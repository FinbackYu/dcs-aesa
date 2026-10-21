'use strict';
// Imaging chain of the SAR core: plan one image (range-bin grid, simulated pulse
// train, aperture weights), synthesize the complex echo history, focus it, and
// describe the result.
//
// Dependencies are the core's own modules plus the generated config; the scene
// contract is geometry.validate, which checks structure only. A game adapter is
// responsible for translating its scene into that contract (footprint, surface
// vocabulary, object kinds) before anything here sees it.
//
// Determinism: every number below is a pure function of (scene, cfg). The plan is
// recomputed in each parallel worker instead of being shipped, and both synthesis
// and focusing split into blocks that hold exactly the serial values — see pool.cjs.
const {C_MPS, sar: {constants: SAR_CONSTANTS, geometry: SAR_GEOMETRY, render: SAR_RENDER}} = require('../shared/config.cjs');
const {pixel, validate, apertureGeometry} = require('./geometry.cjs');
const {materialCounts} = require('./materials.cjs');
const {RANGE_WINDOW_PADDING_CELLS} = require('./memory.cjs');
const {pulses, apertureWeights, kernelTable, kernelIndex, kernelStep, resolutionOf} = require('./waveform.cjs');
const scattering = require('./scatterers.cjs');
const {settings} = require('./settings.cjs');
const {focusRows} = require('./focus.cjs');
const pfa = require('./pfa.cjs');

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
// dB reference: a run's own peak, floored at the display floor. See docs/conventions.md §dB.
const DB_FLOOR_DB = SAR_RENDER.db_floor_ref;

// Scatterers of one scene. The caller may pass a prebuilt list (the pool builds it
// once and ships it to the workers); otherwise it is built from the settings.
function buildScatterers(input, options = {}) {
  const scene = validate(input), cfg = settings(options);
  return scattering.buildScatterers(scene, cfg);
}

// Geometry of one image: range-bin grid, pulse times and aperture weights.
// Deterministic and cheap, so a parallel worker recomputes it instead of receiving it.
function planScene(input, scatterers, options = {}) {
  const scene = validate(input), cfg = settings(options), center = pixel(scene, 0, 0);
  if (!Array.isArray(scatterers) || scatterers.length === 0 || scatterers.length > 20000
      || scatterers.some(s => !Array.isArray(s.pos) || s.pos.length !== 3 || !s.pos.every(Number.isFinite)
        || !Number.isFinite(s.phase) || !Number.isFinite(s.amplitude) || s.amplitude < 0)) throw Error('Invalid scatterers');
  const resolution = resolutionOf(cfg.bandwidth), spacing = resolution / cfg.rangeStep, k = 4 * Math.PI / cfg.lambda;
  // Cover every scatterer/pixel delta including terrain relief, with kernel padding.
  const radius = Math.max(...scene.terrain.map(p => distance(p, center)), ...scatterers.map(s => distance(s.pos, center)))
    + RANGE_WINDOW_PADDING_CELLS * resolution;
  if (radius > SAR_GEOMETRY.max_relief_m) throw Error('Terrain relief exceeds prototype range window');
  const binMin = -radius, count = Math.ceil(2 * radius / spacing) + 2, table = kernelTable(cfg.window);
  const sampling = pulses(scene, scatterers, cfg, count), samples = sampling.samples;
  const budget = SAR_CONSTANTS.history_budget_bytes;
  if (count * samples.length * SAR_CONSTANTS.history_bytes_per_bin_pulse > budget)
    throw Error('Simulated echo history exceeds 512 MiB budget');
  const weights = apertureWeights(samples, cfg.window);
  return {
    scene, cfg, center, k, resolution, binMin, count, spacing, table, samples, sampling,
    weights, weightSum: weights.reduce((s, v) => s + v, 0), objects:
      cfg.shadow || cfg.sceneModel === 'classified' ? scattering.modelObjects(scene) : []
  };
}

// Pulses are independent: every pulse starts from zero bins and touches only its own range,
// so a block holds exactly the values a full serial run produces for those indices — no
// reduction and no changed summation order. `target` writes into shared history buffers.
function synthesizeRange(plan, scatterers, from, to, target) {
  const {scene, cfg, k, resolution, binMin, count, spacing, table, samples, objects, center} = plan, history = [];
  // 'center' carries a mask on the points, so a blocked scatterer is skipped before any arithmetic;
  // 'pulse' re-decides per pulse (a shadow edge moves with the platform) at N x the march cost.
  const masked = cfg.shadow && cfg.shadowLook === 'center', perPulse = cfg.shadow && cfg.shadowLook === 'pulse';
  const sampler = perPulse ? scattering.createSampler(scene) : null;
  // The truncated kernel spans `kernel_lobes` resolution cells on each side of the echo; the
  // LUT covers exactly that range (lobes*4096 entries), so `lutMax` is its last index.
  const lobeSpan = SAR_CONSTANTS.kernel_lobes * resolution, lutStep = kernelStep(cfg.rangeStep), lutMax = table.length - 1;
  for (let n = from; n < to; n++) {
    const pos = samples[n].pos, reference = distance(pos, center);
    const re = target ? target.re.subarray(n * count, (n + 1) * count) : new Float64Array(count);
    const im = target ? target.im.subarray(n * count, (n + 1) * count) : new Float64Array(count);
    if (target) target.reference[n] = reference;
    for (const s of scatterers) {
      if (masked && s.blocked_by) continue;
      const amplitude = cfg.sceneModel === 'classified'
        ? scattering.amplitude(scene, s, pos, objects, pixel, {perPulse, sampler})
        : perPulse ? scattering.amplitude(scene, s, pos, objects, pixel, {perPulse: true, sampler}) : s.amplitude;
      if (amplitude === 0) continue;
      const delta = distance(pos, s.pos) - reference, phase = s.phase - k * delta;
      const real = amplitude * Math.cos(phase), imag = amplitude * Math.sin(phase);
      const lo = Math.max(0, Math.ceil((delta - lobeSpan - binMin) / spacing));
      const hi = Math.min(count - 1, Math.floor((delta + lobeSpan - binMin) / spacing));
      // Walk the kernel LUT in `rangeStep`-bin strides. The bound is the LUT's own end: past it the
      // truncated envelope is zero, so stopping there is the same computation, not a shortcut.
      let lut = kernelIndex((binMin + lo * spacing - delta) / resolution);
      for (let j = lo; j <= hi && lut < lutMax; j++, lut += lutStep) {
        const q = Math.min(lutMax - 1, Math.max(0, Math.floor(lut))), f = lut - q;
        const e = table[q] + (table[q + 1] - table[q]) * f;
        re[j] += e * real; im[j] += e * imag;
      }
    }
    history.push({reference, re, im});
  }
  return history;
}

function synthesizeScene(input, scatterers, options = {}) {
  const plan = planScene(input, scatterers, options);
  plan.weightSum = plan.weights.reduce((s, v) => s + v, 0);
  return {
    scene: plan.scene, cfg: plan.cfg, history: synthesizeRange(plan, scatterers, 0, plan.samples.length),
    samples: plan.samples, sampling: plan.sampling, weights: plan.weights, weightSum: plan.weightSum,
    binMin: plan.binMin, spacing: plan.spacing, resolution: plan.resolution
  };
}

function focusImage(data, options = {}) {
  return data.cfg.focuser === 'pfa' ? pfa.focus(data).power : focusRows(data, 0, data.cfg.width, options);
}

// `summary` carries the echo-history facts of a run: pulse count/prf/sampling method from
// the plan plus the aperture geometry, so serial and parallel runs share one metadata path.
function assembleResult(scene, cfg, scatterers, power, summary, started) {
  const {trajectory} = scene, {slant, effective} = summary, peak = Math.max(...power), gaps = trajectory.slice(1).map((p, i) => p.t - trajectory[i].t);
  const shadow = scattering.visibilityStats(scatterers), objects = scattering.modelObjects(scene);
  return {
    source: scene.source, width: cfg.width, size_m: scene.size,
    db: power.map(v => peak > 0 ? Math.max(DB_FLOOR_DB, 10 * Math.log10(Math.max(v / peak, 1e-12))) : DB_FLOOR_DB), power,
    metadata: {
      engine: cfg.sceneModel === 'classified' ? 'scene-v3' : 'surface-v2', focuser: cfg.focuser, quality: cfg.quality,
      // The dB scale this matrix is on: every SAR patch is normalised to its own frame peak. A consumer
      // that compares two images reads this field first (docs/conventions.md §7), because a MAP frame is
      // on a different reference and the two are not comparable without it.
      mode: 'sar', db_ref: SAR_RENDER.db_ref,
      ...(cfg.requested_quality === undefined ? {} : {requested_quality: cfg.requested_quality}),
      scene_model: cfg.sceneModel, lambda_m: cfg.lambda, bandwidth_hz: cfg.bandwidth, width: cfg.width, window: cfg.window,
      range_interpolation: cfg.rangeInterpolation,
      scatterers: scatterers.length, scatter_spacing_m: cfg.scatterSpacing, scatter_seed: cfg.seed,
      poses: trajectory.length, duration_s: trajectory.at(-1).t - trajectory[0].t, max_gap_s: Math.max(...gaps),
      simulated_pulses: summary.pulses, simulated_prf_hz: summary.prf, pulse_oversampling: cfg.pulseOversampling, pulse_sampling: summary.method,
      transverse_aperture_m: effective, nominal_cross_rect_m: cfg.lambda * slant / (2 * effective),
      nominal_slant_range_rect_m: summary.resolution, terrain_spacing_m: scene.size / (scene.n - 1), image_step_m: scene.size / (cfg.width - 1),
      compute_ms: performance.now() - started,
      visibility: cfg.shadow ? (cfg.shadowLook === 'center'
        ? 'one DEM ray march + oriented boxes per scatterer at the aperture centre; a blocked scatterer contributes no echo; outside patch unknown'
        : 'per-pulse DEM ray march + oriented boxes; counts below are the aperture-centre mask; outside patch unknown') : 'not modeled',
      shadow: cfg.shadow, shadow_look: cfg.shadowLook, shadowed_scatterers: shadow.blocked, shadowed_terrain: shadow.terrain,
      shadowed_objects: shadow.object, shadow_objects: cfg.shadow ? objects.length : 0,
      layover: cfg.sceneModel === 'classified'
        ? 'exact 3-D object returns: a face or roof focuses at the ground range whose slant range matches, i.e. displaced toward the radar by about H*h/g'
        : 'no object scatterers in this scene model; the image grid follows the DEM, so terrain relief shows as geometry rather than as a fold',
      objects_received: (scene.objects || []).length,
      objects_modeled: cfg.sceneModel === 'classified' ? objects.length : 0,
      surface_counts: materialCounts(scene),
      material: cfg.sceneModel === 'classified'
        ? 'assumed class coefficients and cosine incidence; simplified box faces; not calibrated'
        : 'assumed constant coefficient + bilinear slope incidence; area weighted',
      model: 'world-anchored jittered point samples of assumed surface; exact path; normalized power'
    }
  };
}

// Two focusing paths over the same synthesized history: time-domain backprojection (exact 3-D
// ranges, any terrain) and polar-format PFA (plane wave over the patch, one 2-D FFT).
function reconstruct(input, options = {}) {
  const started = performance.now(), scene = validate(input), cfg = settings(options);
  const aperture = apertureGeometry(scene);
  const scatterers = buildScatterers(scene, cfg), data = synthesizeScene(scene, scatterers, cfg);
  const power = focusImage(data, options);
  return assembleResult(scene, cfg, scatterers, power,
    {...aperture, pulses: data.samples.length, prf: data.sampling.prf, method: data.sampling.method, resolution: data.resolution}, started);
}

module.exports = {
  validate, pixel, buildScatterers, planScene, synthesizeRange, synthesizeScene, focusImage,
  apertureGeometry, assembleResult, reconstruct, settings, DB_FLOOR_DB
};

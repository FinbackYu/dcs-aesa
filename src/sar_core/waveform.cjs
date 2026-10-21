'use strict';
// Pulse train of one synthetic aperture: navigation knots in, simulated RF
// pulse times out, bounded by the echo-history memory budget.
//
// The navigation record is not an RF pulse train: it is sampled at the game's
// frame rate, which aliases the patch Doppler extent at high ground speed. The
// waveform module therefore interpolates the validated short intervals onto a
// simulated PRF derived from the patch's own Doppler spread and the project's
// oversampling margin, and refuses a scene whose pulse count cannot fit the
// history budget (see memory.cjs) instead of silently truncating it.
const {C_MPS,sar:{constants:SAR_CONSTANTS}}=require('../shared/config.cjs');
const {rangeBins,pulseLimit,HISTORY_BUDGET_BYTES,HISTORY_PULSE_SHARE}=require('./memory.cjs');

const range = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
// Assumed oversampling of the patch Doppler extent; the generated default is the
// project margin against aliasing, lower values are an explicit test-speed trade.
const DEFAULT_PULSE_OVERSAMPLING = SAR_CONSTANTS.default_pulse_oversampling;

// `bins` is optional: callers that already know the bin count (planScene) pass
// it, everyone else gets the same number from the scene itself. Both the
// required and the allowed count are reported.
function pulses(scene, scatterers, cfg, bins) {
  const nav = scene.trajectory;
  if ((cfg.pulseSampling || (cfg.sceneModel === 'classified' ? 'auto' : 'telemetry')) === 'telemetry')
    return { samples: nav, method: 'telemetry frames (may alias)', prf: null, limit: null };
  // Telemetry is navigation, not RF pulse sampling: only the terrain vertices and
  // the modelled object faces determine the Doppler extent per interval.
  const center = scene.center, extrema = [...scene.terrain, ...scatterers.filter(p => p.object !== undefined).map(p => p.pos)];
  let doppler = 0;
  for (let i = 1; i < nav.length; i++) {
    const a = nav[i - 1], b = nav[i], dt = b.t - a.t, ref = range(b.pos, center) - range(a.pos, center);
    for (const p of extrema) doppler = Math.max(doppler, Math.abs((range(b.pos, p) - range(a.pos, p) - ref) / dt * 2 / cfg.lambda));
  }
  const oversampling = cfg.pulseOversampling ?? DEFAULT_PULSE_OVERSAMPLING;
  const prf = Math.max(SAR_CONSTANTS.min_prf_hz, Math.ceil(doppler * oversampling)), start = nav[0].t,
    duration = nav.at(-1).t - start, count = Math.ceil(duration * prf) + 1;
  const binCount = Number.isFinite(bins) && bins > 0 ? Math.floor(bins) : rangeBins(scene, scatterers, cfg),
    limit = pulseLimit(binCount);
  if (count > limit) throw Error(`Scene needs ${count} simulated pulses but the echo history budget (${Math.round(HISTORY_BUDGET_BYTES * HISTORY_PULSE_SHARE / 1048576)} MiB over ${binCount} range bins) allows ${limit}; reduce range footprint, ground speed or pulse oversampling`);
  let i = 0;
  const samples = Array.from({ length: count }, (_, k) => {
    const t = start + duration * k / (count - 1);
    while (i < nav.length - 2 && t > nav[i + 1].t) i++;
    const a = nav[i], b = nav[i + 1], f = (t - a.t) / (b.t - a.t);
    return { t, pos: a.pos.map((v, j) => v + f * (b.pos[j] - v)) };
  });
  return {
    samples,
    method: 'linear navigation interpolation over validated short intervals; simulated RF pulses, not measured extra poses'
      + (oversampling < DEFAULT_PULSE_OVERSAMPLING ? `; pulse oversampling ×${oversampling}（降低过采样，可能混叠）` : ''),
    prf,
    limit
  };
}

// Range-compressed resolution cell and the aperture weight of each pulse. The
// Hann taper is applied over the aperture time, so a synthetic aperture's
// sidelobes come from the window and not from a hard pulse onset.
function apertureWeights(samples, window) {
  const start = samples[0].t, duration = samples.at(-1).t - start;
  return samples.map((p, i) => {
    const dt = (samples[Math.min(i + 1, samples.length - 1)].t - samples[Math.max(i - 1, 0)].t) / 2;
    return dt * (window === 'hann' ? .5 - .5 * Math.cos(2 * Math.PI * (p.t - start) / duration) : 1);
  });
}

const resolutionOf = bandwidth => C_MPS / (2 * bandwidth);

const sinc = x => Math.abs(x) < 1e-10 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);

// Range-compressed amplitude envelope of one scatterer, in units of the range
// resolution cell: a rectangular band gives sinc, a Hann taper gives
// sinc(u) + (sinc(u-1) + sinc(u+1))/2 (its frequency response).
function envelope(u, window) {
  return window === 'hann' ? sinc(u) + .5 * (sinc(u - 1) + sinc(u + 1)) : sinc(u);
}

// Amplitude-envelope LUT only. Propagation phase always uses exact 3D range.
// Linear interpolation step 1/2048 of a range-resolution cell; checked against
// the analytic envelope to better than 1e-7 (test_sar_surface.cjs).
const tables = new Map();
function kernelTable(window) {
  if (!tables.has(window)) {
    const lobes = SAR_CONSTANTS.kernel_lobes;
    const table = new Float64Array(lobes * 4096 + 1);
    for (let i = 0; i < table.length; i++) table[i] = envelope(i / 2048 - lobes, window);
    tables.set(window, table);
  }
  return tables.get(window);
}
// LUT index of a kernel argument in resolution cells; the table covers
// [-lobes, +lobes] with 2048 samples per cell. The arithmetic stays
// `u*2048 + lobes*2048` (not `(u + lobes)*2048`) so the index is bit-for-bit the
// one the pre-migration engine computed.
const kernelIndex = u => u * 2048 + SAR_CONSTANTS.kernel_lobes * 2048;
// Bins per range-resolution cell in LUT units: the synthesis walks the kernel in
// `rangeStep`-bin strides, so each step advances 1/rangeStep of a cell.
const kernelStep = rangeStep => 2048 / rangeStep;

module.exports = {
  pulses, apertureWeights, resolutionOf, envelope, kernelTable, kernelIndex, kernelStep, sinc,
  DEFAULT_PULSE_OVERSAMPLING
};

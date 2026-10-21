/* Offline SAR feasibility probe, not a DCS radar implementation.
 * Ideal rectangular-band range-compressed complex echoes + geometric backprojection.
 * Assumptions: stationary isotropic point scatterers, stop-and-go, constant amplitude,
 * exact trajectory, no terrain/clutter/noise/antenna pattern/absolute radiometry.
 * Coordinates follow DCS: y is up; aircraft travels along +x.
 * Run: node scripts/sar_principle_probe.cjs
 */
'use strict';
const {C_MPS,LAMBDA_M,SAR_PROFILES}=require('../src/shared/config.cjs');
const C = C_MPS;
const DEFAULTS = { lambda: LAMBDA_M, bandwidth: SAR_PROFILES.standard.bandwidth_hz, speed: 250, duration: 2,
  height: 4000, groundRange: 30000, azimuthDeg: 45, pulses: 257,
  binSpacing: .125, binMin: -32, binMax: 32 };

function sinc(x) { return Math.abs(x) < 1e-10 ? 1 : Math.sin(Math.PI*x)/(Math.PI*x); }
function distance(a, b) { return Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]); }

function geometry(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const angle = cfg.azimuthDeg * Math.PI / 180;
  const center = [cfg.groundRange*Math.cos(angle), 0, cfg.groundRange*Math.sin(angle)];
  const point = (cross, ground) => [center[0] + cross*Math.sin(angle) + ground*Math.cos(angle),
    0, center[2] - cross*Math.cos(angle) + ground*Math.sin(angle)];
  const trajectory = Array.from({length: cfg.pulses}, (_, n) =>
    [cfg.speed*cfg.duration*(n/(cfg.pulses-1)-.5), cfg.height, 0]);
  return { cfg, center, point, trajectory };
}

function synthesize(scatterers, options = {}) {
  const geo = geometry(options), { cfg, center, trajectory } = geo;
  const count = Math.round((cfg.binMax-cfg.binMin)/cfg.binSpacing)+1;
  const waveNumber = 4*Math.PI/cfg.lambda;
  const history = trajectory.map(position => {
    const reference = distance(position, center);
    const re = new Float64Array(count), im = new Float64Array(count);
    for (const scatterer of scatterers) {
      const delta = distance(position, geo.point(scatterer.cross, scatterer.ground))-reference;
      const phase = (scatterer.phase || 0) - waveNumber*delta;
      const amplitude = scatterer.amplitude ?? 1;
      for (let j = 0; j < count; j++) {
        const envelope = amplitude*sinc(2*cfg.bandwidth*(cfg.binMin+j*cfg.binSpacing-delta)/C);
        re[j] += envelope*Math.cos(phase); im[j] += envelope*Math.sin(phase);
      }
    }
    return { re, im, reference };
  });
  return { ...geo, history };
}

// Deliberately explicit O(pixels*pulses) reference algorithm, linear envelope interpolation.
function focus(data, cross, ground, { erasePhase = false, rangeError = () => 0 } = {}) {
  const { cfg, history, trajectory } = data;
  const pixel = data.point(cross, ground);
  let real = 0, imag = 0;
  for (let n = 0; n < history.length; n++) {
    const row = history[n];
    const delta = distance(trajectory[n], pixel)-row.reference+rangeError(n);
    const index = (delta-cfg.binMin)/cfg.binSpacing;
    const j = Math.floor(index), frac = index-j;
    if (j < 0 || j+1 >= row.re.length) continue;
    let re, im;
    if (erasePhase) {
      re = (1-frac)*Math.hypot(row.re[j],row.im[j]) + frac*Math.hypot(row.re[j+1],row.im[j+1]);
      im = 0;
    } else {
      re = row.re[j]*(1-frac) + row.re[j+1]*frac;
      im = row.im[j]*(1-frac) + row.im[j+1]*frac;
    }
    const phase = 4*Math.PI*delta/cfg.lambda;
    real += re*Math.cos(phase)-im*Math.sin(phase);
    imag += re*Math.sin(phase)+im*Math.cos(phase);
  }
  return (real*real+imag*imag)/(history.length*history.length);
}

function profile(data, axis, { center = 0, span = 8, step = .02 } = {}) {
  return Array.from({length: Math.round(2*span/step)+1}, (_, i) => {
    const offset = center-span+i*step;
    return { offset, power: focus(data, axis === 'cross' ? offset : 0,
      axis === 'ground' ? offset : 0) };
  });
}

function fwhm(samples) {
  let peak = 0;
  for (let i = 1; i < samples.length; i++) if (samples[i].power > samples[peak].power) peak = i;
  const half = samples[peak].power/2;
  let left = peak, right = peak;
  while (left > 0 && samples[left].power > half) left--;
  while (right+1 < samples.length && samples[right].power > half) right++;
  if (left === 0 || right === samples.length-1) return null;
  const crossing = (a,b) => a.offset + (half-a.power)/(b.power-a.power)*(b.offset-a.offset);
  return crossing(samples[right-1],samples[right])-crossing(samples[left],samples[left+1]);
}

function probe() {
  const point = [{cross: 0, ground: 0}];
  const baseline = synthesize(point);
  const halfTime = synthesize(point, {duration: 1});
  const halfBandwidth = synthesize(point, {bandwidth: SAR_PROFILES.standard.bandwidth_hz/2});
  const shifted = synthesize([{cross: 3, ground: 0}]);
  const error = n => .004*Math.sin(2*Math.PI*7*n/(baseline.cfg.pulses-1));
  const pair = synthesize([{cross: -2, ground: 0}, {cross: 2, ground: 0}]);
  const forward = synthesize([{cross: 3, ground: 0}], {azimuthDeg: 0});
  const started = performance.now();
  const image = Array.from({length: 65}, (_, row) => Array.from({length: 65}, (_, col) =>
    focus(pair, (col-32)*.25, (row-32)*.25)));
  const computeMs = performance.now()-started;
  const cfg = baseline.cfg;
  const slant = Math.hypot(cfg.groundRange,cfg.height);
  const nominalCross = cfg.lambda*slant/(2*cfg.speed*cfg.duration*Math.sin(cfg.azimuthDeg*Math.PI/180));
  return {
    assumptions: 'Synthetic points, normalized power, ideal rectangular band, exact path; not DCS terrain or calibrated radar performance.',
    config: cfg,
    nominal: { slant_range_m: slant, slant_range_resolution_m: C/(2*cfg.bandwidth),
      ground_range_resolution_m: C/(2*cfg.bandwidth)*slant/cfg.groundRange,
      cross_range_resolution_m: nominalCross },
    measured: { cross_fwhm_m: fwhm(profile(baseline,'cross')),
      half_time_cross_fwhm_m: fwhm(profile(halfTime,'cross')),
      ground_fwhm_m: fwhm(profile(baseline,'ground')),
      half_bandwidth_ground_fwhm_m: fwhm(profile(halfBandwidth,'ground')),
      phase_erasure_power_ratio: focus(shifted,3,0,{erasePhase:true})/focus(shifted,3,0),
      varying_4mm_range_error_power_ratio: focus(baseline,0,0,{rangeError:error})/focus(baseline,0,0),
      pair_center_to_target_power_ratio: focus(pair,0,0)/focus(pair,2,0),
      forward_left_right_power_difference: Math.abs(focus(forward,3,0)-focus(forward,-3,0)),
      image_pixels: 65*65, image_pulse_pixel_evaluations: 65*65*cfg.pulses,
      image_compute_ms: computeMs },
    // Optional inspectable raster numbers; deliberately not a drawn map or target overlay.
    image: { width: 65, height: 65, step_m: .25, cross_min_m: -8, ground_min_m: -8,
      normalized_power: image },
  };
}

module.exports = { C, DEFAULTS, geometry, synthesize, focus, profile, fwhm, probe };
if (require.main === module) {
  const result = probe();
  if (!process.argv.includes('--image')) delete result.image;
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
}

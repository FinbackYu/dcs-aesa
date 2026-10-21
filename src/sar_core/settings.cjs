'use strict';
// Processing settings of the SAR core: one validated option record built from
// spec/sar.json defaults, the quality profiles and the footprint cap rule.
//
// Three layers exist and each is explicit:
//   * `settings(options)`       — the engine contract. Unknown values fail here,
//                                 so a focusing run never silently degrades;
//   * `PROFILES`/`GRIDS`        — waveform promises (`fine` = 150 MHz + 257 px)
//                                 and the coarse-grid rule of the `fast` test
//                                 profile. `fast` is an explicitly lossy test
//                                 profile, not a resolution claim: the output
//                                 grid halves, scatter spacing doubles and pulse
//                                 oversampling drops to 1.5, which no longer
//                                 keeps the project's aliasing margin;
//   * `effectiveQuality`        — a footprint caps the waveform it can support
//                                 (512 m supplies 37.5 MHz, 2048 m supplies
//                                 10 MHz), so `fine` over a coarse footprint is
//                                 reported as the standard profile it really is.
//                                 Only `fine` makes a resolution claim a coarse
//                                 footprint can silently break.
const {SAR_PROFILES,sar:{grids:SAR_GRIDS,constants:SAR_CONSTANTS,render:SAR_RENDER}}=require('../shared/config.cjs');
const {DEFAULT_PULSE_OVERSAMPLING}=require('./waveform.cjs');

const DEFAULTS = Object.freeze({
  lambda: SAR_CONSTANTS.default_lambda_m,
  bandwidth: SAR_CONSTANTS.default_bandwidth_hz,
  scatterSpacing: 1,
  seed: SAR_RENDER.default_seed,
  width: SAR_CONSTANTS.default_width,
  window: SAR_CONSTANTS.default_window,
  rangeInterpolation: SAR_CONSTANTS.default_range_interpolation,
  rangeStep: SAR_CONSTANTS.default_range_step,
  kernelLobes: SAR_CONSTANTS.kernel_lobes,
  sceneModel: SAR_RENDER.default_scene_model,
  quality: 'standard',
  pulseOversampling: DEFAULT_PULSE_OVERSAMPLING,
  focuser: SAR_RENDER.default_focuser,
  shadow: SAR_RENDER.default_shadow,
  shadowLook: SAR_RENDER.default_shadow_look
});

function settings(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  if (cfg.pulseSampling !== undefined && !['auto', 'telemetry'].includes(cfg.pulseSampling)) throw Error('Invalid pulse sampling');
  if (!SAR_RENDER.scene_models.includes(cfg.sceneModel) || !Object.hasOwn(SAR_PROFILES, cfg.quality)
      || !SAR_RENDER.windows.includes(cfg.window) || !SAR_RENDER.range_interpolations.includes(cfg.rangeInterpolation)
      || !SAR_RENDER.scatter_spacings_m.includes(cfg.scatterSpacing)
      || !SAR_RENDER.focusers.includes(cfg.focuser) || typeof cfg.shadow !== 'boolean'
      || !SAR_RENDER.shadow_looks.includes(cfg.shadowLook)
      || !SAR_RENDER.widths_px.includes(cfg.width) || !Number.isInteger(cfg.seed) || cfg.seed < 0 || cfg.seed > 0xffffffff
      || !Number.isFinite(cfg.lambda) || cfg.lambda < .005 || cfg.lambda > .1
      || !Number.isFinite(cfg.bandwidth) || cfg.bandwidth < 10e6 || cfg.bandwidth > 150e6
      || !Number.isFinite(cfg.pulseOversampling) || cfg.pulseOversampling < SAR_CONSTANTS.pulse_oversampling_min
        || cfg.pulseOversampling > SAR_CONSTANTS.pulse_oversampling_max
      || cfg.rangeStep !== SAR_CONSTANTS.default_range_step || cfg.kernelLobes !== SAR_CONSTANTS.kernel_lobes
      || (cfg.requested_quality !== undefined && !Object.hasOwn(SAR_PROFILES, cfg.requested_quality)))
    throw Error('Invalid SAR processing settings');
  return cfg;
}

const profile = ({ quality, bandwidth_hz, width, scatter_spacing_m, pulse_oversampling }) => Object.freeze({
  quality, bandwidth: bandwidth_hz, width,
  ...(scatter_spacing_m === undefined ? {} : { scatterSpacing: scatter_spacing_m }),
  pulseOversampling: pulse_oversampling
});
const PROFILES = Object.freeze(Object.fromEntries(Object.entries(SAR_PROFILES)
  .filter(([name, value]) => value.quality === name)
  .map(([name, value]) => [name, profile(value)])));
// The grid rule that forms PROFILES.fast also coarsens a footprint's own width and spacing.
const GRIDS = Object.freeze({
  fast: Object.freeze({
    width: width => Math.ceil(width / SAR_GRIDS.fast.width_divisor),
    scatterSpacing: spacing => spacing * SAR_GRIDS.fast.scatter_spacing_multiplier
  })
});
const IDENTITY = Object.freeze({ width: width => width, scatterSpacing: spacing => spacing });

const QUALITY_RULE = SAR_PROFILES.effective_quality_rule;
function effectiveQuality(options, requested) {
  if (requested === undefined) return undefined;
  const fine = PROFILES[QUALITY_RULE.requested];
  return requested === QUALITY_RULE.requested && (options.bandwidth !== fine.bandwidth || options.width !== fine.width)
    ? QUALITY_RULE.downgrade_to : requested;
}

// The option record a request resolves to, given a resolver for the requested
// footprint (`footprintOf` is supplied by the caller — the game adapter — so the core
// never looks up a game footprint). Tests and tools call this through the adapter,
// which binds its own resolver; `processingOptions` is exported here for callers that
// already work in core terms.
function processingOptions(params, base = { window: SAR_CONSTANTS.default_window }, footprintOf = null) {
  if (params.quality !== undefined && !Object.hasOwn(PROFILES, params.quality)) throw Error('Invalid SAR quality profile');
  const grid = GRIDS[params.quality] || IDENTITY;
  const options = { ...base, ...(params.quality === undefined ? {} : PROFILES[params.quality]), window: params.window ?? base.window ?? SAR_CONSTANTS.default_window };
  if (params.footprint !== undefined) {
    if (typeof footprintOf !== 'function') throw Error('Invalid SAR footprint source');
    const p = footprintOf(params.footprint);
    options.footprint = params.footprint;
    options.scatterSpacing = grid.scatterSpacing(p.scatterSpacing);
    if (params.footprint !== 'detail') { options.width = grid.width(p.width); options.bandwidth = p.bandwidth; }
  }
  if (params.sceneModel !== undefined) options.sceneModel = params.sceneModel;
  if (params.focuser !== undefined) options.focuser = params.focuser;
  // `quality/bandwidth/width` are always the values actually applied. When a request
  // was capped, the disclaimed request travels beside them so diagnostics can still
  // see what was asked for.
  const requested = params.quality ?? base.requested_quality ?? base.quality, effective = effectiveQuality(options, requested);
  for (const key of ['requested_quality', 'effective_quality', 'effective_bandwidth', 'effective_width']) delete options[key];
  if (effective !== undefined) options.quality = effective;
  if (requested !== undefined && requested !== effective) {
    options.requested_quality = requested;
    options.effective_quality = effective;
    options.effective_bandwidth = options.bandwidth;
    options.effective_width = options.width;
  }
  settings(options);
  return options;
}

module.exports = { DEFAULTS, PROFILES, GRIDS, settings, processingOptions, effectiveQuality };

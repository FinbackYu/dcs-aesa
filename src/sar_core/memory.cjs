'use strict';
// Echo-history memory budget.
//
// Every (range bin, pulse) pair is one complex128 echo-history sample (re+im,
// 16 B), and the history is what limits a simulated scene long before physics
// does: a 512 m 'area' tile collected by a 317 m/s aircraft at ~860 m needs a
// ~7.5 kHz PRF (≈15 k pulses) over its 2 s aperture but only ~1772 range bins,
// i.e. ≈425 MB — 90% of the budget below, and exactly what the old fixed
// 8192-pulse ceiling refused to spend. planScene allocates that history (two
// float64 bin planes per pulse, or one pair of shared buffers per image in the
// pool) and keeps its own hard budget check, so the pulse ceiling is derived
// from the budget and a scene's bin count.
const {C_MPS,sar:{constants:SAR_CONSTANTS}}=require('../shared/config.cjs');

const HISTORY_BUDGET_BYTES = SAR_CONSTANTS.history_budget_bytes,
  HISTORY_BYTES_PER_BIN_PULSE = SAR_CONSTANTS.history_bytes_per_bin_pulse;
// Pulses may not spend the whole budget: the DEM, the scatterer list, the output
// power grid and the per-worker copies of the scene live beside the history, so
// the generated share (7/8) is the pulse share.
const HISTORY_PULSE_SHARE = SAR_CONSTANTS.history_pulse_share;
// Ceiling for small patches, whose derived limit would otherwise grow without
// bound (a flat 128 m 'detail' patch has ~1047 bins and would be allowed ~28 k
// pulses, i.e. minutes of simulation).
const MAX_SIMULATED_PULSES = SAR_CONSTANTS.max_simulated_pulses;
// Kernel padding of the range window, in resolution cells: the truncated
// amplitude kernel extends this far past the furthest scatterer.
const RANGE_WINDOW_PADDING_CELLS = SAR_CONSTANTS.range_window_padding_cells;

const range = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// Bin count of the image a scene will produce, by the same rule planScene uses:
// the range window covers the farthest DEM/scatterer vertex from the patch
// centre plus the kernel padding, sampled at resolution/rangeStep. For the same
// inputs planScene reaches the identical number (pixel(scene,0,0) lands on the
// centre DEM vertex that scene.center[1] carries), and its own allocation check
// stays in place as the backstop.
function rangeBins(scene, scatterers, cfg) {
  const resolution = C_MPS / (2 * cfg.bandwidth), spacing = resolution / cfg.rangeStep;
  const radius = Math.max(...scene.terrain.map(p => range(p, scene.center)), ...scatterers.map(s => range(s.pos, scene.center)))
    + RANGE_WINDOW_PADDING_CELLS * resolution;
  return Math.ceil(2 * radius / spacing) + 2;
}

// Pulses a scene with this many range bins may simulate before the history
// stops fitting. A caller that cannot supply a bin count falls back to the
// absolute ceiling.
function pulseLimit(bins) {
  if (!Number.isFinite(bins) || bins < 1) return MAX_SIMULATED_PULSES;
  return Math.min(MAX_SIMULATED_PULSES,
    Math.floor(HISTORY_BUDGET_BYTES * HISTORY_PULSE_SHARE / (bins * HISTORY_BYTES_PER_BIN_PULSE)));
}

module.exports = {
  rangeBins, pulseLimit,
  HISTORY_BUDGET_BYTES, HISTORY_PULSE_SHARE, HISTORY_BYTES_PER_BIN_PULSE, MAX_SIMULATED_PULSES,
  RANGE_WINDOW_PADDING_CELLS
};

'use strict';
// Wide-area sweep planner: which world tile the next SAR patch is pointed at.
//
// Wide-area sweep (continuous mode:'sweep') is world-anchored. The ground is divided into fixed
// tiles on an absolute grid — tile (tx,tz) of size S covers [tx·S,(tx+1)·S) × [tz·S,(tz+1)·S), so its
// centre is ((tx+.5)·S,(tz+.5)·S) — and the aircraft flying only slides the imaging window over that
// grid. There is no per-aircraft cell layout and no replan threshold: every capture re-enumerates
// the window and picks the best uncovered tile, so the beam is re-aimed at fixed ground instead of
// at a patch glued to the aircraft.
//
// The window is the side-looking quarter the project recommends (30–60° off the ground track) out to
// the Export's 1–50 km ground-range limit. Tiles are ordered forward first (5° azimuth bands, the
// band closest to the nose first) and then by ground range, so coverage grows forward and outward.
// Every number below is the sweep contract from spec/sar.json (sar.map.sweep).
const {sar} = require('../../src/shared/config.cjs');
const MAP_SWEEP = sar.map.sweep;

const SWEEP_MIN_ANGLE_DEG = MAP_SWEEP.min_angle_deg, SWEEP_MAX_ANGLE_DEG = MAP_SWEEP.max_angle_deg,
  SWEEP_MIN_RANGE_M = MAP_SWEEP.min_range_m, SWEEP_MAX_RANGE_M = MAP_SWEEP.max_range_m,
  SWEEP_ANGLE_BAND_DEG = MAP_SWEEP.angle_band_deg, SWEEP_PLAN_MAX = MAP_SWEEP.plan_max,
  SWEEP_SIZES = MAP_SWEEP.sizes_m, SWEEP_DEFAULT_SIZE = MAP_SWEEP.default_size_m;
// The window is measured from where the aircraft will be when the patch is actually collected, not
// from the newest pose on record: the Export refuses a patch whose ground range has dropped below
// 1 km by the time it looks, and a 317 m/s aircraft closes that gap while the previous image is
// computed. 10 s of lead covers the fast profile (2 s trajectory + ~1 s compute + queueing) with
// margin — 3.2 km of along-track motion at 317 m/s — and matches the real failure it fixes: tiles
// chosen at 1.0–1.8 km that were 0.6–0.9 km away when the Export looked.
// With a predicted pose a tile must clear 1.5 km: 0.5 km above the Export's own 1 km limit, i.e.
// 1.6 s of flight at 317 m/s of prediction slack, and far enough that a 512 m patch keeps a modest
// angular extent — and with it a modest simulated pulse count. Without a velocity (no trajectory
// yet) the plain 1 km Export limit is used, as before.
// A tile that a capture refused (bad geometry) or that failed to compute (for example the
// simulated-pulse ceiling of a large patch) is not re-offered immediately: the world grid would
// otherwise keep picking the same tile forever. The backoff is bounded.
const SWEEP_LEAD_S = MAP_SWEEP.lead_s, SWEEP_PREDICTED_MIN_RANGE_M = MAP_SWEEP.predicted_min_range_m,
  SWEEP_RETRY_MS = MAP_SWEEP.retry_ms, SWEEP_RETRY_MAX = MAP_SWEEP.retry_max;
// Footprint per tile size: the small tile uses the 'area' slice, the 2048 m one the 'airport' overview.
const sweepRegion = size => size <= sar.footprints.area.size_m ? 'area' : 'airport';

// A tile is covered when the mosaic holds an image at least as large whose centre is within its own
// half diagonal of the tile centre — the largest offset at which the tile centre still falls inside
// that image whatever the relative rotation. A 2048 m image therefore also covers the 512 m tiles
// inside it, while a 512 m image can never cover a 2048 m tile. Covered tiles are not offered.
// MAP frames are excluded: their tile is the square that carries the beam wedge, so the square claims
// ground the real-beam map never looked at — behind the aircraft and along the wedge's edges — and
// suppressing a SAR tile there would trade a real patch for a corner of an empty frame.
class SweepPlanner {
  constructor({mosaic, state, retryMs = SWEEP_RETRY_MS, retryMax = SWEEP_RETRY_MAX, leadS = SWEEP_LEAD_S,
    predictedMinRangeM = SWEEP_PREDICTED_MIN_RANGE_M, minRangeM = SWEEP_MIN_RANGE_M} = {}) {
    this.mosaic = mosaic; this.state = state;
    this.retryMs = retryMs; this.retryMax = retryMax; this.leadS = leadS;
    this.predictedMinRangeM = predictedMinRangeM; this.minRangeM = minRangeM;
    this.retry = new Map();
    this.gridKey = null; this.activity = -1; this.inFlight = null; this.lastSide = 0; this.notePrefix = '';
  }
  // Where the aircraft will be when the next patch is collected (SWEEP_LEAD_S, see the constants).
  lead(pose) {
    if (!pose) return null;
    if (!pose.velocity) return {...pose, lead_s: 0};
    return {...pose, pos: [pose.pos[0] + pose.velocity[0] * this.leadS, pose.pos[1], pose.pos[2] + pose.velocity[1] * this.leadS], lead_s: this.leadS};
  }
  coveredByMosaic(tile) {
    return this.mosaic.entries.some(entry => entry.mode !== 'map' && entry.size_m >= tile.size_m
      && Math.hypot(entry.center[0] - tile.center[0], entry.center[2] - tile.center[2]) <= entry.size_m * Math.SQRT1_2);
  }
  retryKey(tile) { return `${tile.size_m}:${Math.floor(tile.center[0] / tile.size_m)}:${Math.floor(tile.center[2] / tile.size_m)}`; }
  deferred(tile) {
    const until = this.retry.get(this.retryKey(tile));
    if (until === undefined) return false;
    if (until > Date.now()) return true;
    this.retry.delete(this.retryKey(tile));
    return false;
  }
  defer(tile) {
    this.retry.set(this.retryKey(tile), Date.now() + this.retryMs);
    while (this.retry.size > this.retryMax) this.retry.delete(this.retry.keys().next().value);
  }
  clear() { this.retry.clear(); this.gridKey = null; this.activity = -1; this.lastSide = 0; this.notePrefix = ''; }
  // Enumerate the fixed world tiles whose centre is inside the imaging window as seen from this pose,
  // drop the covered and the deferred ones, and keep the best SWEEP_PLAN_MAX for the plan: forward
  // azimuth bands first (the 30–35° band is closest to the nose), then ground range, and inside one
  // band/range bucket the side the previous capture did not use, so both sides fill evenly.
  // `minRange` is the floor a tile has to clear from this pose: 1.5 km for a predicted pose, the
  // Export's own 1 km otherwise (see SWEEP_PREDICTED_MIN_RANGE_M).
  buildWindow(pose, size, minRange = this.minRangeM) {
    const first = Math.floor((pose.pos[0] - SWEEP_MAX_RANGE_M) / size), last = Math.floor((pose.pos[0] + SWEEP_MAX_RANGE_M) / size);
    const firstZ = Math.floor((pose.pos[2] - SWEEP_MAX_RANGE_M) / size), lastZ = Math.floor((pose.pos[2] + SWEEP_MAX_RANGE_M) / size);
    const ranked = []; let covered = 0, deferred = 0;
    for (let tx = first; tx <= last; tx++) for (let tz = firstZ; tz <= lastZ; tz++) {
      const x = (tx + .5) * size, z = (tz + .5) * size, dx = x - pose.pos[0], dz = z - pose.pos[2], range = Math.hypot(dx, dz);
      if (range < minRange || range > SWEEP_MAX_RANGE_M) continue;
      // Same sign convention as /designate/check and the Export: positive is to the right of the ground
      // track, so the 右/左 the operator reads here and the side the viewer draws are the same sign as
      // the relative track angle a captured target reports. (The heading and the bearing are both
      // complements of the Export's angles, so the difference is heading minus bearing.)
      let angle = (pose.heading - Math.atan2(dx, dz)) * 180 / Math.PI;
      while (angle > 180) angle -= 360;
      while (angle < -180) angle += 360;
      const azimuth = Math.abs(angle);
      if (azimuth < SWEEP_MIN_ANGLE_DEG || azimuth > SWEEP_MAX_ANGLE_DEG) continue;
      const tile = {center: [+x.toFixed(1), pose.height, +z.toFixed(1)], bearing: +Math.atan2(dx, dz).toFixed(6),
        size_m: size, side: angle >= 0 ? 1 : -1, angleDeg: +azimuth.toFixed(1), rangeM: Math.round(range), status: 'pending'};
      if (this.coveredByMosaic(tile)) { covered++; continue; }
      if (this.deferred(tile)) { deferred++; continue; }
      ranked.push({tile, band: Math.floor((azimuth - SWEEP_MIN_ANGLE_DEG) / SWEEP_ANGLE_BAND_DEG),
        range, side: tile.side === this.lastSide ? 1 : 0});
    }
    ranked.sort((a, b) => a.band - b.band || a.range - b.range || a.side - b.side);
    const continuous = this.state.continuous;
    continuous.sweepPlan = ranked.slice(0, SWEEP_PLAN_MAX).map(entry => entry.tile);
    continuous.sweepPruned = covered;
    continuous.sweepDeferred = deferred;
    continuous.sweepAnchor = [pose.pos[0], pose.pos[2]];
    continuous.sweepIndex = 0;
    return {offered: ranked.length, covered, deferred};
  }
  // Opportunistic selection over the fixed grid: no plan is "followed", the window simply slides as
  // the aircraft flies, and every capture takes the best uncovered tile of the window at that moment.
  // It is called with the predicted pose, so the squares offered are the ones that will still be
  // there when the patch is collected.
  next(pose) {
    const size = this.state.continuous.sweepSize;
    const minRange = pose.lead_s ? this.predictedMinRangeM : this.minRangeM;
    const gridKey = `${Math.floor(pose.pos[0] / size)}:${Math.floor(pose.pos[2] / size)}`;
    const activity = this.state.continuous.completed + this.state.continuous.skipped + this.state.continuous.failures;
    let window = null;
    if (!this.state.continuous.sweepPlan || gridKey !== this.gridKey || activity !== this.activity) {
      window = this.buildWindow(pose, size, minRange);           // a fresh candidate batch for this window
      this.gridKey = gridKey; this.activity = activity;
    }
    const plan = this.state.continuous.sweepPlan;
    const index = plan.findIndex(candidate => candidate.status === 'pending');
    if (index < 0) {
      const deferred = this.state.continuous.sweepDeferred ? `、退避 ${this.state.continuous.sweepDeferred} 块` : '';
      return {exhausted: `当前窗口内 ${this.state.continuous.sweepPlan.length} 块候选均已处理（已覆盖 ${this.state.continuous.sweepPruned} 块${deferred}），随飞机前进自动换窗`};
    }
    const cell = plan[index];
    this.state.continuous.sweepIndex = index; cell.status = 'capturing'; this.inFlight = cell; this.lastSide = cell.side;
    return {cell, index, window};
  }
  // A capture that failed is retired as skipped and backed off, so the fixed grid moves on to the
  // next tile instead of picking the same one forever.
  failed() {
    const failed = this.inFlight;
    if (failed) { failed.status = 'skipped'; this.defer(failed); this.inFlight = null; }
    return failed;
  }
  done() {
    if (this.inFlight) { this.inFlight.status = 'done'; this.inFlight = null; }
  }
  // The sentence that explains the flight decision, including the tile-level backoff when one applies.
  note(prefix, message) { return prefix ? `${prefix}；${message}` : message; }
}

module.exports = {SweepPlanner, sweepRegion, SWEEP_DEFAULT_SIZE, SWEEP_SIZES, SWEEP_LEAD_S, SWEEP_RETRY_MS,
  SWEEP_MIN_RANGE_M, SWEEP_MAX_RANGE_M, SWEEP_MIN_ANGLE_DEG, SWEEP_MAX_ANGLE_DEG, SWEEP_PLAN_MAX};

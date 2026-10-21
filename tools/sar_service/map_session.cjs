'use strict';
// Real-beam ground map (MAP) session: the coarse base layer a SAR patch is pasted onto.
//
// A frame is a window of one world-fixed coarse lattice (src/sar_core/map.cjs), so the rolling
// window asks the Export only for the cells that entered it and a frame can be drawn from whatever
// part is already collected. The window itself is the aircraft's own forward sector — centred on
// the anchor pose, ±azimuth about the nose, out to range — because that is the shape a real aperture
// paints: no doppler blind cone, nothing to the sides, nothing behind. Frames join the mosaic
// channel with metadata.mode:'map'; they never take the SAR display slots, because
// state.result/reference/snapshot keep 128 m patch semantics.
//
// This module owns the MAP state machine and its session state. The wire, the mosaic and the
// service flags are reached through `ctx`, so a session can be driven by a test without a socket.
const {sar, SAR_MAP_SERVICE_DEFAULTS, PROTOCOL} = require('../../src/shared/config.cjs');
const mapEngine = require('../../src/sar_core/map.cjs');
const {windowSector, planJobs, coverage, sectorGrid} = require('./coverage_index.cjs');
const {relativeAngleDeg} = mapEngine;
const {sweepRegion} = require('./sweep_planner.cjs');

const MAP_LIMITS = sar.map.limits;
// `side`/`angle`/`span` of the old square window are still accepted and ignored: a forward sector has
// no side to choose (it is symmetric about the nose) and no square span (the frame follows range and
// cell), and silently keeping them meaningful would pretend the map can be aimed off the flight path.
// looks 4: a single look on a 250 m display cell is grain, not information — the display cell is already
// finer than the azimuth response beyond a few km, so averaging four looks indoors costs no collection
// time and leaves the far field to the beam average as before. dbs_factor: the reference radar's MAP mode
// is a doppler-sharpened (DBS) picture, so the patrol sharpens too wherever the cone angle allows it.
const MAP_JOB_CELLS = MAP_LIMITS.job_cells_max, MAP_JOB_TIMEOUT_MS = MAP_LIMITS.job_timeout_ms,
  MAP_ADVANCE_M = MAP_LIMITS.advance_m, MAP_TURN_REANCHOR_DEG = MAP_LIMITS.turn_reanchor_deg,
  MAP_FRAME_MIN_MS = MAP_LIMITS.frame_min_ms, MAP_RENDER_GAIN = MAP_LIMITS.render_gain, MAP_POSE_REFRESH_MS = MAP_LIMITS.pose_refresh_ms;

class MapSession {
  constructor(ctx) {
    this.ctx = ctx;
    this.active = false; this.continuous = false; this.params = null; this.rect = null;
    this.sensor = null; this.heading = null; this.velocity = null; this.poseAt = 0; this.track = null; this.lastPose = null;
    this.frames = 0; this.jobs = 0; this.failures = 0;
    this.renderedCenter = null; this.renderedFraction = 0; this.lastFrameAt = 0;
    this.pendingProbe = false; this.sharpenNote = '';
    // The lattice is the coordinate system the window and the Export job share, so its spacing must be
    // the requested cell size; changing the spacing starts a fresh lattice because old cells would no
    // longer line up with it.
    this.cache = mapEngine.createCache({cell_m: SAR_MAP_SERVICE_DEFAULTS.cell_m});
  }
  lattice(cell) {
    if (this.cache.cell_m !== cell) {
      this.cache = mapEngine.createCache({cell_m: cell});
      this.ctx.state.map.cells = 0; this.ctx.state.map.surfaces = 0;
    }
    return this.cache;
  }
  // The heading may be null while only one pose has arrived; the placement gate probes until the
  // second pose completes the pair rather than let a sector out the door on a fabricated north.
  pose() { return this.sensor ? {pos: this.sensor.slice(), heading: this.heading} : this.ctx.currentPose(); }
  // Where the sector sits: the aircraft is its apex, so the frame centre is the anchor position itself
  // and the nose direction is the anchor heading (heading = atan2(dx,dz), the project's bearing
  // convention, so windowSector's own apex/heading convention applies unchanged).
  windowFor(pose, cfg) {
    return windowSector({center: [pose.pos[0], pose.pos[2]], heading: pose.heading, azimuth_deg: cfg.azimuth, range_m: cfg.range, cell_m: cfg.cell});
  }
  // How far the aircraft has left its sector behind: horizontal distance from the anchor (the sector's
  // centre) and the heading change since it was placed. Both are needed — a slow aircraft can fly out of
  // a narrow sector, and a turn swings the whole wedge off the nose without the position moving at all.
  drift(pose, rect) { return Math.hypot(pose.pos[0] - rect.center[0], pose.pos[2] - rect.center[1]); }
  turnDeg(pose, rect) { return Math.abs(relativeAngleDeg(pose.heading, rect.heading)); }
  windowSummary(rect) {
    if (!rect) return null;
    return {center: rect.center, cells: rect.nx, ix0: rect.ix0, iz0: rect.iz0,
      sector: {heading_deg: +(rect.heading * 180 / Math.PI).toFixed(1), azimuth_deg: rect.azimuth_deg, range_m: rect.range_m}};
  }
  blocked() {
    const ctx = this.ctx;
    if (ctx.mode !== 'live' || !ctx.ready) return '等待 DCS Export 连接';
    if (!ctx.collector.capabilities?.map) return '需要新版 SAR Export（CAPTURE_MAP 增量地形）';
    if (!ctx.terrainReady()) return '等待可用地形接口';
    if (ctx.busy()) return '等待上一次采集结束';
    return null;
  }
  probe(refresh = false) {
    this.ctx.write(this.ctx.collector.startMap({x0: 0, z0: 0, cols: 2, rows: 2, step: this.params.cell, relative: true}));
    this.pendingProbe = !refresh;
    this.ctx.state.map.note = refresh ? '刷新本机位姿（2×2 格）' : '尚无本机位姿：先用 2×2 格定位';
  }
  collect(job, plan) {
    this.ctx.write(this.ctx.collector.startMap({x0: job.x0, z0: job.z0, cols: job.cols, rows: job.rows, step: this.params.cell}));
    this.jobs++; this.ctx.state.map.jobs = this.jobs;
    this.ctx.state.map.note = `采集地图格 ${job.cols}×${job.rows}（${job.cells} 格；扇形已覆盖 ${(plan.fraction * 100).toFixed(0)}%）`;
  }
  // The map job's own poses are the only position source when no SAR capture has run yet.
  ingest(completed) {
    const cache = this.cache;
    for (const cell of completed.cells) cache.setHeight(...cache.index(cell.x, cell.z), cell.h);
    let surfaces = 0;
    for (const surface of completed.surfaces) {
      const cell = completed.cells[surface.index]; if (!cell) continue;
      cache.setSurface(...cache.index(cell.x, cell.z), surface.name); surfaces++;
    }
    if (completed.poses.length) {
      const last = completed.poses.at(-1);
      this.sensor = last.pos.slice(); this.poseAt = Date.now();
      // The MAPPOSE frame carries the ownship velocity (x,z); it is the only velocity a MAP-only
      // session ever gets, and DBS needs it to know which way the Doppler gradient runs.
      if (Array.isArray(last.vel) && Number.isFinite(last.vel[0]) && Number.isFinite(last.vel[2]) && Math.hypot(last.vel[0], last.vel[2]) > 0)
        this.velocity = [last.vel[0], last.vel[2]];
      // Heading comes from pose PAIRS, and the pair may span two jobs: a thin sector job finishes
      // well under the Export's 0.25 s pose gate, so it carries exactly one pose and within-job
      // pairs never exist — a patrol of thin jobs then never learned a heading at all and the
      // sector silently fell back to heading 0 (real-flight bug, 2026-10-16). Keep the newest
      // pose across jobs and pair it with every arrival instead.
      for (const pose of completed.poses) {
        const before = this.lastPose;
        if (before) {
          const dt = pose.t - before.t, dx = pose.pos[0] - before.pos[0], dz = pose.pos[2] - before.pos[2];
          if (dt > 0 && Math.hypot(dx, dz) > 1) this.heading = Math.atan2(dx, dz);
        }
        this.lastPose = {t: pose.t, pos: pose.pos.slice()};
      }
      const step = Math.max(1, Math.ceil(completed.poses.length / 32));
      this.track = completed.poses.filter((pose, index) => index % step === 0 || index === completed.poses.length - 1).map(pose => [+pose.pos[0].toFixed(1), +pose.pos[2].toFixed(1)]);
    }
    const counts = cache.counts();
    this.ctx.state.map.cells = counts.heights; this.ctx.state.map.surfaces = counts.surfaces;
    return surfaces;
  }
  // The sharpening a patrol frame actually got, in a shape both the note and the page can read: without it
  // a MAP product looks the same whether its azimuth response was narrowed or fell back to the beam.
  static sharpState(dbs) {
    if (!dbs) return null;
    return {factor: dbs.factor, patrol: !!dbs.patrol, effective: dbs.effective, degraded: dbs.degraded, forward_cells: dbs.forward_cells};
  }
  static sharpStateText(dbs, factor) {
    if (!dbs) return '';
    if (dbs.effective === 'sharpened') return ` ·多普勒锐化 ${factor}:1`;
    if (dbs.effective === 'partly-sharpened') return ` ·多普勒锐化 ${factor}:1（近前视 ${dbs.forward_cells} 格保留实波束）`;
    return dbs.degraded === 'no_velocity' ? ' ·无地速退化实波束' : ` ·前视退化实波束 ${dbs.forward_cells} 格`;
  }
  frame(rect, cfg) {
    const pose = this.pose(); if (!pose) return null;
    // The frame is rendered for the sector it was collected for, not for the current heading: the mask
    // has to match the ground the cells were asked for, or a turn would show half a frame of ground the
    // plan never collected.
    // frame:0 — not the frame counter. The speckle of a rolling map has to be a property of the GROUND,
    // not of the frame that happens to show it: a per-frame draw re-rolls every cell between frames, and
    // the overlap of two consecutive windows then flickers and shows a grain-level seam in the mosaic. A
    // real aperture at a fixed frequency and a stable geometry sees the same clutter realisation while
    // the aircraft flies on; what this gives up is the frequency-agile decorrelation of a real radar (its
    // speckle really does change pulse to pulse), which matters less here than a base map that holds still.
    const result = mapEngine.renderFrame(this.cache, {center: rect.center, sensor: pose.pos, cells: cfg.cells, cell_m: cfg.cell,
      beam_deg: cfg.beam, looks: cfg.looks, stc: cfg.stc, shadow: cfg.shadow, peak_norm: cfg.peak_norm, frame: 0,
      dbs: {factor: cfg.dbs_factor, patrol: true}, sensorVel: this.velocity,
      sector: {heading: rect.heading, azimuth_deg: rect.azimuth_deg, range_m: rect.range_m}});
    const entry = this.ctx.keepImage(mapEngine.anchor(result), result, null);
    this.frames++; this.lastFrameAt = Date.now();
    this.renderedCenter = `${rect.center[0]},${rect.center[1]}`; this.renderedFraction = result.metadata.coverage.fraction;
    this.ctx.state.map.frames = this.frames;
    if (entry) this.ctx.state.map.lastFrame = {seq: entry.seq, completed: entry.completed, fraction: result.metadata.coverage.fraction,
      compute_ms: Math.round(result.metadata.compute_ms || 0), sharpen: MapSession.sharpState(result.metadata.dbs),
      // The surface-relief (DSM) layer that produced the shadows/bright edges of this frame: the table is
      // an assumption, so the page can show how much of the frame was lifted instead of implying it is
      // measured geometry. Render-only — the lattice keeps the bare DEM.
      relief: result.metadata.relief ? {cells: result.metadata.relief.cells, mean_m: result.metadata.relief.mean_m, max_m: result.metadata.relief.max_m} : null};
    // The sharpening state travels in the note: the base map is a MAP product on the outside, so without
    // this line a degraded (real-beam) sector would look exactly like a sharpened one. The frame note
    // itself is short-lived (the next collection overwrites it), so the same sentence is kept in
    // this.sharpenNote and repeated in the note that lingers while the sector waits for the aircraft.
    const sharpNote = MapSession.sharpStateText(result.metadata.dbs, cfg.dbs_factor);
    this.sharpenNote = sharpNote;
    this.ctx.state.map.note = `底图第 ${this.frames} 帧：扇形覆盖 ${(result.metadata.coverage.fraction * 100).toFixed(0)}%（${result.metadata.coverage.known}/${result.metadata.coverage.cells} 格），渲染 ${(result.metadata.compute_ms || 0).toFixed(0)} ms${sharpNote}`;
    return result;
  }
  finish(note) { this.active = false; this.ctx.state.map.note = note; this.ctx.state.phase = this.ctx.state.result ? '成像完成' : '地图完成'; }
  // One step of the map state machine: re-anchor the sector if the aircraft has left it, plan the
  // missing cells inside the beam wedge, draw a due frame, then collect the nearest missing piece.
  advance() {
    const cfg = this.params, pose = this.pose(), state = this.ctx.state;
    if (!pose) { this.probe(); return; }
    if (!this.rect) {
      // A sector placed before the heading is known points at a fabricated north — a direction the
      // aircraft may not be flying at all, with nothing to correct a manual single shot. The pose
      // from a prior SAR trajectory already carries one; otherwise probe until the next pose
      // completes the cross-job pair the heading is derived from.
      if (pose.heading == null) { this.probe(true); state.map.note = '已取得位置，等待下一个位姿以确定航向'; return; }
      this.rect = this.windowFor(pose, cfg);
    }
    let rect = this.rect, window = coverage(this.cache, rect), moved = null;
    // Re-anchor while the sector is still filling, not only after it is complete: the wedge is centred on
    // the aircraft, so 1 km of flight or a 12 deg turn already points it at the wrong ground — and a turn
    // invalidates the half-swept wedge outright. Re-anchoring keeps the lattice (world-fixed cells are
    // reused) and only re-plans what the wedge now covers. A manual single shot is exempt: it finishes
    // exactly the sector it was asked for.
    if (this.continuous) {
      const drift = this.drift(pose, rect), turn = this.turnDeg(pose, rect);
      if (drift >= MAP_ADVANCE_M || turn >= MAP_TURN_REANCHOR_DEG) {
        const reason = turn >= MAP_TURN_REANCHOR_DEG ? `机头已转 ${turn.toFixed(0)}°` : `本机已前进 ${(drift / 1000).toFixed(2)} km`;
        moved = `${reason}：扇形按当前位姿重摆，只补新格`;
        rect = this.rect = this.windowFor(pose, cfg); window = coverage(this.cache, rect);
      }
    }
    const plan = planJobs(this.cache, rect, {cell_m: cfg.cell, max_cells: MAP_JOB_CELLS, sensor: pose.pos, max_dim: PROTOCOL.sar.map.rows_max});
    state.map.coverage = +window.fraction.toFixed(4);
    state.map.window = this.windowSummary(rect);
    // Frame policy before the plan: a sector re-anchors every kilometre of flight, so waiting for "this
    // window is complete" would mean never drawing anything while flying. Continuous mode draws
    // progressive frames (a new one per MAP_FRAME_MIN_MS at the earliest, once coverage gained
    // MAP_RENDER_GAIN) plus one for a completed wedge; a manual shot draws exactly one, of its
    // finished sector, and never before it is finished.
    const key = `${rect.center[0]},${rect.center[1]}`, same = this.renderedCenter === key;
    const baseline = same ? this.renderedFraction : 0, gain = window.fraction - baseline, complete = window.fraction >= 1 && baseline < 1;
    const rateOk = this.frames === 0 || Date.now() - this.lastFrameAt >= MAP_FRAME_MIN_MS;
    const due = this.continuous ? (complete || (rateOk && gain >= MAP_RENDER_GAIN)) : complete;
    if (due && !this.frame(rect, cfg)) return;
    if (plan.jobs.length) {
      this.collect(plan.jobs[0], plan);
      if (moved) state.map.note = `${moved}；${state.map.note}`;
      return;
    }
    if (this.continuous) {
      // The aircraft keeps flying, but its position only reaches the service through captured poses.
      // A cheap 2x2 pose job keeps the wait honest: without it the loop would wait for movement it
      // cannot see, while the wedge is already complete.
      if (Date.now() - this.poseAt >= MAP_POSE_REFRESH_MS) { this.probe(true); return; }
      state.map.note = `扇形已采集完（${window.known}/${window.cells} 格${window.surface ? `，分类 ${window.surface}` : ''}），等待本机前进 ${MAP_ADVANCE_M} m 或转向 ${MAP_TURN_REANCHOR_DEG}° 后重摆${this.sharpenNote || ''}`;
      return;
    }
    this.finish(`地图扇区完成：覆盖 ${(window.fraction * 100).toFixed(0)}%（${window.known}/${window.cells} 格）`);
  }
  tryCapture() {
    if (!this.active || this.ctx.closed) return;
    const blocked = this.blocked();
    if (blocked) { this.ctx.state.map.note = blocked; if (!this.ctx.state.continuous.enabled) this.ctx.state.phase = blocked; return; }
    this.advance();
  }
  // /state summary: small enough for the 700 ms poll; frame matrices stay behind /image/<seq>.
  summary() {
    const cfg = this.params, collector = this.ctx.collector;
    return {active: this.active, continuous: this.active && this.continuous, note: this.ctx.state.map.note,
      frames: this.frames, jobs: this.jobs, failures: this.failures,
      cells: this.ctx.state.map.cells, surfaces: this.ctx.state.map.surfaces, coverage: this.ctx.state.map.coverage,
      window: this.ctx.state.map.window, lastFrame: this.ctx.state.map.lastFrame, progress: collector.map?.progress || null,
      reason: this.active ? this.blocked() : null, supported: !!collector.capabilities?.map,
      // Fine (16-class) surface classes can only come from the native probe on a new Export: the field is
      // present once such a name has been seen on this connection and absent while an old Export runs, so
      // the page can tell "engine mask" from "five-class fallback" without a second request.
      ...(collector.fineSurfaces ? {fineSurfaces: true} : {}),
      params: cfg ? {range_m: cfg.range, azimuth_deg: cfg.azimuth, cell_m: cfg.cell, grid: cfg.cells, beam_deg: cfg.beam, looks: cfg.looks,
        stc: cfg.stc, shadow: cfg.shadow, dbs_factor: cfg.dbs_factor, peak_norm: cfg.peak_norm} : null,
      pose: this.sensor ? {pos: this.sensor.map(v => +v.toFixed(1)),
        heading_deg: this.heading != null ? +(this.heading * 180 / Math.PI).toFixed(1) : null,
        age_s: this.poseAt ? +((Date.now() - this.poseAt) / 1000).toFixed(1) : null} : null,
      track: this.track || null};
  }
  completed(completed) {
    this.ingest(completed);
    if (this.pendingProbe) {
      this.pendingProbe = false;
      this.ctx.state.map.note = '已取得本机位姿，开始按当前航向布置地图窗';
    }
    this.tryCapture();
  }
  // Start (or restart) a session. Manual and patrol share this, so the reset is written once.
  start({cfg, continuous}) {
    this.lattice(cfg.cell);
    this.params = cfg; this.continuous = continuous; this.active = true; this.rect = null;
    this.renderedCenter = null; this.renderedFraction = 0; this.frames = 0; this.lastFrameAt = 0;
    this.pendingProbe = false;
    this.ctx.state.map.coverage = 0; this.ctx.state.map.frames = 0; this.ctx.state.map.failures = 0;
  }
}

// The requested parameters of a MAP job, validated against the generated service contract.
function mapParams(input = {}) {
  const cfg = {range: SAR_MAP_SERVICE_DEFAULTS.range_m, azimuth: SAR_MAP_SERVICE_DEFAULTS.azimuth_deg, cell: SAR_MAP_SERVICE_DEFAULTS.cell_m,
    beam: SAR_MAP_SERVICE_DEFAULTS.beam_deg, looks: SAR_MAP_SERVICE_DEFAULTS.looks, stc: SAR_MAP_SERVICE_DEFAULTS.stc,
    shadow: SAR_MAP_SERVICE_DEFAULTS.shadow, dbs_factor: SAR_MAP_SERVICE_DEFAULTS.dbs_factor, peak_norm: SAR_MAP_SERVICE_DEFAULTS.peak_norm, ...input};
  const number = (value, low, high, label) => { if (!Number.isFinite(value) || value < low || value > high) throw Error(`Invalid map ${label}`); return value; };
  const integer = (value, label) => { if (!Number.isInteger(value)) throw Error(`Invalid map ${label}`); return value; };
  cfg.range = number(cfg.range, MAP_LIMITS.service_range_m.min, MAP_LIMITS.service_range_m.max, 'range');
  cfg.azimuth = number(cfg.azimuth, MAP_LIMITS.service_azimuth_deg.min, MAP_LIMITS.service_azimuth_deg.max, 'azimuth');
  cfg.cell = integer(number(cfg.cell, MAP_LIMITS.service_cell_m.min, MAP_LIMITS.service_cell_m.max, 'cell size'), 'cell size');
  cfg.beam = number(cfg.beam, MAP_LIMITS.beam_deg.min, MAP_LIMITS.beam_deg.max, 'beam width');
  cfg.looks = integer(number(cfg.looks, MAP_LIMITS.looks.min, MAP_LIMITS.looks.max, 'look count'), 'look count');
  cfg.dbs_factor = integer(number(cfg.dbs_factor, MAP_LIMITS.dbs_factor_service.min, MAP_LIMITS.dbs_factor_service.max, 'dbs factor'), 'dbs factor');
  if (typeof cfg.stc !== 'boolean' || typeof cfg.shadow !== 'boolean' || typeof cfg.peak_norm !== 'boolean') throw Error('Invalid map options');
  // The frame size is not a free parameter any more: it is the square that holds the sector, so the
  // grid follows range/cell and only has to be checked against the frame budget.
  cfg.cells = sectorGrid({range_m: cfg.range, cell_m: cfg.cell});
  const grid = mapEngine.options({cell_m: cfg.cell, cells: cfg.cells, beam_deg: cfg.beam, looks: cfg.looks, stc: cfg.stc, shadow: cfg.shadow});
  cfg.cells = grid.cells;
  return cfg;
}

// The tile size decides the footprint: the small tile uses the 'area' slice, the 2048 m one the
// 'airport' overview.
module.exports = {MapSession, mapParams, MAP_ADVANCE_M, MAP_TURN_REANCHOR_DEG, MAP_JOB_CELLS, MAP_JOB_TIMEOUT_MS, MAP_FRAME_MIN_MS, MAP_RENDER_GAIN, MAP_POSE_REFRESH_MS};

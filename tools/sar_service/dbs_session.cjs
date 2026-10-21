'use strict';
// DBS (Doppler beam sharpening) session: the middle rung between the patrol's coarse base map and
// a 128 m SAR patch. The operator clicks a point, the service collects one small block of that
// ground on a 25 m lattice and renders it with the Doppler-sharpened beam of src/sar_core/map.cjs
// (ported from the DCS radar shader). It is MAP family throughout — CAPTURE_MAP for the collection,
// renderFrame for the picture, the mosaic for display — but it has its own lattice and its own
// session, so a DBS block never lands in the patrol's cache and a patrol never lands in the DBS one.
// The block is small (512 m at 25 m is 441 cells ≈ 26 frames of the Export) and one-shot: no
// rolling, no re-anchoring, no progressive frames.
const {sar, SAR_MAP_SERVICE_DEFAULTS, PROTOCOL} = require('../../src/shared/config.cjs');
const mapEngine = require('../../src/sar_core/map.cjs');
const {windowRect, coverage} = require('./coverage_index.cjs');

const MAP_DBS = sar.map.dbs;
const DBS_CELL = MAP_DBS.cell_m, DBS_SPAN_MIN = MAP_DBS.span_min_m, DBS_SPAN_MAX = MAP_DBS.span_max_m,
  DBS_SPAN_DEFAULT = MAP_DBS.span_default_m, DBS_SHARPENS = MAP_DBS.sharpens, DBS_SHARPEN_DEFAULT = MAP_DBS.sharpen_default;

class DbsSession {
  constructor(ctx) {
    this.ctx = ctx;
    this.active = false; this.point = null; this.span = 0; this.cells = 0; this.factor = DBS_SHARPEN_DEFAULT; this.pose = null; this.rect = null;
    this.frames = 0; this.failures = 0; this.started = 0; this.jobs = 0; this.reused = false;
    // The fine lattice is world-fixed, so the cells of a block stay valid for the next click nearby; the
    // limit is the same order as the patrol's because a 25 m lattice holds 100x more cells per square metre.
    this.cache = mapEngine.createCache({cell_m: DBS_CELL, limit: sar.map.lattice.limit});
  }
  grid(span) { return 2 * Math.round(span / (2 * DBS_CELL)) + 1; }
  // A DBS block is refused only for the reasons that make it meaningless: no terrain, no pose, or a point
  // the Export's own terrain range cannot reach. Unlike SAR it has no side-looking window — a block near
  // the nose is a perfectly good request that simply comes out as a real-beam picture (see the engine's
  // degradation statistics), and that is the case the display warns about instead of blocking.
  blocked() {
    const ctx = this.ctx;
    if (ctx.mode !== 'live' || !ctx.ready) return '等待 DCS Export 连接';
    if (!ctx.collector.capabilities?.map) return '需要新版 SAR Export（CAPTURE_MAP 增量地形）';
    if (!ctx.terrainReady()) return '等待可用地形接口';
    if (ctx.job || ctx.enriching || ctx.collector.job) return 'SAR 成像占用中，稍后再做 DBS 放大';
    if (this.active) return 'DBS 放大已在进行';
    // Only the patrol's rolling job gives way to a DBS block (its lattice survives and it resumes by
    // itself). A manual /map shot is a deliberate one-shot like a SAR patch, so a DBS waits for it.
    if (ctx.collector.map && !ctx.mapPatrol()) return '等待上一次地图采集结束';
    return null;
  }
  // DBS is between SAR and the patrol: a designated SAR patch takes the beam from everything (that is the
  // existing /capture path), a DBS block takes it from the patrol, and while a DBS block is in flight a new
  // SAR or DBS request is refused rather than interrupting it — the block is one to two seconds of work.
  canDbs() { return this.ctx.mode === 'live' && this.ctx.terrainReady() && !!this.ctx.collector.capabilities?.map && !this.ctx.job && !this.ctx.enriching && !this.ctx.collector.job && !this.active; }
  tryCapture() {
    if (!this.active || this.ctx.closed) return;
    const rect = windowRect({center: this.point, cell_m: DBS_CELL, cells: this.cells});
    this.rect = rect;
    // The fine lattice is world-fixed and survives between clicks, so a block that is already collected
    // (the same point twice, or a block overlapping an earlier one) is rendered straight away instead of
    // being asked for again: the Export is the scarce resource here, not the CPU.
    const known = coverage(this.cache, rect);
    if (known.fraction >= 1 && known.known > 0) {
      this.reused = true;
      this.completed({cells: [], surfaces: [], poses: []});
      return;
    }
    this.reused = false;
    this.ctx.write(this.ctx.collector.startMap({x0: rect.ix0 * DBS_CELL, z0: rect.iz0 * DBS_CELL, cols: rect.nx, rows: rect.nz, step: DBS_CELL, dbs: true}));
    this.jobs++;
    this.ctx.state.dbs.note = `采集 DBS 方块 ${rect.nx}×${rect.nz}（${rect.nx * rect.nz} 格 @${DBS_CELL} m）`;
  }
  // One job, one frame: the block arrives whole, is rendered for the pose it was designated from, and joins
  // the mosaic with mode:'dbs'. The cells go into the DBS lattice only — the patrol's map stays untouched.
  completed(completed) {
    for (const cell of completed.cells) this.cache.setHeight(...this.cache.index(cell.x, cell.z), cell.h);
    for (const surface of completed.surfaces) {
      const cell = completed.cells[surface.index]; if (!cell) continue;
      this.cache.setSurface(...this.cache.index(cell.x, cell.z), surface.name);
    }
    const rect = this.rect, pose = this.pose;
    // frame:0 for the same reason as the patrol frames: a block the operator clicks twice, or two
    // overlapping blocks, must show the same ground clutter instead of re-rolling it (see MapSession.frame).
    const result = mapEngine.renderFrame(this.cache, {center: rect.center, sensor: pose.pos, cells: this.cells, cell_m: DBS_CELL,
      beam_deg: SAR_MAP_SERVICE_DEFAULTS.beam_deg, looks: SAR_MAP_SERVICE_DEFAULTS.looks, stc: SAR_MAP_SERVICE_DEFAULTS.stc,
      shadow: SAR_MAP_SERVICE_DEFAULTS.shadow, peak_norm: SAR_MAP_SERVICE_DEFAULTS.peak_norm, frame: 0,
      dbs: {factor: this.factor}, sensorVel: pose.velocity});
    const entry = this.ctx.keepImage(mapEngine.anchor(result), result, null);
    this.frames++; this.active = false;
    const meta = result.metadata.dbs;
    if (entry) this.ctx.state.dbs.lastFrame = {seq: entry.seq, completed: entry.completed, point: this.point.slice(),
      span_m: result.size_m, cell_m: DBS_CELL, grid: result.width, sharpen: this.factor, reused: !!this.reused,
      effective: meta ? meta.effective : null, compute_ms: Math.round(result.metadata.compute_ms || 0)};
    const sharpenNote = meta ? (meta.effective === 'sharpened' ? `锐化 ${this.factor}:1` : meta.effective === 'partly-sharpened'
      ? `部分格退化为实波束（近前视 ${meta.forward_cells}/${meta.cells} 格）` : '整块退化为实波束（近前视或本机地速未知）') : '';
    const reusedNote = this.reused ? '，复用已采集格' : '';
    this.ctx.state.dbs.note = `DBS 放大完成：${result.size_m} m 块 @${DBS_CELL} m（${result.width}×${result.width}${sharpenNote ? `，${sharpenNote}` : ''}${reusedNote}），渲染 ${(result.metadata.compute_ms || 0).toFixed(0)} ms`;
    this.ctx.state.phase = this.ctx.state.result ? '成像完成' : 'DBS 完成';
    return result;
  }
  summary() {
    return {active: this.active, note: this.ctx.state.dbs.note,
      frames: this.frames, jobs: this.jobs, failures: this.failures,
      point: this.point ? this.point.slice() : null, span_m: this.span || null, cell_m: DBS_CELL,
      grid: this.cells || null, sharpen: this.factor, sharpens: DBS_SHARPENS.slice(),
      span_limits: [DBS_SPAN_MIN, DBS_SPAN_MAX],
      progress: this.ctx.collector.map?.dbs ? this.ctx.collector.map.progress : null,
      reason: this.active ? this.blocked() : null, supported: !!this.ctx.collector.capabilities?.map,
      lastFrame: this.ctx.state.dbs.lastFrame, canDbs: this.canDbs()};
  }
  start(request, pose) {
    this.active = true; this.point = request.point.slice(); this.span = request.span; this.cells = request.cells;
    this.factor = request.sharpen; this.pose = {pos: pose.pos.slice(), heading: pose.heading, velocity: pose.velocity ? pose.velocity.slice() : null};
    this.rect = null; this.started = Date.now();
    this.ctx.state.dbs.note = '准备 DBS 放大'; this.ctx.state.phase = '采集 DBS 放大块'; this.ctx.state.error = null;
    this.tryCapture();
  }
}

// The validated request of one block: a point, a span from the generated limits, and a sharpen factor.
function dbsRequest(input = {}) {
  const x = input.x, z = input.z;
  if (!Number.isFinite(x) || !Number.isFinite(z) || Math.abs(x) > 1e8 || Math.abs(z) > 1e8) throw Error('Invalid dbs point');
  const span = input.span_m === undefined ? DBS_SPAN_DEFAULT : input.span_m;
  if (!Number.isFinite(span) || span < DBS_SPAN_MIN || span > DBS_SPAN_MAX) throw Error(`Invalid dbs span_m (${DBS_SPAN_MIN}-${DBS_SPAN_MAX})`);
  const sharpen = input.sharpen === undefined ? DBS_SHARPEN_DEFAULT : input.sharpen;
  if (!DBS_SHARPENS.includes(sharpen)) throw Error(`Invalid dbs sharpen (${DBS_SHARPENS.join(' or ')})`);
  return {point: [x, z], span, sharpen, cells: 2 * Math.round(span / (2 * DBS_CELL)) + 1};
}

module.exports = {DbsSession, dbsRequest, DBS_CELL, DBS_SPAN_MIN, DBS_SPAN_MAX, DBS_SPAN_DEFAULT, DBS_SHARPENS, DBS_SHARPEN_DEFAULT};

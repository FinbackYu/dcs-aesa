'use strict';
// The SAR service: one CompositionRoot that wires the wire collector, the imaging chain, the
// sessions and the HTTP API together. Everything here is policy between modules — which capture the
// next one is, what a failure retires, when the Export is considered stale — while the physics
// lives in src/sar_core/, the protocol in collector.cjs and the routes in http_api.cjs.
const path = require('node:path');
const {runImage, poolSize} = require('../../src/sar_core/pool.cjs');
const {validate, apertureGeometry} = require('../../src/sar_core/geometry.cjs');
const {settings} = require('../../src/sar_core/settings.cjs');
const {processingOptions} = require('../../src/adapters/dcs/sar_adapter.cjs');
const {footprint, sceneFootprint} = require('../../src/adapters/dcs/sar_adapter.cjs');
const {createBridge} = require('../sar_bridge.cjs');
const CONFIG = require('../../src/shared/config.cjs');
const {PROTOCOL, SAR_MAP_SERVICE_DEFAULTS} = CONFIG;
const PROTOCOL_SAR = PROTOCOL.sar;
const MAP_LIMITS = CONFIG.sar.map.limits, MAP_MOVER = CONFIG.sar.map.mover;
const {Collector} = require('./collector.cjs');
const {MosaicStore, MOSAIC_LIMIT} = require('./mosaic_store.cjs');
const {Recorder} = require('./recorder.cjs');
const {SweepPlanner, sweepRegion, SWEEP_DEFAULT_SIZE, SWEEP_SIZES, SWEEP_RETRY_MS} = require('./sweep_planner.cjs');
const {MapSession, mapParams, MAP_JOB_TIMEOUT_MS} = require('./map_session.cjs');
const {DbsSession, dbsRequest, DBS_CELL} = require('./dbs_session.cjs');
const {flightIssue, gateReason, designateCheck, trajectoryPose, leadPose, IMAGE_MIN_RANGE_M, IMAGE_MAX_RANGE_M} = require('./arbiter.cjs');
const {createHttpApi} = require('./http_api.cjs');

// Continuous mode never stops by itself: it skips unsuitable opportunities, says why, and keeps
// retrying. A prediction older than gateWindowMs means "no fresh geometry knowledge: take the shot".
const GATE_WINDOW_MS = 8000;
// GMTI track picture (live mode only): the mission sampler lists ground movers around the aircraft
// and the service turns that into what the radar can actually see. A target whose own radial velocity
// is below the minimum detectable velocity stays buried in the clutter no matter how fast the
// platform flies — clutter cancellation removes the platform's Doppler, not the target's — so the
// threshold is applied to the target's velocity along the line of sight. 2 m/s is the RQ-4 GMTI
// class figure (4 kt ≈ 2.06 m/s) and the poll keeps the picture fresh without flooding the bridge.
const MOVER_POLL_MS = MAP_MOVER.poll_ms, MOVER_RADIUS_M = MAP_MOVER.radius_max_m, MOVER_MAX = MAP_MOVER.max, MOVER_MDV_MPS = MAP_MOVER.mdv_mps;

function createService({tcpPort = PROTOCOL.ports.sar_tcp, httpPort = PROTOCOL.ports.sar_http, scenePort = tcpPort === 0 ? 0 : PROTOCOL.ports.sar_scene,
  recordDir = path.join(__dirname, '..', '..', 'recordings', 'sar'), scene = null, display = null, mode = 'live', processing = {window: 'hann'},
  workers = poolSize(), mosaicLimit = MOSAIC_LIMIT, gateWindowMs = GATE_WINDOW_MS, moverPollMs = MOVER_POLL_MS, moverMdvMps = MOVER_MDV_MPS} = {}) {
  settings(processing);
  const gateWindow = Number.isFinite(gateWindowMs) && gateWindowMs >= 0 ? gateWindowMs : GATE_WINDOW_MS;
  const moverEvery = Number.isFinite(moverPollMs) && moverPollMs > 0 ? moverPollMs : MOVER_POLL_MS;
  const moverMdv = Number.isFinite(moverMdvMps) && moverMdvMps >= 0 ? moverMdvMps : MOVER_MDV_MPS;
  const collector = new Collector(), mosaic = new MosaicStore({limit: mosaicLimit}), recorder = new Recorder(recordDir);
  let socket = null, ready = false, job = null, closed = false, lastScene = null, displayedScene = null, continuousOptions = null;
  let nextCaptureAt = 0, enriching = null, lastCaptured = null, lastFailures = [];
  const state = {mode, phase: '等待 DCS Export 连接', error: null, result: null, record: null, compat: null,
    continuous: {enabled: false, mode: 'relative', side: 1, range: 20000, record: false, quality: 'standard', window: 'hann', completed: 0, failures: 0, skipped: 0, captureSide: 1, nextSide: 1, sweepPlan: null, sweepIndex: 0, sweepAnchor: null, sweepPruned: 0, sweepDeferred: 0, sweepSize: SWEEP_DEFAULT_SIZE, note: '未启动'},
    map: {note: '未启动', coverage: 0, cells: 0, surfaces: 0, window: null, frames: 0, jobs: 0, lastFrame: null},
    dbs: {note: '未启动', lastFrame: null},
    movers: null, moversNote: '未获取'};
  const write = line => { if (socket && !socket.destroyed) socket.write(line); };
  const terrainReady = () => ready && collector.status?.provider === 'terrain.GetHeight' && Date.now() - collector.status.received < PROTOCOL.timeouts.sar_status_stale_ms;
  const busy = () => !!(job || enriching || collector.job || collector.map);
  const available = () => mode === 'live' && terrainReady() && !job && !enriching && !collector.job && !collector.map;
  const mapPatrol = () => state.continuous.enabled && state.continuous.mode === 'map';
  const keepImage = (scene, result, record, at) => mosaic.keep(scene, result, record, at);
  const summary = MosaicStore.summary;

  const planner = new SweepPlanner({mosaic, state});
  const mapSession = new MapSession({state, collector, mode, ready, closed: false, job, enriching,
    write, terrainReady, busy, mapPatrol, keepImage, currentPose: () => currentPose(), closed: () => closed});
  const dbsSession = new DbsSession({state, collector, mode, ready, closed: false, job, enriching, write, terrainReady, mapPatrol, keepImage});
  // The sessions read the live flags through `ctx`; these getters keep them in step with the closure
  // variables above instead of copying them once.
  Object.defineProperty(mapSession.ctx, 'ready', {get: () => ready});
  Object.defineProperty(mapSession.ctx, 'job', {get: () => job});
  Object.defineProperty(mapSession.ctx, 'enriching', {get: () => enriching});
  Object.defineProperty(mapSession.ctx, 'closed', {get: () => closed});
  Object.defineProperty(dbsSession.ctx, 'ready', {get: () => ready});
  Object.defineProperty(dbsSession.ctx, 'job', {get: () => job});
  Object.defineProperty(dbsSession.ctx, 'enriching', {get: () => enriching});
  Object.defineProperty(dbsSession.ctx, 'closed', {get: () => closed});

  // The Export status carries no position or heading, so the aircraft symbol and track come from
  // the newest captured trajectory: its last pose is where the aircraft was for that patch.
  function ownship() {
    const trajectory = lastCaptured?.scene?.trajectory || displayedScene?.trajectory || lastScene?.trajectory;
    if (!Array.isArray(trajectory) || trajectory.length < 2) {
      // A MAP-only session has no SAR trajectory; its own pose stream still drives the mosaic view.
      return mapSession.sensor ? {pos: mapSession.sensor.map(v => +v.toFixed(1)), t: null,
        age_s: mapSession.poseAt ? +((Date.now() - mapSession.poseAt) / 1000).toFixed(1) : null,
        heading_deg: mapSession.heading != null ? +(mapSession.heading * 180 / Math.PI).toFixed(1) : null,
        speed_mps: null, track: mapSession.track || []} : null;
    }
    const last = trajectory.at(-1), previous = trajectory[trajectory.length - 2], dt = last.t - previous.t;
    const step = Math.max(1, Math.ceil(trajectory.length / 32));
    return {pos: last.pos.map(v => +v.toFixed(1)), t: last.t, age_s: lastCaptured ? +((Date.now() - lastCaptured.at) / 1000).toFixed(1) : null,
      heading_deg: dt > 0 ? +(Math.atan2(last.pos[0] - previous.pos[0], last.pos[2] - previous.pos[2]) * 180 / Math.PI).toFixed(1) : null,
      speed_mps: dt > 0 ? +(Math.hypot(last.pos[0] - previous.pos[0], last.pos[2] - previous.pos[2]) / dt).toFixed(1) : null,
      track: trajectory.filter((pose, index) => index % step === 0 || index === trajectory.length - 1).map(pose => [+pose.pos[0].toFixed(1), +pose.pos[2].toFixed(1)])};
  }
  function currentPose() {
    const trajectory = lastCaptured?.scene?.trajectory || displayedScene?.trajectory || lastScene?.trajectory;
    return trajectoryPose(trajectory, lastCaptured?.scene?.center?.[1]);
  }
  // A restored snapshot may predate the db_ref field: the SAR engine's reference is the display
  // default, so a display image without one is described rather than refused (a MAP entry never is —
  // see MosaicStore.keep).
  if (display) {
    const r = display.result, n = r?.width * r?.width;
    if (scene || !Number.isSafeInteger(display.completed) || display.completed <= 0 || !r || !['dcs', 'synthetic-demo'].includes(r.source) || !Object.values(CONFIG.sar.footprints).map(f => f.size_m).includes(r.size_m) || !CONFIG.sar.render.widths_px.includes(r.width)
      || !Array.isArray(r.db) || r.db.length !== n || !r.db.every(v => Number.isFinite(v) && v >= CONFIG.display.db.floor_db && v <= 0)
        || !Array.isArray(r.power) || r.power.length !== n || !r.power.every(v => Number.isFinite(v) && v >= 0)
        || !r.metadata || typeof r.metadata !== 'object'
        || (display.target && (!Number.isFinite(display.target.latitude) || Math.abs(display.target.latitude) > 90
          || !Number.isFinite(display.target.longitude) || Math.abs(display.target.longitude) > 180
          || !Number.isFinite(display.target.ground_range_m) || display.target.ground_range_m < PROTOCOL_SAR.capture.min_range_m || display.target.ground_range_m > PROTOCOL_SAR.capture.max_range_m
          || !Number.isFinite(display.target.relative_track_deg) || Math.abs(display.target.relative_track_deg) > 180))) throw Error('Invalid restored SAR display');
    if (display.scene) {
      validate(display.scene);
      if (display.scene.source !== r.source || display.scene.size !== r.size_m
          || ['latitude', 'longitude', 'ground_range_m', 'relative_track_deg'].some(k => display.scene.target?.[k] !== display.target?.[k])) throw Error('Restored scene differs from display');
      lastScene = displayedScene = display.scene;
    } else displayedScene = {target: display.target};
    state.result = r; state.completed = display.completed; state.restoredDisplay = true; state.restoredInput = !!display.scene;
    if (display.scene) keepImage(display.scene, r, null, display.completed);   // anchored snapshots join the mosaic
  }
  const bridge = createBridge({port: scenePort});
  const moverPoll = {pending: false, at: 0, updatedAt: 0};
  // --- GMTI track picture ---------------------------------------------------------------------
  // One reported mover -> the contract the display draws, or null when the radar could not see it.
  function moverEntry(report, own) {
    const dx = report.pos[0] - own.pos[0], dz = report.pos[2] - own.pos[2], range = Math.hypot(dx, dz);
    if (!(range > 1) || range > MOVER_RADIUS_M) return null;
    // The Doppler that survives clutter cancellation is the target's own velocity along the line of
    // sight; a parked vehicle or one moving across the beam is in the blind zone either way.
    const radial = (report.v[0] * dx + report.v[2] * dz) / range;
    if (Math.abs(radial) < moverMdv) return null;
    return {x: +report.pos[0].toFixed(1), z: +report.pos[2].toFixed(1), speed: +Math.hypot(report.v[0], report.v[2]).toFixed(1),
      headingDeg: +(Math.atan2(report.v[0], report.v[2]) * 180 / Math.PI).toFixed(1), ageS: 0};
  }
  function moverSeen(own) {
    return list => list.map(report => moverEntry(report, own)).filter(Boolean)
      .sort((a, b) => Math.hypot(a.x - own.pos[0], a.z - own.pos[2]) - Math.hypot(b.x - own.pos[0], b.z - own.pos[2]))
      .slice(0, MOVER_MAX);
  }
  // Degradation is explicit: movers are either the current picture or null with a reason, never a
  // stale list pretending to be live.
  function moverDegraded(note) { state.movers = null; state.moversNote = note; moverPoll.updatedAt = Date.now(); }
  function pollMovers() {
    if (closed) return;
    if (mode !== 'live') { if (state.movers !== null) moverDegraded('非 live 模式不启用动目标数据链'); else state.moversNote = '非 live 模式不启用动目标数据链'; return; }
    if (!bridge.capabilities.connected || bridge.capabilities.movers !== 'world.searchObjects') {
      const note = !bridge.capabilities.connected ? '场景桥未连接：动目标数据链不可用' : 'mission 采样器不支持动目标查询，请重新部署场景钩子';
      if (state.movers !== null) moverDegraded(note); else state.moversNote = note;
      return;
    }
    if (moverPoll.pending) return;
    const now = Date.now();
    if (now - moverPoll.at < moverEvery) return;
    const own = ownship();
    if (!own || !Array.isArray(own.pos)) return moverDegraded('本机尚无轨迹，动目标查询待机');
    moverPoll.at = now; moverPoll.pending = true;
    bridge.movers({cx: own.pos[0], cz: own.pos[2], radius: MOVER_RADIUS_M}).then(result => {
      moverPoll.pending = false;
      if (closed) return;
      if (!result || !result.complete) return moverDegraded(`动目标查询失败：${result && result.reason ? result.reason : '未知原因'}`);
      const seen = moverSeen(own)(result.movers);
      state.movers = seen; moverPoll.updatedAt = Date.now();
      state.moversNote = seen.length ? `${seen.length} 个动目标（径向 |v| ≥ ${moverMdv} m/s；入检 ${result.movers.length} 个）` : '当前无满足多普勒门限的动目标';
    }, e => { moverPoll.pending = false; moverDegraded(`动目标查询失败：${e.message}`); });
  }
  // The picture ages between polls, so the age is computed when it is read rather than frozen at
  // poll time; every entry of one poll shares it.
  function refreshMoverAges() {
    if (!state.movers) return;
    const age = +((Date.now() - moverPoll.updatedAt) / 1000).toFixed(1);
    for (const entry of state.movers) entry.ageS = age;
  }
  function abort(error, countFailure = true) {
    enriching = null; bridge.cancel(); collector.job = null; collector.map = null; state.error = error; state.phase = '采集失败';
    // Failure history survives later phase/error overwrites so post-mortem diagnosis can read it.
    const failed = planner.inFlight;
    lastFailures.push({at: new Date().toISOString(), error: String(error), cell: failed ? {center: failed.center, rangeM: failed.rangeM, angleDeg: failed.angleDeg} : null, ownship: ownship()?.pos || null});
    while (lastFailures.length > 12) lastFailures.shift();
    // A sweep tile that failed (bad geometry at capture, or a compute refusal such as the
    // simulated-pulse ceiling) is retired as skipped and backed off, so the fixed grid moves on to
    // the next tile instead of picking the same one forever. The failure is still counted.
    planner.failed();
    // A failed MAP job is dropped whole by the collector. A continuous patrol keeps its session and is
    // retried by tryContinuous() after the backoff, but a manual /map is one deliberate shot: it ends
    // here with the reason so the page can stop/resend instead of being locked out by a session that
    // is no longer making progress. A DBS block is one-shot too and already ends below.
    if (mapSession.active) {
      mapSession.failures++; state.map.failures = mapSession.failures;
      if (mapSession.continuous) state.map.note = `地图采集失败：${error}`;
      else { mapSession.active = false; mapSession.pendingProbe = false; state.map.note = `地图采集失败：${error}（可重新发起）`; }
    }
    if (dbsSession.active) { dbsSession.active = false; dbsSession.failures++; state.dbs.note = `DBS 放大失败：${error}`; }
    if (state.continuous.enabled) {
      if (countFailure) state.continuous.failures++;
      nextCaptureAt = Date.now() + PROTOCOL.timeouts.sar_map_retry_backoff_ms;
      const reason = failed ? `：${error}；该瓦片退避 ${Math.round(SWEEP_RETRY_MS / 1000)} s` : '';
      state.continuous.note = countFailure ? `本次失败（累计 ${state.continuous.failures} 次）${reason}，稍后重试` : '等待 Export 恢复连接';
    }
  }
  function beginCapture(params, options, continuous = false) {
    const geographic = Object.hasOwn(params, 'latitude') || Object.hasOwn(params, 'longitude');
    if (geographic && !collector.status.geo_available) throw Error('Geographic API unavailable; update Export and re-enter mission');
    const region = params.footprint || 'detail'; footprint(region);
    if ((region !== 'detail' || params.worldX !== undefined) && collector.capabilities?.version !== PROTOCOL.versions.sar_caps) throw Error('Update SAR Export for larger/world-coordinate captures');
    const command = params.worldX !== undefined ? collector.startWorld(params.worldX, params.worldZ, region) : geographic ? collector.startGeo(params.latitude, params.longitude, region) : collector.start(params.side, params.range, region);
    collector.job.processing = options;
    if (continuous) collector.job.continuous = true;
    state.phase = '采集地形与轨迹'; state.error = null;
    if (!continuous) { state.result = null; state.record = null; lastScene = null; displayedScene = null; }
    write(command); return collector.job.id;
  }
  // Continuous mode: gate, then capture. An unsuitable flight is skipped with a reason and retried;
  // side 0 alternates right/left so one pass covers both sides of the track. Mode 'sweep' takes the
  // best uncovered world tile of the current window instead of one fixed side/range patch.
  function tryContinuous() {
    if (!state.continuous.enabled || closed || job || enriching || collector.job || collector.map || Date.now() < nextCaptureAt) return;
    if (!available()) {
      const reason = !ready ? '等待 DCS Export 连接' : collector.status?.provider !== 'terrain.GetHeight' ? '等待可用地形接口' : '等待任务继续运行';
      state.continuous.note = reason; state.phase = reason; return;
    }
    // A MAP needs no focusing geometry, so it skips the flight gate: the beam map is exactly what
    // an unsuitable-SAR flight can still see. It has its own window state machine.
    if (state.continuous.mode === 'map') { mapSession.tryCapture(); return; }
    // The sweep judges the geometry of the square it is about to take, not of the one it just took,
    // so both halves of this decision run at the predicted pose (and the selection gets the same one).
    const sweep = state.continuous.mode === 'sweep';
    const predicted = sweep ? planner.lead(currentPose()) : null;
    const issue = gateReason(lastCaptured, gateWindow, !sweep);
    if (issue) { state.continuous.note = `暂不采集：${issue}`; state.phase = state.continuous.note; return; }
    if (sweep) { trySweepCapture(predicted); return; }
    if (state.continuous.side === 0) {
      const side = state.continuous.nextSide ?? 1;
      state.continuous.captureSide = side; state.continuous.nextSide = -side;
    } else state.continuous.captureSide = state.continuous.side;
    try {
      beginCapture({...state.continuous, side: state.continuous.captureSide}, continuousOptions, true);
      state.continuous.note = `正在采集第 ${state.continuous.completed + 1} 张（${state.continuous.captureSide === 1 ? '右' : '左'}侧）`;
    } catch (e) { abort(e.message); }
  }
  function trySweepCapture(predicted) {
    // Sweep cells are world-anchored patches, which the Export only accepts from version 2 on.
    if (collector.capabilities?.version !== PROTOCOL.versions.sar_caps) { state.continuous.note = '暂不采集：广域扫掠需要新版 SAR Export（世界坐标采集）'; state.phase = state.continuous.note; return; }
    const next = predicted ? planner.next(predicted) : {bootstrap: true};
    if (next.bootstrap) {
      // Without a captured trajectory the service does not know where the aircraft is: take one
      // patch in relative mode to learn the pose, then measure the window from it.
      state.continuous.captureSide = state.continuous.side === -1 ? -1 : 1;
      try {
        beginCapture({...state.continuous, side: state.continuous.captureSide}, continuousOptions, true);
        state.continuous.note = `首次采集（尚无本机位置）：${state.continuous.captureSide === 1 ? '右' : '左'}侧 ${(state.continuous.range / 1000).toFixed(0)} km`;
      } catch (e) { abort(e.message); }
      return;
    }
    if (next.exhausted) { state.continuous.note = next.exhausted; state.phase = next.exhausted; return; }
    try {
      // The tile is a fixed world square, so the capture names it directly (512 m → 'area' slice,
      // 2048 m → 'airport' overview; see sweepRegion).
      beginCapture({worldX: next.cell.center[0], worldZ: next.cell.center[2], footprint: sweepRegion(state.continuous.sweepSize)}, continuousOptions, true);
      state.continuous.captureSide = next.cell.side;
      const prefix = planner.notePrefix ? `${planner.notePrefix}；` : '';
      const pruned = state.continuous.sweepPruned ? `；窗口内已覆盖 ${state.continuous.sweepPruned} 块` : '';
      const basis = predicted && predicted.lead_s ? `前推 ${predicted.lead_s} s 处 ` : '';
      state.continuous.note = `${prefix}正在采集第 ${state.continuous.completed + 1} 张（瓦片 ${next.cell.size_m} m ${next.cell.side === 1 ? '右' : '左'} ${next.cell.angleDeg}° / ${basis}${(next.cell.rangeM / 1000).toFixed(1)} km，候选 ${next.index + 1}/${state.continuous.sweepPlan.length}${pruned}）`;
    } catch (e) { abort(e.message); }
  }
  // Which pose a designation is judged from. The MAP patrol comes first because a radar watch can be
  // the only position source there is — starting the watch and designating straight away is now a
  // normal flow, with no SAR patch captured yet. A pose without a heading is not usable, though: the
  // squint would be measured against an invented north, so that case falls through to the SAR
  // trajectory and fails only if that is missing too. (mapPose()'s heading??0 stays the right thing for
  // placing a map window, which only needs a coarse direction, but here it would fabricate a
  // plausible-looking verdict.)
  // The velocity travels with the pose because DBS needs the Doppler gradient: a MAP pose carries the
  // MAPPOSE velocity and a SAR pose the mean ground velocity of its trajectory, so both sources can
  // sharpen — and a pose without one is reported as such instead of being sharpened from an invented
  // direction.
  function designatePose() {
    if (mapSession.sensor && mapSession.heading != null)
      return {pos: mapSession.sensor.slice(), heading: mapSession.heading, velocity: mapSession.velocity ? mapSession.velocity.slice() : null};
    const pose = currentPose();
    return pose ? {pos: pose.pos.slice(), heading: pose.heading, velocity: pose.velocity ? pose.velocity.slice() : null} : null;
  }
  // Drop an in-flight MAP-family job and say which session lost it. CANCEL ends the Export's cell stream;
  // the patrol keeps its lattice and re-asks for the missing rest when it resumes, while a DBS block is
  // one-shot — nothing would ever ask for its cells again, so the session ends here with the reason.
  function cancelMapJob({map, dbs} = {}) {
    if (!collector.map) return null;
    const cancelled = collector.map; collector.map = null; write('CANCEL\n');
    if (cancelled.dbs) { dbsSession.active = false; if (dbs) state.dbs.note = dbs; }
    else if (map) state.map.note = map;
    return cancelled;
  }
  function compute(input, save = true, options = input.processing || processing, continuousCapture = false) {
    settings(options); lastScene = input;
    validate(input); state.phase = '计算复数回波与聚焦'; state.error = null; if (!continuousCapture) state.result = null;
    let record = !save && input === displayedScene ? state.record : null;
    if (save) record = recorder.save(input);
    // One image at a time: `job` is the in-flight computation (single worker or a whole pool
    // team, see pool.cjs) and doubles as the busy flag everywhere else in this service.
    // It always settles — including when a worker dies — so the loop below cannot stall.
    const current = job = runImage(input, options, {workers});
    current.done.then(result => {
      if (job !== current) return; job = null;
      state.result = result; displayedScene = input; state.record = record; state.completed = Date.now(); state.phase = '成像完成';
      state.restoredDisplay = false; state.restoredInput = false;
      keepImage(input, result, record, state.completed);
      planner.done();
      if (continuousCapture) {
        state.continuous.completed++; state.continuous.failures = 0; nextCaptureAt = Date.now() + 500;
        state.continuous.note = state.continuous.enabled ? '本张完成，准备下一次采集' : '已停止，保留最后完成图像';
      }
    }, e => { if (job !== current) return; job = null; if (!closed) abort(e.message); }).finally(tryContinuous);
  }
  // A completed capture: enrich it with the mission's surface/object data, then gate and compute it.
  function captured(completed) {
    enriching = completed.id; state.phase = '等待地表与对象数据';
    bridge.finish(completed).then(extras => {
      if (closed || enriching !== completed.id) return;
      enriching = null; Object.assign(completed, extras);
      if (completed.surface_provider && completed.scene_data.surface_provider === 'unavailable') completed.scene_data.surface_provider = completed.surface_provider;
      lastCaptured = {scene: completed, at: Date.now()};
      // Continuous mode assesses the just-captured geometry: an unusable patch is skipped with
      // a reason instead of being computed, recorded or counted as a failure. The 2 s spacing
      // keeps that reason readable on the page before the loop retries.
      if (completed.continuous) {
        const issue = flightIssue(completed);
        if (issue) {
          state.continuous.skipped++; nextCaptureAt = Date.now() + PROTOCOL.timeouts.sar_map_retry_backoff_ms; state.phase = '连续采集：跳过本次';
          state.continuous.note = `已跳过本次：${issue}`;
          if (planner.inFlight) {
            planner.inFlight.status = 'skipped'; planner.defer(planner.inFlight);
            state.continuous.note = `已跳过瓦片：${issue}；该瓦片退避 ${Math.round(SWEEP_RETRY_MS / 1000)} s`;
            planner.inFlight = null;
          }
          tryContinuous(); return;
        }
      }
      try { compute(completed, !completed.continuous || state.continuous.record, completed.processing || processing, !!completed.continuous); } catch (e) { abort(e.message); }
    });
  }
  // The TCP side of the Export protocol: greeting, line framing, and routing a completed job to the
  // session that asked for it.
  const tcp = require('node:net').createServer(c => {
    if (mode !== 'live' || socket) { c.destroy(); return; }
    socket = c; c.setNoDelay(true); let buf = ''; ready = false; collector.fineSurfaces = false; collector.compat = null; state.compat = null;
    c.on('data', chunk => {
      buf += chunk.toString('ascii');
      if (buf.length > PROTOCOL.limits.recv_buffer_bytes) { abort('Protocol buffer overflow'); c.destroy(); return; }
      while (buf.includes('\n')) {
        const split = buf.indexOf('\n'), line = buf.slice(0, split).replace(/\r$/, ''); buf = buf.slice(split + 1);
        try {
          if (!ready) { if (line !== `HELLO,${PROTOCOL.versions.sar}`) throw Error('Invalid greeting'); ready = true; state.phase = '已连接，等待地形探测'; continue; }
          const completed = collector.accept(line);
          // The collector owns the strict COMPAT parse; /state carries only that three-field summary.
          if (collector.compat) state.compat = collector.compat;
          // Ask for the fine surface vocabulary once, right after the Export says it can collect a map.
          // An Export that predates this command ignores it silently and keeps answering with the five
          // legacy classes, so old and new Exports both work; an old service never sends it, so a new
          // Export keeps its fine classes to itself and the old service still parses every line.
          if (line.startsWith('CAPS,') && collector.capabilities?.map) write('SURFACE_FINE\n');
          // A completed MAP-family job is routed by its marker: a DBS block goes to its own lattice and
          // one-shot render, everything else is the patrol's rolling window.
          if (completed?.kind === 'map') { completed.dbs ? dbsSession.completed(completed) : mapSession.completed(completed); continue; }
          if (line.startsWith('BEGIN,') && collector.job) bridge.request(collector.job);
          if (completed) captured(completed);
        } catch (e) { abort(e.message); c.write('CANCEL\n'); }
      }
      tryContinuous();
    });
    c.on('error', () => {});
    c.on('close', () => {
      if (socket !== c) return;
      socket = null; ready = false; collector.status = null; collector.capabilities = null; collector.compat = null; state.compat = null;
      if (collector.job) abort('Export disconnected; incomplete capture discarded', false);
      if (collector.map) abort('Export disconnected; incomplete map discarded', false);
      tryContinuous();
    });
  });
  // The 100 ms tick: stale exports, capture and map timeouts, the continuous loop and the mover poll.
  const timer = setInterval(() => {
    if (state.continuous.enabled && collector.job && collector.status && Date.now() - collector.status.received >= PROTOCOL.timeouts.sar_status_stale_ms) {
      collector.job = null; write('CANCEL\n'); state.phase = state.continuous.note = '等待任务继续运行'; state.error = null;
    }
    if (collector.job && Date.now() - collector.job.started > PROTOCOL.timeouts.sar_capture_timeout_ms) { abort('Capture timed out (paused mission or missing data)'); write('CANCEL\n'); }
    // A MAP job is dropped the same way when the mission stops reporting, and is timed out on its own
    // budget: the cell data of a dropped job is discarded, so the next attempt re-asks for it.
    if (collector.map && collector.status && Date.now() - collector.status.received >= PROTOCOL.timeouts.sar_status_stale_ms) {
      const dropped = cancelMapJob({map: '等待任务继续运行', dbs: 'DBS 放大中止：等待任务继续运行'});
      // A manual shot has no owner that would ask again: end it with a reason so it can be resent.
      if (dropped && !dropped.dbs && !mapSession.continuous) { mapSession.active = false; mapSession.pendingProbe = false; state.map.note = '地图采集暂停（任务未继续报告），可重新发起'; }
      state.error = null;
    }
    if (collector.map && Date.now() - collector.map.started > MAP_JOB_TIMEOUT_MS) {
      const timedOut = cancelMapJob({dbs: 'DBS 放大超时（任务暂停或数据缺失），可重新点选'});
      if (timedOut && timedOut.dbs) { dbsSession.failures++; }
      else {
        mapSession.failures++; state.map.failures = mapSession.failures;
        if (mapSession.continuous) { nextCaptureAt = Date.now() + PROTOCOL.timeouts.sar_map_retry_backoff_ms; state.map.note = '地图采集超时（任务暂停或数据缺失），稍后重试'; }
        else { mapSession.active = false; mapSession.pendingProbe = false; state.map.note = '地图采集超时（任务暂停或数据缺失），可重新发起'; }
      }
    }
    // Retrying a MAP job belongs to the continuous patrol only, through tryContinuous() below and its
    // own backoff. A manual /map that failed has already closed its session in abort(); re-issuing it
    // from this 100 ms tick was the infinite-retry bug (the page could neither stop nor resend it).
    tryContinuous();
    pollMovers();
  }, 100);
  // The largest sweep tile the PFA can focus: a tile whose footprint is the airport overview (2048 m)
  // is outside the plane-wave limits and past the 2048² k-grid, so the sweep falls back to
  // backprojection for it and says so. Derived from the footprint table rather than a tile constant,
  // so a new footprint size cannot silently inherit the wrong focuser rule.
  const maxPfaTile = Math.max(...SWEEP_SIZES.filter(size => sweepRegion(size) !== 'airport'));
  const api = createHttpApi({state, collector, mosaic, bridge, mapSession, dbsSession, mode, processing,
    ready: () => ready, isReady: () => ready, terrainReady, busy, available, mapPatrol, keepImage, summary, ownship, refreshMoverAges,
    designatePose, designateCheck: (pose, x, z) => designateCheck(pose, x, z, {flightIssue: lastCaptured && Date.now() - lastCaptured.at <= gateWindow ? flightIssue(lastCaptured.scene, false) : null}),
    beginCapture, compute, cancelMapJob, tryContinuous, getEnriching: () => enriching, clearEnriching: () => { enriching = null; bridge.cancel(); },
    getFailures: () => lastFailures, get job() { return job; }, set job(value) { job = value; },
    continuousOptions: () => continuousOptions, setContinuousOptions: value => { continuousOptions = value; },
    getLastScene: () => lastScene, getDisplayedScene: () => displayedScene,
    setNextCaptureAt: value => { nextCaptureAt = value; }, write,
    footprint, sceneFootprint, mapParams, dbsRequest, mapLattice: cell => mapSession.lattice(cell),
    // The sweep's own contract: tile sizes, their default, the footprint a tile maps to, the focuser
    // limit, and the prefix (a fallback notice) that rides on the next capture's note.
    sweepSizes: SWEEP_SIZES, sweepDefaultSize: SWEEP_DEFAULT_SIZE, sweepRegion, maxPfaTile,
    setSweepNotePrefix: prefix => { planner.notePrefix = prefix; }, plannerReset: () => planner.clear(),
    DBS_CELL, DBS_IMAGE_MIN_RANGE_M: IMAGE_MIN_RANGE_M, DBS_IMAGE_MAX_RANGE_M: IMAGE_MAX_RANGE_M});
  const server = api.server;
  const started = Promise.all([bridge.started, new Promise((resolve, reject) => { tcp.once('error', reject); tcp.listen(tcpPort, PROTOCOL.host, resolve); }),
    new Promise((resolve, reject) => { server.once('error', reject); server.listen(httpPort, PROTOCOL.host, resolve); })]).then(([actualScenePort]) => {
    // A caller asks for port 0 and then talks to whatever was actually bound. A zero/absent port here
    // would surface much later as an opaque client error (fetch rejects port 0 as a "bad port"), so
    // reject the startup instead of handing one out.
    const portOf = server => { const value = server.address()?.port; if (!Number.isInteger(value) || value <= 0) throw Error('Service failed to bind a real port'); return value; };
    const actualTcpPort = portOf(tcp), actualHttpPort = portOf(server);
    if (!Number.isInteger(actualScenePort) || actualScenePort <= 0) throw Error('Scene bridge failed to bind a real port');
    // A replay scene may carry its own processing block, which then supplies the base options;
    // the CLI's explicit scene model and focuser are passed as request parameters so they survive.
    if (scene) compute(scene, false, processingOptions({quality: processing.quality, sceneModel: processing.sceneModel, focuser: processing.focuser, footprint: scene.footprint || (sceneFootprint(scene) === 'detail' ? undefined : sceneFootprint(scene))}, scene.processing || processing));
    return {tcpPort: actualTcpPort, httpPort: actualHttpPort, scenePort: actualScenePort};
  });
  async function close() { closed = true; clearInterval(timer); socket?.destroy(); if (job) await job.terminate(); await Promise.all([bridge.close(), new Promise(r => tcp.close(r)), new Promise(r => server.close(r))]); }
  return {started, close, state, collector};
}
module.exports = {createService, GATE_WINDOW_MS, MOVER_POLL_MS, MOVER_RADIUS_M, MOVER_MAX, MOVER_MDV_MPS};

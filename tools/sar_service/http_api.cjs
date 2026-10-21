'use strict';
// HTTP surface of the SAR service: the page, the D3 state summary, the image endpoints and the
// commands that start or stop a capture.
//
// D3 (docs/conventions.md §8.5): /state carries summaries and a resultSeq, never an image matrix;
// matrices are fetched once per sequence number through /image/<seq> (mosaic entries) or /snapshot
// (the full-resolution current result). /mosaic/<seq> stays as a compatible alias of /image/<seq>
// because the endpoint was in the Gate 0 baseline; both name the same retained entry.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const {PROTOCOL} = require('../../src/shared/config.cjs');
const {processingOptions} = require('../../src/adapters/dcs/sar_adapter.cjs');

function createHttpApi(ctx) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'sar_viewer.html'));
  const server = http.createServer((req, res) => {
    const allowedHost = `${PROTOCOL.host}:${server.address().port}`;
    if (req.headers.host !== allowedHost && req.headers.host !== `localhost:${server.address().port}`) { res.writeHead(403); res.end(); return; }
    const send = (code, value) => { res.writeHead(code, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(value)); };
    if (req.method === 'GET' && req.url === '/') { res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}); res.end(html); return; }
    if (req.method === 'GET' && (req.url === '/state' || req.url.startsWith('/state?'))) { send(200, stateBody(req.url)); return; }
    if (req.method === 'GET' && (req.url.startsWith('/image/') || req.url.startsWith('/mosaic/'))) {
      const prefix = req.url.startsWith('/image/') ? '/image/' : '/mosaic/';
      const seq = Number(req.url.slice(prefix.length));
      const entry = ctx.mosaic.find(seq);
      entry ? send(200, {...ctx.summary(entry), db: Array.from(entry.db)}) : send(404, {error: 'Image not retained'});
      return;
    }
    if (req.method === 'GET' && req.url === '/reference') {
      const reference = referenceBody();
      reference ? send(200, reference) : send(409, {error: 'No complete raw input retained'});
      return;
    }
    if (req.method === 'GET' && req.url === '/scene') { ctx.getLastScene() ? send(200, {scene: ctx.getLastScene()}) : send(409, {error: 'No complete raw scene retained'}); return; }
    if (req.method === 'GET' && req.url === '/snapshot') {
      ctx.state.result ? send(200, {completed: ctx.state.completed, result: ctx.state.result,
        target: ctx.getDisplayedScene()?.target || null, scene: ctx.getDisplayedScene()?.terrain ? ctx.getDisplayedScene() : null}) : send(409, {error: 'No completed image retained'});
      return;
    }
    if (req.method === 'GET' && (req.url === '/designate/check' || req.url.startsWith('/designate/check?'))) { designate(req.url, send); return; }
    if (req.method === 'POST' && ['/capture', '/map', '/dbs', '/reprocess', '/continuous/start', '/continuous/stop'].includes(req.url)) {
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) { send(403, {error: 'Invalid origin'}); return; }
      let body = ''; req.on('data', b => { body += b; if (body.length > 1024) req.destroy(); });
      req.on('end', () => { try { command(req.url, JSON.parse(body), send); } catch (e) { send(409, {error: e.message}); } });
      return;
    }
    res.writeHead(404); res.end();
  });

  // /state: the D3 summary. Every image matrix is reachable by its own sequence number, so a 700 ms
  // poll only carries counts, flags and the newest metadata.
  function stateBody(url) {
    // ?since=<seq> turns the 700 ms poll into an incremental one: only summaries newer than the
    // client's last sequence number travel, and the matrices stay behind /image/<seq>.
    const since = url.includes('?') ? Number(new URL(url, 'http://127.0.0.1').searchParams.get('since')) : NaN;
    ctx.refreshMoverAges();
    const result = ctx.state.result, displayed = ctx.getDisplayedScene();
    // D3: the client pulls the image when resultSeq changes; the matrix never travels in a poll.
    const resultSeq = result ? ctx.mosaic.latestResultSeq() : null;
    return {
      mode: ctx.state.mode, phase: ctx.state.phase, error: ctx.state.error,
      resultSeq,
      result: result ? {source: result.source, width: result.width, size_m: result.size_m, metadata: resultMetadata(result.metadata)} : null,
      // The dB scale the matrix behind resultSeq is on, read from the retained entry (which resolves a
      // snapshot that predates the field) so the poll and the image cannot disagree.
      db_ref: resultSeq === null ? null : ctx.mosaic.find(resultSeq)?.db_ref ?? null,
      record: ctx.state.record, completed: ctx.state.completed, restoredDisplay: ctx.state.restoredDisplay, restoredInput: ctx.state.restoredInput,
      continuous: ctx.state.continuous, map: ctx.mapSession.summary(), dbs: ctx.dbsSession.summary(),
      movers: ctx.state.movers, moversNote: ctx.state.moversNote,
      connected: ctx.isReady(), status: ctx.collector.status, exportCapabilities: ctx.collector.capabilities || null,
      compat: ctx.state.compat, sceneCapabilities: ctx.bridge.capabilities,
      // The imaging window the service actually enforces (the Export's 1–50 km ground range and the
      // side-looking 20–160°). The page draws that layer from these numbers instead of keeping a
      // second copy; it is a named record, not a capability probe.
      imageWindow: {min_angle_deg: PROTOCOL.sar.image_window.min_angle_deg, max_angle_deg: PROTOCOL.sar.image_window.max_angle_deg,
        min_range_m: PROTOCOL.sar.capture.min_range_m, max_range_m: PROTOCOL.sar.capture.max_range_m},
      // The input raster behind the displayed image. Only its descriptor travels in the poll; the
      // heights/surfaces/objects are fetches of their own (D3): a 129x129 height grid alone is
      // several kilobytes, and the 700 ms poll must not carry it 1.4 times a second.
      reference: referenceSummary(),
      progress: ctx.collector.job?.progress, target: (result ? displayed : ctx.collector.job || ctx.getLastScene())?.target || null,
      captureTarget: ctx.collector.job?.target || null, canReprocess: !!ctx.getLastScene() && !ctx.busy() && !ctx.state.continuous.enabled,
      // A manual shot needs the terrain path and the beam free. During a MAP patrol the pending map job
      // is not a blocker — /capture preempts it — so the viewer's designate button stays lit; outside
      // that mode (including while a manual map shot runs) the original refusal stands.
      canCapture: ctx.state.mode === 'live' && ctx.terrainReady() && !ctx.job && !ctx.getEnriching() && !ctx.collector.job && (ctx.mapPatrol() || (!ctx.collector.map && !ctx.state.continuous.enabled)),
      // canDbs mirrors it for the DBS button: the patrol's own map job does not block (a DBS block preempts
      // it), but a SAR job does, and so does a DBS already in flight.
      canDbs: ctx.dbsSession.canDbs(),
      canStartContinuous: ctx.state.mode === 'live' && !ctx.job && !ctx.getEnriching() && !ctx.collector.job && !ctx.state.continuous.enabled,
      imaging: ctx.job ? {mode: ctx.job.mode, workers: ctx.job.workers} : null,
      ownship: ctx.ownship(), lastFailures: ctx.getFailures(),
      mosaic: ctx.mosaic.state({since})
    };
  }
  // The result's descriptor. The long prose fields of the metadata (the visibility/layover/material
  // sentences that explain the model) are a reference block, not poll data: they travel with the
  // matrix in /image/<seq> and /snapshot, where a client asks for them once per result. Everything the
  // page paints the frame from — waveform, grid, quality, focuser, the dB reference — stays here.
  const POLL_METADATA_OMIT = Object.freeze(['visibility', 'layover', 'material', 'model']);
  function resultMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object') return metadata;
    return Object.fromEntries(Object.entries(metadata).filter(([key]) => !POLL_METADATA_OMIT.includes(key)));
  }
  // The full raw input of the displayed image: the same scene /snapshot restores from, minus the
  // matrix that has its own endpoint. A client asks once per completed image, keyed by `completed`.
  function referenceBody() {
    const displayed = ctx.getDisplayedScene();
    if (!ctx.state.result || !displayed?.terrain) return null;
    return {completed: ctx.state.completed, source: displayed.source,
      center: displayed.center, bearing: displayed.bearing, size: displayed.size, n: displayed.n,
      heights: displayed.terrain.map(p => p[1]), surfaces: displayed.surfaces || null,
      objects: displayed.objects || [], scene_data: displayed.scene_data || null};
  }
  function referenceSummary() {
    const reference = referenceBody();
    if (!reference) return null;
    const {heights, surfaces, objects, ...descriptor} = reference;
    return {...descriptor, heights_len: heights.length,
      surfaces_len: surfaces ? surfaces.length : null, objects_len: objects.length};
  }
  function designate(url, send) {
    // The one authority on "can this point be imaged": the viewer asks with world coordinates and
    // renders the verdict, it never re-derives the window itself. Geometry is answered from the
    // newest pose even while the service is busy — that is exactly when the operator asks — and from
    // whichever source has one (see designatePose: the MAP patrol can be the only one).
    const query = new URL(url, 'http://127.0.0.1').searchParams;
    const point = key => { const value = query.get(key); return value === null || value.trim() === '' ? NaN : Number(value); };
    const x = point('x'), z = point('z');
    if (!Number.isFinite(x) || !Number.isFinite(z) || Math.abs(x) > 1e8 || Math.abs(z) > 1e8) { send(400, {error: 'Invalid designation point'}); return; }
    const pose = ctx.designatePose();
    pose ? send(200, ctx.designateCheck(pose, x, z)) : send(409, {error: 'No aircraft pose yet: no SAR trajectory or map pose has been received'});
  }
  function command(url, params, send) {
    let options = processingOptions(params, ctx.processing);
    if (url === '/continuous/stop') {
      ctx.state.continuous.enabled = false;
      ctx.state.continuous.note = ctx.job ? '已停止追加采集，当前计算完成后保留图像' : '已停止';
      ctx.clearEnriching(); ctx.bridge.cancel();
      if (ctx.collector.job) { ctx.collector.job = null; ctx.write('CANCEL\n'); }
      // A MAP session keeps its lattice and its rendered frames: only the loop stops. A DBS block has
      // no lattice worth keeping (a 512 m block is one shot) and ends with the reason.
      ctx.cancelMapJob({map: '已停止地图采集，保留已采集格', dbs: '已停止 DBS 放大（方块未完成）'});
      if (ctx.mapSession.active) { ctx.mapSession.active = false; ctx.mapSession.pendingProbe = false; ctx.state.map.note = '已停止地图采集，保留已采集格与拼接层图像'; }
      if (!ctx.job) ctx.state.phase = ctx.state.result ? '已停止，保留上次图像' : '已停止连续采集';
      send(200, {stopped: true}); return;
    }
    if (url === '/continuous/start') { startContinuous(params, options, send); return; }
    // A running loop owns the beam — and reprocessing shares the same display slots — so both are
    // refused, with two exceptions: during a MAP patrol a manual SAR designation is accepted and
    // preempts the coarse base map (the map job in flight is cancelled below; the lattice and the
    // frames drawn from it survive, and the patrol resumes by itself once the SAR job settles), and
    // a DBS point shot is accepted the same way, because it is the patrol's own MAP-family middle
    // rung. relative/sweep keep the refusal: their whole plan is the patch stream that would break.
    const patrol = ctx.mapPatrol();
    if (ctx.state.continuous.enabled && !(patrol && ['/capture', '/dbs'].includes(url))) throw Error('Stop continuous capture before manual capture or reprocessing');
    if (url === '/map') { startMap(params, send); return; }
    if (url === '/dbs') { startDbs(params, send); return; }
    if (url === '/reprocess') {
      if (!ctx.getLastScene() || ctx.job || ctx.getEnriching() || ctx.collector.job) throw Error('No completed capture, or processing is busy');
      const region = ctx.sceneFootprint(ctx.getLastScene()), selected = {...params, footprint: region};
      if (region === 'detail' && params.footprint === undefined) delete selected.footprint;
      ctx.compute(ctx.getLastScene(), false, processingOptions(selected, ctx.processing)); send(202, {reprocessed: true}); return;
    }
    if (patrol) {
      // A running patch capture or a running computation is the SAR job the operator is waiting
      // for: it is never preemptible. Only the patrol's own coarse map job gives way.
      if (ctx.job || ctx.getEnriching() || ctx.collector.job) throw Error('SAR imaging busy, wait for the current job to settle');
      // CANCEL ends the Export's cell stream; the cells it already delivered stay in the lattice,
      // so the patrol only re-asks for the missing rest when it resumes. The note is what the
      // operator sees while the patrol is paused, and the next collected job overwrites it.
      if (ctx.collector.map) ctx.cancelMapJob({map: 'SAR 指定抢占地图采集（已取消当前地图格任务），采集完成后自动恢复巡逻',
        dbs: 'SAR 指定抢占 DBS 放大（已取消当前 DBS 方块）'});
    }
    if (!ctx.available()) throw Error('DCS terrain unavailable, paused, or busy');
    send(202, {id: ctx.beginCapture(params, options)});
  }
  function startContinuous(params, options, send) {
    if (ctx.state.mode !== 'live' || ctx.job || ctx.getEnriching() || ctx.collector.job || ctx.state.continuous.enabled) throw Error('Continuous capture unavailable or busy');
    // mode 'sweep' aims at fixed world tiles inside the imaging window; 'map' rolls a coarse
    // real-beam base map window around the aircraft; 'relative' is the original side/range
    // patch glued to the aircraft.
    if (params.mode !== undefined && !['relative', 'sweep', 'map'].includes(params.mode)) throw Error('Invalid continuous capture mode');
    if (params.mode === 'map') {
      // The forward sector has no side to choose and no square span to set, so the old
      // side/angle/span parameters are accepted and ignored here; mapParams validates the
      // parameters the sector really has (range, azimuth, cell, beam, looks, stc, shadow).
      const mapCfg = ctx.mapParams(params);
      if (ctx.state.mode === 'live' && ctx.isReady() && !ctx.collector.capabilities?.map) throw Error('Update SAR Export for MAP collection');
      ctx.mapLattice(mapCfg.cell);
      ctx.mapSession.start({cfg: mapCfg, continuous: true});
      ctx.state.map.note = '等待地图采集';
      // side stays 1 in the shared continuous state: it is the SAR modes' field, and the viewer
      // reads the sector from map.window.sector / map.params instead of a side.
      Object.assign(ctx.state.continuous, {enabled: true, mode: 'map', side: 1, range: mapCfg.range, record: false, quality: 'map',
        footprint: 'map', sceneModel: 'classified', window: 'real-beam', focuser: 'real-beam', completed: 0, failures: 0, skipped: 0,
        captureSide: 1, nextSide: 1, sweepPlan: null, sweepIndex: 0, sweepAnchor: null, sweepPruned: 0, sweepDeferred: 0, note: '等待地图采集'});
      ctx.plannerReset();
      ctx.setContinuousOptions({window: 'hann', quality: 'standard'}); ctx.setNextCaptureAt(0); ctx.state.error = null;
      ctx.tryContinuous(); send(202, {started: true}); return;
    }
    // side 0 = alternate right/left each capture; ±1 keeps the original fixed side.
    if (![-1, 0, 1].includes(params.side) || !Number.isFinite(params.range) || params.range < PROTOCOL.sar.capture.min_range_m || params.range > PROTOCOL.sar.capture.max_range_m || (params.record !== undefined && typeof params.record !== 'boolean')) throw Error('Invalid continuous capture parameters');
    const sweepSize = params.mode === 'sweep' ? (params.sweepSize === undefined ? ctx.sweepDefaultSize : params.sweepSize) : null;
    if (params.mode === 'sweep' && !ctx.sweepSizes.includes(sweepSize)) throw Error('Invalid sweep tile size');
    const region = params.mode === 'sweep' ? ctx.sweepRegion(sweepSize) : (params.footprint || 'detail');
    ctx.footprint(region);
    if (region !== 'detail' && ctx.isReady() && ctx.collector.capabilities?.version !== PROTOCOL.versions.sar_caps) throw Error('Update SAR Export for larger captures');
    // The window decides the footprint, so the sweep's per-tile options are rebuilt for it; the
    // requested quality is passed explicitly so the profile's grid rule applies to the tile.
    const quality = params.quality ?? ctx.processing.quality ?? 'standard';
    // A fresh start begins with a fresh planner: the retry list, the window key and the note prefix of
    // the previous run must not carry over. The reset comes before the sweep block so the fallback
    // notice set below is the one the first capture actually reports.
    ctx.plannerReset();
    if (params.mode === 'sweep') {
      const requested = params.focuser ?? ctx.processing.focuser ?? 'backprojection';
      // The PFA refuses patches whose k-grid would exceed 2048², and the airport-overview tile is past
      // that limit: rather than failing every tile, such a sweep falls back to the backprojection
      // focuser and says so (the image metadata records the focuser actually used). The decision is
      // made on the footprint the tile collects, which is what the limit is actually about.
      const focuser = requested === 'pfa' && ctx.footprint(region).size > ctx.maxPfaTile ? 'backprojection' : requested;
      options = processingOptions({...params, footprint: region, quality, focuser}, ctx.processing);
      if (focuser !== requested) ctx.setSweepNotePrefix('2048 m 瓦片超出 PFA 的 k 网格上限，已改用反投影');
    }
    Object.assign(ctx.state.continuous, {enabled: true, mode: params.mode || 'relative', side: params.side, range: params.range, record: params.record ?? false, quality,
      footprint: region, sceneModel: options.sceneModel || 'uniform', window: options.window, focuser: options.focuser || 'backprojection', completed: 0, failures: 0, skipped: 0,
      captureSide: params.side === 0 ? 1 : params.side, nextSide: 1, sweepPlan: null, sweepIndex: 0, sweepAnchor: null, sweepPruned: 0, sweepDeferred: 0,
      sweepSize: params.mode === 'sweep' ? sweepSize : ctx.sweepDefaultSize, note: '等待采集'});
    ctx.setContinuousOptions(options); ctx.setNextCaptureAt(0); ctx.state.error = null;
    ctx.tryContinuous(); send(202, {started: true});
  }
  function startMap(params, send) {
    if (ctx.mapSession.active) throw Error('Map session already running');
    const blocked = ctx.mapSession.blocked(); if (blocked) throw Error(blocked);
    const cfg = ctx.mapParams(params);
    ctx.mapLattice(cfg.cell);
    ctx.mapSession.start({cfg, continuous: false});
    ctx.state.map.note = '准备地图采集';
    ctx.state.phase = '准备地图采集'; ctx.state.error = null;
    ctx.mapSession.tryCapture();
    send(202, {map: true, cell_m: cfg.cell, grid: cfg.cells, range_m: cfg.range, azimuth_deg: cfg.azimuth, beam_deg: cfg.beam, looks: cfg.looks});
  }
  // DBS: the middle rung, a one-shot small block on the fine lattice. Handled before the patrol block
  // because it preempts the patrol itself, with its own note; the request validation is answered with
  // 400 (the request is wrong) instead of the 409 the service state failures use, so the page can tell
  // "fix the request" from "wait a moment".
  function startDbs(params, send) {
    let request;
    try { request = ctx.dbsRequest(params); } catch (e) { send(400, {error: e.message}); return; }
    const blocked = ctx.dbsSession.blocked();
    if (blocked) throw Error(blocked);
    const pose = ctx.designatePose();
    if (!pose) throw Error('No aircraft pose yet: no SAR trajectory or map pose has been received');
    const range = Math.hypot(request.point[0] - pose.pos[0], request.point[1] - pose.pos[2]);
    if (range < ctx.DBS_IMAGE_MIN_RANGE_M || range > ctx.DBS_IMAGE_MAX_RANGE_M)
      throw Error(`目标地距 ${(range / 1000).toFixed(2)} km 不在 ${ctx.DBS_IMAGE_MIN_RANGE_M / 1000}–${ctx.DBS_IMAGE_MAX_RANGE_M / 1000} km 内，Export 取不到该处地形`);
    // The patrol gives way: its lattice and the frames already drawn survive, only its pending cell
    // job is cancelled, and it re-plans the missing rest when it resumes on its own.
    ctx.cancelMapJob({map: 'DBS 放大抢占地图采集（已取消当前地图格任务），完成后自动恢复巡逻'});
    ctx.dbsSession.start(request, pose);
    send(202, {dbs: true, x: request.point[0], z: request.point[1], span_m: request.span, cell_m: ctx.DBS_CELL, grid: request.cells, sharpen: request.sharpen,
      velocity: pose.velocity ? pose.velocity.slice() : null});
  }
  return {server, stateBody};
}

module.exports = {createHttpApi};

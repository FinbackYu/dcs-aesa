'use strict';
// Wire collector of the SAR service: one class owns the Export's line protocol for
// both job families.
//
//   * a patch job (CAPTURE / CAPTURE_GEO / CAPTURE_WORLD) answers BEGIN, HEIGHT,
//     SURFACE, POSE, END and returns the finished scene;
//   * a map job (CAPTURE_MAP[_AT]) answers MAPGRID, MAPBEGIN, MAPHEIGHT, MAPSURFACE,
//     MAPPOSE, MAPEND and returns the finished rectangle.
//
// Everything here is protocol structure and sequence checking. Turning a DCS
// surface token into a core class is the adapter's job, and validating the finished
// scene is the core's; this module only decides whether a line is well formed.
const CONFIG = require('../../src/shared/config.cjs');
const {PROTOCOL} = CONFIG;
const PROTOCOL_SAR = PROTOCOL.sar, PROTOCOL_MAP = PROTOCOL.sar.map;
const {footprint, geometry, surfaceName, isLegacySurfaceToken} = require('../../src/adapters/dcs/sar_adapter.cjs');
const {pickSurface} = require('../../src/sar_core/materials.cjs');
const {validate} = require('../../src/sar_core/geometry.cjs');

// A MAPSURFACE class field is capped at 96 characters on both ends: the Export truncates a probe
// union at the first class that would not fit (src/export/aesa_sar_export.lua MAPSURFACE_MAX), and
// this parser rejects anything longer. The 16-class worst case is therefore never sent whole; its
// prefix still contains Building, the class the service picks. Both numbers come from the spec so the
// two ends cannot drift apart.
//
// Two vocabularies coexist here, in any mix, because an Export may be older or newer than this
// service: the legacy five-class API (the digit 1-5, or land/sea/water/road/runway) and the native
// probe's 16-class mask (capitalised names joined with '+', because a comma is the field separator).
// Capitalisation keeps 'sea' (the old word for water) and 'Sea' (the engine class) apart. Structural
// garbage is a protocol error; an unknown *name* only degrades that cell to 'unknown' (a probe that
// learns a new class must not fail a whole map job), and a union collapses to one class by radar
// significance, so a cell that is both town and runway is drawn as the town it belongs to.
function surfaceClass(token) {
  if (typeof token !== 'string' || token === '' || token.length > PROTOCOL_MAP.surface_token_max_chars) throw Error('Invalid MAPSURFACE');
  const parts = token.split('+');
  if (parts.length > PROTOCOL_MAP.surface_parts_max) throw Error('Invalid MAPSURFACE');
  const names = [];
  for (const raw of parts) {
    const text = raw.trim();
    if (!text) throw Error('Invalid MAPSURFACE');
    if (isLegacySurfaceToken(text)) { names.push(surfaceName(text)); continue; }
    const key = text.toLowerCase();
    if (!/^[a-z_]{1,24}$/.test(key)) throw Error('Invalid MAPSURFACE');
    names.push(key);
  }
  // An unknown name is not a protocol error: a probe that learns a class this service does not know
  // must degrade that one cell, not fail the whole map job.
  return pickSurface(names) || 'unknown';
}

class Collector {
  // fineSurfaces: has this connection ever carried a fine (16-class probe) surface name? Reset when a new
  // Export connects, so a session that falls back to an old Export does not keep claiming fine classes.
  constructor() { this.job = null; this.map = null; this.status = null; this.nextId = 1; this.fineSurfaces = false; this.compat = null; }
  start(side, range, region = 'detail') {
    if (this.job) throw Error('busy');
    if (![-1, 1].includes(side) || !Number.isFinite(range) || range < PROTOCOL_SAR.capture.min_range_m || range > PROTOCOL_SAR.capture.max_range_m) throw Error('invalid capture parameters');
    const p = footprint(region); this.job = {id: this.nextId++, started: Date.now(), terrain: [], trajectory: [], source: 'dcs', progress: '等待地形', footprint: region};
    return `CAPTURE,${this.job.id},${side},${range}${region === 'detail' ? '' : `,${p.size},${p.n}`}\n`;
  }
  startGeo(latitude, longitude, region = 'detail') {
    if (this.job) throw Error('busy');
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) throw Error('Invalid geographic coordinates');
    const p = footprint(region); this.job = {id: this.nextId++, started: Date.now(), terrain: [], trajectory: [], source: 'dcs', progress: '等待坐标转换与地形', target_request: {latitude, longitude}, footprint: region};
    return `CAPTURE_GEO,${this.job.id},${latitude},${longitude}${region === 'detail' ? '' : `,${p.size},${p.n}`}\n`;
  }
  startWorld(x, z, region = 'detail') {
    if (!Number.isFinite(x) || !Number.isFinite(z) || Math.abs(x) > 1e8 || Math.abs(z) > 1e8) throw Error('Invalid world point');
    this.start(1, 20000, region);
    const p = footprint(region); this.job.world_request = {x, z};
    return `CAPTURE_WORLD,${this.job.id},${x},${z}${region === 'detail' ? '' : `,${p.size},${p.n}`}\n`;
  }
  // A MAP job is a coarse terrain rectangle: the server names the lattice origin and the Export
  // answers one line per cell, so a rolling window only asks for the cells that entered it. The job
  // carries its own poses because the Export status has no position or heading, which also lets MAP
  // mode bootstrap without any prior SAR capture (`relative` resolves the origin to the ownship).
  // `dbs:true` marks a Doppler-sharpening block: the same protocol on a fine lattice, but its cells go
  // to the DBS cache instead of the patrol's, so the completion has to be able to tell them apart.
  startMap({x0, z0, cols, rows, step, relative = false, dbs = false} = {}) {
    if (this.map) throw Error('busy');
    if (!Number.isFinite(x0) || !Number.isFinite(z0) || Math.abs(x0) > 1e8 || Math.abs(z0) > 1e8) throw Error('Invalid map origin');
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > PROTOCOL_MAP.rows_max || rows > PROTOCOL_MAP.rows_max || cols * rows > PROTOCOL_MAP.cells_max) throw Error('Invalid map rectangle');
    if (!Number.isInteger(step) || step < PROTOCOL_MAP.step_min_m || step > PROTOCOL_MAP.step_max_m) throw Error('Invalid map cell size');
    const label = dbs ? 'DBS' : '地图';
    this.map = {
      id: this.nextId++, started: Date.now(), dbs: !!dbs, request: {x0, z0, cols, rows, step, relative, dbs: !!dbs}, origin: null, cols, rows, step,
      grid_layout: null, cells: new Map(), surfaces: new Map(), poses: [], sequence: 0, poseSequence: 0, progress: `${label} ${cols}×${rows} 等待地形`
    };
    return `CAPTURE_MAP${relative ? '_AT' : ''},${this.map.id},${x0},${z0},${cols},${rows},${step}\n`;
  }
  accept(line) {
    if (line.length > PROTOCOL.limits.sar_server_line_max_chars) throw Error('Protocol line too long');
    const a = line.split(','), num = i => Number(a[i]);
    if (a[0].startsWith('MAP')) return this._map(a);
    // A MAP job's FAIL carries the map id, which the SAR job filter below would drop.
    if (a[0] === 'FAIL' && this.map && num(1) === this.map.id) return this._map(a);
    if (a[0] === 'CAPS') {
      if (!PROTOCOL_SAR.rows.CAPS.fields.includes(a.length) || a[1] !== String(PROTOCOL.versions.sar_caps) || !['terrain.GetSurfaceType', 'unavailable'].includes(a[2]) || (a.length === 4 && a[3] !== 'map')) throw Error('Invalid Export capabilities');
      this.capabilities = {version: PROTOCOL.versions.sar_caps, surface: a[2], map: a.length === 4};
      return;
    }
    // Compatibility handshake: COMPAT,<profile_id>,<matrix_hash>. It is a summary only — the full
    // capability matrix stays in the probe log, never on /state. "unknown" is the probe's explicit
    // fail-closed value, so it is preserved instead of being replaced by a fabricated hash.
    if (a[0] === 'COMPAT') {
      if (a.length !== PROTOCOL_SAR.rows.COMPAT.fields || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(a[1]) || !/^(?:[0-9A-Fa-f]{8}|unknown)$/.test(a[2])) throw Error('Invalid compatibility handshake');
      this.compat = {profile_id: a[1], matrix_hash: a[2], at: Date.now()};
      return;
    }
    if (a[0] === 'STATUS') {
      if (!PROTOCOL_SAR.rows.STATUS.fields.includes(a.length) || !Number.isFinite(num(1)) || !['terrain.GetHeight', 'unavailable'].includes(a[2]) || (a.length === 7 && !['0', '1'].includes(a[6]))) throw Error('Invalid status');
      this.status = {t: num(1), provider: a[2], terrain_under_ownship: a[3], LoGetAltitude_under_ownship: a[4], ASL_minus_AGL: a[5], geo_available: a[6] === '1', received: Date.now()};
      return;
    }
    const j = this.job;
    if (!j || num(1) !== j.id) return;
    if (a[0] === 'FAIL') throw Error(a.slice(2).join(',') || 'acquisition failed');
    if (a[0] === 'TARGET') {
      if (j.target || a.length !== PROTOCOL_SAR.rows.TARGET.fields || !a.slice(2).every(v => v !== '' && Number.isFinite(Number(v))) || Math.abs(num(2)) > 90 || Math.abs(num(3)) > 180 || num(4) < PROTOCOL_SAR.capture.min_range_m || num(4) > PROTOCOL_SAR.capture.max_range_m || Math.abs(num(5)) > 180) throw Error('Invalid TARGET');
      if (j.target_request && (Math.abs(j.target_request.latitude - num(2)) > 1e-8 || Math.abs(j.target_request.longitude - num(3)) > 1e-8)) throw Error('Target coordinates differ from request');
      j.target = {latitude: num(2), longitude: num(3), ground_range_m: num(4), relative_track_deg: num(5)};
      return;
    }
    if (a[0] === 'BEGIN') {
      if (j.n || a.length !== PROTOCOL_SAR.rows.BEGIN.fields || !a.slice(2).every(v => v !== '' && Number.isFinite(Number(v))) || !geometry(num(5), num(6)) || num(5) !== footprint(j.footprint).size) throw Error('Invalid BEGIN');
      if (j.world_request && (Math.abs(num(2) - j.world_request.x) > .01 || Math.abs(num(3) - j.world_request.z) > .01)) throw Error('World target differs from request');
      j.center = [num(2), 0, num(3)]; j.bearing = num(4); j.size = num(5); j.n = num(6);
    }
    return this._data(a, j);
  }
  // MAP protocol: row-major cells, an echoed lattice position for every height, optional surface
  // classes from the same Export surface API the patch captures use, and periodic ownship poses.
  _map(a) {
    const j = this.map, num = i => Number(a[i]);
    if (!j || num(1) !== j.id) return;
    if (a[0] === 'FAIL') throw Error(a[2] || 'map acquisition failed');
    // Additive grid marker (not an eighth MAPBEGIN field): the new Export names the layout it used,
    // an older one omits the line and the protocol default below is the same canonical grid. An
    // unknown layout is refused instead of being guessed; a second marker is a protocol error.
    if (a[0] === 'MAPGRID') {
      if (a.length !== PROTOCOL_SAR.rows.MAPGRID.fields || a[2] !== CONFIG.sar.map.engine_defaults.grid_layout || j.grid_layout) throw Error('Invalid MAPGRID');
      j.grid_layout = a[2];
      return;
    }
    const numbers = values => values.every(v => v !== '' && Number.isFinite(Number(v)));
    if (a[0] === 'MAPBEGIN') {
      if (a.length !== PROTOCOL_SAR.rows.MAPBEGIN.fields || !numbers(a.slice(2)) || num(4) !== j.cols || num(5) !== j.rows || num(6) !== j.step
        || Math.abs(num(2)) > 1e8 || Math.abs(num(3)) > 1e8) throw Error('Invalid MAPBEGIN');
      if (!j.request.relative && (Math.abs(num(2) - j.request.x0) > .5 || Math.abs(num(3) - j.request.z0) > .5)) throw Error('Map origin differs from request');
      j.origin = [num(2), num(3)];
      return;
    }
    if (a[0] === 'MAPHEIGHT') {
      if (a.length !== PROTOCOL_SAR.rows.MAPHEIGHT.fields || !numbers(a.slice(2)) || j.cells.size >= j.cols * j.rows) throw Error('Invalid MAPHEIGHT');
      const col = num(2), row = num(3);
      if (!Number.isInteger(col) || !Number.isInteger(row) || col < 0 || row < 0 || col >= j.cols || row >= j.rows || row * j.cols + col !== j.sequence) throw Error('Invalid MAPHEIGHT sequence');
      if (!j.origin || Math.abs(num(4) - (j.origin[0] + col * j.step)) > .01 || Math.abs(num(6) - (j.origin[1] + row * j.step)) > .01) throw Error('Map cell position differs from the lattice');
      j.cells.set(j.sequence, {col, row, x: num(4), h: num(5), z: num(6)}); j.sequence++;
      j.progress = `${j.dbs ? 'DBS' : '地图'} ${j.cells.size}/${j.cols * j.rows}`;
      return;
    }
    if (a[0] === 'MAPSURFACE') {
      // The last field is the cell's ground class. Both vocabularies are accepted, because an Export may
      // be older (five classes: the digit 1-5 or land/sea/water/road/runway) or newer (the engine's
      // 16-class mask joined with '+', e.g. "Land+Runway+Road" — a comma would break this protocol).
      // A union picks one class by radar significance: the map shows the installation, not land use.
      if (a.length !== PROTOCOL_SAR.rows.MAPSURFACE.fields) throw Error('Invalid MAPSURFACE');
      const col = num(2), row = num(3), index = row * j.cols + col;
      if (!Number.isInteger(col) || !Number.isInteger(row) || col < 0 || row < 0 || col >= j.cols || row >= j.rows || index >= j.sequence) throw Error('Invalid MAPSURFACE sequence');
      // A capital letter or a '+' union only comes from the probe's vocabulary (the legacy words are
      // lowercase, the digits are numbers), so this is the one place that records "the engine mask is in use".
      if (/[A-Z+]/.test(a[4])) this.fineSurfaces = true;
      j.surfaces.set(index, surfaceClass(a[4]));
      return;
    }
    if (a[0] === 'MAPPOSE') {
      if (a.length !== PROTOCOL_SAR.rows.MAPPOSE.fields || !numbers(a.slice(3)) || !Number.isInteger(num(2))) throw Error('Invalid MAPPOSE');
      // The first frame of a job sets the numbering baseline: the Export that is deployed in DCS starts
      // this stream at 1 (while the SAR POSE stream starts at 0), and a service that insisted on 0
      // refused every real map job at its very first pose. Any integer is taken as the baseline; from
      // the second frame on the step is strictly +1, so a dropped or reordered frame still fails.
      if (!j.poses.length) j.poseSequence = num(2);
      if (num(2) !== j.poseSequence) throw Error('Invalid MAPPOSE');
      const t = num(3);
      if (j.poses.length && t < j.poses.at(-1).t) throw Error('Invalid MAPPOSE sequence');
      j.poses.push({t, pos: [num(4), num(5), num(6)], vel: [num(7), 0, num(8)]}); j.poseSequence++;
      while (j.poses.length > 512) j.poses.shift();
      j.progress = `${j.dbs ? 'DBS' : '地图'} ${j.cells.size}/${j.cols * j.rows}（${j.poses.length} 帧位姿）`;
      return;
    }
    if (a[0] === 'MAPEND') {
      if (a.length !== PROTOCOL_SAR.rows.MAPEND.fields || !numbers(a.slice(2)) || num(2) !== j.cols * j.rows || j.cells.size !== j.cols * j.rows) throw Error('Incomplete MAPEND');
      this.map = null;
      return {
        kind: 'map', id: j.id, dbs: !!j.dbs, cols: j.cols, rows: j.rows, step: j.step, origin: j.origin,
        grid_layout: j.grid_layout || CONFIG.sar.map.engine_defaults.grid_layout, started: j.started, completed: Date.now(),
        cells: [...j.cells.values()], surfaces: [...j.surfaces].map(([index, name]) => ({index, name})), poses: j.poses
      };
    }
  }
  _data(a, j) {
    const num = i => Number(a[i]);
    if (a[0] === 'HEIGHT') {
      if (!j.n || a.length !== PROTOCOL_SAR.rows.HEIGHT.fields || !a.slice(2).every(v => v !== '' && Number.isFinite(Number(v))) || num(2) !== j.terrain.length || j.terrain.length >= j.n ** 2) throw Error('Missing or invalid terrain sequence');
      j.terrain.push(a.slice(3).map(Number)); j.progress = `地形 ${j.terrain.length}/${j.n ** 2}`;
    } else if (a[0] === 'SURFACE') {
      j.surfaces ??= [];
      if (!j.n || a.length !== PROTOCOL_SAR.rows.SURFACE.fields || a[2] === '' || !['1', '2', '3', '4', '5', 'land', 'sea', 'water', 'road', 'runway', 'unknown'].includes(a[3]) || num(2) !== j.surfaces.length || j.surfaces.length >= j.n ** 2) throw Error('Invalid Export surface sequence');
      j.surfaces.push(surfaceName(a[3])); j.surface_provider = 'terrain.GetSurfaceType';
    } else if (a[0] === 'POSE') {
      // The wire format is POSE,id,seq,t,x,y,z (7 fields, see src/export/aesa_sar_export.lua).
      if (j.terrain.length !== j.n ** 2 || a.length !== 7 || !a.slice(2).every(v => v !== '' && Number.isFinite(Number(v))) || num(2) !== j.trajectory.length || j.trajectory.length >= CONFIG.sar.geometry.trajectory_max_frames) throw Error('Missing or invalid pose sequence');
      j.trajectory.push({t: num(3), pos: a.slice(4).map(Number)}); j.progress = `轨迹 ${j.trajectory.length} 帧`;
    } else if (a[0] === 'END') {
      if (j.target_request && !j.target) throw Error('Geographic capture missing confirmed TARGET');
      // Export evaluates completion every frame; a pose at pose_rate_hz need not fall on that frame.
      const lag = num(3) - j.trajectory.at(-1)?.t;
      if (a.length !== PROTOCOL_SAR.rows.END.fields || num(2) !== j.trajectory.length || !Number.isFinite(lag) || lag < 0 || lag > 1 / PROTOCOL_SAR.pose_rate_hz + 1e-6) throw Error('Incomplete END');
      j.center[1] = j.terrain[Math.floor(j.n ** 2 / 2)][1];
      validate(j); this.job = null; return j;
    }
  }
}

module.exports = {Collector, surfaceClass, isLegacySurfaceToken};

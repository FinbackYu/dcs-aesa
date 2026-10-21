'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { findLua: findDcsLua } = require('../scripts/build_common.cjs');

const ROOT = path.resolve(__dirname, '..');
const WORKSPACE = path.resolve(ROOT, '..');
const generator = require(path.join(ROOT, 'scripts', 'gen_config.cjs'));

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function readJson(relative) {
  return JSON.parse(read(relative));
}

const rawSpecs = Object.fromEntries(generator.SPEC_FILES.map(name => [name, readJson(`spec/${name}`)]));
const resolved = generator.validateSpecs(rawSpecs).resolved;
const spec = {
  physics: resolved['physics.json'],
  radar: resolved['radar.json'],
  sar: resolved['sar.json'],
  protocol: resolved['protocol.json'],
  deployment: resolved['deployment.json'],
  display: resolved['display.json']
};

// Old key names are read from spec/radar.json's renames map, not copied into this test.
const renames = spec.radar.renames;
function oldNameFor(newPath) {
  const entry = Object.entries(renames).find(([, value]) => value === newPath);
  if (!entry) throw new Error(`spec/radar.json renames has no entry for ${newPath}`);
  return entry[0].split('.').pop().replace(/\[\]$/, '');
}
const removedTick = Object.entries(renames).find(([, value]) => value === null)[0].split('.').pop();
const old = {
  lambda: oldNameFor('radar.lambda_m'),
  ptxAvg: oldNameFor('radar.ptx_avg_w'),
  prf: oldNameFor('radar.prf[].prf_hz'),
  notch: oldNameFor('radar.prf[].notch_half_mps'),
  searchIdx: oldNameFor('prf_selection.search (names)'),
  farIdx: oldNameFor('prf_selection.track_far (names)'),
  nearIdx: oldNameFor('prf_selection.track_near (names)'),
  sttIdx: oldNameFor('prf_selection.stt (names)'),
  nearKm: oldNameFor('scheduler.revisit.near_range_m'),
  gateVel: oldNameFor('tracker.gate_vel_margin_mps'),
  velFloor: oldNameFor('tracker.vel_floor_mps'),
  gateAccel: oldNameFor('tracker.gate_accel_margin_mps'),
  velAccel: oldNameFor('tracker.vel_accel_max_mps2'),
  slowMover: oldNameFor('tracker.slow_mover_mps'),
  tick: removedTick
};

function findLua() {
  const candidates = [
    process.env.AESA_LUA,
    findDcsLua(),
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

function findGcc() {
  const candidates = [
    process.env.AESA_GCC,
    path.join(ROOT, '.tools', 'mingw-root', 'mingw64', 'bin', 'gcc.exe'),
    path.join(WORKSPACE, '.tools', 'mingw-root', 'mingw64', 'bin', 'gcc.exe'),
    'C:/msys64/mingw64/bin/gcc.exe'
  ].filter(Boolean);
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (found) return found;
  const probe = spawnSync('gcc', ['--version'], { encoding: 'utf8' });
  return probe.status === 0 ? 'gcc' : null;
}

function runLua(lua, script) {
  const result = spawnSync(lua, ['-e', script], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, `Lua failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result.stdout.trim();
}

function nearlyEqual(actual, expected, label, epsilon = 1e-12) {
  const scale = Math.max(1, Math.abs(actual), Math.abs(expected));
  assert.ok(Math.abs(actual - expected) <= epsilon * scale, `${label}: ${actual} != ${expected}`);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseDefineMap(header) {  const macros = new Map();
  for (const line of header.split(/\r?\n/)) {
    const match = /^#define\s+(AESA_[A-Z0-9_]+)\s+(.+?)(?:\s*\/\*.*)?$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    else if (/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)) value = Number(value);
    macros.set(match[1], value);
  }
  return macros;
}

test('generator --check is clean and deterministic', () => {
  const check = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'gen_config.cjs'), '--check'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.match(check.stdout, new RegExp(`OK: ${generator.generateAll().outputList.length} generated files match spec`));
  const first = generator.generateAll();
  const second = generator.generateAll();
  assert.deepEqual(first.outputs, second.outputs);
  assert.equal(first.inputSha, generator.inputHash(rawSpecs));
});

test('generated files carry DO NOT EDIT, generator and input hash', () => {
  const expectedHash = generator.inputHash(rawSpecs);
  for (const relative of [generator.OUTPUTS[0], generator.OUTPUTS[1], generator.OUTPUTS[2], generator.OUTPUTS[3]]) {
    const text = read(relative);
    assert.match(text, /DO NOT EDIT/, relative);
    assert.match(text, /scripts\/gen_config\.cjs/, relative);
    assert.match(text, new RegExp(`input-sha256[:=]\\s*${expectedHash}`), relative);
  }
  const fixture = readJson('tests/fixtures/config.json');
  assert.equal(fixture.DO_NOT_EDIT, true);
  assert.equal(fixture.generator, 'scripts/gen_config.cjs');
  assert.equal(fixture.input_sha256, expectedHash);
  const docs = read('docs/config-reference.md');
  assert.match(docs, new RegExp(expectedHash));
  assert.match(docs, /本文件由生成器从/);
});

test('generated JS exports spec-derived constants and is frozen', () => {
  const config = require(path.join(ROOT, 'src', 'shared', 'config.cjs'));
  nearlyEqual(config.C_MPS, spec.physics.constants.c_mps, 'C_MPS');
  nearlyEqual(config.LAMBDA_M, spec.radar.radar.lambda_m, 'LAMBDA_M');
  assert.deepEqual(config.SAR_PROFILES, spec.sar.profiles);
  assert.deepEqual(config.SAR_FOOTPRINTS, spec.sar.footprints);
  assert.deepEqual(config.SURFACE_CLASSES, spec.sar.surface_classes);
  assert.deepEqual(config.SURFACE_PRIORITY, spec.sar.surface_priority);
  assert.deepEqual(config.SAR_MATERIALS, spec.sar.materials);
  assert.deepEqual(config.SAR_MAP_SERVICE_DEFAULTS, spec.sar.map.service_defaults);
  assert.deepEqual(config.MAP_ENGINE_DEFAULTS, spec.sar.map.engine_defaults);
  assert.deepEqual(config.PROTOCOL.ports, spec.protocol.ports);
  assert.deepEqual(config.PROTOCOL.mosaic.limit, spec.display.mosaic.limit);
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.SAR_PROFILES));
  assert.ok(Object.isFrozen(config.PROTOCOL));
});

test('generated Lua loads under Lua 5.1 and validates', () => {
  const lua = findLua();
  if (!lua) throw new Error('Lua 5.1 (luae.exe) not found; Gate 2 requires it for loadfile checks');
  const output = runLua(lua, `
    assert(loadfile('src/shared/config.lua'))
    assert(loadfile('src/shared/protocol.lua'))
    local c = dofile('src/shared/config.lua')
    local p = dofile('src/shared/protocol.lua')
    local v = dofile('src/shared/config_validate.lua')
    assert(v.validate(c))
    local bad = { radar = { hpbw_el_deg = 3 }, scheduler = { search = { el_bars_deg = { 0, 4 } } } }
    local ok, err = pcall(v.validate, bad)
    assert(not ok and tostring(err):match('blind band'))
    print(string.format('%.17g|%.17g|%s|%d|%d|%.17g|%d|%s',
      c.physics.c_mps, c.radar.lambda_m, c.scheduler.prf_selection.search[1],
      p.ports.aa_export, c.display.mosaic.limit, c.display.db.step, c.display.db.no_data,
      c.deployment.saved_games.scripts_root))
  `);
  const [c, lambda, prf, aaPort, mosaic, dbStep, noData, scripts] = output.split('|');
  nearlyEqual(Number(c), spec.physics.constants.c_mps, 'Lua C');
  nearlyEqual(Number(lambda), spec.radar.radar.lambda_m, 'Lua lambda');
  assert.equal(prf, spec.radar.prf_selection.search[0]);
  assert.equal(Number(aaPort), spec.protocol.ports.aa_export);
  assert.equal(Number(mosaic), spec.display.mosaic.limit);
  nearlyEqual(Number(dbStep), spec.display.db.step, 'Lua db step');
  assert.equal(Number(noData), spec.display.db.no_data);
  assert.equal(scripts, spec.deployment.saved_games.scripts_root);
});

test('generated C header is structurally valid and compiles when gcc is available', () => {
  const header = read('src/native/generated/config.h');
  assert.match(header, /#ifndef AESA_GENERATED_CONFIG_H/);
  assert.match(header, /#define AESA_GENERATED_CONFIG_H/);
  assert.match(header, /#endif/);
  const macros = parseDefineMap(header);
  nearlyEqual(macros.get('AESA_C_MPS'), spec.physics.constants.c_mps, 'AESA_C_MPS');
  nearlyEqual(macros.get('AESA_BOLTZMANN_J_PER_K'), spec.physics.constants.boltzmann_j_per_k, 'AESA_BOLTZMANN');
  nearlyEqual(macros.get('AESA_T0_K'), spec.physics.constants.t0_k, 'AESA_T0');
  nearlyEqual(macros.get('AESA_EARTH_RADIUS_M'), spec.physics.constants.earth_radius_m, 'AESA_EARTH_RADIUS');
  for (const [name, port] of Object.entries(spec.protocol.ports)) {
    assert.equal(macros.get(`AESA_PORT_${name.toUpperCase()}`), port, name);
  }
  assert.equal(macros.get('AESA_SAR_COMMAND_MAX_CHARS'), spec.protocol.limits.sar_command_max_chars);
  assert.equal(macros.get('AESA_SAR_SERVER_LINE_MAX_CHARS'), spec.protocol.limits.sar_server_line_max_chars);
  assert.equal(macros.get('AESA_MAP_CELLS_MAX'), spec.protocol.sar.map.cells_max);
  assert.equal(macros.get('AESA_MAP_ROWS_MAX'), spec.protocol.sar.map.rows_max);
  assert.equal(macros.get('AESA_SAR_RANGE_MIN_M'), spec.protocol.sar.capture.min_range_m);
  assert.equal(macros.get('AESA_SAR_RANGE_MAX_M'), spec.protocol.sar.capture.max_range_m);
  assert.equal(macros.get('AESA_SAR_SIDE_MIN_DEG'), spec.protocol.sar.image_window.min_angle_deg);
  assert.equal(macros.get('AESA_SAR_SIDE_MAX_DEG'), spec.protocol.sar.image_window.max_angle_deg);

  const gcc = findGcc();
  if (!gcc) throw new Error('gcc not found; Gate 2 requires a C compiler for config.h syntax check');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aesa-gate2-'));
  const source = path.join(temp, 'config_check.c');
  fs.writeFileSync(source, [
    `#include "${path.join(ROOT, 'src', 'native', 'generated', 'config.h').replace(/\\/g, '/')}"`,
    'int main(void) {',
    '  return (int)(AESA_MAP_CELLS_MAX + AESA_MAP_ROWS_MAX + AESA_SAR_RANGE_MAX_M + AESA_PORT_SAR_SCENE);',
    '}',
    ''
  ].join('\n'));
  const env = { ...process.env };
  if (gcc !== 'gcc') env.PATH = `${path.dirname(gcc)}${path.delimiter}${env.PATH || ''}`;
  const compile = spawnSync(gcc, ['-fsyntax-only', '-I', ROOT, source], { cwd: ROOT, encoding: 'utf8', env });
  assert.equal(compile.status, 0, compile.stdout + compile.stderr);
});

test('generated shared radar config matches spec and old keys are removed', () => {
  const lua = findLua();
  if (!lua) throw new Error('Lua 5.1 (luae.exe) not found; Gate 2 requires it for config comparison');
  const output = runLua(lua, `
    local c = dofile('src/shared/config.lua')
    local function show(name, v)
      if type(v) == 'boolean' then print(name .. '\\t' .. tostring(v))
      elseif type(v) == 'number' then print(name .. '\\t' .. string.format('%.17g', v))
      else print(name .. '\\t' .. tostring(v)) end
    end
    show('lambda', c.radar.lambda_m)
    show('ptx_avg', c.radar.ptx_avg_w)
    show('ptx_peak_w', c.radar.ptx_peak_w)
    show('gain0_db', c.radar.gain0_db)
    show('nf_db', c.radar.nf_db)
    show('loss_db', c.radar.loss_db)
    show('pfa', c.radar.pfa)
    show('scan_k', c.radar.scan_k)
    show('scan_cone_deg', c.radar.scan_cone_deg)
    show('hpbw_az_deg', c.radar.hpbw_az_deg)
    show('hpbw_el_deg', c.radar.hpbw_el_deg)
    show('earth_radius_m', c.radar.earth_radius_m)
    show('earth_k', c.radar.earth_k)
    show('surface_alt_m', c.radar.surface_alt_m)
    show('min_range_m', c.radar.min_range_m)
    for i, p in ipairs(c.radar.prf) do
      show('prf.' .. i .. '.name', p.name)
      show('prf.' .. i .. '.prf', p.prf_hz)
      show('prf.' .. i .. '.tau', p.tau_s)
      show('prf.' .. i .. '.notch', p.notch_half_mps)
      show('prf.' .. i .. '.old_notch_present', p.${old.notch} ~= nil)
    end
    show('search.az_span_deg', c.scheduler.search.az_span_deg)
    show('search.az_step_deg', c.scheduler.search.az_step_deg)
    for i, v in ipairs(c.scheduler.search.el_bars_deg) do show('search.el.' .. i, v) end
    for i, v in ipairs(c.scheduler.prf_selection.search) do show('search.name.' .. i, v) end
    for i, v in ipairs(c.scheduler.prf_selection.track_far) do show('far.name.' .. i, v) end
    for i, v in ipairs(c.scheduler.prf_selection.track_near) do show('near.name.' .. i, v) end
    for i, v in ipairs(c.scheduler.prf_selection.stt) do show('stt.name.' .. i, v) end
    show('revisit.track_far_hz', c.scheduler.revisit.track_far_hz)
    show('revisit.track_near_hz', c.scheduler.revisit.track_near_hz)
    show('revisit.stt_hz', c.scheduler.revisit.stt_hz)
    show('revisit.near_km', c.scheduler.revisit.near_range_m)
    show('revisit.near_prf_R_m', c.scheduler.revisit.near_prf_R_m)
    show('tracker.confirm_m', c.tracker.confirm_m)
    show('tracker.confirm_window_s', c.tracker.confirm_window_s)
    show('tracker.coast_s', c.tracker.coast_s)
    show('tracker.gate_base_m', c.tracker.gate_base_m)
    show('tracker.gate_vel_margin', c.tracker.gate_vel_margin_mps)
    show('tracker.gate_max_m', c.tracker.gate_max_m)
    show('tracker.vel_floor', c.tracker.vel_floor_mps)
    show('tracker.gate_accel_margin', c.tracker.gate_accel_margin_mps)
    show('tracker.vel_smooth', c.tracker.vel_smooth)
    show('tracker.vel_accel_max', c.tracker.vel_accel_max_mps2)
    show('tracker.slow_mover', c.tracker.slow_mover_mps)
    show('tick_present', c.scheduler.${old.tick} ~= nil)
    show('old_search_idx_present', c.scheduler.search.${old.searchIdx} ~= nil)
  `);
  const values = new Map();
  for (const line of output.split(/\r?\n/)) {
    const index = line.indexOf('\t');
    if (index > 0) values.set(line.slice(0, index), line.slice(index + 1));
  }
  const number = name => Number(values.get(name));
  const specRadar = spec.radar.radar;
  const specScheduler = spec.radar.scheduler;
  const specTracker = spec.radar.tracker;
  nearlyEqual(number('lambda'), specRadar.lambda_m, 'lambda');
  nearlyEqual(number('ptx_avg'), specRadar.ptx_avg_w, 'ptx_avg');
  nearlyEqual(number('ptx_peak_w'), specRadar.ptx_peak_w, 'ptx_peak_w');
  nearlyEqual(number('gain0_db'), specRadar.gain0_db, 'gain0_db');
  nearlyEqual(number('nf_db'), specRadar.nf_db, 'nf_db');
  nearlyEqual(number('loss_db'), specRadar.loss_db, 'loss_db');
  nearlyEqual(number('pfa'), specRadar.pfa, 'pfa');
  nearlyEqual(number('scan_k'), specRadar.scan_k, 'scan_k');
  nearlyEqual(number('scan_cone_deg'), specRadar.scan_cone_deg, 'scan_cone_deg');
  nearlyEqual(number('hpbw_az_deg'), specRadar.hpbw_az_deg, 'hpbw_az_deg');
  nearlyEqual(number('hpbw_el_deg'), specRadar.hpbw_el_deg, 'hpbw_el_deg');
  nearlyEqual(number('earth_radius_m'), specRadar.earth_radius_m, 'earth_radius_m');
  nearlyEqual(number('earth_k'), specRadar.earth_k, 'earth_k');
  nearlyEqual(number('surface_alt_m'), specRadar.surface_alt_m, 'surface_alt_m');
  nearlyEqual(number('min_range_m'), specRadar.min_range_m, 'min_range_m');
  assert.equal(values.get('tick_present'), 'false');
  assert.equal(values.get('old_search_idx_present'), 'false');
  assert.ok(!Object.prototype.hasOwnProperty.call(spec.radar.scheduler, old.tick), 'spec removed the time-slice key');

  for (const [index, prf] of specRadar.prf.entries()) {
    const n = index + 1;
    assert.equal(values.get(`prf.${n}.name`), prf.name);
    nearlyEqual(number(`prf.${n}.prf`), prf.prf_hz, `prf ${n} prf`);
    nearlyEqual(number(`prf.${n}.tau`), prf.tau_s, `prf ${n} tau`);
    nearlyEqual(number(`prf.${n}.notch`), prf.notch_half_mps, `prf ${n} notch`);
  }
  nearlyEqual(number('search.az_span_deg'), specScheduler.search.az_span_deg, 'az span');
  nearlyEqual(number('search.az_step_deg'), specScheduler.search.az_step_deg, 'az step');
  for (const [index, bar] of specScheduler.search.el_bars_deg.entries()) {
    nearlyEqual(number(`search.el.${index + 1}`), bar, `el bar ${index + 1}`);
  }
  const collectNames = prefix => [...values.keys()]
    .filter(key => key.startsWith(prefix))
    .sort((a, b) => Number(a.split('.').pop()) - Number(b.split('.').pop()))
    .map(key => values.get(key));
  assert.deepEqual(spec.radar.prf_selection.search, collectNames('search.name.'));
  assert.deepEqual(spec.radar.prf_selection.track_far, collectNames('far.name.'));
  assert.deepEqual(spec.radar.prf_selection.track_near, collectNames('near.name.'));
  assert.deepEqual(spec.radar.prf_selection.stt, collectNames('stt.name.'));
  nearlyEqual(number('revisit.track_far_hz'), specScheduler.revisit.track_far_hz, 'track far');
  nearlyEqual(number('revisit.track_near_hz'), specScheduler.revisit.track_near_hz, 'track near');
  nearlyEqual(number('revisit.stt_hz'), specScheduler.revisit.stt_hz, 'stt');
  nearlyEqual(number('revisit.near_km'), specScheduler.revisit.near_range_m, 'near range');
  nearlyEqual(number('revisit.near_prf_R_m'), specScheduler.revisit.near_prf_R_m, 'near prf range');
  nearlyEqual(number('tracker.confirm_m'), specTracker.confirm_m, 'confirm_m');
  nearlyEqual(number('tracker.confirm_window_s'), specTracker.confirm_window_s, 'confirm_window_s');
  nearlyEqual(number('tracker.coast_s'), specTracker.coast_s, 'coast_s');
  nearlyEqual(number('tracker.gate_base_m'), specTracker.gate_base_m, 'gate_base_m');
  nearlyEqual(number('tracker.gate_vel_margin'), specTracker.gate_vel_margin_mps, 'gate_vel_margin');
  nearlyEqual(number('tracker.gate_max_m'), specTracker.gate_max_m, 'gate_max_m');
  nearlyEqual(number('tracker.vel_floor'), specTracker.vel_floor_mps, 'vel_floor');
  nearlyEqual(number('tracker.gate_accel_margin'), specTracker.gate_accel_margin_mps, 'gate_accel');
  nearlyEqual(number('tracker.vel_smooth'), specTracker.vel_smooth, 'vel_smooth');
  nearlyEqual(number('tracker.vel_accel_max'), specTracker.vel_accel_max_mps2, 'vel_accel');
  nearlyEqual(number('tracker.slow_mover'), specTracker.slow_mover_mps, 'slow_mover');
});

test('spec protocol ports and line limits match current sources', () => {
  const aa = read('src/export/aesa_export.lua');
  const sar = read('src/export/sar_protocol.lua');
  const live = read('tools/live.py');
  const receiver = read('tools/receiver.py');
  const sarLive = read('tools/sar_live.cjs');
  const hook = read('src/hooks/aesa_sar_scene_hook.lua');
  const bridge = read('tools/sar_bridge.cjs');
  const ports = spec.protocol.ports;
  assert.equal(Number(/PORT\s*=\s*(\d+)/.exec(aa)[1]), ports.aa_export);
  assert.match(live, /EXPORT_PORT\s*=\s*_SPEC\["ports"\]\["aa_export"\]/);
  assert.match(live, /HTTP_PORT\s*=\s*_SPEC\["ports"\]\["aa_http"\]/);
  assert.equal(Number(/PORT\s*=\s*(\d+)/.exec(sar)[1]), ports.sar_tcp);
  const service = read('tools/sar_service/service.cjs');
  assert.match(service, /tcpPort = PROTOCOL\.ports\.sar_tcp/);
  assert.match(service, /httpPort = PROTOCOL\.ports\.sar_http/);
  assert.match(service, /scenePort = tcpPort === 0 \? 0 : PROTOCOL\.ports\.sar_scene/);
  assert.match(hook, /scene_host,scene_port=protocol\.host,protocol\.ports\.sar_scene/);
  assert.match(hook, /connect\(scene_host,scene_port\)/);
  assert.match(receiver, /DEFAULT_PORT\s*=\s*_SPEC\["ports"\]\["aa_export"\]/);
  assert.match(receiver, /["']spec["']\s*\/\s*["']protocol\.json["']/);
  assert.match(bridge, /port=PROTOCOL\.ports\.sar_scene/);
  const aaRows = spec.protocol.aa.rows;
  const aaProto = spec.protocol.versions.aa_proto;
  assert.equal(aaRows.V1.fields, 1, 'spec V1 row is a single session marker');
  assert.deepEqual(aaRows.PROTO.tokens, ['PROTO', aaProto], 'spec PROTO tokens match versions.aa_proto');
  assert.equal(aaRows.PROTO.fields, aaRows.PROTO.tokens.length, 'spec PROTO field count matches its tokens');
  assert.equal(aaRows.COMPAT.fields, 3, 'spec COMPAT row carries profile id and matrix hash');
  assert.match(
    aa,
    new RegExp(`"${escapeRegExp(spec.protocol.versions.aa)}\\\\nPROTO,${escapeRegExp(aaProto)}\\\\n"`
      + '\\s*\\.\\.\\s*compat_line\\(\\)\\s*\\.\\.\\s*"\\\\n"'),
    'A/A handshake sends V1, then PROTO,<aa_proto>, then COMPAT');
  assert.match(
    aa,
    /local function compat_line\(\)\s*\n\s*return "COMPAT," \.\. profile:id\(\) \.\. "," \.\. profile:matrix_hash\(\)/,
    'COMPAT line has profile id and matrix hash fields');
  // The handshake word and the command cap moved with the split: the version is a protocol
  // constant, the cap is enforced by the collector's command parser.
  assert.match(sar, new RegExp(`VERSION = "${spec.protocol.versions.sar}"`));
  assert.match(hook, new RegExp(`HELLO,${spec.protocol.versions.scene}`));
  assert.match(read('src/export/sar_collector.lua'), new RegExp(`#line > ${spec.protocol.limits.sar_command_max_chars}`));
  assert.match(read('tools/sar_service/collector.cjs'), /PROTOCOL\.limits\.sar_server_line_max_chars/);
  assert.match(read('tools/sar_service/collector.cjs'), /PROTOCOL_MAP\.surface_token_max_chars/);
  assert.match(bridge, /PROTOCOL\.limits\.scene_line_max_chars/);
  assert.match(bridge, /PROTOCOL\.limits\.scene_recv_buffer_bytes/);
});

test('spec SAR profiles, footprints, materials and MAP defaults match current modules', () => {
  const { PROFILES } = require(path.join(ROOT, 'src', 'sar_core', 'settings.cjs'));
  for (const name of ['standard', 'fine', 'fast']) {
    const actual = PROFILES[name];
    const expected = spec.sar.profiles[name];
    assert.equal(actual.quality, expected.quality);
    assert.equal(actual.bandwidth, expected.bandwidth_hz);
    assert.equal(actual.width, expected.width);
    assert.equal(actual.pulseOversampling, expected.pulse_oversampling);
    if (expected.scatter_spacing_m !== undefined) assert.equal(actual.scatterSpacing, expected.scatter_spacing_m);
  }

  const { FOOTPRINTS } = require(path.join(ROOT, 'src', 'adapters', 'dcs', 'sar_adapter.cjs'));
  for (const name of ['detail', 'area', 'airport']) {
    const actual = FOOTPRINTS[name];
    const expected = spec.sar.footprints[name];
    assert.equal(actual.size, expected.size_m);
    assert.equal(actual.n, expected.n);
    assert.equal(actual.scatterSpacing, expected.scatter_spacing_m);
    if (expected.width !== undefined) assert.equal(actual.width, expected.width);
    if (expected.bandwidth_hz !== undefined) assert.equal(actual.bandwidth, expected.bandwidth_hz);
  }

  const { MATERIALS, SURFACE_CLASSES, SURFACE_PRIORITY } = require(path.join(ROOT, 'src', 'sar_core', 'materials.cjs'));
  assert.deepEqual([...SURFACE_CLASSES], spec.sar.surface_classes);
  assert.deepEqual([...SURFACE_PRIORITY], spec.sar.surface_priority);
  for (const [name, value] of Object.entries(MATERIALS)) {
    assert.equal(value, spec.sar.materials[name], name);
  }

  const { DEFAULTS } = require(path.join(ROOT, 'src', 'sar_core', 'map.cjs'));
  assert.deepEqual(DEFAULTS, spec.sar.map.engine_defaults);

  const config = require(path.join(ROOT, 'src', 'shared', 'config.cjs'));
  assert.deepEqual(config.SAR_MAP_SERVICE_DEFAULTS, spec.sar.map.service_defaults);
  assert.deepEqual(config.MAP_ENGINE_DEFAULTS, spec.sar.map.engine_defaults);
  assert.deepEqual(config.sar.map.limits, spec.sar.map.limits);
  assert.deepEqual(config.sar.map.mover, spec.sar.map.mover);
  assert.equal(config.PROTOCOL.mosaic.limit, spec.display.mosaic.limit);

  // The service defaults are consumed where they are used: the sessions read the MAP defaults out of
  // the generated config, the mosaic store owns the retention limit, and nothing restates them.
  const sessions = read('tools/sar_service/map_session.cjs') + read('tools/sar_service/dbs_session.cjs');
  assert.match(sessions, /SAR_MAP_SERVICE_DEFAULTS/);
  assert.match(read('tools/sar_service/coverage_index.cjs'), /MAP_ENGINE_DEFAULTS/);
  assert.match(read('tools/sar_service/mosaic_store.cjs'), /PROTOCOL\.mosaic\.limit/);
  assert.match(read('tools/sar_service/service.cjs'), /MAP_MOVER\.radius_max_m/);
  assert.match(read('tools/sar_service/service.cjs'), /PROTOCOL\.timeouts\.sar_map_retry_backoff_ms/);
  // The CLI is composition only (Gate 5 split tools/sar_live.cjs into tools/sar_service/*): a
  // default or a wire limit restated in it would be a second source.
  const sarLive = read('tools/sar_live.cjs');
  assert.doesNotMatch(sarLive, new RegExp(`const ${['MAP', 'DEFAULTS'].join('_')}=`));
  assert.doesNotMatch(sarLive, /const MAP_CELLS_MAX=/);
  assert.doesNotMatch(sarLive, /const MOSAIC_LIMIT=50/);
  assert.doesNotMatch(sarLive, /const SURFACE_TOKEN_MAX=/);

  const sarExport = read('src/export/sar_protocol.lua');
  assert.equal(Number(/N = (\d+), SIZE = (\d+), DURATION = (\d+)/.exec(sarExport)[1]), spec.protocol.sar.default_n);
  assert.equal(Number(/N = (\d+), SIZE = (\d+), DURATION = (\d+)/.exec(sarExport)[2]), spec.protocol.sar.default_size_m);
  assert.equal(Number(/N = (\d+), SIZE = (\d+), DURATION = (\d+)/.exec(sarExport)[3]), spec.protocol.sar.duration_s);
  const mapMatch = /MAP_CELLS = (\d+), MAP_ROWS = (\d+), MAP_STEP = \{ (\d+), (\d+) \}, MAP_POSE = ([\d.]+)/.exec(sarExport);
  assert.ok(mapMatch, 'Export MAP constants found');
  assert.equal(Number(mapMatch[1]), spec.sar.map.collection.cells_max);
  assert.equal(Number(mapMatch[2]), spec.sar.map.collection.rows_max);
  assert.equal(Number(mapMatch[3]), spec.sar.map.collection.step_min_m);
  assert.equal(Number(mapMatch[4]), spec.sar.map.collection.step_max_m);
  assert.equal(Number(mapMatch[5]), spec.sar.map.collection.pose_interval_s);

  const pfa = require(path.join(ROOT, 'src', 'sar_core', 'pfa.cjs'));
  assert.equal(pfa.MAX_PFA_GRID, spec.sar.pfa.max_grid);
});

test('spec physics constants are single-sourced', () => {
  const config = require(path.join(ROOT, 'src', 'shared', 'config.cjs'));
  nearlyEqual(config.C_MPS, spec.physics.constants.c_mps, 'C_MPS');
  nearlyEqual(config.BOLTZMANN_J_PER_K, spec.physics.constants.boltzmann_j_per_k, 'BOLTZMANN');
  nearlyEqual(config.T0_K, spec.physics.constants.t0_k, 'T0');
  for (const relative of ['src/sar_core/engine.cjs', 'src/sar_core/pfa.cjs', 'src/sar_core/memory.cjs']) {
    const text = read(relative);
    assert.match(text, /C_MPS/, `C_MPS import in ${relative}`);
    assert.doesNotMatch(text, /\b299792458\b/, `literal C removed from ${relative}`);
  }
  const constants = read('src/core/constants.lua');
  assert.match(constants, /function M\.configure/, 'constants.configure exists');
  assert.match(
    constants,
    /C_LIGHT,\s*K_BOLTZ,\s*T0\s*=\s*p\.c_mps,\s*p\.boltzmann_j_per_k,\s*p\.t0_k/,
    'constants.configure stores the injected c_mps/boltzmann_j_per_k/t0_k');
  const physics = read('src/core/physics.lua');
  assert.match(physics, /constants\.light_speed\(\)/, 'physics reads C from core/constants');
  assert.match(physics, /constants\.boltzmann\(\)/, 'physics reads Boltzmann from core/constants');
  assert.match(physics, /constants\.t0\(\)/, 'physics reads T0 from core/constants');
  for (const relative of [
    'src/core/constants.lua',
    'src/core/physics.lua',
    'src/core/beam.lua',
    'src/core/detection.lua',
    'src/core/geometry.lua'
  ]) {
    const text = read(relative);
    const cLiteral = new RegExp('\\b(?:' + ['299', '792458'].join('') + '(?:\\.0+)?|2\\.99792458[eE]8)\\b');
    assert.doesNotMatch(text, cLiteral, `literal C in ${relative}`);
    assert.doesNotMatch(text, /\b1\.380649e-23\b/, `literal Boltzmann in ${relative}`);
    assert.doesNotMatch(text, /(?<![\d.])290(?:\.0+)?(?![\d])/, `literal T0=290 in ${relative}`);
  }
});

test('spec deployment paths match installers and hooks', () => {
  const products = spec.deployment.products;
  const common = read('scripts/install_common.cjs');
  assert.match(common, new RegExp(escapeRegExp(products.aa_export.backup_suffix)));
  const exportInstaller = read('scripts/install_export.py');
  assert.match(exportInstaller, new RegExp(escapeRegExp(path.posix.basename(products.aa_export.script))));
  assert.match(exportInstaller, new RegExp(escapeRegExp(products.aa_export.backup_suffix)));
  const sarInstaller = read('scripts/install_sar.cjs');
  assert.match(sarInstaller, new RegExp(escapeRegExp(path.posix.basename(products.sar_export.script))));
  const sceneInstaller = read('scripts/install_sar_scene.cjs');
  assert.match(sceneInstaller, new RegExp(escapeRegExp(products.sar_scene.script)));
  const agrInstaller = read('scripts/install_agradar_probe.cjs');
  assert.match(agrInstaller, new RegExp(escapeRegExp(products.agradar.dll)));
  const fcInstaller = read('scripts/install_fc_probe.cjs');
  assert.match(fcInstaller, new RegExp(escapeRegExp(products.fc.trace_dll)));
  assert.match(fcInstaller, new RegExp(escapeRegExp(products.fc.inject_dll)));
  const agrHook = read('src/hooks/aesa_agradar_hook.lua');
  assert.match(agrHook, new RegExp(escapeRegExp(products.agradar.log_dir.replace(/\//g, '\\\\'))));
  const fcNative = read('src/native/fc_probe/aesa_fc.c');
  const nativeLogDir = spec.deployment.native.fc_log_dir.replace('%USERPROFILE%/', '').replace(/\//g, '\\\\');
  assert.match(fcNative, new RegExp(escapeRegExp(nativeLogDir)));
});

test('schema validation rejects missing keys, duplicate ports, bad spacing and non-finite numbers', () => {
  const clone = value => JSON.parse(JSON.stringify(value));
  const base = clone(rawSpecs);
  const badRadar = clone(base);
  badRadar['radar.json'].radar.hpbw_el_deg = 2;
  assert.throws(() => generator.validateSpecs(badRadar), /gap .* exceeds hpbw_el_deg/);

  const badPort = clone(base);
  badPort['protocol.json'].ports.aa_http = badPort['protocol.json'].ports.aa_export;
  assert.throws(() => generator.validateSpecs(badPort), /duplicate port/);

  const missing = clone(base);
  delete missing['sar.json'].surface_classes;
  assert.throws(() => generator.validateSpecs(missing), /surface_classes.*must be an array/);

  const nonFinite = clone(base);
  nonFinite['physics.json'].constants.c_mps = Number.NaN;
  assert.throws(() => generator.validateSpecs(nonFinite), /non-finite/);

  const badSurface = clone(base);
  badSurface['sar.json'].surface_classes.pop();
  assert.throws(() => generator.validateSpecs(badSurface), /exactly 16/);
});

test('fixture snapshot matches generated config', () => {
  const fixture = readJson('tests/fixtures/config.json');
  const generated = generator.generateAll();
  assert.equal(fixture.input_sha256, generated.inputSha);
  const config = require(path.join(ROOT, 'src', 'shared', 'config.cjs'));
  assert.deepEqual(fixture.config.physics, config.physics);
  assert.deepEqual(fixture.config.radar, config.radar);
  assert.deepEqual(fixture.config.scheduler, config.scheduler);
  assert.deepEqual(fixture.config.tracker, config.tracker);
  assert.deepEqual(fixture.config.sar, config.sar);
  assert.deepEqual(fixture.config.protocol, config.protocol);
  assert.deepEqual(fixture.config.deployment, config.deployment);
  assert.deepEqual(fixture.config.display, config.display);
  const conflictCount = Object.values(rawSpecs).reduce((sum, value) => sum + (value.known_conflicts || []).length, 0);
  assert.equal(fixture.known_conflicts.length, conflictCount);
});

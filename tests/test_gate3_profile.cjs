'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { findLua: findDcsLua } = require('../scripts/build_common.cjs');

const ROOT = path.resolve(__dirname, '..');
const WORKSPACE = path.resolve(ROOT, '..');
const generator = require(path.join(ROOT, 'scripts', 'gen_config.cjs'));

const PROFILE_ID = 'dcs-2.9.30.28738-mt';
const PROFILE_LUA = `src/adapters/dcs/compat/profiles/${PROFILE_ID}.lua`;
const GENERIC_LUA = 'src/adapters/dcs/compat/profiles/dcs-generic.lua';
const HEADER = 'src/native/abi/dcs_profile.h';
const FIXTURE = 'tests/fixtures/dcs_profile.json';

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function readJson(relative) {
  return JSON.parse(read(relative));
}

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

// Independent reference implementation: must not call generator.fnv1a32.
function fnv1a32Reference(text) {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(text, 'utf8')) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function matrixCanonicalReference(capabilities) {
  return Object.keys(capabilities).sort().map(key => {
    const value = capabilities[key];
    let state = 'unknown';
    if (value === true) state = 'ok';
    else if (value === false) state = 'unavailable';
    else if (typeof value === 'string') state = value;
    else if (value && typeof value === 'object' && value.state) state = value.state;
    return `${key}=${state}\n`;
  }).join('');
}

const HASH_VECTOR_INPUTS = [
  'EXP-SELF=ok\n',
  'EXP-SELF=ok\nEXP-VEL=degraded\n',
  'BUILD=ok\nEXP-SELF=unknown\nNAT-HASH=unavailable\n'
];

const rawSpecs = Object.fromEntries(generator.SPEC_FILES.map(name => [name, readJson(`spec/${name}`)]));
const profileSpecs = generator.readProfileSpecs();
const profiles = generator.validateProfileSpecs(profileSpecs);
const generated = generator.generateAll();
const fixture = readJson(FIXTURE);
const concrete = profiles.find(entry => entry.spec.id === PROFILE_ID);
const generic = profiles.find(entry => entry.spec.id === 'dcs-generic');

function parseMacros(text) {
  const macros = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^#define\s+([A-Z0-9_]+)\s+(.+?)(?:\s*\/\*.*)?$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    else if (/^0x[0-9a-f]+$/i.test(value)) value = Number.parseInt(value, 16);
    else if (/^-?\d+$/.test(value)) value = Number(value);
    macros.set(match[1], value);
  }
  return macros;
}

function arrayValues(text, name) {
  const pattern = new RegExp(`static const char \\*const ${name}\\[\\] = \\{([\\s\\S]*?)\\n\\};`);
  const match = pattern.exec(text);
  assert.ok(match, `${name} array exists`);
  return [...match[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(item => JSON.parse(`"${item[1]}"`));
}

test('generator --check is clean, deterministic and covers profile outputs', () => {
  const check = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'gen_config.cjs'), '--check'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.match(check.stdout, new RegExp(`OK: ${generated.outputList.length} generated files match spec`));
  assert.match(check.stdout, /profile-input-sha256 [0-9a-f]{64}/);
  for (const relative of [PROFILE_LUA, GENERIC_LUA, HEADER, FIXTURE]) {
    assert.ok(generated.outputList.includes(relative), `${relative} is checked`);
  }
  assert.equal(generated.outputList.length, generator.BASE_OUTPUTS.length + profiles.length + 2);
  const first = generator.generateAll();
  const second = generator.generateAll();
  assert.deepEqual(first.outputs, second.outputs);
  assert.deepEqual(first.outputList, second.outputList);
  assert.equal(first.inputSha, generator.inputHash(rawSpecs));
  assert.equal(first.profileInputSha, generator.inputHash(rawSpecs, profileSpecs));
  assert.notEqual(first.inputSha, first.profileInputSha);
});

test('profile specs validate build, modules, offsets and required capabilities', () => {
  assert.equal(concrete.concrete, true);
  assert.equal(generic.concrete, false);
  assert.equal(concrete.spec.build, '2.9.30.28738');
  assert.equal(concrete.spec.variant, 'MT');
  assert.equal(concrete.spec.verified, '2026-10-17');
  assert.deepEqual(Object.keys(concrete.spec.modules), [
    'DCS', 'Inter', 'edterrain4', 'Weapons', 'wRadio', 'WeaponBlocks', 'WorldGeneral', 'CockpitBase'
  ]);
  for (const [name, module] of Object.entries(concrete.spec.modules)) {
    assert.match(module.sha256, /^[0-9A-F]{64}$/, name);
    assert.equal(module.version, '2.9.30.28738', name);
  }
  assert.equal(concrete.spec.native.agradar.symbols.length, 4);
  assert.equal(concrete.spec.native.agradar.vtable_slot, 19);
  assert.equal(concrete.spec.native.agradar.point_on_surface_offset, 0x38);
  assert.equal(concrete.spec.native.agradar.surface_classes, 16);
  assert.equal(concrete.spec.native.fc.symbols.length, 17);
  assert.equal(concrete.spec.native.fc.sites.length, 13);
  assert.deepEqual(concrete.spec.native.fc.offsets, {
    pos: 0x1a8, vel: 0x1c0, aim: 0x220, tgo: 0x170, r0: 0x178, range: 0x180
  });
  // Gate 6: the inject build exists, so the profile documents the write path
  // (write=true). Runtime permission still needs mode=1 + NAT-FC-SYM + exports.
  assert.equal(concrete.spec.native.fc.write, true);
  assert.deepEqual(concrete.spec.native.fc.trace_exports, [
    'aesa_fc_init', 'aesa_fc_poll', 'aesa_fc_shutdown', 'aesa_fc_version',
    'aesa_fc_trace_start', 'aesa_fc_trace_stop', 'aesa_fc_readable'
  ]);
  assert.deepEqual(concrete.spec.native.fc.inject_exports, [
    'aesa_fc_init', 'aesa_fc_poll', 'aesa_fc_shutdown', 'aesa_fc_version',
    'aesa_fc_trace_start', 'aesa_fc_trace_stop', 'aesa_fc_readable',
    'aesa_fc_arm', 'aesa_fc_disarm', 'aesa_fc_feed_target'
  ]);
  assert.equal(concrete.spec.data.rcs_entries, 50);
  assert.deepEqual(concrete.spec.data.rcs_required_fallbacks, ['fighter', 'large', 'helicopter', 'missile']);
  assert.equal(concrete.spec.shader.radar_fx_sha256, '719E33753046E472F1D14CC7032786F5B26672389126A3DA79718786A99ECC3D');
  const generated = require(path.join(ROOT, 'src', 'shared', 'config.cjs'));
  assert.equal(concrete.spec.shader.dbs_lambda, generated.LAMBDA_M);
  for (const key of concrete.spec.required) {
    assert.equal(generator.matrixState(concrete.spec.capabilities[key]), 'ok', key);
  }
});

test('generated Lua profiles carry DO NOT EDIT, generator and profile hash', () => {
  for (const entry of [concrete, generic]) {
    const relative = `src/adapters/dcs/compat/profiles/${entry.spec.id}.lua`;
    const text = read(relative);
    assert.match(text, /DO NOT EDIT/, relative);
    assert.match(text, /generated by scripts\/gen_config\.cjs/, relative);
    assert.match(text, new RegExp(`profile-id: ${entry.spec.id.replace(/\./g, '\\.')}`), relative);
    assert.match(text, new RegExp(`profile-sha256: ${generator.sha256Canonical(entry.data)}`), relative);
    assert.match(text, new RegExp(`input-sha256: ${generated.profileInputSha}`), relative);
    assert.match(text, new RegExp(`id = "${entry.spec.id.replace(/\./g, '\\.')}"`), relative);
  }
  const concreteText = read(PROFILE_LUA);
  for (const module of Object.values(concrete.spec.modules)) {
    assert.ok(concreteText.includes(module.sha256), module.sha256);
  }
  assert.match(concreteText, /pos = 424/);
  assert.match(concreteText, /vel = 448/);
  assert.match(concreteText, /aim = 544/);
  assert.match(concreteText, /tgo = 368/);
  assert.match(concreteText, /r0 = 376/);
  assert.match(concreteText, /range = 384/);
  assert.match(concreteText, /\[0\] = "Land"/);
  assert.match(read(GENERIC_LUA), /read_only = true/);
});

test('native symbol names match the probe source declarations', () => {
  const joinStrings = text => text.replace(/"\s*\n\s*"/g, '');
  const agradarSource = joinStrings(read('src/native/agradar_probe/aesa_agradar.c'));
  const fcSource = joinStrings(read('src/native/fc_probe/aesa_fc.c'));
  for (const entry of concrete.spec.native.agradar.symbols) {
    assert.ok(agradarSource.includes(entry.symbol), `${entry.module}!${entry.symbol}`);
  }
  for (const entry of concrete.spec.native.fc.symbols) {
    assert.ok(fcSource.includes(entry.symbol), `${entry.module}!${entry.symbol}`);
  }
  for (const entry of concrete.spec.native.fc.sites) {
    assert.ok(fcSource.includes(entry.symbol), `${entry.name}: ${entry.module}!${entry.symbol}`);
  }
});

test('generated C header has active macros, per-profile guards and symbol arrays', () => {
  const header = read(HEADER);
  assert.match(header, /DO NOT EDIT/);
  assert.match(header, /generated by scripts\/gen_config\.cjs/);
  assert.match(header, new RegExp(`input-sha256: ${generated.profileInputSha}`));
  assert.match(header, /#ifndef AESA_DCS_PROFILE_H/);
  assert.match(header, /#endif \/\* AESA_DCS_PROFILE_H \*\//);
  assert.match(header, /AESA_DCS_PROFILE_DCS_2_9_30_28738_MT_DEFINED/);
  assert.match(header, /AESA_DCS_PROFILE_DCS_GENERIC_DEFINED/);

  const macros = parseMacros(header);
  assert.equal(macros.get('AESA_DCS_PROFILE_ID'), PROFILE_ID);
  assert.equal(macros.get('AESA_DCS_PROFILE_SCHEMA'), 1);
  assert.equal(macros.get('AESA_DCS_BUILD'), '2.9.30.28738');
  assert.equal(macros.get('AESA_DCS_VARIANT'), 'MT');
  assert.equal(macros.get('AESA_DCS_VARIANT_MT'), 1);
  assert.equal(macros.get('AESA_DCS_VARIANT_ST'), 0);
  assert.equal(macros.get('AESA_DCS_EXPORTS_SHA256'), 'unknown');
  assert.equal(macros.get('AESA_AGR_VTABLE_SLOT'), 19);
  assert.equal(macros.get('AESA_AGR_POINT_SURFACE_OFF'), 0x38);
  assert.equal(macros.get('AESA_AGR_SURFACE_CLASSES'), 16);
  assert.equal(macros.get('AESA_AGR_SYMBOL_COUNT'), 4);
  assert.equal(macros.get('AESA_FC_OFF_POS'), 0x1a8);
  assert.equal(macros.get('AESA_FC_OFF_VEL'), 0x1c0);
  assert.equal(macros.get('AESA_FC_OFF_AIM'), 0x220);
  assert.equal(macros.get('AESA_FC_OFF_TGO'), 0x170);
  assert.equal(macros.get('AESA_FC_OFF_R0'), 0x178);
  assert.equal(macros.get('AESA_FC_OFF_RANGE'), 0x180);
  assert.equal(macros.get('AESA_FC_SYMBOL_COUNT'), 17);
  assert.equal(macros.get('AESA_FC_SITE_COUNT'), 13);
  assert.equal(macros.get('AESA_DCS_MODULE_COUNT'), 8);

  const moduleNames = arrayValues(header, 'AESA_DCS_MODULE_NAMES');
  const moduleVersions = arrayValues(header, 'AESA_DCS_MODULE_VERSIONS');
  const moduleHashes = arrayValues(header, 'AESA_DCS_MODULE_SHA256');
  assert.deepEqual(moduleNames, [
    'DCS.exe', 'Inter.dll', 'edterrain4.dll', 'Weapons.dll',
    'wRadio.dll', 'WeaponBlocks.dll', 'WorldGeneral.dll', 'CockpitBase.dll'
  ]);
  assert.equal(moduleVersions.length, 8);
  assert.ok(moduleVersions.every(version => version === '2.9.30.28738'));
  assert.equal(moduleHashes.length, 8);
  for (const [index, hash] of moduleHashes.entries()) {
    const key = Object.keys(concrete.spec.modules)[index];
    assert.equal(hash, concrete.spec.modules[key].sha256, key);
  }

  const agrSymbols = arrayValues(header, 'AESA_AGR_SYMBOLS');
  const fcSymbols = arrayValues(header, 'AESA_FC_SYMBOLS');
  const siteSymbols = arrayValues(header, 'AESA_FC_SITE_SYMBOLS');
  const siteNames = arrayValues(header, 'AESA_FC_SITE_NAMES');
  assert.equal(agrSymbols.length, 4);
  assert.equal(fcSymbols.length, 17);
  assert.equal(siteSymbols.length, 13);
  assert.equal(siteNames.length, 13);
  assert.equal(agrSymbols[0], 'Inter.dll!?GetDefaultTerrain@ITerrain@edterrain@@SAPEAV12@XZ');
  assert.ok(fcSymbols.includes('Weapons.dll!?setTarget@wAmmunitionGuided@@UEAAXI@Z'));
  assert.deepEqual(siteNames, [
    'RECV_DL', 'RECV_NET', 'SEND_DL', 'ASSIGN_AUTO', 'TRACK_WS', 'TRACK_LAUNCHER',
    'SET_TARGET', 'ASSIGN_TP', 'SYNC_TP', 'CALC_INERT', 'CALC_TERM', 'CTRL_MODE', 'INTERM_TP'
  ]);
});

test('generated C header parses', () => {
  const gcc = findGcc();
  if (!gcc) throw new Error('gcc not found; Gate 3 requires a C compiler for dcs_profile.h');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aesa-gate3-'));
  const source = path.join(temp, 'dcs_profile_check.c');
  fs.writeFileSync(source, [
    `#include "${path.join(ROOT, 'src', 'native', 'abi', 'dcs_profile.h').replace(/\\/g, '/')}"`,
    'int main(void) {',
    '  return AESA_DCS_PROFILE_SCHEMA + (int)AESA_AGR_POINT_SURFACE_OFF + (int)AESA_FC_OFF_POS',
    '    + (int)AESA_AGR_SYMBOLS[0][0] + (int)AESA_FC_SITE_NAMES[0][0]',
    '    + (int)AESA_DCS_MODULE_NAMES[0][0] + (int)AESA_DCS_MODULE_SHA256[0][0];',
    '}',
    ''
  ].join('\n'));
  const env = { ...process.env };
  if (gcc !== 'gcc') env.PATH = `${path.dirname(gcc)}${path.delimiter}${env.PATH || ''}`;
  const compile = spawnSync(gcc, ['-fsyntax-only', '-I', ROOT, source], { cwd: ROOT, encoding: 'utf8', env });
  assert.equal(compile.status, 0, compile.stdout + compile.stderr);
});

test('fixture snapshots both profiles and their matrix hashes', () => {
  assert.equal(fixture.DO_NOT_EDIT, true);
  assert.equal(fixture.generator, 'scripts/gen_config.cjs');
  assert.equal(fixture.input_sha256, generated.profileInputSha);
  assert.equal(fixture.matrix_algorithm, 'fnv1a32');
  assert.equal(fixture.profiles.length, profiles.length);
  for (const entry of profiles) {
    const saved = fixture.profiles.find(profile => profile.id === entry.spec.id);
    assert.ok(saved, entry.spec.id);
    assert.equal(saved.file, `src/adapters/dcs/compat/profiles/${entry.spec.id}.lua`);
    assert.equal(saved.profile_sha256, generator.sha256Canonical(entry.data));
    assert.deepEqual(saved.data, entry.data);
    assert.equal(saved.matrix_hash, fnv1a32Reference(matrixCanonicalReference(entry.data.capabilities)));
    assert.equal(saved.matrix_hash, generator.matrixHash(entry.data.capabilities));
  }
});

test('Lua and JS agree on matrix hash vectors and generated profiles', () => {
  const lua = findLua();
  if (!lua) throw new Error('Lua 5.1 (luae.exe) not found; Gate 3 requires it for profile checks');
  const script = `
    local P = dofile('src/adapters/dcs/compat/profile.lua')
    for i = 1, #P.HASH_VECTORS do
      local v = P.HASH_VECTORS[i]
      print(string.format('VECTOR|%d|%s|%s', i, P.fnv1a32(v.input), v.hash))
    end
    local concrete = dofile('${PROFILE_LUA}')
    local instance = P.new(concrete, 'generated')
    print(string.format('MATRIX|%s|%s|%s', instance:matrix_hash(), instance:id(), instance.profile_source))
    local generic = dofile('${GENERIC_LUA}')
    P.set_generic(generic)
    local fallback = P.new(nil)
    print(string.format('GENERIC|%s|%s|%s', fallback:matrix_hash(), fallback:id(), fallback.profile_source))
    local ok, err = pcall(fallback.require, fallback, 'BUILD')
    print(string.format('REQUIRE|%s|%s|%s', tostring(ok), type(err), tostring(err and err.code)))
  `;
  const result = spawnSync(lua, ['-e', script], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, `Lua failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const rows = result.stdout.trim().split(/\r?\n/).map(line => line.split('|'));
  const vectors = rows.filter(row => row[0] === 'VECTOR');
  assert.equal(vectors.length, 3);
  for (const [index, row] of vectors.entries()) {
    assert.equal(row[1], String(index + 1));
    assert.equal(row[2], fnv1a32Reference(HASH_VECTOR_INPUTS[index]), `vector ${index + 1}`);
    assert.equal(row[2], row[3], `Lua vector ${index + 1} matches declared hash`);
  }
  const matrix = rows.find(row => row[0] === 'MATRIX');
  assert.ok(matrix);
  assert.equal(matrix[1], fnv1a32Reference(matrixCanonicalReference(concrete.spec.capabilities)));
  assert.equal(matrix[1], fixture.profiles.find(profile => profile.id === PROFILE_ID).matrix_hash);
  assert.equal(matrix[2], PROFILE_ID);
  assert.equal(matrix[3], 'generated');
  const genericRow = rows.find(row => row[0] === 'GENERIC');
  assert.ok(genericRow);
  assert.equal(genericRow[1], fnv1a32Reference(matrixCanonicalReference(generic.spec.capabilities)));
  assert.equal(genericRow[2], 'dcs-generic');
  assert.equal(genericRow[3], 'fallback');
  const requireRow = rows.find(row => row[0] === 'REQUIRE');
  assert.deepEqual(requireRow.slice(1), ['false', 'table', 'capability']);
});

test('schema validation rejects bad build, module hash, offset and required capability', () => {
  const clone = () => JSON.parse(JSON.stringify(profileSpecs));
  const concreteName = `${PROFILE_ID}.json`;

  const badBuild = clone();
  badBuild[concreteName].build = '2.9.30';
  assert.throws(() => generator.validateProfileSpecs(badBuild), /build.*four numeric components|must be dcs-/);

  const badHash = clone();
  badHash[concreteName].modules.DCS.sha256 = 'not-a-hash';
  assert.throws(() => generator.validateProfileSpecs(badHash), /sha256.*64-character hex/);

  const badOffset = clone();
  badOffset[concreteName].native.fc.offsets.pos = 1.5;
  assert.throws(() => generator.validateProfileSpecs(badOffset), /offsets\.pos.*integer/);

  const badRequired = clone();
  badRequired[concreteName].capabilities.BUILD = false;
  assert.throws(() => generator.validateProfileSpecs(badRequired), /required capability "BUILD" must be "ok"/);

  const badState = clone();
  badState[concreteName].capabilities['EXP-SELF'] = 'broken';
  assert.throws(() => generator.validateProfileSpecs(badState), /state must be ok\|degraded\|unavailable\|unknown/);

  const missingSchema = clone();
  delete missingSchema[concreteName].schema;
  assert.throws(() => generator.validateProfileSpecs(missingSchema), /missing required key "schema"/);

  const badCount = clone();
  badCount[concreteName].native.fc.sites.pop();
  assert.throws(() => generator.validateProfileSpecs(badCount), /must have exactly 13 entries/);
});

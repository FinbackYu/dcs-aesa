'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { findLua: findDcsLua } = require('../scripts/build_common.cjs');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'compat');
const SAVED_GAMES = path.join(FIXTURES, 'saved-games');
const FULL_PROFILE = path.join(ROOT, 'spec', 'dcs_profiles', 'dcs-2.9.30.28738-mt.json');
const MIN_PROFILE = path.join(FIXTURES, 'profile-min.json');
const CLI = path.join(ROOT, 'scripts', 'compat_check.cjs');
const cc = require(CLI);

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60000,
  });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aesa-compat-'));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function withoutTimestamp(value) {
  const clone = JSON.parse(JSON.stringify(value));
  delete clone.generated_at;
  return clone;
}

function fixture(name) {
  return path.join(FIXTURES, name);
}

function findLua() {
  const candidates = [
    process.env.AESA_LUA,
    findDcsLua(),
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

test('matrix hash matches profile.lua, the generated fixture and fixed vectors', () => {
  const vectors = [
    ['EXP-SELF=ok\n', 'd261c0ec'],
    ['EXP-SELF=ok\nEXP-VEL=degraded\n', '8ebcf91c'],
    ['BUILD=ok\nEXP-SELF=unknown\nNAT-HASH=unavailable\n', '1012a55e'],
  ];
  for (const [input, expected] of vectors) {
    assert.equal(cc.fnv1a32(input), expected);
  }
  assert.equal(
    cc.matrixCanonical({ 'EXP-VEL': 'degraded', 'EXP-SELF': 'ok' }),
    'EXP-SELF=ok\nEXP-VEL=degraded\n'
  );

  const snapshot = readJson(path.join(ROOT, 'tests', 'fixtures', 'dcs_profile.json'));
  for (const profile of snapshot.profiles) {
    assert.equal(cc.matrixHash(profile.data.capabilities), profile.matrix_hash, profile.id);
  }

  const lua = findLua();
  assert.ok(lua, 'Lua 5.1 (luae.exe) is required for the cross-language hash check');
  const script = `
    local P = dofile('src/adapters/dcs/compat/profile.lua')
    for i = 1, #P.HASH_VECTORS do
      local v = P.HASH_VECTORS[i]
      print(string.format('VECTOR|%d|%s', i, P.fnv1a32(v.input)))
    end
    local concrete = P.new(dofile('src/adapters/dcs/compat/profiles/dcs-2.9.30.28738-mt.lua'))
    print(string.format('MATRIX|%s|%s', concrete:id(), concrete:matrix_hash()))
    local generic = P.new(dofile('src/adapters/dcs/compat/profiles/dcs-generic.lua'))
    print(string.format('MATRIX|%s|%s', generic:id(), generic:matrix_hash()))
  `;
  const result = spawnSync(lua, ['-e', script], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const rows = result.stdout.trim().split(/\r?\n/).map(line => line.split('|'));
  const vectorRows = rows.filter(row => row[0] === 'VECTOR');
  assert.equal(vectorRows.length, 3);
  for (const [index, row] of vectorRows.entries()) {
    assert.equal(row[2], vectors[index][1], `vector ${index + 1}`);
  }
  const matrices = Object.fromEntries(rows.filter(row => row[0] === 'MATRIX').map(row => [row[1], row[2]]));
  for (const profile of snapshot.profiles) {
    assert.equal(matrices[profile.id], profile.matrix_hash, profile.id);
  }
});

test('record from the saved-games fixture is normalized, sorted and deterministic', () => {
  const directory = tempDir();
  const firstFile = path.join(directory, 'baseline-a.json');
  const secondFile = path.join(directory, 'baseline-b.json');
  for (const file of [firstFile, secondFile]) {
    const result = run(['--record', file, '--saved-games', SAVED_GAMES, '--profile', FULL_PROFILE]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /level=B/);
  }
  const first = readJson(firstFile);
  const second = readJson(secondFile);
  assert.equal(first.schema, 1);
  assert.equal(first.build, '2.9.30.28738');
  assert.equal(first.variant, 'MT');
  assert.equal(first.profile_id, 'dcs-2.9.30.28738-mt');
  assert.equal(first.level, 'B');
  assert.equal(first.matrix_hash, '0982a986');
  assert.deepEqual(first.required, [...first.required].sort());
  assert.deepEqual(Object.keys(first.caps), [...Object.keys(first.caps)].sort());
  assert.equal(Object.keys(first.caps).length, 39);
  assert.equal(first.caps['DAT-RCS'].state, 'ok');
  assert.equal(first.caps['NAT-AGR-SYM'].state, 'ok');
  assert.equal(first.caps['NAT-FC-SITES'].state, 'degraded');
  assert.equal(first.caps['GFX-RADARFX'].state, 'ok');
  assert.equal(cc.matrixHash(first.caps), first.matrix_hash);
  assert.deepEqual(withoutTimestamp(first), withoutTimestamp(second));
});

test('detect diff exits 0 for an A matrix and writes stable JSON', () => {
  const directory = tempDir();
  const baseline = path.join(directory, 'baseline.json');
  const output = path.join(directory, 'detect.json');
  let result = run(['--record', baseline, '--probe', fixture('probe-min-ok.log'), '--profile', MIN_PROFILE]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  result = run([
    '--detect', '--diff', baseline, '--json', output,
    '--probe', fixture('probe-min-ok.log'), '--profile', MIN_PROFILE,
  ]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /level=A/);
  const detected = readJson(output);
  assert.equal(detected.level, 'A');
  assert.equal(detected.matrix_hash, '2997d797');
  assert.deepEqual(detected.diffs, []);
  assert.deepEqual(detected.flaky, []);
});

test('optional degradation exits 2 (B)', () => {
  const directory = tempDir();
  const baseline = path.join(directory, 'baseline.json');
  const output = path.join(directory, 'detect.json');
  let result = run(['--record', baseline, '--probe', fixture('probe-min-ok.log'), '--profile', MIN_PROFILE]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  result = run([
    '--detect', '--diff', baseline, '--json', output,
    '--probe', fixture('probe-min-degraded.log'), '--profile', MIN_PROFILE,
  ]);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  const detected = readJson(output);
  assert.equal(detected.level, 'B');
  const added = detected.diffs.find(diff => diff.key === 'TER-VIS');
  assert.ok(added, 'TER-VIS diff present');
  assert.equal(added.class, 'added');
  assert.equal(added.before, null);
  assert.equal(added.after, 'degraded');
});

test('required capability loss exits 3 (C)', () => {
  const directory = tempDir();
  const baseline = path.join(directory, 'baseline.json');
  const output = path.join(directory, 'detect.json');
  let result = run(['--record', baseline, '--probe', fixture('probe-min-ok.log'), '--profile', MIN_PROFILE]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  result = run([
    '--detect', '--diff', baseline, '--json', output,
    '--probe', fixture('probe-min-required-bad.log'), '--profile', MIN_PROFILE,
  ]);
  assert.equal(result.status, 3, result.stdout + result.stderr);
  const detected = readJson(output);
  assert.equal(detected.level, 'C');
  const diff = detected.diffs.find(item => item.key === 'TER-GH');
  assert.ok(diff, 'TER-GH diff present');
  assert.equal(diff.before, 'ok');
  assert.equal(diff.after, 'unavailable');
  assert.equal(diff.class, 'incompatible');
});

test('missing or incomplete probe evidence exits 4 (blocked)', () => {
  const directory = tempDir();
  const baseline = path.join(directory, 'baseline.json');
  let result = run(['--record', baseline, '--probe', fixture('probe-min-ok.log'), '--profile', MIN_PROFILE]);
  assert.equal(result.status, 0, result.stdout + result.stderr);

  result = run([
    '--detect', '--diff', baseline,
    '--probe', fixture('probe-incomplete.log'), '--profile', MIN_PROFILE,
  ]);
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.match(result.stdout, /level=blocked/);

  const missingBaseline = path.join(directory, 'blocked-baseline.json');
  result = run([
    '--record', missingBaseline, '--saved-games', directory,
    '--profile', MIN_PROFILE,
  ]);
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.equal(fs.existsSync(missingBaseline), false, 'blocked baseline must not be written');
});

test('baseline-missing keys are classified added; upgrades are improved', () => {
  const directory = tempDir();
  const baseline = path.join(directory, 'baseline.json');
  let result = run(['--record', baseline, '--probe', fixture('probe-min-ok.log'), '--profile', MIN_PROFILE]);
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const addedOutput = path.join(directory, 'added.json');
  result = run([
    '--detect', '--diff', baseline, '--json', addedOutput,
    '--probe', fixture('probe-min-added.log'), '--profile', MIN_PROFILE,
  ]);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  const added = readJson(addedOutput);
  assert.equal(added.level, 'B');
  const addedDiff = added.diffs.find(item => item.key === 'TER-VIS');
  assert.ok(addedDiff);
  assert.equal(addedDiff.class, 'added');

  const badBaseline = path.join(directory, 'bad-baseline.json');
  result = run(['--record', badBaseline, '--probe', fixture('probe-min-required-bad.log'), '--profile', MIN_PROFILE]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const improvedOutput = path.join(directory, 'improved.json');
  result = run([
    '--detect', '--diff', badBaseline, '--json', improvedOutput,
    '--probe', fixture('probe-min-ok.log'), '--profile', MIN_PROFILE,
  ]);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  const improved = readJson(improvedOutput);
  assert.equal(improved.level, 'B');
  const improvedDiff = improved.diffs.find(item => item.key === 'TER-GH');
  assert.ok(improvedDiff);
  assert.equal(improvedDiff.class, 'improved');
  assert.equal(improvedDiff.before, 'unavailable');
  assert.equal(improvedDiff.after, 'ok');
});

test('conflicting probe runs are flaky and blocked', () => {
  const directory = tempDir();
  const baseline = path.join(directory, 'baseline.json');
  const output = path.join(directory, 'flaky.json');
  let result = run(['--record', baseline, '--probe', fixture('probe-min-ok.log'), '--profile', MIN_PROFILE]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  result = run([
    '--detect', '--diff', baseline, '--json', output,
    '--probe', fixture('probe-min-flaky-a.log'),
    '--probe', fixture('probe-min-flaky-b.log'),
    '--profile', MIN_PROFILE,
  ]);
  assert.equal(result.status, 4, result.stdout + result.stderr);
  const detected = readJson(output);
  assert.equal(detected.level, 'blocked');
  assert.deepEqual(detected.flaky, ['TER-GH']);
  assert.ok(detected.diffs.some(diff => diff.key === 'TER-GH' && diff.class === 'flaky'));
});

test('probe/native/dcs parsers and diff/level helpers are stable', () => {
  const probeText = [
    'CAP,OUTSIDE,ok,ignored',
    'timestamp COMPAT_BEGIN,dcs-1.2.3.4,abc12345',
    'CAP,TER-GH,ok,height=1',
    'CAP,TER-GH,degraded,latest',
    'FACT,note,a\\,b',
    'COMPAT_END,2',
    'CAP,OUTSIDE2,ok,ignored',
  ].join('\n');
  const parsed = cc.parseProbeText(probeText);
  assert.equal(parsed.complete, true);
  assert.equal(parsed.profileId, 'dcs-1.2.3.4');
  assert.equal(parsed.matrixHash, 'abc12345');
  assert.equal(parsed.caps.OUTSIDE, undefined);
  assert.equal(parsed.caps.OUTSIDE2, undefined);
  assert.equal(parsed.caps['TER-GH'].state, 'degraded');
  assert.equal(parsed.facts.note, 'a,b');
  assert.equal(parsed.capCountActual, 1);
  assert.equal(parsed.countMismatch, true);

  const agr = cc.parseNativeText(fs.readFileSync(
    path.join(SAVED_GAMES, 'Logs', 'AESA', 'AGR', 'agradar_native.log'), 'utf8'));
  assert.equal(agr.loaded, 4);
  assert.equal(agr.total, 4);
  assert.equal(agr.surfaceMatch, 16);
  assert.equal(agr.surfaceTotal, 16);
  assert.equal(agr.vtableMatch, true);
  assert.equal(agr.moduleVersions['Inter.dll'], '2.9.30.28738');

  const fc = cc.parseNativeText(fs.readFileSync(
    path.join(SAVED_GAMES, 'Logs', 'AESA', 'fc_native.log'), 'utf8'));
  assert.equal(fc.loaded, 17);
  assert.equal(fc.total, 17);
  assert.equal(fc.moduleVersions['Weapons.dll'], '2.9.30.28738');

  const fcExtra = cc.parseNativeText(fs.readFileSync(fixture('native-fc-extra.log'), 'utf8'));
  assert.equal(fcExtra.traceSites, 13);
  assert.equal(fcExtra.offsetsOk, true);

  const dcs = cc.parseDcsText(fs.readFileSync(
    path.join(SAVED_GAMES, 'Logs', 'dcs.log'), 'utf8'));
  assert.deepEqual(dcs, { build: '2.9.30.28738', variant: 'MT' });

  const before = {
    BUILD: { state: 'ok', detail: '' },
    'EXP-SELF': { state: 'unavailable', detail: '' },
    'TER-GH': { state: 'ok', detail: 'old' },
  };
  const after = {
    BUILD: { state: 'degraded', detail: '' },
    'EXP-SELF': { state: 'ok', detail: '' },
    'TER-GH': { state: 'ok', detail: 'new' },
    'TER-VIS': { state: 'ok', detail: '' },
  };
  const required = new Set(['BUILD', 'EXP-SELF', 'TER-GH']);
  const diffs = cc.diffCaps(before, after, required);
  const byKey = Object.fromEntries(diffs.map(diff => [diff.key, diff]));
  assert.equal(byKey.BUILD.class, 'incompatible');
  assert.equal(byKey['EXP-SELF'].class, 'improved');
  assert.equal(byKey['TER-GH'].class, 'info');
  assert.equal(byKey['TER-VIS'].class, 'added');

  const removedRequired = cc.diffCaps(
    { BUILD: { state: 'ok', detail: '' }, 'TER-GH': { state: 'ok', detail: '' } },
    { BUILD: { state: 'ok', detail: '' } },
    new Set(['BUILD', 'TER-GH'])
  );
  assert.equal(removedRequired.find(item => item.key === 'TER-GH').class, 'incompatible');
  const removedOptional = cc.diffCaps(
    { BUILD: { state: 'ok', detail: '' }, 'TER-VIS': { state: 'degraded', detail: '' } },
    { BUILD: { state: 'ok', detail: '' } },
    new Set(['BUILD'])
  );
  assert.equal(removedOptional.find(item => item.key === 'TER-VIS').class, 'degraded');

  assert.equal(cc.computeLevel({ BUILD: { state: 'ok' } }, ['BUILD']), 'A');
  assert.equal(cc.computeLevel({ BUILD: { state: 'degraded' } }, ['BUILD']), 'C');
  assert.equal(cc.computeLevel({ BUILD: { state: 'unknown' } }, ['BUILD']), 'blocked');
  assert.equal(cc.computeLevel({ BUILD: { state: 'ok' }, X: { state: 'degraded' } }, ['BUILD']), 'B');
});

test('usage and input errors exit 1', () => {
  let result = run(['--unknown']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown argument/);

  result = run(['--record', '--detect']);
  assert.equal(result.status, 1);

  result = run(['--detect', '--profile', path.join(FIXTURES, 'missing.json')]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot read JSON/);

  result = run(['--detect', '--probe', path.join(FIXTURES, 'missing.log')]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /probe path not found/);

  result = run(['--detect', '--diff', path.join(FIXTURES, 'missing-baseline.json')]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /baseline not found/);
});

test('detect without --diff/--json prints stable JSON and uses the level exit code', () => {
  const result = run(['--detect', '--probe', fixture('probe-min-ok.log'), '--profile', MIN_PROFILE]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.level, 'A');
  assert.equal(parsed.profile_id, 'dcs-1.2.3.4');
  assert.equal(parsed.matrix_hash, '2997d797');
  assert.deepEqual(Object.keys(parsed.caps), [...Object.keys(parsed.caps)].sort());
});

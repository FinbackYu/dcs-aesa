'use strict';
// Gate 6 static guards for the native read/write split (D4).
// These checks run against the built PE exports and the shipped sources; they
// fail if a trace build ever grows a write export or the hook stops selecting
// the trace DLL by default.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const common = require('../scripts/build_common.cjs');
const build = require('../scripts/build_fc_probe.cjs');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(ROOT, 'src', 'hooks', 'aesa_fc_hook.lua');

test('trace DLL exports the read-only set and no write export', () => {
  assert.ok(fs.existsSync(build.TRACE), 'build the native DLLs first: node scripts/build_fc_probe.cjs');
  const exports = common.exportsOf(build.TRACE);
  for (const name of build.TRACE_REQUIRED) assert.ok(exports.includes(name), `trace missing ${name}`);
  for (const name of build.WRITE_EXPORTS) assert.ok(!exports.includes(name), `trace leaked ${name}`);
});

test('inject DLL is a trace superset with all write exports', () => {
  assert.ok(fs.existsSync(build.INJECT), 'build the native DLLs first: node scripts/build_fc_probe.cjs');
  const exports = common.exportsOf(build.INJECT);
  for (const name of build.INJECT_REQUIRED) assert.ok(exports.includes(name), `inject missing ${name}`);
});

test('both FC DLLs keep the kernel32/msvcrt/version-only dependency set', () => {
  for (const file of [build.TRACE, build.INJECT]) {
    if (!fs.existsSync(file)) continue;
    assert.doesNotThrow(() => common.assertDependencies(file));
  }
});

test('one C source owns both builds behind AESA_FC_TRACE_ONLY', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'native', 'fc_probe', 'aesa_fc.c'), 'utf8');
  assert.match(source, /#ifdef AESA_FC_TRACE_ONLY/);
  assert.match(source, /#ifndef AESA_FC_TRACE_ONLY/);
  // native.load() resolves the version symbol before init binds the Lua API;
  // version must bind it itself or the first caller gets no string.
  const version = source.slice(source.indexOf('FC_EXPORT aesa_fc_version'));
  assert.match(version.slice(0, 400), /bind_lua\(\)/);
  // The write exports and the two detour rewrites must sit inside guards.
  const guarded = source.slice(source.indexOf('#ifndef AESA_FC_TRACE_ONLY'));
  assert.match(guarded, /aesa_fc_arm/);
  assert.match(guarded, /aesa_fc_feed_target/);
});

test('hook selects trace by default and inject only behind the write gate', () => {
  const hook = fs.readFileSync(HOOK, 'utf8');
  assert.match(hook, /aesa_fc_trace\.dll/);
  assert.match(hook, /aesa_fc_inject\.dll/);
  assert.ok(!hook.includes('Scripts\\\\AESA-FC\\\\aesa_fc.dll') || hook.includes('legacy'),
    'the hook must not load the legacy single DLL');
  assert.match(hook, /inject_refusal/);
  assert.match(hook, /native\.fc\.write/);
  assert.match(hook, /native\.fc\.inject_exports/);
  assert.match(hook, /native\.fc\.trace_exports/);
});

test('generated profile carries distinct trace and inject export lists', () => {
  const profile = fs.readFileSync(path.join(ROOT, 'src', 'adapters', 'dcs', 'compat', 'profiles',
    'dcs-2.9.30.28738-mt.lua'), 'utf8');
  assert.match(profile, /trace_exports = \{/);
  assert.match(profile, /inject_exports = \{/);
  assert.match(profile, /"aesa_fc_readable"/);
  assert.match(profile, /"aesa_fc_feed_target"/);
  assert.match(profile, /write = true/);
});

test('AGR profile check runs after init and defers before terrain exists', () => {
  const hook = fs.readFileSync(path.join(ROOT, 'src', 'hooks', 'aesa_agradar_hook.lua'), 'utf8');
  const init = hook.indexOf('pcall(init, base .. "Logs\\\\AESA\\\\AGR")');
  const check = hook.indexOf('got.aesa_agradar_profile_check');
  assert.ok(init >= 0, 'AGR init call missing');
  assert.ok(check > init, 'profile check must run after init (symbols resolved)');
  assert.match(hook, /value == -1/, 'engine-not-ready must be a distinct retry state');

  const source = fs.readFileSync(path.join(ROOT, 'src', 'native', 'agradar_probe', 'aesa_agradar.c'), 'utf8');
  const block = source.slice(source.indexOf('AGR_EXPORT aesa_agradar_profile_check'));
  assert.match(block.slice(0, 400), /int ok = -1/);
});

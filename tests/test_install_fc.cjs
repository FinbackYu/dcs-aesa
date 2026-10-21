'use strict';
// Gate 6: FC deployment lifecycle on a temporary Saved Games fixture.
// Covers trace-only default, explicit inject, repair, uninstall, foreign-file
// preservation, the DCS-running guard and legacy aesa_fc.dll migration.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { deploy, paths } = require('../scripts/install_fc_probe.cjs');
const { hash } = require('../scripts/install_common.cjs');

const lua = process.env.AESA_LUA;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aesa-fc-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, p: paths(root) };
}

test('Default install is trace-only; verify/repair/uninstall roundtrip', { skip: !lua && 'Set AESA_LUA to run Lua 5.1 integration' }, t => {
  const { root, p } = fixture(t);
  const opts = { lua, running: false };
  fs.mkdirSync(path.join(root, 'Scripts', 'Hooks'), { recursive: true });
  const foreign = path.join(root, 'Scripts', 'Hooks', 'other.lua');
  fs.writeFileSync(foreign, '-- other hook');

  deploy(root, 'install', opts);
  assert.ok(fs.existsSync(p.hook));
  assert.ok(fs.existsSync(p.trace));
  assert.ok(!fs.existsSync(p.inject), 'default install must not deploy inject');
  assert.ok(!fs.existsSync(p.legacy), 'default install must not deploy the legacy DLL');
  const hook = fs.readFileSync(p.hook, 'utf8');
  assert.match(hook, /aesa_fc_trace\.dll/);
  assert.match(hook, /aesa_fc_inject\.dll/);
  assert.match(hook, /AESA_RUNTIME = \{/);

  let manifest = JSON.parse(fs.readFileSync(p.manifest, 'utf8'));
  assert.equal(manifest.schema, 2);
  assert.equal(manifest.variant, 'trace');
  assert.equal(manifest.inject_hash, null);
  assert.equal(manifest.trace_hash, hash(fs.readFileSync(p.trace)));
  assert.equal(manifest.hook_hash, hash(fs.readFileSync(p.hook)));

  deploy(root, 'verify', opts);
  deploy(root, 'repair', opts);
  assert.deepEqual(fs.readFileSync(p.hook), Buffer.from(hook));
  deploy(root, 'uninstall', opts);
  assert.ok(!fs.existsSync(p.hook));
  assert.ok(!fs.existsSync(p.trace));
  assert.ok(!fs.existsSync(p.manifest));
  assert.equal(fs.readFileSync(foreign, 'utf8'), '-- other hook');
  assert.ok(fs.existsSync(p.trace + '.bak-aesa'), 'pre-uninstall trace backup expected');
});

test('Explicit inject deploys both DLLs and switching back to trace removes inject', { skip: !lua && 'Set AESA_LUA to run Lua 5.1 integration' }, t => {
  const { root, p } = fixture(t);
  const opts = { lua, running: false };
  deploy(root, 'install', { ...opts, withInject: true });
  assert.ok(fs.existsSync(p.trace));
  assert.ok(fs.existsSync(p.inject));
  let manifest = JSON.parse(fs.readFileSync(p.manifest, 'utf8'));
  assert.equal(manifest.variant, 'trace+inject');
  assert.equal(manifest.inject_hash, hash(fs.readFileSync(p.inject)));
  deploy(root, 'verify', opts);

  deploy(root, 'install', opts); // trace only
  assert.ok(!fs.existsSync(p.inject), 'trace-only repair must remove the owned inject DLL');
  manifest = JSON.parse(fs.readFileSync(p.manifest, 'utf8'));
  assert.equal(manifest.variant, 'trace');
  assert.equal(manifest.inject_hash, null);
});

test('DCS-running guard refuses install/repair/uninstall without mutations', { skip: !lua && 'Set AESA_LUA to run Lua 5.1 integration' }, t => {
  const { root, p } = fixture(t);
  const ok = { lua, running: false };
  assert.throws(() => deploy(root, 'install', { lua, running: true }), /DCS is running/);
  assert.ok(!fs.existsSync(p.hook));
  deploy(root, 'install', ok);
  const before = fs.readFileSync(p.hook);
  assert.throws(() => deploy(root, 'repair', { lua, running: true }), /DCS is running/);
  assert.throws(() => deploy(root, 'uninstall', { lua, running: true }), /DCS is running/);
  assert.deepEqual(fs.readFileSync(p.hook), before);
  deploy(root, 'verify', { lua, running: true }); // verify stays read-only
});

test('Unknown or modified files are never overwritten or removed', { skip: !lua && 'Set AESA_LUA to run Lua 5.1 integration' }, t => {
  const { root, p } = fixture(t);
  const opts = { lua, running: false };
  fs.mkdirSync(path.dirname(p.trace), { recursive: true });
  fs.writeFileSync(p.trace, 'not our dll');
  assert.throws(() => deploy(root, 'install', opts), /Unknown or modified/);
  assert.equal(fs.readFileSync(p.trace, 'utf8'), 'not our dll');

  fs.rmSync(p.trace);
  deploy(root, 'install', opts);
  fs.appendFileSync(p.trace, 'local edit');
  for (const action of ['repair', 'uninstall']) {
    assert.throws(() => deploy(root, action, opts), /Unknown or modified/);
  }
  assert.ok(fs.existsSync(p.manifest), 'manifest must survive a refused uninstall');
});

test('Legacy aesa_fc.dll manifest is migrated, backed up and removed', { skip: !lua && 'Set AESA_LUA to run Lua 5.1 integration' }, t => {
  const { root, p } = fixture(t);
  const opts = { lua, running: false };
  fs.mkdirSync(path.dirname(p.legacy), { recursive: true });
  fs.writeFileSync(p.legacy, 'legacy probe bytes');
  const legacyManifest = {
    schema: 1,
    product: 'aesa-fc-probe',
    hook_hash: hash(Buffer.from('legacy hook')),
    dll_hash: hash(Buffer.from('legacy probe bytes')),
    sources: ['dist/dev/aesa_fc.dll (built from src/native/fc_probe/aesa_fc.c)'],
    files: ['Scripts/Hooks/aesa_fc_hook.lua', 'Scripts/AESA-FC/aesa_fc.dll', 'Scripts/AESA-FC/fc-manifest.json'],
  };
  fs.writeFileSync(p.manifest, JSON.stringify(legacyManifest, null, 2) + '\n');

  deploy(root, 'install', opts);
  assert.ok(!fs.existsSync(p.legacy), 'legacy DLL must be removed after migration');
  assert.ok(fs.existsSync(p.legacy + '.bak-aesa'), 'legacy DLL must be backed up first');
  assert.ok(fs.existsSync(p.trace));
  const manifest = JSON.parse(fs.readFileSync(p.manifest, 'utf8'));
  assert.equal(manifest.schema, 2);
  assert.equal(manifest.variant, 'trace');
});

test('Untracked legacy DLL without a manifest is refused', { skip: !lua && 'Set AESA_LUA to run Lua 5.1 integration' }, t => {
  const { root, p } = fixture(t);
  fs.mkdirSync(path.dirname(p.legacy), { recursive: true });
  fs.writeFileSync(p.legacy, 'unknown');
  assert.throws(() => deploy(root, 'install', { lua, running: false }), /Unknown or modified legacy/);
  assert.equal(fs.readFileSync(p.legacy, 'utf8'), 'unknown');
});

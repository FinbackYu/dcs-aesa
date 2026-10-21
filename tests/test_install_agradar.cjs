'use strict';
// Gate 6: AGR deployment lifecycle on a temporary Saved Games fixture.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { deploy, paths, BAK } = require('../scripts/install_agradar_probe.cjs');
const { hash } = require('../scripts/install_common.cjs');

const lua = process.env.AESA_LUA;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aesa-agr-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, p: paths(root) };
}

test('Install/verify/repair/uninstall on a temporary Saved Games fixture', { skip: !lua && 'Set AESA_LUA to run Lua 5.1 integration' }, t => {
  const { root, p } = fixture(t);
  const opts = { lua, running: false };
  fs.mkdirSync(path.join(root, 'Scripts', 'Hooks'), { recursive: true });
  const foreign = path.join(root, 'Scripts', 'Hooks', 'other.lua');
  fs.writeFileSync(foreign, '-- other hook');

  deploy(root, 'install', opts);
  assert.ok(fs.existsSync(p.hook));
  assert.ok(fs.existsSync(p.dll));
  const manifest = JSON.parse(fs.readFileSync(p.manifest, 'utf8'));
  assert.equal(manifest.product, 'aesa-agradar-probe');
  assert.equal(manifest.hook_hash, hash(fs.readFileSync(p.hook)));
  assert.equal(manifest.dll_hash, hash(fs.readFileSync(p.dll)));

  deploy(root, 'verify', opts);
  deploy(root, 'repair', opts);
  const status = deploy(root, 'status', {});
  assert.equal(status.installed, true);
  assert.equal(status.verified, true);
  assert.equal(status.current, true);

  deploy(root, 'uninstall', opts);
  assert.ok(!fs.existsSync(p.hook));
  assert.ok(!fs.existsSync(p.dll));
  assert.ok(!fs.existsSync(p.manifest));
  assert.equal(fs.readFileSync(foreign, 'utf8'), '-- other hook');
  assert.ok(fs.existsSync(p.dll + BAK), 'pre-uninstall DLL backup expected');
});

test('DCS-running guard refuses mutation; verify stays read-only', { skip: !lua && 'Set AESA_LUA to run Lua 5.1 integration' }, t => {
  const { root, p } = fixture(t);
  const opts = { lua, running: false };
  assert.throws(() => deploy(root, 'install', { lua, running: true }), /DCS is running/);
  assert.ok(!fs.existsSync(p.hook));
  deploy(root, 'install', opts);
  assert.throws(() => deploy(root, 'repair', { lua, running: true }), /DCS is running/);
  assert.throws(() => deploy(root, 'uninstall', { lua, running: true }), /DCS is running/);
  deploy(root, 'verify', { lua, running: true });
});

test('Modified and unknown DLLs are never overwritten or removed', { skip: !lua && 'Set AESA_LUA to run Lua 5.1 integration' }, t => {
  const { root, p } = fixture(t);
  const opts = { lua, running: false };
  fs.mkdirSync(path.dirname(p.dll), { recursive: true });
  fs.writeFileSync(p.dll, 'unknown');
  assert.throws(() => deploy(root, 'install', opts), /Unknown or modified/);
  assert.equal(fs.readFileSync(p.dll, 'utf8'), 'unknown');

  fs.rmSync(p.dll);
  deploy(root, 'install', opts);
  fs.appendFileSync(p.dll, 'edit');
  assert.throws(() => deploy(root, 'uninstall', opts), /Unknown or modified/);
  assert.ok(fs.existsSync(p.manifest));
});

'use strict';
// AESA fire-control probe deployment (development-only, Saved Games side).
//
// Gate 6 (D4) default: deploy the read-only trace DLL only.
//   --with-inject additionally deploys aesa_fc_inject.dll; the hook still
//   loads it only when fc_experiment.lua says mode=1 and the generated profile
//   passes. The old single aesa_fc.dll is recognized as a legacy deployment,
//   backed up and removed; unknown files are never overwritten or deleted.
const fs = require('node:fs');
const path = require('node:path');
const common = require('./install_common.cjs');
const runtime = require('./build_runtime.cjs');
const { hash, backup, transaction } = common;

const base = path.join(__dirname, '..');
const TRACE = path.join(base, 'dist', 'dev', 'aesa_fc_trace.dll');
const INJECT = path.join(base, 'dist', 'dev', 'aesa_fc_inject.dll');
const PRODUCT = 'aesa-fc-probe';
const BUNDLE_HINT = 'FC hook bundle could not be built; run node scripts/build_runtime.cjs fc_hook';

function paths(root) {
  return {
    hook: path.join(root, 'Scripts/Hooks/aesa_fc_hook.lua'),
    trace: path.join(root, 'Scripts/AESA-FC/aesa_fc_trace.dll'),
    inject: path.join(root, 'Scripts/AESA-FC/aesa_fc_inject.dll'),
    legacy: path.join(root, 'Scripts/AESA-FC/aesa_fc.dll'),
    manifest: path.join(root, 'Scripts/AESA-FC/fc-manifest.json'),
  };
}

function readManifest(file) {
  if (!fs.existsSync(file)) return null;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!data || data.product !== PRODUCT || data.schema !== 1 && data.schema !== 2) {
    throw Error('Invalid FC probe manifest');
  }
  if (typeof data.hook_hash !== 'string' || !common.HEX64.test(data.hook_hash)) {
    throw Error('Invalid FC probe manifest (hook_hash)');
  }
  if (data.schema === 1) {
    if (typeof data.dll_hash !== 'string' || !common.HEX64.test(data.dll_hash)) {
      throw Error('Invalid legacy FC probe manifest (dll_hash)');
    }
    return { ...data, legacy: true };
  }
  for (const key of ['trace_hash', 'inject_hash']) {
    if (data[key] !== null && data[key] !== undefined && !common.HEX64.test(data[key])) {
      throw Error(`Invalid FC probe manifest (${key})`);
    }
  }
  if (!common.HEX64.test(data.trace_hash || '')) {
    throw Error('Invalid FC probe manifest (trace_hash)');
  }
  return data;
}

// The deployed hook is the built runtime bundle, not the source template.
function hookPayload() {
  const built = runtime.build('fc_hook');
  if (!built || typeof built.text !== 'string' || !built.text.includes('AESA_RUNTIME')) {
    throw Error(BUNDLE_HINT);
  }
  return Buffer.from(built.text);
}

function requireBuilt(file, hint) {
  if (!fs.existsSync(file)) throw Error(`${hint}; run node scripts/build_fc_probe.cjs first`);
  return fs.readFileSync(file);
}

function owned(file, expected, label) {
  if (fs.existsSync(file) && (!expected || hash(fs.readFileSync(file)) !== expected)) {
    throw Error(`Unknown or modified ${label}; no overwrite/removal`);
  }
}

function statusOf(root) {
  const p = paths(root);
  const m = readManifest(p.manifest);
  const trace = common.read(p.trace);
  const inject = common.read(p.inject);
  const hook = common.read(p.hook);
  const legacy = common.read(p.legacy);
  const installed = !!(m && hook && trace);
  const verified = installed
    && hash(hook) === m.hook_hash
    && hash(trace) === m.trace_hash
    && (m.inject_hash ? !!(inject && hash(inject) === m.inject_hash) : !inject);
  const currentHook = hash(hookPayload());
  const currentTrace = fs.existsSync(TRACE) ? hash(fs.readFileSync(TRACE)) : null;
  const currentInject = fs.existsSync(INJECT) ? hash(fs.readFileSync(INJECT)) : null;
  const current = installed
    && hash(hook) === currentHook
    && hash(trace) === currentTrace
    && (m.inject_hash ? !!inject && hash(inject) === currentInject : !inject);
  return { paths: p, manifest: m, installed, verified, current, legacy: !!legacy, variant: m ? (m.inject_hash ? 'trace+inject' : 'trace') : null };
}

function deploy(root, action, { lua = process.env.AESA_LUA || 'lua', running, withInject = false } = {}) {
  root = common.requireDirectory(root);
  const p = paths(root);
  const m = readManifest(p.manifest);
  owned(p.hook, m && m.hook_hash, 'FC hook');
  if (m && m.legacy) owned(p.legacy, m.dll_hash, 'legacy FC DLL');
  else owned(p.legacy, null, 'legacy FC DLL');
  owned(p.trace, m && m.trace_hash, 'FC trace DLL');
  owned(p.inject, m && m.inject_hash, 'FC inject DLL');

  if (action === 'status') {
    return statusOf(root);
  }

  if (action === 'verify') {
    const status = statusOf(root);
    if (!status.installed) throw Error('FC probe is not installed');
    if (!status.verified) throw Error('FC probe files differ from manifest; run repair');
    if (!status.current) throw Error('FC probe differs from current sources/build; run repair');
    return p;
  }

  if (action === 'uninstall') {
    if (!m && !fs.existsSync(p.hook) && !fs.existsSync(p.trace)
        && !fs.existsSync(p.inject) && !fs.existsSync(p.legacy)) {
      return p;
    }
    common.ensureDcsClosed({ running });
    const changes = [];
    const ownedFiles = [];
    if (m && m.legacy) ownedFiles.push([p.legacy, m.dll_hash]);
    if (m && m.trace_hash) ownedFiles.push([p.trace, m.trace_hash]);
    if (m && m.inject_hash) ownedFiles.push([p.inject, m.inject_hash]);
    for (const [file, expected] of ownedFiles) {
      if (fs.existsSync(file) && hash(fs.readFileSync(file)) !== expected) {
        throw Error('Modified FC DLL; no removal: ' + file);
      }
    }
    for (const file of [p.hook, p.trace, p.inject, p.legacy, p.manifest]) {
      if (fs.existsSync(file)) backup(file);
    }
    changes.push([p.hook, null], [p.trace, null], [p.inject, null], [p.legacy, null], [p.manifest, null]);
    transaction(changes);
    return p;
  }

  if (!['install', 'repair'].includes(action)) throw Error('Unknown action');

  const hook = hookPayload();
  const trace = requireBuilt(TRACE, 'FC trace DLL not built');
  if (withInject && !fs.existsSync(INJECT)) {
    throw Error('FC inject DLL not built; run node scripts/build_fc_probe.cjs first');
  }
  const inject = withInject ? fs.readFileSync(INJECT) : null;
  common.ensureDcsClosed({ running });
  common.syntaxText(lua, hook, 'fc-hook');

  // A legacy manifest/file pair is migrated only after its old hash checks out.
  if (!m && fs.existsSync(p.legacy)) {
    throw Error('Unknown legacy aesa_fc.dll; no overwrite/removal');
  }
  if (m && m.legacy && fs.existsSync(p.legacy) && hash(fs.readFileSync(p.legacy)) !== m.dll_hash) {
    throw Error('Modified legacy aesa_fc.dll; no overwrite/removal');
  }

  const record = {
    schema: 2,
    product: PRODUCT,
    variant: inject ? 'trace+inject' : 'trace',
    hook_hash: hash(hook),
    trace_hash: hash(trace),
    inject_hash: inject ? hash(inject) : null,
    sources: [
      'dist/dev/aesa_fc_hook.lua (built from src/hooks/aesa_fc_hook.lua)',
      'dist/dev/aesa_fc_trace.dll (built from src/native/fc_probe/aesa_fc.c with AESA_FC_TRACE_ONLY)',
      ...(inject ? ['dist/dev/aesa_fc_inject.dll (built from src/native/fc_probe/aesa_fc.c)'] : []),
    ],
    files: [
      'Scripts/Hooks/aesa_fc_hook.lua',
      'Scripts/AESA-FC/aesa_fc_trace.dll',
      ...(inject ? ['Scripts/AESA-FC/aesa_fc_inject.dll'] : []),
      'Scripts/AESA-FC/fc-manifest.json',
    ],
  };

  for (const file of [p.hook, p.trace, p.inject, p.legacy, p.manifest]) {
    if (fs.existsSync(file)) backup(file);
  }
  const changes = [];
  if (m && m.legacy) changes.push([p.legacy, null]);
  changes.push([p.trace, trace], [p.hook, hook]);
  if (inject) changes.push([p.inject, inject]);
  else if (fs.existsSync(p.inject) && (!m || m.inject_hash)) changes.push([p.inject, null]);
  changes.push([p.manifest, Buffer.from(JSON.stringify(record, null, 2) + '\n')]);
  transaction(changes);
  return deploy(root, 'verify', { lua, running, withInject });
}

module.exports = { deploy, paths, statusOf, PRODUCT, TRACE, INJECT };
if (require.main === module) {
  const args = process.argv.slice(2);
  const action = args.shift() || 'status';
  let root;
  const options = { withInject: false };
  try {
    while (args.length) {
      const key = args.shift();
      if (key === '--with-inject') {
        options.withInject = true;
        continue;
      }
      const value = args.shift();
      if (!value || !['--saved-games', '--lua'].includes(key)) {
        throw Error('Usage: install_fc_probe.cjs install|repair|uninstall|verify|status --saved-games <directory> [--lua <Lua 5.1 executable>] [--with-inject]');
      }
      if (key === '--saved-games') root = value;
      else options.lua = value;
    }
    if (!root) throw Error('--saved-games required');
    const result = deploy(root, action, options);
    if (action === 'status') console.log(JSON.stringify(result, null, 2));
    else console.log('FC probe ' + action + ' complete. Restart DCS to reload Hooks.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

'use strict';
// Dev-only installer for the one-file DCS compatibility probe.
// It writes only under Saved Games, keeps a manifest/backups, and adds a
// separate marker block to Export.lua. It never touches the DCS install.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { hash, backup, transaction, syntax } = require('./install_common.cjs');
const { write: buildBundle, OUTPUT } = require('./build_compat_probe.cjs');

const PRODUCT = 'aesa-compat-probe';
const BEGIN = '--[[ AESA COMPAT PROBE BEGIN ]]';
const END = '--[[ AESA COMPAT PROBE END ]]';
const BLOCK = `${BEGIN}
pcall(function()
    local fsapi = require("lfs")
    local root = fsapi.writedir() .. [[Scripts\\AESA\\]]
    local entry = dofile(root .. "aesa_compat_probe.lua")
    entry.install_export(root)
end)
${END}`;

function paths(root) {
  return {
    script: path.join(root, 'Scripts', 'AESA', 'aesa_compat_probe.lua'),
    manifest: path.join(root, 'Scripts', 'AESA', 'compat-probe-manifest.json'),
    export: path.join(root, 'Scripts', 'Export.lua'),
  };
}

function read(file) {
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

function span(raw) {
  if (!raw) return null;
  const beginToken = Buffer.from(BEGIN);
  const endToken = Buffer.from(END);
  const begin = raw.indexOf(beginToken);
  const end = raw.indexOf(endToken);
  if (begin < 0 && end < 0) return null;
  if (begin < 0 || end < begin) throw Error('AESA COMPAT PROBE markers are incomplete');
  if (raw.indexOf(beginToken, begin + beginToken.length) >= 0
    || raw.indexOf(endToken, end + endToken.length) >= 0) {
    throw Error('AESA COMPAT PROBE markers are duplicated');
  }
  const after = end + endToken.length;
  const lineEnd = raw.indexOf(0x0a, after);
  return [begin, lineEnd < 0 ? raw.length : lineEnd + 1];
}

function manifest(file) {
  if (!fs.existsSync(file)) return null;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (data.product !== PRODUCT || data.schema !== 1
    || !/^[a-f0-9]{64}$/.test(data.script_hash)
    || !/^[a-f0-9]{64}$/.test(data.export_hash)
    || typeof data.export_before !== 'string'
    || Buffer.from(data.export_before, 'base64').toString('base64') !== data.export_before) {
    throw Error('Invalid compat-probe manifest; no files changed');
  }
  return data;
}

function blockFor(raw) {
  const nl = raw.includes('\r\n') ? '\r\n' : '\n';
  return BLOCK.replace(/\n/g, nl) + nl;
}

function deploy(root, action, options = {}) {
  root = path.resolve(root);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw Error('Saved Games target must be an existing directory');
  }
  const p = paths(root);
  const raw = read(p.export) || Buffer.alloc(0);
  const current = span(raw);
  const m = manifest(p.manifest);
  const lua = options.lua || process.env.AESA_LUA || 'lua';

  if (fs.existsSync(p.script) && !m) {
    throw Error('Scripts/AESA/aesa_compat_probe.lua exists without a manifest; refusing overwrite');
  }
  if (m && fs.existsSync(p.script) && hash(fs.readFileSync(p.script)) !== m.script_hash) {
    throw Error('compat probe script was modified; refusing overwrite/removal');
  }

  if (action === 'status' || action === 'verify') {
    const installed = !!m && !!current && fs.existsSync(p.script);
    if (action === 'verify' && !installed) throw Error('compat probe is not installed');
    return { installed, paths: p, script_hash: m ? m.script_hash : null };
  }

  if (action === 'uninstall') {
    if (!m && !current && !fs.existsSync(p.script)) return p;
    let baseline;
    if (m && hash(raw) === m.export_hash) {
      baseline = Buffer.from(m.export_before, 'base64');
    } else {
      const s = current;
      baseline = s
        ? Buffer.concat([raw.subarray(0, s[0]), raw.subarray(s[1])])
        : raw;
    }
    backup(p.export);
    backup(p.script);
    backup(p.manifest);
    transaction([
      [p.export, baseline.length ? baseline : null],
      [p.script, null],
      [p.manifest, null],
    ]);
    return p;
  }

  if (!['install', 'repair'].includes(action)) throw Error('Expected install|repair|verify|status|uninstall');

  const built = buildBundle();
  if (built.lua.checked && !built.lua.ok) throw Error(`Lua 5.1 syntax check failed: ${built.lua.reason}`);
  const payload = Buffer.from(built.text);
  const s = current;
  const baseline = s
    ? Buffer.concat([raw.subarray(0, s[0]), raw.subarray(s[1])])
    : raw;
  const nl = raw.includes(Buffer.from('\r\n')) ? '\r\n' : '\n';
  const separator = baseline.length && !baseline.toString('utf8').endsWith('\n') ? nl : '';
  const exportAfter = Buffer.concat([
    baseline,
    Buffer.from(separator + blockFor(raw)),
  ]);
  const record = {
    product: PRODUCT,
    schema: 1,
    sources: [
      'src/adapters/dcs/api/export.lua',
      'src/adapters/dcs/api/hook.lua',
      'src/adapters/dcs/api/native.lua',
      'src/adapters/dcs/compat/profile.lua',
      'src/adapters/dcs/compat/probe.lua',
      'src/adapters/dcs/compat/profiles/dcs-2.9.30.28738-mt.lua',
      'src/adapters/dcs/compat/entry_bundle.lua',
    ],
    script_hash: hash(payload),
    export_hash: hash(exportAfter),
    export_before: baseline.toString('base64'),
    files: [
      'Scripts/Export.lua',
      'Scripts/AESA/aesa_compat_probe.lua',
      'Scripts/AESA/compat-probe-manifest.json',
    ],
  };

  backup(p.export);
  backup(p.script);
  backup(p.manifest);
  syntax(lua, OUTPUT);
  transaction([
    [p.script, payload],
    [p.export, exportAfter],
    [p.manifest, Buffer.from(JSON.stringify(record, null, 2) + '\n')],
  ]);
  return deploy(root, 'verify', { lua });
}

module.exports = { PRODUCT, BEGIN, END, BLOCK, paths, span, deploy };

if (require.main === module) {
  const args = process.argv.slice(2);
  const action = args.shift() || 'status';
  let root;
  const options = {};
  try {
    while (args.length) {
      const key = args.shift();
      const value = args.shift();
      if (!value || !['--saved-games', '--lua'].includes(key)) {
        throw Error('Usage: install_compat_probe.cjs install|repair|verify|status|uninstall --saved-games <dir> [--lua <Lua 5.1>]');
      }
      if (key === '--saved-games') root = value;
      else options.lua = value;
    }
    if (!root) throw Error('--saved-games is required');
    const result = deploy(root, action, options);
    console.log(`compat probe ${action}: ${path.resolve(root)}`);
    if (result && result.script_hash) console.log(`script sha256: ${result.script_hash}`);
    console.log('Restart DCS to reload Export/Hooks.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

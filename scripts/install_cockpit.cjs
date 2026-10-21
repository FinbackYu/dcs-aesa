'use strict';
// Development-only F-16C cockpit page installer (C0).
// This is the first 3b deep-integration step: it backs up the two official
// files it patches, refuses unknown/modified targets, and restores exactly
// what it replaced. It never touches Saved Games or the user's Export.lua.
const fs = require('node:fs');
const path = require('node:path');
const common = require('./install_common.cjs');

const PRODUCT = 'aesa-cockpit-c0';
const MARK = 'AESA_COCKPIT_C0';
const BEGIN = `-- BEGIN ${MARK}`;
const END = `-- END ${MARK}`;
const AESA_DEVICE_ID = 240;

// Every AESA_* cockpit parameter, declared from the device_init.lua block
// before devices and indicator pages are constructed on worker threads: a
// name first created from the running device can bind too late on the page
// side (the C1.5 "stuck on defaults" defect; F16V parameters.lua pattern).
// Mirrors the load-time predeclaration in controller.lua;
// tests/test_cockpit_page.cjs pins both lists equal.
const AESA_PARAMS = [
  'AESA_MODE', 'AESA_RANGE', 'AESA_RANGE_UP', 'AESA_RANGE_DOWN',
  'AESA_AZ', 'AESA_BARS', 'AESA_WPN', 'AESA_HINT',
  'AESA_BEAM_X', 'AESA_BEAM_EL', 'AESA_PITCH', 'AESA_ROLL', 'AESA_SCAN_LIM',
  'AESA_CUR_X', 'AESA_CUR_Y', 'AESA_CUR_MAX', 'AESA_CUR_MIN', 'AESA_CUR_BRG',
  'AESA_STT_SHOW', 'AESA_STT_ASPECT', 'AESA_STT_TRK', 'AESA_STT_CAS', 'AESA_STT_CLOSE',
];
for (let i = 1; i <= 8; i++) {
  for (const suffix of ['_SHOW', '_STATUS', '_X', '_Y', '_HDG', '_ALT', '_TUC', '_HOT']) {
    AESA_PARAMS.push(`AESA_TRK_${i}${suffix}`);
  }
}

function aesaParamsLua() {
  const lines = [];
  for (let i = 0; i < AESA_PARAMS.length; i += 6) {
    lines.push('    ' + AESA_PARAMS.slice(i, i + 6).map((n) => `'${n}'`).join(', '));
  }
  return lines.join(',\n');
}

const PAGE = path.join(__dirname, '..', 'src', 'adapters', 'dcs', 'cockpit', 'page', 'MFD_FCR_AESA_AA.lua');
const CONTROLLER = path.join(__dirname, '..', 'src', 'adapters', 'dcs', 'cockpit', 'controller.lua');

function paths(root) {
  const scripts = path.join(root, 'Mods', 'aircraft', 'F-16C', 'Cockpit', 'Scripts');
  return {
    scripts,
    pages: path.join(scripts, 'Displays', 'MFD', 'indicator', 'MFD_Pages_Init.lua'),
    device: path.join(scripts, 'device_init.lua'),
    controller: path.join(scripts, 'AESA', 'controller.lua'),
    page: path.join(scripts, 'Displays', 'MFD', 'indicator', 'Pages', 'FCR', 'MFD_FCR_AESA_AA.lua'),
    manifest: path.join(scripts, 'AESA', 'manifest.json'),
  };
}

function lf(text) { return text.replace(/\r\n/g, '\n'); }
function eolOf(text) { return text.includes('\r\n') ? '\r\n' : '\n'; }

function insertAfterLine(raw, anchor, block, label) {
  const original = raw.toString('utf8');
  if (original.includes(block)) return raw;
  const eol = eolOf(original);
  const text = original.replace(/\r\n/g, '\n');
  const index = text.indexOf(anchor);
  if (index < 0 || text.indexOf(anchor, index + 1) >= 0) {
    throw Error(`Cannot find a unique ${label} anchor; no files changed`);
  }
  const lineEnd = text.indexOf('\n', index);
  if (lineEnd < 0) throw Error(`Cannot find end of ${label} anchor line; no files changed`);
  const at = lineEnd + 1;
  const insertion = block + '\n';
  return Buffer.from((text.slice(0, at) + insertion + text.slice(at)).replace(/\n/g, eol), 'utf8');
}

function removeBlock(raw, label) {
  const text = raw.toString('utf8');
  const b = text.indexOf(BEGIN), e = text.indexOf(END);
  if (b < 0 && e < 0) return raw;
  if (b < 0 || e < 0 || b >= e || text.indexOf(BEGIN, b + 1) >= 0 || text.indexOf(END, e + 1) >= 0) {
    throw Error(`Incomplete or duplicated ${label} markers; preserve files and inspect backups`);
  }
  let stop = e + END.length;
  if (text[stop] === '\r') stop++;
  if (text[stop] === '\n') stop++;
  let start = b;
  // The block is inserted with its own leading newline. Remove that newline
  // when the marker is at a line boundary, but not a preceding line's content.
  if (start > 0 && text[start - 1] === '\n') {
    start--;
    if (start > 0 && text[start - 1] === '\r') start--;
  }
  return Buffer.from(text.slice(0, start) + text.slice(stop), 'utf8');
}

const DECL = `${BEGIN}
local SUBSET_AESA_AA = counter()
${END}`;

const OVERRIDE = `${BEGIN}
page_subsets[SUBSET_AESA_AA] = PagesPath.."FCR/MFD_FCR_AESA_AA.lua"
pages[PAGE_FCR_AA] = {SUBSET_BASE, SUBSET_AESA_AA, SUBSET_BASE_MENU, SUBSET_SOI}
${END}`;

const DEVICE = `${BEGIN}
if devices.AESA then
    error("AESA cockpit device ID collision: "..tostring(devices.AESA))
end
devices.AESA = ${AESA_DEVICE_ID}
-- Declare every AESA_* parameter before devices and indicator pages are
-- constructed: a name first created from the running device can bind too
-- late on the page side. Mirrors controller.lua's load-time predeclaration.
for _, name in ipairs({
${aesaParamsLua()}
}) do get_param_handle(name) end
creators[devices.AESA] = {'avLuaDevice', LockOn_Options.script_path..'AESA/controller.lua'}
${END}`;

function patchPages(raw) {
  let out = insertAfterLine(raw, 'local SUBSET_ATP_AA', DECL, 'MFD_Pages_Init subset list');
  // The override must land AFTER the stock makePagesCommon() call, which
  // reassigns pages[PAGE_FCR_AA] to the native composition; the unique
  // init_pageID assignment line guarantees that ordering.
  out = insertAfterLine(out, 'init_pageID\t= PAGE_NONE', OVERRIDE, 'MFD_Pages_Init page table');
  return out;
}

function patchDevice(raw) {
  return insertAfterLine(raw, 'kneeboard_implementation', DEVICE, 'device_init tail');
}

function manifest(p) {
  if (!fs.existsSync(p)) return null;
  return common.manifest(p, { product: PRODUCT, hashes: ['pages_before_hash', 'pages_after_hash', 'device_before_hash', 'device_after_hash', 'controller_hash', 'page_hash'] });
}

function ensureSource() {
  for (const file of [PAGE, CONTROLLER]) if (!fs.existsSync(file)) throw Error(`Missing source: ${file}`);
}

function install(root, { lua = process.env.AESA_LUA } = {}) {
  root = common.requireDirectory(root);
  const p = paths(root);
  for (const file of [p.pages, p.device]) if (!fs.existsSync(file)) throw Error(`F-16C cockpit file not found: ${file}`);
  if (!fs.existsSync(path.join(root, 'bin', 'DCS.exe')) && !fs.existsSync(path.join(root, 'bin-mt', 'DCS.exe'))) {
    throw Error('Target does not look like a DCS installation (bin/DCS.exe missing)');
  }
  common.ensureDcsClosed();
  ensureSource();
  lua = lua || path.join(root, 'bin', 'luae.exe');
  if (fs.existsSync(lua)) {
    common.syntax(lua, PAGE);
    common.syntax(lua, CONTROLLER);
  }

  const m = manifest(p.manifest);
  const pagesRaw = fs.readFileSync(p.pages);
  const deviceRaw = fs.readFileSync(p.device);
  let pages = patchPages(pagesRaw);
  let device = patchDevice(deviceRaw);

  // Repair path: if our markers exist and the manifest matches, rebuild from
  // the current files (idempotent) instead of refusing. If markers exist
  // without a manifest, refuse: we cannot know what is ours.
  const hasMark = pagesRaw.includes(Buffer.from(BEGIN)) || deviceRaw.includes(Buffer.from(BEGIN));
  if (hasMark && !m) throw Error('AESA cockpit markers exist without a manifest; preserve files and inspect backups');
  if (m) {
    const pagesOwned = common.hash(pagesRaw) === m.pages_after_hash;
    const deviceOwned = common.hash(deviceRaw) === m.device_after_hash;
    if (!pagesOwned || !deviceOwned) throw Error('AESA cockpit files were modified by something else; refusing overwrite');
    // Revert to the recorded originals first, then patch fresh. This keeps
    // the operation deterministic and catches marker drift.
    pages = patchPages(Buffer.from(m.pages_before, 'base64'));
    device = patchDevice(Buffer.from(m.device_before, 'base64'));
  }

  const pageData = fs.readFileSync(PAGE);
  const controllerData = fs.readFileSync(CONTROLLER);
  const record = {
    product: PRODUCT,
    schema: 1,
    revision: common.hash(Buffer.concat([pageData, controllerData, pages, device])),
    pages_before: (m ? Buffer.from(m.pages_before, 'base64') : pagesRaw).toString('base64'),
    pages_before_hash: m ? m.pages_before_hash : common.hash(pagesRaw),
    pages_after_hash: common.hash(pages),
    device_before: (m ? Buffer.from(m.device_before, 'base64') : deviceRaw).toString('base64'),
    device_before_hash: m ? m.device_before_hash : common.hash(deviceRaw),
    device_after_hash: common.hash(device),
    controller_hash: common.hash(controllerData),
    page_hash: common.hash(pageData),
    device_id: AESA_DEVICE_ID,
  };
  for (const file of [p.pages, p.device, p.controller, p.page, p.manifest]) common.backup(file);
  common.transaction([
    [p.controller, controllerData],
    [p.page, pageData],
    [p.pages, pages],
    [p.device, device],
    [p.manifest, Buffer.from(JSON.stringify(record, null, 2) + '\n')],
  ]);
  return p;
}

function verify(root) {
  root = common.requireDirectory(root);
  const p = paths(root);
  const m = manifest(p.manifest);
  if (!m) throw Error('AESA cockpit is not installed');
  if (common.hash(fs.readFileSync(p.pages)) !== m.pages_after_hash) throw Error('MFD_Pages_Init.lua differs from installed revision');
  if (common.hash(fs.readFileSync(p.device)) !== m.device_after_hash) throw Error('device_init.lua differs from installed revision');
  if (common.hash(fs.readFileSync(p.controller)) !== m.controller_hash) throw Error('controller.lua differs from installed revision');
  if (common.hash(fs.readFileSync(p.page)) !== m.page_hash) throw Error('MFD_FCR_AESA_AA.lua differs from installed revision');
  if (!fs.readFileSync(p.pages).includes(Buffer.from(BEGIN))) throw Error('MFD page markers missing');
  if (!fs.readFileSync(p.device).includes(Buffer.from(BEGIN))) throw Error('device markers missing');
  return p;
}

function uninstall(root) {
  root = common.requireDirectory(root);
  const p = paths(root);
  const m = manifest(p.manifest);
  if (!m) {
    if (!fs.existsSync(p.pages) && !fs.existsSync(p.device)) return p;
    throw Error('AESA cockpit manifest missing; refusing to guess what to restore');
  }
  common.ensureDcsClosed();
  const pagesRaw = fs.readFileSync(p.pages), deviceRaw = fs.readFileSync(p.device);
  if (common.hash(pagesRaw) !== m.pages_after_hash || common.hash(deviceRaw) !== m.device_after_hash) {
    throw Error('AESA cockpit files were modified by something else; refusing removal');
  }
  common.owned(p.controller, m.controller_hash, 'AESA controller');
  common.owned(p.page, m.page_hash, 'AESA page');
  for (const file of [p.pages, p.device, p.controller, p.page, p.manifest]) common.backup(file);
  common.transaction([
    [p.pages, Buffer.from(m.pages_before, 'base64')],
    [p.device, Buffer.from(m.device_before, 'base64')],
    [p.controller, null],
    [p.page, null],
    [p.manifest, null],
  ]);
  for (const dir of [path.join(p.scripts, 'AESA')]) {
    try { if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch (error) { /* leave it */ }
  }
  return p;
}

function main() {
  const args = process.argv.slice(2);
  const action = args.shift() || 'status';
  let root, lua;
  while (args.length) {
    const key = args.shift(), value = args.shift();
    if (!value || !['--dcs-dir', '--lua'].includes(key)) throw Error('Usage: install_cockpit.cjs install|verify|uninstall|status --dcs-dir <DCS install> [--lua <luae.exe>]');
    if (key === '--dcs-dir') root = value; else lua = value;
  }
  if (!root) throw Error('--dcs-dir is required (no implicit target selection)');
  if (action === 'install' || action === 'repair') { install(root, { lua }); console.log('installed: ' + path.resolve(root)); }
  else if (action === 'uninstall') { uninstall(root); console.log('uninstalled: ' + path.resolve(root)); }
  else if (action === 'verify') { verify(root); console.log('verified: ' + path.resolve(root)); }
  else if (action === 'status') {
    const p = paths(path.resolve(root));
    console.log(manifest(p.manifest) ? 'installed' : 'not installed');
  } else throw Error('Unknown action: ' + action);
}

module.exports = { install, verify, uninstall, paths, PRODUCT, BEGIN, END, AESA_DEVICE_ID, AESA_PARAMS };
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

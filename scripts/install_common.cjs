'use strict';
// Shared deployment primitives (Gate 6): one backup suffix, one atomic write,
// one rollback transaction, one Lua 5.1 syntax gate and one DCS-running guard
// for every Saved Games installer. Host-side only: this module never runs
// inside DCS and never writes the DCS install directory.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const BACKUP_SUFFIX = '.bak-aesa';
const HEX64 = /^[a-f0-9]{64}$/;

function hash(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function read(file) {
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

// First backup keeps the pre-AESA file; a content-addressed revision keeps
// every distinct later revision (including edits made by other tools).
function backup(file, suffix = BACKUP_SUFFIX) {
  const data = read(file);
  if (data === null) return;
  const first = file + suffix;
  if (!fs.existsSync(first)) {
    fs.writeFileSync(first, data, { flag: 'wx' });
  } else if (!fs.readFileSync(first).equals(data)) {
    const revision = first + '-' + hash(data).slice(0, 16);
    if (!fs.existsSync(revision)) fs.writeFileSync(revision, data, { flag: 'wx' });
    else if (!fs.readFileSync(revision).equals(data)) throw Error('Backup collision: ' + revision);
  }
}

// Atomic replacement in the destination directory. A null payload removes the
// file (used by uninstall); the caller must already own/verify the target.
function write(file, data) {
  if (data === null) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.tmp-' + crypto.randomBytes(6).toString('hex');
  try {
    fs.writeFileSync(temp, data, { flag: 'wx' });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

// Restore every owned destination if a later write fails. Backups are kept.
function transaction(changes) {
  const originals = changes.map(([file]) => [file, read(file)]);
  try {
    for (const [file, data] of changes) write(file, data);
  } catch (error) {
    for (const [file, data] of originals.reverse()) write(file, data);
    throw error;
  }
}

function requireDirectory(root) {
  const target = path.resolve(root);
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    throw Error('Target must be an existing Saved Games directory');
  }
  return target;
}

// tasklist is the dependency-free way to see whether the simulator is still
// holding DLLs/Export.lua. A failed probe is treated as "not running" so the
// installer stays usable on hosts without tasklist; tests inject `running`.
function dcsProcesses({ running } = {}) {
  if (typeof running === 'boolean') return running;
  const result = spawnSync('tasklist', ['/NH'], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) return false;
  return /\bDCS(?:\.openbeta)?\.exe\b/i.test(result.stdout || '');
}

function ensureDcsClosed(opts = {}) {
  if (dcsProcesses(opts)) {
    throw Error('DCS is running; close it before install/repair/uninstall (verify/status are read-only)');
  }
}

function syntax(lua, file) {
  const delimiter = '====';
  if (String(file).includes(']' + delimiter + ']')) throw Error('Invalid source path');
  const result = spawnSync(lua, ['-e',
    `assert(_VERSION == 'Lua 5.1'); assert(loadfile([${delimiter}[${file}]${delimiter}]))`],
  { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) {
    throw Error(`Lua 5.1 syntax check failed: ${result.error ? result.error.message : result.stderr}`);
  }
}

function syntaxText(lua, text, label = 'install') {
  const temp = path.join(require('node:os').tmpdir(), `aesa-${label}-${process.pid}-${crypto.randomBytes(4).toString('hex')}.lua`);
  fs.writeFileSync(temp, text);
  try {
    syntax(lua, temp);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function manifest(file, { product, hashes = [], optional = [] } = {}) {
  if (!fs.existsSync(file)) return null;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!data || data.schema !== 1 || (product && data.product !== product)) {
    throw Error(`Invalid manifest: ${path.basename(file)}`);
  }
  for (const key of hashes) {
    if (!HEX64.test(data[key] || '')) throw Error(`Invalid manifest hash: ${key}`);
  }
  for (const key of optional) {
    if (data[key] !== undefined && typeof data[key] !== 'string') {
      throw Error(`Invalid manifest field: ${key}`);
    }
  }
  return data;
}

function owned(file, expectedHash, label) {
  if (fs.existsSync(file) && (!expectedHash || hash(fs.readFileSync(file)) !== expectedHash)) {
    throw Error(`Unknown or modified ${label}; refusing overwrite/removal`);
  }
}

module.exports = {
  BACKUP_SUFFIX,
  HEX64,
  hash,
  read,
  backup,
  write,
  transaction,
  requireDirectory,
  dcsProcesses,
  ensureDcsClosed,
  syntax,
  syntaxText,
  manifest,
  owned,
};

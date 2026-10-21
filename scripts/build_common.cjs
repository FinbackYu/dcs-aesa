'use strict';
// Shared native build helpers: toolchain discovery, a PATH-safe runner, PE
// export/dependency assertions and an optional Lua 5.1 loadfile syntax check.
// Gate 6: every native build script uses this module so the flags and guards
// cannot drift apart.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const MINHOOK_SRC = path.join(ROOT, 'src', 'native', 'third_party', 'minhook', 'src');
const DEFAULT_CFLAGS = ['-O2', '-Wall', '-Wextra', '-shared', '-static', '-static-libgcc'];

function gcc() {
  const candidates = [
    process.env.AESA_GCC,
    path.join(ROOT, '.tools', 'mingw-root', 'mingw64', 'bin', 'gcc.exe'),
    path.join(ROOT, '..', '.tools', 'mingw-root', 'mingw64', 'bin', 'gcc.exe'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (error) {
      // try the next candidate
    }
  }
  throw Error('gcc not found; run python scripts/bootstrap_mingw.py first or set AESA_GCC');
}

// Run a tool with the toolchain's own bin directory leading PATH. gcc's
// sub-tools (cc1, as, ld) load runtime DLLs from that directory, and a
// duplicate PATH/Path key on Windows makes the child silently pick the old
// value, so the environment is rebuilt case-insensitively.
function run(cmd, args) {
  const env = {};
  for (const key of Object.keys(process.env)) {
    if (key.toUpperCase() !== 'PATH') env[key] = process.env[key];
  }
  const bin = path.dirname(cmd);
  const old = process.env.PATH || process.env.Path || '';
  env.Path = bin + path.delimiter + old;
  const result = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, env });
  if (result.error || result.status !== 0) {
    throw Error(`${path.basename(cmd)} failed (${result.status}${result.error ? ', ' + result.error.message : ''})\n${result.stdout || ''}${result.stderr || ''}`);
  }
  return result.stdout || '';
}

function minhookSources() {
  return [
    path.join(MINHOOK_SRC, 'buffer.c'),
    path.join(MINHOOK_SRC, 'hook.c'),
    path.join(MINHOOK_SRC, 'trampoline.c'),
    path.join(MINHOOK_SRC, 'hde', 'hde64.c'),
  ];
}

function peDump(file) {
  return run(path.join(path.dirname(gcc()), 'objdump.exe'), ['-p', file]);
}

// PE export names from objdump's name-pointer table. The earlier export
// address table also has `[ n]` rows (with "Export RVA" instead of a name),
// so parsing starts at the "[Ordinal/Name Pointer] Table" header.
function exportsOf(file) {
  const dump = peDump(file);
  const marker = dump.indexOf('[Ordinal/Name Pointer] Table');
  if (marker < 0) throw Error(`${path.basename(file)} has no PE export name table`);
  const names = [];
  for (const match of dump.slice(marker).matchAll(/^\s*\[\s*\d+\]\s+\+base\[\s*\d+\]\s+[0-9a-f]+\s+(\S+)/gim)) {
    names.push(match[1]);
  }
  return names;
}

function dependenciesOf(file) {
  return [...peDump(file).matchAll(/DLL Name: (.+)/g)].map(match => match[1].trim());
}

function assertExports(file, { required = [], forbidden = [] } = {}) {
  const names = new Set(exportsOf(file));
  const missing = required.filter(name => !names.has(name));
  if (missing.length) throw Error(`${path.basename(file)} is missing exports: ${missing.join(', ')}`);
  const leaked = forbidden.filter(name => names.has(name));
  if (leaked.length) throw Error(`${path.basename(file)} must not export: ${leaked.join(', ')}`);
  return [...names].sort();
}

function assertDependencies(file, allowed = /^(KERNEL32|msvcrt|VERSION)/i) {
  const unexpected = dependenciesOf(file).filter(name => !allowed.test(name));
  if (unexpected.length) throw Error(`${path.basename(file)} has unexpected DLL dependencies: ${unexpected.join(', ')}`);
}

// Compile one DLL and run the PE guards. `required`/`forbidden` are checked
// against the freshly written file before the build is considered successful.
function compile({ output, sources, defines = [], cflags = [], required = [], forbidden = [], allowedDeps } = {}) {
  if (!output) throw Error('compile: output is required');
  if (!Array.isArray(sources) || sources.length === 0) throw Error('compile: sources are required');
  const cc = gcc();
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const args = [...DEFAULT_CFLAGS, ...cflags, ...defines.map(define => `-D${define}`), '-o', output, ...sources, '-lversion'];
  run(cc, args);
  assertExports(output, { required, forbidden });
  assertDependencies(output, allowedDeps);
  return output;
}

// Locate a Lua 5.1 interpreter for syntax checks: AESA_LUA wins, otherwise
// scan the usual DCS install locations on every drive for the bundled
// luae.exe. The result is cached; null means no interpreter was found.
let cachedLua;
function dcsLuaeCandidates() {
  const relatives = [
    'SteamLibrary/steamapps/common/DCSWorld',
    'SteamLibrary/steamapps/common/DCS World',
    'Steam/steamapps/common/DCSWorld',
    'Steam/steamapps/common/DCS World',
    'Program Files (x86)/Steam/steamapps/common/DCSWorld',
    'Program Files (x86)/Steam/steamapps/common/DCS World',
    'Program Files/Steam/steamapps/common/DCSWorld',
    'Program Files/Steam/steamapps/common/DCS World',
    'Games/SteamLibrary/steamapps/common/DCSWorld',
    'Games/Steam/steamapps/common/DCSWorld',
    'Eagle Dynamics/DCS World',
    'Eagle Dynamics/DCS World OpenBeta',
  ];
  const candidates = [];
  for (let index = 0; index < 26; index++) {
    const drive = `${String.fromCharCode(65 + index)}:/`;
    for (const relative of relatives) candidates.push(path.join(drive, relative, 'bin', 'luae.exe'));
  }
  return candidates;
}

function findLua() {
  if (cachedLua !== undefined) return cachedLua;
  const candidates = [process.env.AESA_LUA, ...dcsLuaeCandidates()].filter(Boolean);
  cachedLua = null;
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) { cachedLua = candidate; break; }
    } catch (error) {
      // try the next candidate
    }
  }
  return cachedLua;
}

// Lua 5.1 syntax gate. Uses AESA_LUA or the local DCS luae.exe; a missing
// interpreter is reported (not silently treated as success) so callers can
// decide whether the environment is acceptable.
function checkLuaFile(file, lua = findLua()) {
  if (!lua || !fs.existsSync(lua)) return { checked: false, reason: 'luae.exe not found' };
  if (!fs.existsSync(file)) return { checked: false, reason: `missing Lua source: ${file}` };
  const result = spawnSync(lua, ['-e', `assert(loadfile(${JSON.stringify(file)}))`], {
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const why = result.error ? result.error.message : `${result.stdout || ''}${result.stderr || ''}`;
    return { checked: true, ok: false, reason: why.trim() };
  }
  return { checked: true, ok: true };
}

function checkLuaText(text, label) {
  const temp = path.join(os.tmpdir(), `aesa-${label}-${process.pid}.lua`);
  fs.writeFileSync(temp, text);
  try {
    return checkLuaFile(temp);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

module.exports = {
  ROOT,
  DEFAULT_CFLAGS,
  gcc,
  run,
  minhookSources,
  peDump,
  exportsOf,
  dependenciesOf,
  assertExports,
  assertDependencies,
  compile,
  findLua,
  checkLuaFile,
  checkLuaText,
};

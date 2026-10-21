#!/usr/bin/env node
'use strict';

// Read-only DCS compatibility checker (Gate 3).
//
// Sources: probe logs (COMPAT/CAP/FACT), native probe logs (sym/init lines),
// dcs.log build line, repository RCS data and optional DCS installation
// fingerprints. The tool never writes to the DCS installation or Saved Games;
// only the explicit --record/--json output paths are written.
//
// Exit codes: 0 A (compatible), 2 B (degraded), 3 C (incompatible),
//             4 blocked (probe/logs missing or flaky), 1 usage/input error.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const STATES = new Set(['ok', 'degraded', 'unavailable', 'unknown']);
const EXIT = Object.freeze({ A: 0, B: 2, C: 3, BLOCKED: 4, USAGE: 1 });
const MAX_DETAIL = 200;

class UsageError extends Error {}
class BlockedError extends Error {}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function truncateDetail(text) {
  let value = String(text == null ? '' : text).replace(/[\r\n]+/g, ' ').replace(/,/g, ';');
  if (value.length > MAX_DETAIL) value = `${value.slice(0, MAX_DETAIL - 3)}...`;
  return value;
}

function normalizeState(value) {
  if (value === true) return 'ok';
  if (value === false) return 'unavailable';
  if (typeof value === 'string' && STATES.has(value)) return value;
  if (value && typeof value === 'object' && value.state !== undefined) {
    return normalizeState(value.state);
  }
  return 'unknown';
}

function normalizeCap(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return {
      state: normalizeState(value.state),
      detail: truncateDetail(value.detail),
    };
  }
  return { state: normalizeState(value), detail: '' };
}

function normalizeCaps(raw) {
  const caps = {};
  for (const key of Object.keys(raw || {}).sort()) {
    caps[key] = normalizeCap(raw[key]);
  }
  return caps;
}

function matrixCanonical(capabilities) {
  const caps = capabilities && typeof capabilities === 'object' ? capabilities : {};
  return Object.keys(caps).sort().map(key => `${key}=${normalizeState(caps[key])}\n`).join('');
}

function fnv1a32(text) {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(String(text), 'utf8')) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function matrixHash(capabilities) {
  return fnv1a32(matrixCanonical(capabilities));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = stableValue(value[key]);
    return result;
  }
  return value;
}

function stableJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new UsageError(`cannot read JSON ${file}: ${error.message}`);
  }
}

function readTextIfFile(file) {
  try {
    if (!fs.statSync(file).isFile()) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function relative(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

function findDefaultProfile() {
  const directory = path.join(ROOT, 'spec', 'dcs_profiles');
  let names;
  try {
    names = fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort();
  } catch (error) {
    throw new UsageError(`cannot list ${relative(directory)}: ${error.message}`);
  }
  const profiles = names.map(name => {
    const file = path.join(directory, name);
    return { file, spec: readJson(file) };
  });
  const active = profiles.find(entry => entry.spec.active === true)
    || profiles.find(entry => entry.spec.id !== 'dcs-generic');
  if (!active) throw new UsageError('no active profile in spec/dcs_profiles');
  return active;
}

function loadProfile(option) {
  const entry = option
    ? { file: path.resolve(process.cwd(), option), spec: readJson(path.resolve(process.cwd(), option)) }
    : findDefaultProfile();
  const spec = entry.spec;
  if (!spec || typeof spec !== 'object') throw new UsageError('profile must be an object');
  if (typeof spec.id !== 'string' || spec.id === '') throw new UsageError('profile.id is required');
  if (typeof spec.build !== 'string' || spec.build === '') throw new UsageError('profile.build is required');
  if (spec.capabilities !== undefined && (typeof spec.capabilities !== 'object' || spec.capabilities === null)) {
    throw new UsageError('profile.capabilities must be an object');
  }
  if (spec.required !== undefined && !Array.isArray(spec.required)) {
    throw new UsageError('profile.required must be an array');
  }
  return {
    file: entry.file,
    spec: {
      ...spec,
      capabilities: spec.capabilities || {},
      required: (spec.required || []).filter(item => typeof item === 'string'),
      modules: spec.modules || {},
      native: spec.native || {},
      data: spec.data || {},
      shader: spec.shader || {},
    },
  };
}

function defaultSavedGames() {
  if (process.env.AESA_SAVED_GAMES) return path.resolve(process.env.AESA_SAVED_GAMES);
  const candidate = path.join(os.homedir(), 'Saved Games', 'DCS');
  return fs.existsSync(candidate) ? candidate : null;
}

function resolveSavedGames(options) {
  if (options.savedGames) return path.resolve(process.cwd(), options.savedGames);
  // Explicit --probe inputs are an offline override: do not silently mix in
  // the user's live Saved Games logs unless --saved-games is also given.
  if (options.probes.length > 0) return null;
  return defaultSavedGames();
}

function parseArgs(argv) {
  const options = {
    help: false,
    detect: false,
    probes: [],
    record: null,
    diff: null,
    json: null,
    profile: null,
    savedGames: null,
    dcsDir: null,
  };
  const flags = new Set([
    '--record', '--diff', '--json', '--probe', '--profile', '--saved-games', '--dcs-dir',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw === '--help' || raw === '-h') {
      options.help = true;
      continue;
    }
    if (raw === '--detect') {
      options.detect = true;
      continue;
    }
    let name = raw;
    let value = null;
    const equals = raw.indexOf('=');
    if (equals > 0) {
      name = raw.slice(0, equals);
      value = raw.slice(equals + 1);
    }
    if (!flags.has(name)) throw new UsageError(`unknown argument: ${raw}`);
    if (value === null) {
      index += 1;
      if (index >= argv.length) throw new UsageError(`${name} requires a value`);
      value = argv[index];
    }
    if (value === '') throw new UsageError(`${name} requires a non-empty value`);
    if (value.startsWith('--')) throw new UsageError(`${name} requires a value`);
    if (name === '--probe') options.probes.push(value);
    else if (name === '--record') options.record = value;
    else if (name === '--diff') options.diff = value;
    else if (name === '--json') options.json = value;
    else if (name === '--profile') options.profile = value;
    else if (name === '--saved-games') options.savedGames = value;
    else if (name === '--dcs-dir') options.dcsDir = value;
  }
  if (options.help) return options;
  if (options.record && options.detect) throw new UsageError('--record cannot be combined with --detect');
  if (options.record && (options.diff || options.json)) {
    throw new UsageError('--record writes the baseline; do not pass --diff/--json with it');
  }
  if (options.diff || options.json) options.detect = true;
  if (!options.record && !options.detect) {
    throw new UsageError('nothing to do; use --record or --detect');
  }
  if (options.probes.length === 0) options.probes = [];
  return options;
}

const KNOWN_SAVED_GAMES_INPUTS = [
  ['Scripts/AESA/probe-export.log', 'probe'],
  ['Scripts/AESA/probe-hook.log', 'probe'],
  ['Scripts/AESA/compat/probe-export.log', 'probe'],
  ['Scripts/AESA/compat/probe-hook.log', 'probe'],
  ['Logs/AESA/AGR/agradar_native.log', 'native-agr'],
  ['Logs/AESA/fc_native.log', 'native-fc'],
  ['Logs/dcs.log', 'dcs'],
];

const KNOWN_PROBE_DIR_FILES = [
  'probe-export.log',
  'probe-hook.log',
  'agradar_native.log',
  'fc_native.log',
  'dcs.log',
];

function inferKindFromName(file) {
  const name = path.basename(file).toLowerCase();
  if (name.includes('probe')) return 'probe';
  if (name.includes('agradar')) return 'native-agr';
  if (name.includes('fc_native') || name.includes('fc-')) return 'native-fc';
  if (name === 'dcs.log') return 'dcs';
  return 'unknown';
}

function collectInputs(options) {
  const inputs = [];
  const seen = new Set();
  function add(file, kind) {
    const resolved = path.resolve(file);
    if (seen.has(resolved)) return;
    if (!fs.existsSync(resolved)) return;
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return;
    seen.add(resolved);
    inputs.push({ file: resolved, kind });
  }
  for (const probe of options.probes) {
    const resolved = path.resolve(process.cwd(), probe);
    if (!fs.existsSync(resolved)) throw new UsageError(`probe path not found: ${probe}`);
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      for (const name of KNOWN_PROBE_DIR_FILES) {
        add(path.join(resolved, name), inferKindFromName(name));
      }
    } else {
      add(resolved, inferKindFromName(resolved));
    }
  }
  const savedGames = resolveSavedGames(options);
  if (options.savedGames && !fs.existsSync(savedGames)) {
    throw new UsageError(`saved-games path not found: ${options.savedGames}`);
  }
  if (savedGames) {
    for (const [relativePath, kind] of KNOWN_SAVED_GAMES_INPUTS) {
      add(path.join(savedGames, relativePath), kind);
    }
  }
  if (options.dcsDir) {
    const dcsDir = path.resolve(process.cwd(), options.dcsDir);
    if (!fs.existsSync(dcsDir)) throw new UsageError(`dcs-dir not found: ${options.dcsDir}`);
  }
  inputs.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return inputs;
}

function tokenIndex(line, token) {
  let start = 0;
  while (true) {
    const index = line.indexOf(token, start);
    if (index < 0) return -1;
    const before = index > 0 ? line[index - 1] : '';
    const after = line[index + token.length] || '';
    if (!/[A-Za-z0-9_]/.test(before) && (after === '' || after === ',' || after === ' ')) return index;
    start = index + token.length;
  }
}

function unescapeFact(value) {
  return String(value || '')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\,/g, ',')
    .replace(/\\\\/g, '\\');
}

function parseProbeText(text) {
  const blocks = [];
  let current = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const begin = tokenIndex(raw, 'COMPAT_BEGIN');
    if (begin >= 0) {
      current = {
        profileId: 'unknown',
        matrixHash: 'unknown',
        caps: {},
        facts: {},
        capCount: 0,
        complete: false,
        ignored: 0,
      };
      const rest = raw.slice(begin + 'COMPAT_BEGIN'.length);
      const match = /^,([^,]*),([^,]*)/.exec(rest);
      if (match) {
        if (match[1]) current.profileId = match[1];
        if (match[2]) current.matrixHash = match[2];
      }
      continue;
    }
    if (!current) continue;
    const end = tokenIndex(raw, 'COMPAT_END');
    if (end >= 0) {
      const rest = raw.slice(end + 'COMPAT_END'.length);
      const match = /^,(\d+)/.exec(rest);
      current.capCount = match ? Number(match[1]) : 0;
      current.complete = true;
      blocks.push(current);
      current = null;
      continue;
    }
    const capIndex = tokenIndex(raw, 'CAP');
    if (capIndex >= 0) {
      const rest = raw.slice(capIndex + 'CAP'.length);
      const match = /^,([^,]+),([^,]+),?(.*)$/.exec(rest);
      if (match && STATES.has(match[2])) {
        current.caps[match[1]] = { state: match[2], detail: truncateDetail(match[3] || '') };
      } else {
        current.ignored += 1;
      }
      continue;
    }
    const factIndex = tokenIndex(raw, 'FACT');
    if (factIndex >= 0) {
      const rest = raw.slice(factIndex + 'FACT'.length);
      const match = /^,([^,]+),(.*)$/.exec(rest);
      if (match) current.facts[match[1]] = unescapeFact(match[2]);
      else current.ignored += 1;
    }
  }
  if (blocks.length === 0 && current) {
    const actual = Object.keys(current.caps).length;
    current.capCountActual = actual;
    current.countMismatch = current.capCount !== actual;
    return current;
  }
  const last = blocks[blocks.length - 1];
  if (last) {
    const actual = Object.keys(last.caps).length;
    last.capCountActual = actual;
    last.countMismatch = last.capCount !== actual;
  }
  return last || {
    profileId: 'unknown',
    matrixHash: 'unknown',
    caps: {},
    facts: {},
    capCount: 0,
    complete: false,
    ignored: 0,
  };
}

function parseNativeText(text) {
  const result = {
    symbols: {},
    missing: [],
    loaded: null,
    total: null,
    surfaceMatch: null,
    surfaceTotal: null,
    moduleVersions: {},
    vtableMatch: null,
    offsetsOk: null,
    traceSites: null,
    exportsSha256: null,
  };
  for (const line of String(text).split(/\r?\n/)) {
    const init = /init complete:\s*(\d+)\s*\/\s*(\d+)\s+symbols resolved/.exec(line);
    if (init) {
      result.loaded = Number(init[1]);
      result.total = Number(init[2]);
      continue;
    }
    const surface = /engine surface-name validation:\s*(\d+)\s*\/\s*(\d+)\s+match/.exec(line);
    if (surface) {
      result.surfaceMatch = Number(surface[1]);
      result.surfaceTotal = Number(surface[2]);
      continue;
    }
    const module = /module\s+([^:\s]+):\s+.*?\s+version\s+(\d+\.\d+\.\d+\.\d+)/.exec(line);
    if (module) {
      result.moduleVersions[module[1]] = module[2];
      continue;
    }
    const symbol = /sym\s+(.+?)\s+(resolved|late-resolved|MISSING)\s*$/.exec(line);
    if (symbol) {
      result.symbols[symbol[1]] = symbol[2];
      if (symbol[2] === 'MISSING') result.missing.push(symbol[1]);
      continue;
    }
    const trace = /trace hooks installed:\s*(\d+)/i.exec(line);
    if (trace) {
      result.traceSites = Number(trace[1]);
      continue;
    }
    if (/vtable\[\d+\][^\n]*(?:!=|mismatch|outside)/i.test(line)) {
      result.vtableMatch = false;
      continue;
    }
    if (/vtable\[\d+\]\s+(?:match|ok)\b/i.test(line)) {
      result.vtableMatch = true;
      continue;
    }
    if (/offsets?\s+sanity[^\n]*(?:mismatch|invalid|fail)/i.test(line)) {
      result.offsetsOk = false;
      continue;
    }
    if (/offsets?\s+sanity[^\n]*(?:ok|match)/i.test(line)) {
      result.offsetsOk = true;
      continue;
    }
    const digest = /exports?_sha256[:\s]+([0-9a-f]{64})/i.exec(line);
    if (digest) result.exportsSha256 = digest[1].toLowerCase();
  }
  if (result.loaded === null) {
    const names = Object.keys(result.symbols);
    result.total = names.length;
    result.loaded = names.filter(name => result.symbols[name] !== 'MISSING').length;
  }
  return result;
}

function mergeNativeLogs(logs) {
  if (logs.length === 0) return null;
  const merged = {
    symbols: {},
    missing: [],
    loaded: null,
    total: null,
    surfaceMatch: null,
    surfaceTotal: null,
    moduleVersions: {},
    vtableMatch: null,
    offsetsOk: null,
    traceSites: null,
    exportsSha256: null,
  };
  for (const log of logs) {
    Object.assign(merged.symbols, log.symbols);
    merged.missing = log.missing.length ? log.missing : merged.missing;
    if (log.loaded !== null) merged.loaded = log.loaded;
    if (log.total !== null) merged.total = log.total;
    if (log.surfaceMatch !== null) merged.surfaceMatch = log.surfaceMatch;
    if (log.surfaceTotal !== null) merged.surfaceTotal = log.surfaceTotal;
    Object.assign(merged.moduleVersions, log.moduleVersions);
    if (log.vtableMatch === false || merged.vtableMatch === null) {
      if (log.vtableMatch !== null) merged.vtableMatch = log.vtableMatch;
    }
    if (log.offsetsOk === false || merged.offsetsOk === null) {
      if (log.offsetsOk !== null) merged.offsetsOk = log.offsetsOk;
    }
    if (log.traceSites !== null) merged.traceSites = log.traceSites;
    if (log.exportsSha256) merged.exportsSha256 = log.exportsSha256;
  }
  return merged;
}

function parseDcsText(text) {
  const matches = [...String(text).matchAll(/DCS\/(\d+\.\d+\.\d+\.\d+)\s*\(([^)]*)\)/g)];
  if (matches.length === 0) {
    const fallback = /DCS\/(\d+\.\d+\.\d+\.\d+)/.exec(String(text));
    return fallback ? { build: fallback[1], variant: null } : null;
  }
  const last = matches[matches.length - 1];
  const variantMatch = /(?:^|;)\s*(MT|ST)\s*(?:;|$)/i.exec(last[2]);
  return { build: last[1], variant: variantMatch ? variantMatch[1].toUpperCase() : null };
}

function loadInputs(options) {
  const inputs = collectInputs(options);
  const probeBlocks = [];
  const nativeAgr = [];
  const nativeFc = [];
  const dcs = [];
  const sources = [];
  for (const input of inputs) {
    const text = readTextIfFile(input.file);
    if (text === null) continue;
    sources.push(relative(input.file));
    let kind = input.kind;
    if (kind === 'unknown') {
      if (text.includes('COMPAT_BEGIN')) kind = 'probe';
      else if (/engine surface-name validation|aesa_agradar|AESA_AGR/.test(text)) kind = 'native-agr';
      else if (/aesa_fc|init complete:.*symbols resolved/i.test(text)) kind = 'native-fc';
      else if (/DCS\/\d+\.\d+\.\d+\.\d+/.test(text)) kind = 'dcs';
    }
    if (kind === 'probe') {
      const parsed = parseProbeText(text);
      if (parsed && (parsed.complete || Object.keys(parsed.caps).length > 0)) probeBlocks.push(parsed);
    } else if (kind === 'native-agr') {
      nativeAgr.push(parseNativeText(text));
    } else if (kind === 'native-fc') {
      nativeFc.push(parseNativeText(text));
    } else if (kind === 'dcs') {
      const parsed = parseDcsText(text);
      if (parsed) dcs.push(parsed);
    }
  }
  const savedGames = resolveSavedGames(options);
  if (savedGames) {
    const exportLua = path.join(savedGames, 'Scripts', 'Export.lua');
    if (fs.existsSync(exportLua)) sources.push(relative(exportLua));
  }
  return { inputs, sources: [...new Set(sources)].sort(), probeBlocks, nativeAgr, nativeFc, dcs };
}

function mergeProbeBlocks(blocks) {
  const caps = {};
  const facts = {};
  const flakyKeys = new Set();
  let profileId = null;
  let matrixHashValue = null;
  let complete = false;
  let incomplete = false;
  for (const block of blocks) {
    if (block.complete && !block.countMismatch) complete = true;
    else incomplete = true;
    if (block.profileId && block.profileId !== 'unknown') profileId = block.profileId;
    if (block.matrixHash && block.matrixHash !== 'unknown') matrixHashValue = block.matrixHash;
    for (const [key, cap] of Object.entries(block.caps)) {
      const previous = caps[key];
      if (!previous) {
        caps[key] = cap;
        continue;
      }
      if (previous.state === 'unknown' && cap.state !== 'unknown') {
        caps[key] = cap;
        continue;
      }
      if (previous.state !== 'unknown' && cap.state === 'unknown') {
        continue;
      }
      if (previous.state !== cap.state) flakyKeys.add(key);
      caps[key] = cap;
    }
    Object.assign(facts, block.facts);
  }
  return {
    caps,
    facts,
    flakyKeys,
    complete,
    incomplete: incomplete && !complete,
    profileId,
    matrixHash: matrixHashValue,
  };
}

function setCap(caps, key, cap, overwrite = false) {
  if (!overwrite) {
    const current = caps[key];
    if (current && current.state !== 'unknown') return;
  }
  caps[key] = normalizeCap(cap);
}

function applyBuild(caps, facts, profile, dcsLogs) {
  let build = facts.build || null;
  let variant = facts.variant || null;
  const log = dcsLogs.length ? dcsLogs[dcsLogs.length - 1] : null;
  if (log) {
    if (build && log.build && String(build) !== String(log.build)) {
      caps.BUILD = {
        state: 'degraded',
        detail: truncateDetail(`probe=${build} dcs.log=${log.build}`),
      };
      facts.build = build;
      if (variant) facts.variant = variant;
      return;
    }
    if (!build) build = log.build;
    if (!variant) variant = log.variant;
  }
  if (!build) return;
  facts.build = build;
  if (variant) facts.variant = variant;
  if (profile.spec.id === 'dcs-generic') {
    caps.BUILD = { state: 'ok', detail: 'generic' };
    return;
  }
  if (String(build) !== String(profile.spec.build)) {
    caps.BUILD = {
      state: 'degraded',
      detail: truncateDetail(`build=${build} profile=${profile.spec.build}`),
    };
    return;
  }
  if (variant && profile.spec.variant && String(variant) !== String(profile.spec.variant)) {
    caps.BUILD = {
      state: 'degraded',
      detail: truncateDetail(`variant=${variant} profile=${profile.spec.variant}`),
    };
    return;
  }
  if (!variant && profile.spec.variant && profile.spec.variant !== 'unknown') {
    caps.BUILD = { state: 'degraded', detail: 'variant not observed' };
    return;
  }
  caps.BUILD = {
    state: 'ok',
    detail: variant ? `${build}/${variant}` : build,
  };
}

function applyExportLua(caps, options) {
  const current = caps['EXP-LOAD'];
  if (current && current.state !== 'unknown') return;
  const savedGames = resolveSavedGames(options);
  if (!savedGames) return;
  const file = path.join(savedGames, 'Scripts', 'Export.lua');
  const text = readTextIfFile(file);
  if (text === null) return;
  const begin = '--[[ AESA EXPORT BEGIN ]]';
  const end = '--[[ AESA EXPORT END ]]';
  const script = path.join(savedGames, 'Scripts', 'AESA', 'aesa_export.lua');
  const beginIndex = text.indexOf(begin);
  const endIndex = text.indexOf(end);
  const beginCount = text.split(begin).length - 1;
  const endCount = text.split(end).length - 1;
  if (beginIndex >= 0 && endIndex > beginIndex && beginCount === 1 && endCount === 1) {
    if (fs.existsSync(script)) {
      setCap(caps, 'EXP-LOAD', { state: 'ok', detail: 'AESA marker block' }, true);
    } else {
      setCap(caps, 'EXP-LOAD', {
        state: 'unavailable',
        detail: 'AESA sampler script missing',
      }, true);
    }
  } else {
    setCap(caps, 'EXP-LOAD', {
      state: 'unavailable',
      detail: beginCount === 0 || endCount === 0 ? 'AESA marker block missing' : 'AESA marker block malformed',
    }, true);
  }
}

function parseRcsData() {
  const file = path.join(ROOT, 'src', 'adapters', 'dcs', 'rcs_data.lua');
  const text = readTextIfFile(file);
  if (text === null) return null;
  const entries = [...text.matchAll(/^\s*\["/gm)].length;
  const fallbackMatch = /fallback\s*=\s*\{([^}]*)\}/s.exec(text);
  const fallbacks = {};
  if (fallbackMatch) {
    for (const match of fallbackMatch[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=/g)) {
      fallbacks[match[1]] = true;
    }
  }
  return { schema: 1, entries, fallbacks, file: relative(file) };
}

function applyRcs(caps, profile) {
  const rcs = parseRcsData();
  if (!rcs) return;
  const current = caps['DAT-RCS'];
  if (current && current.state !== 'unknown') return;
  const declaresRcs = profile.spec.data.rcs_schema !== undefined
    || profile.spec.data.rcs_entries !== undefined
    || profile.spec.data.rcs_required_fallbacks !== undefined;
  if (!declaresRcs) return;
  const expectedSchema = profile.spec.data.rcs_schema;
  if (expectedSchema !== undefined && rcs.schema !== expectedSchema) {
    setCap(caps, 'DAT-RCS', { state: 'unavailable', detail: `schema=${rcs.schema}` }, true);
    return;
  }
  const required = profile.spec.data.rcs_required_fallbacks || [];
  for (const name of required) {
    if (!rcs.fallbacks[name]) {
      setCap(caps, 'DAT-RCS', { state: 'unavailable', detail: `missing fallback ${name}` }, true);
      return;
    }
  }
  const expectedEntries = profile.spec.data.rcs_entries;
  if (expectedEntries !== undefined && rcs.entries !== expectedEntries) {
    setCap(caps, 'DAT-RCS', {
      state: 'degraded',
      detail: `entries=${rcs.entries} profile=${expectedEntries}`,
    }, true);
    return;
  }
  setCap(caps, 'DAT-RCS', { state: 'ok', detail: `entries=${rcs.entries}` }, true);
}

function moduleFileName(name) {
  if (name === 'DCS') return 'DCS.exe';
  return `${name}.dll`;
}

function applyDcsDirectory(caps, profile, options) {
  if (!options.dcsDir) return;
  const dcsDir = path.resolve(process.cwd(), options.dcsDir);
  const candidateBins = profile.spec.variant === 'ST'
    ? [path.join(dcsDir, 'bin'), path.join(dcsDir, 'bin-mt')]
    : [path.join(dcsDir, 'bin-mt'), path.join(dcsDir, 'bin')];
  const findModule = name => {
    const fileName = moduleFileName(name);
    for (const bin of candidateBins) {
      const file = path.join(bin, fileName);
      if (fs.existsSync(file)) return file;
    }
    return null;
  };

  const radarFx = path.join(dcsDir, 'Bazar', 'shaders', 'enlight', 'radar.fx');
  if (fs.existsSync(radarFx) && profile.spec.shader.radar_fx_sha256) {
    const actual = sha256File(radarFx).toUpperCase();
    const expected = String(profile.spec.shader.radar_fx_sha256).toUpperCase();
    setCap(caps, 'GFX-RADARFX', actual === expected
      ? { state: 'ok', detail: 'hash match' }
      : { state: 'degraded', detail: 'radar.fx hash mismatch; DBS fallback' }, true);
  }
  const radarLua = path.join(dcsDir, 'Config', 'Effects', 'radar.lua');
  if (fs.existsSync(radarLua) && profile.spec.shader.radar_lua_sha256) {
    const actual = sha256File(radarLua).toUpperCase();
    const expected = String(profile.spec.shader.radar_lua_sha256).toUpperCase();
    setCap(caps, 'GFX-PRESET', actual === expected
      ? { state: 'ok', detail: 'hash match' }
      : { state: 'degraded', detail: 'radar.lua preset hash mismatch' }, true);
  }

  const moduleNames = Object.keys(profile.spec.modules || {});
  if (moduleNames.length === 0) return;
  let checked = 0;
  let mismatched = [];
  for (const name of moduleNames) {
    const file = findModule(name);
    if (!file) continue;
    checked += 1;
    const expected = String(profile.spec.modules[name].sha256 || '').toUpperCase();
    const actual = sha256File(file).toUpperCase();
    if (expected && actual !== expected) mismatched.push(name);
  }
  if (checked > 0) {
    if (mismatched.length > 0) {
      setCap(caps, 'NAT-HASH', {
        state: 'unavailable',
        detail: `module hash mismatch: ${mismatched.join('+')}`,
      }, true);
    } else if (checked < moduleNames.length) {
      setCap(caps, 'NAT-HASH', {
        state: 'unavailable',
        detail: `module files missing: ${checked}/${moduleNames.length}`,
      }, true);
    } else {
      setCap(caps, 'NAT-HASH', {
        state: 'degraded',
        detail: `module hashes match (${checked}); export digest not measured`,
      }, true);
    }
  }
}

function moduleVersion(moduleVersions, name) {
  const candidates = [name, `${name}.dll`, `${name}.exe`];
  for (const candidate of candidates) {
    if (moduleVersions[candidate] !== undefined) return moduleVersions[candidate];
  }
  return null;
}

function applyNativeCaps(caps, profile, nativeAgr, nativeFc) {
  const agr = mergeNativeLogs(nativeAgr);
  const fc = mergeNativeLogs(nativeFc);

  if (agr && agr.loaded !== null && agr.total !== null) {
    const expected = profile.spec.native?.agradar?.symbols?.length || 4;
    const state = agr.loaded === agr.total && agr.total === expected
      ? 'ok'
      : agr.loaded > 0 ? 'degraded' : 'unavailable';
    setCap(caps, 'NAT-AGR-SYM', {
      state,
      detail: `${agr.loaded}/${agr.total} expected=${expected}`,
    }, true);
  }
  if (agr && agr.surfaceMatch !== null && agr.surfaceTotal !== null) {
    const expected = profile.spec.native?.agradar?.surface_classes || 16;
    const state = agr.surfaceMatch === agr.surfaceTotal && agr.surfaceTotal === expected
      ? 'ok'
      : agr.surfaceMatch > 0 ? 'degraded' : 'unavailable';
    setCap(caps, 'NAT-AGR-MASK', {
      state,
      detail: `${agr.surfaceMatch}/${agr.surfaceTotal} expected=${expected}`,
    }, true);
  }
  if (agr && agr.vtableMatch !== null) {
    setCap(caps, 'NAT-AGR-VT', agr.vtableMatch
      ? { state: 'ok', detail: 'vtable match' }
      : { state: 'unavailable', detail: 'vtable mismatch' }, true);
  }

  if (fc && fc.loaded !== null && fc.total !== null) {
    const expected = profile.spec.native?.fc?.symbols?.length || 17;
    const state = fc.loaded === fc.total && fc.total === expected
      ? 'ok'
      : fc.loaded > 0 ? 'degraded' : 'unavailable';
    setCap(caps, 'NAT-FC-SYM', {
      state,
      detail: `${fc.loaded}/${fc.total} expected=${expected}`,
    }, true);
  }
  if (fc && fc.traceSites !== null) {
    const expected = profile.spec.native?.fc?.sites?.length || 13;
    const state = fc.traceSites === expected
      ? 'ok'
      : fc.traceSites > 0 ? 'degraded' : 'unavailable';
    setCap(caps, 'NAT-FC-SITES', {
      state,
      detail: `${fc.traceSites}/${expected}`,
    }, true);
  }
  if (fc && fc.offsetsOk !== null) {
    setCap(caps, 'NAT-FC-OFF', fc.offsetsOk
      ? { state: 'ok', detail: 'offsets sanity' }
      : { state: 'unavailable', detail: 'offsets mismatch' }, true);
  }

  const exportsSha = (agr && agr.exportsSha256) || (fc && fc.exportsSha256) || null;
  if (exportsSha) {
    const expected = profile.spec.native?.exports_sha256;
    if (!expected || expected === 'unknown') {
      setCap(caps, 'NAT-HASH', {
        state: 'degraded',
        detail: 'export digest measured but profile has no digest',
      }, true);
    } else if (String(expected).toLowerCase() === exportsSha) {
      setCap(caps, 'NAT-HASH', { state: 'ok', detail: 'export digest match' }, true);
    } else {
      setCap(caps, 'NAT-HASH', { state: 'unavailable', detail: 'export digest mismatch' }, true);
    }
    return;
  }
  const versions = {
    ...(agr ? agr.moduleVersions : {}),
    ...(fc ? fc.moduleVersions : {}),
  };
  if (Object.keys(versions).length === 0) return;
  const mismatched = [];
  let checked = 0;
  let missing = 0;
  for (const [name, module] of Object.entries(profile.spec.modules || {})) {
    const actual = moduleVersion(versions, name);
    if (actual === null) {
      missing += 1;
      continue;
    }
    checked += 1;
    if (String(actual) !== String(module.version)) mismatched.push(name);
  }
  if (mismatched.length > 0) {
    setCap(caps, 'NAT-HASH', {
      state: 'unavailable',
      detail: `module version mismatch: ${mismatched.join('+')}`,
    }, true);
  } else if (checked > 0 && missing === 0) {
    setCap(caps, 'NAT-HASH', {
      state: 'degraded',
      detail: 'module versions match; export digest not measured',
    }, true);
  }
}

function computeLevel(caps, required, options = {}) {
  if (options.blocked || options.flaky) return 'blocked';
  let missing = false;
  let bad = false;
  for (const key of required) {
    const cap = caps[key];
    if (!cap || cap.state === 'unknown') missing = true;
    else if (cap.state !== 'ok') bad = true;
  }
  if (missing) return 'blocked';
  if (bad) return 'C';
  for (const cap of Object.values(caps)) {
    if (cap.state === 'degraded' || cap.state === 'unavailable') return 'B';
  }
  return 'A';
}

function detect(options) {
  const profile = loadProfile(options.profile);
  const loaded = loadInputs(options);
  const merged = mergeProbeBlocks(loaded.probeBlocks);
  const caps = normalizeCaps(merged.caps);
  const facts = { ...merged.facts };
  applyBuild(caps, facts, profile, loaded.dcs);
  if (profile.spec.id !== 'dcs-generic'
    && merged.profileId && merged.profileId !== 'unknown'
    && merged.profileId !== profile.spec.id) {
    caps.BUILD = {
      state: 'degraded',
      detail: truncateDetail(`probe profile=${merged.profileId} profile=${profile.spec.id}`),
    };
  }
  applyExportLua(caps, options);
  applyRcs(caps, profile);
  applyNativeCaps(caps, profile, loaded.nativeAgr, loaded.nativeFc);
  applyDcsDirectory(caps, profile, options);

  const flaky = [...merged.flakyKeys].sort();
  const level = computeLevel(caps, profile.spec.required, {
    blocked: !merged.complete,
    flaky: flaky.length > 0,
  });
  if (merged.profileId && merged.profileId !== 'unknown') facts.probe_profile_id = merged.profileId;
  if (merged.matrixHash && merged.matrixHash !== 'unknown') facts.probe_matrix_hash = merged.matrixHash;
  const output = {
    schema: 1,
    generated_at: new Date().toISOString(),
    build: facts.build || null,
    variant: facts.variant || null,
    profile_id: profile.spec.id,
    matrix_hash: matrixHash(caps),
    level,
    required: [...profile.spec.required].sort(),
    caps: normalizeCaps(caps),
    diffs: [],
    facts: stableValue(facts),
    sources: loaded.sources,
    flaky,
  };
  return { profile, output, merged };
}

function buildBaseline(result) {
  const { profile, output, merged } = result;
  const caps = {};
  for (const key of Object.keys(profile.spec.capabilities || {}).sort()) {
    caps[key] = { state: 'unknown', detail: 'not observed' };
  }
  for (const [key, cap] of Object.entries(output.caps)) caps[key] = cap;
  const level = computeLevel(caps, profile.spec.required, {
    blocked: !merged.complete,
    flaky: output.flaky.length > 0,
  });
  if (level === 'blocked') {
    throw new BlockedError('probe logs are missing or incomplete; baseline not written');
  }
  return {
    ...output,
    level,
    matrix_hash: matrixHash(caps),
    caps: normalizeCaps(caps),
    diffs: [],
  };
}

function diffCaps(beforeCaps, afterCaps, required) {
  const keys = [...new Set([...Object.keys(beforeCaps), ...Object.keys(afterCaps)])].sort();
  const diffs = [];
  for (const key of keys) {
    const before = beforeCaps[key];
    const after = afterCaps[key];
    if (!before) {
      diffs.push({ key, before: null, after: after.state, class: 'added' });
      continue;
    }
    if (!after) {
      diffs.push({
        key,
        before: before.state,
        after: null,
        class: required.has(key) ? 'incompatible' : 'degraded',
      });
      continue;
    }
    if (before.state === after.state) {
      if ((before.detail || '') !== (after.detail || '')) {
        diffs.push({
          key,
          before: before.state,
          after: after.state,
          class: 'info',
          before_detail: before.detail || '',
          after_detail: after.detail || '',
        });
      }
      continue;
    }
    let klass;
    if (after.state === 'ok') {
      klass = before.state === 'ok' ? 'info' : 'improved';
    } else if (after.state === 'unknown') {
      klass = required.has(key) ? 'incompatible' : 'degraded';
    } else if (after.state === 'degraded' || after.state === 'unavailable') {
      if (before.state === 'unavailable' && after.state === 'degraded') klass = 'improved';
      else klass = required.has(key) ? 'incompatible' : 'degraded';
    } else {
      klass = 'info';
    }
    diffs.push({ key, before: before.state, after: after.state, class: klass });
  }
  return diffs;
}

function runDiff(options) {
  const baselineFile = path.resolve(process.cwd(), options.diff);
  if (!fs.existsSync(baselineFile)) throw new UsageError(`baseline not found: ${options.diff}`);
  const baseline = readJson(baselineFile);
  if (!baseline || typeof baseline !== 'object' || typeof baseline.caps !== 'object') {
    throw new UsageError(`baseline ${options.diff} has no caps object`);
  }
  const result = detect(options);
  const { profile, output } = result;
  const required = new Set(profile.spec.required);
  const beforeCaps = normalizeCaps(baseline.caps);
  const diffs = diffCaps(beforeCaps, output.caps, required);
  for (const key of output.flaky) {
    const entry = {
      key,
      before: beforeCaps[key] ? beforeCaps[key].state : null,
      after: output.caps[key] ? output.caps[key].state : null,
      class: 'flaky',
    };
    const index = diffs.findIndex(diff => diff.key === key);
    if (index >= 0) diffs[index] = entry;
    else diffs.push(entry);
  }
  diffs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  let level = output.level;
  if (output.flaky.length > 0 || (Array.isArray(baseline.flaky) && baseline.flaky.length > 0)) {
    level = 'blocked';
  } else if (level === 'blocked') {
    // Missing/incomplete probe evidence wins over diff classification.
  } else if (diffs.some(diff => diff.class === 'incompatible')) {
    level = 'C';
  } else if (level !== 'C' && level !== 'blocked'
    && diffs.some(diff => ['degraded', 'improved', 'added'].includes(diff.class))) {
    level = 'B';
  }
  output.level = level;
  output.diffs = diffs;
  output.baseline_matrix_hash = typeof baseline.matrix_hash === 'string' ? baseline.matrix_hash : null;
  return { profile, output };
}

function isInside(child, parent) {
  const relativePath = path.relative(parent, child);
  return relativePath === ''
    || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function writeJson(file, value, options = {}) {
  const target = path.resolve(process.cwd(), file);
  if (options.dcsDir) {
    const dcsDir = path.resolve(process.cwd(), options.dcsDir);
    if (isInside(target, dcsDir)) {
      throw new UsageError('refusing to write inside the DCS installation directory');
    }
  }
  if (options.savedGames) {
    const savedGames = path.resolve(process.cwd(), options.savedGames);
    if (isInside(target, savedGames)) {
      throw new UsageError('refusing to write inside the Saved Games directory');
    }
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, stableJson(value), 'utf8');
  return target;
}

function printSummary(output, label) {
  const lines = [];
  lines.push(`compat_check ${label}: profile=${output.profile_id} build=${output.build || 'unknown'} variant=${output.variant || 'unknown'}`);
  lines.push(`level=${output.level} matrix_hash=${output.matrix_hash}`);
  for (const [key, cap] of Object.entries(output.caps)) {
    const detail = cap.detail ? ` ${cap.detail}` : '';
    lines.push(`CAP ${key} ${cap.state}${detail}`);
  }
  for (const diff of output.diffs || []) {
    lines.push(`DIFF ${diff.key} ${diff.before || '-'} -> ${diff.after || '-'} ${diff.class}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function exitCode(level) {
  return EXIT[level] ?? EXIT.BLOCKED;
}

function helpText() {
  return [
    'usage: node scripts/compat_check.cjs --record <json> [options]',
    '       node scripts/compat_check.cjs --detect --diff <baseline> [options]',
    '       node scripts/compat_check.cjs --detect --json <out> [options]',
    '',
    'options:',
    '  --probe <log>          probe/native/dcs log (repeatable; file or directory)',
    '  --saved-games <dir>    Saved Games directory (read-only)',
    '  --profile <json>       profile spec (default: active spec/dcs_profiles)',
    '  --dcs-dir <dir>        DCS installation directory (read-only fingerprints)',
    '',
    'exit codes: 0 A, 2 B, 3 C, 4 blocked/missing, 1 usage error',
  ].join('\n');
}

function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`compat_check: ${error.message}\n`);
      return EXIT.USAGE;
    }
    throw error;
  }
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }
  try {
    if (options.record) {
      const result = detect(options);
      const baseline = buildBaseline(result);
      const target = writeJson(options.record, baseline, options);
      process.stdout.write(`recorded ${relative(target)} level=${baseline.level} matrix_hash=${baseline.matrix_hash}\n`);
      return 0;
    }
    if (options.diff) {
      const result = runDiff(options);
      if (options.json) writeJson(options.json, result.output, options);
      printSummary(result.output, 'diff');
      return exitCode(result.output.level);
    }
    const result = detect(options);
    if (options.json) {
      writeJson(options.json, result.output, options);
      printSummary(result.output, 'detect');
    } else {
      process.stdout.write(stableJson(result.output));
    }
    return exitCode(result.output.level);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`compat_check: ${error.message}\n`);
      return EXIT.USAGE;
    }
    if (error instanceof BlockedError) {
      process.stderr.write(`compat_check: ${error.message}\n`);
      return EXIT.BLOCKED;
    }
    process.stderr.write(`compat_check: ${error.stack || error.message}\n`);
    return EXIT.USAGE;
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  EXIT,
  STATES,
  fnv1a32,
  matrixCanonical,
  matrixHash,
  matrixState: normalizeState,
  normalizeCap,
  normalizeCaps,
  parseArgs,
  parseProbeText,
  parseNativeText,
  parseDcsText,
  parseRcsData,
  diffCaps,
  computeLevel,
  loadProfile,
  main,
};

#!/usr/bin/env node
'use strict';

// Single-source generator: spec/*.json -> Lua / JS / C / fixture / reference doc.
// No third-party dependencies, no timestamps, no machine paths. Deterministic output.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const SPEC_DIR = path.join(ROOT, 'spec');
const PROFILE_SPEC_DIR = path.join(SPEC_DIR, 'dcs_profiles');
const SPEC_FILES = ['physics.json', 'radar.json', 'sar.json', 'protocol.json', 'deployment.json', 'display.json'];
const GENERATOR = 'scripts/gen_config.cjs';
const SCHEMA = 1;

const OUT_CONFIG_LUA = 'src/shared/config.lua';
const OUT_PROTOCOL_LUA = 'src/shared/protocol.lua';
const OUT_CONFIG_JS = 'src/shared/config.cjs';
const OUT_CONFIG_H = 'src/native/generated/config.h';
const OUT_FIXTURE = 'tests/fixtures/config.json';
const OUT_DOCS = 'docs/config-reference.md';
const PROFILE_OUTPUT_DIR = 'src/adapters/dcs/compat/profiles';
const OUT_PROFILE_H = 'src/native/abi/dcs_profile.h';
const OUT_PROFILE_FIXTURE = 'tests/fixtures/dcs_profile.json';
const BASE_OUTPUTS = [OUT_CONFIG_LUA, OUT_PROTOCOL_LUA, OUT_CONFIG_JS, OUT_CONFIG_H, OUT_FIXTURE, OUT_DOCS];
// Kept for callers that only care about the Gate 2 outputs. --check/--write use
// the dynamic list returned by generateAll() so profile outputs are covered too.
const OUTPUTS = BASE_OUTPUTS;

const SOURCE_CLASSES = new Set(['official', 'public_constant', 'assumption', 'derived', 'setting', 'code_default']);
const PROFILE_STATES = new Set(['ok', 'degraded', 'unavailable', 'unknown']);
const PROFILE_SYMBOL_STATUSES = new Set(['resolved', 'missing', 'unknown']);
const PROFILE_HASH_RE = /^[0-9A-Fa-f]{64}$/;
const PROFILE_ID_RE = /^dcs-[a-z0-9][a-z0-9.-]*$/;
const PROFILE_BUILD_RE = /^\d+\.\d+\.\d+\.\d+$/;
const PROFILE_MODULE_RE = /^[A-Za-z0-9_.]+$/;
const PROFILE_CAP_KEY_RE = /^[A-Z][A-Z0-9_-]*$/;
const META_KEYS = new Set(['schema', 'owner', 'sources', 'known_conflicts', 'renames', 'legacy_key_names']);

function readSpec(name) {
  const file = path.join(SPEC_DIR, name);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`cannot read spec/${name}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid JSON in spec/${name}: ${error.message}`);
  }
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function inputHash(rawSpecs, profileSpecs = null) {
  const hash = crypto.createHash('sha256');
  for (const name of SPEC_FILES) hash.update(`${name}\n${canonical(rawSpecs[name])}\n`, 'utf8');
  // Profile inputs are optional so the Gate 2 output family keeps its existing
  // input hash; profile outputs use the combined hash (see generateAll).
  if (profileSpecs !== null) {
    for (const name of Object.keys(profileSpecs).sort()) {
      hash.update(`dcs_profiles/${name}\n${canonical(profileSpecs[name])}\n`, 'utf8');
    }
  }
  return hash.digest('hex');
}

function fail(context, message) {
  throw new Error(`${context}: ${message}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function expectObject(value, context) {
  if (!isPlainObject(value)) fail(context, 'must be an object');
  return value;
}

function expectArray(value, context) {
  if (!Array.isArray(value)) fail(context, 'must be an array');
  return value;
}

function expectString(value, context) {
  if (typeof value !== 'string' || value.length === 0) fail(context, 'must be a non-empty string');
  return value;
}

function expectBoolean(value, context) {
  if (typeof value !== 'boolean') fail(context, 'must be a boolean');
  return value;
}

function expectFinite(value, context) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(context, 'must be a finite number');
  return value;
}

function expectInteger(value, context) {
  expectFinite(value, context);
  if (!Number.isInteger(value)) fail(context, 'must be an integer');
  return value;
}

function expectPositive(value, context) {
  expectFinite(value, context);
  if (!(value > 0)) fail(context, 'must be > 0');
  return value;
}

function expectRange(value, context, min, max) {
  expectFinite(value, context);
  if (value < min || value > max) fail(context, `must be in [${min}, ${max}]`);
  return value;
}

function requireKeys(object, keys, context) {
  expectObject(object, context);
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) fail(context, `missing required key "${key}"`);
  }
}

function walkNumbers(value, context, seen = new Set()) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(context, 'contains a non-finite number');
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) fail(context, 'contains a cycle');
  seen.add(value);
  if (Array.isArray(value)) value.forEach((item, index) => walkNumbers(item, `${context}[${index}]`, seen));
  else for (const [key, item] of Object.entries(value)) walkNumbers(item, `${context}.${key}`, seen);
  seen.delete(value);
}

function resolvePointer(root, pointer, context) {
  if (pointer === '') return root;
  let node = root;
  for (const raw of pointer.split('/')) {
    const token = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(node)) {
      if (!/^\d+$/.test(token) || Number(token) >= node.length) fail(context, `array pointer token "${token}" is out of range`);
      node = node[Number(token)];
    } else if (isPlainObject(node)) {
      if (!Object.prototype.hasOwnProperty.call(node, token)) fail(context, `pointer token "${token}" is missing`);
      node = node[token];
    } else {
      fail(context, `pointer descends into a scalar at "${token}"`);
    }
  }
  return node;
}

function splitRef(ref, context, currentFile) {
  const withFile = /^([a-z_]+\.json)#\/(.*)$/.exec(ref);
  if (withFile) {
    const file = withFile[1];
    if (!SPEC_FILES.includes(file)) fail(context, `$ref points at unknown spec file "${file}"`);
    return { file, pointer: withFile[2] };
  }
  const sameFile = /^#\/(.*)$/.exec(ref);
  if (sameFile) {
    if (!SPEC_FILES.includes(currentFile)) fail(context, `same-file $ref without a valid current file`);
    return { file: currentFile, pointer: sameFile[1] };
  }
  fail(context, `invalid $ref "${ref}" (expected <file>.json#/pointer or #/pointer)`);
}

function resolveSpecs(rawSpecs) {
  const origins = Object.fromEntries(SPEC_FILES.map(name => [name, Object.create(null)]));
  const refPaths = Object.fromEntries(SPEC_FILES.map(name => [name, Object.create(null)]));
  const cache = new Map();

  function resolveNode(node, file, pointer, stack) {
    if (isPlainObject(node) && Object.prototype.hasOwnProperty.call(node, '$ref')) {
      const ref = expectString(node.$ref, `${file}#/${pointer}.$ref`);
      const key = `${file}#/${pointer}`;
      if (stack.includes(key)) fail(key, `cyclic $ref (${[...stack, key].join(' -> ')})`);
      const target = splitRef(ref, `${file}#/${pointer}`, file);
      const targetKey = `${target.file}#/${target.pointer}`;
      if (cache.has(targetKey)) {
        const cached = cache.get(targetKey);
        origins[file][pointer] = cached.origin;
        refPaths[file][pointer] = ref;
        return cached;
      }
      const targetNode = resolvePointer(rawSpecs[target.file], target.pointer, `${file}#/${pointer}`);
      const targetPath = target.pointer.replace(/\//g, '.');
      const result = resolveNode(targetNode, target.file, targetPath, [...stack, key]);
      cache.set(targetKey, result);
      origins[file][pointer] = result.origin;
      refPaths[file][pointer] = ref;
      return result;
    }
    if (Array.isArray(node)) {
      const value = node.map((item, index) => {
        const childPath = `${pointer}[${index}]`;
        const result = resolveNode(item, file, childPath, stack);
        origins[file][childPath] = result.origin;
        return result.value;
      });
      return { value, origin: origins[file][pointer] || { file, path: pointer } };
    }
    if (isPlainObject(node)) {
      const value = {};
      for (const [key, item] of Object.entries(node)) {
        const childPath = pointer === '' ? key : `${pointer}.${key}`;
        const result = resolveNode(item, file, childPath, stack);
        origins[file][childPath] = result.origin;
        value[key] = result.value;
      }
      return { value, origin: origins[file][pointer] || { file, path: pointer } };
    }
    return { value: node, origin: origins[file][pointer] || { file, path: pointer } };
  }

  const resolved = {};
  for (const name of SPEC_FILES) {
    const result = resolveNode(rawSpecs[name], name, '', []);
    resolved[name] = result.value;
    origins[name][''] = result.origin;
  }

  function assertNoRefs(value, context) {
    if (isPlainObject(value)) {
      if (Object.prototype.hasOwnProperty.call(value, '$ref')) fail(context, 'unresolved $ref remains');
      for (const [key, item] of Object.entries(value)) assertNoRefs(item, `${context}.${key}`);
    } else if (Array.isArray(value)) value.forEach((item, index) => assertNoRefs(item, `${context}[${index}]`));
  }
  for (const name of SPEC_FILES) assertNoRefs(resolved[name], `spec/${name}`);

  return { resolved, origins, refPaths };
}

function validateSourceMap(spec, file, specName) {
  if (spec.sources === undefined) return;
  const sources = expectObject(spec.sources, `spec/${file}.sources`);
  for (const [key, source] of Object.entries(sources)) {
    const context = `spec/${file}.sources["${key}"]`;
    requireKeys(source, ['file', 'line', 'class', 'note'], context);
    const sourceFile = expectString(source.file, `${context}.file`);
    expectInteger(source.line, `${context}.line`);
    if (!SOURCE_CLASSES.has(source.class)) fail(`${context}.class`, `unknown source class "${source.class}"`);
    expectString(source.note, `${context}.note`);
    const absolute = path.resolve(ROOT, sourceFile);
    if (!absolute.startsWith(ROOT + path.sep) && absolute !== ROOT) fail(`${context}.file`, 'must stay inside the repository');
    if (!fs.existsSync(absolute)) fail(`${context}.file`, `file does not exist: ${sourceFile}`);
    if (/^[A-Za-z]:[\\/]/.test(sourceFile) || sourceFile.startsWith('\\\\')) {
      fail(`${context}.file`, 'absolute paths are not allowed');
    }
    if (path.basename(key) !== key && key.includes('..')) fail(`${context}`, 'source key contains ".."');
  }
  void specName;
}

function validateConflicts(spec, file) {
  if (spec.known_conflicts === undefined) return;
  const conflicts = expectArray(spec.known_conflicts, `spec/${file}.known_conflicts`);
  const ids = new Set();
  for (const [index, conflict] of conflicts.entries()) {
    const context = `spec/${file}.known_conflicts[${index}]`;
    requireKeys(conflict, ['id', 'topic', 'evidence', 'resolution'], context);
    const id = expectString(conflict.id, `${context}.id`);
    if (ids.has(id)) fail(`${context}.id`, 'duplicate conflict id');
    ids.add(id);
    expectString(conflict.topic, `${context}.topic`);
    expectArray(conflict.evidence, `${context}.evidence`).forEach((item, i) => expectString(item, `${context}.evidence[${i}]`));
    expectString(conflict.resolution, `${context}.resolution`);
  }
}

function validateCommon(resolved, rawSpecs, origins) {
  for (const name of SPEC_FILES) {
    const spec = resolved[name];
    const raw = rawSpecs[name];
    expectObject(spec, `spec/${name}`);
    if (spec.schema !== SCHEMA) fail(`spec/${name}.schema`, `must be ${SCHEMA}`);
    expectString(spec.owner, `spec/${name}.owner`);
    walkNumbers(spec, `spec/${name}`);
    validateSourceMap(raw, name);
    validateConflicts(raw, name);
    void origins;
  }
}

function validatePhysics(spec) {
  const c = expectObject(spec.constants, 'physics.constants');
  requireKeys(c, ['c_mps', 'boltzmann_j_per_k', 't0_k', 'earth_radius_m', 'earth_k'], 'physics.constants');
  expectPositive(c.c_mps, 'physics.constants.c_mps');
  expectPositive(c.boltzmann_j_per_k, 'physics.constants.boltzmann_j_per_k');
  expectPositive(c.t0_k, 'physics.constants.t0_k');
  expectPositive(c.earth_radius_m, 'physics.constants.earth_radius_m');
  expectPositive(c.earth_k, 'physics.constants.earth_k');
}

function checkNoLegacyKeys(value, context, banned) {
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (banned.has(key)) fail(context, `legacy key "${key}" must be removed or renamed`);
      checkNoLegacyKeys(item, `${context}.${key}`, banned);
    }
  } else if (Array.isArray(value)) value.forEach((item, index) => checkNoLegacyKeys(item, `${context}[${index}]`, banned));
}

function validateRadar(spec) {
  const radar = expectObject(spec.radar, 'radar.radar');
  requireKeys(radar, [
    'lambda_m', 'ptx_avg_w', 'ptx_peak_w', 'gain0_db', 'nf_db', 'loss_db', 'pfa',
    'integration_efficiency', 'coherence_time_s', 'fluctuation_hold_s', 'scan_k',
    'scan_cone_deg', 'steer_overhead_s', 'hpbw_az_deg', 'hpbw_el_deg', 'dwell_search_s',
    'dwell_track_s', 'dwell_stt_s', 'dwell_compensation', 'horizon_enabled',
    'earth_radius_m', 'earth_k', 'surface_alt_m', 'min_range_m', 'max_range_m', 'prf'
  ], 'radar.radar');
  expectPositive(radar.lambda_m, 'radar.radar.lambda_m');
  expectPositive(radar.ptx_avg_w, 'radar.radar.ptx_avg_w');
  expectPositive(radar.ptx_peak_w, 'radar.radar.ptx_peak_w');
  expectPositive(radar.gain0_db, 'radar.radar.gain0_db');
  expectPositive(radar.nf_db, 'radar.radar.nf_db');
  expectPositive(radar.loss_db, 'radar.radar.loss_db');
  expectRange(radar.pfa, 'radar.radar.pfa', 0, 1);
  expectPositive(radar.integration_efficiency, 'radar.radar.integration_efficiency');
  if (radar.coherence_time_s !== false) expectPositive(radar.coherence_time_s, 'radar.radar.coherence_time_s');
  expectFinite(radar.fluctuation_hold_s, 'radar.radar.fluctuation_hold_s');
  expectPositive(radar.scan_k, 'radar.radar.scan_k');
  expectRange(radar.scan_cone_deg, 'radar.radar.scan_cone_deg', 0, 90);
  expectPositive(radar.steer_overhead_s, 'radar.radar.steer_overhead_s');
  expectPositive(radar.hpbw_az_deg, 'radar.radar.hpbw_az_deg');
  expectPositive(radar.hpbw_el_deg, 'radar.radar.hpbw_el_deg');
  expectPositive(radar.dwell_search_s, 'radar.radar.dwell_search_s');
  expectPositive(radar.dwell_track_s, 'radar.radar.dwell_track_s');
  expectPositive(radar.dwell_stt_s, 'radar.radar.dwell_stt_s');
  expectBoolean(radar.dwell_compensation, 'radar.radar.dwell_compensation');
  expectBoolean(radar.horizon_enabled, 'radar.radar.horizon_enabled');
  expectPositive(radar.earth_radius_m, 'radar.radar.earth_radius_m');
  expectPositive(radar.earth_k, 'radar.radar.earth_k');
  expectFinite(radar.surface_alt_m, 'radar.radar.surface_alt_m');
  expectFinite(radar.min_range_m, 'radar.radar.min_range_m');
  if (radar.max_range_m !== false) expectPositive(radar.max_range_m, 'radar.radar.max_range_m');

  const prf = expectArray(radar.prf, 'radar.radar.prf');
  if (prf.length === 0) fail('radar.radar.prf', 'must not be empty');
  const names = new Set();
  for (const [index, entry] of prf.entries()) {
    const context = `radar.radar.prf[${index}]`;
    requireKeys(entry, ['name', 'prf_hz', 'tau_s', 'notch_half_mps', 'zero_notch_half_mps'], context);
    const name = expectString(entry.name, `${context}.name`);
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) fail(`${context}.name`, 'must be an uppercase PRF name');
    if (names.has(name)) fail(`${context}.name`, 'duplicate PRF name');
    names.add(name);
    expectPositive(entry.prf_hz, `${context}.prf_hz`);
    expectPositive(entry.tau_s, `${context}.tau_s`);
    expectFinite(entry.notch_half_mps, `${context}.notch_half_mps`);
    if (entry.notch_half_mps < 0) fail(`${context}.notch_half_mps`, 'must be >= 0');
    expectFinite(entry.zero_notch_half_mps, `${context}.zero_notch_half_mps`);
    if (entry.zero_notch_half_mps < 0) fail(`${context}.zero_notch_half_mps`, 'must be >= 0');
    if (entry.tau_s * entry.prf_hz > 1) fail(`${context}`, 'duty cycle tau_s*prf_hz must be <= 1');
  }

  const scheduler = expectObject(spec.scheduler, 'radar.scheduler');
  requireKeys(scheduler, ['search', 'revisit'], 'radar.scheduler');
  const search = expectObject(scheduler.search, 'radar.scheduler.search');
  requireKeys(search, ['az_span_deg', 'az_step_deg', 'el_bars_deg'], 'radar.scheduler.search');
  const azSpan = expectPositive(search.az_span_deg, 'radar.scheduler.search.az_span_deg');
  const azStep = expectPositive(search.az_step_deg, 'radar.scheduler.search.az_step_deg');
  if (azStep > radar.hpbw_az_deg) fail('radar.scheduler.search.az_step_deg', `must be <= hpbw_az_deg (${radar.hpbw_az_deg})`);
  if (azSpan < azStep) fail('radar.scheduler.search.az_span_deg', 'must be >= az_step_deg');
  const bars = expectArray(search.el_bars_deg, 'radar.scheduler.search.el_bars_deg');
  if (bars.length === 0) fail('radar.scheduler.search.el_bars_deg', 'must not be empty');
  let previous;
  for (const [index, bar] of bars.entries()) {
    expectFinite(bar, `radar.scheduler.search.el_bars_deg[${index}]`);
    if (previous !== undefined) {
      const gap = bar - previous;
      if (!(gap > 0)) fail('radar.scheduler.search.el_bars_deg', 'must be strictly increasing');
      if (gap > radar.hpbw_el_deg) {
        fail('radar.scheduler.search.el_bars_deg', `gap ${gap} at [${index}] exceeds hpbw_el_deg=${radar.hpbw_el_deg}`);
      }
    }
    previous = bar;
  }

  const revisit = expectObject(scheduler.revisit, 'radar.scheduler.revisit');
  requireKeys(revisit, ['track_far_hz', 'track_near_hz', 'stt_hz', 'near_range_m', 'near_prf_R_m'], 'radar.scheduler.revisit');
  expectPositive(revisit.track_far_hz, 'radar.scheduler.revisit.track_far_hz');
  expectPositive(revisit.track_near_hz, 'radar.scheduler.revisit.track_near_hz');
  expectPositive(revisit.stt_hz, 'radar.scheduler.revisit.stt_hz');
  expectPositive(revisit.near_range_m, 'radar.scheduler.revisit.near_range_m');
  expectPositive(revisit.near_prf_R_m, 'radar.scheduler.revisit.near_prf_R_m');

  const selection = expectObject(spec.prf_selection, 'radar.prf_selection');
  requireKeys(selection, ['search', 'track_far', 'track_near', 'stt'], 'radar.prf_selection');
  for (const [key, list] of Object.entries(selection)) {
    const context = `radar.prf_selection.${key}`;
    const values = expectArray(list, context);
    if (values.length === 0) fail(context, 'must not be empty');
    for (const [index, name] of values.entries()) {
      expectString(name, `${context}[${index}]`);
      if (!names.has(name)) fail(`${context}[${index}]`, `unknown PRF name "${name}"`);
    }
  }

  const tracker = expectObject(spec.tracker, 'radar.tracker');
  requireKeys(tracker, [
    'confirm_m', 'confirm_window_s', 'coast_s', 'gate_base_m', 'gate_vel_margin_mps',
    'gate_max_m', 'vel_floor_mps', 'gate_accel_margin_mps', 'vel_smooth',
    'vel_accel_max_mps2', 'slow_mover_mps'
  ], 'radar.tracker');
  expectPositive(tracker.confirm_m, 'radar.tracker.confirm_m');
  expectPositive(tracker.confirm_window_s, 'radar.tracker.confirm_window_s');
  expectPositive(tracker.coast_s, 'radar.tracker.coast_s');
  expectPositive(tracker.gate_base_m, 'radar.tracker.gate_base_m');
  expectFinite(tracker.gate_vel_margin_mps, 'radar.tracker.gate_vel_margin_mps');
  expectPositive(tracker.gate_max_m, 'radar.tracker.gate_max_m');
  if (tracker.gate_max_m < tracker.gate_base_m) fail('radar.tracker.gate_max_m', 'must be >= gate_base_m');
  expectFinite(tracker.vel_floor_mps, 'radar.tracker.vel_floor_mps');
  expectFinite(tracker.gate_accel_margin_mps, 'radar.tracker.gate_accel_margin_mps');
  expectRange(tracker.vel_smooth, 'radar.tracker.vel_smooth', 0, 1);
  expectPositive(tracker.vel_accel_max_mps2, 'radar.tracker.vel_accel_max_mps2');
  expectFinite(tracker.slow_mover_mps, 'radar.tracker.slow_mover_mps');

  const legacyNames = expectArray(spec.legacy_key_names, 'radar.legacy_key_names');
  if (legacyNames.length === 0) fail('radar.legacy_key_names', 'must not be empty');
  const banned = new Set(legacyNames.map((name, index) => expectString(name, `radar.legacy_key_names[${index}]`)));
  checkNoLegacyKeys(spec.radar, 'radar.radar', banned);
  checkNoLegacyKeys(spec.scheduler, 'radar.scheduler', banned);
  checkNoLegacyKeys(spec.tracker, 'radar.tracker', banned);
}

function validateSar(spec) {
  const constants = expectObject(spec.constants, 'sar.constants');
  requireKeys(constants, [
    'default_lambda_m', 'default_bandwidth_hz', 'default_width', 'default_range_step',
    'kernel_lobes', 'default_window', 'default_range_interpolation',
    'default_pulse_oversampling', 'pulse_oversampling_min', 'pulse_oversampling_max',
    'min_prf_hz', 'history_budget_bytes', 'history_bytes_per_bin_pulse',
    'history_pulse_share', 'max_simulated_pulses', 'range_window_padding_cells'
  ], 'sar.constants');
  expectPositive(constants.default_lambda_m, 'sar.constants.default_lambda_m');
  expectPositive(constants.default_bandwidth_hz, 'sar.constants.default_bandwidth_hz');
  expectInteger(constants.default_width, 'sar.constants.default_width');
  expectPositive(constants.default_range_step, 'sar.constants.default_range_step');
  expectPositive(constants.kernel_lobes, 'sar.constants.kernel_lobes');
  expectString(constants.default_window, 'sar.constants.default_window');
  expectString(constants.default_range_interpolation, 'sar.constants.default_range_interpolation');
  expectPositive(constants.default_pulse_oversampling, 'sar.constants.default_pulse_oversampling');
  expectPositive(constants.pulse_oversampling_min, 'sar.constants.pulse_oversampling_min');
  expectPositive(constants.pulse_oversampling_max, 'sar.constants.pulse_oversampling_max');
  if (constants.pulse_oversampling_min > constants.pulse_oversampling_max) fail('sar.constants', 'pulse oversampling min > max');
  expectPositive(constants.min_prf_hz, 'sar.constants.min_prf_hz');
  expectPositive(constants.history_budget_bytes, 'sar.constants.history_budget_bytes');
  expectPositive(constants.history_bytes_per_bin_pulse, 'sar.constants.history_bytes_per_bin_pulse');
  expectRange(constants.history_pulse_share, 'sar.constants.history_pulse_share', 0, 1);
  expectPositive(constants.max_simulated_pulses, 'sar.constants.max_simulated_pulses');
  expectInteger(constants.range_window_padding_cells, 'sar.constants.range_window_padding_cells');
  if (constants.range_window_padding_cells < constants.kernel_lobes)
    fail('sar.constants.range_window_padding_cells', 'must cover at least the kernel lobes');

  const profiles = expectObject(spec.profiles, 'sar.profiles');
  requireKeys(profiles, ['standard', 'fine', 'fast'], 'sar.profiles');
  for (const name of ['standard', 'fine', 'fast']) {
    const profile = expectObject(profiles[name], `sar.profiles.${name}`);
    requireKeys(profile, ['quality', 'bandwidth_hz', 'width'], `sar.profiles.${name}`);
    expectString(profile.quality, `sar.profiles.${name}.quality`);
    expectPositive(profile.bandwidth_hz, `sar.profiles.${name}.bandwidth_hz`);
    expectInteger(profile.width, `sar.profiles.${name}.width`);
    if (![65, 129, 257].includes(profile.width)) fail(`sar.profiles.${name}.width`, 'must be 65, 129 or 257');
    if (profile.pulse_oversampling !== undefined) {
      expectRange(profile.pulse_oversampling, `sar.profiles.${name}.pulse_oversampling`, constants.pulse_oversampling_min, constants.pulse_oversampling_max);
    }
  }
  if (profiles.standard.bandwidth_hz !== constants.default_bandwidth_hz) fail('sar.profiles.standard.bandwidth_hz', 'must equal sar.constants.default_bandwidth_hz');
  if (profiles.standard.width !== constants.default_width) fail('sar.profiles.standard.width', 'must equal sar.constants.default_width');

  const footprints = expectObject(spec.footprints, 'sar.footprints');
  requireKeys(footprints, ['detail', 'area', 'airport'], 'sar.footprints');
  const sizeN = new Set();
  for (const [name, footprint] of Object.entries(footprints)) {
    const context = `sar.footprints.${name}`;
    requireKeys(footprint, ['size_m', 'n', 'scatter_spacing_m'], context);
    expectPositive(footprint.size_m, `${context}.size_m`);
    expectInteger(footprint.n, `${context}.n`);
    if (footprint.n < 2) fail(`${context}.n`, 'must be >= 2');
    expectPositive(footprint.scatter_spacing_m, `${context}.scatter_spacing_m`);
    const key = `${footprint.size_m}x${footprint.n}`;
    if (sizeN.has(key)) fail(context, 'duplicate size/n pair');
    sizeN.add(key);
    if (footprint.width !== undefined) expectInteger(footprint.width, `${context}.width`);
    if (footprint.bandwidth_hz !== undefined) expectPositive(footprint.bandwidth_hz, `${context}.bandwidth_hz`);
  }

  const classes = expectArray(spec.surface_classes, 'sar.surface_classes');
  if (classes.length !== 16) fail('sar.surface_classes', 'must contain exactly 16 classes');
  const classSet = new Set(classes);
  if (classSet.size !== classes.length) fail('sar.surface_classes', 'must be unique');
  const priority = expectArray(spec.surface_priority, 'sar.surface_priority');
  if (priority.length !== 16) fail('sar.surface_priority', 'must contain exactly 16 classes');
  if (new Set(priority).size !== priority.length) fail('sar.surface_priority', 'must be unique');
  for (const name of priority) if (!classSet.has(name)) fail('sar.surface_priority', `unknown class "${name}"`);
  for (const name of classSet) if (!priority.includes(name)) fail('sar.surface_priority', `missing class "${name}"`);
  const materials = expectObject(spec.materials, 'sar.materials');
  for (const name of classSet) {
    expectPositive(materials[name], `sar.materials.${name}`);
  }
  for (const name of ['unknown', 'shallow_water', 'water']) expectPositive(materials[name], `sar.materials.${name}`);
  const legacy = expectObject(spec.legacy_surfaces, 'sar.legacy_surfaces');
  for (const [key, name] of Object.entries(legacy)) {
    if (!Object.prototype.hasOwnProperty.call(materials, name)) fail(`sar.legacy_surfaces.${key}`, `unknown material "${name}"`);
  }

  const map = expectObject(spec.map, 'sar.map');
  requireKeys(map, ['engine_defaults', 'service_defaults', 'limits', 'collection', 'lattice', 'dbs', 'mover', 'sweep'], 'sar.map');
  const engine = expectObject(map.engine_defaults, 'sar.map.engine_defaults');
  requireKeys(engine, ['cell_m', 'cells', 'beam_deg', 'looks', 'stc', 'shadow', 'layover', 'layover_margin_cells', 'seed', 'min_slant_m', 'surface_default', 'kernel_sigmas', 'peak_norm', 'relief', 'grid_layout'], 'sar.map.engine_defaults');
  const service = expectObject(map.service_defaults, 'sar.map.service_defaults');
  requireKeys(service, ['range_m', 'azimuth_deg', 'cell_m', 'beam_deg', 'looks', 'stc', 'shadow', 'dbs_factor', 'peak_norm'], 'sar.map.service_defaults');
  const limits = expectObject(map.limits, 'sar.map.limits');
  requireKeys(limits, ['cell_m', 'service_cell_m', 'cells', 'sector_cells_max', 'beam_deg', 'looks', 'layover_margin_cells', 'min_slant_m', 'kernel_sigmas', 'dbs_factor_engine', 'dbs_factor_service', 'service_range_m', 'service_azimuth_deg', 'job_cells_max', 'job_timeout_ms', 'advance_m', 'turn_reanchor_deg', 'frame_min_ms', 'render_gain', 'pose_refresh_ms'], 'sar.map.limits');
  for (const [name, limit] of Object.entries(limits)) {
    if (!isPlainObject(limit)) continue;
    const context = `sar.map.limits.${name}`;
    requireKeys(limit, ['min', 'max'], context);
    expectFinite(limit.min, `${context}.min`);
    expectFinite(limit.max, `${context}.max`);
    if (!(limit.min <= limit.max)) fail(context, 'min must be <= max');
  }
  expectFinite(engine.cell_m, 'sar.map.engine_defaults.cell_m');
  expectInteger(engine.cells, 'sar.map.engine_defaults.cells');
  expectFinite(engine.beam_deg, 'sar.map.engine_defaults.beam_deg');
  expectInteger(engine.looks, 'sar.map.engine_defaults.looks');
  expectBoolean(engine.stc, 'sar.map.engine_defaults.stc');
  expectBoolean(engine.shadow, 'sar.map.engine_defaults.shadow');
  expectBoolean(engine.layover, 'sar.map.engine_defaults.layover');
  expectInteger(engine.layover_margin_cells, 'sar.map.engine_defaults.layover_margin_cells');
  expectInteger(engine.seed, 'sar.map.engine_defaults.seed');
  expectFinite(engine.min_slant_m, 'sar.map.engine_defaults.min_slant_m');
  expectString(engine.surface_default, 'sar.map.engine_defaults.surface_default');
  if (!Object.prototype.hasOwnProperty.call(materials, engine.surface_default)) fail('sar.map.engine_defaults.surface_default', 'unknown material');
  expectFinite(engine.kernel_sigmas, 'sar.map.engine_defaults.kernel_sigmas');
  expectBoolean(engine.peak_norm, 'sar.map.engine_defaults.peak_norm');
  expectBoolean(engine.relief, 'sar.map.engine_defaults.relief');
  expectString(engine.grid_layout, 'sar.map.engine_defaults.grid_layout');
  for (const [key, limitName] of [['cell_m', 'cell_m'], ['beam_deg', 'beam_deg'], ['looks', 'looks'], ['layover_margin_cells', 'layover_margin_cells'], ['min_slant_m', 'min_slant_m'], ['kernel_sigmas', 'kernel_sigmas']]) {
    expectRange(engine[key], `sar.map.engine_defaults.${key}`, limits[limitName].min, limits[limitName].max);
  }
  expectRange(service.range_m, 'sar.map.service_defaults.range_m', limits.service_range_m.min, limits.service_range_m.max);
  expectRange(service.azimuth_deg, 'sar.map.service_defaults.azimuth_deg', limits.service_azimuth_deg.min, limits.service_azimuth_deg.max);
  expectRange(service.cell_m, 'sar.map.service_defaults.cell_m', limits.service_cell_m.min, limits.service_cell_m.max);
  expectRange(service.beam_deg, 'sar.map.service_defaults.beam_deg', limits.beam_deg.min, limits.beam_deg.max);
  expectRange(service.looks, 'sar.map.service_defaults.looks', limits.looks.min, limits.looks.max);
  expectRange(service.dbs_factor, 'sar.map.service_defaults.dbs_factor', limits.dbs_factor_service.min, limits.dbs_factor_service.max);
  expectBoolean(service.stc, 'sar.map.service_defaults.stc');
  expectBoolean(service.shadow, 'sar.map.service_defaults.shadow');
  expectBoolean(service.peak_norm, 'sar.map.service_defaults.peak_norm');

  const collection = expectObject(map.collection, 'sar.map.collection');
  requireKeys(collection, ['cells_max', 'rows_max', 'step_min_m', 'step_max_m', 'pose_interval_s'], 'sar.map.collection');
  expectInteger(collection.cells_max, 'sar.map.collection.cells_max');
  expectInteger(collection.rows_max, 'sar.map.collection.rows_max');
  expectPositive(collection.step_min_m, 'sar.map.collection.step_min_m');
  expectPositive(collection.step_max_m, 'sar.map.collection.step_max_m');
  if (collection.step_min_m > collection.step_max_m) fail('sar.map.collection', 'step_min_m > step_max_m');
  expectPositive(collection.pose_interval_s, 'sar.map.collection.pose_interval_s');

  const dbs = expectObject(map.dbs, 'sar.map.dbs');
  requireKeys(dbs, ['cell_m', 'span_min_m', 'span_max_m', 'span_default_m', 'sharpens', 'sharpen_default', 'near_forward_deg'], 'sar.map.dbs');
  expectPositive(dbs.cell_m, 'sar.map.dbs.cell_m');
  expectPositive(dbs.span_min_m, 'sar.map.dbs.span_min_m');
  expectPositive(dbs.span_max_m, 'sar.map.dbs.span_max_m');
  expectPositive(dbs.span_default_m, 'sar.map.dbs.span_default_m');
  if (dbs.span_min_m > dbs.span_default_m || dbs.span_default_m > dbs.span_max_m) fail('sar.map.dbs', 'span default outside limits');
  expectArray(dbs.sharpens, 'sar.map.dbs.sharpens').forEach((value, index) => expectPositive(value, `sar.map.dbs.sharpens[${index}]`));
  expectPositive(dbs.sharpen_default, 'sar.map.dbs.sharpen_default');
  if (!dbs.sharpens.includes(dbs.sharpen_default)) fail('sar.map.dbs.sharpen_default', 'must be one of sharpens');
  expectFinite(dbs.near_forward_deg, 'sar.map.dbs.near_forward_deg');

  const pfa = expectObject(spec.pfa, 'sar.pfa');
  requireKeys(pfa, ['max_grid', 'min_grid', 'grid_margin', 'nyquist_margin', 'radial_min_grid', 'decimation_max'], 'sar.pfa');
  expectPositive(pfa.max_grid, 'sar.pfa.max_grid');
  expectPositive(pfa.min_grid, 'sar.pfa.min_grid');
  if (pfa.min_grid > pfa.max_grid) fail('sar.pfa', 'min_grid > max_grid');
  expectPositive(pfa.grid_margin, 'sar.pfa.grid_margin');
  expectPositive(pfa.nyquist_margin, 'sar.pfa.nyquist_margin');
  expectPositive(pfa.radial_min_grid, 'sar.pfa.radial_min_grid');
  expectPositive(pfa.decimation_max, 'sar.pfa.decimation_max');

  const geometry = expectObject(spec.geometry, 'sar.geometry');
  requireKeys(geometry, ['trajectory_min_frames', 'trajectory_max_frames', 'trajectory_max_gap_s', 'trajectory_max_speed_mps', 'aperture_min_s', 'aperture_max_s', 'clearance_min_m', 'max_relief_m', 'min_transverse_aperture_m', 'terrain_geometry_tolerance_m'], 'sar.geometry');
  expectPositive(geometry.trajectory_min_frames, 'sar.geometry.trajectory_min_frames');
  expectPositive(geometry.trajectory_max_frames, 'sar.geometry.trajectory_max_frames');
  if (geometry.trajectory_min_frames >= geometry.trajectory_max_frames) fail('sar.geometry', 'trajectory_min_frames >= trajectory_max_frames');
  expectPositive(geometry.trajectory_max_gap_s, 'sar.geometry.trajectory_max_gap_s');
  expectPositive(geometry.trajectory_max_speed_mps, 'sar.geometry.trajectory_max_speed_mps');
  expectPositive(geometry.aperture_min_s, 'sar.geometry.aperture_min_s');
  expectPositive(geometry.aperture_max_s, 'sar.geometry.aperture_max_s');
  if (geometry.aperture_min_s >= geometry.aperture_max_s) fail('sar.geometry', 'aperture_min_s >= aperture_max_s');
  expectFinite(geometry.clearance_min_m, 'sar.geometry.clearance_min_m');
  expectPositive(geometry.max_relief_m, 'sar.geometry.max_relief_m');
  expectPositive(geometry.min_transverse_aperture_m, 'sar.geometry.min_transverse_aperture_m');
  expectFinite(geometry.terrain_geometry_tolerance_m, 'sar.geometry.terrain_geometry_tolerance_m');

  const scene = expectObject(spec.scene, 'sar.scene');
  requireKeys(scene, ['max_objects', 'object_visit_max', 'object_bbox_max_m', 'object_axis_tolerance', 'object_pos_abs_max_m', 'object_scatter_budget', 'model_objects_max', 'surface_grid_cells_expr'], 'sar.scene');
  expectInteger(scene.max_objects, 'sar.scene.max_objects');
  expectInteger(scene.object_visit_max, 'sar.scene.object_visit_max');
  expectPositive(scene.object_bbox_max_m, 'sar.scene.object_bbox_max_m');
  expectPositive(scene.object_axis_tolerance, 'sar.scene.object_axis_tolerance');
  expectPositive(scene.object_pos_abs_max_m, 'sar.scene.object_pos_abs_max_m');
  expectPositive(scene.object_scatter_budget, 'sar.scene.object_scatter_budget');
  expectPositive(scene.model_objects_max, 'sar.scene.model_objects_max');
  expectString(scene.surface_grid_cells_expr, 'sar.scene.surface_grid_cells_expr');

  const render = expectObject(spec.render, 'sar.render');
  requireKeys(render, ['default_scene_model', 'scene_models', 'default_focuser', 'focusers', 'windows', 'range_interpolations', 'scatter_spacings_m', 'widths_px', 'shadow_looks', 'default_seed', 'default_shadow', 'default_shadow_look', 'db_floor_ref', 'db_ref'], 'sar.render');
  expectString(render.db_ref, 'sar.render.db_ref');
  for (const [key, list] of Object.entries({ scene_models: render.scene_models, focusers: render.focusers, windows: render.windows, range_interpolations: render.range_interpolations, scatter_spacings_m: render.scatter_spacings_m, widths_px: render.widths_px, shadow_looks: render.shadow_looks })) {
    const values = expectArray(list, `sar.render.${key}`);
    if (values.length === 0) fail(`sar.render.${key}`, 'must not be empty');
    if (new Set(values).size !== values.length) fail(`sar.render.${key}`, 'must be unique');
  }
  for (const [key, value] of [['default_scene_model', render.default_scene_model], ['default_focuser', render.default_focuser], ['default_shadow_look', render.default_shadow_look]]) {
    const list = key === 'default_scene_model' ? render.scene_models : key === 'default_focuser' ? render.focusers : render.shadow_looks;
    if (!list.includes(value)) fail(`sar.render.${key}`, `"${value}" is not in the allowed list`);
  }
  expectInteger(render.default_seed, 'sar.render.default_seed');
  expectBoolean(render.default_shadow, 'sar.render.default_shadow');
  if (!render.scatter_spacings_m.includes(profiles.fast.scatter_spacing_m)) fail('sar.render.scatter_spacings_m', 'missing fast scatter spacing');
  for (const footprint of Object.values(footprints)) if (!render.scatter_spacings_m.includes(footprint.scatter_spacing_m)) fail('sar.render.scatter_spacings_m', 'missing footprint scatter spacing');
  for (const profile of Object.values(profiles)) if (profile.width !== undefined && !render.widths_px.includes(profile.width)) fail('sar.render.widths_px', 'missing profile width');
  for (const footprint of Object.values(footprints)) if (footprint.width !== undefined && !render.widths_px.includes(footprint.width)) fail('sar.render.widths_px', 'missing footprint width');
}

function validateProtocol(spec, display) {
  expectString(spec.host, 'protocol.host');
  const ports = expectObject(spec.ports, 'protocol.ports');
  requireKeys(ports, ['aa_export', 'aa_http', 'sar_tcp', 'sar_http', 'sar_scene'], 'protocol.ports');
  const seen = new Set();
  for (const [name, value] of Object.entries(ports)) {
    expectInteger(value, `protocol.ports.${name}`);
    if (value < 1 || value > 65535) fail(`protocol.ports.${name}`, 'must be in [1, 65535]');
    if (seen.has(value)) fail(`protocol.ports.${name}`, `duplicate port ${value}`);
    seen.add(value);
  }
  const versions = expectObject(spec.versions, 'protocol.versions');
  requireKeys(versions, ['aa', 'sar', 'sar_caps', 'scene', 'scene_caps'], 'protocol.versions');
  for (const [name, value] of Object.entries(versions)) {
    if (name.endsWith('_caps')) expectInteger(value, `protocol.versions.${name}`);
    else expectString(value, `protocol.versions.${name}`);
  }
  const aa = expectObject(spec.aa, 'protocol.aa');
  requireKeys(aa, ['sample_rate_hz', 'line_ending', 'coalition_values', 'vel_valid_values', 'rows'], 'protocol.aa');
  expectPositive(aa.sample_rate_hz, 'protocol.aa.sample_rate_hz');
  expectString(aa.line_ending, 'protocol.aa.line_ending');
  for (const [key, list] of [['coalition_values', aa.coalition_values], ['vel_valid_values', aa.vel_valid_values]]) {
    expectArray(list, `protocol.aa.${key}`).forEach((value, index) => expectFinite(value, `protocol.aa.${key}[${index}]`));
  }
  const rows = expectObject(aa.rows, 'protocol.aa.rows');
  requireKeys(rows, ['V1', 'P', 'A', 'O', 'T', 'L', 'E'], 'protocol.aa.rows');
  for (const [name, row] of Object.entries(rows)) {
    const context = `protocol.aa.rows.${name}`;
    if (row.fields !== undefined) {
      if (Array.isArray(row.fields)) row.fields.forEach((value, index) => expectPositive(value, `${context}.fields[${index}]`));
      else expectPositive(row.fields, `${context}.fields`);
    }
    if (row.min_fields !== undefined) expectPositive(row.min_fields, `${context}.min_fields`);
    if (row.legacy_fields !== undefined) expectArray(row.legacy_fields, `${context}.legacy_fields`).forEach((value, index) => expectPositive(value, `${context}.legacy_fields[${index}]`));
    if (row.fields === undefined && row.min_fields === undefined) fail(context, 'needs fields or min_fields');
  }
  const sar = expectObject(spec.sar, 'protocol.sar');
  requireKeys(sar, ['status_rate_hz', 'pose_rate_hz', 'default_size_m', 'default_n', 'duration_s', 'default_footprint', 'capture', 'image_window', 'map', 'rows', 'commands'], 'protocol.sar');
  expectPositive(sar.status_rate_hz, 'protocol.sar.status_rate_hz');
  expectPositive(sar.pose_rate_hz, 'protocol.sar.pose_rate_hz');
  expectPositive(sar.default_size_m, 'protocol.sar.default_size_m');
  expectPositive(sar.default_n, 'protocol.sar.default_n');
  expectPositive(sar.duration_s, 'protocol.sar.duration_s');
  expectString(sar.default_footprint, 'protocol.sar.default_footprint');
  const capture = expectObject(sar.capture, 'protocol.sar.capture');
  requireKeys(capture, ['min_range_m', 'max_range_m', 'side_values', 'size_n_pairs'], 'protocol.sar.capture');
  expectPositive(capture.min_range_m, 'protocol.sar.capture.min_range_m');
  expectPositive(capture.max_range_m, 'protocol.sar.capture.max_range_m');
  if (!(capture.min_range_m < capture.max_range_m)) fail('protocol.sar.capture', 'min_range_m >= max_range_m');
  expectArray(capture.side_values, 'protocol.sar.capture.side_values').forEach((value, index) => expectFinite(value, `protocol.sar.capture.side_values[${index}]`));
  for (const [index, pair] of expectArray(capture.size_n_pairs, 'protocol.sar.capture.size_n_pairs').entries()) {
    if (!Array.isArray(pair) || pair.length !== 2) fail(`protocol.sar.capture.size_n_pairs[${index}]`, 'must be [size, n]');
    expectPositive(pair[0], `protocol.sar.capture.size_n_pairs[${index}][0]`);
    expectPositive(pair[1], `protocol.sar.capture.size_n_pairs[${index}][1]`);
  }
  const imageWindow = expectObject(sar.image_window, 'protocol.sar.image_window');
  requireKeys(imageWindow, ['min_angle_deg', 'max_angle_deg'], 'protocol.sar.image_window');
  expectPositive(imageWindow.min_angle_deg, 'protocol.sar.image_window.min_angle_deg');
  expectPositive(imageWindow.max_angle_deg, 'protocol.sar.image_window.max_angle_deg');
  if (!(imageWindow.min_angle_deg < imageWindow.max_angle_deg)) fail('protocol.sar.image_window', 'min >= max');
  if (imageWindow.max_angle_deg > 180) fail('protocol.sar.image_window.max_angle_deg', 'must be <= 180');
  const map = expectObject(sar.map, 'protocol.sar.map');
  requireKeys(map, ['cells_max', 'rows_max', 'step_min_m', 'step_max_m', 'pose_interval_s', 'job_timeout_ms', 'surface_token_max_chars', 'surface_parts_max', 'grid_layout'], 'protocol.sar.map');
  for (const key of ['cells_max', 'rows_max', 'step_min_m', 'step_max_m', 'pose_interval_s', 'job_timeout_ms', 'surface_token_max_chars', 'surface_parts_max']) {
    expectPositive(map[key], `protocol.sar.map.${key}`);
  }
  expectString(map.grid_layout, 'protocol.sar.map.grid_layout');
  const limits = expectObject(spec.limits, 'protocol.limits');
  requireKeys(limits, ['aa_line_max_chars', 'aa_recv_buffer_bytes', 'sar_command_max_chars', 'sar_server_line_max_chars', 'recv_buffer_bytes', 'sar_export_pending_max_bytes', 'scene_line_max_chars', 'scene_recv_buffer_bytes', 'scene_pending_max_bytes', 'scene_partial_fragment_max_chars', 'map_surface_max_chars'], 'protocol.limits');
  if (limits.aa_line_max_chars !== null) expectPositive(limits.aa_line_max_chars, 'protocol.limits.aa_line_max_chars');
  if (limits.aa_recv_buffer_bytes !== null) expectPositive(limits.aa_recv_buffer_bytes, 'protocol.limits.aa_recv_buffer_bytes');
  for (const [key, value] of Object.entries(limits)) {
    if (value !== null) expectPositive(value, `protocol.limits.${key}`);
  }
  const timeouts = expectObject(spec.timeouts, 'protocol.timeouts');
  for (const [key, value] of Object.entries(timeouts)) expectPositive(value, `protocol.timeouts.${key}`);
  const scene = expectObject(spec.scene, 'protocol.scene');
  for (const key of ['object_max', 'object_visit_max', 'mover_max', 'mover_radius_max_m', 'mover_visit_max', 'mover_lines_per_step', 'mover_search_s', 'mover_min_speed_mps', 'mover_timeout_ms']) {
    expectPositive(scene[key], `protocol.scene.${key}`);
  }
  const sceneRows = expectObject(scene.rows, 'protocol.scene.rows');
  requireKeys(sceneRows, ['HELLO', 'CAP', 'SURFACE', 'OBJECT', 'SCENE_END', 'MOVER', 'MOVER_END', 'MOVER_FAIL', 'FAIL', 'BRIDGE_ERROR'], 'protocol.scene.rows');
  const sarRows = expectObject(sar.rows, 'protocol.sar.rows');
  requireKeys(sarRows, ['HELLO', 'CAPS', 'STATUS', 'BEGIN', 'TARGET', 'HEIGHT', 'SURFACE', 'POSE', 'END', 'FAIL', 'MAPBEGIN', 'MAPGRID', 'MAPHEIGHT', 'MAPSURFACE', 'MAPPOSE', 'MAPEND'], 'protocol.sar.rows');
  for (const [groupName, group] of [['sar', sarRows], ['scene', sceneRows]]) {
    for (const [name, row] of Object.entries(group)) {
      const context = `protocol.${groupName}.rows.${name}`;
      if (row.fields !== undefined) {
        if (Array.isArray(row.fields)) row.fields.forEach((value, index) => expectPositive(value, `${context}.fields[${index}]`));
        else expectPositive(row.fields, `${context}.fields`);
      } else fail(context, 'missing fields');
    }
  }
  for (const [groupName, group] of [['sar', sar.commands], ['scene', scene.commands]]) {
    for (const [name, row] of Object.entries(group)) {
      const context = `protocol.${groupName}.commands.${name}`;
      if (Array.isArray(row.fields)) row.fields.forEach((value, index) => expectPositive(value, `${context}.fields[${index}]`));
      else expectPositive(row.fields, `${context}.fields`);
    }
  }
  const mosaic = expectObject(spec.mosaic, 'protocol.mosaic');
  requireKeys(mosaic, ['limit', 'poll_ms', 'db_step', 'no_data'], 'protocol.mosaic');
  const db = expectObject(spec.db, 'protocol.db');
  requireKeys(db, ['step', 'no_data', 'clamp_min', 'clamp_max'], 'protocol.db');
  if (mosaic.limit !== display.mosaic.limit) fail('protocol.mosaic.limit', 'must equal display.mosaic.limit');
  if (mosaic.poll_ms !== display.mosaic.poll_ms) fail('protocol.mosaic.poll_ms', 'must equal display.mosaic.poll_ms');
  if (db.step !== display.db.step) fail('protocol.db.step', 'must equal display.db.step');
  if (db.no_data !== display.db.no_data) fail('protocol.db.no_data', 'must equal display.db.no_data');
  if (db.clamp_min !== display.db.clamp_min) fail('protocol.db.clamp_min', 'must equal display.db.clamp_min');
  if (db.clamp_max !== display.db.clamp_max) fail('protocol.db.clamp_max', 'must equal display.db.clamp_max');
}

function validateDeployment(spec) {
  const saved = expectObject(spec.saved_games, 'deployment.saved_games');
  requireKeys(saved, ['path_env', 'default_candidates', 'cli_flag', 'selection', 'scripts_root', 'logs_root'], 'deployment.saved_games');
  expectString(saved.path_env, 'deployment.saved_games.path_env');
  expectString(saved.cli_flag, 'deployment.saved_games.cli_flag');
  expectString(saved.selection, 'deployment.saved_games.selection');
  const candidates = expectArray(saved.default_candidates, 'deployment.saved_games.default_candidates');
  if (candidates.length === 0) fail('deployment.saved_games.default_candidates', 'must not be empty');
  for (const [index, candidate] of candidates.entries()) {
    const text = expectString(candidate, `deployment.saved_games.default_candidates[${index}]`);
    if (/^[A-Za-z]:[\\/]/.test(text) || text.startsWith('/')) fail(`deployment.saved_games.default_candidates[${index}]`, 'machine-absolute paths are not allowed');
  }
  for (const key of ['scripts_root', 'logs_root']) {
    const text = expectString(saved[key], `deployment.saved_games.${key}`);
    if (text.includes('..')) fail(`deployment.saved_games.${key}`, 'must not contain ".."');
  }
  const products = expectObject(spec.products, 'deployment.products');
  requireKeys(products, ['aa_export', 'sar_export', 'sar_scene', 'agradar', 'fc'], 'deployment.products');
  for (const [name, product] of Object.entries(products)) {
    const context = `deployment.products.${name}`;
    expectObject(product, context);
    const paths = [];
    for (const [key, value] of Object.entries(product)) {
      if (key === 'sources') { expectArray(value, `${context}.sources`); continue; }
      if (key === 'log_files') { expectArray(value, `${context}.log_files`); continue; }
      if (typeof value === 'string' && (key.includes('script') || key === 'hook' || key === 'dll' || key.endsWith('_dll') || key === 'manifest' || key === 'diag_log' || key === 'log_dir' || key === 'experiment_config')) paths.push([key, value]);
    }
    for (const [key, value] of paths) {
      if (value.includes('..')) fail(`${context}.${key}`, 'must not contain ".."');
      if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/')) fail(`${context}.${key}`, 'machine-absolute paths are not allowed');
      if ((key === 'dll' || key.endsWith('_dll')) && !value.endsWith('.dll')) fail(`${context}.${key}`, 'must end with .dll');
    }
  }
  const native = expectObject(spec.native, 'deployment.native');
  for (const key of ['agradar_dll_name', 'fc_trace_dll_name', 'fc_inject_dll_name', 'fc_log_dir']) expectString(native[key], `deployment.native.${key}`);
}

function validateDisplay(spec) {
  const db = expectObject(spec.db, 'display.db');
  requireKeys(db, ['step', 'no_data', 'clamp_min', 'clamp_max', 'floor_db', 'peak_norm_default', 'refs', 'ref_by_product'], 'display.db');
  if (db.step !== 0.25) fail('display.db.step', 'must be 0.25 (wire Int8 scale)');
  if (db.no_data !== -128) fail('display.db.no_data', 'must be -128');
  if (db.clamp_min !== -127) fail('display.db.clamp_min', 'must be -127');
  expectInteger(db.clamp_max, 'display.db.clamp_max');
  expectFinite(db.floor_db, 'display.db.floor_db');
  if (!(db.floor_db < db.clamp_min * db.step)) fail('display.db.floor_db', 'must be below the Int8 floor');
  expectBoolean(db.peak_norm_default, 'display.db.peak_norm_default');
  const refs = expectArray(db.refs, 'display.db.refs');
  for (const value of ['fixed_material', 'frame_peak']) if (!refs.includes(value)) fail('display.db.refs', `missing "${value}"`);
  const byProduct = expectObject(db.ref_by_product, 'display.db.ref_by_product');
  for (const [product, ref] of Object.entries(byProduct)) {
    expectString(ref, `display.db.ref_by_product.${product}`);
    if (!refs.includes(ref)) fail(`display.db.ref_by_product.${product}`, `"${ref}" is not in display.db.refs`);
  }
  if (byProduct.sar === byProduct.map) fail('display.db.ref_by_product', 'SAR and MAP must not share one unlabelled dB scale');
  const mosaic = expectObject(spec.mosaic, 'display.mosaic');
  requireKeys(mosaic, ['limit', 'poll_ms', 'fade_min', 'state_since', 'image_endpoint', 'snapshot_endpoint'], 'display.mosaic');
  if (mosaic.limit !== 50) fail('display.mosaic.limit', 'must be 50');
  if (mosaic.poll_ms !== 700) fail('display.mosaic.poll_ms', 'must be 700');
  expectRange(mosaic.fade_min, 'display.mosaic.fade_min', 0, 1);
  expectBoolean(mosaic.state_since, 'display.mosaic.state_since');
  for (const key of ['image_endpoint', 'snapshot_endpoint']) expectString(mosaic[key], `display.mosaic.${key}`);
  // D3: one endpoint names an image sequence; the page and the baseline both fetch it by seq.
  if (mosaic.image_endpoint !== '/image/<seq>') fail('display.mosaic.image_endpoint', 'must be /image/<seq>');
  const sar = expectObject(spec.sar, 'display.sar');
  requireKeys(sar, ['range', 'side_window', 'default_range_km', 'contrast_db_options', 'contrast_default_db', 'map', 'dbs', 'sweep', 'colors'], 'display.sar');
  const range = expectObject(sar.range, 'display.sar.range');
  requireKeys(range, ['min_m', 'max_m'], 'display.sar.range');
  expectPositive(range.min_m, 'display.sar.range.min_m');
  expectPositive(range.max_m, 'display.sar.range.max_m');
  if (!(range.min_m < range.max_m)) fail('display.sar.range', 'min_m >= max_m');
  const side = expectObject(sar.side_window, 'display.sar.side_window');
  requireKeys(side, ['min_abs_deg', 'max_abs_deg'], 'display.sar.side_window');
  expectPositive(side.min_abs_deg, 'display.sar.side_window.min_abs_deg');
  expectPositive(side.max_abs_deg, 'display.sar.side_window.max_abs_deg');
  expectPositive(sar.default_range_km, 'display.sar.default_range_km');
  const contrast = expectArray(sar.contrast_db_options, 'display.sar.contrast_db_options');
  if (!contrast.includes(sar.contrast_default_db)) fail('display.sar.contrast_default_db', 'must be one of contrast_db_options');
  for (const [key, value] of Object.entries(sar.map)) expectPositive(value, `display.sar.map.${key}`);
  expectArray(sar.dbs.sharpens, 'display.sar.dbs.sharpens').forEach((value, index) => expectPositive(value, `display.sar.dbs.sharpens[${index}]`));
  expectPositive(sar.dbs.default_sharpen, 'display.sar.dbs.default_sharpen');
  expectPositive(sar.dbs.near_forward_deg, 'display.sar.dbs.near_forward_deg');
  for (const key of ['min_angle_deg', 'max_angle_deg', 'min_range_m', 'max_range_m']) expectPositive(sar.sweep[key], `display.sar.sweep.${key}`);
  const colors = expectObject(sar.colors, 'display.sar.colors');
  expectString(colors.background, 'display.sar.colors.background');
  expectArray(colors.legend_gradient, 'display.sar.colors.legend_gradient').forEach((value, index) => expectString(value, `display.sar.colors.legend_gradient[${index}]`));
  const aa = expectObject(spec.aa, 'display.aa');
  requireKeys(aa, ['kt_per_mps', 'nm_per_km', 'm_per_nm', 'ft_per_m', 'range_scale_nm', 'colors'], 'display.aa');
  for (const key of ['kt_per_mps', 'nm_per_km', 'm_per_nm', 'ft_per_m']) expectPositive(aa[key], `display.aa.${key}`);
  expectArray(aa.range_scale_nm, 'display.aa.range_scale_nm').forEach((value, index) => expectPositive(value, `display.aa.range_scale_nm[${index}]`));
  expectObject(aa.colors, 'display.aa.colors');
}

function validateCrossFile(resolved) {
  const physics = resolved['physics.json'];
  const radar = resolved['radar.json'];
  const sar = resolved['sar.json'];
  const protocol = resolved['protocol.json'];
  const display = resolved['display.json'];
  if (radar.radar.earth_radius_m !== physics.constants.earth_radius_m) fail('cross-file', 'radar earth_radius_m differs from physics');
  if (radar.radar.earth_k !== physics.constants.earth_k) fail('cross-file', 'radar earth_k differs from physics');
  if (protocol.sar.capture.min_range_m !== display.sar.range.min_m) fail('cross-file', 'protocol/display SAR min range differ');
  if (protocol.sar.capture.max_range_m !== display.sar.range.max_m) fail('cross-file', 'protocol/display SAR max range differ');
  if (protocol.sar.image_window.min_angle_deg !== display.sar.side_window.min_abs_deg) fail('cross-file', 'protocol/display SAR min angle differ');
  if (protocol.sar.image_window.max_angle_deg !== display.sar.side_window.max_abs_deg) fail('cross-file', 'protocol/display SAR max angle differ');
  if (protocol.sar.map.cells_max !== sar.map.collection.cells_max) fail('cross-file', 'MAP cells_max differs');
  if (protocol.sar.map.rows_max !== sar.map.collection.rows_max) fail('cross-file', 'MAP rows_max differs');
  if (protocol.sar.map.step_min_m !== sar.map.collection.step_min_m) fail('cross-file', 'MAP step_min differs');
  if (protocol.sar.map.step_max_m !== sar.map.collection.step_max_m) fail('cross-file', 'MAP step_max differs');
  if (protocol.sar.map.pose_interval_s !== sar.map.collection.pose_interval_s) fail('cross-file', 'MAP pose interval differs');
  if (protocol.sar.map.job_timeout_ms !== sar.map.limits.job_timeout_ms) fail('cross-file', 'MAP job timeout differs');
  if (protocol.sar.map.grid_layout !== sar.map.engine_defaults.grid_layout) fail('cross-file', 'MAP grid layout differs');
  if (protocol.timeouts.sar_map_job_timeout_ms !== sar.map.limits.job_timeout_ms) fail('cross-file', 'protocol/sar MAP timeout differs');
  if (protocol.timeouts.mover_response_timeout_ms !== sar.map.mover.bridge_timeout_ms) fail('cross-file', 'mover timeout differs');
  if (protocol.scene.mover_timeout_ms !== sar.map.mover.bridge_timeout_ms) fail('cross-file', 'scene mover timeout differs');
  if (protocol.scene.object_max !== sar.scene.max_objects) fail('cross-file', 'scene object max differs');
  if (protocol.scene.object_visit_max !== sar.scene.object_visit_max) fail('cross-file', 'scene object visit max differs');
  if (protocol.scene.mover_max !== sar.map.mover.max) fail('cross-file', 'scene mover max differs');
  if (protocol.scene.mover_radius_max_m !== sar.map.mover.radius_max_m) fail('cross-file', 'scene mover radius differs');
  if (protocol.scene.mover_visit_max !== sar.map.mover.mission_visit_max) fail('cross-file', 'scene mover visit differs');
  if (protocol.scene.mover_lines_per_step !== sar.map.mover.mission_lines_per_step) fail('cross-file', 'scene mover lines differs');
  if (protocol.scene.mover_search_s !== sar.map.mover.mission_search_s) fail('cross-file', 'scene mover search differs');
  if (protocol.scene.mover_min_speed_mps !== sar.map.mover.mission_min_speed_mps) fail('cross-file', 'scene mover min speed differs');
  if (display.sar.map.range_m !== sar.map.service_defaults.range_m) fail('cross-file', 'display MAP range differs');
  if (display.sar.map.azimuth_deg !== sar.map.service_defaults.azimuth_deg) fail('cross-file', 'display MAP azimuth differs');
  if (display.sar.map.cell_m !== sar.map.service_defaults.cell_m) fail('cross-file', 'display MAP cell differs');
  if (display.sar.map.beam_deg !== sar.map.service_defaults.beam_deg) fail('cross-file', 'display MAP beam differs');
  if (display.sar.map.looks !== sar.map.service_defaults.looks) fail('cross-file', 'display MAP looks differs');
  if (display.sar.dbs.default_sharpen !== sar.map.dbs.sharpen_default) fail('cross-file', 'display DBS default sharpen differs');
  if (display.sar.dbs.near_forward_deg !== sar.map.dbs.near_forward_deg) fail('cross-file', 'display DBS near-forward differs');
  if (display.sar.sweep.min_angle_deg !== sar.map.sweep.min_angle_deg) fail('cross-file', 'display sweep min angle differs');
  if (display.sar.sweep.max_angle_deg !== sar.map.sweep.max_angle_deg) fail('cross-file', 'display sweep max angle differs');
  if (display.sar.sweep.min_range_m !== sar.map.sweep.min_range_m) fail('cross-file', 'display sweep min range differs');
  if (display.sar.sweep.max_range_m !== sar.map.sweep.max_range_m) fail('cross-file', 'display sweep max range differs');
  if (sar.render.db_floor_ref !== display.db.floor_db) fail('cross-file', 'SAR db floor differs from display');
  if (sar.render.db_ref !== display.db.ref_by_product.sar) fail('cross-file', 'SAR db_ref differs from display.db.ref_by_product.sar');
  if (sar.map.engine_defaults.db_ref !== display.db.ref_by_product.map) fail('cross-file', 'MAP db_ref differs from display.db.ref_by_product.map');
  const pairs = new Set(protocol.sar.capture.size_n_pairs.map(pair => `${pair[0]}x${pair[1]}`));
  for (const footprint of Object.values(sar.footprints)) {
    if (!pairs.has(`${footprint.size_m}x${footprint.n}`)) fail('cross-file', `protocol size_n_pairs missing ${footprint.size_m}x${footprint.n}`);
  }
  if (pairs.size !== Object.keys(sar.footprints).length) fail('cross-file', 'protocol size_n_pairs has extra entries');
}

function validateSpecs(rawSpecs) {
  const { resolved, origins, refPaths } = resolveSpecs(rawSpecs);
  validateCommon(resolved, rawSpecs, origins);
  validatePhysics(resolved['physics.json']);
  validateRadar(resolved['radar.json']);
  validateSar(resolved['sar.json']);
  validateProtocol(resolved['protocol.json'], resolved['display.json']);
  validateDeployment(resolved['deployment.json']);
  validateDisplay(resolved['display.json']);
  validateCrossFile(resolved);
  return { resolved, origins, refPaths };
}

function sourceLookup(specName, specPath, rawSpecs, origins) {
  const table = specName ? origins[specName] : null;
  const origin = table ? (table[specPath] || findAncestorOrigin(table, specPath)) : null;
  const targetFile = origin ? origin.file : specName;
  const targetPath = origin ? origin.path : specPath;
  if (!targetFile) return null;
  const sourceTable = rawSpecs[targetFile] && rawSpecs[targetFile].sources;
  if (!isPlainObject(sourceTable)) return null;
  for (const candidate of sourceCandidates(targetPath)) {
    if (Object.prototype.hasOwnProperty.call(sourceTable, candidate)) return { ...sourceTable[candidate], spec: targetFile, path: candidate };
  }
  return null;
}

function findAncestorOrigin(table, specPath) {
  for (const candidate of ancestors(specPath)) if (table[candidate]) return table[candidate];
  return null;
}

function ancestors(specPath) {
  const result = [];
  let current = specPath;
  while (current !== '') {
    const next = /\[\d+\]$/.test(current)
      ? current.replace(/\[\d+\]$/, '')
      : current.replace(/\.[^.[\]]+$/, '');
    if (next === current) break;
    current = next;
    result.push(current);
  }
  return [...new Set(result)];
}

function sourceCandidates(specPath) {
  const result = [specPath, specPath.replace(/\[\d+\]/g, '[]')];
  for (const ancestor of ancestors(specPath)) {
    result.push(ancestor);
    result.push(ancestor.replace(/\[\d+\]/g, '[]'));
  }
  return [...new Set(result)].filter(Boolean);
}

function outputToSpecPath(outputPath) {
  const parts = outputPath.split('.');
  const head = parts.shift();
  const rest = parts.join('.');
  if (head === 'physics') return { file: 'physics.json', path: `constants.${rest}` };
  if (head === 'radar') return { file: 'radar.json', path: `radar.${rest}` };
  if (head === 'scheduler') {
    if (rest.startsWith('prf_selection')) return { file: 'radar.json', path: rest };
    return { file: 'radar.json', path: `scheduler.${rest}` };
  }
  if (head === 'tracker') return { file: 'radar.json', path: `tracker.${rest}` };
  if (head === 'deployment') return { file: 'deployment.json', path: rest };
  if (head === 'display') return { file: 'display.json', path: rest };
  return null;
}

function sourceForOutput(outputPath, rawSpecs, origins) {
  const mapped = outputToSpecPath(outputPath);
  if (!mapped) return null;
  return sourceLookup(mapped.file, mapped.path, rawSpecs, origins);
}

function sourceComment(source) {
  if (!source) return '';
  const location = `${source.file}:${source.line}`;
  return ` -- ${location} [${source.class}] ${source.note}`;
}

function luaString(value) {
  return '"' + value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t') + '"';
}

function luaNumber(value) {
  if (!Number.isFinite(value)) throw new Error(`cannot serialise non-finite number ${value}`);
  if (Number.isInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) return String(value);
  return String(value);
}

function luaKey(key) {
  if (/^-?\d+$/.test(key)) return `[${key}]`;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : `[${luaString(key)}]`;
}

function luaValue(value, indent, specPath, sourceResolver) {
  const pad = '  '.repeat(indent);
  if (value === null) return 'false';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return luaNumber(value);
  if (typeof value === 'string') return luaString(value);
  const source = sourceComment(sourceResolver(specPath));
  if (Array.isArray(value)) {
    if (value.length === 0) return `{}${source}`;
    const rows = value.map((item, index) => {
      const childPath = `${specPath}[${index + 1}]`;
      const scalar = item === null || typeof item !== 'object';
      const suffix = scalar ? `,${sourceComment(sourceResolver(childPath))}` : ',';
      return `${pad}  ${luaValue(item, indent + 1, childPath, sourceResolver)}${suffix}`;
    });
    return `{${source}\n${rows.join('\n')}\n${pad}}`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return `{}${source}`;
    const rows = keys.map(key => {
      const childPath = specPath === '' ? key : `${specPath}.${key}`;
      const item = value[key];
      const scalar = item === null || typeof item !== 'object';
      const suffix = scalar ? `,${sourceComment(sourceResolver(childPath))}` : ',';
      return `${pad}  ${luaKey(key)} = ${luaValue(item, indent + 1, childPath, sourceResolver)}${suffix}`;
    });
    return `{${source}\n${rows.join('\n')}\n${pad}}`;
  }
  throw new Error(`cannot serialise ${typeof value} at ${specPath}`);
}

function buildConfigTable(resolved) {
  const radar = resolved['radar.json'];
  const physics = resolved['physics.json'];
  const deployment = resolved['deployment.json'];
  const display = resolved['display.json'];
  return {
    schema: SCHEMA,
    physics: physics.constants,
    radar: radar.radar,
    scheduler: { ...radar.scheduler, prf_selection: radar.prf_selection },
    tracker: radar.tracker,
    deployment: {
      saved_games: deployment.saved_games,
      products: deployment.products,
      native: deployment.native
    },
    display: {
      db: display.db,
      mosaic: display.mosaic,
      sar: display.sar,
      aa: display.aa
    }
  };
}

function buildProtocolTable(resolved) {
  const protocol = resolved['protocol.json'];
  return {
    schema: protocol.schema,
    host: protocol.host,
    ports: protocol.ports,
    versions: protocol.versions,
    aa: protocol.aa,
    sar: protocol.sar,
    scene: protocol.scene,
    limits: protocol.limits,
    timeouts: protocol.timeouts,
    mosaic: protocol.mosaic,
    db: protocol.db
  };
}

function headerLines(commentStyle, inputSha, extra = []) {
  const inputs = SPEC_FILES.map(name => `spec/${name}`).join(', ');
  if (commentStyle === 'lua') {
    return [
      '-- DO NOT EDIT -- generated by scripts/gen_config.cjs',
      `-- inputs: ${inputs}`,
      `-- input-sha256: ${inputSha}`,
      '-- schema: 1',
      ...extra
    ];
  }
  if (commentStyle === 'js') {
    return [
      '// DO NOT EDIT -- generated by scripts/gen_config.cjs',
      `// inputs: ${inputs}`,
      `// input-sha256: ${inputSha}`,
      '// schema: 1',
      ...extra
    ];
  }
  if (commentStyle === 'c') {
    return [
      '/* DO NOT EDIT -- generated by scripts/gen_config.cjs',
      ` * inputs: ${inputs}`,
      ` * input-sha256: ${inputSha}`,
      ' * schema: 1',
      ...extra.map(line => ` * ${line}`),
      ' */'
    ];
  }
  return [];
}

function generateConfigLua(resolved, rawSpecs, origins, inputSha) {
  const table = buildConfigTable(resolved);
  const sourceResolver = outputPath => sourceForOutput(outputPath, rawSpecs, origins);
  const body = luaValue(table, 0, '', sourceResolver);
  return [
    ...headerLines('lua', inputSha, ['-- source: spec/physics.json, spec/radar.json, spec/deployment.json, spec/display.json']),
    '',
    `local config = ${body}`,
    '',
    'return config',
    ''
  ].join('\n');
}

function generateProtocolLua(resolved, rawSpecs, origins, inputSha) {
  const table = buildProtocolTable(resolved);
  const sourceResolver = specPath => {
    const source = sourceLookup('protocol.json', specPath, rawSpecs, origins);
    return source;
  };
  const body = luaValue(table, 0, '', sourceResolver);
  return [
    ...headerLines('lua', inputSha, ['-- source: spec/protocol.json (with refs into display/sar)']),
    '',
    `local protocol = ${body}`,
    '',
    'return protocol',
    ''
  ].join('\n');
}

function jsValue(value, indent, sourceResolver, specPath) {
  const pad = '  '.repeat(indent);
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[\n${value.map((item, index) => `${pad}  ${jsValue(item, indent + 1, sourceResolver, `${specPath}[${index}]`)}`).join(',\n')}\n${pad}]`;
  }
  const keys = Object.keys(value);
  if (keys.length === 0) return '{}';
  const rows = keys.map(key => {
    const childPath = specPath === '' ? key : `${specPath}.${key}`;
    const source = sourceResolver(childPath);
    const comment = source ? ` // ${source.file}:${source.line}` : '';
    return `${pad}  ${JSON.stringify(key)}: ${jsValue(value[key], indent + 1, sourceResolver, childPath)},${comment}`;
  });
  return `{\n${rows.join('\n')}\n${pad}}`;
}

function generateConfigJs(resolved, rawSpecs, origins, inputSha) {
  const config = buildConfigTable(resolved);
  const sar = resolved['sar.json'];
  const protocol = buildProtocolTable(resolved);
  const combined = {
    schema: SCHEMA,
    physics: config.physics,
    radar: config.radar,
    scheduler: config.scheduler,
    tracker: config.tracker,
    sar: {
      constants: sar.constants,
      profiles: sar.profiles,
      footprints: sar.footprints,
      grids: sar.grids,
      materials: sar.materials,
      surface_classes: sar.surface_classes,
      surface_priority: sar.surface_priority,
      legacy_surfaces: sar.legacy_surfaces,
      map: sar.map,
      pfa: sar.pfa,
      geometry: sar.geometry,
      scene: sar.scene,
      render: sar.render
    },
    protocol,
    deployment: config.deployment,
    display: config.display
  };
  const sourceResolver = outputPath => {
    if (outputPath.startsWith('sar.')) {
      const specPath = outputPath.slice(4);
      return sourceLookup('sar.json', specPath, rawSpecs, origins);
    }
    if (outputPath.startsWith('protocol.')) {
      return sourceLookup('protocol.json', outputPath.slice(9), rawSpecs, origins);
    }
    return sourceForOutput(outputPath, rawSpecs, origins);
  };
  const body = jsValue(combined, 0, sourceResolver, '');
  return [
    ...headerLines('js', inputSha, ['// source: spec/physics.json, spec/radar.json, spec/sar.json, spec/protocol.json, spec/deployment.json, spec/display.json']),
    '',
    "'use strict';",
    '',
    `const CONFIG = ${body};`,
    '',
    'function deepFreeze(value) {',
    '  if (value && typeof value === "object" && !Object.isFrozen(value)) {',
    '    Object.freeze(value);',
    '    for (const key of Object.keys(value)) deepFreeze(value[key]);',
    '  }',
    '  return value;',
    '}',
    '',
    'deepFreeze(CONFIG);',
    '',
    'const exported = {',
    '  ...CONFIG,',
    '  C_MPS: CONFIG.physics.c_mps,',
    '  BOLTZMANN_J_PER_K: CONFIG.physics.boltzmann_j_per_k,',
    '  T0_K: CONFIG.physics.t0_k,',
    '  EARTH_RADIUS_M: CONFIG.physics.earth_radius_m,',
    '  EARTH_K: CONFIG.physics.earth_k,',
    '  LAMBDA_M: CONFIG.radar.lambda_m,',
    '  PRF_PROFILES: CONFIG.radar.prf,',
    '  SAR_PROFILES: CONFIG.sar.profiles,',
    '  SAR_FOOTPRINTS: CONFIG.sar.footprints,',
    '  SAR_MATERIALS: CONFIG.sar.materials,',
    '  SURFACE_CLASSES: CONFIG.sar.surface_classes,',
    '  SURFACE_PRIORITY: CONFIG.sar.surface_priority,',
    '  MAP_ENGINE_DEFAULTS: CONFIG.sar.map.engine_defaults,',
    '  SAR_MAP_SERVICE_DEFAULTS: CONFIG.sar.map.service_defaults,',
    '  PROTOCOL: CONFIG.protocol',
    '};',
    '',
    'deepFreeze(exported);',
    'module.exports = exported;',
    ''
  ].join('\n');
}

function generateConfigH(resolved, rawSpecs, origins, inputSha) {
  const physics = resolved['physics.json'].constants;
  const protocol = resolved['protocol.json'];
  const sar = resolved['sar.json'];
  const source = specPath => {
    if (specPath.startsWith('constants.')) return sourceLookup('physics.json', specPath, rawSpecs, origins);
    if (specPath.startsWith('map.')) return sourceLookup('sar.json', specPath, rawSpecs, origins);
    return sourceLookup('protocol.json', specPath, rawSpecs, origins);
  };
  const line = (name, value, specPath, note) => {
    const src = source(specPath);
    const suffix = src ? ` /* ${src.file}:${src.line} */` : '';
    const comment = note ? ` /* ${note}${src ? `; ${src.file}:${src.line}` : ''} */` : suffix;
    return `#define ${name} ${value}${comment}`;
  };
  const lines = [];
  lines.push(...headerLines('c', inputSha, ['source: spec/physics.json, spec/protocol.json, spec/sar.json']));
  lines.push('', '#ifndef AESA_GENERATED_CONFIG_H', '#define AESA_GENERATED_CONFIG_H', '');
  lines.push(line('AESA_C_MPS', String(physics.c_mps), 'constants.c_mps'));
  lines.push(line('AESA_BOLTZMANN_J_PER_K', String(physics.boltzmann_j_per_k), 'constants.boltzmann_j_per_k'));
  lines.push(line('AESA_T0_K', String(physics.t0_k), 'constants.t0_k'));
  lines.push(line('AESA_EARTH_RADIUS_M', String(physics.earth_radius_m), 'constants.earth_radius_m'));
  lines.push(line('AESA_EARTH_K', String(physics.earth_k), 'constants.earth_k'));
  lines.push('');
  lines.push(`#define AESA_HOST "${protocol.host}"`);
  for (const [name, value] of Object.entries(protocol.ports)) {
    lines.push(line(`AESA_PORT_${name.toUpperCase()}`, String(value), `ports.${name}`));
  }
  lines.push('');
  lines.push(`#define AESA_AA_PROTOCOL_VERSION "${protocol.versions.aa}"`);
  lines.push(`#define AESA_SAR_PROTOCOL_VERSION "${protocol.versions.sar}"`);
  lines.push(`#define AESA_SCENE_PROTOCOL_VERSION "${protocol.versions.scene}"`);
  lines.push(`#define AESA_SAR_CAPS_VERSION ${protocol.versions.sar_caps}`);
  lines.push('');
  lines.push(line('AESA_AA_LINE_MAX_CHARS', protocol.limits.aa_line_max_chars === null ? '0' : String(protocol.limits.aa_line_max_chars), 'limits.aa_line_max_chars', '0 means no explicit limit'));
  lines.push(line('AESA_SAR_COMMAND_MAX_CHARS', String(protocol.limits.sar_command_max_chars), 'limits.sar_command_max_chars'));
  lines.push(line('AESA_SAR_SERVER_LINE_MAX_CHARS', String(protocol.limits.sar_server_line_max_chars), 'limits.sar_server_line_max_chars'));
  lines.push(line('AESA_RECV_BUFFER_BYTES', String(protocol.limits.recv_buffer_bytes), 'limits.recv_buffer_bytes'));
  lines.push(line('AESA_SCENE_LINE_MAX_CHARS', String(protocol.limits.scene_line_max_chars), 'limits.scene_line_max_chars'));
  lines.push(line('AESA_SCENE_RECV_BUFFER_BYTES', String(protocol.limits.scene_recv_buffer_bytes), 'limits.scene_recv_buffer_bytes'));
  lines.push(line('AESA_MAP_SURFACE_MAX_CHARS', String(protocol.limits.map_surface_max_chars), 'limits.map_surface_max_chars'));
  lines.push('');
  lines.push(line('AESA_SAR_RANGE_MIN_M', String(protocol.sar.capture.min_range_m), 'sar.capture.min_range_m'));
  lines.push(line('AESA_SAR_RANGE_MAX_M', String(protocol.sar.capture.max_range_m), 'sar.capture.max_range_m'));
  lines.push(line('AESA_SAR_SIDE_MIN_DEG', String(protocol.sar.image_window.min_angle_deg), 'sar.image_window.min_angle_deg'));
  lines.push(line('AESA_SAR_SIDE_MAX_DEG', String(protocol.sar.image_window.max_angle_deg), 'sar.image_window.max_angle_deg'));
  lines.push('');
  lines.push(line('AESA_MAP_CELLS_MAX', String(protocol.sar.map.cells_max), 'sar.map.cells_max'));
  lines.push(line('AESA_MAP_ROWS_MAX', String(protocol.sar.map.rows_max), 'sar.map.rows_max'));
  lines.push(line('AESA_MAP_STEP_MIN_M', String(protocol.sar.map.step_min_m), 'sar.map.step_min_m'));
  lines.push(line('AESA_MAP_STEP_MAX_M', String(protocol.sar.map.step_max_m), 'sar.map.step_max_m'));
  lines.push(line('AESA_MAP_JOB_TIMEOUT_MS', String(protocol.sar.map.job_timeout_ms), 'sar.map.job_timeout_ms'));
  lines.push(line('AESA_MAP_CELL_M', String(sar.map.engine_defaults.cell_m), 'map.engine_defaults.cell_m'));
  lines.push(line('AESA_MAP_LOOKS_DEFAULT', String(sar.map.service_defaults.looks), 'map.service_defaults.looks'));
  lines.push('');
  lines.push('#endif /* AESA_GENERATED_CONFIG_H */', '');
  return lines.join('\n');
}

const CONSUMERS = [
  ['physics.constants', 'core/physics, sar_core/waveform, src/native'],
  ['radar.radar', 'core/{beam,detection,physics,scheduler}'],
  ['radar.scheduler.search', 'core/scheduler'],
  ['radar.scheduler.revisit', 'core/scheduler'],
  ['radar.prf_selection', 'core/scheduler'],
  ['radar.tracker', 'core/tracker'],
  ['sar.profiles', 'sar_core/waveform, sar_service, export'],
  ['sar.footprints', 'sar_core/geometry, adapters/dcs/sar_adapter, export'],
  ['sar.grids', 'sar_core/geometry, adapters/dcs/sar_adapter'],
  ['sar.materials', 'sar_core/materials, export, sar_service, viewer'],
  ['sar.surface_classes', 'sar_core/materials, export, sar_service, viewer'],
  ['sar.surface_priority', 'sar_core/materials, sar_service, viewer'],
  ['sar.legacy_surfaces', 'export, sar_service, sar_core/materials'],
  ['sar.map', 'sar_core/map, sar_service, viewer'],
  ['sar.pfa', 'sar_core/pfa'],
  ['sar.geometry', 'sar_core/geometry, adapters/dcs/sar_adapter'],
  ['sar.scene', 'sar_core/geometry, adapters/dcs/sar_adapter'],
  ['sar.render', 'sar_core/{engine,focus}, sar_service'],
  ['protocol.ports', 'export, sar_service, tools/python, native'],
  ['protocol.versions', 'export, scene, sar_service'],
  ['protocol.aa', 'export/aa_protocol, tools/receiver.py, tools/live.py'],
  ['protocol.sar', 'export/sar_protocol, sar_service'],
  ['protocol.scene', 'scene, hooks, sar_service'],
  ['protocol.limits', 'export, sar_service, native'],
  ['protocol.timeouts', 'sar_service'],
  ['protocol.mosaic', 'sar_service, viewer'],
  ['protocol.db', 'sar_service, viewer'],
  ['deployment', 'scripts/install_*, src/hooks, src/native'],
  ['display', 'sar_service, viewer']
];

function consumersFor(specFileName, specPath) {
  const fullPath = `${specFileName.replace(/\.json$/, '')}.${specPath}`;
  let best = null;
  for (const [prefix, consumers] of CONSUMERS) {
    if (fullPath === prefix || fullPath.startsWith(prefix + '.')) {
      if (!best || prefix.length > best[0].length) best = [prefix, consumers];
    }
  }
  return best ? best[1] : '—';
}

function markdownValue(value) {
  const text = JSON.stringify(value);
  return `\`${text.replace(/\|/g, '\\|')}\``;
}

function markdownSource(source) {
  if (!source) return '—';
  return `\`${source.file}:${source.line}\` [${source.class}] ${source.note.replace(/\|/g, '\\|')}`;
}

function collectRows(specName, node, specPath, rows, refPaths, origins, rawSpecs) {
  if (isPlainObject(node)) {
    for (const [key, value] of Object.entries(node)) {
      const childPath = specPath === '' ? key : `${specPath}.${key}`;
      collectRows(specName, value, childPath, rows, refPaths, origins, rawSpecs);
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((value, index) => collectRows(specName, value, `${specPath}[${index}]`, rows, refPaths, origins, rawSpecs));
    return;
  }
  rows.push({ path: specPath, value: node, ref: refPaths[specPath] || null, source: sourceLookup(specName, specPath, rawSpecs, origins) });
}

function generateDocs(resolved, rawSpecs, origins, refPaths, inputSha) {
  const lines = [];
  lines.push('# aesa 配置参考');
  lines.push('');
  lines.push('- 状态：current');
  lines.push('- 生成器：`scripts/gen_config.cjs`');
  lines.push(`- input-sha256：\`${inputSha}\``);
  lines.push('- 来源：`spec/physics.json`、`spec/radar.json`、`spec/sar.json`、`spec/protocol.json`、`spec/deployment.json`、`spec/display.json`');
  lines.push('');
  lines.push('> 本文件由生成器从 `spec/*.json` 生成，值不要手改。改参数只改 `spec/`，然后运行 `node scripts/gen_config.cjs`；`--check` 必须零 diff。');
  lines.push('');
  lines.push('## 生成物');
  lines.push('');
  lines.push('| 文件 | 用途 |');
  lines.push('|---|---|');
  lines.push('| `src/shared/config.lua` | A/A + deployment/display 的 Lua 配置表 |');
  lines.push('| `src/shared/protocol.lua` | 端口、版本、行 schema、上限、超时 |');
  lines.push('| `src/shared/config.cjs` | JS 常量：C/λ、SAR profiles/footprints/materials、MAP、protocol |');
  lines.push('| `src/native/generated/config.h` | C 常量：C/玻尔兹曼/T0/地球、端口、上限、MAP 上限 |');
  lines.push('| `tests/fixtures/config.json` | 生成快照，供契约测试导入 |');
  lines.push('| `docs/config-reference.md` | 本文件 |');
  lines.push('');
  lines.push('## 已知冲突');
  lines.push('');
  const conflicts = [];
  for (const name of SPEC_FILES) {
    for (const conflict of rawSpecs[name].known_conflicts || []) conflicts.push({ ...conflict, spec: name });
  }
  if (conflicts.length === 0) lines.push('无。');
  else {
    lines.push('| ID | spec | 主题 | 证据 | 处理 |');
    lines.push('|---|---|---|---|---|');
    for (const conflict of conflicts) {
      lines.push(`| \`${conflict.id}\` | \`spec/${conflict.spec}\` | ${conflict.topic.replace(/\|/g, '\\|')} | ${conflict.evidence.map(item => `\`${item.replace(/\|/g, '\\|')}\``).join('<br>')} | ${conflict.resolution.replace(/\|/g, '\\|')} |`);
    }
  }
  lines.push('');
  lines.push('## 参数表');
  lines.push('');
  lines.push('`source` 是当前代码/文档中的出处；`ref` 表示该值通过 spec 间引用来自另一文件；`consumers` 是迁移后的目标消费者。');
  lines.push('');
  const sections = [
    ['physics.json', '物理常数'],
    ['radar.json', 'A/A 雷达、调度器、跟踪器'],
    ['sar.json', 'SAR 波形、footprint、材质、MAP、PFA'],
    ['protocol.json', '端口、版本、行协议、上限、超时'],
    ['deployment.json', 'Saved Games 部署布局'],
    ['display.json', 'dB、mosaic、显示/量程/颜色']
  ];
  for (const [name, title] of sections) {
    lines.push(`### ${title} (\`spec/${name}\`)`);
    lines.push('');
    lines.push('| 参数 | 值 | 来源 | ref | 消费者 |');
    lines.push('|---|---|---|---|---|');
    const rows = [];
    const spec = { ...resolved[name] };
    for (const key of META_KEYS) delete spec[key];
    collectRows(name, spec, '', rows, refPaths[name], origins[name], rawSpecs);
    for (const row of rows) {
      lines.push(`| \`${row.path}\` | ${markdownValue(row.value)} | ${markdownSource(row.source)} | ${row.ref ? `\`${row.ref}\`` : '—'} | ${consumersFor(name, row.path)} |`);
    }
    lines.push('');
  }
  lines.push('## 尚未迁移的消费者');
  lines.push('');
  lines.push('本任务只建立 spec/生成物与测试，不修改消费者。以下文件仍在使用各自的旧常量/旧键，后续 Gate 或并行迁移任务必须改为从生成物导入：');
  lines.push('');
  const ports = resolved['protocol.json'].ports;
  const versions = resolved['protocol.json'].versions;
  for (const item of [
    '`src/core/*.lua`：A/A 核心直接消费 `src/shared/config.lua`（`core/init.build` 加载）',
    `\`src/export/aesa_export.lua\`：端口 ${ports.aa_export}、\`${versions.aa}\`、10 Hz、A/T/O/L/E 行`,
    `\`src/export/aesa_sar_export.lua\`：端口 ${ports.sar_tcp}、\`${versions.sar}\`、footprint、MAP 上限、1–50 km`,
    `\`src/scene/aesa_sar_mission.lua\` / \`src/hooks/aesa_sar_scene_hook.lua\`：场景桥 ${ports.sar_scene}、mover 上限`,
    '`tools/sar_*.cjs`：SAR 物理默认值、profiles、footprints、materials、MAP/DBS、PFA',
    `\`tools/sar_live.cjs\`：端口 ${ports.sar_tcp}/${ports.sar_http}/${ports.sar_scene}、MAP 服务默认值、mosaic、dB、超时`,
    `\`tools/sar_bridge.cjs\`：${ports.sar_scene}、mover 超时/上限`,
    `\`tools/receiver.py\` / \`tools/live.py\` / \`tools/replay.py\`：${ports.aa_export}/${ports.aa_http}、\`${versions.aa}\` 行 schema`,
    '`tools/sar_viewer.html` / `tools/viewer/index.html`：dB 解码、量程、轮询、颜色、1–50 km/20–160° 文案',
    '`scripts/install_*.cjs` / `scripts/install_export.py`：部署路径、备份后缀、manifest',
    '`src/hooks/*.lua` / `src/native/*/*.c`：DLL 名、日志目录、原生常量'
  ]) lines.push(`- ${item}`);
  lines.push('');
  return lines.join('\n') + '\n';
}

function buildFixture(resolved, rawSpecs, inputSha) {
  const config = buildConfigTable(resolved);
  const sar = resolved['sar.json'];
  const conflicts = [];
  for (const name of SPEC_FILES) {
    for (const conflict of rawSpecs[name].known_conflicts || []) conflicts.push({ ...conflict, spec: name });
  }
  return {
    schema: SCHEMA,
    DO_NOT_EDIT: true,
    generator: GENERATOR,
    input_sha256: inputSha,
    spec_files: SPEC_FILES.map(name => `spec/${name}`),
    config: {
      physics: config.physics,
      radar: config.radar,
      scheduler: config.scheduler,
      tracker: config.tracker,
      sar: {
        constants: sar.constants,
        profiles: sar.profiles,
        footprints: sar.footprints,
        grids: sar.grids,
        materials: sar.materials,
        surface_classes: sar.surface_classes,
        surface_priority: sar.surface_priority,
        legacy_surfaces: sar.legacy_surfaces,
        map: sar.map,
        pfa: sar.pfa,
        geometry: sar.geometry,
        scene: sar.scene,
        render: sar.render
      },
      protocol: buildProtocolTable(resolved),
      deployment: config.deployment,
      display: config.display
    },
    known_conflicts: conflicts
  };
}

function readProfileSpecs() {
  let names;
  try {
    names = fs.readdirSync(PROFILE_SPEC_DIR).filter(name => name.endsWith('.json')).sort();
  } catch (error) {
    throw new Error(`cannot read spec/dcs_profiles: ${error.message}`);
  }
  if (names.length === 0) throw new Error('spec/dcs_profiles must contain at least one .json profile');
  const specs = {};
  for (const name of names) {
    const relative = `spec/dcs_profiles/${name}`;
    const file = path.join(PROFILE_SPEC_DIR, name);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      throw new Error(`cannot read ${relative}: ${error.message}`);
    }
    try {
      specs[name] = JSON.parse(text);
    } catch (error) {
      throw new Error(`invalid JSON in ${relative}: ${error.message}`);
    }
  }
  return specs;
}

function sha256Canonical(value) {
  return crypto.createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

function fnv1a32(text) {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(text, 'utf8')) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function matrixState(value) {
  if (value === undefined || value === null) return 'unknown';
  if (value === true) return 'ok';
  if (value === false) return 'unavailable';
  if (typeof value === 'string') return PROFILE_STATES.has(value) ? value : 'unknown';
  if (isPlainObject(value) && value.state !== undefined) return matrixState(value.state);
  return 'unknown';
}

function matrixEntries(capabilities) {
  const caps = isPlainObject(capabilities) ? capabilities : {};
  return Object.keys(caps).sort().map(key => ({ key, state: matrixState(caps[key]) }));
}

function matrixCanonical(capabilities) {
  return matrixEntries(capabilities).map(entry => `${entry.key}=${entry.state}\n`).join('');
}

function matrixHash(capabilities) {
  return fnv1a32(matrixCanonical(capabilities));
}

function expectHashOrUnknown(value, context) {
  const text = expectString(value, context);
  if (text !== 'unknown' && !PROFILE_HASH_RE.test(text)) {
    fail(context, 'must be a 64-character hex SHA256 or "unknown"');
  }
  return text;
}

function expectProfileSymbols(value, context, expectedCount, withName) {
  const list = expectArray(value, context);
  if (expectedCount !== null && list.length !== expectedCount) {
    fail(context, `must have exactly ${expectedCount} entries`);
  }
  const seen = new Set();
  for (const [index, entry] of list.entries()) {
    const child = `${context}[${index}]`;
    requireKeys(entry, withName ? ['module', 'symbol', 'name', 'status'] : ['module', 'symbol', 'status'], child);
    const moduleName = expectString(entry.module, `${child}.module`);
    if (!PROFILE_MODULE_RE.test(moduleName)) fail(`${child}.module`, 'invalid module name');
    const symbol = expectString(entry.symbol, `${child}.symbol`);
    if (/[\r\n]/.test(symbol)) fail(`${child}.symbol`, 'must not contain newlines');
    if (withName) expectString(entry.name, `${child}.name`);
    if (!PROFILE_SYMBOL_STATUSES.has(entry.status)) {
      fail(`${child}.status`, 'must be "resolved", "missing" or "unknown"');
    }
    const key = `${moduleName}!${symbol}`;
    if (seen.has(key)) fail(child, 'duplicate module!symbol');
    seen.add(key);
  }
  return list;
}

function validateModules(value, context, concrete) {
  const modules = expectObject(value, context);
  const names = Object.keys(modules);
  if (concrete && names.length === 0) fail(context, 'must declare at least one module');
  for (const [name, entry] of Object.entries(modules)) {
    const child = `${context}.${name}`;
    if (!PROFILE_MODULE_RE.test(name)) fail(child, 'invalid module name');
    requireKeys(entry, ['version', 'sha256'], child);
    expectString(entry.version, `${child}.version`);
    const hash = expectHashOrUnknown(entry.sha256, `${child}.sha256`);
    if (concrete && hash === 'unknown') fail(`${child}.sha256`, 'verified profile modules require a SHA256');
  }
}

function validateExportSection(value, context) {
  const section = expectObject(value, context);
  const callbacks = expectObject(section.callbacks, `${context}.callbacks`);
  expectBoolean(callbacks.after_next_frame, `${context}.callbacks.after_next_frame`);
  expectString(callbacks.activity_next_event, `${context}.callbacks.activity_next_event`);
  const fields = expectObject(section.fields, `${context}.fields`);
  for (const group of ['self', 'world_object', 'target']) {
    const entries = expectObject(fields[group], `${context}.fields.${group}`);
    if (Object.keys(entries).length === 0) fail(`${context}.fields.${group}`, 'must not be empty');
    for (const [name, field] of Object.entries(entries)) {
      expectString(field, `${context}.fields.${group}.${name}`);
    }
  }
  const apis = expectObject(section.apis, `${context}.apis`);
  for (const [name, value] of Object.entries(apis)) {
    if (typeof value !== 'boolean' && value !== 'unknown') {
      fail(`${context}.apis.${name}`, 'must be a boolean or "unknown"');
    }
  }
  const geo = expectObject(section.geo, `${context}.geo`);
  for (const key of ['forward', 'inverse', 'order']) expectString(geo[key], `${context}.geo.${key}`);
  if (geo.inverse_alias !== undefined) expectString(geo.inverse_alias, `${context}.geo.inverse_alias`);
  const terrain = expectObject(section.terrain, `${context}.terrain`);
  for (const [name, value] of Object.entries(terrain)) {
    if (typeof value !== 'boolean' && value !== 'unknown') {
      fail(`${context}.terrain.${name}`, 'must be a boolean or "unknown"');
    }
  }
}

function validateMissionSection(value, context) {
  const section = expectObject(value, context);
  for (const group of ['bridge', 'land', 'world', 'objects', 'events', 'timer']) {
    const entries = expectObject(section[group], `${context}.${group}`);
    for (const [name, item] of Object.entries(entries)) {
      if (Array.isArray(item)) {
        item.forEach((entry, index) => expectString(entry, `${context}.${group}.${name}[${index}]`));
      } else if (typeof item !== 'boolean' && item !== 'unknown') {
        fail(`${context}.${group}.${name}`, 'must be a boolean, "unknown" or an array of strings');
      }
    }
  }
}

function validateNativeSection(value, context) {
  const section = expectObject(value, context);
  expectHashOrUnknown(section.exports_sha256, `${context}.exports_sha256`);
  const agr = expectObject(section.agradar, `${context}.agradar`);
  expectProfileSymbols(agr.symbols, `${context}.agradar.symbols`, 4, false);
  if (expectInteger(agr.vtable_slot, `${context}.agradar.vtable_slot`) < 0) {
    fail(`${context}.agradar.vtable_slot`, 'must be >= 0');
  }
  if (expectInteger(agr.point_on_surface_offset, `${context}.agradar.point_on_surface_offset`) < 0) {
    fail(`${context}.agradar.point_on_surface_offset`, 'must be >= 0');
  }
  const classes = expectInteger(agr.surface_classes, `${context}.agradar.surface_classes`);
  if (classes <= 0) fail(`${context}.agradar.surface_classes`, 'must be > 0');
  const bits = expectObject(agr.surface_bits, `${context}.agradar.surface_bits`);
  for (const [bit, name] of Object.entries(bits)) {
    if (!/^\d+$/.test(bit)) fail(`${context}.agradar.surface_bits`, `key "${bit}" must be a bit number`);
    expectString(name, `${context}.agradar.surface_bits.${bit}`);
  }
  if (Object.keys(bits).length !== classes) {
    fail(`${context}.agradar.surface_bits`, `must declare ${classes} classes, got ${Object.keys(bits).length}`);
  }
  const fc = expectObject(section.fc, `${context}.fc`);
  expectProfileSymbols(fc.symbols, `${context}.fc.symbols`, 17, false);
  expectProfileSymbols(fc.sites, `${context}.fc.sites`, 13, true);
  const offsets = expectObject(fc.offsets, `${context}.fc.offsets`);
  for (const key of ['pos', 'vel', 'aim', 'tgo', 'r0', 'range']) {
    if (expectInteger(offsets[key], `${context}.fc.offsets.${key}`) < 0) {
      fail(`${context}.fc.offsets.${key}`, 'must be >= 0');
    }
  }
  expectBoolean(fc.write, `${context}.fc.write`);
}

function validateDataSection(value, context) {
  const data = expectObject(value, context);
  if (expectInteger(data.rcs_schema, `${context}.rcs_schema`) < 1) fail(`${context}.rcs_schema`, 'must be >= 1');
  if (expectInteger(data.rcs_entries, `${context}.rcs_entries`) < 0) fail(`${context}.rcs_entries`, 'must be >= 0');
  const fallbacks = expectArray(data.rcs_required_fallbacks, `${context}.rcs_required_fallbacks`);
  if (fallbacks.length !== 4) fail(`${context}.rcs_required_fallbacks`, 'must have exactly four entries');
  const seen = new Set();
  for (const [index, name] of fallbacks.entries()) {
    expectString(name, `${context}.rcs_required_fallbacks[${index}]`);
    if (seen.has(name)) fail(`${context}.rcs_required_fallbacks`, `duplicate fallback "${name}"`);
    seen.add(name);
  }
  for (const required of ['fighter', 'large', 'helicopter', 'missile']) {
    if (!seen.has(required)) fail(`${context}.rcs_required_fallbacks`, `missing fallback "${required}"`);
  }
  if (expectInteger(data.surface_classes, `${context}.surface_classes`) !== 16) {
    fail(`${context}.surface_classes`, 'must be 16');
  }
}

function validateShaderSection(value, context) {
  const shader = expectObject(value, context);
  expectHashOrUnknown(shader.radar_fx_sha256, `${context}.radar_fx_sha256`);
  if (expectFinite(shader.dbs_lambda, `${context}.dbs_lambda`) <= 0) {
    fail(`${context}.dbs_lambda`, 'must be > 0');
  }
  expectFinite(shader.dbs_omega, `${context}.dbs_omega`);
  const cone = expectFinite(shader.dbs_full_cone_deg, `${context}.dbs_full_cone_deg`);
  if (cone < 0 || cone > 180) fail(`${context}.dbs_full_cone_deg`, 'must be in [0, 180]');
  if (shader.radar_fx_lines !== undefined) {
    const lines = expectObject(shader.radar_fx_lines, `${context}.radar_fx_lines`);
    for (const [name, line] of Object.entries(lines)) {
      if (expectInteger(line, `${context}.radar_fx_lines.${name}`) < 0) {
        fail(`${context}.radar_fx_lines.${name}`, 'must be >= 0');
      }
    }
  }
  expectHashOrUnknown(shader.radar_lua_sha256, `${context}.radar_lua_sha256`);
  const presets = expectObject(shader.radar_lua_presets, `${context}.radar_lua_presets`);
  for (const name of ['EXP1', 'EXP2', 'EXP3']) {
    const preset = expectObject(presets[name], `${context}.radar_lua_presets.${name}`);
    requireKeys(preset, ['resolution', 'omega', 'blank_angle_deg'], `${context}.radar_lua_presets.${name}`);
    if (expectInteger(preset.resolution, `${context}.radar_lua_presets.${name}.resolution`) <= 0) {
      fail(`${context}.radar_lua_presets.${name}.resolution`, 'must be > 0');
    }
    expectFinite(preset.omega, `${context}.radar_lua_presets.${name}.omega`);
    const blank = expectFinite(preset.blank_angle_deg, `${context}.radar_lua_presets.${name}.blank_angle_deg`);
    if (blank < 0 || blank > 180) fail(`${context}.radar_lua_presets.${name}.blank_angle_deg`, 'must be in [0, 180]');
  }
}

function validateCapabilities(value, context) {
  const capabilities = expectObject(value, context);
  for (const [key, item] of Object.entries(capabilities)) {
    const child = `${context}["${key}"]`;
    if (!PROFILE_CAP_KEY_RE.test(key)) fail(child, 'capability key must be UPPER-KEBAB-CASE');
    if (typeof item === 'boolean') continue;
    if (typeof item === 'string') {
      if (!PROFILE_STATES.has(item)) fail(child, 'state must be ok|degraded|unavailable|unknown');
      continue;
    }
    if (isPlainObject(item)) {
      requireKeys(item, ['state'], child);
      if (!PROFILE_STATES.has(item.state)) fail(`${child}.state`, 'state must be ok|degraded|unavailable|unknown');
      if (item.detail !== undefined) expectString(item.detail, `${child}.detail`);
      continue;
    }
    fail(child, 'must be a boolean, state string or {state, detail} object');
  }
  return capabilities;
}

function validateRequired(value, capabilities, context, concrete) {
  const required = expectArray(value, context);
  if (required.length === 0) fail(context, 'must not be empty');
  const seen = new Set();
  for (const [index, key] of required.entries()) {
    expectString(key, `${context}[${index}]`);
    if (seen.has(key)) fail(`${context}[${index}]`, `duplicate required capability "${key}"`);
    seen.add(key);
    if (!Object.prototype.hasOwnProperty.call(capabilities, key)) {
      fail(`${context}[${index}]`, `required capability "${key}" is not declared in capabilities`);
    }
    if (concrete && matrixState(capabilities[key]) !== 'ok') {
      fail(`${context}[${index}]`, `required capability "${key}" must be "ok" in a verified profile`);
    }
  }
}

function runtimeProfile(spec) {
  const data = {};
  for (const [key, value] of Object.entries(spec)) {
    if (key === 'owner' || key === 'active') continue;
    data[key] = value;
  }
  return data;
}

function validateProfileSpec(spec, fileName) {
  const context = `spec/dcs_profiles/${fileName}`;
  requireKeys(spec, ['schema', 'owner', 'id', 'build', 'variant', 'verified', 'evidence', 'required', 'capabilities'], context);
  if (spec.schema !== SCHEMA) fail(`${context}.schema`, `must be ${SCHEMA}`);
  expectString(spec.owner, `${context}.owner`);
  const id = expectString(spec.id, `${context}.id`);
  if (!PROFILE_ID_RE.test(id)) fail(`${context}.id`, 'must match dcs-<build>[-<variant>]');
  if (`${id}.json` !== fileName) fail(`${context}.id`, `file name must be ${id}.json`);
  const build = expectString(spec.build, `${context}.build`);
  const variant = expectString(spec.variant, `${context}.variant`);
  if (!['MT', 'ST', 'unknown'].includes(variant)) fail(`${context}.variant`, 'must be MT, ST or unknown');
  const concrete = build !== 'unknown';
  if (concrete) {
    if (!PROFILE_BUILD_RE.test(build)) fail(`${context}.build`, 'must be four numeric components, e.g. 2.9.30.28738');
    const expected = variant === 'unknown' ? `dcs-${build}` : `dcs-${build}-${variant.toLowerCase()}`;
    if (id !== expected) fail(`${context}.id`, `must be ${expected} for build/variant`);
  } else {
    if (id !== 'dcs-generic') fail(`${context}.id`, 'unknown build is reserved for dcs-generic');
    if (variant !== 'unknown') fail(`${context}.variant`, 'generic profile must use variant "unknown"');
  }
  const verified = expectString(spec.verified, `${context}.verified`);
  if (concrete) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(verified)) fail(`${context}.verified`, 'verified profile requires YYYY-MM-DD');
  } else if (verified !== 'unknown' && !/^\d{4}-\d{2}-\d{2}$/.test(verified)) {
    fail(`${context}.verified`, 'must be YYYY-MM-DD or "unknown"');
  }
  const evidence = expectArray(spec.evidence, `${context}.evidence`);
  if (evidence.length === 0) fail(`${context}.evidence`, 'must not be empty');
  evidence.forEach((item, index) => expectString(item, `${context}.evidence[${index}]`));
  if (spec.active !== undefined) expectBoolean(spec.active, `${context}.active`);
  if (spec.active === true && !concrete) fail(`${context}.active`, 'generic profile cannot be active');
  if (spec.read_only !== undefined) expectBoolean(spec.read_only, `${context}.read_only`);
  if (concrete) {
    requireKeys(spec, ['modules', 'export', 'mission', 'native', 'data', 'shader'], context);
    validateModules(spec.modules, `${context}.modules`, true);
    validateExportSection(spec.export, `${context}.export`);
    validateMissionSection(spec.mission, `${context}.mission`);
    validateNativeSection(spec.native, `${context}.native`);
    validateDataSection(spec.data, `${context}.data`);
    validateShaderSection(spec.shader, `${context}.shader`);
  } else {
    if (spec.modules !== undefined) validateModules(spec.modules, `${context}.modules`, false);
    if (spec.export !== undefined) validateExportSection(spec.export, `${context}.export`);
    if (spec.mission !== undefined) validateMissionSection(spec.mission, `${context}.mission`);
    if (spec.native !== undefined) validateNativeSection(spec.native, `${context}.native`);
    if (spec.data !== undefined) validateDataSection(spec.data, `${context}.data`);
    if (spec.shader !== undefined) validateShaderSection(spec.shader, `${context}.shader`);
  }
  const capabilities = validateCapabilities(spec.capabilities, `${context}.capabilities`);
  validateRequired(spec.required, capabilities, `${context}.required`, concrete);
  return { name: fileName, spec, concrete, data: runtimeProfile(spec), active: spec.active === true };
}

function validateProfileSpecs(profileSpecs) {
  const names = Object.keys(profileSpecs).sort();
  if (names.length === 0) fail('spec/dcs_profiles', 'must contain at least one profile');
  const entries = [];
  const ids = new Set();
  let activeId = null;
  for (const name of names) {
    if (!name.endsWith('.json')) fail(`spec/dcs_profiles/${name}`, 'profile file must end with .json');
    const entry = validateProfileSpec(profileSpecs[name], name);
    if (ids.has(entry.spec.id)) fail(`spec/dcs_profiles/${name}`, `duplicate profile id "${entry.spec.id}"`);
    ids.add(entry.spec.id);
    if (entry.active) {
      if (activeId !== null) fail('spec/dcs_profiles', `multiple active profiles: ${activeId} and ${entry.spec.id}`);
      activeId = entry.spec.id;
    }
    entries.push(entry);
  }
  if (activeId === null) {
    const concrete = entries.filter(entry => entry.concrete);
    if (concrete.length !== 1) {
      fail('spec/dcs_profiles', 'exactly one concrete profile must be active (set "active": true)');
    }
    concrete[0].active = true;
    activeId = concrete[0].spec.id;
  }
  for (const entry of entries) entry.active = entry.spec.id === activeId;
  entries.sort((a, b) => (a.spec.id < b.spec.id ? -1 : a.spec.id > b.spec.id ? 1 : 0));
  return entries;
}

function generateProfileLua(entry, inputSha) {
  const body = luaValue(entry.data, 0, '', () => null);
  return [
    '-- DO NOT EDIT -- generated by scripts/gen_config.cjs',
    `-- source: spec/dcs_profiles/${entry.name}`,
    `-- profile-id: ${entry.spec.id}`,
    `-- profile-sha256: ${sha256Canonical(entry.data)}`,
    `-- inputs: spec/*.json + spec/dcs_profiles/${entry.name}`,
    `-- input-sha256: ${inputSha}`,
    '-- schema: 1',
    '',
    `return ${body}`,
    ''
  ].join('\n');
}

function cString(value) {
  return '"' + String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r') + '"';
}

function cHex(value) {
  return `0x${Number(value).toString(16)}`;
}

function profileMacroPrefix(id) {
  return `AESA_DCS_PROFILE_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

function emitStringArray(lines, name, values) {
  if (values.length === 0) return;
  lines.push(`static const char *const ${name}[] = {`);
  for (const value of values) lines.push(`    ${cString(value)},`);
  lines.push('};');
}

function profileNativeParts(entry) {
  const data = entry.data;
  const native = isPlainObject(data.native) ? data.native : {};
  const agr = isPlainObject(native.agradar) ? native.agradar : {};
  const fc = isPlainObject(native.fc) ? native.fc : {};
  return {
    exportsSha256: native.exports_sha256 || 'unknown',
    modules: isPlainObject(data.modules) ? data.modules : {},
    agr,
    agrSymbols: Array.isArray(agr.symbols) ? agr.symbols : [],
    surfaceClasses: agr.surface_classes !== undefined
      ? agr.surface_classes
      : (isPlainObject(data.data) ? data.data.surface_classes : 0),
    fc,
    fcSymbols: Array.isArray(fc.symbols) ? fc.symbols : [],
    fcSites: Array.isArray(fc.sites) ? fc.sites : [],
    offsets: isPlainObject(fc.offsets) ? fc.offsets : {}
  };
}

function moduleFileName(name) {
  if (name === 'DCS') return 'DCS.exe';
  return name.includes('.') ? name : `${name}.dll`;
}

function emitModuleArrays(lines, prefix, modules) {
  const names = Object.keys(modules);
  lines.push(`#define ${prefix}_MODULE_COUNT ${names.length}`);
  emitStringArray(lines, `${prefix}_MODULE_NAMES`, names.map(moduleFileName));
  emitStringArray(lines, `${prefix}_MODULE_VERSIONS`, names.map(name => modules[name].version));
  emitStringArray(lines, `${prefix}_MODULE_SHA256`, names.map(name => modules[name].sha256));
}

function symbolRows(symbols) {
  return symbols.map(entry => `${entry.module}!${entry.symbol}`);
}

function emitProfileBlock(lines, entry) {
  const prefix = profileMacroPrefix(entry.spec.id);
  const guard = `${prefix}_DEFINED`;
  const data = entry.data;
  const parts = profileNativeParts(entry);
  lines.push(`/* profile: ${entry.spec.id} */`);
  lines.push(`#if !defined(${guard})`);
  lines.push(`#define ${guard} 1`);
  lines.push(`#define ${prefix}_ID ${cString(data.id)}`);
  lines.push(`#define ${prefix}_SCHEMA ${data.schema}`);
  lines.push(`#define ${prefix}_BUILD ${cString(data.build)}`);
  lines.push(`#define ${prefix}_VARIANT ${cString(data.variant)}`);
  lines.push(`#define ${prefix}_VARIANT_MT ${data.variant === 'MT' ? 1 : 0}`);
  lines.push(`#define ${prefix}_VARIANT_ST ${data.variant === 'ST' ? 1 : 0}`);
  lines.push(`#define ${prefix}_EXPORTS_SHA256 ${cString(parts.exportsSha256)}`);
  emitModuleArrays(lines, prefix, parts.modules);
  if (entry.concrete) {
    lines.push(`#define ${prefix}_AGR_VTABLE_SLOT ${parts.agr.vtable_slot}`);
    lines.push(`#define ${prefix}_AGR_POINT_SURFACE_OFF ${cHex(parts.agr.point_on_surface_offset)}`);
    lines.push(`#define ${prefix}_AGR_SURFACE_CLASSES ${parts.surfaceClasses}`);
  } else {
    lines.push('/* native offsets intentionally absent: generic profile is unverified */');
  }
  lines.push(`#define ${prefix}_AGR_SYMBOL_COUNT ${parts.agrSymbols.length}`);
  lines.push(`#define ${prefix}_FC_SYMBOL_COUNT ${parts.fcSymbols.length}`);
  lines.push(`#define ${prefix}_FC_SITE_COUNT ${parts.fcSites.length}`);
  if (entry.concrete) {
    lines.push(`#define ${prefix}_FC_OFF_POS ${cHex(parts.offsets.pos)}`);
    lines.push(`#define ${prefix}_FC_OFF_VEL ${cHex(parts.offsets.vel)}`);
    lines.push(`#define ${prefix}_FC_OFF_AIM ${cHex(parts.offsets.aim)}`);
    lines.push(`#define ${prefix}_FC_OFF_TGO ${cHex(parts.offsets.tgo)}`);
    lines.push(`#define ${prefix}_FC_OFF_R0 ${cHex(parts.offsets.r0)}`);
    lines.push(`#define ${prefix}_FC_OFF_RANGE ${cHex(parts.offsets.range)}`);
  }
  emitStringArray(lines, `${prefix}_AGR_SYMBOLS`, symbolRows(parts.agrSymbols));
  emitStringArray(lines, `${prefix}_FC_SYMBOLS`, symbolRows(parts.fcSymbols));
  emitStringArray(lines, `${prefix}_FC_SITE_SYMBOLS`, symbolRows(parts.fcSites));
  emitStringArray(lines, `${prefix}_FC_SITE_NAMES`, parts.fcSites.map(site => site.name));
  lines.push(`#endif /* ${guard} */`);
}

function generateProfileHeader(entries, inputSha) {
  const active = entries.find(entry => entry.active);
  if (!active) fail('spec/dcs_profiles', 'no active profile selected');
  const data = active.data;
  const parts = profileNativeParts(active);
  const lines = [];
  lines.push('/* DO NOT EDIT -- generated by scripts/gen_config.cjs');
  lines.push(' * inputs: spec/*.json + spec/dcs_profiles/*.json');
  lines.push(` * input-sha256: ${inputSha}`);
  lines.push(` * active: ${active.spec.id}`);
  lines.push(' * schema: 1');
  for (const entry of entries) {
    lines.push(` * profile ${entry.spec.id}: ${sha256Canonical(entry.data)}`);
  }
  lines.push(' */');
  lines.push('');
  lines.push('#ifndef AESA_DCS_PROFILE_H');
  lines.push('#define AESA_DCS_PROFILE_H');
  lines.push('');
  lines.push(`#define AESA_DCS_PROFILE_COUNT ${entries.length}`);
  lines.push('/* Symbol entries are "module!mangled-name"; split on the first \'!\'. */');
  lines.push('');
  for (const entry of entries) {
    emitProfileBlock(lines, entry);
    lines.push('');
  }
  lines.push(`/* active profile: ${active.spec.id} */`);
  lines.push(`#define AESA_DCS_PROFILE_ID ${cString(data.id)}`);
  lines.push(`#define AESA_DCS_PROFILE_SCHEMA ${data.schema}`);
  lines.push(`#define AESA_DCS_BUILD ${cString(data.build)}`);
  lines.push(`#define AESA_DCS_VARIANT ${cString(data.variant)}`);
  lines.push(`#define AESA_DCS_VARIANT_MT ${data.variant === 'MT' ? 1 : 0}`);
  lines.push(`#define AESA_DCS_VARIANT_ST ${data.variant === 'ST' ? 1 : 0}`);
  lines.push(`#define AESA_DCS_EXPORTS_SHA256 ${cString(parts.exportsSha256)}`);
  emitModuleArrays(lines, 'AESA_DCS', parts.modules);
  lines.push(`#define AESA_AGR_VTABLE_SLOT ${parts.agr.vtable_slot}`);
  lines.push(`#define AESA_AGR_POINT_SURFACE_OFF ${cHex(parts.agr.point_on_surface_offset)}`);
  lines.push(`#define AESA_AGR_SURFACE_CLASSES ${parts.surfaceClasses}`);
  lines.push(`#define AESA_AGR_SYMBOL_COUNT ${parts.agrSymbols.length}`);
  lines.push(`#define AESA_FC_OFF_POS ${cHex(parts.offsets.pos)}`);
  lines.push(`#define AESA_FC_OFF_VEL ${cHex(parts.offsets.vel)}`);
  lines.push(`#define AESA_FC_OFF_AIM ${cHex(parts.offsets.aim)}`);
  lines.push(`#define AESA_FC_OFF_TGO ${cHex(parts.offsets.tgo)}`);
  lines.push(`#define AESA_FC_OFF_R0 ${cHex(parts.offsets.r0)}`);
  lines.push(`#define AESA_FC_OFF_RANGE ${cHex(parts.offsets.range)}`);
  lines.push(`#define AESA_FC_SYMBOL_COUNT ${parts.fcSymbols.length}`);
  lines.push(`#define AESA_FC_SITE_COUNT ${parts.fcSites.length}`);
  emitStringArray(lines, 'AESA_AGR_SYMBOLS', symbolRows(parts.agrSymbols));
  emitStringArray(lines, 'AESA_FC_SYMBOLS', symbolRows(parts.fcSymbols));
  emitStringArray(lines, 'AESA_FC_SITE_SYMBOLS', symbolRows(parts.fcSites));
  emitStringArray(lines, 'AESA_FC_SITE_NAMES', parts.fcSites.map(site => site.name));
  lines.push('');
  lines.push('#endif /* AESA_DCS_PROFILE_H */');
  lines.push('');
  return lines.join('\n');
}

function buildProfileFixture(entries, inputSha) {
  return {
    schema: 1,
    DO_NOT_EDIT: true,
    generator: GENERATOR,
    input_sha256: inputSha,
    matrix_algorithm: 'fnv1a32',
    matrix_format: 'sorted KEY=state rows joined with \\n, trailing \\n',
    spec_files: entries.map(entry => `spec/dcs_profiles/${entry.name}`),
    profiles: entries.map(entry => ({
      id: entry.spec.id,
      file: `${PROFILE_OUTPUT_DIR}/${entry.spec.id}.lua`,
      active: entry.active,
      profile_sha256: sha256Canonical(entry.data),
      matrix_hash: matrixHash(entry.data.capabilities || {}),
      data: entry.data
    }))
  };
}

function generateAll() {
  const rawSpecs = Object.fromEntries(SPEC_FILES.map(name => [name, readSpec(name)]));
  const { resolved, origins, refPaths } = validateSpecs(rawSpecs);
  const baseInputSha = inputHash(rawSpecs);
  const profileSpecs = readProfileSpecs();
  const profiles = validateProfileSpecs(profileSpecs);
  const profileInputSha = inputHash(rawSpecs, profileSpecs);
  const outputs = {
    [OUT_CONFIG_LUA]: generateConfigLua(resolved, rawSpecs, origins, baseInputSha),
    [OUT_PROTOCOL_LUA]: generateProtocolLua(resolved, rawSpecs, origins, baseInputSha),
    [OUT_CONFIG_JS]: generateConfigJs(resolved, rawSpecs, origins, baseInputSha),
    [OUT_CONFIG_H]: generateConfigH(resolved, rawSpecs, origins, baseInputSha),
    [OUT_FIXTURE]: `${JSON.stringify(buildFixture(resolved, rawSpecs, baseInputSha), null, 2)}\n`,
    [OUT_DOCS]: generateDocs(resolved, rawSpecs, origins, refPaths, baseInputSha)
  };
  const outputList = [...BASE_OUTPUTS];
  for (const entry of profiles) {
    const relative = `${PROFILE_OUTPUT_DIR}/${entry.spec.id}.lua`;
    outputs[relative] = generateProfileLua(entry, profileInputSha);
    outputList.push(relative);
  }
  outputs[OUT_PROFILE_H] = generateProfileHeader(profiles, profileInputSha);
  outputs[OUT_PROFILE_FIXTURE] = `${JSON.stringify(buildProfileFixture(profiles, profileInputSha), null, 2)}\n`;
  outputList.push(OUT_PROFILE_H, OUT_PROFILE_FIXTURE);
  return {
    outputs,
    outputList,
    inputSha: baseInputSha,
    profileInputSha,
    profiles: profiles.map(entry => entry.spec.id)
  };
}

function firstDiff(expected, actual) {
  const a = expected.split('\n');
  const b = actual.split('\n');
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return { line: index + 1, expected: a[index] ?? '<missing>', actual: b[index] ?? '<missing>' };
  }
  return null;
}

function main(argv) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node scripts/gen_config.cjs [--write | --check]');
    console.log('  generates spec/*.json and spec/dcs_profiles/*.json outputs');
    console.log('  --write  write generated files (default)');
    console.log('  --check  fail on any difference; exit 0 only when everything matches');
    return 0;
  }
  const unknown = args.filter(arg => !['--write', '--check'].includes(arg));
  if (unknown.length > 0) {
    console.error(`gen_config: unknown argument(s): ${unknown.join(' ')}`);
    return 2;
  }
  const check = args.includes('--check');
  let generated;
  try {
    generated = generateAll();
  } catch (error) {
    console.error(`gen_config: ${error.message}`);
    return 1;
  }
  if (check) {
    let mismatches = 0;
    for (const relative of generated.outputList) {
      const absolute = path.join(ROOT, relative);
      const expected = generated.outputs[relative];
      let actual = null;
      try {
        actual = fs.readFileSync(absolute, 'utf8');
      } catch {
        actual = null;
      }
      if (actual !== expected) {
        mismatches += 1;
        console.error(`DIFF ${relative}`);
        if (actual !== null) {
          const diff = firstDiff(expected, actual);
          if (diff) console.error(`  line ${diff.line}: expected ${JSON.stringify(diff.expected)}, got ${JSON.stringify(diff.actual)}`);
        } else {
          console.error('  file is missing');
        }
      }
    }
    if (mismatches > 0) {
      console.error(`gen_config: ${mismatches} generated file(s) differ; run node scripts/gen_config.cjs --write`);
      return 1;
    }
    console.log(`OK: ${generated.outputList.length} generated files match spec (input-sha256 ${generated.inputSha}, profile-input-sha256 ${generated.profileInputSha})`);
    return 0;
  }
  let written = 0;
  for (const relative of generated.outputList) {
    const absolute = path.join(ROOT, relative);
    const content = generated.outputs[relative];
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    let current = null;
    try {
      current = fs.readFileSync(absolute, 'utf8');
    } catch {
      current = null;
    }
    if (current !== content) {
      fs.writeFileSync(absolute, content, 'utf8');
      written += 1;
      console.log(`WROTE ${relative}`);
    }
  }
  console.log(`gen_config: ${written} file(s) written, ${generated.outputList.length - written} unchanged (input-sha256 ${generated.inputSha}, profile-input-sha256 ${generated.profileInputSha})`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv);
}

module.exports = {
  ROOT,
  SPEC_DIR,
  PROFILE_SPEC_DIR,
  SPEC_FILES,
  OUTPUTS,
  BASE_OUTPUTS,
  PROFILE_OUTPUT_DIR,
  OUT_PROFILE_H,
  OUT_PROFILE_FIXTURE,
  canonical,
  inputHash,
  resolveSpecs,
  validateSpecs,
  sourceLookup,
  sourceForOutput,
  buildConfigTable,
  buildProtocolTable,
  generateAll,
  main,
  readProfileSpecs,
  validateProfileSpec,
  validateProfileSpecs,
  generateProfileLua,
  generateProfileHeader,
  buildProfileFixture,
  fnv1a32,
  matrixCanonical,
  matrixEntries,
  matrixHash,
  matrixState,
  sha256Canonical
};

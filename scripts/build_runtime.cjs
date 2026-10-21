'use strict';
// Build the one-file deployment form of each runtime consumer.
// Sources stay modular; every bundle wraps the API modules it needs in local
// functions, publishes them as AESA_RUNTIME, then appends the consumer entry.
// The deployed file never uses require/dofile, so all four DCS Lua states
// (export, hook, mission, native host) load the same shape.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { findLua } = require('./build_common.cjs');

const ROOT = path.resolve(__dirname, '..');

const API = {
  export: 'src/adapters/dcs/api/export.lua',
  hook: 'src/adapters/dcs/api/hook.lua',
  mission: 'src/adapters/dcs/api/mission.lua',
  native: 'src/adapters/dcs/api/native.lua',
  socket: 'src/adapters/dcs/api/socket.lua',
  profile: 'src/adapters/dcs/compat/profile.lua',
  profileData: 'src/adapters/dcs/compat/profiles/dcs-2.9.30.28738-mt.lua',
};

const TARGETS = {
  export: {
    output: 'dist/dev/aesa_export.lua',
    modules: [
      ['ExportApi', API.export],
      ['SocketApi', API.socket],
      ['ProfileModule', API.profile],
      ['ProfileData', API.profileData],
    ],
    runtime: ['export', 'socket', 'profile', 'profile_data'],
    entry: 'src/export/aesa_export.lua',
  },
  sar_export: {
    output: 'dist/dev/aesa_sar_export.lua',
    modules: [
      ['ExportApi', API.export],
      ['SocketApi', API.socket],
      ['NativeApi', API.native],
      ['ProfileModule', API.profile],
      ['ProfileData', API.profileData],
      ['SarProtocol', 'src/export/sar_protocol.lua'],
      ['SarDcsEnv', 'src/export/sar_dcs_env.lua'],
      ['SarCollector', 'src/export/sar_collector.lua'],
      ['SarTransport', 'src/export/sar_transport.lua'],
    ],
    runtime: ['export', 'socket', 'native', 'profile', 'profile_data'],
    // The SAR modules are published as their own table: the entry reads them by name, and keeping
    // them out of AESA_RUNTIME leaves the adapter namespace exactly what Gate 3 defined it to be.
    extra: {
      table: 'AESA_SAR',
      names: {
        api: 'ExportApi', native: 'NativeApi', socket: 'SocketApi', profile: 'ProfileModule',
        profile_data: 'ProfileData',
        protocol: 'SarProtocol', dcs_env: 'SarDcsEnv', collector: 'SarCollector', transport: 'SarTransport',
      },
    },
    entry: 'src/export/aesa_sar_export.lua',
  },
  sar_scene_hook: {
    output: 'dist/dev/aesa_sar_scene_hook.lua',
    modules: [
      ['HookApi', API.hook],
      ['SocketApi', API.socket],
      ['ProfileModule', API.profile],
      ['ProfileData', API.profileData],
      ['SceneProtocol', 'src/shared/protocol.lua'],
    ],
    runtime: ['hook', 'socket', 'profile', 'profile_data'],
    entry: 'src/hooks/aesa_sar_scene_hook.lua',
  },
  sar_mission: {
    output: 'dist/dev/aesa_sar_mission.lua',
    modules: [
      ['MissionApi', API.mission],
      // The wire protocol is pure Lua and carries the patch geometries (P.allowed), so the scene
      // sampler validates a job against the same list the Export collects instead of repeating it.
      ['SarProtocol', 'src/export/sar_protocol.lua'],
      ['SarMissionEnv', 'src/scene/sar_mission_env.lua'],
      ['SarSceneCore', 'src/scene/sar_scene_core.lua'],
    ],
    runtime: ['mission'],
    extra: { table: 'AESA_SCENE', names: { protocol: 'SarProtocol', mission_env: 'SarMissionEnv', core: 'SarSceneCore' } },
    entry: 'src/scene/aesa_sar_mission.lua',
  },
  fc_hook: {
    output: 'dist/dev/aesa_fc_hook.lua',
    modules: [
      ['HookApi', API.hook],
      ['NativeApi', API.native],
      ['ProfileModule', API.profile],
      ['ProfileData', API.profileData],
    ],
    runtime: ['hook', 'native', 'profile', 'profile_data'],
    entry: 'src/hooks/aesa_fc_hook.lua',
  },
  agradar_hook: {
    output: 'dist/dev/aesa_agradar_hook.lua',
    modules: [
      ['HookApi', API.hook],
      ['NativeApi', API.native],
      ['ProfileModule', API.profile],
      ['ProfileData', API.profileData],
    ],
    runtime: ['hook', 'native', 'profile', 'profile_data'],
    entry: 'src/hooks/aesa_agradar_hook.lua',
  },
};

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function moduleSource(name, relative) {
  const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
  return `-- ---- ${relative} ----\nlocal function __${name}()\n${source}\nend\nlocal ${name} = __${name}()\n`;
}

function runtimeSource(names) {
  const lines = ['AESA_RUNTIME = {'];
  for (const name of names) {
    const moduleName = {
      export: 'ExportApi',
      hook: 'HookApi',
      mission: 'MissionApi',
      native: 'NativeApi',
      socket: 'SocketApi',
      profile: 'ProfileModule',
      profile_data: 'ProfileData',
    }[name];
    if (!moduleName) throw new Error(`unknown runtime module: ${name}`);
    lines.push(`    ${name} = ${moduleName},`);
  }
  lines.push('}');
  return lines.join('\n') + '\n';
}

function extraSource(extra) {
  const lines = [`${extra.table} = {`];
  for (const [name, moduleName] of Object.entries(extra.names)) lines.push(`    ${name} = ${moduleName},`);
  lines.push('}');
  return lines.join('\n') + '\n';
}

function longBracket(text) {
  let eq = '=';
  while (text.includes(']' + eq + ']')) eq += '=';
  return '[' + eq + '[' + text + ']' + eq + ']';
}

function build(name) {
  const target = TARGETS[name];
  if (!target) throw new Error(`unknown target: ${name}`);
  const pieces = target.modules.map(([moduleName, relative]) => moduleSource(moduleName, relative));
  const files = [...target.modules.map(([, relative]) => relative), target.entry];
  const hashes = Object.fromEntries(files.map((relative) => [
    relative,
    sha256(fs.readFileSync(path.join(ROOT, relative))),
  ]));
  const header = [
    '-- DO NOT EDIT -- generated by scripts/build_runtime.cjs',
    `-- Runtime bundle: ${name}`,
    `-- source-sha256: ${sha256(JSON.stringify(hashes))}`,
    '-- inputs:',
    ...Object.entries(hashes).map(([file, hash]) => `--   ${file} ${hash}`),
    '',
  ].join('\n');
  let entry = fs.readFileSync(path.join(ROOT, target.entry), 'utf8');
  if (name === 'sar_scene_hook') {
    entry = entry.replace('__MISSION_SOURCE__', longBracket(buildMission()));
  }
  const body = [
    '',
    '-- ---- runtime modules ----',
    ...pieces,
    '-- ---- runtime table ----',
    runtimeSource(target.runtime),
    ...(target.extra ? ['-- ---- declared modules ----', extraSource(target.extra)] : []),
    `-- ---- entry: ${target.entry} ----`,
    entry,
    '',
  ].join('\n');
  return { name, target, text: header + body, hashes };
}

function buildMission() {
  return build('sar_mission').text;
}

function checkLua(text, label) {
  const lua = findLua();
  if (!lua) return { checked: false, reason: 'luae.exe not found' };
  const temp = path.join(os.tmpdir(), `aesa-runtime-${label}-${process.pid}.lua`);
  fs.writeFileSync(temp, text);
  let result;
  try {
    result = spawnSync(lua, ['-e', `assert(loadfile(${JSON.stringify(temp)}))`], {
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    });
  } finally {
    fs.rmSync(temp, { force: true });
  }
  if (result.error || result.status !== 0) {
    const why = result.error ? result.error.message : `${result.stdout || ''}${result.stderr || ''}`;
    return { checked: true, ok: false, reason: why.trim() };
  }
  return { checked: true, ok: true };
}

function write(name) {
  const result = build(name);
  const output = path.join(ROOT, result.target.output);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, result.text);
  return {
    ...result,
    output,
    bytes: Buffer.byteLength(result.text),
    lua: checkLua(result.text, name),
  };
}

function writeAll() {
  return Object.keys(TARGETS).map((name) => write(name));
}

module.exports = { ROOT, API, TARGETS, build, buildMission, checkLua, write, writeAll, sha256 };

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const only = args.find((arg) => !arg.startsWith('--'));
    const results = only && only !== 'all' ? [write(only)] : writeAll();
    let failed = false;
    for (const result of results) {
      console.log(`built: ${path.relative(ROOT, result.output)} (${result.bytes} bytes)`);
      if (result.lua.checked && !result.lua.ok) {
        console.error(`Lua syntax check failed (${result.name}): ${result.lua.reason}`);
        failed = true;
      } else if (!result.lua.checked) {
        console.log(`Lua syntax check skipped (${result.name}): ${result.lua.reason}`);
      }
    }
    if (failed) process.exitCode = 1;
    else console.log('Lua 5.1 syntax OK');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

'use strict';
// Unified Gate test entry: Python core, review regressions, cockpit state
// bridge, SAR Node suites, installation suites (when Lua 5.1 is available)
// and native probe DLL tests (when the DCS bin is available). Every skip
// carries a reason.
//
//   node scripts/test_all.cjs [--json <path>] [--verbose]
//
// Exit code is non-zero when a required suite fails. A conditional suite that
// cannot run is reported as skipped, not as a pass.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TESTS = path.join(ROOT, 'tests');
const SUITE_TIMEOUT_MS = 600000;
const MAX_BUFFER = 64 * 1024 * 1024;
const PYTHON_ENV = { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: options.timeout ?? SUITE_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
    ...options,
  });
}

function detectPython(env = process.env) {
  const candidates = [];
  if (env.AESA_PYTHON) candidates.push({ command: env.AESA_PYTHON, prefix: [] });
  candidates.push({ command: 'python', prefix: [] });
  if (process.platform === 'win32') candidates.push({ command: 'py', prefix: ['-3'] });
  for (const candidate of candidates) {
    const result = run(candidate.command, [...candidate.prefix, '--version'], { timeout: 15000 });
    if (!result.error && result.status === 0) {
      const version = `${result.stdout || ''}${result.stderr || ''}`.trim().split(/\r?\n/)[0];
      return { ...candidate, version };
    }
  }
  return null;
}

function normalizeDcsBin(candidate) {
  if (!candidate) return null;
  if (isFile(path.join(candidate, 'luae.exe'))) return path.resolve(candidate);
  if (isFile(path.join(candidate, 'bin', 'luae.exe'))) return path.resolve(candidate, 'bin');
  return null;
}

function dcsBinCandidates() {
  const roots = [];
  for (let index = 0; index < 26; index++) {
    const drive = `${String.fromCharCode(65 + index)}:/`;
    for (const relative of [
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
    ]) roots.push(path.join(drive, relative));
  }
  return roots;
}

function resolveDcsBin(env = process.env) {
  if (env.AESA_DCS_BIN) {
    const found = normalizeDcsBin(env.AESA_DCS_BIN);
    return found
      ? { path: found, source: 'AESA_DCS_BIN' }
      : { path: null, source: 'AESA_DCS_BIN', reason: 'AESA_DCS_BIN 不是有效的 DCS bin（需要 luae.exe）' };
  }
  if (env.AESA_LUA) {
    const found = normalizeDcsBin(path.dirname(env.AESA_LUA));
    if (found) return { path: found, source: 'AESA_LUA 所在目录' };
  }
  for (const candidate of dcsBinCandidates()) {
    const found = normalizeDcsBin(candidate);
    if (found) return { path: found, source: '自动检测' };
  }
  return { path: null, source: null, reason: '未找到 DCS bin（可设置 AESA_DCS_BIN 或 AESA_LUA）' };
}

function resolveLua(dcsBin, env = process.env) {
  if (env.AESA_LUA) {
    return isFile(env.AESA_LUA)
      ? { path: path.resolve(env.AESA_LUA), source: 'AESA_LUA' }
      : { path: null, source: 'AESA_LUA', reason: 'AESA_LUA 指向的文件不存在' };
  }
  if (dcsBin?.path) {
    const lua = path.join(dcsBin.path, 'luae.exe');
    if (isFile(lua)) return { path: lua, source: 'DCS bin' };
  }
  return { path: null, source: null, reason: '未设置 AESA_LUA，且未找到 DCS luae.exe' };
}

function luaVersion(luaPath) {
  if (!luaPath) return null;
  const result = run(luaPath, ['-e', 'io.write(_VERSION)'], { timeout: 15000 });
  return !result.error && result.status === 0 ? (result.stdout || '').trim() : null;
}

function gitOutput(args) {
  const result = run('git', args, { timeout: 15000 });
  return !result.error && result.status === 0 ? result.stdout.trim() : null;
}

function gitInfo(options = {}) {
  const commit = gitOutput(['rev-parse', 'HEAD']);
  if (!commit) return { commit: null, branch: null, tag: null, dirty: null };
  const branch = gitOutput(['rev-parse', '--abbrev-ref', 'HEAD']);
  const tag = gitOutput(['describe', '--tags', '--exact-match', 'HEAD']);
  const statusArgs = ['status', '--porcelain'];
  if (options.exclude?.length) {
    statusArgs.push('--', '.', ...options.exclude.map(item => `:(exclude)${item}`));
  }
  const status = gitOutput(statusArgs);
  return { commit, branch, tag, dirty: status === null ? null : status.length > 0 };
}

function parseIntMatch(output, regex, fallback = null) {
  const global = regex.global ? regex : new RegExp(regex.source, `${regex.flags}g`);
  const matches = [...output.matchAll(global)];
  if (!matches.length) return fallback;
  const value = Number(matches[matches.length - 1][1]);
  return Number.isFinite(value) ? value : fallback;
}

function parseNodeTest(output, exitCode) {
  const number = regex => parseIntMatch(output, regex);
  const total = number(/^(?:ℹ|#)\s+tests\s+(\d+)\s*$/gm);
  const pass = number(/^(?:ℹ|#)\s+pass\s+(\d+)\s*$/gm);
  const fail = number(/^(?:ℹ|#)\s+fail\s+(\d+)\s*$/gm);
  const skip = number(/^(?:ℹ|#)\s+skipped\s+(\d+)\s*$/gm);
  const cancelled = number(/^(?:ℹ|#)\s+cancelled\s+(\d+)\s*$/gm) ?? 0;
  const counts = {
    pass: pass ?? 0,
    fail: fail ?? (exitCode === 0 ? 0 : 1),
    skip: skip ?? 0,
    total: total ?? ((pass ?? 0) + (fail ?? 0) + (skip ?? 0)),
  };
  return {
    ok: exitCode === 0 && counts.fail === 0 && cancelled === 0,
    counts,
    detail: counts.pass + '/' + counts.total,
  };
}

function parsePythonRun(output, exitCode) {
  const match = output.match(/^-{4}\s+(\d+)\/(\d+)\s+passed\s*$/m);
  if (!match) {
    const counts = { pass: exitCode === 0 ? 1 : 0, fail: exitCode === 0 ? 0 : 1, skip: 0, total: 1 };
    return { ok: exitCode === 0, counts, detail: 'unparsed' };
  }
  const pass = Number(match[1]);
  const total = Number(match[2]);
  const fail = Math.max(0, total - pass);
  return {
    ok: exitCode === 0 && fail === 0,
    counts: { pass, fail, skip: 0, total },
    detail: `${pass}/${total}`,
  };
}

function parseUnittest(output, exitCode) {
  const ran = parseIntMatch(output, /^Ran\s+(\d+)\s+tests?\s+in\s+/m);
  const failed = output.match(/^FAILED\s+\(([^)]*)\)/m);
  const okLine = /^OK(?:\s+\(|$)/m.test(output);
  const skip = parseIntMatch(output, /skipped=(\d+)/m, 0) ?? 0;
  let fail = 0;
  if (failed) {
    fail = parseIntMatch(failed[1], /failures=(\d+)/m, 0) + parseIntMatch(failed[1], /errors=(\d+)/m, 0);
    if (fail === 0) fail = 1;
  }
  const total = ran ?? 1;
  const pass = Math.max(0, total - fail - skip);
  return {
    ok: exitCode === 0 && okLine && fail === 0,
    counts: { pass, fail, skip, total },
    detail: `${pass}/${total}${skip ? ` (skip ${skip})` : ''}`,
  };
}

function parseSmoke(output, exitCode) {
  const ok = exitCode === 0 && /\bOK\b/.test(output);
  return {
    ok,
    counts: { pass: ok ? 1 : 0, fail: ok ? 0 : 1, skip: 0, total: 1 },
    detail: ok ? '1/1' : '0/1',
  };
}

function tail(text, lines = 40, chars = 8000) {
  const all = String(text || '').trim().split(/\r?\n/);
  return all.slice(-lines).join('\n').slice(-chars);
}

function suiteBase(id, name, command, required = true) {
  return { id, name, command, required };
}

function skipSuite(definition, reason) {
  return {
    ...definition,
    required: false,
    status: 'skip',
    reason,
    duration_ms: 0,
    exit_code: null,
    counts: { pass: 0, fail: 0, skip: 1, total: 1 },
  };
}

function failSuite(definition, reason) {
  return {
    ...definition,
    status: 'fail',
    reason,
    duration_ms: 0,
    exit_code: null,
    counts: { pass: 0, fail: 1, skip: 0, total: 1 },
  };
}

function runSuite(definition, { command, args, env = {}, parse }) {
  const started = performance.now();
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: SUITE_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
    env: { ...process.env, ...env },
  });
  const duration_ms = Math.round(performance.now() - started);
  const output = `${result.stdout || ''}${result.stderr ? `\n${result.stderr}` : ''}`;
  if (result.error) {
    const timedOut = result.error.code === 'ETIMEDOUT';
    return {
      ...definition,
      status: 'fail',
      reason: timedOut ? `超时（${SUITE_TIMEOUT_MS / 1000}s）` : `无法启动: ${result.error.message}`,
      duration_ms,
      exit_code: result.status,
      counts: { pass: 0, fail: 1, skip: 0, total: 1 },
      output,
    };
  }
  const parsed = parse(output, result.status);
  return {
    ...definition,
    status: parsed.ok ? 'pass' : 'fail',
    reason: parsed.ok ? null : `退出码 ${result.status}: ${tail(output, 12, 1200)}`,
    duration_ms,
    exit_code: result.status,
    counts: parsed.counts,
    detail: parsed.detail,
    output,
  };
}

function sarTestFiles() {
  return fs.readdirSync(TESTS)
    .filter(name => /^test_sar_.*\.cjs$/.test(name))
    .sort();
}

function suiteEnvironment(ctx, luaVersionText) {
  return {
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    node: process.version,
    python: ctx.python ? { command: ctx.python.command, version: ctx.python.version } : null,
    lua: {
      available: !!ctx.lua.path,
      source: ctx.lua.source,
      version: luaVersionText,
    },
    dcs_bin: { available: !!ctx.dcsBin.path, source: ctx.dcsBin.source },
    git: ctx.git,
  };
}

function totalsFrom(suites, duration_ms) {
  const totals = {
    suites: { pass: 0, fail: 0, skip: 0, total: suites.length },
    tests: { pass: 0, fail: 0, skip: 0, total: 0 },
    duration_ms,
  };
  for (const suite of suites) {
    totals.suites[suite.status === 'pass' ? 'pass' : suite.status === 'skip' ? 'skip' : 'fail']++;
    totals.tests.pass += suite.counts.pass;
    totals.tests.fail += suite.counts.fail;
    totals.tests.skip += suite.counts.skip;
    totals.tests.total += suite.counts.total;
  }
  return totals;
}

function formatCounts(suite) {
  const counts = suite.counts;
  if (suite.status === 'skip') return '—';
  if (counts.total === counts.pass && !counts.skip) return `${counts.pass}/${counts.total}`;
  return `${counts.pass}/${counts.total}${counts.skip ? ` skip ${counts.skip}` : ''}`;
}

function formatDuration(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function usage() {
  console.log('用法: node scripts/test_all.cjs [--json <path>] [--verbose]');
}

function main() {
  const args = process.argv.slice(2);
  let jsonPath = null;
  let verbose = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--json') {
      if (index + 1 >= args.length) { usage(); process.exitCode = 2; return; }
      jsonPath = args[++index];
    } else if (arg.startsWith('--json=')) {
      jsonPath = arg.slice('--json='.length);
    } else if (arg === '--verbose') {
      verbose = true;
    } else if (arg === '--help' || arg === '-h') {
      usage();
      return;
    } else {
      console.error(`未知参数: ${arg}`);
      usage();
      process.exitCode = 2;
      return;
    }
  }

  const startedAt = new Date();
  const started = performance.now();
  const ctx = {
    python: detectPython(),
    dcsBin: resolveDcsBin(),
    git: gitInfo(),
  };
  ctx.lua = resolveLua(ctx.dcsBin);
  // Hand the detected toolchain to the child suites so individual test files
  // do not need their own machine-specific fallbacks.
  const toolEnv = {};
  if (ctx.lua.path) toolEnv.AESA_LUA = ctx.lua.path;
  if (ctx.dcsBin.path) toolEnv.AESA_DCS_BIN = ctx.dcsBin.path;
  const pythonEnv = { ...PYTHON_ENV, ...toolEnv };
  const luaVersionText = luaVersion(ctx.lua.path);

  console.log('aesa test_all');
  console.log(`commit ${ctx.git.commit ? ctx.git.commit.slice(0, 12) : 'unknown'}`
    + `${ctx.git.branch ? ` (${ctx.git.branch})` : ''}`
    + `${ctx.git.tag ? ` tag ${ctx.git.tag}` : ''}`
    + `${ctx.git.dirty === null ? '' : ctx.git.dirty ? ' dirty' : ' clean'}`);
  console.log(`Python: ${ctx.python ? ctx.python.version : '未找到'}`
    + ` | Lua 5.1: ${ctx.lua.path ? (luaVersionText || '可用') : '不可用'}`
    + ` | DCS bin: ${ctx.dcsBin.path ? '可用' : '不可用'}`);
  console.log('');

  const suites = [];

  if (ctx.python) {
    const python = [ctx.python.command, ...ctx.python.prefix];
    suites.push(runSuite(
      suiteBase('python-core', 'Python 核心测试', 'python tests/run_tests.py'),
      { command: python[0], args: [...python.slice(1), 'tests/run_tests.py'], env: pythonEnv, parse: parsePythonRun },
    ));
    suites.push(runSuite(
      suiteBase('python-regressions', 'Python 回归测试', 'python tests/test_review_regressions.py'),
      { command: python[0], args: [...python.slice(1), 'tests/test_review_regressions.py'], env: pythonEnv, parse: parseUnittest },
    ));
    const gatePython = fs.readdirSync(TESTS).filter(name => /^test_gate.*\.py$/.test(name)).sort();
    if (gatePython.length) {
      suites.push(runSuite(
        suiteBase('python-gate', 'Gate 回归测试', 'python -m unittest discover -s tests -p "test_gate*.py"'),
        {
          command: python[0],
          args: [...python.slice(1), '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_gate*.py'],
          env: pythonEnv,
          parse: parseUnittest,
        },
      ));
    }
    const cockpitBridgeTest = 'tests/test_cockpit_bridge.py';
    if (isFile(path.join(ROOT, cockpitBridgeTest))) {
      suites.push(runSuite(
        suiteBase('python-cockpit-bridge', '座舱状态桥测试', `python ${cockpitBridgeTest}`),
        {
          command: python[0],
          args: [...python.slice(1), cockpitBridgeTest],
          env: pythonEnv,
          parse: parseUnittest,
        },
      ));
    }
  } else {
    const reason = '未找到 Python（可设置 AESA_PYTHON）';
    suites.push(failSuite(suiteBase('python-core', 'Python 核心测试', 'python tests/run_tests.py'), reason));
    suites.push(failSuite(suiteBase('python-regressions', 'Python 回归测试', 'python tests/test_review_regressions.py'), reason));
  }

  const sarFiles = sarTestFiles();
  if (!sarFiles.length) {
    suites.push(failSuite(suiteBase('node-sar', 'SAR Node 测试', 'node --test tests/test_sar_*.cjs'),
      '未找到 tests/test_sar_*.cjs'));
  } else {
    suites.push(runSuite(
      suiteBase('node-sar', 'SAR Node 测试', 'node --test tests/test_sar_*.cjs'),
      {
        command: process.execPath,
        args: ['--test', ...sarFiles.map(name => path.join('tests', name))],
        env: toolEnv,
        parse: parseNodeTest,
      },
    ));
  }

  const viewerTest = 'tests/test_viewer_vectors.cjs';
  if (!isFile(path.join(ROOT, viewerTest))) {
    suites.push(failSuite(
      suiteBase('node-viewer', '显示层向量测试', `node --test ${viewerTest}`),
      `未找到 ${viewerTest}`,
    ));
  } else {
    suites.push(runSuite(
      suiteBase('node-viewer', '显示层向量测试', `node --test ${viewerTest}`),
      {
        command: process.execPath,
        args: ['--test', viewerTest],
        parse: parseNodeTest,
      },
    ));
  }

  const cockpitTest = 'tests/test_cockpit_page.cjs';
  if (!isFile(path.join(ROOT, cockpitTest))) {
    suites.push(failSuite(suiteBase('node-cockpit', '座舱页面测试', `node --test ${cockpitTest}`),
      `未找到 ${cockpitTest}`));
  } else if (!ctx.lua.path) {
    suites.push(skipSuite(suiteBase('node-cockpit', '座舱页面测试', `node --test ${cockpitTest}`),
      ctx.lua.reason || 'AESA_LUA/DCS luae.exe 不可用'));
  } else {
    const cockpitEnv = { AESA_LUA: ctx.lua.path };
    if (ctx.dcsBin.path) cockpitEnv.AESA_DCS_DIR = path.dirname(ctx.dcsBin.path);
    suites.push(runSuite(
      suiteBase('node-cockpit', '座舱页面测试', `node --test ${cockpitTest}`, true),
      {
        command: process.execPath,
        args: ['--test', cockpitTest],
        env: cockpitEnv,
        parse: parseNodeTest,
      },
    ));
  }

  const gateNodeFiles = fs.readdirSync(TESTS).filter(name => /^test_gate.*\.cjs$/.test(name)).sort();
  if (gateNodeFiles.length) {
    suites.push(runSuite(
      suiteBase('node-gate', 'Gate Node 测试', 'node --test tests/test_gate*.cjs'),
      {
        command: process.execPath,
        args: ['--test', ...gateNodeFiles.map(name => path.join('tests', name))],
        env: toolEnv,
        parse: parseNodeTest,
      },
    ));
  }

  const installFiles = ['tests/test_install_sar.cjs', 'tests/test_install_sar_scene.cjs',
    'tests/test_install_fc.cjs', 'tests/test_install_agradar.cjs'];
  const installDefinition = suiteBase('install-sar', '部署生命周期测试',
    'node --test tests/test_install_*.cjs', false);
  if (!ctx.lua.path) {
    suites.push(skipSuite(installDefinition, ctx.lua.reason || 'AESA_LUA/DCS luae.exe 不可用'));
  } else {
    suites.push(runSuite(
      { ...installDefinition, required: true },
      {
        command: process.execPath,
        args: ['--test', ...installFiles],
        env: { AESA_LUA: ctx.lua.path },
        parse: parseNodeTest,
      },
    ));
  }

  const nativeDefinition = (id, name, script) => suiteBase(id, name, `python ${script}`, false);
  let nativeReason = null;
  if (!ctx.dcsBin.path) {
    nativeReason = ctx.dcsBin.reason || '未找到 DCS bin（可设置 AESA_DCS_BIN）';
  } else if (!isFile(path.join(ctx.dcsBin.path, 'luae.exe')) || !isFile(path.join(ctx.dcsBin.path, 'lua.dll'))) {
    nativeReason = 'DCS bin 缺少 luae.exe 或 lua.dll';
  }

  const nativeSuites = [
    {
      definition: nativeDefinition('native-agradar', '原生地表探针测试', 'tests/test_agradar_probe_dll.py'),
      dll: path.join(ROOT, 'dist', 'dev', 'aesa_agradar.dll'),
      build: 'node scripts/build_agradar_probe.cjs',
    },
    {
      definition: nativeDefinition('native-fc', '原生火控探针测试', 'tests/test_fc_probe_dll.py'),
      dll: path.join(ROOT, 'dist', 'dev', 'aesa_fc_trace.dll'),
      extraDlls: [path.join(ROOT, 'dist', 'dev', 'aesa_fc_inject.dll')],
      build: 'node scripts/build_fc_probe.cjs',
    },
  ];

  for (const native of nativeSuites) {
    const missing = [native.dll, ...(native.extraDlls || [])].filter(file => !isFile(file));
    const reason = nativeReason || (missing.length ? `DLL 未构建（${native.build}）` : null);
    if (reason) {
      suites.push(skipSuite(native.definition, reason));
    } else if (!ctx.python) {
      suites.push(skipSuite(native.definition, '未找到 Python（可设置 AESA_PYTHON）'));
    } else {
      const python = [ctx.python.command, ...ctx.python.prefix];
      suites.push(runSuite(
        { ...native.definition, required: true },
        {
          command: python[0],
          args: [...python.slice(1), native.definition.command.replace(/^python\s+/, '')],
          env: pythonEnv,
          parse: parseSmoke,
        },
      ));
    }
  }

  const duration_ms = Math.round(performance.now() - started);
  const totals = totalsFrom(suites, duration_ms);
  const requiredOk = suites.every(suite => !suite.required || suite.status === 'pass');
  const ok = requiredOk && suites.every(suite => suite.status !== 'fail');
  const finishedAt = new Date();

  for (let index = 0; index < suites.length; index++) {
    const suite = suites[index];
    const label = suite.status === 'pass' ? 'PASS' : suite.status === 'skip' ? 'SKIP' : 'FAIL';
    console.log(`[${index + 1}/${suites.length}] ${suite.name} ... ${label} `
      + `${suite.status === 'skip' ? '' : `${formatCounts(suite)} `}(${formatDuration(suite.duration_ms)})`);
    if (suite.status === 'skip') console.log(`       原因: ${suite.reason}`);
    if (suite.status === 'fail') console.log(tail(suite.output || suite.reason, 20, 4000).replace(/^/gm, '       '));
    if (verbose && suite.status !== 'skip') {
      const output = suite.output || '';
      console.log(output.replace(/^/gm, '       '));
    }
  }

  console.log('');
  console.log(`套件: ${totals.suites.pass} 通过, ${totals.suites.fail} 失败, ${totals.suites.skip} 跳过`
    + ` | 测试: ${totals.tests.pass} 通过, ${totals.tests.fail} 失败, ${totals.tests.skip} 跳过`
    + ` | 总耗时 ${formatDuration(duration_ms)}`);
  const skipped = suites.filter(suite => suite.status === 'skip');
  if (skipped.length) {
    console.log('跳过原因:');
    for (const suite of skipped) console.log(`- ${suite.id}: ${suite.reason}`);
  }
  console.log(`结果: ${ok ? 'GREEN' : 'RED'}${ok && skipped.length ? `（${skipped.length} 个套件有明确 skip 原因）` : ''}`);

  if (jsonPath) {
    const report = {
      schema: 1,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms,
      result: ok ? 'green' : 'red',
      ok,
      environment: suiteEnvironment(ctx, luaVersionText),
      suites: suites.map(({ output, ...suite }) => suite),
      totals,
    };
    const target = path.resolve(process.cwd(), jsonPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`JSON: ${target}`);
  }

  process.exitCode = ok ? 0 : 1;
}

module.exports = {
  ROOT,
  detectPython,
  resolveDcsBin,
  resolveLua,
  luaVersion,
  gitInfo,
  run,
  isFile,
};

if (require.main === module) main();

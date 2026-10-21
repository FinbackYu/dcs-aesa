#!/usr/bin/env node
'use strict';

/*
 * aesa repository audit (Gate 0).
 *
 * Checks the items in docs/refactor-plan.md §7.3:
 *   - git status / untracked-file ownership
 *   - suspicious file names
 *   - TODO/FIXME/XXX/HACK/DEPRECATED owner+date metadata
 *   - game API boundary
 *   - duplicate constants
 *   - legacy module/symbol references
 *   - documentation status labels and dead local links
 *   - generated-file headers
 *   - test skip counts
 *   - recordings/__pycache__/dist tracking
 *
 * The current tree intentionally contains known violations.  Gate 0 keeps
 * tests/baseline/audit-baseline.json as an allowlist: findings that are
 * recorded there are reported as "known" and do not fail the run.  Only
 * findings outside the baseline (or occurrences beyond the baseline count)
 * fail.  Use --update-baseline to record the current state; later gates
 * should delete entries as they fix things.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SELF = 'scripts/audit_repo.cjs';
const DEFAULT_BASELINE = path.join(ROOT, 'tests', 'baseline', 'audit-baseline.json');

const GATE0_NEW_FILES = new Set([
  'docs/refactor-plan.md',
  'docs/architecture.md',
  'docs/conventions.md',
  'docs/dcs-compat.md',
  'docs/testing-gates.md',
  'docs/file-inventory.md',
  'DEPRECATIONS.md',
  'scripts/test_all.cjs',
  'scripts/capture_baseline.cjs',
  'scripts/audit_repo.cjs',
]);
// Gate 0 task 9/10 also updates these tracked files.  They are allowed only
// as working-tree modifications; after commit, further edits are flagged
// again by the normal git-status check.
const GATE0_MODIFIED_FILES = new Set([
  'AGENTS.md',
  'README.md',
  'docs/status.md',
  'docs/design-fc-injection.md',
]);
// Gate 0 also produces baseline JSONs; new files in that directory are an
// owned category, not stray untracked residue. worklog/ is local-only and is
// handled by isLocalOnlyPath in isGate0GitChange.
const GATE0_EXPECTED_PREFIXES = ['tests/baseline/'];

const DEFAULT_OWNER = '项目维护者（Gate 0 审计）';

const RULES = {
  'git-unowned': {
    check: 'git', severity: 'error', gate: 'Gate 0',
    note: '工作区存在计划外修改或未跟踪文件；每个未跟踪文件都要有归属。',
  },
  'git-clean-unowned': {
    check: 'git', severity: 'error', gate: 'Gate 0',
    note: 'git clean -nd 列出未归属的临时文件或目录。',
  },
  'suspicious-filename': {
    check: 'filenames', severity: 'error', gate: 'Gate 0/7',
    note: '文件名或目录名含 _old/_new/_vN/copy/backup/bak/tmp/deprecated。',
  },
  'todo-metadata': {
    check: 'todos', severity: 'warn', gate: 'Gate 6',
    note: 'TODO/FIXME/XXX/HACK/DEPRECATED 必须带 owner 与日期。',
  },
  'game-api-out-of-bounds': {
    check: 'game-api', severity: 'error', gate: 'Gate 3',
    note: '游戏 API 只允许出现在 src/adapters/dcs/api/（Gate 3 才创建该目录）。',
  },
  'duplicate-constant': {
    check: 'constants', severity: 'warn', gate: 'Gate 2',
    note: '常量应只来自 spec/、生成物或 tests/fixtures/。',
  },
  'legacy-symbol': {
    check: 'legacy', severity: 'warn', gate: 'Gate 2/4/5',
    note: '重构计划中要删除或改名的旧符号，先记录后收紧。',
  },
  'broken-require': {
    check: 'legacy', severity: 'error', gate: 'Gate 4/5',
    note: '相对 require/import 的目标文件不存在。',
  },
  'tests-import-in-prod': {
    check: 'legacy', severity: 'warn', gate: 'Gate 4',
    note: '生产工具依赖 tests/；Gate 4 要拆出共享模块。',
  },
  'docs-status-missing': {
    check: 'docs', severity: 'warn', gate: 'Gate 6',
    note: '文档缺少 current/historical/external-reference/draft 状态标签。',
  },
  'docs-status-invalid': {
    check: 'docs', severity: 'warn', gate: 'Gate 6',
    note: '文档状态标签不在允许集合内。',
  },
  'dead-link': {
    check: 'docs', severity: 'error', gate: 'Gate 6',
    note: '本地 Markdown 链接目标不存在。',
  },
  'docs-pending-link': {
    check: 'docs', severity: 'warn', gate: 'Gate 0',
    note: '链接指向 Gate 0 计划内、当前尚未生成的文件。',
  },
  'generated-header': {
    check: 'generated', severity: 'error', gate: 'Gate 2',
    note: '生成物缺少 DO NOT EDIT / generator / hash 头。',
  },
  'test-skip': {
    check: 'skips', severity: 'warn', gate: 'Gate 7',
    note: '测试含 skip；数量、条件与原因进入基线，关键套件不允许静默跳过。',
  },
  'tracked-artifact': {
    check: 'artifacts', severity: 'error', gate: 'Gate 0',
    note: 'recordings/、__pycache__/、dist/ 运行产物不应被跟踪。',
  },
  'gitignore-missing': {
    check: 'artifacts', severity: 'warn', gate: 'Gate 0',
    note: '.gitignore 缺少运行产物的忽略规则。',
  },
  'sensitive-wording': {
    check: 'wording', severity: 'error', gate: 'post-release',
    note: '只写事实（偏移/签名/行为/哈希），不写获取方法；内容纪律见 CONTRIBUTING.md。',
  },
};

const CHECK_DEFS = [
  { id: 'git', label: 'git status / 未跟踪文件归属' },
  { id: 'filenames', label: '可疑文件名' },
  { id: 'todos', label: 'TODO/FIXME owner+日期' },
  { id: 'game-api', label: '游戏 API 越界' },
  { id: 'constants', label: '重复常量' },
  { id: 'legacy', label: '旧模块/旧符号/依赖方向' },
  { id: 'docs', label: '文档状态与死链' },
  { id: 'generated', label: '生成物头标记' },
  { id: 'skips', label: '测试 skip 数量' },
  { id: 'artifacts', label: 'recordings/__pycache__/dist 跟踪' },
  { id: 'wording', label: '敏感方法措辞（文件与提交信息）' },
];

const TEXT_EXT = new Set([
  '.lua', '.cjs', '.js', '.mjs', '.py', '.c', '.h', '.html',
  '.json', '.md', '.txt', '.cfg', '.yml', '.yaml',
]);
const CODE_EXT = new Set(['.lua', '.cjs', '.js', '.mjs', '.py', '.c', '.h', '.html']);
const JS_EXT = new Set(['.cjs', '.js', '.mjs']);

const GLOBAL_SCAN_EXCLUDED = [
  '.git/',
  'recordings/',
  'worklog/',
  'dist/',
  'src/native/third_party/',
  'tests/baseline/',
  'tests/__pycache__/',
  'tools/__pycache__/',
  'scripts/__pycache__/',
];

const GAME_API_PATTERNS = [
  { key: 'LoGet', re: /\bLoGet[A-Za-z0-9_]*/g },
  // DCS terrain methods are capitalised (GetHeight/GetSurfaceType) or the
  // lowercase isVisible; this avoids matching local arrays named `terrain`.
  { key: 'terrain.', re: /(?<![.\w])terrain\.(?:[A-Z][A-Za-z0-9_]*|isVisible)\b/g },
  { key: 'world.searchObjects', re: /\bworld\.searchObjects\b/g },
  { key: 'net.dostring_in', re: /\bnet\.dostring_in\b/g },
  { key: 'package.loadlib', re: /\bpackage\.loadlib\b/g },
  { key: 'lfs.', re: /(?<![.\w])lfs\.[A-Za-z_][A-Za-z0-9_]*/g },
];

const CONSTANT_RULES = [
  {
    key: '299792458',
    label: '光速',
    re: /\b(?:299792458(?:\.0+)?|2\.99792458e8)\b/g,
  },
  {
    key: '0.03(lambda)',
    label: 'X 波段波长',
    re: /(?<![\d.-])0\.03(?![\d])/g,
    lineRe: /\b(?:lambda|LAMBDA|λ|DBS_LAMBDA)\b|radar\.fx/i,
  },
  {
    key: '359x(port)',
    label: '固定端口',
    re: /\b359[0-4]\b/g,
  },
  {
    key: '128(SAR)',
    label: 'SAR 128 m 档/网格',
    re: /(?<![\d.-])128(?![\d])/g,
    lineRe: /\b(?:size|SIZE|size_m|width|WIDTH|footprint|FOOTPRINT|detail|DETAIL|grid|GRID)\b/,
  },
  {
    key: '17(MAP)',
    label: 'MAP 17 格/帧/网格',
    re: /(?<![\d.-])17(?![\d])/g,
    lineRe: /\b(?:N|n)\s*(?:=|:)\s*17\b|\b(?:N|n)\s*==\s*17\b|MAP_STEP|map_step|17\s*(?:格|cells?)|\b(?:row|col|grid)\b[^\n]*\b17\b|\b17\b[^\n]*\b(?:row|col|grid)\b|[<>]=?\s*17\b/,
  },
];

const LEGACY_SYMBOLS = [
  { symbol: 'AESA.VERSION', gate: 'Gate 3', note: '死的版本常量，Gate 3 删除。' },
  { symbol: 'AESA.tick', gate: 'Gate 3', note: '旧 tick 入口，Gate 3 删除。' },
  { symbol: 'default_rcs', gate: 'Gate 4', note: 'init.build 不再默认加载 DCS 数据。' },
  { symbol: 'rel_geo', gate: 'Gate 4', note: 'viewer 相对几何，迁到 snapshot/DTO。' },
  { symbol: 'tick_s', gate: 'Gate 2', note: '配置键删除。' },
  { symbol: 'notch_half_ms', gate: 'Gate 2', note: '改名为 notch_half_mps。' },
  { symbol: 'zero_notch_half_ms', gate: 'Gate 2', note: '改名为 _mps。' },
  { symbol: 'gate_vel_margin_ms', gate: 'Gate 2', note: '改名为 _mps。' },
  { symbol: 'vel_floor_ms', gate: 'Gate 2', note: '改名为 _mps。' },
  { symbol: 'slow_mover_ms', gate: 'Gate 2', note: '改名为 _mps。' },
  { symbol: 'sarWindowHalfDeg', gate: 'Gate 5', note: 'viewer 重算窗口的参数，Gate 5 删除。' },
  { symbol: 'degraded_near_forward_deg', gate: 'Gate 5', note: 'viewer 物理提示，Gate 5 删除。' },
  { symbol: 'MAP_DEFAULTS', gate: 'Gate 5', note: '重复默认值，Gate 5 收敛到 spec/。' },
];

const CRITICAL_TEST_RE = /^tests\/test_sar_[^/]+\.cjs$/;

function parseArgs(argv) {
  const opts = {
    json: false,
    verbose: false,
    strict: false,
    updateBaseline: false,
    baselinePath: DEFAULT_BASELINE,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--verbose' || a === '-v') opts.verbose = true;
    else if (a === '--strict') opts.strict = true;
    else if (a === '--update-baseline') opts.updateBaseline = true;
    else if (a === '--check-message-file') {
      const v = argv[++i];
      if (!v) throw new Error('--check-message-file 需要一个路径');
      if (!opts.checkMessageFiles) opts.checkMessageFiles = [];
      opts.checkMessageFiles.push(v);
    }
    else if (a === '--baseline') {
      const v = argv[++i];
      if (!v) throw new Error('--baseline 需要一个路径');
      opts.baselinePath = path.isAbsolute(v) ? v : path.join(ROOT, v);
    } else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`未知参数: ${a}`);
  }
  return opts;
}

function toPosix(p) {
  return String(p).split(path.sep).join('/');
}

function normalizeRel(p) {
  return toPosix(p).replace(/^\.\//, '').replace(/\/+$/, '');
}

function isGate0PlannedPath(relPath) {
  const p = normalizeRel(relPath);
  if (GATE0_NEW_FILES.has(p)) return true;
  return GATE0_EXPECTED_PREFIXES.some((prefix) => p === prefix.slice(0, -1) || p.startsWith(prefix));
}

// Generated docs and structure references may legitimately point into the
// local-only worklog (see .gitignore); their links are not dead just because
// the log is not committed.
function isLocalOnlyPath(relPath) {
  const p = normalizeRel(relPath);
  return p === 'worklog' || p.startsWith('worklog/');
}

function isGate0GitChange(entry) {
  const paths = [entry.path, entry.from].filter(Boolean).map(normalizeRel);
  const code = entry.code || '';
  const added = code === '??' || code[0] === 'A';
  const modified = code[0] === 'M' || code[1] === 'M';
  const deleted = code.includes('D');
  return paths.some((p) => {
    // worklog/ is local-only (.gitignore). Its untracking appears as delete or
    // rename; those entries are owned, not stray residue.
    if (isLocalOnlyPath(p) && (deleted || added || modified)) return true;
    if (added && isGate0PlannedPath(p)) return true;
    if (modified && GATE0_MODIFIED_FILES.has(p)) return true;
    // The allowlist is this tool's own output; regenerating it must not look
    // like an unowned working-tree change.
    if (modified && p === 'tests/baseline/audit-baseline.json') return true;
    return false;
  });
}

function isScanExcluded(relPath) {
  const p = normalizeRel(relPath);
  return GLOBAL_SCAN_EXCLUDED.some((prefix) => p.startsWith(prefix));
}

function extOf(relPath) {
  return path.extname(relPath).toLowerCase();
}

function sha1(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

function runGit(args) {
  const r = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, LC_ALL: 'C' },
  });
  return {
    ok: !r.error && r.status === 0,
    status: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error ? r.error.message : '',
  };
}

function parseStatusZ(text) {
  const parts = text.split('\0');
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i];
    if (!raw) continue;
    const code = raw.slice(0, 2);
    const p = raw.slice(3);
    if (!p) continue;
    const entry = { code, path: normalizeRel(p) };
    if (code[0] === 'R' || code[0] === 'C') {
      const other = parts[++i];
      if (other) entry.from = normalizeRel(other);
    }
    entries.push(entry);
  }
  return entries;
}

function unquoteGitPath(s) {
  let p = s.trim();
  if (p.startsWith('"') && p.endsWith('"')) {
    try {
      p = JSON.parse(p);
    } catch {
      p = p.slice(1, -1);
    }
  }
  return normalizeRel(p);
}

function parseCleanDryRun(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.match(/^Would remove (.+)$/))
    .filter(Boolean)
    .map((m) => unquoteGitPath(m[1]));
}

function collectGitContext() {
  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  const commit = runGit(['rev-parse', 'HEAD']);
  const shortCommit = runGit(['rev-parse', '--short', 'HEAD']);
  const tags = runGit(['tag', '--points-at', 'HEAD']);
  const status = runGit(['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-z', '-uall']);
  const tracked = runGit(['-c', 'core.quotepath=false', 'ls-files', '-z']);
  const clean = runGit(['-c', 'core.quotepath=false', 'clean', '-nd']);

  if (!branch.ok || !commit.ok || !status.ok || !tracked.ok) {
    const detail = [branch, commit, status, tracked]
      .filter((r) => !r.ok)
      .map((r) => r.error || r.stderr || `git exit ${r.status}`)
      .join('; ');
    throw new Error(`git 检查失败: ${detail}`);
  }

  const statusEntries = parseStatusZ(status.stdout);
  const trackedFiles = tracked.stdout.split('\0').filter(Boolean).map(normalizeRel);
  const cleanDryRun = clean.ok ? parseCleanDryRun(clean.stdout) : [];

  return {
    branch: branch.stdout.trim(),
    commit: commit.stdout.trim(),
    shortCommit: shortCommit.ok ? shortCommit.stdout.trim() : commit.stdout.trim().slice(0, 7),
    tags: tags.ok ? tags.stdout.split(/\r?\n/).filter(Boolean) : [],
    status: statusEntries,
    tracked: trackedFiles,
    cleanDryRun,
    cleanOk: clean.ok,
  };
}

function buildWorkingFiles(git) {
  const set = new Set(git.tracked);
  for (const entry of git.status) {
    if (entry.code === '??') set.add(entry.path);
  }
  return [...set].filter((p) => {
    try {
      return fs.statSync(path.join(ROOT, p)).isFile();
    } catch {
      return false;
    }
  }).sort();
}

const textCache = new Map();
function readText(relPath) {
  if (textCache.has(relPath)) return textCache.get(relPath);
  let text = null;
  try {
    const abs = path.join(ROOT, relPath);
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > 8 * 1024 * 1024) {
      textCache.set(relPath, null);
      return null;
    }
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) {
      textCache.set(relPath, null);
      return null;
    }
    text = buf.toString('utf8');
  } catch {
    text = null;
  }
  textCache.set(relPath, text);
  return text;
}

function linesOf(relPath) {
  const text = readText(relPath);
  return text === null ? null : text.split(/\r?\n/);
}

function finding(rule, fields) {
  const meta = RULES[rule];
  if (!meta) throw new Error(`未定义规则: ${rule}`);
  const count = fields.count === undefined ? 1 : fields.count;
  return {
    id: `${rule}|${fields.file}|${fields.key}`,
    rule,
    severity: fields.severity || meta.severity,
    check: meta.check,
    gate: fields.gate || meta.gate,
    owner: fields.owner || meta.owner || DEFAULT_OWNER,
    file: fields.file,
    key: fields.key,
    count,
    message: fields.message,
    lines: fields.lines || [],
    note: fields.note || meta.note,
  };
}

function createFindingStore() {
  const map = new Map();
  return {
    add(rule, fields) {
      const f = finding(rule, fields);
      const existing = map.get(f.id);
      if (existing) {
        existing.count += f.count;
        existing.lines.push(...f.lines);
        if (f.message && !existing.message.includes(f.message)) {
          existing.message = `${existing.message}；${f.message}`;
        }
        return existing;
      }
      map.set(f.id, f);
      return f;
    },
    all() {
      return [...map.values()].map((f) => {
        const lines = [...new Set(f.lines)].sort((a, b) => a - b);
        return { ...f, lines: lines.slice(0, 20) };
      }).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
  };
}

function filesMatching(workingFiles, prefixes, extensions, extraExclude = []) {
  return workingFiles.filter((p) => {
    if (p === SELF) return false;
    if (isScanExcluded(p)) return false;
    if (extraExclude.some((prefix) => p.startsWith(prefix))) return false;
    if (!prefixes.some((prefix) => p.startsWith(prefix))) return false;
    return extensions.has(extOf(p));
  });
}

function countMatches(line, re) {
  const m = line.match(re);
  return m ? m.length : 0;
}

function uniqueSorted(nums) {
  return [...new Set(nums)].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function checkGit(git, workingFiles, store) {
  const expectedChanges = [];
  const statusPaths = new Set();
  for (const entry of git.status) {
    for (const p of [entry.path, entry.from].filter(Boolean)) statusPaths.add(normalizeRel(p));
    if (isGate0GitChange(entry)) {
      expectedChanges.push(entry);
      continue;
    }
    store.add('git-unowned', {
      file: entry.path,
      key: entry.code,
      message: `工作区条目 ${entry.code} 不属于 Gate 0 计划内文件`,
    });
  }

  for (const p of git.cleanDryRun) {
    if (statusPaths.has(p)) continue;
    if (isGate0PlannedPath(p)) continue;
    store.add('git-clean-unowned', {
      file: p,
      key: 'clean',
      message: 'git clean -nd 列出未归属的临时文件或目录',
    });
  }

  return { expectedChanges, cleanDryRun: git.cleanDryRun };
}

const SUSPICIOUS_RE = /(_old|_new|_v\d+|copy|backup|bak|tmp|deprecated)/i;
function checkSuspiciousFilenames(workingFiles, store) {
  let scanned = 0;
  for (const file of workingFiles) {
    if (isScanExcluded(file)) continue;
    if (file.startsWith('worklog/') || file.startsWith('docs/research/')) continue;
    scanned++;
    const m = file.match(SUSPICIOUS_RE);
    if (!m) continue;
    store.add('suspicious-filename', {
      file,
      key: m[1].toLowerCase(),
      message: `可疑文件名/路径片段 "${m[1]}"`,
    });
  }
  return { scanned };
}

function checkTodos(workingFiles, store) {
  const files = filesMatching(
    workingFiles,
    ['src/', 'tools/', 'scripts/', 'tests/'],
    CODE_EXT,
    ['src/native/third_party/', 'tests/fixtures/'],
  );
  for (const file of files) {
    const lines = linesOf(file);
    if (!lines) continue;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/https?:\/\//i.test(line)) continue;
      const m = line.match(/\b(TODO|FIXME|XXX|HACK|DEPRECATED)\b/);
      if (!m) continue;
      const hasDate = /\b20\d{2}[-/.]\d{1,2}(?:[-/.]\d{1,2})?\b/.test(line);
      const hasOwner = /(@[A-Za-z0-9_.-]+|\bowner\s*[:=]|\bassignee\s*[:=]|负责人|\b(?:TODO|FIXME|XXX|HACK|DEPRECATED)\s*\(\s*[A-Za-z0-9_.@-]+\s*[,)])/i.test(line);
      if (hasDate && hasOwner) continue;
      const missing = [!hasDate ? '日期' : null, !hasOwner ? 'owner' : null].filter(Boolean).join('+');
      const excerpt = line.trim().slice(0, 120);
      store.add('todo-metadata', {
        file,
        key: `${m[1]}:${sha1(line.trim()).slice(0, 12)}`,
        message: `${m[1]} 缺少 ${missing}: ${excerpt}`,
        lines: [i + 1],
      });
    }
  }
  return { files: files.length };
}

// A violation is an *access*, not a mention. Provider tokens in quoted labels
// (`net.dostring_in(scripting)`, the SAR capability strings) and comments are
// data; `codeOnly` blanks both before the scan. A real call still needs the
// opening parenthesis, so `lfs.writedir()`, `package.loadlib(...)` and
// `terrain.GetHeight(x)` remain violations.

function apiCallsOnLine(line, pattern, python = false) {
  // A provider token inside a quoted label ("net.dostring_in(scripting)") is
  // data, not a call. Blank strings/comments first, then require a call.
  const code = codeOnly(line, python);
  const re = new RegExp(pattern.re.source, 'g');
  let calls = 0;
  for (const match of code.matchAll(re)) {
    const rest = code.slice(match.index + match[0].length);
    if (/^\s*\(/.test(rest)) calls++;
  }
  return calls;
}

// Constants are definitions, not text: blank quoted literals and drop comments before counting. A
// number in a metadata string ("lambda=0.03") or a comment describes the value, it does not define a
// second one. HTML body text is markup, not a quoted literal, and stays for the caller to judge.
function codeOnly(line, python = false) {
  let out = '', quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') { i++; out += '  '; continue; }
      if (c === quote) quote = null;
      out += ' ';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; out += ' '; continue; }
    if (c === '-' && line[i + 1] === '-') break;
    if (c === '/' && line[i + 1] === '/') break;
    if (python && c === '#') break;
    out += c;
  }
  return out;
}

function checkGameApi(workingFiles, store) {
  const files = filesMatching(
    workingFiles,
    ['src/', 'tools/', 'scripts/'],
    CODE_EXT,
    // Host-side installers write Saved Games from Node/Python; the `lfs.`
    // text they carry is a deployed Lua string, not a game-process call.
    ['src/native/', 'src/adapters/dcs/api/', 'scripts/install_'],
  );
  for (const file of files) {
    const lines = linesOf(file);
    if (!lines) continue;
    for (const pattern of GAME_API_PATTERNS) {
      const hitLines = [];
      let count = 0;
      for (let i = 0; i < lines.length; i++) {
        const n = apiCallsOnLine(lines[i], pattern, file.endsWith('.py'));
        if (n > 0) {
          count += n;
          hitLines.push(i + 1);
        }
      }
      if (count === 0) continue;
      store.add('game-api-out-of-bounds', {
        file,
        key: pattern.key,
        count,
        lines: uniqueSorted(hitLines),
        message: `${pattern.key} 调用出现在 ${file}；允许位置只有 src/adapters/dcs/api/`,
      });
    }
  }
  return { apiDirExists: fs.existsSync(path.join(ROOT, 'src', 'adapters', 'dcs', 'api')) };
}

// A spec source is where a parameter is *defined*; spec/*.json names the file **and the line**, so a
// value on that line is not a second copy. The exemption stays per line rather than per file: a hook
// that is a source for the scene version must not also hide an unrelated hard-coded port or footprint
// pair on another line. `src/shared/` and the generated artifacts stay explicitly allowed because
// they are generator outputs rather than sources.
let specSourceLinesCache = null;
function specSourceLines() {
  if (specSourceLinesCache) return specSourceLinesCache;
  const byFile = new Map();
  for (const name of ['physics', 'radar', 'sar', 'protocol', 'deployment', 'display']) {
    let spec;
    try {
      spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'spec', `${name}.json`), 'utf8'));
    } catch {
      continue;
    }
    for (const source of Object.values(spec.sources || {})) {
      if (!source || typeof source.file !== 'string') continue;
      const file = normalizeRel(source.file);
      const line = Number(source.line);
      if (!Number.isInteger(line) || line < 1) continue;
      if (!byFile.has(file)) byFile.set(file, new Set());
      byFile.get(file).add(line);
    }
  }
  specSourceLinesCache = byFile;
  return byFile;
}

function isConstantAllowed(file) {
  return file.startsWith('spec/')
    || file.startsWith('tests/fixtures/')
    || file.startsWith('src/shared/')
    || file.startsWith('src/adapters/dcs/compat/profiles/')
    || file.includes('/generated/')
    || file.startsWith('src/native/generated/');
}

function checkConstants(workingFiles, store) {
  const files = filesMatching(
    workingFiles,
    ['src/', 'tools/', 'scripts/', 'tests/', 'spec/'],
    CODE_EXT,
    ['src/native/', 'tests/fixtures/'],
  );
  const sourceLines = specSourceLines();
  for (const file of files) {
    if (isConstantAllowed(file)) continue;
    const declaredLines = sourceLines.get(normalizeRel(file));
    const lines = linesOf(file);
    if (!lines) continue;
    for (const rule of CONSTANT_RULES) {
      const hitLines = [];
      let count = 0;
      for (let i = 0; i < lines.length; i++) {
        if (declaredLines && declaredLines.has(i + 1)) continue;
        const line = lines[i];
        // A value named in a comment or a quoted string is documentation, not a second definition.
        const code = codeOnly(line, file.endsWith('.py'));
        if (rule.lineRe && !rule.lineRe.test(code)) continue;
        const n = countMatches(code, rule.re);
        if (n > 0) {
          count += n;
          hitLines.push(i + 1);
        }
      }
      if (count === 0) continue;
      store.add('duplicate-constant', {
        file,
        key: rule.key,
        count,
        lines: uniqueSorted(hitLines),
        message: `${rule.label} ${rule.key} 在 ${file} 出现 ${count} 次；应只在 spec/、生成物或 tests/fixtures/`,
      });
    }
  }
  return { files: files.length };
}

function resolveRelativeModule(fromFile, target) {
  const base = path.resolve(path.dirname(path.join(ROOT, fromFile)), target);
  const candidates = [base];
  if (!path.extname(base)) {
    for (const ext of ['.cjs', '.js', '.mjs', '.json']) candidates.push(base + ext);
    for (const ext of ['.cjs', '.js', '.mjs']) candidates.push(path.join(base, `index${ext}`));
  }
  return candidates.some((c) => {
    try {
      return fs.statSync(c).isFile();
    } catch {
      return false;
    }
  });
}

function checkLegacy(workingFiles, store) {
  const files = filesMatching(
    workingFiles,
    ['src/', 'tools/', 'scripts/', 'tests/'],
    CODE_EXT,
    ['src/native/third_party/', 'tests/fixtures/'],
  );
  for (const file of files) {
    const lines = linesOf(file);
    if (!lines) continue;

    for (const entry of LEGACY_SYMBOLS) {
      const re = new RegExp(`\\b${entry.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
      const hitLines = [];
      let count = 0;
      for (let i = 0; i < lines.length; i++) {
        const n = countMatches(lines[i], re);
        if (n > 0) {
          count += n;
          hitLines.push(i + 1);
        }
      }
      if (count === 0) continue;
      store.add('legacy-symbol', {
        file,
        key: entry.symbol,
        count,
        lines: uniqueSorted(hitLines),
        gate: entry.gate,
        note: entry.note,
        message: `旧符号 ${entry.symbol} 仍被引用（${entry.gate} 清理目标）`,
      });
    }

    if (JS_EXT.has(extOf(file))) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const targets = [];
        const requireRe = /\brequire\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;
        const importRe = /\bfrom\s+['"](\.[^'"]+)['"]/g;
        let m;
        while ((m = requireRe.exec(line))) targets.push(m[1]);
        while ((m = importRe.exec(line))) targets.push(m[1]);
        for (const target of targets) {
          if (!resolveRelativeModule(file, target)) {
            store.add('broken-require', {
              file,
              key: target,
              message: `相对引用目标不存在: ${target}`,
              lines: [i + 1],
            });
          }
        }
      }
    }

    if (file.startsWith('tools/') && extOf(file) === '.py') {
      const hitLines = [];
      let count = 0;
      for (let i = 0; i < lines.length; i++) {
        if (/^\s*(?:from|import)\s+(?:tests|run_tests)\b/.test(lines[i])
            || /sys\.path\.insert\([^)]*["']tests["']/.test(lines[i])) {
          count++;
          hitLines.push(i + 1);
        }
      }
      if (count > 0) {
        store.add('tests-import-in-prod', {
          file,
          key: 'tests',
          count,
          lines: uniqueSorted(hitLines),
          message: '生产工具直接依赖 tests/；Gate 4 应拆出共享 Lua 加载/协议模块',
        });
      }
    }
  }
  return { files: files.length, watchedSymbols: LEGACY_SYMBOLS.length };
}

const VALID_DOC_STATUS = new Set(['current', 'historical', 'external-reference', 'draft']);
function findDocStatus(text) {
  // The document-level status lives in the header (front matter, a metadata
  // table, or a bullet).  ADR sections later in the file also use "状态",
  // so only the first 30 lines are considered.
  const head = text.split(/\r?\n/).slice(0, 30).join('\n');
  const validPatterns = [
    /(?:^|\n)[ \t]*(?:>\s*)?(?:[-*][ \t]+)?(?:\*\*)?(?:状态|status)(?:\*\*)?[ \t]*[:：][ \t]*(?:\*\*|`)?[ \t]*(current|historical|external-reference|draft)\b/i,
    /(?:^|\n)[ \t]*\|[ \t]*(?:状态|status)[ \t]*\|[ \t]*(?:\*\*|`)?[ \t]*(current|historical|external-reference|draft)\b/i,
  ];
  for (const re of validPatterns) {
    const m = head.match(re);
    if (m) return { valid: true, token: m[1] };
  }
  const anyPatterns = [
    /(?:^|\n)[ \t]*(?:>\s*)?(?:[-*][ \t]+)?(?:\*\*)?(?:状态|status)(?:\*\*)?[ \t]*[:：][ \t]*([^\n]{1,60})/i,
    /(?:^|\n)[ \t]*\|[ \t]*(?:状态|status)[ \t]*\|[ \t]*([^|\n]{1,60})/i,
  ];
  for (const re of anyPatterns) {
    const m = head.match(re);
    if (m) return { valid: false, value: m[1].trim().replace(/[*`]/g, '').slice(0, 40) };
  }
  return { valid: false, value: null };
}

function checkDocs(workingFiles, store) {
  const docs = workingFiles.filter((p) => p.startsWith('docs/') && extOf(p) === '.md');
  for (const file of docs) {
    const text = readText(file);
    if (!text) continue;
    const status = findDocStatus(text);
    if (status.valid && VALID_DOC_STATUS.has(status.token.toLowerCase())) continue;
    if (status.value) {
      store.add('docs-status-invalid', {
        file,
        key: 'invalid-status',
        message: `状态标签 "${status.value}" 不在 current|historical|external-reference|draft 中`,
      });
    } else {
      store.add('docs-status-missing', {
        file,
        key: 'missing-status',
        message: '缺少文档状态标签（current|historical|external-reference|draft）',
      });
    }
  }

  // worklog/index.md is local-only (.gitignore): scan it when present, but a
  // fresh clone without it is not an error.
  const linkFiles = [
    ...docs,
    'README.md',
    'AGENTS.md',
    'worklog/index.md',
  ].filter((p) => fs.existsSync(path.join(ROOT, p)));

  for (const file of linkFiles) {
    const lines = linesOf(file);
    if (!lines) continue;
    const dead = new Map();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const targets = [];
      const inlineRe = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
      const refRe = /^\s*\[[^\]]+\]:\s*(\S+)/;
      let m;
      while ((m = inlineRe.exec(line))) targets.push(m[1]);
      const ref = line.match(refRe);
      if (ref) targets.push(ref[1]);
      for (const rawTarget of targets) {
        const resolved = resolveLocalLink(file, rawTarget);
        if (!resolved) continue;
        if (fs.existsSync(resolved.abs)) continue;
        const relTarget = normalizeRel(path.relative(ROOT, resolved.abs));
        // worklog/ is local-only; tracked docs may reference it without the
        // link being dead on a fresh clone.
        if (isLocalOnlyPath(relTarget)) continue;
        if (isGate0PlannedPath(relTarget)) {
          store.add('docs-pending-link', {
            file,
            key: rawTarget,
            message: `链接目标 ${rawTarget} 属于 Gate 0 计划文件，当前尚未生成`,
            lines: [i + 1],
          });
          continue;
        }
        const prev = dead.get(rawTarget) || { count: 0, lines: [] };
        prev.count++;
        prev.lines.push(i + 1);
        dead.set(rawTarget, prev);
      }
    }
    for (const [target, info] of dead) {
      store.add('dead-link', {
        file,
        key: target,
        count: info.count,
        lines: uniqueSorted(info.lines),
        message: `本地链接目标不存在: ${target}`,
      });
    }
  }
  return { docs: docs.length, linkFiles: linkFiles.length };
}

function resolveLocalLink(fromFile, rawTarget) {
  let target = String(rawTarget).trim();
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
  if (!target) return null;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) return null;
  if (target.startsWith('#')) return null;
  if (/^[A-Za-z]:[\\/]/.test(target)) return null;
  target = target.split('#')[0].split('?')[0];
  if (!target) return null;
  try {
    target = decodeURIComponent(target);
  } catch {
    // Keep the raw target; fs will simply report it missing.
  }
  target = target.replace(/\\/g, '/');
  const abs = target.startsWith('/')
    ? path.join(ROOT, target.slice(1))
    : path.resolve(path.dirname(path.join(ROOT, fromFile)), target);
  return { abs };
}

function checkGenerated(workingFiles, store) {
  const candidates = workingFiles.filter((p) => (
    p.startsWith('src/shared/')
    || p.includes('/generated/')
    || p === 'src/adapters/dcs/rcs_data.lua'
  ));
  for (const file of candidates) {
    const lines = linesOf(file);
    if (!lines) continue;
    const header = lines.slice(0, 40).join('\n');
    const doNotEdit = /DO NOT EDIT|do not edit|勿手改|请勿(?:手工)?(?:编辑|修改)|生成文件/i.test(header);
    const generator = /(?:generated\s+by|generator|由\s*[`'"]?(?:scripts|tools)[\\/][\w./\\-]+|(?:scripts|tools)[\\/][\w./\\-]+\.(?:py|cjs|js))/i.test(header);
    const hash = /(?:sha-?256|content[- ]hash|generator[- ]hash|\bhash\b)\s*[:=]?\s*[a-f0-9]{8,}|\b[a-f0-9]{32,}\b/i.test(header);
    if (!doNotEdit) {
      store.add('generated-header', { file, key: 'do-not-edit', message: '生成物缺少 DO NOT EDIT/勿手改 标记' });
    }
    if (!generator) {
      store.add('generated-header', { file, key: 'generator', message: '生成物缺少 generator 来源' });
    }
    if (!hash) {
      store.add('generated-header', { file, key: 'hash', message: '生成物缺少内容 hash（无法验证重生成一致）' });
    }
  }
  return { checked: candidates };
}

function checkTestSkips(workingFiles, store) {
  const files = workingFiles.filter((p) => (
    p.startsWith('tests/')
    && !p.startsWith('tests/baseline/')
    && !p.startsWith('tests/fixtures/')
    && ['.cjs', '.js', '.mjs', '.py', '.lua'].includes(extOf(p))
  ));
  const skipSites = [];
  for (const file of files) {
    const lines = linesOf(file);
    if (!lines) continue;
    const sites = [];
    const seenLines = new Set();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let matched = false;
      let conditional = false;
      let reason = false;
      let reasonText = null;

      const nodeOptions = line.match(/\b(?:test|it)\s*\([^\n]*?\{\s*skip\s*:\s*([^}]*)\}/);
      if (nodeOptions) {
        matched = true;
        const expr = nodeOptions[1];
        conditional = /(?:!|&&|\|\||process\.env|os\.environ|\blua\b|\benv\b|platform)/i.test(expr);
        const reasonMatch = expr.match(/['"]([^'"]+)['"]/);
        reason = Boolean(reasonMatch);
        reasonText = reasonMatch ? reasonMatch[1] : null;
      } else if (/\btest\.skip\s*\(|\bit\.skip\s*\(|\bt\.skip\s*\(/.test(line)) {
        matched = true;
      } else if (/@(?:unittest\.)?skip(If|Unless)?\b/.test(line) || /pytest\.mark\.skip(if)?\b/.test(line)) {
        matched = true;
        conditional = /skipIf|skipUnless|skipif/i.test(line);
      }

      if (!matched || seenLines.has(i + 1)) continue;
      seenLines.add(i + 1);
      sites.push({ line: i + 1, conditional, reason, reasonText });
    }
    if (sites.length === 0) continue;

    const unconditional = sites.filter((s) => !s.conditional).length;
    const conditional = sites.length - unconditional;
    const withReason = sites.filter((s) => s.reason).length;
    const reasons = [...new Set(sites.map((s) => s.reasonText).filter(Boolean))];
    const critical = CRITICAL_TEST_RE.test(file);
    const severity = (unconditional > 0 || critical) ? 'error' : 'warn';
    skipSites.push({ file, count: sites.length, unconditional, conditional, withReason, reasons, critical });
    // A conditional skip with a reason is an environment gate, not a hidden
    // failure: report it in the summary but do not make it a finding. Critical
    // suites and unconditional/reasonless skips stay findings.
    if (unconditional > 0 || withReason < sites.length || critical) {
      store.add('test-skip', {
        file,
        key: 'skips',
        count: sites.length,
        severity,
        lines: sites.map((s) => s.line),
        message: `测试跳过 ${sites.length} 处（无条件 ${unconditional}，条件 ${conditional}，带原因 ${withReason}）`
          + `${reasons.length ? `；原因: ${reasons.join(' | ')}` : '；未写原因'}${critical ? '；关键套件' : ''}`,
      });
    }
  }
  return { skipSites };
}

function artifactReason(p) {
  if (p.startsWith('recordings/')) return 'recordings/ 是本机飞行录制目录，不应入库';
  if (p.includes('/__pycache__/') || p.startsWith('__pycache__/') || p.endsWith('.pyc')) return 'Python 缓存不应入库';
  if (p.startsWith('dist/') && p !== 'dist/.gitkeep') return 'dist/ 只允许 dist/.gitkeep';
  return null;
}

function checkTrackedArtifacts(git, store) {
  let recordings = 0;
  let pycache = 0;
  let dist = 0;
  for (const file of git.tracked) {
    const reason = artifactReason(file);
    if (!reason) continue;
    if (file.startsWith('recordings/')) recordings++;
    else if (file.includes('/__pycache__/') || file.startsWith('__pycache__/') || file.endsWith('.pyc')) pycache++;
    else if (file.startsWith('dist/')) dist++;
    store.add('tracked-artifact', {
      file,
      key: reason.split(' ')[0],
      message: reason,
    });
  }

  const gitignorePath = path.join(ROOT, '.gitignore');
  const gitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
  const required = [
    { key: 'recordings/', re: /^recordings\/?$/m, message: '缺少 recordings/ 忽略规则' },
    { key: '__pycache__/', re: /^__pycache__\/?$/m, message: '缺少 __pycache__/ 忽略规则' },
    { key: 'dist/*', re: /^dist\/\*$/m, message: '缺少 dist/* 忽略规则' },
    { key: '!dist/.gitkeep', re: /^!dist\/\.gitkeep$/m, message: '缺少 !dist/.gitkeep 例外' },
  ];
  for (const item of required) {
    if (item.re.test(gitignore)) continue;
    store.add('gitignore-missing', {
      file: '.gitignore',
      key: item.key,
      message: item.message,
    });
  }
  return {
    trackedFiles: git.tracked.length,
    trackedRecordings: recordings,
    trackedPycache: pycache,
    trackedDist: dist,
  };
}

// 敏感方法措辞（内容纪律，见 CONTRIBUTING.md）：仓库只写事实（偏移、签名、
// 行为、哈希），不写获取方法。命中即 error；存量命中登记在
// tests/baseline/audit-baseline.json，新增一处即 FAIL。
const WORDING_RULES = [
  { id: 'unpack', re: /解包/, label: '解包' },
  { id: 'decompile-zh', re: /反编译/, label: '反编译' },
  { id: 'disasm-zh', re: /反汇编/, label: '反汇编' },
  { id: 'reverse-zh', re: /逆向/, label: '逆向' },
  { id: 'unpack-shell', re: /脱壳/, label: '脱壳' },
  { id: 'source-extract', re: /源码提取|嵌入源码|字符串提取/, label: '源码提取' },
  { id: 'decompile-en', re: /decompil/i, label: 'decompile' },
  { id: 'disasm-en', re: /disassembl/i, label: 'disassemble' },
  { id: 're-tools', re: /Hex-Rays|IDA Pro|Ghidra|x64dbg|nupkg/i, label: 'RE 工具/格式名' },
];

// tests/baseline/ 是 allowlist 本身（关键词作为数据出现）；third_party 不改造。
const WORDING_EXCLUDED = ['tests/baseline/', 'src/native/third_party/'];

function scanWordingLines(store, file, lines) {
  let hits = 0;
  lines.forEach((line, index) => {
    for (const rule of WORDING_RULES) {
      if (!rule.re.test(line)) continue;
      hits += 1;
      // 只报告位置与规则名，不回显行内容（公开 CI 日志可见）。
      store.add('sensitive-wording', {
        file,
        key: `L${index + 1}`,
        message: `命中措辞规则 ${rule.id}（${rule.label}）`,
        lines: [index + 1],
      });
    }
  });
  return hits;
}

function checkWording(git, workingFiles, store) {
  const files = filesMatching(workingFiles, [''], new Set([...TEXT_EXT, ...CODE_EXT]), WORDING_EXCLUDED);
  let fileHits = 0;
  for (const relPath of files) {
    fileHits += scanWordingLines(store, relPath, linesOf(relPath));
  }
  let commitHits = 0;
  let commits = 0;
  const log = runGit(['log', '--format=%H%x00%B%x00', '-n', '50']);
  if (log.ok && log.stdout) {
    const parts = log.stdout.split('\0');
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const sha = parts[i].trim();
      const body = parts[i + 1];
      if (!sha || !body.trim()) continue;
      commits += 1;
      commitHits += scanWordingLines(store, `git-log/${sha.slice(0, 12)}`, body.split(/\r?\n/));
    }
  }
  return { scannedFiles: files.length, scannedCommits: commits, fileHits, commitHits };
}

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

function loadBaseline(baselinePath) {
  if (!fs.existsSync(baselinePath)) {
    return { present: false, path: baselinePath, entries: new Map(), json: null, error: null };
  }
  let json;
  try {
    json = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  } catch (e) {
    return { present: true, path: baselinePath, entries: new Map(), json: null, error: e.message };
  }
  const list = Array.isArray(json.allowlist) ? json.allowlist : [];
  const entries = new Map();
  for (const entry of list) {
    if (!entry || typeof entry.id !== 'string') continue;
    const count = Number.isFinite(entry.count) && entry.count > 0 ? entry.count : 1;
    entries.set(entry.id, { ...entry, count });
  }
  return { present: true, path: baselinePath, entries, json, error: null };
}

function applyBaseline(findings, baseline) {
  let stale = 0;
  const matchedIds = new Set();
  const result = findings.map((f) => {
    const entry = baseline.entries.get(f.id);
    if (!entry) {
      return { ...f, status: 'new', baselineCount: 0, newCount: f.count };
    }
    matchedIds.add(f.id);
    const sameSeverity = !entry.severity || entry.severity === f.severity;
    if (f.count <= entry.count && sameSeverity) {
      return { ...f, status: 'known', baselineCount: entry.count, newCount: 0 };
    }
    return {
      ...f,
      status: 'new',
      baselineCount: entry.count,
      baselineSeverity: entry.severity || null,
      escalated: !sameSeverity,
      newCount: Math.max(0, f.count - entry.count),
    };
  });
  const staleIds = [];
  for (const id of baseline.entries.keys()) {
    if (!matchedIds.has(id)) {
      stale++;
      staleIds.push(id);
    }
  }
  return { findings: result, stale, staleIds };
}

function buildSummary(findings, opts, baselineInfo, extra) {
  const isNew = (f, sev) => f.status === 'new' && f.severity === sev;
  const isKnown = (f, sev) => f.status === 'known' && f.severity === sev;
  const sum = (list, key) => list.reduce((n, f) => n + f[key], 0);
  const newErrors = findings.filter((f) => isNew(f, 'error'));
  const newWarnings = findings.filter((f) => isNew(f, 'warn'));
  const knownErrors = findings.filter((f) => isKnown(f, 'error'));
  const knownWarnings = findings.filter((f) => isKnown(f, 'warn'));
  const pass = newErrors.length === 0 && (!opts.strict || newWarnings.length === 0);
  return {
    pass,
    strict: opts.strict,
    newErrors: newErrors.length,
    newWarnings: newWarnings.length,
    knownErrors: knownErrors.length,
    knownWarnings: knownWarnings.length,
    newErrorOccurrences: sum(newErrors, 'count'),
    newWarningOccurrences: sum(newWarnings, 'count'),
    knownErrorOccurrences: sum(knownErrors, 'count'),
    knownWarningOccurrences: sum(knownWarnings, 'count'),
    totalFindings: findings.length,
    expectedChanges: extra.expectedChanges.length,
    staleBaselineEntries: baselineInfo.stale,
    baselinePresent: baselineInfo.present,
  };
}

function writeBaseline(baselinePath, findings, git) {
  const entries = findings.map((f) => ({
    id: f.id,
    rule: f.rule,
    severity: f.severity,
    check: f.check,
    gate: f.gate,
    owner: f.owner,
    file: f.file,
    key: f.key,
    count: f.count,
    message: f.message,
    note: f.note,
  })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const ruleCatalog = {};
  for (const [rule, meta] of Object.entries(RULES)) {
    ruleCatalog[rule] = {
      check: meta.check,
      severity: meta.severity,
      gate: meta.gate,
      owner: meta.owner || DEFAULT_OWNER,
      note: meta.note,
    };
  }

  const json = {
    schema: 1,
    schemaVersion: 1,
    gate: 0,
    command: 'node scripts/audit_repo.cjs --update-baseline',
    cwd: '<repo>',
    commit: git.commit,
    baselineTag: 'pre-arch-refactor',
    generatedAt: new Date().toISOString(),
    generatedBy: 'scripts/audit_repo.cjs --update-baseline',
    description: 'Gate 0 已知问题 allowlist。audit_repo.cjs 只把基线之外的 error 计为失败；warn 不改变退出码（--strict 时改变）。',
    git: {
      branch: git.branch,
      commit: git.commit,
      shortCommit: git.shortCommit,
      tags: git.tags,
    },
    environment: {
      os: process.platform === 'win32' ? 'Windows' : process.platform,
      node: process.version,
      python: process.env.AESA_PYTHON || null,
      lupa: null,
      dcsBuild: null,
      lua: process.env.AESA_LUA || null,
      savedGames: process.env.AESA_SAVED_GAMES || null,
      note: 'audit_repo 本身不需要 Python/lupa/DCS；这些字段留作 Gate 环境记录。',
    },
    inputs: {
      scope: 'git tracked + untracked non-ignored files',
      baseline: 'tests/baseline/audit-baseline.json',
    },
    metrics: {
      trackedFiles: git.tracked.length,
      findings: findings.length,
      errors: findings.filter((f) => f.severity === 'error').length,
      warnings: findings.filter((f) => f.severity === 'warn').length,
    },
    tolerance: {},
    expectedGate0Paths: [...GATE0_NEW_FILES, ...GATE0_MODIFIED_FILES].sort(),
    expectedGate0ModifiedPaths: [...GATE0_MODIFIED_FILES].sort(),
    expectedGate0Prefixes: [...GATE0_EXPECTED_PREFIXES],
    notes: [
      '本文件只记录 Gate 0 当时已经存在的问题，不代表问题可接受。',
      '后续 Gate 修复后删除对应条目；用 --update-baseline 重新生成，不要手改计数来“变绿”。',
      '新增条目必须能解释归属（Gate/owner），不得为了通过审计修改业务代码。',
      '生成物只校验头标记，未重新运行 generator 验证内容 hash。',
      '测试 skip 为静态标记计数；运行时 skip 以 scripts/test_all.cjs 的报告为准。',
      '本地链接只校验路径存在，不校验 #anchor。',
      'Lua dofile/loadfile 与 Python 动态 sys.path 导入不做全量解析；只检查 JS 相对 require 和生产工具对 tests/ 的依赖。',
      '文档状态只读前 30 行，避免 ADR 的“状态：Accepted”被误认成文档级状态。',
    ],
    ruleCatalog,
    allowlist: entries,
  };

  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  fs.writeFileSync(baselinePath, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
  return entries.length;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function lineRef(f) {
  if (!f.lines || f.lines.length === 0) return f.file;
  const first = f.lines[0];
  return `${f.file}:${first}`;
}

function printHuman(report, opts) {
  const out = [];
  const { summary, git, baseline, findings, checks, extra } = report;
  out.push('aesa repo audit — Gate 0');
  out.push(`root: ${ROOT}`);
  out.push(`git: ${git.branch} @ ${git.shortCommit}${git.tags.length ? ` (tags: ${git.tags.join(', ')})` : ''}`);
  out.push(`baseline: ${path.relative(ROOT, baseline.path) || baseline.path}`
    + (baseline.present
      ? ` (${baseline.entries.size} entries${baseline.json && baseline.json.generatedAt ? `, ${baseline.json.generatedAt}` : ''})`
      : ' (missing — all findings are new; run --update-baseline)'));
  out.push(`working tree: ${summary.expectedChanges} expected Gate 0 change(s), `
    + `${git.status.filter((e) => !isGate0GitChange(e)).length} unowned`);

  if (baseline.error) out.push(`baseline error: ${baseline.error}`);

  const newFindings = findings
    .filter((f) => f.status === 'new')
    .sort((a, b) => {
      const rank = (f) => (f.severity === 'error' ? 0 : 1);
      return rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
  out.push('');
  out.push(`NEW FINDINGS (${summary.newErrors} errors / ${summary.newWarnings} warnings)`);
  if (newFindings.length === 0) {
    out.push('  none');
  } else {
    for (const f of newFindings) {
      const extraCount = f.baselineCount > 0
        ? (f.escalated ? ` (severity escalated from ${f.baselineSeverity})` : ` (+${f.newCount} beyond baseline)`)
        : '';
      out.push(`  [${f.severity}] ${f.rule} ${lineRef(f)}${extraCount}`);
      out.push(`    ${f.message}${f.count > 1 ? ` (${f.count} occurrences)` : ''}`);
      if (f.note) out.push(`    note: ${f.note}`);
    }
  }

  const knownFindings = findings.filter((f) => f.status === 'known');
  out.push('');
  out.push(`KNOWN (suppressed by baseline): ${summary.knownErrors} errors / ${summary.knownWarnings} warnings`
    + ` (${summary.knownErrorOccurrences + summary.knownWarningOccurrences} occurrences)`);
  for (const check of checks) {
    const ns = check.newFindings;
    const ks = check.knownFindings;
    if (ns === 0 && ks === 0) continue;
    out.push(`  ${check.label}: ${ns} new / ${ks} known`);
  }

  if (opts.verbose && knownFindings.length > 0) {
    out.push('');
    out.push('KNOWN DETAIL');
    for (const f of knownFindings) {
      out.push(`  [known][${f.severity}] ${f.rule} ${lineRef(f)} — ${f.message}`);
    }
  }

  out.push('');
  out.push('CHECKS');
  for (const check of checks) {
    const details = check.details && Object.keys(check.details).length
      ? ` (${Object.entries(check.details).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')})`
      : '';
    const status = check.newErrorFindings > 0
      ? 'FAIL'
      : check.newFindings > 0
        ? (opts.strict ? 'FAIL' : 'WARN')
        : 'ok';
    out.push(`  ${check.label}: ${status}; ${check.newFindings} new / ${check.knownFindings} known${details}`);
  }

  if (summary.staleBaselineEntries > 0) {
    out.push('');
    out.push(`baseline: ${summary.staleBaselineEntries} entr${summary.staleBaselineEntries === 1 ? 'y' : 'ies'} no longer matched (tighten with --update-baseline)`);
    if (opts.verbose) {
      for (const id of baseline.staleIds || []) out.push(`  stale: ${id}`);
    }
  }

  out.push('');
  if (summary.pass) {
    out.push(`RESULT: PASS — ${summary.newErrors} new errors, ${summary.newWarnings} new warnings; `
      + `${summary.knownErrors + summary.knownWarnings} known findings suppressed by baseline.`);
  } else {
    const why = summary.strict && summary.newErrors === 0
      ? `${summary.newWarnings} new warnings (--strict)`
      : `${summary.newErrors} new errors`;
    out.push(`RESULT: FAIL — ${why}.`);
  }
  console.log(out.join('\n'));
}

function reportJson(report) {
  const { summary, git, baseline, findings, checks, extra } = report;
  return {
    schemaVersion: 1,
    tool: SELF,
    generatedAt: new Date().toISOString(),
    root: ROOT,
    git: {
      branch: git.branch,
      commit: git.commit,
      shortCommit: git.shortCommit,
      tags: git.tags,
      status: git.status,
      cleanDryRun: git.cleanDryRun,
      expectedChanges: extra.expectedChanges,
    },
    baseline: {
      path: path.relative(ROOT, baseline.path) || baseline.path,
      present: baseline.present,
      entries: baseline.entries.size,
      generatedAt: baseline.json ? baseline.json.generatedAt || null : null,
      error: baseline.error,
      stale: baseline.staleIds || [],
    },
    summary,
    checks,
    findings,
    limitations: [
      'TODO 检查只覆盖 src/tools/scripts/tests 的代码文件，不覆盖 docs/worklog。',
      '重复常量按行上下文匹配；0.03 只在 lambda/λ/radar.fx 行统计，128/17 只在尺寸/网格上下文统计。',
      '生成物只校验头标记，未重新运行 generator 验证内容 hash 与重生成一致。',
      '测试 skip 为静态标记计数；运行时 skip 以 scripts/test_all.cjs 的报告为准。',
      '本地 Markdown 链接只校验路径存在，不校验 #anchor。',
      '游戏 API 扫描覆盖 src/tools/scripts，不含 tests（测试桩）与 docs（说明文字）。',
      'Lua dofile/loadfile 与 Python 动态 sys.path 导入不做全量路径解析；只检查 JS 相对 require 和生产工具对 tests/ 的依赖。',
      'git 工作区检查允许 Gate 0 计划内新增/修改；提交后对已跟踪文件的再次修改会重新变成 error。',
    ],
  };
}

function buildChecks(findings, details = {}) {
  return CHECK_DEFS.map((def) => {
    const list = findings.filter((f) => f.check === def.id);
    const newList = list.filter((f) => f.status === 'new');
    const knownList = list.filter((f) => f.status === 'known');
    return {
      id: def.id,
      label: def.label,
      newFindings: newList.length,
      knownFindings: knownList.length,
      newErrorFindings: newList.filter((f) => f.severity === 'error').length,
      newOccurrences: newList.reduce((n, f) => n + f.count, 0),
      knownOccurrences: knownList.reduce((n, f) => n + f.count, 0),
      details: details[def.id] || null,
    };
  });
}

function printHelp() {
  console.log(`用法: node scripts/audit_repo.cjs [options]

选项:
  --json               输出机器可读 JSON（stdout 只有 JSON）
  --verbose, -v        人类可读输出中列出被基线抑制的已知项
  --strict             新增 warning 也导致退出码非 0
  --update-baseline    把当前全部发现写入 tests/baseline/audit-baseline.json
  --baseline <path>    指定基线文件（默认 tests/baseline/audit-baseline.json）
  --check-message-file <path>  独立扫描文本文件的敏感措辞（可重复；CI 扫 PR 文本用）
  --help, -h           显示本帮助

退出码:
  0  没有基线之外的新 error（--strict 时也没有新 warning）
  1  存在新 error（或 --strict 下新 warning）
  2  参数/环境/基线解析错误

检查范围见 docs/refactor-plan.md §7.3。基线只用于记录 Gate 0 已知问题，
后续 Gate 应删除对应条目，而不是修改业务代码来“变绿”。`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`audit_repo: ${e.message}`);
    return 2;
  }
  if (opts.help) {
    printHelp();
    return 0;
  }

  // 独立文本扫描模式（CI 扫 PR 标题/正文用）：不走 git，命中即退出码 1。
  if (opts.checkMessageFiles) {
    const store = createFindingStore();
    for (const file of opts.checkMessageFiles) {
      if (!fs.existsSync(file)) {
        console.error(`audit_repo: --check-message-file 文件不存在: ${file}`);
        return 2;
      }
      scanWordingLines(store, `message:${path.basename(file)}`,
        fs.readFileSync(file, 'utf8').split(/\r?\n/));
    }
    const findings = store.all();
    for (const f of findings) {
      console.log(`[${f.severity}] ${f.rule} ${lineRef(f)} — ${f.message}`);
    }
    if (findings.length) {
      console.log(`audit_repo: ${findings.length} 处措辞命中（内容纪律见 CONTRIBUTING.md）`);
      return 1;
    }
    console.log('audit_repo: 文本措辞检查通过');
    return 0;
  }

  let git;
  try {
    git = collectGitContext();
  } catch (e) {
    console.error(`audit_repo: ${e.message}`);
    return 2;
  }

  const workingFiles = buildWorkingFiles(git);
  const store = createFindingStore();
  const extra = {};

  try {
    extra.git = checkGit(git, workingFiles, store);
    extra.filenames = checkSuspiciousFilenames(workingFiles, store);
    extra.todos = checkTodos(workingFiles, store);
    extra.gameApi = checkGameApi(workingFiles, store);
    extra.constants = checkConstants(workingFiles, store);
    extra.legacy = checkLegacy(workingFiles, store);
    extra.docs = checkDocs(workingFiles, store);
    extra.generated = checkGenerated(workingFiles, store);
    extra.skips = checkTestSkips(workingFiles, store);
    extra.artifacts = checkTrackedArtifacts(git, store);
    extra.wording = checkWording(git, workingFiles, store);
  } catch (e) {
    console.error(`audit_repo: 检查执行失败: ${e.stack || e.message}`);
    return 2;
  }

  const findings = store.all();
  const expectedChanges = extra.git.expectedChanges.map((e) => ({
    code: e.code,
    path: e.path,
    from: e.from || null,
  }));
  const checkDetails = {
    git: {
      expectedChanges: expectedChanges.length,
      unowned: git.status.filter((e) => !isGate0GitChange(e)).length,
      cleanDryRun: git.cleanDryRun.length,
    },
    filenames: extra.filenames,
    todos: extra.todos,
    'game-api': extra.gameApi,
    constants: extra.constants,
    legacy: extra.legacy,
    docs: extra.docs,
    generated: extra.generated,
    skips: {
      files: extra.skips.skipSites.length,
      sites: extra.skips.skipSites.reduce((n, s) => n + s.count, 0),
    },
    artifacts: extra.artifacts,
    wording: extra.wording,
  };

  if (opts.updateBaseline) {
    let n;
    try {
      n = writeBaseline(opts.baselinePath, findings, git);
    } catch (e) {
      console.error(`audit_repo: 写入基线失败: ${e.message}`);
      return 2;
    }
    const payload = {
      updated: true,
      path: path.relative(ROOT, opts.baselinePath) || opts.baselinePath,
      entries: n,
      errors: findings.filter((f) => f.severity === 'error').length,
      warnings: findings.filter((f) => f.severity === 'warn').length,
      generatedAt: new Date().toISOString(),
    };
    if (opts.json) console.log(JSON.stringify(payload, null, 2));
    else {
      console.log(`audit_repo: wrote ${path.relative(ROOT, opts.baselinePath) || opts.baselinePath} — ${n} entries (${payload.errors} errors, ${payload.warnings} warnings)`);
    }
    return 0;
  }

  const baseline = loadBaseline(opts.baselinePath);
  if (baseline.error) {
    console.error(`audit_repo: 基线 JSON 解析失败: ${baseline.error}`);
    return 2;
  }
  const applied = applyBaseline(findings, baseline);
  const summary = buildSummary(applied.findings, opts, {
    ...baseline,
    stale: applied.stale,
    staleIds: applied.staleIds,
  }, { expectedChanges });
  const report = {
    git,
    baseline: { ...baseline, staleIds: applied.staleIds },
    findings: applied.findings,
    summary,
    checks: buildChecks(applied.findings, checkDetails),
    extra: { expectedChanges },
  };

  if (opts.json) {
    console.log(JSON.stringify(reportJson(report), null, 2));
  } else {
    printHuman(report, opts);
  }
  return summary.pass ? 0 : 1;
}

process.exitCode = main();

'use strict';
// Gate 0 baseline capture. Writes only JSON summaries and SHA-256 values into
// tests/baseline/; recordings, images and matrices are never copied.
//
//   node scripts/capture_baseline.cjs [--out <dir>]
//
// Every artifact is generated from this run. Re-run it after an intentional
// change and review the diff instead of editing the JSON by hand.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { spawnSync } = require('node:child_process');
const { detectPython, resolveDcsBin, resolveLua, luaVersion, gitInfo } = require('./test_all.cjs');
const engine = require('../src/sar_core/engine.cjs');
const { demoScene } = require('../tools/sar_demo_scene.cjs');
const { processingOptions } = require('../src/adapters/dcs/sar_adapter.cjs');
const { pointQuality } = require('../scripts/sar_quality_probe.cjs');
const { createService } = require('../tools/sar_live.cjs');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUT = path.join(ROOT, 'tests', 'baseline');
const FLIGHT3 = 'recordings/flight3-final.aesarec';
const FLIGHT9 = 'recordings/flight9.aesarec';
const SAR_DETAIL = 'recordings/sar/sar-1790863917930-4.json';
const SAR_AREA = 'recordings/sar/sar-1790875325239-1.json';
const REPLAY_DT = 0.05;
const REPLAY_SEED = 42;
const FLIGHT9_LIMIT_S = 1800;
const PYTHON_ENV = { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
const MAX_BUFFER = 64 * 1024 * 1024;

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function statFile(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? { size: stat.size } : null;
  } catch { return null; }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function sanitize(value) {
  if (typeof value !== 'string') return value;
  const variants = [ROOT, ROOT.replace(/\\/g, '/'), os.homedir(), os.homedir().replace(/\\/g, '/')];
  let text = value;
  for (const variant of variants) {
    if (variant && variant.length > 2) text = text.split(variant).join(variant === os.homedir() ? '<home>' : '<repo>');
  }
  return text;
}

function tail(text, lines = 30, chars = 6000) {
  const all = String(text || '').trim().split(/\r?\n/);
  return sanitize(all.slice(-lines).join('\n').slice(-chars));
}

function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function base(ctx, command) {
  return {
    schema: 1,
    generated_at: ctx.generatedAt,
    generator: 'scripts/capture_baseline.cjs',
    command,
    commit: ctx.git.commit,
    branch: ctx.git.branch,
    tag: ctx.git.tag,
    worktree_dirty: ctx.git.dirty,
  };
}

function writeJson(outDir, name, ctx, command, data) {
  const target = path.join(outDir, name);
  fs.writeFileSync(target, `${JSON.stringify({ ...base(ctx, command), ...data }, null, 2)}\n`);
}

async function attempt(step, fn) {
  try {
    return await fn();
  } catch (error) {
    return { status: 'error', reason: sanitize(`${step}: ${error.message}`) };
  }
}

function runPythonJson(ctx, script, args, timeout = 600000) {
  if (!ctx.python) throw Error('未找到 Python（可设置 AESA_PYTHON）');
  const result = spawnSync(ctx.python.command, [...ctx.python.prefix, '-', ...args], {
    cwd: ROOT,
    input: script,
    encoding: 'utf8',
    timeout,
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
    env: { ...process.env, ...PYTHON_ENV },
  });
  if (result.error) {
    throw Error(result.error.code === 'ETIMEDOUT'
      ? `Python 超时（${Math.round(timeout / 1000)}s）`
      : `无法启动 Python: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw Error(`Python 退出码 ${result.status}: ${tail(result.stderr || result.stdout, 20, 4000)}`);
  }
  const output = (result.stdout || '').trim();
  if (!output) throw Error('Python 没有输出 JSON');
  try {
    return JSON.parse(output);
  } catch (error) {
    throw Error(`Python 输出不是 JSON: ${error.message}; ${tail(output, 8, 2000)}`);
  }
}

// Select the longest recording session exactly as tools/replay.py does, but
// without loading the whole file into memory.
async function scanRecording(file) {
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let totalLines = 0;
  let blankLines = 0;
  const lineTypes = {};
  const sessions = [];
  let current = null;
  for await (const raw of lines) {
    totalLines++;
    const line = raw.trim();
    if (!line) { blankLines++; continue; }
    const space = line.indexOf(' ');
    const kind = space < 0 ? line : line.slice(0, space);
    lineTypes[kind] = (lineTypes[kind] || 0) + 1;
    if (kind === 'V1') {
      if (current) sessions.push(current);
      current = { frames: 0, lines: 0, first_t: null, last_t: null };
    }
    if (!current) current = { frames: 0, lines: 0, first_t: null, last_t: null };
    current.lines++;
    if (kind === 'A') {
      const parts = line.split(/\s+/);
      const time = Number(parts[1]);
      if (Number.isFinite(time)) {
        if (current.first_t === null) current.first_t = time;
        current.last_t = time;
        current.frames++;
      }
    }
  }
  lines.close();
  if (current) sessions.push(current);
  const sessionOut = session => ({
    frames: session.frames,
    lines: session.lines,
    first_t: session.first_t,
    last_t: session.last_t,
    span_s: session.first_t === null ? 0 : round(session.last_t - session.first_t),
  });
  const scanned = sessions.map(sessionOut);
  const withFrames = scanned.filter(session => session.frames > 0);
  const selected = withFrames.length
    ? withFrames.reduce((best, session) => session.span_s > best.span_s ? session : best)
    : null;
  return {
    total_lines: totalLines,
    blank_lines: blankLines,
    line_types: lineTypes,
    session_count: scanned.length,
    sessions: scanned,
    selected_session: selected,
    max_session_span_s: selected ? selected.span_s : 0,
  };
}

const REPLAY_SCRIPT = `
import json, math, os, sys, time
root = os.getcwd()
sys.path.insert(0, os.path.join(root, "tools"))
sys.path.insert(0, os.path.join(root, "tests"))
import replay
from receiver import load_sessions
path = sys.argv[1]
dt = float(sys.argv[2])
seed = int(sys.argv[3])
started = time.perf_counter()
result = replay.run(path, dt=dt, seed=seed, quiet=True)
wall_ms = round((time.perf_counter() - started) * 1000.0, 1)
if result is None:
    raise SystemExit("replay returned no result")
frames = result["frames"]
all_sessions = load_sessions(path)
sessions = [session for session in all_sessions if len(session[0]) >= 2]
selected = max(sessions, key=lambda session: session[0][-1]["t"] - session[0][0]["t"]) if sessions else None
duration = frames[-1]["t"] - frames[0]["t"]
steps = max(1, int(math.ceil(duration / dt)))
tracks = []
for track in result["tracks"]:
    vr = track["vr"]
    tracks.append({
        "id": str(track["id"]),
        "az_deg": round(math.degrees(float(track["az"])), 6),
        "el_deg": round(math.degrees(float(track["el"])), 6),
        "R_km": round(float(track["R"]) / 1000.0, 6),
        "vr_mps": None if vr is None else round(float(vr), 6),
        "confirmed": bool(track["confirmed"]),
        "hits": int(track["hits"]),
    })
ours = {str(key): int(value) for key, value in result["ours"].items()}
engine = {str(key): int(value) for key, value in result["eng"].items()}
out = {
    "frames": len(frames),
    "duration_s": round(duration, 6),
    "steps": steps,
    "step_s": round(duration / steps, 9),
    "dwells": result["dwells"],
    "engine_contacts": len(result["engine"]),
    "tracks_total": len(tracks),
    "tracks_confirmed": sum(1 for track in tracks if track["confirmed"]),
    "tracks": tracks,
    "detections_by_target": ours,
    "engine_contacts_by_target": engine,
    "session_count": len(sessions),
    "selected_session": None if selected is None else {
        "frames": len(selected[0]),
        "duration_s": round(selected[0][-1]["t"] - selected[0][0]["t"], 6),
        "probe": selected[2],
    },
    "wall_ms": wall_ms,
}
print(json.dumps(out, ensure_ascii=True, sort_keys=True))
`;

const PROTOCOL_SCRIPT = `
import collections, json, sys
sys.path.insert(0, "tools")
from receiver import parse_line
path = sys.argv[1]
line_types = collections.Counter()
parsed_types = collections.Counter()
field_counts = collections.defaultdict(collections.Counter)
bad_samples = []
probes = []
sessions = []
current = None
total = 0
blank = 0
bad = 0
with open(path, "r", encoding="utf-8", errors="replace") as handle:
    for lineno, raw in enumerate(handle, 1):
        total += 1
        line = raw.strip()
        if not line:
            blank += 1
            continue
        kind = line.split(" ", 1)[0]
        line_types[kind] += 1
        if kind == "V1" or line.startswith("V1 "):
            if current is not None:
                sessions.append(current)
            current = {"frames": 0, "lines": 0, "first_t": None, "last_t": None}
        if current is None:
            current = {"frames": 0, "lines": 0, "first_t": None, "last_t": None}
        current["lines"] += 1
        if kind == "A":
            parts = line.split()
            if len(parts) > 1:
                try:
                    value = float(parts[1])
                    if current["first_t"] is None:
                        current["first_t"] = value
                    current["last_t"] = value
                    current["frames"] += 1
                except ValueError:
                    pass
        parsed = parse_line(line)
        if parsed is None:
            bad += 1
            if len(bad_samples) < 10:
                bad_samples.append({"line": lineno, "text": line[:160]})
            continue
        parsed_kind, fields = parsed
        parsed_types[parsed_kind] += 1
        field_counts[parsed_kind][str(len(line.split()))] += 1
        if parsed_kind == "P":
            text = fields.get("text")
            if text and text not in probes:
                probes.append(text)
if current is not None:
    sessions.append(current)
def session_out(session):
    span = 0.0 if session["first_t"] is None else session["last_t"] - session["first_t"]
    return {"frames": session["frames"], "lines": session["lines"],
            "first_t": session["first_t"], "last_t": session["last_t"],
            "span_s": round(span, 6)}
sessions_out = [session_out(session) for session in sessions]
selected = max(sessions, key=lambda session: (session["last_t"] - session["first_t"])
               if session["first_t"] is not None else 0) if sessions else None
out = {
    "total_lines": total,
    "blank_lines": blank,
    "parseable_lines": sum(parsed_types.values()),
    "line_types": dict(line_types),
    "parsed_types": dict(parsed_types),
    "field_counts": {kind: dict(counts) for kind, counts in field_counts.items()},
    "bad_lines": {"count": bad, "samples": bad_samples},
    "probes": probes,
    "session_count": len(sessions_out),
    "sessions": sessions_out,
    "selected_session": None if selected is None else session_out(selected),
}
print(json.dumps(out, ensure_ascii=True, sort_keys=True))
`;

async function captureReplay(ctx, inputRel, { limitSeconds = null, label }) {
  const file = path.join(ROOT, inputRel);
  const stat = statFile(file);
  if (!stat) {
    return {
      status: 'skipped',
      reason: `录制文件不存在: ${inputRel}`,
      input: inputRel,
      input_bytes: null,
      input_sha256: null,
    };
  }
  const inputSha256 = await sha256File(file);
  const scan = await scanRecording(file);
  const common = {
    input: inputRel,
    input_bytes: stat.size,
    input_sha256: inputSha256,
    recording: scan,
  };
  if (limitSeconds !== null && scan.max_session_span_s > limitSeconds) {
    return {
      status: 'skipped',
      reason: `最大会话 ${scan.max_session_span_s.toFixed(2)} s 超过 ${limitSeconds} s 上限，未执行回放`,
      limit_s: limitSeconds,
      ...common,
    };
  }
  const replay = runPythonJson(ctx, REPLAY_SCRIPT, [inputRel, String(REPLAY_DT), String(REPLAY_SEED)], 900000);
  return {
    status: 'ok',
    ...common,
    replay: {
      ...replay,
      entry: 'tools/replay.py run()',
      dt: REPLAY_DT,
      seed: REPLAY_SEED,
      command: `python tools/replay.py ${inputRel} --dt ${REPLAY_DT} --seed ${REPLAY_SEED}`,
      label: label || null,
    },
  };
}

async function captureProtocol(ctx, inputRel) {
  const file = path.join(ROOT, inputRel);
  const stat = statFile(file);
  if (!stat) {
    return { status: 'error', reason: `输入文件不存在: ${inputRel}`, input: inputRel };
  }
  const inputSha256 = await sha256File(file);
  const protocol = runPythonJson(ctx, PROTOCOL_SCRIPT, [inputRel], 300000);
  return {
    status: 'ok',
    input: inputRel,
    input_bytes: stat.size,
    input_sha256: inputSha256,
    parser: 'tools/receiver.parse_line()',
    bad_line_definition: 'parse_line() 返回 None',
    ...protocol,
  };
}

function dbStats(db) {
  const finite = [];
  for (const value of db) if (Number.isFinite(value)) finite.push(value);
  finite.sort((a, b) => a - b);
  const quantile = q => finite.length ? finite[Math.min(finite.length - 1, Math.floor(q * (finite.length - 1)))] : null;
  const sum = finite.reduce((total, value) => total + value, 0);
  return {
    pixels: db.length,
    finite_pixels: finite.length,
    min_db: finite.length ? round(finite[0]) : null,
    max_db: finite.length ? round(finite[finite.length - 1]) : null,
    range_db: finite.length ? round(finite[finite.length - 1] - finite[0]) : null,
    mean_db: finite.length ? round(sum / finite.length) : null,
    p01_db: round(quantile(0.01)),
    p50_db: round(quantile(0.5)),
    p99_db: round(quantile(0.99)),
  };
}

function pickMetadata(metadata) {
  if (!metadata) return null;
  const keys = [
    'engine', 'focuser', 'quality', 'scene_model', 'window', 'range_interpolation',
    'lambda_m', 'bandwidth_hz', 'scatter_spacing_m', 'scatter_seed', 'scatterers',
    'poses', 'duration_s', 'simulated_pulses', 'terrain_spacing_m', 'image_step_m',
    'shadow', 'shadowed_scatterers', 'shadowed_terrain', 'shadowed_objects',
    'model',
  ];
  const out = {};
  for (const key of keys) if (metadata[key] !== undefined) out[key] = metadata[key];
  return out;
}

async function captureSar(ctx, { inputRel, footprint, label }) {
  const file = path.join(ROOT, inputRel);
  const stat = statFile(file);
  if (!stat) {
    return { status: 'skipped', reason: `输入场景不存在: ${inputRel}`, input: inputRel, footprint };
  }
  const inputSha256 = await sha256File(file);
  try {
    const scene = JSON.parse(fs.readFileSync(file, 'utf8'));
    const params = { ...(scene.processing || {}), footprint };
    const options = processingOptions(params);
    const imageStarted = performance.now();
    const image = engine.reconstruct(scene, options);
    const imageWallMs = Math.round(performance.now() - imageStarted);
    const db = dbStats(image.db);
    const pointStarted = performance.now();
    const point = pointQuality(options);
    const pointWallMs = Math.round(performance.now() - pointStarted);
    return {
      status: 'ok',
      label,
      footprint,
      input: inputRel,
      input_bytes: stat.size,
      input_sha256: inputSha256,
      scene: {
        source: scene.source,
        size_m: scene.size,
        grid_n: scene.n,
        terrain_points: scene.terrain.length,
        trajectory_poses: scene.trajectory.length,
        duration_s: round(scene.trajectory.at(-1).t - scene.trajectory[0].t),
        bearing_deg: round(scene.bearing * 180 / Math.PI),
        declared_footprint: scene.footprint || null,
        target: scene.target || null,
      },
      processing: options,
      image: {
        width: image.width,
        size_m: image.size_m,
        pixels: image.width * image.width,
        dB: db,
        width_matches_options: image.width === options.width,
        bandwidth_matches_options: image.metadata?.bandwidth_hz === options.bandwidth,
        compute_ms: round(image.metadata?.compute_ms),
        wall_ms: imageWallMs,
      },
      metadata: pickMetadata(image.metadata),
      point_response: {
        entry: 'scripts/sar_quality_probe.cjs pointQuality()',
        window: point.window,
        profiles: {
          cross: point.profiles.cross,
          ground: point.profiles.ground,
        },
        analytic_rect: point.analytic_rect,
        limits: point.limits,
        basis: '独立理想平地 + 单点散射；1D 截面 ±12 m、步长 0.01 m；不是本次真实地形的分辨率',
        wall_ms: pointWallMs,
      },
      wall_ms: imageWallMs + pointWallMs,
    };
  } catch (error) {
    return {
      status: 'error',
      input: inputRel,
      input_bytes: stat.size,
      input_sha256: inputSha256,
      reason: sanitize(error.message),
    };
  }
}

function mosaicEntry(entry) {
  const out = {};
  for (const key of [
    'seq', 'source', 'width', 'size_m', 'bearing', 'center', 'footprint', 'target',
    'quality', 'focuser', 'scene_model', 'image_step_m', 'mode', 'sector', 'dbs', 'compute_ms',
  ]) if (entry[key] !== undefined) out[key] = entry[key];
  return out;
}

async function captureState(ctx) {
  const started = performance.now();
  let service = null;
  try {
    const scene = demoScene();
    service = createService({ tcpPort: 0, httpPort: 0, mode: 'demo', scene });
    const ports = await service.started;
    const deadline = Date.now() + 120000;
    while (!service.state.result) {
      if (Date.now() > deadline) throw Error('demo 图像在 120 s 内未完成');
      await sleep(20);
    }
    const response = await fetch(`http://127.0.0.1:${ports.httpPort}/state`);
    if (!response.ok) throw Error(`GET /state 返回 ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    const state = JSON.parse(body.toString('utf8'));
    // D3 (docs/conventions.md §8.5): the poll carries summaries and a resultSeq; the matrix, the raw
    // input and the full snapshot are separate fetches. Their sizes are recorded here so the split
    // can be re-measured, and so a future /state regression (a matrix creeping back into the poll)
    // shows up as a byte count rather than only as a UI slowness.
    const fetchBytes = async (path) => {
      const res = await fetch(`http://127.0.0.1:${ports.httpPort}${path}`);
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer()).length;
    };
    const result = state.result || null;
    const resultSeq = state.resultSeq ?? null;
    const reference = state.reference || null;
    const mosaic = state.mosaic || {};
    const entries = Array.isArray(mosaic.entries) ? mosaic.entries.map(mosaicEntry) : [];
    // What the poll would cost with the result and reference descriptors removed: the gap between it
    // and state_bytes is what the summaries themselves add, so the 4 KB line is judged on real content.
    const withoutResultReference = Buffer.byteLength(JSON.stringify({ ...state, result: null, reference: null }));
    return {
      status: 'ok',
      mode: 'demo',
      scene: 'tools/sar_demo_scene.cjs demoScene()',
      service_entry: 'tools/sar_live.cjs createService({mode:"demo"})',
      command: 'node scripts/capture_baseline.cjs (state-size step)',
      wall_ms: Math.round(performance.now() - started),
      state_bytes: body.length,
      state_keys: Object.keys(state),
      result_keys: result ? Object.keys(result) : null,
      reference_keys: reference ? Object.keys(reference) : null,
      result_json_bytes: result ? Buffer.byteLength(JSON.stringify(result)) : null,
      reference_json_bytes: reference ? Buffer.byteLength(JSON.stringify(reference)) : null,
      // A matrix in the poll would show up here; after D3 these are null on a compliant service.
      result_db_json_bytes: result?.db ? Buffer.byteLength(JSON.stringify(result.db)) : null,
      result_power_json_bytes: result?.power ? Buffer.byteLength(JSON.stringify(result.power)) : null,
      reference_heights_json_bytes: reference?.heights ? Buffer.byteLength(JSON.stringify(reference.heights)) : null,
      state_without_result_reference_bytes: withoutResultReference,
      endpoints: {
        image_bytes: resultSeq === null ? null : await fetchBytes(`/image/${resultSeq}`),
        reference_bytes: await fetchBytes('/reference'),
        snapshot_bytes: await fetchBytes('/snapshot'),
      },
      image: result ? {
        width: result.width,
        size_m: result.size_m,
        db_len: Array.isArray(result.db) ? result.db.length : null,
        power_len: Array.isArray(result.power) ? result.power.length : null,
        quality: result.metadata?.quality ?? null,
        window: result.metadata?.window ?? null,
        bandwidth_hz: result.metadata?.bandwidth_hz ?? null,
        scatter_spacing_m: result.metadata?.scatter_spacing_m ?? null,
        compute_ms: round(result.metadata?.compute_ms),
      } : null,
      reference: reference ? {
        n: reference.n,
        size: reference.size,
        heights_len: Array.isArray(reference.heights) ? reference.heights.length : null,
        surfaces_len: Array.isArray(reference.surfaces) ? reference.surfaces.length : null,
        objects_len: Array.isArray(reference.objects) ? reference.objects.length : null,
      } : null,
      mosaic: {
        limit: mosaic.limit,
        count: mosaic.count,
        dropped: mosaic.dropped,
        firstSeq: mosaic.firstSeq,
        latestSeq: mosaic.latestSeq,
        dB_step: mosaic.dB_step,
        entry_count: entries.length,
        entries,
      },
      note: 'D3 已落地：/state 只带摘要与 resultSeq，矩阵走 /image/<seq>、输入走 /reference、全量走 /snapshot；4 KB 目标按 demo 单条与增量轮询计，满 mosaic 的全量摘要更大但不含矩阵。',
    };
  } catch (error) {
    return { status: 'error', reason: sanitize(error.message) };
  } finally {
    if (service) {
      try { await service.close(); } catch { /* best effort */ }
    }
  }
}

function detectLupa(ctx) {
  if (!ctx.python) return null;
  const result = spawnSync(ctx.python.command, [
    ...ctx.python.prefix, '-c',
    'import lupa; print(getattr(lupa, "__version__", "unknown"))',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
    env: { ...process.env, ...PYTHON_ENV },
  });
  return !result.error && result.status === 0 ? (result.stdout || '').trim() : null;
}

function statusLabel(status) {
  return { ok: 'OK', skipped: 'SKIPPED', error: 'ERROR' }[status] || String(status).toUpperCase();
}

function bytesText(value) {
  return value === null || value === undefined ? '—' : `${value} bytes`;
}

function msText(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
}

function numberText(value, digits = 3) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : '—';
}

function trackTable(tracks) {
  const lines = [
    '| 航迹 | az° | el° | R km | vr m/s | 确认 | hits |',
    '| ---: | ---: | ---: | ---: | ---: | --- | ---: |',
  ];
  for (const track of tracks) {
    lines.push(`| ${track.id} | ${numberText(track.az_deg, 2)} | ${numberText(track.el_deg, 2)} `
      + `| ${numberText(track.R_km, 3)} | ${numberText(track.vr_mps, 1)} `
      + `| ${track.confirmed ? '是' : '否'} | ${track.hits} |`);
  }
  return lines;
}

function pointTable(point) {
  const lines = [
    '| 方向 | FWHM m | PSLR dB | ISLR dB | 峰值偏移 m | 第一零点 m |',
    '| --- | ---: | ---: | ---: | ---: | --- |',
  ];
  for (const axis of ['cross', 'ground']) {
    const profile = point.profiles[axis];
    lines.push(`| ${axis === 'cross' ? '横向' : '地距'} | ${numberText(profile.fwhm_m, 4)} `
      + `| ${numberText(profile.pslr_db, 2)} | ${numberText(profile.islr_1d_db, 2)} `
      + `| ${numberText(profile.peak_offset_m, 4)} `
      + `| ${profile.first_nulls_m.map(value => numberText(value, 2)).join(' … ')} |`);
  }
  return lines;
}

function renderReadme(ctx, results) {
  const { replay3, replay9, sarDetail, sarArea, protocol, state } = results;
  const lines = [];
  lines.push('# aesa Gate 0 基线');
  lines.push('');
  lines.push(`- 生成时间：\`${ctx.generatedAt}\``);
  lines.push(`- commit：\`${ctx.git.commit || 'unknown'}\``);
  lines.push(`- 分支：\`${ctx.git.branch || 'unknown'}\``);
  lines.push(`- tag：\`${ctx.git.tag || '无 exact tag'}\``);
  lines.push(`- 工作区：\`${ctx.git.dirty === null ? 'unknown' : ctx.git.dirty ? 'dirty' : 'clean'}\``);
  lines.push('- 生成命令：`node scripts/capture_baseline.cjs`');
  lines.push('- 测试入口：`node scripts/test_all.cjs`');
  lines.push('');
  lines.push('## 环境');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('| --- | --- |');
  lines.push(`| 操作系统 | ${os.type()} ${os.release()} (${process.platform}/${process.arch}) |`);
  lines.push(`| Node | ${process.version} |`);
  lines.push(`| Python | ${ctx.python ? ctx.python.version : '未找到'} |`);
  lines.push(`| lupa | ${ctx.lupaVersion || '未知'} |`);
  lines.push(`| Lua 5.1 | ${ctx.lua.path ? `可用（DCS luae.exe，${ctx.luaVersionText || '版本未知'}）` : '不可用'} |`);
  lines.push(`| DCS bin | ${ctx.dcsBin.path ? '可用' : '不可用'} |`);
  lines.push(`| 回放参数 | \`--dt ${REPLAY_DT} --seed ${REPLAY_SEED}\` |`);
  lines.push('| SAR 散射种子 | `20261001`（`src/sar_core/settings.cjs` 默认值） |');
  lines.push('');
  lines.push('## 文件与状态');
  lines.push('');
  lines.push('| 文件 | 状态 | 摘要 |');
  lines.push('| --- | --- | --- |');
  const summary = (entry, okText) => {
    if (entry.status === 'ok') return typeof okText === 'function' ? okText() : okText;
    if (entry.status === 'skipped') return entry.reason;
    return `错误：${entry.reason}`;
  };
  lines.push(`| \`replay-flight3.json\` | ${statusLabel(replay3.status)} | ${summary(replay3, () =>
    replay3.replay
      ? `${replay3.replay.frames} 帧 / ${replay3.replay.duration_s} s，${replay3.replay.tracks_confirmed}/${replay3.replay.tracks_total} 确认航迹，${replay3.replay.steps} 步`
      : '—')} |`);
  lines.push(`| \`replay-flight9.json\` | ${statusLabel(replay9.status)} | ${summary(replay9, () =>
    replay9.replay
      ? `${replay9.replay.frames} 帧 / ${replay9.replay.duration_s} s，${replay9.replay.tracks_confirmed}/${replay9.replay.tracks_total} 确认航迹`
      : '—')} |`);
  lines.push(`| \`sar-detail.json\` | ${statusLabel(sarDetail.status)} | ${summary(sarDetail, () =>
    sarDetail.image
      ? `${sarDetail.image.size_m} m / ${sarDetail.image.width} px，dB [${numberText(sarDetail.image.dB.min_db, 1)}, ${numberText(sarDetail.image.dB.max_db, 1)}]，compute ${msText(sarDetail.image.compute_ms)}`
      : '—')} |`);
  lines.push(`| \`sar-area.json\` | ${statusLabel(sarArea.status)} | ${summary(sarArea, () =>
    sarArea.image
      ? `${sarArea.image.size_m} m / ${sarArea.image.width} px，dB [${numberText(sarArea.image.dB.min_db, 1)}, ${numberText(sarArea.image.dB.max_db, 1)}]，compute ${msText(sarArea.image.compute_ms)}`
      : '—')} |`);
  lines.push(`| \`export-protocol.json\` | ${statusLabel(protocol.status)} | ${summary(protocol, () =>
    `${protocol.total_lines} 行，${protocol.bad_lines.count} 坏行，${protocol.session_count} 个会话`)} |`);
  lines.push(`| \`state-size.json\` | ${statusLabel(state.status)} | ${summary(state, () =>
    `GET /state ${bytesText(state.state_bytes)}，mosaic ${state.mosaic.count} 帧（latestSeq ${state.mosaic.latestSeq}）`)} |`);
  lines.push('');
  lines.push('> 本目录可能同时包含其他 Gate 0 任务生成的 `audit-baseline.json`；本脚本不读取或修改它。');
  lines.push('');

  lines.push('## `replay-flight3.json`');
  lines.push('');
  lines.push(`- 状态：**${statusLabel(replay3.status)}**`);
  lines.push(`- 输入：\`${FLIGHT3}\`${replay3.input_sha256 ? `（SHA-256 \`${replay3.input_sha256}\`，${bytesText(replay3.input_bytes)}）` : ''}`);
  lines.push('- 口径：`tools/replay.py` 选择 A 帧时间跨度最大的会话，按 `dt=0.05`、`seed=42` 逐步进核心；帧数/时长来自 A 行，航迹来自核心最终 `trk.tracks`，检测计数来自驻留审计。');
  if (replay3.status === 'ok' && replay3.replay) {
    const replay = replay3.replay;
    lines.push(`- 录制扫描：${replay3.recording.session_count} 个会话，${replay3.recording.total_lines} 行，最大会话 ${replay3.recording.max_session_span_s} s。`);
    lines.push(`- 回放：${replay.frames} 帧，${replay.duration_s} s，${replay.steps} 步（步长 ${replay.step_s} s），${replay.dwells} 个驻留，${replay.engine_contacts} 条引擎接触，${replay.tracks_confirmed}/${replay.tracks_total} 条确认航迹。`);
    lines.push(`- 回放耗时：${msText(replay.wall_ms)}（Lua 加载、真值构建、核心步进和结果汇总的总和）。`);
    lines.push(`- 命令：\`${replay.command}\``);
    lines.push('');
    lines.push('### 航迹');
    lines.push('');
    lines.push(...trackTable(replay.tracks));
    lines.push('');
    lines.push('### 检测次数按真值目标');
    lines.push('');
    lines.push('| 目标 id | 我方检测次数 | 引擎接触 |');
    lines.push('| --- | ---: | ---: |');
    const ids = [...new Set([...Object.keys(replay.detections_by_target), ...Object.keys(replay.engine_contacts_by_target)])].sort();
    for (const id of ids) {
      lines.push(`| ${id} | ${replay.detections_by_target[id] ?? 0} | ${replay.engine_contacts_by_target[id] ?? 0} |`);
    }
  } else {
    lines.push(`- 结果：${replay3.reason}`);
  }
  lines.push('');

  lines.push('## `replay-flight9.json`');
  lines.push('');
  lines.push(`- 状态：**${statusLabel(replay9.status)}**`);
  lines.push(`- 输入：\`${FLIGHT9}\`${replay9.input_sha256 ? `（SHA-256 \`${replay9.input_sha256}\`，${bytesText(replay9.input_bytes)}）` : ''}`);
  lines.push('- 口径：与 flight3 相同的回放入口；最长会话超过 30 分钟（1800 s）或文件不可用时只记录扫描元数据和跳过原因，不执行回放。');
  if (replay9.recording) {
    const recording = replay9.recording;
    const totalFrames = recording.sessions.reduce((sum, session) => sum + session.frames, 0);
    lines.push(`- 录制扫描：${recording.session_count} 个会话，${recording.total_lines} 行，${totalFrames} 个 A 帧，最大会话 ${recording.max_session_span_s} s。`);
  }
  if (replay9.status === 'ok' && replay9.replay) {
    lines.push(`- 回放：${replay9.replay.frames} 帧，${replay9.replay.duration_s} s，${replay9.replay.tracks_confirmed}/${replay9.replay.tracks_total} 条确认航迹，耗时 ${msText(replay9.replay.wall_ms)}。`);
  } else {
    lines.push(`- 跳过原因：${replay9.reason}`);
  }
  lines.push('');

  for (const [name, entry, title] of [
    ['sar-detail.json', sarDetail, '`sar-detail.json`（detail footprint）'],
    ['sar-area.json', sarArea, '`sar-area.json`（area footprint）'],
  ]) {
    lines.push(`## ${title}`);
    lines.push('');
    lines.push(`- 状态：**${statusLabel(entry.status)}**`);
    lines.push(`- 输入：\`${entry.input || '（未记录）'}\`${entry.input_sha256 ? `（SHA-256 \`${entry.input_sha256}\`，${bytesText(entry.input_bytes)}）` : ''}`);
    if (entry.status === 'ok') {
      lines.push('- 口径：`src/sar_core/engine.cjs reconstruct()` 生成图像；`scripts/sar_quality_probe.cjs pointQuality()` 在独立理想平地上计算点响应。图像 dB 以本图峰值为 0 dB，显示下限 -40 dB。');
      lines.push(`- 场景：${entry.scene.size_m} m / ${entry.scene.grid_n}×${entry.scene.grid_n} 地形（${entry.scene.terrain_points} 点）/ ${entry.scene.trajectory_poses} 帧轨迹，${entry.scene.duration_s} s；声明 footprint：${entry.scene.declared_footprint || '无（按本次指定 footprint 处理）'}。`);
      if (!entry.scene.declared_footprint) {
        lines.push(`- 选择说明：该场景能完成侧视成像；虽然 JSON 未声明 footprint，本次按 ${entry.footprint} 处理。`);
      }
      lines.push(`- 处理：footprint \`${entry.footprint}\`，actual quality \`${entry.metadata?.quality || 'default'}\`，window \`${entry.processing.window}\`，bandwidth ${entry.processing.bandwidth} Hz，width ${entry.processing.width}，scatterSpacing ${entry.processing.scatterSpacing}，actual sceneModel \`${entry.metadata?.scene_model || 'default'}\`。`);
      lines.push(`- 图像：${entry.image.width}×${entry.image.width}，${entry.image.pixels} 像素；dB min/max/mean = ${numberText(entry.image.dB.min_db, 3)} / ${numberText(entry.image.dB.max_db, 3)} / ${numberText(entry.image.dB.mean_db, 3)}，p01/p50/p99 = ${numberText(entry.image.dB.p01_db, 3)} / ${numberText(entry.image.dB.p50_db, 3)} / ${numberText(entry.image.dB.p99_db, 3)}。`);
      lines.push(`- 耗时：引擎 \`compute_ms\` ${msText(entry.image.compute_ms)}，成像 wall ${msText(entry.image.wall_ms)}，点响应 wall ${msText(entry.point_response.wall_ms)}。`);
      lines.push(`- 一致性：图像宽度与 options 一致 = ${entry.image.width_matches_options}，带宽与 options 一致 = ${entry.image.bandwidth_matches_options}。`);
      lines.push('');
      lines.push('### 点响应');
      lines.push('');
      lines.push(...pointTable(entry.point_response));
      lines.push('');
      lines.push(`点响应口径：${entry.point_response.basis}。解析近似：横向 ${numberText(entry.point_response.analytic_rect.cross_fwhm_m, 4)} m，地距 ${numberText(entry.point_response.analytic_rect.ground_fwhm_m, 4)} m；这些数字不能当作本次真实地形的分辨率或识别能力。`);
    } else {
      lines.push(`- 原因：${entry.reason}`);
    }
    lines.push('');
  }

  lines.push('## `export-protocol.json`');
  lines.push('');
  lines.push(`- 状态：**${statusLabel(protocol.status)}**`);
  lines.push(`- 输入：\`${FLIGHT3}\`${protocol.input_sha256 ? `（SHA-256 \`${protocol.input_sha256}\`，${bytesText(protocol.input_bytes)}）` : ''}`);
  if (protocol.status === 'ok') {
    lines.push('- 口径：逐行调用 `tools/receiver.parse_line()`；返回 `None` 计为坏行；字段数按空白分隔统计。空行单独计数，不算坏行。');
    lines.push(`- 总行数 ${protocol.total_lines}，空行 ${protocol.blank_lines}，可解析 ${protocol.parseable_lines}，坏行 ${protocol.bad_lines.count}，会话 ${protocol.session_count}。`);
    lines.push('');
    lines.push('| 行类型 | 行数 | 可解析数 | 字段数分布 |');
    lines.push('| --- | ---: | ---: | --- |');
    const kinds = [...new Set([...Object.keys(protocol.line_types), ...Object.keys(protocol.parsed_types)])].sort();
    for (const kind of kinds) {
      const fields = protocol.field_counts[kind] || {};
      const fieldText = Object.keys(fields).length
        ? Object.entries(fields).sort((a, b) => Number(a[0]) - Number(b[0])).map(([count, lines]) => `${count} 字段 × ${lines}`).join('，')
        : '—';
      lines.push(`| ${kind} | ${protocol.line_types[kind] ?? 0} | ${protocol.parsed_types[kind] ?? 0} | ${fieldText} |`);
    }
    if (protocol.bad_lines.count) {
      lines.push('');
      lines.push('坏行样例：');
      for (const sample of protocol.bad_lines.samples) {
        lines.push(`- 第 ${sample.line} 行：\`${sample.text}\``);
      }
    }
    if (protocol.probes.length) {
      lines.push('');
      lines.push(`P 行探针字段（${protocol.probes.length} 种，按 parse_line() 输出）：\`${protocol.probes.join('` / `')}\``);
      lines.push('');
      lines.push('注意：当前 `tools/receiver.parse_line()` 对 P 行使用 `line[3:]`，原始 `P Bank:...` 会解析为 `ank:...`（首字段丢失第一个字符）；本次按现有实现记录，修复后应更新此基线。');
    }
  } else {
    lines.push(`- 原因：${protocol.reason}`);
  }
  lines.push('');

  lines.push('## `state-size.json`');
  lines.push('');
  lines.push(`- 状态：**${statusLabel(state.status)}**`);
  if (state.status === 'ok') {
    lines.push('- 口径：`tools/sar_live.cjs createService({mode:\'demo\', scene: demoScene()})` 的无游戏模式；等待首帧完成后 GET `/state`，`state_bytes` 是 HTTP 响应体的原始字节数。');
    lines.push(`- 总字节：${bytesText(state.state_bytes)}；顶层字段 ${state.state_keys.length} 个。`);
    lines.push(`- 分项：result 描述 ${bytesText(state.result_json_bytes)}（不含矩阵），reference 描述 ${bytesText(state.reference_json_bytes)}（不含栅格）。`);
    lines.push(`- 分开取回的载荷：/image/<seq> ${bytesText(state.endpoints.image_bytes)}，/reference ${bytesText(state.endpoints.reference_bytes)}，/snapshot ${bytesText(state.endpoints.snapshot_bytes)}。`);
    lines.push(`- D3 验收：/state ${bytesText(state.state_bytes)}（demo 单条 mosaic）；4 KB 目标按此基线与增量轮询计。满 50 条摘要的全量 /state 约 17 KB、live 含 status/caps/target 约 4.1 KB，均只有摘要；矩阵一旦回流会在这个条目之外暴露。`);
    lines.push(`- 图像摘要：${state.image.width}×${state.image.width}，quality \`${state.image.quality}\`，window \`${state.image.window}\`，scatterSpacing ${state.image.scatter_spacing_m}，compute ${msText(state.image.compute_ms)}。`);
    lines.push(`- mosaic：${state.mosaic.count} 帧，latestSeq ${state.mosaic.latestSeq}，firstSeq ${state.mosaic.firstSeq}，limit ${state.mosaic.limit}，dropped ${state.mosaic.dropped}，dB_step ${state.mosaic.dB_step}。`);
    lines.push(`- 运行耗时：${msText(state.wall_ms)}。`);
    lines.push(`- ${state.note}`);
  } else {
    lines.push(`- 原因：${state.reason}`);
  }
  lines.push('');

  lines.push('## Skip / 错误');
  lines.push('');
  const problems = [
    ['replay-flight9.json', replay9],
    ['sar-detail.json', sarDetail],
    ['sar-area.json', sarArea],
    ['export-protocol.json', protocol],
    ['state-size.json', state],
  ].filter(([, entry]) => entry.status !== 'ok');
  if (!problems.length) {
    lines.push('- 无。');
  } else {
    for (const [name, entry] of problems) {
      lines.push(`- \`${name}\`：**${statusLabel(entry.status)}** — ${entry.reason}`);
    }
  }
  lines.push('');
  lines.push('## 复现与确定性');
  lines.push('');
  lines.push('- 重新生成：`node scripts/capture_baseline.cjs`（默认写入 `tests/baseline/`）。');
  lines.push('- 回放通过 `tools/replay.py` 的 `run()`，`dt=0.05`、`seed=42`；帧数、航迹、检测计数可复现，`wall_ms` 随机器负载变化。');
  lines.push('- SAR 使用 `src/sar_core/settings.cjs` 的固定散射种子 `20261001`；图像统计可复现，`compute_ms`/`wall_ms` 随机器负载变化。');
  lines.push('- `/state` 的字节数包含运行时时间戳/`completed` 等字段，可能随进程或版本略有差异；本文件记录本次实际值。');
  lines.push('- 基线只保存 JSON、摘要和 SHA-256，不复制录制文件、图像或矩阵。');
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  let outDir = DEFAULT_OUT;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--out') {
      if (index + 1 >= args.length) {
        console.error('用法: node scripts/capture_baseline.cjs [--out <dir>]');
        process.exitCode = 2;
        return;
      }
      outDir = path.resolve(process.cwd(), args[++index]);
    } else if (args[index] === '--help' || args[index] === '-h') {
      console.log('用法: node scripts/capture_baseline.cjs [--out <dir>]');
      return;
    } else {
      console.error(`未知参数: ${args[index]}`);
      console.error('用法: node scripts/capture_baseline.cjs [--out <dir>]');
      process.exitCode = 2;
      return;
    }
  }
  fs.mkdirSync(outDir, { recursive: true });

  const ctx = {
    generatedAt: new Date().toISOString(),
    git: gitInfo({ exclude: ['tests/baseline'] }),
    dcsBin: resolveDcsBin(),
    python: detectPython(),
  };
  ctx.lua = resolveLua(ctx.dcsBin);
  ctx.luaVersionText = luaVersion(ctx.lua.path);
  ctx.lupaVersion = detectLupa(ctx);

  console.log('aesa capture_baseline');
  console.log(`commit ${ctx.git.commit ? ctx.git.commit.slice(0, 12) : 'unknown'}`
    + `${ctx.git.branch ? ` (${ctx.git.branch})` : ''}`
    + `${ctx.git.tag ? ` tag ${ctx.git.tag}` : ''}`);
  console.log(`输出目录: ${outDir}`);
  console.log('');

  const results = {};

  console.log('[1/6] replay-flight3 ...');
  results.replay3 = await attempt('replay-flight3', () => captureReplay(ctx, FLIGHT3, { label: 'flight3-final' }));
  writeJson(outDir, 'replay-flight3.json', ctx,
    'node scripts/capture_baseline.cjs (replay-flight3 step)', results.replay3);
  console.log(`      ${statusLabel(results.replay3.status)}`
    + `${results.replay3.replay ? ` ${results.replay3.replay.frames} 帧 / ${results.replay3.replay.duration_s} s` : ` ${results.replay3.reason}`}`);

  console.log('[2/6] replay-flight9 ...');
  results.replay9 = await attempt('replay-flight9', () => captureReplay(ctx, FLIGHT9, { limitSeconds: FLIGHT9_LIMIT_S, label: 'flight9' }));
  writeJson(outDir, 'replay-flight9.json', ctx,
    'node scripts/capture_baseline.cjs (replay-flight9 step)', results.replay9);
  console.log(`      ${statusLabel(results.replay9.status)}`
    + `${results.replay9.replay ? ` ${results.replay9.replay.frames} 帧 / ${results.replay9.replay.duration_s} s` : ` ${results.replay9.reason}`}`);

  console.log('[3/6] sar-detail ...');
  results.sarDetail = await attempt('sar-detail', () => captureSar(ctx, { inputRel: SAR_DETAIL, footprint: 'detail', label: 'detail' }));
  writeJson(outDir, 'sar-detail.json', ctx,
    'node scripts/capture_baseline.cjs (sar-detail step)', results.sarDetail);
  console.log(`      ${statusLabel(results.sarDetail.status)}`
    + `${results.sarDetail.image ? ` ${results.sarDetail.image.width} px / ${results.sarDetail.image.size_m} m / ${msText(results.sarDetail.image.compute_ms)}` : ` ${results.sarDetail.reason}`}`);

  console.log('[4/6] sar-area ...');
  results.sarArea = await attempt('sar-area', () => captureSar(ctx, { inputRel: SAR_AREA, footprint: 'area', label: 'area' }));
  writeJson(outDir, 'sar-area.json', ctx,
    'node scripts/capture_baseline.cjs (sar-area step)', results.sarArea);
  console.log(`      ${statusLabel(results.sarArea.status)}`
    + `${results.sarArea.image ? ` ${results.sarArea.image.width} px / ${results.sarArea.image.size_m} m / ${msText(results.sarArea.image.compute_ms)}` : ` ${results.sarArea.reason}`}`);

  console.log('[5/6] export-protocol ...');
  results.protocol = await attempt('export-protocol', () => captureProtocol(ctx, FLIGHT3));
  writeJson(outDir, 'export-protocol.json', ctx,
    'node scripts/capture_baseline.cjs (export-protocol step)', results.protocol);
  console.log(`      ${statusLabel(results.protocol.status)}`
    + `${results.protocol.status === 'ok' ? ` ${results.protocol.total_lines} 行 / ${results.protocol.bad_lines.count} 坏行` : ` ${results.protocol.reason}`}`);

  console.log('[6/6] state-size ...');
  results.state = await captureState(ctx);
  writeJson(outDir, 'state-size.json', ctx,
    'node scripts/capture_baseline.cjs (state-size step)', results.state);
  console.log(`      ${statusLabel(results.state.status)}`
    + `${results.state.status === 'ok' ? ` ${results.state.state_bytes} bytes / mosaic ${results.state.mosaic.count}` : ` ${results.state.reason}`}`);

  const readme = renderReadme(ctx, results);
  fs.writeFileSync(path.join(outDir, 'README.md'), `${readme}\n`);
  console.log('');
  console.log(`README: ${path.join(outDir, 'README.md')}`);

  const failures = Object.entries(results).filter(([, entry]) => entry.status === 'error');
  const skips = Object.entries(results).filter(([, entry]) => entry.status === 'skipped');
  for (const [name, entry] of failures) console.error(`ERROR ${name}: ${entry.reason}`);
  for (const [name, entry] of skips) console.log(`SKIP  ${name}: ${entry.reason}`);
  console.log(failures.length ? '基线生成失败（存在 ERROR）' : '基线生成完成');
  process.exitCode = failures.length ? 1 : 0;
}

main().catch(error => {
  console.error(sanitize(error.stack || error.message));
  process.exitCode = 1;
});

'use strict';
// Image pool: runs one SAR image on one worker (baseline path) or on a team of workers.
// Both phases of the engine split without changing any arithmetic:
//   echo synthesis  — a pulse starts from zero range bins and reads only the scatterers, so a
//                     pulse block holds exactly the values a serial run writes for those pulses;
//   backprojection  — a pixel accumulates over all pulses inside its own iteration, so a row
//                     block holds exactly the values the serial row loop produces.
// Blocks are concatenated in index order by the caller, so results are bit-identical to serial.
const os = require('node:os'), path = require('node:path');
const {Worker} = require('node:worker_threads');
const engine = require('./engine.cjs');
const {settings} = require('./settings.cjs');
const {pulses} = require('./waveform.cjs');
const {validate} = engine;
// Parallel policy, measured on the reference machine (i7-12700KF: 20 logical = 8 P-cores with
// SMT + 4 E-cores, Node 25):
//   echo synthesis writes ~7e7–1.15e8 range-bin updates/s (2*kernelLobes*rangeStep bins per
//   scatterer-pulse; 3.45e9 updates in 49.5 s for the 512 m standard image, i.e. ~98% of its
//   50.4 s, and 5.1e8 in 4.5 s for the 128 m one) and backprojection ~1.6e7 pixel-pulse
//   updates/s. A team costs ~250 ms of fixed overhead (worker starts, scatterer copies, two
//   phase barriers), so a split only pays off above MIN_PARALLEL_MS of estimated serial work,
//   and no worker is started for less than MIN_CHUNK_MS of that estimate.
// Split scaling on the 512 m standard image: 1→54.8 s, 2→29.9, 4→16.3, 8→9.4, 12→7.1, 19→7.8 s.
// Beyond the physical core count the extra threads only add startup and memory traffic, so the
// pool stops at MAX_POOL_SIZE (12 here) unless a caller passes its own `workers`.
const SYNTH_UPDATES_PER_MS = 9e4, FOCUS_UPDATES_PER_MS = 1.6e4, MIN_PARALLEL_MS = 800, MIN_CHUNK_MS = 250;
const WORKER_FILE = path.join(__dirname, 'worker.cjs'), RESERVED_CORES = 1, MAX_POOL_SIZE = 12;
function poolSize(cores = os.availableParallelism?.() ?? os.cpus().length) { return Math.max(1, Math.min(cores - RESERVED_CORES, MAX_POOL_SIZE)); }
// buildScatterers keeps the cells of the |cross|,|ground| <= size/2 square, i.e. ≈(size/spacing)²
// surface points (16383 measured against 16641 estimated for the 512 m / 4 m patch), plus objects.
function estimateWork(scene, cfg, pulseCount) {
  const scatterers = Math.min(20000, (Math.ceil(scene.size / cfg.scatterSpacing) + 1) ** 2);
  const synthOps = scatterers * pulseCount * 2 * cfg.kernelLobes * cfg.rangeStep, focusOps = cfg.width * cfg.width * pulseCount;
  return {scatterers, pulses: pulseCount, ms: synthOps / SYNTH_UPDATES_PER_MS + focusOps / FOCUS_UPDATES_PER_MS};
}
function blocks(count, parts) {
  const out = [], base = Math.floor(count / parts), extra = count % parts; let lo = 0;
  for (let i = 0; i < parts; i++) { const size = base + (i < extra ? 1 : 0); out.push([lo, lo + size]); lo += size; }
  return out;
}
// One settlement per worker. A worker that dies settles its waiters instead of stalling the
// image, so the service always leaves the "computing" state and can schedule the next capture.
function workerSettled(worker, onMessage, reject) {
  worker.once('message', message => message.error ? reject(Error(message.error)) : onMessage(message));
  worker.once('error', reject);
  worker.once('exit', () => reject(Error('SAR worker exited without a result')));
}
// The worker entry and the two thresholds are parameters so tests and tuning runs can pin them
// (a stub worker proves the crash path; a forced threshold exercises the split on a small scene);
// the service only ever passes `workers`.
function runImage(scene, processing, {workers = poolSize(), workerFile = WORKER_FILE, minParallelMs = MIN_PARALLEL_MS, minChunkMs = MIN_CHUNK_MS} = {}) {
  const started = performance.now(), size = Math.max(1, workers);
  let running = null, settled = false, resolveJob = null, rejectJob = null, mode = 'serial', estimate = null, cfg = null, valid = null, failure = null;
  const done = new Promise((resolve, reject) => { resolveJob = resolve; rejectJob = reject; });
  const settle = (settleWith, value) => { if (settled) return; settled = true; settleWith(value); };
  const report = e => settle(rejectJob, e instanceof Error ? e : Error(String(e)));
  // The size decision is synchronous so callers can report which path an image takes; anything
  // that throws while planning is reported through `done`, like a worker failure.
  try {
    cfg = settings(processing); valid = validate(scene);
    estimate = estimateWork(valid, cfg, pulses(valid, [], cfg).samples.length);
    mode = size > 1 && estimate.ms >= minParallelMs ? 'parallel' : 'serial';
  } catch (e) { failure = e; }
  async function serial() {
    const worker = new Worker(workerFile, {workerData: {task: 'image', scene: valid, processing}});
    running = {workers: [worker]};
    const answer = await new Promise((resolve, reject) => workerSettled(worker, resolve, reject));
    running = null;
    return answer.result;
  }
  async function parallel() {
    const aperture = engine.apertureGeometry(valid);          // the serial path's pre-flight checks
    const scatterers = engine.buildScatterers(valid, cfg);     // ~20 ms; workers receive this list
    const plan = engine.planScene(valid, scatterers, cfg);      // bin grid, pulse times, aperture weights
    const pulseCount = plan.samples.length, count = plan.count, width = cfg.width;
    const parts = Math.max(2, Math.min(size, pulseCount, width, Math.ceil(estimate.ms / minChunkMs)));
    const shared = {
      re: new SharedArrayBuffer(8 * count * pulseCount), im: new SharedArrayBuffer(8 * count * pulseCount),
      reference: new SharedArrayBuffer(8 * pulseCount)
    };
    const pulseBlocks = blocks(pulseCount, parts), rowBlocks = blocks(width, parts);
    const team = pulseBlocks.map((synth, i) => new Worker(workerFile, {
      workerData: {
        task: 'chunk', scene: valid, processing,
        scatterers, shared, synth, focus: rowBlocks[i]
      }
    }));
    running = {workers: team};
    try {
      await Promise.all(team.map(worker => new Promise((resolve, reject) => workerSettled(worker, message =>
        message.phase === 'synthesized' ? resolve() : reject(Error('Unexpected SAR worker message')), reject))));
      // Barrier: all pulses are in the shared history, so every worker can focus any row. The PFA
      // is not split (one 2-D FFT over the whole k-space), so one worker focuses and the rest idle.
      const chunks = cfg.focuser === 'pfa'
        ? [await new Promise((resolve, reject) => {
          workerSettled(team[0], message => message.phase === 'focused' ? resolve(message.power) : reject(Error('Unexpected SAR worker message')), reject);
          team[0].postMessage({phase: 'pfa'});
        })]
        : await Promise.all(team.map(worker => new Promise((resolve, reject) => {
          workerSettled(worker, message => message.phase === 'focused' ? resolve(message.power) : reject(Error('Unexpected SAR worker message')), reject);
          worker.postMessage({phase: 'focus'});
        })));
      const power = [];
      for (const chunk of chunks) for (const value of chunk) power.push(value);
      return engine.assembleResult(valid, cfg, scatterers, power,
        {...aperture, pulses: pulseCount, prf: plan.sampling.prf, method: plan.sampling.method, resolution: plan.resolution}, started);
    } finally {
      running = null;
      await Promise.allSettled(team.map(worker => worker.terminate()));
    }
  }
  Promise.resolve().then(() => {
    if (failure) throw failure;
    return mode === 'parallel' ? parallel() : serial();
  }).then(result => settle(resolveJob, result), report);
  return {
    mode, estimate, workers: size, done,
    // Stops the whole team of the image in flight. Used on service shutdown and by callers that
    // abandon a computation, so no worker survives an aborted or closed service.
    terminate: async () => {
      const current = running; running = null;
      settle(rejectJob, Error('SAR computation terminated'));
      await Promise.allSettled((current?.workers || []).map(worker => worker.terminate()));
    }
  };
}
module.exports = {runImage, poolSize, estimateWork, blocks, MIN_PARALLEL_MS, MIN_CHUNK_MS, WORKER_FILE};

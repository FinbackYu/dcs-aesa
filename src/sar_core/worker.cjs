'use strict';
// Worker entry of the SAR image pool (see pool.cjs). Two roles:
//   task 'image' — one complete serial reconstruct; the single-worker/baseline path.
//   task 'chunk' — one block of a split image: fill this block's pulse range in the shared
//                  echo-history buffers, wait for the pool's barrier, then focus this block's
//                  pixel rows. Both phases call the same engine functions as the serial path,
//                  so a split image computes exactly the same numbers.
const {parentPort, workerData} = require('node:worker_threads');
const engine = require('./engine.cjs');
const {focusRows} = require('./focus.cjs');
const pfa = require('./pfa.cjs');
const fail = e => parentPort.postMessage({error: e.message || String(e)});
function releasedPower(power) {
  const values = Float64Array.from(power);
  parentPort.postMessage({phase: 'focused', power: values}, {transferList: [values.buffer]});
}
function focusChunk(plan, history, rowStart, rowEnd, processing) {
  releasedPower(focusRows({scene: plan.scene, cfg: plan.cfg, samples: plan.samples,
    weights: plan.weights, weightSum: plan.weightSum, binMin: plan.binMin, spacing: plan.spacing, history}, rowStart, rowEnd, processing, engine.pixel));
}
if (workerData.task === 'image') {
  try { parentPort.postMessage({result: engine.reconstruct(workerData.scene, workerData.processing || {})}); }
  catch (e) { fail(e); }
} else if (workerData.task === 'chunk') {
  try {
    const {scene, processing = {}, scatterers, shared, synth: [from, to], focus: [rowStart, rowEnd]} = workerData;
    const plan = engine.planScene(scene, scatterers, processing), count = plan.count, pulses = plan.samples.length;
    const re = new Float64Array(shared.re), im = new Float64Array(shared.im), reference = new Float64Array(shared.reference);
    engine.synthesizeRange(plan, scatterers, from, to, {re, im, reference});
    parentPort.postMessage({phase: 'synthesized'});
    parentPort.once('message', message => {
      if (message?.phase !== 'focus' && message?.phase !== 'pfa') return;
      try {
        const history = new Array(pulses);
        for (let n = 0; n < pulses; n++) history[n] = {reference: reference[n], re: re.subarray(n * count, (n + 1) * count), im: im.subarray(n * count, (n + 1) * count)};
        // PFA runs on one worker over the whole shared history: the FFT is not split, only the
        // echo synthesis is.
        if (message.phase === 'pfa') releasedPower(pfa.focus({...plan, history}, processing).power);
        else focusChunk(plan, history, rowStart, rowEnd, processing);
      } catch (e) { fail(e); }
    });
  } catch (e) { fail(e); }
} else fail(Error('Unknown SAR worker task'));

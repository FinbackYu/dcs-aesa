'use strict';
// Time-domain backprojection: the exact-range focuser.
//
// Each pixel accumulates over every pulse inside its own iteration, so a row block
// holds exactly the values the serial row loop produces and blocks can be
// concatenated in index order without any change in summation order (see pool.cjs).
const {pixelCenter, pixel: pixelAt} = require('./geometry.cjs');

// One pixel: integrate the range-compressed echo of every pulse at that pixel's own
// 3-D range. `rangeError` is a probe hook (it shifts each pulse's travel range), not
// part of the physics; `erasePhase` drops the echo phase before the propagation
// phase, which turns the focus into an incoherent sum and is used to prove the
// aperture phase is what creates the peak.
function focusPoint(data, point, { erasePhase = false, rangeError = () => 0 } = {}) {
  let real = 0, imag = 0;
  for (let n = 0; n < data.history.length; n++) {
    const h = data.history[n], delta = distance(data.samples[n].pos, point) - h.reference + rangeError(n);
    const index = (delta - data.binMin) / data.spacing, j = Math.floor(index), f = index - j;
    if (j < 0 || j + 1 >= h.re.length) continue;
    let re = h.re[j] * (1 - f) + h.re[j + 1] * f, im = h.im[j] * (1 - f) + h.im[j + 1] * f;
    if (data.cfg.rangeInterpolation === 'cubic' && j >= 1 && j + 2 < h.re.length) {
      const f2 = f * f, f3 = f2 * f, a = -.5 * f + f2 - .5 * f3, b = 1 - 2.5 * f2 + 1.5 * f3,
        c = .5 * f + 2 * f2 - 1.5 * f3, d = -.5 * f2 + .5 * f3;
      re = a * h.re[j - 1] + b * h.re[j] + c * h.re[j + 1] + d * h.re[j + 2];
      im = a * h.im[j - 1] + b * h.im[j] + c * h.im[j + 1] + d * h.im[j + 2];
    }
    if (erasePhase) { re = Math.hypot(re, im); im = 0; }
    const phase = 4 * Math.PI * delta / data.cfg.lambda, w = data.weights[n];
    real += w * (re * Math.cos(phase) - im * Math.sin(phase));
    imag += w * (re * Math.sin(phase) + im * Math.cos(phase));
  }
  return (real * real + imag * imag) / (data.weightSum * data.weightSum);
}

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// Rows [rowStart, rowEnd) of the output grid, in row-major order. The pixel mapper defaults to the
// canonical scene grid; the pool passes its own only to share the identical function with the serial
// path, never a different projection.
function focusRows(data, rowStart, rowEnd, options, pixel = pixelAt) {
  const { scene, cfg } = data, { width } = cfg, power = [];
  for (let r = rowStart; r < rowEnd; r++) for (let c = 0; c < width; c++) power.push(focusPoint(data,
    pixel(scene, pixelCenter(c, scene.size, width), pixelCenter(r, scene.size, width)), options));
  return power;
}

module.exports = { focusPoint, focusRows };

'use strict';
// Polar-format (frequency-domain) focuser — the second focusing path beside
// time-domain backprojection. One range FFT per pulse, polar→rectangular
// resampling of the baseband spectrum, one 2-D inverse FFT. No dependencies; the
// radix-2 FFT below is the only transform.
//
// Model. The synthesis stores, for pulse n, the range-compressed complex echo as a
// function of the slant-range offset d from the patch centre, with the phase
// exp(-j k d), k = 4pi/lambda:
//     g_n(d) = sum_s a_s exp(j phi_s) exp(-j k d_s) K((d - d_s)/resolution),  d_s = R_n(s) - R_nc
// Its transform over d is  G_n(nu) = sum_s a_s exp(j phi_s) exp(-j (k + 2pi nu) d_s) Wh(2pi nu);
// the envelope kernel K is Hann-shaped, so Wh is a Hann window over |nu| <= 1/(2 resolution):
// the data is band-limited to kappa = k + 2pi nu in [k - pi/resolution, k + pi/resolution].
// With the plane-wave (far-field) approximation d_s ~ u_n . s, u_n the unit line of sight from
// the platform to the patch centre, G_n(nu) equals the 2-D spectrum of the scene at the k-vector
// kappa*u_n. Resampling those polar samples onto a rectangular grid in the patch (cross, ground)
// plane and inverting with a 2-D FFT images the patch.
//
// Sampling. The k-grid must (a) hold the polar support - a thin annular sector of radius ~k,
// which is what forces the PFA image grid to be as fine as the resolution - and (b) let the
// image be at least as large as the patch, which fixes the k-grid spacing dk = 2pi/(N*step).
// Interpolation is bilinear in (direction, kappa), the same gather the classic implementations
// use; nearest-neighbour would add a larger phase error than the plane-wave term it is meant to
// measure, so linear interpolation is used everywhere.
//
// Limits (documented in docs/sar-feasibility.md, measured by scripts/sar_pfa_probe.cjs):
//   * plane-wave phase error k*|s_perp|^2/(2R) is not compensated -> patch-size limit;
//   * the patch is assumed flat at the centre height (terrain relief maps to a ground-range
//     displacement ~ h/tan(elevation) and defocus, exactly the layover the backprojection keeps);
//   * the residual quadratic phase also makes the speckle realisation differ from the
//     backprojection's even when both are correctly focused.
const {C_MPS, sar: {pfa: PFA_LIMITS}} = require('../shared/config.cjs');
const {worldToScene, clampPixel, pixelCenter} = require('./geometry.cjs');
// The image grid must cover the polar support; beyond this the FFT working set is no longer
// worth it (2048^2 complex = 67 MB, ~250 ms), and a 2048 m overview patch is outside PFA's
// plane-wave limits anyway.
const MAX_PFA_GRID = PFA_LIMITS.max_grid;
function nextPow2(value) { let power = 1; while (power < value) power *= 2; return power; }
const twiddleCache = new Map();
function twiddles(count) {
  let table = twiddleCache.get(count);
  if (!table) {
    const cos = new Float64Array(count / 2), sin = new Float64Array(count / 2);
    for (let i = 0; i < count / 2; i++) { const angle = -2 * Math.PI * i / count; cos[i] = Math.cos(angle); sin[i] = Math.sin(angle); }
    table = {cos, sin}; twiddleCache.set(count, table);
  }
  return table;
}
// In-place iterative radix-2 FFT. sign=-1 forward (sum x exp(-2pi i mn/N)), +1 inverse.
function fft(re, im, sign) {
  const count = re.length;
  if (count !== im.length || (count & (count - 1)) !== 0) throw Error('FFT length must be a power of two');
  const {cos, sin} = twiddles(count);
  for (let i = 1, j = 0; i < count; i++) {
    let bit = count >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let span = 2; span <= count; span <<= 1) {
    const half = span >> 1, stride = count / span;
    for (let base = 0; base < count; base += span) {
      for (let k = 0, index = 0; k < half; k++, index += stride) {
        const wr = cos[index], wi = sign < 0 ? sin[index] : -sin[index];
        const a = base + k, b = a + half, xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
      }
    }
  }
}
function fft2d(re, im, count, sign) {
  const rowRe = new Float64Array(count), rowIm = new Float64Array(count);
  for (let row = 0; row < count; row++) {
    const base = row * count;
    rowRe.set(re.subarray(base, base + count)); rowIm.set(im.subarray(base, base + count));
    fft(rowRe, rowIm, sign);
    re.set(rowRe, base); im.set(rowIm, base);
  }
  for (let column = 0; column < count; column++) {
    for (let row = 0; row < count; row++) { rowRe[row] = re[row * count + column]; rowIm[row] = im[row * count + column]; }
    fft(rowRe, rowIm, sign);
    for (let row = 0; row < count; row++) { re[row * count + column] = rowRe[row]; im[row * count + column] = rowIm[row]; }
  }
}
// Geometry shared by the plan and the focusing loop: in-plane line of sight per pulse, the
// k-space support and the resulting image/k grid. Exported so probes can report the plan.
function planPfa(data, grid = {}) {
  const {scene, cfg, history, samples, spacing, resolution} = data;
  const width = grid.width || cfg.width, size = grid.size || scene.size, pulseCount = history.length, k = 4 * Math.PI / cfg.lambda;
  if (!(pulseCount >= 2) || !(resolution > 0) || !(spacing > 0)) throw Error('Invalid PFA input');
  // Plane basis from the patch bearing, matching pixel(): cross -> (sin b, 0, -cos b),
  // ground -> (cos b, 0, sin b); the vertical component of the line of sight is dropped, which is
  // the flat-patch assumption. worldToScene projects the platform into that basis; the line of
  // sight points from the platform to the centre, so the projected direction is its negative.
  const sin = Math.sin(scene.bearing), cos = Math.cos(scene.bearing);
  const cx = scene.center[0], cy = scene.center[1], cz = scene.center[2];
  const dirCross = new Float64Array(pulseCount), dirGround = new Float64Array(pulseCount);
  const magnitude = new Float64Array(pulseCount);
  let meanCross = 0, meanGround = 0;
  for (let n = 0; n < pulseCount; n++) {
    const p = samples[n].pos, vx = cx - p[0], vy = cy - p[1], vz = cz - p[2], range = Math.hypot(vx, vy, vz);
    if (!(range > 0) || !Number.isFinite(range)) throw Error('Invalid PFA input');
    const [platformCross, platformGround] = worldToScene(scene.center, scene.bearing, p[0], p[2]);
    dirCross[n] = -platformCross / range; dirGround[n] = -platformGround / range;
    magnitude[n] = Math.hypot(dirCross[n], dirGround[n]);
    meanCross += dirCross[n]; meanGround += dirGround[n];
  }
  meanCross /= pulseCount; meanGround /= pulseCount;
  const order = Array.from({length: pulseCount}, (_, n) => n).sort((a, b) =>
    Math.atan2(dirCross[a], dirGround[a]) - Math.atan2(dirCross[b], dirGround[b]));
  const angles = new Float64Array(pulseCount);
  for (let i = 0; i < pulseCount; i++) angles[i] = Math.atan2(dirCross[order[i]], dirGround[order[i]]);
  const halfBand = Math.PI / resolution, kMin = k - halfBand, kMax = k + halfBand;
  let uMax = 0, vMax = 0;
  for (let n = 0; n < pulseCount; n++) for (let s = 0; s < 2; s++) {
    const kappa = s ? kMax : kMin;
    uMax = Math.max(uMax, Math.abs(dirCross[n] * kappa - k * meanCross));
    vMax = Math.max(vMax, Math.abs(dirGround[n] * kappa - k * meanGround));
  }
  // Nyquist pixel size pi/k_max per axis, with 5% margin; grid size covers the patch plus margin.
  // A caller may ask for a finer step (k-space zero padding): the FFT grid is then judged on the
  // smaller step, which keeps the same k-support but samples the image more finely.
  const nyquist = Math.PI / (PFA_LIMITS.nyquist_margin * Math.max(uMax, vMax));
  const step = Math.min(nyquist, grid.step_m || nyquist);
  const count = Math.min(MAX_PFA_GRID, Math.max(PFA_LIMITS.min_grid, nextPow2(Math.ceil(size / step * PFA_LIMITS.grid_margin))));
  if (count * step < size) throw Error(`PFA needs a k-space grid beyond ${MAX_PFA_GRID}² for this patch; use backprojection or a smaller footprint`);
  const dk = 2 * Math.PI / (count * step);
  // Range spectrum: decimate the range bins to at most one sample per resolution cell (the
  // synthesis kernel is exactly Hann-band-limited, so this loses nothing) and transform.
  const binCount = history[0].re.length;
  let decim = 1; while (decim * 2 * spacing <= resolution && decim < PFA_LIMITS.decimation_max) decim *= 2;
  const decimatedSpan = Math.floor((binCount - 1) / decim) + 1;
  let radial = nextPow2(Math.max(PFA_LIMITS.radial_min_grid, decimatedSpan));
  while (2 * Math.PI / (radial * decim * spacing) > dk) radial *= 2;
  return {
    scene, cfg, width, size, pulseCount, k, sin, cos, dirCross, dirGround, magnitude, meanCross, meanGround,
    order, angles, halfBand, kMin, kMax, uMax, vMax, step, count, dk, binCount, decim, radial,
    band_m: [kMin, kMax], support_rad_m: [uMax, vMax]
  };
}
function focus(data, processing = {}, grid = {}) {
  const plan = planPfa(data, grid);
  const {history, binMin, weights, weightSum, spacing} = data;
  const {k, order, angles, magnitude, meanCross, meanGround,
    kMin, kMax, uMax, vMax, step, count, dk, binCount, decim, radial, pulseCount, width, size} = plan;
  const scale = radial * decim * spacing / (2 * Math.PI);
  // Per-pulse range spectra, weighted by the same aperture window the backprojection uses and
  // referred to the patch centre (the decimated first bin sits at d = binMin).
  const stackRe = new Float64Array(pulseCount * radial), stackIm = new Float64Array(pulseCount * radial);
  const workRe = new Float64Array(radial), workIm = new Float64Array(radial);
  for (let n = 0; n < pulseCount; n++) {
    workRe.fill(0); workIm.fill(0);
    const row = history[n];
    for (let m = 0, j = 0; m < radial && j < binCount; m++, j += decim) { workRe[m] = row.re[j]; workIm[m] = row.im[j]; }
    fft(workRe, workIm, -1);
    const weight = weights ? weights[n] / (weightSum || 1) : 1;
    for (let m = 0; m < radial; m++) {
      const index = m <= radial / 2 ? m : m - radial, nu = index / (radial * decim * spacing), phase = -2 * Math.PI * nu * binMin;
      const wr = Math.cos(phase) * weight, wi = Math.sin(phase) * weight;
      const re = workRe[m], im = workIm[m];
      stackRe[n * radial + m] = re * wr - im * wi; stackIm[n * radial + m] = re * wi + im * wr;
    }
  }
  // Gather the polar samples onto the rectangular baseband grid, bilinear in (direction, kappa).
  const gridRe = new Float64Array(count * count), gridIm = new Float64Array(count * count);
  const half = count / 2, uLo = Math.max(0, Math.floor(-uMax / dk + half)), uHi = Math.min(count - 1, Math.ceil(uMax / dk + half));
  const vLo = Math.max(0, Math.floor(-vMax / dk + half)), vHi = Math.min(count - 1, Math.ceil(vMax / dk + half));
  // The range DFT puts nu=0 at index 0 (the band is the whole decimated Nyquist band, since the
  // decimation step equals the resolution), so kappa = k sits at index 0 and the array wraps.
  const radialAt = kappa => { const position = (kappa - k) * scale % radial; return position < 0 ? position + radial : position; };
  for (let iu = uLo; iu <= uHi; iu++) {
    const kCross = (iu - half) * dk + k * meanCross;
    for (let iv = vLo; iv <= vHi; iv++) {
      // kCross/kGround are the in-plane components of the k-vector; the radial wavenumber of a
      // sample is |k|/|in-plane line of sight|, so the band limit is applied per pulse below.
      const kGround = (iv - half) * dk + k * meanGround, kappa = Math.hypot(kCross, kGround);
      const phi = Math.atan2(kCross, kGround);
      let lo = 0, hi = pulseCount - 1;
      if (phi < angles[0] || phi > angles[hi]) continue;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (angles[mid] <= phi) lo = mid; else hi = mid; }
      const span = angles[hi] - angles[lo], fraction = span > 0 ? (phi - angles[lo]) / span : 0;
      const first = order[lo], second = order[hi];
      let sumRe = 0, sumIm = 0;
      for (let side = 0; side < 2; side++) {
        const pulse = side ? second : first, position = radialAt(kappa / magnitude[pulse]);
        if (!Number.isFinite(position)) continue;
        const j = Math.floor(position), frac = position - j, base = pulse * radial, next = j + 1 === radial ? 0 : j + 1;
        const re = stackRe[base + j] + (stackRe[base + next] - stackRe[base + j]) * frac;
        const im = stackIm[base + j] + (stackIm[base + next] - stackIm[base + j]) * frac;
        const weight = side ? fraction : 1 - fraction;
        sumRe += weight * re; sumIm += weight * im;
      }
      if (sumRe === 0 && sumIm === 0) continue;
      gridRe[iv * count + iu] = sumRe; gridIm[iv * count + iu] = sumIm;
    }
  }
  // The k grid is centred on index count/2, so the inverse transform needs the (-1)^index
  // checkerboard on both axes; the output checkerboard is a pure sign and |I|^2 is unaffected.
  for (let iv = 0; iv < count; iv++) for (let iu = 0; iu < count; iu++) if ((iu + iv) & 1) { const m = iv * count + iu; gridRe[m] = -gridRe[m]; gridIm[m] = -gridIm[m]; }
  fft2d(gridRe, gridIm, count, 1);
  // Sample |I|^2 (bilinear) onto the display grid: index p <-> (p - count/2)*step metres.
  const power = new Array(width * width);
  for (let row = 0; row < width; row++) {
    const fV = pixelCenter(row, size, width) / step + half;
    for (let column = 0; column < width; column++) {
      const fU = pixelCenter(column, size, width) / step + half;
      const u = clampPixel(fU, count, 1e-6), v = clampPixel(fV, count, 1e-6);
      const ui = Math.floor(u), vi = Math.floor(v), fu = u - ui, fv = v - vi, m = vi * count + ui;
      const a = gridRe[m] * gridRe[m] + gridIm[m] * gridIm[m], b = gridRe[m + 1] * gridRe[m + 1] + gridIm[m + 1] * gridIm[m + 1];
      const c2 = gridRe[m + count] * gridRe[m + count] + gridIm[m + count] * gridIm[m + count];
      const d = gridRe[m + count + 1] * gridRe[m + count + 1] + gridIm[m + count + 1] * gridIm[m + count + 1];
      power[row * width + column] = (a * (1 - fu) + b * fu) * (1 - fv) + (c2 * (1 - fu) + d * fu) * fv;
    }
  }
  return {
    power, width, size, step_m: step, grid: count, radial_samples: radial, pulses: pulseCount,
    band_rad_m: [kMin, kMax], support_rad_m: [uMax, vMax], focused_pulses: pulseCount,
    model: 'polar-format (plane-wave, flat patch); polar resampling bilinear in direction and kappa'
  };
}
module.exports = {focus, planPfa, fft, fft2d, nextPow2, MAX_PFA_GRID, C: C_MPS};

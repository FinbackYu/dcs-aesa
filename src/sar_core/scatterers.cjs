'use strict';
// Scatterer model of the assumed surface: where the sampling points sit, what
// they scatter, and what occludes them.
//
// The DEM is geometry, not reflectivity: interpolation of the terrain grid is
// geometry, while the amplitude of a point comes from a project assumption.
// Three models exist and each is explicit:
//   * `uniform`    — every sample carries the same coefficient with a bilinear
//                    slope incidence factor (no class input at all);
//   * `classified` — each sample takes the ground class under it from the
//                    surface grid and the local surface normal from the DEM;
//                    objects on the scene become their own oriented-box faces.
//   * objects      — in both models, boxes occlude; in `classified` their faces
//                    also scatter, so a wall focuses at the ground range whose
//                    slant range matches (see the layover note in map.cjs).
//
// Sample positions and phases are anchored to world x/z cells, not to DEM
// vertices, so overlapping patches agree and the image does not show the
// terrain lattice.
const {sar:{constants:SAR_CONSTANTS,scene:SAR_SCENE}}=require('../shared/config.cjs');
const {worldToScene,texelIndex,clampPixel,pixel}=require('./geometry.cjs');
const {MATERIALS,materialAt}=require('./materials.cjs');

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const local = (scene, p) => worldToScene(scene.center, scene.bearing, p[0], p[2]);

function boxBlocked(o, from, to) {
  const a = from.map((v, i) => v - o.pos[i]), d = to.map((v, i) => v - from[i]);
  let lo = 0, hi = 1;
  for (let i = 0; i < 3; i++) {
    const p = dot(a, o.axes[i]), v = dot(d, o.axes[i]);
    if (Math.abs(v) < 1e-10) { if (p < o.min[i] || p > o.max[i]) return false; continue; }
    let t0 = (o.min[i] - p) / v, t1 = (o.max[i] - p) / v;
    if (t0 > t1) [t0, t1] = [t1, t0];
    lo = Math.max(lo, t0); hi = Math.min(hi, t1);
    if (lo > hi) return false;
  }
  return hi > 1e-6 && lo < 1 - 1e-6;
}

// The occlusion march samples the DEM at half its spacing — up to ~180 samples
// on the longest patch ray — so it reads a flat copy of the patch through index
// arithmetic instead of calling pixel(), which builds a new point for every
// sample. Same clamping as pixel(), so both agree exactly.
function createSampler(scene) {
  const { n, terrain } = scene, size = scene.size, heights = new Float64Array(n * n);
  for (let i = 0; i < heights.length; i++) heights[i] = terrain[i][1];
  return (cross, ground) => {
    const [col, row] = texelIndex(cross, ground, size, n), c = clampPixel(col, n), r = clampPixel(row, n);
    const c0 = Math.min(n - 2, Math.floor(c)), r0 = Math.min(n - 2, Math.floor(r)), fc = c - c0, fr = r - r0, i = r0 * n + c0;
    return (1 - fr) * ((1 - fc) * heights[i] + fc * heights[i + 1]) + fr * ((1 - fc) * heights[i + n] + fc * heights[i + n + 1]);
  };
}

function terrainBlocked(scene, from, to, terrainAt, sample) {
  const a = local(scene, from), b = local(scene, to), d = b.map((v, i) => v - a[i]), half = scene.size / 2;
  let lo = 0, hi = 1;
  for (let i = 0; i < 2; i++) {
    if (Math.abs(d[i]) < 1e-10) { if (Math.abs(a[i]) > half) return false; continue; }
    let t0 = (-half - a[i]) / d[i], t1 = (half - a[i]) / d[i];
    if (t0 > t1) [t0, t1] = [t1, t0];
    lo = Math.max(lo, t0); hi = Math.min(hi, t1);
    if (lo > hi) return false;
  }
  // Sample only known DEM, at half its spacing. Outside-patch occlusion is unknown.
  const steps = Math.max(1, Math.ceil(Math.hypot(...d) * (hi - lo) / (scene.size / (scene.n - 1) / 2)));
  for (let k = 0; k <= steps; k++) {
    const t = lo + (hi - lo) * k / steps;
    if (t >= 1 - 1e-6) continue;
    const h = sample ? sample(a[0] + d[0] * t, a[1] + d[1] * t) : terrainAt(scene, a[0] + d[0] * t, a[1] + d[1] * t)[1];
    if (h > from[1] + (to[1] - from[1]) * t + .1) return true;
  }
  return false;
}

function modelObjects(scene) {
  return (scene.objects || []).filter(o => {
    const p = local(scene, o.pos), radius = Math.hypot(...o.max.map((v, i) => Math.max(Math.abs(v), Math.abs(o.min[i]))));
    return Math.abs(p[0]) <= scene.size / 2 + radius && Math.abs(p[1]) <= scene.size / 2 + radius;
  }).slice(0, SAR_SCENE.model_objects_max);
}

// Faces of each oriented box as scattering points, on a shared finite budget:
// boxes represent geometry, not meshes.
function objectScatterers(objects, seed, hash) {
  const points = [], budget = SAR_SCENE.object_scatter_budget;
  for (let oi = 0; oi < objects.length; oi++) {
    const o = objects[oi], length = o.max.map((v, i) => v - o.min[i]);
    for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
      const u = (axis + 1) % 3, v = (axis + 2) % 3,
        spacing = Math.max(2, Math.sqrt(length[u] * length[v] * 6 * objects.length / budget)),
        nu = Math.max(1, Math.ceil(length[u] / spacing)), nv = Math.max(1, Math.ceil(length[v] / spacing));
      for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
        if (points.length >= budget) return points;
        const coord = [0, 0, 0];
        coord[axis] = sign > 0 ? o.max[axis] : o.min[axis];
        coord[u] = o.min[u] + (i + .5) * length[u] / nu;
        coord[v] = o.min[v] + (j + .5) * length[v] / nv;
        const pos = o.pos.map((p, k) => p + coord.reduce((sum, x, a) => sum + x * o.axes[a][k], 0)),
          normal = o.axes[axis].map(x => x * sign), area = length[u] * length[v] / (nu * nv);
        points.push({
          pos, normal, object: oi, area, amplitude: Math.sqrt(area * 2),
          phase: 2 * Math.PI * hash(Math.floor(pos[0] * 10), Math.floor(pos[2] * 10), seed, axis * 71 + sign + Math.floor(pos[1] * 10)) / 4294967296
        });
      }
    }
  }
  return points;
}

// Occlusion of one scatterer from one look. The terrain march is the expensive
// part; an oriented box only has to be tested when the ray reaches it, and every
// face of a box is a scatterer of its own, so a point is never blocked by the
// box it belongs to.
function occluder(scene, point, pose, objects, terrainAt, sampler) {
  if (terrainBlocked(scene, pose, point.pos, terrainAt, sampler)) return 'terrain';
  for (let i = 0; i < objects.length; i++) if (i !== point.object && boxBlocked(objects[i], pose, point.pos)) return 'object';
  return null;
}

// One occlusion evaluation per scatterer at a chosen pose, stored on the point
// as `blocked_by`. The look geometry changes by only ~1.4 deg over a 2 s
// aperture, so the mask is evaluated once for the frame rather than per pulse;
// the residual per-pulse quantity is the incidence cosine, a dot product.
function markVisibility(scene, points, pose, objects, terrainAt) {
  const sampler = createSampler(scene);
  let terrain = 0, object = 0;
  for (const point of points) {
    point.blocked_by = undefined;
    const cause = occluder(scene, point, pose, objects, terrainAt, sampler);
    if (cause) { point.blocked_by = cause; if (cause === 'terrain') terrain++; else object++; }
  }
  return { tested: points.length, terrain, object, blocked: terrain + object };
}

function visibilityStats(points) {
  let terrain = 0, object = 0;
  for (const point of points) {
    if (point.blocked_by === 'terrain') terrain++;
    else if (point.blocked_by) object++;
  }
  return { terrain, object, blocked: terrain + object, tested: points.length };
}

// Amplitudes are summed over ~1.5e6 scatterer-pulse pairs for one image, so the
// dot products are written without allocating a ray array or spreading a normal
// into Math.hypot.
function amplitude(scene, s, pose, objects, terrainAt, { perPulse = false, sampler = null } = {}) {
  const rx = pose[0] - s.pos[0], ry = pose[1] - s.pos[1], rz = pose[2] - s.pos[2], range = Math.sqrt(rx * rx + ry * ry + rz * rz);
  let incidence = 1;
  if (s.normal) {
    const n = s.normal;
    incidence = Math.max(0, (n[0] * rx + n[1] * ry + n[2] * rz) / (Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]) * range));
  }
  if (incidence <= 0) return 0;
  if (perPulse) { if (occluder(scene, s, pose, objects, terrainAt, sampler)) return 0; }
  else if (s.blocked_by) return 0;
  return s.amplitude * Math.sqrt(incidence);
}

// Jittered world-cell hash: the same (ix,iz,seed,salt) always yields the same
// [0,1) value, so overlapping patches place identical samples.
function hashCell(x, z, seed, salt) {
  let h = (Math.imul(x | 0, 0x9e3779b1) ^ Math.imul(z | 0, 0x85ebca77) ^ seed ^ salt) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d); h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0) + .5;
}

// DEM surface normal at a fractional scene coordinate, from the four samples
// that bracket it (bilinear), in world axes.
function surfaceNormal(scene, cross, ground) {
  const n = scene.n, d = scene.size / (n - 1);
  const [col, row] = texelIndex(cross, ground, scene.size, n);
  const c = clampPixel(col, n), r = clampPixel(row, n);
  const c0 = Math.min(n - 2, Math.floor(c)), r0 = Math.min(n - 2, Math.floor(r)), fc = c - c0, fr = r - r0;
  const h = (row, col) => scene.terrain[row * n + col][1];
  const dc = ((1 - fr) * (h(r0, c0 + 1) - h(r0, c0)) + fr * (h(r0 + 1, c0 + 1) - h(r0 + 1, c0))) / d;
  const dr = ((1 - fc) * (h(r0 + 1, c0) - h(r0, c0)) + fc * (h(r0 + 1, c0 + 1) - h(r0, c0 + 1))) / d;
  const b = scene.bearing;
  return [-dc * Math.sin(b) - dr * Math.cos(b), 1, dc * Math.cos(b) - dr * Math.sin(b)];
}

// The scatterer list of one image. Geometry is read through pixel() so the
// exact DEM the focusing chain uses is the surface the echoes come from.
function buildScatterers(scene, cfg) {
  const step = cfg.scatterSpacing, half = scene.size / 2;
  const corners = [pixel(scene, -half, -half), pixel(scene, -half, half), pixel(scene, half, -half), pixel(scene, half, half)];
  const x0 = Math.floor(Math.min(...corners.map(p => p[0])) / step), x1 = Math.floor(Math.max(...corners.map(p => p[0])) / step);
  const z0 = Math.floor(Math.min(...corners.map(p => p[2])) / step), z1 = Math.floor(Math.max(...corners.map(p => p[2])) / step);
  const mid = scene.trajectory[Math.floor(scene.trajectory.length / 2)].pos, points = [];
  for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) {
    const x = (ix + hashCell(ix, iz, cfg.seed, 0x12345678) / 4294967296) * step;
    const z = (iz + hashCell(ix, iz, cfg.seed, 0x87654321) / 4294967296) * step;
    const [cross, ground] = worldToScene(scene.center, scene.bearing, x, z);
    if (Math.abs(cross) > half || Math.abs(ground) > half) continue;
    const pos = pixel(scene, cross, ground), norm = surfaceNormal(scene, cross, ground), towards = mid.map((v, j) => v - pos[j]);
    const incidence = Math.max(0, norm.reduce((sum, v, j) => sum + v * towards[j], 0) / (Math.hypot(...norm) * Math.hypot(...towards)));
    const material = materialAt(scene, cross, ground);
    points.push({
      pos, phase: 2 * Math.PI * hashCell(ix, iz, cfg.seed, 0xa5a5a5a5) / 4294967296,
      ...(cfg.sceneModel === 'classified' ? { normal: norm, material } : {}),
      amplitude: Math.sqrt(step * step * (cfg.sceneModel === 'classified' ? MATERIALS[material] : .05 + incidence)),
      area: step * step, key: `${ix},${iz}`
    });
  }
  if (cfg.sceneModel === 'classified') points.push(...objectScatterers(modelObjects(scene), cfg.seed, hashCell));
  // Occlusion mask. Buildings shadow the ground in both scene models (they are
  // only *scatterers* in the classified one), and the mask is evaluated once per
  // scatterer at the aperture-centre pose: the look direction moves about 1.4 deg
  // over a 2 s aperture, far below the shadow-edge scale, while one march per
  // pulse would cost the full scatterer-pulse product. With shadowLook:'pulse'
  // the same mask is kept for reporting only — the synthesis re-decides per pulse.
  if (cfg.shadow) markVisibility(scene, points, mid, modelObjects(scene), pixel);
  return points;
}

module.exports = {
  hashCell, surfaceNormal, buildScatterers, modelObjects, objectScatterers,
  amplitude, occluder, terrainBlocked, boxBlocked, local, createSampler, markVisibility, visibilityStats
};

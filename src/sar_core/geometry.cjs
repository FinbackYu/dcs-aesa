'use strict';
// Canonical scene/MAP geometry shared by the JS core and the Lua twin
// (src/sar_core/geometry.lua). Pure math: no game API, no IO, no dependencies
// beyond the generated spec constants.
//
// Scene grid (docs/conventions.md §6.3):
//   cross  = (col/(n-1) - 0.5) * size
//   ground = (row/(n-1) - 0.5) * size
//   x = cx + cross*sin(b) + ground*cos(b)
//   z = cz - cross*cos(b) + ground*sin(b)
// Its inverse:
//   cross = dx*sin(b) - dz*cos(b)
//   ground = dx*cos(b) + dz*sin(b)
// The vertical axis is not part of the projection: callers take y from the DEM.
// `bearing` is the SAR scene bearing of the ground/LOS axis: 0 = +x,
// +pi/2 = +z (atan2(dz,dx)); it is not the MAP engine heading atan2(dx,dz).
//
// MAP grid (docs/conventions.md §6.1): col runs along +x, row along +z.
//   x = x0 + col*step, z = z0 + row*step
//
// Return convention: arrays in the same order as the Lua multiple returns.
// `center` accepts either {x,z} named fields or a 3-element sequence [x,y,z].
// texelIndex/pixelCenter require n >= 2 (scene grids are 17/33/65 samples per
// side) and size > 0.
//
// This module also owns the scene contract that the focusing chain relies on:
// terrain vertices must sit on the canonical grid, and a trajectory must be a
// continuous, short-interval, side-looking navigation record. Object kind
// vocabulary and surface class names are game-side concerns and are validated
// by the adapter, not here.
const {sar:{geometry:SAR_GEOMETRY}}=require('../shared/config.cjs');

function centerXZ(center) {
  return Array.isArray(center) ? [center[0], center[2]] : [center.x, center.z];
}

// Scene (cross, ground) -> world [x, z]. y is the caller's DEM height.
function sceneToWorld(center, bearing, cross, ground) {
  const [cx, cz] = centerXZ(center);
  const s = Math.sin(bearing), c = Math.cos(bearing);
  return [cx + cross * s + ground * c, cz - cross * c + ground * s];
}

// World (x, z) -> scene [cross, ground]; inverse of sceneToWorld.
function worldToScene(center, bearing, x, z) {
  const [cx, cz] = centerXZ(center);
  const dx = x - cx, dz = z - cz;
  const s = Math.sin(bearing), c = Math.cos(bearing);
  return [dx * s - dz * c, dx * c + dz * s];
}

// Fractional texel coordinate for a scene point. No rounding and no clamping:
// col/row are in [0, n-1] exactly at the patch edges and outside it beyond them.
function texelIndex(cross, ground, size, n) {
  const last = n - 1;
  return [(cross / size + 0.5) * last, (ground / size + 0.5) * last];
}

// Clamp a fractional texel coordinate into the sampling range.
// epsilon=0 gives [0, n-1]; PFA passes 1e-6 to keep its +1 neighbour in range.
function clampPixel(index, n, epsilon = 0) {
  const upper = Math.max(0, (n - 1) - epsilon);
  if (index < 0) return 0;
  if (index > upper) return upper;
  return index;
}

// Texel index (0..n-1) -> scene coordinate along one axis.
function pixelCenter(index, size, n) {
  return (index / (n - 1) - 0.5) * size;
}

// Canonical MAP cell (col -> +x, row -> +z) -> world [x, z].
function mapCellToWorld(x0, z0, step, col, row) {
  return [x0 + col * step, z0 + row * step];
}

// World (x, z) -> fractional MAP cell [col, row]; inverse of mapCellToWorld.
function worldToMapCell(x0, z0, step, x, z) {
  return [(x - x0) / step, (z - z0) / step];
}

// Signed angular difference in degrees between two headings or bearings,
// folded to (-180,180]. relative = heading - bearing, positive to the right of
// the ground track; the service's /designate/check, the Export's
// relative_track_deg and the sweep planner all use this one convention.
function relativeAngleDeg(heading, bearing) {
  let a = (heading - bearing) * 180 / Math.PI;
  while (a > 180) a -= 360;
  while (a <= -180) a += 360;
  return a;
}

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const finiteArray = (a, n) => Array.isArray(a) && a.length === n && a.every(v => Number.isFinite(v) && Math.abs(v) < 1e9);

// DEM height at a fractional scene coordinate, bilinear with edge clamping.
// Grids are 17/33/65 samples per side, so n >= 2 is required.
function pixel(scene, cross, ground) {
  const { n, size, terrain, bearing, center } = scene;
  const [col, row] = texelIndex(cross, ground, size, n);
  const c = clampPixel(col, n), r = clampPixel(row, n);
  const c0 = Math.min(n - 2, Math.floor(c)), r0 = Math.min(n - 2, Math.floor(r));
  const fc = c - c0, fr = r - r0;
  const y = (1 - fr) * ((1 - fc) * terrain[r0 * n + c0][1] + fc * terrain[r0 * n + c0 + 1][1])
    + fr * ((1 - fc) * terrain[(r0 + 1) * n + c0][1] + fc * terrain[(r0 + 1) * n + c0 + 1][1]);
  const [x, z] = sceneToWorld(center, bearing, cross, ground);
  return [x, y, z];
}

// Scene contract. Structure only: what a focusing run needs in order to be
// physically meaningful. Surface vocabulary and object kinds are game data and
// are validated by the adapter before a scene reaches the core.
function validate(scene) {
  if (!scene || !Array.isArray(scene.terrain) || !Array.isArray(scene.trajectory)
      || !finiteArray(scene.center, 3) || !Number.isFinite(scene.bearing)
      || !Number.isInteger(scene.n) || scene.n < 2 || !(scene.size > 0)
      || scene.terrain.length !== scene.n ** 2
      || scene.trajectory.length < SAR_GEOMETRY.trajectory_min_frames
      || scene.trajectory.length > SAR_GEOMETRY.trajectory_max_frames)
    throw Error('Invalid or incomplete scene/trajectory');
  const { n, size, bearing, center, terrain, trajectory } = scene;
  for (let i = 0; i < terrain.length; i++) {
    const p = terrain[i], cross = pixelCenter(i % n, size, n), ground = pixelCenter(Math.floor(i / n), size, n);
    const [x, z] = sceneToWorld(center, bearing, cross, ground);
    if (!finiteArray(p, 3) || Math.abs(p[0] - x) > SAR_GEOMETRY.terrain_geometry_tolerance_m
        || Math.abs(p[2] - z) > SAR_GEOMETRY.terrain_geometry_tolerance_m)
      throw Error('Invalid terrain geometry');
  }
  if (scene.surfaces !== undefined
      && (!Array.isArray(scene.surfaces) || scene.surfaces.length !== n ** 2
        || scene.surfaces.some(s => typeof s !== 'string' || s === '')))
    throw Error('Invalid surface grid');
  if (scene.objects !== undefined && !Array.isArray(scene.objects)) throw Error('Invalid object list');
  for (const o of scene.objects || []) {
    if (typeof o.kind !== 'string' || o.kind === '' || !finiteArray(o.pos, 3)
        || !Array.isArray(o.axes) || o.axes.length !== 3
        || o.axes.some(a => !Array.isArray(a) || a.length !== 3 || !a.every(Number.isFinite))
        || !Array.isArray(o.min) || !Array.isArray(o.max) || o.min.length !== 3 || o.max.length !== 3
        || o.min.some((v, i) => !Number.isFinite(v) || !Number.isFinite(o.max[i]) || o.max[i] <= v))
      throw Error('Invalid object geometry');
  }
  for (let i = 0; i < trajectory.length; i++) {
    if (!Number.isFinite(trajectory[i].t) || !finiteArray(trajectory[i].pos, 3)) throw Error('Invalid pose');
    if (i && (trajectory[i].t <= trajectory[i - 1].t || trajectory[i].t - trajectory[i - 1].t > SAR_GEOMETRY.trajectory_max_gap_s
        || distance(trajectory[i].pos, trajectory[i - 1].pos) / (trajectory[i].t - trajectory[i - 1].t) > SAR_GEOMETRY.trajectory_max_speed_mps))
      throw Error('Trajectory discontinuity or missing frames');
  }
  const duration = trajectory.at(-1).t - trajectory[0].t;
  if (duration < SAR_GEOMETRY.aperture_min_s || duration > SAR_GEOMETRY.aperture_max_s) throw Error('Insufficient aperture duration');
  if (trajectory.some(p => p.pos[1] < Math.max(...terrain.map(v => v[1])) + SAR_GEOMETRY.clearance_min_m))
    throw Error('Aircraft below patch terrain or insufficient clearance');
  return scene;
}

// Transverse aperture of a pass relative to the patch centre: the component of
// the platform displacement perpendicular to the line of sight. A straight
// radial approach has none, and no cross-range resolution to offer.
function apertureGeometry(scene) {
  const center = pixel(scene, 0, 0), mid = scene.trajectory[Math.floor(scene.trajectory.length / 2)].pos;
  const los = center.map((v, i) => v - mid[i]), slant = Math.hypot(...los);
  const path = scene.trajectory.at(-1).pos.map((v, i) => v - scene.trajectory[0].pos[i]);
  const dot = path.reduce((s, v, i) => s + v * los[i] / slant, 0);
  const effective = Math.sqrt(Math.max(0, path.reduce((s, v) => s + v * v, 0) - dot * dot));
  if (effective < SAR_GEOMETRY.min_transverse_aperture_m) throw Error('Insufficient transverse aperture; choose a side-looking patch');
  return { slant, effective };
}

module.exports = {
  sceneToWorld, worldToScene, texelIndex, clampPixel, pixelCenter, mapCellToWorld, worldToMapCell,
  relativeAngleDeg, pixel, validate, apertureGeometry
};

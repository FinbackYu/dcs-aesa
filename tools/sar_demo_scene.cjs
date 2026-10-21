'use strict';
// Synthetic demo scene: one detail footprint patch with a relief bump, collected by a
// straight 250 m/s pass at 4 km. It exists so the service can run without DCS
// (`sar_live.cjs --demo`), the probes have a deterministic input and the tests do
// not need a recording.
//
// This is a demo fixture, not part of the SAR core: the core only accepts a scene,
// and a scene's source is whatever produced it. Everything here is a project
// assumption over the canonical scene grid (src/sar_core/geometry.cjs).
const {pixelCenter, sceneToWorld} = require('../src/sar_core/geometry.cjs');
const {size_m: SIZE, n: N} = require('../src/shared/config.cjs').sar.footprints.detail;

function demoScene() {
  const bearing = Math.PI / 4, center = [20000 * Math.cos(bearing), 0, 20000 * Math.sin(bearing)];
  const scene = {source: 'synthetic-demo', n: N, size: SIZE, bearing, center, terrain: [], trajectory: []};
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const cross = pixelCenter(c, SIZE, N), ground = pixelCenter(r, SIZE, N);
    const [x, z] = sceneToWorld(center, bearing, cross, ground);
    scene.terrain.push([x, 80 + 30 * Math.exp(-((cross - 20) ** 2 + (ground + 10) ** 2) / 600), z]);
  }
  for (let n = 0; n <= 120; n++) scene.trajectory.push({t: n / 60, pos: [250 * n / 60, 4000, 0]});
  scene.center[1] = scene.terrain[Math.floor(N / 2) * N + Math.floor(N / 2)][1];
  return scene;
}

module.exports = {demoScene};

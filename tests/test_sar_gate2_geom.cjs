'use strict';
// Gate 2 canonical scene/MAP geometry (JS side + Lua 5.1 cross-check).
//
// The fixed vectors below cover the patch centre, four corners, bearings
// 0/45/90/135/180/270, odd and even texel counts, clamp boundaries and the
// four MAP corners. Grid sizes come from the generated
// tests/fixtures/config.json; the expected values are frozen in this test.
// When Lua 5.1 (luae.exe) is available the same calls are executed against
// src/sar_core/geometry.lua and every value is compared with the JS result at
// 1e-9. Missing Lua is reported as a skip, not a pass.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { findLua: findDcsLua } = require('../scripts/build_common.cjs');
const geom = require('../src/sar_core/geometry.cjs');
const CONFIG = require('../tests/fixtures/config.json');

const ROOT = path.resolve(__dirname, '..');
const LUA_MODULE = path.join(ROOT, 'src', 'sar_core', 'geometry.lua');
const TOL = 1e-9;
// Grid sizes come from the Gate 2 generated fixture, not a second copy in the test.
const DETAIL = CONFIG.config.sar.footprints.detail;
const AREA = CONFIG.config.sar.footprints.area;
const AIRPORT = CONFIG.config.sar.footprints.airport;

const SCENE_CASES = [
  { center: [1000, 500, -2000], bearing: 0, cross: 0, ground: 0, x: 1000, z: -2000 },
  { center: [1000, 500, -2000], bearing: 0, cross: 64, ground: 64, x: 1064, z: -2064 },
  { center: [1000, 500, -2000], bearing: 0, cross: -64, ground: -64, x: 936, z: -1936 },
  { center: [1000, 500, -2000], bearing: 0, cross: 64, ground: -64, x: 936, z: -2064 },
  { center: [1000, 500, -2000], bearing: 0, cross: -64, ground: 64, x: 1064, z: -1936 },
  { center: [1000, 500, -2000], bearing: Math.PI / 4, cross: 64, ground: -32, x: 1022.6274169979695, z: -2067.8822509939087 },
  { center: [1000, 500, -2000], bearing: Math.PI / 2, cross: 32, ground: 64, x: 1032, z: -1936 },
  { center: [1000, 500, -2000], bearing: 3 * Math.PI / 4, cross: -64, ground: 32, x: 932.1177490060915, z: -2022.6274169979695 },
  { center: [1000, 500, -2000], bearing: Math.PI, cross: 10, ground: 20, x: 980, z: -1990 },
  { center: [1000, 500, -2000], bearing: 3 * Math.PI / 2, cross: -10, ground: -20, x: 1010, z: -1980 },
  { center: [0, 0, 0], bearing: Math.PI / 4, cross: 64, ground: 64, x: 90.50966799187808, z: 0 },
  { center: [0, 0, 0], bearing: Math.PI / 4, cross: -64, ground: 64, x: 0, z: 90.50966799187808 },
  { center: [0, 0, 0], bearing: Math.PI / 2, cross: 64, ground: -64, x: 64, z: -64 },
  { center: [0, 0, 0], bearing: 3 * Math.PI / 4, cross: 64, ground: 64, x: 0, z: 90.50966799187808 },
  { center: [0, 0, 0], bearing: 3 * Math.PI / 4, cross: -64, ground: 64, x: -90.50966799187808, z: 0 },
];

const TEXEL_CASES = [
  { cross: 0, ground: 0, size: DETAIL.size_m, n: DETAIL.n, col: 8, row: 8 },
  { cross: -64, ground: -64, size: DETAIL.size_m, n: DETAIL.n, col: 0, row: 0 },
  { cross: 64, ground: 64, size: DETAIL.size_m, n: DETAIL.n, col: 16, row: 16 },
  { cross: 16, ground: -16, size: DETAIL.size_m, n: DETAIL.n, col: 10, row: 6 },
  { cross: 0, ground: 0, size: AREA.size_m, n: AREA.n, col: 16, row: 16 },
  { cross: 256, ground: -256, size: AREA.size_m, n: AREA.n, col: 32, row: 0 },
  { cross: 0, ground: 0, size: AIRPORT.size_m, n: AIRPORT.n, col: 32, row: 32 },
  { cross: 0, ground: 0, size: 300, n: 4, col: 1.5, row: 1.5 },
  { cross: 0, ground: 0, size: 300, n: 5, col: 2, row: 2 },
  { cross: DETAIL.size_m, ground: -DETAIL.size_m, size: DETAIL.size_m, n: DETAIL.n, col: 24, row: -8 },
];

const CLAMP_CASES = [
  { index: -0.5, n: DETAIL.n, value: 0 },
  { index: 0, n: DETAIL.n, value: 0 },
  { index: 8, n: DETAIL.n, value: 8 },
  { index: 16, n: DETAIL.n, value: 16 },
  { index: 16.5, n: DETAIL.n, value: 16 },
  { index: 16.0000005, n: DETAIL.n, value: 16 },
  { index: 16.0000005, n: DETAIL.n, epsilon: 1e-6, value: 15.999999 },
  { index: 0.0000005, n: DETAIL.n, epsilon: 1e-6, value: 0.0000005 },
  { index: 4.7, n: 4, value: 3 },
  { index: 0.5, n: 1, value: 0 },
];

const PIXEL_CENTER_CASES = [
  { index: 0, size: DETAIL.size_m, n: DETAIL.n, value: -64 },
  { index: 8, size: DETAIL.size_m, n: DETAIL.n, value: 0 },
  { index: 16, size: DETAIL.size_m, n: DETAIL.n, value: 64 },
  { index: 10, size: DETAIL.size_m, n: DETAIL.n, value: 16 },
  { index: 0, size: AREA.size_m, n: AREA.n, value: -256 },
  { index: 16, size: AREA.size_m, n: AREA.n, value: 0 },
  { index: 32, size: AIRPORT.size_m, n: AIRPORT.n, value: 0 },
  { index: 1, size: 300, n: 4, value: -50 },
  { index: 2, size: 300, n: 4, value: 50 },
  { index: 0, size: 300, n: 5, value: -150 },
  { index: 4, size: 300, n: 5, value: 150 },
];

const MAP_CASES = [
  { x0: -500, z0: -500, step: 250, col: 0, row: 0, x: -500, z: -500 },
  { x0: -500, z0: -500, step: 250, col: 4, row: 0, x: 500, z: -500 },
  { x0: -500, z0: -500, step: 250, col: 0, row: 4, x: -500, z: 500 },
  { x0: -500, z0: -500, step: 250, col: 4, row: 4, x: 500, z: 500 },
  { x0: -500, z0: -500, step: 250, col: 2, row: 2, x: 0, z: 0 },
  { x0: 1000, z0: -2000, step: 25, col: 3, row: 2, x: 1075, z: -1950 },
  { x0: 1000, z0: -2000, step: 25, col: 1.5, row: 0.5, x: 1037.5, z: -1987.5 },
  { x0: -1000, z0: 500, step: 100, col: -2, row: -3, x: -1200, z: 200 },
];

const MAP_INV_CASES = [
  { x0: -500, z0: -500, step: 250, x: 125, z: -375, col: 2.5, row: 0.5 },
  { x0: -500, z0: -500, step: 250, x: 500, z: 500, col: 4, row: 4 },
  { x0: 1000, z0: -2000, step: 25, x: 1075, z: -1950, col: 3, row: 2 },
  { x0: 1000, z0: -2000, step: 25, x: 1037.5, z: -1987.5, col: 1.5, row: 0.5 },
  { x0: -1000, z0: 500, step: 100, x: -1200, z: 200, col: -2, row: -3 },
];

function close(actual, expected, label) {
  assert.equal(typeof actual, 'number', `${label}: not a number`);
  assert.ok(Number.isFinite(actual), `${label}: ${actual} is not finite`);
  assert.ok(Math.abs(actual - expected) <= TOL,
    `${label}: ${actual} != ${expected} (|d|=${Math.abs(actual - expected)})`);
}

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function which(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  const extensions = process.platform === 'win32' ? ['', '.exe'] : [''];
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, name + extension);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

function findLua() {
  const candidates = [];
  if (process.env.AESA_LUA) candidates.push(process.env.AESA_LUA);
  if (process.env.AESA_DCS_BIN) {
    candidates.push(path.join(process.env.AESA_DCS_BIN, 'luae.exe'));
    candidates.push(path.join(process.env.AESA_DCS_BIN, 'bin', 'luae.exe'));
  }
  const dcsLua = findDcsLua();
  if (dcsLua) candidates.push(dcsLua);
  for (const name of ['lua51', 'lua5.1']) {
    const found = which(name);
    if (found) candidates.push(found);
  }
  for (const candidate of candidates) {
    if (!isFile(candidate)) continue;
    const result = spawnSync(candidate, ['-e', 'io.write(_VERSION)'],
      { encoding: 'utf8', timeout: 15000 });
    if (result.status === 0 && (result.stdout || '').trim() === 'Lua 5.1') {
      return path.resolve(candidate);
    }
  }
  return null;
}

function luaNumber(value) {
  return Object.is(value, -0) ? '0' : String(value);
}

function luaCenter(center) {
  return `{${luaNumber(center[0])},${luaNumber(center[1])},${luaNumber(center[2])}}`;
}

function luaCall(expression, expected) {
  const js = [];
  // `expected` is the fixed vector; `js` is the same call evaluated by this module.
  return { expression, expected, js };
}

function buildCalls() {
  const calls = [];
  for (const c of SCENE_CASES) {
    const [x, z] = geom.sceneToWorld(c.center, c.bearing, c.cross, c.ground);
    calls.push(luaCall(
      `g.sceneToWorld(${luaCenter(c.center)}, ${luaNumber(c.bearing)}, ${luaNumber(c.cross)}, ${luaNumber(c.ground)})`,
      [c.x, c.z]));
    calls[calls.length - 1].js = [x, z];
    calls.push(luaCall(
      `g.worldToScene(${luaCenter(c.center)}, ${luaNumber(c.bearing)}, ${luaNumber(x)}, ${luaNumber(z)})`,
      [c.cross, c.ground]));
    calls[calls.length - 1].js = geom.worldToScene(c.center, c.bearing, x, z);
  }
  for (const c of TEXEL_CASES) {
    calls.push(luaCall(
      `g.texelIndex(${luaNumber(c.cross)}, ${luaNumber(c.ground)}, ${luaNumber(c.size)}, ${c.n})`,
      [c.col, c.row]));
    calls[calls.length - 1].js = geom.texelIndex(c.cross, c.ground, c.size, c.n);
  }
  for (const c of CLAMP_CASES) {
    const expression = c.epsilon === undefined
      ? `g.clampPixel(${luaNumber(c.index)}, ${c.n})`
      : `g.clampPixel(${luaNumber(c.index)}, ${c.n}, ${luaNumber(c.epsilon)})`;
    calls.push(luaCall(expression, [c.value]));
    calls[calls.length - 1].js = [geom.clampPixel(c.index, c.n, c.epsilon)];
  }
  for (const c of PIXEL_CENTER_CASES) {
    calls.push(luaCall(
      `g.pixelCenter(${c.index}, ${luaNumber(c.size)}, ${c.n})`, [c.value]));
    calls[calls.length - 1].js = [geom.pixelCenter(c.index, c.size, c.n)];
  }
  for (const c of MAP_CASES) {
    calls.push(luaCall(
      `g.mapCellToWorld(${luaNumber(c.x0)}, ${luaNumber(c.z0)}, ${luaNumber(c.step)}, ${luaNumber(c.col)}, ${luaNumber(c.row)})`,
      [c.x, c.z]));
    calls[calls.length - 1].js = geom.mapCellToWorld(c.x0, c.z0, c.step, c.col, c.row);
  }
  for (const c of MAP_INV_CASES) {
    calls.push(luaCall(
      `g.worldToMapCell(${luaNumber(c.x0)}, ${luaNumber(c.z0)}, ${luaNumber(c.step)}, ${luaNumber(c.x)}, ${luaNumber(c.z)})`,
      [c.col, c.row]));
    calls[calls.length - 1].js = geom.worldToMapCell(c.x0, c.z0, c.step, c.x, c.z);
  }
  // Composition: texelIndex -> clampPixel -> pixelCenter -> sceneToWorld.
  for (const [size, n] of [[DETAIL.size_m, DETAIL.n], [300, 4],
    [300, 5], [AREA.size_m, AREA.n], [AIRPORT.size_m, AIRPORT.n]]) {
    for (const bearing of [0, Math.PI / 4, Math.PI / 2, 3 * Math.PI / 4]) {
      for (const cross of [-size / 2, size / 2]) {
        for (const ground of [-size / 2, size / 2]) {
          const [col, row] = geom.texelIndex(cross, ground, size, n);
          const c = geom.pixelCenter(geom.clampPixel(col, n), size, n);
          const r = geom.pixelCenter(geom.clampPixel(row, n), size, n);
          const [x, z] = geom.sceneToWorld([0, 0, 0], bearing, c, r);
          calls.push(luaCall(
            `grid({0,0,0}, ${luaNumber(bearing)}, ${luaNumber(cross)}, ${luaNumber(ground)}, ${luaNumber(size)}, ${n})`,
            [x, z]));
          calls[calls.length - 1].js = [x, z];
        }
      }
    }
  }
  return calls;
}

function runLua(lua, calls) {
  const script = [
    `local g = dofile([==[${LUA_MODULE.replace(/\\/g, '/')}]==])`,
    'if os and os.setlocale then pcall(os.setlocale, "C") end',
    'local function e(...)',
    '  local t = {...}',
    '  local o = {}',
    '  for i = 1, #t do o[i] = string.format("%.17g", t[i]) end',
    '  io.write(table.concat(o, " "), "\\n")',
    'end',
    'local function grid(center, bearing, cross, ground, size, n)',
    '  local col, row = g.texelIndex(cross, ground, size, n)',
    '  local c = g.pixelCenter(g.clampPixel(col, n), size, n)',
    '  local r = g.pixelCenter(g.clampPixel(row, n), size, n)',
    '  return g.sceneToWorld(center, bearing, c, r)',
    'end',
    ...calls.map(call => `e(${call.expression})`),
    'io.write("DONE\\n")',
    '',
  ].join('\n');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aesa-geom-'));
  try {
    const file = path.join(tmp, 'vectors.lua');
    fs.writeFileSync(file, script, 'utf8');
    const result = spawnSync(lua, [file], {
      cwd: ROOT, encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(result.status, 0,
      `luae failed:\n${result.stderr || result.stdout}`);
    const lines = (result.stdout || '').split(/\r?\n/).filter(line => line.trim());
    assert.equal(lines.at(-1), 'DONE', `luae output missing DONE:\n${result.stdout}`);
    const rows = lines.slice(0, -1).map(line => line.trim().split(/\s+/).map(Number));
    assert.equal(rows.length, calls.length, 'luae returned a different number of rows');
    for (let index = 0; index < calls.length; index++) {
      const row = rows[index];
      const call = calls[index];
      assert.equal(row.length, call.js.length,
        `call ${index} (${call.expression}) returned ${row.length} values`);
      for (let component = 0; component < row.length; component++) {
        close(row[component], call.js[component],
          `Lua/JS call ${index} component ${component}`);
        close(row[component], call.expected[component],
          `Lua/fixture call ${index} component ${component}`);
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const LUA = findLua();

test('sceneToWorld and worldToScene cover centre, corners and bearings', () => {
  for (const c of SCENE_CASES) {
    const [x, z] = geom.sceneToWorld(c.center, c.bearing, c.cross, c.ground);
    close(x, c.x, `sceneToWorld x b=${c.bearing} cross=${c.cross} ground=${c.ground}`);
    close(z, c.z, `sceneToWorld z b=${c.bearing} cross=${c.cross} ground=${c.ground}`);
    const [cross, ground] = geom.worldToScene(c.center, c.bearing, x, z);
    close(cross, c.cross, 'worldToScene cross');
    close(ground, c.ground, 'worldToScene ground');
  }
});

test('sceneToWorld accepts a named centre as well as a sequence', () => {
  const named = geom.sceneToWorld({ x: 1000, z: -2000 }, 0, 64, 64);
  const sequence = geom.sceneToWorld([1000, 500, -2000], 0, 64, 64);
  assert.deepEqual(named, sequence);
});

test('texelIndex covers odd/even n and the patch border', () => {
  for (const c of TEXEL_CASES) {
    const [col, row] = geom.texelIndex(c.cross, c.ground, c.size, c.n);
    close(col, c.col, `texelIndex col n=${c.n}`);
    close(row, c.row, `texelIndex row n=${c.n}`);
  }
});

test('clampPixel covers both edges and PFA neighbour reserve', () => {
  for (const c of CLAMP_CASES) {
    close(geom.clampPixel(c.index, c.n, c.epsilon), c.value,
      `clampPixel index=${c.index} n=${c.n} epsilon=${c.epsilon}`);
  }
});

test('pixelCenter maps index to the scene coordinate', () => {
  for (const c of PIXEL_CENTER_CASES) {
    close(geom.pixelCenter(c.index, c.size, c.n), c.value,
      `pixelCenter index=${c.index} size=${c.size} n=${c.n}`);
  }
});

test('mapCellToWorld keeps col=+x and row=+z on the four corners', () => {
  for (const c of MAP_CASES) {
    const [x, z] = geom.mapCellToWorld(c.x0, c.z0, c.step, c.col, c.row);
    close(x, c.x, `mapCellToWorld x col=${c.col} row=${c.row}`);
    close(z, c.z, `mapCellToWorld z col=${c.col} row=${c.row}`);
    const [col, row] = geom.worldToMapCell(c.x0, c.z0, c.step, x, z);
    close(col, c.col, 'worldToMapCell col');
    close(row, c.row, 'worldToMapCell row');
  }
  for (const c of MAP_INV_CASES) {
    const [col, row] = geom.worldToMapCell(c.x0, c.z0, c.step, c.x, c.z);
    close(col, c.col, 'worldToMapCell fractional col');
    close(row, c.row, 'worldToMapCell fractional row');
  }
});

test('texelIndex -> clampPixel -> pixelCenter round-trips the scene corners', () => {
  for (const [size, n] of [[DETAIL.size_m, DETAIL.n], [300, 4],
    [300, 5], [AREA.size_m, AREA.n], [AIRPORT.size_m, AIRPORT.n]]) {
    for (const bearing of [0, Math.PI / 4, Math.PI / 2, 3 * Math.PI / 4]) {
      for (const cross of [-size / 2, size / 2]) {
        for (const ground of [-size / 2, size / 2]) {
          const [col, row] = geom.texelIndex(cross, ground, size, n);
          const c = geom.pixelCenter(geom.clampPixel(col, n), size, n);
          const r = geom.pixelCenter(geom.clampPixel(row, n), size, n);
          const [x, z] = geom.sceneToWorld([0, 0, 0], bearing, c, r);
          const [directX, directZ] = geom.sceneToWorld([0, 0, 0], bearing, cross, ground);
          close(x, directX, `composition x size=${size} n=${n}`);
          close(z, directZ, `composition z size=${size} n=${n}`);
          close(col, cross === -size / 2 ? 0 : n - 1, 'corner col');
          close(row, ground === -size / 2 ? 0 : n - 1, 'corner row');
        }
      }
    }
  }
});

test('Lua 5.1 and JS return identical geometry', {
  skip: LUA ? false : 'Lua 5.1 (luae.exe) not found; set AESA_LUA or AESA_DCS_BIN',
}, () => {
  const calls = buildCalls();
  assert.ok(calls.length >= 30, 'the cross-language fixture covers all function groups');
  runLua(LUA, calls);
});

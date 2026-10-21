// T2 display geometry: exercise the actual viewer with a recording canvas.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function viewer(width = 1886, height = 1200) {
  const strokes = [];
  let points = [], dash = [];
  const ctx = new Proxy({
    beginPath() { points = []; },
    moveTo(x, y) { points.push([x, y]); },
    lineTo(x, y) { points.push([x, y]); },
    setLineDash(value) { dash = value; },
    stroke() { strokes.push({ points: [...points], dash: [...dash],
      color: ctx.strokeStyle, width: ctx.lineWidth }); },
    measureText(s) { return { width: s.length * 6 }; },
  }, { get(target, key) { return key in target ? target[key] : () => {}; } });
  const element = () => ({ style: {}, checked: false, getContext: () => ctx,
    getBoundingClientRect: () => ({ width, height }), addEventListener() {} });
  const elements = {};
  const sandbox = vm.createContext({
    document: { getElementById: id => elements[id] ||= element() },
    localStorage: { getItem() {}, setItem() {} }, devicePixelRatio: 1,
    EventSource: class {}, addEventListener() {}, requestAnimationFrame() {},
  });
  const html = fs.readFileSync(path.join(__dirname, '../tools/viewer/index.html'), 'utf8');
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], sandbox);
  return { sandbox, strokes };
}

function length(points) {
  return points.slice(1).reduce((sum, p, i) =>
    sum + Math.hypot(p[0] - points[i][0], p[1] - points[i][1]), 0);
}

for (const mode of ['scope', 'plan']) {
  test(`${mode}: near target vectors stay short at a large world range`, () => {
    const { sandbox, strokes } = viewer();
    vm.runInContext(`snap = {own: {pos: [0, 0, 0], heading_deg: 0}, tracks: [
      {id: 8, confirmed: true, iff: 'unknown', east_m: -1000, north_m: -7400,
       ve_mps: 250, vn_mps: 0, speed_ms: 250, R_km: Math.hypot(1000,7400)/1000,
       az_deg: Math.atan2(-1000,-7400)*180/Math.PI},
      {id: 1, east_m: 0, north_m: -92000, R_km: 92, az_deg: 0}
    ]}; ${mode === 'scope' ? 'drawScope(1886,1200,80)' : 'drawPlan(1886,1200)'};`, sandbox);
    const vectors = strokes.filter(s => s.color === '#ffd24a' &&
      (s.width === 1.6 || s.dash.length));
    const solid = vectors.filter(s => !s.dash.length);
    assert.ok(solid.length && vectors.some(s => s.dash.length), 'draw both vector parts');
    assert.ok(solid.reduce((sum,s) => sum + length(s.points), 0) <= 48.001,
      'solid vector must fit the screen budget');
    assert.ok(vectors.reduce((sum,s) => sum + length(s.points), 0) <= 96.001,
      'solid and forecast combined must fit the screen budget');
  });
}

function vector(tr, { plotSize = 1000, rangeM = 100000, angular = false } = {}) {
  const { sandbox } = viewer();
  sandbox.input = tr;
  return vm.runInContext(`vectorPath(input,
    ${angular ? 'p => [Math.atan2(p.east_m, -p.north_m)*1000, Math.hypot(p.east_m,p.north_m)/10]'
      : 'p => [p.east_m/100,p.north_m/100]'}, ${rangeM}, ${plotSize})`, sandbox);
}

const track = { east_m: 0, north_m: -50000, ve_mps: 0, vn_mps: 100, speed_ms: 100 };

test('ordinary vector retains 15s/60s timing and contiguous world endpoints', () => {
  const result = vector(track);
  assert.equal(result.solid_s, 15);
  assert.equal(result.end_s, 60);
  assert.deepEqual([...result.solid.at(-1)], [0, -485]);
  assert.deepEqual([...result.future[0]], [...result.solid.at(-1)]);
  assert.deepEqual([...result.future.at(-1)], [0, -440]);
});

test('small windows scale the entire projected path budget down', () => {
  const result = vector({ ...track, vn_mps: 300, speed_ms: 300 }, { plotSize: 200 });
  assert.ok(length(result.solid) <= 20.001);
  assert.ok(length(result.solid) + length(result.future) <= 40.001);
  assert.ok(result.end_s < 60);
  assert.deepEqual([...result.future[0]], [...result.solid.at(-1)]);
});

test('world range cap still shortens otherwise small screen vectors', () => {
  const result = vector(track, { rangeM: 1000 });
  assert.equal(result.solid_s, 1.5);
  assert.equal(result.end_s, 3);
});

test('close crossing never produces a screen-wide angular wrap line', () => {
  const result = vector({ ...track, east_m: 1, north_m: -30, vn_mps: 200, speed_ms: 200 },
    { angular: true });
  assert.ok(length(result.solid) <= 48.001);
  assert.ok(length(result.solid) + length(result.future) <= 96.001);
  assert.ok(result.end_s < .15, 'stop before passing the ownship');
});

test('invalid, zero, or filtered speeds do not draw a misleading vector', () => {
  for (const overrides of [{ ve_mps: NaN }, { north_m: undefined }, { vn_mps: Infinity },
    { speed_ms: 401 }, { ve_mps: 401, speed_ms: undefined },
    { ve_mps: 0, vn_mps: 0, speed_ms: 0 }]) {
    assert.equal(vector({ ...track, ...overrides }), null);
  }
});

test('missing speed scalar uses velocity components and still limits the path', () => {
  const result = vector({ ...track, vn_mps: 300, speed_ms: undefined });
  assert.ok(result);
  assert.ok(length(result.solid) + length(result.future) <= 96.001);
});

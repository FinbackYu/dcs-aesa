'use strict';
// DCS side of the SAR boundary: everything the pure core (src/sar_core) must not know.
//
// Three kinds of data live here, all of them DCS facts rather than physics:
//   * footprints — the patch geometries the Export collects (128/512/2048 m with
//     their DEM sample counts, scatter spacing and the waveform each can support);
//   * surface vocabulary — DCS's surface tokens and the native aesa_agradar class
//     mask, translated into the core's class names (the 16 classes in spec/sar.json
//     plus the five legacy tokens of terrain.GetSurfaceType);
//   * scene validation that only makes sense for a DCS scene: object kinds, box
//     sizes, axis orthonormality, the object budget.
//
// The core never sees a DCS token, a kind string or a footprint name: the adapter
// resolves them before a scene or a processing request reaches src/sar_core.
const {sar:{footprints:SAR_FOOTPRINTS,scene:SAR_SCENE}}=require('../../shared/config.cjs');
const {processingOptions}=require('../../sar_core/settings.cjs');

const FOOTPRINTS = Object.freeze(Object.fromEntries(Object.entries(SAR_FOOTPRINTS).map(([name, p]) =>
  [name, Object.freeze({size: p.size_m, n: p.n, scatterSpacing: p.scatter_spacing_m,
    ...(p.width === undefined ? {} : {width: p.width}), ...(p.bandwidth_hz === undefined ? {} : {bandwidth: p.bandwidth_hz})})])));
function footprint(name = 'detail') {
  if (!Object.hasOwn(FOOTPRINTS, name)) throw Error('Invalid SAR footprint');
  return FOOTPRINTS[name];
}
// A scene's grid is one of the collected footprints; anything else has no Export behind it.
function geometry(size, n) { return Object.values(FOOTPRINTS).some(v => v.size === size && v.n === n); }
function sceneFootprint(scene) { return Object.keys(FOOTPRINTS).find(k => FOOTPRINTS[k].size === scene.size && FOOTPRINTS[k].n === scene.n); }

// Legacy five-class tokens of terrain.GetSurfaceType (index -> core class name).
const LEGACY_SURFACES = Object.freeze({0: 'unknown', 1: 'land', 2: 'shallow_water', 3: 'water', 4: 'road', 5: 'runway'});
// Map one Export surface token to a core class. The Export sends either the numeric
// legacy index or the spelling; `sea` and `water` both mean open water.
const SURFACE_ALIASES = Object.freeze({sea: 'water', water: 'water'});
function surfaceName(token) {
  if (typeof token === 'number' || /^\d+$/.test(token)) return LEGACY_SURFACES[token] || 'unknown';
  return LEGACY_SURFACES[token] || SURFACE_ALIASES[token] || token || 'unknown';
}
// The tokens the legacy terrain probe may send: the five numeric classes and their spellings, plus
// `sea` (the Export's old word for open water). This set is derived from LEGACY_SURFACES so a new
// legacy class cannot be added in one place and forgotten in the other.
const LEGACY_SURFACE_TOKENS = new Set([
  ...Object.keys(LEGACY_SURFACES).filter(key => key !== '0'),
  ...Object.values(LEGACY_SURFACES),
  'sea',
]);
function isLegacySurfaceToken(token) { return LEGACY_SURFACE_TOKENS.has(token); }

// Object kinds a DCS scene may carry. `scenery` covers static map objects, which
// are boxes like units but are not dynamic entities.
const OBJECT_KINDS = Object.freeze(['unit', 'static', 'scenery']);

// DCS-specific scene contract, run before the core's structural validate(): object
// kinds, the object budget, box sizes and axis orthonormality. Surface class names
// are NOT re-checked here — the core accepts any non-empty class string and an
// unknown class is simply the default material.
function validateExtras(scene) {
  if (scene.surfaces !== undefined && !Array.isArray(scene.surfaces)) throw Error('Invalid surface grid');
  if (scene.objects !== undefined && (!Array.isArray(scene.objects) || scene.objects.length > SAR_SCENE.max_objects)) throw Error('Invalid object list');
  for (const o of scene.objects || []) {
    if (!OBJECT_KINDS.includes(o.kind) || !Array.isArray(o.pos) || o.pos.length !== 3 || !o.pos.every(v => Number.isFinite(v) && Math.abs(v) < SAR_SCENE.object_pos_abs_max_m)
      || !Array.isArray(o.axes) || o.axes.length !== 3 || o.axes.some(a => !Array.isArray(a) || a.length !== 3 || !a.every(Number.isFinite))
      || !Array.isArray(o.min) || !Array.isArray(o.max) || o.min.length !== 3 || o.max.length !== 3
      || o.min.some((v, i) => !Number.isFinite(v) || !Number.isFinite(o.max[i]) || o.max[i] <= v || o.max[i] - v > SAR_SCENE.object_bbox_max_m))
      throw Error('Invalid object geometry');
    for (let i = 0; i < 3; i++) {
      if (Math.abs(Math.hypot(...o.axes[i]) - 1) > SAR_SCENE.object_axis_tolerance) throw Error('Invalid object axes');
      for (let j = 0; j < i; j++) if (Math.abs(o.axes[i].reduce((s, v, k) => s + v * o.axes[j][k], 0)) > SAR_SCENE.object_axis_tolerance) throw Error('Invalid object axes');
    }
  }
}

// The core's option record with this adapter's footprint resolver already bound: callers in the
// service and the tools ask the adapter for the processing options of a request, so no caller has
// to know that a footprint is a DCS concept.
function processingOptionsFor(params, base) { return processingOptions(params, base, footprint); }

module.exports = {
  FOOTPRINTS, footprint, geometry, sceneFootprint,
  LEGACY_SURFACES, LEGACY_SURFACE_TOKENS, isLegacySurfaceToken, surfaceName,
  OBJECT_KINDS, validateExtras,
  processingOptions: processingOptionsFor
};

'use strict';
// Surface material model of the SAR core: one reflectivity coefficient per
// ground class, all relative to bare ground at normal incidence (land = 1 =
// 0 dB), plus the "most radar-significant class wins" union rule.
//
// The coefficients and both class orders come from spec/sar.json through
// src/shared/config.cjs, so the display's brightness order stays auditable:
// man-made doubles bounce (bright), vegetation scatters in a volume (slightly
// bright), open ground and beaches are a little dark, steel and asphalt are
// specular (dark), water is the darkest thing on the map. They are project
// assumptions, not calibrated radar cross sections or measurement data.
//
// Class names are the core's own vocabulary (the 16 classes the surface grid
// uses plus `unknown`). Translating a game's surface tokens into these names is
// the adapter's job (src/adapters/dcs/sar_adapter.cjs); the core never parses
// a game token.
const {SAR_MATERIALS:MATERIALS,SURFACE_CLASSES,SURFACE_PRIORITY}=require('../shared/config.cjs');
const {texelIndex,clampPixel}=require('./geometry.cjs');

// The two water classes of the legacy five-class vocabulary are outside the 16-class priority
// list: an old Export's 'water' is open water and 'shallow_water' is its shallow class, and both
// still have a material coefficient. They rank just below `sea` — open water is the darkest thing
// on the map — so a union that also holds a land class keeps the land.
const LEGACY_WATER_PRIORITY = Object.freeze(['water', 'shallow_water']);

// Collapse a class union to the single most radar-significant class. Names
// outside the vocabulary are ignored (a newer producer may add classes); an
// empty or fully unknown union is 'unknown'.
function pickSurface(names) {
  if (!Array.isArray(names) || names.length === 0) return 'unknown';
  for (const name of SURFACE_PRIORITY) if (names.includes(name)) return name;
  for (const name of LEGACY_WATER_PRIORITY) if (names.includes(name)) return name;
  return 'unknown';
}

function materialAt(scene, cross, ground) {
  if (!scene.surfaces) return 'unknown';
  const [c, r] = texelIndex(cross, ground, scene.size, scene.n);
  const col = clampPixel(Math.round(c), scene.n), row = clampPixel(Math.round(r), scene.n);
  return scene.surfaces[row * scene.n + col];
}

function materialCounts(scene) {
  return (scene.surfaces || []).reduce((a, k) => (a[k] = (a[k] || 0) + 1, a), {});
}

module.exports = { MATERIALS, SURFACE_CLASSES, SURFACE_PRIORITY, pickSurface, materialAt, materialCounts };

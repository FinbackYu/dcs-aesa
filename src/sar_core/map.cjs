'use strict';
// Real-beam ground map (MAP): the coarse base layer a SAR patch is pasted onto.
//
// This is the project's assumed surface model, not a DCS radar measurement, and it deliberately is
// not a synthetic aperture: the azimuth (cross-range) response is the physical beam, so its metric
// width grows with slant range. The DEM height and the surface class are the only inputs; everything
// else below is a project assumption:
//   * reflectivity = material coefficient x cosine of the local incidence angle (DEM normal)
//   * terrain shadowing by ray marching the DEM between the sensor and the cell
//   * the DEM is bare earth, so built-up and canopy classes carry a statistical surface relief (a DSM
//     layer, render-only): building 15 m, construction 10 m, town 8 m, trees 12 m, forest 18 m, with a
//     deterministic +-40 % jitter. That is what lets the same ray march and the same normal produce the
//     F-15E reference picture's effect — a bright cluster facing the radar with a dark band trailing it —
//     at grazing angles low enough to see it (roughly: shadow h*cot(grazing), so a low-altitude or
//     long-range look; at the patrol's usual altitude one building's shadow is sub-cell)
//   * layover: ground-range conversion g = sqrt(R^2 - H^2) maps every terrain point above the datum
//     to a bin NEARER than its true along-look offset, so a slope facing the radar folds its upper
//     returns onto the cells in front of it. Each cell shows the visible return whose ground-range
//     bin is its own, nearest slant range winning the bin; cell positions stay world-anchored, so
//     the fold shows as displaced source brightness, not displaced geometry
//   * azimuth resolution is the antenna power pattern (Gaussian main lobe, 3 dB width == beam_deg)
//     convolved over the map: a 3 deg X-band beam smears ~520 m at 10 km and ~1.6 km at 30 km
//   * multiplicative speckle, exponential per look; the ground map of the patrol is averaged over several
//     looks by default (see sar.map.service_defaults), because a single look on a 250 m display cell is
//     grain, not information. It is applied before the beam, so the far field is averaged by the wider
//     beam exactly as a real aperture averages it
//   * range spreading is 1/R^4 and STC is a display choice, not radiometry: stc:true (default) compensates
//     it completely, so the picture is the ground's own reflectivity and a uniform surface reads evenly;
//     stc:false shows the raw receiver, i.e. the same reflectivity with its 1/R^4 falloff referenced to
//     the nadir slant range
//   * the dB scale has a fixed reference — 0 dB is the brightest material coefficient at normal incidence
//     with mean speckle — so frames, patrol and DBS blocks all share one scale and a rolling mosaic shows
//     no brightness steps between frames (peak_norm:true restores the old per-frame peak normalisation,
//     and with it those steps)
//   * the frame is the aircraft's own forward sector — centred on the ownship, +-60 deg about the nose,
//     out to the requested ground range — because a real aperture has no Doppler blind cone: it looks
//     straight ahead, and the wedge (not a square, not a side-looking strip) is the shape it paints
// Not modelled: antenna sidelobes, off-boresight gain taper, volume scattering, rain,
// polarization, multipath, or any pulse-compression processing chain. The layover fold search
// reaches a bounded distance past each cell, so extreme relief can fold further than the model
// looks. The display grid (default 250 m) is finer than the azimuth resolution beyond about
// 5 km: that is oversampling of a coarse measurement, not recovered detail.
//
// Lattice windows, sector planning and job splitting are NOT here: they are collection
// scheduling (tools/sar_service/), not physics. This module owns the cache-sampling contract
// (`cache.sample`/`cache.sampleSurface`) and the render itself.
const {MAP_ENGINE_DEFAULTS, LAMBDA_M, display, sar} = require('../shared/config.cjs');
const {MATERIALS} = require('./materials.cjs');

const MAP_LIMITS = sar.map.limits;
const DEG = 180 / Math.PI, FWHM = 2 * Math.sqrt(2 * Math.log(2));
// One MAP grid for collection, rendering and display: the matrix is row-major with col -> +x and
// row -> +z, exactly the CAPTURE_MAP/MAPHEIGHT convention of the Export. Frames written before this
// layout existed are not re-rendered here; the viewer recognises them by the missing metadata field.
const GRID_LAYOUT = MAP_ENGINE_DEFAULTS.grid_layout;
const DEFAULTS = MAP_ENGINE_DEFAULTS;
const KEY_OFFSET = 2 ** 23, KEY_SIZE = 2 ** 24;
function pack(ix, iz) { return (ix + KEY_OFFSET) * KEY_SIZE + (iz + KEY_OFFSET); }
function hash(cell, seed, salt) {
  let h = (Math.imul(cell[0] | 0, 0x9e3779b1) ^ Math.imul(cell[1] | 0, 0x85ebca77) ^ seed ^ salt) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d); h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function options(input = {}) {
  const cfg = { ...DEFAULTS, ...input };
  if (!Number.isFinite(cfg.cell_m) || cfg.cell_m < MAP_LIMITS.cell_m.min || cfg.cell_m > MAP_LIMITS.cell_m.max) throw Error('Invalid map cell size');
  // The frame is the square that circumscribes a beam sector, so its size follows range/cell instead of
  // a fixed span: the floor is only "a grid that is still a map" (a 5 km sector at a 1 km cell is 7
  // cells across), and the ceiling is the frame budget the render and the mosaic are built around.
  if (!Number.isInteger(cfg.cells) || cfg.cells < MAP_LIMITS.cells.min || cfg.cells > MAP_LIMITS.cells.max) throw Error('Invalid map grid size');
  if (!Number.isFinite(cfg.beam_deg) || cfg.beam_deg < MAP_LIMITS.beam_deg.min || cfg.beam_deg > MAP_LIMITS.beam_deg.max) throw Error('Invalid map beam width');
  if (!Number.isInteger(cfg.looks) || cfg.looks < MAP_LIMITS.looks.min || cfg.looks > MAP_LIMITS.looks.max) throw Error('Invalid map look count');
  if (typeof cfg.stc !== 'boolean' || typeof cfg.shadow !== 'boolean' || typeof cfg.layover !== 'boolean') throw Error('Invalid map options');
  if (typeof cfg.peak_norm !== 'boolean') throw Error('Invalid map peak normalisation');
  if (typeof cfg.relief !== 'boolean') throw Error('Invalid map relief');
  if (!Number.isInteger(cfg.layover_margin_cells) || cfg.layover_margin_cells < MAP_LIMITS.layover_margin_cells.min || cfg.layover_margin_cells > MAP_LIMITS.layover_margin_cells.max) throw Error('Invalid map layover margin');
  if (!Number.isInteger(cfg.seed) || cfg.seed < 0 || cfg.seed > 0xffffffff) throw Error('Invalid map seed');
  if (cfg.frame !== undefined && (!Number.isInteger(cfg.frame) || cfg.frame < 0)) throw Error('Invalid map frame index');
  if (!Number.isFinite(cfg.min_slant_m) || cfg.min_slant_m < MAP_LIMITS.min_slant_m.min || cfg.min_slant_m > MAP_LIMITS.min_slant_m.max) throw Error('Invalid map minimum slant range');
  if (!Number.isFinite(cfg.kernel_sigmas) || cfg.kernel_sigmas < MAP_LIMITS.kernel_sigmas.min || cfg.kernel_sigmas > MAP_LIMITS.kernel_sigmas.max) throw Error('Invalid map kernel width');
  // Fail closed on an unknown orientation instead of guessing: a transpose or mirror here is a silently
  // wrong map, not a cosmetic difference. Only the canonical layout is produced by this engine.
  if (cfg.grid_layout !== undefined && cfg.grid_layout !== GRID_LAYOUT) throw Error('Invalid map grid layout');
  cfg.grid_layout = GRID_LAYOUT;
  // DBS options: the sharpening factor the display asked for and the platform velocity that creates the
  // Doppler gradient. A factor of 1 is a plain real-beam frame, so `dbs:{factor:1}` is legal. `patrol:true`
  // is the rolling base map itself, which is a real-beam product on the outside (mode/quality/focuser stay
  // 'map') but is sharpened inside wherever the geometry allows — the reference radar's MAP mode works the
  // same way, and only the designated one-shot block is reported as a DBS picture.
  if (cfg.dbs !== undefined && (!cfg.dbs || typeof cfg.dbs !== 'object' || !Number.isFinite(cfg.dbs.factor) || cfg.dbs.factor < MAP_LIMITS.dbs_factor_engine.min || cfg.dbs.factor > MAP_LIMITS.dbs_factor_engine.max))
    throw Error('Invalid map dbs factor');
  if (cfg.dbs !== undefined && cfg.dbs.patrol !== undefined && typeof cfg.dbs.patrol !== 'boolean') throw Error('Invalid map dbs patrol');
  if (cfg.sensorVel !== undefined && cfg.sensorVel !== null
    && (!Array.isArray(cfg.sensorVel) || cfg.sensorVel.length < 2 || !cfg.sensorVel.slice(0, 2).every(Number.isFinite)))
    throw Error('Invalid map sensor velocity');
  if (!MATERIALS[cfg.surface_default]) throw Error('Invalid map default material');
  cfg.span_m = (cfg.cells - 1) * cfg.cell_m;
  return cfg;
}
// One world-fixed lattice shared by every frame, so a rolling window only asks the Export for the
// cells that entered it. Lattice points sit on multiples of cell_m; a DEM sample is bilinear over
// the four surrounding points and renormalised over whichever of them are known.
function createCache({cell_m = MAP_ENGINE_DEFAULTS.cell_m, limit = sar.map.lattice.limit} = {}) {
  if (!Number.isFinite(cell_m) || cell_m <= 0 || cell_m > sar.map.lattice.cell_max_m) throw Error('Invalid map lattice cell');
  if (!Number.isInteger(limit) || limit < 64) throw Error('Invalid map lattice limit');
  const heights = new Map(), surfaces = new Map(); let heightCount = 0, surfaceCount = 0;
  const index = (x, z) => [Math.round(x / cell_m), Math.round(z / cell_m)];
  // A long flight keeps adding cells, so the lattice is bounded: past the limit the oldest quarter is
  // dropped (ground the aircraft has already passed) instead of growing without end.
  function trim(map, count) {
    const drop = Math.ceil(limit * .25); let removed = 0;
    for (const key of map.keys()) { map.delete(key); removed++; if (removed >= drop) break; }
    return count - removed;
  }
  function insert(map, key, value, count) {
    if (!map.has(key)) count++;
    map.set(key, value);
    return count > limit ? trim(map, count) : count;
  }
  return {
    cell_m,
    index,
    position: (ix, iz) => [ix * cell_m, iz * cell_m],
    hasHeight: (ix, iz) => heights.has(pack(ix, iz)),
    hasSurface: (ix, iz) => surfaces.has(pack(ix, iz)),
    setHeight(ix, iz, h) { if (!Number.isFinite(h)) throw Error('Invalid map height'); heightCount = insert(heights, pack(ix, iz), h, heightCount); },
    setSurface(ix, iz, name) { if (!MATERIALS[name]) throw Error('Invalid map surface class'); surfaceCount = insert(surfaces, pack(ix, iz), name, surfaceCount); },
    height: (ix, iz) => heights.get(pack(ix, iz)),
    surface: (ix, iz) => surfaces.get(pack(ix, iz)),
    // `known` is the share of the interpolation weight taken from collected cells, so a partly
    // covered edge is not silently extrapolated at full strength.
    sample(x, z) {
      const fx = x / cell_m, fz = z / cell_m, i0 = Math.floor(fx), j0 = Math.floor(fz), u = fx - i0, v = fz - j0;
      let sum = 0, weight = 0;
      for (let di = 0; di < 2; di++) for (let dj = 0; dj < 2; dj++) {
        const w = (di ? u : 1 - u) * (dj ? v : 1 - v); if (w <= 0) continue;
        const h = heights.get(pack(i0 + di, j0 + dj)); if (h === undefined) continue;
        sum += w * h; weight += w;
      }
      return {h: weight > 0 ? sum / weight : null, known: weight};
    },
    // Nearest-neighbour classification: surface classes are categories, not a field to interpolate.
    sampleSurface(x, z) { const fx = Math.round(x / cell_m), fz = Math.round(z / cell_m); return surfaces.get(pack(fx, fz)) ?? null; },
    counts: () => ({heights: heightCount, surfaces: surfaceCount}),
    clear() { heights.clear(); surfaces.clear(); heightCount = 0; surfaceCount = 0; }
  };
}
// Antenna power pattern as a normalised discrete kernel: Gaussian main lobe whose 3 dB full width
// is the beam width, evaluated on a step_m grid around the target cell.
function beamWeights(sigma_m, step_m, sigmas = MAP_ENGINE_DEFAULTS.kernel_sigmas) {
  if (!(sigma_m > 0) || !(step_m > 0) || !(sigmas > 0)) throw Error('Invalid beam kernel');
  const K = Math.max(1, Math.ceil(sigmas * sigma_m / step_m)), weights = [];
  let sum = 0;
  for (let k = -K; k <= K; k++) { const value = Math.exp(-.5 * (k * step_m / sigma_m) ** 2); weights.push(value); sum += value; }
  return {K, weights: weights.map(v => v / sum), sigma_cells: sigma_m / step_m};
}
// Metric width of the beam at a slant range: 3 dB width = R x beamwidth.
function beamSigmaM(slant_m, beam_deg) { return slant_m * (beam_deg / DEG) / FWHM; }
// Doppler beam sharpening (DBS). The azimuth response stops being the physical beam once the Doppler
// gradient across it is usable: each scatterer's radial velocity, and with it its Doppler shift, depends
// on where it sits inside the beam, so the beam can be cut into narrow Doppler slices. This is a port of
// the official DBS pass of the DCS radar shader, Bazar/shaders/enlight/radar.fx, blurRadialDBS() lines
// 138-176 (and the pass at line 279-281), which the project takes as the reference implementation:
//   * radar.fx:146-148 — lambda = 0.03 m, and the cone angle of the cell
//       teta_dopler = 2 * acos(saturate(lambda/(2V) * (2*dot(vel,vXZ)/lambda + omega/teta)) - 1e-7)
//     where vXZ is the unit ground direction from the radar to the cell and teta the beam width. With a
//     platform of speed V the bracket is dot(vel,vXZ)/V + lambda*omega/(2V*teta): the first term is the
//     cosine of the angle between the ground velocity and the line of sight, the second one ED's scan
//     term. A conical scan would sweep the beam across the ground and widen the apparent cone; this
//     project's map has no scan, so omega = 0 and the term drops out (kept in the formula below so the
//     port stays comparable line by line).
//   * radar.fx:158-165 — the taps sit on the beam arc at k*teta/K and carry the Doppler filter's own
//     response w = sin(x)/x with x = k*teta_dopler/K*resolution*0.5. Its first zero therefore sits at
//     k/K = 2*pi/(teta_dopler*resolution), i.e. the DBS cell is teta_beam/2 * 2*pi/(teta_dopler*resolution)
//     wide: the sharpening is teta_beam / (that width) = teta_dopler*resolution/pi, which grows linearly
//     with the cone angle and collapses to nothing at the nose. `resolution` is the engine's uniform
//     (radar.fx:280 passes params.y); it is how many resolution cells the beam is cut into, and this
//     project fixes it from the contract with the display: full sharpening at 45 deg of squint means
//     teta_dopler = pi/2 there, so resolution = 2*factor.
//   * radar.fx:171-173 — ED multiplies the result by step(dot(vel_hat,vXZ), cosBlankAngle), which zeroes
//     the cells outside the blank cone. On a small designated block that is the whole picture whenever the
//     block sits near the nose, so this project degrades instead of blanking: a cell whose cone angle is
//     too small to sharpen keeps the real beam (factor 1), and the frame reports how much of it did.
// One deviation is deliberate: ED convolves with the sinc weights of the Doppler filters, this project
// keeps the Gaussian of its beam model and only takes the narrowing law and the cone geometry from the
// shader, so DBS sidelobes are not modelled (the same "no sidelobes" simplification as the real beam).
const DBS_LAMBDA_M = LAMBDA_M, DBS_OMEGA = 0, DBS_FULL_CONE_DEG = 45;
function dopConeRad({velocity, sensor, x, z, beam_deg} = {}) {
  if (!Array.isArray(velocity) || velocity.length < 2 || !velocity.every(Number.isFinite)) return 0;
  const speed = Math.hypot(velocity[0], velocity[1]);
  if (!(speed > 0)) return 0;                                        // a stationary platform has no Doppler gradient at all
  const dx = x - sensor[0], dz = z - sensor[2], range = Math.hypot(dx, dz);
  if (!(range > 0)) return 0;
  const beamRad = beam_deg / DEG;
  const scan = DBS_OMEGA === 0 ? 0 : DBS_LAMBDA_M * DBS_OMEGA / (2 * speed * beamRad);   // omega = 0 here: see above
  const cosine = Math.min(1, Math.max(0, (velocity[0] * dx + velocity[1] * dz) / (speed * range) + scan));   // ED's saturate()
  return 2 * Math.acos(Math.min(1, Math.max(0, cosine)) - 1e-7);       // radar.fx:148, radians
}
// Sharpening factor of one cell from ED's cone angle: 1 (the real beam) at the nose, the requested factor
// from DBS_FULL_CONE_DEG (45 deg of squint, where the cone angle is pi/2) outwards, linear in between.
// A cone angle that cannot be evaluated sharpens nothing: a factor of 1 is the honest answer, and the
// frame's metadata then reports a real-beam picture instead of a number nobody can act on.
function dopSharpenFactor(factor, coneRad) {
  if (!Number.isFinite(coneRad) || !(coneRad > 0)) return 1;
  return Math.min(factor, Math.max(1, coneRad * 2 * factor / Math.PI));
}
// The ground velocity a DBS frame can use, or null when there is none: a missing velocity and a stationary
// aircraft are the same case physically — no Doppler gradient across the beam, so nothing to sharpen.
function dbsVelocity(cfg) {
  if (!Array.isArray(cfg.sensorVel) || cfg.sensorVel.length < 2) return null;
  const v = [cfg.sensorVel[0], cfg.sensorVel[1]];
  return v.every(Number.isFinite) && Math.hypot(v[0], v[1]) > 0 ? v : null;
}
// Multiplicative speckle, deterministic per world cell and frame. Single look is an exponential
// draw (fully developed speckle); `looks` > 1 averages independent draws (Gamma).
function speckleGain(cell, seed, frame = 0, looks = 1) {
  let sum = 0;
  for (let look = 0; look < looks; look++) sum -= Math.log(1 - hash(cell, seed, (frame >>> 0) * 131 + look * 7919));
  return sum / looks;
}
// Azimuth smearing: every cell is averaged over the cells its own beam illuminates, along the
// cross-range direction of the line of sight, with the kernel width taken from its own slant range.
// `valid` marks cells whose DEM is known: a shadowed cell is a known zero and takes part in the
// average (a real beam really does spill light into a shadow edge, and narrow shadows really are
// filled in), while an uncollected cell is unknown, is dropped, and the weights are renormalised so
// a partly collected frame is not darkened by the cells it has not collected yet.
function convolveBeam(texture, {n, cross, sigma, valid, sigmas = MAP_ENGINE_DEFAULTS.kernel_sigmas} = {}) {
  if (!Number.isInteger(n) || n < 1 || !Array.isArray(cross) || cross.length !== 2 || !sigma || !valid) throw Error('Invalid map convolution');
  const out = new Float64Array(n * n).fill(NaN), [dc, dr] = cross;
  for (let row = 0; row < n; row++) for (let col = 0; col < n; col++) {
    const index = row * n + col;
    if (!valid[index]) continue;
    const cells = sigma[index];
    if (!(cells > 0)) { out[index] = texture[index]; continue; }
    const K = Math.max(1, Math.ceil(sigmas * cells)); let sum = 0, weight = 0;
    for (let k = -K; k <= K; k++) {
      // Kernel taps are clamped to the frame: outside the sector the surface is the same one the
      // edge cell shows, while uncollected cells keep their own `valid` flag and are dropped.
      const c = Math.min(n - 1, Math.max(0, col + dc * k)), r = Math.min(n - 1, Math.max(0, row + dr * k));
      const c0 = Math.min(n - 2, Math.floor(c)), r0 = Math.min(n - 2, Math.floor(r)), fc = c - c0, fr = r - r0;
      const w = Math.exp(-.5 * (k / cells) ** 2);
      for (let dr2 = 0; dr2 < 2; dr2++) for (let dc2 = 0; dc2 < 2; dc2++) {
        const sw = (dc2 ? fc : 1 - fc) * (dr2 ? fr : 1 - fr), sample = (r0 + dr2) * n + c0 + dc2;
        if (sw <= 0 || !valid[sample]) continue;
        sum += w * sw * texture[sample]; weight += w * sw;
      }
    }
    out[index] = weight > 0 ? sum / weight : NaN;
  }
  return out;
}
// Surface relief: a DSM layer over the bare-earth DEM. DCS's terrain heights are the ground — buildings and
// canopies are objects, not elevation — so the shadow and layover machinery cannot see them at all. Each
// cell whose class is built-up or canopy gets a statistical height for the render only, and the existing
// ray march then produces what the F-15E reference picture shows: a bright cluster of returns with a dark
// trailing band. The radar-facing edge tilts the local normal toward the sensor (brighter), the far edge
// tilts away (darker), and the ground behind the cluster falls into shadow once the grazing angle is low
// enough (the shadow is h*cot(grazing), so it is a low-altitude / long-range effect, not a patrol default).
// Every value is a PROJECT ASSUMPTION calibrated on that reference picture's shadow length — not a building
// footprint and not a measured height. Classes not listed add nothing.
// The +-40 % jitter keeps a skyline from becoming one flat slab. It uses the same world-anchored hash as the
// speckle, with its own salt, so a cell's roofline is identical in every frame and the mosaic cannot shimmer.
const SURFACE_RELIEF_M = Object.freeze({building: 15, construction: 10, town: 8, trees: 12, forest: 18});
const SURFACE_RELIEF_JITTER = .4, SURFACE_RELIEF_SALT = 0x5eed;
function surfaceRelief(name, ix, iz, seed) {
  const base = SURFACE_RELIEF_M[name];
  if (!base) return 0;
  return base * (1 - SURFACE_RELIEF_JITTER + 2 * SURFACE_RELIEF_JITTER * hash([ix, iz], seed, SURFACE_RELIEF_SALT));
}
// Terrain occlusion between the sensor and one cell: the ray is walked in frame space at half-cell
// steps against the nearest DEM sample — fine enough to catch a one-cell-wide ridge crest, and
// cheap enough for a whole sector. Samples outside the collected window, or on cells whose DEM is
// unknown, are skipped rather than assumed flat.
function blocked(height, n, half, cx, cz, step, col, row, sensor) {
  // Canonical frame axes: col -> +x, row -> +z.
  const colSensor = half + (sensor[0] - cx) / step, rowSensor = half + (sensor[2] - cz) / step;
  const dcol = colSensor - col, drow = rowSensor - row, span = Math.hypot(dcol, drow);
  const count = Math.max(1, Math.ceil(span / .5)), height0 = height[row * n + col], dy = sensor[1] - height0;
  for (let k = 1; k < count; k++) {
    const t = k / count, c = Math.round(col + dcol * t), r = Math.round(row + drow * t);
    if (c < 0 || r < 0 || c >= n || r >= n) continue;
    const terrain = height[r * n + c];
    if (Number.isNaN(terrain)) continue;
    if (terrain > height0 + dy * t + .1) return true;
  }
  return false;
}
// Cosine of the incidence angle between the local surface normal and the look direction. The normal is the
// central difference of the frame's *effective* heights (bare DEM plus the class relief), not of the bare
// DEM: a roof edge has to tilt the normal, or a wall facing the radar could never read brighter than the
// flat ground beside it — that bright edge is the F-15E reference picture's cluster return. A neighbour
// outside the frame, or with unknown DEM, falls back to what the cache knows and finally to the cell's own
// height, so a frame with no relief is computed exactly as before (the cache fallback is the old path).
function incidence(height, cache, n, half, cx, cz, step, x, z, h, sensor) {
  const col = Math.round(half + (x - cx) / step), row = Math.round(half + (z - cz) / step);
  const sample = (r, c, dx, dz) => {
    if (r >= 0 && c >= 0 && r < n && c < n) { const value = height[r * n + c]; if (!Number.isNaN(value)) return value; }
    return cache.sample(x + dx, z + dz).h ?? h;
  };
  const dhdx = sample(row, col + 1, step, 0) - sample(row, col - 1, -step, 0);
  const dhdz = sample(row + 1, col, 0, step) - sample(row - 1, col, 0, -step);
  const dx = sensor[0] - x, dz = sensor[2] - z, dy = sensor[1] - h;
  const range = Math.hypot(dx, dy, dz);
  const normal = [-dhdx / (2 * step), 1, -dhdz / (2 * step)], length = Math.hypot(normal[0], normal[1], normal[2]);
  return {cosine: (normal[0] * dx + normal[1] * dy + normal[2] * dz) / (length * range), range};
}
// One walk along the look direction finds, per cell, both the occluders (shadow) and the surface
// return that lands in the cell's ground-range bin (layover fold). Ground-range conversion
// g = sqrt(R^2 - H^2) puts every terrain point above the datum datum_m into a bin nearer than its
// true along-look offset u, so a slope facing the radar folds its upper returns onto the cells in
// front of it. The walk runs in frame space at half-cell steps over the same grid blocked() uses,
// extended a bounded distance past the cell; a sample is visible unless an earlier sample subtends
// a higher elevation (a running horizon replaces the angle by its tangent, which orders the same),
// and occluded samples return nothing. stopAtShadow short-circuits once an occluder is found,
// because a shadowed cell renders black no matter which return would fold into it. Among the
// visible samples whose g falls into this cell's bin, the return whose g is nearest the bin centre
// wins — the bin physically integrates every surface at that range, and the closest ground-range
// placement is the best map-scale proxy — with the nearest slant range breaking the tie. Samples
// outside the collected window or on unknown DEM are skipped, matching blocked().
function layoverWalk(height, n, half, cx, cz, step, sensor, col, row, h, datum, marginCells, stopAtShadow) {
  // Canonical frame axes: col -> +x, row -> +z, matching blocked() and the matrix index.
  const colSensor = half + (sensor[0] - cx) / step, rowSensor = half + (sensor[2] - cz) / step;
  const dcol = colSensor - col, drow = rowSensor - row, spanCells = Math.hypot(dcol, drow);
  if (spanCells < 1) return {shadowed: false, best: null};
  const sensorY = sensor[1], H = sensorY - datum, u = spanCells * step;
  const count = Math.max(1, Math.ceil((spanCells + marginCells) / .5)), height0 = h;
  let horizon = -Infinity, shadowed = false, best = null, bestDelta = Infinity, bestR = Infinity;
  for (let k = 1; k <= count; k++) {
    const w = k * step * .5, lambda = w / u, c = Math.round(colSensor - dcol * lambda), r = Math.round(rowSensor - drow * lambda);
    if (c < 0 || r < 0 || c >= n || r >= n) continue;
    const terrain = height[r * n + c];
    if (Number.isNaN(terrain)) continue;
    if (lambda < 1 && terrain > sensorY + (height0 - sensorY) * lambda + .1) {
      shadowed = true;
      if (stopAtShadow) return {shadowed, best: null};
    }
    const slope = (terrain - sensorY) / w;
    if (slope <= horizon) continue;
    horizon = slope;
    if (H <= 0) continue;
    const dyt = sensorY - terrain, R = Math.sqrt(w * w + dyt * dyt), g = Math.sqrt(Math.max(R * R - H * H, 0)), delta = Math.abs(g - u);
    if (delta <= step * .5 && (delta < bestDelta - 1e-9 || Math.abs(delta - bestDelta) <= 1e-9 && R < bestR)) {
      bestDelta = delta; bestR = R;
      best = {x: cx + (c - half) * step, z: cz + (r - half) * step, h: terrain};
    }
  }
  return {shadowed, best};
}
// Frame render. `sensor` is the aircraft position the frame is drawn for (the newest known pose):
// shadowing, layover fold, incidence and the beam width all come from that single geometry, so a
// frame collected over several seconds is treated as one look, not as a moving aperture. The optional
// `sector` — the beam wedge the frame was collected for, `{heading,azimuth_deg,range_m}` about
// request.center — turns the square frame into a real-beam picture: cells outside the wedge are no
// data (db NaN), not dark ground. The optional `dbs:{factor}` with `sensorVel:[vx,vz]` switches the
// azimuth response from the physical beam to a Doppler-sharpened one (see dopConeRad/dopSharpenFactor
// above); without a velocity it degrades to the real beam.
function renderFrame(cache, request = {}) {
  const cfg = options(request), started = performance.now();
  const n = cfg.cells, step = cfg.cell_m, half = (n - 1) / 2, size = (n - 1) * step;
  if (!Array.isArray(request.center) || request.center.length < 2 || !Number.isFinite(request.center[0]) || !Number.isFinite(request.center[1])) throw Error('Invalid map frame center');
  if (!Array.isArray(request.sensor) || request.sensor.length !== 3 || !request.sensor.every(Number.isFinite)) throw Error('Invalid map sensor position');
  const cx = Math.round(request.center[0] / step) * step, cz = Math.round(request.center[1] / step) * step, sensor = request.sensor.slice();
  const sector = request.sector === undefined ? null : request.sector;
  const mask = sector ? sectorMask({center: [cx, cz], heading: sector.heading, azimuth_deg: sector.azimuth_deg, range_m: sector.range_m}) : null;
  // Masked cells are no data throughout the render: no height, no material, not valid, not convolved, and
  // explicitly NaN in the dB matrix at the end, so a client can tell "outside the beam" (nothing was ever
  // looked at) from "measured but dark". Without a sector the mask is empty and the frame is unchanged.
  const outside = new Uint8Array(n * n); let masked = 0;
  if (mask) for (let row = 0; row < n; row++) for (let col = 0; col < n; col++) {
    const index = row * n + col;
    if (!mask(cx + (col - half) * step, cz + (row - half) * step)) { outside[index] = 1; masked++; }
  }
  const window = frameCoverage(cache, cx, cz, n, step, half, mask);
  // DBS state for this frame: the requested factor and the platform velocity that has to be there for it
  // to mean anything. No usable velocity degrades the whole frame to the real beam (factor 1 everywhere)
  // instead of failing, and the metadata says so — a designated block that cannot be sharpened is still a
  // picture of that ground.
  const velocity = dbsVelocity(cfg);
  const dbsUse = cfg.dbs !== undefined && velocity !== null;
  const requestedFactor = cfg.dbs ? cfg.dbs.factor : 1;
  let sharpenMin = Infinity, sharpenMax = 0, sharpenSum = 0, coneMin = Infinity, coneMax = 0, conedCells = 0, forwardCells = 0;
  const height = new Float64Array(n * n).fill(NaN), material = new Array(n * n).fill(null);
  // heightSum/heightCells stay on the bare DEM: they are the datum the layover geometry and the STC
  // reference are measured from, and a rooftop is not the ground. heightMin/Max do take the lift, because
  // they only decide whether the fold path can matter — and a built-up cluster is exactly a fold source.
  let heightSum = 0, heightCells = 0, heightMin = Infinity, heightMax = -Infinity;
  let reliefCells = 0, reliefSum = 0, reliefMax = 0;
  for (let row = 0; row < n; row++) for (let col = 0; col < n; col++) {
    const index = row * n + col; if (outside[index]) continue;
    const x = cx + (col - half) * step, z = cz + (row - half) * step, sample = cache.sample(x, z);
    material[index] = cache.sampleSurface(x, z);
    if (sample.known >= 1) {
      // Render-only DSM: the lift is keyed to the world lattice point (like the speckle), so a roofline is
      // the same in every frame, and it never reaches the cache.
      const lift = cfg.relief ? surfaceRelief(material[index] ?? cfg.surface_default, Math.round(x / step), Math.round(z / step), cfg.seed) : 0;
      const effective = sample.h + lift;
      height[index] = effective; heightSum += sample.h; heightCells++;
      if (effective < heightMin) heightMin = effective; if (effective > heightMax) heightMax = effective;
      if (lift > 0) { reliefCells++; reliefSum += lift; if (lift > reliefMax) reliefMax = lift; }
    }
  }
  // valid: the DEM is known and the cell is inside the modelled slant-range window. A shadowed cell
  // stays valid (it is a known zero); only cells with no collected DEM are unknown.
  const valid = new Uint8Array(n * n), slant = new Float64Array(n * n);
  const frame = cfg.frame ?? 0, texture = new Float64Array(n * n).fill(NaN), sigma = new Float64Array(n * n);
  const datum = heightCells ? heightSum / heightCells : 0, H = sensor[1] - datum;
  // The fold can only matter when the tallest relief can displace a source by half a cell at the
  // nearest corner; flat frames keep the legacy path entirely.
  const cornerU = Math.min(
    Math.hypot(sensor[0] - (cx - half * step), sensor[2] - (cz - half * step)), Math.hypot(sensor[0] - (cx - half * step), sensor[2] - (cz + half * step)),
    Math.hypot(sensor[0] - (cx + half * step), sensor[2] - (cz - half * step)), Math.hypot(sensor[0] - (cx + half * step), sensor[2] - (cz + half * step)));
  const foldApplies = cfg.layover && H > 0 && heightCells > 0 && (heightMax - heightMin) * H > cornerU * step * .5;
  let shadowed = 0, backfacing = 0, blank = 0, unseen = 0, folded = 0;
  const ownTexture = (x, z, h) => {
    const {cosine} = incidence(height, cache, n, half, cx, cz, step, x, z, h, sensor);
    if (cosine <= 0) return null;
    return MATERIALS[cache.sampleSurface(x, z) ?? cfg.surface_default] * cosine
      * speckleGain([Math.round(x / step), Math.round(z / step)], cfg.seed, frame, cfg.looks);
  };
  for (let row = 0; row < n; row++) for (let col = 0; col < n; col++) {
    const index = row * n + col;
    // Outside the beam wedge there is nothing to render — the cell is not a shadow and not a blank
    // hole in collected ground, it was never looked at.
    if (outside[index]) continue;
    const h = height[index];
    if (Number.isNaN(h)) { blank++; continue; }
    const x = cx + (col - half) * step, z = cz + (row - half) * step;
    const range = Math.hypot(sensor[0] - x, sensor[1] - h, sensor[2] - z);
    if (range < cfg.min_slant_m) { unseen++; continue; }
    // Azimuth kernel of this cell. Without DBS it is the physical beam at the cell's own slant range; with
    // DBS the beam is cut by the Doppler gradient of *that* cell's line of sight (the shader computes the
    // cone per fragment too), so the narrowing follows the geometry across the frame instead of being one
    // number for the picture.
    let kernel = beamSigmaM(range, cfg.beam_deg) / step;
    if (dbsUse) {
      const cone = dopConeRad({velocity, sensor, x, z, beam_deg: cfg.beam_deg});
      const sharpen = dopSharpenFactor(requestedFactor, cone);
      kernel /= sharpen;
      if (sharpen < sharpenMin) sharpenMin = sharpen;
      if (sharpen > sharpenMax) sharpenMax = sharpen;
      sharpenSum += sharpen;
      if (cone < coneMin) coneMin = cone;
      if (cone > coneMax) coneMax = cone;
      if (sharpen <= 1 + 1e-9) forwardCells++;
      conedCells++;
    }
    slant[index] = range; valid[index] = 1; sigma[index] = kernel;
    if (foldApplies) {
      // The fold path re-derives shadowing during the same walk, so `blocked` stays the shadow
      // source only for the legacy (layover-off) rendering.
      const dx = x - sensor[0], dz = z - sensor[2];
      if (Math.hypot(dx, dz) >= step) {
        const {shadowed: blockedHere, best} = layoverWalk(height, n, half, cx, cz, step, sensor, col, row, h, datum, cfg.layover_margin_cells, cfg.shadow);
        if (cfg.shadow && blockedHere) { shadowed++; texture[index] = 0; continue; }
        const sameCell = best && Math.round(best.x / step) === Math.round(x / step) && Math.round(best.z / step) === Math.round(z / step);
        if (best && !sameCell) {
          const value = ownTexture(best.x, best.z, best.h);
          if (value === null) { backfacing++; texture[index] = 0; continue; }
          folded++; texture[index] = value; continue;
        }
        const value = ownTexture(x, z, h);
        if (value === null) { backfacing++; texture[index] = 0; continue; }
        texture[index] = value; continue;
      }
    }
    const {cosine} = incidence(height, cache, n, half, cx, cz, step, x, z, h, sensor);
    if (cosine <= 0) { backfacing++; texture[index] = 0; continue; }
    if (cfg.shadow && blocked(height, n, half, cx, cz, step, col, row, sensor)) { shadowed++; texture[index] = 0; continue; }
    texture[index] = MATERIALS[material[index] ?? cfg.surface_default] * cosine
      * speckleGain([Math.round(x / step), Math.round(z / step)], cfg.seed, frame, cfg.looks);
  }
  // Cross-range direction is a property of the frame (one sensor position), so the convolution runs
  // along one world direction; each cell's own slant range still sets its kernel width. `cross` is in
  // matrix units [dc,dr], where col -> +x and row -> +z, so it is the perpendicular of the ground line
  // of sight in that same basis — not the line of sight itself.
  const los = [cx - sensor[0], cz - sensor[2]], groundCenter = Math.hypot(los[0], los[1]);
  const cross = groundCenter > 0 ? [-los[1] / groundCenter, los[0] / groundCenter] : [1, 0];
  const smeared = convolveBeam(texture, {n, cross, sigma, valid, sigmas: cfg.kernel_sigmas});
  const centerRange = Math.hypot(sensor[0] - cx, sensor[1] - (heightCells ? heightSum / heightCells : 0), sensor[2] - cz);
  // Radiometry, stated once here because it is what makes neighbouring frames comparable:
  //   stc:true  (default) fully compensates the 1/R^4 range spreading, so `power` IS the ground's own
  //             reflectivity (material coefficient x cosine incidence, with the speckle of this look)
  //             and a uniform surface reads evenly at every range — that is what STC is for.
  //   stc:false is the raw receiver: the same reflectivity with its 1/R^4 spreading kept, referenced to
  //             the nadir slant range so the number has a stable meaning instead of depending on where
  //             the frame happens to sit.
  // `peak_norm` only chooses the dB reference: false (default) keeps the fixed one (0 dB = brightest
  // material at normal incidence, mean speckle), true divides by this frame's own peak as before.
  const nadirRange = Math.max(H, step);
  const power = new Float64Array(n * n); let peak = 0;
  for (let index = 0; index < n * n; index++) {
    const value = smeared[index];
    if (Number.isNaN(value)) continue;
    const cell = cfg.stc ? value : value * Math.pow(nadirRange / Math.max(slant[index], step), 4);
    power[index] = cell;
    if (cell > peak) peak = cell;
  }
  const db = Array(n * n);
  for (let index = 0; index < n * n; index++) {
    if (!cfg.peak_norm) { db[index] = Math.max(display.db.floor_db, 10 * Math.log10(Math.max(power[index], 1e-12))); continue; }
    db[index] = peak > 0 ? Math.max(display.db.floor_db, 10 * Math.log10(Math.max(power[index] / peak, 1e-12))) : display.db.floor_db;
  }
  // A masked cell is marked as no data (NaN) instead of reading as a -40 dB floor of measured ground:
  // the mosaic quantiser turns a non-finite dB into its -128 sentinel, which is what lets the client
  // draw the wedge and leave the rest of the square empty.
  if (mask) for (let index = 0; index < n * n; index++) if (outside[index]) db[index] = NaN;
  const classes = {};
  for (const name of material) if (name) classes[name] = (classes[name] || 0) + 1;
  // A designated DBS block is its own product ('dbs'); the patrol's rolling map stays a MAP product even
  // though its azimuth response is sharpened too — the page keys the base map off mode:'map', and the DBS
  // details travel in metadata.dbs either way.
  const designated = cfg.dbs ? !cfg.dbs.patrol : false;
  const factorText = `${requestedFactor}:1`;
  // DBS description: what the geometry actually delivered. `forward_cells` counts the cells whose cone
  // angle is too small to sharpen (they are drawn with the real beam — ED would have blanked them), so a
  // designated block can be a plain real-beam picture without that being hidden.
  const dbsMeta = cfg.dbs ? {
    factor: requestedFactor, velocity: velocity ? velocity.slice() : null,
    resolution_cells: 2 * requestedFactor, full_sharpen_cone_deg: DBS_FULL_CONE_DEG,
    sharpen_min: conedCells ? +sharpenMin.toFixed(3) : null, sharpen_max: conedCells ? +sharpenMax.toFixed(3) : null,
    sharpen_mean: conedCells ? +(sharpenSum / conedCells).toFixed(3) : null,
    cone_deg_min: conedCells ? +(coneMin * DEG).toFixed(1) : null, cone_deg_max: conedCells ? +(coneMax * DEG).toFixed(1) : null,
    los_angle_deg_min: conedCells ? +(coneMin * DEG / 2).toFixed(1) : null, los_angle_deg_max: conedCells ? +(coneMax * DEG / 2).toFixed(1) : null,
    cells: conedCells, forward_cells: forwardCells,
    // 退化统计：整帧、部分还是完全没锐化。正前方那些格保留实波束（ED 会把它们整块挖空），
    // 所以"拍到了但没锐化"必须能读出来，而不是看起来像一张正常的 DBS 图。
    degraded: !velocity ? 'no_velocity' : (forwardCells > 0 ? 'forward_looking' : 'none'),
    effective: !velocity || !conedCells ? 'real-beam' : (forwardCells === 0 ? 'sharpened' : (forwardCells >= conedCells ? 'real-beam' : 'partly-sharpened')),
    patrol: !!cfg.dbs.patrol,
    note: velocity ? '' : '本机地速未知：整帧退化为实波束（多普勒梯度为零，无法锐化）',
    port: 'radar.fx blurRadialDBS (Bazar/shaders/enlight/radar.fx:138-176): teta_dopler from lambda=0.03 and the ground velocity, kernel narrowed by teta_dopler*resolution/pi with resolution=2*factor; ED\'s blank cone is replaced by degradation to the real beam'
  } : undefined;
  return {
    source: 'dcs', width: n, size_m: size, db, power: Array.from(power),
    metadata: {
      mode: designated ? 'dbs' : 'map', engine: 'map-v1', quality: designated ? 'dbs' : 'map', focuser: designated ? 'doppler' : 'real-beam',
      // The dB reference the matrix is on (docs/conventions.md §7): the fixed material reference by
      // default, the frame peak when peak_norm re-normalises. Both come from spec/display.json so a
      // client, the mosaic and this render cannot disagree about what 0 dB means.
      db_ref: cfg.peak_norm ? display.db.ref_by_product.peak : display.db.ref_by_product.map,
      grid_layout: cfg.grid_layout, cell_m: step, span_m: size, cells: n, beam_deg: cfg.beam_deg, beam_sigma_deg: cfg.beam_deg / FWHM, looks: cfg.looks,
      stc: cfg.stc, peak_norm: cfg.peak_norm, shadow: cfg.shadow, layover: cfg.layover, layover_margin_cells: cfg.layover_margin_cells, seed: cfg.seed, frame, kernel_sigmas: cfg.kernel_sigmas, min_slant_m: cfg.min_slant_m,
      default_material: cfg.surface_default, image_step_m: step,
      sensor, center: [cx, cz], center_height: heightCells ? heightSum / heightCells : 0, center_slant_m: centerRange,
      sector: sector ? {
        heading_deg: +(sector.heading * DEG).toFixed(1), azimuth_deg: sector.azimuth_deg, range_m: sector.range_m,
        cells: n * n - masked, outside_cells: masked
      } : undefined,
      dbs: dbsMeta,
      // What the render actually lifted: the per-class table (project assumptions), the jitter band, and what
      // this frame got. Cells of a lift-free class never enter the count, so a clean-forest frame says 0.
      relief: {
        enabled: cfg.relief, table: {...SURFACE_RELIEF_M}, jitter: [1 - SURFACE_RELIEF_JITTER, 1 + SURFACE_RELIEF_JITTER],
        cells: reliefCells, mean_m: reliefCells ? +(reliefSum / reliefCells).toFixed(2) : 0, max_m: +reliefMax.toFixed(2)
      },
      coverage: window, shadowed_cells: shadowed, backfacing_cells: backfacing, blank_cells: blank, below_min_slant_cells: unseen, layover_cells: folded,
      layover_datum_m: cfg.layover ? datum : undefined, material_counts: classes,
      model: (cfg.dbs
        ? (cfg.dbs.patrol
          ? `assumed material coefficients x cosine incidence; DEM ray-march shadowing; ground-range fold (layover); the frame is the forward sector of a real aperture whose azimuth response is sharpened by the Doppler cone wherever the geometry allows it (Doppler beam sharpening ported from the DCS radar shader, factor ${factorText}): a cell near the nose keeps the physical beam, the rest is narrowed by its own cone angle`
          : `assumed material coefficients x cosine incidence; DEM ray-march shadowing; ground-range fold (layover); azimuth response is a Doppler-sharpened beam (Doppler beam sharpening ported from the DCS radar shader, factor ${factorText}) that falls back to the physical beam where the cone angle is too small; the frame is a small designated block`)
        : 'assumed material coefficients x cosine incidence; DEM ray-march shadowing; ground-range fold (layover): each cell shows the nearest-slant-range visible return mapped to its ground-range bin; real-beam power-pattern convolution along cross-range; the frame holds the forward sector of a real aperture, which has no Doppler blind cone at the nose')
        + (cfg.relief ? '; cell heights are the bare DEM plus a class-typical surface relief (building 15 m, construction 10 m, town 8 m, trees 12 m, forest 18 m, +-40 % world-anchored jitter) so the same shadow, incidence and layover machinery sees built-up ground; the relief is an assumption, not measured geometry' : '; no class relief (relief:false)'),
      radiometry: cfg.stc
        ? (cfg.peak_norm
          ? 'STC fully compensates the 1/R^4 range spreading, so the picture is the ground reflectivity; the dB is normalised to this frame peak (peak_norm: brightness steps between frames return)'
          : 'STC fully compensates the 1/R^4 range spreading, so the picture is the ground reflectivity; fixed dB reference, 0 dB = brightest material at normal incidence with mean speckle (frames and blocks comparable)')
        : (cfg.peak_norm
          ? 'raw received power with 1/R^4 range spreading referenced to the nadir slant range, normalised to this frame peak'
          : 'raw received power with 1/R^4 range spreading referenced to the nadir slant range; fixed dB reference, 0 dB = brightest material at normal incidence with mean speckle'),
      limitation: (cfg.dbs
        ? (cfg.dbs.patrol
          ? 'no sidelobes, no volume scattering; the sharpening is a far-field effect — inside roughly 8 km a 3 deg beam is already narrower than the 250 m display cell, so the near sector shows the physical beam and only the far field is sharpened; a cell near the nose keeps the full real beam instead of being blanked (reference shader blanks it); layover folds brightness onto world-anchored cells instead of displacing geometry; DEM outside the collected window, and every cell outside the framed sector, is unknown'
          : 'no sidelobes (the Doppler filter response of the reference shader is a sinc; this model keeps the Gaussian of the beam), no volume scattering; layover folds brightness onto world-anchored cells instead of displacing geometry; a cell near the nose keeps the full real beam instead of being blanked, so a block straight ahead is as coarse as the beam')
        : 'no sidelobes, no volume scattering; azimuth resolution is the beam, not an aperture; layover folds brightness onto world-anchored cells instead of displacing geometry, and its search reaches a bounded distance past each cell; DEM outside the collected window, and every cell outside the framed sector, is unknown')
        + (cfg.relief ? '; the relief is one statistic per class, not building geometry: one building shadow is sub-cell at 250 m (a cluster reads as a darker band only when the grazing angle is low — low altitude or long range), roofs hide one another by the +-40 % jitter, and the lift never leaves the render (the lattice keeps the bare DEM)' : ';'),
      compute_ms: performance.now() - started
    }
  };
}
// Frame coverage, read straight off the cache. The scheduled collection plan (missing
// rectangles, job splitting, nearest-first ordering) lives in tools/sar_service/.
function frameCoverage(cache, cx, cz, n, step, half, mask) {
  let known = 0, surface = 0, total = 0;
  const rect = {ix0: Math.round(cx / step - half), iz0: Math.round(cz / step - half), nx: n, nz: n};
  for (let iz = rect.iz0; iz < rect.iz0 + rect.nz; iz++) for (let ix = rect.ix0; ix < rect.ix0 + rect.nx; ix++) {
    if (mask && !mask(ix * step, iz * step)) continue;
    total++;
    if (cache.hasHeight(ix, iz)) known++;
    if (cache.hasSurface(ix, iz)) surface++;
  }
  return {cells: total, known, surface, fraction: total ? known / total : 0, surface_fraction: total ? surface / total : 0};
}
// World-coordinate test of one sector, shared by the lattice window and the frame render so both agree
// cell for cell on what is inside: within the ground range AND within the azimuth wedge around the nose.
function relativeAngleDeg(heading, bearing) {
  let a = (heading - bearing) * DEG;
  while (a > 180) a -= 360;
  while (a <= -180) a += 360;
  return a;
}
function sectorMask({center, heading, azimuth_deg, range_m} = {}) {
  if (!Array.isArray(center) || center.length < 2 || !Number.isFinite(center[0]) || !Number.isFinite(center[1])) throw Error('Invalid map sector centre');
  if (!Number.isFinite(heading)) throw Error('Invalid map sector heading');
  if (!Number.isFinite(azimuth_deg) || azimuth_deg <= 0 || azimuth_deg > 180) throw Error('Invalid map sector azimuth');
  if (!Number.isFinite(range_m) || range_m <= 0) throw Error('Invalid map sector range');
  const cx = center[0], cz = center[1], limit = range_m * range_m;
  return (x, z) => {
    const dx = x - cx, dz = z - cz;
    if (dx * dx + dz * dz > limit) return false;
    return Math.abs(relativeAngleDeg(heading, Math.atan2(dx, dz))) <= azimuth_deg;
  };
}
// Scene anchor of a completed frame: the patch centre the SAR collector will be asked for,
// with the frame's own centre height so the collect request is consistent with the render.
function anchor(result) {
  if (!result || !result.metadata || !['map', 'dbs'].includes(result.metadata.mode)) throw Error('Not a map result');
  const {center, center_height: height} = result.metadata;
  return {source: 'dcs', center: [center[0], height, center[1]], bearing: 0, size: result.size_m, footprint: result.metadata.mode};
}
module.exports = {
  DEFAULTS, GRID_LAYOUT, options, createCache, beamWeights, beamSigmaM, dopConeRad, dopSharpenFactor,
  dbsVelocity, speckleGain, convolveBeam, renderFrame, anchor, sectorMask, relativeAngleDeg
};

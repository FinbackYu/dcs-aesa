'use strict';
// Lattice windows and collection planning of the SAR service: which square of the
// world a frame covers, which of its cells the beam actually looks at, which of
// those are still missing, and how the missing ground is split into Export jobs.
//
// These are service concerns, not physics: the core's map.cjs renders a frame from
// whatever lattice it is handed, and draws the beam mask with the same sectorMask
// this file uses to enumerate cells, so a frame and its plan agree cell for cell.
const {MAP_ENGINE_DEFAULTS, sar} = require('../../src/shared/config.cjs');
const {sectorMask} = require('../../src/sar_core/map.cjs');
const MAP_LIMITS = sar.map.limits, MAP_SERVICE_DEFAULTS = sar.map.service_defaults;

const rectCells = rect => rect.nx * rect.nz;
// Lattice window of a map frame. The frame uses the canonical MAP grid: columns run along +x and rows
// along +z (index = row*n+col), so the window is an axis-aligned slice of the world-fixed lattice and
// consecutive frames share every cell they have in common. This is the plain square slice; the shape
// the map actually images is the forward sector of windowSector().
function windowRect({center, cell_m = MAP_ENGINE_DEFAULTS.cell_m, cells = MAP_ENGINE_DEFAULTS.cells} = {}) {
  if (!Array.isArray(center) || center.length < 2 || !Number.isFinite(center[0]) || !Number.isFinite(center[1])) throw Error('Invalid map window center');
  if (!Number.isInteger(cells) || cells < 1 || cells > MAP_LIMITS.sector_cells_max) throw Error('Invalid map window size');
  const ix = Math.round(center[0] / cell_m), iz = Math.round(center[1] / cell_m), half = (cells - 1) / 2;
  return {ix0: Math.round(ix - half), iz0: Math.round(iz - half), nx: cells, nz: cells, center: [ix * cell_m, iz * cell_m]};
}
// The map window is a forward sector, not a square. A real aperture has no Doppler blind cone, so the
// nose is exactly where it can look, and the physical beam's metric width grows with range on both
// sides of it — a rolling square window would show a shape and a look direction the radar does not
// have. What the mosaic needs is still a north-up square cell grid, so windowSector() returns the
// square that circumscribes the wedge plus the predicate that says which of its cells the beam
// actually illuminated: everything outside that wedge is no data, not dark ground.
const SECTOR_MAX_CELLS = MAP_LIMITS.sector_cells_max, ALWAYS_INSIDE = () => true;
// Side of the square frame that circumscribes the wedge; the wedge's furthest point is range_m along
// the nose, so ceil(range/cell) cells of half-width hold every cell the sector can reach at any
// azimuth. The frame budget is the hard limit — a finer cell or a longer range has to be answered with
// a coarser request rather than by rendering a frame the mosaic and the client cannot carry.
function sectorGrid({range_m, cell_m = MAP_ENGINE_DEFAULTS.cell_m} = {}) {
  if (!Number.isFinite(range_m) || range_m <= 0) throw Error('Invalid map sector range');
  if (!Number.isFinite(cell_m) || cell_m <= 0) throw Error('Invalid map window cell');
  const cells = 2 * Math.ceil(range_m / cell_m) + 1;
  if (cells > SECTOR_MAX_CELLS) throw Error(`Map sector grid ${cells} exceeds the ${SECTOR_MAX_CELLS}-cell frame limit: use a coarser cell or a shorter range`);
  return cells;
}
function windowSector({center, heading, azimuth_deg = MAP_SERVICE_DEFAULTS.azimuth_deg, range_m = MAP_SERVICE_DEFAULTS.range_m, cell_m = MAP_SERVICE_DEFAULTS.cell_m} = {}) {
  const cells = sectorGrid({range_m, cell_m});
  const rect = windowRect({center, cell_m, cells});
  // The wedge is centred on the lattice point nearest the aircraft, which is also the frame centre the
  // renderer is handed, so apex and grid stay on the same lattice point and a cell is inside or outside
  // for both of them.
  const mask = sectorMask({center: rect.center, heading, azimuth_deg, range_m});
  return {...rect, heading, azimuth_deg, range_m, mask, predicate: (ix, iz) => mask(ix * cell_m, iz * cell_m)};
}
// A window may carry its own predicate (windowSector does), so a caller that took its window from there
// does not have to repeat the filter — and cannot pass it in one place while forgetting it in another.
function insideTest(rect, predicate) {
  return typeof predicate === 'function' ? predicate : typeof rect?.predicate === 'function' ? rect.predicate : ALWAYS_INSIDE;
}
function coverage(cache, rect, predicate) {
  const inside = insideTest(rect, predicate);
  let known = 0, surface = 0, total = 0;
  for (let iz = rect.iz0; iz < rect.iz0 + rect.nz; iz++) for (let ix = rect.ix0; ix < rect.ix0 + rect.nx; ix++) {
    if (!inside(ix, iz)) continue;
    total++;
    if (cache.hasHeight(ix, iz)) known++;
    if (cache.hasSurface(ix, iz)) surface++;
  }
  return {cells: total, known, surface, fraction: total ? known / total : 0, surface_fraction: total ? surface / total : 0};
}
// Missing cells of a window as disjoint rectangles: maximal runs per row, merged downwards while
// the run keeps the same column span. A window that only moved a little therefore costs a few
// rectangles instead of re-querying the whole sector. With a sector predicate a run is a line of cells
// the beam really looks at, so a merged rectangle still holds only cells inside the wedge (every row
// contributed exactly that span), and a wedge costs a few small rectangles per row instead of one big
// block: the ground outside the beam is never asked for.
function missingRects(cache, rect, predicate) {
  const inside = insideTest(rect, predicate);
  const out = []; let open = new Map();
  for (let iz = rect.iz0; iz < rect.iz0 + rect.nz; iz++) {
    const runs = [], next = new Map(); let start = null;
    for (let ix = rect.ix0; ix < rect.ix0 + rect.nx; ix++) {
      const wanted = inside(ix, iz) && !cache.hasHeight(ix, iz);
      if (wanted) { if (start === null) start = ix; }
      else if (start !== null) { runs.push([start, ix - 1]); start = null; }
    }
    if (start !== null) runs.push([start, rect.ix0 + rect.nx - 1]);
    for (const [ix0, ix1] of runs) {
      const key = `${ix0},${ix1}`, current = open.get(key);
      if (current) { current.iz1 = iz; next.set(key, current); }
      else { const made = {ix0, iz0: iz, iz1: iz, ix1}; next.set(key, made); out.push(made); }
    }
    open = next;
  }
  return out.map(({ix0, iz0, ix1, iz1}) => ({ix0, iz0, nx: ix1 - ix0 + 1, nz: iz1 - iz0 + 1}));
}
// Split along the longer side, because a job is capped in both the cell count and each dimension
// (max_dim: the Export delivers at most that many rows or columns per request). Splitting only the
// columns left a tall window — a sector frame is as tall as it is wide — with rows the Export refuses
// without a word, so the request would simply never start.
function splitJob(rect, maxCells, maxDim = Infinity) {
  if (rectCells(rect) <= maxCells && rect.nx <= maxDim && rect.nz <= maxDim) return [rect];
  if (rect.nx >= rect.nz && rect.nx > 1) {
    const half = Math.floor(rect.nx / 2);
    return [...splitJob({...rect, nx: half}, maxCells, maxDim), ...splitJob({...rect, ix0: rect.ix0 + half, nx: rect.nx - half}, maxCells, maxDim)];
  }
  if (rect.nz > 1) {
    const half = Math.floor(rect.nz / 2);
    return [...splitJob({...rect, nz: half}, maxCells, maxDim), ...splitJob({...rect, iz0: rect.iz0 + half, nz: rect.nz - half}, maxCells, maxDim)];
  }
  return [rect];
}
// Collection plan for one window: the disjoint rectangles still missing, split under the per-job
// cell budget and ordered nearest-to-sensor first, so a partial first pass already covers the
// ground closest to the aircraft instead of an arbitrary corner of the sector. The coverage it
// reports is the sector's own coverage, so "fraction 1" means the beam's ground is collected, not
// the square that happens to circumscribe it.
function planJobs(cache, rect, {cell_m = MAP_ENGINE_DEFAULTS.cell_m, max_cells = MAP_LIMITS.job_cells_max, sensor = null, predicate, max_dim = Infinity} = {}) {
  const inside = insideTest(rect, predicate), jobs = [];
  for (const piece of missingRects(cache, rect, inside)) for (const part of splitJob(piece, max_cells, max_dim))
    jobs.push({ix0: part.ix0, iz0: part.iz0, nx: part.nx, nz: part.nz, x0: part.ix0 * cell_m, z0: part.iz0 * cell_m,
      cols: part.nx, rows: part.nz, cells: rectCells(part)});
  if (Array.isArray(sensor) && sensor.length >= 3 && Number.isFinite(sensor[0]) && Number.isFinite(sensor[2])) {
    const gap = job => {
      const far = job.x0 + (job.cols - 1) * cell_m, farz = job.z0 + (job.rows - 1) * cell_m;
      const dx = Math.max(0, Math.max(job.x0 - sensor[0], sensor[0] - far)), dz = Math.max(0, Math.max(job.z0 - sensor[2], sensor[2] - farz));
      return Math.hypot(dx, dz);
    };
    jobs.sort((a, b) => gap(a) - gap(b));
  }
  return {jobs, ...coverage(cache, rect, inside)};
}

module.exports = {windowRect, rectCells, sectorGrid, windowSector, coverage, missingRects, splitJob, planJobs, sectorMask, SECTOR_MAX_CELLS};

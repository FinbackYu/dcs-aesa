'use strict';
// Completed images kept for the geo-anchored mosaic view. /state carries summaries only (it is
// polled every 700 ms); each matrix is fetched once through /image/<seq>, in a 0.25 dB quantised
// Int8 copy, because the mosaic is a display layer — /snapshot keeps the full-resolution image.
//
// Every entry carries the dB reference of its own matrix (`db_ref`), because a SAR patch is
// normalised to its frame peak while a MAP/DBS frame is on a fixed material reference: a client
// that compares brightness across entries without reading this field is comparing two scales.
const {PROTOCOL, display, sar} = require('../../src/shared/config.cjs');

const MOSAIC_LIMIT = PROTOCOL.mosaic.limit;
// The references a display matrix may declare. A producer picks one through spec/display.json's
// ref_by_product; an entry outside this list has no defined scale and is not retained.
const DISPLAY_DB_REFS = Object.freeze(display.db.refs.slice());
const SAR_DB_REF = sar.render.db_ref;

class MosaicStore {
  constructor({limit = MOSAIC_LIMIT} = {}) {
    // Sequence numbers restart at 1 with each service run; the generation tells a polling client
    // that its cached seqs belong to a previous run and must be dropped.
    this.generation = Date.now();
    this.limit = Math.max(1, Number.isSafeInteger(limit) ? limit : MOSAIC_LIMIT);
    this.entries = [];
    this.nextSeq = 1;
    this.dropped = 0;
    // The sequence number of the newest SAR patch. It is what /state's resultSeq names: the current
    // display image is one retained entry, so a client pulls the same body whether it came from the
    // mosaic or from the display slot (D3, docs/conventions.md §8.5).
    this.resultSeq = null;
  }
  // Every completed image with a world anchor joins the mosaic; the oldest is dropped past the limit.
  keep(scene, result, record, at) {
    const anchor = worldAnchor(scene);
    if (!anchor || !result || !Array.isArray(result.db) || result.db.length !== result.width * result.width) return null;
    // A restored snapshot written before db_ref existed is still a SAR engine result: it is on the
    // SAR reference, which is the only scale the engine has ever produced. A matrix that names a
    // reference outside the display contract is refused instead of being relabelled.
    const dbRef = result.metadata?.db_ref ?? (result.metadata?.mode === undefined || result.metadata.mode === 'sar' ? SAR_DB_REF : undefined);
    const entry = {
      seq: this.nextSeq++, completed: at || Date.now(), source: result.source, record: record || null,
      width: result.width, size_m: result.size_m, bearing: anchor.bearing, center: anchor.center,
      footprint: scene.footprint || null, target: scene.target || null,
      quality: result.metadata?.quality ?? null, focuser: result.metadata?.focuser ?? null,
      scene_model: result.metadata?.scene_model ?? null, image_step_m: result.metadata?.image_step_m ?? null,
      mode: result.metadata?.mode ?? 'sar',
      // The dB reference of this matrix, copied from the result that produced it. A result without one
      // is refused rather than silently labelled: cross-entry brightness would have no basis.
      db_ref: dbRef,
      // MAP tiles carry their canonical grid (col -> +x, row -> +z) so the viewer never has to guess
      // an orientation. SAR patch entries leave it null and keep their scene cross/ground grid.
      grid_layout: result.metadata?.grid_layout ?? null,
      // A map tile carries its own beam wedge and a DBS tile its sharpening: the mosaic entry has to stay
      // self-describing after the aircraft turns away, because that wedge is what the -128 cells in its
      // matrix mean and the factor is what the readout calls it.
      sector: result.metadata?.sector ?? null,
      dbs: result.metadata?.dbs ?? null,
      compute_ms: Math.round(result.metadata?.compute_ms || 0),
      // 0.25 dB steps, clamped at the -127 floor with +12 dB of headroom above the fixed 0 dB
      // reference, so the brightest few dB (speckle peaks, specular folds) are not flattened to one
      // white; a non-finite dB (a map frame's cell outside its beam sector) keeps the -128 sentinel,
      // which no measurement can produce, so "no data" is decodable from "measured but dark" without
      // a second matrix.
      db: Int8Array.from(result.db, value => Number.isFinite(value)
        ? Math.max(PROTOCOL.db.clamp_min, Math.min(PROTOCOL.db.clamp_max, Math.round(value / PROTOCOL.db.step)))
        : PROTOCOL.db.no_data)
    };
    if (!DISPLAY_DB_REFS.includes(entry.db_ref)) throw Error('Image result carries no valid dB reference');
    this.entries.push(entry);
    // The SAR patch is the display image: its sequence is the one /state.resultSeq names.
    if (entry.mode === 'sar') this.resultSeq = entry.seq;
    while (this.entries.length > this.limit) {
      const evicted = this.entries.shift(); this.dropped++;
      if (evicted.seq === this.resultSeq) this.resultSeq = null;
    }
    return entry;
  }
  // The sequence of the newest SAR patch, or null when none was retained (a MAP-only session, or a
  // patch that has already been evicted by the mosaic limit).
  latestResultSeq() { return this.resultSeq; }
  find(seq) { return Number.isSafeInteger(seq) ? this.entries.find(entry => entry.seq === seq) || null : null; }
  // The summary a poll carries: everything but the matrix.
  static summary(entry) { if (!entry) return null; const {db, ...rest} = entry; return rest; }
  // An entry that a SAR tile must not be replaced by: a MAP frame's square claims ground its beam never
  // looked at, so it can never stand in for an imaged patch (see the sweep planner's coverage rule).
  covered(center, size_m) {
    return this.entries.some(entry => entry.mode !== 'map' && entry.size_m >= size_m
      && Math.hypot(entry.center[0] - center[0], entry.center[2] - center[2]) <= entry.size_m * Math.SQRT1_2);
  }
  // /state's mosaic section. `since` turns the poll into an incremental one (only newer summaries).
  state({ since = null } = {}) {
    const incremental = Number.isSafeInteger(since) && since >= 0;
    return {
      generation: this.generation, limit: this.limit, count: this.entries.length, dropped: this.dropped,
      firstSeq: this.entries.length ? this.entries[0].seq : this.nextSeq, latestSeq: this.nextSeq - 1,
      dB_step: PROTOCOL.mosaic.db_step, incremental,
      entries: (incremental ? this.entries.filter(entry => entry.seq > since) : this.entries).map(MosaicStore.summary)
    };
  }
}

// A completed image joins the mosaic only if it knows where it belongs in the world.
function worldAnchor(scene) {
  return scene && Number.isFinite(scene.bearing) && Array.isArray(scene.center)
    ? {center: [scene.center[0], scene.center[1], scene.center[2]], bearing: scene.bearing, size_m: scene.size} : null;
}

module.exports = {MosaicStore, worldAnchor, MOSAIC_LIMIT};

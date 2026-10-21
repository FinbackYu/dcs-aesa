'use strict';
// Raw capture recorder: writes each collected scene to its own JSON file so a flight can be
// replayed and reprocessed without DCS (tools/replay.py, tests, sar_live --replay).
//
// A recording is the input of a result, not a cache: the file is created with O_EXCL so a
// name collision is an error instead of an overwrite, and the service never deletes one.
const fs = require('node:fs'), path = require('node:path');

class Recorder {
  constructor(directory) { this.directory = directory; }
  // Returns the basename of the written file (what /state.record carries), or null when the
  // caller asked for no recording.
  save(scene) {
    fs.mkdirSync(this.directory, {recursive: true});
    const file = path.join(this.directory, `sar-${Date.now()}-${scene.id}.json`);
    fs.writeFileSync(file, JSON.stringify(scene), {flag: 'wx'});
    return path.basename(file);
  }
}

module.exports = {Recorder};

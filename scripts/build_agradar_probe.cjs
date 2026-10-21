'use strict';
// Build the AESA AGR native probe DLL with the workspace-local mingw toolchain.
// Gate 6: gcc/flags/PE guards live in build_common.cjs.
// Toolchain bootstrap: python scripts/bootstrap_mingw.py (repo .tools, gitignored).
const path = require('node:path');
const common = require('./build_common.cjs');

const ROOT = common.ROOT;
const SOURCE = path.join(ROOT, 'src', 'native', 'agradar_probe', 'aesa_agradar.c');
const OUTPUT = path.join(ROOT, 'dist', 'dev', 'aesa_agradar.dll');
const REQUIRED = [
  'aesa_agradar_init', 'aesa_agradar_poll', 'aesa_agradar_shutdown',
  'aesa_agradar_version', 'aesa_agradar_surface_names',
  'aesa_agradar_surface_mask',
];

function build() {
  return common.compile({ output: OUTPUT, sources: [SOURCE], required: REQUIRED });
}

module.exports = { build, OUTPUT, SOURCE, REQUIRED };
if (require.main === module) {
  try {
    console.log('built: ' + build());
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

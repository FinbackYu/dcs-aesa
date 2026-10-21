'use strict';
// Build the AESA fire-control native components with the workspace-local
// mingw toolchain. Gate 6 (D4): one C source, two DLLs:
//   aesa_fc_trace.dll  — read-only trace (no write exports at all)
//   aesa_fc_inject.dll — trace superset plus arm/disarm/feed_target
// Only one of them may be loaded into DCS at a time (both install MinHook).
// Toolchain bootstrap: python scripts/bootstrap_mingw.py (repo .tools, gitignored).
const path = require('node:path');
const common = require('./build_common.cjs');

const ROOT = common.ROOT;
const SOURCE = path.join(ROOT, 'src', 'native', 'fc_probe', 'aesa_fc.c');
const OUTDIR = path.join(ROOT, 'dist', 'dev');
const TRACE = path.join(OUTDIR, 'aesa_fc_trace.dll');
const INJECT = path.join(OUTDIR, 'aesa_fc_inject.dll');

const TRACE_REQUIRED = [
  'aesa_fc_init', 'aesa_fc_poll', 'aesa_fc_shutdown', 'aesa_fc_version',
  'aesa_fc_trace_start', 'aesa_fc_trace_stop', 'aesa_fc_readable',
];
const WRITE_EXPORTS = ['aesa_fc_arm', 'aesa_fc_disarm', 'aesa_fc_feed_target'];
const INJECT_REQUIRED = [...TRACE_REQUIRED, ...WRITE_EXPORTS];

function sources() {
  return [SOURCE, ...common.minhookSources()];
}

function buildTrace() {
  return common.compile({
    output: TRACE,
    sources: sources(),
    defines: ['AESA_FC_TRACE_ONLY'],
    required: TRACE_REQUIRED,
    forbidden: WRITE_EXPORTS,
  });
}

function buildInject() {
  return common.compile({
    output: INJECT,
    sources: sources(),
    required: INJECT_REQUIRED,
  });
}

function build() {
  return [buildTrace(), buildInject()];
}

module.exports = {
  build, buildTrace, buildInject,
  TRACE, INJECT, TRACE_REQUIRED, INJECT_REQUIRED, WRITE_EXPORTS, SOURCE,
};
if (require.main === module) {
  try {
    for (const output of build()) console.log('built: ' + output);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

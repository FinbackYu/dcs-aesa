'use strict';
// CLI and composition root of the SAR service.
//
// The service is assembled in tools/sar_service/: collector.cjs owns the Export wire protocol,
// service.cjs wires the sessions, the mosaic and the HTTP API together, and the physics lives in
// src/sar_core/. This file only parses the command line, builds the initial scene and keeps the
// process alive; it re-exports the two entry points the tests and the probes import.
//
//   node tools/sar_live.cjs [--demo | --replay scene.json] [--quality standard|fine|fast]
//     [--focuser backprojection|pfa] [--window hann|rect] [--scene-model uniform|classified]
//     [--restore-display snapshot.json] [--http-port N] [--tcp-port N] [--scene-port N]
const fs = require('node:fs');
const {validate} = require('../src/sar_core/geometry.cjs');
const {settings} = require('../src/sar_core/settings.cjs');
const {processingOptions} = require('../src/adapters/dcs/sar_adapter.cjs');
const {demoScene} = require('./sar_demo_scene.cjs');
const {Collector} = require('./sar_service/collector.cjs');
const {createService} = require('./sar_service/service.cjs');

const PORT_FLAGS = {'--http-port': 'httpPort', '--tcp-port': 'tcpPort', '--scene-port': 'scenePort'};
const USAGE = 'Usage: sar_live.cjs [--demo | --replay scene.json] [--quality standard|fine|fast] '
  + '[--focuser backprojection|pfa] [--restore-display snapshot.json] [--window hann|rect] '
  + '[--scene-model uniform|classified] [--http-port N] [--tcp-port N] [--scene-port N]';

function parseArgs(argv) {
  const args = argv.slice(), ports = {}, processing = {window: 'hann'};
  let mode = 'live', scene = null, display = null;
  while (args.length) {
    const key = args.shift();
    // The first scene source wins; a second --demo/--replay is a usage error rather than a silent
    // overwrite of the scene the service would compute.
    if (key === '--demo' && mode === 'live') { mode = 'demo'; scene = demoScene(); }
    else if (key === '--replay' && mode === 'live' && args.length) { mode = 'replay'; scene = JSON.parse(fs.readFileSync(args.shift(), 'utf8')); validate(scene); }
    else if (key === '--window' && args.length) { processing.window = args.shift(); settings(processing); }
    // A quality profile carries a waveform (bandwidth, width, oversampling); asking for one is a
    // request, so the resolved record keeps both the applied and the requested profile.
    else if (key === '--quality' && args.length) { const quality = args.shift(); Object.assign(processing, processingOptions({quality}, processing), {quality}); }
    else if (key === '--restore-display' && args.length) display = JSON.parse(fs.readFileSync(args.shift(), 'utf8'));
    else if (key === '--scene-model' && args.length) { processing.sceneModel = args.shift(); settings(processing); }
    else if (key === '--focuser' && args.length) { processing.focuser = args.shift(); settings(processing); }
    else if (Object.hasOwn(PORT_FLAGS, key) && args.length) {
      const value = Number(args.shift());
      if (!Number.isInteger(value) || value < 0 || value > 65535) throw Error('Invalid port');
      ports[PORT_FLAGS[key]] = value;
    } else throw Error(USAGE);
  }
  return {mode, scene, display, processing, ports};
}

function main(argv = process.argv.slice(2)) {
  let options;
  try { options = parseArgs(argv); } catch (e) { console.error(e.message); process.exit(2); }
  const {mode, scene, display, processing, ports} = options;
  const service = createService({mode, scene, display, processing, ...ports});
  service.started.then(p => console.log(`SAR ${mode}: http://127.0.0.1:${p.httpPort} (Export TCP ${p.tcpPort}, scene Hook TCP ${p.scenePort})`))
    .catch(async e => { console.error(e.message); await service.close(); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => service.close().then(() => process.exit()));
  return service;
}

module.exports = {Collector, createService, parseArgs, main};
if (require.main === module) main();

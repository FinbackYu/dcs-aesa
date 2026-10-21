'use strict';
// C0 development bridge stub: write a tiny AESA state file at 10 Hz so the
// cockpit controller can be verified before the real receiver publishes it.
// Usage:
//   node tools/cockpit_bridge_stub.cjs --saved-games "<Saved Games/DCS>"
//   node tools/cockpit_bridge_stub.cjs --saved-games ... --duration 30
const fs = require('node:fs');
const path = require('node:path');

function arg(name, fallback) {
  const args = process.argv.slice(2);
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const saved = path.resolve(arg('--saved-games', path.join(process.env.USERPROFILE || '', 'Saved Games', 'DCS')));
const dir = path.join(saved, 'Scripts', 'AESA-COCKPIT');
const state = path.join(dir, 'state.txt');
const duration = Number(arg('--duration', '0'));
fs.mkdirSync(dir, { recursive: true });

let seq = 0;
let stopped = false;
const started = Date.now();
function tick() {
  if (stopped) return;
  seq++;
  const text = `AESA1\nseq=${seq}\nvalid=1\nt=${((Date.now() - started) / 1000).toFixed(1)}\n`;
  const temp = state + '.tmp-' + process.pid;
  try {
    fs.writeFileSync(temp, text);
    fs.renameSync(temp, state);
  } catch (error) {
    console.error('bridge write failed:', error.message);
    process.exitCode = 1;
    stopped = true;
    return;
  }
  if (duration > 0 && Date.now() - started >= duration * 1000) {
    stopped = true;
    console.log(`wrote ${seq} frames to ${state}`);
    process.exit(0);
  }
}
const timer = setInterval(tick, 100);
tick();
process.on('SIGINT', () => {
  stopped = true;
  clearInterval(timer);
  console.log(`stopped after ${seq} frames`);
  process.exit(0);
});

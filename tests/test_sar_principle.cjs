'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { C_MPS, SAR_PROFILES } = require('../src/shared/config.cjs');
const { synthesize, focus, profile, fwhm } = require('../scripts/sar_principle_probe.cjs');
const baseline = synthesize([{cross: 0, ground: 0}]);

// SAR-specific physical checks; exploratory chain is outside current T1–T10 A/A tests.
test('point response peaks at the true location', () => {
  for (const axis of ['cross','ground']) {
    const samples = profile(baseline,axis);
    const peak = samples.reduce((a,b) => a.power>b.power ? a : b);
    assert.ok(Math.abs(peak.offset)<.021);
  }
  assert.ok(focus(baseline,0,0)>.999);
});

test('rectangular-band ground response matches independent sinc-squared width', () => {
  const cfg = baseline.cfg;
  const expected = .8859*C_MPS/(2*cfg.bandwidth)*Math.hypot(cfg.groundRange,cfg.height)/cfg.groundRange;
  assert.ok(Math.abs(fwhm(profile(baseline,'ground'))/expected-1)<.04);
});

test('cross-range response matches the small-aperture geometric prediction', () => {
  const cfg = baseline.cfg;
  const expected = .8859*cfg.lambda*Math.hypot(cfg.groundRange,cfg.height)/
    (2*cfg.speed*cfg.duration*Math.sin(cfg.azimuthDeg*Math.PI/180));
  assert.ok(Math.abs(fwhm(profile(baseline,'cross'))/expected-1)<.04);
});

test('half bandwidth doubles ground-range mainlobe width', () => {
  const other = synthesize([{cross:0,ground:0}],{bandwidth:SAR_PROFILES.standard.bandwidth_hz/2});
  const ratio = fwhm(profile(other,'ground'))/fwhm(profile(baseline,'ground'));
  assert.ok(ratio>1.9 && ratio<2.1);
});

test('half aperture time doubles cross-range mainlobe width', () => {
  const other = synthesize([{cross:0,ground:0}],{duration:1});
  const ratio = fwhm(profile(other,'cross'))/fwhm(profile(baseline,'cross'));
  assert.ok(ratio>1.9 && ratio<2.1);
});

test('erasing complex phase prevents off-center target focusing', () => {
  const data = synthesize([{cross:3,ground:0}]);
  assert.ok(focus(data,3,0,{erasePhase:true})/focus(data,3,0)<.1);
});

test('time-varying millimeter range errors degrade coherent peak power', () => {
  const err = n => .004*Math.sin(2*Math.PI*7*n/(baseline.cfg.pulses-1));
  assert.ok(focus(baseline,0,0,{rangeError:err})/focus(baseline,0,0)<.5);
});

test('two stationary targets four meters apart form separate peaks', () => {
  const data = synthesize([{cross:-2,ground:0},{cross:2,ground:0}]);
  assert.ok(focus(data,0,0)<.2*focus(data,2,0));
  assert.ok(focus(data,-2,0)>.5 && focus(data,2,0)>.5);
});

test('straight forward-looking monostatic geometry has left-right ambiguity', () => {
  const data = synthesize([{cross:3,ground:0}],{azimuthDeg:0});
  assert.ok(Math.abs(focus(data,3,0)-focus(data,-3,0))<1e-10);
});

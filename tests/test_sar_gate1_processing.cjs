'use strict';
// Gate 1 regression: a requested quality profile may be capped by the footprint's waveform.
// `fine` promises 150 MHz / 257 px; the 512 m and 2048 m footprints supply 37.5 MHz and 10 MHz.
// The effective profile must be reported everywhere the actual matrix is described.
const test=require('node:test'),assert=require('node:assert/strict');
const {SAR_PROFILES,SAR_FOOTPRINTS,sar:{grids:SAR_GRIDS}}=require('../src/shared/config.cjs');
// processingOptions needs a footprint resolver, which is a DCS concept: the adapter binds it.
const {processingOptions}=require('../src/adapters/dcs/sar_adapter.cjs');
const {settings}=require('../src/sar_core/settings.cjs');
const engine=require('../src/sar_core/engine.cjs');
// Minimal flat scene with the same geometry rules validate() enforces; assembleResult only needs
// source/size/n/center/bearing/trajectory/objects, so this stays a metadata-path unit test.
function flatScene(size,n){
  const bearing=Math.PI/4,center=[20000*Math.cos(bearing),80,20000*Math.sin(bearing)];
  const scene={source:'synthetic-demo',size,n,bearing,center,terrain:[],trajectory:[]};
  for(let row=0;row<n;row++)for(let col=0;col<n;col++){
    const cross=(col/(n-1)-.5)*size,ground=(row/(n-1)-.5)*size;
    scene.terrain.push([center[0]+cross*Math.sin(bearing)+ground*Math.cos(bearing),80,
      center[2]-cross*Math.cos(bearing)+ground*Math.sin(bearing)]);
  }
  for(let k=0;k<=120;k++)scene.trajectory.push({t:k/60,pos:[250*k/60,4000,0]});
  return scene;
}
// Exercise the same metadata builder reconstruct() uses, with a power matrix of the actual width.
function assembled(options){
  const cfg=settings(options),scene=flatScene(512,33);
  const power=Array.from({length:cfg.width*cfg.width},()=>1);
  return engine.assembleResult(scene,cfg,[],power,
    {slant:20000,effective:300,pulses:100,prf:1000,method:'test',resolution:2},performance.now());
}
test('Fine on the 512 m footprint reports the effective standard waveform instead of fine',()=>{
  const options=processingOptions({quality:'fine',footprint:'area'});
  assert.equal(options.quality,'standard');
  assert.equal(options.requested_quality,'fine');
  assert.equal(options.effective_quality,'standard');
  assert.equal(options.effective_bandwidth,SAR_FOOTPRINTS.area.bandwidth_hz);
  assert.equal(options.effective_width,SAR_FOOTPRINTS.area.width);
  assert.equal(options.bandwidth,SAR_FOOTPRINTS.area.bandwidth_hz);
  assert.equal(options.width,SAR_FOOTPRINTS.area.width);
});
test('Fine on the 2048 m footprint reports the effective standard waveform even though the grid is 257 px',()=>{
  const options=processingOptions({quality:'fine',footprint:'airport'});
  assert.equal(options.quality,'standard');
  assert.equal(options.requested_quality,'fine');
  assert.equal(options.effective_quality,'standard');
  assert.equal(options.effective_bandwidth,SAR_FOOTPRINTS.airport.bandwidth_hz);
  assert.equal(options.effective_width,SAR_FOOTPRINTS.airport.width);
  assert.equal(options.bandwidth,SAR_FOOTPRINTS.airport.bandwidth_hz);
  assert.equal(options.width,SAR_FOOTPRINTS.airport.width);
  assert.equal(options.scatterSpacing,SAR_FOOTPRINTS.airport.scatter_spacing_m);
  assert.equal(options.pulseOversampling,SAR_PROFILES.standard.pulse_oversampling);
});
test('Fine on the detail footprint keeps the fine waveform and has nothing to disclaim',()=>{
  const options=processingOptions({quality:'fine',footprint:'detail'});
  assert.deepEqual([options.quality,options.bandwidth,options.width],
    ['fine',SAR_PROFILES.fine.bandwidth_hz,SAR_PROFILES.fine.width]);
  assert.equal(options.requested_quality,undefined);
  assert.equal(options.effective_quality,undefined);
});
test('Standard and fast report the grid and waveform actually applied',()=>{
  const standard=processingOptions({quality:'standard',footprint:'detail'});
  assert.deepEqual([standard.quality,standard.bandwidth,standard.width,standard.pulseOversampling],
    ['standard',SAR_PROFILES.standard.bandwidth_hz,SAR_PROFILES.standard.width,SAR_PROFILES.standard.pulse_oversampling]);
  assert.equal(standard.requested_quality,undefined);
  const fast=processingOptions({quality:'fast',footprint:'detail'});
  assert.deepEqual([fast.quality,fast.bandwidth,fast.width,fast.scatterSpacing,fast.pulseOversampling],
    ['fast',SAR_PROFILES.fast.bandwidth_hz,SAR_PROFILES.fast.width,
      SAR_PROFILES.fast.scatter_spacing_m,SAR_PROFILES.fast.pulse_oversampling]);
  assert.equal(fast.requested_quality,undefined);
  // The footprint's own bandwidth still wins for standard; that is its actual, not a silent fine.
  const area=processingOptions({quality:'standard',footprint:'area'});
  assert.deepEqual([area.quality,area.bandwidth,area.width],
    ['standard',SAR_FOOTPRINTS.area.bandwidth_hz,SAR_FOOTPRINTS.area.width]);
  const fastArea=processingOptions({quality:'fast',footprint:'area'});
  assert.deepEqual([fastArea.quality,fastArea.bandwidth,fastArea.width,fastArea.scatterSpacing],
    ['fast',SAR_FOOTPRINTS.area.bandwidth_hz,
      Math.ceil(SAR_FOOTPRINTS.area.width/SAR_GRIDS.fast.width_divisor),
      SAR_FOOTPRINTS.area.scatter_spacing_m*SAR_GRIDS.fast.scatter_spacing_multiplier]);
});
test('Image metadata records the effective quality/bandwidth/width of the actual matrix',()=>{
  for(const [footprint,bandwidth,width] of [
    ['area',SAR_FOOTPRINTS.area.bandwidth_hz,SAR_FOOTPRINTS.area.width],
    ['airport',SAR_FOOTPRINTS.airport.bandwidth_hz,SAR_FOOTPRINTS.airport.width]]){
    const options=processingOptions({quality:'fine',footprint});
    const image=assembled(options);
    assert.equal(image.width,width,`${footprint} matrix width`);
    assert.equal(image.power.length,image.width*image.width,`${footprint} matrix size`);
    assert.equal(image.metadata.width,image.width,`${footprint} metadata width matches matrix`);
    assert.equal(image.metadata.bandwidth_hz,bandwidth,`${footprint} metadata bandwidth matches matrix`);
    assert.equal(image.metadata.quality,'standard',`${footprint} metadata no longer claims fine`);
    assert.equal(image.metadata.requested_quality,'fine',`${footprint} keeps the request for diagnostics`);
  }
});
test('A degraded request is also recognised when fine comes from the base options',()=>{
  const base=processingOptions({quality:'fine'});
  const options=processingOptions({footprint:'area'},base);
  assert.equal(options.quality,'standard');
  assert.equal(options.requested_quality,'fine');
  assert.equal(options.effective_bandwidth,SAR_FOOTPRINTS.area.bandwidth_hz);
  assert.equal(options.effective_width,SAR_FOOTPRINTS.area.width);
});
test('Reusing a degraded base does not leak stale effective values into a non-degraded request',()=>{
  const degraded=processingOptions({quality:'fine',footprint:'area'});
  const fine=processingOptions({quality:'fine',footprint:'detail'},degraded);
  assert.deepEqual([fine.quality,fine.bandwidth,fine.width],
    ['fine',SAR_PROFILES.fine.bandwidth_hz,SAR_PROFILES.fine.width]);
  assert.equal(fine.requested_quality,undefined);
  assert.equal(fine.effective_quality,undefined);
  assert.equal(fine.effective_bandwidth,undefined);
  assert.equal(fine.effective_width,undefined);
  // With no explicit quality the base's original request survives, and so does its actual waveform.
  const inherited=processingOptions({},degraded);
  assert.equal(inherited.quality,'standard');
  assert.equal(inherited.requested_quality,'fine');
  assert.equal(inherited.effective_bandwidth,SAR_FOOTPRINTS.area.bandwidth_hz);
  assert.equal(inherited.effective_width,SAR_FOOTPRINTS.area.width);
});

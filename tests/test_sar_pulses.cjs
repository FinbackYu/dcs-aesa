'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {LAMBDA_M,SAR_PROFILES,SAR_FOOTPRINTS}=require('../src/shared/config.cjs');
const {pulses}=require('../src/sar_core/waveform.cjs');
const {pulseLimit,rangeBins,MAX_SIMULATED_PULSES}=require('../src/sar_core/memory.cjs');
const {settings}=require('../src/sar_core/settings.cjs'),{processingOptions}=require('../src/adapters/dcs/sar_adapter.cjs');
const {fixture,contrast}=require('../scripts/sar_airport_probe.cjs'),{validate}=require('../src/sar_core/geometry.cjs'),{reconstruct}=require('../src/sar_core/engine.cjs');
// A scene's shape does not change the pulse count (only λ, the geometry and the oversampling do), but
// it decides the bin count the echo-history budget is spent over, so the fixtures use full profiles.
const cfgOf=(region,extra={})=>settings(processingOptions({footprint:region,quality:'standard',focuser:'backprojection'},
  {sceneModel:'classified',...extra}));
// A tile centred `range` metres from the track, collected by a `speed` m/s aircraft at `altitude`
// over the 2 s aperture: the real high-speed geometry the fixed 8192-pulse ceiling used to refuse.
function fastTile({size=SAR_FOOTPRINTS.area.size_m,range=860,speed=317,altitude=1800}={}){
  const n=size<=SAR_FOOTPRINTS.area.size_m?SAR_FOOTPRINTS.area.n:SAR_FOOTPRINTS.airport.n,bearing=0,squint=Math.PI/4;
  const scene={source:'synthetic-demo',n,size,footprint:size<=SAR_FOOTPRINTS.area.size_m?'area':'airport',bearing,
    center:[range*Math.cos(squint),100,range*Math.sin(squint)],terrain:[],trajectory:[]};
  for(let row=0;row<n;row++)for(let column=0;column<n;column++){
    const cross=(column/(n-1)-.5)*size,ground=(row/(n-1)-.5)*size;
    scene.terrain.push([scene.center[0]+cross,100,scene.center[2]+ground]);}
  for(let k=0;k<=120;k++)scene.trajectory.push({t:k/60,pos:[-speed+2*speed*k/120,altitude,0]});
  return scene;}
// The refusal names both numbers, so a test can read them back out.
function refusal(match){try{match();}catch(e){return e.message;}return null;}
test('Simulated PRF grows with footprint Doppler extent, preserves navigation knots and bounds work',()=>{
 const a=fixture('detail'),b=fixture('airport'),detailCfg=cfgOf('detail'),airportCfg=cfgOf('airport');
 const small=pulses(a,[],detailCfg),large=pulses(b,[],airportCfg);
 assert.ok(small.samples.length>a.trajectory.length);assert.ok(large.samples.length>small.samples.length);
 assert.ok(large.samples.length<=large.limit,'a planned scene always fits the ceiling it reports');
 assert.equal(large.limit,pulseLimit(rangeBins(b,[],airportCfg)),'the ceiling is the derived one for its bins');
 assert.equal(small.samples[0].t,a.trajectory[0].t);assert.equal(small.samples.at(-1).t,a.trajectory.at(-1).t);
 for(const p of small.samples)assert.ok(Math.abs(p.pos[0]-250*p.t)<1e-8&&p.pos[1]===4000&&p.pos[2]===0);
 const telemetry=pulses(a,[],{lambda:LAMBDA_M,sceneModel:'uniform'});
 assert.equal(telemetry.samples,a.trajectory);assert.equal(telemetry.limit,null,'telemetry frames are not simulated pulses');
 b.trajectory.forEach(p=>p.pos[1]=400);
 const message=refusal(()=>pulses(b,[],cfgOf('airport',{lambda:.005})));
 assert.match(message,/Scene needs \d+ simulated pulses but the echo history budget \(\d+ MiB over \d+ range bins\) allows \d+; reduce range footprint, ground speed or pulse oversampling/);
 const needed=Number(message.match(/needs (\d+)/)[1]),allowed=Number(message.match(/allows (\d+)/)[1]);
 assert.ok(needed>allowed);assert.equal(allowed,pulseLimit(rangeBins(b,[],cfgOf('airport',{lambda:.005}))));
 a.trajectory[4].t+=1;assert.throws(()=>validate(a),/discontinuity/);
});
test('The simulated pulse ceiling follows the echo-history budget instead of a fixed 8192',()=>{
 const cfg=cfgOf('area');
 // The 512 m 'area' slice is ~1772 range bins of 16 B per pulse, so a flat 512 m tile may simulate
 // ~16.5 k pulses: enough for the ~7.5 kHz PRF a 317 m/s aircraft forces at 860 m, which the fixed
 // ceiling refused although the history (448 MiB of the 512 MiB budget) holds it.
 const near=fastTile({range:860}),bins=rangeBins(near,[],cfg),limit=pulseLimit(bins);
 assert.ok(bins>1700&&bins<1900,`a 512 m tile plans ~1772 range bins, got ${bins}`);
 assert.ok(limit>=15000&&limit<=18000,`the derived ceiling is ~15–18 k pulses, got ${limit}`);
 const sampling=pulses(near,[],cfg);
 assert.ok(sampling.samples.length>8192,`the fixed ceiling refused this scene (${sampling.samples.length} pulses)`);
 assert.ok(sampling.samples.length<=sampling.limit,`${sampling.samples.length} pulses fit the ${sampling.limit} allowed`);
 assert.equal(sampling.limit,limit);
 assert.ok(sampling.prf>=7000&&sampling.prf<=8000,`the real flight reported ~7.5 kHz PRF here, got ${sampling.prf}`);
 // Farther out the same tile needs far fewer pulses.
 assert.ok(pulses(fastTile({range:5000}),[],cfg).samples.length<sampling.samples.length/2);
 // A 2048 m overview at the same distance cannot fit, whatever the budget: refused, with both numbers.
 const overviewCfg=cfgOf('airport'),overviewBins=rangeBins(fastTile({size:SAR_FOOTPRINTS.airport.size_m,range:2000}),[],overviewCfg);
 assert.ok(overviewBins<3000,'the overview DEM does not blow the range window up');
 const refused=refusal(()=>pulses(fastTile({size:SAR_FOOTPRINTS.airport.size_m,range:2000}),[],overviewCfg));
 assert.ok(refused,`the overview needs ${pulseLimit(overviewBins)}+ pulses and must be refused`);
 const needed=Number(refused.match(/needs (\d+)/)[1]),allowed=Number(refused.match(/allows (\d+)/)[1]);
 assert.ok(needed>allowed*2,`${needed} pulses are far past the ${allowed} allowed`);
 assert.ok(allowed>8192,'even the refusal reports a ceiling above the fixed one it replaced');
 // The absolute cap only binds for small patches, and an unknown bin count degrades to it.
 assert.equal(pulseLimit(1),MAX_SIMULATED_PULSES);assert.equal(pulseLimit(undefined),MAX_SIMULATED_PULSES);
 assert.ok(pulseLimit(4000)<MAX_SIMULATED_PULSES,'a dense range window is limited by the budget, not the cap');
});
test('Known paved strip remains darker after coherent image focusing, not only in input coefficients',()=>{
 const s=fixture();s.objects=[];s.terrain.forEach(p=>p[1]=100);const cfg={width:SAR_PROFILES.fast.width,scatterSpacing:SAR_FOOTPRINTS.airport.scatter_spacing_m,bandwidth:SAR_FOOTPRINTS.area.bandwidth_hz,pulseSampling:'auto'};
 const uniform=reconstruct(s,{...cfg,sceneModel:'uniform'}),classified=reconstruct(s,{...cfg,sceneModel:'classified'});
 assert.ok(contrast(classified)<contrast(uniform)-6,JSON.stringify({uniform:contrast(uniform),classified:contrast(classified)}));
 assert.ok(classified.metadata.simulated_pulses>classified.metadata.poses);assert.ok(classified.db.every(Number.isFinite));
});
test('Pulse oversampling stays at the project 2.5 by default and marks reduced sampling as an aliasing risk',()=>{
 const s=fixture('area'),cfg=cfgOf('area');
 const base=pulses(s,[],cfg),explicit=pulses(s,[],{...cfg,pulseOversampling:SAR_PROFILES.standard.pulse_oversampling}),reduced=pulses(s,[],{...cfg,pulseOversampling:SAR_PROFILES.fast.pulse_oversampling});
 const reducedRatio=SAR_PROFILES.fast.pulse_oversampling/SAR_PROFILES.standard.pulse_oversampling;
 assert.equal(explicit.prf,base.prf);assert.doesNotMatch(base.method,/降低过采样/);
 assert.ok(Math.abs(reduced.prf/explicit.prf-reducedRatio)<.01);
 assert.ok(Math.abs(reduced.samples.length/base.samples.length-reducedRatio)<.05);
 assert.equal(reduced.samples[0].t,s.trajectory[0].t);assert.equal(reduced.samples.at(-1).t,s.trajectory.at(-1).t);
 assert.match(reduced.method,/(降低过采样，可能混叠)/);
});

'use strict';
// Known synthetic scene. No DCS airport geometry or material measurements.
const fs=require('node:fs'),path=require('node:path');
const {demoScene}=require('../tools/sar_demo_scene.cjs');
const {validate}=require('../src/sar_core/geometry.cjs'),{reconstruct}=require('../src/sar_core/engine.cjs');
const {FOOTPRINTS}=require('../src/adapters/dcs/sar_adapter.cjs');
const {processingOptions}=require('../src/adapters/dcs/sar_adapter.cjs');
function fixture(region='area'){
 const s=demoScene(),p=FOOTPRINTS[region];Object.assign(s,{size:p.size,n:p.n,footprint:region,terrain:[],surfaces:[]});s.trajectory=s.trajectory.filter((_,i)=>i%4===0);
 for(let r=0;r<s.n;r++)for(let c=0;c<s.n;c++){const cross=(c/(s.n-1)-.5)*s.size,ground=(r/(s.n-1)-.5)*s.size;s.terrain.push([s.center[0]+cross*Math.sin(s.bearing)+ground*Math.cos(s.bearing),100+Math.max(0,-cross-100)*.25,s.center[2]-cross*Math.cos(s.bearing)+ground*Math.sin(s.bearing)]);s.surfaces.push(Math.abs(cross)<32?'runway':'land');}
 s.center[1]=100;s.objects=[{kind:'static',pos:[s.center[0]+80*Math.sin(s.bearing),100,s.center[2]-80*Math.cos(s.bearing)],axes:[[Math.sin(s.bearing),0,-Math.cos(s.bearing)],[0,1,0],[Math.cos(s.bearing),0,Math.sin(s.bearing)]],min:[-15,0,-25],max:[15,15,25]}];
 s.scene_data={surface_provider:'synthetic known classes',object_provider:'synthetic known box',note:'合成验证场景，不是 DCS 机场实测'};return validate(s);
}
function contrast(result){const w=result.width;let land=0,runway=0,nl=0,nr=0;for(let r=0;r<w;r++)for(let c=0;c<w;c++){const x=(c/(w-1)-.5)*result.size_m;if(Math.abs(x)<16){runway+=result.power[r*w+c];nr++;}else if(x>140&&x<220){land+=result.power[r*w+c];nl++;}}return 10*Math.log10((runway/nr)/(land/nl));}
if(require.main===module){const dir=path.resolve(process.argv[2]||'recordings/sar-airport-probe');fs.mkdirSync(dir,{recursive:true});const scene=fixture(),uniform=reconstruct(scene,{...processingOptions({footprint:'area',sceneModel:'uniform'}),pulseSampling:'auto'}),classified=reconstruct(scene,processingOptions({footprint:'area',sceneModel:'classified'}));fs.writeFileSync(path.join(dir,'scene.json'),JSON.stringify(scene));fs.writeFileSync(path.join(dir,'comparison.json'),JSON.stringify({source:'synthetic-demo',uniform,classified}));const metrics={source:'synthetic known scene, not DCS',uniform_runway_to_land_db:contrast(uniform),classified_runway_to_land_db:contrast(classified),uniform_compute_ms:uniform.metadata.compute_ms,classified_compute_ms:classified.metadata.compute_ms,pulses:classified.metadata.simulated_pulses};fs.writeFileSync(path.join(dir,'metrics.json'),JSON.stringify(metrics,null,2));console.log(JSON.stringify(metrics));}
module.exports={fixture,contrast};

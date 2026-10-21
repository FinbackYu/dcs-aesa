'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),net=require('node:net');
const {demoScene}=require('../tools/sar_demo_scene.cjs');
const {pixel}=require('../src/sar_core/engine.cjs'),{validate}=require('../src/sar_core/geometry.cjs');
const {FOOTPRINTS,validateExtras}=require('../src/adapters/dcs/sar_adapter.cjs');
const {processingOptions}=require('../src/adapters/dcs/sar_adapter.cjs');
const engineCore=require('../src/sar_core/engine.cjs');
const {MATERIALS,materialAt}=require('../src/sar_core/materials.cjs'),{terrainBlocked,boxBlocked}=require('../src/sar_core/scatterers.cjs');
const {createBridge}=require('../tools/sar_bridge.cjs');
const {Collector}=require('../tools/sar_live.cjs');
const {createService}=require('../tools/sar_live.cjs');
const engine=engineCore;
function scene(region='detail'){const s=demoScene(),p=FOOTPRINTS[region];Object.assign(s,{size:p.size,n:p.n,footprint:region});s.terrain=Array.from({length:p.n*p.n},(_,i)=>{const c=(i%p.n/(p.n-1)-.5)*p.size,g=(Math.floor(i/p.n)/(p.n-1)-.5)*p.size;return [s.center[0]+c*Math.sin(s.bearing)+g*Math.cos(s.bearing),100,s.center[2]-c*Math.cos(s.bearing)+g*Math.sin(s.bearing)];});s.center[1]=100;return s;}
const box={kind:'static',pos:[0,100,0],axes:[[1,0,0],[0,1,0],[0,0,1]],min:[-10,0,-10],max:[10,20,10]};
test('Three footprints preserve ordered geometry and enforce coarse overview processing',()=>{
 for(const name of Object.keys(FOOTPRINTS)){const s=scene(name);validate(s);assert.equal(pixel(s,0,0)[1],100);const cfg=processingOptions({quality:'fine',footprint:name,sceneModel:'classified'});assert.equal(cfg.scatterSpacing,FOOTPRINTS[name].scatterSpacing);if(name==='airport'){assert.equal(cfg.width,257);assert.equal(cfg.bandwidth,10e6);}const c=new Collector();assert.match(c.start(1,20000,name),/^CAPTURE,1,1,20000/);c.accept(`BEGIN,1,${s.center[0]},${s.center[2]},${s.bearing},${s.size},${s.n}`);for(let i=0;i<s.terrain.length;i++)c.accept(`HEIGHT,1,${i},${s.terrain[i].join(',')}`);assert.equal(c.job.terrain.length,s.n**2);}
 assert.throws(()=>processingOptions({footprint:'whole-map'}));
 // The surface grid's structure is the core's contract (it knows class strings, not DCS names); the
 // adapter only refuses DCS-invalid geometry, so a short grid passes here and fails in validate().
 assert.doesNotThrow(()=>validateExtras({n:FOOTPRINTS.detail.n,surfaces:['land']}));
 assert.throws(()=>validate({...scene(),surfaces:['land']}),/surface grid/);
 assert.throws(()=>validateExtras({objects:[{...box,axes:[[2,0,0],[0,1,0],[0,0,1]]}]}));
});
test('Classification changes coherent echoes before focusing; old model is an explicit control',()=>{
 const s=scene();s.surfaces=Array(289).fill('land');const options={sceneModel:'classified',scatterSpacing:4,width:65};const a=engine.buildScatterers(s,options),h=engine.synthesizeScene(s,a,options),energy=h.history.reduce((sum,p)=>sum+p.re.reduce((v,x,i)=>v+x*x+p.im[i]**2,0),0);
 s.surfaces.fill('runway');const b=engine.buildScatterers(s,options),hr=engine.synthesizeScene(s,b,options),er=hr.history.reduce((sum,p)=>sum+p.re.reduce((v,x,i)=>v+x*x+p.im[i]**2,0),0);assert.ok(Math.abs(er/energy-MATERIALS.runway)<1e-10);
 assert.deepEqual(a.map(p=>p.pos),b.map(p=>p.pos));assert.deepEqual(a.map(p=>p.phase),b.map(p=>p.phase));
 const old=engine.buildScatterers(s,{scatterSpacing:4});s.surfaces.fill('water');assert.deepEqual(engine.buildScatterers(s,{scatterSpacing:4}),old);
 assert.equal(materialAt(s,0,0),'water');delete s.surfaces;assert.equal(materialAt(s,0,0),'unknown');
});
test('DEM ridge blocks a ray, flat DEM does not; oriented box blocks only intersecting rays',()=>{
 const s=scene(),p=pixel(s,0,50),q=pixel(s,0,-50),from=[p[0],150,p[2]],to=q;
 assert.equal(terrainBlocked(s,from,to,pixel),false);
 for(let i=0;i<s.terrain.length;i++)if(Math.floor(i/s.n)===8)s.terrain[i][1]=200;
 assert.equal(terrainBlocked(s,from,to,pixel),true);
 assert.equal(boxBlocked(box,[-100,110,0],[100,110,0]),true);assert.equal(boxBlocked(box,[-100,130,0],[100,130,0]),false);
 const rotated={...box,axes:[[Math.SQRT1_2,0,Math.SQRT1_2],[0,1,0],[-Math.SQRT1_2,0,Math.SQRT1_2]]};assert.equal(boxBlocked(rotated,[-100,110,0],[100,110,0]),true);
});
test('Object faces enter the echo scatterers and bounded local visibility reports source limits',()=>{
 const s=scene();s.objects=[{...box,pos:[...s.center]}];const opts={sceneModel:'classified',scatterSpacing:4,width:65};const a=engine.buildScatterers(s,opts);assert.ok(a.some(p=>p.object===0&&p.pos[1]>s.center[1]));assert.ok(a.length<20000);
 const r=engine.reconstruct(s,opts);assert.equal(r.metadata.objects_received,1);assert.equal(r.metadata.objects_modeled,1);assert.match(r.metadata.visibility,/outside patch unknown/);assert.ok(r.db.every(Number.isFinite));
});
test('Bridge accepts a complete classified scene; malformed sequence discards partial extras',async t=>{
 const b=createBridge({port:0});t.after(()=>b.close());const port=await b.started,c=net.connect(port,'127.0.0.1');t.after(()=>c.destroy());await new Promise(r=>c.once('connect',r));c.write('HELLO,SARSCENE1\nCAP,land.getSurfaceType,world.searchObjects,a_do_script\n');await new Promise(r=>setTimeout(r,20));
 const s=scene();s.id=8;const command=new Promise(r=>c.once('data',r));b.request(s);assert.match((await command).toString(),/^SCENE,8,/);const complete=b.finish(s);c.write(Array.from({length:289},(_,i)=>`SURFACE,8,${i},5`).join('\n')+'\nSCENE_END,8,0,2,3,world.searchObjects\n');const result=await complete;assert.equal(result.surfaces.length,289);assert.equal(result.surfaces[0],'runway');assert.equal(result.scene_data.moving_objects_skipped,3);
 s.id=9;b.request(s);const bad=b.finish(s);c.write('SURFACE,9,1,5\n');const failed=await bad;assert.equal(failed.surfaces,undefined);assert.match(failed.scene_data.note,/Invalid/);
});
test('Export plus mission scene join reaches worker; reprocess preserves actual overview geometry',async t=>{
 const service=createService({tcpPort:0,httpPort:0,scenePort:0,processing:{window:'hann'}});t.after(()=>service.close());const ports=await service.started,base=`http://127.0.0.1:${ports.httpPort}`;
 const wait=async fn=>{const until=Date.now()+120000;while(!fn()){if(Date.now()>until)throw Error('Test timed out');await new Promise(r=>setTimeout(r,10));}};
 const hook=net.connect(ports.scenePort,'127.0.0.1'),exp=net.connect(ports.tcpPort,'127.0.0.1');t.after(()=>{hook.destroy();exp.destroy();});await Promise.all([new Promise(r=>hook.once('connect',r)),new Promise(r=>exp.once('connect',r))]);
 hook.write('HELLO,SARSCENE1\nCAP,land.getSurfaceType,world.searchObjects,a_do_script\n');exp.write('HELLO,SAR1\nCAPS,2,terrain.GetSurfaceType\nSTATUS,1,terrain.GetHeight,100,100,100,1\n');await wait(()=>service.collector.capabilities&&service.collector.status);
 const s=scene('area');s.trajectory=s.trajectory.filter((_,i)=>i%8===0);
 const response=await fetch(base+'/capture',{method:'POST',body:JSON.stringify({footprint:'area',side:1,range:20000,sceneModel:'classified',quality:'fine'})});assert.equal(response.status,202);const {id}=await response.json();
 hook.on('data',chunk=>{if(chunk.toString().startsWith('SCENE,'))hook.write(Array.from({length:s.n**2},(_,i)=>`SURFACE,${id},${i},5`).join('\n')+`\nSCENE_END,${id},0,0,0,world.searchObjects\n`);});
 const lines=[`BEGIN,${id},${s.center[0]},${s.center[2]},${s.bearing},${s.size},${s.n}`,...s.terrain.map((p,i)=>`HEIGHT,${id},${i},${p.join(',')}`),...s.trajectory.map((p,i)=>`POSE,${id},${i},${p.t},${p.pos.join(',')}`),`END,${id},${s.trajectory.length},2`];exp.write(lines.join('\n')+'\n');await wait(()=>service.state.result||service.state.error);assert.equal(service.state.error,null);assert.equal(service.state.result.metadata.engine,'scene-v3');assert.equal(service.state.result.size_m,512);
 const first=(await(await fetch(base+'/snapshot')).json());assert.equal(first.scene.surfaces[0],'runway');assert.equal(first.scene.scene_data.surface_provider,'land.getSurfaceType');assert.equal(first.result.metadata.bandwidth_hz,37.5e6);
 assert.equal((await fetch(base+'/reprocess',{method:'POST',body:'{"footprint":"detail","quality":"fine","sceneModel":"uniform"}'})).status,202);await wait(()=>service.state.result);assert.equal(service.state.result.size_m,512);assert.equal(service.state.result.metadata.bandwidth_hz,37.5e6);assert.equal(service.state.result.metadata.engine,'surface-v2');
});

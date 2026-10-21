'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),http=require('node:http');
const {Collector,createService}=require('../tools/sar_live.cjs');
const {PROTOCOL}=require('../src/shared/config.cjs');
const SIZE=PROTOCOL.sar.default_size_m;
// node:http instead of the global fetch. fetch (and browsers) refuse a list of well-known ports even
// when the service legitimately owns one as its OS-assigned ephemeral port (Windows dynamic range
// starts at 1024 on this machine and includes 4045/6000/6665-6669/10080). That turned a valid local
// port into an opaque "bad port" failure when several suites ran in parallel. The port still comes
// from service.started; only the client changed.
function fetch(url,options={}){
  return new Promise((resolve,reject)=>{
    const target=new URL(url),port=target.port===''?80:Number(target.port);
    if(!Number.isInteger(port)||port<=0||port>65535)return reject(Error(`test fetch: invalid URL port in ${url}`));
    const body=options.body===undefined?null:Buffer.from(String(options.body));
    const headers={...(options.headers||{})};
    if(body&&headers['Content-Length']===undefined)headers['Content-Length']=body.length;
    const request=http.request({host:target.hostname,port,path:target.pathname+target.search,method:options.method||'GET',headers},response=>{
      let text='';response.setEncoding('utf8');response.on('data',chunk=>text+=chunk);
      response.on('end',()=>resolve({status:response.statusCode,ok:response.statusCode>=200&&response.statusCode<300,
        text:async()=>text,json:async()=>JSON.parse(text),headers:response.headers}));
    });
    request.on('error',reject);
    if(body)request.write(body);
    request.end();
  });
}
const {demoScene}=require('../tools/sar_demo_scene.cjs');
const {reconstruct,pixel}=require('../src/sar_core/engine.cjs'),{validate}=require('../src/sar_core/geometry.cjs');
const {processingOptions}=require('../src/adapters/dcs/sar_adapter.cjs');
const map=require('../src/sar_core/map.cjs');                 // the sector mask, to judge what a patrol asked for
function messages(scene,id=1){return [
  `BEGIN,${id},${scene.center[0]},${scene.center[2]},${scene.bearing},${PROTOCOL.sar.default_size_m},${PROTOCOL.sar.default_n}`,
  ...scene.terrain.map((p,i)=>`HEIGHT,${id},${i},${p.join(',')}`),
  ...scene.trajectory.map((p,i)=>`POSE,${id},${i},${p.t},${p.pos.join(',')}`),
  `END,${id},${scene.trajectory.length},${scene.trajectory.at(-1).t}`];}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(f,label='condition'){for(let i=0;i<375;i++){if(await f())return;await delay(40);}throw Error(`wait timed out: ${label}`);}
// A flat DEM and a drifting ownship: the least MAP protocol a patrol needs to learn a pose of its own
// (the protocol itself is exercised by test_sar_map.cjs). `poses:1` is an Export that reports a single
// pose per job — a position without a second frame, so no heading can be derived from it. The pose
// numbering starts at 1, which is what the Export deployed in DCS does (test_sar_map.cjs's stub starts
// at 0): the service takes the first number as its baseline, so both are covered end to end.
// `own.heading` is the direction the two poses step along (default +x, the demo flight's heading), so a
// test can turn the aircraft and watch the sector re-anchor without it flying anywhere; the two poses do
// not accumulate, so a patrol of many jobs cannot walk the aircraft out of the sector under test.
const DEM_HEIGHT=(x,z)=>100+.004*Math.max(0,x)+8*Math.sin(z/4000);
function mapReply(own,line,poses=2,requests=null){
  const a=line.trim().split(',');
  if(a[0]!=='CAPTURE_MAP'&&a[0]!=='CAPTURE_MAP_AT')return null;
  const id=Number(a[1]),relative=a[0]==='CAPTURE_MAP_AT';
  const origin=relative?[own.x+Number(a[2]),own.z+Number(a[3])]:[Number(a[2]),Number(a[3])];
  const cols=Number(a[4]),rows=Number(a[5]),step=Number(a[6]);
  requests?.push({id,relative,origin,cols,rows,step,cells:cols*rows});
  let sequence=1;
  // The pose clock is monotonic across jobs, like the real model time it imitates: a clock that
  // resets per job would hide the cross-job heading pair (one pose per job, paired with the next
  // job's pose) that the service now relies on.
  const pose=offset=>{const heading=own.heading??Math.PI/2;own.clock=(own.clock??1000)+.25;
    return `MAPPOSE,${id},${sequence++},${own.clock},${own.x+offset*Math.sin(heading)},3000,${own.z+offset*Math.cos(heading)},250,0`;};
  const lines=[`MAPBEGIN,${id},${origin[0]},${origin[1]},${cols},${rows},${step}`,pose(0)];
  for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){
    const x=origin[0]+col*step,z=origin[1]+row*step;
    lines.push(`MAPHEIGHT,${id},${col},${row},${x},${DEM_HEIGHT(x,z).toFixed(3)},${z}`);
  }
  if(poses>1)lines.push(pose(12));
  lines.push(`MAPEND,${id},${cols*rows},${own.clock}`);
  return lines;}
// A live Export that keeps the terrain status fresh (the service drops a link whose status is older
// than 3 s) and records every command it receives, including a mid-job CANCEL. With `answerMap` it
// also answers MAP jobs, which is what a radar watch needs before any SAR patch exists. Its ownship
// (`exporter.own`) is the test's handle on the aircraft: move `own.x`/`own.z` to fly, set `own.heading`
// to turn, and the MAP poses it reports follow.
async function liveExport(t,port,{map=true,answerMap=false,mapPoses=2}={}){
  const own={x:0,z:0};
  const exporter={client:null,log:'',own,requests:[],commands:()=>exporter.log};
  const client=net.createConnection({host:'127.0.0.1',port});t.after(()=>client.destroy());
  await new Promise((resolve,reject)=>{client.once('connect',resolve);client.once('error',reject);});
  let buffer='';
  client.on('data',b=>{
    const text=b.toString();exporter.log+=text;
    if(!answerMap)return;
    buffer+=text;                                  // commands are newline-terminated and may be coalesced
    let index;
    while((index=buffer.indexOf('\n'))>=0){
      const reply=mapReply(own,buffer.slice(0,index),mapPoses,exporter.requests);buffer=buffer.slice(index+1);
      if(reply)client.write(reply.join('\n')+'\n');
    }
  });
  client.write(`HELLO,SAR1\nCAPS,2,terrain.GetSurfaceType${map?',map':''}\nSTATUS,42,terrain.GetHeight,50,51,50,1\n`);
  const keepAlive=setInterval(()=>{if(client.destroyed)clearInterval(keepAlive);else client.write('STATUS,42,terrain.GetHeight,50,51,50,1\n');},500);
  t.after(()=>clearInterval(keepAlive));
  exporter.client=client;
  return exporter;
}
// One manual patch capture answered with the given scene: this is how the service learns the trajectory
// every geometry question is measured from.
async function captureScene(service,base,exporter,scene){
  assert.equal((await fetch(base+'/capture',{method:'POST',body:'{"side":1,"range":20000}'})).status,202);
  await until(()=>service.collector.job,'capture request');
  exporter.client.write(messages(scene,service.collector.job.id).join('\n')+'\n');
  await until(()=>service.state.result||service.state.error,'captured image');
  return service.state.result;
}

test('Quality profiles are explicit waveform assumptions and invalid choices do not start work',()=>{
  assert.deepEqual(processingOptions({quality:'fine',window:'rect'}),{quality:'fine',bandwidth:150e6,width:257,pulseOversampling:2.5,window:'rect'});
  assert.equal(processingOptions({}, {width:65,scatterSpacing:4}).width,65);
  assert.throws(()=>processingOptions({quality:'unknown'}),/profile/);
});
test('Fast test profile halves the output grid, doubles scatter spacing and lowers pulse oversampling',()=>{
  assert.deepEqual(processingOptions({quality:'fast'}),{quality:'fast',bandwidth:75e6,width:65,scatterSpacing:2,pulseOversampling:1.5,window:'hann'});
  assert.deepEqual(processingOptions({quality:'fast',footprint:'area',sceneModel:'classified'}),{quality:'fast',bandwidth:37.5e6,width:65,scatterSpacing:8,pulseOversampling:1.5,footprint:'area',sceneModel:'classified',window:'hann'});
  const overview=processingOptions({quality:'fast',footprint:'airport'});
  assert.equal(overview.width,129);assert.equal(overview.scatterSpacing,32);assert.equal(overview.bandwidth,10e6);
  // Switching back to standard from a fast-derived base restores the full grid and the 2.5 oversampling margin.
  const standard=processingOptions({quality:'standard',footprint:'area'},processingOptions({quality:'fast'}));
  assert.deepEqual([standard.width,standard.scatterSpacing,standard.pulseOversampling],[129,4,2.5]);
  for(const quality of ['FAST','fast ',0,null,{}])assert.throws(()=>processingOptions({quality}),/profile/);
});
test('Fast image metadata records the lossy profile and the aliasing-risk sampling note',()=>{
  const image=reconstruct(demoScene(),processingOptions({quality:'fast',sceneModel:'classified'}));
  assert.equal(image.width,65);assert.equal(image.metadata.image_step_m,2);
  assert.deepEqual([image.metadata.quality,image.metadata.scatter_spacing_m,image.metadata.pulse_oversampling],['fast',2,1.5]);
  assert.match(image.metadata.pulse_sampling,/降低过采样，可能混叠/);
});
test('Restored display preserves image time/target but cannot masquerade as recoverable raw capture',async t=>{
  const display={completed:1000,result:{source:'dcs',size_m:SIZE,width:129,db:Array(129*129).fill(-10),power:Array(129*129).fill(1),metadata:{bandwidth_hz:75e6}},target:{latitude:41,longitude:42,ground_range_m:20000,relative_track_deg:45}};
  const service=createService({tcpPort:0,httpPort:0,display});t.after(()=>service.close());const p=await service.started;
  const s=await(await fetch(`http://127.0.0.1:${p.httpPort}/state`)).json();assert.equal(s.completed,1000);assert.equal(s.target.latitude,41);assert.equal(s.restoredDisplay,true);assert.equal(s.canReprocess,false);
  assert.equal((await fetch(`http://127.0.0.1:${p.httpPort}/scene`)).status,409);
  assert.equal(s.reference,null);
  assert.throws(()=>createService({display:{...display,result:{...display.result,db:[0]}}}),/display/);
});

test('Atomic snapshot restores matching raw height/image/time and rejects a different target',async t=>{
  const scene=demoScene();scene.target={latitude:41,longitude:42,ground_range_m:20000,relative_track_deg:45};
  const display={completed:1000,result:{source:scene.source,size_m:SIZE,width:65,db:Array(65*65).fill(-10),power:Array(65*65).fill(1),metadata:{}},target:scene.target,scene};
  const service=createService({tcpPort:0,httpPort:0,display});t.after(()=>service.close());const p=await service.started,base=`http://127.0.0.1:${p.httpPort}`;
  const s=await(await fetch(base+'/state')).json();assert.equal(s.completed,1000);assert.equal(s.restoredInput,true);assert.equal(s.canReprocess,true);
  // D3: the poll carries the descriptor, the raster is a fetch of its own.
  assert.equal(s.reference.heights,undefined,'the poll carries no raster');
  assert.equal(s.reference.completed,s.completed);
  const reference=await(await fetch(base+'/reference')).json();
  assert.deepEqual(reference.heights,scene.terrain.map(p=>p[1]));assert.equal(reference.completed,s.completed);
  assert.deepEqual(await(await fetch(base+'/snapshot')).json(),display);
  assert.throws(()=>createService({display:{...display,target:{...scene.target,latitude:42}}}),/differs/);
});
test('Fine reprocessing produces a finer response raster and exposes unchanged raw geometry',async t=>{
  const scene=demoScene();scene.processing={window:'hann',bandwidth:75e6,width:65,scatterSpacing:4};
  const service=createService({tcpPort:0,httpPort:0,scene,mode:'replay',processing:{quality:'fine',scatterSpacing:4,width:65}});t.after(()=>service.close());
  const p=await service.started,base=`http://127.0.0.1:${p.httpPort}`;await until(()=>service.state.result);
  assert.equal(service.state.result.width,257);assert.equal(service.state.result.metadata.bandwidth_hz,150e6);
  const raw=await(await fetch(base+'/scene')).json();assert.deepEqual(raw.scene,scene);
  assert.equal((await fetch(base+'/reprocess',{method:'POST',body:'{"quality":"unknown"}'})).status,409);
  assert.equal((await fetch(base+'/reprocess',{method:'POST',body:'{"quality":"fine","window":"hann"}'})).status,202);
  await until(()=>service.state.result?.width===257);
  assert.equal(service.state.result.metadata.bandwidth_hz,150e6);assert.equal(service.state.result.metadata.image_step_m,.5);
  assert.equal(service.state.result.metadata.terrain_spacing_m,8);assert.equal(service.state.result.source,'synthetic-demo');
  assert.equal((await fetch(base+'/reprocess',{method:'POST',body:'{"quality":"fast"}'})).status,202);
  await until(()=>service.state.result?.width===65);
  assert.deepEqual([service.state.result.metadata.quality,service.state.result.metadata.scatter_spacing_m,service.state.result.metadata.pulse_oversampling],['fast',2,1.5]);
  assert.deepEqual((await(await fetch(base+'/scene')).json()).scene,raw.scene);assert.equal(service.state.record,null);
});

test('Continuous capture waits for Export, repeats with bounded work, retains last image, and stops on request',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aesa-sar-continuous-'));
  const service=createService({tcpPort:0,httpPort:0,recordDir:root,processing:{scatterSpacing:4,width:65}});
  t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
  const ports=await service.started,base=`http://127.0.0.1:${ports.httpPort}`;
  const post=async(route,params)=>(await fetch(base+route,{method:'POST',body:JSON.stringify(params)}));
  assert.equal((await post('/continuous/start',{side:1,range:20000})).status,202);
  assert.equal(service.state.continuous.enabled,true);assert.equal(service.collector.job,null);
  const client=net.createConnection({host:'127.0.0.1',port:ports.tcpPort});t.after(()=>client.destroy());
  await new Promise(r=>client.once('connect',r));let commands='';client.on('data',b=>commands+=b.toString());
  client.write('HELLO,SAR1\nSTATUS,42,terrain.GetHeight,50,51,50,1\n');
  // A real Export reports status continuously and the service only starts captures while that
  // status is younger than 3 s; refreshing it keeps this test independent of host speed.
  const status=setInterval(()=>{if(!client.destroyed)client.write('STATUS,42,terrain.GetHeight,50,51,50,1\n');},500);
  t.after(()=>clearInterval(status));
  await until(()=>commands.includes('CAPTURE,1,1,20000'));
  assert.equal((await post('/capture',{side:1,range:20000})).status,409);
  client.write(messages(demoScene(),1).join('\n')+'\n');await until(()=>service.state.continuous.completed===1);
  const first=service.state.result;
  await until(()=>commands.includes('CAPTURE,2,1,20000'));
  assert.equal(service.state.result,first);assert.equal(service.state.continuous.completed,1);
  const paired=await(await fetch(base+'/state')).json();assert.deepEqual(paired.reference.center,demoScene().center);
  const pending=demoScene();pending.center=[50000,50,50000];
  // The next collection may already have its own center; reference must retain the displayed image's input.
  service.collector.job.center=pending.center;
  assert.deepEqual((await(await fetch(base+'/state')).json()).reference.center,demoScene().center);
  assert.deepEqual((await(await fetch(base+'/snapshot')).json()).scene.center,demoScene().center);
  delete service.collector.job.center;
  assert.deepEqual(fs.readdirSync(root),[]);assert.equal((await post('/reprocess',{window:'rect'})).status,409);
  client.write(messages(demoScene(),2).join('\n')+'\n');await until(()=>service.state.continuous.completed===2);
  await until(()=>service.collector.job);
  assert.equal((await post('/continuous/stop',{})).status,200);await until(()=>commands.includes('CANCEL'));
  assert.equal(service.collector.job,null);assert.equal(service.state.continuous.enabled,false);
  const stoppedCommands=commands;await delay(700);assert.equal(commands,stoppedCommands);
  assert.equal(service.state.result.source,'dcs');assert.equal((await(await fetch(base+'/state')).json()).canReprocess,true);
  assert.equal((await post('/reprocess',{window:'rect'})).status,202);await until(()=>service.state.result&&service.state.result.metadata.window==='rect');
  assert.equal(service.state.continuous.completed,2);assert.deepEqual(fs.readdirSync(root),[]);
});

test('Continuous capture waits across disconnect/stale status and keeps retrying after repeated failures',async t=>{
  const service=createService({tcpPort:0,httpPort:0,processing:{scatterSpacing:4,width:65}});t.after(()=>service.close());
  const ports=await service.started,base=`http://127.0.0.1:${ports.httpPort}`;
  await fetch(base+'/continuous/start',{method:'POST',body:'{"side":-1,"range":10000}'});
  async function connect(){const c=net.createConnection({host:'127.0.0.1',port:ports.tcpPort});t.after(()=>c.destroy());await new Promise(r=>c.once('connect',r));c.write('HELLO,SAR1\nSTATUS,42,terrain.GetHeight,0,0,0\n');return c;}
  let client=await connect();await until(()=>service.collector.job);
  service.collector.status.received=Date.now()-4000;await until(()=>!service.collector.job);
  assert.equal(service.state.continuous.enabled,true);assert.equal(service.state.continuous.failures,0);
  client.destroy();await until(()=>!service.collector.status);assert.equal(service.state.continuous.enabled,true);
  client=await connect();await until(()=>service.collector.job);
  // Failures are counted and displayed but never stop the loop: it keeps offering new captures.
  for(let i=1;i<=4;i++){
    client.write(`FAIL,${service.collector.job.id},ground_speed_too_low\n`);
    await until(()=>service.state.continuous.failures===i);
    assert.equal(service.state.continuous.enabled,true);
    assert.match(service.state.continuous.note,/本次失败/);
    client.write('STATUS,43,terrain.GetHeight,0,0,0\n');await until(()=>service.collector.job);
  }
  assert.equal(service.state.continuous.failures,4);
  client.write(messages(demoScene(),service.collector.job.id).join('\n')+'\n');await until(()=>service.state.continuous.completed===1);
  assert.equal(service.state.continuous.failures,0);assert.equal(service.state.continuous.enabled,true);
  assert.equal((await fetch(base+'/continuous/stop',{method:'POST',body:'{}'})).status,200);
  assert.equal(service.state.continuous.enabled,false);
});

test('Continuous options reject invalid, foreign-origin and replay starts; explicit recording remains opt-in',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aesa-sar-continuous-save-'));
  const service=createService({tcpPort:0,httpPort:0,recordDir:root,processing:{scatterSpacing:4,width:65}});
  t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
  const ports=await service.started,base=`http://127.0.0.1:${ports.httpPort}`;
  for(const params of [{side:2,range:20000},{side:1,range:500},{side:1,range:20000,record:'yes'}])assert.equal((await fetch(base+'/continuous/start',{method:'POST',body:JSON.stringify(params)})).status,409);
  assert.equal(service.state.continuous.enabled,false);
  assert.equal((await fetch(base+'/continuous/start',{method:'POST',headers:{Origin:'https://foreign.example'},body:'{"side":1,"range":20000}'})).status,403);
  assert.equal((await fetch(base+'/continuous/start',{method:'POST',body:'{"side":1,"range":20000,"record":true}'})).status,202);
  const client=net.createConnection({host:'127.0.0.1',port:ports.tcpPort});t.after(()=>client.destroy());await new Promise(r=>client.once('connect',r));
  client.write('HELLO,SAR1\nSTATUS,42,terrain.GetHeight,0,0,0\n');await until(()=>service.collector.job);
  client.write(messages(demoScene(),1).join('\n')+'\n');await until(()=>service.state.phase==='计算复数回波与聚焦');
  await fetch(base+'/continuous/stop',{method:'POST',body:'{}'});
  await until(()=>service.state.continuous.completed===1);await delay(700);
  assert.equal(service.collector.job,null);assert.equal(service.state.continuous.enabled,false);assert.equal(fs.readdirSync(root).length,1);
  const record=service.state.record;
  assert.equal((await fetch(base+'/reprocess',{method:'POST',body:'{"window":"rect"}'})).status,202);
  await until(()=>service.state.result?.metadata.window==='rect');
  assert.equal(service.state.record,record);assert.equal(service.state.continuous.completed,1);assert.equal(fs.readdirSync(root).length,1);
  const replay=createService({tcpPort:0,httpPort:0,mode:'replay'});t.after(()=>replay.close());const p=await replay.started;
  assert.equal((await fetch(`http://127.0.0.1:${p.httpPort}/continuous/start`,{method:'POST',body:'{"side":1,"range":20000}'})).status,409);
});

test('Geographic targeting preserves requested and confirmed coordinates and rejects invalid targets',()=>{
  const c=new Collector();
  c.accept('STATUS,42,terrain.GetHeight,50,51,50,1');
  assert.equal(c.status.geo_available,true);
  assert.equal(c.startGeo(41.5,42.25),'CAPTURE_GEO,1,41.5,42.25\n');
  c.accept('TARGET,1,41.5,42.25,20000,45');
  let result;for(const line of messages(demoScene()))result=c.accept(line)||result;
  assert.deepEqual(result.target,{latitude:41.5,longitude:42.25,ground_range_m:20000,relative_track_deg:45});
  assert.deepEqual(result.target_request,{latitude:41.5,longitude:42.25});
  for(const [lat,lon] of [[91,42],[41,-181],[NaN,0],['41',42]])assert.throws(()=>c.startGeo(lat,lon));
  c.startGeo(41,42);assert.throws(()=>c.accept('TARGET,2,41,42,0,45'),/Invalid TARGET/);
  assert.throws(()=>c.accept('TARGET,2,41,43,20000,45'),/differ from request/);
  const missing=new Collector();missing.startGeo(41,42);
  assert.throws(()=>{for(const line of messages(demoScene()))missing.accept(line);},/missing confirmed TARGET/);
  const legacy=new Collector();legacy.accept('STATUS,42,terrain.GetHeight,50,51,50');assert.equal(legacy.status.geo_available,false);
});
test('Capture protocol accepts the actual seven-field Lua BEGIN and all ordered samples',()=>{
  const c=new Collector();c.start(1,20000);let result;
  for(const line of messages(demoScene()))result=c.accept(line)||result;
  assert.equal(result.source,'dcs');assert.equal(result.terrain.length,289);assert.equal(c.job,null);
});
test('Protocol rejects missing terrain, duplicate poses and incomplete END',()=>{
  const scene=demoScene();
  for(const alter of [lines=>lines.splice(20,1),lines=>lines.splice(300,0,lines[299]),lines=>lines[lines.length-1]='END,1,120,2']){
    const lines=messages(scene),c=new Collector();c.start(1,20000);alter(lines);
    assert.throws(()=>{for(const line of lines)c.accept(line);});
  }
});
test('END between two scheduled pose samples is valid, but missing final trajectory is rejected',()=>{
  const scene=demoScene(),lines=messages(scene),c=new Collector();c.start(1,20000);
  lines[lines.length-1]='END,1,121,2.005';let result;
  for(const line of lines)result=c.accept(line)||result;
  assert.equal(result.trajectory.length,121);
  const bad=messages(scene),d=new Collector();d.start(1,20000);bad[bad.length-1]='END,1,121,2.05';
  assert.throws(()=>{for(const line of bad)d.accept(line);},/Incomplete END/);
});
test('No fabricated interpolation across long trajectory gaps or model-time reset',()=>{
  for(const mutate of [s=>s.trajectory.splice(10,20),s=>s.trajectory[20].t=0,s=>s.terrain[0][1]=NaN,s=>s.terrain[0][0]+=10]){
    const scene=demoScene();mutate(scene);assert.throws(()=>validate(scene));
  }
});
test('Ground surface interpolation retains queried grid heights',()=>{
  const scene=demoScene();for(let i=0;i<289;i++){const c=(i%17/16-.5)*128,r=(Math.floor(i/17)/16-.5)*128;
    assert.ok(Math.abs(pixel(scene,c,r)[1]-scene.terrain[i][1])<1e-10);}
});
test('Actual curved 3D positions drive coherent image; deterministic phase survives replay',()=>{
  const scene=demoScene();scene.trajectory.forEach(p=>{p.pos[1]+=Math.sin(p.t)*10;p.pos[2]+=p.t*p.t*20;});
  const a=reconstruct(scene),b=reconstruct(JSON.parse(JSON.stringify(scene))),erased=reconstruct(scene,{erasePhase:true});
  assert.deepEqual(a.power,b.power);assert.equal(a.width,129);assert.ok(a.db.every(Number.isFinite));
  assert.ok(a.power.some((v,i)=>Math.abs(v-erased.power[i])>.01));
  assert.equal(a.metadata.terrain_spacing_m,8);
  // The uniform model carries the same one-look occlusion mask as the classified one, so the
  // metadata reports the model instead of claiming that nothing is modelled.
  assert.equal(a.metadata.shadow,true);assert.equal(a.metadata.shadow_look,'center');
  assert.match(a.metadata.visibility,/aperture centre.*outside patch unknown/);
  assert.equal(a.metadata.shadowed_objects,0);assert.equal(a.metadata.shadow_objects,0);
  assert.equal(a.metadata.shadowed_scatterers,a.metadata.shadowed_terrain+a.metadata.shadowed_objects);
});
test('Forward aperture fails instead of promising fine cross-range resolution',()=>{
  const scene=demoScene();const end=scene.trajectory.at(-1).pos;
  scene.trajectory.forEach(p=>{const f=p.t/2;p.pos=scene.center.map((v,i)=>v+(i===1?4000:20000)*(1-f*.01));});
  // Straight radial flight: no transverse aperture relative to patch center.
  assert.throws(()=>reconstruct(scene),/transverse aperture/);
});
test('Loopback TCP → collection → recording → worker → HTTP raster, including split lines',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aesa-sar-live-'));
  const service=createService({tcpPort:0,httpPort:0,recordDir:root});
  t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
  const ports=await service.started,base=`http://127.0.0.1:${ports.httpPort}`;
  const client=net.createConnection({host:'127.0.0.1',port:ports.tcpPort});t.after(()=>client.destroy());
  await new Promise(r=>client.once('connect',r));client.write('HELLO,SA');client.write('R1\nSTATUS,42,terrain.GetHeight,50,51,50,1\n');
  await until(()=>service.collector.status);
  assert.equal((await fetch(base+'/capture',{method:'POST',body:'{"latitude":91,"longitude":42}'})).status,409);
  const command=new Promise(r=>client.once('data',b=>r(b.toString())));
  assert.equal((await fetch(base+'/capture',{method:'POST',body:JSON.stringify({latitude:41.5,longitude:42.25})})).status,202);
  assert.match(await command,/CAPTURE_GEO,1,41.5,42.25/);
  client.write('TARGET,1,41.5,42.25,20000,45\n'+messages(demoScene()).join('\n')+'\n');
  await until(()=>service.state.result||service.state.error);
  assert.equal(service.state.error,null);
  // D3: /state carries the summary and the sequence number; the matrix comes from /image/<seq>.
  const state=await (await fetch(base+'/state')).json();assert.equal(state.result.source,'dcs');assert.equal(state.result.db,undefined,'the poll carries no matrix');
  const image=await(await fetch(base+'/image/'+state.resultSeq)).json();assert.equal(image.db.length,129*129);assert.equal(image.db_ref,'frame_peak');
  assert.equal(state.db_ref,'frame_peak','the declared scale is the one the image is on');
  assert.equal(state.target.longitude,42.25);
  const files=fs.readdirSync(root);assert.equal(files.length,1);assert.equal(JSON.parse(fs.readFileSync(path.join(root,files[0]))).trajectory.length,121);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,files[0]))).target.latitude,41.5);
  assert.match(await (await fetch(base)).text(),/模拟复数回波/);
  assert.equal((await fetch(base+'/capture',{method:'POST',headers:{Origin:'https://foreign.example'},body:'{}'})).status,403);
});
test('Disconnect discards partial scene; unavailable terrain cannot trigger capture',async t=>{
  const service=createService({tcpPort:0,httpPort:0});t.after(()=>service.close());const ports=await service.started;
  const client=net.createConnection({host:'127.0.0.1',port:ports.tcpPort});await new Promise(r=>client.once('connect',r));
  client.write('HELLO,SAR1\nSTATUS,42,unavailable,unknown,0,0\n');await until(()=>service.collector.status);
  const r=await fetch(`http://127.0.0.1:${ports.httpPort}/capture`,{method:'POST',body:'{"side":1,"range":20000}'});assert.equal(r.status,409);
  service.collector.start(1,20000);client.destroy();await until(()=>service.state.error);assert.equal(service.collector.job,null);assert.equal(service.state.result,null);
});
test('Recorded data can be reprocessed with another window while Export is disconnected',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aesa-sar-reprocess-'));
  const scene=demoScene(),original=JSON.stringify(scene);
  const service=createService({tcpPort:0,httpPort:0,recordDir:root,scene,mode:'replay',processing:{window:'hann',scatterSpacing:4,width:65}});
  t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
  const ports=await service.started,base=`http://127.0.0.1:${ports.httpPort}`;
  await until(()=>service.state.result);const first=service.state.result;
  let state=await(await fetch(base+'/state')).json();assert.equal(state.canCapture,false);assert.equal(state.canReprocess,true);assert.equal(first.metadata.window,'hann');
  assert.equal((await fetch(base+'/reprocess',{method:'POST',body:'{"window":"invalid"}'})).status,409);
  assert.equal((await fetch(base+'/reprocess',{method:'POST',headers:{Origin:'https://foreign.example'},body:'{"window":"rect"}'})).status,403);
  assert.equal((await fetch(base+'/reprocess',{method:'POST',body:'{"window":"rect"}'})).status,202);
  await until(()=>service.state.result);const second=service.state.result;
  assert.equal(second.metadata.window,'rect');assert.notDeepEqual(first.power,second.power);assert.equal(JSON.stringify(scene),original);
  assert.deepEqual(fs.readdirSync(root),[]);assert.equal(second.source,'synthetic-demo');assert.equal(service.state.mode,'replay');
  // Repeating the same processing is deterministic and does not fabricate a new capture.
  assert.equal((await fetch(base+'/reprocess',{method:'POST',body:'{"window":"rect"}'})).status,202);await until(()=>service.state.result);
  assert.deepEqual(service.state.result.power,second.power);
});
test('Failed new capture cannot silently reprocess an older scene as current data',async t=>{
  const service=createService({tcpPort:0,httpPort:0,scene:demoScene(),processing:{scatterSpacing:4,width:65}});t.after(()=>service.close());
  const ports=await service.started,base=`http://127.0.0.1:${ports.httpPort}`;await until(()=>service.state.result);
  const client=net.createConnection({host:'127.0.0.1',port:ports.tcpPort});t.after(()=>client.destroy());await new Promise(r=>client.once('connect',r));
  client.write('HELLO,SAR1\nSTATUS,42,terrain.GetHeight,50,51,50\n');await until(()=>service.collector.status);
  assert.equal((await fetch(base+'/capture',{method:'POST',body:'{"side":1,"range":20000}'})).status,202);
  client.write('FAIL,1,terrain_query_failed\n');await until(()=>service.state.error);
  const state=await(await fetch(base+'/state')).json();assert.equal(state.canReprocess,false);
  assert.equal((await fetch(base+'/reprocess',{method:'POST',body:'{"window":"rect"}'})).status,409);
});

test('A MAP patrol is preempted by a manual SAR designation and resumes by itself',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aesa-sar-patrol-'));
  const service=createService({tcpPort:0,httpPort:0,recordDir:root,processing:{scatterSpacing:4,width:65}});
  t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
  const ports=await service.started,base=`http://127.0.0.1:${ports.httpPort}`;
  const exporter=await liveExport(t,ports.tcpPort);
  await until(()=>service.collector.capabilities?.map===true,'map capability');
  // A first patch teaches the service where the aircraft is, so the patrol places its window in world
  // coordinates instead of first asking for the 2x2 ownship probe.
  const first=await captureScene(service,base,exporter,demoScene());
  assert.equal((await fetch(base+'/continuous/start',{method:'POST',body:'{"mode":"map","range":12000,"cell":500}'})).status,202);
  await until(()=>service.collector.map,'patrol map job');
  const preempted=service.collector.map.id;
  assert.match(exporter.commands(),new RegExp(`CAPTURE_MAP,${preempted},`));
  assert.equal((await(await fetch(base+'/state')).json()).canCapture,true,'a patrol leaves the manual capture available');
  // The designation takes the beam: the pending map job is cancelled and the SAR capture is accepted.
  const capture=await fetch(base+'/capture',{method:'POST',body:'{"side":-1,"range":12000}'});
  assert.equal(capture.status,202);assert.ok(Number.isSafeInteger((await capture.json()).id));
  assert.equal(service.collector.map,null);assert.match(exporter.commands(),/CANCEL/);
  assert.match(service.state.map.note,/抢占/);
  assert.equal(service.state.continuous.enabled,true,'the patrol is preempted, not stopped');
  assert.equal((await(await fetch(base+'/state')).json()).canCapture,false,'an in-flight SAR job blocks the next one');
  // Late lines of the cancelled job must neither resurrect it nor reach the lattice, and a late FAIL
  // must not be mistaken for a failure of the SAR job that took the beam (the ids are distinct).
  exporter.client.write(`FAIL,${preempted},map_aborted\nMAPBEGIN,${preempted},0,0,10,10,500\nMAPHEIGHT,${preempted},0,0,0,100,0\nMAPEND,${preempted},100,1001\n`);
  await until(()=>service.collector.job,'sar capture request');
  exporter.client.write(messages(demoScene(),service.collector.job.id).join('\n')+'\n');
  await until(()=>service.state.result&&service.state.result!==first,'second image');
  assert.equal(service.state.error,null);
  assert.equal(service.state.map.cells,0,'the cancelled job delivered no cell and its late lines were dropped');
  assert.equal(service.state.continuous.enabled,true,'the patrol survived the preemption');
  assert.equal((await(await fetch(base+'/state')).json()).map.active,true,'the map session is still running');
  // The loop resumes on its own, with a new job id, from the lattice the preemption left behind.
  await until(()=>service.collector.map&&service.collector.map.id!==preempted,'resumed patrol job');
  assert.match(exporter.commands(),new RegExp(`CAPTURE_MAP,${service.collector.map.id},`));
  assert.equal((await(await fetch(base+'/state')).json()).canCapture,true);
  assert.equal((await fetch(base+'/continuous/stop',{method:'POST',body:'{}'})).status,200);
});

test('Continuous relative and sweep keep the beam, and a patrol still refuses reprocess and map shots',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aesa-sar-ownbeam-'));
  const service=createService({tcpPort:0,httpPort:0,recordDir:root,processing:{scatterSpacing:4,width:65}});
  t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
  const ports=await service.started,base=`http://127.0.0.1:${ports.httpPort}`;
  const exporter=await liveExport(t,ports.tcpPort);
  await until(()=>service.collector.capabilities?.map===true,'capabilities');
  for(const params of [{mode:'relative',side:1,range:20000},{mode:'sweep',side:1,range:20000,sweepSize:512}]){
    assert.equal((await fetch(base+'/continuous/start',{method:'POST',body:JSON.stringify(params)})).status,202);
    await until(()=>service.collector.job,`${params.mode} capture`);
    const refused=await fetch(base+'/capture',{method:'POST',body:'{"side":1,"range":20000}'});
    assert.equal(refused.status,409,`${params.mode} keeps the refusal`);
    assert.match((await refused.json()).error,/Stop continuous capture/);
    // DBS is a MAP-family block: only a MAP patrol gives way to it, a relative/sweep plan owns the beam.
    const refusedDbs=await fetch(base+'/dbs',{method:'POST',body:'{"x":0,"z":12000}'});
    assert.equal(refusedDbs.status,409,`${params.mode} refuses a DBS block`);
    assert.match((await refusedDbs.json()).error,/Stop continuous capture/);
    const state=await(await fetch(base+'/state')).json();
    assert.deepEqual([state.canCapture,state.canReprocess,state.canStartContinuous],[false,false,false]);
    assert.equal((await fetch(base+'/continuous/stop',{method:'POST',body:'{}'})).status,200);
  }
  // During a MAP patrol only the SAR patch capture is let in; the other write routes keep their refusal,
  // so the patrol's own loop stays the single owner of the map session (canReprocess stays false).
  await captureScene(service,base,exporter,demoScene());
  assert.equal((await fetch(base+'/continuous/start',{method:'POST',body:'{"mode":"map","range":12000,"cell":500}'})).status,202);
  await until(()=>service.collector.map,'patrol map job');
  assert.equal((await fetch(base+'/reprocess',{method:'POST',body:'{"window":"rect"}'})).status,409);
  assert.equal((await fetch(base+'/map',{method:'POST',body:'{"range":12000,"cell":500}'})).status,409);
  const state=await(await fetch(base+'/state')).json();
  assert.deepEqual([state.canCapture,state.canReprocess],[true,false]);
  assert.equal((await fetch(base+'/continuous/stop',{method:'POST',body:'{}'})).status,200);
});

test('Designation check states the side-looking window, the range limits and the missing pose',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aesa-sar-designate-'));
  const service=createService({tcpPort:0,httpPort:0,recordDir:root,processing:{scatterSpacing:4,width:65}});
  t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
  const ports=await service.started,base=`http://127.0.0.1:${ports.httpPort}`;
  // Without any pose there is nothing to measure the geometry from.
  const none=await fetch(base+'/designate/check?x=0&z=0');
  assert.equal(none.status,409);assert.match((await none.json()).error,/No aircraft pose/);
  assert.equal((await fetch(base+'/designate/check?x=abc&z=1')).status,400);
  assert.equal((await fetch(base+'/designate/check?x=1e9&z=0')).status,400);
  assert.equal((await fetch(base+'/designate/check')).status,400);
  const exporter=await liveExport(t,ports.tcpPort);
  await until(()=>service.collector.status,'export status');
  await captureScene(service,base,exporter,demoScene());
  const own=(await(await fetch(base+'/state')).json()).ownship,head=own.heading_deg*Math.PI/180;
  // Points are named by literal world offsets, so none of the expected numbers restates the formula they
  // are meant to check. The demo flight runs along +x at heading 90°, and the Export's sign rule (its
  // bearing atan2(dz,dx) minus its track atan2(vz,vx), positive to the right) makes +z abeam right and
  // -z abeam left — the 正右/负左 convention the page shows.
  assert.ok(Math.abs(own.heading_deg-90)<.1,`the compass cases below assume the demo heading (got ${own.heading_deg})`);
  const check=async(dx,dz)=>{
    const response=await fetch(`${base}/designate/check?x=${own.pos[0]+dx}&z=${own.pos[2]+dz}`);
    return {status:response.status,body:await response.json()};
  };
  // The angle is defined by the Export, so it is compared against the Export's own arithmetic on the
  // same vectors — with the atan2 normalisation that makes ±180 the same direction.
  const track=Math.atan2(own.speed_mps*Math.cos(head),own.speed_mps*Math.sin(head));
  const exportAngle=(dx,dz)=>{const difference=Math.atan2(dz,dx)-track;return Math.atan2(Math.sin(difference),Math.cos(difference))*180/Math.PI;};
  const sameAngle=(a,b)=>Math.abs(((a-b+540)%360)-180)<.2;
  const right=await check(0,20000);
  assert.equal(right.status,200);
  assert.deepEqual([right.body.ok,right.body.reasons,right.body.side,right.body.flightIssue],[true,[],1,null]);
  assert.ok(Math.abs(right.body.range_km-20)<.01);
  assert.ok(Math.abs(right.body.relative_track_deg-90)<.1,`abeam right reads +90, got ${right.body.relative_track_deg}`);
  const left=await check(0,-10000);
  assert.deepEqual([left.body.ok,left.body.side],[true,-1]);
  assert.ok(Math.abs(left.body.relative_track_deg+90)<.1,'abeam left is negative');
  for(const [dx,dz] of [[0,20000],[0,-20000],[20000,0],[-20000,0],[0,60000]]){
    const body=(await check(dx,dz)).body;
    assert.ok(sameAngle(body.relative_track_deg,exportAngle(dx,dz)),
      `offset ${dx},${dz} reads ${body.relative_track_deg}, the Export reads ${exportAngle(dx,dz).toFixed(1)}`);
  }
  const ahead=await check(20000,0);
  assert.deepEqual([ahead.body.ok,ahead.body.reasons.length],[false,1]);
  assert.match(ahead.body.reasons[0],/侧视窗/);
  const near=await check(0,400);
  assert.deepEqual([near.body.ok,near.body.reasons.length],[false,1]);
  assert.match(near.body.reasons[0],/下限/);
  const far=await check(0,60000);
  assert.deepEqual([far.body.ok,far.body.reasons.length],[false,1]);
  assert.match(far.body.reasons[0],/上限/);
  const both=await check(-600,0);
  assert.equal(both.body.ok,false);assert.equal(both.body.reasons.length,2,'距离与斜视角各违反一条');
  const here=await check(0,0);
  assert.deepEqual([here.body.ok,here.body.reasons.length,here.body.relative_track_deg],[false,1,0]);
});

test('Designation check carries the flight advice only while the newest capture is fresh',async t=>{
  // A bent final leg: the two halves of the 2 s track differ by 20°, so the flight gate reads 20°/s of
  // turn — a flight the continuous loop would wait out, and exactly what the advice field reports.
  const bend=deg=>{const scene=demoScene(),trajectory=scene.trajectory,mid=Math.floor(trajectory.length/2),pivot=trajectory[mid].pos,rad=deg*Math.PI/180;
    for(let i=mid+1;i<trajectory.length;i++){
      const dx=trajectory[i].pos[0]-pivot[0],dz=trajectory[i].pos[2]-pivot[2];
      trajectory[i].pos=[+(pivot[0]+dx*Math.cos(rad)-dz*Math.sin(rad)).toFixed(4),trajectory[i].pos[1],+(pivot[2]+dx*Math.sin(rad)+dz*Math.cos(rad)).toFixed(4)];
    }return scene;};
  for(const [gateWindowMs,expected] of [[undefined,/转弯率 20.0°\/s/],[0,null]]){
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'aesa-sar-advice-'));
    const service=createService({tcpPort:0,httpPort:0,recordDir:root,processing:{scatterSpacing:4,width:65},...(gateWindowMs===undefined?{}:{gateWindowMs})});
    t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
    const ports=await service.started,base=`http://127.0.0.1:${ports.httpPort}`;
    const exporter=await liveExport(t,ports.tcpPort);
    await until(()=>service.collector.status,'export status');
    await captureScene(service,base,exporter,bend(20));
    const own=(await(await fetch(base+'/state')).json()).ownship;
    // Abeam to the right of the final (turned) heading: relative = heading - bearing = +90, which keeps
    // the geometry itself imageable whatever the flight gate says.
    const abeamRight=own.heading_deg*Math.PI/180-Math.PI/2;
    const body=await(await fetch(`${base}/designate/check?x=${own.pos[0]+20000*Math.sin(abeamRight)}&z=${own.pos[2]+20000*Math.cos(abeamRight)}`)).json();
    assert.equal(body.ok,true,'the geometry itself is imageable whatever the flight does');
    assert.ok(Math.abs(body.relative_track_deg-90)<.1,`abeam right reads +90, got ${body.relative_track_deg}`);
    if(expected)assert.match(body.flightIssue,expected);else assert.equal(body.flightIssue,null,'a capture past the gate window says nothing');
  }
});

test('A MAP watch with no SAR capture behind it answers designations from its own pose',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aesa-sar-mappose-'));
  const service=createService({tcpPort:0,httpPort:0,recordDir:root,processing:{scatterSpacing:4,width:65}});
  t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
  const ports=await service.started,base=`http://127.0.0.1:${ports.httpPort}`;
  const exporter=await liveExport(t,ports.tcpPort,{answerMap:true});
  await until(()=>service.collector.capabilities?.map===true,'map capability');
  assert.equal((await fetch(base+'/designate/check?x=0&z=10000')).status,409,'nothing is known before the watch runs');
  assert.equal((await fetch(base+'/continuous/start',{method:'POST',body:'{"mode":"map","range":12000,"cell":500}'})).status,202);
  await until(async()=>{const s=await(await fetch(base+'/state')).json();return s.map.pose&&s.map.pose.heading_deg!==null;},'map pose with heading');
  const state=await(await fetch(base+'/state')).json();
  assert.equal(state.result,null,'the watch is the only pose source: no SAR patch was ever captured');
  assert.equal(state.continuous.mode,'map');
  assert.equal((await fetch(base+'/reprocess',{method:'POST',body:'{"window":"rect"}'})).status,409,'there is nothing to reprocess');
  // The watch's own pose is a full pose, so the geometry rule reads exactly as it does with a SAR
  // trajectory: the fake ownship drifts along +x, so a point at +z is abeam right.
  const pose=state.map.pose;
  const body=await(await fetch(`${base}/designate/check?x=${pose.pos[0]}&z=${pose.pos[2]+20000}`)).json();
  assert.deepEqual([body.ok,body.reasons,body.side,body.flightIssue],[true,[],1,null]);
  assert.ok(Math.abs(body.range_km-20)<.01&&Math.abs(body.relative_track_deg-90)<.1,
    `range ${body.range_km} km, abeam right ${body.relative_track_deg}`);
  // The sector is the aircraft's own forward wedge, so it is centred on the watch's own position and
  // points along the heading it flies (+x here). The old square window was offset 45 deg to one side;
  // a real-beam map has no side to sit on, and this is the assertion that witnessed that offset.
  assert.ok(state.map.window&&state.map.window.center,`a sector has been placed (${JSON.stringify(state.map.window)})`);
  const anchorOffset=Math.hypot(state.map.window.center[0]-pose.pos[0],state.map.window.center[1]-pose.pos[2]);
  assert.ok(anchorOffset<=500,`the sector is centred on the aircraft (off by ${anchorOffset.toFixed(0)} m, one lattice rounding)`);
  assert.deepEqual([state.map.window.cells,state.map.window.sector.range_m,state.map.window.sector.azimuth_deg],[49,12000,60]);
  assert.ok(Math.abs(state.map.window.sector.heading_deg-90)<1,`the sector points along the +x heading (${state.map.window.sector.heading_deg})`);
  assert.equal(state.map.params.side,undefined,'the patrol summary reports the sector, not a side');
  assert.equal((await fetch(base+'/continuous/stop',{method:'POST',body:'{}'})).status,200);
});

test('A MAP patrol re-anchors its sector when the heading changes',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aesa-sar-mapturn-'));
  const service=createService({tcpPort:0,httpPort:0,recordDir:root,processing:{scatterSpacing:4,width:65}});
  t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
  const ports=await service.started,base=`http://127.0.0.1:${ports.httpPort}`;
  const exporter=await liveExport(t,ports.tcpPort,{answerMap:true});
  await until(()=>service.collector.capabilities?.map===true,'map capability');
  assert.equal((await fetch(base+'/continuous/start',{method:'POST',body:'{"mode":"map","range":20000,"cell":250}'})).status,202);
  await until(async()=>{const s=await(await fetch(base+'/state')).json();return s.map.window&&s.map.window.sector;},'first sector');
  const first=await(await fetch(base+'/state')).json();
  assert.ok(Math.abs(first.map.window.sector.heading_deg-90)<1,`the sector starts on the +x heading (${first.map.window.sector.heading_deg})`);
  // The aircraft turns 35 deg without flying anywhere far: a sector that keeps aiming down the old nose
  // would spend its collection on ground the antenna no longer looks at. The plan that follows has to be
  // the new wedge — and part of it is ground the old wedge never contained, which is what a turn costs.
  const before=exporter.requests.length;
  exporter.own.heading=90*Math.PI/180-35*Math.PI/180;
  await until(()=>exporter.requests.slice(before).some(request=>request.relative===false),'re-anchored sector job');
  const turned=await(await fetch(base+'/state')).json();
  assert.ok(Math.abs(turned.map.window.sector.heading_deg-55)<1,`the sector follows the turn (${turned.map.window.sector.heading_deg})`);
  const moved=Math.hypot(turned.map.window.center[0]-first.map.window.center[0],turned.map.window.center[1]-first.map.window.center[1]);
  assert.ok(moved<1000,`the turn alone re-anchored it: the aircraft stayed put (${moved.toFixed(0)} m)`);
  const cells=[];
  for(const request of exporter.requests.slice(before)){
    if(request.relative)continue;
    for(let col=0;col<request.cols;col++)for(let row=0;row<request.rows;row++)
      cells.push([request.origin[0]+col*request.step,request.origin[1]+row*request.step]);
  }
  const newMask=map.sectorMask({center:turned.map.window.center,heading:55*Math.PI/180,azimuth_deg:60,range_m:20000});
  const oldMask=map.sectorMask({center:first.map.window.center,heading:Math.PI/2,azimuth_deg:60,range_m:20000});
  assert.ok(cells.length>0,'the new sector was collected');
  assert.ok(cells.every(([x,z])=>newMask(x,z)),'every newly asked cell is inside the new wedge');
  assert.ok(cells.some(([x,z])=>!oldMask(x,z)),'and the collection left the old wedge behind for ground the new nose reaches');
  assert.equal((await fetch(base+'/continuous/stop',{method:'POST',body:'{}'})).status,200);
});

test('A MAP position without a heading stays unknown instead of reading as north',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aesa-sar-mapnorth-'));
  const service=createService({tcpPort:0,httpPort:0,recordDir:root,processing:{scatterSpacing:4,width:65}});
  t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
  const ports=await service.started,base=`http://127.0.0.1:${ports.httpPort}`;
  // One pose per job and the ownship never moves: consecutive poses (across jobs or not) have no
  // displacement, so no heading can be derived from them.
  const exporter=await liveExport(t,ports.tcpPort,{answerMap:true,mapPoses:1});
  await until(()=>service.collector.capabilities?.map===true,'map capability');
  assert.equal((await fetch(base+'/continuous/start',{method:'POST',body:'{"mode":"map","range":12000,"cell":500}'})).status,202);
  await until(async()=>{const s=await(await fetch(base+'/state')).json();return s.map.pose&&s.map.pose.pos;},'map position');
  const state=await(await fetch(base+'/state')).json();
  assert.equal(state.map.pose.heading_deg,null,'poses that do not move yield no heading');
  // The patrol no longer places a fallback window while the heading is unknown: it keeps probing,
  // and a squint angle is never fabricated from the north-pointing fallback.
  assert.ok(state.map.active&&state.continuous.enabled,'the patrol itself carries on');
  assert.equal(state.map.window,null,'no window is placed before the heading is known');
  const refused=await fetch(base+'/designate/check?x=0&z=10000');
  assert.equal(refused.status,409);assert.match((await refused.json()).error,/No aircraft pose/);
  assert.equal((await fetch(base+'/continuous/stop',{method:'POST','body':'{}'})).status,200);
});

test('A patrol of one-pose jobs still learns the heading from the pair across jobs',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aesa-sar-mapheading-'));
  const service=createService({tcpPort:0,httpPort:0,recordDir:root,processing:{scatterSpacing:4,width:65}});
  t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
  const ports=await service.started,base=`http://127.0.0.1:${ports.httpPort}`;
  // The real Export's 0.25 s pose gate gives a thin sector job exactly one pose: the only pair a
  // heading can ever come from spans two jobs. Fly the ownship between probes and the service must
  // learn it — this is the regime that left the sector pointing at the heading-0 fallback in flight.
  const exporter=await liveExport(t,ports.tcpPort,{answerMap:true,mapPoses:1});
  await until(()=>service.collector.capabilities?.map===true,'map capability');
  assert.equal((await fetch(base+'/continuous/start',{method:'POST',body:'{"mode":"map","range":12000,"cell":500}'})).status,202);
  await until(async()=>{const s=await(await fetch(base+'/state')).json();return s.map.pose&&s.map.pose.pos;},'first probe');
  exporter.own.x+=500;
  await until(async()=>{const s=await(await fetch(base+'/state')).json();return s.map.pose&&s.map.pose.heading_deg!==null;},'cross-job heading');
  const posed=await(await fetch(base+'/state')).json();
  assert.ok(Math.abs(posed.map.pose.heading_deg-90)<1,`heading from the cross-job pair points along +x (${posed.map.pose.heading_deg})`);
  await until(async()=>{const s=await(await fetch(base+'/state')).json();return s.map.window!==null;},'window after the heading is known');
  const state=await(await fetch(base+'/state')).json();
  assert.ok(Math.abs(state.map.window.sector.heading_deg-90)<1,`the first placed sector already points along the learned heading (${state.map.window.sector.heading_deg})`);
  assert.equal((await fetch(base+'/continuous/stop',{method:'POST',body:'{}'})).status,200);
});

// A complete MAP job in protocol order: the origin, one height per cell in row-major order, the given
// pose frames and a closing MAPEND. The first frame's number is the job's baseline, so a test can
// speak for either numbering convention.
function mapJobLines(id,poses,{cols=2,rows=2,step=500,x0=0,z0=0}={}){
  const lines=[`MAPBEGIN,${id},${x0},${z0},${cols},${rows},${step}`];
  for(let row=0;row<rows;row++)for(let col=0;col<cols;col++)
    lines.push(`MAPHEIGHT,${id},${col},${row},${x0+col*step},100,${z0+row*step}`);
  for(const pose of poses)lines.push(`MAPPOSE,${id},${pose.seq},${pose.t},${x0+12},3000,${z0},250,0`);
  lines.push(`MAPEND,${id},${cols*rows},${poses.length?poses.at(-1).t:1}`);
  return lines;}

test('The map pose stream takes the first frame as its numbering baseline and is strict after it',()=>{
  // The Export deployed in DCS numbers the first map pose of a job 1 — its SAR POSE stream starts at 0 —
  // so a service that insisted on 0 refused every real map job at its very first frame. The first frame
  // now sets the baseline, whichever integer it carries, and from the second frame on the step is
  // strictly +1: a dropped or reordered frame still fails the job instead of shifting the ownship track
  // silently. (The numbers themselves are never the aircraft's position — that is what the frames say.)
  const run=poses=>{
    const collector=new Collector();collector.startMap({x0:0,z0:0,cols:2,rows:2,step:500});
    const id=collector.map.id;
    let completed;for(const line of mapJobLines(id,poses))completed=collector.accept(line)||completed;
    return {collector,completed};};
  for(const base of [0,1,7,42]){
    const {collector,completed}=run([{seq:base,t:1},{seq:base+1,t:1.25}]);
    assert.equal(collector.map,null,`a job starting at ${base} completes`);
    assert.deepEqual(completed.poses.map(pose=>pose.t),[1,1.25],`both frames kept for base ${base}`);
    assert.deepEqual(completed.poses.map(pose=>pose.pos[0]),[12,12],`frames carry the reported position`);
  }
  for(const [label,poses] of [
    ['a jump',[{seq:0,t:1},{seq:2,t:2}]],
    ['a repeat',[{seq:0,t:1},{seq:0,t:2}]],
    ['a step backwards',[{seq:1,t:1},{seq:0,t:2}]],
    ['a fractional number',[{seq:.5,t:1}]],
    ['a time that goes backwards',[{seq:0,t:2},{seq:1,t:1}]]])
    assert.throws(()=>run(poses),/Invalid MAPPOSE/,`${label} is refused`);
});

// --- surface vocabulary (16-class probe + legacy five) ---------------------------------------------
// The native probe answers a comma-joined, bit-ascending class name list per point ("Land,Road,Town");
// the wire protocol is comma-separated itself, so a union travels '+'-joined in one field. Both that and
// the old five-class vocabulary (digits 1-5, or land/sea/water/road/runway/unknown) have to work in the
// same job: an old Export, a new one and a mixed test harness must all be accepted.
function surfaceJob(surfaces){
  const collector=new Collector();collector.startMap({x0:0,z0:0,cols:2,rows:2,step:250});
  const id=collector.map.id,lines=[`MAPBEGIN,${id},0,0,2,2,250`];
  for(let index=0;index<4;index++){
    const col=index%2,row=Math.floor(index/2);
    lines.push(`MAPHEIGHT,${id},${col},${row},${col*250},100,${row*250}`);
    lines.push(`MAPSURFACE,${id},${col},${row},${surfaces[index]}`);
  }
  lines.push(`MAPEND,${id},4,1`);
  let completed;for(const line of lines)completed=collector.accept(line)||completed;
  return {collector,completed};
}
test('MAPSURFACE accepts both surface vocabularies and picks one class out of a union',()=>{
  const {collector,completed}=surfaceJob(['Land','3','Land+Runway+Road','Building+Land']);
  assert.equal(collector.map,null);
  assert.deepEqual(completed.surfaces.map(entry=>entry.name),['land','water','runway','building'],
    'legacy word, legacy digit, probe union (runway wins over road) and a building union');
  // Order in the union does not matter, case does not matter, and single probe classes pass through.
  assert.deepEqual(surfaceJob(['Town','town+field','Land+Traffic','SEA']).completed.surfaces.map(entry=>entry.name),
    ['town','town','traffic','sea']);
  // Structural garbage is still refused rather than silently misparsed: a comma inside a class list would
  // shift the fields, an empty or non-name token is not a class, and a 17th class is not in the vocabulary.
  for(const bad of ['Land,Road','','Land+','Land@Road','Land+Road+Train+Field+Beach+Town+Forest+Trees+River+Lake+Sea+Runway+Railway+Construction+Building+Traffic+Particle','x'.repeat(100)]){
    assert.throws(()=>surfaceJob([bad,'Land','Land','Land']),/Invalid MAPSURFACE/,`${JSON.stringify(bad)} is refused`);
  }
});

// --- COMPAT handshake (Gate 3 consumer switch) ------------------------------------------------------
// The SAR Export announces its compatibility profile right after CAPS as COMPAT,<profile_id>,<matrix_hash>.
// The service keeps that three-field summary on /state; the capability matrix itself stays in the probe log.
test('SAR COMPAT handshake is accepted after CAPS and exposed as a /state summary',async t=>{
  const service=createService({tcpPort:0,httpPort:0});t.after(()=>service.close());
  const ports=await service.started,base=`http://127.0.0.1:${ports.httpPort}`;
  const client=net.createConnection({host:'127.0.0.1',port:ports.tcpPort});t.after(()=>client.destroy());
  await new Promise(r=>client.once('connect',r));
  client.write('HELLO,SAR1\nCAPS,2,terrain.GetSurfaceType,map\nCOMPAT,dcs-2.9.30.28738-mt,1a2b3c4d\nSTATUS,42,terrain.GetHeight,50,51,50,1\n');
  await until(()=>service.state.compat,'compat handshake');
  assert.deepEqual({profile_id:service.state.compat.profile_id,matrix_hash:service.state.compat.matrix_hash},
    {profile_id:'dcs-2.9.30.28738-mt',matrix_hash:'1a2b3c4d'});
  assert.ok(Number.isFinite(service.state.compat.at),'the handshake carries an arrival time');
  assert.deepEqual([service.collector.capabilities.version,service.collector.capabilities.map],[2,true],'CAPS still parses independently');
  const state=await(await fetch(base+'/state')).json();
  assert.deepEqual(state.compat,service.state.compat);
  assert.deepEqual(Object.keys(state.compat).sort(),['at','matrix_hash','profile_id'],'only the summary, not the matrix');
  assert.equal(state.compat.caps,undefined);assert.equal(state.compat.matrix,undefined);
  client.destroy();
  await until(()=>service.state.compat===null,'compat is cleared with its connection');
  assert.equal((await(await fetch(base+'/state')).json()).compat,null);
});
test('COMPAT rejects malformed handshakes and preserves the explicit unknown fallback',()=>{
  const collector=new Collector();
  collector.accept('CAPS,2,terrain.GetSurfaceType');
  collector.accept('COMPAT,dcs-2.9.30.28738-mt,1a2b3c4d');
  assert.deepEqual([collector.compat.profile_id,collector.compat.matrix_hash],['dcs-2.9.30.28738-mt','1a2b3c4d']);
  assert.ok(Number.isFinite(collector.compat.at));
  for(const line of ['COMPAT','COMPAT,dcs-test','COMPAT,dcs-test,1a2b3c4d,extra','COMPAT,,1a2b3c4d',
    'COMPAT,dcs test,1a2b3c4d','COMPAT,dcs-test,NOTHEX','COMPAT,dcs-test,123456789'])
    assert.throws(()=>collector.accept(line),/Invalid compatibility handshake/,`${line} is refused`);
  collector.accept('COMPAT,unknown,unknown');
  assert.deepEqual([collector.compat.profile_id,collector.compat.matrix_hash],['unknown','unknown'],
    'the probe fail-closed value is kept, not replaced by a fabricated hash');
});

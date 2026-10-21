'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),http=require('node:http');
const {createService}=require('../tools/sar_live.cjs');
const {demoScene}=require('../tools/sar_demo_scene.cjs');
const {MosaicStore}=require('../tools/sar_service/mosaic_store.cjs');
const {PROTOCOL}=require('../src/shared/config.cjs');
function messages(scene,id=1){return [
  `BEGIN,${id},${scene.center[0]},${scene.center[2]},${scene.bearing},${scene.size},${scene.n}`,
  ...scene.terrain.map((p,i)=>`HEIGHT,${id},${i},${p.join(',')}`),
  ...scene.trajectory.map((p,i)=>`POSE,${id},${i},${p.t},${p.pos.join(',')}`),
  `END,${id},${scene.trajectory.length},${scene.trajectory.at(-1).t}`];}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(condition){for(let i=0;i<600;i++){if(await condition())return;await delay(20);}throw Error('wait timed out');}
// node:http instead of the global fetch: fetch refuses some well-known ports even when the service
// owns one as its OS-assigned ephemeral port (see the same helper in test_sar_live.cjs).
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
// Each capture uses a shifted patch so the anchors differ; shifting terrain and trajectory together
// keeps the scene geometry consistent.
function shiftedScene(offset){const scene=demoScene();scene.center[0]+=offset;scene.center[2]+=offset;
  for(const point of scene.terrain){point[0]+=offset;point[2]+=offset;}
  for(const pose of scene.trajectory){pose.pos[0]+=offset;pose.pos[2]+=offset;}
  return scene;}
async function openExport(t,port){const client=net.createConnection({host:'127.0.0.1',port});t.after(()=>client.destroy());
  let buffer='';client.on('data',chunk=>buffer+=chunk.toString());
  await new Promise(r=>client.once('connect',r));
  client.write('HELLO,SAR1\n');
  return {client,commands:()=>buffer,status:()=>client.write('STATUS,42,terrain.GetHeight,50,51,50,1\n')};}
const CONTROL={scatterSpacing:4,width:65};
test('Mosaic retains the newest images with world anchors and evicts the oldest',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aesa-sar-mosaic-'));
  const service=createService({tcpPort:0,httpPort:0,recordDir:root,mosaicLimit:3,processing:CONTROL});
  t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
  const ports=await service.started,base=`http://127.0.0.1:${ports.httpPort}`;
  const exporter=await openExport(t,ports.tcpPort);
  for(let i=0;i<4;i++){
    exporter.status();await delay(30);
    assert.equal((await fetch(base+'/capture',{method:'POST',body:'{"side":1,"range":20000}'})).status,202);
    await until(()=>exporter.commands().includes(`CAPTURE,${i+1},1,20000`));
    exporter.client.write(messages(shiftedScene(i*200),i+1).join('\n')+'\n');
    exporter.status();
    await until(()=>service.state.result&&service.state.completed);
  }
  const state=await(await fetch(base+'/state')).json();
  assert.equal(state.mosaic.limit,3);assert.equal(state.mosaic.count,3);assert.equal(state.mosaic.dropped,1);
  assert.equal(state.mosaic.latestSeq,4);assert.equal(state.mosaic.firstSeq,2);assert.equal(state.mosaic.dB_step,PROTOCOL.mosaic.db_step);
  assert.equal(state.mosaic.entries.length,3);assert.equal(state.mosaic.incremental,false);
  for(const entry of state.mosaic.entries){
    assert.equal(entry.db,undefined,'summaries carry no matrix');
    assert.equal(entry.width,65);assert.equal(entry.size_m,PROTOCOL.sar.default_size_m);
    assert.ok(Number.isFinite(entry.bearing)&&Number.isFinite(entry.center[0])&&Number.isFinite(entry.center[2]));
    assert.ok(Number.isInteger(entry.completed)&&entry.completed>0);
    assert.equal(entry.quality,'standard');assert.equal(entry.focuser,'backprojection');
  }
  assert.ok(state.mosaic.entries[1].center[0]-state.mosaic.entries[0].center[0]>199,'anchors differ per capture');
  assert.ok(JSON.stringify(state.mosaic).length<4000,'a poll carries summaries, not matrices');
  const incremental=await(await fetch(base+'/state?since=3')).json();
  assert.equal(incremental.mosaic.incremental,true);assert.equal(incremental.mosaic.entries.length,1);
  assert.equal(incremental.mosaic.entries[0].seq,4);
  const none=await(await fetch(base+'/state?since=4')).json();assert.equal(none.mosaic.entries.length,0);
  const retained=await(await fetch(base+'/image/4')).json();
  assert.equal(retained.seq,4);assert.equal(retained.db.length,65*65);
  assert.ok(retained.db.every(v=>Number.isInteger(v)&&v>=-160&&v<=0),'dB quantised to 0.25 dB steps');
  assert.equal((await fetch(base+'/image/1')).status,404,'evicted images are gone');
  assert.equal((await fetch(base+'/image/not-a-number')).status,404);
  const alias=await(await fetch(base+'/mosaic/4')).json();
  assert.equal(alias.seq,4,'/mosaic/<seq> 仍是 /image/<seq> 的兼容别名');
  assert.equal(service.state.continuous.skipped,0);
});
test('Anchored restored displays join the mosaic, unanchored ones do not',async t=>{
  const scene=shiftedScene(0);
  const result={source:'synthetic-demo',size_m:PROTOCOL.sar.default_size_m,width:65,db:Array(65*65).fill(-10),power:Array(65*65).fill(1),metadata:{window:'hann'}};
  const anchored=createService({tcpPort:0,httpPort:0,display:{completed:1000,result,target:null,scene}});
  t.after(()=>anchored.close());
  const ports=await anchored.started;
  const state=await(await fetch(`http://127.0.0.1:${ports.httpPort}/state`)).json();
  assert.equal(state.mosaic.count,1);assert.equal(state.mosaic.entries[0].seq,1);
  assert.deepEqual(state.mosaic.entries[0].center,scene.center);assert.equal(state.mosaic.entries[0].bearing,scene.bearing);
  assert.equal(state.mosaic.entries[0].source,'synthetic-demo');
  const restored=await(await fetch(`http://127.0.0.1:${ports.httpPort}/image/1`)).json();
  assert.equal(restored.db.length,65*65);
  const bare=createService({tcpPort:0,httpPort:0,display:{completed:1000,result,target:null}});
  t.after(()=>bare.close());
  const barePorts=await bare.started;
  const bareState=await(await fetch(`http://127.0.0.1:${barePorts.httpPort}/state`)).json();
  assert.equal(bareState.mosaic.count,0);assert.equal(bareState.mosaic.latestSeq,0);
  assert.equal(bareState.mosaic.limit,PROTOCOL.mosaic.limit,'default retention limit');
  assert.equal(bareState.mosaic.firstSeq,1);assert.equal(bareState.mosaic.dropped,0);
  assert.ok(Number.isSafeInteger(bareState.mosaic.generation)&&bareState.mosaic.generation>0,'a restarted service is identifiable');
  assert.notEqual(bareState.mosaic.generation,state.mosaic.generation);
  const clamped=createService({tcpPort:0,httpPort:0,mosaicLimit:0,gateWindowMs:-5});
  t.after(()=>clamped.close());
  const clampedPorts=await clamped.started;
  const clampedState=await(await fetch(`http://127.0.0.1:${clampedPorts.httpPort}/state`)).json();
  assert.equal(clampedState.mosaic.limit,1);
});
test('Continuous mode skips an unusable patch, explains the wait and keeps running',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aesa-sar-gate-'));
  const service=createService({tcpPort:0,httpPort:0,recordDir:root,gateWindowMs:5000,processing:CONTROL});
  t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
  const ports=await service.started,base=`http://127.0.0.1:${ports.httpPort}`;
  const exporter=await openExport(t,ports.tcpPort);
  exporter.status();await delay(30);
  assert.equal((await fetch(base+'/continuous/start',{method:'POST',body:'{"side":0,"range":20000}'})).status,202);
  assert.equal(service.state.continuous.side,0);assert.equal(service.state.continuous.captureSide,1);
  await until(()=>exporter.commands().includes('CAPTURE,1,1,20000'));
  // A nearly along-track target cannot be focused: the service skips it instead of computing it.
  exporter.client.write('TARGET,1,41.5,42.25,20000,5\n'+messages(shiftedScene(0),1).join('\n')+'\n');
  await until(()=>service.state.continuous.skipped===1);
  assert.match(service.state.continuous.note,/已跳过本次/);
  assert.match(service.state.continuous.note,/斜视角 5°/);
  assert.equal(service.state.continuous.completed,0);assert.equal(service.state.continuous.enabled,true);
  assert.equal(service.state.result,null,'a skipped patch is never computed');
  assert.deepEqual(fs.readdirSync(root),[],'a skipped patch is never recorded');
  // While the prediction from that capture is fresh the loop explains the wait instead of capturing.
  await until(()=>/暂不采集/.test(service.state.continuous.note));
  assert.match(service.state.continuous.note,/20–160° 侧视窗口/);
  assert.equal(service.collector.job,null);
  assert.equal(service.state.continuous.enabled,true);
  assert.equal((await fetch(base+'/continuous/stop',{method:'POST',body:'{}'})).status,200);
  assert.equal(service.state.continuous.enabled,false);
});
test('Continuous mode alternates sides when the side selector asks for it',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aesa-sar-alt-'));
  const service=createService({tcpPort:0,httpPort:0,recordDir:root,gateWindowMs:0,processing:CONTROL});
  t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
  const ports=await service.started,base=`http://127.0.0.1:${ports.httpPort}`;
  const exporter=await openExport(t,ports.tcpPort);
  exporter.status();await delay(30);
  assert.equal((await fetch(base+'/continuous/start',{method:'POST',body:'{"side":0,"range":20000}'})).status,202);
  for(const [index,side] of [[1,1],[2,-1],[3,1]]){
    await until(()=>exporter.commands().includes(`CAPTURE,${index},${side},20000`));
    assert.equal(service.state.continuous.captureSide,side);
    exporter.status();
    exporter.client.write(`TARGET,${index},41.5,42.25,20000,${side*45}\n`+messages(shiftedScene(index*150),index).join('\n')+'\n');
    await until(()=>service.state.continuous.completed===index);
  }
  assert.equal(service.state.continuous.failures,0);assert.equal(service.state.continuous.skipped,0);
  const state=await(await fetch(base+'/state')).json();
  assert.equal(state.mosaic.count,3);
  assert.deepEqual(state.mosaic.entries.map(entry=>entry.target.relative_track_deg),[45,-45,45]);
  assert.equal((await fetch(base+'/continuous/stop',{method:'POST',body:'{}'})).status,200);
  const stalled=exporter.commands();await delay(600);assert.equal(exporter.commands(),stalled,'stopping ends the loop');
});
test('Continuous mode skips a patch whose flight cannot be focused and keeps counting failures',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aesa-sar-gate2-'));
  const service=createService({tcpPort:0,httpPort:0,recordDir:root,gateWindowMs:200,processing:CONTROL});
  t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
  const ports=await service.started,base=`http://127.0.0.1:${ports.httpPort}`;
  const exporter=await openExport(t,ports.tcpPort);
  exporter.status();await delay(30);
  await fetch(base+'/continuous/start',{method:'POST',body:'{"side":1,"range":20000}'});
  await until(()=>exporter.commands().includes('CAPTURE,1,1,20000'));
  // Straight radial flight toward the patch: the trajectory is parallel to the line of sight, so
  // there is no transverse aperture (the classic unusable geometry).
  const radial=shiftedScene(0);
  radial.trajectory=radial.trajectory.map(pose=>{const fraction=pose.t/2;
    return {t:pose.t,pos:radial.center.map((value,index)=>value+(index===1?4000:20000)*(1-fraction*.01))};});
  exporter.client.write(messages(radial,1).join('\n')+'\n');
  await until(()=>service.state.continuous.skipped===1);
  assert.match(service.state.continuous.note,/已跳过本次/);
  assert.match(service.state.continuous.note,/侧向孔径不足/);
  assert.equal(service.state.continuous.enabled,true);assert.equal(service.state.continuous.completed,0);
  assert.deepEqual(fs.readdirSync(root),[]);
  // Acquisition failures only add up; the loop keeps offering captures.
  await until(()=>service.collector.job);
  for(let i=1;i<=3;i++){
    exporter.client.write(`FAIL,${service.collector.job.id},ground_speed_too_low\n`);
    await until(()=>service.state.continuous.failures===i);
    assert.equal(service.state.continuous.enabled,true);
    exporter.status();await until(()=>service.collector.job);
  }
  assert.equal(service.state.continuous.failures,3);
  assert.equal((await fetch(base+'/continuous/stop',{method:'POST',body:'{}'})).status,200);
  assert.equal(service.state.continuous.enabled,false);
});
test('D3: the 4 KB poll budget is the incremental poll; a full mosaic stays matrix-free',()=>{
  const store=new MosaicStore(),db=[-10,-10,-10,-10];
  const size=PROTOCOL.sar.capture.size_n_pairs[0][0];
  for(let i=0;i<50;i++)store.keep({bearing:0,center:[i,100,i],size,footprint:'detail'},
    {source:'dcs',width:2,size_m:size,db,metadata:{mode:'sar',quality:'standard',focuser:'backprojection',
      scene_model:'uniform',image_step_m:1,compute_ms:1,db_ref:'frame_peak'}},null);
  const full=store.state();
  assert.equal(full.count,50);
  assert.equal(full.entries.length,50);
  assert.ok(full.entries.every(entry=>!('db' in entry)),'a mosaic summary never carries its matrix');
  assert.ok(Buffer.byteLength(JSON.stringify(full))>4096,
    '50 summaries exceed 4 KB: the budget names the incremental poll, not the full state');
  const incremental=store.state({since:50});
  assert.equal(incremental.entries.length,0);
  assert.ok(Buffer.byteLength(JSON.stringify(incremental))<4096,'the 700 ms incremental poll stays under 4 KB');
});

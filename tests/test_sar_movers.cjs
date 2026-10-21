'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),net=require('node:net'),http=require('node:http');
const {createService}=require('../tools/sar_live.cjs');
const {createBridge}=require('../tools/sar_bridge.cjs');
const {demoScene}=require('../tools/sar_demo_scene.cjs');
const {sar,PROTOCOL}=require('../src/shared/config.cjs');
const NL=String.fromCharCode(10);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(condition,label){for(let i=0;i<400;i++){if(await condition())return;await delay(20);}throw Error(`wait timed out: ${label||''}`);}
// node:http instead of the global fetch: fetch refuses some well-known ports even when the service
// owns one as its OS-assigned ephemeral port (see the same helper in test_sar_live.cjs).
function fetch(url){
  return new Promise((resolve,reject)=>{
    const target=new URL(url),port=target.port===''?80:Number(target.port);
    if(!Number.isInteger(port)||port<=0||port>65535)return reject(Error(`test fetch: invalid URL port in ${url}`));
    const request=http.request({host:target.hostname,port,path:target.pathname+target.search,method:'GET'},response=>{
      let text='';response.setEncoding('utf8');response.on('data',chunk=>text+=chunk);
      response.on('end',()=>resolve({status:response.statusCode,ok:response.statusCode>=200&&response.statusCode<300,
        text:async()=>text,json:async()=>JSON.parse(text),headers:response.headers}));
    });
    request.on('error',reject);request.end();
  });
}
const NEW_CAP='CAP,land.getSurfaceType,world.searchObjects,world.searchObjects,a_do_script';
const OLD_CAP='CAP,land.getSurfaceType,world.searchObjects,a_do_script';
const MOVER=sar.map.mover,MDV=MOVER.mdv_mps;
// The service takes the platform position from the newest captured trajectory, so a seeded scene is
// enough to give the mover poll a pose: the trail ends at (500, 4000, 0).
function seedScene(){const scene=demoScene();scene.terrain=scene.terrain.map(p=>[p[0],100,p[2]]);scene.center[1]=100;return scene;}
// One ground mover report; the bridge validates the exact field count and order.
function moverLines(id,entries){return entries.map((entry,index)=>
  `MOVER,${id},${index},${entry.kind||'unit'},${entry.pos[0].toFixed(9)},60.000000000,${entry.pos[1].toFixed(9)},`+
  `${entry.v[0].toFixed(9)},0.000000000,${entry.v[1].toFixed(9)}`).join(NL)+
  NL+`MOVER_END,${id},${entries.length},${entries.length},0,world.searchObjects`+NL;}
// A stub mission hook: greets the bridge, then answers MOVER queries with whatever the caller decides.
function missionHook(t,port,{cap=NEW_CAP,compat=null,answer=null}={}){
  const client=net.createConnection({host:'127.0.0.1',port});t.after(()=>client.destroy());
  const received=[];let buffer='';
  client.on('data',chunk=>{
    buffer+=chunk.toString();
    let index;
    while((index=buffer.indexOf(NL))>=0){
      const line=buffer.slice(0,index);buffer=buffer.slice(index+1);received.push(line);
      if(answer&&line.startsWith('MOVER,')){const a=line.split(',');
        const reply=answer({id:Number(a[1]),cx:Number(a[2]),cz:Number(a[3]),radius:Number(a[4])});
        if(reply)client.write(reply);}
    }});
  client.on('error',()=>{});
  return new Promise(resolve=>client.once('connect',()=>{
    client.write('HELLO,SARSCENE1'+NL+cap+NL+(compat?compat+NL:''));
    resolve({client,received,queries:()=>received.filter(line=>line.startsWith('MOVER,'))});}));
}
// Everything is relative to the platform at (500, 0): the line of sight decides what GMTI keeps.
const REPORTS={
  closing:{pos:[3500,0],v:[-8,0]},                              // 3 km ahead, closing: radial 8 m/s
  crossing:{pos:[2500,2000],v:[-10*Math.SQRT1_2,10*Math.SQRT1_2]}, // 10 m/s across the beam: blind
  receding:{pos:[500,5000],v:[0,10]},                            // 5 km abeam, opening: radial 10
  parked:{pos:[1500,1000],v:[0,0]},
  slow:{pos:[4500,0],v:[-1.5,0]},                                // under the 2 m/s blind zone
  far:{pos:[60500,0],v:[-20,0]}};                                // outside the 50 km picture
test('Ground movers arrive over the scene bridge, blind-zone filtered, range bounded, contract exact',async t=>{
  const service=createService({tcpPort:0,httpPort:0,scenePort:0,scene:seedScene(),processing:{quality:'fast'},
    moverPollMs:150,moverMdvMps:MDV});
  t.after(()=>service.close());
  const ports=await service.started,base=`http://127.0.0.1:${ports.httpPort}`;
  const hook=await missionHook(t,ports.scenePort,{answer:({id})=>moverLines(id,Object.values(REPORTS))});
  await until(()=>service.state.movers,'the first mover picture');
  const state=await(await fetch(base+'/state')).json();
  assert.equal(state.movers.length,2,'only the movers the radar can see survive the blind zone');
  assert.deepEqual(state.movers.map(entry=>[entry.x,entry.z]),[[3500,0],[500,5000]],'nearest first');
  for(const entry of state.movers)assert.deepEqual(Object.keys(entry).sort(),['ageS','headingDeg','speed','x','z'],'mover contract');
  assert.deepEqual([state.movers[0].speed,state.movers[0].headingDeg],[8,-90],'speed and track heading');
  assert.deepEqual([state.movers[1].speed,state.movers[1].headingDeg],[10,0]);
  assert.ok(state.movers.every(entry=>Number.isFinite(entry.ageS)&&entry.ageS>=0),'every mover carries its age');
  assert.match(state.moversNote,/2 个动目标/);assert.match(state.moversNote,new RegExp(`径向 \\|v\\| ≥ ${MDV} m/s`));
  const query=hook.queries()[0];
  assert.equal(query,`MOVER,1,500.000000000,0.000000000,${MOVER.radius_max_m}`,`the poll names the platform position and ${MOVER.radius_max_m} m`);
  await until(()=>hook.queries().length>=2,'the poll repeats on its cadence');
  assert.notEqual(hook.queries()[1],query,'every poll is its own query id');
  assert.equal(service.state.error,null);
});
test('A sampler without the mover capability reports no picture instead of pretending',async t=>{
  const service=createService({tcpPort:0,httpPort:0,scenePort:0,scene:seedScene(),processing:{quality:'fast'},moverPollMs:100});
  t.after(()=>service.close());
  const ports=await service.started;
  const hook=await missionHook(t,ports.scenePort,{cap:OLD_CAP,answer:({id})=>moverLines(id,[REPORTS.closing])});
  await until(()=>/不支持动目标查询/.test(service.state.moversNote),'the capability reason');
  assert.equal(service.state.movers,null,'no picture without a mover query');
  assert.equal(service.state.continuous.enabled,false);
  assert.deepEqual(hook.queries(),[],'nothing is asked of a sampler that cannot answer');
});
test('A stalled mover poll times out, cancels the query and clears the picture',async t=>{
  const service=createService({tcpPort:0,httpPort:0,scenePort:0,scene:seedScene(),processing:{quality:'fast'},moverPollMs:200});
  t.after(()=>service.close());
  const ports=await service.started;
  const hook=await missionHook(t,ports.scenePort,{answer:null});
  await until(()=>hook.queries().length>=1,'a mover query');
  await until(()=>service.state.moversNote&&/动目标查询失败/.test(service.state.moversNote),'the timeout reason');
  assert.equal(service.state.movers,null);
  assert.match(service.state.moversNote,/timed out/);
  await until(()=>hook.received.includes('MOVER_CANCEL'),'the abandoned query is cancelled');
});
test('A successful picture is cleared when the bridge disconnects',async t=>{
  const service=createService({tcpPort:0,httpPort:0,scenePort:0,scene:seedScene(),processing:{quality:'fast'},moverPollMs:150});
  t.after(()=>service.close());
  const ports=await service.started;
  const hook=await missionHook(t,ports.scenePort,{answer:({id})=>moverLines(id,[REPORTS.closing,REPORTS.receding])});
  await until(()=>service.state.movers&&service.state.movers.length===2,'a populated picture');
  hook.client.destroy();
  await until(()=>service.state.movers===null,'the picture is cleared');
  assert.match(service.state.moversNote,/场景桥未连接/);
});
test('A mover poll and a scene job share one bridge without disturbing each other',async t=>{
  const bridge=createBridge({port:0});t.after(()=>bridge.close());
  const port=await bridge.started;
  const scene=demoScene();scene.id=4;
  const hook=await missionHook(t,port,{answer:({id})=>moverLines(id,[REPORTS.closing,REPORTS.crossing])});
  await until(()=>bridge.capabilities.connected&&bridge.capabilities.surface==='land.getSurfaceType','the scene capabilities');
  bridge.request(scene);
  const job=bridge.finish(scene);
  const movers=await bridge.movers({cx:500,cz:0,radius:MOVER.radius_max_m});
  assert.equal(movers.complete,true,'the mover query completes while a scene job is pending');
  assert.equal(movers.movers.length,2);
  await until(()=>hook.received.some(line=>line.startsWith('SCENE,4,')),'the scene request');
  hook.client.write(Array.from({length:PROTOCOL.sar.default_n**2},(_,i)=>`SURFACE,4,${i},5`).join(NL)+NL+'SCENE_END,4,0,0,0,world.searchObjects'+NL);
  const finished=await job;
  assert.equal(finished.surfaces.length,PROTOCOL.sar.default_n**2,'the scene job still completes');
  assert.equal(finished.scene_data.note,'completed');
  const again=await bridge.movers({cx:500,cz:0,radius:MOVER.radius_max_m});
  assert.equal(again.complete,true,'the bridge still answers movers after a scene');
  assert.equal(bridge.capabilities.movers,'world.searchObjects');
});

test('The scene COMPAT handshake is exposed to callers and clears with its connection',async t=>{
  const bridge=createBridge({port:0});t.after(()=>bridge.close());
  const port=await bridge.started;
  const hook=await missionHook(t,port,{compat:'COMPAT,dcs-2.9.30.28738-mt,1a2b3c4d',
    answer:({id})=>moverLines(id,[REPORTS.closing])});
  await until(()=>bridge.capabilities.connected&&bridge.capabilities.compat,'the scene compat handshake');
  assert.deepEqual({profile_id:bridge.capabilities.compat.profile_id,matrix_hash:bridge.capabilities.compat.matrix_hash},
    {profile_id:'dcs-2.9.30.28738-mt',matrix_hash:'1a2b3c4d'});
  assert.ok(Number.isFinite(bridge.capabilities.compat.at),'the handshake carries an arrival time');
  assert.deepEqual([bridge.capabilities.surface,bridge.capabilities.objects,bridge.capabilities.movers,bridge.capabilities.provider],
    ['land.getSurfaceType','world.searchObjects','world.searchObjects','a_do_script'],'CAP is unchanged');
  const movers=await bridge.movers({cx:500,cz:0,radius:MOVER.radius_max_m});
  assert.equal(movers.complete,true);assert.equal(movers.movers.length,1,'mover handling is unchanged');
  hook.client.destroy();
  await until(()=>!bridge.capabilities.connected&&bridge.capabilities.compat===null,'compat clears on disconnect');
});

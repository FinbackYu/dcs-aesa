'use strict';
// Gate 1 regressions for the MAP state machine and service test isolation.
//
// 1. A failed manual /map is a one-shot: it has to end the session immediately (active=false) and the
//    operator must be able to resend. The old 100 ms timer retried it forever and the resend was refused
//    with "Map session already running".
// 2. A continuous MAP patrol is the only retrying map mode; its failure stays active and is retried
//    after the service's own backoff instead of on every 100 ms tick.
// 3. Tests talk to the port the service actually bound through node:http. A port of 0 or an undefined
//    port is rejected explicitly instead of reaching fetch's "bad port" rule.
const test=require('node:test'),assert=require('node:assert/strict');
const net=require('node:net'),http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Collector,createService}=require('../tools/sar_live.cjs');

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(condition,label='condition',timeoutMs=10000){
  const started=Date.now();
  for(;;){
    if(await condition())return;
    if(Date.now()-started>timeoutMs)throw Error(`wait timed out: ${label}`);
    await delay(20);
  }
}
function assertPort(port,label){
  assert.ok(Number.isInteger(port)&&port>0&&port<=65535,`${label} is a real listening port (got ${port})`);
}
// node:http instead of fetch: the URL port is the one the service reported after listen(), and an
// invalid port is a named assertion above rather than an opaque fetch failure.
function httpJson(port,method,pathname,body){
  assertPort(port,'service HTTP port');
  return new Promise((resolve,reject)=>{
    const payload=body===undefined?null:Buffer.from(body);
    const request=http.request({host:'127.0.0.1',port,method,path:pathname,
      headers:payload?{'Content-Type':'application/json','Content-Length':payload.length}:{}},response=>{
      let text='';
      response.setEncoding('utf8');
      response.on('data',chunk=>text+=chunk);
      response.on('end',()=>{
        let value=null;
        try{value=text?JSON.parse(text):null;}catch(error){return reject(Error(`invalid JSON from ${pathname}: ${error.message}`));}
        resolve({status:response.statusCode,body:value,text});
      });
    });
    request.on('error',reject);
    if(payload)request.write(payload);
    request.end();
  });
}
const DEM_HEIGHT=(x,z)=>100+.004*Math.max(0,x)+8*Math.sin(z/4000);
// A minimal MAP Export: answers every CAPTURE_MAP/CAPTURE_MAP_AT with one complete 2-pose job, or with
// FAIL when control.failNext is set. `requests` is the command log the tests assert on.
async function openMapExport(t,port,control){
  const own={x:0,z:0,heading:Math.PI/2,clock:1000};
  const exporter={own,requests:[],log:'',commands:()=>exporter.log};
  const client=net.createConnection({host:'127.0.0.1',port});
  t.after(()=>client.destroy());
  await new Promise((resolve,reject)=>{client.once('connect',resolve);client.once('error',reject);});
  let buffer='';
  function answer(line){
    const fields=line.split(',');
    if(fields[0]!=='CAPTURE_MAP'&&fields[0]!=='CAPTURE_MAP_AT')return null;
    const id=Number(fields[1]),relative=fields[0]==='CAPTURE_MAP_AT';
    const origin=relative?[own.x+Number(fields[2]),own.z+Number(fields[3])]:[Number(fields[2]),Number(fields[3])];
    const cols=Number(fields[4]),rows=Number(fields[5]),step=Number(fields[6]);
    exporter.requests.push({id,relative,origin,cols,rows,step,cells:cols*rows});
    if(control.holdNext){control.holdNext=false;return null;}   // a paused Export: job accepted, no data
    if(control.failNext){
      control.failNext=false;
      return [`FAIL,${id},terrain_query_failed`];
    }
    let sequence=1;
    const pose=offset=>{own.clock+=.25;return `MAPPOSE,${id},${sequence++},${own.clock},${own.x+offset*Math.sin(own.heading)},3000,${own.z+offset*Math.cos(own.heading)},250,0`;};
    const lines=[`MAPBEGIN,${id},${origin[0]},${origin[1]},${cols},${rows},${step}`,pose(0)];
    for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){
      const x=origin[0]+col*step,z=origin[1]+row*step;
      lines.push(`MAPHEIGHT,${id},${col},${row},${x},${DEM_HEIGHT(x,z).toFixed(3)},${z}`);
    }
    lines.push(pose(12),`MAPEND,${id},${cols*rows},${own.clock}`);
    return lines;
  }
  client.on('data',chunk=>{
    const text=chunk.toString('ascii');exporter.log+=text;buffer+=text;
    let index;
    while((index=buffer.indexOf('\n'))>=0){
      const line=buffer.slice(0,index);buffer=buffer.slice(index+1);
      const reply=answer(line);
      if(reply)client.write(reply.join('\n')+'\n');
    }
  });
  client.write('HELLO,SAR1\nCAPS,2,terrain.GetSurfaceType,map\nSTATUS,42,terrain.GetHeight,50,51,50,1\n');
  const keepAlive=setInterval(()=>{
    if(client.destroyed)clearInterval(keepAlive);
    else if(control.status!==false)client.write('STATUS,42,terrain.GetHeight,50,51,50,1\n');
  },500);
  t.after(()=>clearInterval(keepAlive));
  exporter.client=client;
  return exporter;
}
function tempRoot(t,prefix){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),prefix));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return root;
}

test('A failed manual /map ends the session at once, does not retry on the 100 ms tick, and can be resent',async t=>{
  const root=tempRoot(t,'aesa-gate1-mapfail-');
  const service=createService({tcpPort:0,httpPort:0,recordDir:root,processing:{scatterSpacing:4,width:65}});
  t.after(()=>service.close());
  const ports=await service.started;
  const control={failNext:true};
  const exporter=await openMapExport(t,ports.tcpPort,control);
  await until(()=>service.collector.capabilities?.map===true,'map capability');

  const first=await httpJson(ports.httpPort,'POST','/map',JSON.stringify({range:8000,cell:500}));
  assert.equal(first.status,202,'the first manual shot is accepted');
  await until(()=>exporter.requests.length>=1,'first map job');
  await until(()=>service.state.map.failures>=1,'map failure counted');
  await until(async()=>(await httpJson(ports.httpPort,'GET','/state')).body.map.active===false,
    'a failed manual shot closes its session');
  assert.match(service.state.map.note,/地图采集失败/);
  assert.equal(service.collector.map,null,'the failed Export job is dropped');

  const jobs=exporter.requests.length;
  await delay(400);                                  // four 100 ms service ticks
  assert.equal(exporter.requests.length,jobs,'a manual shot is never retried by the 100 ms timer');

  const second=await httpJson(ports.httpPort,'POST','/map',JSON.stringify({range:8000,cell:500}));
  assert.equal(second.status,202,'the operator can resend immediately');
  await until(()=>service.state.map.frames>=1,'a resent manual shot completes');
  await until(async()=>(await httpJson(ports.httpPort,'GET','/state')).body.map.active===false,
    'the resent shot ends by itself');
  assert.ok(exporter.requests.length>jobs,'the resend really asked the Export again');
});

test('A timed-out manual /map closes its session and can be resent',async t=>{
  const root=tempRoot(t,'aesa-gate1-maptimeout-');
  const service=createService({tcpPort:0,httpPort:0,recordDir:root,processing:{scatterSpacing:4,width:65}});
  t.after(()=>service.close());
  const ports=await service.started;
  const control={holdNext:true};
  const exporter=await openMapExport(t,ports.tcpPort,control);
  await until(()=>service.collector.capabilities?.map===true,'map capability');
  assert.equal((await httpJson(ports.httpPort,'POST','/map',JSON.stringify({range:8000,cell:500}))).status,202);
  await until(()=>service.collector.map,'map job in flight');
  // The Export paused: age the job past its 60 s budget instead of waiting for it.
  service.collector.map.started=Date.now()-61000;
  await until(()=>service.state.map.failures>=1,'timeout counted');
  await until(async()=>(await httpJson(ports.httpPort,'GET','/state')).body.map.active===false,
    'a timed-out manual shot closes its session');
  assert.match(service.state.map.note,/超时/);
  const jobs=exporter.requests.length;
  await delay(300);
  assert.equal(exporter.requests.length,jobs,'a timed-out manual shot is not retried');
  assert.equal((await httpJson(ports.httpPort,'POST','/map',JSON.stringify({range:8000,cell:500}))).status,202,
    'the operator can resend after the timeout');
  await until(()=>service.state.map.frames>=1,'the resent shot completes');
});

test('A manual /map whose Export stops reporting also ends resendable',async t=>{
  const root=tempRoot(t,'aesa-gate1-mappause-');
  const service=createService({tcpPort:0,httpPort:0,recordDir:root,processing:{scatterSpacing:4,width:65}});
  t.after(()=>service.close());
  const ports=await service.started;
  const control={holdNext:true,status:false};
  const exporter=await openMapExport(t,ports.tcpPort,control);
  await until(()=>service.collector.capabilities?.map===true,'map capability');
  assert.equal((await httpJson(ports.httpPort,'POST','/map',JSON.stringify({range:8000,cell:500}))).status,202);
  await until(()=>service.collector.map,'map job in flight');
  service.collector.status.received=Date.now()-4000;   // the mission stopped reporting
  await until(async()=>(await httpJson(ports.httpPort,'GET','/state')).body.map.active===false,
    'a paused manual map ends its session');
  assert.match(service.state.map.note,/暂停/);
  // The Export resumes: a fresh status lets the operator resend and complete.
  control.status=true;service.collector.status.received=Date.now();
  assert.equal((await httpJson(ports.httpPort,'POST','/map',JSON.stringify({range:8000,cell:500}))).status,202);
  await until(()=>service.state.map.frames>=1,'the resent shot completes after the pause');
});

test('A running manual /map can be stopped with the page control and resent',async t=>{
  const root=tempRoot(t,'aesa-gate1-mapstop-');
  const service=createService({tcpPort:0,httpPort:0,recordDir:root,processing:{scatterSpacing:4,width:65}});
  t.after(()=>service.close());
  const ports=await service.started;
  const control={holdNext:true};
  const exporter=await openMapExport(t,ports.tcpPort,control);
  await until(()=>service.collector.capabilities?.map===true,'map capability');
  assert.equal((await httpJson(ports.httpPort,'POST','/map',JSON.stringify({range:8000,cell:500}))).status,202);
  await until(()=>service.collector.map,'map job in flight');
  assert.equal((await httpJson(ports.httpPort,'POST','/continuous/stop','{}')).status,200,
    'the page stop control also stops a one-shot map');
  await until(async()=>(await httpJson(ports.httpPort,'GET','/state')).body.map.active===false,
    'stopping closes the manual map session');
  assert.equal(service.collector.map,null,'the in-flight map job is cancelled');
  assert.equal((await httpJson(ports.httpPort,'POST','/map',JSON.stringify({range:8000,cell:500}))).status,202,
    'a stopped shot can be started again');
  await until(()=>service.state.map.frames>=1,'the resent shot completes');
});

test('A failed continuous MAP patrol stays active and retries after its backoff, not every tick',async t=>{
  const root=tempRoot(t,'aesa-gate1-mapretry-');
  const service=createService({tcpPort:0,httpPort:0,recordDir:root,processing:{scatterSpacing:4,width:65}});
  t.after(()=>service.close());
  const ports=await service.started;
  const control={failNext:true};
  const exporter=await openMapExport(t,ports.tcpPort,control);
  await until(()=>service.collector.capabilities?.map===true,'map capability');

  const started=await httpJson(ports.httpPort,'POST','/continuous/start',JSON.stringify({mode:'map',range:8000,cell:500}));
  assert.equal(started.status,202);
  await until(()=>service.state.map.failures>=1,'patrol failure counted');
  const failed=await httpJson(ports.httpPort,'GET','/state');
  assert.equal(failed.body.map.active,true,'a patrol keeps its session after a failed job');
  assert.equal(service.state.continuous.enabled,true);
  assert.equal(service.collector.map,null);
  const jobs=exporter.requests.length;
  await delay(1000);                                 // well inside the 2 s retry backoff
  assert.equal(exporter.requests.length,jobs,'a failed patrol is not re-asked on every 100 ms tick');
  await until(()=>exporter.requests.length>jobs,'the patrol retries after the backoff',8000);
  await until(()=>service.state.map.frames>=1,'the retried patrol renders a frame');
  const stopped=await httpJson(ports.httpPort,'POST','/continuous/stop','{}');
  assert.equal(stopped.status,200);
  await until(async()=>(await httpJson(ports.httpPort,'GET','/state')).body.map.active===false,
    'stopping ends the patrol');
});

test('Services started concurrently report distinct, already-listening HTTP ports',async t=>{
  const services=[];
  t.after(async()=>{await Promise.all(services.map(service=>service.close()));});
  for(let i=0;i<3;i++)services.push(createService({tcpPort:0,httpPort:0}));
  const ports=await Promise.all(services.map(service=>service.started));
  for(const entry of ports){assertPort(entry.tcpPort,'Export TCP port');assertPort(entry.httpPort,'HTTP port');}
  assert.equal(new Set(ports.map(entry=>entry.httpPort)).size,ports.length,'every service owns its own HTTP port');
  assert.equal(new Set(ports.map(entry=>entry.tcpPort)).size,ports.length,'every service owns its own Export port');
  const states=await Promise.all(ports.map(entry=>httpJson(entry.httpPort,'GET','/state')));
  for(const state of states)assert.equal(state.status,200,'the reported port is already listening');
});

test('MAPSURFACE enforces the same 96-character field cap as the Export',()=>{
  // src/export/aesa_sar_export.lua truncates a probe union at 96 characters (MAPSURFACE_MAX), so
  // the consumer boundary is part of the contract: a 96-character field is accepted, 97 is refused.
  // test_sar_gate1_export.cjs drives the Lua Export itself and proves its union stays inside this.
  const atLimit=['a'.repeat(24),'b'.repeat(24),'c'.repeat(24),'d'.repeat(21)].join('+');
  const overLimit=['a'.repeat(24),'b'.repeat(24),'c'.repeat(24),'d'.repeat(22)].join('+');
  assert.equal(atLimit.length,96);assert.equal(overLimit.length,97);
  const oneCell=token=>{
    const collector=new Collector();collector.startMap({x0:0,z0:0,cols:1,rows:1,step:250});
    const id=collector.map.id;
    let completed=null;
    for(const line of [`MAPBEGIN,${id},0,0,1,1,250`,`MAPHEIGHT,${id},0,0,0,100,0`,
      `MAPSURFACE,${id},0,0,${token}`,`MAPEND,${id},1,1`])completed=collector.accept(line)||completed;
    return completed;
  };
  assert.ok(oneCell(atLimit),'a field exactly at the 96-character limit completes');
  assert.throws(()=>oneCell(overLimit),/Invalid MAPSURFACE/,'one character over the limit is refused');
});

test('MAPGRID is accepted as an additive marker and the canonical layout is the default',()=>{
  const job=lines=>{
    const collector=new Collector();collector.startMap({x0:0,z0:0,cols:1,rows:1,step:250});
    const id=collector.map.id;
    let completed=null;
    for(const line of lines(id))completed=collector.accept(line)||completed;
    return {collector,completed};
  };
  const prefix=id=>`MAPBEGIN,${id},0,0,1,1,250`;
  const body=id=>[`MAPHEIGHT,${id},0,0,0,100,0`,`MAPEND,${id},1,1`];
  const marked=job(id=>[prefix(id),`MAPGRID,${id},col_x_row_z`,...body(id)]);
  assert.ok(marked.completed,'the new Export line does not disturb the job');
  assert.equal(marked.completed.grid_layout,'col_x_row_z');
  const legacy=job(id=>[prefix(id),...body(id)]);
  assert.ok(legacy.completed,'an older Export without MAPGRID still completes');
  assert.equal(legacy.completed.grid_layout,'col_x_row_z','the protocol default is the canonical grid');
  assert.throws(()=>job(id=>[prefix(id),`MAPGRID,${id},legacy_x_row_negz_col`,...body(id)]),/Invalid MAPGRID/);
  assert.throws(()=>job(id=>[prefix(id),`MAPGRID,${id},col_x_row_z`,`MAPGRID,${id},col_x_row_z`,...body(id)]),/Invalid MAPGRID/);
});

test('COMPAT is a strict three-field handshake that does not disturb the job state',()=>{
  const collector=new Collector();
  collector.accept('CAPS,2,terrain.GetSurfaceType,map');
  collector.accept('COMPAT,dcs-2.9.30.28738-mt,1a2b3c4d');
  assert.deepEqual([collector.compat.profile_id,collector.compat.matrix_hash],['dcs-2.9.30.28738-mt','1a2b3c4d']);
  assert.ok(Number.isFinite(collector.compat.at));
  assert.equal(collector.job,null);assert.equal(collector.map,null,'the handshake starts no work');
  for(const line of ['COMPAT','COMPAT,dcs-test','COMPAT,dcs-test,1a2b3c4d,extra','COMPAT,dcs test,1a2b3c4d'])
    assert.throws(()=>collector.accept(line),/Invalid compatibility handshake/,`${line} is refused`);
});

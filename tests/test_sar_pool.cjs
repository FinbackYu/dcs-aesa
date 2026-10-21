'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {runImage,poolSize,estimateWork,blocks,MIN_PARALLEL_MS}=require('../src/sar_core/pool.cjs');
const {demoScene}=require('../tools/sar_demo_scene.cjs');
const {reconstruct}=require('../src/sar_core/engine.cjs');
const {pulses}=require('../src/sar_core/waveform.cjs');
const {settings}=require('../src/sar_core/settings.cjs');
const {createService}=require('../tools/sar_live.cjs');
function identical(image,reference){
  assert.equal(image.width,reference.width);assert.equal(image.size_m,reference.size_m);
  assert.equal(image.power.length,reference.power.length);
  for(let i=0;i<image.power.length;i++)assert.ok(Object.is(image.power[i],reference.power[i]),`power[${i}]: ${image.power[i]} != ${reference.power[i]}`);
  assert.deepEqual(image.db,reference.db);
  for(const key of Object.keys(reference.metadata))if(key!=='compute_ms')assert.deepEqual(image.metadata[key],reference.metadata[key],key);
}
async function until(condition){const deadline=Date.now()+60000;while(!condition()){if(Date.now()>deadline)throw Error('wait timed out');await new Promise(r=>setTimeout(r,20));}}
function getJson(url){return new Promise((resolve,reject)=>{http.get(url,res=>{let body='';res.setEncoding('utf8');res.on('data',chunk=>{body+=chunk;});res.on('end',()=>{try{resolve(JSON.parse(body));}catch(error){reject(error);}});}).on('error',reject);});}
// processingOptions() only whitelists quality/window/footprint/sceneModel, so pool tests pass
// complete settings objects directly (settings() fills the remaining defaults).
const scene=()=>demoScene(),optionsFor=options=>({window:'hann',...options});
test('Pool size leaves one core and block ranges tile the whole index range',()=>{
  assert.equal(poolSize(1),1);assert.equal(poolSize(8),7);assert.equal(poolSize(32),12);assert.ok(poolSize()>=1);
  assert.deepEqual(blocks(7,3),[[0,3],[3,5],[5,7]]);
  assert.deepEqual(blocks(2,4),[[0,1],[1,2],[2,2],[2,2]]);
  assert.deepEqual(blocks(10,1),[[0,10]]);assert.deepEqual(blocks(0,3),[[0,0],[0,0],[0,0]]);
});
test('Split synthesis and focusing stay bit-identical to the serial engine',async()=>{
  const options=optionsFor({width:65,scatterSpacing:4,sceneModel:'classified'});
  const reference=reconstruct(JSON.parse(JSON.stringify(scene())),options);
  for(const workers of [2,6]){
    const job=runImage(JSON.parse(JSON.stringify(scene())),options,{workers,minParallelMs:0});
    assert.equal(job.mode,'parallel');
    identical(await job.done,reference);
  }
  const single=runImage(JSON.parse(JSON.stringify(scene())),options,{workers:1,minParallelMs:0});
  assert.equal(single.mode,'serial');identical(await single.done,reference);
});
test('Small images keep the single-worker path; large estimates split the image',async()=>{
  const small=optionsFor({width:65,scatterSpacing:16});
  const smallWork=estimateWork(scene(),settings(small),pulses(scene(),[],settings(small)).samples.length);
  assert.ok(smallWork.ms<MIN_PARALLEL_MS);
  const smallJob=runImage(scene(),small);assert.equal(smallJob.mode,'serial');await smallJob.done;
  const bigOptions=optionsFor({width:129,scatterSpacing:1,sceneModel:'classified'});
  const bigWork=estimateWork(scene(),settings(bigOptions),pulses(scene(),[],settings(bigOptions)).samples.length);
  assert.ok(bigWork.ms>MIN_PARALLEL_MS);
  const bigJob=runImage(scene(),bigOptions,{workers:6});
  assert.equal(bigJob.mode,'parallel');assert.equal(bigJob.workers,6);
  await bigJob.terminate();await assert.rejects(bigJob.done,/terminated/);
});
test('Terminating a job stops its whole team and settles the waiters',async()=>{
  const job=runImage(scene(),optionsFor({width:129,scatterSpacing:1,sceneModel:'classified'}),{workers:6,minParallelMs:0});
  assert.equal(job.mode,'parallel');
  await job.terminate();await assert.rejects(job.done,/terminated/);
  await job.terminate();
});
test('A worker that dies fails the image instead of stalling the service loop',async()=>{
  const stub=path.join(os.tmpdir(),`aesa-exit-worker-${process.pid}.cjs`);
  fs.writeFileSync(stub,'process.exit(3);\n');
  try{
    const job=runImage(scene(),optionsFor({width:65,scatterSpacing:4,sceneModel:'classified'}),{workers:3,workerFile:stub,minParallelMs:0});
    await assert.rejects(job.done,/exited without a result/);
  }finally{fs.rmSync(stub,{force:true});}
});
test('Service pool path reaches the worker team and returns the serial raster',async t=>{
  const input=scene(),options={window:'hann',width:65,scatterSpacing:2,sceneModel:'classified'};
  const work=estimateWork(input,settings(options),pulses(input,[],settings(options)).samples.length);
  assert.ok(work.ms>MIN_PARALLEL_MS,'the service case must exercise the parallel path');
  const reference=reconstruct(JSON.parse(JSON.stringify(input)),options);
  const service=createService({tcpPort:0,httpPort:0,scene:input,mode:'replay',processing:options,workers:6});
  t.after(()=>service.close());
  await service.started;await until(()=>service.state.result);
  identical(service.state.result,reference);
  assert.equal(service.state.error,null);
  const state=await getJson(`http://127.0.0.1:${(await service.started).httpPort}/state`);
  assert.equal(state.imaging,null);assert.equal(state.canReprocess,true);
});

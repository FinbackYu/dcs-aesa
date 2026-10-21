'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {SAR_PROFILES}=require('../src/shared/config.cjs');
const pfa=require('../src/sar_core/pfa.cjs');
const engine=require('../src/sar_core/engine.cjs');
const {settings}=require('../src/sar_core/settings.cjs');
const {processingOptions}=require('../src/adapters/dcs/sar_adapter.cjs');
const {runImage}=require('../src/sar_core/pool.cjs');
const {demoScene}=require('../tools/sar_demo_scene.cjs');
const {focusRows}=require('../src/sar_core/focus.cjs');
const {createService}=require('../tools/sar_live.cjs');
const {pointComparison,imageComparison,correlation}=require('../scripts/sar_pfa_probe.cjs');
const {worldToScene}=require('../src/sar_core/geometry.cjs');
const mean=values=>values.reduce((sum,value)=>sum+value,0)/values.length;
function flatScene(){const scene=demoScene();scene.terrain.forEach(p=>p[1]=80);scene.center[1]=80;return scene;}
async function until(condition){const deadline=Date.now()+60000;while(!condition()){if(Date.now()>deadline)throw Error('wait timed out');await new Promise(r=>setTimeout(r,20));}}
const standardOptions={width:SAR_PROFILES.standard.width,scatterSpacing:4,window:'hann',sceneModel:'classified'};
test('Radix-2 FFT matches a naive DFT in both directions and rejects other lengths',()=>{
  for(const count of [4,8,16]){
    const re=Float64Array.from({length:count},(_,i)=>Math.sin(i*1.7)+.3),im=Float64Array.from({length:count},(_,i)=>Math.cos(i*.9));
    for(const sign of [-1,1]){
      const actualRe=Float64Array.from(re),actualIm=Float64Array.from(im);pfa.fft(actualRe,actualIm,sign);
      for(let m=0;m<count;m++){
        let sumRe=0,sumIm=0;
        for(let n=0;n<count;n++){const angle=sign*2*Math.PI*m*n/count;sumRe+=re[n]*Math.cos(angle)-im[n]*Math.sin(angle);sumIm+=re[n]*Math.sin(angle)+im[n]*Math.cos(angle);}
        assert.ok(Math.abs(sumRe-actualRe[m])<1e-9&&Math.abs(sumIm-actualIm[m])<1e-9,`length ${count} sign ${sign} bin ${m}`);
      }
    }
    const roundRe=Float64Array.from(re),roundIm=Float64Array.from(im);pfa.fft(roundRe,roundIm,-1);pfa.fft(roundRe,roundIm,1);
    for(let i=0;i<count;i++){assert.ok(Math.abs(roundRe[i]-count*re[i])<1e-9);assert.ok(Math.abs(roundIm[i]-count*im[i])<1e-9);}
  }
  assert.throws(()=>pfa.fft(new Float64Array(6),new Float64Array(6),-1),/power of two/);
  assert.deepEqual([1,2,3].map(pfa.nextPow2),[1,2,4]);
});
test('PFA keeps the backprojection point position, mainlobe and sidelobe level',()=>{
  const report=pointComparison(standardOptions,[[0,0],[30,-20]],{fov:64,steps:257});
  assert.equal(report.points.length,2);
  for(const point of report.points){
    for(const axis of ['cross','ground']){
      const metrics=point[axis];
      assert.ok(Math.abs(metrics.position_error_m)<=.3,`${axis} position ${metrics.position_error_m} m at ${point.target_m}`);
      assert.ok(Math.abs(metrics.pfa_fwhm_m/metrics.bp_fwhm_m-1)<.05,`${axis} FWHM ${metrics.pfa_fwhm_m} vs ${metrics.bp_fwhm_m}`);
      assert.ok(metrics.pfa_pslr_db<metrics.bp_pslr_db+2,`${axis} PSLR ${metrics.pfa_pslr_db} vs ${metrics.bp_pslr_db}`);
    }
    assert.ok(Number.isFinite(point.pfa_image_peak_db_vs_bp_peak));
  }
});
test('Focuser option defaults to backprojection, is passed through and validated',()=>{
  assert.equal(settings({}).focuser,'backprojection');
  assert.equal(settings({focuser:'pfa'}).focuser,'pfa');
  assert.throws(()=>settings({focuser:'polar'}),/settings/);
  assert.throws(()=>settings({focuser:''}),/settings/);
  assert.equal(processingOptions({focuser:'pfa'}).focuser,'pfa');
  assert.equal(processingOptions({quality:'fine'}).focuser,undefined);
  assert.throws(()=>processingOptions({focuser:'keystone'}),/settings/);
  assert.equal(settings({...standardOptions}).focuser,'backprojection');
});
test('PFA image of a flat scene tracks the backprojection image',()=>{
  const cfg=settings(standardOptions),scene=flatScene();
  const data=engine.synthesizeScene(scene,engine.buildScatterers(scene,cfg),cfg);
  const bp=focusRows(data,0,cfg.width,{}),image=pfa.focus(data,{});
  assert.equal(image.power.length,cfg.width*cfg.width);
  const bpMean=mean(bp),pfaMean=mean(image.power);
  const bpNormalized=bp.map(v=>v/bpMean),pfaNormalized=image.power.map(v=>v/pfaMean);
  const raw=correlation(bpNormalized,pfaNormalized);
  assert.ok(raw>.6,`raw correlation ${raw}`);
  // The absolute scales differ by construction (the FFT is unnormalised); compare the
  // peak-to-mean contrast, which is scale free.
  const contrast=10*Math.log10((Math.max(...image.power)/pfaMean)/(Math.max(...bp)/bpMean));
  assert.ok(Math.abs(contrast)<3,`peak-to-mean contrast difference ${contrast.toFixed(2)} dB`);
});
test('Service and pool focus the PFA over one shared history',async t=>{
  const options={...standardOptions,focuser:'pfa'};
  const scene=flatScene();
  const serial=engine.reconstruct(JSON.parse(JSON.stringify(scene)),options);
  assert.equal(serial.metadata.focuser,'pfa');
  const job=runImage(JSON.parse(JSON.stringify(scene)),options,{workers:3,minParallelMs:0});
  assert.equal(job.mode,'parallel');
  const pooled=await job.done;
  for(let i=0;i<serial.power.length;i++)assert.ok(Object.is(serial.power[i],pooled.power[i]),`pooled power[${i}]`);
  const service=createService({tcpPort:0,httpPort:0,scene,mode:'replay',processing:{...standardOptions,focuser:'pfa'},workers:1});
  t.after(()=>service.close());
  await service.started;await until(()=>service.state.result);
  assert.equal(service.state.result.metadata.focuser,'pfa');
  assert.equal(service.state.error,null);
  for(let i=0;i<serial.power.length;i++)assert.ok(Object.is(serial.power[i],service.state.result.power[i]),`service power[${i}]`);
  const base=await service.started;
  assert.equal((await fetch(`http://127.0.0.1:${base.httpPort}/reprocess`,{method:'POST',body:'{"focuser":"polar"}'})).status,409);
  // Replay scenes carry their own processing block; the service-level focuser must still apply.
  const recorded=flatScene();recorded.processing={window:'hann',bandwidth:SAR_PROFILES.standard.bandwidth_hz,width:SAR_PROFILES.standard.width,scatterSpacing:4,sceneModel:'classified'};
  const replay=createService({tcpPort:0,httpPort:0,scene:recorded,mode:'replay',processing:{...standardOptions,focuser:'pfa'},workers:1});
  t.after(()=>replay.close());
  await replay.started;await until(()=>replay.state.result||replay.state.error);
  assert.equal(replay.state.error,null);
  assert.equal(replay.state.result.metadata.focuser,'pfa');
});
test('PFA plane basis is the canonical scene projection of each pulse',()=>{
  const scene=flatScene(),cfg=settings({width:65,scatterSpacing:4});
  const data=engine.synthesizeScene(scene,[{pos:engine.pixel(scene,0,0),phase:0,amplitude:1}],cfg);
  const plan=pfa.planPfa(data);
  for(let n=0;n<plan.pulseCount;n++){
    const p=data.samples[n].pos,range=Math.hypot(p[0]-scene.center[0],p[1]-scene.center[1],p[2]-scene.center[2]);
    const [cross,ground]=worldToScene(scene.center,scene.bearing,p[0],p[2]);
    assert.ok(Math.abs(plan.dirCross[n]+cross/range)<1e-12,`pulse ${n} cross projection`);
    assert.ok(Math.abs(plan.dirGround[n]+ground/range)<1e-12,`pulse ${n} ground projection`);
  }
});

'use strict';
// PFA vs time-domain backprojection on the surface engine: point response and image level.
//   node scripts/sar_pfa_probe.cjs                     point targets on a flat synthetic scene
//   node scripts/sar_pfa_probe.cjs --record <file>     one real recording, both focusers
// The point comparison focuses one shared echo history with both focusers. The recording
// comparison synthesizes once (serially) and then focuses twice, so the two images differ only
// in the focusing algorithm.
const fs=require('node:fs'),path=require('node:path');
const engine=require('../src/sar_core/engine.cjs');
const pfa=require('../src/sar_core/pfa.cjs');
const {focusPoint,focusRows}=require('../src/sar_core/focus.cjs');
const {demoScene}=require('../tools/sar_demo_scene.cjs');
const {settings}=require('../src/sar_core/settings.cjs');
const {processingOptions}=require('../src/adapters/dcs/sar_adapter.cjs');
const {sceneFootprint}=require('../src/adapters/dcs/sar_adapter.cjs');
const {SAR_PROFILES,SAR_FOOTPRINTS,sar:{constants:SAR_CONSTANTS}}=require('../src/shared/config.cjs');
const {profileMetrics}=require('./sar_quality_probe.cjs');
const mean=values=>values.reduce((sum,value)=>sum+value,0)/values.length;
function flatScene(){const scene=demoScene();scene.terrain.forEach(p=>p[1]=80);scene.center[1]=80;return scene;}
function correlation(a,b){const ma=mean(a),mb=mean(b);let num=0,da=0,db=0;
  for(let i=0;i<a.length;i++){num+=(a[i]-ma)*(b[i]-mb);da+=(a[i]-ma)**2;db+=(b[i]-mb)**2;}return num/Math.sqrt(da*db);}
// Block average in place of multi-look: it suppresses the speckle realisation difference and
// leaves the mean-power structure both algorithms have to agree on.
function blocks(values,width,size){const out=Math.floor(width/size),result=new Float64Array(out*out);
  for(let r=0;r<out;r++)for(let c=0;c<out;c++){let sum=0;
    for(let i=0;i<size;i++)for(let j=0;j<size;j++)sum+=values[(r*size+i)*width+c*size+j];
    result[r*out+c]=sum/(size*size);}
  return {values:result,width:out};}
// Sub-pixel peak of a 1-D cut (centroid over the samples around the maximum).
function peakOffset(cut){let best=0;for(let i=1;i<cut.length;i++)if(cut[i].power>cut[best].power)best=i;
  let sum=0,moment=0;for(let i=Math.max(0,best-4);i<=Math.min(cut.length-1,best+4);i++){sum+=cut[i].power;moment+=cut[i].offset*cut[i].power;}
  return moment/sum;}
function pointComparison(options,offsets,fine={fov:128,steps:513}){
  const scene=flatScene(),cfg=settings(options),step=fine.fov/(fine.steps-1),points=[];
  let pfaGridMs=0,bpImageMs=0,gridPixels=0;
  for(const [cross,ground] of offsets){
    const point=engine.pixel(scene,cross,ground);
    const data=engine.synthesizeScene(scene,[{pos:point,phase:.7,amplitude:1}],cfg);
    let started=performance.now();
    const image=pfa.focus(data,{},{size:fine.fov,width:fine.steps,step_m:step});
    pfaGridMs+=performance.now()-started;gridPixels=image.grid;
    started=performance.now();const bpImage=focusRows(data,0,cfg.width,{});bpImageMs+=performance.now()-started;
    let peak=0;for(let i=1;i<image.power.length;i++)if(image.power[i]>image.power[peak])peak=i;
    const row=Math.floor(peak/fine.steps),col=peak%fine.steps;
    // Cuts are limited to the target's neighbourhood (as in sar_quality_probe): the patch edge
    // itself is a boundary of the imaged plane and would dominate the sidelobe metric.
    const span=16,cutSteps=Math.round(2*span/step)+1;
    const pfaCross=[],pfaGround=[],bpCross=[],bpGround=[];
    for(let i=0;i<cutSteps;i++){
      const offset=-span+i*step,indexCross=col+Math.round(offset/step),indexGround=row+Math.round(offset/step);
      if(indexCross>=0&&indexCross<fine.steps)pfaCross.push({offset,power:image.power[row*fine.steps+indexCross]});
      if(indexGround>=0&&indexGround<fine.steps)pfaGround.push({offset,power:image.power[indexGround*fine.steps+col]});
      bpCross.push({offset,power:focusPoint(data,engine.pixel(scene,cross+offset,ground))});
      bpGround.push({offset,power:focusPoint(data,engine.pixel(scene,cross,ground+offset))});
    }
    const point_result={target_m:[cross,ground]};
    for(const axis of ['cross','ground']){
      const bpProfile=profileMetrics(axis==='cross'?bpCross:bpGround),pfaProfile=profileMetrics(axis==='cross'?pfaCross:pfaGround);
      point_result[axis]={bp_fwhm_m:+bpProfile.fwhm_m.toFixed(3),pfa_fwhm_m:+pfaProfile.fwhm_m.toFixed(3),
        bp_pslr_db:+bpProfile.pslr_db.toFixed(2),pfa_pslr_db:+pfaProfile.pslr_db.toFixed(2),
        position_error_m:+(peakOffset(axis==='cross'?pfaCross:pfaGround)-peakOffset(axis==='cross'?bpCross:bpGround)).toFixed(3)};
    }
    point_result.pfa_peak_power_vs_bp=+(image.power[peak]/focusPoint(data,point)).toFixed(4);
    point_result.pfa_image_peak_db_vs_bp_peak=+(10*Math.log10(image.power[peak]/Math.max(...bpImage))).toFixed(2);
    points.push(point_result);
  }
  return {comparison:'pfa-vs-backprojection point response',options,
    grid:{fov_m:fine.fov,step_m:+step.toFixed(4),pfa_grid_pixels:gridPixels},
    focus_ms:{pfa_fine_grid_total:+pfaGridMs.toFixed(1),backprojection_total:+bpImageMs.toFixed(1),points:offsets.length},
    points,
    note:'Flat patch, single ideal scatterer, Hann window, one shared echo history; the backprojection cut is evaluated directly, the PFA is sampled from a zero-padded fine grid.'};
}
function imageComparison(file,options){
  const scene=JSON.parse(fs.readFileSync(file,'utf8')),cfg=settings(options);
  let started=performance.now();const scatterers=engine.buildScatterers(scene,cfg);
  const data=engine.synthesizeScene(scene,scatterers,cfg);const synthesisMs=performance.now()-started;
  started=performance.now();const bp=focusRows(data,0,cfg.width,{});const bpFocusMs=performance.now()-started;
  started=performance.now();const image=pfa.focus(data,{});const pfaFocusMs=performance.now()-started;
  const width=cfg.width,mb=mean(bp),mp=mean(image.power);
  const nb=bp.map(v=>v/mb),np=image.power.map(v=>v/mp);
  const argmax=values=>{let best=0;for(let i=1;i<values.length;i++)if(values[i]>values[best])best=i;return best;};
  const relief=Math.max(...scene.terrain.map(p=>p[1]))-Math.min(...scene.terrain.map(p=>p[1]));
  const result={comparison:'pfa-vs-backprojection image',file:path.basename(file),options,width,
    scatterers:scatterers.length,pulses:data.samples.length,terrain_relief_m:+relief.toFixed(2),
    synthesis_ms:+synthesisMs.toFixed(0),bp_focus_ms:+bpFocusMs.toFixed(0),pfa_focus_ms:+pfaFocusMs.toFixed(0),
    pfa_grid:image.grid,pfa_step_m:+image.step_m.toFixed(3),
    mean_power_ratio:+(mp/mb).toExponential(3),raw_correlation:+correlation(nb,np).toFixed(3),
    bp_peak_pixel:[argmax(bp)%width,Math.floor(argmax(bp)/width)],
    pfa_peak_pixel:[argmax(image.power)%width,Math.floor(argmax(image.power)/width)]};
  for(const size of [4,8,16]){
    const a=blocks(nb,width,size),b=blocks(np,width,size),differences=[];
    for(let i=0;i<a.values.length;i++)differences.push(10*Math.log10(b.values[i]/a.values[i]));
    differences.sort((x,y)=>x-y);
    result['looks'+size*size]={blocks:a.width*2,correlation:+correlation(a.values,b.values).toFixed(3),
      db_mean:+mean(differences).toFixed(2),db_p05:+differences[Math.floor(differences.length*.05)].toFixed(2),
      db_p95:+differences[Math.floor(differences.length*.95)].toFixed(2),
      within_1db:+(differences.filter(v=>Math.abs(v)<=1).length/differences.length).toFixed(3),
      within_3db:+(differences.filter(v=>Math.abs(v)<=3).length/differences.length).toFixed(3)};
  }
  result.note='Backprojection focuses the true 3-D terrain; PFA focuses a flat patch at the centre height, so relief moves scatterers by about h/tan(elevation) and the speckle realisation differs wherever both resolve the same cell.';
  return result;
}
module.exports={flatScene,pointComparison,imageComparison,blocks,correlation,peakOffset};
if(require.main===module){
  const args=process.argv.slice(2);let record=null,quality='standard';
  while(args.length){const key=args.shift();if(key==='--record'&&args.length)record=args.shift();else if(key==='--quality'&&args.length)quality=args.shift();else throw Error('Usage: sar_pfa_probe.cjs [--record recordings/sar/x.json] [--quality standard|fine|fast]');}
  const base={width:SAR_PROFILES.standard.width,scatterSpacing:SAR_FOOTPRINTS.detail.scatter_spacing_m,
    window:SAR_CONSTANTS.default_window,bandwidth:SAR_PROFILES.standard.bandwidth_hz};
  const result=record
    ?imageComparison(record,processingOptions({quality,footprint:sceneFootprint(JSON.parse(fs.readFileSync(record,'utf8'))),sceneModel:'classified'},base))
    :{point_response:pointComparison(base,[[0,0],[40,0],[-40,0],[0,40],[40,40]])};
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
}

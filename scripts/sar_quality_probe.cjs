'use strict';
const fs=require('node:fs'),path=require('node:path');
const engine=require('../src/sar_core/engine.cjs');
const {demoScene}=require('../tools/sar_demo_scene.cjs');
const {focusPoint}=require('../src/sar_core/focus.cjs');
const {C_MPS}=require('../src/shared/config.cjs');
const {fwhm}=require('./sar_principle_probe.cjs');
function flatScene(){const scene=demoScene();scene.terrain.forEach(p=>p[1]=80);scene.center[1]=80;return scene;}
function profileMetrics(samples) {
  const peak=samples.reduce((best,v,i)=>v.power>samples[best].power?i:best,0);
  // Mainlobe bounded by nearest local minima (first nulls), not an arbitrary pixel count.
  let left=peak-1,right=peak+1;
  while(left>0&&samples[left-1].power<samples[left].power)left--;
  while(right<samples.length-1&&samples[right+1].power<samples[right].power)right++;
  if(left===0||right===samples.length-1)throw Error('Profile does not contain both first nulls');
  const main=samples.slice(left,right+1).reduce((s,v)=>s+v.power,0);
  const side=samples.slice(0,left).concat(samples.slice(right+1));
  return {fwhm_m:fwhm(samples),peak_offset_m:samples[peak].offset,
    first_nulls_m:[samples[left].offset,samples[right].offset],
    pslr_db:10*Math.log10(Math.max(...side.map(v=>v.power))/samples[peak].power),
    islr_1d_db:10*Math.log10(side.reduce((s,v)=>s+v.power,0)/main),
    profile_extent_m:[samples[0].offset,samples.at(-1).offset],step_m:samples[1].offset-samples[0].offset};
}
function pointQuality(options={}) {
  const scene=flatScene(),point=engine.pixel(scene,0,0);
  const data=engine.synthesizeScene(scene,[{pos:point,phase:.7,amplitude:1}],options);
  const profiles={};
  for(const axis of ['cross','ground']) {
    const samples=Array.from({length:2401},(_,i)=>{const offset=(i-1200)*.01;
      return {offset,power:focusPoint(data,engine.pixel(scene,axis==='cross'?offset:0,axis==='ground'?offset:0))};});
    profiles[axis]=profileMetrics(samples);
  }
  const center=engine.pixel(scene,0,0),mid=scene.trajectory[60].pos,slant=Math.hypot(...center.map((v,i)=>v-mid[i]));
  const delta=scene.trajectory.at(-1).pos.map((v,i)=>v-scene.trajectory[0].pos[i]);
  const los=center.map((v,i)=>(v-mid[i])/slant),radial=delta.reduce((s,v,i)=>s+v*los[i],0);
  const effective=Math.sqrt(delta.reduce((s,v)=>s+v*v,0)-radial*radial);
  return {window:data.cfg.window,profiles,analytic_rect:{cross_fwhm_m:.8859*data.cfg.lambda*slant/(2*effective),
    ground_fwhm_m:.8859*C_MPS/(2*data.cfg.bandwidth)*slant/Math.hypot(center[0]-mid[0],center[2]-mid[2])},
    limits:'1D cuts, finite +/-12 m extent, ideal single point; not terrain/material or calibrated radar performance'};
}
function latticeRatio(image) {
  const {width,power,size_m}=image;let lattice=0,other=0,n=0,m=0;
  for(let row=8;row<width-8;row++)for(let col=8;col<width-8;col++) {
    const x=(col/(width-1)-.5)*size_m,z=(row/(width-1)-.5)*size_m,p=power[row*width+col];
    if(Math.abs(x/8-Math.round(x/8))<1e-8&&Math.abs(z/8-Math.round(z/8))<1e-8){lattice+=p;n++;}else{other+=p;m++;}
  }
  return (lattice/n)/(other/m);
}
// The surface engine replaced the legacy grid scatterer in Gate 5, so the old A/B comparison (and
// the 8 m grid-lock ratio it printed) has no second model left to compare against. What remains is
// the surface model's own grid lock, reported per image: a uniform scatterer grid that showed up as
// a lattice in the image would concentrate power on the 8 m vertices.
function compare(scene) {
  // Common 65x65 grid: rectangular and Hann processing of the same echo model.
  const surface=engine.reconstruct(scene,{window:'rect',width:65,rangeInterpolation:'linear'});
  const hann=engine.reconstruct(scene,{window:'hann',width:65});
  return {source:scene.source,terrain_points:scene.terrain.length,poses:scene.trajectory.length,
    images:{surface_rect:surface,surface_hann:hann},
    grid_lock_power_ratio:{surface_rect:latticeRatio(surface),surface_hann:latticeRatio(hann)}};
}
function htmlReport(report) {
  const data=JSON.stringify(report).replace(/</g,'\u003c');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>SAR 散射与聚焦对照</title>
<style>body{font:16px system-ui;background:#10151b;color:#d2dfec;margin:24px}main{display:flex;flex-wrap:wrap;gap:20px}canvas{width:360px;height:360px;image-rendering:pixelated;border:1px solid #586674}pre{white-space:pre-wrap}.warning{color:#f3c674}table{border-collapse:collapse}td,th{border:1px solid #586674;padding:9px;text-align:left}a{color:#91c9ff}</style>
<h1>SAR 散射与聚焦对照</h1><p class="warning">同一高程与轨迹，假设散射。各图分别按峰值归一化；可比较纹理和网格伪影，不能比较绝对亮度或识别真实地物。</p>
<p id="source"></p><p>横轴：视线横向 −64 → +64 m；纵轴：地距 +64 → −64 m。黑 −40 dB，白 0 dB。</p><main id="images"></main><h2>8 m 网格顶点/其他位置功率比</h2><p>理想均匀表面应接近 1；这里仅是人工网格锁定诊断，不是通用图像质量评分。</p><table><tbody id="grid"></tbody></table><h2>理想单点响应检查</h2><table><thead><tr><th>聚焦窗 / 方向</th><th>半功率主瓣宽度 m</th><th>峰值旁瓣 dB</th><th>积分旁瓣 dB</th></tr></thead><tbody id="point"></tbody></table><p>单点使用另一个理想平地场景；1D 截面范围 ±12 m、采样间隔 0.01 m。积分旁瓣只统计此截面范围；这些数值不能当作实飞地物分辨率。旁瓣下降伴随主瓣变宽。</p><details><summary>单点检查原始数据</summary><pre id="raw"></pre></details>
<script>const report=${data};document.getElementById('source').textContent='输入来源 '+report.comparison.source+' · 轨迹 '+report.comparison.poses+' 帧';
const names={surface_rect:'随机表面散射 + 矩形窗',surface_hann:'随机表面散射 + Hann 窗'};
for(const [key,img]of Object.entries(report.comparison.images)){const section=document.createElement('section'),title=document.createElement('h2'),canvas=document.createElement('canvas');title.textContent=names[key];canvas.width=canvas.height=img.width;const ctx=canvas.getContext('2d'),pixels=ctx.createImageData(img.width,img.width);for(let row=0;row<img.width;row++)for(let col=0;col<img.width;col++){const i=row*img.width+col,v=Math.round((img.db[(img.width-1-row)*img.width+col]+40)/40*255);pixels.data[i*4]=pixels.data[i*4+1]=pixels.data[i*4+2]=v;pixels.data[i*4+3]=255;}ctx.putImageData(pixels,0,0);section.append(title,canvas);document.getElementById('images').append(section);}
function row(id,values){const tr=document.createElement('tr');for(const value of values){const td=document.createElement('td');td.textContent=value;tr.append(td);}document.getElementById('grid').append(tr);}
for(const [key,value]of Object.entries(report.comparison.grid_lock_power_ratio))row('grid',[names[key],value.toFixed(3)]);
for(const [window,q]of Object.entries(report.point_response))for(const [axis,p]of Object.entries(q.profiles))row('point',[(window==='rect'?'矩形窗':'Hann 窗')+' / '+(axis==='cross'?'横向':'地距'),p.fwhm_m.toFixed(3),p.pslr_db.toFixed(2),p.islr_1d_db.toFixed(2)]);
document.getElementById('raw').textContent=JSON.stringify(report.point_response,null,2);</script></html>`;
}
module.exports={flatScene,profileMetrics,pointQuality,latticeRatio,compare,htmlReport};
if(require.main===module) {
  const args=process.argv.slice(2);let scene=flatScene(),output;
  while(args.length){const key=args.shift(),value=args.shift();if(key==='--record'&&value)scene=JSON.parse(fs.readFileSync(value));else if(key==='--html'&&value)output=value;else throw Error('Usage: sar_quality_probe.cjs [--record scene.json] [--html output.html]');}
  const comparison=compare(scene),point_response={rect:pointQuality({window:'rect'}),hann:pointQuality({window:'hann'})};
  if(output){fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,htmlReport({comparison,point_response}));}
  const compact={...comparison};delete compact.images;console.log(JSON.stringify({...compact,point_response},null,2));
}

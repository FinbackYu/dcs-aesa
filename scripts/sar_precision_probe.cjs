'use strict';
const fs=require('node:fs'),path=require('node:path');
const {validate}=require('../src/sar_core/geometry.cjs'),{reconstruct}=require('../src/sar_core/engine.cjs');
const {PROFILES}=require('../src/sar_core/settings.cjs');
const {processingOptions,sceneFootprint}=require('../src/adapters/dcs/sar_adapter.cjs');
const {pointQuality}=require('./sar_quality_probe.cjs');
function compare(scene){
  validate(scene);
  const footprint=sceneFootprint(scene),images={},points={};
  if(!footprint)throw Error('Scene size/grid does not match a known SAR footprint');
  for(const name of Object.keys(PROFILES)){
    const options={...processingOptions({quality:name,footprint,sceneModel:'uniform'},{window:'hann'}),window:'hann'};
    images[name]=reconstruct(scene,options);
    points[name]=pointQuality(options);
  }
  return {source:scene.source,poses:scene.trajectory.length,terrain_spacing_m:scene.size/(scene.n-1),footprint,images,points};
}
function html(report){
  const data=JSON.stringify(report).replace(/</g,'\\u003c');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>SAR 精细档对照</title>
<style>body{font:16px system-ui;background:#10151b;color:#d2dfec;margin:24px}main{display:flex;flex-wrap:wrap;gap:20px}canvas{width:360px;height:360px;image-rendering:pixelated;border:1px solid #586674}table{border-collapse:collapse}td,th{padding:9px;border:1px solid #586674;text-align:left}.warning{color:#f3c674}p{max-width:1150px;line-height:1.6}</style>
<h1>SAR 精细档：同一 DCS 地形 / 轨迹对照</h1><p class="warning">模拟散射和波形；提高模拟带宽会重新合成回波，不是在真实接收数据中增加信息。地形仍为 8 m，无建筑、材质或遮挡输入。</p>
<p id="source"></p><main id="images"></main><p>中、右两图使用相同 30 dB 显示范围；左、中两图是同一标准功率矩阵，仅改变显示对比度。各成像结果按本图峰值归一化，不比较绝对亮度。横轴视线横向 −64→+64 m，纵轴地距 +64→−64 m。</p>
<h2>理想点响应与处理耗时</h2><table><thead><tr><th>档位</th><th>模拟带宽</th><th>输出间隔</th><th>横向 FWHM</th><th>地距 FWHM</th><th>本次图像计算</th></tr></thead><tbody id="metrics"></tbody></table>
<p>点响应使用独立理想平地：20 km 地距、4 km 平台高度、250 m/s、2 s、Hann；±12 m 截面，0.01 m 步长。指标不是本次真实地物的分辨率或识别能力。更宽带宽改善距离方向的理想响应；当前孔径不变，横向不会因此翻倍改善。细化像素不补足地形数据。</p>
<script>const report=${data};document.getElementById('source').textContent='已有录制来源 '+report.source+' · '+report.poses+' 帧 · 地形间隔 '+report.terrain_spacing_m+' m';
for(const [key,title,range]of [['standard','标准 / 40 dB',40],['standard','标准 / 30 dB',30],['fine','精细 / 30 dB',30]]){
const img=report.images[key],section=document.createElement('section'),h=document.createElement('h2'),canvas=document.createElement('canvas');h.textContent=title;canvas.width=canvas.height=img.width;const ctx=canvas.getContext('2d'),pixels=ctx.createImageData(img.width,img.width);
for(let row=0;row<img.width;row++)for(let col=0;col<img.width;col++){const i=row*img.width+col,v=Math.round(Math.max(0,Math.min(1,(img.db[(img.width-1-row)*img.width+col]+range)/range))*255);pixels.data[i*4]=pixels.data[i*4+1]=pixels.data[i*4+2]=v;pixels.data[i*4+3]=255;}ctx.putImageData(pixels,0,0);section.append(h,canvas);document.getElementById('images').append(section);}
for(const key of ['standard','fine']){const p=report.points[key],m=report.images[key].metadata,tr=document.createElement('tr');for(const v of [key==='fine'?'精细':'标准',m.bandwidth_hz/1e6+' MHz',m.image_step_m+' m',p.profiles.cross.fwhm_m.toFixed(3)+' m',p.profiles.ground.fwhm_m.toFixed(3)+' m',(m.compute_ms/1000).toFixed(2)+' s']){const td=document.createElement('td');td.textContent=v;tr.append(td);}document.getElementById('metrics').append(tr);}</script></html>`;
}
module.exports={compare,html};
if(require.main===module){
  const [input,output]=process.argv.slice(2);if(!input||!output)throw Error('Usage: sar_precision_probe.cjs scene.json report.html');
  const report=compare(JSON.parse(fs.readFileSync(input,'utf8')));fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,html(report));
  const compact={source:report.source,poses:report.poses,terrain_spacing_m:report.terrain_spacing_m};
  for(const key of ['standard','fine'])compact[key]={bandwidth_hz:report.images[key].metadata.bandwidth_hz,image_step_m:report.images[key].metadata.image_step_m,compute_ms:report.images[key].metadata.compute_ms,cross_fwhm_m:report.points[key].profiles.cross.fwhm_m,ground_fwhm_m:report.points[key].profiles.ground.fwhm_m};
  console.log(JSON.stringify(compact,null,2));
}

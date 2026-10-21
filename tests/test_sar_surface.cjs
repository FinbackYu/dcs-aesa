'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {demoScene}=require('../tools/sar_demo_scene.cjs');
const engine=require('../src/sar_core/engine.cjs');
const {pointQuality}=require('../scripts/sar_quality_probe.cjs');
const {envelope,kernelTable}=require('../src/sar_core/waveform.cjs');
const {focusPoint}=require('../src/sar_core/focus.cjs');
const {sceneToWorld,worldToScene,pixelCenter}=require('../src/sar_core/geometry.cjs');
function flatScene(){const s=demoScene();s.terrain.forEach(p=>p[1]=80);s.center[1]=80;return s;}
// Occlusion fixtures: a ridge spanning the patch across the line of sight, and a wall standing
// perpendicular to it. Both are the geometries the shadow/layover checks need.
function groundOf(s,p){return worldToScene(s.center,s.bearing,p[0],p[2])[1];}
function ridgeScene(){const s=flatScene();for(const p of s.terrain)if(Math.abs(groundOf(s,p))<=8)p[1]+=12;return s;}
function wallScene(height){
  const s=flatScene(),c=engine.pixel(s,0,0),r=Math.SQRT1_2;
  s.objects=[{kind:'static',pos:[c[0],c[1],c[2]],axes:[[r,0,r],[0,1,0],[-r,0,r]],min:[-2,0,-20],max:[2,height,20]}];
  return s;
}
// The patch-centre cross column as [ground offset, power] pairs: shadows and layover both displace
// returns along the ground (range) axis, so that is where they are visible.
function centreColumn(image){
  const width=image.width,col=Math.round((width-1)/2),out=[];
  for(let row=0;row<width;row++)out.push({ground:pixelCenter(row,image.size_m,width),power:image.power[row*width+col]});
  return out;
}
function latticeRatio(image){
  const {width,power,size_m}=image;let lattice=0,other=0,n=0,m=0;
  for(let row=8;row<width-8;row++)for(let col=8;col<width-8;col++){
    const x=pixelCenter(col,size_m,width),z=pixelCenter(row,size_m,width),p=power[row*width+col];
    if(Math.abs(x/8-Math.round(x/8))<1e-8&&Math.abs(z/8-Math.round(z/8))<1e-8){lattice+=p;n++;}else{other+=p;m++;}
  }
  return (lattice/n)/(other/m);
}
test('pixel() maps scene coordinates through the canonical scene geometry',()=>{
  const s=flatScene();
  for(const cross of [-s.size,-s.size/2,-13.25,0,7.5,s.size/2,s.size])
    for(const ground of [-s.size,-s.size/2,0,11.75,s.size/2,s.size]){
      const [x,z]=sceneToWorld(s.center,s.bearing,cross,ground);
      const p=engine.pixel(s,cross,ground);
      assert.equal(p[0],x,`x at ${cross},${ground}`);
      assert.equal(p[2],z,`z at ${cross},${ground}`);
      assert.equal(p[1],80,'the flat patch height is interpolated');
    }
});
test('Flat assumed surface does not concentrate image power on the DEM vertex lattice',()=>{
  const image=engine.reconstruct(flatScene());
  assert.ok(latticeRatio(image)<2,`8 m lattice power ratio ${latticeRatio(image)}`);
});
test('Single-point location is not biased toward the range-bin lattice',()=>{
  for(const window of ['rect','hann'])for(const p of Object.values(pointQuality({window}).profiles))
    assert.ok(Math.abs(p.peak_offset_m)<.025,`range-bin location bias ${p.peak_offset_m} m`);
});
test('Point widths match independent rectangular predictions; Hann reduces sidelobes with wider lobes',()=>{
  const rect=pointQuality({window:'rect'}),hann=pointQuality({window:'hann'});
  for(const axis of ['cross','ground']) {
    assert.ok(Math.abs(rect.profiles[axis].fwhm_m/rect.analytic_rect[axis+'_fwhm_m']-1)<.04);
    assert.ok(rect.profiles[axis].pslr_db>-14&&rect.profiles[axis].pslr_db<-12.5);
    assert.ok(hann.profiles[axis].pslr_db<-30);
    assert.ok(hann.profiles[axis].fwhm_m/rect.profiles[axis].fwhm_m>1.55);
    assert.ok(hann.profiles[axis].fwhm_m/rect.profiles[axis].fwhm_m<1.7);
    assert.ok(hann.profiles[axis].islr_1d_db<rect.profiles[axis].islr_1d_db-15);
  }
});
test('Fine waveform halves ideal range mainlobe without claiming a shorter cross-range lobe',()=>{
  const standard=pointQuality({window:'hann',bandwidth:75e6}),fine=pointQuality({window:'hann',bandwidth:150e6,width:257});
  assert.ok(Math.abs(fine.profiles.ground.fwhm_m/standard.profiles.ground.fwhm_m-.5)<.02);
  assert.ok(Math.abs(fine.profiles.cross.fwhm_m/standard.profiles.cross.fwhm_m-1)<.04);
  assert.ok(fine.profiles.ground.pslr_db<-30);
});
test('Hann compressed envelope agrees with independent frequency-domain quadrature',()=>{
  for(const u of [.125,.7,1.3,3,12]){
    let sum=0,norm=0;const n=4000;
    for(let i=0;i<=n;i++){const f=i/n-.5,w=(.5+.5*Math.cos(2*Math.PI*f))*(i===0||i===n?.5:1);sum+=w*Math.cos(2*Math.PI*f*u);norm+=w;}
    assert.ok(Math.abs(envelope(u,'hann')-sum/norm)<1e-7);
  }
});
test('Fast envelope lookup preserves analytic amplitude to within 1e-7',()=>{
  for(const window of ['rect','hann']){const table=kernelTable(window);
    for(let i=0;i<500;i++){const u=-15.999+i*31.998/500,index=(u+16)*2048,j=Math.floor(index),f=index-j;
      assert.ok(Math.abs(table[j]*(1-f)+table[j+1]*f-envelope(u,window))<1e-7);}
  }
});
test('Diffuse samples are repeatable, anchored across overlapping patches, and area normalized',()=>{
  const s=flatScene(),a=engine.buildScatterers(s),again=engine.buildScatterers(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(a,again);assert.ok(a.length>16000&&a.length<16800);
  const moved=flatScene();moved.center[0]+=4;moved.terrain.forEach(p=>p[0]+=4);
  const b=new Map(engine.buildScatterers(moved).map(p=>[p.key,p]));let overlaps=0;
  for(const p of a)if(b.has(p.key)){const q=b.get(p.key);assert.equal(p.phase,q.phase);assert.ok(Math.hypot(...p.pos.map((v,i)=>v-q.pos[i]))<1e-8);overlaps++;}
  assert.ok(overlaps>a.length*.9);
  const energy=points=>points.reduce((sum,p)=>sum+p.amplitude*p.amplitude,0);
  for(const spacing of [2,4])assert.ok(Math.abs(energy(engine.buildScatterers(s,{scatterSpacing:spacing}))/energy(a)-1)<.04);
  const changed=engine.buildScatterers(s,{seed:99});assert.notEqual(changed[0].phase,a[0].phase);
});
test('Independent path errors and off-center points affect coherent focusing',()=>{
  const s=flatScene(),p=engine.pixel(s,3,5),data=engine.synthesizeScene(s,[{pos:p,phase:0,amplitude:1}],{window:'rect'});
  const good=focusPoint(data,p),wrong=focusPoint(data,engine.pixel(s,-3,5));
  assert.ok(good>.99);assert.ok(wrong<good*.05);
  assert.ok(focusPoint(data,p,{erasePhase:true})<good*.15);
  assert.ok(focusPoint(data,p,{rangeError:i=>.004*Math.sin(2*Math.PI*7*i/120)})<good*.3);
});
test('Surface computation bounds reject unsupported options and malformed scatterers',()=>{
  const s=flatScene();for(const opts of [{scatterSpacing:0},{seed:NaN},{width:2048},{window:'bad'},{bandwidth:Infinity}])
    assert.throws(()=>engine.buildScatterers(s,opts),/settings/);
  assert.throws(()=>engine.synthesizeScene(s,[{pos:[0,NaN,0],phase:0,amplitude:1}]),/scatterers/);
  // The legacy grid scatterer is gone in Gate 5, so there is no second scatter model to switch to:
  // unsupported options are refused by settings(), including an unknown focuser.
  assert.throws(()=>engine.reconstruct(s,{focuser:'unknown'}),/settings/);
});
test('A ridge leaves the ground behind it truly black and the lit side unchanged',()=>{
  const scene=ridgeScene(),options={scatterSpacing:4,width:65};
  const shadowed=engine.reconstruct(scene,options),open=engine.reconstruct(scene,{...options,shadow:false});
  assert.equal(shadowed.metadata.shadow,true);assert.equal(shadowed.metadata.shadow_look,'center');
  assert.ok(shadowed.metadata.shadowed_terrain>0,'the ridge blocks terrain');
  assert.equal(shadowed.metadata.shadowed_objects,0);
  assert.equal(shadowed.metadata.shadowed_scatterers,shadowed.metadata.shadowed_terrain+shadowed.metadata.shadowed_objects);
  assert.equal(open.metadata.shadowed_scatterers,0);assert.equal(open.metadata.visibility,'not modeled');
  assert.match(shadowed.metadata.visibility,/outside patch unknown/);
  const on=centreColumn(shadowed),off=centreColumn(open),peak=Math.max(...shadowed.power);
  const region=rows=>rows.filter(({ground})=>ground>=16&&ground<64);
  const shadowMean=region(on).reduce((sum,v)=>sum+v.power,0)/region(on).length;
  const openMean=region(off).reduce((sum,v)=>sum+v.power,0)/region(off).length;
  assert.ok(Math.max(...region(on).map(v=>v.power))<peak*1e-4,`the shadow sits at least 40 dB under the peak: ${Math.max(...region(on).map(v=>v.power))} against ${peak}`);
  assert.ok(openMean>shadowMean*1e3,`the open image does light that ground (${openMean} against ${shadowMean}): the darkness is the shadow, not a quiet scene`);
  for(const {ground,power} of on)if(ground<-16)assert.ok(Math.abs(power/off.find(v=>v.ground===ground).power-1)<.1,`ground ${ground} m in front stays lit`);
});
test('A building shadows its own footprint and the ground behind it, never the ground in front',()=>{
  const scene=flatScene(),c=engine.pixel(scene,0,0),options={scatterSpacing:4,width:65};
  scene.objects=[{kind:'static',pos:[c[0],c[1],c[2]],axes:[[1,0,0],[0,1,0],[0,0,1]],min:[-10,0,-10],max:[10,20,10]}];
  const shadowed=engine.reconstruct(scene,options),open=engine.reconstruct(scene,{...options,shadow:false});
  assert.ok(shadowed.metadata.shadowed_objects>0,'the box blocks ground');assert.equal(shadowed.metadata.shadowed_terrain,0);
  assert.equal(shadowed.metadata.shadow_objects,1,'the box is used for shadowing even in the uniform model');
  const on=centreColumn(shadowed),off=centreColumn(open),peak=Math.max(...shadowed.power);
  const select=(rows,from,to)=>rows.filter(({ground})=>ground>from&&ground<to);
  const mean=rows=>rows.reduce((sum,v)=>sum+v.power,0)/rows.length;
  assert.ok(Math.max(...select(on,-6,64).map(v=>v.power))<peak*1e-4,'the footprint and the shadow behind it are black at least 40 dB under the peak');
  assert.ok(mean(select(on,-6,64))*1e3<mean(select(off,-6,64)),'the open image does light that ground');
  assert.ok(Math.abs(mean(select(on,-64,-16))/mean(select(off,-64,-16))-1)<.1,'the ground in front of the building keeps its level');
});
test('A wall return is displaced toward the radar by about H*h/g, and more so when it is taller',()=>{
  const options={scatterSpacing:4,width:65,sceneModel:'classified'},plain=flatScene();
  const open=engine.reconstruct(plain,options),base=engine.pixel(plain,0,0),mid=plain.trajectory[60].pos;
  const H=mid[1]-base[1],g=Math.hypot(base[0]-mid[0],base[2]-mid[2]);
  const added=height=>{
    const image=engine.reconstruct(wallScene(height),options),on=centreColumn(image),off=centreColumn(open);
    let moment=0,mass=0,far=0,peak=0,peakAt=null;
    for(let i=0;i<on.length;i++){
      const value=Math.max(0,on[i].power-off[i].power),ground=on[i].ground;
      moment+=value*ground;mass+=value;if(ground<-6)far+=value;
      if(value>peak){peak=value;peakAt=ground;}
    }
    return {centroid:moment/mass,mass,peakAt,farShare:far/mass};
  };
  const short=added(25),tall=added(100);
  assert.ok(short.centroid<0&&tall.centroid<short.centroid,'the wall return sits on the radar side and moves nearer as it grows');
  const predicted=-(H/g)*100;
  assert.ok(Math.abs(tall.peakAt-predicted)<.25*Math.abs(predicted),`the tall wall peaks at ${tall.peakAt} m against H*h/g = ${predicted.toFixed(1)} m`);
  assert.ok(short.farShare<.1&&tall.farShare>.5,`a taller wall pushes more of its energy past its own footprint (${short.farShare.toFixed(3)} vs ${tall.farShare.toFixed(3)})`);
  assert.ok(tall.mass>0&&short.mass>0,'the wall returns reach the image at all');
});
test('Shadow off is an explicit control; a flat patch is bit-identical either way',()=>{
  const scene=flatScene(),options={scatterSpacing:4,width:65};
  const on=engine.reconstruct(scene,options),off=engine.reconstruct(scene,{...options,shadow:false});
  assert.deepEqual(on.power,off.power,'nothing to occlude means the mask changes no arithmetic');
  assert.equal(on.metadata.shadowed_scatterers,0);assert.equal(off.metadata.visibility,'not modeled');
  assert.match(on.metadata.layover,/no object scatterers/);
  assert.throws(()=>engine.reconstruct(scene,{...options,shadowLook:'sometimes'}),/settings/);
  assert.throws(()=>engine.reconstruct(scene,{...options,shadow:'yes'}),/settings/);
});
test('Per-pulse occlusion reproduces the one-look image when the occluder spans the patch',()=>{
  const scene=ridgeScene(),options={scatterSpacing:4,width:65,sceneModel:'classified'};
  const centre=engine.reconstruct(scene,options),pulse=engine.reconstruct(scene,{...options,shadowLook:'pulse'});
  assert.equal(pulse.metadata.shadow_look,'pulse');
  assert.match(pulse.metadata.visibility,/per-pulse/);
  assert.deepEqual(centre.power,pulse.power,'the ridge blocks every pulse identically, so the cheap one-look mask is exact here');
  assert.equal(centre.metadata.shadowed_scatterers,pulse.metadata.shadowed_scatterers,'the reported mask is the aperture-centre one in both modes');
});
module.exports={flatScene,latticeRatio};

'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {SURFACE_CLASSES}=require('../src/shared/config.cjs');
const {demoScene}=require('../tools/sar_demo_scene.cjs');
const {pixel,buildScatterers}=require('../src/sar_core/engine.cjs');
const scattering=require('../src/sar_core/scatterers.cjs');
// The surface vocabulary moved to materials.cjs in Gate 5; the scatterers keep the geometry.
const materials=require('../src/sar_core/materials.cjs');
const {worldToScene}=require('../src/sar_core/geometry.cjs');
// A 128 m patch whose terrain is flat unless `step` raises everything at cross>0, plus an optional
// box at the patch centre. Both are the geometries the shadow and layover tests need.
function scene({ridge=false,box=null}={}){
  const s=demoScene();
  for(const p of s.terrain)p[1]=80+(ridge&&Math.abs(groundOffset(s,p))<=8?12:0);
  s.center[1]=80;
  if(box!==null){const c=pixel(s,0,0);s.objects=[{kind:'static',pos:[c[0],c[1],c[2]],axes:[[1,0,0],[0,1,0],[0,0,1]],min:[-10,0,-10],max:[10,box,10]}];}
  return s;
}
const midpose=s=>s.trajectory[Math.floor(s.trajectory.length/2)].pos;
const groundOffset=(s,p)=>worldToScene(s.center,s.bearing,p[0],p[2])[1];
const points=options=>buildScatterers(scene(options),{scatterSpacing:4,width:65,...options});
test('Scene-local projection and surface lookup use the canonical grid',()=>{
  const s=scene();
  s.surfaces=Array(s.n*s.n).fill('land');
  s.surfaces[0]='water';
  for(const p of [[s.center[0],s.center[1],s.center[2]],
    [s.center[0]+13.5,s.center[1],s.center[2]-7.25],
    [s.center[0]-40,s.center[1]+3,s.center[2]+31]])
    assert.deepEqual(scattering.local(s,p),worldToScene(s.center,s.bearing,p[0],p[2]));
  assert.equal(materials.materialAt(s,-s.size/2,-s.size/2),'water','the lower-left texel');
  assert.equal(materials.materialAt(s,-10*s.size,-10*s.size),'water','outside the patch clamps to the same corner');
  assert.equal(materials.materialAt(s,0,0),'land');
});
test('The fast DEM sampler agrees with pixel() everywhere, including outside the patch',()=>{
  const s=scene({ridge:true}),sample=scattering.createSampler(s);
  for(let c=-90;c<=90;c+=7)for(let g=-90;g<=90;g+=7)
    assert.ok(Math.abs(sample(c,g)-pixel(s,c,g)[1])<1e-12,`sampler differs at ${c},${g}`);
});
test('terrainBlocked keeps its public behaviour and the sampler returns the same answer',()=>{
  const s=scene({ridge:true}),sample=scattering.createSampler(s),mid=midpose(s);
  const behind=pixel(s,0,40);
  assert.equal(scattering.terrainBlocked(s,mid,behind,pixel),true,'the ridge blocks the ground behind it');
  assert.equal(scattering.terrainBlocked(s,mid,behind,pixel,sample),true,'the sampler returns the same answer');
  assert.equal(scattering.terrainBlocked(s,mid,pixel(s,0,-40),pixel),false,'ground in front of the ridge stays visible');
  const flat=scene();
  assert.equal(scattering.terrainBlocked(flat,midpose(flat),pixel(flat,0,40),pixel),false,'flat ground blocks nothing');
});
test('One look marks terrain and object occluders separately and reproducibly',()=>{
  const s=scene({ridge:true,box:20}),options={ridge:true,box:20,sceneModel:'classified'};
  const a=points(options),stats=scattering.visibilityStats(a),again=points(options);
  assert.deepEqual(stats,scattering.visibilityStats(again),'the mask is reproducible');
  assert.ok(stats.terrain>0,'the ridge shadows the ground behind it');
  assert.ok(stats.object>0,'the box shadows ground behind it');
  assert.equal(stats.blocked,stats.terrain+stats.object);
  assert.equal(stats.tested,a.length,'every scatterer is decided');
  for(const p of a)assert.ok(p.blocked_by===undefined||['terrain','object'].includes(p.blocked_by));
  const blockedPoint=a.find(p=>p.blocked_by==='terrain');
  assert.equal(scattering.occluder(s,blockedPoint,midpose(s),scattering.modelObjects(s),pixel,scattering.createSampler(s)),'terrain','the mask is a property of the look');
});
test('A blocked scatterer contributes nothing, and the mask never changes a visible one',()=>{
  const s=scene({ridge:true,box:20}),mid=midpose(s),sample=scattering.createSampler(s),objects=scattering.modelObjects(s);
  const all=points({ridge:true,box:20,sceneModel:'classified'}),blocked=all.filter(p=>p.blocked_by),visible=all.filter(p=>!p.blocked_by);
  assert.ok(blocked.length>0&&visible.length>0);
  for(const p of blocked)assert.equal(scattering.amplitude(s,p,mid,objects,pixel),0,'masked echo is silent');
  for(const p of blocked)assert.equal(scattering.amplitude(s,p,mid,objects,pixel,{perPulse:true,sampler:sample}),0,'per-pulse agrees at the same pose');
  for(const p of visible.slice(0,50)){
    assert.equal(scattering.amplitude(s,p,mid,objects,pixel),scattering.amplitude(s,{...p,blocked_by:undefined},mid,objects,pixel),'a visible scatterer keeps its amplitude');
    assert.ok(scattering.amplitude(s,p,mid,objects,pixel)>0,'and is not silently dropped');
  }
});
test('One look matches the per-pulse decision for a broad occluder and moves few points for a box',()=>{
  const flips=(scene,points,objects)=>{
    const sample=scattering.createSampler(scene),first=scene.trajectory[0].pos;
    return points.filter(p=>Boolean(scattering.occluder(scene,p,first,objects,pixel,sample))!==Boolean(p.blocked_by)).length;
  };
  const ridge=scene({ridge:true}),ridgePoints=points({ridge:true,sceneModel:'classified'});
  assert.equal(flips(ridge,ridgePoints,scattering.modelObjects(ridge)),0,'a ridge that spans the patch is blocked identically for every pulse of the aperture');
  const boxed=scene({box:20}),boxPoints=points({box:20,sceneModel:'classified'}),moved=flips(boxed,boxPoints,scattering.modelObjects(boxed));
  assert.ok(moved>0,'a compact occluder does move its shadow edge with the platform');
  assert.ok(moved<boxPoints.length*.01,`but only ${moved} of ${boxPoints.length} points change: the one-look trade-off is stated, not hidden`);
  const flat=points({}),flatStats=scattering.visibilityStats(flat);
  assert.equal(flatStats.blocked,0,'a flat patch has nothing to occlude');
  assert.equal(flatStats.tested,flat.length);
});
test('Layover ordering: a face return has a shorter slant range than the ground under it',()=>{
  const s=scene({box:24}),mid=midpose(s),base=pixel(s,0,0),top=[base[0],base[1]+24,base[2]];
  const baseRange=Math.hypot(...base.map((v,i)=>v-mid[i])),topRange=Math.hypot(...top.map((v,i)=>v-mid[i]));
  assert.ok(topRange<baseRange,'the higher return is nearer in slant range: the layover ordering');
  const H=mid[1]-base[1],g=Math.hypot(base[0]-mid[0],base[2]-mid[2]),expected=H*24/g;
  assert.ok(Math.abs(baseRange-topRange-expected)<.05*expected,`slant-range difference ${(baseRange-topRange).toFixed(2)} m matches H*h/g = ${expected.toFixed(2)} m`);
  assert.ok(Math.abs(groundOffset(s,base))<1e-9,'the box stands at the patch-centre ground range');
});

// The ground map's surface classes: the engine's native probe reports up to 16 classes per point, the
// legacy terrain API only five. These tests pin the vocabulary, the coefficients and the one-class pick.
test('Surface vocabulary: 16 engine classes plus the five legacy names, all positive reflectivities',()=>{
  const {MATERIALS}=materials;
  const engine=SURFACE_CLASSES;
  assert.deepEqual(materials.SURFACE_CLASSES,engine,'the probe vocabulary is the generated 16 classes');
  for(const name of engine)assert.ok(Number.isFinite(MATERIALS[name])&&MATERIALS[name]>0,`${name} has a positive coefficient`);
  for(const name of ['unknown','shallow_water','water'])assert.ok(Number.isFinite(MATERIALS[name])&&MATERIALS[name]>0,`legacy ${name} is still there`);
  // 0 dB is land at normal incidence, so every other class is a ratio to it. The man-made order is the one
  // the display needs: buildings (double bounce) far above bare ground, towns next, vegetation a little up,
  // fields/beach a little down, the linear infrastructure specular dark, water darkest.
  const db=name=>10*Math.log10(MATERIALS[name]/MATERIALS.land);
  assert.ok(db('building')>=6&&db('building')<=10,`building is +6..10 dB (${db('building').toFixed(1)})`);
  assert.ok(db('construction')>=6&&db('construction')<db('building'),`construction is high but under a finished wall (${db('construction').toFixed(1)})`);
  assert.ok(db('town')>2&&db('town')<db('construction'),'a town cell averages buildings and streets');
  assert.ok(db('trees')>0&&db('forest')>0,'vegetation returns a little above bare ground (volume scattering)');
  assert.ok(db('field')<0&&db('beach')<0,'field and beach read slightly darker than bare land');
  assert.ok(['road','railway','runway'].every(name=>db(name)<db('field')),'roads, railways and runways are specular dark');
  assert.ok(['sea','river','lake'].every(name=>db(name)<-13),'the water family is the darkest');
  assert.ok(db('sea')<db('lake')&&db('lake')<db('river'),'open sea calmer than a lake, a river rougher still');
  assert.ok(db('traffic')<0&&db('traffic')>db('road'),'a few metal vehicles lift a road cell a little');
  assert.ok(MATERIALS.particle_effect>0,`particle effects get a small but positive value (${MATERIALS.particle_effect})`);
  // The monotone chain the docs quote, kept as one assertion so a later edit cannot quietly reorder it.
  const chain=['building','construction','town','forest','trees','land','beach','field','traffic','road','railway','runway','particle_effect','river','lake','sea'];
  for(let i=1;i<chain.length;i++)assert.ok(MATERIALS[chain[i-1]]>MATERIALS[chain[i]],`${chain[i-1]} > ${chain[i]}`);
});

test('Surface pick: a multi-class union becomes the most radar-significant class',()=>{
  const {pickSurface}=materials;
  // The measured runway point is a union of seven classes; the frozen policy takes the town (it outranks
  // the runway), because the base map's job is to show the installation, not land use.
  assert.equal(pickSurface(['land','runway','road','railway','town','field','beach']),'town');
  assert.equal(pickSurface(['land','runway','road']),'runway');
  assert.equal(pickSurface(['land','building','trees']),'building');
  assert.equal(pickSurface(['trees','forest']),'trees','the frozen order puts trees ahead of forest');
  assert.equal(pickSurface(['land']),'land');
  assert.equal(pickSurface(['sea','land']),'land','water never overrides the ground it lies in');
  assert.equal(pickSurface(['water']),'water','legacy single-class values pass through');
  assert.equal(pickSurface(['shallow_water','land']),'land');
  assert.equal(pickSurface([]),'unknown');
  assert.equal(pickSurface(['not_a_class']),'unknown','an unknown name is not a class');
  // Every class appears in the priority table exactly once, so "pick" is total over the vocabulary.
  assert.deepEqual([...materials.SURFACE_PRIORITY].sort(),[...materials.SURFACE_CLASSES].sort());
});

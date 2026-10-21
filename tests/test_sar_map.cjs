'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),http=require('node:http');
const {createService}=require('../tools/sar_live.cjs');
const {demoScene}=require('../tools/sar_demo_scene.cjs');
const map=require('../src/sar_core/map.cjs');
// The lattice window, sector planning and job splitting are service concerns: they left the
// core's map.cjs in Gate 5 and live with the service that schedules the collection.
const lattice=require('../tools/sar_service/coverage_index.cjs');
const {sar,PROTOCOL}=require('../src/shared/config.cjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(condition,label='condition'){for(let i=0;i<750;i++){if(await condition())return;await delay(20);}throw Error(`wait timed out: ${label}`);}
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
// Synthetic DEM used by the render tests: a flat plain, one north-south ridge and a lake band.
function ridgeTerrain(){
  const step=250,cache=map.createCache({cell_m:step});
  for(let ix=-240;ix<=240;ix++)for(let iz=-240;iz<=240;iz++){
    const x=ix*step;
    cache.setHeight(ix,iz,(x>=4000&&x<=4500)?900:100);
    cache.setSurface(ix,iz,x<=-3000?'water':'land');
  }
  return {cache,step};
}

test('Beam kernel: normalised, symmetric, peaked at the centre and wider with slant range',()=>{
  const {K,weights}=map.beamWeights(500,250);
  assert.equal(K,Math.ceil(3*500/250));
  assert.equal(weights.length,2*K+1);
  assert.ok(Math.abs(weights.reduce((a,b)=>a+b,0)-1)<1e-12,'normalised power pattern');
  for(let k=1;k<=K;k++){
    assert.ok(weights[K+k]>0&&weights[K-k]>0,'kernel stays positive');
    assert.ok(Math.abs(weights[K+k]-weights[K-k])<1e-15,'symmetric');
    assert.ok(weights[K+k]<weights[K+k-1],'falls off away from the centre');
  }
  const ratio=weights=>weights.weights[weights.K+1]/weights.weights[weights.K];
  const near=map.beamWeights(200,250),far=map.beamWeights(1200,250);
  assert.ok(far.K>near.K,'a longer slant range needs a wider kernel');
  assert.ok(ratio(far)>ratio(near),'and a flatter shape around the centre');
  assert.equal(map.beamWeights(1,250,3).K,1,'a sub-cell beam still covers its own cell');
  const fwhm=2*Math.sqrt(2*Math.log(2));
  assert.ok(Math.abs(map.beamSigmaM(10000,3)-10000*(3*Math.PI/180)/fwhm)<1e-9);
  assert.ok(Math.abs(map.beamSigmaM(10000,3)-222.4)<1,'X-band 3 deg at 10 km is ~222 m sigma');
  assert.throws(()=>map.beamWeights(0,250),/Invalid beam kernel/);
});

test('Beam convolution: a point spreads to the beam width, a uniform field is preserved',()=>{
  const n=41,sigma=new Float64Array(n*n).fill(2),valid=new Uint8Array(n*n).fill(1);
  const flat=new Float64Array(n*n).fill(.5);
  const smeared=map.convolveBeam(flat,{n,cross:[1,0],sigma,valid});
  for(const value of smeared)assert.ok(Math.abs(value-.5)<1e-9,'a uniform map stays uniform');
  const point=new Float64Array(n*n).fill(0);point[20*n+20]=1;
  const spread=map.convolveBeam(point,{n,cross:[1,0],sigma,valid});
  const line=[...Array(n).keys()].map(k=>spread[20*n+k]),peak=Math.max(...line);
  assert.equal(line.indexOf(peak),20,'peak stays at the point');
  const above=line.filter(v=>v>=peak/2).length;
  assert.ok(Math.abs(above-2.3548*2)<=1,'FWHM follows the kernel width in cells');
  for(let k=0;k<n;k++)assert.ok(Math.abs(line[k]-line[40-k])<1e-9,'symmetric about the point');
  // Unknown neighbours are dropped instead of read as dark ground, and stay empty themselves.
  const partial=new Uint8Array(n*n).fill(1);partial.fill(0,0,20*n);
  const edge=map.convolveBeam(flat,{n,cross:[0,1],sigma,valid:partial});
  assert.ok(Math.abs(edge[20*n+20]-.5)<1e-9,'no darkening from uncollected neighbours');
  assert.ok(Number.isNaN(edge[10*n+20]),'uncollected cells carry no data instead of a fake value');
});

test('Speckle is multiplicative, exponential per look, and reproducible',()=>{
  const sample=(seed,frame,looks)=>{const out=[];for(let i=0;i<40000;i++)out.push(map.speckleGain([i%200,(i/200)|0],seed,frame,looks));return out;};
  const moments=values=>{const mean=values.reduce((a,b)=>a+b,0)/values.length;return {mean,variance:values.reduce((a,b)=>a+(b-mean)**2,0)/values.length};};
  const one=moments(sample(7,0,1));
  assert.ok(Math.abs(one.mean-1)<.03,`single-look mean stays at 1 (got ${one.mean.toFixed(3)})`);
  assert.ok(Math.abs(one.variance-1)<.12,`single-look variance stays at 1 (got ${one.variance.toFixed(3)})`);
  assert.ok(sample(7,0,1).every(v=>v>=0),'multiplicative gain is never negative');
  const four=moments(sample(7,0,4));
  assert.ok(Math.abs(four.variance-.25)<.05,`four looks quarter the variance (got ${four.variance.toFixed(3)})`);
  assert.equal(map.speckleGain([3,4],7,0,1),map.speckleGain([3,4],7,0,1),'same cell and frame reproduce');
  assert.notEqual(map.speckleGain([3,4],7,0,1),map.speckleGain([3,4],7,1,1),'a new frame draws new speckle');
  assert.notEqual(map.speckleGain([3,4],7,0,1),map.speckleGain([5,4],7,0,1),'neighbouring cells are independent');
});

test('Lattice cache interpolates, refuses to invent data and keeps classes as categories',()=>{
  const cache=map.createCache({cell_m:250});
  cache.setHeight(0,0,100);cache.setHeight(1,0,200);
  assert.equal(cache.sample(0,0).h,100);assert.equal(cache.sample(125,0).h,150);
  assert.equal(cache.sample(125,0).known,1,'two known corners cover the line between them');
  assert.equal(cache.sample(125,125).known,.5,'a missing corner only halves the weight');
  assert.ok(Math.abs(cache.sample(125,125).h-150)<1e-9,'only known corners contribute');
  assert.equal(cache.sample(60000,0).h,null,'no extrapolation outside the collected cells');
  cache.setSurface(0,0,'water');
  assert.equal(cache.sampleSurface(10,10),'water','classes take the nearest lattice point');
  assert.equal(cache.sampleSurface(600,0),null,'uncollected classification stays unknown');
  assert.throws(()=>cache.setSurface(0,0,'lava'),/Invalid map surface class/,'a name outside the 16 classes is refused');
  // The probe's own classes are accepted by the lattice, not just the legacy five.
  for(const name of ['building','construction','town','railway','field','beach','trees','forest','traffic','particle_effect','sea','river','lake'])
    cache.setSurface(3,3,name);
  assert.throws(()=>cache.setHeight(0,0,NaN),/Invalid map height/);
  // A long flight must not grow the lattice without bound.
  const bounded=map.createCache({cell_m:250,limit:1000});
  for(let i=0;i<3000;i++){bounded.setHeight(i,0,100+i);bounded.setSurface(i,0,'land');}
  assert.deepEqual(bounded.counts(),{heights:1000,surfaces:1000});
  assert.ok(bounded.hasHeight(2999,0),'the newest cells are kept');
  assert.ok(!bounded.hasHeight(0,0),'the oldest cells are dropped');
  assert.throws(()=>map.createCache({cell_m:250,limit:10}),/Invalid map lattice limit/);
});

test('The rolling window asks only for the cells that entered it',()=>{
  const cell=250;
  const cache=map.createCache({cell_m:cell});
  const first=lattice.windowRect({center:[0,0],cell_m:cell,cells:121});
  assert.deepEqual([first.ix0,first.iz0,first.nx,first.nz],[-60,-60,121,121]);
  const plan=lattice.planJobs(cache,first,{cell_m:cell,max_cells:50000});
  assert.equal(plan.jobs.length,1,'a 30x30 km sector is one job when the budget allows');
  assert.equal(plan.cells,14641);assert.equal(plan.known,0);assert.equal(plan.fraction,0);
  assert.deepEqual([plan.jobs[0].x0,plan.jobs[0].z0,plan.jobs[0].cols,plan.jobs[0].rows],[-15000,-15000,121,121]);
  for(let ix=-60;ix<=60;ix++)for(let iz=-60;iz<=60;iz++)cache.setHeight(ix,iz,100);
  assert.equal(lattice.planJobs(cache,first,{cell_m:cell}).jobs.length,0,'a collected window asks for nothing');
  assert.equal(lattice.coverage(cache,first).fraction,1);
  const moved={ix0:first.ix0+1,iz0:first.iz0+1,nx:121,nz:121};
  assert.equal(lattice.coverage(cache,moved).known,121*121-121*2+1,'one row plus one column entered');
  const minimal=lattice.planJobs(cache,moved,{cell_m:cell,max_cells:50000});
  assert.equal(minimal.jobs.reduce((sum,job)=>sum+job.cells,0),121*2-1,'only the new band is requested');
  for(const job of minimal.jobs){
    assert.ok(job.ix0>=moved.ix0&&job.ix0+job.cols<=moved.ix0+121&&job.iz0>=moved.iz0&&job.iz0+job.rows<=moved.iz0+121,'jobs stay inside the window');
    assert.equal(job.x0,job.ix0*cell);assert.equal(job.z0,job.iz0*cell);
  }
  const empty=map.createCache({cell_m:cell});
  const split=lattice.planJobs(empty,first,{cell_m:cell,max_cells:4000});
  assert.ok(split.jobs.length>=4,'a big sector is split under the per-job budget');
  const seen=new Set();
  for(const job of split.jobs){
    assert.ok(job.cells<=4000,'per-job budget respected');
    for(let x=job.x0;x<job.x0+job.cols*cell;x+=cell)for(let z=job.z0;z<job.z0+job.rows*cell;z+=cell){
      const key=`${x},${z}`;assert.ok(!seen.has(key),'jobs do not overlap');seen.add(key);
    }
  }
  assert.equal(seen.size,14641,'the plan covers the window exactly once');
  // Near-first ordering: with a sensor east of the window the closest part is requested first.
  const ordered=lattice.planJobs(empty,first,{cell_m:cell,max_cells:4000,sensor:[40000,0,0]}).jobs;
  assert.equal(ordered[0].x0,Math.max(...ordered.map(job=>job.x0)),'the sensor side of the sector is requested first');
});

test('The window is a forward sector: the nose is inside it, the tail is not',()=>{
  const cell=250,heading=Math.PI/2;                                 // flying along +x, the demo flight's heading
  const sector=lattice.windowSector({center:[0,0],heading,azimuth_deg:60,range_m:20000,cell_m:cell});
  assert.equal(sector.nx,161);assert.equal(sector.nz,161,'range/cell = 80 cells of half-width, plus the apex');
  assert.deepEqual(sector.center,[0,0]);
  assert.equal(sector.heading,heading);assert.equal(sector.azimuth_deg,60);assert.equal(sector.range_m,20000);
  // World coordinates, so the assertions below name ground rather than indices.
  const at=(x,z)=>sector.predicate(x/cell,z/cell);
  assert.ok(at(20000,0),'the whole boresight range is inside');
  assert.ok(at(250,0)&&at(500,0),'the first cells in front of the apex are inside');
  assert.ok(at(10000,17000)&&at(10000,-17000),'+-60 deg at mid range is inside (tan60 x 10000 = 17320)');
  assert.ok(!at(10000,18000)&&!at(10000,-18000),'just outside the wedge is not');
  assert.ok(!at(-1000,0)&&!at(-20000,0),'nothing behind the aircraft — the map never looks backwards');
  assert.ok(at(15000,10000),'the wedge opens up with range: 33.7 deg off the nose at 15 km is inside');
  assert.ok(!at(0,20000)&&!at(0,-20000),'a beam right/left of the track is outside a real beam map');
  assert.ok(!at(21000,0),'beyond the ground range');
  assert.ok(!at(14900,14900),'the radius cuts the wedge: 21070 m > 20 km');
  // The wedge follows the heading: the same ground is inside or outside depending on where the nose points.
  assert.ok(!lattice.windowSector({center:[0,0],heading:-Math.PI/2,azimuth_deg:60,range_m:20000,cell_m:cell}).predicate(80,0),
    'with the nose pointing at -x the ground ahead of the old heading is behind the aircraft');
  // Coverage is measured over the wedge, not over the square that holds it.
  const cache=map.createCache({cell_m:cell});
  const empty=lattice.coverage(cache,sector);
  const ideal=(120/360)*Math.PI*20000*20000/(cell*cell);
  assert.ok(Math.abs(empty.cells-ideal)<ideal*.02,`the wedge holds about ${Math.round(ideal)} cells (got ${empty.cells})`);
  assert.ok(empty.cells<0.3*161*161,'far fewer cells than the circumscribing square');
  assert.equal(empty.known,0);assert.equal(empty.fraction,0);
  for(let iz=sector.iz0;iz<sector.iz0+sector.nz;iz++)for(let ix=sector.ix0;ix<sector.ix0+sector.nx;ix++)
    if(sector.predicate(ix,iz))cache.setHeight(ix,iz,100);
  assert.equal(lattice.coverage(cache,sector).fraction,1,'a collected wedge reads as fully covered');
  assert.ok(lattice.coverage(cache,lattice.windowRect({center:sector.center,cell_m:cell,cells:161})).fraction<0.3,
    'the same cells cover only a quarter of the square the old window asked for');
});

test('The sector grid is capped at the frame budget and says what to change',()=>{
  assert.equal(lattice.sectorGrid({range_m:20000,cell_m:250}),161);
  assert.equal(lattice.sectorGrid({range_m:30000,cell_m:250}),241,'30 km at 250 m still fits the 257-cell frame');
  assert.equal(lattice.sectorGrid({range_m:5000,cell_m:250}),41);
  assert.throws(()=>lattice.sectorGrid({range_m:30000,cell_m:100}),/exceeds the 257-cell frame limit: use a coarser cell or a shorter range/);
  assert.throws(()=>lattice.windowSector({center:[0,0],heading:0,azimuth_deg:60,range_m:30000,cell_m:150}),/exceeds/);
  assert.throws(()=>lattice.windowSector({center:[0,0],heading:0,azimuth_deg:0,range_m:20000,cell_m:250}),/Invalid map sector azimuth/);
  assert.throws(()=>lattice.windowSector({center:[0,0],heading:0,azimuth_deg:200,range_m:20000,cell_m:250}),/Invalid map sector azimuth/);
  assert.throws(()=>lattice.windowSector({center:[0,0],heading:NaN,azimuth_deg:60,range_m:20000,cell_m:250}),/Invalid map sector heading/);
  assert.throws(()=>lattice.windowSector({center:[0,0],heading:0,azimuth_deg:60,range_m:0,cell_m:250}),/Invalid map sector range/);
  // The angular fold is the project's heading - bearing convention, positive to the right, folded into
  // (-180,180]: exactly half a turn is reported as +180, so the two edges read the same either way.
  assert.equal(map.relativeAngleDeg(Math.PI/2,0),90);assert.equal(map.relativeAngleDeg(Math.PI/2,Math.PI),-90);
  assert.equal(map.relativeAngleDeg(0,-Math.PI),180);assert.equal(map.relativeAngleDeg(Math.PI/4,Math.PI/4),0);
  assert.ok(Math.abs(map.relativeAngleDeg(0,Math.PI*3)-180)<1e-9,'more than a full turn folds back into +-180');
  assert.ok(Math.abs(map.relativeAngleDeg(-Math.PI*2,0))<1e-9,'a whole turn the other way cancels out');
});

test('Collection inside a sector asks for the wedge only, nearest first',()=>{
  const cell=250,sector=lattice.windowSector({center:[0,0],heading:Math.PI/2,azimuth_deg:60,range_m:8000,cell_m:cell});
  const cache=map.createCache({cell_m:cell});
  const plan=lattice.planJobs(cache,sector,{cell_m:cell,max_cells:4000,sensor:[0,0,0]});
  const cells=plan.jobs.reduce((sum,job)=>sum+job.cells,0);
  assert.equal(cells,plan.cells,'the plan asks for every missing cell of the wedge exactly once');
  assert.ok(Math.abs(plan.cells-(120/360)*Math.PI*8000*8000/(cell*cell))<40,`the wedge is ~268 cells (got ${plan.cells})`);
  // No job may reach outside the wedge: a cell outside it is ground the beam never looks at.
  for(const job of plan.jobs){
    for(let ix=job.ix0;ix<job.ix0+job.cols;ix++)for(let iz=job.iz0;iz<job.iz0+job.rows;iz++)
      assert.ok(sector.predicate(ix,iz),`job cell ${ix},${iz} is inside the wedge (${job.x0},${job.z0} ${job.cols}x${job.rows})`);
    assert.ok(job.cells<=4000,'the per-job budget still holds');
    assert.ok(job.cols<=200&&job.rows<=200,'a job stays under the Export row/column cap');
  }
  // A tall sliver of the wedge is split by rows as well: the Export refuses a 200+ row job silently.
  const tall=lattice.windowSector({center:[0,0],heading:Math.PI/2,azimuth_deg:60,range_m:30000,cell_m:250});
  const tallPlan=lattice.planJobs(map.createCache({cell_m:250}),tall,{cell_m:250,max_cells:4000,sensor:[0,0,0],max_dim:200});
  assert.ok(tallPlan.jobs.every(job=>job.cols<=200&&job.rows<=200),'every job of a 241-cell frame respects the cap');
  assert.equal(tallPlan.jobs.reduce((sum,job)=>sum+job.cells,0),tallPlan.cells,'and still covers the wedge exactly once');
  // Filling the wedge leaves nothing to ask for, while the corners of the square stay unasked.
  for(let iz=sector.iz0;iz<sector.iz0+sector.nz;iz++)for(let ix=sector.ix0;ix<sector.ix0+sector.nx;ix++)
    if(sector.predicate(ix,iz))cache.setHeight(ix,iz,100);
  const done=lattice.planJobs(cache,sector,{cell_m:cell,max_cells:4000});
  assert.equal(done.jobs.length,0);assert.equal(done.fraction,1);
});

test('Render mask: outside the sector is no data, inside is untouched',()=>{
  const cell=250,n=161,heading=Math.PI/2,azimuth=60,range=20000;
  const sector=lattice.windowSector({center:[0,0],heading,azimuth_deg:azimuth,range_m:range,cell_m:cell});
  // Only the wedge was ever collected — which is exactly what the service's lattice holds — so the
  // unmasked render is dark outside it and the masked one must agree with it cell for cell inside.
  const cache=map.createCache({cell_m:cell});
  for(let ix=-120;ix<=120;ix++)for(let iz=-120;iz<=120;iz++){
    if(!sector.predicate(ix,iz))continue;
    cache.setHeight(ix,iz,100+(ix%2)*10);cache.setSurface(ix,iz,'land');
  }
  const request={center:[0,0],sensor:[-300,3000,0],cells:n,cell_m:cell,frame:7};
  const full=map.renderFrame(cache,request);
  const masked=map.renderFrame(cache,{...request,sector:{heading,azimuth_deg:azimuth,range_m:range}});
  const half=(n-1)/2;
  const mask=map.sectorMask({center:[0,0],heading,azimuth_deg:azimuth,range_m:range});
  let inside=0,outside=0,nanInside=0,nanOutside=0;
  for(let row=0;row<n;row++)for(let col=0;col<n;col++){
    const index=row*n+col,x=(col-half)*cell,z=(row-half)*cell;
    if(mask(x,z)){
      inside++;
      if(Number.isNaN(masked.db[index]))nanInside++;
      assert.equal(masked.db[index],full.db[index],`in-sector dB is untouched at ${x},${z}`);
      assert.equal(masked.power[index],full.power[index],`in-sector power is untouched at ${x},${z}`);
    }else{
      outside++;
      if(Number.isNaN(masked.db[index]))nanOutside++;
      assert.ok(full.db[index]>=-40&&Number.isFinite(full.db[index]),'the unmasked render still floors unknown ground to -40 dB');
    }
  }
  assert.equal(nanInside,0);assert.equal(nanOutside,outside,'every cell outside the wedge is marked as no data');
  assert.equal(inside+outside,n*n);
  assert.equal(masked.metadata.sector.cells,inside);assert.equal(masked.metadata.sector.outside_cells,outside);
  assert.deepEqual([masked.metadata.sector.heading_deg,masked.metadata.sector.azimuth_deg,masked.metadata.sector.range_m],[90,azimuth,range]);
  assert.equal(masked.metadata.coverage.cells,inside,'coverage counts the wedge');
  assert.equal(masked.metadata.coverage.fraction,1);
  assert.equal(full.metadata.coverage.cells,n*n,'without a sector the whole square is the frame, as before');
  assert.equal(masked.metadata.blank_cells,0,'a masked cell is not counted as a blank (unknown DEM) cell');
  assert.equal(masked.metadata.sector.outside_cells,masked.metadata.sector.outside_cells|0);
  assert.match(masked.metadata.limitation,/outside the framed sector/);
  // The quantised mosaic matrix: outside the wedge is the -128 sentinel, inside never is.
  const quantised=Int8Array.from(masked.db,v=>Number.isFinite(v)?Math.max(-127,Math.min(48,Math.round(v*4))):-128);
  assert.equal([...quantised].filter(v=>v===-128).length,outside);
  assert.ok([...quantised].every(v=>v===-128||v>=-127),'-128 is only ever the sentinel');
  assert.throws(()=>map.renderFrame(cache,{...request,sector:{heading:NaN,azimuth_deg:60,range_m:range}}),/Invalid map sector heading/);
  assert.throws(()=>map.renderFrame(cache,{...request,sector:{heading:0,azimuth_deg:60,range_m:-1}}),/Invalid map sector range/);
  // A sector that is much wider than the frame's corners is legal but never changes the corners: the
  // mask is the wedge, not the frame.
  const wide=map.renderFrame(cache,{...request,sector:{heading,azimuth_deg:180,range_m:range}});
  assert.ok(wide.metadata.sector.outside_cells>0,'the corners are still outside the radius');
  assert.ok(wide.metadata.sector.outside_cells<outside,'a 180 deg wedge masks far less than a 60 deg one');
});

test('DBS: the cone angle and the sharpening factor are the shader port, monotone in the squint',()=>{
  const sensor=[-10000,3000,0],velocity=[250,0];                        // flying along +x, frame 10 km ahead
  const cone=(x,z,vel=velocity)=>map.dopConeRad({velocity:vel,sensor,x,z,beam_deg:3});
  assert.ok(cone(0,0)<1e-3,'a cell on the velocity vector itself has no Doppler cone');
  assert.ok(Math.abs(cone(-10000,20000)-Math.PI)<1e-4,
    `straight abeam of the aircraft is the widest cone the shader allows (${(cone(-10000,20000)*180/Math.PI).toFixed(1)} deg)`);
  assert.ok(Math.abs(cone(-30000,0)-Math.PI)<1e-4,'and a cell straight behind is clamped to it (ED saturates the cosine)');
  assert.ok(cone(0,20000)<Math.PI&&cone(0,20000)>Math.PI/2,'a cell 63 deg off the nose sits between the two');
  assert.equal(map.dopConeRad({velocity:[0,0],sensor,x:0,z:0,beam_deg:3}),0,'a stationary platform has no gradient at all');
  assert.equal(map.dopConeRad({velocity:[250,0],sensor:[0,0,0],x:0,z:0,beam_deg:3}),0,'a cell under the aircraft has no direction to measure');
  // lambda = 0.03 m and the scan term omega/teta of radar.fx:146-148 never enter a value here: omega is 0.
  assert.equal(map.dopConeRad({velocity:[250,0],sensor,x:0,z:20000,beam_deg:3}),map.dopConeRad({velocity:[250,0],sensor,x:0,z:20000,beam_deg:30}),
    'the beam width only scales ED\'s scan term, which is zero without a scan');
  // Factor: exactly 1 at the nose, the requested factor from 45 deg of squint on, monotone and continuous.
  assert.equal(map.dopSharpenFactor(8,0),1);
  assert.equal(map.dopSharpenFactor(8,Math.PI/4),4,'half the cone, half the sharpening');
  assert.equal(map.dopSharpenFactor(8,Math.PI/2),8,'45 deg of squint reaches the full factor');
  assert.equal(map.dopSharpenFactor(8,Math.PI),8,'and it stays there out to the widest cone');
  assert.equal(map.dopSharpenFactor(32,Math.PI/2),32);
  assert.equal(map.dopSharpenFactor(32,Math.PI/8),8,'DBS2 sharpens twice as fast on the way up to its own factor');
  let previous=1;
  for(let coneAngle=0;coneAngle<=Math.PI+1e-9;coneAngle+=Math.PI/90){
    const factor=map.dopSharpenFactor(32,coneAngle);
    assert.ok(factor>=previous-1e-12,`the factor never falls back (cone ${(coneAngle*180/Math.PI).toFixed(1)} deg)`);
    assert.ok(factor<=32);
    previous=factor;
  }
  assert.equal(map.dopSharpenFactor(8,NaN),1,'a cone that cannot be computed sharpens nothing');
});

test('DBS render: forward-looking is the real beam bit for bit, side-looking keeps the energy',()=>{
  const cell=25,n=81;
  // One bright cell on a dark plain: the azimuth response of the frame is then the kernel itself.
  const build=()=>{const cache=map.createCache({cell_m:cell});
    for(let ix=-60;ix<=60;ix++)for(let iz=-60;iz<=60;iz++){
      cache.setHeight(ix,iz,100);
      cache.setSurface(ix,iz,(ix===0&&iz===0)?'land':'water');
    }
    return cache;};
  const request={center:[0,0],sensor:[-12000,3000,0],cells:n,cell_m:cell,frame:5};
  const rbm=map.renderFrame(build(),request);
  const line=result=>{const half=(n-1)/2;return Array.from({length:n},(_,k)=>result.power[Math.round(half)*n+k]);};
  const spread=values=>{const peak=Math.max(...values);return values.filter(value=>value>=peak*.1).length;};
  // Velocity along the line of sight: cone 0 everywhere in this block, so every cell keeps the real beam
  // and the frame has to come out bit for bit like the same frame rendered without any DBS option.
  const forward=map.renderFrame(build(),{...request,dbs:{factor:8},sensorVel:[250,0]});
  assert.deepEqual(forward.db,rbm.db,'near-forward DBS has to be the real beam, not a hollowed-out frame');
  assert.deepEqual(forward.power,rbm.power);
  const forwardMeta=forward.metadata.dbs;
  assert.deepEqual([forwardMeta.sharpen_min,forwardMeta.sharpen_max],[1,1]);
  assert.equal(forwardMeta.effective,'real-beam');
  assert.equal(forwardMeta.degraded,'forward_looking');
  assert.equal(forwardMeta.forward_cells,forwardMeta.cells,'every cell of the block is in the degenerate cone');
  assert.ok(forwardMeta.los_angle_deg_max<6,`the block spans a few degrees of squint (${forwardMeta.los_angle_deg_max})`);
  // A velocity that cannot sharpen anything degrades just as quietly: unknown, stationary or no DBS option.
  assert.deepEqual(map.renderFrame(build(),{...request,dbs:{factor:8},sensorVel:null}).db,rbm.db);
  assert.deepEqual(map.renderFrame(build(),{...request,dbs:{factor:8},sensorVel:[0,0]}).db,rbm.db);
  assert.deepEqual(map.renderFrame(build(),{...request,sensorVel:[0,250]}).db,rbm.db,'a velocity without dbs changes nothing');
  const degraded=map.renderFrame(build(),{...request,dbs:{factor:8},sensorVel:null}).metadata.dbs;
  assert.equal(degraded.degraded,'no_velocity');assert.equal(degraded.effective,'real-beam');
  assert.match(degraded.note,/退化为实波束/);
  assert.equal(degraded.sharpen_min,null,'nothing was sharpened, so there is no factor to report');
  // Abeam: the beam is cut by the full factor and the same energy stays in far fewer cells.
  const side=map.renderFrame(build(),{...request,dbs:{factor:8},sensorVel:[0,250]});
  const sideMeta=side.metadata.dbs;
  assert.deepEqual([sideMeta.sharpen_min,sideMeta.sharpen_max],[8,8]);
  assert.equal(sideMeta.effective,'sharpened');assert.equal(sideMeta.forward_cells,0);
  assert.ok(Math.abs(sideMeta.los_angle_deg_min-84.8)<1,'abeam is a LOS within a few degrees of 90 deg of the velocity');
  assert.ok(spread(line(side))<spread(line(rbm))/4,`the sharpened response is far narrower (${spread(line(side))} vs ${spread(line(rbm))} cells)`);
  assert.ok(Math.max(...line(side))>Math.max(...line(rbm))*4,'and its peak is higher, because the energy is not spread out');
  // Between the two: 22.5 deg of squint gives about half the factor, so the frame is neither the real beam
  // nor fully sharpened — and the factor varies across the block, because each cell has its own geometry.
  const mid=map.renderFrame(build(),{...request,dbs:{factor:8},sensorVel:[231,95.7]});
  const midMeta=mid.metadata.dbs;
  assert.ok(midMeta.sharpen_min>1.5&&midMeta.sharpen_max<6,`half a cone is half a factor (${midMeta.sharpen_min}-${midMeta.sharpen_max})`);
  assert.ok(midMeta.sharpen_min<midMeta.sharpen_max,'the sharpening follows each cell own line of sight');
  assert.ok(spread(line(mid))>spread(line(side)),'a partly sharpened frame is wider than a fully sharpened one');
  assert.ok(spread(line(mid))<spread(line(rbm)),'and narrower than the real beam');
  assert.ok(Math.max(...line(mid))<Math.max(...line(side)),'with a lower peak');
  // Metadata and anchor: the product says what it is, and the mosaic anchor knows it is a DBS tile.
  assert.equal(side.metadata.mode,'dbs');assert.equal(side.metadata.quality,'dbs');assert.equal(side.metadata.focuser,'doppler');
  assert.equal(side.metadata.engine,'map-v1','the engine is the same one, only the azimuth response differs');
  assert.deepEqual(side.metadata.dbs.velocity,[0,250]);
  assert.equal(side.metadata.dbs.resolution_cells,16,'resolution = 2 * factor, the constant that pins 45 deg');
  assert.equal(side.metadata.dbs.port.includes('radar.fx'),true,'the port names its source');
  assert.match(side.metadata.model,/Doppler/);
  assert.match(side.metadata.limitation,/near the nose/);
  assert.equal(map.anchor(side).footprint,'dbs');
  assert.equal(map.anchor(rbm).footprint,'map');
  assert.throws(()=>map.renderFrame(build(),{...request,dbs:{factor:0}}),/Invalid map dbs factor/);
  assert.throws(()=>map.renderFrame(build(),{...request,dbs:{factor:'8'}}),/Invalid map dbs factor/);
  assert.throws(()=>map.renderFrame(build(),{...request,sensorVel:[1]}),/Invalid map sensor velocity/);
  assert.throws(()=>map.renderFrame(build(),{...request,sensorVel:['a',0]}),/Invalid map sensor velocity/);
});

test('DBS on the patrol: the base map stays a MAP product but carries its sharpening',()=>{
  // The reference radar's MAP mode is a doppler-sharpened picture, so the patrol requests the same kernel
  // with `patrol:true`. It has to stay a MAP product on the outside — the page keys the base map off
  // mode/quality/focuser — while metadata.dbs says exactly how much sharpening the geometry delivered.
  const cell=25,n=81;
  const build=()=>{const cache=map.createCache({cell_m:cell});
    for(let ix=-60;ix<=60;ix++)for(let iz=-60;iz<=60;iz++){
      cache.setHeight(ix,iz,100);
      cache.setSurface(ix,iz,(ix===0&&iz===0)?'land':'water');
    }
    return cache;};
  const request={center:[0,0],sensor:[-12000,3000,0],cells:n,cell_m:cell,frame:0};
  const line=result=>{const half=(n-1)/2;return Array.from({length:n},(_,k)=>result.power[Math.round(half)*n+k]);};
  const spread=values=>{const peak=Math.max(...values);return values.filter(value=>value>=peak*.1).length;};
  const rbm=map.renderFrame(build(),request);
  const patrol=map.renderFrame(build(),{...request,dbs:{factor:8,patrol:true},sensorVel:[0,250]});
  assert.deepEqual([patrol.metadata.mode,patrol.metadata.quality,patrol.metadata.focuser],['map','map','real-beam']);
  assert.equal(map.anchor(patrol).footprint,'map');
  assert.equal(patrol.metadata.engine,'map-v1');
  assert.equal(patrol.metadata.dbs.patrol,true);
  assert.equal(patrol.metadata.dbs.factor,8);
  assert.equal(patrol.metadata.dbs.effective,'sharpened');
  assert.equal(patrol.metadata.dbs.degraded,'none');
  assert.equal(patrol.metadata.dbs.velocity[0],0);
  assert.match(patrol.metadata.model,/factor 8:1/);
  assert.match(patrol.metadata.limitation,/far-field|far field/);
  assert.ok(spread(line(patrol))<spread(line(rbm)),'the patrol frame really was sharpened, not just labelled');
  // No velocity: no Doppler gradient, so the patrol falls back to the physical beam — and still as a MAP
  // product, with the reason in the metadata instead of a silently sharper-looking frame.
  const degraded=map.renderFrame(build(),{...request,dbs:{factor:8,patrol:true},sensorVel:null});
  assert.deepEqual(degraded.db,rbm.db);
  assert.deepEqual([degraded.metadata.mode,degraded.metadata.quality,degraded.metadata.focuser],['map','map','real-beam']);
  assert.equal(degraded.metadata.dbs.degraded,'no_velocity');
  assert.equal(degraded.metadata.dbs.effective,'real-beam');
  assert.match(degraded.metadata.dbs.note,/退化为实波束/);
  // A designated block keeps reporting itself as a DBS product; only the patrol case is hidden behind 'map'.
  assert.equal(map.renderFrame(build(),{...request,dbs:{factor:8},sensorVel:[0,250]}).metadata.mode,'dbs');
  assert.equal(map.renderFrame(build(),{...request,dbs:{factor:8},sensorVel:[0,250]}).metadata.dbs.patrol,false);
  assert.throws(()=>map.renderFrame(build(),{...request,dbs:{factor:8,patrol:'yes'}}),/Invalid map dbs patrol/);
});

test('Render: layover folds a radar-facing slope onto the plain in front of it',()=>{
  // Geometry chosen so the fold reaches past one 250 m cell: a face stepping 400/900/1000 m over
  // three lattice points, seen from ~2 km out, folds its upper steps onto the water plain in
  // front of it (g = sqrt(R^2 - H^2) < u for every point above the datum, and the face is steeper
  // than the grazing angle, so the upper steps win the nearer cells by nearest slant range).
  const step=250,cache=map.createCache({cell_m:step});
  const heightAt=x=>x<2000?100:x<2250?400:x<2500?900:x<2750?1000:100;
  for(let ix=-10;ix<=22;ix++)for(let iz=-16;iz<=16;iz++){
    const x=ix*step,h=heightAt(x);
    cache.setHeight(ix,iz,h);
    cache.setSurface(ix,iz,h>100?'land':'water');
  }
  const request={center:[1500,0],sensor:[-500,3000,0],cells:33,cell_m:step,frame:0};
  const result=map.renderFrame(cache,request);
  const n=result.width,half=(n-1)/2;
  const cell=x=>result.power[Math.round(half)*n+Math.round(half+(x-1500)/step)];
  assert.equal(result.metadata.layover,true,'layover is on by default and reported');
  assert.ok(result.metadata.layover_cells>=2,`the fold re-sources the plain cells before the face (got ${result.metadata.layover_cells})`);
  assert.ok(cell(1500)>cell(500)*5&&cell(1750)>cell(500)*5,
    `folded water cells read land-bright (${cell(500).toExponential(1)} vs ${cell(1500).toExponential(1)}/${cell(1750).toExponential(1)})`);
  assert.ok(result.metadata.shadowed_cells>100,`the ridge still casts its shadow behind it (got ${result.metadata.shadowed_cells})`);
  for(let x=2750;x<=3750;x+=step)assert.ok(result.db[Math.round(half)*n+Math.round(half+(x-1500)/step)]<=-39,
    `the shadow cell at x=${x} stays black`);
  assert.ok(cell(500)>1e-4,'the lit plain stays bright next to the fold');
  const off=map.renderFrame(cache,{...request,layover:false});
  const offCell=x=>off.power[Math.round(half)*n+Math.round(half+(x-1500)/step)];
  assert.equal(off.metadata.layover,false,'layover:false is reported');
  assert.ok(offCell(1500)<=offCell(500)*3&&offCell(1750)<=offCell(500)*3,
    'with layover off the same cells read as dark water again');
  assert.throws(()=>map.renderFrame(cache,{...request,layover:'yes'}),/Invalid map options/);
  assert.throws(()=>map.renderFrame(cache,{...request,layover_margin_cells:99}),/Invalid map layover margin/);
  // Flat ground cannot move a source: both switches render bit-identical there.
  const flat=map.createCache({cell_m:step});
  for(let ix=-16;ix<=16;ix++)for(let iz=-16;iz<=16;iz++){flat.setHeight(ix,iz,100);flat.setSurface(ix,iz,'land');}
  const flatRequest={center:[0,0],sensor:[-12000,3000,0],cells:33,cell_m:step,frame:0};
  assert.deepEqual(map.renderFrame(flat,{...flatRequest,layover:false}).db,
    map.renderFrame(flat,{...flatRequest,layover:true}).db,'flat ground renders identically with the fold on or off');
});

test('Render: shadow, materials, no-data cells and STC',()=>{
  const {cache,step}=ridgeTerrain();
  const center=[8000,0],sensor=[-15000,3000,0];
  const result=map.renderFrame(cache,{center,sensor,cells:121,cell_m:step,frame:0});
  const n=result.width,half=(n-1)/2;
  const at=(x,z)=>result.db[Math.round(half+z/step)*n+Math.round(half+(x-8000)/step)];
  const mean=(x0,x1)=>{let sum=0,count=0;for(let x=x0;x<=x1;x+=step)for(let z=-10000;z<=10000;z+=step){sum+=10**(at(x,z)/10);count++;}return 10*Math.log10(sum/count);};
  assert.ok(mean(6000,11000)<mean(0,3500)-10,`the ridge shadow is far darker than the lit plain (${mean(6000,11000).toFixed(1)} dB)`);
  assert.ok(result.metadata.shadowed_cells>2000,'the shadow band is reported');
  assert.ok(result.metadata.material_counts.water>0&&result.metadata.material_counts.land>0);
  assert.ok(at(-4000,0)<at(-1000,0)-8,'water reads darker than land at the same range');
  // dB has a fixed reference now, so it is not capped at 0: 0 dB is land at normal incidence with mean
  // speckle, and a single look can push a cell a few dB above it. The floor is still -40 and anything a
  // cell can physically carry stays well under +12.
  assert.ok(result.db.every(v=>Number.isFinite(v)&&v>=-40&&v<=12),'dB follows the project convention (fixed reference, -40 floor)');
  assert.ok(result.db.some(v=>v>0),'a bright cell may sit above the 0 dB reference');
  assert.ok(result.power.every(v=>Number.isFinite(v)&&v>=0));
  assert.equal(result.metadata.mode,'map');assert.equal(result.metadata.quality,'map');assert.equal(result.metadata.focuser,'real-beam');
  assert.equal(result.metadata.image_step_m,step);assert.equal(result.size_m,30000);
  const partial=map.createCache({cell_m:step});
  for(let ix=-30;ix<=30;ix++)for(let iz=-30;iz<=30;iz++)partial.setHeight(ix,iz,100);
  const sparse=map.renderFrame(partial,{center:[0,0],sensor:[0,3000,-15000],cells:121,cell_m:step,frame:0});
  assert.ok(sparse.metadata.coverage.fraction>.2&&sparse.metadata.coverage.fraction<.3,`about a quarter is collected (${sparse.metadata.coverage.fraction})`);
  assert.ok(sparse.power.some(v=>v===0),'uncollected cells stay empty');
  assert.ok(sparse.metadata.blank_cells>9000,'blank cells are reported');
  assert.ok(sparse.power.filter(v=>v===0).length>=sparse.metadata.blank_cells,'every blank cell is dark');
  const raw=map.renderFrame(cache,{center,sensor,stc:false,cells:121,cell_m:step,frame:0});
  const rawAt=(x,z)=>raw.db[Math.round(half+z/step)*n+Math.round(half+(x-8000)/step)];
  assert.ok(at(20000,0)>rawAt(20000,0)+3,'STC lifts the far range (a display choice, not radiometry)');
  assert.ok(raw.metadata.radiometry!==result.metadata.radiometry);
});

test('Speckle: four looks average the grain out, a single look does not',()=>{
  // The patrol renders with looks 4. This is the engine-side evidence that the switch does what the
  // service claims: the mean brightness is unchanged (multi-look averages independent exponential draws),
  // the coefficient of variation drops by about the square root of the look count.
  const step=250,cache=map.createCache({cell_m:step});
  for(let ix=-120;ix<=120;ix++)for(let iz=-120;iz<=120;iz++){cache.setHeight(ix,iz,100);cache.setSurface(ix,iz,'land');}
  const stats=looks=>{
    const result=map.renderFrame(cache,{center:[0,0],sensor:[0,3000,0],cells:61,cell_m:step,frame:0,looks});
    const n=61,half=30,values=[];
    // One range band only: the incidence cosine changes with range, and that variation is geometry, not grain.
    for(let x=2000;x<=6000;x+=step)for(let z=-500;z<=500;z+=step)values.push(result.power[Math.round(half+z/step)*n+Math.round(half+x/step)]);
    const mean=values.reduce((sum,value)=>sum+value,0)/values.length;
    return {mean,cv:Math.sqrt(values.reduce((sum,value)=>sum+(value-mean)**2,0)/values.length)/mean};
  };
  const one=stats(1),four=stats(4);
  assert.ok(Math.abs(one.mean-four.mean)/one.mean<.05,`the mean brightness survives (${one.mean.toFixed(3)} vs ${four.mean.toFixed(3)})`);
  assert.ok(one.cv>1.5*four.cv,`four looks cut the grain (cv ${four.cv.toFixed(2)} vs ${one.cv.toFixed(2)})`);
  assert.ok(Math.abs(four.cv-.5)<.1,'and land on the 1/sqrt(looks) figure of an exponential speckle');
});

test('Radiometry: the level belongs to the ground, not to the frame own peak',()=>{
  // The rolling mosaic pastes frames of different ground side by side, so a frame whose own brightest cell
  // sets its scale steps up and down against its neighbours. A frame of nothing but far ground makes that
  // visible in one number: on the fixed scale it stays dark, normalised to its own (dim) peak it glows.
  const step=250,far=map.createCache({cell_m:step});
  for(let ix=-120;ix<=120;ix++)for(let iz=-120;iz<=120;iz++){
    if(Math.hypot(ix*step,iz*step)<15000)continue;               // only the outer ring was collected
    far.setHeight(ix,iz,100);far.setSurface(ix,iz,'water');
  }
  const request={center:[0,0],sensor:[0,3000,0],cells:241,cell_m:step,frame:0,looks:8};
  const fixed=map.renderFrame(far,request),pinned=map.renderFrame(far,{...request,peak_norm:true});
  assert.ok(fixed.metadata.coverage.fraction>.5,'the far ring is really what this frame shows');
  assert.ok(Math.max(...fixed.db.filter(Number.isFinite))<-15,
    `a far-only frame stays dark on the fixed scale (${Math.max(...fixed.db.filter(Number.isFinite)).toFixed(1)} dB)`);
  assert.ok(Math.abs(Math.max(...pinned.db.filter(Number.isFinite)))<.5,
    'while peak_norm:true lights the same frame up to its own peak, which is the brightness step between frames');
  // The same ground drawn as two different frames keeps its level: only the speckle realisation changes,
  // and that is what the service pins by rendering the patrol with a fixed frame index.
  const cache=map.createCache({cell_m:step});
  for(let ix=-120;ix<=120;ix++)for(let iz=-120;iz<=120;iz++){cache.setHeight(ix,iz,100);cache.setSurface(ix,iz,'land');}
  const mean=result=>{let sum=0,count=0;for(let d=-6;d<=6;d++)for(let e=-6;e<=6;e++){sum+=10**(result.db[(30+d)*61+(30+e)]/10);count++;}return 10*Math.log10(sum/count);};
  const first=map.renderFrame(cache,{...request,cells:61,frame:0}),later=map.renderFrame(cache,{...request,cells:61,frame:7});
  assert.ok(Math.abs(mean(first)-mean(later))<.5,`the level does not move with the frame index (${mean(first).toFixed(2)} vs ${mean(later).toFixed(2)} dB)`);
});
test('Radiometry: STC fully compensates, so a uniform plain has no range ramp',()=>{
  // A flat plain of one material, seen from directly above — the patrol's own geometry, where the frame
  // centre IS the aircraft. Compensating 1/R^4 means painting that ground evenly; the old
  // power = texture x (slant/H)^4 factor instead made the far rim ~30 dB brighter, which is the range
  // ramp this test exists to catch (the residual few dB below are the incidence cosine, a real surface
  // effect, not radiometry).
  const step=250,cache=map.createCache({cell_m:step});
  for(let ix=-120;ix<=120;ix++)for(let iz=-120;iz<=120;iz++){cache.setHeight(ix,iz,100);cache.setSurface(ix,iz,'land');}
  const result=map.renderFrame(cache,{center:[0,0],sensor:[0,3000,0],cells:121,cell_m:step,frame:0});
  const n=result.width,half=(n-1)/2;
  const at=(x,z)=>result.db[Math.round(half+z/step)*n+Math.round(half+x/step)];
  const mean=(x0,x1)=>{let sum=0,count=0;for(let x=x0;x<=x1;x+=step)for(let z=-3000;z<=3000;z+=step){sum+=10**(at(x,z)/10);count++;}return 10*Math.log10(sum/count);};
  const near=mean(3000,4000),far=mean(13000,14000);
  assert.ok(far<near+1,`the far field must not be brighter than the near field (${far.toFixed(1)} vs ${near.toFixed(1)} dB)`);
  assert.ok(Math.abs(far-near)<6,`a uniform plain stays within a few dB across the frame (${Math.abs(far-near).toFixed(1)} dB)`);
  // The dB scale is fixed, not per frame: 0 dB is the brightest material coefficient at normal incidence
  // with mean speckle. A frame of nothing but dark water therefore reads about -18 dB; normalising it to
  // its own peak would stretch that same water to 0 dB and make every frame its own brightness standard.
  const water=map.createCache({cell_m:step});
  for(let ix=-40;ix<=40;ix++)for(let iz=-40;iz<=40;iz++){water.setHeight(ix,iz,100);water.setSurface(ix,iz,'water');}
  const dark=map.renderFrame(water,{center:[0,0],sensor:[0,3000,0],cells:61,cell_m:step,frame:0,looks:8});
  assert.ok(Math.max(...dark.db)<-8,`an all-water frame stays dark on the fixed scale (peak ${Math.max(...dark.db).toFixed(1)} dB)`);
  // The level itself is the material's own coefficient, not a stretched frame peak. Read the middle of the
  // frame (near-nadir, cosine close to 1) so the incidence falloff of this model does not enter.
  const middle=[];for(let d=-2;d<=2;d++)for(let e=-2;e<=2;e++)middle.push(dark.db[(30+d)*61+(30+e)]);
  const waterLevel=middle.reduce((sum,value)=>sum+value,0)/middle.length;
  assert.ok(Math.abs(waterLevel-10*Math.log10(.015))<2.5,`water sits at its own coefficient, 10*log10(0.015) = -18 dB (${waterLevel.toFixed(1)} dB)`);
  const bright=map.renderFrame(cache,{center:[0,0],sensor:[0,3000,0],cells:61,cell_m:step,frame:0,looks:8});
  assert.ok(Math.abs(bright.db[30*61+30])<2.5,`and land at normal incidence is the 0 dB reference (${bright.db[30*61+30].toFixed(1)} dB)`);
  const stretched=map.renderFrame(water,{center:[0,0],sensor:[0,3000,0],cells:61,cell_m:step,frame:0,looks:8,peak_norm:true});
  assert.ok(Math.abs(Math.max(...stretched.db))<.5,`peak_norm:true brings the per-frame peak back to 0 dB (${Math.max(...stretched.db).toFixed(1)})`);
  assert.match(stretched.metadata.radiometry,/peak/);
  // stc:false is the raw receiver: 1/R^4 spreading relative to the nadir range, so the far field is far
  // darker than the compensated picture and the two radiometry strings say which one is shown.
  const raw=map.renderFrame(cache,{center:[0,0],sensor:[0,3000,0],cells:121,cell_m:step,frame:0,stc:false});
  const rawAt=(x,z)=>raw.db[Math.round(half+z/step)*n+Math.round(half+x/step)];
  assert.ok(rawAt(13000,0)<at(13000,0)-15,`raw 1/R^4 makes the far field much darker (${rawAt(13000,0).toFixed(1)} vs ${at(13000,0).toFixed(1)} dB)`);
  // The two paths differ by exactly the compensated factor: 40*log10(nadir/slant) of that cell, with the
  // nadir slant taken from the aircraft's height above the frame's mean ground.
  const Href=3000-result.metadata.center_height,slantAt=x=>Math.hypot(x,Href);
  assert.ok(Math.abs((rawAt(13000,0)-at(13000,0))-10*Math.log10((Href/slantAt(13000))**4))<1.5,
    'the raw picture is the compensated one times the 1/R^4 ratio to the nadir slant range');
  assert.throws(()=>map.renderFrame(cache,{center:[0,0],sensor:[0,3000,0],peak_norm:'yes'}),/Invalid map peak normalisation/);
});

// --- surface relief (DSM) ---------------------------------------------------------------------
// DCS's DEM is a bare-earth model: buildings and canopies are not in it, so without a class-typical
// height the shadow and layover machinery can never see them. These tests pin the lift table, the fact
// that it is render-only, and the effect the F-15E reference picture shows (bright cluster, dark trailing
// band) at a grazing angle where the geometry can produce it.
const reliefPlain=(cluster={})=>{
  const step=250,cache=map.createCache({cell_m:step});
  for(let ix=-120;ix<=120;ix++)for(let iz=-120;iz<=120;iz++){
    cache.setHeight(ix,iz,100);
    cache.setSurface(ix,iz,cluster(ix,iz));
  }
  return cache;
};
const RELIEF_REQUEST={center:[2000,0],sensor:[-15000,700,0],cells:81,cell_m:250,frame:0};
const reliefAt=result=>{
  const n=result.width,half=(n-1)/2;
  return (x,z)=>result.db[Math.round(half+z/250)*n+Math.round(half+(x-2000)/250)];
};
test('DSM relief: a building cluster shadows the ground behind it and brightens its radar face',()=>{
  // A 5x5 building block centred on (500, 0) on a flat 100 m plain, seen from 15 km at 300 m AGL. The
  // grazing angle is about 1.1 deg, so a 15 m building throws a ~780 m shadow — the F-15E reference
  // picture's "bright cluster with a dark trailing band". The grazing angle is what decides whether the
  // effect exists at all: at the patrol's usual 3 km altitude the same building throws ~50 m, sub-cell,
  // which is the honest reason a single building is invisible there (asserted below).
  const cluster=(ix,iz)=>ix>=0&&ix<=4&&iz>=-2&&iz<=2?'building':'land';
  const request={...RELIEF_REQUEST,sensor:[-15000,300,0]};
  const built=map.renderFrame(reliefPlain(cluster),request);
  const flat=map.renderFrame(reliefPlain(()=>'land'),request);
  const b=reliefAt(built),f=reliefAt(flat);
  // The shadow band lies behind the cluster, i.e. further from the sensor (+x).
  const band=[1250,1500,1750].map(x=>+(b(x,0)-f(x,0)).toFixed(1));
  assert.ok(band.some(delta=>delta<-5),`a dark band trails the cluster (${band.join(', ')} dB)`);
  const sideways=Math.abs(b(0,1500)-f(0,1500));
  assert.ok(sideways<3,`but the plain beside it is unchanged (${sideways.toFixed(1)} dB)`);
  // The radar-facing edge: the normal tilts toward the sensor, and at a grazing look that is a large
  // relative change in the incidence cosine — the bright leading edge of the reference picture.
  assert.ok(b(0,0)>f(0,0)+5,`the leading edge reads brighter (${(b(0,0)-f(0,0)).toFixed(1)} dB)`);
  // The cluster's own lee side falls into the shadow of the taller roofs in front of it (the +-40 % jitter
  // makes a patchwork, exactly as a dense cluster does in the reference picture).
  assert.ok(b(1000,0)<f(1000,0)-3,`the lee edge reads darker (${(b(1000,0)-f(1000,0)).toFixed(1)} dB)`);
  // Deterministic, and the lattice keeps the bare DEM: the lift is a render-only DSM.
  assert.deepEqual(map.renderFrame(reliefPlain(cluster),request).db,built.db,'the same seed reproduces bit for bit');
  assert.equal(reliefPlain(cluster).height(0,0),100,'the cache still holds the bare DEM');
  assert.equal(reliefPlain(cluster).height(4,2),100);
  assert.ok(built.metadata.relief&&built.metadata.relief.cells>0,'the lift is reported');
  // And the honest counterpart: from the patrol's cruising altitude the same cluster makes no shadow cell
  // at all — the relief must not be exaggerated until it shows.
  const high=map.renderFrame(reliefPlain(cluster),{...RELIEF_REQUEST,sensor:[-15000,3000,0]});
  const highFlat=map.renderFrame(reliefPlain(()=>'land'),{...RELIEF_REQUEST,sensor:[-15000,3000,0]});
  assert.equal(high.metadata.shadowed_cells,0,'no shadow from 3 km at 15 km — sub-cell, as documented');
  assert.ok(reliefAt(high)(0,0)>reliefAt(highFlat)(0,0)+5,'the cluster still reads bright from altitude (material + tilt)');
});
test('DSM relief: the table is a per-class assumption with a deterministic jitter',()=>{
  const expects={building:15,construction:10,town:8,trees:12,forest:18};
  for(const [name,base] of Object.entries(expects)){
    const result=map.renderFrame(reliefPlain(()=>name),{...RELIEF_REQUEST,cells:41});
    const relief=result.metadata.relief;
    assert.ok(relief.cells>0,`${name} lifts cells`);
    assert.ok(relief.mean_m>base*.85&&relief.mean_m<base*1.15,`${name} averages about ${base} m (${relief.mean_m.toFixed(1)})`);
    assert.ok(relief.max_m>=base*.6-.01&&relief.max_m<=base*1.4+.01,`${name} jitters inside 0.6-1.4x (${relief.max_m.toFixed(1)})`);
    assert.deepEqual(relief.table[name],base,`the reported table carries ${name}`);
  }
  for(const name of ['land','unknown','sea','water','shallow_water','road','runway','railway','field','beach','traffic','particle_effect','river','lake']){
    const result=map.renderFrame(reliefPlain(()=>name),{...RELIEF_REQUEST,cells:41});
    assert.equal(result.metadata.relief.cells,0,`${name} is flat`);
    assert.equal(result.metadata.relief.mean_m,0,`${name} adds no height`);
  }
});
test('DSM relief: classes without a lift render exactly as before, and the switch turns it off',()=>{
  // The lift is a rendering layer: with no lifted class in the frame (or with relief:false) the numbers
  // have to be the ones the engine produced before the DSM layer existed.
  const plain=reliefPlain(()=>'land');
  const before=map.renderFrame(plain,RELIEF_REQUEST);
  assert.deepEqual(map.renderFrame(plain,{...RELIEF_REQUEST,relief:false}).db,before.db,'land-only frame is unchanged');
  assert.equal(before.metadata.relief.cells,0);
  assert.equal(before.metadata.relief.enabled,true,'the layer is on by default');
  // With the lift off, a building block keeps its material brightness (+9 dB, the double bounce) but casts
  // no shadow and has no bright/dark edges: the geometry part of the effect comes from the lift alone.
  const cluster=(ix,iz)=>ix>=0&&ix<=4&&iz>=-2&&iz<=2?'building':'land';
  const request={...RELIEF_REQUEST,sensor:[-15000,300,0]};
  const off=map.renderFrame(reliefPlain(cluster),{...request,relief:false});
  const offFlat=map.renderFrame(reliefPlain(()=>'land'),{...request,relief:false});
  const on=map.renderFrame(reliefPlain(cluster),request);
  assert.equal(off.metadata.relief.cells,0,'relief:false lifts nothing');
  assert.equal(off.metadata.relief.enabled,false);
  assert.equal(off.metadata.shadowed_cells,0,'no lift, no shadow at this grazing angle');
  assert.notDeepEqual(on.db,off.db,'the lift changes the picture');
  const o=reliefAt(off),oFlat=reliefAt(offFlat);
  assert.ok(o(0,0)>oFlat(0,0)+5,'the building material alone still reads bright');
  assert.ok([1250,1500,1750].every(x=>o(x,0)-oFlat(x,0)>-3),'but there is no dark band without the lift');
  assert.throws(()=>map.renderFrame(plain,{...RELIEF_REQUEST,relief:'yes'}),/Invalid map relief/);
});

test('Render: the beam widens the cross-range response with slant range',()=>{
  const cell=250,n=121;
  const build=()=>{const cache=map.createCache({cell_m:cell});
    for(let ix=-240;ix<=240;ix++)for(let iz=-240;iz<=240;iz++){
      cache.setHeight(ix,iz,100);
      cache.setSurface(ix,iz,(ix===0&&iz===0)?'land':'water');
    }
    return cache;};
  const profile=sensor=>{
    const result=map.renderFrame(build(),{center:[0,0],sensor,cells:n,cell_m:cell,frame:0});
    const half=(n-1)/2,line=[];
    for(let k=-10;k<=10;k++)line.push(result.power[Math.round(half+k)*n+Math.round(half)]);
    const peak=Math.max(...line);
    return {peak,width:line.filter(v=>v>=peak/2).length,skirt:line.filter(v=>v>=peak/10).length};
  };
  const near=profile([-5000,2500,0]),far=profile([-25000,2500,0]);
  assert.equal(near.width,1,'at 5 km a 3 deg beam fits inside one 250 m cell');
  assert.ok(far.width>=4,`at 25 km the same beam covers several cells (got ${far.width})`);
  assert.ok(far.skirt>near.skirt,'the far response has longer skirts');
  assert.ok(far.peak<near.peak,'spreading the same energy lowers the far peak');
});

test('Render: deterministic, and a 30 km sector stays inside the render budget',()=>{
  const {cache,step}=ridgeTerrain();
  const request={center:[8000,0],sensor:[-15000,3000,0],cells:121,cell_m:step,frame:3};
  const first=map.renderFrame(cache,{...request}),second=map.renderFrame(cache,{...request});
  assert.deepEqual(first.db,second.db,'the same frame seed reproduces bit for bit');
  assert.deepEqual(first.power,second.power);
  assert.notDeepEqual(first.db,map.renderFrame(cache,{...request,frame:4}).db,'a new frame draws new speckle');
  const started=performance.now();
  for(let i=0;i<5;i++)map.renderFrame(cache,{...request,frame:10+i});
  const average=(performance.now()-started)/5;
  assert.ok(average<1000,`a 121x121 sector render stays under 1 s (measured ${average.toFixed(0)} ms)`);
  const anchor=map.anchor(first);
  assert.deepEqual(anchor.center,[8000,first.metadata.center_height,0]);
  assert.equal(anchor.bearing,0);assert.equal(anchor.size,30000);assert.equal(anchor.footprint,'map');
  assert.throws(()=>map.anchor({metadata:{}}),/Not a map result/);
  assert.throws(()=>map.renderFrame(cache,{center:[0,0],sensor:[0,3000]}),/Invalid map sensor position/);
  assert.throws(()=>map.renderFrame(cache,{center:[0,0],sensor:[0,3000,0],beam_deg:99}),/Invalid map beam width/);
});

// --- service level ----------------------------------------------------------------------------
// The fake Export answers MAP jobs from a synthetic DEM and drifts its own position, so the rolling
// sector can be observed. Lines go out in small batches: the service treats one oversized chunk as
// a protocol overflow. Only two poses travel per job (one at each end, 12 m apart, which is all a
// heading needs): a job that reported a pose every few cells would drag the aircraft kilometres
// forward and re-anchor the sector under the test's feet.
const DEM=(x,z)=>100+0.004*Math.max(0,x)+8*Math.sin(z/4000);
function mapReply(fake,line){
  const a=line.trim().split(',');
  if(a[0]!=='CAPTURE_MAP'&&a[0]!=='CAPTURE_MAP_AT')return null;
  const id=Number(a[1]),relative=a[0]==='CAPTURE_MAP_AT';
  const origin=relative?[fake.own[0]+Number(a[2]),fake.own[1]+Number(a[3])]:[Number(a[2]),Number(a[3])];
  const cols=Number(a[4]),rows=Number(a[5]),step=Number(a[6]);
  const job={id,relative,origin,cols,rows,step,cells:cols*rows};
  fake.requests.push(job);
  if(fake.failNext){fake.failNext=false;return [`FAIL,${id},terrain_query_failed`];}
  let clock=1000+fake.requests.length;
  const lines=[`MAPBEGIN,${id},${origin[0]},${origin[1]},${cols},${rows},${step}`];
  const poseSeq={value:0};                                  // pose numbering restarts with each job
  // Two poses 12 m apart give the service a heading. They do NOT accumulate: the test moves fake.own
  // itself, so a job of many cells cannot drag the aircraft out of the sector the assertions describe.
  // The velocity they carry (250 m/s along +x, the fake's own drift) is what a DBS block sharpens with.
  const pose=offset=>{clock+=.25;return `MAPPOSE,${id},${poseSeq.value++},${clock},${fake.own[0]+offset},3000,${fake.own[1]},250,0`;};
  lines.push(pose(0));
  for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){
    const x=origin[0]+col*step,z=origin[1]+row*step;
    lines.push(`MAPHEIGHT,${id},${col},${row},${x},${DEM(x,z).toFixed(3)},${z}`);
    // `surfaceMode` answers like an Export with the native 16-class probe (a class union in one '+'-joined
    // field): 'fine' mixes land, a runway union and a building union by quadrant, 'fine-building' makes the
    // whole block a building union and 'legacy-land' keeps every cell bare land — the controlled pair the
    // radiometry comparison needs. The default keeps the legacy five-class word a plain Export sends.
    const surface=fake.surfaceMode==='fine'?(x<0?'Land':z<0?'Land+Runway+Road':'Building+Land')
      :fake.surfaceMode==='fine-building'?'Building+Land'
      :fake.surfaceMode==='legacy-land'?'land'
      :(x>2000?'water':'land');
    lines.push(`MAPSURFACE,${id},${col},${row},${surface}`);
  }
  lines.push(pose(12));
  lines.push(`MAPEND,${id},${cols*rows},${clock}`);
  // `hold` keeps one job in the fake's hand: that is how a test gets a job that is really in flight when
  // the next request arrives. release() then lets it finish.
  if(fake.hold){fake.hold=false;fake.held={id,lines};return null;}
  return lines;
}
async function openExport(t,port,{map:supportsMap=true}={}){
  const fake={client:null,own:[0,0],poseSeq:0,requests:[],hold:false,held:null,log:'',commands:()=>fake.log};
  const client=net.createConnection({host:'127.0.0.1',port});t.after(()=>client.destroy());
  await new Promise((resolve,reject)=>{client.once('connect',resolve);client.once('error',reject);});
  let buffer='',pending=[],writing=false;
  const flush=async()=>{
    if(writing)return;writing=true;
    while(pending.length){
      const batch=pending.splice(0,120);
      if(!client.write(batch.join('')))await new Promise(r=>client.once('drain',r));
    }
    writing=false;
  };
  client.on('data',chunk=>{
    const text=chunk.toString('ascii');fake.log+=text;buffer+=text;
    let index;
    while((index=buffer.indexOf('\n'))>=0){
      const line=buffer.slice(0,index);buffer=buffer.slice(index+1);
      const reply=mapReply(fake,line);
      if(reply){pending.push(...reply.map(text=>text+'\n'));flush();}
    }
  });
  fake.release=()=>{
    if(!fake.held)return false;
    const held=fake.held;fake.held=null;
    pending.push(...held.lines.map(text=>text+'\n'));flush();
    return true;
  };
  client.write(`HELLO,SAR1\nCAPS,2,terrain.GetSurfaceType${supportsMap?',map':''}\nSTATUS,42,terrain.GetHeight,50,51,50,1\n`);
  // A real Export reports status once a second; the service drops a stale link after 3 s, so the
  // fake has to keep it fresh or a slow test would be refused for the wrong reason.
  const keepAlive=setInterval(()=>{if(client.destroyed)clearInterval(keepAlive);else client.write('STATUS,42,terrain.GetHeight,50,51,50,1\n');},500);
  t.after(()=>clearInterval(keepAlive));
  fake.client=client;
  return fake;
}
function sarMessages(scene,id){return [
  `BEGIN,${id},${scene.center[0]},${scene.center[2]},${scene.bearing},${PROTOCOL.sar.default_size_m},${PROTOCOL.sar.default_n}`,
  ...scene.terrain.map((p,i)=>`HEIGHT,${id},${i},${p.join(',')}`),
  ...scene.trajectory.map((p,i)=>`POSE,${id},${i},${p.t},${p.pos.join(',')}`),
  `END,${id},${scene.trajectory.length},${scene.trajectory.at(-1).t}`].join('\n')+'\n';}
const CONTROL={scatterSpacing:4,width:65};
// A forward sector 8 km deep on a 500 m lattice: 33x33 cells of frame, ~268 of them inside the wedge.
const SERVICE_DEFAULTS=sar.map.service_defaults,DBS=sar.map.dbs;
const MAP_REQUEST={range:8000,azimuth:SERVICE_DEFAULTS.azimuth_deg,cell:500};
const MAP_GRID=lattice.sectorGrid({range_m:MAP_REQUEST.range,cell_m:MAP_REQUEST.cell});
const DBS_GRID=2*Math.round(DBS.span_default_m/(2*DBS.cell_m))+1,DBS_SIZE_M=(DBS_GRID-1)*DBS.cell_m;
// Every cell the service asked the Export for, as world coordinates. The wedge is checked from the
// requests themselves, so a plan that quietly asks for the circumscribing square fails here.
function requestedCells(requests){
  const out=[];
  for(const request of requests){
    if(request.relative)continue;
    for(let col=0;col<request.cols;col++)for(let row=0;row<request.rows;row++)
      out.push([request.origin[0]+col*request.step,request.origin[1]+row*request.step]);
  }
  return out;
}

test('Manual /map images one forward sector that coexists with SAR patches',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aesa-sar-map-'));
  const service=createService({tcpPort:0,httpPort:0,recordDir:root,processing:CONTROL});
  t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
  const ports=await service.started,base=`http://127.0.0.1:${ports.httpPort}`;
  const exporter=await openExport(t,ports.tcpPort);
  await until(()=>service.collector.capabilities?.map===true,'map capability');
  const initial=await(await fetch(base+'/state')).json();
  assert.equal(initial.map.active,false);assert.equal(initial.map.supported,true);assert.equal(initial.exportCapabilities.map,true);
  // A first SAR patch teaches the service where the aircraft is; its tile joins the mosaic first.
  assert.equal((await fetch(base+'/capture',{method:'POST',body:'{"side":1,"range":20000}'})).status,202);
  await until(()=>service.collector.job,'sar capture');
  exporter.client.write(sarMessages(demoScene(),service.collector.job.id));
  await until(()=>service.state.result,'sar image');
  const response=await fetch(base+'/map',{method:'POST',body:JSON.stringify(MAP_REQUEST)});
  assert.equal(response.status,202);
  const started=await response.json();
  assert.deepEqual([started.cell_m,started.grid,started.range_m,started.azimuth_deg],[500,MAP_GRID,8000,MAP_REQUEST.azimuth]);
  assert.equal(started.side,undefined,'the sector has no side, so the answer carries none');
  await until(()=>exporter.requests.length>=1,'map request');
  const request=exporter.requests[0];
  assert.equal(request.relative,false,'with a known pose the sector is placed in world coordinates');
  assert.equal(request.step,500);
  assert.ok(request.cols<=MAP_GRID&&request.rows<=MAP_GRID,'no job exceeds the frame');
  // The sector is the aircraft's own forward wedge: its apex is the ownship, the demo flight heads
  // along +x, and the centre is that same position — a real beam map has nowhere else to sit.
  const placed=await(await fetch(base+'/state')).json(),own=placed.ownship.pos,centre=placed.map.window.center;
  const anchorOffset=Math.hypot(centre[0]-own[0],centre[1]-own[2]);
  assert.ok(anchorOffset<=350,`the sector centre is the aircraft position (off by ${anchorOffset.toFixed(0)} m, one lattice rounding)`);
  assert.deepEqual([placed.map.window.cells,placed.map.window.sector.azimuth_deg,placed.map.window.sector.range_m],[MAP_GRID,MAP_REQUEST.azimuth,MAP_REQUEST.range]);
  assert.ok(Math.abs(placed.map.window.sector.heading_deg-90)<1,`the sector follows the heading (${placed.map.window.sector.heading_deg})`);
  await until(()=>service.state.map.lastFrame,'map frame');
  await until(async()=>(await(await fetch(base+'/state')).json()).map.active===false,'a manual shot ends by itself');
  const state=await(await fetch(base+'/state')).json();
  assert.equal(state.map.frames,1,'a manual sector shot draws exactly one frame');
  assert.ok(state.map.coverage>.99);
  // The requested ground is the wedge and nothing else: inside it, inside the range, and nothing behind.
  const mask=map.sectorMask({center:centre,heading:placed.map.window.sector.heading_deg*Math.PI/180,azimuth_deg:MAP_REQUEST.azimuth,range_m:MAP_REQUEST.range});
  const cells=requestedCells(exporter.requests);
  assert.ok(cells.length>=250&&cells.length<=290,`the wedge is about 268 cells (asked ${cells.length})`);
  assert.ok(cells.every(([x,z])=>mask(x,z)),'every requested cell is inside the beam wedge');
  assert.ok(cells.every(([x,z])=>x>=centre[0]-1),'no cell behind the aircraft');
  assert.ok(Math.max(...cells.map(([x])=>x))>centre[0]+7000,`the wedge reaches out to its ${MAP_REQUEST.range/1000} km range`);
  const widest=Math.max(...cells.map(([,z])=>Math.abs(z-centre[1])));
  assert.ok(Math.abs(widest-8000*Math.sin(Math.PI/3))<1000,`and opens to +-60 deg (widest cell ${widest} m, +-60 deg is 6928 m)`);
  assert.equal(new Set(cells.map(cell=>cell.join(','))).size,cells.length,'jobs do not overlap');
  const entries=state.mosaic.entries;
  assert.deepEqual(entries.map(entry=>entry.mode),['sar','map'],'both products share the mosaic channel');
  assert.deepEqual(entries.map(entry=>entry.size_m),[PROTOCOL.sar.default_size_m,16000],'the map tile is the 2x8 km frame that holds the wedge');
  const tile=entries.at(-1);
  assert.equal(tile.seq,state.mosaic.latestSeq);
  assert.equal(tile.width,MAP_GRID);assert.equal(tile.bearing,0);assert.equal(tile.source,'dcs');
  assert.equal(tile.quality,'map');assert.equal(tile.focuser,'real-beam');assert.equal(tile.image_step_m,500);
  assert.equal(tile.grid_layout,'col_x_row_z','the mosaic entry tells the viewer the matrix is col=x,row=z');
  assert.deepEqual([tile.sector.heading_deg,tile.sector.azimuth_deg,tile.sector.range_m],[90,MAP_REQUEST.azimuth,MAP_REQUEST.range],
    'the tile carries the wedge its -128 cells mean, so it stays readable after the aircraft turns');
  const image=await(await fetch(base+`/image/${tile.seq}`)).json();
  assert.equal(image.db.length,MAP_GRID*MAP_GRID);
  assert.ok(image.db.every(v=>Number.isInteger(v)&&v>=-160&&v<=48),'matrix travels quantised (floor -127, sentinel -128, +12 dB headroom above the fixed reference)');
  // Cell for cell: the wedge holds measurements, the rest of the square holds the -128 no-data sentinel
  // that only a non-finite dB can produce.
  const half=(MAP_GRID-1)/2;
  let measured=0,sentinel=0;
  image.db.forEach((value,index)=>{
    const row=Math.floor(index/MAP_GRID),col=index%MAP_GRID;
    const x=centre[0]+(col-half)*500,z=centre[1]+(row-half)*500;
    if(mask(x,z)){assert.notEqual(value,-128,'inside the wedge there is a measurement');measured++;}
    else{assert.equal(value,-128,'outside the wedge the matrix carries the no-data sentinel');sentinel++;}
  });
  assert.ok(measured>=250&&measured<=290,`the frame shows the ~268 cells of the wedge (${measured})`);
  assert.equal(measured+sentinel,MAP_GRID*MAP_GRID);
  assert.deepEqual([tile.sector.cells,tile.sector.outside_cells],[measured,sentinel],'the tile counts its own wedge');
  assert.ok(state.map.cells>=250,'the wedge was stored in the lattice');
  assert.ok(state.map.surfaces>=250,'classification came with the same jobs');
  // A map tile must not stand in for the ground its square covers but its beam never looked at: a SAR
  // sweep started afterwards still offers the tiles inside that square, and prunes none of them (before
  // the sector existed, the map frame's square was taken as coverage and would have pruned them).
  assert.equal((await fetch(base+'/continuous/start',{method:'POST',body:'{"mode":"sweep","side":1,"range":20000,"sweepSize":512}'})).status,202);
  await until(()=>service.state.continuous.sweepPlan?.length,'sweep plan');
  assert.equal(service.state.continuous.sweepPruned,0,'a MAP frame covers no SAR tile');
  const inSquare=service.state.continuous.sweepPlan.filter(candidate=>
    Math.hypot(candidate.center[0]-centre[0],candidate.center[2]-centre[1])<=2*MAP_REQUEST.range*Math.SQRT1_2);
  assert.ok(inSquare.length>0,'tiles inside the map frame are still offered to the sweep');
  assert.equal((await fetch(base+'/continuous/stop',{method:'POST',body:'{}'})).status,200);
});

test('Continuous MAP re-anchors the sector on the move and only collects the new band',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aesa-sar-maproll-'));
  const service=createService({tcpPort:0,httpPort:0,recordDir:root,processing:CONTROL});
  t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
  const ports=await service.started,base=`http://127.0.0.1:${ports.httpPort}`;
  const exporter=await openExport(t,ports.tcpPort);
  await until(()=>service.collector.capabilities?.map===true,'map capability');
  assert.equal((await fetch(base+'/continuous/start',{method:'POST',body:JSON.stringify({mode:'map',cell:500})})).status,202);
  assert.equal(service.state.continuous.mode,'map');
  await until(()=>exporter.requests.length>=1,'first map job');
  const probe=exporter.requests[0];
  assert.equal(probe.relative,true,'without a trajectory the first request locates the ownship');
  assert.equal(probe.cells,4);
  await until(()=>service.state.map.frames>=1,'first frame');
  await until(async()=>(await(await fetch(base+'/state')).json()).map.coverage>0.99,'first sector collected');
  // The sector arrives as disjoint rectangles (the probe already covered its four cells), so the cost
  // of a sector is the sum over the jobs it took, not any single request. 20 km on a 500 m lattice is
  // an 81x81 frame holding ~1675 cells of wedge.
  const windowJobs=exporter.requests.filter(request=>request.relative===false);
  const collected=windowJobs.reduce((sum,request)=>sum+request.cells,0);
  assert.ok(collected>1600&&collected<=1700,`the first sector is collected whole (${collected} of ~1675 wedge cells)`);
  assert.ok(windowJobs.every(request=>request.cols<=81&&request.rows<=81),'no job exceeds the frame');
  const firstState=await(await fetch(base+'/state')).json();
  const firstCentre=firstState.map.window.center.slice();
  exporter.own[0]+=1800;                                  // the aircraft flies on: the sector must re-anchor
  const before=exporter.requests.length;
  // The next thing the service does is refresh the pose (2x2 ownship probe); the re-anchor itself shows
  // up as a world-coordinate job for the ground the new sector added.
  await until(()=>exporter.requests.slice(before).some(request=>request.relative===false),'re-anchored sector job');
  await until(()=>service.state.map.frames>=2,'second frame');
  const rolled=exporter.requests.slice(before).filter(request=>request.relative===false);
  const rolledCells=rolled.reduce((sum,request)=>sum+request.cells,0);
  assert.ok(rolledCells>0&&rolledCells<collected/4,`a re-anchored sector only asks for the ground that entered it (${rolledCells} of ${collected})`);
  const state=await(await fetch(base+'/state')).json();
  // What entered it is the outer rim of the wedge: the aircraft moved 1.8 km, so the ground the new
  // sector sees that the old one did not is the band beyond 20 - 1.8 km along the new centre's range.
  const newCentre=state.map.window.center;
  const rim=requestedCells(rolled).map(([x,z])=>Math.hypot(x-newCentre[0],z-newCentre[1]));
  assert.ok(Math.min(...rim)>16000,`every newly asked cell is on the rim, not in the middle (${Math.min(...rim).toFixed(0)} m)`);
  assert.ok(Math.max(...rim)<=20000+1,'and inside the 20 km range');
  // The sector is centred on the aircraft, so re-anchoring moves the frame with it — forward, on the
  // same heading, and the overlap with the old sector is what was already collected.
  assert.ok(newCentre[0]>firstCentre[0]+1000,`the sector moved with the aircraft (${(newCentre[0]-firstCentre[0]).toFixed(0)} m)`);
  assert.ok(Math.abs(newCentre[1]-firstCentre[1])<600,'a straight run along +x does not shift the sector sideways');
  assert.ok(state.map.coverage>0.7,`the re-anchored sector is mostly ground already collected (${state.map.coverage})`);
  assert.equal(state.map.continuous,true);assert.equal(state.map.active,true);
  assert.deepEqual([state.map.params.cell_m,state.map.params.range_m,state.map.params.azimuth_deg,state.map.params.grid],
    [500,SERVICE_DEFAULTS.range_m,SERVICE_DEFAULTS.azimuth_deg,lattice.sectorGrid({range_m:SERVICE_DEFAULTS.range_m,cell_m:500})]);
  // The patrol renders with the display defaults the clarity pass settled on: four looks (grain, not
  // information, on a 250 m cell) and a doppler-sharpened azimuth response at factor 8 (the reference
  // radar's MAP mode is a DBS picture). Both are reported for the page, and the sharpening state is in
  // the frame note, because a MAP product looks the same whether or not it was sharpened.
  assert.equal(state.map.params.looks,SERVICE_DEFAULTS.looks);
  assert.equal(state.map.params.dbs_factor,SERVICE_DEFAULTS.dbs_factor);
  // The sharpening state has to be readable when the page polls (700 ms), so it is structured on the last
  // frame and the same sentence is repeated in the note that lingers while the sector waits.
  assert.equal(state.map.lastFrame.sharpen.factor,SERVICE_DEFAULTS.dbs_factor);
  assert.equal(state.map.lastFrame.sharpen.patrol,true);
  // The patrol sector points along the nose, so the near-forward cells have no Doppler gradient and the
  // sector edges do: the status must come out 'partly-sharpened'. A 'real-beam' here would mean the
  // velocity never reached the engine, which is exactly the failure this line exists to catch.
  assert.equal(state.map.lastFrame.sharpen.effective,'partly-sharpened');
  assert.ok(state.map.lastFrame.sharpen.forward_cells>0);
  // The lingering note (the one an operator actually reads while the sector waits) repeats it; the collect
  // notes in between do not, so wait for the wait state rather than sampling a random moment.
  await until(()=>service.state.map.note.includes('等待本机前进'),'waiting note');
  assert.match(service.state.map.note,new RegExp(`多普勒锐化 ${SERVICE_DEFAULTS.dbs_factor}:1|退化实波束`),`the note carries the sharpening state: ${service.state.map.note}`);
  const mapTiles=state.mosaic.entries.filter(entry=>entry.mode==='map');
  assert.ok(mapTiles.every(entry=>entry.dbs&&entry.dbs.patrol===true),'the base map tiles say they came from the patrol');
  assert.ok(mapTiles.every(entry=>entry.dbs.factor===SERVICE_DEFAULTS.dbs_factor&&Number.isFinite(entry.dbs.sharpen_max)),'with the sharpening they actually got');
  assert.equal(state.map.window.sector.range_m,SERVICE_DEFAULTS.range_m);assert.equal(state.map.window.sector.azimuth_deg,SERVICE_DEFAULTS.azimuth_deg);
  assert.ok(Math.abs(state.map.window.sector.heading_deg-90)<1,`the sector follows the +x heading (${state.map.window.sector.heading_deg})`);
  assert.ok(state.map.pose.heading_deg!==null,'the map job reports its own pose');
  assert.ok(state.map.track.length>=1);
  assert.ok(state.mosaic.entries.filter(entry=>entry.mode==='map').length>=2);
  assert.ok(state.mosaic.entries.every(entry=>entry.mode==='map'),'no SAR patch was mixed in');
  assert.equal((await fetch(base+'/continuous/stop',{method:'POST',body:'{}'})).status,200);
  const stalled=exporter.requests.length;await delay(700);
  assert.equal(exporter.requests.length,stalled,'stopping ends the map loop');
  const stopped=await(await fetch(base+'/state')).json();
  assert.equal(stopped.map.active,false);assert.equal(stopped.map.continuous,false);
  assert.equal(service.collector.map,null);
});

test('MAP mode requires the new Export, ignores the old square parameters and rejects an invalid sector',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aesa-sar-mapguard-'));
  const service=createService({tcpPort:0,httpPort:0,recordDir:root,processing:CONTROL});
  t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
  const ports=await service.started,base=`http://127.0.0.1:${ports.httpPort}`;
  const exporter=await openExport(t,ports.tcpPort,{map:false});
  await until(()=>service.collector.capabilities,'capabilities');
  assert.equal(service.collector.capabilities.map,false);
  const refused=await fetch(base+'/map',{method:'POST',body:JSON.stringify(MAP_REQUEST)});
  assert.equal(refused.status,409);assert.match((await refused.json()).error,/新版 SAR Export/);
  const refusedDbs=await fetch(base+'/dbs',{method:'POST',body:'{"x":0,"z":12000}'});
  assert.equal(refusedDbs.status,409,'DBS shares the CAPTURE_MAP channel, so it needs the same Export');
  assert.match((await refusedDbs.json()).error,/新版 SAR Export/);
  assert.equal((await(await fetch(base+'/state')).json()).canDbs,false);
  assert.equal(service.collector.map,null);
  exporter.client.write('CAPS,2,terrain.GetSurfaceType,map\n');
  await until(()=>service.collector.capabilities.map===true,'map capability');
  for(const body of [{cell:10},{cell:5000},{range:1000},{range:40000},{azimuth:5},{azimuth:80},{beam:99},{looks:0},{stc:'yes'},{peak_norm:'yes'},{dbs_factor:0},{dbs_factor:33},{dbs_factor:2.5}]){
    const response=await fetch(base+'/map',{method:'POST',body:JSON.stringify({...MAP_REQUEST,...body})});
    assert.equal(response.status,409,`${JSON.stringify(body)} is rejected`);
    assert.match((await response.json()).error,/Invalid map/);
  }
  // A sector grid past the frame budget is refused with what to change, not with a generic error.
  const tooFine=await fetch(base+'/map',{method:'POST',body:JSON.stringify({...MAP_REQUEST,cell:100,range:30000})});
  assert.equal(tooFine.status,409);
  assert.match((await tooFine.json()).error,/exceeds the 257-cell frame limit: use a coarser cell or a shorter range/);
  assert.equal(service.collector.map,null);
  assert.equal((await fetch(base+'/map',{method:'GET'})).status,404);
  // The old square-window parameters are accepted and ignored: the forward sector has no side, no look
  // angle and no span, and a request that names them still images the wedge in front of the aircraft.
  assert.equal((await fetch(base+'/map',{method:'POST',body:JSON.stringify({...MAP_REQUEST,side:-1,angle:80,span:60000,sweepSize:2048,peak_norm:true,dbs_factor:16})})).status,202);
  await until(()=>exporter.requests.length>=1,'map request after ignored parameters');
  const placed=await(await fetch(base+'/state')).json();
  assert.deepEqual([placed.map.window.sector.azimuth_deg,placed.map.window.sector.range_m],[MAP_REQUEST.azimuth,MAP_REQUEST.range]);
  assert.equal(placed.map.window.cells,MAP_GRID);
  assert.ok(placed.map.params.side===undefined&&placed.map.params.span_m===undefined&&placed.map.params.angle_deg===undefined,
    'the summary reports the sector parameters, not the ignored square ones');
  // The display switches travel with the request and are reported back: stc/peak_norm change the dB
  // reference, dbs_factor the azimuth response of the base map (16:1 here instead of the default 8:1).
  assert.equal(placed.map.params.peak_norm,true);
  assert.equal(placed.map.params.dbs_factor,16);
  assert.equal(placed.map.params.looks,4);
  await until(()=>service.state.map.lastFrame,'map frame');
  await until(async()=>(await(await fetch(base+'/state')).json()).map.active===false,'the shot ends by itself');
});

test('A failed manual map job ends the shot and a new request runs it whole',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aesa-sar-mapfail-'));
  const service=createService({tcpPort:0,httpPort:0,recordDir:root,processing:CONTROL});
  t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
  const ports=await service.started,base=`http://127.0.0.1:${ports.httpPort}`;
  const exporter=await openExport(t,ports.tcpPort);
  await until(()=>service.collector.capabilities?.map===true,'map capability');
  exporter.failNext=true;
  assert.equal((await fetch(base+'/map',{method:'POST',body:JSON.stringify(MAP_REQUEST)})).status,202);
  await until(async()=>(await(await fetch(base+'/state')).json()).map.failures>=1,'map failure counted');
  await until(async()=>(await(await fetch(base+'/state')).json()).map.active===false,
    'a failed manual shot closes its session');
  // The 100 ms tick must not re-ask a shot whose session has ended.
  const asked=exporter.requests.length;
  await delay(400);
  assert.equal(exporter.requests.length,asked,'a manual map shot is not retried by the service tick');
  assert.equal(service.collector.map,null);
  // The operator can resend: the new shot starts from a clean session and completes.
  assert.equal((await fetch(base+'/map',{method:'POST',body:JSON.stringify(MAP_REQUEST)})).status,202);
  await until(()=>service.state.map.lastFrame,'frame after the resend');
  const state=await(await fetch(base+'/state')).json();
  assert.equal(state.map.active,false);
  assert.ok(state.map.coverage>.99);
  assert.ok(state.mosaic.entries.some(entry=>entry.mode==='map'));
});

// --- DBS (Doppler beam sharpening) service level -----------------------------------------------
// A DBS block is the same CAPTURE_MAP protocol on the 25 m lattice, so the same fake Export answers it.
// These tests are about the routing (its own lattice and session), the preemption order SAR > DBS > patrol
// and the /state contract the page reads: canDbs plus the dbs summary carrying note/lastFrame.
const DBS_ABEAM=[500,12000];                 // abeam of the demo flight (+x heading): the sharpened case
const DBS_FORWARD=[12500,0];                 // straight ahead: the block that degrades to the real beam

test('DBS images one block on its own fine lattice and does not touch the patrol map',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aesa-sar-dbs-'));
  const service=createService({tcpPort:0,httpPort:0,recordDir:root,processing:CONTROL});
  t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
  const ports=await service.started,base=`http://127.0.0.1:${ports.httpPort}`;
  const exporter=await openExport(t,ports.tcpPort);
  await until(()=>service.collector.capabilities?.map===true,'map capability');
  // A SAR patch teaches the service where the aircraft is and how fast it moves (the demo flight runs
  // along +x at 250 m/s, which is the velocity the DBS sharpening is computed from).
  assert.equal((await fetch(base+'/capture',{method:'POST',body:'{"side":1,"range":20000}'})).status,202);
  await until(()=>service.collector.job,'sar capture');
  exporter.client.write(sarMessages(demoScene(),service.collector.job.id));
  await until(()=>service.state.result,'sar image');
  const before=await(await fetch(base+'/state')).json();
  assert.equal(before.canDbs,true);assert.equal(before.dbs.active,false);assert.equal(before.dbs.lastFrame,null);
  assert.equal(before.dbs.supported,true);
  assert.deepEqual([before.dbs.span_limits,before.dbs.sharpens],[ [DBS.span_min_m,DBS.span_max_m],DBS.sharpens ]);
  assert.equal(before.dbs.cell_m,DBS.cell_m);
  const response=await fetch(base+'/dbs',{method:'POST',body:JSON.stringify({x:DBS_ABEAM[0],z:DBS_ABEAM[1],span_m:DBS.span_default_m,sharpen:DBS.sharpen_default})});
  assert.equal(response.status,202);
  const started=await response.json();
  assert.deepEqual([started.dbs,started.span_m,started.cell_m,started.grid,started.sharpen],[true,DBS.span_default_m,DBS.cell_m,DBS_GRID,DBS.sharpen_default]);
  assert.deepEqual(started.velocity,[250,0],'the block is sharpened with the pose the service was designated from');
  await until(()=>service.state.dbs.lastFrame,'dbs frame');
  // One CAPTURE_MAP job for the whole block: 21x21 on the 25 m lattice, centred on the designated point.
  const request=exporter.requests.at(-1);
  assert.deepEqual([request.relative,request.step,request.cols,request.rows,request.cells],[false,DBS.cell_m,DBS_GRID,DBS_GRID,DBS_GRID**2]);
  assert.equal(request.origin[0],Math.round(DBS_ABEAM[0]/DBS.cell_m)*DBS.cell_m-((DBS_GRID-1)/2)*DBS.cell_m);
  assert.equal(request.origin[1],Math.round(DBS_ABEAM[1]/DBS.cell_m)*DBS.cell_m-((DBS_GRID-1)/2)*DBS.cell_m);
  const state=await(await fetch(base+'/state')).json();
  assert.equal(state.dbs.active,false);
  assert.equal(state.dbs.frames,1);assert.equal(state.dbs.jobs,1);assert.equal(state.dbs.failures,0);
  assert.equal(state.dbs.lastFrame.grid,DBS_GRID);assert.equal(state.dbs.lastFrame.sharpen,DBS.sharpen_default);
  assert.equal(state.dbs.lastFrame.reused,false);
  assert.equal(state.dbs.lastFrame.effective,'sharpened','abeam of the flight the block gets the full factor');
  assert.match(state.dbs.note,/DBS 放大完成/);assert.match(state.dbs.note,new RegExp(`锐化 ${DBS.sharpen_default}:1`));
  assert.equal(state.canDbs,true);
  // The compact product: a 500 m block on a 25 m grid, marked as a DBS tile with its factor for the readout.
  const tile=state.mosaic.entries.at(-1);
  assert.equal(tile.mode,'dbs');assert.equal(tile.width,DBS_GRID);assert.equal(tile.size_m,DBS_SIZE_M);assert.equal(tile.image_step_m,DBS.cell_m);
  assert.equal(tile.quality,'dbs');assert.equal(tile.focuser,'doppler');assert.equal(tile.bearing,0);assert.equal(tile.sector,null);
  assert.equal(tile.dbs.factor,DBS.sharpen_default);assert.equal(tile.dbs.velocity[0],250);
  assert.equal(tile.seq,state.mosaic.latestSeq);
  const image=await(await fetch(base+`/image/${tile.seq}`)).json();
  assert.equal(image.db.length,DBS_GRID**2);
  assert.ok(image.db.every(v=>Number.isInteger(v)&&v>=-160&&v<=48),'matrix travels quantised (floor -127, sentinel -128, +12 dB headroom above the fixed reference)');
  assert.ok(!image.db.includes(-128),'a fully collected block has no no-data sentinel in it');
  // The block went into the DBS lattice, not the patrol's: the patrol never collected anything here, and
  // the report says so (this is the "互不污染" the patrol's own coverage numbers depend on).
  assert.equal(state.map.cells,0);assert.equal(state.map.surfaces,0);
  // A second shot at the same point is rendered from the fine lattice instead of asking the Export again.
  const asked=exporter.requests.length;
  assert.equal((await fetch(base+'/dbs',{method:'POST',body:'{"x":500,"z":12000}'})).status,202);
  await until(()=>service.state.dbs.lastFrame?.reused===true,'second dbs frame from the lattice');
  assert.equal(exporter.requests.length,asked,'the same block is not collected twice');
  const again=await(await fetch(base+'/state')).json();
  assert.equal(again.dbs.jobs,1,'the second shot did not ask the Export for anything');
  assert.equal(again.dbs.lastFrame.reused,true);
  assert.match(again.dbs.note,/复用已采集格/);
  assert.equal(again.mosaic.entries.at(-1).seq,tile.seq+1,'but it is a new tile: a new look at that ground');
  // Same block, same frame index: the second picture is bit-for-bit the first one. This is what the fixed
  // frame index buys the mosaic — a re-shot or an overlapping block shows the same clutter, not a re-roll.
  const second=await(await fetch(base+`/image/${again.mosaic.entries.at(-1).seq}`)).json();
  assert.deepEqual(second.db,image.db,'the ground, not the frame counter, decides the speckle');
});

test('DBS preempts the patrol job and the patrol resumes by itself',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aesa-sar-dbspreempt-'));
  const service=createService({tcpPort:0,httpPort:0,recordDir:root,processing:CONTROL});
  t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
  const ports=await service.started,base=`http://127.0.0.1:${ports.httpPort}`;
  const exporter=await openExport(t,ports.tcpPort);
  await until(()=>service.collector.capabilities?.map===true,'map capability');
  assert.equal((await fetch(base+'/continuous/start',{method:'POST',body:'{"mode":"map","cell":500,"range":20000}'})).status,202);
  await until(()=>service.collector.map,'patrol job');
  await until(async()=>(await(await fetch(base+'/state')).json()).map.window,'patrol sector placed');
  // Hold the patrol's next job so it is really in flight when the DBS request arrives.
  exporter.hold=true;
  await until(()=>exporter.held&&service.collector.map&&!service.collector.map.dbs,'held patrol job');
  const patrolJob=service.collector.map.id;
  assert.equal((await(await fetch(base+'/state')).json()).canDbs,true,'a patrol does not block a DBS block');
  const response=await fetch(base+'/dbs',{method:'POST',body:JSON.stringify({x:DBS_ABEAM[0],z:DBS_ABEAM[1]})});
  assert.equal(response.status,202);
  assert.equal(service.collector.map?.dbs,true,'the DBS block took the channel');
  assert.match(service.state.map.note,/DBS 放大抢占地图采集/);
  assert.ok(exporter.commands().includes('CANCEL'),'the patrol job was cancelled, not left running');
  assert.ok(patrolJob>0);
  await until(()=>service.state.dbs.lastFrame,'dbs frame');
  const during=await(await fetch(base+'/state')).json();
  assert.equal(during.map.active,true,'the patrol is preempted, not stopped');
  assert.equal(during.continuous.enabled,true);
  assert.equal(during.dbs.active,false);
  // The patrol resumes on its own with a fresh cell job, from the lattice the preemption left behind.
  await until(()=>service.collector.map&&!service.collector.map.dbs,'resumed patrol job');
  assert.ok(service.collector.map.id!==patrolJob);
  assert.equal((await fetch(base+'/continuous/stop',{method:'POST',body:'{}'})).status,200);
  assert.equal((await(await fetch(base+'/state')).json()).map.active,false);
});

test('A DBS block in flight refuses a second DBS and a SAR capture, and frees both afterwards',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aesa-sar-dbsbusy-'));
  const service=createService({tcpPort:0,httpPort:0,recordDir:root,processing:CONTROL});
  t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
  const ports=await service.started,base=`http://127.0.0.1:${ports.httpPort}`;
  const exporter=await openExport(t,ports.tcpPort);
  await until(()=>service.collector.capabilities?.map===true,'map capability');
  assert.equal((await fetch(base+'/capture',{method:'POST',body:'{"side":1,"range":20000}'})).status,202);
  await until(()=>service.collector.job,'sar capture');
  exporter.client.write(sarMessages(demoScene(),service.collector.job.id));
  await until(()=>service.state.result,'sar image');
  exporter.hold=true;                                        // keep the block in flight
  assert.equal((await fetch(base+'/dbs',{method:'POST',body:'{"x":500,"z":12000}'})).status,202);
  await until(()=>service.collector.map?.dbs===true,'dbs job in flight');
  const busy=await(await fetch(base+'/state')).json();
  assert.equal(busy.dbs.active,true);assert.equal(busy.canDbs,false);
  assert.equal(busy.canCapture,false,'a DBS block owns the terrain channel while it runs');
  const second=await fetch(base+'/dbs',{method:'POST',body:'{"x":1000,"z":13000}'});
  assert.equal(second.status,409);assert.match((await second.json()).error,/已在进行/);
  const sar=await fetch(base+'/capture',{method:'POST',body:'{"side":1,"range":20000}'});
  assert.equal(sar.status,409,'a SAR capture waits for the block instead of interrupting it');
  // The block is one or two seconds of work, so nothing is lost by waiting: release it and both routes open.
  assert.equal(exporter.release(),true);
  await until(()=>service.state.dbs.lastFrame,'dbs frame');
  const free=await(await fetch(base+'/state')).json();
  assert.equal(free.dbs.active,false);assert.equal(free.canDbs,true);assert.equal(free.canCapture,true);
  assert.equal(free.dbs.frames,1);
});

test('DBS validates its request with 400, refuses the impossible with 409 and reports a failure',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aesa-sar-dbsguard-'));
  const service=createService({tcpPort:0,httpPort:0,recordDir:root,processing:CONTROL});
  t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
  const ports=await service.started,base=`http://127.0.0.1:${ports.httpPort}`;
  const exporter=await openExport(t,ports.tcpPort);
  await until(()=>service.collector.capabilities?.map===true,'map capability');
  const dbs=body=>fetch(base+'/dbs',{method:'POST',body:JSON.stringify(body)});
  // A request the service cannot parse is a 400: the point, the block size and the factor are all validated
  // before anything is asked of the Export.
  for(const body of [{},{x:'a',z:0},{x:0},{x:1e9,z:0},{x:0,z:0,span_m:100},{x:0,z:0,span_m:2000},{x:0,z:0,sharpen:16},{x:0,z:0,sharpen:'8'},{x:0,z:0,sharpen:null}]){
    const response=await dbs(body);
    assert.equal(response.status,400,`${JSON.stringify(body)} is a bad request`);
    assert.match((await response.json()).error,/Invalid dbs/);
  }
  assert.equal((await(await fetch(base+'/state')).json()).dbs.active,false);
  assert.equal(service.collector.map,null,'a rejected request never starts a job');
  // Without a pose there is nothing to render from.
  const noPose=await dbs({x:0,z:12000});
  assert.equal(noPose.status,409);assert.match((await noPose.json()).error,/No aircraft pose/);
  assert.equal((await(await fetch(base+'/state')).json()).canDbs,true,'the button is live, the request just arrived too early');
  // Teach a pose, then the range gate: DBS borrows the Export's terrain range, nothing else.
  assert.equal((await fetch(base+'/capture',{method:'POST',body:'{"side":1,"range":20000}'})).status,202);
  await until(()=>service.collector.job,'sar capture');
  exporter.client.write(sarMessages(demoScene(),service.collector.job.id));
  await until(()=>service.state.result,'sar image');
  const near=await dbs({x:800,z:0});
  assert.equal(near.status,409);assert.match((await near.json()).error,/不在 1–50 km/);
  const far=await dbs({x:60000,z:0});
  assert.equal(far.status,409);assert.match((await far.json()).error,/不在 1–50 km/);
  assert.equal(service.collector.map,null,'a refused request never starts a job');
  // A manual map shot is a deliberate one-shot like a SAR patch: a DBS block waits for it instead of
  // cancelling it (only the patrol's rolling job gives way — a DBS must not throw away that sector).
  exporter.hold=true;
  assert.equal((await fetch(base+'/map',{method:'POST',body:JSON.stringify(MAP_REQUEST)})).status,202);
  await until(()=>service.collector.map&&!service.collector.map.dbs,'held manual map shot');
  const duringManual=await dbs({x:500,z:12000});
  assert.equal(duringManual.status,409);assert.match((await duringManual.json()).error,/等待上一次地图采集结束/);
  assert.equal(service.state.dbs.note==='未启动'||!/DBS 放大完成/.test(service.state.dbs.note),true,'no DBS frame was produced');
  assert.equal((await fetch(base+'/continuous/stop',{method:'POST',body:'{}'})).status,200);
  // Straight ahead is NOT refused: DBS has no side-looking window, it just comes out as the real beam.
  assert.equal((await dbs({x:DBS_FORWARD[0],z:DBS_FORWARD[1]})).status,202);
  await until(()=>service.state.dbs.lastFrame,'forward dbs frame');
  const forward=await(await fetch(base+'/state')).json();
  assert.equal(forward.dbs.lastFrame.effective,'real-beam');
  assert.match(forward.dbs.note,/退化为实波束/);
  // A job the Export refuses ends the session with the reason, and leaves the route usable again.
  exporter.failNext=true;
  assert.equal((await dbs({x:500,z:12000})).status,202);
  await until(async()=>(await(await fetch(base+'/state')).json()).dbs.failures>=1,'dbs failure counted');
  const failed=await(await fetch(base+'/state')).json();
  assert.equal(failed.dbs.active,false);
  assert.equal(failed.dbs.frames,1,'the failed shot produced no frame');
  assert.match(failed.dbs.note,/DBS 放大失败/);
  assert.equal(failed.canDbs,true,'and the next click is accepted');
});

test('Fine surface classes from the native probe flow through the patrol map',async t=>{
  // Each shot gets its own service: the map lattice is world-fixed and survives between shots of one
  // session, so a second shot would re-render the first one's classification instead of re-collecting.
  const shoot=async mode=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'aesa-sar-surfaces-'));
    const service=createService({tcpPort:0,httpPort:0,recordDir:root,processing:CONTROL});
    t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
    const ports=await service.started,base=`http://127.0.0.1:${ports.httpPort}`;
    const exporter=await openExport(t,ports.tcpPort);
    await until(()=>service.collector.capabilities?.map===true,'map capability');
    // The service asks for the fine vocabulary once per connection; an Export that predates the command
    // ignores it and keeps answering with the five-class words, so nothing breaks either way.
    await until(()=>exporter.commands().includes('SURFACE_FINE'),'SURFACE_FINE handshake');
    assert.equal(exporter.commands().split('SURFACE_FINE').length-1,1,'asked once, not per job');
    assert.equal((await fetch(base+'/capture',{method:'POST',body:'{"side":1,"range":20000}'})).status,202);
    await until(()=>service.collector.job,'sar capture');
    exporter.client.write(sarMessages(demoScene(),service.collector.job.id));
    await until(()=>service.state.result,'sar image');
    exporter.surfaceMode=mode;
    assert.equal((await fetch(base+'/map',{method:'POST',body:JSON.stringify(MAP_REQUEST)})).status,202);
    await until(async()=>(await(await fetch(base+'/state')).json()).mosaic.latestSeq>0&&service.state.map.frames>0,'map tile');
    await until(async()=>(await(await fetch(base+'/state')).json()).map.active===false,'shot ends');
    const state=await(await fetch(base+'/state')).json();
    const tile=state.mosaic.entries.at(-1);
    const image=await(await fetch(base+`/image/${tile.seq}`)).json();
    // Skip the -128 no-data sentinel (the square outside the sector); everything else is a measurement,
    // and the mosaic now carries positive dB too (the display ceiling sits well above the 0 dB reference).
    const cells=image.db.filter(v=>v>-128);
    return {state,tile,mean:cells.reduce((sum,v)=>sum+v/4,0)/cells.length};
  };
  const mixed=await shoot('fine');
  assert.ok(mixed.state.map.surfaces>=250,`the merged land/runway/building vocabulary was stored (${mixed.state.map.surfaces})`);
  assert.equal(mixed.tile.mode,'map');
  // The page can tell the engine's own 16-class mask from the five-class fallback: the flag appears only
  // after a fine name has travelled on this connection, and an old Export never sets it.
  assert.equal(mixed.state.map.fineSurfaces,true,'fine classes are reported for the page');
  assert.ok(mixed.state.map.lastFrame.relief.cells>0,'and the frame says how many cells the DSM layer lifted');
  assert.ok(mixed.state.map.lastFrame.relief.max_m>0,'with the tallest lift of that frame');
  assert.equal(Object.hasOwn(mixed.state.map,'fineSurfaces'),true,'and the field exists once seen');
  // A fine-class job is accepted end to end and the classes reach the picture: the 'Building+Land' half of
  // the wedge comes out at +6..+10 dB (double bounce) while the 'Land+Runway+Road' half picks the runway
  // and drops to about -16 dB — the frozen priority and the coefficients at work.
  assert.ok(mixed.mean>-8&&mixed.mean<-2,`the mixed wedge lands between the two halves (${mixed.mean.toFixed(1)} dB)`);
  // The controlled pair: the same geometry classified as a building union and as bare land.
  const building=await shoot('fine-building');
  const land=await shoot('legacy-land');
  assert.ok(building.mean>land.mean+5,`buildings really brighten the tile (${building.mean.toFixed(1)} vs ${land.mean.toFixed(1)} dB)`);
  assert.ok(land.state.map.surfaces>=250,'and the legacy path still classifies every cell');
  assert.equal(Object.hasOwn(land.state.map,'fineSurfaces'),false,'an old Export leaves the field out entirely');
});
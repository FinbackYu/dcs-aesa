'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),net=require('node:net'),http=require('node:http');
const {createService}=require('../tools/sar_live.cjs');
const {demoScene}=require('../tools/sar_demo_scene.cjs');
const {sar}=require('../src/shared/config.cjs');
const NL=String.fromCharCode(10);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(condition,label){for(let i=0;i<1200;i++){if(await condition())return;await delay(20);}throw Error(`wait timed out: ${label||'condition'}`);}
// The service binds an OS-assigned port (0) itself, so the port reported by started is exclusively
// owned by that instance; a second service can never share it. Talk to exactly that port through
// node:http, and fail on a missing/zero port instead of letting fetch turn it into an opaque "bad port".
function assertPort(port,label){
  assert.ok(Number.isInteger(port)&&port>0&&port<=65535,`${label} is a real listening port (got ${port})`);
}
function request(port,method,pathname,body){
  assertPort(port,'sweep service HTTP port');
  return new Promise((resolve,reject)=>{
    const payload=body===undefined?null:Buffer.from(body);
    const req=http.request({host:'127.0.0.1',port,method,path:pathname,
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
    req.on('error',reject);
    if(payload)req.write(payload);
    req.end();
  });
}
// The documented sweep contract, read from the generated spec so the test cannot restate a stale copy.
const SWEEP_SPEC=sar.map.sweep;
const WINDOW={maxRange:SWEEP_SPEC.max_range_m,minAngle:SWEEP_SPEC.min_angle_deg,maxAngle:SWEEP_SPEC.max_angle_deg,
  planMax:SWEEP_SPEC.plan_max,defaultSize:SWEEP_SPEC.default_size_m,exportMinRange:SWEEP_SPEC.min_range_m,
  predictedMinRange:SWEEP_SPEC.predicted_min_range_m,lead_s:SWEEP_SPEC.lead_s,band:SWEEP_SPEC.angle_band_deg};
const TILE_KEYS=['angleDeg','bearing','center','rangeM','side','size_m','status'];
const FOOTPRINTS={512:{n:sar.footprints.area.n,footprint:'area'},2048:{n:sar.footprints.airport.n,footprint:'airport'}};
const SWEEP={quality:'fast'};
const SPEED=250,ALTITUDE=4000;             // the demo trail: 250 m/s at 4000 m over 2 s
// A world tile as a complete scene: a flat DEM square centred on (x,z) and the demo trail as the
// aircraft track, flown at `speed`/`altitude`, slid `along` metres up its own heading, and finally
// moved by `offset` [dx,dz] so a test can put the aircraft anywhere relative to the tile.
function tileScene(x,z,{size=512,along=0,speed=SPEED,altitude=ALTITUDE,offset=null}={}){
  const scene=demoScene(),{n,footprint}=FOOTPRINTS[size];
  Object.assign(scene,{size,n,footprint});scene.center[0]=x;scene.center[2]=z;
  scene.terrain=Array.from({length:n*n},(_,index)=>{
    const cross=(index%n/(n-1)-.5)*size,ground=(Math.floor(index/n)/(n-1)-.5)*size;
    return [x+cross*Math.sin(scene.bearing)+ground*Math.cos(scene.bearing),100,
      z-cross*Math.cos(scene.bearing)+ground*Math.sin(scene.bearing)];});
  scene.center[1]=100;
  for(const pose of scene.trajectory){pose.pos[0]=speed*pose.t;pose.pos[1]=altitude;pose.pos[2]=0;}
  // The track runs along +x, so sliding the whole trail by `along` metres is a pure along-track move
  // that leaves the mean velocity (and with it the predicted pose) at `speed`.
  if(along)for(const pose of scene.trajectory)pose.pos[0]+=along;
  if(offset)for(const pose of scene.trajectory){pose.pos[0]+=offset[0];pose.pos[2]+=offset[1];}
  return scene;}
function messages(scene,id){return [
  `BEGIN,${id},${scene.center[0]},${scene.center[2]},${scene.bearing},${scene.size},${scene.n}`,
  ...scene.terrain.map((point,index)=>`HEIGHT,${id},${index},${point.join(',')}`),
  ...scene.trajectory.map((pose,index)=>`POSE,${id},${index},${pose.t},${pose.pos.join(',')}`),
  `END,${id},${scene.trajectory.length},${scene.trajectory.at(-1).t}`].join(NL)+NL;}
async function openExport(t,port,{capabilities=true}={}){
  const client=net.createConnection({host:'127.0.0.1',port});t.after(()=>client.destroy());
  let buffer='';client.on('data',chunk=>buffer+=chunk.toString());
  await new Promise(resolve=>client.once('connect',resolve));
  const status=()=>client.write('STATUS,42,terrain.GetHeight,50,51,50,1'+NL);
  client.write('HELLO,SAR1'+NL+(capabilities?'CAPS,2,terrain.GetSurfaceType'+NL:'')+'STATUS,42,terrain.GetHeight,50,51,50,1'+NL);
  // The service only captures while a terrain status is fresh (<3 s), so the stub keeps reporting
  // one; a real Export sends it every frame.
  const beat=setInterval(()=>{if(!client.destroyed)status();},1000);t.after(()=>clearInterval(beat));
  return {client,status,commands:()=>buffer};}
async function sweepService(t,{scene=null,processing=SWEEP,capabilities=true}={}){
  const service=createService({tcpPort:0,httpPort:0,...(scene?{scene}:{}),processing});
  t.after(()=>service.close());
  const ports=await service.started;
  assertPort(ports.httpPort,'sweep service HTTP port');
  if(scene)await until(()=>service.state.result,'seed image');
  const exporter=await openExport(t,ports.tcpPort,{capabilities});
  await until(()=>service.collector.status&&(!capabilities||service.collector.capabilities),'Export handshake');
  return {service,port:ports.httpPort,exporter,start:body=>request(ports.httpPort,'POST','/continuous/start',body)};}
// A real Export streams a patch line by line and the service refuses a protocol buffer above
// 64 KB, so a scene is fed in batches instead of one write (the service drains each batch).
async function feed(exporter,scene,id){
  const lines=messages(scene,id).split(NL);
  for(let start=0;start<lines.length;start+=240){exporter.client.write(lines.slice(start,start+240).join(NL)+NL);await delay(2);}}
// Waits for the newest capture command of one kind with an id above `afterId` (capture ids increase
// per service, so this is immune to a command that already arrived before the caller looked) and
// parses it. `size` narrows the wait to one tile size, which separates a restart's squares from an
// abandoned capture of the previous sweep.
async function captureCommand(exporter,prefix,{afterId=0,size=null,label}={}){
  const lines=()=>exporter.commands().split(NL).filter(line=>line.startsWith(`${prefix},`)
    &&(size===null||line.endsWith(`,${size},${FOOTPRINTS[size].n}`)));
  const newest=()=>{const found=lines();return found.length?found.at(-1):null;};
  await until(()=>{const line=newest();return !!line&&Number(line.split(',')[1])>afterId;},
    label||`${prefix} capture after id ${afterId}`);
  const line=newest(),fields=line.split(',');
  return {line,fields,id:Number(fields[1]),size:Number(fields.at(-2)),n:Number(fields.at(-1)),
    fixed:prefix==='CAPTURE_WORLD'?{x:Number(fields[2]),z:Number(fields[3])}:{side:Number(fields[2]),range:Number(fields[3])}};}
// The pose the service derives from a scene: the newest trajectory end, its instantaneous track, and
// the mean ground velocity of the whole trajectory (which is what the lead uses).
function poseOf(scene){const trajectory=scene.trajectory,last=trajectory.at(-1),previous=trajectory.at(-2),first=trajectory[0];
  const span=last.t-first.t;
  return {x:last.pos[0],z:last.pos[2],heading:Math.atan2(last.pos[0]-previous.pos[0],last.pos[2]-previous.pos[2]),
    velocity:span>0?[(last.pos[0]-first.pos[0])/span,(last.pos[2]-first.pos[2])/span]:null};}
function covers(cover,tile){return Math.hypot(cover[0]-tile.x,cover[1]-tile.z)<=cover[2]*Math.SQRT1_2;}
// Where the service measures its window from: the pose pushed `lead` seconds up its own track.
function leadOf(pose,lead=WINDOW.lead_s){
  return pose.velocity?{x:pose.x+pose.velocity[0]*lead,z:pose.z+pose.velocity[1]*lead,heading:pose.heading,lead}
    :{x:pose.x,z:pose.z,heading:pose.heading,lead:0};}
// The window the service should offer, derived from the documented rule rather than from the
// service: fixed lattice centres, 5° forward bands then ground range, |relative track angle| 30–60°,
// measured from the predicted pose with a 1.5 km floor (the plain 1 km Export floor without a lead).
// `covered` lists [x,z,size_m] of already imaged squares.
function windowTiles(pose,size,{covered=[],lead=WINDOW.lead_s}={}){
  const anchor=leadOf(pose,lead),minRange=anchor.lead?WINDOW.predictedMinRange:WINDOW.exportMinRange;
  const tiles=[];
  for(let tx=Math.floor((anchor.x-WINDOW.maxRange)/size);tx<=Math.floor((anchor.x+WINDOW.maxRange)/size);tx++)
    for(let tz=Math.floor((anchor.z-WINDOW.maxRange)/size);tz<=Math.floor((anchor.z+WINDOW.maxRange)/size);tz++){
      const x=(tx+.5)*size,z=(tz+.5)*size,dx=x-anchor.x,dz=z-anchor.z,range=Math.hypot(dx,dz);
      if(range<minRange||range>WINDOW.maxRange)continue;
      // Positive is to the right, the Export's convention: the tracks these tests build run along +x,
      // so a square in the +z half is abeam right and carries side 1 — the same sign /designate/check
      // reports for the same point.
      let angle=(anchor.heading-Math.atan2(dx,dz))*180/Math.PI;
      while(angle>180)angle-=360;
      while(angle<-180)angle+=360;
      const azimuth=Math.abs(angle);
      if(azimuth<WINDOW.minAngle||azimuth>WINDOW.maxAngle)continue;
      if(covered.some(cover=>covers(cover,{x,z})))continue;
      tiles.push({x,z,azimuth,range,side:angle>=0?1:-1,band:Math.floor((azimuth-WINDOW.minAngle)/WINDOW.band)});}
  tiles.sort((a,b)=>a.band-b.band||a.range-b.range);
  return tiles;}
function coveredInWindow(pose,size,covered){
  return windowTiles(pose,size,{covered:[]}).filter(tile=>covered.some(cover=>covers(cover,tile)));}
function assertPlan(plan,expected,label){
  const note=label||'';
  assert.equal(plan.length,Math.min(WINDOW.planMax,expected.length),`plan length ${note}`);
  assert.deepEqual(plan.map(tile=>`${tile.center[0]},${tile.center[2]}`).sort(),
    expected.slice(0,plan.length).map(tile=>`${tile.x},${tile.z}`).sort(),`plan tiles ${note}`);
  plan.forEach((tile,index)=>{
    assert.equal(Math.floor((tile.angleDeg-WINDOW.minAngle)/WINDOW.band),expected[index].band,`band of tile ${index} ${note}`);
    assert.ok(Math.abs(tile.rangeM-expected[index].range)<=1,`range of tile ${index} ${note}`);});}
// Every tile is measured from the anchor the service used, so the assertions take that anchor too.
function assertTile(tile,size,anchor,expected){
  assert.deepEqual(Object.keys(tile).sort(),TILE_KEYS,'tile contract');
  assert.equal(tile.size_m,size);
  assert.ok(Math.abs(tile.center[0]/size-.5-Math.round(tile.center[0]/size-.5))<1e-9,`x on the ${size} m lattice: ${tile.center[0]}`);
  assert.ok(Math.abs(tile.center[2]/size-.5-Math.round(tile.center[2]/size-.5))<1e-9,`z on the ${size} m lattice: ${tile.center[2]}`);
  assert.ok(Number.isFinite(tile.center[1]),'tile height comes from the newest capture');
  const dx=tile.center[0]-anchor.x,dz=tile.center[2]-anchor.z,range=Math.hypot(dx,dz);
  assert.ok(range>=WINDOW.predictedMinRange&&range<=WINDOW.maxRange,`ground range ${range} clears the predicted floor`);
  assert.ok(Math.abs(tile.bearing-Math.atan2(dx,dz))<1e-6,'bearing points at the tile from the anchor');
  assert.ok(tile.angleDeg>=WINDOW.minAngle&&tile.angleDeg<=WINDOW.maxAngle,`angle ${tile.angleDeg} inside the side window`);
  assert.ok(Math.abs(tile.angleDeg-expected.azimuth)<=0.06,`angle ${tile.angleDeg} vs ${expected.azimuth}`);
  assert.equal(tile.rangeM,Math.round(expected.range));
  assert.equal(tile.side,expected.side,'side follows the tile position relative to the ground track');
  // The sign itself, from geometry rather than from the formula above: the tracks in this file run
  // along +x, so the +z half of the window is abeam to the right and must read side 1 (positive = right
  // is the Export's convention, the one the 右/左 wording and the viewer's sweep card read).
  assert.equal(tile.side,Math.sign(tile.center[2]-anchor.z),`side sign at z=${tile.center[2]} vs anchor ${anchor.z}`);}
test('Sweep tiles are fixed world squares chosen from the predicted pose',async t=>{
  const {service,exporter,start}=await sweepService(t);
  assert.equal((await start('{"mode":"sweep","side":1,"range":20000}')).status,202);
  const opened=service.state.continuous;
  assert.equal(opened.mode,'sweep');assert.equal(opened.sweepSize,512);assert.equal(opened.footprint,'area');
  assert.equal(opened.sweepPlan,null,'no window before the aircraft position is known');
  // The Export status carries no position, so the first patch is the relative side/range one: it
  // only exists to learn the pose, and the squares start with the capture after it.
  const bootstrap=await captureCommand(exporter,'CAPTURE',{label:'the bootstrap patch'});
  assert.deepEqual([bootstrap.fixed.side,bootstrap.fixed.range,bootstrap.size,bootstrap.n],[1,20000,512,33]);
  await feed(exporter,tileScene(0,0),bootstrap.id);
  const world=await captureCommand(exporter,'CAPTURE_WORLD',{afterId:bootstrap.id,label:'the first world square'});
  const continuous=service.state.continuous,pose=poseOf(tileScene(0,0)),anchor=leadOf(pose);
  assert.deepEqual(continuous.sweepAnchor,[anchor.x,anchor.z],'the window is anchored on the predicted pose');
  assert.ok(Math.abs(anchor.x-pose.x-SPEED*WINDOW.lead_s)<1e-9,'a 250 m/s aircraft is led by 2.5 km');
  assert.equal(continuous.sweepIndex,0);assert.equal(continuous.sweepDeferred,0);
  assert.equal(continuous.sweepPruned,0,'the one imaged square sits under the aircraft, behind the window');
  const plan=continuous.sweepPlan,expected=windowTiles(pose,512);
  assert.equal(plan.length,WINDOW.planMax,`the unbounded grid is exposed as a batch of ${WINDOW.planMax}`);
  assertPlan(plan,expected);
  plan.forEach((tile,index)=>{assertTile(tile,512,anchor,expected[index]);
    assert.equal(tile.status,index===0?'capturing':'pending','only the square being imaged is marked');
    assert.ok(tile.rangeM>=WINDOW.predictedMinRange,'every square clears the 1.5 km predicted floor');});
  const angles=plan.map(tile=>tile.angleDeg);
  assert.ok(Math.min(...angles)>=WINDOW.minAngle,'nothing closer to the nose than 30°');
  assert.ok(Math.min(...angles)<35.1,'the batch opens in the 30–35° band, i.e. forward first');
  // Both sides of the track are offered, and each side's sign is the one the operator reads: the tiles
  // with a positive z offset are abeam right (side 1), the others abeam left (side -1).
  assert.deepEqual([...new Set(plan.map(tile=>tile.side))].sort(),[-1,1],'the batch spans both sides of the track');
  const forward=plan.filter(tile=>tile.angleDeg<35.06).map(tile=>tile.rangeM);
  assert.deepEqual(forward,[...forward].sort((a,b)=>a-b),'inside the closest band: near range first');
  assert.equal(world.size,512);assert.equal(world.n,33);
  assert.equal(world.fixed.x,plan[0].center[0]);assert.equal(world.fixed.z,plan[0].center[2]);
});
test('A fast aircraft is offered squares that are still ahead when the patch is taken',async t=>{
  // The real failure: squares chosen at 1.0–1.8 km were 0.6–0.9 km away by the time the Export
  // looked, because a 317 m/s aircraft closed the gap while the previous image was computed. The
  // window is now measured from the predicted pose, so those squares are never offered.
  const seed=tileScene(0,0,{speed:317,altitude:1800});
  const {service,exporter,start}=await sweepService(t,{scene:seed});
  assert.equal((await start('{"mode":"sweep","side":1,"range":20000}')).status,202);
  const pose=poseOf(seed),anchor=leadOf(pose);
  assert.ok(Math.abs(anchor.x-pose.x-317*WINDOW.lead_s)<1e-9,'10 s of lead at 317 m/s is 3.17 km');
  const world=await captureCommand(exporter,'CAPTURE_WORLD',{label:'the first square'});
  const continuous=service.state.continuous;
  assert.deepEqual(continuous.sweepAnchor,[anchor.x,anchor.z],'the window is anchored on the predicted pose');
  assert.match(continuous.note,/前推 10 s 处/);
  const plan=continuous.sweepPlan;
  assertPlan(plan,windowTiles(pose,512));
  assert.equal(continuous.sweepPruned,0);
  assert.ok(plan.every(tile=>tile.rangeM>=WINDOW.predictedMinRange),'every square clears 1.5 km from the predicted pose');
  // The Export checks the range again when the patch is collected (here: at the newest pose in the
  // answered scene), and every offered square is still well past its 1 km floor there.
  const short=plan.filter(tile=>Math.hypot(tile.center[0]-pose.x,tile.center[2]-pose.z)<WINDOW.exportMinRange);
  assert.deepEqual(short,[],'no offered square has closed under the Export 1 km floor by capture time');
  // The square the old rule took: the nearest 30–35° candidate seen from the current pose with the
  // Export's plain 1 km floor — exactly the one that closed to 0.6–0.9 km in the real flight.
  const near=windowTiles(pose,512,{lead:0})[0];
  const nearRange=Math.hypot(near.x-pose.x,near.z-pose.z);
  assert.ok(nearRange<1600&&nearRange>=WINDOW.exportMinRange,`the old rule offered a ${Math.round(nearRange)} m square`);
  assert.ok(!plan.some(tile=>tile.center[0]===near.x&&tile.center[2]===near.z),'the square that would close under 1 km is not offered');
  assert.ok(Math.hypot(world.fixed.x-pose.x,world.fixed.z-pose.z)>=WINDOW.exportMinRange,'the taken square is past 1 km at capture time');
});
test('The window slides with the aircraft and never offers a covered square again',async t=>{
  const {service,exporter,start}=await sweepService(t);
  assert.equal((await start('{"mode":"sweep","side":1,"range":20000}')).status,202);
  const bootstrap=await captureCommand(exporter,'CAPTURE');
  await feed(exporter,tileScene(0,0),bootstrap.id);
  const first=await captureCommand(exporter,'CAPTURE_WORLD',{afterId:bootstrap.id});
  const anchor=service.state.continuous.sweepAnchor.slice();
  await feed(exporter,tileScene(first.fixed.x,first.fixed.z),first.id);
  await until(()=>service.state.continuous.completed===1,'first square imaged');
  const second=await captureCommand(exporter,'CAPTURE_WORLD',{afterId:first.id,label:'the second square'});
  assert.notDeepEqual([second.fixed.x,second.fixed.z],[first.fixed.x,first.fixed.z],'a new square, not the covered one');
  const continuous=service.state.continuous,pose=poseOf(tileScene(0,0)),image=[first.fixed.x,first.fixed.z,512];
  // The pose has not moved, so the window is the same: the imaged square is still a candidate there
  // and must be pruned as covered rather than offered again.
  assert.deepEqual(continuous.sweepAnchor,anchor);
  assert.ok(coveredInWindow(pose,512,[image]).length>=1,'the imaged square is still inside the window');
  assert.equal(continuous.sweepPruned,coveredInWindow(pose,512,[image]).length);
  assert.ok(!continuous.sweepPlan.some(tile=>tile.center[0]===image[0]&&tile.center[2]===image[1]),'a covered square is not offered again');
  // Answer the second capture with a scene whose aircraft has flown 640 m up the track: the window
  // re-anchors on the new predicted pose.
  await feed(exporter,tileScene(second.fixed.x,second.fixed.z,{along:640}),second.id);
  await until(()=>service.state.continuous.completed===2,'second square imaged');
  const third=await captureCommand(exporter,'CAPTURE_WORLD',{afterId:second.id,label:'the third square'});
  const moved=poseOf(tileScene(0,0,{along:640})),movedAnchor=leadOf(moved);
  assert.deepEqual(continuous.sweepAnchor,[movedAnchor.x,movedAnchor.z],'the anchor moved with the aircraft');
  assert.equal(continuous.sweepAnchor[0]-anchor[0],640);
  const covered=[image,[second.fixed.x,second.fixed.z,512]];
  assertPlan(continuous.sweepPlan,windowTiles(moved,512,{covered}));
  assert.equal(continuous.sweepPruned,coveredInWindow(moved,512,covered).length);
  for(const square of covered)assert.ok(!continuous.sweepPlan.some(tile=>
    tile.center[0]===square[0]&&tile.center[2]===square[1]),'a covered square is not offered again');
  assert.notDeepEqual([third.fixed.x,third.fixed.z],[first.fixed.x,first.fixed.z]);
  assert.notDeepEqual([third.fixed.x,third.fixed.z],[second.fixed.x,second.fixed.z]);
});
test('A 2048 m image covers the 512 m squares inside it',async t=>{
  const seed=tileScene(0,0,{size:2048});
  const {service,port,exporter,start}=await sweepService(t,{scene:seed});
  assert.equal((await start('{"mode":"sweep","side":1,"range":20000,"sweepSize":2048}')).status,202);
  const pose=poseOf(seed),anchor=leadOf(pose);
  const world=await captureCommand(exporter,'CAPTURE_WORLD',{label:'the first 2048 m tile'});
  assert.equal(world.size,2048);assert.equal(world.n,65);
  assertPlan(service.state.continuous.sweepPlan,windowTiles(pose,2048,{covered:[[0,0,2048]]}),'2048 m window');
  await feed(exporter,tileScene(world.fixed.x,world.fixed.z,{size:2048}),world.id);
  await until(()=>service.state.continuous.completed===1,'2048 m tile imaged');
  const state=(await request(port,'GET','/state')).body;
  const image=state.mosaic.entries.at(-1);
  assert.equal(image.size_m,2048);assert.equal(image.width,129,'the fast grid halves the 257 m overview grid');
  assert.deepEqual(image.center,[world.fixed.x,100,world.fixed.z]);
  assert.equal((await request(port,'POST','/continuous/stop','{}')).status,200);
  // Re-enter the same window with 512 m squares: a 2048 m image covers every 512 m square whose
  // centre falls inside it, so those squares must not be offered again.
  assert.equal((await start('{"mode":"sweep","side":1,"range":20000,"sweepSize":512}')).status,202);
  const small=await captureCommand(exporter,'CAPTURE_WORLD',{afterId:world.id,size:512,label:'the first 512 m square'});
  const continuous=service.state.continuous;
  assert.equal(continuous.sweepSize,512);
  const cover=[world.fixed.x,world.fixed.z,2048];
  assertPlan(continuous.sweepPlan,windowTiles(pose,512,{covered:[cover]}));
  const pruned=coveredInWindow(pose,512,[cover]).length;
  assert.ok(pruned>=1,`the 2048 m image covers ${pruned} candidate squares`);
  assert.equal(continuous.sweepPruned,pruned);
  assert.ok(!continuous.sweepPlan.some(tile=>covers(cover,tile)),'no square inside the big image is offered');
  assert.notDeepEqual([small.fixed.x,small.fixed.z],[world.fixed.x,world.fixed.z]);
  assert.ok(Math.abs(continuous.sweepAnchor[0]-anchor.x)<1e-6,'the same pose re-anchors the same window');
});
test('A 2048 m sweep falls back from PFA to backprojection and says so',async t=>{
  const {service,port,exporter,start}=await sweepService(t);
  const response=await start('{"mode":"sweep","side":1,"range":20000,"sweepSize":2048,"focuser":"pfa"}');
  assert.equal(response.status,202);
  const continuous=service.state.continuous;
  assert.equal(continuous.sweepSize,2048);assert.equal(continuous.footprint,'airport');
  assert.equal(continuous.focuser,'backprojection','a 2048 m patch is past the PFA k-grid limit');
  const bootstrap=await captureCommand(exporter,'CAPTURE');
  assert.deepEqual([bootstrap.fixed.side,bootstrap.fixed.range,bootstrap.size,bootstrap.n],[1,20000,2048,65]);
  await feed(exporter,tileScene(0,0,{size:2048}),bootstrap.id);
  const world=await captureCommand(exporter,'CAPTURE_WORLD',{afterId:bootstrap.id,label:'the first 2048 m tile'});
  assert.equal(world.size,2048);assert.equal(world.n,65);
  assert.ok(Math.abs(world.fixed.x/2048-.5-Math.round(world.fixed.x/2048-.5))<1e-9,'tile centre on the 2048 m lattice');
  assert.match(service.state.continuous.note,/2048 m 瓦片超出 PFA 的 k 网格上限，已改用反投影/);
  assert.match(service.state.continuous.note,/前推 10 s 处/);
  await feed(exporter,tileScene(world.fixed.x,world.fixed.z,{size:2048}),world.id);
  await until(()=>service.state.continuous.completed===1,'2048 m tile imaged');
  const state=(await request(port,'GET','/state')).body;
  const image=state.mosaic.entries.at(-1);
  assert.equal(image.size_m,2048);assert.equal(image.focuser,'backprojection','the image records the focuser used');
  assert.equal(image.quality,'fast');
  // The fallback is specific to the big tile: a 512 m sweep keeps the requested focuser.
  const small=createService({tcpPort:0,httpPort:0,processing:SWEEP});t.after(()=>small.close());
  const smallPorts=await small.started;
  assertPort(smallPorts.httpPort,'small sweep HTTP port');
  const smallExporter=await openExport(t,smallPorts.tcpPort);
  assert.equal((await request(smallPorts.httpPort,'POST','/continuous/start',
    '{"mode":"sweep","side":1,"range":20000,"focuser":"pfa"}')).status,202);
  assert.equal(small.state.continuous.focuser,'pfa');
  assert.equal(small.state.continuous.sweepSize,512);assert.equal(small.state.continuous.footprint,'area');
  const smallCapture=await captureCommand(smallExporter,'CAPTURE');
  assert.deepEqual([smallCapture.size,smallCapture.n],[512,33]);
});
test('A tile the engine cannot simulate is skipped, backed off and the sweep moves on',async t=>{
  // A 2048 m overview collected by a 390 m/s aircraft needs twenty thousand simulated pulses: it
  // cannot fit the echo-history budget at all, and the refusal has to name both numbers, retire the
  // square, keep it out of the next window and let the sweep take another one. The ceiling is an
  // engine limit, not a sweep rule.
  const seed=tileScene(20000,20000);
  const {service,exporter,start}=await sweepService(t,{scene:seed,processing:{quality:'fast',pulseSampling:'auto',lambda:.005}});
  assert.equal((await start('{"mode":"sweep","side":1,"range":20000,"sweepSize":2048}')).status,202);
  const world=await captureCommand(exporter,'CAPTURE_WORLD',{label:'the first world square'});
  const continuous=service.state.continuous,plan=continuous.sweepPlan;
  const chosen=plan.find(tile=>tile.status==='capturing');
  assert.deepEqual([chosen.center[0],chosen.center[2]],[world.fixed.x,world.fixed.z]);
  await feed(exporter,tileScene(world.fixed.x,world.fixed.z,{size:2048,speed:390}),world.id);
  await until(()=>service.state.continuous.failures===1,'the square is refused');
  const needed=Number((service.state.error.match(/needs (\d+) simulated pulses/)||[])[1]);
  const allowed=Number((service.state.error.match(/allows (\d+);/)||[])[1]);
  assert.ok(needed>allowed,`the refusal carries both numbers: ${needed} > ${allowed}`);
  assert.ok(allowed>8192,'the derived ceiling is above the fixed one it replaced');
  assert.match(service.state.continuous.note,/simulated pulses/);
  assert.match(service.state.continuous.note,/该瓦片退避 60 s/);
  assert.equal(service.state.continuous.enabled,true,'a refused square never stops the sweep');
  assert.equal(service.state.continuous.skipped,0,'a refusal is a failure, not a geometry skip');
  assert.equal(chosen.status,'skipped','the refused square is retired');
  const next=await captureCommand(exporter,'CAPTURE_WORLD',{afterId:world.id,label:'the next square after the backoff'});
  assert.notDeepEqual([next.fixed.x,next.fixed.z],[world.fixed.x,world.fixed.z],'the refused square is deferred');
  assert.ok(service.state.continuous.sweepDeferred>=1,'the backoff keeps it out of the ranked window');
  assert.ok(!service.state.continuous.sweepPlan.some(tile=>
    tile.center[0]===world.fixed.x&&tile.center[2]===world.fixed.z),'a deferred square is not offered again');
});
test('Sweep start needs a version 2 Export and bootstraps the pose with one relative patch',async t=>{
  // Without world coordinates the Export cannot name a tile, so the sweep refuses to start instead
  // of imaging squares nobody asked for.
  const legacy=createService({tcpPort:0,httpPort:0,processing:SWEEP});t.after(()=>legacy.close());
  const legacyPorts=await legacy.started;
  assertPort(legacyPorts.httpPort,'legacy sweep HTTP port');
  const legacyExport=await openExport(t,legacyPorts.tcpPort,{capabilities:false});
  await until(()=>legacy.collector.status,'legacy status');
  await delay(50);
  const refused=await request(legacyPorts.httpPort,'POST','/continuous/start','{"mode":"sweep","side":1,"range":20000}');
  assert.equal(refused.status,409);
  assert.match(refused.body.error,/Update SAR Export/);
  assert.equal(legacy.state.continuous.enabled,false,'a sweep never starts half-configured');
  assert.equal(legacyExport.commands(),'','nothing is captured at all');
  // A version 2 Export without a trajectory yet: one relative patch teaches the sweep the pose.
  const {service,exporter,start}=await sweepService(t);
  assert.equal((await start('{"mode":"sweep","side":-1,"range":15000}')).status,202);
  const bootstrap=await captureCommand(exporter,'CAPTURE',{label:'the bootstrap patch'});
  assert.deepEqual([bootstrap.fields[2],bootstrap.fields[3],bootstrap.size,bootstrap.n],['-1','15000',512,33]);
  assert.equal(service.state.continuous.sweepPlan,null,'no window before a trajectory exists');
});
test('Sweep parameters are validated and relative mode is unchanged',async t=>{
  const service=createService({tcpPort:0,httpPort:0,processing:SWEEP});t.after(()=>service.close());
  const ports=await service.started;
  assertPort(ports.httpPort,'parameter sweep HTTP port');
  const post=body=>request(ports.httpPort,'POST','/continuous/start',body);
  assert.equal((await post('{"mode":"swath","side":1,"range":20000}')).status,409);
  assert.equal((await post('{"mode":"sweep","side":1}')).status,409);
  const invalid=await post('{"mode":"sweep","side":1,"range":20000,"sweepSize":1024}');
  assert.equal(invalid.status,409);assert.match(invalid.body.error,/Invalid sweep tile size/);
  assert.equal((await post('{"mode":"sweep","side":1,"range":20000,"sweepSize":512}')).status,202);
  assert.equal(service.state.continuous.sweepSize,512);assert.equal(service.state.continuous.footprint,'area');
  assert.equal((await request(ports.httpPort,'POST','/continuous/stop','{}')).status,200);
  assert.equal((await post('{"side":1,"range":20000}')).status,202);
  const continuous=service.state.continuous;
  assert.equal(continuous.mode,'relative');assert.equal(continuous.sweepPlan,null);
  assert.equal(continuous.sweepSize,WINDOW.defaultSize,'the tile size is reported in both modes');
  assert.equal(continuous.footprint,'detail');
});

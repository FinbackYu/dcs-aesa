'use strict';
const net=require('node:net');
const {surfaceName,validateExtras}=require('../src/adapters/dcs/sar_adapter.cjs');
const {PROTOCOL}=require('../src/shared/config.cjs');
const PROTOCOL_SCENE=PROTOCOL.scene;
// A mover poll is one bounded search box, not a whole scene, so it gets a tighter timeout: the
// service polls at the generated mover cadence and must never queue behind a stalled mission side.
const MOVER_TIMEOUT_MS=PROTOCOL.timeouts.mover_response_timeout_ms,MOVER_LIMIT=PROTOCOL_SCENE.mover_max,
  MOVER_RADIUS_MAX=PROTOCOL_SCENE.mover_radius_max_m;
const PROVIDERS=['unavailable','a_do_script','net.dostring_in(existing_permissions)','net.dostring_in(scripting)','net.dostring_in(mission)','net.dostring_in(mission)+a_do_script'];
function createBridge({port=PROTOCOL.ports.sar_scene}={}){
 let socket=null,job=null,moverJob=null,nextMoverId=1;
 const capabilities={connected:false,surface:'unavailable',objects:'unavailable',movers:'unavailable',provider:'unavailable',error:null,compat:null};
 function settle(reason){if(!job)return;const j=job;job=null;clearTimeout(j.timer);
  if(j.resolve)j.resolve({...(j.complete?{surfaces:j.surfaces,objects:j.objectProvider==='world.searchObjects'?j.objects:[]}:{}),
   scene_data:{surface_provider:j.complete?'land.getSurfaceType':'unavailable',object_provider:j.complete?j.objectProvider:'unavailable',
    objects_skipped:j.skipped||0,moving_objects_skipped:j.moving||0,objects_truncated:j.objects.length>=PROTOCOL_SCENE.object_max||j.objects.length+(j.skipped||0)+(j.moving||0)>=PROTOCOL_SCENE.object_visit_max,bridge:capabilities.provider,note:reason}});
 }
 function settleMover(reason){if(!moverJob)return;const j=moverJob;moverJob=null;clearTimeout(j.timer);
  if(j.resolve)j.resolve({movers:j.complete?j.movers:[],visited:j.visited||0,complete:!!j.complete,reason});}
 // One ground-mover query: the mission lists UNIT/STATIC objects inside the box with their velocity
 // vectors, and the caller applies the radar's own detection rules (Doppler blind zone, range).
 function movers({cx,cz,radius=MOVER_RADIUS_MAX,timeoutMs=MOVER_TIMEOUT_MS}={}){
  if(!Number.isFinite(cx)||!Number.isFinite(cz)||Math.abs(cx)>1e8||Math.abs(cz)>1e8
     ||!Number.isFinite(radius)||radius<1000||radius>MOVER_RADIUS_MAX)
    return Promise.resolve({movers:[],complete:false,reason:'invalid mover request'});
  settleMover('superseded');
  if(!socket||socket.destroyed||capabilities.movers!=='world.searchObjects')
    return Promise.resolve({movers:[],complete:false,
      reason:!socket||socket.destroyed?'scene hook disconnected':capabilities.movers==='unavailable'?'mission sampler has no mover query':'scene hook not ready'});
  const queried={id:nextMoverId++,movers:[],visited:0,complete:false,timer:null,resolve:null};
  moverJob=queried;
  // A socket can die between the guard above and this write; that must degrade like any other
  // disconnection instead of throwing out of a poll tick.
  try{socket.write(`MOVER,${queried.id},${cx.toFixed(9)},${cz.toFixed(9)},${Math.round(radius)}\n`);}
  catch(e){moverJob=null;return Promise.resolve({movers:[],complete:false,reason:'scene hook disconnected'});}
  return new Promise(resolve=>{queried.resolve=resolve;
   queried.timer=setTimeout(()=>{socket?.write('MOVER_CANCEL\n');settleMover('mover response timed out');},Math.max(100,timeoutMs));});
 }
 const server=net.createServer(c=>{
  if(socket){c.destroy();return;}socket=c;c.setNoDelay(true);let buf='',hello=false;
  c.on('data',chunk=>{buf+=chunk.toString('ascii');if(buf.length>PROTOCOL.limits.scene_recv_buffer_bytes){c.destroy();return;}
   try{while(buf.includes('\n')){const i=buf.indexOf('\n'),line=buf.slice(0,i).replace(/\r$/,'');buf=buf.slice(i+1);if(line.length>PROTOCOL.limits.scene_line_max_chars)throw Error('Scene line too long');
    if(!hello){if(line!==`HELLO,${PROTOCOL.versions.scene}`)throw Error('Invalid scene greeting');hello=true;capabilities.connected=true;continue;}
    const a=line.split(',');
    if(a[0]==='CAP'){
      // Four fields is the pre-GMTI hook (surface, objects, provider); five adds the mover capability
      // before the provider, which the hook always appends last.
      if(!PROTOCOL_SCENE.rows.CAP.fields.includes(a.length))throw Error('Invalid scene capabilities');
      const moversField=a.length===5?a[3]:'unavailable',providerField=a.length===5?a[4]:a[3];
      if(!['land.getSurfaceType','unavailable'].includes(a[1])||!['world.searchObjects','unavailable'].includes(a[2])
        ||!['world.searchObjects','unavailable'].includes(moversField)||!PROVIDERS.includes(providerField))throw Error('Invalid scene capabilities');
      Object.assign(capabilities,{surface:a[1],objects:a[2],movers:moversField,provider:providerField,error:null});continue;}
    // Compatibility handshake from the mission sampler: COMPAT,<profile_id>,<matrix_hash>. It is
    // exposed as capabilities.compat, a summary only; the full matrix remains in the probe log.
    if(a[0]==='COMPAT'){
      if(a.length!==PROTOCOL_SCENE.rows.COMPAT.fields||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(a[1])||!/^(?:[0-9A-Fa-f]{8}|unknown)$/.test(a[2]))throw Error('Invalid scene compatibility handshake');
      capabilities.compat={profile_id:a[1],matrix_hash:a[2],at:Date.now()};continue;}
    if(a[0]==='BRIDGE_ERROR'){throw Error('Scene execution failed');}
    if(a[0]==='MOVER'||a[0]==='MOVER_END'||a[0]==='MOVER_FAIL'){
      if(!moverJob||Number(a[1])!==moverJob.id)continue;
      if(a[0]==='MOVER'){
        if(a.length!==PROTOCOL_SCENE.rows.MOVER.fields||Number(a[2])!==moverJob.movers.length||moverJob.movers.length>=MOVER_LIMIT
          ||!['unit','static'].includes(a[3])||a.slice(4).some(v=>v===''||!Number.isFinite(Number(v))))throw Error('Invalid mover report');
        const v=a.slice(4).map(Number);
        moverJob.movers.push({kind:a[3],pos:v.slice(0,3),v:v.slice(3,6)});
      }else if(a[0]==='MOVER_END'){
        if(a.length!==PROTOCOL_SCENE.rows.MOVER_END.fields||a.slice(2,5).some(v=>!/^\d+$/.test(v))||Number(a[2])!==moverJob.movers.length)throw Error('Incomplete mover response');
        moverJob.visited=Number(a[3]);
        if(a[5]==='world.searchObjects'){moverJob.complete=true;settleMover('completed');}
        else settleMover(a[5]==='query_failed'?'mover query failed':'mission sampler has no mover query');
      }else settleMover(a[2]||'mover query failed');
      continue;}
    if(!job||Number(a[1])!==job.id)continue;
    if(a[0]==='FAIL'){settle(a[2]||'scene query failed');continue;}
    if(a[0]==='SURFACE'){if(a.length!==PROTOCOL_SCENE.rows.SURFACE.fields||Number(a[2])!==job.surfaces.length||job.surfaces.length>=job.n**2||!['1','2','3','4','5'].includes(a[3]))throw Error('Invalid scene surface sequence');job.surfaces.push(surfaceName(a[3]));}
    else if(a[0]==='OBJECT'){
      if(a.length!==PROTOCOL_SCENE.rows.OBJECT.fields||Number(a[2])!==job.objects.length||job.objects.length>=PROTOCOL_SCENE.object_max||a.slice(4).some(v=>v===''||!Number.isFinite(Number(v))))throw Error('Invalid scene object');
      const v=a.slice(4).map(Number),o={kind:a[3],pos:v.slice(0,3),axes:[v.slice(3,6),v.slice(6,9),v.slice(9,12)],min:v.slice(12,15),max:v.slice(15,18)};
      validateExtras({objects:[o]});job.objects.push(o);
    }else if(a[0]==='SCENE_END'){
      if(a.length!==PROTOCOL_SCENE.rows.SCENE_END.fields||job.surfaces.length!==job.n**2||Number(a[2])!==job.objects.length||a.slice(2,5).some(v=>!/^\d+$/.test(v))||!['world.searchObjects','unavailable','query_failed'].includes(a[5]))throw Error('Incomplete scene response');
      job.complete=true;job.skipped=Number(a[3]);job.moving=Number(a[4]);job.objectProvider=a[5];if(job.resolve)settle('completed');
    }
   }}catch(e){capabilities.error=e.message;settle(e.message);settleMover(e.message);c.destroy();}
  });
  c.on('error',()=>{});
  c.on('close',()=>{if(socket===c){socket=null;Object.assign(capabilities,{connected:false,surface:'unavailable',objects:'unavailable',movers:'unavailable',provider:'unavailable',compat:null});
   settle('scene hook disconnected');settleMover('scene hook disconnected');}});
 });
 const started=new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,PROTOCOL.host,()=>resolve(server.address().port));});
 function request(scene){settle('superseded');if(!socket||socket.destroyed||capabilities.surface!=='land.getSurfaceType')return;
  job={id:scene.id,n:scene.n,surfaces:[],objects:[],complete:false};
  try{socket.write(`SCENE,${scene.id},${scene.center[0].toFixed(9)},${scene.center[2].toFixed(9)},${scene.bearing.toFixed(12)},${scene.size},${scene.n}\n`);}
  catch(e){settle('scene hook disconnected');}
 }
 function finish(scene){
  if(!job||job.id!==scene.id)return Promise.resolve({scene_data:{surface_provider:scene.surface_provider||'unavailable',object_provider:'unavailable',bridge:capabilities.provider,note:capabilities.error||'mission bridge unavailable'}});
  return new Promise(resolve=>{job.resolve=resolve;if(job.complete)settle('completed');else job.timer=setTimeout(()=>{socket?.write('CANCEL\n');settle('scene response timed out; Export-only input retained');},PROTOCOL.timeouts.scene_response_timeout_ms);});
 }
 function cancel(){socket?.write('CANCEL\n');settle('cancelled');}
 async function close(){cancel();settleMover('scene hook closed');socket?.destroy();await new Promise(r=>server.close(r));}
 return {started,capabilities,request,finish,cancel,movers,close,MOVER_TIMEOUT_MS,MOVER_LIMIT};
}
module.exports={createBridge,MOVER_TIMEOUT_MS,MOVER_LIMIT,MOVER_RADIUS_MAX};

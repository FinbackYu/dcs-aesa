'use strict';
// Optional development hook. Does not grant unsafe APIs or alter mission sandboxing.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const common=require('./install_common.cjs');
const {hash,backup,transaction,syntax}=common;
const runtime=require('./build_runtime.cjs');
function buildScene(){
 const hook=runtime.build('sar_scene_hook'),mission=runtime.build('sar_mission');
 return {payload:Buffer.from(hook.text),mission:mission.text,
  sources:[...new Set([...Object.keys(hook.hashes),...Object.keys(mission.hashes)])]};
}
function bundle(){return buildScene().payload;}
function paths(root){return {script:path.join(root,'Scripts/Hooks/aesa_sar_scene_hook.lua'),manifest:path.join(root,'Scripts/AESA-SAR/scene-manifest.json')};}
function deploy(root,action,{lua=process.env.AESA_LUA||'lua',running}={}){
 root=common.requireDirectory(root);
 const p=paths(root),m=fs.existsSync(p.manifest)?JSON.parse(fs.readFileSync(p.manifest,'utf8')):null;
 if(m&&(m.schema!==1||m.product!=='aesa-sar-scene-hook'||!/^[a-f0-9]{64}$/.test(m.script_hash)))throw Error('Invalid scene manifest');
 if(fs.existsSync(p.script)&&(!m||hash(fs.readFileSync(p.script))!==m.script_hash))throw Error('Unknown or modified scene hook; no overwrite/removal');
 if(action==='uninstall'){common.ensureDcsClosed({running});if(!m&&!fs.existsSync(p.script))return p;for(const f of Object.values(p))backup(f);transaction([[p.script,null],[p.manifest,null]]);return p;}
 const built=buildScene(),payload=built.payload;
 if(['verify','status'].includes(action)){if(!m||!fs.existsSync(p.script)||hash(payload)!==m.script_hash)throw Error('Scene hook absent or differs from current source');return p;}
 if(!['install','repair'].includes(action))throw Error('Unknown action');
 common.ensureDcsClosed({running});
 // Compile the generated file, not only the source template. Check before target mutations.
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aesa-scene-syntax-'));
 try{const file=path.join(dir,'hook.lua'),missionFile=path.join(dir,'mission.lua');fs.writeFileSync(file,payload);fs.writeFileSync(missionFile,built.mission);syntax(lua,file);syntax(lua,missionFile);}finally{fs.rmSync(dir,{recursive:true,force:true});}
 const record={schema:1,product:'aesa-sar-scene-hook',script_hash:hash(payload),revision:hash(payload),
  sources:built.sources,files:['Scripts/Hooks/aesa_sar_scene_hook.lua','Scripts/AESA-SAR/scene-manifest.json']};
 for(const f of Object.values(p))backup(f);
 transaction([[p.script,payload],[p.manifest,Buffer.from(JSON.stringify(record,null,2)+'\n')]]);return deploy(root,'verify',{lua});
}
module.exports={bundle,paths,deploy};
if(require.main===module){const args=process.argv.slice(2),action=args.shift()||'status';let root,options={};try{while(args.length){const key=args.shift(),value=args.shift();if(!value||!['--saved-games','--lua'].includes(key))throw Error('Expected --saved-games <directory> [--lua <Lua 5.1>]');if(key==='--saved-games')root=value;else options.lua=value;}if(!root)throw Error('--saved-games required');deploy(root,action,options);console.log('Scene hook '+action+' complete. Restart DCS to reload Hooks.');}catch(e){console.error(e.message);process.exitCode=1;}}

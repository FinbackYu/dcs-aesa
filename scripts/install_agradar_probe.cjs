'use strict';
// AESA AGR probe deployment (development-only, Saved Games side).
// Installs the Hooks loader and the native surface-mask probe DLL. No writes
// to the DCS install directory. Backup suffix is .bak-aesa-agr (not the SAR
// suffix; the fire-control installer's reuse of .bak-aesa-sar is a known
// historical issue and is deliberately not copied here).
const fs=require('node:fs'),path=require('node:path');
const common=require('./install_common.cjs');
const {hash,transaction,syntax}=common;
const base=path.join(__dirname,'..');
const HOOK=path.join(base,'dist','dev','aesa_agradar_hook.lua');
const DLL=path.join(base,'dist','dev','aesa_agradar.dll');
const BUNDLE_HINT='Runtime bundle not built; run node scripts/build_runtime.cjs agradar_hook first';
const PRODUCT='aesa-agradar-probe';
const BAK=common.BACKUP_SUFFIX;

function paths(root){return {
  hook:path.join(root,'Scripts/Hooks/aesa_agradar_hook.lua'),
  dll:path.join(root,'Scripts/AESA-AGR/aesa_agradar.dll'),
  manifest:path.join(root,'Scripts/AESA-AGR/agr-manifest.json')};}

const read=common.read;
const backup=common.backup;
const dcsRunning=common.dcsProcesses;
const manifest=(p)=>common.manifest(p,{product:PRODUCT,hashes:['hook_hash','dll_hash']});
const owned=(p,m,key,label)=>common.owned(p,m&&m[key],label);

function deploy(root,action,{lua=process.env.AESA_LUA||'lua',running}={}){
  root=common.requireDirectory(root);
  const p=paths(root);

  if(action==='status'){
    const m=manifest(p.manifest);
    const hook=read(p.hook),dll=read(p.dll);
    const installed=!!(m&&hook&&dll);
    const verified=installed&&hash(hook)===m.hook_hash&&hash(dll)===m.dll_hash;
    const source_hook=read(HOOK),source_dll=read(DLL);
    const current=!!(source_hook&&source_dll&&m&&hash(source_hook)===m.hook_hash&&hash(source_dll)===m.dll_hash);
    return {paths:p,installed,verified,current};
  }

  const m=manifest(p.manifest);
  owned(p.hook,m,'hook_hash','AGR hook');
  owned(p.dll,m,'dll_hash','AGR DLL');

  if(action==='uninstall'){
    if(!m&&!fs.existsSync(p.hook)&&!fs.existsSync(p.dll))return {paths:p,installed:false};
    common.ensureDcsClosed({running});
    for(const f of [p.hook,p.dll,p.manifest])if(fs.existsSync(f))backup(f);
    transaction([[p.hook,null],[p.dll,null],[p.manifest,null]]);
    return {paths:p,installed:false};
  }

  if(!fs.existsSync(HOOK))throw Error(BUNDLE_HINT);
  const hook=fs.readFileSync(HOOK);
  if(!fs.existsSync(DLL))throw Error('Probe DLL not built; run node scripts/build_agradar_probe.cjs first');
  const dll=fs.readFileSync(DLL);

  if(action==='verify'){
    if(!m||!fs.existsSync(p.hook)||!fs.existsSync(p.dll))throw Error('AGR probe is not installed');
    if(hash(hook)!==m.hook_hash||hash(dll)!==m.dll_hash)
      throw Error('AGR probe differs from current sources/build; run repair');
    if(hash(fs.readFileSync(p.hook))!==m.hook_hash||hash(fs.readFileSync(p.dll))!==m.dll_hash)
      throw Error('AGR probe files differ from manifest; run repair');
    return {paths:p,installed:true,verified:true};
  }

  if(!['install','repair'].includes(action))throw Error('Unknown action');
  common.ensureDcsClosed({running});
  syntax(lua,HOOK);

  const record={schema:1,product:PRODUCT,hook_hash:hash(hook),dll_hash:hash(dll),
    sources:['dist/dev/aesa_agradar_hook.lua (built from src/hooks/aesa_agradar_hook.lua)',
             'dist/dev/aesa_agradar.dll (built from src/native/agradar_probe/aesa_agradar.c)'],
    files:['Scripts/Hooks/aesa_agradar_hook.lua',
           'Scripts/AESA-AGR/aesa_agradar.dll',
           'Scripts/AESA-AGR/agr-manifest.json']};

  for(const f of [p.hook,p.dll,p.manifest])if(fs.existsSync(f))backup(f);
  // DLL first: it is the file a running DCS locks, so it is the write most
  // likely to fail; failing here leaves hook+manifest untouched.
  transaction([[p.dll,dll],[p.hook,hook],
    [p.manifest,Buffer.from(JSON.stringify(record,null,2)+'\n')]]);
  return deploy(root,'verify',{lua});
}

module.exports={deploy,paths,PRODUCT,BAK};
if(require.main===module){
  const args=process.argv.slice(2),action=args.shift()||'status';let root,options={};
  try{
    while(args.length){const key=args.shift(),value=args.shift();
      if(!value||!['--saved-games','--lua'].includes(key))
        throw Error('Usage: install_agradar_probe.cjs install|repair|uninstall|verify|status --saved-games <directory> [--lua <Lua 5.1 executable>]');
      if(key==='--saved-games')root=value;else options.lua=value;}
    if(!root)throw Error('--saved-games required');
    const result=deploy(root,action,options);
    if(action==='status'){
      console.log(JSON.stringify(result,null,2));
    }else{
      console.log('AGR probe '+action+' complete.');
      if(action==='install'||action==='repair')console.log('Restart DCS to reload Hooks; the DLL is loaded by Scripts/Hooks/aesa_agradar_hook.lua.');
    }
  }catch(e){console.error(e.message);process.exitCode=1;}
}

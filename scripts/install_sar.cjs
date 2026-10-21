'use strict';
// Development-only deployment; independent manifest and marker from A/A Export.
// The deployed file is the one-file runtime bundle built by build_runtime.cjs,
// not the source entry: the bundle carries the API adapters as local functions
// and publishes AESA_RUNTIME before the consumer runs.
const fs=require('node:fs'),path=require('node:path');
const {write:buildRuntime,build:buildText}=require('./build_runtime.cjs');
const common=require('./install_common.cjs');
const SOURCE=path.join(__dirname,'..','dist','dev','aesa_sar_export.lua');
const SOURCE_NAME='dist/dev/aesa_sar_export.lua';
const BEGIN='--[[ AESA SAR BEGIN ]]',END='--[[ AESA SAR END ]]';
const BLOCK=`${BEGIN}\ndo\n    local ok, err = pcall(dofile, lfs.writedir() .. [[Scripts\\AESA-SAR\\aesa_sar_export.lua]])\n    if not ok then\n        pcall(function()\n            local file = io.open(lfs.writedir() .. [[Scripts\\AESA-SAR\\export_diag.log]], "a")\n            if file then file:write("SAR loader error: " .. tostring(err) .. "\\n") file:close() end\n        end)\n        if log and log.write then log.write("AESA-SAR", log.ERROR, tostring(err)) end\n    end\nend\n${END}`;
const hash=common.hash;
const read=common.read;
function paths(root){const dir=path.join(root,'Scripts');return {export:path.join(dir,'Export.lua'),script:path.join(dir,'AESA-SAR','aesa_sar_export.lua'),manifest:path.join(dir,'AESA-SAR','manifest.json')};}
function span(raw){
  const s=raw.toString('latin1'),count=m=>s.split(m).length-1;
  if(!count(BEGIN)&&!count(END))return null;
  if(count(BEGIN)!==1||count(END)!==1)throw Error('Incomplete or duplicated SAR markers; preserve files and inspect backups');
  const b=s.indexOf(BEGIN),e=s.indexOf(END);
  if(b>=e||b>0&&s[b-1]!=='\n'||e>0&&s[e-1]!=='\n'||!['\r','\n',''].includes(s[b+BEGIN.length]||'')||!['\r','\n',''].includes(s[e+END.length]||''))throw Error('Invalid SAR marker lines');
  let finish=e+END.length;if(s[finish]==='\r')finish++;if(s[finish]==='\n')finish++;
  return [b,finish];
}
function manifest(p){
  if(!fs.existsSync(p))return null;const m=JSON.parse(fs.readFileSync(p,'utf8'));
  if(m.product!=='aesa-sar-export'||m.schema!==1||!/^[a-f0-9]{64}$/.test(m.script_hash)||!/^[a-f0-9]{64}$/.test(m.export_hash)
    ||typeof m.export_existed!=='boolean'||typeof m.export_before!=='string'||typeof m.append_separator!=='string'
    ||Buffer.from(m.export_before,'base64').toString('base64')!==m.export_before
    ||Buffer.from(m.append_separator,'base64').toString('base64')!==m.append_separator)throw Error('Invalid SAR manifest; no files changed');
  return m;
}
function owned(p,m){if(fs.existsSync(p)&&(!m||hash(fs.readFileSync(p))!==m.script_hash))throw Error('Unknown or modified SAR script; refusing overwrite/removal');}
const backup=common.backup, transaction=common.transaction, syntax=common.syntax;
function strip(raw,s,m){
  if(!s)return raw;let [b,e]=s;
  if(m){const before=Buffer.from(m.export_before,'base64'),sep=Buffer.from(m.append_separator,'base64');
    // Keep a separator if another tool has appended code after our loader.
    if(e===raw.length&&raw.subarray(0,b).equals(Buffer.concat([before,sep])))b-=sep.length;}
  return Buffer.concat([raw.subarray(0,b),raw.subarray(e)]);
}
function bundle(){
  const built=buildRuntime('sar_export');
  if(built.lua.checked&&!built.lua.ok)throw Error(`Runtime bundle build failed: ${built.lua.reason}`);
  if(!fs.existsSync(SOURCE))throw Error('Runtime bundle missing after build');
  return SOURCE;
}
function deploy(root,action,{lua=process.env.AESA_LUA||'lua',source=SOURCE,running}={}){
  root=common.requireDirectory(root);
  const p=paths(root),raw=read(p.export)||Buffer.alloc(0),s=span(raw),m=manifest(p.manifest);owned(p.script,m);
  if(s&&!m)throw Error('SAR block without manifest; preserve files and inspect backups');
  if(raw.includes(0))throw Error('Export.lua appears UTF-16/binary; no files changed');
  if(['verify','status'].includes(action)){
    if(!m||!fs.existsSync(p.script)||!s)throw Error('SAR addon is not installed');
    // Verify against the current sources, not a possibly stale dist file: the
    // bundle text is rebuilt in memory and includes adapter/profile changes.
    const current=source===SOURCE?buildText('sar_export').text:fs.readFileSync(source);
    if(hash(fs.readFileSync(p.script))!==hash(current))throw Error('SAR script differs from current development source');
    if(raw.subarray(s[0],s[1]).toString().replace(/\r\n/g,'\n').trimEnd()!==BLOCK)throw Error('SAR loader differs; run repair');
    return p;
  }
  if(action==='uninstall'){
    common.ensureDcsClosed({running});
    if(!m&&!s&&!fs.existsSync(p.script))return p;
    const pristine=m&&hash(raw)===m.export_hash;
    const baseline=pristine?Buffer.from(m.export_before,'base64'):strip(raw,s,m);
    for(const file of Object.values(p))backup(file);
    transaction([[p.export,pristine&&!m.export_existed?null:baseline],[p.script,null],[p.manifest,null]]);return p;
  }
  if(!['install','repair'].includes(action))throw Error('Unknown action');
  common.ensureDcsClosed({running});
  const built=source===SOURCE?bundle():source;
  syntax(lua,built);const payload=fs.readFileSync(built);
  const pristine=m&&hash(raw)===m.export_hash;
  const baseline=pristine?Buffer.from(m.export_before,'base64'):strip(raw,s,m);
  const nl=baseline.includes(Buffer.from('\r\n'))?'\r\n':'\n';
  const sep=baseline.length?(baseline.at(-1)===10?nl:nl+nl):'';
  const updated=Buffer.concat([baseline,Buffer.from(sep+BLOCK.replace(/\n/g,nl)+nl)]);
  const record={product:'aesa-sar-export',schema:1,source:SOURCE_NAME,revision:hash(payload),
    script_hash:hash(payload),export_hash:hash(updated),export_existed:pristine?m.export_existed:fs.existsSync(p.export),
    export_before:baseline.toString('base64'),append_separator:Buffer.from(sep).toString('base64'),
    files:['Scripts/Export.lua','Scripts/AESA-SAR/aesa_sar_export.lua','Scripts/AESA-SAR/manifest.json']};
  for(const file of Object.values(p))backup(file);
  transaction([[p.script,payload],[p.export,updated],[p.manifest,Buffer.from(JSON.stringify(record,null,2)+'\n')]]);
  return deploy(root,'verify',{lua,source});
}
module.exports={deploy,paths,span,BLOCK,SOURCE,SOURCE_NAME};
if(require.main===module){
  const args=process.argv.slice(2),action=args.shift()||'status';let root,options={};
  while(args.length){const key=args.shift(),value=args.shift();if(!value||!['--saved-games','--lua'].includes(key))throw Error('Usage: install_sar.cjs install|repair|uninstall|verify|status --saved-games <directory> [--lua <Lua 5.1 executable>]');if(key==='--saved-games')root=value;else options.lua=value;}
  try{if(!root)throw Error('--saved-games is required (no implicit target selection)');console.log(`${action}: ${path.resolve(root)}`);deploy(root,action,options);console.log('Complete; other Export content preserved.');}catch(e){console.error(e.message);process.exitCode=1;}
}

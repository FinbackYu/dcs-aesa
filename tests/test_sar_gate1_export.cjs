'use strict';
// Gate 1 contract test: the SAR Export's MAP surface/geometry lines must be accepted by the real
// consumer parser in src/sar_core/map.cjs. The Lua sampler is driven through luae.exe because the
// vocabulary and the grid marker live in src/export/sar_protocol.lua; the Collector is the same
// class the live service uses, so this is an export -> service round-trip, not a second spec.
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {Collector}=require('../tools/sar_live.cjs');
// Same Lua detection as the Gate runner: explicit env first, then the standard DCS installs.
const {resolveDcsBin,resolveLua}=require('../scripts/test_all.cjs');
const ROOT=path.join(__dirname,'..');
const LUA=resolveLua(resolveDcsBin(process.env),process.env).path;

// Three jobs in one interpreter run:
//   101 - a 4x4 lattice whose cells carry each engine class exactly once (round-trip);
//   102 - a 2x2 lattice where every cell carries the union of all 16 classes (worst case);
//   103 - a 2x2 lattice with the explicit grid marker and known world coordinates (no transpose).
const LUA_HARNESS=`
AESA_SAR = {
  api = dofile("src/adapters/dcs/api/export.lua"),
  socket = dofile("src/adapters/dcs/api/socket.lua"),
  native = dofile("src/adapters/dcs/api/native.lua"),
  profile = dofile("src/adapters/dcs/compat/profile.lua"),
  profile_data = dofile("src/adapters/dcs/compat/profiles/dcs-2.9.30.28738-mt.lua"),
  protocol = dofile("src/export/sar_protocol.lua"),
  dcs_env = dofile("src/export/sar_dcs_env.lua"),
  collector = dofile("src/export/sar_collector.lua"),
  transport = dofile("src/export/sar_transport.lua"),
}
AESA_RUNTIME = { native = AESA_SAR.native }
local M = dofile("src/export/aesa_sar_export.lua")
local EXPORTS = AESA_SAR.profile_data.native.agradar.exports
local function emit(job)
  local out = {}
  package.loadlib = function(path, name)
    if name == "aesa_agradar_surface_names" then
      return function(x, z)
        local col = math.floor((x - job.x0) / job.step + 0.5)
        local row = math.floor((z - job.z0) / job.step + 0.5)
        return job.names[row * job.cols + col + 1] or job.names[1]
      end
    elseif name == "aesa_agradar_surface_mask" then
      return function() return 1 end
    elseif name == "aesa_agradar_profile_check" then
      return function() return 1 end
    elseif name == "aesa_agradar_init" then
      return function() end
    elseif name == "aesa_agradar_version" then
      return function() return "test" end
    elseif name == "aesa_agradar_poll" or name == "aesa_agradar_shutdown" then
      return function() end
    end
    return nil, "symbol not found"
  end
  local state = M.new(function(line) out[#out + 1] = line end, {
    self = function() return {Position = {x = 0, y = 4000, z = 0}} end,
    velocity = function() return {x = 250, y = 0, z = 0} end,
    height = function() return 100 end,
    surface = function() return "land" end,
    writedir = function() return "X:/Saved Games/DCS/" end,
    agradar_exports = EXPORTS,
    native_load = function(path, symbols) return AESA_SAR.native.new(_G):load(path, symbols) end,
  })
  state.command("SURFACE_FINE")
  state.command(string.format("CAPTURE_MAP,%d,%d,%d,%d,%d,%d", job.id, job.x0, job.z0, job.cols, job.rows, job.step))
  state.tick(0)
  for _, line in ipairs(out) do io.write(line, "\\n") end
end
emit({id = 101, x0 = 0, z0 = 0, cols = 4, rows = 4, step = 250, names = {
  "Land", "Runway", "Sea", "River", "Lake", "Road", "Railway", "Town",
  "Field", "Beach", "Building", "Construction", "Trees", "Forest", "Traffic", "ParticleEffect" }})
emit({id = 102, x0 = 0, z0 = 0, cols = 2, rows = 2, step = 250, names = {
  "Land,Runway,Sea,River,Lake,Road,Railway,Town,Field,Beach,Building,Construction,Trees,Forest,Traffic,ParticleEffect" }})
emit({id = 103, x0 = 1000, z0 = 2000, cols = 2, rows = 2, step = 250, names = {"Land"}})
`;
const ENGINE_CLASSES=['land','runway','sea','river','lake','road','railway','town','field','beach','building','construction','trees','forest','traffic','particle_effect'];

function luaLines(){
  assert.ok(LUA,'DCS Lua 5.1 (luae.exe) is required for the Export contract test; set AESA_LUA or AESA_DCS_BIN');
  const result=spawnSync(LUA,['-e',LUA_HARNESS],{cwd:ROOT,encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,`luae.exe failed: ${result.stderr||result.stdout}`);
  return result.stdout.split(/\r?\n/).filter(Boolean);
}
function jobs(lines){
  const out=new Map();
  for(const line of lines){
    const match=/^MAP[A-Z]+,(\d+),/.exec(line);
    if(!match)continue;
    const id=Number(match[1]);
    if(!out.has(id))out.set(id,[]);
    out.get(id).push(line);
  }
  return out;
}
// Feed the Export's own lines to a fresh Collector. The service hands out its own job id through
// startMap(), so the id field is rewritten in place; everything else travels verbatim.
function collect(lines){
  const begin=lines.find(line=>line.startsWith('MAPBEGIN,'));
  assert.ok(begin,'job has no MAPBEGIN');
  const fields=begin.split(',');
  const collector=new Collector();
  collector.startMap({x0:Number(fields[2]),z0:Number(fields[3]),cols:Number(fields[4]),rows:Number(fields[5]),step:Number(fields[6])});
  const id=collector.map.id;
  let completed=null;
  for(const line of lines){
    const rewritten=line.replace(/^(MAP[A-Z]+),\d+,/,`$1,${id},`);
    completed=collector.accept(rewritten)||completed;
  }
  return {collector,completed};
}
function oneCell(token){
  const collector=new Collector();
  collector.startMap({x0:0,z0:0,cols:1,rows:1,step:250});
  const id=collector.map.id;
  let completed=null;
  for(const line of [`MAPBEGIN,${id},0,0,1,1,250`,`MAPHEIGHT,${id},0,0,0,100,0`,`MAPSURFACE,${id},0,0,${token}`,`MAPEND,${id},1,1`]){
    completed=collector.accept(line)||completed;
  }
  return completed;
}

test('every engine surface class round-trips through the real MAPSURFACE parser',()=>{
  const {completed}=collect(jobs(luaLines()).get(101));
  assert.ok(completed,'the 4x4 class job did not complete');
  assert.deepEqual(completed.surfaces.map(entry=>entry.name),ENGINE_CLASSES,
    'one class per cell, including ParticleEffect, must survive Export -> service');
});

test('the 16-class union stays inside the consumer field limit and keeps its winner',()=>{
  const lines=jobs(luaLines()).get(102);
  const tokens=lines.filter(line=>line.startsWith('MAPSURFACE,')).map(line=>line.split(',')[4]);
  assert.equal(tokens.length,4,'one surface line per cell');
  for(const token of tokens){
    assert.ok(token.length<=96,`Export emitted a ${token.length}-character MAPSURFACE field; the consumer rejects >96: ${token}`);
  }
  // Pin the consumer boundary itself so the Export cannot drift from an unstated number.
  const atLimit=['a'.repeat(24),'b'.repeat(24),'c'.repeat(24),'d'.repeat(21)].join('+');
  const overLimit=['a'.repeat(24),'b'.repeat(24),'c'.repeat(24),'d'.repeat(22)].join('+');
  assert.equal(atLimit.length,96);
  assert.ok(oneCell(atLimit),'a 96-character field is accepted');
  assert.throws(()=>oneCell(overLimit),/Invalid MAPSURFACE/,'the service rejects a 97-character field');
  const {completed}=collect(lines);
  assert.ok(completed,'the all-class union did not complete');
  assert.deepEqual(completed.surfaces.map(entry=>entry.name),['building','building','building','building'],
    'truncation must keep the radar-significance winner (Building)');
});

test('MAP grid marker is additive and cells keep col->+x, row->+z',()=>{
  const lines=jobs(luaLines()).get(103);
  assert.ok(lines.includes('MAPGRID,103,col_x_row_z'),'the Export must declare its grid layout explicitly');
  const {completed}=collect(lines);
  assert.ok(completed,'the grid job did not complete with the marker present');
  const cells=new Map(completed.cells.map(cell=>[`${cell.col},${cell.row}`,cell]));
  for(const cell of completed.cells){
    assert.equal(cell.x,1000+cell.col*250,`x = x0 + col*step for (${cell.col},${cell.row})`);
    assert.equal(cell.z,2000+cell.row*250,`z = z0 + row*step for (${cell.col},${cell.row})`);
  }
  assert.deepEqual([cells.get('1,0').x,cells.get('1,0').z],[1250,2000],'col runs along +x only');
  assert.deepEqual([cells.get('0,1').x,cells.get('0,1').z],[1000,2250],'row runs along +z only');
  // The marker is optional on the wire: an older Export never sends it, and the deployed service
  // ignores unknown MAP* lines, so both ends must still complete without it.
  const old=lines.filter(line=>!line.startsWith('MAPGRID,'));
  assert.ok(collect(old).completed,'a job without MAPGRID must still complete');
});

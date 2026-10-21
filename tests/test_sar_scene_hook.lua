-- Run against the generated deployment file, including embedded mission source.
local now,callbacks,output=0,nil,''
local connected,first_socket=false,true
local function client()
 local requests={'SCENE,3,10000,10000,0.785398163397,128,17','MOVER,900001,10000,10000,50000'}
 return {settimeout=function() end,connect=function() connected=true return true end,close=function() connected=false end,
  receive=function() local line=table.remove(requests,1) if line then return line end return nil,'timeout','' end,
  send=function(_,text) local n=math.min(#text,257) output=output..string.sub(text,1,n) if n<#text then return nil,'timeout',n end return n end}
end
local real_require=require
require=function(name)
 if name=='socket' then if first_socket then first_socket=false error('not on initial path') end return {tcp=client} end
 if name=='lfs' then return {currentdir=function() return '' end} end
 return real_require(name)
end
DCS={getModelTime=function() return now end,setUserCallbacks=function(c) callbacks=c end}
local mission={math=math,string=string,table=table,pcall=pcall,ipairs=ipairs,pairs=pairs,type=type,tostring=tostring,tonumber=tonumber,assert=assert,setmetatable=setmetatable,error=error,
 land={getSurfaceType=function() return 5 end},Object={Category={SCENERY=1,STATIC=2,UNIT=3}},
 world={VolumeType={BOX=1},searchObjects=function(category,_,callback)
   if category==3 then callback({inAir=function() return false end,getVelocity=function() return {x=0,y=0,z=15} end,
     getPosition=function() return {p={x=12000,y=60,z=9000}} end}) end end}}
mission._G=mission
mission.loadstring=function(code) return setfenv(assert(loadstring(code)),mission) end
a_do_script=function(code) return mission.loadstring(code)() end
net={dostring_in=function() error('existing permissions rejected') end}
dofile(arg[1]) callbacks.onSimulationStart()
for i=1,100 do now=i/60 callbacks.onSimulationFrame() end
assert(string.find(output,'HELLO,SARSCENE1\nCOMPAT,dcs-2.9.30.28738-mt,0982a986\nCAP,land.getSurfaceType,world.searchObjects,world.searchObjects,a_do_script\n',1,true))
assert(string.find(output,'SURFACE,3,288,5\n') and string.find(output,'SCENE_END,3,0,0,1,world.searchObjects\n'))
-- The mover query rides the same bridge: it starts beside the scene job and reports one unit.
assert(string.find(output,'MOVER,900001,0,unit,12000.000000000,60.000000000,9000.000000000,0.000000000,0.000000000,15.000000000\n'))
assert(string.find(output,'MOVER_END,900001,1,1,0,world.searchObjects\n'))
assert(not mission.io and not mission.os and not net.allow_unsafe_api and not net.allow_dostring_in)
callbacks.onSimulationStop() assert(not connected)
-- Two-hop bridge: dostring_in("mission") lands in the mission/network state, a_do_script reaches the scripting state.
output='' now=0 a_do_script=nil
local middle={type=type,a_do_script=function(code) return mission.loadstring(code)() end}
middle.loadstring=function(code) return setfenv(assert(loadstring(code)),middle) end
net={dostring_in=function(state,code) if state=='mission' then return middle.loadstring(code)() end error('rejected') end}
dofile(arg[1]) callbacks.onSimulationStart()
for i=1,100 do now=i/60 callbacks.onSimulationFrame() end
assert(string.find(output,'HELLO,SARSCENE1\nCOMPAT,dcs-2.9.30.28738-mt,0982a986\nCAP,land.getSurfaceType,world.searchObjects,world.searchObjects,net.dostring_in(mission)+a_do_script\n',1,true))
assert(string.find(output,'SURFACE,3,288,5\n') and string.find(output,'SCENE_END,3,0,0,1,world.searchObjects\n'))
assert(string.find(output,'MOVER_END,900001,1,1,0,world.searchObjects\n'))
callbacks.onSimulationStop() assert(not connected)
-- Permission failure reports unavailable rather than changing configuration.
output='' now=0 a_do_script=nil
net={dostring_in=function() error('existing permissions rejected') end}
dofile(arg[1]) callbacks.onSimulationStart()
for i=1,10 do now=i/60 callbacks.onSimulationFrame() end
assert(string.find(output,'HELLO,SARSCENE1\nCOMPAT,dcs-2.9.30.28738-mt,0982a986\nCAP,unavailable,unavailable,unavailable,unavailable\n',1,true))
assert(not net.allow_unsafe_api and not net.allow_dostring_in)
callbacks.onSimulationStop()
print('Generated Hook runtime: source injection, primary bridge, bounded partial socket writes, unavailable permissions and stop PASS')

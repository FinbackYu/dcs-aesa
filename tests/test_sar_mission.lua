local count=0
land={getSurfaceType=function(p) count=count+1 assert(type(p.x)=='number' and type(p.y)=='number' and not p.z) return p.x<0 and 1 or 5 end}
Object={Category={SCENERY=1,STATIC=2,UNIT=3}}
local visited=0
local good={getPosition=function() return {p={x=5,y=100,z=5},x={x=1,y=0,z=0},y={x=0,y=1,z=0},z={x=0,y=0,z=1}} end,getDesc=function() return {box={min={x=-5,y=0,z=-5},max={x=5,y=20,z=5}}} end}
world={VolumeType={BOX=1},searchObjects=function(category,volume,callback)
 assert(volume.id==1 and volume.params.min.x<volume.params.max.x)
 if category==1 then callback(good) callback({}) elseif category==3 then callback({getVelocity=function() return {x=10,y=0,z=0} end}) end
 visited=visited+1
end}
local MissionApi=assert(dofile('src/adapters/dcs/api/mission.lua'))
AESA_RUNTIME={mission=MissionApi}
-- The entry reads the mission modules from the table the deployed bundle publishes as
-- AESA_SCENE; here they are the source files themselves. The protocol supplies the patch
-- geometries the scene core validates against.
local protocol=dofile('src/shared/protocol.lua')
local SIZE,N=protocol.sar.default_size_m,protocol.sar.default_n
AESA_SCENE={protocol=dofile('src/export/sar_protocol.lua'),mission_env=dofile('src/scene/sar_mission_env.lua'),core=dofile('src/scene/sar_scene_core.lua')}
local M=dofile('src/scene/aesa_sar_mission.lua')
assert(M.probe()=='CAP,land.getSurfaceType,world.searchObjects,world.searchObjects')
for _,pair in ipairs(protocol.sar.capture.size_n_pairs) do
 local id=pair[2] M.start(id,0,0,0,pair[1],pair[2]) local lines={}
 while M.job do local before=count lines[#lines+1]=M.step() assert(count-before<=protocol.scene.mover_lines_per_step+1) end
 local result=table.concat(lines,'\n') local grids=0 for _ in string.gmatch(result,'SURFACE,') do grids=grids+1 end
 assert(grids==pair[2]^2 and string.find(result,'OBJECT,'..id..',0,scenery,'))
 assert(string.find(result,'SCENE_END,'..id..',1,1,1,world.searchObjects'))
end
-- The adapter returns SCENERY/STATIC/UNIT in order without a per-object kind;
-- boundary probing must label all three groups correctly.
local unit_still={getVelocity=function() return {x=0,y=0,z=0} end,getPosition=good.getPosition,getDesc=good.getDesc}
world.searchObjects=function(category,_,callback)
 if category==1 then callback(good) elseif category==2 then callback(good) elseif category==3 then callback(unit_still) end
end
M.start(60,0,0,0,SIZE,N) local mixed={} while M.job do mixed[#mixed+1]=M.step() end mixed=table.concat(mixed,'\n')
assert(string.find(mixed,'OBJECT,60,0,scenery,',1,true) and string.find(mixed,'OBJECT,60,1,static,',1,true)
    and string.find(mixed,'OBJECT,60,2,unit,',1,true),mixed)
assert(string.find(mixed,'SCENE_END,60,3,0,0,world.searchObjects',1,true),mixed)
world.searchObjects=function(_,_,callback) for i=1,1000 do if callback({})==false then break end end end
M.start(50,0,0,0,SIZE,N) local final while M.job do final=M.step() end assert(string.find(final,'SCENE_END,50,0,512,0,'))
land.getSurfaceType=function() return 0/0 end M.start(51,0,0,0,SIZE,N) assert(M.step()=='FAIL,51,surface_query_failed' and not M.job)
-- Fail closed when the mission environment has no land API: never invent a surface class.
local saved_land=land land=nil
assert(M.probe()=='CAP,unavailable,world.searchObjects,world.searchObjects',M.probe())
M.start(52,0,0,0,SIZE,N) assert(M.step()=='FAIL,52,surface_unavailable' and not M.job)
land=saved_land
print('SAR mission grid, Vec2, bounded object queries, geometry, moving exclusion and surface fail-closed PASS')
-- MOVER 动目标查询：UNIT/STATIC 地面动目标，剔除空中、静止与坏数据，半径/数量/访次上限，分帧节流
function object_fixture(kind,i)
    return {inAir=function() return kind=='air' end,
        getVelocity=function() if kind=='broken' then return nil end
            if kind=='still' then return {x=0,y=0,z=0} end
            return {x=12+i,y=0,z=-3} end,
        getPosition=function() return {p={x=1000+i,y=60,z=-2000+i}} end}
end
assert(M.probe()=='CAP,land.getSurfaceType,world.searchObjects,world.searchObjects',M.probe())
assert(M.mover(900,0,0,60000)=='ERROR,invalid_request' and not M.mover_job,'半径超上限应拒绝')
assert(M.mover(900,0,0,999)=='ERROR,invalid_request' and not M.mover_job,'半径低于下限应拒绝')
world.searchObjects=function(category,volume,callback)
    assert(volume.id==1 and volume.params.max.x-volume.params.min.x==100000 and volume.params.max.z-volume.params.min.z==100000)
    if category==Object.Category.UNIT then
        for i=1,3 do callback(object_fixture('move',i)) end
        callback(object_fixture('air',4)) callback(object_fixture('still',5)) callback(object_fixture('broken',6))
    elseif category==Object.Category.STATIC then callback(object_fixture('move',7)) end
end
assert(M.mover(901,0,0,50000)=='CAP,world.searchObjects')
local chunks={} while M.mover_job do chunks[#chunks+1]=M.mover_step() end
assert(#chunks==1,'4 条动目标应一帧送完（每帧 16 行），实得 '..#chunks..' 帧')
local text=chunks[1]
local units,statics=0,0
for line in string.gmatch(text,'[^\n]+') do
    if string.find(line,'^MOVER,901,%d+,unit,') then units=units+1 end
    if string.find(line,'^MOVER,901,%d+,static,') then statics=statics+1 end
end
assert(units==3 and statics==1,'应报告 3 个 unit 与 1 个 static 动目标（得到 '..units..'/'..statics..'）')
assert(string.find(text,'MOVER,901,0,unit,1001.000000000,60.000000000,-1999.000000000,13.000000000,0.000000000,-3.000000000',1,true),text)
assert(string.find(text,'MOVER_END,901,4,7,2,world.searchObjects',1,true),text)
-- 数量上限 64：每帧 16 行 → 4 帧；访次上限 128：全部静止时只报告访次与剔除数
world.searchObjects=function(category,_,callback)
    if category~=Object.Category.UNIT then return end
    for i=1,200 do if callback(object_fixture('move',i))==false then break end end
end
assert(M.mover(902,0,0,50000)=='CAP,world.searchObjects')
local mover_chunks,count=0,0 while M.mover_job do mover_chunks=mover_chunks+1 local t=M.mover_step() local n=0
    for _ in string.gmatch(t,'[^\n]+') do n=n+1 end
    assert(n<=protocol.scene.mover_lines_per_step+1,'每帧最多 16 条加 MOVER_END，实得 '..n)
    for _ in string.gmatch(t,'MOVER,902,') do count=count+1 end end
assert(mover_chunks==4 and count==64,'数量上限 64、每帧 16 条 → 4 帧（得到 '..mover_chunks..' 帧 / '..count..' 条）')
world.searchObjects=function(category,_,callback)
    if category~=Object.Category.UNIT then return end
    for i=1,400 do if callback(object_fixture('still',i))==false then break end end
end
local still='' assert(M.mover(903,0,0,50000)=='CAP,world.searchObjects') while M.mover_job do still=still..M.mover_step()..'\n' end
assert(string.find(still,'MOVER_END,903,0,128,128,world.searchObjects',1,true),still)
-- 模型时间预算：mission 环境给时钟时，扫描超预算即收手并照常结束
local clock=0
timer={getTime=function() clock=clock+.01 return clock end}
world.searchObjects=function(category,_,callback)
    if category~=Object.Category.UNIT then return end
    for i=1,200 do if callback(object_fixture('move',i))==false then break end end
end
local ticked='' assert(M.mover(904,0,0,50000)=='CAP,world.searchObjects') while M.mover_job do ticked=ticked..M.mover_step()..'\n' end
local ticked_count=0 for _ in string.gmatch(ticked,'MOVER,904,') do ticked_count=ticked_count+1 end
assert(ticked_count>0 and ticked_count<64,'时钟推进后应只收集部分动目标（得到 '..ticked_count..'）')
assert(string.find(ticked,'MOVER_END,904,',1,true),ticked)
timer=nil
-- SCENE 与 MOVER 并存：两个作业各自分帧推进，互不改写对方状态
land.getSurfaceType=function() return 5 end
world.searchObjects=function(category,_,callback)
    if category==Object.Category.UNIT then callback(object_fixture('move',1))
    elseif category==Object.Category.STATIC then callback(object_fixture('move',2)) end
end
assert(string.sub(M.start(905,0,0,0,SIZE,N),1,4)=='CAP,')
assert(M.mover(906,0,0,50000)=='CAP,world.searchObjects')
local scene_chunks,mover_frames,scene_end,mover_end=0,0,nil,nil
while not scene_end or not mover_end do
    if not scene_end then scene_chunks=scene_chunks+1 local t=M.step() if string.find(t,'SCENE_END,') then scene_end=t end end
    if not mover_end then mover_frames=mover_frames+1 local t=M.mover_step() if string.find(t,'MOVER_END,') then mover_end=t end end
    assert(scene_chunks<40 and mover_frames<40,'并存时两个作业都应推进')
end
assert(string.find(scene_end,'SCENE_END,905,0,0,2,world.searchObjects',1,true),scene_end)
assert(string.find(mover_end,'MOVER_END,906,2,2,0,world.searchObjects',1,true),mover_end)
assert(not M.job and not M.mover_job and mover_frames==1,'动目标一帧完成，栅格继续到 SCENE_END')
print('SAR mission GMTI mover query, filtering, bounds, throttle and scene coexistence PASS')

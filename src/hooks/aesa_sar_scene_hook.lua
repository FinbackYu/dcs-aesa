-- Generated development hook embeds the project mission sampler at deployment.
-- Game API access is routed through the injected Hook adapter and Socket helper;
-- the mission bundle is executed in the mission/scripting state and uses its own
-- Mission adapter. COMPAT announces the generated compatibility profile.
local runtime=assert(AESA_RUNTIME,"AESA runtime missing")
local hook=runtime.hook.new(_G)
local profile=runtime.profile.new(runtime.profile_data,"generated")
local COMPAT="COMPAT,"..profile:id()..","..profile:matrix_hash()
-- Wire constants come from the generated protocol module injected by
-- build_runtime.cjs; the hook must not carry a second copy of the port or the
-- size/n pairs.
local protocol=assert(SceneProtocol,"scene protocol missing")
local scene_host,scene_port=protocol.host,protocol.ports.sar_scene
local capture_pairs=protocol.sar.capture.size_n_pairs
local function capture_allowed(size,n)
    for _,pair in ipairs(capture_pairs) do
        if size==pair[1] and n==pair[2] then return true end
    end
    return false
end
local SOURCE=__MISSION_SOURCE__
local client,socket_lib,pending,partial,retry,active,mover_active,mover_id,next_probe=nil,nil,"","",-1e9,false,false,nil,0
local invoke,provider=nil,"unavailable"
local last_cap,fallback_time=nil,0
local function diagnostic(message)
    hook:log_write("AESA-SAR-SCENE",tostring(message))
end
local function close() if client then pcall(function() client:close() end) end client=nil pending="" partial="" active=false mover_active=false mover_id=nil end
local function execute(code)
    if not invoke then return nil end
    local ok,value=pcall(invoke,code)
    if ok and type(value)=="string" then return value end
end
local ENV_CODE="return 'ENV,'..type(land)..','..type(world)..','..type(timer)..','..type(a_do_script)"
local function probe()
    invoke=nil provider="unavailable"
    local candidates={}
    -- The Hook adapter has no arbitrary a_do_script executor; the direct channel is
    -- the legacy fallback and is only used when the Hooks state exposes it.
    local direct=hook.env and hook.env.a_do_script
    if type(direct)=="function" then candidates[#candidates+1]={function(code) return direct(code) end,"a_do_script"} end
    candidates[#candidates+1]={function(code) return hook:dostring("scripting",code) end,"net.dostring_in(scripting)"}
    candidates[#candidates+1]={function(code) return hook:dostring("mission","return a_do_script("..string.format("%q",code)..")") end,"net.dostring_in(mission)+a_do_script"}
    candidates[#candidates+1]={function(code) return hook:dostring("mission",code) end,"net.dostring_in(mission)"}
    local report={}
    for _,candidate in ipairs(candidates) do
        invoke=candidate[1]
        local ok,value=pcall(invoke,ENV_CODE)
        report[#report+1]=candidate[2].."="..(ok and tostring(value) or "ERR:"..tostring(value))
        local response=execute("if type(AESA_SAR_SCENE)=='table' and type(AESA_SAR_SCENE.probe)=='function' then return AESA_SAR_SCENE.probe() end local f=assert(loadstring("..string.format("%q",SOURCE).."));f();return AESA_SAR_SCENE.probe()")
        -- The capability string carries surface, objects and movers; the service appends the provider
        -- it used, so accept any candidate whose sampler can resolve the terrain surface.
        local surface=string.match(response or "","^CAP,([^,]*),")
        if surface=="land.getSurfaceType" then
            provider=candidate[2] local detail=response..","..provider.." | "..table.concat(report," | ")
            if last_cap~=detail then diagnostic(detail) last_cap=detail end return response
        end
    end
    invoke=nil local summary=table.concat(report," | ") if summary=="" then summary="no candidates" end
    if last_cap~=summary then diagnostic("probe "..summary) last_cap=summary end return "CAP,unavailable,unavailable,unavailable"
end
local function model_time()
    local value=hook:dcs_model_time()
    if value~=nil then return value end
    fallback_time=fallback_time+1/60
    return fallback_time
end
local function frame()
    local now=model_time()
    if not client then
        if now<retry then return end retry=now+2
        if not socket_lib then socket_lib=runtime.socket.bootstrap(_G) end
        if not socket_lib then return end
        local c=socket_lib.tcp() c:settimeout(.01)
        if not c:connect(scene_host,scene_port) then c:close() return end
        c:settimeout(0) client=c
        pending="HELLO,SARSCENE1\n"..COMPAT.."\n"..probe()..","..provider.."\n"
        next_probe=now+5
    end
    if not active and now>=next_probe then next_probe=now+5 pending=pending..probe()..","..provider.."\n" end
    local line,err,fragment=client:receive("*l",partial) partial=line and "" or (fragment or "")
    if err=="closed" or #partial>256 then close() return end
    if line then
        if line=="CANCEL" then active=false execute("if AESA_SAR_SCENE then AESA_SAR_SCENE.job=nil end return 'CANCELLED'")
        elseif line=="MOVER_CANCEL" then mover_active=false mover_id=nil execute("if AESA_SAR_SCENE then AESA_SAR_SCENE.mover_job=nil end return 'CANCELLED'")
        elseif invoke then
            local id,x,z,b,size,n=string.match(line,"^SCENE,(%d+),([%d%.%-]+),([%d%.%-]+),([%d%.%-]+),(%d+),(%d+)$")
            if id then
                id,x,z,b,size,n=tonumber(id),tonumber(x),tonumber(z),tonumber(b),tonumber(size),tonumber(n)
                if id<=1e9 and x and z and b and math.abs(x)<1e8 and math.abs(z)<1e8 and math.abs(b)<100
                    and capture_allowed(size,n) then
                    local response=execute(string.format("return AESA_SAR_SCENE.start(%d,%.9f,%.9f,%.12f,%d,%d)",id,x,z,b,size,n))
                    active=response and string.sub(response,1,4)=="CAP," or false
                    if not active then pending=pending.."FAIL,"..id..",bridge_start_failed\n" end
                end
            else
                local mid,mx,mz,mr=string.match(line,"^MOVER,(%d+),([%d%.%-]+),([%d%.%-]+),(%d+)$")
                if mid then
                    mid,mx,mz,mr=tonumber(mid),tonumber(mx),tonumber(mz),tonumber(mr)
                    if mid<=1e9 and mx and mz and mr and math.abs(mx)<1e8 and math.abs(mz)<1e8 and mr>=1000 and mr<=50000 then
                        local response=execute(string.format("return AESA_SAR_SCENE.mover(%d,%.9f,%.9f,%d)",mid,mx,mz,mr))
                        mover_active=response and string.sub(response,1,4)=="CAP," or false
                        if mover_active then mover_id=mid else pending=pending.."MOVER_FAIL,"..mid..",bridge_mover_start_failed\n" end
                    else pending=pending.."MOVER_FAIL,"..mid..",invalid_request\n" end
                end
            end
        end
    end
    if active then
        local response=execute("return AESA_SAR_SCENE.step()")
        if not response then active=false pending=pending.."BRIDGE_ERROR\n"
        else pending=pending..response.."\n" if string.find(response,"SCENE_END,") or string.sub(response,1,5)=="FAIL," then active=false end end
    end
    -- The mover query is a second job of the same sampler: it drains beside a scene job and never
    -- interrupts it (the CANCEL above stops the scene only).
    if mover_active then
        local response=execute("return AESA_SAR_SCENE.mover_step()")
        if not response or response=="IDLE" then
            mover_active=false pending=pending.."MOVER_FAIL,"..tostring(mover_id)..",bridge_mover_step_failed\n"
        else
            pending=pending..response.."\n"
            if string.find(response,"MOVER_END,") then mover_active=false mover_id=nil end
        end
    end
    if #pending>65536 then close() return end
    if #pending>0 then local sent,why,last=client:send(pending) pending=string.sub(pending,(sent or last or 0)+1) if why and why~="timeout" then close() end end
end
-- Dev-only, file-gated compatibility probe. The compat directory is absent in
-- normal installs, so this is a no-op unless the one-file probe was deployed.
local function run_compat_probe()
    local base=hook:writedir()
    if type(base)~="string" or base=="" then return end
    if string.sub(base,-1)~="\\" and string.sub(base,-1)~="/" then base=base.."\\" end
    local dir=base.."Scripts\\AESA\\"
    local ok,entry=pcall(dofile,dir.."aesa_compat_probe.lua")
    if ok and type(entry)=="table" and type(entry.run_hook)=="function" then pcall(entry.run_hook,dir) end
end
local callbacks={}
function callbacks.onSimulationFrame() local ok,err=pcall(frame) if not ok then diagnostic(tostring(err)) close() end end
function callbacks.onSimulationStart() run_compat_probe() close() retry=-1e9 end
function callbacks.onSimulationStop() close() end
local ok,why=hook:set_user_callbacks(callbacks)
if not ok then diagnostic("setUserCallbacks: "..tostring(why)) end

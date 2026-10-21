-- AESA fire-control native probe loader (Saved Games side only; no install
-- directory writes) and poll loop.
-- Gate 3: this consumer reaches the engine through AESA_RUNTIME only:
-- runtime.hook for filesystem/loadlib/mission-bridge/log/DCS, runtime.native
-- for the probe DLL exports listed in the generated profile, runtime.profile
-- for the compatibility matrix. It does not require modules or call engine
-- globals directly.
--
-- P3-1 experiment: when a mission containing the trace bandits runs, resolve
-- the designated bandit's engine ObjectID through the Hook adapter. Mode is
-- fail-closed: the default is 0 = read-only trace (no writes at all); only an
-- explicit mode=1 arms forced designation / lead feed. Single-player
-- development only.
local runtime = assert(AESA_RUNTIME, "AESA runtime missing")
local hookapi = runtime.hook.new(_G)
local nativeapi = runtime.native.new(_G)
local profile = runtime.profile.new(runtime.profile_data, "generated")

local product="aesa-fc-probe"
local experiment={bandit_name="FC-TRACE-BANDIT-2", mode=0, deadline=30, retry=2}
local log_ready=hookapi:log_available()~=nil

local function diagnostic(message)
    if not log_ready then return end
    -- Adapter contract: log_write(level, message). Keep the probe tag in the
    -- text so hook diagnostics stay identifiable in dcs.log.
    pcall(hookapi.log_write,hookapi,"INFO","AESA-FC: "..tostring(message))
end

local function base_dir()
    local dir=hookapi:writedir()
    if type(dir)~="string" or dir=="" then return nil end
    if string.sub(dir,-1)~="\\" and string.sub(dir,-1)~="/" then dir=dir.."\\" end
    return dir
end

-- Compatibility handshake line: COMPAT,<profile_id>,<matrix_hash>.
-- Emitted verbatim (no probe prefix) so log parsers see the fixed format.
if log_ready then
    pcall(hookapi.log_write,hookapi,"INFO",
        "COMPAT,"..tostring(profile:id())..","..tostring(profile:matrix_hash()))
end
if profile:is_fallback() then
    diagnostic("profile fallback: "..tostring(profile.fallback_reason or "unknown"))
end

-- per-sortie overrides from Saved Games, rewritten between flights:
-- Scripts\AESA-FC\fc_experiment.lua -> return { mode=0 } for a trace-only
-- native baseline (the default), { mode=1 } to explicitly enable injection.
do
    local base=base_dir()
    if base then
        local path=base.."Scripts\\AESA-FC\\fc_experiment.lua"
        local handle=io.open(path,"r")
        if handle then
            handle:close()
            local chunk,load_err=loadfile(path)
            if chunk then
                local ok,cfg=pcall(chunk)
                if ok and type(cfg)=="table" then
                    for k,v in pairs(cfg) do experiment[k]=v end
                else
                    diagnostic("fc_experiment.lua ignored: "..tostring(cfg))
                end
            else
                diagnostic("fc_experiment.lua load failed: "..tostring(load_err))
            end
        end
    end
end
-- Mission-side trajectory recorder, installed into the mission scripting
-- state once arming succeeds. Uses ONLY public API (world event handler +
-- Weapon/Unit getPosition), replacing the DLL-side GetPosition sampling that
-- crashed the sim on 2026-10-16 (engine virtuals are unsafe on ammunition
-- objects). Samples are buffered mission-side and pulled through the Hook
-- adapter's mission bridge into Logs\AESA\fc_msl_pos.log.
local MSL_RECORDER_SRC=[[
if not aesa_fc_msl then
  aesa_fc_msl = { tracked = {}, buf = {}, cap = 6000,
                  unit_names = { "FC-TRACE-BANDIT-1", "FC-TRACE-BANDIT-2" },
                  shooter_name = nil }
  local msl = aesa_fc_msl
  local function rec(line)
    if #msl.buf < msl.cap then msl.buf[#msl.buf + 1] = line end
  end
  msl.rec = rec
  local function name_of(u)
    if not u then return "-" end
    local ok, n = pcall(function() return u:getName() end)
    if ok and n then return n end
    return "-"
  end
  local function sample_unit(nm, t)
    local ok, line = pcall(function()
      local u = Unit.getByName(nm)
      if not u or not u:isExist() then return nil end
      local p = u:getPosition()
      return string.format("TGT,%.2f,%s,%.1f,%.1f,%.1f", t, nm, p.p.x, p.p.y, p.p.z)
    end)
    if ok and line then rec(line) end
  end
  local function sampler()
    local t = timer.getTime()
    for _, nm in ipairs(msl.unit_names) do sample_unit(nm, t) end
    if msl.shooter_name then sample_unit(msl.shooter_name, t) end
    local keep = {}
    for i = 1, #msl.tracked do
      local w = msl.tracked[i]
      local ok, exists = pcall(function() return w:isExist() end)
      if ok and exists then
        keep[#keep + 1] = w
        local ok2, line = pcall(function()
          local p = w:getPosition()
          local id = w:getObjectID()
          local v = nil
          pcall(function() v = w:getVelocity() end)
          if v then
            return string.format("MSL,%.2f,%s,%.1f,%.1f,%.1f,%.1f,%.1f,%.1f",
              t, tostring(id), p.p.x, p.p.y, p.p.z, v.x, v.y, v.z)
          end
          return string.format("MSL,%.2f,%s,%.1f,%.1f,%.1f",
            t, tostring(id), p.p.x, p.p.y, p.p.z)
        end)
        if ok2 and line then rec(line) end
      end
    end
    msl.tracked = keep
    timer.scheduleFunction(sampler, nil, timer.getTime() + 0.25)
  end
  -- keep a STRONG reference to the handler: an anonymous handler table can be
  -- GC'd (suspected cause of events stopping right after registration).
  msl.ev_handler = {
    onEvent = function(e)
      pcall(function()
        local t = timer.getTime()
        if t <= 0 then return end  -- init-phase spam carries no id; ignore
        local EV = world.event or {}
        local eid = e.id or -1
        if (msl.ev_n or 0) < 120 then
          msl.ev_n = (msl.ev_n or 0) + 1
          rec(string.format("EVT,%.2f,%s,%s,%s", t, tostring(eid),
            e.initiator and "i" or "-", e.weapon and "w" or "-"))
        end
        local SHOT = EV.S_EVENT_SHOT or 1
        local HIT = EV.S_EVENT_HIT or 2
        if eid == SHOT and e.weapon then
          local wid = "?"
          pcall(function() wid = tostring(e.weapon:getObjectID()) end)
          local wt = "?"
          pcall(function() wt = e.weapon:getTypeName() end)
          rec(string.format("SHOT,%.2f,%s,%s,%s", t, name_of(e.initiator), wid, wt))
          msl.tracked[#msl.tracked + 1] = e.weapon
          msl.shooter_name = name_of(e.initiator)
        elseif eid == HIT then
          local wn = "-"
          pcall(function() wn = e.weapon:getTypeName() end)
          rec(string.format("HIT,%.2f,%s,%s,%s", t, name_of(e.initiator), name_of(e.target), wn))
        end
      end)
    end
  }
  world.addEventHandler(msl.ev_handler)
  timer.scheduleFunction(sampler, nil, timer.getTime() + 0.25)
end
function aesa_fc_msl_dump()
  local m = aesa_fc_msl
  if not m or #m.buf == 0 then return "" end
  local s = table.concat(m.buf, "\n") .. "\n"
  m.buf = {}
  return s
end
return "aesa_fc_msl ok"
]]
local init,poll,shutdown,trace_start,trace_stop,arm,disarm,feed_target
local loaded=false
local loaded_kind=nil
local failures=0
local arm_state,arm_next,arm_deadline="idle",0,0
local msl_installed=false
local pull_ctr=0
-- Only an explicit numeric 1 enables write injection. Anything else (including
-- a typo such as mode=2) is coerced to read-only mode 0 and logged.
do
    local raw=experiment.mode
    local mode=tonumber(raw)
    if mode~=0 and mode~=1 then
        diagnostic("invalid experiment.mode="..tostring(raw).."; using 0 (READ-ONLY)")
        mode=0
    end
    experiment.mode=mode
    experiment.deadline=tonumber(experiment.deadline) or 30
    experiment.retry=tonumber(experiment.retry) or 2
    if experiment.retry<=0 then experiment.retry=2 end
    if type(experiment.bandit_name)~="string" or experiment.bandit_name=="" then
        experiment.bandit_name="FC-TRACE-BANDIT-2"
    end
end
local function mode_label() return experiment.mode==1 and "INJECT" or "READ-ONLY" end
local function clear_symbols()
    init,poll,shutdown,trace_start,trace_stop,arm,disarm,feed_target=nil,nil,nil,nil,nil,nil,nil,nil
end

-- Export contract per build: the trace DLL has no write exports at all; the
-- inject DLL is a superset. A profile that only carries the Gate 3 `exports`
-- list is treated as the inject list so an older generated profile still
-- resolves, but the selected build is still trace unless mode=1 passes.
local function exports_for(kind)
    local key=kind=="inject" and "native.fc.inject_exports" or "native.fc.trace_exports"
    local list=profile:get(key)
    if type(list)~="table" or #list==0 then list=profile:get("native.fc.exports") end
    if type(list)~="table" or #list==0 then return nil end
    return list
end

local function dll_path(kind)
    local base=base_dir()
    if not base then return nil end
    local name=kind=="inject" and "aesa_fc_inject.dll" or "aesa_fc_trace.dll"
    return base.."Scripts\\AESA-FC\\"..name
end

local function file_exists(path)
    local handle=io.open(path,"rb")
    if handle then handle:close() return true end
    return false
end

-- Fail-closed write gate: mode=1 is necessary but not sufficient. The inject
-- DLL is only considered when the generated profile is verified for the FC
-- symbols, states that the write path is part of the build, and the DLL and
-- its write exports are actually present. Any failure keeps mode=0/trace.
local function inject_refusal()
    local reasons={}
    if profile:is_fallback() then reasons[#reasons+1]="profile-fallback" end
    local sym=profile:cap("NAT-FC-SYM")
    if sym~="ok" then reasons[#reasons+1]="NAT-FC-SYM="..tostring(sym) end
    if profile:get("native.fc.write")~=true then reasons[#reasons+1]="native.fc.write=false" end
    local exports=exports_for("inject")
    if not exports then
        reasons[#reasons+1]="no inject_exports"
    else
        local names={}
        for _,name in ipairs(exports) do names[name]=true end
        for _,name in ipairs({"aesa_fc_arm","aesa_fc_disarm"}) do
            if not names[name] then reasons[#reasons+1]=name end
        end
        if experiment.feed==1 and not names["aesa_fc_feed_target"] then
            reasons[#reasons+1]="aesa_fc_feed_target"
        end
    end
    local path=dll_path("inject")
    if not path then
        reasons[#reasons+1]="no-writedir"
    elseif not file_exists(path) then
        reasons[#reasons+1]="inject-dll-absent"
    end
    return reasons
end

local function unload_native()
    if trace_stop then pcall(trace_stop) end
    if shutdown then pcall(shutdown) end
    clear_symbols()
    loaded=false
    loaded_kind=nil
end

local function load_native(kind)
    local base=base_dir()
    if not base then diagnostic("no writedir") return false end
    local exports=exports_for(kind)
    if not exports then
        diagnostic("profile has no native.fc exports for "..kind.."; native probe unavailable")
        return false
    end
    local path=dll_path(kind)
    if not path then diagnostic("no writedir") return false end
    local result,why=nativeapi:load(path,exports,{version_symbol="aesa_fc_version"})
    if type(result)~="table" then
        diagnostic(kind.." native load failed: "..tostring(why))
        return false
    end
    if type(result.missing)=="table" and #result.missing>0 then
        diagnostic(kind.." native exports missing: "..table.concat(result.missing,","))
    end
    local got=result.loaded or {}
    init,poll,shutdown=got.aesa_fc_init,got.aesa_fc_poll,got.aesa_fc_shutdown
    trace_start,trace_stop=got.aesa_fc_trace_start,got.aesa_fc_trace_stop
    if kind=="inject" then
        arm,disarm,feed_target=got.aesa_fc_arm,got.aesa_fc_disarm,got.aesa_fc_feed_target
    else
        arm,disarm,feed_target=nil,nil,nil
    end
    if type(init)~="function" or type(poll)~="function" then
        diagnostic(kind.." required exports missing (init/poll)")
        clear_symbols()
        return false
    end
    if kind=="inject" and (type(arm)~="function" or type(disarm)~="function") then
        diagnostic("inject write exports missing (arm/disarm)")
        unload_native()
        return false
    end
    if kind=="inject" and experiment.feed==1 and type(feed_target)~="function" then
        diagnostic("inject feed requested but aesa_fc_feed_target is missing")
        unload_native()
        return false
    end
    local ok,resolved=pcall(init,base.."Logs\\AESA")
    if not ok then
        diagnostic(kind.." init failed: "..tostring(resolved))
        clear_symbols()
        return false
    end
    loaded=true
    loaded_kind=kind
    diagnostic(kind.." probe loaded, symbols resolved: "..tostring(resolved)
        ..", version="..tostring(result.version))
    diagnostic(string.format("experiment mode=%d (%s), native=%s, bandit=%s",
        experiment.mode,mode_label(),kind,tostring(experiment.bandit_name)))
    if trace_start then
        local tok,hooked=pcall(trace_start)
        diagnostic(tok and ("trace hooks installed: "..tostring(hooked)) or ("trace_start failed: "..tostring(hooked)))
    end
    return true
end

local function load()
    if loaded then return true end
    local kind="trace"
    if experiment.mode==1 then
        local reasons=inject_refusal()
        if #reasons==0 then
            kind="inject"
        else
            diagnostic("write path disabled ("..table.concat(reasons,",")..
                "); using 0 (READ-ONLY)")
            experiment.mode=0
        end
    end
    if load_native(kind) then return true end
    if kind=="inject" then
        diagnostic("inject load failed; falling back to read-only trace")
        experiment.mode=0
        if load_native("trace") then return true end
    end
    return false
end
-- Run code in the mission scripting state through the Hook adapter. The plain
-- "mission" dostring state lacks Unit/world/timer (observed 2026-10-17);
-- "scripting" works, with a_do_script wrapping as fallback. The working
-- channel is remembered.
local msl_channel
local function run_mission(code)
    local candidates={}
    if msl_channel=="scripting" then
        candidates={function() return hookapi:dostring("scripting",code) end}
    elseif msl_channel=="ado" then
        candidates={function() return hookapi:dostring("mission","return a_do_script("..string.format("%q",code)..")") end}
    else
        candidates={
            function() return hookapi:dostring("scripting",code) end,
            function() return hookapi:dostring("mission","return a_do_script("..string.format("%q",code)..")") end,
        }
    end
    for i,cand in ipairs(candidates) do
        local value=cand()
        if value~=nil then
            if not msl_channel then
                msl_channel=(i==1 and "scripting" or "ado")
                diagnostic("mission-state channel: "..msl_channel)
            end
            return value
        end
    end
    return nil
end
-- resolve the bandit's runtime ObjectID from the mission/scripting env.
local last_query_value
local function query_bandit_id()
    local code="local u=Unit.getByName("..string.format("%q",experiment.bandit_name)..") if not u then return -1 end local ok,id=pcall(function() return u:getID() end) if ok and type(id)=='number' then return id end return u.id_ or -3"
    local candidates={
        function() return hookapi:dostring("scripting",code) end,
        function() return hookapi:dostring("mission","return a_do_script("..string.format("%q",code)..")") end,
        function() return hookapi:dostring("mission",code) end,
    }
    for _,cand in ipairs(candidates) do
        local value=cand()
        local id=tonumber(value)
        if id then last_query_value=id end
        if id and id>0 then return id end
    end
    return nil
end
local msl_next_try=0
local function ensure_msl_recorder(now)
    if msl_installed or now<msl_next_try then return end
    msl_next_try=now+5
    local res=run_mission(MSL_RECORDER_SRC)
    if res==nil and msl_channel==nil then return end
    local v=run_mission("return tostring(aesa_fc_msl_dump ~= nil)")
    if v=="true" or (type(res)=="string" and string.find(res,"aesa_fc_msl ok")) then
        msl_installed=true
        diagnostic("msl trajectory recorder installed in mission state")
    end
end
local function pull_msl_log()
    pull_ctr=pull_ctr+1
    if pull_ctr%45~=0 or not msl_installed then return end
    local s=run_mission("return aesa_fc_msl_dump and aesa_fc_msl_dump() or ''")
    if type(s)~="string" or s=="" then return end
    local base=base_dir()
    if not base then return end
    local fok,ferr=pcall(function()
        local f=io.open(base.."Logs\\AESA\\fc_msl_pos.log","ab")
        if f then f:write(s) f:close() end
    end)
    if not fok then diagnostic("msl log write failed: "..tostring(ferr)) end
end
local feed_ctr=0
local feed_query=nil
local function feed_step()
    if experiment.mode~=1 or experiment.feed~=1 or not feed_target or arm_state~="armed" then return end
    feed_ctr=feed_ctr+1
    if feed_ctr%15~=0 then return end
    if not feed_query then
        feed_query="local u=Unit.getByName("..string.format("%q",experiment.bandit_name)..") if not u or not u:isExist() then return '' end local ok,r=pcall(function() local p=u:getPosition().p local v=u:getVelocity() return string.format('%.1f,%.1f,%.1f,%.2f,%.2f,%.2f',p.x,p.y,p.z,v.x,v.y,v.z) end) return ok and r or ''"
    end
    local s=run_mission(feed_query)
    if type(s)=="string" and s~="" then
        pcall(feed_target,s)
    end
end
local function arm_step(now)
    if experiment.mode~=1 or type(arm)~="function" then return end
    if arm_state~="pending" or now<arm_next then return end
    if now>arm_deadline then arm_state="failed" diagnostic("P3-1 arm: bandit not found, giving up (last value: "..tostring(last_query_value)..")") return end
    arm_next=now+experiment.retry
    local ok,id=pcall(query_bandit_id)
    if ok and id then
        if arm then
            local aok,err=pcall(arm,experiment.mode,id)
            if aok then
                diagnostic(string.format("P3-1 ARMED: bandit %s id=%s mode=%d (%s)",experiment.bandit_name,tostring(id),experiment.mode,mode_label()))
                arm_state="armed"
                return
            end
            diagnostic("arm call failed: "..tostring(err))
        end
        arm_state="failed"
    end
end
local function now()
    local value=hookapi:dcs_model_time()
    if type(value)=="number" then return value end
    return os.clock()
end
local function frame()
    if not loaded and not load() then return end
    if poll then
        local ok,err=pcall(poll)
        if not ok then
            failures=failures+1
            if failures<=3 or failures%600==0 then diagnostic("poll error: "..tostring(err)) end
        end
    end
    local t=now()
    arm_step(t)
    ensure_msl_recorder(t)
    pull_msl_log()
    feed_step()
end
-- Dev-only, file-gated compatibility probe (no-op without the deployed probe).
-- loadfile returns nil when the file is absent, so no lfs probe is needed.
local function run_compat_probe()
    local base=base_dir()
    if not base then return end
    local dir=base..[[Scripts\AESA\]]
    local chunk=loadfile(dir.."aesa_compat_probe.lua")
    if not chunk then return end
    local ok,entry=pcall(chunk)
    if ok and type(entry)=="table" and type(entry.run_hook)=="function" then pcall(entry.run_hook,dir) end
end
local callbacks={}
function callbacks.onSimulationFrame() local ok,err=pcall(frame) if not ok then diagnostic(tostring(err)) end end
function callbacks.onSimulationStart()
    run_compat_probe()
    if disarm then pcall(disarm) end
    arm_state="pending"
    msl_installed=false
    msl_next_try=0
    local t=now()
    arm_next=t+1
    arm_deadline=t+experiment.deadline
end
function callbacks.onSimulationStop()
    if disarm then pcall(disarm) end
    unload_native()
    arm_state="idle"
end
if not hookapi:set_user_callbacks(callbacks) then diagnostic("setUserCallbacks unavailable") end
load()

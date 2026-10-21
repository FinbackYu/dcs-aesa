-- Run with Lua 5.1 from the aesa repository root.
-- The runtime adapters are loaded directly, so this suite exercises the same
-- adapter shapes that the deployment bundle publishes as AESA_RUNTIME.
--
-- The entry composes the SAR modules from a table rather than loading them itself (the deployed
-- bundle has no require), so here that table is the four source files, and AESA_RUNTIME carries the
-- adapters the transport reaches for.
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
AESA_RUNTIME = nil
local M = dofile("src/export/aesa_sar_export.lua")
local EXPORTS = dofile("src/adapters/dcs/compat/profiles/dcs-2.9.30.28738-mt.lua").native.agradar.exports
local packets, calls, t = {}, 0, 0
local env = {
    self = function() return { Position = { x = 250 * t, y = 4000, z = 0 } } end,
    velocity = function() return { x = 250, y = 0, z = 0 } end,
    height = function(x,z) calls = calls + 1 return 100 + x * 0.001 + z * 0.002 end,
    altitude = function() return 123 end, agl = function() return 3900 end
}
local function send(line) packets[#packets + 1] = line end
local s = M.new(send, env)
s.command("CAPTURE,1,1,20000")
for i = 0, 160 do
    t = i / 60
    local previous = calls
    s.tick(t)
    assert(calls - previous <= 18, "Unbounded height queries in a frame")
end
local heights, poses, ended = 0, 0, false
for _, line in ipairs(packets) do
    if string.match(line, "^HEIGHT,") then heights = heights + 1 end
    if string.match(line, "^POSE,") then poses = poses + 1 end
    if string.match(line, "^END,1,") then ended = true end
end
assert(heights == 289 and poses >= 60 and ended and not s.job, "Incomplete capture")
assert(string.match(packets[2], "^BEGIN,1,"), "Protocol ordering")
-- The deployed service only accepts these exact provider tokens.
local HEIGHT_PROVIDER = "terrain" .. ".GetHeight"
assert(string.find(table.concat(packets, "\n"), "STATUS,0.000000000," .. HEIGHT_PROVIDER .. ",", 1, true),
    "healthy STATUS must use the service's provider token")
-- Validate actual positions, not a generated constant-velocity path in the exporter.
local last = packets[#packets]
assert(not string.find(table.concat(packets, "\n"), "nan"))
s.command("CAPTURE,2,-1,20000")
s.tick(5)
s.tick(1)
assert(not s.job and packets[#packets-1] == "FAIL,2,model_time_reset", "Model-time reset did not abort")
local noheight = M.new(send, {self=env.self, velocity=env.velocity})
noheight.command("CAPTURE,3,1,20000")
assert(packets[#packets] == "FAIL,3,terrain_unavailable")
-- The adapter reports GetHeight availability explicitly. A function that exists
-- but is known to be unavailable must be refused just like a missing one.
local capped = M.new(send, {self=env.self, velocity=env.velocity,
    height=env.height, height_available=false})
capped.command("CAPTURE,10,1,20000")
assert(packets[#packets] == "FAIL,10,terrain_unavailable", "missing GetHeight capability must refuse capture")
local statuspack = {}
local nostatus = M.new(function(line) statuspack[#statuspack + 1] = line end,
    {self=env.self, velocity=env.velocity, height=env.height, height_available=false})
nostatus.tick(0)
assert(string.match(statuspack[1], "^STATUS,0%.000000000,unavailable,"),
    "missing GetHeight must be reported as unavailable: " .. tostring(statuspack[1]))
local broken = M.new(send, {self=env.self, velocity=env.velocity, height=function() return 0/0 end})
broken.command("CAPTURE,4,1,20000") broken.tick(10)
assert(packets[#packets] == "FAIL,4,terrain_query_failed" and not broken.job)
local slow = M.new(send, {self=env.self, velocity=function() return {x=0,z=0} end,height=env.height})
slow.command("CAPTURE,5,1,20000")
assert(packets[#packets] == "FAIL,5,ground_speed_too_low")
-- Larger requests retain a fixed per-frame query budget, plus explicit surface labels.
for _,pair in ipairs({{512,33},{2048,65}}) do
    local bigpack={}
    local big=M.new(function(line) bigpack[#bigpack+1]=line end,{self=env.self,velocity=env.velocity,height=env.height,surface=function() return 'land' end})
    t=0 big.command('CAPTURE,30,1,20000,'..pair[1]..','..pair[2])
    for i=0,500 do t=i/60 local previous=calls big.tick(t) assert(calls-previous<=18) end
    local heights,surfaces=0,0 for _,line in ipairs(bigpack) do if string.find(line,'^HEIGHT,') then heights=heights+1 elseif string.find(line,'^SURFACE,') then surfaces=surfaces+1 end end
    assert(heights==pair[2]^2 and surfaces==heights and not big.job)
end
t=0 local selected=M.new(send,env) selected.command('CAPTURE_WORLD,31,10000,10000') assert(selected.job.x==10000 and selected.job.z==10000)
print("SAR Lua sampler: ordered capture, three bounded footprints, world point, time reset, unavailable/invalid terrain, low speed PASS")

-- Surface classes come from adapter terrain_surface_type. The adapter may answer
-- with a class number or a name; everything else, including a missing adapter,
-- is unknown rather than a guessed class.
local function map_surfaces(pack)
    local out = {}
    for _, line in ipairs(pack) do
        local v = string.match(line, "^MAPSURFACE,%d+,%d+,%d+,(.+)$")
        if v then out[#out + 1] = v end
    end
    return out
end
local function class_run(surface_fn)
    local pack = {}
    local st = M.new(function(line) pack[#pack + 1] = line end,
        {self = env.self, velocity = env.velocity, height = env.height, surface = surface_fn})
    st.command("CAPTURE_MAP,80,0,0,2,2,250")
    st.tick(0)
    return map_surfaces(pack)
end
assert(class_run(function() return 3 end)[1] == "3", "class number 1-5 travels as its digit")
assert(class_run(function() return "Runway" end)[1] == "runway", "class names are lower-cased")
for _, invalid in ipairs({0, 6, 2.5, "", "grass"}) do
    assert(class_run(function() return invalid end)[1] == "unknown",
        "invalid class " .. tostring(invalid) .. " must be unknown")
end
assert(class_run(function() error("engine failure") end)[1] == "unknown", "adapter errors become unknown")
-- No adapter surface at all and no probe: an explicitly requested fine vocabulary
-- still yields per-cell unknown, not a fabricated class.
do
    local pack = {}
    local st = M.new(function(line) pack[#pack + 1] = line end,
        {self = env.self, velocity = env.velocity, height = env.height})
    st.command("SURFACE_FINE")
    st.command("CAPTURE_MAP,81,0,0,2,2,250")
    st.tick(0)
    local got = map_surfaces(pack)
    assert(#got == 4 and got[1] == "unknown", "missing adapter surface must be unknown")
end
print("SAR surface adapter: numbers 1-5, names, invalid/missing/error cases PASS")

-- Geographic conversion argument order is longitude, latitude in the official Export example.
local geoenv = {self=env.self,velocity=env.velocity,height=env.height,
    geo=function(lon,lat) assert(lon==42.25 and lat==41.5) return {x=10000,z=10000} end}
t=0
local geo=M.new(send,geoenv)
geo.command("CAPTURE_GEO,6,41.5,42.25")
assert(geo.job and geo.job.x==10000 and geo.job.z==10000)
assert(math.abs(geo.job.bearing-math.pi/4)<1e-10)
geo.tick(0)
assert(string.find(table.concat(packets,"\n"),"TARGET,6,41.500000000,42.250000000,"))
geo.command("CANCEL")
geo.command("CAPTURE_GEO,7,91,42.25") assert(not geo.job)
local absent=M.new(send,{self=env.self,velocity=env.velocity,height=env.height})
absent.command("CAPTURE_GEO,8,41.5,42.25") assert(packets[#packets]=="FAIL,8,geo_unavailable")
for _, converter in ipairs({function() error("conversion failed") end,function() return {x=0/0,z=0} end,
    function() return {x=1,z=1} end,function() return {x=100000,z=0} end}) do
    local bad=M.new(send,{self=env.self,velocity=env.velocity,height=env.height,geo=converter})
    bad.command("CAPTURE_GEO,8,41.5,42.25") assert(not bad.job and string.match(packets[#packets],"^FAIL,8,"))
end
print("SAR geographic targeting: conversion order, fixed center, confirmed target, invalid/out-of-range/unavailable PASS")

-- MAP: a coarse north-up lattice the server fills incrementally, 17 cells per frame.
local mappack = {}
local mapenv = {self=env.self, velocity=env.velocity, height=env.height, surface=function() return 'land' end}
t = 0
local mapper = M.new(function(line) mappack[#mappack + 1] = line end, mapenv)
mapper.command("CAPTURE_MAP,40,1000,2000,3,2,250")
assert(mappack[#mappack - 1] == "MAPBEGIN,40,1000.000000000,2000.000000000,3,2,250"
    and mappack[#mappack] == "MAPGRID,40,col_x_row_z", "map origin and grid layout are echoed before the cells")
for i = 0, 4 do t = i / 60 mapper.tick(t) end
local heights, surfaces, poses, ended = 0, 0, 0, false
local pose_seq = {}
for _, line in ipairs(mappack) do
    if string.match(line, "^MAPHEIGHT,") then heights = heights + 1 end
    if string.match(line, "^MAPSURFACE,") then surfaces = surfaces + 1 end
    if string.match(line, "^MAPPOSE,") then poses = poses + 1 pose_seq[#pose_seq + 1] = tonumber(string.match(line, "^MAPPOSE,%d+,(%d+),")) end
    if string.match(line, "^MAPEND,40,6,") then ended = true end
end
assert(heights == 6 and surfaces == 6 and poses >= 1 and ended and not mapper.map, "map job completes with heights, classes and poses")
-- The map pose stream is numbered like the SAR POSE stream: the first frame of a job is 0 and every
-- later frame follows by exactly one. The server now adopts the first number as its baseline, so an
-- Export in the field that still numbers from 1 keeps working, but this end keeps one rule for both
-- job kinds — and a test that only counted the frames would not have caught the two drifting apart.
for index = 1, #pose_seq do
    assert(pose_seq[index] == index - 1,
        "map pose " .. index .. " carries seq " .. tostring(pose_seq[index]) .. ", expected " .. (index - 1))
end
local cell
for _, line in ipairs(mappack) do
    if string.match(line, "^MAPHEIGHT,40,1,0,") then cell = line end
end
assert(cell == "MAPHEIGHT,40,1,0,1250.000000000,105.250000000,2000.000000000", "cell (col,row) sits on the lattice: " .. tostring(cell))
-- A relative request resolves against the ownship here, because the server cannot know it first.
local relpack = {}
local relative = M.new(function(line) relpack[#relpack + 1] = line end, mapenv)
t = 0
relative.command("CAPTURE_MAP_AT,41,1500,0,2,2,250")
assert(relpack[#relpack - 1] == "MAPBEGIN,41,1500.000000000,0.000000000,2,2,250"
    and relpack[#relpack] == "MAPGRID,41,col_x_row_z", "relative origin and grid layout are resolved and echoed")
relative.tick(0)
assert(not relative.map and string.match(relpack[#relpack], "^MAPEND,41,4,"), "a small job finishes inside one frame")
local abad = M.new(send, mapenv)
abad.command("CAPTURE_MAP,42,0,0,200,200,250") assert(not abad.map, "a rectangle over the cell budget is ignored")
abad.command("CAPTURE_MAP,42,0,0,2,2,10") assert(not abad.map, "a cell size outside 25-2000 m is ignored")
abad.command("CAPTURE_MAP,42,0,0,2,2,250")
abad.command("CAPTURE_MAP,43,0,0,2,2,250") assert(packets[#packets] == "FAIL,43,map_busy", "one map job at a time")
abad.command("CANCEL") assert(packets[#packets] == "FAIL,42,cancelled" and not abad.map, "CANCEL drops a running map job")
local noheight = M.new(send, {self=env.self, velocity=env.velocity})
noheight.command("CAPTURE_MAP,44,0,0,2,2,250") assert(packets[#packets] == "FAIL,44,terrain_unavailable")
-- A map job and a SAR capture are independent: each keeps its own 17-cell frame budget.
t = 0
local bothpack, bothcalls = {}, 0
local both = M.new(function(line) bothpack[#bothpack + 1] = line end,
    {self=env.self, velocity=env.velocity, height=function(x,z) bothcalls = bothcalls + 1 return env.height(x,z) end})
both.command("CAPTURE,45,1,20000")
both.command("CAPTURE_MAP,46,0,0,40,40,250")
for i = 0, 300 do
    t = i / 60
    local previous = bothcalls
    both.tick(t)
    assert(bothcalls - previous <= 36, "map and SAR together stay inside two 17-cell budgets (plus the 1 Hz status query)")
end
local mapcells = 0
for _, line in ipairs(bothpack) do if string.match(line, "^MAPHEIGHT,") then mapcells = mapcells + 1 end end
assert(mapcells == 1600 and not both.map, "the 1600-cell map job filled alongside a SAR capture")
print("SAR map lattice: ordering, echo, relative origin, validation, cancellation, coexistence PASS")

-- Exercise callback chain and TCP partial writes with a deterministic socket stub.
-- The deployed consumer sees the SAR modules and the adapters; the export adapter resolves these
-- globals, so the test provides the engine-shaped environment DCS provides.
local written, clock, connected, frames = "", 0, false, 0
local log_lines = {}
local fake = {}
function fake:settimeout() end
function fake:connect() connected = true return true end
function fake:close() connected = false end
function fake:receive(_,prefix)
    if not self.command_sent and clock > 0 then self.command_sent = true return "CAPTURE,9,1,20000" end
    return nil, "timeout", prefix or ""
end
function fake:send(data)
    local n = math.min(1000,#data)
    written = written .. string.sub(data,1,n)
    if n == #data then return n end
    return nil,"timeout",n
end
_G.socket = {tcp=function() return fake end}
_G.terrain = {GetHeight=env.height, GetSurfaceType=function() return 1 end}
_G.lfs = {writedir=function() return "S:\\Saved Games\\DCS\\" end}
_G.log = {INFO=1, ERROR=2, write=function(tag,level,message) log_lines[#log_lines+1]=tostring(tag)..":"..tostring(message) return true end}
_G.LoGetModelTime = function() return clock end
_G.LoGetSelfData = env.self
_G.LoGetVectorVelocity = env.velocity
_G.LuaExportAfterNextFrame = function() frames = frames + 1 error("neighbor failed") end
local old_stop_called = false
_G.LuaExportStop = function() old_stop_called = true end
AESA_SAR.api = dofile("src/adapters/dcs/api/export.lua")
AESA_SAR.socket = dofile("src/adapters/dcs/api/socket.lua")
AESA_SAR.native = dofile("src/adapters/dcs/api/native.lua")
AESA_SAR.profile = dofile("src/adapters/dcs/compat/profile.lua")
AESA_SAR.profile_data = dofile("src/adapters/dcs/compat/profiles/dcs-2.9.30.28738-mt.lua")
AESA_RUNTIME = {
    export = AESA_SAR.api, socket = AESA_SAR.socket, native = AESA_SAR.native,
    profile = AESA_SAR.profile, profile_data = AESA_SAR.profile_data,
}
dofile("src/export/aesa_sar_export.lua")
LuaExportStart()
for i = 0, 200 do clock = i / 60 t = clock LuaExportAfterNextFrame() end
assert(frames == 201 and connected)
assert(string.sub(written,1,11) == "HELLO,SAR1\n")
local expected_profile = AESA_RUNTIME.profile.new(AESA_SAR.profile_data, "generated")
local compat = string.format("COMPAT,%s,%s", expected_profile:id(), expected_profile:matrix_hash())
assert(string.sub(written, 12, 11 + #compat) == compat,
    "COMPAT must follow HELLO with the generated profile id and matrix hash: " .. tostring(string.sub(written, 12, 11 + #compat)))
assert(string.find(written, "\nCAPS,2," .. ("terrain" .. ".GetSurfaceType") .. ",map\n", 1, true),
    "CAPS advertises the adapter surface capability")
assert(string.find(written,"\nSURFACE,9,"), "adapter surface classes travel on the legacy SURFACE stream")
assert(string.find(written,"\nEND,9,"), "Partial sends truncated the capture")
LuaExportStop()
assert(old_stop_called and not connected)
print("SAR Lua callback chain, COMPAT handshake and TCP partial-write recovery PASS")

-- A missing LuaSocket module is fatal for the session: diagnose once and stop.
-- Retrying cannot make the module appear, so the bootstrap is called only once.
do
    local real_socket = AESA_SAR.socket
    local attempts = 0
    AESA_SAR.socket = {bootstrap=function() attempts = attempts + 1 return nil, "missing:socket" end}
    local before = #log_lines
    _G.LuaExportAfterNextFrame = nil
    dofile("src/export/aesa_sar_export.lua")
    LuaExportStart()
    clock = 100
    LuaExportAfterNextFrame()
    LuaExportAfterNextFrame()
    assert(attempts == 1, "a missing socket module must stop collection instead of retrying forever")
    local logged = table.concat(log_lines, "\n", before + 1)
    assert(string.find(logged, "socket unavailable", 1, true),
        "missing socket must be diagnosed: " .. logged)
    AESA_SAR.socket = real_socket
end
print("SAR socket bootstrap: missing module diagnosed and stopped PASS")

-- Fine surface classes: the engine's 16-class mask comes from the native aesa_agradar probe, loaded
-- through runtime.native with the export list from profile.native.agradar.exports. It is used only
-- when the service asks for it with SURFACE_FINE; every other combination keeps the five-class words,
-- and every failure (missing DLL, partial DLL, missing writedir, failed profile check) degrades to
-- those five classes instead of inventing one.
local function run_map(opts)
    opts = opts or {}
    local pack = {}
    local e = {self = env.self, velocity = env.velocity, height = env.height,
        surface = opts.surface or function() return "land" end}
    e.writedir = function()
        if opts.writedir == false then return nil, "missing:lfs.writedir" end
        return opts.writedir or "S:\\Saved Games\\DCS\\"
    end
    e.agradar_exports = opts.exports or EXPORTS
    e.native_load = function(path, symbols)
        return AESA_RUNTIME.native.new(_G):load(path, symbols)
    end
    local s = M.new(function(line) pack[#pack + 1] = line end, e)
    if opts.fine then s.command("SURFACE_FINE") end
    s.command(string.format("CAPTURE_MAP,%d,%d,0,2,2,250", opts.id or 50, opts.x0 or 0))
    for i = 0, 4 do s.tick(i / 60) end
    return map_surfaces(pack)
end
local real_loadlib = package.loadlib
local loadlib_log, probe_calls, init_calls = {}, 0, 0
local function symbols_without(omit)
    local out = {}
    for _, name in ipairs(EXPORTS) do if name ~= omit then out[name] = true end end
    return out
end
local function stub(exported, opts)
    opts = opts or {}
    loadlib_log, probe_calls, init_calls = {}, 0, 0
    package.loadlib = function(path, name)
        loadlib_log[#loadlib_log + 1] = path .. "|" .. name
        if not exported[name] then return nil, "symbol not found" end
        if name == "aesa_agradar_init" then return function() init_calls = init_calls + 1 end end
        if name == "aesa_agradar_poll" or name == "aesa_agradar_shutdown" then return function() end end
        if name == "aesa_agradar_version" then return function() return "test" end end
        if name == "aesa_agradar_profile_check" then return function() return opts.profile_check or 1 end end
        return function(x, z)
            probe_calls = probe_calls + 1
            if x < 0 then return nil end                    -- engine not ready for that point
            return opts.names or "Land,Runway,Road"          -- the probe's comma-joined union
        end
    end
end
local function restore() package.loadlib = real_loadlib end
local FULL = symbols_without(nil)
local AGRA = "Scripts\\AESA-AGR\\aesa_agradar.dll"

-- 1) No SURFACE_FINE: an old service gets the old words, and the probe is never even looked for.
stub(FULL)
local legacy = run_map({id = 53, surface = function() return "land" end})
assert(#loadlib_log == 0 and probe_calls == 0, "the probe is not touched unless the service asks for it")
assert(#legacy == 4 and legacy[1] == "land", "legacy words travel unchanged")
restore()

-- 2) writedir is available: the DLL path is the adapter's Saved Games root, and every export the
-- profile lists is resolved from that one path before the probe is used.
stub(FULL, {names = "Land,Runway,Road"})
local fine = run_map({fine = true, id = 54, surface = function() return "water" end})
local prefix = "S:\\Saved Games\\DCS\\" .. AGRA .. "|"
local seen = {}
for _, entry in ipairs(loadlib_log) do
    assert(string.sub(entry, 1, #prefix) == prefix, "every symbol comes from the profile path: " .. entry)
    seen[string.match(entry, "|(.+)$")] = true
end
for _, name in ipairs(EXPORTS) do assert(seen[name], name .. " was not loaded") end
assert(#loadlib_log == #EXPORTS and init_calls == 1, "one pass over the profile exports, then init once")
assert(probe_calls >= 4 and fine[1] == "Land+Runway+Road" and fine[4] == "Land+Runway+Road",
    "the union travels '+'-joined: " .. tostring(fine[1]))
restore()

-- 3) No writedir: no path search fallback, so there is no probe and the five classes stay.
stub(FULL)
local noDir = run_map({fine = true, id = 55, writedir = false, surface = function() return "water" end})
assert(#loadlib_log == 0 and noDir[1] == "water", "missing writedir must not trigger a path search")
restore()
stub(FULL)
local emptyDir = run_map({fine = true, id = 56, writedir = "", surface = function() return "water" end})
assert(#loadlib_log == 0 and emptyDir[1] == "water", "an empty writedir is unavailable, not a root")
restore()

-- 4) One profile export missing is a stale/partial DLL: no fine vocabulary, per cell.
stub(symbols_without("aesa_agradar_surface_mask"))
local half = run_map({fine = true, id = 57, surface = function() return "road" end})
assert(half[1] == "road", "a half-exported DLL is not used: " .. tostring(half[1]))
assert(#loadlib_log == #EXPORTS, "the whole profile list is attempted before giving up")
restore()

-- 5) A failed native profile check (vtable mismatch) also disables the fine vocabulary.
stub(FULL, {profile_check = 0})
local mismatch = run_map({fine = true, id = 58, surface = function() return "road" end})
assert(mismatch[1] == "road", "a profile-check mismatch is not used: " .. tostring(mismatch[1]))
restore()

-- 6) A point the probe cannot answer (engine not ready there) falls back per cell, not per job.
stub(FULL, {names = "Land,Runway,Road"})
local mixed = run_map({fine = true, id = 59, x0 = -250, surface = function() return "road" end})
assert(mixed[1] == "road" and mixed[2] == "Land+Runway+Road" and mixed[3] == "road" and mixed[4] == "Land+Runway+Road",
    "per-cell fallback: " .. table.concat(mixed, " "))
restore()

print("SAR map surfaces: profile export list, single path, partial DLL, profile check, per-cell fallback PASS")

-- Gate 1 regression: the 16 engine classes must survive the wire mapping. The probe names its classes
-- in CamelCase ("ParticleEffect") while the service's vocabulary is snake_case ("particle_effect"); a
-- plain lower() lookup lost ParticleEffect, and the cell silently fell back to the legacy five-class
-- answer. Every class is checked on its own so one bad entry cannot hide behind a union.
local CLASS_CASES = {
    {"Land", "Land"}, {"Runway", "Runway"}, {"Sea", "Sea"}, {"River", "River"}, {"Lake", "Lake"},
    {"Road", "Road"}, {"Railway", "Railway"}, {"Town", "Town"}, {"Field", "Field"}, {"Beach", "Beach"},
    {"Building", "Building"}, {"Construction", "Construction"}, {"Trees", "Trees"}, {"Forest", "Forest"},
    {"Traffic", "Traffic"}, {"ParticleEffect", "Particle_Effect"},
}
for _, case in ipairs(CLASS_CASES) do
    stub(FULL, {names = case[1]})
    local got = run_map({fine = true, surface = function() return "land" end, id = 60})
    assert(#got == 4, "a 2x2 map still delivers four surface lines")
    for cell = 1, 4 do
        assert(got[cell] == case[2],
            "probe class " .. case[1] .. " travelled as " .. tostring(got[cell]) .. ", expected " .. case[2])
    end
    restore()
end
print("SAR surface vocabulary: all 16 engine classes survive the wire mapping (ParticleEffect -> Particle_Effect) PASS")

-- Worst case: one point carries every engine class. The service refuses a MAPSURFACE field longer than
-- 96 characters (tools/sar_service/collector.cjs surfaceClass), and the full capitalised union is 114,
-- so the Export must encode a deterministic prefix that stays inside the consumer's limit. Truncating
-- probe order keeps Building (the service's radar-significance winner) in the prefix; no class that
-- could win a truncated union sits after the cut.
local ALL_CLASSES = "Land,Runway,Sea,River,Lake,Road,Railway,Town,Field,Beach,Building,Construction,Trees,Forest,Traffic,ParticleEffect"
stub(FULL, {names = ALL_CLASSES})
local worst = run_map({fine = true, surface = function() return "land" end, id = 61})
assert(#worst == 4, "the all-class union still produces a surface line per cell")
for cell = 1, 4 do
    assert(#worst[cell] <= 96, "MAPSURFACE field exceeds the consumer limit: " .. #worst[cell] .. " characters")
    assert(string.find(worst[cell], "Building", 1, true),
        "the significance winner must survive truncation: " .. tostring(worst[cell]))
end
restore()
print("SAR surface vocabulary: 16-class worst case stays inside the consumer's 96-character field limit PASS")

-- Gate 1 regression: the MAP grid is canonical (col -> +x, row -> +z) and says so explicitly. The marker
-- is a separate additive line because the deployed service requires MAPBEGIN to have exactly seven fields;
-- an unknown MAP* line is ignored by it, so an old server and an old Export both keep working.
local gridpack = {}
local grid = M.new(function(line) gridpack[#gridpack + 1] = line end, env)
grid.command("CAPTURE_MAP,71,1000,2000,2,2,250")
grid.tick(0)
assert(gridpack[1] == "MAPBEGIN,71,1000.000000000,2000.000000000,2,2,250", "map origin is echoed first")
assert(gridpack[2] == "MAPGRID,71,col_x_row_z", "explicit grid layout marker: " .. tostring(gridpack[2]))
local cells = {}
for _, line in ipairs(gridpack) do
    local id, col, row, x, _, z = string.match(line, "^MAPHEIGHT,(%d+),(%d+),(%d+),([^,]+),([^,]+),([^,]+)$")
    if id then cells[#cells + 1] = {col = tonumber(col), row = tonumber(row), x = tonumber(x), z = tonumber(z)} end
end
assert(#cells == 4, "all four lattice cells were delivered")
for _, cell in ipairs(cells) do
    assert(cell.x == 1000 + cell.col * 250, "x must be x0 + col*step: " .. tostring(cell.x))
    assert(cell.z == 2000 + cell.row * 250, "z must be z0 + row*step: " .. tostring(cell.z))
end
assert(cells[2].col == 1 and cells[2].row == 0 and cells[2].x == 1250 and cells[2].z == 2000,
    "col runs along +x: " .. table.concat({cells[2].col, cells[2].row, cells[2].x, cells[2].z}, ","))
assert(cells[3].col == 0 and cells[3].row == 1 and cells[3].x == 1000 and cells[3].z == 2250,
    "row runs along +z: " .. table.concat({cells[3].col, cells[3].row, cells[3].x, cells[3].z}, ","))
print("SAR map grid: explicit col_x_row_z marker, col->+x and row->+z with no transpose PASS")

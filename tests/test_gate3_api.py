import re
import shutil
import subprocess
import unittest
from pathlib import Path

try:
    from lupa import lua51
except ImportError:  # pragma: no cover - environment guard
    lua51 = None

ROOT = Path(__file__).resolve().parents[1]
EXPORT = str(ROOT / "src/adapters/dcs/api/export.lua").replace("\\", "/")
MISSION = str(ROOT / "src/adapters/dcs/api/mission.lua").replace("\\", "/")
HOOK = str(ROOT / "src/adapters/dcs/api/hook.lua").replace("\\", "/")
NATIVE = str(ROOT / "src/adapters/dcs/api/native.lua").replace("\\", "/")
SOCKET = str(ROOT / "src/adapters/dcs/api/socket.lua").replace("\\", "/")
PROFILE = str(ROOT / "src/adapters/dcs/compat/profile.lua").replace("\\", "/")
PROBE = str(ROOT / "src/adapters/dcs/compat/probe.lua").replace("\\", "/")
CONCRETE = str(
    ROOT / "src/adapters/dcs/compat/profiles/dcs-2.9.30.28738-mt.lua"
).replace("\\", "/")

LUA_PRELUDE = """
local function eq(a, b, msg)
  assert(a == b, tostring(msg) .. ': expected ' .. tostring(b) .. ', got ' .. tostring(a))
end
local function starts(value, prefix, msg)
  assert(type(value) == 'string' and string.sub(value, 1, #prefix) == prefix,
    tostring(msg) .. ': unexpected reason ' .. tostring(value))
end
local function truthy(value, msg)
  assert(value, msg)
end
"""


def run_lua(script):
    if lua51 is None:
        raise unittest.SkipTest("lupa.lua51 is not installed")
    runtime = lua51.LuaRuntime(unpack_returned_tuples=True)
    try:
        runtime.execute(LUA_PRELUDE + script)
    except Exception as error:  # lupa raises LuaError with the Lua message
        raise AssertionError(f"Lua assertion failed: {error}\nscript:\n{script}") from error


class Gate3ApiTest(unittest.TestCase):
    def test_export_api_with_stub_environment(self):
        script = """
local Export = assert(dofile('__EXPORT__'))
local env = {
  LoGetModelTime = function() return 42.5 end,
  LoGetSelfData = function()
    return { Position = { x = 1, y = 2, z = 3 }, Heading = 0.1, Pitch = 0.2,
             Bank = 0.3, Type = 'F-16C_50', LatLongAlt = { lat = 45, lon = 40, alt = 1000 } }
  end,
  LoGetVectorVelocity = function() return { x = 10, y = 0, z = 20 } end,
  LoGetWorldObjects = function()
    return { [100] = { Position = { x = 1, y = 2, z = 3 }, CoalitionID = 1, Type = 'Su-27' } }
  end,
  LoGetTargetInformation = function() return nil end,
  LoGetLockedTargetInformation = function() return {} end,
  LoIsSensorExportAllowed = function() return true end,
  terrain = {
    GetHeight = function(x, z) return 100 + x + z end,
    GetSurfaceType = function() return 1 end,
    isVisible = function(x1, y1, z1, x2, y2, z2) return x1 == x2 and z1 == z2 end,
  },
  LoGeoCoordinatesToLoCoordinates = function(lon, lat) return lon * 1000, lat * 2000 end,
  LoLoCoordinatesToGeoCoordinates = function(x, z)
    return { latitude = z / 2000, longitude = x / 1000 }
  end,
  LoGetAltitude = function() return 1200 end,
  LoGetAltitudeAboveGroundLevel = function() return 200 end,
  LoGetHeightWithObjects = function() return 190 end,
  lfs = { writedir = function() return 'C:/Saved Games/DCS/' end,
          currentdir = function() return 'C:/DCS/bin' end },
  log = { INFO = 1, write = function(level, message) return true end },
  socket = { tcp = function() return {} end },
  package = { loadlib = function(path, symbol) return function() return symbol end end },
  AESA_FACTS = { build = '2.9.30.28738', variant = 'MT' },
}
local api = Export.new(env)
eq(api:model_time(), 42.5, 'model time')
eq(api:self_data().Position.x, 1, 'self position')
eq(api:vector_velocity().z, 20, 'velocity')
eq(api:world_objects()[100].CoalitionID, 1, 'world objects')
local target, target_why = api:target_information()
eq(target, nil, 'target information nil')
starts(target_why, 'empty:', 'target information reason')
eq(api:locked_target_information() ~= nil, true, 'locked target')
eq(api:sensor_export_allowed(), true, 'sensor export allowed')
eq(api:terrain_height(2, 3), 105, 'terrain height')
eq(api:terrain_surface_type(2, 3), 1, 'terrain surface')
eq(api:terrain_visible(1, 2, 3, 1, 0, 3), true, 'terrain visible')
local x, z = api:geo_forward(40, 45)
eq(x, 40000, 'geo forward x')
eq(z, 90000, 'geo forward z')
eq(api:geo_inverse(x, z).latitude, 45, 'geo inverse lat')
eq(api:altitude(0, 0), 1200, 'altitude')
eq(api:agl(), 200, 'agl')
eq(api:height_with_objects(), 190, 'height with objects')
eq(api:writedir(), 'C:/Saved Games/DCS/', 'writedir')
eq(api:currentdir(), 'C:/DCS/bin', 'currentdir')
eq(api:log_write('INFO', 'hello'), true, 'log write')
eq(api:socket() ~= nil, true, 'socket')
eq(api:loadlib_available(), true, 'loadlib available')
eq(type(api:loadlib('x.dll', 'symbol')), 'function', 'loadlib symbol')
local caps = api:capabilities()
eq(caps.self_data, 'ok', 'cap self')
eq(caps.world_objects, 'ok', 'cap world')
eq(caps.terrain_get_height, 'ok', 'cap height')
eq(caps.terrain_is_visible, 'ok', 'cap visible')
eq(caps.log_write, 'ok', 'cap log')
eq(caps.socket, 'ok', 'cap socket')
eq(caps.loadlib, 'ok', 'cap loadlib')
local adapter = api:adapter()
eq(adapter.kind, 'export', 'adapter kind')
eq(adapter.call('model_time'), 42.5, 'adapter call')
eq(adapter.call('self_data').Position.z, 3, 'adapter self data')
eq(adapter.facts().build, '2.9.30.28738', 'adapter facts')
local missing, missing_why = api:call('does_not_exist')
eq(missing, nil, 'unknown operation')
starts(missing_why, 'missing:operation:', 'unknown operation reason')
print('export ok')
""".replace("__EXPORT__", EXPORT)
        run_lua(script)

    def test_export_api_missing_types_and_errors_are_isolated(self):
        script = """
local Export = assert(dofile('__EXPORT__'))
local empty = Export.new({})
local value, why = empty:model_time()
eq(value, nil, 'missing model time')
starts(why, 'missing:', 'missing model time reason')
value, why = empty:self_data()
eq(value, nil, 'missing self data')
starts(why, 'missing:', 'missing self data reason')
value, why = empty:terrain_height(0, 0)
eq(value, nil, 'missing terrain')
starts(why, 'missing:', 'missing terrain reason')
value, why = empty:socket()
eq(value, nil, 'missing socket')
starts(why, 'missing:', 'missing socket reason')
value, why = empty:loadlib_available()
eq(value, nil, 'missing loadlib')
starts(why, 'missing:', 'missing loadlib reason')
local empty_caps = empty:capabilities()
eq(empty_caps.self_data, 'unavailable', 'empty cap self')
eq(empty_caps.socket, 'unavailable', 'empty cap socket')
local adapter = empty:adapter()
value, why = adapter.call('self_data')
eq(value, nil, 'adapter missing self')
starts(why, 'missing:', 'adapter missing reason')

local bad = Export.new({
  LoGetModelTime = function() error('clock exploded') end,
  LoGetSelfData = function() return 5 end,
  LoGetVectorVelocity = function() return { x = 1 } end,
  LoGetWorldObjects = function() return 'not a table' end,
  terrain = { GetHeight = function() error('terrain exploded') end,
              GetSurfaceType = function() return true end,
              isVisible = function() return 1 end },
  LoGeoCoordinatesToLoCoordinates = function() return 1 end,
  LoLoCoordinatesToGeoCoordinates = function() return nil end,
  lfs = { writedir = function() return 7 end },
  log = { write = function() return false end },
  package = { loadlib = function() error('loadlib exploded') end },
})
local function isolated(call)
  local ok, a, b = pcall(call)
  truthy(ok, 'wrapper must not throw')
  return a, b
end
value, why = isolated(function() return bad:model_time() end)
eq(value, nil, 'error model time')
starts(why, 'error:', 'error model time reason')
value, why = isolated(function() return bad:self_data() end)
eq(value, nil, 'wrong self type')
starts(why, 'type:', 'wrong self type reason')
value, why = isolated(function() return bad:vector_velocity() end)
eq(value, nil, 'wrong velocity')
starts(why, 'invalid:', 'wrong velocity reason')
value, why = isolated(function() return bad:world_objects() end)
eq(value, nil, 'wrong world')
starts(why, 'type:', 'wrong world reason')
value, why = isolated(function() return bad:terrain_height(0, 0) end)
eq(value, nil, 'error terrain')
starts(why, 'error:', 'error terrain reason')
value, why = isolated(function() return bad:terrain_surface_type(0, 0) end)
eq(value, nil, 'wrong surface')
starts(why, 'type:', 'wrong surface reason')
value, why = isolated(function() return bad:terrain_visible(1, 2, 3, 4, 5, 6) end)
eq(value, nil, 'wrong visibility')
starts(why, 'type:', 'wrong visibility reason')
value, why = isolated(function() return bad:geo_forward(1, 2) end)
eq(value, nil, 'wrong forward')
starts(why, 'type:', 'wrong forward reason')
value, why = isolated(function() return bad:geo_inverse(1, 2) end)
eq(value, nil, 'wrong inverse')
starts(why, 'type:', 'wrong inverse reason')
value, why = isolated(function() return bad:writedir() end)
eq(value, nil, 'wrong writedir')
starts(why, 'invalid:', 'wrong writedir reason')
value, why = isolated(function() return bad:log_write('INFO', 'x') end)
eq(value, nil, 'log write failure')
starts(why, 'error:', 'log write failure reason')
value, why = isolated(function() return bad:loadlib('x.dll', 'symbol') end)
eq(value, nil, 'loadlib error')
starts(why, 'error:', 'loadlib error reason')
print('export isolation ok')
""".replace("__EXPORT__", EXPORT)
        run_lua(script)

    def test_export_surface_type_never_retries_with_vec2(self):
        script = """
local Export = assert(dofile('__EXPORT__'))
local calls = 0
local function recorder(result)
  return function(a, b)
    calls = calls + 1
    assert(type(a) == 'number' and type(b) == 'number',
      'terrain.GetSurfaceType must only be called with scalars')
    return result
  end
end

local named = Export.new({ terrain = { GetSurfaceType = recorder('land') } })
local value, why = named:terrain_surface_type(12, 34)
eq(value, 'land', 'surface name accepted')
eq(why, nil, 'surface name has no reason')
eq(calls, 1, 'surface name calls once')

local numeric = Export.new({ terrain = { GetSurfaceType = recorder(4) } })
value, why = numeric:terrain_surface_type(12, 34)
eq(value, 4, 'surface number accepted')
eq(calls, 2, 'surface number calls once')

local invalid = Export.new({ terrain = { GetSurfaceType = recorder(true) } })
value, why = invalid:terrain_surface_type(12, 34)
eq(value, nil, 'invalid surface rejected')
starts(why, 'type:', 'invalid surface reason')
eq(calls, 3, 'invalid surface calls once')
print('export surface forms ok')
""".replace("__EXPORT__", EXPORT)
        run_lua(script)

    def test_export_geo_forward_accepts_table_and_scalars(self):
        script = """
local Export = assert(dofile('__EXPORT__'))
local table_env = Export.new({
  LoGeoCoordinatesToLoCoordinates = function(lon, lat)
    eq(lon, 40, 'geo lon')
    eq(lat, 45, 'geo lat')
    return { x = 1234.5, y = 0, z = -678.25 }
  end,
})
local x, z = table_env:geo_forward(40, 45)
eq(x, 1234.5, 'geo table x')
eq(z, -678.25, 'geo table z')

local pair_env = Export.new({
  LoGeoCoordinatesToLoCoordinates = function() return 11, 22 end,
})
x, z = pair_env:geo_forward(40, 45)
eq(x, 11, 'geo pair x')
eq(z, 22, 'geo pair z')

local bad_env = Export.new({
  LoGeoCoordinatesToLoCoordinates = function() return { x = 1 } end,
})
local value, why = bad_env:geo_forward(40, 45)
eq(value, nil, 'geo bad shape')
starts(why, 'type:', 'geo bad shape reason')
print('export geo forms ok')
""".replace("__EXPORT__", EXPORT)
        run_lua(script)

    def test_socket_bootstrap_rejects_module_without_core(self):
        script = """
local Socket = assert(dofile('__SOCKET__'))
local client = newproxy(true)
getmetatable(client).__index = { close = function() end }
local working = { tcp = function() return client end }
local broken = { tcp = function() error('socket.core missing') end }
local calls = 0
local env = {
  require = function(name)
    calls = calls + 1
    if calls == 1 then return broken end
    return working
  end,
  package = { path = '', cpath = '', loaded = { socket = broken, ['socket.core'] = false } },
  lfs = { currentdir = function() return 'C:/DCSWorld' end },
}
local api, why = Socket.bootstrap(env)
eq(api, working, 'broken module rejected')
eq(calls >= 2, true, 'retried after cache reset')
eq(env.package.loaded.socket ~= broken, true, 'cache reset')
print('socket bootstrap ok')
""".replace("__SOCKET__", SOCKET)
        run_lua(script)

    def test_hook_mission_queries_use_scripting_state(self):
        script = """
local Hook = assert(dofile('__HOOK__'))
local seen = {}
local env = {
  net = {
    dostring_in = function(state, code)
      seen[#seen + 1] = state
      if string.find(code, 'getSurfaceType', 1, true) then return '2' end
      if string.find(code, 'searchObjects', 1, true) then return '3' end
      if string.find(code, 'getAirbases', 1, true) then return '100.5,-200.25' end
      return 'table,table,table'
    end,
  },
}
local api = Hook.new(env)
local surface, why = api:land_surface_type(1, 2)
eq(surface, 2, 'hook land surface')
eq(why, nil, 'hook land surface reason')
local search, why2 = api:world_search({ x = 1, z = 2 }, 500, 8)
eq(search.visited, 3, 'hook world search')
eq(why2, nil, 'hook world search reason')
local anchor, why4 = api:mission_anchor()
eq(anchor.x, 100.5, 'anchor x')
eq(anchor.z, -200.25, 'anchor z')
eq(why4, nil, 'anchor reason')
eq(#seen, 3, 'hook mission queries')
eq(seen[1], 'scripting', 'land state')
eq(seen[2], 'scripting', 'world state')
eq(seen[3], 'scripting', 'anchor state')

local missing = Hook.new({ net = { dostring_in = function() return 'unavailable' end } })
local value, why3 = missing:land_surface_type(1, 2)
eq(value, nil, 'missing land')
starts(why3, 'missing:', 'missing land reason')
print('hook mission queries ok')
""".replace("__HOOK__", HOOK)
        run_lua(script)

    def test_mission_api_with_stub_environment(self):
        script = """
local Mission = assert(dofile('__MISSION__'))
local world = {
  searchObjects = function(category, volume, handler)
    eq(volume.id, 11, 'volume id')
    handler({})
    return true
  end,
  VolumeType = { BOX = 11 },
  event = { S_EVENT_SHOT = 1, S_EVENT_HIT = 2 },
  addEventHandler = function() return true end,
}
local land = {
  getSurfaceType = function(point) eq(point.y, 2, 'land vec2 y'); return 2 end,
  getHeight = function(point) return 123 end,
  isVisible = function(from, to) return from.x == to.x end,
}
local timer = {
  getTime = function() return 5 end,
  scheduleFunction = function(fn, at) return 1 end,
}
local coalition = {
  side = { BLUE = 2, RED = 1 },
  getCountryCoalition = function(country) return 2 end,
  getGroups = function(side) return {} end,
  getUnits = function(side) return {} end,
  getStaticObjects = function(side) return {} end,
  addGroup = function() return nil end,
}
local controller = { setTask = function() end, pushTask = function() end,
                     setCommand = function() end }
local Group = { getController = function() return {} end }
local Object = { Category = { SCENERY = 1, STATIC = 2, UNIT = 3 } }
local net = { dostring_in = function(state, code) return 'table,table,table,table' end }
local env = {
  world = world, land = land, timer = timer, coalition = coalition,
  controller = controller, Group = Group, Object = Object, net = net,
  a_do_script = function(code) return 'table,table,table,table' end,
  AESA_SAR_SCENE = { version = 2 },
  AESA_FACTS = { build = '2.9.30.28738' },
}
local api = Mission.new(env)
local search = api:world_search({ x = 1, z = 2 }, 100, 8)
eq(search.visited, 3, 'world search visited')
eq(search.provider, 'world.searchObjects', 'world search provider')
eq(api:land_surface_type(0, 2), 2, 'land surface')
eq(api:land_height(0, 2), 123, 'land height')
eq(api:land_visible({ x = 1, y = 0, z = 0 }, { x = 1, y = 0, z = 0 }), true, 'land visible')
eq(api:timer_get_time(), 5, 'timer time')
eq(api:timer_schedule(function() end, 10), 1, 'timer schedule')
local coalition_info = api:coalition_probe()
eq(coalition_info.side, true, 'coalition side')
eq(coalition_info.get_groups, true, 'coalition groups')
eq(coalition_info.get_country_coalition, true, 'coalition country')
local controller_info = api:controller_probe()
eq(controller_info.set_task, true, 'controller set task')
eq(controller_info.group_get_controller, true, 'group controller')
local dostring = api:dostring_probe()
eq(dostring.ok, true, 'dostring probe')
eq(api:dostring('scripting', 'return 1'), 'table,table,table,table', 'dostring')
eq(api:mission_global().version, 2, 'mission global')
local caps = api:capabilities()
eq(caps.search_objects, 'ok', 'cap search')
eq(caps.volume_box, 'ok', 'cap volume')
eq(caps.category_unit, 'ok', 'cap category')
eq(caps.land_surface_type, 'ok', 'cap land')
eq(caps.net_dostring, 'ok', 'cap dostring')
local adapter = api:adapter()
eq(adapter.kind, 'mission', 'adapter kind')
eq(adapter.call('timer_get_time'), 5, 'adapter timer')
print('mission ok')
""".replace("__MISSION__", MISSION)
        run_lua(script)

    def test_mission_api_missing_and_errors(self):
        script = """
local Mission = assert(dofile('__MISSION__'))
local empty = Mission.new({})
local value, why = empty:world_search({ x = 0, z = 0 }, 100, 8)
eq(value, nil, 'missing world')
starts(why, 'missing:', 'missing world reason')
value, why = empty:land_surface_type(0, 0)
eq(value, nil, 'missing land')
starts(why, 'missing:', 'missing land reason')
value, why = empty:timer_get_time()
eq(value, nil, 'missing timer')
starts(why, 'missing:', 'missing timer reason')
value, why = empty:coalition_probe()
eq(value, nil, 'missing coalition')
starts(why, 'missing:', 'missing coalition reason')
value, why = empty:dostring_probe()
eq(value, nil, 'missing dostring')
starts(why, 'missing:', 'missing dostring reason')
local empty_caps = empty:capabilities()
eq(empty_caps.search_objects, 'unavailable', 'empty cap search')
eq(empty_caps.net_dostring, 'unavailable', 'empty cap dostring')

local bad = Mission.new({
  world = {
    searchObjects = function() error('search exploded') end,
    VolumeType = { BOX = 1 },
  },
  Object = { Category = { SCENERY = 1, STATIC = 2, UNIT = 3 } },
  land = { getSurfaceType = function() return 'land' end,
           getHeight = function() error('height exploded') end,
           isVisible = function() return 1 end },
  timer = { getTime = function() return 'late' end,
            scheduleFunction = function() error('schedule exploded') end },
  coalition = { side = {}, getGroups = function() error('groups exploded') end },
  controller = { setTask = true },
  Group = { getController = true },
  net = { dostring_in = function() error('dostring exploded') end },
})
local function isolated(call)
  local ok, a, b = pcall(call)
  truthy(ok, 'wrapper must not throw')
  return a, b
end
value, why = isolated(function() return bad:world_search({ x = 0, z = 0 }, 10, 2) end)
eq(value, nil, 'search error')
starts(why, 'error:', 'search error reason')
value, why = isolated(function() return bad:land_surface_type(0, 0) end)
eq(value, nil, 'surface type error')
starts(why, 'type:', 'surface type error reason')
value, why = isolated(function() return bad:land_height(0, 0) end)
eq(value, nil, 'height error')
starts(why, 'error:', 'height error reason')
value, why = isolated(function() return bad:land_visible({ x = 0, y = 0, z = 0 }, { x = 0, y = 0, z = 0 }) end)
eq(value, nil, 'visible type error')
starts(why, 'type:', 'visible type error reason')
value, why = isolated(function() return bad:timer_get_time() end)
eq(value, nil, 'timer type error')
starts(why, 'type:', 'timer type error reason')
value, why = isolated(function() return bad:coalition_probe() end)
eq(type(value), 'table', 'coalition partial table')
eq(value.get_units, false, 'coalition partial reports missing units')
value, why = isolated(function() return bad:dostring_probe() end)
eq(value, nil, 'dostring error')
starts(why, 'error:', 'dostring error reason')
print('mission isolation ok')
""".replace("__MISSION__", MISSION)
        run_lua(script)

    def test_hook_api_with_stub_environment(self):
        script = """
local Hook = assert(dofile('__HOOK__'))
local function loadlib(path, symbol)
  if symbol == 'missing' then return nil, 'not found' end
  if symbol == 'version' then return function() return '1.2.3' end end
  return function() return 'call:' .. symbol end
end
local env = {
  DCS = { getModelTime = function() return 7 end,
          setUserCallbacks = function(callbacks) return true end },
  lfs = { writedir = function() return 'C:/Saved Games/DCS/' end,
          currentdir = function() return 'C:/DCS/bin' end },
  package = { loadlib = loadlib },
  net = { dostring_in = function(state, code) return 'table,table,table,table' end },
  a_do_script = function(code) return 'table,table,table,table' end,
  log = { INFO = 1, write = function() return true end },
  socket = { tcp = function() return {} end },
  AESA_FACTS = { build = '2.9.30.28738' },
}
local api = Hook.new(env)
eq(api:dcs_model_time(), 7, 'hook model time')
local callbacks = api:hook_callbacks()
eq(callbacks.model_time, true, 'hook model time capability')
eq(callbacks.set_user_callbacks, true, 'hook set callbacks capability')
eq(api:set_user_callbacks({}), true, 'hook set callbacks')
eq(api:writedir(), 'C:/Saved Games/DCS/', 'hook writedir')
eq(api:currentdir(), 'C:/DCS/bin', 'hook currentdir')
local symbol = api:load_symbol('x.dll', 'ok')
eq(type(symbol), 'function', 'hook load symbol')
eq(symbol(), 'call:ok', 'hook loaded call')
local missing, missing_why = api:load_symbol('x.dll', 'missing')
eq(missing, nil, 'hook missing symbol')
starts(missing_why, 'loadlib:', 'hook missing symbol reason')
local loaded = api:load('x.dll', { 'ok', 'missing' })
eq(loaded.total, 2, 'hook load total')
eq(loaded.loaded_count, 1, 'hook load count')
eq(loaded.missing[1], 'missing', 'hook load missing')
local versioned = api:load('x.dll', { 'ok' }, { version_symbol = 'version' })
eq(versioned.version, '1.2.3', 'hook load version')
local dostring = api:dostring_probe()
eq(dostring.ok, true, 'hook dostring probe')
eq(api:log_available(), true, 'hook log available')
eq(api:socket() ~= nil, true, 'hook socket')
local caps = api:capabilities()
eq(caps.dcs_model_time, 'ok', 'cap hook time')
eq(caps.dcs_set_user_callbacks, 'ok', 'cap hook callbacks')
eq(caps.loadlib, 'ok', 'cap hook loadlib')
eq(caps.net_dostring, 'ok', 'cap hook dostring')
eq(caps.log_write, 'ok', 'cap hook log')
local adapter = api:adapter()
eq(adapter.kind, 'hook', 'hook adapter kind')
eq(adapter.call('dcs_model_time'), 7, 'hook adapter call')
print('hook ok')
""".replace("__HOOK__", HOOK)
        run_lua(script)

    def test_hook_api_missing_and_errors(self):
        script = """
local Hook = assert(dofile('__HOOK__'))
local empty = Hook.new({})
local value, why = empty:dcs_model_time()
eq(value, nil, 'missing hook time')
starts(why, 'missing:', 'missing hook time reason')
value, why = empty:hook_callbacks()
eq(value, nil, 'missing hook callbacks')
starts(why, 'missing:', 'missing hook callbacks reason')
value, why = empty:load_symbol('x.dll', 'symbol')
eq(value, nil, 'missing hook loadlib')
starts(why, 'missing:', 'missing hook loadlib reason')
value, why = empty:dostring_probe()
eq(value, nil, 'missing hook dostring')
starts(why, 'missing:', 'missing hook dostring reason')
local empty_caps = empty:capabilities()
eq(empty_caps.dcs_model_time, 'unavailable', 'empty hook cap time')
eq(empty_caps.loadlib, 'unavailable', 'empty hook cap loadlib')

local bad = Hook.new({
  DCS = { getModelTime = function() error('clock exploded') end,
          setUserCallbacks = function() return false end },
  lfs = { writedir = function() return 7 end },
  package = { loadlib = function() error('loadlib exploded') end },
  net = { dostring_in = function() error('dostring exploded') end },
  log = { write = function() return false end },
})
local function isolated(call)
  local ok, a, b = pcall(call)
  truthy(ok, 'wrapper must not throw')
  return a, b
end
value, why = isolated(function() return bad:dcs_model_time() end)
eq(value, nil, 'hook time error')
starts(why, 'error:', 'hook time error reason')
value, why = isolated(function() return bad:set_user_callbacks({}) end)
eq(value, nil, 'hook set callbacks failure')
starts(why, 'error:', 'hook set callbacks failure reason')
value, why = isolated(function() return bad:writedir() end)
eq(value, nil, 'hook writedir type')
starts(why, 'invalid:', 'hook writedir type reason')
value, why = isolated(function() return bad:load_symbol('x.dll', 'symbol') end)
eq(value, nil, 'hook loadlib error')
starts(why, 'error:', 'hook loadlib error reason')
value, why = isolated(function() return bad:dostring_probe() end)
eq(value, nil, 'hook dostring error')
starts(why, 'error:', 'hook dostring error reason')
print('hook isolation ok')
""".replace("__HOOK__", HOOK)
        run_lua(script)

    def test_native_api_loads_symbols_and_reports_missing(self):
        script = """
local Native = assert(dofile('__NATIVE__'))
local function loadlib(path, symbol)
  if symbol == 'missing' then return nil, 'not found' end
  if symbol == 'version' then return function() return '1.2.3' end end
  return function() return 'call:' .. symbol end
end
local api = Native.new({ package = { loadlib = loadlib, path = '?.lua', cpath = '?.dll' } })
local symbol = api:load_symbol('x.dll', 'ok')
eq(type(symbol), 'function', 'native symbol')
eq(symbol(), 'call:ok', 'native symbol call')
local missing, missing_why = api:load_symbol('x.dll', 'missing')
eq(missing, nil, 'native missing')
starts(missing_why, 'loadlib:', 'native missing reason')
local loaded = api:load('x.dll', {
  { name = 'init', symbol = 'aesa_fc_init' },
  { name = 'version', symbol = 'version' },
  'missing',
}, { version_symbol = 'version' })
eq(loaded.total, 3, 'native total')
eq(loaded.loaded_count, 2, 'native loaded')
eq(loaded.missing[1], 'missing', 'native missing list')
eq(loaded.version, '1.2.3', 'native version')
local profile = {
  native = {
    agradar = {
      symbols = { { symbol = 'a' }, { symbol = 'b' } },
      vtable_slot = 19,
      point_on_surface_offset = 0x38,
    },
    fc = {
      symbols = { { symbol = 'c' }, { symbol = 'd' }, { symbol = 'e' } },
      sites = { { name = 'RECV_DL' }, { name = 'RECV_NET' } },
    },
  },
}
local probe = api:probe(profile.native, {
  paths = { agradar = 'agr.dll', fc = 'fc.dll' },
  agradar_version = 'agr-1',
  fc_version = 'fc-1',
  vtable_slot = 19,
  point_on_surface_offset = 0x38,
  surface_match = 2,
  surface_total = 2,
  fc_sites_loaded = 2,
  fc_sites_total = 2,
  offsets_ok = true,
  hashes_ok = true,
})
eq(probe.agradar.symbols.loaded, 2, 'native agr loaded')
eq(probe.agradar.symbols.total, 2, 'native agr total')
eq(probe.agradar.vtable_match, true, 'native vtable')
eq(probe.fc.symbols.loaded, 3, 'native fc loaded')
eq(probe.fc.sites.loaded, 2, 'native fc sites')
eq(probe.fc.offsets_ok, true, 'native offsets')
eq(probe.hashes.ok, true, 'native hashes')
local caps = api:capabilities()
eq(caps.loadlib, 'ok', 'native cap loadlib')
eq(caps.package_cpath, '?.dll', 'native cpath')
local empty = Native.new({})
missing, missing_why = empty:load_symbol('x.dll', 'symbol')
eq(missing, nil, 'native empty loadlib')
starts(missing_why, 'missing:', 'native empty loadlib reason')
local empty_probe = empty:probe(profile.native, { paths = { agradar = 'x.dll' } })
starts(empty_probe.agradar.error, 'missing:', 'native probe missing loadlib')
print('native ok')
""".replace("__NATIVE__", NATIVE)
        run_lua(script)

    def test_api_adapters_feed_probe_operation_names(self):
        script = """
local profile = assert(dofile('__PROFILE__')).new(assert(dofile('__CONCRETE__')))
local probe = assert(dofile('__PROBE__'))
local Export = assert(dofile('__EXPORT__'))
local Hook = assert(dofile('__HOOK__'))
local Mission = assert(dofile('__MISSION__'))

local export_env = {
  LoGetModelTime = function() return 12.5 end,
  LoGetSelfData = function()
    return { Position = { x = 1, y = 2, z = 3 }, Heading = 0.1, Pitch = 0.2, Bank = 0.3 }
  end,
  LoGetVectorVelocity = function() return { x = 1, y = 0, z = 2 } end,
  LoGetWorldObjects = function()
    return { [1] = { Position = { x = 1, y = 2, z = 3 }, CoalitionID = 1 } }
  end,
  LoGetTargetInformation = function() return {} end,
  terrain = {
    GetHeight = function() return 100 end,
    GetSurfaceType = function() return 1 end,
    isVisible = function() return true end,
  },
  LoGeoCoordinatesToLoCoordinates = function(lon, lat) return lon, lat end,
  LoLoCoordinatesToGeoCoordinates = function(x, z) return { latitude = z, longitude = x } end,
  lfs = { writedir = function() return 'C:/Saved Games/DCS/' end },
  log = { write = function() return true end },
  socket = { tcp = function() return {} end },
  package = { loadlib = function() return function() end end },
  AESA_FACTS = { build = '2.9.30.28738', variant = 'MT',
                 export_callbacks = { loaded = true, after_next_frame = true,
                                      activity_next_event = 'passthrough' } },
}
local export_result = probe.run(profile, Export.new(export_env):adapter(), {})
eq(export_result.caps['EXP-SELF'].state, 'ok', 'probe export self')
eq(export_result.caps['EXP-TIME'].state, 'ok', 'probe export time')
eq(export_result.caps['EXP-GEO'].state, 'ok', 'probe export geo')
eq(export_result.caps['TER-GH'].state, 'ok', 'probe export terrain')
eq(export_result.caps['TER-GST'].state, 'ok', 'probe export surface')
eq(export_result.caps['TER-VIS'].state, 'ok', 'probe export visibility')
eq(export_result.caps['IO-SOCK'].state, 'ok', 'probe export socket')
eq(export_result.caps['IO-LFS'].state, 'ok', 'probe export lfs')
eq(export_result.caps['IO-LOADLIB'].state, 'ok', 'probe export loadlib')
eq(export_result.caps['IO-LOG'].state, 'ok', 'probe export log')
eq(export_result.caps['EXP-LOAD'].state, 'ok', 'probe export load')
eq(export_result.caps['WLD-SEARCH'].state, 'unknown', 'probe export mission gap')

local hook_env = {
  DCS = { getModelTime = function() return 7 end,
          setUserCallbacks = function() return true end },
  lfs = { writedir = function() return 'C:/Saved Games/DCS/' end },
  package = { loadlib = function() return function() end end },
  net = { dostring_in = function() return 'table,table,table,table' end },
  log = { write = function() return true end },
  socket = { tcp = function() return {} end },
}
local hook_result = probe.run(profile, Hook.new(hook_env):adapter(), {})
eq(hook_result.caps['HOOK-CB'].state, 'ok', 'probe hook callbacks')
eq(hook_result.caps['MSN-DOSTRING'].state, 'ok', 'probe hook dostring')
eq(hook_result.caps['IO-SOCK'].state, 'ok', 'probe hook socket')
eq(hook_result.caps['IO-LFS'].state, 'ok', 'probe hook lfs')
eq(hook_result.caps['IO-LOADLIB'].state, 'ok', 'probe hook loadlib')
eq(hook_result.caps['IO-LOG'].state, 'ok', 'probe hook log')
eq(hook_result.caps['EXP-SELF'].state, 'unknown', 'probe hook export gap')

local mission_env = {
  world = {
    searchObjects = function(category, volume, handler) handler({}); return true end,
    VolumeType = { BOX = 1 },
  },
  Object = { Category = { SCENERY = 1, STATIC = 2, UNIT = 3 } },
  land = { getSurfaceType = function() return 1 end },
  net = { dostring_in = function() return 'table,table,table,table' end },
  coalition = {
    side = { BLUE = 2 },
    getGroups = function() return {} end,
    getUnits = function() return {} end,
    getCountryCoalition = function() return 2 end,
  },
  controller = { setTask = function() end },
  Group = { getController = function() end },
  AESA_SAR_SCENE = { version = 1 },
}
local mission_result = probe.run(profile, Mission.new(mission_env):adapter(), {})
eq(mission_result.caps['WLD-SEARCH'].state, 'ok', 'probe mission search')
eq(mission_result.caps['LND-SURF'].state, 'ok', 'probe mission land')
eq(mission_result.caps['MSN-DOSTRING'].state, 'ok', 'probe mission dostring')
eq(mission_result.caps['MSN-COAL'].state, 'ok', 'probe mission coalition')
eq(mission_result.caps['MSN-LIFE'].state, 'ok', 'probe mission life')
eq(mission_result.caps['HOOK-CB'].state, 'unknown', 'probe mission hook gap')
eq(mission_result.caps['EXP-SELF'].state, 'unknown', 'probe mission export gap')
print('adapter probe integration ok')
""".replace("__PROFILE__", PROFILE).replace("__PROBE__", PROBE).replace(
            "__CONCRETE__", CONCRETE
        ).replace("__EXPORT__", EXPORT).replace("__HOOK__", HOOK).replace(
            "__MISSION__", MISSION
        )
        run_lua(script)

    def test_api_modules_are_pure_lua_51(self):
        for relative in (
            "src/adapters/dcs/api/export.lua",
            "src/adapters/dcs/api/mission.lua",
            "src/adapters/dcs/api/hook.lua",
            "src/adapters/dcs/api/native.lua",
        ):
            source = (ROOT / relative).read_text(encoding="utf-8")
            code = "\n".join(line.split("--", 1)[0] for line in source.splitlines())
            self.assertIsNone(
                re.search(r"(?<![.:\w])require\s*\(", code),
                f"{relative}: must not call a global require()",
            )
            self.assertNotRegex(code, r"\bdofile\s*\(")
            self.assertNotRegex(code, r"\bloadfile\s*\(")
            self.assertNotRegex(code, r"\bloadstring\s*\(")
            self.assertNotRegex(code, r"\bio\.")
            self.assertNotRegex(code, r"\bos\.")
            self.assertNotRegex(code, r"\bdebug\.")
            self.assertIn("return ", source)

    def test_node_compat_check_suite_is_covered(self):
        # test_all discovers Python test_gate*.py files; keep the Node CLI suite
        # in that discovery path without changing scripts/test_all.cjs.
        node = shutil.which("node")
        if not node:
            self.skipTest("node not found")
        result = subprocess.run(
            [node, "--test", "tests/test_gate3_compat_check.cjs"],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=300,
        )
        self.assertEqual(
            result.returncode,
            0,
            f"Gate 3 compat_check Node suite failed\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}",
        )


if __name__ == "__main__":
    unittest.main()

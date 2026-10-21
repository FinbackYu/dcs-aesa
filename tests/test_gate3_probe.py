import unittest
from pathlib import Path

try:
    from lupa import lua51
except ImportError:  # pragma: no cover - environment guard
    lua51 = None

ROOT = Path(__file__).resolve().parents[1]
PROFILE_LUA = (ROOT / "src/adapters/dcs/compat/profile.lua").as_posix()
PROBE_LUA = (ROOT / "src/adapters/dcs/compat/probe.lua").as_posix()
CONCRETE_LUA = (ROOT / "src/adapters/dcs/compat/profiles/dcs-2.9.30.28738-mt.lua").as_posix()
PROFILE_ID = "dcs-2.9.30.28738-mt"

PRELUDE = """
local P = assert(dofile('__PROFILE__'))
local probe = assert(dofile('__PROBE__'))
local profile = P.new(assert(dofile('__CONCRETE__')))

local function eq(a, b, msg)
  assert(a == b, tostring(msg) .. ': expected ' .. tostring(b) .. ', got ' .. tostring(a))
end
local function truthy(value, msg)
  assert(value, msg)
end
local function make_api(kind, ops, facts, data, native, globals)
  local function call(name, ...)
    local fn = ops[name]
    if type(fn) ~= 'function' then return nil, 'missing:' .. name end
    local ok, a, b = pcall(fn, ...)
    if not ok then return nil, 'error:' .. tostring(a) end
    return a, b
  end
  return {
    kind = kind,
    call = call,
    facts = facts or {},
    data = data or {},
    native = native,
    globals = globals,
  }
end

local function native_ok()
  return {
    agradar = {
      symbols = { loaded = 7, total = 7, missing = {} },
      vtable_match = true,
      surface_match = 16,
      surface_total = 16,
    },
    fc = {
      symbols = { loaded = 9, total = 9, missing = {} },
      sites = { loaded = 13, total = 13 },
      offsets_ok = true,
    },
    hashes = { ok = true, detail = 'module/export hash' },
  }
end

local function data_ok()
  local shader = profile:get('shader')
  return {
    rcs = {
      schema = 1,
      entries = 50,
      fallbacks = { fighter = true, large = true, helicopter = true, missile = true },
    },
    rcs_coverage = 0.95,
    radar_fx_sha256 = shader.radar_fx_sha256,
    radar_lua_sha256 = shader.radar_lua_sha256,
  }
end

local function facts_ok()
  return {
    build = '2.9.30.28738',
    variant = 'MT',
    export_callbacks = { loaded = true, after_next_frame = true,
                         activity_next_event = 'passthrough' },
  }
end

local function ops_ok()
  return {
    self_data = function()
      return { Position = { x = 1, y = 2, z = 3 }, Heading = 0.1, Pitch = 0.2,
               Bank = 0.3, Type = 'F-16C_50' }
    end,
    world_objects = function()
      return { [100] = { Position = { x = 1, y = 2, z = 3 }, CoalitionID = 1 } }
    end,
    model_time = function() return 10.5 end,
    vector_velocity = function() return { x = 10, y = 0, z = 20 } end,
    target_information = function() return { [1] = { ID = 1 } } end,
    geo_forward = function(lon, lat) return lon * 1000, lat * 2000 end,
    geo_inverse = function(x, z) return { latitude = z / 2000, longitude = x / 1000 } end,
    altitude = function() return 1000 end,
    terrain_height = function() return 100 end,
    terrain_surface_type = function() return 1 end,
    terrain_visible = function() return true end,
    world_search = function() return { visited = 1, categories = { 'UNIT' } } end,
    land_surface_type = function() return 1 end,
    land_height = function() return 100 end,
    land_visible = function() return true end,
    timer_get_time = function() return 10 end,
    timer_schedule = function() return 1 end,
    coalition_probe = function()
      return { side = true, get_country_coalition = true, get_groups = true,
               get_units = true, get_static_objects = true, add_group = true }
    end,
    controller_probe = function()
      return { table = true, set_task = true, push_task = true, set_command = true,
               group_get_controller = true }
    end,
    dostring_probe = function()
      return { ok = true, result = 'table,table,table,table', provider = 'net.dostring_in(scripting)' }
    end,
    mission_global = function() return { version = 1, job = nil } end,
    hook_callbacks = function() return { model_time = true, set_user_callbacks = true } end,
    socket_probe = function() return { tcp = function() return {} end } end,
    writedir = function() return 'C:/Saved Games/DCS/' end,
    currentdir = function() return 'C:/DCS/bin' end,
    loadlib_available = function() return true end,
    log_available = function() return true end,
    native_info = function() return native_ok() end,
  }
end
"""


def run_lua(script):
    if lua51 is None:
        raise unittest.SkipTest("lupa.lua51 is not installed")
    runtime = lua51.LuaRuntime(unpack_returned_tuples=True)
    prelude = (
        PRELUDE.replace("__PROFILE__", PROFILE_LUA)
        .replace("__PROBE__", PROBE_LUA)
        .replace("__CONCRETE__", CONCRETE_LUA)
    )
    try:
        runtime.execute(prelude + script)
    except Exception as error:
        raise AssertionError(f"Lua assertion failed: {error}\nscript:\n{script}") from error


class Gate3ProbeTest(unittest.TestCase):
    def test_ok_matrix_format_and_parse_roundtrip(self):
        script = """
local api = make_api('export', ops_ok(), facts_ok(), data_ok(), native_ok())
local result = probe.run(profile, api, {})
eq(result.profile_id, '__PROFILE_ID__', 'profile id')
eq(result.matrix_hash, profile:matrix_hash(), 'matrix hash')
eq(result.complete, true, 'complete')
eq(#result.errors, 0, 'no probe errors')
local cap_total = 0
for _ in pairs(result.caps) do cap_total = cap_total + 1 end
truthy(cap_total >= 39, 'cap count')
local expected = {
  BUILD = 'ok', ['EXP-LOAD'] = 'ok', ['EXP-AFTER'] = 'ok', ['EXP-ACT'] = 'ok',
  ['EXP-SELF'] = 'ok', ['EXP-WORLD'] = 'ok', ['EXP-TIME'] = 'ok', ['EXP-VEL'] = 'ok',
  ['EXP-TGT'] = 'ok', ['EXP-GEO'] = 'ok', ['EXP-ALT'] = 'degraded',
  ['TER-GH'] = 'ok', ['TER-GST'] = 'ok', ['TER-VIS'] = 'ok',
  ['WLD-SEARCH'] = 'ok', ['LND-SURF'] = 'ok', ['MSN-DOSTRING'] = 'ok',
  ['MSN-COAL'] = 'ok', ['MSN-LIFE'] = 'ok', ['HOOK-CB'] = 'ok',
  ['IO-SOCK'] = 'ok', ['IO-LFS'] = 'ok', ['IO-LOADLIB'] = 'ok', ['IO-LOG'] = 'ok',
  ['NET-PORT'] = 'unknown', ['NAT-AGR-SYM'] = 'ok', ['NAT-AGR-VT'] = 'ok',
  ['NAT-AGR-MASK'] = 'ok', ['NAT-FC-SYM'] = 'ok', ['NAT-FC-SITES'] = 'ok',
  ['NAT-FC-OFF'] = 'ok', ['NAT-HASH'] = 'ok', ['DAT-RCS'] = 'ok',
  ['DAT-RCS-COV'] = 'ok', ['GFX-RADARFX'] = 'ok', ['GFX-PRESET'] = 'ok',
  ['MODULE'] = 'unknown', ['MAP'] = 'unknown', ['MODS'] = 'unknown',
}
for key, state in pairs(expected) do
  truthy(result.caps[key], 'missing cap ' .. key)
  eq(result.caps[key].state, state, 'cap state ' .. key)
end

local text = probe.format(result)
local lines = {}
for line in string.gmatch(text .. '\\n', '([^\\n]*)\\n') do lines[#lines + 1] = line end
truthy(#lines >= 3, 'format lines')
local first = lines[1]
eq(string.sub(first, 1, 13), 'COMPAT_BEGIN,', 'begin prefix')
eq(first, 'COMPAT_BEGIN,__PROFILE_ID__,' .. profile:matrix_hash(), 'begin line')
local last = lines[#lines]
local end_count = string.match(last, '^COMPAT_END,(%d+)$')
truthy(end_count, 'end line')
local cap_count = 0
local previous = ''
for index = 2, #lines - 1 do
  local line = lines[index]
  if string.sub(line, 1, 4) == 'CAP,' then
    cap_count = cap_count + 1
    local key, state, detail = string.match(line, '^CAP,([^,]+),([a-z]+),(.*)$')
    truthy(key and state and detail, 'cap line shape ' .. line)
    truthy(key > previous, 'cap keys sorted at ' .. key)
    previous = key
    truthy(string.find(detail, ',', 1, true) == nil, 'detail has comma')
    truthy(string.find(detail, '\\n', 1, true) == nil, 'detail has newline')
    truthy(#line <= 512, 'cap line length')
  end
end
eq(tonumber(end_count), cap_count, 'end count')
local parsed = probe.parse(text)
eq(parsed.complete, true, 'parse complete')
eq(parsed.profile_id, '__PROFILE_ID__', 'parse profile id')
eq(parsed.matrix_hash, profile:matrix_hash(), 'parse matrix hash')
eq(parsed.cap_count_actual, cap_count, 'parse cap count')
eq(parsed.count_mismatch, false, 'parse count mismatch')
for key, cap in pairs(result.caps) do
  truthy(parsed.caps[key], 'parse missing ' .. key)
  eq(parsed.caps[key].state, cap.state, 'parse state ' .. key)
  eq(parsed.caps[key].detail, cap.detail, 'parse detail ' .. key)
end
truthy(parsed.facts.build == '2.9.30.28738', 'parse build fact')
print('probe ok matrix')
""".replace("__PROFILE_ID__", PROFILE_ID)
        run_lua(script)

    def test_surface_type_accepts_number_or_name(self):
        script = """
local function run_with(value)
  local ops = ops_ok()
  ops.terrain_surface_type = function() return value end
  return probe.run(profile, make_api('export', ops, facts_ok(), data_ok(), native_ok()), {})
end

local named = run_with('land')
eq(named.caps['TER-GST'].state, 'ok', 'name surface ok')
eq(named.caps['TER-GST'].detail, 'name=land', 'name surface detail')

local upper = run_with('Land')
eq(upper.caps['TER-GST'].state, 'ok', 'case-insensitive surface ok')
eq(upper.caps['TER-GST'].detail, 'name=land', 'case-insensitive surface detail')

local numeric = run_with(4)
eq(numeric.caps['TER-GST'].state, 'ok', 'numeric surface ok')
eq(numeric.caps['TER-GST'].detail, 'class=4', 'numeric surface detail')

local outside = run_with(9)
eq(outside.caps['TER-GST'].state, 'degraded', 'outside surface degraded')

local unknown = run_with('swamp')
eq(unknown.caps['TER-GST'].state, 'degraded', 'unknown name degraded')
eq(unknown.caps['TER-GST'].detail, 'name=swamp', 'unknown name detail')
print('surface forms')
""".replace("__PROFILE_ID__", PROFILE_ID)
        run_lua(script)

    def test_world_search_uses_mission_anchor_when_available(self):
        script = """
local ops = ops_ok()
local seen = nil
ops.mission_anchor = function() return { x = 111.5, z = -222.25 } end
ops.world_search = function(point, radius, limit)
  seen = { x = point.x, z = point.z, radius = radius, limit = limit }
  return { visited = 4 }
end
local result = probe.run(profile, make_api('hook', ops, facts_ok(), data_ok(), native_ok()), {})
eq(result.caps['WLD-SEARCH'].state, 'ok', 'anchored search ok')
eq(seen.x, 111.5, 'anchored x')
eq(seen.z, -222.25, 'anchored z')
eq(seen.radius, 2000, 'anchored radius')

local fallback = nil
ops = ops_ok()
ops.world_search = function(point) fallback = point; return { visited = 2 } end
local second = probe.run(profile, make_api('hook', ops, facts_ok(), data_ok(), native_ok()), {})
eq(second.caps['WLD-SEARCH'].state, 'ok', 'fallback search ok')
eq(fallback.x, 1, 'fallback x')
eq(fallback.z, 3, 'fallback z')
print('world search anchor')
""".replace("__PROFILE_ID__", PROFILE_ID)
        run_lua(script)

    def test_degraded_matrix_is_reported_per_capability(self):
        script = """
local ops = ops_ok()
ops.self_data = function() return { Position = { x = 1, y = 2, z = 3 } } end
ops.world_objects = function()
  return { [1] = { Position = { x = 1, y = 2, z = 3 } } }
end
ops.vector_velocity = function() return { x = 0, y = 0, z = 0 } end
ops.target_information = function() return {} end
ops.geo_inverse = function() return { latitude = 0, longitude = 0 } end
ops.terrain_height = function() return nil, 'missing:terrain_height' end
ops.terrain_surface_type = function() return 99 end
ops.terrain_visible = function() return false end
ops.world_search = function() return { visited = 0 } end
ops.land_surface_type = function() return 9 end
ops.dostring_probe = function() return nil, 'error:permission' end
ops.coalition_probe = function() return { side = true, get_groups = true } end
ops.mission_global = function() return {} end
ops.hook_callbacks = function() return { model_time = true, set_user_callbacks = false } end
ops.socket_probe = function() return nil, 'missing:socket' end
ops.writedir = function() return nil, 'missing:lfs.writedir' end
ops.loadlib_available = function() return false end
ops.log_available = function() return false end
ops.native_info = function()
  return {
    agradar = {
      symbols = { loaded = 2, total = 4, missing = { 'a', 'b' } },
      vtable_match = false,
      surface_match = 12,
      surface_total = 16,
    },
    fc = {
      symbols = { loaded = 10, total = 17, missing = {} },
      sites = { loaded = 5, total = 13 },
      offsets_ok = false,
    },
    hashes = { ok = false, detail = 'hash mismatch' },
  }
end
local data = data_ok()
data.rcs.fallbacks.missile = nil
data.rcs_coverage = 0.5
data.radar_fx_sha256 = 'deadbeef'
data.radar_lua_sha256 = 'deadbeef'
local facts = facts_ok()
facts.build = '9.9.9.9'
facts.net_port = { free = false }
local api = make_api('export', ops, facts, data)
local result = probe.run(profile, api, {})
local expected = {
  BUILD = 'degraded',
  ['EXP-SELF'] = 'degraded',
  ['EXP-WORLD'] = 'degraded',
  ['EXP-VEL'] = 'degraded',
  ['EXP-TGT'] = 'degraded',
  ['EXP-GEO'] = 'degraded',
  ['EXP-ALT'] = 'degraded',
  ['TER-GH'] = 'unavailable',
  ['TER-GST'] = 'degraded',
  ['TER-VIS'] = 'degraded',
  ['WLD-SEARCH'] = 'degraded',
  ['LND-SURF'] = 'degraded',
  ['MSN-DOSTRING'] = 'degraded',
  ['MSN-COAL'] = 'degraded',
  ['MSN-LIFE'] = 'degraded',
  ['HOOK-CB'] = 'degraded',
  ['IO-SOCK'] = 'unavailable',
  ['IO-LFS'] = 'unavailable',
  ['IO-LOADLIB'] = 'unavailable',
  ['IO-LOG'] = 'unavailable',
  ['NET-PORT'] = 'degraded',
  ['NAT-AGR-SYM'] = 'degraded',
  ['NAT-AGR-VT'] = 'unavailable',
  ['NAT-AGR-MASK'] = 'degraded',
  ['NAT-FC-SYM'] = 'degraded',
  ['NAT-FC-SITES'] = 'degraded',
  ['NAT-FC-OFF'] = 'unavailable',
  ['NAT-HASH'] = 'unavailable',
  ['DAT-RCS'] = 'unavailable',
  ['DAT-RCS-COV'] = 'degraded',
  ['GFX-RADARFX'] = 'degraded',
  ['GFX-PRESET'] = 'degraded',
}
for key, state in pairs(expected) do
  truthy(result.caps[key], 'missing cap ' .. key)
  eq(result.caps[key].state, state, 'degraded cap ' .. key)
end
eq(result.caps['EXP-TIME'].state, 'ok', 'unaffected time')
eq(result.caps['EXP-LOAD'].state, 'ok', 'unaffected load')
local text = probe.format(result)
truthy(string.find(text, 'CAP,TER-GH,unavailable,', 1, true), 'formatted TER-GH')
local parsed = probe.parse(text)
eq(parsed.caps['TER-GH'].state, 'unavailable', 'parsed TER-GH')
print('probe degraded')
""".replace("__PROFILE_ID__", PROFILE_ID)
        run_lua(script)

    def test_missing_environment_yields_unavailable_or_unknown(self):
        script = """
local api = make_api('export', {}, {})
local result = probe.run(profile, api, {})
eq(result.caps['BUILD'].state, 'unknown', 'missing build')
eq(result.caps['EXP-LOAD'].state, 'unknown', 'missing load')
eq(result.caps['EXP-SELF'].state, 'unavailable', 'missing self')
eq(result.caps['TER-GH'].state, 'unavailable', 'missing terrain')
eq(result.caps['WLD-SEARCH'].state, 'unknown', 'search not probed in export')
eq(result.caps['HOOK-CB'].state, 'unknown', 'hook not probed in export')
eq(result.caps['IO-SOCK'].state, 'unavailable', 'missing socket')
eq(result.caps['NAT-AGR-SYM'].state, 'unknown', 'missing native')
eq(result.caps['NAT-FC-SYM'].state, 'unknown', 'missing native fc')
eq(result.caps['DAT-RCS'].state, 'unknown', 'missing rcs')
eq(result.caps['GFX-RADARFX'].state, 'unknown', 'missing shader')
eq(result.caps['NET-PORT'].state, 'unknown', 'missing port')
truthy(#result.errors == 0, 'missing api is not a probe error')
local text = probe.format(result)
local parsed = probe.parse(text)
eq(parsed.complete, true, 'missing parse complete')
eq(parsed.caps['EXP-SELF'].state, 'unavailable', 'missing parsed self')
print('probe missing')
""".replace("__PROFILE_ID__", PROFILE_ID)
        run_lua(script)

    def test_single_capability_failure_is_isolated_and_detail_truncated(self):
        script = """
local ops = ops_ok()
ops.model_time = function() error(string.rep('x', 400)) end
local api = make_api('export', ops, facts_ok(), data_ok(), native_ok())
local dispatch = api.call
api.call = function(name, ...)
  if name == 'model_time' then error('dispatch exploded') end
  return dispatch(name, ...)
end
local ok_run, result = pcall(probe.run, profile, api, {})
truthy(ok_run, 'probe.run must not throw')
eq(result.caps['EXP-TIME'].state, 'degraded', 'failed time')
eq(result.caps['EXP-SELF'].state, 'ok', 'self survives time failure')
eq(result.caps['TER-GH'].state, 'ok', 'terrain survives time failure')
local detail = result.caps['EXP-TIME'].detail
truthy(string.sub(detail, 1, 6) == 'error:', 'error detail')
truthy(#detail <= 200, 'detail truncated')
truthy(string.find(detail, ',', 1, true) == nil, 'detail comma')
truthy(string.find(detail, '\\n', 1, true) == nil, 'detail newline')
local text = probe.format(result)
for line in string.gmatch(text .. '\\n', '([^\\n]*)\\n') do
  truthy(#line <= 512, 'line length')
end
print('probe isolation')
""".replace("__PROFILE_ID__", PROFILE_ID)
        run_lua(script)

    def test_parse_ignores_outside_caps_and_unescapes_facts(self):
        script = """
local text = table.concat({
  'CAP,OUTSIDE,ok,ignored',
  'prefix COMPAT_BEGIN,dcs-1.2.3.4,abc12345',
  'CAP,TER-GH,ok,height=1',
  'FACT,note,a\\\\,b',
  'CAP,TER-GH,degraded,latest',
  'CAP,BAD,broken,ignored',
  'COMPAT_END,2',
  'CAP,OUTSIDE2,ok,ignored',
}, '\\n')
local parsed = probe.parse(text)
eq(parsed.complete, true, 'parse complete')
eq(parsed.profile_id, 'dcs-1.2.3.4', 'parse id')
eq(parsed.matrix_hash, 'abc12345', 'parse hash')
eq(parsed.caps['OUTSIDE'], nil, 'outside cap ignored')
eq(parsed.caps['OUTSIDE2'], nil, 'outside cap 2 ignored')
eq(parsed.caps['BAD'], nil, 'invalid state ignored')
eq(parsed.caps['TER-GH'].state, 'degraded', 'duplicate last wins')
eq(parsed.facts.note, 'a,b', 'fact unescape')
eq(parsed.cap_count_actual, 1, 'actual cap count')
eq(parsed.count_mismatch, true, 'count mismatch detected')
local empty = probe.parse('no compat block here')
eq(empty.complete, false, 'missing block')
eq(empty.caps['TER-GH'], nil, 'missing block caps')
print('probe parse')
""".replace("__PROFILE_ID__", PROFILE_ID)
        run_lua(script)

    def test_profile_instance_and_raw_table_hash_agree(self):
        script = """
local raw = assert(dofile('__CONCRETE__'))
local raw_result = probe.run(raw, make_api('export', {}, {}), {})
eq(raw_result.profile_id, '__PROFILE_ID__', 'raw profile id')
eq(raw_result.matrix_hash, profile:matrix_hash(), 'raw matrix hash')
local api = make_api('export', ops_ok(), facts_ok(), data_ok(), native_ok())
local instance_result = probe.run(profile, api, {})
eq(instance_result.matrix_hash, raw_result.matrix_hash, 'instance/raw hash')
print('probe profile access')
""".replace("__PROFILE_ID__", PROFILE_ID).replace("__CONCRETE__", CONCRETE_LUA)
        run_lua(script)


if __name__ == "__main__":
    unittest.main()

-- DCS Hooks environment adapter (Lua 5.1, no require/io/os).
-- The caller injects the Hooks globals; wrappers type-check and isolate errors.
--
-- Reason prefixes: missing:<name>, type:<name>, invalid:<name>, error:<text>,
-- loadlib:<text>.

local Hook = {}
Hook.SCHEMA = 1
Hook.KIND = "hook"

local function finite(value)
    return type(value) == "number" and value == value
        and value ~= math.huge and value ~= -math.huge
end

local function invoke(fn, ...)
    if type(fn) ~= "function" then return false, nil, "missing:function" end
    local ok, a, b = pcall(fn, ...)
    if not ok then return false, nil, "error:" .. tostring(a) end
    return true, a, b
end

local function node(env, key)
    if type(env) ~= "table" then return nil end
    local value = env[key]
    if type(value) == "table" then return value end
    return nil
end

local function fn_at(env, key)
    if type(env) ~= "table" then return nil end
    if type(env[key]) == "function" then return env[key] end
    return nil
end

local function fn_in(env, group, key)
    local value = node(env, group)
    if value and type(value[key]) == "function" then return value[key] end
    return nil
end

local function symbol_list(symbols)
    local list = {}
    if type(symbols) ~= "table" then return list end
    local numeric = 0
    for key in pairs(symbols) do
        if type(key) == "number" then numeric = numeric + 1 end
    end
    if numeric > 0 then
        for index = 1, #symbols do
            local item = symbols[index]
            if type(item) == "string" and item ~= "" then
                list[#list + 1] = { name = item, symbol = item }
            elseif type(item) == "table" and type(item.symbol) == "string" then
                list[#list + 1] = {
                    name = type(item.name) == "string" and item.name or item.symbol,
                    symbol = item.symbol,
                    module = item.module,
                }
            end
        end
    else
        local keys = {}
        for key, value in pairs(symbols) do
            if type(key) == "string" and type(value) == "string" then
                keys[#keys + 1] = key
            end
        end
        table.sort(keys)
        for _, key in ipairs(keys) do
            list[#list + 1] = { name = key, symbol = symbols[key] }
        end
    end
    return list
end

local methods = {}

function methods:dcs_model_time()
    local ok, value, why = invoke(fn_in(self.env, "DCS", "getModelTime"))
    if not ok then return nil, why end
    if not finite(value) then return nil, "type:DCS.getModelTime.result" end
    return value
end

function methods:hook_callbacks()
    local dcs = node(self.env, "DCS")
    if not dcs then return nil, "missing:DCS" end
    return {
        model_time = type(dcs.getModelTime) == "function",
        set_user_callbacks = type(dcs.setUserCallbacks) == "function",
    }
end

function methods:set_user_callbacks(callbacks)
    if type(callbacks) ~= "table" then return nil, "type:set_user_callbacks.table" end
    local fn = fn_in(self.env, "DCS", "setUserCallbacks")
    if not fn then return nil, "missing:DCS.setUserCallbacks" end
    local ok, value, why = invoke(fn, callbacks)
    if not ok then return nil, why end
    if value == false then return nil, "error:DCS.setUserCallbacks" end
    return true
end

function methods:writedir()
    local ok, value, why = invoke(fn_in(self.env, "lfs", "writedir"))
    if not ok then return nil, why end
    if type(value) ~= "string" or value == "" then return nil, "invalid:lfs.writedir" end
    return value
end

function methods:currentdir()
    local ok, value, why = invoke(fn_in(self.env, "lfs", "currentdir"))
    if not ok then return nil, why end
    if type(value) ~= "string" or value == "" then return nil, "invalid:lfs.currentdir" end
    return value
end

function methods:load_symbol(path, symbol)
    local package_table = node(self.env, "package")
    if not package_table or type(package_table.loadlib) ~= "function" then
        return nil, "missing:package.loadlib"
    end
    if type(path) ~= "string" or path == "" then return nil, "type:load_symbol.path" end
    if type(symbol) ~= "string" or symbol == "" then return nil, "type:load_symbol.symbol" end
    local ok, value, err = invoke(package_table.loadlib, path, symbol)
    if not ok then return nil, err end
    if type(value) ~= "function" then
        return nil, "loadlib:" .. tostring(err or "nil")
    end
    return value
end

function methods:load(path, symbols, opts)
    opts = opts or {}
    if type(path) ~= "string" or path == "" then return nil, "type:load.path" end
    local package_table = node(self.env, "package")
    if not package_table or type(package_table.loadlib) ~= "function" then
        return nil, "missing:package.loadlib"
    end
    local list = symbol_list(symbols)
    local result = {
        path = path,
        total = #list,
        loaded = {},
        loaded_count = 0,
        missing = {},
        missing_symbols = {},
        version = nil,
        version_error = nil,
    }
    for _, entry in ipairs(list) do
        local fn, why = self:load_symbol(path, entry.symbol)
        if fn then
            result.loaded[entry.name] = fn
            result.loaded_count = result.loaded_count + 1
        else
            result.missing[#result.missing + 1] = entry.symbol
            result.missing_symbols[#result.missing_symbols + 1] = {
                name = entry.name,
                symbol = entry.symbol,
                reason = why,
            }
        end
    end
    if opts.version_symbol then
        local fn, why = self:load_symbol(path, opts.version_symbol)
        if fn then
            local ok, value, why2 = invoke(fn)
            if ok then
                result.version = value
            else
                result.version_error = why2
            end
        else
            result.version_error = why
        end
    elseif opts.version ~= nil then
        result.version = opts.version
    end
    return result
end

function methods:loadlib_available()
    local package_table = node(self.env, "package")
    if not package_table or type(package_table.loadlib) ~= "function" then
        return nil, "missing:package.loadlib"
    end
    return true
end

function methods:socket_probe()
    return self:socket()
end

function methods:dostring(state, code)
    if type(state) ~= "string" or type(code) ~= "string" then
        return nil, "type:net.dostring_in"
    end
    local net = node(self.env, "net")
    if not net or type(net.dostring_in) ~= "function" then
        return nil, "missing:net.dostring_in"
    end
    local ok, value, why = invoke(net.dostring_in, state, code)
    if not ok then return nil, why end
    return value
end

local PROBE_CODE = "return type(land)..','..type(world)..','..type(timer)..','..type(a_do_script)"

function methods:dostring_probe()
    local attempts = {}
    local net = node(self.env, "net")
    if net and type(net.dostring_in) == "function" then
        local ok, value = invoke(net.dostring_in, "scripting", PROBE_CODE)
        if ok and type(value) == "string" then
            return { ok = true, result = value, provider = "net.dostring_in(scripting)" }
        end
        attempts[#attempts + 1] = "net.dostring_in(scripting)"
    end
    local direct = fn_at(self.env, "a_do_script")
    if direct then
        local ok, value = invoke(direct, PROBE_CODE)
        if ok and type(value) == "string" then
            return { ok = true, result = value, provider = "a_do_script" }
        end
        attempts[#attempts + 1] = "a_do_script"
    end
    if #attempts == 0 then return nil, "missing:net.dostring_in" end
    return nil, "error:dostring:" .. table.concat(attempts, "+")
end

function methods:log_available()
    local log_table = node(self.env, "log")
    if not log_table or type(log_table.write) ~= "function" then
        return nil, "missing:log.write"
    end
    return true
end

function methods:log_write(tag, level, message)
    if type(tag) ~= "string" or tag == "" then return nil, "type:log.write.tag" end
    local log_table = node(self.env, "log")
    local fn = fn_in(self.env, "log", "write")
    if not fn then return nil, "missing:log.write" end
    local text, severity
    if type(message) == "string" then
        text, severity = message, level
    else
        text, severity = level, nil
    end
    if type(text) ~= "string" then return nil, "type:log.write.message" end
    if severity == nil then
        severity = log_table and type(log_table.INFO) == "number" and log_table.INFO or 1
    end
    local ok, value, why = invoke(fn, tag, severity, text)
    if not ok then return nil, why end
    if value == false then return nil, "error:log.write" end
    return true
end

function methods:socket()
    local direct = node(self.env, "socket")
    if direct then
        if type(direct.tcp) ~= "function" then return nil, "type:socket.tcp" end
        return direct
    end
    local require_fn = fn_at(self.env, "require")
    if not require_fn then return nil, "missing:require" end
    local ok, value, why = invoke(require_fn, "socket")
    if not ok then return nil, why end
    if type(value) ~= "table" then return nil, "missing:socket" end
    if type(value.tcp) ~= "function" then return nil, "type:socket.tcp" end
    return value
end

function methods:land_surface_type(x, z)
    if not finite(x) or not finite(z) then
        return nil, "type:land.getSurfaceType"
    end
    -- On 2.9.30 the mission state exposes neither land nor world; the scripting
    -- state is the one that owns the mission API globals. Guard inside the
    -- state so a missing module is reported instead of raised.
    local code = string.format([[
if type(land) ~= 'table' or type(land.getSurfaceType) ~= 'function' then return 'unavailable' end
local ok, v = pcall(land.getSurfaceType, {x=%.9f, y=%.9f})
if not ok then return 'error:'..tostring(v) end
if type(v) == 'number' then return tostring(v) end
if type(v) == 'string' then return 'name:'..v end
return 'type:'..type(v)
]], x, z)
    local value, why = self:dostring("scripting", code)
    if type(value) ~= "string" then return nil, why or "type:land.getSurfaceType" end
    if value == "unavailable" then return nil, "missing:land.getSurfaceType" end
    if string.sub(value, 1, 5) == "name:" then return string.sub(value, 6) end
    if string.sub(value, 1, 5) == "type:" then return nil, "type:land.getSurfaceType.result" end
    local number = tonumber(value)
    if not number then return nil, "error:" .. value end
    return number
end

function methods:world_search(point, radius, limit)
    if type(point) ~= "table" or not finite(point.x) or not finite(point.z) then
        return nil, "type:world.searchObjects.point"
    end
    radius = finite(radius) and math.max(1, radius) or 500
    local code = string.format([[
local vt=world and world.VolumeType
if not (world and type(world.searchObjects)=='function' and vt and vt.BOX and Object and Object.Category) then return 'unavailable' end
local n=0
local vol={id=vt.BOX,params={min={x=%.9f,y=-1000,z=%.9f},max={x=%.9f,y=10000,z=%.9f}}}
local ok,err=pcall(world.searchObjects,{Object.Category.UNIT,Object.Category.STATIC,Object.Category.SCENERY},vol,function(o) n=n+1 end)
if not ok then return 'error:'..tostring(err) end
return tostring(n)
]], point.x - radius, point.z - radius, point.x + radius, point.z + radius)
    local value, why = self:dostring("scripting", code)
    if type(value) ~= "string" then return nil, why or "type:world.searchObjects" end
    if value == "unavailable" then return nil, "missing:world.searchObjects" end
    local visited = tonumber(value)
    if not visited then return nil, "error:" .. value end
    return { visited = visited }
end

function methods:mission_anchor()
    local code = [[
local function pack(point)
    return string.format('%.9f,%.9f', point.x, point.z)
end
local function point_of(object)
    local ok, point = pcall(function() return object:getPoint() end)
    if ok and type(point) == 'table'
        and type(point.x) == 'number' and type(point.z) == 'number' then
        return point
    end
end
if type(coalition) == 'table' and type(coalition.getGroups) == 'function'
    and type(coalition.side) == 'table' then
    for _, side in pairs(coalition.side) do
        local ok, groups = pcall(coalition.getGroups, side)
        if ok and type(groups) == 'table' then
            for _, group in ipairs(groups) do
                local got, units = pcall(function() return group:getUnits() end)
                if got and type(units) == 'table' then
                    for _, unit in ipairs(units) do
                        local point = point_of(unit)
                        if point then return pack(point) end
                    end
                end
            end
        end
    end
end
if type(world) == 'table' and type(world.getAirbases) == 'function' then
    local ok, bases = pcall(world.getAirbases)
    if ok and type(bases) == 'table' then
        for _, base in ipairs(bases) do
            local point = point_of(base)
            if point then return pack(point) end
        end
    end
end
return 'unavailable'
]]
    local value, why = self:dostring("scripting", code)
    if type(value) ~= "string" then return nil, why or "type:mission_anchor" end
    if value == "unavailable" then return nil, "missing:mission.anchor" end
    local x, z = string.match(value, "^(-?%d+%.?%d*),(-?%d+%.?%d*)$")
    if not x then return nil, "error:" .. value end
    return { x = tonumber(x), z = tonumber(z) }
end

function methods:facts()
    local facts = {}
    local injected = self.env and self.env.AESA_FACTS
    if type(injected) == "table" then
        for key, value in pairs(injected) do
            if type(key) == "string" then facts[key] = value end
        end
    end
    facts.kind = self.KIND
    return facts
end

function methods:capabilities()
    local dcs = node(self.env, "DCS")
    local lfs = node(self.env, "lfs")
    local package_table = node(self.env, "package")
    local net = node(self.env, "net")
    local log_table = node(self.env, "log")
    local socket_state = "unavailable"
    if node(self.env, "socket") or fn_at(self.env, "require") then
        socket_state = "unknown"
        local socket_table = node(self.env, "socket")
        if socket_table and type(socket_table.tcp) == "function" then
            socket_state = "ok"
        end
    end
    local function cap(value) if value then return "ok" end return "unavailable" end
    return {
        kind = self.KIND,
        schema = self.SCHEMA,
        dcs_model_time = cap(dcs and type(dcs.getModelTime) == "function"),
        dcs_set_user_callbacks = cap(dcs and type(dcs.setUserCallbacks) == "function"),
        lfs_writedir = cap(lfs and type(lfs.writedir) == "function"),
        lfs_currentdir = cap(lfs and type(lfs.currentdir) == "function"),
        loadlib = cap(package_table and type(package_table.loadlib) == "function"),
        net_dostring = cap(net and type(net.dostring_in) == "function"),
        a_do_script = cap(type(self.env.a_do_script) == "function"),
        log_write = cap(log_table and type(log_table.write) == "function"),
        socket = socket_state,
    }
end

function methods:call(name, ...)
    local fn = methods[name]
    if type(fn) ~= "function" then
        return nil, "missing:operation:" .. tostring(name)
    end
    local ok, a, b = pcall(fn, self, ...)
    if not ok then return nil, "error:" .. tostring(a) end
    return a, b
end

function methods:adapter()
    local instance = self
    return {
        kind = self.KIND,
        globals = self.env,
        instance = instance,
        call = function(name, ...) return instance:call(name, ...) end,
        facts = function() return instance:facts() end,
        capabilities = function() return instance:capabilities() end,
    }
end

methods.KIND = Hook.KIND
methods.SCHEMA = Hook.SCHEMA
local mt = { __index = methods }

function Hook.new(env)
    return setmetatable({ env = env or _G }, mt)
end

return Hook

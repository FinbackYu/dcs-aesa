-- DCS Export environment adapter (Lua 5.1, no require/io/os).
-- The caller injects the Export globals (or defaults to _G); every game API
-- access goes through a typed pcall wrapper that returns value or nil+reason.
--
-- Reason prefixes: missing:<name>, type:<name>, invalid:<name>, error:<text>,
-- empty:<name>, loadlib:<text>.

local Export = {}
Export.SCHEMA = 1
Export.KIND = "export"

local function finite(value)
    return type(value) == "number" and value == value
        and value ~= math.huge and value ~= -math.huge
end

local function invoke(fn, ...)
    if type(fn) ~= "function" then
        return false, nil, "missing:function"
    end
    local ok, a, b = pcall(fn, ...)
    if not ok then
        return false, nil, "error:" .. tostring(a)
    end
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
    local value = env[key]
    if type(value) == "function" then return value end
    return nil
end

local function fn_in(env, group, key)
    local value = node(env, group)
    if value and type(value[key]) == "function" then return value[key] end
    return nil
end

local function vector3(value)
    return type(value) == "table" and finite(value.x)
        and finite(value.y) and finite(value.z)
end

local methods = {}

function methods:model_time()
    local ok, value, why = invoke(fn_at(self.env, "LoGetModelTime"))
    if not ok then return nil, why end
    if not finite(value) then return nil, "type:LoGetModelTime" end
    return value
end

function methods:self_data()
    local ok, value, why = invoke(fn_at(self.env, "LoGetSelfData"))
    if not ok then return nil, why end
    if type(value) ~= "table" then return nil, "type:LoGetSelfData" end
    local position = value.Position or value.position
    if type(position) ~= "table" or not vector3(position) then
        return nil, "invalid:Position"
    end
    return value
end

function methods:vector_velocity()
    local ok, value, why = invoke(fn_at(self.env, "LoGetVectorVelocity"))
    if not ok then return nil, why end
    if type(value) ~= "table" then return nil, "type:LoGetVectorVelocity" end
    if not vector3(value) then return nil, "invalid:LoGetVectorVelocity" end
    return value
end

function methods:world_objects(filter)
    local fn = fn_at(self.env, "LoGetWorldObjects")
    if not fn then return nil, "missing:LoGetWorldObjects" end
    if filter ~= nil and type(filter) ~= "string" then
        return nil, "type:LoGetWorldObjects.filter"
    end
    local ok, value, why
    if filter == nil then
        ok, value, why = invoke(fn)
    else
        ok, value, why = invoke(fn, filter)
    end
    if not ok then return nil, why end
    if type(value) ~= "table" then return nil, "type:LoGetWorldObjects" end
    return value
end

function methods:target_information()
    local ok, value, why = invoke(fn_at(self.env, "LoGetTargetInformation"))
    if not ok then return nil, why end
    if value == nil then return nil, "empty:LoGetTargetInformation" end
    if type(value) ~= "table" then return nil, "type:LoGetTargetInformation" end
    return value
end

function methods:locked_target_information()
    local ok, value, why = invoke(fn_at(self.env, "LoGetLockedTargetInformation"))
    if not ok then return nil, why end
    if value == nil then return nil, "empty:LoGetLockedTargetInformation" end
    if type(value) ~= "table" then return nil, "type:LoGetLockedTargetInformation" end
    return value
end

function methods:sensor_export_allowed()
    local ok, value, why = invoke(fn_at(self.env, "LoIsSensorExportAllowed"))
    if not ok then return nil, why end
    if type(value) ~= "boolean" then return nil, "type:LoIsSensorExportAllowed" end
    return value
end

function methods:terrain_height(x, z)
    if not finite(x) or not finite(z) then return nil, "type:terrain_height.point" end
    local fn = fn_in(self.env, "terrain", "GetHeight")
    if not fn then return nil, "missing:terrain.GetHeight" end
    local ok, value, why = invoke(fn, x, z)
    if not ok then return nil, why end
    if not finite(value) then return nil, "type:terrain.GetHeight.result" end
    return value
end

function methods:terrain_surface_type(x, z)
    if not finite(x) or not finite(z) then return nil, "type:terrain_surface_type.point" end
    local fn = fn_in(self.env, "terrain", "GetSurfaceType")
    if not fn then return nil, "missing:terrain.GetSurfaceType" end
    -- Scalar arguments only. On 2.9.30 a Vec2 table makes lua-terrain raise a
    -- C++ exception that escapes pcall and terminates DCS; never retry with
    -- another argument shape. The result is a class number or a name string.
    local ok, value, why = invoke(fn, x, z)
    if not ok then return nil, why end
    if type(value) == "number" then return value end
    if type(value) == "string" and value ~= "" then return value end
    return nil, "type:terrain.GetSurfaceType.result"
end

function methods:terrain_visible(x1, y1, z1, x2, y2, z2)
    if not finite(x1) or not finite(y1) or not finite(z1)
        or not finite(x2) or not finite(y2) or not finite(z2) then
        return nil, "type:terrain_visible.points"
    end
    local fn = fn_in(self.env, "terrain", "isVisible")
    if not fn then return nil, "missing:terrain.isVisible" end
    local ok, value, why = invoke(fn, x1, y1, z1, x2, y2, z2)
    if not ok then return nil, why end
    if type(value) ~= "boolean" then return nil, "type:terrain.isVisible.result" end
    return value
end

function methods:geo_forward(lon, lat)
    if not finite(lon) or not finite(lat) then return nil, "type:geo_forward.point" end
    local fn = fn_at(self.env, "LoGeoCoordinatesToLoCoordinates")
    if not fn then return nil, "missing:LoGeoCoordinatesToLoCoordinates" end
    local ok, value, second = invoke(fn, lon, lat)
    if not ok then return nil, second end
    if type(value) == "table" then
        if finite(value.x) and finite(value.z) then return value.x, value.z end
        return nil, "type:LoGeoCoordinatesToLoCoordinates.result"
    end
    if finite(value) and finite(second) then return value, second end
    return nil, "type:LoGeoCoordinatesToLoCoordinates.result"
end

function methods:geo_inverse(x, z)
    if not finite(x) or not finite(z) then return nil, "type:geo_inverse.point" end
    local fn = fn_at(self.env, "LoLoCoordinatesToGeoCoordinates")
        or fn_at(self.env, "LoCoordinatesToGeoCoordinates")
    if not fn then return nil, "missing:LoLoCoordinatesToGeoCoordinates" end
    local ok, value, second = invoke(fn, x, z)
    if not ok then return nil, second end
    if type(value) == "table" then
        if finite(value.latitude) or finite(value.lat) then return value end
        return nil, "invalid:LoLoCoordinatesToGeoCoordinates"
    end
    if finite(value) and finite(second) then
        return { latitude = value, longitude = second }
    end
    return nil, "type:LoLoCoordinatesToGeoCoordinates.result"
end

function methods:altitude(x, z)
    if not finite(x) or not finite(z) then return nil, "type:altitude.point" end
    local ok, value, why = invoke(fn_at(self.env, "LoGetAltitude"), x, z)
    if not ok then return nil, why end
    if not finite(value) then return nil, "type:LoGetAltitude.result" end
    return value
end

function methods:agl()
    local ok, value, why = invoke(fn_at(self.env, "LoGetAltitudeAboveGroundLevel"))
    if not ok then return nil, why end
    if not finite(value) then return nil, "type:LoGetAltitudeAboveGroundLevel.result" end
    return value
end

function methods:height_with_objects()
    local ok, value, why = invoke(fn_at(self.env, "LoGetHeightWithObjects"))
    if not ok then return nil, why end
    if not finite(value) then return nil, "type:LoGetHeightWithObjects.result" end
    return value
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

function methods:log_available()
    local log_table = node(self.env, "log")
    if not log_table or type(log_table.write) ~= "function" then
        return nil, "missing:log.write"
    end
    return true
end

function methods:export_callbacks()
    local facts = self.env and self.env.AESA_FACTS
    if type(facts) == "table" and type(facts.export_callbacks) == "table" then
        return facts.export_callbacks
    end
    return nil, "missing:export_callbacks"
end

function methods:loadlib(path, symbol)
    if type(path) ~= "string" or path == "" then return nil, "type:loadlib.path" end
    if type(symbol) ~= "string" or symbol == "" then return nil, "type:loadlib.symbol" end
    local package_table = node(self.env, "package")
    if not package_table or type(package_table.loadlib) ~= "function" then
        return nil, "missing:package.loadlib"
    end
    local ok, value, err = invoke(package_table.loadlib, path, symbol)
    if not ok then return nil, err end
    if type(value) ~= "function" then
        return nil, "loadlib:" .. tostring(err or "nil")
    end
    return value
end

local function cap(present)
    if present then return "ok" end
    return "unavailable"
end

function methods:capabilities()
    local terrain = node(self.env, "terrain")
    local lfs = node(self.env, "lfs")
    local log_table = node(self.env, "log")
    local package_table = node(self.env, "package")
    local socket_state = "unavailable"
    if node(self.env, "socket") or fn_at(self.env, "require") then
        socket_state = "unknown"
        local socket_table = node(self.env, "socket")
        if socket_table and type(socket_table.tcp) == "function" then
            socket_state = "ok"
        end
    end
    return {
        kind = self.KIND,
        schema = self.SCHEMA,
        model_time = cap(fn_at(self.env, "LoGetModelTime") ~= nil),
        self_data = cap(fn_at(self.env, "LoGetSelfData") ~= nil),
        vector_velocity = cap(fn_at(self.env, "LoGetVectorVelocity") ~= nil),
        world_objects = cap(fn_at(self.env, "LoGetWorldObjects") ~= nil),
        target_information = cap(fn_at(self.env, "LoGetTargetInformation") ~= nil),
        locked_target_information = cap(fn_at(self.env, "LoGetLockedTargetInformation") ~= nil),
        sensor_export_allowed = cap(fn_at(self.env, "LoIsSensorExportAllowed") ~= nil),
        geo_forward = cap(fn_at(self.env, "LoGeoCoordinatesToLoCoordinates") ~= nil),
        geo_inverse = cap((fn_at(self.env, "LoLoCoordinatesToGeoCoordinates")
            or fn_at(self.env, "LoCoordinatesToGeoCoordinates")) ~= nil),
        terrain_get_height = cap(terrain and type(terrain.GetHeight) == "function"),
        terrain_get_surface_type = cap(terrain and type(terrain.GetSurfaceType) == "function"),
        terrain_is_visible = cap(terrain and type(terrain.isVisible) == "function"),
        lfs_writedir = cap(lfs and type(lfs.writedir) == "function"),
        lfs_currentdir = cap(lfs and type(lfs.currentdir) == "function"),
        log_write = cap(log_table and type(log_table.write) == "function"),
        socket = socket_state,
        loadlib = cap(package_table and type(package_table.loadlib) == "function"),
    }
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

methods.KIND = Export.KIND
methods.SCHEMA = Export.SCHEMA
local mt = { __index = methods }

function Export.new(env)
    return setmetatable({ env = env or _G }, mt)
end

return Export

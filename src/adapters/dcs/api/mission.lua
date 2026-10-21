-- DCS mission environment adapter (Lua 5.1, no require/io/os).
-- The caller injects the mission globals; wrappers type-check every value and
-- isolate failures with pcall. Read-only helpers never mutate mission state.
--
-- Reason prefixes: missing:<name>, type:<name>, invalid:<name>, error:<text>.

local Mission = {}
Mission.SCHEMA = 1
Mission.KIND = "mission"

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

local function point3(value)
    if type(value) ~= "table" then return nil end
    local x = value.x
    local y = value.y or 0
    local z = value.z
    if not finite(x) or not finite(y) or not finite(z) then return nil end
    return { x = x, y = y, z = z }
end

local methods = {}

local CATEGORY_NAMES = { "SCENERY", "STATIC", "UNIT" }

function methods:world_search(point, half, limit)
    local world = node(self.env, "world")
    if not world or type(world.searchObjects) ~= "function" then
        return nil, "missing:world.searchObjects"
    end
    local volume_type = world.VolumeType
    if type(volume_type) ~= "table" or volume_type.BOX == nil then
        return nil, "missing:world.VolumeType.BOX"
    end
    local object = node(self.env, "Object")
    local categories = object and object.Category
    if type(categories) ~= "table"
        or categories.SCENERY == nil
        or categories.STATIC == nil
        or categories.UNIT == nil then
        return nil, "missing:Object.Category"
    end
    local center = point3(point) or { x = 0, y = 0, z = 0 }
    local radius = finite(half) and math.abs(half) or 500
    local budget = finite(limit) and math.floor(limit) or 8
    if budget < 1 then budget = 1 end
    local volume = {
        id = volume_type.BOX,
        params = {
            min = { x = center.x - radius, y = -1000, z = center.z - radius },
            max = { x = center.x + radius, y = 10000, z = center.z + radius },
        },
    }
    local visited = 0
    local objects = {}
    local used_categories = {}
    local function handler(obj)
        if visited >= budget then return false end
        visited = visited + 1
        objects[#objects + 1] = obj
        return visited < budget
    end
    for _, name in ipairs(CATEGORY_NAMES) do
        local category = categories[name]
        if category ~= nil then
            used_categories[#used_categories + 1] = name
            local ok, value, why = invoke(world.searchObjects, category, volume, handler)
            if not ok then
                return nil, "error:world.searchObjects:" .. tostring(why)
            end
            if value == false or visited >= budget then break end
        end
    end
    return {
        visited = visited,
        objects = objects,
        categories = used_categories,
        provider = "world.searchObjects",
    }
end

function methods:land_surface_type(x, z)
    if not finite(x) or not finite(z) then return nil, "type:land_surface_type.point" end
    local fn = fn_in(self.env, "land", "getSurfaceType")
    if not fn then return nil, "missing:land.getSurfaceType" end
    local ok, value, why = invoke(fn, { x = x, y = z })
    if not ok then return nil, why end
    if type(value) ~= "number" then return nil, "type:land.getSurfaceType.result" end
    return value
end

function methods:land_height(x, z)
    if not finite(x) or not finite(z) then return nil, "type:land_height.point" end
    local fn = fn_in(self.env, "land", "getHeight")
    if not fn then return nil, "missing:land.getHeight" end
    local ok, value, why = invoke(fn, { x = x, y = z })
    if not ok then return nil, why end
    if not finite(value) then return nil, "type:land.getHeight.result" end
    return value
end

function methods:land_visible(from, to)
    local a = point3(from)
    local b = point3(to)
    if not a or not b then return nil, "type:land_visible.points" end
    local fn = fn_in(self.env, "land", "isVisible")
    if not fn then return nil, "missing:land.isVisible" end
    local ok, value, why = invoke(fn, a, b)
    if not ok then return nil, why end
    if type(value) ~= "boolean" then return nil, "type:land.isVisible.result" end
    return value
end

function methods:timer_get_time()
    local ok, value, why = invoke(fn_in(self.env, "timer", "getTime"))
    if not ok then return nil, why end
    if not finite(value) then return nil, "type:timer.getTime.result" end
    return value
end

function methods:timer_schedule(fn, at, ...)
    if type(fn) ~= "function" then return nil, "type:timer.scheduleFunction.fn" end
    if not finite(at) then return nil, "type:timer.scheduleFunction.at" end
    local schedule = fn_in(self.env, "timer", "scheduleFunction")
    if not schedule then return nil, "missing:timer.scheduleFunction" end
    local ok, value, why = invoke(schedule, fn, at, ...)
    if not ok then return nil, why end
    return value
end

function methods:coalition_probe()
    local coalition = node(self.env, "coalition")
    if not coalition then return nil, "missing:coalition" end
    local result = {
        table = true,
        side = type(coalition.side) == "table",
        get_country_coalition = type(coalition.getCountryCoalition) == "function",
        get_groups = type(coalition.getGroups) == "function",
        get_units = type(coalition.getUnits) == "function",
        get_static_objects = type(coalition.getStaticObjects) == "function",
        add_group = type(coalition.addGroup) == "function",
        groups = 0,
    }
    if result.side and result.get_groups then
        local side = coalition.side.BLUE
        if side ~= nil then
            local ok, groups = invoke(coalition.getGroups, side)
            if ok and type(groups) == "table" then
                for _ in pairs(groups) do result.groups = result.groups + 1 end
            end
        end
    end
    return result
end

function methods:controller_probe()
    local controller = node(self.env, "controller")
    local group = node(self.env, "Group")
    local result = {
        table = controller ~= nil,
        set_task = controller and type(controller.setTask) == "function" or false,
        push_task = controller and type(controller.pushTask) == "function" or false,
        set_command = controller and type(controller.setCommand) == "function" or false,
        group_get_controller = group and type(group.getController) == "function" or false,
    }
    if not result.table and not result.group_get_controller then
        return nil, "missing:controller"
    end
    return result
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

function methods:mission_global()
    local value = self.env and self.env.AESA_SAR_SCENE
    if value == nil then return nil, "missing:AESA_SAR_SCENE" end
    if type(value) ~= "table" then return nil, "type:AESA_SAR_SCENE" end
    return value
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
    local world = node(self.env, "world")
    local object = node(self.env, "Object")
    local categories = object and object.Category
    local land = node(self.env, "land")
    local timer = node(self.env, "timer")
    local coalition = node(self.env, "coalition")
    local controller = node(self.env, "controller")
    local group = node(self.env, "Group")
    local net = node(self.env, "net")
    local function cap(value) if value then return "ok" end return "unavailable" end
    return {
        kind = self.KIND,
        schema = self.SCHEMA,
        search_objects = cap(world and type(world.searchObjects) == "function"),
        volume_box = cap(world and type(world.VolumeType) == "table" and world.VolumeType.BOX ~= nil),
        category_scenery = cap(categories and categories.SCENERY ~= nil),
        category_static = cap(categories and categories.STATIC ~= nil),
        category_unit = cap(categories and categories.UNIT ~= nil),
        land_surface_type = cap(land and type(land.getSurfaceType) == "function"),
        land_height = cap(land and type(land.getHeight) == "function"),
        land_visible = cap(land and type(land.isVisible) == "function"),
        timer_get_time = cap(timer and type(timer.getTime) == "function"),
        timer_schedule = cap(timer and type(timer.scheduleFunction) == "function"),
        coalition = cap(coalition and type(coalition.side) == "table"),
        controller = cap(controller and type(controller.setTask) == "function"),
        group_get_controller = cap(group and type(group.getController) == "function"),
        net_dostring = cap(net and type(net.dostring_in) == "function"),
        a_do_script = cap(type(self.env.a_do_script) == "function"),
        mission_global = cap(type(self.env.AESA_SAR_SCENE) == "table"),
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

methods.KIND = Mission.KIND
methods.SCHEMA = Mission.SCHEMA
local mt = { __index = methods }

function Mission.new(env)
    return setmetatable({ env = env or _G }, mt)
end

return Mission

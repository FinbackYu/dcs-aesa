-- LuaSocket discovery for DCS Lua states (Lua 5.1, no require at load time).
-- The Export/Hook sandboxes do not inherit DCS's LuaSocket search paths, so the
-- same cpath probe used to be copied into every consumer. Keep it here and let
-- callers inject their environment (`_G` in DCS, a stub table in tests).
--
-- A `socket` module can exist in package.loaded while its C core is missing:
-- the Lua wrapper still exposes `tcp` but every call errors. Accept a module
-- only after a tcp() probe succeeds, and drop the cached wrapper before trying
-- another cpath entry.
local Socket = {}
Socket.SCHEMA = 1

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

local function invoke(fn, ...)
    local ok, a, b = pcall(fn, ...)
    if not ok then return false, nil, tostring(a) end
    return true, a, b
end

local function usable(module)
    if type(module) ~= "table" or type(module.tcp) ~= "function" then return false end
    local ok, client = pcall(module.tcp)
    if not ok then return false end
    if type(client) ~= "table" and type(client) ~= "userdata" then return false end
    pcall(function() client:close() end)
    return true
end

local function reset_cache(package_table)
    local loaded = package_table and package_table.loaded
    if type(loaded) ~= "table" then return end
    loaded.socket = nil
    loaded["socket.core"] = nil
end

function Socket.bootstrap(env)
    if type(env) ~= "table" then return nil, "type:socket.env" end
    local direct = node(env, "socket")
    if usable(direct) then return direct end
    local require_fn = fn_at(env, "require")
    if not require_fn then return nil, "missing:require" end
    local package_table = node(env, "package")
    local lfs = node(env, "lfs")
    local ok, value = invoke(require_fn, "socket")
    if ok and usable(value) then return value end
    reset_cache(package_table)
    local bases = {}
    local function add(base)
        if type(base) == "string" and base ~= "" then
            bases[#bases + 1] = string.gsub(base, "[/\\]?$", "\\")
        end
    end
    if lfs and type(lfs.currentdir) == "function" then
        local got, base = invoke(lfs.currentdir)
        if got then add(base) end
    end
    if lfs and type(lfs.envbasedir) == "function" then
        local got, base = invoke(lfs.envbasedir)
        if got then add(base) end
    end
    if package_table and type(package_table.path) == "string" then
        for entry in string.gmatch(package_table.path, "[^;]+") do
            local base = string.match(entry, "^(.-)[/\\]%?%.lua$")
            if base and string.find(base, "DCSWorld", 1, true) then
                add(base .. "\\")
                break
            end
        end
    end
    for _, base in ipairs(bases) do
        local combos = {
            { base .. [[LuaSocket\?.lua]], [[bin\lua-?.dll]] },
            { base .. [[LuaSocket\?.lua]], [[bin-mt\lua-?.dll]] },
            { base .. [[LuaSocket\?.lua]], [[bin\?.dll]] },
            { base .. [[LuaSocket\?.lua]], [[LuaSocket\?.dll]] },
        }
        for _, combo in ipairs(combos) do
            if package_table then
                if type(package_table.path) == "string" then
                    package_table.path = package_table.path .. ";" .. combo[1]
                end
                if type(package_table.cpath) == "string" then
                    package_table.cpath = package_table.cpath .. ";" .. base .. combo[2]
                end
            end
            reset_cache(package_table)
            local loaded, api = invoke(require_fn, "socket")
            if loaded and usable(api) then
                return api
            end
        end
    end
    return nil, "missing:socket"
end

function Socket.get(env)
    return Socket.bootstrap(env)
end

return Socket

-- Native symbol loader (Lua 5.1, no require/io/os, no memory writes).
-- Uses the injected package.loadlib to resolve one export at a time and reports
-- the loaded functions, the missing list, the DLL path and an optional version
-- export. Runtime vtable/offset checks are injected as facts by the caller;
-- this module never reads or writes process memory.

local Native = {}
Native.SCHEMA = 1
Native.KIND = "native"

local function node(env, key)
    if type(env) ~= "table" then return nil end
    local value = env[key]
    if type(value) == "table" then return value end
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

function methods:load_symbol(path, symbol)
    local package_table = node(self.env, "package")
    if not package_table or type(package_table.loadlib) ~= "function" then
        return nil, "missing:package.loadlib"
    end
    if type(path) ~= "string" or path == "" then return nil, "type:load_symbol.path" end
    if type(symbol) ~= "string" or symbol == "" then return nil, "type:load_symbol.symbol" end
    local ok, value, err = pcall(package_table.loadlib, path, symbol)
    if not ok then return nil, "error:" .. tostring(value) end
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
            local ok, value = pcall(fn)
            if ok then
                result.version = value
            else
                result.version_error = "error:" .. tostring(value)
            end
        else
            result.version_error = why
        end
    elseif opts.version ~= nil then
        result.version = opts.version
    end
    result.path = opts.display_path or path
    return result
end

local function load_role(self, path, profile, opts)
    local role = profile or {}
    -- Lua loadlib can only resolve the AESA DLL's own exports, not the engine
    -- mangled symbols the DLL resolves internally. Use the explicit export
    -- list when the profile provides one.
    local symbols = role.exports or role.symbols
    if type(path) ~= "string" or path == "" then
        return {
            symbols = {
                loaded = 0,
                total = type(symbols) == "table" and #symbols or 0,
                missing = {},
            },
            error = "missing:path",
        }
    end
    local loaded, why = self:load(path, symbols, opts)
    if not loaded then
        return {
            symbols = {
                loaded = 0,
                total = type(symbols) == "table" and #symbols or 0,
                missing = {},
            },
            error = why,
        }
    end
    local profile_check = nil
    if opts.profile_check_symbol then
        local fn = self:load_symbol(path, opts.profile_check_symbol)
        if fn then
            local ok, value = pcall(fn)
            if ok and type(value) == "number" then profile_check = value end
        end
    end
    return {
        symbols = {
            loaded = loaded.loaded_count,
            total = loaded.total,
            missing = loaded.missing,
            version = loaded.version,
            version_error = loaded.version_error,
            path = loaded.path,
        },
        profile_check = profile_check,
    }
end

-- Build the shape consumed by compat/probe.lua. Runtime checks that require
-- process memory (vtable equality, offset sanity) must be supplied by the
-- caller; this module only reports symbol resolution and optional versions.
function methods:probe(native_profile, opts)
    opts = opts or {}
    local paths = opts.paths or {}
    local profile = native_profile or {}
    local agradar = profile.agradar or {}
    local fc = profile.fc or {}
    local result = {
        agradar = load_role(self, paths.agradar, agradar, {
            version_symbol = opts.agradar_version_symbol,
            version = opts.agradar_version,
            display_path = paths.agradar,
            profile_check_symbol = opts.agradar_profile_check_symbol or "aesa_agradar_profile_check",
        }),
        fc = load_role(self, paths.fc, fc, {
            version_symbol = opts.fc_version_symbol,
            version = opts.fc_version,
            display_path = paths.fc,
        }),
        hashes = {
            ok = opts.hashes_ok,
            detail = opts.hashes_detail,
            version_match = opts.version_match,
            exports_sha256 = opts.exports_sha256,
        },
    }
    if type(result.agradar.profile_check) == "number" then
        result.agradar.vtable_match = result.agradar.profile_check == 1
    end
    if opts.vtable_slot ~= nil and agradar.vtable_slot ~= nil then
        result.agradar.vtable_match = opts.vtable_slot == agradar.vtable_slot
        if opts.point_on_surface_offset ~= nil and agradar.point_on_surface_offset ~= nil then
            result.agradar.vtable_match = result.agradar.vtable_match
                and opts.point_on_surface_offset == agradar.point_on_surface_offset
        end
    end
    if opts.surface_match ~= nil then result.agradar.surface_match = opts.surface_match end
    if opts.surface_total ~= nil then result.agradar.surface_total = opts.surface_total end
    if opts.fc_sites_loaded ~= nil then
        result.fc.sites = {
            loaded = opts.fc_sites_loaded,
            total = opts.fc_sites_total or (type(fc.sites) == "table" and #fc.sites or 0),
        }
    end
    if opts.offsets_ok ~= nil then result.fc.offsets_ok = opts.offsets_ok end
    return result
end

function methods:capabilities()
    local package_table = node(self.env, "package")
    local result = {
        kind = self.KIND,
        schema = self.SCHEMA,
        loadlib = "unavailable",
        package_path = nil,
        package_cpath = nil,
    }
    if package_table and type(package_table.loadlib) == "function" then
        result.loadlib = "ok"
        if type(package_table.path) == "string" then result.package_path = package_table.path end
        if type(package_table.cpath) == "string" then result.package_cpath = package_table.cpath end
    end
    return result
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

methods.KIND = Native.KIND
methods.SCHEMA = Native.SCHEMA
local mt = { __index = methods }

function Native.new(env)
    return setmetatable({ env = env or _G }, mt)
end

return Native

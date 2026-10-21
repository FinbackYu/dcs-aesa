-- DCS environment of the SAR Export: the sides of the game the sampler asks about.
--
-- Three kinds of environment fact live here, all of them DCS rather than protocol:
--   * the surface query — the adapter's five-class call plus the native aesa_agradar probe that
--     answers the engine's 16-class mask. The probe is loaded once per connection (never per cell)
--     and only when the service asks for the fine vocabulary;
--   * the capability and terrain helpers (GetHeight as a hard prerequisite, altitude, AGL, the
--     geographic pair) and the ownship pose/velocity the sampler needs for every job;
--   * the production environment builder, which wires the export adapter into the callback table the
--     sampler consumes. The Lua tests inject the same shape without an engine global.
--
-- This file never reads an engine global itself; `env` carries every callback the adapter owns. The
-- protocol words it needs (the fine-class spellings) are injected by the entry, so no module here
-- loads another: the deployed bundle has no require and the tests run the files directly.
local M = {}

-- A probe that can answer the engine's mask. The DLL lives under the Saved Games root the active
-- DCS instance uses (adapter writedir); no USERPROFILE/bin/cpath search is attempted, because a copy
-- found elsewhere would be stale or somebody else's. Both query functions must come from the same
-- load result, every export the profile lists must resolve, and a failed profile check means no fine
-- classes. init is called once with an empty string — the probe's own hook owns the real init, this
-- call is idempotent and the query functions self-initialise too.
local SURFACE_PROBE_FILE = "aesa_agradar.dll"
local SURFACE_PROBE_DIR = "Scripts\\AESA-AGR\\"
local function surface_probe(env)
    if type(env.native_load) ~= "function" or type(env.writedir) ~= "function" then return nil end
    local exports = env.agradar_exports
    if type(exports) ~= "table" or #exports == 0 then return nil end
    local ok, dir = pcall(env.writedir)
    if not ok or type(dir) ~= "string" or dir == "" then return nil end
    if string.sub(dir, -1) ~= "\\" and string.sub(dir, -1) ~= "/" then dir = dir .. "\\" end
    local path = dir .. SURFACE_PROBE_DIR .. SURFACE_PROBE_FILE
    local loaded, result = pcall(env.native_load, path, exports)
    if not loaded or type(result) ~= "table" then return nil end
    local functions = result.loaded
    if type(functions) ~= "table" then return nil end
    if type(result.total) ~= "number" or result.total ~= #exports then return nil end
    if type(result.loaded_count) ~= "number" or result.loaded_count < result.total then return nil end
    local names = functions.aesa_agradar_surface_names
    local mask = functions.aesa_agradar_surface_mask
    if type(names) ~= "function" or type(mask) ~= "function" then return nil end
    local check = functions.aesa_agradar_profile_check
    if type(check) == "function" then
        local checked, value = pcall(check)
        if not checked or value ~= 1 then return nil end
    end
    local init = functions.aesa_agradar_init
    if type(init) == "function" then pcall(init, "") end
    return { names = names, mask = mask, path = path }
end

-- GetHeight is a hard prerequisite: without it no cell can be collected. The adapter reports the
-- capability explicitly, so a missing engine function is refused at command time instead of failing
-- on the first cell query.
local function height_ready(env)
    if type(env.height_available) == "function" then
        local ok, value = pcall(env.height_available)
        if not ok or value ~= true then return false end
    elseif env.height_available == false then
        return false
    end
    return type(env.height) == "function"
end

-- One class string per cell: the probe's union when the service asked for it and the probe is
-- usable, the adapter's five-class answer otherwise. A nil from the probe (engine not ready,
-- reserved cell) falls back per cell, so a working probe with a few blind spots still maps the rest.
local function cell_surface(env, state, x, z, protocol)
    if state.surface_fine then
        if not state.probe_checked then
            state.probe_checked = true
            state.probe = surface_probe(env)
        end
        if state.probe then
            local ok, names = pcall(state.probe.names, x, z)
            if ok then
                local merged = protocol.fine_classes(names)
                if merged then return merged end
            end
        end
    end
    return protocol.surface(env.surface, x, z)
end

-- Production wiring. Every engine value below comes from the export adapter; capabilities are
-- sampled once per connection so a missing GetHeight turns into an explicit FAIL and a missing
-- GetSurfaceType omits class lines instead of fabricating them.
local function capabilities(api)
    local ok, value = pcall(api.capabilities, api)
    if ok and type(value) == "table" then return value end
    return {}
end

local function finite(v) return type(v) == "number" and v == v and math.abs(v) < 1e10 end
local function environment(a, native, caps, profile)
    local surface_fn, geo, inverse
    if caps.terrain_get_surface_type == "ok" then
        surface_fn = function(x, z) return a:terrain_surface_type(x, z) end
    end
    if caps.geo_forward == "ok" then
        geo = function(lon, lat)
            local x, z = a:geo_forward(lon, lat)
            if finite(x) and finite(z) then return { x = x, z = z } end
        end
    end
    if caps.geo_inverse == "ok" then
        inverse = function(x, z)
            local point = a:geo_inverse(x, z)
            if type(point) == "table" then return point end
        end
    end
    return {
        self = function() return a:self_data() end,
        velocity = function() return a:vector_velocity() end,
        height = function(x, z) return a:terrain_height(x, z) end,
        height_available = caps.terrain_get_height == "ok",
        surface = surface_fn,
        altitude = function(x, z) return a:altitude(x, z) end,
        agl = function() return a:agl() end,
        geo = geo,
        inverse_geo = inverse,
        writedir = function() return a:writedir() end,
        agradar_exports = profile:get("native.agradar.exports"),
        native_load = function(path, symbols)
            if type(native) ~= "table" or type(native.load) ~= "function" then
                return nil, "missing:native.load"
            end
            return native:load(path, symbols)
        end,
    }
end

return {
    surface_probe = surface_probe, height_ready = height_ready, cell_surface = cell_surface,
    capabilities = capabilities, environment = environment,
}

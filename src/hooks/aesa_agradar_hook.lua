-- AESA AGR native probe loader (phase 1, runtime consumer).
-- Loads aesa_agradar.dll from Saved Games and exposes the engine's 64-bit
-- surface-type mask. No install-directory writes; no hooks in the engine; the
-- DLL only reads GetDefaultTerrain()/getPointOnSurface and the Inter.dll name
-- decoders.
--
-- Gate 3: all engine services come from AESA_RUNTIME: runtime.hook for
-- filesystem/loadlib/log/DCS, runtime.native for the exports listed in the
-- generated profile, runtime.profile for the compatibility matrix. It does not
-- require modules or call engine globals directly.
--
-- Deployed as Scripts/Hooks/aesa_agradar_hook.lua; DLL lives in
-- Scripts/AESA-AGR/aesa_agradar.dll. The DLL is loaded independently by each
-- Lua state, so it never caches lua_State.
local runtime = assert(AESA_RUNTIME, "AESA runtime missing")
local hookapi = runtime.hook.new(_G)
local nativeapi = runtime.native.new(_G)
local profile = runtime.profile.new(runtime.profile_data, "generated")

local init, poll, shutdown, version, surface_names, surface_mask
local loaded = false
local next_try = 0
local next_error_log = 0
local profile_wait_logged = false
local log_ready = hookapi:log_available() ~= nil

local function diagnostic(message)
    if not log_ready then return end
    -- Adapter contract: log_write(level, message). Keep the probe tag in the
    -- text so hook diagnostics stay identifiable in dcs.log.
    pcall(hookapi.log_write, hookapi, "INFO", "AESA-AGR: " .. tostring(message))
end

-- Compatibility handshake line: COMPAT,<profile_id>,<matrix_hash>.
-- Emitted verbatim (no probe prefix) so log parsers see the fixed format.
if log_ready then
    pcall(hookapi.log_write, hookapi, "INFO", "COMPAT," .. tostring(profile:id())
        .. "," .. tostring(profile:matrix_hash()))
end
if profile:is_fallback() then
    diagnostic("profile fallback: " .. tostring(profile.fallback_reason or "unknown"))
end

local function now()
    local value = hookapi:dcs_model_time()
    if type(value) == "number" then
        return value
    end
    return os.clock()
end

local function base_dir()
    local dir = hookapi:writedir()
    if type(dir) ~= "string" or dir == "" then
        return nil
    end
    if string.sub(dir, -1) ~= "\\" and string.sub(dir, -1) ~= "/" then
        dir = dir .. "\\"
    end
    return dir
end

local function clear_symbols()
    init, poll, shutdown, version, surface_names, surface_mask =
        nil, nil, nil, nil, nil, nil
end

local function load()
    if loaded then
        return true
    end
    local base = base_dir()
    if not base then
        diagnostic("writedir unavailable")
        return false
    end
    local exports = profile:get("native.agradar.exports")
    if type(exports) ~= "table" or #exports == 0 then
        diagnostic("profile has no native.agradar.exports; probe unavailable")
        return false
    end

    local dir = base .. "Scripts\\AESA-AGR\\"
    local path = dir .. "aesa_agradar.dll"
    local result, why = nativeapi:load(path, exports)
    if type(result) ~= "table" then
        diagnostic("native load failed: " .. tostring(why))
        return false
    end
    if type(result.missing) == "table" and #result.missing > 0 then
        diagnostic("native exports missing: " .. table.concat(result.missing, ","))
    end
    local got = result.loaded or {}
    init = got.aesa_agradar_init
    poll = got.aesa_agradar_poll
    shutdown = got.aesa_agradar_shutdown
    version = got.aesa_agradar_version
    surface_names = got.aesa_agradar_surface_names
    surface_mask = got.aesa_agradar_surface_mask
    if not (init and poll and shutdown and version and surface_names and surface_mask) then
        diagnostic("one or more exports missing")
        clear_symbols()
        return false
    end

    local ok, resolved = pcall(init, base .. "Logs\\AESA\\AGR")
    if not ok then
        diagnostic("init failed: " .. tostring(resolved))
        clear_symbols()
        return false
    end

    -- The profile check compares the engine vtable slot/offset compiled into
    -- the profile with the live engine. Run it after init: init resolves the
    -- engine symbols, which the check needs. A mismatch means the surface
    -- read is not trustworthy: fail closed instead of returning stale classes.
    local check = got.aesa_agradar_profile_check
    if type(check) == "function" then
        local checked, value = pcall(check)
        if checked and value == -1 then
            -- Symbols are resolved, but the terrain instance does not exist
            -- yet (DCS start-up before a mission). Retry quietly instead of
            -- reporting a profile mismatch.
            if not profile_wait_logged then
                diagnostic("profile check deferred: engine not ready")
                profile_wait_logged = true
            end
            pcall(shutdown)
            clear_symbols()
            return false
        end
        if not checked or value ~= 1 then
            diagnostic("profile check failed: " .. tostring(value))
            pcall(shutdown)
            clear_symbols()
            return false
        end
    end

    diagnostic("probe loaded, symbols resolved: " .. tostring(resolved))
    profile_wait_logged = false
    loaded = true
    return true
end

local function frame()
    local t = now()
    if not loaded then
        if t < next_try then
            return
        end
        if not load() then
            next_try = t + 2
            return
        end
    end

    local ok, err = pcall(poll)
    if not ok then
        if t >= next_error_log then
            diagnostic("poll error: " .. tostring(err))
            next_error_log = t + 2
        end
    end
end

local callbacks = {}
function callbacks.onSimulationFrame()
    local ok, err = pcall(frame)
    if not ok and now() >= next_error_log then
        diagnostic("frame error: " .. tostring(err))
        next_error_log = now() + 2
    end
end

function callbacks.onSimulationStop()
    if shutdown then
        pcall(shutdown)
    end
    loaded = false
    next_try = 0
    next_error_log = 0
end

if not hookapi:set_user_callbacks(callbacks) then
    diagnostic("setUserCallbacks unavailable")
end

load()

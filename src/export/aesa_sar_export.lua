-- Development SAR acquisition only; no radar computation or game-file changes.
--
-- Entry of the SAR Export: it composes the four pieces and installs them, nothing else.
--   sar_protocol.lua   wire constants and value mapping (no game API)
--   sar_dcs_env.lua    the DCS side: surface probe, terrain/geo capabilities, ownship callbacks
--   sar_collector.lua  the command/tick state machine of one patch job and one map job
--   sar_transport.lua  socket lifecycle, handshake, frame pump, Export callbacks
--
-- One deployment form: scripts/build_runtime.cjs wraps the DCS API adapters and the four modules
-- into this one chunk and publishes the adapters as AESA_RUNTIME and the SAR modules as AESA_SAR.
-- The entry loads nothing and never touches an engine global directly.
local M = {}

local parts = assert(AESA_SAR, "AESA SAR modules missing")
M.protocol, M.dcs_env, M.collector = parts.protocol, parts.dcs_env, parts.collector
-- The bundle declares what it is: adapters plus the SAR modules. The Lua suites build the same table
-- by dofile but have no engine, and a profile needs the generated profile data to answer at all.
local deployed = type(parts.api) == "table" and type(parts.socket) == "table"
    and type(parts.native) == "table" and type(parts.profile) == "table"
    and type(parts.profile_data) == "table"

-- `env` is the adapter-facing callback table built by sar_dcs_env.environment; the Lua 5.1 tests
-- inject the same shape. The sampler never reads an engine global itself.
function M.new(send, env)
    return M.collector.new(send, env, M.protocol, M.dcs_env)
end

-- Production wiring: HELLO/COMPAT/CAPS and the DCS Export callbacks, installed only when the
-- adapter reports a model clock (a bare sampler in the tests has no socket and no engine).
local api
if type(parts.api) == "table" and type(parts.api.new) == "function" then api = parts.api.new(_G) end
local function boot_log(message)
    if not api then return end
    pcall(function()
        local dir = api:writedir()
        if type(dir) ~= "string" or dir == "" then return end
        local file = io.open(dir .. [[Scripts\AESA-SAR\export_diag.log]], "a")
        if file then file:write("AESA-SAR: " .. tostring(message) .. "\n") file:close() end
    end)
end
boot_log("entry runtime=" .. tostring(AESA_RUNTIME ~= nil) .. " deployed=" .. tostring(deployed)
    .. " api=" .. type(parts.api) .. " profile_data=" .. type(parts.profile_data))
if AESA_RUNTIME and deployed then
    local native = parts.native.new(_G)
    local profile = parts.profile.new(parts.profile_data, "generated")
    local transport = parts.transport.new({
        api = api, native = native, socket = parts.socket, profile = profile,
        protocol = parts.protocol, dcs_env = parts.dcs_env, sampler = M.new,
        compat = string.format("COMPAT,%s,%s", profile:id(), profile:matrix_hash()),
    })
    boot_log("transport install=" .. tostring(transport.install()))
end

return M

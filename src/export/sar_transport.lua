-- Connection lifecycle and frame pump of the SAR Export.
--
-- One non-blocking TCP session to the service: the HELLO/COMPAT/CAPS handshake, a bounded number of
-- commands read per frame, the sampler's lines buffered and flushed with partial-write recovery, and
-- the DCS Export callbacks installed around them. Reconnection cadence and the fatal/transient split
-- live here too — a missing LuaSocket module cannot appear by retrying, a refused connection can.
--
-- The module knows the wire only through the protocol table and the game only through the adapter
-- (`api`) plus the environment builder; it never formats a job line itself.
local M = {}

-- Connection states, so callers do not parse reasons: "idle" (no socket, retry allowed), "fatal"
-- (no socket and retrying cannot help this session) and "open".
M.IDLE, M.FATAL, M.OPEN = "idle", "fatal", "open"

-- `spec` carries api (export adapter), native (native adapter), socket (runtime socket module),
-- profile, compat (the COMPAT line), protocol, dcs_env/capabilities and `sampler`, the factory that
-- builds a collector for one connection.
function M.new(spec)
    local api, native_api, profile = spec.api, spec.native, spec.profile
    local protocol, dcs_env, new_sampler = spec.protocol, spec.dcs_env, spec.sampler
    local runtime_socket, compat = spec.socket, spec.compat
    local client, sampler, pending, partial, retry, last_model = nil, nil, "", "", -1e9, nil
    local socket_missing = false
    local diag_file

    local function diagnostic(message)
        local text = "AESA-SAR: " .. tostring(message)
        local logged, wrote = pcall(api.log_write, api, "INFO", text)
        if logged and wrote then return end
        -- Export state has no `log` table in some builds; keep the same file fallback as A/A so a
        -- failed connection or skipped install is not silent.
        pcall(function()
            if not diag_file then
                local dir = api:writedir()
                if type(dir) == "string" and dir ~= "" then
                    diag_file = io.open(dir .. [[Scripts\AESA-SAR\export_diag.log]], "a")
                end
            end
            if diag_file then
                local wall = ""
                pcall(function() wall = os.date("%H:%M:%S ") end)
                diag_file:write(string.format("%s %8.2f %s\n", wall, last_model or -1, text))
                diag_file:flush()
            end
        end)
    end
    local function model_time() return api:model_time() end

    local function close()
        if client then pcall(function() client:close() end) end
        client, sampler, pending, partial = nil, nil, "", ""
    end

    -- Returns client | nil, reason, fatal. A missing LuaSocket module is fatal for this Export
    -- session (retrying cannot materialise it); a refused connection is not, because the receiver
    -- may simply not be up yet.
    local function connect()
        local ok, sock, why = pcall(function() return runtime_socket.bootstrap(_G) end)
        if not ok then return nil, tostring(sock), true end
        if type(sock) ~= "table" or type(sock.tcp) ~= "function" then
            return nil, why or "missing:socket", true
        end
        local made, c = pcall(sock.tcp)
        if not made or (type(c) ~= "table" and type(c) ~= "userdata") then
            return nil, "socket.tcp:" .. tostring(c), true
        end
        local ready, err = pcall(function()
            c:settimeout(0.01)
            if not c:connect(protocol.HOST, protocol.PORT) then error("connect failed") end
            c:settimeout(0)
        end)
        if not ready then pcall(function() c:close() end) return nil, tostring(err), false end
        return c
    end
    local function frame()
        local t = protocol.safe(model_time)
        if not t then return end
        if last_model and t < last_model then retry = -1e9 end
        last_model = t
        if not client then
            if socket_missing or t < retry then return end
            retry = t + 2
            local c, why, fatal = connect()
            if not c then
                if fatal then
                    socket_missing = true
                    diagnostic("socket unavailable: " .. tostring(why))
                end
                return
            end
            local caps = dcs_env.capabilities(api)
            client = c
            -- COMPAT follows HELLO as a separate additive line: an older service ignores it, and a
            -- current one records the profile and matrix hash.
            pending = "HELLO," .. protocol.VERSION .. "\n" .. compat .. "\nCAPS," .. protocol.CAPS .. ","
                .. (caps.terrain_get_surface_type == "ok" and protocol.SURFACE_PROVIDER or "unavailable") .. ",map\n"
            sampler = new_sampler(function(line) pending = pending .. line .. "\n" end,
                dcs_env.environment(api, native_api, caps, profile))
            diagnostic("connected; height=" .. tostring(caps.terrain_get_height == "ok")
                .. " surface=" .. tostring(caps.terrain_get_surface_type == "ok"))
        end
        -- Process at most four commands per frame; do not execute remote Lua.
        for _ = 1, 4 do
            local line, err, fragment = client:receive("*l", partial)
            partial = line and "" or (fragment or "")
            if #partial > 160 or err == "closed" then close() return end
            if line then sampler.command(line) else break end
        end
        sampler.tick(t)
        if #pending > 65536 then close() return end
        if #pending > 0 then
            local sent, err, last = client:send(pending)
            local count = sent or last or 0
            pending = string.sub(pending, count + 1)
            if err and err ~= "timeout" then close() end
        end
    end

    local function reset()
        close() retry = -1e9 last_model = nil socket_missing = false
    end

    -- DCS calls these globals; tests that load only the sampler never reach here. The callback chain
    -- keeps whatever the user already had installed, so this Export coexists with SRS/Tacview.
    local function install()
        local caps = dcs_env.capabilities(api)
        if caps.model_time ~= "ok" then
            diagnostic("install skipped: model_time=" .. tostring(caps.model_time))
            return false
        end
        local old_start, old_stop, old_frame = LuaExportStart, LuaExportStop, LuaExportAfterNextFrame
        LuaExportStart = function()
            if old_start then pcall(old_start) end
            reset()
        end
        LuaExportStop = function()
            close()
            if old_stop then pcall(old_stop) end
        end
        LuaExportAfterNextFrame = function()
            if old_frame then pcall(old_frame) end
            local ok, err = pcall(frame)
            if not ok then diagnostic(tostring(err)) close() end
        end
        return true
    end

    local function status()
        if client then return M.OPEN end
        return socket_missing and M.FATAL or M.IDLE
    end

    return { close = close, frame = frame, install = install, status = status }
end

return M

-- Command/tick state machine of the SAR Export: one square patch job and one coarse MAP job,
-- both driven by the model clock and both answering on the wire in the order the service expects.
--
-- The sampler owns no game API (env.* is the whole surface it may touch) and no wire constant
-- (P is the protocol module). Everything here is sequence, bounds and formatting, which is what the
-- service's Collector parses; the physics of the resulting scene is the service's.
local M = {}

-- `new(send, env, P, D)` builds one sampler. `send(line)` appends one wire line, `env` is the
-- adapter-facing callback table (sar_dcs_env.environment, or the same shape injected by the tests),
-- `P` is sar_protocol and `D` is sar_dcs_env.
function M.new(send, env, P, D)
    local finite, fields, surface = P.finite, P.fields, P.surface
    -- Lines drained per frame: one SAR surface row (P.N cells) or one MAP lattice row, so the budget
    -- is the patch width rather than a number of its own.
    local LINES_PER_FRAME = P.N
    local state = { job = nil, map = nil, last = nil, status_t = -1e9, surface_fine = false,
        probe = nil, probe_checked = false }

    local function height_ready() return D.height_ready(env) end
    local function cell_surface(x, z) return D.cell_surface(env, state, x, z, P) end

    local function fail(reason)
        if state.job then send("FAIL," .. state.job.id .. "," .. reason) end
        state.job = nil
    end
    local function fail_map(reason)
        if state.map then send("FAIL," .. state.map.id .. "," .. reason) end
        state.map = nil
    end

    function state.command(line)
        if #line > 160 then return end
        local a = fields(line)
        if a[1] == "CANCEL" then fail("cancelled") if state.map then fail_map("cancelled") end return end
        -- The service asks for the fine 16-class surface vocabulary once per connection. An older service
        -- never sends this and keeps getting the five-class words above.
        if a[1] == "SURFACE_FINE" then state.surface_fine = true return end
        local map, relative = a[1] == "CAPTURE_MAP", a[1] == "CAPTURE_MAP_AT"
        if map or relative then
            if #a ~= 7 or not string.match(a[2], "^%d+$") then return end
            local id, x0, z0 = tonumber(a[2]), tonumber(a[3]), tonumber(a[4])
            local cols, rows, step = tonumber(a[5]), tonumber(a[6]), tonumber(a[7])
            local bound = relative and 1e5 or 1e8
            if not (finite(id) and finite(x0) and finite(z0) and finite(cols) and finite(rows) and finite(step)) then return end
            if id > 1e9 or math.abs(x0) > bound or math.abs(z0) > bound
                or step < P.MAP_STEP[1] or step > P.MAP_STEP[2] or step ~= math.floor(step)
                or cols ~= math.floor(cols) or rows ~= math.floor(rows)
                or cols < 1 or rows < 1 or cols > P.MAP_ROWS or rows > P.MAP_ROWS or cols * rows > P.MAP_CELLS then return end
            if state.map then send("FAIL," .. id .. ",map_busy") return end
            local own = env.self()
            if not own or not own.Position or not finite(own.Position.x) or not finite(own.Position.z) then send("FAIL," .. id .. ",no_ownship") return end
            if not height_ready() then send("FAIL," .. id .. ",terrain_unavailable") return end
            if relative then x0, z0 = own.Position.x + x0, own.Position.z + z0 end
            if math.abs(x0) > 1e8 or math.abs(z0) > 1e8 then send("FAIL," .. id .. ",map_origin_out_of_range") return end
            -- MAPBEGIN carries the origin the server must place the cells on, because a relative
            -- request is resolved here: the server does not know the aircraft position before the job.
            state.map = { id = id, x0 = x0, z0 = z0, cols = cols, rows = rows, step = step, index = 0, seq = 0, pose_t = -1e9 }
            send(string.format("MAPBEGIN,%d,%.9f,%.9f,%d,%d,%d", id, x0, z0, cols, rows, step))
            -- Additive marker, not an eighth MAPBEGIN field: the deployed service requires exactly seven
            -- fields there, while an unknown MAP* line is ignored, so old and new ends keep working.
            send(string.format("MAPGRID,%d,col_x_row_z", id))
            return
        end
        local geographic, world = a[1] == "CAPTURE_GEO", a[1] == "CAPTURE_WORLD"
        if (a[1] ~= "CAPTURE" and not geographic and not world) or (#a ~= 4 and #a ~= 6) or not string.match(a[2], "^%d+$") then return end
        local size, n = tonumber(a[5] or P.SIZE), tonumber(a[6] or P.N)
        if not P.allowed(size, n) then return end
        local id, side, range = tonumber(a[2]), tonumber(a[3]), tonumber(a[4])
        if not finite(id) or id > 1e9 or not finite(side) or not finite(range) then return end
        if geographic then
            if math.abs(side) > 90 or math.abs(range) > 180 then return end
        elseif not world and ((side ~= -1 and side ~= 1) or range < 1000 or range > 50000) then return end
        if state.job then send("FAIL," .. id .. ",busy") return end
        local own, velocity = env.self(), env.velocity()
        if not own or not own.Position or not velocity then send("FAIL," .. id .. ",no_ownship") return end
        local p = own.Position
        if not finite(p.x) or not finite(p.y) or not finite(p.z)
            or not finite(velocity.x) or not finite(velocity.z)
            or velocity.x^2 + velocity.z^2 < 100 then send("FAIL," .. id .. ",ground_speed_too_low") return end
        if not height_ready() then send("FAIL," .. id .. ",terrain_unavailable") return end
        local track = math.atan2(velocity.z, velocity.x)
        local bearing = track + side * math.pi / 4
        local x, z = p.x + range * math.cos(bearing), p.z + range * math.sin(bearing)
        local latitude, longitude
        if geographic then
            if type(env.geo) ~= "function" then send("FAIL," .. id .. ",geo_unavailable") return end
            latitude, longitude = side, range
            local ok, point = pcall(env.geo, longitude, latitude)
            if not ok or type(point) ~= "table" or not finite(point.x) or not finite(point.z) then
                send("FAIL," .. id .. ",geo_conversion_failed") return
            end
            x, z = point.x, point.z
            range = math.sqrt((x - p.x) ^ 2 + (z - p.z) ^ 2)
            if range < 1000 or range > 50000 then send("FAIL," .. id .. ",target_range_1_to_50_km," .. string.format("%.0f", range)) return end
            bearing = math.atan2(z - p.z, x - p.x)
        elseif world then
            x, z = side, range
            range = math.sqrt((x - p.x) ^ 2 + (z - p.z) ^ 2)
            if range < 1000 or range > 50000 then send("FAIL," .. id .. ",target_range_1_to_50_km," .. string.format("%.0f", range)) return end
            bearing = math.atan2(z - p.z, x - p.x)
        end
        if not geographic and type(env.inverse_geo) == "function" then
            local ok, point = pcall(env.inverse_geo, x, z)
            if ok and type(point) == "table" and finite(point.latitude) and finite(point.longitude)
                and math.abs(point.latitude) <= 90 and math.abs(point.longitude) <= 180 then
                latitude, longitude = point.latitude, point.longitude
            end
        end
        local relative_track = math.atan2(math.sin(bearing - track), math.cos(bearing - track)) * 180 / math.pi
        state.job = { id = id, x = x, z = z, bearing = bearing, row = 0, index = 0, size = size, n = n, seq = 0,
            latitude = latitude, longitude = longitude, range = range, relative = relative_track }
    end

    function state.tick(t)
        if not finite(t) then return end
        if state.last and t < state.last then fail("model_time_reset") fail_map("model_time_reset") state.status_t = -1e9 end
        state.last = t
        local own = env.self()
        if not own or not own.Position then fail("no_ownship") fail_map("no_ownship") return end
        local p = own.Position
        if not finite(p.x) or not finite(p.y) or not finite(p.z) then fail("invalid_position") fail_map("invalid_position") return end
        if t - state.status_t >= 1 then
            state.status_t = t
            local th = P.safe(env.height, p.x, p.z)
            local lh = P.safe(env.altitude, p.x, p.z)
            local agl = P.safe(env.agl)
            send(string.format("STATUS,%.9f,%s,%s,%s,%s,%d", t, height_ready() and P.HEIGHT_PROVIDER or "unavailable",
                tostring(th or "unknown"), tostring(lh or "unknown"), tostring(agl and p.y - agl or "unknown"),
                type(env.geo) == "function" and 1 or 0))
        end
        local m = state.map
        if m then
            -- Poses travel with the job because the frame render needs a sensor position and the
            -- Export status carries none; a MAP job is therefore self-contained.
            if t - m.pose_t >= P.MAP_POSE then
                m.pose_t = t
                local velocity = env.velocity()
                -- Numbered like the SAR POSE stream: the first frame of a job is 0 and the counter moves
                -- after the frame is sent, so one rule covers both job kinds. The service takes whatever
                -- the first frame says as its baseline, so an Export still numbering from 1 keeps working.
                send(string.format("MAPPOSE,%d,%d,%.9f,%.9f,%.9f,%.9f,%.9f,%.9f", m.id, m.seq, t, p.x, p.y, p.z,
                    velocity and finite(velocity.x) and velocity.x or 0, velocity and finite(velocity.z) and velocity.z or 0))
                m.seq = m.seq + 1
            end
            for _ = 1, LINES_PER_FRAME do
                if m.index >= m.cols * m.rows then break end
                -- Canonical MAP grid (MAPGRID above): col runs along +x, row along +z. Never transpose.
                local col, row = m.index % m.cols, math.floor(m.index / m.cols)
                local x, z = m.x0 + col * m.step, m.z0 + row * m.step
                local y = P.safe(env.height, x, z)
                if not y then fail_map("terrain_query_failed") return end
                send(string.format("MAPHEIGHT,%d,%d,%d,%.9f,%.9f,%.9f", m.id, col, row, x, y, z))
                if env.surface or state.surface_fine then send(string.format("MAPSURFACE,%d,%d,%d,%s", m.id, col, row, cell_surface(x, z))) end
                m.index = m.index + 1
            end
            if m.index >= m.cols * m.rows then
                send(string.format("MAPEND,%d,%d,%.9f", m.id, m.index, t))
                state.map = nil
            end
        end
        local j = state.job
        if not j then return end
        if j.index < j.n * j.n then
            -- Fixed scene basis: cross = (sin(bearing),-cos(bearing)), ground = LOS.
            for _ = 1, LINES_PER_FRAME do
                if j.index >= j.n * j.n then break end
                local row, col = math.floor(j.index / j.n), j.index % j.n
                local ground = (row / (j.n - 1) - 0.5) * j.size
                local cross = (col / (j.n - 1) - 0.5) * j.size
                local x = j.x + cross * math.sin(j.bearing) + ground * math.cos(j.bearing)
                local z = j.z - cross * math.cos(j.bearing) + ground * math.sin(j.bearing)
                local y = P.safe(env.height, x, z)
                if not y then fail("terrain_query_failed") return end
                if j.index == 0 then
                    send(string.format("BEGIN,%d,%.9f,%.9f,%.12f,%d,%d", j.id, j.x, j.z, j.bearing, j.size, j.n))
                    if j.latitude then
                        send(string.format("TARGET,%d,%.9f,%.9f,%.9f,%.9f", j.id, j.latitude, j.longitude, j.range, j.relative))
                    end
                end
                send(string.format("HEIGHT,%d,%d,%.9f,%.9f,%.9f", j.id, j.index, x, y, z))
                if env.surface then send(string.format("SURFACE,%d,%d,%s", j.id, j.index, surface(env.surface, x, z))) end
                j.index = j.index + 1
            end
            j.row = math.floor(j.index / j.n)
            return
        end
        if not j.start then j.start = t j.next = t end
        if t >= j.next then
            send(string.format("POSE,%d,%d,%.9f,%.9f,%.9f,%.9f", j.id, j.seq, t, p.x, p.y, p.z))
            j.seq = j.seq + 1
            j.next = t + 1 / 60
        end
        if t - j.start >= P.DURATION then
            send(string.format("END,%d,%d,%.9f", j.id, j.seq, t))
            state.job = nil
        end
    end
    return state
end

return M

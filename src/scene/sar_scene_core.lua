-- Scene and GMTI sampling core of the mission-side SAR sampler.
--
-- Two independent jobs, both drained a bounded number of lines per frame so a mission frame is never
-- held by a large query:
--   * a scene job — one surface grid over the square patch, then the static-object boxes;
--   * a mover job — the ground movers a GMTI overlay needs, reported as position and velocity.
-- The environment (world search, surface classes, clock) arrives as `env` (sar_mission_env), so this
-- file holds only the sequence and the object-field decisions, which is what the hook and the tests
-- both drive.
local M = { version = 1 }

-- Patch geometries the scene sampler accepts. The bridge only asks for a footprint the Export can
-- collect, so the list is the wire protocol's (sar_protocol.allowed) rather than a second copy of the
-- numbers here. Without it the sampler refuses every job: an unbound core must not guess a grid.
local allowed = nil
function M.configure(P) allowed = P.allowed end

-- The adapter reports one ordered result per search: SCENERY first, then STATIC, then UNIT.
-- It has no per-object category field, so the boundary of each group is found from the last
-- category the adapter saw at a given prefix length. The boundaries are monotonic, hence an
-- exponential probe plus binary refinement over at most 512 objects. A truncated scene result
-- that ends inside SCENERY is entirely scenery; no extra probe is needed in that (common) case.
local RANK = { SCENERY = 1, STATIC = 2, UNIT = 3 }
-- GMTI mover query. world.searchObjects runs synchronously inside the calling frame, so the work is
-- bounded three ways: a 50 km box (the service never asks for more), at most 128 objects inspected
-- and at most 64 movers reported, plus a model-time budget where the mission environment exposes a
-- clock. A partial list is a valid GMTI picture, not an error; the service adds a wall-clock timeout
-- on top (tools/sar_bridge.cjs) so a stalled mission cannot hold up the poll.
local MOVER_RADIUS_MAX, MOVER_VISIT_MAX, MOVER_MAX = 50000, 128, 64
local MOVER_LINES = 16
local MOVER_SEARCH_S = .1
-- Below this an object is not a mover at all; the scene sampler uses the same 1 m/s rule to keep
-- moving objects out of the SAR geometry, and here it keeps parked vehicles out of the report.
local MOVER_MIN_SPEED = 1
-- Scene objects: the surface grid plus at most this many boxes, and the parts of each box that must
-- be valid before it can enter the scene geometry.
local OBJECT_MAX = 128
local OBJECT_BOX_MAX = 500
M.MOVER_RADIUS_MAX, M.MOVER_VISIT_MAX, M.MOVER_MAX, M.MOVER_LINES = MOVER_RADIUS_MAX, MOVER_VISIT_MAX, MOVER_MAX, MOVER_LINES

local function finite(v) return type(v) == "number" and v == v and math.abs(v) < 1e8 end
local function call(obj, name)
    if not obj or type(obj[name]) ~= "function" then return nil end
    local ok, v = pcall(obj[name], obj)
    if ok then return v end
end
local function vector(v) return type(v) == "table" and finite(v.x) and finite(v.y) and finite(v.z) end

local function last_category(result)
    local categories = result.categories
    if type(categories) ~= "table" or #categories == 0 then return nil end
    return categories[#categories]
end

-- Largest index in [low,high] whose category rank does not exceed max_rank.
-- Returns low-1 when the first object is already beyond the group. Exponential
-- probing keeps the extra world visits close to the group size when the group
-- boundary is near `low` (the common static/unit case).
local function last_within(env, point, half, low, high, max_rank)
    if low > high then return low - 1 end
    local function category_at(index)
        local result, why = env.search(point, half, index)
        if not result then return nil, why end
        if #result.objects < index then return nil, "short_result" end
        return last_category(result)
    end
    local first, why = category_at(low)
    if not first then return nil, why end
    if not RANK[first] then return nil, "unknown_category" end
    if RANK[first] > max_rank then return low - 1 end
    local lo, distance = low, 1
    while lo < high do
        local probe = math.min(high, lo + distance)
        local category, why2 = category_at(probe)
        if not category then return nil, why2 end
        if not RANK[category] then return nil, "unknown_category" end
        if RANK[category] <= max_rank then
            lo = probe distance = distance * 2
        else
            local a, b = lo, probe - 1
            while a < b do
                local mid = math.floor((a + b + 1) / 2)
                local inner, why3 = category_at(mid)
                if not inner then return nil, why3 end
                if not RANK[inner] then return nil, "unknown_category" end
                if RANK[inner] <= max_rank then a = mid else b = mid - 1 end
            end
            return a
        end
    end
    return lo
end

-- Split the ordered adapter result into scenery/static/unit counts.
local function boundaries(env, point, half, result)
    local n = #result.objects
    if n == 0 then return 0, 0, n end
    local last = last_category(result)
    if last == "SCENERY" then return n, n, n end
    local e2
    if last == "STATIC" then
        e2 = n
    elseif last == "UNIT" then
        local value, why = last_within(env, point, half, 1, n, 2)
        if not value then return nil, why end
        e2 = value < 0 and 0 or value
    else
        return nil, "unknown_category"
    end
    local s1 = 0
    if e2 > 0 then
        local value, why = last_within(env, point, half, 1, e2, 1)
        if not value then return nil, why end
        s1 = value < 0 and 0 or value
    end
    return s1, e2, n
end

local function objects(env, j)
    local lines, count, skipped, moving = {}, 0, 0, 0
    if not env.world_capable() then return lines, 0, 0, 0, "unavailable" end
    local half = j.size / 2
    local extent = half * (math.abs(math.sin(j.b)) + math.abs(math.cos(j.b))) + 250
    local point = { x = j.x, z = j.z }
    local result = env.search(point, extent, 512)
    if not result then return lines, 0, 0, 0, "query_failed" end
    local s1, e2, n = boundaries(env, point, extent, result)
    if not s1 then return lines, 0, 0, 0, "query_failed" end
    for index, o in ipairs(result.objects) do
        if count >= OBJECT_MAX then break end
        local kind = index <= s1 and "scenery" or (index <= e2 and "static" or "unit")
        local speed = call(o, "getVelocity")
        if call(o, "inAir") == true or (vector(speed) and speed.x ^ 2 + speed.y ^ 2 + speed.z ^ 2 > 1) then
            moving = moving + 1
        else
            local pose, desc = call(o, "getPosition"), call(o, "getDesc")
            local box = type(desc) == "table" and desc.box or nil
            if type(pose) ~= "table" or not vector(pose.p) or not vector(pose.x) or not vector(pose.y) or not vector(pose.z)
                or type(box) ~= "table" or not vector(box.min) or not vector(box.max) then
                skipped = skipped + 1
            else
                local bad = false
                for _, axis in ipairs({ "x", "y", "z" }) do
                    if box.max[axis] <= box.min[axis] or box.max[axis] - box.min[axis] > OBJECT_BOX_MAX then bad = true break end
                end
                if bad then skipped = skipped + 1
                else
                    local a = { "OBJECT", tostring(j.id), tostring(count), kind }
                    for _, v in ipairs({ pose.p, pose.x, pose.y, pose.z, box.min, box.max }) do
                        a[#a + 1] = string.format("%.9f", v.x) a[#a + 1] = string.format("%.9f", v.y) a[#a + 1] = string.format("%.9f", v.z)
                    end
                    lines[#lines + 1] = table.concat(a, ",") count = count + 1
                end
            end
        end
    end
    return lines, count, skipped, moving, "world.searchObjects"
end

-- Ground movers for the GMTI overlay: UNIT and STATIC objects that are not airborne and whose own
-- velocity is non-zero (airborne contacts belong to the radar's air picture, not to GMTI). Reports
-- position and velocity vector; the service decides what the radar can see (Doppler blind zone).
-- The adapter returns objects in SCENERY/STATIC/UNIT order, so the mover filter only accepts the
-- STATIC and UNIT groups. Units are reported before statics, matching the old visit order. If the
-- 128-object adapter budget was consumed before the UNIT group was reached, the poll fails closed
-- instead of pretending the box has no movers.
local function movers(env, j)
    local lines, count, visited, skipped = {}, 0, 0, 0
    if not env.world_capable() then return lines, 0, 0, 0, "unavailable" end
    local point = { x = j.cx, z = j.cz }
    local result = env.search(point, j.radius, MOVER_VISIT_MAX)
    if not result then return lines, 0, 0, 0, "query_failed" end
    local n = #result.objects
    if n == 0 then return lines, 0, 0, 0, "world.searchObjects" end
    local last = last_category(result)
    if last == "SCENERY" then
        if n >= MOVER_VISIT_MAX then return lines, 0, 0, 0, "unavailable" end
        return lines, 0, 0, 0, "world.searchObjects"
    end
    if last ~= "STATIC" and last ~= "UNIT" then return lines, 0, 0, 0, "query_failed" end
    if last == "STATIC" and n >= MOVER_VISIT_MAX then
        -- Units would have come after the truncated static group.
        return lines, 0, 0, 0, "unavailable"
    end
    local s1, e2 = boundaries(env, point, j.radius, result)
    if not s1 then return lines, 0, 0, 0, "query_failed" end
    local started = env.clock()
    local function expired()
        if started == nil then return false end
        local now = env.clock()
        return now ~= nil and now - started > MOVER_SEARCH_S
    end
    local function collect(from, to, kind)
        for index = from, to do
            if count >= MOVER_MAX or visited >= MOVER_VISIT_MAX or expired() then return false end
            visited = visited + 1
            local o = result.objects[index]
            if call(o, "inAir") == true then
                -- airborne contacts belong to the air picture
            else
                local vel = call(o, "getVelocity")
                if not vector(vel) or vel.x ^ 2 + vel.z ^ 2 < MOVER_MIN_SPEED ^ 2 then skipped = skipped + 1
                else
                    local pose = call(o, "getPosition")
                    if type(pose) ~= "table" or not vector(pose.p) then skipped = skipped + 1
                    else
                        local a = { "MOVER", tostring(j.id), tostring(count), kind }
                        for _, v in ipairs({ pose.p, vel }) do
                            a[#a + 1] = string.format("%.9f", v.x) a[#a + 1] = string.format("%.9f", v.y) a[#a + 1] = string.format("%.9f", v.z)
                        end
                        lines[#lines + 1] = table.concat(a, ",") count = count + 1
                    end
                end
            end
        end
        return true
    end
    if not collect(e2 + 1, n, "unit") then return lines, count, visited, skipped, "world.searchObjects" end
    if not collect(s1 + 1, e2, "static") then return lines, count, visited, skipped, "world.searchObjects" end
    return lines, count, visited, skipped, "world.searchObjects"
end

function M.probe(env)
    local surface = env.capabilities().land_surface_type == "ok" and "land.getSurfaceType" or "unavailable"
    return "CAP," .. surface .. "," .. env.mover_capability() .. "," .. env.mover_capability()
end

function M.start(env, id, x, z, b, size, n)
    if not allowed or not finite(id) or id ~= math.floor(id) or not finite(x) or not finite(z) or not finite(b)
        or not allowed(size, n) then
        return "ERROR,invalid_request"
    end
    M.job = { id = id, x = x, z = z, b = b, size = size, n = n, index = 0 }
    return M.probe(env)
end

function M.step(env)
    local j = M.job
    if not j then return "IDLE" end
    local lines = {}
    if env.capabilities().land_surface_type ~= "ok" then M.job = nil return "FAIL," .. j.id .. ",surface_unavailable" end
    for _ = 1, 17 do
        if j.index >= j.n * j.n then break end
        local row, col = math.floor(j.index / j.n), j.index % j.n
        local cross, ground = (col / (j.n - 1) - .5) * j.size, (row / (j.n - 1) - .5) * j.size
        local x = j.x + cross * math.sin(j.b) + ground * math.cos(j.b)
        local z = j.z - cross * math.cos(j.b) + ground * math.sin(j.b)
        local v = env.surface_type(x, z)
        if not finite(v) or v ~= math.floor(v) or v < 1 or v > 5 then M.job = nil return "FAIL," .. j.id .. ",surface_query_failed" end
        lines[#lines + 1] = string.format("SURFACE,%d,%d,%d", j.id, j.index, v) j.index = j.index + 1
    end
    if j.index == j.n * j.n then
        local obj, count, skipped, moving, provider = objects(env, j)
        for _, v in ipairs(obj) do lines[#lines + 1] = v end
        lines[#lines + 1] = string.format("SCENE_END,%d,%d,%d,%d,%s", j.id, count, skipped, moving, provider)
        M.job = nil
    end
    return table.concat(lines, "\n")
end

function M.mover(env, id, cx, cz, radius)
    if not finite(id) or id ~= math.floor(id) or not finite(cx) or not finite(cz) or not finite(radius)
        or radius < 1000 or radius > MOVER_RADIUS_MAX then return "ERROR,invalid_request" end
    M.mover_job = { id = id, cx = cx, cz = cz, radius = radius, lines = nil, index = 0, count = 0, skipped = 0, visited = 0, provider = "unavailable" }
    return "CAP," .. env.mover_capability()
end

-- The mover query is a second, independent job: it neither disturbs an in-flight scene job nor is
-- disturbed by one, and it drains at most MOVER_LINES per frame like the scene sampler's grid rows.
function M.mover_step(env)
    local j = M.mover_job
    if not j then return "IDLE" end
    if not j.lines then
        local lines, count, visited, skipped, provider = movers(env, j)
        j.lines, j.count, j.visited, j.skipped, j.provider = lines, count, visited, skipped, provider
    end
    local out = {}
    for _ = 1, MOVER_LINES do
        if j.index >= #j.lines then break end
        out[#out + 1] = j.lines[j.index + 1] j.index = j.index + 1
    end
    if j.index >= #j.lines then
        out[#out + 1] = string.format("MOVER_END,%d,%d,%d,%d,%s", j.id, j.count, j.visited, j.skipped, j.provider)
        M.mover_job = nil
    end
    return table.concat(out, "\n")
end

return M

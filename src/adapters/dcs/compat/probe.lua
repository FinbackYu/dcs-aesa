-- Read-only DCS compatibility probe (Lua 5.1, no require/io/os).
-- The caller injects a profile accessor and an environment adapter:
--
--   api = {
--     kind    = "export" | "mission" | "hook",
--     call    = function(name, ...) -> value, reason,
--     facts   = table | function,
--     native  = table (native.lua :probe shape, optional),
--     data    = table (RCS/shader/module facts, optional),
--     globals = table (injected environment, optional),
--   }
--
-- Every capability runs in its own pcall. The probe never registers events,
-- opens sockets, writes files or mutates globals; it only reads and samples.
--
-- Output format (one line each):
--   COMPAT_BEGIN,<profile_id>,<matrix_hash>
--   CAP,<key>,<ok|degraded|unavailable|unknown>,<detail>
--   FACT,<name>,<value>
--   COMPAT_END,<cap_count>

local probe = {}
probe.SCHEMA = 1
probe.MAX_DETAIL = 200
probe.MAX_LINE = 512

local STATES = {
    ok = true,
    degraded = true,
    unavailable = true,
    unknown = true,
}

local function finite(value)
    return type(value) == "number" and value == value
        and value ~= math.huge and value ~= -math.huge
end

local function normalize_state(value)
    if value == true then return "ok" end
    if value == false then return "unavailable" end
    if type(value) == "string" and STATES[value] then return value end
    if type(value) == "table" and value.state ~= nil then
        return normalize_state(value.state)
    end
    return "unknown"
end

local function sanitize_detail(text)
    local value = tostring(text == nil and "" or text)
    value = string.gsub(value, "[\r\n]+", " ")
    value = string.gsub(value, ",", ";")
    if #value > probe.MAX_DETAIL then
        value = string.sub(value, 1, probe.MAX_DETAIL - 3) .. "..."
    end
    return value
end

local function escape_fact(value)
    local text = tostring(value)
    text = string.gsub(text, "\\", "\\\\")
    text = string.gsub(text, ",", "\\,")
    text = string.gsub(text, "\r", "\\r")
    text = string.gsub(text, "\n", "\\n")
    return text
end

local function unescape_fact(value)
    local text = tostring(value or "")
    text = string.gsub(text, "\\n", "\n")
    text = string.gsub(text, "\\r", "\r")
    text = string.gsub(text, "\\,", ",")
    text = string.gsub(text, "\\\\", "\\")
    return text
end

local function classify_reason(why)
    local text = tostring(why or "unknown")
    if string.sub(text, 1, 8) == "missing:" then return "unavailable" end
    if string.sub(text, 1, 8) == "loadlib:" then return "unavailable" end
    if string.sub(text, 1, 6) == "empty:" then return "degraded" end
    if string.sub(text, 1, 5) == "type:" then return "degraded" end
    if string.sub(text, 1, 8) == "invalid:" then return "degraded" end
    if string.sub(text, 1, 6) == "error:" then return "degraded" end
    return "degraded"
end

local function applicable_to(kind, key)
    if kind == nil or kind == "unknown" then return true end
    if string.match(key, "^EXP%-") or string.match(key, "^TER%-") then
        return kind == "export"
    end
    if key == "WLD-SEARCH" or key == "LND-SURF" then
        return kind == "mission" or kind == "hook"
    end
    if key == "MSN-COAL" or key == "MSN-LIFE" then
        return kind == "mission"
    end
    if key == "HOOK-CB" then return kind == "hook" end
    if key == "MSN-DOSTRING" then return kind == "mission" or kind == "hook" end
    return true
end

local function profile_get(profile, path, default)
    if type(profile) ~= "table" then return default end
    if type(profile.get) == "function" then
        local ok, value = pcall(profile.get, profile, path, default)
        if ok and value ~= nil then return value end
    end
    local current = profile
    for token in string.gmatch(path, "[^%.]+") do
        if type(current) ~= "table" then return default end
        local value = current[token]
        if value == nil and string.match(token, "^%d+$") then
            value = current[tonumber(token)]
        end
        if value == nil then return default end
        current = value
    end
    return current
end

local function profile_id(profile)
    if type(profile) == "table" and type(profile.id) == "function" then
        local ok, value = pcall(profile.id, profile)
        if ok and type(value) == "string" then return value end
    end
    local value = profile_get(profile, "id", "unknown")
    if type(value) == "string" then return value end
    return "unknown"
end

local function profile_source(profile)
    if type(profile) == "table" and type(profile.profile_source) == "string" then
        return profile.profile_source
    end
    if profile_id(profile) == "dcs-generic" then return "fallback" end
    return "injected"
end

local FNV_OFFSET_HI = 0x811c
local FNV_OFFSET_LO = 0x9dc5
local FNV_PRIME = 16777619

local function xor8(a, b)
    local result = 0
    local bit = 1
    for _ = 1, 8 do
        local aa = a % 2
        local bb = b % 2
        if aa ~= bb then result = result + bit end
        a = math.floor(a / 2)
        b = math.floor(b / 2)
        bit = bit * 2
    end
    return result
end

local function fnv1a32(text)
    local hi = FNV_OFFSET_HI
    local lo = FNV_OFFSET_LO
    for index = 1, #text do
        local byte = string.byte(text, index)
        lo = lo - (lo % 256) + xor8(lo % 256, byte)
        local product = lo * FNV_PRIME
        local carry = math.floor(product / 65536)
        lo = product % 65536
        hi = (hi * FNV_PRIME + carry) % 65536
    end
    return string.format("%04x%04x", hi, lo)
end

local function matrix_hash(profile)
    if type(profile) == "table" and type(profile.matrix_hash) == "function" then
        local ok, value = pcall(profile.matrix_hash, profile)
        if ok and type(value) == "string" then return value end
    end
    local caps = profile_get(profile, "capabilities", {})
    local rows = {}
    if type(caps) == "table" then
        local keys = {}
        for key in pairs(caps) do
            if type(key) == "string" then keys[#keys + 1] = key end
        end
        table.sort(keys)
        for _, key in ipairs(keys) do
            rows[#rows + 1] = key .. "=" .. normalize_state(caps[key]) .. "\n"
        end
    end
    return fnv1a32(table.concat(rows))
end

local function call_api(api, name, ...)
    if type(api) ~= "table" then return nil, "missing:api" end
    local fn = api.call
    if type(fn) == "function" then
        local ok, a, b
        if api.env ~= nil and api.instance == nil then
            ok, a, b = pcall(fn, api, name, ...)
        else
            ok, a, b = pcall(fn, name, ...)
        end
        if not ok then return nil, "error:" .. tostring(a) end
        return a, b
    end
    local instance = api.instance
    if type(instance) == "table" and type(instance.call) == "function" then
        local ok, a, b = pcall(instance.call, instance, name, ...)
        if not ok then return nil, "error:" .. tostring(a) end
        return a, b
    end
    return nil, "missing:api.call"
end

local function collect_facts(api, opts)
    local facts = {}
    local function merge(value)
        if type(value) ~= "table" then return end
        for key, item in pairs(value) do
            if type(key) == "string" then facts[key] = item end
        end
    end
    if type(opts.facts) == "table" then merge(opts.facts) end
    if type(api.facts) == "table" then
        merge(api.facts)
    elseif type(api.facts) == "function" then
        local ok, value = pcall(api.facts)
        if ok then merge(value) end
    end
    if type(api.data) == "table" then merge(api.data.facts) end
    facts.probe_kind = api.kind or api.KIND or opts.kind or "unknown"
    facts.matrix_algorithm = "fnv1a32"
    return facts
end

local function fact_value(value)
    if type(value) == "string" or type(value) == "number" or type(value) == "boolean" then
        return tostring(value)
    end
    if type(value) == "table" then
        local parts = {}
        for key, item in pairs(value) do
            if type(key) == "string"
                and (type(item) == "string" or type(item) == "number" or type(item) == "boolean") then
                parts[#parts + 1] = key .. "=" .. tostring(item)
            end
        end
        table.sort(parts)
        return table.concat(parts, ";")
    end
    return nil
end

local function token_index(line, token)
    local start = 1
    while true do
        local index = string.find(line, token, start, true)
        if not index then return nil end
        local before = index > 1 and string.sub(line, index - 1, index - 1) or ""
        local after = string.sub(line, index + #token, index + #token)
        if (before == "" or not string.match(before, "[A-Za-z0-9_]"))
            and (after == "" or after == "," or after == " ") then
            return index
        end
        start = index + #token
    end
end

function probe.run(profile, api, opts)
    opts = opts or {}
    api = api or {}
    local kind = api.kind or api.KIND or opts.kind or "unknown"
    local result = {
        schema = probe.SCHEMA,
        kind = kind,
        profile_id = profile_id(profile),
        profile_source = profile_source(profile),
        matrix_hash = matrix_hash(profile),
        facts = {},
        caps = {},
        errors = {},
        complete = false,
    }
    local facts = collect_facts(api, opts)
    result.facts = facts
    local self_cache = nil
    local self_loaded = false
    local native_cache = nil
    local native_loaded = false
    local point_cache = nil

    local function get_self()
        if not self_loaded then
            local value, why = call_api(api, "self_data")
            self_cache = { value = value, why = why }
            self_loaded = true
        end
        return self_cache.value, self_cache.why
    end

    local function get_native()
        if not native_loaded then
            if type(api.native) == "table" then
                native_cache = api.native
            elseif type(api.native) == "function" then
                local ok, value = pcall(api.native)
                if ok then native_cache = value end
            else
                local value = call_api(api, "native_info")
                if type(value) == "table" then native_cache = value end
            end
            native_loaded = true
        end
        return native_cache
    end

    local function get_point()
        if point_cache then return point_cache end
        if type(opts.point) == "table"
            and finite(opts.point.x) and finite(opts.point.z) then
            point_cache = opts.point
            return point_cache
        end
        local own = get_self()
        if type(own) == "table" then
            local position = own.Position or own.position
            if type(position) == "table"
                and finite(position.x) and finite(position.z) then
                point_cache = { x = position.x, y = position.y or 0, z = position.z }
                return point_cache
            end
        end
        point_cache = { x = 0, y = 0, z = 0 }
        return point_cache
    end

    local function record(key, state, detail)
        result.caps[key] = {
            state = normalize_state(state),
            detail = sanitize_detail(detail),
        }
    end

    local function check(key, fn)
        local ok, value = pcall(fn)
        if not ok then
            result.errors[#result.errors + 1] = { key = key, err = sanitize_detail(value) }
            record(key, "degraded", "probe-error:" .. tostring(value))
            return
        end
        if type(value) == "table" and value.state ~= nil then
            if normalize_state(value.state) == "unavailable"
                and not applicable_to(result.kind, key) then
                record(key, "unknown", "not-probed-in-" .. tostring(result.kind))
            else
                record(key, value.state, value.detail)
            end
        else
            record(key, "unknown", "not-probed")
        end
    end

    local function callbacks_fact()
        local value = facts.export_callbacks
        if type(value) == "table" then return value end
        local current = call_api(api, "export_callbacks")
        if type(current) == "table" then return current end
        return nil
    end

    local function symbol_state(section, expected)
        local symbols = section and section.symbols
        if type(symbols) ~= "table" then
            return { state = "unknown", detail = "not observed" }
        end
        local missing = symbols.missing
        local missing_count = type(missing) == "table" and #missing or 0
        local total = symbols.total or 0
        local loaded = symbols.loaded or 0
        if total == 0 then total = loaded + missing_count end
        if total == 0 then return { state = "unknown", detail = "no symbols" } end
        if expected and total < expected then
            return { state = "degraded", detail = loaded .. "/" .. total .. " expected=" .. expected }
        end
        if loaded >= total then return { state = "ok", detail = loaded .. "/" .. total } end
        if loaded > 0 then return { state = "degraded", detail = loaded .. "/" .. total } end
        return { state = "unavailable", detail = "0/" .. total }
    end

    local checks = {
        { "BUILD", function()
            local build = facts.build or opts.build
            local variant = facts.variant or opts.variant
            local expected_build = profile_get(profile, "build", nil)
            local expected_variant = profile_get(profile, "variant", nil)
            if build == nil then
                return { state = "unknown", detail = "build not observed" }
            end
            if result.profile_id == "dcs-generic" then
                return { state = "ok", detail = "generic" }
            end
            if expected_build == nil then
                return { state = "unknown", detail = "profile build missing" }
            end
            if tostring(build) ~= tostring(expected_build) then
                return { state = "degraded", detail = "build=" .. tostring(build) .. " profile=" .. tostring(expected_build) }
            end
            if variant ~= nil and expected_variant ~= nil and variant ~= "unknown"
                and tostring(variant) ~= tostring(expected_variant) then
                return { state = "degraded", detail = "variant=" .. tostring(variant) }
            end
            if variant == nil and expected_variant ~= nil and expected_variant ~= "unknown" then
                return { state = "degraded", detail = "variant not observed" }
            end
            return { state = "ok", detail = tostring(build) }
        end },
        { "EXP-LOAD", function()
            local callbacks = callbacks_fact()
            if type(callbacks) ~= "table" then
                return { state = "unknown", detail = "not observed" }
            end
            if callbacks.loaded == true then return { state = "ok", detail = "loaded" } end
            if callbacks.loaded == false then return { state = "unavailable", detail = "not loaded" } end
            return { state = "unknown", detail = "loaded not observed" }
        end },
        { "EXP-AFTER", function()
            local callbacks = callbacks_fact()
            if type(callbacks) ~= "table" then
                return { state = "unknown", detail = "not observed" }
            end
            if callbacks.after_next_frame == true then return { state = "ok", detail = "callback present" } end
            if callbacks.after_next_frame == false then return { state = "unavailable", detail = "callback missing" } end
            return { state = "unknown", detail = "callback not observed" }
        end },
        { "EXP-ACT", function()
            local callbacks = callbacks_fact()
            if type(callbacks) ~= "table" then
                return { state = "unknown", detail = "not observed" }
            end
            local value = callbacks.activity_next_event
            if value == "passthrough" then return { state = "ok", detail = "passthrough" } end
            if value == false then return { state = "unavailable", detail = "blocked" } end
            if type(value) == "string" then return { state = "degraded", detail = value } end
            return { state = "unknown", detail = "not observed" }
        end },
        { "EXP-SELF", function()
            local value, why = get_self()
            if why then return { state = classify_reason(why), detail = why } end
            if type(value) ~= "table" then return { state = "degraded", detail = "not a table" } end
            local position = value.Position or value.position
            if type(position) ~= "table"
                or not finite(position.x) or not finite(position.y) or not finite(position.z) then
                return { state = "unavailable", detail = "Position missing" }
            end
            facts.own_type = facts.own_type or value.Type or value.Name
            local attitude = finite(value.Heading) and finite(value.Pitch) and finite(value.Bank)
            if not attitude then return { state = "degraded", detail = "attitude missing" } end
            return { state = "ok", detail = "position+attitude" }
        end },
        { "EXP-WORLD", function()
            local value, why = call_api(api, "world_objects")
            if why then return { state = classify_reason(why), detail = why } end
            if type(value) ~= "table" then return { state = "degraded", detail = "not a table" } end
            local count = 0
            local first = nil
            local sample = nil
            for _, object in pairs(value) do
                count = count + 1
                if first == nil then first = object end
                if type(object) == "table" then
                    local position = object.Position or object.position
                    local coalition = object.CoalitionID
                    if coalition == nil then coalition = object.coalition_id end
                    if type(position) == "table" and finite(position.x)
                        and (coalition == 1 or coalition == 2) then
                        sample = object
                    end
                end
            end
            facts.world_object_count = count
            if count == 0 then return { state = "degraded", detail = "no objects" } end
            if type(first) ~= "table" then return { state = "degraded", detail = "object not a table" } end
            local chosen = sample or first
            local position = chosen.Position or chosen.position
            if type(position) ~= "table" or not finite(position.x) then
                return { state = "unavailable", detail = "object Position missing" }
            end
            local coalition = chosen.CoalitionID
            if coalition == nil then coalition = chosen.coalition_id end
            if coalition ~= 1 and coalition ~= 2 then
                return { state = "degraded", detail = "CoalitionID missing" }
            end
            return { state = "ok", detail = "objects=" .. count }
        end },
        { "EXP-TIME", function()
            local value, why = call_api(api, "model_time")
            if why then return { state = classify_reason(why), detail = why } end
            if not finite(value) then return { state = "degraded", detail = "model time not finite" } end
            return { state = "ok", detail = string.format("%.3f", value) }
        end },
        { "EXP-VEL", function()
            local value, why = call_api(api, "vector_velocity")
            if why then return { state = classify_reason(why), detail = why } end
            if type(value) ~= "table"
                or not finite(value.x) or not finite(value.y) or not finite(value.z) then
                return { state = "degraded", detail = "shape invalid" }
            end
            if value.x == 0 and value.y == 0 and value.z == 0 then
                return { state = "degraded", detail = "zero velocity" }
            end
            return { state = "ok", detail = "vector velocity" }
        end },
        { "EXP-TGT", function()
            local value, why = call_api(api, "target_information")
            if why then return { state = classify_reason(why), detail = why } end
            if type(value) ~= "table" then return { state = "degraded", detail = "not a table" } end
            local count = 0
            for _ in pairs(value) do count = count + 1 end
            facts.target_count = count
            if count == 0 then return { state = "degraded", detail = "no engine contacts" } end
            return { state = "ok", detail = "contacts=" .. count }
        end },
        { "EXP-GEO", function()
            local lon, lat = 40, 45
            local own = get_self()
            if type(own) == "table" and type(own.LatLongAlt) == "table" then
                local altitude = own.LatLongAlt
                local own_lat = altitude.lat
                if own_lat == nil then own_lat = altitude.Lat end
                local own_lon = altitude.lon
                if own_lon == nil then own_lon = altitude.Lon end
                if finite(own_lat) and finite(own_lon) then
                    lat = own_lat
                    lon = own_lon
                end
            end
            facts.geo_order = profile_get(profile, "export.geo.order", "lon,lat")
            local x, z = call_api(api, "geo_forward", lon, lat)
            if x == nil then
                return { state = classify_reason(z), detail = z }
            end
            if not finite(x) or not finite(z) then
                return { state = "degraded", detail = "forward shape" }
            end
            local inverse, why = call_api(api, "geo_inverse", x, z)
            if inverse == nil then
                return { state = "degraded", detail = "inverse:" .. tostring(why) }
            end
            if type(inverse) ~= "table" then
                return { state = "degraded", detail = "inverse shape" }
            end
            local inverse_lat = inverse.latitude
            if inverse_lat == nil then inverse_lat = inverse.lat end
            local inverse_lon = inverse.longitude
            if inverse_lon == nil then inverse_lon = inverse.lon end
            if not finite(inverse_lat) or not finite(inverse_lon) then
                return { state = "degraded", detail = "inverse fields" }
            end
            local delta_lat = math.abs(inverse_lat - lat)
            local delta_lon = math.abs(inverse_lon - lon)
            if delta_lat <= 0.05 and delta_lon <= 0.05 then
                return { state = "ok", detail = "roundtrip" }
            end
            return { state = "degraded", detail = string.format("roundtrip delta=%.3f/%.3f", delta_lat, delta_lon) }
        end },
        { "EXP-ALT", function()
            local point = get_point()
            local value, why = call_api(api, "altitude", point.x, point.z)
            if why then return { state = classify_reason(why), detail = why } end
            if not finite(value) then return { state = "degraded", detail = "not finite" } end
            return { state = "degraded", detail = "available; semantics unverified" }
        end },
        { "TER-GH", function()
            local point = get_point()
            local value, why = call_api(api, "terrain_height", point.x, point.z)
            if why then return { state = classify_reason(why), detail = why } end
            if not finite(value) then return { state = "degraded", detail = "not finite" } end
            return { state = "ok", detail = string.format("height=%.1f", value) }
        end },
        { "TER-GST", function()
            local point = get_point()
            local value, why = call_api(api, "terrain_surface_type", point.x, point.z)
            if why then return { state = classify_reason(why), detail = why } end
            if type(value) == "number" then
                if value < 1 or value > 5 then return { state = "degraded", detail = "outside 1..5" } end
                return { state = "ok", detail = "class=" .. tostring(value) }
            end
            if type(value) == "string" then
                local name = string.lower(value)
                if name == "land" or name == "sea" or name == "water"
                    or name == "shallow_water" or name == "road" or name == "runway" then
                    return { state = "ok", detail = "name=" .. name }
                end
                return { state = "degraded", detail = "name=" .. name }
            end
            return { state = "degraded", detail = "unexpected result" }
        end },
        { "TER-VIS", function()
            local point = get_point()
            local value, why = call_api(api, "terrain_visible",
                point.x, point.y or 0, point.z, point.x, point.y or 0, point.z)
            if why then return { state = classify_reason(why), detail = why } end
            if type(value) ~= "boolean" then return { state = "degraded", detail = "not boolean" } end
            if value then return { state = "ok", detail = "same point visible" } end
            return { state = "degraded", detail = "same point not visible" }
        end },
        { "WLD-SEARCH", function()
            local point = get_point()
            local anchor = call_api(api, "mission_anchor")
            if type(anchor) == "table" and finite(anchor.x) and finite(anchor.z) then
                point = anchor
            end
            local value, why = call_api(api, "world_search", point, 2000, 8)
            if why then return { state = classify_reason(why), detail = why } end
            if type(value) ~= "table" then return { state = "degraded", detail = "not a table" } end
            local visited = value.visited
            if type(visited) ~= "number" then
                return { state = "degraded", detail = "visited missing" }
            end
            if visited == 0 then return { state = "degraded", detail = "no objects in 2km box" } end
            return { state = "ok", detail = "visited=" .. tostring(visited) }
        end },
        { "LND-SURF", function()
            local point = get_point()
            local value, why = call_api(api, "land_surface_type", point.x, point.z)
            if why then return { state = classify_reason(why), detail = why } end
            if type(value) ~= "number" then return { state = "degraded", detail = "not a number" } end
            if value < 1 or value > 5 then return { state = "degraded", detail = "outside 1..5" } end
            return { state = "ok", detail = "class=" .. tostring(value) }
        end },
        { "MSN-DOSTRING", function()
            local value, why = call_api(api, "dostring_probe")
            if why then return { state = classify_reason(why), detail = why } end
            if type(value) == "string" then
                if string.find(value, "table", 1, true) then return { state = "ok", detail = value } end
                return { state = "degraded", detail = value }
            end
            if type(value) == "table" then
                local result_text = value.result or value.scripting
                if value.ok == true and type(result_text) == "string" then
                    return { state = "ok", detail = result_text }
                end
                if type(result_text) == "string" then
                    return { state = "degraded", detail = result_text }
                end
            end
            return { state = "degraded", detail = "unexpected probe result" }
        end },
        { "MSN-COAL", function()
            local value, why = call_api(api, "coalition_probe")
            if why then return { state = classify_reason(why), detail = why } end
            if type(value) ~= "table" then return { state = "degraded", detail = "not a table" } end
            local score = 0
            if value.side then score = score + 1 end
            if value.get_groups then score = score + 1 end
            if value.get_units then score = score + 1 end
            if value.get_country_coalition then score = score + 1 end
            local controller = call_api(api, "controller_probe")
            if type(controller) == "table" then
                if controller.set_task then score = score + 1 end
                if controller.group_get_controller then score = score + 1 end
            end
            if score >= 6 then return { state = "ok", detail = "coalition/controller read APIs" } end
            if score > 0 then return { state = "degraded", detail = "partial coalition/controller API" } end
            return { state = "unavailable", detail = "coalition read APIs missing" }
        end },
        { "MSN-LIFE", function()
            local value, why = call_api(api, "mission_global")
            if value == nil and type(api.globals) == "table" then
                value = api.globals.AESA_SAR_SCENE
                why = nil
            end
            if why and value == nil then return { state = classify_reason(why), detail = why } end
            if type(value) ~= "table" then return { state = "unavailable", detail = "mission global missing" } end
            if value.version == nil then return { state = "degraded", detail = "version missing" } end
            return { state = "ok", detail = "version=" .. tostring(value.version) }
        end },
        { "HOOK-CB", function()
            local value, why = call_api(api, "hook_callbacks")
            if value == nil and type(api.globals) == "table" then
                local dcs = api.globals.DCS
                if type(dcs) == "table" then
                    value = {
                        model_time = type(dcs.getModelTime) == "function",
                        set_user_callbacks = type(dcs.setUserCallbacks) == "function",
                    }
                    why = nil
                end
            end
            if why and value == nil then return { state = classify_reason(why), detail = why } end
            if type(value) ~= "table" then return { state = "unavailable", detail = "DCS callbacks missing" } end
            local count = 0
            if value.model_time then count = count + 1 end
            if value.set_user_callbacks then count = count + 1 end
            if count == 2 then return { state = "ok", detail = "model time + callbacks" } end
            if count == 1 then return { state = "degraded", detail = "partial DCS callbacks" } end
            return { state = "unavailable", detail = "DCS callbacks missing" }
        end },
        { "IO-SOCK", function()
            local value, why = call_api(api, "socket_probe")
            if value == nil and type(api.globals) == "table" then
                value = api.globals.socket
                why = nil
            end
            if why and value == nil then return { state = classify_reason(why), detail = why } end
            if type(value) ~= "table" then return { state = "unavailable", detail = "socket missing" } end
            if type(value.tcp) == "function" then return { state = "ok", detail = "socket.tcp" } end
            return { state = "degraded", detail = "socket.tcp missing" }
        end },
        { "IO-LFS", function()
            local value, why = call_api(api, "writedir")
            if value == nil and type(api.globals) == "table" then
                local lfs_api = api.globals.lfs
                if type(lfs_api) == "table" and type(lfs_api.writedir) == "function" then
                    local ok, path = pcall(lfs_api.writedir)
                    if ok then value = path; why = nil end
                end
            end
            if why and value == nil then return { state = classify_reason(why), detail = why } end
            if type(value) ~= "string" or value == "" then
                return { state = "degraded", detail = "writedir invalid" }
            end
            facts.writedir = value
            return { state = "ok", detail = value }
        end },
        { "IO-LOADLIB", function()
            local value, why = call_api(api, "loadlib_available")
            if value == nil and type(api.globals) == "table" then
                local package_table = api.globals.package
                if type(package_table) == "table" then
                    value = type(package_table.loadlib) == "function" or nil
                    why = value and nil or ("missing:package" .. ".loadlib")
                end
            end
            if value == true then return { state = "ok", detail = "loadlib" } end
            if value == false then return { state = "unavailable", detail = "loadlib disabled" } end
            if why then return { state = classify_reason(why), detail = why } end
            return { state = "unknown", detail = "not observed" }
        end },
        { "IO-LOG", function()
            local value, why = call_api(api, "log_available")
            if value == nil and type(api.globals) == "table" then
                local log_table = api.globals.log
                if type(log_table) == "table" then
                    value = type(log_table.write) == "function" or nil
                    why = value and nil or "missing:log.write"
                end
            end
            if value == true then return { state = "ok", detail = "log.write" } end
            if value == false then return { state = "unavailable", detail = "log.write disabled" } end
            if why then return { state = classify_reason(why), detail = why } end
            return { state = "unknown", detail = "not observed" }
        end },
        { "NET-PORT", function()
            local value = facts.net_port
            if type(value) ~= "table" and type(api.data) == "table" then
                value = api.data.net_port
            end
            if type(value) ~= "table" then
                return { state = "unknown", detail = "not observed" }
            end
            if value.free == false then
                return { state = "degraded", detail = "port busy" }
            end
            if value.protocol or value.greeting then
                return { state = "ok", detail = "protocol=" .. tostring(value.protocol or value.greeting) }
            end
            return { state = "unknown", detail = "protocol not observed" }
        end },
        { "NAT-AGR-SYM", function()
            local native = get_native()
            if type(native) ~= "table" then return { state = "unknown", detail = "not observed" } end
            local expected = profile_get(profile, "native.agradar.exports", nil)
            if type(expected) ~= "table" then
                expected = profile_get(profile, "native.agradar.symbols", nil)
            end
            return symbol_state(native.agradar, type(expected) == "table" and #expected or 4)
        end },
        { "NAT-AGR-VT", function()
            local native = get_native()
            if type(native) ~= "table" or type(native.agradar) ~= "table" then
                return { state = "unknown", detail = "not observed" }
            end
            local value = native.agradar.vtable_match
            if value == true then return { state = "ok", detail = "vtable match" } end
            if value == false then return { state = "unavailable", detail = "vtable mismatch" } end
            return { state = "unknown", detail = "not observed" }
        end },
        { "NAT-AGR-MASK", function()
            local native = get_native()
            if type(native) ~= "table" or type(native.agradar) ~= "table" then
                return { state = "unknown", detail = "not observed" }
            end
            local match = native.agradar.surface_match
            local total = native.agradar.surface_total
            if type(match) ~= "number" or type(total) ~= "number" or total == 0 then
                return { state = "unknown", detail = "not observed" }
            end
            if match >= total then return { state = "ok", detail = match .. "/" .. total } end
            if match > 0 then return { state = "degraded", detail = match .. "/" .. total } end
            return { state = "unavailable", detail = "0/" .. total }
        end },
        { "NAT-FC-SYM", function()
            local native = get_native()
            if type(native) ~= "table" then return { state = "unknown", detail = "not observed" } end
            local expected = profile_get(profile, "native.fc.trace_exports", nil)
            if type(expected) ~= "table" then
                expected = profile_get(profile, "native.fc.exports", nil)
            end
            return symbol_state(native.fc, type(expected) == "table" and #expected or 7)
        end },
        { "NAT-FC-SITES", function()
            local native = get_native()
            if type(native) ~= "table" or type(native.fc) ~= "table"
                or type(native.fc.sites) ~= "table" then
                return { state = "unknown", detail = "not observed" }
            end
            local loaded = native.fc.sites.loaded or 0
            local total = native.fc.sites.total or 0
            if total == 0 then return { state = "unknown", detail = "not observed" } end
            if loaded >= total then return { state = "ok", detail = loaded .. "/" .. total } end
            if loaded > 0 then return { state = "degraded", detail = loaded .. "/" .. total } end
            return { state = "unavailable", detail = "0/" .. total }
        end },
        { "NAT-FC-OFF", function()
            local native = get_native()
            if type(native) ~= "table" or type(native.fc) ~= "table" then
                return { state = "unknown", detail = "not observed" }
            end
            local value = native.fc.offsets_ok
            if value == true then return { state = "ok", detail = "offsets sanity" } end
            if value == false then return { state = "unavailable", detail = "offsets mismatch" } end
            return { state = "unknown", detail = "not observed" }
        end },
        { "NAT-HASH", function()
            local native = get_native()
            if type(native) ~= "table" or type(native.hashes) ~= "table" then
                return { state = "unknown", detail = "not observed" }
            end
            local value = native.hashes
            if value.ok == true then
                return { state = "ok", detail = value.detail or "module/export hash" }
            end
            if value.ok == false then
                return { state = "unavailable", detail = value.detail or "hash mismatch" }
            end
            if value.version_match == true then
                return { state = "degraded", detail = "module versions match; export digest unknown" }
            end
            return { state = "unknown", detail = "not observed" }
        end },
        { "DAT-RCS", function()
            local data = type(api.data) == "table" and api.data.rcs or nil
            if type(data) ~= "table" then return { state = "unknown", detail = "not observed" } end
            local schema = profile_get(profile, "data.rcs_schema", nil)
            if schema ~= nil and data.schema == nil then
                return { state = "degraded", detail = "schema not observed" }
            end
            if schema ~= nil and data.schema ~= schema then
                return { state = "unavailable", detail = "schema=" .. tostring(data.schema) }
            end
            local entries = profile_get(profile, "data.rcs_entries", nil)
            if entries ~= nil and data.entries == nil then
                return { state = "degraded", detail = "entries not observed" }
            end
            if entries ~= nil and data.entries ~= entries then
                return { state = "degraded", detail = "entries=" .. tostring(data.entries) }
            end
            local required = profile_get(profile, "data.rcs_required_fallbacks", nil)
            if type(required) == "table" then
                for _, name in ipairs(required) do
                    local present = type(data.fallbacks) == "table" and data.fallbacks[name] ~= nil
                    if not present then
                        return { state = "unavailable", detail = "missing fallback " .. tostring(name) }
                    end
                end
            end
            return { state = "ok", detail = "entries=" .. tostring(data.entries or "?") }
        end },
        { "DAT-RCS-COV", function()
            local value = type(api.data) == "table" and api.data.rcs_coverage or nil
            if not finite(value) then return { state = "unknown", detail = "not observed" } end
            if value >= 0.9 then return { state = "ok", detail = string.format("%.2f", value) } end
            return { state = "degraded", detail = string.format("%.2f", value) }
        end },
        { "GFX-RADARFX", function()
            local expected = profile_get(profile, "shader.radar_fx_sha256", nil)
            local actual = type(api.data) == "table" and api.data.radar_fx_sha256 or facts.radar_fx_sha256
            if type(actual) ~= "string" or type(expected) ~= "string" then
                return { state = "unknown", detail = "not observed" }
            end
            if string.lower(actual) == string.lower(expected) then
                return { state = "ok", detail = "hash match" }
            end
            return { state = "degraded", detail = "hash mismatch; DBS fallback" }
        end },
        { "GFX-PRESET", function()
            local expected = profile_get(profile, "shader.radar_lua_sha256", nil)
            local actual = type(api.data) == "table" and api.data.radar_lua_sha256 or facts.radar_lua_sha256
            if type(actual) ~= "string" or type(expected) ~= "string" then
                return { state = "unknown", detail = "not observed" }
            end
            if string.lower(actual) == string.lower(expected) then
                return { state = "ok", detail = "hash match" }
            end
            return { state = "degraded", detail = "preset hash mismatch" }
        end },
        { "MODULE", function()
            local value = type(api.data) == "table" and api.data.module or nil
            if type(value) == "table" and value.state ~= nil then
                return { state = value.state, detail = value.detail }
            end
            if value == nil then return { state = "unknown", detail = "not observed" } end
            return { state = "ok", detail = tostring(value) }
        end },
        { "MAP", function()
            local value = type(api.data) == "table" and api.data.map or nil
            if type(value) == "table" and value.state ~= nil then
                return { state = value.state, detail = value.detail }
            end
            if value == nil then return { state = "unknown", detail = "not observed" } end
            return { state = "ok", detail = tostring(value) }
        end },
        { "MODS", function()
            local value = type(api.data) == "table" and api.data.mods or nil
            if type(value) == "table" and value.state ~= nil then
                return { state = value.state, detail = value.detail }
            end
            if value == nil then return { state = "unknown", detail = "not observed" } end
            return { state = "ok", detail = tostring(value) }
        end },
    }

    for _, entry in ipairs(checks) do
        check(entry[1], entry[2])
    end

    facts.build = facts.build or opts.build
    facts.variant = facts.variant or opts.variant
    facts.profile_id = result.profile_id
    facts.profile_source = result.profile_source
    local keys = {}
    for key in pairs(result.caps) do keys[#keys + 1] = key end
    table.sort(keys)
    result.cap_count = #keys
    result.complete = true
    return result
end

function probe.format(result)
    result = result or {}
    local caps = result.caps or {}
    local facts = result.facts or {}
    local lines = {}
    lines[#lines + 1] = "COMPAT_BEGIN,"
        .. tostring(result.profile_id or "unknown") .. ","
        .. tostring(result.matrix_hash or "unknown")
    local cap_keys = {}
    for key in pairs(caps) do cap_keys[#cap_keys + 1] = key end
    table.sort(cap_keys)
    for _, key in ipairs(cap_keys) do
        local cap = caps[key] or {}
        lines[#lines + 1] = "CAP," .. key .. "," .. normalize_state(cap.state)
            .. "," .. sanitize_detail(cap.detail)
    end
    local fact_keys = {}
    for key, value in pairs(facts) do
        if type(key) == "string" and fact_value(value) ~= nil then
            fact_keys[#fact_keys + 1] = key
        end
    end
    table.sort(fact_keys)
    for _, key in ipairs(fact_keys) do
        local value = fact_value(facts[key])
        if #value > 400 then value = string.sub(value, 1, 397) .. "..." end
        lines[#lines + 1] = "FACT," .. key .. "," .. escape_fact(value)
    end
    lines[#lines + 1] = "COMPAT_END," .. tostring(#cap_keys)
    return table.concat(lines, "\n")
end

function probe.parse(input)
    local lines = {}
    if type(input) == "string" then
        for line in string.gmatch(input .. "\n", "([^\n]*)\n") do
            lines[#lines + 1] = line
        end
    elseif type(input) == "table" then
        lines = input
    end
    local result = {
        profile_id = "unknown",
        matrix_hash = "unknown",
        caps = {},
        facts = {},
        errors = {},
        ignored = 0,
        cap_count = 0,
        complete = false,
    }
    local current = nil
    local blocks = {}
    for _, raw in ipairs(lines) do
        local line = string.gsub(tostring(raw), "\r$", "")
        local begin = token_index(line, "COMPAT_BEGIN")
        if begin then
            current = {
                profile_id = "unknown",
                matrix_hash = "unknown",
                caps = {},
                facts = {},
                errors = {},
                ignored = 0,
                cap_count = 0,
                complete = false,
            }
            local rest = string.sub(line, begin + #"COMPAT_BEGIN")
            local id, hash = string.match(rest, "^,([^,]*),([^,]*)")
            if id and id ~= "" then current.profile_id = id end
            if hash and hash ~= "" then current.matrix_hash = hash end
        elseif current then
            local end_index = token_index(line, "COMPAT_END")
            local cap_index = token_index(line, "CAP")
            local fact_index = token_index(line, "FACT")
            if end_index then
                local rest = string.sub(line, end_index + #"COMPAT_END")
                local count = string.match(rest, "^,(%d+)")
                current.cap_count = tonumber(count) or 0
                current.complete = true
                blocks[#blocks + 1] = current
                current = nil
            elseif cap_index then
                local rest = string.sub(line, cap_index + #"CAP")
                local key, state, detail = string.match(rest, "^,([^,]+),([^,]+),?(.*)$")
                if key and STATES[state] then
                    current.caps[key] = { state = state, detail = detail or "" }
                else
                    current.ignored = current.ignored + 1
                end
            elseif fact_index then
                local rest = string.sub(line, fact_index + #"FACT")
                local key, value = string.match(rest, "^,([^,]+),(.*)$")
                if key then
                    current.facts[key] = unescape_fact(value or "")
                else
                    current.ignored = current.ignored + 1
                end
            end
        end
    end
    local chosen = blocks[#blocks]
    if not chosen then return result end
    local actual = 0
    for _ in pairs(chosen.caps) do actual = actual + 1 end
    chosen.cap_count_actual = actual
    chosen.count_mismatch = chosen.cap_count ~= actual
    return chosen
end

return probe

-- Mission-state environment of the SAR scene sampler: the DCS side of world queries.
--
-- Everything the scene core asks about the live mission lives here: whether world.searchObjects and
-- the three object categories are available, one ordered search, the terrain surface class, the
-- mission clock and the probe string the hook publishes. The core never calls a mission global; it
-- receives this table. Tests inject the same five functions without a DCS state.
--
-- searchObjects runs synchronously inside the calling frame, so `search` is the only place the
-- adapter is touched, and the core decides how many queries a step may spend.
local M = {}

-- `api` is the mission adapter (AESA_RUNTIME.mission.new(_G)).
function M.new(api)
    local env = {}

    function env.capabilities() return api:capabilities() end

    function env.world_capable()
        local c = env.capabilities()
        return c.search_objects == "ok" and c.volume_box == "ok" and c.category_scenery == "ok"
            and c.category_static == "ok" and c.category_unit == "ok"
    end

    -- One ordered adapter result (SCENERY, then STATIC, then UNIT) or nil + reason.
    function env.search(point, half, limit)
        if not env.world_capable() then return nil, "unavailable" end
        local result, why = api:world_search(point, half, limit)
        if type(result) ~= "table" or type(result.objects) ~= "table" then return nil, why or "query_failed" end
        return result
    end

    -- terrain.GetSurfaceType through the adapter, as the raw class number.
    function env.surface_type(x, z)
        if env.capabilities().land_surface_type ~= "ok" then return nil, "surface_unavailable" end
        return api:land_surface_type(x, z)
    end

    -- Model time when the mission state exposes one; nil otherwise (GMTI then has no time budget).
    function env.clock()
        if env.capabilities().timer_get_time ~= "ok" then return nil end
        local value = api:timer_get_time()
        if type(value) == "number" and value == value and math.abs(value) < 1e8 then return value end
    end

    function env.mover_capability()
        return env.world_capable() and "world.searchObjects" or "unavailable"
    end

    return env
end

return M

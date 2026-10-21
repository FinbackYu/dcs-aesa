-- Mission environment. No io/os/require or changes to the mission sandbox.
--
-- Entry of the mission-side SAR sampler: it binds the mission adapter to the environment and the
-- environment to the scene core, and publishes the result as AESA_SAR_SCENE for the hook. The two
-- pieces live next door:
--   sar_mission_env.lua  world.searchObjects / land.* / timer.getTime through the mission adapter
--   sar_scene_core.lua   the surface grid, the object boxes and the GMTI mover job
-- The deployed bundle wraps both into this one chunk and publishes them as AESA_SCENE, the same way
-- the SAR Export gets AESA_SAR.
local parts = assert(AESA_SCENE, "AESA scene modules missing")
local runtime = assert(AESA_RUNTIME, "AESA runtime missing")
local api = runtime.mission.new(_G)

local env = parts.mission_env.new(api)
local core = assert(parts.core, "scene core missing")
-- The accepted patch geometries are the wire protocol's, not the sampler's own: bind them once here.
core.configure(assert(parts.protocol, "scene protocol missing"))

-- The job state belongs to the core; the hook clears `AESA_SAR_SCENE.job` to cancel a job, so the
-- published table forwards reads and writes of the state fields to the core instead of holding a
-- stale copy. Everything else (the MOVER_* bounds) reads through the same metatable.
local M = {
    version = core.version,
    probe = function() return core.probe(env) end,
    start = function(id, x, z, b, size, n) return core.start(env, id, x, z, b, size, n) end,
    step = function() return core.step(env) end,
    mover = function(id, cx, cz, radius) return core.mover(env, id, cx, cz, radius) end,
    mover_step = function() return core.mover_step(env) end,
}
setmetatable(M, { __index = core, __newindex = core })

AESA_SAR_SCENE = M
return M

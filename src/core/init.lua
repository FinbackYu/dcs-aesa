-- core/init.lua —— 纯核心加载入口：dofile 各模块并组装（模块自身不做 require）
-- 配置唯一来源：<root>/../shared/config.lua（由 spec/ 生成）。
-- 用法（Lua 侧）：
--   local core = dofile("<...>/src/core/init.lua").build("<...>/src/core")
--   local aesa = core.new(truth, rcs, sink, seed, opts)
--   aesa:step(dt); local snap = aesa:snapshot()
-- 注入配置：build(root, { config = cfg })；cfg 会先深拷贝再经 config_validate 校验。
-- 本入口不加载任何游戏数据或适配器；DCS 帧/RCS 由 src/adapters/dcs/ 注入。

local M = {}

local function deep_copy(value, seen)
  if type(value) ~= "table" then return value end
  seen = seen or {}
  if seen[value] then return seen[value] end
  local copy = {}
  seen[value] = copy
  for k, v in pairs(value) do copy[k] = deep_copy(v, seen) end
  return copy
end

local function load_config(root, opts)
  local validator = dofile(root .. "/../shared/config_validate.lua")
  local cfg
  if opts.config ~= nil then
    cfg = deep_copy(opts.config)
  else
    cfg = dofile(root .. "/../shared/config.lua")
  end
  validator.validate(cfg)
  return cfg
end

function M.build(root, opts)
  if opts ~= nil and type(opts) ~= "table" then
    error("init.build opts must be a table", 2)
  end
  opts = opts or {}

  local aesa = {}
  aesa.config = load_config(root, opts)

  aesa.constants = dofile(root .. "/constants.lua")
  local pc = aesa.config.physics
  if type(pc) ~= "table" then error("config.physics missing", 2) end
  aesa.constants.configure({
    c_mps = pc.c_mps,
    boltzmann_j_per_k = pc.boltzmann_j_per_k,
    t0_k = pc.t0_k,
  })

  aesa.physics = dofile(root .. "/physics.lua")
  aesa.beam = dofile(root .. "/beam.lua")
  aesa.detection = dofile(root .. "/detection.lua")
  aesa.geometry = dofile(root .. "/geometry.lua")
  aesa.scheduler = dofile(root .. "/scheduler.lua")
  aesa.tracker = dofile(root .. "/tracker.lua")
  aesa.rcs = dofile(root .. "/rcs.lua")
  aesa.measurement = dofile(root .. "/measurement.lua")
  aesa.snapshot = dofile(root .. "/snapshot.lua")
  aesa.core = dofile(root .. "/core.lua")

  aesa.mods = {
    constants = aesa.constants,
    physics = aesa.physics,
    beam = aesa.beam,
    detection = aesa.detection,
    geometry = aesa.geometry,
    scheduler = aesa.scheduler,
    tracker = aesa.tracker,
    measurement = aesa.measurement,
    snapshot = aesa.snapshot,
  }
  aesa.physics.bind(aesa.mods)
  aesa.detection.bind(aesa.mods)
  aesa.geometry.bind(aesa.mods)

  function aesa.new(truth, rcs, sink, seed, run_opts)
    return aesa.core.new(aesa.mods, aesa.config, truth,
                         rcs or aesa.rcs.passthrough(), sink, seed, run_opts)
  end
  return aesa
end

return M

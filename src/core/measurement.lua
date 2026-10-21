-- core/measurement.lua —— MeasurementModel：把真值几何转成雷达可观测的测量值
-- 默认 exact（恒等）；量化模型仅作用于距离/方位/俯仰三个测量量，
-- 门限（in_gate）仍由真值几何决定，避免测量误差改变波束覆盖判定。

local M = {}

local function finite_nonneg(v, name)
  if type(v) ~= "number" or v ~= v or v < 0 or v == math.huge then
    error(name .. " must be a non-negative finite number", 3)
  end
end

function M.exact()
  local o = { kind = "exact" }
  function o:apply(geo) return geo end
  return o
end

-- opts = { range_step_m=, az_step_rad=, el_step_rad= }
-- 步长为 0 表示该维度不量化。
function M.quantized(opts)
  opts = opts or {}
  local dr, da, de = opts.range_step_m or 0, opts.az_step_rad or 0, opts.el_step_rad or 0
  finite_nonneg(dr, "range_step_m")
  finite_nonneg(da, "az_step_rad")
  finite_nonneg(de, "el_step_rad")
  local function q(v, step)
    if step <= 0 then return v end
    return math.floor(v / step + 0.5) * step
  end
  local o = { kind = "quantized", range_step_m = dr, az_step_rad = da, el_step_rad = de }
  function o:apply(geo)
    local out = {}
    for k, v in pairs(geo) do out[k] = v end
    out.R = q(geo.R, dr)
    out.az_rel = q(geo.az_rel, da)
    out.el_rel = q(geo.el_rel, de)
    out.measurement = self.kind
    return out
  end
  return o
end

return M

-- core/rcs.lua —— RCSProvider 接口：优先使用真值目标携带的 rcs_m2，其次按 rcs_class 兜底
-- 类别名与数值均由调用方注入；本模块不含任何机型名、分类正则或官方数据。

local M = {}

local function fail(msg) error(msg, 3) end

-- 无兜底档时使用：只接受真值目标自带的 rcs_m2，缺失即 fail-closed。
function M.passthrough()
  local o = {}
  function o:get(target)
    if type(target) ~= "table" or type(target.rcs_m2) ~= "number" then
      fail("rcs.get: target has no rcs_m2 and no class table is configured")
    end
    return { rcs_m2 = target.rcs_m2, source = target.rcs_source or "provided" }
  end
  return o
end

-- values: { <class> = m2, ... }；default_class 必须存在于 values。
function M.new(values, default_class)
  if type(values) ~= "table" then fail("rcs values must be a table") end
  if type(default_class) ~= "string" then fail("rcs default_class must be a string") end
  if type(values[default_class]) ~= "number" then
    fail("rcs values missing default class '" .. default_class .. "'")
  end
  local o = { values = values, default_class = default_class }
  function o:get(target)
    if type(target) ~= "table" then fail("rcs.get expects a target table") end
    if type(target.rcs_m2) == "number" then
      return { rcs_m2 = target.rcs_m2, source = target.rcs_source or "provided" }
    end
    local class = target.rcs_class or default_class
    local v = values[class]
    if type(v) ~= "number" then
      fail("rcs.get: no value for class '" .. tostring(class) ..
           "' and target has no rcs_m2")
    end
    return { rcs_m2 = v, source = "class-estimate" }
  end
  return o
end

return M

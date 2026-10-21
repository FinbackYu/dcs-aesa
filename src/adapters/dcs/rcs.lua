-- adapters/dcs/rcs.lua —— DCS RCS 数据解析：官方明文标量表 + DCS 机型分档
-- 政策：目标侧数据锚定官方；兜底为【估计】且显式标注。
-- 本模块只把 DCS 机型名解析成 {rcs_m2, rcs_class, source}；核心不识别机型名。

local M = {}

-- fallback 的必需键，与 scripts/extract_rcs.py 的 FALLBACK 保持一致。
local FALLBACK_KEYS = { "fighter", "large", "helicopter", "missile" }

local function fail(msg)
  error(msg, 3)
end

-- 启动校验：缺键时立即报错，避免 missile 等类别在 get() 里静默拿到 nil。
local function validate_fallback(data)
  if type(data) ~= "table" then
    fail("rcs_data 必须是 table（得到 " .. type(data) .. "）")
  end
  if type(data.fallback) ~= "table" then
    fail("rcs_data.fallback 缺失或不是 table")
  end
  local required = table.concat(FALLBACK_KEYS, "/")
  for _, key in ipairs(FALLBACK_KEYS) do
    local value = data.fallback[key]
    if type(value) ~= "number" or value ~= value
       or value == math.huge or value == -math.huge or value <= 0 then
      fail("rcs_data.fallback 缺少有效键 '" .. key ..
           "'（需要 " .. required .. "，值为 >0 的有限数）")
    end
  end
end

-- 大平台/直升机的粗分类启发（typeName 前缀/包含匹配）
local LARGE = { "Tu%-", "KC%-", "C%-1", "C%-2", "C%-3", "C%-130", "B%-", "An%-", "Il%-76", "A400", "KJ%-", "H%-6" }
local HELI = { "Helicopter", "Helo", "Mi%-8", "UH%-1", "UH%-60", "Ka%-50", "Ka%-52", "AH%-", "SA342", "Mi%-24", "Mi%-26", "OH%-58", "CH%-", "SH%-60", "Gazelle" }
-- 导弹/弹药：真实 RCS ~0.05-0.1 m²（flight9 实飞发现 AGM-65D 拿了 5m² 战斗机兜底，
-- 被远距稳定跟踪——真导弹基本不可远距检测）。检测距离 ∝ σ^¼，0.05m² ≈ 1/3 距离。
local MISSILE = { "AGM", "AIM", "GBU", "JDAM", "SDB", "Kh%-", "Kh_", "X%-", "X2", "X3",
                  "X5", "X6", "X7", "R%-27", "R%-33", "R%-37", "R%-40", "R%-60", "R%-73",
                  "R%-77", "R%-3", "PL%-", "PL_", "MICA", "Meteor", "SD%-1", "SD1", "Derby",
                  "9M", "5V5", "48N", "HQ%-", "SAMP", "AAM", "FAB", "MK%-8", "MK8",
                  "KAB", "LS%-6", "LS6" }

local function in_any(name, pats)
  for _, p in ipairs(pats) do
    if name:find(p) then return true end
  end
  return false
end

-- data：rcs_data.lua 的返回值（可替换）
function M.new(data)
  validate_fallback(data)
  -- 构造时固化四档值：即使调用方之后改动 data.fallback，也不会静默返回 nil。
  local fallback = {
    fighter = data.fallback.fighter,
    large = data.fallback.large,
    helicopter = data.fallback.helicopter,
    missile = data.fallback.missile,
  }
  local o = { data = data, fallback = fallback }

  function o:classify(typeName)
    local name = tostring(typeName or "")
    if in_any(name, MISSILE) then return "missile" end
    if in_any(name, HELI) then return "helicopter" end
    if in_any(name, LARGE) then return "large" end
    return "fighter"
  end

  function o:get(typeName)
    local name = tostring(typeName or "")
    local v = data.map[name]
    if v then
      return { rcs_m2 = v, source = "ed-plaintext", rcs_class = nil }
    end
    local cls = self:classify(name)
    return { rcs_m2 = fallback[cls], source = "fallback-estimate", rcs_class = cls }
  end

  function o:resolve(typeName)
    return self:get(typeName)
  end

  return o
end

return M

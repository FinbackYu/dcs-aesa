-- core/constants.lua —— 物理常量、单位换算与可种子随机数
-- 常量由生成配置显式注入（src/shared/config.lua → core/init.build → configure）；
-- 本模块不保存第二份字面量，也不感知任何游戏坐标语义。

local M = {}

local C_LIGHT
local K_BOLTZ
local T0
local PI = math.pi

local function finite_positive(v)
  return type(v) == "number" and v == v and v ~= math.huge and v ~= -math.huge and v > 0
end

function M.configure(p)
  if type(p) ~= "table" then error("constants.configure expects a table", 2) end
  if not finite_positive(p.c_mps) then
    error("constants.configure: c_mps must be a positive finite number", 2)
  end
  if not finite_positive(p.boltzmann_j_per_k) then
    error("constants.configure: boltzmann_j_per_k must be a positive finite number", 2)
  end
  if not finite_positive(p.t0_k) then
    error("constants.configure: t0_k must be a positive finite number", 2)
  end
  C_LIGHT, K_BOLTZ, T0 = p.c_mps, p.boltzmann_j_per_k, p.t0_k
  return M
end

function M.light_speed() return C_LIGHT end
function M.boltzmann() return K_BOLTZ end
function M.t0() return T0 end

function M.db_to_lin(db) return 10 ^ (db / 10) end
function M.lin_to_db(l) return 10 * math.log10(l) end
function M.deg2rad(d) return d * PI / 180 end
function M.rad2deg(r) return r * 180 / PI end

-- 可种子随机（Park–Miller LCG）：同一种子同一序列，测试可复现
function M.make_rng(seed)
  local x = math.floor(seed or 1)
  if x <= 0 then x = x + 2147483646 end
  return function()
    x = (x * 16807) % 2147483647
    return x / 2147483647.0
  end
end

return M

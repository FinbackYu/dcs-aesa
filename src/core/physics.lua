-- core/physics.lua —— 雷达方程与检测统计：纯函数，无状态、无 IO
-- 理论依据：docs/theory-notes.md §1–§4
-- 本模块不读写任何坐标轴；几何由 core/geometry.lua 提供。

local M = {}

local constants = nil
local PI = math.pi

function M.bind(mods)
  constants = mods.constants
  return M
end

local function C() return constants.light_speed() end

-- §1 驻留能量形式雷达方程（单基地，全相参积累等效）
-- a = {R=, sigma=, theta=扫描角, Td=驻留时长}
function M.snr(rc, a)
  local g0 = constants.db_to_lin(rc.gain0_db)
  local g = g0 * (math.cos(a.theta or 0) ^ (rc.scan_k or 1))
  local effective_Td = rc.coherence_time_s and math.min(a.Td, rc.coherence_time_s) or a.Td
  local e = (a.ptx_avg_w or rc.ptx_avg_w) * effective_Td * (rc.integration_efficiency or 1)
  local noise = constants.boltzmann() * constants.t0() * constants.db_to_lin(rc.nf_db)
  local loss = constants.db_to_lin(rc.loss_db)
  local den = (4 * PI) ^ 3 * a.R ^ 4 * noise * loss
  return e * g * g * rc.lambda_m ^ 2 * a.sigma / den
end

-- §2 Swerling-1 单驻留闭式
function M.pd_swerling1(snr, pfa) return pfa ^ (1 / (1 + snr)) end
function M.snr_req_swerling1(pd, pfa) return math.log(pfa) / math.log(pd) - 1 end

-- §2 Albersheim（非起伏 + N 脉冲非相参，对照用）
function M.albersheim_db(pd, pfa, n)
  local a = math.log(0.62 / pfa)
  local b = math.log(pd / (1 - pd))
  return -5 * math.log10(n) + (6.2 + 4.54 / math.sqrt(n + 0.44))
      * math.log10(a + 0.12 * a * b + 1.7 * b)
end

-- §1 数值求 Rmax：pd(snr(R)) = pd 对应的距离
function M.rmax(rc, sigma, theta, Td, pd)
  local snr_req = M.snr_req_swerling1(pd, rc.pfa)
  local lo, hi = 100.0, 2e6 -- m
  for _ = 1, 60 do
    local mid = 0.5 * (lo + hi)
    if M.snr(rc, { R = mid, sigma = sigma, theta = theta, Td = Td }) > snr_req then lo = mid else hi = mid end
  end
  return 0.5 * (lo + hi)
end

function M.transmit_power(rc, pe)
  return math.min(rc.ptx_avg_w, (rc.ptx_peak_w or math.huge) * pe.tau_s * pe.prf_hz)
end

-- 供波形/检测模块使用的光速
function M.light_speed() return C() end

return M

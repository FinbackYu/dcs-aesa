-- core/detection.lua —— 波形盲区、检测概率与伯努利/起伏判定
-- 纯函数；噪声/光速常量由 core/constants.lua 注入，几何由 core/geometry.lua 提供。

local M = {}

local constants = nil
local physics = nil
local PI = math.pi

function M.bind(mods)
  constants, physics = mods.constants, mods.physics
  return M
end

-- 矩形脉冲，发射期间接收关闭：回波与下一/上一发射脉冲重叠的能量损失。
-- 通过相邻周期的区间交集计算，支持大于 50% 的占空比。
function M.eclipsing_factor(pe, R)
  local period, tau = 1 / pe.prf_hz, pe.tau_s
  local delay = (2 * R / constants.light_speed()) % period
  local lost = 0
  for n = 0, 1 do
    local lo = math.max(delay, n * period)
    local hi = math.min(delay + tau, n * period + tau)
    lost = lost + math.max(0, hi - lo)
  end
  return math.max(0, math.min(1, 1 - lost / tau))
end

-- 近距 cτ/2 为完整脉冲接收的保守下限；周期遮蔽按能量处理。
function M.range_blind(pe, R)
  return R < (pe.min_range_m or constants.light_speed() * pe.tau_s / 2)
      or M.eclipsing_factor(pe, R) < 1e-12
end

-- §4 速度凹口：主瓣杂波 notch + 盲速
-- v_close/v_mlc：目标与主瓣杂波的径向接近速度（m/s，正=接近）
function M.velocity_blind(pe, lambda, v_close, v_mlc)
  local period = lambda * pe.prf_hz / 2
  local function folded(v) return (v + period / 2) % period - period / 2 end
  if math.abs(folded(v_close - v_mlc)) <= pe.notch_half_mps then return true end
  -- 可选的零多普勒/旁瓣杂波滤波器，与主瓣杂波中心独立。
  if pe.zero_notch_half_mps > 0
      and math.abs(folded(v_close)) <= pe.zero_notch_half_mps then return true end
  return false
end

-- §1–§4 综合：一个驻留对一个（已确认在门内的）目标的检测评估
-- geo 为 core/geometry.geometry 结果（可已由 MeasurementModel 量化）；
-- 返回 {detected, snr, pd, reason}
function M.assess(rc, pe, geo, theta, Td, sigma, rng, fluctuation)
  if M.range_blind(pe, geo.R) then
    return { detected = false, snr = nil, pd = nil, reason = "range-blind" }
  end
  if M.velocity_blind(pe, rc.lambda_m, geo.v_close, geo.v_mlc) then
    return { detected = false, snr = nil, pd = nil, reason = "notch" }
  end
  local s = physics.snr(rc, { R = geo.R, sigma = sigma, theta = theta, Td = Td,
                              ptx_avg_w = physics.transmit_power(rc, pe) })
      * M.eclipsing_factor(pe, geo.R) * (geo.beam_factor or 1)
  local pd = physics.pd_swerling1(s, rc.pfa)
  local detected
  if fluctuation == nil then
    detected = rng() < pd
  else
    -- 指数 RCS 功率在相关窗内保持；每 CPI 的复高斯接收噪声独立。
    -- 圆对称噪声使固定信号相位不影响平方律检波统计。
    local radius = math.sqrt(-math.log(math.max(1e-15, rng())))
    local phase = 2 * PI * rng()
    local real = math.sqrt(s * fluctuation) + radius * math.cos(phase)
    local imag = radius * math.sin(phase)
    detected = real * real + imag * imag > -math.log(rc.pfa)
  end
  -- pd 是对目标起伏平均的单 CPI 概率，不能作为相关 CPI 的联合概率。
  return { detected = detected, snr = s, pd = pd, reason = "ok" }
end

return M

-- core/beam.lua —— 波束几何：扫描角、方向余弦门、双程主瓣因子、主瓣杂波径向速度
-- 纯函数；机体基由 core/geometry.lua 提供（本模块不构造姿态）。

local M = {}

local PI = math.pi

-- 扫描角（相对阵面法线 = 机头）
function M.theta_of(az, el)
  return math.acos(math.max(-1, math.min(1, math.cos(el) * math.cos(az))))
end

local function dot(a, b) return a.x * b.x + a.y * b.y + a.z * b.z end

-- basis = {f=前, r=右, up=上}（通用 ENU 向量）
-- 返回 theta、主瓣杂波径向速度 v_mlc、是否在检测门内 in_gate、双程主瓣因子 beam_factor
function M.evaluate(rc, own, rel, R, basis, dwell)
  local f, r, up = basis.f, basis.r, basis.up
  local ce, se = math.cos(dwell.el), math.sin(dwell.el)
  local ca, sa = math.cos(dwell.az), math.sin(dwell.az)
  local bd = {
    x = r.x * ce * sa + f.x * ce * ca + up.x * se,
    y = r.y * ce * sa + f.y * ce * ca + up.y * se,
    z = r.z * ce * sa + f.z * ce * ca + up.z * se,
  }
  local v_mlc = dot(own.vel, bd)
  local theta = M.theta_of(dwell.az, dwell.el)

  -- 平面阵的方向余弦域高斯主瓣：展宽由投影自动产生，两轴不统一乘 secθ。
  -- 这里按 HPBW/2 归一化，检测门为 ±hpbw/2；搜索俯仰条带间距必须
  -- <= hpbw_el_deg，否则相邻条带之间会出现盲带（config.validate 启动校验）。
  local rb, ub, fb = dot(rel, r), dot(rel, up), dot(rel, f)
  local invR = 1 / math.max(R, 1e-12)
  local du = (rb * invR - ce * sa) / math.sin(math.rad(rc.hpbw_az_deg) / 2)
  local dv = (ub * invR - se) / math.sin(math.rad(rc.hpbw_el_deg) / 2)
  local offset2 = du * du + dv * dv
  local in_gate = R > 0 and fb > 0 and offset2 <= 1 + 1e-9
  local beam_factor = math.exp(-2 * math.log(2) * offset2) -- 收发双程，HPBW 边缘为 1/4
  return {
    theta = theta,
    v_mlc = v_mlc,
    in_gate = in_gate,
    beam_factor = beam_factor,
  }
end

return M

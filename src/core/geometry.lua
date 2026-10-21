-- core/geometry.lua —— 通用 ENU 几何：机体基、相对测量、世界点、球面视距
-- 帧约定（D1）：x 东、y 北、z 上；航向从北顺时针，俯仰上仰为正，滚转右翼下沉为正。
-- 本模块不出现任何游戏轴向、海拔字段或航向偏移；游戏帧转换只在 adapters/dcs/frame.lua。

local M = {}

local function dot(a, b) return a.x * b.x + a.y * b.y + a.z * b.z end

-- 机体基：航向缺省时由水平速度反解（通用，不依赖任何游戏约定）。
function M.body_basis(own)
  local h = own.heading
  if h == nil then
    h = 0
    local vx, vy = own.vel and own.vel.x or 0, own.vel and own.vel.y or 0
    if vx ^ 2 + vy ^ 2 > 1e-12 then h = math.atan2(vx, vy) end
  end
  local cp, sp = math.cos(own.pitch or 0), math.sin(own.pitch or 0)
  local cr, sr = math.cos(own.roll or 0), math.sin(own.roll or 0)
  local sh, ch = math.sin(h), math.cos(h)
  return {
    f = { x = sh * cp, y = ch * cp, z = sp },
    r = { x = ch * cr + sh * sp * sr, y = -sh * cr + ch * sp * sr, z = -cp * sr },
    up = { x = ch * sr - sh * sp * cr, y = -sh * sr - ch * sp * cr, z = cp * cr },
  }
end

local function rel_state(own, tgt)
  local rel = {
    x = tgt.pos.x - own.pos.x,
    y = tgt.pos.y - own.pos.y,
    z = tgt.pos.z - own.pos.z,
  }
  local R = math.sqrt(rel.x * rel.x + rel.y * rel.y + rel.z * rel.z)
  local basis = M.body_basis(own)
  local fb, rb, ub = dot(rel, basis.f), dot(rel, basis.r), dot(rel, basis.up)
  local az_rel = math.atan2(rb, fb)
  local el_rel = math.atan2(ub, math.sqrt(fb * fb + rb * rb))
  local vrel = {
    x = own.vel.x - tgt.vel.x,
    y = own.vel.y - tgt.vel.y,
    z = own.vel.z - tgt.vel.z,
  }
  local v_close = dot(vrel, rel) / math.max(R, 1e-12)
  return rel, R, basis, fb, rb, ub, az_rel, el_rel, v_close
end

-- 目标相对机体的测量几何（不含波束门）
function M.body_view(own, tgt)
  local rel, R, basis, _, _, _, az_rel, el_rel, v_close = rel_state(own, tgt)
  return {
    R = R, az_rel = az_rel, el_rel = el_rel, v_close = v_close,
    rel = rel, basis = basis,
  }
end

-- §3/§0 几何：本体系波束 vs 目标
-- own/tgt: {pos={x,y,z}(m), vel={x,y,z}(m/s)}；dwell: {az=,el=}(rad，本体系，az 右正)
function M.geometry(rc, own, tgt, dwell)
  local rel, R, basis, fb, rb, ub, az_rel, el_rel, v_close = rel_state(own, tgt)
  local b = M.evaluate_beam(rc, own, rel, R, basis, dwell)
  return {
    R = R, az_rel = az_rel, el_rel = el_rel,
    v_close = v_close, v_mlc = b.v_mlc,
    theta = b.theta, in_gate = b.in_gate, beam_factor = b.beam_factor,
    fb = fb, rb = rb, ub = ub,
  }
end

-- 由 core/init.build 注入 beam 模块，避免几何层复制门限公式。
local beam_mod = nil

function M.bind(mods)
  beam_mod = mods.beam
  return M
end

function M.evaluate_beam(rc, own, rel, R, basis, dwell)
  return beam_mod.evaluate(rc, own, rel, R, basis, dwell)
end

-- §3/§0 机体测量 → 世界点（与 body_basis 同一套前/右/上基）
function M.world_point(own, az, el, R)
  local basis = M.body_basis(own)
  local f, right, up = basis.f, basis.r, basis.up
  local ce, se = math.cos(el), math.sin(el)
  local ca, sa = math.cos(az), math.sin(az)
  return {
    x = own.pos.x + R * (f.x * ce * ca + right.x * ce * sa + up.x * se),
    y = own.pos.y + R * (f.y * ce * ca + right.y * ce * sa + up.y * se),
    z = own.pos.z + R * (f.z * ce * ca + right.z * ce * sa + up.z * se),
  }
end

-- 有效地球球面视距：水平距离在 ENU x/y 平面，目标高度在 z。
function M.horizon_visible(rc, own, tgt)
  if rc.horizon_enabled == false then return true end
  local re = (rc.earth_radius_m or 6371000) * (rc.earth_k or 4 / 3)
  local base = rc.surface_alt_m or 0
  local function reach(z)
    local h = math.max(0, z - base)
    return math.sqrt(2 * re * h + h * h)
  end
  local dx, dy = tgt.pos.x - own.pos.x, tgt.pos.y - own.pos.y
  return math.sqrt(dx * dx + dy * dy) <= reach(own.pos.z) + reach(tgt.pos.z)
end

return M

-- adapters/dcs/frame.lua —— DCS 世界系 ↔ 核心 ENU 的唯一转换点（D1）
-- DCS：x 北、y 上、z 东；Heading 从北顺时针，Pitch 上仰为正，Bank 右机翼下沉为正。
-- 核心：x 东、y 北、z 上；航向从北顺时针，俯仰上仰为正，滚转右翼下沉为正。
-- 历史录制（V1 协议）的 O 行发送的是 Heading + π/2；legacy_* 只服务这类旧数据，
-- 新 Export 发送原始 DCS Heading（PROTO,2）。

local M = {}

function M.position(x, y, z)
  return { x = z, y = x, z = y }
end

function M.velocity(x, y, z)
  return { x = z, y = x, z = y }
end

function M.attitude(heading, pitch, bank)
  return { heading = heading, pitch = pitch, roll = bank }
end

-- V1 旧录制：O 行航向 = 原始 DCS Heading + π/2
local HALF_PI = math.pi / 2
function M.legacy_heading(heading)
  if heading == nil then return nil end
  return heading - HALF_PI
end

function M.ownship(raw, legacy)
  local heading = raw.heading
  if heading ~= nil then
    if legacy then heading = M.legacy_heading(heading) end
  else
    -- 无姿态帧（flight9 全部无 O 行）：按旧 V1 约定由 DCS 速度反解，
    -- 再转到 ENU。静止时沿用旧默认 h_legacy=0（机头 -Z），即 ENU -π/2。
    local h_legacy = 0
    local vx, vz = raw.vel.x, raw.vel.z
    if vx * vx + vz * vz > 1e-12 then h_legacy = math.atan2(vx, -vz) end
    heading = h_legacy - HALF_PI
  end
  return {
    label = raw.typeName or raw.label,
    pos = M.position(raw.pos.x, raw.pos.y, raw.pos.z),
    vel = M.velocity(raw.vel.x, raw.vel.y, raw.vel.z),
    heading = heading,
    pitch = raw.pitch,
    roll = raw.roll or raw.bank,
  }
end

function M.target(raw, legacy)
  local blocked = nil
  if raw.visible == true then blocked = false
  elseif raw.visible == false then blocked = true end
  return {
    id = raw.id,
    label = raw.typeName or raw.label,
    coalition = raw.coalition,
    pos = M.position(raw.pos.x, raw.pos.y, raw.pos.z),
    vel = M.velocity(raw.vel.x, raw.vel.y, raw.vel.z),
    blocked = blocked,
  }
end

return M

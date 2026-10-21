-- core/tracker.lua —— 航迹管理（ENU 世界系）：最近邻关联、M/N 起始、coast/删除
-- 理论依据：docs/theory-notes.md §6
-- 航迹档案在世界系：与真实雷达 track file 一致，本机机动不进入预测/关联；
-- az/el/R/vr 为显示视图字段（机体坐标），由 core.sync_tasks 用**当前**本机姿态每步刷新，
-- 本模块不感知本机状态。
-- 关联门为速度自适应：gate = base + (|vel|+margin)·漏检时长（封顶），
-- 并拒绝隐含相对速度超物理上限的候选。
-- 航迹遍历/关联/删除按稳定 id 顺序，pairs 顺序不影响结果；
-- 提供 sorted_ids 与 track_ids/ordered 视图供 core、sink 使用。
-- 航迹状态：pos/vel = {x,y,z}（ENU，m / m/s）。

local M = {}

M.__index = M

-- 稳定 id 排序：航迹表是 map，pairs 顺序依赖哈希布局。
-- 数值 id 按数值升序，字符串 id 按字典序；其他类型/NaN 直接报错（fail-closed），
-- 保证任意插入/删除历史下遍历顺序一致。
local TYPE_RANK = { number = 1, string = 2 }

local function id_rank(id) return TYPE_RANK[type(id)] or 3 end

function M.compare_ids(a, b)
  local ra, rb = id_rank(a), id_rank(b)
  if ra ~= rb then return ra < rb end
  if ra == 1 then return a < b end
  return tostring(a) < tostring(b)
end

function M.sorted_ids(tracks)
  local ids = {}
  for id in pairs(tracks) do
    local t = type(id)
    if (t ~= "number" and t ~= "string") or (t == "number" and id ~= id) then
      error("track id must be a finite number or string, got " .. t, 2)
    end
    ids[#ids + 1] = id
  end
  table.sort(ids, M.compare_ids)
  return ids
end

function M.new(tcfg)
  return setmetatable({ cfg = tcfg, tracks = {}, next_id = 1,
                        id_version = 0, ids_cache = nil,
                        ids_map = nil, ids_version = -1 }, M)
end

-- 稳定顺序的 id 列表：新增/删除航迹时版本 +1；同一版本内复用排序结果。
function M:track_ids()
  if self.ids_cache and self.ids_map == self.tracks and self.ids_version == self.id_version then
    return self.ids_cache
  end
  local ids = M.sorted_ids(self.tracks)
  self.ids_cache, self.ids_map, self.ids_version = ids, self.tracks, self.id_version
  return ids
end

function M:ordered()
  local ids = self:track_ids()
  local out = {}
  for i = 1, #ids do out[i] = self.tracks[ids[i]] end
  return out
end

-- dets: {{wx=, wy=, wz=}, ...}（一个驻留或一次 step 内的检测集合，ENU 世界坐标）
-- 返回更新后的 tracks 表（id -> 航迹）
function M.update(self, t, dets)
  local cfg = self.cfg
  local used = {}

  -- 1) 已有航迹：世界系匀速预测 + 最近邻关联（速度自适应三维距离门）
  -- 按稳定 id 顺序关联：同距离候选/多航迹争抢同一检测时结果与表插入顺序无关。
  local ids = self:track_ids()
  for _, id in ipairs(ids) do
    local tr = self.tracks[id]
    local dtu = t - tr.last_update
    local px = tr.pos.x + tr.vel.x * dtu
    local py = tr.pos.y + tr.vel.y * dtu
    local pz = tr.pos.z + tr.vel.z * dtu
    local speed = math.sqrt(tr.vel.x ^ 2 + tr.vel.y ^ 2 + tr.vel.z ^ 2)
    local gate = math.min(cfg.gate_max_m,
                          cfg.gate_base_m + (speed + cfg.gate_vel_margin_mps) * dtu)
    -- 相对加速度界：候选隐含速度 = dist/dtu 不得超过 max(已学速度,包线下限)+容差——
    -- 战斗机不可能瞬间改变相对速度；近距编队串档（隐含 ≈ 间隔/回访周期，数百 m/s）会被拒。
    -- 速度未知期（新航迹 vel=0）用包线下限，保证真实快速目标能完成 M/N 确认。
    local implied_max = (math.max(speed, cfg.vel_floor_mps) + cfg.gate_accel_margin_mps) * dtu

    local best, bdist = nil, gate
    for i, d in ipairs(dets) do
      if not used[i] then
        local dist = math.sqrt((d.wx - px) ^ 2 + (d.wy - py) ^ 2 + (d.wz - pz) ^ 2)
        -- 门内 且 隐含相对速度物理合理（防串档反馈环：被污染的速度放大门→再抓更远）
        if dist <= bdist and dist <= implied_max then
          best, bdist = i, dist
        end
      end
    end

    if best then
      used[best] = id
      local d = dets[best]
      local dt = t - tr.last_update
      if dt > 1e-6 then
        local s = cfg.vel_smooth
        local nvx = s * ((d.wx - tr.pos.x) / dt) + (1 - s) * tr.vel.x
        local nvy = s * ((d.wy - tr.pos.y) / dt) + (1 - s) * tr.vel.y
        local nvz = s * ((d.wz - tr.pos.z) / dt) + (1 - s) * tr.vel.z
        -- 速度变化率限幅（≈12g）：串档/换成员的隐含速度一拍可跳 100+ m/s，
        -- 经 vel_smooth 污染已确认航迹的档案。未确认阶段不限（初始化收敛
        -- 不是目标真加速度，两拍差分起步）
        local dvx, dvy, dvz = nvx - tr.vel.x, nvy - tr.vel.y, nvz - tr.vel.z
        local dv = math.sqrt(dvx * dvx + dvy * dvy + dvz * dvz)
        local dv_max = cfg.vel_accel_max_mps2 * dt
        if tr.confirmed and dv > dv_max and dv > 1e-9 then
          local k = dv_max / dv
          nvx, nvy, nvz = tr.vel.x + dvx * k, tr.vel.y + dvy * k, tr.vel.z + dvz * k
        end
        tr.vel.x, tr.vel.y, tr.vel.z = nvx, nvy, nvz
      end
      tr.pos = { x = d.wx, y = d.wy, z = d.wz }
      tr.last_update = t
      tr.hits = tr.hits + 1
      tr.misses = 0
      -- 慢速动目标抑制【设定】：A/A 模式不确认地面交通（坦克/车队 ~10-20m/s）。
      -- 已知边界：悬停直升机（≈0m/s）也会被抑制（真雷达用地形/高度信息，此处用速度替代）。
      local sp2 = math.sqrt(tr.vel.x ^ 2 + tr.vel.y ^ 2 + tr.vel.z ^ 2)
      if not tr.confirmed and tr.hits >= cfg.confirm_m
          and (t - tr.first_t) <= cfg.confirm_window_s
          and sp2 >= cfg.slow_mover_mps then
        tr.confirmed = true
      end
    else
      tr.misses = tr.misses + 1
    end
  end

  -- 2) 删除：coast 超时；未确认超窗；确认后速度收敛仍低于慢速阈值的按地面动目标清除
  --    （确认时刻的速度门挡不住"先快后收敛"的路径——速度学习期瞬时值可短暂超阈）
  local changed = false
  for _, id in ipairs(ids) do
    local tr = self.tracks[id]
    if (t - tr.last_update) > cfg.coast_s then
      self.tracks[id] = nil
      changed = true
    elseif not tr.confirmed and (t - tr.first_t) > cfg.confirm_window_s then
      self.tracks[id] = nil
      changed = true
    elseif tr.confirmed and (t - tr.first_t) > cfg.confirm_window_s
        and (tr.vel.x ^ 2 + tr.vel.y ^ 2 + tr.vel.z ^ 2) < cfg.slow_mover_mps ^ 2 then
      self.tracks[id] = nil
      changed = true
    end
  end
  if changed then self.id_version = self.id_version + 1 end

  -- 3) 新检测起始暂定航迹（世界系，速度未知从零学起）
  local added = false
  for i, d in ipairs(dets) do
    if not used[i] then
      self.tracks[self.next_id] = {
        id = self.next_id,
        pos = { x = d.wx, y = d.wy, z = d.wz },
        vel = { x = 0, y = 0, z = 0 },
        hits = 1, misses = 0,
        first_t = t, last_update = t,
        confirmed = false,
      }
      self.next_id = self.next_id + 1
      added = true
    end
  end
  if added then self.id_version = self.id_version + 1 end

  return self.tracks
end

return M

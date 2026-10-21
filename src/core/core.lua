-- core/core.lua —— 组装：step(dt) 驱动调度器 → 驻留物理判定 → 航迹 → 输出
-- 依赖注入：mods = {constants, physics, beam, detection, geometry, scheduler, tracker, snapshot, measurement}
-- truth/rcs/sink 为适配器（契约见 docs/architecture.md §5）。
-- 本模块只使用通用 ENU 帧；任何游戏坐标/机型/可见性语义都在适配器内完成。

local M = {}

-- 视图反解用的零位波束（az/el 相对机头；in_gate/theta 不使用）
local VIEW_DWELL = { az = 0, el = 0 }

M.__index = M

function M.new(mods, cfg, truth, rcs, sink, seed, opts)
  opts = opts or {}
  local core = setmetatable({
    mods = mods, cfg = cfg, truth = truth, rcs = rcs, sink = sink,
    t = 0,
    rng = mods.constants.make_rng(seed or 42),
    sched = mods.scheduler.new(cfg.scheduler, cfg.radar, mods),
    trk = mods.tracker.new(cfg.tracker),
    measurement = opts.measurement or mods.measurement.exact(),
    own_coalition = opts.own_coalition or 2,
    iff_radius_m = opts.iff_radius_m or 500,
    stt_id = nil,
    fluctuations = {},
    target_raw_ids = nil,
    target_perm = nil,
    last_beam = nil,
    beam_ring_cap = opts.beam_ring_cap or 150,
    beam_trail = {},
    budget = { search = 0, track = 0, stt = 0 },
  }, M)
  return core
end

function M.set_stt(self, id) self.stt_id = id end

function M.fluctuation_factor(self, id, now)
  local hold = self.cfg.radar.fluctuation_hold_s or 0
  if hold <= 0 then return nil end
  local epoch = math.floor(now / hold)
  local record = self.fluctuations[id]
  if not record or record.epoch ~= epoch then
    record = { epoch = epoch, factor = -math.log(math.max(1e-15, self.rng())) }
    self.fluctuations[id] = record
  end
  return record.factor
end

-- 返回 targets 列表按稳定 id 排序的索引置换。真值适配器每个驻留返回新表，
-- 但同一录制/实时帧内目标 id 顺序在多个驻留间不变；缓存置换，避免每驻留重排。
function M.target_permutation(self, targets)
  local n = #targets
  local cached_ids, perm = self.target_raw_ids, self.target_perm
  local same = cached_ids ~= nil and #cached_ids == n
  if same then
    for i = 1, n do
      if cached_ids[i] ~= targets[i].id then same = false break end
    end
  end
  if same then return perm end

  local ids = {}
  for i = 1, n do
    local id = targets[i].id
    local t = type(id)
    if (t ~= "number" and t ~= "string") or (t == "number" and id ~= id) then
      error("target id must be a finite number or string, got " .. t, 2)
    end
    ids[i] = id
  end
  perm = {}
  for i = 1, n do perm[i] = i end
  local compare = self.mods.tracker.compare_ids
  table.sort(perm, function(a, b) return compare(ids[a], ids[b]) end)
  self.target_raw_ids, self.target_perm = ids, perm
  return perm
end

-- IFF（显示层）：航迹世界位置附近最近的真值目标阵营。
-- 同阵营=friend、异阵营=hostile、无匹配=unknown；核心不模拟 NCTR/应答失败。
function M.iff_for(self, east, north)
  local targets = self.truth:targets(self.t)
  if type(targets) ~= "table" then return "unknown" end
  local best, best_d2 = nil, self.iff_radius_m * self.iff_radius_m
  for i = 1, #targets do
    local tg = targets[i]
    local de, dn = tg.pos.x - east, tg.pos.y - north
    local d2 = de * de + dn * dn
    if d2 <= best_d2 then best, best_d2 = tg, d2 end
  end
  if not best then return "unknown" end
  if best.coalition == self.own_coalition then return "friend" end
  if best.coalition == 1 or best.coalition == 2 then return "hostile" end
  return "unknown"
end

function M.snapshot(self)
  return self.mods.snapshot.build(self)
end

function M.push_beam(self, entry)
  local ring = self.beam_trail
  ring[#ring + 1] = entry
  if #ring > self.beam_ring_cap then table.remove(ring, 1) end
end

function M.step(self, dt)
  local horizon = self.t + dt
  self.sched:step(dt, function(dwell)
    self.t = dwell.t_end
    self:run_dwell(dwell)
    self:sync_tasks()
  end)
  self.t = horizon
  self:sync_tasks()
  -- 第一个参数保持 id->track 映射（兼容旧 sink）；第二个参数是稳定 id 顺序的数组视图。
  self.sink:on_tracks(self.trk.tracks, self.trk:ordered())
end

-- 一个驻留：几何 → 门限/盲区/notch → SNR/Pd → 伯努利判定 → 检测列表 → 航迹更新
-- 输出按 beam / truth / measurement / detection 四段拆分，sink 不依赖内部实现。
function M.run_dwell(self, dwell)
  local geo_mod = self.mods.geometry
  local ph = self.mods.physics
  local det = self.mods.detection
  local rc = self.cfg.radar
  local pe = rc.prf[dwell.prf_idx]
  local mid = 0.5 * (dwell.t_start + dwell.t_end)
  local own = self.truth:ownship(mid)

  local dets = {}
  local truth_rows = {}
  local meas_rows = {}
  local det_rows = {}
  -- 目标按稳定 id 顺序处理：随机数消费顺序与审计输出不得依赖适配器的表/列表顺序。
  local targets = self.truth:targets(mid)
  local perm = self:target_permutation(targets)
  for k = 1, #targets do
    local tgt = targets[perm[k]]
    local geo = geo_mod.geometry(rc, own, tgt, dwell)
    local meas = self.measurement:apply(geo)
    local rec = { id = tgt.id, detected = false, reason = "gate" }
    local blocked = tgt.blocked
    rec.blocked = blocked

    local rr = {
      id = tgt.id, label = tgt.label, coalition = tgt.coalition,
      pos = tgt.pos, vel = tgt.vel, blocked = blocked,
    }
    local mm = {
      id = tgt.id, range_m = meas.R, az_rel = meas.az_rel, el_rel = meas.el_rel,
      v_close = meas.v_close, v_mlc = meas.v_mlc,
    }

    if geo.in_gate and not geo_mod.horizon_visible(rc, own, tgt) then
      rec.reason = "horizon"
    elseif geo.in_gate and blocked == true then
      rec.reason = "terrain"
    elseif geo.in_gate and (geo.R < (rc.min_range_m or 0) or (rc.max_range_m and geo.R > rc.max_range_m)) then
      rec.reason = "range-limit"
    elseif geo.in_gate then
      local sigma = self.rcs:get(tgt).rcs_m2
      local res = det.assess(rc, pe, meas, meas.theta or geo.theta, dwell.Td, sigma, self.rng,
                             self:fluctuation_factor(tgt.id, mid))
      rec.detected = res.detected
      rec.reason = res.reason
      rec.snr, rec.pd = res.snr, res.pd
      if res.detected then
        -- 世界系检测点（跟踪档案输入；本机机动与航迹预测解耦）
        local wp = geo_mod.world_point(own, meas.az_rel, meas.el_rel, meas.R)
        dets[#dets + 1] = { wx = wp.x, wy = wp.y, wz = wp.z }
      end
    end

    truth_rows[#truth_rows + 1] = rr
    meas_rows[#meas_rows + 1] = mm
    det_rows[#det_rows + 1] = rec
  end

  self.trk:update(mid, dets)

  local beam = {
    t = dwell.t_start, az = dwell.az, el = dwell.el, theta = dwell.theta,
    td = dwell.Td, prf = pe.name, purpose = dwell.purpose,
    task_id = dwell.task_id, bar = dwell.bar,
  }
  self.last_beam = {
    t = beam.t, az = beam.az, el = beam.el, purpose = beam.purpose,
    prf = beam.prf, td = beam.td, detections = #dets,
  }
  self:push_beam({ t = beam.t, az = beam.az, el = beam.el, purpose = beam.purpose })
  self.budget[dwell.purpose] = (self.budget[dwell.purpose] or 0) + dwell.Td

  self.sink:on_dwell({
    beam = beam,
    truth = { targets = truth_rows },
    measurement = { model = self.measurement.kind, targets = meas_rows },
    detection = { n = #dets, targets = det_rows },
  })
end

-- 航迹视图刷新 + 确认航迹 -> 调度任务（STT 优先档）；消失航迹 -> 移除任务
-- az/el/R/vr 是机体坐标显示字段：每步用**当前**本机姿态从世界档案反解，
-- 本机转向时视图随机体平稳变化，档案本身（世界系）不受影响。
function M.sync_tasks(self)
  local rc = self.cfg.radar
  local geo_mod = self.mods.geometry
  local rv = self.cfg.scheduler.revisit
  local own = self.truth:ownship(self.t)
  local seen = {}
  -- 稳定 id 顺序：确认航迹 -> 调度任务的插入、视图刷新与移除都不依赖 pairs 顺序。
  for _, id in ipairs(self.trk:track_ids()) do
    local tr = self.trk.tracks[id]
    seen[id] = true
    local age = math.max(0, self.t - (tr.last_update or self.t))
    local predicted = { x = tr.pos.x + tr.vel.x * age, y = tr.pos.y + tr.vel.y * age,
                        z = tr.pos.z + tr.vel.z * age }
    local geo = geo_mod.geometry(rc, own, { pos = predicted, vel = tr.vel }, VIEW_DWELL)
    tr.az, tr.el, tr.R, tr.vr = geo.az_rel, geo.el_rel, geo.R, geo.v_close
    if tr.confirmed then
      local kind = id == self.stt_id and "stt" or "track"
      local prf = self.sched.prf_indices
      local hz = kind == "stt" and rv.stt_hz
          or (tr.R <= rv.near_range_m and rv.track_near_hz or rv.track_far_hz)
      local indices = kind == "stt" and prf.stt
          or (tr.R <= rv.near_prf_R_m and prf.track_near or prf.track_far)
      self.sched:update_track(id, kind, hz, indices)
      self.sched:set_geo(id, tr.az, tr.el)
    end
  end
  for _, id in ipairs(self.mods.tracker.sorted_ids(self.sched.tracks)) do
    if not seen[id] then self.sched:remove_track(id) end
  end
end

return M

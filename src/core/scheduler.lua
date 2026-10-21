-- core/scheduler.lua —— 确定性事件调度：完成驻留后输出；回访按截止时间，PRF 按实际驻留轮换。
-- 扫描角公式由 core/beam.lua 注入，本模块不复制几何定义。

local M = {}
M.__index = M
local EPS = 1e-12

local SELECTION_KEYS = { "search", "track_far", "track_near", "stt" }

-- PRF 选择在配置里按名字书写；这里建立 name→index 映射并解析成索引数组，
-- 调度器之后只使用索引（与雷达波形表的顺序解耦）。
function M.resolve_prf_selection(scfg, rcfg)
  local selection = scfg and scfg.prf_selection
  if type(selection) ~= "table" then
    error("scheduler.prf_selection missing", 3)
  end
  if type(rcfg) ~= "table" or type(rcfg.prf) ~= "table" then
    error("scheduler.new: radar.prf missing", 3)
  end

  local by_name = {}
  for i = 1, #rcfg.prf do
    local p = rcfg.prf[i]
    if type(p) ~= "table" or type(p.name) ~= "string" then
      error(string.format("scheduler.new: radar.prf[%d].name missing", i), 3)
    end
    if by_name[p.name] then
      error("scheduler.new: duplicate PRF name " .. p.name, 3)
    end
    by_name[p.name] = i
  end

  local out = {}
  for _, key in ipairs(SELECTION_KEYS) do
    local names = selection[key]
    if type(names) ~= "table" or #names < 1 then
      error("scheduler.prf_selection." .. key .. " must be a non-empty sequence", 3)
    end
    local indices = {}
    for i = 1, #names do
      local idx = by_name[names[i]]
      if not idx then
        error(string.format("scheduler.prf_selection.%s[%d] unknown PRF %q",
          key, i, tostring(names[i])), 3)
      end
      indices[i] = idx
    end
    out[key] = indices
  end
  return out
end

function M.build_raster(scfg)
  local s, ras = scfg.search, {}
  local n = math.floor(2 * s.az_span_deg / s.az_step_deg + 0.5) + 1
  for ei = 1, #s.el_bars_deg do
    for ai = 0, n - 1 do
      ras[#ras + 1] = { az = math.rad(-s.az_span_deg + ai * s.az_step_deg),
                        el = math.rad(s.el_bars_deg[ei]) }
    end
  end
  return ras
end

-- mods.beam.theta_of 必须存在；调度器不自行推导扫描角。
function M.new(scfg, rc, mods)
  local theta_of = mods and mods.beam and mods.beam.theta_of
  if type(theta_of) ~= "function" then
    error("scheduler.new: mods.beam.theta_of required", 3)
  end
  local prf_indices = M.resolve_prf_selection(scfg, rc)
  return setmetatable({ scfg = scfg, rc = rc, prf_indices = prf_indices,
    theta_of = theta_of,
    default_prf_idx = prf_indices.track_far[1],
    t = 0, busy_until = 0, pending = nil,
    tracks = {}, search = { idx = 1, prf_slot = 1, raster = M.build_raster(scfg), frame_start = nil },
    ledger = { dwell_s = 0, steer_s = 0, idle_s = 0, count = 0 },
    stats = { search_frame_time = nil, stt_late_max = 0, track_late_max = 0 } }, M)
end

function M.add_track(self, id, kind, hz, prf_idx)
  self.tracks[id] = { kind = kind, hz = hz, prf_idx = prf_idx or self.default_prf_idx,
                     next_due = self.t, az = 0, el = 0, prf_slot = 1 }
end

local function same_list(a, b)
  if not a or #a ~= #b then return false end
  for i = 1, #a do if a[i] ~= b[i] then return false end end
  return true
end

function M.update_track(self, id, kind, hz, indices)
  local tr = self.tracks[id]
  if not tr then self:add_track(id, kind, hz, indices[1]) tr = self.tracks[id] end
  if tr.kind ~= kind or tr.hz ~= hz then
    tr.next_due = math.max(self.t, (tr.last_start or self.t - 1 / hz) + 1 / hz)
    if kind == "stt" and tr.kind ~= "stt" then tr.next_due = self.t end
  end
  tr.kind, tr.hz = kind, hz
  if not same_list(tr.prf_indices, indices) then tr.prf_indices, tr.prf_slot = indices, 1 end
end

function M.remove_track(self, id) self.tracks[id] = nil end
function M.set_geo(self, id, az, el)
  local tr = self.tracks[id]
  if tr then tr.az, tr.el = az, el end
end

function M.dwell_Td(self, kind, theta)
  local rc = self.rc
  local base = rc.dwell_search_s
  if kind == "track" then base = rc.dwell_track_s
  elseif kind == "stt" then base = rc.dwell_stt_s end
  if rc.dwell_compensation then base = base / math.cos(theta) ^ (2 * (rc.scan_k or 1)) end
  return base
end

local function feasible(self, az, el)
  return self.theta_of(az, el) <= math.rad(self.rc.scan_cone_deg) + EPS
end

local function next_task(self)
  local best, best_id
  for id, tr in pairs(self.tracks) do
    if tr.hz > 0 and self.t >= tr.next_due - EPS and feasible(self, tr.az, tr.el) then
      local priority = tr.kind == "stt" and 1 or 0
      local bp = best and (best.kind == "stt" and 1 or 0) or -1
      if not best or priority > bp or (priority == bp and
          (tr.next_due < best.next_due or (tr.next_due == best.next_due and tostring(id) < tostring(best_id)))) then
        best, best_id = tr, id
      end
    end
  end
  return best, best_id
end

function M.pop_dwell(self)
  local tr, id = next_task(self)
  if tr then
    local theta = self.theta_of(tr.az, tr.el)
    local indices = tr.prf_indices or { tr.prf_idx }
    local d = { purpose = tr.kind, task_id = id, az = tr.az, el = tr.el, theta = theta,
                Td = self:dwell_Td(tr.kind, theta), prf_idx = indices[tr.prf_slot], due = tr.next_due }
    tr.prf_slot = tr.prf_slot % #indices + 1
    -- 过载时跳过错过的周期；仍保留真实迟到统计。
    local missed = math.floor(math.max(0, self.t - tr.next_due) * tr.hz + EPS)
    tr.next_due = tr.next_due + (missed + 1) / tr.hz
    tr.last_start = self.t
    return d
  end
  local ras = self.search.raster
  for _ = 1, #ras do
    local pos = ras[self.search.idx]
    if feasible(self, pos.az, pos.el) then
      if self.search.idx == 1 and self.search.prf_slot == 1 then
        if self.search.frame_start then self.stats.search_frame_time = self.t - self.search.frame_start end
        self.search.frame_start = self.t
      end
      local indices = self.prf_indices.search
      local theta = self.theta_of(pos.az, pos.el)
      local d = { purpose = "search", az = pos.az, el = pos.el, theta = theta,
                  Td = self:dwell_Td("search", theta), prf_idx = indices[self.search.prf_slot], bar = self.search.idx }
      self.search.prf_slot = self.search.prf_slot % #indices + 1
      if self.search.prf_slot == 1 then self.search.idx = self.search.idx % #ras + 1 end
      return d
    end
    self.search.idx, self.search.prf_slot = self.search.idx % #ras + 1, 1
  end
  return nil
end

function M.step(self, dt, emit)
  assert(dt >= 0, "dt must be nonnegative")
  local horizon = self.t + dt
  while true do
    if self.pending then
      if self.pending.t_end > horizon + EPS then break end
      self.t = self.pending.t_end
      local done = self.pending
      self.pending = nil
      emit(done)
    end
    if self.busy_until > horizon + EPS then break end
    self.t = self.busy_until
    local d = self:pop_dwell()
    if not d then
      local wake = horizon
      for _, tr in pairs(self.tracks) do
        if tr.hz > 0 and feasible(self, tr.az, tr.el) and tr.next_due > self.t + EPS then
          wake = math.min(wake, tr.next_due)
        end
      end
      self.ledger.idle_s = self.ledger.idle_s + wake - self.t
      self.busy_until = wake
      if wake >= horizon - EPS then break end
    else
      d.t_start, d.t_end = self.t, self.t + d.Td
      self.busy_until = d.t_end + self.rc.steer_overhead_s
      self.pending = d
      self.ledger.dwell_s = self.ledger.dwell_s + d.Td
      self.ledger.steer_s = self.ledger.steer_s + self.rc.steer_overhead_s
      self.ledger.count = self.ledger.count + 1
      if d.due then
        local late = math.max(0, d.t_start - d.due)
        local key = d.purpose == "stt" and "stt_late_max" or "track_late_max"
        self.stats[key] = math.max(self.stats[key], late)
      end
    end
  end
  self.t = horizon
end
return M

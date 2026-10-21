-- core/snapshot.lua —— 稳定显示 DTO：显示层只消费本模块的输出，不读 sched/trk 内部表。
-- 单位：距离 m（另给 km），角度 deg，速度 m/s；世界坐标固定 ENU（east/north/up）。

local M = {}

local function deg(rad) return rad * 180 / math.pi end

local function id_key(id)
  local t = type(id)
  if t == "number" then return "n:" .. string.format("%020.6f", id) end
  return "s:" .. tostring(id)
end

local function track_view(core, id)
  local tr = core.trk.tracks[id]
  local age = math.max(0, core.t - (tr.last_update or core.t))
  local east = tr.pos.x + tr.vel.x * age
  local north = tr.pos.y + tr.vel.y * age
  local up = tr.pos.z + tr.vel.z * age
  local speed = math.sqrt(tr.vel.x ^ 2 + tr.vel.y ^ 2 + tr.vel.z ^ 2)
  return {
    id = id,
    confirmed = tr.confirmed and true or false,
    iff = core:iff_for(east, north),
    az_deg = deg(tr.az or 0), el_deg = deg(tr.el or 0),
    range_m = tr.R, range_km = tr.R and tr.R / 1000 or nil,
    vr_mps = tr.vr,
    east_m = east, north_m = north, up_m = up,
    ve_mps = tr.vel.x, vn_mps = tr.vel.y, vu_mps = tr.vel.z,
    speed_ms = speed,
    hits = tr.hits, misses = tr.misses,
  }
end

local function truth_views(core)
  local own = core.truth:ownship(core.t)
  local list = core.truth:targets(core.t)
  if type(list) ~= "table" then return {} end
  local out = {}
  for i = 1, #list do
    local tg = list[i]
    local view = {
      id = tg.id, label = tg.label,
      coalition = tg.coalition, blocked = tg.blocked,
      east_m = tg.pos.x, north_m = tg.pos.y, up_m = tg.pos.z,
    }
    if own then
      local g = core.mods.geometry.body_view(own, tg)
      view.az_deg = deg(g.az_rel)
      view.el_deg = deg(g.el_rel)
      view.range_m = g.R
      view.range_km = g.R / 1000
    end
    out[#out + 1] = view
  end
  return out
end

local function budget_pct(core)
  local b = core.budget
  local total = b.search + b.track + b.stt
  if total <= 0 then return nil, nil, nil end
  return 100 * b.search / total, 100 * b.track / total, 100 * b.stt / total
end

function M.build(core)
  local own_raw = core.truth:ownship(core.t)
  local own = { type = nil, alt_m = nil, speed_ms = nil, heading_deg = nil,
                pitch_deg = nil, roll_deg = nil, pos = nil }
  if own_raw then
    local speed = math.sqrt(own_raw.vel.x ^ 2 + own_raw.vel.y ^ 2 + own_raw.vel.z ^ 2)
    own = {
      type = own_raw.label,
      alt_m = own_raw.pos.z,
      speed_ms = speed,
      heading_deg = own_raw.heading and deg(own_raw.heading) or nil,
      pitch_deg = own_raw.pitch and deg(own_raw.pitch) or nil,
      roll_deg = own_raw.roll and deg(own_raw.roll) or nil,
      pos = { own_raw.pos.x, own_raw.pos.y, own_raw.pos.z },
    }
  end

  local tracks = {}
  for _, id in ipairs(core.trk:track_ids()) do
    tracks[#tracks + 1] = track_view(core, id)
  end
  table.sort(tracks, function(a, b)
    if a.confirmed ~= b.confirmed then return a.confirmed end
    local ar, br = a.range_km or 0, b.range_km or 0
    if ar ~= br then return ar < br end
    return id_key(a.id) < id_key(b.id)
  end)

  local beam = nil
  if core.last_beam then
    local b = core.last_beam
    beam = { az_deg = deg(b.az), el_deg = deg(b.el), purpose = b.purpose,
             prf = b.prf, td_ms = b.td * 1000, detections = b.detections, t = b.t }
  end
  local trail = {}
  for i = 1, #core.beam_trail do
    local e = core.beam_trail[i]
    trail[i] = { az_deg = deg(e.az), el_deg = deg(e.el), purpose = e.purpose, t = e.t }
  end

  local sched = core.sched
  local led = sched.ledger
  local consumed = led.dwell_s + led.steer_s - math.max(0, sched.busy_until - core.t)
  local duty = core.t > 0 and (math.max(0, consumed) / math.max(core.t, 1e-9)) or 0
  if duty < 0 then duty = 0 elseif duty > 1 then duty = 1 end
  local search_pct, track_pct, stt_pct = budget_pct(core)
  local cfg = core.cfg
  local sc = cfg.scheduler.search
  local bars = {}
  for i = 1, #sc.el_bars_deg do bars[i] = sc.el_bars_deg[i] end

  return {
    t = core.t,
    cfg = { el_bars_deg = bars, az_span_deg = sc.az_span_deg,
            scan_cone_deg = cfg.radar.scan_cone_deg },
    own = own,
    tracks = tracks,
    beam = beam,
    beam_trail = trail,
    raster = { idx = sched.search.idx, count = #sched.search.raster,
               frame_time_s = sched.stats.search_frame_time },
    sched = {
      dwells = led.count,
      duty = duty,
      search_pct = search_pct, track_pct = track_pct, stt_pct = stt_pct,
      search_frame_s = sched.stats.search_frame_time,
      stt_late_max_ms = sched.stats.stt_late_max * 1000,
      track_late_max_ms = sched.stats.track_late_max * 1000,
    },
    truth = truth_views(core),
  }
end

return M

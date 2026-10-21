-- adapters/dcs/truth_replay.lua —— 回放型 TruthSource：DCS 录制帧 → 核心 ENU 真值
-- 帧格式（tools/ingest.py 解析产物，原始 DCS 轴）：
--   { t=, own={typeName,pos={x,y,z},vel={x,y,z},heading,pitch,roll},
--     targets={{id,typeName,coalition,pos,vel,visible}} }
-- 规则：位置/速度线性插值；目标按 id 对齐；只在单帧出现的目标保持该帧值（不外推）；
--       查询越界（早于首帧/晚于末帧）clamp 到边界帧。
-- 坐标与航向转换只在 frame.lua；旧 V1 录制用 opts.legacy_heading=true。
-- opts.rcs（可选）：{ resolve(typeName) -> {rcs_m2, source, rcs_class} }，
-- 用于把 DCS 机型解析成核心的 rcs_m2/rcs_class；核心不识别机型名。

local frame = rawget(_G, "AESA_FRAME")

local M = {}

local function lerp(a, b, u) return a + (b - a) * u end
local function angle(a, b, u)
  if a == nil then return nil end
  if b == nil then return a end
  return a + ((b - a + math.pi) % (2 * math.pi) - math.pi) * u
end

local function interp3(a, b, u)
  if not b then return { x = a.x, y = a.y, z = a.z } end
  return { x = lerp(a.x, b.x, u), y = lerp(a.y, b.y, u), z = lerp(a.z, b.z, u) }
end

-- 定位 t 所在帧区间，返回 ia, ib, u（越界时 ia==ib）
local function locate(frames, t)
  local n = #frames
  if n == 0 then return nil, nil, 0 end
  if t <= frames[1].t then return 1, 1, 0 end
  if t >= frames[n].t then return n, n, 0 end
  for i = 1, n - 1 do
    if t >= frames[i].t and t < frames[i + 1].t then
      local span = frames[i + 1].t - frames[i].t
      local u = span > 1e-9 and (t - frames[i].t) / span or 0
      return i, i + 1, u
    end
  end
  return n, n, 0
end

local function blocked_of(visible)
  if visible == true then return false end
  if visible == false then return true end
  return nil
end

function M.new(frames, opts)
  opts = opts or {}
  if frame == nil then frame = opts.frame end
  if frame == nil then
    local src = debug.getinfo(1, "S").source
    local dir = src and src:match("^@(.*[/\\])")
    if not dir then
      error("truth_replay.new: frame module required (opts.frame or AESA_FRAME)", 2)
    end
    frame = dofile(dir .. "frame.lua")
  end
  local legacy = opts.legacy_heading and true or false
  local resolver = opts.rcs

  -- 每帧目标按 id 建索引，供区间对齐
  local indexed = {}
  for i = 1, #frames do
    local byid = {}
    for _, tg in ipairs(frames[i].targets or {}) do byid[tostring(tg.id)] = tg end
    indexed[i] = byid
  end

  local o = { frames = frames, indexed = indexed, opts = opts }
  local rcs_cache = {}

  local function rcs_of(tg)
    if not resolver then return nil, nil end
    local name = tg.typeName or tg.label
    local key = tostring(name)
    local hit = rcs_cache[key]
    if hit == nil then
      hit = resolver:resolve(name)
      rcs_cache[key] = hit
    end
    return hit.rcs_m2, hit.rcs_class
  end

  -- 增量追加一帧（实时显示器用；frames 表为共享引用，locate 按 #frames 生效）
  function o:append(f)
    local n = #self.frames + 1
    self.frames[n] = f
    local byid = {}
    for _, tg in ipairs(f.targets or {}) do byid[tostring(tg.id)] = tg end
    self.indexed[n] = byid
  end

  function o:ownship(now)
    local ia, ib, u = locate(frames, now)
    if not ia then return nil end
    local a, b = frames[ia], frames[ib]
    local raw = {
      typeName = a.own.typeName,
      pos = interp3(a.own.pos, b.own.pos, u),
      vel = interp3(a.own.vel, b.own.vel, u),
      heading = angle(a.own.heading, b.own.heading, u),
      pitch = angle(a.own.pitch, b.own.pitch, u),
      roll = angle(a.own.roll, b.own.roll, u),
    }
    return frame.ownship(raw, legacy)
  end

  function o:targets(now)
    local ia, ib, u = locate(frames, now)
    if not ia then return {} end
    local a, b = frames[ia], frames[ib]
    local byid = indexed[ib]
    local out = {}
    for _, tg in ipairs(a.targets or {}) do
      local nb = (ia ~= ib) and byid[tostring(tg.id)] or nil
      local visible = tg.visible
      -- 遮蔽状态不做数值插值；跨状态区间保守地保留遮挡。
      if nb then
        if tg.visible == false or nb.visible == false then visible = false
        elseif tg.visible == nil or nb.visible == nil then visible = nil end
      end
      local raw = {
        id = tg.id, typeName = tg.typeName, coalition = tg.coalition,
        pos = interp3(tg.pos, nb and nb.pos or nil, u),
        vel = interp3(tg.vel, nb and nb.vel or nil, u),
        visible = visible,
      }
      local row = frame.target(raw, legacy)
      row.rcs_m2, row.rcs_class = rcs_of(tg)
      out[#out + 1] = row
    end
    return out
  end

  return o
end

return M

-- aesa_export.lua —— A/A Export 侧真值采样（薄、稳、可注入测试）
-- 部署：dist/dev/aesa_export.lua（由 scripts/build_runtime.cjs 生成），
-- 由 Saved Games\Scripts\Export.lua 的 AESA 标记块 dofile。
-- 设计：docs/design-phase2.md；协议 V1；时间基准 = 模型时间（仿真时间）。
-- Gate 1：A/T 行尾追加 vel_valid（0/1）；T 行阵营缺失/非法为 unknown。
-- Gate 3：游戏 API 全部经 AESA_RUNTIME.export；连接后发送 COMPAT 握手。
-- Gate 4：PROTO,2 声明坐标/姿态为原始 DCS 值（x 北、y 上、z 东；Heading 从北顺时针）；
--         接收端只在 src/adapters/dcs/frame.lua 转 ENU。旧 V1 录制无 PROTO 行，
--         其 O 行航向为 Heading + π/2（历史约定）。
-- 环境约定：外部访问 pcall 防护；socket 不可用/接收端不在时降级并写诊断。

local runtime = assert(AESA_RUNTIME, "AESA runtime missing")
local api = runtime.export.new(_G)
local profile = runtime.profile.new(runtime.profile_data, "generated")

local AESA = {
  PORT      = 3590,
  HOST      = "127.0.0.1",
  RATE_HZ   = 10,        -- 采样频率
  RETRY_S   = 2.0,       -- 掉线重连间隔
  next_sample = 0,
  last_try   = -1e9,
  sock       = nil,
  probed     = false,
  err_count  = 0,
}

-- 诊断日志（路径经适配层取得；全部 pcall，失败时退回引擎日志）
local function diag(msg)
  pcall(function()
    if not AESA.diagf then
      local dir = api:writedir()
      if type(dir) == "string" and dir ~= "" then
        AESA.diagf = io.open(dir .. [[Scripts\AESA\export_diag.log]], "a")
      end
    end
    if AESA.diagf then
      local wall = ""
      pcall(function() wall = os.date("%H:%M:%S ") end)
      AESA.diagf:write(string.format("%s %8.2f %s\n", wall, AESA.last_t or -1, msg))
      AESA.diagf:flush()
    end
  end)
  if not AESA.diagf then
    pcall(function() api:log_write("AESA", msg) end)
  end
end
AESA.diag = diag

local function sanitize(s)
  s = tostring(s or "?")
  return (s:gsub("%s+", "_"))
end

local function fmt(v)
  if type(v) ~= "number" then v = 0 end
  return string.format("%.3f", v)
end

-- 防御式取三维点：接受 {x,y,z} 或含方向矩阵的 {x=..,y=..,z=..,p={x,y,z}}
local function vec3(t)
  if type(t) ~= "table" then return nil end
  if type(t.p) == "table" then t = t.p end
  local function finite(v) return type(v) == "number" and v == v and math.abs(v) < math.huge end
  if finite(t.x) and finite(t.y) and finite(t.z) then return t end
  return nil
end

local function num(v) if type(v) == "number" then return v end return 0 end

local function finite_num(v)
  return type(v) == "number" and v == v and math.abs(v) < math.huge
end

-- 阵营：只读 CoalitionID。它是 DCS 的阵营字段（0/1/2），与 Country 不是一回事；
-- 缺失或非法一律 "unknown"，不回退 Country/coalition，避免把国家当阵营。
local function side_text(v)
  if type(v) == "string" then v = tonumber(v) end
  if finite_num(v) and v >= 0 and v <= 2 and v == math.floor(v) then
    return string.format("%d", v)
  end
  return nil
end

local function coalition_text(obj)
  return side_text(obj.CoalitionID) or "unknown"
end

-- 稳定顺序：目标按对象 id 排序输出，不依赖 pairs 遍历顺序。
local function key_less(a, b)
  local ta, tb = type(a), type(b)
  if ta == tb then
    if ta == "number" or ta == "string" then return a < b end
    return tostring(a) < tostring(b)
  end
  return ta < tb
end

local function sorted_keys(tbl)
  local keys = {}
  for k in pairs(tbl) do keys[#keys + 1] = k end
  table.sort(keys, key_less)
  return keys
end

-- 采样一帧：adapter = runtime.export.new(env)（缺省用 DCS 全局适配器）；
-- send(line) 发送一行。返回发出的行数（测试/诊断用）。
-- 缺本机/位置/速度字段时 fail-closed：不发伪造数据，速度按 vel_valid=0 处理。
function AESA.sample(t, adapter, send)
  adapter = adapter or api
  local n = 0
  local function out(line) n = n + 1 send(line) end

  -- 本机
  local sd, self_why = adapter:self_data()
  if type(sd) ~= "table" then
    AESA.last_reason = "no-selfdata:" .. tostring(self_why)
    return 0
  end
  local sp = vec3(sd.Position) or vec3(sd.position)
  if not sp then AESA.last_reason = "no-selfpos" return 0 end
  -- 本机速度只认真实速度接口；缺失时发 0 + vel_valid=0，
  -- 不用本机数据上并不存在的 velocity 字段冒充。
  local sv = adapter:vector_velocity()
  local vel_valid = sv ~= nil
  local svx, svy, svz = 0, 0, 0
  if sv then svx, svy, svz = num(sv.x), num(sv.y), num(sv.z) end
  out(string.format("A %s %s %s %s %s %s %s %s %d",
    fmt(t), sanitize(sd.Name or sd.name or "OWN"),
    fmt(sp.x), fmt(sp.y), fmt(sp.z), fmt(svx), fmt(svy), fmt(svz),
    vel_valid and 1 or 0))
  if type(sd.Heading) == "number" and type(sd.Pitch) == "number" and type(sd.Bank) == "number" then
    -- 原始 DCS 姿态：Heading 从北顺时针、Pitch 上仰为正、Bank 右机翼下沉为正。
    -- 坐标轴与航向的转换只在接收端 src/adapters/dcs/frame.lua。
    out(string.format("O %s %s %s %s", fmt(t), fmt(sd.Heading), fmt(sd.Pitch), fmt(sd.Bank)))
  end

  -- 首帧探针：把世界对象第一个对象的字段名发出去（现场发现结构差异）
  local objs = adapter:world_objects()
  if not AESA.probed and type(objs) == "table" then
    local first
    local obj_keys = sorted_keys(objs)
    if obj_keys[1] ~= nil then first = objs[obj_keys[1]] end
    if type(first) == "table" then
      local keys = {}
      for k, v in pairs(first) do keys[#keys + 1] = k .. ":" .. type(v) end
      table.sort(keys)
      out("P " .. table.concat(keys, "|"))
    end
    AESA.probed = true
  end

  -- 单位（过滤本机自身：世界对象会把玩家飞机列进来，位置与本机重合）
  if type(objs) == "table" then
    for _, id in ipairs(sorted_keys(objs)) do
      local obj = objs[id]
      if type(obj) == "table" then
        local p = vec3(obj.Position) or vec3(obj.position) or vec3(obj.pos)
        local v = vec3(obj.velocity) or vec3(obj.Velocity) or vec3(obj.vel)
        local obj_vel_valid = v ~= nil
        local distance2 = 0
        if p then distance2 = (p.x - sp.x)^2 + (p.y - sp.y)^2 + (p.z - sp.z)^2 end
        if p and distance2 > 4.0 then
          local vx, vy, vz = 0, 0, 0
          if v then vx, vy, vz = num(v.x), num(v.y), num(v.z) end
          out(string.format("T %s %s %s %s %s %s %s %s %s %s %s",
            fmt(t), sanitize(id), sanitize(obj.Name or obj.name or "?"), coalition_text(obj),
            fmt(p.x), fmt(p.y), fmt(p.z), fmt(vx), fmt(vy), fmt(vz),
            obj_vel_valid and 1 or 0))
          local visible = adapter:terrain_visible(sp.x, sp.y, sp.z, p.x, p.y, p.z)
          if type(visible) == "boolean" then
            out(string.format("L %s %s %d", fmt(t), sanitize(id), visible and 1 or 0))
          end
        end
      end
    end
  end

  -- 引擎雷达接触（对照用，录制原始字段，解释在回放侧）
  local tgts = adapter:target_information()
  if type(tgts) == "table" then
    for _, key in ipairs(sorted_keys(tgts)) do
      local tg = tgts[key]
      if type(tg) == "table" then
        local p = tg.position and vec3(tg.position.p or tg.position) or nil
        local pos = ""
        if p then pos = fmt(p.x) .. " " .. fmt(p.y) .. " " .. fmt(p.z) .. " " end
        out(string.format("E %s %s %s%s %s %s %s",
          fmt(t), sanitize(tg.ID or tg.id or "?"), pos,
          fmt(tg.distance), fmt(tg.convergence_velocity),
          fmt(tg.reflection), num(tg.flags)))
      end
    end
  end

  return n
end

-- ---------------- 实际 Export 接线（测试环境不执行以下部分的条件由测试方控制） -----

-- socket 引导统一由适配层负责；缺失时写诊断并停止连接尝试，不静默失败。
local socket_api, socket_why
local socket_checked = false

local function socket_ready()
  if socket_checked then return socket_api ~= nil end
  socket_checked = true
  socket_api, socket_why = runtime.socket.bootstrap(_G)
  if not socket_api then
    AESA.socket_missing = true
    diag("socket UNAVAILABLE: " .. tostring(socket_why))
  end
  return socket_api ~= nil
end

local function compat_line()
  return "COMPAT," .. profile:id() .. "," .. profile:matrix_hash()
end

local function try_connect(now)
  if AESA.sock then return true end
  if AESA.socket_missing then return false end
  if now - AESA.last_try < AESA.RETRY_S then return false end
  AESA.last_try = now
  if not socket_ready() then return false end
  local ok, s = pcall(function()
    local c = socket_api.tcp()
    c:settimeout(0.05)
    if not c:connect(AESA.HOST, AESA.PORT) then c:close() error("connect failed") end
    c:settimeout(0.05)
    return c
  end)
  if ok then
    AESA.sock = s
    AESA.probed = false
    -- 先 V1 会话标记，再 PROTO,2 坐标声明，最后 COMPAT 兼容握手（接收端忽略未知行）。
    local payload = "V1\nPROTO,2\n" .. compat_line() .. "\n"
    local sent_ok, sent, sent_err = pcall(function() return s:send(payload) end)
    if not sent_ok or sent == nil then
      diag("handshake send fail: " .. tostring(sent_ok and sent_err or sent))
      pcall(function() s:close() end)
      AESA.sock = nil
      return false
    end
    if profile:is_fallback() then
      diag("profile fallback=" .. tostring(profile.fallback_reason) .. " id=" .. profile:id())
    end
    diag("connected; profile=" .. profile:id() .. " compat=" .. profile:matrix_hash())
  else
    AESA.err_count = AESA.err_count + 1
    if AESA.err_count <= 3 or AESA.err_count % 20 == 0 then
      diag("connect fail #" .. AESA.err_count .. " socket_ok=" .. tostring(socket_api ~= nil))
    end
  end
  return ok
end

-- 每帧轮询采样（由 LuaExportAfterNextFrame 驱动；不依赖 ActivityNextEvent——
-- 实测在该工具链环境下 DCS 会在任务加载完成后停止调用后者，前者全程可靠）
function AESA.frame_poll()
  local t = api:model_time()
  if type(t) ~= "number" or t ~= t or math.abs(t) == math.huge then return end
  AESA.last_t = t
  local interval = 1.0 / AESA.RATE_HZ
  AESA.next_sample = AESA.next_sample or 0
  if t < AESA.next_sample then return end
  AESA.next_sample = t + interval
  if not try_connect(t) then return end
  -- 整帧合并为一次发送：大任务（100+ 单位/帧）下逐行小包发送会撑爆
  -- 非阻塞缓冲导致误判断连
  local buf = {}
  local ok, err = pcall(function()
    AESA.sample(t, api, function(line) buf[#buf + 1] = line end)
    if #buf > 0 then
      local sent, send_err = AESA.sock:send(table.concat(buf, "\n") .. "\n")
      assert(sent ~= nil, tostring(send_err))
    end
  end)
  if not ok then
    diag("poll fail: " .. tostring(err))
    pcall(function() AESA.sock:close() end)
    AESA.sock = nil
  elseif #buf == 0 then
    AESA.empty_n = (AESA.empty_n or 0) + 1
    if AESA.empty_n == 1 or AESA.empty_n % 50 == 0 then
      diag("empty frame reason=" .. tostring(AESA.last_reason) .. " count=" .. AESA.empty_n)
    end
  else
    if AESA.empty_n and AESA.empty_n > 0 then
      diag("frames resumed after " .. AESA.empty_n .. " empty")
    end
    AESA.empty_n = 0
    AESA.ok_n = (AESA.ok_n or 0) + 1
    if AESA.ok_n == 1 then diag("first frame sent, lines=" .. #buf) end
    if AESA.ok_n % 200 == 0 then diag("ok_n=" .. AESA.ok_n .. " t=" .. string.format("%.1f", t)) end
    -- E 诊断（每 5s）：引擎目标接口的实际返回类型与权限位
    -- （背景：目标信息接口为 FC 时代接口，新模块不喂数据——实测留证）
    if not AESA.ediag_t or t - AESA.ediag_t >= 5 then
      AESA.ediag_t = t
      local tgt = api:target_information()
      local lock = api:locked_target_information()
      local allowed = api:sensor_export_allowed()
      local n1 = type(tgt) == "table" and #tgt or "-"
      diag("E-diag tgt=" .. tostring(n1) .. "/" .. type(tgt)
        .. " lock=" .. type(lock) .. " allow=" .. tostring(allowed))
    end
  end
end

-- 回调链式包裹（与其他 Export 工具共存；无论此前是否有人定义过回调都要挂载，
-- 否则全新 Export.lua（只有我们的块）时 DCS 不会调用任何东西）
do
  local _start = LuaExportStart
  LuaExportStart = function()
    if _start then _start() end
    AESA.next_sample = 0
    AESA.last_try = -1e9
    AESA.sock = nil
    AESA.empty_n, AESA.ok_n = nil, nil
    diag("export start")
  end
  local _stop = LuaExportStop
  LuaExportStop = function()
    diag("export stop (ok_n=" .. tostring(AESA.ok_n) .. ")")
    if AESA.sock then pcall(function() AESA.sock:close() end) AESA.sock = nil end
    if _stop then _stop() end
  end
  local _next = LuaExportActivityNextEvent
  LuaExportActivityNextEvent = function(t)
    -- 纯透传：只保证邻居回调链正常；采样已改由每帧回调驱动
    -- （实测本环境下 DCS 会在任务加载完成后停调本回调，不可依赖）
    local nt
    if _next then
      local ok, r = pcall(_next, t)
      if ok then nt = r else
        diag("next-chain error: " .. tostring(r))
      end
    end
    if type(nt) ~= "number" or nt ~= nt or nt < t or nt > t + 10 then
      nt = t + 0.5
    end
    return nt
  end
  -- 每帧回调：邻居链 + 我们的限频采样（全程可靠的驱动源）
  local _after = LuaExportAfterNextFrame
  LuaExportAfterNextFrame = function()
    if _after then
      local ok, r = pcall(_after)
      if not ok then diag("after-chain error: " .. tostring(r)) end
    end
    AESA.frm_n = (AESA.frm_n or 0) + 1
    if AESA.frm_n % 300 == 1 then diag("FRAME alive #" .. AESA.frm_n) end
    local ok2, err2 = pcall(AESA.frame_poll)
    if not ok2 then diag("poll error: " .. tostring(err2)) end
  end
end

return AESA

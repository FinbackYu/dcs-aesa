-- AESA cockpit bridge controller (C1.6).
-- Loaded as an avLuaDevice through device_init.lua. It reads the local,
-- receiver-written state file and publishes named cockpit parameters for
-- MFD_FCR_AESA_AA.lua. It never reads DCS world state and never writes the
-- native FCR device.
local lfs = rawget(_G, "lfs")
if not lfs then
    local ok, module = pcall(require, "lfs")
    if ok then lfs = module end
end
local state_path
if lfs and type(lfs.writedir) == "function" then
    local ok, dir = pcall(lfs.writedir)
    if ok and type(dir) == "string" and dir ~= "" then
        if string.sub(dir, -1) ~= "\\" and string.sub(dir, -1) ~= "/" then
            dir = dir.."\\"
        end
        state_path = dir.."Scripts\\AESA-COCKPIT\\state.txt"
    end
end

-- Bring-up diagnostic (temporary, registered in DEPRECATIONS.md): the avLuaDevice
-- cockpit state may lack lfs or resolve writedir differently; log the facts at
-- load and every read-outcome/parameter change so the real-machine path is
-- visible.
local diag_path = state_path and (state_path:sub(1, -10).."controller-diag.log") or nil
local diag_last
local function diag(line)
    local ok, file = pcall(io.open, diag_path or "aesa-cockpit-diag.log", "a")
    if not ok or not file then return end
    local clock = rawget(_G, "os") and os.clock and string.format("%.1f", os.clock()) or "?"
    file:write("["..clock.."] "..line.."\n")
    file:close()
end
local diag_done = {}
local function diag_once(key, line)
    if diag_done[key] then return end
    diag_done[key] = true
    diag(line)
end
diag("boot lfs_global="..type(rawget(_G, "lfs")).." lfs="..type(lfs)
    .." io="..type(rawget(_G, "io")).." os="..type(rawget(_G, "os"))
    .." path="..tostring(state_path))

local handles, values = {}, {}
local function set(name, value)
    if values[name] == value then return end
    local handle = handles[name]
    if not handle then
        handle = get_param_handle(name)
        handles[name] = handle
    end
    if not handle then
        diag_once("nohandle:"..name, "param handle unavailable: "..name)
        return
    end
    local ok, err = pcall(function() handle:set(value) end)
    if ok then
        values[name] = value
    else
        diag_once("setfail:"..name, "param set failed: "..name.." ("..tostring(err)..")")
    end
end

-- Declare every published parameter at load time, and resolve all handles up
-- front. The cockpit parameter registry is shared across Lua states; a name
-- first created after the indicator pages are constructed may never bind on
-- the page side (the C1.5 "stuck on defaults" defect). The same names are
-- also declared from the device_init.lua registration block, before any
-- worker thread starts; tests/test_cockpit_page.cjs pins both lists equal.
local TRACK_SUFFIXES = { "_SHOW", "_STATUS", "_X", "_Y", "_HDG", "_ALT", "_TUC", "_HOT" }
local PARAM_NAMES = {
    "AESA_MODE", "AESA_RANGE", "AESA_RANGE_UP", "AESA_RANGE_DOWN",
    "AESA_AZ", "AESA_BARS", "AESA_WPN", "AESA_HINT",
    "AESA_BEAM_X", "AESA_BEAM_EL", "AESA_PITCH", "AESA_ROLL", "AESA_SCAN_LIM",
    "AESA_CUR_X", "AESA_CUR_Y", "AESA_CUR_MAX", "AESA_CUR_MIN", "AESA_CUR_BRG",
    "AESA_STT_SHOW", "AESA_STT_ASPECT", "AESA_STT_TRK", "AESA_STT_CAS", "AESA_STT_CLOSE",
}
for i = 1, 8 do
    for _, suffix in ipairs(TRACK_SUFFIXES) do
        PARAM_NAMES[#PARAM_NAMES + 1] = "AESA_TRK_"..i..suffix
    end
end
for _, name in ipairs(PARAM_NAMES) do
    local handle = get_param_handle(name)
    if handle then
        handles[name] = handle
    else
        diag_once("nohandle:"..name, "param handle unavailable: "..name)
    end
end
diag("declared "..#PARAM_NAMES.." params")

local function clamp(value, low, high)
    if value < low then return low end
    if value > high then return high end
    return value
end

local function upper(value)
    return type(value) == "string" and string.upper(value) or ""
end

local function round(value)
    return math.floor(value + .5)
end

local function pad2(value)
    return string.format("%02d", clamp(round(value), 0, 99))
end

local function pad3(value)
    return string.format("%03d", clamp(round(value), 0, 999))
end

-- B-scope projection shared by tracks and the TDC cursor: x = az x2 units,
-- y = -240 + range/scale x 480; off-scope contacts are hidden, not clamped.
local function project(az, range, scale)
    local visible = math.abs(az) <= 63 and range >= 0 and range <= scale
    return clamp(az, -63, 63) * 2, -240 + clamp(range, 0, scale) / scale * 480, visible
end

local STATUS_CODE = { SEARCH = 0, TRACK = 1, STT = 2 }

local function clear_track(i)
    local prefix = "AESA_TRK_"..i
    set(prefix.."_SHOW", 0)
    set(prefix.."_STATUS", 0)
    set(prefix.."_X", 0)
    set(prefix.."_Y", 0)
    set(prefix.."_HDG", 0)
    set(prefix.."_ALT", "")
    set(prefix.."_TUC", 0)
    set(prefix.."_HOT", 0)
end

local function publish_track(i, track, scale, tuc_slot)
    local prefix = "AESA_TRK_"..i
    local x, y, visible = project(track.az or 0, track.range or 0, scale)
    local vc = track.vc or 0
    set(prefix.."_SHOW", visible and 1 or 0)
    set(prefix.."_STATUS", STATUS_CODE[track.status] or 0)
    set(prefix.."_X", x)
    set(prefix.."_Y", y)
    set(prefix.."_HDG", track.hdg or 0)
    set(prefix.."_ALT", pad2((track.alt or 0) / 1000))
    set(prefix.."_TUC", visible and i == tuc_slot and 1 or 0)
    set(prefix.."_HOT", vc < -50 and -1 or (vc > 50 and 1 or 0))
end

local function clear_all()
    for i = 1, 8 do clear_track(i) end
    set("AESA_STT_SHOW", 0)
    set("AESA_STT_ASPECT", "")
    set("AESA_STT_TRK", "")
    set("AESA_STT_CAS", "")
    set("AESA_STT_CLOSE", "")
    set("AESA_HINT", "NO DATA")
end

-- STT top-row readouts: demo-grade derivations from the locked track (same
-- math as the display preview) until the tracker publishes real values.
local function publish_stt(track)
    if not track then
        set("AESA_STT_SHOW", 0)
        set("AESA_STT_ASPECT", "")
        set("AESA_STT_TRK", "")
        set("AESA_STT_CAS", "")
        set("AESA_STT_CLOSE", "")
        return
    end
    local hdg = track.hdg or 0
    local vc = track.vc or 0
    local angle = (hdg - (track.az or 0) + 180) % 360
    local aspect = angle <= 180 and (round(angle).."R") or (round(360 - angle).."L")
    set("AESA_STT_SHOW", 1)
    set("AESA_STT_ASPECT", aspect)
    set("AESA_STT_TRK", pad3(hdg).."°")
    set("AESA_STT_CAS", tostring(380 + round(math.abs(vc) / 10)))
    set("AESA_STT_CLOSE", (vc < 0 and "+" or "")..round(-vc).."K")
end

local function publish(state)
    if not state.valid then
        set("AESA_MODE", "---")
        set("AESA_RANGE", "---")
        set("AESA_AZ", "---")
        set("AESA_BARS", "---")
        set("AESA_WPN", "")
        set("AESA_RANGE_UP", 0)
        set("AESA_RANGE_DOWN", 0)
        set("AESA_BEAM_X", 0)
        set("AESA_BEAM_EL", 0)
        set("AESA_PITCH", 0)
        set("AESA_ROLL", 0)
        set("AESA_CUR_X", 0)
        set("AESA_CUR_Y", 0)
        set("AESA_CUR_MAX", "")
        set("AESA_CUR_MIN", "")
        set("AESA_CUR_BRG", "")
        clear_all()
        return
    end
    local scale = math.max(state.range or 40, 1)
    local bars = state.bars or 4
    local az = state.az or 60
    local beam = state.beam or 0
    set("AESA_MODE", upper(state.mode) ~= "" and upper(state.mode) or "RWS")
    set("AESA_RANGE", string.format("%d", scale))
    set("AESA_RANGE_UP", scale < 160 and 1 or 0)
    set("AESA_RANGE_DOWN", scale > 5 and 1 or 0)
    set("AESA_AZ", "A\n"..(az >= 60 and 6 or az >= 30 and 3 or 1))
    set("AESA_BARS", string.format("%d\nB", bars))
    set("AESA_WPN", state.wpn or "")
    set("AESA_BEAM_X", clamp(beam * 2, -120, 120))
    set("AESA_BEAM_EL", clamp((state.beam_el or 0) * 2, -120, 120))
    set("AESA_PITCH", state.pitch or 0)
    set("AESA_ROLL", state.roll or 0)
    set("AESA_SCAN_LIM", clamp(az, 0, 60) * 2)
    -- TDC cursor: explicit cursor=az,range or parked on the beam at 55% range.
    local cur_az, cur_range = beam, .55 * scale
    if state.cursor then
        cur_az, cur_range = state.cursor.az, state.cursor.range
    end
    local cx, cy = project(cur_az, clamp(cur_range, 0, scale), scale)
    cx = clamp(cx, -120, 120)
    set("AESA_CUR_X", cx)
    set("AESA_CUR_Y", cy)
    -- Scan altitude window at the cursor: demo calc from the altitude setting,
    -- cursor range fraction and bar count (mirrors the preview).
    local alt_k = tonumber(string.match(tostring(state.alt or ""), "%d+")) or 20
    local half = alt_k * (1 - clamp(cur_range / scale, 0, 1)) * .35 + bars
    set("AESA_CUR_MAX", pad2(math.min(99, alt_k + half)))
    set("AESA_CUR_MIN", pad2(math.max(1, alt_k - half)))
    -- Cursor bearing/range relative to the fixed steerpoint symbol (-15, 105).
    local dx, dy = cx - (-15), cy - 105
    local brg = math.deg(math.atan2(dx, dy)) % 360
    local rng = math.sqrt(dx * dx + dy * dy) / 480 * scale
    set("AESA_CUR_BRG", string.format("%03d %02d", round(brg) % 360, clamp(round(rng), 0, 99)))
    -- Tracks; TUC is the cursor-nearest visible SEARCH track, suppressed by STT.
    local tracks = state.tracks or {}
    local stt_slot
    for i = 1, 8 do
        local track = tracks[i]
        if track and STATUS_CODE[track.status] == 2 then
            local _, _, visible = project(track.az or 0, track.range or 0, scale)
            if visible then stt_slot = i end
        end
    end
    local tuc_slot, tuc_dist
    if not stt_slot then
        for i = 1, 8 do
            local track = tracks[i]
            if track and (STATUS_CODE[track.status] or 0) == 0 then
                local x, y, visible = project(track.az or 0, track.range or 0, scale)
                if visible then
                    local d = (x - cx) * (x - cx) + (y - cy) * (y - cy)
                    if not tuc_dist or d < tuc_dist then tuc_slot, tuc_dist = i, d end
                end
            end
        end
    end
    for i = 1, 8 do
        local track = tracks[i]
        if track then publish_track(i, track, scale, tuc_slot) else clear_track(i) end
    end
    publish_stt(stt_slot and tracks[stt_slot])
    set("AESA_HINT", "")
end

local function split(value)
    local fields = {}
    for field in string.gmatch(value, "([^,]+)") do fields[#fields + 1] = field end
    return fields
end

local function parse_track(value)
    local fields = split(value)
    if #fields < 6 then return nil end
    local id = tonumber(fields[1])
    local az = tonumber(fields[2])
    local range = tonumber(fields[3])
    local vc = tonumber(fields[4])
    local alt = tonumber(fields[5])
    if not (id and az and range and vc and alt) then return nil end
    return {
        id = id, az = az, range = range, vc = vc, alt = alt,
        status = upper(fields[6]),
        hdg = tonumber(fields[7]) or 0,
    }
end

local function parse_own(value)
    local fields = split(value)
    return tonumber(fields[2]) or 0, tonumber(fields[3]) or 0
end

local function parse_cursor(value)
    local fields = split(value)
    local az, range = tonumber(fields[1]), tonumber(fields[2])
    if not (az and range) then return nil end
    return { az = az, range = range }
end

local function read_state()
    if not state_path then return nil, "no_path" end
    local file, err = io.open(state_path, "r")
    if not file then return nil, "open_fail:"..tostring(err) end
    local text = file:read("*a")
    file:close()
    if not text or text == "" then return nil, "empty" end
    local raw = { tracks = {} }
    for line in string.gmatch(text, "[^\r\n]+") do
        local key, value = string.match(line, "^([%w_]+)=(.*)$")
        if key == "track" then
            local track = parse_track(value)
            if track and #raw.tracks < 8 then raw.tracks[#raw.tracks + 1] = track end
        elseif key then
            raw[key] = value
        end
    end
    local seq = tonumber(raw.seq)
    if not seq then return nil, "no_seq" end
    local pitch, roll = 0, 0
    if raw.own then pitch, roll = parse_own(raw.own) end
    return {
        seq = seq,
        valid = raw.valid == "1",
        mode = raw.mode,
        range = tonumber(raw.range) or 40,
        az = tonumber(raw.az) or 60,
        bars = tonumber(raw.bars) or 4,
        alt = raw.alt,
        beam = tonumber(raw.beam) or 0,
        beam_el = tonumber(raw.beam_el) or 0,
        pitch = pitch,
        roll = roll,
        wpn = raw.wpn and upper(raw.wpn) or nil,
        cursor = raw.cursor and parse_cursor(raw.cursor) or nil,
        extra = tonumber(raw.extra) or 0, -- reserved (track overflow count, C2)
        tracks = raw.tracks,
    }
end

local last_seq, last_valid
local function update_state()
    local state, why = read_state()
    if why ~= nil and why ~= diag_last then
        diag_last = why
        diag("read fail: "..why)
    elseif state and diag_last ~= nil then
        diag_last = nil
        diag("read ok: seq="..state.seq.." valid="..tostring(state.valid))
    end
    if not state then
        if last_seq ~= nil or last_valid ~= false then
            last_seq, last_valid = nil, false
            publish({ valid = false, tracks = {} })
        end
        return
    end
    if state.seq == last_seq then return end
    last_seq, last_valid = state.seq, state.valid
    publish(state)
end

make_default_activity(0.1)

function post_initialize()
    update_state()
end

function update()
    update_state()
end

function SetCommand(command, value)
    -- C1 is read-only from the cockpit; HOTAS commands are added in C2.
end

need_to_be_closed = false

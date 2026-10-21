-- AESA A/A page: replaces the F-16C PAGE_FCR_AA page composition.
-- The native FCR device still owns page selection/power/SOI; this page only
-- draws the AESA presentation and reads parameters published by
-- AESA/controller.lua. No DCS world access, no native DLL.
--
-- Layout follows the DCS-native FCR A/A page (MFD_FCR_AA.lua,
-- MFD_FCR_COMMON.lua, MFD_FCR_BASE.lua, MFD_Symbology.lua) and the confirmed
-- display preview tools/cockpit_preview.html. The preview paints scales,
-- carets and the horizon teal/cyan; the F-16C material table only offers the
-- default text color and the dedicated yellow controller, so those elements
-- are WHITE here and only STT/NO DATA use YELLOW.
--
-- Parameter binding rules (C1.6 — pinned by tests/test_cockpit_page.cjs):
-- * The engine binds element_params/controllers inside Add(): fields assigned
--   after an add* helper returns are never picked up (the C1.5 "everything
--   stuck on defaults / NO DATA" defect). Every helper below passes all
--   controllers at creation time; only moved() needs element_params and sets
--   both fields before Add().
-- * Parameter-driven text uses the stock shorthand: the bare parameter name
--   as the first controller entry binds it as the text source (native
--   precedent: FCR_RangeVelScale, FCR_BearingRangeLabel, DED lines). No
--   element_params, no text_using_parameter, no formats.
-- * Visibility gates use the stock equality shorthand {name, value} at
--   creation (native precedent: {"MFD_SOI", 1} on the SOI box).
dofile(LockOn_Options.script_path.."Displays/MFD/indicator/MFD_Symbology.lua")

local WHITE = {{"MFD_Text_Color"}}
local YELLOW = {{"MFD_SetColor_Yellow"}}
local F8 = STROKE_FNT_DFLT_8_12
local F10 = STROKE_FNT_DFLT_10_14

-- Stroke line rot: 0 extends +y, -90 extends +x, 90 extends -x, 180 extends -y.
local function hline(name, length, x, y, parent, controllers)
    return addStrokeLine(name, length, {x, y}, -90, parent, controllers or WHITE)
end
local function vline(name, length, x, y, parent, controllers)
    return addStrokeLine(name, length, {x, y}, 0, parent, controllers or WHITE)
end
local function frame(name, cx, cy, w, h, parent, controllers)
    local hw, hh = w / 2, h / 2
    hline(name.."_T", w, cx - hw, cy + hh, parent, controllers)
    hline(name.."_B", w, cx - hw, cy - hh, parent, controllers)
    vline(name.."_L", h, cx - hw, cy - hh, parent, controllers)
    vline(name.."_R", h, cx + hw, cy - hh, parent, controllers)
end
local function text(name, value, font, align, pos, parent, controllers)
    return addStrokeText(name, value, font, align, pos, parent, controllers or WHITE)
end
-- Parameter-driven text: stock shorthand binding (see the header rules).
local function ptext(name, value, font, align, pos, parent, param, color)
    return addStrokeText(name, value, font, align, pos, parent, {{param}, color or WHITE[1]})
end
-- Visibility gate: stock equality shorthand, visible while param == on.
local function gate(name, param, on, parent, pos)
    return addPlaceholder(name, pos or {0, 0}, parent, {{param, on}})
end
-- Move/rotate placeholder: no stock helper accepts element_params, so build
-- the ceSimple and set element_params + controllers before Add().
local function moved(name, params, controllers, parent, pos)
    local ph = CreateElement("ceSimple")
    setPlaceholderCommonProperties(ph, name, pos or {0, 0}, parent, nil)
    ph.element_params = params
    ph.controllers = controllers
    Add(ph)
    return ph
end

-- The display bezel/frame is not drawn by the page: the MFD screen edge is the
-- physical bezel (the native pages draw no frame either). Bottom-row format
-- labels (SWAP / current format / TEST / DTE / DCLT) come from SUBSET_BASE_MENU
-- in the page composition, driven by the native MFD device (inverse-video
-- selection included); this page draws none of them.

------------------------------------------------------------- OSB labels (F10)
-- Stock add_PB_label for the top row: the text anchors at {x, 237} CenterTop
-- and each label carries the stock clip mask that cuts the SOI frame around
-- the text (the gaps in the selection border). Mask controllers stay nil —
-- this page has no menu states, so the gaps are always open. The mode label
-- follows the AESA_MODE parameter; the rest are static.
add_PB_label(1, "CRM", nil, WHITE)
add_PB_label(2, "RWS", nil, {{"AESA_MODE"}, WHITE[1]})
add_PB_label(3, "NORM", nil, WHITE)
add_PB_label(4, "OVRD", nil, WHITE)
add_PB_label(5, "CNTL", nil, WHITE)
local cont = text("AESA_CONT", "CONT", F10, "CenterCenter", {214, 135})
addSizeClipMask(cont, 2, 20, nil, {25, 0})

-- Right edge range marks (3/4, 1/2, 1/4 of the selected range).
local rmarks = addPlaceholder("AESA_RMARKS", {239, 0}, nil, nil)
for i = 0, 2 do
    hline("AESA_RMARK_"..i, 15, -15, 120 - i * 120, rmarks.name, WHITE)
end

------------------------------------------------------------- left column
-- Range cluster at the native Range_Scale_Root {-220, 116}: the value with
-- its stock outlined underlay, the native Decrement-symbol arrows at
-- {0, +/-25} (scale 3.5; the increment is the same symbol rotated 180), and
-- the stock edge mask that cuts the SOI frame around the cluster.
local range_root = addPlaceholder("AESA_RANGE_ROOT", {-220, 116}, nil, nil)
addStrokeText("AESA_RANGE_OUTLINED", 40, F10, "CenterCenter", nil, range_root.name, {{"AESA_RANGE"}}, nil, true)
ptext("AESA_RANGE", 40, F10, "CenterCenter", nil, range_root.name, "AESA_RANGE")
addStrokeSymbol("AESA_RANGE_DOWN_SYM", {"stroke_symbols_MFD", "Decrement-symbol"}, "FromSet", {0, -25}, range_root.name, {{"AESA_RANGE_DOWN", 1}, WHITE[1]}, 3.5)
local range_up = addStrokeSymbol("AESA_RANGE_UP_SYM", {"stroke_symbols_MFD", "Decrement-symbol"}, "FromSet", {0, 25}, range_root.name, {{"AESA_RANGE_UP", 1}, WHITE[1]}, 3.5)
range_up.init_rot = {180}
addSizeClipMask(range_root, 2, 72, nil, {-19, 0})
-- Azimuth setting and elevation bar count at the stock PB18/PB17 anchors
-- (text at x=-237 LeftCenter; the controller sends them pre-wrapped, "A\n6").
ptext("AESA_AZ", "A\n6", F10, "LeftCenter", {-237, -1}, nil, "AESA_AZ")
ptext("AESA_BARS", "4\nB", F10, "LeftCenter", {-237, -79}, nil, "AESA_BARS")
-- IFF mode readout at the stock FCR_IFF anchor (static "M4" until the AESA
-- core grows an IFF model).
local m4 = text("AESA_M4", "M4", F10, "LeftCenter", {-235, -145})
addSizeClipMask(m4, 2, 20, nil, {-4, 0})

------------------------------------------------------------- scales and carets
-- Bottom azimuth scale: seven ticks up from y=-212, center tick longer.
local aztics = addPlaceholder("AESA_AZ_TICS", {0, -212}, nil, nil)
for i = 0, 6 do
    vline("AESA_AZ_TIC_"..i, i == 3 and 22 or 15, -120 + i * 40, 0, aztics.name, WHITE)
end
-- Left elevation scale: seven ticks right from x=-197, center tick longer.
local eltics = addPlaceholder("AESA_EL_TICS", {-197, 0}, nil, nil)
for i = 0, 6 do
    hline("AESA_EL_TIC_"..i, i == 3 and 22 or 15, 0, 120 - i * 40, eltics.name, WHITE)
end
-- T carets (three-line thickness, native addCaret pattern). Azimuth hangs from
-- y=-218 and follows the beam azimuth; elevation sits at x=-203, rotated 90
-- degrees, and follows the antenna elevation. Preview paints these teal.
local function caret_lines(name, parent)
    for i = 0, 2 do
        addStrokeLine(name.."_V_"..i, 13, {-1 + i, 0}, -180, parent, WHITE)
        hline(name.."_H_"..i, 13, -6.5, 1 - i, parent, WHITE)
    end
end
local azcaret = moved("AESA_AZ_CARET", {"AESA_BEAM_X"},
    {{"move_left_right_using_parameter", 0, 1}}, nil, {0, -218})
caret_lines("AESA_AZ_CARET", azcaret.name)
local elcaret = moved("AESA_EL_CARET", {"AESA_BEAM_EL"},
    {{"move_up_down_using_parameter", 0, 1}}, nil, {-203, 0})
elcaret.init_rot = {-90}
caret_lines("AESA_EL_CARET", elcaret.name)

------------------------------------------------------------- B-scope center
-- Horizon: 240-wide line with 8-unit downturned end ticks, moved by pitch
-- (positive pitch pushes the line down) and rotated by roll. Preview: cyan.
local horizon = moved("AESA_HORI_ROOT", {"AESA_PITCH", "AESA_ROLL"}, {
    {"move_up_down_using_parameter", 0, -2},
    {"rotate_using_parameter", 1, math.rad(-1)},
}, nil, {0, 0})
hline("AESA_HORI", 240, -120, 0, horizon.name, WHITE)
vline("AESA_HORI_TL", 8, -120, -8, horizon.name, WHITE)
vline("AESA_HORI_TR", 8, 120, -8, horizon.name, WHITE)
-- Azimuth scan limits: vertical lines at +/- (azimuth setting / 60 x 120).
local scanl = moved("AESA_SCANLIM_L", {"AESA_SCAN_LIM"},
    {{"move_left_right_using_parameter", 0, -1}}, nil, {0, 0})
vline("AESA_SCANLIM_L_LINE", 400, 0, -200, scanl.name, WHITE)
local scanr = moved("AESA_SCANLIM_R", {"AESA_SCAN_LIM"},
    {{"move_left_right_using_parameter", 0, 1}}, nil, {0, 0})
vline("AESA_SCANLIM_R_LINE", 400, 0, -200, scanr.name, WHITE)
-- Bullseye rings (1/5/10) and the steerpoint wedding cake. Preview: cyan.
addStrokeCircle("AESA_BULL_1", 1, {-60, 150}, nil, WHITE)
addStrokeCircle("AESA_BULL_2", 5, {-60, 150}, nil, WHITE)
addStrokeCircle("AESA_BULL_3", 10, {-60, 150}, nil, WHITE)
addFcrSteerpoint("AESA_STPT", {-15, 105}, nil, nil)

-- TDC acquisition cursor: two 30-long vertical lines at x=+/-15 with the
-- scan altitude window readouts on the right. Hidden while STT is active.
local cur_gate = gate("AESA_CUR_GATE", "AESA_STT_SHOW", 0, nil)
local cur = moved("AESA_CUR_MOVE", {"AESA_CUR_X", "AESA_CUR_Y"}, {
    {"move_left_right_using_parameter", 0, 1},
    {"move_up_down_using_parameter", 1, 1},
}, cur_gate.name, {0, 0})
vline("AESA_CUR_L", 30, -15, -15, cur.name, WHITE)
vline("AESA_CUR_R", 30, 15, -15, cur.name, WHITE)
ptext("AESA_CUR_MAX", "", F10, "LeftCenter", {20, 17}, cur.name, "AESA_CUR_MAX")
ptext("AESA_CUR_MIN", "", F10, "LeftCenter", {20, -17}, cur.name, "AESA_CUR_MIN")

------------------------------------------------------------- track slots
for i = 1, 8 do
    local prefix = "AESA_TRK_"..i
    local slot_gate = gate(prefix.."_GATE", prefix.."_SHOW", 1, nil)
    local move = moved(prefix.."_MOVE", {prefix.."_X", prefix.."_Y"}, {
        {"move_left_right_using_parameter", 0, 1},
        {"move_up_down_using_parameter", 1, 1},
    }, slot_gate.name, {0, 0})
    local rot = moved(prefix.."_ROT", {prefix.."_HDG"},
        {{"rotate_using_parameter", 0, math.rad(1)}}, move.name, {0, 0})
    -- SEARCH: filled 10x10 box; hotline up (cold) or down (hot) by HOT param;
    -- altitude only on the track-under-cursor slot (TUC gate).
    local search = gate(prefix.."_SEARCH", prefix.."_STATUS", 0, rot.name)
    addFillBox(prefix.."_FILL", 10, 10, "CenterCenter", {0, 0}, search.name, nil)
    vline(prefix.."_HOT_UP", 10, 0, 5, search.name, {{prefix.."_HOT", 1}, WHITE[1]})
    vline(prefix.."_HOT_DN", 10, 0, -15, search.name, {{prefix.."_HOT", -1}, WHITE[1]})
    addStrokeText(prefix.."_ALT", "", F10, "CenterTop", {0, -19}, search.name,
        {{prefix.."_ALT"}, {prefix.."_TUC", 1}, WHITE[1]})
    -- TRACK: 12x12 stroked box rotated with heading + 10-long nose line.
    local track = gate(prefix.."_TRACK", prefix.."_STATUS", 1, rot.name)
    frame(prefix.."_TRACK_BOX", 0, 0, 12, 12, track.name, WHITE)
    vline(prefix.."_TRACK_NOSE", 10, 0, 6, track.name, WHITE)
    ptext(prefix.."_TALT", "", F10, "CenterTop", {0, -19}, track.name, prefix.."_ALT")
    -- STT: yellow 18x18 box + outer circle + top aspect pointer.
    local stt = gate(prefix.."_STT", prefix.."_STATUS", 2, rot.name)
    frame(prefix.."_STT_BOX", 0, 0, 18, 18, stt.name, YELLOW)
    addStrokeCircle(prefix.."_STT_CIRCLE", 16, {0, 0}, stt.name, YELLOW)
    vline(prefix.."_STT_PTR", 10, 0, 13, stt.name, YELLOW)
    ptext(prefix.."_STT_ALT", "", F10, "CenterTop", {0, -19}, stt.name, prefix.."_ALT", YELLOW[1])
end

-- STT data row across the top (aspect / ground track / CAS / closure).
local stt_row = gate("AESA_STT_ROW", "AESA_STT_SHOW", 1, nil)
ptext("AESA_STT_ASPECT", "", F8, "LeftTop", {-218, 215}, stt_row.name, "AESA_STT_ASPECT")
ptext("AESA_STT_TRK", "", F8, "LeftTop", {-158, 215}, stt_row.name, "AESA_STT_TRK")
ptext("AESA_STT_CAS", "", F8, "CenterTop", {79, 215}, stt_row.name, "AESA_STT_CAS")
ptext("AESA_STT_CLOSE", "", F8, "RightTop", {198, 215}, stt_row.name, "AESA_STT_CLOSE")

------------------------------------------------------------- bottom data
-- Bullseye LOS reference (static demo values, same as the preview).
addStrokeCircle("AESA_BLOS", 17, {-213, -194}, nil, WHITE)
text("AESA_BLOS_RNG", "34", F8, "CenterCenter", {-213, -194})
text("AESA_BLOS_BRG", "058", F8, "CenterCenter", {-213, -224.6})
-- Cursor bearing/range from the steerpoint ("042 11" style).
ptext("AESA_CUR_BRG", "", F8, "LeftCenter", {-235, -119}, nil, "AESA_CUR_BRG")
text("AESA_ALL", "ALL", F8, "LeftCenter", {-176, -208})
ptext("AESA_WPN", "", F10, "CenterCenter", {0, -195}, nil, "AESA_WPN")
ptext("AESA_HINT", "NO DATA", F10, "CenterCenter", {0, -186}, nil, "AESA_HINT", YELLOW[1])

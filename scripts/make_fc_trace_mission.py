#!/usr/bin/env python3
"""Surgical generator for the AESA FC trace mission.

Takes the known-good free-flight template miz and ONLY appends two groups
(E-3A AWACS on blue, 2x MiG-29A on red) plus repositions the player group
route. Every other byte of the template mission table is preserved, so GUI
compatibility is inherited rather than re-derived. No DCS launch required.

Usage: python scripts/make_fc_trace_mission.py [--install <Saved Games dir>]
"""
import os
import re
import sys
import zipfile

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
OUT = os.path.join(BASE, "dist", "dev", "AESA-FC-Trace-Caucasus.miz")
TEMPLATE = os.path.expandvars(
    r"%USERPROFILE%\Saved Games\DCS\Missions\F-16C - Caucasus - Free Flight - Enhanced.miz")

# Anchor = template player spawn area (Kutaisi overhead).
# Bandits start 25 km east heading west (head-on, lockable almost immediately).
PX, PZ = -318317.0, 635239.0
BANDIT_OFFSET = 92600.0
BANDIT_SEP = 15000.0
ALT_HI = 9144.0
AWACS_OFFSET_X, AWACS_OFFSET_Z = -40000.0, -40000.0


def scan_block(text, start):
    """Return end index of the brace-balanced block whose '{' is at text[start]."""
    depth = 0
    i = start
    n = len(text)
    while i < n:
        c = text[i]
        if c == '"' or c == "'":
            j = i + 1
            while j < n:
                if text[j] == "\\":
                    j += 2
                    continue
                if text[j] == c:
                    break
                j += 1
            i = j + 1
            continue
        if text.startswith("[[", i):
            j = text.find("]]", i + 2)
            i = n if j < 0 else j + 2
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    raise ValueError("unbalanced block")


def replace_group_name(group_text, new_name):
    """Replace the group's own ["name"] (a depth-1 key of the group table)."""
    # group_text starts with "[N] = {"; find depth-1 keys by scanning.
    bpos = group_text.find("{")
    depth = 0
    i = bpos
    n = len(group_text)
    while i < n:
        c = group_text[i]
        if c in "\"'":
            j = i + 1
            while j < n:
                if group_text[j] == "\\":
                    j += 2
                    continue
                if group_text[j] == c:
                    break
                j += 1
            i = j + 1
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                break
        elif c == "[" and depth == 1:
            mm = re.match(r'\["name"\] = "[^"]*"', group_text[i:])
            if mm:
                return (group_text[:i] + '["name"] = "%s"' % new_name +
                        group_text[i + mm.end():])
        i += 1
    return group_text


def find_group_span(mission, group_id):
    """Locate the full text span [start,end) of a group table by groupId."""
    gid = mission.find('["groupId"] = %d' % group_id)
    if gid < 0:
        raise ValueError("group %d not found" % group_id)
    # find the enclosing '["group"]' table and split its top-level items
    gpos = mission.rfind('["group"]', 0, gid)
    bpos = mission.find("{", mission.find("= ", gpos))
    epos = scan_block(mission, bpos)
    body = mission[bpos + 1:epos - 1]
    items = []
    i = 0
    n = len(body)
    while i < n:
        mm = re.compile(r'\[(\d+)\] = \{').search(body, i)
        if not mm:
            break
        bstart = mm.end() - 1
        bend = scan_block(body, bstart)
        items.append((mm.start(), bend, int(mm.group(1))))
        i = bend
    for start, end, _ in items:
        if '["groupId"] = %d' % group_id in body[start:end]:
            tail = end
            if body[tail:tail + 1] == ",":
                tail += 1
            return (bpos + 1 + start), (bpos + 1 + tail)
    raise ValueError("group %d not found in group table" % group_id)


def main():
    install = None
    args = sys.argv[1:]
    if "--install" in args:
        install = args[args.index("--install") + 1]

    with zipfile.ZipFile(TEMPLATE) as z:
        mission = z.read("mission").decode("utf-8")
        others = {n: z.read(n) for n in z.namelist() if n != "mission"}

    # --- 1. player group: shift route + unit coords to the anchor heading east
    p_start, p_end = find_group_span(mission, 348)
    player = mission[p_start:p_end]
    xs = [float(v) for v in re.findall(r'\["x"\] = (-?[\d.]+)', player)]
    zs = [float(v) for v in re.findall(r'\["y"\] = (-?[\d.]+)', player)]
    ox, oz = xs[0], zs[0]

    def shift(text, dx, dz):
        def rx(mm):
            return '["x"] = %.2f' % (float(mm.group(1)) + dx)
        def rz(mm):
            return '["y"] = %.2f' % (float(mm.group(1)) + dz)
        text = re.sub(r'\["x"\] = (-?[\d.]+)', rx, text)
        text = re.sub(r'\["y"\] = (-?[\d.]+)', rz, text)
        return text

    player = shift(player, PX - ox, PZ - oz)
    player = re.sub(r'\["heading"\] = -?[\d.]+',
                    '["heading"] = 1.5707963267949', player)
    player = re.sub(r'\["psi"\] = -?[\d.]+',
                    '["psi"] = 1.5707963267949', player)
    # rebuild the player's whole route eastbound so the air-start points at
    # the bandits (spawn orientation follows the route, not the unit psi)
    r0 = player.find('["route"]')
    rb = player.find("{", player.find("= ", r0))
    re_ = scan_block(player, rb)
    new_route = ('{\n                            ["points"] = {\n'
                 '                                [1] = {\n'
                 '                                    ["type"] = "Turning Point",\n'
                 '                                    ["alt"] = 9144.0,\n'
                 '                                    ["action"] = "Turning Point",\n'
                 '                                    ["alt_type"] = "BARO",\n'
                 '                                    ["speed"] = 256.94,\n'
                 '                                    ["ETA"] = 0,\n'
                 '                                    ["ETA_locked"] = false,\n'
                 '                                    ["y"] = %.2f,\n'
                 '                                    ["x"] = %.2f,\n'
                 '                                    ["formation_template"] = "",\n'
                 '                                    ["speed_locked"] = true,\n'
                 '                                },\n'
                 '                                [2] = {\n'
                 '                                    ["type"] = "Turning Point",\n'
                 '                                    ["alt"] = 9144.0,\n'
                 '                                    ["action"] = "Turning Point",\n'
                 '                                    ["alt_type"] = "BARO",\n'
                 '                                    ["speed"] = 256.94,\n'
                 '                                    ["ETA"] = 233.43,\n'
                 '                                    ["ETA_locked"] = true,\n'
                 '                                    ["y"] = %.2f,\n'
                 '                                    ["x"] = %.2f,\n'
                 '                                    ["formation_template"] = "",\n'
                 '                                    ["speed_locked"] = true,\n'
                 '                                },\n'
                 '                            },\n'
                 '                        }') % (PZ, PX, PZ + 60000.0, PX)
    player = player[:r0] + '["route"] = ' + new_route + player[re_:]
    # player spawn altitude to 30,000 ft as well
    player = re.sub(r'\["alt"\] = [\d.]+', '["alt"] = 9144.0', player)
    mission = mission[:p_start] + player + mission[p_end:]

    # --- 2. build AWACS + bandit groups from the shifted player skeleton
    def make_variant(skel, group_id, group_name, unit_blocks, route_pts, task):
        g = skel
        g = re.sub(r'\["groupId"\] = \d+', '["groupId"] = %d' % group_id, g)
        g = replace_group_name(g, group_name)
        # route points: replace the whole route table
        r0 = g.find('["route"]')
        rb = g.find("{", g.find("= ", r0))
        re_ = scan_block(g, rb)
        route = '{\n                            ["points"] = {\n'
        eta = 0.0
        prev = None
        for idx, (x, z, alt, speed) in enumerate(route_pts, 1):
            if prev is not None:
                eta += (((x - prev[0]) ** 2 + (z - prev[1]) ** 2) ** 0.5) / speed
            prev = (x, z)
            # DCS validation nags when a route has NO locked-time waypoint;
            # lock the last one (timing is irrelevant for the trace scenario).
            locked = "true" if idx == len(route_pts) else "false"
            route += ('                                [%d] = {\n'
                      '                                    ["alt"] = %.1f,\n'
                      '                                    ["action"] = "Turning Point",\n'
                      '                                    ["alt_type"] = "BARO",\n'
                      '                                    ["speed"] = %.1f,\n'
                      '                                    ["task"] = {\n'
                      '                                        ["id"] = "ComboTask",\n'
                      '                                        ["params"] = {\n'
                      '                                            ["tasks"] = {},\n'
                      '                                        },\n'
                      '                                    },\n'
                      '                                    ["type"] = "Turning Point",\n'
                      '                                    ["ETA"] = %.2f,\n'
                      '                                    ["ETA_locked"] = %s,\n'
                      '                                    ["y"] = %.2f,\n'
                      '                                    ["x"] = %.2f,\n'
                      '                                    ["formation_template"] = "",\n'
                      '                                    ["speed_locked"] = true,\n'
                      '                                },\n') % (idx, alt, speed, eta, locked, z, x)
        route += '                            },\n                        }'
        g = g[:r0] + '["route"] = ' + route + g[re_:]
        # task
        g = re.sub(r'\["task"\] = "[^"]*"', '["task"] = "%s"' % task, g, count=1)
        # units table
        u0 = g.find('["units"]')
        ub = g.find("{", g.find("= ", u0))
        ue = scan_block(g, ub)
        g = g[:u0] + '["units"] = {\n' + unit_blocks + '                                }' + g[ue:]
        return g

    def unit_block(skel_unit, unit_id, name, utype, x, z, alt, speed, heading,
                   skill, callsign_num, onboard):
        u = skel_unit
        u = re.sub(r'\["unitId"\] = \d+', '["unitId"] = %d' % unit_id, u)
        u = re.sub(r'\["name"\] = "[^"]*"', '["name"] = "%s"' % name, u, count=1)
        u = re.sub(r'\["type"\] = "[^"]*"', '["type"] = "%s"' % utype, u)
        u = re.sub(r'\["skill"\] = "[^"]*"', '["skill"] = "%s"' % skill, u, count=1)
        u = re.sub(r'\["x"\] = -?[\d.]+', '["x"] = %.2f' % x, u)
        u = re.sub(r'\["y"\] = -?[\d.]+', '["y"] = %.2f' % z, u)
        u = re.sub(r'\["alt"\] = [\d.]+', '["alt"] = %.1f' % alt, u, count=1)
        u = re.sub(r'\["speed"\] = [\d.]+', '["speed"] = %.2f' % speed, u, count=1)
        u = re.sub(r'\["heading"\] = -?[\d.]+', '["heading"] = %.10f' % heading, u)
        u = re.sub(r'\["psi"\] = -?[\d.]+', '["psi"] = %.10f' % heading, u)
        u = re.sub(r'\["onboard_num"\] = "\d+"', '["onboard_num"] = "%03d"' % onboard, u)
        u = re.sub(r'\["callsign"\] = \{[^}]*\}',
                   '["callsign"] = %d' % callsign_num, u)
        u = re.sub(r'^\s*\[\d+\]\s*=\s*', '', u.strip())  # skeleton's own "[N] ="
        return u

    # pull the single unit skeleton out of the shifted player group
    u0 = player.find('["units"]')
    ub = player.find("{", player.find("= ", u0))
    ue = scan_block(player, ub)
    units_text = player[ub:ue]
    us = units_text.find("[1]")
    unit_skel = units_text[us:]
    unit_skel = unit_skel[:unit_skel.rfind("},") + 2]

    awacs_route = [(PX + AWACS_OFFSET_X, PZ + AWACS_OFFSET_Z, 9000, 220),
                   (PX - 10000, PZ - 60000, 9000, 220)]
    awacs_units = unit_block(unit_skel, 9001, "FC-TRACE-AWACS-1", "E-3A",
                             awacs_route[0][0], awacs_route[0][1], 9000, 220, 0.0,
                             "Excellent", 901, 901)
    awacs_group = make_variant(player, 9001, "FC-TRACE-AWACS",
                               "                                    [1] = " + awacs_units.strip() + "\n",
                               awacs_route, "AWACS")

    bandit_route = [(PX, PZ + BANDIT_OFFSET, 9144.0, 250),
                    (PX, PZ + 20000, 9144.0, 250)]
    b1 = unit_block(unit_skel, 9002, "FC-TRACE-BANDIT-1", "MiG-29A",
                    PX - BANDIT_SEP / 2, PZ + BANDIT_OFFSET, 9144.0, 250,
                    4.7123889804, "Excellent", 902, 902)
    b2 = unit_block(unit_skel, 9003, "FC-TRACE-BANDIT-2", "MiG-29A",
                    PX + BANDIT_SEP / 2, PZ + BANDIT_OFFSET, 9144.0,
                    250, 4.7123889804, "Excellent", 903, 903)
    bandit_group = make_variant(player, 9002, "FC-TRACE-BANDITS",
                                "                                    [1] = " + b1.strip() + "\n"
                                "                                    [2] = " + b2.strip() + "\n",
                                bandit_route, "CAP")

    # strip player-specific payload/livery/properties from non-player variants:
    # AIM-120 pylons and an F-16 livery are invalid on an E-3A / MiG-29A.
    def sanitize_variant(g):
        p0 = g.find('["pylons"]')
        pb = g.find("{", g.find("= ", p0))
        pe = scan_block(g, pb)
        g = g[:p0] + '["pylons"] = {}' + g[pe:]
        g = re.sub(r'\["livery_id"\] = "[^"]*",\s*', '', g)
        a0 = g.find('["AddPropAircraft"]')
        if a0 > 0:
            ab = g.find("{", g.find("= ", a0))
            ae = scan_block(g, ab)
            g = g[:a0] + '["AddPropAircraft"] = {}' + g[ae:]
        return g

    awacs_group = sanitize_variant(awacs_group)
    bandit_group = sanitize_variant(bandit_group)

    # --- 3. insert groups into the blue/red plane group lists
    def insert_into_group_list(mission_text, section_pos, group_text):
        # find '["group"] = {' after section_pos, then the last '},' before its close
        gpos = mission_text.find('["group"]', section_pos)
        bpos = mission_text.find("{", mission_text.find("= ", gpos))
        epos = scan_block(mission_text, bpos)
        body = mission_text[bpos + 1:epos - 1]
        # count TOP-LEVEL items only: nested arrays (units, route points,
        # pylons, radio channels) carry [N] keys too and would inflate the
        # index — a sparse index makes the group invisible to ipairs loaders.
        idxs = []
        i = 0
        n = len(body)
        while i < n:
            mm = re.compile(r'\[(\d+)\] = \{').search(body, i)
            if not mm:
                break
            bend = scan_block(body, mm.end() - 1)
            idxs.append(int(mm.group(1)))
            i = bend
        next_idx = max(idxs) + 1 if idxs else 1
        g = group_text.strip()
        g = re.sub(r'^\[\d+\]\s*=\s*', '', g)  # strip the skeleton's own "[N] ="
        insert = '\n                                [%d] = %s' % (next_idx, g)
        return mission_text[:epos - 1] + insert + '\n                        ' + mission_text[epos - 1:], next_idx

    blue_plane = mission.find('["plane"]', mission.find('["blue"]'))
    mission, _ = insert_into_group_list(mission, blue_plane, awacs_group)
    # ["red"] first occurs in the coalitions side-list; the country detail
    # table lives after ["coalition"] — anchor there before looking for red.
    coalition_detail = mission.find('["coalition"]')
    red_detail = mission.find('["red"]', coalition_detail)
    red_plane = mission.find('["plane"]', red_detail)
    mission, _ = insert_into_group_list(mission, red_plane, bandit_group)

    # --- 4. write the miz
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    if os.path.exists(OUT):
        os.remove(OUT)
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("mission", mission)
        for n, data in others.items():
            z.writestr(n, data)
    print("built:", OUT)
    if install:
        dest = os.path.join(install, "Missions", "AESA-FC-Trace-Caucasus.miz")
        if os.path.exists(dest):
            os.remove(dest)
        import shutil
        shutil.copyfile(OUT, dest)
        print("installed:", dest)


if __name__ == "__main__":
    main()

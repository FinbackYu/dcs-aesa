#!/usr/bin/env python3
"""Summarize an fc_probe trace log (Logs/AESA/fc_trace.log).

Groups by hook tag, prints call counts, and reconstructs the launch
sequence: TRACK_*/SET_TARGET/ASSIGN_AUTO events in time order with the
runtime class names captured from RTTI. Datalink messages (RECV_DL /
RECV_NET / SEND_DL) are summarized by first-word pattern rather than
dumped raw.

Usage: python tools/fc_trace_report.py [path-to-fc_trace.log]
"""
import os
import re
import sys
from collections import Counter, defaultdict

DEFAULT = os.path.expandvars(
    r"%USERPROFILE%\Saved Games\DCS\Logs\AESA\fc_trace.log")

LINE = re.compile(r"^\[(\d+:\d+:\d+\.\d+) t(\d+)\] (.*)$")


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT
    if not os.path.exists(path):
        print("no trace log at", path)
        return 1
    counts = Counter()
    launches = []
    instances = defaultdict(set)
    first_last = {}
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            m = LINE.match(line)
            if not m:
                continue
            ts, tid, body = m.groups()
            tag = body.split()[0] if body.split() else ""
            counts[tag] += 1
            if tag not in first_last:
                first_last[tag] = [ts, ts]
            first_last[tag][1] = ts
            inst = re.search(r"this=(0x[0-9a-f]+) \(([^)]+)\)", body)
            if inst:
                instances[tag].add(inst.group(1) + " " + inst.group(2))
            if tag in ("TRACK_WS", "TRACK_LAUNCHER", "SET_TARGET", "ASSIGN_AUTO",
                       "ASSIGN_TP", "SYNC_TP", "INTERM_TP"):
                launches.append((ts, tag, body[:220]))
    print("== call counts (tag: total, window) ==")
    for tag, n in counts.most_common():
        w = first_last.get(tag, ["?", "?"])
        print(f"  {tag:16s} {n:6d}   {w[0]} .. {w[1]}")
    print("\n== distinct 'this' instances per tag (first 6) ==")
    for tag, s in instances.items():
        for x in sorted(s)[:6]:
            print(f"  {tag:16s} {x}")
        if len(s) > 6:
            print(f"  {tag:16s} ... +{len(s)-6} more")
    print("\n== launch sequence (fire-control events in order) ==")
    for ts, tag, body in launches[:400]:
        print(f"  {ts} {body}")
    if len(launches) > 400:
        print(f"  ... +{len(launches)-400} more")
    msl_report(os.path.dirname(os.path.abspath(path)))
    return 0


def msl_report(log_dir):
    """Analyze the Lua-side trajectory log (fc_msl_pos.log) written by the
    hook bridge: SHOT/HIT events plus per-weapon bearing/closest-approach
    vs the trace bandits. This is the P3-3 steering evidence."""
    path = os.path.join(log_dir, "fc_msl_pos.log")
    if not os.path.exists(path):
        print("\n(no fc_msl_pos.log yet — Lua-side recorder produced nothing)")
        return
    shots, hits = [], []
    evts = []
    msl = defaultdict(list)   # wid -> [(t,x,y,z)]
    tgt = defaultdict(dict)   # name -> {t:(x,y,z)}
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            p = line.strip().split(",")
            if p[0] == "SHOT" and len(p) >= 5:
                shots.append(p)
            elif p[0] == "HIT" and len(p) >= 5:
                hits.append(p)
            elif p[0] == "EVT" and len(p) >= 3:
                evts.append(p)
            elif p[0] == "MSL" and len(p) >= 6:
                msl[p[2]].append(tuple(float(v) for v in (p[1], p[3], p[4], p[5])))
            elif p[0] == "TGT" and len(p) >= 6:
                tgt[p[2]][float(p[1])] = tuple(float(v) for v in (p[3], p[4], p[5]))
    print("\n== fc_msl_pos.log: weapon events ==")
    if evts:
        ids = Counter(e[2] for e in evts)
        print("  raw event ids seen:", dict(ids))
    for p in shots:
        print(f"  SHOT t={p[1]:>8s} initiator={p[2]:<28s} wid={p[3]:<10s} {p[4]}")
    for p in hits:
        print(f"  HIT  t={p[1]:>8s} initiator={p[2]:<28s} target={p[3]}")

    def nearest(series, t):
        if not series:
            return None
        return series[min(series, key=lambda k: abs(k - t))]

    print("\n== per-weapon trajectory vs bandits ==")
    for wid, pts in msl.items():
        pts.sort()
        t0, t1 = pts[0][0], pts[-1][0]
        alts = [p[2] for p in pts]
        print(f"  wid={wid}: {len(pts)} samples, t {t0:.1f}..{t1:.1f}, "
              f"alt {min(alts):.0f}..{max(alts):.0f} m")
        for nm, series in sorted(tgt.items()):
            if nm == "SHOOTER":
                continue
            best = None
            for t, x, y, z in pts:
                ref = nearest(series, t)
                if ref is None:
                    continue
                d = ((x - ref[0]) ** 2 + (z - ref[2]) ** 2) ** 0.5
                if best is None or d < best[1]:
                    best = (t, d)
            if best:
                print(f"    closest approach to {nm}: {best[1]:8.0f} m @ t={best[0]:.1f}")
        # steering check: horizontal bearing wid->each bandit at first/last sample
        for label, pt in (("first", pts[0]), ("last", pts[-1])):
            out = []
            for nm, series in sorted(tgt.items()):
                if nm == "SHOOTER":
                    continue
                ref = nearest(series, pt[0])
                if ref is None:
                    continue
                import math
                brg = math.degrees(math.atan2(ref[2] - pt[3], ref[0] - pt[1])) % 360
                d = ((pt[1] - ref[0]) ** 2 + (pt[3] - ref[2]) ** 2) ** 0.5
                out.append(f"{nm}: brg {brg:5.1f}° {d / 1000:6.1f} km")
            print(f"    {label:5s} sample t={pt[0]:.1f}: " + "; ".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())

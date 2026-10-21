# -*- coding: utf-8 -*-
"""aesa 回放：录制文件 → 核心 → 确认航迹 + 引擎雷达对照报告。

用法：
    python tools/replay.py <flight.aesarec> [--dt 0.05] [--seed 42]
"""
import math
import os
import sys

import ingest
import lua_host
import truth

TOOLS = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(TOOLS)


def track_list(tracks):
    """Track IDs are a map: removals leave holes; Lua # is not a map length."""
    return [track for _, track in sorted(tracks.items())]


def _nearest_rank(values, fraction):
    """Nearest-rank percentile; deterministic and independent of interpolation."""
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, int(math.ceil(fraction * len(ordered))) - 1))
    return ordered[index]


def jump_stats(updates, step):
    """Position jump between consecutive confirmed-track updates.

    updates is a sequence of (track_id, last_update, x, y, z) sampled once per
    core step. A step with no update leaves last_update unchanged. Gaps longer
    than one far-track revisit (1 s; the scheduler's track_far_hz is 1 Hz) are
    treated as a lost/reacquired segment and excluded. step keeps the caller's
    time base explicit for the adjacent-update case.
    """
    previous = {}
    jumps = []
    implied = []
    regaps = 0
    gap_limit = max(1.0, 1.5 * step)
    for track_id, last_update, x, y, z in updates:
        old = previous.get(track_id)
        if old is not None:
            gap = last_update - old[0]
            if gap > gap_limit + 1e-9:
                regaps += 1
            elif gap > 1e-9:
                distance = math.sqrt((x - old[1]) ** 2 + (y - old[2]) ** 2
                                     + (z - old[3]) ** 2)
                jumps.append(distance)
                implied.append(distance / gap)
        previous[track_id] = (last_update, x, y, z)
    if not jumps:
        return {"samples": 0, "regaps_excluded": regaps, "p95_m": None, "max_m": None,
                "max_implied_speed_mps": None}
    return {
        "samples": len(jumps),
        "regaps_excluded": regaps,
        "p95_m": round(_nearest_rank(jumps, 0.95), 3),
        "max_m": round(max(jumps), 3),
        "max_implied_speed_mps": round(max(implied), 1),
    }


def _build_truth(host, frames, proto, rcs):
    opts = host.T({"legacy_heading": truth.legacy_for(proto)})
    opts["rcs"] = rcs
    opts["frame"] = host.mod("frame")
    return host.mod("truth_replay").new(truth.to_lua_frames(host, frames), opts)


def run(rec_path, dt=0.05, seed=42, quiet=False):
    sessions = [s for s in ingest.load_sessions(rec_path) if len(s.frames) >= 2]
    if not sessions:
        print("录制为空")
        return None
    # 取时间跨度最大的会话（混入的调试碎帧自动排除）
    session = max(sessions, key=lambda s: s.frames[-1]["t"] - s.frames[0]["t"])
    frames, engine, probe, proto = session
    if not quiet:
        print("录制: %d 个会话，采用最大段: %d 帧, %.1fs, 引擎接触 %d 条%s"
              % (len(sessions), len(frames), frames[-1]["t"] - frames[0]["t"],
                 len(engine), ("，探针: " + probe) if probe else ""))

    host = lua_host.Host()
    aesa = host.build()
    truth_src = _build_truth(host, frames, proto, host.dcs_rcs())
    sink = host.counting_sink()
    core = aesa.new(truth_src, host.mod("rcs").passthrough(), sink, seed)

    t0, t1 = frames[0]["t"], frames[-1]["t"]
    n = max(1, int(math.ceil((t1 - t0) / dt)))
    step = (t1 - t0) / n
    confirmed_updates = []
    for _ in range(n):
        host.call(core, "step", step)
        for trk in track_list(core["trk"]["tracks"]):
            if trk["confirmed"]:
                pos = trk["pos"]
                confirmed_updates.append((trk["id"], trk["last_update"],
                                          pos["x"], pos["y"], pos["z"]))
    jumps = jump_stats(confirmed_updates, step)

    # 汇总（counting sink 只保留驻留数与检测计数，避免长录制占用 GB 级内存）
    dw = int(sink["dwells"])
    tracks = track_list(core["trk"]["tracks"])
    ours = {k: int(v) for k, v in sink["counts"].items()}
    eng = {}
    for e in engine:
        eng[e["id"]] = eng.get(e["id"], 0) + 1

    if not quiet:
        print("核心: %d 步, %d 驻留, %d 条航迹（%d 确认）"
              % (n, dw, len(tracks), sum(1 for t in tracks if t["confirmed"])))
        if jumps["samples"]:
            print("跳变: %d 次更新（排除重捕 %d）, p95=%.3fm max=%.3fm max隐含速度=%.0fm/s"
                  % (jumps["samples"], jumps["regaps_excluded"],
                     jumps["p95_m"], jumps["max_m"], jumps["max_implied_speed_mps"]))
        else:
            print("跳变: 无相邻步更新样本（排除重捕 %d）" % jumps["regaps_excluded"])
        print("%-12s %-14s %-10s %s" % ("目标id", "我方检测次数", "引擎接触", "备注"))
        ids = sorted(set(list(ours.keys()) + list(eng.keys())))
        for tid in ids:
            print("%-12s %-14d %-10d" % (tid, ours.get(tid, 0), eng.get(tid, 0)))
        for t in tracks:
            print("  航迹 #%s az=%+.1f° el=%+.1f° R=%.1fkm vr=%+.0fm/s 确认=%s 命中=%d"
                  % (t["id"], math.degrees(t["az"]), math.degrees(t["el"]),
                     t["R"] / 1000.0, t["vr"], t["confirmed"], t["hits"]))
    return {"frames": frames, "engine": engine, "core": core,
            "dwells": dw, "tracks": tracks, "ours": ours, "eng": eng,
            "proto": proto, "legacy_heading": truth.legacy_for(proto),
            "jumps": jumps}


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return 2
    rec = args[0]
    dt, seed = 0.05, 42
    i = 1
    while i < len(args):
        if args[i] == "--dt":
            i += 1
            dt = float(args[i])
        elif args[i] == "--seed":
            i += 1
            seed = int(args[i])
        i += 1
    run(rec, dt, seed)
    return 0


if __name__ == "__main__":
    sys.exit(main())

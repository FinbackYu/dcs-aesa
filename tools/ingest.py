# -*- coding: utf-8 -*-
"""aesa 采集数据摄入：录制文件 → 会话/帧；流式速度差分修补。

只做文件/数据整理，不碰 Lua、不碰 HTTP。
"""
import collections

from protocol import FrameBuffer

Session = collections.namedtuple("Session", "frames engine probe proto")


class VelocityPatcher:
    """流式速度修补 helper（receiver/live 共用）。

    valid=True 时信任导出速度（含真实 0 m/s）；valid 缺失/False 且速度全零时
    用相邻帧位置差分估计。差分结果不会把 vel_valid 改回 True。
    """

    def __init__(self):
        self._hist = {}  # key -> (t, pos)

    def patch(self, key, t, pos, vel, valid=None):
        vel = tuple(float(x) for x in vel)
        if valid is not True and not any(abs(x) > 1e-6 for x in vel):
            prev = self._hist.get(key)
            if prev is not None and t - prev[0] > 1e-6:
                dt = t - prev[0]
                vel = tuple((pos[i] - prev[1][i]) / dt for i in range(3))
        self._hist[key] = (t, pos)
        return vel


def _est_vel(seq):
    """速度全零但位置在动的对象：邻帧差分估计速度。seq=[(t,pos,vel,valid)]"""
    for i, (t, p, v, valid) in enumerate(seq):
        if valid is True:
            continue
        if any(abs(x) > 1e-6 for x in v):
            continue
        if i > 0:
            t0, p0, _, _ = seq[i - 1]
            if t - t0 > 1e-6:
                seq[i] = (t, p, ((p[0] - p0[0]) / (t - t0),
                                 (p[1] - p0[1]) / (t - t0),
                                 (p[2] - p0[2]) / (t - t0)), valid)
        elif len(seq) > 1:
            t1, p1, _, _ = seq[i + 1]
            if t1 - t > 1e-6:
                seq[i] = (t, p, ((p1[0] - p[0]) / (t1 - t),
                                 (p1[1] - p[1]) / (t1 - t),
                                 (p1[2] - p[2]) / (t1 - t)), valid)


def estimate_velocities(frames):
    """录制后处理：修补缺失速度（本机 + 各目标）。"""
    if not frames:
        return
    own_seq = [(f["t"], f["own"]["pos"], f["own"]["vel"],
                f["own"].get("vel_valid")) for f in frames]
    _est_vel(own_seq)
    for f, s in zip(frames, own_seq):
        f["own"]["vel"] = s[2]
    byid = {}
    for f in frames:
        for tg in f["targets"]:
            byid.setdefault(tg["id"], []).append(
                (f["t"], tg["pos"], tg["vel"], tg.get("vel_valid")))
    for seq in byid.values():
        _est_vel(seq)
    idx = {tid: 0 for tid in byid}
    for f in frames:
        for tg in f["targets"]:
            i = idx[tg["id"]]
            tg["vel"] = byid[tg["id"]][i][2]
            idx[tg["id"]] = i + 1
    return frames


def load_recording(path):
    """录制文件 → (frames, engine_contacts, probe_text, proto)。"""
    buf = FrameBuffer()
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                buf.feed(line)
    frames = buf.finish()
    estimate_velocities(frames)
    return frames, buf.engine, buf.probe, buf.proto


def load_compat(path):
    """录制文件 → 最后一条有效 COMPAT 握手（摘要用）；没有则 None。"""
    compat = None
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line.startswith("COMPAT,"):
                from protocol import parse_line
                parsed = parse_line(line)
                if parsed:
                    compat = parsed[1]
    return compat


def load_sessions(path):
    """按 V1 握手行切分会话（一次任务 = 一个连接 = 一个 V1）。
    返回 [Session(frames, engine, probe, proto)]；用于混有多次飞行的录制文件。"""
    with open(path, "r", encoding="utf-8") as f:
        raw = [ln.strip() for ln in f if ln.strip()]
    sessions, buf = [], None
    for line in raw:
        if line == "V1" or line.startswith("V1 "):
            if buf is not None:
                sessions.append(buf)
            buf = FrameBuffer()
            continue
        if buf is None:
            buf = FrameBuffer()
        buf.feed(line)
    if buf is not None:
        sessions.append(buf)
    out = []
    for b in sessions:
        frames = b.finish()
        estimate_velocities(frames)
        out.append(Session(frames, b.engine, b.probe, b.proto))
    return out

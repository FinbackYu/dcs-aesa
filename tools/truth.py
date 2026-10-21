# -*- coding: utf-8 -*-
"""aesa 真值帧打包：Python 采集帧 → Lua 适配器输入（原始 DCS 轴）。

坐标/姿态转换不在这里做：truth_replay 通过 src/adapters/dcs/frame.lua 统一转换。
PROTO,2 之前的历史录制，其 O 行航向为 Heading + π/2，由 truth_replay 的
legacy_heading 选项修正。
"""


def legacy_for(proto):
    return proto is None or int(proto) < 2


def v3(value):
    return {"x": value[0], "y": value[1], "z": value[2]}


def to_lua_frame(host, frame, tn):
    tgs = []
    for tg in frame["targets"]:
        row = {"id": tg["id"], "typeName": tg["typeName"],
               "coalition": tg["coalition"],
               "pos": v3(tg["pos"]), "vel": v3(tg["vel"])}
        if "visible" in tg:
            row["visible"] = tg["visible"]
        tgs.append(row)
    own = {"typeName": frame["own"]["typeName"],
           "pos": v3(frame["own"]["pos"]), "vel": v3(frame["own"]["vel"])}
    for key in ("heading", "pitch", "roll"):
        if key in frame["own"]:
            own[key] = frame["own"][key]
    return host.T({"t": tn, "own": own, "targets": host.T(tgs)})


def to_lua_frames(host, frames):
    """录制帧列表 → Lua 帧数组（时间归一化到首帧 t0=0）。

    若录制从任务中段开始（接收器中途重启/断线重连），绝对时间会让
    truth_replay 整段 clamp 在首帧。
    """
    if not frames:
        return host.TL([])
    t0 = frames[0]["t"]
    return host.TL([to_lua_frame(host, f, f["t"] - t0) for f in frames])

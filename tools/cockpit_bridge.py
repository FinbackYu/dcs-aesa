# -*- coding: utf-8 -*-
"""C1.5a 座舱状态桥：核心 snapshot DTO → AESA-COCKPIT state.txt 映射 + 原子写 + 限频。

协议（行式 key=value，详见 docs/design-cockpit-page.md §6.1）：
    AESA1 / seq / valid / mode / range / az / bars / prf / alt / scan /
    beam / beam_el / own / hz / track=serial,az,range_nm,vc,alt_ft,status[,hdg] / extra
除 AESA1/seq/valid 外全部可选；未知键被旧解析方（controller.lua、
cockpit_preview.html、cockpit_bridge_stub.cjs 产物）忽略，向后兼容。

纯 stdlib、无 lupa/DCS 依赖：live.py 主线程把已转好的 Python snapshot
dict 传进来，本模块只做格式化与文件写出。单位换算（m→NM、m/s→kt、
m→ft）按 §6.1 契约在此收口，页面不再换算物理量。
"""
import math
import os
import sys
import time
from collections import deque

M_PER_NM = 1852.0          # 海里定义（精确）
MPS_TO_KT = 1.94384        # m/s → 节
M_TO_FT = 3.28084          # m → ft
RANGE_STEPS_NM = (10, 20, 40, 80, 160)   # 显示量程自动档
DEFAULT_RANGE_NM = 40      # 无航迹时的默认量程
MAX_TRACKS = 8             # 协议槽位上限（controller 固定 8 槽）
VALID_MAX_FRAME_AGE_S = 1.0  # valid 判定：最近 1 s 内有帧
WRITE_HZ = 10.0            # 写出目标频率（座舱侧靠 seq 判活，须恒定节奏）


def _round_int(value):
    """四舍五入到整数（远离零方向处理 .5），None 原样返回。"""
    if value is None:
        return None
    if value >= 0:
        return int(math.floor(value + 0.5))
    return -int(math.floor(-value + 0.5))


def _heading_deg(ve_mps, vn_mps):
    """由 ENU 速度矢量求航向：atan2(东, 北)，归一 [0, 360)。"""
    if ve_mps is None or vn_mps is None:
        return None
    deg = math.degrees(math.atan2(ve_mps, vn_mps)) % 360.0
    result = _round_int(deg)
    return 0 if result == 360 else result


def _display_range_nm(tracks):
    """显示量程自动档：能装下最远航迹的最小档；无航迹默认 40 NM。"""
    farthest = 0.0
    for track in tracks:
        rng = track.get("range_m")
        if rng is None:
            continue
        farthest = max(farthest, rng / M_PER_NM)
    if farthest <= 0.0:
        return DEFAULT_RANGE_NM
    for step in RANGE_STEPS_NM:
        if farthest <= step:
            return step
    return RANGE_STEPS_NM[-1]


def _sort_key(track):
    """STT > confirmed > 距离近优先；id 字典序兜底保证确定性。"""
    rng = track.get("range_m")
    return (0 if track.get("stt") else 1,
            0 if track.get("confirmed") else 1,
            rng if rng is not None else math.inf,
            str(track.get("id")))


def _derive_mode(tracks):
    # 派生显示语义（核心没有独立的“模式”概念）：有 STT 航迹 → STT，
    # 有 confirmed → TWS，否则 RWS。核心 DTO 暂无 STT 锁标志，stt 字段
    # 为预留（当前只会出现 TWS/RWS）。
    if any(t.get("stt") for t in tracks):
        return "STT"
    if any(t.get("confirmed") for t in tracks):
        return "TWS"
    return "RWS"


def _track_status(track):
    # 核心 DTO 暂无 STT 标志：confirmed → TRACK，否则 SEARCH；STT 为预留分支。
    if track.get("stt"):
        return "STT"
    return "TRACK" if track.get("confirmed") else "SEARCH"


def _format_track(serial, track):
    az = _round_int(track.get("az_deg"))
    rng_m = track.get("range_m")
    rng_nm = _round_int(rng_m / M_PER_NM) if rng_m is not None else 0
    vr = track.get("vr_mps")  # 核心约定：vr = v_close，正 = 接近（detection.lua）
    vc_kt = _round_int(vr * MPS_TO_KT) if vr is not None else 0
    up_m = track.get("up_m")
    alt_ft = _round_int(up_m * M_TO_FT) if up_m is not None else 0
    fields = ["%02d" % serial, str(az if az is not None else 0), str(rng_nm),
              str(vc_kt), str(alt_ft), _track_status(track)]
    hdg = _heading_deg(track.get("ve_mps"), track.get("vn_mps"))
    if hdg is not None:
        fields.append(str(hdg))  # 第 7 字段可选：速度矢量缺失时保持旧 6 段格式
    return "track=" + ",".join(fields)


def snapshot_to_state(snap, link, seq, hz=None):
    """snapshot DTO + 链路状态 → state.txt 文本。纯函数，不写文件。

    snap：LiveCore.snapshot() 的 Python dict（可为 None，按空处理）。
    link：至少含 connected(bool) 与 frame_age_s(秒, 可 None)。
    seq：本次写出序号。hz：实测写出频率（缺省取 link["hz"] 或 0）。
    """
    snap = snap or {}
    link = link or {}
    if hz is None:
        hz = float(link.get("hz") or 0.0)
    tracks = [t for t in (snap.get("tracks") or []) if isinstance(t, dict)]
    tracks.sort(key=_sort_key)
    beam = snap.get("beam") or {}
    own = snap.get("own") or {}
    cfg = snap.get("cfg") or {}

    connected = bool(link.get("connected"))
    frame_age = link.get("frame_age_s")
    valid = connected and frame_age is not None and frame_age <= VALID_MAX_FRAME_AGE_S

    az_span = cfg.get("az_span_deg")
    az = _round_int(az_span / 2) if az_span is not None else 60
    el_bars = cfg.get("el_bars_deg")
    bars = len(el_bars) if isinstance(el_bars, (list, tuple)) else 4
    prf = beam.get("prf") or "HI"
    alt_m = own.get("alt_m")
    alt = str(_round_int(alt_m * M_TO_FT / 1000.0)) if alt_m is not None else "---"

    lines = [
        "AESA1",
        "seq=%d" % seq,
        "valid=%d" % (1 if valid else 0),
        "mode=%s" % _derive_mode(tracks),
        "range=%d" % _display_range_nm(tracks),
        "az=%d" % az,
        "bars=%d" % bars,
        "prf=%s" % prf,
        "alt=%s" % alt,
        "scan=AUTO",  # 扫描程序暂无外部控制，固定 AUTO（C2 接 HOTAS 后才有实义）
        "beam=%d" % (_round_int(beam.get("az_deg")) or 0),
        "beam_el=%d" % (_round_int(beam.get("el_deg")) or 0),
    ]
    attitude = [own.get("heading_deg"), own.get("pitch_deg"), own.get("roll_deg")]
    if any(v is not None for v in attitude):
        rendered = []
        for index, value in enumerate(attitude):
            if value is None:
                rendered.append("---")
                continue
            if index == 0:
                value = value % 360.0  # 核心航向是弧度直转（可负），桥内归一 [0,360)
            rounded = _round_int(value)
            rendered.append(str(0 if rounded == 360 else rounded))
        lines.append("own=" + ",".join(rendered))
    lines.append("hz=%.1f" % hz)
    for serial, track in enumerate(tracks[:MAX_TRACKS], 1):
        lines.append(_format_track(serial, track))
    if len(tracks) > MAX_TRACKS:
        lines.append("extra=%d" % (len(tracks) - MAX_TRACKS))
    return "\n".join(lines) + "\n"


class StateWriter:
    """state.txt 原子写（tmp + rename，同 cockpit_bridge_stub.cjs）+ 限频。

    maybe_write() 每次循环都调用：距上次写出不足 1/WRITE_HZ 秒则跳过；
    写出即递增 seq（数据不变也递增——座舱侧靠 seq 判活）。"""

    def __init__(self, path, hz=WRITE_HZ):
        self.path = path
        self.interval = 1.0 / hz
        self.seq = 0
        self.measured_hz = 0.0
        self._last_write = None
        self._write_times = deque(maxlen=11)
        directory = os.path.dirname(os.path.abspath(path))
        if directory:
            os.makedirs(directory, exist_ok=True)

    def maybe_write(self, snap, link, now=None):
        """到点则原子写出并返回 True；限频跳过或写失败返回 False。"""
        now = time.monotonic() if now is None else now
        if (self._last_write is not None
                and now - self._last_write < self.interval):
            return False
        text = snapshot_to_state(snap, link, self.seq + 1, hz=self.measured_hz)
        tmp = "%s.tmp-%d" % (self.path, os.getpid())
        try:
            with open(tmp, "w", encoding="utf-8", newline="\n") as handle:
                handle.write(text)
            # os.replace 在 Windows 上目标被读方（CRT open 无 delete 共享）瞬时
            # 占用时会 WinError 5；短重试吸收这类碰撞（controller 每 0.1 s 读一次）。
            for attempt in range(3):
                try:
                    os.replace(tmp, self.path)
                    break
                except OSError:
                    if attempt == 2:
                        raise
                    time.sleep(0.005)
        except OSError as error:
            print("cockpit state write failed: %s" % error, file=sys.stderr)
            try:
                os.unlink(tmp)
            except OSError:
                pass
            return False
        self.seq += 1
        self._last_write = now
        self._write_times.append(now)
        if len(self._write_times) >= 2:
            span = self._write_times[-1] - self._write_times[0]
            if span > 0:
                self.measured_hz = (len(self._write_times) - 1) / span
        return True

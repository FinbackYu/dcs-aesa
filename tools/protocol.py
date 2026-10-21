# -*- coding: utf-8 -*-
"""aesa A/A 行协议 V1：解析 Export 采样流（纯解析，不做文件/网络 IO）。

行：
  V1 | PROTO,2 | COMPAT,<profile_id>,<matrix_hash> | P <探针>
  A 本机 | T 单位 | O 姿态 | L 地形可见性 | E 引擎雷达接触
Gate 1 起 A/T 行尾追加 vel_valid（0/1）；旧行缺失时按 False 解析。
PROTO,2 表示 O 行与坐标是原始 DCS 值；缺失按 V1 旧约定（航向 +π/2）。
未知行一律忽略，不中断接收。
"""


def _coalition(token):
    """CoalitionID token → 0/1/2；缺失/非法收敛为协议允许的 "unknown"。"""
    if token == "unknown":
        return "unknown"
    try:
        value = float(token)
    except ValueError:
        return "unknown"
    if value.is_integer() and int(value) in (0, 1, 2):
        return int(value)
    return "unknown"


def _velocity_valid(token):
    """尾字段 vel_valid：只接受 0/1；其它值按已知行格式错误拒绝。"""
    if token not in ("0", "1"):
        raise ValueError("bad vel_valid: %r" % token)
    return token == "1"


def parse_line(line):
    """一行 → (kind, fields)；无法解析返回 None。"""
    line = line.strip()
    if line.startswith("COMPAT,"):
        fields = line.split(",")
        if (len(fields) == 3 and fields[1] and fields[2]
                and not any(ch.isspace() for ch in fields[1] + fields[2])):
            return "COMPAT", {"profile_id": fields[1], "matrix_hash": fields[2],
                              "text": fields[1] + "," + fields[2]}
        return None
    if line.startswith("PROTO,"):
        fields = line.split(",")
        if len(fields) == 2 and fields[1].isdigit():
            return "PROTO", {"version": int(fields[1]), "text": fields[1]}
        return None
    parts = line.split()
    if not parts:
        return None
    kind = parts[0]
    try:
        if kind == "A" and len(parts) in (9, 10):
            return kind, {
                "t": float(parts[1]), "typeName": parts[2],
                "pos": (float(parts[3]), float(parts[4]), float(parts[5])),
                "vel": (float(parts[6]), float(parts[7]), float(parts[8])),
                "vel_valid": _velocity_valid(parts[9]) if len(parts) == 10 else False,
            }
        if kind == "T" and len(parts) in (11, 12):
            return kind, {
                "t": float(parts[1]), "id": parts[2], "typeName": parts[3],
                "coalition": _coalition(parts[4]),
                "pos": (float(parts[5]), float(parts[6]), float(parts[7])),
                "vel": (float(parts[8]), float(parts[9]), float(parts[10])),
                "vel_valid": _velocity_valid(parts[11]) if len(parts) == 12 else False,
            }
        if kind == "E" and len(parts) in (7, 10):
            base = 5 if len(parts) == 10 else 2
            return kind, {
                "t": float(parts[1]), "id": parts[2],
                "pos": (float(parts[3]), float(parts[4]), float(parts[5])) if len(parts) == 10 else None,
                "R": float(parts[base + 1]), "vclose": float(parts[base + 2]),
                "rcs": float(parts[base + 3]), "flags": int(float(parts[base + 4])),
            }
        if kind == "O" and len(parts) == 5:
            return kind, {"t": float(parts[1]), "heading": float(parts[2]),
                          "pitch": float(parts[3]), "roll": float(parts[4])}
        if kind == "L" and len(parts) == 4 and parts[3] in ("0", "1"):
            return kind, {"t": float(parts[1]), "id": parts[2], "visible": parts[3] == "1"}
        if kind in ("V1", "P"):
            return kind, {"text": line[2:].strip()}
    except ValueError:
        return None
    return None


class FrameBuffer:
    """行 → 帧分组（新 A 行开新帧）；同时记录会话级 PROTO/COMPAT/探针。

    ``retain=False`` is the streaming mode used by the recording receiver: it
    keeps only the current/last frame and counters, so a 30-minute recording
    does not retain every frame and target dictionary until disconnect.
    """

    def __init__(self, retain=True):
        self.retain = retain
        self.frames = []      # {t, own, targets[]}
        self.engine = []      # 引擎雷达接触（E 行）
        self.frame_count = 0
        self.engine_count = 0
        self.last_frame = None
        self.probe = None
        self.compat = None    # 最近一条 COMPAT 握手（profile_id + matrix_hash）
        self.proto = None     # 坐标/姿态协议版本（2 = 原始 DCS 值）
        self._cur = None

    def feed(self, line):
        parsed = parse_line(line)
        if not parsed:
            return
        kind, f = parsed
        if kind == "COMPAT":
            self.compat = f
        elif kind == "PROTO":
            self.proto = f["version"]
        elif kind == "P":
            self.probe = f["text"]
        elif kind == "A":
            self._flush()
            self._cur = {"t": f["t"],
                         "own": {"typeName": f["typeName"], "pos": f["pos"], "vel": f["vel"],
                                 "vel_valid": f["vel_valid"]},
                         "targets": []}
        elif kind == "T" and self._cur is not None and f["t"] == self._cur["t"]:
            self._cur["targets"].append({
                "id": f["id"], "typeName": f["typeName"], "coalition": f["coalition"],
                "pos": f["pos"], "vel": f["vel"], "vel_valid": f["vel_valid"]})
        elif kind == "O" and self._cur is not None and f["t"] == self._cur["t"]:
            self._cur["own"].update({k: f[k] for k in ("heading", "pitch", "roll")})
        elif kind == "L" and self._cur is not None and f["t"] == self._cur["t"]:
            for tg in self._cur["targets"]:
                if tg["id"] == f["id"]:
                    tg["visible"] = f["visible"]
                    break
        elif kind == "E":
            self.engine_count += 1
            if self.retain:
                self.engine.append(f)

    def _flush(self):
        if self._cur is not None:
            self.frame_count += 1
            self.last_frame = self._cur
            if self.retain:
                self.frames.append(self._cur)
            self._cur = None

    def finish(self):
        self._flush()
        return self.frames

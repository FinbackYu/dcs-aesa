# -*- coding: utf-8 -*-
"""C1.5a 座舱状态桥测试：snapshot → state.txt 映射、原子写/限频、--replay 集成。

映射与写出用例是纯 stdlib 确定性单测（手工构造 snapshot dict，断言逐行文本）。
集成用例用真实管线回放 recordings/flight3-final.aesarec 产出 state.txt 并解析
校验；录制缺失（recordings/ 为本机数据）或 lupa 不可用时按 AGENTS.md skip 规则
skipTest 并打印原因。
"""
import importlib.util
import os
import re
import socket
import subprocess
import sys
import tempfile
import time
import unittest

TESTS = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(TESTS)
TOOLS = os.path.join(REPO, "tools")
if TOOLS not in sys.path:
    sys.path.insert(0, TOOLS)

import cockpit_bridge  # noqa: E402

REPLAY_REC = os.path.join(REPO, "recordings", "flight3-final.aesarec")
LINK_OK = {"connected": True, "frame_age_s": 0.2}
CFG = {"az_span_deg": 120, "el_bars_deg": [-3.4, -1.1, 1.1, 3.4]}


def snap_of(tracks=(), beam=None, own=None, cfg=CFG):
    return {"tracks": list(tracks), "beam": beam, "own": own, "cfg": cfg}


def parse_state_text(text):
    """按 controller.lua read_state() 语义解析；结构非法返回 None。"""
    if not text or not text.startswith("AESA1\n"):
        return None
    state = {"tracks": []}
    for line in text.splitlines()[1:]:
        match = re.match(r"^([A-Za-z0-9_]+)=(.*)$", line)
        if not match:
            return None
        key, value = match.group(1), match.group(2)
        if key == "track":
            state["tracks"].append(value.split(","))
        else:
            state[key] = value
    if "seq" not in state or "valid" not in state:
        return None
    return state


class TestMapping(unittest.TestCase):
    def test_empty_snapshot_defaults(self):
        text = cockpit_bridge.snapshot_to_state(snap_of(), LINK_OK, 7, hz=10.0)
        self.assertEqual(text, "\n".join([
            "AESA1",
            "seq=7",
            "valid=1",
            "mode=RWS",
            "range=40",
            "az=60",
            "bars=4",
            "prf=HI",
            "alt=---",
            "scan=AUTO",
            "beam=0",
            "beam_el=0",
            "hz=10.0",
        ]) + "\n")

    def test_full_mapping_exact_text(self):
        tracks = [
            # 故意乱序：验证 STT > confirmed > 距离近的排序
            {"id": 9, "confirmed": False, "az_deg": 0.0, "range_m": 1852.0,
             "vr_mps": 0.0, "up_m": 304.8, "ve_mps": 0.0, "vn_mps": -50.0},
            {"id": 1, "confirmed": True, "az_deg": -12.6, "range_m": 9260.0,
             "vr_mps": -50.0, "up_m": 1524.0, "ve_mps": -100.0, "vn_mps": 0.0},
            {"id": 3, "confirmed": True, "stt": True, "az_deg": 5.4,
             "range_m": 18520.0, "vr_mps": 220.0, "up_m": 6096.0,
             "ve_mps": 100.0, "vn_mps": 0.0},
        ]
        beam = {"az_deg": -14.5, "el_deg": 3.5, "prf": "MED"}
        own = {"alt_m": 9144.0, "speed_ms": 200.0, "heading_deg": 269.5,
               "pitch_deg": -2.4, "roll_deg": 0.4}
        text = cockpit_bridge.snapshot_to_state(
            snap_of(tracks, beam, own), LINK_OK, 12, hz=9.6)
        self.assertEqual(text, "\n".join([
            "AESA1",
            "seq=12",
            "valid=1",
            "mode=STT",
            "range=10",      # 最远航迹 10.0 NM → 最小能装下的档
            "az=60",         # az_span_deg/2
            "bars=4",
            "prf=MED",
            "alt=30",        # 9144 m ≈ 30000 ft = 30 kft
            "scan=AUTO",
            "beam=-15",      # -14.5 远离零方向取整
            "beam_el=4",
            "own=270,-2,0",
            "hz=9.6",
            # 单位：m→NM(/1852)、m/s→kt(×1.94384)、m→ft(×3.28084)；hdg=atan2(ve,vn)
            "track=01,5,10,428,20000,STT,90",
            "track=02,-13,5,-97,5000,TRACK,270",
            "track=03,0,1,0,1000,SEARCH,180",
        ]) + "\n")

    def test_track_sorting_truncate_and_extra(self):
        tracks = [{"id": i, "confirmed": False, "az_deg": 0.0,
                   "range_m": 1852.0 * (11 - i),  # id 1 → 10 NM（最远）
                   "vr_mps": 0.0, "up_m": 0.0}
                  for i in range(1, 11)]
        text = cockpit_bridge.snapshot_to_state(snap_of(tracks), LINK_OK, 3, hz=10.0)
        lines = text.splitlines()
        track_lines = [l for l in lines if l.startswith("track=")]
        self.assertEqual(len(track_lines), 8)
        # 距离近优先：serial 01 是 1 NM 的 id=10；无速度矢量 → 保持旧 6 段格式
        self.assertEqual(track_lines[0], "track=01,0,1,0,0,SEARCH")
        self.assertEqual(track_lines[-1], "track=08,0,8,0,0,SEARCH")
        self.assertEqual(lines[-1], "extra=2")
        self.assertIn("mode=RWS", lines)   # 无 confirmed → RWS
        self.assertIn("range=10", lines)   # 最远 10 NM → 10 档

    def test_mode_derivation(self):
        search = {"id": 1, "confirmed": False, "range_m": 1852.0}
        confirmed = {"id": 2, "confirmed": True, "range_m": 1852.0}
        stt = {"id": 3, "confirmed": True, "stt": True, "range_m": 1852.0}
        self.assertIn("mode=RWS", cockpit_bridge.snapshot_to_state(
            snap_of([search]), LINK_OK, 1))
        self.assertIn("mode=TWS", cockpit_bridge.snapshot_to_state(
            snap_of([search, confirmed]), LINK_OK, 1))
        self.assertIn("mode=STT", cockpit_bridge.snapshot_to_state(
            snap_of([confirmed, stt]), LINK_OK, 1))

    def test_display_range_steps(self):
        cases = [(None, 40), (9.9, 10), (10.0, 10), (10.1, 20), (39.9, 40),
                 (40.1, 80), (79.9, 80), (80.1, 160), (170.0, 160)]
        for nm, expected in cases:
            tracks = [] if nm is None else [
                {"id": 1, "confirmed": True, "range_m": nm * 1852.0}]
            text = cockpit_bridge.snapshot_to_state(snap_of(tracks), LINK_OK, 1)
            self.assertIn("range=%d" % expected, text.splitlines(),
                          "farthest=%s NM" % nm)

    def test_valid_requires_connected_and_recent_frame(self):
        snap = snap_of()
        self.assertIn("valid=1", cockpit_bridge.snapshot_to_state(
            snap, {"connected": True, "frame_age_s": 0.9}, 1).splitlines())
        self.assertIn("valid=0", cockpit_bridge.snapshot_to_state(
            snap, {"connected": True, "frame_age_s": 2.0}, 1).splitlines())
        self.assertIn("valid=0", cockpit_bridge.snapshot_to_state(
            snap, {"connected": True, "frame_age_s": None}, 1).splitlines())
        self.assertIn("valid=0", cockpit_bridge.snapshot_to_state(
            snap, {"connected": False, "frame_age_s": 0.1}, 1).splitlines())

    def test_own_line_omitted_without_attitude(self):
        text = cockpit_bridge.snapshot_to_state(snap_of(own=None), LINK_OK, 1)
        self.assertNotIn("own=", text)
        self.assertIn("alt=---", text.splitlines())
        own = {"alt_m": 1000.0, "heading_deg": None, "pitch_deg": 5.0,
               "roll_deg": None}
        lines = cockpit_bridge.snapshot_to_state(
            snap_of(own=own), LINK_OK, 1).splitlines()
        self.assertIn("own=---,5,---", lines)
        self.assertIn("alt=3", lines)  # 1000 m ≈ 3.28 kft → 3

    def test_own_heading_normalized(self):
        # 核心航向是弧度直转可为负；桥内归一 [0,360)，359.6 取整回绕为 0
        own = {"alt_m": None, "heading_deg": -256.4, "pitch_deg": None,
               "roll_deg": None}
        lines = cockpit_bridge.snapshot_to_state(
            snap_of(own=own), LINK_OK, 1).splitlines()
        self.assertIn("own=104,---,---", lines)
        own["heading_deg"] = 359.6
        lines = cockpit_bridge.snapshot_to_state(
            snap_of(own=own), LINK_OK, 1).splitlines()
        self.assertIn("own=0,---,---", lines)

    def test_defaults_without_beam_and_cfg(self):
        lines = cockpit_bridge.snapshot_to_state(
            {"tracks": []}, LINK_OK, 1).splitlines()
        self.assertIn("beam=0", lines)
        self.assertIn("beam_el=0", lines)
        self.assertIn("prf=HI", lines)
        self.assertIn("az=60", lines)
        self.assertIn("bars=4", lines)


class TestWriter(unittest.TestCase):
    def test_atomic_write_seq_and_rate_limit(self):
        with tempfile.TemporaryDirectory() as td:
            path = os.path.join(td, "sub", "state.txt")
            writer = cockpit_bridge.StateWriter(path)
            self.assertTrue(writer.maybe_write({}, LINK_OK, now=1000.0))
            self.assertEqual(writer.seq, 1)
            # 限频：距上次写出不足 0.1 s 跳过，seq 不动、文件不变
            self.assertFalse(writer.maybe_write({}, LINK_OK, now=1000.05))
            self.assertEqual(writer.seq, 1)
            with open(path, encoding="utf-8") as handle:
                self.assertIn("seq=1", handle.read())
            # 到点写出：seq 递增；第三次写出时 hz=实测间隔频率 5.0
            self.assertTrue(writer.maybe_write({}, LINK_OK, now=1000.2))
            self.assertFalse(writer.maybe_write({}, LINK_OK, now=1000.25))
            self.assertTrue(writer.maybe_write({}, LINK_OK, now=1000.4))
            self.assertEqual(writer.seq, 3)
            with open(path, encoding="utf-8") as handle:
                text = handle.read()
            self.assertIn("seq=3", text)
            self.assertIn("hz=5.0", text)
            self.assertAlmostEqual(writer.measured_hz, 5.0, places=6)
            # 原子写：目录里只有 state.txt，无 .tmp- 残留
            self.assertEqual(os.listdir(os.path.dirname(path)), ["state.txt"])

    def test_seq_continuity_over_many_writes(self):
        with tempfile.TemporaryDirectory() as td:
            path = os.path.join(td, "state.txt")
            writer = cockpit_bridge.StateWriter(path)
            now = 2000.0
            for expected_seq in range(1, 16):
                self.assertTrue(writer.maybe_write({}, LINK_OK, now=now))
                self.assertEqual(writer.seq, expected_seq)
                now += 0.11
            with open(path, encoding="utf-8") as handle:
                self.assertIn("seq=15", handle.read())


class TestReplayIntegration(unittest.TestCase):
    @staticmethod
    def _field_errors(state):
        """对抓拍状态做全字段校验（与 controller 解析语义一致）；返回错误串或 None。"""
        if state["mode"] not in ("RWS", "TWS", "STT"):
            return "mode 非法: %r" % state["mode"]
        if state["range"] not in ("10", "20", "40", "80", "160"):
            return "range 非法: %r" % state["range"]
        if state.get("scan") != "AUTO":
            return "scan 非法: %r" % state.get("scan")
        try:
            for key in ("az", "bars", "beam", "beam_el"):
                int(state[key])
            float(state["hz"])
        except (KeyError, ValueError) as error:
            return "头字段非法: %s" % error
        if len(state["tracks"]) > 8:
            return "航迹超过 8 条"
        for fields in state["tracks"]:
            try:
                if len(fields) < 6 or not re.match(r"^\d{2}$", fields[0]):
                    raise ValueError("字段数/serial")
                for value in fields[:5]:
                    float(value)
                if fields[5].upper() not in ("SEARCH", "TRACK", "STT"):
                    raise ValueError("status")
                if len(fields) > 6:
                    float(fields[6])
                if "extra" in state:
                    int(state["extra"])
            except ValueError as error:
                return "track 非法（%s）: %r" % (error, ",".join(fields))
        return None

    def test_replay_writes_parseable_state(self):
        if not os.path.isfile(REPLAY_REC):
            print("skip: %s 不存在（recordings/ 为本机数据，不入库）" % REPLAY_REC)
            self.skipTest("recordings/flight3-final.aesarec 不存在")
        if importlib.util.find_spec("lupa") is None:
            print("skip: lupa 不可用（pip install lupa）")
            self.skipTest("lupa 不可用")

        def free_port():
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
                sock.bind(("127.0.0.1", 0))
                return sock.getsockname()[1]

        env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
        with tempfile.TemporaryDirectory() as td:
            state_path = os.path.join(td, "AESA-COCKPIT", "state.txt")
            proc = subprocess.Popen(
                [sys.executable, "-u", os.path.join(TOOLS, "live.py"),
                 "--replay", REPLAY_REC, "--speed", "0",
                 "--cockpit-state", state_path,
                 "--http", str(free_port()), "--port", str(free_port())],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                encoding="utf-8", errors="replace", env=env)
            seqs, valid_text, max_tracks, bad = [], None, 0, None
            try:
                deadline = time.time() + 90
                while time.time() < deadline:
                    if os.path.isfile(state_path):
                        try:
                            with open(state_path, encoding="utf-8") as handle:
                                text = handle.read()
                        except OSError:
                            text = ""
                        state = parse_state_text(text)
                        if state and (not seqs or int(state["seq"]) > seqs[-1]):
                            seqs.append(int(state["seq"]))
                            max_tracks = max(max_tracks, len(state["tracks"]))
                            if bad is None:
                                bad = self._field_errors(state)
                            if state["valid"] == "1" and valid_text is None:
                                valid_text = text
                        elif text and not state and bad is None:
                            bad = "无法解析: %r" % text[:120]
                    # 等三个条件齐：持续写出、抓到 valid=1、抓到带航迹的帧
                    if len(seqs) >= 8 and valid_text is not None and max_tracks >= 1:
                        break
                    time.sleep(0.1)
            finally:
                proc.terminate()
                try:
                    out, _ = proc.communicate(timeout=15)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    out, _ = proc.communicate()

            context = "live.py 输出尾部:\n%s" % "\n".join(
                (out or "").splitlines()[-8:])
            self.assertGreaterEqual(len(seqs), 8,
                                    "seq 未持续递增（~10 Hz 写出）。" + context)
            self.assertEqual(seqs, sorted(seqs))
            self.assertIsNone(bad, "状态帧校验失败。" + context)
            self.assertIsNotNone(valid_text,
                                 "回放喂帧期间未写出 valid=1 状态。" + context)
            self.assertGreaterEqual(max_tracks, 1,
                                    "整个回放期间状态里没有任何航迹。" + context)


if __name__ == "__main__":
    unittest.main(verbosity=2)

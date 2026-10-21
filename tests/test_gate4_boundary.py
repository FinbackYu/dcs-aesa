# -*- coding: utf-8 -*-
"""Gate 4 边界回归：ENU 帧、DCS 适配器、核心纯净度、生产工具独立性。

覆盖：
- DCS (x 北, y 上, z 东) ↔ 核心 ENU 的转换与姿态偏移；
- 同一物理场景经适配器与直接 ENU 注入，相对几何一致；
- truth_replay 的 legacy 航向、blocked 映射与 RCS 解析；
- src/core 不含游戏 API/机型/可见性语义；
- tools/ 生产代码不 import tests/。
"""
import os
import math
import unittest

import os as _os
import sys as _sys

_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
import run_tests as rt


def T(value):
    return rt.T(value)


class FrameConversionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.frame = rt.mod("frame")

    def test_dcs_axes_map_to_enu(self):
        p = self.frame.position(100.0, 200.0, 300.0)   # x north, y up, z east
        self.assertAlmostEqual(p["x"], 300.0)          # east
        self.assertAlmostEqual(p["y"], 100.0)          # north
        self.assertAlmostEqual(p["z"], 200.0)          # up
        v = self.frame.velocity(-5.0, 0.0, 7.0)
        self.assertAlmostEqual(v["x"], 7.0)
        self.assertAlmostEqual(v["y"], -5.0)
        self.assertAlmostEqual(v["z"], 0.0)

    def test_heading_conventions(self):
        # DCS Heading=0 指北；ENU 航向 0 同样指北。
        self.assertAlmostEqual(self.frame.attitude(0.0, 0.1, 0.2)["heading"], 0.0)
        # V1 旧录制 O 行 = Heading + pi/2。
        self.assertAlmostEqual(self.frame.legacy_heading(math.pi / 2), 0.0)
        raw = T({"typeName": "X", "heading": math.pi / 2, "pitch": 0.1, "bank": 0.2,
                 "pos": {"x": 0, "y": 0, "z": 0}, "vel": {"x": 0, "y": 0, "z": 0}})
        own = self.frame.ownship(raw, True)
        self.assertAlmostEqual(own["heading"], 0.0)
        self.assertAlmostEqual(own["pitch"], 0.1)
        self.assertAlmostEqual(own["roll"], 0.2)

    def test_missing_heading_uses_legacy_velocity_fallback(self):
        # 无 O 行、速度指北（DCS x>0）→ ENU heading 0。
        raw = T({"typeName": "X", "pos": {"x": 0, "y": 0, "z": 0},
                 "vel": {"x": 100, "y": 0, "z": 0}})
        own = self.frame.ownship(raw, True)
        self.assertAlmostEqual(own["heading"], 0.0)
        # 静止时沿用旧默认 h_legacy=0（机头 -Z），即 ENU -pi/2。
        still = T({"typeName": "X", "pos": {"x": 0, "y": 0, "z": 0},
                   "vel": {"x": 0, "y": 0, "z": 0}})
        self.assertAlmostEqual(self.frame.ownship(still, True)["heading"], -math.pi / 2)

    def test_adapter_and_enu_geometry_agree(self):
        frame = self.frame
        # 物理场景：本机朝北，目标在东北方向 40 km、高 1 km。
        enu_own = T({"pos": {"x": 0, "y": 0, "z": 8000}, "vel": {"x": 200, "y": 0, "z": 0},
                     "heading": 0.0, "pitch": 0.0, "roll": 0.0})
        enu_tgt = T({"pos": {"x": 20000, "y": 34641.016, "z": 9000},
                     "vel": {"x": -150, "y": 120, "z": 0}})
        raw_own = T({
            "typeName": "OWN",
            "pos": {"x": 0, "y": 8000, "z": 0},
            "vel": {"x": 0, "y": 0, "z": 200},
            "heading": 0.0, "pitch": 0.0, "bank": 0.0,
        })
        raw_tgt = T({
            "typeName": "TGT", "coalition": 1, "visible": False,
            "pos": {"x": 34641.016, "y": 9000, "z": 20000},
            "vel": {"x": 120, "y": 0, "z": -150},
        })
        own2 = frame.ownship(raw_own, False)
        tgt2 = frame.target(raw_tgt, False)
        self.assertTrue(tgt2["blocked"])

        rc = rt.mod("config")["radar"]
        dwell = T({"az": 0.0, "el": 0.0})
        g1 = rt.geometry.geometry(rc, enu_own, enu_tgt, dwell)
        g2 = rt.geometry.geometry(rc, own2, tgt2, dwell)
        self.assertAlmostEqual(g1["R"], g2["R"], places=6)
        self.assertAlmostEqual(g1["az_rel"], g2["az_rel"], places=9)
        self.assertAlmostEqual(g1["el_rel"], g2["el_rel"], places=9)
        self.assertAlmostEqual(g1["v_close"], g2["v_close"], places=6)


class TruthReplayAdapterTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.frame = rt.mod("frame")
        cls.data = rt.mod("rcs_data")
        cls.dcs_rcs = rt.mod("dcs_rcs").new(cls.data)

    def _truth(self, frames, legacy=True):
        opts = T({"legacy_heading": legacy})
        opts["frame"] = self.frame
        opts["rcs"] = self.dcs_rcs
        return rt.mod("truth_replay").new(frames, opts)

    def test_targets_are_enu_and_carry_rcs(self):
        frames = rt.TL([T({
            "t": 0.0,
            "own": {"typeName": "OWN", "pos": {"x": 0, "y": 8000, "z": 0},
                    "vel": {"x": 0, "y": 0, "z": -200},
                    "heading": math.pi / 2, "pitch": 0.0, "roll": 0.0},
            "targets": [{"id": "t1", "typeName": "J-11A", "coalition": 1,
                         "pos": {"x": 1000, "y": 8000, "z": 2000},
                         "vel": {"x": 0, "y": 0, "z": 50}, "visible": False}],
        })])
        truth = self._truth(frames, legacy=True)
        own = rt.call(truth, "ownship", 0)
        self.assertAlmostEqual(own["heading"], 0.0)
        tg = rt.call(truth, "targets", 0)[1]
        self.assertAlmostEqual(tg["pos"]["x"], 2000.0)   # east = DCS z
        self.assertAlmostEqual(tg["pos"]["y"], 1000.0)   # north = DCS x
        self.assertAlmostEqual(tg["pos"]["z"], 8000.0)   # up = DCS y
        self.assertTrue(tg["blocked"])
        self.assertEqual(tg["label"], "J-11A")
        self.assertAlmostEqual(tg["rcs_m2"], 5.5)        # official J-11A

    def test_proto2_raw_heading_is_not_shifted(self):
        frames = rt.TL([T({
            "t": 0.0,
            "own": {"typeName": "OWN", "pos": {"x": 0, "y": 0, "z": 0},
                    "vel": {"x": 0, "y": 0, "z": 0}, "heading": 1.0},
            "targets": [],
        })])
        truth = self._truth(frames, legacy=False)
        self.assertAlmostEqual(rt.call(truth, "ownship", 0)["heading"], 1.0)


class CorePurityTest(unittest.TestCase):
    def test_core_has_no_game_api_or_dcs_semantics(self):
        core = os.path.join(rt.ROOT, "src", "core")
        banned = [r"LoGet", r"package\.loadlib", r"require\s*\(",
                  r"os\s*[.(]", r"io\s*[.(]", r"typeName",
                  r"terrain", r"land\.", r"world\.", r"visible",
                  r"Heading\s*\+"]
        for name in sorted(os.listdir(core)):
            if not name.endswith(".lua"):
                continue
            path = os.path.join(core, name)
            with open(path, encoding="utf-8") as f:
                text = f.read()
            for pattern in banned:
                self.assertNotRegex(text, pattern, "%s 含 %r" % (name, pattern))

    def test_production_tools_do_not_import_tests(self):
        tools = os.path.join(rt.ROOT, "tools")
        targets = ["live.py", "replay.py", "receiver.py", "lua_host.py",
                   "protocol.py", "ingest.py", "truth.py"]
        for name in targets:
            with open(os.path.join(tools, name), encoding="utf-8") as f:
                text = f.read()
            self.assertNotIn("run_tests", text, name)
            self.assertNotIn("import tests", text, name)
            self.assertNotIn('"tests"', text, name)

    def test_viewer_has_no_physics_copy(self):
        with open(os.path.join(rt.ROOT, "tools", "viewer", "index.html"),
                  encoding="utf-8") as f:
            text = f.read()
        self.assertNotIn("rel" + "_geo", text)
        self.assertNotIn("snap.trk", text)
        self.assertNotIn("snap.sched.tracks", text)


if __name__ == "__main__":
    unittest.main(verbosity=2)

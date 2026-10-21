# -*- coding: utf-8 -*-
"""Gate 4 snapshot/MeasurementModel 契约回归。

覆盖：
- core:snapshot() 的稳定 DTO 字段与取值范围（显示层唯一入口）；
- on_dwell 的 beam/truth/measurement/detection 四段结构；
- MeasurementModel 默认 exact，量化模型只改测量量；
- 同配置 + 同真值 + 同种子两次运行快照一致。
"""
import math
import os as _os
import sys as _sys
import unittest

_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
import run_tests as rt


def build_core(seed=42, measurement=None):
    aesa = rt.mod("init").build(rt.SRC)
    own = rt.T({"pos": {"x": 0.0, "y": 0.0, "z": 8000.0},
                "vel": {"x": -200.0, "y": 0.0, "z": 0.0},
                "heading": -math.pi / 2, "pitch": 0.0, "roll": 0.0})
    target = rt.T({"id": 1, "label": "F-16", "coalition": 1,
                   "pos": {"x": -40000.0, "y": 0.0, "z": 8000.0},
                   "vel": {"x": 200.0, "y": 0.0, "z": 0.0},
                   "rcs_m2": 5.0})
    truth = rt.helpers.truth(own, rt.TL([target]))
    sink = rt.helpers.sink()
    opts = None
    if measurement is not None:
        opts = rt.T({"measurement": measurement})
    core = aesa.new(truth, rt.helpers.rcs_static(5.0), sink, seed, opts)
    return aesa, core, sink


def run(core, steps=400, dt=0.05):
    for _ in range(steps):
        rt.call(core, "step", dt)


class SnapshotContractTest(unittest.TestCase):
    def test_snapshot_has_stable_display_dto(self):
        _, core, _ = build_core()
        run(core)
        snap = rt.call(core, "snapshot")
        for key in ("t", "cfg", "own", "tracks", "beam", "beam_trail",
                    "raster", "sched", "truth"):
            self.assertIn(key, snap.keys(), "snapshot 缺少 %s" % key)

        cfg = snap["cfg"]
        self.assertIn("el_bars_deg", cfg.keys())
        self.assertIn("az_span_deg", cfg.keys())
        self.assertIn("scan_cone_deg", cfg.keys())

        own = snap["own"]
        self.assertAlmostEqual(own["alt_m"], 8000.0)
        self.assertAlmostEqual(own["speed_ms"], 200.0)
        self.assertEqual(len(own["pos"]), 3)

        self.assertTrue(snap["tracks"], "20 s 后应有航迹")
        tr = snap["tracks"][1]
        for key in ("id", "confirmed", "iff", "az_deg", "el_deg", "range_km",
                    "vr_mps", "east_m", "north_m", "up_m", "ve_mps", "vn_mps",
                    "speed_ms", "hits", "misses"):
            self.assertIn(key, tr.keys(), "track 缺少 %s" % key)
        self.assertIn(tr["iff"], ("friend", "hostile", "unknown"))
        self.assertAlmostEqual(tr["range_km"], 32.0, delta=0.5)

        self.assertIsNotNone(snap["beam"])
        self.assertIn("detections", snap["beam"].keys())
        self.assertIn("td_ms", snap["beam"].keys())
        self.assertTrue(snap["beam_trail"])
        self.assertIn("count", snap["raster"].keys())

        sched = snap["sched"]
        self.assertGreater(sched["dwells"], 0)
        self.assertGreaterEqual(sched["duty"], 0.0)
        self.assertLessEqual(sched["duty"], 1.0)

        truth = snap["truth"][1]
        self.assertEqual(truth["label"], "F-16")
        self.assertAlmostEqual(truth["range_km"], 32.0, delta=0.5)

    def test_on_dwell_is_split_into_four_sections(self):
        _, core, sink = build_core()
        run(core, steps=10)
        self.assertTrue(sink.dwells)
        dwell = sink.dwells[1]
        self.assertEqual(sorted(dwell.keys()), ["beam", "detection", "measurement", "truth"])
        beam_keys = set(dwell["beam"].keys())
        self.assertTrue({"az", "el", "prf", "purpose", "t", "td", "theta"} <= beam_keys)
        if dwell["beam"]["purpose"] != "search":
            self.assertIn("task_id", beam_keys)
        self.assertEqual(dwell["measurement"]["model"], "exact")
        self.assertEqual(len(dwell["truth"]["targets"]), 1)
        self.assertEqual(len(dwell["measurement"]["targets"]), 1)
        self.assertEqual(len(dwell["detection"]["targets"]), 1)
        det = dwell["detection"]["targets"][1]
        self.assertEqual(det["id"], 1)
        self.assertIn(det["reason"], ("gate", "horizon", "terrain", "range-limit",
                                      "range-blind", "notch", "ok"))

    def test_snapshot_is_deterministic(self):
        _, a, _ = build_core(seed=7)
        _, b, _ = build_core(seed=7)
        run(a, steps=200)
        run(b, steps=200)
        la = rt.call(a, "snapshot")["tracks"]
        lb = rt.call(b, "snapshot")["tracks"]
        sa = [la[i] for i in range(1, len(la) + 1)]
        sb = [lb[i] for i in range(1, len(lb) + 1)]
        self.assertEqual(len(sa), len(sb))
        for x, y in zip(sa, sb, strict=True):
            self.assertEqual(x["id"], y["id"])
            self.assertEqual(x["hits"], y["hits"])
            self.assertEqual(x["misses"], y["misses"])
            self.assertAlmostEqual(x["range_m"], y["range_m"], places=9)
            self.assertAlmostEqual(x["az_deg"], y["az_deg"], places=12)


class MeasurementModelTest(unittest.TestCase):
    def test_default_is_exact(self):
        _, core, _ = build_core()
        self.assertEqual(core["measurement"]["kind"], "exact")

    def test_exact_returns_same_geometry(self):
        m = rt.mod("measurement").exact()
        geo = rt.T({"R": 1234.5, "az_rel": 0.1, "el_rel": -0.2, "v_close": 30.0})
        out = rt.call(m, "apply", geo)
        self.assertEqual(out["R"], geo["R"])
        self.assertEqual(out["az_rel"], geo["az_rel"])
        self.assertNotIn("measurement", out.keys())

    def test_quantized_rounds_measurements_only(self):
        m = rt.mod("measurement").quantized(rt.T({
            "range_step_m": 100.0,
            "az_step_rad": math.radians(1.0),
            "el_step_rad": math.radians(0.5),
        }))
        geo = rt.T({"R": 1234.5, "az_rel": math.radians(1.4),
                    "el_rel": math.radians(-0.8), "v_close": 30.0,
                    "in_gate": True, "beam_factor": 0.5})
        out = rt.call(m, "apply", geo)
        self.assertAlmostEqual(out["R"], 1200.0)
        self.assertAlmostEqual(out["az_rel"], math.radians(1.0))
        self.assertAlmostEqual(out["el_rel"], math.radians(-1.0))
        self.assertAlmostEqual(out["v_close"], 30.0)
        self.assertTrue(out["in_gate"])
        self.assertEqual(out["measurement"], "quantized")

    def test_quantized_measurement_flows_into_audit(self):
        m = rt.mod("measurement").quantized(rt.T({"range_step_m": 100.0}))
        _, core, sink = build_core(measurement=m)
        run(core, steps=10)
        meas = sink.dwells[1]["measurement"]
        self.assertEqual(meas["model"], "quantized")
        for i in range(1, len(meas["targets"]) + 1):
            self.assertAlmostEqual(meas["targets"][i]["range_m"] % 100.0, 0.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)

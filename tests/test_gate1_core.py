# -*- coding: utf-8 -*-
"""Gate 1 核心确定性回归：目标/航迹遍历不得依赖 Lua 表内部顺序。

每个用例都用同一组逻辑输入、不同插入顺序构造 truth targets / tracker.tracks，
断言核心输出（含随机消费后的检测、审计顺序与航迹视图）逐位一致。
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run_tests as rt  # noqa: E402

RT = rt.RT


def id_key(value):
    """排序键：数值按数值升序，字符串按字典序，其余类型排在最后（测试侧独立实现）。"""
    if isinstance(value, bool):
        return (2, str(value))
    if isinstance(value, (int, float)):
        return (0, float(value))
    if isinstance(value, str):
        return (1, value)
    return (3, str(value))


def sorted_ids(ids):
    return sorted(ids, key=id_key)


def to_list(tbl):
    return [tbl[i] for i in range(1, len(tbl) + 1)]


def lua_sink():
    factory = RT.eval(
        """
        function()
          local s = { tracks_hist = {}, ordered_hist = {}, dwells = {} }
          function s:on_tracks(tracks, ordered)
            self.tracks_hist[#self.tracks_hist + 1] = tracks
            self.ordered_hist[#self.ordered_hist + 1] = ordered or {}
          end
          function s:on_dwell(d) self.dwells[#self.dwells + 1] = d end
          return s
        end
        """)
    return factory()


def target(tid, z, vz=300.0, x=0.0, y=8000.0):
    """旧 DCS 参数（x 北 / y 上 / z 东）→ ENU（east=z, north=x, up=y）。"""
    return {"id": tid, "label": "F-16", "coalition": 2,
            "pos": {"x": z, "y": x, "z": y},
            "vel": {"x": vz, "y": 0.0, "z": 0.0}}


def run_core(targets, seed=42, steps=240, dt=0.05):
    own = rt.T({"pos": {"x": 0.0, "y": 0.0, "z": 8000.0},
                "vel": {"x": -200.0, "y": 0.0, "z": 0.0}})
    truth = rt.helpers.truth(own, rt.TL([rt.T(t) for t in targets]))
    sink = lua_sink()
    aesa = rt.mod("init").build(rt.SRC)
    core = aesa.new(truth, rt.helpers.rcs_static(5.0), sink, seed)
    for _ in range(steps):
        rt.call(core, "step", dt)
    return core, sink


def opt_float(value):
    return None if value is None else float(value)


def track_record(tr):
    return {
        "id": tr["id"],
        "confirmed": bool(tr["confirmed"]),
        "pos": tuple(float(tr["pos"][axis]) for axis in "xyz"),
        "vel": tuple(float(tr["vel"][axis]) for axis in "xyz"),
        "hits": int(tr["hits"]),
        "misses": int(tr["misses"]),
        "first_t": float(tr["first_t"]),
        "last_update": float(tr["last_update"]),
        "az": opt_float(tr["az"]), "el": opt_float(tr["el"]),
        "R": opt_float(tr["R"]), "vr": opt_float(tr["vr"]),
    }


def tracks_snapshot(tracks):
    return [(tid, track_record(tracks[tid]))
            for tid in sorted_ids(list(tracks.keys()))]


def audit_record(rec, meas):
    return {
        "id": rec["id"],
        "detected": bool(rec["detected"]),
        "reason": rec["reason"],
        "snr": None if rec["snr"] is None else float(rec["snr"]),
        "pd": None if rec["pd"] is None else float(rec["pd"]),
        "az": float(meas["az_rel"]), "el": float(meas["el_rel"]),
        "R": float(meas["range_m"]), "vr": float(meas["v_close"]),
        "blocked": rec["blocked"],
    }


def dwell_snapshot(sink):
    """每个驻留的审计记录按 id 归一再比较，避免仅凭数组顺序判定。"""
    out = []
    for i in range(1, len(sink.dwells) + 1):
        d = sink.dwells[i]
        beam, det, meas = d["beam"], d["detection"], d["measurement"]
        records = []
        for j in range(1, len(det["targets"]) + 1):
            rec = det["targets"][j]
            records.append((rec["id"], audit_record(rec, meas["targets"][j])))
        out.append((float(beam["t"]), float(beam["td"]), float(beam["az"]), float(beam["el"]),
                    str(beam["prf"]), str(beam["purpose"]), int(det["n"]),
                    sorted(records, key=lambda item: id_key(item[0]))))
    return out


def audit_order(sink):
    return [[sink.dwells[i]["detection"]["targets"][j]["id"]
             for j in range(1, len(sink.dwells[i]["detection"]["targets"]) + 1)]
            for i in range(1, len(sink.dwells) + 1)]


def ordered_history(sink):
    hist = []
    for i in range(1, len(sink.ordered_hist) + 1):
        view = sink.ordered_hist[i]
        hist.append([view[j]["id"] for j in range(1, len(view) + 1)])
    return hist


def make_track(tid, x, y, z, vx=0.0, vy=0.0, vz=0.0, hits=2, misses=0,
               first_t=0.0, last_update=0.0, confirmed=True):
    return {"id": tid, "pos": {"x": x, "y": y, "z": z},
            "vel": {"x": vx, "y": vy, "z": vz},
            "hits": hits, "misses": misses,
            "first_t": first_t, "last_update": last_update,
            "confirmed": confirmed}


def lua_track_map(entries):
    """按给定顺序把 (id, track) 写入 Lua 表，保留插入顺序。"""
    tbl = RT.eval("function() return {} end")()
    for tid, tr in entries:
        tbl[tid] = rt.T(tr)
    return tbl


class CoreDeterminismTest(unittest.TestCase):
    def assert_same_run(self, runs):
        base_core, base_sink = runs[0]
        base_tracks = tracks_snapshot(base_core["trk"]["tracks"])
        base_audit = dwell_snapshot(base_sink)
        base_order = ordered_history(base_sink)
        self.assertTrue(base_sink.dwells, "场景应产生驻留")
        detected = False
        for i in range(1, len(base_sink.dwells) + 1):
            d = base_sink.dwells[i]
            for j in range(1, len(d["detection"]["targets"]) + 1):
                detected = detected or bool(d["detection"]["targets"][j]["detected"])
        self.assertTrue(detected, "场景应产生检测")
        for core, sink in runs[1:]:
            self.assertEqual(tracks_snapshot(core["trk"]["tracks"]), base_tracks,
                             "航迹内容随输入插入顺序改变")
            self.assertEqual(dwell_snapshot(sink), base_audit,
                             "驻留审计（随机消费）随输入插入顺序改变")
            self.assertEqual(ordered_history(sink), base_order,
                             "航迹输出顺序随输入插入顺序改变")

    def test_numeric_target_order_does_not_change_output(self):
        base = [target(11, -61000.0), target(12, -83000.0),
                target(13, -97000.0), target(14, -111000.0),
                target(15, -123000.0), target(16, -127000.0)]
        runs = [run_core(order) for order in
                (base, list(reversed(base)),
                 [base[i] for i in (3, 0, 5, 1, 4, 2)])]
        self.assert_same_run(runs)
        for core, sink in runs:
            for ids in audit_order(sink):
                self.assertEqual(ids, sorted_ids(ids), "驻留审计目标未按稳定 id 排序")
        self.assertEqual(ordered_history(runs[0][1]), ordered_history(runs[1][1]))

    def test_string_target_order_does_not_change_output(self):
        base = [target("zulu", -61000.0), target("alpha", -83000.0),
                target("mike", -97000.0), target("bravo", -111000.0)]
        runs = [run_core(order) for order in
                (base, list(reversed(base)), [base[1], base[3], base[0], base[2]])]
        self.assert_same_run(runs)
        for core, sink in runs:
            for ids in audit_order(sink):
                self.assertEqual(ids, sorted_ids(ids), "字符串 id 未按稳定字典序输出")
        for ids in ordered_history(runs[0][1]):
            self.assertEqual(ids, sorted_ids(ids))

    def test_track_output_order_matches_stable_id_order(self):
        core, sink = run_core([target(21, -61000.0), target(22, -83000.0),
                               target(23, -97000.0)], steps=120)
        self.assertTrue(core["trk"]["tracks"].keys())
        track_ids = list(core["trk"]["tracks"].keys())
        self.assertEqual(to_list(core["trk"].track_ids(core["trk"])),
                         sorted_ids(track_ids))
        self.assertEqual([tr["id"] for tr in to_list(core["trk"].ordered(core["trk"]))],
                         sorted_ids(track_ids))
        for ids in ordered_history(sink):
            self.assertEqual(ids, sorted_ids(ids))
        self.assertEqual(ordered_history(sink)[-1], sorted_ids(track_ids))

    def test_sorted_ids_mixed_numeric_and_string(self):
        tbl = RT.eval("function() return {[3]={},['b']={},[1]={},['a']={}} end")()
        self.assertEqual(to_list(rt.mod("tracker").sorted_ids(tbl)), [1, 3, "a", "b"])


class TrackerDeterminismTest(unittest.TestCase):
    def association_case(self, entries, dets, t=0.5):
        trk = rt.mod("tracker").new(rt.mod("config")["tracker"])
        trk["tracks"] = lua_track_map(entries)
        trk["next_id"] = 100
        call_dets = rt.TL([rt.T({"wx": d[0], "wy": d[1], "wz": d[2]}) for d in dets])
        rt.call(trk, "update", t, call_dets)
        return trk

    def test_association_independent_of_track_insertion_order(self):
        # 两个航迹的预测位置重合，只有一个检测：稳定 id 较小的航迹必须获得关联。
        a = make_track("a", 0.0, 8000.0, -50000.0)
        b = make_track("b", 0.0, 8000.0, -50000.0)
        det = [(0.0, 8000.0, -50000.0)]
        forward = self.association_case([("a", a), ("b", b)], det)
        reverse = self.association_case([("b", b), ("a", a)], det)
        for trk in (forward, reverse):
            self.assertEqual(trk["tracks"]["a"]["hits"], 3, "id 'a' 应获得检测")
            self.assertEqual(trk["tracks"]["a"]["misses"], 0)
            self.assertEqual(trk["tracks"]["b"]["hits"], 2, "id 'b' 不应抢到检测")
            self.assertEqual(trk["tracks"]["b"]["misses"], 1)

    def test_numeric_ids_associate_by_sorted_order(self):
        # 稀疏数值键（哈希部分）同样不得依赖插入顺序；id 1001 先关联。
        a = make_track(1001, 0.0, 8000.0, -50000.0)
        b = make_track(1002, 0.0, 8000.0, -50000.0)
        det = [(0.0, 8000.0, -50000.0)]
        for entries in ([(1001, a), (1002, b)], [(1002, b), (1001, a)]):
            trk = self.association_case(entries, det)
            self.assertEqual(trk["tracks"][1001]["hits"], 3)
            self.assertEqual(trk["tracks"][1002]["misses"], 1)

    def test_mixed_type_ids_have_stable_order(self):
        # 数值 id 排在字符串 id 前，两个顺序都必须由 7 先关联。
        num = make_track(7, 0.0, 8000.0, -50000.0)
        txt = make_track("10", 0.0, 8000.0, -50000.0)
        det = [(0.0, 8000.0, -50000.0)]
        for entries in ([(7, num), ("10", txt)], [("10", txt), (7, num)]):
            trk = self.association_case(entries, det)
            self.assertEqual(trk["tracks"][7]["hits"], 3)
            self.assertEqual(trk["tracks"]["10"]["misses"], 1)

    def test_deletion_independent_of_track_insertion_order(self):
        # 三种删除路径：coast 超时、未确认超窗、确认后慢速。插入顺序不得影响结果。
        entries = [
            (1, make_track(1, 0, 8000, -1000, last_update=3.0, confirmed=True)),
            (2, make_track(2, 0, 8000, -2000, first_t=1.0, last_update=9.5,
                           hits=1, confirmed=False)),
            (3, make_track(3, 0, 8000, -3000, vx=1.0, first_t=1.0, last_update=9.5,
                           confirmed=True)),
            (4, make_track(4, 0, 8000, -4000, vz=100.0, first_t=1.0, last_update=9.5,
                           confirmed=True)),
        ]
        snapshots = []
        for order in (entries, list(reversed(entries)),
                      [entries[i] for i in (2, 0, 3, 1)]):
            trk = rt.mod("tracker").new(rt.mod("config")["tracker"])
            trk["tracks"] = lua_track_map(order)
            rt.call(trk, "update", 10.0, rt.TL([]))
            snapshots.append(tracks_snapshot(trk["tracks"]))
        self.assertEqual([sid for sid, _ in snapshots[0]], [4])
        self.assertEqual(snapshots[0], snapshots[1])
        self.assertEqual(snapshots[0], snapshots[2])


if __name__ == "__main__":
    unittest.main(verbosity=2)

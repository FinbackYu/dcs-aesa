"""Review regressions: T1-T6 physics, T7/T9/T10 scheduling, and integration safety."""
import copy
import json
import os
import sys
import tempfile
import unittest
import math
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))
import run_tests as rt
import install_export as installer
from receiver import FrameBuffer, parse_line
import live

EXPORT = os.path.join(rt.ROOT, "src", "export", "aesa_export.lua")
API_EXPORT = os.path.join(rt.ROOT, "src", "adapters", "dcs", "api", "export.lua")
API_SOCKET = os.path.join(rt.ROOT, "src", "adapters", "dcs", "api", "socket.lua")
PROFILE = os.path.join(rt.ROOT, "src", "adapters", "dcs", "compat", "profile.lua")
PROFILE_DATA = os.path.join(
    rt.ROOT, "src", "adapters", "dcs", "compat", "profiles", "dcs-2.9.30.28738-mt.lua")
_RUNTIME_READY = False


def _lua_path(path):
    return path.replace("\\", "/")


def load_export():
    global _RUNTIME_READY
    if not _RUNTIME_READY:
        rt.RT.execute(
            "AESA_RUNTIME = {\n"
            "  export = assert(dofile('%s')),\n"
            "  socket = assert(dofile('%s')),\n"
            "  profile = assert(dofile('%s')),\n"
            "  profile_data = assert(dofile('%s')),\n"
            "}\n" % (_lua_path(API_EXPORT), _lua_path(API_SOCKET),
                     _lua_path(PROFILE), _lua_path(PROFILE_DATA)))
        _RUNTIME_READY = True
    return rt.load_lua(EXPORT, "export")


def export_adapter(env):
    return rt.RT.eval("function(env) return AESA_RUNTIME.export.new(env) end")(env)


def core_fixture(distance=600, height=8000, sigma=5, target_speed=-200):
    a = rt.mod("init").build(rt.SRC)
    own = rt.T({"pos": {"x": 0.0, "y": 0.0, "z": height},
                "vel": {"x": -200.0, "y": 0.0, "z": 0.0}})
    target = rt.T({"id": "target", "label": "F-16", "coalition": 1,
                   "pos": {"x": -distance, "y": 0.0, "z": height},
                   "vel": {"x": target_speed, "y": 0.0, "z": 0.0}})
    truth = rt.helpers.truth(own, rt.TL([target]))
    sink = rt.helpers.sink()
    c = a.new(truth, rt.helpers.rcs_static(sigma), sink, 42)
    c["rng"] = rt.RT.eval("function() return 0.000001 end")
    return a, c, sink, own, target


def dwell():
    return rt.T({"az": 0, "el": 0, "theta": 0, "Td": .01,
                 "prf_idx": 2, "t_start": 0, "t_end": .01, "purpose": "search"})


class PhysicsRegressions(unittest.TestCase):
    def setUp(self):
        self.cfg = rt.mod("config")
        self.ph = rt.physics
        self.det = rt.detection
        self.geo = rt.geometry
        self.lam = self.cfg["radar"]["lambda_m"]

    def test_t5_clutter_aliases(self):
        pe = self.cfg["radar"]["prf"][2]
        for velocity in (-100, 200, 500):
            self.assertTrue(self.det.velocity_blind(pe, self.lam, velocity, 200))

    def test_t5_zero_frequency_filter_is_separate(self):
        pe = self.cfg["radar"]["prf"][2]
        self.assertFalse(self.det.velocity_blind(pe, self.lam, 600, 200))
        pe["zero_notch_half_mps"] = 5
        self.assertTrue(self.det.velocity_blind(pe, self.lam, 600, 200))
        self.assertTrue(self.det.velocity_blind(pe, self.lam, 0, 200))

    def test_t6_eclipsing_energy_on_both_sides(self):
        pe = self.cfg["radar"]["prf"][1]
        self.assertAlmostEqual(self.det.eclipsing_factor(pe, 700), .165051, places=5)
        self.assertAlmostEqual(self.det.eclipsing_factor(pe, 900), .502077, places=5)
        self.assertFalse(self.det.range_blind(pe, 900))
        self.assertTrue(self.det.range_blind(pe, 200))

    def test_t2_compensation_follows_scan_exponent(self):
        self.cfg["radar"]["scan_k"] = 1.5
        sched = rt.mod("scheduler").new(self.cfg["scheduler"], self.cfg["radar"],
                                        rt.T({"beam": rt.beam}))
        self.assertAlmostEqual(rt.call(sched, "dwell_Td", "search", rt.RT.eval("math.pi/3")), .08)

    def test_t2_cross_scan_beam_does_not_double(self):
        _, _, _, own, _ = core_fixture()
        point = self.geo.world_point(own, rt.RT.eval("math.pi/3"), .04363323, 100000)
        target = rt.T({"pos": point, "vel": {"x": 0, "y": 0, "z": 0}})
        geo = self.geo.geometry(self.cfg["radar"], own, target,
                                rt.T({"az": rt.RT.eval("math.pi/3"), "el": 0}))
        self.assertFalse(geo["in_gate"])

    def test_t2_half_power_edge_has_two_way_loss(self):
        _, _, _, own, _ = core_fixture()
        point = self.geo.world_point(own, .02617994, 0, 100000)
        geo = self.geo.geometry(self.cfg["radar"], own,
                                rt.T({"pos": point, "vel": {"x": 0, "y": 0, "z": 300}}),
                                rt.T({"az": 0, "el": 0}))
        self.assertAlmostEqual(geo["beam_factor"], .25, delta=.001)

    def test_t1_peak_power_constrains_low_duty_waveform(self):
        rc = self.cfg["radar"]
        self.assertLessEqual(self.ph.transmit_power(rc, rc["prf"][3]),
                             rc["ptx_peak_w"] * rc["prf"][3]["prf_hz"] * rc["prf"][3]["tau_s"])

    def test_t10_uses_actual_scan_angle(self):
        sched = rt.mod("scheduler").new(self.cfg["scheduler"], self.cfg["radar"],
                                        rt.T({"beam": rt.beam}))
        rt.call(sched, "add_track", 1, "track", 4, 2)
        rt.call(sched, "set_geo", 1, 1.04719755, 1.04719755)
        out = []
        rt.call(sched, "step", .1, lambda d: out.append(dict(d)))
        self.assertTrue(all(d["theta"] <= 1.047197552 for d in out))
        self.assertTrue(all(d.get("task_id") != 1 for d in out))

    def test_t1_horizon_rejects_low_target(self):
        _, c, sink, _, _ = core_fixture(100000, 100, target_speed=250)
        rt.call(c, "run_dwell", dwell())
        self.assertEqual(sink["dwells"][1]["detection"]["n"], 0)
        self.assertEqual(sink["dwells"][1]["detection"]["targets"][1]["reason"], "horizon")

    def test_t1_terrain_visibility_is_obeyed(self):
        _, c, sink, _, target = core_fixture(40000, target_speed=250)
        target["blocked"] = True
        rt.call(c, "run_dwell", dwell())
        self.assertEqual(sink["dwells"][1]["detection"]["n"], 0)
        self.assertEqual(sink["dwells"][1]["detection"]["targets"][1]["reason"], "terrain")

    def test_t1_large_target_beyond_old_cutoff(self):
        _, c, sink, _, _ = core_fixture(260000, sigma=100, target_speed=250)
        rt.call(c, "run_dwell", dwell())
        self.assertEqual(sink["dwells"][1]["detection"]["n"], 1)

    def test_t6_close_target_can_be_acquired(self):
        _, c, _, _, _ = core_fixture()
        for _ in range(200):
            rt.call(c, "step", .05)
        self.assertTrue(any(tr["confirmed"] for _, tr in c["trk"]["tracks"].items()))

    def test_t6_search_prfs_cover_shared_eclipse(self):
        cfg = self.cfg
        rc = cfg["radar"]
        R = cfg["physics"]["c_mps"] / (2 * rc["prf"][2]["prf_hz"])
        indices = rt.mod("scheduler").new(cfg["scheduler"], rc,
                                          rt.T({"beam": rt.beam})).prf_indices.search
        self.assertIsNotNone(indices)
        self.assertTrue(any(self.det.eclipsing_factor(rc["prf"][indices[i]], R) > .5
                            for i in range(1, len(indices) + 1)))

    def test_t2_orientation_roundtrip_uses_pitch_and_roll(self):
        _, _, _, own, _ = core_fixture()
        own["heading"], own["pitch"], own["roll"] = .5, .4, .3
        p = self.geo.world_point(own, 0, 0, 1000)
        self.assertAlmostEqual(p["z"] - own["pos"]["z"], 1000 * rt.RT.eval("math.sin(.4)"))
        geo = self.geo.geometry(self.cfg["radar"], own,
                                rt.T({"pos": p, "vel": {"x": 0, "y": 0, "z": 0}}),
                                rt.T({"az": 0, "el": 0}))
        self.assertAlmostEqual(geo["az_rel"], 0)
        self.assertAlmostEqual(geo["el_rel"], 0)

    def test_t3_correlated_dwells_share_target_fluctuation(self):
        a, c, _, _, _ = core_fixture(40000, target_speed=250)
        a["config"]["radar"]["fluctuation_hold_s"] = 1.0
        f1 = rt.call(c, "fluctuation_factor", "target", .01)
        f2 = rt.call(c, "fluctuation_factor", "target", .99)
        self.assertGreater(f1, 0)
        self.assertEqual(f1, f2)
        c["rng"] = rt.RT.eval("function() return .5 end")
        self.assertNotEqual(f1, rt.call(c, "fluctuation_factor", "target", 1.01))

    def test_t3_complex_noise_sampling_matches_swerling_marginal(self):
        # Average over exponential RCS power; receiver complex-noise samples are independent.
        rc = self.cfg["radar"]
        pe = rc["prf"][2]
        geo = rt.T({"R": 4000, "v_close": 50, "v_mlc": 0, "beam_factor": 1})
        energy_snr = self.ph.snr(rc, rt.T({"R": 4000, "sigma": 1, "theta": 0, "Td": .01}))
        factor = self.det.eclipsing_factor(pe, 4000)
        sigma = 20 / (energy_snr * factor)
        rng = rt.constants.make_rng(321)
        detections = 0
        n = 20000
        for _ in range(n):
            power = -math.log(rng())
            result = self.det.assess(rc, pe, geo, 0, .01, sigma, rng, power)
            detections += result["detected"]
        expected = self.ph.pd_swerling1(20, rc["pfa"])
        self.assertAlmostEqual(detections / n, expected, delta=.015)

    def test_t3_zero_fluctuation_uses_receiver_noise(self):
        rc = self.cfg["radar"]
        pe = rc["prf"][2]
        geo = rt.T({"R": 4000, "v_close": 50, "v_mlc": 0, "beam_factor": 1})
        result = self.det.assess(rc, pe, geo, 0, .01, 5,
                                 rt.RT.eval("function() return .5 end"), 0)
        self.assertFalse(result["detected"])

    def test_t1_coherent_energy_can_be_limited(self):
        rc = self.cfg["radar"]
        rc["integration_efficiency"], rc["coherence_time_s"] = .5, .005
        args = rt.T({"R": 100000, "sigma": 5, "theta": 0, "Td": .01})
        limited = self.ph.snr(rc, args)
        rc["integration_efficiency"], rc["coherence_time_s"] = 1, False
        self.assertAlmostEqual(limited / self.ph.snr(rc, args), .25)


class SchedulingRegressions(unittest.TestCase):
    def test_core_step_partition_has_same_observations(self):
        def run(parts):
            _, c, sink, _, target = core_fixture(40000, target_speed=300)
            target["pos"]["y"] = 5000
            for dt in parts:
                rt.call(c, "step", dt)
            self.assertTrue(any(d["beam"]["purpose"] == "track"
                                for _, d in sink["dwells"].items()))
            return [(d["beam"]["t"], d["beam"]["az"], d["beam"]["el"],
                     d["beam"]["prf"], d["detection"]["n"])
                    for _, d in sink["dwells"].items()]
        coarse, fine = run([2] * 15), run([.01] * 3000)
        self.assertEqual(len(coarse), len(fine))
        for a, b in zip(coarse, fine):
            for i in range(3):
                self.assertAlmostEqual(a[i], b[i], places=8)
            self.assertEqual(a[3:], b[3:])

    def test_t7_dt_partition_does_not_change_revisits(self):
        def run(parts):
            cfg = rt.mod("config")
            s = rt.mod("scheduler").new(cfg["scheduler"], cfg["radar"],
                                        rt.T({"beam": rt.beam}))
            rt.call(s, "add_track", 1, "stt", 6, 1)
            out = []
            for dt in parts:
                rt.call(s, "step", dt, lambda d: out.append((d["purpose"], d["t_start"])))
            return out
        coarse, fine = run([1.0] * 2), run([.01] * 200)
        self.assertEqual(len(coarse), len(fine))
        for a, b in zip(coarse, fine):
            self.assertEqual(a[0], b[0])
            self.assertAlmostEqual(a[1], b[1], places=8)
        self.assertGreaterEqual(sum(p == "stt" for p, _ in coarse), 12)

    def test_t9_detections_are_emitted_after_dwell_finishes(self):
        cfg = rt.mod("config")
        s = rt.mod("scheduler").new(cfg["scheduler"], cfg["radar"],
                                    rt.T({"beam": rt.beam}))
        out = []
        rt.call(s, "step", .001, lambda d: out.append(dict(d)))
        self.assertEqual(out, [])
        rt.call(s, "step", .1, lambda d: out.append(dict(d)))
        self.assertTrue(out)
        self.assertTrue(all(d["t_end"] <= .101 + 1e-9 for d in out))

    def test_t7_stt_upgrade_downgrade_and_rate_change(self):
        _, c, _, _, _ = core_fixture(60000)
        rt.call(c["trk"], "update", 0, rt.TL([rt.T({"wx": -60000, "wy": 0, "wz": 8000})]))
        rt.call(c["trk"], "update", .5, rt.TL([rt.T({"wx": -59850, "wy": 0, "wz": 8000})]))
        rv = rt.mod("config")["scheduler"]["revisit"]
        c["t"] = .5
        rt.call(c, "sync_tasks")
        task = c["sched"]["tracks"][1]
        self.assertEqual(task["hz"], rv["track_far_hz"])
        rt.call(c, "set_stt", 1)
        rt.call(c, "sync_tasks")
        self.assertEqual(task["kind"], "stt")
        self.assertEqual(task["hz"], rv["stt_hz"])
        rt.call(c, "set_stt", None)
        c["trk"]["tracks"][1]["pos"]["x"] = -20000
        rt.call(c, "sync_tasks")
        self.assertEqual(task["kind"], "track")
        self.assertEqual(task["hz"], rv["track_near_hz"])


class IntegrationRegressions(unittest.TestCase):
    def test_replay_summary_handles_deleted_track_ids(self):
        import replay
        tracks = rt.RT.eval("{[2]={id=2,confirmed=true},[5]={id=5,confirmed=false}}")
        result = replay.track_list(tracks)
        self.assertEqual([track["id"] for track in result], [2, 5])

    def test_replay_jump_stats_excludes_reacquisition_gap(self):
        import replay
        updates = [(1, 0.00, 0, 0, 0), (1, 0.05, 3, 4, 0), (1, 0.10, 3, 4, 0),
                   (1, 0.10, 3, 4, 0), (1, 1.35, 6, 8, 0), (1, 1.40, 9, 12, 0)]
        stats = replay.jump_stats(updates, 0.05)
        self.assertEqual(stats["samples"], 3)
        self.assertEqual(stats["regaps_excluded"], 1)
        self.assertEqual(stats["p95_m"], 5.0)
        self.assertEqual(stats["max_m"], 5.0)

    def test_replay_jump_stats_nearest_rank_p95(self):
        import replay
        updates = [(1, i * 0.05, i * (i + 1) / 2, 0, 0) for i in range(21)]
        stats = replay.jump_stats(updates, 0.05)
        # 20 adjacent-step moves, 1..20 m; nearest-rank p95 is the 19th value.
        self.assertEqual(stats["samples"], 20)
        self.assertEqual(stats["p95_m"], 19.0)
        self.assertEqual(stats["max_m"], 20.0)

    def test_frame_buffer_streaming_mode_keeps_only_counts(self):
        buf = FrameBuffer(retain=False)
        for t in (0, 1, 2):
            buf.feed("A %d OWN 0 8000 0 0 0 -200 1" % t)
            buf.feed("T %d target F16 1 0 8000 -1000 0 0 200 1" % t)
        buf.feed("E 0 target 1 2 3 40000 500 5 34")
        self.assertEqual(buf.frame_count, 2)
        self.assertEqual(buf.last_frame["t"], 1)
        self.assertEqual(buf.frames, [])
        self.assertEqual(buf.engine_count, 1)
        self.assertEqual(buf.finish(), [])
        self.assertEqual(buf.frame_count, 3)
        self.assertEqual(buf.last_frame["t"], 2)

    def test_engine_fields_both_formats(self):
        for line in ("E 12.5 unit 40000 500 5 34", "E 12.5 unit 1 2 3 40000 500 5 34"):
            kind, row = parse_line(line)
            self.assertEqual(kind, "E")
            self.assertEqual((row["R"], row["vclose"], row["rcs"], row["flags"]), (40000, 500, 5, 34))

    def test_live_gap_preserves_time(self):
        c = live.LiveCore()
        for t in (0, 5, 5.1):
            c.feed({"t": t, "own": {"typeName": "F-16", "pos": (0, 8000, -200*t),
                                    "vel": (0, 0, -200)}, "targets": []})
        self.assertAlmostEqual(c.core["t"], 5.1)

    def test_live_snapshot_reports_compat(self):
        c = live.LiveCore()
        compat = {"profile_id": "dcs-2.9.30.28738-mt", "matrix_hash": "1a2b3c4d"}
        snap = c.snapshot({"connected": True, "compat": compat})
        self.assertEqual(snap["compat"], compat)

    def test_export_skips_object_without_position(self):
        exporter = load_export()
        lo = rt.RT.eval("""{
              LoGetSelfData=function() return {Position={x=0,y=8000,z=0}} end,
              LoGetWorldObjects=function() return {[1]={Name='bad'},[2]={Name='good',Position={x=0,y=8000,z=-1000}}} end}""")
        lines = []
        exporter.sample(0, export_adapter(lo), lines.append)
        self.assertEqual(sum(line.startswith("T ") for line in lines), 1)

    def test_orientation_and_visibility_protocol(self):
        buf = FrameBuffer()
        buf.feed("A 0 OWN 0 8000 0 0 0 -200")
        buf.feed("O 0 0.5 0.4 0.3")
        buf.feed("T 0 target F16 1 0 8000 -1000 0 0 200")
        buf.feed("L 0 target 0")
        frame = buf.finish()[0]
        self.assertEqual(frame["own"]["pitch"], .4)
        self.assertFalse(frame["targets"][0]["visible"])

    def test_optional_metadata_survives_live_and_replay(self):
        import truth as truth_mod
        frame = {"t": 0, "own": {"typeName": "OWN", "pos": (0, 8000, 0),
                 "vel": (0, 0, -200), "heading": .5, "pitch": .4, "roll": .3},
                 "targets": [{"id": "target", "typeName": "F16", "coalition": 1,
                              "pos": (0, 8000, -1000), "vel": (0, 0, 200), "visible": False}]}
        live_core = live.LiveCore()
        self.assertTrue(live_core.set_proto(2))
        live_core.feed(copy.deepcopy(frame))
        opts = rt.T({"legacy_heading": False})
        opts["frame"] = rt.mod("frame")
        replay_truth = rt.mod("truth_replay").new(truth_mod.to_lua_frames(rt, [frame]), opts)
        for truth_src in (live_core.truth, replay_truth):
            own = rt.call(truth_src, "ownship", 0)
            self.assertEqual((own["heading"], own["pitch"], own["roll"]), (.5, .4, .3))
            target = rt.call(truth_src, "targets", 0)[1]
            self.assertTrue(target["blocked"])
            self.assertEqual(target["label"], "F16")

    def test_export_orientation_and_visibility(self):
        exporter = load_export()
        lo = rt.RT.eval("""{
                LoGetSelfData=function() return {Position={x=0,y=8000,z=0},
                Heading=0,Pitch=.4,Bank=.3} end,
                LoGetWorldObjects=function() return {[2]={Name='good',Position={x=1000,y=8000,z=0}}} end,
                terrain={isVisible=function() return false end}}""")
        buf = FrameBuffer()
        exporter.sample(0, export_adapter(lo), buf.feed)
        frame = buf.finish()[0]
        self.assertAlmostEqual(frame["own"]["heading"], 0.0, places=3)
        self.assertFalse(frame["targets"][0]["visible"])


class DeploymentRegressions(unittest.TestCase):
    def test_install_deploys_built_bundle_not_source(self):
        with tempfile.TemporaryDirectory() as root:
            self.assertFalse(installer.install(root))
            deployed = os.path.join(root, "Scripts", "AESA", "aesa_export.lua")
            with open(deployed, "rb") as stream:
                payload = stream.read()
            with open(installer.SRC_EXPORT, "rb") as stream:
                built = stream.read()
            self.assertEqual(payload, built)
            self.assertIn(b"DO NOT EDIT -- generated by scripts/build_runtime.cjs", payload)
            with open(os.path.join(root, "Scripts", "AESA", "manifest.json"),
                      encoding="utf-8") as stream:
                manifest = json.load(stream)
            self.assertEqual(manifest["source"], "dist/dev/aesa_export.lua")

    def test_known_legacy_uninstall_does_not_require_dist(self):
        with tempfile.TemporaryDirectory() as root:
            directory = os.path.join(root, "Scripts", "AESA")
            os.makedirs(directory)
            legacy = b"-- known legacy fixture"
            path = os.path.join(directory, "aesa_export.lua")
            with open(path, "wb") as stream:
                stream.write(legacy)
            with patch.object(installer, "LEGACY_HASHES", {installer._hash(legacy)}), \
                    patch.object(installer, "SRC_EXPORT", os.path.join(root, "missing.lua")):
                self.assertFalse(installer.uninstall(root))
            self.assertFalse(os.path.exists(path))

    def test_corrupt_manifest_refuses_writes(self):
        for content in (b"[]", b'{"product":"aesa-export","schema":1,"script_hash":123}'):
            with tempfile.TemporaryDirectory() as root:
                directory = os.path.join(root, "Scripts", "AESA")
                os.makedirs(directory)
                path = os.path.join(directory, "manifest.json")
                with open(path, "wb") as stream:
                    stream.write(content)
                self.assertTrue(installer.install(root))
                with open(path, "rb") as stream:
                    self.assertEqual(stream.read(), content)
                self.assertFalse(os.path.exists(os.path.join(root, "Scripts", "Export.lua")))

    def test_external_export_edits_survive_repair_and_uninstall(self):
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, "Scripts", "Export.lua")
            os.makedirs(os.path.dirname(path))
            original = b"-- SRS\r\ndofile('srs.lua')\r\n"
            with open(path, "wb") as stream:
                stream.write(original)
            self.assertFalse(installer.install(root))
            addition = b"-- new tool\r\ndofile('tacview.lua')\r\n"
            with open(path, "ab") as stream:
                stream.write(addition)
            self.assertFalse(installer.repair(root))
            self.assertFalse(installer.uninstall(root))
            with open(path, "rb") as stream:
                self.assertEqual(stream.read(), original + addition)

    def test_whitespace_only_export_is_removed_after_uninstall(self):
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, "Scripts", "Export.lua")
            os.makedirs(os.path.dirname(path))
            with open(path, "wb") as stream:
                stream.write(b"\n\n\n")
            self.assertFalse(installer.install(root))
            with open(os.path.join(root, "Scripts", "AESA", "manifest.json"),
                      encoding="utf-8") as stream:
                manifest = json.load(stream)
            self.assertFalse(manifest["export_existed"])
            self.assertFalse(installer.uninstall(root))
            self.assertFalse(os.path.exists(path))

    def test_changed_owned_script_stops_upgrade_and_uninstall(self):
        with tempfile.TemporaryDirectory() as root:
            self.assertFalse(installer.install(root))
            exp = os.path.join(root, "Scripts", "Export.lua")
            script = os.path.join(root, "Scripts", "AESA", "aesa_export.lua")
            with open(script, "ab") as stream:
                stream.write(b"\n-- local modifications")
            with open(exp, "rb") as stream:
                before = stream.read()
            for action in (installer.install, installer.uninstall):
                self.assertTrue(action(root))
                with open(exp, "rb") as stream:
                    self.assertEqual(stream.read(), before)

    def test_install_io_failure_rolls_back_destinations(self):
        with tempfile.TemporaryDirectory() as root:
            exp = os.path.join(root, "Scripts", "Export.lua")
            os.makedirs(os.path.dirname(exp))
            original = b"-- original\n"
            with open(exp, "wb") as stream:
                stream.write(original)
            real_write, calls = installer._write, []
            def fail_once(path, data):
                calls.append(str(path))
                if len(calls) == 2:
                    raise OSError("simulated write failure")
                real_write(path, data)
            with patch.object(installer, "_write", fail_once):
                self.assertTrue(installer.install(root))
            with open(exp, "rb") as stream:
                self.assertEqual(stream.read(), original)
            self.assertFalse(os.path.exists(os.path.join(root, "Scripts", "AESA", "aesa_export.lua")))

    def test_malformed_markers_leave_everything_unchanged(self):
        for action in (installer.install, installer.repair, installer.uninstall):
            with tempfile.TemporaryDirectory() as root:
                scripts = os.path.join(root, "Scripts")
                os.mkdir(scripts)
                exp = os.path.join(scripts, "Export.lua")
                original = ("-- SRS\n" + installer.BLOCK_BEGIN + "\nbroken\ndofile('tacview.lua')\n").encode()
                with open(exp, "wb") as f:
                    f.write(original)
                self.assertTrue(action(root))
                with open(exp, "rb") as f:
                    self.assertEqual(f.read(), original)
                self.assertFalse(os.path.exists(os.path.join(scripts, "AESA")))

    def test_unknown_script_cannot_be_overwritten(self):
        with tempfile.TemporaryDirectory() as root:
            directory = os.path.join(root, "Scripts", "AESA")
            os.makedirs(directory)
            path = os.path.join(directory, "aesa_export.lua")
            with open(path, "wb") as f:
                f.write(b"-- personal script")
            self.assertTrue(installer.install(root))
            with open(path, "rb") as f:
                self.assertEqual(f.read(), b"-- personal script")
            self.assertFalse(os.path.exists(os.path.join(root, "Scripts", "Export.lua")))

    def test_export_bytes_survive_lifecycle_and_other_tool_edits(self):
        with tempfile.TemporaryDirectory() as root:
            os.makedirs(os.path.join(root, "Scripts"))
            exp = os.path.join(root, "Scripts", "Export.lua")
            original = b"\xef\xbb\xbf-- user \xff\r\ndofile('srs.lua')\r\n"
            with open(exp, "wb") as f:
                f.write(original)
            self.assertFalse(installer.install(root))
            self.assertFalse(installer.repair(root))
            self.assertFalse(installer.uninstall(root))
            with open(exp, "rb") as f:
                self.assertEqual(f.read(), original)

    def test_uninstall_preserves_logs_and_foreign_files(self):
        with tempfile.TemporaryDirectory() as root:
            self.assertFalse(installer.install(root))
            directory = os.path.join(root, "Scripts", "AESA")
            for name in ("export_diag.log", "personal.txt"):
                with open(os.path.join(directory, name), "wb") as f:
                    f.write(b"keep")
            self.assertFalse(installer.uninstall(root))
            self.assertFalse(os.path.exists(os.path.join(directory, "aesa_export.lua")))
            self.assertTrue(os.path.exists(os.path.join(directory, "personal.txt")))
            self.assertTrue(os.path.exists(os.path.join(directory, "export_diag.log")))


if __name__ == "__main__":
    unittest.main(verbosity=2)

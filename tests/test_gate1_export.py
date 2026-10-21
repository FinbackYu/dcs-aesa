"""Gate 1 regressions: A/A Export sampling and V1 protocol correctness.

Covers CoalitionID preference, LoGetVectorVelocity / vel_valid, real P-line
parsing, deterministic target ordering, and the shared velocity patcher.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run_tests as rt
from receiver import FrameBuffer, VelocityPatcher, estimate_velocities, parse_line

EXPORT = os.path.join(rt.ROOT, "src", "export", "aesa_export.lua")
API_EXPORT = os.path.join(rt.ROOT, "src", "adapters", "dcs", "api", "export.lua")
API_SOCKET = os.path.join(rt.ROOT, "src", "adapters", "dcs", "api", "socket.lua")
PROFILE = os.path.join(rt.ROOT, "src", "adapters", "dcs", "compat", "profile.lua")
PROFILE_DATA = os.path.join(
    rt.ROOT, "src", "adapters", "dcs", "compat", "profiles", "dcs-2.9.30.28738-mt.lua")
REAL_P = ("P Bank:number|Coalition:string|CoalitionID:number|Country:number|"
          "Flags:table|GroupName:string|Heading:number|LatLongAlt:table|"
          "Name:string|Pitch:number|Position:table|PositionAsMatrix:table|"
          "Type:table|UnitName:string")

_RUNTIME_READY = False
_ADAPTER_FACTORY = None
_NORMALIZER = None


def _lua_path(path):
    return path.replace("\\", "/")


def load_export():
    """Set AESA_RUNTIME before loading the consumer source, per the Gate 3 contract."""
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
    return rt.load_lua(EXPORT, "aesa_export")


def make_adapter(env):
    global _ADAPTER_FACTORY
    if _ADAPTER_FACTORY is None:
        _ADAPTER_FACTORY = rt.RT.eval(
            "function(env) return AESA_RUNTIME.export.new(env) end")
    return _ADAPTER_FACTORY(env)


def normalize(lo):
    """Map the legacy injected stub names onto the DCS adapter's environment shape."""
    global _NORMALIZER
    if _NORMALIZER is None:
        _NORMALIZER = rt.RT.eval("""
            function(lo)
              local env = {}
              env.LoGetSelfData = lo.selfData
              env.LoGetVectorVelocity = lo.vectorVelocity
              env.LoGetWorldObjects = lo.worldObjects
              env.LoGetTargetInformation = lo.targets
              env.LoGetModelTime = lo.modelTime
              if lo.isVisible then env.terrain = { isVisible = lo.isVisible } end
              return env
            end
        """)
    return _NORMALIZER(lo)


def sample(lo, t=0.0):
    exporter = load_export()
    lines = []
    exporter.sample(t, make_adapter(normalize(lo)), lines.append)
    return lines


def rows(lines, prefix):
    return [line.split() for line in lines if line.startswith(prefix + " ")]


def make_lo(src):
    return rt.RT.eval(src)()


class CoalitionRegressions(unittest.TestCase):
    def test_coalition_id_wins_over_coalition_and_country(self):
        lo = make_lo("""
            function()
              return {
                selfData = function()
                  return {Name='OWN', Position={x=0,y=8000,z=0}}
                end,
                vectorVelocity = function() return {x=0,y=0,z=-200} end,
                worldObjects = function()
                  return {[11] = {Name='bandit', CoalitionID=1, coalition=2,
                                  Country=2, Position={x=0,y=8000,z=-1000}}}
                end,
              }
            end
        """)
        t = rows(sample(lo), "T")[0]
        self.assertEqual(t[4], "1")

    def test_coalition_missing_or_invalid_is_unknown_without_country_fallback(self):
        lo = make_lo("""
            function()
              return {
                selfData = function()
                  return {Name='OWN', Position={x=0,y=8000,z=0}}
                end,
                vectorVelocity = function() return {x=0,y=0,z=-200} end,
                worldObjects = function()
                  return {
                    [12] = {Name='legacy', coalition=2, Country=1,
                            Position={x=0,y=8000,z=-1000}},
                    [13] = {Name='missing', Position={x=100,y=8000,z=-1000}},
                    [14] = {Name='invalid', CoalitionID=7, coalition=2, Country=2,
                            Position={x=200,y=8000,z=-1000}},
                  }
                end,
              }
            end
        """)
        by_id = {t[2]: t for t in rows(sample(lo), "T")}
        self.assertEqual(by_id["12"][4], "unknown")
        self.assertEqual(by_id["13"][4], "unknown")
        self.assertEqual(by_id["14"][4], "unknown")


class VelocityRegressions(unittest.TestCase):
    def test_export_line_field_counts(self):
        lo = make_lo("""
            function()
              return {
                selfData = function()
                  return {Name='OWN', Position={x=0,y=8000,z=0}}
                end,
                vectorVelocity = function() return {x=0,y=0,z=-200} end,
                worldObjects = function()
                  return {[1] = {Name='t', CoalitionID=2,
                                 Position={x=0,y=8000,z=-1000}}}
                end,
              }
            end
        """)
        lines = sample(lo)
        self.assertEqual(len(rows(lines, "A")[0]), 10)
        self.assertEqual(len(rows(lines, "T")[0]), 12)

    def test_ownship_uses_vector_velocity(self):
        lo = make_lo("""
            function()
              return {
                selfData = function()
                  return {Name='OWN', Position={x=0,y=8000,z=0},
                          velocity={x=0,y=0,z=1}}
                end,
                vectorVelocity = function() return {x=10,y=20,z=30} end,
                worldObjects = function() return {} end,
              }
            end
        """)
        a = rows(sample(lo), "A")[0]
        self.assertEqual(a[6:9], ["10.000", "20.000", "30.000"])
        self.assertEqual(a[9], "1")

    def test_missing_vector_velocity_is_not_faked_by_selfdata(self):
        # LoGetSelfData 没有 velocity；即使旧桩塞了同名字段也不能当成有效速度。
        lo = make_lo("""
            function()
              return {
                selfData = function()
                  return {Name='OWN', Position={x=0,y=8000,z=0},
                          velocity={x=0,y=0,z=1}}
                end,
                worldObjects = function() return {} end,
              }
            end
        """)
        a = rows(sample(lo), "A")[0]
        self.assertEqual(a[6:9], ["0.000", "0.000", "0.000"])
        self.assertEqual(a[9], "0")

    def test_target_velocity_case_and_validity(self):
        lo = make_lo("""
            function()
              return {
                selfData = function()
                  return {Name='OWN', Position={x=0,y=8000,z=0}}
                end,
                vectorVelocity = function() return {x=0,y=0,z=-200} end,
                worldObjects = function()
                  return {
                    [21] = {Name='upper', Velocity={x=1,y=2,z=3},
                            Position={x=0,y=8000,z=-1000}},
                    [22] = {Name='lower', velocity={x=4,y=5,z=6},
                            Position={x=100,y=8000,z=-1000}},
                    [23] = {Name='none', Position={x=200,y=8000,z=-1000}},
                    [24] = {Name='both', Velocity={x=7,y=8,z=9},
                            velocity={x=10,y=11,z=12},
                            Position={x=300,y=8000,z=-1000}},
                  }
                end,
              }
            end
        """)
        by_id = {t[2]: t for t in rows(sample(lo), "T")}
        self.assertEqual(by_id["21"][8:11], ["1.000", "2.000", "3.000"])
        self.assertEqual(by_id["21"][11], "1")
        self.assertEqual(by_id["22"][8:11], ["4.000", "5.000", "6.000"])
        self.assertEqual(by_id["22"][11], "1")
        self.assertEqual(by_id["23"][8:11], ["0.000", "0.000", "0.000"])
        self.assertEqual(by_id["23"][11], "0")
        self.assertEqual(by_id["24"][8:11], ["10.000", "11.000", "12.000"])
        self.assertEqual(by_id["24"][11], "1")


class OrderingRegressions(unittest.TestCase):
    def test_targets_sorted_by_stable_object_id(self):
        lo = make_lo("""
            function()
              return {
                selfData = function()
                  return {Name='OWN', Position={x=0,y=8000,z=0}}
                end,
                vectorVelocity = function() return {x=0,y=0,z=-200} end,
                worldObjects = function()
                  return {
                    [9] = {Name='nine', Position={x=0,y=8000,z=-1000}},
                    [1] = {Name='one', Position={x=100,y=8000,z=-1000}},
                    [5] = {Name='five', Position={x=200,y=8000,z=-1000}},
                  }
                end,
              }
            end
        """)
        self.assertEqual([t[2] for t in rows(sample(lo), "T")], ["1", "5", "9"])


class FailClosedRegressions(unittest.TestCase):
    def test_missing_ownship_position_sends_nothing(self):
        lo = make_lo("""
            function()
              return {
                selfData = function() return {Name='OWN'} end,
                worldObjects = function()
                  return {[1] = {Name='t', Position={x=0,y=8000,z=-1000}}}
                end,
              }
            end
        """)
        self.assertEqual(sample(lo), [])

    def test_missing_selfdata_sends_nothing(self):
        lo = make_lo("""
            function()
              return {
                worldObjects = function()
                  return {[1] = {Name='t', Position={x=0,y=8000,z=-1000}}}
                end,
              }
            end
        """)
        self.assertEqual(sample(lo), [])

    def test_missing_visibility_emits_no_l_line(self):
        lo = make_lo("""
            function()
              return {
                selfData = function()
                  return {Name='OWN', Position={x=0,y=8000,z=0}}
                end,
                vectorVelocity = function() return {x=0,y=0,z=-200} end,
                worldObjects = function()
                  return {[1] = {Name='t', Position={x=0,y=8000,z=-1000}}}
                end,
              }
            end
        """)
        lines = sample(lo)
        self.assertEqual(len(rows(lines, "T")), 1)
        self.assertEqual(rows(lines, "L"), [])

    def test_missing_world_objects_is_not_an_error(self):
        lo = make_lo("""
            function()
              return {
                selfData = function()
                  return {Name='OWN', Position={x=0,y=8000,z=0}}
                end,
                vectorVelocity = function() return {x=0,y=0,z=-200} end,
              }
            end
        """)
        lines = sample(lo)
        self.assertEqual(len(rows(lines, "A")), 1)
        self.assertEqual(rows(lines, "T"), [])
        self.assertEqual(rows(lines, "E"), [])

    def test_missing_socket_logs_and_stops(self):
        rt.RT.execute("""
            _G.SENT, _G.LOGS = {}, {}
            _G.socket = nil
            _G.lfs = nil
            _G.package = nil
            _G.log = { write = function(tag, level, message)
              LOGS[#LOGS + 1] = message
              return true
            end }
            _G.LoGetModelTime = function() return 2.0 end
            _G.LoGetSelfData = function()
              return {Name='OWN', Position={x=0,y=8000,z=0}}
            end
            _G.LoGetVectorVelocity = function() return {x=0,y=0,z=-200} end
            _G.LoGetWorldObjects = function() return {} end
        """)
        exporter = load_export()
        exporter.frame_poll()
        self.assertIsNone(exporter.sock)
        logs = rt.RT.eval("table.concat(LOGS, '|')")
        self.assertIn("socket UNAVAILABLE", logs)

    def test_connect_sends_compat_after_v1(self):
        rt.RT.execute("""
            _G.SENT, _G.LOGS = {}, {}
            _G.lfs = nil
            _G.package = nil
            _G.log = { write = function(tag, level, message)
              LOGS[#LOGS + 1] = message
              return true
            end }
            _G.socket = { tcp = function()
              return {
                settimeout = function() end,
                connect = function() return true end,
                send = function(self, data) SENT[#SENT + 1] = data return #data end,
                close = function() end,
              }
            end }
            _G.LoGetModelTime = function() return 1.0 end
            _G.LoGetSelfData = function()
              return {Name='OWN', Position={x=0,y=8000,z=0}}
            end
            _G.LoGetVectorVelocity = function() return {x=0,y=0,z=-200} end
            _G.LoGetWorldObjects = function() return {} end
        """)
        exporter = load_export()
        exporter.frame_poll()
        profile_id = rt.RT.eval(
            "AESA_RUNTIME.profile.new(AESA_RUNTIME.profile_data, 'generated'):id()")
        matrix = rt.RT.eval(
            "AESA_RUNTIME.profile.new(AESA_RUNTIME.profile_data, 'generated'):matrix_hash()")
        first = rt.RT.eval("SENT[1]")
        self.assertEqual(first, "V1\nPROTO,2\nCOMPAT,%s,%s\n" % (profile_id, matrix))


class CompatProtocolRegressions(unittest.TestCase):
    def test_compat_line_is_parsed_and_recorded(self):
        kind, row = parse_line("COMPAT,dcs-2.9.30.28738-mt,1a2b3c4d")
        self.assertEqual(kind, "COMPAT")
        self.assertEqual(row["profile_id"], "dcs-2.9.30.28738-mt")
        self.assertEqual(row["matrix_hash"], "1a2b3c4d")
        buf = FrameBuffer()
        buf.feed("COMPAT,dcs-2.9.30.28738-mt,1a2b3c4d")
        self.assertEqual(buf.compat["matrix_hash"], "1a2b3c4d")

    def test_incomplete_compat_and_unknown_lines_are_ignored(self):
        self.assertIsNone(parse_line("COMPAT,only"))
        self.assertIsNone(parse_line("COMPAT,a,b,c"))
        buf = FrameBuffer()
        buf.feed("COMPAT,only")
        buf.feed("WHAT,ever")
        self.assertIsNone(buf.compat)


class ProtocolRegressions(unittest.TestCase):
    def test_real_probe_line_keeps_first_character(self):
        kind, row = parse_line(REAL_P)
        self.assertEqual(kind, "P")
        self.assertEqual(row["text"], REAL_P[2:])
        self.assertTrue(row["text"].startswith("Bank:number"))

    def test_empty_and_spaced_probe_lines(self):
        self.assertEqual(parse_line("P")[1]["text"], "")
        self.assertEqual(parse_line("P  Foo  Bar")[1]["text"], "Foo  Bar")
        self.assertEqual(parse_line("V1")[1]["text"], "")

    def test_legacy_a_and_t_lines_are_not_velocity_valid(self):
        kind, row = parse_line("A 0 OWN 0 8000 0 0 0 -200")
        self.assertEqual(kind, "A")
        self.assertFalse(row["vel_valid"])
        kind, row = parse_line("T 0 target F16 1 0 8000 -1000 0 0 200")
        self.assertEqual(kind, "T")
        self.assertFalse(row["vel_valid"])
        self.assertEqual(row["coalition"], 1)

    def test_out_of_range_coalition_normalizes_to_unknown(self):
        # 旧 Export 把 Country（如 7）写进 T 行；新解析器 fail-closed 为 unknown。
        kind, row = parse_line("T 0 target F16 7 0 8000 -1000 0 0 200")
        self.assertEqual(kind, "T")
        self.assertEqual(row["coalition"], "unknown")

    def test_new_lines_carry_velocity_validity(self):
        kind, row = parse_line("A 0 OWN 0 8000 0 0 0 -200 1")
        self.assertTrue(row["vel_valid"])
        kind, row = parse_line("T 0 target F16 2 0 8000 -1000 0 0 200 0")
        self.assertFalse(row["vel_valid"])
        kind, row = parse_line("T 0 target F16 unknown 0 8000 -1000 0 0 200 1")
        self.assertEqual(row["coalition"], "unknown")
        self.assertTrue(row["vel_valid"])

    def test_malformed_velocity_validity_rejects_known_line(self):
        self.assertIsNone(parse_line("A 0 OWN 0 8000 0 0 0 -200 2"))
        self.assertIsNone(parse_line("T 0 target F16 1 0 8000 -1000 0 0 200 x"))

    def test_frame_buffer_preserves_velocity_validity(self):
        buf = FrameBuffer()
        buf.feed("A 0 OWN 0 8000 0 0 0 -200 1")
        buf.feed("T 0 target F16 1 0 8000 -1000 0 0 200 0")
        buf.feed("T 0 other F16 unknown 1 8000 -1000 0 0 200 1")
        frame = buf.finish()[0]
        self.assertTrue(frame["own"]["vel_valid"])
        self.assertFalse(frame["targets"][0]["vel_valid"])
        self.assertEqual(frame["targets"][1]["coalition"], "unknown")
        self.assertTrue(frame["targets"][1]["vel_valid"])

    def test_estimate_does_not_mark_differential_velocity_valid(self):
        frames = [
            {"t": 0.0, "own": {"pos": (0, 0, 0), "vel": (0, 0, 0), "vel_valid": False},
             "targets": []},
            {"t": 1.0, "own": {"pos": (0, 0, -100), "vel": (0, 0, 0), "vel_valid": False},
             "targets": []},
        ]
        estimate_velocities(frames)
        self.assertAlmostEqual(frames[1]["own"]["vel"][2], -100.0)
        self.assertFalse(frames[1]["own"]["vel_valid"])

    def test_estimate_trusts_explicit_valid_zero(self):
        frames = [
            {"t": 0.0, "own": {"pos": (0, 0, 0), "vel": (0, 0, 0), "vel_valid": True},
             "targets": []},
            {"t": 1.0, "own": {"pos": (0, 0, -100), "vel": (0, 0, 0), "vel_valid": True},
             "targets": []},
        ]
        estimate_velocities(frames)
        self.assertEqual(frames[1]["own"]["vel"], (0, 0, 0))


class LiveVelocityPatchRegressions(unittest.TestCase):
    def test_patcher_trusts_explicit_valid_zero(self):
        patcher = VelocityPatcher()
        patcher.patch("own", 0.0, (0, 0, 0), (0, 0, 0), True)
        self.assertEqual(patcher.patch("own", 1.0, (0, 0, -100), (0, 0, 0), True),
                         (0, 0, 0))

    def test_live_uses_receiver_patcher(self):
        import live
        core = live.LiveCore()
        self.assertFalse(hasattr(core, "_patch_vel"))
        self.assertIsInstance(core.vel_patcher, VelocityPatcher)
        core.feed({"t": 0.0,
                   "own": {"typeName": "OWN", "pos": (0, 8000, 0), "vel": (0, 0, 0)},
                   "targets": [{"id": "t1", "typeName": "F16", "coalition": 1,
                                "pos": (1000, 8000, 0), "vel": (0, 0, 0)}]})
        core.feed({"t": 1.0,
                   "own": {"typeName": "OWN", "pos": (0, 8000, -100), "vel": (0, 0, 0)},
                   "targets": [{"id": "t1", "typeName": "F16", "coalition": 1,
                                "pos": (1000, 8000, -200), "vel": (0, 0, 0)}]})
        self.assertAlmostEqual(core.last_frame["own"]["vel"][2], -100.0)
        self.assertAlmostEqual(core.last_frame["targets"][0]["vel"][2], -200.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)

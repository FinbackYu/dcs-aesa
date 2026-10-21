# -*- coding: utf-8 -*-
"""Gate 1 回归：搜索俯仰条带不得留下大于 HPBW 的盲带。

Bug：旧 config.lua 的 el_bars_deg 间距 6°，core/beam.evaluate 的俯仰门宽由
hpbw_el_deg=3° 决定（半宽 1.5°），相邻条带间因此存在 3° 盲带。

约定：条带中心按升序排列；相邻中心间距必须 <= hpbw_el_deg。
默认配置（src/shared/config.lua 生成物）满足该约束；config_validate 会在
init.build 加载默认或注入配置时拒绝违反约束的配置。

运行：
    python tests/test_gate1_physics.py
    python -m unittest discover -s tests -p "test_gate*.py"
"""
import math
import os
import unittest

import lupa.lua51 as lupa

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src", "core")
SHARED = os.path.join(ROOT, "src", "shared")

RT = lupa.LuaRuntime(unpack_returned_tuples=True)
_LOAD = RT.eval(
    "function(src, name) local f, e = loadstring(src, name)"
    " if not f then error(e, 2) end return f() end"
)


def load_lua(path, name):
    with open(path, "r", encoding="utf-8") as f:
        return _LOAD(f.read(), name)


def lua_table(value):
    return RT.table_from(value, recursive=True)


def pcall(fn, arg):
    ok, err = RT.eval("function(f, x) return pcall(f, x) end")(fn, arg)
    return bool(ok), err


class ElevationBarCoverageTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cfg = load_lua(os.path.join(SHARED, "config.lua"), "config")
        cls.validator = load_lua(os.path.join(SHARED, "config_validate.lua"),
                                 "config_validate")
        cls.constants = load_lua(os.path.join(SRC, "constants.lua"), "constants")
        cls.constants.configure(lua_table({
            "c_mps": cls.cfg["physics"]["c_mps"],
            "boltzmann_j_per_k": cls.cfg["physics"]["boltzmann_j_per_k"],
            "t0_k": cls.cfg["physics"]["t0_k"],
        }))
        cls.physics = load_lua(os.path.join(SRC, "physics.lua"), "physics")
        cls.physics.bind(lua_table({"constants": cls.constants}))
        cls.beam = load_lua(os.path.join(SRC, "beam.lua"), "beam")
        cls.geometry = load_lua(os.path.join(SRC, "geometry.lua"), "geometry")
        cls.geometry.bind(lua_table({"beam": cls.beam}))
        cls.rc = cls.cfg["radar"]
        cls.search = cls.cfg["scheduler"]["search"]
        bars = cls.search["el_bars_deg"]
        cls.bars = [float(bars[i]) for i in range(1, len(bars) + 1)]
        cls.hpbw = float(cls.rc["hpbw_el_deg"])

    def _covers(self, target_el_deg, bar_el_deg, az_deg=0.0):
        """目标在给定方位/仰角时，波束（本体系 az/el）是否落在检测门内。

        目标方向按机体基精确构造（航向 0 = 北），确保 ENU 几何与机体系角度一致。
        """
        own = lua_table({
            "pos": {"x": 0.0, "y": 0.0, "z": 0.0},
            "vel": {"x": 0.0, "y": 0.0, "z": 0.0},
        })
        el = math.radians(target_el_deg)
        az = math.radians(az_deg)
        target = lua_table({
            "pos": {"x": 50000.0 * math.cos(el) * math.sin(az),
                    "y": 50000.0 * math.cos(el) * math.cos(az),
                    "z": 50000.0 * math.sin(el)},
            "vel": {"x": 0.0, "y": 0.0, "z": 0.0},
        })
        dwell = lua_table({"az": az, "el": math.radians(bar_el_deg)})
        return bool(self.geometry.geometry(self.rc, own, target, dwell)["in_gate"])

    def test_default_bar_spacing_does_not_exceed_hpbw(self):
        self.assertGreaterEqual(len(self.bars), 2, "默认搜索至少需要两个俯仰条带")
        for lo, hi in zip(self.bars, self.bars[1:]):
            self.assertLessEqual(
                hi - lo, self.hpbw + 1e-12,
                "相邻俯仰条带 %.3f° / %.3f° 间距 %.3f° 超过 hpbw_el=%.3f°"
                % (lo, hi, hi - lo, self.hpbw))

    def test_adjacent_bar_boundary_is_covered(self):
        """相邻条带中点必须至少被一侧波束覆盖，不允许出现盲带。"""
        for lo, hi in zip(self.bars, self.bars[1:]):
            mid = 0.5 * (lo + hi)
            hits = [bar for bar in (lo, hi) if self._covers(mid, bar)]
            self.assertTrue(
                hits,
                "%.3f° 处存在盲带：条带 %.3f° / %.3f° 均未覆盖" % (mid, lo, hi))

    def test_level_flight_is_covered_at_azimuth_cell_boundary(self):
        """方位栅格最坏偏角（相邻波束中心之间）时，0° 仰角仍须有波束覆盖。

        圆形检测门会同时消耗方位/仰角余量；若没有 0° 附近的条带，
        平飞目标会在方位格点之间掉出所有条带。
        """
        az_step = float(self.search["az_step_deg"])
        for az_off in (0.0, 0.25 * az_step, 0.5 * az_step):
            covered = [bar for bar in self.bars if self._covers(0.0, bar, az_deg=az_off)]
            self.assertTrue(
                covered,
                "方位偏角 %.3f° 时 0° 仰角无条带覆盖（条带 %s）" % (az_off, self.bars))

    def test_elevation_coverage_is_continuous(self):
        """从最低条带下边缘到最高条带上边缘，逐点扫描无任何空隙。"""
        lo = self.bars[0] - self.hpbw / 2.0
        hi = self.bars[-1] + self.hpbw / 2.0
        step = 0.05
        n = int(round((hi - lo) / step))
        for i in range(n + 1):
            el = lo + i * step
            covered = [bar for bar in self.bars if self._covers(el, bar)]
            self.assertTrue(
                covered,
                "仰角 %.3f° 未被任何条带覆盖（条带 %s）" % (el, self.bars))

    def test_loader_rejects_legacy_six_degree_bars(self):
        """init.build 必须校验配置：把生成配置的条带改回旧 6° 间距直接报错。"""
        bad = load_lua(os.path.join(SHARED, "config.lua"), "config-blind-band")
        bad["scheduler"]["search"]["el_bars_deg"] = lua_table([-6.0, 0.0, 6.0])
        init = load_lua(os.path.join(SRC, "init.lua"), "init")
        make_opts = RT.eval("function(cfg) return { config = cfg } end")
        with self.assertRaises(Exception) as ctx:
            init.build(SRC, make_opts(bad))
        self.assertIn("blind band", str(ctx.exception).lower())

    def test_validation_accepts_default_config(self):
        ok, err = pcall(self.validator.validate, self.cfg)
        self.assertTrue(ok, "默认配置应通过校验: %s" % err)

    def test_validation_accepts_spacing_equal_to_hpbw(self):
        cfg = lua_table({
            "radar": {"hpbw_el_deg": 3.0},
            "scheduler": {"search": {"el_bars_deg": [-4.5, -1.5, 1.5, 4.5]}},
        })
        ok, err = pcall(self.validator.validate, cfg)
        self.assertTrue(ok, "间距等于 HPBW 时应接受: %s" % err)

    def test_validation_rejects_legacy_six_degree_bars(self):
        """旧配置（-6/0/6）必须启动失败，不能静默接受盲带。"""
        cfg = lua_table({
            "radar": {"hpbw_el_deg": 3.0},
            "scheduler": {"search": {"el_bars_deg": [-6.0, 0.0, 6.0]}},
        })
        ok, err = pcall(self.validator.validate, cfg)
        self.assertFalse(ok, "6° 间距配 3° 波束必须被拒绝")
        self.assertIn("blind band", str(err).lower(), "错误信息应说明盲带: %s" % err)

    def test_validation_rejects_unsorted_bars(self):
        """条带必须升序；否则相邻比较会漏掉真实空隙。"""
        cfg = lua_table({
            "radar": {"hpbw_el_deg": 3.0},
            "scheduler": {"search": {"el_bars_deg": [0.0, 6.0, -6.0]}},
        })
        ok, err = pcall(self.validator.validate, cfg)
        self.assertFalse(ok, "未排序条带必须被拒绝")


if __name__ == "__main__":
    unittest.main(verbosity=2)

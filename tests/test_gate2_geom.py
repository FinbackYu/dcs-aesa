#!/usr/bin/env python3
"""Gate 2 canonical scene/MAP geometry vectors (Lua 5.1 side).

Runs ``src/sar_core/geometry.lua`` through DCS's Lua 5.1 (``luae.exe``) and
checks the fixed vectors that the JS twin (``src/sar_core/geometry.cjs``) also
uses. The Node test ``tests/test_sar_gate2_geom.cjs`` additionally feeds the
same vectors through both languages and compares them value by value.

Coverage: patch centre and four corners, bearings 0/45/90/135/180/270,
odd and even texel counts, clamp boundaries, and the four MAP corners.
Grid sizes come from the generated ``tests/fixtures/config.json``; the
expected values are frozen in this test. Run directly:
``python tests/test_gate2_geom.py``.
"""
import json
import math
import os
import shutil
import subprocess
import tempfile
import unittest

import find_tools

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODULE = os.path.join(ROOT, "src", "sar_core", "geometry.lua")
TOL = 1e-9

# Grid sizes come from the Gate 2 generated fixture, not a second copy in the test.
with open(os.path.join(ROOT, "tests", "fixtures", "config.json"),
          encoding="utf-8") as _handle:
    _FOOTPRINTS = json.load(_handle)["config"]["sar"]["footprints"]
DETAIL = _FOOTPRINTS["detail"]
AREA = _FOOTPRINTS["area"]
AIRPORT = _FOOTPRINTS["airport"]
DETAIL_SIZE = float(DETAIL["size_m"])
DETAIL_N = DETAIL["n"]
AREA_SIZE = float(AREA["size_m"])
AREA_N = AREA["n"]
AIRPORT_SIZE = float(AIRPORT["size_m"])
AIRPORT_N = AIRPORT["n"]


def find_lua():
    """Same discovery order as tests/test_gate1_native.py."""
    candidates = find_tools.lua_candidates()
    for candidate in candidates:
        if not (candidate and os.path.isfile(candidate)):
            continue
        try:
            result = subprocess.run(
                [candidate, "-e", "io.write(_VERSION)"], capture_output=True,
                text=True, encoding="utf-8", errors="replace", timeout=15)
        except OSError:
            continue
        if result.returncode == 0 and result.stdout.strip() == "Lua 5.1":
            return os.path.abspath(candidate)
    return None


LUA = find_lua()

# (center, bearing, cross, ground, world x, world z). Expected values are the
# canonical formula evaluated once and frozen; tolerance is 1e-9.
SCENE_CASES = [
    ((1000.0, 500.0, -2000.0), 0.0, 0.0, 0.0, 1000.0, -2000.0),
    ((1000.0, 500.0, -2000.0), 0.0, 64.0, 64.0, 1064.0, -2064.0),
    ((1000.0, 500.0, -2000.0), 0.0, -64.0, -64.0, 936.0, -1936.0),
    ((1000.0, 500.0, -2000.0), 0.0, 64.0, -64.0, 936.0, -2064.0),
    ((1000.0, 500.0, -2000.0), 0.0, -64.0, 64.0, 1064.0, -1936.0),
    ((1000.0, 500.0, -2000.0), math.pi / 4, 64.0, -32.0,
     1022.6274169979695, -2067.8822509939087),
    ((1000.0, 500.0, -2000.0), math.pi / 2, 32.0, 64.0, 1032.0, -1936.0),
    ((1000.0, 500.0, -2000.0), 3 * math.pi / 4, -64.0, 32.0,
     932.1177490060915, -2022.6274169979695),
    ((1000.0, 500.0, -2000.0), math.pi, 10.0, 20.0, 980.0, -1990.0),
    ((1000.0, 500.0, -2000.0), 3 * math.pi / 2, -10.0, -20.0, 1010.0, -1980.0),
    ((0.0, 0.0, 0.0), math.pi / 4, 64.0, 64.0, 90.50966799187808, 0.0),
    ((0.0, 0.0, 0.0), math.pi / 4, -64.0, 64.0, 0.0, 90.50966799187808),
    ((0.0, 0.0, 0.0), math.pi / 2, 64.0, -64.0, 64.0, -64.0),
    ((0.0, 0.0, 0.0), 3 * math.pi / 4, 64.0, 64.0, 0.0, 90.50966799187808),
    ((0.0, 0.0, 0.0), 3 * math.pi / 4, -64.0, 64.0, -90.50966799187808, 0.0),
]

TEXEL_CASES = [
    (0.0, 0.0, DETAIL_SIZE, DETAIL_N, 8.0, 8.0),
    (-64.0, -64.0, DETAIL_SIZE, DETAIL_N, 0.0, 0.0),
    (64.0, 64.0, DETAIL_SIZE, DETAIL_N, 16.0, 16.0),
    (16.0, -16.0, DETAIL_SIZE, DETAIL_N, 10.0, 6.0),
    (0.0, 0.0, AREA_SIZE, AREA_N, 16.0, 16.0),
    (256.0, -256.0, AREA_SIZE, AREA_N, 32.0, 0.0),
    (0.0, 0.0, AIRPORT_SIZE, AIRPORT_N, 32.0, 32.0),
    (0.0, 0.0, 300.0, 4, 1.5, 1.5),
    (0.0, 0.0, 300.0, 5, 2.0, 2.0),
    (DETAIL_SIZE, -DETAIL_SIZE, DETAIL_SIZE, DETAIL_N, 24.0, -8.0),
]

# (index, n, epsilon or None, expected)
CLAMP_CASES = [
    (-0.5, DETAIL_N, None, 0.0),
    (0.0, DETAIL_N, None, 0.0),
    (8.0, DETAIL_N, None, 8.0),
    (16.0, DETAIL_N, None, 16.0),
    (16.5, DETAIL_N, None, 16.0),
    (16.0000005, DETAIL_N, None, 16.0),
    (16.0000005, DETAIL_N, 1e-6, 15.999999),
    (0.0000005, DETAIL_N, 1e-6, 0.0000005),
    (4.7, 4, None, 3.0),
    (0.5, 1, None, 0.0),
]

# (index, size, n, expected)
PIXEL_CENTER_CASES = [
    (0, DETAIL_SIZE, DETAIL_N, -64.0),
    (8, DETAIL_SIZE, DETAIL_N, 0.0),
    (16, DETAIL_SIZE, DETAIL_N, 64.0),
    (10, DETAIL_SIZE, DETAIL_N, 16.0),
    (0, AREA_SIZE, AREA_N, -256.0),
    (16, AREA_SIZE, AREA_N, 0.0),
    (32, AIRPORT_SIZE, AIRPORT_N, 0.0),
    (1, 300.0, 4, -50.0),
    (2, 300.0, 4, 50.0),
    (0, 300.0, 5, -150.0),
    (4, 300.0, 5, 150.0),
]

# (x0, z0, step, col, row, world x, world z)
MAP_CASES = [
    (-500.0, -500.0, 250.0, 0.0, 0.0, -500.0, -500.0),
    (-500.0, -500.0, 250.0, 4.0, 0.0, 500.0, -500.0),
    (-500.0, -500.0, 250.0, 0.0, 4.0, -500.0, 500.0),
    (-500.0, -500.0, 250.0, 4.0, 4.0, 500.0, 500.0),
    (-500.0, -500.0, 250.0, 2.0, 2.0, 0.0, 0.0),
    (1000.0, -2000.0, 25.0, 3.0, 2.0, 1075.0, -1950.0),
    (1000.0, -2000.0, 25.0, 1.5, 0.5, 1037.5, -1987.5),
    (-1000.0, 500.0, 100.0, -2.0, -3.0, -1200.0, 200.0),
]

# (x0, z0, step, world x, world z, col, row)
MAP_INV_CASES = [
    (-500.0, -500.0, 250.0, 125.0, -375.0, 2.5, 0.5),
    (-500.0, -500.0, 250.0, 500.0, 500.0, 4.0, 4.0),
    (1000.0, -2000.0, 25.0, 1075.0, -1950.0, 3.0, 2.0),
    (1000.0, -2000.0, 25.0, 1037.5, -1987.5, 1.5, 0.5),
    (-1000.0, 500.0, 100.0, -1200.0, 200.0, -2.0, -3.0),
]


def lua_number(value):
    return repr(float(value))


def lua_literal(value):
    if isinstance(value, (tuple, list)):
        return "{" + ",".join(lua_number(v) for v in value) + "}"
    return lua_number(value)


class SceneGeometryLuaTest(unittest.TestCase):
    maxDiff = None

    def run_lua(self, calls, prelude=None):
        """calls: [(lua expression, expected tuple)]. Returns actual tuples."""
        script = [
            "local g = dofile([==[" + MODULE.replace("\\", "/") + "]==])",
            "if os and os.setlocale then pcall(os.setlocale, \"C\") end",
            "local function e(...)",
            "  local t = {...}",
            "  local o = {}",
            '  for i = 1, #t do o[i] = string.format("%.17g", t[i]) end',
            '  io.write(table.concat(o, " "), "\\n")',
            "end",
        ]
        if prelude:
            script.extend(prelude)
        script.extend(expression for expression, _ in calls)
        script.append('io.write("DONE\\n")')
        with tempfile.TemporaryDirectory(prefix="aesa-geom-") as tmp:
            path = os.path.join(tmp, "vectors.lua")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write("\n".join(script) + "\n")
            result = subprocess.run(
                [LUA, path], cwd=ROOT, capture_output=True, text=True,
                encoding="utf-8", errors="replace", timeout=60)
        self.assertEqual(result.returncode, 0,
                         "luae failed:\n" + (result.stderr or result.stdout))
        lines = [line.strip() for line in result.stdout.splitlines()
                 if line.strip()]
        self.assertTrue(lines and lines[-1] == "DONE",
                        "luae output missing DONE:\n" + result.stdout)
        values = [[float(token) for token in line.split()]
                  for line in lines[:-1]]
        self.assertEqual(len(values), len(calls),
                         "luae returned a different number of rows:\n"
                         + result.stdout)
        for index, (actual, (_, expected)) in enumerate(zip(values, calls)):
            self.assertEqual(len(actual), len(expected),
                             f"call {index} returned {len(actual)} values")
            for component, (got, want) in enumerate(zip(actual, expected)):
                self.assertLessEqual(
                    abs(got - want), TOL,
                    f"call {index} component {component}: {got!r} != {want!r}")
        return values

    def test_scene_to_world_vectors(self):
        calls = [
            ("e(g.sceneToWorld(%s, %s, %s, %s))"
             % (lua_literal(center), lua_number(bearing),
                lua_number(cross), lua_number(ground)),
             (x, z))
            for center, bearing, cross, ground, x, z in SCENE_CASES
        ]
        self.run_lua(calls)

    def test_world_to_scene_inverse(self):
        calls = [
            ("e(g.worldToScene(%s, %s, %s, %s))"
             % (lua_literal(center), lua_number(bearing),
                lua_number(x), lua_number(z)),
             (cross, ground))
            for center, bearing, cross, ground, x, z in SCENE_CASES
        ]
        self.run_lua(calls)

    def test_texel_index_vectors(self):
        calls = [
            ("e(g.texelIndex(%s, %s, %s, %d))"
             % (lua_number(cross), lua_number(ground),
                lua_number(size), n),
             (col, row))
            for cross, ground, size, n, col, row in TEXEL_CASES
        ]
        self.run_lua(calls)

    def test_clamp_pixel_vectors(self):
        calls = []
        for index, n, epsilon, expected in CLAMP_CASES:
            if epsilon is None:
                expression = "e(g.clampPixel(%s, %d))" % (
                    lua_number(index), n)
            else:
                expression = "e(g.clampPixel(%s, %d, %s))" % (
                    lua_number(index), n, lua_number(epsilon))
            calls.append((expression, (expected,)))
        self.run_lua(calls)

    def test_pixel_center_vectors(self):
        calls = [
            ("e(g.pixelCenter(%d, %s, %d))"
             % (index, lua_number(size), n), (center,))
            for index, size, n, center in PIXEL_CENTER_CASES
        ]
        self.run_lua(calls)

    def test_map_cell_vectors(self):
        calls = [
            ("e(g.mapCellToWorld(%s, %s, %s, %s, %s))"
             % (lua_number(x0), lua_number(z0), lua_number(step),
                lua_number(col), lua_number(row)), (x, z))
            for x0, z0, step, col, row, x, z in MAP_CASES
        ]
        calls.extend(
            ("e(g.worldToMapCell(%s, %s, %s, %s, %s))"
             % (lua_number(x0), lua_number(z0), lua_number(step),
                lua_number(x), lua_number(z)), (col, row))
            for x0, z0, step, x, z, col, row in MAP_INV_CASES
        )
        self.run_lua(calls)

    def test_scene_grid_composition_odd_and_even_n(self):
        """texelIndex -> clampPixel -> pixelCenter -> sceneToWorld hits the same corners."""
        script_calls = [
            "local function grid(center, bearing, cross, ground, size, n)",
            "  local col, row = g.texelIndex(cross, ground, size, n)",
            "  local c = g.pixelCenter(g.clampPixel(col, n), size, n)",
            "  local r = g.pixelCenter(g.clampPixel(row, n), size, n)",
            "  return g.sceneToWorld(center, bearing, c, r)",
            "end",
        ]
        calls = []
        for size, n in ((DETAIL_SIZE, DETAIL_N), (300.0, 4),
                        (300.0, 5), (AREA_SIZE, AREA_N),
                        (AIRPORT_SIZE, AIRPORT_N)):
            for bearing in (0.0, math.pi / 4, math.pi / 2, 3 * math.pi / 4):
                for cross in (-size / 2, size / 2):
                    for ground in (-size / 2, size / 2):
                        # Expected direct mapping of the same corner.
                        x = cross * math.sin(bearing) + ground * math.cos(bearing)
                        z = -cross * math.cos(bearing) + ground * math.sin(bearing)
                        calls.append(
                            ("e(grid({0,0,0}, %s, %s, %s, %s, %d))"
                             % (lua_number(bearing), lua_number(cross),
                                lua_number(ground), lua_number(size), n),
                             (x, z)))
        # The helper definitions must precede the calls.
        self.run_lua(calls, prelude=script_calls)


if LUA is None:
    SceneGeometryLuaTest = unittest.skip(
        "Lua 5.1 (luae.exe) not found; set AESA_LUA or AESA_DCS_BIN")(
            SceneGeometryLuaTest)


if __name__ == "__main__":
    unittest.main(verbosity=2)

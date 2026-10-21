# -*- coding: utf-8 -*-
"""Gate 1 RCS 回归测试：fallback schema、导弹兜底与缺键 fail-closed。

覆盖：
- 生成器输出的 fallback 必须包含 rcs.lua 实际使用的四个键；
- 未知导弹目标必须落到 missile 档，而不是 fighter 档；
- rcs_data.fallback 缺任一键时，rcs.new 必须抛出清晰错误而不是静默 nil。

用法：python tests/test_gate1_rcs.py
"""
import os
import sys
import tempfile
import unittest

import lupa.lua51 as lupa

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ADAPTERS = os.path.join(ROOT, "src", "adapters", "dcs")
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

import extract_rcs  # noqa: E402

# 与 src/adapters/dcs/rcs.lua 的消费者保持一致：large 是轰炸机/大型平台档。
REQUIRED_FALLBACK = ("fighter", "large", "helicopter", "missile")

RT = lupa.LuaRuntime(unpack_returned_tuples=True)
_LOADER = RT.eval(
    "function(src, name) local f, e = loadstring(src, name)"
    " if not f then error(e, 2) end return f() end"
)


def load_lua(path, name):
    with open(path, encoding="utf-8") as f:
        return _LOADER(f.read(), name)


def as_lua_table(value):
    return RT.table_from(value, recursive=True)


def provider_get(provider, name):
    return getattr(provider, "get")(provider, name)


class GeneratorSchemaTest(unittest.TestCase):
    def test_generator_document_has_full_fallback_schema(self):
        with tempfile.TemporaryDirectory() as tmp:
            unit_dir = os.path.join(tmp, "CoreMods", "aircraft", "Gate1")
            os.makedirs(unit_dir)
            with open(os.path.join(unit_dir, "entry.lua"), "w", encoding="utf-8") as f:
                f.write('Name = "Gate1-RCS-Test"\nRCS = 3.5\n')

            entries, _, _ = extract_rcs.extract(tmp)
            self.assertEqual(entries.get("Gate1-RCS-Test"), 3.5)
            document = extract_rcs.render_document(entries)

        data = _LOADER(document, "rcs_data_generated")
        fallback = data["fallback"]
        for key in REQUIRED_FALLBACK:
            self.assertIsNotNone(
                fallback[key],
                "生成器 fallback 缺少键 %r；rcs.lua 会对该类目标取到 nil" % key,
            )
        self.assertAlmostEqual(fallback["missile"], 0.05, places=9)
        self.assertEqual(data["map"]["Gate1-RCS-Test"], 3.5)

        # missile=0.05 是项目设定，不是官方明文值；生成物必须保留来源注释。
        self.assertIn("【设定】", document)
        self.assertIn("missile = 0.05", document)


class CommittedDataTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = load_lua(os.path.join(ADAPTERS, "rcs_data.lua"), "rcs_data")

    def test_committed_data_has_full_fallback_schema(self):
        fallback = self.data["fallback"]
        for key in REQUIRED_FALLBACK:
            self.assertIsNotNone(fallback[key], "rcs_data.lua fallback 缺少 %r" % key)
        self.assertAlmostEqual(fallback["missile"], 0.05, places=9)

    def test_committed_map_is_not_empty(self):
        self.assertGreater(sum(1 for _ in self.data["map"].items()), 0)


class ProviderFallbackTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rcs = load_lua(os.path.join(ADAPTERS, "rcs.lua"), "dcs_rcs")
        cls.data = load_lua(os.path.join(ADAPTERS, "rcs_data.lua"), "rcs_data")

    def test_unknown_missile_target_uses_missile_tier(self):
        provider = self.rcs.new(self.data)
        for name in ("AGM_65D", "AIM-120C", "Kh-31P"):
            with self.subTest(name=name):
                value = provider_get(provider, name)
                self.assertEqual(value["source"], "fallback-estimate")
                self.assertAlmostEqual(value["rcs_m2"], 0.05, places=9)

    def test_each_tier_is_consumed(self):
        data = as_lua_table({
            "map": {},
            "fallback": {
                "fighter": 11.0,
                "large": 22.0,
                "helicopter": 33.0,
                "missile": 44.0,
            },
        })
        provider = self.rcs.new(data)
        cases = {
            "SomeUnknownFighter": 11.0,
            "KC-135": 22.0,
            "Mi-24V": 33.0,
            "AGM_65D": 44.0,
        }
        for name, expected in cases.items():
            with self.subTest(name=name):
                value = provider_get(provider, name)
                self.assertEqual(value["source"], "fallback-estimate")
                self.assertAlmostEqual(value["rcs_m2"], expected, places=9)

    def test_missing_fallback_key_raises_clear_error(self):
        for missing in REQUIRED_FALLBACK:
            with self.subTest(missing=missing):
                fallback = {
                    key: 1.0 for key in REQUIRED_FALLBACK if key != missing
                }
                data = as_lua_table({"map": {}, "fallback": fallback})
                with self.assertRaises(lupa.LuaError) as caught:
                    self.rcs.new(data)
                message = str(caught.exception)
                self.assertIn("fallback", message)
                self.assertIn("'%s'" % missing, message)

    def test_missing_fallback_table_raises_clear_error(self):
        data = as_lua_table({"map": {}})
        with self.assertRaises(lupa.LuaError) as caught:
            self.rcs.new(data)
        self.assertIn("fallback", str(caught.exception))


if __name__ == "__main__":
    unittest.main()

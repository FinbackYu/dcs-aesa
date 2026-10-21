import os
import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path

import find_tools

ROOT = Path(__file__).resolve().parents[1]
PROTOCOL = json.loads((ROOT / "spec" / "protocol.json").read_text(encoding="utf-8"))
DISPLAY = json.loads((ROOT / "spec" / "display.json").read_text(encoding="utf-8"))
DEPLOYMENT = json.loads((ROOT / "spec" / "deployment.json").read_text(encoding="utf-8"))


def find_lua():
    return find_tools.find_lua()


def discover_node():
    return shutil.which("node")


class Gate2ConfigTest(unittest.TestCase):
    def run_node(self, args, timeout=120):
        node = discover_node()
        if not node:
            self.skipTest("node not found; cannot run Gate 2 contract checks")
        env = os.environ.copy()
        lua = find_lua()
        if lua:
            env.setdefault("AESA_LUA", lua)
        result = subprocess.run(
            [node, *args],
            cwd=str(ROOT),
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
        return result

    def test_gen_config_check(self):
        result = self.run_node(["scripts/gen_config.cjs", "--check"])
        self.assertEqual(
            result.returncode,
            0,
            f"gen_config --check failed\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}",
        )
        self.assertIn("generated files match spec", result.stdout)

    def test_node_contract_suite(self):
        result = self.run_node(["--test", "tests/test_gate2_config.cjs"])
        self.assertEqual(
            result.returncode,
            0,
            f"Gate 2 Node suite failed\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}",
        )

    def test_generated_headers_and_fixture(self):
        checks = [
            "src/shared/config.lua",
            "src/shared/protocol.lua",
            "src/shared/config.cjs",
            "src/native/generated/config.h",
        ]
        for relative in checks:
            text = (ROOT / relative).read_text(encoding="utf-8")
            self.assertIn("DO NOT EDIT", text, relative)
            self.assertIn("scripts/gen_config.cjs", text, relative)
            self.assertRegex(text, r"input-sha256[:=]\s*[0-9a-f]{64}", relative)
        fixture = (ROOT / "tests/fixtures/config.json").read_text(encoding="utf-8")
        self.assertIn('"DO_NOT_EDIT": true', fixture)
        self.assertRegex(fixture, r'"input_sha256": "[0-9a-f]{64}"')
        docs = (ROOT / "docs/config-reference.md").read_text(encoding="utf-8")
        self.assertIn("本文件由生成器从", docs)
        self.assertRegex(docs, r"input-sha256.*[0-9a-f]{64}")
        for spec in ("physics", "radar", "sar", "protocol", "deployment", "display"):
            self.assertTrue((ROOT / "spec" / f"{spec}.json").is_file(), spec)

    def test_lua_51_loadfile(self):
        lua = find_lua()
        if not lua:
            self.skipTest("Lua 5.1 (luae.exe) not found")
        ports = PROTOCOL["ports"]
        db = DISPLAY["db"]
        scripts_root = DEPLOYMENT["saved_games"]["scripts_root"]
        script = (
            "assert(loadfile('src/shared/config.lua'));"
            "assert(loadfile('src/shared/protocol.lua'));"
            "local c=dofile('src/shared/config.lua');"
            "local p=dofile('src/shared/protocol.lua');"
            "local v=dofile('src/shared/config_validate.lua');"
            "assert(v.validate(c));"
            f"assert(p.ports.aa_export=={ports['aa_export']} and p.ports.sar_scene=={ports['sar_scene']});"
            f"assert(p.db.step=={db['step']} and p.db.no_data=={db['no_data']});"
            f"assert(c.deployment.saved_games.scripts_root=='{scripts_root}');"
            "print('lua51 ok')"
        )
        result = subprocess.run(
            [lua, "-e", script],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
        )
        self.assertEqual(
            result.returncode,
            0,
            f"Lua load failed\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}",
        )
        self.assertIn("lua51 ok", result.stdout)

    def test_no_nan_in_specs(self):
        for name in ("physics", "radar", "sar", "protocol", "deployment", "display"):
            text = (ROOT / "spec" / f"{name}.json").read_text(encoding="utf-8")
            self.assertNotRegex(text, r"\bNaN\b")
            self.assertNotRegex(text, r"\bInfinity\b")


if __name__ == "__main__":
    unittest.main()

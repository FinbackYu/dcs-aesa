import json
import os
import re
import shutil
import subprocess
import unittest
from pathlib import Path

import find_tools

ROOT = Path(__file__).resolve().parents[1]
PROFILE_ID = "dcs-2.9.30.28738-mt"
PROFILE_LUA = f"src/adapters/dcs/compat/profiles/{PROFILE_ID}.lua"
GENERIC_LUA = "src/adapters/dcs/compat/profiles/dcs-generic.lua"
HEADER = "src/native/abi/dcs_profile.h"
FIXTURE = "tests/fixtures/dcs_profile.json"


def find_lua():
    return find_tools.find_lua()


def discover_node():
    return shutil.which("node")


def fnv1a32(text):
    value = 0x811C9DC5
    for byte in text.encode("utf-8"):
        value ^= byte
        value = (value * 0x01000193) & 0xFFFFFFFF
    return f"{value:08x}"


def parse_macros(header):
    macros = {}
    for line in header.splitlines():
        match = re.match(r"^#define\s+([A-Z0-9_]+)\s+(.+?)(?:\s*/\*.*)?$", line)
        if not match:
            continue
        name, raw = match.group(1), match.group(2).strip()
        if raw.startswith('"') and raw.endswith('"'):
            value = raw[1:-1]
        elif re.match(r"^0x[0-9a-f]+$", raw, re.IGNORECASE):
            value = int(raw, 16)
        elif re.match(r"^-?\d+$", raw):
            value = int(raw)
        else:
            value = raw
        macros[name] = value
    return macros


class Gate3ProfileTest(unittest.TestCase):
    def run_node(self, args, timeout=180):
        node = discover_node()
        if not node:
            self.skipTest("node not found; cannot run Gate 3 contract checks")
        return subprocess.run(
            [node, *args],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )

    def test_gen_config_check_covers_profile_outputs(self):
        result = self.run_node(["scripts/gen_config.cjs", "--check"])
        self.assertEqual(
            result.returncode,
            0,
            f"gen_config --check failed\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}",
        )
        self.assertIn("generated files match spec", result.stdout)
        self.assertRegex(result.stdout, r"profile-input-sha256 [0-9a-f]{64}")
        for relative in (PROFILE_LUA, GENERIC_LUA, HEADER, FIXTURE):
            self.assertTrue((ROOT / relative).is_file(), relative)

    def test_node_profile_suite(self):
        result = self.run_node(["--test", "tests/test_gate3_profile.cjs"])
        self.assertEqual(
            result.returncode,
            0,
            f"Gate 3 Node suite failed\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}",
        )

    def test_generated_profile_headers_hashes_and_macros(self):
        fixture = json.loads((ROOT / FIXTURE).read_text(encoding="utf-8"))
        self.assertTrue(fixture["DO_NOT_EDIT"])
        self.assertEqual(fixture["generator"], "scripts/gen_config.cjs")
        self.assertRegex(fixture["input_sha256"], r"^[0-9a-f]{64}$")
        self.assertEqual(fixture["matrix_algorithm"], "fnv1a32")
        by_id = {profile["id"]: profile for profile in fixture["profiles"]}
        self.assertEqual(set(by_id), {PROFILE_ID, "dcs-generic"})

        for profile_id, relative in ((PROFILE_ID, PROFILE_LUA), ("dcs-generic", GENERIC_LUA)):
            text = (ROOT / relative).read_text(encoding="utf-8")
            self.assertIn("DO NOT EDIT", text)
            self.assertIn("scripts/gen_config.cjs", text)
            self.assertIn(f"profile-id: {profile_id}", text)
            match = re.search(r"profile-sha256: ([0-9a-f]{64})", text)
            self.assertIsNotNone(match, relative)
            self.assertEqual(match.group(1), by_id[profile_id]["profile_sha256"], relative)
            self.assertIn(f"input-sha256: {fixture['input_sha256']}", text, relative)

        header = (ROOT / HEADER).read_text(encoding="utf-8")
        self.assertIn("DO NOT EDIT", header)
        self.assertIn("scripts/gen_config.cjs", header)
        self.assertIn("AESA_DCS_PROFILE_DCS_2_9_30_28738_MT_DEFINED", header)
        self.assertIn("AESA_DCS_PROFILE_DCS_GENERIC_DEFINED", header)
        macros = parse_macros(header)
        self.assertEqual(macros["AESA_DCS_PROFILE_ID"], PROFILE_ID)
        self.assertEqual(macros["AESA_DCS_PROFILE_SCHEMA"], 1)
        self.assertEqual(macros["AESA_DCS_BUILD"], "2.9.30.28738")
        self.assertEqual(macros["AESA_DCS_VARIANT"], "MT")
        self.assertEqual(macros["AESA_DCS_VARIANT_MT"], 1)
        self.assertEqual(macros["AESA_DCS_VARIANT_ST"], 0)
        self.assertEqual(macros["AESA_DCS_EXPORTS_SHA256"], "unknown")
        self.assertEqual(macros["AESA_AGR_VTABLE_SLOT"], 19)
        self.assertEqual(macros["AESA_AGR_POINT_SURFACE_OFF"], 0x38)
        self.assertEqual(macros["AESA_AGR_SURFACE_CLASSES"], 16)
        self.assertEqual(macros["AESA_AGR_SYMBOL_COUNT"], 4)
        self.assertEqual(macros["AESA_FC_OFF_POS"], 0x1A8)
        self.assertEqual(macros["AESA_FC_OFF_VEL"], 0x1C0)
        self.assertEqual(macros["AESA_FC_OFF_AIM"], 0x220)
        self.assertEqual(macros["AESA_FC_OFF_TGO"], 0x170)
        self.assertEqual(macros["AESA_FC_OFF_R0"], 0x178)
        self.assertEqual(macros["AESA_FC_OFF_RANGE"], 0x180)
        self.assertEqual(macros["AESA_FC_SYMBOL_COUNT"], 17)
        self.assertEqual(macros["AESA_FC_SITE_COUNT"], 13)
        self.assertEqual(macros["AESA_DCS_MODULE_COUNT"], 8)
        for module_name in (
            "DCS.exe",
            "Inter.dll",
            "edterrain4.dll",
            "Weapons.dll",
            "wRadio.dll",
            "WeaponBlocks.dll",
            "WorldGeneral.dll",
            "CockpitBase.dll",
        ):
            self.assertIn(module_name, header)
        for symbol in (
            "Inter.dll!?GetDefaultTerrain@ITerrain@edterrain@@SAPEAV12@XZ",
            "edterrain4.dll!?getPointOnSurface@ITerrainImpl4@@UEBA?AUPointOnSurface@edterrain@@AEBVVec3d@osg@@PEAUInternalCache@23@@Z",
            "WeaponBlocks.dll!?calcTerminalGuidance@wGP_AMRAAM@@IEAAXN@Z",
        ):
            self.assertIn(symbol, header)

        hash_vectors = [
            ("EXP-SELF=ok\n", "d261c0ec"),
            ("EXP-SELF=ok\nEXP-VEL=degraded\n", "8ebcf91c"),
            ("BUILD=ok\nEXP-SELF=unknown\nNAT-HASH=unavailable\n", "1012a55e"),
        ]
        for text, expected in hash_vectors:
            self.assertEqual(fnv1a32(text), expected)

        for profile in fixture["profiles"]:
            capabilities = profile["data"]["capabilities"]
            canonical = "".join(
                f"{key}={self._state(capabilities[key])}\n" for key in sorted(capabilities)
            )
            self.assertEqual(profile["matrix_hash"], fnv1a32(canonical), profile["id"])

    @staticmethod
    def _state(value):
        if value is True:
            return "ok"
        if value is False:
            return "unavailable"
        if isinstance(value, str):
            return value
        if isinstance(value, dict):
            return value["state"]
        return "unknown"

    def test_profile_lua_is_pure(self):
        source = (ROOT / "src/adapters/dcs/compat/profile.lua").read_text(encoding="utf-8")
        code = "\n".join(line.split("--", 1)[0] for line in source.splitlines())
        self.assertIsNone(re.search(r"(?<![.:\w])require\s*\(", code), "no global require()")
        self.assertNotRegex(code, r"\bdofile\s*\(")
        self.assertNotRegex(code, r"\bloadfile\s*\(")
        self.assertNotRegex(code, r"\bio\.")
        self.assertNotRegex(code, r"\bos\.")
        self.assertIn("return P", source)

    def test_lua_profile_behaviour_and_hash_vectors(self):
        lua = find_lua()
        if not lua:
            self.skipTest("Lua 5.1 (luae.exe) not found")
        fixture = json.loads((ROOT / FIXTURE).read_text(encoding="utf-8"))
        by_id = {profile["id"]: profile for profile in fixture["profiles"]}
        concrete_hash = by_id[PROFILE_ID]["matrix_hash"]
        generic_hash = by_id["dcs-generic"]["matrix_hash"]
        script = f"""
local P = dofile('src/adapters/dcs/compat/profile.lua')
local concrete = dofile('{PROFILE_LUA}')
local p = P.new(concrete, 'generated')
assert(p:id() == '{PROFILE_ID}')
assert(p:is_fallback() == false)
assert(p.profile_source == 'generated')
assert(p:get('schema') == 1)
assert(p:get('build') == '2.9.30.28738')
assert(p:cap('EXP-SELF') == 'ok')
assert(p:cap('EXP-TGT') == 'degraded')
assert(p:cap('NO-SUCH-CAP') == 'unknown')
assert(p:cap('export.apis.self_data') == 'ok')
assert(p:field('self', 'position') == 'Position')
assert(p:field('world_object', 'coalition_id') == 'CoalitionID')
assert(p:field('missing', 'x') == nil)
assert(p:api('self_data') == true)
assert(p:api('target_information') == nil)
assert(p:get('modules.DCS.sha256') == '4715620182E7EE36B3982D5C33D0F3265204BB2464D10E5DB7CEF0579E9BAEC0')
assert(p:get('native.agradar.surface_bits.0') == 'Land')
assert(p:get('native.fc.offsets.pos') == 424)
assert(p:get('missing.path', 'fallback') == 'fallback')
assert(p:require('EXP-SELF') == true)
assert(p:require() == true)
local ok, err = pcall(p.require, p, 'NAT-HASH')
assert(not ok and type(err) == 'table')
assert(err.code == 'capability' and err.key == 'NAT-HASH' and err.state == 'degraded')
local matrix = p:matrix()
assert(#matrix > 10)
for i = 2, #matrix do assert(matrix[i - 1].key < matrix[i].key) end
assert(p:matrix_hash() == '{concrete_hash}')

local function fake(caps)
  return {{ schema = 1, id = 'dcs-1.2.3.4', build = '1.2.3.4', capabilities = caps }}
end
assert(P.new(fake({{ CAP = false }})):cap('CAP') == 'unavailable')
assert(P.new(fake({{}})):cap('CAP') == 'unknown')
assert(P.new(fake({{ ['EXP-SELF'] = 'ok' }})):matrix_hash() == 'd261c0ec')
assert(P.new(fake({{ ['EXP-SELF'] = 'ok', ['EXP-VEL'] = 'degraded' }})):matrix_hash() == '8ebcf91c')
assert(P.new(fake({{ BUILD = 'ok', ['EXP-SELF'] = 'unknown', ['NAT-HASH'] = 'unavailable' }})):matrix_hash() == '1012a55e')
for i = 1, #P.HASH_VECTORS do
  local vector = P.HASH_VECTORS[i]
  assert(P.fnv1a32(vector.input) == vector.hash)
end

local api_profile = {{
  schema = 1, id = 'dcs-1.2.3.4', build = '1.2.3.4',
  export = {{ apis = {{ self_data = true, target_information = false }} }},
  capabilities = {{}}
}}
local apis = P.new(api_profile)
assert(apis:api('self_data') == true)
assert(apis:api('target_information') == false)
assert(apis:api('missing') == nil)

local fallback = P.new(nil)
assert(fallback:id() == 'dcs-generic')
assert(fallback:is_fallback() == true)
assert(fallback:cap('BUILD') == 'unknown')
local bad_profile = P.new({{ schema = 2, id = 'x', build = 'y' }}, 'generated')
assert(bad_profile:id() == 'dcs-generic')
assert(bad_profile:is_fallback() == true)
assert(bad_profile.fallback_reason == 'schema')
local ok_all, err_all = pcall(fallback.require, fallback)
assert(not ok_all and type(err_all) == 'table' and err_all.code == 'capability')

local generic = dofile('{GENERIC_LUA}')
P.set_generic(generic)
local injected = P.new(nil)
assert(injected:id() == 'dcs-generic')
assert(injected:is_fallback() == true)
assert(injected:matrix_hash() == '{generic_hash}')
print('lua profile ok')
"""
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
            f"Lua profile checks failed\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}",
        )
        self.assertIn("lua profile ok", result.stdout)


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Smoke/robustness test for the AESA AGR surface-mask probe DLL.

Covers the two integration fixes:
  * surface_names/surface_mask called without init, in a real Lua state, with
    the engine absent -> nil, no crash, no log file.
  * init("") then init(real_log_dir) -> symbols still resolve, logging opens
    on the explicit call, and the lazy failure is logged exactly once.
  * optional: with Inter.dll/edterrain4.dll loaded, an explicit init resolves
    4/4 symbols and validates the 16-class table.

The no-engine Lua cases use DCS's luae.exe (which imports lua.dll), so the
DLL's runtime Lua binding is exercised exactly as the Export state does it.
Run after: node scripts/build_agradar_probe.cjs
"""
import ctypes
import os
import subprocess
import sys
import tempfile

import find_tools

HERE = os.path.dirname(os.path.abspath(__file__))
DLL = os.path.join(HERE, "..", "dist", "dev", "aesa_agradar.dll")
DCS_BIN = find_tools.find_dcs_bin()
LUAE = os.path.join(DCS_BIN, "luae.exe") if DCS_BIN else ""
LUA_DLL = os.path.join(DCS_BIN, "lua.dll") if DCS_BIN else ""
DEFAULT_LOG = os.path.join(os.environ.get("USERPROFILE", ""), "Saved Games",
                           "DCS", "Logs", "AESA", "AGR", "agradar_native.log")

EXPORTS = ("aesa_agradar_init", "aesa_agradar_poll", "aesa_agradar_shutdown",
           "aesa_agradar_version", "aesa_agradar_surface_names",
           "aesa_agradar_surface_mask", "aesa_agradar_profile_check")


def bind(probe):
    for name in EXPORTS:
        fn = getattr(probe, name)
        fn.argtypes = [ctypes.c_void_p]
        fn.restype = ctypes.c_int


def run_lua(script, dll_path, log_dir):
    with tempfile.NamedTemporaryFile("w", suffix=".lua", delete=False,
                                     encoding="utf-8") as f:
        f.write(script)
        script_path = f.name
    try:
        r = subprocess.run([LUAE, script_path, dll_path, log_dir],
                           capture_output=True, text=True, timeout=30)
        if r.returncode != 0:
            raise AssertionError("luae failed: " + (r.stderr or r.stdout))
        return r.stdout.strip()
    finally:
        os.remove(script_path)


def main():
    if not os.path.exists(DLL):
        print("probe DLL not built; run node scripts/build_agradar_probe.cjs first")
        return 1
    default_log_available = True
    if os.path.exists(DEFAULT_LOG):
        try:
            os.remove(DEFAULT_LOG)
        except PermissionError:
            # A running DCS keeps its own native log open. Use a temp log for
            # the explicit-init cases; the default-log assertions are skipped.
            default_log_available = False
            print("DCS holds agradar_native.log; using a temp log for this run")

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetModuleHandleA.argtypes = [ctypes.c_char_p]
    kernel32.GetModuleHandleA.restype = ctypes.c_void_p
    assert not kernel32.GetModuleHandleA(b"Inter.dll"), \
        "test must start without Inter.dll loaded"

    probe = ctypes.CDLL(os.path.abspath(DLL))
    bind(probe)
    for name in EXPORTS:
        assert hasattr(probe, name), "missing export: " + name

    # No lua_State: functions must return their Lua result counts and not
    # crash. init(NULL) must not create a default log (empty log_dir = no-op).
    assert probe.aesa_agradar_init(None) == 1
    assert probe.aesa_agradar_version(None) == 1
    assert probe.aesa_agradar_surface_names(None) == 1
    assert probe.aesa_agradar_surface_mask(None) == 1
    assert probe.aesa_agradar_poll(None) == 1
    assert probe.aesa_agradar_shutdown(None) == 1
    if default_log_available:
        assert not os.path.exists(DEFAULT_LOG), \
            "init(NULL) must not create a default log"

    if not (os.path.isfile(LUAE) and os.path.isfile(LUA_DLL)):
        print("luae.exe/lua.dll unavailable; Lua-state cases skipped")
        print("agradar_probe DLL smoke test OK")
        return 0

    # Case 1: no init, engine absent, real Lua state with coordinates.
    # surface_* must return nil without crashing and without creating a log.
    script_no_init = r'''
local path = arg[1]
local sn = assert(package.loadlib(path, "aesa_agradar_surface_names"))
local sm = assert(package.loadlib(path, "aesa_agradar_surface_mask"))
local a = sn(40000.0, 40000.0)
local b = sm(40000.0, 40000.0)
print(type(a), type(b))
'''
    out = run_lua(script_no_init, DLL, DEFAULT_LOG)
    assert out.split() == ["nil", "nil"], out
    if default_log_available:
        assert not os.path.exists(DEFAULT_LOG), \
            "surface_* without init must not create a log"

    # Case 2: init("") must not open a log; init(real_dir) must still resolve
    # symbols and open the log; lazy queries then return nil and log the
    # failure exactly once.
    with tempfile.TemporaryDirectory() as tmp:
        log_dir = os.path.join(tmp, "Logs", "AESA", "AGR")
        script_lazy = r'''
local path, logdir = arg[1], arg[2]
local init = assert(package.loadlib(path, "aesa_agradar_init"))
local sn = assert(package.loadlib(path, "aesa_agradar_surface_names"))
local sm = assert(package.loadlib(path, "aesa_agradar_surface_mask"))
local n0 = init("")
local n1 = init(logdir)
local a = sn(40000.0, 40000.0)
local b = sm(40000.0, 40000.0)
print(n0, n1, type(a), type(b))
'''
        out = run_lua(script_lazy, DLL, log_dir)
        parts = out.split()
        assert len(parts) == 4, out
        assert parts[0].isdigit() and parts[1].isdigit(), out
        assert parts[2:] == ["nil", "nil"], out
        log_path = os.path.join(log_dir, "agradar_native.log")
        assert os.path.exists(log_path), "explicit init did not open the log"
        with open(log_path, "r", encoding="utf-8", errors="replace") as f:
            log_text = f.read()
        assert "init complete: 0/4 symbols resolved" in log_text
        assert log_text.count("lazy resolve failed") == 1, log_text
        if default_log_available:
            assert not os.path.exists(DEFAULT_LOG), \
                "init('') must not fall back to the default log path"

    # Case 3 (optional): engine modules loaded; explicit init with a real log
    # dir must resolve 4/4 and validate the 16-class table. No terrain is
    # opened, so surface_names should still return nil (terrain null or
    # all-ones sentinel), not crash.
    if DCS_BIN and os.path.isdir(DCS_BIN):
        os.add_dll_directory(DCS_BIN)
        ctypes.WinDLL(os.path.join(DCS_BIN, "Inter.dll"))
        ctypes.WinDLL(os.path.join(DCS_BIN, "edterrain4.dll"))

        lua = ctypes.WinDLL(LUA_DLL)
        lua.luaL_newstate.restype = ctypes.c_void_p
        lua.lua_close.argtypes = [ctypes.c_void_p]
        lua.lua_pushstring.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
        lua.lua_pushnumber.argtypes = [ctypes.c_void_p, ctypes.c_double]
        lua.lua_tonumber.argtypes = [ctypes.c_void_p, ctypes.c_int]
        lua.lua_tonumber.restype = ctypes.c_double
        lua.lua_type.argtypes = [ctypes.c_void_p, ctypes.c_int]
        lua.lua_type.restype = ctypes.c_int
        lua.lua_settop.argtypes = [ctypes.c_void_p, ctypes.c_int]

        L = lua.luaL_newstate()
        assert L, "luaL_newstate failed"
        with tempfile.TemporaryDirectory() as tmp:
            log_dir = os.path.join(tmp, "Logs", "AESA", "AGR")
            lua.lua_pushstring(L, log_dir.encode())
            assert probe.aesa_agradar_init(L) == 1
            assert int(lua.lua_tonumber(L, -1)) == 4, "engine symbols did not resolve 4/4"
            lua.lua_settop(L, 0)

            lua.lua_pushnumber(L, 40000.0)
            lua.lua_pushnumber(L, 40000.0)
            assert probe.aesa_agradar_surface_names(L) == 1
            assert lua.lua_type(L, -1) == 0, "surface_names should be nil without a terrain"
            lua.lua_settop(L, 0)

            log_path = os.path.join(log_dir, "agradar_native.log")
            with open(log_path, "r", encoding="utf-8", errors="replace") as f:
                log_text = f.read()
            assert "init complete: 4/4 symbols resolved" in log_text
            assert "engine surface-name validation: 16/16 match" in log_text
            probe.aesa_agradar_shutdown(L)
        lua.lua_close(L)

    print("agradar_probe DLL smoke test OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())

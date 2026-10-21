#!/usr/bin/env python3
"""Gate 1 native fire-control safety regressions.

Covers the two known Gate 1 defects:

1. ``readable()`` in ``src/native/fc_probe/aesa_fc.c`` validated only the page
   that contains the first byte. ``aesa_fc_readable`` is the read-only test
   export of that same check; it must reject any range that crosses into
   uncommitted, no-access or guard memory.
2. ``src/hooks/aesa_fc_hook.lua`` defaulted to ``mode=1`` (write injection).
   The default must be ``mode=0`` (read-only); only an explicit ``mode=1``
   override may arm injection, and the log must state the effective mode.
   Trace lifecycle (start/stop) must stay unchanged. Gate 3 adds: the hook is
   a runtime consumer (``AESA_RUNTIME``), touches no engine global directly,
   and logs the fixed ``COMPAT,<profile_id>,<matrix_hash>`` handshake line.

Run directly: ``python tests/test_gate1_native.py``.
"""
import ctypes
import os
import shutil
import subprocess
import tempfile
import unittest

import find_tools

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DLL = os.path.join(ROOT, "dist", "dev", "aesa_fc_trace.dll")
HOOK = os.path.join(ROOT, "src", "hooks", "aesa_fc_hook.lua")
AGR_HOOK = os.path.join(ROOT, "src", "hooks", "aesa_agradar_hook.lua")

PAGE = 0x1000
MEM_COMMIT = 0x1000
MEM_RESERVE = 0x2000
MEM_RELEASE = 0x8000
PAGE_NOACCESS = 0x01
PAGE_READONLY = 0x02
PAGE_READWRITE = 0x04
PAGE_GUARD = 0x100

KERNEL32 = ctypes.WinDLL("kernel32", use_last_error=True)
KERNEL32.VirtualAlloc.restype = ctypes.c_void_p
KERNEL32.VirtualAlloc.argtypes = [ctypes.c_void_p, ctypes.c_size_t,
                                  ctypes.c_ulong, ctypes.c_ulong]
KERNEL32.VirtualFree.restype = ctypes.c_int
KERNEL32.VirtualFree.argtypes = [ctypes.c_void_p, ctypes.c_size_t,
                                 ctypes.c_ulong]
KERNEL32.VirtualProtect.restype = ctypes.c_int
KERNEL32.VirtualProtect.argtypes = [ctypes.c_void_p, ctypes.c_size_t,
                                    ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong)]


def find_lua():
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


class ReadableRangeTest(unittest.TestCase):
    """The exported range check must cover the whole [p, p+n) span."""

    @classmethod
    def setUpClass(cls):
        if not os.path.isfile(DLL):
            raise AssertionError(
                "probe DLL not built; run node scripts/build_fc_probe.cjs first")
        cls.probe = ctypes.CDLL(os.path.abspath(DLL))
        if not hasattr(cls.probe, "aesa_fc_readable"):
            raise AssertionError(
                "aesa_fc_readable export missing; readable() range fix not built")
        cls.probe.aesa_fc_readable.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
        cls.probe.aesa_fc_readable.restype = ctypes.c_int
        cls._allocations = []

    @classmethod
    def tearDownClass(cls):
        for ptr in cls._allocations:
            KERNEL32.VirtualFree(ptr, 0, MEM_RELEASE)

    @classmethod
    def alloc(cls, size, protect=PAGE_READWRITE, reserve=False):
        flags = MEM_RESERVE if reserve else MEM_COMMIT
        ptr = KERNEL32.VirtualAlloc(None, size, flags, protect)
        if not ptr:
            raise OSError(ctypes.get_last_error(), "VirtualAlloc failed")
        cls._allocations.append(ptr)
        return ptr

    @classmethod
    def protect(cls, ptr, size, protection):
        old = ctypes.c_ulong()
        if not KERNEL32.VirtualProtect(ptr, size, protection,
                                       ctypes.byref(old)):
            raise OSError(ctypes.get_last_error(), "VirtualProtect failed")

    def readable(self, ptr, size):
        return self.probe.aesa_fc_readable(ptr, size)

    def test_normal_range(self):
        buf = ctypes.create_string_buffer(64)
        addr = ctypes.addressof(buf)
        self.assertEqual(self.readable(addr, 64), 1)
        self.assertEqual(self.readable(addr, 0), 1)
        self.assertEqual(self.readable(None, 1), 0)
        self.assertEqual(self.readable(None, 0), 0)

    def test_size_overflow_is_rejected(self):
        buf = ctypes.create_string_buffer(16)
        self.assertEqual(self.readable(ctypes.addressof(buf),
                                       ctypes.c_size_t(-1).value), 0)

    def test_range_inside_readable_page(self):
        ptr = self.alloc(PAGE)
        self.assertEqual(self.readable(ptr, 16), 1)
        self.assertEqual(self.readable(ptr + PAGE - 16, 16), 1)

    def test_range_crossing_into_noaccess_is_rejected(self):
        ptr = self.alloc(2 * PAGE)
        self.protect(ptr + PAGE, PAGE, PAGE_NOACCESS)
        # The first page is committed and readable; the old implementation
        # returned 1 here because it only inspected that first page.
        self.assertEqual(self.readable(ptr + PAGE - 16, 17), 0)
        self.assertEqual(self.readable(ptr + PAGE - 1, 2), 0)
        self.assertEqual(self.readable(ptr + PAGE, 1), 0)

    def test_range_crossing_into_readable_page(self):
        ptr = self.alloc(2 * PAGE)
        self.assertEqual(self.readable(ptr + PAGE - 16, 32), 1)

    def test_readonly_page_is_readable(self):
        ptr = self.alloc(PAGE)
        self.protect(ptr, PAGE, PAGE_READONLY)
        self.assertEqual(self.readable(ptr, 16), 1)

    def test_uncommitted_page_is_rejected(self):
        ptr = self.alloc(PAGE, reserve=True)
        self.assertEqual(self.readable(ptr, 1), 0)

    def test_guard_page_is_rejected(self):
        ptr = self.alloc(PAGE, protect=PAGE_READWRITE | PAGE_GUARD)
        self.assertEqual(self.readable(ptr, 1), 0)


LUA_HARNESS = r"""
local sg = assert(arg[1], "saved-games argument missing")
local hook = assert(arg[2], "hook path argument missing")
local root = assert(arg[3], "repo root argument missing")
if string.sub(root, -1) ~= "/" and string.sub(root, -1) ~= "\\" then
    root = root .. "/"
end

local journal = { log = {}, loadlib = {}, polls = 0 }
local callbacks
local function note(msg) journal.log[#journal.log + 1] = tostring(msg) end

-- The hook checks for the inject DLL before loading it. The test harness
-- stubs package.loadlib below, so the file only has to exist; its contents
-- are never parsed.
for _, name in ipairs({ "aesa_fc_trace.dll", "aesa_fc_inject.dll" }) do
    local handle = assert(io.open(sg .. "\\Scripts\\AESA-FC\\" .. name, "wb"))
    handle:write("stub")
    handle:close()
end

-- DCS lfs.writedir() returns a trailing separator; the hook relies on it.
-- The adapter reads the Hooks global, so this must not be a local.
lfs = { writedir = function() return sg .. "\\" end }
package.loaded["lfs"] = lfs

local function make_stub(sym)
    return function(...)
        if sym == "aesa_fc_init" then
            journal.init_arg = select(1, ...)
            return 17
        elseif sym == "aesa_fc_trace_start" then
            journal.trace_start = (journal.trace_start or 0) + 1
            return 13
        elseif sym == "aesa_fc_trace_stop" then
            journal.trace_stop = (journal.trace_stop or 0) + 1
            return 0
        elseif sym == "aesa_fc_poll" then
            journal.polls = journal.polls + 1
            return 0
        elseif sym == "aesa_fc_arm" then
            local mode, id = ...
            journal.arm_mode = tonumber(mode)
            journal.arm_id = tonumber(id)
            journal.arm_calls = (journal.arm_calls or 0) + 1
            return 1
        elseif sym == "aesa_fc_disarm" then
            journal.disarm = (journal.disarm or 0) + 1
            return 0
        elseif sym == "aesa_fc_feed_target" then
            journal.feed_arg = select(1, ...)
            return 1
        elseif sym == "aesa_fc_shutdown" then
            journal.shutdown = (journal.shutdown or 0) + 1
            return 0
        end
        return 0
    end
end

package.loadlib = function(path, sym)
    journal.loadlib[#journal.loadlib + 1] = sym
    return make_stub(sym)
end

log = {
    INFO = 1, WARNING = 2, ERROR = 3,
    -- The adapter contract is log_write(level, message); older hooks called
    -- log.write(tag, level, message). Accept both and keep the message.
    write = function(a, b, c) note(c or b) end,
}
DCS = {
    getModelTime = function() return journal.now or 0 end,
    setUserCallbacks = function(cb) callbacks = cb end,
}
net = {
    dostring_in = function(_, code)
        code = tostring(code)
        if string.find(code, "Unit.getByName", 1, true) then return "42" end
        if string.find(code, "aesa_fc_msl_dump ~= nil", 1, true) then return "true" end
        if string.find(code, "aesa_fc_msl_dump", 1, true) then return "" end
        if string.find(code, "aesa_fc_msl", 1, true) then return "aesa_fc_msl ok" end
        return ""
    end,
}

local function module(path)
    local chunk, err = loadfile(root .. path)
    if not chunk then error("cannot load " .. path .. ": " .. tostring(err)) end
    return chunk()
end
local profile_data = module("src/adapters/dcs/compat/profiles/dcs-2.9.30.28738-mt.lua")
if arg[4] == "degraded" then
    -- Simulate a native profile mismatch: the DLL still loads, but the
    -- generated matrix no longer marks the FC symbols as verified.
    profile_data.capabilities["NAT-FC-SYM"] = "degraded"
end
AESA_RUNTIME = {
    hook = module("src/adapters/dcs/api/hook.lua"),
    native = module("src/adapters/dcs/api/native.lua"),
    profile = module("src/adapters/dcs/compat/profile.lua"),
    profile_data = profile_data,
}

local chunk, err = loadfile(hook)
if not chunk then error("cannot load hook: " .. tostring(err)) end
chunk()

if not callbacks or type(callbacks.onSimulationStart) ~= "function" then
    error("hook did not register callbacks")
end

journal.now = 0
callbacks.onSimulationStart()
journal.now = 5
for _ = 1, 20 do callbacks.onSimulationFrame() end
callbacks.onSimulationStop()

local function out(key, value)
    print(key .. "=" .. tostring(value))
end
out("ARM_CALLS", journal.arm_calls or 0)
out("ARM_MODE", journal.arm_mode)
out("ARM_ID", journal.arm_id)
out("TRACE_START", journal.trace_start or 0)
out("TRACE_STOP", journal.trace_stop or 0)
out("FEED_ARG", journal.feed_arg)
out("POLLS", journal.polls or 0)
out("DISARM", journal.disarm or 0)
out("SHUTDOWN", journal.shutdown or 0)
for i = 1, #journal.log do
    local escaped = string.gsub(journal.log[i], "[\r\n]+", " ")
    print("LOG=" .. escaped)
end
"""


class HookDefaultModeTest(unittest.TestCase):
    """aesa_fc_hook.lua must be read-only unless mode=1 is explicit."""

    @classmethod
    def setUpClass(cls):
        cls.lua = find_lua()
        if not cls.lua:
            raise unittest.SkipTest(
                "Lua 5.1 executable not found (set AESA_LUA or AESA_DCS_BIN)")
        if not os.path.isfile(HOOK):
            raise AssertionError("missing hook source: " + HOOK)

    def run_hook(self, config_source=None, profile_mode=None):
        with tempfile.TemporaryDirectory() as tmp:
            saved_games = os.path.join(tmp, "Saved Games", "DCS")
            script_dir = os.path.join(saved_games, "Scripts", "AESA-FC")
            os.makedirs(script_dir)
            if config_source is not None:
                with open(os.path.join(script_dir, "fc_experiment.lua"), "w",
                          encoding="utf-8") as f:
                    f.write(config_source)
            harness = os.path.join(tmp, "harness.lua")
            with open(harness, "w", encoding="utf-8") as f:
                f.write(LUA_HARNESS)
            result = subprocess.run(
                [self.lua, harness, saved_games, HOOK,
                 ROOT.replace("\\", "/"), profile_mode or ""],
                capture_output=True, text=True, encoding="utf-8",
                errors="replace", timeout=60)
        self.assertEqual(result.returncode, 0,
                         "hook harness failed:\n%s\n%s"
                         % (result.stdout, result.stderr))
        values = {}
        logs = []
        for line in result.stdout.splitlines():
            if line.startswith("LOG="):
                logs.append(line[4:])
            elif "=" in line:
                key, _, value = line.partition("=")
                values[key] = value
        self.assertIn("TRACE_START", values,
                      "hook did not load the native trace build:\n" + result.stdout)
        return values, logs

    def test_default_is_read_only_trace(self):
        values, logs = self.run_hook()
        self.assertEqual(values["ARM_CALLS"], "0",
                         "default trace build must not call the write exports")
        self.assertEqual(values["TRACE_START"], "1",
                         "read-only default must keep trace_start")
        self.assertEqual(values["TRACE_STOP"], "1",
                         "read-only default must keep trace_stop")
        self.assertEqual(values["SHUTDOWN"], "1")
        joined = "\n".join(logs).lower()
        self.assertIn("mode=0", joined)
        self.assertIn("read-only", joined)
        self.assertIn("native=trace", joined)

    def test_explicit_mode_one_injects(self):
        values, logs = self.run_hook("return { mode = 1 }\n")
        self.assertEqual(values["ARM_MODE"], "1",
                         "explicit mode=1 must enable the inject build")
        self.assertEqual(values["ARM_CALLS"], "1")
        self.assertEqual(values["TRACE_START"], "1")
        joined = "\n".join(logs).lower()
        self.assertIn("mode=1", joined)
        self.assertIn("native=inject", joined)

    def test_unknown_mode_falls_back_to_read_only(self):
        values, logs = self.run_hook("return { mode = 2 }\n")
        self.assertEqual(values["ARM_CALLS"], "0")
        self.assertEqual(values["TRACE_START"], "1")
        joined = "\n".join(logs).lower()
        self.assertIn("invalid experiment.mode", joined)
        self.assertIn("mode=0", joined)
        self.assertIn("native=trace", joined)

    def test_feed_requires_mode_one(self):
        values, _ = self.run_hook("return { mode = 0, feed = 1 }\n")
        self.assertEqual(values["ARM_CALLS"], "0")
        self.assertEqual(values["FEED_ARG"], "nil",
                         "mode=0 must not feed the injection path")

    def test_feed_runs_with_explicit_mode_one(self):
        values, _ = self.run_hook("return { mode = 1, feed = 1 }\n")
        self.assertEqual(values["ARM_MODE"], "1")
        self.assertNotEqual(values["FEED_ARG"], "nil",
                            "explicit mode=1 + feed=1 must still feed")

    def test_profile_mismatch_forces_read_only(self):
        values, logs = self.run_hook("return { mode = 1 }\n",
                                     profile_mode="degraded")
        self.assertEqual(values["ARM_CALLS"], "0",
                         "a native profile mismatch must force read-only")
        self.assertEqual(values["TRACE_START"], "1")
        joined = "\n".join(logs).lower()
        self.assertIn("write path disabled", joined)
        self.assertIn("nat-fc-sym=degraded", joined)
        self.assertIn("native=trace", joined)

    def test_compat_handshake_line(self):
        _, logs = self.run_hook()
        lines = [line for line in logs if line.startswith("COMPAT,")]
        self.assertEqual(len(lines), 1,
                         "exactly one COMPAT handshake expected:\n"
                         + "\n".join(logs))
        self.assertRegex(lines[0],
                         r"^COMPAT,dcs-[a-z0-9][a-z0-9.\-]*,[0-9a-f]{8}$")


class HookRuntimeBoundaryTest(unittest.TestCase):
    """Gate 3: hooks consume AESA_RUNTIME, not engine globals directly."""

    # The FC mission recorder is a code string executed in the mission state;
    # its Unit/world/timer payload is not a Hooks-state API call, so only the
    # Hooks-side services are checked here.
    DIRECT_TOKENS = (
        "package.loadlib",
        "net.dostring_in",
        'require("lfs")',
        "require('lfs')",
        'require("socket")',
        "require('socket')",
        "lfs.",
    )

    def assert_runtime_consumer(self, path):
        self.assertTrue(os.path.isfile(path), path)
        with open(path, encoding="utf-8") as source_file:
            source = source_file.read()
        for token in self.DIRECT_TOKENS:
            self.assertNotIn(token, source,
                             f"{os.path.basename(path)} uses {token}")
        self.assertIn("assert(AESA_RUNTIME", source)
        self.assertIn("runtime.hook.new(_G)", source)
        self.assertIn("runtime.native.new(_G)", source)
        self.assertIn('runtime.profile.new(runtime.profile_data, "generated")',
                      source)

    def test_fc_hook_is_runtime_consumer(self):
        self.assert_runtime_consumer(HOOK)

    def test_agr_hook_is_runtime_consumer(self):
        self.assert_runtime_consumer(AGR_HOOK)


if __name__ == "__main__":
    unittest.main(verbosity=2)

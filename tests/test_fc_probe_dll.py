#!/usr/bin/env python3
"""Smoke test for the fire-control native DLLs outside DCS (ctypes load).

Gate 6 (D4) splits the old probe into two builds from one source:
  aesa_fc_trace.dll   read-only trace; must NOT export the write functions.
  aesa_fc_inject.dll  trace superset; must export arm/disarm/feed_target.
The test verifies the carrier contract for both, the read-only range helper
used by the Gate 1 boundary regression, and the export split itself.

Run after scripts/build_fc_probe.cjs.
"""
import ctypes
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TRACE = os.path.join(ROOT, "dist", "dev", "aesa_fc_trace.dll")
INJECT = os.path.join(ROOT, "dist", "dev", "aesa_fc_inject.dll")
BASE_EXPORTS = ("aesa_fc_init", "aesa_fc_poll", "aesa_fc_shutdown",
                "aesa_fc_version", "aesa_fc_trace_start", "aesa_fc_trace_stop",
                "aesa_fc_readable")
WRITE_EXPORTS = ("aesa_fc_arm", "aesa_fc_disarm", "aesa_fc_feed_target")


def load(path):
    if not os.path.exists(path):
        print("probe DLL not built; run node scripts/build_fc_probe.cjs first")
        raise SystemExit(1)
    return ctypes.CDLL(os.path.abspath(path))


def check_readable(probe):
    probe.aesa_fc_readable.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
    probe.aesa_fc_readable.restype = ctypes.c_int
    assert probe.aesa_fc_readable(None, 1) == 0, "readable(NULL) must be false"


def exercise(probe, label, write_path):
    for name in BASE_EXPORTS:
        assert hasattr(probe, name), f"{label}: missing export {name}"
    for name in WRITE_EXPORTS:
        present = hasattr(probe, name)
        if write_path:
            assert present, f"{label}: missing write export {name}"
        else:
            assert not present, f"{label}: write export leaked: {name}"
    check_readable(probe)
    n = probe.aesa_fc_init(None)
    assert isinstance(n, int), f"{label}: init must return an int (lua results)"
    assert probe.aesa_fc_version(None) == 1, f"{label}: version must report one result"
    assert probe.aesa_fc_trace_start(None) == 1, f"{label}: trace_start returns one Lua result"
    if write_path:
        assert probe.aesa_fc_arm(None) == 1, f"{label}: arm returns one Lua result"
        probe.aesa_fc_disarm(None)
        assert probe.aesa_fc_feed_target(None) == 1, f"{label}: feed_target returns one result"
    probe.aesa_fc_poll(None)
    probe.aesa_fc_poll(None)
    probe.aesa_fc_trace_stop(None)
    probe.aesa_fc_shutdown(None)


def main():
    trace = load(TRACE)
    inject = load(INJECT)
    exercise(trace, "trace", False)
    exercise(inject, "inject", True)

    # default log path (outside DCS): %USERPROFILE%\Saved Games\DCS\Logs\AESA
    default_log = os.path.join(os.environ["USERPROFILE"], "Saved Games", "DCS",
                               "Logs", "AESA", "fc_native.log")
    assert os.path.exists(default_log), "probe did not write its log"
    with open(default_log, "r", encoding="utf-8", errors="replace") as f:
        text = f.read()
    assert "aesa_fc probe init (trace, phase1+trace)" in text, "trace init line missing"
    assert "aesa_fc probe init (inject, phase1+trace)" in text, "inject init line missing"
    assert "poll alive" in text, "poll heartbeat missing"
    assert "shutdown after 2 frames" in text, "shutdown line missing"
    # Outside DCS the engine modules are absent: symbols must be MISSING.
    assert "MISSING" in text, "expected unresolved symbols outside DCS"
    print("fc_probe DLL smoke test OK (trace + inject)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

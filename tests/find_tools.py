# -*- coding: utf-8 -*-
"""Locate the DCS-bundled Lua 5.1 interpreter / DCS bin directory for tests.

Resolution order: AESA_LUA / AESA_DCS_BIN environment overrides, then a
drive-letter scan of the usual DCS install locations, then lua51/lua5.1
on PATH. The DCS-bundled luae.exe is Lua 5.1.
"""
import os
import shutil
import string

_DCS_RELATIVES = [
    "SteamLibrary/steamapps/common/DCSWorld",
    "SteamLibrary/steamapps/common/DCS World",
    "Steam/steamapps/common/DCSWorld",
    "Steam/steamapps/common/DCS World",
    "Program Files (x86)/Steam/steamapps/common/DCSWorld",
    "Program Files (x86)/Steam/steamapps/common/DCS World",
    "Program Files/Steam/steamapps/common/DCSWorld",
    "Program Files/Steam/steamapps/common/DCS World",
    "Games/SteamLibrary/steamapps/common/DCSWorld",
    "Games/Steam/steamapps/common/DCSWorld",
    "Eagle Dynamics/DCS World",
    "Eagle Dynamics/DCS World OpenBeta",
]


def _scan_dcs_bins():
    for letter in string.ascii_uppercase:
        for relative in _DCS_RELATIVES:
            candidate = os.path.join(letter + ":/", relative, "bin")
            if os.path.isfile(os.path.join(candidate, "luae.exe")):
                yield candidate


def find_dcs_bin():
    """First DCS bin directory containing luae.exe, or None."""
    env = os.environ.get("AESA_DCS_BIN")
    if env:
        for candidate in (env, os.path.join(env, "bin")):
            if os.path.isfile(os.path.join(candidate, "luae.exe")):
                return os.path.normpath(candidate)
        return None
    lua = os.environ.get("AESA_LUA")
    if lua and os.path.isfile(lua):
        return os.path.dirname(os.path.abspath(lua))
    for candidate in _scan_dcs_bins():
        return candidate
    return None


def lua_candidates():
    """Ordered luae/lua candidates: env overrides, drive scan, PATH."""
    candidates = [os.environ.get("AESA_LUA")]
    dcs = os.environ.get("AESA_DCS_BIN")
    if dcs:
        candidates.extend([os.path.join(dcs, "luae.exe"),
                           os.path.join(dcs, "bin", "luae.exe")])
    candidates.extend(os.path.join(bin_dir, "luae.exe")
                      for bin_dir in _scan_dcs_bins())
    candidates.extend([shutil.which("lua51"), shutil.which("lua5.1")])
    return candidates


def find_lua():
    """First existing Lua interpreter, or None."""
    for candidate in lua_candidates():
        if candidate and os.path.isfile(candidate):
            return candidate
    return None

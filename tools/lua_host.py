# -*- coding: utf-8 -*-
"""aesa Lua 宿主：创建 Lua 5.1 运行时、按路径加载核心/适配器模块。

生产工具（live/replay/receiver）只通过本模块触碰 Lua；不依赖 tests/。
路径约定：
  - src/core/*.lua            纯核心
  - src/adapters/dcs/*.lua    游戏适配（frame/truth_replay/rcs/rcs_data）
  - src/shared/*.lua          生成配置
"""
import os

import lupa.lua51 as lua

TOOLS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(TOOLS)
CORE = os.path.join(ROOT, "src", "core")
ADAPTERS = os.path.join(ROOT, "src", "adapters", "dcs")
SHARED = os.path.join(ROOT, "src", "shared")

_CORE_MODULES = {
    "init", "constants", "physics", "beam", "detection", "geometry",
    "scheduler", "tracker", "core", "rcs", "measurement", "snapshot",
}
_ADAPTER_MODULES = {
    "frame", "truth_replay", "dcs_rcs", "rcs_data",
}


class Host:
    """单线程 Lua 宿主（LuaRuntime 非线程安全）。"""

    def __init__(self):
        self.RT = lua.LuaRuntime(unpack_returned_tuples=True)
        self._loader = self.RT.eval(
            "function(src, name) local f, e = loadstring(src, name)"
            " if not f then error(e, 2) end return f() end")
        self._noop = self.RT.eval(
            "function() local s = {}"
            " function s:on_dwell(d) end"
            " function s:on_tracks(tracks, ordered) end"
            " return s end")()
        self._dwell = self.RT.eval(
            "function() local s = { dwells = {} }"
            " function s:on_dwell(d) s.dwells[#s.dwells + 1] = d end"
            " function s:on_tracks(tracks, ordered) end"
            " return s end")
        self._count = self.RT.eval(
            "function() local s = { dwells = 0, counts = {} }"
            " function s:on_dwell(d)"
            "   s.dwells = s.dwells + 1"
            "   local rows = d.detection.targets"
            "   for i = 1, #rows do"
            "     if rows[i].detected then"
            "       local k = tostring(rows[i].id)"
            "       s.counts[k] = (s.counts[k] or 0) + 1"
            "     end"
            "   end"
            " end"
            " function s:on_tracks(tracks, ordered) end"
            " return s end")

    # ---------------------------------------------------------------- 加载
    def load_lua(self, path, name):
        with open(path, "r", encoding="utf-8") as f:
            return self._loader(f.read(), name)

    def module_path(self, name):
        if name == "config":
            return os.path.join(SHARED, "config.lua")
        if name in _CORE_MODULES:
            return os.path.join(CORE, name + ".lua")
        if name == "rcs":
            return os.path.join(CORE, "rcs.lua")
        if name == "dcs_rcs":
            return os.path.join(ADAPTERS, "rcs.lua")
        if name in _ADAPTER_MODULES:
            return os.path.join(ADAPTERS, name + ".lua")
        if name == "rcs":
            return os.path.join(CORE, "rcs.lua")
        raise KeyError("unknown Lua module: %s" % name)

    def mod(self, name):
        return self.load_lua(self.module_path(name), name)

    def build(self, opts=None):
        """核心组合根；opts 为 {config=...} 注入配置。"""
        init = self.mod("init")
        if opts is None:
            return init.build(CORE)
        return init.build(CORE, self.T(opts))

    def dcs_rcs(self):
        """DCS RCS 解析器（官方 map + 机型分档）。"""
        return self.mod("dcs_rcs").new(self.mod("rcs_data"))

    def noop_sink(self):
        return self._noop

    def dwell_sink(self):
        return self._dwell()

    def counting_sink(self):
        """只累计驻留数与每目标检测数，不保留审计表（回放/长任务用）。"""
        return self._count()

    # ---------------------------------------------------------------- 转换
    def T(self, value):
        """Python dict/list -> Lua 表（递归）。"""
        return self.RT.table_from(value, recursive=True)

    def TL(self, values):
        return self.RT.table_from(values)

    def call(self, obj, method, *args):
        """等价 Lua 的 obj:method(...)。"""
        return getattr(obj, method)(obj, *args)

    def to_python(self, value):
        """Lua 值 -> JSON 友好的 Python 值（数组识别为 list）。"""
        if type(value).__name__ == "_LuaTable":
            keys = list(value.keys())
            if not keys:
                return []
            if all(isinstance(k, (int, float)) and float(k).is_integer()
                   and 1 <= int(k) <= len(keys) for k in keys):
                return [self.to_python(value[i]) for i in range(1, len(keys) + 1)]
            out = {}
            for k in keys:
                out[str(k)] = self.to_python(value[k])
            return out
        if isinstance(value, float) and (value != value or value in (float("inf"), float("-inf"))):
            return None
        return value

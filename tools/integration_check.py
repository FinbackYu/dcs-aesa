# -*- coding: utf-8 -*-
"""集成自检：加载【已部署】的 aesa_export.lua，模拟 Export 环境（前置回调 + Lo* 桩），
对着真实接收器（端口见 spec/protocol.json）跑回调链，验证连接与采样是否发生。

用法：python tools/integration_check.py [已部署 aesa_export.lua 路径]
缺省路径为 %USERPROFILE%\\Saved Games\\DCS\\Scripts\\AESA\\aesa_export.lua。"""
import os
import sys
import time

import lupa.lua51 as lupa

DEPLOYED = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.expanduser("~"), "Saved Games", "DCS", "Scripts", "AESA", "aesa_export.lua")

rt = lupa.LuaRuntime()
g = rt.globals()

# 模拟此前已加载的其他工具回调（Tacview/ExportScript 链）
prev = rt.eval("function(t) return t + 0.05 end")
g.LuaExportStart = rt.eval("function() end")
g.LuaExportStop = rt.eval("function() end")
g.LuaExportActivityNextEvent = prev

# Lo* 桩
rt.execute("AESA_T = 0")
g.LoGetModelTime = rt.eval("function() AESA_T = AESA_T + 0.1 return AESA_T end")
g.LoGetSelfData = rt.eval("""
function()
  return { Name = 'ITSELF', Position = { x = 1, y = 8000, z = -1 },
           velocity = { x = 0, y = 0, z = -200 } }
end
""")
g.LoGetWorldObjects = rt.eval("""
function()
  return { [42] = { Name = 'Bandit', coalition = 2, Position = { x = 1, y = 8000, z = -60001 },
                    velocity = { x = 0, y = 0, z = 100 } } }
end
""")
g.LoGetTargetInformation = rt.eval("function() return { { ID = 42, distance = 60000, convergence_velocity = 300, reflection = 5, flags = 32 } } end")

src = open(DEPLOYED, encoding="utf-8").read()
print("加载已部署文件（等价 dofile）...")
loader = rt.eval("function(src) local f, e = loadstring(src, '@deployed') if not f then error(e) end return f() end")
mod = loader(src)
print("模块返回类型:", mod and type(mod) or None)

# 检查回调是否被包裹
print("ActivityNextEvent 已被包裹:", g.LuaExportActivityNextEvent is not prev)

# 跑 5 秒回调链
g.LuaExportStart()
for i in range(60):
    t = i * 0.05
    g.LuaExportActivityNextEvent(t)
    time.sleep(0.02)
print("回调链执行完毕，检查接收器数据...")

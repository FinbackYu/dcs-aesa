# 阶段三 3a 设计：外部显示器（网页查看器）

状态：historical（设计记录，2026-09-27；快照已由 `src/core/snapshot.lua` 提供稳定 ENU DTO，见 `docs/architecture.md`）。
更新：2026-09-27。原状态：**已实现并验收**（flight3 录制回放驱动浏览器实测通过）。

## 1. 目标与形态

把阶段一核心 + 阶段二真值管道的输出实时"看见"：receiver 侧本地 HTTP 服务，
浏览器 / 第二屏 / 平板打开即用，不碰 DCS 进程内任何东西（呈现层与数据层解耦，
3b 座舱页之前的独立里程碑）。

## 2. 架构

```
DCS Export（已部署，无改动）
   │ V1 行协议 TCP 127.0.0.1:3590
tools/live.py
   ├─ tcp_feed 线程：解析/录制（同 receiver.serve 语义，V1→重建核心）
   ├─ 主线程：LiveCore —— 帧到达即
   │    增量速度差分修补（T 行无速度字段）
   │    → 时间归一化（t - t0）
   │    → truth_replay:append() 增量追加
   │    → core:step(Δt)（单步上限 1s，防暂停/重连跳变）
   │    → core:snapshot()（现 `src/core/snapshot.lua`，ENU 稳定 DTO）
   ├─ ThreadingHTTPServer(3591)：GET / 首页；GET /stream SSE 10Hz 推 JSON
   └─ 回放模式 --replay <file> [--speed N]：同一查看器、同一管道（0=尽快）
tools/viewer/index.html（单文件、零依赖、vanilla JS canvas）
```

线程模型（硬约束）：lupa LuaRuntime 非线程安全——只有主线程触碰 Lua；
SSE 线程只读主线程产出的 Python 快照（锁交换）。选 SSE 而非 WebSocket：
单向推送足够，stdlib 即可，浏览器原生自动重连。

## 3. 快照内容（SSE JSON）

> 现役：`core:snapshot()` 提供 ENU DTO（`tracks.east_m/north_m/ve_mps/vn_mps`、`beam`、`truth`、`sched` 等），`live.py` 只补 `wall`/`link`/`compat`；viewer 不再读 `sched`/`trk` 内部表或计算 `rel_geo`。以下为 2026-09-27 的原始字段设计。

t / wall / cfg(锥角·方位覆盖·俯仰条) / link(连接·来源·Hz·帧数·引擎接触数)
/ own(机型·高度·速度·航向) / beam(当前驻留方位·俯仰·用途·PRF·Td·命中数)
/ beam_trail(最近 ~150 驻留) / raster(进度 idx/n·帧周期)
/ sched(驻留数·**分用途时间预算** 搜/跟/STT%·迟滞)
/ tracks(编号·确认态·az/el/R/vr·命中) / truth(真值叠加层，前端默认关)。

真值叠加是显式标注的调试层（复选框默认关）——显示器本体只画核心探测/跟踪产物，
与"不偷看世界真值"的原则一致。

## 4. 查看器要素

- **B 扫描**：方位×距离，距离量程自动（航迹最远×1.3 取雷达常用整档，海里）；
  搜索覆盖带底纹，方位/距离网格；显示单位为航空制（海里/节/英尺，仅显示层换算，
  数据链与核心保持 SI）；
- **波束位置指示（AESA 特色核心）**：当前驻留竖线 + 2.5s 渐隐轨迹（按用途着色
  搜索青/跟踪橙/STT 红）——光栅扫描过程直接可见；检测命中时波束顶部闪光；
- 右侧**俯仰条**：搜索条位 + 波束俯仰轨迹；
- **航迹符号**：确认=圆圈+芯点（青），暂定=空心菱形（黄），尾迹渐隐点列；
  单标签两行（编号 / 距离+闭合速度▲▼），四向避让 + 引出线扇出（编队密集区防叠字，
  两轮浏览器视觉验收迭代出来的）；
- **状态栏**：链路/任务时/本机/波束/光栅/时间预算/航迹计数/引擎接触；
- 停更 >2.5s 显示"等待数据"。

## 5. 顺带修的问题（重要）

- **时间基准隐患**：核心时钟从 0 起，若录制/接入从任务中段开始（接收器中途重启、
  断线重连都必然如此），truth_replay 会把所有查询 clamp 在首帧——**在静止真值上
  假跑**，且结果看似合理（检测/航迹照常出）。修复：`to_lua_frames` / `LiveCore`
  都归一化到首帧 t0=0；回归测试 `t_timebase` 用"检测距离必须随运动变化"作判别器。
  已核实 flight3 的 168s 会话恰好从 t=0 录起（先开接收器再进任务），阶段二结论有效。
- truth_replay 新增 `append()`（增量喂数）；core 审计记录补 az/el/vr（显示层原料）。

## 6. 测试（21/21）

新增：t_truth_append / t_timebase（时间基准回归）/ t_live_offline
（LiveCore 全管道含速度差分修补）/ t_live_http（首页 + SSE 流）。

## 7. 用法

```
实时（飞前启动，可同时录制）：
  python tools/live.py --record recordings/flightN.aesarec
回放驱动（演示/复盘，speed 0=尽快）：
  python tools/live.py --replay recordings/flight3-final.aesarec --speed 1.0
浏览器： http://127.0.0.1:3591/
```

## 8. 双显示模式（2026-09-27 追加）

- **B-scope（默认）**：战斗机空对空雷达标准格式——横轴即雷达测量空间（方位角），
  波束分辨率全程均匀；尾迹不向底部中心汇聚是该坐标系固有畸变（R=0 的整条底边都是
  本机），且转向后敌机航线脱靶是真实几何，忠实显示应弯向侧方。
- **俯视图（切换）**：北向上稳定态势显示（对应真机 HSD/数据链层）——世界画布固定、
  本机符号与搜索扇区随机头转动、尾迹=目标真实世界路径直线、距离环、当前波束线。
  B-scope 读几何费劲的场合（交汇/脱靶/转向验证）用它一目了然。
- 模式按钮持久化（localStorage）；真值叠加层在俯视图下按世界坐标原样绘制。

## 9. 后续（3a 范围外）

- STT 交互（点击航迹锁定 → core.set_stt）——协议需上行通道（现在 SSE 只下行）；
- 检测原始 blip 淡出层（现为航迹级显示）；
- 俯仰条改为真俯仰-距离剖面；
- 3b：座舱页面 + 窗口贴附（安装目录 OvGME 打包，按 AGENTS.md 规则）。

# 文件盘点（Gate 0 建立，Gate 4 更新）

状态：current · 更新：2026-10-18 · 范围：`<repo>` 独立仓库。

实测基线（Gate 0 开始前）：git 跟踪 **138** 个文件；另有 gitignored 的 `dist/`（6.8 MB）、`recordings/`（382 MB）与三个 `__pycache__/`。本盘点只列清单，**不删除任何文件**；删除候选统一放在 §6，并注明计划 Gate。同一目录下同构且数量大的用户数据按路径模式合并，并写明实测数量；其余逐文件列出。

Gate 4 后：`src/aesa/` 已删除，A/A 核心位于 `src/core/`，DCS 适配位于 `src/adapters/dcs/`；Python A/A 共用层为 `tools/{lua_host,protocol,ingest,truth}.py`。本文件按当前实际路径列出。

处置图例：**保留**＝继续现役；**移动**＝重构 Gate 内迁移到目标路径；**删除候选**＝只登记，待确认后在计划 Gate 删除；**归档**＝移入带 README 的 `archive/`（需确认）。

---

## 1. 现役（源码、文档、治理）

### 1.0 单一事实源与生成物

| 路径 | 用途 | 归属模块 | 处置 |
|---|---|---|---|
| `spec/physics.json` | 光速、玻尔兹曼、T0、地球半径/折射系数 | 单一事实源 | 保留；改值只改这里 |
| `spec/radar.json` | A/A 雷达、调度、跟踪参数；PRF 名字选择；旧键 renames | 单一事实源 | 保留 |
| `spec/sar.json` | SAR profiles/footprints/materials/MAP/PFA/scene | 单一事实源 | 保留 |
| `spec/protocol.json` | 端口、版本、行 schema、上限、超时、mosaic/dB | 单一事实源 | 保留 |
| `spec/deployment.json` | Saved Games/Scripts/DLL/日志/备份 | 单一事实源 | 保留；Gate 6 消费 |
| `spec/display.json` | dB/mosaic/轮询/量程/颜色 | 单一事实源 | 保留；Gate 5 消费 |
| `scripts/gen_config.cjs` | spec → Lua/JS/C/fixture/文档，`--check` 零 diff | 生成器 | 保留；改 spec 后 `--write` |
| `src/shared/config.lua` | A/A 配置生成物 | 生成物 | 保留；`DO NOT EDIT` |
| `src/shared/protocol.lua` | 协议端口/版本/上限生成物 | 生成物 | 保留；`DO NOT EDIT` |
| `src/shared/config_validate.lua` | 注入配置校验（手写） | 配置校验 | 保留 |
| `src/sar_core/geometry.lua/.cjs` | 场景/MAP canonical 几何 | SAR 核心几何 | 保留（Gate 5 由 `src/geom/scene_geom.*` 迁入） |
| `src/sar_core/{engine,focus,pfa,waveform,memory,scatterers,materials,map,settings,pool,worker}.cjs` | SAR 成像链、聚焦、脉冲/内存、散射/材质、MAP/DBS、质量档、并行池 | SAR 纯核心 | Gate 5 新建；无 DCS/HTTP/文件系统 |
| `src/adapters/dcs/sar_adapter.cjs` | DCS footprint/地表词表/对象 kind/场景校验 | DCS 适配 | Gate 5 新建 |
| `src/shared/config.cjs` | JS 生成配置 | 生成物 | 保留；`DO NOT EDIT`（Gate 5 从 `tools/generated/` 迁入） |
| `src/native/generated/config.h` | C 生成常量 | 生成物 | 保留；`DO NOT EDIT` |
| `tests/fixtures/config.json` | 生成配置快照 | 测试夹具 | 保留；由生成器写 |

### 1.1a DCS API 与兼容层 `src/adapters/dcs/{api,compat}/`

| 路径 | 用途 | 归属模块 | 处置 |
|---|---|---|---|
| `src/adapters/dcs/api/export.lua` | Export 侧 `LoGet*`/terrain/geo/lfs/log/socket 收口 | DCS API | 离线已实现；消费者切换待实机 probe |
| `src/adapters/dcs/api/mission.lua` | `world`/`land`/`Object`/`timer`/`coalition`/`net.dostring_in` 收口 | DCS API | 同上 |
| `src/adapters/dcs/api/hook.lua` | `DCS.*`/lfs/loadlib/net.dostring_in/log 收口 | DCS API | 同上 |
| `src/adapters/dcs/api/native.lua` | `package.loadlib` 逐符号加载/probe | DCS API | 同上 |
| `src/adapters/dcs/api/socket.lua` | LuaSocket 加载/重连/发送收口 | DCS API | 同上 |
| `src/adapters/dcs/compat/profile.lua` | 能力查询、矩阵、FNV-1a hash | 兼容层 | 保留 |
| `src/adapters/dcs/compat/probe.lua` | 39 能力只读探测、COMPAT 行 | 兼容层 | 保留；实机未运行 |
| `src/adapters/dcs/compat/profiles/*.lua` | profile 生成物 | 生成物 | `DO NOT EDIT` |
| `src/native/abi/dcs_profile.h` | 原生 ABI/符号/偏移 | 生成物 | `DO NOT EDIT` |
| `scripts/compat_check.cjs` | 只读基线/矩阵/diff CLI | 兼容工具 | 保留 |
| `tests/fixtures/compat/` | 离线 probe/日志 fixture | 测试夹具 | 保留 |
| `tests/test_gate3_*.{py,cjs}` | API/probe/profile/compat_check 回归 | Gate 3 测试 | 保留 |

### 1.1b A/A 仿真核心 `src/core/`（Gate 4 建立）

| 路径 | 用途 | 归属模块 | 处置 |
|---|---|---|---|
| `src/core/init.lua` | `dofile` 加载入口与组装；配置加载/注入；不加载 DCS 数据 | A/A 入口 | 保留 |
| `src/core/constants.lua` | 物理常量/单位换算/可种子 RNG；`configure()` 注入 | A/A 核心 | 保留 |
| `src/core/physics.lua` | 雷达方程/检测统计 | A/A 核心 | 保留 |
| `src/core/beam.lua` | 扫描角/方向余弦门/双程主瓣因子/主瓣杂波径向速度 | A/A 核心 | 保留 |
| `src/core/detection.lua` | 脉冲遮蔽/距离盲区/速度凹口/`assess` | A/A 核心 | 保留 |
| `src/core/geometry.lua` | ENU 机体基/相对测量/世界点/球面视距 | A/A 核心 | 保留 |
| `src/core/scheduler.lua` | 事件驱动驻留调度器、时间账本 | A/A 核心 | 保留 |
| `src/core/tracker.lua` | 世界系航迹管理、关联、起始、coast | A/A 核心 | 保留 |
| `src/core/measurement.lua` | MeasurementModel：exact/quantized | A/A 核心 | 保留 |
| `src/core/rcs.lua` | RCSProvider 接口（`new`/`passthrough`），不含机型名 | A/A 核心 | 保留 |
| `src/core/snapshot.lua` | 稳定显示 DTO（ENU） | A/A 核心 | 保留 |
| `src/core/core.lua` | `step(dt)`、sink 契约、`snapshot()` | A/A 核心 | 保留 |

### 1.1c A/A DCS 适配 `src/adapters/dcs/`

| 路径 | 用途 | 归属模块 | 处置 |
|---|---|---|---|
| `src/adapters/dcs/frame.lua` | DCS 世界系 ↔ ENU 唯一转换点；旧 V1 `legacy_heading` | A/A 适配 / DCS | 保留 |
| `src/adapters/dcs/truth_replay.lua` | 录制帧 → 按时间插值的 TruthSource（经 frame 转 ENU） | A/A 适配 / DCS | 保留 |
| `src/adapters/dcs/rcs.lua` | DCS 机型分类 + 官方 map 解析 + 分档兜底 | A/A 适配 / DCS | 保留 |
| `src/adapters/dcs/rcs_data.lua` | 机型 RCS 标量表，脚本生成，勿手改 | 生成物 / DCS 适配 | 保留；Gate 6 补 hash |
| `src/adapters/dcs/cockpit/controller.lua` | 座舱桥控制器：读 `state.txt`（含增量字段），按原生 FCR 坐标投影发布 AESA 参数；无世界访问 | 3b 座舱适配 | 新增（C1，C1.5 新投影） |
| `src/adapters/dcs/cockpit/page/MFD_FCR_AESA_AA.lua` | 覆盖 F-16C `PAGE_FCR_AA` 的 AESA A/A 页面（按原生 FCR A/A 页坐标复原布局，299 元素） | 3b 座舱显示 | 新增（C1，C1.5 重排） |

### 1.2 Export `src/export/`

| 路径 | 用途 | 归属模块 | 处置 |
|---|---|---|---|
| `src/export/aesa_export.lua` | A/A 真值采样，V1 行协议 → TCP 3590 | Export 适配 | 保留；Gate 3/4 拆 sampler/protocol/transport/API |
| `src/export/aesa_sar_export.lua` | SAR Export 入口（AESA_SAR bundle 装配） | Export 适配 | 保留 |
| `src/export/sar_protocol.lua` | 线协议常量/词表/footprint 白名单（纯 Lua） | Export 协议 | Gate 5 新建 |
| `src/export/sar_dcs_env.lua` | Export 侧能力探测与 terrain 查询 | Export 适配 | Gate 5 新建 |
| `src/export/sar_collector.lua` | SAR/MAP 命令状态机与行格式 | Export 协议 | Gate 5 新建 |
| `src/export/sar_transport.lua` | TCP 生命周期/握手/命令读取/发送 | Export 传输 | Gate 5 新建 |

### 1.3 场景桥 `src/scene/`

| 路径 | 用途 | 归属模块 | 处置 |
|---|---|---|---|
| `src/scene/aesa_sar_mission.lua` | 任务态入口（AESA_SCENE bundle 装配） | Scene 适配 | 保留 |
| `src/scene/sar_mission_env.lua` | mission API 适配（world/land/Object/timer） | Scene 适配 | Gate 5 新建 |
| `src/scene/sar_scene_core.lua` | 场景网格/对象框/GMTI 序列 | Scene 逻辑 | Gate 5 新建 |

### 1.4 Hooks `src/hooks/`

| 路径 | 用途 | 归属模块 | 处置 |
|---|---|---|---|
| `src/hooks/aesa_fc_hook.lua` | FC 探针加载器；默认加载 `aesa_fc_trace.dll`，仅显式 `mode=1` + profile + inject DLL 条件通过才加载 inject；含 mission 轨迹记录器 | Hooks / Native | 保留；Gate 6 已完成 |
| `src/hooks/aesa_sar_scene_hook.lua` | SAR 场景 Hook 加载器；端口/尺寸对从注入的 `SceneProtocol` 读取 | Hooks | 保留；Gate 6 去裸常量 |

### 1.5 原生 `src/native/`

| 路径 | 用途 | 归属模块 | 处置 |
|---|---|---|---|
| `src/native/agradar_probe/aesa_agradar.c` | 引擎地表类型/64 位掩码只读探针 DLL；导出 `aesa_agradar_profile_check` | Native / AGR | 保留；Gate 3/6 已完成 |
| `src/native/fc_probe/aesa_fc.c` | 单一 C 源：`AESA_FC_TRACE_ONLY` 编译只读 trace；默认构建 trace 超集 + 写路径 | Native / FC | 保留；Gate 6 已完成 |

### 1.6 工具 `tools/`

| 路径 | 用途 | 归属模块 | 处置 |
|---|---|---|---|
| `tools/sar_bridge.cjs` | SAR 场景桥 TCP 客户端与命令拼装 | SAR 桥接 | 保留 |
| `tools/sar_demo_scene.cjs` | 确定性合成场景（`--demo`/测试） | SAR 演示 | Gate 5 新建 |
| `tools/sar_service/*.cjs` | 采集解析、可成像性、MAP/DBS、扫掠、覆盖、拼接、HTTP、录制、组合根 | SAR 服务 | Gate 5 新建（见 `docs/architecture.md` §4.12） |
| `tools/sar_live.cjs` | SAR 服务 CLI 组合根（62 行） | SAR 服务 | 保留；服务模块在 `tools/sar_service/` |
| `tools/sar_viewer.html` | SAR/MAP/DBS 显示与交互 | SAR 显示 | 保留；只读 `/state` 摘要 + `/image/<seq>`/`/snapshot`，不重算物理 |
| `tools/viewer/index.html` | A/A 外部显示器（B 扫/俯视/SSE），只消费 ENU snapshot DTO | A/A 显示 | 保留；Gate 4 已完成 |
| `tools/lua_host.py` | Lua 5.1 宿主；按 `src/core`、`src/adapters/dcs`、`src/shared` 加载模块 | A/A 共用层 | 保留 |
| `tools/protocol.py` | V1 行协议纯解析（`V1`/`PROTO,2`/`COMPAT`/A-O-T-L-E） | A/A 协议 | 保留 |
| `tools/ingest.py` | 录制/会话、速度差分修补 | A/A 数据 | 保留 |
| `tools/truth.py` | Python 帧 → Lua 真值输入；`legacy_for(proto)` | A/A 数据 | 保留 |
| `tools/live.py` | A/A 实时接收/录制/核心步进/HTTP/SSE 薄 CLI；快照来自 `core:snapshot()` | A/A 服务 | 保留；Gate 4 已完成 |
| `tools/receiver.py` | TCP 接收与录制摘要薄 CLI，解析走 `protocol.py`/`ingest.py` | A/A 协议 | 保留 |
| `tools/replay.py` | 录制 → 核心 → 航迹/引擎雷达对照报告薄 CLI；不依赖 `tests/` | A/A 回放 | 保留；Gate 4 已完成 |
| `tools/integration_check.py` | 对已部署 Export 的集成自检（当前硬编码本机 Saved Games 路径） | A/A 工具 | 保留；Gate 4/6 参数化本机路径 |
| `tools/fc_trace_report.py` | `fc_trace.log` 汇总与发射序列重建 | Native 工具 | 保留；Gate 6 随 trace 路径更新 |
| `tools/cockpit_bridge_stub.cjs` | C0/C1 状态文件 10 Hz 桩，供座舱页离线/实机联调 | 3b 座舱工具 | 新增（开发用） |
| `tools/cockpit_bridge.py` | C1.5a 状态桥：snapshot DTO → state.txt 映射、原子写、10 Hz 限频；经 `live.py --cockpit-state` 接入 | 3b 座舱工具 | 新增（C1.5a） |
| `tools/cockpit_preview.html` | 480×480 显示层单文件预览：版面按原生 FCR A/A 页坐标复原，可调模式/量程/方位/BARS/天线俯仰/光标/航迹/STT/武器/牛眼/SOI，导出桥协议 | 3b 座舱显示 | 新增（设计评审用） |

### 1.7 脚本 `scripts/`

| 路径 | 用途 | 归属模块 | 处置 |
|---|---|---|---|
| `scripts/test_all.cjs` | Gate 0 统一测试入口：Python/Node/Lua/原生套件与 skip 汇总 | 治理/测试 | 保留；每次 Gate 必跑 |
| `scripts/audit_repo.cjs` | Gate 0 仓库审计：残留、API 越界、重复常量、文档/生成物/skip | 治理/测试 | 保留；每个 Gate 跑 `--strict` |
| `scripts/capture_baseline.cjs` | Gate 0 基线采集：回放/SAR/协议/state 摘要与 SHA-256 写入 `tests/baseline/` | 治理/测试 | 保留；只写 JSON/哈希，不复制录制/图像/矩阵 |
| `scripts/build_common.cjs` | 共享 gcc/PATH/PE 导出/依赖守卫/Lua 语法检查 | 构建 | Gate 6 新建 |
| `scripts/build_agradar_probe.cjs` | 用工作区 mingw 构建 AGR DLL，复用 `build_common` | 构建 | 保留；Gate 6 已统一 |
| `scripts/build_fc_probe.cjs` | 同一 C 源构建 trace/inject 两个 DLL，断言 trace 无写导出 | 构建 | 保留；Gate 6 已拆分 |
| `scripts/extract_rcs.py` | 从 DCS 明文数据库提取 RCS 表 | 数据生成 | 保留；Gate 1 补 `missile` 兜底 |
| `scripts/install_common.cjs` | 统一 hash/backup/transaction/atomic write/Lua 5.1 检查/DCS 运行检查 | 部署 | Gate 6 新建 |
| `scripts/install_agradar_probe.cjs` | AGR Hook+DLL 部署/修复/卸载/状态；复用 common | 部署 | 保留；Gate 6 已统一 |
| `scripts/install_export.py` | A/A Export 部署（标记块、语法检查、备份、DCS 运行检查） | 部署 | 保留；Gate 6 已加检查 |
| `scripts/install_fc_probe.cjs` | FC Hook + trace DLL 部署；`--with-inject` 才装 inject；旧 `aesa_fc.dll` 迁移 | 部署 | 保留；Gate 6 已拆分 |
| `scripts/install_sar.cjs` | SAR Export 部署，独立 manifest/marker；复用 common | 部署 | 保留；Gate 6 已统一 |
| `scripts/install_sar_scene.cjs` | SAR 场景 Hook 部署（嵌入 mission 源码）；复用 common | 部署 | 保留；Gate 6 已统一 |
| `scripts/install_cockpit.cjs` | F-16C 座舱 AESA 页安装/验证/卸载；页面组合补丁 + 设备注册 + 精确还原 | 部署 / 3b | 新增（C1；深度集成，尚未实机） |
| `scripts/make_fc_trace_mission.py` | 生成 `AESA-FC-Trace-Caucasus.miz` 实验任务 | 实验/工具 | 保留；Gate 6 归档或参数化 |
| `scripts/sar_airport_probe.cjs` | 已知合成机场场景与对照 | SAR 实验 | 保留（测试依赖）；Gate 5 视对照需要归档 |
| `scripts/sar_pfa_probe.cjs` | PFA vs 反投影点响应/图像电平对照 | SAR 实验 | 保留（测试依赖）；Gate 5 归档候选 |
| `scripts/sar_precision_probe.cjs` | 同一实飞录制的标准/精细档对照 | SAR 实验 | 保留；Gate 5 归档候选 |
| `scripts/sar_principle_probe.cjs` | 离线 SAR 原理实验（理想回波+反投影） | SAR 实验 | 保留（测试依赖）；Gate 5 归档候选 |
| `scripts/sar_quality_probe.cjs` | 点响应质量指标与模型对照 | SAR 实验 | 保留（测试依赖）；Gate 5 归档候选 |

### 1.8 测试 `tests/`

| 路径 | 用途 | 归属模块 | 处置 |
|---|---|---|---|
| `tests/helpers.lua` | 恒速真值源、静态 RCS、收集 sink | 测试辅助 | 保留 |
| `tests/run_tests.py` | A/A 核心 22 项单元测试（lupa.lua51） | A/A 测试 | 保留 |
| `tests/test_review_regressions.py` | 物理/调度/集成安全 38 项回归 | A/A 测试 | 保留 |
| `tests/test_gate4_boundary.py` | Gate 4 边界：frame DCS↔ENU、legacy 航向、truth_replay 轴转换 | Gate 4 测试 | 保留 |
| `tests/test_gate4_snapshot.py` | Gate 4 snapshot DTO、on_dwell 四段、MeasurementModel、确定性 | Gate 4 测试 | 保留 |
| `tests/test_viewer_vectors.cjs` | A/A 显示几何与矢量限长回归（Gate 0 起已并入 `test_all`） | 显示测试 | 保留；Gate 4 随 snapshot 迁移 |
| `tests/test_sar_live.cjs` | SAR 服务/HTTP/连续采集 | SAR 测试 | 保留；Gate 5 拆服务单测 |
| `tests/test_sar_map.cjs` | MAP 扇形、格网、DBS、质量 | SAR 测试 | 保留；Gate 5 更新契约 |
| `tests/test_sar_mosaic.cjs` | 拼接、增量、跳过/失败语义 | SAR 测试 | 保留 |
| `tests/test_sar_movers.cjs` | GMTI 动目标与桥降级 | SAR 测试 | 保留 |
| `tests/test_sar_pfa.cjs` | PFA 点响应/图像等价 | SAR 测试 | 保留 |
| `tests/test_sar_pool.cjs` | 并行池结果逐位一致 | SAR 测试 | 保留 |
| `tests/test_sar_principle.cjs` | 原理探针的物理断言 | SAR 测试 | 保留；Gate 5 归档时同步 |
| `tests/test_sar_pulses.cjs` | 脉冲预算/上限/拒绝 | SAR 测试 | 保留 |
| `tests/test_sar_scattering.cjs` | 散射/阴影/叠掩 | SAR 测试 | 保留 |
| `tests/test_sar_scene.cjs` | 场景 schema/footprint | SAR 测试 | 保留 |
| `tests/test_sar_surface.cjs` | 表面求积/窗函数/点质量 | SAR 测试 | 保留 |
| `tests/test_sar_sweep.cjs` | 世界格扫掠/退避/覆盖 | SAR 测试 | 保留 |
| `tests/test_sar_viewer.cjs` | SAR 页面行为（VM 沙箱） | 显示测试 | 保留；Gate 5 只读 metadata |
| `tests/test_install_sar.cjs` | SAR Export 安装/修复/卸载生命周期；`.bak-aesa` 备份 | 部署测试 | 保留；Gate 6 已统一 |
| `tests/test_install_sar_scene.cjs` | 场景 Hook 安装/修复/卸载生命周期 | 部署测试 | 保留；Gate 6 已统一 |
| `tests/test_install_fc.cjs` | FC trace 默认/`--with-inject`/迁移/卸载/DCS 运行守卫 | 部署测试 | Gate 6 新建 |
| `tests/test_install_agradar.cjs` | AGR 安装/验证/卸载/未知文件/DCS 运行守卫 | 部署测试 | Gate 6 新建 |
| `tests/test_gate6_native.cjs` | trace/inject PE 导出表、单一 C 源、hook 选择策略、profile 导出契约 | Gate 回归 | Gate 6 新建 |
| `tests/test_sar_export.lua` | SAR Export Lua 5.1 集成 | Lua 集成 | 保留 |
| `tests/test_sar_mission.lua` | 任务采样器 Lua 5.1 集成 | Lua 集成 | 保留 |
| `tests/test_sar_scene_hook.lua` | 生成的场景 Hook 执行集成 | Lua 集成 | 保留 |
| `tests/test_agradar_probe_dll.py` | AGR DLL 冒烟/惰性失败/16 类表 | Native 测试 | 保留；DLL 未构建则失败 |
| `tests/test_fc_probe_dll.py` | trace + inject 两个 DLL 的导出/日志/空 Lua state 冒烟；trace 负向断言无写导出 | Native 测试 | 保留；Gate 6 已拆分 |
| `tests/test_gate6_native.cjs` | 原生读写拆分的静态守卫（见上） | Gate 回归 | Gate 6 新建 |
| `tests/test_cockpit_page.cjs` | 座舱页/控制器 Lua 桩、无效帧清空、安装器临时树 patch/restore | 3b 座舱测试 | 新增（C1） |
| `tests/test_cockpit_bridge.py` | C1.5a 状态桥映射/原子写/限频单测 + `--replay` 真实管线集成（recordings 缺失则 skip 并打印原因） | 3b 座舱测试 | 新增（C1.5a） |
| `tests/test_gate1_rcs.py` | Gate 1 RCS fallback schema/导弹档/缺键校验 | Gate 回归 | 保留；由 `test_all` 的 `test_gate*.py` 发现 |
| `tests/test_gate1_export.py` | Gate 1 阵营/速度/`vel_valid`/P 行/排序 | Gate 回归 | 保留 |
| `tests/test_gate1_core.py` | Gate 1 稳定 id 排序/确定性 | Gate 回归 | 保留 |
| `tests/test_gate1_physics.py` | Gate 1 俯仰条带覆盖/配置校验 | Gate 回归 | 保留 |
| `tests/test_gate1_native.py` | Gate 1 `readable` 边界/默认只读 mode | Gate 回归 | 保留 |
| `tests/test_sar_gate1_export.cjs` | SAR Export → Collector 跨语言契约 | SAR Gate 回归 | 保留 |
| `tests/test_sar_gate1_map.cjs` | MAP canonical grid/`MAPGRID`/朝向 | SAR Gate 回归 | 保留 |
| `tests/test_sar_gate1_processing.cjs` | effective quality/带宽/宽度与 metadata | SAR Gate 回归 | 保留 |
| `tests/test_sar_gate1_service.cjs` | 手动 `/map` 失败/重发、端口隔离/并发 | SAR Gate 回归 | 保留 |
| `tests/baseline/audit-baseline.json` | 审计 allowlist；Gate 6 起为空（0 条） | 测试基线 | 保留；不得手改计数变绿 |

### 1.9 文档 `docs/`（当前与历史状态）

| 路径 | 用途 | 归属模块 | 处置 |
|---|---|---|---|
| `docs/refactor-plan.md` | 架构重构执行计划（Gate 0–7、决策、门禁） | 重构 | 保留 |
| `docs/gate-6-plan.md` | Gate 6 实施计划（原生拆分/部署/审计清零/文档） | 重构 | 保留；Gate 6 执行清单 |
| `docs/architecture.md` | 模块边界/依赖/文件地图/ADR | 架构 | 保留（Gate 0 建立） |
| `docs/conventions.md` | 坐标/角度/时间/单位/栅格/dB/协议版本 | 约定 | 保留（Gate 0 建立） |
| `docs/dcs-compat.md` | DCS 版本耦合面与更新流程 | 兼容 | 保留（Gate 0 建立） |
| `docs/testing-gates.md` | 测试矩阵、阈值、三色判定 | 测试 | 保留（Gate 0 建立） |
| `docs/file-inventory.md` | 本文件 | 治理 | 保留；每个 Gate 更新 |
| `docs/feasibility.md` | 项目可行性、引擎分层、硬边界 | 背景 | 保留（当前背景） |
| `docs/theory-notes.md` | 物理模型、适用条件、T1–T10 断言 | 理论 | 保留（当前依据） |
| `docs/dcs-map-terrain-interfaces.md` | DCS 地形/地图接口能力与实际接入状态 | 参考 | 保留 |
| `docs/sar-feasibility.md` | SAR 可行性、PFA/几何/散射证据 | SAR 参考 | 保留 |
| `docs/sar-in-mission.md` | SAR/MAP/DBS/GMTI 任务内操作与边界 | SAR 运维 | 保留；Gate 5 随契约更新 |
| `docs/sar-surface-quality.md` | 表面散射与成像质量对照 | SAR 参考 | 保留 |
| `docs/sar-airport-validation.md` | 机场/地表验证流程（当前分支） | SAR 验证 | 保留；Gate 5 复核 |
| `docs/design-sar-airport.md` | 机场开发方案 | SAR 设计 | 保留；Gate 5 复核 |
| `docs/design-phase1.md` | 阶段一核心设计（historical；模块已迁至 `src/core/`） | 历史设计 | 保留；标 historical |
| `docs/design-phase2.md` | 阶段二数据层设计（historical；协议现状见 `architecture.md` §8.1） | 历史设计 | 保留；标 historical |
| `docs/design-phase3a.md` | 3a 外部显示器设计（historical；snapshot 契约已由 `src/core/snapshot.lua` 承接） | 历史设计 | 保留；标 historical |
| `docs/design-cockpit-page.md` | 3b 座舱页设计：覆盖 FCR A/A、数据桥、HOTAS、C1 状态 | 3b 设计 | 新增（current draft） |
| `docs/cockpit-page-concept-square.png` | 480×480 F-16 MFD AESA 页概念图 | 3b 设计 | 新增 |
| `docs/cockpit-page-concept.png` | 476×700 竖屏概念图（F16V 集成方向） | 3b 设计 | 新增 |
| `docs/cockpit-preview-screenshot.png` | `tools/cockpit_preview.html` 的静态预览截图 | 3b 设计 | 新增 |
| `docs/design-fc-injection.md` | 火控注入设计与实验结论 | 历史设计 | 保留；Gate 6 标历史或重写 |
| `docs/design-sar-prototype.md` | 早期 SAR 小切片原型设计 | 历史设计 | 保留；Gate 6 标历史或重写 |
| `docs/review-fixes.md` | 2026-09-30 审查修复记录 | 历史记录 | 保留（只读） |
| `docs/status.md` | 2026-09-30 项目状态快照 | 历史记录 | 保留；已标 `historical`，不再维护 |
| `docs/viewer-vectors.md` | A/A 显示矢量方向与限长规则 | 显示 | 保留 |
| `docs/coverage-agmti.html` | 一次性 A/G(GMTI) 覆盖预测可视化 | 生成物 | 删除候选（Gate 7，见 §6） |
| `docs/coverage-topview.html` | 一次性 A/A 覆盖俯视可视化 | 生成物 | 删除候选（Gate 7，见 §6） |

### 1.10 仓库治理（根目录）

| 路径 | 用途 | 归属模块 | 处置 |
|---|---|---|---|
| `AGENTS.md` | 仓库级开发约定、测试口令、安全边界、清理/Gate 纪律 | 治理 | 保留；每个 Gate 同步事实 |
| `README.md` | 项目介绍、当前结构、文档索引、开发入口 | 治理 | 保留 |
| `DEPRECATIONS.md` | 废弃文件/符号登记（空表） | 治理 | 保留；Gate 0 建立 |
| `LICENSE` | MIT 许可证 | 治理 | 保留 |
| `.gitignore` | 忽略缓存、日志、`dist/*`、`recordings/` | 治理 | 保留 |

---

## 2. 生成物

| 路径 | 用途/来源 | 归属模块 | 处置 |
|---|---|---|---|
| `src/adapters/dcs/rcs_data.lua` | `scripts/extract_rcs.py` 生成的 RCS 表 | 数据生成 | 保留；已有“勿手改”头；Gate 2/6 加 generator/hash |
| `dist/.gitkeep` | 保留发布目录占位 | 发布 | 保留（唯一入库的 dist 文件） |
| `dist/dev/aesa_fc_trace.dll` | `build_fc_probe.cjs` 只读构建（约 103 KB） | Native 构建 | 保留本机；可重建，不入库 |
| `dist/dev/aesa_fc_inject.dll` | `build_fc_probe.cjs` 写构建（约 126 KB） | Native 构建 | 保留本机；可重建，不入库 |
| `dist/dev/aesa_agradar.dll` | `build_agradar_probe.cjs` 构建产物（78,633 B） | Native 构建 | 保留本机；可重建，不入库 |
| `dist/dev/AESA-FC-Trace-Caucasus.miz` | `make_fc_trace_mission.py` 生成的实验任务（6,837,513 B） | 实验/构建 | 保留本机；可重建，不入库 |
| `dist/demo.aesarec` | 早期演示录制（43,703 B） | 用户数据 | 保留本机；不入库 |
| `scripts/__pycache__/` | Python 字节码缓存 | 生成物 | 删除候选（Gate 7，见 §6） |
| `tests/__pycache__/` | Python 字节码缓存 | 生成物 | 删除候选（Gate 7，见 §6） |
| `tools/__pycache__/` | Python 字节码缓存 | 生成物 | 删除候选（Gate 7，见 §6） |
| `docs/coverage-agmti.html`、`docs/coverage-topview.html` | 一次性覆盖预测页面，仅互相引用 | 生成物/历史 | 删除候选（Gate 7，见 §6） |

生成规则：Gate 2 起，所有生成物必须带 `DO NOT EDIT` + generator + hash；`node scripts/gen_config.cjs --check` 零 diff。当前 `rcs_data.lua` 只有生成头，尚未有 hash。

---

## 3. 历史

`worklog/` 全部为历史工作日志，只读存档，不复制其中代码到现役路径。共 30 个文件（28 篇日志 + 模板 + 索引），日志按本地创建时间命名并存入 `2026-09/`、`2026-10/` 月份目录。**`worklog/` 由 `.gitignore` 忽略，只存在于本机、不入库**（2026-10-18 起 `git rm --cached` 取消跟踪）；因此 `docs/` 中引用具体日志路径的链接在干净克隆上不解析，`scripts/audit_repo.cjs` 对此豁免。

| 路径 | 用途 | 归属模块 | 处置 |
|---|---|---|---|
| `worklog/index.md` | 工作日志索引 | 历史 | 保留（只读） |
| `worklog/TEMPLATE.md` | 新日志模板 | 历史 | 保留 |
| `worklog/2026-09/2026-09-30_2237_AESA审查修复与开发阶段校正.md` | 审查修复与阶段校正 | 历史 | 保留（只读） |
| `worklog/2026-09/2026-09-30_2255_AESA速度预测线屏幕限长.md` | 显示矢量限长 | 历史 | 保留（只读） |
| `worklog/2026-09/2026-09-30_2301_对地目标识别与地形库探索.md` | 对地识别/地形库调研 | 历史 | 保留（只读） |
| `worklog/2026-09/2026-09-30_2324_SAR原理成像可行性与离线验证.md` | SAR 原理验证 | 历史 | 保留（只读） |
| `worklog/2026-10/2026-10-01_0025_SAR任务内采集原型与实机成像验证.md` | 任务内 SAR 原型 | 历史 | 保留（只读） |
| `worklog/2026-10/2026-10-01_0114_SAR随机表面散射与成像质量量化.md` | 表面散射质量 | 历史 | 保留（只读） |
| `worklog/2026-10/2026-10-01_2007_SAR经纬度选区与建筑数据边界.md` | 经纬度选区/建筑边界 | 历史 | 保留（只读） |
| `worklog/2026-10/2026-10-01_2044_SAR连续采集与自动恢复.md` | 连续采集 | 历史 | 保留（只读） |
| `worklog/2026-10/2026-10-01_2202_SAR精细模拟波形与清晰度对照.md` | 精细波形 | 历史 | 保留（只读） |
| `worklog/2026-10/2026-10-01_2335_SAR地图高程与成像三栏对照.md` | 三栏对照 | 历史 | 保留（只读） |
| `worklog/2026-10/2026-10-02_0139_SAR地表对象与机场概览.md` | 地表对象/机场 | 历史 | 保留（只读） |
| `worklog/2026-10/2026-10-09_0032_SAR任务桥接直通与拼接余辉.md` | 任务桥/拼接 | 历史 | 保留（只读） |
| `worklog/2026-10/2026-10-15_1820_SAR世界锚定扫掠MAP底图GMTI与座舱化.md` | 扫掠/MAP/GMTI | 历史 | 保留（只读） |
| `worklog/2026-10/2026-10-17_0311_火控注入攻坚与原生探针.md` | 火控注入/原生探针 | 历史 | 保留（只读） |
| `worklog/2026-10/2026-10-17_0325_SAR分层放大工作流与雷达调研归档.md` | SAR 分层放大/调研 | 历史 | 保留（只读） |
| `worklog/2026-10/2026-10-17_2022_火控引导全链路闭环与开源抽象清单.md` | 火控闭环/抽象清单 | 历史 | 保留（只读） |
| `worklog/2026-10/2026-10-17_2022_雷达画质攻坚与原生地表探针.md` | 画质/地表探针 | 历史 | 保留（只读） |
| `worklog/2026-10/2026-10-17_2233_gate-0.md` | Gate 0 基线/决策/盘点 | 历史 | 保留（只读） |
| `worklog/2026-10/2026-10-17_2315_gate-1.md` | Gate 1 正确性止血 | 历史 | 保留（只读） |
| `worklog/2026-10/2026-10-18_0026_gate-2.md` | Gate 2 契约与单一事实源 | 历史 | 保留（只读） |
| `worklog/2026-10/2026-10-18_0118_gate-3-offline.md` | Gate 3 兼容层离线层 | 历史 | 保留（只读） |
| `worklog/2026-10/2026-10-18_0220_gate-3-real-probe.md` | Gate 3 实机 probe 首轮 | 历史 | 保留（只读） |
| `worklog/2026-10/2026-10-18_0302_gate-3-consumer-switch.md` | Gate 3 消费者切换 | 历史 | 保留（只读） |
| `worklog/2026-10/2026-10-18_1637_gate-3-complete.md` | Gate 3 收口 | 历史 | 保留（只读） |
| `worklog/2026-10/2026-10-18_1734_gate-4.md` | Gate 4 收口 | 历史 | 保留（只读） |
| `worklog/2026-10/2026-10-18_2101_gate-5.md` | Gate 5 收口 | 历史 | 保留（只读） |
| `worklog/2026-10/2026-10-18_2253_gate-5-review-fixes.md` | Gate 5 审核修复 | 历史 | 保留（只读） |
| `worklog/2026-10/2026-10-19_0007_gate-6-native-deployment-audit.md` | Gate 6 原生/部署/审计（原生/离线 Green，FC trace 实机通过，A/A/SAR 待复测） | 历史 | 保留（只读） |

`docs/status.md`、`docs/review-fixes.md`、`docs/design-phase*.md`、`docs/design-fc-injection.md`、`docs/design-sar-prototype.md` 的历史属性见 §1.9；均保留，不批量删除。

---

## 4. 外部参考（含第三方）

### 4.1 `docs/research/`（只读，不参与构建）

| 路径 | 用途 | 归属模块 | 处置 |
|---|---|---|---|
| `docs/research/agradar-probe-phase1.md` | AGR 探针阶段一调研 | 外部参考 | 保留（只读） |
| `docs/research/dcs-mod-radar-survey.md` | DCS 社区雷达模组调研 | 外部参考 | 保留（只读） |
| `docs/research/edterrain4-landscape-map.md` | edterrain4 地表/地图逆向笔记 | 外部参考 | 保留（只读） |
| `docs/research/enlight-agradar-map.md` | DCS `radar.fx` / AGR 着色器分析 | 外部参考 | 保留（只读） |
| `docs/research/fire-control-aim120-injection.md` | AIM-120 引导注入调研 | 外部参考 | 保留（只读） |
| `docs/research/fire-control-paths.md` | 火控调用路径调研 | 外部参考 | 保留（只读） |
| `docs/research/sar-real-world-usage.md` | 真实 SAR/AESA 使用调研（510+ 行） | 外部参考 | 保留（只读） |

外部材料 `<workspace>/research/`（缓存、测试依赖、第三方模组样本等）在 aesa 仓库之外，不属于本盘点，也不入库；不要复制进 `src/`。

### 4.2 第三方 `src/native/third_party/minhook/`（保留 + LICENSE，不改造）

| 路径 | 用途 | 归属模块 | 处置 |
|---|---|---|---|
| `src/native/third_party/minhook/LICENSE.txt` | MinHook 许可证 | 第三方 | 保留 |
| `src/native/third_party/minhook/include/MinHook.h` | 公共头 | 第三方 | 保留 |
| `src/native/third_party/minhook/src/{buffer.c,buffer.h,hook.c,trampoline.c,trampoline.h}` | 钩子/跳板/缓冲实现（5 个文件） | 第三方 | 保留 |
| `src/native/third_party/minhook/src/hde/{hde32.c,hde32.h,hde64.c,hde64.h,pstdint.h,table32.h,table64.h}` | HDE 反汇编引擎（7 个文件） | 第三方 | 保留 |

第三方合计 14 个跟踪文件；不批量删除、不重写、不把其代码风格套用到项目源码。

---

## 5. 实验与用户数据

### 5.1 可复现实验脚本（保留，测试依赖）

`scripts/sar_airport_probe.cjs`、`scripts/sar_pfa_probe.cjs`、`scripts/sar_precision_probe.cjs`、`scripts/sar_principle_probe.cjs`、`scripts/sar_quality_probe.cjs` 见 §1.7。它们是测试依赖的可复现实验，Gate 5 若归档必须同步迁移/保留测试入口。

### 5.2 `recordings/`（gitignored，用户数据；不删，清理前确认）

| 路径 | 用途 | 归属模块 | 处置 |
|---|---|---|---|
| `recordings/flight1.aesarec` | 早期实飞录制（47,685 B） | 用户数据 | 保留 |
| `recordings/flight2.aesarec` | 空录制（0 B） | 用户数据 | 删除候选（Gate 7，需确认） |
| `recordings/flight3.aesarec` | flight3 原始录制（12,356,248 B） | 用户数据 | 保留 |
| `recordings/flight3-final.aesarec` | 168 s 完整会话，回放/演示标准素材（7,714,864 B） | 用户数据 | 保留 |
| `recordings/flight4.aesarec` | 实飞录制（10,785,682 B） | 用户数据 | 保留 |
| `recordings/flight5.aesarec` | 实飞录制（2,109,461 B） | 用户数据 | 保留 |
| `recordings/flight6.aesarec` | 实飞录制（14,625,971 B） | 用户数据 | 保留 |
| `recordings/flight7.aesarec` | 实飞录制（5,276,561 B） | 用户数据 | 保留 |
| `recordings/flight8.aesarec` | 实飞录制（5,949,547 B） | 用户数据 | 保留 |
| `recordings/flight9.aesarec` | 最长实飞录制（256,078,590 B） | 用户数据 | 保留 |
| `recordings/selftest.aesarec` | 自检录制（3,473 B） | 用户数据 | 保留 |
| `recordings/sar/` | 171 个 SAR 切片/快照 JSON，模式 `sar-<epoch>-<seq>.json` | 用户数据/实验 | 保留或归档（需确认） |
| `recordings/sar-airport-probe/` | 机场验证 4 件：`comparison.json`、`metrics.json`、`scene.json`、`snapshot.json` | 实验数据 | 保留或归档（需确认） |

### 5.3 `recordings/sar-preview/` 一次性实验产物（35 个顶层文件）

截图（13）：`airport-viewer.png`、`continuous-capture.png`、`continuous-result.png`、`dcs-replay.png`、`demo.png`、`fine-live.png`、`geographic-target.png`、`map-comparison.png`、`precision-comparison.png`、`relief-flight-diagnosis.png`、`surface-comparison.png`、`surface-replay.png`、`terrain-diagnosis.png`。

JSON/HTML 快照与报告（16）：`live-before-quality.json`、`map-upgrade-snapshot.json`、`pre-airport-continuous.json`、`pre-airport-snapshot.json`、`relief-flight-diagnosis.json`、`relief-flight-metrics.json`、`relief-flight-scene.json`、`relief-flight-snapshot.json`、`surface-metrics.json`、`terrain-diagnosis-metrics.json`、`terrain-diagnosis-scene.json`、`terrain-diagnosis-state.json`、`precision-comparison.html`、`relief-flight-diagnosis.html`、`surface-comparison.html`、`terrain-diagnosis.html`。

脚本（6）：`append-continuous-worklog.sh`、`append-geographic-worklog.sh`、`append-map-worklog.sh`、`append-precision-worklog.sh`、`relief-diagnosis.cjs`、`terrain-diagnosis.cjs`。

浏览器 profile（不在上述 35 内，共 736 个文件 / 49 MB）：`recordings/sar-preview/airport-browser/`（244）、`browser-profile/`（207）、`browser-profile-2/`（285）。这些是 Edge/浏览器缓存与用户配置，不是项目产物。

### 5.4 实验任务

`dist/dev/AESA-FC-Trace-Caucasus.miz`（见 §2）为火控 trace 实验任务，可由 `scripts/make_fc_trace_mission.py` 重建；保留本机，不入库。

---

## 6. 删除候选（只登记，Gate 0 不删除）

| 路径/模式 | 类别 | 理由 | 计划 Gate | 备注 |
|---|---|---|---|---|
| `scripts/__pycache__/`、`tests/__pycache__/`、`tools/__pycache__/` | 生成缓存 | 可随时重建，gitignored | Gate 7（可随时安全清理） | 不参与构建；删除不影响测试 |
| `recordings/sar-preview/airport-browser/`（244 文件） | 浏览器缓存 | 一次性浏览器 profile | Gate 7 | 需用户确认；在 gitignored `recordings/` 内 |
| `recordings/sar-preview/browser-profile/`（207 文件） | 浏览器缓存 | 一次性浏览器 profile | Gate 7 | 需用户确认 |
| `recordings/sar-preview/browser-profile-2/`（285 文件） | 浏览器缓存 | 一次性浏览器 profile | Gate 7 | 需用户确认 |
| `docs/coverage-agmti.html`、`docs/coverage-topview.html` | 一次性生成物 | 仅互相引用，无构建/文档依赖 | Gate 7 | 可先归档；删除需确认 |
| `recordings/flight2.aesarec` | 用户数据 | 0 字节空录制 | Gate 7 | 需用户确认 |
| `recordings/sar-preview/*.png`、`*.html`、`*.json`（§5.3 的 29 个快照/报告） | 一次性实验产物 | 无构建依赖，可由录制重算 | Gate 7 | 建议归档或删除，需用户确认 |
| `recordings/sar-preview/append-*.sh`（4 个） | 一次性脚本 | 写 worklog 的临时脚本 | Gate 7 | 若仍有复用价值先移入 `scripts/` |
| `recordings/sar-preview/relief-diagnosis.cjs`、`terrain-diagnosis.cjs` | 一次性脚本 | 诊断用，未入库 | Gate 7 | 若仍需复现，移入 `scripts/` 后归档 |
| `dist/dev/aesa_fc_trace.dll`、`aesa_fc_inject.dll`、`aesa_agradar.dll`、`AESA-FC-Trace-Caucasus.miz` | 构建产物 | 可由脚本重建 | Gate 7（发布/归档时） | 当前测试仍需，先保留本机 |
| `dist/demo.aesarec` | 用户数据 | 早期演示录制 | 不删除 | 需用户确认是否保留 |

**明确不在删除候选内**（避免误删）：

- `recordings/` 与 `dist/dev/*.miz`：用户数据，清理前必须确认。
- `docs/research/`：外部参考，只读保留。
- `worklog/`：历史存档，只读保留；gitignored 本机数据，不入库。
- `src/native/third_party/minhook/`：第三方代码 + LICENSE，保留且不改造。
- `docs/status.md`、`docs/review-fixes.md`、`docs/design-*.md`：历史/设计记录，保留；由 Gate 6 决定重写或标历史。
- `src/adapters/dcs/rcs_data.lua`：生成物但为现役数据，保留并由 `extract_rcs.py` 重生成。
- `AGENTS.md`、`README.md`、`DEPRECATIONS.md`、`.gitignore`、`LICENSE`：治理文件，保留。

当前未发现 `_old`/`_new`/`_v2`/`copy`/`backup`/`*.bak`/`*.tmp`/`deprecated` 命名的跟踪文件；未发现未登记的 `TODO/FIXME/XXX/HACK/DEPRECATED` 源码标记。每个 Gate 结束时用 `node scripts/audit_repo.cjs` 复核本清单。

**Gate 7 处置（2026-10-19）**：`scripts/__pycache__/`、`tests/__pycache__/`、`tools/__pycache__/` 已删除，`git clean -nd` 为空；`DEPRECATIONS.md` 清空（旧 `aesa_fc.dll` 与 `install_sar` re-export 已无调用方）。`recordings/sar-preview/`、`recordings/flight2.aesarec`、`docs/coverage-*.html`、`dist/dev/*` 属于用户数据/历史生成物/测试依赖，未获删除确认，保留；`recordings/` 与 `worklog/` 继续 gitignored。

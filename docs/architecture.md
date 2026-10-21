# aesa 架构

| 项 | 内容 |
|---|---|
| 状态 | current |
| 更新 | 2026-10-19 |
| owner | 项目维护者（架构与边界） |
| 范围 | 仓库内所有现役代码、工具、脚本、测试与文档的模块边界；含 3b C1 座舱页适配（`src/adapters/dcs/cockpit/`），不含 3c 帧内渲染、MP 完整性、发布打包 |
| 基线 | tag `pre-arch-refactor`（Gate 0 冻结的当前可演示状态） |
| 决策 | D1–D4 全部采用计划推荐 A 方案，见 §5 |
| Gate 状态 | Gate 0–7 完成；Gate 7 全量回归与收口完成，tag `arch-refactor-complete` |

相关文档：[重构执行计划](refactor-plan.md) · [坐标/单位/协议约定](conventions.md) · [DCS 兼容层](dcs-compat.md) · [测试与 Gate 门禁](testing-gates.md) · [文件盘点](file-inventory.md)

本文件描述**代码实际边界**，不是愿望清单。§2.1 与 §4 的“现状”以 Gate 4 完成后的代码为准；“目标”是 Gate 5–6 的迁移合同。结构发生变化时，必须在同一个 Gate 更新本文件，否则 `scripts/audit_repo.cjs` 的文档一致性检查视为失败。

---

## 1. 目标与非目标

### 1.1 目标

1. **原理与游戏分离**：`src/core` 与 `src/sar_core` 不出现 DCS 机型名、`visible`、`Heading + π/2`、`LoGet*`、`land.*`、`world.*`；游戏 API 只在 `src/adapters/dcs/api/`。
2. **一个概念一个所有者**：物理常数、雷达/波形、场景/战术、协议/采集、部署、显示各自只有一个配置来源（`spec/`）。
3. **游戏更新可集中验证**：DCS build/module profile、启动探针、`compat_check` 三者构成唯一版本耦合面；缺能力 fail-closed。
4. **服务可独立测试**：`sar_live.cjs` 只做组合根；Collector、Arbiter、Sessions、Sweep、Coverage、Mosaic、Recorder、HttpApi 可单测。
5. **显示只消费结果**：viewer 不重算分辨率、机体投影、相对角；物理量由 snapshot/metadata 提供。
6. **零残留**：被替代的旧文件、旧常量、旧配置、旧文档在同一 Gate 删除或归档，不留 `_old`/`_v2`/`copy`/`bak`/`tmp`。

### 1.2 非目标（本轮重构不做；3b 已另起功能线）

- 3c 帧内渲染、窗口贴附；3b C1 座舱页已在 `src/adapters/dcs/cockpit/` 开始，不属于 Gate 0–7 的重构范围。
- MP 完整性校验、服务端兼容性、长期运行稳定性。
- 发布打包、签名、分发、版本号策略。
- 新雷达模式、新数据源、多雷达/多实例。
- 完整测量噪声模型（只保留 `MeasurementModel` 接口，默认 exact）。
- 超出“不退化”的性能优化。

以上项目在 Gate 7 完成后单独排期，不混入本轮重构；详见[重构计划 §11](refactor-plan.md#11-本轮不包含)。

---

## 2. 当前结构与目标结构

### 2.1 当前结构（Gate 5 完成后）

```text
aesa/
├─ docs/                         # 设计、理论、验证记录、调研（§4.10）
├─ recordings/                   # 实飞录制与 SAR 场景 JSON（本机数据，gitignore）
├─ dist/                         # dev 构建产物 .dll / .miz（gitignore，仅 .gitkeep 入库）
├─ spec/                         # 单一事实源（physics/radar/sar/protocol/deployment/display）
├─ src/
│  ├─ shared/                    # 生成配置：config.lua、protocol.lua；手写 config_validate.lua
│  ├─ sar_core/                  # 纯 JS SAR 核心（Gate 5）：无 DCS、无 HTTP、无文件系统
│  │  ├─ geometry.cjs/.lua       # canonical 场景/MAP 几何（原 src/geom/scene_geom.*）
│  │  ├─ engine.cjs              # 成像链：栅格/脉冲规划 + 回波合成 + 聚焦
│  │  ├─ focus.cjs               # 时域反投影聚焦器
│  │  ├─ pfa.cjs                 # 极坐标格式（频域）聚焦器
│  │  ├─ waveform.cjs            # 一个合成孔径的脉冲序列
│  │  ├─ memory.cjs              # 回波历史内存预算
│  │  ├─ scatterers.cjs          # 漫反射采样点/散射/遮挡
│  │  ├─ materials.cjs           # 地表 16 类系数与优先级
│  │  ├─ map.cjs                 # 实波束 MAP/DBS 渲染
│  │  ├─ settings.cjs            # 处理选项/质量档/footprint 上限
│  │  ├─ pool.cjs / worker.cjs   # 并行池与 worker 入口
│  ├─ core/                      # 纯 Lua 5.1 A/A 核心：无 DCS、无 IO、ENU 帧
│  │  ├─ init.lua                # dofile 组装；配置加载/注入
│  │  ├─ constants.lua           # 物理常量/单位换算/可种子 RNG（configure 注入）
│  │  ├─ physics.lua             # 雷达方程/检测统计
│  │  ├─ beam.lua                # 扫描角/方向余弦门/双程主瓣因子/主瓣杂波径向速度
│  │  ├─ detection.lua           # 脉冲遮蔽/距离盲区/速度凹口/assess
│  │  ├─ geometry.lua            # ENU 机体基/相对测量/世界点/球面视距
│  │  ├─ scheduler.lua           # 事件驱动驻留调度
│  │  ├─ tracker.lua             # 世界系航迹管理
│  │  ├─ measurement.lua         # MeasurementModel（默认 exact；可注入 quantized）
│  │  ├─ rcs.lua                 # RCSProvider 接口（new/passthrough）
│  │  ├─ snapshot.lua            # 稳定显示 DTO
│  │  └─ core.lua                # step(dt) 组装、sink 契约、snapshot()
│  ├─ adapters/dcs/
│  │  ├─ frame.lua               # DCS ↔ ENU 唯一转换点（含旧 V1 legacy_heading）
│  │  ├─ truth_replay.lua        # 录制帧 → 核心 TruthSource
│  │  ├─ rcs.lua                 # DCS 机型分类 + 官方 map 解析
│  │  ├─ rcs_data.lua            # 由 scripts/extract_rcs.py 生成
│  │  ├─ api/                    # export/mission/hook/native/socket：游戏 API 单点
│  │  ├─ cockpit/                # 3b C1：F-16C FCR A/A 覆盖页 + 状态文件桥控制器
│  │  └─ compat/                 # profile.lua、probe.lua、profiles/*.lua（生成物）
│  ├─ export/
│  │  ├─ aesa_export.lua         # A/A V1 采样 + PROTO,2 + COMPAT + socket + DCS API
│  │  ├─ aesa_sar_export.lua     # SAR Export 入口（AESA_SAR bundle，薄装配）
│  │  ├─ sar_protocol.lua        # 线协议常量/词表/几何白名单（纯 Lua）
│  │  ├─ sar_dcs_env.lua         # Export 侧能力探测与 terrain 查询
│  │  ├─ sar_collector.lua       # SAR/MAP 命令状态机与行格式
│  │  └─ sar_transport.lua       # TCP 生命周期/握手/命令与发送
│  ├─ scene/
│  │  ├─ aesa_sar_mission.lua    # 任务态入口（AESA_SCENE bundle）
│  │  ├─ sar_mission_env.lua     # mission API 适配（world/land/timer）
│  │  └─ sar_scene_core.lua      # 场景网格/对象框/GMTI 序列
│  ├─ hooks/
│  │  ├─ aesa_agradar_hook.lua   # AGR 原生探针加载器（只读）
│  │  ├─ aesa_fc_hook.lua        # 火控探针加载器（trace + 注入 + 任务态记录器）
│  │  └─ aesa_sar_scene_hook.lua # 生成文件：内嵌 mission 源码 + TCP 桥
│  └─ native/
│     ├─ abi/dcs_profile.h       # 由 spec/dcs_profiles 生成
│     ├─ agradar_probe/aesa_agradar.c
│     ├─ fc_probe/aesa_fc.c
│     └─ third_party/minhook/    # 原样引入的 MinHook（含 LICENSE）
├─ tools/
│  ├─ sar_service/               # SAR 服务（adapters，Gate 5）
│  │  ├─ service.cjs             # 组合根：TCP 3592 + HTTP 3593 + 场景桥 3594 生命周期
│  │  ├─ collector.cjs           # Export 行解析与作业状态
│  │  ├─ arbiter.cjs             # 可成像性判定（侧视窗/距离）
│  │  ├─ map_session.cjs         # MAP/DBS 会话
│  │  ├─ dbs_session.cjs         # DBS 锐化会话
│  │  ├─ sweep_planner.cjs       # 广域扫掠计划
│  │  ├─ coverage_index.cjs      # 扇区/覆盖索引
│  │  ├─ mosaic_store.cjs        # Int8 拼接存储与 db_ref
│  │  ├─ http_api.cjs            # /state、/image/<seq>、/reference、/snapshot、POST 命令
│  │  └─ recorder.cjs            # recordings/sar/*.json
│  ├─ sar_bridge.cjs             # 场景桥 TCP 客户端
│  ├─ sar_demo_scene.cjs         # 确定性合成场景（--demo 与测试）
│  ├─ sar_live.cjs               # SAR 服务 CLI（<300 行组合根）
│  ├─ sar_viewer.html            # SAR 页面（只消费 /state 摘要 + /image、/snapshot）
│  ├─ lua_host.py / protocol.py / ingest.py / truth.py   # A/A 共用层
│  ├─ live.py / receiver.py / replay.py                  # 薄 CLI
│  ├─ integration_check.py / fc_trace_report.py
│  └─ viewer/index.html          # A/A 页面（消费 ENU snapshot DTO）
├─ scripts/                      # 提取、构建、部署、离线探针（§4.8）
└─ tests/                        # Python + lupa、Node test、Lua 5.1 测试（§4.9）
```

结构特征（Gate 4 完成后；仍然存在的债务在 §9）：

- **核心与游戏语义已分离**。`src/core/` 只接受 ENU：x 东、y 北、z 上，航向从北顺时针，俯仰上仰为正，滚转右翼下沉为正。DCS 轴、`Heading + π/2`、MSL 高度与机型名只出现在 `src/adapters/dcs/`；旧 V1 录制的航向偏移只由 `frame.lua` 的 `legacy_heading` 修正。
- **`src/aesa/` 已删除**。A/A 核心全部位于 `src/core/`；回放/RCS/DCS 分类位于 `src/adapters/dcs/`；没有 `default_rcs`，核心 `rcs.lua` 只是接口（`new(values, default_class)` / `passthrough()`）。
- **DCS 宿主经 runtime bundle 收口**：`aesa_export.lua`、`aesa_sar_export.lua`、`aesa_sar_scene_hook.lua` 与 hooks 通过 `AESA_RUNTIME` 调用 `api/*`；`src/export`、`src/hooks`、`src/scene` 中不再直接出现 socket/lfs/`LoGet*`（Gate 3 已完成消费者切换）。
- **SAR 物理在 `src/sar_core/`（Gate 5 已落地，D2）**：纯 JS，不 import DCS 适配、服务、桥接或 viewer；`tools/` 只做适配、服务与显示，`src/adapters/dcs/sar_adapter.cjs` 是 DCS 词汇（footprint、地表词表、场景校验、DBS 参考）的唯一入口。
- **SAR 服务已拆分为 `tools/sar_service/`**：`sar_live.cjs` 只剩 CLI 组合根；采集解析、可成像性判定、MAP/DBS 会话、扫掠、覆盖、拼接、HTTP 与录制各自成模块。
- **SAR Export / mission 已拆分**：协议常量、环境探测、采集状态机、传输层分别在 `src/export/sar_*.lua`；任务侧拆成入口、环境与场景核心；部署形态仍是由 `scripts/build_runtime.cjs` 生成的单文件 bundle。
- **D3 已落地**：`/state` 只回摘要 + `resultSeq`；矩阵走 `/image/<seq>`（`/mosaic/<seq>` 为兼容别名）与 `/snapshot`；viewer 在 `completed` 变化时按 seq 拉图，不再重算物理或分辨率。
- **参数与协议已单点化**：光速、λ、端口、footprint、1–50 km、地表 16 类词表、MAP 默认值、dB 量化步长均由 `spec/` 生成（§6）。
- **原生读写已隔离（Gate 6 完成，D4）**：`src/native/fc_probe/aesa_fc.c` 用 `AESA_FC_TRACE_ONLY` 编译出只读 `aesa_fc_trace.dll` 与写路径超集 `aesa_fc_inject.dll`；默认只读，写路径需 `mode=1` + profile 校验 + 显式 `--with-inject`。同一时刻只加载一个 DLL。

### 2.2 目标结构

目标树来自[重构计划 §4.1](refactor-plan.md#41-目录)，是本轮迁移的合同。**Gate 2 已建立 `spec/`、`src/shared/`、`src/native/generated/`；Gate 3 已建立 `src/adapters/dcs/{api,compat}`；Gate 4 已建立 `src/core/` 与 `src/adapters/dcs/{frame,truth_replay,rcs,rcs_data}` 并删除 `src/aesa/`；Gate 5 已建立 `src/sar_core/`、`tools/sar_service/`，完成 SAR Export/mission 拆分，把 JS 生成配置落到 `src/shared/config.cjs` 并删除 `src/geom/`、`tools/generated/` 与旧 SAR 单文件；Gate 6 已建立 `src/native/fc_probe` 的 trace/inject 双构建、`build_common` 与 `install_common`；Gate 7 已完成全量回归与收口。**

```text
aesa/
├─ spec/                         # 单一事实源（Gate 2）
│  ├─ physics.json
│  ├─ radar.json
│  ├─ sar.json
│  ├─ protocol.json
│  ├─ deployment.json
│  ├─ display.json
│  └─ dcs_profiles/dcs-<build>.json
├─ src/
│  ├─ core/                      # 纯 Lua A/A：无 DCS、无 IO（Gate 4 已建立）
│  │  ├─ constants.lua
│  │  ├─ physics.lua
│  │  ├─ geometry.lua
│  │  ├─ beam.lua
│  │  ├─ detection.lua
│  │  ├─ scheduler.lua
│  │  ├─ tracker.lua
│  │  ├─ core.lua
│  │  ├─ snapshot.lua
│  │  ├─ measurement.lua
│  │  ├─ rcs.lua                  # RCSProvider 接口
│  │  └─ init.lua
│  ├─ adapters/dcs/
│  │  ├─ frame.lua               # 唯一的帧/姿态转换点（D1）
│  │  ├─ truth_replay.lua
│  │  ├─ rcs.lua
│  │  ├─ rcs_data.lua
│  │  ├─ api/{export,mission,hook,native}.lua
│  │  ├─ compat/{profile,probe}.lua + profiles/
│  │  └─ data/{surfaces,shaders}.lua
│  ├─ export/                    # 薄采样/协议/传输
│  │  ├─ aa_sampler.lua
│  │  ├─ aa_protocol.lua
│  │  ├─ aa_transport.lua
│  │  ├─ sar_protocol.lua
│  │  ├─ sar_collector.lua
│  │  └─ sar_transport.lua
│  ├─ scene/{sar_scene_core,sar_mission_env}.lua
│  ├─ hooks/                     # 生命周期/桥接
│  ├─ native/
│  │  ├─ abi/dcs_profile.h       # 由 profile 生成
│  │  ├─ agradar_probe/
│  │  ├─ fc_trace/               # 只读
│  │  └─ fc_inject/              # 写，独立 DLL
│  ├─ sar_core/                  # 纯 JS SAR：无 DCS、无 HTTP、无 fs
│  │  ├─ geometry.cjs
│  │  ├─ waveform.cjs
│  │  ├─ scatterers.cjs
│  │  ├─ materials.cjs
│  │  ├─ engine.cjs
│  │  ├─ focus.cjs
│  │  ├─ pfa.cjs
│  │  ├─ map.cjs
│  │  ├─ memory.cjs
│  │  └─ pool.cjs
│  └─ shared/{config,protocol}.lua   # 生成物
├─ tools/
│  ├─ sar_service/               # 组合/HTTP/作业（Gate 5）
│  │  ├─ collector.cjs
│  │  ├─ arbiter.cjs
│  │  ├─ sar_session.cjs
│  │  ├─ map_session.cjs
│  │  ├─ dbs_session.cjs
│  │  ├─ sweep_planner.cjs
│  │  ├─ coverage_index.cjs
│  │  ├─ mosaic_store.cjs
│  │  ├─ recorder.cjs
│  │  ├─ http_api.cjs
│  │  └─ service.cjs
│  ├─ sar_live.cjs               # 兼容入口/CLI，仅组合根，目标 <300 行
│  ├─ lua_host.py
│  ├─ protocol.py
│  ├─ ingest.py
│  ├─ truth.py
│  ├─ receiver.py / live.py / replay.py   # 薄 CLI
│  ├─ sar_viewer.html
│  └─ viewer/
├─ scripts/
│  ├─ test_all.cjs
│  ├─ audit_repo.cjs
│  ├─ gen_config.cjs
│  ├─ compat_check.cjs
│  ├─ install_common.cjs
│  └─ install_*.cjs
└─ tests/
   ├─ baseline/
   └─ fixtures/
```

### 2.3 现状 → 目标映射

| 现状 | 目标 | Gate |
|---|---|---|
| `src/aesa/*`（已删除） | 接口/物理 → `src/core/*`；DCS 回放/RCS → `src/adapters/dcs/*` | 4（已完成） |
| `src/shared/config.lua` | 已由 `spec/radar.json` + `spec/physics.json` 生成；`src/core/init.lua` 加载并支持注入 | 2（已完成） |
| `src/export/aesa_export.lua` | `aa_sampler` + `aa_protocol` + `aa_transport` + `adapters/dcs/api/export.lua` | 3/4（协议层已更新；文件拆分未开始） |
| `src/export/aesa_sar_export.lua` | `sar_protocol` + `sar_collector` + `sar_transport` + `adapters/dcs/api/export.lua` | 3/5 |
| `src/scene/aesa_sar_mission.lua` | `sar_scene_core.lua` + `sar_mission_env.lua` | 5 |
| `src/hooks/*` | 生命周期/桥接；API 调用进 `adapters/dcs/api/hook.lua`、`native.lua` | 3/6 |
| `src/native/agradar_probe` | 原位 + `abi/dcs_profile.h` 自检 | 6 |
| `src/native/fc_probe` | 拆 `fc_trace/`（只读）+ `fc_inject/`（写） | 6 |
| `tools/sar_{engine,surface,pfa,pulses,scattering,map,pool,worker}.cjs` | 物理进 `src/sar_core/*`；DCS 词汇进 `adapters/dcs/sar_adapter.cjs` | 5 |
| `tools/sar_live.cjs` | `tools/sar_service/*` + 薄 CLI | 5 |
| `tools/live.py`/`receiver.py`/`replay.py` | `lua_host.py`/`protocol.py`/`ingest.py`/`truth.py` + 薄 CLI | 4（已完成） |
| `tools/sar_viewer.html`、`tools/viewer/index.html` | 原位；只消费 snapshot/metadata | 4（A/A 已完成）/5（SAR） |
| `scripts/install_*.cjs`、`install_export.py` | `install_common.cjs` + 产品脚本 | 6 |
| `scripts/sar_*_probe.cjs` | 消费 `src/sar_core` + 生成配置，不再自带物理 | 5 |

---

## 3. 依赖方向与硬规则

### 3.1 当前依赖（Gate 5 实测）

```text
src/core/init.lua
  └─ dofile: ../shared/config_validate, ../shared/config,
             constants, physics, beam, detection, geometry, scheduler,
             tracker, rcs, measurement, snapshot, core
src/core/core.lua
  ├─ mods.{constants,physics,beam,detection,geometry,scheduler,tracker,measurement,snapshot}
  └─ truth / rcs / sink（鸭子类型适配器，契约见 §附录 A）
src/core/geometry.lua       # 纯 ENU；body_basis 由 heading/pitch/roll 构造
src/adapters/dcs/frame.lua  # DCS → ENU 唯一转换；legacy_heading 只服务旧 V1
src/adapters/dcs/truth_replay.lua  # 录制帧适配器；调用 frame.ownship/target
src/adapters/dcs/rcs.lua    # DCS 机型分类 + rcs_data 官方 map

src/export/*.lua            # 经 AESA_RUNTIME 调用 api/*；自身仍负责行协议/传输
src/hooks/*.lua             # 经 AESA_RUNTIME 调用 api/* 与 package.loadlib
src/scene/aesa_sar_mission.lua  # 任务态入口：绑定 sar_mission_env + sar_scene_core（Gate 5 收口）

tools/sar_live.cjs          # CLI 组合根；服务模块在 tools/sar_service/
  ├─ sar_service/{collector,arbiter,map_session,dbs_session,sweep_planner,
  │               coverage_index,mosaic_store,recorder,http_api,service}
  ├─ src/sar_core/{engine,focus,pfa,map,waveform,memory,scatterers,materials,pool}
  ├─ src/adapters/dcs/sar_adapter.cjs（footprint/地表词/对象 kind/场景校验）
  ├─ sar_bridge（TCP 3594，场景桥）
  └─ sar_viewer.html（HTTP 3593）

tools/live.py
  ├─ lua_host.py → src/core/init.lua + src/adapters/dcs/*
  ├─ protocol.py / ingest.py / truth.py（解析、录制、Lua 帧）
  └─ viewer/index.html（SSE /stream，消费 snapshot DTO）
tools/replay.py
  ├─ lua_host.py / protocol.py / ingest.py / truth.py
  └─ （不再依赖 tests/）
```

### 3.2 目标依赖

**配置生成链**（改参数只改 spec，生成物零 diff 是门禁）：

```text
                spec/*.json（物理/雷达/SAR/协议/部署/显示 + dcs_profiles）
                                   │ scripts/gen_config.cjs
        ┌──────────────────────────┼────────────────────────────┐
        ▼                          ▼                            ▼
 src/shared/config.lua    src/shared/config.cjs      src/native/generated/config.h
 + protocol.lua           （SAR JS 配置）             + abi/dcs_profile.h（profile 生成）
```

**模块分层与运行时数据流**（箭头 = 依赖/数据方向；`════` = DCS 进程边界）：

```text
┌─ DCS 进程外（宿主机） ─────────────────────────────────────────────────────┐
│                                                                            │
│  tools/sar_service/* ──使用──▶ src/sar_core（纯 JS：成像/聚焦/MAP；         │
│   （编排/会话/HTTP 3593）        无 DCS、无 HTTP、无 fs）                   │
│                                                                            │
│  tools/{live,receiver,replay}.py ──经 lua_host──▶ src/core（纯 Lua：       │
│                                                    调度/方程/航迹）        │
│  tools/cockpit_bridge.py ──写──▶ state.txt（10 Hz）                        │
│  viewer/*（HTML；只读 snapshot/图像，不重算物理）                           │
└──────▲────────────────▲───────────────────────────▲───────────▲────────────┘
       │                │                           │           │
       │ TCP 3590/3592  │ TCP 3594                  │ TCP 3592  │ state.txt
       │ A/A + SAR 下行 │ 场景查询上行               │ SAR 下行  │ 座舱状态上行
       │                │                           │           │
╪══════╪════════════════╪═══════════════════════════╪═══════════╪═══════════╪
       │                │                           │           │
┌──────┴───────┐ ┌──────┴───────┐           ┌───────┴───────┐ ┌─┴───────────┐
│ src/export   │ │ src/scene    │           │ src/hooks     │ │ adapters/   │
│ A/A 采样      │ │ 任务场景桥    │           │ 3 个 hook：    │ │ dcs/cockpit │
│ + SAR 采集    │ │ GMTI/场景序列 │           │ 生命周期/桥接  │ │ controller  │
└──────▲───────┘ └──────▲───────┘           └───────▲───────┘ └─▲───────────┘
       │                │                           │           │
       └────────────────┴───────┬───────────────────┴───────────┘
                                │ AESA_RUNTIME（build_runtime.cjs 打包）
              ┌─────────────────┴────────────────────────────────┐
              │ src/adapters/dcs —— 唯一的 DCS 语义层             │
              │ frame（帧/姿态转换 D1）· truth_replay · rcs       │
              │ api/{export,mission,hook,native,socket}（API 单点）│
              │ compat（profile/probe 能力矩阵）                  │
              └───────▲──────────────────────────▲───────────────┘
                      │                          │ package.loadlib
        ┌─────────────┴───────────┐   ┌──────────┴────────────────┐
        │ src/core（纯 Lua，ENU） │   │ src/native（C 探针）       │
        │ 被 adapters 与 tools     │   │ agradar_probe ·            │
        │ 两侧复用，不依赖 DCS     │   │ fc_trace/fc_inject（D4，   │
        │                          │   │ 默认只读）                 │
        └──────────────────────────┘   └───────────────────────────┘
```

要点：`src/core`、`src/sar_core` 两个纯核心只被依赖、不反向依赖；DCS 语义（坐标系、机型名、游戏 API）全部收口在 `src/adapters/dcs`；`tools/` 只做编排、传输与显示，不定义物理。

### 3.3 硬规则

| ID | 规则 | 判定方式 | 当前状态 |
|---|---|---|---|
| R1 | `src/core` 不含 DCS 语义：机型名、`visible`、`Heading + π/2`、`LoGet*`、`land.`、`world.`、`pos.y` 海拔假设 | `audit_repo` 正则 + 人工评审 | **满足（Gate 4）**：核心为 ENU；DCS 语义只在 `src/adapters/dcs/` |
| R2 | `src/core` 不 `require`/不碰 `os`、`io`、`lfs`；时间只认传入 `dt`，随机数只认注入 seed | 静态扫描 | 满足（`init` 只用 `dofile` 加载） |
| R3 | 游戏 API 只在 `src/adapters/dcs/api/`；`compat/probe.lua` 只通过注入的 api 表间接调用，不直接引用全局；其他目录出现即失败 | `audit_repo` | 满足（Gate 3）：`api/` 已建立，Export/Scene/Hooks 经 `AESA_RUNTIME` 调用 |
| R4 | `src/sar_core` 不 import 服务、HTTP、fs、net、viewer、DCS | 静态扫描 | 满足（Gate 5）：`src/sar_core` 只 import 自身/生成配置 |
| R5 | `tools/` 不反向定义物理；只编排、适配、显示 | 评审 + 常量扫描 | 满足（Gate 5）：SAR 物理在 `src/sar_core`，`tools/` 为服务/适配/显示 |
| R6 | viewer 不重算物理：分辨率、地距、相对角、波束宽度只读 snapshot/metadata | 评审 + viewer 常量扫描 | 满足（Gate 5）：viewer 读 snapshot/metadata；可成像性走 `/designate/check` |
| R7 | 参数/协议单源：改一个值只改 `spec/`；生成物 `DO NOT EDIT` + generator/hash | `gen_config --check` | 满足（Gate 6）：`gen_config --check` 10 个生成物零 diff，审计生成物头通过 |
| R8 | 依赖单向：core ← adapters ← export/scene/hooks；sar_core ← sar_service ← viewer | import 图 | 满足：Lua 侧 core 不 import 适配器；tools 经 lua_host 加载适配器 |
| R9 | 原生默认只读；写路径独立、显式、profile 校验 | 代码 + 实机检查 | 满足（Gate 6/7）：trace 为默认导出集无写函数；inject 仅显式安装/配置；实机默认只读 |
| R10 | 生成物有 `DO NOT EDIT`、生成器、输入 hash；旧生成物同 Gate 删除 | `audit_repo` | 满足（Gate 6）：生成头/hash/生成器审计通过 |

补充说明：

- R6 允许 viewer 做**显示坐标变换**（世界 → 屏幕、缩放、平移）和样式计算；禁止的是从原始参数重新推导物理量。SAR 页面的可成像性判定必须走 `GET /designate/check`，不得在页面复刻判据。
- R8 中 `src/export`、`src/scene`、`src/hooks` 可以依赖 `src/core` 的接口和 `src/adapters/dcs`，但不得互相 import 对方的内部实现；共享的协议/采集逻辑下沉到 `src/shared` 或 `src/adapters`。
- 场景桥的 mission 源码在部署时被 `scripts/install_sar_scene.cjs` 内嵌进 hook（`__MISSION_SOURCE__`）。这是 DCS 任务态执行的部署约束，不是运行时依赖；但 hook 与 mission 源码必须成对部署、成对回滚，安装清单中视为一个产品。

### 3.4 执行工具

| 工具 | 职责 | 状态 |
|---|---|---|
| `scripts/test_all.cjs` | 统一跑 Python/Node/原生套件，报告 pass/fail/skip 及 skip 原因 | Gate 0 产出 |
| `scripts/audit_repo.cjs` | 文件名、TODO owner、API 越界、重复常量、旧符号、文档状态、生成物 hash、skip 审计 | Gate 0 产出 |
| `scripts/gen_config.cjs --check` | `spec/` → 生成物零 diff | Gate 2 产出 |
| `scripts/compat_check.cjs` | 记录/对比 DCS build 能力矩阵 | Gate 3 产出 |

审计规则和通过标准见[测试与 Gate 门禁](testing-gates.md)；当前文件的分类见[文件盘点](file-inventory.md)。

---

## 4. 模块与文件责任表

### 4.1 `src/core/`（A/A 核心）与 `src/adapters/dcs/`（A/A 适配）

**归属规则**：物理/调度/航迹/显示 DTO 在 `src/core/`；DCS 坐标、字段名、机型分类、录制格式只在 `src/adapters/dcs/`。`src/aesa/` 已删除，不存在第二份实现。

| 文件 | 现状职责（可验证） |
|---|---|
| `src/shared/config.lua` | 由 `spec/radar.json` + `spec/physics.json` 生成：雷达参数、调度器搜索/回访/PRF 名字选择、跟踪器参数。逐项带来源标记；`core/init.build` 支持注入深拷贝。 |
| `core/init.lua` | `M.build(root, opts)` 用 `dofile` 加载配置校验、生成配置与 11 个核心模块；`constants.configure` 注入物理常量；`aesa.new` 注入 truth/rcs/sink/seed/measurement；不加载任何 DCS 数据，RCS 默认 `passthrough()`。 |
| `core/constants.lua` | 物理常量、dB/角度换算、Park–Miller 可种子 RNG；值由 `configure()` 从生成配置注入，模块内不保存第二份字面量。 |
| `core/physics.lua` | 单驻留雷达方程、Swerling-1、Albersheim、Rmax、发射功率；常量经 `constants` 使用。 |
| `core/beam.lua` | 扫描角 `theta_of`、方向余弦域高斯主瓣门、双程主瓣因子、主瓣杂波径向速度 `v_mlc`。 |
| `core/detection.lua` | 脉冲遮蔽、距离盲区、速度凹口（MLC notch/零多普勒）、`assess` 综合判定。 |
| `core/geometry.lua` | ENU 机体基（heading 从北顺时针）、相对测量、机体测量→世界点、球面视距；不出现 DCS 轴或海拔字段。 |
| `core/scheduler.lua` | 确定性事件调度：搜索光栅、跟踪/STT 任务、PRF 轮换、驻留补偿、扫描锥可行域、事件循环、时间账本、迟到统计；任务排序按稳定 id；`new` 需要 `mods.beam.theta_of`。 |
| `core/tracker.lua` | 世界系航迹：匀速预测、速度自适应最近邻门、速度平滑/加速度限幅、M/N 确认、慢速抑制、coast/删除；`pairs` 遍历改稳定顺序。 |
| `core/measurement.lua` | `MeasurementModel`：`exact()` 恒等；可选 `quantized({range_step_m, az_step_rad, el_step_rad})` 只量化测量量，波束门限仍用真值几何。 |
| `core/rcs.lua` | RCSProvider 接口：`new(values, default_class)` 按 `rcs_class` 兜底；`passthrough()` 只接受目标自带 `rcs_m2`。不含机型名/分类正则。 |
| `core/snapshot.lua` | 稳定显示 DTO：`t/cfg/own/tracks/beam/beam_trail/raster/sched/truth`；航迹含 `east_m/north_m/up_m`、`ve_mps/vn_mps/vu_mps`、`az_deg/el_deg/range_m/vr_mps`；显示层不再读 `sched/trk` 内部表。 |
| `core/core.lua` | `step(dt)` 驱动调度器；`run_dwell` 做几何→视距/地形/距离门→SNR/Pd→伯努利/起伏判定→世界系检测点→航迹；`sync_tasks` 用当前姿态反解航迹 az/el/R/vr；暴露 `snapshot()`；sink 契约见下。 |
| `adapters/dcs/frame.lua` | DCS 世界系 ↔ ENU 唯一转换点：`position/velocity` 交换轴，`attitude` 原样保留 heading/pitch/bank；`legacy_heading` 只修正旧 V1 录制的 `Heading + π/2`。 |
| `adapters/dcs/truth_replay.lua` | 回放型 TruthSource：帧序列按 `now` 插值；`ownship`/`targets` 经 `frame` 转 ENU；目标按 id 对齐，`visible` 跨帧保守传播；`append` 支持实时追加；可选 `opts.rcs.resolve`。 |
| `adapters/dcs/rcs.lua` | DCS 机型分类：官方 `rcs_data.map` 精确匹配，否则按 `LARGE/HELI/MISSILE/fighter` 分档并标 `fallback-estimate`；启动校验四档 fallback 键。 |
| `adapters/dcs/rcs_data.lua` | 生成文件：机型 → RCS 映射 + 四档 fallback；由 `scripts/extract_rcs.py` 生成，勿手改。 |

A/A 输出的两个稳定契约：

```text
sink:on_tracks(tracks_by_id, ordered_tracks)
sink:on_dwell({
  beam        = {t, az, el, theta, td, prf, purpose, task_id, bar},
  truth       = {targets = {{id,label,coalition,pos,vel,blocked}, ...}},
  measurement = {model = "exact"|"quantized", targets = {{id,range_m,az_rel,el_rel,v_close,v_mlc}, ...}},
  detection   = {n, targets = {{id,detected,reason,blocked,snr,pd}, ...}},
})
core:snapshot() -> stable display DTO（ENU）
```

`tools/live.py` 只在 `core:snapshot()` 上补 `wall`、`link`、`compat` 三个传输/会话字段；viewer 不读取 `sched`/`trk` 内部表。

### 4.2 `src/export/`

| 文件 | 现状职责（可验证） | 目标归属 |
|---|---|---|
| `aesa_export.lua` | A/A V1 采样：`V1` greeting 后发送 `PROTO,2`（声明坐标/姿态为原始 DCS 值）与 `COMPAT,<profile>,<matrix_hash>`；A/O/P/T/L/E 行；10 Hz；`O` 行发送原始 DCS Heading/Pitch/Bank（不再 `+π/2`）；T 行阵营取 `CoalitionID`；速度取 `obj.velocity/vel` 或 `LoGetVectorVelocity`（缺失记 `vel_valid=0`）；`terrain.isVisible` 遮蔽；首帧 P 探针；经 `AESA_RUNTIME` 调用 `api/*`；链表包裹 Start/Stop/ActivityNextEvent/AfterNextFrame；E-diag 每 5 s。 | `aa_sampler.lua`（采样）+ `aa_protocol.lua`（行/版本）+ `aa_transport.lua`（socket/重连）+ `adapters/dcs/api/export.lua`；Gate 3 已完成协议/API，文件拆分留待后续 |
| `aesa_sar_export.lua` | SAR Export 入口（Gate 5）：从 `AESA_SAR` 取装配件，握手/回调安装由 `sar_transport` 完成；不直接调用游戏 API。 | 已落地 |
| `sar_protocol.lua` | 线协议常量与词表（纯 Lua）：端口、VERSION/CAPS、footprint 白名单 `allowed()`、MAP 栅格参数、地表/provider token、行字段解析。 | 已落地 |
| `sar_dcs_env.lua` | Export 侧能力探测与 `terrain.*` 查询；向采样器提供 `env` 回调。 | 已落地 |
| `sar_collector.lua` | `HELLO,SAR1`/`CAPS`/`STATUS`；`CAPTURE*`/`SURFACE_FINE`；BEGIN/TARGET/HEIGHT/SURFACE/POSE/END；MAPBEGIN/MAPHEIGHT/MAPSURFACE/MAPPOSE/MAPEND；每帧一行（`P.N` 单元）。 | 已落地 |
| `sar_transport.lua` | TCP 生命周期、HELLO/COMPAT/CAPS、每帧命令读取、缓冲与部分写恢复、重连节奏。 | 已落地 |

### 4.3 `src/scene/`

| 文件 | 现状职责（可验证） | 目标归属 |
|---|---|---|
| `aesa_sar_mission.lua` | 任务态入口（Gate 5）：绑定 `mission_env` 与 `scene_core`，把协议里的 footprint 白名单交给核心校验，发布 `AESA_SAR_SCENE`。 | 已落地 |
| `sar_mission_env.lua` | DCS 任务 API 适配：`world.searchObjects`、`land.getSurfaceType`、`timer.getTime`、`net.dostring_in` 能力探测；缺失能力报 `unavailable`。 | 已落地 |
| `sar_scene_core.lua` | 场景/GMTI 序列：`probe()` → `CAP,...`；`start/step` 每帧一行 `SURFACE`；BOX 查 SCENERY/STATIC/UNIT（最多 128 对象/512 访问）输出 `OBJECT`；`mover`/`mover_step` 50 km 内地面动目标（g/s ≥1 m/s，最多 64/128 访问/0.1 s）输出 `MOVER`/`MOVER_END`。 | 已落地 |

### 4.4 `src/hooks/`

| 文件 | 现状职责（可验证） | 目标归属 |
|---|---|---|
| `aesa_agradar_hook.lua` | 经 `AESA_RUNTIME`（`runtime.hook`/`runtime.native`/`runtime.profile`）从 `Saved Games\Scripts\AESA-AGR\aesa_agradar.dll` 加载 init/poll/shutdown/version/surface_names/surface_mask；每帧 `poll`；`onSimulationStop` `shutdown`；只读，无引擎 hook；日志 `Logs\AESA\AGR`。 | 保留生命周期薄壳；不直接调用游戏全局；Gate 3 已完成 |
| `aesa_fc_hook.lua` | 经 `AESA_RUNTIME` 默认从 `Scripts\AESA-FC\aesa_fc_trace.dll` 加载 trace 导出（init/poll/shutdown/version/trace_start/trace_stop/readable）；仅当 `fc_experiment.lua` 显式 `mode=1` 且 profile `NAT-FC-SYM=ok`/`native.fc.write=true`/inject DLL 与写导出齐全时改加载 `aesa_fc_inject.dll`（额外 arm/disarm/feed_target）。读取 bandit 名、deadline/retry；`runtime.hook:dostring` 解析 ObjectID、注入任务态 MSL 记录器、拉取日志、喂目标位置；`onSimulationStop` 先 disarm 再 trace_stop/shutdown。 | 生命周期/桥接薄壳；Gate 6 已完成 trace/inject 双构建加载策略 |
| `aesa_sar_scene_hook.lua` | **生成文件**：`__MISSION_SOURCE__` 被安装器替换为 `aesa_sar_mission.lua` 全文；TCP 3594；`HELLO,SARSCENE1`；经 `runtime.hook:dostring` 按 `a_do_script`、`scripting`、`mission`+`a_do_script`、plain mission 顺序探测执行通道；转发 SCENE/MOVER/CANCEL/MOVER_CANCEL；每 5 s 重报 CAP；`mover_step` 每次最多 16 行；`DCS.setUserCallbacks` 经 `runtime.hook`。 | 生命周期/socket 薄壳；执行通道/能力探测已进 `api/hook.lua`、`compat/probe.lua`；Gate 3 已完成 |

### 4.5 `src/native/`

| 文件 | 现状职责（可验证） | 目标归属 |
|---|---|---|
| `agradar_probe/aesa_agradar.c` | AGR 原生探针（只读）：解析 `GetDefaultTerrain()`/`getPointOnSurface`/`get_surface_type_name(s)`（含 `Inter.dll` 符号），把引擎 64 位地表 mask 解码成 16 类名称；导出 `aesa_agradar_init/poll/shutdown/version/surface_names/surface_mask` 与 `aesa_agradar_profile_check`；无 `luaopen_*`，由 `package.loadlib` 逐符号取；日志 `Logs\AESA\AGR`；懒解析、只读。 | 原位保留；Gate 6 已完成 profile/version 自检 |
| `fc_probe/aesa_fc.c` | 火控原生探针：MinHook detour 火控/导弹/目标相关引擎函数。同一 C 源两个构建：`AESA_FC_TRACE_ONLY` 的 trace（只导出 init/poll/shutdown/version/trace_start/trace_stop/readable）与默认 inject（trace 超集 + arm/disarm/feed_target）。 | 原位保留；Gate 6 已完成 D4 拆分与导出表守卫 |
| `third_party/minhook/` | 原样引入的 MinHook：`LICENSE.txt`、`include/MinHook.h`、`src/{buffer,hook,trampoline}.c`、`src/hde/{hde32,hde64}.c` 及头文件。 | 保留 + LICENSE；不改造、不计入本项目代码风格；Gate 6 只做构建统一 |

### 4.6 `tools/` SAR 适配与服务（Gate 5）

| 文件 | 职责 |
|---|---|
| `sar_service/` | SAR 服务模块（表见 §4.12）：采集解析、可成像性、MAP/DBS、扫掠、覆盖、拼接、HTTP/录制。 |
| `sar_bridge.cjs` | 场景桥客户端：TCP 3594、`HELLO,SARSCENE1` 能力、`SCENE`/`MOVER` 请求、超时与上限、能力/原因回传。 |
| `sar_demo_scene.cjs` | 确定性合成场景（`--demo` 与测试输入），网格取自 `spec/sar.json` 的 detail footprint。 |
| `sar_live.cjs` | CLI 组合根：参数解析、`service.start()`/`close()`、退出码（63 行）。 |
| `sar_viewer.html` | SAR 页面（见 §4.7）。 |

原 `tools/sar_{scene,engine,surface,pfa,pulses,scattering,processing,map,pool,worker}.cjs` 已在 Gate 5 删除：物理进 `src/sar_core/`，DCS footprint/地表词表/场景校验进 `src/adapters/dcs/sar_adapter.cjs`，其余编排进 `tools/sar_service/`。

### 4.7 `tools/` Python 与显示资产

| 文件 | 现状职责（可验证） | 目标归属 |
|---|---|---|
| `lua_host.py` | Lua 宿主：创建 Lua 5.1 运行时，按 `src/core/*.lua`、`src/adapters/dcs/*.lua`、`src/shared/*.lua` 路径加载模块；生产工具只通过本模块触碰 Lua。 |
| `protocol.py` | A/A V1 行协议纯解析：`V1`/`PROTO,2`/`COMPAT`/`P`/`A`/`O`/`T`/`L`/`E`，按 `A` 行分帧；不做文件/网络 IO。 |
| `ingest.py` | 录制文件 → 会话/帧；`VelocityPatcher`、会话切分、兼容握手摘要。 |
| `truth.py` | Python 采集帧 → Lua 适配器输入（原始 DCS 轴）；`legacy_for(proto)` 决定旧 V1 航向是否修正；转换本身在 `frame.lua`。 |
| `live.py` | 薄 CLI：TCP 3590 收帧、时间归一、追加 `truth_replay`、按 ≤1 s 分片 `core:step`、HTTP 3591 + SSE `/stream`；快照直接取 `core:snapshot()` 并补 `wall`/`link`/`compat`。 |
| `receiver.py` | 薄 CLI：`protocol.py` 解析 + `ingest.py` 录制/回放加载 + TCP 3590 摘要。 |
| `replay.py` | 薄回放 CLI：录制 → `truth.py`/`truth_replay` → `src/core` → 确认航迹 + E 行对照报告；不再 `import tests/`。 |
| `integration_check.py` | 加载**已部署**的 `aesa_export.lua`，用 lupa + Lo* 桩 + 前置回调链，对 127.0.0.1:3590 真实接收器做连通/采样自检；仍硬编码本机 Saved Games 路径（Gate 6 参数化）。 |
| `fc_trace_report.py` | 解析 `Logs/AESA/fc_trace.log`，按 hook tag 统计，重建 TRACK/SET_TARGET/ASSIGN 序列，汇总 datalink 消息和 MSL 记录。 |
| `viewer/index.html` | A/A 页面：EventSource `/stream`，绘制波束/波束轨迹/航迹/真值/速度线/预测线；只消费 ENU snapshot DTO（`east_m/north_m/ve_mps/vn_mps` 等），不再有 `rel_geo` 或机体投影副本。 |
| `sar_viewer.html` | SAR 页面：700 ms 轮询 `/state` 摘要（含 `resultSeq`/`db_ref`/`imageWindow`），在 `completed` 变化时按 seq 取 `/image/<seq>`，`/snapshot` 备份，`/scene` 原始输入，`/designate/check` 判可成像性，POST 捕获/MAP/DBS/重算/连续；绘制 mosaic、扇形、DBS/SAR 精看、mover。页面不重算物理、方位向分辨率或光速（Gate 5/D3 已删除这些副本）。 |

### 4.8 `scripts/`

| 文件 | 现状职责（可验证） | 目标归属 |
|---|---|---|
| `install_sar.cjs` | SAR Export 安装器：写 `Scripts/Export.lua` 标记块（`AESA SAR BEGIN/END`）、`Scripts/AESA-SAR/aesa_sar_export.lua`、`manifest.json`；`span` 校验标记唯一性；`owned` 防覆盖；`.bak-aesa` 备份；事务回滚；Lua 5.1 `loadfile` 语法检查；action `install/repair/uninstall/verify/status`；复用 `install_common`。 | 保留；Gate 6 已迁移 |
| `install_sar_scene.cjs` | 可选场景 Hook 安装器：把 `src/scene/aesa_sar_mission.lua` 全文嵌入 `aesa_sar_scene_hook.lua` 的 `__MISSION_SOURCE__`，编译生成的 bundle；写 `Scripts/Hooks/aesa_sar_scene_hook.lua` + `scene-manifest.json`；复用 `install_common`。 | 保留；Gate 6 已迁移 |
| `install_agradar_probe.cjs` | AGR Hook + DLL 安装器：`Scripts/Hooks/aesa_agradar_hook.lua`、`Scripts/AESA-AGR/aesa_agradar.dll`、manifest；`.bak-aesa`、status/verify/uninstall；复用 `install_common`。 | 保留；Gate 6 已迁移 |
| `install_fc_probe.cjs` | 火控 Hook + trace DLL 安装器：`Scripts/Hooks/aesa_fc_hook.lua`、`Scripts/AESA-FC/aesa_fc_trace.dll`、manifest；`--with-inject` 才装 `aesa_fc_inject.dll`；旧 `aesa_fc.dll` 按旧 hash 备份后迁移；`.bak-aesa`。 | 保留；Gate 6 已完成 |
| `install_export.py` | A/A Export 安装器（Python）：`Scripts/Export.lua` 标记块、`Scripts/AESA/aesa_export.lua`、manifest；hash/backup/transaction/legacy hash 迁移；DCS 运行检查；action `install/repair/uninstall/verify/status`。 | 保留 Python 实现；与 `install_common` 同语义；Gate 6 已加检查 |
| `extract_rcs.py` | 从 DCS 明文资产提取 `RCS =` 字段，生成 `src/adapters/dcs/rcs_data.lua`；跳过 Sounds/Tracks/terrain/MissionEditor 等；输出四档 fallback（`fighter/large/helicopter/missile`，Gate 1 已修）；生成头/schema 测试已有，hash 待补。 | 保留；Gate 6 补 `DO NOT EDIT`/hash |
| `build_agradar_probe.cjs` | 用工作区 `.tools/mingw-root` 的 gcc 构建 `dist/dev/aesa_agradar.dll`；`AESA_GCC` 可覆盖；复用 `build_common`。 | 保留；Gate 6 已统一 |
| `build_fc_probe.cjs` | 同一 C 源构建 `dist/dev/aesa_fc_trace.dll`（`AESA_FC_TRACE_ONLY`）与 `dist/dev/aesa_fc_inject.dll`；PE 导出/依赖守卫。 | 保留；Gate 6 已拆分 |
| `build_common.cjs` | gcc 定位/PATH 合并/PE 导出与依赖检查/Lua 5.1 检查。 | Gate 6 新建 |
| `install_common.cjs` | hash/backup(`.bak-aesa`)/transaction/atomic write/Lua 5.1 检查/DCS 运行检查/manifest 校验。 | Gate 6 新建 |
| `make_fc_trace_mission.py` | 从已知良好模板 miz 生成 FC trace 任务（追加 E-3A/2×MiG-29A，改玩家航线），不启动 DCS；`--install` 可写入 Saved Games。 | 保留为开发夹具生成器；Gate 6 归档或参数化路径/清单 |
| `sar_principle_probe.cjs` | 独立离线 SAR 可行性实验：自带 `C`、λ/BW/speed/duration 等默认值，理想矩形带 + 反投影。 | 改为 import `src/sar_core` + `spec/`；或标 historical；Gate 5 |
| `sar_pfa_probe.cjs` | PFA vs 反投影点响应/图像对照；可读录制；合成一次、两种聚焦。 | 消费 `src/sar_core`；Gate 5 |
| `sar_precision_probe.cjs` | 对同一场景跑 standard/fine/fast，输出分辨率/点质量对照。 | 消费 `src/sar_core` + 生成配置；Gate 5 |
| `sar_quality_probe.cjs` | 点响应指标：峰值/主瓣 FWHM/位置误差等；被 precision/airport probe 复用。 | 消费 `src/sar_core`；Gate 5 |
| `sar_airport_probe.cjs` | 已知合成机场场景（跑道/建筑），验证 area/airport footprint 成像。 | 场景夹具移到 `tests/fixtures`，成像走 `src/sar_core`；Gate 5 |
| `test_all.cjs` / `audit_repo.cjs` | Gate 0 已落地的统一测试/审计入口（与本文并行产出）。 | Gate 0 |
| `capture_baseline.cjs` | Gate 0 已落地的基线采集入口：回放、SAR、协议、`/state` 摘要与哈希，见[测试与 Gate 门禁](testing-gates.md)。 | Gate 0 |
| `gen_config.cjs` / `compat_check.cjs` / `install_common.cjs` | Gate 2/3/6 新增的生成器、兼容检查、部署公共层。 | Gate 2/3/6 |

当前脚本的状态（Gate 6 已处理）：

- 备份后缀统一为 `.bak-aesa`（`install_common.BACKUP_SUFFIX`）；旧 `.bak-aesa-sar`/`.bak-aesa-agr` 仅作为用户数据保留，不再新写。
- JS 与 Python 安装器仍各自实现 manifest/marker，但共用同一语义：原子写、事务回滚、Lua 5.1 检查、DCS 运行检查、`.bak-aesa`；`install_export.py` 的 legacy hash 迁移保留在 Python 侧。
- 所有安装器在 install/repair/uninstall 前检查 `DCS*.exe`；verify/status 只读放行。FC 默认 trace，inject 需 `--with-inject` 且运行时仍需 `mode=1`。

### 4.9 `tests/`

| 文件 | 职责 | 目标 |
|---|---|---|
| `helpers.lua` | 恒速真值源、静态 RCS、收集 sink（`on_tracks`/`on_dwell`）；与核心适配器契约一致。 | 保留；契约已改 ENU（D1） |
| `run_tests.py` | Python + lupa 核心单测：T1–T10 物理/调度/航迹 + 端到端冒烟；Gate 4 后使用 ENU 向量。 | 保留 |
| `test_review_regressions.py` | 38 项回归：T1–T6 物理、T7/T9/T10 调度、部署/协议/解析集成安全。 | 保留；新增回归随 Gate 1 |
| `test_gate4_boundary.py` | Gate 4 边界回归：`frame.lua` DCS↔ENU 往返、legacy V1 航向、`truth_replay` 轴转换、核心无 DCS 语义。 | 保留 |
| `test_gate4_snapshot.py` | Gate 4 契约回归：`snapshot` 稳定 DTO、`on_dwell` 四段结构、`MeasurementModel` exact/quantized、确定性。 | 保留 |
| `test_agradar_probe_dll.py` | ctypes 加载 AGR DLL 的 smoke/robustness；需要 DCS bin/构建产物。 | 保留；Gate 6 加 profile 自检 |
| `test_fc_probe_dll.py` | ctypes 加载 FC DLL 的 smoke；需要 DCS bin/构建产物。 | 拆 trace/inject 后分别测试；Gate 6 |
| `test_install_sar.cjs` | SAR Export 安装器生命周期：标记、备份、manifest、事务、拒绝未知文件。 | 改为 `install_common` 契约；Gate 6 |
| `test_install_sar_scene.cjs` | 场景 Hook bundle/安装/卸载；生成的 hook 可编译。 | 保留；Gate 6 |
| `test_sar_live.cjs` | SAR 服务集成：TCP 采集、HTTP、连续、指定、DBS、mover、状态机（31 个 test）。 | 拆到 `sar_service` 单测 + 服务集成；Gate 5 |
| `test_sar_map.cjs` | MAP 协议/栅格/覆盖/DSM/帧渲染（31 个 test）。 | 拆 map 核心/服务；Gate 5 |
| `test_sar_mosaic.cjs` | 拼接层保留/淘汰/增量/量化/404。 | 服务/mosaic_store；Gate 5 |
| `test_sar_movers.cjs` | GMTI 桥/多普勒盲区/降级。 | 服务/movers；Gate 5 |
| `test_sar_sweep.cjs` | 扫掠计划/覆盖/退避/预测位姿。 | sweep_planner；Gate 5 |
| `test_sar_pfa.cjs` | FFT/PFA 网格/点响应。 | `sar_core/pfa`；Gate 5 |
| `test_sar_pool.cjs` | 并行/串行逐位一致、阈值、分块。 | `sar_core/pool`；Gate 5 |
| `test_sar_principle.cjs` | 离线 SAR 原理/几何/点响应。 | `sar_core`；Gate 5 |
| `test_sar_pulses.cjs` | 脉冲预算/上限/range bins。 | `sar_core/memory`；Gate 5 |
| `test_sar_scattering.cjs` | 材质/散射/对象/遮挡。 | `sar_core/{materials,scatterers}`；Gate 5 |
| `test_sar_scene.cjs` | 场景校验/示例/像素/孔径。 | `sar_core/geometry` + adapter；Gate 5 |
| `test_sar_surface.cjs` | 面元引擎/聚焦/窗/插值/质量。 | `sar_core/{engine,focus}`；Gate 5 |
| `test_sar_export.lua` | 用注入 `send`/`env` 驱动 SAR 采集器，验证协议/状态机/地形/地距。 | 拆分后测 `sar_collector`；Gate 5 |
| `test_sar_mission.lua` | 桩 `land`/`world`/`Object` 驱动任务采样器，验证 17 行/帧、对象/动目标。 | 测 `sar_scene_core`；Gate 5 |
| `test_sar_scene_hook.lua` | 对**生成的部署文件**跑 socket/命令/任务源嵌入。 | 保留；Gate 6 随安装器 |
| `test_sar_viewer.cjs` | 在 vm + 假 DOM 中执行 `sar_viewer.html`，53 个页面行为/协议/绘制 test。 | 删除物理副本断言，改 metadata 契约；Gate 5 |
| `test_viewer_vectors.cjs` | A/A 页面速度线/预测线/显示几何回归。 | 保留显示测试；物理量改由 snapshot 提供；Gate 4 |
| `tests/baseline/`（目标） | 回放摘要、SAR 指标、协议计数、`/state` 大小；只存 JSON/哈希。 | Gate 0 新增 |
| `tests/fixtures/`（目标） | 生成配置、固定场景、Lua/JS 交叉向量。 | Gate 2 起 |

### 4.10 `docs/`

| 文件 | 职责 | 目标处置 |
|---|---|---|
| `architecture.md` | 本文件：边界、依赖、文件地图、ADR、单一事实源、数据流、债务 | current；结构变化同 Gate 更新 |
| `refactor-plan.md` | 本轮重构的目标、Gate、验证、清理、回滚 | draft（执行计划）；Gate 完成后按实际状态更新 |
| `conventions.md` | 坐标/角度/时间/单位/栅格/dB/协议版本约定 | current；Gate 0 新增（并行产出） |
| `dcs-compat.md` | DCS 版本耦合面、profile、探针、更新流程 | current；Gate 0 新增（并行产出） |
| `testing-gates.md` | Gate 定义、测试矩阵、阈值、三色判定、skip 规则 | current；Gate 0 新增（并行产出） |
| `file-inventory.md` | 现役/生成/历史/外部参考/实验/删除候选分类 | current；Gate 0 新增（并行产出） |
| `feasibility.md` | DCS 雷达分层、社区模组边界、硬边界 | current 背景；DCS 更新时复核 |
| `theory-notes.md` | 雷达/检测/跟踪理论；T1–T10 与测试对应 | current 理论依据 |
| `design-phase1.md` | 核心设计、TruthSource/RCSProvider/OutputSink 契约 | historical（模块已迁至 `src/core/`；契约现状见本文附录 A） |
| `design-phase2.md` | A/A Export V1 协议、录制、部署 | historical（协议已增加 `PROTO,2`/`COMPAT`；现状见本文 §8.1 与 `dcs-compat.md`） |
| `design-phase3a.md` | 外部显示器/实时链路 | historical（显示 DTO 已由 `core/snapshot.lua` 提供） |
| `design-sar-prototype.md` | SAR 原型设计/假设 | Gate 6 标 historical 或重写 |
| `design-sar-airport.md` | 机场概览/大切片设计 | current 设计；Gate 5 随核心迁移 |
| `design-fc-injection.md` | 火控注入设计与实验结论 | Gate 6 标 historical 或重写；D4 后拆分 |
| `sar-feasibility.md` | SAR 物理、PFA 边界、分辨率/几何限制 | current 理论依据 |
| `sar-in-mission.md` | SAR 各模式（精看/扫掠/MAP/DBS/GMTI）操作与边界 | current 使用说明；Gate 5 更新端点/字段 |
| `sar-surface-quality.md` | 表面模型、窗/插值、质量对照 | current 验证记录；Gate 5 复核 |
| `sar-airport-validation.md` | 机场场景验证记录 | current 验证记录；Gate 5 复核 |
| `dcs-map-terrain-interfaces.md` | DCS 地图/地形接口区别与边界 | current 参考；Gate 3 并入 dcs-compat |
| `viewer-vectors.md` | A/A 显示速度线/预测线定义 | current 显示说明 |
| `review-fixes.md` | 2026-09-30 审查修复记录 | historical 记录；不复制代码 |
| `status.md` | 项目状态快照（2026-09-30/10-01） | historical 快照（已在文件中标注）；不再维护 |
| `coverage-agmti.html`、`coverage-topview.html` | 覆盖预测的可视化产物 | 生成物/删除候选（Gate 7，见[文件盘点](file-inventory.md)） |
| `research/`（7 篇） | `agradar-probe-phase1.md`、`dcs-mod-radar-survey.md`、`edterrain4-landscape-map.md`、`enlight-agradar-map.md`、`fire-control-aim120-injection.md`、`fire-control-paths.md`、`sar-real-world-usage.md`：AGR 探针、DCS mod 雷达、EDTerrain4、Enlight AGRadar、AIM-120 注入、火控路径、SAR 真实使用调研 | external-reference；只读，不参与构建 |

文档状态约定（`current`/`historical`/`external-reference`/`draft`）与死链检查见[测试与 Gate 门禁](testing-gates.md)；每篇文档的最终分类见[文件盘点](file-inventory.md)。

### 4.11 `spec/` 与生成物（目标）

| 来源 | 内容 | 生成物 | 主要消费者 |
|---|---|---|---|
| `spec/physics.json` | 光速、玻尔兹曼、参考温度、dB 定义 | `src/shared/config.lua`、JS 配置、`src/native/generated/config.h` | core/physics、sar_core/waveform、native |
| `spec/radar.json` | λ、功率、增益、噪声、损耗、Pfa、波束、驻留、扫描锥、PRF（按名字）、回访、关联门 | `src/shared/config.lua` | core/{beam,detection,scheduler,tracker,physics} |
| `spec/sar.json` | footprint、带宽、输出宽度、脉冲/内存预算、PFA、散射材质、DBS 系数 | JS/Lua 配置 | sar_core、sar_service、export 校验 |
| `spec/protocol.json` | 3590/3591/3592/3593/3594、greeting、版本、行 schema、上限、超时、配额 | Lua/JS/Python/C 生成物 | export、sar_service、python tools、native |
| `spec/deployment.json` | Saved Games 路径、Scripts 子目录、DLL 名、日志目录、备份后缀 | Lua/JS | 安装器、hooks、compat |
| `spec/display.json` | dB 量化/参考、mosaic、轮询、量程、颜色 | JS/Lua | sar_service、viewer |
| `spec/dcs_profiles/dcs-<build>.json` | build/module 字段、能力、符号、偏移、数据源 | `src/adapters/dcs/compat/profiles/*.lua`、`src/native/abi/dcs_profile.h` | adapters/compat、native、compat_check |

生成规则：

- 每个生成物首行 `DO NOT EDIT`，并带 generator 名、输入文件列表、输入 hash、生成时间或版本；`gen_config --check` 必须零 diff。
- 测试不得保留第二份规范；测试从生成物导入常量，跨语言几何用固定向量。
- 生成物和 `spec/` 在同一 Gate 内替换旧常量；旧键、旧默认、旧 fixture 同步删除。

### 4.12 `tools/sar_service/`（Gate 5 已落地）

| 模块 | 职责 | 明确不负责 |
|---|---|---|
| `collector.cjs` | TCP 行解析、SAR/MAP 作业状态、协议校验 | 物理、HTTP、页面 |
| `arbiter.cjs` | 可成像性判定（1–50 km、20–160° 侧视窗）、采集权仲裁 | 成像 |
| `map_session.cjs` | MAP 扇区/滚动窗口/格网会话 | 渲染物理 |
| `dbs_session.cjs` | DBS 一次性小块/复用格网 | 锐化数学 |
| `sweep_planner.cjs` | 固定世界瓦片、预测位姿、覆盖/退避 | 成像 |
| `coverage_index.cjs` | 覆盖判据/瓦片索引 | 图像存储 |
| `mosaic_store.cjs` | seq/generation、保留/淘汰、Int8 量化与 `db_ref` | 页面绘制 |
| `recorder.cjs` | 场景/结果落盘、路径/命名 | 协议 |
| `http_api.cjs` | 路由、鉴权/Host/Origin、`/state`、`/image/<seq>`、`/reference`、`/snapshot`、POST | 物理 |
| `service.cjs` | 组装上述模块、SAR 采集会话、生命周期、端口 | 物理 |

`tools/sar_live.cjs` 只保留 CLI、参数解析、`service.start()`/`close()` 与退出码（当前 63 行）。

---

## 5. 架构决策记录（ADR）

四项决策均在 Gate 0（2026-10-17）确认采用**计划推荐 A 方案**。ADR 一旦接受，后续 Gate 不反复；需要变更时新增 ADR 并说明取代关系。

### ADR-001：D1 帧模型采用通用 ENU

- **状态**：Accepted（Gate 0，2026-10-17）
- **决策**：D1 选择 **A**。
- **问题**：Gate 0 时核心名为“无 DCS 依赖”，实际把 DCS 世界系写进了物理接口（以下路径为历史证据，`src/aesa/` 已在 Gate 4 删除）：
  - `src/aesa/physics.lua:115-129`（现 `src/core/geometry.lua`）的 `body_basis` 规定 `heading=0` 朝 `-Z`；
  - `src/aesa/physics.lua:108-110`（现 `src/core/geometry.lua`）的视距计算把 `pos.y` 当海拔、`x/z` 当水平面；
  - `src/aesa/physics.lua:131-134`（现 `src/core/geometry.lua`）的注释直接写明“本体系波束”“DCS 的局部平面”；
  - `src/export/aesa_export.lua:77-79` 在采样侧做 `Heading + π/2`（Gate 4 已改为发送原始 DCS 姿态）。
  结果是：核心只能接 DCS 真值；任何合成/非 DCS 真值源都要伪造 DCS 语义；测试向量与游戏绑定。
- **选择**：核心使用通用 ENU 右手系（x 东、y 北、z 上），航向从北顺时针、俯仰上仰为正、滚转右翼下沉为正；DCS 的 `x/y/z`、`Heading`、MSL 高度只在 `src/adapters/dcs/frame.lua` 转换一次。
  - DCS → ENU：`east = z_DCS`、`north = x_DCS`、`up = y_DCS`；
  - 航向：ENU 前向 `(sin ψ, cos ψ, 0)`，ψ 为从北顺时针；DCS `Heading` 在适配器内转换，核心不再出现 `+π/2`；
  - 位置/速度/姿态在进入核心前完成转换；核心内部、跟踪档案、snapshot 全部为 ENU。
- **理由**：
  1. 核心可接任意 TruthSource（录制、合成、未来其他游戏/真值源），符合“原理与游戏分离”。
  2. 坐标语义只在一个文件出现，测试可用明确的东/北/上向量，回归失败时能定位是物理还是转换。
  3. viewer/服务只消费 ENU 世界坐标，不再各自解释 DCS 轴。
  4. 与 D2 的“核心纯化”一致：物理模块不携带游戏知识。
- **影响**：
  - `physics.geometry`/`world_point`/`horizon_visible` 的输入输出改为 ENU；`body_basis` 从“DCS 航向”改为通用姿态基。
  - `truth_replay` 移到 `adapters/dcs/` 并在加载时转换；录制文件仍是 DCS 原始字段（归档格式不变）。
  - `tracker` 的世界系档案、`core:snapshot()`、`live.py` 的显示映射、A/A viewer 的世界绘制全部改为 ENU。
  - 需要固定向量测试：DCS↔ENU 往返、航向 0/90/180/270、俯仰/滚转符号、视距/波束门限。
  - 文档 `conventions.md` 是坐标/角度签名的唯一说明；本 ADR 只记录决策。
- **迁移方向**（Gate 4，**已完成**）：
  1. 新建 `src/adapters/dcs/frame.lua`，先写转换与往返测试；
  2. 核心测试改用 ENU 向量，保留一组 DCS 转换向量作为契约；
  3. `physics.lua` 拆分时删除 DCS 注释、`pos.y` 海拔假设、`heading=0 → -Z`；
  4. `truth_replay.lua` 移动到 adapters，核心只留接口；
  5. `live.py`/viewer 删除 `rel_geo` 与机体投影副本，改用 snapshot。
- **结果（Gate 4，2026-10-18）**：`src/core/` 与 `src/adapters/dcs/{frame,truth_replay,rcs,rcs_data}.lua` 已落地；`src/aesa/` 已删除；`tests/test_gate4_boundary.py` 覆盖往返与 legacy 航向；flight3/flight9 回放与基线一致。
- **被否决方案**：
  - **B：核心明确为 DCS-local，冻结接口**。改动小，但放弃“核心可接非 DCS 真值源”，并把游戏坐标语义永久写进物理层；与目标 1 冲突。若选 B，Gate 4 的帧迁移范围缩小，但 D2/D3 仍要做；本轮不选。
  - **折中：核心内部同时保留两套帧**。会产生双真值/双测试，任何几何 bug 都要判断是哪套帧，维护成本高于一次迁移；不选。

### ADR-002：D2 SAR 核心归属 `src/sar_core/`

- **状态**：Accepted（Gate 0，2026-10-17）
- **决策**：D2 选择 **A**。
- **问题**：SAR 物理目前全部在 `tools/`：
  - `sar_engine.cjs` 同时做场景校验、回波合成、反投影，并内置 λ/BW 旧路径；
  - `sar_surface.cjs` 做面元/聚焦，`sar_pfa.cjs` 做 PFA，`sar_pulses.cjs` 做预算，`sar_scattering.cjs` 做材质/遮挡，`sar_map.cjs` 做 MAP/DSM/DBS；
  - `sar_live.cjs` 直接 require 这些模块并把物理、协议、HTTP、会话混在一起；
  - 物理模块还认识 DCS 的 footprint、16 类地表词、对象 kind、`radar.fx` 常量。
  结果：物理无法脱离服务测试；服务无法替换物理；同一参数在多个模块各有一份。
- **选择**：SAR 物理进 `src/sar_core/` 纯 JS（无 DCS API/坐标/机型语义、无 HTTP、无文件系统；`radar.fx` 的算法出处只作为注释），`tools/` 只做适配/服务/显示。
  - `geometry.cjs`、`waveform.cjs`、`scatterers.cjs`、`materials.cjs`、`engine.cjs`、`focus.cjs`、`pfa.cjs`、`map.cjs`、`memory.cjs`、`pool.cjs`；
  - DCS footprint/地表词/对象 kind/采集质量约束进 `src/adapters/dcs/sar_adapter.cjs`；DBS 的 shader 出处注释留在 `map.cjs`，adapter 不再导出未消费的 shader 常量；
  - 服务在 `tools/sar_service/`，只编排核心。
- **理由**：
  1. 核心可用固定场景/点目标单测，不需要 TCP/HTTP/Export；
  2. 服务可替换核心（对照算法、性能档），核心可替换服务（离线探针、脚本）；
  3. 物理常量与算法只有一个所有者，消除 `sar_surface`/`sar_engine`/`sar_map` 的默认值副本；
  4. DCS 地表词汇和对象模型被隔离，核心不因游戏新增类名而改。
- **影响**：
  - `tools/sar_*.cjs` 的公开 API 会变；`scripts/sar_*_probe.cjs` 必须改为 import `src/sar_core`。
  - `src/adapters/dcs/sar_adapter.cjs` 是新边界：footprint（detail/area/airport）、16 类地表词、对象 kind、质量/带宽/宽度约束、DBS 8:1/32:1 与 λ/resolution 约定。
  - `tools/sar_service/` 的 session 只持有场景/结果，不持有物理公式。
  - 图像等价验收：SAR 图像与基线逐像素 0 或 ≤1 LSB；PFA/点响应在容差内。
  - 测试拆分：核心单测（无服务）+ 服务单测（假 adapter）+ 集成/视觉。
- **迁移方向**（Gate 5）：
  1. 先建 `src/sar_core` 与固定向量测试，逐模块搬物理，保持数值等价；
  2. 建 `src/adapters/dcs/sar_adapter.cjs`，把 footprint/词表/对象/质量约束从核心与 `sar_scene` 移出；
  3. 建 `tools/sar_service/*`，把 `sar_live.cjs` 的 Collector/Arbiter/Sessions/Sweep/Coverage/Mosaic/Recorder/HttpApi 拆出；
  4. `sar_live.cjs` 只留 CLI/组合根，目标 <300 行；
  5. `scripts/sar_*_probe.cjs` 改为消费核心；删除旧物理副本。
- **结果（Gate 5，2026-10-18）**：`src/sar_core/` 已建立（`engine/focus/pfa/waveform/memory/scatterers/materials/map/settings/pool/worker/geometry`），`src/adapters/dcs/sar_adapter.cjs` 收口 DCS 词汇，`tools/sar_service/` 落地，`tools/sar_live.cjs` 降至 63 行；旧 `tools/sar_{scene,engine,surface,pfa,pulses,scattering,processing,map,pool,worker}.cjs` 已删除；`scripts/sar_*_probe.cjs` 改吃核心。SAR 图像基线（detail/area）由 `tests/baseline/sar-*.json` 锁定。
- **被否决方案**：
  - **B：承认 `tools/sar_*` 是独立产品/第二个 bounded context**。改动小，但物理仍与服务耦合，测试仍要起服务/伪造 DCS 场景；参数仍多源；与“一个概念一个所有者”冲突。若 SAR 不再长期维护可选 B 并删除迁移，但当前 SAR 是主线演示，不选。

### ADR-003：D3 `/state` 只回摘要 + `resultSeq`

- **状态**：Accepted（Gate 0，2026-10-17）
- **决策**：D3 选择 **A**。
- **问题**：当前 `sar_live.cjs` 的 `/state` 除摘要外还携带 `reference`（整幅 DEM 高度、地表、对象）、`mosaic.entries` 摘要、`movers`、`map`/`dbs` 状态等；图像矩阵走 `/mosaic/<seq>`，快照走 `/snapshot`。页面每 700 ms 轮询 `/state`，并在 `completed` 变化时取图。问题不是“有没有分离”，而是**契约没有冻结**：`/state` 可继续膨胀，端点命名把 mosaic 与 MAP/DBS 产物混在一起，viewer 仍可读到完整场景输入。
- **选择**：`/state` 只回摘要 + `resultSeq`；图像走 `/image/<seq>` 或 `/snapshot`；viewer 在 `completed`/`resultSeq` 变化时拉图。
  - `/state` 允许字段：连接/阶段/能力、continuous、map/dbs 摘要、mosaic 摘要（计数/seq 范围/量化步长）、ownship、movers、compat、`resultSeq`、错误/备注；
  - 禁止字段：矩阵、整幅 DEM/地表/对象、完整 `result`、页面绘制所需的大数组；
  - `/image/<seq>`：按 seq 取量化矩阵 + metadata；淘汰后 404；
  - `/snapshot`：完整结果 + 输入场景（备份/重算/回放），不作为轮询接口。
- **理由**：
  1. 轮询 payload 稳定、可测（目标 <4 KB），慢网络/移动端可用；
  2. 图像与摘要解耦，mosaic 保留策略不影响状态轮询；
  3. viewer 不再依赖 `/state` 里的内部数组，D2 与 A/A/SAR 边界迁移可独立进行；
  4. 便于将来换传输（SSE/WebSocket）而不改物理/服务。
- **影响**：
  - `sar_live.cjs` 现有 `/state` 要瘦身；`/mosaic/<seq>` 重命名为 `/image/<seq>`（或保留别名到 Gate 5 结束，记入 `DEPRECATIONS.md`）；
  - `sar_viewer.html` 的 `reference`/`scene` 读取改为按需 `/snapshot` 或 `/image`；
  - `tests/test_sar_viewer.cjs`、`test_sar_live.cjs`、`test_sar_mosaic.cjs` 更新契约；
  - `/state` 大小进基线（`tests/baseline/state-size.json`），Gate 5 门限 <4 KB。
- **迁移方向**（Gate 5）：
  1. 定义 `/state` schema 与 `resultSeq` 语义（完成序号，单调递增；mosaic 淘汰不改变已发 seq 的含义）；
  2. 服务先同时提供 `/mosaic/<seq>` 与 `/image/<seq>`，viewer 切到 `/image`；
  3. 删除 `/state.reference`/大数组，`/snapshot` 承接完整输入；
  4. 更新测试与页面；Gate 5 结束时删除旧端点。
- **结果（Gate 5，2026-10-18）**：`/state` 只回摘要 + `resultSeq`（`tools/sar_service/http_api.cjs:59-93`），`state.result` 不再出现在轮询里；`/image/<seq>` 成为唯一规范端点，`/mosaic/<seq>` 保留为兼容别名并有测试锁定（`tests/test_sar_mosaic.cjs`）；`/reference` 与 `/snapshot` 承接大对象；`tests/baseline/state-size.json` 锁定轮询体积上限；viewer 删除光速/方位向分辨率重算。
- **被否决方案**：
  - **B：保留 `/state.result` 兼容，增加 `?full=0`，下一阶段再切**。改动小，但会留下两套契约，viewer 仍可依赖完整结果，`/state` 继续膨胀；与“显示只消费结果”冲突。除非时间不足且明确记债，否则不选。

### ADR-004：D4 原生只读/写拆分

- **状态**：Accepted（Gate 0，2026-10-17）
- **决策**：D4 选择 **A**。
- **问题**：`src/native/fc_probe/aesa_fc.c` 一个 DLL 内同时有：
  - 只读 trace：`aesa_fc_trace_start/trace_stop`、`Logs\AESA\fc_trace.log`；
  - 写路径：`aesa_fc_arm/disarm/feed_target`，通过 MinHook 改写指定/中段目标/导引输入；
  - Gate 0 时 `src/hooks/aesa_fc_hook.lua:12` 默认 `mode=1`（注入）；Gate 1 已改为 `mode=0`，非法值归零。
  剩余风险：trace 与注入仍在同一 DLL，无法独立卸载/审计；没有 ABI/profile 校验。
- **选择**：只读 trace DLL 与写注入 DLL 分开；默认只读；写路径必须显式配置 + profile 校验。
  - `src/native/fc_trace/`：trace hooks、poll、日志、version；不导出 arm/feed；
  - `src/native/fc_inject/`：arm/disarm/feed_target 与写 hook；独立 DLL、独立 manifest、独立部署开关；
  - `src/native/abi/dcs_profile.h`：由 `spec/dcs_profiles` 生成，启动自检符号/偏移/export hash；不匹配 fail-closed；
  - hook 默认只加载 trace；`fc_experiment.lua` 显式写开关（现有 `mode=1`，Gate 6 定稿键名）且 profile 匹配才加载 inject。
- **理由**：
  1. 最小权限：只读演示不需要写能力；写 DLL 不部署就没有攻击面；
  2. 可独立验证/卸载/回滚，故障隔离；
  3. profile 校验把游戏更新导致的符号/偏移漂移变成“只读降级”，而不是崩溃或错误注入；
  4. 与 D4 的“默认只读”目标一致，MP/实机风险可控。
- **影响**：
  - 构建拆两个目标；安装器/清单/备份/卸载按产品区分；
  - `aesa_fc_hook.lua` 拆加载/选择逻辑；默认路径不调用 `arm/feed`；
  - `tools/fc_trace_report.py` 只依赖 trace 日志格式；
  - 测试：trace DLL 可独立 smoke；inject DLL 需要显式配置/沙箱；profile 不匹配测试；
  - Gate 1 先做止血：把当前 hook 默认改为 `mode=0`，不注入。
- **迁移方向**（Gate 6）：
  1. Gate 1（已完成）：`aesa_fc_hook.lua` 默认 `mode=0`，`fc_experiment.lua` 显式开启；`readable()` 校验完整页范围；
  2. Gate 6：拆 `fc_trace/` 与 `fc_inject/` 源码/导出/构建；
  3. 生成 `abi/dcs_profile.h`；hook 启动自检，失败只读；
  4. 安装器分产品 manifest/备份后缀，写路径显式开关；
  5. 删除旧单 DLL 与旧 ABI 常量。
- **实施结果（Gate 6，2026-10-18）**：采用同一 `src/native/fc_probe/aesa_fc.c`、`AESA_FC_TRACE_ONLY` 宏切两个构建，而不是两套源码目录（D6-1）：`aesa_fc_trace.dll` 的 PE 导出表没有 arm/disarm/feed；`aesa_fc_inject.dll` 是 trace 超集。`build_common.cjs` 在构建期断言导出/依赖；hook 默认 trace，inject 仅在 `mode=1` + profile + 写导出通过时加载，同一时刻只加载一个。旧单 DLL 由安装器按旧 manifest 迁移，备份后缀统一 `.bak-aesa`。
- **被否决方案**：
  - **B：同一 DLL，编译期/运行期开关，默认 `mode=0`**。实现快，但写 hook 仍链接在同一二进制，误调用/被利用的面仍在；trace 与 inject 无法独立卸载；profile 校验仍要补。只作为时间不足的降级，不作为目标架构。

---

## 6. 单一事实源

### 6.1 来源与生成物

| 来源 | 内容 | 生成物 | 消费者 |
|---|---|---|---|
| `spec/physics.json` | 光速、玻尔兹曼、参考温度、dB/单位定义 | `src/shared/config.lua`、`src/shared/config.cjs`、`src/native/generated/config.h` | `core/physics`、`sar_core/waveform`、native |
| `spec/radar.json` | λ、峰值/平均功率、增益、噪声、损耗、Pfa、波束、驻留、扫描锥、PRF（按名字）、回访、跟踪门 | `src/shared/config.lua`、`src/shared/config.cjs` | `core/{beam,detection,scheduler,tracker,physics}` |
| `spec/sar.json` | footprint（size/n/scatterSpacing/width/bandwidth）、脉冲/内存预算、PFA、材质系数、DBS 系数 | `src/shared/config.lua`、`src/shared/config.cjs` | `sar_core`、`sar_service`、export 校验 |
| `spec/protocol.json` | 3590/3591/3592/3593/3594、greeting、版本、行 schema、上限、超时、配额 | `src/shared/protocol.lua`、JS/Python/C 生成物 | export、sar_service、python tools、native |
| `spec/deployment.json` | Saved Games 路径、Scripts 子目录、DLL 名、日志目录、备份后缀 | `src/shared/config.lua`、`src/shared/config.cjs` | 安装器、hooks、compat |
| `spec/display.json` | dB 量化/参考、mosaic、轮询、量程、颜色 | `src/shared/config.lua`、`src/shared/config.cjs` | sar_service、viewer |
| `spec/dcs_profiles/dcs-<build>.json` | build/module 字段、能力、符号、偏移、数据源 | `src/adapters/dcs/compat/profiles/*.lua`、`src/native/abi/dcs_profile.h` | adapters/compat、native、compat_check |

JS 生成物 Gate 5 已落到 `src/shared/config.cjs`（与 `config.lua` 同目录），`tools/generated/` 已删除；`src/sar_core` 只依赖 `src/shared/config.cjs`，见 §9.4。

### 6.2 生成物规则

- 生成物首行 `DO NOT EDIT`，并带 generator、输入文件、输入 hash；`scripts/gen_config.cjs --check` 零 diff。
- 生成物不放业务逻辑，只放常量/表；消费者不得二次改写默认值。
- 测试从生成物导入常量；禁止在测试/fixture 里保留第二份规范。
- 生成物与旧常量同 Gate 替换；旧键、旧默认、旧 fixture 同 Gate 删除。

### 6.3 当前重复事实（Gate 2 清理清单）

> 本表是 Gate 2 的清理清单（历史证据）；Gate 5 已删除 `tools/sar_*.cjs`、`tools/generated/` 与 `src/geom/`，现役路径见 §4 与 `docs/file-inventory.md`。

| 事实 | 现状副本（示例） | 风险 |
|---|---|---|
| 光速 `299792458` | `spec/physics.json` → `src/shared/config.lua` → `src/core/constants.lua`（`configure()` 注入）；`tools/sar_engine.cjs`、`sar_surface.cjs`、`sar_pfa.cjs`、`sar_pulses.cjs`；`scripts/sar_principle_probe.cjs` | 任一改值/精度不同，Lua/JS 结果不可比 |
| λ = 0.03 | Gate 2 已收敛到 `spec/physics.json` → 生成物；`sar_surface.cjs`/viewer 仍有本地副本，Gate 5 清理 | 雷达/SAR 参数漂移 |
| 带宽/宽度 | `tools/sar_scene.cjs` `FOOTPRINTS`（37.5/10 MHz、129/257）；`sar_processing.cjs` `PROFILES`（75/150 MHz）；`sar_surface.cjs` `DEFAULTS`（75 MHz、129） | footprint×quality 的有效值多源 |
| 端口 | `aesa_export.lua` 3590；`live.py` 3591；`aesa_sar_export.lua` 3592；`sar_live.cjs` 3592/3593/3594；`receiver.py` 3590；scene hook 3594；`sar_bridge.cjs` 3594 | 部署/防火墙/页面配置不同步 |
| footprint | `tools/sar_scene.cjs` `FOOTPRINTS`；`aesa_sar_export.lua` `allowed(size,n)`；`aesa_sar_mission.lua` `start` 校验；`sar_live.cjs` 兼容检查；`sar_processing.cjs` `GRIDS` | 新增档位要改 4–5 处，易漏 |
| 1–50 km 地距 | `aesa_sar_export.lua` 校验；`sar_live.cjs` `IMAGE_MIN/MAX_RANGE_M`；`sar_viewer.html` 文案/判据；`src/scene` mover 半径 50 km（不同语义） | 边界不一致，页面与服务判定打架 |
| 16 类地表词 | `aesa_sar_export.lua` `SURFACE_FINE_NAMES`；`sar_scene.cjs` `SURFACES`；`sar_scattering.cjs` `MATERIALS`/`SURFACE_CLASSES`；`sar_live.cjs` `LEGACY_SURFACE_TOKENS`；`aesa_sar_mission.lua` 1–5；`sar_map.cjs` 材质 | 新增类/改名多源不同步 |
| MAP 默认 | `aesa_sar_export.lua` `MAP_CELLS/MAP_ROWS/MAP_STEP/MAP_POSE`；`sar_live.cjs` `MAP_CELLS_MAX/MAP_ROWS_MAX/MAP_STEP_MIN/MAX/MAP_DEFAULTS`；`sar_map.cjs` `DEFAULTS` | 协议/渲染/服务上限不一致 |
| dB 量化 | `sar_live.cjs` `dB_step:.25`；`sar_viewer.html` Int8 解码；`sar_map.cjs` 固定基准；`sar_surface.cjs` 输出标尺 | 同一像素在不同端点解释不同 |
| PRF 档 | Gate 2 已改为 `spec/radar.json` 的 `prf_selection` 名字数组；scheduler 建立 name→index 映射 | 改表顺序不再改变行为 |

Gate 2 完成后，core/JS/SAR 物理常量应只命中 `spec/`、生成物和测试 fixture；Export/Python/viewer/安装器的残留已登记在 `docs/config-reference.md`，随 Gate 3–6 清理。具体审计正则见[测试与 Gate 门禁](testing-gates.md)。

---

## 7. DCS 边界与兼容层

### 7.1 版本耦合面（现状）

| 面 | 现状调用 | 现状位置 | 目标位置 |
|---|---|---|---|
| Export API | `LoGetModelTime`、`LoGetSelfData`、`LoGetWorldObjects`、`LoGetTargetInformation`、`LoGetLockedTargetInformation`、`LoIsSensorExportAllowed`、`LoGetVectorVelocity`、`LoGetAltitude`、`LoGetAltitudeAboveGroundLevel`、`LoGeoCoordinatesToLoCoordinates`、`LoLoCoordinatesToGeoCoordinates`/`LoCoordinatesToGeoCoordinates` | `src/export/aesa_export.lua`（`lo_env`、`frame_poll`）、`src/export/aesa_sar_export.lua`（`frame`/`M.new` 的 `env`） | `src/adapters/dcs/api/export.lua` |
| terrain 模块 | `terrain.GetHeight`、`terrain.GetSurfaceType`、`terrain.isVisible` | `aesa_export.lua`（`require("terrain")`）、`aesa_sar_export.lua`（`terrain.GetHeight/GetSurfaceType`） | `api/export.lua` + `data/surfaces.lua` |
| Mission API | `land.getSurfaceType`、`world.searchObjects`、`world.VolumeType`、`Object.Category`、`timer.getTime/scheduleFunction`、`world.addEventHandler`、`Unit.getByName`、`getPosition/getVelocity/getDesc/getID`、`net.dostring_in`、`a_do_script` | `src/scene/aesa_sar_mission.lua`、`src/hooks/aesa_fc_hook.lua`、`src/hooks/aesa_sar_scene_hook.lua` | `src/adapters/dcs/api/mission.lua` |
| Hook API | `DCS.setUserCallbacks`、`DCS.getModelTime`、`log.write`、`lfs.writedir/currentdir`、`package.loadlib`、`package.cpath` | 三个 hooks + `aesa_sar_export.lua` 的探针加载 | `src/adapters/dcs/api/hook.lua`、`native.lua` |
| 原生符号 | AGR：`GetDefaultTerrain()`、`getPointOnSurface`、`get_surface_type_name(s)`、`Inter.dll` 名称解码；FC：火控/导弹/目标引擎函数、MinHook 偏移 | `src/native/agradar_probe/aesa_agradar.c`、`src/native/fc_probe/aesa_fc.c` | `src/native/abi/dcs_profile.h` + compat |
| 协议/版本 | `V1`、`HELLO,SAR1`、`HELLO,SARSCENE1`、`CAPS` 字段、`SURFACE_FINE`、16 类词、`MAPSURFACE` 长度、`ParticleEffect`、`radar.fx` DBS 常量 | export/scene/hooks/tools/viewer | `spec/protocol.json` + compat profile |
| 数据形态 | `LoGetWorldObjects` 的 `Position`/`Position.p`、`Heading/Pitch/Bank`、`Country` vs `CoalitionID`、`velocity` 是否存在、对象包围盒 `desc.box`、`getPosition().p` | export/scene | `compat/profile` + `api/*` 的字段适配 |

### 7.2 兼容层（Gate 3/4 已落地）

```text
src/adapters/dcs/
├─ frame.lua                  # DCS 世界/姿态 → ENU（D1 唯一转换点）
├─ truth_replay.lua           # 录制帧 → 核心 TruthSource
├─ rcs.lua / rcs_data.lua     # DCS 机型分类/RCS 数据
├─ api/
│  ├─ export.lua              # LoGet*、terrain.* 的唯一入口
│  ├─ mission.lua             # land/world/Object/timer 的唯一入口
│  ├─ hook.lua                # DCS.setUserCallbacks/log/lfs 的唯一入口
│  └─ native.lua              # package.loadlib/符号解析的唯一入口
├─ compat/
│  ├─ profile.lua             # 校验/查询 profile（表由适配器注入，不读文件）
│  ├─ probe.lua               # 启动探针/能力矩阵
│  └─ profiles/dcs-<build>.lua
└─ data/
   ├─ surfaces.lua            # 16 类词表/旧五类映射
   └─ shaders.lua             # radar.fx 参考常量（DBS/λ/resolution）
```

- `spec/dcs_profiles/dcs-<build>.json` 是 profile 的唯一来源；运行时由生成器产出 Lua 表；`src/native/abi/dcs_profile.h` 由同一来源生成。
- Export 握手增加 `COMPAT,<profile_id>,<matrix_hash>`；`/state` 增加 `compat` 段（profile、能力、降级原因）。
- `scripts/compat_check.cjs --record baseline` 记录当前 DCS build；`--detect --diff baseline` 输出能力矩阵与 diff；退出码表达完全兼容/降级/不兼容。
- 更新流程：DCS 更新 → 先跑 `compat_check` → 只改 profile/数据 → 回归 → 再改业务代码。详见 [DCS 兼容层](dcs-compat.md)。

### 7.3 fail-closed 规则

| 缺失能力 | 行为 |
|---|---|
| `CoalitionID` 不存在 | 阵营 `unknown`，不猜测 `Country` |
| 目标速度字段不存在 | `vel_valid=false`，不做差分假装实时速度 |
| `terrain.isVisible` 不存在 | `visibility=unknown`，仍应用球面视距 |
| `net.dostring_in` 不存在 | 场景桥 `unavailable`；SAR 地形采集可继续，但对象/GMTI 为空并标注原因 |
| `terrain.GetHeight` 不存在 | SAR 采集拒绝（`terrain_unavailable`） |
| 原生 profile 不匹配 | 只读；注入路径不可达 |
| AGR 探针不可用 | MAP 退回旧五类地表；不伪造 16 类 |
| `radar.fx`/DBS 常量不匹配 | DBS 退化并报告原因，不静默用错参数 |

“缺能力返回假值”一律视为 Red；具体测试见[测试与 Gate 门禁](testing-gates.md)。

---

## 8. 模块间数据流

### 8.1 A/A 实时与回放

**现状（Gate 4 完成后）**

1. DCS Export 进程加载 `src/export/aesa_export.lua`（由 `Scripts/Export.lua` 标记块 `dofile`）。
2. `LuaExportAfterNextFrame` 每帧调用 `frame_poll`；按 `LoGetModelTime` 限频 10 Hz；把整帧行合并为一次 `socket:send` 到 `127.0.0.1:3590`。
3. 行格式：`V1` greeting → `PROTO,2`（声明 O 行与坐标是原始 DCS 值）→ `COMPAT,<profile_id>,<matrix_hash>`；随后 `A` 本机、`O` 姿态（原始 DCS Heading/Pitch/Bank）、`P` 首帧字段探针、`T` 单位（阵营/位置/速度）、`L` 地形可见性、`E` 引擎雷达接触。旧 V1 录制没有 `PROTO` 行，其 O 行航向为 `Heading + π/2`。
4. `tools/receiver.py`/`tools/live.py` 通过 `protocol.py` 解析、`ingest.py` 录制/会话、`truth.py` 打包 Lua 帧；`truth_replay.lua` 调 `frame.lua` 统一转 ENU，旧录制由 `legacy_heading` 修正航向。
5. 主线程（lupa 非线程安全）按 `dt` 分片调用 `core:step`；核心输出 `sink:on_dwell`（beam/truth/measurement/detection）与 `on_tracks`。
6. `core:snapshot()` 生成稳定 ENU 显示 DTO；`live.py` 只补 `wall`/`link`/`compat`，HTTP 3591 + SSE `/stream` 推给 `tools/viewer/index.html`；`replay.py` 用同一核心跑录制并输出航迹/引擎对照报告，不再依赖 `tests/`。

### 8.2 SAR

**Gate 0（历史证据）**

1. 服务 `tools/sar_live.cjs` 同时监听 TCP 3592（Export）、HTTP 3593（页面/接口）、TCP 3594（场景桥）。
2. Export `src/export/aesa_sar_export.lua` 连接 3592，发 `HELLO,SAR1` + `CAPS,2,...`；服务可回 `SURFACE_FINE` 要求 16 类地表。
3. 单张 SAR：`/capture` → `CAPTURE`/`CAPTURE_GEO`/`CAPTURE_WORLD` → Export 计算目标点（航迹±45°、geo/world 转换、1–50 km 校验）→ `BEGIN`/`TARGET`/`HEIGHT`/`SURFACE`（17/帧）→ `POSE`（60 Hz，2 s）→ `END`。
4. 服务 `Collector` 解析；`BEGIN` 时通过 `sar_bridge.cjs` 向场景 Hook 发 `SCENE`；Hook 用 `net.dostring_in` 在任务态执行 `aesa_sar_mission.lua`，返回 `SURFACE`/`OBJECT`/`SCENE_END`；服务合并 `scene_data`（地表 provider、对象、跳过/截断统计）。
5. `compute()` 把场景交给 `sar_pool.runImage`：`sar_engine` 校验/合成，`sar_surface` 面元/聚焦，`sar_pfa` PFA，`sar_scattering` 材质/遮挡；结果保存 `recordings/sar/sar-<time>-<id>.json`，内存保留 mosaic（最多 50）。
6. MAP：`/map` → `CAPTURE_MAP`/`CAPTURE_MAP_AT` → `MAPBEGIN`/`MAPPOSE`/`MAPHEIGHT`/`MAPSURFACE`/`MAPEND`；`sar_map` 按扇区/滚动窗口渲染，进入 mosaic 的 `mode:'map'` 条目；DBS 复用同一 MAP 协议在 25 m 网格上采集，带 `sharpen 8|32`，进入 `mode:'dbs'`。
7. 连续/扫掠：服务维护 `continuous` 状态、`sweepPlan`、覆盖/退避；页面 700 ms 轮询 `/state`，按 `completed`/`seq` 取 `/mosaic/<seq>`；`/snapshot` 备份完整结果；`/scene` 保留原始输入；`/designate/check` 唯一判定可成像性。
8. GMTI：Hook 每 2 s 报 `movers`；服务按目标径向速度/多普勒盲区过滤，`/state.movers` 给页面。

**现状（Gate 5 完成后）**

1. `src/export/{sar_protocol,sar_collector,sar_dcs_env,sar_transport}.lua` 只做协议/状态机/环境/传输；DCS 读取经 `api/export.lua`。
2. `src/scene/{sar_scene_core,sar_mission_env}.lua`：前者纯逻辑/格式化（footprint 白名单由 `sar_protocol.allowed` 提供），后者只封装 `land/world/Object/timer`。
3. `src/sar_core` 接收通用场景/波形/材质，输出图像/元数据；不识别 DCS 类名。
4. `src/adapters/dcs/sar_adapter.cjs` 把 DCS footprint、16 类词、对象 kind、质量约束、`radar.fx` 常量送进核心。
5. `tools/sar_service` 负责 Collector/Arbiter/Sessions/Sweep/Coverage/Mosaic/Recorder/HttpApi；`sar_live.cjs` 只组合。
6. `D3`：`/state` 摘要 + `resultSeq`；`/image/<seq>` 取图（`/mosaic/<seq>` 兼容别名）；`/snapshot` 取完整结果/输入。

### 8.3 原生

**现状（Gate 0）**

1. DCS 启动加载 `Saved Games\Scripts\Hooks\aesa_*_hook.lua`；hook 用 `lfs.writedir()` 定位 `Scripts/AESA-AGR|AESA-FC` 下的 DLL，`package.loadlib` 逐符号取函数。
2. AGR：`onSimulationFrame` → `aesa_agradar_poll`；DLL 解析引擎地表符号，Export 在 `SURFACE_FINE` 模式下用 `surface_names`/`surface_mask` 取 16 类；只读，日志 `Logs/AESA/AGR`。
3. FC：`onSimulationFrame` → `aesa_fc_poll`；`load()` 同时取 trace 与写导出；`onSimulationStart` 进入 `pending`，通过 `net.dostring_in` 查 bandit ObjectID，`aesa_fc_arm(mode,id)`；每帧 `ensure_msl_recorder`/`pull_msl_log`/`feed_step`；`onSimulationStop` `disarm`/`trace_stop`/`shutdown`。Gate 1 起默认 `mode=0`（只读），显式 `mode=1` 才 arm 写路径。
4. 任务态 MSL 记录器通过 `net.dostring_in("scripting")`（或 `mission`+`a_do_script`）安装 `world.addEventHandler` + `timer.scheduleFunction`，把 `SHOT/HIT/MSL/TGT` 行缓冲，hook 每 45 帧拉取写入 `Logs/AESA/fc_msl_pos.log`。
5. `tools/fc_trace_report.py` 离线解析 `fc_trace.log`。

**目标（Gate 6）**

1. hook 只做生命周期/选择：默认加载 `fc_trace`，不加载 `fc_inject`；DLL 加载/日志/符号解析经 `api/native.lua`。
2. `fc_trace`：只读 trace/poll/version，独立 manifest/卸载；`fc_inject`：显式配置 + profile 校验 + 备份/回滚。
3. `abi/dcs_profile.h` 启动自检；不匹配 fail-closed（只读）。
4. AGR 增加 profile/version 自检；导出守卫包含 `aesa_fc_feed_target`。
5. 日志格式作为 trace 报告契约；拆分后 `fc_trace_report.py` 更新解析器。

### 8.4 端口、进程与线程

| 通道 | 端口 | 协议/格式 | 现状进程 | 目标模块 |
|---|---|---|---|---|
| A/A Export → 接收器 | 3590 | `V1` + A/O/P/T/L/E 行 | DCS Export Lua → Python | `aa_transport` / `protocol.py` |
| A/A 页面 | 3591 | HTTP + SSE `/stream` | Python `live.py` | `lua_host`/`http` 薄层 |
| SAR Export → 服务 | 3592 | `HELLO,SAR1` + CAPS/STATUS/SAR/MAP 行 | DCS Export Lua → Node | `sar_transport` / `collector.cjs` |
| SAR 页面/API | 3593 | HTTP `/state`、`/image/<seq>`、`/snapshot`、`/scene`、`/designate/check`、POST | Node `sar_live.cjs` | `http_api.cjs` |
| 场景桥 | 3594 | `HELLO,SARSCENE1` + CAP/SCENE/MOVER 行 | DCS Hook Lua ↔ Node | `sar_bridge`/service |
| 原生 AGR/FC | 进程内 | `package.loadlib` C 导出 | DCS 进程 | `api/native.lua` |

线程/宿主约束：

- Python `lupa.LuaRuntime` 非线程安全：只有主线程触碰 Lua；TCP/回放线程只入队 Python 帧；HTTP 线程只读主线程产出的快照（`live.py` docstring）。
- Node SAR 服务：TCP/HTTP 事件循环 + worker 线程池；池按脉冲块/行块拆分，结果与串行逐位一致（`sar_pool.cjs`/`sar_worker.cjs`）。
- DCS 每个 Lua 状态独立加载 DLL；`aesa_agradar.c` 明确不缓存 `lua_State`。
- 导出/场景/Hook 的 socket 自举只允许在 `transport`/`api` 层；业务模块不得直接 `require("socket")`。

---

## 9. 当前已知架构债务与对应 Gate

### 9.1 架构债务

| ID | 债务 | 证据 | 影响 | Gate / 决策 |
|---|---|---|---|---|
| A-01 | 核心携带 DCS 语义（`pos.y` 海拔、`heading=0 → -Z`、`Heading + π/2`） | Gate 0 证据：`src/aesa/physics.lua:108-134`、`src/export/aesa_export.lua:77-79`（文件已删除/已改） | 核心不能接非 DCS 真值；测试/显示耦合 | 4 / D1（**已完成**） |
| A-02 | 游戏 API 散落在 export/scene/hooks，未单点 | 本文件 §7.1 | Gate 3 已建 `api/{export,mission,hook,native}.lua` 与 probe，消费者已切换并通过实机烟测 | 3（已完成） |
| A-03 | socket 自举三份、DLL loadlib 两份 | `aesa_export.lua`、`aesa_sar_export.lua`、`aesa_sar_scene_hook.lua`；两个 hook | Gate 3 已把 loadlib/socket 收口到 `api/*`；旧自举随消费者切换删除 | 3（已完成） |
| A-04 | 参数/协议/词表/端口多源 | §6.3 | Gate 2 收敛 core/JS/SAR 物理；Gate 5 把 SAR 协议的常量/词表/端点/颜色全部指向 `spec/` 生成物；Python 接收器与安装器的部署常量仍待 Gate 6 | 2（部分完成）/5（SAR 已完成） |
| A-05 | SAR 物理在 tools，且认识 DCS 词汇 | Gate 0 证据：`tools/sar_engine/surface/pfa/pulses/scattering/map.cjs`（已删除） | Gate 5 已迁入 `src/sar_core/`；DCS 词汇收口到 `src/adapters/dcs/sar_adapter.cjs`；旧文件已删除 | 5 / D2（**已完成**） |
| A-06 | `sar_live.cjs` 1311 行单文件混合协议/状态机/HTTP/作业 | 本文件 §4.6 | Gate 5 已拆到 `tools/sar_service/`，`sar_live.cjs` 63 行 CLI；各模块有独立测试 | 5（**已完成**） |
| A-07 | `/state` 契约未冻结，图像端点命名混杂 | Gate 0 证据：`/state.reference`、`/mosaic/<seq>`、`/snapshot` | Gate 5 已改为摘要 + `resultSeq`；`/image/<seq>` 为规范端点，`/mosaic/<seq>` 仅兼容别名；`state-size` 基线上限 | 5 / D3（**已完成**） |
| A-08 | viewer 重算物理/复制常量 | A/A：已改 `core:snapshot()`；SAR：光速/方位向分辨率/`resolutionInfo` 已删除，页面只显示服务端 metadata | 已消除两套真值 | 4（A/A）/5（SAR）/ D3（**已完成**） |
| A-09 | 原生 FC 单 DLL 同时读写 | `src/native/fc_probe/aesa_fc.c`、`src/hooks/aesa_fc_hook.lua` | Gate 1 已默认 `mode=0` + 完整范围校验；写路径仍与 trace 同 DLL，无法独立卸载/审计 | 6 / D4 |
| A-10 | 安装器重复实现，备份后缀不统一 | `scripts/install_*.cjs`、`install_export.py`、`install_sar.cjs` 的 `backup()` | 产品间卸载/审计困难；DLL 替换无 DCS 运行检查 | 6 |
| A-11 | Python 生产工具依赖测试设施，`rel_geo` 重复 | Gate 4 前 `tools/live.py`、`tools/replay.py` 都 `import run_tests`；`live.py` 有 `rel_geo` | 生产路径被测试代码绑架；几何两套 | 4（**已完成**） |
| A-12 | 离线探针自带物理常量/默认值 | `scripts/sar_*probe.cjs` | Gate 5：探针改为消费 `src/sar_core` 与 `src/shared/config.cjs`；`audit_repo` 的重复常量检查覆盖探针 | 5（**已完成**） |
| A-13 | JS 生成配置落点与 sar_core 纯化冲突 | Gate 2 生成 `tools/generated/config.cjs`；R4 禁止 `sar_core → tools` | Gate 5 已把生成物落到 `src/shared/config.cjs` 并删除 `tools/generated/`；`sar_core` 只依赖 `src/shared/config.cjs` | 已完成（Gate 5） |
| A-14 | 文档状态头/索引缺失，`status.md` 停在 2026-09-30 | 本文件 §4.10 | 文档可信度下降；审计无法判定现役/历史 | 0/6 |
| A-15 | `integration_check.py` 硬编码本机 Saved Games 路径 | `tools/integration_check.py:9` | 换机/换账户失效；无法进 CI | 4/6 |
| A-16 | 场景 Hook 在安装时内嵌 mission 源码 | `scripts/install_sar_scene.cjs` `bundle()` | hook/mission 必须成对部署/回滚；测试跑生成文件 | 6（部署清单按单产品管理） |

### 9.2 与架构迁移耦合的正确性缺陷（Gate 1 已清）

这些不是“架构”问题，但会在边界迁移时被带到新接口。Gate 1 已完成修复并带回放/测试验证；保留清单用于迁移时核对契约（详见[重构计划 §2.2](refactor-plan.md#22-已知问题本轮-gate-1-处理)）：

| 问题 | 位置 | 对架构迁移的影响 |
|---|---|---|
| RCS 生成器丢 `missile` 兜底 | `scripts/extract_rcs.py:98`、`src/adapters/dcs/rcs_data.lua`、`src/adapters/dcs/rcs.lua`（原 `src/aesa/*`，已迁出） | 已修；生成器与适配器现在都要求四档 fallback |
| T 行阵营取 `Country` 而非 `CoalitionID` | `src/export/aesa_export.lua:107` | 新 `aa_sampler` 的字段契约会错 |
| A/T 速度在真实 DCS 不存在，录制为 0 | `src/export/aesa_export.lua:69,99-108`、`tools/receiver.py:105-121`、`tools/live.py:127-135` | `truth`/`vel_valid` 接口必须先定义 |
| 手动 `/map` 失败无限重试且页面无法停止 | `tools/sar_live.cjs`（`abort`/`tryMapCapture` 路径） | 拆服务状态机前必须先修语义 |
| MAP 采集/渲染 row/col 语义相反 | `src/export/aesa_sar_export.lua:259-260`、`tools/sar_map.cjs:494-497` | 新 `sar_protocol`/`map.cjs` 必须统一 canonical 栅格 |
| 俯仰条带 6° 间距配 3° 波束有盲带 | `spec/radar.json` 已改为 2.25° 间距；`config_validate` 拒绝 spacing > HPBW | Gate 1/2 已修 |
| 随机/关联依赖 `pairs` 顺序 | `src/export/aesa_export.lua:97`、`src/core/core.lua:107`、`src/core/tracker.lua:26`（原 `src/aesa/*`，已迁出） | 确定性迁移/回放基线会被破坏 |
| `fine + 512/2048` 静默降级但 metadata 仍写 fine | `tools/sar_processing.cjs`、`tools/sar_surface.cjs` | `spec/sar.json` 必须记录 effective 值 |
| `ParticleEffect` 映射丢失、`MAPSURFACE` 长度上限不一致 | `src/export/aesa_sar_export.lua`、`tools/sar_live.cjs` | 16 类词表进 adapter 前先统一 |
| 原生探针默认注入、`readable()` 未校验长度（Gate 1 已修：默认只读 + 完整范围校验） | `src/hooks/aesa_fc_hook.lua`、`src/native/fc_probe/aesa_fc.c` | Gate 6 已完成 trace/inject 拆分、profile 校验与实机默认只读 |

### 9.3 债务与 Gate 的对应关系

```text
Gate 0  A-14（文档地图/状态/索引）
Gate 1  9.2 全部（已完成）；A-09 的默认 mode=0 与范围校验（已完成）
Gate 2  A-04（spec/生成物）；A-13（JS 配置落点决策）；A-12 的常量部分
Gate 3  A-02、A-03（API/传输/兼容层；已完成，实机 probe level B）
Gate 4  A-01（D1）、A-08 的 A/A 部分、A-11（**已完成**；待 worklog/commit）
Gate 5  A-05（D2）、A-06、A-07（D3）、A-08 的 SAR 部分、A-12 的物理部分、9.2 的 SAR 项（**已完成**）
Gate 6  A-09（D4）、A-10、A-15、A-16、A-14 的文档定稿（**已完成**）
Gate 7  全量回归；确认无残留、无旧 import、无旧端点（**已完成**，tag `arch-refactor-complete`）
```

### 9.4 开放问题：JS 生成配置的落点（Gate 2 决策）

**已决（Gate 2）**：按任务要求先生成到 `tools/generated/config.cjs`；`src/sar_core` 尚不存在，迁移到 `src/shared/config.cjs` 留到 Gate 5 消费者迁移。**Gate 5 已执行**：生成器直接输出 `src/shared/config.cjs`，`tools/generated/` 删除，`tools/`、`tests/`、`scripts/` 统一 require 新落点；未保留转发 shim（无旧消费者）。以下为 Gate 0 的备选分析，保留作决策记录：

- **推荐**：`spec/` 生成 `src/shared/config.cjs`（与 `config.lua` 同目录）；`tools/generated/config.cjs` 如需保留，只做 `module.exports = require("../../src/shared/config.cjs")` 的转发，供服务/旧探针过渡。`sar_core` 只 import `src/shared/config.cjs`。
- 备选：生成到 `src/sar_core/generated/config.cjs`，由 `sar_core` 内部消费；`tools/generated` 仅服务侧使用。缺点是 `src/shared` 与 `src/sar_core` 各有一份 JS 常量，需 `gen_config --check` 保证同源。
- 不选：`sar_core` 直接 require `tools/generated/config.cjs`，违反 R4，Gate 7 审计会失败。

本文件保留此节作为 Gate 2 决策记录；落点已于 Gate 5 定稿为 `src/shared/config.cjs`，见 §6.1 的生成物表。

---

## 10. 维护规则

1. **同 Gate 更新**：目录/文件/依赖/端点/生成物变化，必须在本文件同一 Gate 更新“现状”和“目标”；不允许“代码已迁、文档下轮再说”。
2. **ADR 不改写**：已接受的 ADR 只追加“结果/后续”；需要改变决策时新增 ADR，并在旧 ADR 标注“被 ADR-00x 取代”。
3. **文件地图与盘点同步**：新增/移动/删除文件时，同步更新 §4 与[文件盘点](file-inventory.md)；`audit_repo` 会检查未归属文件。
4. **文档状态头**：每篇文档必须有 `current|historical|external-reference|draft`；本文件为 `current`。
5. **链接检查**：本文件链接的五篇文档必须存在；`audit_repo` 检查死链。
6. **零残留**：旧路径、旧端点、旧常量在同一 Gate 删除；临时 shim 只能记入 `DEPRECATIONS.md`，下一 Gate 删除。
7. **规则文件同步**：本文件的命令、路径、部署位置变化时，同步更新 `AGENTS.md` 与 `README.md` 的文档索引；`AGENTS.md` 是仓库权威约定，本文件是架构事实源。
8. **评审入口**：新代码评审先看 §3.3 硬规则与 §5 ADR；违反任一硬规则必须在 PR/提交说明中给出 Gate 例外与删除期限。

---

## 附录 A：本文引用的关键契约

| 契约 | 当前定义（Gate 4） |
|---|---|
| TruthSource | `ownship(now)`、`targets(now)`（`src/core/core.lua`、`docs/design-phase1.md` §3）；核心输入为 ENU，DCS 版本由 `src/adapters/dcs/frame.lua` 转换后注入 |
| RCSProvider | `src/core/rcs.lua` 接口（`new(values, default_class)`/`passthrough()`）+ `src/adapters/dcs/rcs.lua` 的 DCS 分类与官方 map 解析 |
| OutputSink | `on_tracks(tracks, ordered)`、`on_dwell({beam,truth,measurement,detection})`；`snapshot()` 输出稳定显示 DTO（ENU） |
| SAR 采集协议 | `HELLO,SAR1` + CAPS/STATUS/SAR/MAP 行（`src/export/aesa_sar_export.lua`、`tools/sar_live.cjs`）→ Gate 5 由 `spec/protocol.json` 生成物与 `sar_collector` 状态机承接 |
| 场景桥协议 | `HELLO,SARSCENE1` + CAP/SCENE/MOVER 行（`src/hooks/aesa_sar_scene_hook.lua`、`tools/sar_bridge.cjs`）→ Gate 5 收敛到 `spec/protocol.json` |
| 原生 ABI | 手写符号名/偏移（`src/native/*/*.c`）→ Gate 6 由 `spec/dcs_profiles` 生成 `src/native/abi/dcs_profile.h` 并启动自检 |
| `/state` | 当前完整状态（含 reference/mosaic 摘要）→ Gate 5 改为摘要 + `resultSeq`；图像 `/image/<seq>`；完整结果 `/snapshot` |

## 附录 B：术语

- **驻留（dwell）**：一次波束指向 + 波形 + 驻留时长的调度单元。
- **CPI**：相干处理间隔；本项目以驻留为 CPI。
- **足迹（footprint）**：SAR 场景的网格/带宽/输出宽度组合；`detail`/`area`/`airport`。
- **MAP**：实波束地面图，不做孔径合成。
- **DBS**：多普勒波束锐化，MAP 与 SAR 之间的中间档。
- **mosaic**：按世界坐标保留的已完成图像集合（含 MAP/DBS/SAR 条目）。
- **ENU**：东-北-上右手系；D1 采用的核心世界系。
- **fail-closed**：缺能力/不匹配时返回未知或拒绝，不返回假值。

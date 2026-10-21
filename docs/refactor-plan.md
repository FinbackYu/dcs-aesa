# aesa 架构重构执行计划

- 日期：2026-10-19
- 状态：current（Gate 0–7 已完成；Gate 7 tag `arch-refactor-complete`：`test_all` 483 项 3 次、回放/SAR 基线与 Gate 0 逐项一致、安装生命周期修复、实机 smoke 与 `compat_check` level B 通过）
- 范围：所有**已实现功能**的抽象、解耦、迁移与清理；不包含尚未开始的新功能与发布验证。
- 原则：**范围一次纳入，执行分 Gate；每个 Gate 完成迁移并删除旧路径；Green 才进入下一个 Gate。**

---

## 0. 结论摘要

当前 aesa 已经具备可演示的原型：A/A 外部显示器、SAR/MAP/DBS/扫掠/GMTI、Export 采样、原生地表探针与火控注入验证。但代码边界仍是"运行时不调用 DCS API"，而不是"原理不依赖 DCS 语义"，并且存在两套物理栈、多个常量事实源和部分版本耦合代码硬编码。

本轮不做"只修 demo、其他以后再说"。所有已有实现都进入重构范围：

- A/A 核心与 DCS 适配器分离；
- SAR 物理从 `tools/` 抽成独立核心；
- `sar_live.cjs`、`live.py`、两个 Export 脚本拆成薄适配器与可测模块；
- DCS 兼容层（profile、探针、原生 ABI 表）单点化；
- `spec/` 成为参数与协议的唯一来源；
- viewer 只消费 snapshot/metadata；
- 原生只读/写路径拆分，默认只读；
- 安装脚本统一，旧文件/旧代码/旧文档同 Gate 清理。

尚未开始的功能（3b/3c 座舱与渲染、MP 完整性验证、发布打包、长期稳定性）不属于本轮，不混进来。

---

## 1. 目标与非目标

### 1.1 目标

1. **原理与游戏分离**：核心不出现 DCS 机型名、`visible`、`Heading + π/2`、`LoGet*`；游戏 API 只在 `src/adapters/dcs/api/`。
2. **一个概念一个所有者**：物理常数、雷达/波形、场景/战术、协议/采集、部署、显示各自只有一个配置来源。
3. **游戏更新可集中验证**：DCS build/module profile + 启动探针 + `compat_check`；缺能力 fail-closed。
4. **服务可独立测试**：`sar_live.cjs` 只做组合根；Collector、Arbiter、Sessions、Sweep、Coverage、Mosaic、Recorder、HttpApi 分离。
5. **显示只消费结果**：viewer 不再重算分辨率、机体投影、相对角。
6. **零残留**：旧文件、旧代码、旧配置、旧文档在每个 Gate 内删除或归档；不留 `_old`/`_v2`/`copy`/`bak`。

### 1.2 非目标（本轮不做）

- 3b/3c 座舱页面、窗口贴附、帧内渲染。
- MP 完整性校验、服务端兼容性、长期运行稳定性验证。
- 发布打包、签名、分发、版本号策略。
- 新雷达模式、新数据源、多雷达/多实例。
- 完整测量噪声模型（只留 `MeasurementModel` 接口，默认 exact）。
- 超出"不退化"的性能优化。

### 1.3 "一次性完成"的定义

- **范围一次纳入**：所有已有实现都迁移，不把半成品留在旧路径。
- **执行分 Gate**：每个 Gate 有停点、测试标准、清理门禁；Green 才继续。
- **旧路径同 Gate 删除**：迁移完成即删；如必须临时保留 shim，记入 `DEPRECATIONS.md`，下一个 Gate 删除。
- **最终一套实现**：一个概念一个所有者，一个参数一个来源，一个几何公式一个模块。

---

## 2. 当前基线

### 2.1 已可运行

- `src/core/`（Gate 4 建立）：`constants`、`physics`、`beam`、`detection`、`geometry`、`scheduler`、`tracker`、`measurement`、`rcs`（接口）、`snapshot`、`core`、`init`。
- `src/adapters/dcs/`：`frame`、`truth_replay`、`rcs`、`rcs_data` 与 `api/`、`compat/`。
- `src/export/aesa_export.lua`：A/A V1 行协议 → TCP 3590。
- `src/export/aesa_sar_export.lua`：SAR/MAP 采集 → TCP 3592。
- `src/scene/aesa_sar_mission.lua` + `src/hooks/aesa_sar_scene_hook.lua`：对象/GMTI 场景桥 → TCP 3594。
- `tools/sar_*.cjs`：SAR 回波、反投影、PFA、实波束/MAP、DBS、并行池。
- `tools/sar_live.cjs`：SAR 服务、HTTP、连续采集、扫掠、拼接。
- `tools/live.py`、`receiver.py`、`replay.py`：A/A 实时/录制/回放。
- `src/native/agradar_probe`、`src/native/fc_probe`：地表掩码、火控观测/注入。
- `scripts/install_*`：开发部署脚本（manifest/备份已具雏形）。

### 2.2 已知问题（Gate 1 已修复，保留作回归清单）

Gate 1 已完成下列修复并带回放验证，证据见 `worklog/2026-10/2026-10-17_2315_gate-1.md`；本表保留用于迁移时核对契约，不再表示当前缺陷。

| 严重度 | 问题 | 位置 |
|---|---|---|
| 高 | RCS 生成器丢 `missile` 兜底 | `scripts/extract_rcs.py:98`、`src/adapters/dcs/rcs_data.lua`、`src/adapters/dcs/rcs.lua`（历史路径 `src/aesa/*`，已迁出） |
| 高 | T 行阵营实际取 `Country`，未读 `CoalitionID` | `src/export/aesa_export.lua:107` |
| 高 | A/T 速度字段在真实 DCS 中不存在，录制为 0 | `src/export/aesa_export.lua:69,99-108`；`tools/receiver.py:105-121`；`tools/live.py:127-135` |
| 高 | 手动 `/map` 失败后无限重试且页面无法停止 | `tools/sar_live.cjs:373-374,1278` |
| 高 | MAP 采集 row/col 与渲染 row/col 语义相反 | `src/export/aesa_sar_export.lua:259-260`；`tools/sar_map.cjs:494-497` |
| 中 | 搜索俯仰条带 6° 间距配 3° 波束存在盲带 | Gate 0 历史路径 `src/aesa/config.lua:54`、`src/aesa/physics.lua:170-173`（文件已删除；现配置校验在 `src/shared/config_validate.lua`） |
| 中 | 随机/关联依赖 `pairs` 遍历顺序 | `src/export/aesa_export.lua:97`、`src/core/core.lua`、`src/core/tracker.lua`（历史路径 `src/aesa/*`，已迁出） |
| 中 | `fine + 512/2048` 静默降级但 metadata 仍写 fine | `tools/sar_processing.cjs:20-21`；`tools/sar_surface.cjs:190` |
| 中 | `ParticleEffect` 映射丢失、MAPSURFACE 长度上限不一致 | `src/export/aesa_sar_export.lua:39,46-51`；`tools/sar_live.cjs:27-38` |
| 中 | 原生探针默认注入、`readable()` 未校验长度 | `src/hooks/aesa_fc_hook.lua:12`；`src/native/fc_probe/aesa_fc.c:289-299` |

### 2.3 基线冻结

Gate 0 必须建立：

- `scripts/test_all.cjs`：统一跑 Python/Node/原生套件，报告 pass/fail/skip。
- `scripts/audit_repo.cjs`：残留、重复常量、API 越界、旧引用、文档状态检查。
- `tests/baseline/`：回放摘要、SAR 指标、协议计数、`/state` 大小；只存 JSON/哈希，不存大图。
- 当前 commit tag：`pre-arch-refactor`。

基线数字以 Gate 0 实际运行为准，不沿用历史记忆。已知核心测试：`python tests/run_tests.py` 22/22、`python tests/test_review_regressions.py` 38/38；其余套件在 Gate 0 补录。

---

## 3. Gate 0 必须先定的决策

四项决策写入 `docs/architecture.md` 的 ADR 小节，后续不再反复。

### D1. 帧模型

- **A（推荐）**：核心使用通用 ENU（x 东、y 北、z 上或等价右手系），DCS `x/y/z`、`Heading + π/2`、MSL 高度只在 `src/adapters/dcs/frame.lua` 转换。
- **B**：核心明确为 DCS-local，冻结接口并在 `docs/conventions.md` 声明"核心只接 DCS 世界系"。
- 影响：A 需要改 `physics` 接口和测试；B 改动小但放弃"核心可接非 DCS 真值源"。
- 计划默认按 **A** 编写；若 Gate 0 选 B，Gate 4 的帧迁移范围相应缩小。

### D2. SAR 核心归属

- **A（推荐）**：`src/sar_core/` 纯 JS 核心（无 DCS 名称、无 HTTP、无文件系统），`tools/` 只做适配/服务/显示。
- **B**：承认 `tools/sar_*` 是独立产品，但必须在 `docs/architecture.md` 声明它是第二个 bounded context。
- 计划默认按 **A** 编写；SAR 若不再长期维护，可选 B 并删除相关迁移。

### D3. `/state` 契约

- **A（推荐）**：`/state` 只回摘要 + `resultSeq`；图像走 `/image/<seq>` 或 `/snapshot`；viewer 在 `completed` 变化时拉图。
- **B**：保留 `/state.result` 兼容，但增加 `?full=0`，下一阶段再切。
- 计划默认按 **A** 编写，viewer 同 Gate 迁移。

### D4. 原生只读/写拆分

- **A（推荐）**：只读 trace DLL 与写注入 DLL 分开；默认只读；写路径必须显式配置 + profile 校验。
- **B**：同一 DLL，编译期/运行期开关；默认 `mode=0`。
- 计划默认按 **A** 编写；若时间不足，至少完成 B 的默认关闭和 profile 校验。

---

## 4. 目标结构

### 4.1 目录

```text
aesa/
  spec/                         # 单一事实源
    physics.json
    radar.json
    sar.json
    protocol.json
    deployment.json
    display.json
    dcs_profiles/
      dcs-<build>.json
  src/
    core/                       # 纯 Lua A/A
      constants.lua
      physics.lua
      geometry.lua
      beam.lua
      detection.lua
      scheduler.lua
      tracker.lua
      core.lua
      snapshot.lua
      measurement.lua
      intercept.lua
    adapters/dcs/
      frame.lua
      truth_replay.lua
      rcs.lua
      rcs_data.lua
      api/
        export.lua
        mission.lua
        hook.lua
        native.lua
      compat/
        profile.lua
        probe.lua
        profiles/
      data/
        surfaces.lua
        shaders.lua
    export/                     # 薄采样
      aa_sampler.lua
      aa_protocol.lua
      aa_transport.lua
      sar_protocol.lua
      sar_collector.lua
      sar_transport.lua
    scene/
      sar_scene_core.lua
      sar_mission_env.lua
    hooks/                      # 生命周期/桥接
    native/
      abi/
        dcs_profile.h
      agradar_probe/
      fc_trace/
      fc_inject/
    sar_core/                   # 纯 JS SAR
      geometry.cjs
      waveform.cjs
      scatterers.cjs
      materials.cjs
      engine.cjs
      focus.cjs
      pfa.cjs
      map.cjs
      memory.cjs
      pool.cjs
    shared/                     # 生成物
      config.lua
      protocol.lua
  tools/
    sar_service/
      collector.cjs
      arbiter.cjs
      sar_session.cjs
      map_session.cjs
      dbs_session.cjs
      sweep_planner.cjs
      coverage_index.cjs
      mosaic_store.cjs
      recorder.cjs
      http_api.cjs
      service.cjs
    sar_live.cjs                # 兼容入口/CLI，仅组合根
    lua_host.py
    protocol.py
    ingest.py
    truth.py
    receiver.py
    live.py
    replay.py
    sar_viewer.html
    viewer/
  scripts/
    test_all.cjs
    audit_repo.cjs
    gen_config.cjs
    compat_check.cjs
    install_common.cjs
    install_*.cjs
  tests/
    baseline/
    fixtures/
```

### 4.2 依赖方向

```text
src/core              # 纯 Lua，无 DCS、无 IO
    ↑
src/adapters/dcs      # 唯一游戏 API/帧/数据适配
    ↑
src/export / scene / hooks

src/sar_core          # 纯 JS，无 DCS、无 HTTP
    ↑
src/adapters/dcs (SAR)
    ↑
tools/sar_service     # 组合/HTTP/作业
    ↑
viewer
```

硬规则：

- `src/core` 不得 import 游戏适配、服务、文件系统。
- `src/sar_core` 不得 import `tools/sar_service`、`sar_bridge`、viewer。
- `tools/` 不得反向定义物理；只能编排。
- viewer 不得重算物理；只消费 snapshot/metadata。

### 4.3 单一事实源

| 来源 | 内容 | 生成物 |
|---|---|---|
| `spec/physics.json` | 光速、玻尔兹曼、参考温度 | Lua/JS/C |
| `spec/radar.json` | A/A 雷达、PRF（按名字）、驻留、波束、扫描锥 | Lua |
| `spec/sar.json` | footprint、带宽、输出宽度、脉冲预算、PFA、散射 | JS/Lua |
| `spec/protocol.json` | 端口、greeting、版本、行 schema、上限、超时、配额 | Lua/JS/Python/C |
| `spec/deployment.json` | Saved Games 路径、Scripts 子目录、DLL、日志 | Lua/JS |
| `spec/display.json` | dB 量化/参考、mosaic、轮询、量程、颜色 | JS/Lua |
| `spec/dcs_profiles/*.json` | DCS build/module 的字段、能力、符号、偏移、数据源 | Lua/JS/C |

生成物统一加 `DO NOT EDIT` + generator + hash；`gen_config --check` 必须零 diff。

---

## 5. 执行 Gate

### Gate 0：基线、决策、盘点

**目标**：冻结当前可演示状态，建立文件地图、测试基线、清理和门禁工具。

**任务**

1. 打 tag `pre-arch-refactor`；记录当前分支/commit。
2. 建 `scripts/test_all.cjs`，覆盖：
   - `python tests/run_tests.py`
   - `python tests/test_review_regressions.py`
   - `node --test tests/test_sar_*.cjs`
   - `node --test tests/test_install_sar.cjs tests/test_install_sar_scene.cjs`（`AESA_LUA` 可用时）
   - `python tests/test_agradar_probe_dll.py`、`test_fc_probe_dll.py`（DCS bin 可用时）
   - 报告 pass/fail/skip 和 skip 原因。
3. 建 `scripts/audit_repo.cjs`（检查项见 §7.3）。
4. 建 `docs/architecture.md`（模块边界、依赖方向、文件地图、ADR）。
5. 建 `docs/conventions.md`（坐标/角度/时间/单位/栅格/dB/协议版本）。
6. 建 `docs/dcs-compat.md`（版本耦合面 + 更新流程）。
7. 建 `docs/testing-gates.md`（Gate 定义、阈值、判定规则）。
8. 建 `tests/baseline/`：
   - `replay-flight3.json`、`replay-flight9.json`；
   - `sar-detail.json`、`sar-area.json`（尺寸、dB 范围、耗时、点响应指标）；
   - `export-protocol.json`（行数/字段数/坏行）；
   - `state-size.json`（`/state` 响应大小、mosaic 摘要）。
9. 更新 `AGENTS.md`：
   - 修正 `fc_probe` "只读"描述；
   - 补完整测试命令和 skip 规则；
   - 补清理纪律与 Gate 规则；
   - 补兼容层位置和游戏更新流程。
10. `docs/status.md` 标为历史快照；README 增加新文档索引。
11. 文件盘点：按"现役/生成/历史/外部参考/实验/删除候选"分类，列出候选清单。

**验证**

- `node scripts/test_all.cjs` 输出基线；所有必跑套件 Green，skip 有原因。
- `node scripts/audit_repo.cjs` 无 error。
- `git status` 干净。
- 四个决策写入 `docs/architecture.md`。

**清理**

- 建 `DEPRECATIONS.md`（空表）。
- 清理候选只列清单，不批量删除；用户确认后再动。

**退出条件**：基线可复现；文档地图完整；测试/审计工具可用。否则停。

---

### Gate 1：正确性止血

**目标**：消除会静默给错数据的缺陷，并删除被替代的旧路径。

**任务**（每条先写失败测试）

1. `extract_rcs.py` 补 `missile` 兜底；`rcs.lua` 启动校验四个 fallback key；生成器 schema 测试。
2. `aesa_export.lua` 改读 `CoalitionID`；测试桩使用真实 DCS 字段（`Country` 与 `CoalitionID` 不同）。
3. 本机速度改 `LoGetVectorVelocity`；目标速度加 `vel_valid`；`receiver.py` 与 `live.py` 的差分修补收敛到一个模块。
4. 手动 `/map` 失败关闭 `mapSession.active`；100 ms 定时器只对连续模式重试；页面可停、可重发。
5. MAP 采集/渲染统一 canonical `(ix=x, iz=z)` 或明确 `grid_layout`；新消费者按 cols/rows 不转置。
6. 俯仰条带：加密到 ≤HPBW，或启动校验 `spacing <= hpbw_el` 并明确接受盲带。
7. 目标/航迹按稳定 id 排序；随机消费与关联不依赖 `pairs` 顺序。
8. `processingOptions` 返回 `effective_quality/bandwidth/width`；metadata 记录实际值。
9. `ParticleEffect` canonical 映射；`MAPSURFACE` 长度上限统一，16 类 worst-case 测试。
10. `aesa_fc.c` 的 `readable()` 校验完整页范围；`aesa_fc_hook.lua` 默认 `mode=0`。

**验证**

- 每条 bug 的回归测试通过。
- `python tests/run_tests.py` 22/22；`python tests/test_review_regressions.py` 38/38。
- `python tools/replay.py recordings/flight3-final.aesarec --dt 0.05 --seed 42` 与基线一致；`flight9` 无新增假航迹。
- `node scripts/audit_repo.cjs` 无 error。

**清理**

- 删除被替代的旧字段/旧分支/旧测试（速度两份、地图重试、旧阵营回退、旧 `fine` 元数据路径）。
- 旧路径不得以注释保留。

**退出条件**：无已知静默错误；基线无退化。否则停。

---

### Gate 2：契约与单一事实源

**目标**：参数/协议/几何只改一处；删除重复常量和死配置。

**任务**

1. 建 `spec/` 六个 JSON（§4.3）。
2. 建 `scripts/gen_config.cjs`：
   - `src/shared/config.lua`、`protocol.lua`；
   - `src/shared/config.cjs`（Gate 5 从 `tools/generated/` 迁入）；
   - `src/native/generated/config.h`；
   - `tests/fixtures/config.*`。
3. 建 `scene_geom.lua` / `scene_geom.cjs`：
   - `sceneToWorld`、`worldToScene`、`texelIndex`、`clampPixel`；
   - 替换 Export、mission、engine、surface、PFA、viewer 的 9 处公式；
   - 固定向量 Lua/JS 交叉测试。
4. 配置清理：
   - 删除 `tick_s`；
   - `notch_half_ms` → `notch_half_mps`，`gate_vel_margin_ms`/`vel_floor_ms`/`slow_mover_ms` → `_mps`；
   - PRF 数组改名字引用，删除 `{2,4,1,5}` 下标；
   - `init.build(root, {config=...})` 支持注入和深拷贝；
   - `az_step`/`hpbw`、replay range 等交叉约束进 schema。
5. 删除重复常量：`C`、`λ`、端口、footprint、1–50 km、地表词表、MAP 默认。
6. 测试从生成物导入常量；删除测试里的第二份规范。

**验证**

- `node scripts/gen_config.cjs --check` 零 diff。
- Lua/JS 几何向量一致。
- `rg` 重复常量只在 `spec/`、生成物、测试 fixture 出现。
- 全量测试通过；回放/SAR 与基线一致（浮点允许 ≤1e-9 或 1 LSB，需记录）。
- `audit_repo` 无 error。

**清理**

- 删除旧配置键、旧常量、旧生成物、旧测试 fixture。
- 生成物加 `DO NOT EDIT` + generator/hash。

**退出条件**：改一个参数只改 `spec/`；跨语言一致；无重复常量。否则停。

---

### Gate 3：DCS 兼容层

**目标**：游戏版本相关知识单点化；更新后可集中验证、降级、修改。

**任务**

1. 建 `src/adapters/dcs/api/{export,mission,hook,native}.lua`：
   - 所有 `LoGet*`、`terrain.*`、`world.*`、`land.*`、`net.dostring_in`、`log.*`、`package.loadlib`、`lfs` 只在这里。
2. 建 `src/adapters/dcs/compat/{profile,probe}.lua` + `profiles/dcs-<build>.lua`：
   - 字段名、机型能力、回调 quirk、地形/地表/任务能力、原生符号/偏移/导出、数据源。
3. 建 `src/native/abi/dcs_profile.h`（由 profile 生成）：
   - 符号、vtable、offset、export hash；
   - 启动自检；不匹配 fail-closed。
4. 建 `scripts/compat_check.cjs`：
   - `--record baseline` / `--detect --diff baseline`；
   - 检查 build、字段形态、回调、mission 能力、原生符号、RCS 数量、地表词表、`radar.fx` hash；
   - 输出能力矩阵与 diff；退出码表达完全兼容/降级/不兼容。
5. Export 握手增加 `COMPAT,<profile_id>,<matrix_hash>`；`/state` 增加 `compat` 段。
6. fail-closed 规则：
   - 缺 `CoalitionID` → `unknown`；
   - 缺速度 → `vel_valid=false`；
   - 缺 `terrain.isVisible` → `visibility=unknown`；
   - 缺 `net.dostring_in` → 场景桥 `unavailable`；
   - 缺 `GetHeight` → SAR 采集拒绝；
   - 原生 profile 不匹配 → 只读。
7. 删除业务代码里的直接游戏 API 调用、两份 socket 自举、死 `CAP` 字符串、`AESA.VERSION`、`AESA.tick`。

**验证**

- `node scripts/compat_check.cjs --detect --diff <baseline>` 当前 DCS build Green。
- `rg` 游戏 API 只在 `api/`。
- fail-closed 测试通过。
- 实机（DCS 可用时）：Export 10 Hz、日志无 error、场景桥能力正确。
- 原生只读默认；写路径不可达。

**清理**

- 删除旧 API 调用、旧 socket 自举、旧能力字符串、旧版本常量。

**退出条件**：游戏更新后只改 profile/数据即可恢复；缺能力不返回假值。否则停。

---

### Gate 4：A/A 边界

**目标**：核心去掉 DCS 语义；显示层不再读内部表；Python 工具共用一套协议/ingest。

**状态：代码迁移已完成（2026-10-18）**。`src/core/`（12 个模块）与 `src/adapters/dcs/{frame,truth_replay,rcs,rcs_data}.lua` 已落地，`src/aesa/` 已删除；`tests/test_gate4_boundary.py`、`tests/test_gate4_snapshot.py` 已加入。`test_all` 9/9 套件、447 项在新增测试前全绿；flight3（15828 驻留、6/6 航迹）与 flight9（62340 驻留、5/5 航迹）回放与基线一致。待最终 worklog/commit 后判定 Green。

**实际落地**

- 核心帧为 ENU：x 东、y 北、z 上；heading 从北顺时针，pitch 上正，roll 右翼下沉为正。
- Export 发送 `V1` → `PROTO,2` → `COMPAT,...`；`O` 行发送原始 DCS Heading/Pitch/Bank，旧 V1 录制由 `frame.legacy_heading` 修正。
- `core:snapshot()` 拥有稳定显示 DTO；`live.py` 只补 `wall`/`link`/`compat`；viewer 消费 ENU 字段（`east_m/north_m/ve_mps/vn_mps`），无 `rel_geo`。
- `on_dwell` 拆为 `beam`/`truth`/`measurement`/`detection`；`MeasurementModel` 默认 exact、可选 quantized。
- Python 工具拆为 `lua_host.py`/`protocol.py`/`ingest.py`/`truth.py`；`live.py`/`receiver.py`/`replay.py` 变薄，不再 import `tests/`。

**任务**

以下为迁移前任务清单（`src/aesa/` 已删除，旧路径仅作历史对照）：

1. 移动 DCS 适配：
   - `src/aesa/truth_replay.lua` → `src/adapters/dcs/truth_replay.lua`；
   - `src/aesa/rcs.lua` 拆为 `src/core/rcs.lua`（接口）+ `src/adapters/dcs/rcs.lua`（DCS 分类）；
   - `src/aesa/rcs_data.lua` → `src/adapters/dcs/rcs_data.lua`；
   - `init.build` 不再默认加载 DCS 数据。
2. 帧模型：
   - 按 D1 实现 `src/adapters/dcs/frame.lua`；
   - `src/core/physics.lua` 去掉 DCS 注释、`pos.y` 语义、`heading=0 → -Z` 假设；
   - 测试使用通用帧 + DCS 转换向量。
3. `core:snapshot()` + `TrackView`：
   - sink 输出稳定 DTO；
   - `tools/live.py`、viewer 不再读 `sched/trk` 内部表；
   - `on_dwell` 拆 `beam/truth/measurement/detection`。
4. `MeasurementModel` 接口：默认 exact；预留量化/噪声。
5. Python：
   - `tools/lua_host.py`、`protocol.py`、`ingest.py`、`truth.py`；
   - `receiver.py`/`live.py`/`replay.py` 变薄；
   - 生产工具不再 `import tests.run_tests`。
6. A/A viewer：只消费 snapshot；删除 `rel_geo`、机体投影、内部字段读取。

**验证**

- `rg` 核心无 DCS 机型名/`visible`/`Heading + π/2`/`LoGet*`。
- 回放 `flight3-final`/`flight9` 与基线一致；同种子连跑 3 次一致。
- `snapshot` 契约测试通过；viewer 视觉检查通过。
- Python 工具不依赖 `tests/`；集成/回放通过。

**清理**

- 删除原 `src/aesa/`（已删除）、`default_rcs`、旧内部字段读取、`live.py.rel_geo`、viewer 物理副本、旧测试。

**退出条件**：核心可接合成 TruthSource；显示只读 snapshot；无 DCS 语义。否则停。

---

### Gate 5：SAR 边界

**目标**：SAR 物理独立；服务拆分；Export/mission 变薄；`/state`/dB/viewer 收敛。

**任务**

1. 建 `src/sar_core/`，迁移 `tools/sar_{engine,surface,pfa,pulses,scattering,map,pool,worker}.cjs` 的物理部分：
   - `geometry.cjs`、`waveform.cjs`、`scatterers.cjs`、`materials.cjs`、`engine.cjs`、`focus.cjs`、`pfa.cjs`、`map.cjs`、`memory.cjs`、`pool.cjs`。
2. 建 `src/adapters/dcs/sar_adapter.cjs`：
   - footprint、surface 词汇、对象 kind、采集质量约束、`radar.fx` 参考常量；
   - 核心不识别 DCS 类名。
3. 拆 `tools/sar_live.cjs`：
   - `Collector`、`CaptureArbiter`、`SarSession`、`MapSession`、`DbsSession`、`SweepPlanner`、`CoverageIndex`、`MosaicStore`、`Recorder`、`HttpApi`、`service`；
   - `sar_live.cjs` 只保留 CLI/组合根，目标 <300 行。
4. 拆 `src/export/aesa_sar_export.lua`：
   - `sar_protocol.lua`、`sar_collector.lua`、`sar_dcs_env.lua`、`sar_transport.lua`。
5. 拆 `src/scene/aesa_sar_mission.lua`：
   - `sar_scene_core.lua`、`sar_mission_env.lua`。
6. `/state` 按 D3 切摘要 + `/image/<seq>`；viewer 同轮迁移。
7. dB 参考统一：每条目 `db_ref` 或固定参考；SAR/MAP 不再共用未标注的 Int8 标尺。
8. SAR viewer 只读 metadata：删除分辨率重算、20–160°/1–50 km 副本、`degraded_near_forward_deg`、`sarWindowHalfDeg`。
9. 删除旧 `MAP_DEFAULTS` 副本、旧栅格方向、旧 DBS 提示。

**验证**

- SAR 图像与基线逐像素 0 或 ≤1 LSB；PFA/点响应指标在容差内。
- 服务模块单测通过；`/state` 摘要 <4 KB；viewer 视觉检查。
- Export/mission 测试通过；16 类地表 round-trip。
- `sar_live.cjs` <300 行；无旧 import。

**清理**

- 删除旧单文件、旧默认、旧 dB 路径、旧 viewer 物理、旧测试。
- 旧 SAR 算法若保留对照 → `archive/` + README；否则删除。

**退出条件**：SAR 核心无服务/DCS 依赖；服务可独立测试；图像等价。否则停。

---

### Gate 6：原生、部署、文档

**目标**：原生只读/写拆分；安装统一；文档/规则同步。

> 详细实施计划（任务分解、审计清零清单、验证矩阵、风险/回滚）见 [gate-6-plan.md](gate-6-plan.md)。

**任务**

1. 原生：
   - `aesa_fc` 拆 `fc_trace`（只读）与 `fc_inject`（写）；
   - 默认只读；写路径显式配置 + profile 校验 + 备份/回滚；
   - `aesa_agradar` 增加 profile/version 自检；
   - 构建脚本统一 `build_common.cjs`；导出守卫包含 `aesa_fc_feed_target`。
2. 部署：
   - `scripts/install_common.cjs`：hash/backup/transaction/syntax/manifest/ensureDcsClosed；
   - 统一备份后缀、`status/verify` 语义、`DCS*.exe` 检查；
   - 给 FC/AGR 安装器补生命周期测试。
3. 文档/规则：
   - `AGENTS.md` 当前事实；
   - `README.md` 架构/测试矩阵/文档索引；
   - `docs/status.md` 历史；
   - `design-sar-prototype.md`、`design-fc-injection.md` 标历史或重写；
   - `docs/config-reference.md` 从 `spec/` 生成。

**验证**

- 原生构建/加载/卸载无崩溃；符号解析与 profile 一致；默认只读。
- install → verify → repair → uninstall 生命周期测试通过；无残留、不覆盖用户文件。
- `audit_repo` 无 error；文档无死链；AGENTS 与代码一致。

**清理**

- 删除旧安装器重复逻辑、旧 ABI 常量、过时文档结论、旧构建守卫。

**执行结果（2026-10-18）**

- 原生：同一 `aesa_fc.c` 用 `AESA_FC_TRACE_ONLY` 编译 `aesa_fc_trace.dll`（导出表无写函数）与 `aesa_fc_inject.dll`（trace 超集）；`build_common.cjs` 统一 gcc/PATH/PE 守卫；hook 默认 trace，inject 仅在 `mode=1` + profile + 写导出通过时加载。
- 部署：`install_common.cjs` 统一 `.bak-aesa`/事务/Lua 5.1/DCS 运行检查；SAR/场景/FC/AGR 安装器已迁移；FC `--with-inject` 显式；旧 `aesa_fc.dll` 按旧 manifest 迁移。
- 审计：38 条 known 清零，`tests/baseline/audit-baseline.json` 为空；`audit_repo --strict` 0 finding。
- 验证：`test_all` 9/9 套件、480 项通过；`gen_config --check` 0 diff；FC trace 13/13 hooks/默认只读、A/A 739 帧/76.72 s（9.63 Hz）、scene `CAP,...` 实机通过；SAR Export 连接行未落 `dcs.log` 作为观察性缺口，见 Gate 6 worklog。

**退出条件**：原生安全默认；部署可复现；文档/规则同步。否则停。

---

### Gate 7：全量回归与收口

**目标**：确认整套重构没有破坏演示/回放/SAR/部署；清理所有残留。

**任务**

1. `node scripts/test_all.cjs` 全绿；skip 有原因。
2. 回放 `flight3-final`、`flight9` 与基线一致；确定性 3 次一致。
3. SAR：128/512 档图像、PFA、MAP、DBS、sweep、mosaic 与基线一致；实机 smoke。
4. `compat_check` 当前 build Green；缺能力降级测试。
5. 安装/卸载/修复在干净 Saved Games 上通过；无残留。
6. `audit_repo` 零 error；`git status` 干净；无旧 import/旧文档链接。
7. 打 tag `arch-refactor-complete`；写 worklog 总结（迁移/删除/遗留）。

**验证**

- 所有 Gate 的指标与基线一致或有明确批准的差异。
- 演示链路仍可运行：A/A 实时/回放、SAR 出图、Export 采样、场景桥。
- 无 `_old`/`_v2`/`copy`/`bak`/`tmp` 留在现役目录。

**退出条件**：全量 Green + 清理审计零 error。否则停，不宣布完成。

**执行结果（2026-10-19）**

- 全量：`test_all` 3 次 9/9 套件、483 项通过（59.71 / 60.19 / 59.51 s），0 失败/0 skip；`git clean -nd` 为空。
- 回放：flight3（1608 帧 / 168.29 s / 6 确认）与 flight9（6716 帧 / 690.149 s / 5 确认）各 3 次输出逐字节一致；帧数/时长/航迹/检测计数与 `tests/baseline` 逐项 0 差异。Gate 7 新增位置跳变测量：flight3 p95 231.161 m / max 281.847 m，flight9 p95 229.254 m / max 232.353 m，最大隐含速度 354/232 m/s；`src/core` 与 `tools/replay.py` 相对基线 commit `c5124eae` 无差异。
- SAR：`capture_baseline --out` 重跑 detail/area 与 Gate 0 基线逐项 0 差异（`0 bad lines`、`3664 B /state`）；机场 512 m 合成场景 3 次图像矩阵 SHA-256 一致（uniform/classified），PFA 五点最大 FWHM 相对差 1.643%、位置误差 0.10 m、PSLR 不劣于反投影 +1.07 dB；2048 m 机场概览 smoke 成功（257 px / 8 m / 10 MHz / 3351 pulses / 153.6 s）。
- 部署：临时 Saved Games 四产品 install→verify→repair→uninstall 全 0；修复 `install_export` 将空白 `Export.lua` 误判为用户文件、`install_compat_probe` 卸载留下 0 B `Export.lua`；删除 `install_sar` 旧 re-export 并迁移 compat probe/测试到 `install_common`。
- 生产缺陷：`build_runtime` 的 `AESA_SAR` 表漏发 `profile_data`，导致 `deployed=false`、SAR Export 从未安装；补入并由 `test_install_sar.cjs` 断言。`compat_check` 的 RCS 路径从已删除的 `src/aesa/` 改为 `src/adapters/dcs/`，并补 `Scripts/AESA/probe-*.log` 根路径输入。
- 实机（2026-10-19 06:29–06:32）：A/A 1186 帧 / 123.177 s = 9.628 Hz；`AESA-SAR: connected; height=true surface=true`；scene `CAP,land.getSurfaceType,world.searchObjects,world.searchObjects,net.dostring_in(scripting)`；FC trace 17/17 symbols、13/13 hooks、`mode=0`、`inject-dll-absent`、shutdown after 21543 frames；AGR deferred 一次后 loaded；无 AESA error/poll error。
- 兼容：`compat_check --detect --diff tests/baseline/compat.json --dcs-dir <DCS>` → **level B**（exit 2），required 全 ok；DAT-RCS 50 entries、GFX-RADARFX hash match。

---

## 6. 测试与门禁标准

### 6.1 三色判定

| 结论 | 条件 | 动作 |
|---|---|---|
| Green | 构建/加载成功；必跑测试全过；功能指标在基线容差内；无新增 warning；审计无 error | 进入下一个 Gate |
| Yellow | 只有非关键偏差，且有 owner/日期/说明 | 本 Gate 内继续；进入下一 Gate 前清零或经确认接受 |
| Red | 崩溃/挂起、数据错误、物理偏差超容差、协议/字段不匹配、原生符号/偏移不匹配、确定性破坏、flaky、审计 error | 停线，定位根因，补失败测试，修复后重跑整个 Gate |

补充：

- 同一测试连跑 3 次，任一失败即 Red。
- 环境缺失标 `blocked`，不算 Green。
- 不允许注释测试、降低阈值、跳过实机来变绿。

### 6.2 测试矩阵

| 层级 | 命令 | 何时 |
|---|---|---|
| 单元 | `python tests/run_tests.py`、`python tests/test_review_regressions.py`、新模块单测 | 每次提交 |
| 契约 | `node scripts/gen_config.cjs --check`、Lua/JS 几何向量、协议 schema | Gate 2 起 |
| 集成 | `python tools/integration_check.py`、`node --test tests/test_sar_*.cjs` | 每个 Gate |
| 回放 | `python tools/replay.py recordings/flight3-final.aesarec --dt 0.05 --seed 42` | Gate 1/2/4/5 |
| 实机 | 进 DCS、`compat_check`、页面烟测 | Gate 1/3/5/6 |
| 视觉 | 截图 + 检查清单 | Gate 4/5 |
| 性能 | 回放耗时、SAR 成像耗时、`/state` 大小 | Gate 2/4/5 |
| 部署 | `node --test tests/test_install_*.cjs`、生命周期 | Gate 6/7 |

### 6.3 功能指标

**A/A 核心**

- 回放帧数/时长/确认航迹数/ID 与基线一致。
- 不新增假航迹、不丢真实航迹；位置跳变 p95/max ≤ 基线 +10%。
- 检测原因分布、调度账本与基线一致或差异可解释。
- 同配置+同真值+同种子连跑 3 次完全一致。

**SAR**

- 图像尺寸、`quality`、`bandwidth`、`width` 与实际一致。
- dB 范围、量化、`no_data` 与协议一致。
- 点响应/PFA 指标在现有阈值内（FWHM <2%、位置 ≤0.2 m 等）。
- 拼接 `seq/generation` 正确；`/state` 摘要 <4 KB。
- MAP/DBS 失败可停/可重发；`span_requested_m`/`span_sampled_m` 可见。
- 视觉：mosaic 对齐、扇形锚点、DBS 提示正确。

**Export/协议**

- 10 Hz 采样，帧丢失 <1% 或与基线一致。
- A/T/O/L/E 行字段数正确；坏行 0。
- `CoalitionID ∈ {0,1,2}`；`vel_valid` 与真实 API 一致。
- `export_diag.log` 无 error/重连风暴。

**兼容层/原生**

- 当前 DCS build profile `verified`；能力矩阵每项有状态和原因。
- 缺失能力不返回假值。
- 原生符号/偏移/profile hash 匹配；不匹配只读；默认不注入。

### 6.4 证据与汇报

每个 Gate 结束写本机 `worklog/<YYYY-MM>/<YYYY-MM-DD>_<HHMM>_gate-<n>.md`（命名与结构以 `worklog/TEMPLATE.md` 和 `docs/testing-gates.md` §7 为准；`worklog/` 不入库）：

- 命令、环境（DCS build、Lua 路径、Node 版本）、commit；
- pass/fail/skip；
- 指标对照表；
- 删除/归档清单；
- 偏差与 Yellow 项；
- 最终判定 Green/Yellow/Red。

汇报顺序：影响 → 改动/删除 → 需确认 → 遗留。

---

## 7. 清理与归档纪律

### 7.1 文件分类

| 类别 | 位置/例子 | 处置 |
|---|---|---|
| 现役源码 | `src/`、`tools/`、`scripts/`、`tests/` | 保留；每个目录在 `docs/architecture.md` 有归属 |
| 生成物 | `src/adapters/dcs/rcs_data.lua`、`src/shared/*`、`src/native/generated/*` | 保留 + `DO NOT EDIT` + generator/hash |
| 历史 | `worklog/`、git history | 只读；不复制代码；`worklog/` 为 gitignored 本机数据 |
| 外部参考 | `docs/research/` | 只读；不参与构建 |
| 实验 | 顶层 `experiments/` 或 `aesa/archive/` | 自包含 + README + 日期；不参与构建 |
| 用户数据 | `recordings/`、`dist/dev/*.miz` | 不删；gitignore；清理前确认 |
| 第三方 | `src/native/third_party/minhook` | 保留 + LICENSE；不改造 |
| 删除候选 | `*_old`、`*_v2`、`*.bak`、`*copy*`、`tmp`、死配置、注释代码 | 删除；汇报中列出 |

### 7.2 每个 Gate 的清理

- Gate 0：盘点、文档地图、审计脚本；不批量删除。
- Gate 1：删除被修复替代的旧分支/旧字段/旧测试。
- Gate 2：删除旧常量、旧配置键、旧生成物；生成物加头。
- Gate 3：删除直接游戏 API 调用、两份 socket 自举、死版本/能力字符串。
- Gate 4：删除原 `src/aesa/` 内 DCS 文件、`default_rcs`、`rel_geo`、viewer 物理副本、旧内部字段测试（**已完成**）。
- Gate 5：删除旧 SAR 单文件、旧默认、旧 dB 路径、旧栅格方向、旧 viewer 物理。
- Gate 6：删除旧安装器重复逻辑、旧 ABI 常量、过时文档。
- Gate 7：删除所有临时 shim；archive 只保留有 README 的对照实现。

### 7.3 `audit_repo.cjs` 检查项

1. `git status --porcelain` 干净；未跟踪文件有归属。
2. 可疑文件名：`(_old|_new|_v[0-9]+|copy|backup|bak|tmp|deprecated)`。
3. `TODO|FIXME|XXX|HACK|DEPRECATED` 带 owner/日期。
4. 游戏 API 越界：`LoGet`、`terrain.`、`world.searchObjects`、`net.dostring_in`、`package.loadlib`、`lfs.` 只在 `src/adapters/dcs/api/`。
5. 重复常量：`299792458`、`0.03`、`3590/3592/3593/3594`、`128/17` 只在 `spec/`、生成物、测试 fixture。
6. 旧模块/旧符号引用无残留。
7. 文档：每篇有 `current|historical|external-reference|draft` 状态；无死链；有索引。
8. 生成物：generator/hash 与重生成一致。
9. 测试：skip 数量与原因；关键套件不允许静默跳过。
10. 工作区：`recordings/`、`__pycache__`、`dist/` 不被跟踪；`git clean -nd` 只列已确认临时文件。

### 7.4 删除与归档边界

- **随 Gate 直接删除**：被新模块替代的旧文件/旧常量/旧测试/注释代码；前提是 grep 无引用、测试 Green、汇报中列出。
- **先列清单等确认**：用途不明文件、跨目录批量删除、`recordings/`、`docs/research/`、`worklog/`、`third_party`、可能仍被外部部署引用的旧脚本。
- **归档**：只有需要对照的旧算法/实验进 `aesa/archive/<date>-<topic>/`，带 README、替代关系、移除条件；不参与构建。
- **部署侧旧文件**：同步更新安装器 manifest/备份/卸载，并用 `compat_check`/部署验证确认无残留加载。

---

## 8. 风险与回滚

| 风险 | 应对 |
|---|---|
| DCS 在重构期间更新 | Gate 0 固定 baseline；更新后先跑 `compat_check`，再决定是否更新 profile；不在 Red 状态继续迁移 |
| 大范围移动导致行为漂移 | 每个 Gate 做等价测试；移动与行为修改分开提交；失败回滚 tag |
| 原生写内存 | 默认只读；写路径独立 DLL；profile 校验；显式开关；失败 fail-closed |
| 实机环境不可用 | 标 `blocked`，不算 Green；离线可继续的部分继续，但发布/实机 Gate 未过不能宣布完成 |
| 范围膨胀 | 本轮只覆盖已有实现；新功能/发布验证单列；Gate 边界可停，但不得留半迁移状态 |
| 清理误删 | 常规替换删除随 Gate 完成；批量/不明/用户数据先确认；archive 带 README |

回滚规则：

- 每个 Gate 开始打 tag。
- Gate 内用分支；失败 `git reset --hard <gate-tag>` 或 revert。
- 连续两次修复仍 Red → 回滚并重新评估方案，不持续打补丁。

---

## 9. 第一批提交（Gate 0–1）

1. `docs: architecture/conventions/dcs-compat/testing-gates + baseline tag`
2. `test: unified test runner + audit_repo`
3. `fix(rcs): missile fallback + schema test`
4. `fix(export): CoalitionID + real-shape stubs`
5. `fix(export): LoGetVectorVelocity + vel_valid + single velocity normalizer`
6. `fix(sar): manual map abort/retry semantics`
7. `fix(sar): canonical MAP grid + grid_layout`
8. `fix(core): elevation bar spacing validation`
9. `fix(core): deterministic target/track ordering`
10. `fix(sar): effective quality metadata + ParticleEffect/MAPSURFACE`
11. `fix(native): readable() bounds + default read-only`
12. `spec: protocol.json + generator skeleton (ports/footprints)`

---

## 10. 完成标准

本轮完成时，以下全部成立：

1. **核心无 DCS 语义**：`src/core` 不出现 DCS 机型名、`visible`、`Heading + π/2`、`LoGet*`。
2. **游戏 API 单点**：`src/adapters/dcs/api/` 之外无直接游戏 API。
3. **参数单源**：`spec/` 是唯一来源；生成物可复现；改一个值只改一处。
4. **SAR 核心独立**：`src/sar_core` 无 DCS/服务/HTTP 依赖；`tools/sar_service` 只编排。
5. **服务可测**：`sar_live.cjs` <300 行；Collector/Arbiter/Sessions/Sweep/Coverage/Mosaic/Recorder/HttpApi 有单测。
6. **显示只读结果**：viewer 不重算物理；`/state` 只回摘要；图像走独立端点。
7. **原生安全默认**：只读默认；写路径独立、显式、profile 校验；不匹配 fail-closed。
8. **测试门禁**：`test_all` Green；skip 有原因；`audit_repo` 零 error。
9. **零残留**：无 `_old`/`_v2`/`copy`/`bak`/`tmp`；旧路径已删；archive 有 README；`git status` 干净。
10. **演示仍可用**：A/A 实时/回放、SAR 出图、Export 采样、场景桥在实机或录制上通过。

---

## 11. 本轮不包含

- 3b/3c 座舱页面、窗口贴附、帧内渲染。
- MP 完整性校验、服务端兼容、长期运行稳定性。
- 发布打包、签名、分发、版本号策略。
- 新雷达模式、新数据源、多雷达/多实例。
- 完整测量噪声模型（只留接口）。
- 超出"不退化"的性能优化。

这些在 Gate 7 完成后单独排期，不混入本轮重构。

---

## 附录 A：常用命令

```bash
# 核心
python tests/run_tests.py
python tests/test_review_regressions.py

# SAR / 安装
node --test tests/test_sar_*.cjs
set AESA_LUA=<DCS>\bin\luae.exe
node --test tests/test_install_sar.cjs tests/test_install_sar_scene.cjs

# 原生（需要 DCS bin）
python tests/test_agradar_probe_dll.py
python tests/test_fc_probe_dll.py

# 回放
python tools/replay.py recordings/flight3-final.aesarec --dt 0.05 --seed 42

# 重构后新增
node scripts/test_all.cjs
node scripts/audit_repo.cjs
node scripts/gen_config.cjs --check
node scripts/compat_check.cjs --detect --diff tests/baseline/compat.json
```

## 附录 B：文件迁移表

下表记录迁移前 → 目标位置；Gate 4 的 A/A 行已完成（原 `src/aesa/` 已删除）。其余行仍是后续 Gate 的计划。

| 迁移前位置（历史） | 目标位置 | 处理 |
|---|---|---|
| `src/aesa/truth_replay.lua` | `src/adapters/dcs/truth_replay.lua` | 移动；核心只留接口（已完成） |
| `src/aesa/rcs.lua` | `src/core/rcs.lua` + `src/adapters/dcs/rcs.lua` | 拆接口/DCS 分类（已完成） |
| `src/aesa/rcs_data.lua` | `src/adapters/dcs/rcs_data.lua` | 移动；加生成头（已完成） |
| `src/aesa/physics.lua` | `src/core/{physics,geometry,beam,detection,constants}.lua` | 拆分；去 DCS 语义（已完成） |
| `src/aesa/core.lua` | `src/core/core.lua` + `snapshot.lua` | 加 snapshot；sink 契约（已完成） |
| `src/export/aesa_export.lua` | `src/export/{aa_sampler,aa_protocol,aa_transport}.lua` + `adapters/dcs/api/export.lua` | 拆采样/协议/传输/API |
| `src/export/aesa_sar_export.lua` | `src/export/{sar_protocol,sar_collector,sar_transport}.lua` + `adapters/dcs/api/export.lua` | 拆协议/状态机/传输/API |
| `src/scene/aesa_sar_mission.lua` | `src/scene/{sar_scene_core,sar_mission_env}.lua` | 拆纯逻辑/任务 API |
| `src/hooks/*.lua` | `src/hooks/*` + `adapters/dcs/api/hook.lua` | 只留生命周期/桥接 |
| `tools/sar_{engine,surface,pfa,pulses,scattering,map,pool,worker}.cjs` | `src/sar_core/*` | 迁移物理；服务只编排 |
| `tools/sar_live.cjs` | `tools/sar_service/*` + 薄 CLI | 拆分；<300 行 |
| `tools/live.py` / `receiver.py` / `replay.py` | `tools/{lua_host,protocol,ingest,truth}.py` + 薄 CLI | 共用协议/ingest |
| `tools/sar_viewer.html` / `tools/viewer/index.html` | 原位置 | 只消费 snapshot/metadata |
| `scripts/install_*.cjs` / `install_export.py` | `scripts/install_common.cjs` + 产品脚本 | 统一 manifest/备份/事务 |
| `src/aesa/config.lua` | `spec/*.json` + `src/shared/config.lua` | 单源；核心注入（Gate 2 已完成） |

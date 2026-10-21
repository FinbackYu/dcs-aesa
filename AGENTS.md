# aesa 项目开发约定

目标：原理级 AESA 雷达仿真核心 + DCS 集成。本文件是本仓库的权威约定；背景论证见 `docs/feasibility.md`，当前架构重构的执行计划见 `docs/refactor-plan.md`。

当前为早期开发阶段。源码已公开托管在 GitHub（https://github.com/FinbackYu/dcs-aesa），但暂无发布包计划：日常开发和修复保留在源码、测试与文档中，不生成发布包或添加自动打包流程；用户明确安排发布后再按发布约定出包。现有部署脚本只用于开发验证，部署前检查 Lua 5.1 语法并保留用户文件。

2026-10-17 起进入架构重构，Gate 0/1/2/3 已完成；Gate 3（DCS 兼容层）已完成并通过实机烟测（probe level B）；Gate 4（A/A 边界）已完成（`test_all` 9/9 套件、463 项通过，flight3/flight9 各连跑 3 次一致且与基线逐项相同）；Gate 5（SAR 边界）已完成（`test_all` 9/9 套件、464 项通过；SAR 图像基线 detail/area 锁定；D3 `/state`/`/image` 契约落地）。Gate 6（原生/部署/文档）已完成代码与离线验证：`fc_trace`/`fc_inject` 双构建、默认只读、`install_common`/`build_common` 统一、审计 0 finding、`test_all` 9/9 套件 480 项通过。真实 Saved Games 烟测已通过：FC trace 13/13 hooks、默认只读、`inject-dll-absent` 回退；AGR 只 deferred 一次后 loaded；A/A 739 帧 / 76.72 s（9.63 Hz）；场景桥 `CAP,land.getSurfaceType,world.searchObjects,...`。SAR Export 的 `connected` 行未落 `dcs.log`（Export 态 log 不可用），但服务与场景桥均正常；作为观察性缺口记入 worklog。Gate 6 据此判 Green。Gate 7（全量回归与收口）已完成：`test_all` 3 次各 483 项通过、0 失败/0 skip；flight3/flight9 回放各 3 次逐字节一致且与 Gate 0 基线逐项 0 差异；SAR detail/area 与基线 0 差异，512 m 图像矩阵 3 次一致，2048 m smoke 通过；修复 `build_runtime` 漏发 `profile_data` 导致 SAR Export 从未安装、空白 `Export.lua` 卸载残留、`compat_check` 旧 RCS 路径与 probe 日志路径；实机 A/A 1186 帧/123.177 s（9.628 Hz）、SAR `connected; height=true surface=true`、FC trace 13/13 hooks/默认只读、AGR loaded；`compat_check` level B（required 全 ok）。tag `arch-refactor-complete`。Gate 定义、三色判定与退出条件以 `docs/refactor-plan.md` 和 `docs/testing-gates.md` 为准；每个 Gate 的判定与证据在 `worklog/`。2026-10-19 起进入 3b：以覆盖 F-16C 原 `PAGE_FCR_AA` 的方式实现 AESA A/A 页，C1 页面/文件桥/安装器已完成离线验证；C1.5 已完成：显示层预览按原生 FCR A/A 页坐标重画、Lua 页与 controller 同步新布局（299 元素）、真实数据桥 `tools/cockpit_bridge.py`（核心 snapshot → `state.txt` 10 Hz）接入 `live.py --cockpit-state`；实机首飞发现参数绑定缺陷（元素全停默认值、NO DATA 常亮）与版面偏差。C1.6 已完成：根因定位为 `Add()` 后才赋 `element_params`/`controllers`（引擎只在 Add 时绑定）+ 参数未在页面构建前预声明；页面改原生简写绑定（文本裸参数名 controller、等值门控、moved 预 Add 构建）、顶行改用 `add_PB_label`（`{x,237}` + SOI 框缺口遮罩）、量程三角换原生 `Decrement-symbol`、M4 归位 `{-235,-145}`；controller 与 device_init 注册块双预声明 87 参数（测试锁定三方一致）；预览与文档同步，已装机待飞验。设计见 `docs/design-cockpit-page.md`。

## 目录（当前实际结构）

- `spec/`：单一事实源（physics/radar/sar/protocol/deployment/display JSON）；`scripts/gen_config.cjs` 生成 `src/shared/config.lua`、`src/shared/protocol.lua`、`src/shared/config.cjs`、`src/native/generated/config.h`。改参数先改 spec，再 `node scripts/gen_config.cjs --write`，`--check` 必须零 diff。
- `src/shared/`：生成配置（`config.lua`、`protocol.lua`、`config.cjs`）与手写 `config_validate.lua`；`src/sar_core/`：纯 JS SAR 核心，含 canonical 场景/MAP 几何（`geometry.lua/.cjs`）。
- `src/adapters/dcs/`：DCS 适配层。`frame.lua` 是 DCS 世界系 ↔ 核心 ENU 的唯一转换点；`truth_replay.lua`（录制回放 TruthSource）、`rcs.lua`（DCS 机型分类）、`rcs_data.lua`（生成物，`scripts/extract_rcs.py`）承担 A/A 适配；`sar_adapter.cjs` 收口 SAR 的 DCS 词汇（footprint、地表词表、对象 kind、场景校验；DBS 的 `radar.fx` 算法出处注释留在 `src/sar_core/map.cjs`）；`api/{export,mission,hook,native,socket}.lua` 收口游戏 API；`compat/profile.lua`、`probe.lua` 与 `profiles/*.lua`（生成物）提供能力矩阵；`src/native/abi/dcs_profile.h` 是生成的原生 ABI 表。Gate 3 已完成：实机 probe level B（required 全 ok），烟测通过；消费方通过 `scripts/build_runtime.cjs` 生成的单文件 bundle 读取 `AESA_RUNTIME`，不再直接调用游戏 API。
- `src/core/`：纯 A/A 仿真核心（Lua 5.1 子集，无 DCS 依赖）：`constants`（物理常量/单位换算/可种子 RNG）、`physics`（雷达方程/检测统计）、`beam`（扫描角/方向余弦门/主瓣因子）、`detection`（脉冲遮蔽/盲区/notch/assess）、`geometry`（ENU 机体基/相对测量/世界点/视距）、`scheduler`、`tracker`、`measurement`（MeasurementModel）、`rcs`（接口）、`snapshot`（稳定显示 DTO）、`core`、`init`；配置由 `init.build` 从 `src/shared/config.lua` 加载或注入。`src/aesa/` 已在 Gate 4 删除。
- `src/export/`：DCS Export 侧薄采样：`aesa_export.lua`（A/A V1 行协议 → TCP 3590）；SAR 侧由 `aesa_sar_export.lua`（入口）+ `sar_protocol.lua`（线协议/几何白名单）+ `sar_dcs_env.lua`（能力与地形查询）+ `sar_collector.lua`（命令状态机）+ `sar_transport.lua`（TCP 生命周期）组成，部署时打成 `AESA_SAR` bundle。
- `src/scene/`：任务内场景桥：`aesa_sar_mission.lua`（入口）、`sar_mission_env.lua`（mission API 适配）、`sar_scene_core.lua`（场景/GMTI 序列）。
- `src/hooks/`：Saved Games `Scripts/Hooks` 加载器：`aesa_sar_scene_hook.lua`、`aesa_agradar_hook.lua`、`aesa_fc_hook.lua`。只负责生命周期与桥接，不承载业务物理。
- `src/native/`：进程内原生组件（C，经 `package.loadlib` 载入 DCS 进程）：
  - `agradar_probe/`：只读地表类型/掩码探针，导出 `aesa_agradar_profile_check` 做 profile 自检；
  - `fc_probe/`：单一 C 源、两个构建：`aesa_fc_trace.dll`（`AESA_FC_TRACE_ONLY`，只读 trace）与 `aesa_fc_inject.dll`（trace 超集 + arm/disarm/feed_target）；同一时刻只加载一个（见下文安全边界）；
  - `third_party/minhook/`：第三方 MinHook，保留原 LICENSE，不改造。
- `tools/`：SAR 服务/显示与 A/A 外部工具：
  - `sar_service/`：SAR 服务模块（collector/arbiter/map_session/dbs_session/sweep_planner/coverage_index/mosaic_store/recorder/http_api/service）；`sar_live.cjs` 只是 CLI 组合根；
  - `sar_bridge.cjs`（场景桥客户端）、`sar_demo_scene.cjs`（确定性合成场景）；SAR 物理已在 `src/sar_core/`，JS 生成配置在 `src/shared/config.cjs`；
  - 顶层 Python 工具：`live.py`、`receiver.py`、`replay.py`、`integration_check.py`、`fc_trace_report.py`（当前没有 `tools/python/` 子目录；重构目标见 `docs/refactor-plan.md`）；
  - 显示：`sar_viewer.html`、`viewer/index.html`。
- `scripts/`：数据提取（`extract_rcs.py`）、原生构建（`build_common.cjs` + `build_fc_probe.cjs`/`build_agradar_probe.cjs`/`build_compat_probe.cjs`）、部署/卸载（`install_common.cjs` + 产品安装器）、任务生成与可复现离线实验（`sar_*_probe.cjs`）。原生构建使用仓库内 `.tools/mingw-root` 的 mingw-w64 gcc（也兼容上层工作区的 `.tools/mingw-root`）；首次引导 `python scripts/bootstrap_mingw.py`（工具链约 1 GB，gitignored）。
- `tests/`：Python + lupa、Node `node:test`、Lua 5.1 集成与原生 DLL 冒烟测试。
- `docs/`：设计、理论、兼容、测试与重构文档；`docs/research/` 为外部调研（只读，不参与构建）。
- `dist/`：本机构建/发布产物，`.gitignore` 忽略（仅 `.gitkeep` 入库）；`dist/dev/` 放 DLL 与测试任务。
- `recordings/`：实飞录制、SAR 快照与实验产物（用户数据，gitignored，清理前必须确认）。
- `worklog/`：历史工作日志（只读存档，不复制其中代码到现役路径）；`.gitignore` 忽略，**只存在于本机，不入库**。

`src/core/` 已于 Gate 4 建立；`src/sar_core/` 与 `tools/sar_service/` 已于 Gate 5 建立；Gate 6 已建立 `src/native/fc_probe` 的 trace/inject 双构建（同一 C 源、两个 DLL）、`scripts/build_common.cjs` 与 `scripts/install_common.cjs`；Gate 2 已建立 `spec/`、`src/shared/`、生成物；Gate 3 已建立 `src/adapters/dcs/` 与 runtime bundle；Gate 4 已建立 `src/core/` 并把 DCS 帧/RCS/回放收口到 `src/adapters/dcs/`；Gate 5 把 SAR 物理收口到 `src/sar_core/`、服务拆到 `tools/sar_service/`、DCS 词汇收口到 `src/adapters/dcs/sar_adapter.cjs`。**不得提前在旧路径旁新建半套实现**。

## 架构边界（Gate 0 已定决策）

- **D1 帧模型**：核心使用通用 ENU 右手系（x 东、y 北、z 上）；DCS 的 `x/z/y`、`heading=0 → -Z`、MSL 高度只在 `src/adapters/dcs/frame.lua`（Gate 4 已落地）转换。核心不得出现 DCS 坐标语义、`Heading + π/2`、机型名或 `visible`；旧 V1 录制的航向偏移也只由该文件按 `legacy_heading` 修正。
- **D2 SAR 核心**：SAR 物理迁入 `src/sar_core/` 纯 JS（无 DCS API/坐标/机型语义；`radar.fx` 的算法出处只作注释；无 HTTP、无文件系统）；`tools/` 只做适配、服务与显示。迁移前，`tools/sar_*.cjs` 仍是唯一现役实现。
- **D3 `/state` 契约**：只回摘要 + `resultSeq`；图像走 `/image/<seq>` 或 `/snapshot`；viewer 在 `completed` 变化时拉图，不重算物理。
- **D4 原生读写拆分**：`fc_trace`（只读）与 `fc_inject`（写）分开，默认只读；写路径必须显式配置 + profile 校验 + 备份/回滚。Gate 6 已落地：同一 `aesa_fc.c` 用 `AESA_FC_TRACE_ONLY` 编译 trace（导出表无写函数），inject 为 trace 超集；两者不得同时加载。
- 依赖方向：`src/core` 不 import 游戏适配/服务/文件系统；`src/sar_core` 不 import `tools/`、桥接或 viewer；`tools/` 不得反向定义物理；viewer 只消费 snapshot/metadata。
- 游戏 API 只能出现在 `src/adapters/dcs/api/`（`LoGet*`、`terrain.*`、`world.*`、`land.*`、`net.dostring_in`、`package.loadlib`、`lfs`）。Gate 3 已完成消费者切换：`src/export/`、`src/scene/`、`src/hooks/` 通过 `AESA_RUNTIME` 调用 `api/*`。FC 实验的 mission payload 是字符串载荷（在 mission 状态执行），不是 Hooks 侧 API 调用；除它之外不得新增其他例外。

## 编码纪律

1. **Lua 5.1 兼容子集**：不用 5.2+ 特性（goto、整除、`_ENV`、位运算符）；兼容 LuaJIT。
2. **纯核心**：核心模块不碰 `os/io/require`（模块加载只发生在入口）；随机数用注入的可种子发生器；时间只认调用方传入的 `dt`。
3. **配置驱动**：雷达参数、PRF 档、回访率、扫描锥、SAR footprint/带宽等都必须有单一来源并注明来源（官方数据 / 公开估计【假设】/ 项目设定）。Gate 2 起统一到 `spec/` 生成物，禁止在业务模块再写第二份常量。
4. **数据政策**：目标侧数据（位置/速度/RCS）锚定 DCS 官方；自建假设必须显式标注并可开关；未覆盖机型用分档兜底值并标注估计。
5. **测试**：每个 bug 先写失败测试再修；测试断言与 `docs/theory-notes.md` §9 的 T1–T10 对应；不注释测试、不降低阈值、不跳过实机来“变绿”。
6. **确定性**：同一配置 + 同真值 + 同种子连跑 3 次结果一致；随机消费与航迹/目标排序不得依赖 `pairs` 遍历顺序。
7. **零残留**：不留 `_old`/`_new`/`_v2`/`copy`/`backup`/`*.bak`/`tmp`；不用注释保留旧路径；临时 shim 必须登记到根目录 `DEPRECATIONS.md`，并在登记的下一个 Gate 删除。

## 测试与跳过规则

Gate 0 起统一入口（两个脚本均于 Gate 0 引入）：

```bash
node scripts/test_all.cjs         # 跑 Python/Node/Lua/原生套件，报告 pass/fail/skip 与 skip 原因
node scripts/audit_repo.cjs       # 残留、重复常量、游戏 API 越界、旧引用、文档状态审计
node scripts/capture_baseline.cjs # Gate 0 基线摘要/哈希；只写 tests/baseline/，不复制录制/图像/矩阵
```

`test_all` 覆盖 11 个套件：`python tests/run_tests.py`、`python tests/test_review_regressions.py`、`python tests/test_cockpit_bridge.py`（座舱状态桥 snapshot→state.txt）、`python -m unittest discover -s tests -p "test_gate*.py"`（Gate 回归）、`node --test tests/test_gate*.cjs`（Gate Node）、`node --test tests/test_sar_*.cjs`、`node --test tests/test_viewer_vectors.cjs`、`node --test tests/test_cockpit_page.cjs`（座舱页 Lua 桩/安装器/参数绑定纪律，需 Lua 5.1）、Lua 5.1 部署生命周期套件（`test_install_sar/scene/fc/agradar`，有 `AESA_LUA`/DCS `luae.exe` 时）与两个原生 DLL 套件（DCS bin 与 `dist/dev/*.dll` 可用时；否则 skip 并给出原因）。当前为 500 项通过（Gate 7 收口时为 483；新增接收器流式回归后 484；新增座舱 C1 3 项后 487；新增座舱状态桥 12 项后 499；C1.6 座舱参数绑定三路一致回归后 500）。回放、SAR 基线由 `capture_baseline.cjs` 单独生成，不在 `test_all` 内。

`tests/baseline/` 保存 Gate 0 基线摘要与 `audit-baseline.json` allowlist（只存 JSON/哈希，不存大图）。基线数字以 `test_all`/回放实际输出为准；`--update-baseline` 只在 Gate 0 首次建基线使用，之后修问题时收紧 allowlist，不得手改计数来“变绿”。`test_all` 可用 `AESA_PYTHON` / `AESA_DCS_BIN` / `AESA_LUA` 覆盖环境探测。

单项命令（Git Bash；Windows `cmd` 下通配符不展开，优先用 `test_all`）：

```bash
# A/A 核心（需要 lupa.lua51）
python tests/run_tests.py
python tests/test_review_regressions.py

# SAR 与显示
node --test tests/test_sar_*.cjs
node --test tests/test_viewer_vectors.cjs

# 部署/Lua 5.1 集成（未设置 AESA_LUA 时相关用例 skip）
export AESA_LUA="<DCS>/bin/luae.exe"
node --test tests/test_install_sar.cjs tests/test_install_sar_scene.cjs tests/test_install_fc.cjs tests/test_install_agradar.cjs

# 原生探针（先构建；DLL 位于 dist/dev/，不入库）
node scripts/build_agradar_probe.cjs
node scripts/build_fc_probe.cjs
python tests/test_agradar_probe_dll.py
python tests/test_fc_probe_dll.py

# 回放基线（需要 recordings/ 本机数据）
python tools/replay.py recordings/flight3-final.aesarec --dt 0.05 --seed 42
```

Skip 规则：

- **缺 `lupa`**：`python tests/run_tests.py` / `test_review_regressions.py` 不能运行，标 `blocked`，不是 skip、不是 Green；先 `pip install lupa`。
- **缺 Python**：`test_all` 的 Python 套件直接 fail（不静默跳过）；先安装 Python 或设置 `AESA_PYTHON`。
- **未设置 `AESA_LUA`**：`test_install_sar*.cjs` 的 Lua 5.1 用例 skip 并打印原因；要判定部署回归 Green，必须设置到 DCS 自带 `luae.exe` 后重跑。
- **原生 DLL 未构建**：直接运行 `test_*_probe_dll.py` 会以非零退出（提示先构建），按失败处理；`test_all` 会把该套件标 skip 并给出原因。skip 不算 Green，先构建再跑。
- **缺 `luae.exe`/`lua.dll` 或 DCS bin**：`test_all` 跳过原生套件并给出原因；直接运行 `test_agradar_probe_dll.py` 时只跳过需要真实 Lua state 的用例，其余 ctypes 用例仍须通过。原生验证不能以 skip 计入 Green。
- **缺 `recordings/` 或指定录制**：回放基线无法执行，标 `blocked`；不能据此宣称 A/A 无退化。
- **DCS 未运行 / 无 Saved Games**：实机、场景桥和部署生命周期门禁标 `blocked`；离线套件可继续，但不得宣布该 Gate 完成。
- 所有 skip 必须由 `test_all` 汇总实际原因；关键套件（Lua 核心、SAR、安装、原生）不允许静默跳过。环境缺失不等于通过。
- 同一测试连跑 3 次，任一失败即 Red（flaky 也算 Red）。

## DCS 兼容层与游戏更新流程

当前位置（Gate 3/4 已建立）：

- `src/adapters/dcs/api/{export,mission,hook,native}.lua`：所有游戏 API 的唯一入口。
- `src/adapters/dcs/frame.lua`：DCS 世界系 ↔ 通用 ENU 的唯一转换点（D1）。
- `src/adapters/dcs/compat/{profile,probe}.lua` + `profiles/dcs-<build>.lua`：build/module 字段、能力、回调 quirk、地形/任务/原生能力。
- `src/native/abi/dcs_profile.h`：由 profile 生成的原生符号/偏移/export hash 表；启动自检，不匹配 fail-closed。
- `scripts/compat_check.cjs`（Gate 3）：`--record baseline` / `--detect --diff baseline`，输出能力矩阵与差异，退出码区分完全兼容/降级/不兼容。

游戏更新后的固定流程：

1. 停飞、记录旧 build 与 commit；确认 `git status` 干净，必要时先打 Gate tag。
2. 更新前用 `compat_check --record baseline` 留档（Gate 3 起；此前用当前测试与日志人工留档）。
3. 更新 DCS 后先跑 `compat_check --detect --diff <baseline>`，检查字段形态、回调、任务能力、原生符号/偏移、RCS 数量、地表词表、`radar.fx` hash。
4. 只在 profile/数据层修兼容，不改业务物理；缺能力必须 fail-closed：缺 `CoalitionID` → `unknown`，缺速度 → `vel_valid=false`，缺可见性 → `unknown`，缺 `dostring_in` → 场景桥 `unavailable`，缺 `GetHeight` → SAR 拒绝，原生 profile 不匹配 → 只读。
5. 重跑 `node scripts/test_all.cjs`、`node scripts/audit_repo.cjs` 与实机烟测（Export 10 Hz、日志无 error、场景桥能力正确、原生默认只读），结果写入当次 Gate worklog。
6. 连续两次修复仍 Red：回滚到 Gate tag，重新评估方案，不带着不匹配的 profile 继续迁移。

原生 ABI 只对已验证 build 生效。当前 `aesa_fc.c` 的符号/偏移（如 `wGP_AMRAAM+0x1a8/+0x1c0/+0x220`）按 DCS 2.9.30.28738 实测；换 build 必须重新验证并更新 profile，禁止沿用旧偏移硬跑。

## `fc_probe` 安全边界（当前事实）

`src/native/fc_probe/aesa_fc.c` 是一份 C 源、两个构建：

- **`aesa_fc_trace.dll`（默认）**：定义 `AESA_FC_TRACE_ONLY`，只编译只读 trace。MinHook detour 记录 datalink 收发、武器分配/跟踪、`setTarget`、导弹制导 tick（共 13 个站点）；OBJD 以只读方式采样对象内存并做差异日志。导出表**没有** `aesa_fc_arm`/`aesa_fc_disarm`/`aesa_fc_feed_target`。日志在 `Saved Games\DCS\Logs\AESA\`。
- **`aesa_fc_inject.dll`（显式可选）**：trace 超集，额外导出写路径。`aesa_fc_arm(mode, target)` 在 `mode=1` 时把首枚自导导弹的 `setTarget(0)` 改写为指定 ObjectID；`aesa_fc_feed_target("px,py,pz,vx,vy,vz")` 在制导 tick 前把前置瞄准点写入 `wGP_AMRAAM+0x220`。只有安装时传 `--with-inject` 才会部署。
- 两个 DLL 都装 MinHook detour，**同一时刻只能加载一个**；hook 先 `trace_stop`/`shutdown` 再切换。

加载策略（`src/hooks/aesa_fc_hook.lua`）：默认只加载 trace。只有同时满足以下条件才加载 inject：`fc_experiment.lua` 显式 `mode=1`（非法值强制 0）、profile 非 fallback、`NAT-FC-SYM=ok`、`native.fc.write=true`、inject DLL 存在且写导出齐全；`feed=1` 还要求 `aesa_fc_feed_target`。任一条件失败写日志并回退 trace/只读，绝不在 trace 上尝试写。目标名 `FC-TRACE-BANDIT-2`。

安全边界：

- 只用于**单机开发任务**；禁止在多人服务器、竞技或任何完整性校验环境使用。
- 只写 `Saved Games\DCS\Scripts\` 与 `Logs\`，不写 DCS 安装目录；部署必须走 `scripts/install_fc_probe.cjs`（manifest/hash/备份/拒绝覆盖未知文件；旧 `aesa_fc.dll` 按旧 hash 识别后迁移）。
- 注入只在具名实验目标存在、`mode=1` 且 `feed`/arm 条件满足时触发；默认部署即只读，不需要额外配置。需要注入时必须显式写 `fc_experiment.lua` 并确认任务与目标名。
- 偏移与符号是 build 相关的，只对已验证 build 使用；不匹配或无法确认时只读运行，不尝试写入。
- Gate 1 已完成：hook 默认 `mode=0`，`readable()` 校验完整页范围。Gate 6 已完成 trace/inject 拆分与导出表静态守卫；写路径仍要求显式配置 + profile 校验 + 备份/回滚。
- `aesa_agradar` 地表探针是只读路径，不在此列。

## 兼容探针（dev，一次性）

源码仍是 `api/*.lua`、`profile.lua`、`probe.lua`、`entry_bundle.lua`；部署时由 `scripts/build_compat_probe.cjs` 打成**一个文件** `dist/dev/aesa_compat_probe.lua`。

```bash
node scripts/build_compat_probe.cjs
node scripts/install_compat_probe.cjs install --saved-games "<Saved Games>" --lua "<DCS>/bin/luae.exe"
node scripts/install_compat_probe.cjs verify --saved-games "<Saved Games>"
node scripts/install_compat_probe.cjs uninstall --saved-games "<Saved Games>"
```

安装器只写 `Scripts/AESA/aesa_compat_probe.lua`、manifest 和 `Export.lua` 的独立标记块；Hook 有两个 `run_compat_probe()`，文件不存在时 no-op。实机跑完后用 `compat_check --record/--detect --diff` 采集基线。**该探针仅开发者 / DCS 更新诊断使用，不属于用户部署清单；开源用户不需要安装，发布文档不得把它列为必需步骤。** 当前开发机保留安装；2026-10-18 实机 probe 达到 **level B**（required 全 ok），日志在 `Scripts/AESA/probe-export.log` / `probe-hook.log`；消费者 bundle 已切换并通过实机烟测（A/A 313 帧 / 32.6 s、SAR `connected; height=true surface=true`、scene `CAP,land.getSurfaceType,world.searchObjects`），已打 `gate-3-complete`。

## 清理与归档纪律

| 类别 | 位置/例子 | 处置 |
|---|---|---|
| 现役源码 | `src/`、`tools/`、`scripts/`、`tests/` | 保留；归属见 `docs/architecture.md` 与 `docs/file-inventory.md` |
| 生成物 | `src/adapters/dcs/rcs_data.lua`、`src/shared/*`、`src/native/generated/*`、`dist/dev/*` | 保留 + `DO NOT EDIT` + generator/hash；可重建产物不入库 |
| 历史 | `worklog/`、`docs/status.md`、`docs/review-fixes.md` | 只读存档；不复制代码，不再更新结论；`worklog/` 为 gitignored 本机数据，不提交 |
| 外部参考 | `docs/research/` | 只读；不参与构建；不批量删除 |
| 实验 | 顶层 `experiments/`（本仓库目前无）、`scripts/sar_*_probe.cjs`、`recordings/sar-preview/` | 可复现实验保留；一次性产物归档或确认后删除 |
| 用户数据 | `recordings/`、`dist/dev/*.miz` | 不删；gitignore；清理前确认 |
| 第三方 | `src/native/third_party/minhook/` | 保留 + LICENSE；不改造、不批量删除 |
| 删除候选 | `*_old`、`*_v2`、`*.bak`、`*copy*`、`tmp`、`__pycache__`、死配置、注释代码 | 只列清单；在计划 Gate 删除并汇报 |

- Gate 0 只盘点、不批量删除。Gate 1–7 的删除范围见 `docs/refactor-plan.md` §7.2。
- 被替代的旧路径在同一 Gate 内删除；确需临时 shim 时登记 `DEPRECATIONS.md`（日期/旧文件或符号/替代/计划删除 Gate/负责人），到期必删。
- 归档只允许需要对照的旧算法/实验，目录为 `aesa/archive/<date>-<topic>/`，必须带 README（替代关系、移除条件、日期），且不参与构建。
- 不提交：`recordings/`、`worklog/`、`__pycache__`、`dist/*`（`.gitkeep` 除外）、日志、缓存、本机专属路径配置。
- 每个 Gate 结束写本机 `worklog/<YYYY-MM>/<YYYY-MM-DD>_<HHMM>_gate-<n>.md`（按 `worklog/TEMPLATE.md` 五段结构，不提交），并在 `worklog/index.md` 追加一行；记录命令、环境、commit、pass/fail/skip、指标、删除/归档清单与 Green/Yellow/Red 判定。

## Gate 规则

- Gate 顺序：0 基线/文档/盘点 → 1 正确性止血 → 2 契约与单一事实源 → 3 DCS 兼容层 → 4 A/A 边界 → 5 SAR 边界 → 6 原生/部署/文档 → 7 全量回归与收口。不得跳 Gate，不得留半迁移状态。
- **Green**：构建/加载成功；必跑测试全过；指标在基线容差内；无新增 warning；审计无 error。才进入下一 Gate。
- **Yellow**：只有非关键偏差，且有 owner/日期/说明；进入下一 Gate 前清零或经用户确认接受。
- **Red**：崩溃/挂起、数据错误、物理偏差超容差、协议/字段不匹配、原生符号/偏移不匹配、确定性破坏、flaky、审计 error。停线，补失败测试，修复后重跑整个 Gate。
- 环境缺失标 `blocked`，不算 Green；不允许用注释测试、降阈值、跳过实机来变绿。
- 每个 Gate 开始打 tag；失败可回滚到该 tag；连续两次修复仍 Red 则回滚重评，不持续打补丁。

## 部署规则

- 发布包只从 `dist/` 出；当前早期开发阶段不生成发布包。
- 常规部署目标为 `%USERPROFILE%\Saved Games\DCS\`（或 `.openbeta`）。
- 对用户 `Export.lua` 采用带 `BEGIN/END` 标记的加载块，与 SRS/Tacview 等共存，提供修复与卸载。
- 深度集成（座舱页面、渲染 overlay）允许写入 DCS 安装目录，但必须：附文件清单、修改前自动备份、按清单精确还原、以 OvGME/JSGME 兼容格式打包、部署前做同名工具冲突检测。已知并接受：DCS 更新会还原改动、部分 MP 服务器完整性校验会拒绝。
- 当前开发部署脚本：`install_export.py`、`install_sar.cjs`、`install_sar_scene.cjs`、`install_fc_probe.cjs`、`install_agradar_probe.cjs`。均要求目标 Saved Games 已存在、拒绝覆盖未知/已修改文件、按 manifest 卸载；Gate 6 已统一到 `install_common.cjs`（`.bak-aesa` 备份、事务回滚、Lua 5.1 检查、DCS 运行检查）。FC 默认只装 trace，`--with-inject` 才装 inject。3b 座舱页另用 `install_cockpit.cjs --dcs-dir <DCS install>`，只写 F-16C 模块并按标记块/manifest 精确还原；这是安装目录深度集成，默认不随普通 Saved Games 部署安装。
- 不覆盖用户已有文件；不把本机路径、日志、缓存或游戏文件提交到版本控制。

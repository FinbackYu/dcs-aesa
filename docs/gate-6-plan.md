# Gate 6 实施计划：原生读写拆分、部署统一、审计清零与文档定稿

- 状态：current
- 日期：2026-10-18
- 起点：`3d9890a`（`master` 与 `refactor/architecture-gates` 同点，工作区干净）
- 依据：[refactor-plan §Gate 6](refactor-plan.md#gate-6原生部署文档)、[testing-gates §Gate 6](testing-gates.md#gate-6原生部署文档)、[AGENTS.md](../AGENTS.md) 的 D2/D4、Gate 规则与部署规则
- Gate 状态：Gate 0–5 已完成；Gate 6 未开始，`gate-6-start` 尚未打

## 0. 决策（已拍板）

| 编号 | 决策 | 理由 |
|---|---|---|
| D6-1 | **同一份 C 源编译两个 DLL**：`aesa_fc_trace.dll`（只读）与 `aesa_fc_inject.dll`（trace 超集 + 写路径）；同一时刻只加载一个 | 物理上保证 trace 无写导出，又避免两个 DLL 同时装 MinHook 冲突；满足 D4“只读/写分开” |
| D6-2 | **审计逐条清零**：把 `tests/baseline/audit-baseline.json` 的 allowlist 清到 0，`audit_repo --strict` 必须 0 finding；不改计数、不靠白名单 | 用户明确要求；Gate 6 G6-09 要求零 finding |
| D6-3 | **默认只部署/加载 trace**；`fc_inject.dll` 是显式可选项（安装器 `--with-inject`），hook 只在 `fc_experiment.lua` 的 `mode=1` 且 profile 通过时加载 inject | 默认只读必须是能力级，而不是配置级 |
| D6-4 | 不改变 A/A、SAR 物理与 `src/core`、`src/sar_core` 的数值路径 | Gate 6 是原生/部署/文档边界，不混入物理改动 |

## 1. 目标与退出条件

Gate 6 的退出条件（逐条对应 `testing-gates.md` G6-01..G6-10）：

1. `fc_trace`/`fc_inject` 拆分完成，默认只读；写路径需要显式配置、profile 校验、备份/回滚。
2. `aesa_agradar` 有 profile/version 自检；构建导出守卫包含 `aesa_fc_feed_target`（仅 inject）。
3. `build_common.cjs`/`install_common.cjs` 统一构建与部署逻辑。
4. FC/AGR/Export/SAR 安装器生命周期测试通过；无残留、不覆盖用户文件。
5. 备份后缀、事务、manifest/hash、`DCS*.exe` 检查统一。
6. 原生 DLL 构建/加载/卸载无崩溃；日志无 error。
7. 真实 Saved Games 烟测通过；默认只读；写路径未配置时不可达。
8. AGENTS/README/status/config-reference 与代码同步；无死链。
9. 全量测试/原生/生命周期各 3 次一致；`audit_repo --strict` 零 finding；`git status` 干净。
10. Gate 6 worklog 完成，判定明确。

## 2. 工作分解

### A. 原生 `fc_trace` / `fc_inject` 拆分（最高风险）

#### A1. 源码与编译开关

- 保留单一实现 `src/native/fc_probe/aesa_fc.c`，用编译宏切两个目标：
  - `AESA_FC_TRACE_ONLY`：不编译写路径（`g_force_mode`、`aesa_fc_arm`、`aesa_fc_disarm`、`aesa_fc_feed_target` 及 detour 内的写入分支）。
  - 默认（无宏）：trace + 写路径（inject 构建）。
- 两个 DLL 都保留：`aesa_fc_init`、`aesa_fc_poll`、`aesa_fc_shutdown`、`aesa_fc_version`、`aesa_fc_trace_start`、`aesa_fc_trace_stop`、`aesa_fc_readable`。
- 只有 inject 构建导出：`aesa_fc_arm`、`aesa_fc_disarm`、`aesa_fc_feed_target`。
- 构建后用 `objdump -p` 断言：
  - trace 必须**没有** `aesa_fc_arm/disarm/feed_target`；
  - inject 必须**有**这三个，且 `aesa_fc_feed_target` 在导出守卫清单内；
  - 两者依赖只允许 `KERNEL32/msvcrt/VERSION`（沿用现有检查）。

#### A2. 构建统一

- 新增 `scripts/build_common.cjs`：封装 `gcc()`、`run()`、`sources()`、`objdump` 导出/依赖检查、Lua `loadfile` 语法检查。
- `scripts/build_fc_probe.cjs` 保留为兼容 CLI，内部调用 `build_common` 生成两个 DLL：
  - `dist/dev/aesa_fc_trace.dll`
  - `dist/dev/aesa_fc_inject.dll`
- `scripts/build_agradar_probe.cjs` 改为薄封装，复用同一 gcc/objdump/依赖检查。
- 旧 `dist/dev/aesa_fc.dll` 不再由新构建产生；清理与迁移归入 A5/ Gate 6 清理项。

#### A3. spec、profile 与生成物

- `spec/deployment.json` 的 `products.fc`/`native` 增加：
  - `fc_trace_dll_name = "aesa_fc_trace.dll"`
  - `fc_inject_dll_name = "aesa_fc_inject.dll"`
  - 保留 `fc_dll_name` 作为历史别名或在同一 Gate 内删除（二选一，删除前先改所有 profile/测试）。
- `spec/deployment.json` 的 `sources` 指向 `src/hooks/aesa_fc_hook.lua` 与 `src/native/fc_probe/aesa_fc.c`；新增字段的 source 行要落在真实代码行。
- 生成 profile（`dcs-2.9.30.28738-mt.lua`、`dcs-generic.lua`）的 `native.fc` 增加：
  - `trace_exports`：只读集合（含 `aesa_fc_readable`）
  - `inject_exports`：只读集合 + 三个写导出
  - `write` 字段只允许 inject 使用；trace 的 `write=false`
- `scripts/gen_config.cjs` 生成上述字段；`gen_config --check` 零 diff。
- profile 的 `NAT-FC-SYM`/`NAT-FC-SITES` 校验逻辑保持；inject 另加 `NAT-FC-INJECT`（或等价能力位），未通过时拒绝加载 inject。

#### A4. Hook 加载策略

- [aesa_fc_hook.lua](../src/hooks/aesa_fc_hook.lua) 默认只加载 `Scripts/AESA-FC/aesa_fc_trace.dll`，解析 trace 导出集合。
- 只有同时满足以下条件才加载 inject：
  1. `Scripts/AESA-FC/fc_experiment.lua` 显式 `mode=1`（默认 0；非法值仍强制 0）；
  2. profile 不是 fallback，`NAT-FC-SYM=ok`，inject 能力位通过；
  3. inject DLL 存在、导出齐全、hash 与 manifest 匹配；
  4. `feed=1` 时 `aesa_fc_feed_target` 必须存在。
- 任一条件失败：写日志、回退 trace/只读，**不得**在 trace 上尝试写。
- 同一时刻只 `package.loadlib` 一个 DLL；先 `aesa_fc_trace_stop`/`shutdown` 再切换，避免双重 hook。
- `mode=1` 但 inject 未部署：日志明确“inject DLL absent; read-only”，不自动降级为“装 trace 也能写”。

#### A5. 安装器与旧部署迁移

- `install_fc_probe.cjs`：
  - 默认 `install/repair/verify` 只处理 trace DLL + hook + manifest；
  - `--with-inject` 才把 inject DLL 纳入 manifest；
  - `uninstall` 只删 manifest 记录的文件；旧 `aesa_fc.dll` 若被旧 manifest 记录，按旧哈希识别后备份并移除；未知文件拒绝覆盖/删除。
  - manifest 记录 `product: aesa-fc-trace`/`aesa-fc-inject` 或 `files[]` role，便于 verify 报告。
- 变更备份后缀前先做迁移说明；旧 `.bak-aesa-sar` 在 FC/场景 installer 中复用的问题随 `install_common` 统一（见 B）。
- 部署默认不装 inject；文档写明如何显式安装与回滚。

#### A6. 测试

- `tests/test_fc_probe_dll.py` 拆为两个断言组：
  - trace DLL：加载、init/poll/version/trace_start/stop/readable、日志；`ctypes` 访问 `aesa_fc_arm`/`feed_target` 必须失败；
  - inject DLL：加载、init/trace、arm/disarm/feed_target 可调用；日志；profile 不匹配时 hook 层 fail-closed（用 Lua 测试）。
- 新增静态守卫测试（Node）：`objdump`/PE 导出表检查 trace 无写导出、inject 有 `aesa_fc_feed_target`。
- 新增 `tests/test_gate6_native.py`（或等价）覆盖：默认只读、inject 未配置不可达、profile 不匹配拒绝、切换 DLL 不重复 hook、`aesa_fc_readable` 边界。
- 更新 `test_all` 的原生套件：trace 与 inject 两个 DLL 都跑；DLL 缺失时按既有权重 skip/fail。

### B. `build_common.cjs` / `install_common.cjs` 与部署统一

#### B1. `build_common.cjs`

- 统一 gcc 定位、PATH 处理、MinHook 源列表、`-O2 -Wall -Wextra -shared -static -static-libgcc` 参数、导出/依赖守卫。
- `build_fc_probe.cjs`、`build_agradar_probe.cjs`、`build_compat_probe.cjs` 复用；`build_runtime.cjs` 是否复用只做 gcc/Lua 检查，不强行合并 bundle 逻辑。

#### B2. `install_common.cjs`

提供单一实现：

- `hash(buffer)`、`backup(path)`、`transaction(writes)`（失败回滚）、`syntax(lua, path)`、`ensureDcsClosed()`（`DCS*.exe` 检查）、`manifest` schema 校验。
- 统一备份后缀（建议 `.bak-aesa`；旧 `.bak-aesa-sar` 只用于识别/卸载旧部署）。
- 统一 `install/verify/repair/uninstall/status` 语义；`verify` 只读，不写备份。
- `ensureDcsClosed` 可注入（测试用），默认用 `tasklist` 或 Node 进程枚举；DCS 运行时 install/repair/uninstall 拒绝，verify/status 允许。
- 迁移：
  - `install_sar.cjs`、`install_sar_scene.cjs`、`install_agradar_probe.cjs`、`install_fc_probe.cjs` 改用 common；
  - `install_export.py` 建议改为薄 CLI 调 Node `install_export.cjs`（新），避免 Python/Node 两套事务/备份逻辑；若保留 Python 实现，必须调用同一 manifest/备份语义并加生命周期测试。
- 对外 CLI 参数（`--saved-games`、`--lua`）保持兼容；旧命令不破坏。

#### B3. 生命周期测试

- 新增 `tests/test_install_fc.cjs`、`tests/test_install_agradar.cjs`：
  - 临时 Saved Games fixture，`install → verify → repair → uninstall`；
  - 外来文件保留；manifest/hash 校验；无残留；
  - `ensureDcsClosed` 注入 fake running 状态，验证拒绝；
  - 旧 suffix/manifest 迁移用例。
- `scripts/test_all.cjs` 将 FC/AGR 生命周期加入安装套件（当前仅 SAR/SAR scene）。
- 三次连跑一致。

### C. 审计逐条清零（当前 38 条 known）

现状：`audit_repo --strict` 0 new，但 allowlist 有 38 条（4 error / 34 warn）。Gate 6 目标：allowlist 空、0 finding。

| 类别 | 条数 | 处理 |
|---|---:|---|
| 文档状态缺失 | 20 | 补 `状态：...` 标签；分组见 C1 |
| 重复常量 | 12 | 见 C2；改代码/生成注入，而不是加白名单 |
| 游戏 API 越界 | 4 | 见 C3；规则精确化 + 字符串跳过 |
| 测试 skip | 2 | 见 C4；补原因，规则只报无原因/无条件 skip |

#### C1. 20 个文档状态

- `current`：`docs/feasibility.md`、`docs/theory-notes.md`、`docs/viewer-vectors.md`、`docs/dcs-map-terrain-interfaces.md`、`docs/sar-feasibility.md`、`docs/sar-in-mission.md`、`docs/sar-surface-quality.md`
- `historical`：`docs/design-fc-injection.md`、`docs/design-sar-airport.md`、`docs/design-sar-prototype.md`、`docs/review-fixes.md`、`docs/sar-airport-validation.md`
- `external-reference`：`docs/research/*.md`（8 个）
- 每个文件在标题下、前 30 行内加 `- 状态：...` + 日期；不得只加注释行。

#### C2. 12 个重复常量

- `src/hooks/aesa_sar_scene_hook.lua`（3 条：3594、128、17）：由 `build_runtime.cjs` 把 `src/shared/protocol.lua` 作为 `SceneProtocol` 模块注入 hook bundle，hook 从 `ports.sar_scene` 与 `sar.capture.size_n_pairs` 生成端口/白名单；源码不再出现裸数字。
- `tests/test_sar_live.cjs`（128×2）、`test_sar_map.cjs`（128）、`test_sar_mission.lua`（17×2）、`test_sar_mosaic.cjs`（128×2）、`test_sar_scene.cjs`（17）、`test_sar_viewer.cjs`（128×15、17）：从 `src/shared/config.cjs` 的 `PROTOCOL`/`SAR_FOOTPRINTS` 导入，或用一个 `const SIZE = ...` 派生；测试不得复制 spec 值。
- `tools/integration_check.py`（3590）、`tools/live.py`（3591×2）：像 `receiver.py` 一样读 `spec/protocol.json`，或复用 `tools/protocol.py` 的加载函数。
- 完成后 `grep` 确认无裸 128/17/3590/3591/3594（测试 fixture 除外）。

#### C3. 4 个 game-api error

- `scripts/install_export.py`、`install_sar.cjs` 的 `lfs.`：这是宿主部署脚本的文件操作，不是游戏内 API；`checkGameApi` 排除 `scripts/install_*`，并在规则注释/文档写明“安装器属于宿主侧”。
- `src/hooks/aesa_sar_scene_hook.lua`（`net.dostring_in` 3 处）、`tools/sar_bridge.cjs`（4 处）：都是 provider 标签字符串；让 `apiCallsOnLine` 跳过字符串字面量（复用 `codeOnly` 或等价扫描），真实调用仍计数。
- 新增审计规则测试：注释、字符串、真实调用、安装器四类 fixture，防止规则改坏后静默放行。

#### C4. 2 个 test-skip

- 给 `tests/test_install_sar_scene.cjs` 的 3 处 skip 补原因；`test_install_sar.cjs` 的 5 处保持原因。
- `checkSkips` 只把“无条件 skip”或“无原因 skip”记为 finding；带原因的条件 skip 记录但不阻断（文档写明 Gate 6 的判定口径）。
- 完成后 allowlist 中 `test-skip` 两条删除。

#### C5. 清零与基线

- 所有修复完成后运行 `node scripts/audit_repo.cjs --update-baseline` 生成 **0 条 allowlist** 的基线（或空 allowlist 的合法 schema），再 `--strict` 验证 `0 new / 0 known`。
- `tests/baseline/README.md` 更新为“Gate 6 起 allowlist 为空”；`audit_repo.cjs` 的 stale 检查保留。
- 不得为了清零删测试/跳过实机/降低阈值。

### D. 文档与规则定稿

- `AGENTS.md`：Gate 6 状态、原生双 DLL、默认只读、安装统一、测试计数（预计新增生命周期/原生用例后 >464）。
- `README.md`：架构树（`src/native/fc_trace|fc_inject`）、测试矩阵、文档索引、Gate 6 状态。
- `docs/status.md`：标 `historical`，不再维护。
- `docs/design-sar-prototype.md`、`docs/design-fc-injection.md`、`docs/design-sar-airport.md`：标 historical 或重写为 Gate 6 现状；不得与现役路径矛盾。
- `docs/config-reference.md`：由 `spec/` 重新生成。
- `docs/file-inventory.md`：新增 `fc_trace`/`fc_inject`、build/install common、Gate 6 计划、测试；删除旧 `aesa_fc.dll` 描述。
- `DEPRECATIONS.md`：登记旧 `aesa_fc.dll`/旧备份后缀/旧 install 入口，写计划删除 Gate（Gate 6 内删除则不留）。
- `docs/testing-gates.md`：Gate 6 状态、G6-01..10 勾选、证据口径。
- 本计划在 Gate 6 期间作为执行清单；完成后把结果写 worklog，不修改本文件的历史记录。

### E. 真实 Saved Games 烟测

前置：关闭 DCS、备份 `Saved Games\DCS`、确认没有 `DCS*.exe`。

1. `install_fc_probe.cjs install --saved-games ...`（默认 trace only）+ `install_sar`/`install_sar_scene`/`install_export`。
2. 单机开发任务进入 `FC-TRACE-BANDIT-2` 场景：
   - 日志 `Logs\AESA\fc_trace.log` / `fc_native.log` 无 error；
   - 默认 `mode=0`；无 `fc_experiment.lua` 时写路径不可达；
   - A/A Export 约 10 Hz、SAR `connected; height=true surface=true`、scene `CAP,...`；
   - Gate 5 欠的 SAR Export/场景桥/DBS/MAP 行为在本轮确认。
3. 需要注入时，只有用户明确同意、单机、备份后才写 `fc_experiment.lua`（`mode=1`，必要时 `feed=1`），验证后立即恢复 `mode=0` 并 `uninstall/verify`。
4. 退出 DCS 后 `uninstall`，确认无残留；记录日志 hash/时间。

### F. 收口

- 构建 3 次、生命周期 3 次、`test_all` 3 次、`audit_repo --strict` 0、`gen_config --check` 0 diff、`git status` 干净。
- 写 `worklog/2026-10/<date>_gate-6.md`，更新 `worklog/index.md`，判定 Green/Yellow/Red。
- 打 `gate-6-complete`；若 Red，回滚到 `gate-6-start`，不带着原生写风险继续。

## 3. 执行顺序（建议）

| 阶段 | 内容 | 依赖 | 产出 |
|---|---|---|---|
| M0 | 打 `gate-6-start`；提交本计划；确认 DCS 关闭、gcc 可用 | Gate 5 Green | 起点 tag/计划 |
| M1 | A1–A3 源码/构建/profile 双目标；静态导出守卫 | M0 | 两个 DLL 可构建 |
| M2 | A4–A6 hook 切换、安装器、DLL 测试 | M1 | 默认只读可验证 |
| M3 | B1–B3 build/install common、生命周期 | M2 | 安装可复现 |
| M4 | C1–C5 审计清零；D 文档 | M2/M3 | audit 0 finding |
| M5 | E 实机烟测（trace 默认；inject 可选） | M2/M4 | 实机证据 |
| M6 | F 收口 + worklog + tag | 全部 | Gate 6 判定 |

审计清零放在 M4 而不是最后，是因为 hook/测试/安装器的改动会改常量与 skip 计数；先改代码再清基线，避免反复。

## 4. 验证矩阵（Gate 6 证据）

```bash
# 构建（两个 FC DLL + AGR）
node scripts/build_fc_probe.cjs
node scripts/build_agradar_probe.cjs

# 静态守卫（构建内已断言，另跑测试）
node --test tests/test_gate6_native.cjs
python tests/test_fc_probe_dll.py          # trace + inject
python tests/test_agradar_probe_dll.py

# 安装生命周期（临时 fixture，不指向真实 Saved Games）
node --test tests/test_install_fc.cjs tests/test_install_agradar.cjs
node --test tests/test_install_sar.cjs tests/test_install_sar_scene.cjs

# 全量
node scripts/test_all.cjs                  # ×3
node scripts/audit_repo.cjs --strict       # 0 new / 0 known
node scripts/gen_config.cjs --check        # 0 diff
```

实机证据：`Logs/AESA/fc_trace.log`、`fc_native.log`、SAR/场景桥日志、默认只读与 inject 未配置不可达的日志行。

## 5. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 两个 DLL 同时 Hook 冲突 | 同一时刻只加载一个；inject 是 trace 超集；切换前 stop/shutdown |
| trace 误编译写代码 | objdump 导出守卫 + ctypes 负向断言 + CI 测试 |
| 旧部署 `aesa_fc.dll`/旧 manifest/旧后缀 | 按旧 hash 识别、备份后迁移；未知文件拒绝；`verify` 报差异 |
| DCS 更新导致 profile/符号不匹配 | 默认 trace；inject 只在 profile 通过时加载；不匹配 fail-closed |
| 审计清零工作量大 | 先 C3/C4 规则精确化，再 C1 文档标签，最后 C2 常量；分小提交 |
| 实机不可用 | Gate 6 相关项标 blocked，不得 Green；离线套件继续 |
| 原生写路径误开 | `fc_experiment.lua` 不存在/非 1/inject 缺失/profile 失败均只读；日志审计 |

## 6. 预期新增/修改文件

- 新增：`scripts/build_common.cjs`、`scripts/install_common.cjs`（若决定新 `install_export.cjs` 也在此）、`tests/test_gate6_native.cjs`、`tests/test_install_fc.cjs`、`tests/test_install_agradar.cjs`
- 修改：`src/native/fc_probe/aesa_fc.c`、`scripts/build_fc_probe.cjs`、`scripts/build_agradar_probe.cjs`、`src/hooks/aesa_fc_hook.lua`、`src/hooks/aesa_sar_scene_hook.lua`、`scripts/build_runtime.cjs`、`scripts/install_fc_probe.cjs`、`scripts/install_agradar_probe.cjs`、`scripts/install_sar.cjs`、`scripts/install_sar_scene.cjs`、`scripts/install_export.py`、`spec/deployment.json`、profile 生成物、`tests/test_fc_probe_dll.py`、`tests/test_sar_*.cjs`、`tests/test_install_*.cjs`、`scripts/test_all.cjs`、`scripts/audit_repo.cjs`、`tests/baseline/audit-baseline.json`、文档清单（§D）
- 清理：旧 `dist/dev/aesa_fc.dll`、旧 FC manifest/旧备份后缀（按 DEPRECATIONS 登记与迁移）

## 7. 完成定义（DoD）

- G6-01..G6-10 全部满足，且每条有命令/日志/退出码证据。
- trace DLL 的导出表不含 `aesa_fc_arm/disarm/feed_target`；inject DLL 含且受 profile 守卫。
- 默认部署/加载 trace；inject 仅在显式配置 + profile 通过时可用；未配置时日志明确只读。
- 安装器生命周期 3 次一致；外来文件保留；无残留。
- `audit_repo --strict` **0 finding**、allowlist 为空；`test_all` 3 次 GREEN；`gen_config --check` 0 diff；`git status` 干净。
- Gate 6 worklog 完成，判定明确，打 `gate-6-complete`。

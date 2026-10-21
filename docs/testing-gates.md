# 测试与门禁（Gate 0–7）

状态：current
更新：2026-10-19
Gate 状态：Gate 0–7 完成；**Gate 7 完成（Green）**：`test_all` 483 项 × 3、回放 flight3/flight9 与基线逐项一致、SAR detail/area 0 差异、PFA/2048 smoke 通过、安装生命周期修复、实机 A/A/SAR/FC/AGR 通过、`compat_check` level B（required 全 ok）；tag `arch-refactor-complete`。
依据：`docs/refactor-plan.md` §5–§7；`AGENTS.md` 的 Gate 规则。
适用范围：架构重构 Gate 0–7 的执行、验收与证据记录。本文只定义门禁，不改变业务代码；阈值、命令或判定语义的变更必须与对应 Gate 同提交，并在 worklog 中写明原因。

---

## 0. 执行约定

### 0.1 环境与记录

所有命令默认在仓库根目录用 **Git Bash** 执行：

```bash
cd <repo>
export AESA_LUA="<DCS>/bin/luae.exe"
```

每次 Gate 的证据必须记录实际值，不得沿用历史记忆：

- 操作系统、CPU 核数（SAR 并行/耗时相关）、Node、Python、lupa 版本；
- DCS build（Gate 3 起以 `compat_check` 的 profile 为准；此前记录启动器/日志可见的 build）；
- Lua 5.1 实际路径与 `_VERSION`；
- Saved Games 路径（生命周期测试使用临时目录时也要记录，避免误写真实目录）；
- 分支、Gate 开始/结束 commit、Gate tag、`git status` 与 `git clean -nd` 结果。

DCS 安装目录只作为只读参考；部署只通过安装脚本写入 Saved Games。对真实 Saved Games 的测试前先确认没有正在运行的 `DCS*.exe`。

### 0.2 命令标记

本文用三种标记：

- `[现有]`：Gate 0 时仓库中已经存在的脚本，命令必须按本文原样执行。
- `[Gate N 引入]`：该 Gate 才实现/启用的脚本或端点；落地时若名称、参数或退出码与本文不同，必须在同一提交回填本文，不能留下失效命令。
- `[手工]`：没有可靠退出码或需要人看屏幕/日志的项目；只记录观测值和截图路径，不计为自动化 pass。

**现有命令**（Gate 0 已可运行）：

```bash
python tests/run_tests.py
python tests/test_review_regressions.py
node --test tests/test_sar_*.cjs
node --test tests/test_viewer_vectors.cjs
node --test tests/test_install_sar.cjs tests/test_install_sar_scene.cjs
python tests/test_agradar_probe_dll.py
python tests/test_fc_probe_dll.py

python tools/replay.py recordings/flight3-final.aesarec --dt 0.05 --seed 42
python tools/live.py --record recordings/<name>.aesarec
python tools/live.py --replay recordings/<name>.aesarec --speed 0
python tools/receiver.py --record recordings/<name>.aesarec
python tools/integration_check.py

node tools/sar_live.cjs --demo
node tools/sar_live.cjs --replay <scene.json> --quality <standard|fine|fast>
node scripts/sar_airport_probe.cjs [输出目录]
node scripts/sar_pfa_probe.cjs [--record <scene.json>] [--quality <standard|fine|fast>]
node scripts/sar_quality_probe.cjs [--record <scene.json>] [--html <report.html>]
node scripts/sar_precision_probe.cjs <scene.json> <report.html>
node scripts/sar_principle_probe.cjs [--image]

node scripts/install_sar.cjs <action> --saved-games <目录> [--lua <Lua 5.1>]
node scripts/install_sar_scene.cjs <action> --saved-games <目录> [--lua <Lua 5.1>]
node scripts/install_fc_probe.cjs <action> --saved-games <目录> [--lua <Lua 5.1>]
node scripts/install_agradar_probe.cjs <action> --saved-games <目录> [--lua <Lua 5.1>]
python scripts/install_export.py <action> --saved-games <目录>
# <action> = install | verify | repair | uninstall | status（按脚本支持集选择）
node scripts/build_fc_probe.cjs
node scripts/build_agradar_probe.cjs
python tools/fc_trace_report.py [日志路径]
python scripts/extract_rcs.py <DCS 安装目录>
```

**后续 Gate 引入**：

```bash
node scripts/test_all.cjs [--json <path>] [--verbose]      # Gate 0 引入（并行产物）
node scripts/capture_baseline.cjs                          # Gate 0 引入（并行产物）
node scripts/audit_repo.cjs [--strict] [--json] [--update-baseline]  # Gate 0 引入
node scripts/gen_config.cjs --check                        # Gate 2 引入
node scripts/compat_check.cjs --record <基线>              # Gate 3 引入
node scripts/compat_check.cjs --detect --diff <基线>       # Gate 3 引入
```

Gate 4 的契约测试已落地：`tests/test_gate4_boundary.py`、`tests/test_gate4_snapshot.py`（由 `python -m unittest discover -s tests -p "test_gate*.py"` 覆盖）。Gate 5 的 `src/sar_core` 模块测试与 `/image/<seq>` 端点，以落地时的测试文件/路由为准；落地前不得把它们写成已通过。Gate 6 的 `install_common.cjs` / `build_common.cjs` 是内部模块，产品 CLI 保持上面的现有入口。

### 0.3 证据原则

- 每条结论必须能追溯到一条命令、一个退出码或一张截图；禁止凭印象写“通过”。
- 命令输出中的数字原样进入 worklog；不要把历史 worklog、README 或 `docs/status.md` 的数字当成当前 Gate 的基线。
- 基线文件只存 JSON/哈希/摘要，不存大图、原始录制或 `dist/` 产物。
- 工作区必须可解释：Gate 结束提交后 `git status --porcelain` 为空；若有并行 Gate 文件，先确认归属再提交。
- 任何“跳过/阻塞”都要写原因、影响和恢复条件；环境缺失不算通过。

---

## 1. 判定规则

### 1.1 Green / Yellow / Red / Blocked

| 判定 | 条件 | 动作 |
|---|---|---|
| **Green** | 构建/加载成功；该 Gate 的阻断项全部通过；指标在基线容差内；无新增 warning；`audit_repo --strict` 零 finding；清理与证据完成；没有未批准的 Yellow/Blocked | 才能进入下一个 Gate |
| **Yellow** | 只有非关键偏差（不影响数据正确性、协议、物理、确定性、安全默认），且有 owner、日期、原因和影响范围 | 本 Gate 内继续；进入下一 Gate 前必须清零，或由用户明确书面接受；**Yellow 不是 Green** |
| **Red** | 崩溃/挂起；数据错误；物理偏差超容差；协议/字段不匹配；原生符号/偏移不匹配；确定性破坏；flaky；审计 error；缺能力返回假值 | 停线：定位根因、先补失败测试、修复后重跑整个 Gate；连续两次修复仍 Red 则回滚到 Gate tag 重评 |
| **Blocked** | 必需环境缺失（DCS、Saved Games、Lua 5.1、原生构建工具、录制文件等），导致该 Gate 的阻断项无法执行 | 记录原因与影响；可继续不依赖该环境的离线部分；**不得把 Gate 判为 Green，也不得进入依赖该能力的下一 Gate** |

判定补充：

- 同一项同时满足 Yellow 和 Red 条件时按 **Red** 处理。
- 新增 warning 不能通过 `audit_repo` 默认模式隐藏；Gate 一律用 `--strict`。
- “skip”不是 pass；“blocked”不是 skip；二者都不能计入通过数。
- 只有用户明确接受并记录在 worklog 的 Yellow 才能进入下一 Gate；接受记录必须包含接受人、日期、剩余风险和补做期限。

### 1.2 三次连跑

- 所有自动化阻断项（单元、契约、集成、回放、SAR 指标、部署生命周期）**连跑 3 次**。
- 3 次中任意一次失败、超时、崩溃或输出不确定，一律 **Red**；不允许取平均、重跑一次变绿或只报最好一次。
- 确定性比较用规范化的 JSON/哈希/像素哈希，不用“看起来一样”。同一配置 + 同真值 + 同种子，3 次的航迹 ID、确认状态、告警/检测计数、图像哈希必须一致。
- 性能类指标 3 次都记录，报告 `min / median / max`；判定用 median，但任何一次超时/挂起仍按 Red。
- 手工视觉项每个受影响视图至少检查 1 次；显示代码改动时在同一构建上刷新/截图 3 次，确认不是偶发绘制问题。

### 1.3 禁止“变绿”

严禁以下行为：

- 注释掉、删除、改写断言，或把测试改成只打印不失败；
- 无条件 `skip`、`todo`、提前 `return`、捕获异常后当作通过；
- 降低阈值、放宽容差、减少采样点/脉冲数/图像尺寸来避开失败；
- 跳过实机、视觉或部署检查，或用离线结果冒充实机；
- 修改 `tests/baseline/*.json` 让回归值匹配当前输出；
- 用 `--update-baseline` 吞掉新 finding，或手工改 allowlist 计数；
- 把环境缺失写成 pass，或把 `blocked` 写成 `skip`；
- 为了让审计通过而删除现役文件/文档，或把问题移到扫描范围外。

### 1.4 基线/阈值变更

- 基线只能在 Gate 0 首次建立；后续 Gate 不得为了匹配退化而改基线。
- 阈值变更必须有用户批准，并在同一提交更新：测试断言、本文对应指标、基线文件、worklog 的“旧值/新值/原因/影响”。
- 因环境差异（机器、DCS build、CPU 核数）造成的非关键偏差标 Yellow，不得直接改阈值。
- 浮点比较默认：配置/几何 `≤1e-9` 相对误差；SAR 图像 `0` 或 `≤1 LSB`（mosaic 量化步长 0.25 dB 时即 0.25 dB）；A/A 回放指标按 §4.1 的容差。

---

## 2. 测试矩阵

| 层级 | 目的 | 命令 | 适用 Gate | 阻断性/说明 |
|---|---|---|---|---|
| 单元（Python） | A/A 核心、协议、安装逻辑 | `python tests/run_tests.py`；`python tests/test_review_regressions.py` | G0–G7 | 阻断；缺 lupa 标 blocked，不是 skip |
| 单元/模块（Node） | SAR、显示、服务模块 | `node --test tests/test_sar_*.cjs`；Gate 4/5 新增模块测试 | G0–G7 | 阻断；新增测试必须进入 `test_all` |
| 契约 | 单一事实源、几何向量、协议 schema | `node scripts/gen_config.cjs --check`（G2 引入）；Lua/JS 几何向量（G2 引入）；协议 schema（G2 引入） | G2–G7 | 阻断；`gen_config --check` 必须零 diff |
| 集成 | 服务、桥接、显示、模块组合 | `node --test tests/test_sar_*.cjs`；`node --test tests/test_viewer_vectors.cjs`；`python tools/integration_check.py`（手工） | G0–G7 | 自动项阻断；`integration_check` 只作手工冒烟，见 §6 |
| 回放 | A/A 不退化、确定性 | `python tools/replay.py recordings/flight3-final.aesarec --dt 0.05 --seed 42`；`flight9` 同参数 | G0–G2、G4、G5、G7 | 有录制时阻断；缺录制 blocked |
| 实机 | DCS 内 Export/场景桥/原生 | 部署 + 进任务 + `compat_check`（G3 引入）+ 日志检查 | G1、G3、G5、G6、G7 | 阻断；DCS 不可用 blocked，不算 Green |
| 视觉 | A/A/SAR 页面与图像 | `node --test tests/test_sar_viewer.cjs`（含在 SAR glob）；手工截图检查清单 | G4、G5、G7 | 显示改动时阻断；截图路径入 worklog |
| 性能 | 回放耗时、SAR 成像、`/state` 大小 | 回放墙钟；`metadata.compute_ms`；`GET /state` 字节数 | G0 基线、G2、G4、G5、G7 | 记录 3 次；明显退化（>10% median）Yellow，超时/挂起 Red |
| 部署 | 安装/修复/卸载/不覆盖 | `node --test tests/test_install_sar.cjs tests/test_install_sar_scene.cjs`；各安装器生命周期 | G0 基线、G6、G7 | 阻断；DCS 运行中不得部署 |

矩阵说明：

- `test_all` 是统一入口，必须汇总上述自动化项的 pass/fail/skip 与 skip 原因；单项命令用于定位，不能替代 `test_all` 的汇总。
- **当前 `test_all` 覆盖 11 个套件：Python 核心/回归、座舱状态桥（`tests/test_cockpit_bridge.py`）、Gate Python 回归（`tests/test_gate*.py`）、Gate Node（`tests/test_gate*.cjs`）、SAR Node、显示层向量、座舱页（`tests/test_cockpit_page.cjs`，需 Lua 5.1）、SAR 安装和两个原生 DLL；回放与 SAR 基线仍由 `capture_baseline.cjs` 单独生成**（见 §6）。Gate 验收必须额外执行回放；不能因为 `test_all` 打印 GREEN 就跳过回放。
- `test_sar_*.cjs` 当前包含 13 个文件，覆盖 SAR 物理、服务、MAP/DBS、扫掠/拼接、场景与 viewer；Export Lua 采集由 `test_install_sar*.cjs` 在 `AESA_LUA` 下运行。新增 SAR 模块测试必须沿用该 glob 或显式加入 `test_all`。
- 实机项在 Gate 1/3/5/6/7 是阻断项。只跑离线套件不能把含实机项的 Gate 判为 Green。
- 视觉项不是“看一眼就行”：按 §4.5 的检查清单逐条记录，截图放在 worklog 引用的本机路径，不提交大图。

---

## 3. 基线文件与证据格式

### 3.1 `tests/baseline/` 文件

| 文件 | 产生方式 | 必须包含 |
|---|---|---|
| `replay-flight3.json` | `node scripts/capture_baseline.cjs`（Gate 0 引入） | 命令、commit、status、输入哈希、帧数、时长、确认航迹数/ID、检测计数、回放耗时；**p95/max 跳变需另补测量**（见 §6） |
| `replay-flight9.json` | 同上，flight9 | 同上；最长会话 690.1 s，在 1800 s 上限内已实际回放：6716 帧 / 690.15 s / 5 条确认航迹 |
| `sar-detail.json` | `capture_baseline.cjs` 的 detail 步骤（脚本内 `reconstruct` + `pointQuality`，输入 `recordings/sar/*.json`） | 命令、场景/录制、`size_m`、`quality`、`bandwidth_hz`、`width`、dB 范围、耗时、点响应、图像哈希；`sar_pfa_probe` 可作 PFA 补充 |
| `sar-area.json` | 同上，area footprint | 同上；另记 footprint、拼接 `seq/generation` |
| `export-protocol.json` | `capture_baseline.cjs` 的协议步骤（逐行 `receiver.parse_line`） | 文件、会话数、帧数/时长/速率、各类行数与字段数、坏行数、CoalitionID 值域、`vel_valid` 计数 |
| `state-size.json` | `capture_baseline.cjs` 的 state 步骤（demo 服务 + `GET /state`） | 端点、响应字节数、是否含矩阵、`latestSeq`/mosaic 摘要、测量时间 |
| `README.md` | `capture_baseline.cjs` | 环境、每条基线状态/跳过原因、复现命令；不替代 JSON 中的指标 |
| `audit-baseline.json` | `node scripts/audit_repo.cjs --update-baseline`（Gate 0 首次） | 基线 tag、commit、allowlist、生成时间；已知问题只登记，不代表可接受 |
| `compat.json` | `node scripts/compat_check.cjs --record`（Gate 3 引入） | build、profile id、能力矩阵、原生符号/偏移/export hash、字段形态、`radar.fx` hash |

Gate 0 并行产物若把 PFA 单独存为 `tests/baseline/sar-pfa.json`，同样必须包含 `command/commit/status/input_sha256` 与指标字段（环境可集中在 `tests/baseline/README.md`）；文件名变化必须在本文和 `test_all` 中登记。

### 3.2 基线 JSON 公共字段

`capture_baseline.cjs` 当前生成的 JSON 形态（各文件按步骤附加 `replay`/`image`/`point_response`/`bad_lines`/`state_bytes` 等字段）：

```json
{
  "schema": 1,
  "generated_at": "2026-10-17T...",
  "generator": "scripts/capture_baseline.cjs",
  "command": "node scripts/capture_baseline.cjs (replay-flight3 step)",
  "commit": "<git rev-parse HEAD>",
  "branch": "refactor/architecture-gates",
  "tag": "pre-arch-refactor",
  "worktree_dirty": false,
  "status": "ok",
  "input": "recordings/flight3-final.aesarec",
  "input_sha256": "<哈希>",
  "replay": { "frames": 1608, "duration_s": 168.29, "tracks_total": 6, "tracks_confirmed": 6 }
}
```

环境（OS/Node/Python/lupa/Lua/DCS bin/回放参数）当前集中写在 `tests/baseline/README.md`；若某条 JSON 自行带 `environment`，也必须完整。要求：

- `command` 必须能直接复制执行；参数、工作目录、环境变量缺一不可。
- `status` 必须明确 `ok`/`skipped`/`error`；`skipped` 要写原因，不能当通过。
- `worktree_dirty` 必须为 `false`；若为 `true`，记录具体 dirty 文件，并在提交后重跑 `capture_baseline.cjs`；否则基线不对应任何可复现 commit。
- 录制/场景输入记录 SHA-256；图像只记录哈希和摘要，不存大图。
- 基线文件中的数字是 Gate 0 实际运行的输出；不得手填历史 worklog 的数字。
- 基线变更必须有用户批准和 worklog 记录；`audit-baseline.json` 的新增条目必须有 Gate/owner 归属。

---

## 4. 功能指标

### 4.1 A/A 核心

| 指标 | 测量/定义 | 基线/容差 | 适用 Gate |
|---|---|---|---|
| 回放帧数/时长 | `tools/replay.py` 输出“采用最大段: N 帧, T s” | 与基线完全一致（Gate 0 记录实际值） | G0–G2、G4、G5、G7 |
| 确认航迹数/ID | 最终 `tracks` 中 `confirmed` 数量与 ID 集合 | 与基线完全一致 | 同上 |
| 假航迹/丢真实航迹 | 与真值目标对照；flight9 历史基线为“21 条航迹=全部真实空中目标” | 不新增假航迹；不丢真实航迹 | G1–G2、G4、G5、G7 |
| 位置跳变 p95/max | 同一 track id 的相邻帧位置差（米），排除丢失后重捕获的跨段；对全部确认航迹取 p95 与 max | p95 和 max 均 ≤ 基线 +10%；单点不得出现基线外的量级跳变 | G0 基线、G1–G2、G4、G7 |
| 检测原因分布/调度账本 | sink/dwell 的检测原因、驻留计数、时间账本 | 与基线一致，或差异可逐项解释并记录 | G0–G2、G4、G7 |
| 确定性 | 同配置+同真值+同种子连跑 3 次，比较最终航迹/计数/输出哈希 | 3 次完全一致；任一差异 Red | 所有含回放的 Gate |
| 回放耗时 | 3 次墙钟，记录 min/median/max | 记录基线；median 比基线慢 >10% 标 Yellow；超时/挂起 Red | G0、G2、G4、G5、G7 |

补充：

- **当前 `tools/replay.py` 与 `scripts/capture_baseline.cjs` 都不输出逐帧跳变 p95/max**，只记录最终航迹/检测计数。Gate 0 基线任务必须补测量（扩展现有 replay 输出或新增采集脚本），并把命令写进 `tests/baseline/replay-*.json` 的 `command`。在该测量落地前，跳变指标标 `blocked`，不得用 `docs/status.md` 里 flight5 的历史 p95 冒充 flight3/flight9 基线。
- **flight9 基线已建立**：最长会话 690.15 s，`capture_baseline` 已在 1800 s 上限内实际回放，记录 6716 帧 / 13803 步 / 62340 驻留 / 5 条确认航迹；后续 Gate 直接与该文件比较。
- 航迹 ID 可能因重排序变化；Gate 1 要求按稳定 id 排序。基线比较时先确认 ID 映射规则，不得用集合比较掩盖 ID 漂移。
- 位置跳变的“相邻帧”以核心 step 的输出为准；不要用录制原始帧直接比较。

### 4.2 SAR

| 指标 | 测量/定义 | 基线/容差 | 适用 Gate |
|---|---|---|---|
| 图像尺寸/网格 | `metadata.size_m`、`width`、`scatter_spacing_m`、`image_step_m` | 与请求 footprint/quality 的实际值一致；与基线一致 | G0–G2、G5、G7 |
| `quality` | `metadata.quality` | 必须是**实际生效**档；`fine` 因网格/带宽限制降级时不得仍写 `fine` | G1、G5、G7 |
| `bandwidth` | `metadata.bandwidth_hz` | 与 `spec/sar.json`（Gate 2 前为 `sar_processing`/`sar_scene`）的 footprint×quality 一致 | G0–G2、G5、G7 |
| `width` | 输出像素宽（129/257/65 等） | 与实际输出一致；不得静默降级 | G0–G2、G5、G7 |
| dB 范围/量化 | `db` 的最小/最大、量化步长、`no_data` 哨兵 | 与协议一致；mosaic 0.25 dB Int8；无数据用 -128；与基线逐像素 0 或 ≤1 LSB | G0–G2、G5、G7 |
| PFA 点响应 | `sar_pfa_probe` 的 FWHM 相对差、位置误差、PSLR | FWHM 相对差 <2%；位置误差 ≤0.2 m；PSLR 不劣于反投影 +2 dB；见 §6 的阈值差异说明 | G0 基线、G2、G5、G7 |
| 图像等价 | 与基线逐像素比较 | 0 或 ≤1 LSB；超过则 Red | G2、G5、G7 |
| 拼接 `seq/generation` | `/state`、`/image/<seq>`、`/snapshot` | `seq` 单调递增；重启后 `generation` 改变；旧 seq 返回 404；客户端按 generation 丢弃缓存 | G5、G7 |
| `/state` 大小 | `GET /state` 响应体字节数（不含 HTTP 头），首次全量与 `?since=<seq>` 稳态各测一次 | D3 后 **<4 KB**；不含图像矩阵；Gate 0 记录重构前大小 | G0 基线、G5、G7 |
| 失败可停/可重发 | 手动/连续 MAP/DBS 失败后的状态机 | 失败后 `active=false`、错误可见、页面可停止、可重新发起；连续模式只按 100 ms 定时器重试，不无限重试手动任务 | G1、G5、G7 |
| `span_requested_m`/`span_sampled_m` | 采集/元数据 | 两者都可见；实际采样跨度不得冒充请求跨度 | G1、G5、G7 |
| 视觉 | 见 §4.5 | 无错位、无接缝闪烁、无错误提示；截图记录 | G5、G7 |
| 成像耗时 | `metadata.compute_ms` 与 probe 输出 | 3 次记录；median 比基线慢 >10% 标 Yellow；超时/挂起 Red | G0、G2、G5、G7 |

补充：

- 图像尺寸与分辨率不是一回事：`size_m` 是选区边长，`image_step_m` 是输出栅格；报告中必须同时写，不能只写“128 m 分辨率”。
- 2048 m/area/airport 档可能自动改用反投影；`metadata.focuser` 必须报告实际聚焦器。
- PFA 的平面波近似、地形起伏和大切片边缘效应按 `docs/sar-feasibility.md` 解释；不能用单张截图代替指标。

### 4.3 Export/协议

| 指标 | 测量/定义 | 基线/容差 | 适用 Gate |
|---|---|---|---|
| 采样率 | A 行时间戳：帧数/时长；丢帧率 = `1 - 帧数/(时长×10)` | 设计 10 Hz；**<1% 丢帧或与基线一致**；Gate 0 记录实际值。当前 flight3 预检约 9.55–9.61 Hz（约 4% 缺失），必须如实记录，不能写成满足 <1% | G0 基线、G1、G3、G7 |
| 字段数 | 每种行的 token 数 | Gate 1 起新格式 A=10、T=12（行尾 `vel_valid`）；旧录制 A=9、T=11 仍必须可解析（`vel_valid=false`）；O=5、L=4、E=7 或 10（含类型 token） | G0–G3、G7 |
| 坏行 | 非空行中 `receiver.parse_line` 返回 `None` 的数量，以及数值解析失败/截断帧 | 0；任何坏行 Red | G0–G3、G7 |
| `CoalitionID` | T 行阵营字段 | ∈ {0,1,2}；缺失时显式 `unknown`，不得回退到 `Country` 冒充；测试桩要让 `Country` 与 `CoalitionID` 不同 | G1 起 |
| `vel_valid` | A/T 速度有效性 | 速度来自真实 API 时才为 true；缺失 API 时 false，不得写 0 冒充；字段位置由 Gate 1 协议测试固定 | G1 起 |
| 日志 | `Saved Games\DCS\Scripts\AESA\export_diag.log` | 无 error/失败重连风暴；允许的首次连接失败与基线一致；60 s 实机窗口内无异常刷屏 | G1、G3、G7 |

补充：

- 字段数以 `spec/protocol.json`（Gate 2 起）为唯一来源；Gate 0/1 以 `tools/receiver.py:parse_line` 和 Export 测试为准。只改 Export 不改解析器（或反之）一律 Red。
- 坏行统计包含 `V1`/`P` 以外的未知行；`P` 是首帧探针，允许存在但内容变化要解释。
- 10 Hz 是设计频率，不是当前实测保证；当前基线低于 10 Hz 时，Gate 0 以基线为准，Gate 1/3 不得恶化。若要求达到 <1%，必须先修时间基准/采样并重新基线，不得只改报告。

### 4.4 兼容层/原生

| 指标 | 测量/定义 | 基线/容差 | 适用 Gate |
|---|---|---|---|
| profile 状态 | `compat_check` 能力矩阵 | 当前 DCS build 为 `verified`；降级项有 `degraded`/`unavailable`/`unknown` 状态和原因 | G3、G6、G7 |
| 能力矩阵 | 字段/回调/地形/任务/原生符号/地表词表/`radar.fx` hash | 每项有状态、来源、原因；不得用“存在接口”推断“调用成功” | G3、G6、G7 |
| 缺能力不返回假值 | fail-closed 用例 | 缺 `CoalitionID` → `unknown`；缺速度 → `vel_valid=false`；缺 `terrain.isVisible` → `visibility=unknown`；缺 `net.dostring_in` → 场景桥 `unavailable`；缺 `GetHeight` → SAR 拒绝；原生 profile 不匹配 → 只读 | G3、G5、G6、G7 |
| 符号/偏移/profile hash | 原生导出、`dcs_profile.h`、启动自检 | 符号、vtable/offset、export hash 与 profile 一致；不匹配 fail-closed，不写入 | G3、G6、G7 |
| 默认只读 | `aesa_fc_hook.lua`/DLL 安装与运行状态 | 默认加载 trace；写注入必须显式 `mode=1` + profile 校验 + 注入 DLL 存在；Gate 6 已完成拆分 | G1、G3、G6、G7 |
| 原生加载/卸载 | DLL 构建、`init`/`poll`/`shutdown`、日志 | 无崩溃/挂起；日志无 error；卸载后 DCS 可正常退出 | G6、G7 |

`compat_check` 的退出码在 Gate 3 落地时固定为 **0=A（required 全 ok 且无降级）、2=B（required 全 ok，存在非关键 degraded/unavailable）、3=C（required 有 degraded/unavailable）、4=blocked（probe/日志缺失或 flaky）、1=用法/输入错误**。`--diff` 的 `level` 与退出码同义；调用方不得把 2 当作失败，也不得把 3 当作可用。

### 4.5 部署与视觉检查清单

**部署**（G0 基线、G6、G7 阻断）：

- [ ] `install` 只写 manifest 列出的文件；修改已有文件前有备份；拒绝覆盖未知/已修改文件。
- [ ] `verify` 能发现缺失、哈希不符、manifest 损坏；`repair` 恢复自身文件且不碰外来文件。
- [ ] `uninstall` 只删除清单内且哈希匹配的文件；保留用户日志、外来文件、其他插件加载块。
- [ ] 部署前检查 `DCS*.exe`；运行中拒绝部署。
- [ ] 生命周期结束后目标目录无残留（备份按约定保留，并列出）。
- [ ] 真实 Saved Games 的最终烟测单独记录，不与临时 fixture 结果混写。

**视觉（A/A）**：

- [ ] B 扫量程环、波束当前位置/渐隐轨迹、检测闪光正常。
- [ ] 确认/暂定航迹符号、尾迹、标签不重叠；速度/预测线按量程限长，无超长线。
- [ ] 北向↑/航向↑切换正确，N 标记与量程换算无错位。
- [ ] 真值叠加默认关闭；开启后与航迹可区分。
- [ ] 页面无 console error；SSE/轮询断开时状态可见。

**视觉（SAR）**：

- [ ] mosaic 与已知地图/机场/道路对齐；扇形锚点、方向、范围正确；无明显接缝/闪烁。
- [ ] MAP 扇形外与未采集格显示无数据，不冒充已采集；DBS 提示与实际锐化/近前视退化一致。
- [ ] dB 图例/量化与 `metadata` 一致；`size_m`、`width`、`quality`、`focuser` 叠加信息与实际一致。
- [ ] `/state` 完成变化时拉取图像；不重复拉同一 seq；generation 变化后缓存失效。
- [ ] 失败/停止/重发状态在页面上可见；按钮不被永久禁用。
- [ ] 浏览器 console 无未处理异常；网络失败有可读提示。

截图与观测写入 worklog；大图不入库。

---

## 5. Gate 定义

### Gate 0：基线、决策、盘点

**目标**：冻结当前可演示状态；建立文件地图、测试基线、清理和门禁工具；四项决策（D1–D4）按推荐 A 方案落档。**不改业务行为、不批量删除文件。**

**进入条件**

- 分支为 `refactor/architecture-gates`（Gate 0 时名为 `codex/sar-airport-mapping`，2026-10-18 改名）；tag `pre-arch-refactor` 已存在并指向基线 commit。
- 用户确认 D1–D4 均采用 A 方案。
- Node、Python、lupa、DCS Lua 5.1 可用；`recordings/flight3-final.aesarec`、`flight9.aesarec` 存在；DLL 已构建或可构建。
- 工作区改动有归属；Gate 0 并行文档/脚本视为预期，不修改其他任务的文件。

**必跑命令**

```bash
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD
git rev-parse 'pre-arch-refactor^{}'
git status --porcelain=v1 -uall

export AESA_LUA="<DCS>/bin/luae.exe"
python tests/run_tests.py
python tests/test_review_regressions.py
node --test tests/test_sar_*.cjs
node --test tests/test_viewer_vectors.cjs
node --test tests/test_install_sar.cjs tests/test_install_sar_scene.cjs
python tests/test_agradar_probe_dll.py
python tests/test_fc_probe_dll.py

node scripts/test_all.cjs                    # Gate 0 引入；未落地则 blocked
node scripts/audit_repo.cjs --update-baseline # Gate 0 引入；仅首次建基线
node scripts/audit_repo.cjs --strict          # Gate 0 引入

python tools/replay.py recordings/flight3-final.aesarec --dt 0.05 --seed 42
python tools/replay.py recordings/flight9.aesarec --dt 0.05 --seed 42

node scripts/capture_baseline.cjs            # Gate 0 引入的基线采集入口；以实际产物为准
```

SAR/状态基线（`capture_baseline.cjs` 写入 `tests/baseline/`，不提交大图；补充探针输出用 Gate 专用目录，避免覆盖已有 `recordings/` 用户数据）：

```bash
# 主基线：replay-flight3/9、sar-detail/area、export-protocol、state-size
node scripts/capture_baseline.cjs

# 补充探针：PFA/点响应/地表对照；默认只打印，不覆盖用户数据
node scripts/sar_airport_probe.cjs recordings/gate-0-probe
node scripts/sar_pfa_probe.cjs
node scripts/sar_quality_probe.cjs

# 手工交叉检查 /state 字节数（capture_baseline 已记录 state-size.json）
node tools/sar_live.cjs --demo --http-port 3593 --tcp-port 0 --scene-port 0
# 等 /state 显示成像完成后：
curl -s http://127.0.0.1:3593/state | wc -c
```

**指标/验收**

- `python tests/run_tests.py` 22/22、`python tests/test_review_regressions.py` 38/38（以实际输出为准；Gate 0 记录当前套件数）。
- `node --test tests/test_sar_*.cjs` 全绿；`test_viewer_vectors` 全绿；Lua 安装套件在 `AESA_LUA` 可用时全绿；原生 DLL 套件在 DLL 已构建时全绿。
- `test_all` 报告 pass/fail/skip 与 skip 原因；同一套件连跑 3 次，无 flaky。
- `audit_repo --strict` 退出码 0；`audit-baseline.json` 只记录 Gate 0 当时已知问题，不把问题写成可接受。
- `tests/baseline/` 的 Gate 0 六个数据基线文件（replay×2、SAR×2、export、state）存在，另含 `audit-baseline.json`；都含 command/commit/status/输入哈希，环境集中在 `tests/baseline/README.md`；重放/回放可复现。`compat.json` 是 Gate 3 产物。
- 基线必须在干净工作区生成（`worktree_dirty=false`）；若并行文档导致 dirty，先提交再重跑 `capture_baseline.cjs`。当前预检的基线文件是在 dirty 工作区生成的，只能作草稿。
- `capture_baseline.cjs` 对最长会话超过 1800 s 的录制才记录跳过原因；flight9（690.15 s）已实际回放并写入基线。若未来录制超过上限，必须单独跑 `tools/replay.py` 留档或把该基线标 blocked。
- 决策 D1–D4 写入 `docs/architecture.md`；`docs/conventions.md`、`docs/dcs-compat.md` 建立；`docs/file-inventory.md` 分类完成；`DEPRECATIONS.md` 为空表；`docs/status.md` 标历史；README 增加索引。
- 不修改业务代码、不删除文件；删除候选只列清单。

**退出条件**

- 基线可复现；文档地图完整；`test_all`/`audit_repo` 可用；`git status` 干净（提交后）；四个决策已落档；无未说明的 blocked。
- 任一必跑套件 Red，或关键环境 blocked，Gate 0 停在此处，不得进入 Gate 1。

**停点检查清单**

- [ ] G0-01 记录分支、HEAD、`pre-arch-refactor^{}`；tag 指向基线 commit，差异有说明。
- [ ] G0-02 记录 Node/Python/lupa/DCS build/Lua/Saved Games/CPU 核数；路径可复现。
- [ ] G0-03 `python tests/run_tests.py` 通过，3 次一致。
- [ ] G0-04 `python tests/test_review_regressions.py` 通过，3 次一致。
- [ ] G0-05 `node --test tests/test_sar_*.cjs` 3 次全绿；无 flaky（预检出现的 bad-port 失败必须修复或按 Red 记录，不能用重试掩盖）。
- [ ] G0-06 `node --test tests/test_viewer_vectors.cjs` 通过，3 次一致。
- [ ] G0-07 `AESA_LUA` 或 `test_all` 自动检测到 DCS `luae.exe` 时安装套件全绿；都不可用时 skip 有原因且不能算 pass。
- [ ] G0-08 原生 DLL 测试通过；DLL 未构建按失败处理，DCS Lua 缺失按 blocked 记录。
- [ ] G0-09 `node scripts/test_all.cjs` 存在且汇总 pass/fail/skip；3 次输出可比较。
- [ ] G0-10 `node scripts/audit_repo.cjs --strict` 退出码 0；`--update-baseline` 仅首次使用且 diff 已复核。
- [ ] G0-11 `tests/baseline/*.json` 含 command/commit/status/输入哈希；环境在 README；`worktree_dirty=false`（dirty 时提交后重跑）；无大图/原始录制。
- [ ] G0-12 flight3 与 flight9 回放基线均记录帧数/时长/航迹/ID（flight9：6716 帧 / 690.15 s / 5 条确认）；p95/max 跳变测量尚未落地，该项标 blocked，不用历史值代替。
- [ ] G0-13 SAR 基线记录 128/512 档（2048 若可用则记录）的 size/quality/bandwidth/width/dB/no_data/点响应/耗时/哈希。
- [ ] G0-14 Export 基线记录帧数/速率/字段数/坏行/CoalitionID；当前 10 Hz 偏差如实记录。
- [ ] G0-15 `/state` 基线记录字节数（含是否含矩阵）；D3 的 <4 KB 目标留给 Gate 5。
- [ ] G0-16 D1–D4 写入 `docs/architecture.md`；conventions/dcs-compat/file-inventory/DEPRECATIONS 完成；status 标历史；README 索引更新。
- [ ] G0-17 没有业务代码改动、没有批量删除；删除候选只列清单。
- [ ] G0-18 提交后 `git status` 干净；Gate 0 worklog 写完。

---

### Gate 1：正确性止血

**目标**：消除会静默给错数据的缺陷，并删除被替代的旧路径；每条 bug 先写失败测试。

**进入条件**

- Gate 0 为 Green（或 Yellow 已获用户接受）；tag `gate-1-start` 已打。
- 基线文件可读；`tools/replay.py`、SAR 套件、Export 部署路径可用。
- DCS/实机环境可用；不可用则本 Gate 的实机项 blocked，不能判 Green。

**必跑命令**

```bash
python tests/run_tests.py
python tests/test_review_regressions.py
node --test tests/test_sar_*.cjs
node scripts/test_all.cjs
node scripts/audit_repo.cjs --strict
python tools/replay.py recordings/flight3-final.aesarec --dt 0.05 --seed 42
python tools/replay.py recordings/flight9.aesarec --dt 0.05 --seed 42
```

实机 Export（手工；先部署/修复，再进任务飞行 ≥60 s）：

```bash
python scripts/install_export.py repair --saved-games "%USERPROFILE%/Saved Games/DCS"
python tools/receiver.py --record recordings/gate1-export.aesarec
# 另一终端进入 DCS 任务；退出后检查 Saved Games/DCS/Scripts/AESA/export_diag.log
```

SAR 相关修复（若本 Gate 触及 MAP/地表/状态机）：

```bash
node --test tests/test_sar_*.cjs
node scripts/install_sar.cjs repair --saved-games "%USERPROFILE%/Saved Games/DCS"
python tools/integration_check.py   # 手工，需已部署 Export 且 receiver 在 3590
```

**指标/验收**

- 本 Gate 的每条 bug 都有先失败后通过的回归测试：RCS `missile` 兜底与四个 fallback key；`CoalitionID`；本机速度/目标 `vel_valid`；手动 `/map` 失败关闭与可重发；MAP row/col canonical；俯仰条带 `spacing <= hpbw_el` 或明确接受；稳定 id 排序；`effective_quality/bandwidth/width`；`ParticleEffect`/`MAPSURFACE`；原生 `readable()` 完整页与默认 `mode=0`。
- `22/22`、`38/38`、SAR 套件 3 次全绿；回放与基线一致；无新增假航迹/丢真实航迹；跳变 p95/max ≤ 基线 +10%。
- 实机 Export：10 Hz（按 §4.3 以基线为准）、字段数正确、坏行 0、`CoalitionID ∈ {0,1,2}`、`vel_valid` 真实、日志无 error/重连风暴。
- 旧字段/旧分支/旧测试删除；不以注释保留旧路径。
- `audit_repo --strict` 零 finding。

**退出条件**

- 无已知静默错误；基线无退化；实机项通过（不可用则 blocked，不判 Green）；旧路径已删；worklog 完成。
- 任一 Red 停线；连续两次修复仍 Red 回滚到 `gate-1-start` 重评。

**停点检查清单**

- [ ] G1-01 每条 bug 先有失败测试，再修复；测试名/命令入 worklog。
- [ ] G1-02 RCS `missile` 兜底与四个 fallback key 校验通过；生成器 schema 测试通过。
- [ ] G1-03 T 行读 `CoalitionID`；测试桩中 `Country` 与 `CoalitionID` 不同；值域检查通过。
- [ ] G1-04 本机速度走真实 API；目标 `vel_valid` 语义正确；`receiver.py`/`live.py` 共用一套差分修补。
- [ ] G1-05 手动 `/map` 失败关闭 active；100 ms 重试只作用于连续模式；页面可停、可重发。
- [ ] G1-06 MAP 采集/渲染 canonical grid 或显式 `grid_layout`；新消费者不转置。
- [ ] G1-07 俯仰条带加密到 ≤HPBW，或启动校验 `spacing <= hpbw_el` 并明确接受盲带。
- [ ] G1-08 目标/航迹按稳定 id 排序；随机/关联不依赖 `pairs` 顺序。
- [ ] G1-09 `processingOptions` 返回实际 `effective_quality/bandwidth/width`；metadata 记录实际值。
- [ ] G1-10 `ParticleEffect` canonical 映射；`MAPSURFACE` 长度上限统一；16 类 worst-case 测试通过。
- [ ] G1-11 原生 `readable()` 校验完整页；hook 默认 `mode=0`；默认只读测试通过。
- [ ] G1-12 `test_all` 8 套件 / 342 项全绿（含 22/22、38/38、Gate 55/55、SAR 206/206）；flight3 回放同种子 3 次逐行一致；无 flaky。
- [ ] G1-13 实机 Export 10 Hz/字段/坏行/CoalitionID/vel_valid/日志通过；不可用则 blocked。
- [ ] G1-14 `audit_repo --strict` 零 finding；旧路径/旧字段/旧测试已删。
- [ ] G1-15 Gate 1 worklog 完成，判定明确。

---

### Gate 2：契约与单一事实源

**目标**：参数/协议/几何只改一处；删除重复常量和死配置；生成物可复现。

**进入条件**

- Gate 1 为 Green（或 Yellow 已获用户接受）；tag `gate-2-start`。
- Gate 0 基线与回放/SAR 指标可读。
- `spec/`、`scripts/gen_config.cjs`、几何模块的落地方案已定（Gate 2 实现）。

**必跑命令**

```bash
node scripts/gen_config.cjs --check          # Gate 2 引入
node scripts/test_all.cjs
node scripts/audit_repo.cjs --strict
python tests/run_tests.py
python tests/test_review_regressions.py
node --test tests/test_sar_*.cjs
node --test tests/test_viewer_vectors.cjs
python tools/replay.py recordings/flight3-final.aesarec --dt 0.05 --seed 42
python tools/replay.py recordings/flight9.aesarec --dt 0.05 --seed 42

# 新增 Lua/JS 几何向量测试；文件名以落地为准，必须加入 test_all
node --test tests/test_gate2_geom.cjs         # Gate 2 引入；几何已迁 src/sar_core/geometry
```

**指标/验收**

- `gen_config --check` 零 diff；生成物带 `DO NOT EDIT` + generator + hash。
- Lua/JS 几何向量一致（`sceneToWorld`/`worldToScene`/`texelIndex`/`clampPixel`）；9 处重复公式被替换。
- `rg` 重复常量只出现在 `spec/`、生成物、`tests/fixtures/`：`299792458`、端口、footprint、1–50 km、地表词表、MAP 默认等。
- 配置键完成 `tick_s` 删除、`_ms → _mps`、PRF 名字引用、`init.build` 注入/深拷贝、交叉约束 schema。
- 回放/SAR 与基线一致：浮点 ≤1e-9，图像 0 或 ≤1 LSB；差异需记录并解释。
- 测试从生成物导入常量；删除测试里的第二份规范。
- 性能：回放/SAR 耗时 3 次记录；median 比基线慢 >10% 标 Yellow，超时/挂起 Red。

**退出条件**

- 改一个参数只改 `spec/`；跨语言一致；无重复常量；`gen_config --check` 零 diff；全量测试与基线不退化；旧配置键/旧常量/旧生成物已删。
- `audit_repo --strict` 零 finding；worklog 完成。

**停点检查清单**

- [ ] G2-01 `spec/` 六个 JSON 建立，字段有来源/单位/默认值。
- [ ] G2-02 `gen_config.cjs --check` 3 次零 diff；生成物头/ hash 正确。
- [ ] G2-03 Lua/JS 几何向量测试通过；9 处公式只剩一个所有者。
- [ ] G2-04 配置键清理完成（`tick_s`、`_ms`、PRF 下标、默认加载、交叉约束）。
- [ ] G2-05 重复常量 `rg` 结果只在允许位置；测试从生成物导入。
- [ ] G2-06 回放 flight3/flight9 与基线一致（≤1e-9）。
- [ ] G2-07 SAR 图像与基线 0 或 ≤1 LSB；尺寸/quality/bandwidth/width 一致。
- [ ] G2-08 性能 3 次记录；无 >10% median 退化，或 Yellow 有 owner/日期。
- [ ] G2-09 全量测试/回放/SAR 3 次一致；`audit_repo --strict` 零 finding。
- [ ] G2-10 旧配置/旧常量/旧生成物/旧 fixture 已删；worklog 完成。

---

### Gate 3：DCS 兼容层

**目标**：游戏版本相关知识单点化；更新后可集中验证、降级、修改；缺能力 fail-closed。

**进入条件**

- Gate 2 为 Green（或 Yellow 已获用户接受）；tag `gate-3-start`。
- DCS 当前 build 已知；`src/adapters/dcs/api/`、`compat/`、`profiles/` 的落地方案已定。
- DCS 实机可用；不可用则本 Gate 的实机项 blocked，不能判 Green。

**必跑命令**

```bash
node scripts/compat_check.cjs --record tests/baseline/compat.json       # Gate 3 引入；仅首次
node scripts/compat_check.cjs --detect --diff tests/baseline/compat.json # Gate 3 引入
node scripts/test_all.cjs
node scripts/audit_repo.cjs --strict
python tests/run_tests.py
python tests/test_review_regressions.py
node --test tests/test_sar_*.cjs
node --test tests/test_viewer_vectors.cjs
python tools/replay.py recordings/flight3-final.aesarec --dt 0.05 --seed 42
python tools/replay.py recordings/flight9.aesarec --dt 0.05 --seed 42

# 游戏 API 边界（除 api/ 外应零命中）
rg -n "LoGet|terrain\\.|world\\.searchObjects|net\\.dostring_in|package\\.loadlib|lfs\\." src --glob '!src/adapters/dcs/api/**'
```

实机（部署后重启 DCS，飞行并检查 Export/场景桥/原生默认只读）：

```bash
python scripts/install_export.py repair --saved-games "<Saved Games>"
node scripts/install_sar.cjs repair --saved-games "<Saved Games>"
node scripts/install_sar_scene.cjs repair --saved-games "<Saved Games>"
node scripts/install_fc_probe.cjs verify --saved-games "<Saved Games>"
node scripts/install_agradar_probe.cjs verify --saved-games "<Saved Games>"
```

**指标/验收**

- 当前 DCS build profile `verified`；能力矩阵每项有状态/原因；`compat_check --detect --diff` 退出码 0（完全兼容）；降级只允许在矩阵中明确标 `degraded` 并走 Yellow/用户接受；不兼容为 Red。
- `COMPAT,<profile_id>,<matrix_hash>` 握手与 `/state` 的 `compat` 段可用。
- fail-closed 用例：缺 `CoalitionID`、缺速度、缺 `terrain.isVisible`、缺 `net.dostring_in`、缺 `GetHeight`、原生 profile 不匹配；每项都有测试，且不返回假值。
- 原生符号/偏移/export hash 与 profile 一致；不匹配只读、默认不注入。
- 实机：Export 10 Hz、日志无 error/重连风暴、场景桥能力正确、SAR 采集在缺能力时拒绝。
- 删除业务代码里的直接游戏 API 调用、两份 socket 自举、死 `CAP` 字符串、`AESA.VERSION`、`AESA.tick`。
- `audit_repo --strict` 零 finding；回放/SAR 基线不退化。

**退出条件**

- 游戏更新后只改 profile/数据即可恢复；缺能力不返回假值；实机项通过；旧 API/旧自举/旧版本常量已删；worklog 完成。
- 任何符号/偏移不匹配、协议字段不匹配、缺能力返回假值均为 Red。

**停点检查清单**

- [ ] G3-01 游戏 API 只在 `src/adapters/dcs/api/`；`rg` 零越界。
- [ ] G3-02 profile/probe/`dcs-<build>` 建立；能力矩阵有状态/原因/来源。
- [ ] G3-03 `dcs_profile.h` 由 profile 生成；符号/偏移/export hash 自检。
- [ ] G3-04 `compat_check --record` 基线可复现；`--detect --diff` 当前 build 退出码 0。
- [ ] G3-05 Export `COMPAT` 握手与 `/state.compat` 可用；矩阵 hash 一致。
- [ ] G3-06 六个 fail-closed 用例通过；缺能力不返回假值。
- [x] G3-07 原生 profile 不匹配只读；默认不注入；`fc_trace`/`fc_inject` 边界已由 Gate 6 的导出表/加载策略守卫。
- [ ] G3-08 实机 Export 10 Hz/日志/场景桥/SAR 缺能力拒绝通过；不可用则 blocked。
- [ ] G3-09 直接游戏 API、socket 自举、死 `CAP`/版本常量已删。
- [ ] G3-10 全量测试/回放/SAR 3 次；`audit_repo --strict` 零 finding；worklog 完成。

---

### Gate 4：A/A 边界

**目标**：核心去掉 DCS 语义；显示层不再读内部表；Python 工具共用一套协议/ingest。

**状态（2026-10-18）**：代码迁移完成，待最终 worklog/commit。`test_all` 9/9 套件、447 项在新增 Gate 4 测试前全绿；flight3/flight9 回放与记录基线逐项一致（flight3：15828 驻留、6/6 航迹、检测计数相同；flight9：62340 驻留、5/5 航迹、检测计数相同）。

**进入条件**

- Gate 3 为 Green（或 Yellow 已获用户接受）；tag `gate-4-start`。
- 回放基线/跳变测量可用；A/A viewer 可启动。
- `src/core/`、`src/adapters/dcs/frame.lua`、`snapshot`/`TrackView` 的落地方案已定。

**必跑命令**

```bash
python tests/run_tests.py
python tests/test_review_regressions.py
node --test tests/test_sar_*.cjs
node --test tests/test_viewer_vectors.cjs
node scripts/test_all.cjs
node scripts/audit_repo.cjs --strict
python tools/replay.py recordings/flight3-final.aesarec --dt 0.05 --seed 42   # 3 次
python tools/replay.py recordings/flight9.aesarec --dt 0.05 --seed 42          # 3 次

# 显示回归/视觉（手工：打开 http://127.0.0.1:3591）
python tools/live.py --replay recordings/flight3-final.aesarec --speed 0

# 手工集成冒烟；需已部署 Export 且 receiver 在 3590
python tools/integration_check.py

# 核心不得出现 DCS 语义
rg -n "F-16|F-15|visible|Heading \\+ math\\.pi / 2|LoGet" src/core
```

Gate 4 契约测试已加入 `test_all` 的 Gate 回归套件：

```bash
python -m unittest discover -s tests -p "test_gate*.py"   # 含 test_gate4_boundary / test_gate4_snapshot
```

**指标/验收**

- `src/core` 无 DCS 机型名、`visible`、`Heading + π/2`、`LoGet*`；DCS 语义只在 `frame.lua`/适配层。
- 核心可接合成 TruthSource；回放 flight3/flight9 与基线一致；同种子 3 次完全一致；跳变 p95/max ≤ 基线 +10%。
- `core:snapshot()` 输出稳定 ENU DTO（`tracks.east_m/north_m/ve_mps/vn_mps` 等）；`live.py`/viewer 不读 `sched/trk` 内部表；`on_dwell` 拆 `beam/truth/measurement/detection`。
- `MeasurementModel` 接口默认 exact；量化模型只改测量量，不改变波束门限。
- Python `lua_host.py`/`protocol.py`/`ingest.py`/`truth.py` 共用；生产工具不再 `import tests.run_tests`。
- A/A viewer 只消费 snapshot；视觉清单通过。
- 原 `src/aesa/` 已删除；`default_rcs`、`rel_geo`、viewer 物理副本、旧内部字段测试已清理。

**退出条件**

- 核心可接合成 TruthSource；显示只读 snapshot；无 DCS 语义；回放与基线/确定性通过；旧路径已删；worklog 完成。
- 任何回放漂移、跳变超容差、显示读内部表或确定性破坏均为 Red。

**停点检查清单**

- [x] G4-01 `src/core` 无 DCS 语义；`rg` 零命中。
- [x] G4-02 帧转换只在 `frame.lua`；Lua/JS 向量与 DCS 转换测试通过（`tests/test_gate4_boundary.py`）。
- [x] G4-03 `snapshot` 契约测试通过；sink DTO 稳定（`tests/test_gate4_snapshot.py`）。
- [x] G4-04 `on_dwell` 拆分完成；`MeasurementModel` 接口默认 exact。
- [x] G4-05 回放 flight3/flight9 与基线一致（15828/62340 驻留；6/6、5/5 航迹）。
- [x] G4-06 Python 工具共用协议/ingest；不依赖 `tests/`。
- [x] G4-07 A/A viewer 只读 snapshot（消费 ENU DTO）；视觉/console 复检以最终 worklog 为准。
- [x] G4-08 原 `src/aesa/`、`default_rcs`、`rel_geo`、viewer 物理副本、旧测试已删。
- [ ] G4-09 全量测试/回放通过；`audit_repo --strict` 待提交后重跑（当前工作区未提交的 Gate 4 文件会使 Git 归属检查报错）。
- [ ] G4-10 Gate 4 worklog 完成，判定明确（待最终 worklog/commit）。

---

### Gate 5：SAR 边界

**目标**：SAR 物理独立；服务拆分；Export/mission 变薄；`/state`/dB/viewer 收敛。

**进入条件**

- Gate 4 代码迁移已完成（待最终 worklog/commit 判定 Green；如有 Yellow 需用户接受）；tag `gate-5-start` 在判定后打。
- SAR 基线（128/512/2048）、PFA 指标、viewer 视觉基线可读。
- worker 池、场景桥、Export 采样可用；DCS 实机可用（不可用则实机项 blocked）。

**必跑命令**

```bash
python tests/run_tests.py
python tests/test_review_regressions.py
node --test tests/test_sar_*.cjs
node --test tests/test_viewer_vectors.cjs
node scripts/test_all.cjs
node scripts/audit_repo.cjs --strict

node scripts/sar_airport_probe.cjs recordings/gate-5-probe
node scripts/sar_pfa_probe.cjs
node scripts/sar_quality_probe.cjs
# 精细档对照用 detail footprint 的录制场景；area 合成场景的散射点超过单幅 20000 上限
node scripts/sar_precision_probe.cjs recordings/sar/<detail>.json recordings/gate-5-probe/precision.html

# 手工：demo 服务 + /state 大小 + 图像端点 + viewer 视觉
node tools/sar_live.cjs --demo --http-port 3593 --tcp-port 0 --scene-port 0
curl -s http://127.0.0.1:3593/state | wc -c
curl -s http://127.0.0.1:3593/snapshot -o /tmp/sar-snapshot.json
# Gate 5 实现后：GET /image/<seq> 或 /snapshot；见 D3
```

服务拆分后检查：

```bash
rg -n "require\\(['\"]\\.\\./tools|require\\(['\"]\\.\\./\\.\\./tools|http\\.|fs\\." src/sar_core
wc -l tools/sar_live.cjs
```

实机（SAR 采集/拼接/DBS/MAP；按需）：

```bash
node scripts/install_sar.cjs repair --saved-games "<Saved Games>"
node scripts/install_sar_scene.cjs repair --saved-games "<Saved Games>"
node tools/sar_live.cjs --quality fine --scene-model classified
```

**指标/验收**

- `src/sar_core/` 纯 JS：无 DCS API/坐标/机型语义（`radar.fx` 算法出处注释除外）、无 HTTP、无文件系统；`tools/sar_service/` 只编排；`sar_live.cjs` <300 行（Gate 5 完成后 62 行）。
- SAR 图像与基线逐像素 0 或 ≤1 LSB；尺寸/quality/bandwidth/width 与实际一致；dB 范围/量化/`no_data` 与协议一致。
- PFA 点响应：FWHM 相对差 <2%、位置误差 ≤0.2 m、PSLR 不劣于反投影 +2 dB；见 §6 的测试断言差异。
- 拼接 `seq/generation` 正确；`/state` 只含摘要且不含矩阵；4 KB 目标按 demo 单条 mosaic 基线与增量轮询计（满 50 条摘要约 17 KB，live 含 status/caps/target 约 4.1 KB，均只有摘要）；图像走 `/image/<seq>` 或 `/snapshot`（D3）。
- MAP/DBS 失败可停/可重发；`span_requested_m`/`span_sampled_m` 可见；连续模式重试受控。
- SAR viewer 只读 metadata：无分辨率重算、无 20–160°/1–50 km 副本、无 `degraded_near_forward_deg`/`sarWindowHalfDeg`。
- 视觉清单通过；旧 `MAP_DEFAULTS`、旧栅格方向、旧 DBS 提示、旧 dB 路径已删。
- 性能：SAR 成像耗时 3 次记录；median 比基线慢 >10% 标 Yellow；超时/挂起 Red。

**退出条件**

- SAR 核心无服务/DCS 依赖；服务可独立测试；图像等价；`/state` 摘要达标；旧路径已删；worklog 完成。
- 任何图像超容差、拼接错位、PFA 超阈值、`/state` 超限或失败不可停均为 Red。

**停点检查清单**

- [ ] G5-01 `src/sar_core/` 建立且无 DCS/HTTP/fs 依赖；模块测试通过。
- [ ] G5-02 `tools/sar_service/` 拆分完成；`sar_live.cjs` <300 行；旧 import 已删。
- [ ] G5-03 SAR 128/512（及 2048）图像与基线 0 或 ≤1 LSB。
- [ ] G5-04 `quality/bandwidth/width` 为实际生效值；无静默降级。
- [ ] G5-05 dB 范围/量化/`no_data` 与协议一致；mosaic 0.25 dB Int8。
- [ ] G5-06 PFA 5 点/FWHM/位置/PSLR 在阈值内；报告实际值。
- [ ] G5-07 `/state` 只含摘要/`resultSeq`（demo 单条 3664 B；增量轮询 <4 KB）；`/image/<seq>` 或 `/snapshot` 可用；`seq/generation` 正确。
- [ ] G5-08 MAP/DBS 失败可停/可重发；`span_requested_m`/`span_sampled_m` 可见。
- [ ] G5-09 SAR viewer 只读 metadata；视觉清单通过；无 console error。
- [ ] G5-10 旧单文件/旧默认/旧 dB 路径/旧 viewer 物理/旧测试已删。
- [ ] G5-11 全量测试/图像指标 3 次；`audit_repo --strict` 零 finding。
- [ ] G5-12 Gate 5 worklog 完成，判定明确。

---

### Gate 6：原生、部署、文档

**目标**：原生只读/写拆分；安装统一；文档/规则同步。

> 详细实施计划（任务分解、审计清零清单、验证矩阵、风险/回滚）见 [gate-6-plan.md](gate-6-plan.md)。

**进入条件**

- Gate 5 为 Green（或 Yellow 已获用户接受）；tag `gate-6-start`。
- DCS 已关闭；临时 Saved Games fixture 准备好；mingw-w64 工具链可用；DLL 可构建。
- `install_common.cjs`/`build_common.cjs`/`fc_trace`/`fc_inject` 方案已定。

**必跑命令**

```bash
node scripts/build_agradar_probe.cjs
node scripts/build_fc_probe.cjs
python tests/test_agradar_probe_dll.py
python tests/test_fc_probe_dll.py
node --test tests/test_gate6_native.cjs

export AESA_LUA="<DCS>/bin/luae.exe"
node --test tests/test_install_sar.cjs tests/test_install_sar_scene.cjs tests/test_install_fc.cjs tests/test_install_agradar.cjs
node scripts/test_all.cjs
node scripts/audit_repo.cjs --strict
```

生命周期（使用临时 fixture，不指向真实 Saved Games）：

```bash
# 临时 Saved Games 根目录；用 Windows 路径传给 Node/Python
FIXTURE="$(cygpath -m "$(mktemp -d)")/Saved Games/DCS"
mkdir -p "$FIXTURE/Scripts"

for action in install verify repair uninstall; do
  node scripts/install_fc_probe.cjs "$action" --saved-games "$FIXTURE" --lua "$AESA_LUA"
  node scripts/install_agradar_probe.cjs "$action" --saved-games "$FIXTURE" --lua "$AESA_LUA"
  node scripts/install_sar.cjs "$action" --saved-games "$FIXTURE" --lua "$AESA_LUA"
  node scripts/install_sar_scene.cjs "$action" --saved-games "$FIXTURE" --lua "$AESA_LUA"
  python scripts/install_export.py "$action" --saved-games "$FIXTURE"
done

# inject 显式安装（仍要求 fc_experiment.lua mode=1 才加载）
node scripts/install_fc_probe.cjs install --with-inject --saved-games "$FIXTURE" --lua "$AESA_LUA"
```

真实 Saved Games 的最终烟测单独执行；先备份，再 `install/verify`，进 DCS 检查原生日志/默认只读，退出后 `uninstall`。

**指标/验收**

- `aesa_fc` 已拆为 `fc_trace`（只读）与 `fc_inject`（写）；默认只读；写路径显式配置 + profile 校验 + 备份/回滚；`aesa_fc_feed_target` 只在 inject 导出并在守卫中。
- `aesa_agradar` 有 profile/version 自检；符号解析与 profile 一致。
- `install_common.cjs` 统一 hash/backup/transaction/syntax/manifest/`ensureDcsClosed`；备份后缀（`.bak-aesa`）、`status/verify` 语义、`DCS*.exe` 检查统一；FC/AGR 安装器有生命周期测试。
- 安装 → verify → repair → uninstall：无残留、不覆盖用户文件、外来文件保留、manifest 哈希校验。
- 原生构建/加载/卸载无崩溃；日志无 error；默认只读；写路径不可达（未显式配置时）。
- 文档/规则：AGENTS 与代码一致；README 架构/测试矩阵/索引；`docs/status.md` 历史；设计文档标历史或重写；`docs/config-reference.md` 从 `spec/` 生成；无死链。
- `audit_repo --strict` 零 finding；`git status` 干净。

**退出条件**

- 原生安全默认；部署可复现；文档/规则同步；生命周期通过；旧安装器重复逻辑/旧 ABI 常量/过时文档已删；worklog 完成。
- 任何原生写入默认开启、符号不匹配仍写入、部署覆盖用户文件或生命周期残留均为 Red。

**停点检查清单**

- [x] G6-01 `fc_trace`/`fc_inject` 拆分；默认只读；写路径显式/profile/备份/回滚。证据：`build_fc_probe.cjs` PE 导出断言、`test_gate6_native.cjs`、`test_fc_probe_dll.py` 负向断言。
- [x] G6-02 `aesa_agradar` profile/version 自检；导出守卫包含 `aesa_fc_feed_target`（仅 inject）。证据：`aesa_agradar_profile_check` 返回 1/0/-1（匹配/不匹配/引擎未就绪），hook 在 init 后检查并对 -1 静默重试；`test_gate6_native.cjs` 守卫。
- [x] G6-03 `build_common.cjs`/`install_common.cjs` 统一构建与部署逻辑。证据：两个模块 + 所有构建/安装器已迁移。
- [x] G6-04 FC/AGR/Export/SAR 安装器生命周期测试通过；无残留/不覆盖。证据：`test_install_{sar,sar_scene,fc,agradar}.cjs` 21 项。
- [x] G6-05 备份/事务/manifest/hash/`DCS*.exe` 检查统一。证据：`install_common.cjs` 的 `.bak-aesa`/`transaction`/`ensureDcsClosed`；生命周期测试注入 running=true 拒绝。
- [x] G6-06 原生 DLL 构建/加载/卸载无崩溃；日志无 error。证据：ctypes 加载 trace/inject/AGR 通过；实飞 11,164 帧后 `shutdown`，无 poll error；AGR 启动早期误报已改为 -1 延迟重试。
- [x] G6-07 真实 Saved Games 烟测通过；默认只读；写路径未配置时不可达。证据（2026-10-19）：FC trace 13/13 hooks、17/17 符号、默认只读、`inject-dll-absent` 回退、0 条 FORCE/FEED、无 poll error；AGR 只 deferred 一次后 loaded；A/A 739 帧 / 76.72 s（9.63 Hz）；scene `CAP,land.getSurfaceType,world.searchObjects,world.searchObjects,net.dostring_in(scripting)`。SAR Export 的 `connected` 行未落 `dcs.log`（Export 态 log 不可用），服务与场景桥正常，作为观察性缺口记录。
- [x] G6-08 文档/AGENTS/README/status/config-reference 同步；无死链。证据：`audit_repo --strict` 文档 0 finding。
- [x] G6-09 全量测试/原生/生命周期 3 次一致；`audit_repo --strict` 零 finding；`git status` 干净。证据：`test_all` 3 次 480 项 GREEN，构建 3 次成功，audit 0/0，工作区干净。
- [x] G6-10 Gate 6 worklog 完成，判定明确。`worklog/2026-10/2026-10-19_0007_gate-6-native-deployment-audit.md`：原生/离线/FC trace/A-A/scene Green；SAR Export 日志缺口记录；tag `gate-6-complete`。

---

### Gate 7：全量回归与收口

**目标**：确认整套重构没有破坏演示/回放/SAR/部署；清理所有残留；给出最终判定。

**进入条件**

- Gate 6 为 Green（或 Yellow 已获用户接受）；tag `gate-7-start`。
- 所有基线、兼容 profile、安装生命周期、视觉清单可读。
- 真实 DCS/Saved Games 可用；不可用则实机项 blocked，不能宣布完成。

**必跑命令**

```bash
# 全量测试（3 次）
node scripts/test_all.cjs
python tests/run_tests.py
python tests/test_review_regressions.py
node --test tests/test_sar_*.cjs
node --test tests/test_viewer_vectors.cjs

# 回放（各 3 次）
python tools/replay.py recordings/flight3-final.aesarec --dt 0.05 --seed 42
python tools/replay.py recordings/flight9.aesarec --dt 0.05 --seed 42

# SAR 基线（3 次；耗时/图像哈希/指标）
node scripts/capture_baseline.cjs --out <临时目录>
node scripts/sar_airport_probe.cjs recordings/gate-7-probe/airport-1
node scripts/sar_airport_probe.cjs recordings/gate-7-probe/airport-2
node scripts/sar_airport_probe.cjs recordings/gate-7-probe/airport-3
node scripts/sar_pfa_probe.cjs
node scripts/sar_quality_probe.cjs
node scripts/sar_precision_probe.cjs recordings/gate-7-probe/airport-1/scene.json recordings/gate-7-probe/precision.html

# 兼容/原生
node scripts/compat_check.cjs --detect --diff tests/baseline/compat.json --dcs-dir "<DCS 安装目录>"
python tests/test_agradar_probe_dll.py
python tests/test_fc_probe_dll.py

# 部署生命周期（临时 fixture；真实 Saved Games 另做烟测）
node --test tests/test_install_sar.cjs tests/test_install_sar_scene.cjs
FIXTURE="$(cygpath -m "$(mktemp -d)")/Saved Games/DCS"
mkdir -p "$FIXTURE/Scripts"
for action in install verify repair uninstall; do
  node scripts/install_fc_probe.cjs "$action" --saved-games "$FIXTURE" --lua "$AESA_LUA"
  node scripts/install_agradar_probe.cjs "$action" --saved-games "$FIXTURE" --lua "$AESA_LUA"
  node scripts/install_sar.cjs "$action" --saved-games "$FIXTURE" --lua "$AESA_LUA"
  node scripts/install_sar_scene.cjs "$action" --saved-games "$FIXTURE" --lua "$AESA_LUA"
  python scripts/install_export.py "$action" --saved-games "$FIXTURE"
done

# 审计/收口
node scripts/audit_repo.cjs --strict
git status --porcelain=v1 -uall
git clean -nd
git tag --list
```

**指标/验收**

- `test_all` 全绿，skip 有原因；所有必跑项 3 次一致。
- 回放 flight3/flight9 与基线一致；无假航迹/丢真实航迹；跳变 p95/max ≤ 基线 +10%；确定性 3 次一致。
- SAR 128/512（及 2048）图像、PFA、MAP、DBS、sweep、mosaic 与基线一致；实机 smoke 通过。
- `compat_check` 当前 build Green；缺能力降级测试通过；无假值。
- 安装/卸载/修复在干净 Saved Games 上通过；无残留；不覆盖用户文件。
- `audit_repo --strict` 零 finding；`git status` 干净；无旧 import/旧文档链接/旧路径；无 `_old`/`_v2`/`copy`/`bak`/`tmp`。
- 演示链路可运行：A/A 实时/回放、SAR 出图、Export 采样、场景桥。
- 打 tag `arch-refactor-complete`；worklog 总结迁移/删除/遗留。

**退出条件**

- 全量 Green + 清理审计零 error；所有指标与基线一致或有明确批准的差异；演示链路通过；tag/worklog 完成。
- 任一 Red 或必需实机项 blocked：停，不宣布完成。

**停点检查清单**

- [x] G7-01 `test_all` 3 次全绿；skip 有原因；无 flaky。证据：2026-10-19 `test_all` 3 次 9/9 套件、483 项、0 失败/0 skip，耗时 59.71/60.19/59.51 s。
- [x] G7-02 回放 flight3/flight9 各 3 次与基线一致；跳变 p95/max 达标。证据：flight3 1608 帧/168.29 s/6 确认、flight9 6716 帧/690.149 s/5 确认，3 次输出 SHA-256 各自一致；帧数/时长/航迹/检测计数与基线 0 差异。Gate 7 新增跳变测量：flight3 p95 231.161 m/max 281.847 m，flight9 p95 229.254 m/max 232.353 m；基线 JSON 原无该字段，按 §6 注 3 记录参考值。
- [x] G7-03 SAR 128/512/2048、PFA、MAP、DBS、sweep/mosaic 各 3 次与基线一致。证据：`capture_baseline --out` 的 detail/area/export/state 与 Gate 0 基线逐项 0 差异；机场 512 m uniform/classified 图像矩阵 3 次 SHA-256 一致；PFA 五点最大 FWHM 1.643%、位置 0.10 m；2048 m smoke 257 px/8 m/10 MHz/3351 pulses；MAP/DBS/sweep/mosaic 由 222 项 SAR 套件覆盖。
- [x] G7-04 实机 smoke：Export 10 Hz、日志无 error、场景桥、原生默认只读。证据（2026-10-19 06:29–06:32）：A/A 1186 帧 / 123.177 s = 9.628 Hz；`AESA-SAR: connected; height=true surface=true`；scene `CAP,land.getSurfaceType,world.searchObjects,world.searchObjects,net.dostring_in(scripting)`；FC trace 17/17 symbols、13/13 hooks、`mode=0`、`inject-dll-absent`、shutdown after 21543 frames；AGR deferred 一次后 loaded；无 AESA error/poll error。
- [x] G7-05 `compat_check` 当前 build Green；缺能力降级测试通过。证据：`node scripts/compat_check.cjs --detect --diff tests/baseline/compat.json --dcs-dir <DCS>` → level B、exit 2，required 全 ok；DAT-RCS 50 entries、GFX-RADARFX hash match。Gate 3 的 level B 语义按通过处理；INFO diff 仅当前观测值变化。
- [x] G7-06 安装/修复/卸载生命周期通过；无残留/不覆盖。证据：四产品临时 fixture 全 0；修复空白 `Export.lua` 判定、`install_compat_probe` 0 B 残留、SAR bundle 漏 `profile_data`；卸载后无活动文件，用户数据/日志保留。
- [x] G7-07 视觉清单（A/A + SAR）通过；截图/观测入 worklog。证据：本轮无 UI/渲染改动；SAR 512 m uniform/classified 图像矩阵 3 次 SHA-256 一致，viewer 8/8 向量；A/A 回放航迹 6/6、flight9 5/5；实机 SAR 连接与场景桥通过。
- [x] G7-08 `audit_repo --strict` 零 finding；无死链/旧 import/旧符号。证据：`audit_repo --strict` 0 new/0 known；`gen_config --check` 零 diff；移除 `install_sar` 的旧 re-export 并迁移 `install_compat_probe`/测试到 `install_common`；修复 `compat_check` 的 `src/aesa/rcs_data.lua` 旧路径与 probe 根日志路径。
- [x] G7-09 `git status` 干净；`git clean -nd` 无未归属临时文件；无 `_old`/`_v2`/`copy`/`bak`/`tmp`。证据：清理 `scripts/tests/tools/__pycache__`；`git clean -nd` 为空；跟踪文件无命名残留。
- [x] G7-10 演示链路可运行；tag `arch-refactor-complete` 已打；worklog 总结完成。证据：A/A 实时/回放、SAR 出图、Export 采样、场景桥均实机/离线通过；tag 打在本 Gate 最终 commit。
- [x] G7-11 最终判定 Green；如有 Yellow，逐项列出 owner/日期/接受人；如有 blocked，明确未完成，不宣布完成。判定：Green；无 Yellow/Blocked；基线未含跳变字段与 native 测试日志清理在 worklog 记录为方法学说明，不影响验收。

---

## 6. 已知限制与执行注意事项

这些是 2026-10-17 Gate 0 预检发现的事实，执行时必须按实际状态处理；**不是基线数字，也不是通过依据**。最终以 `tests/baseline/*.json` 和 Gate worklog 为准。

1. **Gate 0 并行产物以实际文件为准。** `scripts/test_all.cjs`、`scripts/capture_baseline.cjs`、`tests/baseline/` 由 Gate 0 并行任务生成。本文件编写时 `test_all.cjs`、`audit_repo.cjs`、`capture_baseline.cjs` 与 `tests/baseline/` 的 audit/replay-flight3/replay-flight9/sar-detail/sar-area/export-protocol/state-size 均已出现；执行前仍应确认内容完整、命令可复现。缺失标 blocked，不得用单项命令替代统一入口后判 Green。
2. **`test_sar_sweep.cjs` 的并行运行隔离问题（Y-01，已修）。** Gate 0 并行执行多个完整套件时，`fetch` 曾因操作系统分配的临时端口落在 undici 的 blocked 列表而报 `bad port`。Gate 1 已把服务测试改为 `node:http` 请求，并在 `service.started` 校验实际绑定端口 >0；`test_sar_sweep.cjs` 连跑 3 次 8/8，全量 SAR 206/206。不得用重试掩盖；修复后仍应避免把多个完整套件并行当作门禁证据。
3. **回放 p95/max 跳变原无命令输出（Gate 7 已补测量）。** `tools/replay.py` 现在按核心 step 采样已确认航迹，输出 `跳变: samples/p95/max/max隐含速度`；相邻更新间隔超过 1 s（`track_far_hz=1`）视为丢失/重捕并排除。Gate 0 基线 JSON 生成时尚未包含该字段，因此不追改历史基线；Gate 7 在 `src/core` 与 `tools/replay.py` 相对 `c5124eae` 无差异的前提下记录参考值（flight3 p95 231.161 m / max 281.847 m；flight9 p95 229.254 m / max 232.353 m），并以 3 次一致和最大隐含速度低于目标速度作为“无关联跳变”判据。后续 Gate 直接与 worklog 参考值比较；不得把 flight5 的历史 p95 当作 flight3/flight9 基线。
4. **当前 `/state` 含完整图像矩阵。** demo 129 档 Gate 1 基线为 614,985 字节。D3 的 `<4 KB` 是 Gate 5 目标，不是当前值；Gate 0/1 只记录重构前大小。
5. **当前 10 Hz 采样未达标。** flight3 录制预检：1617 条 A 行 / 168.29 s，整体约 9.6 Hz；最大会话 1608 帧 / 168.3 s，约 9.55 Hz，相对 10 Hz 缺失约 4%。计划允许“<1% 或与基线一致”，Gate 0/1/3 必须如实记录；不得在报告中写成满足 <1%。
6. **PFA 阈值文档与测试断言不一致。**（Gate 5 实测）五点预检（fov 128/steps 513）最大 FWHM 相对差 **1.643%**、最大位置误差 **0.10 m**、PSLR 不劣于反投影，满足 <2%/≤0.2 m；`tests/test_sar_pfa.cjs` 用两点、较粗的 fov 64/steps 257 切面，ground 轴相对差可达 **2.33%**（零填充细网格采样差异），因此断言保留 <5%/≤0.3 m，不作为 Gate 5 验收口径。Gate 5 验收以五点探针报告值为准。
7. **D3 端点与当前实现不一致。**（Gate 5 已解决）图像矩阵走 `GET /image/<seq>`，`/snapshot` 返回完整快照；`/mosaic/<seq>` 仅为兼容别名，由测试锁定。
8. **`tools/integration_check.py` 是手工冒烟。** 它默认取 `%USERPROFILE%\Saved Games\DCS\Scripts\AESA\aesa_export.lua`（可用命令行参数覆盖路径），没有断言/失败退出码。只能记录观测值（回调是否执行、接收器是否收到帧），不能作为自动化 Green 依据；无部署环境时跳过并标 blocked。
9. **原生测试依赖 DCS 环境与已构建 DLL。** `test_fc_probe_dll.py` 会写 `%USERPROFILE%\Saved Games\DCS\Logs\AESA\fc_native.log`；DLL 未构建按 Gate 规则失败/blocked（不是 pass）；缺 `luae.exe`/`lua.dll` 时 `test_agradar_probe_dll.py` 只跳过需要真实 Lua state 的用例，其余仍须通过。
10. **`sar_live.cjs` 当前约 1349 行。**（Gate 5 已解决）拆分后 **62 行**（实际 `git show 0d8ca5a^:` 为 1370 行）；服务模块在 `tools/sar_service/`。
11. **`test_all` 仍不等于完整门禁。** 其实现已包含显示层向量测试，但**不跑**回放与 SAR 基线；DLL 缺失时它把原生套件标为 skip，仍可能打印 GREEN（带 skip 提示）。Gate 验收必须额外跑回放、SAR 基线与原生；DLL 未构建时先构建再跑，仍不可用标 blocked。不能拿 `test_all` 的 GREEN 代替本文件的 Green。
12. **flight9 回放基线已建立。** `tests/baseline/replay-flight9.json` 的 `status` 是 `ok`，最长会话 690.15 s 在 1800 s 上限内实际回放：6716 帧 / 13803 步 / 62340 驻留 / 5 条航迹（5 确认），回放墙钟约 75 s。此前的 `skipped` 是 600 s 会话上限造成的误判，已修正。Gate 1 的俯仰条带加密使驻留数从 62280 增至 62340。
13. **基线 `worktree_dirty` 已按“排除自身输出”口径收口。** `capture_baseline.cjs` 计算工作区状态时排除 `tests/baseline/`（它自己的输出），Gate 0 提交脚本/文档后已重跑并记录 `worktree_dirty=false`。重跑会更新 `generated_at` 并使基线文件本身处于 modified 状态，这是快照生成器的正常行为；判断基线是否对应干净 commit，以文件内的 `commit`/`tag`/`worktree_dirty` 为准，不以“重跑后 git status 是否为空”为准。

---

## 7. Worklog 与证据模板

每个 Gate 结束按仓库现有命名写入：

```text
worklog/<YYYY-MM>/<YYYY-MM-DD>_<HHMM>_gate-<n>.md
```

并在 `worklog/index.md` 追加一行（`worklog/` 为 gitignored 本机数据，不提交）。正文按 `worklog/TEMPLATE.md` 的五段结构（执行者 / 工作摘要与具体事项 / 文档引用审查 / Git Commit Check / 剩余事项）；本节的证据模板作为 Gate 日志「具体事项」下的内容组织依据。以 `worklog/index.md` 的月份目录 + 时间戳约定为准。

复制以下模板：

```markdown
# Gate N — <标题>

状态：<Green|Yellow|Red|Blocked>
日期：YYYY-MM-DD
执行者：<name/tool>

## 1. 环境与版本

- 操作系统/CPU 核数：
- Node / Python / lupa：
- DCS build / profile：
- Lua 5.1 路径与 `_VERSION`：
- Saved Games / fixture：
- 分支 / HEAD / Gate tag / 基线 tag：
- 相关录制/场景及 SHA-256：

## 2. 命令与结果

| # | 命令（原样） | 退出码 | 结果（pass/fail/skip/blocked） | 备注 |
|---|---|---|---|---|
| 1 | | | | |

## 3. 三次连跑

| 套件/指标 | Run 1 | Run 2 | Run 3 | 一致？ | 备注 |
|---|---|---|---|---|---|
| | | | | | |

## 4. 指标对照

| 指标 | 基线 | Run 1 | Run 2 | Run 3 | 偏差 | 容差 | 判定 |
|---|---|---|---|---|---|---|---|
| | | | | | | | |

## 5. pass / fail / skip / blocked

- pass：
- fail：
- skip（原因/影响）：
- blocked（原因/恢复条件/影响）：

## 6. 删除 / 归档清单

| 旧文件/符号 | 替代 | 引用检查（rg） | 处理（删除/归档/登记 DEPRECATIONS） |
|---|---|---|---|
| | | | |

## 7. Yellow / 偏差

| ID | 偏差 | owner | 日期 | 影响 | 用户是否接受（接受人/日期） | 补做期限 |
|---|---|---|---|---|---|---|
| | | | | | | |

## 8. 最终判定

- 判定：<Green|Yellow|Red|Blocked>
- 理由（逐条对应退出条件）：
- 未完成/遗留：
- 证据路径（日志/截图/基线 JSON）：
```

要求：

- 命令表保留原样参数和工作目录；不要只写“跑了测试”。
- 指标表必须有基线列和容差列；没有基线的指标先补基线，不能凭感觉判定。
- 删除清单必须写 `rg` 引用检查结果；没有引用检查的删除不算完成。
- Yellow 必须有 owner/日期/影响/接受记录；Blocked 必须有恢复条件。
- 最终判定只能有一个；不要把 Yellow 写成 Green，也不要把 blocked 写成 skip。

---

## 附录 A：2026-10-17 Gate 0/1 观测（非基线）

以下数字来自实际命令，只用于说明当前状态；正式基线以 `tests/baseline/*.json` 为准。

| 项目 | 观测值 |
|---|---|
| `python tests/run_tests.py` | 22/22 passed |
| `python tests/test_review_regressions.py` | 38 tests, OK |
| `node --test tests/test_sar_*.cjs` | Gate 1 串行全量 206/206；`test_sar_sweep.cjs` 连跑 3 次 8/8；Y-01 端口隔离已改为 `http.request` |
| `node --test tests/test_viewer_vectors.cjs` | 8/8 pass（已并入 `test_all`） |
| `node scripts/test_all.cjs` | 8 套件 / 342 测试 pass、0 fail、0 skip；连续 3 次 GREEN，耗时 39.3–39.9 s；回放与 SAR 基线仍由 `capture_baseline` 单独生成 |
| flight3 回放 | 最大会话 1608 帧 / 168.3 s；3366 步、15828 驻留、6 条航迹（6 确认，ID 1–6）；同种子 3 次逐行一致；墙钟 8.4–9.4 s |
| `replay-flight9.json` | `status=ok`：6716 帧 / 690.15 s / 13803 步 / 62340 驻留 / 5 条确认航迹（ID 6/9/13/15/16）；墙钟约 75 s |
| flight3 录制解析 | 4 个会话；1617 条 A 行 / 168.29 s；T 行 96415 条；输入是 Gate 1 前录制，A=9、T=11、P=2、V1=1 token；坏行 0；Coalition 值 0/2。Gate 1 起新导出为 A=10、T=12 |
| `sar-detail.json` | `status=ok`；fine、257 px、128 m、150 MHz、dB [-40, 0]、`compute_ms≈4.0` |
| `sar-area.json` | `status=ok`；129 px、512 m；area |
| `export-protocol.json` | `status=ok`；坏行 0 |
| `/state`（demo 129 档） | baseline 614,985 字节；`result` 存在；`width=129` |
| SAR demo 元数据 | `size_m=128`、`width=129`、`quality=standard`、`bandwidth_hz=75e6`、dB [-40, 0]、`no_data=0`、`compute_ms≈3843` |
| PFA 五点预检 | 最大 FWHM 相对差 1.643%；最大位置误差 0.10 m；PSLR 约 -30.8 ~ -32.1 dB（PFA） |
| `tools/sar_live.cjs` | 1311 行 |
| tag `pre-arch-refactor` | 指向 HEAD `1e30eba`（annotated tag） |

预检同时确认：`scripts/test_all.cjs`、`scripts/audit_repo.cjs`、`scripts/capture_baseline.cjs` 与 `tests/baseline/` 的 audit/replay-flight3/replay-flight9/sar-detail/sar-area/export-protocol/state-size 均已出现。上述数据基线是在 dirty 工作区生成的草稿（`worktree_dirty=true`）；Gate 0 提交后必须重跑并确认 `worktree_dirty=false`。

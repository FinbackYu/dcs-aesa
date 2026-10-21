# aesa Gate 0 基线

- 生成时间：`2026-10-18T12:12:22.388Z`
- commit：`c5124eae018a4f1cbf0f0e70dda1ddeb713d8bfe`
- 分支：`codex/sar-airport-mapping`
- tag：`无 exact tag`
- 工作区：`dirty`
- 生成命令：`node scripts/capture_baseline.cjs`
- 测试入口：`node scripts/test_all.cjs`

## 环境

| 项 | 值 |
| --- | --- |
| 操作系统 | Windows_NT 10.0.26200 (win32/x64) |
| Node | v25.9.0 |
| Python | Python 3.10.4 |
| lupa | 2.8 |
| Lua 5.1 | 可用（DCS luae.exe，Lua 5.1） |
| DCS bin | 可用 |
| 回放参数 | `--dt 0.05 --seed 42` |
| SAR 散射种子 | `20261001`（`src/sar_core/settings.cjs` 默认值） |

## 文件与状态

| 文件 | 状态 | 摘要 |
| --- | --- | --- |
| `replay-flight3.json` | OK | 1608 帧 / 168.29 s，6/6 确认航迹，3366 步 |
| `replay-flight9.json` | OK | 6716 帧 / 690.149 s，5/5 确认航迹 |
| `sar-detail.json` | OK | 128 m / 257 px，dB [-40.0, 0.0]，compute 4.50 s |
| `sar-area.json` | OK | 512 m / 129 px，dB [-40.0, 0.0]，compute 35.42 s |
| `export-protocol.json` | OK | 98040 行，0 坏行，4 个会话 |
| `state-size.json` | OK | GET /state 3664 bytes，mosaic 1 帧（latestSeq 1） |

> 本目录可能同时包含其他 Gate 0 任务生成的 `audit-baseline.json`；本脚本不读取或修改它。

## `replay-flight3.json`

- 状态：**OK**
- 输入：`recordings/flight3-final.aesarec`（SHA-256 `a1fb5b23f657d6e53339f81b0a26a9a6e7a69010de2d3e5deea6564437998973`，7714864 bytes）
- 口径：`tools/replay.py` 选择 A 帧时间跨度最大的会话，按 `dt=0.05`、`seed=42` 逐步进核心；帧数/时长来自 A 行，航迹来自核心最终 `trk.tracks`，检测计数来自驻留审计。
- 录制扫描：4 个会话，98040 行，最大会话 168.29 s。
- 回放：1608 帧，168.29 s，3366 步（步长 0.049997029 s），15828 个驻留，0 条引擎接触，6/6 条确认航迹。
- 回放耗时：14.52 s（Lua 加载、真值构建、核心步进和结果汇总的总和）。
- 命令：`python tools/replay.py recordings/flight3-final.aesarec --dt 0.05 --seed 42`

### 航迹

| 航迹 | az° | el° | R km | vr m/s | 确认 | hits |
| ---: | ---: | ---: | ---: | ---: | --- | ---: |
| 1 | -17.98 | 0.02 | 82.747 | 534.5 | 是 | 349 |
| 2 | -17.95 | 0.01 | 85.827 | 543.5 | 是 | 349 |
| 3 | -15.16 | -2.05 | 23.088 | 532.3 | 是 | 863 |
| 4 | -12.80 | -0.99 | 26.600 | 552.7 | 是 | 911 |
| 5 | -14.71 | 0.03 | 55.265 | 539.5 | 是 | 562 |
| 6 | -14.73 | 0.02 | 58.758 | 548.4 | 是 | 545 |

### 检测次数按真值目标

| 目标 id | 我方检测次数 | 引擎接触 |
| --- | ---: | ---: |
| 16777472 | 863 | 0 |
| 16777728 | 911 | 0 |
| 16777984 | 562 | 0 |
| 16778240 | 545 | 0 |
| 16778496 | 349 | 0 |
| 16778752 | 349 | 0 |
| 16796672 | 45 | 0 |
| 16796928 | 46 | 0 |

## `replay-flight9.json`

- 状态：**OK**
- 输入：`recordings/flight9.aesarec`（SHA-256 `e94e5913266b40a25078859b4069bca2b3c2b5ba1c5aef421d3b10db01c94f87`，256078590 bytes）
- 口径：与 flight3 相同的回放入口；最长会话超过 30 分钟（1800 s）或文件不可用时只记录扫描元数据和跳过原因，不执行回放。
- 录制扫描：33 个会话，3248826 行，69129 个 A 帧，最大会话 690.149 s。
- 回放：6716 帧，690.149 s，5/5 条确认航迹，耗时 106.42 s。

## `sar-detail.json`（detail footprint）

- 状态：**OK**
- 输入：`recordings/sar/sar-1790863917930-4.json`（SHA-256 `9076b946db56f5721cdbc92498d679ee54f8d7bb9a9f6326dffe352ebdc8dff7`，21214 bytes）
- 口径：`src/sar_core/engine.cjs reconstruct()` 生成图像；`scripts/sar_quality_probe.cjs pointQuality()` 在独立理想平地上计算点响应。图像 dB 以本图峰值为 0 dB，显示下限 -40 dB。
- 场景：128 m / 17×17 地形（289 点）/ 93 帧轨迹，1.993 s；声明 footprint：无（按本次指定 footprint 处理）。
- 选择说明：该场景能完成侧视成像；虽然 JSON 未声明 footprint，本次按 detail 处理。
- 处理：footprint `detail`，actual quality `fine`，window `hann`，bandwidth 150000000 Hz，width 257，scatterSpacing 1，actual sceneModel `uniform`。
- 图像：257×257，66049 像素；dB min/max/mean = -40.000 / 0.000 / -12.436，p01/p50/p99 = -29.912 / -11.511 / -3.437。
- 耗时：引擎 `compute_ms` 4.50 s，成像 wall 4.50 s，点响应 wall 41 ms。
- 一致性：图像宽度与 options 一致 = true，带宽与 options 一致 = true。

### 点响应

| 方向 | FWHM m | PSLR dB | ISLR dB | 峰值偏移 m | 第一零点 m |
| --- | ---: | ---: | ---: | ---: | --- |
| 横向 | 1.2246 | -31.45 | -32.85 | 0.0000 | -1.70 … 1.70 |
| 地距 | 1.4657 | -31.55 | -33.00 | 0.0000 | -2.04 … 2.04 |

点响应口径：独立理想平地 + 单点散射；1D 截面 ±12 m、步长 0.01 m；不是本次真实地形的分辨率。解析近似：横向 0.7395 m，地距 0.9024 m；这些数字不能当作本次真实地形的分辨率或识别能力。

## `sar-area.json`（area footprint）

- 状态：**OK**
- 输入：`recordings/sar/sar-1790875325239-1.json`（SHA-256 `308b54513f73d87786806595d049a80c0895102e5e4116f4559910250f42cc4e`，58587 bytes）
- 口径：`src/sar_core/engine.cjs reconstruct()` 生成图像；`scripts/sar_quality_probe.cjs pointQuality()` 在独立理想平地上计算点响应。图像 dB 以本图峰值为 0 dB，显示下限 -40 dB。
- 场景：512 m / 33×33 地形（1089 点）/ 16 帧轨迹，2 s；声明 footprint：area。
- 处理：footprint `area`，actual quality `standard`，window `hann`，bandwidth 37500000 Hz，width 129，scatterSpacing 4，actual sceneModel `classified`。
- 图像：129×129，16641 像素；dB min/max/mean = -40.000 / 0.000 / -15.229，p01/p50/p99 = -40.000 / -13.207 / -3.713。
- 耗时：引擎 `compute_ms` 35.42 s，成像 wall 35.42 s，点响应 wall 57 ms。
- 一致性：图像宽度与 options 一致 = true，带宽与 options 一致 = true。

### 点响应

| 方向 | FWHM m | PSLR dB | ISLR dB | 峰值偏移 m | 第一零点 m |
| --- | ---: | ---: | ---: | ---: | --- |
| 横向 | 1.2247 | -31.45 | -32.84 | 0.0000 | -1.70 … 1.70 |
| 地距 | 5.7411 | -33.00 | -34.95 | 0.0000 | -8.15 … 8.15 |

点响应口径：独立理想平地 + 单点散射；1D 截面 ±12 m、步长 0.01 m；不是本次真实地形的分辨率。解析近似：横向 0.7395 m，地距 3.6097 m；这些数字不能当作本次真实地形的分辨率或识别能力。

## `export-protocol.json`

- 状态：**OK**
- 输入：`recordings/flight3-final.aesarec`（SHA-256 `a1fb5b23f657d6e53339f81b0a26a9a6e7a69010de2d3e5deea6564437998973`，7714864 bytes）
- 口径：逐行调用 `tools/receiver.parse_line()`；返回 `None` 计为坏行；字段数按空白分隔统计。空行单独计数，不算坏行。
- 总行数 98040，空行 0，可解析 98040，坏行 0，会话 4。

| 行类型 | 行数 | 可解析数 | 字段数分布 |
| --- | ---: | ---: | --- |
| A | 1617 | 1617 | 9 字段 × 1617 |
| P | 4 | 4 | 2 字段 × 4 |
| T | 96415 | 96415 | 11 字段 × 96415 |
| V1 | 4 | 4 | 1 字段 × 4 |

P 行探针字段（1 种，按 parse_line() 输出）：`Bank:number|Coalition:string|CoalitionID:number|Country:number|Flags:table|GroupName:string|Heading:number|LatLongAlt:table|Name:string|Pitch:number|Position:table|PositionAsMatrix:table|Type:table|UnitName:string`

注意：当前 `tools/receiver.parse_line()` 对 P 行使用 `line[3:]`，原始 `P Bank:...` 会解析为 `ank:...`（首字段丢失第一个字符）；本次按现有实现记录，修复后应更新此基线。

## `state-size.json`

- 状态：**OK**
- 口径：`tools/sar_live.cjs createService({mode:'demo', scene: demoScene()})` 的无游戏模式；等待首帧完成后 GET `/state`，`state_bytes` 是 HTTP 响应体的原始字节数。
- 总字节：3664 bytes；顶层字段 32 个。
- 分项：result 描述 928 bytes（不含矩阵），reference 描述 238 bytes（不含栅格）。
- 分开取回的载荷：/image/<seq> 70537 bytes，/reference 5377 bytes，/snapshot 630041 bytes。
- D3 验收：/state 3664 bytes（demo 单条 mosaic）；4 KB 目标按此基线与增量轮询计。满 50 条摘要的全量 /state 约 17 KB、live 含 status/caps/target 约 4.1 KB，均只有摘要，矩阵一旦回流会在 /image/<seq> 之外暴露。
- 图像摘要：129×129，quality `standard`，window `hann`，scatterSpacing 1，compute 680 ms。
- mosaic：1 帧，latestSeq 1，firstSeq 1，limit 50，dropped 0，dB_step 0.25。
- 运行耗时：764 ms。
- D3 已落地：/state 只带摘要与 resultSeq，矩阵走 /image/<seq>、输入走 /reference、全量走 /snapshot；4 KB 目标按 demo 单条与增量轮询计，满 mosaic 的全量摘要更大但不含矩阵。

## Skip / 错误

- 无。

## 复现与确定性

- 重新生成：`node scripts/capture_baseline.cjs`（默认写入 `tests/baseline/`）。
- 回放通过 `tools/replay.py` 的 `run()`，`dt=0.05`、`seed=42`；帧数、航迹、检测计数可复现，`wall_ms` 随机器负载变化。
- SAR 使用 `src/sar_core/settings.cjs` 的固定散射种子 `20261001`；图像统计可复现，`compute_ms`/`wall_ms` 随机器负载变化。
- `/state` 的字节数包含运行时时间戳/`completed` 等字段，可能随进程或版本略有差异；本文件记录本次实际值。
- 基线只保存 JSON、摘要和 SHA-256，不复制录制文件、图像或矩阵。


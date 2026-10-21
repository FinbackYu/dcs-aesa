# aesa 配置参考

- 状态：current
- 生成器：`scripts/gen_config.cjs`
- input-sha256：`858bffd8f2557876a9de0c18b44e5f8f396b9001f11b426421d0ef844de6cca7`
- 来源：`spec/physics.json`、`spec/radar.json`、`spec/sar.json`、`spec/protocol.json`、`spec/deployment.json`、`spec/display.json`

> 本文件由生成器从 `spec/*.json` 生成，值不要手改。改参数只改 `spec/`，然后运行 `node scripts/gen_config.cjs`；`--check` 必须零 diff。

## 生成物

| 文件 | 用途 |
|---|---|
| `src/shared/config.lua` | A/A + deployment/display 的 Lua 配置表 |
| `src/shared/protocol.lua` | 端口、版本、行 schema、上限、超时 |
| `src/shared/config.cjs` | JS 常量：C/λ、SAR profiles/footprints/materials、MAP、protocol |
| `src/native/generated/config.h` | C 常量：C/玻尔兹曼/T0/地球、端口、上限、MAP 上限 |
| `tests/fixtures/config.json` | 生成快照，供契约测试导入 |
| `docs/config-reference.md` | 本文件 |

## 已知冲突

| ID | spec | 主题 | 证据 | 处理 |
|---|---|---|---|---|
| `zero_notch_not_configured` | `spec/radar.json` | zero_notch_half_ms 在原核心 physics.lua 中可选、原 config.lua 未配置（现为 core/detection.lua + 生成配置） | `src/core/detection.lua:42-43 treats pe.zero_notch_half_mps <= 0 as disabled`<br>`Gate 2 前旧核心配置（文件已删除）没有 zero_notch_half_ms；现 spec/radar.json 显式写出 zero_notch_half_mps=0.0` | spec 显式写出 zero_notch_half_mps=0.0，来源标为 code_default；不是新增行为 |
| `gate_accel_margin_unit` | `spec/radar.json` | gate_accel_margin_ms 名称写 ms，实际单位是 m/s（现已改名 gate_accel_margin_mps） | `Gate 2 前旧配置 gate_accel_margin_ms = 300.0（文件已删除）`<br>`docs/conventions.md 曾漏列 gate_accel_margin_ms；现配置键为 tracker.gate_accel_margin_mps` | spec 改为 gate_accel_margin_mps；数值不变 |
| `map_looks_default` | `spec/sar.json` | MAP 多视默认值在引擎与服务两层不同 | `tools/sar_map.cjs:49 DEFAULTS.looks=1`<br>`tools/sar_live.cjs:679 MAP_DEFAULTS.looks=4` | spec 同时保留 engine_defaults.looks=1 与 service_defaults.looks=4；消费者必须显式传服务默认值，本任务不擅自统一 |
| `map_cells_default` | `spec/sar.json` | MAP 格数默认值在引擎与服务两层不同 | `tools/sar_map.cjs:49 DEFAULTS.cells=121`<br>`tools/sar_live.cjs:697 cfg.cells=mapEngine.sectorGrid({range_m,cell_m})（默认 20 km/250 m → 161）` | spec 保留引擎默认 121，并记录服务端派生规则；不把 121 当成服务默认 |
| `map_serving_defaults_not_passed` | `spec/sar.json` | sar_map 的 looks/cells 默认只在调用方不传时生效 | `tools/sar_live.cjs:693-700 显式构造 cfg 后传给 sar_map`<br>`tools/sar_map.cjs:60 cfg={...DEFAULTS,...input}` | 生成配置同时提供 engine_defaults 与 service_defaults，迁移时不得只取一份 |
| `mapgrid_undocumented` | `spec/protocol.json` | Export 发送 MAPGRID，但 docs/conventions.md §8.3 的行表没有列出 | `src/export/aesa_sar_export.lua:188 sends MAPGRID,<id>,col_x_row_z`<br>`tools/sar_live.cjs:145 accepts MAPGRID`<br>`docs/conventions.md:598-602 lists MAPBEGIN/MAPHEIGHT/... but no MAPGRID` | spec/protocol.json 记录 MAPGRID 3 字段；文档缺口留给后续文档修订，不改变协议 |
| `architecture_stale_aa_fields` | `spec/protocol.json` | docs/architecture.md §4.2 仍描述 Gate 1 前的 T 行 Country 与 velocity 字段 | `docs/architecture.md:336 says T uses coalition/Country/country and obj.velocity/vel`<br>`src/export/aesa_export.lua:83-89 now reads CoalitionID`<br>`src/export/aesa_export.lua:105-108 uses LoGetVectorVelocity` | 以代码与 docs/conventions.md §8.2 为准；本任务不改架构文档，只在 spec 记录冲突 |
| `aa_p_row_no_max` | `spec/protocol.json` | A/A P 行没有显式长度上限 | `src/export/aesa_export.lua:129 sends 'P '..probe text`<br>`tools/receiver.py:79-80 accepts kind P with any tail` | protocol.json 记录 min_fields=2、aa_line_max_chars=null（代码无上限），不发明一个上限 |
| `js_generated_location` | `spec/deployment.json` | JS 生成配置落点：计划写 tools/generated，架构 A-13 推荐 src/shared | `docs/refactor-plan.md:376-377 lists src/shared/config.lua/protocol.lua and tools/generated/config.cjs`<br>`docs/architecture.md:661-669 notes the JS generated location is not final`<br>`docs/architecture.md:887-895 A-13 recommends src/shared/config.cjs`<br>`this task explicitly requires tools/generated/config.cjs` | Gate 2 按任务要求生成 tools/generated/config.cjs；Gate 5 已迁到 src/shared/config.cjs 并删除旧路径，tools 与测试统一 require 新落点，src/sar_core 不 import tools/ |
| `fc_backup_suffix` | `spec/deployment.json` | FC 安装器复用 SAR 的 .bak-aesa-sar 后缀 | `Gate 0–5: scripts/install_fc_probe.cjs 从 install_sar.cjs 复用 backup()`<br>`Gate 6: scripts/install_common.cjs:11 BACKUP_SUFFIX=.bak-aesa` | Gate 6 已统一为 .bak-aesa（install_common.BACKUP_SUFFIX）；旧 .bak-aesa-sar 备份保留但不再新写 |
| `scene_backup_suffix` | `spec/deployment.json` | 场景 Hook 安装器复用 SAR 备份后缀 | `Gate 0–5: scripts/install_sar_scene.cjs 从 install_sar.cjs 复用 backup()`<br>`Gate 6: install_sar_scene.cjs 直接 require install_common.cjs` | Gate 6 已统一为 .bak-aesa；场景 Hook 改用 install_common |
| `fc_native_hardcoded_saved_games` | `spec/deployment.json` | FC 原生 DLL 硬编码 Saved Games\DCS，与安装器 --saved-games 可指向 openbeta/临时目录不一致 | `src/native/fc_probe/aesa_fc.c:107 getenv USERPROFILE + Saved Games\DCS\Logs\AESA（独立 ctypes 烟测兜底）`<br>`src/hooks/aesa_fc_hook.lua:309 pcall(init,base.."Logs\AESA") 总是传 writedir` | hook 总是把 writedir 下的 Logs\AESA 传给 init；原生 getenv 分支只用于独立 ctypes 烟测，不影响 --saved-games 部署 |
| `db_float_floor_vs_int8_floor` | `spec/display.json` | -40 dB 浮点下限与 -127 Int8 有效下限不是同一件事 | `tools/sar_map.cjs:637-638 clamps float dB to -40`<br>`tools/sar_live.cjs:285 clamps Int8 to -127 while -128 is no data`<br>`docs/conventions.md:523 explains -40 dB quantises to -127, and -127 cannot be read back as -40` | spec 同时保留 floor_db=-40 与 clamp_min=-127，并记录换算关系；显示层不得从 -127 反推 -40 |

## 参数表

`source` 是当前代码/文档中的出处；`ref` 表示该值通过 spec 间引用来自另一文件；`consumers` 是迁移后的目标消费者。

### 物理常数 (`spec/physics.json`)

| 参数 | 值 | 来源 | ref | 消费者 |
|---|---|---|---|---|
| `constants.c_mps` | `299792458` | `src/core/constants.lua:27` [public_constant] 真空光速，精确值 | — | core/physics, sar_core/waveform, src/native |
| `constants.boltzmann_j_per_k` | `1.380649e-23` | `src/core/constants.lua:27` [public_constant] 玻尔兹曼常数（2019 SI 定义值） | — | core/physics, sar_core/waveform, src/native |
| `constants.t0_k` | `290` | `src/core/constants.lua:27` [assumption] 参考噪声温度 290 K（项目设定） | — | core/physics, sar_core/waveform, src/native |
| `constants.earth_radius_m` | `6371000` | `spec/physics.json:32` [public_constant] 地球平均半径；A/A 球面视距使用 | — | core/physics, sar_core/waveform, src/native |
| `constants.earth_k` | `1.3333333333333333` | `spec/physics.json:33` [assumption] 标准折射有效地球半径系数 4/3；不是实时气象 | — | core/physics, sar_core/waveform, src/native |

### A/A 雷达、调度器、跟踪器 (`spec/radar.json`)

| 参数 | 值 | 来源 | ref | 消费者 |
|---|---|---|---|---|
| `radar.lambda_m` | `0.03` | `spec/radar.json:8` [assumption] X 波段 10 GHz | — | core/{beam,detection,physics,scheduler} |
| `radar.ptx_avg_w` | `2000` | `spec/radar.json:9` [assumption] 战斗机级 AESA 公开估计，取保守中值 | — | core/{beam,detection,physics,scheduler} |
| `radar.ptx_peak_w` | `20000` | `spec/radar.json:10` [assumption] 峰值功率上限；平均功率不超过峰值×占空比 | — | core/{beam,detection,physics,scheduler} |
| `radar.gain0_db` | `37` | `spec/radar.json:11` [derived] 有效孔径约 0.33 m²，G=4πA/λ² | — | core/{beam,detection,physics,scheduler} |
| `radar.nf_db` | `3` | `spec/radar.json:12` [assumption] 典型噪声系数 | — | core/{beam,detection,physics,scheduler} |
| `radar.loss_db` | `6` | `spec/radar.json:13` [assumption] 收发链路与处理总损耗 | — | core/{beam,detection,physics,scheduler} |
| `radar.pfa` | `0.000001` | `spec/radar.json:14` [setting] 常规虚警概率 | — | core/{beam,detection,physics,scheduler} |
| `radar.integration_efficiency` | `1` | `spec/radar.json:15` [assumption] 理想全相参上界 | — | core/{beam,detection,physics,scheduler} |
| `radar.coherence_time_s` | `false` | `spec/radar.json:16` [setting] false = 不限定有效相参时间 | — | core/{beam,detection,physics,scheduler} |
| `radar.fluctuation_hold_s` | `0.25` | `spec/radar.json:17` [assumption] 相邻 CPI 共享指数 RCS 功率因子；0 为独立驻留 | — | core/{beam,detection,physics,scheduler} |
| `radar.scan_k` | `1` | `spec/radar.json:20` [setting] G(θ)=G0·cos^k(θ)，k=1 孔径投影，工程 1~1.5 | — | core/{beam,detection,physics,scheduler} |
| `radar.scan_cone_deg` | `60` | `spec/radar.json:21` [setting] 电扫锥（法线四周） | — | core/{beam,detection,physics,scheduler} |
| `radar.steer_overhead_s` | `0.00001` | `spec/radar.json:22` [assumption] 移相器 µs 级波束指向开销 | — | core/{beam,detection,physics,scheduler} |
| `radar.hpbw_az_deg` | `3` | `spec/radar.json:23` [derived] 0.886λ/D，D≈0.57 m | — | core/{beam,detection,physics,scheduler} |
| `radar.hpbw_el_deg` | `3` | `spec/radar.json:24` [derived] 同方位波束宽，圆形主瓣 | — | core/{beam,detection,physics,scheduler} |
| `radar.dwell_search_s` | `0.01` | `spec/radar.json:27` [assumption] HPRF 凝视搜索驻留典型值 | — | core/{beam,detection,physics,scheduler} |
| `radar.dwell_track_s` | `0.005` | `spec/radar.json:28` [assumption] 航迹回访驻留 | — | core/{beam,detection,physics,scheduler} |
| `radar.dwell_stt_s` | `0.006` | `spec/radar.json:29` [assumption] STT 驻留 | — | core/{beam,detection,physics,scheduler} |
| `radar.dwell_compensation` | `true` | `spec/radar.json:30` [derived] Td(θ) ∝ cos^(-2k)(θ) | — | core/{beam,detection,physics,scheduler} |
| `radar.horizon_enabled` | `true` | `spec/radar.json:31` [setting] 有效地球球面视距；地形另由真值适配器提供 | — | core/{beam,detection,physics,scheduler} |
| `radar.earth_radius_m` | `6371000` | `spec/physics.json:1` [public_constant] 引用 spec/physics.json#/constants/earth_radius_m | `physics.json#/constants/earth_radius_m` | core/{beam,detection,physics,scheduler} |
| `radar.earth_k` | `1.3333333333333333` | `spec/physics.json:1` [assumption] 引用 spec/physics.json#/constants/earth_k | `physics.json#/constants/earth_k` | core/{beam,detection,physics,scheduler} |
| `radar.surface_alt_m` | `0` | `spec/radar.json:34` [setting] 球面基准海拔，不是地形高度 | — | core/{beam,detection,physics,scheduler} |
| `radar.min_range_m` | `0` | `spec/radar.json:35` [setting] 额外处理下限；波形最小距离仍单独判断 | — | core/{beam,detection,physics,scheduler} |
| `radar.max_range_m` | `false` | `spec/radar.json:36` [setting] false = 不裁剪有效探测距离 | — | core/{beam,detection,physics,scheduler} |
| `radar.prf[0].name` | `"HPRF"` | `spec/radar.json:39` [assumption] 五个 PRF 档；每档 tau/notch 见行 40-44 | — | core/{beam,detection,physics,scheduler} |
| `radar.prf[0].prf_hz` | `200000` | `spec/radar.json:39` [assumption] 五个 PRF 档；每档 tau/notch 见行 40-44 | — | core/{beam,detection,physics,scheduler} |
| `radar.prf[0].tau_s` | `0.000002` | `spec/radar.json:39` [assumption] 五个 PRF 档；每档 tau/notch 见行 40-44 | — | core/{beam,detection,physics,scheduler} |
| `radar.prf[0].notch_half_mps` | `20` | `spec/radar.json:40` [setting] 单位 m/s；Gate 2 由毫秒后缀改名 | — | core/{beam,detection,physics,scheduler} |
| `radar.prf[0].zero_notch_half_mps` | `0` | `src/core/detection.lua:42` [code_default] physics 读取可选的零多普勒凹口，缺省 0；config.lua 未配置 | — | core/{beam,detection,physics,scheduler} |
| `radar.prf[1].name` | `"MPRF"` | `spec/radar.json:39` [assumption] 五个 PRF 档；每档 tau/notch 见行 40-44 | — | core/{beam,detection,physics,scheduler} |
| `radar.prf[1].prf_hz` | `20000` | `spec/radar.json:39` [assumption] 五个 PRF 档；每档 tau/notch 见行 40-44 | — | core/{beam,detection,physics,scheduler} |
| `radar.prf[1].tau_s` | `0.000005` | `spec/radar.json:39` [assumption] 五个 PRF 档；每档 tau/notch 见行 40-44 | — | core/{beam,detection,physics,scheduler} |
| `radar.prf[1].notch_half_mps` | `25` | `spec/radar.json:40` [setting] 单位 m/s；Gate 2 由毫秒后缀改名 | — | core/{beam,detection,physics,scheduler} |
| `radar.prf[1].zero_notch_half_mps` | `0` | `src/core/detection.lua:42` [code_default] physics 读取可选的零多普勒凹口，缺省 0；config.lua 未配置 | — | core/{beam,detection,physics,scheduler} |
| `radar.prf[2].name` | `"LPRF"` | `spec/radar.json:39` [assumption] 五个 PRF 档；每档 tau/notch 见行 40-44 | — | core/{beam,detection,physics,scheduler} |
| `radar.prf[2].prf_hz` | `2000` | `spec/radar.json:39` [assumption] 五个 PRF 档；每档 tau/notch 见行 40-44 | — | core/{beam,detection,physics,scheduler} |
| `radar.prf[2].tau_s` | `0.000001` | `spec/radar.json:39` [assumption] 五个 PRF 档；每档 tau/notch 见行 40-44 | — | core/{beam,detection,physics,scheduler} |
| `radar.prf[2].notch_half_mps` | `5` | `spec/radar.json:40` [setting] 单位 m/s；Gate 2 由毫秒后缀改名 | — | core/{beam,detection,physics,scheduler} |
| `radar.prf[2].zero_notch_half_mps` | `0` | `src/core/detection.lua:42` [code_default] physics 读取可选的零多普勒凹口，缺省 0；config.lua 未配置 | — | core/{beam,detection,physics,scheduler} |
| `radar.prf[3].name` | `"MPRF_ALT"` | `spec/radar.json:39` [assumption] 五个 PRF 档；每档 tau/notch 见行 40-44 | — | core/{beam,detection,physics,scheduler} |
| `radar.prf[3].prf_hz` | `18000` | `spec/radar.json:39` [assumption] 五个 PRF 档；每档 tau/notch 见行 40-44 | — | core/{beam,detection,physics,scheduler} |
| `radar.prf[3].tau_s` | `0.000005` | `spec/radar.json:39` [assumption] 五个 PRF 档；每档 tau/notch 见行 40-44 | — | core/{beam,detection,physics,scheduler} |
| `radar.prf[3].notch_half_mps` | `25` | `spec/radar.json:40` [setting] 单位 m/s；Gate 2 由毫秒后缀改名 | — | core/{beam,detection,physics,scheduler} |
| `radar.prf[3].zero_notch_half_mps` | `0` | `src/core/detection.lua:42` [code_default] physics 读取可选的零多普勒凹口，缺省 0；config.lua 未配置 | — | core/{beam,detection,physics,scheduler} |
| `radar.prf[4].name` | `"HPRF_ALT"` | `spec/radar.json:39` [assumption] 五个 PRF 档；每档 tau/notch 见行 40-44 | — | core/{beam,detection,physics,scheduler} |
| `radar.prf[4].prf_hz` | `164000` | `spec/radar.json:39` [assumption] 五个 PRF 档；每档 tau/notch 见行 40-44 | — | core/{beam,detection,physics,scheduler} |
| `radar.prf[4].tau_s` | `0.000002` | `spec/radar.json:39` [assumption] 五个 PRF 档；每档 tau/notch 见行 40-44 | — | core/{beam,detection,physics,scheduler} |
| `radar.prf[4].notch_half_mps` | `20` | `spec/radar.json:40` [setting] 单位 m/s；Gate 2 由毫秒后缀改名 | — | core/{beam,detection,physics,scheduler} |
| `radar.prf[4].zero_notch_half_mps` | `0` | `src/core/detection.lua:42` [code_default] physics 读取可选的零多普勒凹口，缺省 0；config.lua 未配置 | — | core/{beam,detection,physics,scheduler} |
| `scheduler.search.az_span_deg` | `30` | `spec/radar.json:52` [setting] 搜索方位 ±30° | — | core/scheduler |
| `scheduler.search.az_step_deg` | `3` | `spec/radar.json:53` [derived] 步进等于波束宽 | — | core/scheduler |
| `scheduler.search.el_bars_deg[0]` | `-4.5` | `spec/radar.json:57` [derived] 覆盖包线 -6°..+6°；间距 2.25° < hpbw_el_deg=3° | — | core/scheduler |
| `scheduler.search.el_bars_deg[1]` | `-2.25` | `spec/radar.json:57` [derived] 覆盖包线 -6°..+6°；间距 2.25° < hpbw_el_deg=3° | — | core/scheduler |
| `scheduler.search.el_bars_deg[2]` | `0` | `spec/radar.json:57` [derived] 覆盖包线 -6°..+6°；间距 2.25° < hpbw_el_deg=3° | — | core/scheduler |
| `scheduler.search.el_bars_deg[3]` | `2.25` | `spec/radar.json:57` [derived] 覆盖包线 -6°..+6°；间距 2.25° < hpbw_el_deg=3° | — | core/scheduler |
| `scheduler.search.el_bars_deg[4]` | `4.5` | `spec/radar.json:57` [derived] 覆盖包线 -6°..+6°；间距 2.25° < hpbw_el_deg=3° | — | core/scheduler |
| `scheduler.revisit.track_far_hz` | `1` | `spec/radar.json:61` [setting] RRM 文献经验区间 | — | core/scheduler |
| `scheduler.revisit.track_near_hz` | `4` | `spec/radar.json:62` [setting] 近距跟踪回访率 | — | core/scheduler |
| `scheduler.revisit.stt_hz` | `6` | `spec/radar.json:63` [setting] STT 回访率 | — | core/scheduler |
| `scheduler.revisit.near_range_m` | `50000` | `spec/radar.json:64` [setting] 原为 km，按约定换算为 m | — | core/scheduler |
| `scheduler.revisit.near_prf_R_m` | `8000` | `spec/radar.json:65` [setting] 近/远距 PRF 分界距离 | — | core/scheduler |
| `prf_selection.search[0]` | `"MPRF"` | `spec/radar.json:58` [setting] 由原下标数组按下标映射为名字：search {2,4,1,5}、track_far {2,4}、track_near {1,5,2,4}、stt {1,5} | — | core/scheduler |
| `prf_selection.search[1]` | `"MPRF_ALT"` | `spec/radar.json:58` [setting] 由原下标数组按下标映射为名字：search {2,4,1,5}、track_far {2,4}、track_near {1,5,2,4}、stt {1,5} | — | core/scheduler |
| `prf_selection.search[2]` | `"HPRF"` | `spec/radar.json:58` [setting] 由原下标数组按下标映射为名字：search {2,4,1,5}、track_far {2,4}、track_near {1,5,2,4}、stt {1,5} | — | core/scheduler |
| `prf_selection.search[3]` | `"HPRF_ALT"` | `spec/radar.json:58` [setting] 由原下标数组按下标映射为名字：search {2,4,1,5}、track_far {2,4}、track_near {1,5,2,4}、stt {1,5} | — | core/scheduler |
| `prf_selection.track_far[0]` | `"MPRF"` | `spec/radar.json:58` [setting] 由原下标数组按下标映射为名字：search {2,4,1,5}、track_far {2,4}、track_near {1,5,2,4}、stt {1,5} | — | core/scheduler |
| `prf_selection.track_far[1]` | `"MPRF_ALT"` | `spec/radar.json:58` [setting] 由原下标数组按下标映射为名字：search {2,4,1,5}、track_far {2,4}、track_near {1,5,2,4}、stt {1,5} | — | core/scheduler |
| `prf_selection.track_near[0]` | `"HPRF"` | `spec/radar.json:58` [setting] 由原下标数组按下标映射为名字：search {2,4,1,5}、track_far {2,4}、track_near {1,5,2,4}、stt {1,5} | — | core/scheduler |
| `prf_selection.track_near[1]` | `"HPRF_ALT"` | `spec/radar.json:58` [setting] 由原下标数组按下标映射为名字：search {2,4,1,5}、track_far {2,4}、track_near {1,5,2,4}、stt {1,5} | — | core/scheduler |
| `prf_selection.track_near[2]` | `"MPRF"` | `spec/radar.json:58` [setting] 由原下标数组按下标映射为名字：search {2,4,1,5}、track_far {2,4}、track_near {1,5,2,4}、stt {1,5} | — | core/scheduler |
| `prf_selection.track_near[3]` | `"MPRF_ALT"` | `spec/radar.json:58` [setting] 由原下标数组按下标映射为名字：search {2,4,1,5}、track_far {2,4}、track_near {1,5,2,4}、stt {1,5} | — | core/scheduler |
| `prf_selection.stt[0]` | `"HPRF"` | `spec/radar.json:58` [setting] 由原下标数组按下标映射为名字：search {2,4,1,5}、track_far {2,4}、track_near {1,5,2,4}、stt {1,5} | — | core/scheduler |
| `prf_selection.stt[1]` | `"HPRF_ALT"` | `spec/radar.json:58` [setting] 由原下标数组按下标映射为名字：search {2,4,1,5}、track_far {2,4}、track_near {1,5,2,4}、stt {1,5} | — | core/scheduler |
| `tracker.confirm_m` | `2` | `spec/radar.json:73` [setting] M/N 起始；2/3 等价时间窗简化 | — | core/tracker |
| `tracker.confirm_window_s` | `8` | `spec/radar.json:74` [setting] M/N 确认时间窗 | — | core/tracker |
| `tracker.coast_s` | `6` | `spec/radar.json:75` [setting] 漏检保持时长 | — | core/tracker |
| `tracker.gate_base_m` | `250` | `spec/radar.json:79` [setting] 自适应关联门基础值 | — | core/tracker |
| `tracker.gate_vel_margin_mps` | `150` | `spec/radar.json:80` [setting] 速度估计误差裕度，单位 m/s | — | core/tracker |
| `tracker.gate_max_m` | `2000` | `spec/radar.json:81` [setting] 关联门上限 | — | core/tracker |
| `tracker.vel_floor_mps` | `350` | `spec/radar.json:82` [setting] 速度未知期的合理性下限，单位 m/s | — | core/tracker |
| `tracker.gate_accel_margin_mps` | `300` | `spec/radar.json:83` [setting] 关联隐含速度容差，单位 m/s | — | core/tracker |
| `tracker.vel_smooth` | `0.5` | `spec/radar.json:85` [setting] 速率平滑系数 | — | core/tracker |
| `tracker.vel_accel_max_mps2` | `120` | `spec/radar.json:86` [setting] 单次回访速度变化上限，单位 m/s² | — | core/tracker |
| `tracker.slow_mover_mps` | `25` | `spec/radar.json:89` [setting] 慢速动目标抑制阈值，单位 m/s；低于该速度不确认 | — | core/tracker |

### SAR 波形、footprint、材质、MAP、PFA (`spec/sar.json`)

| 参数 | 值 | 来源 | ref | 消费者 |
|---|---|---|---|---|
| `constants.default_lambda_m` | `0.03` | `src/sar_core/settings.cjs:24` [setting] DEFAULTS：lambda .03、BW 75 MHz、width 129、rangeStep 8、kernelLobes 16、seed 20261001（Gate 5 前在 tools/sar_surface.cjs） | — | — |
| `constants.default_bandwidth_hz` | `75000000` | `src/sar_core/settings.cjs:24` [setting] DEFAULTS：lambda .03、BW 75 MHz、width 129、rangeStep 8、kernelLobes 16、seed 20261001（Gate 5 前在 tools/sar_surface.cjs） | — | — |
| `constants.default_width` | `129` | `src/sar_core/settings.cjs:24` [setting] DEFAULTS：lambda .03、BW 75 MHz、width 129、rangeStep 8、kernelLobes 16、seed 20261001（Gate 5 前在 tools/sar_surface.cjs） | — | — |
| `constants.default_range_step` | `8` | `src/sar_core/settings.cjs:24` [setting] DEFAULTS：lambda .03、BW 75 MHz、width 129、rangeStep 8、kernelLobes 16、seed 20261001（Gate 5 前在 tools/sar_surface.cjs） | — | — |
| `constants.kernel_lobes` | `16` | `src/sar_core/settings.cjs:24` [setting] DEFAULTS：lambda .03、BW 75 MHz、width 129、rangeStep 8、kernelLobes 16、seed 20261001（Gate 5 前在 tools/sar_surface.cjs） | — | — |
| `constants.range_window_padding_cells` | `20` | `src/sar_core/memory.cjs:27` [assumption] Range window padding in resolution cells past the farthest scatterer; kernel lobes (16) + 4 guard cells. Gate 5 lifted it out of the hard-coded 20*resolution in planScene/reconstructLegacy. | — | — |
| `constants.default_window` | `"hann"` | `src/sar_core/settings.cjs:24` [setting] DEFAULTS：lambda .03、BW 75 MHz、width 129、rangeStep 8、kernelLobes 16、seed 20261001（Gate 5 前在 tools/sar_surface.cjs） | — | — |
| `constants.default_range_interpolation` | `"cubic"` | `src/sar_core/settings.cjs:24` [setting] DEFAULTS：lambda .03、BW 75 MHz、width 129、rangeStep 8、kernelLobes 16、seed 20261001（Gate 5 前在 tools/sar_surface.cjs） | — | — |
| `constants.default_pulse_oversampling` | `2.5` | `src/sar_core/waveform.cjs:17` [assumption] 多普勒支撑过采样 2.5 是项目抗混叠裕度 | — | — |
| `constants.pulse_oversampling_min` | `1` | `src/sar_core/settings.cjs:24` [setting] DEFAULTS：lambda .03、BW 75 MHz、width 129、rangeStep 8、kernelLobes 16、seed 20261001（Gate 5 前在 tools/sar_surface.cjs） | — | — |
| `constants.pulse_oversampling_max` | `4` | `src/sar_core/settings.cjs:24` [setting] DEFAULTS：lambda .03、BW 75 MHz、width 129、rangeStep 8、kernelLobes 16、seed 20261001（Gate 5 前在 tools/sar_surface.cjs） | — | — |
| `constants.min_prf_hz` | `60` | `src/sar_core/settings.cjs:24` [setting] DEFAULTS：lambda .03、BW 75 MHz、width 129、rangeStep 8、kernelLobes 16、seed 20261001（Gate 5 前在 tools/sar_surface.cjs） | — | — |
| `constants.history_budget_bytes` | `536870912` | `src/sar_core/memory.cjs:15` [setting] 512 MiB 回波历史预算 | — | — |
| `constants.history_bytes_per_bin_pulse` | `16` | `src/sar_core/memory.cjs:16` [derived] complex128 = 16 B | — | — |
| `constants.history_pulse_share` | `0.875` | `src/sar_core/memory.cjs:20` [setting] 脉冲份额 7/8 = 448 MiB | — | — |
| `constants.max_simulated_pulses` | `32768` | `src/sar_core/memory.cjs:24` [setting] 小 patch 的绝对脉冲上限 | — | — |
| `profiles.standard.quality` | `"standard"` | `src/sar_core/settings.cjs:66` [setting] standard/fine/fast；fast 为显式有损测试档 | — | sar_core/waveform, sar_service, export |
| `profiles.standard.bandwidth_hz` | `75000000` | `src/sar_core/settings.cjs:66` [setting] standard/fine/fast；fast 为显式有损测试档 | — | sar_core/waveform, sar_service, export |
| `profiles.standard.width` | `129` | `src/sar_core/settings.cjs:66` [setting] standard/fine/fast；fast 为显式有损测试档 | — | sar_core/waveform, sar_service, export |
| `profiles.standard.pulse_oversampling` | `2.5` | `src/sar_core/settings.cjs:66` [setting] standard/fine/fast；fast 为显式有损测试档 | — | sar_core/waveform, sar_service, export |
| `profiles.fine.quality` | `"fine"` | `src/sar_core/settings.cjs:66` [setting] standard/fine/fast；fast 为显式有损测试档 | — | sar_core/waveform, sar_service, export |
| `profiles.fine.bandwidth_hz` | `150000000` | `src/sar_core/settings.cjs:66` [setting] standard/fine/fast；fast 为显式有损测试档 | — | sar_core/waveform, sar_service, export |
| `profiles.fine.width` | `257` | `src/sar_core/settings.cjs:66` [setting] standard/fine/fast；fast 为显式有损测试档 | — | sar_core/waveform, sar_service, export |
| `profiles.fine.pulse_oversampling` | `2.5` | `src/sar_core/settings.cjs:66` [setting] standard/fine/fast；fast 为显式有损测试档 | — | sar_core/waveform, sar_service, export |
| `profiles.fast.quality` | `"fast"` | `src/sar_core/settings.cjs:66` [setting] standard/fine/fast；fast 为显式有损测试档 | — | sar_core/waveform, sar_service, export |
| `profiles.fast.bandwidth_hz` | `75000000` | `src/sar_core/settings.cjs:66` [setting] standard/fine/fast；fast 为显式有损测试档 | — | sar_core/waveform, sar_service, export |
| `profiles.fast.width` | `65` | `src/sar_core/settings.cjs:66` [setting] standard/fine/fast；fast 为显式有损测试档 | — | sar_core/waveform, sar_service, export |
| `profiles.fast.scatter_spacing_m` | `2` | `src/sar_core/settings.cjs:66` [setting] standard/fine/fast；fast 为显式有损测试档 | — | sar_core/waveform, sar_service, export |
| `profiles.fast.pulse_oversampling` | `1.5` | `src/sar_core/settings.cjs:66` [setting] standard/fine/fast；fast 为显式有损测试档 | — | sar_core/waveform, sar_service, export |
| `profiles.effective_quality_rule.requested` | `"fine"` | `src/sar_core/settings.cjs:66` [setting] standard/fine/fast；fast 为显式有损测试档 | — | sar_core/waveform, sar_service, export |
| `profiles.effective_quality_rule.downgrade_to` | `"standard"` | `src/sar_core/settings.cjs:66` [setting] standard/fine/fast；fast 为显式有损测试档 | — | sar_core/waveform, sar_service, export |
| `profiles.effective_quality_rule.bandwidth_hz` | `150000000` | `src/sar_core/settings.cjs:66` [setting] standard/fine/fast；fast 为显式有损测试档 | — | sar_core/waveform, sar_service, export |
| `profiles.effective_quality_rule.width` | `257` | `src/sar_core/settings.cjs:66` [setting] standard/fine/fast；fast 为显式有损测试档 | — | sar_core/waveform, sar_service, export |
| `profiles.effective_quality_rule.note` | `"fine 是 150 MHz + 257 px 的波形承诺；footprint 的带宽/宽度不足时实际档位降为 standard，并在 metadata 记录实际值"` | `src/sar_core/settings.cjs:66` [setting] standard/fine/fast；fast 为显式有损测试档 | — | sar_core/waveform, sar_service, export |
| `footprints.detail.size_m` | `128` | `src/adapters/dcs/sar_adapter.cjs:19` [setting] detail/area/airport 的 size/n/scatterSpacing/width/bandwidth；DCS 词汇归适配层 | — | sar_core/geometry, adapters/dcs/sar_adapter, export |
| `footprints.detail.n` | `17` | `src/adapters/dcs/sar_adapter.cjs:19` [setting] detail/area/airport 的 size/n/scatterSpacing/width/bandwidth；DCS 词汇归适配层 | — | sar_core/geometry, adapters/dcs/sar_adapter, export |
| `footprints.detail.scatter_spacing_m` | `1` | `src/adapters/dcs/sar_adapter.cjs:19` [setting] detail/area/airport 的 size/n/scatterSpacing/width/bandwidth；DCS 词汇归适配层 | — | sar_core/geometry, adapters/dcs/sar_adapter, export |
| `footprints.area.size_m` | `512` | `src/adapters/dcs/sar_adapter.cjs:19` [setting] detail/area/airport 的 size/n/scatterSpacing/width/bandwidth；DCS 词汇归适配层 | — | sar_core/geometry, adapters/dcs/sar_adapter, export |
| `footprints.area.n` | `33` | `src/adapters/dcs/sar_adapter.cjs:19` [setting] detail/area/airport 的 size/n/scatterSpacing/width/bandwidth；DCS 词汇归适配层 | — | sar_core/geometry, adapters/dcs/sar_adapter, export |
| `footprints.area.scatter_spacing_m` | `4` | `src/adapters/dcs/sar_adapter.cjs:19` [setting] detail/area/airport 的 size/n/scatterSpacing/width/bandwidth；DCS 词汇归适配层 | — | sar_core/geometry, adapters/dcs/sar_adapter, export |
| `footprints.area.width` | `129` | `src/adapters/dcs/sar_adapter.cjs:19` [setting] detail/area/airport 的 size/n/scatterSpacing/width/bandwidth；DCS 词汇归适配层 | — | sar_core/geometry, adapters/dcs/sar_adapter, export |
| `footprints.area.bandwidth_hz` | `37500000` | `src/adapters/dcs/sar_adapter.cjs:19` [setting] detail/area/airport 的 size/n/scatterSpacing/width/bandwidth；DCS 词汇归适配层 | — | sar_core/geometry, adapters/dcs/sar_adapter, export |
| `footprints.airport.size_m` | `2048` | `src/adapters/dcs/sar_adapter.cjs:19` [setting] detail/area/airport 的 size/n/scatterSpacing/width/bandwidth；DCS 词汇归适配层 | — | sar_core/geometry, adapters/dcs/sar_adapter, export |
| `footprints.airport.n` | `65` | `src/adapters/dcs/sar_adapter.cjs:19` [setting] detail/area/airport 的 size/n/scatterSpacing/width/bandwidth；DCS 词汇归适配层 | — | sar_core/geometry, adapters/dcs/sar_adapter, export |
| `footprints.airport.scatter_spacing_m` | `16` | `src/adapters/dcs/sar_adapter.cjs:19` [setting] detail/area/airport 的 size/n/scatterSpacing/width/bandwidth；DCS 词汇归适配层 | — | sar_core/geometry, adapters/dcs/sar_adapter, export |
| `footprints.airport.width` | `257` | `src/adapters/dcs/sar_adapter.cjs:19` [setting] detail/area/airport 的 size/n/scatterSpacing/width/bandwidth；DCS 词汇归适配层 | — | sar_core/geometry, adapters/dcs/sar_adapter, export |
| `footprints.airport.bandwidth_hz` | `10000000` | `src/adapters/dcs/sar_adapter.cjs:19` [setting] detail/area/airport 的 size/n/scatterSpacing/width/bandwidth；DCS 词汇归适配层 | — | sar_core/geometry, adapters/dcs/sar_adapter, export |
| `grids.fast.width_divisor` | `2` | `src/sar_core/settings.cjs:70` [derived] GRIDS.fast：宽度减半、spacing 加倍 | — | sar_core/geometry, adapters/dcs/sar_adapter |
| `grids.fast.scatter_spacing_multiplier` | `2` | `src/sar_core/settings.cjs:70` [derived] GRIDS.fast：宽度减半、spacing 加倍 | — | sar_core/geometry, adapters/dcs/sar_adapter |
| `grids.fast.note` | `"width=ceil(width/2)，spacing=spacing×2；只对非 detail footprint 应用"` | `src/sar_core/settings.cjs:70` [derived] GRIDS.fast：宽度减半、spacing 加倍 | — | sar_core/geometry, adapters/dcs/sar_adapter |
| `materials.land` | `1` | `src/sar_core/materials.cjs:17` [assumption] 相对裸地法向入射的材质系数；全部为项目假设 | — | sar_core/materials, export, sar_service, viewer |
| `materials.unknown` | `1` | `src/sar_core/materials.cjs:17` [assumption] 相对裸地法向入射的材质系数；全部为项目假设 | — | sar_core/materials, export, sar_service, viewer |
| `materials.shallow_water` | `0.08` | `src/sar_core/materials.cjs:17` [assumption] 相对裸地法向入射的材质系数；全部为项目假设 | — | sar_core/materials, export, sar_service, viewer |
| `materials.water` | `0.015` | `src/sar_core/materials.cjs:17` [assumption] 相对裸地法向入射的材质系数；全部为项目假设 | — | sar_core/materials, export, sar_service, viewer |
| `materials.road` | `0.12` | `src/sar_core/materials.cjs:17` [assumption] 相对裸地法向入射的材质系数；全部为项目假设 | — | sar_core/materials, export, sar_service, viewer |
| `materials.runway` | `0.06` | `src/sar_core/materials.cjs:17` [assumption] 相对裸地法向入射的材质系数；全部为项目假设 | — | sar_core/materials, export, sar_service, viewer |
| `materials.building` | `8` | `src/sar_core/materials.cjs:17` [assumption] 相对裸地法向入射的材质系数；全部为项目假设 | — | sar_core/materials, export, sar_service, viewer |
| `materials.construction` | `5` | `src/sar_core/materials.cjs:17` [assumption] 相对裸地法向入射的材质系数；全部为项目假设 | — | sar_core/materials, export, sar_service, viewer |
| `materials.town` | `3` | `src/sar_core/materials.cjs:17` [assumption] 相对裸地法向入射的材质系数；全部为项目假设 | — | sar_core/materials, export, sar_service, viewer |
| `materials.forest` | `1.9` | `src/sar_core/materials.cjs:17` [assumption] 相对裸地法向入射的材质系数；全部为项目假设 | — | sar_core/materials, export, sar_service, viewer |
| `materials.trees` | `1.6` | `src/sar_core/materials.cjs:17` [assumption] 相对裸地法向入射的材质系数；全部为项目假设 | — | sar_core/materials, export, sar_service, viewer |
| `materials.beach` | `0.8` | `src/sar_core/materials.cjs:17` [assumption] 相对裸地法向入射的材质系数；全部为项目假设 | — | sar_core/materials, export, sar_service, viewer |
| `materials.field` | `0.75` | `src/sar_core/materials.cjs:17` [assumption] 相对裸地法向入射的材质系数；全部为项目假设 | — | sar_core/materials, export, sar_service, viewer |
| `materials.traffic` | `0.25` | `src/sar_core/materials.cjs:17` [assumption] 相对裸地法向入射的材质系数；全部为项目假设 | — | sar_core/materials, export, sar_service, viewer |
| `materials.railway` | `0.1` | `src/sar_core/materials.cjs:17` [assumption] 相对裸地法向入射的材质系数；全部为项目假设 | — | sar_core/materials, export, sar_service, viewer |
| `materials.particle_effect` | `0.05` | `src/sar_core/materials.cjs:17` [assumption] 相对裸地法向入射的材质系数；全部为项目假设 | — | sar_core/materials, export, sar_service, viewer |
| `materials.river` | `0.03` | `src/sar_core/materials.cjs:17` [assumption] 相对裸地法向入射的材质系数；全部为项目假设 | — | sar_core/materials, export, sar_service, viewer |
| `materials.lake` | `0.02` | `src/sar_core/materials.cjs:17` [assumption] 相对裸地法向入射的材质系数；全部为项目假设 | — | sar_core/materials, export, sar_service, viewer |
| `materials.sea` | `0.015` | `src/sar_core/materials.cjs:17` [assumption] 相对裸地法向入射的材质系数；全部为项目假设 | — | sar_core/materials, export, sar_service, viewer |
| `surface_classes[0]` | `"land"` | `src/sar_core/materials.cjs:17` [official] 引擎 64 位地表 mask 的 16 类，顺序按探针位升序；词表来自生成配置 | — | — |
| `surface_classes[1]` | `"runway"` | `src/sar_core/materials.cjs:17` [official] 引擎 64 位地表 mask 的 16 类，顺序按探针位升序；词表来自生成配置 | — | — |
| `surface_classes[2]` | `"sea"` | `src/sar_core/materials.cjs:17` [official] 引擎 64 位地表 mask 的 16 类，顺序按探针位升序；词表来自生成配置 | — | — |
| `surface_classes[3]` | `"river"` | `src/sar_core/materials.cjs:17` [official] 引擎 64 位地表 mask 的 16 类，顺序按探针位升序；词表来自生成配置 | — | — |
| `surface_classes[4]` | `"lake"` | `src/sar_core/materials.cjs:17` [official] 引擎 64 位地表 mask 的 16 类，顺序按探针位升序；词表来自生成配置 | — | — |
| `surface_classes[5]` | `"road"` | `src/sar_core/materials.cjs:17` [official] 引擎 64 位地表 mask 的 16 类，顺序按探针位升序；词表来自生成配置 | — | — |
| `surface_classes[6]` | `"railway"` | `src/sar_core/materials.cjs:17` [official] 引擎 64 位地表 mask 的 16 类，顺序按探针位升序；词表来自生成配置 | — | — |
| `surface_classes[7]` | `"town"` | `src/sar_core/materials.cjs:17` [official] 引擎 64 位地表 mask 的 16 类，顺序按探针位升序；词表来自生成配置 | — | — |
| `surface_classes[8]` | `"field"` | `src/sar_core/materials.cjs:17` [official] 引擎 64 位地表 mask 的 16 类，顺序按探针位升序；词表来自生成配置 | — | — |
| `surface_classes[9]` | `"beach"` | `src/sar_core/materials.cjs:17` [official] 引擎 64 位地表 mask 的 16 类，顺序按探针位升序；词表来自生成配置 | — | — |
| `surface_classes[10]` | `"building"` | `src/sar_core/materials.cjs:17` [official] 引擎 64 位地表 mask 的 16 类，顺序按探针位升序；词表来自生成配置 | — | — |
| `surface_classes[11]` | `"construction"` | `src/sar_core/materials.cjs:17` [official] 引擎 64 位地表 mask 的 16 类，顺序按探针位升序；词表来自生成配置 | — | — |
| `surface_classes[12]` | `"trees"` | `src/sar_core/materials.cjs:17` [official] 引擎 64 位地表 mask 的 16 类，顺序按探针位升序；词表来自生成配置 | — | — |
| `surface_classes[13]` | `"forest"` | `src/sar_core/materials.cjs:17` [official] 引擎 64 位地表 mask 的 16 类，顺序按探针位升序；词表来自生成配置 | — | — |
| `surface_classes[14]` | `"traffic"` | `src/sar_core/materials.cjs:17` [official] 引擎 64 位地表 mask 的 16 类，顺序按探针位升序；词表来自生成配置 | — | — |
| `surface_classes[15]` | `"particle_effect"` | `src/sar_core/materials.cjs:17` [official] 引擎 64 位地表 mask 的 16 类，顺序按探针位升序；词表来自生成配置 | — | — |
| `surface_priority[0]` | `"building"` | `src/sar_core/materials.cjs:31` [setting] 按雷达显著性而非土地利用排序 | — | — |
| `surface_priority[1]` | `"construction"` | `src/sar_core/materials.cjs:31` [setting] 按雷达显著性而非土地利用排序 | — | — |
| `surface_priority[2]` | `"town"` | `src/sar_core/materials.cjs:31` [setting] 按雷达显著性而非土地利用排序 | — | — |
| `surface_priority[3]` | `"runway"` | `src/sar_core/materials.cjs:31` [setting] 按雷达显著性而非土地利用排序 | — | — |
| `surface_priority[4]` | `"road"` | `src/sar_core/materials.cjs:31` [setting] 按雷达显著性而非土地利用排序 | — | — |
| `surface_priority[5]` | `"railway"` | `src/sar_core/materials.cjs:31` [setting] 按雷达显著性而非土地利用排序 | — | — |
| `surface_priority[6]` | `"traffic"` | `src/sar_core/materials.cjs:31` [setting] 按雷达显著性而非土地利用排序 | — | — |
| `surface_priority[7]` | `"trees"` | `src/sar_core/materials.cjs:31` [setting] 按雷达显著性而非土地利用排序 | — | — |
| `surface_priority[8]` | `"forest"` | `src/sar_core/materials.cjs:31` [setting] 按雷达显著性而非土地利用排序 | — | — |
| `surface_priority[9]` | `"field"` | `src/sar_core/materials.cjs:31` [setting] 按雷达显著性而非土地利用排序 | — | — |
| `surface_priority[10]` | `"beach"` | `src/sar_core/materials.cjs:31` [setting] 按雷达显著性而非土地利用排序 | — | — |
| `surface_priority[11]` | `"land"` | `src/sar_core/materials.cjs:31` [setting] 按雷达显著性而非土地利用排序 | — | — |
| `surface_priority[12]` | `"river"` | `src/sar_core/materials.cjs:31` [setting] 按雷达显著性而非土地利用排序 | — | — |
| `surface_priority[13]` | `"lake"` | `src/sar_core/materials.cjs:31` [setting] 按雷达显著性而非土地利用排序 | — | — |
| `surface_priority[14]` | `"sea"` | `src/sar_core/materials.cjs:31` [setting] 按雷达显著性而非土地利用排序 | — | — |
| `surface_priority[15]` | `"particle_effect"` | `src/sar_core/materials.cjs:31` [setting] 按雷达显著性而非土地利用排序 | — | — |
| `legacy_surfaces.0` | `"unknown"` | `src/adapters/dcs/sar_adapter.cjs:31` [official] terrain.GetSurfaceType 旧五类词表 | — | export, sar_service, sar_core/materials |
| `legacy_surfaces.1` | `"land"` | `src/adapters/dcs/sar_adapter.cjs:31` [official] terrain.GetSurfaceType 旧五类词表 | — | export, sar_service, sar_core/materials |
| `legacy_surfaces.2` | `"shallow_water"` | `src/adapters/dcs/sar_adapter.cjs:31` [official] terrain.GetSurfaceType 旧五类词表 | — | export, sar_service, sar_core/materials |
| `legacy_surfaces.3` | `"water"` | `src/adapters/dcs/sar_adapter.cjs:31` [official] terrain.GetSurfaceType 旧五类词表 | — | export, sar_service, sar_core/materials |
| `legacy_surfaces.4` | `"road"` | `src/adapters/dcs/sar_adapter.cjs:31` [official] terrain.GetSurfaceType 旧五类词表 | — | export, sar_service, sar_core/materials |
| `legacy_surfaces.5` | `"runway"` | `src/adapters/dcs/sar_adapter.cjs:31` [official] terrain.GetSurfaceType 旧五类词表 | — | export, sar_service, sar_core/materials |
| `map.engine_defaults.cell_m` | `250` | `src/sar_core/map.cjs:56` [setting] sar_map 渲染器 DEFAULT；looks=1、cells=121 | — | sar_core/map, sar_service, viewer |
| `map.engine_defaults.cells` | `121` | `src/sar_core/map.cjs:56` [setting] sar_map 渲染器 DEFAULT；looks=1、cells=121 | — | sar_core/map, sar_service, viewer |
| `map.engine_defaults.beam_deg` | `3` | `src/sar_core/map.cjs:56` [setting] sar_map 渲染器 DEFAULT；looks=1、cells=121 | — | sar_core/map, sar_service, viewer |
| `map.engine_defaults.looks` | `1` | `src/sar_core/map.cjs:56` [setting] sar_map 渲染器 DEFAULT；looks=1、cells=121 | — | sar_core/map, sar_service, viewer |
| `map.engine_defaults.stc` | `true` | `src/sar_core/map.cjs:56` [setting] sar_map 渲染器 DEFAULT；looks=1、cells=121 | — | sar_core/map, sar_service, viewer |
| `map.engine_defaults.shadow` | `true` | `src/sar_core/map.cjs:56` [setting] sar_map 渲染器 DEFAULT；looks=1、cells=121 | — | sar_core/map, sar_service, viewer |
| `map.engine_defaults.layover` | `true` | `src/sar_core/map.cjs:56` [setting] sar_map 渲染器 DEFAULT；looks=1、cells=121 | — | sar_core/map, sar_service, viewer |
| `map.engine_defaults.layover_margin_cells` | `4` | `src/sar_core/map.cjs:56` [setting] sar_map 渲染器 DEFAULT；looks=1、cells=121 | — | sar_core/map, sar_service, viewer |
| `map.engine_defaults.seed` | `20261009` | `src/sar_core/map.cjs:56` [setting] sar_map 渲染器 DEFAULT；looks=1、cells=121 | — | sar_core/map, sar_service, viewer |
| `map.engine_defaults.min_slant_m` | `1500` | `src/sar_core/map.cjs:56` [setting] sar_map 渲染器 DEFAULT；looks=1、cells=121 | — | sar_core/map, sar_service, viewer |
| `map.engine_defaults.surface_default` | `"unknown"` | `src/sar_core/map.cjs:56` [setting] sar_map 渲染器 DEFAULT；looks=1、cells=121 | — | sar_core/map, sar_service, viewer |
| `map.engine_defaults.kernel_sigmas` | `3` | `src/sar_core/map.cjs:56` [setting] sar_map 渲染器 DEFAULT；looks=1、cells=121 | — | sar_core/map, sar_service, viewer |
| `map.engine_defaults.peak_norm` | `false` | `src/sar_core/map.cjs:56` [setting] sar_map 渲染器 DEFAULT；looks=1、cells=121 | — | sar_core/map, sar_service, viewer |
| `map.engine_defaults.relief` | `true` | `src/sar_core/map.cjs:56` [setting] sar_map 渲染器 DEFAULT；looks=1、cells=121 | — | sar_core/map, sar_service, viewer |
| `map.engine_defaults.grid_layout` | `"col_x_row_z"` | `src/sar_core/map.cjs:56` [setting] sar_map 渲染器 DEFAULT；looks=1、cells=121 | — | sar_core/map, sar_service, viewer |
| `map.engine_defaults.db_ref` | `"fixed_material"` | `src/sar_core/map.cjs:500` [setting] MAP 默认固定材质参考；peak_norm:true 时回到 frame_peak | — | sar_core/map, sar_service, viewer |
| `map.service_defaults.range_m` | `20000` | `src/shared/config.cjs:1` [setting] SAR 服务 MAP 默认值；looks=4（生成配置 SAR_MAP_SERVICE_DEFAULTS） | — | sar_core/map, sar_service, viewer |
| `map.service_defaults.azimuth_deg` | `60` | `src/shared/config.cjs:1` [setting] SAR 服务 MAP 默认值；looks=4（生成配置 SAR_MAP_SERVICE_DEFAULTS） | — | sar_core/map, sar_service, viewer |
| `map.service_defaults.cell_m` | `250` | `src/shared/config.cjs:1` [setting] SAR 服务 MAP 默认值；looks=4（生成配置 SAR_MAP_SERVICE_DEFAULTS） | — | sar_core/map, sar_service, viewer |
| `map.service_defaults.beam_deg` | `3` | `src/shared/config.cjs:1` [setting] SAR 服务 MAP 默认值；looks=4（生成配置 SAR_MAP_SERVICE_DEFAULTS） | — | sar_core/map, sar_service, viewer |
| `map.service_defaults.looks` | `4` | `src/shared/config.cjs:1` [setting] SAR 服务 MAP 默认值；looks=4（生成配置 SAR_MAP_SERVICE_DEFAULTS） | — | sar_core/map, sar_service, viewer |
| `map.service_defaults.stc` | `true` | `src/shared/config.cjs:1` [setting] SAR 服务 MAP 默认值；looks=4（生成配置 SAR_MAP_SERVICE_DEFAULTS） | — | sar_core/map, sar_service, viewer |
| `map.service_defaults.shadow` | `true` | `src/shared/config.cjs:1` [setting] SAR 服务 MAP 默认值；looks=4（生成配置 SAR_MAP_SERVICE_DEFAULTS） | — | sar_core/map, sar_service, viewer |
| `map.service_defaults.dbs_factor` | `8` | `src/shared/config.cjs:1` [setting] SAR 服务 MAP 默认值；looks=4（生成配置 SAR_MAP_SERVICE_DEFAULTS） | — | sar_core/map, sar_service, viewer |
| `map.service_defaults.peak_norm` | `false` | `src/shared/config.cjs:1` [setting] SAR 服务 MAP 默认值；looks=4（生成配置 SAR_MAP_SERVICE_DEFAULTS） | — | sar_core/map, sar_service, viewer |
| `map.limits.cell_m.min` | `25` | `src/sar_core/map.cjs:50` [setting] 引擎/service 的校验范围；service 范围见 spec/sar.json map.limits.service_* | — | sar_core/map, sar_service, viewer |
| `map.limits.cell_m.max` | `2000` | `src/sar_core/map.cjs:50` [setting] 引擎/service 的校验范围；service 范围见 spec/sar.json map.limits.service_* | — | sar_core/map, sar_service, viewer |
| `map.limits.service_cell_m.min` | `50` | `src/sar_core/map.cjs:50` [setting] 引擎/service 的校验范围；service 范围见 spec/sar.json map.limits.service_* | — | sar_core/map, sar_service, viewer |
| `map.limits.service_cell_m.max` | `1000` | `src/sar_core/map.cjs:50` [setting] 引擎/service 的校验范围；service 范围见 spec/sar.json map.limits.service_* | — | sar_core/map, sar_service, viewer |
| `map.limits.cells.min` | `5` | `src/sar_core/map.cjs:50` [setting] 引擎/service 的校验范围；service 范围见 spec/sar.json map.limits.service_* | — | sar_core/map, sar_service, viewer |
| `map.limits.cells.max` | `257` | `src/sar_core/map.cjs:50` [setting] 引擎/service 的校验范围；service 范围见 spec/sar.json map.limits.service_* | — | sar_core/map, sar_service, viewer |
| `map.limits.sector_cells_max` | `257` | `src/sar_core/map.cjs:50` [setting] 引擎/service 的校验范围；service 范围见 spec/sar.json map.limits.service_* | — | sar_core/map, sar_service, viewer |
| `map.limits.beam_deg.min` | `0.2` | `src/sar_core/map.cjs:50` [setting] 引擎/service 的校验范围；service 范围见 spec/sar.json map.limits.service_* | — | sar_core/map, sar_service, viewer |
| `map.limits.beam_deg.max` | `30` | `src/sar_core/map.cjs:50` [setting] 引擎/service 的校验范围；service 范围见 spec/sar.json map.limits.service_* | — | sar_core/map, sar_service, viewer |
| `map.limits.looks.min` | `1` | `src/sar_core/map.cjs:50` [setting] 引擎/service 的校验范围；service 范围见 spec/sar.json map.limits.service_* | — | sar_core/map, sar_service, viewer |
| `map.limits.looks.max` | `64` | `src/sar_core/map.cjs:50` [setting] 引擎/service 的校验范围；service 范围见 spec/sar.json map.limits.service_* | — | sar_core/map, sar_service, viewer |
| `map.limits.layover_margin_cells.min` | `0` | `src/sar_core/map.cjs:50` [setting] 引擎/service 的校验范围；service 范围见 spec/sar.json map.limits.service_* | — | sar_core/map, sar_service, viewer |
| `map.limits.layover_margin_cells.max` | `16` | `src/sar_core/map.cjs:50` [setting] 引擎/service 的校验范围；service 范围见 spec/sar.json map.limits.service_* | — | sar_core/map, sar_service, viewer |
| `map.limits.min_slant_m.min` | `0` | `src/sar_core/map.cjs:50` [setting] 引擎/service 的校验范围；service 范围见 spec/sar.json map.limits.service_* | — | sar_core/map, sar_service, viewer |
| `map.limits.min_slant_m.max` | `50000` | `src/sar_core/map.cjs:50` [setting] 引擎/service 的校验范围；service 范围见 spec/sar.json map.limits.service_* | — | sar_core/map, sar_service, viewer |
| `map.limits.kernel_sigmas.min` | `1` | `src/sar_core/map.cjs:50` [setting] 引擎/service 的校验范围；service 范围见 spec/sar.json map.limits.service_* | — | sar_core/map, sar_service, viewer |
| `map.limits.kernel_sigmas.max` | `6` | `src/sar_core/map.cjs:50` [setting] 引擎/service 的校验范围；service 范围见 spec/sar.json map.limits.service_* | — | sar_core/map, sar_service, viewer |
| `map.limits.dbs_factor_engine.min` | `1` | `src/sar_core/map.cjs:50` [setting] 引擎/service 的校验范围；service 范围见 spec/sar.json map.limits.service_* | — | sar_core/map, sar_service, viewer |
| `map.limits.dbs_factor_engine.max` | `128` | `src/sar_core/map.cjs:50` [setting] 引擎/service 的校验范围；service 范围见 spec/sar.json map.limits.service_* | — | sar_core/map, sar_service, viewer |
| `map.limits.dbs_factor_service.min` | `1` | `src/sar_core/map.cjs:50` [setting] 引擎/service 的校验范围；service 范围见 spec/sar.json map.limits.service_* | — | sar_core/map, sar_service, viewer |
| `map.limits.dbs_factor_service.max` | `32` | `src/sar_core/map.cjs:50` [setting] 引擎/service 的校验范围；service 范围见 spec/sar.json map.limits.service_* | — | sar_core/map, sar_service, viewer |
| `map.limits.service_range_m.min` | `5000` | `src/sar_core/map.cjs:50` [setting] 引擎/service 的校验范围；service 范围见 spec/sar.json map.limits.service_* | — | sar_core/map, sar_service, viewer |
| `map.limits.service_range_m.max` | `30000` | `src/sar_core/map.cjs:50` [setting] 引擎/service 的校验范围；service 范围见 spec/sar.json map.limits.service_* | — | sar_core/map, sar_service, viewer |
| `map.limits.service_azimuth_deg.min` | `15` | `src/sar_core/map.cjs:50` [setting] 引擎/service 的校验范围；service 范围见 spec/sar.json map.limits.service_* | — | sar_core/map, sar_service, viewer |
| `map.limits.service_azimuth_deg.max` | `75` | `src/sar_core/map.cjs:50` [setting] 引擎/service 的校验范围；service 范围见 spec/sar.json map.limits.service_* | — | sar_core/map, sar_service, viewer |
| `map.limits.job_cells_max` | `4000` | `src/sar_core/map.cjs:50` [setting] 引擎/service 的校验范围；service 范围见 spec/sar.json map.limits.service_* | — | sar_core/map, sar_service, viewer |
| `map.limits.job_timeout_ms` | `60000` | `src/sar_core/map.cjs:50` [setting] 引擎/service 的校验范围；service 范围见 spec/sar.json map.limits.service_* | — | sar_core/map, sar_service, viewer |
| `map.limits.advance_m` | `1000` | `src/sar_core/map.cjs:50` [setting] 引擎/service 的校验范围；service 范围见 spec/sar.json map.limits.service_* | — | sar_core/map, sar_service, viewer |
| `map.limits.turn_reanchor_deg` | `12` | `src/sar_core/map.cjs:50` [setting] 引擎/service 的校验范围；service 范围见 spec/sar.json map.limits.service_* | — | sar_core/map, sar_service, viewer |
| `map.limits.frame_min_ms` | `1500` | `src/sar_core/map.cjs:50` [setting] 引擎/service 的校验范围；service 范围见 spec/sar.json map.limits.service_* | — | sar_core/map, sar_service, viewer |
| `map.limits.render_gain` | `0.06` | `src/sar_core/map.cjs:50` [setting] 引擎/service 的校验范围；service 范围见 spec/sar.json map.limits.service_* | — | sar_core/map, sar_service, viewer |
| `map.limits.pose_refresh_ms` | `2000` | `src/sar_core/map.cjs:50` [setting] 引擎/service 的校验范围；service 范围见 spec/sar.json map.limits.service_* | — | sar_core/map, sar_service, viewer |
| `map.collection.cells_max` | `20000` | `src/export/sar_protocol.lua:13` [setting] MAP_CELLS/MAP_ROWS/MAP_STEP/MAP_POSE（Export 线协议常量） | — | sar_core/map, sar_service, viewer |
| `map.collection.rows_max` | `200` | `src/export/sar_protocol.lua:13` [setting] MAP_CELLS/MAP_ROWS/MAP_STEP/MAP_POSE（Export 线协议常量） | — | sar_core/map, sar_service, viewer |
| `map.collection.step_min_m` | `25` | `src/export/sar_protocol.lua:13` [setting] MAP_CELLS/MAP_ROWS/MAP_STEP/MAP_POSE（Export 线协议常量） | — | sar_core/map, sar_service, viewer |
| `map.collection.step_max_m` | `2000` | `src/export/sar_protocol.lua:13` [setting] MAP_CELLS/MAP_ROWS/MAP_STEP/MAP_POSE（Export 线协议常量） | — | sar_core/map, sar_service, viewer |
| `map.collection.pose_interval_s` | `0.25` | `src/export/sar_protocol.lua:13` [setting] MAP_CELLS/MAP_ROWS/MAP_STEP/MAP_POSE（Export 线协议常量） | — | sar_core/map, sar_service, viewer |
| `map.lattice.limit` | `400000` | `src/sar_core/map.cjs:103` [setting] 世界栅格缓存上限 400000 | — | sar_core/map, sar_service, viewer |
| `map.lattice.cell_max_m` | `5000` | `src/sar_core/map.cjs:103` [setting] 世界栅格缓存上限 400000 | — | sar_core/map, sar_service, viewer |
| `map.dbs.cell_m` | `25` | `tools/sar_service/dbs_session.cjs:14` [setting] DBS 25 m 格、256-1024 m 块、8/32 锐化 | — | sar_core/map, sar_service, viewer |
| `map.dbs.span_min_m` | `256` | `tools/sar_service/dbs_session.cjs:14` [setting] DBS 25 m 格、256-1024 m 块、8/32 锐化 | — | sar_core/map, sar_service, viewer |
| `map.dbs.span_max_m` | `1024` | `tools/sar_service/dbs_session.cjs:14` [setting] DBS 25 m 格、256-1024 m 块、8/32 锐化 | — | sar_core/map, sar_service, viewer |
| `map.dbs.span_default_m` | `512` | `tools/sar_service/dbs_session.cjs:14` [setting] DBS 25 m 格、256-1024 m 块、8/32 锐化 | — | sar_core/map, sar_service, viewer |
| `map.dbs.sharpens[0]` | `8` | `tools/sar_service/dbs_session.cjs:14` [setting] DBS 25 m 格、256-1024 m 块、8/32 锐化 | — | sar_core/map, sar_service, viewer |
| `map.dbs.sharpens[1]` | `32` | `tools/sar_service/dbs_session.cjs:14` [setting] DBS 25 m 格、256-1024 m 块、8/32 锐化 | — | sar_core/map, sar_service, viewer |
| `map.dbs.sharpen_default` | `8` | `tools/sar_service/dbs_session.cjs:14` [setting] DBS 25 m 格、256-1024 m 块、8/32 锐化 | — | sar_core/map, sar_service, viewer |
| `map.dbs.near_forward_deg` | `20` | `tools/sar_service/dbs_session.cjs:14` [setting] DBS 25 m 格、256-1024 m 块、8/32 锐化 | — | sar_core/map, sar_service, viewer |
| `map.mover.poll_ms` | `2000` | `tools/sar_service/service.cjs:35` [setting] GMTI 轮询 2 s、半径 50 km、最多 64、MDV 2 m/s | — | sar_core/map, sar_service, viewer |
| `map.mover.radius_max_m` | `50000` | `tools/sar_service/service.cjs:35` [setting] GMTI 轮询 2 s、半径 50 km、最多 64、MDV 2 m/s | — | sar_core/map, sar_service, viewer |
| `map.mover.max` | `64` | `tools/sar_service/service.cjs:35` [setting] GMTI 轮询 2 s、半径 50 km、最多 64、MDV 2 m/s | — | sar_core/map, sar_service, viewer |
| `map.mover.mdv_mps` | `2` | `tools/sar_service/service.cjs:35` [setting] GMTI 轮询 2 s、半径 50 km、最多 64、MDV 2 m/s | — | sar_core/map, sar_service, viewer |
| `map.mover.mission_visit_max` | `128` | `tools/sar_service/service.cjs:35` [setting] GMTI 轮询 2 s、半径 50 km、最多 64、MDV 2 m/s | — | sar_core/map, sar_service, viewer |
| `map.mover.mission_lines_per_step` | `16` | `tools/sar_service/service.cjs:35` [setting] GMTI 轮询 2 s、半径 50 km、最多 64、MDV 2 m/s | — | sar_core/map, sar_service, viewer |
| `map.mover.mission_search_s` | `0.1` | `tools/sar_service/service.cjs:35` [setting] GMTI 轮询 2 s、半径 50 km、最多 64、MDV 2 m/s | — | sar_core/map, sar_service, viewer |
| `map.mover.mission_min_speed_mps` | `1` | `tools/sar_service/service.cjs:35` [setting] GMTI 轮询 2 s、半径 50 km、最多 64、MDV 2 m/s | — | sar_core/map, sar_service, viewer |
| `map.mover.bridge_timeout_ms` | `3000` | `tools/sar_service/service.cjs:35` [setting] GMTI 轮询 2 s、半径 50 km、最多 64、MDV 2 m/s | — | sar_core/map, sar_service, viewer |
| `map.sweep.min_angle_deg` | `30` | `tools/sar_service/sweep_planner.cjs:18` [setting] 扫掠窗口 30-60°、1-50 km；计划/退避参数同文件 35 行 | — | sar_core/map, sar_service, viewer |
| `map.sweep.max_angle_deg` | `60` | `tools/sar_service/sweep_planner.cjs:18` [setting] 扫掠窗口 30-60°、1-50 km；计划/退避参数同文件 35 行 | — | sar_core/map, sar_service, viewer |
| `map.sweep.min_range_m` | `1000` | `tools/sar_service/sweep_planner.cjs:18` [setting] 扫掠窗口 30-60°、1-50 km；计划/退避参数同文件 35 行 | `protocol.json#/sar/capture/min_range_m` | sar_core/map, sar_service, viewer |
| `map.sweep.max_range_m` | `50000` | `tools/sar_service/sweep_planner.cjs:18` [setting] 扫掠窗口 30-60°、1-50 km；计划/退避参数同文件 35 行 | `protocol.json#/sar/capture/max_range_m` | sar_core/map, sar_service, viewer |
| `map.sweep.angle_band_deg` | `5` | `tools/sar_service/sweep_planner.cjs:18` [setting] 扫掠窗口 30-60°、1-50 km；计划/退避参数同文件 35 行 | — | sar_core/map, sar_service, viewer |
| `map.sweep.plan_max` | `20` | `tools/sar_service/sweep_planner.cjs:18` [setting] 扫掠窗口 30-60°、1-50 km；计划/退避参数同文件 35 行 | — | sar_core/map, sar_service, viewer |
| `map.sweep.sizes_m[0]` | `512` | `tools/sar_service/sweep_planner.cjs:18` [setting] 扫掠窗口 30-60°、1-50 km；计划/退避参数同文件 35 行 | — | sar_core/map, sar_service, viewer |
| `map.sweep.sizes_m[1]` | `2048` | `tools/sar_service/sweep_planner.cjs:18` [setting] 扫掠窗口 30-60°、1-50 km；计划/退避参数同文件 35 行 | — | sar_core/map, sar_service, viewer |
| `map.sweep.default_size_m` | `512` | `tools/sar_service/sweep_planner.cjs:18` [setting] 扫掠窗口 30-60°、1-50 km；计划/退避参数同文件 35 行 | — | sar_core/map, sar_service, viewer |
| `map.sweep.lead_s` | `10` | `tools/sar_service/sweep_planner.cjs:18` [setting] 扫掠窗口 30-60°、1-50 km；计划/退避参数同文件 35 行 | — | sar_core/map, sar_service, viewer |
| `map.sweep.predicted_min_range_m` | `1500` | `tools/sar_service/sweep_planner.cjs:18` [setting] 扫掠窗口 30-60°、1-50 km；计划/退避参数同文件 35 行 | — | sar_core/map, sar_service, viewer |
| `map.sweep.retry_ms` | `60000` | `tools/sar_service/sweep_planner.cjs:18` [setting] 扫掠窗口 30-60°、1-50 km；计划/退避参数同文件 35 行 | — | sar_core/map, sar_service, viewer |
| `map.sweep.retry_max` | `128` | `tools/sar_service/sweep_planner.cjs:18` [setting] 扫掠窗口 30-60°、1-50 km；计划/退避参数同文件 35 行 | — | sar_core/map, sar_service, viewer |
| `pfa.max_grid` | `2048` | `src/sar_core/pfa.cjs:37` [setting] MAX_PFA_GRID=2048；网格/径向下限 256、margin 1.05 | — | sar_core/pfa |
| `pfa.min_grid` | `256` | `src/sar_core/pfa.cjs:37` [setting] MAX_PFA_GRID=2048；网格/径向下限 256、margin 1.05 | — | sar_core/pfa |
| `pfa.grid_margin` | `1.05` | `src/sar_core/pfa.cjs:37` [setting] MAX_PFA_GRID=2048；网格/径向下限 256、margin 1.05 | — | sar_core/pfa |
| `pfa.nyquist_margin` | `1.05` | `src/sar_core/pfa.cjs:37` [setting] MAX_PFA_GRID=2048；网格/径向下限 256、margin 1.05 | — | sar_core/pfa |
| `pfa.radial_min_grid` | `256` | `src/sar_core/pfa.cjs:37` [setting] MAX_PFA_GRID=2048；网格/径向下限 256、margin 1.05 | — | sar_core/pfa |
| `pfa.decimation_max` | `8` | `src/sar_core/pfa.cjs:37` [setting] MAX_PFA_GRID=2048；网格/径向下限 256、margin 1.05 | — | sar_core/pfa |
| `geometry.trajectory_min_frames` | `16` | `src/sar_core/geometry.cjs:31` [setting] 轨迹 16-180 帧、间隔 ≤0.25 s、速度 ≤1500 m/s、孔径 1.8-2.5 s、净空 50 m、起伏 2000 m | — | sar_core/geometry, adapters/dcs/sar_adapter |
| `geometry.trajectory_max_frames` | `180` | `src/sar_core/geometry.cjs:31` [setting] 轨迹 16-180 帧、间隔 ≤0.25 s、速度 ≤1500 m/s、孔径 1.8-2.5 s、净空 50 m、起伏 2000 m | — | sar_core/geometry, adapters/dcs/sar_adapter |
| `geometry.trajectory_max_gap_s` | `0.25` | `src/sar_core/geometry.cjs:31` [setting] 轨迹 16-180 帧、间隔 ≤0.25 s、速度 ≤1500 m/s、孔径 1.8-2.5 s、净空 50 m、起伏 2000 m | — | sar_core/geometry, adapters/dcs/sar_adapter |
| `geometry.trajectory_max_speed_mps` | `1500` | `src/sar_core/geometry.cjs:31` [setting] 轨迹 16-180 帧、间隔 ≤0.25 s、速度 ≤1500 m/s、孔径 1.8-2.5 s、净空 50 m、起伏 2000 m | — | sar_core/geometry, adapters/dcs/sar_adapter |
| `geometry.aperture_min_s` | `1.8` | `src/sar_core/geometry.cjs:31` [setting] 轨迹 16-180 帧、间隔 ≤0.25 s、速度 ≤1500 m/s、孔径 1.8-2.5 s、净空 50 m、起伏 2000 m | — | sar_core/geometry, adapters/dcs/sar_adapter |
| `geometry.aperture_max_s` | `2.5` | `src/sar_core/geometry.cjs:31` [setting] 轨迹 16-180 帧、间隔 ≤0.25 s、速度 ≤1500 m/s、孔径 1.8-2.5 s、净空 50 m、起伏 2000 m | — | sar_core/geometry, adapters/dcs/sar_adapter |
| `geometry.clearance_min_m` | `50` | `src/sar_core/geometry.cjs:31` [setting] 轨迹 16-180 帧、间隔 ≤0.25 s、速度 ≤1500 m/s、孔径 1.8-2.5 s、净空 50 m、起伏 2000 m | — | sar_core/geometry, adapters/dcs/sar_adapter |
| `geometry.max_relief_m` | `2000` | `src/sar_core/geometry.cjs:31` [setting] 轨迹 16-180 帧、间隔 ≤0.25 s、速度 ≤1500 m/s、孔径 1.8-2.5 s、净空 50 m、起伏 2000 m | — | sar_core/geometry, adapters/dcs/sar_adapter |
| `geometry.min_transverse_aperture_m` | `20` | `src/sar_core/geometry.cjs:31` [setting] 轨迹 16-180 帧、间隔 ≤0.25 s、速度 ≤1500 m/s、孔径 1.8-2.5 s、净空 50 m、起伏 2000 m | — | sar_core/geometry, adapters/dcs/sar_adapter |
| `geometry.terrain_geometry_tolerance_m` | `0.01` | `src/sar_core/geometry.cjs:31` [setting] 轨迹 16-180 帧、间隔 ≤0.25 s、速度 ≤1500 m/s、孔径 1.8-2.5 s、净空 50 m、起伏 2000 m | — | sar_core/geometry, adapters/dcs/sar_adapter |
| `scene.max_objects` | `128` | `src/adapters/dcs/sar_adapter.cjs:16` [setting] 对象最多 128、包围盒 ≤500 m、轴正交容差 0.01；DCS 对象类别词表同文件 42 行 | — | sar_core/geometry, adapters/dcs/sar_adapter |
| `scene.object_visit_max` | `512` | `src/adapters/dcs/sar_adapter.cjs:16` [setting] 对象最多 128、包围盒 ≤500 m、轴正交容差 0.01；DCS 对象类别词表同文件 42 行 | — | sar_core/geometry, adapters/dcs/sar_adapter |
| `scene.object_bbox_max_m` | `500` | `src/adapters/dcs/sar_adapter.cjs:16` [setting] 对象最多 128、包围盒 ≤500 m、轴正交容差 0.01；DCS 对象类别词表同文件 42 行 | — | sar_core/geometry, adapters/dcs/sar_adapter |
| `scene.object_axis_tolerance` | `0.01` | `src/adapters/dcs/sar_adapter.cjs:16` [setting] 对象最多 128、包围盒 ≤500 m、轴正交容差 0.01；DCS 对象类别词表同文件 42 行 | — | sar_core/geometry, adapters/dcs/sar_adapter |
| `scene.object_pos_abs_max_m` | `100000000` | `src/adapters/dcs/sar_adapter.cjs:16` [setting] 对象最多 128、包围盒 ≤500 m、轴正交容差 0.01；DCS 对象类别词表同文件 42 行 | — | sar_core/geometry, adapters/dcs/sar_adapter |
| `scene.object_scatter_budget` | `2048` | `src/adapters/dcs/sar_adapter.cjs:16` [setting] 对象最多 128、包围盒 ≤500 m、轴正交容差 0.01；DCS 对象类别词表同文件 42 行 | — | sar_core/geometry, adapters/dcs/sar_adapter |
| `scene.model_objects_max` | `32` | `src/adapters/dcs/sar_adapter.cjs:16` [setting] 对象最多 128、包围盒 ≤500 m、轴正交容差 0.01；DCS 对象类别词表同文件 42 行 | — | sar_core/geometry, adapters/dcs/sar_adapter |
| `scene.surface_grid_cells_expr` | `"n*n"` | `src/adapters/dcs/sar_adapter.cjs:16` [setting] 对象最多 128、包围盒 ≤500 m、轴正交容差 0.01；DCS 对象类别词表同文件 42 行 | — | sar_core/geometry, adapters/dcs/sar_adapter |
| `render.default_scene_model` | `"uniform"` | `src/sar_core/settings.cjs:24` [setting] DEFAULTS：sceneModel uniform、focuser backprojection、window hann、shadow center、seed 20261001 | — | sar_core/{engine,focus}, sar_service |
| `render.scene_models[0]` | `"uniform"` | `src/sar_core/settings.cjs:24` [setting] DEFAULTS：sceneModel uniform、focuser backprojection、window hann、shadow center、seed 20261001 | — | sar_core/{engine,focus}, sar_service |
| `render.scene_models[1]` | `"classified"` | `src/sar_core/settings.cjs:24` [setting] DEFAULTS：sceneModel uniform、focuser backprojection、window hann、shadow center、seed 20261001 | — | sar_core/{engine,focus}, sar_service |
| `render.default_focuser` | `"backprojection"` | `src/sar_core/settings.cjs:24` [setting] DEFAULTS：sceneModel uniform、focuser backprojection、window hann、shadow center、seed 20261001 | — | sar_core/{engine,focus}, sar_service |
| `render.focusers[0]` | `"backprojection"` | `src/sar_core/settings.cjs:24` [setting] DEFAULTS：sceneModel uniform、focuser backprojection、window hann、shadow center、seed 20261001 | — | sar_core/{engine,focus}, sar_service |
| `render.focusers[1]` | `"pfa"` | `src/sar_core/settings.cjs:24` [setting] DEFAULTS：sceneModel uniform、focuser backprojection、window hann、shadow center、seed 20261001 | — | sar_core/{engine,focus}, sar_service |
| `render.windows[0]` | `"rect"` | `src/sar_core/settings.cjs:24` [setting] DEFAULTS：sceneModel uniform、focuser backprojection、window hann、shadow center、seed 20261001 | — | sar_core/{engine,focus}, sar_service |
| `render.windows[1]` | `"hann"` | `src/sar_core/settings.cjs:24` [setting] DEFAULTS：sceneModel uniform、focuser backprojection、window hann、shadow center、seed 20261001 | — | sar_core/{engine,focus}, sar_service |
| `render.range_interpolations[0]` | `"linear"` | `src/sar_core/settings.cjs:24` [setting] DEFAULTS：sceneModel uniform、focuser backprojection、window hann、shadow center、seed 20261001 | — | sar_core/{engine,focus}, sar_service |
| `render.range_interpolations[1]` | `"cubic"` | `src/sar_core/settings.cjs:24` [setting] DEFAULTS：sceneModel uniform、focuser backprojection、window hann、shadow center、seed 20261001 | — | sar_core/{engine,focus}, sar_service |
| `render.scatter_spacings_m[0]` | `1` | `src/sar_core/settings.cjs:24` [setting] DEFAULTS：sceneModel uniform、focuser backprojection、window hann、shadow center、seed 20261001 | — | sar_core/{engine,focus}, sar_service |
| `render.scatter_spacings_m[1]` | `2` | `src/sar_core/settings.cjs:24` [setting] DEFAULTS：sceneModel uniform、focuser backprojection、window hann、shadow center、seed 20261001 | — | sar_core/{engine,focus}, sar_service |
| `render.scatter_spacings_m[2]` | `4` | `src/sar_core/settings.cjs:24` [setting] DEFAULTS：sceneModel uniform、focuser backprojection、window hann、shadow center、seed 20261001 | — | sar_core/{engine,focus}, sar_service |
| `render.scatter_spacings_m[3]` | `8` | `src/sar_core/settings.cjs:24` [setting] DEFAULTS：sceneModel uniform、focuser backprojection、window hann、shadow center、seed 20261001 | — | sar_core/{engine,focus}, sar_service |
| `render.scatter_spacings_m[4]` | `16` | `src/sar_core/settings.cjs:24` [setting] DEFAULTS：sceneModel uniform、focuser backprojection、window hann、shadow center、seed 20261001 | — | sar_core/{engine,focus}, sar_service |
| `render.scatter_spacings_m[5]` | `32` | `src/sar_core/settings.cjs:24` [setting] DEFAULTS：sceneModel uniform、focuser backprojection、window hann、shadow center、seed 20261001 | — | sar_core/{engine,focus}, sar_service |
| `render.widths_px[0]` | `65` | `src/sar_core/settings.cjs:24` [setting] DEFAULTS：sceneModel uniform、focuser backprojection、window hann、shadow center、seed 20261001 | — | sar_core/{engine,focus}, sar_service |
| `render.widths_px[1]` | `129` | `src/sar_core/settings.cjs:24` [setting] DEFAULTS：sceneModel uniform、focuser backprojection、window hann、shadow center、seed 20261001 | — | sar_core/{engine,focus}, sar_service |
| `render.widths_px[2]` | `257` | `src/sar_core/settings.cjs:24` [setting] DEFAULTS：sceneModel uniform、focuser backprojection、window hann、shadow center、seed 20261001 | — | sar_core/{engine,focus}, sar_service |
| `render.shadow_looks[0]` | `"center"` | `src/sar_core/settings.cjs:24` [setting] DEFAULTS：sceneModel uniform、focuser backprojection、window hann、shadow center、seed 20261001 | — | sar_core/{engine,focus}, sar_service |
| `render.shadow_looks[1]` | `"pulse"` | `src/sar_core/settings.cjs:24` [setting] DEFAULTS：sceneModel uniform、focuser backprojection、window hann、shadow center、seed 20261001 | — | sar_core/{engine,focus}, sar_service |
| `render.default_seed` | `20261001` | `src/sar_core/settings.cjs:24` [setting] DEFAULTS：sceneModel uniform、focuser backprojection、window hann、shadow center、seed 20261001 | — | sar_core/{engine,focus}, sar_service |
| `render.default_shadow` | `true` | `src/sar_core/settings.cjs:24` [setting] DEFAULTS：sceneModel uniform、focuser backprojection、window hann、shadow center、seed 20261001 | — | sar_core/{engine,focus}, sar_service |
| `render.default_shadow_look` | `"center"` | `src/sar_core/settings.cjs:24` [setting] DEFAULTS：sceneModel uniform、focuser backprojection、window hann、shadow center、seed 20261001 | — | sar_core/{engine,focus}, sar_service |
| `render.db_floor_ref` | `-40` | `src/sar_core/settings.cjs:24` [setting] DEFAULTS：sceneModel uniform、focuser backprojection、window hann、shadow center、seed 20261001 | `display.json#/db/floor_db` | sar_core/{engine,focus}, sar_service |
| `render.db_ref` | `"frame_peak"` | `src/sar_core/engine.cjs:26` [setting] SAR 结果逐帧峰值参考（与 MAP 的固定材质参考分开标注） | `display.json#/db/ref_by_product/sar` | sar_core/{engine,focus}, sar_service |

### 端口、版本、行协议、上限、超时 (`spec/protocol.json`)

| 参数 | 值 | 来源 | ref | 消费者 |
|---|---|---|---|---|
| `host` | `"127.0.0.1"` | `src/export/aesa_export.lua:18` [setting] 所有监听仅限 127.0.0.1 | — | — |
| `ports.aa_export` | `3590` | `src/export/aesa_export.lua:17` [setting] 3590/3592/3593/3594 分别见 aesa_export、aesa_sar_export、sar_live、scene hook；3591 见 live.py | — | export, sar_service, tools/python, native |
| `ports.aa_http` | `3591` | `src/export/aesa_export.lua:17` [setting] 3590/3592/3593/3594 分别见 aesa_export、aesa_sar_export、sar_live、scene hook；3591 见 live.py | — | export, sar_service, tools/python, native |
| `ports.sar_tcp` | `3592` | `src/export/aesa_export.lua:17` [setting] 3590/3592/3593/3594 分别见 aesa_export、aesa_sar_export、sar_live、scene hook；3591 见 live.py | — | export, sar_service, tools/python, native |
| `ports.sar_http` | `3593` | `src/export/aesa_export.lua:17` [setting] 3590/3592/3593/3594 分别见 aesa_export、aesa_sar_export、sar_live、scene hook；3591 见 live.py | — | export, sar_service, tools/python, native |
| `ports.sar_scene` | `3594` | `src/export/aesa_export.lua:17` [setting] 3590/3592/3593/3594 分别见 aesa_export、aesa_sar_export、sar_live、scene hook；3591 见 live.py | — | export, sar_service, tools/python, native |
| `versions.aa` | `"V1"` | `src/export/aesa_export.lua:237` [setting] A/A 连接握手行 V1；PROTO,2 单独声明坐标/姿态约定 | — | export, scene, sar_service |
| `versions.sar` | `"SAR1"` | `src/export/sar_protocol.lua:17` [setting] SAR 通道/协议名 SAR1 | — | export, scene, sar_service |
| `versions.sar_caps` | `2` | `src/export/sar_protocol.lua:17` [setting] CAPS 能力版本 2 | — | export, scene, sar_service |
| `versions.scene` | `"SARSCENE1"` | `src/hooks/aesa_sar_scene_hook.lua:60` [setting] 场景桥握手 SARSCENE1 | — | export, scene, sar_service |
| `versions.scene_caps` | `1` | `src/scene/sar_scene_core.lua:10` [setting] 任务采样器版本号 1 | — | export, scene, sar_service |
| `versions.aa_proto` | `"2"` | `src/export/aesa_export.lua:235` [setting] 连接后发送 PROTO,2；接收端 frame.lua 负责 DCS→ENU | — | export, scene, sar_service |
| `aa.sample_rate_hz` | `10` | `src/export/aesa_export.lua:9` [setting] RATE_HZ=10、RETRY_S=2；行字段见 AESA.sample 与 tools/receiver.py parse_line | — | export/aa_protocol, tools/receiver.py, tools/live.py |
| `aa.line_ending` | `"\n"` | `src/export/aesa_export.lua:9` [setting] RATE_HZ=10、RETRY_S=2；行字段见 AESA.sample 与 tools/receiver.py parse_line | — | export/aa_protocol, tools/receiver.py, tools/live.py |
| `aa.coalition_values[0]` | `0` | `src/export/aesa_export.lua:9` [setting] RATE_HZ=10、RETRY_S=2；行字段见 AESA.sample 与 tools/receiver.py parse_line | — | export/aa_protocol, tools/receiver.py, tools/live.py |
| `aa.coalition_values[1]` | `1` | `src/export/aesa_export.lua:9` [setting] RATE_HZ=10、RETRY_S=2；行字段见 AESA.sample 与 tools/receiver.py parse_line | — | export/aa_protocol, tools/receiver.py, tools/live.py |
| `aa.coalition_values[2]` | `2` | `src/export/aesa_export.lua:9` [setting] RATE_HZ=10、RETRY_S=2；行字段见 AESA.sample 与 tools/receiver.py parse_line | — | export/aa_protocol, tools/receiver.py, tools/live.py |
| `aa.vel_valid_values[0]` | `0` | `src/export/aesa_export.lua:9` [setting] RATE_HZ=10、RETRY_S=2；行字段见 AESA.sample 与 tools/receiver.py parse_line | — | export/aa_protocol, tools/receiver.py, tools/live.py |
| `aa.vel_valid_values[1]` | `1` | `src/export/aesa_export.lua:9` [setting] RATE_HZ=10、RETRY_S=2；行字段见 AESA.sample 与 tools/receiver.py parse_line | — | export/aa_protocol, tools/receiver.py, tools/live.py |
| `aa.rows.V1.fields` | `1` | `src/export/aesa_export.lua:9` [setting] RATE_HZ=10、RETRY_S=2；行字段见 AESA.sample 与 tools/receiver.py parse_line | — | export/aa_protocol, tools/receiver.py, tools/live.py |
| `aa.rows.PROTO.fields` | `2` | `src/export/aesa_export.lua:9` [setting] RATE_HZ=10、RETRY_S=2；行字段见 AESA.sample 与 tools/receiver.py parse_line | — | export/aa_protocol, tools/receiver.py, tools/live.py |
| `aa.rows.PROTO.tokens[0]` | `"PROTO"` | `src/export/aesa_export.lua:9` [setting] RATE_HZ=10、RETRY_S=2；行字段见 AESA.sample 与 tools/receiver.py parse_line | — | export/aa_protocol, tools/receiver.py, tools/live.py |
| `aa.rows.PROTO.tokens[1]` | `"2"` | `src/export/aesa_export.lua:9` [setting] RATE_HZ=10、RETRY_S=2；行字段见 AESA.sample 与 tools/receiver.py parse_line | — | export/aa_protocol, tools/receiver.py, tools/live.py |
| `aa.rows.PROTO.note` | `"A/A 坐标/姿态声明：原始 DCS 值（x 北、y 上、z 东；Heading 从北顺时针）。缺失时按 V1 旧约定解释"` | `src/export/aesa_export.lua:9` [setting] RATE_HZ=10、RETRY_S=2；行字段见 AESA.sample 与 tools/receiver.py parse_line | — | export/aa_protocol, tools/receiver.py, tools/live.py |
| `aa.rows.COMPAT.fields` | `3` | `src/export/aesa_export.lua:9` [setting] RATE_HZ=10、RETRY_S=2；行字段见 AESA.sample 与 tools/receiver.py parse_line | — | export/aa_protocol, tools/receiver.py, tools/live.py |
| `aa.rows.P.min_fields` | `2` | `src/export/aesa_export.lua:9` [setting] RATE_HZ=10、RETRY_S=2；行字段见 AESA.sample 与 tools/receiver.py parse_line | — | export/aa_protocol, tools/receiver.py, tools/live.py |
| `aa.rows.P.note` | `"首帧字段名探针；P 后可带任意探针文本"` | `src/export/aesa_export.lua:9` [setting] RATE_HZ=10、RETRY_S=2；行字段见 AESA.sample 与 tools/receiver.py parse_line | — | export/aa_protocol, tools/receiver.py, tools/live.py |
| `aa.rows.A.fields` | `10` | `src/export/aesa_export.lua:9` [setting] RATE_HZ=10、RETRY_S=2；行字段见 AESA.sample 与 tools/receiver.py parse_line | — | export/aa_protocol, tools/receiver.py, tools/live.py |
| `aa.rows.A.legacy_fields[0]` | `9` | `src/export/aesa_export.lua:9` [setting] RATE_HZ=10、RETRY_S=2；行字段见 AESA.sample 与 tools/receiver.py parse_line | — | export/aa_protocol, tools/receiver.py, tools/live.py |
| `aa.rows.O.fields` | `5` | `src/export/aesa_export.lua:9` [setting] RATE_HZ=10、RETRY_S=2；行字段见 AESA.sample 与 tools/receiver.py parse_line | — | export/aa_protocol, tools/receiver.py, tools/live.py |
| `aa.rows.T.fields` | `12` | `src/export/aesa_export.lua:9` [setting] RATE_HZ=10、RETRY_S=2；行字段见 AESA.sample 与 tools/receiver.py parse_line | — | export/aa_protocol, tools/receiver.py, tools/live.py |
| `aa.rows.T.legacy_fields[0]` | `11` | `src/export/aesa_export.lua:9` [setting] RATE_HZ=10、RETRY_S=2；行字段见 AESA.sample 与 tools/receiver.py parse_line | — | export/aa_protocol, tools/receiver.py, tools/live.py |
| `aa.rows.L.fields` | `4` | `src/export/aesa_export.lua:9` [setting] RATE_HZ=10、RETRY_S=2；行字段见 AESA.sample 与 tools/receiver.py parse_line | — | export/aa_protocol, tools/receiver.py, tools/live.py |
| `aa.rows.E.fields[0]` | `7` | `src/export/aesa_export.lua:9` [setting] RATE_HZ=10、RETRY_S=2；行字段见 AESA.sample 与 tools/receiver.py parse_line | — | export/aa_protocol, tools/receiver.py, tools/live.py |
| `aa.rows.E.fields[1]` | `10` | `src/export/aesa_export.lua:9` [setting] RATE_HZ=10、RETRY_S=2；行字段见 AESA.sample 与 tools/receiver.py parse_line | — | export/aa_protocol, tools/receiver.py, tools/live.py |
| `sar.status_rate_hz` | `1` | `src/export/sar_protocol.lua:13` [setting] N=17、SIZE=128、DURATION=2；STATUS 1 Hz、POSE 60 Hz、MAPPOSE 0.25 s | — | export/sar_protocol, sar_service |
| `sar.pose_rate_hz` | `60` | `src/export/sar_protocol.lua:13` [setting] N=17、SIZE=128、DURATION=2；STATUS 1 Hz、POSE 60 Hz、MAPPOSE 0.25 s | — | export/sar_protocol, sar_service |
| `sar.default_size_m` | `128` | `src/export/sar_protocol.lua:13` [setting] N=17、SIZE=128、DURATION=2；STATUS 1 Hz、POSE 60 Hz、MAPPOSE 0.25 s | — | export/sar_protocol, sar_service |
| `sar.default_n` | `17` | `src/export/sar_protocol.lua:13` [setting] N=17、SIZE=128、DURATION=2；STATUS 1 Hz、POSE 60 Hz、MAPPOSE 0.25 s | — | export/sar_protocol, sar_service |
| `sar.duration_s` | `2` | `src/export/sar_protocol.lua:13` [setting] N=17、SIZE=128、DURATION=2；STATUS 1 Hz、POSE 60 Hz、MAPPOSE 0.25 s | — | export/sar_protocol, sar_service |
| `sar.default_footprint` | `"detail"` | `src/export/sar_protocol.lua:13` [setting] N=17、SIZE=128、DURATION=2；STATUS 1 Hz、POSE 60 Hz、MAPPOSE 0.25 s | — | export/sar_protocol, sar_service |
| `sar.capture.min_range_m` | `1000` | `src/export/sar_protocol.lua:41` [setting] 侧视 1-50 km；size/n 组合见 allowed() 行 23 | — | export/sar_protocol, sar_service |
| `sar.capture.max_range_m` | `50000` | `src/export/sar_protocol.lua:41` [setting] 侧视 1-50 km；size/n 组合见 allowed() 行 23 | — | export/sar_protocol, sar_service |
| `sar.capture.side_values[0]` | `-1` | `src/export/sar_protocol.lua:41` [setting] 侧视 1-50 km；size/n 组合见 allowed() 行 23 | — | export/sar_protocol, sar_service |
| `sar.capture.side_values[1]` | `1` | `src/export/sar_protocol.lua:41` [setting] 侧视 1-50 km；size/n 组合见 allowed() 行 23 | — | export/sar_protocol, sar_service |
| `sar.capture.size_n_pairs[0][0]` | `128` | `src/export/sar_protocol.lua:41` [setting] 侧视 1-50 km；size/n 组合见 allowed() 行 23 | — | export/sar_protocol, sar_service |
| `sar.capture.size_n_pairs[0][1]` | `17` | `src/export/sar_protocol.lua:41` [setting] 侧视 1-50 km；size/n 组合见 allowed() 行 23 | — | export/sar_protocol, sar_service |
| `sar.capture.size_n_pairs[1][0]` | `512` | `src/export/sar_protocol.lua:41` [setting] 侧视 1-50 km；size/n 组合见 allowed() 行 23 | — | export/sar_protocol, sar_service |
| `sar.capture.size_n_pairs[1][1]` | `33` | `src/export/sar_protocol.lua:41` [setting] 侧视 1-50 km；size/n 组合见 allowed() 行 23 | — | export/sar_protocol, sar_service |
| `sar.capture.size_n_pairs[2][0]` | `2048` | `src/export/sar_protocol.lua:41` [setting] 侧视 1-50 km；size/n 组合见 allowed() 行 23 | — | export/sar_protocol, sar_service |
| `sar.capture.size_n_pairs[2][1]` | `65` | `src/export/sar_protocol.lua:41` [setting] 侧视 1-50 km；size/n 组合见 allowed() 行 23 | — | export/sar_protocol, sar_service |
| `sar.image_window.min_angle_deg` | `20` | `tools/sar_service/arbiter.cjs:18` [setting] 可成像侧视窗 20-160°（绝对值，正右负左） | — | export/sar_protocol, sar_service |
| `sar.image_window.max_angle_deg` | `160` | `tools/sar_service/arbiter.cjs:18` [setting] 可成像侧视窗 20-160°（绝对值，正右负左） | — | export/sar_protocol, sar_service |
| `sar.map.cells_max` | `20000` | `src/export/sar_protocol.lua:14` [setting] MAP_CELLS/MAP_ROWS/MAP_STEP/MAP_POSE；服务端上限见 protocol.map 生成物 | `sar.json#/map/collection/cells_max` | export/sar_protocol, sar_service |
| `sar.map.rows_max` | `200` | `src/export/sar_protocol.lua:14` [setting] MAP_CELLS/MAP_ROWS/MAP_STEP/MAP_POSE；服务端上限见 protocol.map 生成物 | `sar.json#/map/collection/rows_max` | export/sar_protocol, sar_service |
| `sar.map.step_min_m` | `25` | `src/export/sar_protocol.lua:14` [setting] MAP_CELLS/MAP_ROWS/MAP_STEP/MAP_POSE；服务端上限见 protocol.map 生成物 | `sar.json#/map/collection/step_min_m` | export/sar_protocol, sar_service |
| `sar.map.step_max_m` | `2000` | `src/export/sar_protocol.lua:14` [setting] MAP_CELLS/MAP_ROWS/MAP_STEP/MAP_POSE；服务端上限见 protocol.map 生成物 | `sar.json#/map/collection/step_max_m` | export/sar_protocol, sar_service |
| `sar.map.pose_interval_s` | `0.25` | `src/export/sar_protocol.lua:14` [setting] MAP_CELLS/MAP_ROWS/MAP_STEP/MAP_POSE；服务端上限见 protocol.map 生成物 | `sar.json#/map/collection/pose_interval_s` | export/sar_protocol, sar_service |
| `sar.map.job_timeout_ms` | `60000` | `src/export/sar_protocol.lua:14` [setting] MAP_CELLS/MAP_ROWS/MAP_STEP/MAP_POSE；服务端上限见 protocol.map 生成物 | `sar.json#/map/limits/job_timeout_ms` | export/sar_protocol, sar_service |
| `sar.map.surface_token_max_chars` | `96` | `src/export/sar_protocol.lua:14` [setting] MAP_CELLS/MAP_ROWS/MAP_STEP/MAP_POSE；服务端上限见 protocol.map 生成物 | `#/limits/map_surface_max_chars` | export/sar_protocol, sar_service |
| `sar.map.surface_parts_max` | `16` | `src/export/sar_protocol.lua:14` [setting] MAP_CELLS/MAP_ROWS/MAP_STEP/MAP_POSE；服务端上限见 protocol.map 生成物 | — | export/sar_protocol, sar_service |
| `sar.map.grid_layout` | `"col_x_row_z"` | `src/export/sar_protocol.lua:14` [setting] MAP_CELLS/MAP_ROWS/MAP_STEP/MAP_POSE；服务端上限见 protocol.map 生成物 | `sar.json#/map/engine_defaults/grid_layout` | export/sar_protocol, sar_service |
| `sar.rows.HELLO.fields` | `2` | `tools/sar_service/collector.cjs:99` [setting] Collector 对每行字段数的严格校验 | — | export/sar_protocol, sar_service |
| `sar.rows.HELLO.tokens[0]` | `"HELLO"` | `tools/sar_service/collector.cjs:99` [setting] Collector 对每行字段数的严格校验 | — | export/sar_protocol, sar_service |
| `sar.rows.HELLO.tokens[1]` | `"SAR1"` | `tools/sar_service/collector.cjs:99` [setting] Collector 对每行字段数的严格校验 | — | export/sar_protocol, sar_service |
| `sar.rows.CAPS.fields[0]` | `3` | `tools/sar_service/collector.cjs:99` [setting] Collector 对每行字段数的严格校验 | — | export/sar_protocol, sar_service |
| `sar.rows.CAPS.fields[1]` | `4` | `tools/sar_service/collector.cjs:99` [setting] Collector 对每行字段数的严格校验 | — | export/sar_protocol, sar_service |
| `sar.rows.COMPAT.fields` | `3` | `tools/sar_service/collector.cjs:99` [setting] Collector 对每行字段数的严格校验 | — | export/sar_protocol, sar_service |
| `sar.rows.STATUS.fields[0]` | `6` | `tools/sar_service/collector.cjs:99` [setting] Collector 对每行字段数的严格校验 | — | export/sar_protocol, sar_service |
| `sar.rows.STATUS.fields[1]` | `7` | `tools/sar_service/collector.cjs:99` [setting] Collector 对每行字段数的严格校验 | — | export/sar_protocol, sar_service |
| `sar.rows.BEGIN.fields` | `7` | `tools/sar_service/collector.cjs:99` [setting] Collector 对每行字段数的严格校验 | — | export/sar_protocol, sar_service |
| `sar.rows.TARGET.fields` | `6` | `tools/sar_service/collector.cjs:99` [setting] Collector 对每行字段数的严格校验 | — | export/sar_protocol, sar_service |
| `sar.rows.HEIGHT.fields` | `6` | `tools/sar_service/collector.cjs:99` [setting] Collector 对每行字段数的严格校验 | — | export/sar_protocol, sar_service |
| `sar.rows.SURFACE.fields` | `4` | `tools/sar_service/collector.cjs:99` [setting] Collector 对每行字段数的严格校验 | — | export/sar_protocol, sar_service |
| `sar.rows.POSE.fields` | `6` | `tools/sar_service/collector.cjs:99` [setting] Collector 对每行字段数的严格校验 | — | export/sar_protocol, sar_service |
| `sar.rows.END.fields` | `4` | `tools/sar_service/collector.cjs:99` [setting] Collector 对每行字段数的严格校验 | — | export/sar_protocol, sar_service |
| `sar.rows.FAIL.fields[0]` | `3` | `tools/sar_service/collector.cjs:99` [setting] Collector 对每行字段数的严格校验 | — | export/sar_protocol, sar_service |
| `sar.rows.FAIL.fields[1]` | `4` | `tools/sar_service/collector.cjs:99` [setting] Collector 对每行字段数的严格校验 | — | export/sar_protocol, sar_service |
| `sar.rows.MAPBEGIN.fields` | `7` | `tools/sar_service/collector.cjs:99` [setting] Collector 对每行字段数的严格校验 | — | export/sar_protocol, sar_service |
| `sar.rows.MAPGRID.fields` | `3` | `tools/sar_service/collector.cjs:99` [setting] Collector 对每行字段数的严格校验 | — | export/sar_protocol, sar_service |
| `sar.rows.MAPHEIGHT.fields` | `7` | `tools/sar_service/collector.cjs:99` [setting] Collector 对每行字段数的严格校验 | — | export/sar_protocol, sar_service |
| `sar.rows.MAPSURFACE.fields` | `5` | `tools/sar_service/collector.cjs:99` [setting] Collector 对每行字段数的严格校验 | — | export/sar_protocol, sar_service |
| `sar.rows.MAPPOSE.fields` | `9` | `tools/sar_service/collector.cjs:99` [setting] Collector 对每行字段数的严格校验 | — | export/sar_protocol, sar_service |
| `sar.rows.MAPEND.fields` | `4` | `tools/sar_service/collector.cjs:99` [setting] Collector 对每行字段数的严格校验 | — | export/sar_protocol, sar_service |
| `sar.commands.CAPTURE.fields[0]` | `4` | `src/export/sar_collector.lua:32` [setting] 服务端命令字段数：CAPTURE/GEO/WORLD 4 或 6、MAP 7、CANCEL/SURFACE_FINE 1 | — | export/sar_protocol, sar_service |
| `sar.commands.CAPTURE.fields[1]` | `6` | `src/export/sar_collector.lua:32` [setting] 服务端命令字段数：CAPTURE/GEO/WORLD 4 或 6、MAP 7、CANCEL/SURFACE_FINE 1 | — | export/sar_protocol, sar_service |
| `sar.commands.CAPTURE_GEO.fields[0]` | `4` | `src/export/sar_collector.lua:32` [setting] 服务端命令字段数：CAPTURE/GEO/WORLD 4 或 6、MAP 7、CANCEL/SURFACE_FINE 1 | — | export/sar_protocol, sar_service |
| `sar.commands.CAPTURE_GEO.fields[1]` | `6` | `src/export/sar_collector.lua:32` [setting] 服务端命令字段数：CAPTURE/GEO/WORLD 4 或 6、MAP 7、CANCEL/SURFACE_FINE 1 | — | export/sar_protocol, sar_service |
| `sar.commands.CAPTURE_WORLD.fields[0]` | `4` | `src/export/sar_collector.lua:32` [setting] 服务端命令字段数：CAPTURE/GEO/WORLD 4 或 6、MAP 7、CANCEL/SURFACE_FINE 1 | — | export/sar_protocol, sar_service |
| `sar.commands.CAPTURE_WORLD.fields[1]` | `6` | `src/export/sar_collector.lua:32` [setting] 服务端命令字段数：CAPTURE/GEO/WORLD 4 或 6、MAP 7、CANCEL/SURFACE_FINE 1 | — | export/sar_protocol, sar_service |
| `sar.commands.CAPTURE_MAP.fields` | `7` | `src/export/sar_collector.lua:32` [setting] 服务端命令字段数：CAPTURE/GEO/WORLD 4 或 6、MAP 7、CANCEL/SURFACE_FINE 1 | — | export/sar_protocol, sar_service |
| `sar.commands.CAPTURE_MAP_AT.fields` | `7` | `src/export/sar_collector.lua:32` [setting] 服务端命令字段数：CAPTURE/GEO/WORLD 4 或 6、MAP 7、CANCEL/SURFACE_FINE 1 | — | export/sar_protocol, sar_service |
| `sar.commands.CANCEL.fields` | `1` | `src/export/sar_collector.lua:32` [setting] 服务端命令字段数：CAPTURE/GEO/WORLD 4 或 6、MAP 7、CANCEL/SURFACE_FINE 1 | — | export/sar_protocol, sar_service |
| `sar.commands.SURFACE_FINE.fields` | `1` | `src/export/sar_collector.lua:32` [setting] 服务端命令字段数：CAPTURE/GEO/WORLD 4 或 6、MAP 7、CANCEL/SURFACE_FINE 1 | — | export/sar_protocol, sar_service |
| `scene.object_max` | `128` | `src/scene/sar_scene_core.lua:29` [setting] MOVER 半径/访问/上限；17 个 SURFACE/帧、16 个 MOVER/步 | `sar.json#/scene/max_objects` | scene, hooks, sar_service |
| `scene.object_visit_max` | `512` | `src/scene/sar_scene_core.lua:29` [setting] MOVER 半径/访问/上限；17 个 SURFACE/帧、16 个 MOVER/步 | `sar.json#/scene/object_visit_max` | scene, hooks, sar_service |
| `scene.mover_max` | `64` | `src/scene/sar_scene_core.lua:29` [setting] MOVER 半径/访问/上限；17 个 SURFACE/帧、16 个 MOVER/步 | `sar.json#/map/mover/max` | scene, hooks, sar_service |
| `scene.mover_radius_max_m` | `50000` | `src/scene/sar_scene_core.lua:29` [setting] MOVER 半径/访问/上限；17 个 SURFACE/帧、16 个 MOVER/步 | `sar.json#/map/mover/radius_max_m` | scene, hooks, sar_service |
| `scene.mover_visit_max` | `128` | `src/scene/sar_scene_core.lua:29` [setting] MOVER 半径/访问/上限；17 个 SURFACE/帧、16 个 MOVER/步 | `sar.json#/map/mover/mission_visit_max` | scene, hooks, sar_service |
| `scene.mover_lines_per_step` | `16` | `src/scene/sar_scene_core.lua:29` [setting] MOVER 半径/访问/上限；17 个 SURFACE/帧、16 个 MOVER/步 | `sar.json#/map/mover/mission_lines_per_step` | scene, hooks, sar_service |
| `scene.mover_search_s` | `0.1` | `src/scene/sar_scene_core.lua:29` [setting] MOVER 半径/访问/上限；17 个 SURFACE/帧、16 个 MOVER/步 | `sar.json#/map/mover/mission_search_s` | scene, hooks, sar_service |
| `scene.mover_min_speed_mps` | `1` | `src/scene/sar_scene_core.lua:29` [setting] MOVER 半径/访问/上限；17 个 SURFACE/帧、16 个 MOVER/步 | `sar.json#/map/mover/mission_min_speed_mps` | scene, hooks, sar_service |
| `scene.mover_timeout_ms` | `3000` | `src/scene/sar_scene_core.lua:29` [setting] MOVER 半径/访问/上限；17 个 SURFACE/帧、16 个 MOVER/步 | `sar.json#/map/mover/bridge_timeout_ms` | scene, hooks, sar_service |
| `scene.rows.HELLO.fields` | `2` | `tools/sar_bridge.cjs:49` [setting] 桥对 CAP/SURFACE/OBJECT/SCENE_END/MOVER/MOVER_END 的字段校验 | — | scene, hooks, sar_service |
| `scene.rows.HELLO.tokens[0]` | `"HELLO"` | `tools/sar_bridge.cjs:49` [setting] 桥对 CAP/SURFACE/OBJECT/SCENE_END/MOVER/MOVER_END 的字段校验 | — | scene, hooks, sar_service |
| `scene.rows.HELLO.tokens[1]` | `"SARSCENE1"` | `tools/sar_bridge.cjs:49` [setting] 桥对 CAP/SURFACE/OBJECT/SCENE_END/MOVER/MOVER_END 的字段校验 | — | scene, hooks, sar_service |
| `scene.rows.CAP.fields[0]` | `4` | `tools/sar_bridge.cjs:49` [setting] 桥对 CAP/SURFACE/OBJECT/SCENE_END/MOVER/MOVER_END 的字段校验 | — | scene, hooks, sar_service |
| `scene.rows.CAP.fields[1]` | `5` | `tools/sar_bridge.cjs:49` [setting] 桥对 CAP/SURFACE/OBJECT/SCENE_END/MOVER/MOVER_END 的字段校验 | — | scene, hooks, sar_service |
| `scene.rows.COMPAT.fields` | `3` | `tools/sar_bridge.cjs:49` [setting] 桥对 CAP/SURFACE/OBJECT/SCENE_END/MOVER/MOVER_END 的字段校验 | — | scene, hooks, sar_service |
| `scene.rows.SURFACE.fields` | `4` | `tools/sar_bridge.cjs:49` [setting] 桥对 CAP/SURFACE/OBJECT/SCENE_END/MOVER/MOVER_END 的字段校验 | — | scene, hooks, sar_service |
| `scene.rows.OBJECT.fields` | `22` | `tools/sar_bridge.cjs:49` [setting] 桥对 CAP/SURFACE/OBJECT/SCENE_END/MOVER/MOVER_END 的字段校验 | — | scene, hooks, sar_service |
| `scene.rows.SCENE_END.fields` | `6` | `tools/sar_bridge.cjs:49` [setting] 桥对 CAP/SURFACE/OBJECT/SCENE_END/MOVER/MOVER_END 的字段校验 | — | scene, hooks, sar_service |
| `scene.rows.MOVER.fields` | `10` | `tools/sar_bridge.cjs:49` [setting] 桥对 CAP/SURFACE/OBJECT/SCENE_END/MOVER/MOVER_END 的字段校验 | — | scene, hooks, sar_service |
| `scene.rows.MOVER_END.fields` | `6` | `tools/sar_bridge.cjs:49` [setting] 桥对 CAP/SURFACE/OBJECT/SCENE_END/MOVER/MOVER_END 的字段校验 | — | scene, hooks, sar_service |
| `scene.rows.MOVER_FAIL.fields` | `3` | `tools/sar_bridge.cjs:49` [setting] 桥对 CAP/SURFACE/OBJECT/SCENE_END/MOVER/MOVER_END 的字段校验 | — | scene, hooks, sar_service |
| `scene.rows.FAIL.fields[0]` | `3` | `tools/sar_bridge.cjs:49` [setting] 桥对 CAP/SURFACE/OBJECT/SCENE_END/MOVER/MOVER_END 的字段校验 | — | scene, hooks, sar_service |
| `scene.rows.FAIL.fields[1]` | `4` | `tools/sar_bridge.cjs:49` [setting] 桥对 CAP/SURFACE/OBJECT/SCENE_END/MOVER/MOVER_END 的字段校验 | — | scene, hooks, sar_service |
| `scene.rows.BRIDGE_ERROR.fields` | `1` | `tools/sar_bridge.cjs:49` [setting] 桥对 CAP/SURFACE/OBJECT/SCENE_END/MOVER/MOVER_END 的字段校验 | — | scene, hooks, sar_service |
| `scene.commands.SCENE.fields` | `7` | `src/hooks/aesa_sar_scene_hook.lua:65` [setting] 场景桥命令字段数：SCENE 7、MOVER 5、CANCEL/MOVER_CANCEL 1 | — | scene, hooks, sar_service |
| `scene.commands.MOVER.fields` | `5` | `src/hooks/aesa_sar_scene_hook.lua:65` [setting] 场景桥命令字段数：SCENE 7、MOVER 5、CANCEL/MOVER_CANCEL 1 | — | scene, hooks, sar_service |
| `scene.commands.CANCEL.fields` | `1` | `src/hooks/aesa_sar_scene_hook.lua:65` [setting] 场景桥命令字段数：SCENE 7、MOVER 5、CANCEL/MOVER_CANCEL 1 | — | scene, hooks, sar_service |
| `scene.commands.MOVER_CANCEL.fields` | `1` | `src/hooks/aesa_sar_scene_hook.lua:65` [setting] 场景桥命令字段数：SCENE 7、MOVER 5、CANCEL/MOVER_CANCEL 1 | — | scene, hooks, sar_service |
| `limits.aa_line_max_chars` | `null` | `tools/protocol.py:99` [code_default] A/A 解析器没有显式单行上限；null 表示不发明上限 | — | export, sar_service, native |
| `limits.aa_recv_buffer_bytes` | `null` | `tools/protocol.py:88` [code_default] A/A 未设置接收缓冲上限 | — | export, sar_service, native |
| `limits.sar_command_max_chars` | `160` | `src/export/sar_collector.lua:33` [setting] 命令行 160；服务端单行 512、缓冲 65536；场景行 2048、缓冲 65536 | — | export, sar_service, native |
| `limits.sar_server_line_max_chars` | `512` | `src/export/sar_collector.lua:33` [setting] 命令行 160；服务端单行 512、缓冲 65536；场景行 2048、缓冲 65536 | — | export, sar_service, native |
| `limits.recv_buffer_bytes` | `65536` | `src/export/sar_collector.lua:33` [setting] 命令行 160；服务端单行 512、缓冲 65536；场景行 2048、缓冲 65536 | — | export, sar_service, native |
| `limits.sar_export_pending_max_bytes` | `65536` | `src/export/sar_collector.lua:33` [setting] 命令行 160；服务端单行 512、缓冲 65536；场景行 2048、缓冲 65536 | — | export, sar_service, native |
| `limits.scene_line_max_chars` | `2048` | `src/export/sar_collector.lua:33` [setting] 命令行 160；服务端单行 512、缓冲 65536；场景行 2048、缓冲 65536 | — | export, sar_service, native |
| `limits.scene_recv_buffer_bytes` | `65536` | `src/export/sar_collector.lua:33` [setting] 命令行 160；服务端单行 512、缓冲 65536；场景行 2048、缓冲 65536 | — | export, sar_service, native |
| `limits.scene_pending_max_bytes` | `65536` | `src/export/sar_collector.lua:33` [setting] 命令行 160；服务端单行 512、缓冲 65536；场景行 2048、缓冲 65536 | — | export, sar_service, native |
| `limits.scene_partial_fragment_max_chars` | `256` | `src/export/sar_collector.lua:33` [setting] 命令行 160；服务端单行 512、缓冲 65536；场景行 2048、缓冲 65536 | — | export, sar_service, native |
| `limits.map_surface_max_chars` | `96` | `src/export/sar_collector.lua:33` [setting] 命令行 160；服务端单行 512、缓冲 65536；场景行 2048、缓冲 65536 | — | export, sar_service, native |
| `timeouts.aa_reconnect_s` | `2` | `tools/sar_service/service.cjs:382` [setting] STATUS 3 s 陈旧、采集 30 s、MAP 60 s、重试 2 s；场景 8 s、mover 3 s 见 sar_bridge.cjs:91,35 | — | sar_service |
| `timeouts.aa_socket_s` | `30` | `tools/sar_service/service.cjs:382` [setting] STATUS 3 s 陈旧、采集 30 s、MAP 60 s、重试 2 s；场景 8 s、mover 3 s 见 sar_bridge.cjs:91,35 | — | sar_service |
| `timeouts.aa_sse_retry_ms` | `2000` | `tools/sar_service/service.cjs:382` [setting] STATUS 3 s 陈旧、采集 30 s、MAP 60 s、重试 2 s；场景 8 s、mover 3 s 见 sar_bridge.cjs:91,35 | — | sar_service |
| `timeouts.sar_export_reconnect_s` | `2` | `tools/sar_service/service.cjs:382` [setting] STATUS 3 s 陈旧、采集 30 s、MAP 60 s、重试 2 s；场景 8 s、mover 3 s 见 sar_bridge.cjs:91,35 | — | sar_service |
| `timeouts.sar_status_stale_ms` | `3000` | `tools/sar_service/service.cjs:382` [setting] STATUS 3 s 陈旧、采集 30 s、MAP 60 s、重试 2 s；场景 8 s、mover 3 s 见 sar_bridge.cjs:91,35 | — | sar_service |
| `timeouts.sar_capture_timeout_ms` | `30000` | `tools/sar_service/service.cjs:382` [setting] STATUS 3 s 陈旧、采集 30 s、MAP 60 s、重试 2 s；场景 8 s、mover 3 s 见 sar_bridge.cjs:91,35 | — | sar_service |
| `timeouts.sar_map_job_timeout_ms` | `60000` | `tools/sar_service/service.cjs:382` [setting] STATUS 3 s 陈旧、采集 30 s、MAP 60 s、重试 2 s；场景 8 s、mover 3 s 见 sar_bridge.cjs:91,35 | `sar.json#/map/limits/job_timeout_ms` | sar_service |
| `timeouts.sar_map_retry_backoff_ms` | `2000` | `tools/sar_service/service.cjs:382` [setting] STATUS 3 s 陈旧、采集 30 s、MAP 60 s、重试 2 s；场景 8 s、mover 3 s 见 sar_bridge.cjs:91,35 | — | sar_service |
| `timeouts.scene_response_timeout_ms` | `8000` | `tools/sar_service/service.cjs:382` [setting] STATUS 3 s 陈旧、采集 30 s、MAP 60 s、重试 2 s；场景 8 s、mover 3 s 见 sar_bridge.cjs:91,35 | — | sar_service |
| `timeouts.scene_reconnect_s` | `2` | `tools/sar_service/service.cjs:382` [setting] STATUS 3 s 陈旧、采集 30 s、MAP 60 s、重试 2 s；场景 8 s、mover 3 s 见 sar_bridge.cjs:91,35 | — | sar_service |
| `timeouts.scene_reprobe_s` | `5` | `tools/sar_service/service.cjs:382` [setting] STATUS 3 s 陈旧、采集 30 s、MAP 60 s、重试 2 s；场景 8 s、mover 3 s 见 sar_bridge.cjs:91,35 | — | sar_service |
| `timeouts.mover_response_timeout_ms` | `3000` | `tools/sar_service/service.cjs:382` [setting] STATUS 3 s 陈旧、采集 30 s、MAP 60 s、重试 2 s；场景 8 s、mover 3 s 见 sar_bridge.cjs:91,35 | `sar.json#/map/mover/bridge_timeout_ms` | sar_service |
| `mosaic.limit` | `50` | `tools/sar_service/http_api.cjs:93` [setting] 引用 spec/display.json 的 mosaic/dB 定义 | `display.json#/mosaic/limit` | sar_service, viewer |
| `mosaic.poll_ms` | `700` | `tools/sar_service/http_api.cjs:93` [setting] 引用 spec/display.json 的 mosaic/dB 定义 | `display.json#/mosaic/poll_ms` | sar_service, viewer |
| `mosaic.db_step` | `0.25` | `tools/sar_service/http_api.cjs:93` [setting] 引用 spec/display.json 的 mosaic/dB 定义 | `display.json#/db/step` | sar_service, viewer |
| `mosaic.no_data` | `-128` | `tools/sar_service/http_api.cjs:93` [setting] 引用 spec/display.json 的 mosaic/dB 定义 | `display.json#/db/no_data` | sar_service, viewer |
| `db.step` | `0.25` | `tools/sar_service/mosaic_store.cjs:63` [setting] 引用 spec/display.json 的 Int8 dB 定义 | `display.json#/db/step` | sar_service, viewer |
| `db.no_data` | `-128` | `tools/sar_service/mosaic_store.cjs:63` [setting] 引用 spec/display.json 的 Int8 dB 定义 | `display.json#/db/no_data` | sar_service, viewer |
| `db.clamp_min` | `-127` | `tools/sar_service/mosaic_store.cjs:63` [setting] 引用 spec/display.json 的 Int8 dB 定义 | `display.json#/db/clamp_min` | sar_service, viewer |
| `db.clamp_max` | `48` | `tools/sar_service/mosaic_store.cjs:63` [setting] 引用 spec/display.json 的 Int8 dB 定义 | `display.json#/db/clamp_max` | sar_service, viewer |

### Saved Games 部署布局 (`spec/deployment.json`)

| 参数 | 值 | 来源 | ref | 消费者 |
|---|---|---|---|---|
| `saved_games.path_env` | `"USERPROFILE"` | `scripts/install_sar.cjs:90` [setting] 所有安装器要求显式 --saved-games（install_sar.cjs:90；install_export.py:314） | — | scripts/install_*, src/hooks, src/native |
| `saved_games.default_candidates[0]` | `"%USERPROFILE%/Saved Games/DCS"` | `scripts/install_sar.cjs:90` [setting] 所有安装器要求显式 --saved-games（install_sar.cjs:90；install_export.py:314） | — | scripts/install_*, src/hooks, src/native |
| `saved_games.default_candidates[1]` | `"%USERPROFILE%/Saved Games/DCS.openbeta"` | `scripts/install_sar.cjs:90` [setting] 所有安装器要求显式 --saved-games（install_sar.cjs:90；install_export.py:314） | — | scripts/install_*, src/hooks, src/native |
| `saved_games.cli_flag` | `"--saved-games"` | `scripts/install_sar.cjs:90` [setting] 所有安装器要求显式 --saved-games（install_sar.cjs:90；install_export.py:314） | — | scripts/install_*, src/hooks, src/native |
| `saved_games.selection` | `"explicit --saved-games required; no implicit target selection"` | `scripts/install_sar.cjs:90` [setting] 所有安装器要求显式 --saved-games（install_sar.cjs:90；install_export.py:314） | — | scripts/install_*, src/hooks, src/native |
| `saved_games.scripts_root` | `"Scripts"` | `scripts/install_sar.cjs:9` [setting] Scripts/ 下按产品分子目录 | — | scripts/install_*, src/hooks, src/native |
| `saved_games.logs_root` | `"Logs/AESA"` | `src/hooks/aesa_agradar_hook.lua:74` [setting] Logs/AESA；AGR 子目录 AGR | — | scripts/install_*, src/hooks, src/native |
| `products.aa_export.source` | `"src/export/aesa_export.lua"` | `scripts/install_export.py:43` [setting] Scripts/Export.lua 标记块 + Scripts/AESA/aesa_export.lua；备份后缀 .bak-aesa（install_export.py:167） | — | scripts/install_*, src/hooks, src/native |
| `products.aa_export.script` | `"Scripts/AESA/aesa_export.lua"` | `scripts/install_export.py:43` [setting] Scripts/Export.lua 标记块 + Scripts/AESA/aesa_export.lua；备份后缀 .bak-aesa（install_export.py:167） | — | scripts/install_*, src/hooks, src/native |
| `products.aa_export.manifest` | `"Scripts/AESA/manifest.json"` | `scripts/install_export.py:43` [setting] Scripts/Export.lua 标记块 + Scripts/AESA/aesa_export.lua；备份后缀 .bak-aesa（install_export.py:167） | — | scripts/install_*, src/hooks, src/native |
| `products.aa_export.marker_begin` | `"--[[ AESA EXPORT BEGIN ]]"` | `scripts/install_export.py:43` [setting] Scripts/Export.lua 标记块 + Scripts/AESA/aesa_export.lua；备份后缀 .bak-aesa（install_export.py:167） | — | scripts/install_*, src/hooks, src/native |
| `products.aa_export.marker_end` | `"--[[ AESA EXPORT END ]]"` | `scripts/install_export.py:43` [setting] Scripts/Export.lua 标记块 + Scripts/AESA/aesa_export.lua；备份后缀 .bak-aesa（install_export.py:167） | — | scripts/install_*, src/hooks, src/native |
| `products.aa_export.backup_suffix` | `".bak-aesa"` | `scripts/install_export.py:43` [setting] Scripts/Export.lua 标记块 + Scripts/AESA/aesa_export.lua；备份后缀 .bak-aesa（install_export.py:167） | — | scripts/install_*, src/hooks, src/native |
| `products.aa_export.diag_log` | `"Scripts/AESA/export_diag.log"` | `scripts/install_export.py:43` [setting] Scripts/Export.lua 标记块 + Scripts/AESA/aesa_export.lua；备份后缀 .bak-aesa（install_export.py:167） | — | scripts/install_*, src/hooks, src/native |
| `products.sar_export.source` | `"src/export/aesa_sar_export.lua"` | `scripts/install_sar.cjs:15` [setting] Scripts/AESA-SAR；备份 .bak-aesa（install_common.BACKUP_SUFFIX） | — | scripts/install_*, src/hooks, src/native |
| `products.sar_export.script` | `"Scripts/AESA-SAR/aesa_sar_export.lua"` | `scripts/install_sar.cjs:15` [setting] Scripts/AESA-SAR；备份 .bak-aesa（install_common.BACKUP_SUFFIX） | — | scripts/install_*, src/hooks, src/native |
| `products.sar_export.manifest` | `"Scripts/AESA-SAR/manifest.json"` | `scripts/install_sar.cjs:15` [setting] Scripts/AESA-SAR；备份 .bak-aesa（install_common.BACKUP_SUFFIX） | — | scripts/install_*, src/hooks, src/native |
| `products.sar_export.marker_begin` | `"AESA SAR BEGIN"` | `scripts/install_sar.cjs:15` [setting] Scripts/AESA-SAR；备份 .bak-aesa（install_common.BACKUP_SUFFIX） | — | scripts/install_*, src/hooks, src/native |
| `products.sar_export.marker_end` | `"AESA SAR END"` | `scripts/install_sar.cjs:15` [setting] Scripts/AESA-SAR；备份 .bak-aesa（install_common.BACKUP_SUFFIX） | — | scripts/install_*, src/hooks, src/native |
| `products.sar_export.backup_suffix` | `".bak-aesa"` | `scripts/install_sar.cjs:15` [setting] Scripts/AESA-SAR；备份 .bak-aesa（install_common.BACKUP_SUFFIX） | — | scripts/install_*, src/hooks, src/native |
| `products.sar_export.diag_log` | `"Scripts/AESA-SAR/export_diag.log"` | `scripts/install_sar.cjs:15` [setting] Scripts/AESA-SAR；备份 .bak-aesa（install_common.BACKUP_SUFFIX） | — | scripts/install_*, src/hooks, src/native |
| `products.sar_scene.sources[0]` | `"src/hooks/aesa_sar_scene_hook.lua"` | `scripts/install_sar_scene.cjs:15` [setting] Hook 与 scene-manifest 成对部署；mission 源内嵌进 hook | — | scripts/install_*, src/hooks, src/native |
| `products.sar_scene.sources[1]` | `"src/scene/aesa_sar_mission.lua"` | `scripts/install_sar_scene.cjs:15` [setting] Hook 与 scene-manifest 成对部署；mission 源内嵌进 hook | — | scripts/install_*, src/hooks, src/native |
| `products.sar_scene.script` | `"Scripts/Hooks/aesa_sar_scene_hook.lua"` | `scripts/install_sar_scene.cjs:15` [setting] Hook 与 scene-manifest 成对部署；mission 源内嵌进 hook | — | scripts/install_*, src/hooks, src/native |
| `products.sar_scene.manifest` | `"Scripts/AESA-SAR/scene-manifest.json"` | `scripts/install_sar_scene.cjs:15` [setting] Hook 与 scene-manifest 成对部署；mission 源内嵌进 hook | — | scripts/install_*, src/hooks, src/native |
| `products.sar_scene.backup_suffix` | `".bak-aesa"` | `scripts/install_sar_scene.cjs:15` [setting] Hook 与 scene-manifest 成对部署；mission 源内嵌进 hook | — | scripts/install_*, src/hooks, src/native |
| `products.agradar.sources[0]` | `"src/hooks/aesa_agradar_hook.lua"` | `scripts/install_agradar_probe.cjs:19` [setting] Scripts/AESA-AGR；备份 .bak-aesa（install_common） | — | scripts/install_*, src/hooks, src/native |
| `products.agradar.sources[1]` | `"src/native/agradar_probe/aesa_agradar.c"` | `scripts/install_agradar_probe.cjs:19` [setting] Scripts/AESA-AGR；备份 .bak-aesa（install_common） | — | scripts/install_*, src/hooks, src/native |
| `products.agradar.hook` | `"Scripts/Hooks/aesa_agradar_hook.lua"` | `scripts/install_agradar_probe.cjs:19` [setting] Scripts/AESA-AGR；备份 .bak-aesa（install_common） | — | scripts/install_*, src/hooks, src/native |
| `products.agradar.dll` | `"Scripts/AESA-AGR/aesa_agradar.dll"` | `scripts/install_agradar_probe.cjs:19` [setting] Scripts/AESA-AGR；备份 .bak-aesa（install_common） | — | scripts/install_*, src/hooks, src/native |
| `products.agradar.manifest` | `"Scripts/AESA-AGR/agr-manifest.json"` | `scripts/install_agradar_probe.cjs:19` [setting] Scripts/AESA-AGR；备份 .bak-aesa（install_common） | — | scripts/install_*, src/hooks, src/native |
| `products.agradar.dist_dll` | `"dist/dev/aesa_agradar.dll"` | `scripts/install_agradar_probe.cjs:19` [setting] Scripts/AESA-AGR；备份 .bak-aesa（install_common） | — | scripts/install_*, src/hooks, src/native |
| `products.agradar.backup_suffix` | `".bak-aesa"` | `scripts/install_agradar_probe.cjs:19` [setting] Scripts/AESA-AGR；备份 .bak-aesa（install_common） | — | scripts/install_*, src/hooks, src/native |
| `products.agradar.log_dir` | `"Logs/AESA/AGR"` | `scripts/install_agradar_probe.cjs:19` [setting] Scripts/AESA-AGR；备份 .bak-aesa（install_common） | — | scripts/install_*, src/hooks, src/native |
| `products.fc.sources[0]` | `"src/hooks/aesa_fc_hook.lua"` | `scripts/install_fc_probe.cjs:21` [setting] Scripts/AESA-FC；默认 trace，--with-inject 才纳入 inject；备份 .bak-aesa | — | scripts/install_*, src/hooks, src/native |
| `products.fc.sources[1]` | `"src/native/fc_probe/aesa_fc.c"` | `scripts/install_fc_probe.cjs:21` [setting] Scripts/AESA-FC；默认 trace，--with-inject 才纳入 inject；备份 .bak-aesa | — | scripts/install_*, src/hooks, src/native |
| `products.fc.hook` | `"Scripts/Hooks/aesa_fc_hook.lua"` | `scripts/install_fc_probe.cjs:21` [setting] Scripts/AESA-FC；默认 trace，--with-inject 才纳入 inject；备份 .bak-aesa | — | scripts/install_*, src/hooks, src/native |
| `products.fc.trace_dll` | `"Scripts/AESA-FC/aesa_fc_trace.dll"` | `scripts/install_fc_probe.cjs:21` [setting] Scripts/AESA-FC；默认 trace，--with-inject 才纳入 inject；备份 .bak-aesa | — | scripts/install_*, src/hooks, src/native |
| `products.fc.inject_dll` | `"Scripts/AESA-FC/aesa_fc_inject.dll"` | `scripts/install_fc_probe.cjs:21` [setting] Scripts/AESA-FC；默认 trace，--with-inject 才纳入 inject；备份 .bak-aesa | — | scripts/install_*, src/hooks, src/native |
| `products.fc.trace_dist_dll` | `"dist/dev/aesa_fc_trace.dll"` | `scripts/install_fc_probe.cjs:21` [setting] Scripts/AESA-FC；默认 trace，--with-inject 才纳入 inject；备份 .bak-aesa | — | scripts/install_*, src/hooks, src/native |
| `products.fc.inject_dist_dll` | `"dist/dev/aesa_fc_inject.dll"` | `scripts/install_fc_probe.cjs:21` [setting] Scripts/AESA-FC；默认 trace，--with-inject 才纳入 inject；备份 .bak-aesa | — | scripts/install_*, src/hooks, src/native |
| `products.fc.manifest` | `"Scripts/AESA-FC/fc-manifest.json"` | `scripts/install_fc_probe.cjs:21` [setting] Scripts/AESA-FC；默认 trace，--with-inject 才纳入 inject；备份 .bak-aesa | — | scripts/install_*, src/hooks, src/native |
| `products.fc.backup_suffix` | `".bak-aesa"` | `scripts/install_fc_probe.cjs:21` [setting] Scripts/AESA-FC；默认 trace，--with-inject 才纳入 inject；备份 .bak-aesa | — | scripts/install_*, src/hooks, src/native |
| `products.fc.experiment_config` | `"Scripts/AESA-FC/fc_experiment.lua"` | `scripts/install_fc_probe.cjs:21` [setting] Scripts/AESA-FC；默认 trace，--with-inject 才纳入 inject；备份 .bak-aesa | — | scripts/install_*, src/hooks, src/native |
| `products.fc.log_files[0]` | `"Logs/AESA/fc_trace.log"` | `src/native/fc_probe/aesa_fc.c:390` [setting] fc_trace.log / fc_native.log / fc_msl_pos.log 均在 Logs\AESA | — | scripts/install_*, src/hooks, src/native |
| `products.fc.log_files[1]` | `"Logs/AESA/fc_native.log"` | `src/native/fc_probe/aesa_fc.c:390` [setting] fc_trace.log / fc_native.log / fc_msl_pos.log 均在 Logs\AESA | — | scripts/install_*, src/hooks, src/native |
| `products.fc.log_files[2]` | `"Logs/AESA/fc_msl_pos.log"` | `src/native/fc_probe/aesa_fc.c:390` [setting] fc_trace.log / fc_native.log / fc_msl_pos.log 均在 Logs\AESA | — | scripts/install_*, src/hooks, src/native |
| `native.agradar_dll_name` | `"aesa_agradar.dll"` | `src/hooks/aesa_agradar_hook.lua:54` [setting] AGR 探针 DLL 文件名 | — | scripts/install_*, src/hooks, src/native |
| `native.fc_trace_dll_name` | `"aesa_fc_trace.dll"` | `src/hooks/aesa_fc_hook.lua:218` [setting] FC 只读 trace DLL 文件名（默认加载） | — | scripts/install_*, src/hooks, src/native |
| `native.fc_inject_dll_name` | `"aesa_fc_inject.dll"` | `src/hooks/aesa_fc_hook.lua:218` [setting] FC 写注入 DLL 文件名；仅显式 mode=1 且 profile/inject 通过时加载 | — | scripts/install_*, src/hooks, src/native |
| `native.fc_log_dir` | `"%USERPROFILE%/Saved Games/DCS/Logs/AESA"` | `src/native/fc_probe/aesa_fc.c:107` [setting] hook 传入 writedir 下的 Logs\AESA；原生 getenv 默认仅用于独立烟测兜底 | — | scripts/install_*, src/hooks, src/native |

### dB、mosaic、显示/量程/颜色 (`spec/display.json`)

| 参数 | 值 | 来源 | ref | 消费者 |
|---|---|---|---|---|
| `db.step` | `0.25` | `tools/sar_service/mosaic_store.cjs:64` [setting] Int8 量化 = round(db*4)，0.25 dB 步进 | — | sar_service, viewer |
| `db.no_data` | `-128` | `tools/sar_service/mosaic_store.cjs:65` [setting] 非有限 dB 写 -128；不参与插值/统计 | — | sar_service, viewer |
| `db.clamp_min` | `-127` | `tools/sar_service/mosaic_store.cjs:64` [setting] 有效最暗值 -127（≈ -31.75 dB） | — | sar_service, viewer |
| `db.clamp_max` | `48` | `tools/sar_service/mosaic_store.cjs:64` [setting] +12 dB 余量 | — | sar_service, viewer |
| `db.floor_db` | `-40` | `src/sar_core/map.cjs:500` [setting] 完整浮点测到暗值下限 -40 dB；不是 no_data | — | sar_service, viewer |
| `db.peak_norm_default` | `false` | `src/sar_core/map.cjs:500` [setting] MAP 默认固定参考，不做逐帧峰值归一化 | — | sar_service, viewer |
| `db.refs[0]` | `"fixed_material"` | `docs/conventions.md:503` [setting] 每个图像结果必须带 db_ref：fixed_material \| frame_peak | — | sar_service, viewer |
| `db.refs[1]` | `"frame_peak"` | `docs/conventions.md:503` [setting] 每个图像结果必须带 db_ref：fixed_material \| frame_peak | — | sar_service, viewer |
| `db.ref_by_product.sar` | `"frame_peak"` | — | — | sar_service, viewer |
| `db.ref_by_product.map` | `"fixed_material"` | — | — | sar_service, viewer |
| `db.ref_by_product.peak` | `"frame_peak"` | — | — | sar_service, viewer |
| `mosaic.limit` | `50` | `tools/sar_service/mosaic_store.cjs:11` [setting] MOSAIC_LIMIT=50；viewer 的 limit 也是 50 | — | sar_service, viewer |
| `mosaic.poll_ms` | `700` | `tools/sar_viewer.html:1354` [setting] 每 700 ms 轮询 /state；矩阵按 seq 单取 | — | sar_service, viewer |
| `mosaic.fade_min` | `0.45` | `tools/sar_viewer.html:564` [setting] 旧图淡出下限 0.45 | — | sar_service, viewer |
| `mosaic.state_since` | `true` | `tools/sar_service/http_api.cjs:93` [setting] ?since=<seq> 增量轮询 | — | sar_service, viewer |
| `mosaic.image_endpoint` | `"/image/<seq>"` | `tools/sar_service/http_api.cjs:21` [setting] 统一图像端点 /image/<seq>；/mosaic/<seq> 为兼容别名 | — | sar_service, viewer |
| `mosaic.snapshot_endpoint` | `"/snapshot"` | `tools/sar_service/http_api.cjs:34` [setting] 完整结果/输入备份端点 /snapshot | — | sar_service, viewer |
| `sar.range.min_m` | `1000` | `tools/sar_service/collector.cjs:120` [setting] 引用 protocol 的 1-50 km 采集边界 | `protocol.json#/sar/capture/min_range_m` | sar_service, viewer |
| `sar.range.max_m` | `50000` | `tools/sar_service/collector.cjs:120` [setting] 引用 protocol 的 1-50 km 采集边界 | `protocol.json#/sar/capture/max_range_m` | sar_service, viewer |
| `sar.side_window.min_abs_deg` | `20` | `tools/sar_service/arbiter.cjs:18` [setting] 引用 protocol 的 20-160° 侧视窗 | `protocol.json#/sar/image_window/min_angle_deg` | sar_service, viewer |
| `sar.side_window.max_abs_deg` | `160` | `tools/sar_service/arbiter.cjs:18` [setting] 引用 protocol 的 20-160° 侧视窗 | `protocol.json#/sar/image_window/max_angle_deg` | sar_service, viewer |
| `sar.default_range_km` | `20` | `tools/sar_viewer.html:60` [setting] 页面地距默认 20 km，范围 1-50 km | — | sar_service, viewer |
| `sar.contrast_db_options[0]` | `20` | `tools/sar_viewer.html:79` [setting] 20/30/40 dB 显示对比度选项 | — | sar_service, viewer |
| `sar.contrast_db_options[1]` | `30` | `tools/sar_viewer.html:79` [setting] 20/30/40 dB 显示对比度选项 | — | sar_service, viewer |
| `sar.contrast_db_options[2]` | `40` | `tools/sar_viewer.html:79` [setting] 20/30/40 dB 显示对比度选项 | — | sar_service, viewer |
| `sar.contrast_default_db` | `40` | `tools/sar_viewer.html:79` [setting] 默认 40 dB | — | sar_service, viewer |
| `sar.map.range_m` | `20000` | `tools/sar_service/map_session.cjs:272` [setting] 引用 sar.json 的 MAP 服务默认值 | `sar.json#/map/service_defaults/range_m` | sar_service, viewer |
| `sar.map.azimuth_deg` | `60` | `tools/sar_service/map_session.cjs:272` [setting] 引用 sar.json 的 MAP 服务默认值 | `sar.json#/map/service_defaults/azimuth_deg` | sar_service, viewer |
| `sar.map.cell_m` | `250` | `tools/sar_service/map_session.cjs:272` [setting] 引用 sar.json 的 MAP 服务默认值 | `sar.json#/map/service_defaults/cell_m` | sar_service, viewer |
| `sar.map.beam_deg` | `3` | `tools/sar_service/map_session.cjs:272` [setting] 引用 sar.json 的 MAP 服务默认值 | `sar.json#/map/service_defaults/beam_deg` | sar_service, viewer |
| `sar.map.looks` | `4` | `tools/sar_service/map_session.cjs:272` [setting] 引用 sar.json 的 MAP 服务默认值 | `sar.json#/map/service_defaults/looks` | sar_service, viewer |
| `sar.dbs.sharpens[0]` | `8` | `tools/sar_service/dbs_session.cjs:14` [setting] 引用 sar.json 的 DBS 8/32 锐化与近前视 20° | — | sar_service, viewer |
| `sar.dbs.sharpens[1]` | `32` | `tools/sar_service/dbs_session.cjs:14` [setting] 引用 sar.json 的 DBS 8/32 锐化与近前视 20° | — | sar_service, viewer |
| `sar.dbs.default_sharpen` | `8` | `tools/sar_service/dbs_session.cjs:14` [setting] 引用 sar.json 的 DBS 8/32 锐化与近前视 20° | `sar.json#/map/dbs/sharpen_default` | sar_service, viewer |
| `sar.dbs.near_forward_deg` | `20` | `tools/sar_service/dbs_session.cjs:14` [setting] 引用 sar.json 的 DBS 8/32 锐化与近前视 20° | `sar.json#/map/dbs/near_forward_deg` | sar_service, viewer |
| `sar.sweep.min_angle_deg` | `30` | `tools/sar_service/sweep_planner.cjs:18` [setting] 引用 sar.json 的扫掠窗口 30-60°/1-50 km | `sar.json#/map/sweep/min_angle_deg` | sar_service, viewer |
| `sar.sweep.max_angle_deg` | `60` | `tools/sar_service/sweep_planner.cjs:18` [setting] 引用 sar.json 的扫掠窗口 30-60°/1-50 km | `sar.json#/map/sweep/max_angle_deg` | sar_service, viewer |
| `sar.sweep.min_range_m` | `1000` | `tools/sar_service/sweep_planner.cjs:18` [setting] 引用 sar.json 的扫掠窗口 30-60°/1-50 km | `sar.json#/map/sweep/min_range_m` | sar_service, viewer |
| `sar.sweep.max_range_m` | `50000` | `tools/sar_service/sweep_planner.cjs:18` [setting] 引用 sar.json 的扫掠窗口 30-60°/1-50 km | `sar.json#/map/sweep/max_range_m` | sar_service, viewer |
| `sar.colors.background` | `"#090d12"` | `tools/sar_viewer.html:6` [setting] 页面背景/图例渐变；地表色见 94 行 | — | sar_service, viewer |
| `sar.colors.legend_gradient[0]` | `"#19376e"` | `tools/sar_viewer.html:6` [setting] 页面背景/图例渐变；地表色见 94 行 | — | sar_service, viewer |
| `sar.colors.legend_gradient[1]` | `"#46b4a0"` | `tools/sar_viewer.html:6` [setting] 页面背景/图例渐变；地表色见 94 行 | — | sar_service, viewer |
| `sar.colors.legend_gradient[2]` | `"#ead78c"` | `tools/sar_viewer.html:6` [setting] 页面背景/图例渐变；地表色见 94 行 | — | sar_service, viewer |
| `sar.colors.surface.land[0]` | `125` | `tools/sar_viewer.html:6` [setting] 页面背景/图例渐变；地表色见 94 行 | — | sar_service, viewer |
| `sar.colors.surface.land[1]` | `150` | `tools/sar_viewer.html:6` [setting] 页面背景/图例渐变；地表色见 94 行 | — | sar_service, viewer |
| `sar.colors.surface.land[2]` | `90` | `tools/sar_viewer.html:6` [setting] 页面背景/图例渐变；地表色见 94 行 | — | sar_service, viewer |
| `sar.colors.surface.unknown[0]` | `90` | `tools/sar_viewer.html:6` [setting] 页面背景/图例渐变；地表色见 94 行 | — | sar_service, viewer |
| `sar.colors.surface.unknown[1]` | `90` | `tools/sar_viewer.html:6` [setting] 页面背景/图例渐变；地表色见 94 行 | — | sar_service, viewer |
| `sar.colors.surface.unknown[2]` | `90` | `tools/sar_viewer.html:6` [setting] 页面背景/图例渐变；地表色见 94 行 | — | sar_service, viewer |
| `sar.colors.surface.water[0]` | `25` | `tools/sar_viewer.html:6` [setting] 页面背景/图例渐变；地表色见 94 行 | — | sar_service, viewer |
| `sar.colors.surface.water[1]` | `55` | `tools/sar_viewer.html:6` [setting] 页面背景/图例渐变；地表色见 94 行 | — | sar_service, viewer |
| `sar.colors.surface.water[2]` | `110` | `tools/sar_viewer.html:6` [setting] 页面背景/图例渐变；地表色见 94 行 | — | sar_service, viewer |
| `sar.colors.surface.shallow_water[0]` | `70` | `tools/sar_viewer.html:6` [setting] 页面背景/图例渐变；地表色见 94 行 | — | sar_service, viewer |
| `sar.colors.surface.shallow_water[1]` | `180` | `tools/sar_viewer.html:6` [setting] 页面背景/图例渐变；地表色见 94 行 | — | sar_service, viewer |
| `sar.colors.surface.shallow_water[2]` | `160` | `tools/sar_viewer.html:6` [setting] 页面背景/图例渐变；地表色见 94 行 | — | sar_service, viewer |
| `sar.colors.surface.road[0]` | `195` | `tools/sar_viewer.html:6` [setting] 页面背景/图例渐变；地表色见 94 行 | — | sar_service, viewer |
| `sar.colors.surface.road[1]` | `150` | `tools/sar_viewer.html:6` [setting] 页面背景/图例渐变；地表色见 94 行 | — | sar_service, viewer |
| `sar.colors.surface.road[2]` | `80` | `tools/sar_viewer.html:6` [setting] 页面背景/图例渐变；地表色见 94 行 | — | sar_service, viewer |
| `sar.colors.surface.runway[0]` | `230` | `tools/sar_viewer.html:6` [setting] 页面背景/图例渐变；地表色见 94 行 | — | sar_service, viewer |
| `sar.colors.surface.runway[1]` | `210` | `tools/sar_viewer.html:6` [setting] 页面背景/图例渐变；地表色见 94 行 | — | sar_service, viewer |
| `sar.colors.surface.runway[2]` | `175` | `tools/sar_viewer.html:6` [setting] 页面背景/图例渐变；地表色见 94 行 | — | sar_service, viewer |
| `aa.kt_per_mps` | `1.94384` | `tools/viewer/index.html:130` [setting] KT/KNM/M2NM 显示换算；ft 见 264 行 | — | sar_service, viewer |
| `aa.nm_per_km` | `0.539957` | `tools/viewer/index.html:130` [setting] KT/KNM/M2NM 显示换算；ft 见 264 行 | — | sar_service, viewer |
| `aa.m_per_nm` | `1852` | `tools/viewer/index.html:130` [setting] KT/KNM/M2NM 显示换算；ft 见 264 行 | — | sar_service, viewer |
| `aa.ft_per_m` | `3.28084` | `tools/viewer/index.html:130` [setting] KT/KNM/M2NM 显示换算；ft 见 264 行 | — | sar_service, viewer |
| `aa.range_scale_nm[0]` | `5` | `tools/viewer/index.html:130` [setting] 可选量程 5/10/20/40/80/120/160/200 NM | — | sar_service, viewer |
| `aa.range_scale_nm[1]` | `10` | `tools/viewer/index.html:130` [setting] 可选量程 5/10/20/40/80/120/160/200 NM | — | sar_service, viewer |
| `aa.range_scale_nm[2]` | `20` | `tools/viewer/index.html:130` [setting] 可选量程 5/10/20/40/80/120/160/200 NM | — | sar_service, viewer |
| `aa.range_scale_nm[3]` | `40` | `tools/viewer/index.html:130` [setting] 可选量程 5/10/20/40/80/120/160/200 NM | — | sar_service, viewer |
| `aa.range_scale_nm[4]` | `80` | `tools/viewer/index.html:130` [setting] 可选量程 5/10/20/40/80/120/160/200 NM | — | sar_service, viewer |
| `aa.range_scale_nm[5]` | `120` | `tools/viewer/index.html:130` [setting] 可选量程 5/10/20/40/80/120/160/200 NM | — | sar_service, viewer |
| `aa.range_scale_nm[6]` | `160` | `tools/viewer/index.html:130` [setting] 可选量程 5/10/20/40/80/120/160/200 NM | — | sar_service, viewer |
| `aa.range_scale_nm[7]` | `200` | `tools/viewer/index.html:130` [setting] 可选量程 5/10/20/40/80/120/160/200 NM | — | sar_service, viewer |
| `aa.colors.grid` | `"#18242e"` | `tools/viewer/index.html:156` [setting] IFF/航迹/背景颜色 | — | sar_service, viewer |
| `aa.colors.grid_text` | `"#54707e"` | `tools/viewer/index.html:156` [setting] IFF/航迹/背景颜色 | — | sar_service, viewer |
| `aa.colors.band` | `"#0d151c"` | `tools/viewer/index.html:156` [setting] IFF/航迹/背景颜色 | — | sar_service, viewer |
| `aa.colors.search` | `"#2ec8e0"` | `tools/viewer/index.html:156` [setting] IFF/航迹/背景颜色 | — | sar_service, viewer |
| `aa.colors.track` | `"#ff9a3c"` | `tools/viewer/index.html:156` [setting] IFF/航迹/背景颜色 | — | sar_service, viewer |
| `aa.colors.stt` | `"#ff5252"` | `tools/viewer/index.html:156` [setting] IFF/航迹/背景颜色 | — | sar_service, viewer |
| `aa.colors.confirmed` | `"#39d6ff"` | `tools/viewer/index.html:156` [setting] IFF/航迹/背景颜色 | — | sar_service, viewer |
| `aa.colors.tentative` | `"#ffd24a"` | `tools/viewer/index.html:156` [setting] IFF/航迹/背景颜色 | — | sar_service, viewer |
| `aa.colors.truth` | `"#8a97a0"` | `tools/viewer/index.html:156` [setting] IFF/航迹/背景颜色 | — | sar_service, viewer |
| `aa.colors.iff_friend` | `"#4db8ff"` | `tools/viewer/index.html:156` [setting] IFF/航迹/背景颜色 | — | sar_service, viewer |
| `aa.colors.iff_hostile` | `"#ff5252"` | `tools/viewer/index.html:156` [setting] IFF/航迹/背景颜色 | — | sar_service, viewer |
| `aa.colors.iff_unknown` | `"#ffd24a"` | `tools/viewer/index.html:156` [setting] IFF/航迹/背景颜色 | — | sar_service, viewer |

## 尚未迁移的消费者

本任务只建立 spec/生成物与测试，不修改消费者。以下文件仍在使用各自的旧常量/旧键，后续 Gate 或并行迁移任务必须改为从生成物导入：

- `src/core/*.lua`：A/A 核心直接消费 `src/shared/config.lua`（`core/init.build` 加载）
- `src/export/aesa_export.lua`：端口 3590、`V1`、10 Hz、A/T/O/L/E 行
- `src/export/aesa_sar_export.lua`：端口 3592、`SAR1`、footprint、MAP 上限、1–50 km
- `src/scene/aesa_sar_mission.lua` / `src/hooks/aesa_sar_scene_hook.lua`：场景桥 3594、mover 上限
- `tools/sar_*.cjs`：SAR 物理默认值、profiles、footprints、materials、MAP/DBS、PFA
- `tools/sar_live.cjs`：端口 3592/3593/3594、MAP 服务默认值、mosaic、dB、超时
- `tools/sar_bridge.cjs`：3594、mover 超时/上限
- `tools/receiver.py` / `tools/live.py` / `tools/replay.py`：3590/3591、`V1` 行 schema
- `tools/sar_viewer.html` / `tools/viewer/index.html`：dB 解码、量程、轮询、颜色、1–50 km/20–160° 文案
- `scripts/install_*.cjs` / `scripts/install_export.py`：部署路径、备份后缀、manifest
- `src/hooks/*.lua` / `src/native/*/*.c`：DLL 名、日志目录、原生常量


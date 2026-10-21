# aesa — DCS 原理级有源相控阵雷达仿真

在**不改 DCS World 引擎雷达内核**的前提下，自建一套从物理与调度原理出发的 AESA（有源相控阵）雷达仿真核心，并以官方 F-16C 为宿主机分阶段接入 DCS。

## 这是什么、不是什么

DCS 现役玩家机雷达全部是"机械扫描 + 脉冲多普勒"，且其探测逻辑闭源（全真模块在各自 DLL 的 C++ 设备里，FC3/AI 在加密数据库里）。本项目**不是**给现有雷达改参数，而是自建一套与引擎同构的"全知真值 + 传感器滤波"仿真：

- **要模拟的**：AESA 的本质是波束指向可编程——仿真的灵魂是**驻留时间轴调度器**（搜索光栅、航迹回访、STT、模式交织在时间轴上复用），每个驻留内用雷达方程 + Swerling 检测统计 + PRF 盲区/notch 判定。
- **数据政策**：目标侧真值（位置/速度/机型 RCS）全部锚定 DCS 官方数据；唯一自建假设层是雷达自身参数（公开资料估计）与可选的姿态 RCS 增强，全部显式标注。

完整可行性论证（DCS 雷达分层实证、社区模组边界、硬边界清单）见 [docs/feasibility.md](docs/feasibility.md)。

2026-10-17 起进入架构重构 Gate 0，基线冻结 tag 为 `pre-arch-refactor`；Gate 0–7 已完成。Gate 6（原生/部署/文档）交付 `fc_trace`/`fc_inject` 双构建、默认只读、部署统一与审计清零；Gate 7（全量回归与收口）完成 `test_all` 483 项 × 3、flight3/flight9 回放逐字节一致、SAR detail/area 与基线 0 差异、安装生命周期清理，并修复 SAR bundle 漏发 `profile_data` 导致 Export 未安装的生产缺陷。实机 A/A 1186 帧 / 123.177 s（9.628 Hz）、SAR `connected; height=true surface=true`、FC trace 13/13 hooks/默认只读、AGR loaded；`compat_check` level B（required 全 ok）。最终 tag `arch-refactor-complete`。执行计划见 [docs/refactor-plan.md](docs/refactor-plan.md)，当前文件地图见 [docs/file-inventory.md](docs/file-inventory.md)。

## 路线图

| 阶段 | 内容 | 状态 |
|---|---|---|
| 一 | 纯 Lua 仿真核心（调度器/雷达方程/航迹管理）+ 单元测试 | **原型开发中**，已有部分公式和管道测试 |
| 二 | Export 采样 + 录制/回放 + 引擎雷达对照 | **原型开发中**，历史版本接入已打通，持续验证 |
| 三 | 3a 外部显示器 → 3b 座舱页面+窗口贴附 → 3c 帧内渲染 | **3a 原型开发中**；3b 已开始：覆盖 FCR A/A 页的 C1 页面/桥接（离线测试通过，实机启动被本机 DCS/输入法注入崩溃阻塞）；显示层可在 `tools/cockpit_preview.html` 调整预览；3c 未开始 |
| 四 | 连续姿态角 RCS 曲线（可选高保真层，默认关） | 未开始 |

已知硬边界（详见 feasibility §3）：自建雷达的辐射不会出现在敌方 RWR 上；引擎导弹导引不认脚本航迹；玩家间数据共享用 DCS 自带的 `Scripts\RPC.lua` 通道。

## 仓库结构（当前实际）

```text
配置生成链：spec/*.json → scripts/gen_config.cjs → src/shared/{config.lua, protocol.lua,
config.cjs} + src/native/generated/config.h（--check 零 diff 是合并门禁）

┌─ 宿主机（DCS 进程外） ────────────────────────────────────────────────┐
│ tools/sar_service/* ─▶ src/sar_core（纯 JS SAR 核心）                  │
│ tools/{live,receiver,replay}.py ─▶ src/core（纯 Lua A/A 核心）         │
│ tools/cockpit_bridge.py ─▶ state.txt（10 Hz）                          │
│ sar_viewer.html、viewer/（只读 snapshot/图像，不重算物理）              │
└──────▲───────────────▲─────────────────────────▲────────────▲─────────┘
       │TCP 3590/3592  │TCP 3594                 │TCP 3592    │state.txt
       │（A/A+SAR 下行）│（场景查询上行）          │（SAR 下行） │（座舱上行）
╪══════╪═══════════════╪═════════════════════════╪════════════╪══════════╪
┌──────┴───────┐ ┌─────┴──────┐           ┌──────┴───────┐ ┌──┴───────────┐
│ src/export   │ │ src/scene  │           │ src/hooks    │ │ cockpit 页面  │
│ A/A+SAR 采样  │ │ 任务场景桥  │           │ 3 个 hook     │ │ + controller │
└──────▲───────┘ └─────▲──────┘           └──────▲───────┘ └──▲───────────┘
       └───────────────┴────────┬───────────────┴──────────────┘
                                │ AESA_RUNTIME（scripts/build_runtime.cjs 打包）
              ┌─────────────────┴──────────────────────────────────┐
              │ src/adapters/dcs —— 唯一的 DCS 语义层               │
              │ frame · truth_replay · rcs · api/* · compat         │
              └───────▲──────────────────────────▲─────────────────┘
                      │                          │ package.loadlib
        ┌─────────────┴───────────┐   ┌──────────┴─────────────────┐
        │ src/core / src/sar_core │   │ src/native（C：agradar +    │
        │ 纯核心，不依赖 DCS       │   │ fc_trace/fc_inject，默认只读）│
        └─────────────────────────┘   └────────────────────────────┘
```

| 目录 | 内容 |
|---|---|
| `spec/` | 单一事实源：physics / radar / sar / protocol / deployment / display JSON + dcs_profiles |
| `src/core`、`src/sar_core` | 纯仿真核心（Lua A/A、JS SAR）：无 DCS、无 IO、无文件系统 |
| `src/adapters/dcs/` | 唯一 DCS 语义层：frame（DCS↔ENU 唯一转换）、truth_replay、rcs、api/compat、cockpit 页 |
| `src/export`、`src/scene`、`src/hooks` | DCS 进程内入口：Export 采样、任务场景桥、Saved Games Hooks 生命周期 |
| `src/native/` | C 探针：agradar_probe（只读地表）、fc_probe（trace/inject 双构建）、third_party/minhook |
| `tools/` | 宿主机侧：sar_service 服务模块、Python 工具链（lua_host/protocol/ingest/truth + 薄 CLI）、viewer |
| `scripts/` | 数据提取、配置生成、原生构建、部署/卸载、compat_check、统一测试/审计 |
| `tests/` | Python + lupa、Node node:test、Lua 5.1 与原生 DLL 测试；baseline/ 与 fixtures/ |
| `docs/` | 设计、理论、兼容、测试、重构文档；research/ 为外部调研（只读） |
| `dist/`、`recordings/`、`worklog/` | 本机产物与用户数据（gitignored；dist 仅 .gitkeep 入库） |

完整文件地图与依赖硬规则见 [docs/architecture.md](docs/architecture.md) 与 [docs/file-inventory.md](docs/file-inventory.md)。

## 架构与开发文档

| 文档 | 内容 |
|---|---|
| [docs/refactor-plan.md](docs/refactor-plan.md) | 架构重构执行计划：范围、决策、Gate 0–7、测试/清理/回滚标准 |
| [docs/gate-6-plan.md](docs/gate-6-plan.md) | Gate 6 实施计划：原生 `fc_trace`/`fc_inject` 拆分、部署统一、审计清零、实机与收口 |
| [docs/architecture.md](docs/architecture.md) | 模块边界、依赖方向、文件地图与 ADR（Gate 0 建立） |
| [docs/conventions.md](docs/conventions.md) | 坐标/角度/时间/单位/栅格/dB/协议版本约定 |
| [docs/dcs-compat.md](docs/dcs-compat.md) | DCS 版本耦合面、profile/探针位置与游戏更新流程 |
| [docs/testing-gates.md](docs/testing-gates.md) | 测试矩阵、门禁定义、三色判定与基线规则 |
| [docs/file-inventory.md](docs/file-inventory.md) | 文件盘点：现役/生成/历史/外部参考/实验/删除候选 |
| [DEPRECATIONS.md](DEPRECATIONS.md) | 废弃文件与符号登记表（含计划删除 Gate） |
| [AGENTS.md](AGENTS.md) | 仓库级开发约定、测试口令、安全边界与清理纪律 |

延伸阅读：[可行性调研](docs/feasibility.md)、[理论笔记](docs/theory-notes.md)、[SAR 任务内验证](docs/sar-in-mission.md)、[SAR 可行性](docs/sar-feasibility.md)、[表面质量](docs/sar-surface-quality.md)、[DCS 地形/地图接口](docs/dcs-map-terrain-interfaces.md)、[显示矢量规则](docs/viewer-vectors.md)。开发过程的工作日志为本机记录，未入库。[docs/status.md](docs/status.md) 为历史快照，不再维护。

## 开发

- 核心代码必须兼容 **Lua 5.1**（DCS 同版本语义），纯函数、无 `os/io/require`（入口除外）、随机数可注种——同一配置+真值+种子必然复现同一结果。
- 环境：Python 3 + `pip install lupa`（使用 `lupa.lua51`）；Node.js；Lua 5.1 使用 DCS 自带 `<DCS>/bin/luae.exe`。
- **Gate 0 起统一入口**：`node scripts/test_all.cjs` 跑 Python 核心/回归、Gate 回归、SAR Node、Lua 5.1 安装与原生套件并报告 pass/fail/skip；`node scripts/audit_repo.cjs` 检查残留、重复常量、游戏 API 越界、旧引用与文档状态；`node scripts/compat_check.cjs` 读取 probe/原生日志并做 A/B/C/blocked 判定。回放基线需单独运行。单项命令、`AESA_LUA` 设置与 skip 规则见 [AGENTS.md](AGENTS.md#测试与跳过规则)。
- 单独运行核心测试：`python tests/run_tests.py`、`python tests/test_review_regressions.py`；SAR/显示：`node --test tests/test_sar_*.cjs`、`node --test tests/test_viewer_vectors.cjs`。
- 显示层速度线与预测线的含义、限长规则见 [显示说明](docs/viewer-vectors.md)。
- SAR 原型：[任务内验证说明](docs/sar-in-mission.md)，独立 Export 采集地形和实际轨迹，`node tools/sar_live.cjs` 在外部生成模拟复数回波并聚焦；本机 DCS 任务的小切片采集、成像和离线重算已验证，地表散射仍为假设。另有 [可行性研究](docs/sar-feasibility.md)及 `node scripts/sar_principle_probe.cjs` 离线物理实验。尚未接入 AESA 调度器或座舱页面。
- SAR 表面更新：[散射与质量检查](docs/sar-surface-quality.md)，减少高程顶点伪影，提供 Hann/矩形窗及同一输入重算；`node scripts/sar_quality_probe.cjs` 生成可复现点响应指标与模型对照。
- SAR 选区：页面支持按 F10 经纬度固定 128 m 地形切片，并显示确认中心、地距与相对航迹角；支持十进制度、度分和度分秒。建筑几何尚未采集，选中建筑位置不代表已实现建筑成像；操作见任务内验证说明。
- SAR 连续采集：页面一键开始/停止，自动随航迹重复采集小切片，断线/暂停等待恢复，保留上一张图；默认不持续写原始文件。切片之间可能有空隙，尚非全地面覆盖。**永不自动停止**：采集/计算失败只累计 `failures` 并在 2 s 后重试；几何不合适（斜视角不在 20–160° 窗口、侧向孔径不足、转弯/升降过大、状态过期）时跳过这一次机会并在状态行给出原因，跳过次数记在 `skipped`，被跳过的切片不计算、不落盘。侧向可选“左右交替”（每次换边，一次通过覆盖航迹两侧），默认仍是固定右侧。
- SAR 广域扫掠（`mode:'sweep'`）：瓦片是**固定世界方格**（边长 `sweepSize`：512（默认）或 2048 m；格号 `floor(x/S),floor(z/S)`、中心 `((tx+0.5)·S,(tz+0.5)·S)`），飞机前进只是让成像窗口在格网上滑动，没有跟随重排。每次采集前**按预测位姿**重算候选：预测位姿 = 本机沿平均速度前推 10 s（2 s 轨迹 + 快速档计算 + 排队余量），候选对预测位姿需满足地距 **1.5–50 km**（Export 下限 1 km 之上再留 0.5 km ≈ 317 m/s 下 1.6 s 余量）、|相对航迹角| 30–60°，剔除已覆盖与退避中的瓦片，**前方优先**（5° 角度分档，同档内先近后远），前 20 条即 `continuous.sweepPlan`；几何门控与选格跑在同一预测位姿上，无速度信息时退回旧行为（本机位姿 + 1 km 下限）。覆盖判据是拼接层里 `size_m` 不小于该瓦片、中心距 ≤ 其半边对角线（512→362 m，2048→1448 m）的图像，剔除数与 60 s 退避数记在 `sweepPruned`/`sweepDeferred`；2048 m 瓦片超出 PFA 的 k 网格上限时自动改用反投影并在状态行说明。模拟脉冲上限不再固定 8192，而按回波历史预算推导（`pulseLimit = min(32768, 448 MiB / (距离 bin × 16 B))`，512 m 格约 16.5 k 脉冲），超限仍拒绝并同时给出实际需要与允许值，拒收只退避该瓦片、从不停止扫掠。`sweepPlan`（每格 `{center,bearing,size_m,side,angleDeg,rangeM,status}`）、`sweepIndex`、`sweepAnchor`、`sweepSize` 在 `/state` 暴露。文档见 [任务内验证说明](docs/sar-in-mission.md)。
- SAR 实波束底图（`mode:'map'`）：SAR 小块下面的**粗分辨率地面图**，不做孔径合成——方位分辨率就是天线波束（3° 在 10 km 约 520 m、30 km 约 1.6 km），管线为材质系数 × 余弦入射、DEM 射线遮蔽、乘性散斑、波束方向图卷积、多普勒锐化与可选 STC，全在显示栅格上运算（默认扇形 161²/40 km 单帧约 20 ms）。扫描形状是**本机前方 ±60°、半径 20 km 的扇形**：实波束没有多普勒盲锥，正前方看得见，所以 `side`/`angle`/`span` 这些方窗参数已不再有意义（接受但忽略）；方位向按**多普勒锥角锐化**（`dbs_factor` 默认 8:1，近前视保留实波束，真机 MAP 档同理），底图因此是 MAP 家族身份（`mode/quality='map'`、`focuser='real-beam'`）而锐化口径写在 `metadata.dbs` 与 `map.lastFrame.sharpen`。清晰度三件事：散斑默认 **4 视**（250 m 格上单视只是颗粒）且**按世界格生成**（服务端固定帧号，滚动拼接不闪烁接缝），dB 用**固定基准**（0 dB = 最亮材质法向入射、斑点均值，`stc:true` 完全补偿 1/R⁴，均匀地面不再有距离亮度坡，`peak_norm:true` 可退回旧的逐帧峰值归一）。Export 侧新增 `CAPTURE_MAP`（世界固定粗格，17 格/帧），服务端只申请扇形内尚未采集的格子：首扇形 6698 格、107 个任务，前进 ≥1 km 或转向 ≥12° 重摆扇形时只补约 548 格（1 km）。扇形以外与未采集的格子是**无数据**（量化矩阵里的 −128 哨兵），底图走既有 mosaic 通道、条目带 `mode:'map'` 与该帧的 `sector`/`dbs`，不占用 ②③ 栏与 `/snapshot`；假设清单、参数与边界见 [任务内验证说明](docs/sar-in-mission.md)。
- SAR DBS 放大小块（`POST /dbs`，mosaic 条目 `mode:'dbs'`）：底图与 128 m SAR 精看之间的**中间档**，点选一点即在**独立的 25 m 格网**上采一小块（默认 512 m = 21×21 = 441 格 ≈ 0.5–1 s），方位向响应用**多普勒波束锐化**收窄——数学照抄 DCS 官方雷达着色器 `Bazar/shaders/enlight/radar.fx` 的 `blurRadialDBS`（λ = 0.03、锥角公式、核宽 ∝ 锥角 × resolution，本项目钉 `resolution = 2·factor`），倍数 DBS1 = 8:1、DBS2 = 32:1；正前方退化为实波束而**不挖空**（`metadata.dbs` 报告有效锐化范围与近前视格数），无地速时整块退化并说明原因。参数 `{x,z,span_m 256–1024,sharpen 8|32}`，请求写错 400、状态不允许 409（无位姿 / 地距不在 1–50 km / SAR 占用中 / DBS 已在进行）；抢占顺序 **SAR > DBS > 巡逻**，巡逻让路后自动恢复；`/state` 的 `canDbs` 与 `dbs` 段供页面门控与状态行（`lastFrame.seq` 指向 mosaic 里那块），25 m 格网跨点选保留、同一点再拍直接复用已采集格。
- SAR GMTI 动目标：mission 采样器每 2 s 报一次 50 km 内**地面动目标**（UNIT/STATIC、非空中、自身地速 ≥1 m/s）的位置与速度矢量，服务端按真实 GMTI 的**多普勒盲区**过滤——判据是目标自身沿视线的径向速度 `v目标·u`（杂波抑制消掉的是平台的多普勒），`|v| < 2 m/s`（RQ-4 级 4 kt，`moverMdvMps` 可配）不进画面，静止车辆与横穿波束的目标一并消失；`GET /state` 给出 `movers:[{x,z,speed,headingDeg,ageS}]`（按距离近→远，≤64 条），桥不可用/超时/无本机位姿时 `movers:null` 并把原因写进 `moversNote`，绝不拿旧列表冒充实时。查询与栅格采集是场景桥上两个独立作业（`MOVER` 命令，16 行/帧节流、3 s 墙钟超时），旧钩子只报 movers `unavailable`。语义与降级分支见 [任务内验证说明](docs/sar-in-mission.md)。
- SAR 地理锚定拼接（余辉）：服务保留最近 50 张已完成图像的世界锚点（`mosaicLimit` 可配，超出丢最旧，仅内存、重启不留），`GET /state?since=<seq>` 只回增量摘要（稳态约 1 KB/次），矩阵按需从 `GET /mosaic/<seq>` 取（0.25 dB 量化 Int8，淘汰的 seq 返 404），`ownship` 给出最近采集的机位/航向/航迹；页面用这些把图像钉在世界坐标画布上叠加显示。
- SAR 精细档：150 MHz 模拟波形、0.5 m 输出与独立显示对比度；理想距离点响应约减半，真实地形/建筑输入没有增加。`scripts/sar_precision_probe.cjs` 生成同一实飞录制的标准/精细对照。
- SAR 快速测试档：出图优先档把输出像素减半（129→65、257→129）、散射单元加倍（1→2 m、4→8 m、16→32 m）、脉冲过采样 2.5→1.5（带宽不变，降低过采样可能混叠）；参数写入图像元数据并在页面标注，仅用于缩短测试时间，不参与分辨率对照。
- SAR 并行成像：成像改用 worker 线程池（min(核数−1, 12)），回波合成按脉冲分块、反投影按像素行分块，结果与单线程逐位一致（实测逐像素 0 差异）；估算工作量低于 0.8 s 的小图仍走单 worker。本机 512 m 标准档 54.8→8.4 s、128 m 标准档 12.3→1.9 s、128 m 快速档 2.1→0.5 s。
- SAR 第二聚焦路径（PFA）：`tools/sar_pfa.cjs` 自写 radix-2 FFT，逐脉冲距离 FFT → 极坐标重采样 → 二维逆 FFT；页面“聚焦器”与 `--focuser backprojection|pfa` 可选，聚焦器写入元数据。聚焦段实测快 8–11 倍（512 m 标准档 129 ms 对 1082 ms），点目标主瓣/旁瓣与反投影基本一致（FWHM 差 <2%、位置误差 ≤0.2 m），但按平面波近似成像：地形起伏当平地、大切片边缘有米级位移与不同散斑；逐像素相关系数 0.58–0.90、多视后 ±3 dB 占 88–100%。边界与数据见 [可行性文档](docs/sar-feasibility.md)，`node scripts/sar_pfa_probe.cjs` 可复现。
- SAR 多视降斑：页面在功率域对已显示的线性功率矩阵做 1×1/2×2/3×3 块均值（默认 2×2）再转 dB，即时重画当前帧；不重算回波、不新增请求，输出按块降分辨率。
- SAR 地图对照：页面并排显示用户共享的 DCS/F10 窗口、同区高程与 SAR，后两图同中心/方向/时间并联动查看。F10 需在游戏内打开，未自动定位或配准；[接口与使用边界](docs/dcs-map-terrain-interfaces.md)列明任务/Export/GUI 的区别。`GET /snapshot` 可备份已显示图及对应原始输入，重启后保留历史时间和重算能力。
- SAR 真实系统校准：[公开资料调研](docs/research/sar-real-world-usage.md)（2026-10-09/10，战斗机 AESA、卫星 SAR、成像几何、实时处理、作战使用五份笔记）汇总分辨率阶梯（RBM→DBS→SAR patch）、stripmap/宽域覆盖机制、正前盲锥与斜视窗口、patch 节奏等公开锚点，用于校准仿真参数与显示节奏。
- 当前为早期开发阶段，暂无发布包。开发验证可通过 `python scripts/install_export.py install --saved-games "<DCS Saved Games目录>"` 部署采样源码；FC 探针默认只装 trace：`node scripts/install_fc_probe.cjs install --saved-games "<DCS Saved Games目录>" --lua "<DCS>/bin/luae.exe"`，需要写实验时才加 `--with-inject`（仍要求 `fc_experiment.lua` 显式 `mode=1`）。修复/卸载见 [数据层设计](docs/design-phase2.md)。
- **用户部署不需要兼容探针**：`scripts/install_compat_probe.cjs` 是开发者/DCS 更新诊断工具，不属于用户安装清单；当前开发机保留安装，普通用户或未来开源使用者不需要安装它。
- 2026-09-30 审查修复覆盖调度时间、部署保护、协议解析、notch 混叠、双侧遮蔽、波束损失、姿态、视距及 PRF 搜索；详见 [修复记录](docs/review-fixes.md)。新版 O/L Export 扩展仍待实飞验证。
- 当前验证（2026-10-19，Gate 7 收口 + 接收器流式修复 + 座舱 C1/C1.5 离线）：`node scripts/test_all.cjs` → 11 个套件 / **499 项通过**（Gate 7 为 483，新增接收器流式回归、3 项座舱 C1 测试与 12 项座舱状态桥测试）、0 失败、0 跳过；`node scripts/audit_repo.cjs --strict` → 0 new / 0 known（allowlist 为空）；`node scripts/gen_config.cjs --check` 零 diff。flight3（1608 帧 / 6 确认）与 flight9（6716 帧 / 5 确认）各 3 次回放逐字节一致，与 Gate 0 基线逐项 0 差异；SAR detail/area 基线 0 差异，512 m 图像矩阵 3 次一致，2048 m smoke 通过。`compat_check` level B（required 全 ok）。实机：A/A 1186 帧 / 123.177 s（9.628 Hz）、SAR `connected; height=true surface=true`、FC trace 17/17 符号/13/13 hooks/默认只读、AGR loaded、无 AESA error。
- RCS 官方标量表由 `python scripts/extract_rcs.py <DCS安装目录>` 生成（`src/adapters/dcs/rcs_data.lua`，生成文件勿手改；DCS 机型分类在 `src/adapters/dcs/rcs.lua`，核心 `src/core/rcs.lua` 只提供接口；提取不到的机型走分档兜底并在运行时标注 `fallback-estimate`）。
- 编码与部署约定见 [AGENTS.md](AGENTS.md)。
- 理论依据与测试断言：[docs/theory-notes.md](docs/theory-notes.md)（T1–T10 与单元测试一一对应）。

## 声明

- 本项目为独立的非官方研究项目，与 Eagle Dynamics SA 及任何游戏/模组厂商无关联，亦未获其认可或赞助。"DCS World" 及相关产品、机型名称的商标归各自权利人所有，此处仅为指示性使用。
- 本仓库不收录、不分发任何商业游戏或第三方模组的可执行文件、媒体资源或脚本文件；文档中的接口说明、版本指纹与参数表属于为互操作研究记录的事实性信息。
- 本项目仅面向单机、离线环境的原理研究与开发，请勿在多人服务器、竞技或任何带完整性校验的环境中使用。
- 第三方开源组件的归属见 [NOTICE](NOTICE)。

## 许可证

MIT（见 [LICENSE](LICENSE)）；贡献需附 DCO `Signed-off-by`（见 [CONTRIBUTING.md](CONTRIBUTING.md)）。

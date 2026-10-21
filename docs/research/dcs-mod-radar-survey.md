# DCS 官方/第三方模组雷达实现调研（代码可见性 / 架构 / 成像管线）

- 状态：external-reference（2026-10-18 复核）

**日期**：2026-10-15（六路并行调研独立完成，同日归档）。
**背景**：本项目 SAR 成像做到"效果与速度都需要参照系"的阶段，用户提出：官方模组或第三方模组的雷达代码能不能看到？他们是如何制作雷达的？尤其是 RAZBAM F-15E——其雷达被公认为 DCS 中最先进。本调研回答三个问题：(1) 各家雷达代码的可见性边界在哪；(2) 他们做雷达的架构与参数范式是什么；(3) 哪些结论可直接指导我们的 SAR/MAP/DBS/GMTI 开发。
**方法**：六份调研笔记按主题分章归档。归档只做机械处理：去掉调度包装与代理间交接话，合并个别重复句；正文、来源链接与证据标注一律保留。六份笔记独立完成，彼此重复与结论差异不合并、不改写。
**取证基准**：本机 DCS 安装目录 `<DCS>`（DCS 2.9.30.28738，Steam 稳定版，全程只读，未做任何写入）。下文相对路径均以该目录为根。

## 六份笔记的主题分工

| 章 | 主题 | 回答的问题 |
|---|---|---|
| 1 | F-15E 官方模块本地解剖 | RAZBAM 的 Lua/DLL 边界、ARF 框架、SAR 是否实装、雷达视频如何上屏 |
| 2 | FC3 战机雷达 Lua 调查 | FC3 有没有可读雷达代码、Export.lua 暴露什么、JF-17 参数表范式、引擎预设表 |
| 3 | 其余已装模块雷达接口盘点 | 11 个模块各自有没有雷达、模式指令、逻辑所在 DLL——附带发现引擎可读成像管线 |
| 4 | RAZBAM F-15E AN/APG-70 公开资料 | 手册写明的模式规格、2024–2026 停摆时间线、真实 APG-70/82 模式对照 |
| 5 | 开源/第三方模组的 Lua 雷达实现 | 社区三条路线、A-4E-C 完整先例、F-22A 寄生路线 |
| 6 | 引擎给模组雷达的底层能力与渲染路径 | render target 机制、Export 数据边界、任务脚本层能力 |

## 标注约定

- **确认事实**：本地文件行号 / DLL 二进制字符串 / 官方文档或一手声明直接可查。
- **推测**：有依据但未证实的推断，落地前需实测。
- **传闻**：社区转述、请愿、第三方评价，仅供背景。

## 总结论

1. **任何模组的雷达算法都看不到**：探测/成像/模式状态机全在编译后的 C++ DLL（F-15E 在 `F15E_CPT.dll`+`ARF.dll`，F-16C/FA-18C 连自有 DLL 都没有，设备由引擎本体提供）。Lua 层统一只做四件事：设备注册、指令 ID、参数表、显示符号。
2. **但引擎自带的 AG 雷达成像器是完整可读源码**（本次最值钱的发现）：`Bazar/shaders/enlight/radar.fx`（477 行 HLSL，rbm/dbs/rmap/tpm/ta 五模式管线）+ `radarFunc.hlsl`（物理散射模型：7 类地物 σ0 表、1/R⁴、Rayleigh 斑点、世界坐标哈希稳定噪点、角反射器）+ `Config/Effects/radar.lua`（全部机型预设：EXP/DBS1/DBS2 = resolution 19/67/120，ω=1.13446 rad/s）。ED 自家 F-16C/F-18C/AH-64D 的雷达图就出自这里。**F-15E 不在预设表内**——RAZBAM 绕开引擎渲染器自研了整套成像。
3. **F-15E 的 SAR 确凿实装**：RAZBAM 自研 `ARF.dll`（Advanced Radar Framework），`AbstractRadar` 暴露 `setModeSAR_StartPatch / setModeSAR_Continue / updateSAR_Patch / lastSARResult`，`SplatImager::accumulateSAR_Patch` 负责贴片累积，多线程（`RADAR_MAX_CORES` 1–16，默认 4）。术语不叫 SAR/DBS，叫 **HRM1/HRM2**（高分辨地图，分 PPI 扇扫与 Patch 贴片两型）。AG 模式全集 = RBM / GMT / HRM / PVU / AGR，行为级规格全部写在本地 143 MB 官方手册里（480×480 栅格、8.5 ft 最好分辨率、±8° 盲区、成图 2–12 s、多视 ML1/ML2、处理倒计时、auto-freeze）。
4. **FC3 六机没有任何雷达 Lua**（F-15C/Su-27/Su-33/MiG-29/A-10A/Su-25A），唯一可读接口是 `Scripts/Export.lua` 的 `LoGet*` 数据契约；`CoreMods/*/Entry/Sensors.lua` 的 `declare_sensor` 库含官方 A/G 三档距离声明：**RBM / GMTI / HRM**——与我们 MAP / GMTI / SAR 分层一一对应。
5. **社区模组只有三条路线**：① 引擎 `avSimpleRadar`（天花板 RWS+STT，官方文档明说无 TWS，检测黑箱）；② 完全自研——只有 GPL 开源的 **Community A-4E-C** 做到底（地形射线求交 + 材质反射率 + 脉宽涂抹 + 余辉 + 2500 blob 图元上屏，Lua/C++ 两版并存）；③ 寄生官方雷达（Grinnelli F-22A 全仓库没有一行雷达代码，直接声明用 F-15C 的雷达预设）。
6. **雷达视频上屏有一条统一路径**：Lua 声明 `ceTexPoly` + 运行时材质，像素由 C++ 写入；ED/RAZBAM 同构。导出画面的唯一官方通道是 `LoSetSharedTexture` 共享内存（BMP）。
7. **对本项目最硬的结论**：A/G 成像的数据链（地形 + 散射 + 信号处理）DCS 一概不给模组——我们的"Export + 任务桥接 + 外部成像服务"架构就是唯一可行路线，且方向与官方分层（RBM→DBS→SAR patch、GMTI 叠加）一致。`radar.fx`/`radarFunc.hlsl`/`Config/Effects/radar.lua` 三件套是我们 DBS 中间档与散射模型可直接对标的可读参考实现。

---

## 1. F-15E 官方模块本地解剖

### 1.1 结论

1. 可读 Lua 只承担"壳"：设备注册、指令 ID、MPD 页面几何、符号摆放（`Mods/aircraft/F-15E/Cockpit/` 共 181 个 `.lua`）；雷达本体的仿真、成像、模式状态机、目标数据全部在 `bin/F15E_CPT.dll` + `bin/ARF.dll`，Lua 只通过约 100 个命名控制器（`AA_RDR_*` / `AG_RDR_*`）向 C++ 要数据。
2. RAZBAM 自研雷达框架 **ARF**（Advanced Radar Framework），`entry.lua:14-17` 声明 `F15E_CPT`、`F15E_FM`、`ARF` 三个 DLL。从 ARF.dll 导出/修饰符号还原的类型清单：`AbstractRadar`、`AbstractScanPattern`/`HorizontalScanPattern`/`VerticalScanPattern`/`WorldFixedPattern`、`AntennaContext`、`IFF`、`LineImager`、`SplatImager`、`PersistenceImager`、`RadarAltimeter`、`TFRProcessor`、`MultiCrew`、`Switches`、`VThreadPool`。
3. AG 模式里有确凿的 SAR/DBS 实现：`AbstractRadar` 暴露 `setModeSAR_StartPatch` / `setModeSAR_Continue` / `setRawSARSharpening` / `lastSARResult` / `updateSAR_Patch`；`SplatImager` 暴露 `accumulateSAR_Patch` / `accumulateRaw_PPI` / `setProjectionPPI` / `updateTextures` / `assignToMaterial`。选项 `RADAR_SAR_SCINTILLATION = 'Experimental SAR scintillation'`（`Options/optionsData.lua:18`，默认开启，`Options/optionsDb.lua:37`）。
4. 雷达多线程：选项 `RADAR_MAX_CORES = 'Radar threads'` 默认 4、可调 1–16（`Options/optionsDb.lua:36`），框架内有 `VThreadPool`。
5. 雷达图像不是 Lua 画的符号：AG 页把三张运行时纹理贴在 MFD 上（`MFD_radar_video_RBM` / `_HRM_PPI` / `_HRM_PATCH`），由 DLL 的 imager 生成后 `assignToMaterial` 写进材质；Lua 只画光标、标尺、航迹符号、PB 标签。
6. `Cockpit/Radar/RP5_*` 是死代码（RP-5「Izumrud」，MiG-19P 雷达模板残留），全模块无任何引用——只有配置表和矢量图元，不是状态机也不是可用脚手架。
7. 没有 GMTT 的任何痕迹：有 GMTI（`ModeRadar_GMT` + 100 个 GMT 航迹符号），`GMTT`/`GroundTrack`/`track_while_scan` 在两份 DLL 中 0 命中。Lua 层也没有 "DBS"/"SAR" 字样——RAZBAM 用 F-15E 术语 **HRM1/HRM2**。

### 1.2 Lua / DLL 边界

可读 Lua 侧（确认事实）：

| 内容 | 位置 | 说明 |
|---|---|---|
| 设备 ID | `Cockpit/devices.lua:18-20` | `RDRCTRL_AA`=1, `RDRCTRL_AG`=2, `AN_APG70`=3 |
| 设备注册 | `Cockpit/device_init.lua:12-28` | 三个 C++ 类：`AN_APG70::RadarDevice`、`RadarControlAA`、`RadarControlAG`，互注入 `ctrl_device_aa/ag`、`an_apg70`、`MUX`（数据总线 `DMUX`） |
| 总线拓扑 | `device_init.lua:174-176` | 三个雷达设备挂 `F15E_BlackBox::avMUX`；`PACS`、`AAWCTRL`、`GUNCTRL`、`AUTOSTART` 也引用 `AN_APG70` |
| 指令 ID | `command_defs.lua:1046-1076`（`snsrctrl_commands`）、`:923` | 雷达电源旋钮、JTIDS、CC Reset、NCTR |
| HUD 雷达符号 | `Cockpit/HUD/AA/AA_Base.lua`、`AA_Page_ACQ.lua` | 全矢量符号，控制器如 `hud_radar_pdt`、`hud_rdr_super_search` |
| MFD AA 页 | `Cockpit/MFDG/RDR_AA/AA_MAIN.lua`（278 行） | RWS/TWS/STT 航迹、IFF、AoJ、PDT、射程提示、天线扫描标尺 |
| MFD AG 页 | `Cockpit/MFDG/RDR_AG/AG_MAIN.lua`（241 行） | 三路视频贴图、GMT 航迹×100、序列点×40、标记点×5、游标、PVU 读数 |
| 模式位枚举 | `Cockpit/MFDG/MFDG_definitions.lua:320-358` | 见 1.3 |
| 视频纹理声明 | `Cockpit/materials.lua:67-69` | `{nil, WHITE}`——无文件源，运行时填充 |
| NCTR 机型表 | `Cockpit/Scripts/NCTR.lua:1-110` | 纯 Lua 表：机型 → {代号, ?, 方位角} |

DLL 侧（字符串取证，确认事实）：

- `F15E_CPT.dll`（10.7 MB）：`RadarDevice`/`RadarControlAA`/`RadarControlAG`/`AbstractRadar` 类名痕迹；约 100 个 `AA_RDR_*`/`AG_RDR_*` 控制器字面名（如 `AG_RDR_GMT_Contact`、`AA_RDR_STT_Pos`、`AG_RDR_PSL`、`AG_RDR_EXPAND`、`AG_RDR_ANT_Elev`）；HUD 控制器族；开发调试符号 `radar_development_enabled`、`radar_dev_center`、`radar_initialize`；`setVideoToMaterial`、`updateVideoMaterials`；`MFD_PB01..17_Action`。
- `ARF.dll`（10.98 MB）：82 个 `AbstractRadar` 方法，包括 `setModeSTBY/SCAN/STT/TWS/RAW/RNG`、`setModeSAR_StartPatch/Continue`、`setRawSARSharpening/RawMTI/RawMonopulseSharpening`、`lastSARResult/lastScanResult/lastTrackResult/lastRawResult/lastIFFResult`、`createSplatImager`、`enableHighQualityClutter`、`enableNCTR/addNCTRSignature`、`getGroundLockPoint/Level/Range`、`setClipRange`、`setJamSensitivityAdjust`、`setInterferenceChannel`、`enableFullAsynchronous`、`sync_read_antenna`、`isSyncMaster/isSyncSlave`。
- 量化佐证：`AA_MAIN.lua`+`AG_MAIN.lua` 出现过的 95 个控制器名对 `F15E_CPT.dll` 逐字匹配，88 个命中。

**边界判定（高置信推测）**：可读 Lua 是"显示层+输入层+参数表"，DLL 是"传感层"——扫描图案/天线万向节/干扰/杂波/SAR 成像/多机组同步都在 C++。注意：DLL 里几乎不出现 `clutter`/`RCS`/`doppler`/`sidelobe`/`SNR` 字样，"射线投射+杂波模型"是从 API 名与选项名推出的**推测**，实现细节无法从字符串还原。

### 1.3 雷达指令与 AA/AG 模式枚举

物理可点击件仅 6 个（`clickabledata.lua:281-289, 311`）：雷达电源旋钮（OFF/STBY/ON/EMERG）、NCTR AUTO EID、JTIDS 旋钮（5 档）、CC Reset、地形跟随雷达开关（TFR 是独立设备）、雷达高度表开关。**`RDRCTRL_AG` 没有任何可点击件**——AG 模式切换走 WSO 的 MPD 按键 + HOTAS。HOTAS 指令族（`command_defs.lua:649-770`）：`FC_RDR_ANT_UP/DOWN`、`FC_ANT_AXIS`、`FC_STICK_AACQ_*`（自动截获）、`FC_TDC_*`、`FC_WSS*`（武器选择/雷达模式轮换）等，后座有对应 `RC_LHC_*`/`RC_RHC_*` 全系列。另有隐藏调试绑定（`Input/F-15E/keyboard/default.lua:731-734`）：`Radar debug graph toggle`、`Radar seeker head toggle/OFF`、`Radar Development Display toggle`。

模式位掩码（确认事实，`MFDG_definitions.lua:320-358`）：

```
ModeRadar_OFF / WUP / EMRG / STT / AUTO / GUNS / TWS / AGR /
              HRM2 / HRM1 / GMT / PVU / RBM / MRS / SORT / RWS
ModesRadar_AG = HRM2 + HRM1 + GMT + PVU + RBM
ModesRadar_AA = STT + AUTO + GUNS + TWS + MRS + SORT + RWS
```

AG 页另有一套（两套枚举混用，属页面层演化残留）：`ModeAG_RBM / GMT / HRM_PPI / HRM_PATCH / PVU / AGR / SET`。

模式→真机术语映射（**高置信推测**，术语对应关系非 RAZBAM 明文）：

| 模式 | 含义 | 对应真机能力 |
|---|---|---|
| `RBM` | Real Beam Map | 实波束地面地图（非相干，分辨率≈波束宽度）——对应我们的实波束 MAP 底图 |
| `HRM1`/`HRM2` | High-Resolution Map 两档 | DBS/多普勒波束锐化（RAZBAM 内部即称 SAR） |
| `ModeAG_HRM_PPI` | 高分辨地图 PPI 扇扫显示 | 扇扫 DBS |
| `ModeAG_HRM_PATCH` | 高分辨地图贴片显示 | SAR Patch，与 `setModeSAR_StartPatch`/`updateSAR_Patch` 一一对应 |
| `GMT` | Ground Moving Target Indication | GMTI，最多 100 航迹符号（`AG_MAIN.lua:155-158`） |
| `PVU` | Precision Velocity Update | 用地面回波更新惯导速度 |
| `AGR` | Air-to-Ground Ranging | 空地测距（AA 侧也有 `ModeRadar_AGR`） |

### 1.4 RP5_* 死代码的判据

`Radar/Device/RP5_Izumrud_Init.lua`（5 行，仅 3 个全局量）、`RP5_Search.lua`（26 行，±60°、7° 波束、12 km、`ground_clutter={sea/land/artificial=0.5}`、`rays_density=0.15`）、`RP5_Tracking.lua`（25 行）、`Radar/Indicator/RP5_*`（纯矢量图元）。判据：① `perfomance`（原文拼写）是 ED 旧式雷达配置键名，属"配置由引擎读、状态机在引擎内"的老架构；② Device 文件无任何函数与 dofile，只有表赋值；③ `RP5_glass.lua` 顶点/面索引整段注释又原样复制；④ 全模块 grep `RP5|Izumrud` 在 `Cockpit/Radar/` 之外 0 命中，`device_init.lua` 不 dofile 也不注册它。归属（**推测**）：RP-5 是 MiG-17PF/MiG-19P 雷达，RAZBAM 正是 MiG-19P 开发者，`RP5_init.lua:42` 还残留 `ASP5_ind_material`。

### 1.5 雷达视频如何上屏

图像路径（确认事实）：`AG_MAIN.lua:110-122` 的 `create_video_page` 生成 `ceTexPoly` 贴图四边形，材质即三张运行时纹理（`materials.lua:67-69` 声明为 `{nil, WHITE}`，无文件源）。填充者是 ARF.dll 的 imager：`accumulateSAR_Patch`/`accumulateRaw_PPI`/`accumulatePix` → `updateTextures()` → `assignToMaterial(IndicationBaseMaterial*)`。对照：TSD 地图、TGP 视频走引擎 render target（`GetRenderTarget()`），**雷达视频没有用 render target，用的是模块自绘材质**。`AG_MAIN.lua:85-89` 注释明说成像纵横比由 DLL 端负责，`:119` 用 `push_cliprect` 裁底边。三个 imager 分工：`LineImager`（PPI/RHI/B-Scope/E-Scope 四投影、斜距校正、方位偏移）管原始波束条带累积；`SplatImager`（`accumulateSAR_Patch`/`showChunk`/`setPages`）管 SAR 贴片与 PPI 绘制；`PersistenceImager`（`paint`/`setParametricAmplifier`）管余辉。三者均可 `net_read/net_write/request_sync`（多机组同步）。

符号路径（确认事实）：所有 `create_fromsvg`/`create_text`/`create_contact` 是标准 Lua 图元，数值来自 DLL 命名控制器（如 100 个 `AG_RDR_GMT_Contact`）。

### 1.6 对本项目的借鉴

1. **"位图图像 + 矢量符号"分层是官方级做法，与我们架构同构**。成像输出与符号/光标/标尺彻底解耦，并固定成像纵横比与裁剪矩形。
2. **RGBA 材质可当投递通道**：`textures[name]={nil, material}` + `ceTexPoly` 无需 render target、无需改 DCS 文件，适合"外部成像服务→座舱纹理"的部署形态，值得实测。
3. **模式分层可直接照抄**：RBM→HRM1/HRM2（DBS 两档）→HRM_PPI（扇扫）/HRM_PATCH（贴片，`StartPatch/Continue` 语义：进入贴片→持续累积→地面格网锚定）→GMT+PVU。贴片在真机上是与扇扫并列的独立模式，不是同一张图换个裁剪。
4. **"多线程+可配置质量"工程路线**：`RADAR_MAX_CORES` + `VThreadPool` + `enableHighQualityClutter` + scintillation 选项——真实产品的成像质量靠"可退化的物理细节+线程预算"兑付。我们的成像服务也应把射线精度与 CPU 预算暴露成可调项并给保守默认档。
5. **多机组同步一开始就按"状态/流/事件"设计**（`arf_mc_add_state/event_queue/custom_sync`）。
6. 不要照抄其页面框架的完整度——`ModeRadar_*` 与 `ModeAG_*` 两套掩码混用、8 个悬空控制器名是长期演化残留；我们自己的页面应用单一模式枚举+显式命名空间。

---

## 2. FC3 战机雷达 Lua 调查

### 2.1 结论

1. **FC3 六机（F-15C/Su-27/Su-33/MiG-29/A-10A/Su-25A）没有任何雷达 Lua**：`Cockpit/` 只有膝板/Shape/Textures，无 `Cockpit/Scripts`。雷达编译进 `bin/F15.dll`+`F15CCWS.dll` 等（`entry.lua` 的 `binaries` 表为证），二进制字符串已剥离（`Su27.dll` 11183 条可读字符串中含 Radar/scan/PRF 的为 0）。
2. 不止 FC3——全 DCS 统一架构是 `device_init.lua` 里 `creators[device_id] = {C++ 类名, Lua 参数脚本路径 或 nil, 参数}`。F-15E 注册第二项为 `nil`（无 Lua 实现）；F-16C 是 `F16::avRadar_APG68_F16` + 20 行几何常量脚本；FA-18C 雷达 Lua 仅 5–26 行，重头在符号页（约 1040 行）；JF-17 是唯一有实质内容的雷达参数 Lua（278 行）。
3. 真正可读的三类雷达信息：`Scripts/Export.lua` 的 `LoGet*` 家族（FC3 雷达唯一数据契约）；`CoreMods/*/Entry/Sensors.lua` 的 `declare_sensor` 声明库（含 **RBM/GMTI/HRM 三档 A/G 距离 + 参考 RCS**）；`Config/Effects/radar.lua` 引擎成像预设（`rbm/dbs/rmap/tpm/ta` + `omega/resolution/quantization/blurAngle`）。

### 2.2 Export.lua：FC3 雷达的运行时数据契约（确认事实）

| 函数 | 内容 | 行号 |
|---|---|---|
| `LoGetSightingSystemInfo()` | `Manufacturer`、`LaunchAuthorized`、`ScanZone{position{azimuth,elevation,distance_manual,exceeding_manual}, coverage_H{min,max}, size{azimuth,elevation}}`、`scale`、`TDC{x,y}`、`radar_on`、`PRF{current,selection}`（"MED"/"HI"/"ILV"） | `Scripts/Export.lua:702-750` |
| `LoGetTargetInformation()` | 接触表：`ID/type/country/position/velocity/distance/convergence_velocity/mach/delta_psi/fim/fin/flags/reflection`（**RCS m²**）`/course/isjamming/start_of_lock/forces/updates_number/jammer_burned` | `:663-701` |
| `flags` 位 | `whTargetRadarView=0x0002`（BVR 扫）/`whTargetRadarLock=0x0008`（STT）/**`whTargetRadarTrack=0x0020`（TWS）**/`whTargetAutoLockOn=0x0400`/`whTargetLockOnJammer=0x0800`（HOJ）等 | `:682-691` |
| `LoGetLockedTargetInformation()` | 锁定目标表，同上结构 | `:664` |
| `LoGetMCPState()` | 含 `RadarFailure`、`EOSFailure`、`RWSFailure`、`ECMFailure` | `:601-605` |

**易踩的坑**：`LoGetTWSInfo()` 的 TWS = Threat Warning System（RWR 告警源表，`SignalType="scan"/"lock"/"track_while_scan"/"missile_radio_guided"`），不是雷达 TWS 航迹（`:751-765`）。雷达 TWS 要用 `whTargetRadarTrack` 位。

引擎级雷达命令号（`:1109-1152, 1217`）：`226-229` 扫描区四向、`230` 停止、`231-235` 天线四向/停止、`262/263` 扫描区缩放、`271` 简易雷达、`272-279` 自动锁定、`285` RWS/TWS 切换、`394` 换 PRF、`286` RWR 模式。

### 2.3 手册中的可读雷达参数（确认事实，可直接采信）

- **F-15C**：距离档 10/20/40/80/160 NM；方位扫描区 ±60°/±30°；每条扫描角覆盖 2.5°；仰角 ±60°；PRF HI/MED/交织；AACQ 三种近距自动截获最大锁定 10 NM。
- **Su-27**：扫描图形方位三档离散位置；仰角两种调法（直接平滑倾斜 / "距离-角"法）；PRF HI/MED/ILV，**ILV 交替 HPRF/MPRF，代价是最大距离 −25%**；RCS→HUD 点数分档（≤2 m² 一点、2–30 两点、30–60 三点、≥60 四点）；噪声干扰下无法测距、可 AOJ 锁（距离手装，默认 10 km）配合 HOJ。

### 2.4 JF-17 的 278 行：参数表范式最佳样张（确认事实）

`Mods/aircraft/JF-17/Cockpit/Scripts/Sensor/avPDRadarKLJ7.lua`（设备类 `DEKA_Device::JF_17::avPDRadarKLJ7`，`device_init.lua:41`）：

- `:10` `dtime = 1/32`（设备节拍）；`:12-13` 过热/冷却；`:15` 默认量程 40 km。
- `:18-33` `performance = { scan_speed = math.rad(60), beam_width = math.rad(3), track_azimuth/elevation_limits, roll/pitch_compensation_limits, distance_limits = {10, 512000}, ground_clutter = {sea/land/artificial, max_distance=10000, rays_density=0.5} }`。
- `:35-47` `INCT.RWS = { az_limits, el_limits, bar_selection={1,2,4}, az_selection={10°,30°,60°}, prf_selection={0,1,2}, contact_history_selection={1,2,4}, range_selection={10/40/80/160 km} }` ← **"扫描行数 × 方位宽 × PRF × 航迹历史 × 距离档"的官方参数化表达**。
- `:49-56` `AG = { resolution, focus_factor=-0.05, factor_exp=4.0, factor_dbs1=8.0, factor_dbs2=32.0, ag_gain=8.0 }` ← 对地模式分辨率档位。
- `:59-98` 18 类雷达故障枚举 + 按损伤单元/完整度阈值的故障表（至 `:278`）。

配套模式文件：`radar_mode_map.lua`（`mode="rbm"`, blurAngle=2）、`radar_mode_dbs1.lua`（`mode="dbs"`, blurAngle=10, omega=1.13446, resolution=50, quantization=20, blankAngle=0）、`radar_mode_exp.lua`（resolution=20, quantization=15）——全安装仅有的两处可读"雷达成像参数源码"之一（另一处是引擎预设表）。

### 2.5 引擎传感器声明库（确认事实）

`CoreMods/aircraft/*/Entry/Sensors.lua` 的 `declare_sensor(...)`，范式（AJS37 `:28-74`）：

```lua
PS37A = {
  category = SENSOR_RADAR, type = RADAR_MULTIROLE,
  scan_volume = { azimuth = {-60,60}, elevation = {-60,60} },
  max_measuring_distance = 120000, scan_period = 5.0,
  air_search = { centered_scan_volume = {30,30},
    detection_distance = { [HEMISPHERE_UPPER] = {[HEAD_ON]=30000,[TAIL_ON]=30000}, ... },
    lock_on_distance_coeff = 0.85,
    velocity_limits = { radial_velocity_min, relative_radial_velocity_min } },
  surface_search = { vehicles_detection = true, RCS = 100,
    RBM_detection_distance = 120000, GMTI_detection_distance = 120000, HRM_detection_distance = 120000 } }
```

**`RBM/GMTI/HRM` 正是 DCS 引擎官方的对地雷达三档**（实波束成像/动目标指示/高分辨成像），以参考 RCS 给出距离，不给波形细节——引擎没有分辨率、驻留、相干积累、SNR 的任何字段。同类可读库：`CoreMods/tech/*/Database/db_sensors.lua`、`CoreMods/aircraft/{A-6E,F-4E}/Entry/Sensors.lua` 等。J-11A 例（`ChinaAssetPack/Entries/Aircrafts/J-11A.lua:215`）：`RADAR='N-001'`、`radar_can_see_ground=true`、`detection_range_max=250`、`RCS=5.5`；`N-001` 本体定义不在 Lua 里。

脚本层雷达对象接口：`Unit.getSensors()`/`Unit.hasSensors(...)` → `Unit.Radar`（`detectionDistanceRBM/HRM/Air{upperHemisphere{headOn,tailOn},...}`，RCS=1 m² 归一化）；`Unit.getRadar()` → (开机?, 当前感兴趣对象)；`Controller:getDetectedTargets(detection)` 可按 radar/IRST/RWR 等过滤；`LoIsSensorExportAllowed()` 导出权限位。

### 2.6 待纠正事项

**`LoGetF15_TWS_Contacts` 在当前安装的 `Scripts/Export.lua` 中不存在**（全盘 grep 无结果），仅见于社区老脚本与老 wiki——遗留接口，当前版本可用性未知，必须实测。本项目 `docs/plan`、`docs/status` 若提到它应改标"遗留接口，待实测"。

### 2.7 对本项目的借鉴

1. **把引擎参数词汇表当接口规范**：`config.lua` 每条参数旁并列 DCS 引擎字段名（`scan_volume`、`scan_period`、`detection_distance[半球][迎尾]`、`RBM/GMTI/HRM_detection_distance`、参考 `RCS`）与我们的取值来源，偏差永远可审计。
2. **A/G 三档 RBM/GMTI/HRM = 我们的 MAP/GMTI/SAR**，检测按参考 RCS 归一化再与引擎对照。
3. **成像显示参数抄官方量纲**：`omega`（1.13446 rad/s）、`resolution`、`quantization`、`blurAngle`、`blankAngle`、`verticalAngle`/`overlapAngle` 写进 `sar_bridge`/`sar_map` 输出头，可与引擎行为逐项并列。
4. **FC3 是最佳引擎对照组**：用 F-15C 采样四元组——`LoGetSightingSystemInfo`（扫描区/TDC/PRF/radar_on）+ `LoGetTargetInformation` 每目标（distance、convergence_velocity、reflection、updates_number、flags）。`updates_number` 是引擎航迹更新计数，正是我们 AESA 驻留/调度模型最缺的实机参照。
5. **节拍约定**：`device_timer_dt=0.02`（Combined Arms ground_radar）、`dtime=1/32`（JF-17）、`scan_period`（秒级）——把"扫描周期/回访率"作为 config 一级参数，独立于成像帧率与显示刷新；扫描/跟踪/失锁状态机与显示管线彻底解耦。

---

## 3. 其余已装模块雷达接口盘点

### 3.1 结论

1. 各模块雷达的探测/跟踪逻辑全在自有 C++ DLL（`F16C.dll`、`FA18C.dll`、`JF-17_ASM.dll`、`AH64D.dll`、`C130J.dll`、`F-4E-Avionics.dll`），且字面量加密，看不到算法源码。
2. 但有三条真正可读的代码级通道：**引擎自带 AG 雷达成像管线**（`Bazar/shaders/enlight/radar.fx` 477 行 HLSL + `radarFunc.hlsl` 物理散射模型）；**预设参数表** `Config/Effects/radar.lua`（`bin/enlight.dll` 内错误串 `"AG Radar: preset %s not found"` 证明按名取用）；**引擎雷达设备基类符号**（`bin/CockpitBase.dll` 含 `cockpit::avSimpleRadar`、`cockpit::avA2GRadar`、`avRadarSource`、`avRadarAltimeterBase`）。
3. 显示/交互层大量可读 Lua：F-16C AG 雷达 MFD 页、FA-18C RDR 页面族（GMT/SEA/EXP1-3）、AH-64D FCR 页面族（ATM/GTM/RMAP/TPM）、JF-17 RDR 页 + 参数文件、F-4E DSCG 雷达示波器页、C-130J 导航雷达页。

### 3.2 盘点表（DCS 2.9.30.28738，Steam 稳定版）

`Mods\aircraft\` 略写为 `MA\`。

| 模块 | 雷达 | 可读 Lua 暴露的模式/指令摘要 | 逻辑所在 DLL | Doc\ 手册 |
|---|---|---|---|---|
| A-10C_2 | 无（仅雷达高度表+ALR-69 RWR） | 无 | `A10.dll`/`Cockpit_A10C_2.dll`（无雷达） | A-10C II Flight Manual |
| FA-18C | AN/APG-73（AA+AG 实装） | AA：`RWS/VS/TWS/TA/GACQ/BST/VACQ/WACQ/HACQ`；AG：`MAP/GMT/SEA/TA/AGR`+`EXP1/2/3`（`RDR_AA_SPECIAL.lua:8`、`RDR_AG.lua:178`、`RDR_AG_MAIN_PBs.lua:11-14`）；AG 图像走 `AddVideoSignalRender_MPD(1024,1024)`（`RDR_AG.lua:36`） | `FA18C.dll`，设备类 `F18::avRadar_APG73_F18`（`device_init.lua:529-531`） | Early Access Guide 多语 |
| F-16C | AN/APG-68 | AA：`ACM(30x20/10x60/BORE/SLEW)`、`CRM(RWS/ULS/VSR/TWS)`；**AG：`GM/GMT/SEA/BCN/AGR`，GM 下 NORM/EXP/DBS1/DBS2**（`MFD_FCR_Defs.lua:8-45`、`MFD_FCR_AG.lua:76-95`）；图像页用 `render_target_N` 材质，动目标走符号缓冲 `DYNAMIC_DATA.RADAR_AG_CONTACTS`（`MFD_FCR_AG_IMAGE.lua:13-26`） | `F16C.dll`，设备类 `F16::avRadar_APG68_F16`（`device_init.lua:409-412`） | Early Access Guide 多语 |
| JF-17 | KLJ-7 | AA：`rdr_aa_*` 控制器族（107 个 `rdr_*` 控制器）；**AG：RBM(MAP)/DBS1/DBS2/EXP+FRZ+AGR（无 SEA/GMTI）**；参数可读：见 2.4；四种模式参数文件 map(rbm)/exp(dbs,res 20,q 15)/dbs1(res 50,q 20)/dbs2(res 100,q 15) | `JF-17_ASM.dll` | Flight Manual CN + Quick Guide |
| F-4E | AN/APQ-120 | 旋钮即模式：`BST/Radar/Map/Air-Ground/Beacon/TV`；`Display=VI/B-Narrow/B-Wide/PPI-Wide/PPI-Narrow`；`Scan 1/2 Bar`；`Target Aspect`；`Track AOJ/Auto/Manual`；`Pulse Long/Auto/Short`；极化、手动 Vc（`Input/F-4E-WSO/keyboard/default.lua:218-243`）；DSCG 示波器页可读（`Cockpit/Scripts/DSCG/indicator/Radar_Indicator/radar_page.lua`） | `F-4E-Avionics.dll`（+`F-4E-Nextgen.dll`），设备类 `F4EAvionics::Radar`；**DLL 有明文符号**：`radar_panel::State{Aspect,Bars,Polar,Range,Stab,Trigger}`、`JesterComponent::SetRadarGetMlcRangeFunction` 等（Jester AI 用雷达内部量接口） | F-4E Manual 多语 |
| AH-64D | AN/APG-78 FCR | FCR 页面全部可读 Lua：**ATM/GTM/RMAP/TPM** + 菜单（ACQ/CLEARANCE/PROF/RFHO/STATUS/TGT/UTIL）；参数如 `FCR_RMAP_Video`、`FCR_RMAP_Scan_Zone`、`FCR_GTM_Root/WiperColor`（`Displays/MFD/indicator/Pages/MISSION/FCR/**`） | `AH64D.dll`，设备类 `AH64::avFCR_AH64`（`device_init.lua:639-641`） | Flight Manual EN 等 |
| C130J | 导航/气象雷达 | 模式按键齐全：`PSEL/PRCN/MAP/WX/SP/MGM/WS/BCN/OFS/FRZ/PEN/SCTR`+增益/亮度（`clickabledata.lua:521-540`）；AG 参数文件可读：`Systems/AG/nav_dbs_full|offset|zoom.lua`（dbs）、`nav_mgm_full|offset.lua`（rbm）；`Systems/radar.lua` 里是与 JF-17 **完全相同**的 `AG={...}` 模板 | `C130J.dll`，设备类 `herc::NavRadar`（基类 `cockpit::avSimpleRadar` 符号可见） | User Manual EN/RU/CN |
| C-101 | 无 | 仅街机雷达开关 `LockOn_Options.flight.easy_radar` | `ABaseC101.dll` 等（无雷达） | Flight Manual 多语 |
| L-39C | 无（RV-5 雷达高度表） | — | `L39C.dll`（无雷达） | Flight Manual 多语 |
| Su-25T | 无（Shkval/Mercury/ELINT；输入里的 `iCommandPlaneRadar*` 是目标指示器指令） | — | 无 bin 目录（FC3 级，逻辑在引擎侧） | Flight Manual 多语 |
| Uh-1H | 无（雷达高度表） | — | `UH1H.dll`/`CockpitUH1H.dll`（无雷达） | Flight Manual 多语 |

### 3.3 引擎级 AG 雷达成像管线（可读源码，本次最重要发现之一）

`Bazar/shaders/enlight/radar.fx`（447 行后可读）：模式枚举 `M_RBM=0, M_DBS=1, M_RMAP=3, M_TPM=4, M_TA=5`（2 号空缺，疑似历史模式）。管线：

- `PS_SOURCE`：垂直方向图加权 + **阴影贴图做地形遮挡 LOS** + `p·R³/V.y`"理想补偿"。
- `PS_BLUR_RADIAL`：RBM 升余弦实波束方位模糊；DBS `sin(x)/x` 多普勒加权。
- `PS_BLUR_RADIAL_DBS`：λ=0.03 m 多普勒锥角（含扫描速率项 `omega/teta`），核宽 ∝ 锥角×`resolution`；`blankAngle` 屏蔽速度矢量前向扇区。
- `PS_SCAN`：扫描线"画"进累积缓冲，亮度 ∝ `grad² × 方向图 × (0.5+(1−scanDir)·0.25)`，DBS 用 `VS_ROT` 旋转顶点。
- `PS_SCAN_RMAP`：极坐标扫描转换。
- `PS_FINAL`：`exp_saturate` 压缩、增益、可选量化、叠加扫描辉光（G 通道）。TPM/TA 是净空面/危险坡度分类着色。

`Bazar/shaders/enlight/radarFunc.hlsl`（物理散射模型）：地物 σ0 表 `uipo[]`（森林 −14/−12 dB、草原 −16/−23、雪 −23/−30、沙漠 −15/−15、混凝土/沥青 −40/−30、海 2 点 −40/−32、海 6 点 −35/−30）；`ρ₀·Ptx/R⁴·z`（Ptx=500、ρ₀=0.035）；Rayleigh 斑点 `z=sqrt(-2·epr²·ln(rnd))`，随机数来自**世界坐标哈希**（同一地点斑点逐帧稳定）；另有角反射器模型。

`Config/Effects/radar.lua` 预设表：`MAP`/`JF_17`/`GM_F16`/`GM_F16_RBM`（rbm，blurAngle 1.0~3.3）；`EXP1/2/3` 与 `EXP_F16`/`DBS1_F16`/`DBS2_F16`（dbs，resolution 19/67/120，quantization 8，omega 1.13446，blankAngle 5.0）；`AH64D_RMAP`（rmap，verticalAngle 6.25，overlapAngle 0.125——**条带重叠**）；`AH64D_TPM_FAR/NEAR`（tpm，elevationBias 4.8768，clearancePlane 30.48，deadSpace）；`F18_TA`（ta，clearancePlane 152.4）。`ω=1.13446 rad/s ≈ 65°/s` 在所有 dbs 预设中完全一致，是官方口径的天线方位扫描角速度参照。

`bin/enlight.dll` 明文：`radar`、`presets`、`AG Radar: preset %s not found`、`Config/Effects/radar.lua`、`enlight/radar.fx`、参数键 `verticalAngle/blurAngle/resolution/omega/blankAngle/quantization/viewport/color/overlapAngle/deadSpace/elevationBias/clearancePlane/mode`。

### 3.4 引擎雷达设备基类（`bin/CockpitBase.dll`，RTTI 明文，294 个 Radar 符号）

- `cockpit::avSimpleRadar`：`apply_stabilization`、`filter_acqusition`、`get_RCS_for_target`、`get_max_clutter_distance`、`get_pulse_repeat_frequency`、`check_possible_ECM_block_for_lock`、`scan_for_targets`、`next_scan_line/step`、`is_tracking`、`mail_lock`、`l_register_functions`（Lua 注册）。
- `cockpit::avA2GRadar`：`initialize`/`deinitialize`/`search`（空对地搜索基类）。
- `avRadarSource`（RWR 辐射源识别）、`avRadarAltimeterBase`、`avArcadeRadar`/`ccArcadeRadar`/`avArcadeTargetSelector`。

### 3.5 F-16C / JF-17 AG 模式对照

| | GM/NORM | EXP | DBS1 | DBS2 | GMT | SEA | 备注 |
|---|---|---|---|---|---|---|---|
| F-16C（Lua 标签） | GM | EXP | DBS1 | DBS2 | GMT | SEA | `MFD_FCR_AG.lua:91-95` |
| F-16C（引擎预设） | `GM_F16`(rbm,blur 1.0)/`GM_F16_RBM`(blur 3.3) | `EXP_F16`(dbs,res 19) | `DBS1_F16`(res 67) | `DBS2_F16`(res 120) | 无预设 | 无预设 | `Config/Effects/radar.lua:50-91` |
| JF-17 | `radar_mode_map`(rbm) | `radar_mode_exp`(dbs,res 20) | `dbs1`(res 50,blur 10) | `dbs2`(res 100,blur 10) | 无 | 无 | 自带参数文件，数值与引擎默认不同 |

### 3.6 对本项目的借鉴

1. **DBS 有可抄的参考实现**：`radar.fx` 的 `blurRadialDBS` = 径向 sinc 加权方位压缩，核宽 ∝ 多普勒锥角（λ=0.03 m + 平台速度水平分量）× `resolution`，`blankAngle` 屏蔽前向多普勒盲区（与我们扫掠必须避开前向多普勒零点同一物理），`omega` 让扫描速率进入多普勒项。显示端拟真基线：EXP≈19、DBS1≈67、DBS2≈120。
2. **RBM 拟真只需方向图卷积**：升余弦方向图（`max(0, sqrt(1-0.8x²))`）沿径向模糊 + `blurAngle`（3.3°=典型波束宽），MAP 底图/扫描条带可直接用这套权重出图。
3. **斑点与后向散射模型照抄即得"雷达质感"**：7 类地物 σ0 表、1/R⁴、Rayleigh 斑点、世界坐标哈希保证同一地点斑点稳定——正好解决我们 SAR 图像噪点逐帧跳动/跨图辐射不一致问题。
4. **GMTI 在 DCS 里是"纯符号"模式**：引擎不提供 GMT/SEA 成像预设，F-16C 动目标经 `DYNAMIC_DATA.RADAR_AG_CONTACTS` 符号缓冲绘制——我们的 GMTI 同样只需接触列表+符号层，成本更低、更贴近官方观感。
5. **三层解耦架构可对标**：C++ 设备（继承 `avSimpleRadar`/`avA2GRadar`）出参数与符号 → Lua 只做显示/交互 → 引擎 enlight 出图。我们的 Export+任务脚本+外部服务已近这一结构，值得把"参数/符号契约+更新率+命名前缀"正式文档化。
6. （附注）若要复用引擎成像管线，写 `Config/Effects/radar.lua` 属修改游戏已有文件——按 `AGENTS.md` 规则必须走可复现部署脚本 + 备份 + 清单 + 卸载。

---

## 4. RAZBAM F-15E AN/APG-70 公开资料调研

### 4.1 结论

1. 看不到雷达代码，任何模组都看不到（与第 1 章一致）。
2. **DCS F-15E 的 A/G 模式 = RBM / GMT(+IGMT) / HRM（即 SAR，分 PPI 与 Patch 两型）/ PVU / AGR**，全部写入本地官方手册 v1.7；实现程度是"座舱行为级+规格级"：扫描时间、盲区、分辨率分档、处理倒计时、多视、冻结/存储、误差源（INS 速度/位置误差决定画质）都建了模。
3. HRM 的"像 SAR"来自三件事：几何约束（±8° 盲区、斜视角不能太陡/太平、patch 与距离硬绑）、产品化档位表（0.67–80 NM DW ↔ 8.5–1014 ft 分辨率）、**图像直接取自 DCS 世界数据**（手册明说物体密度高的新地图效果最好，Caucasus 永远出不来同样效果）。**未发现任何开发者公开提到光线投射或地表反射率模型**（未证实）。
4. 2024–2026 无 SAR/HRM 新进展：2024-04 起 RAZBAM 停更；ED 年底签和解但拿不到源码，模块"as is"支撑到 2.9.x；2026-05-15 Prowler 提交"回归并完成未竟功能"提案，至 2026-08 仍在等 ED 回复（传闻级）。
5. 真实 APG-70 的 A/G 五模式为 RBM / GMT / HRM（SAR patch）/ BCN / AGR（另有 IGMT、PVU 功能）；APG-82(V)1（AESA）卖点是更高分辨率 SAR 与 SAR/GMTI **近同时交错**。DCS 模块做的是 2003 年 Suite 4E+（机械扫描），AESA 部分无参考，得我们自己造。

### 4.2 A/G 雷达模式清单与状态（以本地手册 v1.7 §11 为准）

手册 p.393 列五种功能：RBM、GMT、HRM、PVU、AGR；模式按钮在 RBM/GMT/HRM/PVU 间循环，AGR 自动介入。

| 模式 | 已实现内容（关键参数） | 手册页 |
|---|---|---|
| **RBM** | 低分辨测绘+气象探测；单 bar 方位扫，100° ≈ **1.2 s**；PPI 宽度 Full/Half/QTR=100°/50°/25°；距离 4.7/10/20/40/80/160 NM；FREEZE、DECLUTTER、增益 GC0–GC3；斜距坐标、ALT 行按 1 bar + 2.5° 波束估算；GMT 叠加（IGMT，≤40 NM 才可进） | p.403–408 |
| **GMT** | 检测上限 **32 NM**（扫描档最大 40 NM）；仰角 bar 1–4；波束宽 **4.6°**（4.7/10 NM）/**3.55°**（20/40 NM）；每帧最多 **100** 目标；符号三帧行为：首帧定位→次帧仍在但位置错→第三帧擦除（**显式建模"陈旧接触"**） | p.409–410 |
| **HRM（= SAR）** | 分辨率以英尺计，最好 **8.5 ft**；成图 2–12 s（PPI 7–10 s）；盲区 ±8°（共 16° Blank Window）；三条禁令：盲区内/接近万向架极限/patch 大于当前距离；PPI 与 Patch 两型；DW 0.67/1.3/3.3/4.7/10/20/40/80 NM；DW 过大的"大 X"无效提示；Auto Freeze（可成像面积 <75%）；**处理时间倒计时**；Stabilized/Progressive 两种 patch 稳定方式；**多视 ML1/ML2（ML2 相邻块 50% 重叠，耗时 ×1.5）**；FREEZE/STORE/RECALL(NEW/OLD)；PVU 未做时画质"严重退化"（手册有对比图） | p.411–420 |
| **PVU** | 天线固定指速度矢量某一角，测地面回波多普勒距离变化率；先粗多普勒估计大误差，两帧有效后精算，约 **10 s**；接受后显示冻结 **4 s**；INS 更新 3–6 分钟（建议带 90°–180° 转向与加减速）；**IPVU** 每 60 s 自动插空；LAND/SEA 两型（海上受洋流污染） | p.421–423 |
| **AGR** | 不可手动选，系统按需自动介入；AUTO 投弹最后 15 s 强制介入；TGP 激光不可用时替代测距；会打断其他雷达模式 | p.424 |
| 未实现 | RBM 的 UPDT 位置更新光标、CHANNEL/BAND 选择、HRM "显示图幅"按钮 | — |

**"480×480"是直接写在手册里的实现细节**（p.420）：显示地图由 480×480 个距离/方位格组成，分辨率 = 图幅/480，于是 0.67 NM→8.5 ft、1.3 NM→17 ft……160 NM→2030 ft（后者是对真实档位表的几何外推，真实公开表止于 80 NM/1014 ft，见 `sar-real-world-usage.md`）。

### 4.3 它是怎么做出来的：确认事实 vs 推测

确认事实（第一方文字）：

- ED 官方预告（2023-05-12）："The radar has been faithfully recreated using **new technologies for DCS**. A prime example of this is the **Synthetic Aperture Radar (SAR) mode**…"——发布前就以 SAR 为卖点。
- 首发功能表（RAZBAM CEO Ron Zambrano，2023-05-02）：A/A: RWS/STT/TWS/HOJ；**A/G: Radar Map, High Resolution Map, Ground Moving Target**；雷达与 TGP 联动；A/G 雷达支持双座同步。
- **画质依赖 DCS 地图数据密度**（手册 p.416 原文 NOTE）："best results can be achieved using newer maps (like Sinai or Marianas), where there is higher density of objects. Older ones, like Caucasus, will never produce the same results."
- 画质第一误差源是导航误差（手册 p.420 "Map cueing errors"）：位置/速度误差是低画质主因；无 EGI 必须先用 PVU。
- 几何门控（p.411/417）：盲区 ±8°；"雷达照到地面的角度不能太陡也不能太平"，远距要飞高些。

强推断（未见开发者直接表述）：

- HRM/PPI 与 Patch 的图像按 DCS 世界（地形+地图对象）合成，而非独立电磁散射模型——依据是"物体密度"NOTE + 480×480 量化 + 无任何射线/反射率公开描述。**流传的"地形光线投射/地表反射率模型"说无任何可靠出处，属未证实。**
- HRM 的"真实感"很大程度来自**行为外壳**：倒计时、无效大 X、盲区、auto-freeze、冻结/存储/召回、ML1/ML2、Stabilized/Progressive——手册逐条写明、可被玩家验证的约束。

A/A 雷达同样值得参考（手册 p.311–312 起）：帧存储以扫描帧计（6-bar 时目标回波可见 >10 s；单 bar ≈1.6 s）；GMTR 档位直接给 notch 速度数值（LO 45 / MED 63 / HI 87 / CHAF 95 kn）；INLV 模式每个 bar 交替 MPRF/HPRF 并逐 bar 显示当前 PRF；Supersearch 20°×20°、6-bar、≤10 NM。**"把时序和门限写成数字"是它口碑的来源。**

"DCS 最真实雷达"定性 = 第三方评价（传闻级，多条一致）：Skyward Flight Media 首发评测、Chuck's Guide 把 RBM/HRM/GMT/IGMT/PVU/AGR 全单列章节、RAZBAM 官方教程视频系列（RBM/GMT/HRM 三部）、2022-11 社区 SAR 模式测试帖。社区另有 "HRM Scintillation" 进阶技巧视频——机制未能从手册/官方源核实，列为未证实。

### 4.4 2024–2026 时间线

| 时间 | 事件 | 性质 |
|---|---|---|
| 2024-01、2024-06 | F-15E 雷达因"日期相关 bug"失效（改系统日期可复现） | 事实（官方论坛与媒体报道） |
| 2024-04 起 | RAZBAM 暂停全部模块支持与开发（纠纷公开化） | 事实 |
| 2024 年底 | ED 与 RAZBAM 签和解协议（含保密条款）；RAZBAM 要求停售其模块 | 事实（ED 官方声明） |
| 2025-07 | ED：无源代码、无合作，模块"as is"尽量维持到 2.9.x；NineLine："若不改变，2.9 之后模块将停止工作" | ED 人员表态 |
| 2025-07 | 同期 ED 给自家 F/A-18 加新地形雷达/TA 模式（2.9.18） | 事实 |
| 2026-01 | 请愿书称 Prowler"确认 Vulkan 版本将使 RAZBAM 模块全部失效" | 传闻/请愿 |
| 2026-05-15 → 2026-08 | Prowler 提交提案：愿回归支持现有产品、兼容未来版本、完成未完功能；仍在 ED 审阅 | 一手声明（Discord 原文转引） |

结论：2024-04 之后 F-15E 雷达（含 HRM/SAR）没有任何新功能进展；社区讨论重心是"模块会不会在 Vulkan 后消失"。注意用词：F-15E 没有 "HRB" 模式，只有 HRM（= SAR）。

### 4.5 真实 AN/APG-70 / APG-82 模式对照

| 机型/雷达 | A/G 模式 | 来源 |
|---|---|---|
| AN/APG-70（F-15E，机械扫） | 五种运行模式：**RBM、GMT、HRM、BCN、AGR**（F-15E 教材式工作手册）；另有 IGMT 与 PVU 功能；HRM 最小 patch 0.67 NM、8.5 ft | F-15E AGR 学生工作手册镜像、ED 论坛 2012 帖（含 RBM 95°/s、HRM 盲区 8°、patch 档位表） |
| APG-63/70 家族相关 | "Enhanced Real Beam GM（含 monopulse 锐化）"、"扩展图 4:1"、DBS；DBS 在离轴 ~10° 以下无优势 | Forecast International 档案、Air & Space Forces 1977 |
| AN/APG-82(V)1/(V)X（AESA） | 更高分辨率对地测绘；SAR 与 GMTI **近同时交错**；GaN 版增程 | TWZ 2021 访谈、Air & Space Forces 2025 |

对照要点：**DCS 模块 = APG-70 行为（无 AESA、无真 SAR 信号处理、无条带模式）**；真实 APG-70 也没有条带 SAR，只有 patch/PPI——真正的 Stripmap/Spotlight/GMTI 三件套要到 APG-82 与专用 SAR 吊舱（ASQ-236、Lynx 等）。

### 4.6 对本项目的借鉴

1. **把"规格与门控"做成产品语义**：分辨率↔图幅↔距离硬绑（480 格量化）、±8° 盲区、斜视角限制、patch 过大给"大 X"、可成像面积 <75% 触发 auto-freeze、成图倒计时。低成本落地样板：每张图输出等效栅格 + 该几何理论方位分辨率 + 不可成图原因。
2. **图像质量建模为"世界数据→图像"的映射**：给 DCS 对象按类型赋 RCS/反射率（车辆/建筑/跑道对比度）+ 遮挡与阴影——比纯高度图更像雷达。
3. **运动补偿/导航误差显式建模**：可注入 INS 速度/位置误差 + 配一个"PVU 式校准"操作，显著提升机理可信度（我们目前是完美运动补偿）。
4. **座舱式快照语义可复制**：Stabilized vs Progressive、RECALL NEW/OLD、STORE、FREEZE、ML1/ML2（50% 重叠、×1.5 耗时）、处理倒计时——工程上便宜的显示层特性。建议拆成"座舱快照视图"（冻结+两档精修）与"拼接侦察图"两条产品线。
5. **远离"可被冻结的依赖"**：F-15E 的教训是雷达逻辑不可注入且因商业纠纷随时可能冻结。我们的外部服务路线不受影响，但应补齐桥不可用时的降级路径、生成物不依赖 DCS 运行时许可；并记住 **SAR 与 GMTI 交错调度是 AESA 的核心卖点**（APG-82 官方措辞），调度器值得按"近同时交错"作为显式设计目标。

主要来源：`https://www.digitalcombatsimulator.com/en/news/2023-05-12/`、`https://stormbirds.blog/2023/05/02/new-early-access-details-released-for-f-15e-plus-liveries/`、`https://www.scribd.com/document/721146611/DCS-F-15E-Flight-Manual-En`、`https://www.skywardfm.com/post/review-dcsworld-f15e-strike-eagle-by-razbam-simulations`、`https://chucksguides.com/aircraft/dcs/f-15e/`、`https://stormbirds.blog/2024/06/14/dcs-f-15e-radar-inop-anti-virus-issues-and-m2000c-fixes/`、`https://forum.dcs.world/topic/341716-f15e-radar-not-working/`、`https://simulationdaily.com/news/razbam-vs-dcs-world-new-statement/`、`https://stormbirds.blog/2025/07/26/dcs-news-core-updates-razbam-situation-heatblur-update-and-another-sale/`、`https://www.change.org/p/eagle-dynamics-to-support-razbam-modules-indefinitely`、`https://combatace.com/forums/topic/101434-news-about-group-r/`、`https://stormbirds.blog/2025/07/16/dcs-f-a-18-is-getting-terrain-avoidance-mode-plus-msi-coming-too/`、`https://pdfcoffee.com/download/agr-2apg70intro-pdf-free.html`、`https://forum.dcs.world/topic/79647-ground-mapping-radar-sar/`、`https://www.forecastinternational.com/archive/disp_pdf.cfm?DACH_RECNO=944`、`https://www.twz.com/40098/we-talk-f-15exs-new-radar-with-the-woman-who-runs-the-program-behind-it`、`https://www.airandspaceforces.com/new-radar-for-f-15ex-more-range-without-demanding-more-power/`。

---

## 5. 开源/第三方模组的 Lua 雷达实现

### 5.1 结论

1. 社区模组做雷达只有三条真实路线：① 用引擎内建设备 `avSimpleRadar`（RWS+STT，引擎算检测，Lua 只画图）——VSN F-4B/C、A-6E、SK60 等一大批；② 自己写检测（Lua 地形射线 / C++ ExternalFM）——目前只有 **Community A-4E-C** 做到底；③ 寄生已有官方模块的雷达（F-22A 寄生 F-15C，J-10C 寄生 JF-17）。
2. **Grinnelli F-22A 没有一行雷达代码**：飞机配置只有 `Sensors = { RADAR = "AN/APG-63" }`（F-15C 雷达预设），全仓库无雷达设备注册。
3. VSN 做的是 F-4B/C（F-4E 是 Heatblur 官方模块）；VSN F-4B/C 玩家雷达是可复用 Lua 模板 **`avRadar`**，核心 = 引擎设备 `avSimpleRadar` + 参数驱动显示。
4. **真正能对标我们 SAR/MAP 的只有 A-4E-C**：地形射线投射算回波强度（Lua 走 `require('terrain')`，C++ 走 `worldgeneral.dll` 的 `globalLand` 地形指针），再用 2500 个 blob 图元把强度画到 MFD——完整的"实波束对地映射雷达"开源实现。
5. **TWS/航迹文件在开源社区是空白**：`avSimpleRadar` 官方文档明确 "Track While Scan (TWS) is not available"，其余模组也无人实现；检测概率（Pd）、多帧航迹关联同样无开源先例（本次搜索范围内）。

### 5.2 路线①：引擎 avSimpleRadar + Lua 指示器（主流做法）

代表仓库：`D4n2021/VSN_F4B_C_Standalone`、`Na1veNoob/DCS-A-6E-Intruder`、`BAAS-Dynamic/DCS-SK60-Mod`；模板原件 `ElTitoDG/My-beginner-repository`（`avRadar_example`）；官方文档 [avSimpleRadar — DCS Modding Documentation](https://modding.caffeinesimulations.com/Aircraft/Lua/Devices/avSimpleRadar/)。

架构（确认事实）：

- 设备注册：`creators[devices.RADAR_RAW] = {"avSimpleRadar", .../avRadar/Device/Radar_init.lua}`（A-6E `device_init.lua:21`；VSN `radarexample_device_init.lua:24-25`）。
- **检测在引擎里**：`avSimpleRadar` 做扫描、跟踪、IFF、杂波，接触点以读参数形式输出：`RADAR_CONTACT_XX_{ELEVATION,AZIMUTH,RANGE,TIME,FRIENDLY,VX,VY,VZ,RCS_COEFF,NCTR}`（一架飞机产生多个 contact，一个 contact = 一次回波）。STT 时输出 `RADAR_STT_{AZIMUTH,ELEVATION,RANGE,FRIENDLY}`。
- **Lua 侧只是"控制器+图元"**：`indication_page.lua` 为最多 900 个接触点各建四边形，接 `element_params`/`controllers` 由引擎推着动（`move_left_right_using_parameter`(方位)/`move_up_down_using_parameter`(距离)/`parameter_in_range`(航迹寿命 5 s 淡出)/`change_color_when_parameter_equal_to_number`(FRIENDLY 变绿)），见 VSN `avRadar/Indicator/indication_page.lua:110-144`。
- 更新循环：`make_default_activity(update_time_step)` + `update()`。VSN 用 1/60 s，A-6E 用 1/50 s。
- 扫描锥/距离门参数（`perfomance` 表）：`scan_volume_azimuth`（±60°）、`scan_volume_elevation`、`scan_beam`（单条波束高度；小于 volume 高度时自动多行扫描）、`tracking_azimuth/elevation`、`roll/pitch_compensation_limits`、`max_available_distance`（**只给"大 RCS 目标"的最大距离标量**，小 RCS 由引擎内部衰减）、`dead_zone`、`ground_clutter = {sea/land/artificial = {A,B,C}, rays_density, max_distance}`（杂波点 RCS = `A + B*random + C*random`）。`scan_speed`、`dead_zone`、`RADAR_BIT`、`ACQUSITION_ZONE_VOLUME_AZIMUTH` 等官方文档标注 "unknown/无效"。
- A-6E 的中文注释是很好的旁证（`Radar_init.lua`）："扫描区间为5deg，扫描周期为41/50 s"（≈0.82 s）、"`scan_speed` 无效参数"——作者是实测引擎扫描时序反推参数的。
- 注意：VSN 的 AI 侧传感器用 F-5E 预设（`Sensors = { RADAR = "AN/APQ-159", RWR = "Abstract RWR" }`）——"玩家雷达"和"AI 雷达模型"是两套东西。

天花板：RWS+STT，检测黑箱，拿不到逐目标 RCS/Pd。但其参数集合（扫描体积/波束/杂波系数/最小距离）就是 ED 官方雷达模型的数据维度，可作我们参数命名与量级的参照。

### 5.3 路线②：完全自研——Community A-4E-C（唯一完整先例）

仓库：<https://github.com/Community-A-4E/community-a4e-c>（GPL，含全部 Lua 与 C++）。

两套并行实现（确认事实）：

| 层 | 文件 | 说明 |
|---|---|---|
| 设备注册 | `A-4E-C/Cockpit/Scripts/device_init.lua:72` | `creators[devices.RADAR] = {"avLuaDevice", .../"RADAR/apg53a.lua"}`——自研设备，不走 avSimpleRadar |
| 主仿真(Lua) | `Cockpit/Scripts/RADAR/apg53a.lua`（55 KB） | 可由插件选项 `oldRadar` 切换启用 |
| 主仿真(C++) | `ExternalFM/FM/Radar.cpp`（26 KB）、`RadarScope.cpp`、`bin/Scooter.dll` | 新雷达，随 ExternalFM 编译 |
| 显示 API | `Cockpit/Scripts/Systems/radar_scope_api.lua` | `set_blob(idx,x,y,opacity)`；2500 个 `RADAR_BLOB_i_{UD,LR,OP}` 参数 |
| 指示器 | `Cockpit/Scripts/RADAR/Indicator/{init,base_page,indication_page}.lua` | 网格、1000 ft 剖面刻线、显示模式 |

Lua 雷达获取地形真值（`apg53a.lua`）：

- `local Terrain = require('terrain')`（座舱环境的 Lua 地形模块，`:7`）。
- `Terrain.isVisible(p0, p)` 做**二分法射线-地形求交**：`find_collision_range`（`:310-360`），迭代次数 ≈ log2(射线长度/精度)；水面可选穿透（`Terrain.GetSurfaceType(bx,bz)=="sea"`）。
- `find_visible_slope`（`:364-386`）用 `Terrain.GetHeight` 取 10 m 前后两点算坡度，坡度与俯仰之差作为回波强度权重。
- 扫描调度：`update_theta_search`（`:388`）±60° 摆动、每 entry 0.5°；仰角 7 个 rho 步长；`apg53a_scan_search`（`:449`）/`scan_plan`（`:489`）/`scan_profile`（`:531`）/`scan_a2g`（`:605`）分模式填充 `search[][]`（碰撞距离）与 `strength[][]`（强度）二维数组；`draw_*`（`:648/711/856`）转成 blob。
- 更新循环 `make_default_activity(0.05)` = 20 Hz，每帧只扫有限个方位段（`update()` 在 `:1358`）。

C++ 雷达（更新的一代）：

- 构造时 `GetModuleHandleA("worldgeneral.dll")` + `GetProcAddress("?globalLand@@3PEAVwTerrain@@EA")` 直接拿引擎地形对象指针（`Radar.cpp` 构造函数）。
- `scanOneRay()`（`:636`）：方向向量 → `getIntersection(ground,pos,dir)` → `getNormal`/`getType` → **`getReflection(dir, normal, TerrainType)` 材质相关反射率** → ×预热因子 → ×`2.0e-4/gain` → 按 `c_pulseLength = 1e-6 s`（脉宽→300 m 距离涂抹）把强度摊进 `m_scanIntensity[]` 距离单元；`m_scanAngle[]` 存俯仰角。
- 常量：`c_beamSigma = 0.037 rad`（≈2.1° 高斯波束）、`c_SNR = 1.5e-4`（**恒定缩放，没有 Pd/Swerling 建模**）、`c_samplesPerFrame = 100`（每帧预算）。
- `drawScan()`（`:701`）余辉衰减 + 距离单元间插值填补空洞，逐个 `addBlobOpacity(index, intensity, brilliance)`。
- `findShips()`（`:598`）对海面目标额外检测；`scanAG/scanAG2`（`:749/816`）A/G 扇扫。
- C++ 与 Lua 显示层接口是同一批参数句柄：`RadarScope.cpp:15-26` 用 `pfn_ed_cockpit_get_parameter_handle("RADAR_BLOB_%i_LR/UD/OP")`。

对本项目的直接价值：A-4E-C 是"实波束地形回波映射"的完整开源参考（几何求交 + 材质反射率 + 脉宽涂抹 + 余辉 + 每帧预算），与我们的 PFA 频域聚焦互补——其 `Terrain` 求交可直接当作我们 MAP/条带模式的几何真值与遮挡判定来源，把昂贵的聚焦留给外部服务。

### 5.4 路线③：寄生已有模块的雷达

- **Grinnelli F-22A**（<https://github.com/grinnellidesigns/f-22a>）：`F-22A.lua:215-217` `Sensors = { RADAR = "AN/APG-63" }`；`:111` `RCS = 0.0001`、`:113` `detection_range_max = 800`；`Cockpit/Scripts/devices.lua` 无雷达设备。README 明确要求装 F-15C/FC3——F-22 的雷达就是 F-15C 的雷达，模组只改 AI 侧 RCS/探测距离和显示皮肤。
- **whisky-actual/Community-J-10**（<https://github.com/whisky-actual/Community-J-10>）：放进 `Mods/aircraft/JF-17/` 槽位复用其雷达设备与 MFCD 页面；同时在 `CoreMods/.../J-10/Entries/Tech/sensors.lua` 覆写引擎传感器数据库（`["AESA_KJ2000"] = {...}`，含 `scan_volume`、`view_volume_max`、`magnifications`、`resolution`）。
- Su-57/F-35/J-20 类模组：FC3 基础改皮，与 F-22A 同路线。Anubis C-130J 无公开源码，实现细节未核实。
- 旁证：引擎雷达是数据驱动的，"AESA" 在 DCS 里就是 AI 传感器预设名（`Quaggles/dcs-lua-datamine` 的 `db/Sensors/Sensor/AESA_KJ2000.lua`），第三方可用 `CoreMods/*/Entries/Tech/sensors.lua` 增补/覆盖。

### 5.5 确认事实 vs 推测

| 项 | 状态 |
|---|---|
| F-22A 无自研雷达、用 F-15C 雷达 + APG-63 传感器预设 | 确认（仓库代码） |
| avSimpleRadar = RWS+STT、无 TWS、接触点以 `RADAR_CONTACT_*` 参数暴露 | 确认（官方 modding 文档） |
| VSN F-4B/C、A-6E、SK60 共用 `avRadar` 模板（最早见于 ED 论坛 2018 帖） | 确认（代码一致+论坛帖） |
| A-4E-C 地形射线投射 + 材质反射率 + blob 显示（Lua/C++ 两版） | 确认（源码） |
| 社区雷达没有 Pd/检测概率模型，SNR 只是常量缩放 | 确认（A-4E-C 源码无 Pd；其余无检测代码） |
| 没有任何开源 Lua TWS 航迹文件实现 | 确认（本次搜索范围内未找到，不代表不存在） |
| `avImprovedRadar`（VSN 注释出现过一次） | 推测：疑似改进版雷达设备/插件，来源未核实 |
| "F-22 Block 40 有自定义 RWS/TWS 雷达"（Reddit 帖） | 未核实，与 Grinnelli 现仓库代码不符 |
| Anubis C-130J 雷达实现 | 未核实（无公开源码） |

### 5.6 对本项目的借鉴

1. **接口天花板已探明，自研是唯一出路**：avSimpleRadar 无 TWS 航迹文件、无 RCS 曲线、无 Pd；我们做的原理级 AESA/SAR 在生态里没有对标物——差异化价值高，但也意味着没有现成参考实现。对外兼容其参数命名/量级，对内自建 RCS/SNR/Pd 与航迹管理。
2. **地形真值两条现成通道可用于 MAP/条带**：Lua 侧 `require('terrain')` 的 `isVisible/GetHeight/GetSurfaceType`；C++ 侧 `worldgeneral.dll` 的 `globalLand`。"射线求交→坡度/材质反射率→脉宽涂抹→强度累加→余辉"流水线可接进我们的成像服务做低成本前端。
3. **扫描调度用"每帧固定预算+时间切片"**：A-4E-C 20 Hz 每帧固定方位段数、C++ 每帧 100 采样点；A-6E 反推出"5° 区间 ≈ 0.82 s 周期"。我们的世界锚定扫掠可照此设每帧方位/距离门预算，扫描周期显式跟随 scan_beam × scan_volume 推导。
4. **显示层用"参数/图元"而不是图像**：A-4E-C 的 2500 blob 方案证明该量级可行；逐像素贴图更新在 DCS 里代价未知、需另行验证。
5. **"寄生模块"可快速验证玩法但不做仿真**：若需要可联机试飞的演示壳，可把外部成像服务挂到这类壳上；核心仿真保持 Export + 任务桥接架构。

---

## 6. 引擎给模组雷达的底层能力与渲染路径

### 6.1 结论

1. 模组雷达的 Lua 层完全可见，信号处理/成像算法不可见；ED 自家 F-16C/F-18C 甚至不附带雷达 DLL——`F16::avRadar_APG68_F16` 由游戏本体模块提供。
2. **雷达视频渲染到 MFD 有一条统一路径**：Lua 用 `GetRenderTarget()` 拿编号，材质 `"render_target_"..(id+1)` 声明 `ceTexPoly` 视频元素；实际像素由座舱设备的原生代码写入共享渲染目标。ED 自家与 RAZBAM 用同一套机制。
3. **关键发现**：`Config/Effects/radar.lua` 是引擎内置雷达成像渲染器配置（`rbm/dbs/rmap/tpm/ta` 五模式 + `resolution/quantization/blurAngle/clearancePlane/elevationBias`），ED 的 F-16/F-18 雷达图就是这台渲染器把地形渲染进 render target 的产物——不是逐点采样高度的"假雷达"，而是对地形网格做真实的视图/射线渲染。F-15E 不在预设表内，说明 RAZBAM 绕开引擎渲染器自研了整套成像。
4. Lua/Export 层拿不到任何雷达图像数据：Export 只有 A-A 目标跟踪表；TA/地面图/DBS 全不暴露。拿 MFD 画面的唯一官方手段是共享内存导出 `LoSetSharedTexture`。

### 6.2 统一的渲染目标机制（确认事实）

Lua 写法在所有机型一字不差：

- ED 公共膝板（官方示范）：`Scripts/Aircrafts/_Common/Cockpit/KNEEBOARD/indicator/base_page.lua:30-31`：
  ```lua
  render_tv.material    = "render_target_"..string.format("%d",GetRenderTarget() + 1)
  render_tv.controllers = {{"to_render_target",0}}
  ```
- F-16C AG 雷达图像页：`F-16C/Cockpit/Scripts/Displays/MFD/indicator/Pages/FCR/MFD_FCR_AG_IMAGE.lua:11-23`（`ceTexPoly` + `render_target_id+1` + `additive_alpha`）。
- F-16C 通用视频元素（TGP/MAV/ATP 共用）：`symbology_defs.lua:823-840` 的 `add_render_target()`。
- F/A-18C AG 雷达专用函数，注释直接写明：`FA-18C/.../MPD/MPD_page_defs.lua:325-349`："Is used for A/G radar render"。
- MFD 显示器通过 `brightness_sensitive_materials`/`opacity_sensitive_materials` 挂载 `render_target_1..8`（F-15E `MFDG_init.lua:9-29`、F-16C `MFD_left_init.lua:1-6`）。

F-15E 证据链：三张 `MFD_radar_video_*` 纹理（`materials.lua:67-72`，素材名 `nil` = 运行时生成）；`F15E_CPT.dll` 内含 `to_render_target` 字符串（Lua 层无一处使用）；设备注册 `device_init.lua:12-28`；RDR_AG 页 241 行全是符号+一张视频纹理。

社区分析（确认存在，官方默许到半公开）：ED 官方论坛 2018 帖 [Basic Radar \[example code\]](https://forum.dcs.world/topic/188347-basic-radar-example-code/) 从 CockpitBase.dll 抽取字符串发现 `RADAR_CONTACT_%02d_` 参数命名规律，并指出这些参数不出现在 `list_cockpit_params()` 里；Helios/DCS-BIOS 大量依赖对 indicator `*_init.lua` 的补丁式改写导出显示内容。

> 推测（未被官方文档确认）：`to_render_target` 是 CockpitBase.dll 暴露给模组 DLL 的接口之一，第三方 DLL 通过调用引擎同名函数把图像写入 MFD render target。

官方唯一图像导出通道（确认事实）：`Scripts/Export.lua:1486-1500` 原文件注释——`LoSetSharedTexture(name)`/`LoRemoveSharedTexture(name)`/`LoUpdateSharedTexture(name)`，以 Windows BMP 形式导出；示例 `"mfd0"`（SHKVAL 全屏）、`"mfd1"`（ABRIS 地图）、`"mirrors"`。同见 [Hoggit DCS Export Script 页](https://wiki.hoggitworld.com/view/DCS_Export_Script)。

### 6.3 ED 自家 F-16C / F-18C 的 AG 雷达实现方式

Lua 壳厚度（确认事实）：F-16C `Sensors/Radar/RadarDevice.lua` 仅 20 行（屏幕像素常量 `RDR_screenSizePx=480` 等 + `renderDebugInfo=false`）；F/A-18C 同名文件仅 5 行。两机型目录下没有雷达专属 DLL——`F16C.dll`/`FA18C.dll` 承载全部航电，雷达设备由主程序模块（`CockpitBase.dll`/`Scripting.dll`/`DCS.exe`）提供实现。

地形来源（确认事实，本地文件）：`Config/Effects/radar.lua`（124 行）定义全部预设（表见 3.3）。这直接回答"地形高度采样还是光线投射"：`tpm`/`ta` 的参数是 `clearancePlane`/`elevationBias`（典型沿波束抽地形高度剖面）；`rbm`/`dbs` 的 `blurAngle`/`resolution`/`quantization` 是视图/射线式渲染的量纲——两者是同一引擎渲染器的不同 mode，数据源是 DCS 地形网格（DTED 级高程+地表分类）。旁证：Mudspike 论坛 Hornet 讨论串有人称雷达波束是 ray casting（"It is not raytracing, its ray casting…"，页面直连 403 仅有搜索摘要，可信度中等）。

> 推测：`radar.lua` 是引擎内建渲染器；ED 自家模组经某个 DLL 侧接口注册预设名；**第三方模组能否注册预设接入引擎渲染器尚未证实**（本机所有模组 Lua 层搜不到 `GM_F16` 等预设名引用，连接点在 DLL 侧）。

### 6.4 Lua 层可用的雷达相关引擎 API

座舱层（Cockpit Lua）：`GetRenderTarget()` + `render_target_N` + `to_render_target`；`ViewportHandling.lua:75-95`（`set_full_viewport_coverage()` 等）；`lock_on_options`/`writeParameter()`；`avLuaDevice` 钩子（`SetCommand`/`CockpitEvent`/`update`）；`add_render_target()`（相机式传感器）。

Export.lua 雷达数据边界（全表核对，确认事实）：

- `LoGetTargetInformation()`/`LoGetLockedTargetInformation()`：目标表含 `ID/type/distance/reflection`（RCS）/`fim`/`fin`/`flags`（含 `whStaticObjectLock`/`whImpactPointTrack` 地面点锁定位）。
- `LoGetTWSInfo()`：RWR 告警源表（**不是雷达 TWS**）。
- `LoGetSightingSystemInfo()`：仅 FC3 级——`ScanZone`、`PRF`、`TDC`、`radar_on`。
- `LoGetMCPState()`：含 `RadarFailure`。
- `LoGetF15_TWS_Contacts`：仅列在 `API/Sim_ControlAPI.md:509`，源码无文档（见 2.6 待纠正事项）。
- 多人服务器门槛：`LoIsSensorExportAllowed()`（服务器 `allow_sensor_export` 设置）。
- **完全没有**：地面图/SAR/DBS 视频、地形反射率、地表分类、雷达图像矩阵、TA 地形剖面。
- DCS-BIOS 印证：[dcs-bios discussion #1217](https://github.com/DCS-Skunkworks/dcs-bios/discussions/1217)——现代高阶模组上 `LoGetTargetInformation` 等老接口大量返回 `nil`，社区只能靠座舱参数间接读数。

任务脚本层（只有元数据）：`Unit.getRadar()` → (开机?, 当前最关注目标)（[Hoggit](https://wiki.hoggitworld.com/view/DCS_func_getRadar)）；`Unit.getSensors()` → 传感器能力表（`typeName`、`detectionDistanceAir.{headOn,tailOn}.{upper,lower}Hemisphere` 等）（[Hoggit](https://wiki.hoggitworld.com/view/DCS_func_getSensors)）；`world.searchObjects(...)` 无地形反射/无雷达图像/无地表材质；任务脚本沙箱（`Scripts/MissionScripting.lua:10-19`）移除 `os/io/lfs/require`——重计算/文件 IO 需额外开洞（本项目已用 `net.dostring_in`）。

FC3 雷达：共享雷达模型经 `LoGetNavigationInfo()`（`SystemMode.master="BVR"/"CAC"/"LNG"/"A2G"`、`submode="RWS"/"TWS"/"STT"/"GUN"/"FLOOD"`）与 `LoGetSightingSystemInfo()` 暴露状态；成像逻辑同样是 C++，Lua 只查询不能改。

### 6.5 对本项目的借鉴

1. **视频进 MFD：抄 render_target + 共享内存**。模组 Lua 声明 `"render_target_"..(GetRenderTarget()+1)` 的 `ceTexPoly`，再用 `LoSetSharedTexture("mfd0")` 把画布导出到命名共享内存给外部成像服务读写。注意 `"mfd0"`/`"mfd1"` 已被 SHKVAL/ABRIS 占用，F-16/F-18 自定义 MFD 是否注册可导出名尚无证据，需实测。
2. **`Config/Effects/radar.lua` 当验收基准**：`resolution=19/67/120` 对应 EXP/DBS1/DBS2 分辨单元数、`quantization=8`、`blurAngle` 方位波束模糊——我们的 SAR/条带图在分辨率与量化档位上对齐 ED 三档，能被 DCS 玩家"一眼认对"。
3. **地形数据只能从引擎外自取**：Lua/Export/任务脚本三层都拿不到地形高程；我们的等价物是自己备 DEM 或用 DCS 地图导出的高程数据。不要指望在插件里通过 Lua 采样地形。
4. **RP5 的 ground_clutter 块是可照搬的参数模板**：`RP5_Search.lua:16-23` 的 sea/land/artificial 三分类反射系数 + `max_distance` + `rays_density=0.15`——DCS 杂波模型就是按射线密度抽样。我们的 GMTI/杂波模型可对齐这个三分类与射线密度思路。
5. **A-A 数据从 Export 白拿，A-G 数据链必须自己造**：`LoGetTargetInformation` 提供 RCS、视角、跟踪类型，够做 A-A 探测判定；A-G 成像（DEM+目标物体+信号处理）DCS 一概不给——这正是当前"外部成像服务"架构，也是本调研最硬的结论。

### 6.6 未能核实事项

ED 官方从未发布雷达渲染器或模组雷达接口的正式文档；社区文档（如 DCS Modding Guideline Wiki）只覆盖座舱设备骨架，未涉及雷达成像。本章所有"引擎能力"结论都是从本机文件与二进制字符串反推的，不是官方承诺的稳定接口。

---

## 附：对本项目既有文档的修正提示

1. `LoGetF15_TWS_Contacts` 在当前安装的 `Scripts/Export.lua` 中不存在（全盘 grep 无结果），仅见于社区老脚本与老 wiki——属遗留接口，当前版本可用性未知。`docs/plan`、`docs/status` 等若引用应改标"遗留接口，待实测"（建议下次飞 F-15C 时与 `LoGetSightingSystemInfo` 一起探测）。
2. 社区模组 DcsWebDatalink（F-15E SIT/HMD 数据链工具）是数据链工具，与雷达无关，不含雷达实现。
3. 若复用引擎成像管线（写 `Config/Effects/radar.lua` 预设）属修改游戏已有文件：必须走可复现部署脚本 + 修改前备份 + 清单 + 可卸载（根 `AGENTS.md` 安装目录部署强制规则），并做同名工具冲突检测。

# DCS 社区模组实现"原理级 AESA 雷达"可行性调研

- 状态：current（2026-10-18 复核）

日期：2026-09-27
调研环境：DCS 2.9.29.27468（`<DCS>`，只读检查）
问题：能否在 DCS 现有"机械扫描 + 脉冲多普勒"雷达体系上开发社区模组实现 AESA？还是必须完全从头开发？

---

## 0. 结论（TL;DR）

**两个问题的答案都是"不"，但各取一半：**

1. **不能在现有实现上"改造"出 AESA。** DCS 的玩家机雷达探测逻辑全部在闭源二进制里（全真模块是各自 DLL 里的 C++ device，FC3/官方 AI 是加密的 `Scripts\Database.edce` + 引擎 C++）。Lua 层暴露的雷达参数 schema（`declare_sensor`）是"扇区 + 扫描周期 + 分姿态探测距离"的抽象模型，**没有波束驻留、波束指向调度、模式交织的概念**，装不下 AESA。
2. **也不需要"完全从零"造整个雷达仿真。** DCS 开放了两类非常有用的资源：
   - **真值数据**：任务脚本环境能拿到所有单位的位置/速度/阵营、地形通视（`land.isVisible`）、引擎探测结果（`Controller:getDetectedTargets`）；Export 侧能拿到本机雷达接触（`LoGetTargetInformation`，含 RCS、接近速度、STT/TWS 标志）。
   - **行为回写**：任务脚本可以 `Controller:knowTarget()` 向 AI "喂"目标知识、用 `setTask/setOption` 约束 AI 行为（Skynet-IADS 已验证这条路线）。

**因此正确的问题表述是：AESA 的"物理 + 波束调度逻辑"必须自己从零写（社区没人有现成的），但它可以寄生在 DCS 之上，用 DCS 当真值源和呈现/行为输出端。** 需要接受的代价：你的雷达"辐射"不会出现在敌方 RWR 上、引擎导弹导引不认你的航迹、结果进不了全真模块的座舱显示器——这三条是当前社区 mod 的硬边界。

推荐路线：**先在本仓库内做纯 Lua 的 AESA 仿真核心（波束调度器 + 雷达方程 + 航迹管理，带单元测试，离线可验证），再分层接入 DCS（任务脚本 → 外部显示器 → 可选的社区 C++ 座舱设备）。**

---

## 1. AESA 从原理上需要模拟什么

### 1.1 物理基础

- 天线是几百到上千个 **T/R 组件**的平面阵列（AN/APG-77、APG-79 约 1000+ 个），每个组件自带发射功放、低噪接收、移相器/衰减器。
- 波束指向由**逐元件相位梯度**决定（Δφ = 2πd·sinθ/λ，d ≤ λ/2 防栅瓣），**无机械惯性，微秒级改向**，覆盖天线法线周围约 **±60° 锥形区域**。
- 关键派生特性（都是机械扫描没有、可以在仿真里体现的）：
  - **扫描损失**：增益 G(θ) ≈ G₀·cosθ（孔径投影），单基地雷达 R_max ∝ √G，所以探测距离 R(θ) ≈ R₀·√cosθ —— 60° 时增益约 -3 dB、距离约降到 70%；波束宽度按 1/cosθ 展宽、副瓣抬升。
  - **波束是可编程资源**：任意时刻可以指向任意方向，这是 AESA 与机械雷达的本质区别——不是"转得快"，而是**指向是软件说了算**。
  - 频率分集：每个驻留可用不同频点/带宽（LPI、抗干扰、抗闪烁的基础）。
  - 无机械可靠性问题：可仿真 T/R 组件逐个失效的**性能退化**（增益/副瓣缓慢变差而非宕机）。

### 1.2 仿真核心 = 驻留时间轴调度器（这是 AESA 模型的灵魂）

机械雷达仿真可以简化为"波束位置随时间连续移动"；AESA 的正确抽象是**离散驻留（dwell）序列**：

```
时间轴:  | 搜索条带1 | 跟踪T3 | 搜索条带2 | 跟踪T1 | A/G测绘条带 | 跟踪T3 | ID/NCLR | 搜索条带3 | ...
```

每个驻留 = {波束指向(az/el)、驻留时长(决定积累时间与探测距离)、波形/PRF、发射功率、模式目的}。调度器按优先级在时间轴上复用：

- **搜索光栅**：把扫描体积切成 bar × 增益档位，逐条驻留；
- **跟踪更新**：每个已建立航迹按需要的 revisit 率（如 1–4 Hz）插队，AESA 因此可以"不中断搜索地维持跟踪"（真正的 TWS 是分时回访，不是牺牲搜索）；
- **模式交织**：A/A 搜索 + 跟踪 + A/G 测绘/SAR + NCTR/识别 + 数据链窗口同时跑，各占时间预算；
- **功率/波形管理（LPI）**：按目标距离只发够用的功率、随机化 PRF 与频点、低副瓣 → 直接决定"被 RWR 截获的概率"，这一条要和告警/ECM 模型联动。

### 1.3 每个驻留内的探测物理（单脉冲级）

对每个候选目标，用雷达方程按驻留参数算检测概率，而不是"进扇区就可见"：

- SNR ∝ Pt·G²(θ_scan)·λ²·σ / ((4π)³·R⁴·kTBF·L)，G 含扫描损失；
- **σ（RCS）的真值分层（2026-09-27 修正，原则：目标侧数据锚定 DCS，不造假设）**：
  - 默认：**机型标量 RCS**——DCS 官方本来就是每机型一个标量（如 `ChinaAssetPack\...\J-11A.lua:150` `RCS = 5.5`），引擎自身的探测也只按"迎头/尾追 × 上/下半球"四桶区分（`declare_sensor` 的 `detection_distance` schema）。我们做"机型 → RCS"查表（官方明文 CoreMod + 社区提取值），官方定多少，探测结果就是多少；
  - 可选（默认关）：**连续姿态角 RCS 曲线**——这是本项目自建假设（DCS 无此数据），必须显式开启并标注，用于需要更高保真的场景；
  - 仿真结构说明：任何传感器仿真（包括 DCS 引擎自己）都是"全知世界真值 + 传感器模型滤波"——`getDetectedTargets`、Export 的 `reflection`/`delta_psi` 都是这道真值的产物。我们的虚拟雷达同构：真值输入全部来自 DCS（单位位置/速度/地形通视/官方 RCS），唯一属于自建的是雷达自身参数（假想 AESA 的功率/增益/波长，只能来自公开资料估计）与可选姿态 RCS 层；
- **脉冲多普勒处理**：PRF 档（H/M/L）各自的距离/多普勒模糊与遮挡（eclipsing），主瓣杂波与**notch**（目标径向速度接近零时被杂波滤掉——引擎里这个现在是一个硬编码的 `radial_velocity_min`，我们可以做成按 PRF 可变的凹口）；
- 检测概率模型（Swerling 1/2）+ 虚警率 → 按驻留采样，而不是确定性开关；
- **航迹管理器**：检测 → 航迹起始（M/N 逻辑）→ 保持（漏检衰减、波束调度器回访）→ 丢失，输出带质量的航迹而非原始回波。

以上 1.2 + 1.3 合起来就是"原理级"的最小集合。DCS 引擎当前的传感器 schema（见 §2.2）只覆盖了其中"扫描体积 + 分姿态距离 + 径向速度下限"三个非常粗的近似，其余全部要自建。

---

## 2. DCS 雷达仿真现状（本机 2.9.29 实证）

### 2.1 分层结构

| 层 | 位置 | 实现 | 社区可改性 |
|---|---|---|---|
| 引擎 AI/FC3 传感器 | `Scripts\Database.edce`（加密）+ 引擎 C++ | `declare_sensor` schema 参数化 | 仅当 Mod 自带明文 DB（如 ChinaAssetPack）可加新条目；官方 FC3 条目本体加密 |
| AI 探测调参 | `Scripts\AI\Detection.lua`（明文） | 姿态因子、地形遮蔽因子等开关 | 改了属全局改，MP 不友好 |
| 全真模块雷达 | 各模块 `bin\*.dll` 内 C++ device（F-16C: `F16::avRadar_APG68_F16`；F/A-18: `F18::avRadar_APG73_F18`；F-15E: `AN_APG70::RadarDevice` 纯 C++ 无 Lua） | 探测逻辑闭源 | Lua 侧只有注册行、显示布局常量、故障表 |
| RWR（告警接收端） | `Scripts\Aircrafts\_Common\Cockpit\analog_RWR_templates.lua` | **有 `RWRScanPatternType.ESA`、AESA 注释、dwell_time** | 明文，电扫概念只存在于"看别人"的这一侧 |
| SAM 相控阵 | `CoreMods\tech\HeavyMetalCore\...\40V6M_RPN_S-300PS_TR.lua` | 用"1 主 + 5 个 ±45° 子 tracker + 大扇区 + 短 scan_period"**近似**多目标电扫通道 | 明文，但本质仍是扇区模型 |
| 任务脚本（MSE） | `Scripts\MissionScripting.lua` 沙箱 | C++ 注入 API | 完全开放（服务器端生效、全体客户端免装） |
| Export | `Scripts\Export.lua`（1273 行，本身是 API 文档） | C++ 注入 Lo* 函数 | 完全开放（仅客户端） |

### 2.2 关键证据

**引擎传感器 schema 没有波束调度概念**（`CoreMods\tech\ColdWarAssetsPack\Database\db_sensors.lua:1-29`，P14 预警雷达）：

```lua
declare_sensor({
    Name = "P14_SR", category = SENSOR_RADAR, type = RADAR_AS,
    scan_volume = { azimuth = {-180,180}, elevation = {-15,15} },
    max_measuring_distance = 400000.0,
    detection_distance = { [HEMISPHERE_UPPER] = { [ASPECT_HEAD_ON]=400000, [ASPECT_TAIL_ON]=400000 }, ... },
    lock_on_distance_coeff = 0.85,
    velocity_limits = { radial_velocity_min = 20 },  -- PD notch 是一个硬下限
    scan_period = 6.0,                               -- 周期性扫描整个扇区
})
```

- 探测距离按"上/下半球 × 迎头/尾追"四个桶给定，RCS 只在**目标单位定义**上（如 `ChinaAssetPack\...\J-11A.lua:150` `RCS = 5.5`）作为缩放因子。多用途雷达（`RADAR_MULTIROLE`）多出 `TWS_max_targets`、`multiple_targets_tracking`、GMTI 距离等字段——**没有任何与"单次驻留/波束指向/模式交织"对应的字段**。
- AESA 相关字样全库 grep 只命中：RWR 模板（ESA 扫描图案、AESA TWS 注释）、`ChinaAssetPack` 里 KJ-2000 的传感器名（用 `scan_period=0.1` 表达"电扫快"）和 F-4E RWR 脚本。**引擎的"电子扫描"只存在于被探测端的告警显示层。**

**全真模块雷达探测在 DLL 里**：`Mods\aircraft\F-16C\Cockpit\Scripts\device_init.lua:409` `creators[devices.FCR] = {"F16::avRadar_APG68_F16", ...}`（旁边的 `RadarDevice.lua` 只有 20 行显示布局常量）；F-15E 连 Lua 文件都是 `nil`。→ **社区无法给现有全真模块注入或替换雷达逻辑。**

**官方 F-16C 的雷达显示链路（2026-09-27 补充验证，"放入官方模组"死路的证据）**：FCR 的 MFD 页面是明文 Lua（`Mods\aircraft\F-16C\Cockpit\Scripts\Displays\MFD\indicator\Pages\FCR\MFD_FCR_AA.lua` 等共 9 个文件），但全部是**声明式符号布局**——`addPlaceholder/addStrokeSymbol` 绑定参数名（如 `MFD_FCR_AA_TrackedTarget_Pos`），目标数据由 C++ 设备（`F16::avRadar_APG68_F16`）算好后写入座舱参数表，页面只负责画。同时座舱脚本目录全量 grep 无 `world./coalition./land./LoGet*` 访问：座舱沙箱既拿不到世界真值，也没有网络/文件通道从外部注入数据。**结论：让官方 F-16 的 MFD 显示自研雷达的结果，不存在架构上的通路，与是否改官方文件、是否取得授权无关。**

**Export 侧能力（`Scripts\Export.lua`，已逐行核实）**：

- `LoGetTargetInformation()`（:647）——**本机当前雷达接触列表**，每目标含 `distance`、`convergence_velocity`（接近速度）、`reflection`（RCS m²）、`delta_psi`（姿态角）、`isjamming`、`updates_number`（航迹更新计数）以及 `flags` 区分 RadarView(BVR)/RadarLock(STT)/RadarTrack(TWS)/HOJ；
- `LoGetSightingSystemInfo()`（:686）——扫描区位置/覆盖、`radar_on`、PRF 档位（MED/HI/ILV）；
- `LoGetTWSInfo()`（:735）——**注意：TWS 这里是 Threat Warning System（本机 RWR 收到的辐射源表：方位/功率/scan|lock|track_while_scan），不是跟踪列表**；
- 权限闸门 `LoIsSensorExportAllowed()/LoIsObjectExportAllowed()`（:429）——MP 下要服务器开 Sensor/Object 导出，Tacview 就是吃 `LoGetWorldObjects()` 这一层。

**任务脚本侧能力（Hoggit 核对）**：`Unit:getPosition()/getVelocity()`、`world.searchObjects`、`coalition.getGroups`、`land.isVisible(a,b)`（地形通视）、`land.getHeight`、`Controller:getDetectedTargets()`（引擎侧真值 oracle，返回 visible/type/distance）、`Unit:getRadar()`、`Controller:knowTarget()`（喂目标给 AI）、`setTask/setOption(AI.Option.Air.id.RADAR_USING)`。沙箱只删 `os/io/lfs/require`（`MissionScripting.lua:15-22`）。

---

## 3. 三条可行路线与各自边界

### 路线 A：任务脚本层"虚拟 AESA"（推荐主路线）

- **做法**：在任务脚本里跑 §1 的仿真核心；输入用真值（`getPosition/getVelocity` + `land.isVisible` 或 `getDetectedTargets` 做对照），输出用 `knowTarget` 喂 AI + `outTextForCoalition`/标记/无线电消息呈现。
- **优点**：服务器端脚本对所有客户端生效、免安装、不碰完整性校验——MP 下唯一稳妥的"影响世界"通道；Skynet-IADS 已证明该层能撑起全网探测/联动/反辐射对抗这类规模逻辑。
- **边界**：呈现手段有限（进不了座舱 MFD）；性能受脚本预算限制（波束调度按 0.1–0.25 s 步长没问题，逐脉冲不可能）；引擎武器导引不认你的航迹。

### 路线 B：Export/外部程序层"第二屏幕雷达"

- **做法**：客户端 Export 脚本把自算/引擎接触经 socket 发到外部程序，渲染一台"真" AESA 显示器（B 扫描、航迹质量、模式交织指示）。
- **优点**：呈现质量上限最高（网页/原生 UI 随便画）；DCS-BIOS/Helios/Tacview 是成熟先例；还能拿 `LoGetTargetInformation` 的引擎数据做"对照组"校准自研模型。
- **边界**：纯只读，无法回写影响 AI/武器；MP 下依赖服务器开 Sensor/Object 导出（多数竞技服不开）。

### 路线 C：社区 C++ SDK 座舱设备（上限最高、成本最高）

- **做法**：像 A-4E-C/UH-60L 那样编译设备 DLL，把 AESA 状态机+显示器做进"自制飞机"的座舱里。
- **硬伤**：社区能拿到的头文件（`wHumanCustomPhysicsAPI.h` 飞模、`ccParametersAPI.h` 座舱参数）**不含世界目标/传感器数据接口**——设备自己"看见"不了世界，探测数据仍要靠 Lua 层自算后喂进来；完整 SDK 仅签约第三方持有（NDA）。开源社区至今没有任何机载 A/A 探测雷达先例，A-4E-C 的 APG-53A（A/G 测绘雷达，Lua 自扫任务对象，甚至能"看见"隐藏单位——官方定性为引擎限制）就是公开生态的天花板。
- **结论**：C 层解决"进座舱的皮"，物理内核仍要 A/B 层的自研核心提供。

### 硬边界汇总（当前无论如何绕不过）

1. 现有 FC3/全真模块的扫描图形与 TWS 逻辑硬编码在引擎/DLL 里，DB 只能改数值（VSN 系列 = 改 FC3 雷达副本的距离参数，行为不变）。
2. 自建雷达的辐射**不会出现在敌方 RWR** 上（引擎 RWR 只认引擎雷达对象）—— ironically 成就了 LPI，但造成信息不对称。
3. **引擎导弹（AIM-120 等）的中段修正只认引擎航迹**；虚拟雷达最多给 AI 喂目标让 AI 战术上配合，玩家发射的导弹无法用你的航迹。
4. MP 完整性校验：改核心安装目录会被拒；`Saved Games\DCS\Mods` 模组与服务器任务脚本安全。
5. `Scripts\AI\Detection.lua` 这类全局明文调参在 MP 上等于改服务器行为，不可作为产品手段。

---

## 4. 路线图（2026-09-27 确认；同日按用户决定拆分：原阶段二分为"数据接入"与"呈现"两段，姿态 RCS 顺延为阶段四）

1. **阶段一：AESA 仿真核心（纯离线）——原型开发中**：已有驻留调度器、单驻留雷达方程、航迹管理与三个适配接口（TruthSource/RCSProvider/OutputSink）的初步实现及部分测试。理论依据与断言见 `docs/theory-notes.md`、设计见 `docs/design-phase1.md`；当前覆盖场景通过不代表本阶段完成，项目暂无发布计划。
2. **阶段二：DCS 真值接入（数据层）——延续阶段一的可测试方法论，核心代码零改动**
   - **真值源适配器**：Export 侧脚本按固定频率采样 `LoGetSelfData` / `LoGetWorldObjects`（同帧附带 `LoGetTargetInformation` 作引擎雷达对照），经 LuaSocket 发本地端口；**核心在 DCS 进程外运行**（Export 脚本只做采样与发送，保持薄而稳，进程内崩溃面最小）。
   - **录制/回放**：真值录制为文件 → 回放型 TruthSource → 阶段一的测试体系直接吃真实数据（线上问题离线复现）。
   - **对照记录**：同一段飞行中引擎雷达接触 vs 本核心输出的量化差异报告——用于参数校准与合理性检查（对齐不是目标，量级与行为差异本身是信息）。
   - **部署**：Saved Games 的 `Export.lua` 标记块 + 安装/验证/修复/卸载脚本（与 SRS/Tacview 共存；不触安装目录、不需要管理员）。
3. **阶段三：呈现（把结果反映到游戏与座舱）**
   - **3a 外部显示器原型——开发中**（docs/design-phase3a.md）：已有 `tools/live.py` 本地 HTTP+SSE 网页查看器（B 扫描 + 波束轨迹 + 时间预算）的初步实现，支持实时与录制回放两种驱动，作为开发调试/对照界面继续验证。
   - **3b 座舱页面 + 窗口贴附**：参照社区先例的做法改 F-16C 座舱脚本注册自制"AESA 页面"（OSB 按钮与页面状态，Export 回读），接触内容先用外部无边框窗口贴附 MFD 屏幕位置绘制（`LoGetCameraPosition` 对位）。安装目录改动按 AGENTS.md 规则打包：OvGME/JSGME 格式 + 清单 + 自动备份/还原。
   - **3c 帧内渲染（可选进阶）**：开源 ReShade 运行时/add-on API（或自研 D3D11 hook）画进游戏帧，覆盖 2D 与 VR。
   - **不变的事实**：引擎 FCR 页面本体不可替换或喂数据（座舱数据通道不存在，见 §2.2），本方案是"新增一页"而非"改造 APG-68"；引擎雷达照常运行，AMRAAM 导引与 RWR 交互不受影响。多人僚机共享走 DCS 自带 `Scripts\RPC.lua` 玩家间通道【社区实证】。
4. **阶段四（可选增强）：连续姿态角 RCS 曲线（默认关）**：机型 × 姿态角 RCS 建模（公开资料 + 估计，显式标注为自建假设），经 RCSProvider 接入；配开/关对照测试。放在数据接入与呈现都验证之后，与"目标侧数据锚定官方"的原则一致。
5. **远期可选**：社区 C++ 飞机模块实现真正座舱内雷达；关注官方 Eurofighter（CAPTOR-E）/Rafale 是否带来引擎级电子扫描建模与新的暴露接口——届时 `declare_sensor` schema 若扩出波束调度字段，输出端可直接升级为引擎原生目标。

---

## 5. 参考来源

- 本地实证：`Scripts\Export.lua`、`Scripts\MissionScripting.lua`、`CoreMods\tech\ColdWarAssetsPack\Database\db_sensors.lua`、`CoreMods\tech\HeavyMetalCore\Database\Vehicles\SAM\radar\40V6M_RPN_S-300PS_TR.lua`、`Scripts\Aircrafts\_Common\Cockpit\analog_RWR_templates.lua`、各模块 `device_init.lua`（见 §2 路径）
- Hoggit Wiki：Scripting Engine（`getDetectedTargets`、`land.isVisible`、`knowTarget` 等）、DCS_export（导出权限分组、Lo* 函数）
- Skynet-IADS（GitHub: walder/Skynet-IADS）——脚本层虚拟 IADS 先例
- A-4E-C（GitHub: Community-A-4E/community-a4e-c）及 issue #531（APG-53A 能看见隐藏单位 → 引擎限制）；heclak 采访（无 SDK 部分功能不可为）
- ED 官方 FAQ 1262/1267/1268（Unit/Controller 脚本 API）
- 社区讨论：VSN 模组雷达改法、DCS 2.9 官方 F-16/F/A-18 雷达 PD 大修（Quaggles dcs-charts）、Eurofighter/Rafale 官宣帖（雷达建模方式均无官方说明，未确认）

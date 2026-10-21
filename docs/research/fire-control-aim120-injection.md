# AIM-120 引导攻坚调研：注入、数据链与模组化路径

- 状态：external-reference（2026-10-18 复核）

日期：2026-10-15。性质：第二轮外部调研 + 本机二进制核实（7 条线索并行）。上一轮结论见 [fire-control-paths.md](fire-control-paths.md)。本轮针对用户要求："想办法让火控雷达能引导 AIM-120；探索为我们的雷达为本机雷达提供目标、注入游戏内存/进程等方法"。

证据分级：【本机核实】（直接读本机 2.9.30.28738 文件/二进制）/【文档】/【社区实证】/【推断】。

## 0. 结论先行

1. **最重要的新事实：DCS 当前版本（2.9.19+ MSI 功能）已官方支持"本机雷达不辐射、靠机外航迹发射并中段引导 AIM-120"——但仅限 F/A-18C。** Hornet 可把 AWACS 的 SURV 数据链航迹指定为 L&S/DT2，雷达处于 SIL/standby（不辐射）时导弹仍收到中段修正并命中【文档：ED changelog 2.9.27.24969 + NineLine 已知问题帖】【社区实证：r/hoggit 1u5d7hv 实测 + ED forum 388967 双人复现】。注意边界：**雷达必须开机 standby，完全 OFF 则既不能指定也无支援**【社区实证，两人独立测试一致】。F-16C 没有 MSI，无证据能对纯数据链航迹发射。
2. **因此"我们的雷达引导 AIM-120"在 ED 飞机上只剩一条理论缝隙：把我们的航迹伪造成 Link16 SURV 消息注入本机数据链总线 → Hornet MSI 融合为航迹 → 玩家指定 L&S → 发射，中段由载机数据链转发**。链路的两半都已被独立实证：①外部进程往 DCS 注 DLL 不需要改安装目录（Saved Games Hooks Lua 直接 `require` 任意 DLL，见 §2）；②引擎数据链收发符号在现役二进制中完整存在（`wRadio.dll` 的 `wDatalinkCommunicator::send_msg/receive_msg`，`datalink_msg` 结构有 2015 SDK 头文件），Modern F-15E mod 已在进程内钩住 `receive_msg`（只读）【本机核实+社区实证】。**未被证实的只有中间一步：合成消息能否被 Hornet 的 MSI 接受并变成可指定航迹——无人做过。**
3. **另一条原生缝隙**：`Weapons.dll` 导出表里有 `wWeaponSystemManager::assignAutotrackingTarget(MovingObject*)`、`add_target`、`assign_target` 等目标写入方法【本机核实】；2015 SDK 头文件有 `IwMissile::setTarget(ObjectID)`、`cLauncherRadarTrack::track_missile(missileID, targetID)`，现役二进制中同名符号仍在【本机核实+社区实证】。但语义大概率只对 AI 射手成立、无 ABI 文档、且 DCSRecorder 的先例证明**引擎会自我纠正被外部改写的仿真状态**（写入位置后被 AI 13 秒拉回）【社区实证】。属高风险逆向赌注。
4. **模组飞机路线被大幅证实**：引擎自带 `avSimpleRadar` 设备类（CockpitBase.dll，未混淆，参数约定已逐字提取），模组飞机的 SARH（AIM-7 级）经此"零额外代码"即可制导（VSN F-4 实证在飞），ARH（AIM-120 级）有一位资深模组作者 2024 年明确声称可行【社区实证，单源】。关键：**我们的 AESA 算法可以实时驾驶这个设备**（写 `SCAN_ZONE_ORIGIN_*`/`RADAR_TDC_*`、发锁定命令 509），引擎负责检测物理与导弹服务——即"我们的雷达拥有目标选择/锁定权，引擎服务导弹"。
5. **自定义弹药路线**：`declare_weapon` 可声明"离架即主动 + 大导引头"的 AIM-120 克隆弹（`go_active_by_default`/`active_dist_trig_by_default` 在 AIM-54C/PL-15 生产文件中实证【本机核实】），社区已有"无锁定发射、弹载雷达自导"的成品弹药 mod【社区实证】。此路线下雷达**真正完全关机**也能命中——但"引导"成色是发射解算+导引头自主。风险：2026-03 有报告称 ED 破坏了全部用 amraam2 scheme 的自定义 FOX-3【社区】。
6. **必须向用户对齐的措辞**：在当前 DCS 机制下，AMRAAM 中段指令链物理上走载机雷达/电台硬件，因此**"本机雷达完全断电关机"与"中段引导"互斥**。可达到的最强形态是"**本机雷达零辐射**"（SIL/standby，敌机 RWR 全程静默）——战术效果与关机等同。若用户坚持字面关机，则只剩自定义弹药（§5）或激光制导体裁（上一轮 A2）。

## 1. 机制地图：AIM-120 中段制导在引擎里读什么

【本机核实，二进制扫描 2.9.30.28738】+ 2015 SDK 头文件【社区实证：`Mysteryfx/NH90`】对照：

| 层 | 现役符号（本机） | 2015 SDK 对应 | Lua 可达性 |
|---|---|---|---|
| 座舱参数总线 | `ed_cockpit_get_parameter_handle` / `ed_cockpit_update_parameter_with_number`（CockpitBase.dll 53 个 `ed_cockpit_*` 导出；**官方头文件 `API/include/Cockpit/ccParametersAPI.h` 随游戏发布**） | — | Export Lua 里 `get_param_handle(name):set(v)` 可达【本机核实 `Scripts/Export.lua:1319-1329`】；但只服务 trigger/显示，**无雷达航迹语义** |
| 雷达接触点约定 | `<prefix>RADAR_CONTACT_%02d_{RANGE,FRIENDLY,RCS,VX,VY,VZ,RND,NOISE,RCS_COEFF,NCTR}` + `RADAR_STT_{AZIMUTH,ELEVATION,RANGE,FRIENDLY}` + `RADAR_TDC_*`/`SCAN_ZONE_*`（可写控制项） | — | 接触点**只读**；控制项模组可写。数据流单向：设备→寄存器→显示 |
| 武器系统 | `wWeaponSystemManager::assignAutotrackingTarget/assign_target/add_target/getTrackingTarget/IsLockedAndReady`（Weapons.dll 导出表） | `cLauncherRadarTrack::track_missile(missileID,targetID)`（Weapons.dll 现役仍有 `track_missile`） | **无 Lua 绑定**，仅进程内 C++ |
| 在飞导弹 | `WeaponBlocks.dll`：`seeker_target_id`/`seeker_target_pos`/`assignSeekerPoint`；`wAmmunitionGuided` | `IwMissile::setTarget(ObjectID)`、`MissileSetTarget(vec)`、`GuidedWeaponNetMessage{MSG_SET_TARGET_ID｜MSG_SET_TARGET_POINT}` | 无；脚本层 `Weapon` 类全只读 |
| 数据链 | `wRadio.dll`：完整 TADIL-J（`DataAirTrack`、`encrypt/extract_FighterToFighterAirTrack`、`msgPacker/msgParser`、`send_msg/receive_msg`、`get_msgs_gueue` 返回可变 `list<datalink_msg>&`）；`Transport.dll`/`DCS.exe`/`CockpitBase.dll` 同族 | `datalink_msg{senderID,receiverID,targetID,pos,msg_type,param1,param2,orientation,...}`、`IwDatalinkTerminal`、`wNetDatalinkCommunicator`（注释"receive-only"） | 无；进程内可钩（Modern F-15E 已实证只读钩） |

方法学警告：模块 DLL（F16C.dll 等）字符串混淆（79 个 `F16::*` 设备类名 0 命中明文），**引擎 DLL 未混淆**（全量 mangled 导出 + RTTI，PDB 路径泄露但不提供 PDB）。所以对引擎的否定结论是硬的，对模块的"找不到"不构成证据。

## 2. 注入载体：进程内 DLL 比预想便宜得多

【社区实证：`NIGos/dcs-control` 的 `DcsQvCull.lua`】**不需要代理 DLL、不需要改安装目录**：

```lua
-- Saved Games\DCS\Scripts\Hooks\xxx.lua（GUI 状态，我们的 3594 hook 就住在这层）
local dll = lfs.writedir() .. [[Scripts\X\X.dll]]
package.cpath = package.cpath .. ';' .. lfs.writedir() .. [[Scripts\X\?.dll]]
require('X')                        -- luaopen_X
local f = package.loadlib(dll, 'X_Shutdown')  -- 任意导出函数
```

配套实证：ED 自己的 `Scripts/Export.lua:33-35` 注释示范 Export 环境 `require("socket")`；Olympus 的调用栈证明原生 DLL 与任务 Lua 同进程同线程【社区】；DCSRecorder 证明进程内对 `MovingObject::ForcePosition` 的真实写入生效【社区实证】。工程化做法（构建指纹守卫 + IAT 钩 edCore + 版本不匹配安全跳过）在 dcs-control 里有完整范例【社区实证】。

IC/反作弊现实：IC 是服务端配置的文件路径清单哈希比对，**未发现任何内存扫描证据**【社区实证+推断】；安装目录改动会被 manifest.bin/IC 感知，纯内存改动不在其机制范围内（机制描述，非规避建议；本项目仅限单机）。

**风险基准**：DCSRecorder 的位置写入实验显示仿真会**自纠正**（AI 13 秒内把被改的位移拉回）——塞进制导回路的数据可能每帧被内部逻辑覆盖。这是所有写入式注入的核心不确定性。

## 3. 路线 A：Link16 SURV 消息合成注入（唯一"ED 飞机 + 我们的航迹 + 真实中段"路线）

机制链：我们的雷达航迹（10 Hz 世界系，现成）→ 进程内 DLL 构造 `datalink_msg`（伪造一个 donor 的 SURV 航迹，目标 ID 指向真实敌机对象）→ 投递到本机玩家的 `wDatalinkCommunicator`（`receive_msg`/`get_msgs_gueue`/`send_msg` 三处候选注入点）→ Hornet MSI 融合出 SURV 航迹 → 玩家指定 L&S → AIM-120 发射 → 载机 standby 雷达/电台转发中段修正。

- 已实证环节：DLL 入进程（§2）；`receive_msg` 钩点稳定到可以随产品发布（Modern F-15E）；DL-only 航迹发射+中段+命中（MSI 现状，§0.1）；`datalink_msg` 结构有头文件。
- 未证实环节（全部集中在一处）：**合成的 SURV 消息能否被 Hornet MSI 接受为可指定航迹**。需要先从只读观测起步：钩 `receive_msg` 录真实 AWACS 航迹消息 → 推断 `msg_type/param1/param2` 语义 → 回放合成消息。
- 限制：仅 F/A-18C（F-16C 无 MSI）；雷达必须 standby（不辐射但不断电）；SURV 航迹更新节拍慢（实测约 12 s，中段质量受限）；ED 已把"off-gimbal 仍支援"标记为待改进（388967），机制可能在补丁中变动。
- F-16C 变体：无 MSI 则此路不通；除非押注 `wWeaponSystemManager` 写入缝（§4）。

## 4. 路线 B：WeaponSystemManager 原生写入（高风险赌注）

`assignAutotrackingTarget(MovingObject*)` 等函数真实存在于 Weapons.dll 导出表【本机核实】。实验路径：进程内 DLL → 拿到本机 `wWeaponSystemManager*` 与目标 `MovingObject*`（ObjectID→指针无公开文档，是核心未知）→ 只读观测先行 → 尝试指派。预期大概率被 `IsHuman`/`allowAssign` 门禁挡住或语义仅适用 AI。**建议只做一次低成本探测，失败即弃。**

## 5. 路线 C：自定义"大导引头"ARH 克隆弹（雷达可真正完全关机）

- 弹药 schema 全 Lua 可写：导引头 `FOV/sens_far_dist/lock_range_5sqm/gimbal/delay`、`go_active_by_default`、`active_dist_trig_by_default`、loft、近炸引信、发动机【本机核实 `aim120_family.lua`、`j-10a_mils_pl15.lua`】。
- 先例：社区弹药 mod 明示"无需锁定，指向目标方向发射，弹载主动雷达自导"【社区实证：Flanker/F-15C weapons mod v2.x】。
- 我们的雷达贡献：探测/跟踪/发射窗口解算/指向提示（经现有显示层或座舱提示）。导弹离架即自导。
- 风险：制导 scheme 是编译产物（`.sch` 不出现在安装里），只能选不能写；amraam2 scheme 2026-03 报告全灭【社区】；改 `CoreMods` 弹药文件触发 IC/被更新还原——须走 Saved Games 侧模组挂载（Flanker mod 证明可行）。
- 衍生猜想（未验证，值得一次实验）：**激光制导空对空弹 + 脚本激光点跟踪飞机**——若引擎允许 laser-homing 武器攻击空中目标且脚本光斑能跟住飞机，这就是"我们的雷达直接指引武器"的最短路（上一轮 A2 的 A/A 变体）。

## 6. 路线 D：自研模组飞机 + avSimpleRadar（唯一"合法可分发"的完整答案）

- `avSimpleRadar`（CockpitBase.dll 引擎自带类）：引擎做检测物理与 STT；模组 Lua 写 `SCAN_ZONE_ORIGIN_*`/`RADAR_TDC_*` 控制扫描与锁定（锁定命令 509/510）；`avSimpleWeaponSystem` 管发射。SARH 实证（VSN F-4 AIM-7）；ARH 单源声称【社区实证】。
- **我们的 AESA 核心驾驶这个设备**：我们的跟踪器选目标 → 实时算 TDC/扫描中心 → 发锁定令 → 引擎形成 STT → AIM-120 中段走引擎航迹。性质是"我们的雷达是火控决策与传感器前端，引擎雷达是执行器"——引擎会用它自己的 RCS 模型重新检测，我们的包线优势不传递。
- 上限：无 TWS（一次一个锁定）、~300 m 死区、STT 偶发无故断开【社区】。
- 另一模组专属正门：自己的模块实现 `IwDatalinkTerminal`（SDK 类），合法地给自己的飞机供数据链航迹。

## 7. 路线 E：零注入的当代演示（垫底/对照）

- **E1（今天就能做，纯原版）**：AI AWACS 开机当 donor + 玩家 Hornet 雷达 SIL + 指定 SURV 航迹为 L&S + AIM-120 命中。我们的雷达在外部做同样的探测/跟踪/态势显示。**诚实措辞：本机雷达不辐射**。这是验证 MSI 行为与录制对照素材的必做实验。
- **E2（AI 射手漏洞探测）**：`RADAR_USING=NEVER` + `knowTarget` 每秒注入 → AI 僚机是否仍会发射 AMRAAM？发射后导弹有无支援？无公开报告，1 小时实验定生死。若可行则"射手全程静默"成立；若不行，退化为 `FOR_ATTACK_ONLY`（搜索靠我们的雷达，发射瞬间才辐射）【文档：RADAR_USING 语义】。

## 8. 实验阶梯（按成本/信息量排序）

| # | 实验 | 成本 | 决定什么 |
|---|---|---|---|
| X1 | 原版复现 MSI 射击：AWACS donor + Hornet SIL + L&S + AIM-120，Tacview 记录；对照组雷达 OFF | 1 次飞行 | §3 路线前提；获得"不辐射引导"基线素材 |
| X2 | Hooks Lua `require` 探针 DLL（只读：拿模块基址、钩 `receive_msg` 录真实 AWACS datalink 消息） | 数天 | §2 载体 + §3 消息语义 |
| X3 | 合成 SURV 消息回放注入，看 Hornet MSI 是否出航迹、可否指定 L&S | 数周 | **§3 成败点** |
| X4 | AI 漏洞：`NEVER+knowTarget` 会不会发射/命中（对照 `FOR_ATTACK_ONLY`） | 1 小时任务 | §7-E2 |
| X5 | 自定义弹药最小弹（克隆 AIM-120C + active-from-launch + 宽 FOV）在 Saved Games 模组挂载下无锁发射实验 | 数天 | §5 可行性（含 amraam2 现状验证） |
| X6 | 激光制导 A2A 弹猜想：脚本光斑跟飞机 + laser-homing 弹打空中目标 | 数天 | §5 衍生 |
| X7 | `wWeaponSystemManager` 只读观测（拿不拿得到指针/读不读得到 tracking target） | 数天 | §4 去留 |
| X8 | avSimpleRadar 最小白鼠：VSN F-4 打 AIM-7 验证接口；再最小模组机挂 AIM-120 验 ARH | 数天~数周 | §6 前提 |

## 9. 风险与合规（继承两轮调研）

- 进程内注入：仅单机；不分发逆向产物；2015 SDK 头文件是 NDA 泄漏物，**不要编进可分发产物**（只作语义参考）。
- `net.dostring_in` 被 ED 标记 OBSOLETE 并逐步收紧（2025-07 起 allow-list 机制），3594 桥长期迁 `a_do_script`。
- 模块 DLL 混淆意味着 F-16C 内部接口只能靠运行时逆向定位，成本极高——**不建议把 F-16C 定为 A/A 火控演示平台；A/A 用 Hornet（MSI）或自研模组机，F-16C 留给 A/G SPI 主线**（上一轮结论不变）。
- 所有日期敏感结论锚定本机 2.9.30.28738（2026-10-07 build）；MSI 与 AMRAAM 无支援行为都有活跃 bug/改动记录，每个补丁后需回归。

## 10. 关键来源索引

- 本机二进制：`bin/{CockpitBase,Weapons,WeaponsBase,wRadio,WorldGeneral,Transport,WeaponBlocks,Scripting}.dll` 导出表/RTTI/字符串；`API/include/Cockpit/ccParametersAPI.h`；`Scripts/Export.lua:1249-1329`；`Mods/aircraft/F-16C/Cockpit/Scripts/`（device_init.lua:409 FCR=`F16::avRadar_APG68_F16` 原生类；SMS 无 Lua；MFD_FCR_AA.lua:39-41 原生 symbol buffer）。
- MSI/DL-only 发射：ED changelog 2.9.27.24969 / 2.9.28.26283；forum.dcs.world/topic/377564（NineLine MSI 已知问题）；reddit.com/r/hoggit/comments/1u5d7hv；forum.dcs.world/topic/388967、382985。
- 注入载体：github.com/NIGos/dcs-control；github.com/caw1517/DCSRecorder（`docs/research/dcs-native-position-write-experiment.md`）；github.com/verdicaysen/TARPS_Project（edCore Factory 逆向）；github.com/Mysteryfx/NH90（2015 SDK 头：`IwDatalinkTerminal.h`、`wDatalinkCommunicator.h`、`cLauncherRadarTrack.h`、`ammunition_guided.h`）。
- avSimpleRadar 协议：forum.dcs.world/topic/188347（2018 范例贴）、/342798（2024 能力清单）、/353820（FC3 航电寄生问题）；modding.caffeinesimulations.com；github.com/D4n2021/VSN_F4B_C_Standalone。
- 自定义弹药：CoreMods/aircraft/AircraftWeaponPack/aim120_family.lua（sensor FOV 15°、sens_far_dist 30km、gimbal ±60°、delay 1.5s）；forum.dcs.world/topic/385903（自定义 FOX-3 2026-03 损坏）；files.digitalcombatsimulator.com/en/files/3325945（无锁发射自导先例）。

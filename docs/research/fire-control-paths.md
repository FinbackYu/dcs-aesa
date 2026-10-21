# 火控引导路径调研：雷达如何引导机载武器

- 状态：external-reference（2026-10-18 复核）

日期：2026-10-15。性质：外部调研 + 本机核实综合。目标判据（用户提出）：**在游戏内雷达关机的情况下，我们的雷达锁定目标并成功引导导弹**。

> 后续：第二轮攻坚调研（注入/数据链/模组化路径，用户要求继续探索 AIM-120 引导）见 [fire-control-aim120-injection.md](fire-control-aim120-injection.md)。该轮修正本文 §3.4 的措辞：F/A-18C 的 MSI 功能（2.9.19+）已支持"雷达不辐射、纯数据链航迹发射并中段引导 AIM-120"，使"伪造数据链航迹注入"成为 ED 飞机上唯一未证伪的 A/A 路线。

证据分级：【本机核实】= 直接读本机文件/代码；【文档】= ED 官方手册/更新日志/API 文档；【社区实证】= 有可核查的第三方项目或复现报告；【推断】= 无直接证据。

## 0. 结论先行

1. **字面意义的"我们的雷达引导 DCS 导弹"在 A/A 路径上不可达**：DCS 中 AIM-120 中段数据链修正只认**载机自身雷达的航迹**【文档/社区实证】；脚本无法生成、移动、重定向在飞武器（`Weapon` 类全只读 + `destroy()`）【文档】。这不是工程量问题，是仿真机制边界（与 `docs/feasibility.md:140` 的既有判断一致）。
2. **A/G 路径（用户提的 F-16 SPI 方向）真实可达，且全程不需要开雷达**：JDAM/JSOW/WCMD 这类惯性制导弹药直接把 **SPI 坐标当作目标点**飞过去（DCS F-16C 手册 p333/p641【本机核实】）。链路：我们的雷达/SAR 产生武器级坐标 → 坐标注入飞机（有官方 DTC 文件通道和第三方运行时注入先例）→ 成为 SPI → 投放 → 命中。雷达自始至终关机。
3. **还有一条更便宜的演示路径：脚本激光照射**。任务脚本 `Spot.createLaser` + 定时 `setPoint` 可持续照射**运动目标**，玩家 LGB 照此引导（JTACAutoLaze/CTLD 先例【社区实证】）。我们的雷达输出航迹 → 激光跟着目标走 → 玩家投弹命中，雷达关机。这是"雷达关机也能引导武器"的最短闭环。
4. **注入飞机座舱这件事有成熟先例**：DCS-BIOS / fsmapper / DCS-TheWay / DCS-DTC 全部走 `Saved Games` 侧 Lua（Export.lua / Hooks），用 `GetDevice(id):performClickableAction(...)` 按座舱按钮；ED 官方还提供 `a_cockpit_perform_clickable_action` 任务触发动作和 JSON 格式的 `.dtc` 数据卡文件。**F-16C 座舱脚本是明文 Lua**（576 个文件，仅核心逻辑在 `F16C.dll`）【本机核实】。
5. **关键不确定项**（需实机实验，见 §5）：F-16C 的 pickle（武器投放）不是 clickable 元素，脚本能否触发投放存疑；但**投放可以由飞行员自己按**——我们的系统只需把坐标送进去，不要求全自动。

## 1. 路径对比总表

| 路径 | 机制 | 雷达关机可行 | 玩家本机武器 | 成熟度/先例 | 风险 |
|---|---|---|---|---|---|
| **A1. SAR/GMTI 坐标 → F-16 SPI → JDAM/JSOW** | 坐标注入（DTC 文件 / UFC 按键注入） | ✅ 惯性弹药只需坐标 | ✅ | DTC 官方【文档】；TheWay/DCS-DTC【社区实证】 | 注入细节依赖模块版本；需实机验证 |
| **A2. 雷达航迹 → 脚本激光照射 → LGB** | `Spot.createLaser`+`setPoint` 跟踪 | ✅ | ✅（激光弹） | JTACAutoLaze/CTLD【社区实证】 | 需要目标在激光编码匹配；AI 投的 LGB 是否认脚本光斑未验证 |
| **A3. 雷达航迹 → AI 射手（AttackUnit/Bombing/knowTarget）** | 任务脚本 AI 任务 | ✅（玩家雷达关；射手自己的雷达开） | ❌ 是 AI 的武器 | MOOSE AI_A2A_DISPATCHER【社区实证】 | 不满足"机载设备"字面要求；适合垫底演示 |
| **B1. A/A maddog 提示发射** | 雷达关 → AIM-120 离架即主动（~10nm 锥） | ✅ | ✅ | Hoggit/ED 模式存在【文档】 | 我们的雷达只做"探测+几何提示"，导弹自导引；"引导"成色低；2020 年 ED 已知问题条目悬而未决 |
| **B2. A/A 中段数据链注入** | 把我们的航迹喂给在飞 AMRAAM | — | — | **无通路**【文档+社区实证】 | 引擎边界，排除 |
| **C. 自研模组飞机（Lua 航电）** | A-4E-C 模式：自己的雷达设备+武器系统 | ✅ | ✅ | A-4E-C【社区实证】 | 工作量最大；单位探测需真值桥（我们已有）；源码 All Rights Reserved 不可抄 |

**推荐顺序：A2（最快验证"关机引导"）→ A1（用户点名的 SPI 主线）→ B1（A/A 提示发射演示）→ A3（垫底）。C 作为长期可选。**

## 2. 我方现有条件（本机核实，来自集成面测绘）

- 雷达核心输出：确认航迹含**世界系 pos/vel**、`R/az/el/vr`、`confirmed`，实飞管道有效输出 **10 Hz**（`src/aesa/tracker.lua:104-111`、`src/export/aesa_export.lua:10`）。
- 已有通道：
  - 3590 下行（Export→外部，只读）；
  - **3592 双向**（外部→Export Lua 环境，命令面受限，故意只读）；
  - **3594 双向 → `net.dostring_in` 任务环境**（唯一能"动手"的层：可触达 `world/land/timer` 及整个任务脚本 API；`src/hooks/aesa_sar_scene_hook.lua`）。授权已在 autoexec.cfg 就位。
- `core.set_stt(id)`（`src/aesa/core.lua:23`）是现成的"锁定"语义缝，但目前不产生对外可见输出。
- 缺口：核心无对地模式（调度器只有 search/track/stt）；跟踪器按设计压制慢速地面目标（`config.lua:86` slow_mover_ms=25）；SAR 产物（坐标/目标清单）全部停在外部浏览器层，无回写。

## 3. 关键机制细节

### 3.1 F-16C SPI（A1 主线）

- SPI 同一时刻只有一个来源：MMC（航路点/瞄准点/各种光标）或某个处于跟踪态的传感器（FCR A-G 的 FTT/MTT、TGP 点/区域跟踪、HTS）【本机核实：F-16C 手册 p332-334】。
- **HMCS 产生的是 markpoint 不是 SPI**；数据链收到的是 markpoint（HSD 上的"X"）。
- **惯性弹药直接吃 SPI**："the SPI will be transferred to the weapon guidance unit as the target location"（p333）——JDAM PRE 流程 HUD 显示的就是"当前 SPI，炸弹将飞往的位置"（p641）。
- 数据链 SPI/markpoint 分享在 DCS 2.7.11（2022-02）已实装【文档：ED changelog】，但仅限模拟内单位产生——外部无法伪造 TNDL 航迹。
- 坐标注入候选通道（按"正规程度"排序）：
  1. **官方 DTC 数据卡**：`.dtc` 是 **JSON**，分区含 DEST PTS（81-99）/THRT PTS（56-70）；`MissionEditor/modules/me_managerDTC.lua:477-640` 有 `ImportFromJSON/ExportToJSON`【本机核实】。飞行员经 DTE 页面上载。完全官方、抗更新、MP 合法；缺点是地面/战前加载动作。
  2. **运行时 UFC 按键注入**：`GetDevice(17):performClickableAction(ufc_commands.DIG*, 1/0)` 模拟 ICP 打字输入航路点/目标点。Modern F-15E 模组已在 F-15E 上实证此模式（UFC_DEV=56、读回校验、"只写空槽"安全规则）【社区实证】；DCS-TheWay/DCS-DTC 对 F-16 同理【社区实证】。
  3. **ME 触发动作 `X: COCKPIT PERFORM CLICKABLE ACTION`**：ED 官方"训练/自动化脚本"用途；社区有用 `net.dostring_in('mission', '_G.a_cockpit_perform_clickable_action(...)')` 配置 F/A-18C 座舱的完整演示【社区实证：ED forum 355010】。
- 硬限制：F-16C 的 **HOTAS（TMS/DMS/COMM/投放）不是 clickable 元素**（`clickabledata.lua` 322 项里 0 个 HOTAS）【本机核实】；TMS Forward（传感器跟踪/SPI 指定）能否经 `GetDevice(16):SetCommand(hotas_commands.*)` 触发是**头号待验证实验**。若不行，退路是飞行员自己按 TMS——我们的系统只负责把坐标送成航路点/目标点，人工完成最后一步指定，仍然满足判据。
- pickle（STICK_WEAPON_RELEASE）同理不可脚本化概率大；但判据不要求自动投放。

### 3.2 脚本激光照射（A2 快线）

- `Spot.createLaser(source, localRef, point, code)`（code 1111-1788）产生的光斑**能引导激光制导武器**；`Spot:setPoint` 每 0.5s 重指运动目标是 wiki 自己的示例模式【文档：Hoggit wiki】。
- JTACAutoLaze（ciribob，已并入 CTLD）就是"脚本持续照射 + 玩家 TGP 搜激光光斑"的成熟工作流【社区实证】。
- 我方链路：雷达航迹（10 Hz 世界系）→ 3594 桥 → 任务侧每帧/定时 `setPoint` → 玩家 LGB。运动目标、雷达关机、真实命中，全部覆盖。
- 未验证：AI 投放的 LGB 是否认脚本光斑；脚本光斑对 TGP LSS 的可见性是社区证据非 ED 文档。

### 3.3 AI 射手（A3 垫底）

- `AttackUnit` 任务自带"目标对被控组自动可见"；`Missile Attack` 选项控制 BVR 发射距离；`Controller:knowTarget` 可直接把目标塞进 AI 感知【文档：Hoggit wiki】。
- 端到端"我们的雷达→真实导弹→真实命中"最容易做，但武器不是玩家的，不满足用户判据的字面要求；适合做兜底演示和回归测试环境。

### 3.4 A/A 为什么字面不可达（B2 排除依据）

- AIM-120 中段："Datalink is supported in RWS, TWS and STT… If the target trackfile is lost prior to this point, the missile goes Active prematurely"（Hoggit F/A-18C【文档级】）；ED 论坛 SME："mid course updates for an AIM-120C5 requires your radar to be emitting"【社区实证】。
- `Weapon` 脚本类全只读；无 spawn API（`coalition.addGroup` 无武器类别）；无移动单位 API（MIST 传送 = 销毁+重建）【文档】。
- SARH（AIM-7/R-27）要全程 STT 照射，脚本无法注入照射【文档】。
- 现代 F-15E mod 里发现的 `wDatalinkCommunicator` 引擎符号钩子是**只读**的（其自述"Read-only; counts + first bytes only"）【本机核实】——能否写入合成航迹未验证，是唯一理论缝隙，但属二进制逆向方向，不建议押注。
- 结论：A/A 方向最多做 B1（maddog 提示发射：我们的雷达是回路里唯一传感器，负责探测/跟踪/发射几何提示，导弹离架后自导）。2025 年有 bug 报告称无支持的 AMRAAM 不退化【社区】，若属实则"唯一传感器"的论证价值打折，需自测。

### 3.5 自研模组飞机（C 长期）

- A-4E-C 证明：免费模组可以纯 Lua 写真实雷达仿真（`RADAR/apg53a.lua`，1405 行，地形射线 + 高斯波束蒙特卡洛），武器释放走标准 iCommand（`weapon_system.lua`），ED 导弹保持 ED 制导（`A4E_Weapons.lua` 用 ED 导弹 schema）【社区实证，源码可读但 All Rights Reserved，不可复用】。
- 公共 API **没有雷达/传感器接口**（`API/include/FM/wHumanCustomPhysicsAPI.h` 纯物理）【本机核实】；A-4E-C 的单位探测靠逆向（作者自述公开该技术违反 ED EULA）。**我们的真值桥恰好绕开这个缺口**——这是我们的架构优势。
- 此路径=自己造一架飞机，工作量最大，但火控完全自主。适合作为"阶段四之后"的可选方向。

## 4. 推荐的里程碑阶梯

- **M1（回写闭环，1 个迭代）**：3594 桥加一条校验过的火控命令（如 `FC_MARK,<id>,<x>,<z>`），任务侧生成 F10 标记/目标清单。验证"雷达指定 → DCS 世界可见动作"。不动安装目录。
- **M2（首次"关机引导"演示）**：M1 + `Spot.createLaser`/`setPoint` 跟踪雷达航迹 → 玩家 F-16C 投 LGB 命中。全程雷达关机。**这可能就是判据的首次达成**。
- **M3（SPI 主线）**：坐标 → F-16C 座舱。先做 DTC JSON（DEST PTS）验证 JDAM 打目标点；再做运行时 UFC 注入（T1/T2 实验先行）。验收：雷达关机，SAR/GMTI 出坐标，JDAM CCRP 命中。
- **M4（A/A 演示）**：maddog 提示发射实验（先实测雷达关时 AMRAAM 真实包线），或 AI 僚机射手垫底。
- 全程约束：不改安装目录（除非走 3b/3c 既有 OvGME 规则）；autoexec 授权保持最小；`net.dostring_in` 有被淘汰趋势，迁移到 `a_do_script`（ED 官方推荐，2.9.13+ 支持返回值）。

## 5. 待实机验证清单（按价值排序）

| # | 实验 | 预期 | 决定什么 |
|---|---|---|---|
| T1 | Export 侧 `GetDevice(17):performClickableAction(DIG1,1)` 按 F-16C ICP，看 DED | 成功 | 注入层在本机有效（M3 前提） |
| T2 | `GetDevice(16):SetCommand(hotas_commands.STICK_TGT_MANAGE_UP,1)` | 未知 | TMS 能否脚本化（M3 自动化上限） |
| T3 | 任务侧 `a_cockpit_perform_clickable_action` 对玩家 F-16C | 未知 | 最"官方"的运行时注入是否可用 |
| T4 | `.dtc` JSON 写入 DEST PTS → DTE 上载 → JDAM 打该点 | 成功 | M3 官方通道 |
| T5 | `LoSetCommand(350/84)` 对 F-16C（对照 FC3 F-15C） | F-16C 无效/FC3 有效 | 遗留命令表死透没 |
| T6 | 脚本激光跟踪运动目标 + 玩家 LGB | 成功 | M2 主线 |
| T7 | AI 投放 LGB 是否认脚本光斑 | 未知 | M2 扩展 |
| T8 | 雷达关 maddog AMRAAM 真实锁定锥/距离；无支持 AMRAAM 是否退化（复现 2025 bug 报告） | 未知 | M4 成色 |

## 6. 顺带发现（移交维护）

- `Saved Games\DCS\Config\autoexec.cfg` 实际白名单比根 AGENTS.md 记录的宽（两个表都含 `scripting`），且不含 `gui`——要驱动 GUI 侧（DTC 管理器在 GUI Lua）需另行授权。
- 本机安装目录里装有 C130J 模组（`Mods\aircraft\C130J`）——装在游戏目录而非 Saved Games，A-4E-C README 明确警告这会触发授权错误/IC 失败；后续部署工作前留意。
- 2026-10-01 时间戳的 `Scripts/Export.lua` 含 avDevice/座舱触发 API 文档块，与仓库文档引用行号一致，大概率是 ED 更新带入，但未能证明非本地改动——依赖前再核。

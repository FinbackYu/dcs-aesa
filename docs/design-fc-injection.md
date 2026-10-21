# 火控原生注入线设计（AIM-120 引导攻坚）

- 状态：historical（2026-10-18 归档）

> 本文记录 2026-10-15 的设计与实验路径；**现役实现已由 Gate 6 改为 `aesa_fc_trace.dll`（只读，默认）/`aesa_fc_inject.dll`（写，显式 `--with-inject`）**。当前安全边界与加载策略以 [AGENTS.md](../AGENTS.md) 的 `fc_probe` 一节为准，本文的 `dist/dev/aesa_fc.dll` 等路径不再现役。

日期：2026-10-15。调研依据：[fire-control-aim120-injection.md](research/fire-control-aim120-injection.md)。本文是实施侧设计，随实验进展更新。

## 1. 目标与判据

让我们的 AESA 雷达航迹成为 **F-16C** 的 AIM-120 火控源（用户 2026-10-15 明确平台约束：为 F-16 做 AESA，F-16 用 AESA 引导 AIM-120），表现与原生火控雷达等效：玩家在我们的雷达上锁定目标 → 发射 AIM-120 → 导弹获得中段修正 → 命中机动目标。全程本机 FCR 零辐射或不工作（FCR OFF）。

## 2. 路线（按 F-16 约束重排）

F-16C 无 MSI（不能像 Hornet 那样对纯数据链航迹发射），因此路线收敛为两条：

1. **武器系统缝（主攻）**：引擎侧 `wWeaponSystemManager::assignAutotrackingTarget` / `wWeaponSystem::track_missile` / `wAmmunitionGuided::setTarget` 全部在 Weapons.dll 导出表且与机型无关（武器是引擎对象）。若玩家机的武器系统接受外部指派的目标关联，中段修正可绕过 FCR 航迹——这是唯一可能实现"FCR **完全断电**也能引导"的路线，且模块无关（F-16/F-15/任何机型通用）。
2. **数据链显示层注入（辅助）**：向 F-16 MIDS 注入 TNDL 航迹只能进 HSD 显示（PDLT 不能发射），可作提示手段，不构成火控。
3. **Hornet MSI 路线降级为参照**：其 SURV 消息语义与"offboard 航迹→发射"行为仍是阶段三合成消息的语义来源；若主攻缝失败且用户接受换机型，随时可回退。

阶段二的目的因此改为：**先用只读追踪摸清 F-16C 打 AIM-120 时引擎侧的完整调用链**（谁调用 track_missile/setTarget/assignAutotrackingTarget、何时调、参数是什么），再决定注入点。

## 3. 载体（已选定）

**Saved Games Hooks Lua + `package.loadlib` 载入自研 DLL**（先例：dcs-control/DcsQvCull）。不改 DCS 安装目录；IC 不涉及内存态。工程纪律继承 dcs-control：构建指纹守卫，版本不匹配安全跳过。

- 探针：`src/native/fc_probe/aesa_fc.c` → `dist/dev/aesa_fc.dll`（mingw-w64 gcc，全静态链接，kernel32/version 之外零依赖）。
- 加载器：`src/hooks/aesa_fc_hook.lua` → 部署为 `Scripts/Hooks/aesa_fc_hook.lua`。
- 部署：`scripts/install_fc_probe.cjs`（install/repair/uninstall/verify，清单+备份，同 SAR 系列约定）。
- 构建：`scripts/build_fc_probe.cjs`（工具链：工作区 `.tools/mingw-root`，`bootstrap_mingw.py` 组装）。
- 日志：`Saved Games\DCS\Logs\AESA\fc_native.log`（行缓冲）。

## 4. 阶段划分

### 阶段一：载体验证（本轮交付）
- DLL 经 hooks 载入 DCS 进程；解析并记录 17 个关键引擎符号（wRadio 数据链收发、Weapons 武器系统、WorldGeneral 对象/数据链终端、CockpitBase 参数总线）；记录模块版本指纹；迟解析重试（引擎 DLL 可能晚于 hook 加载）。
- 验收：DCS 启动后 `fc_native.log` 出现且符号全部 resolved。
- **红线：本阶段不写任何游戏状态、不安装任何钩子。**

### 阶段二：只读观测（本轮交付）
- MinHook（BSD-2，已 vendor 进 `src/native/third_party/minhook/`）只读钩七处引擎函数，记录"F-16C 打 AIM-120"的完整引擎调用链：数据链收发（`receive_msg`/`send_msg`）、武器系统目标指派（`assignAutotrackingTarget`）、导弹-目标关联（`track_missile` ×2）、在飞导弹目标更新（`setTarget`）。每条记录含 this 指针、RTTI 动态类名（引擎类未混淆，可现场打印真实类名）、参数与消息 hex dump；线程安全、限频、行缓冲，绝不写仿真状态。
- 配套任务：`scripts/make_fc_trace_mission.py` 生成 `AESA-FC-Trace-Caucasus.miz`（F-16C 空中起步朝东 + E-3A AWACS + 2× MiG-29A 40km 对冲）。
- **验收达成（2026-10-16 实飞）**：`fc_trace.log` 完整录下两发 AIM-120 的目标指派序列。注入点由观测确定（见 §4a）。

### 阶段三：注入点实验（顺序由阶段二观测决定）

#### 4a. 实飞观测结果（2026-10-16，`fc_trace.log` 铁证）

两发 AIM-120 的 `setTarget`（`wAmmunitionGuided::setTarget(ObjectID)`，Weapons.dll）序列：

| 时间 | 弹体 this | 类（RTTI） | target | 解读 |
|---|---|---|---|---|
| 18:08:51.812 | 0x…7280 | wAmmunitionSelfHoming | **16779264** | 第一发（雷达开）发射瞬间指派目标 |
| +0.001s | 0x…7280 | 同上 | 0 | 短暂清零 |
| 18:08:53.791 | 0x…7280 | 同上 | **16779264** | **+2s 再次指派——这就是中段修正的实际调用** |
| 18:09:06.653 | 0x…d870 | wAmmunitionSelfHoming | 0 | 第二发（FCR 关 maddog）发射：无目标 |
| 18:09:08.217 | 0x…d870 | 同上 | **16779008** | +1.5s 导引头自捕获后写入目标 |
| 后续 | 两弹 | — | 0 | 命中前后清零 |

关键结论：
1. **F-16 模块发射时根本不调 `track_missile`**（发射时刻无任何 TRACK_* 调用；之前录到的全是 AI 地面单位噪音）——`track_missile` 路线排除。
2. **F-16 的中段链路 = 直接对飞行中的弹体调 `setTarget(ObjectID)`**：发射瞬间指派、约 2 秒后再次指派（中段更新）。这就是我们要的注入缝——函数地址可从导出表解析、弹体指针可被钩子实时捕获（每次发射都触发 setTarget）、目标 ID 与我们真值数据（Export V1 的对象 ID）同编号体系。
3. maddog 弹的 `setTarget(0)` → 自捕获 → `setTarget(id)` 序列证明：弹体接受飞行中的外部目标指派（导引头本身就这么用它）。

#### 4b. 阶段三实验设计（首次写入仿真状态，单机）
- **实验 P3-1（已飞三次，结论已出）**：maddog 场景下把 `setTarget(0)` 改写为我们指定的僚机 ObjectID。结果：**改写全程持续生效**（引擎每帧清空、我们每帧改写，单弹最多 1.3 万次覆盖整个飞行），shot/kill 事件的归属随之指向僚机——**但导弹弹道不跟随指定目标**（v5 大间距实验：导弹从不转向指定机）。结论：`setTarget(ObjectID)` 是**记账字段**（shot 事件关联、BDA 归属），不是中段制导输入。第一飞的僚机命中判定为导引头 500m 间距下的自捕获侥幸。

  > **批注（2026-10-17，推翻上述结论）**：后续 OBJD 内存观察实验证明 `setTarget` 指定**就是中段制导输入**——指定后导弹每帧自读目标对象实时位置刷新 `wGP_AMRAAM+0x220`（目标相对矢量），全程连续跟踪指定机直至命中（机头对 15km 外非目标机、FCR 关，排除自捕获侥幸）。"弹道不跟随"系当时无内存观测手段下的误判：中段跟踪真实存在，只是**纯追踪律**（无前置量），目视上弹道不迎头、俯冲晚，被误读为"不跟随"。v4/17:10 两次命中也均为指定机制。且 +0x220 可由外部每 tick 写入前置拦截点（lead feed），纯追踪由此升级为前置追踪（中段末脱靶角 0.58°→11.87°），弹道形态与原生支援弹一致。字段测绘（2.9.30.28738）：G+0x1a8=弹位置(Vec3d)、+0x1c0=弹速度、+0x170=飞行时间、+0x178=初始距离、+0x180=目标距离、+0x220=目标相对矢量。详见 `worklog/2026-10/2026-10-17_2022_火控引导全链路闭环与开源抽象清单.md`。另：下节 P3-3 规划的 `MovingObject::GetPosition` 弹体轨迹方案已证伪——该虚函数对弹药类对象会解引用 NULL 子指针直接崩溃（2026-10-16 发射瞬间崩游戏实证），轨迹记录已改走任务态公共 API + OBJD 内存重建。
- **实验 P3-2（已飞，决定性数据在手）**：雷达开支援弹全程，AMRAAM 的制导处理器 `wGP_AMRAAM` 在弹上持续运行（`controlGuidanceMode`/`calcInertialGuidance` 每帧 200Hz），终端段 `calcTerminalGuidance` 在发射后 ~49s 启动。`assignTargetPoint` 只出现一次（vec=0,0,0，发射初始化）。**中段坐标不经过任何导出函数**——高度疑似发射模块（F16C.dll）直接按字段写弹体/GP 对象内存。
- **下一步（P3-3）**：弹体轨迹记录器（在 200Hz setTarget 上以 ~5Hz 记录弹体世界坐标，符号 `MovingObject::GetPosition` 已在导出表）——重建弹道以区分"中段被我们的指派转向"与"导引头末段自捕获"。再往后：对 GP/弹体对象的目标字段做内存观察（硬件断点或轮询读）定位真正的中段输入。

### 阶段四（远景）
- 与 AESA 核心闭环：锁定入口（`core.set_stt`）→ 注入航迹质量分级 → 发射窗口解算 → 提示玩家。
- 合规红线不变：仅单机、不分发逆向产物、不使用 2015 SDK 头文件编译产物（只作语义参考）。

## 5. 版本脆弱性管理

- 所有符号按导出表名字解析（`GetProcAddress`），不硬编码 RVA；模块版本指纹（FileVersion）随日志记录，不匹配预期版本时只告警不阻断（探针阶段）。
- 每补丁后回归：`node scripts/build_fc_probe.cjs` 重验 + 实机一次。

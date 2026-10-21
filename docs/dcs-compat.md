# DCS 版本耦合面与兼容层

- 状态：current
- 日期：2026-10-18
- 适用代码：`refactor/architecture-gates`（2026-10-18 由 `codex/sar-airport-mapping` 改名），基线 tag `pre-arch-refactor`
- 开发机基线：DCS `2.9.30.28738`（x86_64，MT，Steam 版），活动 Saved Games 为 `%USERPROFILE%\Saved Games\DCS`
- 依据：`docs/refactor-plan.md` Gate 0 第 6 项、Gate 3；本机源码、Saved Games 日志、录制文件和 DCS 安装目录只读核查

本文最初是 Gate 0 的兼容性盘点与 Gate 3 的设计合同。Gate 3 的**离线层与实机层**均已完成：profile spec/生成物、`profile.lua`、`probe.lua`、`api/*.lua`、`dcs_profile.h`、`compat_check.cjs` 已落地；2026-10-18 实机 probe 达到 **level B**（required 全 ok），Export/SAR/Scene 消费者已切换到 `AESA_RUNTIME` 并通过烟测，`COMPAT` 握手生效。Gate 4 已完成 A/A 边界迁移（`src/core/` + `src/adapters/dcs/{frame,truth_replay,rcs,rcs_data}.lua`）。本文给出的路径、字段和检查项不得静默改名。

---

## 1. 结论

1. **耦合面比“调用 LoGet*”更宽。** 除 Export API 外，还有任务沙箱、Hooks 生命周期、LuaSocket 自举、Saved Games 目录选择、RCS 生成物、`radar.fx` 参考常量，以及 `Inter.dll` / `edterrain4.dll` / `Weapons.dll` 的原生符号、vtable 槽位和结构体偏移。
2. **运行时 build 闸门已建立到 profile/ABI，但原生自检尚未全部接入。** profile spec/生成物、`probe.lua`、`compat_check` 与 `dcs_profile.h` 已可校验 build/能力/符号；原生 `aesa_profile_check()` 仍是 Gate 6 工作。`docs/status.md:79`（文件已标 historical）仍写 `2.9.29`，与当前安装和原生日志的 `2.9.30.28738` 已经漂移。
3. **已有可复用的降级雏形，但分散且不完整。** `terrain.GetHeight` 缺失会让 SAR 拒绝采集（`src/export/aesa_sar_export.lua:168,193`）；`net.dostring_in` 失败会退回 `a_do_script` 或报 `CAP,unavailable`（`src/hooks/aesa_sar_scene_hook.lua:23-51`）；但这些判断没有统一的能力矩阵，也没有统一返回给外部工具。
4. **已确认并修复一处真实字段错配（Gate 1）。** 历史录制文件的首帧探针明确列出 `CoalitionID:number`，但 Gate 0 的 T 行写的是 `obj.coalition or obj.Country or obj.country`；flight3/flight9 中 Su-25 的阵营被录成 `0`、F-16 被录成 `2`，这是 `Country`，不是 `CoalitionID`。现 Export 只读 `CoalitionID`，缺失/非法输出 `unknown`。
5. **A/A 目标对象仍无 velocity 字段。** `LoGetSelfData`/`LoGetWorldObjects` 的对象结构不含 velocity；flight3/flight9 的历史 A/T 行速度全为 `0.000`。现本机速度走 `LoGetVectorVelocity`，目标速度缺失时 `vel_valid=false`，接收端可差分估计但不得标成有效。SAR 路径同样单独使用 `LoGetVectorVelocity`（`src/export/aesa_sar_export.lua:349`），两条数据源不能互相假定。
6. **原生 ABI 是最高风险面。** agradar 依赖 `edterrain4.dll` 的 `vtable[19]` 和 `PointOnSurface +0x38`；fc_probe 依赖 13 个 mangled 导出、MSVC RTTI 布局和 `wGP_AMRAAM +0x1a8/+0x1c0/+0x220`。任何一项变化都可能从“返回 nil”升级为“调用错函数/写错内存”。

### 1.1 兼容等级

| 等级 | 判定 | 允许的动作 | 退出码 |
|---|---|---|---|
| A 完全兼容 | 所有 required 能力为 `ok`；原生 profile 的模块 hash、符号、vtable/offset 全部匹配；无新增 unknown | 正常启用全部功能 | 0 |
| B 降级 | required 能力仍为 `ok`；一个或多个 optional 能力 `degraded/unavailable`，且已有明确降级路径 | 只启用能力矩阵允许的功能；页面/日志明示原因 | 2 |
| C 不兼容 | required 能力缺失且无安全降级；原生 profile 不匹配；vtable/offset 无法验证；probe 缺失或过期 | 停用 SAR/注入/任务桥等受影响功能，只保留只读或完全停用；不继续迁移 | 3 |
| blocked | 没有可用 probe 证据、DCS 不可启动、日志缺失 | 不判 Green；记录 blocked 原因 | 4 |

### 1.2 Gate 3 实现状态（2026-10-18）

| 交付物 | 状态 | 证据 |
|---|---|---|
| `spec/dcs_profiles/*.json` | 已实现 | `dcs-2.9.30.28738-mt.json`、`dcs-generic.json` |
| `profile.lua` / 生成 profile | 已实现 | `src/adapters/dcs/compat/profile.lua`、`profiles/*.lua` |
| `api/{export,mission,hook,native}.lua` | 已实现（离线 stub 测试） | `tests/test_gate3_api.py` |
| `probe.lua`（39 能力） | 已实现；实机已运行 | `tests/test_gate3_probe.py`；2026-10-18 probe level B |
| `dcs_profile.h` | 已生成 | `scripts/gen_config.cjs --check` |
| `compat_check.cjs` | 已实现（fixture A/B/C/blocked） | `tests/test_gate3_compat_check.cjs` |
| 一次性部署 | 已实现：构建时打成一个 `dist/dev/aesa_compat_probe.lua`；安装器只写 Saved Games 一个文件 + Export 标记块 | `scripts/build_compat_probe.cjs`、`scripts/install_compat_probe.cjs` |
| 实机 probe 日志 / 基线 | **已完成（level B）** | `Saved Games/Scripts/AESA/probe-export.log`、`probe-hook.log`；`tests/baseline/compat.json` |
| export/scene/hook 消费者切换 | **已完成** | `AESA_RUNTIME`；实机烟测 A/A 313 帧 / 32.6 s、SAR `connected; height=true surface=true`、scene `CAP,land.getSurfaceType,world.searchObjects` |
| `COMPAT` 握手 / `/state.compat` | **已完成** | `src/export/aesa_export.lua`、`tools/live.py`、`profile.lua` |

Gate 3 判定：实机 probe level B（required 全 ok），消费者切换与烟测通过；profile/能力矩阵作为后续 Gate 的兼容基线。

“required”不是全局固定集合，而是按功能定义：A/A 真值采样 required 的是 `LoGetSelfData`、`LoGetWorldObjects`、`LuaExportAfterNextFrame`；SAR 还 required `terrain.GetHeight` 和 `LoGetVectorVelocity`；场景桥 required `net.dostring_in` 或 `a_do_script` + `land.getSurfaceType` + `world.searchObjects`；原生写路径 required 完整 profile。

---

## 2. 环境模型

同一份“游戏 API”在不同 Lua 状态里并不等价。兼容层必须先知道自己在哪个状态，再判断能力。

| 状态 | 进入方式 | 可见的典型全局 | 不可见/不可假定 | 本项目入口 |
|---|---|---|---|---|
| Export | `Saved Games\Scripts\Export.lua` 的标记块 `dofile` | `LoGet*`、`io`、`os`、`lfs`、`require`、`package`、`LuaExport*` 回调 | `world`、`land`、`Object`、`Unit`、`timer`、`DCS.setUserCallbacks` | `src/export/aesa_export.lua`、`src/export/aesa_sar_export.lua` |
| 任务脚本（mission scripting） | 任务加载时执行；本项目经 `a_do_script` / `net.dostring_in` 注入 | `land`、`world`、`Object`、`Unit`、`timer`、`coord`、`net`（部分权限） | `io`、`os`、`require`、`package.loadlib`、`LoGet*`、`DCS.setUserCallbacks` | `src/scene/aesa_sar_mission.lua`、`src/hooks/aesa_sar_scene_hook.lua` 注入的源码 |
| Hooks | `Saved Games\Scripts\Hooks\*.lua` 启动加载 | `DCS`、`lfs`、`io`、`package.loadlib`、`net`（可能）、`os` | `land`、`world`、`LoGet*` | `src/hooks/aesa_fc_hook.lua`、`src/hooks/aesa_agradar_hook.lua`、`src/hooks/aesa_sar_scene_hook.lua` |
| GUI / MissionEditor | 游戏 UI 内部 | 大量内部 API | 不是 Export/任务状态；不作为产品接口 | 未使用 |
| 外部进程 | Python/Node/C | 无游戏 API | 全部游戏状态只能经 Export/桥接/原生 DLL | `tools/`、`scripts/`、`src/native/` |

因此 probe 必须分状态输出能力；`profile.lua` 不能把 Export 的 `LoGetSelfData` 能力当成任务态的 `land.getHeight` 能力。

---

## 3. 版本耦合面清单

每项给出六个字段：当前位置、依赖内容、失效表现、检测方法、降级策略、修复入口。检测 ID 对应 `scripts/compat_check.cjs` 的输出键。

### 3.1 Export 环境与回调 quirk

#### C-01 Export.lua 加载块与共存

| 字段 | 内容 |
|---|---|
| 当前位置 | `scripts/install_export.py:19-25`（AESA 块）、`:42-44`（目标路径）、`:84-102`（标记校验）、`:178-214`（安装/回滚）；`scripts/install_sar.cjs:6`（SAR 块）、`:9`（路径）。实际部署文件 `Saved Games\DCS\Scripts\Export.lua:1-16` 同时含 AESA、SAR、SRS 三段。 |
| 依赖内容 | `lfs.writedir()` 解析 Saved Games；`dofile` 加载 `Scripts\AESA\aesa_export.lua` / `Scripts\AESA-SAR\aesa_sar_export.lua`；BEGIN/END 标记独占一行；保留用户已有内容与换行/BOM。 |
| 失效表现 | 标记重复/残缺时拒绝写入；`dofile` 路径错则整块静默不加载（只有 `log.write`）；两个安装器各自追加，顺序决定回调包裹顺序；SRS 等工具先加载 `socket` 时本项目“白捡”，独立部署时必须自举。 |
| 检测方法 | `EXP-LOAD`：`export_block_present`、`export_marker_count`、`dofile_target_exists`、`load_order`、`export_file_encoding`；安装器 `verify` 已做标记和 hash 校验。 |
| 降级策略 | 标记异常时保留现场、不写入，报告 `export_load=invalid`；目标文件缺失时 `export_load=unavailable`；不尝试猜测损坏块的结束位置。 |
| 修复入口 | `scripts/install_common.cjs`（Gate 6 统一）、`scripts/install_export.py`、`scripts/install_sar.cjs`；兼容层只读取 `EXP-LOAD` 结果。 |

#### C-02 LuaExportAfterNextFrame

| 字段 | 内容 |
|---|---|
| 当前位置 | `src/export/aesa_export.lua:331-341`（包裹并驱动 `frame_poll`）、`:232-234`（为何不用 ActivityNextEvent）；`src/export/aesa_sar_export.lua:386-390`（SAR 版包裹）。 |
| 依赖内容 | DCS 在每帧渲染后调用该全局；回调可以被链式包裹；每帧调用次数/时机不保证固定；本项目用它做 10 Hz 限频采样。 |
| 失效表现 | 回调不再被调用或被其他工具覆盖：无 A/T 行、无 `FRAME alive`、无 TCP 连接；`export_diag.log` 停在旧时间；SAR 完全无帧。若回调内抛错，未 pcall 的邻居会中断整条链。 |
| 检测方法 | `EXP-AFTER`：`callback_present`、`callback_called`（探针帧计数器）、`frames_per_second`、`last_frame_age_s`；对照 `export_diag.log` 的 `FRAME alive #N`。 |
| 降级策略 | 回调缺失 → `sampling=unavailable`，不假装 10 Hz；ActivityNextEvent 只做透传，不作为采样源；如果两路都不可用，A/A 与 SAR 明确不可用。 |
| 修复入口 | `src/adapters/dcs/api/export.lua`（Gate 3）；`profile.callbacks.after_next_frame`。 |

#### C-03 LuaExportActivityNextEvent

| 字段 | 内容 |
|---|---|
| 当前位置 | `src/export/aesa_export.lua:314-329`（链式包裹、异常时 `t+0.5`）；`:316-317` 注释明确“实测本环境下 DCS 会在任务加载完成后停调本回调，不可依赖”。 |
| 依赖内容 | DCS 按返回的仿真时间再次调用；返回值必须是有限 number，且不能小于当前 `t`；邻居回调可能抛错。 |
| 失效表现 | 若采样依赖它：任务加载后采样停止；若返回值非法：DCS 可能不再调度或行为异常；若邻居抛错：链中断。当前代码只透传，因此失效表现为“无害但也不提供驱动”。 |
| 检测方法 | `EXP-ACT`：`callback_present`、`callback_return_type`、`callback_observed_after_mission_load`；探针只记录观察，不强制调用。 |
| 降级策略 | 只保留透传；对邻居返回值做 `type/nan/范围` 校验并夹到 `t+0.5`；任何采样都不依赖本回调。 |
| 修复入口 | `src/adapters/dcs/api/export.lua`；`profile.callbacks.activity_next_event`。 |

#### C-04 Export 回调链、重复加载与生命周期

| 字段 | 内容 |
|---|---|
| 当前位置 | `src/export/aesa_export.lua:19`（`AESA = AESA` 实际只赋值给局部变量，**不是**全局重复加载防护；重复加载防护由 `:2` 所述加载块负责）、`:299-313`（Start/Stop 包裹）、`:234-288`（`frame_poll` 状态机）；`src/export/aesa_sar_export.lua:377-391`（独立包裹）。 |
| 依赖内容 | `LuaExportStart` / `LuaExportStop` 在任务开始/结束时调用；同一进程内可能重复 `dofile`；多个 Export 工具可能各自包裹；全局名可能冲突。 |
| 失效表现 | 重复加载 → 两套 `AESA` 状态、两次连接、重复行、连接抖动；`LuaExportStop` 未调用 → socket 不关闭、任务切换后旧状态残留；`LuaExportStart` 未调用 → `next_sample`/`last_try` 不复位。 |
| 检测方法 | `EXP-LIFE`：`start_seen`、`stop_seen`、`duplicate_instance`（全局版本/实例计数）、`connections_per_sortie`、`greeting_count`；录制首帧重复或 `export_diag.log` 重复 `export start`。 |
| 降级策略 | 入口处做幂等守卫：已加载则只更新版本并返回；每个任务只允许一个 socket；Start/Stop 必须可重入；重复实例报告 `duplicate_export_instance`，不静默双发。 |
| 修复入口 | `src/adapters/dcs/api/export.lua`、`src/export/aa_transport.lua`；加载块仍由安装器维护。 |

#### C-05 Hooks 生命周期与 DCS.setUserCallbacks

| 字段 | 内容 |
|---|---|
| 当前位置 | `src/hooks/aesa_agradar_hook.lua:108-130`（有 `DCS` 守卫）、`src/hooks/aesa_fc_hook.lua:290-308`（`DCS.setUserCallbacks` 无守卫）、`src/hooks/aesa_sar_scene_hook.lua:111-115`（无守卫）。 |
| 依赖内容 | `DCS.setUserCallbacks({onSimulationFrame,onSimulationStart,onSimulationStop})`；`DCS.getModelTime()`；Hooks 在进程启动时加载，任务开始/停止时触发回调。 |
| 失效表现 | `DCS` 或其方法缺失 → Hooks 脚本加载即报错，探针完全不工作；`onSimulationStart` 未触发 → 旧 sortie 状态残留；`onSimulationStop` 未触发 → DLL 不 shutdown、文件句柄不关。 |
| 检测方法 | `HOOK-CB`：`dcs_table`、`set_user_callbacks`、`get_model_time`、`start_seen`、`stop_seen`、`poll_alive`；原生日志的 `poll alive` / `shutdown after N frames`。 |
| 降级策略 | 缺少 `DCS.setUserCallbacks` → 不注册、写一次日志、`native=unavailable`；缺少 `DCS.getModelTime` → 只用 `os.clock` 做重试节流，不能用于仿真时间；不反复报错。 |
| 修复入口 | `src/adapters/dcs/api/hook.lua`（Gate 3）；`profile.callbacks.hook_*`。 |

### 3.2 LoGet* 系列

#### C-06 LoGetSelfData

| 字段 | 内容 |
|---|---|
| 当前位置 | `src/export/aesa_export.lua:66-79`（读 `Position`、`velocity/vel`、`Heading/Pitch/Bank`，并在 `:78` 做 `Heading + π/2`）、`:196-197`；`src/export/aesa_sar_export.lua:348`。DCS 官方说明见安装目录 `Scripts/Export.lua:647`（“same result as LoGetObjectById”）。 |
| 依赖内容 | 返回表含 `Name`、`Position`、`Heading`、`Pitch`、`Bank`、`LatLongAlt`、`Coalition`、`CoalitionID`、`Country`、`Type`、`GroupName`、`UnitName`；**不含 velocity**。`Heading` 单位为弧度，`Heading=0` 朝 +X；本项目核心约定 `Heading=0` 朝 -Z，转换在 `:78`。 |
| 失效表现 | 返回 nil/非表 → `no-selfdata`，整帧不发；`Position` 缺失/非有限 → `no-selfpos`；`Heading/Pitch/Bank` 缺失 → 不发 O 行，核心无法建立姿态；字段改名 → 同样静默空帧。速度字段永远为 nil，A 行速度写 0。 |
| 检测方法 | `EXP-SELF`：`selfdata_type`、`position_shape`、`heading_type`、`pitch_type`、`bank_type`、`velocity_field`（预期 `nil`）；首帧键名探针（类似 `P` 行）记录实际字段。 |
| 降级策略 | 缺 `LoGetSelfData` 或 `Position` → `ownship=unavailable`，不产生 A/T/O 行；缺姿态 → 只发位置，核心标记 `attitude_valid=false`；缺速度 → `vel_valid=false`，不在 A/A 里用差分冒充。 |
| 修复入口 | `src/adapters/dcs/api/export.lua`、`src/adapters/dcs/frame.lua`、`src/export/aa_sampler.lua`。 |

#### C-07 LoGetVectorVelocity

| 字段 | 内容 |
|---|---|
| 当前位置 | `src/export/aesa_sar_export.lua:349`（SAR 唯一使用点）、`:187-192`（无速度/地速过低拒绝采集）。A/A 当前不调用它，见 `src/export/aesa_export.lua:69-72`。 |
| 依赖内容 | 返回 `{x,y,z}` 世界轴速度，单位 m/s；官方说明在安装目录 `Scripts/Export.lua:855`。它是本机速度，不是目标速度。 |
| 失效表现 | 缺失 → SAR `CAPTURE*` 报 `no_ownship`；返回零 → `ground_speed_too_low`；A/A 仍录 0 速度，回放/多普勒/GMTI 全部失真；若字段顺序或轴向变化，航迹角错误。 |
| 检测方法 | `EXP-VEL`：`vector_velocity_type`、`vector_velocity_finite`、`ground_speed_mps`；与相邻帧位置差分对比（容差内才标 `vel_valid=true`）。A/A 另记 `vel_source=none / vector_velocity / differential`。 |
| 降级策略 | 缺失/零/不可信 → `vel_valid=false`；A/A 只用位置，检测/多普勒相关功能标 `degraded`；SAR 拒绝采集而不是用 0 速度伪造地速；离线录制可单独标 `estimated_by_diff`，不能回写成实时 `vel_valid=true`。 |
| 修复入口 | `src/adapters/dcs/api/export.lua`、`src/export/aa_sampler.lua`、`src/export/sar_collector.lua`。 |

#### C-08 LoGetWorldObjects 与对象字段

| 字段 | 内容 |
|---|---|
| 当前位置 | `src/export/aesa_export.lua:96-108`（遍历、过滤本机、T 行）、`:198`；首帧键名探针 `:84-93`。录制文件 `recordings/flight3-final.aesarec` / `flight9.aesarec` 的 P 行给出实际字段。 |
| 依赖内容 | 返回以对象 ID 为键的表；对象结构同 `LoGetObjectById`：`Name`、`Type`、`Country`、`Coalition`、`CoalitionID`（1/2）、`LatLongAlt`、`Heading`、`Pitch`、`Bank`、`Position`、`UnitName`、`GroupName`、`Flags`；**不含 velocity**。`LoGetWorldObjects()` 可接受 `"units"`（默认）/`"ballistic"`/`"airdromes"`；本项目当前只取默认 `"units"`。官方字段表在安装目录 `Scripts/Export.lua:611-638`。 |
| 失效表现 | 字段改名/结构变化 → 无 T 行；`Position` 缺失 → 对象被跳过；`CoalitionID` 缺失/非法时 Gate 1 起输出 `unknown`（不再回退 `Country`）；速度字段缺失 → T 行速度 0 且 `vel_valid=0`；对象数量大时逐行发送会撑爆非阻塞缓冲（当前已改为整帧拼接，`:248-255`）。 |
| 检测方法 | `EXP-WORLD`：`world_objects_type`、`object_count`、`position_shape`、`coalition_id_type`、`coalition_type`、`country_type`、`velocity_field`（预期 `nil`）、`first_object_keys`；`CoalitionID ∈ {1,2}` 才算 IFF 可信。 |
| 降级策略 | 缺 `CoalitionID` → 目标 `coalition=0`（unknown），IFF 一律 `unknown`；**禁止**回退 `Country`/`Coalition` 字符串；缺速度 → `vel_valid=false`，T 行速度 0 且带有效性位；缺位置 → 跳过该对象并计数；整表缺失 → `targets=unavailable`。 |
| 修复入口 | `src/adapters/dcs/api/export.lua`、`src/export/aa_sampler.lua`、`src/adapters/dcs/truth_replay.lua`、`tools/receiver.py` 的字段校验。 |

#### C-09 LoGetTargetInformation / LoGetLockedTargetInformation / LoIsSensorExportAllowed

| 字段 | 内容 |
|---|---|
| 当前位置 | `src/export/aesa_export.lua:121-133`（E 行）、`:199`、`:274-286`（每 5 s E-diag）。 |
| 依赖内容 | `LoGetTargetInformation()` / `LoGetLockedTargetInformation()` 返回引擎雷达接触表，字段含 `ID`、`type`、`country`、`position.p`、`velocity`、`distance`、`convergence_velocity`、`mach`、`delta_psi`、`fim`、`fin`、`flags`；`LoIsSensorExportAllowed()` 返回权限布尔。官方字段表在安装目录 `Scripts/Export.lua:663-690`。 |
| 失效表现 | FC 时代接口；F-16C 等新模块不喂数据（`src/export/aesa_export.lua:275` 注释，实机 E-diag 留证）。E 行缺失 → 无法做“真值 vs 引擎接触”对照；`LoIsSensorExportAllowed` 缺失 → 无法判断传感器导出权限；不会影响 A/A 的 T 行。 |
| 检测方法 | `EXP-TGT`：`target_information_type`、`target_count`、`locked_information_type`、`sensor_export_allowed_type`；E-diag 的 `tgt=N/type lock=... allow=...`；按机型记录 `module_feed=false`。 |
| 降级策略 | 缺失/空表 → `engine_contacts=unavailable`，不生成 E 行；A/A 仍以 `LoGetWorldObjects` 为真值；页面/日志明确“本机型不提供引擎接触”，不用 E 行推断检测性能。 |
| 修复入口 | `src/adapters/dcs/api/export.lua`、`profile.modules.<type>.engine_contacts`；诊断保留 `tools/live.py` 的 E 行解析。 |

#### C-10 LoGetModelTime

| 字段 | 内容 |
|---|---|
| 当前位置 | `src/export/aesa_export.lua:196`、`:235`；`src/export/aesa_sar_export.lua:330-333`、`:228`（`model_time_reset` 中止采集）。 |
| 依赖内容 | 返回任务仿真时间（秒），任务重开/复位会回退；用于 10 Hz 限频、SAR 帧节流和“时间回退”检测。 |
| 失效表现 | 缺失 → A/A 的 `t` 恒 0，只发第一帧；SAR 直接不进入 `frame()`；返回常量/回退 → 限频失效、SAR 作业永不结束或误报 `model_time_reset`；与墙钟混用 → 暂停/加速时行为错误。 |
| 检测方法 | `EXP-TIME`：`model_time_type`、`monotonic_within_sortie`、`reset_observed`、`wall_clock_delta_s`；SAR 的 `model_time_reset` 日志。 |
| 降级策略 | 缺失 → `sampling=unavailable`（SAR 明确不可用）；只用墙钟做连接重试/日志，不用于物理时间；回退时中止当前作业，不拼接跨任务数据。 |
| 修复入口 | `src/adapters/dcs/api/export.lua`、`src/export/sar_collector.lua`。 |

#### C-11 经纬度/世界坐标转换

| 字段 | 内容 |
|---|---|
| 当前位置 | `src/export/aesa_sar_export.lua:353-355`（`LoGeoCoordinatesToLoCoordinates`、`LoLoCoordinatesToGeoCoordinates or LoCoordinatesToGeoCoordinates`）、`:201-207`（经度在前）、`:215-221`（逆变换回填 TARGET）。`docs/dcs-map-terrain-interfaces.md:14,20-21` 记录了任务 `coord.LLtoLO(lat,lon)` 与 Export 的参数顺序差异。 |
| 依赖内容 | Export 正变换 `(longitude_degrees, latitude_degrees)`；逆变换 `(x,z) -> {latitude,longitude}`；任务态 `coord.LLtoLO(latitude,longitude)` 顺序相反；别名 `LoCoordinatesToGeoCoordinates` 可能不存在。 |
| 失效表现 | 函数改名 → `CAPTURE_GEO` 报 `geo_unavailable`，只影响定点模式；参数顺序写反 → **不报错但打错点**，图像/目标落在错误位置；逆变换缺失 → TARGET 行缺失，仍可采集。 |
| 检测方法 | `EXP-GEO`：`forward_present`、`inverse_present`、`inverse_alias`、`argument_order`；用固定已知点做 round-trip，与任务态 `coord.LLtoLO` 交叉核对（容差按地图）。 |
| 降级策略 | 正变换缺失 → 禁用 `CAPTURE_GEO`，保留 `CAPTURE`/`CAPTURE_WORLD`；逆变换缺失 → 不发 TARGET，不伪造经纬度；参数顺序未验证 → 拒绝地理模式，不用“看起来差不多”的结果。 |
| 修复入口 | `src/adapters/dcs/api/export.lua`、`src/adapters/dcs/frame.lua`、`profile.export.geo`。 |

#### C-12 LoGetAltitude / LoGetAltitudeAboveGroundLevel / LoGetHeightWithObjects

| 字段 | 内容 |
|---|---|
| 当前位置 | `src/export/aesa_sar_export.lua:352`（`LoGetAltitude`、`LoGetAltitudeAboveGroundLevel`）、`:236-241`（STATUS 诊断 `ASL-AGL`）；`docs/dcs-map-terrain-interfaces.md:22-24`。 |
| 依赖内容 | `LoGetAltitude(x,z)` 官方注释为“altitude above terrain surface”，任意位置语义未验证；`LoGetAltitudeAboveGroundLevel()` 只对本机；`LoGetHeightWithObjects()` 零参数，只对本机。 |
| 失效表现 | 缺失 → STATUS 的 `LoGetAltitude`/`ASL-AGL` 为 `unknown`；若误把 `LoGetAltitude` 当任意点地形高度，会得到错误高程；不影响 `terrain.GetHeight` 的正式路径。 |
| 检测方法 | `EXP-ALT`：`altitude_type`、`agl_type`、`height_with_objects_type`；与 `terrain.GetHeight(own.x,own.z)` 对比本机点，差异大则标 `altitude_semantics=unverified`。 |
| 降级策略 | 只做本机诊断；缺失/语义不明 → `unknown`；SAR 一律用 `terrain.GetHeight`，不用 `LoGetAltitude` 代替。 |
| 修复入口 | `src/adapters/dcs/api/export.lua`；诊断字段保留。 |

### 3.3 world / terrain / land API

#### C-13 terrain.GetHeight

| 字段 | 内容 |
|---|---|
| 当前位置 | `src/export/aesa_sar_export.lua:350`（取函数）、`:168`/`:193`（无 height 拒绝采集）、`:236-241`（STATUS 公布 provider）、`:261-263`（MAPHEIGHT）、`:283`（HEIGHT）；`tools/sar_live.cjs:385`（`terrainReady`）、`:584`（CAPS v2 门槛）、`:712`。 |
| 依赖内容 | Export 环境 `require("terrain").GetHeight(x,z)`，返回该点地表海拔；由 `lua-terrain.dll` 提供，`bin` 与 `bin-mt` 各一份。 |
| 失效表现 | `require` 失败/函数缺失 → STATUS `terrain.GetHeight` 变成 `unavailable`；`CAPTURE`/`CAPTURE_MAP` 报 `terrain_unavailable`；服务端 `terrainReady()` false，页面一直“等待可用地形接口”；若函数存在但返回 NaN/超范围，`safe()` 过滤后按 `terrain_query_failed` 中止。 |
| 检测方法 | `TER-GH`：`require_terrain`、`get_height_type`、`probe_point_height`、`probe_point_finite`；与任务态 `land.getHeight({x,z})` 对同一点交叉核对；STATUS 行 provider 字段。 |
| 降级策略 | 缺失 → `sar=unavailable`，SAR/MAP/DBS 全部拒绝；A/A 不受影响；**禁止**用 0 高程、椭球高或 `LoGetAltitude` 伪造地形。 |
| 修复入口 | `src/adapters/dcs/api/export.lua`、`src/export/sar_collector.lua`、`profile.export.terrain.get_height`。 |

#### C-14 terrain.GetSurfaceType

| 字段 | 内容 |
|---|---|
| 当前位置 | `src/adapters/dcs/api/export.lua:terrain_surface_type`（唯一入口）；`src/export/sar_collector.lua`（CAPS 公布、五类归一、SURFACE 行）；`src/adapters/dcs/sar_adapter.cjs`（数字/词表映射）、`src/sar_core/materials.cjs`（16 类材质）。 |
| 依赖内容 | Export 环境 `terrain.GetSurfaceType(x,z)` **只接受两个标量**；2.9.30 实测返回地表名字符串（如 `land`），历史版本返回 1–5。**禁止传 Vec2 表**：lua-terrain 会抛 C++ 异常穿透 pcall 并终止 DCS（2026-10-18 实机崩溃，见 worklog Gate 3）。 |
| 失效表现 | 缺失 → `CAPS,2,unavailable,map`；不生成 SURFACE/MAPSURFACE；细类探针仍可能补上，但粗分类缺失；服务端 `surfaceName` 对未知数字返回 `unknown`。 |
| 检测方法 | `TER-GST`：只做标量调用；接受数字 1–5 或 `land/sea/water/shallow_water/road/runway`，其余 degraded；不做参数形态重试。 |
| 降级策略 | 缺失 → `surfaces=unknown`，保留高程与几何；不猜类别；细类探针可用时只输出经过词表校验的 16 类；否则 `unknown`。 |
| 修复入口 | `src/adapters/dcs/api/export.lua`、`src/adapters/dcs/data/surfaces.lua`、`profile.export.terrain.get_surface_type`。 |

#### C-15 terrain.isVisible

| 字段 | 内容 |
|---|---|
| 当前位置 | `src/export/aesa_export.lua:185-204`（`require("terrain")`，六标量 `isVisible`）、`:109-114`（L 行）。 |
| 依赖内容 | Export 沙箱中的 `terrain.isVisible(x1,y1,z1,x2,y2,z2)`，与 MissionEditor `me_utilities.lua` 的六标量接口一致；只判断地形遮挡，不含单位/建筑。 |
| 失效表现 | `require` 失败/函数缺失 → 不发 L 行；接收端保留 `visible=unknown` 并仍应用球面视距；若误判为 true，会把地形遮挡目标当成可见；调用抛错 → 该帧 L 行缺失。 |
| 检测方法 | `TER-VIS`：`require_terrain`、`is_visible_type`、`probe_same_point`（应 true）、`probe_through_ridge`（应 false，需已知地形）；对比任务态 `land.isVisible(from,to)`。 |
| 降级策略 | 缺失 → `visibility=unknown`，不生成 L 行；不默认 true；页面/日志明确“仅球面视距”；任务态 `land.isVisible` 也不能替代 Export 的逐目标判断。 |
| 修复入口 | `src/adapters/dcs/api/export.lua`、`profile.export.terrain.is_visible`。 |

#### C-16 world.searchObjects / VolumeType / Object.Category

| 字段 | 内容 |
|---|---|
| 当前位置 | `src/scene/aesa_sar_mission.lua:21-23`（能力串）、`:42-68`（场景对象）、`:76-104`（GMTI mover）；`src/hooks/aesa_sar_scene_hook.lua:31`（CAP 第二字段）、`:44`（provider 接受条件）；`tools/sar_bridge.cjs:43-50`（CAP 校验）、`:68`（SURFACE 1–5）。 |
| 依赖内容 | 任务态 `world.searchObjects(category, volume, handler)`；`world.VolumeType.BOX`；`Object.Category.SCENERY/STATIC/UNIT`；对象方法 `getPosition`、`getDesc().box`、`getVelocity`、`inAir`；回调返回 false 可提前停止；同步执行，必须限时/限量。 |
| 失效表现 | 任一常量缺失 → `objects()` 返回 `unavailable`，SCENE_END 仍可能带 surfaces；CAP 的 objects/movers 字段为 `unavailable`，服务端 GMTI/建筑叠加为空；对象方法缺失 → 该对象 `skipped`；搜索过大/过慢 → 卡任务帧（已有 512 次访问、0.1 s 预算）。 |
| 检测方法 | `WLD-SEARCH`：`search_objects_type`、`volume_type_box`、`category_scenery/static/unit`、`get_position`、`get_desc_box`、`get_velocity`、`in_air`；用小盒子做一次只读探针，统计 visited/skipped。 |
| 降级策略 | 缺失 → `objects=unavailable`，不返回空列表冒充“没有物体”；保留地形 SURFACE 与 Export 数据；GMTI 标 `movers=unavailable`；页面显示原因。 |
| 修复入口 | `src/adapters/dcs/api/mission.lua`、`src/scene/sar_scene_core.lua`、`profile.mission.world`。 |

#### C-17 land.getSurfaceType / land.getHeight / land.isVisible

| 字段 | 内容 |
|---|---|
| 当前位置 | `src/scene/aesa_sar_mission.lua:31-33`（CAP 第一字段）、`:116-126`（`land.getSurfaceType({x=x,y=z})`，只接受 1–5）；`docs/dcs-map-terrain-interfaces.md:9-13` 记录 `land.getHeight`、`land.isVisible`、`land.getIP`、`land.profile` 的能力与限制。 |
| 依赖内容 | 任务态 `land.getSurfaceType(Vec2)` 返回 1–5；`land.getHeight(Vec2)` 返回地表海拔；`land.isVisible(from,to)` 是任务态视线；`Vec2` 用 `{x=world.x, y=world.z}`，不是 `{x,z}`。 |
| 失效表现 | `land.getSurfaceType` 缺失 → 场景 hook 的 `probe()` 找不到 `CAP,land.getSurfaceType,...`，provider 保持 `unavailable`，整个场景桥不可用；`getHeight` 缺失 → 任务态无法补高程；`isVisible` 缺失 → 任务态不能做视线补充（当前未接入）。 |
| 检测方法 | `LND-SURF`：`get_surface_type_type`、`get_height_type`、`is_visible_type`、`vec2_convention`、`probe_value_range`；与 Export `terrain.GetSurfaceType` 同点对照。 |
| 降级策略 | `land.getSurfaceType` 缺失 → 场景桥 `unavailable`；不要用 `world.searchObjects` 推断地表；`land.getHeight` 缺失 → 只用 Export 高程；`land.isVisible` 缺失 → `visibility=unknown`。 |
| 修复入口 | `src/adapters/dcs/api/mission.lua`、`src/scene/sar_mission_env.lua`、`profile.mission.land`。 |

#### C-18 任务对象/事件/定时器 API

| 字段 | 内容 |
|---|---|
| 当前位置 | `src/scene/aesa_sar_mission.lua:49-64`（对象方法）、`:87-100`（mover 方法）；`src/hooks/aesa_fc_hook.lua:32-128`（`Unit.getByName`、`getPosition`、`getVelocity`、`getObjectID`、`getTypeName`、`isExist`、`world.event`、`world.addEventHandler`、`timer.getTime/scheduleFunction`）、`:250`（feed 查询）。 |
| 依赖内容 | 任务态 `Unit.getByName`、`Unit:getPosition().p`、`Unit:getVelocity()`、`Unit:getObjectID()`、`Unit:getTypeName()`、`Unit:isExist()`；`world.event.S_EVENT_SHOT/HIT`；`world.addEventHandler`；`timer.getTime`、`timer.scheduleFunction`。 |
| 失效表现 | 方法/事件常量改名 → 对象被 `skipped`，轨迹记录器不工作，SHOT/HIT 不记录；`timer` 缺失 → mover 查询没有时钟预算，轨迹采样不调度；事件 handler 被 GC → 事件停止（代码已用强引用 `msl.ev_handler`，`:87-117`）。 |
| 检测方法 | `MSN-OBJ`：`unit_get_by_name`、`unit_position`、`unit_velocity`、`unit_object_id`、`unit_type_name`、`unit_is_exist`、`world_event_shot`、`world_event_hit`、`add_event_handler`、`timer_get_time`、`timer_schedule_function`；首次任务跑 10 s，检查事件计数。 |
| 降级策略 | 缺失 → `mission_objects=degraded/unavailable`；场景对象只报告可用字段；FC 轨迹记录器关闭，保留原生只读 trace；不伪造事件/轨迹。 |
| 修复入口 | `src/adapters/dcs/api/mission.lua`、`src/adapters/dcs/api/hook.lua`、`profile.mission.objects`。 |

### 3.4 mission 环境

#### C-19 net.dostring_in / a_do_script / 权限

| 字段 | 内容 |
|---|---|
| 当前位置 | `src/hooks/aesa_sar_scene_hook.lua:23-51`（四种候选：`a_do_script`、`net.dostring_in("scripting")`、`net.dostring_in("mission")+a_do_script`、`net.dostring_in("mission")`）；`src/hooks/aesa_fc_hook.lua:174-217`（工作通道记忆 + bandit ID 查询）、`:250`（feed 查询）；`docs/sar-airport-validation.md:21,67` 与 `docs/research/fire-control-paths.md:36,104` 记录 `autoexec.cfg` 的 `net.allow_dostring_in` / `allow_unsafe_api` 手工授权。 |
| 依赖内容 | Hooks 态通过 `net.dostring_in(state, code)` 进入任务/网络状态；`"scripting"` 可直接访问 `Unit/world/timer`；`"mission"` 实测缺少这些全局（`aesa_sar_scene_hook.lua:28-29`），需要 `a_do_script` 二跳；权限由 `autoexec.cfg` 的 `net.allow_dostring_in` 决定。 |
| 失效表现 | 权限未开/API 改名 → 所有候选失败，`CAP,unavailable,unavailable,unavailable`；场景对象/GMTI/建筑全部空；FC 无法解析 bandit ObjectID，`arm_step` 超时 `bandit not found`；feed 无法读取目标状态；不会自动改 `autoexec.cfg`。 |
| 检测方法 | `MSN-DOSTRING`：`net_table`、`dostring_in_type`、`scripting_state_ok`、`mission_state_ok`、`a_do_script_type`、`allow_dostring_in`（只读观察，不修改）；探针执行 `return type(land)..','..type(world)..','..type(timer)`；记录实际 provider。 |
| 降级策略 | 缺 `net.dostring_in` 且无 `a_do_script` → `scene_bridge=unavailable`；FC 注入路径 `unavailable`，只保留原生只读 trace；**禁止**探针自行设置 `net.allow_unsafe_api`/`net.allow_dostring_in`；**禁止**用 `loadstring` 之外的网络/文件通道绕过。 |
| 修复入口 | `src/adapters/dcs/api/mission.lua`、`src/adapters/dcs/api/hook.lua`、`src/hooks/aesa_sar_scene_hook.lua`、`profile.mission.bridge`；部署文档说明这是用户手工前置条件。 |

#### C-19A mission 的 coalition / controller API

| 字段 | 内容 |
|---|---|
| 当前位置 | 当前代码**未接入**。`src/scene/aesa_sar_mission.lua:2` 的 `M` 只有 `version/job/mover_job`；`src/hooks/aesa_sar_scene_hook.lua:38` 的任务探针只检查 `land/world/timer/a_do_script`，不检查 `coalition/controller`。Export 侧的 `CoalitionID` 是另一条线，见 C-08。 |
| 依赖内容 | 任务态 `coalition.*`：`coalition.side`、`getCountryCoalition(countryId)`、`getGroups`、`getUnits`、`getStaticObjects`、`getServiceProviders`、`getMainRefPoint`、`addGroup`、`addStaticObject` 等；任务态 `controller` / `Group:getController()`：`setTask`、`pushTask`、`setCommand`、`setOption`、`setAltitude` 等。读取与写入权限不同；`addGroup`/`controller` 会改变任务状态，MP 下受服务器权威/完整性影响。 |
| 失效表现 | API 改名/权限收紧 → 未来任务生成、AI 控制、红蓝方统计不可用；`coalition.addGroup` 失败可能抛错并中断当前 `a_do_script`；`controller` 缺失 → 不能给 Group 下任务；若误用 Export 的 `CoalitionID` 代替任务 `coalition`，会把阵营 ID 与 coalition 对象混为一谈。 |
| 检测方法 | `MSN-COAL`：`coalition_table`、`side_table`、`get_country_coalition_type`、`get_groups_type`、`get_units_type`、`add_group_type`、`controller_type`、`group_get_controller_type`、`set_task_type`；只读探针只调用 `getGroups(coalition.side.BLUE)` 一类的查询，不调用 `addGroup`/`setTask`。 |
| 降级策略 | 缺失 → `mission_control=unavailable`；任务生成/AI 控制功能不启用；只读统计可退回 Export 的 WorldObjects；**禁止**用直接改表、伪造 Group/Controller 对象或改任务文件来“补”API。 |
| 修复入口 | `src/adapters/dcs/api/mission.lua`、`src/scene/sar_mission_env.lua`、`profile.mission.coalition` / `profile.mission.controller`。 |

#### C-20 任务脚本生命周期与全局状态

| 字段 | 内容 |
|---|---|
| 当前位置 | `src/hooks/aesa_sar_scene_hook.lua:1-2`（生成文件头）、`:40`（把 `aesa_sar_mission.lua` 源码注入任务态）、`:52-115`（每帧执行 `AESA_SAR_SCENE.step()`）；`src/scene/aesa_sar_mission.lua:155`（`AESA_SAR_SCENE=M` 全局）。 |
| 依赖内容 | 任务态全局 `AESA_SAR_SCENE` 只在任务内有效；任务重开/换图会重建；Hook 是进程级，跨任务保留自己的 `client/active/retry` 状态；`onSimulationStart/Stop` 的触发时机由 DCS 决定。 |
| 失效表现 | 任务重开但 Hook 未复位 → `active=true` 指向旧 job，收到 `IDLE`/`BRIDGE_ERROR`；全局名冲突 → 两个 sampler 互相覆盖；`start()` 未执行但 `step()` 被调用 → 报 `IDLE`；任务暂停时模型时间不走，服务端误判“任务已停”。 |
| 检测方法 | `MSN-LIFE`：`mission_global_type`、`version`、`start_seen`、`stop_seen`、`model_time_reset`、`idle_after_start`；Hook 日志的 `HELLO`/`BRIDGE_ERROR`/`CAP` 变化。 |
| 降级策略 | 每次 `onSimulationStart` 清空 `active/mover_active/pending`；`step` 前校验 `AESA_SAR_SCENE` 版本；任务重开时主动 `CANCEL`；版本不匹配 → `scene_bridge=unavailable`。 |
| 修复入口 | `src/scene/sar_scene_core.lua`、`src/hooks/aesa_sar_scene_hook.lua`、`profile.mission.lifecycle`。 |

#### C-21 DCS Hooks API（与 C-05 区分）

| 字段 | 内容 |
|---|---|
| 当前位置 | `src/hooks/aesa_agradar_hook.lua:21-26`（`DCS.getModelTime` 回退 `os.clock`）、`:108-130`；`src/hooks/aesa_fc_hook.lua:284,297,308`；`src/hooks/aesa_sar_scene_hook.lua:53,115`。 |
| 依赖内容 | `DCS.getModelTime()` 是仿真时间；`DCS.setUserCallbacks` 注册帧/任务回调；Hooks 环境还提供 `lfs`、`package.loadlib`、`io`。 |
| 失效表现 | `DCS.getModelTime` 缺失 → 重试节流退回 `os.clock`，与暂停/加速不一致；`setUserCallbacks` 缺失 → 原生探针不 poll、场景 hook 不 frame；FC hook 无守卫会在加载时直接报错（`aesa_fc_hook.lua:308`）。 |
| 检测方法 | `HOOK-CB`（同 C-05）；另检查 `os.clock` 与模型时间比例，比例异常时标 `hook_clock=degraded`。 |
| 降级策略 | 缺 `getModelTime` → 只用墙钟做重试，禁止用于物理/协议时间；缺 `setUserCallbacks` → 关闭 Hook 功能并写一次日志。 |
| 修复入口 | `src/adapters/dcs/api/hook.lua`。 |

### 3.5 socket / package.loadlib / lfs 与 Saved Games 路径

#### C-22 LuaSocket 自举

| 字段 | 内容 |
|---|---|
| 当前位置 | `src/export/aesa_export.lua:145-183`（A/A 自举：`require("socket")`，失败后用 `lfs.currentdir()`、`lfs.envbasedir()`、`package.path` 反推 `DCSWorld`，尝试 `LuaSocket\?.lua` + `bin`/`bin-mt`/`LuaSocket` 四种 cpath）；`src/export/aesa_sar_export.lua:313-323`（SAR 自举，只试 `currentdir` + `bin`/`bin-mt`）；`src/hooks/aesa_sar_scene_hook.lua:7-16`（Hooks 自举）。 |
| 依赖内容 | DCS 自带 `lua-socket.dll`（`bin` 与 `bin-mt` 都有）、`LuaSocket\?.lua`（安装根）；进程当前目录可能是安装根或 `bin`；`package.cpath` 命名约定 `lua-?.dll`；SRS 等工具可能已加载 socket。 |
| 失效表现 | `require("socket")` 失败 → 无连接；A/A 会在 `export_diag.log` 写 `socket UNAVAILABLE`，SAR/场景 hook 可能静默；路径拼接错误/权限不足 → 反复重连；MT 进程用了 ST 的 `bin` → 可能加载错 DLL 或失败。 |
| 检测方法 | `IO-SOCK`：`require_socket`、`socket_tcp_type`、`currentdir`、`package_cpath_has_bin`、`package_cpath_has_bin_mt`、`lua_socket_dll_exists`；连接 127.0.0.1 的自测（可选，需服务端）。 |
| 降级策略 | 缺失 → `transport=unavailable`，功能明确不可用；不忙等、不刷日志；重连退避（现有 2 s）；**禁止**把 `package.path/cpath` 改到未知目录或从网络加载。 |
| 修复入口 | `src/adapters/dcs/api/export.lua`、`src/adapters/dcs/api/hook.lua`、`spec/deployment.json`（Gate 3 去重，当前三份自举）。 |

#### C-23 lfs / Saved Games 路径与 DCS 变体

| 字段 | 内容 |
|---|---|
| 当前位置 | `scripts/install_export.py:30-39`（`AESA_SAVED_GAMES` → `~/Saved Games/DCS` → `DCS.openbeta` → 默认 `DCS`）；`src/export/aesa_export.lua:22-35`（`lfs.writedir()` 日志）、`:149-153`（`lfs.currentdir/envbasedir`）；`src/export/aesa_sar_export.lua:58-78`（`lfs.writedir()`，再 `USERPROFILE\Saved Games\DCS` 和 `DCS.openbeta`）；`src/hooks/aesa_fc_hook.lua:135-142`、`src/hooks/aesa_agradar_hook.lua:28-41`（`lfs.writedir()` 拼 `Scripts\...`）。 |
| 依赖内容 | `lfs.writedir()` 是当前活动 Saved Games 的权威来源；安装器可能在 `DCS`/`DCS.openbeta` 都存在时选错；Windows 路径含空格/中文；`os.getenv("USERPROFILE")` 不是唯一用户目录来源。 |
| 失效表现 | 安装到非活动目录 → 游戏不加载，日志无记录；`lfs` 缺失 → 所有 `writedir` 路径失败，原生 DLL 不加载，日志不写；硬编码 `USERPROFILE` 在非默认配置下找不到；路径分隔符混用 → `loadlib` 失败。 |
| 检测方法 | `IO-LFS`：`require_lfs`、`writedir`、`writedir_matches_installer`、`userprofile`、`saved_games_variant`；读取 `Logs/dcs.log` 的 `DCS/<build>` 行确认活动变体；安装器 `status/verify` 对比目标。 |
| 降级策略 | `lfs` 缺失 → `paths=unavailable`，不猜路径；安装器必须显式 `--saved-games`（`install_sar.cjs:93` 已强制；`install_export.py` 仍可自动，Gate 6 统一）；同机双变体时报告歧义，不静默选一个。 |
| 修复入口 | `spec/deployment.json`、`scripts/install_common.cjs`、`src/adapters/dcs/api/hook.lua`。 |

#### C-24 package.loadlib 与 DLL 导出

| 字段 | 内容 |
|---|---|
| 当前位置 | `src/export/aesa_sar_export.lua:83-104`（`aesa_agradar_surface_names`/`_surface_mask`/`_init`，最后才 `require("aesa_agradar")`）；`src/hooks/aesa_agradar_hook.lua:55-84`（`init/poll/shutdown/version/surface_names/surface_mask`）；`src/hooks/aesa_fc_hook.lua:143-170`（`init/poll/shutdown/trace_start/trace_stop/arm/disarm/feed_target`）；manifest hash 在 `scripts/install_agradar_probe.cjs:97-102`、`scripts/install_fc_probe.cjs:29-31`。 |
| 依赖内容 | `package.loadlib(path, symbol)` 返回 C 函数或 nil+err；DLL 必须与 DCS 进程同为 x64；依赖仅系统 DLL；导出名固定；DLL 可能被运行中的 DCS 锁定。 |
| 失效表现 | 导出缺失 → `loadlib` 返回 nil，探针不可用；32/64 位不匹配 → `%1 is not a valid Win32 application`；DLL 依赖缺失 → 加载失败；DLL 被锁 → 安装器写入失败；`require` 包装路径只在 `package.cpath` 已配置时成立。 |
| 检测方法 | `IO-LOADLIB`：`loadlib_type`、`dll_arch`、`required_exports`、`version_string`、`dll_hash_matches_manifest`；逐导出 `loadlib` 并记录缺失项；`GetProcAddress` 失败在日志中本来就是 `MISSING`。 |
| 降级策略 | 任一必需导出缺失 → `native=unavailable`；agradar 不可用 → 退回五类地表；FC 不可用 → 只读/无注入；安装器拒绝覆盖未知文件（已实现）。 |
| 修复入口 | `src/native/abi/dcs_profile.h`、`src/adapters/dcs/api/hook.lua`、`scripts/install_common.cjs`。 |

#### C-25 日志路径、io 与日志体积

| 字段 | 内容 |
|---|---|
| 当前位置 | `src/export/aesa_export.lua:22-35`（`lfs.writedir()..Scripts\AESA\export_diag.log`，`io.open(...,"a")`）；`src/hooks/aesa_fc_hook.lua:237-241`（`Logs\AESA\fc_msl_pos.log`）；原生日志 `Logs\AESA\fc_native.log`、`Logs\AESA\AGR\agradar_native.log`、`Logs\AESA\fc_trace.log`（本机实测 `fc_trace.log` 约 32 MB/次会话）。 |
| 依赖内容 | Export/Hooks 有 `io`；任务态没有；日志目录可写；日志文件会跨会话追加。 |
| 失效表现 | 日志目录不可写 → 诊断丢失；`fc_trace.log` 无上限 → 磁盘膨胀；旧日志被误读为当前 build；`io` 缺失 → `pcall` 静默，问题不可见。 |
| 检测方法 | `IO-LOG`：`io_type`、`log_dir`、`log_size_bytes`、`log_mtime`、`rotation`；`compat_check` 只读最新会话段，不把旧日志当当前证据。 |
| 降级策略 | 日志失败不影响功能；`fc_trace.log` 必须有大小/会话上限（Gate 6）；probe 输出单独文件，避免与历史日志混淆。 |
| 修复入口 | `src/adapters/dcs/api/hook.lua`、`spec/deployment.json`、`fc_trace`。 |

#### C-26 端口与握手（传输耦合）

| 字段 | 内容 |
|---|---|
| 当前位置 | `src/export/aesa_export.lua:8`（3590）、`src/export/aesa_sar_export.lua:3`（3592）、`tools/sar_live.cjs:228`（3592/3593/3594）、`tools/sar_bridge.cjs:8`（3594）；握手 `V1`、`HELLO,SAR1`、`HELLO,SARSCENE1`。 |
| 依赖内容 | 固定本机端口；旧服务/旧 Export 的 greeting 与字段数；场景 CAP 4/5 字段兼容（`tools/sar_bridge.cjs:43-50`）。 |
| 失效表现 | 端口被占用/防火墙 → 连不上；旧服务不认 `SURFACE_FINE`/`CAPS` 版本 → 采集失败；新 Export 给旧服务发未知行 → 旧服务可能断开。 |
| 检测方法 | `NET-PORT`：`port_free`、`greeting`、`protocol_version`、`server_build`；`compat_check` 记录协议版本。 |
| 降级策略 | 连接失败退避并报告；新字段只增不改；旧服务不认的能力不发送；版本不匹配时明确提示升级哪一侧。 |
| 修复入口 | `spec/protocol.json`、`src/export/sar_protocol.lua`、`tools/sar_service/http_api.cjs`。 |

### 3.6 原生符号 / vtable / offset / export hash

#### C-27 agradar 符号集

| 字段 | 内容 |
|---|---|
| 当前位置 | `src/native/agradar_probe/aesa_agradar.c:79-89`（4 个符号，模块 `Inter.dll` / `edterrain4.dll`）、`:394-443`（初始/延迟解析）、`:62-64`（注释：mangled 名来自 `2.9.30.28738` export tables，但只记录模块版本，不硬失败）。 |
| 依赖内容 | `?GetDefaultTerrain@ITerrain@edterrain@@SAPEAV12@XZ`、`?getSurfaceTypesName@edterrain@@YA?AV?$basic_string@D@ed@@_K@Z`、`?getSurfaceTypeName@edterrain@@YAPEBD_K@Z`、`?getPointOnSurface@ITerrainImpl4@@UEBA?AUPointOnSurface@edterrain@@AEBVVec3d@osg@@PEAUInternalCache@23@@Z`；`GetProcAddress` 精确匹配，无特征码扫描。 |
| 失效表现 | 符号改名/移除 → 日志 `MISSING`，`init` 返回 <4，`surface_names/mask` 返回 nil；细类地表不可用，SAR 退回五类；不会崩溃，但会静默失去建筑/森林分类。 |
| 检测方法 | `NAT-AGR-SYM`：`init_count`（应为 4）、`symbols_resolved`、`late_resolved`、`module_versions`；原生日志逐符号 `resolved/MISSING`；PE 导出表 hash 作为 profile 指纹。 |
| 降级策略 | 缺任一符号 → `agradar=unavailable`，不执行查询；细类降级到 `terrain.GetSurfaceType` 五类；日志明示缺失符号。 |
| 修复入口 | `src/native/abi/dcs_profile.h`（Gate 3）、`aesa_agradar.c`、`profile.native.agradar.symbols`。 |

#### C-28 agradar vtable 槽位与 PointOnSurface 偏移

| 字段 | 内容 |
|---|---|
| 当前位置 | `src/native/agradar_probe/aesa_agradar.c:571-579`（校验 vtable 至少 20 指针，取 `vt[19]`）、`:589-610`（与 `GetProcAddress` 地址比较；不同但属于 `edterrain4.dll` 时仍调用）、`:612-620`（`this` 在 RCX、sret 在 RDX、Vec3d 在 R8、cache 在 R9；读 `sret+0x38`）、`:621-627`（全 1 哨兵）。研究证据：`docs/research/edterrain4-landscape-map.md:170,197-208`、`docs/research/agradar-probe-phase1.md:41-75,220-221`。 |
| 依赖内容 | `ITerrainImpl4` vtable 槽位 19（字节偏移 `0x98`）等于导出 `getPointOnSurface` RVA `0x255a0`；`PointOnSurface` 返回结构 `+0x38` 是 8 字节地表类型掩码；`edterrain4.dll` 是 UPX 打包，不能依赖静态文件偏移。 |
| 失效表现 | 槽位顺序变化 → 调到错误虚函数，可能崩溃或返回垃圾；`+0x38` 布局变化 → 掩码错位，建筑/水面分类错；UPX 重打包 → 静态 RVA 失效；vtable 指针属于 `edterrain4` 但不是目标函数时，当前代码会“信任并调用”，这是 fail-open 风险。 |
| 检测方法 | `NAT-AGR-VT`：`vtable_slot`、`vtable_fn_equals_export`、`vtable_fn_module`、`point_on_surface_offset`、`probe_mask_sentinel`、`probe_mask_known_bits`；导出表 hash + 模块 hash；`+0x38` 在真实地形上的已知点对照。 |
| 降级策略 | 槽位函数不等于导出地址、或属于未知模块、或掩码含未知位/全 1 → `agradar=unavailable`，返回 nil；**不得**再走“属于 edterrain4 就调用”的分支；原生只读模式。 |
| 修复入口 | `src/native/abi/dcs_profile.h`、`aesa_agradar.c`；Gate 6 的 `agradar` profile 自检。 |

#### C-29 agradar 地表词表与掩码位

| 字段 | 内容 |
|---|---|
| 当前位置 | `src/native/agradar_probe/aesa_agradar.c:111-128`（16 类 bit 表）、`:503-526`（解码）、`:640-693`（启动时与引擎 `getSurfaceTypeName` 对照并记录 mismatch）；`src/export/sar_protocol.lua`（大写 16 类词表）；`src/sar_core/materials.cjs`（16 类顺序 + 材质）。 |
| 依赖内容 | 位 0/2/4/5/6/8/9/10/11/12/16/17/20/21/22/23 对应 `Land/Runway/Sea/River/Lake/Road/Railway/Town/Field/Beach/Building/Construction/Trees/Forest/Traffic/ParticleEffect`；位 7 等未命名位不输出；全 1 是“地形未就绪”哨兵。 |
| 失效表现 | 位含义/名称变化 → 材质映射错（例如建筑被当陆地）；新增位被忽略 → 新类别显示 `unknown`；新增位被误认为已知 → 材质错误；全 1 未识别 → 整图按“全类别”绘制。 |
| 检测方法 | `NAT-AGR-MASK`：`class_count=16`、`name_mismatches`（启动日志 `16/16 match`）、`unknown_bits`、`sentinel_all_ones`；已知地物点（跑道/水面/建筑）抽样。 |
| 降级策略 | 任一名称 mismatch 或未知位 → 该点 `unknown`，不猜；`class_count` 变化 → `fine_surfaces=degraded`，退回五类；全 1 → 视为地形未就绪，不返回掩码。 |
| 修复入口 | `src/adapters/dcs/data/surfaces.lua`、`profile.native.agradar.surface_bits`、`aesa_agradar.c`。 |

#### C-30 fc_probe 符号集

| 字段 | 内容 |
|---|---|
| 当前位置 | `src/native/fc_probe/aesa_fc.c:46-84`（17 个符号，模块 `wRadio.dll` / `WorldGeneral.dll` / `Weapons.dll` / `CockpitBase.dll`）、`:194-218`（init 解析并记录缺失）、`:222-241`（帧内迟解析）。 |
| 依赖内容 | 数据链 `receive_msg/send_msg/get_msgs_gueue/getNetState/setEnabledReceiverBits`；`MovingObject::getDatalinkTerminal/ForcePosition/Target_ID`；武器 `assignAutotrackingTarget/getTrackingTarget/setTarget/track_missile`；座舱 `ed_cockpit_get_parameter_handle/update_parameter_with_number/dispatch_action_digital/track_is_writing`。 |
| 失效表现 | 符号缺失 → `init` 返回 <17，日志 `MISSING`，迟解析继续重试；依赖该符号的功能不可用；某些符号缺失时 `setTarget` 仍可被调用（危险：写路径没有“符号完整”闸门）。 |
| 检测方法 | `NAT-FC-SYM`：`init_count`（应 17）、`symbols_resolved`、`late_resolved`、`module_versions`；每个符号的模块名和 mangled 名比对 profile。 |
| 降级策略 | 缺任一必需符号 → `fc_inject=unavailable`；`fc_trace` 只安装完整解析的 site；默认只读；不因“大部分符号在”就开放写。 |
| 修复入口 | `src/native/abi/dcs_profile.h`、`src/native/fc_trace` / `fc_inject`（D4/Gate 6）。 |

#### C-31 fc detour site 与签名

| 字段 | 内容 |
|---|---|
| 当前位置 | `src/native/fc_probe/aesa_fc.c:884-919`（13 个 site，含 `wRadio.dll`/`Weapons.dll`/`WeaponBlocks.dll` 的 mangled 符号）、`:921-957`（`MH_CreateHook`/`MH_EnableHook`）、`:959-981`（停止/卸载）。 |
| 依赖内容 | MinHook detour；x64 成员调用约定（`this` 在 RCX；大结构返回时 sret 在 RCX、`this` 在 RDX）；13 个函数签名必须与头文件/引擎一致；`WeaponBlocks.dll` 的 `wGP_AMRAAM` / `wDRadioSeeker` / `wDSeeker`。 |
| 失效表现 | 签名变化 → 参数错位、栈/寄存器破坏，可能直接崩溃；模块未加载 → `target missing`，该 site 不装；MinHook 失败 → `hook failed`；部分安装 → 轨迹不完整但游戏继续，容易误判“没有调用”。 |
| 检测方法 | `NAT-FC-SITES`：`site_count=13`、`sites_hooked`、`sites_missing`、`first_call_seen`、`call_counts`；启动日志 `TRACE start: N/13 hooks installed`；profile 记录每个模块+mangled 符号+签名 hash。 |
| 降级策略 | `sites_hooked < 13` → 写路径关闭；只读 trace 可以继续，但标记 `trace_partial=true`；签名/profile 不匹配 → 不装 hook；默认 read-only。 |
| 修复入口 | `src/native/abi/dcs_profile.h`、`fc_trace`、`fc_inject`。 |

#### C-32 fc 对象偏移（wGP_AMRAAM）

| 字段 | 内容 |
|---|---|
| 当前位置 | `src/native/fc_probe/aesa_fc.c:563-572`（注释：`+0x1a8` 弹位置、`+0x1c0` 弹速度、`+0x220` 目标相对矢量；`+0x170/+0x178/+0x180` 来自 `docs/design-fc-injection.md:64` 与 worklog）、`:579-608`（`feed_write` 读写）、`:585-587`（三个 `readable` 检查）。 |
| 依赖内容 | MSVC x64 对象布局；`wGP_AMRAAM` 的字段偏移在 `2.9.30.28738` 由 OBJD 内存观察 + Lua 轨迹相关性验证；`+0x220` 可被外部每 tick 写入前置拦截点；字段是 `double[3]`/Vec3d。 |
| 失效表现 | 偏移变化 → 读到错误位置/速度，写入破坏其他字段；Gate 1 前的 `readable` 只检查起始页、忽略长度，跨页时可能 AV（**Gate 1 已修：完整页范围校验**）；多线程写入无锁；错误写入可能导致游戏崩溃或弹道异常。 |
| 检测方法 | `NAT-FC-OFF`：`offsets_match_profile`、`position_range`（世界坐标合理）、`velocity_range`、`time_monotonic`（`+0x170`）、`distance_positive`（`+0x180`）、`readable_range`；首次只读采样与 Lua `fc_msl_pos.log` 对照；写入前 dry-run 只校验不写。 |
| 降级策略 | 任一 sanity 失败、profile hash 不匹配、或只读模式 → 禁止 `feed_write`；`fc_inject` 独立 DLL（D4）默认不加载；保留 `fc_trace` 只读。 |
| 修复入口 | `src/native/abi/dcs_profile.h`、`fc_inject`；**不得**在业务 Lua 里硬编码 offset。 |

#### C-33 MSVC RTTI 与对象观察

| 字段 | 内容 |
|---|---|
| 当前位置 | `src/native/fc_probe/aesa_fc.c:303-334`（`rtti_name`：`vft[-1]`、`+12`/`+20` RVA、`TypeDescriptor.name`）、`:436-549`（OBJD 对象观察、`watch_add`/`watch_sample`/`seeker_scan`）、`:397-399` 注释“不从 detour 调用引擎虚函数”。 |
| 依赖内容 | MSVC x64 RTTI 布局（CompleteObjectLocator、TypeDescriptor）；类名用于识别 `wGP_AMRAAM`/seeker；对象指针在 `watch` 中只做内存读取；不调用 `MovingObject::GetPosition`（2026-10-16 崩溃实证）。 |
| 失效表现 | RTTI 被剥离/布局变化 → `no-rtti`/`no-name`，对象标签错误，OBJD 关联失败；误调用引擎虚函数 → 崩溃；对象指针失效 → 读取被 `VirtualQuery` 拒绝。 |
| 检测方法 | `NAT-RTTI`：`rtti_sample`、`class_names`、`no_rtti_count`、`watch_objects`、`watch_read_failures`；日志中的 `OBJW`/`OBJD`；只读内存守卫命中率。 |
| 降级策略 | RTTI 不可用 → 只保留调用计数/入参，不做对象观察；指针不可读 → 跳过；永不从 detour 调用引擎虚函数。 |
| 修复入口 | `fc_trace`、`profile.native.fc.rtti`。 |

#### C-34 原生模块版本 / export hash / manifest

| 字段 | 内容 |
|---|---|
| 当前位置 | `src/native/agradar_probe/aesa_agradar.c:240-270,710-714`（记录 `DCS.exe`/`Inter.dll`/`edterrain4.dll`/`edCore.dll`/`lua.dll` 版本；`lua.dll` 无版本信息）；`src/native/fc_probe/aesa_fc.c:164-192,201-204`（记录 `wRadio/Weapons/WorldGeneral/CockpitBase`）；`scripts/install_agradar_probe.cjs:97-102`、`scripts/install_fc_probe.cjs:29-31`（manifest 只校验 hook/dll 的 SHA256，没有引擎 export hash）。 |
| 依赖内容 | Windows FileVersion 资源；PE 导出表（模块名 + 符号名 + RVA）；DLL/hook 的 SHA256；engine 模块的 SHA256；`lua.dll` 无版本，必须用 hash。 |
| 失效表现 | 游戏更新但模块版本字符串不变（hotfix）→ 仅看版本漏检；导出表变化但符号名不变（RVA 变）→ `GetProcAddress` 仍成功，vtable/offset 可能已变；manifest 只校验自家 DLL，不校验引擎；旧 DLL/hook 混装 → 行为不一致。 |
| 检测方法 | `NAT-HASH`：`module_versions`、`module_sha256`、`exports_sha256`（按 `module!symbol=RVA` 排序后 hash）、`manifest_hook_hash`、`manifest_dll_hash`、`profile_exports_sha256`；`compat_check --detect` 读 PE 导出表（可用工作区 `.tools/mingw-root/mingw64/bin/objdump.exe -p`，或等价解析）。 |
| 降级策略 | 任一 hash 与 profile 不符 → `native_profile=mismatch`，原生只读；写路径关闭；agradar 查询返回 nil；报告具体模块/符号，不只报“版本不对”。 |
| 修复入口 | `scripts/compat_check.cjs`、`src/native/abi/dcs_profile.h`、`spec/dcs_profiles/*.json`。 |

### 3.7 RCS 数据库路径与 schema

#### C-35 RCS 数据来源、路径与生成器

| 字段 | 内容 |
|---|---|
| 当前位置 | `scripts/extract_rcs.py:17-23`（`RCS =`/`Name` 正则、跳过目录）、`:43-57`（前 12000 字符找最近 Name）、`:88-99`（输出 `src/adapters/dcs/rcs_data.lua`；fallback 已统一为 `fighter/large/helicopter/missile`）；`src/adapters/dcs/rcs_data.lua`（生成物，四档 fallback）；`src/adapters/dcs/rcs.lua`（精确 map + 四档 fallback + DCS 分类）；`src/core/rcs.lua`（纯接口 `new/passthrough`）；`src/core/init.lua`（不默认加载 DCS 数据）。 |
| 依赖内容 | DCS 安装目录下 `CoreMods/`、`Mods/` 的明文 Lua 资产；加密的 `Database.edce` 不解析；`RCS` 数值字段；`Name`/`displayName` 归属；生成文件 schema：`map[string]=number` + `fallback{fighter,large,helicopter,missile}`。 |
| 失效表现 | 重新生成后 `missile` 键消失 → `rcs.lua:35` 对导弹类型取 nil，运行时报错或导弹拿不到 RCS；新模块/新路径不在扫描范围 → 条目减少；Name 归属启发式变化 → 键错配；`RCS` 改为表达式/表 → 正则漏采；游戏更新后条目数变化但无人发现。 |
| 检测方法 | `DAT-RCS`：`schema_version`、`entry_count`、`fallback_keys`（必须四项）、`required_types_present`、`regenerate_diff`（生成器输出与仓库文件 diff）、`source_files_scanned`；本机当前基线 50 条。 |
| 降级策略 | schema 不合法/缺 fallback 键 → 拒绝加载或整体标 `rcs=unavailable`，不用默认 5 m² 冒充；条目缺失 → 对应 type 用 fallback 并标 `source=fallback-estimate`；导弹类别必须走 `missile` 档，不得落到 fighter。 |
| 修复入口 | `scripts/extract_rcs.py`、`src/adapters/dcs/rcs_data.lua`（生成物）、`src/core/rcs.lua`（接口）与 `src/adapters/dcs/rcs.lua`（DCS 分类）；Gate 1 第 1 项。 |

#### C-36 RCS 类型名匹配与覆盖率

| 字段 | 内容 |
|---|---|
| 当前位置 | `src/adapters/dcs/rcs.lua`（LARGE/HELI/MISSILE 正则、`data.map[name]` 精确匹配后按正则分档）；`src/adapters/dcs/rcs_data.lua` 的键是资产显示名（如 `F-15E S4+`、`A-10A`），不是 DCS type ID。 |
| 依赖内容 | `T` 行的 `obj.Name`（type name，如 `F-16C_50`）与 RCS map 键的命名一致性；模块更新/改名；第三方模组新增类型；导弹/炸弹命名前缀。 |
| 失效表现 | 新 type 不在 map → 落入 fighter 5 m²，导弹可能被当战斗机（检测距离偏大数倍）；命名大小写/后缀变化 → 精确匹配失败；分类正则误吞（例如 `C-101EB` 会命中 LARGE 的 `"C%-1"` 规则而被当大平台，具体顺序需逐条核对）。 |
| 检测方法 | `DAT-RCS-COV`：`known_type_coverage`（用真实任务 type 列表抽样）、`fallback_counts_by_class`、`missile_fallback_hits`、`unknown_type_ratio`；回放中对比不同 RCS 来源的检测距离。 |
| 降级策略 | 未覆盖类型 → 明确 `source=fallback-estimate`，并在遥测/页面标 `rcs_estimated=true`；导弹未命中 missile 档 → 报告 `rcs_classification=unknown`，不静默用 fighter；关键演示机型缺失 → 阻止“精确 RCS”结论。 |
| 修复入口 | `src/adapters/dcs/rcs.lua`、`scripts/extract_rcs.py`、`tests` 的 schema/coverage 测试。 |

### 3.8 Bazar / shaders / enlight / radar.fx 常量

#### C-37 radar.fx 的 DBS 参考常量

| 字段 | 内容 |
|---|---|
| 当前位置 | `src/sar_core/map.cjs:159-206`（注释给出 `radar.fx:138-176`、`:280`；`DBS_LAMBDA_M=0.03`、`DBS_OMEGA=0`、`DBS_FULL_CONE_DEG=45`；`dopConeRad` 的 `acos(...)-1e-7`）、`:531`（metadata 的 `port` 字符串含具体行号）；`docs/sar-in-mission.md:131`、`docs/sar-feasibility.md:144` 重复引用。 |
| 依赖内容 | `Bazar/shaders/enlight/radar.fx` 的 `blurRadialDBS`：`lambda = 0.03`（`:146`）、锥角公式（`:148`）、核宽 `x = k*teta_dopler/K*resolution*0.5`（`:164`）、调用点 `:280`；`Config/Effects/radar.lua` 的 `resolution` 预设 19/67/120。本项目只移植 lambda、锥角几何和收窄律，sinc 权重改为高斯，`omega=0`（无圆锥扫描）。 |
| 失效表现 | ED 改 lambda/公式/行号 → 本项目 DBS 锥角与锐化倍数偏差，图像“看起来正常但数值错”；`resolution=2*factor` 是项目约定，若误以为引擎 preset 变化会直接影响本项目，会过度反应；行号变化让注释/metadata 失真。 |
| 检测方法 | `GFX-RADARFX`：`radar_fx_sha256`、`lambda_regex`、`blur_function_present`、`line_anchors`、`preset_resolution_values`；当前基线 hash `719E3375...`，`Config/Effects/radar.lua` hash `4A5A6163...`。 |
| 降级策略 | hash/常量不匹配 → `dbs.shader_reference=unverified`，DBS 退化为实波束（`factor=1`），metadata 明示；不静默继续用旧 lambda；SAR 正常成像不受影响。 |
| 修复入口 | `src/adapters/dcs/data/shaders.lua`（Gate 3/5）、`profile.shader.radar_fx`、`spec/dcs_profiles/*.json`；`src/sar_core/map.cjs` 的常量改为从 `src/shared/config.cjs` 读取。 |

#### C-38 Config/Effects/radar.lua 预设与 radarFunc

| 字段 | 内容 |
|---|---|
| 当前位置 | 代码不读取该文件；仅在 `docs/research/dcs-mod-radar-survey.md:28,224-237` 与 `docs/sar-in-mission.md:131` 引用；`src/sar_core/map.cjs` 说明 `resolution` 的显示约定。 |
| 依赖内容 | `Config/Effects/radar.lua` 的 `EXP1/EXP2/EXP3`：`resolution=19/67/120`、`omega=1.13446`、`blankAngle=5.0`；`radarFunc.hlsl` 的 σ0 表、`1/R⁴`、Rayleigh 斑点、世界坐标哈希；这些是参考/对标，不是运行时输入。 |
| 失效表现 | 预设变化 → 文档/显示档位的“对标杆”失真；若未来把 preset 接进代码而没有 profile，会出现隐式耦合；不影响当前 SAR 物理计算。 |
| 检测方法 | `GFX-PRESET`：`radar_lua_sha256`、`exp_resolutions`、`omega`、`blank_angle`；与文档基线对比。 |
| 降级策略 | 仅标记 `reference=stale`；不改变运行时；若未来接入，必须走 profile/data，不得硬编码。 |
| 修复入口 | `src/adapters/dcs/data/shaders.lua`、`docs/research/` 更新、`spec/dcs_profiles`。 |

### 3.9 DCS build / module 差异

#### C-39 DCS build 与 MT/ST 变体

| 字段 | 内容 |
|---|---|
| 当前位置 | 当前安装 `bin/DCS.exe` 与 `bin-mt/DCS.exe` 均为 `2.9.30.28738`；`Saved Games/DCS/Logs/dcs.log` 第 6 行 `DCS/2.9.30.28738 (x86_64; MT; Windows NT 10.0.26200)`；`docs/status.md:79`（historical）仍写 `2.9.29`；原生注释 `aesa_agradar.c:62`、`aesa_fc.c:45,571` 写 `2.9.30.28738`；代码没有 build 闸门。 |
| 依赖内容 | `DCS.exe` FileVersion / `dcs.log` 的 `DCS/<build> (x86_64; MT/ST; ...)`；`bin` 与 `bin-mt` 两套 DLL/`lua-socket.dll`；模块版本与 SHA256；`lua.dll` 无版本资源。 |
| 失效表现 | 新 build 继续运行旧 ABI → 符号/vtable/offset 静默失效或崩溃；ST/MT 选错 `bin` → socket/terrain DLL 加载失败；只看版本字符串漏掉 hotfix；`docs/status.md` 的旧版本号误导排查。 |
| 检测方法 | `BUILD`：`dcs_build`、`dcs_variant`（MT/ST）、`dcs_exe_sha256`、`module_versions`、`module_sha256`、`profile_id`、`profile_verified`；`compat_check --detect` 先读 `dcs.log`，再读 PE/文件版本；探测 `lfs.currentdir()` 与 `package.cpath` 中 `bin`/`bin-mt`。 |
| 降级策略 | 无精确 profile → `profile=generic`，只读；`native=unavailable`；SAR 仅在 probe 证明 `terrain.GetHeight` 可用时启用；不把“版本号相同”当作“ABI 相同”；MT/ST 不明 → 禁止原生写。 |
| 修复入口 | `src/adapters/dcs/compat/profiles/dcs-<build>.lua`、`spec/dcs_profiles/*.json`、`src/native/abi/dcs_profile.h`、`scripts/compat_check.cjs`。 |

#### C-40 机型模块差异（F-16C / FC3 / 第三方）

| 字段 | 内容 |
|---|---|
| 当前位置 | `src/export/aesa_export.lua`（`PROTO,2` + 原始 DCS 姿态；`LoGetTargetInformation` 为 FC 时代接口，F-16C 等新模块不喂数据——实测）、`:279-281`（每 5 s E-diag）；`src/adapters/dcs/rcs.lua`（按机型名分类）。 |
| 依赖内容 | 不同机型模块对 `LoGetSelfData`、`LoGetTargetInformation`、`LoGetLockedTargetInformation`、`LoIsSensorExportAllowed` 的填充不同；`T` 行的 `Name` 是 type name；第三方模组可能改 RCS/传感器/导出行为；FC3 与全保真模块的座舱/数据链差异。 |
| 失效表现 | 换机型后 E 行消失/出现，误判为“雷达性能变化”；SelfData 字段缺失（某些模块无 Heading？需 probe）；RCS 名称不匹配；第三方模组改 `Weapons.dll`/`wRadio.dll` 行为，原生 trace 结论不适用。 |
| 检测方法 | `MODULE`：`own_type`、`own_module`、`engine_contacts_available`、`selfdata_fields`、`rcs_lookup_source`；在 F-16C 与至少一个 FC3 机型各跑一次 probe；按模块记录能力。 |
| 降级策略 | 机型能力不同 → `profile.modules.<type>` 覆盖；E 行缺失不影响 A/A 真值；第三方模组环境 → `native=unverified`，只读，不把单机型结论外推。 |
| 修复入口 | `profile.modules`、`src/adapters/dcs/api/export.lua`、`src/adapters/dcs/rcs.lua`。 |

#### C-41 地形地图差异

| 字段 | 内容 |
|---|---|
| 当前位置 | `src/export/sar_dcs_env.lua`（GetHeight/GetSurfaceType 能力门禁）；`src/adapters/dcs/api/export.lua`（实际 `terrain.*` 调用）；`src/scene/sar_mission_env.lua`（`land.getSurfaceType`）；`docs/dcs-map-terrain-interfaces.md:9-25` 记录接口边界；`src/sar_core/materials.cjs` 的 16 类材质是项目假设，不是地图数据。 |
| 依赖内容 | 不同地图（Caucasus/NTTR/Syria/Mariana 等）的地形高度、水面/地表分类、建筑/植被覆盖；`terrain.GetHeight` 是否覆盖全图；`land.getSurfaceType` 的五类语义；地图模组/第三方地形。 |
| 失效表现 | 某地图 `GetHeight` 在边界外返回 nil → MAP 采集 `terrain_query_failed`；水面类别不同 → `sea/river/lake` 误判；建筑/森林覆盖差异 → SAR 材质假设偏差；地图更新改变地形 → 历史 mosaic 对不上。 |
| 检测方法 | `MAP`：`terrain_name`、`height_probe_points`、`surface_probe_points`、`water_class_values`、`coverage_ratio`；每张地图至少 3 个已知点（陆地/水面/跑道）；记录地图版本/hash。 |
| 降级策略 | 未验证地图 → `map=unverified`，SAR 允许采集但 metadata 标 `surface_confidence=low`；水面/建筑未知 → `unknown`；不把一套地图的阈值外推到另一套。 |
| 修复入口 | `profile.terrain.maps`、`src/adapters/dcs/data/surfaces.lua`、`spec/dcs_profiles`。 |

#### C-42 已装模组、DCS 变体与完整性

| 字段 | 内容 |
|---|---|
| 当前位置 | `scripts/extract_rcs.py:20-23` 扫描 `CoreMods/Mods`；原生探针解析 `Weapons.dll`/`wRadio.dll`/`WeaponBlocks.dll`；`AGENTS.md` 记录“部分 MP 服务器完整性校验会拒绝修改过的客户端”；部署脚本只写 Saved Games。 |
| 依赖内容 | 已装机型/地景/第三方模组；模组可能替换同名 DLL 或新增资产；DCS 更新会还原安装目录改动；MP 服务器可能校验客户端文件。 |
| 失效表现 | 模组更新 → RCS 条目/符号变化；同名 DLL 被替换 → 原生 ABI 不匹配；MP 完整性校验拒绝 → 功能不可用；安装目录被更新还原 → 深度集成失效。 |
| 检测方法 | `MODS`：`installed_modules`、`mod_manifests`、`module_sha256`、`rcs_source_dirs`、`mp_integrity`（仅记录，不承诺）；`compat_check` 报告“非官方模块”清单。 |
| 降级策略 | 非官方/未验证模块 → `native=unverified`，只读；MP 环境 → 默认关闭原生写；不把单机结果当 MP 结论；发布包不包含逆向产物。 |
| 修复入口 | `profile.mods`、`compat_check`、部署文档；Gate 6 的安装冲突检测。 |

---

## 4. 兼容层设计

### 4.1 边界与不变量

1. **单一来源**：`spec/dcs_profiles/dcs-<build>.json` 是 profile 的事实源；`src/adapters/dcs/compat/profiles/dcs-<build>.lua`、`src/native/abi/dcs_profile.h` 是生成物（生成前可手工维护，但必须带 `DO NOT EDIT` 后的 generator/hash）。
2. **业务代码不直接判断版本**：`src/core`、`src/sar_core`、`tools/sar_service`、viewer 不得出现 build 字符串、模块名、`LoGet*`、vtable/offset。
3. **游戏 API 单点**：所有 `LoGet*`、`terrain.*`、`world.*`、`land.*`、`net.dostring_in`、`package.loadlib`、`lfs` 只在 `src/adapters/dcs/api/` 与 `compat/probe.lua` 的注入接口中出现。
4. **未知不等于默认**：任何能力缺失必须返回 `unavailable`/`unknown`，不得用 0、false、5 m²、平面地形、Country 编号等“看起来合理”的值。
5. **probe 只读**：探针不写任务状态、不启 `allow_unsafe_api`、不修改 `autoexec.cfg`、不调用原生写路径；原生写路径只在显式配置 + profile 匹配时启用。
6. **可离线复现**：`compat_check` 只读文件/日志/PE 元数据；不需要启动 DCS 也能对已采集的 probe 结果做 diff。
7. **旧 peer 兼容**：新增能力走“只增字段/未知行忽略”，不改变既有行数/字段位置；协议版本号独立于 DCS build。
8. **D2 边界**：`src/sar_core` 只接收 `shader`/`surface` 常量作为输入，不知道 DCS build、`radar.fx` 路径或模块名；这些由 `src/adapters/dcs/sar_adapter.cjs` 从 profile 注入。
9. **D3 边界**：`/state` 只回摘要（含 `compat` 段），图像仍走 `/image/<seq>` 或 `/snapshot`；`compat` 不带能力全矩阵。
10. **D4 边界**：`fc_trace` 只读、`fc_inject` 写；默认只加载/启用只读侧；写侧必须显式配置 + profile 校验 + 长度/范围检查。
11. **D1 边界**：核心使用通用 ENU；DCS `x/y/z`、`Heading + π/2`、MSL 高度只在 `src/adapters/dcs/frame.lua` 转换，probe/profile 不把 DCS 朝向语义带进核心。

### 4.2 `src/adapters/dcs/compat/profiles/dcs-<build>.lua`

**状态：已实现（生成物，2026-10-18）。** 事实源是 `spec/dcs_profiles/*.json`，由 `scripts/gen_config.cjs` 生成。

数据文件，Lua 5.1 表，不执行 IO/不 require。结构（字段名固定）：

```lua
return {
  schema = 1,
  id = "dcs-2.9.30.28738-mt",
  build = "2.9.30.28738",
  variant = "MT",                       -- "MT" | "ST" | "unknown"
  verified = "2026-10-17",
  evidence = { "docs/dcs-compat.md#3", "tests/baseline/compat.json" },
  modules = {
    DCS       = { version = "2.9.30.28738", sha256 = "47156201..." },
    Inter     = { version = "2.9.30.28738", sha256 = "FBFA21CD..." },
    edterrain4= { version = "2.9.30.28738", sha256 = "8DD15857..." },
    -- ...
  },
  export = {
    callbacks = { after_next_frame = true, activity_next_event = "passthrough" },
    fields = {
      self = { position = "Position", heading = "Heading", pitch = "Pitch", bank = "Bank" },
      world_object = { coalition_id = "CoalitionID", country = "Country", coalition = "Coalition" },
      target = { id = "ID", position = "position", distance = "distance" },
    },
    apis = {
      self_data = true, world_objects = true, vector_velocity = true,
      target_information = false, locked_target_information = false,
      sensor_export_allowed = true, model_time = true,
    },
    geo = { forward = "LoGeoCoordinatesToLoCoordinates", inverse = "LoLoCoordinatesToGeoCoordinates", order = "lon,lat" },
    terrain = { get_height = true, get_surface_type = true, is_visible = true },
  },
  mission = {
    bridge = { "net.dostring_in(scripting)", "net.dostring_in(mission)+a_do_script" },
    land = { get_surface_type = true, get_height = true, is_visible = false },
    world = { search_objects = true, volume_box = true, categories = { "SCENERY", "STATIC", "UNIT" } },
    objects = { get_position = true, get_desc_box = true, get_velocity = true, in_air = true },
    events = { shot = true, hit = true, add_event_handler = true },
    timer = { get_time = true, schedule_function = true },
  },
  native = {
    agradar = {
      symbols = { "?GetDefaultTerrain@...", "..." },
      vtable_slot = 19,
      point_on_surface_offset = 0x38,
      surface_bits = { [0]="Land", [2]="Runway", --[[ ... ]] },
      exports_sha256 = "...",
    },
    fc = {
      symbols = { --[[ 17 个 module+mangled ]] },
      sites = { --[[ 13 个 site ]] },
      offsets = { pos=0x1a8, vel=0x1c0, aim=0x220, tgo=0x170, r0=0x178, range=0x180 },
      write = false,                    -- 默认只读
    },
  },
  data = {
    rcs_schema = 1, rcs_entries = 50,
    rcs_required_fallbacks = { "fighter", "large", "helicopter", "missile" },
    surface_classes = 16,
  },
  shader = {
    radar_fx_sha256 = "719E3375...",
    dbs_lambda = 0.03, dbs_omega = 0.0, dbs_full_cone_deg = 45,
  },
}
```

规则：

- `id` 唯一，格式 `dcs-<build>[-<variant>]`；`build` 必须与 `dcs.log` 的 `DCS/<build>` 完全一致。
- 缺失的能力键 = `unknown`，不是 `false`；显式 `false` 才表示“已验证不存在”。
- profile 只描述“能力与数据”，不写业务策略；例如 `terrain.get_height=true` 不意味着 SAR 一定启用，SAR 还要看 `vector_velocity`。
- 加载顺序：`dcs-<build>-<variant>` → `dcs-<build>` → `dcs-generic`；没有精确 profile 时 `dcs-generic` 只允许只读能力。
- 禁止在一个 profile 里用 `if build >= ...` 的版本区间逻辑；每个 build 一个文件，差异显式列出。

### 4.3 `src/adapters/dcs/compat/profile.lua`

**状态：已实现（2026-10-18）。** 纯 Lua 5.1，不 require DCS API、不读文件；由适配器注入 profile 表。

API 草案：

```lua
local P = {}
function P.new(profile, source) end          -- 校验 schema/id/build；返回实例
function P:cap(key) end                      -- "ok"|"degraded"|"unavailable"|"unknown"
function P:get(path, default) end            -- 例：get("export.fields.world_object.coalition_id")
function P:field(group, name) end            -- 字段名或 nil
function P:api(key) end                      -- 布尔能力；不返回函数
function P:require(key) end                  -- ok 返回 true；否则 error{code="capability", key=...}
function P:matrix() end                      -- 稳定排序的 {key=state} 数组
function P:matrix_hash() end                 -- FNV-1a 32，8 位小写 hex；Lua/JS 共享测试向量
function P:id() end
```

约束：

- `profile.lua` 不做能力探测；探测是 `probe.lua` 的职责，profile 只提供“预期”。
- `profile.lua` 不缓存全局状态；每个 Lua 状态各自实例化，避免 Export/Hooks 互相污染。
- `matrix_hash` 算法必须与 `compat_check.cjs` 一致；测试向量固定 3 组，Lua/JS 各跑一遍。FNV-1a 32 的乘法在 Lua 5.1 用 16 位拆分实现，避免 2^53 精度问题。
- 缺 profile/缺 schema/缺 id → 返回 `dcs-generic` 实例并标 `profile_source=fallback`；不抛到业务层，但 `require` 全部 required 能力失败。

### 4.4 `src/adapters/dcs/compat/probe.lua`

**状态：已实现，实机未运行（2026-10-18）。** 纯 Lua 5.1，接收“环境适配表”，返回能力矩阵；不直接访问全局，便于在 Export/任务/Hook 三种状态复用和离线测试。

```lua
local probe = {}
function probe.run(profile, api, opts) end
-- api = {
--   kind = "export"|"mission"|"hook",
--   globals = { ... },        -- 由 api/*.lua 注入的安全引用
--   call = function(name, ...) end,  -- 统一 pcall 包装
--   now = function() end,
-- }
-- return {
--   profile_id = "...",
--   facts = { build=..., variant=..., own_type=..., module_versions={...}, ... },
--   caps = { ["EXP-SELF"]={state="ok", detail="..."}, ... },
--   errors = { {key=..., err="..."} },
-- }
```

探测规则：

- 每个能力独立 `pcall`；一个失败不影响其他。
- 只做类型/存在性/小样本检查：`world.searchObjects` 用 2 km 盒、优先以任务态第一个单位位置为锚点（取不到再用机场），只计数不落库；`land.getSurfaceType` 只查 1 个点；不跑全图。
- 不修改任何全局；不注册永久事件；不启动 socket 服务。
- 结果按 key 排序；`caps` 只含本次实际探测的 key；`unknown` 不写入 `ok`。
- 失败详情截断到 200 字符，避免日志爆炸。
- 在任务态，probe 由 `sar_scene_core` 暴露为 `AESA_SAR_SCENE.probe_compat()`；Hook 通过任务态桥调用并取回 `CAP,COMPAT,...` 行。
- 在 Export 态，probe 在 `LuaExportStart` 后第一帧、以及每 60 s 运行一次；结果写 `Scripts\AESA\probe-export.log`。
- 在 Hook 态，probe 在 `onSimulationStart` 后运行一次，写 `Scripts\AESA\probe-hook.log`；原生探针的符号结果从 DLL 返回值/日志合并。

输出行（便于 C/JS/Python 解析，不依赖 JSON 库）：

```text
COMPAT_BEGIN,<profile_id>,<matrix_hash>
CAP,<key>,<ok|degraded|unavailable|unknown>,<detail>
FACT,<name>,<value>
COMPAT_END,<cap_count>
```

解析器只在 `COMPAT_BEGIN`/`COMPAT_END` 之间读取 `CAP`，场景协议自身的 `CAP` 行不混入。限制：单行 ≤ 512 字节；`detail` 不含逗号/换行；`FACT` 值做转义。`compat_check` 同时接受此格式和原生日志的 `sym ... resolved/MISSING`。

### 4.5 `src/native/abi/dcs_profile.h`

**状态：已生成（2026-10-18）；原生 `aesa_profile_check()` 尚未接入。** 由 profile 生成，`DO NOT EDIT`，供 `agradar_probe`、`fc_trace`、`fc_inject` 共用。内容至少：

```c
#define AESA_DCS_PROFILE_ID        "dcs-2.9.30.28738-mt"
#define AESA_DCS_PROFILE_SCHEMA    1
#define AESA_DCS_BUILD             "2.9.30.28738"
#define AESA_DCS_VARIANT_MT        1
#define AESA_DCS_EXPORTS_SHA256    "..."   /* 排序后的 module!symbol=RVA 摘要 */

#define AESA_AGR_VTABLE_SLOT       19
#define AESA_AGR_POINT_SURFACE_OFF 0x38
#define AESA_AGR_SURFACE_CLASSES   16

#define AESA_FC_OFF_POS            0x1a8
#define AESA_FC_OFF_VEL            0x1c0
#define AESA_FC_OFF_AIM            0x220
#define AESA_FC_OFF_TGO            0x170
#define AESA_FC_OFF_R0             0x178
#define AESA_FC_OFF_RANGE          0x180

static const char *const AESA_AGR_SYMBOLS[] = { ... };
static const char *const AESA_FC_SYMBOLS[] = { ... };
static const char *const AESA_FC_SITE_SYMBOLS[] = { ... };
```

运行时自检 `aesa_profile_check()`（伪代码）：

1. `GetModuleHandle` 检查 profile 要求的模块；
2. 对每个模块比对 FileVersion 与 SHA256（`lua.dll` 只比 hash）；
3. `GetProcAddress` 每个符号；记录缺失；
4. agradar：比较 `vt[19]` 与 `GetProcAddress(getPointOnSurface)`；不等 → 失败，不再“属于 edterrain4 就调用”；
5. fc：检查 13 个 site 的符号、签名 hash、偏移 sanity（只读采样）；
6. 返回位掩码：`FULL` / `READ_ONLY` / `MISMATCH` / `MISSING`；
7. `MISMATCH/MISSING` 时：`fc_inject` 不加载，`fc_trace` 只装完整 site，`agradar` 查询返回 nil。

生成关系：

```text
spec/dcs_profiles/dcs-<build>.json
        │  scripts/gen_config.cjs（Gate 2）
        ├── src/adapters/dcs/compat/profiles/dcs-<build>.lua
        └── src/native/abi/dcs_profile.h
```

生成物头部必须含 `DO NOT EDIT`、generator、profile hash；`gen_config --check` 零 diff。

### 4.6 `scripts/compat_check.cjs`

**状态：已实现（离线 fixture A/B/C/blocked，2026-10-18）；实机日志未采集。** 只读检查器 + 基线 diff 工具；不写 DCS 安装目录，不启动 DCS。

CLI：

```bash
node scripts/compat_check.cjs --record tests/baseline/compat.json
node scripts/compat_check.cjs --detect --diff tests/baseline/compat.json
node scripts/compat_check.cjs --detect --json out/compat.json
node scripts/compat_check.cjs --emit-profile dcs-2.9.30.28738 --out spec/dcs_profiles/
```

`--record`：读取当前 probe 日志 + 原生日志 + 文件指纹，生成规范化基线；不修改任何部署。
`--detect`：读取最新一次 probe 结果与静态指纹，输出矩阵；不清空旧日志。
`--diff`：与基线比较，分类并返回退出码。
`--emit-profile`：从当前矩阵生成 profile 骨架（仍由人复核 `verified`）。

输入：

| 来源 | 内容 |
|---|---|
| `Saved Games/Scripts/AESA/probe-export.log` | Export 能力行 |
| `Saved Games/Scripts/AESA/probe-hook.log` | Hook/任务/原生能力行 |
| `Saved Games/Logs/AESA/AGR/agradar_native.log` | agradar 符号、模块版本、16/16 校验 |
| `Saved Games/Logs/AESA/fc_native.log` | fc 17 符号、模块版本 |
| `Saved Games/Logs/dcs.log` | `DCS/<build> (x86_64; MT/ST; ...)` |
| `Saved Games/Scripts/Export.lua` | 标记块、加载顺序 |
| DCS 安装目录 | `DCS.exe`、`bin`/`bin-mt` 模块版本 + SHA256、`Bazar/shaders/enlight/radar.fx`、`Config/Effects/radar.lua` |
| 仓库 | `src/adapters/dcs/rcs_data.lua` schema/count、manifest hash、profile 文件 |

检查项：

| 检查 ID | 内容 | required 条件 |
|---|---|---|
| `BUILD` | build/variant/`DCS.exe` hash | 精确 profile 或 generic |
| `EXP-LOAD` | Export 标记/dofile/编码 | A/A、SAR |
| `EXP-AFTER` | `AfterNextFrame` 存在且被调用 | A/A、SAR |
| `EXP-ACT` | `ActivityNextEvent` 透传安全 | 否 |
| `EXP-SELF` | SelfData/姿态字段 | A/A |
| `EXP-VEL` | `LoGetVectorVelocity`/速度可信 | SAR、Doppler |
| `EXP-WORLD` | `LoGetWorldObjects` + `CoalitionID` | A/A |
| `EXP-TGT` | 引擎接触 | 否 |
| `EXP-TIME` | `LoGetModelTime` | A/A、SAR |
| `EXP-GEO` | 正/逆变换 + 参数顺序 | 地理模式 |
| `EXP-ALT` | 高度诊断 | 否 |
| `TER-GH` | `terrain.GetHeight` | SAR |
| `TER-GST` | `terrain.GetSurfaceType` | 地表/MAP |
| `TER-VIS` | `terrain.isVisible` | 可见性 |
| `WLD-SEARCH` | `world.searchObjects`/Volume/Category | 场景对象、GMTI |
| `LND-SURF` | `land.getSurfaceType` | 场景桥 |
| `MSN-DOSTRING` | `net.dostring_in`/`a_do_script` | 场景桥、FC 注入 |
| `MSN-COAL` | `coalition.*` / `controller` | 任务生成/AI 控制 |
| `MSN-LIFE` | 任务全局/生命周期 | 场景桥 |
| `HOOK-CB` | `DCS.setUserCallbacks`/模型时间 | 原生、场景 Hook |
| `IO-SOCK` | LuaSocket | 传输 |
| `IO-LFS` | `lfs.writedir` | 日志/原生路径 |
| `IO-LOADLIB` | 原生导出 | 原生 |
| `IO-LOG` | 日志可写/体积 | 否 |
| `NET-PORT` | 端口/握手/协议 | 传输 |
| `NAT-AGR-SYM` | agradar 4 符号 | agradar |
| `NAT-AGR-VT` | vtable 19 / +0x38 | agradar |
| `NAT-AGR-MASK` | 16 类/哨兵 | 细类地表 |
| `NAT-FC-SYM` | fc 17 符号 | fc |
| `NAT-FC-SITES` | 13 site | fc trace |
| `NAT-FC-OFF` | 偏移 sanity | fc inject |
| `NAT-HASH` | 模块/导出 hash | 原生 |
| `DAT-RCS` | RCS schema/fallback | A/A |
| `DAT-RCS-COV` | 类型覆盖率 | 精度结论 |
| `GFX-RADARFX` | radar.fx hash/lambda | DBS |
| `GFX-PRESET` | radar.lua 预设 | 参考 |
| `MODULE` | 机型能力 | 机型相关结论 |
| `MAP` | 地图能力 | SAR 地图结论 |
| `MODS` | 已装模组/完整性 | 发布/MP 结论 |

diff 规则：

- 归一化键为 `check.key`；值为 `ok|degraded|unavailable|unknown` + `detail`。
- `ok → ok` 且 detail 变化：`info`。
- `ok → degraded/unavailable`：若 key 在 required 集合 → `incompatible`；否则 `degraded`。
- `unavailable → ok`：`improved`，提示更新 profile。
- 基线缺失的 key：`added`，需要人工确认是“新能力”还是“漏检”。
- `BUILD`/`NAT-HASH` 变化但能力全 ok：仍要求更新 profile 的 build/hash，不能直接 Green。
- 同一 check 连续两次运行结果不同：`flaky`，按 blocked 处理，不判 Green。

输出 JSON（稳定排序）：

```json
{
  "schema": 1,
  "generated_at": "2026-10-17T00:00:00Z",
  "build": "2.9.30.28738",
  "variant": "MT",
  "profile_id": "dcs-2.9.30.28738-mt",
  "matrix_hash": "1a2b3c4d",
  "level": "A|B|C|blocked",
  "required": ["EXP-SELF", "..."],
  "caps": {"EXP-SELF": {"state": "ok", "detail": ""}, "...": {}},
  "diffs": [{"key": "TER-GH", "before": "ok", "after": "unavailable", "class": "incompatible"}]
}
```

退出码：`0` 完全兼容；`2` 降级；`3` 不兼容；`4` blocked/probe 缺失；`1` 用法错误。

### 4.7 握手与 `/state.compat`

- A/A：连接后先发 `V1`，再发 `COMPAT,<profile_id>,<matrix_hash>`；接收端未知行忽略。
- SAR：`HELLO,SAR1` 后 `CAPS,2,...` 增加一行 `COMPAT,...`；旧服务忽略未知行。
- 场景：`HELLO,SARSCENE1` 后 `CAP,...` 增加 `COMPAT,...`；`tools/sar_bridge.cjs` 对未知行跳过。
- `/state` 增加：

```json
"compat": {
  "profile_id": "dcs-2.9.30.28738-mt",
  "build": "2.9.30.28738",
  "variant": "MT",
  "matrix_hash": "1a2b3c4d",
  "level": "A",
  "missing": [],
  "degraded": ["TER-VIS"]
}
```

- 页面只显示摘要；完整矩阵在 `probe-*.log`/`compat_check` 输出。
- 旧 viewer 不认识 `compat` 字段时忽略；不改变既有字段。

### 4.8 所有权矩阵

| 知识 | 所有者 | 消费者 |
|---|---|---|
| build/variant/module 版本/hash | `compat_check` + profile | `profile.lua`、`dcs_profile.h` |
| 字段名（CoalitionID 等） | profile | `api/export.lua`、sampler |
| 回调 quirk | profile + `api/export.lua` | export/scene |
| 任务桥 provider | profile + `api/mission.lua` | scene hook |
| 原生符号/vtable/offset | profile → `dcs_profile.h` | agradar/fc |
| RCS schema/coverage | extractor + generated data | rcs adapter/core |
| radar.fx 常量 | profile + `data/shaders.lua` | SAR DBS |
| 协议能力/端口 | `spec/protocol.json` | export/service/viewer |

---

## 5. 游戏更新后的标准流程

> Gate 0 不执行 git commit/tag/checkout/reset；以下“冻结基线”在后续 Gate 按仓库规则执行。

### 步骤 0：冻结基线

1. 记录当前分支、commit、`pre-arch-refactor` tag。
2. 运行必跑套件并保存结果：`python tests/run_tests.py`、`python tests/test_review_regressions.py`、`node --test tests/test_sar_*.cjs`；原生可用时 `python tests/test_agradar_probe_dll.py`、`python tests/test_fc_probe_dll.py`。
3. 运行 `node scripts/compat_check.cjs --record tests/baseline/compat.json`，保存当前 build、模块 hash、能力矩阵。
4. 复制当前 `probe-export.log`、`probe-hook.log`、`agradar_native.log`、`fc_native.log` 到基线目录；不要覆盖旧日志。
5. 不修改任何代码/部署；只读采集。

### 步骤 1：启动探针

1. 确认部署的 Export/SAR/场景/原生文件与 manifest hash 一致（`status/verify`）。
2. 启动 DCS，进入一个已知地图/机型的开发任务；至少飞行 30 s，触发一次 SAR 采集、一次场景对象查询、一次原生 poll。
3. 读取 `probe-export.log`、`probe-hook.log`、原生日志；确认 `COMPAT_END`、`CAP` 行完整。
4. 如果 DCS 无法启动/日志缺失，直接判 `blocked`，不进入分类。

### 步骤 2：`compat_check --detect --diff`

```bash
node scripts/compat_check.cjs --detect --diff tests/baseline/compat.json
```

- 先看 `BUILD`：新 build 是否与当前 profile 的 `build` 一致；variant 是 MT 还是 ST。
- 再看 required 能力：`EXP-SELF`、`EXP-WORLD`、`EXP-AFTER`、`TER-GH`、`EXP-VEL`、`MSN-DOSTRING`、`NAT-*` 中与本次功能相关的项。
- 再看 native hash/vtable/offset；任何 mismatch 都按 C 类处理，不先改业务代码。
- 旧日志时间戳早于本次启动的，不纳入判定；probe 必须带 session id 或启动时间。

### 步骤 3：分类

| 分类 | 条件 | 动作 |
|---|---|---|
| A 完全兼容 | 所有 required `ok`；native profile 匹配；无 unknown required；diff 无 `incompatible` | 更新 profile 的 build/verified/hash；`--record` 新基线；进入回归 |
| B 降级 | required 仍 `ok`；optional `degraded/unavailable`；降级路径已在 profile 声明 | 只启用允许的功能；更新 profile 的降级字段；页面/日志明示；进入回归 |
| C 不兼容 | required 缺失/无法安全降级；native mismatch；vtable/offset 不可验证；probe 缺失 | 停用受影响功能（SAR/场景桥/注入/agradar）；保留只读；不更新 `verified`；记录 blocked/Red；不继续迁移 |
| blocked | DCS 不可启动、日志缺失、探针未部署 | 不判 Green；补环境后重跑 |

分类必须以 `compat_check` 的退出码/JSON 为准，不能凭“飞起来看起来正常”。

### 步骤 4：只改 profile/数据

按变化类型选择修改点，不改业务代码：

| 变化 | 修改 |
|---|---|
| 仅 build 字符串/模块版本 | `spec/dcs_profiles/dcs-<build>.json` 的 `build/modules/verified`；重生成 Lua/H |
| 字段改名 | profile 的 `export.fields`；`api/export.lua` 已按 profile 取值 |
| API 缺失 | profile 的 `apis/terrain/mission` 置 false；启用已有降级分支 |
| 原生符号/RVA/offset 变化 | profile 的 `native.*`；重生成 `dcs_profile.h`；仅当算法/调用约定变化才改 native 代码 |
| RCS 数据变化 | `scripts/extract_rcs.py` 重新生成；schema/coverage 测试 |
| `radar.fx` 常量变化 | profile 的 `shader.*` + `data/shaders.lua`；DBS 可先降级为实波束 |
| 新机型/新地图/新模组 | profile 的 `modules/maps/mods`；补 probe 点 |

如果必须改业务代码才能适配，说明这不是“版本兼容”而是“新能力/新行为”，应单独立项、写 ADR，不在更新当日热修。

### 步骤 5：回归

1. `node scripts/compat_check.cjs --detect --diff tests/baseline/compat.json`：A/B 类必须无 `incompatible`；B 类的每个降级项有 reason。
2. `node scripts/test_all.cjs`（Gate 0 建立）：单元/契约/集成全绿；skip 有原因。
3. 回放：`python tools/replay.py recordings/flight3-final.aesarec --dt 0.05 --seed 42`，与基线一致；`flight9` 无新增假航迹。
4. SAR：128/512/2048 档与基线逐像素 0 或 ≤1 LSB；PFA/点响应在阈值内；`/state` 摘要 <4 KB。
5. `node scripts/audit_repo.cjs` 零 error；`git status` 干净（后续 Gate）。
6. 同一命令连跑 3 次，任一失败即 Red。

### 步骤 6：实机

1. 进 DCS：Export 10 Hz、`export_diag.log` 无 error/重连风暴；SAR 出图；场景对象/GMTI 能力串正确。
2. 原生：默认只读；`fc_inject` 未显式启用时不可达；符号/vtable/offset 日志与 profile 一致。
3. 失败即回滚到上一 profile/部署；不留下半兼容状态。

### 步骤 7：记录

- 本机 `worklog/<YYYY-MM>/<YYYY-MM-DD>_<HHMM>_compat-<build>.md`（gitignored，不提交）：build、variant、模块 hash、probe 矩阵、diff、分类、改动文件、回归结果、遗留。
- 更新 `docs/status.md` 的当前 build（或明确标历史）。
- 更新 `tests/baseline/compat.json` 仅在该 build 被接受为 A/B 后。

---

## 6. fail-closed 规则

### 6.1 总则

- 能力状态只有四种：`ok`、`degraded`、`unavailable`、`unknown`。
- `unknown` 不允许被消费者当成 `ok`/`false`/`0`；消费者必须显式处理或拒绝。
- 任何“默认值”必须带来源标签（`source=default`、`source=fallback-estimate`、`source=unknown`），且不得进入精确结论。
- 原生写路径的默认是关闭；只有 profile 匹配 + 显式配置 + 长度校验通过才可写。

### 6.2 必须 fail-closed 的项

| 缺失/变化 | 判定 | 行为 | 禁止 |
|---|---|---|---|
| 缺 `CoalitionID`（或非 1/2） | `EXP-WORLD=degraded` | 目标 `coalition=0`，IFF `unknown`；T 行保留位置/名称 | 用 `Country`/`Coalition` 字符串推断阵营 |
| 缺速度（`LoGetVectorVelocity` 或对象 velocity） | `EXP-VEL=unavailable` | `vel_valid=false`，速度 0；A/A 只位置；SAR 拒绝采集；Doppler/GMTI 标不可用 | 实时差分冒充真实速度；用 0 速度算多普勒 |
| 缺 `terrain.isVisible` | `TER-VIS=unavailable` | 不发 L 行；`visibility=unknown`；只保留球面视距并标注 | 默认 visible=true；用任务 `land.isVisible` 冒充逐目标可见性 |
| 缺 `net.dostring_in`（且无 `a_do_script`） | `MSN-DOSTRING=unavailable` | 场景桥 `unavailable`；FC 注入不可用；Export-only 继续 | 探针自行开启 `allow_dostring_in`/`allow_unsafe_api`；用文件/网络后门 |
| 缺 `terrain.GetHeight` | `TER-GH=unavailable` | SAR/MAP/DBS 拒绝；A/A 继续 | 平面地形、0 高程、椭球高、`LoGetAltitude` 代替 |
| 原生 profile 不匹配 | `NAT-HASH=mismatch` | `native=read_only`；`fc_inject` 不加载；agradar 查询 nil；只保留完整解析的只读 trace | 加载写 DLL；调用未验证 vtable/offset；用“版本号相同”放行 |
| 缺 `LoGetSelfData`/`Position` | `EXP-SELF=unavailable` | 不发 A/T/O；SAR `no_ownship` | 伪造本机位置/姿态 |
| 缺 `LoGetWorldObjects` | `EXP-WORLD=unavailable` | A/A 无目标；不生成 T 行 | 用引擎接触/E 行冒充真值 |
| 缺 `LoGetModelTime` | `EXP-TIME=unavailable` | 不采样；SAR 不可用 | 用墙钟当仿真时间 |
| 缺 `terrain.GetSurfaceType` | `TER-GST=unavailable` | 地表 `unknown`；高程/几何继续 | 猜 land/sea；把 `unknown` 当 land |
| 缺 `world.searchObjects` | `WLD-SEARCH=unavailable` | 场景对象/ GMTI 为空并带 provider=unavailable | 返回空数组冒充“没有物体” |
| 缺 `land.getSurfaceType` | `LND-SURF=unavailable` | 场景桥整体 `unavailable` | 用 `world` 对象推断地表 |
| 缺 `coalition.*` / `controller` | `MSN-COAL=unavailable` | 任务生成/AI 控制关闭；只读统计可退回 Export | 伪造 Group/Controller；直接改任务表；把 Export `CoalitionID` 当任务 `coalition` |
| 缺 LuaSocket | `IO-SOCK=unavailable` | 传输不可用；退避；明确报错 | 忙等/刷日志/改未知 cpath |
| 缺 `lfs` | `IO-LFS=unavailable` | 不做路径猜测；安装器必须显式目标 | 硬编码用户目录 |
| 缺原生导出/DLL | `IO-LOADLIB=unavailable` | 原生功能关闭；agradar 退回五类；FC 只读/不可用 | 覆盖未知 DLL；从安装目录加载来路不明副本 |
| RCS schema 缺键/生成失败 | `DAT-RCS=unavailable` | 拒绝加载或整体标不可用；关键类型无精确 RCS | 用 5 m² 默认值静默兜底 |
| `radar.fx` hash/常量不匹配 | `GFX-RADARFX=unverified` | DBS 退化为实波束；metadata 标 `shader_reference=unverified` | 静默沿用旧 lambda/公式 |
| build 无 profile | `BUILD=generic` | 只读；原生关闭；仅 probe 证明的能力可用；SAR 需逐项证明 | 自动生成 `verified`；按版本区间猜能力 |
| vtable 槽位函数 ≠ 导出地址 | `NAT-AGR-VT=mismatch` | 返回 nil；不调用 | “属于 edterrain4 就调用” |
| 偏移/长度校验失败 | `NAT-FC-OFF=mismatch` | 禁止写；只读 trace | 继续写 +0x220；跨页读 |
| 任务全局/版本不匹配 | `MSN-LIFE=unavailable` | 清空 job；拒绝 step；重连 | 复用旧 `AESA_SAR_SCENE` |
| 日志/探针缺失 | `blocked` | 不判 Green；补采 | 用历史日志当本次证据 |

### 6.3 状态传播

```text
probe (raw facts)
   → profile.cap(key) (expected vs actual)
   → feature gate (A/A, SAR, scene, native)
   → handshake COMPAT / /state.compat
   → compat_check level (A/B/C/blocked)
```

- 功能 gate 只能读取 `profile.cap`，不能自己再判断 API 是否存在；否则同一能力会出现两套真值。
- `degraded` 必须带 `reason` 和 `since`（build/日期）；`unavailable` 必须带 `missing` 列表。
- 所有降级在 UI/日志可见；不允许“静默变差”。

---

## 7. 当前基线证据

以下为 2026-10-17 本机只读核查结果，作为 profile 初始值和 `tests/baseline/compat.json` 的输入；不是从计划文档抄来的数字。

### 7.1 构建与模块

| 项 | 实测值 | 来源 |
|---|---|---|
| `DCS.exe` FileVersion | `2.9.30.28738` | `bin/DCS.exe` VersionInfo |
| `DCS.exe` SHA256 | `4715620182E7EE36B3982D5C33D0F3265204BB2464D10E5DB7CEF0579E9BAEC0` | `Get-FileHash` |
| `Inter.dll` | `2.9.30.28738` / `FBFA21CD8FD64493174E1CA9C82513A26FF62E4FCD29C2036EEEC64BBDDC867A` | 同上 |
| `edterrain4.dll` | `2.9.30.28738` / `8DD1585729873F6006B2C564CBDB67F9577AF6276EF674967B803F2CE1B48235` | 同上 |
| `Weapons.dll` | `2.9.30.28738` / `6E3A4CB16C0C89CB7BC266D4F275D4E8659AB8E385464BB5D377832D7A2FA614` | 同上 |
| `wRadio.dll` | `2.9.30.28738` / `07831989C80A3510D1281664558B2137894D6FB2DB371BEC4485B7BC7AC9823A` | 同上 |
| `WeaponBlocks.dll` | `2.9.30.28738` / `E1BE3D2BF0D8F3C2DD93925F386B162B96F1DB7318E9B319B54A61B66072B83B` | 同上 |
| `WorldGeneral.dll` | `2.9.30.28738` / `7E9AD48E07F574333AB32C12C92A7BE9C91173C57DE9DDA702FE433F04D6AD27` | 同上 |
| `CockpitBase.dll` | `2.9.30.28738` / `163D55167503DA8DD0EA9EB459E17206FC3DC8D6B4805B5B13BBE58341BEB794` | 同上 |
| `lua.dll` | 无版本资源 | `agradar_native.log` |
| `dcs.log` 启动行 | `DCS/2.9.30.28738 (x86_64; MT; Windows NT 10.0.26200)` | `Logs/dcs.log:6` |

### 7.2 参考数据与着色器

| 项 | 实测值 |
|---|---|
| `Bazar/shaders/enlight/radar.fx` | 13397 bytes；`blurRadialDBS` 在 `:138`；`lambda = 0.03` 在 `:146`；调用点 `:280`；SHA256 `719E33753046E472F1D14CC7032786F5B26672389126A3DA79718786A99ECC3D` |
| `Config/Effects/radar.lua` | 2674 bytes；`EXP1/EXP2/EXP3` 的 `resolution=19/67/120`、`omega=1.13446`、`blankAngle=5.0`；SHA256 `4A5A616381DE38488889CB0ABF7F359915A36F20BCB05EE6686F8746F6A919B2` |
| `src/adapters/dcs/rcs_data.lua` | 50 条 map 条目；fallback 四键 `fighter/large/helicopter/missile`；生成器 `scripts/extract_rcs.py` 已输出四键（Gate 1 修复），与仓库生成物一致 |
| agradar 原生日志 | `init complete: 4/4 symbols resolved`；`engine surface-name validation: 16/16 match`；`engine plural 0x1f05 -> Land, Runway, Road, Railway, Town, Field, Beach` |
| fc 原生日志 | `init complete: 17/17 symbols resolved`；模块版本均为 `2.9.30.28738` |

### 7.3 运行时字段

- `recordings/flight3-final.aesarec` 与 `flight9.aesarec` 首帧 P 行：
  `Bank:number|Coalition:string|CoalitionID:number|Country:number|Flags:table|GroupName:string|Heading:number|LatLongAlt:table|Name:string|Pitch:number|Position:table|PositionAsMatrix:table|Type:table|UnitName:string`
- 同文件（Gate 1 前录制）A/T 行速度字段全为 `0.000`；T 行 Su-25 阵营 `0`、F-16 `2`，与 `Country` 一致，不是 `CoalitionID`。这是历史录制证据，不代表当前 Export 行为。
- Gate 0 时 `src/export/aesa_export.lua:107` 的字段选择是 `obj.coalition or obj.Country or obj.country`；Gate 1 已改为只读 `CoalitionID`，缺失/非法输出 `unknown`。
- 实际 `Saved Games\DCS\Scripts\Export.lua` 含 AESA、SAR、SRS 三段；这验证了“多工具共存 + 标记块”的加载模型。

### 7.4 已知不一致/风险（Gate 0 发现）

1. **已修（Gate 1）**：`scripts/extract_rcs.py` 曾漏生成 `missile` fallback；现在统一输出 `fighter/large/helicopter/missile`，`src/adapters/dcs/rcs.lua` 启动校验四个 key，缺键 fail-closed。
2. `src/native/agradar_probe/aesa_agradar.c:589-610`：vtable[19] 与解析地址不同但属于 `edterrain4.dll` 时仍调用，是 fail-open；应改为严格相等或 profile 验证。
3. **已修（Gate 1）**：`src/native/fc_probe/aesa_fc.c` 的 `readable()` 现在逐内存区校验完整 `[p,p+n)` 范围；跨未提交/NOACCESS/GUARD/只执行页返回 false，并修正了 `rtti_name`/`trace_hex`/`watch_sample`/`feed_write` 的连带范围。
4. `src/native/fc_probe/aesa_fc.c:579-608`：`feed_write` 直接写 `+0x220`，没有 profile/只读闸门；Gate 6 D4 拆 `fc_inject` 前不得默认启用。
5. **已修（Gate 1）**：`src/hooks/aesa_fc_hook.lua` 默认 `experiment.mode=0`（只读）；只有显式 `mode=1` 才 arm 注入，非法值强制归零并写日志。
6. `src/hooks/aesa_fc_hook.lua:308`、`src/hooks/aesa_sar_scene_hook.lua:115`：`DCS.setUserCallbacks` 无守卫；DCS API 变化会在加载时抛错。
7. `scripts/install_export.py:30-39` 在 `DCS`/`DCS.openbeta` 同时存在时自动选 `DCS`；`install_sar.cjs:93` 已强制显式 `--saved-games`，两者策略不一致。
8. **部分实现（Gate 3 离线）**：已有 profile/ABI 的模块 hash 与 `NAT-HASH` 检查定义；原生运行时 `aesa_profile_check()` 尚未接入，`lua.dll` 无版本资源，`native.exports_sha256` 仍为 `unknown`。
9. `docs/status.md:79`（historical）写 `2.9.29`，与当前 `2.9.30.28738` 漂移；历史快照本身保留旧值可以接受，但不能再作为当前环境依据。
10. socket 自举有三份（A/A、SAR、场景），路径策略略有差异；Gate 3 应合并到 `api/export.lua` / `api/hook.lua`。

---

## 8. Gate 3 交付物与验收

| 文件 | 作用 | 验收 |
|---|---|---|
| `spec/dcs_profiles/dcs-<build>.json` | 单一事实源 | schema 校验；与当前 build 对应；无代码分支 |
| `src/adapters/dcs/compat/profile.lua` | 能力查询/矩阵 hash | 纯 Lua；无 DCS API；Lua/JS hash 向量一致 |
| `src/adapters/dcs/compat/probe.lua` | 分状态探测 | 只读；单能力失败隔离；不启用 unsafe API |
| `src/adapters/dcs/compat/profiles/dcs-<build>.lua` | 生成的 Lua profile | 带 `DO NOT EDIT`/generator/hash；字段与 JSON 一致 |
| `src/native/abi/dcs_profile.h` | 原生 ABI 常量/自检 | 由 profile 生成；不匹配 → read-only；vtable 严格校验 |
| `scripts/compat_check.cjs` | 检测/diff/分类 | 退出码 0/2/3/4；JSON 稳定；不写安装目录 |
| `src/adapters/dcs/api/{export,mission,hook,native}.lua` | 游戏 API 单点 | `rg` 游戏 API 只在 `api/`；业务代码无直接调用 |
| `src/adapters/dcs/frame.lua` | 帧/坐标转换 | DCS 语义只在这里；核心无 `Heading+π/2` |
| `src/adapters/dcs/data/surfaces.lua` | 地表词表/材质 | 16 类 + 五类兼容；未知 → unknown |
| `src/adapters/dcs/data/shaders.lua` | `radar.fx` 常量 | 来自 profile；hash 不匹配 → DBS 降级 |

Gate 3 退出条件（与计划一致）：

- `node scripts/compat_check.cjs --detect --diff <baseline>` 当前 build 为 A 或已批准的 B；C 类不允许继续。
- `rg` 游戏 API 只在 `src/adapters/dcs/api/`。
- fail-closed 测试覆盖 §6.2 的全部行。
- 实机：Export 10 Hz、日志无 error、场景桥能力正确；原生默认只读。
- 删除业务代码里的直接游戏 API、两份 socket 自举、死 `CAP` 字符串、`AESA.VERSION`、`AESA.tick`。

---

## 9. 附录：核查命令

以下命令在 2026-10-17 实际执行过，输出用于本文数字：

```bash
# 版本/模块
powershell -NoProfile -Command "(Get-Item '<DCS>\bin\DCS.exe').VersionInfo | Format-List FileVersion,ProductVersion"
powershell -NoProfile -Command "Get-FileHash -Algorithm SHA256 'E:\...\bin\Inter.dll', ..."

# 源码位置
rg -n "LuaExport|LoGet|terrain\.|world\.|land\.|net\.dostring_in|package\.loadlib|lfs\." src scripts tools tests
rg -n "2\.9\.30|28738|build|version" src/native docs

# 录制字段
head -3 recordings/flight3-final.aesarec
grep -m 1 "^P " recordings/flight3-final.aesarec
grep -m 1 "^A " recordings/flight9.aesarec

# 原生日志
grep -n "init complete\|surface-name validation\|module .*version" "%USERPROFILE%/Saved Games/DCS/Logs/AESA/AGR/agradar_native.log"
grep -n "init complete\|module .*version" "%USERPROFILE%/Saved Games/DCS/Logs/AESA/fc_native.log"

# 着色器
grep -n "lambda\|blurRadialDBS\|resolution" "<DCS>/Bazar/shaders/enlight/radar.fx"
grep -n "resolution\|omega\|blankAngle" "<DCS>/Config/Effects/radar.lua"
```

未执行：任何 `git commit/tag/checkout/reset`；任何业务代码修改；任何 DCS 安装目录写入；任何 `autoexec.cfg` 修改。

---

## 10. 未决项

1. `profile.lua` 的 `matrix_hash` 具体算法（FNV-1a 32 vs 其他）需在 Gate 3 与 `compat_check.cjs` 一起定稿，并用固定测试向量锁定。
2. 任务态 probe 的注入方式：是随 `aesa_sar_mission.lua` 一起嵌入，还是由 Hook 单独发送 `probe.lua` 源码；需在 Gate 3 根据安装器能力决定。
3. `dcs.log` 的 `build/variant` 解析在非默认日志路径/多实例下可能不唯一；Gate 3 需定义“最近一次启动”的判定（session id/启动时间）。
4. `terrain.GetHeight` 在多地图边界的行为、`land.getSurfaceType` 的数值语义，仍需按地图实测补 `profile.terrain.maps`。
5. 第三方模组对 `Weapons.dll`/`wRadio.dll` 的替换策略未验证；Gate 6 的冲突检测只做文件名/hash，不等于行为兼容。
6. 当前 `docs/status.md:79` 的 `2.9.29` 是历史状态（该文件已由并行 Gate 0 工作标为 historical）；本次未改该文件，需在文档收口 Gate 确认“历史值 + 当前值”指向 `docs/architecture.md`/本文，而不是让读者把 2.9.29 当现状。

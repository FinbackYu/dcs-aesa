# 阶段二设计：DCS 真值接入（数据层）

状态：historical（设计记录，2026-09-27；DCS 适配已迁至 `src/adapters/dcs/`，核心已迁至 `src/core/`，见 `docs/architecture.md`）。
日期：2026-09-27。定位见 `docs/feasibility.md` §4 阶段二：把核心接上 DCS 真值，核心代码零改动，延续阶段一"录制-回放-断言"的可测试方法论。

> 现役协议在 V1 基础上增加 `PROTO,2`（O 行与坐标是原始 DCS 值）与 `COMPAT,<profile>,<matrix_hash>`；旧 V1 录制的 `O` 航向为 `Heading + π/2`，只由 `src/adapters/dcs/frame.lua` 的 `legacy_heading` 修正。以下为原始设计。

## 1. 架构

```
DCS 进程（Export 环境，薄采样脚本）          DCS 进程外（Python 工具链）
  LuaExportAfterNextFrame ──限频10Hz──►  aesa_export.lua 采样
        LoGetSelfData / LoGetWorldObjects
        LoGetTargetInformation（引擎雷达对照）
                │ LuaSocket TCP 127.0.0.1:3590，文本行协议
                ▼
        tools/receiver.py：解析/录制（*.aesarec）/实时摘要
        tools/replay.py：回放录制 → truth_replay（`src/adapters/dcs/`）→ 阶段一核心（现 `src/core/`）→ 航迹 + 引擎对照报告
```

- **核心在进程外跑**：Export 脚本只采样发送（pcall 全防护、无阻塞、掉线静默重试），崩溃面最小；核心由 Python 经 lupa 驱动，与阶段一同一套测试设施。
- **时间基准 = `LoGetModelTime()`（仿真时间）**，核心 step 的 dt 与录制回放的 t 一致，离线/在线行为相同。

## 2. 行协议（V1，ASCII，\n 结尾）

```
V1                                # 每次连接成功后发送一次
P <探针内容>                      # 首帧字段名探针（防御性适配 LoGet* 返回结构差异）
A <t> <typeName> <x> <y> <z> <vx> <vy> <vz>          # 本机（每帧锚点，新 A = 新帧）
O <t> <heading> <pitch> <roll>                       # 可选本机姿态（核心约定、弧度）
T <t> <id> <typeName> <coalition> <x> <y> <z> <vx> <vy> <vz>  # 单位
L <t> <id> <0|1>                                    # 可选地形可见性，紧随对应 T
E <t> <id> <x> <y> <z> <R> <vclose> <rcs> <flags>     # 引擎雷达接触（对照用）
E <t> <id> <R> <vclose> <rcs> <flags>                # 无坐标的引擎接触
```

- 空格分隔；typeName 中空格替换为 `_`。原始设计位置保留 DCS 世界系米制坐标（Y 为高度），核心 h=0 朝 -Z，DCS Heading 转为 h=Heading+π/2；**Gate 4 起**：`O` 行发送原始 DCS Heading/Pitch/Bank，接收端 `src/adapters/dcs/frame.lua` 统一转 ENU，旧录制由 `legacy_heading` 修正。
- O/L 是 V1 的可选扩展，旧解析器忽略未知行，旧录制仍可用。无 O 时假设平飞和速度航向；无 L 时地形状态为 unknown。L=0 明确抑制检测，不把“缺失”当作“可见”。
- 姿态角走最短角度插值；跨遮蔽状态区间保守保留 false。实时和回放都保留这些字段，实时长间隔分段完整推进，不截掉仿真时间。
- 接收端按 A 行分帧；E 行归属同帧。

## 3. 组件

| 文件 | 职责 |
|---|---|
| `src/export/aesa_export.lua` | 采样+发送（`M.sample(t, lo, send)` 可注入 stub 测试；回调链式包裹，与其他 Export 工具共存；重复 dofile 防护） |
| `src/adapters/dcs/truth_replay.lua` | 回放型 TruthSource：帧序列 → `targets(now)/ownship(now)` 线性插值；目标按 id 对齐，单帧出现者保持（不外推）；经 `frame.lua` 转 ENU |
| `scripts/install_export.py` | Saved Games 部署：安装/验证/修复/卸载；Export.lua 用 BEGIN/END 标记块；首次改动前备份 `Export.lua.bak-aesa`；绝不触碰他人内容 |
| `tools/receiver.py` | TCP 服务器 + 行解析 + 录制（`--record <file>`）+ 实时摘要 |
| `tools/replay.py` | 回放：录制 → 核心 → 确认航迹时间线 + 引擎对照差异报告 |

## 4. 已知不确定点（2026-09-27 实飞后更新）

- `LoGetWorldObjects()` 字段结构——**已实测确认**（探针行）：`Name/Position/Country/Heading/Pitch/UnitName/Coalition/...`，**无 velocity 字段**（接收端差分修补，已验证）。
- **`LoGetTargetInformation` 在 F-16C 上返回空（雷达常开、目标在 23–86 km 迎头亦然）**——该接口为 FC 时代 legacy 导出，较新模块不喂数据（社区同报告：论坛 "LoGetTWSInfo returns nil while Sensor export is true"、DCS-BIOS 讨论）。已加每 5s 的 E 诊断留证；**引擎雷达对照实验改用 FC3 F-15C**（有专用 `LoGetF15_TWS_Contacts`）。
- LuaSocket 连通性——**已实测打通**（168 s 连续录制）。
- 部署/性能——每帧回调限频 10 Hz 采样无感（用户全程无卡顿反馈）；`ActivityNextEvent` 在本工具链下会被 DCS 停调，采样已改 `AfterNextFrame` 驱动（详见 git 历史与 export_diag 经验）。

## 5. 测试计划（并入 tests/run_tests.py）

- `t_export_sampler`：注入 stub Lo* 与发送收集器，断言帧格式/分帧/字段清洗。
- `t_truth_replay`：两帧插值正确（位置/速度线性）、单帧目标保持、边界 clamp。
- `t_install_export`：临时目录全生命周期（安装→验证→外部内容共存→修复→卸载还原）。
- `t_replay_pipeline`：合成录制文件（冒烟场景 10 Hz 采样）→ receiver 解析 → replay 跑核心 → 近距目标确认航迹；E 行计数一致。

## 6. 开发验证部署、修复与卸载（2026-09-30）

当前是早期开发阶段，采样脚本直接从仓库源码部署用于验证，暂无发布包。

```powershell
python scripts/install_export.py install --saved-games "<Saved Games DCS目录>"
python scripts/install_export.py verify --saved-games "<Saved Games DCS目录>"
python scripts/install_export.py repair --saved-games "<Saved Games DCS目录>"
python scripts/install_export.py uninstall --saved-games "<Saved Games DCS目录>"
```

- 安装/修复先做 Lua 5.1 语法检查（lua/luajit 或 lupa.lua51，可通过 AESA_LUA 指定执行器），直接读取 src/export/aesa_export.lua；不生成打包产物。
- Export.lua 加载块由开发部署脚本维护，保留用户现有内容。
- 修改前检查完整、独占行、唯一且顺序正确的 BEGIN/END。残缺/重复标记拒绝写入，用户应对照备份恢复完整块。未知或本地修改过的同名 Lua 也拒绝覆盖和卸载；已知旧版本 hash 支持升级。
- Export.lua 按原始字节处理，保留编码/BOM/换行；每个不同的修改前版本自动备份。部署 manifest 保存脚本 hash、源码修订标识、来源和 Export 原始快照，仅用于安全修复/卸载。文件替换失败会回滚目标。
- 卸载只删除 hash 校验通过的脚本和自身 manifest，恢复原始 Export 或精确剥离加载块，并保留安装后新增的其他工具内容。备份、日志和外来文件保留。用户修改过的 AESA 脚本需先自行保存/恢复，再重试卸载。
- O/L 扩展、地形接口和姿态符号尚需新版实飞验证；本轮只在临时目录做部署测试。

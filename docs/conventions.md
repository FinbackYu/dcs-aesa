# aesa 跨语言 / 跨层约定

- 状态：current
- 日期：2026-10-18
- 适用：分支 `refactor/architecture-gates`（2026-10-18 由 `codex/sar-airport-mapping` 改名），基线 tag `pre-arch-refactor`
- 决策依据：`docs/refactor-plan.md`；Gate 0 四项决策均取推荐 A 方案，模块边界与 ADR 见 `docs/architecture.md`
- Gate 状态：Gate 0–3 完成；**Gate 4 完成**（A/A 核心已迁至 `src/core/`，DCS 适配在 `src/adapters/dcs/`，`src/aesa/` 已删除）；Gate 5 下一步
- 读者：Lua / JS / Python / C 维护者，协议与部署脚本作者，viewer 作者

本文是跨语言、跨进程、跨层的**契约文档**。它不替代代码注释和设计文档，但一旦本文与实现冲突，冲突本身就是缺陷：要么改实现，要么在本文件登记为债务并给出 Gate。

文中使用：

- **必须**：发布/合入门禁；违反即 Red。
- **应当**：默认遵守；偏离必须写明理由和 owner。
- **可以**：允许的实现选择。
- **`[当前]`**：基线代码的实际行为，供迁移对照。
- **`[目标]`**：对应 Gate 完成后必须满足的契约。

权威顺序：

1. `spec/*.json`（Gate 2 起）是参数、协议、部署的唯一来源。
2. `docs/architecture.md` 的 ADR 决定模块边界与依赖方向。
3. 本文决定跨语言/跨层的坐标、单位、时间、栅格、协议、错误与文档纪律。
4. 设计与理论文档解释“为什么”；历史文档和外部资料不构成当前行为契约。

---

## 0. Gate 0 决策对本约定的约束

| 决策 | 选择 | 对本文的直接影响 |
|---|---|---|
| D1 帧模型 | A：核心使用 ENU 右手系 | 核心不得再出现 DCS `x/z/y`、`heading=0 → -Z`；全部转换集中在 `src/adapters/dcs/frame.lua`（Gate 4） |
| D2 SAR 核心 | A：`src/sar_core/` 纯 JS | SAR 物理不得依赖 DCS 名称、HTTP、文件系统；`tools/` 只做适配/服务/显示（Gate 5） |
| D3 `/state` | A：摘要 + `resultSeq` | `/state` 不返回图像矩阵；图像走 `/image/<seq>` 或 `/snapshot`；viewer 在 `completed`/`resultSeq` 变化时拉图（Gate 5） |
| D4 原生 | A：只读 trace 与写注入分离 | 默认只读；写路径必须显式配置、profile 校验、可回滚（Gate 6） |

本文件同时描述 `[当前]` 和 `[目标]`。Gate 4 已完成 A/A 边界迁移：核心帧、snapshot、RCS 接口与 Python 共用层按 `[目标]` 落地；仍标 `[目标]` 的条目是 Gate 5–6 的验收条件，不是当前已实现的行为。

---

## 1. 总原则

1. **一个概念一个所有者**：物理、几何、协议、配置、部署、显示各自只有一个权威实现。
2. **纯核心**：`src/core`（Lua）和 `src/sar_core`（JS）不读时钟、不读文件、不联网、不调用游戏 API、不依赖全局状态。
3. **适配器隔离**：DCS 的坐标、字段名、`LoGet*`、`terrain.*`、`world.*`、`land.*`、`net.dostring_in`、`package.loadlib`、`lfs` 只允许出现在 `src/adapters/dcs/api/` 或明确的适配层。
4. **显示只消费结果**：viewer 不重算物理、分辨率、机体投影或相对角；只读 snapshot / metadata。
5. **单一事实源**：同一常量、端口、footprint、地表词表、栅格方向只能有一个来源；生成物不得手改。
6. **fail-closed**：缺能力、缺字段、未知版本、原生 profile 不匹配时拒绝或降级为明确的 `unknown`/`unavailable`，不得补 0、补旧值或猜一个看起来合理的数。
7. **确定性**：同输入、同种子、同时间序列必须得到逐位一致的结果；排序、随机、遍历顺序都不得依赖 `pairs`/对象插入顺序。
8. **文档有状态**：每篇文档必须标 `current`、`historical`、`external-reference` 或 `draft`（§11）。

---

## 2. 语言与模块边界

### 2.1 Lua 5.1 兼容子集

所有会被 DCS 加载的 Lua（`src/`、`scripts/install_*` 的语法检查、测试）必须兼容 Lua 5.1，并尽量兼容 LuaJIT。

禁止：

- `goto`、`//` 整除、`_ENV`、位运算符（`& | ~ << >>`）、`table.unpack`、`utf8`、`math.type`、`math.tointeger`。
- 依赖 5.2+ 的 `__pairs`、`__len` 语义变化。
- 在核心模块中使用 `os`、`io`、`require`、`package`、`lfs`、`socket`。
- 在物理/调度/航迹代码中读取墙钟或调用 `math.random`。

要求：

- 核心模块是“返回一个 table 的函数文件”，由入口 `src/core/init.lua` 用 `dofile` 加载；模块自身不负责加载别人。入口不加载 DCS 数据；DCS 帧/RCS 由 `src/adapters/dcs/` 注入（Gate 4 已落地）。
- 随机数使用注入的可种子生成器：`constants.make_rng(seed)` 是 Park–Miller LCG，同种子同序列（`src/core/constants.lua:41-48`）。
- 时间只认调用方传入的 `dt`；核心不读 `os.time`/`os.clock`/`LoGetModelTime`（`src/core/core.lua:108-119`、`src/core/scheduler.lua`）。
- 对外部 API 的调用必须用 `pcall` 包裹，并做有限性/范围校验；失败返回 `nil`/`unknown` 或抛出明确错误，不得静默补值。
- 文件名、标识符用 ASCII；源码 UTF-8；注释可以中文。

`[当前]` 的剩余越界：`src/export/aesa_export.lua:43-46` 把非数字格式化为 `0.000`（速度已由 `vel_valid=0` 标记）。核心已无 DCS 坐标语义；`pairs` 顺序问题在 Gate 1 已修（`src/core/core.lua` 按稳定 id 排序，`src/core/tracker.lua` 用 `track_ids`/`sorted_ids`）。

### 2.2 JavaScript

- 使用 CommonJS `.cjs`、`'use strict';`、Node 内置模块；仓库没有 `package.json`，不引入 npm 运行时依赖，不使用转译器。
- 目标 Node 版本以仓库实测为准（当前 Node v25.9.0）；至少使用 Node 18 已稳定的 API。
- `src/sar_core/` 是纯 JS：不得 `require('fs')`、`http`、`net`、`child_process`，不得出现 DCS 类名/地表词表/机型名，不得依赖 viewer。几何、波形、散射、聚焦、MAP/DBS、池化都在这里；服务只编排。
- `tools/sar_service/` 只做采集、状态机、HTTP、作业调度、拼接、录制；不得反向定义物理公式或第二套常量。
- `tools/sar_live.cjs` 是组合根/CLI；`[目标]` < 300 行（Gate 5）。
- 纯函数优先；边界处显式校验（`Number.isFinite`、整数、范围、枚举），非法输入抛 `Error`，不要静默 clamp；只有文档明确允许的显示层 clamp 才可 clamp。
- 物理/散射/渲染不得使用 `Math.random()`；使用世界坐标哈希或注入种子（`src/sar_core/map.cjs:47-53,341-347`）。
- `performance.now()` 只用于 `compute_ms` 等诊断元数据，不得参与物理判定或图像内容。
- 命名：文件名 `snake_case.cjs`；函数/变量 `camelCase`；常量 `UPPER_SNAKE`；类 `PascalCase`。
- 数值：JS 只有 double；涉及整数索引/哈希时用 `Number.isInteger`/`Math.imul`，不要假设 32 位溢出行为。

### 2.3 Python

- Python 3.10；运行时依赖仅标准库 + `lupa`（用于 Lua 宿主/测试）。新增第三方依赖必须先写决策记录。
- `tools/` 是薄工具：`receiver.py`、`live.py`、`replay.py` 只做协议/宿主/编排；共用 `lua_host.py`、`protocol.py`、`ingest.py`、`truth.py`（Gate 4 已完成）。
- 生产工具不得 `import tests`；测试辅助只能被测试导入（Gate 4 已移除 `run_tests` 依赖）。
- `lupa` 的 LuaRuntime 非线程安全：只有主线程触碰 Lua；TCP/回放线程只入队，HTTP 线程只读 Python 快照（`tools/live.py:13-14`）。
- JSON 中禁止 `NaN`/`Infinity`：非有限数一律转 `None`/`null`（`tools/live.py:86-92` 的 `_f` 是范例）。
- 命名 `snake_case`；文件头 UTF-8；命令行非法输入以非零退出码结束并打印原因。

### 2.4 C / 原生

- 符号、偏移、vtable、导出 hash 来自 `spec/dcs_profiles/*.json` 生成的 `src/native/abi/dcs_profile.h`；不得在业务 C 代码里散落魔数。
- `fc_trace` 只读；`fc_inject` 是独立写路径；默认只读，写路径必须显式配置 + profile 校验 + 备份/回滚（D4，Gate 6）。
- 任何指针读取先校验完整范围；`readable()` 不能只校验首字节（`[当前]` `src/native/fc_probe/aesa_fc.c:289-299` 是 Gate 1/6 的修复点）。
- 加载失败、符号缺失、版本不匹配：返回 `unavailable`/`readonly`，不得注入。

### 2.5 依赖方向

```text
src/core (纯 Lua)                  src/sar_core (纯 JS)
    ↑                                   ↑
src/adapters/dcs (Lua)             src/adapters/dcs/sar_adapter (JS)
    ↑                                   ↑
src/export / scene / hooks         tools/sar_service
                                        ↑
                                    tools/sar_live.cjs / viewer
```

硬规则：

- `src/core` 不 import 适配器、服务、文件系统、DCS。
- `src/sar_core` 不 import `tools/sar_service`、`sar_bridge`、viewer。
- `src/export`、`src/scene`、`src/hooks` 只做采样/桥接/传输，不重新定义物理。
- `tools/` 不反向定义物理；viewer 不重算物理。
- 测试可以依赖所有层，但生产代码不得依赖测试。

---

## 3. 坐标系统与帧

### 3.1 DCS 世界系（外部事实）

DCS 官方坐标：**x 向北、z 向东、y 向上**，单位米；这是一个右手系（x × y = z）。官方说明见 [Basic terms and types](https://www.digitalcombatsimulator.com/en/support/faq/1256/)。

- `LoGetSelfData().Position` / `LoGetWorldObjects().Position` 是 `{x,y,z}`，`y` 为海拔（MSL），不是 AGL。
- `terrain.GetHeight(x,z)` 返回该点地面海拔（MSL）。
- `LoGetAltitude(x,z)` 的语义在历史上不够明确，只作为诊断值，不作为地形高度来源（`docs/sar-feasibility.md:67`、`src/export/aesa_sar_export.lua:236-241`）。
- DCS `Heading` 从 +X（北）起算，向 +Z（东）增加，即顺时针；`Pitch` 上仰为正；`Bank` 右机翼下沉为正。Gate 4 前 `src/export/aesa_export.lua` 的注释与 `+π/2` 换算符合这一事实；现 Export 直接发送原始 DCS 值，转换集中在 `src/adapters/dcs/frame.lua`。

> 重要标签冲突：`tools/sar_viewer.html:259` 与 `:834` 写“x 向东、z 向南”，`tests/test_sar_viewer.cjs:929-936` 的方位文案也沿用“heading 90° = 东”。这与 DCS 官方轴和 `src/export/aesa_export.lua:77` 的 Heading=0→+X 相反。地图/拼接公式在该注释体系内是自洽的，但**对外文档和用户可见标签必须使用官方轴**；更严重的是，mosaic 的 `screen_x=world_x, screen_y=world_z`（`tools/sar_viewer.html:490-491`）按官方轴是“北在右、东在下”，相对真北向上旋转了 90°。Gate 5 必须旋转视图或明确改文案（§6.4）；不要根据这些错误标签去改坐标公式。

### 3.2 `[historical]` 基线核心：直接使用 DCS 轴（Gate 0–3 证据）

以下描述 Gate 4 前的基线核心，仅用于理解旧录制与历史测试向量；`src/aesa/` 已删除，现役核心见 §3.3。基线核心没有独立帧，`own.pos`/`tgt.pos` 直接是 DCS `x/y/z`，`y` 为高度。`physics.body_basis` 定义：

```text
heading = 0  → 前向 = (0, 0, -1) = -Z
前向 f = ( sin(h)·cos(p),  sin(p), -cos(h)·cos(p) )
右向 r = ( cos(h)·cos(rl) + sin(h)·sin(p)·sin(rl), -cos(p)·sin(rl), sin(h)·cos(rl) - cos(h)·sin(p)·sin(rl) )
上向 u = ( cos(h)·sin(rl) - sin(h)·sin(p)·cos(rl),  cos(p)·cos(rl), sin(h)·sin(rl) + cos(h)·sin(p)·cos(rl) )
```

其中 `p=pitch` 上仰为正、`rl=roll` 右机翼下沉为正（历史路径 `src/aesa/physics.lua:115-129`，文件已删除）。

DCS → 基线核心的航向换算是：

```text
h_legacy = H_dcs + π/2
```

`H_dcs=0`（北，+X）→ `h_legacy=π/2` → 前向 `(1,0,0)=+X`，与 DCS 一致；`H_dcs=π/2`（东，+Z）→ `h_legacy=π` → 前向 `(0,0,1)=+Z`。因此基线核心的“0°”实际指向 -Z（西），不是北；`docs/theory-notes.md:11` 已经提醒“不能把核心的 -Z 直接称为地理北”。旧 V1 录制的 `O` 行写的就是 `h_legacy`；现 Export 发送原始 DCS Heading，只有 `src/adapters/dcs/frame.lua` 的 `legacy_heading` 会为旧录制减 `π/2`。

### 3.3 `[当前]` 核心：ENU 右手系（Gate 4 已实现）

核心只使用通用 ENU：

- `X`（或 `E`）= 东，`Y`（或 `N`）= 北，`Z`（或 `U`）= 上。
- 右手系：`E × N = U`。
- 位置单位 m，速度单位 m/s。
- 航向 `H`：0 = +N（北），+90° = +E（东），顺时针为正；等价于 `H = atan2(east, north)`。
- 前向、右向、上向：

```text
forward = ( sin H,  cos H, 0 )
right   = ( cos H, -sin H, 0 )
up      = ( 0, 0, 1 )
```

DCS → ENU 的唯一换算（只允许在 `src/adapters/dcs/frame.lua`）：

```text
east_m  = dcs_z
north_m = dcs_x
up_m    = dcs_y

v_east_mps  = dcs_vz
v_north_mps = dcs_vx
v_up_mps    = dcs_vy

H_enu = H_dcs                 -- 两者都是“从北顺时针”
pitch_enu = pitch_dcs         -- 上仰为正
roll_enu  = bank_dcs          -- 右机翼下沉为正
```

反变换：

```text
dcs_x = north_m
dcs_y = up_m
dcs_z = east_m
H_dcs = H_enu
```

注意：这与 §3.2 的 `h_legacy = H_dcs + π/2` 不同。旧录制的偏移只允许出现在 `src/adapters/dcs/frame.lua` 的 `legacy_heading`；`src/core` 不得出现 `-Z`、`Heading + π/2`、DCS 机型名、`visible` 或 `LoGet*`（Gate 4 已验收）。`frame.ownship` 的缺姿态回退也先按 DCS 速度反解 `h_legacy`，再减 `π/2` 转 ENU；该逻辑同样只在该文件。

### 3.4 航向、航迹、方位与符号

- **heading（航向）**：机头指向。
- **track（航迹）**：地速方向；无风时接近 heading，有侧风时不同。
- **bearing（方位）**：从本机指向某点的方向。
- **relative（相对角）**：目标方位减航迹/航向；本文约定**正 = 右，负 = 左**。
- **squint / relative_track_deg**：SAR 目标相对地面航迹的斜视角；侧视窗口当前为 20°–160°（绝对值），正值右、负值左（`src/export/aesa_sar_export.lua:222`；`tools/sar_live.cjs:444-475`）。
- **az_rel**：目标相对机头的方位角，右正；**el_rel**：相对机头的俯仰角，上正（`src/core/geometry.lua`）。
- **pitch**：上仰为正；**roll/bank**：右机翼下沉为正。
- **v_close / vr**：径向接近速度，正 = 接近（`src/core/geometry.lua`）。
- **side**：+1 右、-1 左（`src/export/aesa_sar_export.lua:184-195`）。

当前存在多套角度约定，必须显式区分：

| 来源 | 角度定义 | 单位 | 证据 |
|---|---|---|---|
| DCS `Heading` / A/A `O` 行 | 从 +X（北）向 +Z（东），顺时针；Gate 4 起 Export 直接发送原始 DCS 值 | rad | `src/export/aesa_export.lua`（`PROTO,2`）、`src/adapters/dcs/frame.lua` |
| 旧 V1 录制 `O` 行 | `Heading + π/2`；只有 `frame.legacy_heading` 减回 | rad | `src/adapters/dcs/frame.lua:21-26` |
| 核心 `body_basis`（Gate 4 起） | ENU；0 = 北，右正、上正 | rad | `src/core/geometry.lua:10-25` |
| 历史基线核心（Gate 4 前） | 0 → -Z（西）；方位右正、俯仰上正 | rad | 历史路径 `src/aesa/physics.lua:115-129`，文件已删除 |
| SAR Export `track` / `bearing` | `atan2(z, x)`，从 +X 向 +Z | rad | `src/export/aesa_sar_export.lua:194-196` |
| 地图引擎 `heading` | `atan2(dx, dz)`，从 +Z 向 +X；是上一行的余角 | rad | `src/sar_core/map.cjs:157-175`；`tools/sar_live.cjs:693-694` |
| `TARGET.relative_track_deg` | 目标方位减航迹，正右负左 | deg | `src/export/aesa_sar_export.lua:222` |
| `/state` `heading_deg` | 取决于来源：`map.pose` 是地图约定，`ownship` 是核心 ENU/旧基线约定 | deg | `tools/sar_live.cjs:280-287,880-883`；`tools/live.py` |
| `mosaic.entry.bearing` | 场景/地图锚点的 bearing；地图帧为 0 | rad | `tools/sar_live.cjs:251`；`src/sar_core/map.cjs:692-695` |

关系（模 2π）：

```text
map_heading = π/2 - H_dcs = π - h_legacy
relative_right = bearing - track        -- Export 的 TARGET 约定
relative_right = map_heading - map_bearing
```

`tools/sar_live.cjs:454-458` 的注释说明：地图路径和 Export 路径“互为余角”，所以相对角用“heading − bearing”而不是反过来；符号不能交换。

`[目标]`：

- 核心/适配器内部：rad；对外 JSON/协议字段用 `_deg` 时必须明确是度。
- 绝对航向/方位：存储 `[0, 2π)` rad 或 `[0, 360)` deg；显示前归一化。
- 有符号相对角：`(-π, π]` rad 或 `(-180, 180]` deg；当前 `relativeAngleDeg` 和 Export `relative` 都是这个范围（`src/sar_core/map.cjs:157-162`；`src/export/aesa_sar_export.lua:222`）。
- 俯仰/仰角：`[-π/2, π/2]`。
- `atan2` 的结果是 `(-π, π]`；跨边界插值用最短角差（`src/adapters/dcs/truth_replay.lua:17-28`）。
- 旧字段名 `heading`/`bearing` 只有在协议 schema 明确声明“本行是弧度”时才允许裸用；新字段必须带 `_deg` 或 `_rad`。

### 3.5 坐标只在适配层转换

`[当前]` 硬规则（Gate 4 已落地）：

- DCS `x/y/z`、`Heading+π/2`、MSL 高度、`terrain.*`、`world.*`、`land.*` 只允许出现在 `src/adapters/dcs/`（API 与 frame）。
- `src/export` 只负责把适配器输出的通用量序列化；不自己做 DCS→核心换算。
- `src/core` 的接口使用 ENU；测试使用合成 ENU 真值 + 固定的 DCS→ENU 向量。
- 显示层可以把 ENU 投影到屏幕（方位/俯仰/距离），但不得重新计算物理、分辨率、探测概率或 SNR。
- viewer 不得读取 `sched`/`trk` 内部表；只消费 `core:snapshot()` / `/state` / 图像 metadata（A/A 已落地；SAR 在 Gate 5）。

---

## 4. 单位、后缀与显示换算

### 4.1 基本单位

内部计算一律 SI（m、m/s、s、rad、Hz、W、dB、m²）。跨层字段名必须带单位后缀，除非协议 schema 明确声明整行单位。

| 量 | 内部单位 | 后缀 | 说明 |
|---|---|---|---|
| 长度/高度/距离 | m | `_m` | 海拔、地形高、斜距、地距、栅格步长 |
| 速度 | m/s | `_mps` | 地速、径向速度、风速 |
| 加速度 | m/s² | `_mps2` | `[当前]` `vel_accel_max_ms2` 是旧名，Gate 2 改 |
| 时间 | s | `_s` | 仿真时间、驻留、时长 |
| 毫秒 | ms | `_ms` | **只表示毫秒**，不表示 m/s |
| 角度 | rad | `_rad` | 内部；裸 `heading` 仅在 schema 声明时使用 |
| 角度 | deg | `_deg` | JSON/显示/协议中明确为度 |
| 频率 | Hz | `_hz` | PRF、回访率 |
| 功率 | W | `_w` | 平均/峰值功率 |
| 增益/损耗/电平 | dB | `_db` | 相对参考必须另有 `db_ref` |
| RCS/面积 | m² | `_m2` | 例如 `rcs_m2`；dBsm 用 `_dbsm` |
| 距离（显示） | NM/km | `_nm`/`_km` | 只允许显示层 |
| 速度（显示） | kt | `_kt` | 只允许显示层 |
| 高度（显示） | ft | `_ft` | 只允许显示层 |
| 计数 | 个 | `_n` 或无后缀 | `cols`/`rows`/`cells`/`width` 是计数，不带单位 |

`[当前]` 的已知命名债务：

- 历史基线（Gate 2 前）的 `src/aesa/config.lua` 曾把 `notch_half_ms`、`gate_vel_margin_ms`、`vel_floor_ms`、`slow_mover_ms` 当作毫秒；Gate 2 已统一为 `_mps`，该文件已删除。现配置在 `spec/radar.json` → `src/shared/config.lua`。
- `tools/sar_live.cjs:321` 的 `headingDeg`、`:358` 的 `ageS`、`movers` 的 camelCase 字段是旧 API；新字段用 `heading_deg`、`age_s`。旧字段保留到协议/状态版本升级。
- `compute_ms`、`age_s`、`duration_s` 等是正确用法；不要把它们改成 `_ms` 表示速度。
- 历史 `near_R_km`（Gate 2 前 `src/aesa/config.lua:61`）是 km；现配置用 `near_range_m`。

### 4.2 显示层换算

NM/kt/ft 只允许出现在显示层（viewer、CLI 的人类可读输出），不得进入核心、协议或 `/state` 的物理字段。

A/A viewer 的换算集中在：

- `tools/viewer/index.html:130`：`KT = 1.94384`（m/s→kt）、`KNM = 0.539957`（km→NM）、`M2NM = 1/1852`（m→NM）。
- `:141-142`：`iasKt(ms,h)` 用 ISA 速度比近似指示空速；`mach(ms,h)` 用 ISA 声速。它们是**显示近似**，不是核心物理。
- `:264-266`：高度 `m × 3.28084 → ft`；速度→kt；马赫数显示。

SAR viewer 当前主要用 km/m（`tools/sar_viewer.html:200,355,411`），没有 NM/kt/ft；如果新增，必须遵守同一规则：换算函数有名字、常量带单位、只出现在显示层。

规则：

- 核心/协议只传 SI；显示层负责 `m→ft`、`m/s→kt`、`m→NM` 等。
- 换算常量不得散落为魔数；一个显示模块内只保留一份。
- 显示层可以四舍五入；核心和协议在物理计算前不得提前舍入。
- 任何“指示空速/马赫”都是显示近似，不得反写回核心速度。

---

## 5. 时间与时间戳

### 5.1 时钟域

| 字段/概念 | 单位 | 时钟域 | 说明 |
|---|---|---|---|
| `t` / `t_s` | s | 仿真时间 | DCS `LoGetModelTime()` 或回放归一化时间；任务开始为 0 |
| `dt` / `dt_s` | s | 仿真时间 | 调用方传入的步长；必须 ≥ 0 |
| `age_s` | s | 墙钟差 | `Date.now()/time.time()` 与记录时刻的差 |
| `completed` | ms | 墙钟 | Unix epoch 毫秒；图像完成时间 |
| `received` | ms | 墙钟 | Unix epoch 毫秒；状态/数据到达时间 |
| `compute_ms` | ms | 墙钟 | 计算耗时，只用于诊断 |
| `wall` | s | 墙钟 | Unix epoch 秒；A/A snapshot |
| `seq` | 计数 | 每次服务运行 | 单调序号，不是时间；重启后从 1 开始，用 `generation` 区分 |

### 5.2 规则

- 核心只接收 `dt`，不读墙钟；同输入 + 同 `dt` 序列必须逐位一致（`src/core/core.lua:108-119`；`src/core/scheduler.lua`）。
- `dt < 0` 必须拒绝/断言；`dt = 0` 允许（不推进时间）。`live.py` 把完整帧间隔分段推进，单步上限 1 s（`tools/live.py:41`）。
- 仿真时间单调递增；检测到回退时 fail-closed：SAR Export 发 `FAIL,<id>,model_time_reset` 并清空任务（`src/export/aesa_sar_export.lua:228`）；A/A 实时管道丢弃重复/倒序帧（`tools/live.py` `feed`，`t - t0 <= prev_t` 分支）。
- `t` 的精度：A/A `%.3f`（`src/export/aesa_export.lua:43-46`）；SAR 位置/时间 `%.9f`，bearing `%.12f`（`src/export/aesa_sar_export.lua:174,253,263,286,291,300,305`）。不要在物理计算前按显示精度舍入。
- 采样率（当前）：A/A 10 Hz（`src/export/aesa_export.lua:9-10,237-240`）；SAR STATUS 1 Hz、POSE 60 Hz、MAPPOSE 0.25 s（`src/export/aesa_sar_export.lua:234-241,247-255,299-303`）。
- 墙钟只用于超时/年龄/耗时：状态超过 3 s 未更新即视为不 ready（`tools/sar_live.cjs:385,1266,1272`）；采集 30 s 超时（`:1269`）；MAP 任务有独立超时（`:1274`）。
- 时间戳缺失/非有限：拒绝该行/该任务，不得用 0 代替。`timestamp` 不能从 `seq` 推算。

---

## 6. 栅格、数组布局与图像方向

### 6.1 MAP 世界格网（canonical）

MAP 使用世界固定格网，索引由世界坐标直接决定：

```text
ix = round(x / cell_m)
iz = round(z / cell_m)
x  = ix * cell_m
z  = iz * cell_m
```

这与 `src/sar_core/map.cjs:93,109,118-129` 的 `createCache` 一致；`windowRect` 返回 `{ix0, iz0, nx, nz}`（`:138-143`）。

矩形 `{ix0, iz0, nx, nz}` 覆盖：

```text
ix ∈ [ix0, ix0 + nx)
iz ∈ [iz0, iz0 + nz)
```

协议/数组的 canonical 单元格：

```text
col ∈ [0, cols)
row ∈ [0, rows)
x = x0 + col * step
z = z0 + row * step
index = row * cols + col          -- 行优先，row 是慢轴，col 是快轴
```

即：

- **col 沿 +x 增加**（东/北取决于帧；DCS 世界 x=北）。
- **row 沿 +z 增加**（DCS 世界 z=东）。
- **row 0 = 最小 z 边；col 0 = 最小 x 边。**
- 数组内存布局是 row-major；`index = row * n + col`（`n=cols=rows` 时）。

这同时是 `CAPTURE_MAP` 的线上约定：`x0 = ix0*step`、`z0 = iz0*step`、`cols = nx`、`rows = nz`，Export 计算 `x = x0+col*step`、`z = z0+row*step`（`src/export/aesa_sar_export.lua:258-263`），服务端校验 `row*cols+col === sequence` 且 `x/z` 与格点一致（`tools/sar_live.cjs:121-122`）。

### 6.2 MAP 渲染器与采集一致（Gate 1 已修复）

`src/sar_core/map.cjs` 的 `renderFrame` 现在使用 canonical：

```text
x = cx + (col - half) * step
z = cz + (row - half) * step
index = row * n + col
```

即 `col→+x`、`row→+z`，与 `CAPTURE_MAP`、`MAPHEIGHT`、mosaic 和 `src/sar_core/geometry.cjs` 的 `mapCellToWorld` 一致。

Gate 1 前的旧实现是 `x = cx + (row-half)*step`、`z = cz - (col-half)*step`（转置 + z 反向），会让底图相对真值旋转/镜像。该错误已由 `tests/test_sar_gate1_map.cjs` 的四角向量锁定；旧快照没有 `grid_layout` 时 viewer 才按历史解释，新数据一律读 `grid_layout='col_x_row_z'`。

- `renderFrame`/`coverage`/`missingRects`/`planJobs` 使用同一映射；未知 `grid_layout` fail-closed。
- 新增消费者必须使用 `src/sar_core/geometry.cjs` 的 `mapCellToWorld`/`worldToMapCell` 或 `src/sar_core/geometry.lua` 的同名函数，不得各自写转置。
- viewer 在 Gate 5 改为只读 metadata（`grid_layout`/`center`/`bearing`/`size_m`），不再把 MAP 条目套进 SAR 场景的 `cross/ground` 公式。

`grid_layout` 目标取值：

| 值 | 含义 | 使用者 |
|---|---|---|
| `col_x_row_z` | canonical MAP：col=+x，row=+z | 新 Export/服务/渲染 |
| `cross_col_ground_row` | SAR 场景：col=cross，row=ground | SAR patch/engine |
| `legacy_x_row_negz_col` | 旧渲染：row=+x，col=-z | 仅旧快照兼容，禁止新生产者 |

### 6.3 SAR 小块场景栅格（canonical，当前已一致）

SAR patch 不是世界格网，而是以 `center`、`bearing` 定义的场景栅格：

```text
cross  = (col / (n - 1) - 0.5) * size_m
ground = (row / (n - 1) - 0.5) * size_m

x = center_x + cross * sin(bearing) + ground * cos(bearing)
z = center_z - cross * cos(bearing) + ground * sin(bearing)
y = 该 (x,z) 的地形高度
index = row * n + col
```

- `col` 沿 `cross` 轴，`row` 沿 `ground` 轴（视线方向）；`row 0` 是近端（ground=-size/2），`row n-1` 是远端。
- Export 的 `HEIGHT,id,index,...` 用 `row=floor(index/n)`、`col=index%n`，公式与引擎完全一致（`src/export/sar_collector.lua` HEIGHT 行；`src/scene/sar_scene_core.lua` 场景网格；`src/sar_core/geometry.cjs` 的 canonical row/col/index）。
- 这是**场景栅格**，不是 MAP 世界格网。bearing=0 时它恰好退化为 `row→+x`、`col→-z`，这正是当前 MAP 渲染器错误借用的方向；不要把两者混为一谈。

显示（②③ 栏）当前把图像行翻转：

```text
canvas row 0      = image row n-1   （远端 ground=+size/2）
canvas row n-1    = image row 0     （近端 ground=-size/2）
canvas col        = image col       （cross=-size/2 → +size/2，从左到右）
```

证据：`tools/sar_viewer.html:218-223` 的 `display.db[(width-1-row)*width+col]` 以及 `scale` 文案“纵轴：地距 +half → −half”。这是显示层的 y 轴转换，不改变数组布局。

### 6.4 显示 canvas 的 y 轴与朝向

显示层必须把“图像数组坐标”和“屏幕像素坐标”分开声明，且只在一个地方做转换。

当前两种视图：

| 视图 | 当前映射 | 实际朝向 |
|---|---|---|
| SAR ②③ 栏 | `canvas_x = col`；`canvas_y = n-1-row` | 场景坐标：右 = +cross，上 = +ground；随 `bearing` 旋转，不是世界地图 |
| mosaic 主视图 | `screen_x = (world_x - view_x)*scale`；`screen_y = (world_z - view_z)*scale`（`tools/sar_viewer.html:490-491`） | 按 DCS 官方轴：右 = +x（北），下 = +z（东），上 = -z（西），左 = -x（南）；**不是北向上** |

`src/sar_core/map.cjs:134-137` 把 MAP 帧称为 north-up，但这个说法只在错误的“x 东、z 南”标签下成立。按官方轴，当前 mosaic 是“北在右、东在下”，相对真正的北向上旋转了 90°。Gate 5 必须二选一：

1. **改为真北向上**（推荐给地图视图）：
   ```text
   canvas_x = (world_z - view_z) * scale + width/2
   canvas_y = -(world_x - view_x) * scale + height/2
   ```
   对 canonical MAP `(col,row)`（`x=x0+col*step`、`z=z0+row*step`）：
   ```text
   canvas_x = (row - half) * px_per_m
   canvas_y = (half - col) * px_per_m
   ```
   即屏幕右 = +z（东），屏幕上 = +x（北）。
2. **保留当前朝向**：屏幕右 = +x（北），屏幕下 = +z（东）；则所有“北向上”文案必须删除/改写，并明确“world x→右，world z→下”。

无论选哪种，canvas y 轴向下为正；向北向上时对 `x` 取负号，向东向右时对 `z` 取正号。转换函数只放在 viewer 的视图层，不得进入 `sar_core`/`sar_map`，也不得让每个图层各写一套。

### 6.5 尺寸、计数与 metadata

| 字段 | 含义 | 关系 |
|---|---|---|
| `size_m` | 图像/场景物理边长 | SAR patch：`size_m/(width-1)` = 像元步长 |
| `width` | 图像每边采样数 | `width × width` 个 dB 值 |
| `image_step_m` | SAR 图像像元步长 | `size_m/(width-1)` |
| `cell_m` | MAP 格网间距 | 世界格点间距 |
| `span_m` | MAP 帧物理边长 | `(cells-1)*cell_m`（`src/sar_core/map.cjs:83`） |
| `cells` | MAP 每边格数 | `n = 2*ceil(range/cell)+1`（`src/sar_core/map.cjs:181-187`） |
| `cols`/`rows` | 采集矩形计数 | `cols=nx`、`rows=nz`；不得互换 |
| `n` | 旧 SAR 采集节点数 | 128/17、512/33、2048/65；`n` 与 `width` 不是一回事 |

MAP metadata 至少应带：`center`、`cell_m`、`cells`、`span_m`、`grid_layout`、`sector`（heading/azimuth/range）、`db_ref`、`mode`。SAR metadata 至少应带：`center`、`bearing`、`size_m`、`width`、`image_step_m`、`quality`、`focuser`、`db_ref`、`mode`。viewer 不得自行推导这些值。

---

## 7. dB 参考、量化与 `no_data`

### 7.1 两条 dB 路径与 `db_ref`

| 产品 | dB 参考（`db_ref`） | 下限 | 证据 |
|---|---|---|---|
| SAR patch（`src/sar_core/engine.cjs`） | **逐帧峰值** `frame_peak`：0 dB = 本帧最大功率 | -40 dB | `src/sar_core/engine.cjs:26`；`spec/display.json#/db/ref_by_product` |
| MAP/DBS（`src/sar_core/map.cjs`） | **固定材质参考** `fixed_material`：0 dB = 最亮材质系数法向入射、斑点均值；`peak_norm:true` 可退回逐帧峰值 | -40 dB | `src/sar_core/map.cjs:487,500`；`docs/sar-in-mission.md:77,92` |
| `/image/<seq>` Int8 | 0.25 dB 量化，`round(db*4)`；条目带 `db_ref` | 钳 `-127…+48`；`-128` = no data | `tools/sar_service/mosaic_store.cjs:63-65` |

`db_ref` 的分配由 `spec/display.json#/db/ref_by_product` 单点声明（`sar: frame_peak`、`map: fixed_material`、`peak: frame_peak`）。跨模式/跨帧比较亮度必须同时看 `db_ref`；不同参考之间不得直接比较。

### 7.2 `db_ref` 与量化（Gate 5 已落地）

每个图像结果/拼接条目必须带：

```text
db_ref = "fixed_material" | "frame_peak"
```

- `fixed_material`：0 dB = 最亮材质法向入射、斑点均值；MAP/DBS 默认。
- `frame_peak`：0 dB = 本帧峰值；SAR patch 当前行为，迁移后可改为固定参考。
- 消费方在 `db_ref` 缺失或未知时不得跨条目比较亮度；显示应标注“相对峰值”或“固定参考”。

量化规则（MAP/mosaic）：

```text
q = clamp(round(db * 4), -127, 48)     -- 0.25 dB 步进
db = q / 4
q = -128                               -- no data，不参与插值/统计/亮度映射
```

`-40 dB` 是**完整浮点**的测到暗值下限，不是 no data；`-127` 是 Int8 的有效最暗值（≈ -31.75 dB），-40 dB 在量化时会钳到 -127，不能从 -127 反推 -40。只有 `-128` 表示“没看过/扇形外”。

### 7.3 三种表示

| 场景 | 表示 | 规则 |
|---|---|---|
| JS 内部浮点矩阵 | `NaN` | 只在内部；不得发送到 JSON |
| JSON（`/snapshot`、`/state`） | `null` | `JSON.stringify(NaN)` 会变成 `null`；Python 用 `_f` 主动转 `None` |
| Int8（`/image/<seq>`） | `-128` | 只表示 no data；量化前先判断 `Number.isFinite` |
| 协议文本 | 不发送 NaN/Inf | 发送前校验；缺值用 `unknown`/`unavailable` 或省略可选字段 |
| 地表类别 | `"unknown"` | 不是 `null`，因为“查询成功但未知”与“接口不可用”不同 |

viewer 的双线性插值必须对 `-128` 做哨兵保护：四邻中任一为 `-128` 就退回最近邻，避免把 `-128` 当 `-32 dB` 画成暗边（`tools/sar_viewer.html:520-530`）。

---

## 8. 协议

### 8.1 端口与方向

| 端口 | 方向 | 用途 | 证据 |
|---|---|---|---|
| TCP 3590 | DCS Export → Python | A/A V1 文本行 | `src/export/aesa_export.lua:8`；`tools/receiver.py:17` |
| HTTP 3591 | 浏览器 → Python | A/A viewer + SSE | `tools/live.py:36` |
| TCP 3592 | DCS Export → Node | SAR/MAP 采集 | `src/export/aesa_sar_export.lua:3`；`tools/sar_live.cjs:228` |
| HTTP 3593 | 浏览器 → Node | SAR viewer + REST | `tools/sar_live.cjs:228,1081-1121` |
| TCP 3594 | DCS Hook → Node | 场景/GMTI 桥 | `src/hooks/aesa_sar_scene_hook.lua:58`；`tools/sar_bridge.cjs:8` |

所有监听仅限 `127.0.0.1`；HTTP 还要校验 `Host`，POST 要校验 `Origin`（`tools/sar_live.cjs:1083-1085,1135-1137`）。端口号是当前硬编码债务，Gate 2 移到 `spec/protocol.json`。

### 8.2 A/A 行协议（V1）

行协议是文本字节流：分隔符、数字、字段名/机器 token 为 ASCII；名称（`typeName`/`Name`/`id`）按 UTF-8 字节透传，空格替换为 `_`；接收端按 UTF-8 解码（`tools/receiver.py:150,200`）。`\n` 结尾；空格分隔；每个连接先发 `V1`（`src/export/aesa_export.lua:221`）。接收端按 `A` 行分帧；`T`/`O`/`L`/`E` 归属当前帧。

| 行 | 字段数 | 字段 | 说明 |
|---|---|---|---|
| `V1` | 1 | `V1` | 连接握手/版本 |
| `P` | ≥1 | `P <probe text>` | 首帧字段名探针，防御式适配 |
| `A` | 10（旧 9） | `A t type x y z vx vy vz vel_valid` | 本机；新 `A` 开新帧；旧行缺 `vel_valid` 按 false |
| `O` | 5 | `O t heading pitch roll` | 可选姿态；**弧度**，基线核心约定 |
| `T` | 12（旧 11） | `T t id type coalition x y z vx vy vz vel_valid` | 单位；`id` 是 DCS 对象 ID；旧行缺 `vel_valid` 按 false |
| `L` | 4 | `L t id 0/1` | 可选地形可见性；缺失 = unknown |
| `E` | 7 或 10 | `E t id [x y z] R vclose rcs flags` | 引擎雷达接触，对照用 |

格式：`fmt` 用 `%.3f`；非数字仍写 `0.000`，但 Gate 1 起速度行尾 `vel_valid=0` 明确标记无效，接收端不得把 0 当真实速度。`typeName`/`id`/`Name` 的空格替换为 `_`（`src/export/aesa_export.lua:38-41`）。`O` 行只在 Heading/Pitch/Bank 都是 number 时发送；缺失姿态由回放侧按速度航向/平飞回退。

A/A 的接收端对无法解析的行返回 `None`/忽略（`tools/receiver.py:20-57`），这是为了兼容旧录制；但**已知行的字段数错误也不得当成有效帧**。

`T` 行的 `coalition` 语义是 DCS `CoalitionID`（0=unknown，1=红，2=蓝）。Gate 1 起只读 `CoalitionID`；字段缺失或非法一律输出 `unknown`，不回退 `coalition`/`Country`，避免把国家编号当阵营。`T`/`A` 行速度缺失时写 0 但 `vel_valid=0`；接收端可做差分估计，但不得把估计值标成有效。

### 8.3 SAR/MAP 行协议

结构字段/机器 token 为 ASCII；`\n` 结尾；逗号分隔；字段按位置解析；不支持引号/转义；名称中的逗号/换行必须被 sanitize 或拒绝。服务端会去掉行尾 `\r`（`tools/sar_live.cjs:1037-1038`）。

连接握手：

```text
HELLO,SAR1
CAPS,2,<surface provider>[,map]
```

`SAR1` 是通道/协议名；`CAPS` 的 `2` 是能力版本，两者独立。`CAPS` 第 2 字段是能力版本 2；第 3 字段是 `terrain.GetSurfaceType` 或 `unavailable`；可选第 4 字段 `map` 表示支持增量 MAP。新增可选尾字段不升版本，旧服务/旧 Export 必须能忽略（`src/export/aesa_sar_export.lua:344-346`；`tools/sar_live.cjs:11,83`）。

DCS → 服务端：

| 行 | 字段 | 说明 |
|---|---|---|
| `STATUS` | `t,provider,th,lh,agl[,geo]`（整行 6 或 7 字段） | 1 Hz；`provider ∈ {terrain.GetHeight, unavailable}`；`th/lh/agl` 可为 `unknown`；`geo` 为 0/1，旧 Export 可省略 |
| `BEGIN` | `id,x,z,bearing,size,n` | SAR patch 中心/场景基/尺寸/节点数 |
| `TARGET` | `id,lat,lon,range_m,relative_track_deg` | 地理模式确认目标；相对角单位为度 |
| `HEIGHT` | `id,index,x,y,z` | 地形节点；`index` 为 row-major 序号 |
| `SURFACE` | `id,index,class` | 五类小写词或数字 1–5 |
| `POSE` | `id,seq,t,x,y,z` | SAR 轨迹，60 Hz；`seq` 从 0 递增 |
| `END` | `id,seq,t` | 轨迹结束；`seq` 必须等于 POSE 数 |
| `FAIL` | `id,reason[,detail]` | 任务失败；reason 是稳定机器 token |
| `MAPBEGIN` | `id,x0,z0,cols,rows,step` | MAP 原点（相对请求已解析） |
| `MAPHEIGHT` | `id,col,row,x,y,z` | MAP 格点；**col↔x，row↔z**（canonical） |
| `MAPSURFACE` | `id,col,row,class` | 地表类别；细词汇用 `+` 连接 |
| `MAPPOSE` | `id,seq,t,x,y,z,vx,vz` | MAP 位姿，0.25 s；首帧 `seq` 可任意基线，之后严格 +1 |
| `MAPEND` | `id,count,t` | `count = cols*rows`；不完整则失败，不生成部分图 |

服务端 → DCS：

| 行 | 字段 | 说明 |
|---|---|---|
| `CAPTURE` | `id,side,range[,size,n]` | 侧视 SAR；`side=±1`；`range` m |
| `CAPTURE_GEO` | `id,lat,lon[,size,n]` | 地理中心 |
| `CAPTURE_WORLD` | `id,x,z[,size,n]` | 世界点 |
| `CAPTURE_MAP` | `id,x0,z0,cols,rows,step` | MAP 绝对矩形 |
| `CAPTURE_MAP_AT` | `id,dx,dz,cols,rows,step` | MAP 相对本机矩形；Export 解析后回 `MAPBEGIN` 的绝对原点 |
| `CANCEL` | `CANCEL` | 取消当前 SAR/MAP 任务 |
| `SURFACE_FINE` | `SURFACE_FINE` | 请求 16 类细地表词汇；旧 Export 忽略 |

版本/兼容规则：

- 版本 token 是协议语法的一部分；**破坏性变更**（字段顺序、单位、含义、必填项）必须换新 token（如 `SAR2`/`V2`），不能在同一版本里偷改。
- **加法式变更**（可选尾字段、新行）可以在同版本内做，但必须满足：旧解析器忽略未知行/未知尾字段；新解析器能处理旧端缺失；能力通过 `CAPS` 或行前缀显式通告。`O`/`L`、`CAPS` 的 `map`、`SURFACE_FINE` 都是这种模式。
- 不得复用已废弃字段的位置；不得在旧字段里改变符号或单位。
- 解析器对未知**行类型**可以忽略（A/A 兼容旧录制）；对已知行类型的错误字段数/非法数字必须拒绝，不能“尽量解析”。
- 单行长度：SAR Export 命令上限 160 字符（`src/export/aesa_sar_export.lua:148`）；服务端单行上限 512 字符、接收缓冲 65536 字节（`tools/sar_live.cjs:78,1036`）。
- 数值：只发送十进制有限数；`NaN`/`Inf` 不出现在协议文本；缺值用 `unknown`/`unavailable`，不写 0。
- `FAIL` 的 reason 是稳定 token（如 `no_ownship`、`terrain_unavailable`、`target_range_1_to_50_km`），detail 可带数字；客户端不要把人类可读句子当协议分支。

### 8.4 场景/GMTI 桥（3594）

握手 `HELLO,SARSCENE1`，随后 `CAP,...`；命令 `SCENE,id,x,z,b,size,n`、`MOVER,id,cx,cz,radius`、`SCENE`/`MOVER` 的取消；数据行 `SURFACE`、`OBJECT`、`SCENE_END`、`MOVER`、`MOVER_END`、`MOVER_FAIL`。桥必须通过显式能力字符串报告 `land.getSurfaceType`、`world.searchObjects`、`net.dostring_in` 的可用性；缺失能力时返回 `unavailable`，不得用假对象/假高程填充（`src/scene/aesa_sar_mission.lua:31-34,102-150`；`src/hooks/aesa_sar_scene_hook.lua:36-50,58-105`；`tools/sar_bridge.cjs:41-73`）。

### 8.5 `/state` 与图像端点（D3，Gate 5 已落地）

- `/state` 只回摘要 + `resultSeq`，不返回图像矩阵；`resultSeq` 是最近一次完成图像/结果的 `seq`，没有结果时为 `null`（`tools/sar_service/http_api.cjs:59-93`）。摘要包含 `connected`、`phase`、`error`、`resultSeq`、`mode`、`quality`、`focuser`、`db_ref`、`generation`、`mosaic{latestSeq,count,limit,dropped}`、`imageWindow`（20–160°，`spec/protocol.json#/sar/image_window`）与能力/兼容段。
- 图像统一走 `/image/<seq>`（Int8，0.25 dB 步进）或 `/snapshot`（完整浮点结果与输入）；`/mosaic/<seq>` 保留为 `/image/<seq>` 的兼容别名（`tools/sar_service/http_api.cjs:21`）。
- `/state` 每 700 ms 轮询；`?since=<seq>` 只回新摘要（`tools/sar_service/http_api.cjs:93`；`tools/sar_viewer.html:1354`）。4 KB 目标按 demo 单条（3664 B）与增量轮询计；满 50 条 mosaic 的全量摘要约 17 KB、live 含 status/caps/target 约 4.1 KB，均只有摘要——硬约束是永不含矩阵。
- viewer 在 `completed`/`resultSeq` 变化时拉图；不得每 700 ms 重新下载矩阵，也不得在页面里重算物理或分辨率（`tools/sar_viewer.html`）。
- 旧客户端在 `result` 缺失时降级到 `/snapshot`；不得把缺失当空图。

---

## 9. 配置与生成物

### 9.1 单一事实源

Gate 2 起，`spec/` 是唯一来源：

```text
spec/physics.json      光速、玻尔兹曼、参考温度
spec/radar.json        A/A 雷达、PRF（按名字）、驻留、波束、扫描锥
spec/sar.json          footprint、带宽、输出宽度、脉冲预算、PFA、散射
spec/protocol.json     端口、greeting、版本、行 schema、上限、超时、配额
spec/deployment.json   Saved Games 路径、Scripts 子目录、DLL、日志
spec/display.json      dB 量化/参考、mosaic、轮询、量程、颜色
spec/dcs_profiles/     DCS build/module 的字段、能力、符号、偏移、数据源
```

生成物：

```text
src/shared/config.lua
src/shared/config.cjs
src/shared/protocol.lua
src/native/generated/config.h
tests/fixtures/config.*
```

规则：

- 生成物第一段必须有 `DO NOT EDIT`、generator、输入 list、`input-sha256`、生成时间/版本；例如：
  ```text
  -- DO NOT EDIT -- generated by scripts/gen_config.cjs
  -- from spec/physics.json, spec/protocol.json
  -- input-sha256: <64 hex>
  ```
- `node scripts/gen_config.cjs --check` 必须零 diff；生成器版本/规范变化时 hash 变化是预期的。
- 任何人不得手改生成物；改参数只改 `spec/` 后重生成。
- 生成物必须可由仓库内脚本复现；不得依赖本机路径、时间戳或未提交文件。
- 常量只允许出现在 `spec/`、生成物、测试 fixture。`rg` 不得在业务代码里找到第二份 `299792458`、`0.03`、`3590/3592/3593/3594`、`128/17` 等。
- 配置值必须带单位后缀和来源标记（官方/公开估计/推导/项目设定）；非法值在加载时 fail-closed。
- 部署路径只来自 `spec/deployment.json` 或 `--saved-games` 参数；不得把用户名/机器路径写进源码（`../AGENTS.md:66`）。

### 9.2 `[当前]` 过渡状态（Gate 2/4 后）

- `spec/` 已是唯一参数源；A/A 配置由 `src/shared/config.lua` 生成，`src/core/init.build` 加载并支持注入。SAR 常量仍在 `tools/sar_*.cjs`，Gate 5 收敛。
- `src/adapters/dcs/rcs_data.lua` 是生成文件：由 `scripts/extract_rcs.py` 从 DCS 明文数据库提取，文件头写明“生成文件，勿手改”（`scripts/extract_rcs.py:1-13`）。Gate 6 补英文 `DO NOT EDIT` 和 hash。
- RCS 数据政策：官方明文值优先，分档兜底必须标 `fallback-estimate`；不得把兜底值伪装成官方（`src/adapters/dcs/rcs.lua`）。核心 `src/core/rcs.lua` 只提供接口，不含机型名。

---

## 10. 错误处理与 fail-closed

### 10.1 分层规则

| 层 | 错误处理 |
|---|---|
| 核心物理/调度/航迹 | 纯函数/显式错误；不吞异常；不读外部；非法输入 `error`/断言 |
| DCS 适配器 | 每个外部调用 `pcall`；单对象失败跳过并记录；能力缺失返回 `unknown`/`unavailable` |
| Export/传输 | 任务级失败发 `FAIL` 并清空状态；连接失败关闭重连；不发送半帧/半图 |
| 服务/HTTP | 边界校验，抛 `Error`；HTTP 400/403/404/409；不返回 500 作为正常业务错误 |
| 原生 | 符号/长度/profile 校验失败 -> 只读/不注入；不崩溃进程 |
| 显示 | 缺字段显示 `—`/原因；不猜、不补 0、不重算物理 |

### 10.2 fail-closed 矩阵

| 缺失/异常 | 必须的行为 | 不得的行为 |
|---|---|---|
| `CoalitionID` 缺失 | `coalition=unknown` | 用 `Country` 冒充阵营 |
| 速度字段缺失/全 0 | `vel_valid=false`；差分估计或明确未知 | 当成真实 0 m/s |
| `terrain.isVisible` 缺失 | `visibility=unknown`；仍应用球面视距 | 当成可见或不可见 |
| `net.dostring_in`/场景桥缺失 | 场景/GMTI `unavailable`；页面显示原因 | 用旧列表/假对象 |
| `terrain.GetHeight` 缺失 | SAR/MAP 拒绝，`terrain_unavailable` | 用平地/0 高程 |
| `LoGetModelTime` 回退 | `model_time_reset`，清任务 | 继续用旧时间 |
| 协议行字段数/数字非法 | 拒绝该行/任务；SAR 发 `CANCEL`/`FAIL` | 尽量解析/补默认值 |
| 图像格子未采集 | `no_data`（NaN/`-128`） | 当成 -40 dB 暗地面 |
| 原生符号/偏移/profile 不匹配 | 只读/禁用写路径 | 猜测偏移并注入 |
| 版本/能力不匹配 | 拒绝该功能并说明所需版本 | 静默降级成错误结果 |

### 10.3 fail-open 点（Gate 1 后）

Gate 1 已修（2026-10-17）：

- 阵营：只读 `CoalitionID`；缺失或非法输出 `unknown`，不回退 `Country`。
- 速度：本机走 `LoGetVectorVelocity`；A/T 行尾 `vel_valid`；`receiver.py`/`live.py` 共用 `VelocityPatcher`。
- 手动 `/map` 失败：立即关闭 `mapSession.active`，100 ms 定时器只服务连续巡逻。
- `readable()`：校验完整页范围，越界返回 false。
- `aesa_fc_hook.lua`：默认 `mode=0`（只读），非法 mode 强制 0；`feed` 仅在 `mode=1` 时生效。

仍存在的边界：

- `src/export/aesa_export.lua` 的 `fmt` 对非数字位置/速度仍写 `0.000`；速度已由 `vel_valid` 标记，位置字段的完整性留待 Gate 3/4 的适配层校验。
- 原生仍是单 DLL：写路径默认关闭，但未与 trace 独立；Gate 6 拆 `fc_trace`/`fc_inject`。
- `DCS.setUserCallbacks` 等宿主 API 仍无能力守卫；Gate 3 的 compat/probe 处理。

错误信息要求：面向用户的原因用中文短句；机器分支用稳定 token；日志带 `t`/`id`/`reason`；同一错误不要每帧刷屏（首次 + 每 N 次/状态变化）。

---

## 11. 文档状态标签

每篇 `docs/*.md` 顶部必须有且只有一个状态：

```text
- 状态：current | historical | external-reference | draft
```

含义：

| 标签 | 含义 | 维护规则 |
|---|---|---|
| `current` | 描述当前代码/协议/操作，可作为行为依据 | 与代码同一提交更新；链接必须可达；过期即改标签或删内容 |
| `draft` | 提案、计划、未实现设计 | 不得作为当前行为依据；实现后要么改 `current`，要么归档 |
| `historical` | 历史快照、已完成/已废弃的设计 | 只读；保留日期和“被谁取代/为何保留”；不复制代码到现役 |
| `external-reference` | 外部资料、调研、第三方规范 | 只读；标来源/日期/适用范围；不参与构建 |

补充：

- 文档内某节可以是 `draft`（例如“Gate 5 目标”），但必须在标题或段落里明确；不能让读者误以为已实现。
- 文档互相引用使用相对链接；`audit_repo` 检查死链。
- `worklog/` 是历史记录（gitignored 本机数据，不入库），不作为规范；`docs/research/` 是 `external-reference`；`docs/refactor-plan.md` 在状态改为 `current` 前应按 `draft` 使用（当前头部写“待执行”）。
- 生成物用 `DO NOT EDIT`，文档用状态标签；两者不要混用。

---

## 12. 测试命名与确定性

### 12.1 命名与运行器

| 层 | 命名 | 运行方式 |
|---|---|---|
| Python 单元 | `tests/test_*.py`、`unittest` | `python tests/run_tests.py`、`python tests/test_review_regressions.py` |
| Python 集成 | `tools/integration_check.py` | 手动/CI |
| Lua 单元 | `tests/test_*.lua` | 由 Python/Node 宿主加载；`AESA_LUA` 指向 Lua 5.1 |
| Node 单元/集成 | `tests/test_*.cjs`、`node:test` | `node --test tests/test_sar_*.cjs` |
| 安装/部署 | `tests/test_install_*.cjs` | `AESA_LUA` 可用时运行；否则 skip 并写原因 |
| 原生 | `tests/test_*_dll.py` | 需要 DCS `bin`/DLL；否则 skip 并写原因 |
| 基线 | `tests/baseline/*.json` | `test_all` 汇总；只存摘要/哈希，不存大图 |

测试名应当描述行为/缺陷，而不是实现细节；每个 bug 先写失败测试，再修（`AGENTS.md:47`；`docs/refactor-plan.md:337`）。

### 12.2 确定性

- 同配置 + 同真值 + 同种子必须逐位一致；回放/SAR 至少连跑 3 次，任一失败即 Red（`docs/refactor-plan.md:601-605`）。
- 物理随机只来自注入的 RNG（`src/core/constants.lua:41-48`）；MAP 散斑/起伏用世界坐标哈希（`src/sar_core/map.cjs`）；SAR 散射点用场景 seed（`src/sar_core/scatterers.cjs`）。
- 不得依赖 `pairs`/对象插入顺序/`Map` 迭代顺序来决定输出；需要顺序时按数值 `id`/`seq` 排序，字符串 id 用稳定字典序（Gate 1 已修：`src/export/aesa_export.lua:97`、`src/core/core.lua` 的目标置换、`src/core/tracker.lua` 的 `track_ids`/`sorted_ids`）。
- 不得在核心/物理中使用墙钟；`performance.now()` 只进 `compute_ms`。
- 浮点比较：契约测试用绝对/相对 `1e-9`（或明确记录的更严格容差）；跨语言几何向量用固定输入/期望值；图像量化允许 0 或 1 LSB，不能“看起来差不多”。
- 协议测试必须断言字段数、单位、符号、`unknown`/`no_data`、版本/能力；不能只断言“能解析”。
- 新增约定测试建议：
  - DCS→ENU 与 ENU→DCS 固定向量（含 heading 0/90/180/270）。
  - MAP `(col,row)` → 世界点 → 渲染帧的往返。
  - `q=-128` 不参与插值/统计；`q=-127` 是有效值。
  - 同一输入三次渲染 `db` 逐位相等。
  - 每个协议行的最小/最大字段数、非法行拒绝。

### 12.3 skip 规则

- 缺 DCS Lua/DLL/实机环境可以 skip，但必须打印原因；`blocked` 不算 Green（`docs/refactor-plan.md:601-605`）。
- 关键套件（核心、SAR、协议、安装）不得静默 skip；skip 数量/原因由 `test_all`/`audit_repo` 汇总。
- 不允许通过注释测试、降低阈值、删断言来变绿。

---

## 13. 当前债务与 Gate 映射

以下 `[当前]` 证据是 Gate 0/Gate 1 的历史路径（SAR 单文件已在 Gate 5 拆分），保留作追溯；现役路径见 `docs/file-inventory.md`。

| # | 债务 | `[当前]` 证据 | `[目标]` | Gate |
|---|---|---|---|---|
| 1 | MAP 采集/渲染 row/col 相反 | `src/export/aesa_sar_export.lua:258-263` vs `tools/sar_map.cjs:482-497,516` | canonical `col↔+x,row↔+z` + `grid_layout` | 1 |
| 2 | 三套航向约定（DCS/核心/地图） | §3.2–§3.4；历史 `src/aesa/physics.lua`（已删除） | ENU 罗盘航向，只在 `frame.lua` 转换（Gate 4 已完成） | 4 |
| 3 | 核心直接使用 DCS 轴/`-Z` | 历史 `src/aesa/physics.lua`（已删除） | ENU 核心，无 DCS 语义（Gate 4 已完成） | 4 |
| 4 | `_ms` 表示 m/s | 历史 `src/aesa/config.lua`（已删除）；现 `spec/`/生成物 | `_mps`；`_ms` 仅毫秒（Gate 2 已完成） | 2 |
| 5 | SAR/MAP dB 参考不统一 | `tools/sar_engine.cjs:105-108`；`tools/sar_map.cjs:604-626` | 每条目 `db_ref` | 5 |
| 6 | `/state` 带完整矩阵 | `tools/sar_live.cjs:1088-1119` | 摘要 + `resultSeq`；`/image/<seq>` | 5 |
| 7 | viewer 重算物理/套用场景换算 | `tools/sar_viewer.html:195-209,480-488,686-688` | 只读 metadata/snapshot | 5 |
| 8 | `pairs` 顺序影响输出 | `src/export/aesa_export.lua`；`src/core/core.lua`；`src/core/tracker.lua` | 稳定排序（Gate 1 已修） | 1 |
| 9 | 缺速度/阵营时补 0/Country | `src/export/aesa_export.lua`；`tools/receiver.py` | `vel_valid=false`、`coalition=unknown`（Gate 1 已修） | 1 |
| 10 | 原生默认注入/长度校验不足 | `src/hooks/aesa_fc_hook.lua`；`src/native/fc_probe/aesa_fc.c` | 默认只读 + 完整范围校验（Gate 1 已修）；DLL 拆分仍在 Gate 6 | 6 |
| 11 | 端口/常量/生成物多处硬编码 | `src/export/aesa_export.lua:8`；`src/export/aesa_sar_export.lua:3,7`；`tools/sar_live.cjs:13` | `spec/` + 生成物 | 2 |
| 12 | viewer 轴标签错误 + mosaic 旋转 90° | `tools/sar_viewer.html:259,490-491,834`；`tests/test_sar_viewer.cjs:929-936` | 官方轴：x 北、z 东；真北向上或明确当前朝向 | 5 |
| 13 | 手动 `/map` 失败无限重试 | `tools/sar_live.cjs` | 失败关闭 active；仅连续模式重试（Gate 1 已修） | 1 |

---

## 14. 关键证据索引

- A/A 采样/协议：`src/export/aesa_export.lua`；`tools/protocol.py`、`tools/ingest.py`、`tools/truth.py`
- A/A 解析/回放：`tools/lua_host.py`、`tools/live.py`、`tools/receiver.py`、`tools/replay.py`
- 核心物理/帧：`src/core/geometry.lua`、`src/core/beam.lua`、`src/core/detection.lua`、`src/core/core.lua`、`src/core/tracker.lua`；`src/adapters/dcs/frame.lua`
- 调度/时间：`src/core/scheduler.lua`、`src/core/core.lua:108-119`
- SAR Export/命令：`src/export/{aesa_sar_export,sar_collector,sar_protocol}.lua`
- MAP 引擎：`src/sar_core/map.cjs`
- SAR 场景/引擎：`src/sar_core/{engine,focus,pfa}.cjs`；`src/scene/{sar_scene_core,sar_mission_env}.lua`
- 服务/协议/状态：`tools/sar_service/*.cjs`、`tools/sar_live.cjs`
- viewer：`tools/sar_viewer.html:218-223,259-261,480-530,686-688,834`；`tools/viewer/index.html:130,141-142,264-266`
- 文档决策：`docs/refactor-plan.md:72-85,100-128,333-363,492-527,532-563,591-619,668-710`
- 坐标/理论：`docs/theory-notes.md:11`；`docs/design-phase2.md:24-36`；`docs/sar-in-mission.md:77,92,114`

---

## 15. 变更纪律

- 修改本文必须同步检查：引用行号是否漂移、`[当前]`/`[目标]` 是否被误读、Gate 表是否需要更新。
- 修改任何跨层契约（坐标、单位、协议、栅格、dB、`no_data`）必须同时改：生产代码、测试、本文、`docs/architecture.md`（如需 ADR）、以及 `spec/`/生成物（如涉及参数）。
- 新增语言/进程边界时，先在本文件定义帧、单位、时间、缺失值、版本规则，再写代码。
- 发现实现与本文冲突时：先判断是“文档过期”还是“实现缺陷”；不要为了通过测试而改文档迁就错误行为。

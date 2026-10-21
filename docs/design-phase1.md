# 阶段一设计文档：AESA 仿真核心

状态：historical（设计记录，2026-09-27；模块已迁至 `src/core/`，见 `docs/architecture.md`）。
日期：2026-09-27。理论依据：`docs/theory-notes.md`（下称"理论笔记"）。路线图位置：`docs/feasibility.md` §4 阶段一。

## 1. 目标 / 非目标

**目标**：纯 Lua、无 DCS 依赖的 AESA 仿真核心库——驻留调度器 + 单驻留检测物理 + 航迹管理，行为可用单元测试完全复现（种子随机）。
**非目标**：任何 UI、任何 DCS API 调用、A/G 模式、ECM/NCTR/数据链（阶段二+）、波形级/阵列级仿真（理论笔记 §8）。

## 2. 模块结构（historical：原 `src/aesa/`，Gate 4 已迁至 `src/core/`）

> 下列为 2026-09-27 的设计布局，保留作历史对照。现役路径：`init`、`physics`、`beam`、`detection`、`geometry`、`constants`、`scheduler`、`tracker`、`measurement`、`rcs`、`snapshot`、`core` 均在 `src/core/`；DCS 回放/RCS 在 `src/adapters/dcs/`；`config.lua` 已由 `spec/` 生成到 `src/shared/config.lua`。

```
src/aesa/
  init.lua        -- 加载入口：build(root) 用 dofile 组装各模块（DCS 侧同路径）
  config.lua      -- 参考雷达配置（理论笔记 §1 表 + PRF 三档 + 调度参数），单独文件便于替换
  physics.lua     -- 纯函数：snr / pd / 盲区与 notch 判定 / 波束几何与门限
  scheduler.lua   -- 事件调度器：光栅/回访/STT，完成事件、账本与驻留日志
  tracker.lua     -- 航迹管理：2/3 起始（时间窗简化）、最近邻关联、coast
  core.lua        -- 组装：step(dt)；依赖注入三个适配器
  rcs.lua         -- RCSProvider 默认实现（官方标量表 + 分档兜底，来源标注）
  rcs_data.lua    -- 机型 RCS 数据（scripts/extract_rcs.py 生成，勿手改）
```

数据流（每次 step）：

```
step(dt) → scheduler 取时间片 → 产出驻留(波束指向/PRF/Td)
        → 对该驻留波束覆盖的目标：TruthSource 查真值 → physics 算 SNR/Pd → 伯努利判定
        → 检测/漏检事件 → tracker 更新 → OutputSink 输出(航迹表 + 驻留日志)
```

## 3. 适配器契约（阶段二的插槽）

> 现役契约：核心输入为 ENU，DCS 转换只在 `src/adapters/dcs/frame.lua`；RCSProvider 拆为 `src/core/rcs.lua` 接口 + `src/adapters/dcs/rcs.lua` 分类；`on_dwell` 已拆 `beam/truth/measurement/detection`（见 `docs/architecture.md` 附录 A）。以下为原始设计。

```lua
TruthSource  : targets(now) → {{id, typeName, coalition, pos={x,y,z}, vel={x,y,z}}, ...}
               ownship(now) → {pos={x,y,z}, vel={x,y,z}, heading?, pitch?, roll?} -- 位置保留 DCS 世界系；核心 heading=0 朝 -Z
RCSProvider  : get(typeName) → {rcs_m2, source}   -- source: "ed-plaintext" | "fallback-estimate"
OutputSink   : on_tracks(tracks)   -- 每步后回调；传的是活表引用，需要快照请自行拷贝
               on_dwell(dwell)     -- 每驻留一条审计记录（指向/PRF/Td/覆盖目标/判定结果）
-- 适配器方法会被核心以 obj:method(...) 调用（首个参数为 self）
```

离线实现：`tests/helpers/` 提供脚本化真值（时间轴关键帧插值）与断言收集器。DCS 适配器（阶段二）实现同一契约，核心零改动。

## 4. 关键设计决定

1. **纯核心**：不碰 `os/io/require`（仅 `init.lua` 内做模块加载）；随机数用注入的可种子 LCG（避免依赖 `math.random` 全局状态，测试可复现）。
2. **Lua 5.1 子集**：不用 5.2+ 特性（goto、整除、_ENV、位运算符）；用 `local function`；兼容 LuaJIT。写进代码规范。
3. **时间**：核心只看调用方传入的 dt（秒，浮点）；内部时间片 1 ms，dt 不足一片则累积。
4. **确定性**：同（配置+真值脚本+种子）→ 同结果；所有随机消费点集中在 physics 判定。
5. **配置驱动**：雷达参数、PRF 档、回访率表、扫描锥、驻留补偿开关全部在 config.lua，带来源注释（理论笔记 §1 的【假设】标注逐条对应）。
6. **账本**：scheduler 维护时间预算账本，暴露 `stats`（搜索帧周期、回访达标率、预算占用率）供 T7/T9 断言。

## 5. 测试策略

- 运行时：`pip install lupa`，测试用其 **lua51** 变体（LuaJIT 未随轮子分发；5.1 是比 LuaJIT 更严格的兼容检查）；`tests/run_tests.py`（Python 驱动，无第三方测试框架依赖）。
- 每条断言对应理论笔记 §9 的 T1–T10；T1–T6 为闭式/半闭式（容差 0.5–1%），T7–T10 为行为断言（构造场景 + 种子固定）。
- 新增规则：每个 bug 修复先补一个失败测试再修。

## 6. 交付物与顺序（2026-09-27 全部完成，12/12 测试通过）

1. ✅ 骨架 + config.lua（含参数与来源注释）
2. ✅ physics.lua + T1–T6 测试
3. ✅ scheduler.lua + T7/T9/T10 测试
4. ✅ tracker.lua + T8 测试
5. ✅ core.lua 组装 + 场景级冒烟测试（多目标光栅扫描→起始→回访→notch 凹口）
6. ✅ `scripts/extract_rcs.py` + RCS 数据文件 + RCS provider（原 `src/aesa/rcs.lua`；现拆为 `src/core/rcs.lua` 接口 + `src/adapters/dcs/rcs.lua`）（来源标注；提取启发式的已知限制：个别键名可能归属到分类名，如 JF-17 会被兜底覆盖——核心机型本就在加密 DB 中）

实现备注（与设计的偏差）：
- 实例方法用 `__index` 元表挂在模块表上（Lua 侧 `obj:method()` 可用；Python 测试侧显式传 self）。
- 适配器方法按 Lua 冒号约定多收一个 self 参数（helpers 已按此约定实现）。
- T9 断言细化为"账本 ≡ busy_until + 因果性"（驻留尾沿允许越过当前仿真时刻），理论笔记 §9 已同步。

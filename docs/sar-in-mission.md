# 在 DCS 任务中试验 SAR 小切片

- 状态：current（2026-10-18 复核）

这是任务内数据驱动、任务外计算与显示的开发原型。输入为飞机真实位置和地形高程，输出经过复数回波合成与反投影；地表散射并非 DCS 真实雷达回波。设计及假设见 [原型设计](design-sar-prototype.md)和 [物理可行性](sar-feasibility.md)。

## 安装与启动

需要 Node.js 和一个 Lua 5.1 可执行程序。命令在 `aesa/` 下执行。以下 DCS 安装路径仅为本机示例；脚本没有硬编码它。`--saved-games` 必须明确指定实际使用的配置目录。

```powershell
$env:AESA_LUA = '<DCS>/bin/luae.exe'
$sarSavedGames = Join-Path $env:USERPROFILE 'Saved Games/DCS'
node scripts/install_sar.cjs install --saved-games $sarSavedGames
node scripts/install_sar.cjs verify --saved-games $sarSavedGames
node tools/sar_live.cjs
```

打开 http://127.0.0.1:3593。接收端必须保持运行；Ctrl+C 关闭。独立使用 TCP 3592/HTTP 3593，不占既有空空显示器端口。端口冲突会退出并报告错误，不抢占进程。需要重新进入任务使 Export 加载；若仍未连接，退出并重启 DCS。保持现有任务和机型即可，不需要把探测脚本加到任务或修改 MissionScripting.lua。

推荐先用单机小任务、白天、无大幅机动的固定翼飞机，离地至少数百米，平飞 200–300 m/s，帧率尽量 ≥30。页面中选航迹左/右侧 45°、地距 10–30 km、确认当前地形 provider 可用后点击采集。128×128 m 场景固定于启动时的位置，17×17 高程逐帧查询完后开始 2 s 轨迹积累，继而生成 129×129 图像。低帧率会延长地形采集；暂停、断线或不完整轨迹会失败。采集超过 30 s 会取消，外部成像计算时间另计。

### 连续采集，减少手动操作

页面主要入口为“开始连续采集”；默认航迹右侧 45°、地距 20 km，无需地图坐标。按开始后，服务依次采集地形、积累约 2 s 轨迹、计算图像，完成后稍作间隔自动开始下一次。飞机平稳飞行即可，每次新切片中心随飞机位置/地面航迹变化；停止前不需要重复点击。运行中侧向、距离和处理窗固定，修改参数先停止再开始；刷新页面会显示当前运行参数。侧向可选“左右交替”，此时每次采集换一侧（右→左→右……），一次通过覆盖航迹两侧；默认仍是固定右侧，因为既有记录、文档和验收都以右侧 45° 为准，交替是显式选项而不是新的默认。

允许先开启后进入任务；没有 Export、地形接口不可用或任务暂停时等待，恢复后继续。连续采集中超过 3 s 没有新状态会丢弃未完成数据并取消该次采集，等待恢复；其他采集/计算错误间隔 2 s 重试。**连续模式永不自动停止**：失败只累加 `failures` 供状态显示并在 2 s 后重试，只有用户按“停止连续采集”或服务关闭才结束。几何不合适时服务**跳过这一次机会**而不是报错停机，并在状态行给出原因（如“暂不采集：当前斜视角 5°（正右/负左），等待进入 20–160° 侧视窗口”），跳过的次数记在 `skipped` 里；被跳过的切片不计算、不落盘、不计入失败。

门控判据（同一套判据先用于预测下一次机会，也用于评估刚采完的切片）：
- Export 在线、地形接口可用、状态新鲜（<3 s，缺一则等待而不是跳过）；
- 航迹质量：地面速度 20–400 m/s、垂速 ≤40 m/s（平飞）、后半段转弯率 ≤6°/s；
- 侧向孔径足够（复用 `apertureGeometry` 的 20 m 判据），接近前视/后视航迹时等待；
- 斜视角在 20–160° 窗口内（正右/负左），沿航迹前后 ±20° 内等待窗口。

服务只能在下一次采集完成后才知道真实几何，所以门控用的是**最近一次采集**的航迹与斜视角，并设 8 s 有效期（`gateWindowMs`）：过期后服务重新尝试，避免在几何持续不合适时永久等待，也避免把陈旧判断当成现状。新图完成前保留上一张及其时间/地图中心，不能把旧图当作当前地面。只允许一个采集或计算任务，不堆积待计算场景。

点击“停止连续采集”立即停止追加，并取消尚未完成的采集；已进入 worker 的计算允许完成，保留最后图像。停止后可对内存里的最近完整输入重算。刷新/关闭浏览器页面不会停止后台服务，用停止按钮或接收端 Ctrl+C 结束。连续模式不会在服务器重启后自行恢复，不在回放/演示模式启动。

连续模式默认不保存每次原始文件，避免文件持续增长；需要可回放记录时，在开始前勾选“保存每次原始采集”，仍只写到项目忽略目录。单次采集继续默认保存原始输入。停止后重算不增加采集计数或原始文件。

这只是重复的 128 m 小切片，不是无缝条带 SAR 或全地面扫描：采集/处理期间飞机移动可能远超过 128 m，切片之间存在未覆盖区域。无需精确对准即可试验采集流程，但不能保证切片包含某栋建筑；地物几何/材质缺口也不会因自动采集而补足。约 6 s 一张仅是先前 90 帧录制约 3.53 s 计算加 2 s 轨迹的量级，实际以页面完成时间为准，帧率和算力会改变间隔。

### 广域扫掠（mode:'sweep'）

连续采集的 `mode` 有两种：`relative`（默认，飞机侧向固定角度/地距的小切片）与 `sweep`（广域扫掠，把成像窗口内的固定世界方格依次铺开）。`mode` 与 `sweepSize`（瓦片边长，**512**（默认）或 2048 m，其它值拒绝）只在 `POST /continuous/start` 里给出，其余参数校验不变；`side` 在扫掠模式下只决定首次兜底采集的左右，`range` 被忽略（瓦片位置由格网决定）。几何不合适时跳过、采集/计算失败时计数重试，永不自动停止（语义与上一节相同）。

**固定世界格网**：瓦片是**固定的世界方格**，永不随飞机移动——格号 `tile=(floor(x/S), floor(z/S))`、中心 `((tx+0.5)·S, (tz+0.5)·S)`，S = `sweepSize`。服务不再生成"跟着飞机的环"，也没有"每前进 2 km 重排一圈"这类逻辑：飞机前进只是让成像窗口在同一张格网上滑动，同一片地面的格号、中心与足迹在整段任务里保持不变，两次经过同一区域的覆盖判据也不会漂移。

**机会式选择**：每次准备采集时**按预测位姿**重建候选列表——预测位姿 = 最新轨迹末端的本机位置沿速度矢量前推 `SWEEP_LEAD_S` = **10 s**（依据：2 s 轨迹 + 快速档约 1 s 计算 + 排队与桥接，实机 317 m/s 下即前推 3.2 km；失败复盘是"选中时地距 1.0–1.8 km、采集时只剩 0.6–0.9 km"，10 s 覆盖了这个滞后并留余量）。速度取整条轨迹的**平均地面速度**（单帧 1/60 s 差分会抖，而门控已把转弯限制在 6°/s 内）。枚举以预测位姿为中心 ±50 km 的格网包围盒，保留中心**对预测位姿**地距 ≥ **1.5 km**（不是 Export 的 1 km——0.5 km 余量 ≈ 317 m/s 下 1.6 s 的预测误差）、≤ 50 km、|相对航迹角| 30–60° 的瓦片，剔除已被拼接图覆盖的和仍在退避期内的，再排序：先按 5° 角度分档（30–35° 档最靠近机头，是飞机最先到达的区域），同档内先近后远；取前 20 条作为 `/state` 的 `continuous.sweepPlan`（格网是无界的，页面只看当前批），并采集其中第一条 `pending`。这条最小距离顺带缓解了脉冲预算：近格角展宽大、模拟脉冲数高，1.5 km 之外 512 m 格的张角小得多。窗口内候选全部处理完时状态行提示"当前窗口内 N 块候选均已处理（已覆盖 M 块、退避 K 块），随飞机前进自动换窗"。**没有速度信息时退回旧行为**：以最新位姿为锚、用 Export 的 1 km 下限（内部 `lead_s=0`）。参数依据：项目推荐斜视角 30–60°、Export 限制地距 1–50 km；Export 的 side/range 命令恒为 45° 侧视、无法表达角度网格，所以扫掠直接给世界坐标（`CAPTURE_WORLD` + 显式足迹），由 Export 从视线推导足迹并回报实际斜视角。128 m 档不用于扫掠：在 10–50 km 上只剩几个分辨单元。

**门控同步用预测位姿**：连续采集的几何门控（斜视角 20–160°、侧向孔径、速度/转弯/升降）与选格跑在**同一个预测位姿**上。相对模式重复同一侧向/地距的切片，所以用上一张的实测斜视角预测下一张；扫掠每张换一块方格，它的几何门控就是上面那张窗口本身——高速时上一张的视角在几秒内就失效，不能用它否决下一块。

**窗口重建**：批里记录生成时的**预测位姿** `sweepAnchor`（= 本机位置 + 前推 10 s，`/state` 里直接给出窗口被推到哪），批内每格的 `angleDeg`/`rangeM` 都是相对该锚点的值。当飞机跨过格边界（`floor(x/S)`/`floor(z/S)` 变化，即前进约一个瓦片边长）或采集计数（completed+skipped+failures）变化时重建，否则复用——`/state` 每 700 ms 轮询不会反复重算，页面看到的批是稳定的；实机节奏下每张图之后就重建一次。

**覆盖剔除**：mosaic 中存在 `size_m` **不小于**该瓦片、且其中心与该瓦片中心距离 ≤ 图像**半边对角线**（512 m → 362 m，2048 m → 1448 m）的图像即判定覆盖——这是"瓦片中心无论相对旋转如何都落在既有图像内"的最大偏移，于是 2048 m 概览图自动覆盖其内部的 512 m 小格，而 512 m 图永远不会覆盖 2048 m 大格。本窗口内被覆盖的候选数记在 `continuous.sweepPruned`。拼接层只保留最近 50 张（`mosaicLimit`）——这就是覆盖记忆的长度，被汰出的区域视为未覆盖、可以重拍。

**失败与退避**：被门控判为不适合的瓦片标 `skipped`；采集或计算失败的瓦片同样标 `skipped` 并进入 **60 s 退避**（`SWEEP_RETRY_MS`，最多记 128 条，超出淘汰最旧）。固定格网上这一步是必要的：否则只要引擎拒收某一块，服务会永远挑同一块。退避剔除数记在 `continuous.sweepDeferred`，状态行说明"该瓦片退避 60 s"；失败仍只累计 `failures`，2 s 后换下一块继续。

**模拟脉冲上限按内存推导**（`sar_pulses.cjs`）：每（距离 bin，脉冲）对是 re+im 两个 float64，即 16 B；可用预算是 `planScene` 硬校验的 512 MiB 回波历史中的 **7/8 = 448 MiB**（余下 1/8 给 DEM、散射体表、输出栅格与并行副本），于是每场景允许的脉冲数为 `pulseLimit = min(32768, floor(448 MiB / (bins × 16)))`，`bins` 是该场景自己的距离 bin 数（同一套"最远地形/散射体顶点 + 20 个分辨单元余量"规则）。**绝对上限 32768** 防小格退化：128 m 细节格只有约 1047 bin，否则会放行近 3 万个脉冲、几分钟的模拟算力。512 m 'area' 格约 1772 bin → 约 **16.5 k 脉冲**；2048 m '概览' 约 1868 bin → 约 15.7 k 脉冲。这个上限正是实飞暴露问题的修复点：317 m/s 的飞机在 860 m 处对 512 m 格产生约 7.5 kHz 的模拟 PRF，2 s 孔径约 15 k 脉冲——旧的固定 8192 会直接拒绝，而它其实只占 448 MiB 预算的 90%。超过推导上限仍然拒绝，且信息同时给出**实际需要与允许值**（"Scene needs N simulated pulses but the echo history budget (448 MiB over B range bins) allows L"），`planScene` 的 512 MiB 分配校验保留为兜底。遥测帧采样（`sceneModel:'uniform'` 的默认路径）不模拟脉冲，不受该上限约束。

**2048 m 与 PFA 的冲突**：`sar_pfa.cjs` 的 k 网格上限是 2048²，2048 m 瓦片必然超出，所以 `sweepSize:2048` + `focuser:'pfa'` 不拒绝请求，而是回退到反投影并在状态行注明"2048 m 瓦片超出 PFA 的 k 网格上限，已改用反投影"；`continuous.focuser`、图像元数据与拼接层条目记的都是实际使用的聚焦器。512 m 扫掠保留请求的聚焦器（PFA 在近距离大孔径下仍可能失败，按上面的失败语义处理）。

**首次兜底采集**：Export 的 STATUS 不含位置/航向，服务要等第一张图完成才有轨迹，所以扫掠的第一次采集仍是相对模式的 side/range 小切片（`CAPTURE,<id>,<side>,<range>,<size>,<n>`），它只用来学出本机位姿、不进入格网计划；之后的采集才用 `CAPTURE_WORLD,<id>,<x>,<z>,<size>,<n>` 直接点名瓦片（512 m → 'area' 足迹 33×33 / 4 m / 37.5 MHz，2048 m → 'airport' 概览 65×65 / 16 m / 10 MHz；快速档输出栅格减半）。`mode:'sweep'` 需要支持世界坐标采集的新版 Export：已连接但不支持时 `/continuous/start` 直接报 409 "Update SAR Export for larger captures"，既不启动也不偷偷采集。

`/state` 契约：`continuous.mode`（'relative'/'sweep'）、`sweepSize`、`sweepPlan`（当前窗口的候选批，仅扫掠模式，否则 null，最多 20 条）、`sweepIndex`（正在采集的那条在批中的下标）、`sweepAnchor`（生成批时的**预测位姿** `[x,z]`，即本机位置沿速度前推 10 s；无速度信息时就是本机位置）、`sweepPruned`（本窗口内因已覆盖剔除的块数）、`sweepDeferred`（因退避剔除的块数）。每条 `{center:[x,y,z], bearing, size_m, side, angleDeg, rangeM, status}`，`status ∈ 'pending'|'capturing'|'done'|'skipped'`；`center` 是固定格网中心（`y` 取最近一次切片中心高度，真值以采集结果为准），`bearing` 是锚点指向瓦片中心的绝对方位角，`angleDeg`/`rangeM` 是相对锚点航向与锚点位置的斜视角与地距，`side` 为 1/-1（右/左，取斜视角符号）。数组只在重建时换引用。

局限：批只覆盖当前窗口的前 20 块，格网本身是无界的；瓦片之间不保证无缝——规则格网不等于连续覆盖，飞机在两张图之间已经前进，覆盖只按中心距判断，不做几何或辐射配准，因而 2048 m 图可能剔掉"中心在图内、边缘未被覆盖"的小格（刻意的取舍：宁可少拍重复区，也不重飞已覆盖区）；拼接层不去重，重叠区亮度由后一张决定。覆盖记忆只有 50 张，超出即被视为未覆盖。按每张 2 s 轨迹 + 地表查询 + 计算（512 m 标准档本机约 7 s、快速档约 1 s）估算：标准档每分钟约 7 块、快速档约 20 块；形态是"沿航迹向前扫、每拍一块就把最新覆盖与退避剔除掉"，而不是绕飞机画一个完整圆环。需要更快覆盖时用 `quality:'fast'` 启动扫掠。

### 实波束地面测绘底图（`mode:'map'`）

这是 SAR 小块下面的**粗分辨率底图**，不是第三条聚焦路径：不做孔径合成，方位向分辨率就是天线波束，随斜距线性变宽。所以“看不清”是设计结果而不是缺陷——它给的是**本机前方 ±60°、半径 20 km（可调）的扇形**地表图，而且**正前方看得见**：实波束没有多普勒盲锥，这也是它和侧视 SAR 小块的形状差异所在。连续模式为 `mode:'map'`（`POST /continuous/start`），单拍为 `POST /map`；产物与 SAR 图同构（世界锚定栅格 + dB 矩阵），走既有 mosaic 通道，`metadata.mode='map'` 用于区分。

**渲染管线**（`tools/sar_map.cjs`，零依赖，纯栅格运算，不走逐脉冲合成）：

1. 反射系数 = 材质系数（复用 `sar_scattering.cjs` 的表）× 本地入射角余弦（由 DEM 法线得出）；
2. 遮蔽 = 从本机到格子的 DEM 射线行进（半格步长，只信已采集窗口内的地形）；叠掩 = 地距投影折叠：斜距→地距换算 `g = √(R²−H²)`（H 为本机对帧平均高程面的高度）把高于基准面的每个地形点映射到**比其真实沿视距离更近**的地距 bin，因此面向雷达的陡坡会把上部回波折到坡前的格子上。每格显示落在其地距 bin 内、可见（不被更早地形遮蔽）且 g 最靠近 bin 中心的回波源，斜距最近决胜；格子位置仍锚定真实世界坐标，折叠表现为**亮度源错位**而非几何位移（近似，见假设清单）。同一次步行顺带得出遮蔽（发现遮挡即可早退）；折叠搜索只延伸每格之外 `layover_margin_cells`（默认 4）格，更远的极端折叠不查；平地帧（高差不足以搬动半格）自动跳过；
3. 散斑 = 乘性、单视指数分布（`looks`>1 时为 Gamma 平均），按**世界格**确定性生成：同一块地面在相邻帧里是同一份纹理（服务端固定帧号 0），滚动拼接因此不闪烁、不留颗粒接缝。代价是放弃频率捷变去相关（真实雷达的散斑逐脉冲变化）的建模；巡逻默认 `looks=4`，250 m 显示格上单视只是颗粒而不是信息；
4. 方位展宽 = 与天线功率方向图（高斯主瓣，3 dB 全宽 = `beam`，默认 3°）沿视线横向卷积，核宽由每格自己的斜距决定：5 km 处小于 1 个 250 m 格，10 km 约 2 格，30 km 约 6 格；
5. 辐射度（`stc` / `peak_norm` 两个显示开关，不是辐射定标）：`stc:true`（默认）**完全补偿** 1/R⁴ 距离展布，画面即地面自身的反射系数，均匀地表在远近处读一样的亮度（这是 STC 的本意）；`stc:false` 是原始接收功率，保留 1/R⁴、以星下点斜距为参考。dB 用**固定基准**：0 dB = 最亮材质系数（land 1.0）法向入射、斑点均值，下限钳到 −40 dB；于是帧与帧、巡逻与 DBS 块、扇形与扇形之间色调可比，拼接接缝消失（`peak_norm:true` 可退回逐帧峰值归一，同时也会带回帧间明暗台阶）。本机高度 3 km、20 km 扇形的典型读数：land ≈ 0 dB（入射角余弦再往下带几 dB）、runway ≈ −12、road ≈ −9、shallow ≈ −11、water ≈ −18 dB。

**假设清单**（与项目其它部分同一纪律，均可关或可查）：

| 项 | 取值与来源 | 性质 |
|---|---|---|
| 波长 / 带宽 | 3 cm / 75 MHz（`sar_scattering.cjs`、`sar_surface.cjs` 同一假设） | 项目假设 |
| 波束方位宽度 | 3°（X 波段典型值），可用 `beam` 改 | 公开估计 |
| 材质系数 | `MATERIALS`：16 类地表 + 旧五类别名，全部相对"裸地法向入射 = 1（0 dB）"，逐条标项目假设（见下节） | 项目假设，非标定 σ⁰ |
| 入射依赖 | cos(入射角) | 项目假设（与既有散射模型一致） |
| 散斑 | 单视指数（可 `looks` 提高；巡逻默认 4 视），按世界格而非帧号生成 | 项目假设 |
| 遮蔽 | DEM + 类别抬升（DSM）射线行进（与叠掩同一次沿视步行得出） | 简化 |
| 地表抬升（DSM） | 建筑/施工地/城镇/树/林分别加 15/10/8/12/18 m（±40 % 世界稳定抖动），只作用于渲染 | 项目假设（F-15E 参照图定标） |
| 叠掩 | 斜距→地距折叠：每格显示其地距 bin 内 g 最近、可见、斜距最近的回波源；位置保持世界锚定，只折叠亮度源；搜索范围 = 每格外 4 格（`layover_margin_cells`），平地帧自动跳过 | 项目假设，可用 `layover:false` 关 |
| 展布 | 1/R⁴；`stc:true` 完全补偿、`stc:false` 保留 | 显示选择 |
| dB 基准 | 固定：0 dB = 最亮材质法向入射、斑点均值（`peak_norm:true` 退回逐帧峰值） | 显示选择 |
| DEM | `terrain.GetHeight`（Export 侧，同一 DCS 数据） | **DCS 数据** |
| 地表分类 | 优先引擎原生 16 类掩码（`aesa_agradar` 探针，Export 内 `package.loadlib` 加载）；探针不可用则退回 `terrain.GetSurfaceType` 五类 | **DCS 数据**（类名与掩码）/ 退回路径见下 |

**地表分类与反射系数**（本轮之前只有五类，跑道和建筑画不出来；现在按引擎自己的类掩码着色）：

- **来源**：DCS 引擎 CPU 侧保留 16 类地表掩码——Land、Runway、Sea、River、Lake、Road、Railway、Town、Field、Beach、Building、Construction、Trees、Forest、Traffic、ParticleEffect。它由原生探针 `aesa_agradar.dll` 暴露：该 DLL **没有 `luaopen_*` 入口**，直接导出 Lua C 函数 `aesa_agradar_surface_names(x,z)`（逗号分隔类名串，同一点可能是多类并集，例如跑道点实测 `Land,Runway,Road,Railway,Town,Field,Beach`）、`aesa_agradar_surface_mask(x,z)`，以及探针自己的 hook 管的 `init/poll/shutdown/version`。Export 每次连接**只解析一次**：先按 `<lfs.writedir()>\Scripts\AESA-AGR\aesa_agradar.dll` 找，再按 `%USERPROFILE%\Saved Games\DCS\Scripts\AESA-AGR\...` 与 `...\DCS.openbeta\Scripts\AESA-AGR\...` 找（lfs 没加载时的保险），最后才是 cpath 上 `require "aesa_agradar"` 的兜底；**不搜索 DCS 安装目录**（`bin/`、`bin-mt/`——探针只部署在 Saved Games，安装目录里的同名文件不是我们的）。对命中的路径分别 `package.loadlib(path,"aesa_agradar_surface_names")` 与 `(...,"aesa_agradar_surface_mask")`，两个都取到才算可用，存在 `aesa_agradar_init` 时再以空串调一次（幂等；DLL 侧查询函数本身惰性自初始化）。逐格调用 `surface_names`；探针不在、只导出一个函数、引擎未就绪或该点无掩码时，逐格退回 `terrain.GetSurfaceType` 的 `land/sea/water/road/runway`。/state 的 `map` 段在见到细词汇类名后带 `fineSurfaces:true`（旧 Export 运行时该字段缺省），页面据此区分"引擎原生 16 类"与"五类退回"。
- **协议**：`MAPSURFACE,<id>,<col>,<row>,<类串>`。类串用 `+` 连接（逗号是协议分隔符），例如 `Building+Land`；旧词汇（数字 1–5 或小写 `land/sea/water/road/runway/unknown`）照旧接受，新旧 Export 与新旧服务端任意组合都不炸：新服务端连上时发一次 `SURFACE_FINE` 要求细词汇，老 Export 静默忽略并继续回五类；老服务端从不发它，新 Export 就一直用五类。未知类名只把该格降为 `unknown`（新探针加类不许拖垮整张图），结构垃圾（多字段、空类、非法字符、>16 类）仍然是协议错误。
- **多类并集取一类**（`pickSurface`，雷达显著性顺序，不是土地利用统计）：`Building > Construction > Town > Runway > Road > Railway > Traffic > Trees > Forest > Field > Beach > Land > River > Lake > Sea > ParticleEffect`。理由：RBM 的职责是"看见设施"——先人造强散射体，再线性设施（跑道/道路即使镜面暗，也是操作员要找的目标），再车辆、植被、开阔地；水放最后，一格里的池塘不能把整格画成水。
- **系数**（`MATERIALS`，全部项目假设，dB 相对裸地法向入射）：building 8.0（+9.0，墙面-地面二面角回波，最亮地表）、construction 5.0（+7.0，框架/瓦砾，双回弹但不如整墙相干）、town 3.0（+4.8，建筑与街道在 250 m 格内平均）、forest 1.9（+2.8，冠层体散射）、trees 1.6（+2.0）、land 1.0（0，基准）、beach 0.8（−1.0，沙面光滑低介电）、field 0.75（−1.2，作物/耕地）、traffic 0.25（−6.0，少量金属车辆摊到一格）、road 0.12（−9.2，沥青镜面）、railway 0.10（−10，钢轨镜面、道砟主导）、runway 0.06（−12.2，混凝土/沥青）、particle_effect 0.05（−13，烟尘的弱体回波）、river 0.03（−15.2）、lake 0.02（−17.0）、sea 0.015（−18.2，X 波段平静海面）；旧类别名保留：`shallow_water 0.08`、`water 0.015`、`unknown 1`。逐条系数与理由写在 `sar_scattering.cjs` 的行注释里（AGENTS.md 数据政策：项目假设必须显式标注）。
- **SAR 小块路径不变**：`SURFACE`（SAR 切片逐点分类）仍是五类，`sar_scene.cjs` 的词汇表未扩展——本轮只改巡逻/DBS 的 `MAPSURFACE`。

**地表起伏层（DSM，按类别统计抬升）**：DCS 的高程是**裸地**，建筑与树冠不在 DEM 里，所以只靠 DEM 的遮蔽/叠掩永远看不见它们。`renderFrame` 现在按格的地表类别给**渲染用**的有效高度加一个统计抬升：**building 15 m、construction 10 m、town 8 m（城区密度平均）、trees 12 m、forest 18 m**，其余全部为 0；每个有抬升的格再乘一个 **±40 % 的确定性抖动**（与斑点同一套世界坐标哈希、独立 salt），天际线不平板且帧间/拼接不闪。抬升只存在于帧内高度数组（`height[]`），**绝不写回 `mapCache`/`dbsCache`**——格网里始终是裸 DEM。现有三台机器直接吃这个数组：`blocked()` 射线遮蔽、`layoverWalk()` 叠掩折叠、以及**重构后的 `incidence()`**（法线取帧内有效高度的中心差分，而非再向缓存取裸 DEM；朝雷达的墙面因此真的变亮，背向的变暗）。

- **为什么会看到"亮斑群 + 拖尾暗区"**（F-15E 实机参照图）：建筑材质本身 +9 dB（二面角）给出亮斑；墙面法线朝本机倾斜让掠射下的入射余弦进一步抬升（低掠角时相对变化很大，实测前缘 +11…13 dB）；背雷达侧地面落入阴影（阴影长度 = h·cot(掠射角)）。**能见度由掠射角决定，不是由簇的大小决定**：3 km 高、10–15 km 斜距时 15 m 抬升的阴影只有 50–100 m，亚格，单建筑看不见是对的；约 300–500 m 高、15 km 外（掠射 1–2°）时同一簇的阴影有 400–800 m，跨 2–4 格，才形成参照图里的拖尾暗区；DBS 的 25 m 格下 10 km 处约 50 m 阴影≈2 格，单建筑可见。不为巡逻尺度做任何夸张化。
- **谁被抬升**：整类生效（巡逻是 250 m 统计格，不是单栋几何）；抖动带来的高矮差会让"前排更高的屋顶遮住后排"——密集簇里出现明暗斑驳，这正是实机图的样子。metadata 的 `relief` 给出 `{enabled, table, jitter, cells, mean_m, max_m}`，`/state` 的 `map.lastFrame.relief` 透出本帧的统计，页面/日志因此能说明"阴影来自假设抬升，不是实测建筑高度"。
- **元数据与开关**：`model`/`limitation` 如实写明这一点（统计假设、单格阴影亚格、抬升不进格网）；引擎侧另有 `relief:false`（默认 true）用于对照渲染与诊断，巡逻/DBS 都用默认开启。

不建模：天线旁瓣、偏离波束中心的双程增益衰减、体散射、降水、极化、多径、任何脉压处理链。叠掩按上一节的折叠近似建模（亮度源错位、非几何位移），SAR 小块路径的遮挡/叠掩在 `sar_scattering.cjs`/`sar_surface.cjs` 另行建模。显示栅格 250 m 在约 5 km 以外细于方位分辨率，那是过采样而不是分辨能力；散斑按世界格生成、巡逻默认 4 视，`looks` 可换更平滑的底图但会进一步降低有效分辨率。整帧只用**一帧时刻的本机位置**做几何（遮蔽/叠掩/入射/波束宽度），采集期间本机移动带来的几何变化未建模；帧仍然是北向方格，但**扇形以外的格子是无数据**（`db` 为 `NaN`，量化后为 −128 哨兵），不是“测到很暗的地面”。

**采集与增量扇区**：Export 侧新增 `CAPTURE_MAP,<id>,<x0>,<z0>,<nCols>,<nRows>,<step>` 与 `CAPTURE_MAP_AT,<id>,<ox>,<oz>,<nCols>,<nRows>,<step>`（原点相对本机），格子位置为 `(x0+col*step, z0+row*step)`，Export 逐格回 `MAPHEIGHT`（含回显的格子坐标）、`MAPSURFACE`（若有地表分类）与约 4 Hz 的 `MAPPOSE`（本机位置/速度——Export 的 STATUS 不含位置），完成回 `MAPEND`。仍然每帧最多 17 格，因此默认扇形的 6698 格约 6.6 s 净采集，加上每个任务两帧左右的往返开销（默认参数下 107 个任务）实测约 10 s。服务端把地图存在**世界固定栅格**上（默认 250 m，上限 40 万格，超出丢最旧四分之一），所以：

- 扇形窗口**以本机为圆心、机头方向为轴向**：半宽 `azimuth`（默认 60°，15–75）、外半径 `range`（默认 20 km，5–30 km）；显示帧是北向对齐的方格，canonical 栅格为 `grid_layout='col_x_row_z'`（列沿 +x、行沿 +z；Gate 1 起 Export 发 `MAPGRID,<id>,col_x_row_z`，渲染/页面读同一标记），帧边长 = `2·ceil(range/cell)+1` 格（默认 161² / 40 km，其中 6698 格在扇形内，约 26%）；
- 每次只申请「落在扇形内且尚未采集」的格子（逐行合并成互不重叠的矩形，**扇形外的地面不会去问 Export**）；连续模式在飞机前进 ≥ **1 km** 或航向变化 ≥ **12°** 时按当前位姿重摆扇形（**填充中也生效**——转过 12° 后原来的扇形已经指向错的方向，继续填只是补看不见的地），已采集的世界格网保留、只补新进入的格子（默认参数下前进 1 km 只补约 548 格，8%）；
- 手动 `/map` 是**一次一个扇形，只出一帧**（采集过程中用 `/state.map.coverage` 看进度）；连续 `mode:'map'` 在采集过程中按扇形覆盖率增量出帧（≥6% 且距上一帧 ≥1.5 s），并随前进/转向重摆；旧的 `side`/`angle`/`span` 仍接受但被忽略——前向扇形没有侧向可选，也没有方窗边长；
- 无本机位姿时（未做任何采集）先发 2×2 格的定位任务；连续模式在“等飞机前进”期间定期刷新位姿（2 s 一次，4 格），否则服务看不到飞机已经移动。

**需要重新部署 Export**：MAP 依赖新增的 `CAPTURE_MAP` 命令，按既有流程执行 `node scripts/install_sar.cjs repair --saved-games <Saved Games 目录> --lua <Lua 5.1 可执行文件>` 并重新进入任务即可；`CAPS` 从 3 字段变成 `CAPS,2,<surface>,map`（旧服务端仍接受 3 字段），未升级的 Export 会被服务端以“需要新版 SAR Export”拒绝而不是静默退化成小切片。旧录制/回放不含地图格，回放模式也不提供 MAP（它需要实时地形）。**16 类细分类另需原生探针**：`aesa_agradar.dll` 由探针自己的安装脚本（`scripts/install_agradar_probe.cjs`）装进 **Saved Games** 的 `Scripts/AESA-AGR/`（不是 DCS 安装目录），Export 在服务端连上并发来 `SURFACE_FINE` 后按 `lfs.writedir()\Scripts\AESA-AGR\`、`%USERPROFILE%\Saved Games\DCS[.openbeta]\Scripts\AESA-AGR\` 的顺序找它，用 `package.loadlib` 直接取 `aesa_agradar_surface_names`/`_surface_mask` 两个导出函数（该 DLL 没有 `luaopen_*` 入口）；探针缺失、只导出一个函数或加载失败时逐格退回 `terrain.GetSurfaceType` 的五类，地图照常出图、只是没有建筑/跑道/城镇这些类别。

**接口**：`POST /map` 参数 `{range(5–30 km，默认 20)、azimuth(15–75°，默认 60)、cell(50–1000 m，默认 250)、beam(0.2–30°，默认 3)、looks(1–64，默认 4)、stc(默认 true)、shadow(默认 true)、dbs_factor(1–32，默认 8，巡逻底图的多普勒锐化倍数)}`；`cell` 或 `range` 改变会重建栅格（旧格子不再对齐），且 `2·ceil(range/cell)+1 ≤ 257`，超出时报错并说明改用更粗的格或更短的距离。连续模式用 `mode:'map'`，参数同上。`GET /state` 的 `map` 字段给出 `{active,continuous,note,frames,jobs,failures,cells,surfaces,coverage,window,lastFrame,progress,reason,supported,params,pose,track}`（见到细词汇类名后额外带 `fineSurfaces:true`；旧 Export 运行时该字段缺省），其中 `window={center,cells,ix0,iz0,sector:{heading_deg,azimuth_deg,range_m}}`（`center` 就是本机锚点位置），`params={range_m,azimuth_deg,cell_m,grid,beam_deg,looks,stc,shadow,dbs_factor}`，`lastFrame` 除 `seq/fraction/compute_ms` 外带 `sharpen={factor,patrol,effective,degraded,forward_cells}`（巡逻底图是 MAP 家族，锐化状态只能从这里与 note 读出来），`window.lastFrame.seq` 指向 mosaic 里最新的底图帧。底图帧在拼接条目里带 `mode:'map'`、`size_m=2·ceil(range/cell)·cell`（默认 40000）、`width=格数`、`bearing=0`、`sector`（该帧扇形的描述，−128 的含义所在）、`dbs`（锐化口径：`factor/patrol/effective/sharpen_*`）、`quality:'map'`、`focuser:'real-beam'`（拼接视图的读数行因此显示 `map · real-beam`，与 SAR 图区分），矩阵仍按 0.25 dB 量化、经 `GET /mosaic/<seq>` 取，且量化值与 dB 一起钳在 −127…+48：0 dB 是固定基准（最亮材质法向入射、斑点均值），其上留 +12 dB 余量，所以最亮的斑点/镜面回波不会被压平（页面灰度本身钳到白，悬停读数能读出正的 dB 值）。因此 **−128 就是“扇形外、没有看过”的哨兵**。**底图不占用 ②③ 栏与 `/snapshot`/`/reference`**：那些仍是 128 m 切片的语义。

**性能实测**（本机，默认扇形 161×161 / 40 km / 250 m，缓存已铺满整个方窗的最坏情况）：单帧渲染约 20 ms（含 25921 格扫描，其中 6698 格在扇形内参与几何与卷积；同样格数不含扇形参数的方窗约 60 ms，扇形只算该算的格子）；首扇形 6698 格、107 个采集任务，前进 1 km 重摆只补 548 格（8.2%）、2 km 补 1080 格（16%）；一帧矩阵 JSON 约 120 KB（每帧只取一次），`/state` 的 `map` 段落约 0.5 KB。渲染耗时与格数近似成正比，`cell` 加倍则格数减为四分之一。

**与 SAR 的关系与局限**：MAP 与 SAR 共用同一 mosaic，靠后完成的覆盖先完成的，因此 SAR 小块自然压在底图上；两者不做配准或辐射归一化，底图只保证“同一世界坐标”。底图的分辨率上限由波束与显示格共同决定，不能因为格细就当作识别能力；高程仍是 8 m 级插值、分类仍是粗类，建筑/植被散射未建模。改 `cell` 会清空栅格缓存，连续 MAP 请保持同一格距。拼接层上限 50 张（`mosaicLimit`），连续 MAP 出帧较快时会挤掉较早的 SAR 条目——需要保留 SAR 小块时提高上限或降低出帧频率。

### DBS 放大小块（`POST /dbs`）

RBM 底图与 128 m SAR 精看之间的**中间档**：点选一个点，服务端用 `CAPTURE_MAP` 在**独立的 25 m 细格**上采一小块（默认 512 m → 21×21 = 441 格，Export 17 格/帧 ≈ 0.5–1 s），再用**多普勒波束锐化**（DBS，DCS 里 F-16 那档 `DBS1/DBS2`）渲染。它整条链路都属 MAP 家族：采集走 MAP 协议、渲染走同一 `renderFrame`、产物走 mosaic 通道（条目 `mode:'dbs'`），不占 ②③ 栏与 `/snapshot`/`/reference`。

**锐化数学照抄官方实现**（`tools/sar_map.cjs` 的 `dopConeRad`/`dopSharpenFactor`，出处：DCS 雷达着色器 `Bazar/shaders/enlight/radar.fx` 的 `blurRadialDBS()`，**第 138–176 行**，调用点 **279–281 行**）：

- **锥角**：λ = 0.03 m（146 行），`teta_dopler = 2·acos(saturate(λ/(2V)·(2·dot(v,vXZ)/λ + omega/teta)) − 1e-7)`（148 行），其中 `vXZ` 是本机指向格子的地面单位矢量、`teta` 是波束宽度。括号展开后是 `dot(v,vXZ)/V + λ·omega/(2V·teta)`：前一项就是**地速与视线夹角的余弦**，后一项是 ED 的**扫描项**（圆锥扫描会把波束扫过地面、加宽视在锥角）。本项目的底图没有扫描，`omega = 0`（公式形状保留在代码里，便于逐行对照）；`saturate()` 顺带把后半视方向折到锥角 ≤ 90°。
- **核宽**：抽头落在波束弧上（间隔 `teta/K`），权重是 `sin(x)/x`，`x = k·teta_dopler/K·resolution·0.5`（158–165 行）。它的第一个零点在 `k/K = 2π/(teta_dopler·resolution)`，即锐化倍数 = `teta_dopler·resolution/π`，**随锥角线性增长**。`resolution` 是引擎的 uniform（279–281 行传 `params.y`，即"波束被切成几个分辨单元"）；本项目按与显示层冻结的约定钉住它：**45° 斜视（锥角 π/2）达到全额 factor**，于是 `resolution = 2·factor`。
- **每格一个倍数**：`S = clamp(teta_dopler·2·factor/π, 1, factor)` —— 正前方 → 1（**退化为实波束，不挖空**），45–90° → factor，中间线性连续；视线逐格不同（着色器也是逐 fragment），所以 S 逐格算，与格的锥角范围一起写进 metadata。
- **与 ED 的两处有意偏差**（都写进 metadata/limit）：①164–165 行的权重是 sinc（`sin(x)/x`，即多普勒滤波器的响应，带旁瓣），本项目保留自己的高斯核，只取"收窄律 + 锥角几何"（与实波束路径"不建模旁瓣"同一简化）；②173 行的 `step(dot(vel,vXZ), cosBlankAngle)` 会把盲锥内的格子整块涂黑——在"指定一小块"的场景里那等于整块空白，所以改为**退化**：锥角太小的格保留实波束，`metadata.dbs` 报告 `effective ∈ sharpened|partly-sharpened|real-beam`、`forward_cells`、`sharpen_min/max/mean` 与锥角/视线角范围，页面对近前视给出提示而不是禁用按钮。
- **无速度即无梯度**：本机地速未知或为 0（回放、无轨迹、静止）时整块退化为实波束，`metadata.dbs.degraded='no_velocity'` 并给出中文说明；不编造锐化方向。

**接口**：`POST /dbs {x, z, span_m?, sharpen?}`（`x`/`z` 是世界坐标，与 `worldX`/`worldZ` 同义）。`span_m` 256–1024（默认 512，格数 = `2·round(span/50)+1`，故 512 → 21×21、256 → 11×11、1024 → 41×41），`sharpen` 取 **8**（DBS1，默认）或 **32**（DBS2）。**请求写错 → 400**（点、块大小、档位都在碰 Export 之前校验）；**状态不允许 → 409**：无本机位姿（与 `/designate/check` 同一套 `designatePose()`）、地距不在 1–50 km、SAR 成像占用中、DBS 已在进行。**DBS 没有侧视窗**：正前方照常可用（只是退化为实波束画质），斜视角只影响锐化质量、不拒绝请求。202 返回 `{dbs,x,z,span_m,cell_m,grid,sharpen,velocity}`。

**巡逻底图也用同一套锐化**（真机的 MAP 档本来就是多普勒锐化图）：连续底图每帧以 `dbs:{factor:cfg.dbs_factor, patrol:true}` 渲染，`dbs_factor` 默认 8（1–32 可调，1 即纯实波束）。对外的产品身份不变——`mode/quality` 仍是 `'map'`、`focuser` 仍是 `'real-beam'`（页面靠这些值认底图），但 `metadata.dbs` 全套照填：`patrol:true`、`factor`、`effective ∈ sharpened|partly-sharpened|real-beam`、`forward_cells`、`sharpen_min/max/mean`、锥角/视线角范围。物理上它必然常落在 `partly-sharpened`：巡逻扇形正对机头，近前视那一片没有多普勒梯度（保留实波束），越靠扇角越锐；而且 250 m 显示格在 ~8 km 以内本来就比 3° 波束宽（8 km 处 σ≈178 m），所以锐化主要是**远场跨距涂抹**的改善，不是给近场假装超分辨。`metadata.model/limitation` 有第三套文案如实说明这点；`GET /state` 的 `map.lastFrame.sharpen={factor,patrol,effective,degraded,forward_cells}` 与 `map.note`（帧注记与"等待换摆"注记都带 `·多普勒锐化 F:1` / `·前视退化实波束 N 格` / `·无地速退化实波束`）给出同一状态；mosaic 的底图条目也带 `dbs` 口径，页面能把"这一块到底有没有锐化"读出来。

**抢占顺序 SAR > DBS > 巡逻**：DBS 抢占在飞的**巡逻**格任务（发 `CANCEL`，巡逻的世界固定格网与已出帧不受损，采完后自动恢复）；手动 `/map` 单拍不给 DBS 让路（409 `等待上一次地图采集结束`——它是一次性的正式成像，不是可随时重摆的巡逻）；DBS 在飞时新的 SAR/DBS 请求 409（方块只 1–2 s，"等"比"打断重来"划算），此时 `canCapture` 与 `canDbs` 同时为假；relative/sweep 连续模式不给 DBS 让路（维持原有 409）。SAR 指定仍然抢占一切 MAP 家族在飞任务（含 DBS）。

`GET /state` 新增 **`canDbs`**（顶层，与 `canCapture` 同风格：`terrainReady` 且无 SAR job/enriching/collector.job，且无 DBS 在飞；**巡逻的 map 任务不阻断**——会被抢占）与 **`dbs`** 段 `{active,note,lastFrame,frames,jobs,failures,point,span_m,cell_m,grid,sharpen,sharpens,span_limits,degraded_near_forward_deg,progress,reason,supported,canDbs}`；`lastFrame={seq,completed,point,span_m,cell_m,grid,sharpen,reused,effective,compute_ms}`。拼接条目带 `mode:'dbs'`、`size_m=(格数-1)·25`、`width=格数`、`quality:'dbs'`、`focuser:'doppler'`、`dbs:{factor,...}`（页面据此显示 `dbs · N:1`）、`sector:null`，矩阵仍按 0.25 dB 量化、经 `GET /mosaic/<seq>` 取。

**25 m 格网是世界固定的、跨点选保留、与巡逻缓存互不污染**：DBS 的格不进 `state.map.cells`（巡逻覆盖率不会被 DBS 污染），同一块再点一次直接**复用已采集格**渲染（`lastFrame.reused=true`，不再问 Export）；DBS 不重试：任务失败/超时即结束会话并给出原因，等下一次点选。整块渲染用**指定时刻的位姿与地速**（`MAPPOSE` 或 SAR 轨迹的平均地速），不用回放或猜想。

### 雷达监视工作流（MAP 巡逻 + 指定 SAR）

页面顶部全宽「雷达主视图（实波束地图 + GMTI + SAR 贴片）」是默认工作画面：实波束底图帧、SAR 贴片、GMTI 动目标符号、本机符号与航迹都贴在这张世界坐标图上。「开始雷达监视」一键启动 `mode:'map'` 连续巡逻（扇形随本机前进/转向重摆；页面不发送扇形参数时用服务端默认：半径 20 km、半宽 ±60°）；原连续模式下拉、录制开关等高级控件收进折叠区。

**指定精看**：在主视图（或地表/SAR 图）上单击选取任意点（拖动仍是平移），信息行给出世界坐标、经纬度（有锚点图像可换算时）与相对本机的地距/方位；服务端 `GET /designate/check?x=<worldX>&z=<worldZ>` 是 SAR 可成像性的唯一权威——地距 1–50 km 且 |相对航迹角| 在 20–160° 侧视窗内（正=右，与 Export `relative` 同一符号约定）才可成像；违反时「SAR 精看 128 m」「SAR 区域 512 m」按钮禁用并逐条列出原因（F-15E 拒绝大 X 的等价物）；`flightIssue` 飞行劝告（速度/垂速/转弯率/孔径）显示但不阻断。两个按钮分别发 `/capture {worldX,worldZ,footprint:'detail'|'area',quality:'fine'}`。**巡逻期间指定可用**：SAR 指定抢占正在飞的 MAP 采集任务（先发 CANCEL，已采集格保留），SAR 完成后巡逻自动恢复；`/state` 的 `canCapture` 在巡逻且 SAR 空闲时为 true。relative/sweep 连续模式下手动采集与 `/reprocess`、`/map` 仍被拒绝（409），先停止再操作。位姿来源：优先 MAP 巡逻自己的位姿（`MAPPOSE` 序列），尚无 SAR 轨迹时也能判定；两者都没有时端点 409。

### GMTI 动目标叠加（场景桥拉取）

真实 SAR 显示默认叠加 GMTI 动目标符号（F-15E 用闪烁矩形，JSTARS/Lynx 再加速度矢量）。这里提供同一层语义：任务里的地面动目标位置与速度矢量由 mission 采样器读出，服务端过滤成"雷达能看到什么"，`GET /state` 给出 `movers:[{x,z,speed,headingDeg,ageS}]`（`x`/`z` 为 DCS 世界坐标，`speed` 为地速 m/s，`headingDeg` 取与 `ownship.heading_deg` 相同的 `atan2(vx,vz)` 约定，`ageS` 为该批数据的年龄），前端按符号叠加；**桥不可用或拿不到时 `movers:null`**，原因写在 `moversNote` 里，绝不拿旧列表冒充实时。

**多普勒盲区（MDV）**：GMTI 的杂波抑制（STAP/DPCA）消掉的是**平台**的多普勒，留下的是目标**自身**沿视线的径向速度，所以判据取下式而不是"接近速度"：

```
u  = 本机位置 → 目标位置 的单位向量（水平面）
radial = v目标 · u            // 杂波抑制后仍留在多普勒域的分量
|radial| < MOVER_MDV_MPS ⇒ 落入盲区，不报告
```

于是静止的车辆、以及与视线垂直横穿波束的目标都不出现——这正是真实 GMTI 的盲区形态；若改成"相对本机的接近速度"，飞机飞过停着的车队会把它们全部报成动目标，与实机完全相反。`MOVER_MDV_MPS` 取 **2 m/s**（RQ-4/GH 级 GMTI 的 4 kt ≈ 2.06 m/s，项目假设，可用 `createService({moverMdvMps})` 覆盖）。目标自身的速度门限另有 1 m/s（mission 侧粗筛，与场景采样器"运动对象"的判据一致）。

**数据链**：服务端在 live 模式每 **2 s**（`MOVER_POLL_MS`）用本机位置（`ownship` 轨迹末端，尚无轨迹时跳过并说明）经**同一个场景桥**发一条独立查询：

```
MOVER,<id>,<cx>,<cz>,<radius>                                  → 服务端 → mission
MOVER,<id>,<index>,<kind>,x,y,z,vx,vy,vz                       ← mission → 服务端（每个地面动目标）
MOVER_END,<id>,<count>,<visited>,<skipped>,<provider>          ← mission → 服务端
MOVER_CANCEL                                                   → 服务端 → mission（超时放弃）
```

`kind ∈ unit|static`，剔除空中对象（`inAir`，空中目标是雷达的另一张图）；半径上限 50 km。mission 侧把工作量三重封顶：50 km 搜索盒、最多 64 个动目标、最多 128 个对象被检视，另有 0.1 s 模型时间预算（`timer.getTime` 可用时），并按 **16 行/帧**节流返回（与场景栅格的 17 行/帧同一套模式）。MOVER 与 SCENE 是采样器里的两个独立作业：MOVER 查询不会打断进行中的栅格采集，反之亦然。`CAP` 行的 movers 能力插在 provider 之前（线上为 `CAP,<surface>,<objects>,<movers>,<provider>`）：只带 4 个字段的旧钩子照常工作，只是 movers 报 `unavailable`。

桥侧另有 **3 s 墙钟超时**：mission 卡住时服务不会排队等待，超时即 `MOVER_CANCEL` 并按降级处理。降级分支都写进 `moversNote`：场景桥未连接、mission 采样器不支持动目标查询（未重新部署钩子）、动目标查询失败（超时/协议错误，带原因）、本机尚无轨迹。桥一断开，`movers` 在下一次 100 ms 服务节拍内清空。

局限：这是 **DCS 真值的符号层**，不是雷达检测——没有检测概率、RCS 或航迹形成，也不做航迹历史与关联（每批是独立快照）；目标来自任务对象数据库，因此只有 mission 里真实存在的 unit/static 会出现，未激活或已被摧毁的目标不会出现，采样半径之外的目标也不在视野里。

### 地理锚定拼接（余辉）

服务保留最近 50 张（常量 `MOSAIC_LIMIT`，可用 `createService({mosaicLimit})` 覆盖）已完成图像，每张带世界锚点与来源信息，供页面把它们按坐标钉在一起显示；超出上限丢弃最旧的一张，只存在内存里，服务重启不保留。每张摘要含：`seq`（本次运行内递增）、`completed`、`center`（世界 x/y/z）、`bearing`、`size_m`、`width`、`source`、`record`（若落了原始文件）、`target`（经纬度/地距/相对航迹角，若有）、`quality`、`focuser`、`scene_model`、`image_step_m`、`compute_ms`；数据本体另取。带 `scene` 的 `--restore-display` 快照会作为第一张加入（没有世界锚点的快照不加入）。

接口契约（`/state` 每 700 ms 轮询一次，因此列表与图像分开传）：

- `GET /state` 的 `mosaic`：`{generation, limit, count, dropped, firstSeq, latestSeq, dB_step, incremental, entries[]}`，`entries` 是摘要、**不含矩阵**；不传 `since` 时返回全部保留项（上限 50 条约 1 KB，只在页面加载时发生）。
- `GET /state?since=<seq>`：只返回 `seq > since` 的摘要，稳定状态下每次轮询只有 0–1 条；`firstSeq` 用于让页面丢弃已被淘汰的本地副本。服务重启后 `seq` 从 1 重新开始，`generation` 随之变化，页面据此清空本地缓存重取。服务端实测：稳态每次轮询 mosaic 部分约 1 KB，而单张矩阵约 60 KB，因此矩阵不进轮询。
- `GET /mosaic/<seq>`：返回 `{...摘要, db:[整数]}`，`db` 是按 0.25 dB 量化后的 dB 值（除以 4 得 dB，范围 −40…0 → −160…0），长度 `width²`；拼接是显示层，逐像素分析仍用 `/snapshot` 的完整矩阵。已被淘汰或未知的 `seq` 返回 404。
- `ownship`：`{pos, t, age_s, heading_deg, speed_mps, track[]}`，取自最近一次完成采集的轨迹（Export 的 STATUS 里没有本机位置/航向），`track` 抽稀到 ≤32 个点。`age_s` 是距该次采集的时间。

页面在此基础上新增一个跨栏大视图：以世界 x/z 平面为画布，把每张保留图像按 `center`/`bearing`/`size_m` 旋转缩放贴入，后完成的覆盖先完成的，可选旧图随时间淡出，并叠加本机位置/航向符号与航迹。这是显示层的拼接，不做辐射或几何配准，也不做去重；重叠区的亮度由后一张决定。

本更新只修改外部服务/页面，已有 SAR Export 不需要重装或重启任务。接收端升级时需要重启 Node 进程；已有 Export 会自动重连。

### 精细档与显示对比度

页面“成像档”提供标准 75 MHz/129²/1 m 间隔、精细 150 MHz/257²/0.5 m 间隔，以及快速测试档（出图优先）：输出像素减半（129→65、257→129）、散射单元加倍（1→2 m、4→8 m、16→32 m）、脉冲过采样 2.5→1.5，带宽不变并使用当前足迹的带宽，均保留 Hann/矩形窗。快速档的降低过采样可能混叠，实际参数写在图像元数据并显示在页面说明行，只用于缩短测试时间，不参与分辨率对照。这是重新合成假设波形和聚焦，不是从 DCS 取得更宽的实际雷达回波；更细输出不增加原始 8 m 地形细节。选择档位后单次采集/重算，或停止并按新档位重启连续模式。窗口、档位随新原始输入记录保存；连续状态刷新后恢复选择，保留旧图时不把旧图参数覆盖到正在运行的新档位。

显示范围 20/30/40 dB 可即时调整，只改变同一功率矩阵的灰度，不查询 DCS、不重算或修改图像数据。默认 30 dB，比原 40 dB 更突出亮暗差异；暗部也会更多被截黑，不代表物理精度提高。

### 并行成像

成像由 worker 线程池完成：回波合成按脉冲分块、反投影按像素行分块，任务分配不改变任何求和顺序，结果与单线程逐位一致；估算工作量低于约 0.8 s 的小图仍用单 worker。页面参数、分辨率、档位与之前完全相同，只是等待时间变短（本机 512 m 标准档约 55 s → 8 s 级，128 m 标准档约 12 s → 2 s 级）。计算期间 `/state` 的 `imaging` 字段给出 `{mode,workers}`。并行只影响耗时。PFA 聚焦段只在单个 worker 上做一次二维 FFT，不参与分块。

### 聚焦器

页面“聚焦器”提供两条路径：反投影（默认）逐像素使用精确三维距离，任意地形都按真实位置成像；PFA 走频域（逐脉冲距离 FFT → 极坐标重采样 → 二维逆 FFT），实测聚焦段快 8–11 倍（512 m 标准档 129 ms 对 1082 ms，128 m 标准档 22 ms 对 248 ms），但整幅时间仍由回波合成支配，因此端到端几乎相同（512 m 标准档实测 6.19 s 对 6.19 s，聚焦段的差别被合成掩盖；128 m 档合成约 14.6 s、反投影聚焦 248 ms、PFA 22 ms）。PFA 按平面波近似成像：地形起伏被当作中心高度的平地（低仰角时按约 h/tan(仰角) 在距离方向位移，2° 仰角下 2 m 起伏约 48 m），所以低仰角大切片会出现局部错位与不同的散斑实现；小切片上点目标位置误差 <0.2 m、主瓣宽度与旁瓣电平与反投影基本一致（对比数据见 [可行性文档](sar-feasibility.md) 与 `node scripts/sar_pfa_probe.cjs`）。所用聚焦器写入图像元数据 `focuser`，连续模式同样保存并恢复；命令行可用 `--focuser backprojection|pfa` 覆盖。PFA 超出适用范围时（需要超过 2048² 的 k 网格）会直接报错而不是给出可疑图像。

“多视降斑”开关与“视数”（1×1/2×2/3×3，默认 2×2）只作用于已显示的线性功率矩阵：按视数分块做功率均值（非相干叠加）后再转 dB 灰度，即时重画当前帧，不查询 DCS、不重算回波、不改变聚焦结果。输出按块数取整（129² 在 2×2 下为 65² 块），边缘不足一整块的末行/末列按实际可用像素平均；分辨率随视数下降，块均值压低散斑对比度但不是分辨率提升，也不能补出缺失的地物几何。灰度仍按当前显示矩阵自身峰值归一化，因此不同视数的绝对亮度不直接可比。结果缺少线性功率时回退为单视并在页面说明。

精细档的理想平地单点验证：Hann 地距 FWHM 2.919→1.466 m，横向约 1.225 m 不变，孔径仍为 2 s。这是特定几何的点响应，不是实际建筑的识别尺度；更长孔径、更密真实地形查询及对象数据需要另一步实现。见 [精细档检查](sar-surface-quality.md)。命令行可使用 `--quality fine`，明确指定时覆盖录制里的标准波形/输出参数。

`GET /scene` 只读返回接收端内存中的最近完整原始输入，供独立检查/备份；没有完整输入时返回 409。`GET /snapshot` 原子返回已显示图像及其对应原始输入，保存后可用 `--restore-display snapshot.json` 恢复图像、高程、轨迹及原完成时间。只包含 `/state` 图像的旧快照仍显示“历史图像、原始输入未恢复”，不能重算或重建地形。详见[地图对照与接口](dcs-map-terrain-interfaces.md)。

### F10 / 高程 / SAR 并排对照

页面上方是全宽「雷达主视图」（见“雷达监视工作流”节），其下提供三栏。点击“选择 DCS 窗口”，在 Edge/Chrome 共享弹窗选择游戏窗口，进入 F10 卫星视图后左栏显示真实窗口画面；当前未实现 F10 离屏图像接口，退出 F10 就会显示座舱。共享不采集音频、不录制或上传视频，点击停止或关闭页面结束。

中栏高程与右栏 SAR 来自同一已完成采集，同为 128×128 m，方向为视线横向/地距；鼠标十字线联动显示海拔、回波强度和世界坐标。高程仍为 8 m 输入，显示插值不会增加精度。复制左栏扫描中心，在 F10 对照该位置。左栏窗口未自动定位或配准，不能把任意地图画面直接当作同一切片。连续采集中，新图完成前高程也保留上一张；断线后保留历史时间。

### 把切片对准地图上的建筑

1. F10 地图放大到建筑，鼠标指向建筑中心，读取经纬度；若显示 MGRS，切换坐标格式（默认键位 Left Alt + Y，可在游戏控制设置确认）。保留小数秒或等效精度，避免 128 m 切片偏离目标。
2. 页面分别填写纬度、经度，支持十进制度 `41.5` / `42.25`、度和十进制分 `N41 30.0` / `E042 15.0`、度分秒 `N41 30 00.00` / `E042 15 00.00`。这些只是格式示例，必须用当前任务目标坐标。南纬/西经用 S/W 或负的十进制度；MGRS 不支持。
3. 建议目标在航迹左/右前方约 30–60°，地距 10–30 km；保持平飞后按“按坐标采集 128 m 切片”。地距 1–50 km 之外会拒绝。近航迹前/后方的目标侧向孔径较差，应调整航迹；当前原型未模拟具体 AESA 的转向限制。
4. 页面出现“本次已确认中心”后核对经纬度、启动地距、相对地面航迹角。正角为右侧，负角为左侧。目标位置在命令执行时固定，随后飞机移动不改变地面选区。确认信息和请求坐标随原始采集保存，回放可查看。旧录制没有经纬度时显示未确认，不猜测地图位置。

经纬度转换采用 DCS 自带 `Scripts/Export.lua` 列出的 `LoGeoCoordinatesToLoCoordinates(longitude,latitude)`，两个参数顺序与页面字段顺序不同。相对航迹模式在可用时调用 `LoLoCoordinatesToGeoCoordinates(x,z)` 返回中心经纬度（兼容官方控制 API 清单里的另一名称 `LoCoordinatesToGeoCoordinates`）；没有反转换函数时不伪造中心坐标。坐标按钮需要新 Export 状态确认接口可用；升级插件后重新进入任务。

**对准建筑只解决选区，当前仍未读取建筑几何。** `terrain.GetHeight` 提供地面高程，当前模型没有屋顶、墙面、材质或建筑遮挡/多次反射；因此对准后仍不能期待出现建筑轮廓。任务世界的建筑存在，不意味着已被送入 SAR 回波合成。任务脚本的 `world.searchObjects(Object.Category.SCENERY, ...)` 可检索地景对象，`Object:getDesc().box` 是碰撞包围盒，不能当作完整网格/电磁散射模型；可用性与覆盖需另行实测。2026-10-01 在官方安装文件 `Scripts/Export.lua` 确认 `LoGetHeightWithObjects()` 为零参数的本机离含物体表面高度，不是任意扫描位置的屋顶查询，不用于替代地形采集。

接口与坐标操作参考：[ED 任务单例 API](https://www.digitalcombatsimulator.com/en/support/faq/1257/)、[ED Object API](https://www.digitalcombatsimulator.com/en/support/faq/1259/)、[ED 坐标格式键位确认](https://forum.dcs.world/topic/296605-left-alty-does-not-change-coordinate-types-in-f10-map/)。这些文档不保证 Export 环境具备 mission 的对象 API；本轮未添加跨上下文桥接。

页面显示接口探测、采集进度、图像完成时间、来源、轨迹帧数、最大时间间隔、有效横向孔径、估算的理想分辨尺度及计算耗时。源为 `dcs` 才表示 DCS 采集，`synthetic-demo` 只表示演示。完成时间是电脑时间；轨迹 `t` 是 DCS 模型时间。飞机没有足够侧向孔径或低于场景最高地形 +50 m 会拒绝成像。起伏地形与建筑的遮挡已按切片几何建模（默认对每个散射点做一次视线判定，被挡的点不进回波；开关与统计见[表面散射与质量检查](sar-surface-quality.md)），叠掩由精确三维斜距合成自然给出——高于 DEM 的立面/屋顶回波落在地距更近的格上；但切片外地形的遮挡未知，因此这条高度检查仍不能证明场景全部可见。

## 地形接口验证

页面对比：

- `terrain_under_ownship`：`terrain.GetHeight(x,z)`，当前自动采用的几何 provider。
- `LoGetAltitude_under_ownship`：仅诊断，不自动采用。
- `ASL_minus_AGL`：本机世界高度减雷达离地高度，作为机下参考；有偏差时检查地形、建筑、水面及高度定义。

这些数值一致只是机下检查，不能证明另一 API 在任意坐标都正确。`unavailable` 表示 Export 中 terrain 接口不可用，按钮会禁用；本轮不会自动启用 unsafe API、`net.dostring_in` 或用平地替代。需保留实际探测/错误信息，再决定 mission/GUI 桥接方案。DCS 日志中的 `AESA-SAR` 条目可辅助排查连接和 Lua 加载问题。某些服务器限制 Export/自身状态；先在单机确认。

## 图像与数据的含义

图像由世界地面单元内固定随机分布的表面散射样本的复数距离压缩回波聚焦生成；默认约 16,384 点，取代首版的 289 个高程顶点。相位稳定且使用实际三维轨迹；地形高程经双线性插值作为成像表面。波长 3 cm、75 MHz 带宽、固定随机散射相位和坡面入射强度均为假设。不是原始 ADC/匹配滤波仿真；不包含材质、建筑、植被、车辆散射中心、距离损耗、天线图、噪声、地形遮挡、模糊或极化。幅度只做本次峰值归一化，跨图亮度不具有定量可比性。

地形点间距仍为 8 m、默认散射单元和图像像素间距为 1 m；插值不增加真实地形细节。旁瓣与散斑可能由采样/假设产生，不能当作真实车辆或建筑。默认 Hann 窗减小旁瓣但展宽主瓣；页面可切换矩形窗并“用当前数据重算”，不需要新采集、不写新记录。模型与点响应实测见 [表面散射与质量检查](sar-surface-quality.md)。生成与聚焦共用同一轨迹，不能证明 DCS 位置/时间达到了真实 SAR 导航精度。轨迹采样不是实际发射 PRF，也不能证明整个波束无多普勒/距离模糊。

单次采集以及勾选连续录制时，完整接收的原始输入自动保存在忽略目录 `recordings/sar/sar-*.json`，含全部高程和实际轨迹，即使后续成像失败也可检查/重算；未勾选录制的连续模式只保留最近输入在内存中：

```powershell
# 先退出占用相同端口的接收端，再回放；不会写入新采集文件。
node tools/sar_live.cjs --replay 'recordings/sar/<实际文件名>.json'
# 单独验证外部计算与页面，明确显示合成数据：
node tools/sar_live.cjs --demo
```

第一张成功实飞图像的验收：来源 `dcs`；289 个高程点完整且不是替代值；实际轨迹连续覆盖约 2 s、≥16 帧、任意间隔 ≤0.25 s；输出非空有限功率矩阵；原始文件可离线重算；页面记录采集/完成时间和假设。随后应比较平地/山坡、左右斜视及不同孔径，增加独立算法/公开数据对照。自动端到端测试使用假的 Export 发送端，不能代替这项实飞验收。

2026-10-01 本机任务验证已完成两次采集：分别 87 帧/2.000 s、90 帧/2.004 s。后一次 289 点地形高度范围 134.486–138.665 m，最大轨迹间隔 0.025 s，有效横向孔径约 450.54 m；首版合成 + 聚焦约 201 ms，相同模型与输入重算功率矩阵最大差为 0。`terrain.GetHeight` 已在本机 Export 中可用，机下与 LoGetAltitude、ASL−AGL 接近（这仍不证明其他环境/任意坐标的 LoGetAltitude 语义）。后续 surface-v2 重算约 3.53 s，网格伪影诊断显著改善；仍只证明采集/成像流程，不证明地物识别或真实雷达性能。原始实飞文件留在本机忽略目录，不入库。

## 修复与卸载

```powershell
node scripts/install_sar.cjs repair --saved-games $sarSavedGames
node scripts/install_sar.cjs uninstall --saved-games $sarSavedGames
```

只管理 `AESA SAR BEGIN/END` 块、`Scripts/AESA-SAR/aesa_sar_export.lua` 和独立 manifest。已有 Export 先备份；manifest 包含源文件、版本哈希及管理文件清单。未知/修改后的同名插件文件拒绝覆盖或删除。原始和各版 `.bak-aesa*` 备份留存，不批量清理；其他插件后来追加的 Export 内容保留。卸载后需要重新进入任务使插件停止加载。

## 开发验证

```powershell
$env:AESA_LUA = '<DCS>/bin/luae.exe'
node --test tests/test_install_sar.cjs tests/test_sar_live.cjs tests/test_sar_surface.cjs tests/test_sar_viewer.cjs tests/test_sar_principle.cjs tests/test_viewer_vectors.cjs
```

设置 `AESA_LUA` 才会执行实际 Lua 5.1 与完整部署测试；缺少时测试会显式跳过这些项目。当前尚未接入 AESA 调度器或座舱页面，不生成发布包。

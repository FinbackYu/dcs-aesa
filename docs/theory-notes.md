# AESA 仿真核心理论笔记（阶段一依据）

- 状态：current（2026-10-18 复核）

更新：2026-09-30。模型公式、适用条件和回归断言以本文为准；历史实飞记录不等同于当前版本验证。
原则：目标侧数据锚定 DCS 官方（RCS 等）；雷达自身参数属公开估计（显式标注）；本笔记使每个自建假设可审计。

## 0. 符号与约定

- 单基地脉冲多普勒雷达，X 波段 λ = 0.03 m（10 GHz）。
- 距离 R（m）、径向接近速度 vr（m/s，正值接近）、扫描角 θ（相对天线法线）。
- 时间：仿真秒，核心由调用方 `step(dt)` 驱动，不用墙钟。
- 坐标：位置直接保留 DCS 世界 x/y/z，Y 为高度。核心航向角 h=0 朝 -Z、右转为正，这只是内部角度约定。DCS Heading=0 朝 +X，Export 将其转换为 h=Heading+π/2；不能把核心的 -Z 直接称为地理北。
- 本机姿态：heading/pitch/roll（弧度），上仰和右机翼下沉为正；几何与世界点反解使用同一正交基。旧录制缺失姿态时回退到速度航向和平飞假设。
- dB 与线性：代码内一律线性运算，仅配置/日志用 dB。

## 1. 单驻留信噪比（雷达方程，能量形式）

全相参积累等效为"驻留能量"形式（Richards, *Fundamentals of Radar Signal Processing*；Skolnik, *Introduction to Radar Systems*）：

```
SNR = Pt_avg · Td · G(θ)² · λ² · σ / ( (4π)³ · R⁴ · k·T0·F · L )
```

- Pt_avg：驻留期间平均发射功率（W）；Td：驻留时长（s）；乘积为驻留能量 E。
- G(θ)：天线增益（含扫描损失，§3）；单基地收发同置 → SNR ∝ G²。
- k = 1.380649e-23，T0 = 290 K，F：噪声系数（线性），L：总损耗（线性）。
- σ：目标 RCS（m²）——**默认取 DCS 官方机型标量**（政策见 `docs/feasibility.md` §1.3）。

实际平均功率取 `min(ptx_avg, ptx_peak_w·τ·PRF)`，默认峰值上限 20 kW【假设】。因此 MPRF_ALT 为 1.8 kW、LPRF 为 40 W，不能在低占空比下仍无条件使用 2 kW。

相参处理默认是理想上界。`integration_efficiency` 可降低有效能量；`coherence_time_s` 可限制有效相参时间，超出部分仍占调度时间。这是保守能量上限，不等价于非相参积累算法。另乘双程波束因子和遮蔽能量系数。未建模大气、脉内调制、距离迁移或实际处理器；远距结果不作为真实雷达性能保证。

### 参考雷达（工作示例，配置可换）

| 参数 | 值 | 来源 |
|---|---|---|
| Pt_avg | 2000 W | 公开估计（战斗机级 AESA，范围宽，取保守中值）【假设】 |
| G0 | 37 dBi（5012） | 由 ~0.33 m² 有效孔径 × λ=0.03 m 推出 4πA/λ²【推导】 |
| F | 3 dB | 典型值【假设】 |
| L | 6 dB | 含收发链路、处理损失【假设】 |
| Td（默认搜索驻留） | 10 ms | HPRF 凝视典型值【假设】 |

**基准数字（测试锚点 T1）**：σ=5 m²、正前方、Pd=0.9/Pfa=1e-6 时
- SNR@100 km = 357（25.5 dB）
- 所需 SNR（Swerling 1）= 130.1（21.1 dB）
- Rmax = 100×(357/130.1)^0.25 ≈ **128.7 km**（≈70 nm，战斗机级 AESA 量级合理）

## 2. 检测统计

**Swerling 1 单 CPI 全相参积累后平方律检波**：目标功率指数分布，复高斯接收噪声，SNR 为平均目标信噪比。

```
Pd = Pfa^(1/(1+SNR))   ⟺   SNR_req = ln(Pfa)/ln(Pd) − 1
```

- Pfa=1e-6 是单次检验的概率，不能直接换算成时间虚警率；本项目尚不生成空距离/速度单元的虚警点。
- 默认 `fluctuation_hold_s=0.25`【假设】：同一真值目标在同一相关时间窗内保持指数 RCS 功率因子，每个 CPI 独立生成复接收噪声，按功率阈值 -ln(Pfa) 判定。单 CPI 边缘统计仍符合上述闭式，相关 CPI 的联合检测率不可用独立伯努利相乘。
- 相关窗是可配置的分段保持近似，不是已标定的真实目标姿态相关函数。设 0 可恢复各驻留独立伯努利采样。Swerling 的慢/快起伏定义见 [MathWorks RCS 模型](https://www.mathworks.com/help/radar/ug/modeling-target-radar-cross-section.html)。

**对照模型：Albersheim（1981，非起伏 + 非相参积累 N 脉冲）**（[MathWorks 文档](https://www.mathworks.com/help/radar/ref/albersheim.html)；Richards 2010）：

```
SNR_dB = −5·log10(N) + [6.2 + 4.54/√(N+0.44)] · log10(A + 0.12·A·B + 1.7·B)
A = ln(0.62/Pfa),  B = ln(Pd/(1−Pd))
```

适用 1e-7<Pfa<1e-3、0.1<Pd<0.9、N=1~8096，精度 ~0.2 dB。仅用作测试对照（T4），不进主路径。

**基准数字**：N=1、Pfa=1e-6、Pd=0.9 时非起伏需 13.1 dB，Swerling 1 需 21.1 dB → **起伏损耗 ≈ 8 dB**（与教科书数值一致，作为公式实现正确性的交叉验证）。

## 3. 相控阵扫描特性（AESA 区别于机械扫描的物理层）

- **增益扫描损失**：G(θ)=G0·cos^kθ，默认 k=1【假设】，指数可配置。参考 [Analog Devices 阵列方向图](https://www.analog.com/en/resources/analog-dialogue/articles/phased-array-antenna-patterns-part1.html)。
- **波束形状**：在阵面方向余弦 u/v 中使用高斯主瓣。归一化偏移平方 q=(Δu/sin(HPBWaz/2))²+(Δv/sin(HPBWel/2))²；单程增益因子为 exp(-ln2·q)，收发双程为 exp(-2ln2·q)。q=1 时双程为 1/4，搜索门截断为 q≤1【设定】，未模拟门外主瓣或副瓣。
- **波束展宽**：方向余弦投影自然产生沿扫描方向的展宽；不能把两个角度轴统一乘 secθ。横向扫描时交叉方向的波束宽度基本不变。
- **距离随扫描角**：SNR ∝ G² → Rmax(θ) = Rmax(0)·(cosθ)^(k/2)。**60° 时 = 0.707**（测试锚点 T2：128.7 → 91.0 km）。
- **电扫锥 ±60°**（v1 硬边界，配置项）；锥外不产生驻留（T10）。
- **波束指向时间**：µs 级（移相器切换），建模为常数开销 10 µs/次（相对 ms 级驻留可忽略但入账，T9）。
- **驻留补偿**：仅补偿增益模型的双程能量损失，Td=Td0·cos^(-2k)θ，可关闭。它会消耗更多时间，并不额外消除遮蔽、波束偏离或有效相参时间限制。

## 4. PRF 档、盲区与 notch（脉冲多普勒层）

各档参数进参考雷达配置；公式：

- 不模糊距离 Ru = c/(2·PRF)；不模糊速度 |vr| < λ·PRF/4。
- **主瓣 notch**：中心 vmlc=本机速度·波束方向。用周期 Vb=λ·PRF/2 将 vr-vmlc 折叠至 [-Vb/2,Vb/2)，折叠值落入配置半宽时判盲。因此杂波凹口及其混叠像都会抑制目标；不再额外把绝对零多普勒处视为同一个凹口。可选 `zero_notch_half_ms` 独立表示零多普勒/旁瓣杂波滤波，默认关闭。依据 [MIT 脉冲多普勒课程](https://www.ll.mit.edu/media/6976)。
- **Eclipsing**：矩形脉冲、发射期间接收关闭。以回波与当前/下一发射脉冲的区间交集计算丢失比例，接收能量在每个 Ru 两侧逐渐降低；完全遮蔽才判为周期盲区。HPRF 的 700/900m 接收系数分别约 0.165/0.502。依据 [MathWorks eclipsingfactor](https://www.mathworks.com/help/radar/ref/eclipsingfactor.html)。
- **近距下限**：默认 cτ/2 为完整脉冲接收的保守处理下限，波形 `min_range_m` 可覆盖。它并非部分回波绝对无法检测的物理定律；未模拟实际接收恢复时间和近距部分脉冲处理。

**参考三档示例**（λ=0.03 m）：

| 档 | PRF | Ru | ±v_amb | 特性 |
|---|---|---|---|---|
| HPRF | 200 kHz | 750 m | 1500 m/s | 速度无模糊、距离严重模糊（迎头） |
| MPRF | 20 kHz | 7.5 km | 150 m/s | 双模糊，需解模糊 |
| LPRF | 2 kHz | 75 km | 15 m/s | notch 半宽降为 5m/s，默认搜索不使用 |
| MPRF_ALT | 18 kHz | 8.33 km | 135 m/s | 第二中 PRF【设定】 |
| HPRF_ALT | 164 kHz | 914 m | 1230 m/s | 第二高 PRF【设定】 |

**v1 简化**：解模糊不在驻留层做——各档独立检测，经盲区/notch 过滤后在航迹层按位置聚合（M PRF 多档重合策略，简化决定）；距离模糊引起的"影子目标"v1 不生成（记录为已知偏差）。

## 5. 波束调度 / 雷达资源管理（AESA 的灵魂，区别于机械扫描的"模型层"）

依据：RRM 文献（Miranda 等《Knowledge-based resource management for multifunction radar》[综述](https://www.researchgate.net/publication/3321682_Knowledge-based_resource_management_for_multifunction_radar_a_look_at_scheduling_and_task_prioritization)；Charlish & Katsilieris《Array Radar Resource Management》开放书章；[Miranda UCL 博士论文](https://discovery.ucl.ac.uk/id/eprint/10099609/1/Resource_management_in_multifu.pdf)）。

- **事件时间轴**：在驻留结束和指向开销结束时推进调度，不受调用方 dt 分割影响。完成的驻留才产生检测，尚未完成的驻留保存在 pending。
- **任务边界优先级**：STT > 航迹回访 > 搜索；同级最早截止期优先，id 决定平局。不在驻留中途抢占。
- **回访率默认表**：远距跟踪 1–2 Hz、近距/机动 4 Hz、STT 5–10 Hz（RRM 文献经验区间；最终在调参中定）。
- **过载行为**（T7）：先占用搜索预算，回访按原截止期推进；错过的周期跳过并记真实延迟。总 STT 需求超过容量时无法保证请求频率，可能饿死低优先级任务，不宣称无限容量。20 条同步 6ms STT 的一批至少 120ms，50ms 全部完成不可实现。
- **账本**（T9）：预约驻留+指向开销+idle=busy_until，最多包含一个已开始而未完成的驻留。完成日志加 pending 才与驻留账本相等；可视化占用率扣除尚未消耗的预约时间。

## 6. 航迹管理

依据：Blackman《Multiple-Target Tracking with Radar Applications》。

- **起始 M/N 逻辑**：3 帧中 2 检（2/3）起始为确认航迹（T8）；滑窗实现。
- **坐标系（v2，2026-09-27）**：跟踪档案在世界系（track file 惯例，Blackman 第 9 章）——
  检测在 core 内由机体 az/el/R + 本机姿态转为世界点；本机机动不进入预测与关联。
  v1 机体坐标实现（az/R + 变化率）在实飞中已被证伪：本机 ~3°/s 转向把旋转速率混入
  az_rate，80-100km 处预测偏差 4-5km，编队目标（间隔 ~3km）误关联，航迹单步跳变
  6-13km；v2 在同一录制上最大跳变 ≤550m，且误关联产生的假航迹消失。
- **关联（v2.1）**：最近邻 + **速度自适应三维距离门** gate = base(250m) + (|vel|+150m/s)·漏检时长，
  上限 2000m；并拒绝隐含相对速度 >1000 m/s 的候选（物理合理上限，防串档反馈环）。
  动因：固定 1000m 门在近距编队（间隔 100-500m）串到邻机——flight7 实测位置闪烁、
  速度虚高 4285 m/s（≈间隔/回访周期）；自适应门后同一录制 0 次 >800 m/s。
  无速度门（匀速预测下门内即可，待加项）；JPDA/多假设不做（记录）。
- **质量与 coast**：漏检后按匀速外推保持（coast），~6 s 无更新 → 删除；航迹质量分供显示与调度（质量低 → 提高回访优先级）。
- **视图字段**：az/el/R/vr 为机体坐标显示/调度视图，由 core 每步用当前本机姿态从世界
  档案反解刷新——本机转向时视图随机体平稳变化（波束指向正确），档案不受影响。

### 6.1 PRF 管理（2026-09-30 审查修订）

- 搜索每个光栅位置依次使用 MPRF20k、MPRF18k、HPRF200k、HPRF164k，完成四个 CPI 后移动到下一位置，近距目标可以从搜索阶段被发现。
- 远距跟踪使用两个中 PRF；≤8km 使用两个高和两个中 PRF；STT 使用两个高 PRF。每完成实际调度的一次驻留才轮换，模式、频率和近远距变化会更新现有任务。
- 20k/200k 是整倍数关系，存在共同距离遮蔽；新增 PRF 减少这种重合，但不保证全距离、全速度覆盖，也不进行脉冲间交错或解模糊。
- 代价是搜索帧约为原单 PRF 搜索的四倍；实际时间随扫描补偿、跟踪/STT 负载增加。正常 notch/遮蔽可能使成功检测频率低于任务回访频率。
- 历史 flight7 的“几乎无共同盲区”“112m 可见”结论不能由模型支持，需在新波形配置下重新验证。

## 7. RCS 与可见性（真值层政策）

- σ 默认 = DCS 官方机型标量（本地明文 DB 已确认 87 条，提取脚本待做）；未覆盖机型用分档兜底值并在数据文件中**标注为估计**。
- 连续姿态 RCS 曲线 = 阶段三，默认关。
- LOS 初筛默认启用有效地球半径球面视距，horizon_enabled/earth_k/surface_alt_m 可配置。以海平面为基准的地平线不能代替局部地形。
- 真值可提供 target.visible 或 truth:is_visible(now, own, target)；false 强制抑制检测，缺失记录为 unknown。Export 可选调用官方 terrain.isVisible 六标量接口并发 L 行；该接口在当前 Export 沙箱中的可用性仍需实飞确认。旧录制没有 L 时只应用球面视距。
- 去掉无条件 250km 截断；max_range_m 可显式启用计算裁剪，审计原因为 range-limit。

## 8. v1 明确不做（防止过度建设）

波形级仿真（脉冲串/采样级匹配滤波/模糊函数数值）、阵列信号处理（波束形成权值/副瓣设计）、CFAR 窗口细节、气象/杂波图、传播折射精细模型、解模糊的影子目标、ECM/NCTR/数据链/LPI-RWR 联动（阶段二+）。抽象层级锁定为**"每驻留一次检测判定"**。

## 9. 测试断言清单（编号，tests/ 引用）

- **T1** 雷达方程基准：§1 参考雷达 vs σ=5 m²，正前方 SNR@100km=357±0.5%、Rmax=128.7 km±1%（闭式，无随机）。
- **T2** 扫描损失：θ=60° 时 Rmax=91.0 km（0.707 因子）；θ>60° 无驻留（合并 T10）。
- **T3** Swerling-1 闭式：SNR=130.1 时 Pd 精确=0.9；Pd 随 SNR 单调。
- **T4** 交叉验证：Albersheim(N=1) 与 Swerling-1 之差 = 8.0±1 dB（起伏损耗）。
- **T5** notch：vr 落入凹口 → Pd 强制 0；边界外恢复正常检测。
- **T6** 距离：近距完整脉冲下限与完全周期遮蔽不检测，部分遮蔽按能量系数降低 SNR；多 PRF 搜索可获取 600m 目标。
- **T7** 过载降级：构造 20 条航迹，搜索帧周期拉长、STT 仍按率回访（不饿死）。
- **T8** 航迹：确认窗口内两次命中，另有慢速动目标抑制；coast 期内漏检不删，超时删除。当前是时间窗近似，不是精确 2/3 扫描帧计数器。
- **T9** 完成日志不超过当前时刻；账本含一个 pending 驻留，Σ驻留+指向+idle=busy_until。不同 dt 分割产生同样的实际调度事件。
- **T10** 扫描锥外（|θ|>60°）调度器不产生驻留。

## 10. 参考文献

教科书：Skolnik《Introduction to Radar Systems》；Stimson《Introduction to Airborne Radar》(3rd ed.)；Richards《Fundamentals of Radar Signal Processing》；Mahafza《Radar Systems Analysis and Design Using MATLAB》；Blackman《Multiple-Target Tracking with Radar Applications》；Mailloux《Phased Array Antenna Handbook》。
开放获取：[Miranda et al. RRM 综述](https://www.researchgate.net/publication/3321682_Knowledge-based_resource_management_for_multifunction_radar_a_look_at_scheduling_and_task_prioritization) · [Miranda UCL 博士论文](https://discovery.ucl.ac.uk/id/eprint/10099609/1/Resource_management_in_multifu.pdf) · [NATO STO Adaptive RRM](https://www.sto.nato.int/document/adaptive-radar-resource-management-2) · [MathWorks: Albersheim](https://www.mathworks.com/help/radar/ref/albersheim.html) · [RF Essentials: Phased Array](https://rfessentials.com) · [相控阵计算公式](https://mmwavetest.com)

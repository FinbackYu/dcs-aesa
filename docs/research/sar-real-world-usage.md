# SAR 真实世界使用调研（战斗机 / 卫星 / 实时处理 / 作战使用）

- 状态：external-reference（2026-10-18 复核）

**日期**：2026-10-09 ~ 2026-10-10（五份笔记由并行调研任务独立完成，2026-10-10 归档）。
**背景**：校准本项目的 DCS SAR 原理仿真与真实系统的差距。仿真侧现状（128–2048 m 世界锚定小块、反投影 + PFA 双聚焦路径、实波束 MAP 底图、地理锚定拼接、连续采集与广域扫掠）见[任务内验证说明](../sar-in-mission.md)、[原型设计](../design-sar-prototype.md)、[可行性研究](../sar-feasibility.md)、[表面质量检查](../sar-surface-quality.md)。用户反馈"和真实系统观感不符"后，本调研为下列问题建立公开可查的锚点：分辨率怎么分档、大面积覆盖靠什么机制、哪些几何角度先天不可用、处理时延与刷新节奏的真实量级、SAR 产品在作战里用来干什么。
**方法**：五份公开资料调研笔记按主题分章归档。归档只做机械处理：去掉 swarm 包装标签、四条只对调度代理有意义的交接话、两处代理称谓（"给主 agent / 给父代理"→"要点回顾 / 备注"）、以及结尾一条已过时的"下一步可整理成文档"提议；正文、来源链接与证据标注一律原样保留。五份笔记独立完成，彼此重复与结论差异不合并、不改写。

## 五份笔记的主题分工

| 章 | 主题 | 回答的问题 |
|---|---|---|
| 1 | 战斗机 AESA 对地模式（RBM / DBS / SAR / GMTI） | 模式族谱与硬指标、斜视角限制、座舱呈现——飞行员实际拿到什么画面 |
| 2 | 卫星 SAR 成像模式与覆盖机制 | stripmap / ScanSAR / TOPS / spotlight / 滑动聚束的幅宽–分辨率–驻留权衡；大面积覆盖的正确机制 |
| 3 | 成像几何的物理约束 | 正前视为什么先天不行、画质随斜视角的退化、前视 SAR 都有哪些方案、运动补偿与 INS/GPS 精度要求 |
| 4 | 实时处理算法与工程实现 | 各成像算法（RDA / CS / ωk / PFA / BP）的应用场景与硬件路径；"秒级出图"的瓶颈在哪 |
| 5 | 作战使用与产品形态 | patch / 条带 / 镶嵌 / ViSAR / 变化检测的实际用法、判读员看什么、用户等多久 |

## 标注约定

五份笔记各自采用三档标注，措辞不同、含义一致，归档时保留原措辞：

- **一手指向来源**：【实证】（第 1 章）、【有据可查】（第 2 章）、【可查】（第 3 章）、【有据】（第 5 章）——厂商 / 官方 / 教科书 / 档案级资料。
- **二手中介**：【二手】——行业媒体、贸易档案、论坛、模拟器手册；细节可信但非一手。
- **无直接来源**：【计算】【推算】【推测】——按公式推算、对来源数字做的算术，或没有证据的推断；引用前需自行复核。

> 五份笔记独立得出同一结论：F-35 / AN/APG-81 的 SAR 分辨率、幅宽、成像时间在公开渠道没有可靠数字。本文件不给出任何"F-35 SAR = X 米"的说法，引用时请沿用"亚米级 UHR-SAR（厂商措辞）"。

## 总结论

- **分辨率是一条阶梯，不是一张照片**：RBM 实波束地图（分辨率 ≈ 斜距 × 波束宽度，X 波段 3° 波束在 20 km 处约 1 km 级）→ DBS 多普勒锐化（方位改善 8:1 / 64:1，APY-6 实测 180 ft ≈ 54 m）→ SAR 小块（亚米 ~ 3 m，幅宽 1 ~ 2 km）。座舱里它们是同一张地面稳定地图上的逐级放大/镶嵌：可冻结、可叠加移动目标符号与 ATR 标签，最终产物是目标经纬度。
- **F-15E AN/APG-70 HRM（SAR patch）档位表**——分辨率、patch 尺寸与作用距离硬绑定，"分辨率越高、patch 越小、距离越近"（来源：Air Power Australia F-15E 专辑【二手】，与 APG-66/77 档案的 MAP/EXP 4:1、DBS 8:1 / 64:1 分档互为印证）：

| Patch 尺寸 | 分辨率 | 最大作用距离 |
|---|---|---|
| 0.67 × 0.67 nmi（≈1.2 km） | 8.5 ft（≈2.6 m） | 10 nmi |
| 1.30 × 1.30 nmi | 17 ft（≈5.2 m） | 20 nmi |
| 3.30 × 3.30 nmi | 42 ft（≈12.8 m） | 50 nmi |
| 4.70 × 4.70 nmi | 59 ft（≈18 m） | 80 nmi |
| 10 × 10 nmi | 127 ft（≈39 m） | 160 nmi |

- **大面积覆盖靠 stripmap / 宽域模式，不靠聚束拼块**：卫星的大幅面图像全部来自条带（stripmap，方位分辨率 ≈ 天线长/2、与条带长度无关，TerraSAR-X 单条可延伸 1650 km）与宽幅模式（ScanSAR / TOPS 用分辨率换幅宽：Sentinel-1 IW 250 km、EW 410 km）。聚束全族都是"定点、高分辨、小块"模式（TerraSAR-X Staring SpotLight 仅 7.5×2.5 km @20° / 4×3.7 km @60°）——场景尺寸被天线足迹与转向范围锁死，是几何必然而非实现缺陷。
- **正前方盲锥 ±10–15°**：单站雷达在贴航迹 ±10–15° 内做不了 DBS/SAR（多普勒梯度 df/dθ=(2v/λ)·sinθ→0，且存在左右模糊）；正前方由增强实波束（monopulse 锐化）、TFR 高度剖面与 EO/IR 吊舱承担，雷达"成像"发生在 30–70° 离机头斜视带，战斗机战术上偏爱 45° 偏轴。
- **patch 节奏 3–10 s 合理**：真实驾驶舱节奏 = 凝视/驻留 3–7 s（F-15E pop-up）+ 处理数秒 + 冻结查看；APY-6"画面 30 s 内形成、15 s 累积显示后连续更新"；JSTARS SAR "several seconds"；Global Hawk 从请求到特战队员 PDA 2–3 分钟。我们 128 m patch 端到端 6–10 s 已在该窗口内——差距不在速度，在"拿到图之后能干什么"。
- **SAR 的核心用途是坐标生成**：F-35 的公开作战结论（DOT&E FY2016）是飞行员用 SAR mapping 推导"武器级坐标"，在编队内共享互验后才投放武器；产品形态是"小 patch + 分档分辨率 + 几秒等待 + 冻结取点"，而不是一张好看的灰度图。
- **GMTI 叠加是常态**：动目标以符号直接叠加在 SAR/MAP 底图上（APY-6、F-15E 闪烁矩形、JSTARS、Lynx cross-cue 到 EO/IR），SAR 与 GMTI 交错运行（APG-82 "near-simultaneous interleaving"）是 AESA 的核心卖点。

---

## 1. 战斗机 AESA 雷达对地模式调研笔记（SAR / DBS / RBM / GMTI）

**证据分级**：【实证】厂商/官方/教科书/档案级资料；【二手】媒体、行业手册、论坛、模拟器手册；【计算/推测】本笔记由物理公式推算或无直接来源的推断。凡 F-35 具体指标，公开渠道基本没有数字，下文明确标注。

---

### 0. 一句话结论（先看这个）

真实战斗机对地雷达不是"一张 SAR 照片"，而是**一条分辨率阶梯**：RBM 实波束大地图（上百 km 级、分辨率几百米）→ DBS（8:1 / 64:1 方位锐化，几十米级）→ SAR spot/strip 小块（亚米~3 m，1~2 km 块）。座舱里它们是**同一张地面稳定地图上的逐级放大链/镶嵌**，可冻结（freeze）、可叠加移动目标符号与 ATR 标签，最终用于**生成目标经纬度**。飞行员"拿到的画面"是：地图 + 本机符号 + 光标 + 目标符号/文本框，而不是孤立的一幅灰度图。

---

### 1. 模式族谱与硬指标

#### 1.1 权威模式清单（三份可交叉验证的档案）

**APG-77（F-22，APG-81 的技术母体）【实证】**，Forecast International 档案对其"Advanced Strike Modes"逐条列出，且注明该雷达"基于 APG-66/68/80(V) 家族"：

- **Enhanced Real Beam Ground Map (GM)**：导航与目标探测用地图，**作用距离 80 nmi**；用单脉冲测绘技术锐化硬目标；有 **4:1 分辨率增强的扩展地图模式**；带 Freeze（冻结后可关雷达静默接近）。
- **DBS**：在 10/20/40 nmi 量程上，**DBS1 方位分辨率改善 8:1；DBS2 为 64:1**；用于离轴武器投放的精确发射数据。
- **GMTI**：探测车、卡车、坦克、舰船、滑行飞机，**40 nmi**；GMTT 可自动跟踪。
- **FTT**（固定目标跟踪）可从 GM/GM EXP/SEA/DBS 进入；**SEA** 海面模式；**BCN** 信标。
- SAR 为 2008 年才在 APG-77 上飞行验证（F-22 Increment 3.1 增加图像接口，飞行员可"从雷达驱动的高保真**黑白图像**上选取目标"）。
  来源：[Forecast International APG-77(V) 档案](https://www.forecastinternational.com/archive/disp_pdf.cfm?DACH_RECNO=942)

**APG-66(V)2 / MLU（F-16 家族基线，DBS/MAP 数值同源）【实证】**：

- MAPPING：机头前方全天候地图，量程可选；**EXPANDED 为 4:1 放大**；**DBS 为方位/距离覆盖 8:1 改善**；**Medium DBS 可到 80 nmi**。
- **SCAN-FREEZE**："显示冻结的地面图 + 本机相对地面的运动"，雷达可周期性刷新地图；FREEZE 的同时仍在地图上描绘本机位置。
  来源：[Forecast International APG-66(V) 档案](https://www.forecastinternational.com/archive/disp_pdf.cfm?DACH_RECNO=391)

**F-16 APG-68(V)5 操作手册（模拟器/公开手册系）【二手】**给出四档表：

| 模式 | 放大 | 分辨率（相对 NRM 正常地图） |
|---|---|---|
| EXP | 4:1 | 不提升 |
| DBS1 | 4:1 | **8:1** |
| DBS2 | 8:1 | **64:1** |

同源：DBS2"是中等分辨率模式，锐化比可达 64:1，**耗时为 DBS1 的 2–4 倍**"（F-16 MLU 飞行员培训材料）。
来源：[AN/APG-68(V5) Operations Guide](http://www.maverick.webd.pl/pliki/f4_AN-APG-68-v5.pdf)、[F-16 MLU Production Tape M1（Scribd）](https://www.scribd.com/document/215346006/F-16-a-B-Mid-Life-Update-Production-Tape-M1-the-Pilot)

#### 1.2 有硬数字的完整"阶梯"样本：AN/APY-6(V)（吊舱 SAR/GMTI，非战斗机但数字最全）【实证】

这是公开资料里少见的、把 RBM→DBS→Spot SAR 整条链的**分辨率、幅宽、时间、几何**都写清楚的真实雷达（Norden/NG，Ku 波段，F-16D/Gray Wolf、S-3、NP-3C 上试过）：

| 模式 | 指标 |
|---|---|
| 实波束 RBM | 覆盖 >100 nmi 的宽域；"宽域监视"级画质 |
| DBS | 观测 **14×14 nmi** 区域，**180 ft（≈54 m）分辨率**；距离 64.7 km |
| Spot SAR | **0.8×0.8 nmi**（≈1.5×1.5 km）小块，10 ft 距离/方位分辨率 |
| 超高分辨率 SAR | **1 ft（0.3 m）@ >70 nmi**；SAR 分辨率 1 m 至 0.3 m |
| GMTI | 跟踪径向速度 **5–55（kt 或 km/h，原文单位混用）** 的动目标；符号**直接叠加在 SAR 图像上**；3 端口 CSI 干涉仪抑制杂波 |
| 成像时间 | "**画面 30 s 内形成，15 s 累积显示，随后连续更新**"；目标定位精度 20 m，宣称 SAR 精度 1 m |
| 显示逻辑 | "**从宽域（实波束）逐级降到各种高分辨率 SAR 小块（patch）**，供精确判读" |
| 几何 | 原文："**SAR 模式在速度矢量 ±10° 以内有效**"（即斜视受严格限制，接近正侧视才可用；原句字面是"速度矢量 ±10°"，结合上下文应理解为对正侧视（broadside）的偏差限制——此处存疑，见 §3） |

来源：[Forecast International APY-6(V) 档案](https://www.forecastinternational.com/archive/disp_pdf.cfm?DACH_RECNO=738)

#### 1.3 四款目标雷达的对地模式清单

**F-35 / AN/APG-81**【实证+二手】
- 官方口径：Northrop Grumman 称其有"**ultra-high-resolution SAR mapping mode**"，用于识别与交战地面目标；诺格官网幻灯片列出 APG-81 的用途：对战斗机、地面威胁、无人机/巡航导弹、**BDA（战损评估）、GMTI、SAR 测绘**。来源：[Air & Space Forces Magazine, 2023](https://www.airandspaceforces.com/northrop-grumman-reveals-its-developing-the-f-35s-new-radar/)、[Armada International, 2022](https://www.armadainternational.com/2022/05/airborne-aesa-fighter-radars/)
- 能力清单（Wikipedia 汇总诺格口径）：航迹、空中/地面移动目标指示与跟踪、SAR 高分辨率测绘、**combat ID**、EW、宽带通信，全部可交错（interleaved）。来源：[Wikipedia AN/APG-81](https://en.wikipedia.org/wiki/AN/APG-81)
- **具体分辨率/幅宽/成像时间：公开渠道没有可靠数字**。能查到的只有 2005 年的诺格访谈："我们正让 F-35 雷达的分辨率提高到能**轻松辨认地面特征**，并**一次看更大片的地皮**——比现在的雷达覆盖 3~4 倍的地域"；以及"机头 20×8 英寸全景显示器上可通过按钮选择 SAR ground mapping 等软件模式"。来源：[Avionics Today, 2005](https://www.aviationtoday.com/2005/10/01/f-35-integrated-sensor-suite-lethal-combination/)
- ATR 是 F-35 最保密的部分，"飞行员可在**任务规划时选择要识别的目标类型**"（即 ATR 目标类清单在任务前装载）。来源：同上。

**F-16 家族**
- **APG-68(V)9（机械扫描，最后一型）**【实证】：新 SAR 模式 **2 ft（0.6 m）分辨率**；LM 原话"地面测绘模式分辨率为全球量产战斗机最高"。来源：[Lockheed Martin 2002 新闻稿](https://news.lockheedmartin.com/2002-06-25-Performance-Flight-Testing-of-Updated-Radar-Under-Way-for-Lockheed-Martin-F-16-New-Technology-Expected-to-Significantly-Increase-Radar-Performance)；后续诺格口径："SAR 图像分辨率**优于 1 m**，堪比军用成像卫星"。来源：[F-16.net, 2007](https://www.f-16.net/f-16-news-article2665.html)
- **APG-80（Block 60，AESA）**【实证+二手】：~1000 个 TR 组件，可**同时**对空/对地跟踪并地形跟随；SAR 测绘。来源：[Armada International](https://www.armadainternational.com/2022/05/airborne-aesa-fighter-radars/)
- **APG-83 SABR（F-16V/Block 70）**【实证+二手】：诺格为它起了专名——"**Big SAR**：单张图像覆盖大片地面的高清晰雷达图像"，另有"**高精度坐标生成（high quality co-ordinate generation）**"、"分模式交错运行（interleaved modes）"；即"自动目标提示（ATC）+ SAR"。来源：[F-16.net SABR 报道（引诺格）](https://www.f-16.net/f-16-news-article4836.html)、[Armada International](https://www.armadainternational.com/2022/05/airborne-aesa-fighter-radars/)
- APG-83 的座舱承诺："全天候高分辨率 SAR 测绘，给飞行员一张**大范围地表图像**用于更精确的目标识别与打击"。来源：[The Aviation Geek Club（引诺格）](https://theaviationgeekclub.com/spangdahlem-f-16-jets-are-the-first-active-duty-usaf-vipers-to-receive-an-apg-83-sabr-aesa-radars/)
- 一条**可疑数字**：某土耳其防务站称 APG-83"SAR+ATC，GMTI 可探测 300 km 地面目标"——与公开常识不符，**【二手/存疑】**。来源：[Defence Turkey](https://defenceturkey.com/en/content/does-f-16-viper-block-70-72-aircraft-cater-to-the-turkey-5035)

**台风 Captor / Captor-E / ECRS**【二手为主】
- **SAR 0.3 m 分辨率**是 Captor 家族的公开卖点（Captor-D 时代文件即如此描述）。来源：[Key.Aero 深度文章](https://www.key.aero/article/depth-look-eurofighters-next-gen-radar)、[Secret Projects 论坛引 2006 年资料](https://www.secretprojects.co.uk/threads/eurofighter-typhoon-avionics.19/)
- **Captor-E/ECRS**：HENSOLDT 官方口径"**ultra-high resolution SAR imagery**、含 **GMTI 与 STAP** 的对地模式、兼作电子支援/攻击"。来源：[HENSOLDT ECRS Mk1](https://www.hensoldt.net/products/ecrs-mk1-eurofighter-common-radar-system)
- **几何优势**：AESA 天线装在机械**重定位器**上（ECRS Mk0 双斜盘 ±30° 俯仰），**视场超过 180°**，远超固定阵面（约 90–120°）。来源：[Wikipedia Euroradar CAPTOR](https://en.wikipedia.org/wiki/Euroradar_CAPTOR)、[Armada International](https://www.armadainternational.com/2022/05/airborne-aesa-fighter-radars/)
- **座舱呈现（关键证据，见 §4.2）**：SAR + ATR 的详细描述在 Captor 资料里最完整。

**阵风 RBE2 / RBE2 AESA**【实证】
- RBE2：**±60° 方位/俯仰**电扫；~1000 个 GaAs TR 组件；**对空与对地可交错**。
- 对地模式清单（Avionics Today）：**DBS mapping、SAR mapping、FTT、海面搜索与 TWS、GMTI/T、对地测距，以及对地防撞/地形跟随可组合生成"3D 雷达地图"**。
- RBE2 AESA 增加的新对地模式：GMTI 等。来源：[Avionics Today《Serious Squall》, 2009](https://www.aviationtoday.com/2009/06/01/serious-squall/)、[European Security & Defence, 2023](https://euro-sd.com/2023/01/articles/26781/main-aesa-radar-solutions-on-both-sides-of-the-atlantic/)

---

### 2. 硬指标汇总表

| 项目 | 数值 | 来源/等级 |
|---|---|---|
| RBM 作用距离 | 80 nmi（APG-66/68/77/80 家族）；APY-6 >100 nmi | 【实证】Forecast 档案 |
| RBM 分辨率 | 等于斜距×波束宽度（X 波段 3° 波束 → 20 km 处约 1 km 级）；单脉冲锐化 4:1 | 【实证】原理+4:1 档案；数值为【计算】 |
| DBS 分辨率改善 | 8:1（DBS1）、64:1（DBS2）；绝对量级"几十米"（APY-6 实测 180 ft≈54 m） | 【实证】Forecast + [Principles of Modern Radar Vol.3](https://ftp.idu.ac.id/wp-content/uploads/ebook/tdg/ADNVANCED%20MILITARY%20PLATFORM%20DESIGN/Principles%20of%20Modern%20Radar.%20Volume%20%203.pdf) |
| DBS 观测幅宽 | 14×14 nmi（APY-6） | 【实证】Forecast |
| SAR 分辨率 | 战斗机：2 ft（F-16 V9）、<1 m（诺格）、0.3 m（Captor、APY-6 1 ft@70nmi） | 【实证/二手】 |
| SAR 小块尺寸 | Spot 0.8×0.8 nmi（≈1.5 km）；SABR "Big SAR"=单张大范围图（无数字） | 【实证】/【二手】 |
| 成像时间 | 画面 30 s 形成、15 s 累积显示后连续更新（APY-6）；DBS2 刷新为 DBS1 的 2–4 倍；**战斗机 SAR 聚束相干积累约数秒**（1 m@20 km/250 m·s⁻¹ ≈ 1.2 s；0.3 m@20 km ≈ 4 s） | 【实证】APY-6/MLU；相干时间【计算】 |
| 更新率 | 对空单目标可达 ~15 次/s（APG-81）；对地地图级更新 = 扫描/积累节拍（秒级），可 Freeze | 【二手】Avionics Today；Freeze【实证】 |
| 斜视角 | DBS 最优在正侧视（90°），**距机头 ~10° 内退化到不优于实波束**；机载 SAR 历史上常用斜视 ≤60°；APY-6 原文"SAR 在速度矢量 ±10° 内有效" | 【实证】[Lacomme 教材](https://www.iz3mez.it/wp-content/library/ebook/Air and Spaceborne Radar Systems - An Introduction - (2001) WW.pdf)、[Thiele 论文](https://www.ipi.uni-hannover.de/fileadmin/ipi/publications/2013_Thiele.pdf)、Forecast APY-6 |
| 正前方成像 | 常规 SAR 不能正前方；"dead-ahead beam sharpening"需要专门单脉冲技术（有专利） | 【实证】[EP0434064 专利](https://data.epo.org/publication-server/rest/v1.2/patents/EP0434064NWA2/document.pdf) |
| GMTI 距离 | 40 nmi（APG-77）；APG-66(V)2 低速目标相干检测；APY-6 跟踪 5–55（kt 或 km/h） | 【实证】 |
| GMTI 盲区 | 白噪音盲区 = 主瓣杂波（正侧视时横穿目标难检）；机头/机尾方向因多普勒梯度小受限 | 【实证】原理（[Wikipedia MTI](https://en.wikipedia.org/wiki/Moving_target_indication)）+【推测】细化 |
| 移动目标与 SAR | 真 SAR 只成像静止目标；GMTI 数据**以符号叠加在 SAR 图上** | 【实证】Forecast APY-6 |
| 目标定位精度 | 目标定位 20 m（APY-6，配 RLG/GPS/INS）；Captor 可用矢量地图反算目标 GPS 坐标 | 【实证】 |

---

### 3. 几何限制详解（"是否回避正前方"）

- **RBM 不回避**：它本质就是天线波束扫过的地图，可用在机头前方区域内（APG-66/68 前半球 ±60° 量程内任意选段）。
- **GMTI 主要在侧前方**：为把地面运动目标多普勒与主瓣杂波分开，需要明显的离轴角（正侧视附近性能最好）；正前方横穿目标的多普勒≈0，落在杂波陷波里。【原理，有据】
- **DBS/SAR 回避机头/机尾**：DBS 方位分辨率随"与速度矢量的夹角"变化，**正侧视最优，<10° 时恶化到不优于实波束**（Lacomme）；实践中常用斜视 30–70°。【实证+二手，[rfessentials DBS 词条](https://rfessentials.com/resources/rf-glossary/dbs/)】
- **APY-6 原文**："SAR modes are operational to within ±10 degrees of the aircraft velocity vector"——字面是"在速度矢量 ±10° 内有效"，与"SAR 需侧视"矛盾，合理理解应为"对正侧视方向 ±10° 的斜视范围内有效"（即斜视必须小）。**引用时请保留原文并注明歧义**。
- **机载 SAR 斜视历史**："过去机载系统出于战术安全考虑使用过最高 60° 斜视"（Thiele 论文）。
- **正前方**：常规 SAR 在零多普勒平面（正前/正后）没有可用的多普勒梯度，需专门"死前向锐化"单脉冲技术（专利 EP0434064），说明这不是常规能力。

---

### 4. 座舱呈现：飞行员实际看到什么

#### 4.1 传统四代机（F-16 / F-18 系）——"一张地面稳定地图 + 逐级放大"
- F-16 雷达用 **B-scope** 呈现（不是圆扇形 PPI）；雷达覆盖 120°×120°，对地模式有 GM（正常）、EXP(4:1)、DBS1(8:1)、DBS2(64:1) 四档放大，另有 **steerpoint（指向导航点）/snowplow（机头下扫）**两种扫描起点、光标选择"patch"区域、**freeze**；GMT 模式不提供 DBS1/DBS2 扩展。【二手】[APG-68(V5) Ops Guide](http://www.maverick.webd.pl/pliki/f4_AN-APG-68-v5.pdf)、[Chuck's Guides DCS F-16CM](https://chucksguides.com/aircraft/dcs/f-16cm/)
- F/A-18（DCS 官方手册，按实物 APG-73 建模）主模式族：MAP（默认实波束）、GMT、SEA、TA，以及 **GMT/MAP 交错、SEA/MAP 交错、DBS、EXP1 Sector、EXP2 Patch、EXP3（SAR）**；手册原话"称为 MAP W/SECTOR、MAP/PATCH、MAP W/SAR"——**同一张地图内的三种放大/精细层次**。【二手/模拟器】[DCS F/A-18C 官方指南 PDF](https://www.digitalcombatsimulator.com/en/downloads/documentation/)
- **冻结语义**：SCAN-FREEZE 显示冻结的地面图，并继续画本机相对地面的运动（雷达可周期性更新地图）；APG-77 的 Freeze 用于"关雷达、静默接近目标"。【实证】Forecast 档案

#### 4.2 Captor 系（最完整的"SAR+ATR+地图叠加"描述）【二手，源自德语维基转引 airpower.at / EADS RTO-MP-SET-096】
- 高分辨率 SAR 图像先做高斯平滑 → Canny 边缘 → 闭结构 → 傅里叶描述子 → 神经网络 ATR。
- **目标以红色菱形标在 SAR 图像上，菱形上方红字显示目标类型，如 "T-72"、"MLRS"**。
- **SAR 图像叠加在带已知 GPS 坐标的矢量地图上**，据此计算目标的 GPS 坐标；或用本机 GPS+距离/视角反算。
- 来源：[Wikipedia Euroradar CAPTOR](https://en.wikipedia.org/wiki/Euroradar_CAPTOR)

#### 4.3 F-35 ——"融合态势图 + 传感器窗口"，不是独立照片
- PCD（20×8 英寸全景触摸屏）分成最多 4 个 portal + 8 个 secondary window，5 种可编程布局；**portal 1 是战术态势显示（TSD）**——融合引擎输出的"上帝视角"地图，所有 F-35 共享同一画面；**其余 portal 显示传感器画面，"在本例中是 EOTS 和 SAR"**。飞行员可触摸/光标/语音操作。来源：[Second Line of Defense – F-35 座舱/Skaff 幻灯片](https://sldinfo.com/2012/04/the-f-35-cockpit-enabling-the-pilot-as-a-tactical-decision-maker/)、[An Overview of the F-35 Cockpit](https://sldinfo.com/whitepapers/an-overview-of-the-f-35-cockpit-what-5th-generation-aircraft-are-all-about/)
- 官方 2005 年设想的使用流程：MFD 上出现潜在目标 → **手指点屏幕放大看清晰图像**（识别为敌方地面车辆）→ 再点一次即完成目标指定。来源：[Avionics Today, 2005](https://www.aviationtoday.com/2005/10/01/f-35-integrated-sensor-suite-lethal-combination/)
- F-22（同族）拿到 SAR 后的呈现："从雷达驱动的**高保真黑白图像**上选取目标"。来源：[Forecast APG-77 档案](https://www.forecastinternational.com/archive/disp_pdf.cfm?DACH_RECNO=942)
- **要点**：F-35 的"SAR 显示"= TSD 底图（融合、地理锚定、带符号）+ 一个可选的 SAR/EOTS 传感器窗口；SAR 图像被当作"可点击的地图图层"来指定目标，而不是一张孤立灰度图。

#### 4.4 教科书对呈现的总述
- Skolnik《Radar Handbook》第 3 版第 5 章（Lynch & Kopp，"Multifunctional Radar Systems for Fighter Aircraft"，pp. 5.1–5.46）系统覆盖战斗机雷达任务/模式/显示，包括实波束测绘与显示格式（该章摘录片段提到"3° 天线波束宽度"的显示示例）。我未能获取全文（多个镜像不可达），仅按章节目录与片段引用。来源：[Monash 记录](https://research.monash.edu/en/publications/multifunctional-radar-systems-for-fighter-aircraft)、[摘录 PDF（下载超时）](https://bemil.chosun.com/nbrd/data/10040/upfile/200908/20090830012948.pdf)
- Lacomme《Air and Spaceborne Radar Systems》第 20 章：DBS 用于地面成像"适合探测地面设施，分辨率随天线方位角变化，正侧视最优"。来源：[教材 PDF](https://www.iz3mez.it/wp-content/library/ebook/Air and Spaceborne Radar Systems - An Introduction - (2001) WW.pdf)

---

### 5. 对我们的启示：当前设计与真实系统的差距（按重要性排序）

> 我们当前设计（本地 `aesa/docs/sar-in-mission.md`）：128 m 固定小块 + 512/2048 m 世界格网扫掠、反投影/PFA 聚焦、MAP 实波束底图（30 km 扇区/250 m 格、3° 波束卷积）、50 张世界锚定拼接、斜视角门控 20–160°（推荐 30–60°）、2 s 孔径、无天线方向图/噪声/多视/定标。

1. **缺少"中间档"——没有 DBS 层。** 真实座舱里飞行员最常用的是地图放大链 RBM→EXP(4:1)→DBS1(8:1)→DBS2(64:1)→SAR 小块；我们在 30 km/250 m 的 MAP 与 128 m 的 SAR 之间有 2–3 个数量级断层。"看不到中间那档"是"感觉不对"的最大来源。建议：在 MAP 基础上增加 DBS 等效档（例如 2–4 km 视场、方位锐化 8:1/64:1 的快速成像，秒级刷新、可连续），作为默认交互入口，SAR 小块才是"最后一步放大"。[依据：§1.1/§1.2]
2. **呈现形态是"望远镜切片+拼接"，不是"地面稳定地图"。** 真实系统：单一地面稳定画面（B-scope/PPI 或融合地图）、本机符号+航迹、光标选 patch、冻结、目标符号与文本框叠加、缩放档位（10/20/40/80 nmi）。F-35 更进一步：SAR 是融合 TSD 地图旁的一个窗口，图像可点击指定目标。建议：把现有 mosaic 升级为"主地图视图"，SAR/MAP 帧作为图层贴入，加航迹、光标坐标读出、目标符号层与冻结/暂停；不要让 SAR 图以孤立窗口形式出现。[依据：§4.1–4.3]
3. **图像内容与质感缺少"雷达的痕迹"。** 我们的假设模型没有天线双程方向图（方位/俯仰加权）、旁瓣、距离/多普勒模糊、噪声底、STC/定标、多视降斑、运动补偿误差。真实操作员一眼能认出的"雷达感"（主瓣形状的亮带、盲距、斑点统计、边缘增强）我们没有。建议按性价比补：天线方向图加权 + 接收噪声 + 多视 + 简单 STC/幅度定标，并把"每帧峰值归一化"改成有物理语义的标度。[依据：§1.2 雷达链完整性、§4 呈现]
4. **SAR 小块的尺度与数量级偏差。** 真实 spot patch 约 0.8×0.8 nmi（1.5 km）级别、"Big SAR"是单张大范围图；我们默认 128 m（0.07 nmi）显示 1 m 像素——像"显微镜看砂纸"。建议默认成像窗口提升到 512 m–2 km，128 m 作为可选 zoom；同时把"一次成像覆盖一片区域"（Big SAR 思路）作为常规体验。[依据：§1.2/§1.3]
5. **时间语义：真实是"慢而稳、可冻结"，我们是"连续快刷"。** 真实 SAR 需数秒相干积累；DBS2 刷新是 DBS1 的 2–4 倍；APY-6 画面 30 s 才成形；F-16 冻结后本机在地图上移动。连续的、几秒一张的自动刷新反而不像真实使用节奏。建议：显式提供"采集—成形—冻结—（可后台继续更新）"的阶段状态与进度指示，并允许在图上看到成像期间的航迹段（真实系统会把平台轨迹画在图上）。[依据：§1.2/§4.1]
6. **模式交错与互补叠加缺失。** 真实系统：GMTI 符号直接叠在 SAR 图上；SAR/GMTI/对空可交错（AESA 卖点）。我们没有动目标层。建议：即使不做完整 STAP，也先做"运动目标符号层"（动目标不参与 SAR 成像、以符号标出并给径向速度），这既是真实行为也是座舱观感关键。[依据：§1.2 GMTI]
7. **目标定位/坐标生成链路不完整。** 真实系统最终产物是目标经纬度（APY-6 目标定位 20 m 级；Captor 用矢量地图反算 GPS）。我们已有经纬度转换与世界锚定，缺"图上点击→目标坐标读出/记录"闭环。建议在 mosaic/SAR 视图加光标经纬度与距离方位读出、点击生成目标点。[依据：§1.2/§4.2]
8. **几何门控基本正确但需要"分级"。** 我们 20–160°、推荐 30–60° 与真实 DBS/SAR 的 30–70° 使用区间一致，方向正确；但要注意真实 RBM/GMTI 在近机头方向也可用——不要用 SAR 的门控去限制 MAP 底图与未来的动目标层。另外建议在 UI 明示"正前方/正后方 SAR 不可用"的原因（多普勒梯度→0），这与真实操作员的心理模型一致。[依据：§3]
9. **ATR/目标类型清单未做。** F-35 允许任务前选择要识别的目标类型；Captor 在图上画类型标签。可在任务配置里提供"目标类型清单"（坦克/车辆/建筑等）作为未来 ATR 钩子，并先在 UI 上以符号+文本标签形式占位。[依据：§1.3/§4.2]
10. **地理配准精度与定标未验证。** 真实 SAR 依赖 IMU/GPS 导航精度并宣称米级几何精度；我们的世界锚定只是显示层未做/未验证几何与辐射配准（文档已声明）。对"看起来真实"而言，几何配准正确（拼接无缝、边缘不位移）优先级高于绝对精度。[依据：§1.2 精度行]

---

### 6. 主要来源索引

1. [Forecast International – APG-77(V) 档案（Advanced Strike Modes 全文）](https://www.forecastinternational.com/archive/disp_pdf.cfm?DACH_RECNO=942)
2. [Forecast International – APG-66(V) 档案（MAP/EXP/DBS/SCAN-FREEZE）](https://www.forecastinternational.com/archive/disp_pdf.cfm?DACH_RECNO=391)
3. [Forecast International – APY-6(V) 档案（RBM/DBS/Spot SAR/GMTI 全指标+成像时间+几何）](https://www.forecastinternational.com/archive/disp_pdf.cfm?DACH_RECNO=738)
4. [Lockheed Martin 2002 – APG-68(V)9 SAR 2 ft](https://news.lockheedmartin.com/2002-06-25-Performance-Flight-Testing-of-Updated-Radar-Under-Way-for-Lockheed-Martin-F-16-New-Technology-Expected-to-Significantly-Increase-Radar-Performance)
5. [Lockheed Martin 2003 – APG-68(V)9 SAR 飞行试验](https://news.lockheedmartin.com/news-releases?item=122840)
6. [F-16.net 2007 – APG-68(V)9 SAR <1 m](https://www.f-16.net/f-16-news-article2665.html) / [F-16.net 2014 – SABR "Big SAR"](https://www.f-16.net/f-16-news-article4836.html)
7. [Radartutorial – AN/APG-83](https://www.radartutorial.eu/19.kartei/08.airborne/karte023.en.html)
8. [Armada International 2022 – Airborne AESA Fighter Radars（SABR Big SAR/坐标生成；AESA FOV）](https://www.armadainternational.com/2022/05/airborne-aesa-fighter-radars/)
9. [Air & Space Forces Magazine 2023 – APG-81 用途/BDA/GMTI/SAR](https://www.airandspaceforces.com/northrop-grumman-reveals-its-developing-the-f-35s-new-radar/)
10. [Avionics Today 2005 – F-35 传感器与 SAR 使用设想/ATR](https://www.aviationtoday.com/2005/10/01/f-35-integrated-sensor-suite-lethal-combination/)
11. [Second Line of Defense 2012 – F-35 座舱/Skaff（PCD/TSD/SAR 窗口）](https://sldinfo.com/2012/04/the-f-35-cockpit-enabling-the-pilot-as-a-tactical-decision-maker/)
12. [Wikipedia – AN/APG-81](https://en.wikipedia.org/wiki/AN/APG-81) / [Euroradar CAPTOR（ATR+矢量地图叠加；FoR>180°）](https://en.wikipedia.org/wiki/Euroradar_CAPTOR)
13. [HENSOLDT – ECRS Mk1（ultra-high res SAR/GMTI/STAP）](https://www.hensoldt.net/products/ecrs-mk1-eurofighter-common-radar-system)
14. [Key.Aero – 台风下一代雷达（Captor-D SAR 0.3 m）](https://www.key.aero/article/depth-look-eurofighters-next-gen-radar)
15. [Avionics Today 2009 – Rafale/RBE2 对地模式清单](https://www.aviationtoday.com/2009/06/01/serious-squall/)
16. [European Security & Defence 2023 – RBE2 AESA/GMTI、APG-82 RMP](https://euro-sd.com/2023/01/articles/26781/main-aesa-radar-solutions-on-both-sides-of-the-atlantic/)
17. [Lacomme《Air and Spaceborne Radar Systems》第 15/20 章（DBS 几何）](https://www.iz3mez.it/wp-content/library/ebook/Air and Spaceborne Radar Systems - An Introduction - (2001) WW.pdf)
18. [《Principles of Modern Radar Vol.3》（DBS 分辨率量级、SAR/DBS 章节）](https://ftp.idu.ac.id/wp-content/uploads/ebook/tdg/ADNVANCED%20MILITARY%20PLATFORM%20DESIGN/Principles%20of%20Modern%20Radar.%20Volume%20%203.pdf)
19. [Skolnik《Radar Handbook》3rd ed. 第 5 章 Lynch & Kopp（页码/目录）](https://research.monash.edu/en/publications/multifunctional-radar-systems-for-fighter-aircraft)
20. [Thiele 2013 论文（机载 SAR 斜视 ≤60° 历史）](https://www.ipi.uni-hannover.de/fileadmin/ipi/publications/2013_Thiele.pdf) / [EP0434064 死前向锐化专利](https://data.epo.org/publication-server/rest/v1.2/patents/EP0434064NWA2/document.pdf)
21. [AN/APG-68(V5) Operations Guide（EXP/DBS 档位表）](http://www.maverick.webd.pl/pliki/f4_AN-APG-68-v5.pdf) / [DCS F/A-18C 官方指南（MAP/EXP1 Sector/EXP2 Patch/EXP3 SAR）](https://www.digitalcombatsimulator.com/en/downloads/documentation/) / [Chuck's Guides F-16CM](https://chucksguides.com/aircraft/dcs/f-16cm/)
22. [Defence Turkey – APG-83（SAR/GMTI/ATC，含 300 km 存疑数字）](https://defenceturkey.com/en/content/does-f-16-viper-block-70-72-aircraft-cater-to-the-turkey-5035)

**未获证实/未能访问的关键资料**（如实记录）：F-35/APG-81 的 SAR 分辨率、幅宽、成像时间、更新率均无公开可靠数字；Skolnik 第 5 章全文与 "Multifunctional Radar Systems" 摘录 PDF 多次下载超时，仅按目录与片段引用；Captor-E 的直接 SAR 指标依赖 2006 年与 2021 年媒体报道（0.3 m），非当前官方数据表。

---

## 2. 卫星 SAR 成像模式与覆盖机制调研（用于校准我们的 DCS SAR 仿真）

调研范围：Sentinel-1（ESA）、TerraSAR-X/TanDEM-X（DLR/Airbus）、Capella、ICEYE、Synspective StriX，加上 PRF/模糊理论文献与星载（近）实时处理文献。全部 URL 见文末；文中标【有据可查】= 直接引用来源，标【推算】= 我用来源数字做的算术，标【推测】= 无直接证据的推断。

### 0. TL;DR

1. **真实 SAR 的"大面积覆盖"不靠聚束拼贴，靠 ScanSAR/TOPS 宽幅模式 + 重复轨道/星座**；聚束（spotlight）全族都是"定点高分辨、小块"模式，这不是实现缺陷而是几何必然【有据可查，见 §3/§6】。
2. **模式选择本质是一条"分辨率 ↔ 覆盖"的连续谱**，一个统一的转向/滑动因子 A 就能涵盖 stripmap(A=1)/sliding spotlight(0<A<1)/spotlight(A≈0)，分辨率 ≈ A·L/2【推算，得到 USU 论文数据点支持】。
3. **条带模式的分辨率与条带长度无关**（方位分辨率 ≈ 天线长度/2），所以能无限延伸（TerraSAR-X 单条可达 1650 km）；聚束的**场景尺寸由天线足迹和转向范围决定**（TSX Staring Spotlight 仅 4×3.7 km @60°）【有据可查】。
4. **PRF 的"钻石图"约束**（下限=多普勒采样、上限=距离模糊/发射遮蔽/星下点回波）是宽幅 vs 高分辨不可兼得的根源；实测值：Sentinel-1 PRF 1000–3000 Hz、TerraSAR-X 2.0–6.5 kHz、商业小卫星 ≤7 kHz【有据可查】。
5. **星上实时处理已经有实机数字**：DLR EO-ALERT 用 ω-k 算法在 Zynq MPSoC 上做 L1 成像 3.7 s/块（375–500 km²）；AGX Orin 上滑动聚束 42966×27648 像素成像 19.25 s（采集 11.43 s），即"近实时"【有据可查】。
6. **对我们最重要的一条**：我们的仿真只有"聚束小块 + 拼接扫掠"，缺真实系统的主力机制 **stripmap 连续条带**和**宽域模式降分辨率换幅宽**——这大概率是用户觉得"和真实 F-35 SAR 感觉不对"的根因（详见 §7）。

---

### 1. 统一视角：转向/滑动因子 A

所有非宽域的方位成像模式可以用一个参数统一（记 A = 地面上"照明点/场景"沿航迹滑动速度 ÷ 平台地面速度）：

| A | 模式 | 方位分辨率 | 方位覆盖 |
|---|---|---|---|
| A = 1 | Stripmap | ≈ L/2（天线长度一半，与距离无关） | 整条航迹连续 |
| 0 < A < 1 | Sliding Spotlight | ≈ A·L/2 | 覆盖航迹的 A 比例 |
| A ≈ 0 | Spotlight | λR/(2·v·T_dwell)（驻留时间决定） | 仅天线足迹大小 |

- 文献数据点（USU SmallSat 论文）：天线方位长 L=4.9 m，取 A=0.1 → 方位分辨率 δ=0.25 m；每目标驻留 4.8 s；地面滑动速度 V_sweep=0.75 km/s；总观测 30 s → 约 22 km 长条带【有据可查 + 推算】。验证：0.1×4.9/2 = 0.245 m ✓；λR/(2vT) = 0.031×600km/(2×7500×4.8) ≈ 0.26 m ✓。
- 这解释了全部市场文案：Capella 说 spotlight "天线注视一点、方位分辨率随驻留时间提高、图像宽度由天线波束尺寸决定"；sliding spotlight "改为缓慢滑动照明点，分辨率优秀但覆盖更大"【有据可查，Capella 支持页】。ICEYE 说 SLEA（=sliding spot）"用更长照明时间补偿分辨率损失，15×15 km 场景 1 m"【有据可查】。

**要素耦合关系（全篇的主线）**：分辨率 ↔ 单目标驻留时间；覆盖/场景长度 ↔ 转向扫描速率（A）；幅宽（距离向） ↔ PRF ↔ 距离模糊。三者互锁。

---

### 2. 各模式机制与硬指标

#### 2.1 Stripmap（条带模式）
- 机制：天线波束在方位/俯仰上固定，脉冲连续发射，"图像质量沿飞行方向连续"，条带长度只受资源限制【有据可查，Airbus TSX 产品指南】。
- TerraSAR-X：分辨率 3 m，标准场景 30 km × 50 km，**采集长度可延伸到 1650 km**【有据可查】；条带/ScanSAR 发射占空比 18%【有据可查，eoPortal TSX】。
- Sentinel-1 SM：80 km 幅宽、5 m × 5 m，入射角 18.3°–46.8°【有据可查，ESA/Earthdata】。
- ICEYE Strip：3 m / 30 km × 50 km，标称采集 10 s，最长 500 km（70 s）【有据可查】。
- 驻留时间（单目标被照射时长 = 足迹穿越时间）：S1 ≈ 0.53 s、TSX ≈ 0.47 s【推算：λR/L ÷ Vg】，对应分辨率 L/2（S1 天线 12.3 m → ≈6 m；TSX 4.8 m → 2.4 m，与公布 3 m 一致）。

#### 2.2 ScanSAR（扫描模式）
- 机制：俯仰向电子切换多个子条带（sub-swath），"准同时"覆盖；每条子带内目标照射时间被压缩到 1/N → 方位分辨率下降【有据可查】。
- 定量规则：ScanSAR 方位分辨率比 stripmap 差"至少 N+1 倍"（N=子带数）；Mittermayer 给出的形式为 ρ_Scan = ρ_strip·(n_R+1)、T_int,Scan = T_int/(n_R+1)【有据可查，UNSW ANCDF 报告 / DLR Mittermayer 论文】。
- 代价：**scalloping**（回波幅度随目标在 burst 内位置周期起伏，CNR/SNR 随方位变化）是 ScanSAR 的主要缺陷【有据可查，ESA TM-19】。
- TerraSAR-X：ScanSAR 18.5 m / 100 km 幅宽（4 子带）/ 100×150 km，最长 1650 km；Wide ScanSAR 40 m / 270 km（6 子带）/ 270×200 km，最长 1500 km【有据可查，Airbus】。
- ICEYE Scan：15 m / 100×100 km（4 波束，15 s，最长 500 km）；Scan Wide：27 m / 200×300 km（8 波束，42 s，最长 600 km）；两者都已改用 TOPSAR 采集策略以消除 scalloping【有据可查】。

#### 2.3 TOPS（Sentinel-1 的 IW/EW 模式）
- 机制：俯仰切换子带（如 ScanSAR）+ 方位向从后向前电子扫描（backward→forward），让所有目标都被完整天线方向图照射 → 消除 scalloping、SNR/DTAR 均匀【有据可查，eoPortal / EOS】。
- IW：250 km 幅宽 = 3 个子带，5 m(距离) × 20 m(方位) 单视；EW：410 km = 5 个子带，20 × 40 m【有据可查，eoPortal/ASF】。
- burst 时间结构：聚焦后 burst 时长 ≈ **2.75 s**（IW）/ **3.19 s**（EW），burst 重叠 ≈ **0.4 s**（IW），恰好保证方位向地面连续覆盖；SLC 数据以 25 s 切片给出，**每个切片 ~9 个 burst，覆盖 ~250 × 170 km**【有据可查，ESA PolSAR-2013 / SentiWiki】。
- 方位分辨率的来源（关键数字）：IW1/2/3 的**处理带宽仅 327 / 313 / 314 Hz**，对应方位分辨率 22.5 / 22.7 / 22.6 m，入射角 32.9/38.3/43.1°；同一 burst 内多普勒中心漂移 5.2/4.4/4.6 kHz【有据可查，BRIN 汇总表】。用 Vg/B 验算：6.9 km/s ÷ 327 Hz ≈ 21 m ✓【推算】。
- 结论：TOPS 用"方位分辨率 ~4 倍（N=3 子带）"换"距离幅宽 ~3 倍"，与 N+1 规则量级一致【有据可查规则 + 推算】。
- Sentinel-1 为什么没有 spotlight：**方位波束转向范围只有 ±0.9°**（俯仰 −13°~+12.3°）【有据可查，S1 Product Definition】；TOPS 的 backward→forward 扫描刚好在这个权限内，聚束做不到。

#### 2.4 Spotlight（含 Staring/HighRes）
- 机制：方位向相控阵转向、长时间注视同一点以拉长合成孔径；"这导致图像/场景尺寸受限"【有据可查，Airbus】。Capella 同义表述："图像宽度由天线波束尺寸决定"【有据可查】。
- TerraSAR-X：SpotLight 2 m / 10×10 km；HighRes SpotLight 1 m（300 MHz 带宽）/ 5–10 km × 5 km；**Staring SpotLight 0.25 m，场景长度=天线足迹长度：7.5×2.5 km @20° 入射角，4×3.7 km @60°**【有据可查，Airbus】。
- 驻留时间：0.25 m 需要 ≈4 s 连续照射【推算：λR/(2vρ)，与 USU 论文 0.25 m@4.8 s 吻合】；TSX 聚束一次采集成像的 PRF/带宽实例：PRF 3900 Hz、方位带宽 3478 Hz【有据可查，TSX Spotlight InSAR 论文】。
- ICEYE：Spot 1 m（300 MHz）/ 5×5 km，采集 10 s；Spot Fine 0.5 m（600 MHz）/ 15 s；**Dwell 系列用 25 s 超长驻留**，SLC 方位分辨率 0.08 m、12 视多视后 1 m【有据可查】。
- 斜视角（squint）：ICEYE 聚束类允许 **−45° ~ +45°**，入射角 5°–45°（性能区 20°–40°）【有据可查】。

#### 2.5 Sliding Spotlight（滑动聚束）
- 机制：把旋转中心放到地面之下（virtually below the surface），照明点以 V_sweep < V_ground 在地面滑动；"分辨率比 spotlight 低，但方位场景更大"【有据可查，MDPI 2024 综述 / Synspective】。
- 数字：Synspective StriX 滑动聚束 0.9 m（10 km 幅宽 × 10 km 长）与 0.46 m（0.5 m 方位）两档，Staring Spotlight 最细 0.25 m 但场景长仅 3 km【有据可查】；ICEYE SLEA 1 m / 15×15 km（10 s，2 视）【有据可查】；USU 小卫星例子见 §1【有据可查】。
- 处理上需要 deramp/两步法/Baseband Azimuth Scaling 等专门算法（见 §5）。

---

### 3. 为什么条带能连续、聚束只能小块

| 维度 | Stripmap | Spotlight 族 |
|---|---|---|
| 波束 | 固定（随航迹平移） | 主动转向，注视点固定 |
| 单目标驻留 | 足迹穿越时间，约 0.5 s（S1/TSX） | 可长得多：4 s（0.25 m）~25 s（ICEYE Dwell） |
| 方位分辨率决定因素 | 天线长度 L/2（与距离、条带长无关） | 驻留时间 λR/(2vT)（与天线无直接关系） |
| 方位场景极限 | 无几何极限（TSX 1650 km、ICEYE 500 km） | 由天线足迹 + 转向范围决定（TSX ST 最小 3–8 km） |
| 主要系统约束 | 占空比/存储/下行（S1: 25 min/orbit、1400 Gbit、~600 Mbps） | 转向权限（TSX ±0.75°、S1 ±0.9°）+ PRF/模糊 + 数据量 |

- 核心机理一句话：**条带模式里"分辨率"由天线付账（恒定代价），所以长度免费；聚束模式里"分辨率"由驻留时间付账，而驻留时间被"波束必须一直罩住整个场景"限制住，于是场景尺寸被锁死**【有据可查（两厂商原文）+ 综合】。
- 想"高分辨 + 长条带"就只能走中间态 sliding spotlight：牺牲条带覆盖率（A 比例）换分辨率 A·L/2【有据可查 + 推算】。
- 聚束的 PRF 代价：Staring Spotlight 在低 PRF 下 AASR 恶化显著，尤其偏离场景中心的目标（TerraSAR-X Concurrent Imaging 论文）【有据可查】——因为转向把多普勒谱整体搬移，需要更高 PRF 采样，而高 PRF 又压缩可用的距离幅宽（见 §4）。

---

### 4. PRF 与距离/方位模糊权衡（"钻石图"）

- 下界（多普勒别名）：PRF ≥ B_D ≈ 2·Vs/L【有据可查，SAR 链路预算指南（二次文献，公式与教科书一致）】。
- 上界（距离模糊）：PRI ≥ 2·Wr/c + 2τp → PRF ≤ c/(2Wr+2cτp)；再加上**发射遮蔽**（不能边发边收）与**星下点回波遮蔽**（t_nadir mod PRI 不得落入 0~τp 或落在测绘带内）【有据可查】。
- 根本约束（最小天线面积）：W_a > 2λR·PRF·tanθi/c，A_min = 4λRVs·tanθi/c——"想同时要最宽幅宽和最好分辨率，同一个天线做不到"；文献明确说不需要同时满足时可选更小天线【有据可查，IOP 论文 + Wiley/JPL SAR 教材摘录】。这正是宽幅高分（HRWS）多通道研究存在的理由。
- 实测区间：Sentinel-1 PRF 1000–3000 Hz（可编程）；TerraSAR-X 2.0–6.5 kHz；StriX ≤7 kHz；PRF 与模式强相关——同一平台宽幅模式用低频 PRF【有据可查】。
- 模糊实测指标（会直接影响"图像观感"）：ICEYE 全模式 AASR −17 dB、RASR −20 dB；Sentinel-1 分布式目标模糊比（DTAR）要求 −25 dB【有据可查】。
- 注意：同一平台的 PRF/幅宽组合随模式剧烈变化——ICEYE Spot 幅宽 5 km（高 PRF）、Scan Wide 幅宽 200 km（低 PRF、27 m 分辨率）【有据可查】。

---

### 5. 星载（近）实时处理：算法与实机数字

**地面近实时**：Sentinel-1 要求最坏 3 h 内交付（目标 1 h），档案数据 24 h【有据可查，eoPortal】。算法族按模式分工：stripmap/通用用 Range-Doppler、Chirp Scaling（CS）、ω-k；ScanSAR 用 SPECAN；TOPS/滑动聚束用 Baseband Azimuth Scaling（BAS）或 CS+Deramp/两步法【有据可查，DLR Prats BAS 论文、MDPI 2025、DLR EO-ALERT】。

**星上处理（实机演示）**：
- DLR EO-ALERT（Horizon 2020 项目）：TerraSAR-X 原始数据 → Zynq UltraScale+ ZU19EG MPSoC 上实现 **ω-k** 算法（纯 FPGA PL 流水：8k 方位 FFT / 32k 距离 FFT、滤波器逐像素计算、corner turning；4 条并行数据通路，125 MHz 时钟）；一次处理 8192 方位行 × 最多 32768 距离采样（8+8 bit 复数，约 375–500 km²）；**L1 成像平均 3.7 s**；L2 舰船检测 16.0 s、风/海况 30.8 s；全链条（含告警下行）目标 <5 min，留给 SAR 处理 210 s【有据可查】。
- 该报告同时给出 burst 模式的星上路线：**ScanSAR 用 SPECAN、TOPS 用 BAS**，按 burst 逐块聚焦、**不做拼接**（拼接耗内存且非必需）【有据可查】。
- 嵌入式 GPU 路线（中科院，2025）：滑动聚束 42966×27,648 数据在 NVIDIA AGX Orin 上 **19.25 s** 完成成像，而卫星采集耗时 11.43 s → 近实时；算法 = CS + Deramp 预处理（零填充或额外 chirp scaling 二选一，用 MCI 判据选择），同一框架兼容 stripmap 与 TOPSAR【有据可查】。
- 商业公司侧：Capella 靠 GEO 中继做到"近实时任务分配、**每 15 分钟**重新排一次调度"；数据本身仍是"采集→处理→交付"，重访 2–5 h（8 星）/ 重点区 <3 h【有据可查，Capella 技术单页 / eoPortal】。
- 处理算法与我们的对照：Capella 的太空聚束产品**用 Polar Format Algorithm (PFA) 聚焦**，部分场景提供 Back-Projection (BPA) 结果（NASA CSDA 评估中明确写了"多数 Spot 产品用 PFA 处理"）【有据可查】；文献明确指出 BP 精度好但计算量远大于频域算法，星上一般避免（所以我们用多核 BP 属于"原理验证合理、工程上非最优"）【有据可查，MDPI 2025 综述段】。

---

### 6. 多平台数字速查表

| 平台/模式 | 分辨率 | 幅宽/场景 | 采集时长 | 方位驻留 | 入射/斜视角 | PRF |
|---|---|---|---|---|---|---|
| S1 SM（stripmap） | 5×5 m | 80 km | 受 25 min/圈约束 | ~0.5 s【推算】 | 18.3–46.8° | 1–3 kHz |
| S1 IW（TOPS） | 5×20 m | 250 km（3 子带） | burst 2.75 s / 切片 25 s，~9 burst ≈250×170 km | 2.75 s | 29.1–46.0° | ~1–3 kHz |
| S1 EW（TOPS） | 20×40 m | 410 km（5 子带） | burst 3.19 s | 3.19 s | 18.9–47.0° | — |
| TSX StripMap | 3 m | 30 km × ≤1650 km | 最长 ~4 min【推算】 | ~0.47 s【推算】 | 20–45°（可达 15–60°） | 2.0–6.5 kHz |
| TSX ScanSAR / Wide | 18.5 / 40 m | 100 / 270 km | 长度 ≤1650/1500 km | — | 15.6–49° | — |
| TSX SpotLight / HS / Staring | 2 / 1 / 0.25 m | 10×10 / 10×5 / 7.5×2.5(20°)–4×3.7(60°) km | 数秒级 | ~4 s @0.25 m【推算】 | 15–60° | 聚束实例 3.9 kHz |
| Capella Spot / SS / SM | 亚米级（最小距离向 0.3 m） | 聚束=足迹；滑动聚束更长 | — | — | 斜视角可大范围 | — |
| ICEYE Spot / Spot Fine / SLEA | 1 / 0.5 / 1 m | 5×5 / 5×5 / 15×15 km | 10 / 15 / 10 s | 同左 | 5–45°，斜视 ±45° | 高 PRF |
| ICEYE Dwell 系列 | 1 / 0.5 / 0.25 m（SLC 方位 0.08 m） | 5×5 km | 25 s | 25 s | 同上 | 高 PRF |
| ICEYE Strip | 3 m | 30 km × 50–500 km | 10 s（max 70） | ~秒级 | 15–35°（性能区） | 中 |
| ICEYE Scan / Scan Wide | 15 / 27 m | 100×100 / 200×300 km，长 ≤500/600 km | 15 / 42 s（max 70/84） | — | 21–29 / 21–26° | 低 |
| StriX（Synspective） | Strip 2.6 m；SS 0.9/0.5 m；ST ≤0.25 m | 20 km；10×10 km；3 km 长 | Long Strip 16–80 s | — | 15–45° | ≤7 kHz，占空 ≤25% |

俯仰/方位扫描权限：TSX 方位 ±0.75°、俯仰 ±19.2°；S1 方位 ±0.9°、俯仰 −13.0°~+12.3°【有据可查】。
刷新维度：单星重访 12 天（S1，双星 6 天）、TSX 11 天、StriX 1–7 天、Capella 2–5 h（8 星）；无"帧率"概念，替代量是 PRF（1–7 kHz 方位采样）与单次采集时长（10–80 s）【有据可查 + 推算】。Wave 模式是"沿轨每 100 km 一个 20×20 km 快照"的抽样条带。

---

### 7. 对我们仿真的启示（按重要性排序）

我们现状（供对照）：单次采集 **实际轨迹约 2 s** 的 spotlight 式小块（128 m / 512 m / 2048 m 三档瓦片），**多核反投影（BP）** + **PFA** 聚焦，75/150 MHz 带宽，1 m/4 m/16 m 散射单元，30–60° 斜视角、地距 1–50 km，**实波束 MAP 底图** + 世界锚定拼接 + 10 s 前推的瓦片扫掠（"连续采集"），PRF 沿用空空档 200k/20k/2k Hz，无噪声/斑点/模糊/辐射定标。

1. **缺 stripmap 连续条带模式（最重要）**。真实系统（卫星和机载雷达都一样）默认的大面积图像是**条带模式**：波束与航迹固联，图像沿航迹连续滚动、质量沿方位恒定，方位分辨率 ≈ 天线长/2 与距离无关。我们的"512 m 瓦片 + 网格扫掠"本质是 sliding spotlight，画面上必然呈现块状拼接、边缘重复、块间质量跳变。建议：实现一个真正的 stripmap 模式（沿航迹连续发射/连续成像、图像随飞机前进滚动），把瓦片扫掠降级为"定点高分辨"可选档。
2. **分辨率—幅宽—驻留没有耦合，也没有模式概念**。真实里"用户要哪档"就是这套 trade（§6 表）；我们现在任何一档都能"带宽×孔径自由组合"，没有幅宽上限、没有驻留限制、没有 PRF 压力。建议：config 里显式定义 spot/strip（可选 scan）三档，每档绑定 {L 天线、带宽、PRF、驻留、幅宽、分辨率}，HUD 显示"模式/分辨率/幅宽/相干积累脉冲数 = PRF×T_a"，并强制 δ_az ≈ max(A·L/2, λR/(2vT)) 这类约束。
3. **图像"太干净"**：真实 SAR 的观感一半来自噪声与伪影——NESZ 噪声底（S1 −22 dB、ICEYE −18~−21.5 dB、Capella ~−18 dB）、斑点（真实系统靠多视 4–12 视压制；ICEYE Dwell 12 视）、AASR −17 dB 的方位鬼影、RASR −20 dB 的距离模糊、星下点盲区、TOPS/ScanSAR 的 scalloping/burst 边界。我们目前只有 Hann 窗与对比度调节。建议优先加：噪声底 + 斑点统计 + 多视档位 + 简化的 PRF 模糊鬼影（周期错位复制），这些最直接改变"像不像真雷达图"。
4. **聚束场景尺寸应由天线足迹决定，而不是由网格档位决定**。真实 Staring Spotlight 的场景长=足迹（TSX 3–8 km），滑聚的场景长=A·Vg·T_obs。我们的 2048 m 档接近合理量级，但当前"能扫多大就扫多大"没有物理上限。建议把瓦片尺寸与分辨率绑定 A 因子：给"连续扫掠"设 A（例如 0.3–0.5），由 A 推出分辨率与场景长，让拼贴具备真实身份（sliding spotlight 拼条带）。
5. **世界锚定拼接方向正确，但要按 geocoding 的坑来校准**。真实系统靠轨道/姿态数据把图像配准到地理网格（星上产品附带 geo-reference grid），斜距—地距投影在起伏地形上必然有 foreshortening/layover/shadow，多块拼接会出现几何与辐射缝。我们的"世界锚定 + 十字线联动"已经对路，但可以进一步：显示斜距几何→地距投影造成的拉伸、按局部入射角做辐射归一化（β0/γ0），以及拼接处的接缝/重复覆盖提示（真实产品对 burst 重叠区的处理就是专门课题）。
6. **斜视角/几何的强方向性**。真实 SAR 只在侧视 15–60° 内工作、斜视可达 ±45°，地表亮/暗由局部入射角与粗糙度强决定（镜面跑道 vs 植被），并有 layover/shadow。我们 30–60° 已合理，但缺 layover/shadow 和"侧视方向改变图像明暗结构"的显式呈现——机场跑道这种强方向性目标尤其能暴露差别。
7. **PRF/波形体系与 SAR 不匹配**。我们 SAR 复用空空 PRF（2k–200k Hz）；真实星载 1–7 kHz、机载数千 Hz，且高 PRF 直接限制幅宽（钻石图）。如果继续用 HPRF 做 SAR，会得到"距离不模糊、积累脉冲数爆表"的非真实观感。建议 SAR 档单独定义 PRF（几千赫）+ 占空比（TSX stripmap 18%、StriX ≤25%、S1 25 min/orbit）+ 采集时长上限，并在 UI 呈现"本模式受哪个约束"。
8. **处理链的表达（教学价值）**。真实：频域算法（CS/ω-k/SPECAN/BAS）星上流水线分块处理，3.7 s/块（约 375–500 km²）~ 19.25 s/帧（AGX Orin），BP 只是地面可选/校验手段；我们是多核 BP + PFA。原理级仿真保留 BP 合理，但可在界面/日志里呈现"算法与时延"（例如按 CS/ω-k 的分块 FFT 复杂度估个处理时间），让"聚束小块要几秒才能出图"这件事有真实出处【部分推测：具体时延数字应来自我们自己的基准测试】。
9. **对"F-35 显示感"的针对性推测**（无公开材料，标注推测）：机载 SAR 显示的核心是 ① 条带式连续滚动图像叠加在移动地图上；② 定点聚束放大时的"换挡"过程（模式切换、驻留几秒、斑点多视变化）；③ 实波束 MAP 的分辨率随距离线性变差（cross-range = R·θ_az），DBS/SAR 才把它拉平。我们的实波束 MAP 底图若与 SAR 层分辨率随距离的变化方式不一致（MAP 随距离变差、SAR 不变），正好可以对照真实层次感。这一条建议作为下一步校准假设，需要机载 SAR 专项调研确认（可深挖 APG-81 SAR 测绘模式、DBS 与 SAR 的档位关系）。

---

### 8. 来源清单

1. eoPortal Copernicus Sentinel-1（模式/天线/存储/下行/NRT 3 h）：https://www.eoportal.org/satellite-missions/copernicus-sentinel-1
2. ESA Sentinel-1 Product Definition（PRF 1000–3000 Hz、转向权限、天线尺寸）：https://sentiwiki.copernicus.eu/__attachments/1673968/S1-RS-MDA-52-7440 - Sentinel-1 Product Definition 2016 - 2.7.pdf
3. ESA PolSAR-2013 Sentinel-1 Mission Overview（burst 2.75 s、~9 burst、250×170 km、EW 子带）：https://earth.esa.int/eogateway/documents/20142/37627/PolSAR-2013-Sentinel-1-System-Data.pdf
4. SentiWiki S1 Processing（IW burst 2.75 s / 重叠 0.4 s，EW 3.19 s）：https://sentiwiki.copernicus.eu/web/s1-processing
5. NASA Earthdata / ASF Sentinel-1（IW/EW/SM/WV 指标）：https://www.earthdata.nasa.gov/data/platforms/space-based-platforms/sentinel-1
6. Airbus TerraSAR-X Image Product Guide（模式表、Staring Spotlight 足迹场景、1650 km）：https://airbusus.com/wp-content/uploads/2020/06/r459_9_20171004_tsxx-airbusds-ma-0009_tsx-productguide_i2.01.pdf
7. eoPortal TerraSAR-X（天线 4.8×0.8 m、±0.75°/±19.2°、占空 18%）：https://www.eoportal.org/satellite-missions/terrasar-x
8. TerraSAR-X PRF 2.0–6.5 kHz 与系统参数（学位论文 PDF）：https://opac.ll.chiba-u.jp/da/curator/900118704/YAA_0009.pdf
9. ICEYE Product Documentation – Imaging Modes（9 模式全表、时长、斜视角、模糊比）：https://iceye-ltd.github.io/product-documentation/6.0.7/productspecification/imagingmodes/
10. Capella 支持页 – Collect Modes（机制原文）：https://support.capellaspace.com/what-are-capellas-collect-modes
11. Capella Technical SAR Data Brief（15 min 调度、GEO 中继）：https://cdn.prod.website-files.com/6970b8a0eb7e9ae5e1a148f0/69f896cb4081d83a0d6e0773_1a982f94ee08336d1ad05db7cc5fd62c_Capella_Tech%20Spec_OnePager-DIGITAL_260112.PDF.pdf
12. NASA CSDA Capella Quality Assessment（PFA/BPA、NESZ ~−18 dB、定标差异）：https://ntrs.nasa.gov/api/citations/20250006492/downloads/CSDA%20Capella%20Quality%20Assessment%20SME_final.pdf
13. eoPortal Capella X-SAR（重访 2–5 h/8 星、最小斜距分辨率 0.3 m）：https://www.eoportal.org/satellite-missions/capella-x-sar
14. Synspective StriX Product Guide v18（PRF ≤7 kHz、占空 ≤25%、ST/SS 数字）：https://synspective.com/wp-content/uploads/2026/04/SAR-Data-Product-Guide_EN_v18.0_general_users.pdf
15. DLR EO-ALERT 星上处理链（ω-k、Zynq、3.7 s、SPECAN/BAS 路线）：https://elib.dlr.de/188283/1/SO6P1P_DLR_Demonstrating_a_SAR_Satellite_Onboard_Processing-Breit-Helko.pdf
16. MDPI Remote Sensing 2025, 17(9):1495（AGX Orin 滑动聚束 19.25 s vs 采集 11.43 s）：https://www.mdpi.com/2072-4292/17/9/1495
17. DLR Prats 等 – Baseband Azimuth Scaling（TOPS/滑动聚束处理器）：https://elib.dlr.de/59115/1/prats_TGRS2010_baseband_azimuth_scaling.pdf
18. MDPI Remote Sensing 2024, 17(1):38（聚束/滑聚综述，旋转中心与场景/分辨率关系）：https://www.mdpi.com/2072-4292/17/1/38
19. USU SmallSat 论文（滑聚 A=0.1 → 0.25 m、驻留 4.8 s、V_sweep 0.75 km/s）：https://digitalcommons.usu.edu/cgi/viewcontent.cgi?article=5216&context=smallsat
20. UNSW ANCDF SAR 报告（ScanSAR 分辨率 ≥N+1 倍退化）：https://www.unsw.edu.au/content/dam/pdfs/unsw-canberra/space/2025-12-ancdf/2026-03-UNSW-ANCDF-023-R04-ANCDF_BOM_SAR_Pre_Phase_A_Report_FINALcompressed.pdf
21. DLR Mittermayer – Bidirectional SAR（ρ_Scan=(n_R+1)·ρ_strip、T_int 缩短）：https://elib.dlr.de/76066/1/Mittermayer.pdf
22. ESA InSAR TM-19（ScanSAR scalloping 机制）：https://www.esa.int/esapub/tm/tm19/TM-19_ptC.pdf
23. IOP 会议论文（最小天线面积 A_min = 4λRVs·tanθi/c）：https://iopscience.iop.org/article/10.1088/1757-899X/1172/1/012013/pdf
24. Wiley/JPL《Synthetic Aperture Radar Polarimetry》摘录（PRF 与幅宽的教科书式权衡）：https://catalogimages.wiley.com/images/db/pdf/9781118115114.excerpt.pdf
25. SAR Link Budget 指南（PRF 钻石图、NESZ 推导、RAR vs SAR 分辨率）：https://github.com/m0bien/sar-link-budget/blob/main/README.md
26. BRIN 汇总表（S1 IW1/2/3 处理带宽 327/313/314 Hz、方位分辨 22.5 m 等）：https://ejournal.brin.go.id/ijreses/article/download/13861/10779/40260
27. DLR Concurrent Imaging for TerraSAR-X（Staring Spotlight 低 PRF 下 AASR 恶化）：https://elib.dlr.de/145875/1/Concurrent_Imaging_for_TerraSAR-X_Wide-Area_Imaging_paired_with_High-Resolution_Capabilities.pdf
28. 星上 SAR 处理综述（IEEE JSTARS 2024, Parra Garcia 等）：https://strathprints.strath.ac.uk/89263/7/Parra-Garcia-etal-IEEE-JSTAEORS-2024-Advancements-in-on-board-processing.pdf
29. rfessentials – DBS 词条（实波束 MAP 分辨率 = R×波束宽度，随距离增长）：https://rfessentials.com/resources/rf-glossary/dbs/
30. Sentinel-1 HLOP（25 min/orbit 占空规则）：https://sentiwiki.copernicus.eu/__attachments/1673407/COPE-S1OP-EOPG-PL-15-0020 - Sentinel HLOP 2021 - 3.1.pdf

**本调研的空白与不确定性**：① Sentinel-1 IW 的方位分辨率为何设计成 20 m（处理带宽 327 Hz 的完整设计推导）未找到官方逐步推导，我只找到"处理带宽→分辨率"的观测值，N+1 规则来自二次来源；② Capella 的完整模式指标表（含 look angle 范围）只在 NASA CSDA 表格中部分截取到，未逐项获取；③ 机载/F-35 的 SAR 与实波束 MAP 参数无权威公开数字，§7.9 全为推测，需要单独的机载 SAR 专项调研。

## 3. SAR 成像几何物理约束 — 调研笔记

面向：DCS「原理级 SAR 仿真」校准。标注约定：**【可查】**=有公开出处（链接附后）；**【二手】**=行业/社区长文、贸易数据库等，细节可信但非一手；**【推测】**=本笔记的推断，无直接出处。

---

### 0. 摘要（先回答你点名的两个问题）

**① 战斗机对正前方扇区实际用什么手段成像？**
雷达层面，正前方只有**粗成像/非成像**手段：增强实波束地图（real beam map，靠 monopulse 在"机头方向"做有限锐化）、地形跟随雷达（TFR，输出距离-高度剖面而非图像）；真正的雷达"成像"（DBS/SAR）都在**斜视区**做（离轴 >10°，战术上 45° 偏轴最优）；正前方的高质量"图像"实际由 **EO/IR 吊舱（FLIR）**提供。死前向的 Doppler beam sharpening 有专利方案（monopulse 和/差通道，可达约 10:1），但锐化能力随角度快速改善，正前方是最差点。【可查 + 二手】

**② 画质随斜视角怎么退化？**
以"离航迹（速度矢量）方向"计：0–15° 基本不可用（多普勒梯度 df/dθ=(2v/λ)·sinθ→0，且左右模糊）；15–30° 很弱；**30–70° 是 DBS/SAR 的主工作带**（DBS 锐化比在此带从 ~3:1 增到 ~60:1）；接近 90°（正侧视）物理上最好。战斗机受 **±60° 电扫锥**限制，不转弯时可达的斜视带上限约 60°（离机头），即无法做"正侧视 SAR"，战术上用"偏离目标 45° 航线"来优化——这是 F-15E 公开战术描述里明确写的。【可查 + 二手 + 推导】

---

### 1. 为什么正前视先天不行：多普勒梯度简并 + 左右模糊

- **多普勒-角度关系**：目标多普勒 f_D=(2v/λ)·cosθ（θ=视线与速度矢量夹角）。方位分辨率增益来自梯度 **df/dθ=(2v/λ)·sinθ**；θ→0（正前方）时梯度→0，波束内所有方位点的多普勒重合，方位维不可分辨。DBS 分辨率公式 δcr≈λR/(2·v·T·sinθ)，即越靠近机头越差（∝1/sinθ）。【可查】[RF Essentials DBS 术语页](https://rfessentials.com/resources/rf-glossary/dbs/)
- **左右模糊（left/right ambiguity）**：单站体制下，航迹两侧对称目标的距离历程与多普勒完全相同，无法区分。这是与梯度简并并列的第二个"先天"缺陷。【可查·学术】[IGARSS 2010 Wang/Loffeld（双基地前视 SAR）](https://vigir.missouri.edu/~gdesouza/Research/Conference_CDs/IGARSS_2010/pdfs/4106.pdf)；[Sensors 2020 FDA 前视 SAR 论文](https://pmc.ncbi.nlm.nih.gov/articles/PMC7070757/)（"ground targets distributed in front of the flight trajectory have a small Doppler change rate, which will result in low azimuth resolution"）
- **经典的"不可能"表述**（Westinghouse 专利背景段原文）：常规 SAR 无法在速度矢量方向做波束锐化，"天线指向该方向时无法把速度矢量两侧同距离同多普勒的点分开"。该专利（**EP0434064A2，"SAR with dead-ahead beam sharpening capability"**）给出了解决方案——见 §3.2。【可查·专利】[EP0434064A2](https://data.epo.org/publication-server/rest/v1.2/patents/EP0434064NWA2/document.pdf)
- **盲锥定量**：
  - "blind cone of roughly ±10 to 15° ahead of the aircraft"。【可查·厂商术语页】[RF Essentials](https://rfessentials.com/resources/rf-glossary/dbs/)
  - "DBS is ineffective within about 15 degrees of track"（引 Skolnik《Radar Handbook》3rd ed. p.17.2f 与 Tait 2005）。【二手·教科书转述】[Radartutorial DBS](https://www.radartutorial.eu/20.airborne/ab05.en.html)
  - 战斗机 SAR 资料："beam transmitted at a reasonable angle (**larger than 10 degrees off the aircraft's axis**)"才能成图。【二手】[Air Power Australia: F-15E](https://www.ausairpower.net/TE-F-15E-Strike-Eagle.html)
- **端射（endfire）特殊效应**：正前视合成阵等效为端射阵，方位分辨率 ∝ √(λ/2L)（而非侧视的 λL/2 关系），50–500 m 合成孔径对应 5–15 mrad。同样孔径下比侧视差得多。【可查·专利】

---

### 2. 斜视 SAR 的可用斜视角范围（先分清两种"斜视角"）

⚠️ 两种常见约定，混用会错 90°：
- **从正侧视/零多普勒面量**（卫星产品文档、学术用）：0°=正侧视，90°=正前/正后。
- **从机头/航迹量**（机载雷达习惯）：0°=正前，90°=正侧视。换算：离机头角 = 90° − 离正侧视角。

#### 2.1 从正侧视量（运营系统实际保证的范围）

| 系统 | 可用/保证斜视范围 | 备注 | 来源 |
|---|---|---|---|
| ICEYE（卫星，产品规格保证值） | **±45°**（Spot/Spot Fine/Dwell 全模式） | 1 m / 0.5 m 地距分辨率下仍满足规格；单次采集 10–25 s | [ICEYE 文档](https://iceye-ltd.github.io/product-documentation/6.0.2/productspecification/imagingmodes/) |
| Umbra（卫星，推荐值） | **±45°–±70° 为最优档**（另有 ±110–135° 档） | 文档明确"超出最优斜视范围会退化" | [Umbra 文档](https://docs.canopy.umbra.space/docs/advanced-parameters) |
| 历史机载（战术原因） | **曾用到 60°** | "airborne systems applied squint angles up to 60 degrees for tactical safety reasons" | [Thiele 博士论文/Uni-Hannover](https://www.ipi.uni-hannover.de/fileadmin/ipi/publications/2013_Thiele.pdf) |
| 学术"高斜视"（high squint） | >45° 归类为高斜视，处理需专门算法 | 斜视引入距离-方位强耦合、大 range walk，传统 RD/CS 算法失焦 | 【可查】[Davidson & Cumming 1996, UBC](https://sar.ece.ubc.ca/papers/Davidson Cumming Ito_1996.pdf)；[QMUL 2024 高斜视滑聚](https://qmro.qmul.ac.uk/xmlui/bitstream/handle/123456789/96459/Liu High-Squinted Spaceborne 2024 Accepted.pdf?sequence=2&isAllowed=y) |

#### 2.2 从机头量（战斗机雷达习惯）

- DBS 模式典型工作带：**30–70° 离机头**（"deliberate squint"），盲区 ±10–15°。【可查·术语页】[RF Essentials](https://rfessentials.com/resources/rf-glossary/dbs/)
- 战斗机 AESA 电扫锥约 **±60°**（我们项目自己也按此建模）：不改变航向时，波束可达的斜视带=[30°, 60°]（离机头）→ 能覆盖 DBS 主带，但**够不到正侧视**。要接近正侧视必须转机头/斜飞（F-15E 战术描述："maintain at 45 degrees off the aircraft's axis for optimal SAR performance"）。【二手 + 推导】[Air Power Australia](https://www.ausairpower.net/TE-F-15E-Strike-Eagle.html)
- 综合两约定的一致图像：**物理甜蜜区 ≈ 20–70° 离机头；硬盲区 ≈ ±10–15° 贴航迹；战斗机实用带 ≈ 30–60° 离机头**。

#### 2.3 斜视的代价（为什么不是"越斜越好"或"随便选"）

- 斜视↑ → range walk/距离-方位耦合↑ → 需要二级距离压缩（SRC）等专门处理，高斜视需频域/时域高次项校正。【可查】UBC/QMUL 文献（上表）
- 斜视↑ → 同一地距的斜距变长（R/cos 分量）→ R⁴ 信噪比损失、遮蔽/入射角恶化（卫星产品要求入射角 20–40° 才保证性能）。【可查】[ICEYE 文档](https://iceye-ltd.github.io/product-documentation/6.0.2/productspecification/imagingmodes/)
- 斜视↑ → 多普勒中心大、多普勒带宽大 → PRF/模糊设计压力大。【可查】同 ICEYE/学术
- 双基地前视还有额外的距离分辨率退化案例（"range resolution is extremely degraded in some cases in forward bistatic SAR imaging"）。【可查】[Li et al., Remote Sensing 2018](https://www.mdpi.com/2072-4292/10/11/1676)

---

### 3. 前视 SAR：学术界/工业界有什么方案

#### 3.1 双基地前视 SAR（BFLSAR）— 最主流学术路线

- **原理**：发射机侧视（多普勒梯度充足），接收机前视（目标在接收机正前方）；双站距离历程中发射机贡献恢复了沿航向的可分辨性，原理上可实现前视成像。【可查】[IGARSS 2010 Wang et al.](https://vigir.missouri.edu/~gdesouza/Research/Conference_CDs/IGARSS_2010/pdfs/4106.pdf)；[Krieger et al. 2003, DLR](https://elib.dlr.de/6155/1/154_Krieger.pdf)（"high resolution forward-looking radar for airborne systems, where one or several stationary transmitters... are combined with a passive SAR receiver"）
- **代价/遗留问题**：接收机侧仍存在左右模糊与距离-方位耦合，需要扩展 RD/Omega-K 等专门算法；系统复杂、需时间/相位同步。【可查】同上
- **实验验证**（有外场试验，不是纯理论）：
  - Balke 2005（FGAN/FHR）"Field test of bistatic forward-looking SAR"（IEEE Radar Conf. 2005, pp.424–429）。【可查·文献条目】[PIER 引用列表](https://www.jpier.org/issues/volume.html?paper=14040501)
  - Walterscheid 等 EUSAR 2010：TerraSAR-X 照射 + 机载接收机前视成像（跑道目标）——星-机双基地前视实测。【可查·文献条目】[电子科技大学学报综述引用](https://www.juestc.uestc.edu.cn/cn/article/pdf/preview/25.pdf)
  - 算法研究给出 m 级双站前视分辨率案例（如 1.5 m 距离 / 1.76 m 方位，仿真）。【可查】[Ma et al., PIER 2014](https://www.jpier.org/ac_api/download.php?id=14031706)

#### 3.2 阵列/多通道前视（单平台）

- **Monopulse 死前向锐化**（西屋专利，已授权思路）：方位单脉冲和/差双通道 + 双 SAR 处理器 + 加权组合，先分离速度矢量两侧的同多普勒回波，再做 DBS。指标：正前方可得 **10:1 或更好**的无模糊 DBS 地图；λ=3 cm、L=50–500 m 时分辨率 5–15 mrad；等效阵时长 0.3–3 s（Mach 0.5 级）；"正前方提升 3–10 倍，偏离后迅速改善"。运动补偿仍在可管理范围。【可查·专利】[EP0434064A2](https://data.epo.org/publication-server/rest/v1.2/patents/EP0434064NWA2/document.pdf)
- **多通道/阵列信号处理**：平面相控阵 + 传播算子类方法做机载前视成像（解决左右模糊与低多普勒梯度）。【可查·摘要】[IET RSN 2024](https://ietresearch.onlinelibrary.wiley.com/doi/10.1049/rsn2.12552)（我们未能抓到全文，只有摘要级证据）
- **FDA（频率分集阵）**：给发射阵加小频偏，构造"距离-角度"依赖波束，可在空频域分离距离模糊回波并用接收波束形成解左右模糊；仿真前视成像方位分辨率约 0.10–0.15°（几 km 距离）。仍属研究阶段。【可查·论文+仿真】[Sensors 2020](https://pmc.ncbi.nlm.nih.gov/articles/PMC7070757/)
- **汽车毫米波 MIMO 前视成像**（工业界近距前视已量产）：用 MIMO 虚拟孔径替代多普勒，角分辨率 ∝ λ/(N·d·cosθ)；这是"纯阵列前视"在近距的产业化先例（距离几百米内）。【可查】[Distributed MIMO 前视成像, Remote Sensing 2024](https://www.mdpi.com/2072-4292/16/21/3991)

#### 3.3 Video SAR（视频 SAR）

- 定义：把 SAR 做成连续图像序列（短子孔径滚动成像），用于持续监视/动目标跟踪。帧率与分辨率要求：跟踪地面动目标"帧率至少 **5 Hz**、分辨率至少 **0.2 m**"。【可查·期刊】[Generalized PFA for Airborne Video SAR, Remote Sensing 2023](https://www.mdpi.com/2072-4292/15/11/2807)（镜像 PDF 含该引文：[USST](https://thz.usst.edu.cn/_upload/article/files/ea/c6/ff3b92e84d6bbd222e88bd689edd/19b3d72e-1100-4ca9-91d5-fae1fc2e0e9a.pdf)）
- 起源是 Sandia/GA 的 Ku 波段 Lynx（I-GNAT 无人机，<0.1 m 分辨率级）一类机载系统；现已有星载 SAR 视频产品（ICEYE Dwell → SAR Video，25 s 采集）。【可查】[METU 会议表](http://aiac.ae.metu.edu.tr/paper.php/AIAC-2013-024)；[ICEYE 文档](https://iceye-ltd.github.io/product-documentation/6.0.2/productspecification/imagingmodes/)
- 注意权衡：每一帧只用很短子孔径 → 单帧分辨率/信噪比低于全孔径 SAR；这正是"帧率↔分辨率"的取舍。【可查】[arXiv 2401.10252](https://arxiv.org/pdf/2401.10252v1.pdf)

#### 3.4 其它

- **弯曲航迹 SAR（CF-SAR）**：通过自主调整飞行轨迹与波束实现前视成像。【可查·摘要】[Remote Sensing 2022](https://www.mdpi.com/2072-4292/14/13/2983)。代价是要求平台机动（对战斗机隐蔽/任务剖面不友好）。
- **非相干合成**：牺牲分辨率增益，换取对航迹/姿态误差的低敏感度。【可查】[Springer 章节](https://link.springer.com/chapter/10.1007/0-306-47108-6_1)
- 【推测】到目前为止**没有公开证据表明任何现役战斗机雷达部署了纯前视 SAR 模式**；能查到的前视成像都是双基地试验、阵列研究、视频 SAR（侧视滚动）与死前向 monopulse 增强实波束这类"有限度"手段。

---

### 4. DBS 死区与"正前方到底怎么办"（含可查数字）

#### 4.1 DBS 死区与锐化比（数字）

| 事实 | 数字 | 来源 |
|---|---|---|
| 死区/无效区 | 贴航迹 ±10–15°（DBS 盲锥）；<30° 离机头不宜；"within about 15° of track ineffective" | [RF Essentials](https://rfessentials.com/resources/rf-glossary/dbs/)、[Radartutorial](https://www.radartutorial.eu/20.airborne/ab05.en.html) |
| 典型锐化比 | 10:1–60:1（对实波束）；战斗机天线 40 cm → 波束约 4°，DBS 单元约 0.5° | 同上 |
| 装载机（F-15/F-22 家族，公开贸易资料） | DBS1 **8:1**（地图尺度 10/20/40 nm），DBS2 **64:1** | 【二手】[Forecast International APG-77(V) 归档](https://www.forecastinternational.com/archive/disp_pdf.cfm?DACH_RECNO=944) |
| 计算例 | 10 GHz、v=200 m/s、T=0.1 s、45°、30 km → 方位单元约 **32 m**（对 525 m 实波束 ≈16:1） | 【可查·术语页】[RF Essentials](https://rfessentials.com/resources/rf-glossary/dbs/) |
| 死前向（专利方案） | 正前方 10:1、3–10 倍改善且"偏离后迅速改善"；分辨率 5–15 mrad | 【可查·专利】[EP0434064A2](https://data.epo.org/publication-server/rest/v1.2/patents/EP0434064NWA2/document.pdf) |

#### 4.2 F-15E / APG-70 的实锤数字（SAR patch 模式）

来源为 1980 年代风格的长文技术分析（【二手】，但与公开手册一致度高）[Air Power Australia: F-15E](https://www.ausairpower.net/TE-F-15E-Strike-Eagle.html)：

- HRM（合成孔径高分辨率地图）patch 表：**0.67×0.67 nm / 8.5 ft 分辨率 / 10 nm 最大距离**；1.3 nm→17 ft；3.3 nm→42 ft；4.7 nm→59 ft（80 nm）；10 nm→127 ft（160 nm）。即：分辨率/幅宽/距离三者强耦合，**分辨率越高、patch 越小、距离越近**。
- 战术：进场时**偏离目标航线约 45°**、50 nm 处 pop-up，**3–7 s 俯冲露头让波束驻留成图**；SAR 只生成"immediate target area"的 patch，处理需要"若干秒"，成图后**冻结（freeze）**供 WSO 找目标。
- 掠射角可低到 **0.5°**（1000 ft 高度 / 20 nm），即贴地平飞侧视照射。
- 过渡模式：APG-63 的实波束 + DBS 分辨率被限制在"**约 50 ft**"量级；APG-77 级（AESA）增强实波束地图在 **80 nm** 内成图（monopulse 锐化，正前方也有效），"扩展地图 4:1"。

#### 4.3 正前方扇区的手段汇总（答"实际用什么"）

| 手段 | 覆盖扇区 | 输出形态 | 依据 |
|---|---|---|---|
| 增强实波束地图 RBM（+monopulse，可对正前/离轴硬目标锐化） | 含正前方 | 粗地图（数十 m 级以下）：APG-63 家族 ~50 ft 级 | [Forecast International](https://www.forecastinternational.com/archive/disp_pdf.cfm?DACH_RECNO=944)、[APA](https://www.ausairpower.net/TE-F-15E-Strike-Eagle.html) |
| DBS（斜视） | 30–70° 离机头 | 10–60:1 锐化地图，近实时扫描 | [RF Essentials](https://rfessentials.com/resources/rf-glossary/dbs/)、[Forecast](https://www.forecastinternational.com/archive/disp_pdf.cfm?DACH_RECNO=944) |
| SAR spotlight/patch（斜视） | >10° 离轴（战术 45°） | 0.67–10 nm patch，8.5–127 ft 分辨率，冻结快照 | [APA](https://www.ausairpower.net/TE-F-15E-Strike-Eagle.html) |
| 死前向 DBS（monopulse） | 正前方（专利/研究） | 10:1、5–15 mrad | [EP0434064A2](https://data.epo.org/publication-server/rest/v1.2/patents/EP0434064NWA2/document.pdf) |
| TFR 地形跟随（LANTIRN 导航吊舱；苏/欧机型也有） | 正前方 | 距离-高度剖面（非图像），控制剖面输出 | [APA](https://www.ausairpower.net/TE-F-15E-Strike-Eagle.html) |
| FLIR/EO 吊舱（LANTIRN AAQ-14、Sniper/Litening 等） | 正前方 | 真正的正前"图像"（红外/电视） | 同上 |
| Video SAR / GMTI（吊舱/ISR 平台） | 侧视滚动，持续监视 | ≥5 Hz 序列 | [Remote Sensing 2023](https://www.mdpi.com/2072-4292/15/11/2807) |

#### 4.4 F-35 / AN/APG-81（公开数据非常有限）

- 官方口径仅到："**ultra-high-resolution Synthetic Aperture Radar (SAR) mapping mode**"，无任何分辨率/幅宽数字。【可查·官方】[Northrop Grumman APG-81](https://www.northropgrumman.com/what-we-do/mission-solutions/radars/an-apg-81-active-electronically-scanned-array-aesa-fire-control)
- 2005 年项目描述："SAR terrain mapping function for air-to-surface surveillance and targeting"。【可查】[Avionics Today 2005](https://www.aviationtoday.com/2005/10/01/f-35-integrated-sensor-suite-lethal-combination/)
- 【推测】F-35 的"正前扇区成像"任务同样由雷达斜视 map + EOTS/EO 传感器分工承担；**不要**基于"F-35=SAR 全向"的任何想象做仿真——公开资料不支持。
- 可横向参考：F-16 换装 APG-83 (SABR) 的官方描述也只是"high-resolution SAR maps / large surface image"。【可查】[Northrop SABR 新闻稿转述](https://www.militaryaerospace.com/commercial-aerospace/article/14232330/northrop-grummans-sabr-radar-goes-agile)

---

### 5. 运动补偿与 INS/GPS 精度要求

- **相干成相基本要求**：脉冲间到场景参考点的距离测量误差须小于波长的"一个小的分数"——X 波段（λ≈3 cm）意味着**毫米级往返路径**精度；否则相位不对齐、图像散焦。【可查】[John Gentile SAR 笔记](https://john-gentile.com/kb/dsp/Radar.html)（"a 'small fraction' means millimeters of round-trip path"）；教科书同源（[Introduction to SAR using Python and MATLAB](https://dokumen.pub/introduction-to-synthetic-aperture-radar-using-python-and-matlab-163081864x-9781630818647.html)：pulse-to-pulse relative range error 须小于波长分数）
- **F-15E 的工程细节**：SAR 成像期间 **INS 以 6 倍速率给出位置更新**。【二手】[APA](https://www.ausairpower.net/TE-F-15E-Strike-Eagle.html)
- **Sandia/Doerry（相干变化检测应用）**：平飞时斜视角变化应 **<2°**（"Squint angle differences should be less than 2 degrees in straight and level flight"），超出需飞行员/GPS 制导协助。【可查·报告摘要片段】[OSTI SAND2008-0911C](https://www.osti.gov/biblio/1146354)
- **典型航空摄影/SAR 用 GNSS-INS 的规格量级**（POS AV 610，官方数据表）：后处理 RMS：**XY 0.02 m / Z 0.05 m / 速度 0.005 m/s / 横滚俯仰 0.0025° / 真航向 0.005°**；实时约 0.015°/0.03°，输出率最高 200 Hz。【可查·厂商】[POS AV 610 数据表](https://assets.ctfassets.net/9k5dj5b59lqq/3zotCXoNKxMTrFYkutzYS2/bdf0afe7163f93e1da4c1f4def2a64c7/POS_AV_610.pdf)、[规格汇总页](https://www.jgc.gr/products/applanix/air/pos-av/?lang=en)
- **精度要求的"分工"**：DBS 只做短驻留、对导航误差**容忍度高**；SAR（尤其聚束）依赖精密运动补偿+自聚焦（PGA/SBAC 类）作为兜底。【可查】[RF Essentials](https://rfessentials.com/resources/rf-glossary/dbs/)、[Gentile](https://john-gentile.com/kb/dsp/Radar.html)

---

### 6. 合成孔径时间 ↔ 横向分辨率（公式与硬数字）

- **公式**（k 空间直观）：ρ_r = c/(2B)；**ρ_a = λ/(2Δθ)**，Δθ=平台扫过的角度孔径。【可查】[Gentile](https://john-gentile.com/kb/dsp/Radar.html)
- 等效合成孔径长度 L：ρ_a ≈ Rλ/(2L)；对应时间 **T ≈ L/v**（v 为速度）。【可查】[Chalmers 学位论文](https://publications.lib.chalmers.se/records/fulltext/248665/248665.pdf)
- **DBS 版本**：δcr ≈ λR/(2·v·T·sinθ)（短驻留 T≈波束驻留时间）。【可查】[RF Essentials](https://rfessentials.com/resources/rf-glossary/dbs/)
- **硬数字锚点**：
  - ICEYE：Spot 采集 **10 s** → 1 m 地距分辨率（斜距方位 0.25 m）；Dwell **25 s** → 0.5 m（斜距方位 0.05 m）。时间↔分辨率强对应。【可查】[ICEYE](https://iceye-ltd.github.io/product-documentation/6.0.2/productspecification/imagingmodes/)
  - Gentile 示例：9.65 GHz、200 MHz、0.79 s 子孔径 → 0.75 m(距离)×1.65 m(横向)。【可查】[Gentile](https://john-gentile.com/kb/dsp/Radar.html)
  - 死前向专利：合成阵 0.3–3 s → 5–15 mrad。【可查·专利】
  - F-15E：3–7 s 露头驻留 → 8.5 ft@0.67 nm patch。【二手】
  - Video SAR：每帧亚秒级子孔径 → 帧率高但单帧分辨率受限。【可查】[arXiv 2401.10252](https://arxiv.org/pdf/2401.10252v1.pdf)
- **注意**：上表"横向分辨率"均为**斜距平面**或方位角单元；换算到地距还要除入射/斜视角的投影因子。

---

### 7. 画质随斜视角的退化规律（综合汇表，含推断）

| 离机头角 | 多普勒梯度 sinθ | 可用性 | 真实系统对应 | 备注 |
|---|---|---|---|---|
| 0–10° | 0–0.17 | 单站方位不可分辨（盲锥） | RBM+monopulse 粗图 / TFR / FLIR；专利死前向 DBS 10:1【可查】 | 左右模糊必须用双通道/双基地解决 |
| 10–30° | 0.17–0.5 | 很差 | 系统一般不在此做 SAR/DBS | 专利："偏离后迅速改善" |
| 30–45° | 0.5–0.7 | 好 | DBS 主带；F-15E 45° 最优战术；我们原型默认 45°【可查+二手】 | 战斗机电扫锥内的实用带 |
| 45–60°（离机头） | 0.7–0.87 | 很好 | DBS2 64:1 区；电扫锥上限 | 需要好运动补偿 |
| 60–90°（离机头） | 0.87–1 | 物理最优（梯度最大） | 卫星 SAR 甜区（Umbra 最优 ±45–70° 离正侧视）；战斗机需转向补偿 | 宽带多普勒 → PRF/模糊与处理压力 |
| >90°（后斜视） | 对称 | 与前半面对称 | 可用于前视受威胁时绕后 | — |

【推测】综合以上：**"画质-斜视角"曲线近似 ∝sinθ 在 0–30° 段急剧爬升、30–70° 段进入平台、70–90° 段最优但受系统带宽/PRF 限制**；运营系统用"保证角度范围"（±45°）或"最优角度窗口"（±45–70°）把这条曲线截成规格。

---

### 8. 对我们仿真的启示（按重要性排序）

当前实现（对照 `aesa/docs/design-sar-prototype.md`、`sar-in-mission.md`、`theory-notes.md`）：世界坐标锚定的斜视小块（128–512 m）、2 s 轨迹、互相关 BP + PFA、实波束 MAP 底图、连续采集/拼接；几何门控已把相对航迹角限制在 20–160°，扫掠选块 30–60°。以下为与真实系统的差距：

1. **正前方"能看"是最大的失真源（优先级最高）**。真实单站雷达在贴航迹 ±10–15° 内物理上无法做 SAR/DBS（多普勒简并 + 左右模糊）。我们的连续模式门控（20–160°）已经拦住 20° 以内，但：a) 没有把"为什么拦"变成用户可见的物理反馈（应显示梯度/预期分辨率而非只 skip）；b) 未建模**左右模糊幽灵**（对称镜像目标）——一旦用户把场景放到正前方附近或大方位副瓣处，真实图像会出现镜像鬼影，我们没有；c) 45° 默认值恰好在真实战术最优带内，这点是对的，值得在 UI 里说明"这不是随意的默认"。
2. **显示/交互语义不像座舱雷达**。真机是"驻留→数秒处理→冻结快照"（APG-70；freeze 还会停发射），地图有固定 scale（10/20/40 nm/扩展档）、黑白灰度、以 patch 为中心；我们是"连续 500 ms 排队、~7 s 一张、世界锚定无缝拼接图"。拼接图更像侦察图像产品，不是雷达显示。建议：拆分"座舱式快照视图"与"拼接侦察图"两种显示；后者已是我们的强项，前者才是用户对比 F-35 视频时的直觉来源。
3. **几何-画质耦合没有显式建模成"规格"**。真实系统把分辨率/幅宽/距离/斜视角绑成产品规格（APG-70：0.67 nm@8.5 ft@10 nm；DBS 8:1/64:1；ICEYE ±45° 保证 1 m）。我们的"standard/fine"是波形档（75/150 MHz），没有按斜视角/距离声明"本张图的等效分辨率"，也没有像真实雷达那样禁止/警告某些几何。建议输出每张图的等效栅格与"该几何下的理论方位分辨率"（λ/(2Δθ·sinθ)），让用户看到 30° vs 60° 的差别。
4. **运动补偿用"完美真值"，图像过于理想**。真实 X 波段相干要求毫米级路径精度、INS/GNSS 后处理 0.02 m/0.005° 级；我们直接使用 DCS 真值位置 = 零残余运动误差。选项化注入 INS 漂移/GPS 抖动（以及 PGA 自聚焦开关）才能复现"真实 SAR 有时糊、有振铃"的观感；DBS 容忍误差、SAR 不容忍的对比也可以借此体现。
5. **正前扇区缺少"替代手段"的表达**。真实战斗机正前方给的是 RBM（粗）+ 增强实波束、TFR 剖面、FLIR 图像；如果目标体验是"正前方也能像 SAR 一样清晰"，任何增加分辨率的路都是死路。建议（按实现成本）：a) 正前扇区显示为粗实波束 MAP（我们已有底图）并显式标注不可 SAR；b) 可选 TFR 样式剖面线；c) 若坚持要"前视成像"，标注为研究模式并注明其为双基地/阵列方案（我们无法在单机 DCS 里复现双基地）。
6. **刷新率与成像时间的表达**。真机 patch 循环 = 露头 3–7 s + 处理数秒 + 冻结查看（十秒级循环）；video SAR 是 5 Hz 牺牲单帧分辨率；我们目前"2 s 采集 + 最多 ~4.6 s 计算 + 500 ms 间隔 ≈7 s/张"其实**接近真机 patch 节奏**——建议明确写成"patch 周期"并在连续模式里加"保持上一张/冻结"语义，而不是把它当成实时视频。
7. **分辨率数字的对外口径**。我们精细档实测 FWHM 1.47 m（距离）≈ APG-70 的 8.5 ft（2.6 m）量级、好于 RBM（APG-63 级 ~15 m）；横向 1.22 m 与公式 λ/(2Δθ)/sin45° 自洽（450 m 孔径、20 km 级）。结论：**数值本身合理，问题在几何与用法**。注意 APG-70 级 8.5 ft 是"近距小 patch"条件下的最好值，远距/大 patch 分辨率放宽 5–15 倍——我们的"任意距离同分辨率"需要加距离/角度依赖的规格说明。
8. **PFA/BP 选择**：我们两种算法都有，与文献一致（前视研究同样用 BP；PFA 是聚束标准算法）。按 Gentile 的波前曲率限制 ρa·√(2R/λ)，512 m 场景在 20 km 处远小于 ~1.4 km 上限，PFA 合法——不需要为避免失真而换算法，问题依然不在算法。
9. **建议的"物理约束"最小改动清单**（可直接映射为文档/测试断言）：
   - 门控文案与可视化：把 20–160° 门控拆成"盲锥（±15°）硬禁"+"15–30° 预警（梯度 sinθ<0.5）"+"30–70° 常用"；
   - 每张图附带实际斜视角、sinθ、理论方位分辨率、等效 patch 尺寸；
   - 连续/拼接图的元数据里记录"成像时间窗与孔径长度"（真实产品必有的字段）；
   - 可选：monopulse 死前向模式的"研究性"演示（10:1 DBS、分辨率 5–15 mrad），带明确"实验性/非实战"标注。

---

### 附录：主要来源清单

**官方/厂商**
- Northrop Grumman AN/APG-81 官方页 — https://www.northropgrumman.com/what-we-do/mission-solutions/radars/an-apg-81-active-electronically-scanned-array-aesa-fire-control
- ICEYE 成像模式产品规格 — https://iceye-ltd.github.io/product-documentation/6.0.2/productspecification/imagingmodes/
- Umbra 任务参数文档（斜视范围） — https://docs.canopy.umbra.space/docs/advanced-parameters
- Applanix POS AV 610 数据表 — https://assets.ctfassets.net/9k5dj5b59lqq/3zotCXoNKxMTrFYkutzYS2/bdf0afe7163f93e1da4c1f4def2a64c7/POS_AV_610.pdf （规格汇总：https://www.jgc.gr/products/applanix/air/pos-av/?lang=en）
- RF Essentials DBS 术语页（公式/盲锥） — https://rfessentials.com/resources/rf-glossary/dbs/

**学术/专利**
- EP0434064A2 死前向锐化专利 — https://data.epo.org/publication-server/rest/v1.2/patents/EP0434064NWA2/document.pdf
- IGARSS 2010 双基地前视 SAR 潜力与限制 — https://vigir.missouri.edu/~gdesouza/Research/Conference_CDs/IGARSS_2010/pdfs/4106.pdf
- Krieger et al. 2003（DLR，双/多基地系统概念） — https://elib.dlr.de/6155/1/154_Krieger.pdf
- Sensors 2020 FDA 前视 SAR — https://pmc.ncbi.nlm.nih.gov/articles/PMC7070757/
- Remote Sensing 2018 前/后向双基地成像性能 — https://www.mdpi.com/2072-4292/10/11/1676
- IET RSN 2024 阵列前视成像（摘要） — https://ietresearch.onlinelibrary.wiley.com/doi/10.1049/rsn2.12552
- Remote Sensing 2023 Video SAR PFA — https://www.mdpi.com/2072-4292/15/11/2807 ；arXiv 视频 SAR — https://arxiv.org/pdf/2401.10252v1.pdf
- Remote Sensing 2022 弯曲航迹 SAR — https://www.mdpi.com/2072-4292/14/13/2983
- Remote Sensing 2024 分布式 MIMO 前视成像 — https://www.mdpi.com/2072-4292/16/21/3991
- Davidson & Cumming 1996 斜视 Chirp Scaling — https://sar.ece.ubc.ca/papers/Davidson Cumming Ito_1996.pdf
- QMUL 2024 高斜视滑聚 — https://qmro.qmul.ac.uk/xmlui/bitstream/handle/123456789/96459/Liu High-Squinted Spaceborne 2024 Accepted.pdf?sequence=2&isAllowed=y
- Thiele 博士论文（机载 60° 斜视沿用） — https://www.ipi.uni-hannover.de/fileadmin/ipi/publications/2013_Thiele.pdf
- John Gentile SAR 笔记（公式/运动补偿/mm 级） — https://john-gentile.com/kb/dsp/Radar.html
- Chalmers 论文（ρ=Rλ/2L） — https://publications.lib.chalmers.se/records/fulltext/248665/248665.pdf

**贸易/二手（数字细节可信度中等）**
- Forecast International APG-77(V) 归档（GM/DBS/8:1/64:1/80 nm） — https://www.forecastinternational.com/archive/disp_pdf.cfm?DACH_RECNO=944
- Air Power Australia F-15E 长文（HRM 表、45° 战术、3–7 s、INS 6×、0.5° 掠射） — https://www.ausairpower.net/TE-F-15E-Strike-Eagle.html
- Radartutorial DBS（±15° 引 Skolnik；40 cm 天线/4° 波束） — https://www.radartutorial.eu/20.airborne/ab05.en.html
- Doerry SAND2008-0911C（斜视差 <2°） — https://www.osti.gov/biblio/1146354

**两处未能取得全文（仅摘要/片段级证据，用时应降权）**：IET RSN 2024（403）；MDPI CF-SAR 页面被拦截（仅用检索摘要）。

---

**要点回顾**：①"正前视不行"的根因与量化盲区（±10–15°、sinθ 梯度）证据链完整，可直接用于设计约束与门控文案；②真实战斗机的正前扇区 = 实波束/monopulse + TFR + FLIR，雷达成像都在斜视带，F-15E 类公开数字（8.5 ft patch、45° 偏轴、3–7 s 驻留、8:1/64:1 DBS）可作为仿真标定锚点；③我们当前最大差距不在算法与分辨率数字，而在**几何约束的显式表达、左右模糊缺失、完美运动补偿、以及显示/刷新语义**——这四点决定了"感觉不像"。

---

## 4. 实时 SAR 处理算法与工程实现 —— 调研笔记

**调研目标**：现役/在研实时 SAR 处理器实际用什么算法、什么硬件，自动聚焦与多视降斑在实时链路里的角色；回答"战斗机如何做到秒级出图"。

**结论先行（一句话版）**：高分辨聚束（战斗机 SAR 的典型模式）业界首选 **PFA（极坐标格式算法）+ 频域 FFT**；持久视频/任意轨迹用 **GPU 反投影（子孔径环形移位寄存器）**；宽区域条带用 **RDA/CS**；星载主流 **CS/ECS**，大斜视用 **ωk**。硬件上机载实时 = FPGA（Zynq/Virtex 级，1–7 W），视频/大画幅 = GPU，星载 = 抗辐照 SoC/ASIC。**处理速度早已不是瓶颈**（2004 年单颗 Pentium M 就能实时聚束成像），真正的"秒级"限制在**孔径采集时间（dwell）与波形调度**。

---

### 1. 算法—场景矩阵（有据可查）

| 算法 | 复杂度 | 业界实际定位 | 实时案例/证据 |
|---|---|---|---|
| **RDA 距离-多普勒** | O(N²logN) | 条带 SAR 工程最常用：结构简单、**运动补偿容易做**、精度/运算量可调；缺点是 RCMC 需要插值 | 韩国航空大学 FPGA RDA 实时处理器：2048² 像素 0.823 s、功耗 1.31 W、整幅约 1.1 Hz（含数据装载 0.892 s）[MDPI Electronics 2021](https://www.mdpi.com/2079-9292/10/17/2133) |
| **CSA chirp scaling** | O(N²logN) | 用相位相乘代替插值做 RCMC；**星载主流**（可覆盖条带/聚束/ScanSAR/TOPS）、也被改成聚束版本；"运算量在主流算法中最小、最适合实时" | 星载 SoC 综述明确 "CS 已成为星载 SAR 主流"（Gaofen-3 实测：16384² 只要 9.2 s，全系统 6.9 W）[MDPI Remote Sensing 2023](https://mdpi-res.com/d_attachment/remotesensing/remotesensing-15-04739/article_deploy/remotesensing-15-04739.pdf)；FPGA CSA：4096² 1.96 s、1.31 W [MDPI Sensors 2023](https://www.mdpi.com/article/10.3390/s23020959) |
| **ωk（wavenumber/RMA, Stolt 插值）** | O(N²logN) | 宽孔径/高斜视场景；假设速度随距离不变，不适合大幅宽；比 PFA 慢但能自动处理波前弯曲 | ONERA RAMSES/Sethi 机载雷达用 **ωk + 大规模并行 GPU** 做实时处理与自聚焦 [Cantalloube, EUSAR 2012](http://www.normalesup.org/~cantallo/eusar2012.pdf) |
| **PFA 极坐标格式** | O(N²logN) | **聚束 SAR 热点首选**；插值到矩形网格 + 2D FFT；代价是远离场景中心处离焦（波前弯曲），需后处理 re-focus；有场景尺寸/斜视限制 | 最权威结论：AFRL/Sandia 团队比较 PFA vs RMA vs OSA for **real-time on-board spotlight**："PFA 明显是最优选择……在单颗 Pentium M 上即可对大量场景实时成像"（2004 年！ 9 英寸即 0.23 m 级分辨率语境）[Jakowatz et al., SPIE 2004](https://ui.adsabs.harvard.edu/abs/2004SPIE.5427..108J/abstract)；Sandia 有专门 PFA 教科书级报告 [Doerry, SAND-2012-3369](https://www.osti.gov/biblio/1044949)；FPGA PFA（无人机视频 SAR）：2048² 0.766 s、512² 0.046 s≈**21.7 Hz**、3.677 W [MDPI Electronics 2024](https://www.mdpi.com/2079-9292/13/12/2401)；南航 PFA FPGA 视频 SAR **5 fps**（4096², 200 MHz）[NUAA/IMBioC 2019](https://faculty.nuaa.edu.cn/zzy5/zh_CN/lwcg/95694/content/19241.htm) |
| **BP 时域反投影（及 FFBP）** | O(N³) 起 | 任意轨迹、宽角/圆迹、双基；太慢不适合全孔径实时，但**子孔径增量更新后成为视频 SAR 的工业实现** | Sandia/GA 视频 SAR：**子孔径 circular shift register + GPU** 实现圆迹持久成像 [Miller/Bishop/Doerry, SPIE 2013](https://www.spiedigitallibrary.org/conference-proceedings-of-spie/8746/1/An-application-of-backprojection-for-video-SAR-image-formation-exploiting/10.1117/12.2016417.full)（摘要：平台沿圆轨迹、以运动补偿点为中心的持久视图，GPU 实现）；交叉引用 [SPIE 会议日程](http://www2.iee.or.jp/ver2/smas/19-calender/rireki_files/DSS13%202013.pdf) |

补充算法学层面：教科书式综述（Cruz et al. 2022）确认 PFA 的几何扭曲/离焦随距场景中心距离增大、可用多种机制校正；ωk 的 Stolt 插值适合宽孔径高斜视 [MDPI Remote Sensing 2022 综述](https://www.mdpi.com/2072-4292/14/5/1258)。斜视约束：机载历史上有用到 ±60° 斜视（"tactical safety"），但"如今真实斜视数据很少" [Thiele, Hannover 论文](https://www.ipi.uni-hannover.de/fileadmin/ipi/publications/2013_Thiele.pdf)；高斜视需 CS+SRC 或改进 PFA [Davidson & Cumming 1996](https://sar.ece.ubc.ca/papers/Davidson%20Cumming%20Ito_1996.pdf)、[Moreira & Huang, DLR](https://microsite.geo.uzh.ch/rsl-documents/research/SARlab/GMTILiterature/Ver09/PDF/MH94b.pdf)。

---

### 2. 实时硬件架构与实测数字（有据可查）

**FPGA（机载/无人机主流，低功耗高吞吐）**

| 实现 | 画幅 | 时间 | 器件/功耗 | 来源 |
|---|---|---|---|---|
| RDA | 2048² | 0.823 s（≈1.1 Hz） | Zynq UltraScale+，1.31 W | [MDPI 2021](https://www.mdpi.com/2079-9292/10/17/2133) |
| CSA | 4096² | 1.96 s（136× vs ARM） | Zynq UltraScale+，1.31 W | [MDPI Sensors 2023](https://www.mdpi.com/article/10.3390/s23020959) |
| PFA（视频 SAR） | 2048²/512² | 0.766 s / 0.046 s | Zynq UltraScale+，3.677 W | [MDPI Electronics 2024](https://www.mdpi.com/2079-9292/13/12/2401) |
| PFA 视频 SAR | 4096² | 5 fps（并行距离向 0.063 s@200 MHz） | FPGA | [NUAA 2019](https://faculty.nuaa.edu.cn/zzy5/zh_CN/lwcg/95694/content/19241.htm) / [专利 CN108614266A](https://www.xjishu.com/zhuanli/52/201810203581.html) |
| 早期 RDA（对照） | 2048² | 20.31 s（2004 级 Altera）→ 2.08 s（Virtex-6 优化版） | FPGA | 同上 MDPI 2021 引用对比表 |
| PFA | — | 0.37 s（约 2 GFLOP/s 级） | Virtex-7 XC7VX690T | [中国光学期刊网引文](https://www.opticsjournal.net/Articles/OJ7e9ac0f0094bf328/FullText) |

**GPU / CPU+GPU（视频、大画幅）**
- CPU/GPU 协同：32728×32728（≈10.7 亿像素）**2.8 s**，但功耗 345 W [Zhang et al. 2016, 经 MDPI Sensors 2023 转引](https://www.mdpi.com/article/10.3390/s23020959)。
- 移动 GPU：4096² 约 15 s；Tesla C2075 方案功耗 247 W [同上]。
- Sandia 视频 SAR：GPU 实现子孔径反投影，30 FPS 实测数据集（Ku 段 16.7 GHz、0.1 m、660×720 像素、900 帧）[数据集描述（中文综述转引 SNL）](https://www.sciengine.com/doi/10.12000/JR25265)、[MDPI 用户论文](https://www.mdpi.com/2072-4292/18/3/510)。

**星载（抗辐照 SoC/ASIC）**
- 故障容错 SoC 芯片（Gaofen-3 实测）：条带 16384² **9.2 s**；多通道条带 65536×8192 50.6 s；ScanSAR 32768×4096 7.4 s；**系统功耗 6.9 W**；FFT 占运算量 >50%、相位因子（CORDIC）约 30% [MDPI Remote Sensing 2023](https://mdpi-res.com/d_attachment/remotesensing/remotesensing-15-04739/article_deploy/remotesensing-15-04739.pdf)。
- CS 无需插值、适合星上固定点实现（量化噪声研究基于 RADARSAT-1 数据）[BIT 量化噪声研究](https://pure.bit.edu.cn/en/publications/quantization-noise-analysis-of-fixed-point-cs-algorithm-for-sar/)；CS 在 ERS-1/RADARSAT 时代即被星载处理采用 [Eldhuset 1998](https://www.ece.ubc.ca/~yewn/papers/00705890_eldhuset.pdf)。

**历史锚点（说明"秒级"难度有多低）**
- 2004 年：单颗 Pentium M 跑 PFA 即可对大量聚束场景实时成像 [Jakwatz 2004](https://ui.adsabs.harvard.edu/abs/2004SPIE.5427..108J/abstract)。
- 1999 年：Lynx SAR **实时成图并输出 NTSC 视频**（Ku 段，聚束 0.1 m / 条带 0.3 m，斜距 25–30 km）[Doerry et al., Lynx 论文（OSTI）](https://www.osti.gov/biblio/7140)、[DTIC ADA529750](https://apps.dtic.mil/sti/tr/pdf/ADA529750.pdf)。
- 2005 年：Sandia MiniSAR 从 Class III 无人机**实时回传 4 英寸（0.1 m）分辨率 SAR 图像** [Sandia 新闻稿](https://newsreleases.sandia.gov/sandia-minisar-flies-for-first-time-on-unmanned-aerial-system/)。

---

### 3. 战斗机 SAR 公开硬指标（区分官方/二手）

| 系统 | 指标 | 来源可信度 |
|---|---|---|
| **AN/APG-70**（F-15E，机械扫描） | 地图测绘距离 >100 nmi，分辨率 **8.5 ft ≈ 2.6 m**；高分辨地图幅宽 0.67 nmi（≈1.2 km） | 行业刊物 [Forecast International](https://www.forecastinternational.com/archive/disp_pdf.cfm?DACH_RECNO=729) + 手册摘录 [ED Forums](https://forum.dcs.world/topic/79647-ground-mapping-radar-sar/)（二手，但两源一致） |
| **AN/APG-81**（F-35） | 官方措辞："**ultra-high-resolution SAR mapping mode**"，用于识别并交战目标；1676 个 T/R 模块；**无可信公开分辨率数字** | 官方 [Northrop Grumman F-35 brochure](https://cdn.northropgrumman.com/-/media/Project/Northrop-Grumman/ngc/what-we-do/air/f35/F-35-Brochure-2023-v007.pdf)；"SAR+GMTI 同时"为二手报道 [中文百科](https://www.newton.com.tw/wiki/AN/APG-81/8267681) |
| **AN/APG-82(V)1**（F-15E/EX，AESA） | 官方项目文件措辞："更远距离、**更高分辨率**的对地测绘"，且支持对空/对地功能"**近同时交错**（near-simultaneous interleaving）" | [European Security & Defence 2023](https://euro-sd.com/2023/01/articles/26781/main-aesa-radar-solutions-on-both-sides-of-the-atlantic/)（引 DoD 文件） |
| **ECRS Mk1/Mk2**（台风，AESA） | 明确宣传 **UHR-SAR（超高分辨 SAR）成像**模式；**无公开米数**（中文二手称 Mk1 约 0.5 m，存疑） | 厂商 [HENSOLDT](https://www.hensoldt.net/insights/future-proofing-the-eurofighter-typhoon)、[AIN](https://www.ainonline.com/aviation-news/defense/2021-11-09/typhoon-radar-development-follows-parallel-tracks) |
| **SABR Big SAR**（F-16） | "F-16 史上最大、最清晰 SAR 图，单幅覆盖大面积" | [F-16.net 新闻](https://www.f-16.net/f-16-news-article4729.html)（厂商通稿） |
| **Lynx (AN/APY-8)** | Ku 段；聚束 **0.1 m**、条带 **0.3 m**；斜距 25–30 km；实时 NTSC 输出 | Sandia/GA 论文（一手设计方） |
| **MiniSAR** | 0.1 m（4 英寸），实时回传 | Sandia 官方新闻 |
| **Sandia 视频 SAR 数据集** | Ku 16.7 GHz、**0.1 m、30 FPS**、660×720、900 帧连续 | 公开数据集（多篇论文引用） |
| **视频 SAR 门槛（论文共识）** | 要跟踪动目标：帧率 **≥5 Hz**、分辨率 **≥0.2 m** | [MDPI Remote Sensing 2023 (GP-PFA)](https://www.mdpi.com/2072-4292/15/11/2807) |
| 俄系（对照） | Irbis-E（Su-35）SAR 约 3 m（厂商口径，经二手转述） | Quora 引 NIIP 官网，**低可信度，仅供参考** |

**"秒级出图"的物理上限（我的推算，非文献数字，标注为推测）**：X 波段（λ≈3 cm）在 30 km 斜距做 0.3 m 方位分辨率，需要约 2.9° 转角、约 1.5 km 合成孔径；以 250 m/s 平台速度算，**仅采集孔径就要约 6 s**；Ku 段（λ≈1.8 cm）同样指标约 3.6 s。所以"1–2 s 刷一副高分辨图"在物理上只可能出现在近距离小画幅或较低分辨率档；这也解释了为什么视频 SAR 必须靠**子孔径重叠**提高帧率（重叠率越高，帧率越高，但对处理速度要求越高）[MDPI Electronics 2024](https://www.mdpi.com/2079-9292/13/12/2401)。

---

### 4. 自动聚焦（autofocus）在实时系统中的角色（有据 + 少量推测）

**有据可查**：
- 实时机载 SAR 的处理链 = INS/GPS 测量数据做**粗运动补偿（MoCo）**，再由数据驱动的自聚焦处理**残余相位误差**；PGA（Phase Gradient Autofocus）是最通用的非参数化方法，**不依赖相位误差阶数模型**，对高阶误差有效，优于只能估低阶误差的 Mapdrift [北航学报 1999 对比](https://bhxb.buaa.edu.cn/bhzk/article/id/11466)。
- PGA 的已知局限：依赖**孤立强点目标**，在均匀杂波（海面、沙漠）会失效；Mapdrift 用子孔径互相关估低阶误差、复杂度低 [rfessentials autofocus 综述](https://rfessentials.com/resources/rf-glossary/autofocus-sar/)、[MDPI Enhanced PGA 2025](https://www.mdpi.com/2072-4292/17/7/1216)。
- 工程趋势：ONERA 明确把 **GPU 加速用于"机载 SAR 成像 + 自聚焦"**，其 RAMSES 系统实时链包含 MoCo 与 autofocus 议题 [Cantalloube, EUSAR 2012](http://www.normalesup.org/~cantallo/eusar2012.pdf)、[ResearchGate 页面](https://www.researchgate.net/profile/Hubert-Cantalloube)；汽车 SAR 等新场景在用**低复杂度 PFA 域 PGA 扩展**做实时自聚焦 [arXiv 2026](https://arxiv.org/html/2603.07332v1)。
- 有 FPGA 优化运动补偿纳入实时架构的先例（"integrated first-order motion compensation"）[Pfitzner et al., 经 MDPI Sensors 转引](https://www.mdpi.com/article/10.3390/s23020959)。

**推测（明确标注）**：现役战斗机（APG-81/APG-82 类）大概率是"INS/GPS 惯导粗补偿 + 实时 autofocus（PGA/类 Mapdrift 或其 ASIC 化版本）+ 严格飞行剖面约束（直线、小机动）"的组合；其内部实现（算法变体、迭代次数、硬件）**无公开资料**。

---

### 5. 多视与降斑（speckle）的实时做法

**有据可查**：
- SAR 聚焦输出默认是**单视复数（SLC）**：分辨率最高、散斑最强；操作处理链普遍做**多视（multi-look）**——在距离/方位分辨单元上做非相干平均，用**辐射分辨率换空间分辨率** [SARscape/SAR Guidebook](https://www.nv5geospatialsoftware.com/portals/0/pdfs/envi/SAR_Guidebook.pdf)、[sarmap SAR-Guidebook](https://www.sarmap.ch/pdf/SAR-Guidebook.pdf)。
- 散斑统计关系：L 视平均后标准差 = 均值/√L（即 ENL=L），这就是"几视"的工程含义 [ESA eo4society 讲义](https://eo4society.esa.int/wp-content/uploads/2021/02/D1T2a_LTC2015_Younis.pdf)。
- 多视会在方位向**牺牲分辨率**（n 视 → 方位分辨单元扩大 n 倍），早期处理器需为此缓存（"延迟 = (视数-1)×合成孔径长度"）[Caltech 论文](https://thesis.caltech.edu/1020/1/Haney_mw_1986.pdf)、[NASA NTRS 1978](https://ntrs.nasa.gov/api/citations/19780013624/downloads/19780013624.pdf)；子孔径多视原理 [DLR Reigber 论文](https://elib.dlr.de/54771/1/reigber_habil.pdf)。
- 空间滤波（Lee 等）同样降斑但同样损失分辨率；多视与空间滤波本质都是"平滑" [NRCan 官方说明](https://natural-resources.canada.ca/maps-tools-publications/satellite-elevation-air-photos/radar-image-properties)。

**推测（明确标注）**：战斗机高分辨聚束模式显示的一般是**轻多视（约 1–2 视）或 SLC 强度图**（因为分辨率是卖点）；宽区域条带/导航图会有更多视数和降斑；视频 SAR 因需要高帧率和高分辨率，通常**单视 + 时间维非相干积累**降斑（每帧单视，人眼靠帧间"运动感"抗散斑）——这与 Sandia 数据集 0.1 m/30 FPS 单帧形态一致。

---

### 6. "有据可查 vs 推测" 速查

- **有据**：各算法适用场景与复杂度、PFA 为 on-board 聚束首选（2004 SPIE）、视频 SAR = GPU 反投影 + 子孔径循环移位（SPIE 2013）、各 FPGA/SoC 实测时间与功耗、Lynx/MiniSAR/APG-70 具体指标、APG-81 "UHR SAR" 官方措辞、UHR-SAR（ECRS）、视频 SAR ≥5 Hz/≥0.2 m 门槛、PGA/Mapdrift 特性、多视统计与分辨率代价。
- **推测**：现役战斗机内部算法/硬件具体型号；"秒级刷新"的具体数字（官方无）；聚束模式默认视数；战斗机 autofocus 具体方案；带宽→分辨率（我按 ρ=c/2B 推导）。
- **未能证实**：F-35 SAR 的直接米级数字。建议不要在插件文案里引用任何"F-35 SAR 分辨率 X 米"的具体数字，改用"亚米级 UHR-SAR（厂商措辞）"。

---

### 7. 对我们仿真的启示（按重要性排序）

1. **算法主路径：把 PFA 作为高分辨聚束成像的主算法，BP 降级为"增量式"路径。** 真实系统的共识是聚束=PFA（Jakowatz 2004 明确"首选"，且 2004 年单核 CPU 即可实时）；BP 的实时用法不是每帧全孔径重算，而是**子孔径环形移位寄存器式增量更新**（Sandia/GA 视频 SAR 工业实现）。我们已有 PFA 和多核 BP——建议把 BP 改造成"子孔径滑窗 + 增量累加"，这一步直接决定能否做出 5–30 Hz 的"视频 SAR"观感。
2. **补上运动补偿与自动聚焦环节，并让它"可见地工作"。** 现在的仿真若是理想轨迹，成像永远完美，这与真实 F-35 体验（严格直线飞行、大机动就没有好 SAR 图）不符。建议：合成回波时按"理想航迹+随机误差"生成相位误差；处理链用简化的 INS 粗补偿 + PGA（或 Mapdrift），并允许聚焦质量随机动/误差劣化。加上"点目标稀疏区（沙漠/水面）autofocus 失效"的场景更接近真实。
3. **引入"视数/降斑"参数，区分显示模式。** 真实系统 SLC 高分辨图散斑非常重（比我们现在的"干净"图像更花），宽区域模式则是多视/滤波后的平滑图。建议：显示层增加 ENL（等价视数）参数：聚束高分辨≈1 视（散斑全开）、大区域底图 2–4 视；散斑噪声用 Rayleigh/K 分布按 ENL 生成，而不是加高斯噪声。
4. **分辨率/带宽/几何参数要按物理公式联动，而不是美术化。** 0.3 m 级（≈APG-70 的 8.5 ft 到现代 UHR 之间的合理显示档）对应 ~500 MHz 带宽；方位分辨率需要按合成角/波长/斜距计算，聚束块尺寸受场景中心有效聚焦范围限制（PFA 波前弯曲导致边缘离焦——真实图像边缘模糊是特征，不是 bug）。幅宽档位参考：高分辨小块 ~1–2 km（F-15E 0.67 nmi 先例），宽区域条带几公里到几十公里。
5. **把"刷新节奏"做成两层结构，而不是等一个数字。** 真实战术链路是：连续低分辨底图/视频（≥5 Hz 门槛才有"动目标阴影可跟踪"效果，Sandia 做到 30 FPS）→ 点选小块高分辨聚束成像（受孔径采集时间限制，秒级到十几秒）→ 地理锚定拼接（我们已有）。建议插件里显式建模**dwell 时间 = 采集限制**：高分辨出图间隔应随画幅/分辨率/平台速度变化，而不是固定刷新率。
6. **斜视与几何：默认正侧视为小型聚束，允许有限斜视。** 历史上机载斜视用到过 ±60°（战术安全），但高斜视需要不同算法（CS/RMA）；PFA 在中低斜视效果最好。建议对我们的 PFA 显示加"斜视角滑杆"并在大斜视时按算法边界提示局限/退化，这本身就是很好的原理演示。
7. **GMTI/阴影是补齐"像 F-35"观感的高性价比项。** 现役雷达的宣传重点之一是 SAR 与 GMTI 交错（APG-82 "near-simultaneous interleaving"），飞行员看到的往往是"SAR 图像 + 动目标阴影/矢量叠加"。在我们世界锚定的底图上叠加运动目标阴影/轨迹，比继续提高分辨率更能拉近"真实感"。
8. **性能预算与真实档位对齐（避免"超真实"）。** 参考档位：2048² 一幅 ≈0.8 s、4096² ≈2 s（FPGA 级）；512² 可到 20 Hz。如果我们的多核 BP 明显快于/慢于这个量级，观感都会失真——建议给处理器加"仿真算力档"（相当于 FPGA/GPU/CPU 三档），让延迟像真实系统一样可感知。

---

#### 主要来源清单（按类型）

**学术/官方（一手）**：[Jakowatz 2004 SPIE（实时 on-board 聚束算法对比）](https://ui.adsabs.harvard.edu/abs/2004SPIE.5427..108J/abstract)｜[Cruz et al. 2022 综述](https://www.mdpi.com/2072-4292/14/5/1258)｜[MDPI RDA-FPGA 2021](https://www.mdpi.com/2079-9292/10/17/2133)｜[MDPI CSA-FPGA 2023](https://www.mdpi.com/article/10.3390/s23020959)｜[MDPI PFA-FPGA 2024](https://www.mdpi.com/2079-9292/13/12/2401)｜[MDPI 星载 SoC 2023](https://mdpi-res.com/d_attachment/remotesensing/remotesensing-15-04739/article_deploy/remotesensing-15-04739.pdf)｜[Miller/Bishop/Doerry SPIE 2013 视频 SAR](https://www.spiedigitallibrary.org/conference-proceedings-of-spie/8746/1/An-application-of-backprojection-for-video-SAR-image-formation-exploiting/10.1117/12.2016417.full)｜[Doerry SAND-2012-3369 (PFA)](https://www.osti.gov/biblio/1044949)｜[Lynx (OSTI)](https://www.osti.gov/biblio/7140)｜[MiniSAR 新闻稿](https://newsreleases.sandia.gov/sandia-minisar-flies-for-first-time-on-unmanned-aerial-system/)｜[GP-PFA 视频 SAR 2023](https://www.mdpi.com/2072-4292/15/11/2807)｜[ESA 讲义](https://eo4society.esa.int/wp-content/uploads/2021/02/D1T2a_LTC2015_Younis.pdf)

**厂商/官方文档**：[Northrop F-35 brochure（APG-81 UHR SAR）](https://cdn.northropgrumman.com/-/media/Project/Northrop-Grumman/ngc/what-we-do/air/f35/F-35-Brochure-2023-v007.pdf)｜[Northrop ASQ-236](https://www.northropgrumman.com/what-we-do/air/an-asq-236-dragons-eye-radar-pod)｜[HENSOLDT ECRS UHR-SAR](https://www.hensoldt.net/insights/future-proofing-the-eurofighter-typhoon)｜[European Security & Defence (APG-82)](https://euro-sd.com/2023/01/articles/26781/main-aesa-radar-solutions-on-both-sides-of-the-atlantic/)

**二手/社区**：[Forecast International APG-70](https://www.forecastinternational.com/archive/disp_pdf.cfm?DACH_RECNO=729)｜[ED Forums F-15E SAR](https://forum.dcs.world/topic/79647-ground-mapping-radar-sar/)｜[F-16.net SABR](https://www.f-16.net/f-16-news-article4729.html)｜[rfessentials autofocus](https://rfessentials.com/resources/rf-glossary/autofocus-sar/)

**备注**：F-35 的 SAR 分辨率没有可信公开数字，任何"F-35 SAR = X 米"的说法都不可引用；建议后续若要增强"像 F-35"的观感，按第 7 节第 2、3、7 条（autofocus 劣化、视数/散斑、GMTI 阴影叠加）优先级执行，它们比继续优化成像核更接近真实体验差距。
## 5. SAR 作战使用流程与产品形态 — 调研笔记

调研时间 2026-10-10。约定：**【有据】**= 来源明确可查；**【推测】**= 我的推断或未见权威来源；来源分级：官方/教科书/厂商 > 行业媒体 > 社区。

---

### 0. 一句话结论

真实 SAR 在作战中的核心用途**不是"看一张好看的图"，而是"生成可用的坐标 + 把动/静目标叠在一张地图上做态势和打击"**。F-35 的 SAR 被 DOT&E 报告直接描述为："飞行员用 SAR mapping 功能推导出**武器级坐标**（weapons quality coordinates），并在编队内**共享坐标**相互验证后才投放武器"（[DOT&E FY2016 年报](https://www.dote.osd.mil/portals/97/pub/reports/fy2016/other/2016doteannualreport.pdf)）【有据】。产品形态是**小 patch、分档分辨率、几秒级等待、连续条带/回访拼接、MTI 叠加**，而不是我们目前"重演算一次、出一块 128 m 方图、拼上去淡淡叠起来"的形态。

---

### 1. 产品形态谱系（含硬指标）

#### 1.1 Patch map / High Resolution Map（小块精照）——战斗机的主用形态

- **定义**：高分辨率 SAR 地面测绘出一个"矩形 patch（小块）"，即教科书里的 "rectangular patch map"，是对特定区域的详细图像（Stimson《Introduction to Airborne Radar》原文表述，见 [Academia 转载页](https://www.academia.edu/145588397/Stimsons_Introduction_to_Airborne_Radar_3rdEd_1_1_George_W_Stimson_2014_)）【有据】。F-15E 的 APG-70 叫 HRM，AV-8B 的 APG-65 文档明确写 "although it actually uses a patch map format"（[AV-8B Tactical Manual Part 1, archive.org](https://archive.org/stream/av8btacticalmanualpart1/AV-8B%20Tactical%20Manual%20Part%201_djvu.txt)）【有据】。
- **F-15E APG-70 的 HRM 档位表（最完整的公开战斗机 SAR 产品表）**（[Air Power Australia, F-15E 专辑](https://www.ausairpower.net/TE-F-15E-Strike-Eagle.html)）【有据】：

| Patch 尺寸 | 分辨率 | 最大作用距离 |
|---|---|---|
| 0.67 × 0.67 nm (~1.2 km) | 8.5 ft (~2.6 m) | 10 nm |
| 1.30 × 1.30 nm | 17 ft | 20 nm |
| 3.30 × 3.30 nm | 42 ft | 50 nm |
| 4.70 × 4.70 nm | 59 ft | 80 nm |
| 10 × 10 nm | 127 ft (~39 m) | 160 nm |

- **作战流程（经典 F-15E 剖面）**：低空 TF 接近 → 距目标 50 nm 爬升（pop-up）生成 4.7×4.7 nm patch（含已知地标）→ MTI 找车、车以**闪烁矩形叠加在地图上**→ 距 8 nm 再拍 0.67 nm patch（8.5 ft）识别车队 → WSO 放光标、锁定、导航攻击系统接手（[同上](https://www.ausairpower.net/TE-F-15E-Strike-Eagle.html)）【有据】。
- **关键约束**：SAR 需要**侧视**，文中明确"沿 45° 偏轴接近以获得最优 SAR 性能"；凝视时间 **3–7 s**；信号处理"要算好几秒"；HRM 可工作到 **0.5° 掠射角**（20 nm 时对 1000 ft 高度）；成图时惯导给雷达的更新率要加快 6 倍；图像在操作员屏幕**先拼出再冻结（frozen）**让他找目标/放偏置瞄准点（OAP）（[同上](https://www.ausairpower.net/TE-F-15E-Strike-Eagle.html)）【有据】。
- **F-16/F-15E 挂载的 ASQ-236 "龙眼" SAR 吊舱**（现役重要参照）：SAR 用于"详细地图、坐标生成、炸弹效果评估（BDA）"；官方手册要求由 APG-70 或 ASQ-236 的 HRM patch map 直接指定目标（APG-70 最小 patch 0.67 NM）（[USAF 情况说明](https://www.af.mil/About-Us/Fact-Sheets/Display/Article/104604/anasq-236-radar-pod/)、[AFI 11-2F-15E V3](https://www.bits.de/NRANEU/others/END-Archive/afi11-2f-15ev3%2813%29.pdf)）【有据】。
- **F-35 / APG-81**：官方只公开定性——"ultra-high-resolution SAR mapping mode，可识别并交战军事目标"（[Northrop Grumman](https://www.northropgrumman.com/what-we-do/mission-solutions/radars/an-apg-81-active-electronically-scanned-array-aesa-fire-control)）；NG 展示材料显示 APG-81 同时承担 SAR mapping、GMTI、BDA（[Air & Space Forces](https://www.airandspaceforces.com/northrop-grumman-reveals-its-developing-the-f-35s-new-radar/)）；**具体分辨率从未公开**。F-35 的实战结论是 SAR 才是坐标来源（DOT&E 指出同期 EOTS 分辨率不足，无法对目标做 positive ID，见上）【有据】；具体 m 级数字为【推测：不公开，按 APG-81 级别估计在 0.3–1 m 量级】。

#### 1.2 连续条带（Stripmap）与镶嵌（Mosaic）

- **Global Hawk（HISAR/EISS）**：条带模式 **10 km 宽、1 m 分辨率、作用距离 200 km、日均 138,000 km²**；点模式 **0.3 m、2×2 km 小块、每天 1,900 块**（[Forecast International: Global Hawk ISS](https://www.forecastinternational.com/archive/disp_pdf.cfm?DACH_RECNO=1460)）【有据】。这是"覆盖率 vs 分辨率"取舍最干净的公开数字：1 m 模式一天 13.8 万 km²，0.3 m 模式一天只有约 7,600 km²。
- **Lynx（MQ-9/陆军）**：条带模式 0.3 m、点模式 0.1 m，实时成像，**条带模式把多块 SAR 图拼成一张大图**（厂商原文 "Stripmap mode mosaics multiple spot SAR images together to form one large image"，[GA-ASI Lynx 页](https://www.ga-asi.com/radars/lynx-multi-mode-radar)）【有据】；操作员可在比屏幕大的缓存图内自由平移（[Sandia 新闻稿](https://newsreleases.sandia.gov/sandia-general-atomics-unveil-new-fine-resolution-synthetic-aperture-radar-system/)）【有据】。
- **JSTARS（APY-3）**：雷达以**"地面基准覆盖"模式按既定时间线周期性回访固定区域**，默认宽域监视自动重访，可插入 sector search / SAR 成像；雷达基准模式下单次通过可扫百万 km² 级；18 个操作员台 + 地面站可发成像请求（[Forecast International: APY-3](https://www.forecastinternational.com/archive/disp_pdf.cfm?DACH_RECNO=406)）【有据】。
- **Sentinel R1 (ASTOR)**：spotlight + swath 两种 SAR 加 MTI；swath 模式产出"大量条带画面"（[Forecast ASTOR](https://www.forecastinternational.com/archive/disp_pdf.cfm?DACH_RECNO=824)、[BCAR](http://www.bcar.org.uk/raytheon-sentinel)）【有据】。注意：Forecast 称 spotlight 5 m，与业界常见的"亚米级"说法矛盾，此处按【有据但存疑】处理。
- **其他平台的判读证据**：JSTARS 图像在波斯尼亚曾被用于核实车辆是否撤出隔离区、监视 Sava 河渡口（[Forecast APY-3](https://www.forecastinternational.com/archive/disp_pdf.cfm?DACH_RECNO=406)）【有据】——即真实 SAR 产品常用于**变化/合规核查**，而不仅是找目标。

#### 1.3 视频 SAR（ViSAR）

- DARPA ViSAR：**235 GHz（EHF）**、装进 20 英寸 MTS-B 光电转塔、穿云直播；BAA 指标为 **帧率 >5 Hz、分辨率 ≥0.2 m**；DARPA 明确"不追求等同光电全动视频"，目标是"跟踪机动地面目标"；试飞证实光电被云遮死时 SAR 全程连续跟踪（[Avionics International](https://www.aviationtoday.com/2018/09/28/will-video-synthetic-aperture-radar-revolutionize-close-air-support/)、[Military Embedded](https://militaryembedded.com/news/darpa-reports-its-new-radar-sensor-captures-real-time-video-in-any-weather/)）【有据】。
- 学术侧结论：要达 5 Hz 帧率，载频需 >170 GHz（[MDPI Remote Sensing 2026](https://www.mdpi.com/2072-4292/18/2/294)）【有据】。即 ViSAR 是 Ka 以下波段做不到的产品形态，**不能**用 X 波段"假装"【推测/常识】。
- 用途定位：CAS（近距空中支援）、云/烟尘中持续观察地面机动（同上）【有据】。

#### 1.4 GMTI 与 SAR 的叠加

- 真实产品中，动目标与 SAR 底图**叠加显示**是常态：JSTARS 的 SAR/MTI 数据融合进同一地面站显示，叠加数字地图（道路、植被、水系等 14 个数据库），并有"地形遮蔽数据库"提示哪里目标会消失（[Forecast APY-3](https://www.forecastinternational.com/archive/disp_pdf.cfm?DACH_RECNO=406)）；JSTARS 广域覆盖约 50,000 km²、方位 ±60°、可同时跟踪约 600 个目标、作用距离 250 km+（[Wikipedia/美空军情况表](https://en.wikipedia.org/wiki/Northrop_Grumman_E-8_Joint_STARS)）【有据，600 目标条目标注 citation needed】。
- MP-RTIP（Global Hawk Block 40）的卖点就是**SAR 与 GMTI 并行不切换**（[知乎专栏整理，二手](https://zhuanlan.zhihu.com/p/646308684)）【有据（二手）】。
- DMTI 能测到约 1 mph (0.45 m/s) 的步行人员（[GA-ASI Lynx](https://www.ga-asi.com/radars/lynx-multi-mode-radar)）【有据，厂商宣传】；Global Hawk GMTI 最小可检测速度 2.1 m/s、覆盖 15,000 km²/min（[Forecast ISS](https://www.forecastinternational.com/archive/disp_pdf.cfm?DACH_RECNO=1460)）【有据】。
- 操作模式：选中 GMTI 目标 → **自动 cross-cue 到 EO/IR 窄视场**目视识别（Lynx，[同上](https://www.ga-asi.com/radars/lynx-multi-mode-radar)）【有据】。

#### 1.5 变化检测（ACD/CCD）

- **Lynx**：两次不同时间成像叠加做 Amplitude Change Detection，并有 AMMOD（人造物自动检测）算法突出差异（[GA-ASI](https://www.ga-asi.com/radars/lynx-multi-mode-radar)）【有据】。
- **CCD（相干变化检测）**：Sandia 宣称 Lynx 的 CCD 能检测"软地面上的脚印"级变化（[Sandia 新闻稿](https://newsreleases.sandia.gov/sandia-general-atomics-unveil-new-fine-resolution-synthetic-aperture-radar-system/)）【有据，含宣传成分】；学术界用 CCD/相干性检测**车辙**（[MDPI 2021 车辙研究](https://www.mdpi.com/2072-4292/13/24/5010)）【有据】。美国空军 SBIR 文档把 NCCD（非相干，快、稳健、粗）与 CCD（可测扰动地表、需几何匹配）的取舍写得很明白（[Air Force SBIR 08.3](https://textarchive.ru/c-2195099-pall.html)）【有据】。

---

### 2. 平台任务剖面速览

| 平台 | 雷达/模式 | 关键数字 | 来源 |
|---|---|---|---|
| E-8C JSTARS | APY-7（早期 APY-3） | 250 km+、50,000 km² 视场、±60°、600 目标、18 操作台；MTI 实时报、**SAR 图"several seconds"采集处理** | [Forecast APY-3](https://www.forecastinternational.com/archive/disp_pdf.cfm?DACH_RECNO=406)、[Wikipedia](https://en.wikipedia.org/wiki/Northrop_Grumman_E-8_Joint_STARS) |
| U-2 ASARS-2A | 侧视高分辨 SAR | 三种搜索模式 **3–1 m**；五种 spot 模式 **0.9–0.3 m**；另有增强点成像；操作员/判读员在**地面站**控制；下行 spot 图像 8 Mbps（升级后 45 Mbps） | [Dragon Lady Today](https://dragonladytoday.com/2017/04/18/u-2-asars-radar/)、[FAS ASARS-2](https://irp.fas.org/program/collect/asars-2.htm) |
| RQ-4 Global Hawk | HISAR/EISS | 1 m/10 km 条带、0.3 m/2×2 km 点、±45° 斜视、X 波段 600 MHz、GMTI MDV 4 kt；特战队员 PDA **请求到回图 2–3 分钟**；分析员建立基线后按固定节拍重成像（原文被截断为 "every 10 …"，单位未确认【推测：分钟】） | [Forecast ISS](https://www.forecastinternational.com/archive/disp_pdf.cfm?DACH_RECNO=1460) |
| F-15E | APG-70 HRM | 见 §1.1 表；pop-up 3–7 s；典型 4.7 nm patch → 0.67 nm patch 两级 | [Air Power Australia](https://www.ausairpower.net/TE-F-15E-Strike-Eagle.html) |
| F-35 | APG-81 | 定性："ultra-high resolution"；实战用途=**坐标生成与编队共享** | [NG](https://www.northropgrumman.com/what-we-do/mission-solutions/radars/an-apg-81-active-electronically-scanned-array-aesa-fire-control)、[DOT&E FY2016](https://www.dote.osd.mil/portals/97/pub/reports/fy2016/other/2016doteannualreport.pdf) |
| Sentinel R1 (ASTOR) | 双模 SAR/MTI | 42,000–50,000 ft、探测 300 km、MTI MDV 10 km/h、spot 5 m（存疑）、swath 大幅面 | [Forecast ASTOR](https://www.forecastinternational.com/archive/disp_pdf.cfm?DACH_RECNO=824) |
| ViSAR（演示） | 235 GHz | 0.2 m、>5 Hz、转塔装载、穿云 | [Avionics Today](https://www.aviationtoday.com/2018/09/28/will-video-synthetic-aperture-radar-revolutionize-close-air-support/) |

---

### 3. 判读员怎么用 SAR 图（"好 product"长什么样）

**判读要素（tone/texture/shadow/site…）**：影像亮度由粗糙度/几何/介电常数决定——平静水面黑、粗糙面亮、**人工物（建筑转角、桥、车辆）呈 corner reflector 式亮斑（"亮点或十字"）**、陡坡产生**阴影（SAR 阴影里没有任何信息）**与叠掩（山顶"倒"向雷达）（[NASA Earthdata SAR 判读](https://www.earthdata.nasa.gov/learn/earth-observation-data-basics/sar/image-interpretation)、[Capella SAR 101](https://www.capellaspace.com/resources/sar-101-an-introduction-to-synthetic-aperture-radar)）【有据】。传统判读训练强调 tone/texture/pattern/shape/size/site/association，雷达图习惯把**阴影朝向观察者**、亮点视作人造物、中灰视作开阔地（[University of Lucknow 遥感讲义](https://www.lkouniv.ac.in/site/writereaddata/siteContent/202004021910156883ajay_misra_geo_microwave.pdf)、[NRCan](https://natural-resources.canada.ca/maps-tools-publications/satellite-elevation-air-photos/elements-visual-interpretation)）【有据】。

**可用性的量化标准是 NIIRS（Radar 版）**：等级用"能完成什么判读任务"定义，而不是纯分辨率——例如 Level 4 可"在已知车场里分辨单台车辆"、Level 5 "数清中型直升机、区分 T-62 与 MTU-20"、Level 7 "按型识别小型战斗机（FISHBED/FITTER/FLOGGER）"、Level 9 "分辨 APC 轮/履带、导弹尾翼"（[FAS Radar NIIRS 表](https://irp.fas.org/imint/niirs_c/app3.htm)）【有据】。对应的地面分辨距离（GRD）档位：0.75–1.2 m ≈ L5、0.4–0.75 m ≈ L6、0.2–0.4 m ≈ L7（MSTAR 数据 1 ft ≈ NIIRS 7）（[NIIRS 汇总](https://www.majumderfoundation.org/ML_Radar_ATR_CH09.pdf)、[Wikipedia NIIRS](https://en.wikipedia.org/wiki/NIIRS)）【有据】。**含义：想"识别目标"，0.3 m 是门槛；1 m 只能到"发现/区分大件"级别。**

---

### 4. 覆盖率 vs 分辨率取舍（可直接引用的数字）

| 系统 | 大范围模式 | 精照模式 | 覆盖效率 |
|---|---|---|---|
| Global Hawk | 1 m / 10 km 条带 / 200 km | 0.3 m / 2×2 km | 138,000 km²/24h ↔ 1,900 spot/24h（7,600 km²）|
| JSTARS | 40,000 km² 视场、±60°、250 km | SAR 若干秒一幅、可被 18 台/地面站点播 | 雷达基准模式单次通过百万 km² 级 |
| APG-70 | 10×10 nm @127 ft | 0.67 nm @8.5 ft | patch 越大分辨率越差，硬绑定 |
| Lynx | 0.3 m 条带 | 0.1 m spot | 点模式"凝视直到命令改变或被几何拒绝" |
| ViSAR | — | 0.2 m、>5 Hz | 只做目标级视频，不做广域 |

来源同 §1、§2。【有据】。规律：**"搜索"与"精照"是两个不同产品档**，真实系统从不指望一个模式兼顾；精照总是"点播 + 有限数量"。

---

### 5. 用户实际等待多久

| 场景 | 等待量级 | 来源 |
|---|---|---|
| ViSAR 单帧 | ≤0.2 s | [Avionics Today](https://www.aviationtoday.com/2018/09/28/will-video-synthetic-aperture-radar-revolutionize-close-air-support/) |
| F-15E 拍一张 patch | 3–7 s 凝视 + "好几秒"处理 | [Air Power Australia](https://www.ausairpower.net/TE-F-15E-Strike-Eagle.html) |
| JSTARS SAR 一幅 | "several seconds"（MTI 报告接近实时） | [Forecast APY-3](https://www.forecastinternational.com/archive/disp_pdf.cfm?DACH_RECNO=406) |
| Global Hawk 到特战队员 PDA | 请求→到手 2–3 分钟（跨链路+人工） | [Forecast ISS](https://www.forecastinternational.com/archive/disp_pdf.cfm?DACH_RECNO=1460) |
| 单块 128 m patch 端到端（我们） | 2 s 采集 + ~3.5–8 s 计算 ≈ 6–10 s | `aesa/docs/sar-in-mission.md:39` |

**结论**：驾驶舱内的 patch 等待就是**秒级（约 3–10 s）**，我们目前的量级是**对的**；差距不在速度，而在"拿到图之后能干什么"。【有据 + 推测混合，标注清楚】

---

### 6. 明确区分：有据 / 推测

**有据（公开可查）**：APG-70 档位表与 45° 偏轴、3–7 s 凝视；ASARS-2A 3–1 m / 0.9–0.3 m；GH 1 m/10 km 条带与 0.3 m spot、138,000 km²、15,000 km²/min、±45° 斜视、2–3 min 交付；JSTARS 250 km/50,000 km²/±60°/18 台/SAR several seconds；ViSAR 235 GHz、>5 Hz、0.2 m；NIIRS 任务级定义；Lynx 0.1/0.3 m、实时、CCD、ACD；DOT&E 关于 F-35 SAR 生成武器级坐标并被编队共享；NASA/Capella 的判读要素。

**推测/未证实**：F-35 SAR 具体分辨率（从未公开，m 级为估计）；JSTARS SAR 分辨率；Sentinel R1 的 5 m（与亚米级说法矛盾）；GH "every 10…"的时间单位；"典型 F-35 用 20–40 nm 斜距、5–15° 掠射角"（我按高度/距离推的合理区间）；DBS 盲锥 ±10–15°（行业入门资料，[rfessentials](https://rfessentials.com/resources/rf-glossary/dbs/)）等二手条目。

---

### 7. 对我们仿真的启示（按重要性排序）

对照现状：`aesa/docs/sar-in-mission.md`、`design-sar-prototype.md`、`sar-surface-quality.md`（128/512/2048 m 切片、1/4/8 m 像素、75/150 MHz、2 s 孔径、~6–10 s/张、50 张世界锚定拼接、MAP 实波束底图、斜视 20–160° 门控）。

1. **补阴影（shadow）与叠掩（layover）——这是"不像真 SAR"的第一原因。**
   真实 SAR 判读一半信息来自阴影（目标轮廓、朝向、高度）；我们明确"对倾斜/起伏地形的阴影/叠掩尚未建模"（`sar-in-mission.md:163`），只有 MAP 底图有 DEM 遮蔽（`sar-in-mission.md:79-92`）。建议：SAR patch 合成里加入 DEM 射线遮挡与简单 layover 投影；并把默认几何推向**低掠射角/大斜距**（真实是 70,000 ft + 100+ km 的 standoff），而不是 DCS 常见的"几 km 高、十几 km 距离"俯视几何——俯视不产生阴影，看起来就"平"。

2. **做出"打击工具"而不是"一张图"：坐标工作流。**
   F-35 实战用法是 SAR 图 → 光标取武器级坐标 → 编队共享验证（DOT&E）。我们现在只有 hover 世界坐标（`sar-in-mission.md:148`），没有**十字线锁定目标 → 生成经纬度/MGRS → 目标清单/标记共享**的流程。加入目标标记（cursor designate）、坐标读出、标记列表与"下发到编队/座舱"的显示语义，会立刻接近真实使用感受。

3. **GMTI/动目标叠加缺失。**
   几乎每个真实产品的默认画面都是 SAR 底图 + MTI 符号叠加（JSTARS、F-15E 的闪烁矩形、Lynx cross-cue）。我们的 DCS 世界里车辆/舰船运动是现成的真值，做出**闪烁/带速度矢量的动目标符号叠加在 SAR/MAP 上**成本低、收益极大。

4. **把"条带/回访"做成第一类公民，而不是瓦片拼接。**
   真实广义覆盖靠 stripmap 连续条带 + 周期性回访（JSTARS 地面基准重访、GH 10 km 条带、Lynx 条带互拼）。我们目前是 512 m 固定世界瓦片一块块拍、拼接层"后贴覆盖先贴、旧图变淡"（`sar-in-mission.md:109-122`），既非条带也无回访节拍。建议：以航迹为基准输出**连续条带帧**（沿航迹滑动窗口），并给每个区域记"上次成像时间"，把回访做成可见的时序。

5. **变化检测（ACD/CCD）是我们已有能力的"免费升级"。**
   拼接层已经保留同一世界坐标的多张图；Lynx 级 ACD（两次成像相减高亮）在此数据结构上几乎可直接实现，且这正是真实 SAR 最有说服力的用法之一（波斯尼亚撤军核查、车辙检测）。可先做 ACD，CCD 作为后续（需相位/配准，成本高）。

6. **显示形态：方向/网格/阴影朝向约定。**
   传统判读要求"阴影朝观察者"、北向对齐、带坐标网格；我们的拼接画布已有 N↑/航向↑ 之类选项（`status.md`），但 SAR 图本身的**地距/斜距标注、比例尺、阴影方向约定**还缺。这些小元素是"像不像真产品"的决定性细节。

7. **辐射一致性：per-image 峰值归一化破坏"产品感"。**
   我们每张图独立峰值归一化（`sar-surface-quality.md:11`），拼接后亮度斑驳；真实 mosaic 产品做辐射/几何配准。建议：以场景漫反射参考做**跨图一致归一化**（至少在同一 mosaic 内），这也是 ACD 的前提。

8. **分辨率与"识别能力"的诚实表达（顺带提升观感）。**
   8 m 地形 + 无建筑散射 → 永远出不了 NIIRS 高等级内容（`sar-in-mission.md:177`）。方案有二：a) 接入碰撞包围盒生成 roof/wall 散射样本（`design-sar-airport.md:27` 已规划）＋转角反射增强亮点；b) 明确把产品定位为"地面纹理/散布"级别，不承诺识别。真实 0.3 m spot 才会出现"车辆+车影"那种画面，我们要么做到，要么不要假装。

9. **伪影现实感：噪声底、强散射旁瓣、动态范围。**
   真实 SAR 图有噪声底、强目标旁瓣条、模糊/RFI 条纹；我们的合成结果"太干净"。加一个可调的噪声底与强点旁瓣回注，观感会显著更像真实雷达图（成本低）。

10. **节奏：保持秒级，不要为"实时"过度工程。**
    真实 patch 等待 3–10 s，我们的 ~6–10 s 已在窗口内（对比 §5）。真正缺的是 **ViSAR 式的目标级视频**（≥5 Hz，仅在极小 patch 上可行）和 **条带连续更新**；这两者需要频域/GPU 路径（`worklog/2026-10-09` 已把回波合成列为瓶颈）。可把"快速档 + 128 m patch 自动连续"当成"准视频"体验档，而不宣称 ViSAR。

11. **（次要）斜视窗口校准。**
    门控 20–160° 过宽：真实 SAR 有前视盲锥（±10–15°）、偏好 30–70° 斜视（DBS/战斗机 45° 最优）。建议把"最优窗口"设成 30–60°，把 90° 正侧视为可接受但非最优；这会顺带让几何更接近实战剖面。

---

#### 附：本次来源清单（≥20 条，英文为主）

官方/教科书级：NASA Earthdata、FAS（ASARS-2、Radar NIIRS）、Sandia 新闻稿、DARPA ViSAR（经 Military Embedded/Avionics International 转述）、USAF ASQ-236、DOT&E FY2016、AFI 11-2F-15E V3、Forecast International（GH ISS / APY-3 / ASTOR）、GA-ASI Lynx、Northrop Grumman APG-81、Air & Space Forces。
学术/行业：MDPI（车辙 CCD、ViSAR 帧率）、rfessentials DBS 词条、Capella SAR 101、Stimson 教科书引文、University of Lucknow 遥感讲义、NRCan、Air Power Australia F-15E 专文、Dragon Lady Today、BCAR、Wikipedia（NIIRS/E-8）。

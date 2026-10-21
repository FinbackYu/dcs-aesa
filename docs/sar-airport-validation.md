# SAR 地表与机场开发验证

- 状态：historical（2026-10-18 归档）

本页描述 `codex/sar-airport-mapping` 的新流程。旧小切片文档记录的是此前仅高程、固定 128 m 的版本，不能据此判断新版能力。新模型仍是原理验证，不是 DCS 输出的真实雷达回波。

## 安装与采集

在仓库中执行以下开发部署；脚本明确选择 Saved Games，编译 Lua 5.1，拒绝覆盖不明文件，保留备份和独立清单。无需修改游戏安装目录或任务沙箱。

```powershell
$env:AESA_LUA = '<Lua 5.1 可执行文件>'
$sarTarget = '<实际 DCS Saved Games 目录>'
node scripts/install_sar.cjs repair --saved-games $sarTarget
node scripts/install_sar_scene.cjs install --saved-games $sarTarget
node scripts/install_sar.cjs verify --saved-games $sarTarget
node scripts/install_sar_scene.cjs verify --saved-games $sarTarget
node tools/sar_live.cjs --quality fine --scene-model classified
```

新增 Hooks 需重启 DCS。打开本机 `http://127.0.0.1:3593`，先看 Export 版本及任务桥接能力。桥接仅尝试已可调用的 `a_do_script` 或 `net.dostring_in`，安装脚本不修改 unsafe API 权限；禁止把接口存在当成调用成功。任务未加载时每 5 秒重新探测，不弹游戏消息。

2026-10-08 实机结论：Hook 环境无 `a_do_script`；未配置 autoexec.cfg 时 `net.dostring_in` 虽存在但代码不落任务状态（探测返回 `CAP,unavailable,unavailable` 即此情形，不代表桥接通）。用户已在本机手动创建 `Saved Games\DCS\Config\autoexec.cfg` 声明 `net.allow_unsafe_api={"userhooks"}`、`net.allow_dostring_in={"mission"}`（依据 `API/Sim_ControlAPI.md` §net.dostring_in）后桥接可用；部署脚本仍不代为修改该文件，其他机器需同样手动开启。

1. 先在 F10 找到已知机场，填写其经纬度；推荐机场相对航迹在侧前方 30–60°、地距 10–30 km，平稳飞行。高度应超过整块地形至少 50 m，接口采集仍允许地距 1–50 km。
2. 范围选择 **512 m 区域** 或 **2048 m 概览**，散射选择分类模型，按坐标采集。2 km 未必能包含完整机场，移中心采集其他部分；飞得更高不会自动改变选区范围。
3. 地表图切换“地表分类”，确认是否真实取得 runway/road/water。`land.getSurfaceType` 的 runway 是 API 标签，不保证只对应跑道；机场铺面覆盖与分类边界仍需实测，不能当作精确建筑材质图。
4. 看本张输入说明中的地表 provider、对象 provider、有包围盒对象数和跳过数。没有对象、对象接口不可用、无几何被跳过是不同情况。Export 分类可能仅 land/sea；不会凭机场位置生成跑道标签。
5. 在雷达主视图（或地表/SAR 图）上单击目标点，服务端按当前位姿判定几何（地距 1–50 km、相对航迹角 20–160° 侧视窗），可成像时按“SAR 精看 128 m”采集新的 2 s 航迹；MAP 巡逻不需要停止，指定采集抢占 MAP 采集、完成后巡逻自动恢复。局部精细为 150 MHz、0.5 m 输出；旧概览重算仍保留其实际范围/网格，不会变成局部。
6. F10 实时窗口仍由用户主动共享。复制扫描中心到游戏内对照；F10 不自动定位或与 SAR 配准。高程和 SAR 使用同一完成图及配对输入。

连续采集保持原先的一键开始/停止、等待断线/暂停恢复和可选保存。较大概览计算显著变慢，默认仍为 128 m，不能承诺无缝覆盖。关闭浏览器不会停止后台连续采集。

## 数据与模型

| 范围 | DEM/分类 | 散射间隔 | 输出 | 假设带宽 |
|---|---|---|---|---|
| 128 m | 17² / 8 m | 1 m | 129²/1 m 或 257²/0.5 m | 75/150 MHz |
| 512 m | 33² / 16 m | 4 m | 129²/4 m | 37.5 MHz |
| 2048 m | 65² / 32 m | 16 m | 257²/8 m | 10 MHz |

输出间距不是地物分辨率。概览的地距点响应在斜视下可明显粗于输出像素；散射点密度也限制纹理保真度。

- `uniform` 保留 surface-v2 对照：统一系数、无材质/对象散射点（地形与包围盒遮挡同样生效，见 [表面散射与质量检查](sar-surface-quality.md)），遥测帧直接采样可能混叠。
- `classified` 的 scene-v3 使用显式假设功率系数：陆地/未知 1、浅水 .08、水 .015、道路 .12、跑道 .06，另乘余弦入射。未知明确报告，不当作已取得真实材质；这组系数没有实测校准，不保证所有真实水面或铺面都更暗。
- `world.searchObjects` 查询地景、静态和地面单位，最多访问 512 个、输出 128 个有几何对象；运动速度 >1 m/s 或空中对象不进入静止模型。报告几何缺失/移动跳过及是否达到查询预算。碰撞包围盒不是外观模型，固定朝向盒面产生屋顶/墙面散射，最多建模 32 个、2048 个面样本；对象未按最终图像涂亮。
- 局部阴影使用双线性 DEM 半网格射线采样及朝向盒体相交。不知道飞机到扫描区之间的外部地形，也没有建筑细节、多径、双次反射、真实粗糙度或动态目标成像；这些限制在元数据中保留。
- 遥测帧是导航位置，不等于雷达脉冲。新模型按全地形及盒面估算相对于中心的最大 Doppler，模拟 PRF 至少为其绝对值的 2.5 倍。原始连续有效导航帧间线性插值生成模拟脉冲；没有增加实测位置精度。原轨迹间隙 >.25 s、异常速度/时间仍拒绝；不插过长缺测。上限 8192 脉冲、512 MiB 回波历史，超限明确拒绝。

一块平地仍可能有相干散斑，平坦也不代表均匀灰度。现在可以验证地表边界和简化对象是否改变回波，但不得把某个亮点直接认定为机库或飞机。

## 可复现检查

```powershell
node scripts/sar_airport_probe.cjs
node --test tests/test_sar_scene.cjs tests/test_sar_pulses.cjs tests/test_install_sar_scene.cjs
```

合成检查输出到忽略的 `recordings/sar-airport-probe/`，明确标为 synthetic-demo。已知 512 m 场景包括 64 m 铺装带、坡面和一个盒体；实际导航 31 帧、803 个模拟脉冲。一次开发测量中旧统一系数对照的铺装带/陆地为 −0.18 dB，新模型为 −12.40 dB，符合设置的系数量级；分类模型约 37.5 s。两种对照都用充分模拟脉冲，区别进入回波合成，并非最终图像绘制。机器、视角、对象数改变耗时。

使用遥测帧直接当脉冲的旧粗采样，扩大选区后出现混叠，分类设定容易在成像中被冲淡。回归检查因此同时测试模拟采样预算与聚焦后亮暗差异，不只断言类别系数。

任务桥接实机可调用性、地图分类边界、地景包围盒覆盖和机场 SAR 效果均需机场实飞确认。模拟接口和合成对照不替代实飞。已有历史快照可恢复并重算，但不会补出此前未采集的地表/对象。

## 修复与卸载

分别运行 `install_sar_scene.cjs repair|uninstall --saved-games $sarTarget` 和 `install_sar.cjs repair|uninstall --saved-games $sarTarget`。Hook 卸载只移除经清单哈希验证的自身文件；Export 按标记保留其他插件加载块。二者有独立清单，不删除其他 Hook 或整个目录。备份按原件哈希保留。

接口依据及环境区别见 [地图/地形接口研究](dcs-map-terrain-interfaces.md)，新实现边界见 [开发设计](design-sar-airport.md)。桥接限制同时核对了 DCS 安装内的 `API/Sim_ControlAPI.md` 中 net.dostring_in 的既有权限要求；部署脚本不代为修改 autoexec.cfg，需要时由用户按该文档手动声明（本机已于 2026-10-08 手动开启，见上文）。

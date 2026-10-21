# DCS 地形、地图接口与 SAR 三栏对照

- 状态：current（2026-10-18 复核）

核查日期：2026-10-01。任务脚本、Export、GUI 是不同 Lua 环境，不能因某个接口在文档中存在就假定 Export 可以调用。下表区分接口能力与本项目实际接入状态。

## 地形、坐标和对象

| 环境 / 接口 | 能取得什么 | 限制与接入状态 |
|---|---|---|
| 任务 `land.getHeight(Vec2)` | 任意地图点的地表海拔 | 地表几何，不是完整建筑表面；任务环境尚未桥接 |
| 任务 `land.getSurfaceType(Vec2)` | LAND、SHALLOW_WATER、WATER、ROAD、RUNWAY | 粗分类，不提供森林/城市完整分类、贴图或电磁材质；未接入 |
| 任务 `land.isVisible(from,to)` | 两点之间的地形视线通畅与否 | 官方明确不计单位、静态和地景对象；未接入 |
| 任务 `land.getIP(from,direction,maxDistance)` | 射线与地形的交点 | 地形相交，不是建筑网格相交；未接入 |
| 任务 `land.profile(from,to)` | 两个水平位置之间的地形剖面 | 官方说明只使用输入 x/z；不是地形图像；未接入 |
| 任务 `coord.LLtoLO / LOtoLL` | 经纬度与 DCS 世界坐标转换 | `LLtoLO` 参数为纬度、经度，与 Export 的对应函数顺序不同 |
| 任务 `coord.LLtoMGRS / MGRStoLL` | 经纬度与 MGRS 转换 | 当前页面仅输入经纬度，未接入 MGRS |
| 任务 `world.searchObjects(SCENERY,volume,handler)` | 搜索范围内的地景对象 | 地图/对象覆盖要实测；不能宣称所有建筑和树木均可查询 |
| 对象 `getPoint / getPosition / getDesc` | 位置、朝向和描述；`box` 为碰撞包围盒 | 不代表完整可见模型、材质、屋顶细节或雷达反射率；未接入 |
| Export `terrain.GetHeight(x,z)` | 指定位置的地表海拔 | 本机官方脚本调用先例 + 当前实飞验证；已用于 17×17 / 8 m 地形采集；MAP 粗格（`CAPTURE_MAP`，默认 250 m、17 格/帧）复用同一入口 |
| Export `terrain.GetSurfaceType(x,z)` | 指定位置的地表粗分类 | 与任务 `land.getSurfaceType` 同源；小切片与 MAP 粗格都优先用它，任务桥接作为补充 |
| Export `LoGeoCoordinatesToLoCoordinates(longitude,latitude)` | 经纬度转世界坐标 | 已用于定点扫描；注意经度在前 |
| Export `LoLoCoordinatesToGeoCoordinates(x,z)` | 世界坐标转中心经纬度 | 当前实飞已返回；兼容 `LoCoordinatesToGeoCoordinates` 名称 |
| Export `LoGetAltitudeAboveSeaLevel / AboveGroundLevel` | 本机海拔 / 离地高度 | 本机数据，不能作为任意远处点的高程查询 |
| Export `LoGetHeightWithObjects()` | 本机离含物体表面的高度 | 官方安装文件明确为零参数；不能传扫描坐标读取远处屋顶 |
| Export `LoGetAltitude(x,z)` | 官方注释称 altitude above terrain surface | 保留机下诊断，不自动作为地形提供者；任意位置语义未验证 |
| Export `LoGetCameraPosition()` | 当前观察相机的位姿 | 不是 F10 图像，也不直接提供卫星贴图、完整投影或扫描区配准 |

任务 API 来源：[ED 单例说明](https://www.digitalcombatsimulator.com/en/support/faq/1257/)、[ED 对象说明](https://www.digitalcombatsimulator.com/es/support/faq/1648/)。Vec3 的 y 是海拔；任务地形 Vec2 使用 `{x=world.x,y=world.z}`。

Export 来源为本机 DCS 安装的 `Scripts/Export.lua` 和 `API/Sim_ControlAPI.md`，不复制游戏文件入库。2026-10-01 查到前者 `LoGetHeightWithObjects()` 的明确签名，更新了此前仅从控制 API 名称清单无法判断用途的结论。

## F10 图像的边界

这里的 F10 指游戏内按 F10 打开的地图视角。核查公开任务文档和本机 Export 清单后，尚未找到可直接向外部程序取得 F10 卫星画面、离屏瓦片或指定坐标光学切片的公开接口。这是“未找到并验证”，不是证明引擎不存在内部入口。

本机 GUI 脚本确实使用 `GUIMapView.new()`、`initEDTerrainGraphics()` 等构建地图组件；例如 `Scripts/UI/InstantActionGenerator/InstantActionEditor.lua`。这属于内部 GUI 环境，不能直接当作 Export 的图像服务；本次没有修改 GUI、截取内部渲染纹理或写入安装目录。

当前选用浏览器窗口共享显示真实 DCS 窗口，不用现实世界卫星图替代游戏地图。点击“选择 DCS 窗口”，在浏览器弹窗中选择游戏窗口，再在游戏中打开 F10 卫星视图。窗口共享只在页面视频元素里播放，不采集音频、不录制、不上传帧。停止、浏览器结束共享、页面离开或播放失败时释放媒体轨道。

浏览器必须由用户主动点击后请求授权；网页不能静默选择 DCS，也不能保证用户实际选择了哪个窗口。需用支持 `getDisplayMedia` 的 Edge/Chrome 打开本机页面；浏览器/系统设置可能限制捕获，最小化或独占全屏也可能让画面暂停或不可用。[MDN 窗口共享 API](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)

## 三栏怎么对照

1. 左栏：所选 DCS 窗口的当前画面。进入 F10 后显示 F10；返回座舱后显示座舱。不是独立的离屏地图，不自动跟踪扫描中心。
2. 中栏：当前已显示 SAR 图对应的 17×17 原始地表高程；129² 双线性显示，输入间隔仍为 8 m。蓝到黄映射本张最小/最大海拔，并标出实际起伏。无建筑屋顶，不能当作 SAR 测高结果。
3. 右栏：同一中心、同一方向、同为 128×128 m 的 SAR 模拟图。两图横轴为视线横向、纵轴上方为远距；不是北向地图。

鼠标在高程/SAR 任一图上移动，十字线联动，显示横向/地距偏移、插值地表海拔、相对峰值功率和 DCS 世界 x/z。地图中心同时以十进制度、度分秒显示并可复制。F10 仍需在游戏中移动/缩放到对应中心；此栏未校准投影、方向和尺度，不能把左栏任意像素与右两栏直接一一对应。无确认经纬度的旧录制或合成演示不猜测地理位置。

连续模式下，下一张采集/计算时继续保留上一张图。`GET /state` 的 `reference` 与已显示图在同一次响应中返回，含 completed、source、center、bearing、size、n、heights，来自 `displayedScene`，不能用 `/scene` 中正在处理的新输入替代。页面只有完成时间一致才使用 reference；单次新采集清空旧图时也清空高程和中心。

图像有完成时间和数据来源，断线后保留历史图而不是假称实时扫描。高程色标和 SAR 峰值归一化各按本张范围，不能据此跨图比较绝对回波。窗口视频是当前画面，SAR 是完成采集后的历史区域，两者时间不自动同步。

## 保存与恢复

`GET /snapshot` 原子返回已完成图像、完成时间、对应中心和对应原始 scene；无已完成图像时返回 409。此接口返回 JSON，不包含窗口视频。将返回内容保存到项目忽略目录，再用 `--restore-display snapshot.json` 重启，可恢复历史图和对应原始高程/轨迹，保留原完成时间、开放重算并显示“对应原始输入已恢复”。

不含 scene 的旧图像快照仍可恢复图像，明确显示“原始输入未恢复”，无高程参考也不能重算。恢复场景经几何/轨迹校验，并检查来源、范围和目标信息；不能把另一位置的原始输入塞进快照。快照应从同一服务响应取得，不能任意拼接图像与场景。

后续要做到游戏内自动显示扫描框、地图自动定位或精确图像配准，需要单独验证任务/GUI 桥接及投影信息。本步没有添加任务脚本、启用 unsafe API 或修改任务沙箱。

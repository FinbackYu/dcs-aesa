# edterrain4 / landscape4·landscape5 地形结构测绘

- 状态：external-reference（2026-10-18 复核）

核查日期：2026-10-17
目标：回答“注入 DLL 能否在 CPU 侧按世界坐标 (x,z) 直接查询细粒度地表类别、道路/铁路矢量、物体摆放，入口和方法各是什么”。

核查对象（只读，未写入、未解包大文件）：

- `<DCS>\bin\edterrain4.dll`
- 同目录 `Inter.dll`、`edCore.dll`、`edterrainCore.dll`、`edterrainExtra4.dll`、`edterrainGraphics41.dll`、`Terrain.dll`、`lua-terrain.dll`
- `<DCS>\Mods\terrains\` 下 6 张地图的目录结构与文件头

证据等级：

- **实证**：导出表、文件头、运行时调用结果可直接复现。
- **强推断**：由 ABI、vtable 槽位、调用点反汇编交叉验证，但没有头文件/PDB 直接确认。
- **推测**：语义解释或尚未实测的映射，文中明确标注。

---

## 0. 结论（TL;DR）

| 问题 | 结论 | 入口 |
|---|---|---|
| 细粒度地表类别 | **有，可直接 CPU 查询** | `edterrain::ITerrain::GetDefaultTerrain()` → vtable 槽位 19（字节偏移 `0x98`）→ `ITerrainImpl4::getPointOnSurface(osg::Vec3d const&, PointOnSurface::InternalCache*)`；返回结构 `+0x38` 是 8 字节地表类型掩码（强推断为 64 位 `enSurfaceTypes`） |
| 掩码精度 | 24 个 bit 位置中 **16 个已命名**，远细于 Lua 的 5 类 | `edterrain::getSurfaceTypeName(uint64)` / `getSurfaceTypesName(uint64)`（`Inter.dll` 导出） |
| 道路/铁路矢量 | **有** | `ITerrainImpl4::getRoadNetwork("roads" / "railroads")`（vtable 槽位 50 / `0x190`）→ `IRoadNetwork`；实现类 `IRoadNetworkImpl4` 的 `roadsCount()` / `getRoad(int)` / `findClosestPoint` / `getPoint` 等 |
| 道路几何点 | **有两条路** | 运行期：`IRoadNetworkImpl4` + `edterrain::buildPolylineForRoute`；离线：`landscape4::lRoadNetwork::load("*.rn4")` → `lRoad::getSubRoadVerts` |
| 物体摆放 | **有** | 运行期：`ITerrainImpl4::querySceneObjectsCB`（槽位 27–30）+ `getSceneObjectPosition/Type/Seed/Args`（槽位 35–39）；离线：`landscape5::Scene5File`（`*.scn5`）的 `objectsCount/getObjectPosition/...` |
| 植被/运行时实例 | **有** | `landscape5::Surface5File::querySceneObjects` / `queryRuntimeSceneObjects` |
| 资产实例（点/样条/网格） | **有** | `vd5::VectorData` 的 `pointsCount/pointInstance/splinesCount/splineInstance`；`assets::lLinked::PointInstance/SplineInstance` |
| 是否需要读 GPU 资源 | **不需要** | 以上全部是 CPU 侧对象/文件读取；`edterrainGraphics41.dll` 是渲染侧，与本问题无关 |

一句话：**存在可直接调用的细粒度表面查询**，入口不是 `lTerraDispatchImpl` 的某个公开方法，而是 `edterrain::ITerrain` 接口的 `getPointOnSurface` 虚函数；`lTerraDispatchImpl` 本身的方法几乎全部没有导出名，不能从导出表直接调用。

---

## 1. 测绘方法与二进制事实

### 1.1 工具链与障碍

- 用 `<repo>/.tools\mingw-root\mingw64\bin\objdump.exe -p` 读 PE 导出表。
- MinGW 自带的 `c++filt.exe` **不支持 MSVC 名字反混淆**（`-s msvc` 报 unknown demangling style）。实际使用 Windows `dbghelp.dll` 的 `UnDecorateSymbolName`，通过 Python `ctypes` 调用，逐条反混淆。
- `edterrain4.dll` 是 **UPX 打包**的：节表为 `.UPX0/.UPX1/.UPX2`，`.text` 的 Size 为 0。导出表完整可读，但**不能直接静态反汇编函数体**（文件里的代码是压缩/跳板）。本文的 vtable 数据来自“加载 DLL 让 UPX 在内存中解包后读虚表”，不是静态反汇编。
- `edterrainCore.dll`、`edterrainExtra4.dll`、`edterrainGraphics41.dll`、`Terrain.dll`、`lua-terrain.dll` 未打包，可静态反汇编；`Inter.dll` 也是 UPX。

复现命令（节选）：

```bash
OBJ="<repo>/.tools/mingw-root/mingw64/bin/objdump.exe"
"$OBJ" -p "<DCS>/bin/edterrain4.dll" \
  | sed -n 's/^\t\[ *\([0-9]*\)\].*[[:space:]]\(\?[^[:space:]]*\)$/\1\t\2/p'
```

反混淆用 Python + `dbghelp`：

```python
import ctypes
d = ctypes.WinDLL("dbghelp")
f = d.UnDecorateSymbolName
f.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint, ctypes.c_uint]
f.restype = ctypes.c_uint
out = ctypes.create_string_buffer(32768)
f(b"?GetTerraDispatch@landscape4@@YAPEAVlTerraDispatchImpl@1@XZ", out, len(out), 0)
print(out.value.decode())
# class landscape4::lTerraDispatchImpl * __ptr64 __cdecl landscape4::GetTerraDispatch(void)
```

### 1.2 导出表规模

`objdump -p` 的 Name Pointer 表约 1500 条名字，覆盖：

- `landscape4`：`lTerraDispatchImpl`、`lRoadNetwork`、`lRoad`、`lRoutesFile`、`lPointOnSurface`、`lReferenceFile`、`MaterialAlias`、`BSPUtils3` 等。
- `landscape5`：`Surface5File`、`Scene5File`、`SurfaceTile`、`navGraph5File`、`sup5File`、`lsa5File`、`lsa5pureFile`、`scene5::GeometryHandler50/52` 等。
- `assets`：`lAssetFile`、`lPointAsset`、`lSplineAsset`、`lMeshAsset`、`lLinked::PointInstance/SplineInstance/MeshInstance`。
- `vd5`：`VectorData`、`PointInst`、`SplineInst`、`MeshInst`、`MetaInst`、`PointInstBinding`。
- `edterrain`：`ITerrain`、`ITerrainImpl4`、`IRoadNetwork`、`IRoadNetworkImpl4`、`IRoute`、`PointOnSurface`、`PointOnRoad`、`SurfaceEdgeData` 等。

关键全局入口（`edterrain4.dll`）：

- `?CreateTerraDispatch@landscape4@@YAPEAVlTerraDispatchImpl@1@XZ`
- `?GetTerraDispatch@landscape4@@YAPEAVlTerraDispatchImpl@1@XZ`
- `?SetTerraDispatch@landscape4@@YAXPEAVlTerraDispatchImpl@1@@Z`
- `?DeleteTerraDispatch@landscape4@@YAXPEAVlTerraDispatchImpl@1@@Z`
- `?CreateITerrainStub@landscape4@@YAPEAVITerrain@edterrain@@PEAVlTerraDispatchImpl@1@@Z`
- `?GetTerraDispatchCore@landscape4@@YAPEAVTerraDispatchCore@1@XZ`

`Inter.dll` 里的高层入口：

- `?GetDefaultTerrain@ITerrain@edterrain@@SAPEAV12@XZ`（返回当前活动地形）
- `?getSurfaceTypeByName@edterrain@@YA_KAEBV?$basic_string@D@ed@@@Z`
- `?getSurfaceTypeName@edterrain@@YAPEBD_K@Z`
- `?getSurfaceTypesName@edterrain@@YA?AV?$basic_string@D@ed@@_K@Z`

### 1.3 `lTerraDispatchImpl` 的方法为什么列不全

这是本任务最需要澄清的一点。

- 导出表里 **没有任何 `lTerraDispatchImpl::` 成员函数**。只有上面的 `Create/Get/Set/Delete` 自由函数、`CreateITerrainStub` 和构造函数 `ITerrainImpl4::ITerrainImpl4(lTerraDispatchImpl*)`。
- 运行时读取 `CreateTerraDispatch()` 返回对象的虚表：共 **61 个有效槽位（0–60）**。其中若干槽位被 ICF（相同代码折叠）合并到已有符号（例如 31–34 合并到 `landscape4::lRoad::calculateRoadParts`），其余槽位都指向没有导出名的内部函数。
- 因此无法从当前二进制恢复 `lTerraDispatchImpl` 的方法名和签名，更无法按“表面/高度/landuse 查询方法”逐条列出。它更像内部调度器/资源管理器；对外真正可调用的是它创建出来的 `ITerrainImpl4`。
- `GetTerraDispatchCore()` 在本次独立进程（未初始化地形）里返回 `nullptr`；其 vtable 无法在无地形上下文时取得，本文不把它作为可用入口。

**强推断**：`lTerraDispatchImpl` 的查询能力通过 `ITerrainImpl4` 暴露；不要试图按固定偏移调用 `lTerraDispatchImpl` 的未命名槽位。

### 1.4 `ITerrainImpl4` 虚表（可调用接口）

用 `CreateTerraDispatch()` + `CreateITerrainStub()` 取得一个 `edterrain::ITerrain*`，读其虚表，并与导出表 RVA 对照，得到下表。`ITerrainImpl4` 的 vtable 与 `edterrain::ITerrain` 的前缀一致；这一点由 `CreateITerrainStub` 返回的 `ITerrain*` 直接验证。

| 槽位 | 字节偏移 | 方法（反混淆后） |
|---:|---:|---|
| 0 | `0x00` | `ITerrainImpl4::openTerrain(char const*, lua_State*, ed::ITerrainSecurity*)` |
| 1 | `0x08` | `ITerrainImpl4::createContext() const` |
| 2 | `0x10` | `ITerrainImpl4::setCurrentContext(ITerrainContext*)` |
| 3 | `0x18` | 未命名（ICF 合并到 `vd5::MeshInst::asset` 一类的小 getter） |
| 4 | `0x20` | 未命名（RVA `0x23300`） |
| 5 | `0x28` | `ITerrainImpl4::release()` |
| 6 | `0x30` | `ITerrainImpl4::getTerrainCfg()` |
| 7 | `0x38` | `ITerrainImpl4::getSeaLevel() const` |
| 8 | `0x40` | `ITerrainImpl4::init(char const*, std::function<void(float, ed::basic_string<char> const&)>)` |
| 9 | `0x48` | `ITerrainImpl4::exit(char const*)` |
| 10 | `0x50` | `ITerrainImpl4::setDate(int,int)` |
| 11 | `0x58` | `ITerrainImpl4::getCurrentSeasonName() const` |
| 12 | `0x60` | `ITerrainImpl4::getTechSkinByDate(int,int)` |
| 13 | `0x68` | `ITerrainImpl4::getTempratureRangeByDate(int,int)` |
| 14 | `0x70` | `ITerrainImpl4::setTextureMode(bool)` |
| 15 | `0x78` | `ITerrainImpl4::getTextureMode() const` |
| 16 | `0x80` | 未命名（RVA `0x25160`，转发到 `[rax+0x88]`） |
| 17 | `0x88` | `ITerrainImpl4::getDirtyHeight(double,double,double)` |
| 18 | `0x90` | `ITerrainImpl4::getGeoPointByName(ed::basic_string<char> const&)` |
| **19** | **`0x98`** | **`ITerrainImpl4::getPointOnSurface(osg::Vec3d const&, PointOnSurface::InternalCache*) const`** |
| 20 | `0xA0` | 未命名（RVA `0x25550`，构造/清零一个结构） |
| 21 | `0xA8` | 未命名（RVA `0x25540`，`movsd 0x8(%rdx),%xmm0; ret`） |
| 22 | `0xB0` | 未命名（RVA `0x263c0`，写入 `{0,1.0,0}` 的小函数） |
| 23 | `0xB8` | `ITerrainImpl4::intersection(osg::Vec3d const&, osg::Vec3d const&) const` |
| 24 | `0xC0` | `ITerrainImpl4::envelope(osg::Vec3d const&, osg::Vec3d const&, osg::Vec3f*, int) const` |
| 25 | `0xC8` | `ITerrainImpl4::querySurfaceMesh(osg::BoundingBox, osg::Matrixd const&, int, vector<Vec3f>&, vector<Vec3i>&) const` |
| 26 | `0xD0` | 未命名（ICF 合并到 `assets::lPointAsset::CenterLine::getEndCrossroad`） |
| 27 | `0xD8` | `ITerrainImpl4::querySceneObjectsCB(osg::BoundingBox, uint, function<enQueryObjectBehavior(uint, ModelIntersectionData const&)>) const` |
| 28 | `0xE0` | `ITerrainImpl4::querySceneObjectsCB(osg::Polytope, uint, function<enQueryObjectBehavior(uint, ModelIntersectionData const&)>) const` |
| 29 | `0xE8` | `ITerrainImpl4::querySceneObjectsCB(osg::Polytope, uint, function<enQueryObjectBehavior(uint)>) const` |
| 30 | `0xF0` | `ITerrainImpl4::querySceneObjectsCB(osg::Vec3d, osg::Vec3d, uint, function<enQueryObjectBehavior(uint, ModelIntersectionData const&)>) const` |
| 31–34 | `0xF8`–`0x110` | 未命名（ICF 合并到 `landscape4::lRoad::calculateRoadParts`，可能是纯虚/占位槽） |
| 35 | `0x118` | `ITerrainImpl4::getSceneObjectPosition(uint) const` → `osg::Matrixd` |
| 36 | `0x120` | `ITerrainImpl4::getSceneObjectType(uint) const` → `model::IModel*` |
| 37 | `0x128` | `ITerrainImpl4::getSceneObjectSeed(uint) const` → `float` |
| 38 | `0x130` | `ITerrainImpl4::getSceneObjectArgs(uint) const` → `model::IModelParams*` |
| 39 | `0x138` | `ITerrainImpl4::isSceneObjectValid(uint) const` |
| 40 | `0x140` | `ITerrainImpl4::parseMnemonicId(char const*)` |
| 41 | `0x148` | `ITerrainImpl4::toLatLon(double,double,double&,double&) const` |
| 42 | `0x150` | `ITerrainImpl4::toLatLon(osg::Vec3d const&,double&,double&) const` |
| 43 | `0x158` | `ITerrainImpl4::fromLatLon(double,double,double&,double&) const` |
| 44 | `0x160` | `ITerrainImpl4::fromLatLon(double,double,osg::Vec3d&) const` |
| 45 | `0x168` | `ITerrainImpl4::fromMGRStoLockon(ed::basic_string<char> const&,double&,double&) const` |
| 46 | `0x170` | `ITerrainImpl4::fromLockonToMGRS(double,double,int) const` |
| 47 | `0x178` | `ITerrainImpl4::fromUTMtoLockon(osg::Vec2d const&) const` |
| 48 | `0x180` | `ITerrainImpl4::queryAmbientSounds(osg::Vec3d const&,double,vector<AmbientSoundData>&)` |
| 49 | `0x188` | `ITerrainImpl4::getRasterChartCoverage(osg::BoundingBox, enRasterChartScale)` |
| **50** | **`0x190`** | **`ITerrainImpl4::getRoadNetwork(char const*)`** |
| 51 | `0x198` | `ITerrainImpl4::savePath(IRoute*, ed::basic_string<char> const&) const` |
| 52 | `0x1A0` | `ITerrainImpl4::loadPath(ed::basic_string<char> const&) const` |
| 53 | `0x1A8` | `ITerrainImpl4::getCivilTrafficRouteCount() const` |
| 54 | `0x1B0` | `ITerrainImpl4::getCivilTrafficRoute(int) const` |
| 55 | `0x1B8` | `ITerrainImpl4::getSemanticName(int)` |
| 56 | `0x1C0` | `ITerrainImpl4::createPathCB(osg::Vec3d const&, osg::Vec3d const&, uint, function<float(SurfaceEdgeData const&)>) const` |
| 57 | `0x1C8` | `ITerrainImpl4::findClosestValidPointCB(osg::Vec3d const&, function<float(SurfaceEdgeData const&)>) const` |
| 58 | `0x1D0` | `ITerrainImpl4::findZone(osg::Vec3d const&) const` |
| 59 | `0x1D8` | `ITerrainImpl4::getZone(int) const` |
| 60 | `0x1E0` | `ITerrainImpl4::querySurfaceMeshEx(SurfaceMeshQuery const&, SurfaceMesh&) const` |

**实证交叉点**：槽位 19 的 RVA 是 `0x255a0`；导出表 name-table ordinal 881 的 `?getPointOnSurface@ITerrainImpl4@@UEBA?AUPointOnSurface@edterrain@@AEBVVec3d@osg@@PEAUInternalCache@23@@Z` 的 RVA 也是 `0x255a0`。`lua-terrain.dll` 的 `Terrain.GetSurfaceType` 又正好调用 `vtable+0x98`（见 §2.3）。三者闭合。

---

## 2. 细粒度地表查询

### 2.1 入口与签名

导出符号（`edterrain4.dll`）：

```text
?getPointOnSurface@ITerrainImpl4@@UEBA?AUPointOnSurface@edterrain@@AEBVVec3d@osg@@PEAUInternalCache@23@@Z
```

反混淆：

```cpp
edterrain::PointOnSurface
ITerrainImpl4::getPointOnSurface(
    osg::Vec3d const& point,
    edterrain::PointOnSurface::InternalCache* cache) const;
```

调用链：

1. `GetModuleHandleA("Inter.dll")`。
2. `GetProcAddress` 取 `?GetDefaultTerrain@ITerrain@edterrain@@SAPEAV12@XZ`，调用得到 `edterrain::ITerrain*`。
3. 读该对象首 8 字节得到 vtable 指针。
4. 取 `vtable[19]`（字节偏移 `0x98`）。
5. 以 `osg::Vec3d{x, 1.0, z}`、`cache = nullptr` 调用。
6. 返回的 `PointOnSurface` 结构 **`+0x38` 处是 64 位地表类型掩码**。

`PointOnSurface` 的完整布局没有头文件/PDB，不能逐字段命名。已确认的事实：

- `lua-terrain.dll` 的 `Terrain.GetSurfaceType` 把返回结构放在栈上，随后执行 `mov -0x21(%rbp),%rax`；该结构的基址是 `rbp-0x59`，所以读取偏移是 `0x38`，而且是 **8 字节读取**。
- 用 `CreateITerrainStub` 返回的 stub 对象实测调用 `vtable[19]`：函数会把 `+0x38` 初始化为 `0xFFFFFFFFFFFFFFFF`，把 `+0x44` 初始化为 `-1`，把 `+0x48` 初始化为 `-1`。这证明 `+0x38` 确实是一个 8 字节字段（stub 无地形数据，返回的是哨兵值）。
- 结构至少 0x50 字节；建议调用方分配 0x80 字节并清零。

**强推断**：`+0x00` 是命中点 `osg::Vec3d`，`+0x18` 是法线 `osg::Vec3d`，`+0x30` 可能是高度/材质相关字段，`+0x38` 是 `uint64_t surfaceTypes`，`+0x40` 是两个 32 位字段（第二个为 `-1`），`+0x48` 是另一个 64 位 ID（`-1`）。没有头文件，不要依赖除 `+0x38` 之外的偏移。

尚未实测：真实地形上 `+0x38` 的数值与 `getSurfaceTypeName` 枚举、`Surface5File::verticalIntersection` 输出之间的逐点对照。因此“`+0x38` 就是 64 位 `enSurfaceTypes`”目前是**强推断**，不是实证；`+0x38` 是 8 字节字段本身是实证。

### 2.2 掩码语义：16 个已命名类别

`Inter.dll` 导出的三个解码函数是公开可调用的：

```text
?getSurfaceTypeByName@edterrain@@YA_KAEBV?$basic_string@D@ed@@@Z
?getSurfaceTypeName@edterrain@@YAPEBD_K@Z
?getSurfaceTypesName@edterrain@@YA?AV?$basic_string@D@ed@@_K@Z
```

反混淆：

```cpp
unsigned __int64 edterrain::getSurfaceTypeByName(ed::basic_string<char> const&);
char const*      edterrain::getSurfaceTypeName(unsigned __int64);
ed::basic_string<char> edterrain::getSurfaceTypesName(unsigned __int64);
```

运行时逐位调用 `getSurfaceTypeName(1ull << i)` 的结果（`i = 0..63`）：

| bit | 掩码 | 名称 | 备注 |
|---:|---:|---|---|
| 0 | `0x000001` | `Land` | |
| 1 | `0x000002` | `unknown` | 未命名 |
| 2 | `0x000004` | `Runway` | |
| 3 | `0x000008` | `unknown` | 未命名 |
| 4 | `0x000010` | `Sea` | |
| 5 | `0x000020` | `River` | |
| 6 | `0x000040` | `Lake` | |
| 7 | `0x000080` | `unknown` | `getSurfaceTypeByName("water")` 会带上这一位 |
| 8 | `0x000100` | `Road` | |
| 9 | `0x000200` | `Railway` | 铁路 |
| 10 | `0x000400` | `Town` | 城镇/建成区 |
| 11 | `0x000800` | `Field` | 田野 |
| 12 | `0x001000` | `Beach` | 海滩 |
| 13–15 | `0x002000`–`0x008000` | `unknown` | 未命名 |
| 16 | `0x010000` | `Building` | |
| 17 | `0x020000` | `Construction` | 施工/工地 |
| 18–19 | `0x040000`–`0x080000` | `unknown` | 未命名 |
| 20 | `0x100000` | `Trees` | 树木 |
| 21 | `0x200000` | `Forest` | 森林 |
| 22 | `0x400000` | `Traffic` | 交通流/道路上的动态语义 |
| 23 | `0x800000` | `ParticleEffect` | 粒子效果 |
| 24–63 | — | `unknown` | 当前未命名/未使用 |

组合验证（运行时调用 `getSurfaceTypesName`）：

- `0x1F05` → `"Land, Runway, Road, Railway, Town, Field, Beach"`
- `0xF0` → `"Sea, River, Lake, unknown"`
- `0xFFFFFF` → 上述 24 个 bit 名称的完整拼接

`getSurfaceTypeByName` 的实测别名：

- `"Land"` → `0x1`
- `"Runway"` → `0x4`
- `"Sea"` → `0x10`
- `"River"` → `0x20`
- `"Lake"` → `0x40`
- `"Road"` → `0x100`
- `"Railway"` → `0x200`
- `"Town"` → `0x400`
- `"Field"` → `0x800`
- `"Beach"` → `0x1000`
- `"Building"` → `0x10000`
- `"Construction"` → `0x20000`
- `"Trees"` → `0x100000`
- `"Forest"` → `0x200000`
- `"Traffic"` → `0x400000`
- `"ParticleEffect"` → `0x800000`
- `"water"` → `0xF0`（Sea | River | Lake | bit7）
- `"grass"` → `0`（不是有效名称）

**实证**：以上名称/掩码是直接调用 `Inter.dll` 导出函数得到的，不是从字符串猜测。

### 2.3 与 Lua 五类的关系

项目现有文档把任务环境 `land.getSurfaceType(Vec2)` 记为 5 类：`LAND、SHALLOW_WATER、WATER、ROAD、RUNWAY`（`aesa/docs/dcs-map-terrain-interfaces.md:10`）。本次没有在导出的 Lua 文件里找到小写 `land.getSurfaceType` 的绑定；本机能静态定位到的是 MissionEditor/InstantAction 使用的 `Terrain.GetSurfaceType`（两个平面坐标入参），其编辑器侧 Lua 绑定返回地表类型**字符串**（见 `MissionEditor/modules/me_map_window.lua:1085` 附近）。

`lua-terrain.dll` 的 `Terrain.GetSurfaceType` 反汇编（VA）：

- `luaL_Reg` 表中的 `"GetSurfaceType"` 条目在 VA `0x180009410`：name 指针 `0x180009600` → 函数 `0x180001c90`。
- 函数先调用 `GetDefaultTerrain`（IAT `0x180009008`），构造 `Vec3d{x, 1.0, z}`（常量 `1.0` 在 VA `0x180009f60`）。
- 在 `0x180001d93` 调用 `vtable+0x98`，返回结构基址 `rbp-0x59`。
- 在 `0x180001db5` 读取 `+0x38` 的 8 字节掩码，测试：
  - `bit 0x20` → 字符串 `"river"`（VA `0x180009ae4`，5 字节）
  - `bit 0x10` → 字符串 `"sea"`（VA `0x180009aec`，3 字节）
  - `bit 0x40` → `"lake"`
  - 否则 `mask & 0x1F05` → `"land"`
  - 否则返回空字符串
- 通过 `lua_pushstring`（IAT `0x180009298`）返回。

这三个水体位（`0x10/0x20/0x40` = Sea/River/Lake）和陆地组 `0x1F05` 与 §2.2 的枚举逐位一致，进一步支持“`+0x38` 使用同一套 `enSurfaceTypes`”的强推断。

这说明：

- 这个 Editor 绑定只区分 `land/sea/river/lake`，把 `Land|Runway|Road|Railway|Town|Field|Beach` 全部压成 `"land"`。
- 它**完全丢弃** `Building/Construction/Trees/Forest/Traffic/ParticleEffect` 等位（这些位不在 `0x1F05` 里，也不是水），会返回空字符串。
- 任务环境 `land.getSurfaceType` 的 5 类映射没有在本次静态分析中直接定位到；它很可能是另一套绑定/封装。**不要假设它与 Editor 的 `Terrain.GetSurfaceType` 完全同源**，建议在同一坐标同时调用 Lua 与注入查询做一次实测对照。

**推测映射（待实测，不作为结论）**：

| Lua 五类（项目文档） | 可能的内部 bit | 依据 |
|---|---|---|
| `LAND` | `Land`（可能还含 `Town/Field/Beach`） | Editor 绑定把 `0x1F05` 归为 `"land"` |
| `SHALLOW_WATER` | 未命名 bit7？ | `getSurfaceTypeByName("water")` 带 bit7；未确认语义 |
| `WATER` | `Sea`/`Lake`/`River` | 三个水体位已命名 |
| `ROAD` | `Road` | 名称直接对应 |
| `RUNWAY` | `Runway` | 名称直接对应 |

### 2.4 注入 DLL 调用示例（MSVC / MinGW 通用）

MSVC x64 的成员函数返回大结构时：`RCX = this`，`RDX = 返回缓冲区`，`R8 = 第一个显式参数`，`R9 = 第二个显式参数`；函数在 `RAX` 返回缓冲区指针。不要把它误写成“返回缓冲区在 RCX、this 在 RDX”（这是本次实测踩过的坑）。

```cpp
#include <windows.h>
#include <cstdint>

struct Vec3d { double x, y, z; };

using GetDefaultTerrainFn = void* (*)();

// Windows x64 只有一种调用约定：self 在 RCX，out 在 RDX，point 在 R8，cache 在 R9。
// 把隐藏的返回缓冲区显式作为第二个参数，MSVC / MinGW x64 都可直接这样声明。
using GetPointOnSurfaceFn = void* (*)(void*, void*, const Vec3d*, void*);

bool querySurfaceMask(double x, double z, std::uint64_t& mask) {
    HMODULE inter = GetModuleHandleA("Inter.dll");
    if (!inter) return false;

    auto getTerrain = (GetDefaultTerrainFn)GetProcAddress(
        inter, "?GetDefaultTerrain@ITerrain@edterrain@@SAPEAV12@XZ");
    if (!getTerrain) return false;

    void* terrain = getTerrain();
    if (!terrain) return false;

    void** vt = *reinterpret_cast<void***>(terrain);
    auto getPointOnSurface = (GetPointOnSurfaceFn)vt[19]; // 0x98

    alignas(16) unsigned char out[0x80] = {};
    Vec3d p{ x, 1.0, z };              // Lua 侧同样用 y = 1.0
    getPointOnSurface(terrain, out, &p, nullptr);

    mask = *reinterpret_cast<std::uint64_t*>(out + 0x38);
    return true;
}
```

注意事项：

- `GetDefaultTerrain()` 在任务/地形加载完成后才可用；不要在 DCS 启动早期调用。即使返回非空，也可能拿到未加载地形的 stub：本次对 stub 调用得到 `+0x38 = 0xFFFFFFFFFFFFFFFF`，这是哨兵而不是有效分类。**若 mask 为全 1，应视为“地形未就绪/无效”，不要解码。**
- 建议在模拟线程/任务线程调用；`getPointOnSurface` 是 `const`，但可能触发地形分块懒加载。
- `cache = nullptr` 是 Lua 侧的实际用法；批量查询可考虑复用 `PointOnSurface::InternalCache`，但其布局未测绘。
- 坐标是 DCS 世界坐标 `(x, y, z)`，Lua 的 `Vec2` 用 `{x=world.x, y=world.z}`；高度参数传 `1.0` 与 Lua 一致。
- 若需要经纬度转换，`ITerrainImpl4` 的槽位 41–47 提供 `toLatLon/fromLatLon/fromUTMtoLockon`；`edterrainCore.dll` 是 UTM 投影实现。

### 2.5 低层 `Surface5File` 查询

`landscape5::Surface5File` 是 `.surface5` 文件的解析器，导出表里有完整的低层查询：

```text
?verticalIntersection@Surface5File@landscape5@@QEAA_NAEBVVec3d@osg@@AEAV34@1AEA_KAEAMPEAUInternalCache@PointOnSurface@edterrain@@PEAULOD@12@PEAH6@Z
?surfaceTypes@Surface5File@landscape5@@QEBAIAEBUSquare@12@I@Z
?surfaceTypes@Surface5File@landscape5@@QEBAIAEBUSquare@12@IAEBVVec3d@osg@@@Z
```

反混淆：

```cpp
bool Surface5File::verticalIntersection(
    osg::Vec3d const& point,
    osg::Vec3d& outPoint,
    osg::Vec3d& outNormal,
    unsigned __int64& surfaceTypes,   // 64 位掩码
    float& height,
    edterrain::PointOnSurface::InternalCache* cache,
    Surface5File::LOD* lod,
    int* squareX,
    int* squareY);

unsigned int Surface5File::surfaceTypes(
    Surface5File::Square const& square,
    unsigned int faceIndex,
    osg::Vec3d const& point) const;   // 32 位语义掩码
```

另有：

```text
?convertSemanticMaskToEnSurfaceTypes@@YA_KI@Z  // unsigned __int64 (unsigned int)
```

即：`Surface5File` 的面数据里是 32 位语义掩码，经 `convertSemanticMaskToEnSurfaceTypes` 转成上面的 64 位枚举；`verticalIntersection` 直接输出 64 位结果。`getPointOnSurface` 在内部做同样的转换。

**离线可用性**：`Surface5File` 的构造函数、`load(io::MmfStream&)`、`save`、`verticalIntersection` 都是导出的；`edCore.dll` 也导出 `io::MmfStream(char const*, Stream::Mode, unsigned int)`。理论上可以在独立进程里 mmap `.surface5` 后直接查询，不需要启动 DCS。但对象大小、`Stream::Mode` 枚举值、`InternalCache`/`LOD` 的生命周期都没有头文件，本次未做端到端离线实测。**推测**：这是最接近“自己解析文件结构”的官方路径，比手写二进制解析可靠。

**另一条线索（不推荐作为主路径）**：`edterrainExtra4.dll` 导出 `edtex::ElevationSpatialFile::getSurfaceType(osg::Vec3d const&) const -> int` 和 `getHeight(...)`。它是 elevation spatial file 的查询接口，但本次在 6 张地图的文件头里没有找到与之对应的 magic；其 `Map` 子结构/格式也未测绘。**推测**它服务于地形制作/高程源数据，而不是运行期 `.surface5`。除非后续确认它的数据来源，否则优先用 `getPointOnSurface`/`Surface5File`。

---

## 3. 道路与铁路矢量

### 3.1 运行期入口

`ITerrainImpl4::getRoadNetwork` 在 vtable 槽位 50（字节偏移 `0x190`）：

```text
?getRoadNetwork@ITerrainImpl4@@UEAAPEAVIRoadNetwork@edterrain@@PEBD@Z
```

```cpp
edterrain::IRoadNetwork* ITerrainImpl4::getRoadNetwork(char const* name);
```

`lua-terrain.dll` 的内部字符串给出了网络名：`"roads"`、`"railroads"`，以及机场的 `"getRunwayList: no road network for airdrome %s"`、`"getStandList: not found road network %s"`。**强推断**：

- 地面道路：`getRoadNetwork("roads")`
- 铁路：`getRoadNetwork("railroads")`
- 机场跑道/滑行道：`getRoadNetwork(<airfield name>)`，对应 `AirfieldsTaxiways/*.rn5`

返回的 `IRoadNetwork*` 的实际实现类是 `IRoadNetworkImpl4`（构造函数签名为 `IRoadNetworkImpl4(ITerrainImpl4*, landscape4::lRoadNetwork*)`）。其导出方法（节选）：

| 方法 | 签名（反混淆） |
|---|---|
| `roadsCount` | `int roadsCount() const` |
| `getRoad` | `edterrain::IRoute const* getRoad(int) const` |
| `findClosestPoint` | `bool findClosestPoint(osg::Vec3d const&, edterrain::PointOnRoad&, edterrain::ICheckRoadSink*, double) const` |
| `getPoint` | `bool getPoint(edterrain::PointOnRoad const&, osg::Vec3d&) const` |
| `getPointOnSurface` | `osg::Vec3d getPointOnSurface(edterrain::PointOnRoad const&, edterrain::PointOnSurface&) const` |
| `createRoute` | `edterrain::IRoute* createRoute(edterrain::PointOnRoad const&, edterrain::PointOnRoad const&, edterrain::ICheckRoadSink*) const` |
| `loadRoute` / `saveRoute` | `IRoute* loadRoute(ed::basic_string<char> const&) const` / `bool saveRoute(IRoute*, ed::basic_string<char> const&) const` |
| `chainCount` / `getChain` | `int chainCount() const` / `ed::vector<int> getChain(int) const` |
| `crossroadsCount` / `getCrossroad` | `int crossroadsCount() const` / `edterrain::ICrossroad const* getCrossroad(int) const` |
| `getCrossroadPoint` | `edterrain::PointOnRoad getCrossroadPoint(int) const` |
| `release` | `void release()` |

道路几何的官方辅助函数在 `Inter.dll`：

```text
?buildPolylineForRoute@edterrain@@YAXPEBUIRoute@1@AEBUPointOnRoad@1@1AEAV?$vector@VVec3d@osg@@...@ed@@M@Z
```

反混淆：

```cpp
void edterrain::buildPolylineForRoute(
    edterrain::IRoute const* route,
    edterrain::PointOnRoad const& from,
    edterrain::PointOnRoad const& to,
    ed::vector<osg::Vec3d>& out,
    float step);
```

这条路不需要读 `.rn4`，但需要 `IRoute` 和两个 `PointOnRoad`。`IRoute` 的虚表本次没有测绘；如果只想要“最近道路的折线”，更简单的是离线 `lRoad` 路径（§3.2）。

### 3.2 直接 `lRoad` / `lRoadNetwork` 路径

`landscape4::lRoadNetwork` 和 `landscape4::lRoad` 的绝大多数方法都是导出的：

```text
?load@lRoadNetwork@landscape4@@QEAA_NPEBD@Z
?load@lRoadNetwork@landscape4@@QEAA_NAEAVMmfStream@io@@@Z
?findClosestPoint@lRoadNetwork@landscape4@@QEAA_NAEBVVec3d@osg@@AEAUlPointOnRoad@2@PEAUICheckRoadSink@2@N@Z
?getRoadFromPointToPoint@lRoadNetwork@landscape4@@QEAAPEAVlRoad@2@AEBUlPointOnRoad@2@0NNPEAUICheckRoadSink@2@PEAV?$vector@U?$pair@II@std@@...@ed@@@Z
?getSubRoadVerts@lRoad@landscape4@@QEAAXAEAV?$vector@VVec3d@osg@@...@ed@@NN@Z
?getPoint@lRoad@landscape4@@QEBA?AVVec3d@osg@@N@Z
?getLength@lRoad@landscape4@@QEBA_NPEAN@Z
?getSegmentsCount@lRoad@landscape4@@QEBAHXZ
?getControlVertex@lRoad@landscape4@@QEBA?AVVec3d@osg@@N@Z
```

反混淆后的用法：

```cpp
landscape4::lRoadNetwork net;
net.load(".../roads/Caucasus.rn4");

landscape4::lPointOnRoad pr;
if (net.findClosestPoint(osg::Vec3d{x, 0, z}, pr, nullptr, 100.0)) {
    osg::Vec3d nearest = net.getPoint(pr);   // 最近道路上的点

    // 若要从 A 到 B 取整条路：先分别求两个最近点，再取连接它们的 lRoad。
    landscape4::lPointOnRoad a, b;
    if (net.findClosestPoint(osg::Vec3d{x1, 0, z1}, a, nullptr, 100.0) &&
        net.findClosestPoint(osg::Vec3d{x2, 0, z2}, b, nullptr, 100.0)) {
        landscape4::lRoad* road = net.getRoadFromPointToPoint(a, b, 0.0, 0.0, nullptr, nullptr);
        if (road) {
            ed::vector<osg::Vec3d> verts;
            road->getSubRoadVerts(verts, road->getStartParam(), road->getEndParam());
        }
    }
}
```

注意：

- `lRoadNetwork` **没有导出的 `getRoad(int)` / `roadsCount()`**，所以“按索引枚举所有道路”要用 `IRoadNetworkImpl4` 的 `roadsCount/getRoad`，或者用 `findClosestPoint` + `getRoadFromPointToPoint` 从坐标反查。
- `lRoad::getSubRoadVerts` 是导出方法里最直接的“拿折线顶点”入口；它按参数区间返回点列。
- `lRoadNetwork::load` 有 `char const*`、`basic_string`、`MmfStream` 三个重载，适合离线工具。
- `lRoad` 还有 `getTangent/getNormal/getDerivative1/2/getTimeForRoadWithPhase` 等，足以做道路几何/朝向分析。

**铁路**：同一套 `IRoadNetwork`/`lRoadNetwork`；网络名用 `"railroads"`。`.rn4` 文件里同时包含道路和铁路的类型/链信息（`lRoadNetwork::Chain`、`RoadGraphNode`、`lRoadSegment` 的 `operator>>` 都在导出表里），具体哪些条目是铁路由 `getRoadNetwork("railroads")` 过滤。

### 3.3 磁盘格式

| 文件 | 头 magic | 版本 | 说明 |
|---|---|---|---|
| `roads/<map>.rn4` | `landscape4::lRoadNetwork` | 5 | 地面道路网；`lRoadNetwork::load` |
| `AirfieldsTaxiways/<airfield>.rn5` | `t5::rn5file` | — | 机场跑道/滑行道网；358 个文件 |
| `roads/<map>.routes` | `landscape4::lRoutesFile` | 3 | 民用车辆/船只路线与沿线场景对象，**不是**道路几何 |

`.routes` 的 `lRoutesFile` 方法包括 `load/save`、`addRoute`、`getVehiclePos`、`getSceneObjectPosition`、`objectsCount` 等，适合做交通流/航线，不适合当道路矢量。

---

## 4. 物体摆放

### 4.1 运行期查询（推荐给注入 DLL）

`ITerrainImpl4` 的四个 `querySceneObjectsCB` 重载（槽位 27–30）覆盖包围盒、凸多面体、射线：

```text
?querySceneObjectsCB@ITerrainImpl4@@UEBA?AW4enQueryObjectsResult@edterrain@@AEBV?$BoundingBoxImpl@VVec3f@osg@@@osg@@IV?$function@$$A6A?AW4enQueryObjectBehavior@edterrain@@IAEBUModelIntersectionData@2@@Z@std@@@Z
?querySceneObjectsCB@ITerrainImpl4@@UEBA?AW4enQueryObjectsResult@edterrain@@AEBVPolytope@osg@@IV?$function@$$A6A?AW4enQueryObjectBehavior@edterrain@@I@Z@std@@@Z
?querySceneObjectsCB@ITerrainImpl4@@UEBA?AW4enQueryObjectsResult@edterrain@@AEBVPolytope@osg@@IV?$function@$$A6A?AW4enQueryObjectBehavior@edterrain@@IAEBUModelIntersectionData@2@@Z@std@@@Z
?querySceneObjectsCB@ITerrainImpl4@@UEBA?AW4enQueryObjectsResult@edterrain@@AEBVVec3d@osg@@0IV?$function@$$A6A?AW4enQueryObjectBehavior@edterrain@@IAEBUModelIntersectionData@2@@Z@std@@@Z
```

最实用的做法：

1. 用**凸多面体 + 只回传 ID 的版本**（槽位 29，回调签名 `enQueryObjectBehavior(unsigned int)`）枚举区域内的对象 ID。这样不需要知道 `ModelIntersectionData` 的布局。
2. 对每个 ID 调用：
   - `getSceneObjectPosition(uint) const` → `osg::Matrixd`（槽位 35）
   - `getSceneObjectType(uint) const` → `model::IModel*`（槽位 36）
   - `getSceneObjectSeed(uint) const` → `float`（槽位 37）
   - `getSceneObjectArgs(uint) const` → `model::IModelParams*`（槽位 38）
   - `isSceneObjectValid(uint) const`（槽位 39）

限制与风险：

- 所有 `querySceneObjectsCB` 都带 `std::function` 参数，**ABI 必须与 DCS 使用的 MSVC STL 一致**。用 MSVC 构建注入 DLL 时风险较小；用 MinGW 时 `std::function` 布局/异常/分配器可能不兼容，建议改用离线 `Scene5File` 或写一个极薄的 MSVC 桥接 DLL。
- `enQueryObjectBehavior`/`enQueryObjectsResult` 的枚举值没有在导出表里；需要实测（通常 `0/1` 表示继续/停止，但不要假设）。
- 这个接口返回的是**静态场景对象**（建筑、树木、桥梁等），不是任务中的动态单位；动态单位应走 `world.searchObjects`/仿真对象接口。
- 物体模型的完整可见网格、材质、碰撞体不在 `IModel*` 的公开签名里；这里只能拿到类型指针、矩阵、种子和参数指针。

### 4.2 离线 `Scene5File`（`.scn5`）

`landscape5::Scene5File` 的导出方法（节选）：

```text
?load@Scene5File@landscape5@@UEAA_NAEAVMmfStream@io@@@Z
?objectsCount@Scene5File@landscape5@@QEBAIXZ
?getObjectModel@Scene5File@landscape5@@QEAAPEAVIModel@model@@HH@Z
?getObjectModelName@Scene5File@landscape5@@QEAAAEBV?$basic_string@D@ed@@HH@Z
?getObjectPosition@Scene5File@landscape5@@QEBA?AVMatrixd@osg@@HH@Z
?getObjectSeed@Scene5File@landscape5@@QEBAMHH@Z
?getObjectOptions@Scene5File@landscape5@@QEBAIHH@Z
?getSubobjects@Scene5File@landscape5@@QEBAPEB_K_KAEAH@Z
?isObjectValid@Scene5File@landscape5@@QEBA_NHH@Z
```

反混淆：

```cpp
bool Scene5File::load(io::MmfStream&);
unsigned int Scene5File::objectsCount() const;
model::IModel* Scene5File::getObjectModel(int object, int subobject);
ed::basic_string<char> const& Scene5File::getObjectModelName(int object, int subobject);
osg::Matrixd Scene5File::getObjectPosition(int object, int subobject) const;
float Scene5File::getObjectSeed(int object, int subobject) const;
unsigned int Scene5File::getObjectOptions(int object, int subobject) const;
unsigned __int64 const* Scene5File::getSubobjects(unsigned __int64 id, int& count) const;
bool Scene5File::isObjectValid(int object, int subobject) const;
```

- `.scn5` 文件头 magic 是 `landscape5::Scene5File`，版本 9。
- `objectsCount()` 给顶层对象数；`getObject*` 的第二个参数是子对象索引。`getSubobjects` 用 64 位对象 ID 返回子对象 ID 数组（`count` 为输出）。
- `getObjectPosition` 返回 `osg::Matrixd`（4×4 double，128 字节）；这是完整的摆放矩阵，不只是位置。
- 离线实例化 `Scene5File` 需要知道对象大小和 `io::MmfStream` 的构造/Mode；本次没有做端到端实测。`lDataFileStore::open` 这个“按 magic 自动创建 reader”的工厂在独立进程里用绝对路径测试返回 `false`（推测它需要 VFS 相对路径或游戏初始化），因此不能把它当成开箱即用的离线入口。

### 4.3 `Surface5File` 的运行时/植被对象

`landscape5::Surface5File` 还导出：

```text
?querySceneObjects@Surface5File@landscape5@@QEAAXPEBUInternalContext@@AEBVBoundingBox...@osg@@AEBV?$function@$$A6A_NPEAVIModel@model@@AEBVMatrixd@osg@@@Z@std@@@Z
?queryRuntimeSceneObjects@Surface5File@landscape5@@QEAAXPEBUInternalContext@@AEBVBoundingBox...@osg@@AEBV?$function@$$A6A_NPEAVIModel@model@@AEBVMatrixd@osg@@MHHHHHHH@Z@std@@@Z
```

反混淆：

```cpp
void Surface5File::querySceneObjects(
    InternalContext const* ctx,
    osg::BoundingBox const& box,
    std::function<bool(model::IModel*, osg::Matrixd const&)> const& cb);

void Surface5File::queryRuntimeSceneObjects(
    InternalContext const* ctx,
    osg::BoundingBox const& box,
    std::function<bool(model::IModel*, osg::Matrixd const&, float seed,
                        int, int, int, int, int, int, int)> const& cb);
```

- `querySceneObjects`：普通场景对象。
- `queryRuntimeSceneObjects`：运行时/实例化对象（植被、草丛等），多出一个 `seed` 和 7 个整数参数（推测是 LOD/变体/材质索引，未确认）。
- 这两个接口都需要 `InternalContext*` 和 `std::function`，ABI 风险同 §4.1；更适合在 DCS 进程内用 MSVC 调用。

### 4.4 资产实例：`vd5::VectorData` 与 `assets::lLinked`

如果地图侧使用矢量数据（点/样条/网格实例）来摆放资产，`vd5::VectorData` 是最干净的枚举接口：

```text
?load@VectorData@vd5@@QEAA_NPEBD@Z
?pointsCount@VectorData@vd5@@QEBAHXZ
?pointInstance@VectorData@vd5@@QEAAAEAVPointInst@2@H@Z
?splinesCount@VectorData@vd5@@QEBAHXZ
?splineInstance@VectorData@vd5@@QEAAAEAVSplineInst@2@H@Z
?meshInstance@VectorData@vd5@@QEAAAEAVMeshInst@2@H@Z
```

每个实例：

- `PointInst::asset()` → `assets::lPointAsset*`
- `PointInst::getTransform()` → `osg::Matrixd const&`
- `SplineInst::asset()` → `assets::lSplineAsset*`
- `SplineInst::getVertPos(int)` / `getVert(int)` / `getSegmentPos(int, ...)` / `getBoundingBox()`
- `MeshInst::asset()` → `assets::lMeshAsset*`；`getTransform()`、`getPolygons()`

`assets::lLinked` 是另一套容器，包含 `PointInstance` / `SplineInstance` / `MeshInstance` / `SceneObject`，可用 `load(char const*)` / `load(basic_string)`，并通过 `lLinked2VectorData` / `vectorData2lLinked` 与 `vd5::VectorData` 互转。

资产定义文件：

- `Mods/terrains/<map>/misc/assets.assets` 的 magic 是 `lAssetFile2.0`，对应 `assets::lAssetFile`；方法有 `load(io::MmfStream&)`、`getAsset(name)`、`getPointAsset(name)`、`getSplineAsset(name)`、`getMeshAsset(name)`。
- `assets::lPointAsset::surfaceType()` / `lSplineAsset::surfaceType()` 返回资产设计使用的地表类型（`unsigned int`），不是摆放位置的地表类型。
- `lLinked::PointInstance` / `SplineInstance` 是**摆放实例**；`lPointAsset` / `lSplineAsset` 是**资产定义**。不要把两者混淆。

`vd5::VectorData` 的序列化格式类名是 `lsa5File` / `lsa5pureFile`（导出表可见）；本次在 `Mods/terrains` 下没有发现 `.lsa5` 扩展，推测它是编辑器源数据/内部格式，而不是这 6 张地图的运行时摆放文件。运行时的静态摆放仍以 `.scn5` + `.surface5` 为主。

---

## 5. 磁盘格式对照（只读文件头，未解包）

### 5.1 通用头布局

多张地图的 `.surface5`、`.scn5`、`.rn4`、`.routes`、`.ng5`、`.sup4`、`.sup5`、`.tile`、`.gn4`、`.sd2`、`.sd5`、`.ref` 开头都是同一类“类名 + 版本”头：

```text
u32  02 00 00 00          // 头格式版本
u32  30 00 00 00          // 头长度 0x30
u64  <payload size>       // 文件大小/数据区大小
u8[16] 0                  // 保留
u32  <class name length>
char <class name>[...]
u32  <class version>
```

例（`Caucasus.surface5` 前 0x40 字节）：

```text
00000000: 0200 0000 3000 0000 38d7 9e02 0000 0000
00000010: 0000 0000 0000 0000 0000 0000 0000 0000
00000020: 1800 0000 6c61 6e64 7363 6170 6535 3a3a
00000030: 5375 7266 6163 6535 4669 6c65 0500 0000
```

即：`landscape5::Surface5File`，版本 5。

### 5.2 地图文件表

| 路径 | class magic | 版本 | 体量示例（Caucasus / Syria） | 说明 |
|---|---|---|---:|---|
| `Surface/<map>.surface5` | `landscape5::Surface5File` | 5 | 6,293,651,208 B / 30,426,200,576 B | 地形表面网格 + 材质 + 语义掩码；`Surface5File` |
| `Surface/<map>.ng5` | `navGraph5File` | 10 | 860,801,880 B / 3,310,453,000 B | 地面寻路图；`navGraph5File::findPath` |
| `Surface/<map>.onlay.sup4` | `landscape4::lSuperficialFile` | 5 | 106,221,816 B / 679,902,304 B | 表层/覆盖物 |
| `Surface/<map>.tile` | `landscape5::SurfaceTile` | 2 | 614,608 B / 4,255,232 B | 表面瓦片；`SurfaceTile::load` |
| `roads/<map>.rn4` | `landscape4::lRoadNetwork` | 5 | 203,468,160 B / 2,275,957,360 B | 道路网 |
| `roads/<map>.routes` | `landscape4::lRoutesFile` | 3 | 980,525,840 B / 2,251,462,776 B | 车辆/船只路线与沿线对象 |
| `Scenes/<map>.scn5` | `landscape5::Scene5File` | 9 | 1,140,069,192 B / 5,524,894,992 B | 静态场景对象摆放 |
| `Map/<map>.sup5` | `landscape5::sup5File` | 0 | 48,047,000 B / — | 地图视图/高程表面；`sup5File` |
| `Map/<map>.gn4` | `landscape4::lGeoNamesFile` | 2 | 2,404,872 B / — | 地名 |
| `SurfaceDetails/<map>.sd2` | `landscape4::lSurfaceDetails2File` | — | 80 B / — | 旧版表面细节 |
| `SurfaceDetails/<map>.sd5` | `landscape4::SurfaceDetails5File` | — | — / — | 新版表面细节 |
| `SurfaceDetails/*.ref` | `landscape4::lReferenceFile` | 6 | 120 B–180 KB | 植被/参考对象定义 |
| `misc/assets.assets` | `lAssetFile2.0` | 4 | — | 资产库；`assets::lAssetFile` |
| `AirfieldsTaxiways/*.rn5` | `t5::rn5file` | — | — | 机场跑道/滑行道网 |
| `Models/**/*.m5` | `lModels5File` | — | — | 模型/几何文件 |
| `misc/metacache/**/*.meta2` | 非 terrain 类名 | — | — | 着色器缓存（头里是 `metashaders/terrain/...`），不是物体资产 |

**实证**：上述 magic 均用 `xxd -l 64` 读取文件头得到；未解包任何大文件，未修改 DCS 目录。

### 5.3 地图目录样例

以 `Mods/terrains/Caucasus` 为例：

```text
Surface/      Caucasus.surface5  Caucasus.ng5  Caucasus.onlay.sup4  Caucasus.tile
roads/        Caucasus.rn4  Caucasus.routes
Scenes/       Caucasus.scn5
SurfaceDetails/  *.ref  Caucasus.sd2  Caucasus.References.StructTable.sht
Map/          Caucasus.sup5  Caucasus.gn4  towns.lua
misc/         assets.assets  metacache/
Models/       *.m5  *.ofsh  StructTable
```

Syria/MarianaIslands/PersianGulf/Nevada/Sinai 的结构相同（大小写目录名有差异，例如 `surface/`、`surfaceDetails/`）。

---

## 6. 限制、风险与未决问题

1. **所有偏移/槽位是版本相关的**。本文对应本机 2026-10 的 DCS 稳定版；DCS 更新可能改变 `ITerrainImpl4` 的 vtable 顺序、`PointOnSurface` 布局或文件版本。上线前必须在目标版本重新跑一遍 vtable/offset 校验。
2. **`edterrain4.dll` 是 UPX 打包的**。不要依赖文件内 RVA 做静态 hook；导出表 RVA 可用，但函数体需要运行时解包。用 `GetProcAddress` + vtable 调用，不要硬编码文件偏移。
3. **`lTerraDispatchImpl` 的方法不可直接调用**。它的 61 个虚函数槽没有导出名，不能从符号恢复签名；把它当内部对象，不要按槽位猜测调用。
4. **`PointOnSurface` 只有 `+0x38` 的 8 字节字段经过了三角验证**（Lua 8 字节读取、stub 写入、`verticalIntersection` 的 uint64 输出）；其“64 位 `enSurfaceTypes`”语义仍是强推断。其他字段（命中点、法线、高度、ID）的偏移是推测，使用前应做小范围实测。
5. **地表掩码的语义仍有两层**：`.surface5` 面数据是 32 位语义掩码，`PointOnSurface`/`verticalIntersection` 输出 64 位枚举。`Road/Railway/Town/Building/...` 这些位是否在某个具体坐标上被填充，取决于地图制作时写入的语义数据；不要假设每个地图/每个点都有完整分类。
6. **道路与地表掩码是两套数据**。`Road/Railway` 位可能存在，也可能只在地表纹理/网格里体现；要做路径规划/矢量提取，请用 `IRoadNetwork`/`.rn4`，不要只依赖掩码。
7. **动态单位不在本文范围**。`querySceneObjectsCB` 返回静态场景对象；任务中的车辆、舰船、飞机是仿真对象，需走 `world.searchObjects`/DCS 仿真接口。
8. **`std::function` ABI 是运行期物体查询的最大工程风险**。MinGW 构建的 DLL 不建议直接传 `std::function` 给 DCS；优先用 MSVC 构建，或把查询封装在一个极薄的 MSVC 桥接 DLL 里。
9. **离线 reader 的实例化未完全打通**。`Scene5File`/`Surface5File`/`lRoadNetwork` 的构造函数和 `load` 是导出的，但对象大小、`io::MmfStream` 的 `Mode` 枚举、VFS 初始化都没有头文件；`lDataFileStore::open` 用绝对路径实测返回 `false`。如果要做独立离线工具，建议先用 `lRoadNetwork::load(char const*)`（有 `char const*` 重载）做最小验证，再推广到 `Scene5File`。
10. **不要读 GPU 资源**。本问题所有数据都有 CPU 侧对象/文件入口；`edterrainGraphics41.dll` 的 GPU 资源不是必要条件，读 GPU 会引入驱动/上下文/同步问题。
11. **Lua 五类映射未实测**。项目文档的 `land.getSurfaceType` 5 类与本文的 64 位掩码之间没有做同坐标对照；建议后续在任务环境对同一 `(x,z)` 同时调用 Lua 与注入查询，建立映射表。

---

## 7. 复现与验证命令

### 7.1 导出表 + 反混淆

```bash
OBJ="<repo>/.tools/mingw-root/mingw64/bin/objdump.exe"
DLL="<DCS>/bin/edterrain4.dll"
"$OBJ" -p "$DLL" | sed -n 's/^\t\[ *\([0-9]*\)\].*[[:space:]]\(\?[^[:space:]]*\)$/\1\t\2/p' > /tmp/exports.txt
# 再用 Python dbghelp UnDecorateSymbolName 逐行反混淆
```

### 7.2 运行时 vtable

```python
import os, ctypes
os.add_dll_directory(r"<DCS>\bin")
d = ctypes.WinDLL(r"<DCS>\bin\edterrain4.dll")
ct = d["?CreateTerraDispatch@landscape4@@YAPEAVlTerraDispatchImpl@1@XZ"]; ct.restype = ctypes.c_void_p
cs = d["?CreateITerrainStub@landscape4@@YAPEAVITerrain@edterrain@@PEAVlTerraDispatchImpl@1@@Z"]
cs.restype = ctypes.c_void_p; cs.argtypes = [ctypes.c_void_p]
td = ct(); st = cs(td)
vt = ctypes.c_void_p.from_address(st).value
for i in range(0, 61):
    fn = ctypes.c_void_p.from_address(vt + 8*i).value
    print(i, hex(fn - d._handle))
```

结果中槽位 19 的 RVA 应为 `0x255a0`，与导出 `getPointOnSurface` 的 RVA 一致。

### 7.3 枚举地表类型名

```python
import os, ctypes
os.add_dll_directory(r"<DCS>\bin")
d = ctypes.WinDLL(r"<DCS>\bin\Inter.dll")
f = d["?getSurfaceTypeName@edterrain@@YAPEBD_K@Z"]
f.argtypes = [ctypes.c_ulonglong]; f.restype = ctypes.c_char_p
for i in range(64):
    p = f(1 << i)
    print(i, p.decode() if p else None)
```

### 7.4 文件头

```bash
R="<DCS>/Mods/terrains/Caucasus"
xxd -l 64 "$R/Surface/Caucasus.surface5"
xxd -l 64 "$R/Scenes/Caucasus.scn5"
xxd -l 64 "$R/roads/Caucasus.rn4"
xxd -l 64 "$R/roads/Caucasus.routes"
xxd -l 64 "$R/Surface/Caucasus.ng5"
xxd -l 64 "$R/Map/Caucasus.sup5"
```

---

## 附录 A：关键符号（原始 mangled 名）

### 地表

```text
?GetDefaultTerrain@ITerrain@edterrain@@SAPEAV12@XZ
?getPointOnSurface@ITerrainImpl4@@UEBA?AUPointOnSurface@edterrain@@AEBVVec3d@osg@@PEAUInternalCache@23@@Z
?intersection@ITerrainImpl4@@UEBA?AUPointOnSurface@edterrain@@AEBVVec3d@osg@@0@Z
?querySurfaceMeshEx@ITerrainImpl4@@UEBA_NAEBUSurfaceMeshQuery@edterrain@@AEAUSurfaceMesh@3@@Z
?verticalIntersection@Surface5File@landscape5@@QEAA_NAEBVVec3d@osg@@AEAV34@1AEA_KAEAMPEAUInternalCache@PointOnSurface@edterrain@@PEAULOD@12@PEAH6@Z
?surfaceTypes@Surface5File@landscape5@@QEBAIAEBUSquare@12@I@Z
?surfaceTypes@Surface5File@landscape5@@QEBAIAEBUSquare@12@IAEBVVec3d@osg@@@Z
?getSurfaceTypeByName@edterrain@@YA_KAEBV?$basic_string@D@ed@@@Z
?getSurfaceTypeName@edterrain@@YAPEBD_K@Z
?getSurfaceTypesName@edterrain@@YA?AV?$basic_string@D@ed@@_K@Z
```

### 道路

```text
?getRoadNetwork@ITerrainImpl4@@UEAAPEAVIRoadNetwork@edterrain@@PEBD@Z
?roadsCount@IRoadNetworkImpl4@@UEBAHXZ
?getRoad@IRoadNetworkImpl4@@UEBAPEBVIRoute@edterrain@@H@Z
?findClosestPoint@IRoadNetworkImpl4@@UEBA_NAEBVVec3d@osg@@AEAUPointOnRoad@edterrain@@PEAVICheckRoadSink@5@N@Z
?getPoint@IRoadNetworkImpl4@@UEBA_NAEBUPointOnRoad@edterrain@@AEAVVec3d@osg@@@Z
?getPointOnSurface@IRoadNetworkImpl4@@UEBA?AVVec3d@osg@@AEBUPointOnRoad@edterrain@@AEAUPointOnSurface@5@@Z
?load@lRoadNetwork@landscape4@@QEAA_NPEBD@Z
?getRoadFromPointToPoint@lRoadNetwork@landscape4@@QEAAPEAVlRoad@2@AEBUlPointOnRoad@2@0NNPEAUICheckRoadSink@2@PEAV?$vector@U?$pair@II@std@@...@ed@@@Z
?getSubRoadVerts@lRoad@landscape4@@QEAAXAEAV?$vector@VVec3d@osg@@...@ed@@NN@Z
```

### 物体

```text
?querySceneObjectsCB@ITerrainImpl4@@UEBA?AW4enQueryObjectsResult@edterrain@@AEBV?$BoundingBoxImpl@VVec3f@osg@@@osg@@IV?$function@$$A6A?AW4enQueryObjectBehavior@edterrain@@IAEBUModelIntersectionData@2@@Z@std@@@Z
?querySceneObjectsCB@ITerrainImpl4@@UEBA?AW4enQueryObjectsResult@edterrain@@AEBVPolytope@osg@@IV?$function@$$A6A?AW4enQueryObjectBehavior@edterrain@@I@Z@std@@@Z
?getSceneObjectPosition@ITerrainImpl4@@UEBA?AVMatrixd@osg@@I@Z
?getSceneObjectType@ITerrainImpl4@@UEBAPEAVIModel@model@@I@Z
?getSceneObjectSeed@ITerrainImpl4@@UEBAMI@Z
?getSceneObjectArgs@ITerrainImpl4@@UEBAPEAVIModelParams@model@@I@Z
?isSceneObjectValid@ITerrainImpl4@@UEBA_NI@Z
?objectsCount@Scene5File@landscape5@@QEBAIXZ
?getObjectPosition@Scene5File@landscape5@@QEBA?AVMatrixd@osg@@HH@Z
?getObjectModel@Scene5File@landscape5@@QEAAPEAVIModel@model@@HH@Z
?getSubobjects@Scene5File@landscape5@@QEBAPEB_K_KAEAH@Z
?querySceneObjects@Surface5File@landscape5@@QEAAXPEBUInternalContext@@AEBV?$BoundingBoxImpl@VVec3f@osg@@@osg@@AEBV?$function@$$A6A_NPEAVIModel@model@@AEBVMatrixd@osg@@@Z@std@@@Z
?queryRuntimeSceneObjects@Surface5File@landscape5@@QEAAXPEBUInternalContext@@AEBV?$BoundingBoxImpl@VVec3f@osg@@@osg@@AEBV?$function@$$A6A_NPEAVIModel@model@@AEBVMatrixd@osg@@MHHHHHHH@Z@std@@@Z
```

### 资产/矢量

```text
?load@VectorData@vd5@@QEAA_NPEBD@Z
?pointsCount@VectorData@vd5@@QEBAHXZ
?pointInstance@VectorData@vd5@@QEAAAEAVPointInst@2@H@Z
?splinesCount@VectorData@vd5@@QEBAHXZ
?splineInstance@VectorData@vd5@@QEAAAEAVSplineInst@2@H@Z
?load@lLinked@assets@@QEAA_NPEBD@Z
?load@lAssetFile@assets@@UEAA_NAEAVMmfStream@io@@@Z
?surfaceType@lPointAsset@assets@@QEBAIXZ
?surfaceType@lSplineAsset@assets@@QEBAIXZ
?lLinked2VectorData@vd5@@YA_NAEAVlLinked@assets@@AEAVVectorData@1@PEAV?$function@$$A6A_NW4enAssetClass@assets@@H@Z@std@@PEAV?$function@$$A6AXW4enAssetClass@assets@@HH@Z@6@@Z
?vectorData2lLinked@vd5@@YA_NAEAVVectorData@1@AEAVlLinked@assets@@PEAV?$function@$$A6A_NVVertex@vd5@@AEAUBindToSplineVertex@SplineInstance@lLinked@assets@@@Z@std@@@Z
```

---

## 附录 B：术语对照

| 名称 | 含义 |
|---|---|
| `PointOnSurface` | `getPointOnSurface` 的返回结构；`+0x38` 是 64 位地表类型掩码 |
| `PointOnRoad` | 道路上的参数化位置（道路 ID + 参数 + 车道等）；`IRoadNetwork` 的输入/输出 |
| `IRoute` | 道路/路径接口；`IRoadNetworkImpl4::getRoad(int)` 返回它 |
| `lRoad` | 道路实现类；`getSubRoadVerts` 可取折线顶点 |
| `lRoadNetwork` | `.rn4` 的解析器/容器 |
| `Scene5File` | `.scn5` 的解析器；`objectsCount/getObject*` |
| `Surface5File` | `.surface5` 的解析器；`verticalIntersection/surfaceTypes` |
| `sup5File` | `Map/<map>.sup5` 的解析器，偏地图视图/高程 |
| `lRoutesFile` | `.routes` 的解析器，民用交通路线 |
| `vd5::VectorData` | 点/样条/网格资产实例容器 |
| `assets::lLinked` | 资产实例容器；`PointInstance/SplineInstance/MeshInstance` |
| `lAssetFile` | `.assets` 资产库解析器 |

---

## 附录 C：本次未做/建议后续

1. 在真实任务中用注入 DLL 对同一 `(x,z)` 调用 `getPointOnSurface`，并与 Lua `land.getSurfaceType` 做 5 类对照，建立映射表。
2. 在真实地形上对 `PointOnSurface` 的 `+0x00/+0x18/+0x30/+0x40/+0x48` 做内存对比，确认命中点/法线/高度/ID 的偏移。
3. 测绘 `edterrain::IRoute` 与 `IRoadNetwork` 的虚表，补齐 `getRoad(i)` 的几何提取路径；当前建议用 `buildPolylineForRoute` 或 `lRoad::getSubRoadVerts`。
4. 用 MSVC 写一个最小注入 DLL，验证 `querySceneObjectsCB` 的 `std::function` ABI，并确认 `enQueryObjectBehavior` 的枚举值。
5. 尝试 `lRoadNetwork::load(char const*)` 的独立离线工具（对象大小可通过构造/分配实验确定），再推广到 `Scene5File`/`Surface5File` 的 `io::MmfStream` 路径。
6. 确认 `lDataFileStore::open` 的路径语义（VFS 相对路径/初始化要求），它可能是“按 magic 自动创建 reader”的离线入口。

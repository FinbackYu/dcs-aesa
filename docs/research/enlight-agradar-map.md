# enlight::AGRadar 类接口测绘

- 状态：external-reference（2026-10-18 复核）

> 对象：`<DCS>\bin\enlight.dll`
> 构建：PE32+ x86-64，ImageBase `0x180000000`，PE 时间戳 2026-09-19 13:31:36，PDB 路径 `Projects/Enlight/enlight.pdb`（age 30）。
> 配套：`bin\SceneRenderer.dll`（`bin/Mods` 中唯一静态导入 AGRadar 符号的模块，负责驱动它）、`Bazar\shaders\enlight\radar.fx`、`Bazar\shaders\enlight\radarFunc.hlsl`、`Bazar\shaders\model\functions\radar.hlsl`、`Config\Effects\radar.lua`。
> 本文只做只读测绘；所有地址均为**虚拟地址（VA，ImageBase 0x180000000）**，括号内给出 RVA 时以 `RVA 0x…` 标注。
> 证据标注：**[证]** = 二进制/着色器可直接证实；**[推]** = 由现有证据推断，尚未动态验证；**[待]** = 需要运行时验证。

---

## 0. 结论摘要

1. **导出数量是 272，不是 273。** `enlight.dll` 的 Export Address Table 共 `0x110 = 272` 项，且 272 项全部有名字（无 ordinal-only 导出）。任务描述中的 273 应为计数误差。
2. `enlight::AGRadar` 的公开 API 只有 9 个（含构造/析构）：`update`、`draw`、`getData`、`applyConfigPreset`、`buildDBS`、`clear`、`drawDebug`，以及 ctor/dtor。真正驱动画面的 `renderScanned` / `renderResult` / `renderFinal` / `blurPass` 是 **private 但已导出**，可以被钩子直接调用。
3. **`update()` 的真实回调签名是 6 个参数，不是任务描述里的 5 个**：
   ```cpp
   void update(
       AGRadar::Params const& params,
       osg::Vec2i const& viewportSize,
       std::function<void(int, osg::Matrixf const&, osg::Matrixf const&,
                          osg::Matrixf const*, osg::Matrixf const&, int)> cb);
   ```
   第 4 个参数是 `osg::Matrixf const*`（指向阴影级联矩阵数组），不是 `AGRadarData const*`；此外还多出第 5 个 `osg::Matrixf const&`。**[证]**（导出符号 #259 + `SceneRenderer.dll` 的 RTTI lambda 类型，见 §3.5）
4. 该回调的角色是 **场景重渲染回调**，不是单纯的“视图矩阵供给”：`update()` 把视图矩阵、投影矩阵、阴影投影矩阵数组、级联数交给回调；回调在 `SceneRenderer.dll` 里逐级联构造 `SceneRenderContext` 并调用场景渲染函数，把雷达视角的场景写进 `RadarOrtho` / `RadarOrthoDepth` / `RadarShadowmap`。**[证]**
5. **`src` 不是 AGRadar 自己渲染的**，而是 DCS 普通场景渲染管线在“雷达材质”technique 下渲染出来的反射率图：`model/functions/radar.hlsl` 的 `radar_ps()` 把 `radarValue(gRadarPos, wpos, normal, …)` 写进 R 通道；`def_material.fx` / `deck_material.fx` / `glass_material.fx` 都定义了 `radar` technique。AGRadar 只对它做后处理。**[证]**
6. `srcDepth` 是同一次雷达正交渲染的深度缓冲（`RadarOrthoDepth`）；`shadowmap` 是 DCS 的级联阴影 `Texture2DArray`（`RadarShadowmap`，1–3 级联）。**[证]**
7. 策略 A（钩游戏已有实例）技术上明显更可行：引擎已经负责场景、材质、正交相机、级联阴影；钩子只需要在 `update`/`draw`/`applyConfigPreset` 上做文章。策略 B（自构造实例）最大的障碍不是 `Params`，而是**拿不到 `src`**：必须自己重造 `render::RadarModule` 的整套场景渲染，且要跨 MinGW↔MSVC 的 `std::function`/`std::array<render::Texture,3>` ABI。详见 §6。

---

## 1. 测量方法与符号处理

### 1.1 工具链

- 导出表：`objdump.exe -p enlight.dll`（mingw-w64 binutils）。
- 反混淆：任务要求的同目录 `c++filt.exe` **不能识别 MSVC 名字修饰**（`-s auto/gnu-v3` 均原样输出）。因此改用 `dbghelp.dll!UnDecorateSymbolName(name, out, 8192, 0)`，即 MSVC 链接器同款 demangler，得到 `public: __cdecl enlight::AGRadar::update(...) __ptr64` 这类完整签名。**[证]**

  ```text
  # 实际流程（复现用）
  objdump.exe -p enlight.dll > exports.txt
  # 从 [Ordinal/Name Pointer] Table 抽出 ??... 名字
  c++filt.exe -n < names.txt          # 输出仍是 ??0AGRadar@enlight@@QEAA@XZ（未反混淆）
  # 改用 dbghelp!UnDecorateSymbolName 得到完整可读签名
  ```
- 反汇编：`objdump.exe -d`，地址即 VA。
- 字符串：对 PE 文件做 ASCII 扫描；关键字符串用 `objdump` 的 RIP-relative 注释交叉引用。
- RTTI：`SceneRenderer.dll` 保留了 MSVC RTTI 名字（`.?AV...`），这是确认 `RadarModule` 方法签名和 lambda 类型的决定性证据。

### 1.2 关键字符串（enlight.dll，.rdata）

| VA | 字符串 | 用途 |
|---|---|---|
| `0x18007ABB8` | `Config/Effects/radar.lua` | `AGRadar` ctor 调 `loadConfig` |
| `0x18007ABD8` | `enlight/radar.fx` | ctor 调 `RenderAPI::openShader` |
| `0x18007ABF0` | `cbUniforms` | shader 常量缓冲名 |
| `0x18007ABFC` | `Radar` | technique 名 |
| `0x18007AC04` | `src` | shader 纹理参数名 |
| `0x18007AC08` | `srcDepth` | shader 纹理参数名 |
| `0x18007AC18` | `shadowmap` | shader 纹理参数名 |
| `0x18007AB98` | `AG Radar: preset %s not found` | `applyConfigPreset` 失败日志 |
| `0x18007AC28` | `Failed assert \`shadowmapCount > 0 && shadowmapCount <= 3\`` | 级联数约束 |

### 1.3 构造函数证据

`AGRadar::AGRadar` 位于 `0x180001FE0`（RVA `0x1FE0`，导出 #1）：

| 指令地址 | 行为 | 证据 |
|---|---|---|
| `0x180002431` | `loadConfig("Config/Effects/radar.lua")` | 字符串 xref |
| `0x180002456` | `openShader("enlight/radar.fx", …)` → 存入 `this+0x308` | 字符串 xref，返回值 vtable 调用 |
| `0x1800024A6` | 取 constant buffer `cbUniforms` → `this+0x340` | 字符串 + 后续 `setConstantBuffer` |
| `0x1800024BA` | 取 technique `Radar` → `this+0x338` | 字符串 + 后续 `setTechnique` |
| `0x1800024D5` | 取纹理槽 `src` → `this+0x348` | 字符串 |
| `0x1800024F3` | 取纹理槽 `srcDepth` → `this+0x350` | 字符串 |
| `0x180002511` | 取纹理槽 `shadowmap` → `this+0x358` | 字符串 |

这六个句柄（`0x338/0x340/0x348/0x350/0x358`）就是所有渲染函数操作的核心。**[证]**

---

## 2. 导出符号地图

### 2.1 `enlight::AGRadar`（20 个导出）

签名已去掉 `__ptr64`、`class/struct` 噪声，保留可读 C++ 形式。

| 导出# | RVA | 访问 | 签名 | 作用 |
|---|---|---|---|---|
| 1 | `0x1FE0` | public | `AGRadar()` | 加载 radar.lua、打开 radar.fx、缓存 cbuffer/technique/纹理槽 |
| 41 | `0x2B20` | public | `~AGRadar()` | 释放 shader/常量缓冲等 |
| 104 | `0x3010` | public | `bool applyConfigPreset(const char* name)` | 按名字应用内置/外部预设；找不到时返回 false 并打日志 |
| 118 | `0x3540` | public | `void buildDBS()` | 置 `this+0x10C = 1`（DBS 重建标志） |
| 126 | `0x3550` | public | `void clear()` | 置 `this+0x367 = 1`（配置/图像脏标志） |
| 136 | `0x3630` | public | `void draw(std::array<render::Texture,3> dst, render::Texture src, render::Texture srcDepth, render::Texture shadowmap)` | 后处理主入口，见 §3.6 |
| 142 | `0x4080` | public | `void drawDebug()` | 实测为空 `ret $0`（0x4080 `c2 00 00`） |
| 162 | `0x4090` | public | `AGRadarData getData() const` | 返回 0x130 字节数据（4 个矩阵 + 标量），见 §5.3 |
| 259 | `0x6530` | public | `void update(Params const&, osg::Vec2i const&, std::function<void(int, Matrixf const&, Matrixf const&, Matrixf const*, Matrixf const&, int)>)` | 每帧驱动：算矩阵、调场景渲染回调，见 §3.5 |
| 105 | `0x3150` | private | `void applyPreset(ConfigPreset const&)` | 把 0x70 字节预设拷贝到实例字段 |
| 113 | `0x3360` | private | `void blurPass(render::Texture, render::Texture)` | DBS/RBM 径向模糊（P7/P8） |
| 193 | `0x4750` | private | `void loadConfig(const char*)` | 读 `Config/Effects/radar.lua` |
| 196 | `0x4960` | private | `bool loadPreset(const char*)` | 动态加载单个预设（可能来自任务/模组） |
| 205 | `0x4FD0` | private | `void parsePreset(ConfigPreset&, Lua::Config&)` | Lua key → ConfigPreset 字段 |
| 223 | `0x57C0` | private | `void renderFinal(render::Texture)` | 最终合成（P12/P13） |
| 226 | `0x59E0` | private | `void renderResult(render::Texture)` | 扫描转换（P9/P10/P11） |
| 227 | `0x5D40` | private | `void renderScanned(render::Texture, render::Texture, render::Texture)` | 场景反射率→雷达图（P0–P6），参数顺序 `(src, srcDepth, shadowmap)` |
| 209 | `0xA0880` | private static | `ed::vector<AGRadar::ConfigPreset>` `presets` | 全局预设表，元素 stride `0x70` |

> 注意：`applyPreset` 是 private 但导出，说明链接器把整个类的符号都导出了；这给钩子提供了“绕过 Lua 配置、直接写结构体”的入口。

### 2.2 `enlight::CScope`（8 个导出）

| 导出# | RVA | 签名 | 作用 |
|---|---|---|---|
| 7 | `0x12920` | `CScope(CScope const&)` | 拷贝构造 |
| 8 | `0x12A90` | `CScope()` | 构造 |
| 44 | `0x13000` | `~CScope()` | 析构 |
| 64 | `0x13180` | `CScope& operator=(CScope const&)` | 赋值 |
| 107 | `0x13380` | `bool available() const` | 是否可用 |
| 120 | `0x13390` | `void buildLines(render::Texture, render::Texture, AGRadarData const&, int)` | 计算/构建地形剖面线（CS 在 `cscope.fx`） |
| 137 | `0x13900` | `void draw()` | 提交线条绘制 |
| 143 | `0x139C0` | `void drawDebug()` | 调试绘制 |

`CScope` 与 `AGRadar` 的关系：`SceneRenderer.dll` 在 `AGRadar::getData()` 之后调用 `CScope::buildLines(texA, texB, data, int)`（`0x180044E17`），两张纹理与 `cscope.fx` 的 `srcDepth`/`shadowmap` 对应，因此它消费的是雷达场景的深度/阴影和 `AGRadarData`（见 §3.7）。调用关系 **[证]**；两张纹理的具体身份 **[推]**。

### 2.3 `enlight::` 命名空间的完整类清单

下表按类给出公开方法（省略了逐字的 `__ptr64`；`ed::basic_string<char>` 简写为 `ed::string`，`ed::vector<T, ed::allocator<T>>` 简写为 `ed::vector<T>`）。清单仅覆盖**有导出符号可见**的类；完全没有导出符号的 `enlight::` 内部类无法从 DLL 导出表恢复。

#### `enlight::Airscrew`
```cpp
Airscrew(Airscrew const&);
Airscrew(ed::string const&, int, osg::Vec2f const&, bool);
Airscrew(char const*, int, osg::Vec2f const&, bool);
virtual ~Airscrew();
Airscrew& operator=(Airscrew const&);
virtual void collectRenderables(unsigned, render::CollectionInfo const* const*, bool const* const,
                                ed::vector<render::ISceneRenderable*>* *, render::ILightProbeSampler&);
void parse(Graphics::ModelParser&);
bool setLivery(unsigned);
void updateParams(osg::Matrixd const&, float, float, float, osg::Vec4f const&,
                  boost::container::small_vector<unsigned char,8> const&);
```

#### `enlight::CScope`
```cpp
CScope(); CScope(CScope const&); ~CScope(); CScope& operator=(CScope const&);
bool available() const;
void buildLines(render::Texture, render::Texture, AGRadarData const&, int);
void draw();
void drawDebug();
```

#### `enlight::CirrusClouds`
```cpp
CirrusClouds(); CirrusClouds(CirrusClouds const&); ~CirrusClouds(); CirrusClouds& operator=(CirrusClouds const&);
static unsigned const gridSize;
static float const texTile;
static unsigned const texturesCount;
void render(CirrusCloudsTechnique);
void setRandomSeed(unsigned);
```

#### `enlight::CirrusCloudsProvider`
```cpp
CirrusCloudsProvider();
void setRandomSeed(unsigned);
```

#### `enlight::CirrusCloudsProviderProxy`
```cpp
CirrusCloudsProviderProxy(DCSSceneProxy*);
~CirrusCloudsProviderProxy();
void setRandomSeed(unsigned);
```

#### `enlight::CloudDetails::DensityMapParams::CloudLayer`
```cpp
CloudLayer();
CloudLayer& operator=(CloudLayer&&);
CloudLayer& operator=(CloudLayer const&);
bool operator==(CloudLayer const&) const;
bool operator!=(CloudLayer const&) const;
bool isEnabled() const;
void updateNoiseFreqWeights(float, float);
void updateNoiseFreqWeights2(float, float);
```

#### `enlight::CloudsDensityMapPreset`
```cpp
CloudsDensityMapPreset(); CloudsDensityMapPreset(CloudsDensityMapPreset const&);
CloudsDensityMapPreset(CloudsDensityMapPreset&&); ~CloudsDensityMapPreset();
CloudsDensityMapPreset& operator=(CloudsDensityMapPreset const&);
CloudsDensityMapPreset& operator=(CloudsDensityMapPreset&&);
bool operator==(CloudsDensityMapPreset const&) const;
bool operator!=(CloudsDensityMapPreset const&) const;
CloudsPresetInfo asPresetInfo() const;
bool isDefaultPreset() const;
bool isValidLayersOrder() const;
ed::string printAsLua() const;
bool readFromConfig(Lua::Config&);
```

#### `enlight::CloudsPresetManager`
```cpp
CloudsPresetManager(); CloudsPresetManager(CloudsPresetManager const&); ~CloudsPresetManager();
CloudsPresetManager& operator=(CloudsPresetManager const&);
CloudsDensityMapPreset const& getCurrentDensityMapPreset() const;
CloudsMapsPreset const& getCurrentMapPreset() const;
CloudsDetailPreset const& getDetailsPreset(char const*) const;
void loadPresets(char const*);
void registerJConfEditor();
bool setDensityMapPreset(CloudsDensityMapPreset const&);
bool setDensityMapPreset(char const*);
bool setMapsPreset(int);
```

#### `enlight::CockpitGlassEffectsRenderer`
```cpp
CockpitGlassEffectsRenderer(render::MSAA_ENUM, int);
~CockpitGlassEffectsRenderer();
void buildCockpitRefraction(render::Texture, render::Texture, render::Texture);
void buildDroplets(render::Texture);
EffectType getType() const;
static void resetFeatures();
void setCockpitParams(CockpitParams const&);
void update(EffectParams const&);
```

#### `enlight::Droplets`
```cpp
Droplets(int);
~Droplets();
void addDrops(int);
void draw();
void setDropletScale(float);
bool update(render::Texture, float, osg::Vec3f const&, float, osg::Vec2d const&, render::Texture);
```

#### `enlight::HelicopterRotor`
```cpp
HelicopterRotor(ed::string const&, ed::string const&, ed::string const&,
                ed::vector<char const*> const&, ed::string const&);
HelicopterRotor(char const*, char const*, char const*, ed::vector<char const*> const&, char const*);
virtual ~HelicopterRotor();
virtual void collectRenderables(unsigned, render::CollectionInfo const* const*, bool const* const,
                                ed::vector<render::ISceneRenderable*>* *, render::ILightProbeSampler&);
void parse(Graphics::ModelParser&);
void setBladeModelIdx(ed::vector<int> const&);
bool setLivery(unsigned);
void updateParams(osg::Matrixd const&, float, float, float, osg::Vec4f const&,
                  ed::vector<std::pair<int,float>> const&,
                  boost::container::small_vector<unsigned char,8> const&);
```

#### `enlight::RayCursor`
```cpp
RayCursor(); RayCursor(RayCursor const&); virtual ~RayCursor(); RayCursor& operator=(RayCursor const&);
static std::unique_ptr<RayCursor> build(render::MSAA_ENUM, float);
```

#### `enlight::SimpleMesh`
```cpp
SimpleMesh(); SimpleMesh(SimpleMesh const&); ~SimpleMesh(); SimpleMesh& operator=(SimpleMesh const&);
void bindGeometry(render::Shader&, render::ve_handle_s*, render::ve_handle_s*,
                  render::ve_handle_s*, render::ve_handle_s*) const;
void bindGeometry(render::Shader&, render::ve_handle_s*) const;
void bindTextureFLIR(render::Shader&, unsigned long long) const;
void bindTextures(render::Shader&, unsigned long long, unsigned long long, unsigned long long) const;
void draw(render::Shader&, unsigned) const;
void draw(render::Shader&, unsigned, unsigned, unsigned) const;
osg::BoundingBoxImpl<osg::Vec3f> const& getBounds() const;
unsigned getLodCount() const;
bool loadFromFBX(char const*, bool, bool);
```

#### `enlight::SplineRopeParsable`
```cpp
SplineRopeParsable(); virtual ~SplineRopeParsable();
virtual void collectRenderables(unsigned, render::CollectionInfo const* const*, bool const* const,
                                ed::vector<render::ISceneRenderable*>* *, render::ILightProbeSampler&);
void setVisible(bool);
void updateParams(ed::vector<osg::Vec3d> const&, float);
```

#### `enlight::SplineRopeRenderer`
```cpp
static std::unique_ptr<SplineRopeRenderer> build();
```

#### 命名空间级符号
```cpp
enlight::Clouds& enlight::clouds;                    // 全局对象
CockpitConfig enlight::loadCockpitConfig(char const*);
void enlight::setModelsVFS(std::shared_ptr<edvfs::IVFSandbox>);
```

#### 仅作为参数/返回值出现的 enlight 类型

这些类型没有（或有很少）独立导出方法，但出现在上面的签名里；做钩子/结构体逆向时必须认识：

| 类型 | 出现位置 | 已知信息 |
|---|---|---|
| `enlight::AGRadar::Params` | `AGRadar::update` 参数 | 0x6C 字节，见 §5.2 |
| `enlight::AGRadarData` | `AGRadar::getData` 返回值、`CScope::buildLines` 参数 | 写到 +0x12B，见 §5.3 |
| `enlight::AGRadar::ConfigPreset` | `AGRadar::presets`、`applyPreset` | 0x70 字节，见 §5.1 |
| `enlight::CloudsDetailPreset` | `CloudsPresetManager::getDetailsPreset` 返回值 | 云层细节预设 |
| `enlight::CloudsMapsPreset` | `CloudsPresetManager::getCurrentMapPreset` 返回值 | 云图预设 |
| `enlight::CloudsPresetInfo` | `CloudsDensityMapPreset::asPresetInfo` / `CloudsModule::getCloudsPresetInfo` | 预设摘要 |
| `enlight::CloudsInitializer` | `render::CloudsModule::init` 参数 | 云初始化参数 |
| `enlight::CloudsSamplingParams` | `render::CloudsModule::addAtmosphereSamplingPass` 参数 | 云采样参数 |
| `enlight::CockpitConfig` | `loadCockpitConfig` 返回值、`applyConfig` 参数 | 座舱配置 |
| `enlight::CockpitGlassEffectsRenderer::CockpitParams/EffectParams/EffectType` | 玻璃效果 renderer | 座舱玻璃参数/类型 |
| `enlight::CirrusCloudsTechnique` | `CirrusClouds::render` 参数 | 卷云 technique 枚举 |
| `enlight::SimpleMesh::Vertex` | `SimpleMesh::init` 参数 | 顶点格式 |
| `enlight::Airscrew::Core` / `HelicopterRotor::Core` | 静态 `core` 成员 | 螺旋桨/旋翼共享实现 |
| `enlight::Clouds` | 全局 `enlight::clouds` | 云系统门面对象 |

### 2.4 相邻命名空间（与 AGRadar 同库、但不是 enlight）

这些类**不是** `enlight::` 的成员，列出以便区分：

- `Graphics::AirscrewProxy`（7 个导出）：构造/析构/赋值、`hide()`、`setLivery(unsigned)`、`updateParams(...)`。
- `Graphics::HelicopterRotorProxy`（8 个）：构造/析构/赋值、`hide()`、`setBladeModelIdx(ed::vector<int> const&)`、`setLivery(unsigned)`、`updateParams(...)`。
- `Graphics::SplineRopeProxy`（5 个）：构造/析构/赋值、`hide()`、`updateParams(ed::vector<osg::Vec3d> const&, float)`。
- `Graphics::Special`：`newSceneProxy(DCSSceneProxy&)`、`deleteSceneProxy(DCSSceneProxy&)`、`generateUniqueObjectId()`、`releaseUniqueObjectId(unsigned)`。
- `render::CloudsModule`（20 个）、`render::CloudsRenderer`（5 个）、`render::CockpitCubeModule`（5 个）、`render::CockpitGlassEffectsModule`（4 个）、`render::IndirectLightVolumeModule`（3 个）、`render::VolumetricLightsCollector`（3 个）。
- `ILV::IndirectLightVolume`（7 个）、`ILV::IndirectLightVolumeBuilder`（18 个）。
- `CockpitCubeWrapper`（12 个）、`FLIRparamsHolder`（7 个）。

> 这些符号和 AGRadar 没有调用关系；AGRadar 的依赖面很小：`render::Shader/Texture/ConstantBuffer`、`osg`、`Lua::Config`、`ed` 容器。

---

## 3. radar.fx 数据流

### 3.1 着色器输入与 cbuffer

`radar.fx:10-12`：

```hlsl
Texture2D        src;        // P0–P6 时 R = 反射率；P7 起为乒乓中间图（R=强度，G=垂直方向图）
Texture2D<float> srcDepth;   // 雷达视角的深度
Texture2DArray<float> shadowmap; // DCS 级联阴影，最多 3 层
```

`radar.fx:14-37` 的 `cbUniforms`（DLL 侧 staging 区在 `this+0x3A0`，大小 `0x210`，渲染前整块上传）：

| cbuffer 偏移 | 字段 | DLL 写入位置/来源 | 含义 |
|---|---|---|---|
| `0x000` | `float4x4 viewProjInv` | `renderFinal`/`renderResult` 中由 `this+0x17C/0x1BC/…` 矩阵求逆/相乘得到 | 雷达相机的 viewProj 逆矩阵，用于从深度恢复世界坐标 |
| `0x040` | `float4x4 shadowmapProj[3]` | `update` 计算，经回调传入；`draw` 的 `shadowmap` 配套 | 每个级联的阴影投影矩阵 |
| `0x100` | `float4x4 rotMatrix` | DBS 扫描旋转 | DBS 扫描线旋转 |
| `0x140` | `float4x4 sampleMatrix` | RMAP 极坐标采样 | RMAP 方位/距离→UV 变换 |
| `0x180` | `float3 radarPos` | `this+0x00`（相机位置）经 `update` 计算 | 雷达/相机世界位置 |
| `0x18C` | `float scanDir` | DBS 扫描方向 | +1/−1 |
| `0x190` | `float3 radarDir` | `update` 计算 | 雷达视线方向 |
| `0x19C` | `uint quant` | `this+0xA8`（预设 quantization） | 最终量化级数 |
| `0x1A0` | `float3 radarOrigin` | `update` 计算 | 雷达原点（用于高度补偿） |
| `0x1AC` | `float offsetBlur` | `this+0x100` | 扫描中心偏移 |
| `0x1B0` | `float3 aircraftDir` | `update` 计算 | 载机朝向 |
| `0x1C0` | `float3 aircraftVel` | `this+0x18..0x20`（Params 速度） | 载机速度，DBS 多普勒用 |
| `0x1D0` | `float4 color` | `this+0x7C`（预设 color） | 最终颜色 |
| `0x1E0` | `float4 params` | 各 pass 分别设置 | `x` 距离/角度，`y` 分辨率，`z` omega，`w` 扫描参数 |
| `0x1F0` | `float4 params2` | 各 pass 分别设置 | 垂直方向图、footprint、deadSpace 等 |
| `0x200` | `float4 scanCut` | 扫描切割平面 | DBS 扇区裁剪 |

> 偏移是按 HLSL 打包规则与 DLL 写入点（`0x1E0/0x1D0/0x19C/0x1AC/0x580…0x59C`）对齐得到的；**[证]** 关键锚点：`renderFinal` 把 `this+0x7C` 写到 `+0x1D0`、把 `this+0xA8` 写到 `+0x19C`（`0x1800058C7-0x1800058E1`）；`blurPass` 把 `this+0x90/0x98/0x94/0xA0` 写到 `+0x1E0/+0x1E4/+0x1E8/+0x1F0`（`0x1800033B7-0x1800033F9`）。

### 3.2 technique `Radar` 的 pass 表

`radar.fx:391-475` 定义 15 个 pass。DLL 侧用三张索引表选择 pass：

| 表 VA | 内容 | 用途 |
|---|---|---|
| `0x18007A8E0` | `0,1,2, 0,1,2, 3,3,3, 4,5,5, 6,6,6` | `renderScanned`：mode×级联数 → P0–P6 |
| `0x18007A91C` | `7,8,7,7,7` | `blurPass`：mode 1(DBS) → P8，其余 → P7 |
| `0x18007A930` | `9,10,11,9,9` | `renderResult`：RBM→P9，DBS→P10，RMAP→P11，TPM/TA→P9 |
| `0x18007A944` | `12,12,12,13,13` | `renderFinal`：RBM/DBS/RMAP→P12，TPM/TA→P13 |

mode 枚举（`this+0x134`）：`0=rbm, 1=dbs, 2=rmap, 3=tpm, 4=ta`。**[证]**（`parsePreset` 0x52DA–0x536B 的字符串比较）

> 注意 DBS 的第一阶段仍用 RBM 的 P0–P2：`renderScanned` 表对 mode 1 返回 `0,1,2`，即先按入射角/材质算反射率，再由 P8/P10 转成距离-多普勒。**[证]**

### 3.3 `src` 是什么、谁渲染了它

**结论（[证]）**：`src` 是 DCS 普通场景几何在“雷达材质”technique 下渲染出的**反射率图**，不是 AGRadar 生成的颜色缓冲。

证据链：

1. `Bazar/shaders/model/functions/radar.hlsl:34-43`：
   ```hlsl
   float4 radar_ps(const VS_OUTPUT_RADAR i): SV_TARGET0 {
       ...
       float val = radarValue(gRadarPos, wpos, i.Normal, uipo[4][1]);
       return float4(val, 0, 0, 1);
   }
   ```
   `radarValue()`（`radarFunc.hlsl:33-41`）用雷达位置、世界坐标、法线、材质系数和距离计算回波强度；`uipo` 表（`radarFunc.hlsl:4-12`）给出森林/草原/雪/沙漠/跑道/海面的反射系数。`gRadarPos` 是引擎在雷达渲染 pass 中设置的 uniform（`radar.hlsl:41`）。**[证]**
2. 该 technique 被三个模型材质文件包含：
   - `model/def_material.fx:13`，`TECHNIQUE radar` 在 `:164-186`；
   - `model/deck_material.fx:25`，`technique11 radar` 在 `:111-127`；
   - `model/glass_material.fx:13`，`TECHNIQUE radar` 在 `:129-…`。
   `radar` technique 的 P0 用 `radar_vs/radar_ps`，P1 用 `radar_edge_gs/radar_edge_ps`（角反射器边缘）。**[证]**
3. `SceneRenderer.dll` 里有与雷达渲染图完全对应的字符串和 RTTI：
   - 字符串：`RadarOrtho`（`0x180052508`）、`RadarOrthoDepth`（`0x1800524F8`）、`RadarShadowmap`（`0x1800524E8`）、`RadarTemp`（`0x180052518`）、`RadarMainPass`（`0x180052568`）、`RadarOrthoPass`（`0x180052528`）、`RadarOrthoDepthPass`（`0x180052538`）、`RadarShadowmapPass`（`0x180052550`）。**[证]**
   - RTTI：`render::RadarModule::addPasses(DCSMFDDesc::RadarParams const&, RenderGraph&, ISceneRenderContextBinder const&, FrameContext const&, RenderGraphTexture, WaterModule&)`、`addOrthoPass(...)`、`addOrthoDepthPass(...)`、`addShadowmapPass(... std::array<SceneRenderContext,3> const&, int)`。**[证]**
   - 纹理创建点：`0x180046F61` 创建 `RadarShadowmap`，`0x180046F93` 创建 `RadarOrthoDepth`，`0x180046FC8` 创建 `RadarOrtho`。**[证]**
4. `AGRadar::update` 的回调就是 `RadarModule::addPasses` 里构造的 lambda；它拿到的矩阵被逐级联塞进 `SceneRenderContext` 并交给场景渲染函数（见 §3.5）。**[证]**

**因此**：`src` 的 R 通道在 P0–P6 阶段就是 `radarValue()` 的输出；在 P7–P13 阶段，`src` 这个纹理槽会被重新绑定到上一阶段的中间图（PS_SOURCE 同时写 `(val, rp)`，PS_SCAN 读 `.xy`），所以“`src`”在 shader 里是**乒乓输入**，不是固定的一张图。**[证]**（`radar.fx:189-273` 与 `:315-346`；DLL 每个 pass 前都调用 `setTexture(this+0x348, …)`）

> 证据等级区分：`src` 的**内容生产**（model `radar` technique 写 R 通道）是 **[证]**；`src` 这张纹理在 `SceneRenderer` 里具体叫 `RadarOrtho`、并与 `draw` 的第 2 个纹理参数 1:1 对应，是 **[推]**（名称、创建点和参数位置都吻合，但未在调用点逐字段确认）。`srcDepth`/`shadowmap` 同理。

### 3.4 `srcDepth` 与 `shadowmap`

- `srcDepth`：同一次雷达正交渲染的深度缓冲。`radar.fx:141-143` 用 `srcDepth.Load(uint3(i.pos.xy,0))` 取深度，再用 `viewProjInv` 恢复世界坐标；`cscope.fx:41-47` 做同样的事。SceneRenderer 的 `RadarOrthoDepth` 纹理和 `addOrthoDepthPass` 与之对应（内容 **[证]**，名称绑定 **[推]**）。
- `shadowmap`：`Texture2DArray<float>`（`radar.fx:12`），`calcShadow()`（`:182-187`）用 `shadowmapProj[idx]` 变换到级联空间并 `SampleCmpLevelZero`；级联数由 `update` 写入 `this+0x130`，断言字符串明确 `shadowmapCount > 0 && shadowmapCount <= 3`（`0x18007AC28`），`update` 里 `ceil(this+0x24 / 140.0f)` 后 clamp 到 1–3（`0x180007074-0x1800070AC`）。SceneRenderer 的 `RadarShadowmap` 纹理和 `addShadowmapPass` 与之对应（内容 **[证]**，名称绑定 **[推]**）。

### 3.5 `update()` 的回调到底是什么

#### 3.5.1 真实签名

导出 #259 的反混淆结果：

```cpp
void enlight::AGRadar::update(
    AGRadar::Params const& params,
    osg::Vec2i const& viewportSize,
    std::function<void(int, osg::Matrixf const&, osg::Matrixf const&,
                       osg::Matrixf const*, osg::Matrixf const&, int)> cb);
```

`SceneRenderer.dll` 的 RTTI 进一步确认了 lambda 类型：

```
std::_Func_impl_no_alloc<
  <lambda_1> in render::RadarModule::addPasses(...),
  void, int,
  osg::Matrixf const&, osg::Matrixf const&,
  osg::Matrixf const*, osg::Matrixf const&, int>
```

**[证]** 这与任务描述的 5 参数版本不同：第 3 个矩阵参数之后是 `Matrixf const*`（阴影数组指针），再跟一个 `Matrixf const&`，最后才是 `int`；没有 `AGRadarData const*`。

#### 3.5.2 调用点与实参映射

`AGRadar::update` 在 `0x1800077B7-0x1800077F7` 调用回调。这里是 MSVC 旧版 `std::function` 的 `_Do_call` 约定：**按值参数以“指向临时量”的指针传递**，invoker thunk（`SceneRenderer.dll 0x180045E80`）会先解引用，再跳到 lambda 体（`0x180044450`）。因此调用点的 ABI 形式与逻辑签名不完全一样：

| 调用点位置 | 调用点实际值（ABI 形式） | 逻辑参数（lambda 看到的值） |
|---|---|---|
| `rcx` | `[std::function+0x38]` 指向的 functor | 可调用对象；thunk 会 `add $8,%rcx` 后进入 lambda 体 |
| `rdx` | `&[rsp+0x50]`，临时 int = `this+0x134` | 参数 1：mode（0–4）；thunk 做 `mov (%rdx),%edx` 解引用 |
| `r8` | `&rbp+0x30`（矩阵 A 的地址） | 参数 2：`Matrixf const&` 视图矩阵 **[推]** |
| `r9` | `&this+0x13C`（矩阵 B 的地址） | 参数 3：`Matrixf const&` 投影矩阵 **[推]** |
| `[rsp+0x20]` | `&[rsp+0x40]`，该槽内容为 `&rbp+0x70` | 参数 4：`Matrixf const*`，指向阴影级联矩阵数组；thunk 解引用一次 |
| `[rsp+0x28]` | `&rbp-0x10`（矩阵 C 的地址） | 参数 5：`Matrixf const&` 第二个投影/近远变体 **[推]** |
| `[rsp+0x30]` | `&[rsp+0x60]`，临时 int = `this+0x130` | 参数 6：`shadowmapCount`（1–3）；thunk 解引用 |

**[证]** 参数 1/3/4/6 的映射可直接从指令读出；参数 2/5 的“视图/投影”命名是结合回调实现推断的 **[推]**。**对钩子的含义**：不要按“rdx 是 int 值、栈参数 4 是 Matrixf*”去写汇编转发；`AGRadar::update` 的导出边界是正常的 `std::function` 对象，钩子只应转发这个对象本身，不要手工拆它的实参。

调用后 `update` 立即把 `this+0x138`（状态机）置 1：`0x1800077F7: movl $1, 0x138(%rbx)`。**[证]**

#### 3.5.3 回调实现（SceneRenderer.dll）

- `SceneRenderer.dll` 在 `0x180046194` 调用 `AGRadar::update`（IAT 项 `0x18004F818`）。**[证]**
- 调用前在 `0x180046095-0x180046181` 逐字段构造 `AGRadar::Params`（见 §5.2）。**[证]**
- 回调 functor 的 vtable 在 `0x180052840`，其中 `+0x10` 指向 `0x180045E80`，后者跳到 `0x180044450`。**[证]**
- `0x180044450` 的实现：
  - 把参数 2/3/5 的矩阵和参数 4 的级联数组复制进最多 3 个 `SceneRenderContext`（每个 `0x588` 字节；循环 `add 0x588`、`sub 1`，次数 = 参数 6）。**[证]**
  - 每级联调用 `0x180014FA0`（场景渲染辅助函数）。**[证]**
  - 之后调用 `0x180046220`，传入 functor 捕获的渲染目标/渲染图上下文和 `SceneRenderContext` 数组。**[证]**
- functor 的捕获数据里包含渲染目标/渲染图对象指针（`0x60` 字节的 functor，构造于 `0x180046021`）；这些对象正是 `RadarOrtho` / `RadarOrthoDepth` / `RadarShadowmap`。**[证]**（字符串与创建点见 §3.3）

#### 3.5.4 结论

| 问题 | 结论 | 证据等级 |
|---|---|---|
| 回调是不是“视图矩阵供给”？ | 是，但不只是：它确实收到视图/投影/阴影矩阵 | **[证]** |
| 回调是不是“场景重渲染回调”？ | **是**：它逐级联构造渲染上下文并调用场景渲染，把雷达视角场景写进渲染目标 | **[证]** |
| 回调返不返回纹理？ | 不返回。`src`/`srcDepth`/`shadowmap` 由 `SceneRenderer` 的 `RadarModule` 持有，随后作为 `draw()` 的入参传入 | **[证]** |
| 回调是否每次 `update` 调用一次？ | 是，`update` 只在 `0x1800077F4` 调用一次 | **[证]** |

> 对钩子的含义：**不要只替换矩阵**。如果你想“任意机型独立驱动”，必须提供一个等价的场景渲染回调；仅仅构造 `Params` 并调用 `update` 不会产生 `src`。

### 3.6 `draw()` 的六张纹理与状态机

`draw(std::array<render::Texture,3> dst, render::Texture src, render::Texture srcDepth, render::Texture shadowmap)`：

- `src` / `srcDepth` / `shadowmap` 是输入，分别对应 §3.3/§3.4。
- `dst[0]`：`renderResult` 的**输入**（中间扫描图）。证据：`0x1800039AC` / `0x180003F4C` 把 `&array[0]` 作为 `renderResult` 的纹理参数；`renderResult` 内部把它绑定到 `src` 槽（`0x180005C7D`）。**[证]**
- `dst[2]`：`renderResult` 的**输出目标**，也是 `renderFinal` 的**输入**（最终雷达图）。证据：`renderResult` 之前用 `0x53E0` 以 `array[2]` 为目标（`0x1800038C8` / `0x180003E65`）；`renderFinal(array[2])` 把 `array[2]` 绑定到 `src` 槽（`0x180005948-0x18000594F`），再合成到当前绑定的 MFD 目标。**[证]**
- `dst[1]`：state 2 的扫描源临时目标；`renderScanned` 把场景反射率画到这里，随后 `blurPass` 在 `dst[1]`/`dst[0]` 之间做径向模糊。**[推]**（`0x180003A39` 用 `array[1]` 调 `0x53E0`；具体 ping-pong 次序需动态截帧确认）

`draw` 的 `this+0x138` 状态机（`0x18000388E` 起）：

| 状态 | 行为 | 证据 |
|---|---|---|
| 0 | 只做 `renderFinal(dst[2])` | `0x180003F77-0x180003FA5` |
| 1 | 以 `dst[2]` 为目标开始 pass，`renderResult(dst[0])`，状态→2 | `0x180003E4D-0x180003F71` |
| 2 | （非 TPM/TA）以 `dst[1]` 为临时目标，`renderScanned(src,srcDepth,shadowmap)`，`blurPass`，状态→3 | `0x180003A08-0x180003CC8` |
| 3 | 以 `dst[2]` 为目标，`renderResult(dst[0])`；DBS 脏标志允许回到 0/1 | `0x1800038B0-0x1800039D2` |

### 3.7 `CScope` 与 `cscope.fx`

`cscope.fx` 是 compute shader：

- 输入：`srcDepth`、`shadowmap`、`srcPoints`（`cscope.fx:5-9`）。
- cbuffer：`viewProj`、`viewProjInv`、`shadowmapProj[3]`、`radarPos`、`radarDir`、`distanceFar`、`distances`、`srcDims`（`:11-21`）。
- `CS_TEST`/`CS_MAX` 沿 361 个方位（0.5° 步进）采样深度，重建世界坐标并做阴影测试，输出 `dstPoints`（`:37-89`）。
- `CScope::buildLines(textureA, textureB, AGRadarData const&, int)`（`0x13390`）由 `SceneRenderer` 在 `getData()` 之后调用（`0x180044DBA-0x180044E17`），用于地形剖面/TA 提示线。**[证]**

### 3.8 `Config/Effects/radar.lua` 预设逐字段

`radar.lua:1-124` 定义 `radar.presets`。`parsePreset`（`0x4FD0`）把 Lua key 写入 `ConfigPreset`：

| Lua key | ConfigPreset 偏移 | 默认值 | 含义 | 证据 |
|---|---|---|---|---|
| `viewport` | `+0x20` float[4] | `{0,0,1,1}` | MFD 子视口（归一化 x,y,w,h），`renderFinal` 缩放 | `0x50D2-0x5139` |
| `color` | `+0x30` float[4] | `{0,1,0,1}` | 最终颜色 RGBA | `0x514C-0x51A9` |
| `verticalAngle` | `+0x40` float | `90.0` | 垂直方向图半角（度） | `0x4FF7-0x501B` |
| `blurAngle` | `+0x44` float | `3.3` | 方位模糊/投影 FOV 参数（度） | `0x501B-0x503F` |
| `resolution` | `+0x48` float | `19.0` | DBS 距离/多普勒分辨率 | `0x503F-0x5063` |
| `omega` | `+0x4C` float | `0.5` | DBS 扫描角速率 | `0x5063-0x5087` |
| `blankAngle` | `+0x50` float | `5.0` | DBS 前向扇区消隐半角（度） | `0x5087-0x50AB` |
| `quantization` | `+0x54` int | `256`（ctor 实际默认 8） | 最终量化级数 | `0x50AB-0x50CF` |
| `overlapAngle` | `+0x58` float | `0.0` | RMAP 方位重叠 | `0x51A9-0x51CA` |
| `deadSpace` | `+0x5C` float[2] | `{0.1006,-0.1184}` | TPM 俯仰死区上下界（归一化） | `0x51CA-0x5239` |
| `elevationBias` | `+0x64` float | `0.0` | TPM 高度偏置（米） | `0x5239-0x525A` |
| `clearancePlane` | `+0x68` float | `0.0` | TPM/TA 净空平面高度（米） | `0x525A-0x527B` |
| `mode` | `+0x6C` int | `0` | `rbm/dbs/rmap/tpm/ta` → 0/1/2/3/4 | `0x527B-0x536B` |

`applyPreset`（`0x3150`）再把 `ConfigPreset` 拷贝到实例：

| ConfigPreset | AGRadar 成员 | 说明 |
|---|---|---|
| `+0x20` | `+0x6C` | viewport |
| `+0x30` | `+0x7C` | color |
| `+0x40` | `+0x8C` | verticalAngle |
| `+0x44` | `+0x90` | blurAngle |
| `+0x48` | `+0x98` | resolution |
| `+0x4C` | `+0x94` | omega |
| `+0x50` | `+0xA0` | `cos(blankAngle)`（`applyPreset` 里 `cosf(angle*π/180)`，`0x3194-0x31B5`） |
| `+0x54` | `+0xA8` | quantization |
| `+0x58` | `+0xA4` | overlapAngle |
| `+0x5C` | `+0xAC` | deadSpace[2] |
| `+0x64` | `+0xB4` | elevationBias |
| `+0x68` | `+0xB8` | clearancePlane |
| `+0x6C` | `+0x134` | mode |
| — | `+0x138 = (mode==1 ? 3 : 0)` | 状态机初值 |

`applyPreset` 末尾还置 `+0x367=1`（脏）、`+0x10C=0`、`+0x394=0`。**[证]**

#### EXP / DBS1 / DBS2 专项

| 预设 | mode | resolution | blankAngle | omega | quantization | blurAngle | viewport | color |
|---|---|---|---|---|---|---|---|---|
| `EXP1` | dbs | 19 | 5.0 | 1.13446 | 8 | 3.3 | 9% inset | 绿 |
| `EXP2` | dbs | 67 | 5.0 | 1.13446 | 8 | 3.3 | 9% inset | 绿 |
| `EXP3` | dbs | 120 | 5.0 | 1.13446 | 8 | 3.3 | 9% inset | 绿 |
| `EXP_F16` | dbs | 19 | 0.0 | 1.13446 | 8 | 3.3 | 全屏 | 白 |
| `DBS1_F16` | dbs | 67 | 0.0 | 1.13446 | 8 | 3.3 | 全屏 | 白 |
| `DBS2_F16` | dbs | 120 | 0.0 | 1.13446 | 8 | 3.3 | 全屏 | 白 |
| `GM_F16` | rbm | — | — | — | — | 1.0 | 全屏 | 白 |
| `GM_F16_RBM` | rbm | — | — | — | — | 3.3 | 全屏 | 白 |

`resolution` 在 `radar.fx:138-176` 的 `blurRadialDBS` 里直接进入 `x = k * teta_dopler / KERNEL_SIZE * resolution * 0.5`，决定多普勒滤波旁瓣宽度；数值越大，DBS 方位分辨率越高、可分辨的 Doppler bin 越细。`blankAngle` 在 `PS_SOURCE` 的 `scanCut` 和 `blurRadialDBS` 的 `cosBlankAngle` 里控制前向消隐扇区。`omega` 进入 `teta_dopler` 的 `omega/theta` 项。**[证]**

> F-16 相关预设名（`GM_F16`、`GM_F16_RBM`、`EXP_F16`、`DBS1_F16`、`DBS2_F16`）证明雷达页面使用同一套 AGRadar 预设；它们是否由 F-16 的 avionics 在特定页面调用 `applyConfigPreset`，从名称上高度可信，但精确调用点仍需在 F-16 的 avionics DLL 中确认。**[推]**

---

## 4. 其他相关 shader

### 4.1 `radarFunc.hlsl`

- `uipo[7][2]`（`:4-12`）：七类地表/海面的反射系数区间（森林、草原、雪、沙漠、跑道、海面 2/6 点）。`radar_ps` 用 `uipo[4][1]`（跑道）作为默认材质系数。
- `rand/radarRnd`（`:14-20`）：基于世界坐标的确定性随机，模拟 speckle。
- `radarPhisicalValue`（`:22-31`）：`epr = m * max(dot(V,N),0) * S`，`z = sqrt(-2 epr² ln(rnd))`，`return Po*Ptx/R^4*z`——简化雷达方程。
- `radarCornerReflector`（`:43-53`）：角反射器边缘（`radar_edge_ps`）。

### 4.2 `model/functions/radar.hlsl`

- `radar_vs`（`:9-32`）：普通模型顶点变换；`o.Pos` 是世界坐标，`o.projPos` 用 `gViewProj`。
- `radar_ps`（`:34-43`）：`clipByDiffuseAlpha`、损伤测试、`radarValue` 写 R。
- `radar_edge_gs/ps`（`:50-64`）：每个三角形的偶数 primitive 生成角反射器点。

---

## 5. 关键结构体布局

> 这些布局来自反汇编的字段读写，不是 PDB 调试信息。偏移是 64 位 MSVC 布局。

### 5.1 `AGRadar::ConfigPreset`（0x70 字节）

见 §3.8 的表；总大小由 `presets` 数组 stride `0x70` 证实（`applyConfigPreset` 的 `add $0x70,%rbx`，`0x1800030D5`）。**[证]**

### 5.2 `AGRadar::Params`（0x6C 字节）

`SceneRenderer.dll` 的 `render::RadarModule::addPasses` 在 `0x180046095-0x180046181` 逐字段构造它，`update` 在 `0x1800065DC-0x18000664B` 逐字段复制到实例。

| 偏移 | 类型 | 来源（SceneRenderer `0x180046095` 起） | 推断含义 | 证据等级 |
|---|---|---|---|---|
| `0x00` | `Vec3f` | `RadarModule+0x164/0x168/0x16C`（相机位置） | 相机/眼点世界坐标 | **[证]** 来源；语义 **[推]** |
| `0x0C` | `Vec3f` | `RadarParams.position.xyz - cameraPos`（三个 float） | 雷达天线相对相机的位置 | **[证]** 计算；命名 **[推]** |
| `0x18` | `Vec3f` | `RadarParams+0x18/+0x1C/+0x20` | 载机速度（shader `aircraftVel`） | **[推]**（update 用它算 Doppler/角度） |
| `0x24` | `float` | `RadarParams+0x24` | 距离/视场标量；`ceil(x/140)`→级联数，`tan(0.5*(x/级联+blurAngle))`→投影 | **[证]** 用法；语义 **[待]** |
| `0x28` | `float` | `RadarParams+0x28` | 扫描几何 | **[待]** |
| `0x2C` | `float` | `RadarParams+0x2C` | 扫描几何 | **[待]** |
| `0x30` | `float` | `RadarParams+0x30` | 扫描几何/覆盖项（受 `this+0x361` 标志控制） | **[待]** |
| `0x34` | `float` | `RadarParams+0x34` | 同上（受 `0x362`） | **[待]** |
| `0x38` | `float` | `RadarParams+0x38` | 同上（受 `0x363`） | **[待]** |
| `0x3C` | `float` | `RadarParams+0x3C` | 同上（受 `0x364`）；`renderFinal` 把它写进 `params.x` | **[证]** 用法 |
| `0x40` | `float` | `RadarParams+0x40` | 同上（受 `0x365`） | **[待]** |
| `0x44` | `float` | `RadarParams+0x44` | 同上 | **[待]** |
| `0x48` | `float` | `RadarParams+0x48` | 同上 | **[待]** |
| `0x4C` | `float` | `RadarParams+0x4C` | 若为 0，`update` 回退到 `this+0xB8`（clearancePlane） | **[证]** 回退逻辑 |
| `0x50` | `double` | `RadarParams+0x7C` | 未知（时间/距离） | **[待]** |
| `0x58` | `float` | `RadarParams+0x84` | 未知 | **[待]** |
| `0x5C` | `double` | `RadarParams+0x88` | 未知 | **[待]** |
| `0x64` | `float` | `RadarParams+0x90` | 未知 | **[待]** |
| `0x68` | `float` | `RadarParams+0x94` | 未知 | **[待]** |

> 关键点：**`Params` 的 0x00–0x20 已经足够驱动“雷达在哪里、看哪里、载机多快”**；0x24 以后是模式相关的扫描/距离/高度参数，策略 B 必须逐项动态标定。`this+0x361..0x366` 是“外部覆盖开关”，只有对应标志为 0 时 `update` 才接受 Params 的 0x30–0x48；这些标志由内部逻辑/预设控制。**[证]**

### 5.3 `AGRadarData`（实际写到 +0x12B，按 16 字节对齐大小应为 0x130）

`getData()`（`0x4090`）把实例字段直接拷进返回值：

| 偏移 | 类型 | 来源（`this+`） | 说明 |
|---|---|---|---|
| `0x000` | `osg::Matrixf` | `0x17C` | 矩阵 1 |
| `0x040` | `osg::Matrixf` | `0x1BC` | 矩阵 2 |
| `0x080` | `osg::Matrixf` | `0x1FC` | 矩阵 3 |
| `0x0C0` | `osg::Matrixf` | `0x23C` | 矩阵 4 |
| `0x100` | `int` | `0x130` | shadowmapCount（1–3） |
| `0x108` | `double` | `(double)this+0x0C` | Params 0x0C 分量 |
| `0x110` | `double` | `(double)this+0x10` | Params 0x10 分量 |
| `0x118` | `double` | `(double)this+0x14` | Params 0x14 分量 |
| `0x120` | `double` | `this+0x18`（8 字节） | 速度前两分量/双精度槽 |
| `0x128` | `int` | `this+0x20`（4 字节） | 速度第三分量的位模式 |

四个矩阵的语义尚未逐一定名；从 `getData` 的调用方（`CScope`、HUD/符号绘制）看，它们应覆盖雷达视图/投影/扫描变换。**[推]** 需要动态 dump 后与 `update` 回调参数比对才能定名。

### 5.4 `AGRadar` 实例关键偏移

| 偏移 | 类型 | 含义 | 证据 |
|---|---|---|---|
| `0x00` | `Params`（0x6C） | 最近一次 update 的输入副本 | `0x65DC-0x664B` |
| `0x6C` | `float[4]` | viewport | `applyPreset` |
| `0x7C` | `float[4]` | color | `applyPreset` |
| `0x8C/0x90/0x94/0x98` | float | verticalAngle/blurAngle/omega/resolution | `applyPreset` |
| `0xA0` | float | `cos(blankAngle)` | `applyPreset` |
| `0xA4` | float | overlapAngle | `applyPreset` |
| `0xA8` | int | quantization | `applyPreset`/`renderFinal` |
| `0xAC` | float[2] | deadSpace | `applyPreset` |
| `0xB4/0xB8` | float | elevationBias/clearancePlane | `applyPreset` |
| `0xBC` | `Matrixf` | DBS/RMAP 专用矩阵 | `0x6B7D-0x6D5B` |
| `0x100` | float | offsetBlur | `0x6BEA`/`blurPass` |
| `0x10C` | bool | buildDBS 标志 | `buildDBS` |
| `0x110` | `std::string` | 当前预设名（SSO；size `0x120`，cap `0x128`） | `applyConfigPreset` |
| `0x130` | int | shadowmapCount | `update` |
| `0x134` | int | mode（0–4） | `applyPreset` |
| `0x138` | int | 渲染状态机 | `draw` |
| `0x13C` | `Matrixf` | 回调参数 3（投影矩阵） | `update` 0x6F0C |
| `0x17C/0x1BC/0x1FC/0x23C` | `Matrixf`×4 | `AGRadarData` 的四个矩阵 | `getData` |
| `0x27C/0x2BC` | `Matrixf`×2 | 单级联特例矩阵 | `update` 0x76F5/0x7772 |
| `0x300` | bool | 上述特例开关 | `update` 0x764F |
| `0x308` | `render::Shader*` | radar.fx shader | ctor |
| `0x338` | technique 句柄 | `Radar` | ctor |
| `0x340` | cbuffer 句柄 | `cbUniforms` | ctor |
| `0x348/0x350/0x358` | 纹理槽句柄 | `src`/`srcDepth`/`shadowmap` | ctor |
| `0x360` | bool | 某内部开关 | `update` |
| `0x361..0x366` | bool×6 | Params 覆盖标志 | `update` |
| `0x367` | bool | 配置/图像脏标志 | `clear`/`applyPreset` |
| `0x394` | float | 扫描积分状态 | `update` |
| `0x398` | double | 时间/角度累加器 | `update` 0x6787 |
| `0x3A0` | `uint8[0x210]` | cbuffer staging | `renderFinal`/`renderResult` |
| `0x5B0` | `render::ConstantBuffer*` | 上传用常量缓冲对象 | `0x62AF`/`0x58F6` |

---

## 6. 钩取策略评估

### 6.1 策略 A：钩游戏已有实例（跟 F-16 雷达页面走）

#### 可行钩点

| 钩点 | 地址/方式 | 能拿到什么 | 难度 |
|---|---|---|---|
| `AGRadar::update` | `enlight.dll+0x6530`（导出 #259），inline hook 或 IAT hook | `Params`、viewport、`std::function` 回调；可在调用前改 `Params` | 低（只需转发寄存器） |
| `AGRadar::draw` | `enlight.dll+0x3630`（导出 #136） | 6 张 `render::Texture`：`dst[3]`、`src`、`srcDepth`、`shadowmap` | 中（`Texture` 是 0x18 字节值类型） |
| `AGRadar::applyConfigPreset` | `enlight.dll+0x3010`（导出 #104） | 预设名（`GM_F16`/`DBS1_F16`/`DBS2_F16`…），可用来识别 F-16 页面 | 低 |
| `AGRadar::AGRadar` / `~AGRadar` | `enlight.dll+0x1FE0` / `+0x2B20` | 实例指针生命周期，可维护 registry | 低 |
| `SceneRenderer!AGRadar::update` IAT | `SceneRenderer.dll+0x4F818` | 同 update；IAT 项在模块加载后可直接改指针 | 低 |
| `SceneRenderer!AGRadar::draw` IAT | `SceneRenderer.dll+0x4F810` | 同 draw | 低 |
| `render::RadarModule::addPasses` | `SceneRenderer.dll` 内部（函数约 `0x45F40`） | `DCSMFDDesc::RadarParams`、`RenderGraph&`、渲染目标；比 update 更上游 | 高（内部函数、签名复杂、无导出） |

> `SceneRenderer.dll` 的 IAT 项（RVA）：`draw=0x4F810`、`update=0x4F818`、`applyConfigPreset=0x4F820`、`getData=0x4F808`、`CScope::buildLines=0x4F7F8`、`AGRadar ctor=0x4F830`、`dtor=0x4F828`。**[证]**

#### 需要逆向的结构体

- **`Params`**：至少 0x00–0x24 必须完全理解（位置、雷达相对位置、速度、距离/视场）；0x24 以后的模式相关字段用于改写扫描/距离/高度。见 §5.2。
- **`AGRadar` 实例布局**：`0x130/0x134/0x138`（级联数、mode、状态）、`0x338..0x358`（technique/cbuffer/纹理槽）、`0x110`（当前预设名）。用于判断“当前是不是 F-16 雷达页面”和“当前渲染到哪一步”。
- **`AGRadarData`**：如果要把雷达画面交给自己的 HUD/符号系统，需要 0x130 字节布局；`CScope::buildLines` 已经示范了消费方式。
- **`ConfigPreset`**：如果要注入自定义预设（而不是改 `radar.lua`），需要 0x70 字节布局。
- **`render::Texture`**：如果要在 `draw` 里替换输出/输入纹理，需要知道 0x18 字节布局（shared_ptr + 3×uint16）。**[推]** 0x18 来自构造/拷贝代码 `0x1800025E0` 与 `draw` 的数组 stride。

#### 难点

1. **实例生命周期与页面识别**：`AGRadar` 由 `SceneRenderer` 创建；F-16 雷达页面可能在进入/退出 MFD 页面时创建/销毁。钩 ctor/dtor 维护 registry 是可行的，但需要判断“哪一个实例对应玩家当前页面”。用 `applyConfigPreset("GM_F16"/"DBS1_F16"/"DBS2_F16")` 做识别是最便宜的方案。**[推]**
2. **回调不可随意替换**：`std::function` 由 `SceneRenderer` 构造并拥有；如果钩 `update` 时把回调换掉，必须保证新回调能完成场景渲染，否则 `src`/`srcDepth` 为空。更安全的做法是**只改 `Params`，原样转发回调**。**[证]**（回调职责见 §3.5）
3. **渲染线程/时序**：`update`/`draw` 在渲染线程调用；钩子代码不能做阻塞 I/O、不能调用 Lua、不能假设主线程状态。**[推]**
4. **纹理生命周期**：`draw` 的 `src`/`srcDepth`/`shadowmap` 是渲染图临时纹理；如果钩子保存句柄跨帧使用，可能悬空。**[推]**
5. **ABI**：AGRadar 导出是 MSVC C++ ABI；MinGW DLL 不能构造 `std::function`/`std::array<render::Texture,3>`，但**纯转发型 detour 不需要构造**，只要保持寄存器/栈原样。若要调用 `applyConfigPreset`（只有一个 `const char*`）则完全安全；若要调用 `getData`（返回 0x130 字节结构）也可按值返回内存布局处理。**[推]**
6. **版本脆弱性**：RVA 每次 DCS 更新都会变；应通过导出名/模式扫描定位，而不是硬编码 RVA。**[推]**
7. **多人完整性**：运行时 inline hook 不改文件，但仍有被服务器完整性校验/反作弊标记的风险；这是策略层风险，不是技术障碍。**[推]**

#### 优点

- 场景渲染、材质、正交相机、级联阴影、水面/地形遮蔽全部由引擎完成，画面与 F-16/F-18 原版一致。
- 只需少量结构体知识即可“改参数/改预设/截画面”。
- 不需要自己创建 `render::Texture` 或重造渲染图。

### 6.2 策略 B：自构造实例独立驱动（任意机型可用）

#### 需要做的事

```cpp
auto* radar = new enlight::AGRadar();          // 导出 #1
radar->applyConfigPreset("GM_F16");            // 导出 #104
radar->update(params, osg::Vec2i(w,h), cb);    // 导出 #259
radar->draw(dst, src, srcDepth, shadowmap);    // 导出 #136
```

看起来只有四步，但每一步都有硬门槛：

1. **构造时机**：ctor 会调用 `RenderAPI::openShader("enlight/radar.fx")` 和 `Lua::Config::open("Config/Effects/radar.lua")`；必须在渲染设备/RenderAPI 初始化之后、在渲染线程上调用。从 Saved Games 的 Lua Hooks 进入的代码通常在模拟/主线程，直接 `new AGRadar` 可能崩溃或拿到空 shader。**[推]**
2. **回调必须自己实现**：`update` 只负责算矩阵和调用回调；`src`/`srcDepth`/`shadowmap` 不在 `AGRadar` 内部生成。要得到有意义的雷达图，回调必须：
   - 用传入的视图/投影矩阵建立雷达正交相机；
   - 遍历场景，用 `model` 材质的 `radar` technique 渲染反射率到 `RadarOrtho`；
   - 渲染 `RadarOrthoDepth`；
   - 生成/复制 1–3 级 `RadarShadowmap`；
   - 处理水面、地形、建筑、植被的材质区分。
   这实际上是在重造 `render::RadarModule::addPasses/addOrthoPass/addOrthoDepthPass/addShadowmapPass`。**[证]**（这些方法存在于 SceneRenderer，且是回调的宿主）
3. **渲染目标**：`draw` 需要 3 张 `render::Texture` 作为目标、3 张作为输入。`render::Texture` 是引擎内部值类型（0x18 字节，含 shared_ptr + 元数据），没有导出构造函数；要么从游戏渲染图里“借”，要么用引擎 API 创建，要么用裸 D3D11 纹理 + 手工伪造 `render::Texture`。**[推]**
4. **ABI**：`std::function`（MSVC 实现，functor 通过 vtable `+0x10` 调用）和 `std::array<render::Texture,3>`（按值传递，隐藏指针）都是 MSVC C++ ABI。MinGW libstdc++ 的 `std::function` 布局完全不同，不能互操作。项目当前用 mingw-w64 gcc 构建原生组件（见 `aesa/AGENTS.md`），因此策略 B 要么改用 MSVC/clang-cl，要么用汇编/手工布局构造这些参数。**[证]**（enlight 侧调用模式：`mov 0x38(%r15),%rcx; mov (%rcx),%rax; call *0x10(%rax)`；`SceneRenderer` RTTI 明确是 `std::_Func_impl_no_alloc`）
5. **`Params` 语义**：0x24 以后字段未定名；不同 mode（RBM/DBS/RMAP/TPM/TA）对同一字段的解释可能不同。策略 B 要“任意机型可用”，必须把这些字段全部标定。**[待]**
6. **输出消费**：`AGRadarData` 的四个矩阵语义未定名；如果还要画符号/地形线，需要 `CScope` 和 `AGRadarData`。**[待]**

#### 优点

- 不依赖游戏是否创建雷达页面；任意机型、任意 MFD 都能驱动。
- 参数完全可控，便于做“原理级 AESA”演示。
- 不受 F-16/F-18 页面生命周期影响。

#### 缺点

- 工作量远大于 A：场景渲染回调是主要成本，不是 `Params`。
- 需要 MSVC ABI 或复杂的手工 ABI 桥。
- 需要自己管理渲染目标、渲染线程、资源生命周期。
- 画面一致性难保证（材质/水面/植被/阴影）。

### 6.3 A/B 对比

| 维度 | A：钩已有实例 | B：自构造实例 |
|---|---|---|
| 场景渲染 | 引擎完成 | 自己重造（最大难点） |
| 需要逆向的结构体 | `Params`、实例布局、`AGRadarData`、`ConfigPreset` | 上述全部 + `render::Texture` + `std::function` ABI |
| 机型覆盖 | 仅已接入 AGRadar 的页面（F-16/F-18/AH-64D/JF-17 等） | 理论任意 |
| 工作量 | 低–中 | 高 |
| 风险 | 页面生命周期、回调所有权、版本 RVA | 渲染线程、ABI、渲染目标、画面一致性 |
| 推荐度 | **高**（spike 首选） | 低（除非必须脱离游戏页面） |

### 6.4 推荐的折中路径（A′）

在 `AGRadar::update` 的 detour 里：

1. 读取/修改 `Params`（例如把 F-16 的雷达位置、速度、扫描范围替换成自己的仿真值）；
2. **原样调用原函数**（保留 `SceneRenderer` 的 `std::function` 回调），让引擎继续渲染 `src`/`srcDepth`/`shadowmap`；
3. 在 `AGRadar::draw` 的 detour 里拦截 `dst[2]`，把自己的符号/画面叠加进去，或复制出来做分析。

这条路径不需要构造任何 MSVC STL 对象，也不需要重造场景渲染，是当前代码库（MinGW 原生探针）最容易落地的方案。**[推]**

---

## 7. 证据索引

### 7.1 `enlight.dll`

| 主题 | 地址（VA） | 说明 |
|---|---|---|
| AGRadar ctor | `0x180001FE0` | 加载 radar.lua / radar.fx / 纹理槽 |
| AGRadar dtor | `0x180002B20` | — |
| applyConfigPreset | `0x180003010` | 预设名查找 + 日志 |
| applyPreset | `0x180003150` | ConfigPreset → 实例字段 |
| blurPass | `0x180003360` | P7/P8，cbuffer `params*` |
| draw | `0x180003630` | 状态机 + 6 纹理 |
| buildDBS | `0x180003540` | 置 `0x10C=1` |
| clear | `0x180003550` | 置 `0x367=1` |
| getData | `0x180004090` | 0x130 字节拷贝 |
| loadConfig | `0x180004750` | 读 radar.lua |
| parsePreset | `0x180004FD0` | Lua key → 0x70 结构 |
| renderFinal | `0x1800057C0` | P12/P13 |
| renderResult | `0x1800059E0` | P9/P10/P11 |
| renderScanned | `0x180005D40` | P0–P6，绑定 0x348/0x350/0x358 |
| update | `0x180006530` | 矩阵计算 + 回调 |
| 回调调用点 | `0x1800077F4` | `call *0x10(%rax)` |
| 回调后状态 | `0x1800077F7` | `this+0x138 = 1` |
| pass 表（source） | `0x18007A8E0` | 15 项 |
| pass 表（blur） | `0x18007A91C` | 5 项 |
| pass 表（scan） | `0x18007A930` | 5 项 |
| pass 表（final） | `0x18007A944` | 5 项 |
| 断言 | `0x18007AC28` | `shadowmapCount > 0 && <= 3` |
| 预设表 | `0x1800A0880` | `ed::vector<ConfigPreset>`，stride 0x70 |

### 7.2 `SceneRenderer.dll`

| 主题 | 地址（VA） | 说明 |
|---|---|---|
| AGRadar::update 调用 | `0x180046194` | IAT `0x18004F818` |
| Params 构造 | `0x180046095-0x180046181` | 从 `DCSMFDDesc::RadarParams` 拷贝 |
| 回调 functor vtable | `0x180052840` | `+0x10` → `0x180045E80` |
| 回调 thunk | `0x180045E80` | `jmp 0x180044450` |
| 回调体 | `0x180044450` | 逐级联 `SceneRenderContext` |
| 回调内渲染 | `0x180014FA0` | 每级联场景渲染 |
| 回调内收尾 | `0x180046220` | 传入 functor 捕获的上下文 |
| RadarShadowmap 创建 | `0x180046F61` | 字符串 xref |
| RadarOrthoDepth 创建 | `0x180046F93` | 字符串 xref |
| RadarOrtho 创建 | `0x180046FC8` | 字符串 xref |
| RadarMainPass 调度 | `0x1800461E9` | 字符串 xref |
| RadarOrthoPass 调度 | `0x180044B50` | 字符串 xref |
| AGRadar::draw 调用 | `0x18004578A` | IAT `0x18004F810` |
| CScope::buildLines 调用 | `0x180044E17` | IAT `0x18004F7F8` |
| CScope::getData 调用 | `0x180044DBA` | IAT `0x18004F808` |

### 7.3 着色器/配置

| 文件:行 | 内容 |
|---|---|
| `Bazar/shaders/enlight/radar.fx:10-12` | `src` / `srcDepth` / `shadowmap` 声明 |
| `radar.fx:14-37` | `cbUniforms` 布局 |
| `radar.fx:82-88` | 高度补偿 |
| `radar.fx:90-176` | 径向模糊 / DBS 多普勒模糊 |
| `radar.fx:182-187` | 级联阴影采样 |
| `radar.fx:189-273` | PS_SOURCE（RBM/RMAP/TPM/TA） |
| `radar.fx:275-281` | PS_BLUR_RADIAL / PS_BLUR_RADIAL_DBS |
| `radar.fx:295-307` | PS_FINAL |
| `radar.fx:315-346` | PS_SCAN |
| `radar.fx:348-370` | PS_SCAN_RMAP |
| `radar.fx:391-475` | technique `Radar` P0–P14 |
| `Bazar/shaders/enlight/radarFunc.hlsl:4-12` | `uipo` 反射系数表 |
| `radarFunc.hlsl:22-41` | 雷达方程 |
| `Bazar/shaders/model/functions/radar.hlsl:34-43` | `radar_ps` 写反射率到 R |
| `Bazar/shaders/model/def_material.fx:13,164-186` | `radar` technique |
| `Bazar/shaders/model/deck_material.fx:25,111-127` | `radar` technique |
| `Bazar/shaders/model/glass_material.fx:13,129…` | `radar` technique |
| `Bazar/shaders/enlight/cscope.fx:5-21` | CScope 输入/cbuffer |
| `cscope.fx:37-58` | 深度→世界坐标 + 阴影 |
| `cscope.fx:68-89` | 方位扫描 compute |
| `Config/Effects/radar.lua:1-124` | 全部预设 |
| `Config/Effects/radar.lua:12-41` | EXP1/EXP2/EXP3 |
| `Config/Effects/radar.lua:62-91` | EXP_F16 / DBS1_F16 / DBS2_F16 |

---

## 8. 未决问题与后续验证清单

1. **`Params+0x24` 的语义**：同一字段既用于 `ceil(x/140)` 级联数（`0x7074`），又用于 `tan(0.5*(x/级联+blurAngle))` 投影（`0x72A4`），二者单位冲突。需要动态 dump F-16 GM/DBS 页面各模式下的值，结合雷达页面 range 设置确认。**[待]**
2. **`Params+0x28..0x4C`**：9 个 float 的模式相关含义；建议在 `AGRadar::update` detour 里按 mode 打印，并与 F-16 雷达页面的 range/azimuth/elevation/bar 设置对照。**[待]**
3. **`AGRadarData` 四个矩阵**：建议在 `getData` 返回后与 `update` 回调参数逐元素比较，确定 view/proj/shadow 的对应关系。**[待]**
4. **`draw` 的 `dst[1]` 语义**：state 2/3 的 ping-pong 次序需要动态截帧确认。**[待]**
5. **F-16 页面到 `applyConfigPreset` 的精确调用链**：需要在 F-16 的 avionics DLL 或 `CockpitBase`/`SceneRenderer` 里定位 `GM_F16`/`DBS1_F16`/`DBS2_F16` 字符串的实际传递路径；目前只有 radar.lua 的命名证据。**[待]**
6. **策略 A′ 的最小验证**：在 `AGRadar::update` 入口打印 `Params` 前 0x6C 字节、mode、级联数；在 `draw` 入口打印 6 个 `Texture` 的指针/尺寸；确认 F-16 雷达页面重复进入/退出时实例是否复用。**[待]**
7. **MinGW ↔ MSVC 边界**：策略 A 的纯转发 detour 可行；任何需要构造 `std::function`/`std::array<render::Texture,3>` 的路径都需要 MSVC 工具链或手工 ABI。建议 spike 阶段只做“读 + 改 Params + 转发”，不构造 STL 对象。**[推]**

# AGR 原生探针 Phase 1：CPU 地表掩码查询

- 状态：external-reference（2026-10-18 复核）

核查日期：2026-10-17
目标版本：DCS 2.9.30.28738
前置 spike：`docs/research/edterrain4-landscape-map.md`

本文记录 Phase 1 的实现决定与验证结果。范围仅限“把引擎的 64 位地表类型掩码暴露给 Lua”；不装钩、不写游戏状态、不改 DCS 安装目录。

---

## 1. 交付物

| 文件 | 作用 |
|---|---|
| `src/native/agradar_probe/aesa_agradar.c` | 原生探针 DLL 源码 |
| `src/hooks/aesa_agradar_hook.lua` | Hooks 侧加载/轮询骨架 |
| `scripts/build_agradar_probe.cjs` | 构建 `dist/dev/aesa_agradar.dll` 并做导出/依赖守卫 |
| `scripts/install_agradar_probe.cjs` | Saved Games 部署：manifest、备份、Lua 语法检查、DCS 进程检查 |
| `tests/test_agradar_probe_dll.py` | 无 DCS/无引擎的 ctypes 冒烟测试 + 可选符号解析测试 |
| `docs/research/agradar-probe-phase1.md` | 本文 |

未使用 MinHook，未编译 `src/native/third_party/minhook/`；Phase 1 不需要装钩。

---

## 2. ABI 决定（关键）

### 2.1 成员函数：this 在 RCX，sret 在 RDX

`ITerrainImpl4::getPointOnSurface` 是成员函数，按值返回 `PointOnSurface`。MSVC x64 的实际寄存器顺序是：

```text
RCX = this
RDX = 隐藏的返回缓冲区（sret）
R8  = osg::Vec3d const*（世界坐标）
R9  = PointOnSurface::InternalCache*（本实现传 NULL）
```

**这与父任务说明里的“sret 在 RCX、this 在 RDX”相反。** 本次以反汇编和 MinGW C 探针为准：

- `edterrain4.dll` 的 `getPointOnSurface` 实现 RVA `0x255a0` 前几条指令把 `RDX` 当作可写结构（`mov dword [rdx+0x44], -1`、`mov [rdx+8], rax`），把 `RCX` 保存为 `this`。
- 用 `CreateTerraDispatch()` + `CreateITerrainStub()` 取得 stub，MinGW C 调用 `fn(stub, out, &pt, NULL)`，`out+0x38` 得到全 1 哨兵；调用 `fn(out, stub, &pt, NULL)` 不会写入该位置。
- 全 1 哨兵与 spike 的 Python ctypes 结果一致。

因此实现使用：

```c
typedef void *(__cdecl *get_point_on_surface_fn)(
    void *self, void *out, const agr_vec3d *pt, void *cache);
```

**不要**按“sret 在 RCX”的写法调用；那会把 terrain 对象当成返回缓冲区写入，后果不可控。

### 2.2 自由函数：getSurfaceTypesName 的 sret

`edterrain::getSurfaceTypesName(uint64)` 是**自由函数**，返回 `ed::basic_string<char>`（32 字节、非平凡）。它的 ABI 是：

```text
RCX = sret 缓冲区
RDX = uint64 掩码
RAX = 返回的缓冲区指针（可忽略）
```

MinGW C 实测 `f(sbuf, 0x1F05)` 返回 `"Land, Runway, Road, Railway, Town, Field, Beach"`，`sbuf+16` 是长度 47，`sbuf+0` 是堆指针。该调用只在 init 验证时做一次；**不释放返回的字符串**，原因见 §2.4。

### 2.3 8 KB sret 缓冲与 +0x38

`PointOnSurface` 的完整布局没有头文件/PDB。已确认：

- `+0x38` 是 8 字节字段；
- `getPointOnSurface` 在无地形时会把它初始化为 `0xFFFFFFFFFFFFFFFF`（全 1 哨兵）；
- Lua 的 `Terrain.GetSurfaceType` 正是读取该偏移的 8 字节；
- `Surface5File::verticalIntersection` 输出 64 位掩码。

实现为每次查询分配 8 KB、16 字节对齐的栈缓冲并清零，调用后只读 `+0x38` 的 8 字节。除 `+0x38` 外的字段偏移未使用。

### 2.4 为什么每查询不用 getSurfaceTypesName

`getSurfaceTypesName` 返回的 `ed::basic_string` 由引擎的 MSVC CRT 分配，**没有导出的析构函数**；本 DLL 用 MinGW/msvcrt，不能用 `free()`/`delete` 安全释放。每帧/每点调用会泄漏。

因此：

- init 时调用一次 `getSurfaceTypesName(0x1F05)` 做权威 plural 样本，日志记录；
- 同时用 `getSurfaceTypeName(1<<bit)` 逐位校验 16 个类名；
- **每查询**用 C 源码里写死的 16 项表解码（与引擎逐位校验 16/16 match），不分配、不泄漏。

### 2.5 惰性自初始化（集成裂缝修复）

Export 是独立 Lua 状态，可能只 `package.loadlib(dll, "aesa_agradar_surface_names")` 就调用，既不经过 `luaopen_*`，也不保证 Hooks 侧 hook 先跑过 `init`。因此：

- `surface_names` / `surface_mask` 在进入查询前，于 `g_engine_lock` 内调用 `lazy_resolve_locked()`；
- 若查询所需的两个符号已齐，直接查询；若未齐，重试 `GetModuleHandleA` + `GetProcAddress`；
- 失败返回 nil；有日志时只写一次 `lazy resolve failed: N/4`；成功只写一次 `lazy resolve: N/4`；
- 4/4 且日志已打开时，顺带做 16 类校验；
- 幂等：已解析后每次调用只做一次指针检查，不重复写日志；
- 线程安全：惰性解析与查询共用 `g_engine_lock`；`init`/`poll` 的解析路径可能并发，但只写相同的进程级地址，最坏是重复解析一次，不会破坏查询。

`init(log_dir)` 的空参数语义同时改为：nil/空串 → 不打开日志、不回退默认目录，但仍解析符号并返回计数；显式 `init(real_dir)` 行为不变。这样“只部署 Export 侧、hook 未生效”也能查询；显式 init 仍用于拿日志与校验。

---

## 3. 符号解析结果

必需符号 4 个：

| 模块 | mangled 符号 | 用途 | 本机结果 |
|---|---|---|---|
| `Inter.dll` | `?GetDefaultTerrain@ITerrain@edterrain@@SAPEAV12@XZ` | 取当前 `edterrain::ITerrain*` | resolved |
| `Inter.dll` | `?getSurfaceTypesName@edterrain@@YA?AV?$basic_string@D@ed@@_K@Z` | 一次性 plural 验证 | resolved |
| `Inter.dll` | `?getSurfaceTypeName@edterrain@@YAPEBD_K@Z` | 逐位校验 16 类 | resolved |
| `edterrain4.dll` | `?getPointOnSurface@ITerrainImpl4@@UEBA?AUPointOnSurface@edterrain@@AEBVVec3d@osg@@PEAUInternalCache@23@@Z` | 表面查询 | resolved |

本机日志实测：

```text
module Inter.dll: E:\SteamLibrary\...\bin\Inter.dll version 2.9.30.28738
module edterrain4.dll: E:\SteamLibrary\...\bin\edterrain4.dll version 2.9.30.28738
module edCore.dll: E:\SteamLibrary\...\bin\edCore.dll version 2.9.30.28738
module lua.dll: ... (no version info)
sym ?GetDefaultTerrain@... resolved
sym ?getSurfaceTypesName@... resolved
sym ?getSurfaceTypeName@... resolved
sym ?getPointOnSurface@... resolved
init complete: 4/4 symbols resolved
```

未加载引擎模块时（Python 独立进程、无 `Inter.dll`）：

```text
sym ... MISSING
init complete: 0/4 symbols resolved
```

`poll` 对缺失符号做迟解析；新解析的符号写 `late-resolved`，全部到齐写 `all symbols resolved`。

---

## 4. 掩码与 16 类

`PointOnSurface +0x38` 的 64 位掩码按 bit 升序解码。C 源码中的表：

| bit | 掩码 | 类名 |
|---:|---:|---|
| 0 | `0x000001` | `Land` |
| 2 | `0x000004` | `Runway` |
| 4 | `0x000010` | `Sea` |
| 5 | `0x000020` | `River` |
| 6 | `0x000040` | `Lake` |
| 8 | `0x000100` | `Road` |
| 9 | `0x000200` | `Railway` |
| 10 | `0x000400` | `Town` |
| 11 | `0x000800` | `Field` |
| 12 | `0x001000` | `Beach` |
| 16 | `0x010000` | `Building` |
| 17 | `0x020000` | `Construction` |
| 20 | `0x100000` | `Trees` |
| 21 | `0x200000` | `Forest` |
| 22 | `0x400000` | `Traffic` |
| 23 | `0x800000` | `ParticleEffect` |

未命名 bit：1、3、7、13–15、18–19、24–63。它们不会被输出。

输出格式（`surface_names`）：

- 逗号分隔、**无空格**、按 bit 升序；
- 例：掩码 `0x101` → `"Land,Road"`；
- 掩码 0 或仅含未命名 bit → 空字符串 `""`；
- 全 1 哨兵 → `nil`；
- 引擎/地形不可用或坐标无效 → `nil`。

`surface_mask` 把 64 位掩码装进 Lua double 返回；只使用 bit 0–23，远在 IEEE-754 53 位尾数精度内。

init 时逐位校验日志：

```text
engine surface-name validation:
  bit  0 (0x000001) engine=Land table=Land
  ...
engine surface-name validation: 16/16 match
engine plural 0x1f05 -> Land, Runway, Road, Railway, Town, Field, Beach
```

---

## 5. DLL 导出契约

Lua C 约定 `int(lua_State*)`，不链接 `lua.dll`。每次导出调用都重新 `bind_lua()`，从已加载的 `lua.dll` 解析 `lua_tolstring/lua_pushstring/lua_pushnumber/lua_pushinteger/lua_pushnil/lua_gettop/lua_isnumber/lua_tonumber`；**不缓存任何 lua_State**。

| 导出 | Lua 结果 |
|---|---|
| `aesa_agradar_init(log_dir)` | 整数：已解析符号数（0–4） |
| `aesa_agradar_poll()` | 整数：当前已解析符号数；首次帧写 `poll alive`，每 3600 帧写心跳 |
| `aesa_agradar_shutdown()` | 整数 1；关闭日志 |
| `aesa_agradar_version()` | 字符串：`aesa_agradar 0.1.0 (phase1 surface mask)` |
| `aesa_agradar_surface_names(x,z)` | 字符串或 nil |
| `aesa_agradar_surface_mask(x,z)` | number 或 nil |

坐标：DCS 世界坐标 `(x, y, z)`，内部固定 `y = 1.0`，与 Lua `Terrain.GetSurfaceType` 一致。`|x|,|z| > 1e9`、NaN、Inf 视为无效。

`init(log_dir)` 的 `log_dir` 为 nil/空串时：**不打开日志，也不回退默认目录**，但仍完成符号解析并返回已解析数；之后带真实目录的 `init` 仍会正常打开日志。

`surface_names` / `surface_mask` **不要求先 init**：符号未解析时，在 `g_engine_lock` 内惰性重试 `GetModuleHandleA` + `GetProcAddress`；失败返回 nil，有日志时只写一次 `lazy resolve failed`；成功时只写一次 `lazy resolve`，4/4 时再做名称校验。幂等，重复调用不会刷日志。

同一 DLL 可被 Hooks 与 Export 两个 Lua 状态分别 `package.loadlib`；DLL 不保存 L。进入 `GetDefaultTerrain`/`getPointOnSurface` 的临界段由 `CRITICAL_SECTION` 保护；日志有独立锁与惰性解析共用同一把引擎锁。

---

## 6. 降级路径

任何一步失败都返回 `nil`/0 并写日志，不主动崩溃宿主：

| 条件 | 行为 |
|---|---|
| `lua.dll` 未加载 / Lua API 缺失 | `bind_lua()` 失败；DLL 不崩溃，但无法向 Lua 栈 push 结果。DCS 的 Hooks/Export 环境始终已加载 `lua.dll`；此路径主要出现在独立 ctypes 测试中 |
| `init(nil/"")` | 不打开日志、不回退默认目录；仍解析符号并返回计数；后续显式 `init(real_dir)` 照常开日志 |
| `surface_*` 在 init 前调用 / 符号未解析 | 在引擎锁内惰性重试解析；失败返回 nil；有日志时只写一次 `lazy resolve failed` |
| `Inter.dll` / `edterrain4.dll` 未加载 | 符号 MISSING；`poll` 迟解析；`surface_*` 返回 nil（并尝试惰性解析） |
| `GetDefaultTerrain()` 返回 NULL | `surface query: terrain null/unreadable`（一次）；返回 nil |
| terrain 对象指针/虚表不可读 | `VirtualQuery` 守卫拒绝；写一次日志；返回 nil |
| `vtable[19]` 为空或不可执行 | 拒绝调用；写一次日志；返回 nil |
| `vtable[19]` 不等于 GetProcAddress 地址 | 检查它属于 `edterrain4.dll`；属于则走 vtable 并写一次日志；不属于则拒绝 |
| 返回掩码全 1 | `surface query: all-ones sentinel (terrain not ready)`；返回 nil |
| `getSurfaceTypesName` 字符串布局不可读 | 只影响一次性验证日志；不参与每查询解码 |
| 日志未打开（init 空/nil 或打开失败） | `g_log` 为空，`log_line` no-op；符号解析/查询仍可工作；之后显式 init 可再打开 |
| 坐标不是 number / NaN / Inf / 超范围 | 直接返回 nil，不进入引擎 |

不使用 `__try/__except`（MinGW x64 SEH 支持不确定）；所有指针在解引用前用 `VirtualQuery` 检查。**注意**：这不能防止 `getPointOnSurface` 内部访问坏指针；真实地形上的第一次调用仍是风险点，必须由用户实机验证。

---

## 7. 构建与部署

### 7.1 构建

```bash
cd <repo>
node scripts/build_agradar_probe.cjs
```

实测结果：

- 输出 `dist/dev/aesa_agradar.dll`（约 78 KB）；
- 导出 6 个：`aesa_agradar_init/poll/shutdown/version/surface_names/surface_mask`；
- 依赖仅 `KERNEL32.dll`、`msvcrt.dll`、`VERSION.dll`；
- `-O2 -Wall -Wextra` 无警告。

### 7.2 部署

```bash
node scripts/install_agradar_probe.cjs install \
  --saved-games "%USERPROFILE%\Saved Games\DCS" \
  --lua "<DCS>\bin\luae.exe"
```

部署路径：

- `Scripts/Hooks/aesa_agradar_hook.lua`
- `Scripts/AESA-AGR/aesa_agradar.dll`
- `Scripts/AESA-AGR/agr-manifest.json`

manifest：`product: "aesa-agradar-probe"`、`schema: 1`、`hook_hash`/`dll_hash` 为 sha256。

规则：

- 写入顺序 DLL → hook → manifest；
- 已有文件先备份，后缀 **`.bak-aesa-agr`**（不抄 FC 的 `.bak-aesa-sar`）；
- 已存在且不属于本 manifest 的文件拒绝覆盖/删除；
- `DCS.exe` 正在运行则拒绝 install/repair/uninstall（避免 DLL 被锁）；
- install/repair 前用 Lua 5.1 对 hook 做 `loadfile` 语法检查；
- 子命令：`install|repair|uninstall|verify|status`；
- `uninstall` 只删除清单内文件，保留 `.bak-aesa-agr` 备份。

---

## 8. 验证结果

### 8.1 构建/守卫

- `node scripts/build_agradar_probe.cjs` 成功。
- `objdump -p` 确认 6 个导出与 3 个允许依赖。

### 8.2 健壮性测试

`python tests/test_agradar_probe_dll.py`：

```text
agradar_probe DLL smoke test OK
```

本次运行：测试脚本 1/1 通过；ctypes 基础检查 + 3 个 Lua 状态场景全部通过。

覆盖：

- ctypes 无 Lua 状态：6 个导出存在；`init(None)`/`surface_names(None)`/`surface_mask(None)`/`poll(None)`/`shutdown(None)` 不崩溃、返回正确结果数；`init(None)` **不创建默认日志**。
- Lua 状态 Case 1（`luae.exe`，引擎未加载、未 init）：直接 `surface_names(40000,40000)` / `surface_mask(...)` 返回 nil，不崩溃、不创建日志。
- Lua 状态 Case 2：`init("")` 不建日志；随后 `init(real_log_dir)` 正常打开日志；再次 `surface_*` 返回 nil，日志出现一次 `init complete: 0/4` 和**恰好一次** `lazy resolve failed`。
- 可选 Phase C（本机有 DCS）：加载 `Inter.dll`/`edterrain4.dll`，用真实 `lua_State` 显式 `init(real_log_dir)`，`init` 返回 4/4，日志出现 `16/16 match`；随后 `surface_names` 在无地形时返回 nil，不崩溃。

### 8.3 Lua 状态 + stub 地形

手工验证（未写入仓库测试）：用 DCS `lua.dll` 创建真实 `lua_State`，加载 `Inter.dll`/`edterrain4.dll`，`CreateTerraDispatch()` + `CreateITerrainStub()`，`SetDefaultTerrain(stub)`，显式传一个临时 log dir 给 `init`，再调用本 DLL：

```text
init result count 1 value 4.0 type 3
mask result count 1 type 0 value 0.0
names result count 1 type 0
poll result count 1 value 4.0 type 3
shutdown result count 1 value 1.0 type 3
```

日志：

```text
surface query: all-ones sentinel (terrain not ready)
```

说明：完整调用了 `GetDefaultTerrain` → `vtable[19]` → `getPointOnSurface`，stub 返回全 1，DLL 正确降级为 nil，没有崩溃。

### 8.4 部署脚本

在临时 Saved Games 目录实测：

- `install` 成功，manifest/路径正确；
- `verify`、`status`、`repair` 成功；
- `repair` 生成 `.bak-aesa-agr` 备份；
- `uninstall` 删除清单文件、保留备份；
- Lua 5.1 语法检查通过（DCS `luae.exe`）。

### 8.5 既有 Node 测试

`node --test tests/*.cjs`（Node 25 不接受裸目录 `node --test tests`）：

```text
tests 199
pass 192
fail 0
skipped 7
```

说明：第一次跑这套测试时有 3 个失败，均在 `tests/test_sar_map.cjs`（服务端并行工作流正在修改的文件，本次未触碰）；并行代理随后修复后，最终复跑 192/192 通过。本次新增的 Python 测试通过；未修改任何既有测试。

---

## 9. 用户实机验证步骤

1. **关闭 DCS**（部署脚本会检查 `DCS.exe` 进程；运行中会拒绝写 DLL）。
2. 构建并部署：

   ```bash
   cd <repo>
   node scripts/build_agradar_probe.cjs
   node scripts/install_agradar_probe.cjs install \
     --saved-games "%USERPROFILE%\Saved Games\DCS" \
     --lua "<DCS>\bin\luae.exe"
   ```

3. 启动 DCS，进入一张地图的任务（Caucasus 即可），进入座舱/开始模拟。
4. 查看 `Saved Games\DCS\Logs\AESA\AGR\agradar_native.log`，应看到：

   ```text
   aesa_agradar probe init (phase 1: CPU surface mask)
   module Inter.dll: ... version 2.9.30.28738
   module edterrain4.dll: ... version 2.9.30.28738
   sym ?GetDefaultTerrain@... resolved
   sym ?getSurfaceTypesName@... resolved
   sym ?getSurfaceTypeName@... resolved
   sym ?getPointOnSurface@... resolved
   init complete: 4/4 symbols resolved
   engine surface-name validation: 16/16 match
   engine plural 0x1f05 -> Land, Runway, Road, Railway, Town, Field, Beach
   poll alive (first simulation frame)
   ```

5. 让服务端/Export 侧调用 `aesa_agradar_surface_names(x,z)` 或 `aesa_agradar_surface_mask(x,z)`。第一次成功查询应出现：

   ```text
   first surface query OK: x=... z=... mask=0x........ names=Land,Road,...
   ```

   如果看到：

   ```text
   surface query: all-ones sentinel (terrain not ready)
   ```

   说明查询发生在任务/地形真正加载之前；进入任务后再查一次。

   若服务端只 `package.loadlib(surface_*)` 而没有调用 `init`，首次查询会自动惰性解析符号；但因为没有日志目录，`lazy resolve` 诊断不会落盘。建议 Export 侧仍显式 `init(Logs\AESA\AGR)`，或至少接受“静默惰性解析”。

6. 检查 `Saved Games\DCS\Logs\dcs.log`，应有 `AESA-AGR` 通道：

   ```text
   probe loaded, symbols resolved: 4
   ```

7. 对照验证：在同一 `(x,z)` 用任务 Lua `land.getSurfaceType({x=...,y=...})` 或已知地物（跑道/道路/海面）比较。`surface_names` 返回的 16 类应明显更细；`Land,Road` 等组合表示同一坐标命中多个语义面。

8. 卸载：

   ```bash
   node scripts/install_agradar_probe.cjs uninstall \
     --saved-games "%USERPROFILE%\Saved Games\DCS" \
     --lua "<DCS>\bin\luae.exe"
   ```

   备份文件 `*.bak-aesa-agr` 会保留；确认无误后手动删除。

---

## 10. 未做与后续

1. **真实地形数值验证**：本次只到 stub（全 1 哨兵）。第一次实机查询必须确认 `+0x38` 的有效掩码与已知地物一致；若不一致，优先检查 `PointOnSurface` 偏移或地形是否尚未加载。
2. **InternalCache**：当前传 NULL（与 Lua 调用一致）。若实机发现异常，下一步传一个自有零初始化缓冲；其大小/布局未知，需要实验。
3. **线程安全**：引擎调用有临界区，但 DCS 可能在地形流式加载/卸载时改内部状态；建议只在模拟帧/任务线程查询。
4. **两个 Lua 状态**：DLL 不缓存 L；Hooks 与 Export 各自 `init`/`poll` 会写同一日志。服务端在 Export 环境只 `package.loadlib(surface_*)` 也能工作：首次查询会惰性解析符号。但**建议仍显式调用 `init(real_log_dir)`**，以便拿到模块版本、`init complete` 和 16 类校验日志；`init("")`/nil 只解析符号、不写日志。
5. **版本变化**：符号名/vtable 槽位/`+0x38` 偏移是 2.9.30.28738 的；DCS 更新后先看日志的 `MISSING`/`MISMATCH`/`vtable[19]` 行。
6. **hook 与服务端的职责**：Hooks 侧 hook 只做 init/poll/shutdown，不主动查询地表；`surface_names/mask` 由服务端/Export Lua 状态通过 `package.loadlib` 调用。hook 里的 `surface_names/surface_mask` 是 local，不暴露到全局。
7. **Lua 路径的额外副作用调用**：`lua-terrain.dll` 的 `Terrain.GetSurfaceType` 在调用 `vtable+0x98` 之前，还对 `GetDefaultTerrain()` 的第二个返回值调用了 `vtable+0xf8`（`edx=1`）。本 DLL 没有复制这个调用：`0xf8` 在 `ITerrainImpl4` vtable 中落在 31–34 的 ICF 占位槽，语义不明，贸然调用风险更大。若实机第一次查询返回全 1/ nil 而 Lua 同类查询正常，优先复查这个副作用（例如它可能是纹理/上下文开关）。

/*
 * aesa_agradar.c — AESA AGR native probe, phase 1.
 *
 * Purpose: expose the terrain engine's 64-bit surface-type mask to Lua over a
 * dependency-free DLL loaded with package.loadlib from Saved Games. The probe
 * only reads engine state: GetDefaultTerrain() + ITerrainImpl4::getPointOnSurface
 * plus the Inter.dll name decoders. No hooks, no writes to the simulation.
 *
 * ABI note (verified on this build):
 *   ITerrainImpl4::getPointOnSurface returns PointOnSurface by value, so for a
 *   member function MSVC x64 passes this in RCX, the hidden return buffer in
 *   RDX, osg::Vec3d const* in R8 and InternalCache* in R9. This is the opposite
 *   of the "sret in RCX, this in RDX" note in some fire-control experiments
 *   (that pattern applies to free functions, not to this member function).
 *   A MinGW x64 test against CreateITerrainStub() reproduced the all-ones
 *   sentinel at out+0x38 with call(self, out, &pt, NULL).
 *
 *   The free function edterrain::getSurfaceTypesName(uint64) returns
 *   ed::basic_string<char> by value: sret buffer in RCX, mask in RDX. It is
 *   called once during validation, not on the per-query hot path, because its
 *   returned string has no exported destructor and must not be freed with the
 *   MinGW CRT.
 *
 * The exported entry points are lua_CFunction-compatible but do not link
 * lua.dll; the handful of Lua API functions are resolved from the already
 * loaded lua.dll on every call. No lua_State is cached: the same DLL can be
 * loaded by the Hooks and Export Lua states independently.
 */
#define _WIN32_WINNT 0x0600
#include <windows.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <stdarg.h>

#define AGR_EXPORT __declspec(dllexport) int __cdecl
#define AGR_SYM_COUNT ((int)(sizeof(g_syms) / sizeof(g_syms[0])))

typedef struct lua_State lua_State;
typedef const char *(__cdecl *lua_tolstring_fn)(lua_State *, int, size_t *);
typedef void (__cdecl *lua_pushstring_fn)(lua_State *, const char *);
typedef void (__cdecl *lua_pushnumber_fn)(lua_State *, double);
typedef void (__cdecl *lua_pushinteger_fn)(lua_State *, ptrdiff_t);
typedef void (__cdecl *lua_pushnil_fn)(lua_State *);
typedef int (__cdecl *lua_gettop_fn)(lua_State *);
typedef int (__cdecl *lua_isnumber_fn)(lua_State *, int);
typedef double (__cdecl *lua_tonumber_fn)(lua_State *, int);

static lua_tolstring_fn p_lua_tolstring;
static lua_pushstring_fn p_lua_pushstring;
static lua_pushnumber_fn p_lua_pushnumber;
static lua_pushinteger_fn p_lua_pushinteger;
static lua_pushnil_fn p_lua_pushnil;
static lua_gettop_fn p_lua_gettop;
static lua_isnumber_fn p_lua_isnumber;
static lua_tonumber_fn p_lua_tonumber;

typedef struct {
    double x, y, z;
} agr_vec3d;

/* Engine symbols. Exact mangled names are from the 2.9.30.28738 export tables;
   the probe logs the actual module versions instead of hard-failing on a
   different build. */
struct sym_spec {
    const char *module;
    const char *symbol;
    FARPROC addr;
    int late_logged;
};

enum {
    SYM_TERRAIN = 0,
    SYM_SURFACE_TYPES_NAME,
    SYM_SURFACE_TYPE_NAME,
    SYM_POINT_ON_SURFACE
};

static struct sym_spec g_syms[] = {
    { "Inter.dll",
      "?GetDefaultTerrain@ITerrain@edterrain@@SAPEAV12@XZ", NULL, 0 },
    { "Inter.dll",
      "?getSurfaceTypesName@edterrain@@YA?AV?$basic_string@D@ed@@_K@Z", NULL, 0 },
    { "Inter.dll",
      "?getSurfaceTypeName@edterrain@@YAPEBD_K@Z", NULL, 0 },
    { "edterrain4.dll",
      "?getPointOnSurface@ITerrainImpl4@@UEBA?AUPointOnSurface@edterrain@@"
      "AEBVVec3d@osg@@PEAUInternalCache@23@@Z", NULL, 0 },
};

typedef void *(__cdecl *get_default_terrain_fn)(void);
typedef const char *(__cdecl *get_surface_type_name_fn)(uint64_t);
typedef void *(__cdecl *get_surface_types_name_fn)(void *out, uint64_t mask);
typedef void *(__cdecl *get_point_on_surface_fn)(void *self, void *out,
                                                 const agr_vec3d *pt,
                                                 void *cache);

static get_default_terrain_fn p_get_default_terrain;
static get_surface_type_name_fn p_get_surface_type_name;
static get_surface_types_name_fn p_get_surface_types_name;
static get_point_on_surface_fn p_get_point_on_surface;

/* 16 named types, bit ascending. This is the table enumerated from
   Inter.dll!getSurfaceTypeName in the spike; init re-checks it against the
   engine decoder and logs any mismatch. */
struct surface_name {
    unsigned bit;
    const char *name;
};

static const struct surface_name g_surface_names[] = {
    { 0, "Land" },
    { 2, "Runway" },
    { 4, "Sea" },
    { 5, "River" },
    { 6, "Lake" },
    { 8, "Road" },
    { 9, "Railway" },
    { 10, "Town" },
    { 11, "Field" },
    { 12, "Beach" },
    { 16, "Building" },
    { 17, "Construction" },
    { 20, "Trees" },
    { 21, "Forest" },
    { 22, "Traffic" },
    { 23, "ParticleEffect" },
};

#define AGR_SURFACE_COUNT ((int)(sizeof(g_surface_names) / sizeof(g_surface_names[0])))
#define AGR_ALL_ONES (~(uint64_t)0)

static FILE *g_log;
static char g_log_dir[MAX_PATH];
static CRITICAL_SECTION g_engine_lock;
static CRITICAL_SECTION g_log_lock;
static INIT_ONCE g_once = INIT_ONCE_STATIC_INIT;
static volatile LONG g_poll_count;
static volatile LONG g_first_query_logged;
static volatile LONG g_validated;
static int g_resolved_count;
static int g_all_resolved_logged;
static int g_logged_null_terrain;
static int g_logged_bad_vtable;
static int g_logged_bad_fn;
static int g_logged_bad_vtable_fn;
static int g_logged_sentinel;
static int g_lazy_fail_logged;
static int g_lazy_success_logged;

static void validate_engine_names(void);

static BOOL CALLBACK agr_init_once(PINIT_ONCE once, PVOID param, PVOID *ctx)
{
    (void)once;
    (void)param;
    (void)ctx;
    InitializeCriticalSection(&g_engine_lock);
    InitializeCriticalSection(&g_log_lock);
    return TRUE;
}

static void ensure_locks(void)
{
    InitOnceExecuteOnce(&g_once, agr_init_once, NULL, NULL);
}

/* ------------------------------------------------------------------------- */
/* Logging                                                                   */
/* ------------------------------------------------------------------------- */

static void log_open(const char *dir)
{
    char path[MAX_PATH];
    size_t n;

    /* Empty/nil log_dir means "do not open a log" (no default fallback).
       Symbol resolution still runs; log_line() is simply a no-op. */
    if (!dir || !dir[0])
        return;
    if (g_log)
        return;
    EnterCriticalSection(&g_log_lock);
    if (g_log) {
        LeaveCriticalSection(&g_log_lock);
        return;
    }

    strncpy(g_log_dir, dir, sizeof(g_log_dir) - 1);
    g_log_dir[sizeof(g_log_dir) - 1] = 0;
    n = strlen(g_log_dir);
    while (n > 0 && (g_log_dir[n - 1] == '\\' || g_log_dir[n - 1] == '/'))
        g_log_dir[--n] = 0;

    /* Create every component of the log directory. */
    {
        char *p = g_log_dir;
        if (p[0] && p[1] == ':')
            p += 2;
        for (; *p; ++p) {
            if (*p == '\\' || *p == '/') {
                char c = *p;
                *p = 0;
                if (g_log_dir[0])
                    CreateDirectoryA(g_log_dir, NULL);
                *p = c;
            }
        }
        if (g_log_dir[0])
            CreateDirectoryA(g_log_dir, NULL);
    }

    _snprintf(path, sizeof(path) - 1, "%s\\agradar_native.log", g_log_dir);
    path[sizeof(path) - 1] = 0;
    g_log = fopen(path, "ab");
    LeaveCriticalSection(&g_log_lock);
}

static void log_line(const char *fmt, ...)
{
    SYSTEMTIME st;
    va_list ap;

    if (!g_log)
        return;
    EnterCriticalSection(&g_log_lock);
    if (g_log) {
        GetLocalTime(&st);
        fprintf(g_log, "[%02d:%02d:%02d.%03d] ", st.wHour, st.wMinute,
                st.wSecond, st.wMilliseconds);
        va_start(ap, fmt);
        vfprintf(g_log, fmt, ap);
        va_end(ap);
        fputc('\n', g_log);
        fflush(g_log);
    }
    LeaveCriticalSection(&g_log_lock);
}

static void log_module_version(const char *module)
{
    HMODULE h = GetModuleHandleA(module);
    char path[MAX_PATH];
    DWORD size, dummy;
    BYTE *info;
    VS_FIXEDFILEINFO *ffi;
    UINT len;

    if (!h || !GetModuleFileNameA(h, path, sizeof(path))) {
        log_line("module %s: not loaded", module);
        return;
    }
    size = GetFileVersionInfoSizeA(path, &dummy);
    if (!size) {
        log_line("module %s: %s (no version info)", module, path);
        return;
    }
    info = (BYTE *)HeapAlloc(GetProcessHeap(), 0, size);
    if (!info)
        return;
    if (GetFileVersionInfoA(path, 0, size, info) &&
        VerQueryValueA(info, "\\", (void **)&ffi, &len)) {
        log_line("module %s: %s version %u.%u.%u.%u", module, path,
                 ffi->dwFileVersionMS >> 16, ffi->dwFileVersionMS & 0xffff,
                 ffi->dwFileVersionLS >> 16, ffi->dwFileVersionLS & 0xffff);
    } else {
        log_line("module %s: %s (version query failed)", module, path);
    }
    HeapFree(GetProcessHeap(), 0, info);
}

/* ------------------------------------------------------------------------- */
/* Lua binding                                                               */
/* ------------------------------------------------------------------------- */

/* GetProcAddress returns FARPROC; copying through memcpy avoids the
   -Wcast-function-type warnings from casting between incompatible function
   types. Function and data pointers are the same size on Windows x64. */
static void copy_proc(void *dst, FARPROC src)
{
    memcpy(dst, &src, sizeof(src));
}

/* Called on every exported function. Deliberately does not cache lua_State:
   the same DLL may be loaded by the Hooks and Export Lua states. */
static int bind_lua(void)
{
    HMODULE lua = GetModuleHandleA("lua.dll");
    if (!lua)
        return 0;
    copy_proc(&p_lua_tolstring, GetProcAddress(lua, "lua_tolstring"));
    copy_proc(&p_lua_pushstring, GetProcAddress(lua, "lua_pushstring"));
    copy_proc(&p_lua_pushnumber, GetProcAddress(lua, "lua_pushnumber"));
    copy_proc(&p_lua_pushinteger, GetProcAddress(lua, "lua_pushinteger"));
    copy_proc(&p_lua_pushnil, GetProcAddress(lua, "lua_pushnil"));
    copy_proc(&p_lua_gettop, GetProcAddress(lua, "lua_gettop"));
    copy_proc(&p_lua_isnumber, GetProcAddress(lua, "lua_isnumber"));
    copy_proc(&p_lua_tonumber, GetProcAddress(lua, "lua_tonumber"));
    return p_lua_pushstring && p_lua_pushnumber && p_lua_pushnil &&
           p_lua_gettop && p_lua_isnumber && p_lua_tonumber;
}

static const char *arg_string(lua_State *L, int idx)
{
    if (!L || !p_lua_tolstring || !p_lua_gettop || p_lua_gettop(L) < idx)
        return NULL;
    return p_lua_tolstring(L, idx, NULL);
}

static double arg_number(lua_State *L, int idx, int *ok)
{
    if (!L || !p_lua_isnumber || !p_lua_tonumber || !p_lua_gettop ||
        p_lua_gettop(L) < idx) {
        *ok = 0;
        return 0.0;
    }
    *ok = p_lua_isnumber(L, idx) != 0;
    return *ok ? p_lua_tonumber(L, idx) : 0.0;
}

static void push_string(lua_State *L, const char *s)
{
    if (L && p_lua_pushstring)
        p_lua_pushstring(L, s);
}

static void push_number(lua_State *L, double v)
{
    if (L && p_lua_pushnumber)
        p_lua_pushnumber(L, v);
}

static void push_int(lua_State *L, int v)
{
    if (L && p_lua_pushinteger)
        p_lua_pushinteger(L, (ptrdiff_t)v);
}

static void push_nil(lua_State *L)
{
    if (L && p_lua_pushnil)
        p_lua_pushnil(L);
}

/* ------------------------------------------------------------------------- */
/* Memory guards (no SEH: MinGW x64 SEH support is not reliable here)        */
/* ------------------------------------------------------------------------- */

static int readable(const void *ptr, size_t len)
{
    MEMORY_BASIC_INFORMATION mbi;
    const unsigned char *p = (const unsigned char *)ptr;
    size_t avail;

    if (!ptr || !len)
        return 0;
    if (!VirtualQuery(ptr, &mbi, sizeof(mbi)))
        return 0;
    if (mbi.State != MEM_COMMIT ||
        (mbi.Protect & (PAGE_NOACCESS | PAGE_GUARD)))
        return 0;
    avail = (size_t)((const unsigned char *)mbi.BaseAddress + mbi.RegionSize - p);
    return avail >= len;
}

static int executable(const void *ptr)
{
    MEMORY_BASIC_INFORMATION mbi;
    DWORD prot;

    if (!ptr || !VirtualQuery(ptr, &mbi, sizeof(mbi)))
        return 0;
    if (mbi.State != MEM_COMMIT ||
        (mbi.Protect & (PAGE_NOACCESS | PAGE_GUARD)))
        return 0;
    prot = mbi.Protect & 0xff;
    return prot == PAGE_EXECUTE || prot == PAGE_EXECUTE_READ ||
           prot == PAGE_EXECUTE_READWRITE || prot == PAGE_EXECUTE_WRITECOPY;
}

/* ------------------------------------------------------------------------- */
/* Symbol resolution                                                         */
/* ------------------------------------------------------------------------- */

static void refresh_fn_ptrs(void)
{
    copy_proc(&p_get_default_terrain, g_syms[SYM_TERRAIN].addr);
    copy_proc(&p_get_surface_types_name,
              g_syms[SYM_SURFACE_TYPES_NAME].addr);
    copy_proc(&p_get_surface_type_name, g_syms[SYM_SURFACE_TYPE_NAME].addr);
    copy_proc(&p_get_point_on_surface, g_syms[SYM_POINT_ON_SURFACE].addr);
}

static int resolve_all_initial(void)
{
    int i, found = 0;

    for (i = 0; i < AGR_SYM_COUNT; i++) {
        HMODULE h;
        if (!g_syms[i].addr) {
            h = GetModuleHandleA(g_syms[i].module);
            if (h)
                g_syms[i].addr = GetProcAddress(h, g_syms[i].symbol);
        }
        if (g_syms[i].addr)
            found++;
        log_line("sym %-76s %s", g_syms[i].symbol,
                 g_syms[i].addr ? "resolved" : "MISSING");
    }
    g_resolved_count = found;
    if (found == AGR_SYM_COUNT)
        g_all_resolved_logged = 1;
    refresh_fn_ptrs();
    return found;
}

static int resolve_late(void)
{
    int i, found = 0;

    for (i = 0; i < AGR_SYM_COUNT; i++) {
        if (!g_syms[i].addr) {
            HMODULE h = GetModuleHandleA(g_syms[i].module);
            if (h)
                g_syms[i].addr = GetProcAddress(h, g_syms[i].symbol);
            if (g_syms[i].addr && !g_syms[i].late_logged) {
                g_syms[i].late_logged = 1;
                log_line("sym %-76s late-resolved", g_syms[i].symbol);
            }
        }
        if (g_syms[i].addr)
            found++;
    }
    g_resolved_count = found;
    refresh_fn_ptrs();
    if (found == AGR_SYM_COUNT && !g_all_resolved_logged) {
        g_all_resolved_logged = 1;
        log_module_version("Inter.dll");
        log_module_version("edterrain4.dll");
        log_line("all symbols resolved");
    }
    return found;
}

/* Lazy self-init for callers that only did package.loadlib(surface_names/mask)
   and never ran aesa_agradar_init (e.g. the Export Lua state). Must be called
   with g_engine_lock held. It retries missing symbols on every call (cheap),
   logs at most one failure and one success, and never blocks a query that only
   needs the two query symbols. Idempotent and thread-safe with respect to
   other surface queries. */
static int lazy_resolve_locked(void)
{
    int i, found = 0;
    int can_query;

    if ((p_get_default_terrain && p_get_point_on_surface) &&
        g_resolved_count == AGR_SYM_COUNT)
        return 1;

    for (i = 0; i < AGR_SYM_COUNT; i++) {
        if (!g_syms[i].addr) {
            HMODULE h = GetModuleHandleA(g_syms[i].module);
            if (h)
                g_syms[i].addr = GetProcAddress(h, g_syms[i].symbol);
        }
        if (g_syms[i].addr)
            found++;
    }
    g_resolved_count = found;
    refresh_fn_ptrs();

    can_query = p_get_default_terrain && p_get_point_on_surface;
    if (can_query) {
        if (!g_lazy_success_logged && g_log) {
            g_lazy_success_logged = 1;
            log_line("lazy resolve: %d/%d symbols resolved", found,
                     AGR_SYM_COUNT);
        }
        if (found == AGR_SYM_COUNT && g_log) {
            if (!g_all_resolved_logged) {
                g_all_resolved_logged = 1;
                log_module_version("Inter.dll");
                log_module_version("edterrain4.dll");
                log_line("all symbols resolved (lazy)");
            }
            validate_engine_names();
        }
        return 1;
    }

    if (!g_lazy_fail_logged && g_log) {
        g_lazy_fail_logged = 1;
        log_line("lazy resolve failed: %d/%d symbols (surface query returns nil)",
                 found, AGR_SYM_COUNT);
    }
    return 0;
}

/* ------------------------------------------------------------------------- */
/* Engine surface query                                                      */
/* ------------------------------------------------------------------------- */

static void decode_mask(uint64_t mask, char *out, size_t cap)
{
    size_t used = 0;
    int i;

    if (!out || cap == 0)
        return;
    out[0] = 0;
    for (i = 0; i < AGR_SURFACE_COUNT; i++) {
        const char *name;
        size_t n;
        if (!(mask & ((uint64_t)1 << g_surface_names[i].bit)))
            continue;
        name = g_surface_names[i].name;
        if (used + 1 < cap)
            out[used++] = ',';
        n = strlen(name);
        if (used + n >= cap)
            n = cap - 1 - used;
        memcpy(out + used, name, n);
        used += n;
        out[used] = 0;
    }
}

static void maybe_log_first(double x, double z, uint64_t mask,
                            const char *names)
{
    char buf[512];
    if (InterlockedCompareExchange(&g_first_query_logged, 1, 0) != 0)
        return;
    if (!names) {
        decode_mask(mask, buf, sizeof(buf));
        names = buf;
    }
    log_line("first surface query OK: x=%.3f z=%.3f mask=0x%08lx%08lx names=%s",
             x, z, (unsigned long)(mask >> 32),
             (unsigned long)(mask & 0xffffffffu), names);
}

static int query_surface_mask(double x, double z, uint64_t *out_mask)
{
    int ok = 0;

    EnterCriticalSection(&g_engine_lock);
    if (!lazy_resolve_locked()) {
        LeaveCriticalSection(&g_engine_lock);
        return 0;
    }
    do {
        void *terrain;
        void **vt;
        FARPROC fn;
        get_point_on_surface_fn call;
        unsigned char sret[8192] __attribute__((aligned(16)));
        agr_vec3d p;
        uint64_t mask;

        terrain = p_get_default_terrain();
        if (!terrain || !readable(terrain, sizeof(void *))) {
            if (!g_logged_null_terrain) {
                g_logged_null_terrain = 1;
                log_line("surface query: terrain null/unreadable");
            }
            break;
        }

        vt = *(void ***)terrain;
        if (!vt || !readable(vt, 20 * sizeof(void *))) {
            if (!g_logged_bad_vtable) {
                g_logged_bad_vtable = 1;
                log_line("surface query: vtable null/unreadable at %p", vt);
            }
            break;
        }

        fn = (FARPROC)(void *)vt[19];
        if (!fn || !executable(fn)) {
            if (!g_logged_bad_fn) {
                g_logged_bad_fn = 1;
                log_line("surface query: vtable[19] null/not executable: %p",
                         (void *)fn);
            }
            break;
        }

        if (fn != (FARPROC)(void *)p_get_point_on_surface) {
            HMODULE owner = NULL;
            HMODULE terrain_mod = GetModuleHandleA("edterrain4.dll");
            if (!GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                                        GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                                    (LPCSTR)fn, &owner) ||
                owner != terrain_mod) {
                if (!g_logged_bad_vtable_fn) {
                    g_logged_bad_vtable_fn = 1;
                    log_line("surface query: vtable[19]=%p outside edterrain4; "
                             "refusing call",
                             (void *)fn);
                }
                break;
            }
            if (!g_logged_bad_vtable_fn) {
                g_logged_bad_vtable_fn = 1;
                log_line("surface query: vtable[19]=%p != resolved %p; "
                         "calling vtable implementation",
                         (void *)fn, (void *)p_get_point_on_surface);
            }
        }

        memset(sret, 0, sizeof(sret));
        p.x = x;
        p.y = 1.0;
        p.z = z;
        /* this in RCX, sret buffer in RDX, Vec3d* in R8, cache in R9. */
        copy_proc(&call, fn);
        call(terrain, sret, &p, NULL);

        memcpy(&mask, sret + 0x38, sizeof(mask));
        if (mask == AGR_ALL_ONES) {
            if (!g_logged_sentinel) {
                g_logged_sentinel = 1;
                log_line("surface query: all-ones sentinel (terrain not ready)");
            }
            break;
        }
        *out_mask = mask;
        ok = 1;
    } while (0);
    LeaveCriticalSection(&g_engine_lock);
    return ok;
}

/* One-time validation: compare the hardcoded 16-class table against the
   engine's own singular decoder and log one plural sample. The plural result
   is intentionally not freed: ed::basic_string has no exported destructor and
   was allocated by the engine's MSVC CRT, so freeing it from this MinGW DLL
   would corrupt the heap. It is one allocation per process, not per query. */
static void validate_engine_names(void)
{
    int i, mismatches = 0;

    /* Do not consume the one-shot validation while logging is disabled; a
       later init with a real log_dir must still be able to write it. */
    if (!g_log)
        return;
    if (InterlockedCompareExchange(&g_validated, 1, 0) != 0)
        return;
    log_line("engine surface-name validation:");

    if (p_get_surface_type_name) {
        for (i = 0; i < AGR_SURFACE_COUNT; i++) {
            const char *n =
                p_get_surface_type_name((uint64_t)1 << g_surface_names[i].bit);
            int match =
                n && strcmp(n, g_surface_names[i].name) == 0;
            if (!match)
                mismatches++;
            log_line("  bit %2u (0x%06lx) engine=%s table=%s%s",
                     g_surface_names[i].bit,
                     (unsigned long)((uint64_t)1 << g_surface_names[i].bit),
                     n ? n : "(null)", g_surface_names[i].name,
                     match ? "" : "  [MISMATCH]");
        }
        log_line("engine surface-name validation: %d/%d match",
                 AGR_SURFACE_COUNT - mismatches, AGR_SURFACE_COUNT);
    } else {
        log_line("engine surface-name validation: singular decoder missing");
    }

    if (p_get_surface_types_name) {
        unsigned char sbuf[64];
        uint64_t len = 0;
        const char *s = NULL;

        memset(sbuf, 0, sizeof(sbuf));
        p_get_surface_types_name(sbuf, (uint64_t)0x1f05);
        memcpy(&len, sbuf + 16, sizeof(len));
        if (len <= 15) {
            s = (const char *)sbuf;
        } else if (len < 512) {
            const void *ptr;
            memcpy(&ptr, sbuf, sizeof(ptr));
            if (readable(ptr, (size_t)len + 1))
                s = (const char *)ptr;
        }
        if (s)
            log_line("engine plural 0x1f05 -> %.*s", (int)len, s);
        else
            log_line("engine plural 0x1f05 -> <unreadable basic_string>");
    }
}

/* ------------------------------------------------------------------------- */
/* Exported Lua entry points                                                 */
/* ------------------------------------------------------------------------- */

AGR_EXPORT aesa_agradar_init(lua_State *L)
{
    const char *dir;
    int found;

    ensure_locks();
    bind_lua();
    dir = arg_string(L, 1);
    log_open(dir);

    log_line("aesa_agradar probe init (phase 1: CPU surface mask)");
    log_module_version("DCS.exe");
    log_module_version("Inter.dll");
    log_module_version("edterrain4.dll");
    log_module_version("edCore.dll");
    log_module_version("lua.dll");

    found = resolve_all_initial();
    log_line("init complete: %d/%d symbols resolved", found, AGR_SYM_COUNT);
    if (found == AGR_SYM_COUNT)
        validate_engine_names();

    push_int(L, found);
    return 1;
}

/* Read-only profile check used by the one-file compatibility probe.
   Returns 1 only when the live terrain vtable slot 19 is exactly the
   resolved getPointOnSurface export; 0 means a real mismatch; -1 means the
   engine/terrain is not ready yet (symbols or terrain instance unavailable),
   which the hook treats as "retry later", not as a profile failure.
   It never calls the slot and never writes engine state. */
AGR_EXPORT aesa_agradar_profile_check(lua_State *L)
{
    int ok = -1;

    ensure_locks();
    bind_lua();
    EnterCriticalSection(&g_engine_lock);
    if (lazy_resolve_locked()) {
        void *terrain = p_get_default_terrain();
        if (terrain && readable(terrain, sizeof(void *))) {
            void **vt = *(void ***)terrain;
            if (vt && readable(vt, 20 * sizeof(void *))) {
                FARPROC fn = (FARPROC)(void *)vt[19];
                ok = (fn == (FARPROC)(void *)p_get_point_on_surface) ? 1 : 0;
            }
        }
    }
    LeaveCriticalSection(&g_engine_lock);
    push_int(L, ok);
    return 1;
}

AGR_EXPORT aesa_agradar_poll(lua_State *L)
{
    LONG n;
    int found;

    ensure_locks();
    bind_lua();
    n = InterlockedIncrement(&g_poll_count);
    found = resolve_late();

    if (n == 1)
        log_line("poll alive (first simulation frame)");
    else if (n % 3600 == 0)
        log_line("poll heartbeat: %ld frames", (long)n);

    if (found == AGR_SYM_COUNT)
        validate_engine_names();
    push_int(L, found);
    return 1;
}

AGR_EXPORT aesa_agradar_shutdown(lua_State *L)
{
    ensure_locks();
    bind_lua();
    log_line("shutdown after %ld polls", (long)g_poll_count);
    EnterCriticalSection(&g_log_lock);
    if (g_log) {
        fclose(g_log);
        g_log = NULL;
    }
    LeaveCriticalSection(&g_log_lock);
    push_int(L, 1);
    return 1;
}

AGR_EXPORT aesa_agradar_version(lua_State *L)
{
    ensure_locks();
    bind_lua();
    push_string(L, "aesa_agradar 0.1.0 (phase1 surface mask)");
    return 1;
}

AGR_EXPORT aesa_agradar_surface_names(lua_State *L)
{
    double x, z;
    int okx = 0, okz = 0;
    uint64_t mask;
    char names[512];

    ensure_locks();
    bind_lua();
    x = arg_number(L, 1, &okx);
    z = arg_number(L, 2, &okz);
    if (!okx || !okz || x != x || z != z ||
        x < -1.0e9 || x > 1.0e9 || z < -1.0e9 || z > 1.0e9) {
        push_nil(L);
        return 1;
    }
    if (!query_surface_mask(x, z, &mask)) {
        push_nil(L);
        return 1;
    }
    decode_mask(mask, names, sizeof(names));
    maybe_log_first(x, z, mask, names);
    push_string(L, names);
    return 1;
}

AGR_EXPORT aesa_agradar_surface_mask(lua_State *L)
{
    double x, z;
    int okx = 0, okz = 0;
    uint64_t mask;

    ensure_locks();
    bind_lua();
    x = arg_number(L, 1, &okx);
    z = arg_number(L, 2, &okz);
    if (!okx || !okz || x != x || z != z ||
        x < -1.0e9 || x > 1.0e9 || z < -1.0e9 || z > 1.0e9) {
        push_nil(L);
        return 1;
    }
    if (!query_surface_mask(x, z, &mask)) {
        push_nil(L);
        return 1;
    }
    maybe_log_first(x, z, mask, NULL);
    push_number(L, (double)mask);
    return 1;
}

/*
 * aesa_fc.c — AESA fire-control native probe and (optional) write experiment.
 *
 * Loaded into the DCS process from a Saved Games Scripts/Hooks Lua script via
 * package.loadlib (no proxy DLL, no install-directory writes).
 *
 * Gate 6 (D4): one source, two builds.
 *   - AESA_FC_TRACE_ONLY: read-only trace build (aesa_fc_trace.dll). The write
 *     path (arm/disarm/feed_target and the detour rewrites) is not compiled.
 *   - default: trace + write path (aesa_fc_inject.dll). Only this build exports
 *     aesa_fc_arm / aesa_fc_disarm / aesa_fc_feed_target.
 * The two DLLs must never be loaded at the same time: both install MinHook
 * detours on the same engine functions.
 *
 * The exported functions are lua_CFunction-compatible but do not link lua.dll;
 * the few Lua API entry points used are resolved at runtime, so the DLL stays
 * dependency-free (kernel32/version only) and build-agnostic.
 */
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <math.h>
#include <string.h>
#include <stdarg.h>

#define FC_EXPORT __declspec(dllexport) int __cdecl

#ifdef AESA_FC_TRACE_ONLY
#define FC_VARIANT "trace"
#else
#define FC_VARIANT "inject"
#endif

typedef struct lua_State lua_State;
typedef const char *(__cdecl *lua_tolstring_fn)(lua_State *, int, size_t *);
typedef void (__cdecl *lua_pushstring_fn)(lua_State *, const char *);
typedef void (__cdecl *lua_pushinteger_fn)(lua_State *, ptrdiff_t);
typedef int (__cdecl *lua_gettop_fn)(lua_State *);

static lua_tolstring_fn p_lua_tolstring;
static lua_pushstring_fn p_lua_pushstring;
static lua_pushinteger_fn p_lua_pushinteger;
static lua_gettop_fn p_lua_gettop;

static FILE *g_log;
static char g_log_dir[MAX_PATH];
static unsigned long g_poll_count;
static int g_syms_missing;

struct sym_spec {
    const char *module;
    const char *symbol;
    FARPROC addr;
};

/* Engine symbols probed in phase 1 (exports verified present on 2.9.30.28738). */
static struct sym_spec g_syms[] = {
    { "wRadio.dll",
      "?receive_msg@wDatalinkCommunicator@@UEAAXAEBUdatalink_msg@@@Z", NULL },
    { "wRadio.dll",
      "?receive_msg@wNetDatalinkCommunicator@@UEAAXAEBUdatalink_msg@@@Z", NULL },
    { "wRadio.dll",
      "?send_msg@wDatalinkCommunicator@@UEAAXAEBUdatalink_msg@@@Z", NULL },
    { "wRadio.dll",
      "?get_msgs_gueue@wDatalinkCommunicator@@UEAAAEAV?$list@Udatalink_msg@@V?$"
      "allocator@Udatalink_msg@@@ed@@@ed@@XZ", NULL },
    { "wRadio.dll",
      "?getNetState@wDatalinkCommunicator@@UEBAXAEAUDatalinkState@@@Z", NULL },
    { "wRadio.dll",
      "?setEnabledReceiverBits@wDatalinkCommunicator@@UEAAXAEBV?$bitset@$0CA@@"
      "std@@@Z", NULL },
    { "WorldGeneral.dll",
      "?getDatalinkTerminal@MovingObject@@UEBAPEAVIwDatalinkTerminal@@E@Z", NULL },
    { "WorldGeneral.dll",
      "?ForcePosition@MovingObject@@UEAAXAEBV?$wPosition3@N@@@Z", NULL },
    { "WorldGeneral.dll",
      "?Target_ID@MovingObject@@UEBAIXZ", NULL },
    { "Weapons.dll",
      "?assignAutotrackingTarget@wWeaponSystemManager@@QEAAXPEAVMovingObject@@@Z",
      NULL },
    { "Weapons.dll",
      "?getTrackingTarget@wWeaponSystemManager@@QEBAPEAVMovingObject@@XZ", NULL },
    { "Weapons.dll",
      "?setTarget@wAmmunitionGuided@@UEAAXI@Z", NULL },
    { "Weapons.dll",
      "?track_missile@wWeaponSystem@@QEAA_NII@Z", NULL },
    { "CockpitBase.dll",
      "ed_cockpit_get_parameter_handle", NULL },
    { "CockpitBase.dll",
      "ed_cockpit_update_parameter_with_number", NULL },
    { "CockpitBase.dll",
      "ed_cockpit_dispatch_action_digital", NULL },
    { "CockpitBase.dll",
      "ed_cockpit_track_is_writing", NULL },
};

static void log_open(const char *dir)
{
    char path[MAX_PATH];
    size_t n;
    if (g_log)
        return;
    if (!dir || !dir[0]) {
        const char *up = getenv("USERPROFILE");
        _snprintf(g_log_dir, sizeof(g_log_dir) - 1,
                  "%s\\Saved Games\\DCS\\Logs\\AESA", up ? up : ".");
        g_log_dir[sizeof(g_log_dir) - 1] = 0;
    } else {
        strncpy(g_log_dir, dir, sizeof(g_log_dir) - 1);
        g_log_dir[sizeof(g_log_dir) - 1] = 0;
    }
    /* mkdir -p: walk the path and create each component. */
    for (n = 0; g_log_dir[n]; n++) {
        if (g_log_dir[n] == '\\' && n > 3) {
            g_log_dir[n] = 0;
            CreateDirectoryA(g_log_dir, NULL);
            g_log_dir[n] = '\\';
        }
    }
    CreateDirectoryA(g_log_dir, NULL);
    _snprintf(path, sizeof(path), "%s\\fc_native.log", g_log_dir);
    g_log = fopen(path, "ab");
}

static void log_line(const char *fmt, ...)
{
    SYSTEMTIME st;
    va_list ap;
    if (!g_log)
        return;
    GetLocalTime(&st);
    fprintf(g_log, "[%02d:%02d:%02d.%03d] ", st.wHour, st.wMinute, st.wSecond,
            st.wMilliseconds);
    va_start(ap, fmt);
    vfprintf(g_log, fmt, ap);
    va_end(ap);
    fputc('\n', g_log);
    fflush(g_log);
}

static void bind_lua(void)
{
    HMODULE lua;
    if (p_lua_pushstring)
        return;
    lua = GetModuleHandleA("lua.dll");
    if (!lua)
        return;
    p_lua_tolstring = (lua_tolstring_fn)GetProcAddress(lua, "lua_tolstring");
    p_lua_pushstring = (lua_pushstring_fn)GetProcAddress(lua, "lua_pushstring");
    p_lua_pushinteger =
        (lua_pushinteger_fn)GetProcAddress(lua, "lua_pushinteger");
    p_lua_gettop = (lua_gettop_fn)GetProcAddress(lua, "lua_gettop");
}

static const char *arg_string(lua_State *L, int idx)
{
    if (!L || !p_lua_tolstring || !p_lua_gettop || p_lua_gettop(L) < idx)
        return NULL;
    return p_lua_tolstring(L, idx, NULL);
}

static void push_string(lua_State *L, const char *s)
{
    if (L && p_lua_pushstring)
        p_lua_pushstring(L, s);
}

static void push_int(lua_State *L, ptrdiff_t v)
{
    if (L && p_lua_pushinteger)
        p_lua_pushinteger(L, v);
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
    }
    HeapFree(GetProcessHeap(), 0, info);
}

FC_EXPORT aesa_fc_init(lua_State *L)
{
    size_t i;
    int found = 0;
    bind_lua();
    log_open(arg_string(L, 1));
    log_line("aesa_fc probe init (%s, phase1+trace)", FC_VARIANT);
    log_module_version("wRadio.dll");
    log_module_version("Weapons.dll");
    log_module_version("WorldGeneral.dll");
    log_module_version("CockpitBase.dll");
    for (i = 0; i < sizeof(g_syms) / sizeof(g_syms[0]); i++) {
        HMODULE h = GetModuleHandleA(g_syms[i].module);
        g_syms[i].addr = h ? GetProcAddress(h, g_syms[i].symbol) : NULL;
        if (g_syms[i].addr)
            found++;
        log_line("sym %-72s %s", g_syms[i].symbol,
                 g_syms[i].addr ? "resolved" : "MISSING");
    }
    log_line("init complete: %d/%d symbols resolved", found,
             (int)(sizeof(g_syms) / sizeof(g_syms[0])));
    g_syms_missing = (int)(sizeof(g_syms) / sizeof(g_syms[0])) - found;
    push_int(L, found);
    return 1;
}

/* Engine DLLs may finish loading after our hook runs; retry the missing ones
   from the frame poll until everything resolves. */
static void resolve_missing(void)
{
    size_t i;
    if (g_syms_missing <= 0)
        return;
    for (i = 0; i < sizeof(g_syms) / sizeof(g_syms[0]); i++) {
        HMODULE h;
        if (g_syms[i].addr)
            continue;
        h = GetModuleHandleA(g_syms[i].module);
        if (h)
            g_syms[i].addr = GetProcAddress(h, g_syms[i].symbol);
        if (g_syms[i].addr) {
            g_syms_missing--;
            log_line("sym %-72s late-resolved", g_syms[i].symbol);
        }
    }
    if (g_syms_missing == 0)
        log_line("all symbols resolved");
}

FC_EXPORT aesa_fc_poll(lua_State *L)
{
    (void)L;
    g_poll_count++;
    resolve_missing();
    if (g_poll_count == 1)
        log_line("poll alive (first simulation frame)");
    else if (g_poll_count % 3600 == 0)
        log_line("poll heartbeat: %lu frames", g_poll_count);
    return 0;
}

FC_EXPORT aesa_fc_shutdown(lua_State *L)
{
    (void)L;
    if (g_log) {
        log_line("shutdown after %lu frames", g_poll_count);
        fclose(g_log);
        g_log = NULL;
    }
    return 0;
}

FC_EXPORT aesa_fc_version(lua_State *L)
{
    /* native.load() resolves the version before aesa_fc_init; bind the Lua
       API here too so the first call already returns a string. */
    bind_lua();
    push_string(L, "aesa_fc 0.3.0 (" FC_VARIANT ")");
    return 1;
}

/* --------------------------------------------------------------------------
 * Phase 2: read-only guidance call-graph tracer.
 *
 * MinHook detours on engine functions that participate in missile fire
 * control and datalink message flow. Every detour only LOGS (this pointer,
 * runtime class name read from RTTI, arguments, small raw dumps) and calls
 * the original. Nothing is written to the simulation. Purpose: learn how a
 * stock F-16C AMRAAM shot is wired on the current build, so the injection
 * point for our own track becomes an observation, not a guess.
 * ----------------------------------------------------------------------- */
#include "../third_party/minhook/include/MinHook.h"

static FILE *g_trace;
static CRITICAL_SECTION g_trace_lock;
static int g_trace_lock_init;
static int g_trace_installed;

/* Length of the readable (or writable) prefix of [p, p+n). Every virtual
   memory region the range touches is validated: crossing into uncommitted,
   PAGE_NOACCESS, PAGE_GUARD or (for reads) execute-only memory stops the
   prefix. Callers must compare the result with n before touching memory. */
static size_t range_prefix(const void *p, size_t n, int need_write)
{
    uintptr_t addr, end;

    if (!p)
        return 0;
    addr = (uintptr_t)p;
    if (n > (size_t)(UINTPTR_MAX - addr))
        return 0;
    end = addr + n;
    while (addr < end) {
        MEMORY_BASIC_INFORMATION mbi;
        uintptr_t region_end;
        DWORD prot;

        if (!VirtualQuery((const void *)addr, &mbi, sizeof(mbi)))
            return (size_t)(addr - (uintptr_t)p);
        prot = mbi.Protect & 0xff;
        if (mbi.State != MEM_COMMIT || (mbi.Protect & PAGE_GUARD) ||
            prot == PAGE_NOACCESS || (!need_write && prot == PAGE_EXECUTE) ||
            (need_write && prot != PAGE_READWRITE && prot != PAGE_WRITECOPY &&
             prot != PAGE_EXECUTE_READWRITE &&
             prot != PAGE_EXECUTE_WRITECOPY))
            return (size_t)(addr - (uintptr_t)p);
        region_end = (uintptr_t)mbi.BaseAddress + (uintptr_t)mbi.RegionSize;
        if (region_end <= addr)
            return (size_t)(addr - (uintptr_t)p);
        if (region_end >= end)
            break;
        addr = region_end;
    }
    return n;
}

static int readable(const void *p, size_t n)
{
    return p && range_prefix(p, n, 0) == n;
}

#ifndef AESA_FC_TRACE_ONLY
static int writable(const void *p, size_t n)
{
    return p && range_prefix(p, n, 1) == n;
}
#endif

/* Read-only test export of the range check above. Never dereferences p. */
__declspec(dllexport) int __cdecl aesa_fc_readable(const void *p, size_t n)
{
    return readable(p, n);
}

/* Runtime class identification via RTTI (works for non-obfuscated engine
   classes; module classes with stripped RTTI report "no-rtti"). */
static const char *rtti_name(const void *obj, char *buf, size_t bufsz)
{
    void **vft;
    const unsigned char *col;
    int td_rva;
    HMODULE mod;
    const char *name;
    size_t i, max;

    if (!bufsz)
        return "?";
    snprintf(buf, bufsz, "?");
    if (!readable(obj, sizeof(void *)))
        return "bad-obj";
    vft = *(void ***)obj;
    /* vft[-1] is the complete-object locator, i.e. the slot before vft. */
    if (!readable(vft - 1, sizeof(void *)))
        return "bad-vtbl";
    col = (const unsigned char *)vft[-1];
    if (!readable(col, 24))
        return "no-rtti";
    td_rva = *(const int *)(col + 12);
    if (!GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                                GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                            (const char *)col, &mod))
        return "no-module";
    name = (const char *)mod + td_rva + 16; /* TypeDescriptor.name */
    max = bufsz ? bufsz - 1 : 0;
    if (max > 96)
        max = 96;
    if (!readable(name, max))
        return "no-name";
    for (i = 0; i < max && name[i]; i++)
        buf[i] = name[i];
    buf[i] = 0;
    return buf;
}

static void trace_open(void)
{
    char path[MAX_PATH];
    if (g_trace || !g_log_dir[0])
        return;
    _snprintf(path, sizeof(path), "%s\\fc_trace.log", g_log_dir);
    g_trace = fopen(path, "ab");
    if (!g_trace_lock_init) {
        InitializeCriticalSection(&g_trace_lock);
        g_trace_lock_init = 1;
    }
}

static void trace_line(const char *fmt, ...)
{
    SYSTEMTIME st;
    va_list ap;
    if (!g_trace)
        return;
    EnterCriticalSection(&g_trace_lock);
    GetLocalTime(&st);
    fprintf(g_trace, "[%02d:%02d:%02d.%03d t%lu] ", st.wHour, st.wMinute,
            st.wSecond, st.wMilliseconds, GetCurrentThreadId());
    va_start(ap, fmt);
    vfprintf(g_trace, fmt, ap);
    va_end(ap);
    fputc('\n', g_trace);
    fflush(g_trace);
    LeaveCriticalSection(&g_trace_lock);
}

static void trace_hex(const char *tag, const void *self, const void *msg)
{
    char cls[112];
    char hex[2 * 192 + 1];
    const unsigned char *b = (const unsigned char *)msg;
    int n = 192, i;
    if (!readable(msg, 64)) {
        trace_line("%s this=%p (%s) msg unreadable", tag, self,
                   rtti_name(self, cls, sizeof(cls)));
        return;
    }
    if (!readable(msg, 192))
        n = 64; /* conservative clamp near page end */
    for (i = 0; i < n; i++)
        _snprintf(hex + 2 * i, 3, "%02x", b[i]);
    hex[2 * n] = 0;
    trace_line("%s this=%p (%s) %s", tag, self, rtti_name(self, cls, sizeof(cls)),
               hex);
}

/* --- hook bookkeeping --- */
struct trace_site {
    const char *module;
    const char *symbol;
    void *detour;
    void *original;
    unsigned long calls;
    const char *tag;
};

/* NOTE: no engine virtual calls from detours (Target_ID/GetPosition on
   MovingObject chase sub-object pointers that are NULL on some classes and
   crashed the sim, 2026-10-16). Diagnostics stay read-only memory-wise. */

#define TRACE_SITE_LOG_FIRST 64

static void site_count(struct trace_site *s)
{
    s->calls++;
}

static int site_verbose(struct trace_site *s)
{
    return s->calls <= TRACE_SITE_LOG_FIRST || s->calls % 64 == 0;
}

static struct trace_site g_sites[]; /* defined below; detours index into it */


/* --- detour signatures (x64: member call == free call with this in RCX) --- */
typedef void (*recv_msg_fn)(void *self, const void *msg);
typedef void (*assign_fn)(void *self, void *target);
typedef int (*track_missile_fn)(void *self, unsigned int missile,
                                unsigned int target);
typedef void (*set_target_fn)(void *self, unsigned int target);

static recv_msg_fn orig_recv_dl, orig_recv_net, orig_send_dl;
static assign_fn orig_assign_auto;
static track_missile_fn orig_track_ws, orig_track_launcher;
static set_target_fn orig_set_target_guided;
typedef void (*vec_fn)(void *self, const void *vec);   /* (this, const Vec&) */
typedef void (*guid_fn)(void *self, double dt);        /* (this, double) */
static vec_fn orig_assign_tp, orig_sync_tp;
static guid_fn orig_calc_inertial, orig_calc_terminal, orig_ctrl_mode;
/* member fn returning a big struct by value: MSVC x64 passes the hidden
   return buffer in RCX and 'this' in RDX. */
typedef void (*interm_tp_fn)(void *out, void *self);
static interm_tp_fn orig_interm_tp;

/* --- P4 object watcher (OBJD): delta-dump missile-related object memory ---
   The 2026-10-17 native baseline proved midcourse updates do NOT flow
   through any hookable exported call (setTarget fires only at launch and
   seeker activation; SYNC_TP/INTERM_TP/ASSIGN_TP never fired; datalink
   carried only SA spam). So the aim point lives in object memory written by
   the fire control directly. Delta-dump watched objects at ~5 Hz: snapshot
   starts zeroed so the first sample logs every nonzero 16-byte slot, later
   samples log only changed slots. Offline correlation with the Lua-side
   trajectory log (fc_msl_pos.log) identifies which offset receives the
   intercept point. Read-only; every sample is region-validated first. */
#define WATCH_MAX 6
#define WATCH_SPAN 0x2000
#define WATCH_SLOT 16
struct watch_ent {
    void *obj;
    unsigned char snap[WATCH_SPAN];
    char tag;
    char seeker_state; /* 0=pending, 1=found, 2=gave up */
    unsigned short seeker_retry;
};
static struct watch_ent g_watch[WATCH_MAX];
static int g_watch_n;
static unsigned long g_objdiff_tick;

static void watch_add(void *obj, char tag);
static void watch_sample(void);

static void seeker_scan(struct watch_ent *w)
{
    /* look for a member pointer whose pointee RTTI names a seeker */
    size_t off;
    char cls[112];
    if (w->seeker_state != 0 || !readable(w->obj, WATCH_SPAN))
        return;
    for (off = 0; off + sizeof(void *) <= WATCH_SPAN; off += sizeof(void *)) {
        void *p = *(void **)((unsigned char *)w->obj + off);
        const char *name;
        if (!readable(p, sizeof(void *)))
            continue;
        name = rtti_name(p, cls, sizeof(cls));
        if (strstr(name, "Seeker") || strstr(name, "SN_AR") ||
            strstr(name, "wDRadio")) {
            trace_line("OBJW %p seeker candidate +%03x -> %p (%s)", w->obj,
                       (unsigned)off, p, name);
            watch_add(p, 'S');
            w->seeker_state = 1;
            return;
        }
    }
    if (++w->seeker_retry >= 20) {
        w->seeker_state = 2;
        trace_line("OBJW %p no seeker candidate found", w->obj);
    }
}

static void watch_add(void *obj, char tag)
{
    int i;
    if (!obj)
        return;
    for (i = 0; i < g_watch_n; i++)
        if (g_watch[i].obj == obj)
            return;
    if (g_watch_n >= WATCH_MAX)
        return;
    g_watch[g_watch_n].obj = obj;
    memset(g_watch[g_watch_n].snap, 0, WATCH_SPAN);
    g_watch[g_watch_n].tag = tag;
    g_watch[g_watch_n].seeker_state = 0;
    g_watch[g_watch_n].seeker_retry = 0;
    g_watch_n++;
    trace_line("OBJW add %p tag=%c", obj, tag);
}

static void watch_sample(void)
{
    int i;
    for (i = 0; i < g_watch_n; i++) {
        struct watch_ent *w = &g_watch[i];
        const unsigned char *cur = (const unsigned char *)w->obj;
        size_t valid, off;
        valid = range_prefix(w->obj, WATCH_SPAN, 0);
        valid &= ~(size_t)(WATCH_SLOT - 1);
        for (off = 0; off < valid; off += WATCH_SLOT) {
            if (memcmp(cur + off, w->snap + off, WATCH_SLOT) != 0) {
                char oldh[2 * WATCH_SLOT + 1], newh[2 * WATCH_SLOT + 1];
                int k;
                for (k = 0; k < WATCH_SLOT; k++) {
                    _snprintf(oldh + 2 * k, 3, "%02x", w->snap[off + k]);
                    _snprintf(newh + 2 * k, 3, "%02x", cur[off + k]);
                }
                oldh[2 * WATCH_SLOT] = 0;
                newh[2 * WATCH_SLOT] = 0;
                trace_line("OBJD %p %c +%03x %s>%s", w->obj, w->tag,
                           (unsigned)off, oldh, newh);
                memcpy(w->snap + off, cur + off, WATCH_SLOT);
            }
        }
        if ((w->tag == 'A' || w->tag == 'G') && w->seeker_state == 0)
            seeker_scan(w);
    }
}

/* --- P3-1 write experiment: forced target designation ----------------------
   When armed (mode 1), the first self-homing missile whose setTarget fires
   becomes THE designated missile; any setTarget(0) on it is rewritten to
   setTarget(g_forced_target) — i.e. the maddog launch-time "no target" is
   replaced by our designation on the engine's own call site, same thread.
   Arm/disarm only from Lua. All forced calls are logged unconditionally.
   Compiled only in the inject build (Gate 6 D4). */
#ifndef AESA_FC_TRACE_ONLY
static volatile long g_force_mode;      /* 0=off, 1=one-shot designate */
static volatile long g_forced_target;   /* engine ObjectID */
static void *volatile g_forced_missile; /* captured missile object */

/* --- P5 lead feed -----------------------------------------------------------
   2026-10-17 proof: an injected setTarget designation makes the missile
   refresh wGP_AMRAAM+0x220 every tick with (target_pos - missile_pos), i.e.
   pure pursuit (hit, but late dive, "odd" loft). A natively supported shot
   carries a lead term (+3.8 km constant in our baseline). To look native we
   compute the predicted intercept ourselves: the Lua hook feeds the target's
   live pos/vel at ~2 Hz (aesa_fc_feed_target), and each calc_inertial tick
   we write aim = target + vel*tgo (tgo = range/max(speed,200)) into +0x220
   BEFORE orig runs, so calcInertialGuidance consumes our point this tick.
   OBJD will show whether the write sticks or the missile overwrites it.
   Offsets +0x1a8/+0x1c0/+0x220 verified on DCS 2.9.30.28738 by OBJD
   correlation with the Lua-side trajectory log. */
static volatile long g_feed_valid;
static volatile double g_feed_p[3], g_feed_v[3];
static void *volatile g_feed_gp; /* wGP_AMRAAM of the captured missile */
static void *g_pre_gp[8];        /* G objects already ticking pre-capture */
static int g_pre_gp_n;

static void feed_write(void *self)
{
    double msl_p[3], msl_v[3], dx, dy, dz, dist, spd, tgo, aim[3];
    double *rv;
    if (!g_feed_valid)
        return;
    if (!writable((const char *)self + 0x1a8, 24) ||
        !writable((const char *)self + 0x1c0, 24) ||
        !writable((const char *)self + 0x220, 24))
        return;
    memcpy(msl_p, (const char *)self + 0x1a8, sizeof(msl_p));
    memcpy(msl_v, (const char *)self + 0x1c0, sizeof(msl_v));
    dx = g_feed_p[0] - msl_p[0];
    dy = g_feed_p[1] - msl_p[1];
    dz = g_feed_p[2] - msl_p[2];
    dist = sqrt(dx * dx + dy * dy + dz * dz);
    spd = sqrt(msl_v[0] * msl_v[0] + msl_v[1] * msl_v[1] +
               msl_v[2] * msl_v[2]);
    tgo = dist / (spd > 200.0 ? spd : 200.0);
    aim[0] = g_feed_p[0] + g_feed_v[0] * tgo;
    aim[1] = g_feed_p[1] + g_feed_v[1] * tgo;
    aim[2] = g_feed_p[2] + g_feed_v[2] * tgo;
    rv = (double *)((char *)self + 0x220);
    rv[0] = aim[0] - msl_p[0];
    rv[1] = aim[1] - msl_p[1];
    rv[2] = aim[2] - msl_p[2];
    if (g_objdiff_tick % 200 == 0)
        trace_line("FEED gp=%p rv=(%.0f, %.0f, %.0f) dist=%.0f tgo=%.1f",
                   self, rv[0], rv[1], rv[2], dist, tgo);
}
#endif /* !AESA_FC_TRACE_ONLY */

/* P3-2 detours: the real midcourse channel hunt. */
static void detour_assign_tp(void *self, const void *vec)
{
    char cls[112];
    float v[3] = { 0, 0, 0 };
    if (readable(vec, sizeof(v)))
        memcpy(v, vec, sizeof(v));
    if (site_verbose(&g_sites[7]))
        trace_line("ASSIGN_TP this=%p (%s) vec=(%.1f, %.1f, %.1f)", self,
                   rtti_name(self, cls, sizeof(cls)), v[0], v[1], v[2]);
    site_count(&g_sites[7]);
    orig_assign_tp(self, vec);
}
static void detour_sync_tp(void *self, const void *vec)
{
    char cls[112];
    double v[2] = { 0, 0 };
    if (readable(vec, sizeof(v)))
        memcpy(v, vec, sizeof(v));
    if (site_verbose(&g_sites[8]))
        trace_line("SYNC_TP this=%p (%s) vec=(%.2f, %.2f)", self,
                   rtti_name(self, cls, sizeof(cls)), v[0], v[1]);
    site_count(&g_sites[8]);
    orig_sync_tp(self, vec);
}
static void detour_calc_inertial(void *self, double dt)
{
    char cls[112];
    watch_add(self, 'G');
    if (++g_objdiff_tick % 40 == 0)
        watch_sample();
#ifndef AESA_FC_TRACE_ONLY
    if (g_force_mode == 1) {
        if (g_forced_missile) {
            if (!g_feed_gp) {
                /* first guidance object to tick after our missile's capture
                   (pre-launch tickers belong to other/AI missiles) */
                int i, seen = 0;
                for (i = 0; i < g_pre_gp_n; i++)
                    if (g_pre_gp[i] == self) {
                        seen = 1;
                        break;
                    }
                if (!seen) {
                    InterlockedExchangePointer((void *volatile *)&g_feed_gp,
                                               self);
                    trace_line("FEED captured guidance gp=%p", self);
                }
            }
            if (self == g_feed_gp)
                feed_write(self);
        } else if (g_pre_gp_n < 8) {
            int i, seen = 0;
            for (i = 0; i < g_pre_gp_n; i++)
                if (g_pre_gp[i] == self) {
                    seen = 1;
                    break;
                }
            if (!seen)
                g_pre_gp[g_pre_gp_n++] = self;
        }
    }
#endif
    if (site_verbose(&g_sites[9]))
        trace_line("CALC_INERT this=%p (%s) dt=%.4f", self,
                   rtti_name(self, cls, sizeof(cls)), dt);
    site_count(&g_sites[9]);
    orig_calc_inertial(self, dt);
}
static void detour_calc_terminal(void *self, double dt)
{
    char cls[112];
    if (++g_objdiff_tick % 40 == 0)
        watch_sample(); /* terminal-phase sampling: capture the pitbull
                           handoff transient (midcourse drives it otherwise) */
    if (site_verbose(&g_sites[10]))
        trace_line("CALC_TERM this=%p (%s) dt=%.4f", self,
                   rtti_name(self, cls, sizeof(cls)), dt);
    site_count(&g_sites[10]);
    orig_calc_terminal(self, dt);
}
static void detour_ctrl_mode(void *self, double dt)
{
    char cls[112];
    if (site_verbose(&g_sites[11]))
        trace_line("CTRL_MODE this=%p (%s) dt=%.4f", self,
                   rtti_name(self, cls, sizeof(cls)), dt);
    site_count(&g_sites[11]);
    orig_ctrl_mode(self, dt);
}
/* wDRadioSeeker::getIntermTargetPoint — the midcourse aim-point read. Called
   after orig so the caller's buffer is filled; read-back is a plain memory
   read (guarded), no engine calls. */
static void detour_interm_tp(void *out, void *self)
{
    char cls[112];
    double v[3] = { 0, 0, 0 };
    orig_interm_tp(out, self);
    if (site_verbose(&g_sites[12])) {
        if (readable(out, sizeof(v)))
            memcpy(v, out, sizeof(v));
        trace_line("INTERM_TP this=%p (%s) p=(%.1f, %.1f, %.1f)", self,
                   rtti_name(self, cls, sizeof(cls)), v[0], v[1], v[2]);
    }
    site_count(&g_sites[12]);
}

/* P3-1 force globals and P5 feed state are declared above the detours
   (they are used inside detour_calc_inertial). */

#ifndef AESA_FC_TRACE_ONLY
FC_EXPORT aesa_fc_arm(lua_State *L)
{
    long mode = 0, target = 0;
    if (L && p_lua_gettop && p_lua_tolstring) {
        const char *s;
        if (p_lua_gettop(L) >= 1 && (s = p_lua_tolstring(L, 1, NULL)))
            mode = atol(s);
        if (p_lua_gettop(L) >= 2 && (s = p_lua_tolstring(L, 2, NULL)))
            target = atol(s);
    }
    trace_open();
    InterlockedExchange(&g_forced_target, target);
    InterlockedExchangePointer((void *volatile *)&g_forced_missile, NULL);
    InterlockedExchange(&g_force_mode, mode);
    trace_line("FORCE arm mode=%ld target=%ld", mode, target);
    push_int(L, 1);
    return 1;
}

FC_EXPORT aesa_fc_disarm(lua_State *L)
{
    (void)L;
    InterlockedExchange(&g_force_mode, 0);
    InterlockedExchange(&g_forced_target, 0);
    InterlockedExchangePointer((void *volatile *)&g_forced_missile, NULL);
    g_watch_n = 0; /* drop stale object pointers from the previous sortie */
    g_objdiff_tick = 0;
    InterlockedExchange(&g_feed_valid, 0);
    InterlockedExchangePointer((void *volatile *)&g_feed_gp, NULL);
    g_pre_gp_n = 0;
    if (g_trace)
        trace_line("FORCE disarm");
    return 0;
}

/* aesa_fc_feed_target("px,py,pz,vx,vy,vz") — target state for the lead
   computation, polled by the hook from the mission state at ~2 Hz. */
FC_EXPORT aesa_fc_feed_target(lua_State *L)
{
    const char *s = NULL;
    if (L && p_lua_gettop && p_lua_tolstring && p_lua_gettop(L) >= 1)
        s = p_lua_tolstring(L, 1, NULL);
    if (s) {
        double v[6];
        int n = 0;
        const char *p = s;
        char *end;
        while (n < 6) {
            v[n] = strtod(p, &end);
            if (end == p)
                break;
            n++;
            p = end;
            if (*p == ',')
                p++;
        }
        if (n == 6) {
            int i;
            for (i = 0; i < 3; i++) {
                g_feed_p[i] = v[i];
                g_feed_v[i] = v[3 + i];
            }
            InterlockedExchange(&g_feed_valid, 1);
            push_int(L, 1);
            return 1;
        }
    }
    push_int(L, 0);
    return 1;
}
#endif /* !AESA_FC_TRACE_ONLY */

static void detour_recv_dl(void *self, const void *msg)
{
    if (site_verbose(&g_sites[0]))
        trace_hex("RECV_DL", self, msg);
    site_count(&g_sites[0]);
    orig_recv_dl(self, msg);
}
static void detour_recv_net(void *self, const void *msg)
{
    if (site_verbose(&g_sites[1]))
        trace_hex("RECV_NET", self, msg);
    site_count(&g_sites[1]);
    orig_recv_net(self, msg);
}
static void detour_send_dl(void *self, const void *msg)
{
    if (site_verbose(&g_sites[2]))
        trace_hex("SEND_DL", self, msg);
    site_count(&g_sites[2]);
    orig_send_dl(self, msg);
}
static void detour_assign_auto(void *self, void *target)
{
    char cls[112], tcl[112];
    if (site_verbose(&g_sites[3]))
        trace_line("ASSIGN_AUTO this=%p (%s) target=%p (%s)", self,
                   rtti_name(self, cls, sizeof(cls)), target,
                   rtti_name(target, tcl, sizeof(tcl)));
    site_count(&g_sites[3]);
    orig_assign_auto(self, target);
}
static int detour_track_ws(void *self, unsigned int missile,
                           unsigned int target)
{
    int ret;
    char cls[112];
    ret = orig_track_ws(self, missile, target);
    if (site_verbose(&g_sites[4]))
        trace_line("TRACK_WS this=%p (%s) missile=%u target=%u ret=%d", self,
                   rtti_name(self, cls, sizeof(cls)), missile, target, ret);
    site_count(&g_sites[4]);
    return ret;
}
static int detour_track_launcher(void *self, unsigned int missile,
                                 unsigned int target)
{
    int ret;
    char cls[112];
    ret = orig_track_launcher(self, missile, target);
    if (site_verbose(&g_sites[5]))
        trace_line("TRACK_LAUNCHER this=%p (%s) missile=%u target=%u ret=%d",
                   self, rtti_name(self, cls, sizeof(cls)), missile, target,
                   ret);
    site_count(&g_sites[5]);
    return ret;
}
/* Missile trajectory recording lives in the Lua hook (mission-side
   Weapon:getPosition sampling bridged out to fc_msl_pos.log). Do NOT sample
   positions here by calling MovingObject::GetPosition: on ammunition objects
   it chases a NULL sub-object pointer (verified: AV reading [0+0x70] with
   rcx==missile this, 2026-10-16 crash dcs.20261016-191455). Engine virtuals
   on engine objects are off-limits in detours. */
static void detour_set_target_guided(void *self, unsigned int target)
{
    char cls[112];
    watch_add(self, 'A');
#ifndef AESA_FC_TRACE_ONLY
    if (g_force_mode == 1) {
        void *m = g_forced_missile;
        if (!m && target == 0) {
            /* capture only on the maddog-style launch signature (target==0);
               supported shots (nonzero first call) never hijack the slot */
            m = InterlockedCompareExchangePointer(
                (void *volatile *)&g_forced_missile, self, NULL);
            if (!m) {
                m = self;
                trace_line("FORCE captured missile this=%p (%s)", self,
                           rtti_name(self, cls, sizeof(cls)));
            }
        }
        if (m == self && target == 0) {
            unsigned int want = (unsigned int)g_forced_target;
            if (want) {
                trace_line("FORCE rewrite setTarget(0) -> setTarget(%u) on %p",
                           want, self);
                target = want;
            }
        }
    }
#endif
    if (site_verbose(&g_sites[6]))
        trace_line("SET_TARGET this=%p (%s) target=%u", self,
                   rtti_name(self, cls, sizeof(cls)), target);
    site_count(&g_sites[6]);
    orig_set_target_guided(self, target);
}

static struct trace_site g_sites[] = {
    { "wRadio.dll",
      "?receive_msg@wDatalinkCommunicator@@UEAAXAEBUdatalink_msg@@@Z",
      detour_recv_dl, &orig_recv_dl, 0, "RECV_DL" },
    { "wRadio.dll",
      "?receive_msg@wNetDatalinkCommunicator@@UEAAXAEBUdatalink_msg@@@Z",
      detour_recv_net, &orig_recv_net, 0, "RECV_NET" },
    { "wRadio.dll",
      "?send_msg@wDatalinkCommunicator@@UEAAXAEBUdatalink_msg@@@Z",
      detour_send_dl, &orig_send_dl, 0, "SEND_DL" },
    { "Weapons.dll",
      "?assignAutotrackingTarget@wWeaponSystemManager@@QEAAXPEAVMovingObject@@@"
      "Z",
      detour_assign_auto, &orig_assign_auto, 0, "ASSIGN_AUTO" },
    { "Weapons.dll", "?track_missile@wWeaponSystem@@QEAA_NII@Z",
      detour_track_ws, &orig_track_ws, 0, "TRACK_WS" },
    { "Weapons.dll", "?track_missile@cLauncher@@UEAA_NII@Z",
      detour_track_launcher, &orig_track_launcher, 0, "TRACK_LAUNCHER" },
    { "Weapons.dll", "?setTarget@wAmmunitionGuided@@UEAAXI@Z",
      detour_set_target_guided, &orig_set_target_guided, 0, "SET_TARGET" },
    { "Weapons.dll",
      "?assignTargetPoint@wAmmunitionGuided@@UEAAXAEBVVec3f@osg@@@Z",
      detour_assign_tp, &orig_assign_tp, 0, "ASSIGN_TP" },
    { "WeaponBlocks.dll",
      "?setSyncTargetPoint@wDSeeker@@IEAAXAEBV?$Vector@$02N@Math@@@Z",
      detour_sync_tp, &orig_sync_tp, 0, "SYNC_TP" },
    { "WeaponBlocks.dll", "?calcInertialGuidance@wGP_AMRAAM@@IEAAXN@Z",
      detour_calc_inertial, &orig_calc_inertial, 0, "CALC_INERT" },
    { "WeaponBlocks.dll", "?calcTerminalGuidance@wGP_AMRAAM@@IEAAXN@Z",
      detour_calc_terminal, &orig_calc_terminal, 0, "CALC_TERM" },
    { "WeaponBlocks.dll", "?controlGuidanceMode@wGP_AMRAAM@@IEAAXN@Z",
      detour_ctrl_mode, &orig_ctrl_mode, 0, "CTRL_MODE" },
    { "WeaponBlocks.dll",
      "?getIntermTargetPoint@wDRadioSeeker@@IEAA?AV?$Vector@$02N@Math@@XZ",
      detour_interm_tp, &orig_interm_tp, 0, "INTERM_TP" },
};

FC_EXPORT aesa_fc_trace_start(lua_State *L)
{
    size_t i;
    int installed = 0;
    trace_open();
    if (g_trace_installed) {
        push_int(L, -1);
        return 1;
    }
    MH_STATUS mh = MH_Initialize();
    if (mh != MH_OK && mh != MH_ERROR_ALREADY_INITIALIZED) {
        trace_line("TRACE MinHook init failed (%d)", (int)mh);
        push_int(L, 0);
        return 1;
    }
    for (i = 0; i < sizeof(g_sites) / sizeof(g_sites[0]); i++) {
        struct trace_site *s = &g_sites[i];
        HMODULE h = GetModuleHandleA(s->module);
        void *target = h ? GetProcAddress(h, s->symbol) : NULL;
        if (!target) {
            trace_line("TRACE %s: target missing", s->tag);
            continue;
        }
        if (MH_CreateHook(target, s->detour, s->original) != MH_OK ||
            MH_EnableHook(target) != MH_OK) {
            trace_line("TRACE %s: hook failed", s->tag);
            continue;
        }
        installed++;
        trace_line("TRACE %s hooked at %p", s->tag, target);
    }
    g_trace_installed = installed > 0;
    trace_line("TRACE start: %d/%d hooks installed", installed,
               (int)(sizeof(g_sites) / sizeof(g_sites[0])));
    push_int(L, installed);
    return 1;
}

FC_EXPORT aesa_fc_trace_stop(lua_State *L)
{
    size_t i;
    (void)L;
    for (i = 0; i < sizeof(g_sites) / sizeof(g_sites[0]); i++) {
        struct trace_site *s = &g_sites[i];
        HMODULE h = GetModuleHandleA(s->module);
        void *target = h ? GetProcAddress(h, s->symbol) : NULL;
        if (target && *(void **)s->original) {
            MH_DisableHook(target);
            MH_RemoveHook(target);
            *(void **)s->original = NULL;
        }
        if (s->calls)
            trace_line("TRACE %s total calls: %lu", s->tag, s->calls);
    }
    if (g_trace) {
        trace_line("TRACE stop");
        fclose(g_trace);
        g_trace = NULL;
    }
    g_trace_installed = 0;
    g_watch_n = 0; /* drop stale object pointers from the previous sortie */
    g_objdiff_tick = 0;
    return 0;
}

# -*- coding: utf-8 -*-
"""aesa 单元测试：Python + lupa(lua5.1) 驱动。

断言与 docs/theory-notes.md §9 的 T1–T10 一一对应，另加一个端到端冒烟测试。
用法：python tests/run_tests.py
"""
import math
import os
import random
import socket
import sys
import threading
import time

import lupa.lua51 as lupa

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src", "core")
ADAPTERS = os.path.join(ROOT, "src", "adapters", "dcs")
SHARED = os.path.join(ROOT, "src", "shared")
TESTS = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.join(ROOT, "tools")
for _p in (TOOLS, os.path.join(ROOT, "scripts")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

_CORE_MODULES = {
    "init", "constants", "physics", "beam", "detection", "geometry",
    "scheduler", "tracker", "core", "rcs", "measurement", "snapshot",
}
_ADAPTER_MODULES = {"frame", "truth_replay", "dcs_rcs", "rcs_data"}

RT = lupa.LuaRuntime(unpack_returned_tuples=True)
_loader = RT.eval(
    "function(src, name) local f, e = loadstring(src, name)"
    " if not f then error(e, 2) end return f() end"
)


def load_lua(path, name):
    with open(path, "r", encoding="utf-8") as f:
        return _loader(f.read(), name)


def mod(name):
    if name == "config":
        return load_lua(os.path.join(SHARED, "config.lua"), name)
    if name in _CORE_MODULES:
        return load_lua(os.path.join(SRC, name + ".lua"), name)
    if name == "dcs_rcs":
        return load_lua(os.path.join(ADAPTERS, "rcs.lua"), name)
    if name in _ADAPTER_MODULES:
        return load_lua(os.path.join(ADAPTERS, name + ".lua"), name)
    raise KeyError("unknown Lua module: %s" % name)


def T(d):
    """Python dict -> Lua 表（递归转换）"""
    return RT.table_from(d, recursive=True)


def TL(lst):
    """Python list -> Lua 序列表"""
    return RT.table_from(lst)


def call(obj, method, *args):
    """等价 Lua 的 obj:method(...)（显式传 self）"""
    return getattr(obj, method)(obj, *args)


config = mod("config")
constants = mod("constants")
constants.configure(T({
    "c_mps": config["physics"]["c_mps"],
    "boltzmann_j_per_k": config["physics"]["boltzmann_j_per_k"],
    "t0_k": config["physics"]["t0_k"],
}))
beam = mod("beam")
physics = mod("physics").bind(T({"constants": constants}))
detection = mod("detection").bind(T({"constants": constants, "physics": physics}))
geometry = mod("geometry").bind(T({"beam": beam}))
helpers = load_lua(os.path.join(TESTS, "helpers.lua"), "helpers")

RC = config["radar"]

# ---------------------------------------------------------------- 测试框架
TESTS_ALL = []


def test(fn):
    TESTS_ALL.append(fn)
    return fn


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)


def approx(value, expect, rel):
    return abs(value - expect) <= rel * abs(expect)


# ---------------------------------------------------------------- T1–T6 物理层
@test
def t1_radar_equation():
    """T1 基准：σ=5m² 正前方 SNR@100km≈357、Rmax≈128.7 km（理论笔记 §1）"""
    snr = physics.snr(RC, T({"R": 100e3, "sigma": 5.0, "theta": 0.0, "Td": 0.010}))
    check(snr > 0, "snr 应为正")
    check(approx(snr, 357.4, 0.005), "SNR@100km=%.1f（期望 357.4±0.5%%）" % snr)
    rmax = physics.rmax(RC, 5.0, 0.0, 0.010, 0.9)
    check(approx(rmax, 128.7e3, 0.01), "Rmax=%.0f m（期望 128.7 km±1%%）" % rmax)


@test
def t2_scan_loss():
    """T2 扫描损失：θ=60° 时 Rmax = 0.707 × Rmax(0)"""
    r0 = physics.rmax(RC, 5.0, 0.0, 0.010, 0.9)
    r60 = physics.rmax(RC, 5.0, math.radians(60), 0.010, 0.9)
    ratio = r60 / r0
    check(approx(ratio, 0.7071, 0.02), "Rmax(60°)/Rmax(0)=%.4f（期望 0.707）" % ratio)


@test
def t3_swerling1():
    """T3 Swerling-1 闭式：SNR=SNR_req 时 Pd 精确=0.9，且单调"""
    req = physics.snr_req_swerling1(0.9, 1e-6)
    check(approx(req, 130.1, 0.01), "SNR_req=%.2f（期望 130.1）" % req)
    pd = physics.pd_swerling1(req, 1e-6)
    check(abs(pd - 0.9) < 1e-9, "Pd(SNReq)=%.12f 应精确=0.9" % pd)
    check(physics.pd_swerling1(100, 1e-6) < physics.pd_swerling1(200, 1e-6), "Pd 应随 SNR 单调")


@test
def t4_albersheim_cross():
    """T4 交叉验证：非起伏(N=1)与 Swerling-1 所需 SNR 差 ≈8 dB"""
    alb = physics.albersheim_db(0.9, 1e-6, 1)
    check(approx(alb, 13.1, 0.02), "Albersheim=%.2f dB（期望 13.1）" % alb)
    sw1 = constants.lin_to_db(physics.snr_req_swerling1(0.9, 1e-6))
    diff = sw1 - alb
    check(7.0 <= diff <= 9.0, "起伏损耗=%.2f dB（期望 8±1）" % diff)


@test
def t5_notch():
    """T5 周期主瓣杂波 notch：中心及其混叠像判盲，边界外不判盲"""
    pe = RC["prf"][1]  # HPRF
    lam = RC["lambda_m"]
    check(detection.velocity_blind(pe, lam, 200.0, 200.0), "v_close=v_mlc 应判盲")
    check(not detection.velocity_blind(pe, lam, 250.0, 200.0), "差 50 m/s 不应判盲")
    v_blind = lam * pe["prf_hz"] / 2  # 3000 m/s
    check(detection.velocity_blind(pe, lam, 200.0 + v_blind + 5.0, 200.0), "杂波混叠像附近应判盲")


@test
def t6_range_blind():
    """T6 近距下限与周期遮蔽：部分重叠损失能量，完全遮蔽才判盲"""
    pe = RC["prf"][1]  # HPRF: τ=2µs → c·τ/2≈299.8m；Ru≈749.5m
    check(detection.range_blind(pe, 200.0), "R=200m 近距盲区")
    check(not detection.range_blind(pe, 500.0), "R=500m 不盲")
    check(not detection.range_blind(pe, 900.0), "R=900m 是部分遮蔽，仍可接收回波")
    check(approx(detection.eclipsing_factor(pe, 900.0), 0.502077, 1e-5), "900m 遮蔽能量系数")
    check(not detection.range_blind(pe, 1100.0), "R=1100m 不盲")


# ---------------------------------------------------------------- T7–T10 调度器/航迹
@test
def t_prf_selection_resolution():
    """PRF 选择：配置写名字，调度器解析为波形索引；未知名字 fail-closed"""
    sched = mod("scheduler").new(config["scheduler"], RC, T({"beam": beam}))
    selection = config["scheduler"]["prf_selection"]
    for key in ("search", "track_far", "track_near", "stt"):
        names = selection[key]
        indices = sched.prf_indices[key]
        check(len(names) == len(indices), "%s 名字/索引数量不一致" % key)
        for i in range(1, len(names) + 1):
            check(RC["prf"][indices[i]]["name"] == names[i],
                  "%s[%d] 解析错误：%s -> %s"
                  % (key, i, names[i], RC["prf"][indices[i]]["name"]))

    bad = mod("config")
    bad["scheduler"]["prf_selection"]["search"][1] = "NO_SUCH_PRF"
    try:
        mod("scheduler").new(bad["scheduler"], bad["radar"], T({"beam": beam}))
        check(False, "未知 PRF 名字应被拒绝")
    except Exception as e:  # noqa: BLE001 - lupa 透传 Lua error
        check("unknown PRF" in str(e), "错误信息应指出未知 PRF: %s" % e)


@test
def t7_overload():
    """T7 过载降级：20 条 STT 占满预算 → 搜索帧周期显著拉长，STT 不饿死"""
    sched = mod("scheduler").new(config["scheduler"], RC, T({"beam": beam}))
    records = []

    def emit(d):
        records.append(d)

    # 基线：只有搜索
    for _ in range(300):
        call(sched, "step", 0.1, emit)
    base_frame = sched.stats["search_frame_time"]
    check(base_frame and base_frame > 0.2, "基线帧周期异常: %s" % base_frame)

    # 加 20 条 STT（约 0.72 占空比）
    for i in range(1, 21):
        call(sched, "add_track", i, "stt", config["scheduler"]["revisit"]["stt_hz"], 1)
        call(sched, "set_geo", i, math.radians(10), 0.0)
    for _ in range(600):
        call(sched, "step", 0.1, emit)

    batch_bound = 20 * RC["dwell_stt_s"] / math.cos(math.radians(10)) ** (2 * RC["scan_k"]) + 0.02
    check(0 <= sched.stats["stt_late_max"] <= batch_bound,
          "STT 最大迟到 %.3fs 超出同步批次预算 %.3fs" % (sched.stats["stt_late_max"], batch_bound))
    for task_id in range(1, 21):
        count = sum(d["purpose"] == "stt" and d["task_id"] == task_id for d in records)
        check(count >= 359, "STT #%d 60s 内回访仅 %d 次" % (task_id, count))
    frame = sched.stats["search_frame_time"]
    check(frame > 2 * base_frame,
          "过载下搜索帧周期 %.2fs 应 > 2×基线 %.2fs" % (frame or -1, base_frame))


@test
def t8_tracker():
    """T8 航迹（世界系 v2.1）：M/N 确认、速度自适应门、近距防串档、coast/窗口删除、转向免疫"""
    trk = mod("tracker").new(config["tracker"])

    def D(x, y, z):
        return T({"wx": x, "wy": y, "wz": z})

    # M/N：窗口内两次命中 → 确认；速度由零学起
    tracks = call(trk, "update", 0.0, TL([D(0, 8000, -50000)]))
    check(len(tracks) == 1 and not tracks[1]["confirmed"], "首个检测应产生未确认暂定航迹")
    tracks = call(trk, "update", 0.5, TL([D(0, 8000, -49850)]))
    check(tracks[1]["confirmed"], "窗口内第二次检测应确认（2/3 时间窗简化）")
    v = tracks[1]["vel"]
    check(approx(v["z"], 150.0, 0.01), "速度平滑：0.5×300+0.5×0=150（得到 %.1f）" % v["z"])

    # 自适应门拒绝：3km 外检测（门=250+300×1=550）→ 漏检并起始新暂定航迹
    tracks = call(trk, "update", 1.5, TL([D(3000, 8000, -48000)]))
    check(tracks[1]["misses"] == 1 and tracks[1]["hits"] == 2,
          "门外观测应漏检而非关联（misses=%d）" % tracks[1]["misses"])
    check(len(tracks) == 2 and not tracks[2]["confirmed"],
          "门外观测应起始新的暂定航迹（%d 条）" % len(tracks))

    # 近距防串档（flight7 回归）：t=2.0（dtu=1.5，门=250+300×1.5=700），
    # 800m 外的"邻机"必须被拒绝——固定 1000m 门的老实现会串档
    tracks = call(trk, "update", 2.0, TL([D(800, 8000, -49000)]))
    check(tracks[1]["misses"] == 2, "邻机 800m 应在自适应门外（misses=%d）" % tracks[1]["misses"])

    # coast：last_update=0.5，t=7.0（>0.5+6）删除；暂定航迹2仍在确认窗内
    call(trk, "update", 7.0, TL([]))
    check(trk.tracks[1] is None, "超过 coast 应删除")
    check(trk.tracks[2] is not None, "暂定航迹2仍在确认窗内属正常")

    # 未确认航迹超过确认窗 → 删除
    trk2 = mod("tracker").new(config["tracker"])
    call(trk2, "update", 0.0, TL([D(0, 8000, -50000)]))
    call(trk2, "update", 8.5, TL([]))
    check(len(trk2.tracks) == 0, "未确认航迹超过确认窗应删除")

    # 转向免疫（flight5 场景缩影）：世界系匀速目标连续命中
    trk3 = mod("tracker").new(config["tracker"])
    for k in range(8):
        t = 10.0 + k * 0.5
        z = -60000.0 + 300.0 * (t - 10.0)
        tracks = call(trk3, "update", t, TL([D(120000.0, 7500.0, z)]))
    tr = tracks[1]
    check(tr["hits"] == 8 and tr["misses"] == 0, "匀速目标应连续命中（hits=%d misses=%d）"
          % (tr["hits"], tr["misses"]))
    check(approx(tr["vel"]["z"], 300.0, 0.02), "速度应收敛到 300（得到 %.1f）" % tr["vel"]["z"])

    # 慢速动目标抑制：静止目标两次命中也不确认（A/A 地面交通过滤）
    trk5 = mod("tracker").new(config["tracker"])
    tracks = call(trk5, "update", 0.0, TL([D(50000, 2000, -80000)]))
    tracks = call(trk5, "update", 0.5, TL([D(50000, 2000, -80005)]))
    check(not tracks[1]["confirmed"], "慢速(10m/s)地面目标不应确认")

    # 速度自适应门 vs 物理合理性：门内但隐含相对速度超限的候选必须拒绝
    trk4 = mod("tracker").new(config["tracker"])
    call(trk4, "update", 0.0, TL([D(0, 8000, -100000)]))
    call(trk4, "update", 0.5, TL([D(0, 8000, -99900)]))      # vel→100，确认
    # dtu=0.25：门=250+250×0.25≈313；候选 300m 在门内，但隐含速度 300/0.25=1200
    # 超出 已学速度(100)+加速度容差(300) → 拒绝（相对加速度界，防近距编队串档）
    tracks = call(trk4, "update", 0.75, TL([D(300, 8000, -99825)]))
    check(tracks[1]["misses"] == 1, "隐含相对加速度超界的候选应拒绝")


@test
def t9_ledger():
    """T9 账本包含已开始但未完成的驻留；完成日志不超前"""
    sched = mod("scheduler").new(config["scheduler"], RC, T({"beam": beam}))
    spans = []

    def emit(d):
        spans.append((d["t_start"], d["t_end"]))

    call(sched, "add_track", 1, "track", 4.0, 2)
    call(sched, "set_geo", 1, 0.2, 0.0)
    rng = random.Random(7)
    total = 0.0
    max_dwell = RC["dwell_search_s"] / (math.cos(math.radians(RC["scan_cone_deg"])) ** 2)
    for _ in range(2000):
        dt = rng.choice([0.001, 0.005, 0.02, 0.05])
        call(sched, "step", dt, emit)
        total += dt
        led = sched.ledger
        booked = led["dwell_s"] + led["steer_s"]
        # 账本必须与 busy_until 一致（没有凭空记账）
        check(abs(booked - sched.busy_until) < 1e-9,
              "账本 %.9f ≠ busy_until %.9f" % (booked, sched.busy_until))
        # 因果性：已入账时间不超过"当前时刻 + 单次驻留上限 + 指向开销"
        check(booked <= total + max_dwell + 1e-4,
              "账本超支：%.6f > t+max_dwell=%.6f" % (booked, total + max_dwell))

    s = sum(e - b for b, e in spans)
    if sched.pending is not None:
        s += sched.pending["Td"]
    led = sched.ledger
    check(approx(s, led["dwell_s"], 1e-9), "逐驻留时长和 %.9f 与账本 %.9f 不一致" % (s, led["dwell_s"]))


@test
def t10_cone():
    """T10 扫描锥外任务跳过；检查实际 theta，而非 az/el 矩形"""
    sched = mod("scheduler").new(config["scheduler"], RC, T({"beam": beam}))
    out = []

    def emit(d):
        out.append(d)

    call(sched, "add_track", 1, "track", 50.0, 2)
    call(sched, "set_geo", 1, math.radians(75), math.radians(70))  # 远超 ±60°
    for _ in range(200):
        call(sched, "step", 0.01, emit)
    cone = math.radians(RC["scan_cone_deg"])
    for d in out:
        check(d["theta"] <= cone + 1e-9 and d["task_id"] != 1,
              "越界驻留 az=%.1f el=%.1f" % (math.degrees(d["az"]), math.degrees(d["el"])))


# ---------------------------------------------------------------- 冒烟：端到端
@test
def smoke_end_to_end():
    """冒烟：三目标场景——近距速袭/远距接近目标应被确认；同速悬停目标被 notch 吞掉"""
    aesa = mod("init").build(SRC)

    own = T({"pos": {"x": 0.0, "y": 0.0, "z": 8000.0},
             "vel": {"x": -200.0, "y": 0.0, "z": 0.0}})
    targets = TL([
        # 近距 40km 迎头（接近速度 500 m/s）
        T({"id": 1, "label": "F-16", "coalition": 2,
           "pos": {"x": -40000.0, "y": 0.0, "z": 8000.0},
           "vel": {"x": 300.0, "y": 0.0, "z": 0.0}}),
        # 远距 160km 迎头（首帧 Pd≈0.78，累积检测应确认）
        T({"id": 2, "label": "Su-27", "coalition": 2,
           "pos": {"x": -160000.0, "y": 0.0, "z": 8000.0},
           "vel": {"x": 300.0, "y": 0.0, "z": 0.0}}),
        # 前方 60km 低空悬停目标：v_close≈v_mlc → 主瓣杂波凹口内，不应被检测
        T({"id": 3, "label": "Helicopter", "coalition": 2,
           "pos": {"x": -60000.0, "y": 0.0, "z": 3000.0},
           "vel": {"x": 0.0, "y": 0.0, "z": 0.0}}),
    ])
    truth = helpers.truth(own, targets)
    sink = helpers.sink()

    c = aesa.new(truth, helpers.rcs_static(5.0), sink, 42)
    for _ in range(300):  # 15 s @ 5 Hz 步长
        call(c, "step", 0.05)

    final = {}
    for i in range(1, len(sink.tracks_hist) + 1):
        tbl = sink.tracks_hist[i]
        for j in range(1, len(tbl) + 1):
            tr = tbl[j]
            final[int(tr["id"])] = tr

    def has_confirmed_near(az_deg, r_km, tol_az_deg, tol_r_km):
        for tr in final.values():
            if (tr["confirmed"]
                    and abs(math.degrees(tr["az"]) - az_deg) <= tol_az_deg
                    and abs(tr["R"] / 1000.0 - r_km) <= tol_r_km):
                return True
        return False

    # 15 s 内双方接近 500 m/s：近距 40→32.5 km，远距 160→152.5 km
    check(has_confirmed_near(0, 32.5, 4, 5), "近距目标应有确认航迹")
    check(has_confirmed_near(0, 152.5, 4, 6), "远距目标应在累积检测后确认")
    check(not has_confirmed_near(0, 60, 4, 5), "凹口内悬停目标不应有确认航迹")

    # 账本一致（与 T9 同一因果性不变式）
    led = c.sched.ledger
    booked = led["dwell_s"] + led["steer_s"]
    max_dwell = RC["dwell_search_s"] / (math.cos(math.radians(RC["scan_cone_deg"])) ** 2)
    check(abs(booked - c.sched.busy_until) < 1e-9, "账本与 busy_until 不一致")
    check(booked <= c.t + max_dwell + 1e-4, "核心时间账本超支")

    # 全部驻留都在锥内
    cone = math.radians(RC["scan_cone_deg"])
    for i in range(1, len(sink.dwells) + 1):
        d = sink.dwells[i]["beam"]
        check(abs(d["az"]) <= cone + 1e-9 and abs(d["el"]) <= cone + 1e-9, "冒烟：越界驻留")


# ---------------------------------------------------------------- RCS resolver
@test
def t_rcs_provider():
    """DCS RCS resolver：官方标量优先且来源标记 ed-plaintext；未知机型分档兜底并标注估计"""
    prov = mod("dcs_rcs").new(mod("rcs_data"))

    v = call(prov, "get", "J-11A")
    check(v["source"] == "ed-plaintext" and abs(v["rcs_m2"] - 5.5) < 1e-9,
          "J-11A 应为官方值 5.5（得到 %s from %s）" % (v["rcs_m2"], v["source"]))

    v2 = call(prov, "get", "SomeUnknownFighter")
    check(v2["source"] == "fallback-estimate" and v2["rcs_m2"] == 5.0,
          "未知战斗机应兜底 5.0")

    v3 = call(prov, "get", "Mi-24V")
    check(v3["source"] == "fallback-estimate" and v3["rcs_m2"] == 6.0, "直升机应兜底 6.0")

    v5 = call(prov, "get", "AGM_65D")
    check(v5["source"] == "fallback-estimate" and abs(v5["rcs_m2"] - 0.05) < 1e-9,
          "导弹/弹药应兜底 0.05（真值量级，检测距离≈1/3）")

    v4 = call(prov, "get", "KC-135")
    check(v4["source"] == "fallback-estimate" and v4["rcs_m2"] == 25.0, "大型平台应兜底 25.0")


# ---------------------------------------------------------------- 加载器（DCS 侧同路径）
@test
def t_init_loader():
    """加载器：init.build 用 dofile 组装全部核心模块，工厂与 DCS RCS 解析端到端可用"""
    init = mod("init")
    aesa = init.build(SRC)  # 与 DCS 侧完全相同的加载方式
    for k in ("config", "constants", "physics", "beam", "detection", "geometry",
              "scheduler", "tracker", "core", "rcs", "measurement", "snapshot"):
        check(aesa[k] is not None, "build 未加载 %s" % k)
    check(aesa.config["radar"]["lambda_m"] == RC["lambda_m"],
          "init.build 应从 src/shared/config.lua 加载配置")
    check(aesa.config["scheduler"]["prf_selection"] is not None,
          "生成配置应提供 prf_selection 名字数组")

    # 注入配置：深拷贝后使用，调用方后续修改不得影响已构建实例。
    make_opts = RT.eval("function(cfg) return { config = cfg } end")
    injected_cfg = mod("config")
    injected_cfg["tracker"]["confirm_m"] = 3
    injected = init.build(SRC, make_opts(injected_cfg))
    injected_cfg["tracker"]["confirm_m"] = 4
    check(injected.config["tracker"]["confirm_m"] == 3,
          "注入配置应深拷贝（得到 %s）" % injected.config["tracker"]["confirm_m"])
    check(approx(injected.physics.snr(injected.config["radar"],
                                      T({"R": 100e3, "sigma": 5.0, "theta": 0.0,
                                         "Td": 0.010})), 357.4, 0.005),
          "注入配置应传入 constants.configure")

    # 注入配置与默认配置都必须经过 config_validate（盲带 fail-closed）。
    bad_cfg = mod("config")
    bad_cfg["scheduler"]["search"]["el_bars_deg"] = TL([-6.0, 0.0, 6.0])
    try:
        init.build(SRC, make_opts(bad_cfg))
        check(False, "注入的盲带配置应被拒绝")
    except Exception as e:  # noqa: BLE001 - lupa 透传 Lua error
        check("blind band" in str(e).lower(), "错误信息应说明盲带: %s" % e)

    prov = mod("dcs_rcs").new(mod("rcs_data"))
    v = call(prov, "get", "J-11A")
    check(v["source"] == "ed-plaintext" and abs(v["rcs_m2"] - 5.5) < 1e-9,
          "DCS 解析器应返回官方值")

    own = T({"pos": {"x": 0.0, "y": 0.0, "z": 8000.0},
             "vel": {"x": -200.0, "y": 0.0, "z": 0.0}})
    targets = TL([T({"id": 1, "label": "F-16", "coalition": 2,
                     "rcs_m2": call(prov, "get", "F-16")["rcs_m2"],
                     "pos": {"x": -40000.0, "y": 0.0, "z": 8000.0},
                     "vel": {"x": 300.0, "y": 0.0, "z": 0.0}})])
    sink = helpers.sink()
    c = aesa.new(helpers.truth(own, targets), aesa.rcs.passthrough(), sink, 7)
    for _ in range(60):
        call(c, "step", 0.05)
    check(len(sink.dwells) > 0, "应有驻留输出")
    check(c.sched.ledger["count"] > 0, "账本应有记录")


# ---------------------------------------------------------------- 阶段二：数据层
@test
def t_export_sampler():
    """采样脚本：注入 stub Lo* → 帧行格式/分帧/字段清洗正确"""
    runtime = (
        "AESA_RUNTIME = {"
        " export = assert(dofile('%s')),"
        " socket = assert(dofile('%s')),"
        " profile = assert(dofile('%s')),"
        " profile_data = assert(dofile('%s')) }"
    ) % tuple(
        os.path.join(ROOT, relative).replace("\\", "/")
        for relative in (
            "src/adapters/dcs/api/export.lua",
            "src/adapters/dcs/api/socket.lua",
            "src/adapters/dcs/compat/profile.lua",
            "src/adapters/dcs/compat/profiles/dcs-2.9.30.28738-mt.lua",
        )
    )
    RT.execute(runtime)
    export = load_lua(os.path.join(ROOT, "src", "export", "aesa_export.lua"), "aesa_export")
    make_lo = RT.eval("""
        function()
          return {
            LoGetSelfData = function()
              return { Name = 'F-16C bl.50', Position = { x = 1, y = 2, z = 3 },
                       Heading = 0.1, Pitch = 0.2, Bank = 0.3 }
            end,
            LoGetVectorVelocity = function()
              return { x = 0, y = 0, z = -200 }
            end,
            LoGetWorldObjects = function()
              return { [123] = { Name = 'F-16C_50', CoalitionID = 2,
                                 Position = { x = 10, y = 20, z = 30 } } }
            end,
            LoGetTargetInformation = function()
              return { { ID = 123, distance = 40000, convergence_velocity = 500,
                         reflection = 5, flags = 34 } }
            end,
          }
        end
    """)
    mkcollect = RT.eval(
        "function() local t = {} "
        "local f = function(s) t[#t+1] = s end "
        "return t, f end")
    lines, send = mkcollect()
    lo = make_lo()
    adapter = RT.eval(
        "function(env) return AESA_RUNTIME.export.new(env) end")(lo)
    n = export.sample(12.5, adapter, send)
    check(n >= 3, "应至少发出 A/T/E 三行，得到 %d" % n)
    all_lines = [lines[i] for i in range(1, len(lines) + 1)]
    a = [ln for ln in all_lines if ln.startswith("A ")][0]
    parts = a.split()
    check(parts[1] == "12.500" and parts[2] == "F-16C_bl.50", "A 行格式: %s" % a)
    t_line = [ln for ln in all_lines if ln.startswith("T ")][0]
    tp = t_line.split()
    check(tp[2] == "123" and tp[3] == "F-16C_50", "T 行: %s" % t_line)
    e = [ln for ln in all_lines if ln.startswith("E ")][0]
    ep = e.split()
    check(ep[2] == "123" and ep[3] == "40000.000", "E 行: %s" % e)
    # 解析端回读一致性
    from receiver import parse_line
    for ln in all_lines:
        if ln[:1] in ("A", "T", "E"):
            kind, _f = parse_line(ln)
            check(kind == ln[:1], "解析失败: %s" % ln)


@test
def t_truth_replay():
    """回放真值源：DCS→ENU 转换 / 线性插值 / 越界 clamp / 单帧目标保持"""
    def opts():
        o = T({})
        o["frame"] = mod("frame")
        return o

    frames = TL([
        T({"t": 0.0,
           "own": {"typeName": "OWN", "pos": {"x": 0, "y": 0, "z": 0}, "vel": {"x": 0, "y": 0, "z": -10}},
           "targets": [{"id": "1", "typeName": "F-16", "coalition": 2, "visible": False,
                        "pos": {"x": 0, "y": 0, "z": -1000}, "vel": {"x": 0, "y": 0, "z": 50}}]}),
        T({"t": 1.0,
           "own": {"typeName": "OWN", "pos": {"x": 0, "y": 0, "z": -10}, "vel": {"x": 0, "y": 0, "z": -10}},
           "targets": [{"id": "1", "typeName": "F-16", "coalition": 2, "visible": False,
                        "pos": {"x": 0, "y": 0, "z": -950}, "vel": {"x": 0, "y": 0, "z": 50}}]}),
    ])
    tr = mod("truth_replay").new(frames, opts())
    own = call(tr, "ownship", 0.5)
    check(approx(own["pos"]["x"], -5.0, 1e-9), "本机位置插值 east=%.3f" % own["pos"]["x"])
    tgs = call(tr, "targets", 0.5)
    check(len(tgs) == 1 and approx(tgs[1]["pos"]["x"], -975.0, 1e-9),
          "目标位置插值 east=%.3f" % tgs[1]["pos"]["x"])
    check(tgs[1]["blocked"] is True, "visible=false 应转换为 blocked=true")
    own2 = call(tr, "ownship", 99.0)
    check(approx(own2["pos"]["x"], -10.0, 1e-9), "越界 clamp 到末帧")

    frames3 = TL([
        T({"t": 0.0, "own": {"pos": {"x": 0, "y": 0, "z": 0}, "vel": {"x": 0, "y": 0, "z": 0}},
           "targets": [{"id": "9", "typeName": "X", "coalition": 0,
                        "pos": {"x": 5, "y": 5, "z": 5}, "vel": {"x": 0, "y": 0, "z": 0}}]}),
        T({"t": 1.0, "own": {"pos": {"x": 0, "y": 0, "z": 0}, "vel": {"x": 0, "y": 0, "z": 0}},
           "targets": []}),
    ])
    tr3 = mod("truth_replay").new(frames3, opts())
    tgs3 = call(tr3, "targets", 0.5)
    check(len(tgs3) == 1 and tgs3[1]["pos"]["x"] == 5.0, "单帧出现的目标保持该帧值")
    check(tgs3[1]["label"] == "X" and tgs3[1]["blocked"] is None,
          "目标应输出核心 label/blocked 契约")


@test
def t_install_export():
    """部署脚本：安装/共存/备份/修复/卸载全生命周期（临时目录）"""
    import tempfile
    scripts_dir = os.path.join(ROOT, "scripts")
    if scripts_dir not in sys.path:
        sys.path.insert(0, scripts_dir)
    import install_export as ie

    with tempfile.TemporaryDirectory() as tmp:
        root = os.path.join(tmp, "DCS")
        os.makedirs(os.path.join(root, "Scripts"))
        exp = os.path.join(root, "Scripts", "Export.lua")
        with open(exp, "w", encoding="utf-8") as f:
            f.write("-- SRS stuff\ndofile('srs.lua')\n")

        check(not ie.install(root), "安装后校验应无问题: %s" % ie.verify(root))
        text = open(exp, encoding="utf-8").read()
        check("dofile('srs.lua')" in text and ie.BLOCK_BEGIN in text,
              "外部内容必须保留且标记块存在")
        check(os.path.exists(exp + ".bak-aesa"), "首次修改应有备份")

        broken = "old junk " + ie.BLOCK_BEGIN + "\nbroken\n"
        with open(exp, "w", encoding="utf-8") as f:
            f.write(broken)
        check(ie.repair(root), "残缺标记应拒绝自动修复")
        check(open(exp, encoding="utf-8").read() == broken, "拒绝时保留现场")
        with open(exp, "w", encoding="utf-8") as f:
            f.write("-- user update\n" + text)
        check(not ie.repair(root), "修复后校验应无问题: %s" % ie.verify(root))

        check(not ie.uninstall(root), "卸载自检应无问题")
        text = open(exp, encoding="utf-8").read()
        check(ie.BLOCK_BEGIN not in text and "user update" in text and "srs.lua" in text, "卸载精确移除标记块")
        check(not os.path.exists(os.path.join(root, "Scripts", "AESA", "aesa_export.lua")), "已部署脚本应清除，备份保留")


@test
def t_replay_pipeline():
    """端到端：合成录制 → 协议解析 → truth_replay → 阶段一核心 → 航迹；引擎行计数一致"""
    import tempfile
    tools_dir = os.path.join(ROOT, "tools")
    if tools_dir not in sys.path:
        sys.path.insert(0, tools_dir)
    from receiver import load_recording

    def gen(path):
        own_p = (0.0, 8000.0, 0.0)
        own_v = (0.0, 0.0, -200.0)
        tgts = [("1", "F-16", (0.0, 8000.0, -40000.0), (0.0, 0.0, 300.0)),
                ("2", "Su-27", (0.0, 8000.0, -160000.0), (0.0, 0.0, 300.0)),
                ("3", "Helicopter", (0.0, 3000.0, -60000.0), (0.0, 0.0, 0.0))]
        with open(path, "w", encoding="utf-8") as f:
            t = 0.0
            while t <= 15.0 + 1e-9:
                op = tuple(own_p[i] + own_v[i] * t for i in range(3))
                f.write("A %.3f F-16C_50 %s %s %s %s %s %s\n" % ((t,) + op + own_v))
                for tid, tn, p0, v in tgts:
                    p = tuple(p0[i] + v[i] * t for i in range(3))
                    f.write("T %.3f %s %s 2 %s %s %s %s %s %s\n" % ((t, tid, tn) + p + v))
                p = tuple(tgts[0][2][i] + tgts[0][3][i] * t for i in range(3))
                r = sum((p[i] - op[i]) ** 2 for i in range(3)) ** 0.5
                f.write("E %.3f 1 %s %s %s %.3f 500.000 5.000 34\n" % ((t,) + p + (r,)))
                t += 0.1

    with tempfile.TemporaryDirectory() as tmp:
        rec = os.path.join(tmp, "flight.aesarec")
        gen(rec)
        frames, engine, _probe, _proto = load_recording(rec)
        check(len(frames) == 151, "帧数 %d（期望 151）" % len(frames))
        check(len(engine) == 151, "引擎接触 %d（期望 151）" % len(engine))
        check(approx(frames[75]["own"]["pos"][2], -200.0 * 7.5, 1e-6), "录制解析含速度修补检查基准")

        def v3(x):
            return {"x": x[0], "y": x[1], "z": x[2]}
        lframes = []
        for fr in frames:
            tgs = [T({"id": tg["id"], "typeName": tg["typeName"], "coalition": tg["coalition"],
                      "pos": v3(tg["pos"]), "vel": v3(tg["vel"])}) for tg in fr["targets"]]
            lframes.append(T({"t": fr["t"],
                              "own": T({"typeName": fr["own"]["typeName"],
                                        "pos": v3(fr["own"]["pos"]), "vel": v3(fr["own"]["vel"])}),
                              "targets": TL(tgs)}))
        opts = T({"legacy_heading": True})
        opts["frame"] = mod("frame")
        opts["rcs"] = mod("dcs_rcs").new(mod("rcs_data"))
        truth = mod("truth_replay").new(TL(lframes), opts)
        sink = helpers.sink()
        aesa = mod("init").build(SRC)
        c = aesa.new(truth, aesa.rcs.passthrough(), sink, 42)
        for _ in range(300):
            call(c, "step", 0.05)

        final = {}
        for i in range(1, len(sink.tracks_hist) + 1):
            tbl = sink.tracks_hist[i]
            for j in range(1, len(tbl) + 1):
                trk = tbl[j]
                final[int(trk["id"])] = trk

        def has_conf_near(az_deg, r_km, tol_az, tol_r):
            for trk in final.values():
                if (trk["confirmed"]
                        and abs(math.degrees(trk["az"]) - az_deg) <= tol_az
                        and abs(trk["R"] / 1000.0 - r_km) <= tol_r):
                    return True
            return False

        check(has_conf_near(0, 32.5, 4, 5), "近距目标应有确认航迹")
        check(has_conf_near(0, 152.5, 4, 6), "远距目标应累积确认")
        check(not has_conf_near(0, 60, 4, 5), "凹口内悬停目标不应有确认航迹")

        det1 = 0
        for i in range(1, len(sink.dwells) + 1):
            d = sink.dwells[i]
            for j in range(1, len(d["detection"]["targets"]) + 1):
                r2 = d["detection"]["targets"][j]
                if r2["id"] == "1" and r2["detected"]:
                    det1 += 1
        check(det1 >= 15, "15s 中目标1 检测次数 %d 应足以持续跟踪；PRF notch 会造成正常漏检" % det1)


@test
def t_prf_near():
    """PRF 管理：近距(≤8km)跟踪任务切 HPRF，穿透 MPRF 的 750m 最小距离盲区"""
    own = T({"pos": {"x": 0.0, "y": 0.0, "z": 8000.0},
             "vel": {"x": -350.0, "y": 0.0, "z": 0.0}})
    targets = TL([T({"id": "wing", "label": "F-16", "coalition": 2, "rcs_m2": 5.0,
                     "pos": {"x": -2000.0, "y": 0.0, "z": 8000.0},
                     "vel": {"x": -100.0, "y": 0.0, "z": 0.0}})])
    truth = helpers.truth(own, targets)
    sink = helpers.sink()
    aesa = mod("init").build(SRC)
    c = aesa.new(truth, aesa.rcs.passthrough(), sink, 42)
    for _ in range(120):                       # 6 s：R 2000→500，穿越 MPRF 750m 盲区窗口
        call(c, "step", 0.05)

    conf = [t for _, t in c.trk.tracks.items() if t["confirmed"]]
    check(len(conf) == 1, "近距追击目标应形成确认航迹（得到 %d 条）" % len(conf))
    check(300 <= conf[0]["R"] <= 900,
          "6s 后航迹距离应 0.3~0.9km 且持续跟踪（得到 %.0f m）" % conf[0]["R"])
    # 回访驻留必须是 HPRF 且有检测（同几何下 MPRF 在 750m 内会因最小距离盲区漏检）
    hits = {"HPRF": 0, "MPRF": 0}
    for i in range(1, len(sink.dwells) + 1):
        d = sink.dwells[i]
        beam = d["beam"]
        if beam["purpose"] == "track" and d["detection"]["n"] > 0:
            hits[beam["prf"]] = hits.get(beam["prf"], 0) + 1
    total = sum(hits.values())
    check(total > 12, "近距跟踪应有充足检测驻留（%s）" % hits)
    check(hits.get("HPRF", 0) >= 3 and hits.get("MPRF", 0) >= 3,
          "PRF stagger 应两种波形都有检测（%s）" % hits)


# ---------------------------------------------------------------- 阶段三 3a：实时显示器
@test
def t_truth_append():
    """truth_replay 增量追加：append 后查询区间延伸、索引同步可用（live 喂数依赖）"""
    opts = T({})
    opts["frame"] = mod("frame")
    f1 = T({"t": 0.0,
            "own": {"typeName": "OWN", "pos": {"x": 0, "y": 0, "z": 0}, "vel": {"x": 0, "y": 0, "z": -10}},
            "targets": [{"id": "1", "typeName": "F-16", "coalition": 2,
                         "pos": {"x": 0, "y": 0, "z": -1000}, "vel": {"x": 0, "y": 0, "z": 50}}]})
    frames = TL([f1])
    tr = mod("truth_replay").new(frames, opts)
    own = call(tr, "ownship", 5.0)
    check(own["pos"]["x"] == 0.0, "追加前越界应 clamp 在首帧")
    call(tr, "append", T({"t": 10.0,
                          "own": {"typeName": "OWN", "pos": {"x": 0, "y": 0, "z": -100},
                                  "vel": {"x": 0, "y": 0, "z": -10}},
                          "targets": [{"id": "1", "typeName": "F-16", "coalition": 2,
                                       "pos": {"x": 0, "y": 0, "z": -500},
                                       "vel": {"x": 0, "y": 0, "z": 50}}]}))
    own = call(tr, "ownship", 5.0)
    check(approx(own["pos"]["x"], -50.0, 1e-9), "追加后中点插值 east=%.3f（期望 -50）" % own["pos"]["x"])
    tgs = call(tr, "targets", 5.0)
    check(approx(tgs[1]["pos"]["x"], -750.0, 1e-9), "目标插值 east=%.3f（期望 -750）" % tgs[1]["pos"]["x"])
    own2 = call(tr, "ownship", 12.0)
    check(approx(own2["pos"]["x"], -100.0, 1e-9), "越界 clamp 到新末帧")


@test
def t_timebase():
    """时间基准回归：录制从任务中段（t0=1000）开始时，回放必须归一化到 0，
    否则 truth_replay 整段 clamp 在首帧（静止真值上假跑出航迹）。"""
    import lua_host
    import truth as truth_mod

    t0 = 1000.0
    own_p, own_v = (0.0, 8000.0, 0.0), (0.0, 0.0, -200.0)
    tg_p, tg_v = (0.0, 8000.0, -60000.0), (0.0, 0.0, 300.0)
    frames = []
    k = 0
    while k <= 150:                      # 15 s @10Hz
        t = t0 + k * 0.1
        frames.append({
            "t": t,
            "own": {"typeName": "F-16C_50",
                    "pos": tuple(own_p[i] + own_v[i] * (t - t0) for i in range(3)),
                    "vel": own_v},
            "targets": [{"id": "1", "typeName": "F-16", "coalition": 2,
                         "pos": tuple(tg_p[i] + tg_v[i] * (t - t0) for i in range(3)),
                         "vel": tg_v}]})
        k += 1
    host = lua_host.Host()
    lframes = truth_mod.to_lua_frames(host, frames)
    check(abs(lframes[1]["t"] - 0.0) < 1e-9, "首帧应归一化到 0")
    check(abs(lframes[len(lframes)]["t"] - 15.0) < 1e-6, "末帧应为跨度 15s")

    opts = host.T({"legacy_heading": True})
    opts["frame"] = host.mod("frame")
    opts["rcs"] = host.mod("dcs_rcs").new(host.mod("rcs_data"))
    truth_src = host.mod("truth_replay").new(lframes, opts)
    sink = host.RT.eval(
        "function() local s = { dwells = {}, tracks_hist = {} }"
        " function s:on_dwell(d) s.dwells[#s.dwells + 1] = d end"
        " function s:on_tracks(tracks, ordered) s.tracks_hist[#s.tracks_hist + 1] = tracks end"
        " return s end")()
    aesa = host.build()
    c = aesa.new(truth_src, host.mod("rcs").passthrough(), sink, 42)
    for _ in range(300):
        host.call(c, "step", 0.05)

    # 判别器：真值必须随时间运动——目标1 距离从 60km 接近到 52.5km。
    # clamp 假象下所有检测的 R 恒定（差值≈0）。
    rmin, rmax = 1e30, -1e30
    for i in range(1, len(sink.dwells) + 1):
        d = sink.dwells[i]
        for j in range(1, len(d["detection"]["targets"]) + 1):
            rec = d["detection"]["targets"][j]
            meas = d["measurement"]["targets"][j]
            if rec["id"] == "1" and rec["detected"]:
                rmin = min(rmin, meas["range_m"])
                rmax = max(rmax, meas["range_m"])
    check(rmax - rmin > 4000.0,
          "目标1 检测距离应随运动变化（跨 %.0f m；clamp 假象下≈0）" % (rmax - rmin))
    final = {}
    for i in range(1, len(sink.tracks_hist) + 1):
        tbl = sink.tracks_hist[i]
        for j in range(1, len(tbl) + 1):
            trk = tbl[j]
            final[int(trk["id"])] = trk
    ok = any(t["confirmed"] for t in final.values())
    check(ok, "归一化后应形成确认航迹")


@test
def t_live_offline():
    """live.LiveCore 离线管道：合成帧（目标速度缺失→差分修补）→ 核心步进 → 快照结构完整"""
    import live

    core = live.LiveCore(seed=42)
    own_p, own_v = (0.0, 8000.0, 0.0), (0.0, 0.0, -200.0)
    frames = []
    k = 0
    while k <= 200:                      # 20 s @10Hz，t 从 500 开始（验证归一化）
        t = 500.0 + k * 0.1
        # 目标给零速度（LiveCore.vel_patcher 差分补出）；DCS 轴向 +Z 300 m/s
        # → 转 ENU 后 +east；合上本机 -east 200 m/s，接近速度 ≈500 m/s
        tp = (0.0, 8000.0, -60000.0 + 300.0 * (t - 500.0))
        frames.append({
            "t": t,
            "own": {"typeName": "F-16C_50",
                    "pos": tuple(own_p[i] + own_v[i] * (t - 500.0) for i in range(3)),
                    "vel": own_v},
            "targets": [{"id": "7", "typeName": "F-16", "coalition": 2,
                         "pos": tp, "vel": (0.0, 0.0, 0.0)}]})
        k += 1
    for f in frames:
        core.feed(f)

    snap = core.snapshot({"connected": True, "lines": 0, "engine": 0,
                          "sessions": 1, "source": "live", "eof": False})
    for key in ("t", "wall", "cfg", "link", "own", "beam", "beam_trail",
                "raster", "sched", "tracks", "truth"):
        check(key in snap, "快照缺字段 %s" % key)
    check(19.0 < snap["t"] <= 20.0, "核心时间应为归一化跨度（得到 %.2f）" % snap["t"])
    check(snap["own"]["type"] == "F-16C_50" and snap["own"]["speed_ms"] > 199,
          "本机状态错误: %s" % snap["own"])
    check(snap["beam"] is not None and snap["beam"]["purpose"] in
          ("search", "track", "stt"), "波束快照缺失: %s" % snap["beam"])
    check(len(snap["beam_trail"]) > 10, "波束轨迹过短: %d" % len(snap["beam_trail"]))
    check(snap["raster"]["count"] > 0 and 1 <= snap["raster"]["idx"] <= snap["raster"]["count"],
          "光栅进度错误: %s" % snap["raster"])
    check(0.0 < snap["sched"]["duty"] <= 1.0 + 1e-9, "占空比异常: %s" % snap["sched"])
    confirmed = [t for t in snap["tracks"] if t["confirmed"]]
    check(len(confirmed) >= 1, "20s 接近目标应形成确认航迹: %s" % snap["tracks"])
    tr = confirmed[0]
    check(tr["vr_mps"] is not None and tr["vr_mps"] > 400,
          "差分修补后的接近速度应≈500（得到 %s）" % tr["vr_mps"])
    check(len(snap["truth"]) == 1 and snap["truth"][0]["range_km"] < 60.0,
          "真值叠加层错误: %s" % snap["truth"])
    # 世界坐标跟踪档案（ENU）：本机 (0,0,8000)，目标正西 50km → 世界 ≈(-54000,0,8000)
    check(snap["own"]["pos"] is not None and len(snap["own"]["pos"]) == 3,
          "own.pos 缺失: %s" % snap["own"])
    check(tr.get("east_m") is not None and abs(tr["east_m"] + 54000.0) < 300.0,
          "航迹世界 east 应≈-54000（得到 %s）" % tr.get("east_m"))
    check(abs(tr.get("north_m") or 0) < 500.0,
          "航迹世界 north 应≈0（得到 %s）" % tr.get("north_m"))
    check(abs((tr.get("up_m") or 0) - 8000.0) < 300.0,
          "航迹世界 up 应≈8000（得到 %s）" % tr.get("up_m"))
    # 航迹档案速度：目标真实速度 300 m/s（+east），20s 回访后应收敛
    check(250 < (tr.get("speed_ms") or 0) < 350,
          "航迹速度应收敛到 ~300（得到 %s）" % tr.get("speed_ms"))
    check(tr.get("ve_mps") is not None and tr.get("vu_mps") is not None,
          "航迹速度分量缺失（速度矢量线原料）")
    check(tr.get("iff") == "friend", "IFF 应答机假设：同阵营目标应标 friend（得到 %s）" % tr.get("iff"))


@test
def t_live_http():
    """live HTTP/SSE 服务：首页可取、SSE 流可推快照（无 Lua 依赖，假状态即可）"""
    import live as livemod
    from http.server import ThreadingHTTPServer
    state = {"lock": threading.Lock(),
             "snap": {"t": 1.5, "wall": time.time(), "tracks": [], "truth": [],
                      "beam_trail": [], "beam": None, "raster": {}, "sched": {},
                      "own": {}, "cfg": {}, "link": {}}}
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), livemod.make_handler(state))
    httpd.daemon_threads = True
    port = httpd.server_address[1]
    th = threading.Thread(target=httpd.serve_forever, daemon=True)
    th.start()
    try:
        import urllib.request
        with urllib.request.urlopen("http://127.0.0.1:%d/" % port, timeout=5) as r:
            body = r.read()
        check(b"AESA LIVE" in body and b"EventSource" in body, "首页内容异常")

        s = socket.create_connection(("127.0.0.1", port), timeout=5)
        s.settimeout(5)
        s.sendall(b"GET /stream HTTP/1.1\r\nHost: t\r\n\r\n")
        got = b""
        while b"data: " not in got:
            chunk = s.recv(4096)
            if not chunk:
                break
            got += chunk
        s.close()
        check(b"200" in got.split(b"\r\n", 1)[0], "SSE 应答行: %s" % got[:40])
        check(b"text/event-stream" in got, "SSE Content-Type 缺失")
        check(b'"t":1.5' in got or b'"t": 1.5' in got, "SSE 应推出快照 JSON")
    finally:
        httpd.shutdown()
        httpd.server_close()



# ---------------------------------------------------------------- 运行
def main():
    failed = 0
    for fn in TESTS_ALL:
        name = fn.__name__
        try:
            fn()
            print("PASS  %s" % name)
        except AssertionError as e:
            failed += 1
            print("FAIL  %s: %s" % (name, e))
        except Exception as e:  # noqa: BLE001
            failed += 1
            print("ERROR %s: %r" % (name, e))
    total = len(TESTS_ALL)
    print("---- %d/%d passed" % (total - failed, total))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

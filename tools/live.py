# -*- coding: utf-8 -*-
"""aesa 阶段三 3a：实时显示器 —— 接收 DCS 导出流 + 核心实时步进 + 本地网页查看器。

用法：
  实时（DCS 侧 Export 脚本自动连入，可同时录制）：
      python tools/live.py --record recordings/flightN.aesarec
  回放录制文件驱动同一查看器（--speed 0 = 尽快；默认 1.0 = 实时节奏）：
      python tools/live.py --replay recordings/flight3-final.aesarec
  同时把核心快照写成座舱状态文件（C1.5a 桥，~10 Hz，供座舱 controller 读）：
      python tools/live.py --replay recordings/flight3-final.aesarec --speed 0 \
          --cockpit-state "<tmp 或 Saved Games>/Scripts/AESA-COCKPIT/state.txt"

然后浏览器打开 http://127.0.0.1:3591/。
线程模型（重要）：lupa 的 LuaRuntime 非线程安全——只有主线程触碰 Lua；
  TCP/回放线程只往队列塞 Python 帧；HTTP 线程只读主线程产出的 Python 快照。
"""
import json
import os
import queue
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import ingest
import lua_host
import protocol
import truth

TOOLS = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(TOOLS)

VIEWER = os.path.join(TOOLS, "viewer", "index.html")
# Ports are owned by spec/protocol.json; read them instead of keeping a second
# copy in this dev CLI.
with open(os.path.join(REPO, "spec", "protocol.json"), encoding="utf-8") as _f:
    _SPEC = json.load(_f)
EXPORT_PORT = _SPEC["ports"]["aa_export"]     # DCS Export 脚本连入（与 receiver.py 相同）
HTTP_PORT = _SPEC["ports"]["aa_http"]         # 查看器网页 + SSE
MAX_STEP = 1.0         # 分段步进上限；完整推进帧间隔，不丢弃仿真时间


class LiveCore:
    """帧 → 增量速度修补 → 归一化时间 → 追加 Lua 真值表 → 核心步进 → 快照。
    仅允许主线程调用（LuaRuntime 非线程安全）。"""

    def __init__(self, seed=42, own_coalition=2, legacy_heading=True):
        self.seed = seed
        self.own_coalition = own_coalition
        self.legacy_heading = legacy_heading
        self.host = lua_host.Host()
        self.aesa = self.host.build()
        self.rcs = self.host.dcs_rcs()
        self.sink = self.host.noop_sink()
        self.lua_frames = self.host.TL([])
        self.truth = self._truth()
        self.core = self._core()

        self.t0 = None          # 时间基准（首帧任务时刻）
        self.prev_t = None      # 已步进到的归一化时刻
        self.last_frame = None  # 最近一帧（Python dict，速度已修补）
        self.vel_patcher = ingest.VelocityPatcher()
        self.frames_fed = 0
        self.last_feed_wall = None  # 最近一帧到达的墙钟时刻（座舱桥 valid 判定用）
        self.hz = 0.0
        self._hz_last = (time.time(), 0)

    def _truth(self):
        opts = self.host.T({"legacy_heading": self.legacy_heading})
        opts["rcs"] = self.rcs
        opts["frame"] = self.host.mod("frame")
        return self.host.mod("truth_replay").new(self.lua_frames, opts)

    def _core(self):
        return self.aesa.new(self.truth, self.host.mod("rcs").passthrough(),
                             self.sink, self.seed,
                             self.host.T({"own_coalition": self.own_coalition}))

    def set_proto(self, version):
        """PROTO,2 到达时（首帧前）切换到原始 DCS 航向。"""
        legacy = truth.legacy_for(version)
        if legacy == self.legacy_heading or self.frames_fed:
            return False
        self.legacy_heading = legacy
        self.truth = self._truth()
        self.core = self._core()
        return True

    def feed(self, frame):
        t = frame["t"]
        if self.t0 is not None and self.prev_t is not None and t - self.t0 <= self.prev_t:
            return  # 重复/倒序帧不破坏插值时间轴；新任务由 V1 重建核心
        own = frame["own"]
        own["vel"] = self.vel_patcher.patch("own", t, own["pos"], own["vel"],
                                            own.get("vel_valid"))
        for tg in frame["targets"]:
            tg["vel"] = self.vel_patcher.patch(("tg", tg["id"]), t, tg["pos"], tg["vel"],
                                               tg.get("vel_valid"))

        if self.t0 is None:
            self.t0 = t
        tn = t - self.t0
        self.host.call(self.truth, "append",
                       truth.to_lua_frame(self.host, frame, tn))
        if self.prev_t is not None and tn > self.prev_t:
            remaining = tn - self.prev_t
            while remaining > 1e-12:
                step = min(remaining, MAX_STEP)
                self.host.call(self.core, "step", step)
                remaining -= step
        self.prev_t = tn
        self.last_frame = frame
        self.frames_fed += 1
        self.last_feed_wall = time.time()

        now = time.time()
        dtw = now - self._hz_last[0]
        if dtw >= 1.0:
            self.hz = (self.frames_fed - self._hz_last[1]) / dtw
            self._hz_last = (now, self.frames_fed)

    def snapshot(self, link):
        compat = link.get("compat") if isinstance(link, dict) else None
        snap = self.host.to_python(self.host.call(self.core, "snapshot"))
        snap["wall"] = time.time()
        snap["compat"] = dict(compat) if isinstance(compat, dict) else None
        snap["link"] = dict(link, hz=round(self.hz, 1), frames=self.frames_fed)
        return snap


# ---------------------------------------------------------------- 数据来源线程
def tcp_feed(port, q, stats, record_path=None):
    """TCP 接收线程：V1 切会话、PROTO 声明坐标版本、行缓冲录制。"""
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", port))
    srv.listen(1)
    stats["source"] = "live"
    rec = open(record_path, "a", encoding="utf-8", buffering=1) if record_path else None
    try:
        while True:
            conn, addr = srv.accept()
            print("export connected: %s:%d" % addr)
            stats["connected"] = True
            conn.settimeout(30)
            buf = protocol.FrameBuffer()
            try:
                fp = conn.makefile("r", encoding="utf-8", errors="replace")
                for line in fp:
                    line = line.rstrip("\n")
                    if not line:
                        continue
                    if rec:
                        rec.write(line + "\n")
                    if line == "V1" or line.startswith("V1 "):
                        stats["sessions"] += 1
                        stats["compat"] = None     # 新会话重新等待 COMPAT 握手
                        stats["proto"] = None
                        buf = protocol.FrameBuffer()
                        q.put(("reset", None))     # 新任务：核心清零重建
                        continue
                    stats["lines"] += 1
                    if line.startswith("PROTO,"):
                        parsed = protocol.parse_line(line)
                        if parsed:
                            stats["proto"] = parsed[1]["version"]
                            q.put(("proto", parsed[1]["version"]))
                    elif line.startswith("COMPAT,"):
                        parsed = protocol.parse_line(line)
                        if parsed:
                            stats["compat"] = parsed[1]
                    buf.feed(line)
                    if line.startswith("A") and buf.frames:
                        q.put(("frame", buf.frames[-1]))
                        stats["engine"] = len(buf.engine)
            except (socket.timeout, TimeoutError, OSError):
                pass  # 30s 无数据或连接错误：按断开处理（DCS 侧 2s 自动重连）
            finally:
                try:
                    conn.close()
                except OSError:
                    pass
            stats["connected"] = False
            print("export disconnected. frames=%d engine_contacts=%d"
                  % (len(buf.frames), len(buf.engine)))
    finally:
        stats["connected"] = False
        if rec:
            rec.close()
        srv.close()


def replay_feed(path, speed, q, stats):
    """回放线程：选时间跨度最大的会话，按 speed 倍速喂帧。"""
    sessions = [s for s in ingest.load_sessions(path) if len(s.frames) >= 2]
    if not sessions:
        print("录制为空或无有效会话")
        stats["eof"] = True
        return
    session = max(sessions, key=lambda s: s.frames[-1]["t"] - s.frames[0]["t"])
    frames, engine, probe, proto = session
    stats.update(source="replay", connected=True, engine=len(engine),
                 compat=ingest.load_compat(path), proto=proto)
    print("回放: %d 帧 %.1fs 引擎接触 %d 条%s speed=%s"
          % (len(frames), frames[-1]["t"] - frames[0]["t"], len(engine),
             ("，探针: " + probe) if probe else "", speed))
    q.put(("proto", proto))
    t_sim0 = frames[0]["t"]
    w0 = time.monotonic()
    for f in frames:
        if speed > 0:
            while True:
                remain = (f["t"] - t_sim0) / speed - (time.monotonic() - w0)
                if remain <= 0:
                    break
                time.sleep(min(remain, 0.2))
        q.put(("frame", f))
    stats["connected"] = False
    stats["eof"] = True
    print("回放结束")


# ---------------------------------------------------------------- HTTP / SSE
def make_handler(state):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):  # 静默访问日志
            pass

        def do_GET(self):
            if self.path in ("/", "/index.html"):
                try:
                    with open(VIEWER, "rb") as f:
                        body = f.read()
                except OSError:
                    self.send_error(500, "viewer missing")
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            elif self.path.startswith("/stream"):
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "close")
                self.close_connection = True
                self.end_headers()
                try:
                    self.wfile.write(b"retry: 2000\n\n")
                    self.wfile.flush()
                    last = None
                    while True:
                        with state["lock"]:
                            snap = state["snap"]
                        if snap is not last:
                            self.wfile.write(b"data: " + json.dumps(
                                snap, ensure_ascii=False, separators=(",", ":")).encode()
                                + b"\n\n")
                            self.wfile.flush()
                            last = snap
                        time.sleep(0.1)
                except (BrokenPipeError, ConnectionResetError, OSError):
                    return
            else:
                self.send_error(404)

    return Handler


# ---------------------------------------------------------------- 主循环
def main():
    args = sys.argv[1:]
    opt = {"record": None, "port": EXPORT_PORT, "http": HTTP_PORT,
           "replay": None, "speed": 1.0, "seed": 42, "coalition": 2,
           "cockpit_state": None}
    i = 0
    while i < len(args):
        if args[i] == "--record":
            i += 1
            opt["record"] = args[i]
        elif args[i] == "--port":
            i += 1
            opt["port"] = int(args[i])
        elif args[i] == "--http":
            i += 1
            opt["http"] = int(args[i])
        elif args[i] == "--replay":
            i += 1
            opt["replay"] = args[i]
        elif args[i] == "--speed":
            i += 1
            opt["speed"] = float(args[i])
        elif args[i] == "--seed":
            i += 1
            opt["seed"] = int(args[i])
        elif args[i] == "--cockpit-state":
            i += 1
            opt["cockpit_state"] = args[i]
        elif args[i] == "--red":
            opt["coalition"] = 1
        else:
            print(__doc__)
            return 2
        i += 1

    state = {"lock": threading.Lock(), "snap": None}
    stats = {"connected": False, "lines": 0, "engine": 0, "sessions": 0,
             "source": "live", "eof": False, "compat": None, "proto": None}
    q = queue.Queue()

    if opt["replay"]:
        threading.Thread(target=replay_feed,
                         args=(opt["replay"], opt["speed"], q, stats),
                         daemon=True).start()
    else:
        threading.Thread(target=tcp_feed,
                         args=(opt["port"], q, stats, opt["record"]),
                         daemon=True).start()

    httpd = ThreadingHTTPServer(("127.0.0.1", opt["http"]), make_handler(state))
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    core = LiveCore(opt["seed"], opt["coalition"])
    writer = None
    if opt["cockpit_state"]:
        import cockpit_bridge  # 仅 --cockpit-state 时加载；默认路径行为不变
        writer = cockpit_bridge.StateWriter(opt["cockpit_state"])
        print("cockpit state: %s (~%.0f Hz)" % (opt["cockpit_state"],
                                                cockpit_bridge.WRITE_HZ))
    url = "http://127.0.0.1:%d/" % opt["http"]
    print("viewer: %s   (Ctrl-C 停止)" % url)
    if not opt["replay"]:
        print("等待 DCS Export 连入 127.0.0.1:%d …（进任务后自动开始）" % opt["port"])

    try:
        while True:
            try:
                # 座舱桥启用时缩短轮询间隔，空闲时也能维持 ~10 Hz 的 seq 递增
                item = q.get(timeout=0.05 if writer is not None else 0.2)
                kind = item[0]
                if kind == "frame":
                    core.feed(item[1])
                elif kind == "reset":
                    core = LiveCore(opt["seed"], opt["coalition"])
                    print("V1 会话：核心已重建")
                elif kind == "proto":
                    if core.set_proto(item[1]):
                        print("PROTO,%s：坐标/航向按原始 DCS 值解释" % item[1])
            except queue.Empty:
                pass
            with state["lock"]:
                snap = core.snapshot(stats)
                state["snap"] = snap
            if writer is not None:
                age = None
                if core.last_feed_wall is not None:
                    age = time.time() - core.last_feed_wall
                # 回放 --speed 0 时 feed 线程瞬间读完后 stats.connected 已翻
                # False，但队列里还有大量待处理帧；链路有效性以“仍有帧在流动”
                # 为准，否则离线验证全程 valid=0。实时 TCP 下队列基本为空，
                # 断线即 connected=False，行为不变。
                connected = bool(stats.get("connected")) or not q.empty()
                writer.maybe_write(snap, dict(stats, connected=connected,
                                              frame_age_s=age))
    except KeyboardInterrupt:
        print("\nstopped. frames=%d dwells=%d"
              % (core.frames_fed, core.snapshot(stats)["sched"]["dwells"]))
    finally:
        httpd.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())

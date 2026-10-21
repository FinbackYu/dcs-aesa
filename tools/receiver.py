# -*- coding: utf-8 -*-
"""aesa 阶段二接收器 CLI：解析 Export 采样流 / 录制 / 回放加载。

解析与摄入实现分别在 tools/protocol.py、tools/ingest.py；
本文件只保留 TCP 服务与命令行，并向后导出旧名字。

用法：
  python tools/receiver.py --record flight.aesarec        # 录制
  python tools/receiver.py                                 # 实时摘要
  from tools.receiver import load_recording                # 回放加载
"""
import json
import socket
import sys
from pathlib import Path

from ingest import (VelocityPatcher, estimate_velocities, load_compat,
                    load_recording, load_sessions)
from protocol import FrameBuffer, parse_line

# Port 3590 is spec/protocol.json's; reading it here keeps this dev CLI from being a second
# definition (the Lua Export reads the generated src/shared/protocol.lua).
_SPEC = json.loads((Path(__file__).resolve().parents[1] / "spec" / "protocol.json").read_text(encoding="utf-8"))
DEFAULT_PORT = _SPEC["ports"]["aa_export"]

__all__ = [
    "DEFAULT_PORT", "FrameBuffer", "VelocityPatcher", "estimate_velocities",
    "load_compat", "load_recording", "load_sessions", "parse_line", "serve",
]


def serve(port=DEFAULT_PORT, record_path=None, on_frame=None):
    """TCP 服务器：单客户端循环；--record 时落盘。Ctrl-C 退出。"""
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", port))
    srv.listen(1)
    print("aesa receiver listening on 127.0.0.1:%d (Ctrl-C 停止)" % port)
    rec = open(record_path, "a", encoding="utf-8", buffering=1) if record_path else None
    buf = FrameBuffer(retain=False)
    try:
        while True:
            conn, addr = srv.accept()
            print("connected: %s" % (addr,))
            conn.settimeout(30)
            try:
                fp = conn.makefile("r", encoding="utf-8", errors="replace")
                for line in fp:
                    line = line.rstrip("\n")
                    if line:
                        buf.feed(line)
                        if rec:
                            rec.write(line + "\n")
                        if line.startswith("PROTO,") and buf.proto:
                            print("proto: %s" % buf.proto)
                        if line.startswith("COMPAT,") and buf.compat:
                            print("compat: profile=%s matrix=%s"
                                  % (buf.compat["profile_id"], buf.compat["matrix_hash"]))
                        if line.startswith("A") and on_frame:
                            on_frame(buf.last_frame)
            except (socket.timeout, TimeoutError, OSError):
                pass  # 30s 无数据或连接错误：按断开处理（DCS 侧 2s 自动重连）
            finally:
                try:
                    conn.close()
                except OSError:
                    pass
            buf.finish()
            print("disconnected. frames=%d engine_contacts=%d" % (buf.frame_count, buf.engine_count))
            if buf.probe:
                print("probe: %s" % buf.probe)
    except KeyboardInterrupt:
        buf.finish()
        print("\nstopped. frames=%d engine_contacts=%d" % (buf.frame_count, buf.engine_count))
    finally:
        if rec:
            rec.close()
        srv.close()


def main():
    args = sys.argv[1:]
    port = DEFAULT_PORT
    record_path = None
    i = 0
    while i < len(args):
        if args[i] == "--port":
            i += 1
            port = int(args[i])
        elif args[i] == "--record":
            i += 1
            record_path = args[i]
        i += 1
    serve(port, record_path)


if __name__ == "__main__":
    main()

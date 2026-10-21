# -*- coding: utf-8 -*-
"""Build and deploy the Export runtime bundle after a Lua 5.1 check; preserve user files."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_EXPORT = os.path.join(REPO, "dist", "dev", "aesa_export.lua")
SOURCE_REL = "dist/dev/aesa_export.lua"
BLOCK_BEGIN = "--[[ AESA EXPORT BEGIN ]]"
BLOCK_END = "--[[ AESA EXPORT END ]]"
BLOCK = """%s
-- aesa 真值采样。管理: python scripts/install_export.py
do
    local ok, err = pcall(dofile, lfs.writedir() .. [[Scripts\\AESA\\aesa_export.lua]])
    if not ok and log and log.write then log.write("AESA", log.ERROR, tostring(err)) end
end
%s""" % (BLOCK_BEGIN, BLOCK_END)
# Previously deployed development source: recognize its hash during migration.
LEGACY_HASHES = {"e1ae6e8d98ade15c6cfe569a2561b41161073f819fc925b8bc7c35fb77ea4ece"}


def find_saved_games(explicit=None):
    if explicit:
        return explicit
    if os.environ.get("AESA_SAVED_GAMES"):
        return os.environ["AESA_SAVED_GAMES"]
    base = os.path.join(os.path.expanduser("~"), "Saved Games")
    for name in ("DCS", "DCS.openbeta"):
        if os.path.isdir(os.path.join(base, name)):
            return os.path.join(base, name)
    return os.path.join(base, "DCS")


def _paths(root):
    scripts = Path(root) / "Scripts"
    return scripts / "Export.lua", scripts / "AESA" / "aesa_export.lua", scripts / "AESA" / "manifest.json"


def _read(path):
    return Path(path).read_bytes()


def _hash(data):
    return hashlib.sha256(data).hexdigest()


def _dcs_running():
    """Gate 6: never replace files a running simulator may still be using."""
    if os.environ.get("AESA_SKIP_DCS_CHECK") == "1":
        return False
    try:
        result = subprocess.run(["tasklist", "/NH"], capture_output=True,
                                text=True, encoding="utf-8", errors="replace")
    except (OSError, ValueError):
        return False
    return bool(re.search(r"\bDCS(?:\.openbeta)?\.exe\b", result.stdout or "", re.I))


def _ensure_dcs_closed():
    if _dcs_running():
        raise ValueError("DCS 正在运行；请关闭 DCS 后再 install/repair/uninstall（verify/status 只读）")


def _build_runtime():
    """Regenerate dist/dev/aesa_export.lua before deploying; never deploy source directly."""
    node = shutil.which("node")
    if not node:
        raise ValueError("找不到 node；无法构建 dist/dev/aesa_export.lua")
    script = os.path.join(REPO, "scripts", "build_runtime.cjs")
    result = subprocess.run([node, script, "export"], cwd=REPO, capture_output=True)
    if result.returncode:
        detail = (result.stderr or result.stdout).decode("utf-8", errors="replace").strip()
        raise ValueError("构建 dist/dev/aesa_export.lua 失败：" + detail)
    if not os.path.exists(SRC_EXPORT):
        raise ValueError("构建未生成 dist/dev/aesa_export.lua")


def _check_lua(path):
    """Compile the built bundle without executing it or producing build artifacts."""
    exe = os.environ.get("AESA_LUA") or shutil.which("lua") or shutil.which("luajit")
    if exe:
        expression = "assert(_VERSION == 'Lua 5.1'); assert(loadfile(%s))" % json.dumps(str(path), ensure_ascii=False)
        result = subprocess.run([exe, "-e", expression], capture_output=True)
        if result.returncode:
            raise ValueError("Lua 5.1 语法检查失败：" + result.stderr.decode("utf-8", errors="replace"))
    else:
        import lupa.lua51
        runtime = lupa.lua51.LuaRuntime()
        compile_lua = runtime.eval("function(s) local f,e=loadstring(s); assert(f,e) end")
        compile_lua(Path(path).read_text(encoding="utf-8"))


def _write(path, data):
    """Atomic replacement in the same directory."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=".aesa-", dir=str(path.parent))
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(data)
        os.replace(temporary, str(path))
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _span(data):
    """Validate before any write; never guess where a damaged block ends."""
    begin, end = BLOCK_BEGIN.encode(), BLOCK_END.encode()
    if not data.count(begin) and not data.count(end):
        return None
    if data.count(begin) != 1 or data.count(end) != 1:
        raise ValueError("Export.lua AESA 标记残缺或重复；请根据备份人工恢复完整标记")
    matches = []
    for marker in (begin, end):
        match = re.search(rb"(?m)^" + re.escape(marker) + rb"\r?$", data)
        if not match:
            raise ValueError("Export.lua AESA 标记必须独占一行")
        matches.append(match)
    if matches[0].start() >= matches[1].start():
        raise ValueError("Export.lua AESA 标记顺序错误")
    finish = matches[1].end()
    if data[finish:finish + 1] == b"\n":
        finish += 1
    return matches[0].start(), finish


def _manifest(path):
    if not path.exists():
        return None
    result = json.loads(path.read_text(encoding="utf-8"))
    if (not isinstance(result, dict) or result.get("product") != "aesa-export" or result.get("schema") != 1
            or not isinstance(result.get("script_hash"), str)
            or not re.fullmatch(r"[0-9a-f]{64}", result["script_hash"])
            or not isinstance(result.get("export_before"), str)
            or not isinstance(result.get("export_existed"), bool)):
        raise ValueError("AESA manifest 无效；保留现场，请检查备份")
    # No manifest-provided filesystem paths are used for writes or deletion.
    base64.b64decode(result["export_before"], validate=True)
    return result


def _owned(script, manifest):
    if not script.exists():
        return
    allowed = {manifest["script_hash"]} if manifest else set(LEGACY_HASHES)
    if not manifest:
        for known in (Path(SRC_EXPORT), Path(REPO) / "src" / "export" / "aesa_export.lua"):
            if known.exists():
                allowed.add(_hash(known.read_bytes()))
    if _hash(script.read_bytes()) not in allowed:
        raise ValueError("Scripts/AESA/aesa_export.lua 是未知或已修改的文件；保留原件，未覆盖/卸载")


def _backup(path):
    if not path.exists():
        return
    first = Path(str(path) + ".bak-aesa")
    if not first.exists():
        shutil.copyfile(str(path), str(first))
    # Each distinct revision is backed up before replacement, including edits by other tools.
    revision = Path(str(first) + "-" + _hash(path.read_bytes())[:16])
    if not revision.exists():
        shutil.copyfile(str(path), str(revision))
    elif revision.read_bytes() != path.read_bytes():
        raise ValueError("备份文件冲突，保留原件：%s" % revision)


def _strip(data, span, manifest):
    if span is None:
        return data
    start, end = span
    if manifest:
        before = base64.b64decode(manifest["export_before"])
        separator = base64.b64decode(manifest.get("append_separator", ""))
        if separator and data[:start] == before + separator:
            start -= len(separator)
    return data[:start] + data[end:]


def _transaction(changes):
    """Rollback owned destinations on an I/O error; backups remain available."""
    previous = [(p, p.read_bytes() if p.exists() else None) for p, _ in changes]
    try:
        for path, data in changes:
            if data is None:
                if path.exists():
                    path.unlink()
            else:
                _write(path, data)
    except OSError:
        for path, data in reversed(previous):
            if data is None:
                if path.exists():
                    path.unlink()
            else:
                _write(path, data)
        raise


def install(root):
    try:
        _ensure_dcs_closed()
        _build_runtime()
        exp, script, manifest_path = _paths(root)
        raw = exp.read_bytes() if exp.exists() else b""
        span = _span(raw)
        manifest = _manifest(manifest_path)
        # Check ownership before writing any destination files.
        if script.exists() and not manifest and _hash(script.read_bytes()) not in LEGACY_HASHES:
            if _hash(script.read_bytes()) != _hash(_read(SRC_EXPORT)):
                raise ValueError("Scripts/AESA/aesa_export.lua 是未知文件；保留原件")
        if manifest:
            _owned(script, manifest)
        _check_lua(SRC_EXPORT)
        payload = _read(SRC_EXPORT)
        if manifest and _hash(raw) == manifest.get("export_hash"):
            baseline = base64.b64decode(manifest["export_before"])
            originally_existed = manifest["export_existed"]
        else:
            baseline = _strip(raw, span, manifest)
            # A whitespace-only Export.lua is not user content: hook installers
            # may have created it before this installer ran. Treat it as absent
            # so the final uninstall removes the file instead of leaving blank lines.
            originally_existed = exp.exists() and baseline.strip() != b""
        newline = b"\r\n" if b"\r\n" in baseline else b"\n"
        separator = (newline if baseline.endswith(b"\n") else newline * 2) if baseline else b""
        loader = BLOCK.encode("utf-8").replace(b"\n", newline) + newline
        updated = baseline + separator + loader
        record = {"product": "aesa-export", "schema": 1, "revision": _hash(payload),
                  "script_hash": _hash(payload), "source": SOURCE_REL,
                  "export_hash": _hash(updated), "export_existed": originally_existed,
                  "export_before": base64.b64encode(baseline).decode("ascii"),
                  "append_separator": base64.b64encode(separator).decode("ascii"),
                  "files": ["Scripts/Export.lua", "Scripts/AESA/aesa_export.lua", "Scripts/AESA/manifest.json"]}
        _backup(exp)
        _backup(script)
        _backup(manifest_path)
        _transaction([(script, payload), (exp, updated),
                      (manifest_path, (json.dumps(record, indent=2) + "\n").encode())])
        return verify(root)
    except (OSError, ValueError, KeyError, ImportError, RuntimeError) as error:
        return [str(error)]


def repair(root):
    return install(root)


def uninstall(root):
    try:
        _ensure_dcs_closed()
        exp, script, manifest_path = _paths(root)
        raw = exp.read_bytes() if exp.exists() else b""
        span = _span(raw)
        manifest = _manifest(manifest_path)
        _owned(script, manifest)
        if manifest and _hash(raw) == manifest.get("export_hash"):
            baseline = base64.b64decode(manifest["export_before"])
            remove_export = not manifest["export_existed"] or baseline.strip() == b""
        else:
            baseline, remove_export = _strip(raw, span, manifest), False
            if baseline.strip() == b"":
                remove_export = True
        _backup(exp)
        # Remove only an unchanged, hash-verified owned script and the validated manifest.
        changes = []
        if exp.exists() and (remove_export or baseline != raw):
            changes.append((exp, None if remove_export else baseline))
        changes.extend([(script, None), (manifest_path, None)])
        _transaction(changes)
        if script.parent.exists() and not any(script.parent.iterdir()):
            script.parent.rmdir()
        return []
    except (OSError, ValueError, KeyError) as error:
        return [str(error)]


def verify(root):
    try:
        exp, script, manifest_path = _paths(root)
        issues = []
        manifest = _manifest(manifest_path)
        if not manifest:
            issues.append("缺少 AESA manifest（已知旧版本可运行 install 升级）")
        if not script.exists():
            issues.append("缺少 Scripts/AESA/aesa_export.lua")
        else:
            _owned(script, manifest)
            if Path(SRC_EXPORT).exists() and _hash(script.read_bytes()) != _hash(_read(SRC_EXPORT)):
                issues.append("aesa_export.lua 与当前构建产物不一致（运行 install/repair）")
        if not exp.exists():
            issues.append("缺少 Scripts/Export.lua")
        else:
            raw = exp.read_bytes()
            span = _span(raw)
            if span is None:
                issues.append("Export.lua 缺少 AESA 标记块")
            elif raw[span[0]:span[1]].replace(b"\r\n", b"\n").rstrip(b"\n") != BLOCK.encode():
                issues.append("Export.lua 标记块内容过期（运行 repair）")
        return issues
    except (OSError, ValueError, KeyError) as error:
        return [str(error)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", nargs="?", default="status",
                        choices=["install", "repair", "uninstall", "verify", "status"])
    parser.add_argument("--saved-games")
    args = parser.parse_args()
    root = find_saved_games(args.saved_games)
    print("Saved Games: %s" % root)
    if not os.path.isdir(root):
        print("错误：目录不存在")
        return 2
    action = {"install": install, "repair": repair, "uninstall": uninstall}.get(args.action, verify)
    issues = action(root)
    if issues:
        for issue in issues:
            print("  - " + issue)
        return 1
    print("状态: %s 完成，无问题" % args.action)
    return 0


if __name__ == "__main__":
    sys.exit(main())

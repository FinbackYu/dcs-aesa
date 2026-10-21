# -*- coding: utf-8 -*-
"""从 DCS 安装目录的明文 Lua 数据库提取机型 RCS 标量表。

用法：
    python scripts/extract_rcs.py <DCS安装目录>   # 或设置环境变量 DCS_DIR
输出：
    src/adapters/dcs/rcs_data.lua（生成文件，勿手改）

数据来源说明：官版 FC3/AI 单位本体在加密的 Database.edce 中，本脚本只收集
CoreMods/Mods 下明文资产的 RCS 字段（官方数值，source=ed-plaintext）；
提取不到的机型由 src/adapters/dcs/rcs.lua 按分档兜底（source=fallback-estimate）。
"""
import hashlib
import os
import re
import sys

PAT_RCS = re.compile(r"^\s*RCS\s*=\s*([0-9.]+)\s*,?\s*(?:--(.*))?$", re.M)
PAT_NAME = re.compile(r"(?:Name|displayName)\s*=\s*(?:_\(\s*)?[\"']([^\"']+)[\"']")

SKIP_DIR_PARTS = (
    os.sep + "Sounds", os.sep + "Tracks", os.sep + "Mods" + os.sep + "terrain",
    os.sep + "CoreMods" + os.sep + "terrain", "_resources", os.sep + "MissionEditor",
)

# 与 src/adapters/dcs/rcs.lua 的消费端保持同一 schema：large 是轰炸机/大型平台档，
# missile 是弹药档。新增/改名必须同时改 rcs.lua 与 tests/test_gate1_rcs.py。
FALLBACK = (
    ("fighter", 5.0),
    ("large", 25.0),
    ("helicopter", 6.0),
    ("missile", 0.05),
)


def extract(dcs_root):
    entries = {}   # name -> rcs
    skipped = 0
    n_files = 0
    for base, dirs, files in os.walk(dcs_root):
        if any(p in base for p in SKIP_DIR_PARTS):
            dirs[:] = []
            continue
        for fn in files:
            if not fn.endswith(".lua"):
                continue
            path = os.path.join(base, fn)
            try:
                with open(path, "r", encoding="utf-8", errors="ignore") as f:
                    src = f.read()
            except OSError:
                continue
            ms = list(PAT_RCS.finditer(src))
            if not ms:
                continue
            n_files += 1
            for m in ms:
                back = src[max(0, m.start() - 12000):m.start()]
                names = PAT_NAME.findall(back)
                if not names:
                    skipped += 1  # 归属不明的 RCS（如传感器库文件）跳过
                    continue
                name = norm_name(names[-1])
                if not name:
                    skipped += 1
                    continue
                entries.setdefault(name, float(m.group(1)))
    return entries, n_files, skipped


def norm_name(name):
    """键名归一化：取路径最后一段；丢弃网格引用类（.FBX）误归属键。"""
    if "/" in name:
        name = name.split("/")[-1]
    name = name.strip()
    if not name or name.lower().endswith(".fbx"):
        return None
    return name


HEADER = """-- rcs_data.lua —— 机型 RCS 标量表【生成文件，勿手改】
-- 由 scripts/extract_rcs.py 从 DCS 明文数据库提取（官方数值，source=ed-plaintext）。
-- 提取不到的机型由 adapters/dcs/rcs.lua 的分档兜底（source=fallback-estimate，【估计值】）。
-- content-sha256: {digest}

"""


def render_document(entries):
    """渲染 rcs_data.lua 文本；fallback 必须覆盖 rcs.lua 消费的全部四档。"""
    lines = ["return {"]
    lines.append("  map = {")
    for name in sorted(entries):
        safe = name.replace("\\", "\\\\").replace('"', '\\"')
        lines.append('    ["%s"] = %g,' % (safe, entries[name]))
    lines.append("  },")
    lines.append(
        "  -- 分档兜底值【估计：公开资料量级】；"
        "missile = %g m²【设定】真导弹 RCS≈0.05–0.1 m²，检测距离∝σ^¼"
        % dict(FALLBACK)["missile"]
    )
    fields = []
    for key, value in FALLBACK:
        text = "%g" % value
        if "." not in text and "e" not in text:
            text += ".0"  # 保持 "5.0" 这类原有书写，避免无意义 diff
        fields.append("%s = %s" % (key, text))
    lines.append("  fallback = { %s }," % ", ".join(fields))
    lines.append("}")
    body = "\n".join(lines) + "\n"
    digest = hashlib.sha256(body.encode("utf-8")).hexdigest()
    return HEADER.format(digest=digest) + body


def main():
    dcs_root = None
    for a in sys.argv[1:]:
        if not a.startswith("-"):
            dcs_root = a
    dcs_root = dcs_root or os.environ.get("DCS_DIR")
    if not dcs_root or not os.path.isdir(dcs_root):
        print("用法: python scripts/extract_rcs.py <DCS安装目录>（或设 DCS_DIR）")
        return 1

    entries, n_files, skipped = extract(dcs_root)
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       "src", "adapters", "dcs", "rcs_data.lua")
    with open(out, "w", encoding="utf-8") as f:
        f.write(render_document(entries))
    print("提取 %d 个机型（来自 %d 个文件，跳过归属不明 %d 条）-> %s"
          % (len(entries), n_files, skipped, out))
    return 0


if __name__ == "__main__":
    sys.exit(main())

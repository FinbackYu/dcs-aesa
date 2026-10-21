#!/usr/bin/env python3
"""Fetch a minimal mingw-w64 gcc toolchain from the Aliyun MSYS2 mirror.

Resolves the dependency closure of mingw-w64-x86_64-gcc from the repo
database, downloads .pkg.tar.zst packages and extracts them into
.tools/mingw-root/ next to this repository (which then contains
mingw64/bin/gcc.exe). Local development bootstrap; the toolchain itself
is gitignored. Requires the `zstandard` Python package.
"""
import io
import os
import sys
import tarfile
import urllib.request

import zstandard

REPO = "https://mirrors.aliyun.com/msys2/mingw/mingw64"
ROOT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".tools", "mingw-root"
)
PKGS = os.path.join(ROOT, "_pkgs")
WANT = ["mingw-w64-x86_64-gcc"]


def load_db(path):
    raw = urllib.request.urlopen(REPO + "/mingw64.db", timeout=30).read()
    data = zstandard.ZstdDecompressor().stream_reader(io.BytesIO(raw)).read()
    tf = tarfile.open(fileobj=io.BytesIO(data))
    index = {}
    for m in tf.getmembers():
        if not m.name.endswith("/desc"):
            continue
        lines = tf.extractfile(m).read().decode().split("\n")
        name = fn = None
        deps = []
        i = 0
        while i < len(lines):
            if lines[i] == "%NAME%":
                name = lines[i + 1]
            elif lines[i] == "%FILENAME%":
                fn = lines[i + 1]
            elif lines[i] == "%DEPENDS%":
                j = i + 1
                while j < len(lines) and lines[j] and not lines[j].startswith("%"):
                    deps.append(lines[j].split("<")[0].split(">")[0].split("=")[0])
                    j += 1
            i += 1
        if name:
            index[name] = (fn, deps)
    return index


def closure(index, roots):
    seen, order = set(), []

    def visit(name):
        if name in seen:
            return
        if name not in index:
            print("missing dep (skipped):", name)
            return
        seen.add(name)
        for dep in index[name][1]:
            visit(dep)
        order.append(name)

    for root in roots:
        visit(root)
    return order


def fetch(fn, dest):
    if os.path.exists(dest):
        return
    tmp = dest + ".part"
    with urllib.request.urlopen(REPO + "/" + fn, timeout=120) as r, open(tmp, "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
            print(".", end="", flush=True)
    os.replace(tmp, dest)


def extract(pkg, root):
    raw = open(pkg, "rb").read()
    data = zstandard.ZstdDecompressor().stream_reader(io.BytesIO(raw)).read()
    with tarfile.open(fileobj=io.BytesIO(data)) as tf:
        for m in tf.getmembers():
            if m.name.startswith("."):  # .PKGINFO and friends
                continue
            tf.extract(m, root)


def main():
    os.makedirs(PKGS, exist_ok=True)
    index = load_db(os.path.join(PKGS, "mingw64.db"))
    order = closure(index, WANT)
    print("packages:", len(order))
    for name in order:
        fn = index[name][0]
        dest = os.path.join(PKGS, fn)
        print("fetch", fn, " ", end="", flush=True)
        fetch(fn, dest)
        print(" ok", flush=True)
    for name in order:
        fn = index[name][0]
        print("extract", fn)
        extract(os.path.join(PKGS, fn), ROOT)
    gcc = os.path.join(ROOT, "mingw64", "bin", "gcc.exe")
    print("gcc at", gcc, "exists:", os.path.exists(gcc))


if __name__ == "__main__":
    main()

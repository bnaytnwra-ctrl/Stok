#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
svg2png.py — مُصيّر PNG صغير للمجموعة الفرعية من SVG التي ينتجها tests/render.js
------------------------------------------------------------------------------
لا يوجد rsvg/cairo في البيئة، لذا نُصيّر يدويًا: المستطيلات، المسارات
(M/L) بخطوط أو بتعبئة مسح خطّي، والتدرّجات الرأسية. النص يُتجاهل
(التحقّق هنا هندسي: الشموع، خطّا الوتد، الأهداف، لوحا الحجم وRSI).

    python3 terminal/tests/svg2png.py in.svg out.png
"""
from __future__ import annotations

import re
import struct
import sys
import zlib

TAG = re.compile(r"<(rect|path|linearGradient)\b([^>]*?)(/?)>", re.S)
ATTR = re.compile(r'([a-zA-Z0-9:-]+)="([^"]*)"')


def parse_attrs(s: str) -> dict:
    return {k: v for k, v in ATTR.findall(s or "")}


def to_rgb(c: str):
    c = (c or "").strip()
    if c.startswith("#"):
        h = c[1:]
        if len(h) == 3:
            h = "".join(x * 2 for x in h)
        if len(h) >= 6:
            return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    m = re.match(r"rgba?\(([^)]+)\)", c)
    if m:
        parts = []
        for x in m.group(1).split(","):
            try:
                parts.append(float(x.strip()))
            except ValueError:
                return None
        if len(parts) >= 3:
            return (int(parts[0]), int(parts[1]), int(parts[2]))
    return None


def num(a: dict, k: str, d: float = 0.0) -> float:
    try:
        return float(a.get(k, d))
    except ValueError:
        return d


def subpaths(d: str):
    """يقسم مسار SVG إلى قوائم نقاط (يدعم M/L/Z فقط — وهو كل ما ننتجه)."""
    out, cur = [], []
    for tok in re.findall(r"[MLZ]|-?\d*\.?\d+(?:e[-+]?\d+)?", d, re.I):
        t = tok.upper()
        if t == "M":
            if len(cur) >= 2:
                out.append(cur)
            cur = []
            mode = "M"
        elif t == "L":
            mode = "L"
        elif t == "Z":
            if len(cur) >= 2:
                out.append(cur)
            cur = []
            continue
        else:
            try:
                cur.append(float(tok))
            except ValueError:
                continue
    if len(cur) >= 2:
        out.append(cur)
    return [[(p[i], p[i + 1]) for i in range(0, len(p) - 1, 2)] for p in out if len(p) >= 4]


def main() -> int:
    src, dst = sys.argv[1], sys.argv[2]
    text = open(src, encoding="utf-8").read()

    m = re.search(r'width="(\d+)"\s+height="(\d+)"', text)
    W, H = (int(m.group(1)), int(m.group(2))) if m else (1180, 660)

    img = bytearray()
    for _ in range(H):
        img.extend(b"\x07\x0a\x10" * W)

    # التدرّجات
    grads = {}
    for tag, attrs, _ in TAG.findall(text):
        if tag != "linearGradient":
            continue
        a = parse_attrs(attrs)
        gid = a.get("id")
        body = text.split('id="%s"' % gid, 1)[1].split("</linearGradient>", 1)[0]
        stops = []
        for o, c, op in re.findall(r'offset="([\d.]+)"\s+stop-color="([^"]+)"(?:\s+stop-opacity="([\d.]+)")?', body):
            rgb = to_rgb(c)
            if rgb:
                stops.append((float(o), rgb, float(op) if op else 1.0))
        if gid and stops:
            grads[gid] = (a.get("y2") == "1", stops)

    def _asrgb(v):
        if v is None:
            return None
        while isinstance(v, (tuple, list)) and len(v) == 1:
            v = v[0]
        if isinstance(v, (tuple, list)) and len(v) >= 3:
            try:
                return (int(v[0]), int(v[1]), int(v[2]))
            except (TypeError, ValueError):
                return None
        return None

    def blend(x, y, rgb, alpha):
        rgb = _asrgb(rgb)
        if not rgb or alpha <= 0:
            return
        xi, yi = int(x), int(y)
        if not (0 <= xi < W and 0 <= yi < H):
            return
        o = (yi * W + xi) * 3
        for k in range(3):
            img[o + k] = int(img[o + k] * (1 - alpha) + rgb[k] * alpha)

    def grad_at(gid, y):
        vert, stops = grads[gid]
        t = (y / H) if vert else 0.5
        if len(stops) == 1:
            return stops[0][1], stops[0][2]
        for i in range(len(stops) - 1):
            o0, c0, a0 = stops[i]
            o1, c1, a1 = stops[i + 1]
            if o0 <= t <= o1:
                f = 0 if o1 == o0 else (t - o0) / (o1 - o0)
                rgb = tuple(int(c0[k] + (c1[k] - c0[k]) * f) for k in range(3))
                return rgb, a0 + (a1 - a0) * f
        return stops[-1][1], stops[-1][2]

    def line(x0, y0, x1, y1, rgb, alpha, w):
        n = int(max(abs(x1 - x0), abs(y1 - y0)) * 2) + 1
        for i in range(n + 1):
            t = i / n
            x, y = x0 + (x1 - x0) * t, y0 + (y1 - y0) * t
            for dx in range(-int(w // 2), int(w // 2) + 1):
                for dy in range(-int(w // 2), int(w // 2) + 1):
                    blend(x + dx, y + dy, rgb, alpha)

    def fill_poly(pts, rgb_getter, alpha):
        if len(pts) < 3:
            return
        ys = [p[1] for p in pts]
        for y in range(max(0, int(min(ys))), min(H, int(max(ys)) + 1)):
            xs = []
            for i in range(len(pts)):
                x0, y0 = pts[i]
                x1, y1 = pts[(i + 1) % len(pts)]
                if (y0 <= y < y1) or (y1 <= y < y0):
                    xs.append(x0 + (y - y0) * (x1 - x0) / (y1 - y0))
            xs.sort()
            got = rgb_getter(y)
            col = got[0] if (isinstance(got, tuple) and isinstance(got[0], (tuple, list))) else got
            a2 = got[1] if (isinstance(got, tuple) and len(got) == 2 and isinstance(got[1], (int, float))) else 1
            for i in range(0, len(xs) - 1, 2):
                a, b = int(xs[i]), int(xs[i + 1])
                for x in range(max(0, a), min(W, b + 1)):
                    blend(x, y, col, a2 * alpha)

    n_rect = n_stroke = n_fill = 0
    for tag, attrs, _ in TAG.findall(text):
        if tag == "linearGradient":
            continue
        a = parse_attrs(attrs)
        alpha = float(a.get("opacity", "1") or 1)
        if tag == "rect":
            fillv = a.get("fill", "")
            if fillv.startswith("url("):
                gid = fillv[5:-1]
                rgb = grad_at(gid, num(a, "y")) if gid in grads else None
            else:
                rgb = to_rgb(fillv)
            if a.get("stroke", "none") not in ("none", ""):
                rgb = to_rgb(a.get("stroke", ""))
            x, y = num(a, "x"), num(a, "y")
            w, h = num(a, "width"), num(a, "height")
            fill_poly([(x, y), (x + w, y), (x + w, y + h), (x, y + h)], lambda _y, c=rgb: c, alpha)
            n_rect += 1
        elif tag == "path":
            d = a.get("d", "")
            fill = a.get("fill", "none")
            stroke = a.get("stroke", "none")
            sw = num(a, "stroke-width", 1)
            for pts in subpaths(d):
                if fill not in ("none", ""):
                    if fill.startswith("url("):
                        gid = fill[5:-1]
                        getter = (lambda y, g=gid: grad_at(g, y)) if gid in grads else (lambda y: None)
                    else:
                        c = to_rgb(fill)
                        getter = lambda y, c=c: c
                    fill_poly(pts, getter, alpha)
                    n_fill += 1
                if stroke not in ("none", ""):
                    c = to_rgb(stroke)
                    for i in range(len(pts) - 1):
                        line(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], c, alpha, sw)
                    if "Z" in d.upper():
                        line(pts[-1][0], pts[-1][1], pts[0][0], pts[0][1], c, alpha, sw)
                    n_stroke += 1

    raw = bytearray()
    for y in range(H):
        raw.append(0)
        raw.extend(img[y * W * 3:(y + 1) * W * 3])

    def chunk(typ, data):
        return struct.pack(">I", len(data)) + typ + data + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(bytes(raw), 6))
           + chunk(b"IEND", b""))
    open(dst, "wb").write(png)
    print(f"[ok] {dst}  {W}x{H}  rects={n_rect} strokes={n_stroke} fills={n_fill}  {len(png)//1024} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

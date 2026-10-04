#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
server.py — خادم المنصّة (Terminal Server)
-------------------------------------------
يقدّم واجهة `terminal/` كملفات ثابتة، ويوفّر نقطة `/api/alerts` تقرأ
`logs/alerts_log.csv` الحقيقي من المستودع (تنبيهات بوت تلجرام) حتى تنعكس
التنبيهات الجديدة في اللوحة مباشرة.

التشغيل:
    python3 terminal/server.py [--port 8080] [--host 0.0.0.0]
"""

from __future__ import annotations

import argparse
import csv
import io as _io
import json
import os
import zipfile
import sys
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(ROOT)
ALERTS_CSV = os.path.join(REPO, "logs", "alerts_log.csv")

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
}


def _to_float(v):
    try:
        return float(str(v).strip())
    except (TypeError, ValueError):
        return None


def _normalize(row: list[str]) -> dict | None:
    """
    الملف يحوي بنيتين مختلفتين كتبهما مساران منفصلان في البوت:

      أ) تنبيه خبري (٧ أعمدة):
         ts, ticker, title, price, source, link, score
      ب) محفّز/تقويم (١٠ أعمدة):
         ts, mode, ticker, price, catalyst_ar, event_date, title, source, link, keyword

    نُطوّع الاثنتين إلى شكل واحد.
    """
    row = [(c or "").strip() for c in row]
    if len(row) < 4 or not row[0]:
        return None

    if row[1] in ("realtime", "calendar", "both") and len(row) >= 7:
        return {
            "ts": row[0], "t": row[2] or "—", "title": row[6] or row[4],
            "price": _to_float(row[3]), "src": row[7] or row[1],
            "kind": "محفّز" if row[1] == "calendar" else "عاجل",
            "catalyst": row[4] or "", "event_date": row[5] or "",
            "link": row[8] if len(row) > 8 else "",
            "score": 5 if row[1] == "realtime" else 4,
        }

    return {
        "ts": row[0], "t": row[1] or "—", "title": row[2] or "(بدون عنوان)",
        "price": _to_float(row[3]), "src": row[4] if len(row) > 4 else "",
        "kind": "خبر", "catalyst": "", "event_date": "",
        "link": row[5] if len(row) > 5 else "",
        "score": max(1, min(5, int(_to_float(row[6]) or 3))) if len(row) > 6 else 3,
    }


def read_alerts() -> list[dict]:
    """يقرأ سجل تنبيهات البوت ويتحمّل البنى غير المنتظمة بأمان."""
    rows: list[dict] = []
    if not os.path.exists(ALERTS_CSV):
        return rows
    try:
        with open(ALERTS_CSV, newline="", encoding="utf-8", errors="replace") as fh:
            reader = csv.reader(fh)
            next(reader, None)                       # ترويسة
            for raw in reader:
                try:
                    item = _normalize(raw)
                except Exception:                    # noqa: BLE001 - صف تالف لا يُسقط الباقي
                    item = None
                if item:
                    rows.append(item)
    except OSError as exc:  # pragma: no cover
        print(f"[warn] failed to read alerts: {exc}", file=sys.stderr)
    rows.sort(key=lambda r: r["ts"], reverse=True)
    return rows


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):  # هدوء في السجل
        sys.stderr.write("· %s\n" % (fmt % args))

    def _json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._no_store_sent = True
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        # تعطيل الكاش للملفات الثابتة حتى تصل أحدث نسخة دائمًا (يصلح «لا يستجيب» بعد التحديث)
        if not getattr(self, "_no_store_sent", False):
            self.send_header("Cache-Control", "no-store")
        self._no_store_sent = False
        super().end_headers()

    def _download(self):
        fp = os.path.join(REPO, "stok-terminal-standalone.html")
        if not os.path.exists(fp):
            return self._json({"error": "standalone file missing"}, 404)
        with open(fp, "rb") as fh:
            data = fh.read()
        self.send_response(200)
        # octet-stream => المتصفح يحفظه خامًا باسم الملف دون تحويله لوورد/معاينة
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Disposition", 'attachment; filename="stok-terminal.html"')
        self.send_header("Content-Length", str(len(data)))
        self._no_store_sent = True
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _download_zip(self):
        fp = os.path.join(REPO, "stok-terminal-standalone.html")
        if not os.path.exists(fp):
            return self._json({"error": "standalone file missing"}, 404)
        buf = _io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            z.write(fp, "stok-terminal.html")
        data = buf.getvalue()
        self.send_response(200)
        self.send_header("Content-Type", "application/zip")
        self.send_header("Content-Disposition", 'attachment; filename="stok-terminal.zip"')
        self.send_header("Content-Length", str(len(data)))
        self._no_store_sent = True
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split("?", 1)[0]

        if path in ("/download", "/download.html"):
            return self._download()

        if path in ("/download.zip", "/stok.zip"):
            return self._download_zip()

        if path == "/api/alerts":
            return self._json({
                "generated_utc": datetime.now(timezone.utc).isoformat(),
                "source": os.path.relpath(ALERTS_CSV, REPO),
                "count": len(read_alerts()),
                "alerts": read_alerts(),
            })

        if path == "/api/health":
            return self._json({
                "ok": True,
                "service": "stok-terminal",
                "alerts_csv": os.path.exists(ALERTS_CSV),
                "alerts": len(read_alerts()),
                "time_utc": datetime.now(timezone.utc).isoformat(),
            })

        return super().do_GET()

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        return MIME.get(ext, super().guess_type(path))


def main() -> int:
    ap = argparse.ArgumentParser(description="STOK Falling-Wedge Terminal server")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8080")))
    args = ap.parse_args()

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    srv.daemon_threads = True
    print(f"STOK Terminal  →  http://{args.host}:{args.port}/")
    print(f"repo root      :  {REPO}")
    print(f"alerts csv     :  {ALERTS_CSV} ({'ok' if os.path.exists(ALERTS_CSV) else 'missing'})")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

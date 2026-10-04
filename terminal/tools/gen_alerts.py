#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tools/gen_alerts.py — يولّد نسخة JS مدمجة من `logs/alerts_log.csv`
------------------------------------------------------------------
المنصّة تفضّل `/api/alerts` الحيّ، لكنها تحتاج نسخة مدمجة لتعمل أيضًا عند
فتح `index.html` مباشرة بدون خادم. هذا السكربت يبقي النسختين متطابقتين
باستخدام نفس منطق التطبيع الموجود في `server.py`.

    python3 terminal/tools/gen_alerts.py
"""

from __future__ import annotations

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from server import read_alerts  # noqa: E402

TARGET = os.path.join(os.path.dirname(HERE), "js", "market.js")
BEGIN = "  /* BEGIN-EMBEDDED-ALERTS */"
END = "  /* END-EMBEDDED-ALERTS */"

KEEP = ("ts", "t", "title", "price", "src", "kind", "catalyst", "event_date", "score")


def main() -> int:
    alerts = read_alerts()
    rows = []
    for a in alerts:
        obj = {k: a.get(k) for k in KEEP}
        rows.append("    " + json.dumps(obj, ensure_ascii=False, separators=(",", ":")))
    block = BEGIN + "\n  const ALERTS = [\n" + ",\n".join(rows) + "\n  ];\n" + END

    with open(TARGET, encoding="utf-8") as fh:
        src = fh.read()
    if BEGIN not in src or END not in src:
        print(f"[error] markers not found in {TARGET}", file=sys.stderr)
        return 1
    new = re.sub(re.escape(BEGIN) + r".*?" + re.escape(END), block, src, flags=re.S)
    with open(TARGET, "w", encoding="utf-8") as fh:
        fh.write(new)
    print(f"[ok] embedded {len(alerts)} alerts into {os.path.relpath(TARGET)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

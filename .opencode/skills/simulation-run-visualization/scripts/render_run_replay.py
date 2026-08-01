#!/usr/bin/env python3
"""Render JSON/JSONL simulation events into standalone timeline HTML."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import html
import json
import os
import shutil
import subprocess
from collections import Counter
from pathlib import Path


def external_open(path: Path) -> None:
    if os.name == "nt":
        os.startfile(str(path))  # type: ignore[attr-defined]
    else:
        subprocess.run(["open" if shutil.which("open") else "xdg-open", str(path)], check=True)


def load_events(path: Path) -> list[dict]:
    source = path.read_text(encoding="utf-8")
    if path.suffix.lower() == ".jsonl":
        rows = [json.loads(line) for line in source.splitlines() if line.strip()]
    else:
        value = json.loads(source)
        rows = value.get("events", []) if isinstance(value, dict) else value
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        raise ValueError("event source must be JSONL objects, a JSON list, or a JSON object with events")
    return rows


def get_time(event: dict, index: int) -> float | str:
    for key in ("sim_time_days", "time", "timestamp", "step", "day"):
        if key in event:
            return event[key]
    return index


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--events", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--title", default="Simulation replay")
    parser.add_argument("--max-events", type=int, default=500)
    parser.add_argument("--open", action="store_true", dest="open_browser")
    args = parser.parse_args()
    if args.max_events < 1:
        raise SystemExit("--max-events must be at least 1")
    raw = args.events.read_bytes()
    events = load_events(args.events)
    selected = events[: args.max_events]
    names = Counter(str(event.get("event_type", event.get("type", "untyped"))) for event in events)
    escaped_rows = "".join(
        "<tr><td>{}</td><td>{}</td><td><pre>{}</pre></td></tr>".format(
            html.escape(str(get_time(event, index))),
            html.escape(str(event.get("event_type", event.get("type", "untyped")))),
            html.escape(json.dumps(event, ensure_ascii=False, indent=2)),
        )
        for index, event in enumerate(selected)
    ) or '<tr><td colspan="3">无事件</td></tr>'
    legend = "".join(f"<li><b>{html.escape(name)}</b> {count}</li>" for name, count in names.most_common()) or "<li>无事件</li>"
    payload = json.dumps([{"time": get_time(event, index), "type": event.get("event_type", event.get("type", "untyped"))} for index, event in enumerate(selected)], ensure_ascii=False).replace("</", "<\\/")
    digest = hashlib.sha256(raw).hexdigest()
    generated = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    warning = "已按输入顺序截断显示。" if len(selected) < len(events) else "显示完整事件流。"
    page = f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{html.escape(args.title)}</title>
<style>body{{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:1280px;margin:auto;padding:32px;background:#f7f8fc;color:#172033}}header,section{{background:#fff;border:1px solid #dbe2ef;border-radius:14px;padding:20px;margin:16px 0}}h1,h2{{margin-top:0}}.meta,.warning{{color:#526078}}.warning{{border-left:4px solid #dd8b00;padding-left:10px}}#timeline{{display:flex;gap:4px;align-items:end;height:120px;overflow:auto;border-bottom:1px solid #b9c5d8;padding:8px}}.tick{{min-width:8px;background:#3e73d8;border-radius:3px 3px 0 0}}table{{width:100%;border-collapse:collapse}}th,td{{text-align:left;vertical-align:top;border-top:1px solid #e5eaf3;padding:8px}}pre{{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:12px ui-monospace,SFMono-Regular,monospace}}ul{{columns:2;max-width:680px}}</style>
<header><h1>{html.escape(args.title)}</h1><p class="meta">来源：{html.escape(str(args.events))} · SHA-256：<code>{digest}</code> · 生成：{generated}</p><p class="warning">{warning} 输入 {len(events)} 条，页面显示 {len(selected)} 条；此回放是投影，不证明校准、验证或决策适用性。</p></header>
<section><h2>事件密度（按显示顺序）</h2><div id="timeline" aria-label="事件密度图"></div></section><section><h2>事件类型</h2><ul>{legend}</ul></section><section><h2>事件流</h2><table><thead><tr><th>时间/步骤</th><th>类型</th><th>记录</th></tr></thead><tbody>{escaped_rows}</tbody></table></section><script>const rows={payload};const box=document.querySelector('#timeline');const counts=new Map();rows.forEach(x=>counts.set(String(x.time),(counts.get(String(x.time))||0)+1));const peak=Math.max(1,...counts.values());for(const [time,count] of counts){{const bar=document.createElement('div');bar.className='tick';bar.style.height=`${{12+96*count/peak}}px`;bar.title=`${{time}}: ${{count}} events`;box.append(bar)}}</script></html>'''
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(page, encoding="utf-8")
    print(args.output.resolve())
    if args.open_browser:
        external_open(args.output.resolve())


if __name__ == "__main__":
    main()

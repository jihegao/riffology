#!/usr/bin/env python3
"""Render a simulation model JSON specification as self-contained review HTML."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import html
import json
import os
import shutil
import subprocess
from pathlib import Path


def text(value: object) -> str:
    if value is None:
        return "—"
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, indent=2)
    return str(value)


def esc(value: object) -> str:
    return html.escape(text(value))


def table(rows: list[tuple[str, object]]) -> str:
    if not rows:
        return '<p class="empty">未声明</p>'
    return "<table><tbody>" + "".join(
        f"<tr><th>{esc(key)}</th><td><pre>{esc(value)}</pre></td></tr>" for key, value in rows
    ) + "</tbody></table>"


def open_external(path: Path) -> None:
    if os.name == "nt":
        os.startfile(str(path))  # type: ignore[attr-defined]
        return
    command = ["open", str(path)] if shutil.which("open") else ["xdg-open", str(path)]
    subprocess.run(command, check=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--spec", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--title", default="Simulation model design")
    parser.add_argument("--open", action="store_true", dest="open_browser")
    args = parser.parse_args()

    raw = args.spec.read_bytes()
    spec = json.loads(raw)
    if not isinstance(spec, dict):
        raise SystemExit("--spec must contain one JSON object")
    digest = hashlib.sha256(raw).hexdigest()
    entities = spec.get("entities", {})
    entity_cards = ""
    if isinstance(entities, dict) and entities:
        for name, details in entities.items():
            details = details if isinstance(details, dict) else {"value": details}
            entity_cards += f"<article><h3>{esc(name)}</h3>{table(list(details.items()))}</article>"
    else:
        entity_cards = '<p class="empty">未声明实体</p>'

    primary = [(key, spec.get(key)) for key in ("model_id", "model_class", "model_protocol_version", "time_unit", "public_step", "claim_scope") if key in spec]
    process = [(key, spec.get(key)) for key in ("event_ordering", "queue_policy", "failure_semantics", "measurement_window") if key in spec]
    uncertainty = [(key, spec.get(key)) for key in ("distribution_families", "named_random_streams") if key in spec]
    known = {"entities", *[key for key, _ in primary], *[key for key, _ in process], *[key for key, _ in uncertainty]}
    remaining = {key: value for key, value in spec.items() if key not in known}
    generated = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    page = f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{esc(args.title)}</title>
<style>body{{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:1200px;margin:0 auto;padding:32px;background:#f7f8fc;color:#172033}} header,section{{background:#fff;border:1px solid #dbe2ef;border-radius:14px;padding:22px;margin:16px 0}}h1{{margin:0 0 8px}}h2{{margin-top:0}}.meta{{color:#526078;font-size:14px}}.grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}}article{{border:1px solid #dbe2ef;border-radius:10px;padding:14px}}table{{border-collapse:collapse;width:100%}}th,td{{vertical-align:top;text-align:left;border-top:1px solid #e5eaf3;padding:8px}}th{{width:35%;color:#526078}}pre{{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;font:12px ui-monospace,SFMono-Regular,monospace}}.empty{{color:#68758d;font-style:italic}}</style>
<header><h1>{esc(args.title)}</h1><p class="meta">来源：{esc(args.spec)} · SHA-256：<code>{digest}</code> · 生成：{generated}</p><p>这是模型规范的可审查投影，不证明模型已经验证、校准或适合决策。</p></header>
<section><h2>模型边界</h2>{table(primary)}</section><section><h2>实体与状态</h2><div class="grid">{entity_cards}</div></section><section><h2>事件与调度</h2>{table(process)}</section><section><h2>不确定性与随机流</h2>{table(uncertainty)}</section><section><h2>其余规范字段</h2>{table(list(remaining.items()))}</section></html>'''
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(page, encoding="utf-8")
    print(args.output.resolve())
    if args.open_browser:
        open_external(args.output.resolve())


if __name__ == "__main__":
    main()

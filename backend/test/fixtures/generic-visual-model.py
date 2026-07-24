from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--riff-input", required=True, type=Path)
parser.add_argument("--riff-output-dir", required=True, type=Path)
parser.add_argument("--riff-host", required=True)
parser.add_argument("--riff-port", required=True, type=int)
args = parser.parse_args()

envelope = json.loads(args.riff_input.read_text(encoding="utf-8"))
mode = envelope["parameters"]["mode"]
if mode == "no_listener":
    time.sleep(10)
    raise SystemExit(0)
if mode == "premature_exit":
    raise SystemExit(7)

request_count = 0


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        global request_count
        request_count += 1
        if mode == "redirect":
            self.send_response(302)
            self.send_header("Location", "/other")
            self.end_headers()
            return
        if self.path != "/health":
            self.send_response(404)
            self.end_headers()
            return
        body = b'{"status":"ok"}\n'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: object) -> None:
        return


host = "0.0.0.0" if mode == "wildcard" else args.riff_host
server = HTTPServer((host, args.riff_port), Handler)
server.handle_request()
if mode == "stdout_overflow":
    sys.stdout.write("x" * 100_000)
    sys.stdout.flush()
    time.sleep(10)
elif mode in {"redirect", "linger"}:
    time.sleep(10)
elif mode == "listener_drift":
    time.sleep(0.2)
    server.server_close()
    replacement = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    replacement.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    replacement.bind(("0.0.0.0", args.riff_port))
    replacement.listen(1)
    time.sleep(10)
else:
    # Keep the exact listener present while the client consumes the response
    # and performs its mandatory post-response listener inspection.
    time.sleep(0.2)
server.server_close()
args.riff_output_dir.mkdir(parents=True, exist_ok=True)
encoded = (
    json.dumps(
        {
            "mode": mode,
            "requestCount": request_count,
            "sampleId": envelope["sampleId"],
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    + "\n"
)
if mode == "hardlink_output":
    source = args.riff_input.parent / "tmp" / "linked-summary.json"
    source.write_text(encoded, encoding="utf-8")
    os.link(source, args.riff_output_dir / "summary.json")
else:
    (args.riff_output_dir / "summary.json").write_text(encoded, encoding="utf-8")

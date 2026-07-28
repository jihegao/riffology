from __future__ import annotations

import argparse
import json
import signal
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any

from model import WindTurbineMaintenanceModel
import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse, Response
from starlette.routing import Route, WebSocketRoute
from starlette.websockets import WebSocket, WebSocketDisconnect


HTML = """<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>风机维护可视化推演</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main>
    <header class="hero">
      <div>
        <p class="eyebrow">MESA VISUAL SIMULATION</p>
        <h1>风机维护可视化推演</h1>
        <p class="lede">观察风机状态、维修队列、保障班组与系统可用度如何随仿真日推进。</p>
      </div>
      <div class="day-card"><span>仿真日</span><strong id="day">0</strong></div>
    </header>

    <section class="controls" aria-label="仿真控制">
      <button id="play" type="button">播放</button>
      <button id="step" type="button">单步</button>
      <button id="reset" type="button" class="secondary">重置</button>
      <label>速度
        <select id="speed">
          <option value="1200">慢速</option>
          <option value="600" selected>正常</option>
          <option value="250">快速</option>
        </select>
      </label>
      <span id="status" role="status">就绪</span>
    </section>

    <section class="metrics" aria-label="关键指标">
      <article><span>可用度</span><strong id="availability">—</strong></article>
      <article><span>机组运行</span><strong id="operating">—</strong></article>
      <article><span>故障等待</span><strong id="failed">—</strong></article>
      <article><span>维修队列</span><strong id="queue">—</strong></article>
      <article><span>班组利用率</span><strong id="utilization">—</strong></article>
    </section>

    <section class="workspace">
      <article class="panel farm-panel">
        <div class="panel-title">
          <div><p class="eyebrow">WIND FARM</p><h2>风场状态</h2></div>
          <ul class="legend">
            <li><i class="operating"></i>运行</li>
            <li><i class="waiting"></i>故障等待</li>
            <li><i class="repair"></i>维修</li>
            <li><i class="maintenance"></i>计划维护</li>
            <li><i class="replacement"></i>大修更换</li>
          </ul>
        </div>
        <svg id="farm" viewBox="0 0 100 64" role="img" aria-label="风机状态分布图"></svg>
      </article>

      <article class="panel">
        <div class="panel-title">
          <div><p class="eyebrow">TREND</p><h2>可用度与队列</h2></div>
        </div>
        <svg id="trend" viewBox="0 0 100 58" role="img" aria-label="可用度和维修队列趋势图">
          <path class="grid" d="M8 8H96M8 29H96M8 50H96"></path>
          <polyline id="availability-line" class="availability-line" points=""></polyline>
          <polyline id="queue-line" class="queue-line" points=""></polyline>
        </svg>
        <div class="trend-legend"><span class="availability-key">可用度</span><span class="queue-key">队列（归一化）</span></div>
        <h3>保障班组</h3>
        <div id="crews" class="crew-list"></div>
      </article>
    </section>

    <section class="panel events-panel">
      <div class="panel-title">
        <div><p class="eyebrow">EVENT STREAM</p><h2>最新事件</h2></div>
      </div>
      <ol id="events"></ol>
    </section>

    <footer>合成输入 · 单种子演示 · 不代表真实风场校准结果</footer>
  </main>
  <script src="app.js"></script>
</body>
</html>
"""


CSS = """
:root{color-scheme:dark;--bg:#07131b;--panel:#0d202b;--panel2:#102a35;--ink:#edf8f4;--muted:#91aaa8;--line:#24414a;--mint:#55e6b2;--cyan:#55c7e6;--amber:#f4be5b;--red:#ef6677;--violet:#aa8cff}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% 0,#123844 0,transparent 35%),var(--bg);color:var(--ink);font:14px/1.5 Inter,ui-sans-serif,system-ui,sans-serif}
main{max-width:1180px;margin:auto;padding:26px}.hero,.controls,.panel-title,.workspace{display:flex}.hero{align-items:flex-start;justify-content:space-between;gap:24px}.eyebrow{margin:0 0 5px;color:var(--mint);font-size:11px;font-weight:800;letter-spacing:.16em}.hero h1{font-size:32px;line-height:1.1;margin:0}.lede{color:var(--muted);margin:10px 0 0}.day-card{min-width:112px;padding:14px 18px;border:1px solid var(--line);border-radius:16px;background:#0b1c25;text-align:right}.day-card span{display:block;color:var(--muted);font-size:12px}.day-card strong{font-size:34px;color:var(--mint)}
.controls{align-items:center;gap:10px;margin:22px 0;padding:12px;border:1px solid var(--line);border-radius:14px;background:#091a23}.controls button,.controls select{border:1px solid #326070;border-radius:9px;background:#163947;color:var(--ink);padding:9px 14px;font-weight:700}.controls button{cursor:pointer}.controls button:hover{border-color:var(--mint)}.controls .secondary{background:transparent}.controls label{display:flex;align-items:center;gap:8px;color:var(--muted)}#status{margin-left:auto;color:var(--muted)}
.metrics{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:14px}.metrics article{padding:14px;border:1px solid var(--line);border-radius:13px;background:linear-gradient(145deg,var(--panel),#0b1922)}.metrics span{display:block;color:var(--muted);font-size:12px}.metrics strong{font-size:24px}
.workspace{align-items:stretch;gap:14px}.panel{border:1px solid var(--line);border-radius:16px;background:linear-gradient(150deg,var(--panel),#091820);padding:16px}.farm-panel{flex:1.55}.workspace>.panel:not(.farm-panel){flex:1}.panel-title{align-items:flex-start;justify-content:space-between;gap:12px}.panel h2{font-size:17px;margin:0}.panel h3{margin:10px 0 8px;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.1em}
.legend{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px 12px;margin:0;padding:0;list-style:none;color:var(--muted);font-size:10px}.legend i{display:inline-block;width:8px;height:8px;margin-right:4px;border-radius:50%}.legend .operating,.turbine.operating{fill:var(--mint);background:var(--mint)}.legend .waiting,.turbine.failed_waiting{fill:var(--red);background:var(--red)}.legend .repair,.turbine.corrective_repair{fill:var(--amber);background:var(--amber)}.legend .maintenance,.turbine.planned_maintenance{fill:var(--cyan);background:var(--cyan)}.legend .replacement,.turbine.major_replacement{fill:var(--violet);background:var(--violet)}
#farm{width:100%;min-height:340px;margin-top:10px;border-radius:12px;background:linear-gradient(#0b2732,#0a1d25)}.turbine{stroke:#dffbf0;stroke-width:.25;transition:fill .2s}.crew{fill:none;stroke:#fff;stroke-width:.7}.grid{fill:none;stroke:#27444b;stroke-width:.5}.availability-line,.queue-line{fill:none;stroke-width:1.7;stroke-linejoin:round}.availability-line{stroke:var(--mint)}.queue-line{stroke:var(--amber)}#trend{width:100%;margin-top:12px}.trend-legend{display:flex;gap:18px;color:var(--muted);font-size:11px}.availability-key:before,.queue-key:before{content:"";display:inline-block;width:18px;height:2px;margin:0 5px 3px 0;background:var(--mint)}.queue-key:before{background:var(--amber)}
.crew-list{display:grid;gap:7px}.crew-row{display:grid;grid-template-columns:60px 1fr auto;gap:8px;align-items:center}.crew-row span{color:var(--muted);font-size:11px}.crew-bar{height:6px;border-radius:5px;background:#1c3943;overflow:hidden}.crew-bar i{display:block;height:100%;background:var(--cyan)}
.events-panel{margin-top:14px}.events-panel ol{display:grid;grid-template-columns:repeat(2,1fr);gap:6px 18px;margin:8px 0 0;padding-left:22px;color:var(--muted)}.events-panel strong{color:var(--ink)}footer{padding:16px 2px;color:#667f80;font-size:11px}
@media(max-width:820px){main{padding:16px}.metrics{grid-template-columns:repeat(2,1fr)}.workspace{flex-direction:column}.events-panel ol{grid-template-columns:1fr}.hero h1{font-size:25px}.legend{justify-content:flex-start}.panel-title{flex-direction:column}}
"""


JS = r"""
const $ = (id) => document.getElementById(id);
let timer = null;
let history = [];
let busy = false;
let socket = null;
let heartbeat = null;
let reconnectTimer = null;

async function api(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function pct(value) { return `${(100 * Number(value || 0)).toFixed(1)}%`; }
function points(values, accessor, maximum = 1) {
  if (!values.length) return "";
  return values.map((value, index) => {
    const x = 8 + (88 * index / Math.max(1, values.length - 1));
    const y = 50 - 42 * Math.min(maximum, Math.max(0, accessor(value))) / maximum;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
}

function render(state) {
  const metrics = state.metrics;
  $("day").textContent = Math.round(metrics.sim_time_days);
  $("availability").textContent = pct(metrics.availability_fraction);
  $("operating").textContent = `${metrics.operating_count} / ${metrics.turbine_count}`;
  $("failed").textContent = metrics.failed_waiting_count;
  $("queue").textContent = metrics.corrective_queue_length + metrics.planned_queue_length;
  $("utilization").textContent = pct(metrics.crew_utilization_fraction);

  const farm = $("farm");
  farm.replaceChildren();
  for (const turbine of state.turbines) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    node.setAttribute("cx", 5 + 90 * turbine.x / state.bounds.width);
    node.setAttribute("cy", 5 + 54 * turbine.y / state.bounds.height);
    node.setAttribute("r", 1.15);
    node.setAttribute("class", `turbine ${turbine.state}`);
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = `${turbine.id}: ${turbine.state}`;
    node.append(title);
    farm.append(node);
  }
  for (const crew of state.crews) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    node.setAttribute("x", 5 + 90 * crew.x / state.bounds.width - 1.2);
    node.setAttribute("y", 5 + 54 * crew.y / state.bounds.height - 1.2);
    node.setAttribute("width", 2.4);
    node.setAttribute("height", 2.4);
    node.setAttribute("class", "crew");
    farm.append(node);
  }

  history.push({ availability: metrics.availability_fraction, queue: metrics.corrective_queue_length + metrics.planned_queue_length });
  history = history.slice(-60);
  $("availability-line").setAttribute("points", points(history, (item) => item.availability));
  const maxQueue = Math.max(1, ...history.map((item) => item.queue));
  $("queue-line").setAttribute("points", points(history, (item) => item.queue, maxQueue));

  const crews = $("crews");
  crews.replaceChildren();
  for (const crew of state.crews) {
    const row = document.createElement("div");
    row.className = "crew-row";
    const intensity = crew.state === "idle" ? 8 : crew.state === "working" ? 100 : 55;
    row.innerHTML = `<strong>${crew.id}</strong><div class="crew-bar"><i style="width:${intensity}%"></i></div><span>${crew.state}</span>`;
    crews.append(row);
  }

  const events = $("events");
  events.replaceChildren();
  for (const event of state.events.slice().reverse()) {
    const item = document.createElement("li");
    item.innerHTML = `<strong>${event.type}</strong> · day ${Number(event.time || 0).toFixed(2)}`;
    events.append(item);
  }
  $("status").textContent = state.complete ? "已到达仿真周期终点" : "运行正常";
  if (state.complete) pause();
}

async function refresh() {
  if (busy) return;
  busy = true;
  try { render(await api("api/state")); }
  catch (error) { $("status").textContent = `连接失败：${error.message}`; pause(); }
  finally { busy = false; }
}

function command(action) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    $("status").textContent = "控制通道尚未就绪";
    return;
  }
  socket.send(JSON.stringify({ action }));
}

function step() {
  command("step");
}

function pause() {
  if (timer) clearInterval(timer);
  timer = null;
  $("play").textContent = "播放";
}

function play() {
  if (timer) { pause(); return; }
  $("play").textContent = "暂停";
  timer = setInterval(step, Number($("speed").value));
}

$("play").addEventListener("click", play);
$("step").addEventListener("click", step);
$("reset").addEventListener("click", () => {
  pause(); history = [];
  command("reset");
});
$("speed").addEventListener("change", () => { if (timer) { pause(); play(); } });
function connect() {
  if (socket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(socket.readyState)) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  socket = new WebSocket(new URL("socket", location.href), ["riff.visual.v1"]);
  socket.onopen = () => {
    $("status").textContent = "控制通道已连接";
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = setInterval(() => command("state"), 15000);
    refresh();
  };
  socket.onmessage = (message) => {
    try { render(JSON.parse(message.data)); }
    catch { $("status").textContent = "收到无效的仿真状态"; pause(); }
  };
  socket.onerror = () => { $("status").textContent = "控制通道连接失败"; pause(); };
  socket.onclose = () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    socket = null;
    $("status").textContent = "控制通道重连中";
    pause();
    reconnectTimer = setTimeout(connect, 1000);
  };
}
connect();
"""


def _read_envelope(path: Path) -> tuple[dict[str, Any], int, int, int]:
    value = json.loads(path.read_text(encoding="utf-8"))
    parameters = dict(value["parameters"])
    horizon_days = int(parameters.pop("horizon_days"))
    warmup_days = int(parameters.pop("warmup_days"))
    seed = 2 if value.get("seed") is None else int(value["seed"])
    return parameters, horizon_days, warmup_days, seed


class Simulation:
    def __init__(self, parameters: dict[str, Any], horizon_days: int, warmup_days: int, seed: int) -> None:
        self.parameters = parameters
        self.horizon_days = horizon_days
        self.warmup_days = warmup_days
        self.seed = seed
        self.lock = threading.RLock()
        self.events: deque[dict[str, Any]] = deque(maxlen=12)
        self.model = self._new_model()

    def _new_model(self) -> WindTurbineMaintenanceModel:
        self.events.clear()

        def record(raw: dict[str, Any]) -> None:
            payload = raw.get("payload")
            event_time = payload.get("time_days", 0) if isinstance(payload, dict) else 0
            self.events.append({
                "type": str(raw.get("event_type", "event")),
                "time": event_time,
            })

        return WindTurbineMaintenanceModel(
            parameters=self.parameters,
            horizon_days=self.horizon_days,
            warmup_days=self.warmup_days,
            seed=self.seed,
            event_sink=record,
        )

    def reset(self) -> dict[str, Any]:
        with self.lock:
            self.model = self._new_model()
            return self.snapshot()

    def step(self) -> dict[str, Any]:
        with self.lock:
            if self.model._day_index < self.horizon_days:
                self.model.step()
            return self.snapshot()

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            metrics = self.model.snapshot()
            turbines = [
                {
                    "id": turbine.turbine_id,
                    "x": turbine.x_km,
                    "y": turbine.y_km,
                    "state": turbine.state.value,
                }
                for turbine in self.model.turbines.values()
            ]
            crews = [
                {
                    "id": crew.crew_id,
                    "x": crew.x_km,
                    "y": crew.y_km,
                    "state": crew.state.value,
                }
                for crew in self.model.crews.values()
            ]
            return {
                "schemaVersion": 1,
                "status": "complete" if self.model._day_index >= self.horizon_days else "running",
                "complete": self.model._day_index >= self.horizon_days,
                "bounds": {
                    "width": float(self.parameters["farm_width_km"]),
                    "height": float(self.parameters["farm_height_km"]),
                },
                "metrics": metrics,
                "turbines": turbines,
                "crews": crews,
                "events": list(self.events),
            }


def _headers() -> dict[str, str]:
    return {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    }


def _app(simulation: Simulation) -> Starlette:
    async def page(_request: Request) -> Response:
        return HTMLResponse(HTML, headers=_headers())

    async def style(_request: Request) -> Response:
        return Response(CSS, media_type="text/css", headers=_headers())

    async def script(_request: Request) -> Response:
        return Response(JS, media_type="text/javascript", headers=_headers())

    async def health(_request: Request) -> Response:
        return JSONResponse({"status": "healthy"}, headers=_headers())

    async def state(_request: Request) -> Response:
        return JSONResponse(simulation.snapshot(), headers=_headers())

    async def control(websocket: WebSocket) -> None:
        offered = websocket.headers.get("sec-websocket-protocol", "")
        if "riff.visual.v1" not in {
            item.strip() for item in offered.split(",") if item.strip()
        }:
            await websocket.close(code=1008)
            return
        await websocket.accept(subprotocol="riff.visual.v1")
        await websocket.send_json(simulation.snapshot())
        try:
            while True:
                value = json.loads(await websocket.receive_text())
                action = value.get("action") if isinstance(value, dict) else None
                if action == "state":
                    result = simulation.snapshot()
                elif action == "step":
                    result = simulation.step()
                elif action == "reset":
                    result = simulation.reset()
                else:
                    await websocket.close(code=1008)
                    return
                await websocket.send_json(result)
        except WebSocketDisconnect:
            return

    return Starlette(routes=[
        Route("/", page),
        Route("/index.html", page),
        Route("/style.css", style),
        Route("/app.js", script),
        Route("/health", health),
        Route("/api/state", state),
        Route("/inspection", state),
        WebSocketRoute("/socket", control),
    ])


def _cancellation_probe() -> None:
    signal.signal(signal.SIGTERM, lambda _signum, _frame: raise_exit())
    while True:
        time.sleep(0.05)


def raise_exit() -> None:
    raise SystemExit(0)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--riff-input", type=Path)
    parser.add_argument("--riff-output-dir", type=Path)
    parser.add_argument("--riff-host")
    parser.add_argument("--riff-port", type=int)
    parser.add_argument("--riff-cancellation-probe", action="store_true")
    parser.add_argument("--riff-health-check")
    args = parser.parse_args()

    if args.riff_cancellation_probe:
        _cancellation_probe()
    if args.riff_health_check is not None:
        return 0 if args.riff_health_check == "/health" else 2
    if args.riff_input is None or args.riff_output_dir is None or args.riff_host is None or args.riff_port is None:
        parser.error("visual runtime requires Riff input, output, host, and port")

    parameters, horizon_days, warmup_days, seed = _read_envelope(args.riff_input)
    args.riff_output_dir.mkdir(parents=True, exist_ok=True)
    simulation = Simulation(parameters, horizon_days, warmup_days, seed)
    uvicorn.run(
        _app(simulation),
        host=args.riff_host,
        port=args.riff_port,
        access_log=False,
        log_level="warning",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

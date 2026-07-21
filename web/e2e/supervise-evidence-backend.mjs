import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const integer = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
};
const command = (() => {
  if (!process.env.EVIDENCE_BACKEND_COMMAND_JSON) return ["npm", "start"];
  const value = JSON.parse(process.env.EVIDENCE_BACKEND_COMMAND_JSON);
  if (!Array.isArray(value) || value.length < 1 || value.some((item) => typeof item !== "string" || !item.length)) throw new Error("EVIDENCE_BACKEND_COMMAND_JSON must be a non-empty JSON string array.");
  return value;
})();
const backendDirectory = fileURLToPath(new URL("../../backend/", import.meta.url));
const backendOrigin = process.env.EVIDENCE_BACKEND_ORIGIN ?? "http://127.0.0.1:8787";
const controlPort = integer("EVIDENCE_CONTROL_PORT", 8788);
const healthAttempts = integer("EVIDENCE_HEALTH_ATTEMPTS", 160);
const healthDelayMs = integer("EVIDENCE_HEALTH_DELAY_MS", 50);
let backend = null;
let generation = 0;
let restarting = Promise.resolve();
let stopping = false;
let settleLifecycle;
let rejectLifecycle;
let lifecycleSettled = false;
const lifecycle = new Promise((resolve, reject) => { settleLifecycle = resolve; rejectLifecycle = reject; });

const controlServer = createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/restart") {
    response.writeHead(404, { "content-type": "application/json" }); response.end(JSON.stringify({ error: "not_found" })); return;
  }
  restarting = restarting.then(async () => { await stopBackend(); await startBackend(); return generation; });
  restarting.then(
    (currentGeneration) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ status: "restarted", generation: currentGeneration })); },
    async (error) => { response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify({ error: String(error) })); await fatal(error); }
  );
});

const waitForClose = (child) => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((resolve) => child.once("close", resolve));
const terminateAndWait = async (child) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = waitForClose(child); const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5_000);
  try { child.kill("SIGTERM"); } catch {}
  await closed; clearTimeout(timer);
};
const stopBackend = async () => { const child = backend; backend = null; await terminateAndWait(child); };
const closeControl = () => !controlServer.listening ? Promise.resolve() : new Promise((resolve) => controlServer.close(resolve));
const cleanup = async () => { stopping = true; await stopBackend(); await closeControl(); };
const fatal = (error) => {
  if (lifecycleSettled) return;
  lifecycleSettled = true; rejectLifecycle(error);
};
const shutdown = () => { if (!lifecycleSettled) { lifecycleSettled = true; settleLifecycle(); } };

// Install every last-resort cleanup hook before either the control socket or Backend child exists.
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);
process.on("exit", () => { if (backend && backend.exitCode === null && backend.signalCode === null) { try { backend.kill("SIGTERM"); } catch {} } });

const waitForHealth = async () => {
  let lastError;
  for (let attempt = 0; attempt < healthAttempts; attempt += 1) {
    try { const response = await fetch(`${backendOrigin}/health`); if (response.ok) return; lastError = new Error(`health returned ${response.status}`); }
    catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, healthDelayMs));
  }
  throw new Error(`Backend did not become healthy: ${String(lastError)}`);
};
const startBackend = async () => {
  generation += 1;
  const child = spawn(command[0], command.slice(1), { cwd: backendDirectory, env: { ...process.env, WORKSPACE_ROOT: process.env.WORKSPACE_ROOT, MESA_SERVICE_URL: process.env.MESA_SERVICE_URL ?? "http://127.0.0.1:8091", PORT: new URL(backendOrigin).port || "80" }, stdio: "inherit" });
  backend = child;
  child.once("exit", (code, signal) => { if (!stopping && backend === child) void fatal(new Error(`Evidence Backend exited unexpectedly (${code ?? signal}).`)); });
  try { await waitForHealth(); } catch (error) { if (backend === child) backend = null; await terminateAndWait(child); throw error; }
};
const listenControl = () => new Promise((resolve, reject) => {
  const onError = (error) => { controlServer.off("listening", onListening); reject(error); };
  const onListening = () => { controlServer.off("error", onError); resolve(); };
  controlServer.once("error", onError); controlServer.once("listening", onListening); controlServer.listen(controlPort, "127.0.0.1");
});

try {
  await listenControl();
  await startBackend();
  process.stdout.write(`Evidence Backend test supervisor listening on 127.0.0.1:${controlPort}.\n`);
  await lifecycle;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await cleanup();
}

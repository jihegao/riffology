import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";

const repository = realpathSync(resolve(import.meta.dirname, ".."));
const launcher = join(repository, "scripts", "start-local-demo.sh");
const temporary = realpathSync(mkdtempSync(join(tmpdir(), "start-local-demo-")));
const binDirectory = join(temporary, "bin"); mkdirSync(binDirectory);
const fakeExecutable = `#!/usr/bin/env node
const { basename } = require("node:path"); const { writeFileSync } = require("node:fs");
const service = basename(process.cwd()); const capture = process.env.STARTUP_CAPTURE_DIR;
writeFileSync(capture + "/" + service + ".json", JSON.stringify({ pid: process.pid, cwd: process.cwd(), args: process.argv.slice(2), env: { WORKSPACE_ROOT: process.env.WORKSPACE_ROOT, MESA_PORT: process.env.MESA_PORT, MESA_SERVICE_URL: process.env.MESA_SERVICE_URL, PORT: process.env.PORT, WEB_PORT: process.env.WEB_PORT, VITE_API_BASE_URL: process.env.VITE_API_BASE_URL } }));
const stop = () => { writeFileSync(capture + "/" + service + ".stopped", "stopped\\n"); process.exit(0); }; process.on("SIGTERM", stop); process.on("SIGINT", stop); setInterval(() => {}, 1000);
`;
for (const name of ["uv", "npm"]) { const executable = join(binDirectory, name); writeFileSync(executable, fakeExecutable); chmodSync(executable, 0o755); }

const waitFor = async (condition, label) => { for (let attempt = 0; attempt < 100; attempt += 1) { if (condition()) return; await new Promise((resolvePromise) => setTimeout(resolvePromise, 20)); } throw new Error(`Timed out waiting for ${label}.`); };
const exists = (file) => { try { readFileSync(file); return true; } catch { return false; } };
const runScenario = async (name, overrides, expected) => {
  const capture = join(temporary, `${name}-capture`); const workspace = join(temporary, `${name}-workspace`); mkdirSync(capture); mkdirSync(workspace);
  const environment = { ...process.env, PATH: `${binDirectory}:${process.env.PATH}`, STARTUP_CAPTURE_DIR: capture, WORKSPACE_ROOT: relative(repository, workspace), ...overrides };
  delete environment.MESA_SERVICE_URL; delete environment.VITE_API_BASE_URL;
  Object.assign(environment, overrides);
  const launcherProcess = spawn("bash", [launcher], { cwd: temporary, env: environment, stdio: ["ignore", "pipe", "pipe"] });
  const records = ["mesa_service", "backend", "web"];
  try {
    await waitFor(() => records.every((service) => exists(join(capture, `${service}.json`))), `${name} service captures`);
    launcherProcess.kill("SIGTERM");
    const launcherExit = await new Promise((resolvePromise) => launcherProcess.once("close", (code, signal) => resolvePromise({ code, signal })));
    assert.equal(launcherExit.code, 0);
    await waitFor(() => records.every((service) => exists(join(capture, `${service}.stopped`))), `${name} child cleanup`);
    const captured = Object.fromEntries(records.map((service) => [service, JSON.parse(readFileSync(join(capture, `${service}.json`), "utf8"))]));
    for (const service of records) { assert.equal(captured[service].env.WORKSPACE_ROOT, workspace); assert.throws(() => process.kill(captured[service].pid, 0), { code: "ESRCH" }); }
    assert.equal(captured.mesa_service.cwd, join(repository, "mesa_service")); assert.deepEqual(captured.mesa_service.args.slice(-2), ["--port", expected.mesaPort]);
    assert.equal(captured.backend.cwd, join(repository, "backend")); assert.deepEqual(captured.backend.args, ["start"]);
    assert.equal(captured.web.cwd, join(repository, "web")); assert.deepEqual(captured.web.args.slice(-2), ["--port", expected.webPort]);
    for (const service of records) { assert.equal(captured[service].env.MESA_PORT, expected.mesaPort); assert.equal(captured[service].env.MESA_SERVICE_URL, expected.mesaUrl); assert.equal(captured[service].env.PORT, expected.backendPort); assert.equal(captured[service].env.WEB_PORT, expected.webPort); assert.equal(captured[service].env.VITE_API_BASE_URL, expected.webApiUrl); }
    process.stdout.write(`ok ${name}\n`);
  } finally { if (launcherProcess.exitCode === null && launcherProcess.signalCode === null) launcherProcess.kill("SIGTERM"); }
};

try {
  await runScenario("derived-paired-ports", { MESA_PORT: "19091", PORT: "18787", WEB_PORT: "15173" }, { mesaPort: "19091", mesaUrl: "http://127.0.0.1:19091", backendPort: "18787", webPort: "15173", webApiUrl: "http://127.0.0.1:18787" });
  await runScenario("explicit-url-overrides", { MESA_PORT: "29091", MESA_SERVICE_URL: "http://127.0.0.1:39091", PORT: "28787", WEB_PORT: "25173", VITE_API_BASE_URL: "http://127.0.0.1:38787" }, { mesaPort: "29091", mesaUrl: "http://127.0.0.1:39091", backendPort: "28787", webPort: "25173", webApiUrl: "http://127.0.0.1:38787" });
} finally { rmSync(temporary, { recursive: true, force: true }); }

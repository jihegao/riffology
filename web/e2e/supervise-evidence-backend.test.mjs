import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const supervisor = fileURLToPath(new URL("./supervise-evidence-backend.mjs", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "evidence-supervisor-"));
const childScript = join(temporary, "child.mjs"); const marker = join(temporary, "started.txt"); const pidFile = join(temporary, "child.pid");
writeFileSync(childScript, `import { writeFileSync } from "node:fs"; writeFileSync(process.env.CHILD_MARKER, "started"); writeFileSync(process.env.CHILD_PID_FILE, String(process.pid)); process.on("SIGTERM", () => process.exit()); setInterval(() => {}, 1000);\n`);
const freePort = async () => new Promise((resolve) => { const server = createServer(); server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); }); });
const waitChild = (child) => new Promise((resolve) => { let stderr = ""; child.stderr.on("data", (data) => { stderr += data; }); child.once("close", (code, signal) => resolve({ code, signal, stderr })); });
const launch = (environment) => { const child = spawn(process.execPath, [supervisor], { env: { ...process.env, WORKSPACE_ROOT: temporary, EVIDENCE_BACKEND_COMMAND_JSON: JSON.stringify([process.execPath, childScript]), EVIDENCE_HEALTH_ATTEMPTS: "20", EVIDENCE_HEALTH_DELAY_MS: "20", CHILD_MARKER: marker, CHILD_PID_FILE: pidFile, ...environment }, stdio: ["ignore", "ignore", "pipe"] }); return { child, result: waitChild(child) }; };

test("occupied control port fails before spawning Backend", async () => {
  const occupied = createServer(); await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve)); const port = occupied.address().port;
  const { result } = launch({ EVIDENCE_CONTROL_PORT: String(port), EVIDENCE_BACKEND_ORIGIN: `http://127.0.0.1:${await freePort()}` }); const outcome = await result; await new Promise((resolve) => occupied.close(resolve));
  assert.equal(outcome.code, 1); assert.throws(() => readFileSync(marker));
});

test("health timeout terminates and waits for Backend child", async () => {
  const { result } = launch({ EVIDENCE_CONTROL_PORT: String(await freePort()), EVIDENCE_BACKEND_ORIGIN: `http://127.0.0.1:${await freePort()}` }); const outcome = await result;
  assert.equal(outcome.code, 1); assert.equal(existsSync(pidFile), true, outcome.stderr); const childPid = Number(readFileSync(pidFile, "utf8")); assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
});

process.on("exit", () => rmSync(temporary, { recursive: true, force: true }));

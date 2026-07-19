import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("optional installed OpenCode pure-server discovery smoke uses no provider credentials", { skip: process.env.RUN_OPENCODE_SMOKE !== "true" }, async (t) => {
  const port = await freePort();
  const emptyHome = await mkdtemp(join(tmpdir(), "riff-opencode-smoke-"));
  const child = spawn("opencode", ["serve", "--pure", "--hostname", "127.0.0.1", "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "", HOME: emptyHome },
  });
  t.after(async () => { child.kill("SIGTERM"); await rm(emptyHome, { recursive: true, force: true }); });
  await waitForHealth(`http://127.0.0.1:${port}/global/health`);
  const health = await fetch(`http://127.0.0.1:${port}/global/health`).then((response) => response.json());
  const providers = await fetch(`http://127.0.0.1:${port}/config/providers`).then((response) => response.json());
  assert.equal(health.healthy, true);
  assert.equal(typeof health.version, "string");
  assert.ok(Array.isArray(providers.providers));
});

const freePort = async (): Promise<number> => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close((error) => error ? reject(error) : resolve(typeof address === "object" && address ? address.port : 0));
  });
});

const waitForHealth = async (url: string): Promise<void> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* process is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("OpenCode pure server did not become healthy within five seconds.");
};

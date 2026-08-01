#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"

node - "${repo_root}" <<'NODE'
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { createServer } = require("node:net");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const repoRoot = process.argv[2];
const expectedVersion = "1.18.11";

const freePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close((error) => error
      ? reject(error)
      : resolve(typeof address === "object" && address ? address.port : 0));
  });
});

const readJson = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error(`${new URL(url).pathname} returned ${response.status}`);
  return response.json();
};

const waitForHealth = async (url) => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const health = await readJson(url);
      if (health.healthy === true) return health;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("OpenCode Server did not become healthy within six seconds");
};

const stop = async (child) => {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1_000))]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
};

(async () => {
  const port = await freePort();
  const emptyHome = mkdtempSync(join(tmpdir(), "riffology-opencode-runtime-"));
  const child = spawn("opencode", [
    "serve", "--pure", "--hostname", "127.0.0.1", "--port", String(port),
  ], {
    cwd: repoRoot,
    stdio: "ignore",
    env: { PATH: process.env.PATH ?? "", HOME: emptyHome },
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const health = await waitForHealth(`${baseUrl}/global/health`);
    const paths = await readJson(`${baseUrl}/path`);
    const providers = await readJson(`${baseUrl}/config/providers`);

    assert.equal(health.version, expectedVersion);
    assert.equal(paths.directory, repoRoot);
    assert.equal(paths.worktree, repoRoot);
    assert.ok(Array.isArray(providers.providers));
    console.log(`opencode runtime check: ${health.version}, exact path, and provider discovery passed`);
  } finally {
    await stop(child);
    rmSync(emptyHome, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
NODE

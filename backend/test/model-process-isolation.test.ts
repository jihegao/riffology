import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModelWorkspaceCapability, RestrictedProcessError, RestrictedProcessRunner } from "../src/restricted-process.ts";

const python = realpathSync("/usr/bin/python3");

test("restricted runner fixes command/cwd, scrubs ambient credentials and proxy variables", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "riff-process-env-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  process.env.OPENCODE_API_KEY = "api-secret-that-must-not-leak";
  process.env.HTTPS_PROXY = "http://proxy.invalid";
  t.after(() => { delete process.env.OPENCODE_API_KEY; delete process.env.HTTPS_PROXY; });
  const workspace = createModelWorkspaceCapability(root, "model:env");
  const runner = new RestrictedProcessRunner({
    workspace,
    command: { executable: python, argv: ["-I", "-c", "import json,os;print(json.dumps({'cwd':os.getcwd(),'keys':sorted(os.environ)}))"] },
  });
  const result = await runner.run();
  assert.equal(result.exitCode, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.cwd, workspace.root);
  assert.deepEqual(payload.keys, ["LANG", "LC_ALL", "PYTHONDONTWRITEBYTECODE", "PYTHONHASHSEED", "PYTHONNOUSERSITE", "TMPDIR", "__CF_USER_TEXT_ENCODING"]);
  assert.doesNotMatch(result.stdout + result.stderr, /secret|proxy/iu);
});

test("macOS sandbox denies a direct loopback network connection", { skip: process.platform !== "darwin" }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "riff-process-network-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runner = new RestrictedProcessRunner({
    workspace: createModelWorkspaceCapability(root, "model:network"),
    command: { executable: python, argv: ["-I", "-c", "import socket;socket.create_connection(('127.0.0.1',9),timeout=.2)"] },
  });
  const result = await runner.run();
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /not permitted|permission|operation/iu);
});

test("macOS sandbox cannot read an arbitrary home file outside the Model capability", { skip: process.platform !== "darwin" }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "riff-process-files-"));
  const outside = mkdtempSync(join(homedir(), ".riff-process-outside-"));
  const secret = join(outside, "credential.txt");
  writeFileSync(secret, "do-not-read");
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  const runner = new RestrictedProcessRunner({
    workspace: createModelWorkspaceCapability(root, "model:file-scope"),
    command: { executable: python, argv: ["-I", "-c", `from pathlib import Path;print(Path(${JSON.stringify(secret)}).read_text())`] },
  });
  const result = await runner.run();
  assert.notEqual(result.exitCode, 0);
  assert.doesNotMatch(result.stdout, /do-not-read/u);
});

test("timeout, output limit, and AbortSignal terminate the separate process group", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "riff-process-limits-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = createModelWorkspaceCapability(root, "model:limits");
  const timed = await new RestrictedProcessRunner({ workspace, command: { executable: python, argv: ["-I", "-c", "import time;time.sleep(30)"] }, limits: { timeoutMs: 100, terminateGraceMs: 50 } }).run();
  assert.equal(timed.timedOut, true);
  const output = await new RestrictedProcessRunner({ workspace, command: { executable: python, argv: ["-I", "-c", "print('x'*100000)"] }, limits: { maxOutputBytes: 1000, terminateGraceMs: 50 } }).run();
  assert.equal(output.outputLimitExceeded, true);
  assert.ok(Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr) <= 1000);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100).unref?.();
  const cancelled = await new RestrictedProcessRunner({ workspace, command: { executable: python, argv: ["-I", "-c", "import time;time.sleep(30)"] }, limits: { terminateGraceMs: 50 } }).run({ signal: controller.signal });
  assert.equal(cancelled.cancelled, true);
});

test("default isolation fails closed outside macOS and rejects broad runtime read roots", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "riff-process-closed-"));
  const outside = mkdtempSync(join(tmpdir(), "riff-process-outside-"));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  const workspace = createModelWorkspaceCapability(root, "model:closed");
  const runner = new RestrictedProcessRunner({ workspace, command: { executable: python, argv: ["-I", "-c", "pass"] }, isolation: { kind: "macos-sandbox", runtimeReadRoots: [outside] } });
  await assert.rejects(() => runner.run(), (error: unknown) => error instanceof RestrictedProcessError && error.code === "invalid_runtime_root");
});

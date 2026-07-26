import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { HttpOpenCodeAdapter, normalizeOpenCodeWorkdir, opencodeFromEnvironment } from "../src/opencode-adapter.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const launcher = join(repositoryRoot, "scripts", "start-local-demo.sh");

test("configured OpenCode workdir is canonicalized independently of the caller path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "riff-opencode-workdir-"));
  const workspace = join(root, "workspace");
  const alias = join(root, "workspace-alias");
  await mkdir(workspace);
  await symlink(workspace, alias);
  t.after(() => rm(root, { recursive: true, force: true }));

  // The launcher resolves this before it changes into backend/, so a symlinked
  // configuration cannot make the OpenCode process inherit the caller's cwd.
  assert.equal(normalizeOpenCodeWorkdir(alias), await realpath(workspace));
  assert.throws(() => normalizeOpenCodeWorkdir("relative/workspace"), /absolute/u);
  assert.throws(() => normalizeOpenCodeWorkdir(join(root, "missing")), /exist|directory/u);
  const file = join(root, "not-a-directory");
  await writeFile(file, "not a workspace\n");
  assert.throws(() => normalizeOpenCodeWorkdir(file), /directory/u);
});

test("live OpenCode requires explicit workdir and expected version without contacting the server", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "riff-opencode-required-profile-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  t.after(() => rm(root, { recursive: true, force: true }));

  for (const [config, code] of [
    [{ expectedVersion: "1.18.4" }, "opencode_workdir_unconfigured"],
    [{ workdir: workspace }, "opencode_version_unconfigured"],
  ] as const) {
    let requests = 0;
    const adapter = new HttpOpenCodeAdapter({
      baseUrl: "http://127.0.0.1:4096",
      model: "provider-z/model-2",
      ...config,
      fetch: async () => { requests += 1; throw new Error("configuration errors must not contact OpenCode"); },
    });
    const readiness = await adapter.initialize();
    assert.equal(readiness.status, "error");
    assert.equal(readiness.modelId, null);
    assert.equal(readiness.lastError?.code, code);
    assert.equal(requests, 0);
  }
});

test("invalid live workdir is deferred to stable readiness instead of crashing construction", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "riff-opencode-invalid-workdir-"));
  const missing = join(root, "missing");
  const file = join(root, "not-a-directory");
  await writeFile(file, "not a workspace\n");
  t.after(() => rm(root, { recursive: true, force: true }));

  for (const workdir of ["relative/workspace", missing, file]) {
    let requests = 0;
    let adapter: HttpOpenCodeAdapter | undefined;
    assert.doesNotThrow(() => {
      adapter = opencodeFromEnvironment({
        OPENCODE_URL: "http://127.0.0.1:4096",
        OPENCODE_MODEL: "provider-z/model-2",
        OPENCODE_WORKDIR: workdir,
        OPENCODE_EXPECTED_VERSION: "1.18.4",
      });
    });
    // Supply a request spy through the direct constructor as well; both entry
    // points must defer the same validation instead of terminating the process.
    const direct = new HttpOpenCodeAdapter({
      baseUrl: "http://127.0.0.1:4096",
      model: "provider-z/model-2",
      workdir,
      expectedVersion: "1.18.4",
      fetch: async () => { requests += 1; throw new Error("invalid workdir must not contact OpenCode"); },
    });
    const readiness = await direct.initialize();
    assert.equal(readiness.status, "error");
    assert.equal(readiness.modelId, null);
    assert.equal(readiness.lastError?.code, "opencode_invalid_workdir");
    assert.equal(requests, 0);
    assert.ok(adapter);
  }
});

test("invalid expected version is deferred to stable readiness without server requests", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "riff-opencode-invalid-version-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  t.after(() => rm(root, { recursive: true, force: true }));

  for (const expectedVersion of ["   ", "1.18.4\nforged", "v".repeat(101)]) {
    let requests = 0;
    let adapter: HttpOpenCodeAdapter | undefined;
    assert.doesNotThrow(() => {
      adapter = new HttpOpenCodeAdapter({
        baseUrl: "http://127.0.0.1:4096",
        model: "provider-z/model-2",
        workdir: workspace,
        expectedVersion,
        fetch: async () => { requests += 1; throw new Error("invalid version must not contact OpenCode"); },
      });
    });
    const readiness = await adapter!.initialize();
    assert.equal(readiness.status, "error");
    assert.equal(readiness.modelId, null);
    assert.equal(readiness.lastError?.code, "opencode_invalid_version");
    assert.equal(requests, 0);
  }
});

test("failed mandatory readiness gates every live OpenCode surface without network access", async () => {
  let requests = 0;
  const adapter = new HttpOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    model: "provider-z/model-2",
    expectedVersion: "1.18.4",
    fetch: async () => { requests += 1; throw new Error("an unready adapter must not contact OpenCode"); },
  });
  const readiness = await adapter.initialize();
  assert.equal(readiness.lastError?.code, "opencode_workdir_unconfigured");

  const gatedCalls: Array<[() => Promise<unknown>, string]> = [
    [() => adapter.discoverProviderModels(), "opencode_workdir_unconfigured"],
    [() => adapter.getSession("opaque-session"), "opencode_workdir_unconfigured"],
    [() => adapter.createSession("conversation-a"), "opencode_workdir_unconfigured"],
    [() => adapter.promptWithModel(
      "opaque-session",
      { providerId: "provider-z", modelId: "model-2" },
      { text: "hello", system: "bounded", attachments: [] },
    ), "opencode_workdir_unconfigured"],
    [() => adapter.prompt("opaque-session", { text: "hello", system: "bounded", attachments: [] }), "opencode_workdir_unconfigured"],
    [() => adapter.bindProject("project-a", "http://127.0.0.1:8787"), "opencode_workdir_unconfigured"],
    [() => adapter.bindScopedMcp("scope-a", "http://127.0.0.1:8787/a2/mcp?cap=opaque-capability"), "opencode_workdir_unconfigured"],
    [() => adapter.subscribeEvents(() => undefined), "opencode_workdir_unconfigured"],
  ];
  for (const [call, code] of gatedCalls) {
    await assert.rejects(call, (error: any) => error.code === code);
  }
  assert.equal(requests, 0);
});

test("launcher canonicalizes valid workdirs and preserves invalid overrides for Agent-only read-only degradation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "riff-opencode-launcher-"));
  const tools = join(root, "tools");
  const nested = join(root, "unrelated", "nested");
  await Promise.all([mkdir(tools), mkdir(nested, { recursive: true })]);
  const fakeNpm = join(tools, "npm");
  await writeFile(fakeNpm, "#!/bin/sh\nif [ \"$1\" = start ]; then printf '%s' \"$OPENCODE_WORKDIR\" > \"$RIFF_CAPTURE\"; fi\n");
  await chmod(fakeNpm, 0o755);
  t.after(() => rm(root, { recursive: true, force: true }));

  const expected = await realpath(repositoryRoot);
  for (const cwd of [repositoryRoot, nested]) {
    const capture = join(root, `capture-${cwd === repositoryRoot ? "root" : "nested"}`);
    await runLauncher(cwd, { RIFF_CAPTURE: capture, PATH: `${tools}:/usr/bin:/bin`, RIFF_MODEL_PYTHON: process.execPath });
    assert.equal((await readFile(capture, "utf8")).trim(), expected);
  }
  const invalidFile = join(root, "not-a-directory");
  await writeFile(invalidFile, "not a workspace\n");
  for (const [name, invalid] of [
    ["relative", "relative/workspace"],
    ["missing", join(root, "missing")],
    ["file", invalidFile],
  ]) {
    const capture = join(root, `capture-${name}`);
    await runLauncher(nested, {
      RIFF_CAPTURE: capture,
      PATH: `${tools}:/usr/bin:/bin`,
      RIFF_MODEL_PYTHON: process.execPath,
      OPENCODE_WORKDIR: invalid,
      RIFF_SKIP_OPENCODE: "false",
    });
    assert.equal((await readFile(capture, "utf8")).trim(), invalid);
  }
});

test("a ready adapter revalidates version and directory before reusing a session", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "riff-opencode-drift-"));
  const workspace = join(root, "workspace");
  const driftedWorkspace = join(root, "drifted");
  await Promise.all([mkdir(workspace), mkdir(driftedWorkspace)]);
  t.after(() => rm(root, { recursive: true, force: true }));
  let version = "1.18.4";
  let reportedDirectory = workspace;
  let sessionRequests = 0;
  const adapter = new HttpOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    model: "provider-z/model-2",
    workdir: workspace,
    expectedVersion: "1.18.4",
    fetch: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/global/health") {
        return Response.json({ healthy: true, version });
      }
      if (url.pathname === "/path") {
        return Response.json({ directory: reportedDirectory });
      }
      if (url.pathname === "/config/providers") {
        return Response.json({
          providers: [{ id: "provider-z", models: { "model-2": {} } }],
        });
      }
      if (url.pathname === "/session/opaque-session") {
        sessionRequests += 1;
        return Response.json({
          id: "opaque-session",
          directory: reportedDirectory,
        });
      }
      throw new Error(`unexpected OpenCode endpoint ${url.pathname}`);
    },
  });

  assert.equal((await adapter.initialize()).status, "ready");
  assert.equal(await adapter.getSession("opaque-session"), true);
  assert.equal(sessionRequests, 1);

  version = "1.19.0";
  await assert.rejects(
    () => adapter.getSession("opaque-session"),
    (error: any) => error.code === "opencode_version_mismatch",
  );
  assert.equal(sessionRequests, 1);

  version = "1.18.4";
  reportedDirectory = driftedWorkspace;
  await assert.rejects(
    () => adapter.getSession("opaque-session"),
    (error: any) => error.code === "opencode_workdir_mismatch",
  );
  assert.equal(sessionRequests, 1);

  reportedDirectory = workspace;
  assert.equal(await adapter.getSession("opaque-session"), true);
  assert.equal(sessionRequests, 2);
});

test("OpenCode readiness requires healthy versioned server and matching canonical path before provider discovery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "riff-opencode-readiness-"));
  const workspace = join(root, "workspace");
  const alias = join(root, "workspace-alias");
  await mkdir(workspace);
  await symlink(workspace, alias);
  t.after(() => rm(root, { recursive: true, force: true }));

  const calls: string[] = [];
  const adapter = new HttpOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    model: "provider-z/model-2",
    workdir: alias,
    expectedVersion: "1.18.4",
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      calls.push(path);
      if (path === "/global/health") return Response.json({ healthy: true, version: "1.18.4" });
      if (path === "/path") return Response.json({ directory: workspace });
      if (path === "/config/providers") return Response.json({ providers: [{ id: "provider-z", models: { "model-2": {} } }] });
      throw new Error(`unexpected OpenCode endpoint ${path}`);
    },
  });

  assert.deepEqual(await adapter.initialize(), { status: "ready", modelId: "provider-z/model-2", version: "1.18.4" });
  assert.deepEqual(calls, ["/global/health", "/path", "/config/providers"]);
});

test("loopback and server-auth contract remains available with the mandatory live profile", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "riff-opencode-auth-profile-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls: Array<{ path: string; authorization: string | null }> = [];
  const adapter = new HttpOpenCodeAdapter({
    baseUrl: "http://[::1]:4096",
    model: "provider-z/model-2",
    workdir: workspace,
    expectedVersion: "1.18.4",
    serverUsername: "riff",
    serverPassword: "local-only-secret",
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push({ path, authorization: new Headers(init?.headers).get("authorization") });
      if (path === "/global/health") return Response.json({ healthy: true, version: "1.18.4" });
      if (path === "/path") return Response.json({ directory: workspace });
      if (path === "/config/providers") return Response.json({ providers: [{ id: "provider-z", models: { "model-2": {} } }] });
      throw new Error(`unexpected OpenCode endpoint ${path}`);
    },
  });

  assert.equal((await adapter.initialize()).status, "ready");
  assert.deepEqual(calls.map((call) => call.path), ["/global/health", "/path", "/config/providers"]);
  assert.equal(calls.every((call) => call.authorization === "Basic cmlmZjpsb2NhbC1vbmx5LXNlY3JldA=="), true);
});

test("OpenCode readiness fails closed for unhealthy, unversioned, or malformed-path servers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "riff-opencode-readiness-invalid-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  t.after(() => rm(root, { recursive: true, force: true }));

  for (const health of [{ healthy: false, version: "1.18.4" }, { healthy: true }]) {
    let providerCalls = 0;
    const adapter = new HttpOpenCodeAdapter({
      baseUrl: "http://127.0.0.1:4096",
      model: "provider-z/model-2",
      workdir: workspace,
      expectedVersion: "1.18.4",
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === "/global/health") return Response.json(health);
        if (path === "/config/providers") providerCalls += 1;
        throw new Error(`unexpected OpenCode endpoint ${path}`);
      },
    });
    const readiness = await adapter.initialize();
    assert.equal(readiness.status, "error");
    assert.equal(readiness.modelId, null);
    assert.equal(providerCalls, 0);
  }

  const malformedPath = new HttpOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    model: "provider-z/model-2",
    workdir: workspace,
    expectedVersion: "1.18.4",
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/global/health") return Response.json({ healthy: true, version: "1.18.4" });
      if (path === "/path") return Response.json({ directory: 42 });
      throw new Error(`unexpected OpenCode endpoint ${path}`);
    },
  });
  const readiness = await malformedPath.initialize();
  assert.equal(readiness.status, "error");
  assert.equal(readiness.modelId, null);
  assert.equal(readiness.lastError?.code, "opencode_unavailable");
});

test("an incompatible OpenCode version fails before path or provider discovery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "riff-opencode-version-mismatch-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls: string[] = [];
  const adapter = new HttpOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    model: "provider-z/model-2",
    workdir: workspace,
    expectedVersion: "1.18.4",
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      calls.push(path);
      if (path === "/global/health") return Response.json({ healthy: true, version: "1.19.0" });
      throw new Error(`OpenCode readiness must stop before ${path}`);
    },
  });

  const readiness = await adapter.initialize();
  assert.equal(readiness.status, "error");
  assert.equal(readiness.modelId, null);
  assert.equal(readiness.lastError?.code, "opencode_version_mismatch");
  assert.deepEqual(calls, ["/global/health"]);
});

test("a declared OpenCode path mismatch leaves Riff explicitly read-only before provider discovery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "riff-opencode-path-mismatch-"));
  const workspace = join(root, "workspace");
  const otherWorkspace = join(root, "other-workspace");
  await Promise.all([mkdir(workspace), mkdir(otherWorkspace)]);
  t.after(() => rm(root, { recursive: true, force: true }));

  let providerCalls = 0;
  const adapter = new HttpOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    model: "provider-z/model-2",
    workdir: workspace,
    expectedVersion: "1.18.4",
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/global/health") return Response.json({ healthy: true, version: "1.18.4" });
      if (path === "/path") return Response.json({ directory: otherWorkspace });
      if (path === "/config/providers") providerCalls += 1;
      throw new Error(`unexpected OpenCode endpoint ${path}`);
    },
  });

  const readiness = await adapter.initialize();
  assert.equal(readiness.status, "error");
  assert.equal(readiness.modelId, null);
  assert.equal(readiness.lastError?.code, "opencode_workdir_mismatch");
  assert.equal(providerCalls, 0);
});

const runLauncher = (cwd: string, overrides: Record<string, string>): Promise<void> => new Promise((resolvePromise, reject) => {
  const child = spawn("/bin/bash", [launcher], {
    cwd,
    env: { ...process.env, ...overrides },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", reject);
  child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(stderr.trim() || `launcher exited ${code}`)));
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "..");
const backendRoot = join(repoRoot, "backend");

test("production entry honors app/broker ports and Vite proxies with the exact IPv6 Host", {
  timeout: 30_000,
}, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "riff-network-entry-")));
  const appPort = await freePort("::1");
  const brokerPort = await distinctFreePort("::1", appPort);
  const vitePort = await freePort("127.0.0.1");
  const python = await approvedPython();
  const children = [];
  try {
    const backend = spawn(process.execPath, ["--experimental-strip-types", "src/index.ts"], {
      cwd: backendRoot,
      env: {
        ...process.env,
        MESA_SERVICE_URL: "",
        PORT: String(appPort),
        RIFF_MODEL_PYTHON: python,
        RIFF_PRODUCT_ROOT: join(root, "product"),
        RIFF_SKIP_OPENCODE: "true",
        RIFF_VISUAL_BROKER_PORT: String(brokerPort),
        WORKSPACE_ROOT: join(root, "workspace"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(backend);
    await waitForOutput(
      backend,
      `Riff visual broker listening at http://[::1]:${brokerPort}`,
    );

    const health = await httpRequest("::1", appPort, "/health", {
      host: `[::1]:${appPort}`,
    });
    assert.equal(health.status, 200);
    assert.equal(health.body.healthy, true);
    const wrongHost = await httpRequest("::1", appPort, "/health", {
      host: `localhost:${appPort}`,
    });
    assert.equal(wrongHost.status, 421);
    assert.equal(wrongHost.body.error.code, "platform_host_denied");
    const broker = await httpRequest("::1", brokerPort, "/not-minted", {
      host: `[::1]:${brokerPort}`,
    });
    assert.equal(broker.status, 404);
    assert.equal(broker.body.error.code, "broker_route_denied");

    const vite = spawn(
      process.execPath,
      [
        join(webRoot, "node_modules", "vite", "bin", "vite.js"),
        "--host",
        "127.0.0.1",
        "--port",
        String(vitePort),
        "--strictPort",
      ],
      {
        cwd: webRoot,
        env: {
          ...process.env,
          RIFF_PLATFORM_APP_PORT: String(appPort),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    children.push(vite);
    await waitForOutput(vite, `http://127.0.0.1:${vitePort}/`);

    const proxied = await httpRequest("127.0.0.1", vitePort, "/api/sessions", {
      host: `127.0.0.1:${vitePort}`,
      method: "POST",
    });
    assert.equal(proxied.status, 201);
    assert.match(proxied.body.sessionId, /^session_[0-9a-f-]{36}$/u);
  } finally {
    await Promise.allSettled(children.reverse().map(stopChild));
    await rm(root, { recursive: true, force: true });
  }
});

const approvedPython = async () => {
  const candidates = [
    process.env.RIFF_MODEL_PYTHON,
    join(repoRoot, "mesa_service", ".venv", "bin", "python"),
    "/usr/bin/python3",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next local approved runtime candidate.
    }
  }
  throw new Error("The production-entry integration test requires an executable local Python runtime.");
};

const freePort = async (host) => await new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen({ host, port: 0, ipv6Only: host === "::1" }, () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      reject(new Error(`No TCP address was allocated for ${host}.`));
      return;
    }
    server.close((error) => error ? reject(error) : resolvePort(address.port));
  });
});

const distinctFreePort = async (host, excluded) => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = await freePort(host);
    if (candidate !== excluded) return candidate;
  }
  throw new Error(`Could not allocate a distinct local port on ${host}.`);
};

const waitForOutput = async (child, expected) => await new Promise((resolveWait, reject) => {
  let output = "";
  const timeout = setTimeout(() => {
    cleanup();
    reject(new Error(`Timed out waiting for child output: ${expected}\n${output}`));
  }, 15_000);
  const onData = (chunk) => {
    output += chunk.toString("utf8");
    if (output.includes(expected)) {
      cleanup();
      resolveWait();
    }
  };
  const onExit = (code, signal) => {
    cleanup();
    reject(new Error(`Child exited before readiness (${code ?? signal}): ${output}`));
  };
  const cleanup = () => {
    clearTimeout(timeout);
    child.stdout?.off("data", onData);
    child.stderr?.off("data", onData);
    child.off("exit", onExit);
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.once("exit", onExit);
});

const httpRequest = async (hostname, port, path, options) => await new Promise((resolveRequest, reject) => {
  const outgoing = request({
    family: hostname === "::1" ? 6 : 4,
    headers: { host: options.host },
    hostname,
    method: options.method ?? "GET",
    path,
    port,
  }, (response) => {
    const chunks = [];
    response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    response.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      resolveRequest({
        status: response.statusCode ?? 0,
        body: text ? JSON.parse(text) : {},
      });
    });
  });
  outgoing.once("error", reject);
  outgoing.end();
});

const stopChild = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolveStop) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolveStop();
    }, 5_000);
    timeout.unref?.();
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveStop();
    });
  });
};

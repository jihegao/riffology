import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { request, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BrowserNetworkAddress } from "../src/browser-network-topology.ts";
import { BackendApp } from "../src/server.ts";

test("recovery-only Product startup serves a CSP shell and denies every authority surface", async (t) => {
  const repositoryRoot = await realpath(
    await mkdtemp(join(tmpdir(), "riff-recovery-only-")),
  );
  const staticWebRoot = join(repositoryRoot, "web", "dist");
  await mkdir(join(staticWebRoot, "assets"), { recursive: true });
  await writeFile(
    join(staticWebRoot, "index.html"),
    "<!doctype html><html><head><meta name=\"riffology-server-legacy-product-ui\" content=\"false\" /></head><body><div id=\"root\"></div><script type=\"module\" src=\"/assets/app.js\"></script></body></html>",
  );
  await writeFile(join(staticWebRoot, "assets", "app.js"), "globalThis.riffProduct = true;\n");
  const app = new BackendApp({
    productOnly: true,
    recoveryStatus: {
      state: "recovery_required",
      code: "product_recovery_failed",
      observedAt: "2026-07-25T00:00:00.000Z",
      retryable: false,
    },
    repositoryRoot,
    staticWebRoot,
  });
  await app.initialize();
  const network = await app.listenBrowserNetwork();
  t.after(async () => {
    await app.close();
    await rm(repositoryRoot, { recursive: true, force: true });
  });

  const shell = await raw(network.app, "GET", "/?mode=legacy");
  assert.equal(shell.status, 200);
  assert.match(shell.text, /id="root"/u);
  assert.match(shell.text, /riffology-server-legacy-product-ui" content="false"/u);
  assert.equal(shell.headers["cache-control"], "no-store");
  assert.match(
    String(shell.headers["content-security-policy"]),
    /default-src 'none'; script-src 'self'; style-src 'self'/u,
  );
  assert.match(
    String(shell.headers["content-security-policy"]),
    /frame-ancestors 'none'/u,
  );
  assert.equal(shell.headers["referrer-policy"], "no-referrer");
  assert.equal(shell.headers["permissions-policy"], "camera=(), microphone=(), geolocation=()");

  const defaultWorkbench = await raw(network.app, "GET", "/workbench/new/workspace_7");
  assert.equal(defaultWorkbench.status, 200);
  assert.match(defaultWorkbench.text, /id="root"/u);

  const ownerWorkbench = await raw(network.app, "GET", "/workbench/projects/project_7");
  assert.equal(ownerWorkbench.status, 200);

  const historicalOwnerLink = await raw(network.app, "GET", "/projects/project_7");
  assert.equal(historicalOwnerLink.status, 404);

  const asset = await raw(network.app, "GET", "/assets/app.js");
  assert.equal(asset.status, 200);
  assert.equal(asset.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(asset.headers["content-security-policy"], "default-src 'none'; sandbox");

  const traversal = await raw(network.app, "GET", "/assets/%2e%2e%2findex.html");
  assert.equal(traversal.status, 404);
  assert.doesNotMatch(traversal.text, /id="root"/u);

  const boundary = {
    origin: network.app.origin,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
  };
  const bootstrap = await raw(
    network.app,
    "POST",
    "/api/browser-session/bootstrap",
    boundary,
  );
  assert.equal(bootstrap.status, 201);
  const admitted = {
    ...boundary,
    cookie: cookiePair(bootstrap.headers["set-cookie"]),
  };
  const recovery = await raw(network.app, "GET", "/api/recovery-status", admitted);
  assert.equal(recovery.status, 200);
  assert.deepEqual(recovery.json, {
    state: "recovery_required",
    code: "product_recovery_failed",
    observedAt: "2026-07-25T00:00:00.000Z",
    retryable: false,
  });
  assert.equal(recovery.headers["cache-control"], "private, no-store");
  assert.doesNotMatch(recovery.text, /(?:\/Users\/|product\.sqlite|\.riff-workspace|manifest)/u);

  for (const path of [
    "/api/home",
    "/api/models",
    "/api/projects",
    "/api/conversations/conversation-one",
    "/api/projects/project-one/runs/run-one/visual-frame-session",
  ]) {
    const denied = await raw(network.app, "GET", path, admitted);
    assert.equal(denied.status, 503);
    assert.equal(denied.json.error.code, "recovery_required");
  }

  const host = await raw(
    network.app,
    "GET",
    "/browser/projects/project-one/runs/run-one/visual",
    {
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "none",
    },
  );
  assert.equal(host.status, 503);
  assert.equal(host.json.error.code, "recovery_required");

  const broker = await raw(network.broker, "GET", "/frame/redeem/not-minted");
  assert.equal(broker.status, 503);
  assert.equal(broker.json.error.code, "recovery_required");
  const upgrade = await raw(network.broker, "GET", "/frame/c/not-minted/ws", {
    connection: "Upgrade",
    upgrade: "websocket",
    "sec-websocket-version": "13",
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
  });
  assert.equal(upgrade.status, 503);
  assert.match(upgrade.text, /recovery_required/u);
});

test("explicit local rollback admits legacy Product owner refresh routes only on the server flag", async (t) => {
  const repositoryRoot = await realpath(
    await mkdtemp(join(tmpdir(), "riff-legacy-rollback-")),
  );
  const staticWebRoot = join(repositoryRoot, "web", "dist");
  await mkdir(join(staticWebRoot, "assets"), { recursive: true });
  await writeFile(
    join(staticWebRoot, "index.html"),
    "<!doctype html><html><head><meta name=\"riffology-server-legacy-product-ui\" content=\"false\" /></head><body><div id=\"root\"></div><script type=\"module\" src=\"/assets/app.js\"></script></body></html>",
  );
  await writeFile(join(staticWebRoot, "assets", "app.js"), "globalThis.riffProduct = true;\n");
  const app = new BackendApp({
    productOnly: true,
    recoveryStatus: {
      state: "recovery_required",
      code: "product_recovery_failed",
      observedAt: "2026-07-25T00:00:00.000Z",
      retryable: false,
    },
    repositoryRoot,
    staticWebRoot,
    staticLegacyProductRoutes: true,
  });
  await app.initialize();
  const network = await app.listenBrowserNetwork();
  t.after(async () => {
    await app.close();
    await rm(repositoryRoot, { recursive: true, force: true });
  });

  for (const path of [
    "/models/model_rollback",
    "/projects/project_rollback",
    "/workbench/projects/project_rollback",
  ]) {
    const response = await raw(network.app, "GET", path);
    assert.equal(response.status, 200, path);
    assert.match(response.text, /id="root"/u, path);
    assert.match(response.text, /riffology-server-legacy-product-ui" content="true"/u, path);
  }
  assert.equal((await raw(network.app, "GET", "/models/../secret")).status, 404);
  assert.equal((await raw(network.app, "GET", "/projects/project/extra")).status, 404);
});

const raw = async (
  address: BrowserNetworkAddress,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  json: any;
}> => new Promise((resolveRequest, reject) => {
  const bootstrap = method === "POST" && path === "/api/browser-session/bootstrap";
  const body = bootstrap ? "{}" : "";
  const outgoing = request({
    family: 6,
    headers: {
      host: address.authority,
      ...(bootstrap
        ? { "content-type": "application/json", "content-length": "2" }
        : {}),
      ...headers,
    },
    host: address.host,
    method,
    path,
    port: address.port,
  }, (response) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    response.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let json: any = {};
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = {};
      }
      resolveRequest({
        status: response.statusCode ?? 0,
        headers: response.headers,
        text,
        json,
      });
    });
  });
  outgoing.once("error", reject);
  outgoing.end(body);
});

const cookiePair = (header: string | string[] | undefined): string => {
  const value = Array.isArray(header) ? header[0] : header;
  assert.ok(value);
  return value.split(";", 1)[0]!;
};

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BROWSER_LOOPBACK_HOST,
  BrowserNetworkTopology,
  BrowserNetworkTopologyError,
  networkJson,
  rejectUpgrade,
  type BrowserNetworkAddress,
} from "../src/browser-network-topology.ts";
import { BackendApp } from "../src/server.ts";
import type { MesaAdapter, MesaRunRequest } from "../src/mesa-adapter.ts";
import type { OpenCodeAdapter, OpenCodePrompt, OpenCodeReadiness } from "../src/opencode-adapter.ts";
import type { MesaModel, MesaResults, MesaRun } from "../src/types.ts";

test("platform app and broker exact-bind distinct IPv6 loopback sockets with localhost authorities", async (t) => {
  const topology = await BrowserNetworkTopology.start({
    appHandler: (_request, response, address) => networkJson(response, 200, {
      role: "platform",
      authority: address.authority,
    }),
    brokerHandler: (_request, response) => networkJson(response, 404, {
      accepted: false,
      error: { code: "broker_route_denied" },
    }),
  });
  t.after(() => topology.close());

  assert.equal(topology.app.host, BROWSER_LOOPBACK_HOST);
  assert.equal(topology.broker.host, BROWSER_LOOPBACK_HOST);
  assert.notEqual(topology.app.port, topology.broker.port);
  assert.equal(topology.app.origin, `http://localhost:${topology.app.port}`);
  assert.equal(topology.broker.origin, `http://localhost:${topology.broker.port}`);
  assert.equal(Object.isFrozen(topology.app), true);
  assert.equal(Object.isFrozen(topology.broker), true);
  const ipv4App = await rawAt("127.0.0.1", 4, topology.app, {
    method: "GET",
    path: "/health",
  });
  assert.equal(ipv4App.status, 421);
  assert.equal(ipv4App.body.error.code, "ipv4_authority_denied");
  const ipv4Broker = await rawAt("127.0.0.1", 4, topology.broker, {
    method: "GET",
    path: "/",
  });
  assert.equal(ipv4Broker.status, 421);
  assert.equal(ipv4Broker.body.error.code, "ipv4_authority_denied");

  const takeover = createServer();
  await assert.rejects(
    new Promise<void>((resolve, reject) => {
      takeover.once("error", reject);
      takeover.listen({ host: "127.0.0.1", port: topology.broker.port }, resolve);
    }),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "EADDRINUSE",
  );

  const app = await raw(topology.app, { method: "GET", path: "/health" });
  assert.equal(app.status, 200);
  assert.equal(app.body.role, "platform");
  const broker = await raw(topology.broker, { method: "GET", path: "/not-minted" });
  assert.equal(broker.status, 404);
  assert.equal(broker.body.error.code, "broker_route_denied");
});

test("Host guards fail before either application handler", async (t) => {
  let appCalls = 0;
  let brokerCalls = 0;
  const topology = await BrowserNetworkTopology.start({
    appHandler: (_request, response) => {
      appCalls += 1;
      networkJson(response, 204, {});
    },
    brokerHandler: (_request, response) => {
      brokerCalls += 1;
      networkJson(response, 204, {});
    },
  });
  t.after(() => topology.close());

  for (const host of [
    `[::1]:${topology.app.port}`,
    `127.0.0.1:${topology.app.port}`,
    `[::1]`,
    "localhost",
    `localhost:${topology.broker.port}`,
    `[0:0:0:0:0:0:0:1]:${topology.app.port}`,
  ]) {
    const denied = await raw(topology.app, { method: "GET", path: "/", host });
    assert.equal(denied.status, 421);
    assert.equal(denied.body.error.code, "platform_host_denied");
  }

  const allowed = await raw(topology.app, {
    method: "POST",
    path: "/api/mutate",
  });
  assert.equal(allowed.status, 204);
  assert.equal(appCalls, 1);

  const brokerHost = await raw(topology.broker, {
    method: "GET",
    path: "/frame",
    host: `localhost:${topology.app.port}`,
  });
  assert.equal(brokerHost.status, 421);
  assert.equal(brokerHost.body.error.code, "broker_host_denied");
  const navigation = await raw(topology.broker, { method: "GET", path: "/frame" });
  assert.equal(navigation.status, 204);
  assert.equal(brokerCalls, 1);
});

test("invalid or colliding configured ports fail closed", async () => {
  const handler = (_request: unknown, response: any): void => networkJson(response, 204, {});
  await assert.rejects(
    BrowserNetworkTopology.start({ appPort: 42_000, brokerPort: 42_000, appHandler: handler, brokerHandler: handler }),
    (error: unknown) => error instanceof BrowserNetworkTopologyError
      && error.code === "platform_listener_invalid",
  );
  for (const port of [-1, 65_536, 1.5, Number.NaN]) {
    await assert.rejects(
      BrowserNetworkTopology.start({ appPort: port, appHandler: handler, brokerHandler: handler }),
      (error: unknown) => error instanceof BrowserNetworkTopologyError
        && error.code === "platform_listener_invalid",
    );
  }
  await assert.rejects(
    BrowserNetworkTopology.start({
      closeDrainTimeoutMs: 0,
      appHandler: handler,
      brokerHandler: handler,
    }),
    (error: unknown) => error instanceof BrowserNetworkTopologyError
      && error.code === "platform_listener_invalid",
  );
});

test("beforeReady completes before either listener admits requests and rolls back on failure", async () => {
  let hookEntered!: () => void;
  let releaseHook!: () => void;
  const entered = new Promise<void>((resolve) => {
    hookEntered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releaseHook = resolve;
  });
  let appAddress: BrowserNetworkAddress | undefined;
  const starting = BrowserNetworkTopology.start({
    beforeReady: async ({ app }) => {
      appAddress = app;
      hookEntered();
      await blocked;
    },
    appHandler: (_request, response) => networkJson(response, 204, {}),
    brokerHandler: (_request, response) => networkJson(response, 204, {}),
  });
  await entered;
  assert.ok(appAddress);
  const denied = await raw(appAddress, { method: "GET", path: "/" });
  assert.equal(denied.status, 503);
  releaseHook();
  const topology = await starting;
  assert.equal((await raw(topology.app, { method: "GET", path: "/" })).status, 204);
  await topology.close();

  let rejectedAddress: BrowserNetworkAddress | undefined;
  let rejectedGuardClosed: Promise<void> | undefined;
  await assert.rejects(
    BrowserNetworkTopology.start({
      beforeReady: async ({ app }) => {
        rejectedAddress = app;
        const guardSocket = connect({ host: "127.0.0.1", port: app.port });
        await new Promise<void>((resolve, reject) => {
          guardSocket.once("connect", resolve);
          guardSocket.once("error", reject);
        });
        rejectedGuardClosed = new Promise<void>((resolve) => {
          guardSocket.once("close", resolve);
        });
        guardSocket.write("GET / HTTP/1.1\r\n");
        throw new Error("configuration rejected");
      },
      appHandler: (_request, response) => networkJson(response, 204, {}),
      brokerHandler: (_request, response) => networkJson(response, 204, {}),
    }),
    /configuration rejected/u,
  );
  assert.ok(rejectedAddress);
  assert.ok(rejectedGuardClosed);
  await rejectedGuardClosed;
  await assert.rejects(
    rawAt(BROWSER_LOOPBACK_HOST, 6, rejectedAddress, { method: "GET", path: "/" }),
    closedConnection,
  );
  await assert.rejects(
    rawAt("127.0.0.1", 4, rejectedAddress, { method: "GET", path: "/" }),
    closedConnection,
  );
});

test("broker bind failure never admits an app request and releases partial startup", async () => {
  const appReservation = createServer();
  await new Promise<void>((resolve, reject) => {
    appReservation.once("error", reject);
    appReservation.listen({ host: BROWSER_LOOPBACK_HOST, port: 0, ipv6Only: true }, resolve);
  });
  const appReservationAddress = appReservation.address();
  assert.ok(appReservationAddress && typeof appReservationAddress !== "string");
  const appPort = appReservationAddress.port;
  await new Promise<void>((resolve, reject) =>
    appReservation.close((error) => error ? reject(error) : resolve()));

  const occupied = createServer();
  await new Promise<void>((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen({ host: BROWSER_LOOPBACK_HOST, port: 0, ipv6Only: true }, resolve);
  });
  const occupiedAddress = occupied.address();
  assert.ok(occupiedAddress && typeof occupiedAddress !== "string");
  let handlerCalls = 0;
  try {
    await assert.rejects(
      BrowserNetworkTopology.start({
        appPort,
        brokerPort: occupiedAddress.port,
        appHandler: (_request, response) => {
          handlerCalls += 1;
          networkJson(response, 204, {});
        },
        brokerHandler: (_request, response) => networkJson(response, 204, {}),
      }),
      (error: unknown) => error instanceof BrowserNetworkTopologyError
        && error.code === "broker_listener_unavailable",
    );
    assert.equal(handlerCalls, 0);
    const rebound = createServer();
    await new Promise<void>((resolve, reject) => {
      rebound.once("error", reject);
      rebound.listen({ host: BROWSER_LOOPBACK_HOST, port: appPort, ipv6Only: true }, resolve);
    });
    await new Promise<void>((resolve, reject) =>
      rebound.close((error) => error ? reject(error) : resolve()));
  } finally {
    await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
  }
});

test("sync and async handler failures return bounded generic errors", async (t) => {
  const topology = await BrowserNetworkTopology.start({
    appHandler: () => {
      throw new Error("sensitive sync detail");
    },
    brokerHandler: async () => {
      throw new Error("sensitive async detail");
    },
  });
  t.after(() => topology.close());
  const app = await raw(topology.app, { method: "GET", path: "/" });
  assert.equal(app.status, 500);
  assert.equal(app.body.error.code, "platform_request_failed");
  assert.doesNotMatch(JSON.stringify(app.body), /sensitive/u);
  const broker = await raw(topology.broker, { method: "GET", path: "/" });
  assert.equal(broker.status, 500);
  assert.equal(broker.body.error.code, "broker_request_failed");
  assert.doesNotMatch(JSON.stringify(broker.body), /sensitive/u);
});

test("broker header overflow returns the frozen bounded limit error", async (t) => {
  const topology = await BrowserNetworkTopology.start({
    appHandler: (_request, response) => networkJson(response, 204, {}),
    brokerHandler: (_request, response) => networkJson(response, 204, {}),
  });
  t.after(() => topology.close());
  const response = await new Promise<string>((resolve, reject) => {
    const socket = connect({
      family: 6,
      host: topology.broker.host,
      port: topology.broker.port,
    });
    const chunks: Buffer[] = [];
    socket.once("connect", () => {
      socket.write([
        "GET /frame/c/not-real/ HTTP/1.1",
        `Host: ${topology.broker.authority}`,
        `X-Oversized: ${"x".repeat(33 * 1_024)}`,
        "",
        "",
      ].join("\r\n"));
    });
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.once("error", reject);
  });
  assert.match(response, /^HTTP\/1\.1 502 Bad Gateway\r\n/u);
  assert.match(response, /"code":"visual_frame_proxy_limit_exceeded"/u);
  assert.doesNotMatch(response, /x{128}/u);
});

test("upgrade routing rejects the app, exact-gates broker Host, and close destroys tracked sockets", async () => {
  let brokerUpgrades = 0;
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const topology = await BrowserNetworkTopology.start({
    appHandler: (_request, response) => networkJson(response, 204, {}),
    brokerHandler: (_request, response) => networkJson(response, 204, {}),
    brokerUpgradeHandler: (_request, _socket) => {
      brokerUpgrades += 1;
      entered();
    },
  });
  const appDenied = await rawUpgrade(topology.app, topology.app.authority);
  assert.match(appDenied, /^HTTP\/1\.1 404 Not Found\r\n/u);
  assert.match(appDenied, /"code":"platform_upgrade_denied"/u);
  const brokerDenied = await rawUpgrade(topology.broker, topology.app.authority);
  assert.match(brokerDenied, /^HTTP\/1\.1 421 Misdirected Request\r\n/u);
  assert.equal(brokerUpgrades, 0);

  const client = connect({
    family: 6,
    host: topology.broker.host,
    port: topology.broker.port,
  });
  const clientClosed = new Promise<void>((resolve, reject) => {
    client.once("close", resolve);
    client.once("error", reject);
  });
  await new Promise<void>((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
  client.write([
    "GET /frame/c/opaque/ws HTTP/1.1",
    `Host: ${topology.broker.authority}`,
    "Connection: Upgrade",
    "Upgrade: websocket",
    "",
    "",
  ].join("\r\n"));
  await enteredPromise;
  assert.equal(brokerUpgrades, 1);
  await topology.close();
  await clientClosed;
});

test("upgrade rejection preserves the 504 Gateway Timeout contract", async (t) => {
  const topology = await BrowserNetworkTopology.start({
    appHandler: (_request, response) => networkJson(response, 404, {}),
    brokerHandler: (_request, response) => networkJson(response, 404, {}),
    brokerUpgradeHandler: (_request, socket) =>
      rejectUpgrade(socket, 504, "visual_websocket_timeout"),
  });
  t.after(() => topology.close());

  const response = await rawUpgrade(topology.broker, topology.broker.authority);
  assert.match(response, /^HTTP\/1\.1 504 Gateway Timeout\r\n/u);
  assert.match(response, /"code":"visual_websocket_timeout"/u);
});

test("close stops admission, drains an in-flight handler, and releases both ports", async () => {
  let release!: () => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const handlerRelease = new Promise<void>((resolve) => {
    release = resolve;
  });
  const topology = await BrowserNetworkTopology.start({
    appHandler: async (_request, response) => {
      entered();
      await handlerRelease;
      networkJson(response, 204, {});
    },
    brokerHandler: (_request, response) => networkJson(response, 404, {}),
  });
  const pendingRequest = raw(topology.app, { method: "GET", path: "/slow" });
  await enteredPromise;
  let closed = false;
  const closing = topology.close().then(() => {
    closed = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  release();
  assert.equal((await pendingRequest).status, 204);
  await closing;
  await assert.rejects(
    rawAt(BROWSER_LOOPBACK_HOST, 6, topology.app, { method: "GET", path: "/" }),
    closedConnection,
  );
  await assert.rejects(
    rawAt(BROWSER_LOOPBACK_HOST, 6, topology.broker, { method: "GET", path: "/" }),
    closedConnection,
  );
});

test("close bounds incomplete IPv4 denial-guard requests and releases both authorities", async () => {
  const topology = await BrowserNetworkTopology.start({
    closeDrainTimeoutMs: 10,
    appHandler: (_request, response) => networkJson(response, 204, {}),
    brokerHandler: (_request, response) => networkJson(response, 404, {}),
  });
  const guardSocket = connect({
    host: "127.0.0.1",
    port: topology.app.port,
  });
  await new Promise<void>((resolve, reject) => {
    guardSocket.once("connect", resolve);
    guardSocket.once("error", reject);
  });
  guardSocket.write("GET / HTTP/1.1\r\n");
  const guardClosed = new Promise<void>((resolve) => {
    guardSocket.once("close", resolve);
  });

  await topology.close();
  await guardClosed;
  await assert.rejects(
    rawAt(BROWSER_LOOPBACK_HOST, 6, topology.app, { method: "GET", path: "/" }),
    closedConnection,
  );
  await assert.rejects(
    rawAt("127.0.0.1", 4, topology.app, { method: "GET", path: "/" }),
    closedConnection,
  );
});

test("close terminates a long-lived response after finite handlers drain", async () => {
  let responseStarted!: () => void;
  const responseStartedPromise = new Promise<void>((resolve) => {
    responseStarted = resolve;
  });
  const topology = await BrowserNetworkTopology.start({
    appHandler: (_request, response) => {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        connection: "keep-alive",
      });
      response.write("event: ready\ndata: {}\n\n");
    },
    brokerHandler: (_request, response) => networkJson(response, 404, {}),
  });
  const clientClosed = new Promise<void>((resolve, reject) => {
    const outgoing = request({
      family: 6,
      headers: { host: topology.app.authority },
      host: topology.app.host,
      method: "GET",
      path: "/events",
      port: topology.app.port,
    }, (response) => {
      response.once("data", () => responseStarted());
      response.once("close", resolve);
      response.once("error", (error) => {
        if (closedConnection(error)) resolve();
        else reject(error);
      });
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
  await responseStartedPromise;
  await topology.close();
  await clientClosed;
  await assert.rejects(
    rawAt(BROWSER_LOOPBACK_HOST, 6, topology.app, { method: "GET", path: "/" }),
    closedConnection,
  );
});

test("close applies a bounded drain before forcing a stuck handler connection closed", async () => {
  let responseStarted!: () => void;
  const responseStartedPromise = new Promise<void>((resolve) => {
    responseStarted = resolve;
  });
  const topology = await BrowserNetworkTopology.start({
    closeDrainTimeoutMs: 10,
    appHandler: async (_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("started");
      await new Promise<void>(() => undefined);
    },
    brokerHandler: (_request, response) => networkJson(response, 404, {}),
  });
  const clientClosed = new Promise<void>((resolve, reject) => {
    const outgoing = request({
      family: 6,
      headers: { host: topology.app.authority },
      host: topology.app.host,
      method: "GET",
      path: "/stuck",
      port: topology.app.port,
    }, (response) => {
      response.once("data", () => responseStarted());
      response.once("close", resolve);
      response.once("error", (error) => {
        if (closedConnection(error)) resolve();
        else reject(error);
      });
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
  await responseStartedPromise;
  await topology.close();
  await clientClosed;
  await assert.rejects(
    rawAt(BROWSER_LOOPBACK_HOST, 6, topology.app, { method: "GET", path: "/" }),
    closedConnection,
  );
});

test("BackendApp exposes its real health route only through the guarded app origin", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "riff-browser-network-"));
  const app = new BackendApp({
    mesa: new NetworkFakeMesa(),
    openCode: new NetworkFakeOpenCode(),
    workspaceRoot: workspace,
  });
  await app.initialize();
  const topology = await app.listenBrowserNetwork();
  t.after(async () => {
    await app.close();
    await rm(workspace, { recursive: true, force: true });
  });

  const health = await raw(topology.app, { method: "GET", path: "/health" });
  assert.equal(health.status, 200);
  assert.equal(health.body.healthy, true);
  const mutation = await raw(topology.app, {
    method: "POST",
    path: "/api/sessions",
  });
  assert.equal(mutation.status, 201);

  const broker = await raw(topology.broker, { method: "GET", path: "/anything" });
  assert.equal(broker.status, 404);
  assert.equal(broker.body.error.code, "broker_route_denied");
});

test("BackendApp serializes concurrent browser starts and close cannot leave a listener alive", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "riff-browser-network-race-"));
  const app = new BackendApp({
    mesa: new NetworkFakeMesa(),
    openCode: new NetworkFakeOpenCode(),
    workspaceRoot: workspace,
  });
  await app.initialize();
  try {
    const [first, second] = await Promise.all([
      app.listenBrowserNetwork(),
      app.listenBrowserNetwork(),
    ]);
    assert.deepEqual(second, first);
    const closing = app.close();
    const rejectedLegacy = app.listen();
    await closing;
    await assert.rejects(rejectedLegacy, /already active or closed/u);
    await assert.rejects(
      rawAt(BROWSER_LOOPBACK_HOST, 6, first.app, { method: "GET", path: "/health" }),
      closedConnection,
    );
    await assert.rejects(app.listenBrowserNetwork(), /already active or closed/u);
  } finally {
    await app.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("BackendApp rolls back a failed legacy listen before browser-network retry", async () => {
  const occupied = createServer();
  await new Promise<void>((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const occupiedAddress = occupied.address();
  assert.ok(occupiedAddress && typeof occupiedAddress !== "string");
  const workspace = await mkdtemp(join(tmpdir(), "riff-browser-network-retry-"));
  const app = new BackendApp({
    mesa: new NetworkFakeMesa(),
    openCode: new NetworkFakeOpenCode(),
    workspaceRoot: workspace,
  });
  await app.initialize();
  try {
    await assert.rejects(app.listen(occupiedAddress.port), (error: unknown) =>
      (error as NodeJS.ErrnoException).code === "EADDRINUSE");
    const network = await app.listenBrowserNetwork();
    assert.equal((await raw(network.app, { method: "GET", path: "/health" })).status, 200);
  } finally {
    await app.close();
    await rm(workspace, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
  }
});

test("BackendApp retries browser topology after broker bind failure releases its fixed app port", async () => {
  const appReservation = createServer();
  await new Promise<void>((resolve, reject) => {
    appReservation.once("error", reject);
    appReservation.listen({ host: BROWSER_LOOPBACK_HOST, port: 0, ipv6Only: true }, resolve);
  });
  const appReservationAddress = appReservation.address();
  assert.ok(appReservationAddress && typeof appReservationAddress !== "string");
  const appPort = appReservationAddress.port;
  await new Promise<void>((resolve, reject) =>
    appReservation.close((error) => error ? reject(error) : resolve()));

  const occupiedBroker = createServer();
  await new Promise<void>((resolve, reject) => {
    occupiedBroker.once("error", reject);
    occupiedBroker.listen({ host: BROWSER_LOOPBACK_HOST, port: 0, ipv6Only: true }, resolve);
  });
  const occupiedBrokerAddress = occupiedBroker.address();
  assert.ok(occupiedBrokerAddress && typeof occupiedBrokerAddress !== "string");

  const workspace = await mkdtemp(join(tmpdir(), "riff-browser-network-browser-retry-"));
  const app = new BackendApp({
    mesa: new NetworkFakeMesa(),
    openCode: new NetworkFakeOpenCode(),
    workspaceRoot: workspace,
  });
  await app.initialize();
  try {
    await assert.rejects(
      app.listenBrowserNetwork(appPort, occupiedBrokerAddress.port),
      (error: unknown) => error instanceof BrowserNetworkTopologyError
        && error.code === "broker_listener_unavailable",
    );
    const rebound = createServer();
    await new Promise<void>((resolve, reject) => {
      rebound.once("error", reject);
      rebound.listen({ host: BROWSER_LOOPBACK_HOST, port: appPort, ipv6Only: true }, resolve);
    });
    await new Promise<void>((resolve, reject) =>
      rebound.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) =>
      occupiedBroker.close((error) => error ? reject(error) : resolve()));

    const network = await app.listenBrowserNetwork(appPort, 0);
    assert.equal(network.app.port, appPort);
    assert.notEqual(network.broker.port, appPort);
    assert.equal((await raw(network.app, { method: "GET", path: "/health" })).status, 200);
  } finally {
    await app.close();
    if (occupiedBroker.listening) {
      await new Promise<void>((resolve, reject) =>
        occupiedBroker.close((error) => error ? reject(error) : resolve()));
    }
    await rm(workspace, { recursive: true, force: true });
  }
});

type RawOptions = {
  method: string;
  path: string;
  host?: string;
  origin?: string;
  fetchSite?: string;
};

const raw = async (
  address: BrowserNetworkAddress,
  options: RawOptions,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: any }> =>
  rawAt(address.host, 6, address, options);

const rawAt = async (
  connectHost: string,
  family: 4 | 6,
  address: BrowserNetworkAddress,
  options: RawOptions,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: any }> =>
  new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: options.host ?? address.authority };
    if (options.origin !== undefined) headers.origin = options.origin;
    if (options.fetchSite !== undefined) headers["sec-fetch-site"] = options.fetchSite;
    const outgoing = request({
      family,
      headers,
      host: connectHost,
      method: options.method,
      path: options.path,
      port: address.port,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: text ? JSON.parse(text) : {},
        });
      });
    });
    outgoing.once("error", reject);
    outgoing.end();
  });

const rawUpgrade = async (
  address: BrowserNetworkAddress,
  host: string,
): Promise<string> => new Promise((resolve, reject) => {
  const socket = connect({ family: 6, host: address.host, port: address.port });
  const chunks: Buffer[] = [];
  socket.once("connect", () => {
    socket.write([
      "GET /frame/c/opaque/ws HTTP/1.1",
      `Host: ${host}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      "",
      "",
    ].join("\r\n"));
  });
  socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  socket.once("error", reject);
});

class NetworkFakeMesa implements MesaAdapter {
  async loadModel(): Promise<MesaModel> {
    throw new Error("unused");
  }
  async startRun(_projectId: string, _request: MesaRunRequest): Promise<MesaRun> {
    throw new Error("unused");
  }
  async getRun(): Promise<MesaRun> {
    throw new Error("unused");
  }
  async cancelRun(): Promise<MesaRun> {
    throw new Error("unused");
  }
  async getResults(): Promise<MesaResults> {
    throw new Error("unused");
  }
}

const closedConnection = (error: unknown): boolean =>
  ["ECONNREFUSED", "ECONNRESET"].includes((error as NodeJS.ErrnoException).code ?? "");

class NetworkFakeOpenCode implements OpenCodeAdapter {
  async initialize(): Promise<OpenCodeReadiness> {
    return { status: "unconfigured", modelId: null };
  }
  async createSession(): Promise<string> {
    throw new Error("unused");
  }
  async prompt(_sessionId: string, _prompt: OpenCodePrompt): Promise<void> {
    throw new Error("unused");
  }
  async abort(): Promise<void> {}
}

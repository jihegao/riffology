import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BROWSER_LOOPBACK_HOST,
  BrowserNetworkTopology,
  BrowserNetworkTopologyError,
  networkJson,
  type BrowserNetworkAddress,
} from "../src/browser-network-topology.ts";
import { BackendApp } from "../src/server.ts";
import type { MesaAdapter, MesaRunRequest } from "../src/mesa-adapter.ts";
import type { OpenCodeAdapter, OpenCodePrompt, OpenCodeReadiness } from "../src/opencode-adapter.ts";
import type { MesaModel, MesaResults, MesaRun } from "../src/types.ts";

test("platform app and broker exact-bind distinct IPv6 loopback origins", async (t) => {
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
  assert.equal(topology.app.origin, `http://[::1]:${topology.app.port}`);
  assert.equal(topology.broker.origin, `http://[::1]:${topology.broker.port}`);
  assert.equal(Object.isFrozen(topology.app), true);
  assert.equal(Object.isFrozen(topology.broker), true);
  await assert.rejects(
    rawAt("127.0.0.1", 4, topology.app, { method: "GET", path: "/health" }),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ECONNREFUSED",
  );
  await assert.rejects(
    rawAt("127.0.0.1", 4, topology.broker, { method: "GET", path: "/" }),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ECONNREFUSED",
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
    `localhost:${topology.app.port}`,
    `127.0.0.1:${topology.app.port}`,
    `[::1]`,
    `[::1]:${topology.broker.port}`,
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
    host: `[::1]:${topology.app.port}`,
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

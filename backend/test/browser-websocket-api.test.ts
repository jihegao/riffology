import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import type {
  BrowserFrameConnectedPeer,
  BrowserFrameTarget,
  BrowserFrameTargetResolver,
} from "../src/browser-frame-capability.ts";
import { BrowserFrameInspectionTimeoutError } from "../src/browser-frame-capability.ts";
import type { BrowserNetworkAddress } from "../src/browser-network-topology.ts";
import type { MesaAdapter, MesaRunRequest } from "../src/mesa-adapter.ts";
import type { OpenCodeAdapter, OpenCodePrompt, OpenCodeReadiness } from "../src/opencode-adapter.ts";
import { BackendApp } from "../src/server.ts";
import type { MesaModel, MesaResults, MesaRun } from "../src/types.ts";

const POLICY = Object.freeze({
  path: "/socket",
  subprotocols: Object.freeze(["riff.echo"]),
  maxFrameBytes: 4_096,
  maxConnections: 2,
  idleTimeoutMs: 10_000,
});

test("BackendApp enforces the real broker WebSocket boundary and closes live sockets on rotation and shutdown", {
  timeout: 20_000,
}, async (t) => {
  const capturedLogs: string[] = [];
  const originalConsole = {
    error: console.error,
    info: console.info,
    log: console.log,
    warn: console.warn,
  };
  for (const level of Object.keys(originalConsole) as Array<keyof typeof originalConsole>) {
    console[level] = (...values: unknown[]) => {
      capturedLogs.push(values.map((value) =>
        typeof value === "string" ? value : JSON.stringify(value)).join(" "));
    };
  }
  t.after(() => {
    Object.assign(console, originalConsole);
  });
  const childRequests: Array<{
    url: string | undefined;
    headers: IncomingHttpHeaders;
  }> = [];
  let childMode: "echo" | "redirect" | "non-101" = "echo";
  const childServer = createServer();
  const childWebSockets = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    handleProtocols: (protocols) => protocols.has("riff.echo") ? "riff.echo" : false,
  });
  childServer.on("upgrade", (incoming, socket, head) => {
    childRequests.push({ url: incoming.url, headers: incoming.headers });
    if (childMode === "redirect") {
      socket.end([
        "HTTP/1.1 302 Found",
        "Connection: close",
        "Location: http://child-redirect-sentinel.invalid/private",
        "Content-Length: 0",
        "",
        "",
      ].join("\r\n"));
      return;
    }
    if (childMode === "non-101") {
      socket.end([
        "HTTP/1.1 200 OK",
        "Connection: close",
        "X-Child-Sentinel: child-non-101-sentinel",
        "Content-Length: 0",
        "",
        "",
      ].join("\r\n"));
      return;
    }
    childWebSockets.handleUpgrade(incoming, socket, head, (webSocket) => {
      childWebSockets.emit("connection", webSocket, incoming);
    });
  });
  childWebSockets.on("connection", (webSocket) => {
    webSocket.on("message", (data, isBinary) => webSocket.send(data, { binary: isBinary }));
  });
  await new Promise<void>((resolve, reject) => {
    childServer.once("error", reject);
    childServer.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const childAddress = childServer.address();
  assert.ok(childAddress && typeof childAddress !== "string");
  t.after(async () => {
    for (const client of childWebSockets.clients) client.terminate();
    await new Promise<void>((resolve) => childWebSockets.close(() => resolve()));
    await new Promise<void>((resolve, reject) =>
      childServer.close((error) => error ? reject(error) : resolve()));
  });

  const target: BrowserFrameTarget = Object.freeze({
    projectId: "project_ws",
    runId: "run_ws",
    attemptGeneration: 7,
    port: childAddress.port,
    expiresAtMs: Date.now() + 120_000,
    webSocket: POLICY,
  });
  const connectedPeers: BrowserFrameConnectedPeer[] = [];
  let connectedInspectionTimesOut = false;
  const targets: BrowserFrameTargetResolver = {
    resolve: async (projectId, runId) =>
      projectId === target.projectId && runId === target.runId ? target : null,
    inspect: async (candidate) => exactTarget(candidate, target),
    inspectConnectedPeer: async (candidate, peer) => {
      if (connectedInspectionTimesOut) throw new BrowserFrameInspectionTimeoutError();
      connectedPeers.push(peer);
      return exactTarget(candidate, target)
        && peer.localHost === "127.0.0.1"
        && peer.remoteHost === "127.0.0.1"
        && peer.remotePort === target.port
        && Number.isSafeInteger(peer.localPort);
    },
  };
  const workspace = await mkdtemp(join(tmpdir(), "riff-websocket-api-"));
  let app: BackendApp | undefined;
  let appClosed = false;
  t.after(async () => {
    if (app && !appClosed) await app.close();
    await rm(workspace, { recursive: true, force: true });
  });
  app = new BackendApp({
    mesa: new WebSocketFakeMesa(),
    openCode: new WebSocketFakeOpenCode(),
    workspaceRoot: workspace,
    a2ProductRoot: join(workspace, "product"),
    a3BatchSupervisor: unusedSupervisor() as any,
    a3VisualSupervisor: unusedSupervisor() as any,
    browserFrameTargetResolver: targets,
  });
  await app.initialize();
  const network = await app.listenBrowserNetwork();

  const browserOnlySecret = "browser-only-header-secret";
  let session = await mintFrameSession(app, network, target);
  const secretSentinels = Object.freeze([
    cookieValue(session.appCookie),
    session.csrfToken,
    session.frameUrl,
    new URL(session.frameUrl).pathname.split("/").at(-1)!,
    session.base.split("/").filter(Boolean).at(-1)!,
    cookieValue(session.brokerCookie),
    browserOnlySecret,
    "child-redirect-sentinel",
    "child-non-101-sentinel",
  ]);
  const secretNeedles = Object.freeze([
    ...secretSentinels,
    ...secretSentinels.map((value) => createHash("sha256").update(value).digest("hex")),
  ]);
  const exactPath = `${session.base.slice(0, -1)}${POLICY.path}`;
  assert.match(exactPath, /^\/frame\/c\/[A-Za-z0-9_-]{43}\/socket$/u);
  const exactUrl = webSocketUrl(network.broker, exactPath);
  let browser = new WebSocket(exactUrl, ["riff.echo"], {
    perMessageDeflate: false,
    headers: {
      cookie: session.brokerCookie,
      origin: network.broker.origin,
      "x-browser-only": browserOnlySecret,
    },
  });
  await opened(browser);
  assert.equal(browser.protocol, "riff.echo");
  browser.send("echo-through-broker");
  assert.equal(await nextMessage(browser), "echo-through-broker");
  assert.equal(childRequests.length, 1);
  assert.equal(childRequests[0]!.url, POLICY.path);
  assert.equal(childRequests[0]!.headers.host, `127.0.0.1:${target.port}`);
  assert.equal(childRequests[0]!.headers.origin, network.broker.origin);
  assert.equal(childRequests[0]!.headers.cookie, undefined);
  assert.equal(childRequests[0]!.headers.authorization, undefined);
  assert.equal(childRequests[0]!.headers["x-browser-only"], undefined);
  assert.equal(connectedPeers.length, 1);
  assert.equal(connectedPeers[0]!.remotePort, target.port);
  const normalClose = onceClose(browser);
  browser.close(1000);
  assert.equal((await normalClose).code, 1000);

  connectedInspectionTimesOut = true;
  const timedOutInspection = await rawUpgrade(network.broker, exactPath, [
    ["Host", network.broker.authority],
    ["Connection", "Upgrade"],
    ["Upgrade", "websocket"],
    ["Sec-WebSocket-Version", "13"],
    ["Sec-WebSocket-Key", "AAAAAAAAAAAAAAAAAAAAAA=="],
    ["Origin", network.broker.origin],
    ["Cookie", session.brokerCookie],
    ["Sec-WebSocket-Protocol", "riff.echo"],
  ]);
  connectedInspectionTimesOut = false;
  assert.match(timedOutInspection, /^HTTP\/1\.1 504 /u);
  assert.match(timedOutInspection, /"code":"visual_websocket_timeout"/u);
  assert.equal(childRequests.length, 2, "connected-peer timeout occurs only after the fixed child dial");

  const validHeaders = [
    ["Host", network.broker.authority],
    ["Connection", "Upgrade"],
    ["Upgrade", "websocket"],
    ["Sec-WebSocket-Version", "13"],
    ["Sec-WebSocket-Key", "AAAAAAAAAAAAAAAAAAAAAA=="],
    ["Origin", network.broker.origin],
    ["Cookie", session.brokerCookie],
    ["Sec-WebSocket-Protocol", "riff.echo"],
  ] as const;
  const negativeCases: Array<{
    label: string;
    address: BrowserNetworkAddress;
    method?: string;
    path: string;
    headers: readonly (readonly [string, string])[];
    status: number;
    code: string;
  }> = [
    {
      label: "parsed malformed WebSocket key",
      address: network.broker,
      path: exactPath,
      headers: replaceHeader(validHeaders, "Sec-WebSocket-Key", "not-a-websocket-key"),
      status: 400,
      code: "visual_websocket_protocol_denied",
    },
    {
      label: "non-GET method",
      address: network.broker,
      method: "POST",
      path: exactPath,
      headers: validHeaders,
      status: 405,
      code: "visual_websocket_protocol_denied",
    },
    {
      label: "wrong path",
      address: network.broker,
      path: `${session.base}other`,
      headers: validHeaders,
      status: 404,
      code: "visual_websocket_not_declared",
    },
    {
      label: "query",
      address: network.broker,
      path: `${exactPath}?query=1`,
      headers: validHeaders,
      status: 404,
      code: "visual_websocket_not_declared",
    },
    {
      label: "wrong origin",
      address: network.broker,
      path: exactPath,
      headers: replaceHeader(validHeaders, "Origin", "http://[::1]:9"),
      status: 403,
      code: "visual_frame_session_denied",
    },
    {
      label: "wrong cookie",
      address: network.broker,
      path: exactPath,
      headers: replaceHeader(validHeaders, "Cookie", "riff_frame_wrong=wrongwrongwrongwrongwrong"),
      status: 403,
      code: "visual_frame_session_denied",
    },
    {
      label: "authorization",
      address: network.broker,
      path: exactPath,
      headers: [...validHeaders, ["Authorization", "Bearer browser-secret"]],
      status: 403,
      code: "visual_frame_session_denied",
    },
    {
      label: "wrong protocol",
      address: network.broker,
      path: exactPath,
      headers: replaceHeader(validHeaders, "Sec-WebSocket-Protocol", "wrong.protocol"),
      status: 403,
      code: "visual_websocket_protocol_denied",
    },
    {
      label: "duplicate origin",
      address: network.broker,
      path: exactPath,
      headers: [...validHeaders, ["Origin", network.broker.origin]],
      status: 403,
      code: "visual_frame_session_denied",
    },
    {
      label: "duplicate cookie",
      address: network.broker,
      path: exactPath,
      headers: [...validHeaders, ["Cookie", session.brokerCookie]],
      status: 403,
      code: "visual_frame_session_denied",
    },
    {
      label: "duplicate protocol header",
      address: network.broker,
      path: exactPath,
      headers: [...validHeaders, ["Sec-WebSocket-Protocol", "riff.echo"]],
      status: 403,
      code: "visual_websocket_protocol_denied",
    },
    {
      label: "app listener",
      address: network.app,
      path: exactPath,
      headers: replaceHeader(validHeaders, "Host", network.app.authority),
      status: 404,
      code: "platform_upgrade_denied",
    },
  ];
  const boundedErrorResponses = [timedOutInspection];
  for (const input of negativeCases) {
    const response = await rawUpgrade(input.address, input.path, input.headers, input.method);
    boundedErrorResponses.push(response);
    assert.match(response, new RegExp(`^HTTP/1\\.1 ${input.status} `, "u"), input.label);
    assert.match(response, new RegExp(`"code":"${input.code}"`, "u"), input.label);
    assert.equal(Buffer.byteLength(response) < 2_048, true, input.label);
    assert.equal(response.includes(session.brokerCookie), false, input.label);
    assert.equal(response.includes(browserOnlySecret), false, input.label);
  }
  assert.equal(childRequests.length, 2, "denied upgrades must not dial the child");

  const sharedBootstrap = await raw(network.app, "POST", "/api/browser-session/bootstrap", {
    origin: network.app.origin,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
  });
  assert.equal(sharedBootstrap.status, 201);
  const firstRoute = await issueFromBootstrap(network, target, sharedBootstrap);
  const secondRoute = await issueFromBootstrap(network, target, sharedBootstrap);
  const firstRoutePath = `${firstRoute.base.slice(0, -1)}${POLICY.path}`;
  const secondRoutePath = `${secondRoute.base.slice(0, -1)}${POLICY.path}`;
  const firstActive = new WebSocket(webSocketUrl(network.broker, firstRoutePath), ["riff.echo"], {
    perMessageDeflate: false,
    headers: { cookie: firstRoute.brokerCookie, origin: network.broker.origin },
  });
  const secondActive = new WebSocket(webSocketUrl(network.broker, secondRoutePath), ["riff.echo"], {
    perMessageDeflate: false,
    headers: { cookie: secondRoute.brokerCookie, origin: network.broker.origin },
  });
  await Promise.all([opened(firstActive), opened(secondActive)]);
  const childDialsAtLimit = childRequests.length;
  const maxConnectionsDenied = await rawUpgrade(
    network.broker,
    secondRoutePath,
    upgradeHeaders(network.broker, secondRoute.brokerCookie),
  );
  boundedErrorResponses.push(maxConnectionsDenied);
  assert.match(maxConnectionsDenied, /^HTTP\/1\.1 429 /u);
  assert.match(maxConnectionsDenied, /"code":"visual_websocket_limit"/u);
  assert.equal(
    childRequests.length,
    childDialsAtLimit,
    "attempt-global maxConnections + 1 must be denied before child dial across minted routes",
  );
  const firstActiveClose = onceClose(firstActive);
  const secondActiveClose = onceClose(secondActive);
  firstActive.close(1000);
  secondActive.close(1000);
  assert.equal((await firstActiveClose).code, 1000);
  assert.equal((await secondActiveClose).code, 1000);
  await new Promise<void>((resolve) => setTimeout(resolve, 40));

  childMode = "redirect";
  const redirectRoute = await issueFromBootstrap(network, target, sharedBootstrap);
  const redirectDenied = await rawUpgrade(
    network.broker,
    `${redirectRoute.base.slice(0, -1)}${POLICY.path}`,
    upgradeHeaders(network.broker, redirectRoute.brokerCookie),
  );
  boundedErrorResponses.push(redirectDenied);
  assert.match(redirectDenied, /^HTTP\/1\.1 502 /u);
  assert.match(redirectDenied, /"code":"visual_websocket_upstream_failed"/u);
  assert.doesNotMatch(redirectDenied, /child-redirect-sentinel/u);

  childMode = "non-101";
  const non101Route = await issueFromBootstrap(network, target, sharedBootstrap);
  const non101Denied = await rawUpgrade(
    network.broker,
    `${non101Route.base.slice(0, -1)}${POLICY.path}`,
    upgradeHeaders(network.broker, non101Route.brokerCookie),
  );
  boundedErrorResponses.push(non101Denied);
  assert.match(non101Denied, /^HTTP\/1\.1 502 /u);
  assert.match(non101Denied, /"code":"visual_websocket_upstream_failed"/u);
  assert.doesNotMatch(non101Denied, /child-non-101-sentinel/u);
  childMode = "echo";

  const closeOnRotation = new WebSocket(
    webSocketUrl(network.broker, firstRoutePath),
    ["riff.echo"],
    {
      perMessageDeflate: false,
      headers: { cookie: firstRoute.brokerCookie, origin: network.broker.origin },
    },
  );
  await opened(closeOnRotation);
  const rotationClose = onceClose(closeOnRotation);
  const rotated = await raw(network.app, "POST", "/api/browser-session/bootstrap", {
    origin: network.app.origin,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
  });
  assert.equal(rotated.status, 201);
  assert.equal((await rotationClose).code, 1008);
  const oldAfterRotation = await rawUpgrade(
    network.broker,
    firstRoutePath,
    upgradeHeaders(network.broker, firstRoute.brokerCookie),
  );
  boundedErrorResponses.push(oldAfterRotation);
  assert.match(oldAfterRotation, /^HTTP\/1\.1 403 /u);
  assert.match(oldAfterRotation, /"code":"visual_frame_session_denied"/u);

  session = await issueFromBootstrap(network, target, rotated);
  const shutdownPath = `${session.base.slice(0, -1)}${POLICY.path}`;
  browser = new WebSocket(webSocketUrl(network.broker, shutdownPath), ["riff.echo"], {
    perMessageDeflate: false,
    headers: { cookie: session.brokerCookie, origin: network.broker.origin },
  });
  await opened(browser);
  const unrelatedDto = await raw(network.app, "GET", "/health");
  assert.equal(unrelatedDto.status, 200);
  assertSecretNeedlesAbsent(
    "bounded broker errors",
    boundedErrorResponses.join("\n"),
    secretNeedles,
  );
  assertSecretNeedlesAbsent(
    "child handshake headers",
    JSON.stringify(childRequests),
    secretNeedles,
  );
  assertSecretNeedlesAbsent(
    "unrelated public DTO",
    JSON.stringify(unrelatedDto.json),
    secretNeedles,
  );
  const shutdownClose = onceClose(browser);
  await app.close();
  appClosed = true;
  assert.equal((await shutdownClose).code, 1008);
  assertSecretNeedlesAbsent("backend logs", capturedLogs.join("\n"), secretNeedles);
  assertSecretNeedlesAbsent(
    "ProductStore SQLite",
    await readFile(join(workspace, "product", "product.sqlite3")),
    secretNeedles,
  );
});

const mintFrameSession = async (
  _app: BackendApp,
  network: { app: BrowserNetworkAddress; broker: BrowserNetworkAddress },
  target: BrowserFrameTarget,
): Promise<FrameSession> => {
  const bootstrap = await raw(network.app, "POST", "/api/browser-session/bootstrap", {
    origin: network.app.origin,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
  });
  assert.equal(bootstrap.status, 201);
  return issueFromBootstrap(network, target, bootstrap);
};

const issueFromBootstrap = async (
  network: { app: BrowserNetworkAddress; broker: BrowserNetworkAddress },
  target: BrowserFrameTarget,
  bootstrap: Awaited<ReturnType<typeof raw>>,
): Promise<FrameSession> => {
  const appCookie = cookiePair(bootstrap.headers["set-cookie"]);
  const csrfToken = String(bootstrap.json.csrfToken);
  const issued = await raw(
    network.app,
    "POST",
    `/api/projects/${target.projectId}/runs/${target.runId}/visual-frame-session`,
    {
      origin: network.app.origin,
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
      cookie: appCookie,
      "x-riff-csrf": csrfToken,
    },
  );
  assert.equal(issued.status, 201);
  const frame = new URL(issued.json.frameUrl);
  const redeemed = await raw(network.broker, "GET", frame.pathname);
  assert.equal(redeemed.status, 303, redeemed.text);
  return {
    appCookie,
    base: String(redeemed.headers.location),
    brokerCookie: cookiePair(redeemed.headers["set-cookie"]),
    csrfToken,
    frameUrl: frame.toString(),
  };
};

type FrameSession = Readonly<{
  appCookie: string;
  base: string;
  brokerCookie: string;
  csrfToken: string;
  frameUrl: string;
}>;

const exactTarget = (candidate: BrowserFrameTarget, expected: BrowserFrameTarget): boolean =>
  candidate.projectId === expected.projectId
  && candidate.runId === expected.runId
  && candidate.attemptGeneration === expected.attemptGeneration
  && candidate.port === expected.port
  && candidate.expiresAtMs === expected.expiresAtMs
  && candidate.webSocket?.path === expected.webSocket?.path
  && candidate.webSocket?.maxFrameBytes === expected.webSocket?.maxFrameBytes
  && candidate.webSocket?.maxConnections === expected.webSocket?.maxConnections
  && candidate.webSocket?.idleTimeoutMs === expected.webSocket?.idleTimeoutMs
  && JSON.stringify(candidate.webSocket?.subprotocols)
    === JSON.stringify(expected.webSocket?.subprotocols);

const webSocketUrl = (address: BrowserNetworkAddress, path: string): string =>
  `ws://localhost:${address.port}${path}`;

const upgradeHeaders = (
  address: BrowserNetworkAddress,
  brokerCookie: string,
): readonly (readonly [string, string])[] => [
  ["Host", address.authority],
  ["Connection", "Upgrade"],
  ["Upgrade", "websocket"],
  ["Sec-WebSocket-Version", "13"],
  ["Sec-WebSocket-Key", "AAAAAAAAAAAAAAAAAAAAAA=="],
  ["Origin", address.origin],
  ["Cookie", brokerCookie],
  ["Sec-WebSocket-Protocol", "riff.echo"],
];

const opened = async (webSocket: WebSocket): Promise<void> =>
  await new Promise<void>((resolve, reject) => {
    webSocket.once("open", resolve);
    webSocket.once("error", reject);
  });

const nextMessage = async (webSocket: WebSocket): Promise<string> =>
  await new Promise<string>((resolve, reject) => {
    webSocket.once("message", (data) => resolve(data.toString()));
    webSocket.once("error", reject);
  });

const onceClose = async (webSocket: WebSocket): Promise<{ code: number }> =>
  await new Promise((resolve) => {
    webSocket.once("close", (code) => resolve({ code }));
  });

const replaceHeader = (
  headers: readonly (readonly [string, string])[],
  name: string,
  value: string,
): Array<readonly [string, string]> =>
  headers.map(([candidate, current]) =>
    candidate.toLowerCase() === name.toLowerCase() ? [candidate, value] : [candidate, current]);

const rawUpgrade = async (
  address: BrowserNetworkAddress,
  path: string,
  headers: readonly (readonly [string, string])[],
  method = "GET",
): Promise<string> => await new Promise((resolve, reject) => {
  const socket = connect({
    family: 6,
    host: address.host,
    port: address.port,
  });
  const chunks: Buffer[] = [];
  socket.once("connect", () => {
    socket.write([
      `${method} ${path} HTTP/1.1`,
      ...headers.map(([name, value]) => `${name}: ${value}`),
      "",
      "",
    ].join("\r\n"));
  });
  socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  socket.once("error", reject);
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
}> => await new Promise((resolve, reject) => {
  const automaticBootstrapBody = method === "POST"
    && path === "/api/browser-session/bootstrap"
    && headers["content-length"] === undefined
    && headers["transfer-encoding"] === undefined;
  const body = automaticBootstrapBody ? "{}" : "";
  const outgoing = request({
    family: 6,
    headers: {
      host: address.authority,
      ...(automaticBootstrapBody
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
      resolve({ status: response.statusCode ?? 0, headers: response.headers, text, json });
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

const cookieValue = (pair: string): string => {
  const separator = pair.indexOf("=");
  assert.notEqual(separator, -1);
  return pair.slice(separator + 1);
};

const assertSecretNeedlesAbsent = (
  surfaceName: string,
  surface: string | Buffer,
  needles: readonly string[],
): void => {
  const bytes = typeof surface === "string" ? Buffer.from(surface) : surface;
  for (const needle of needles) {
    assert.equal(
      bytes.includes(Buffer.from(needle)),
      false,
      `${surfaceName} contains a browser/frame/child sentinel or its SHA-256 digest`,
    );
  }
};

const unusedSupervisor = (): {
  supervise(): Promise<never>;
  cleanup(): never;
} => ({
  supervise: async () => {
    throw new Error("unused");
  },
  cleanup: () => {
    throw new Error("unused");
  },
});

class WebSocketFakeMesa implements MesaAdapter {
  async loadModel(): Promise<MesaModel> { throw new Error("unused"); }
  async startRun(_projectId: string, _request: MesaRunRequest): Promise<MesaRun> { throw new Error("unused"); }
  async getRun(): Promise<MesaRun> { throw new Error("unused"); }
  async cancelRun(): Promise<MesaRun> { throw new Error("unused"); }
  async getResults(): Promise<MesaResults> { throw new Error("unused"); }
}

class WebSocketFakeOpenCode implements OpenCodeAdapter {
  async initialize(): Promise<OpenCodeReadiness> { return { status: "unconfigured", modelId: null }; }
  async discoverProviderModels(): Promise<[]> { return []; }
  async getSession(): Promise<boolean> { return false; }
  async createSession(): Promise<string> { throw new Error("unused"); }
  async injectContext(): Promise<void> {}
  async promptWithModel(): Promise<never> { throw new Error("unused"); }
  async prompt(_sessionId: string, _prompt: OpenCodePrompt): Promise<void> { throw new Error("unused"); }
  async abort(): Promise<void> {}
}

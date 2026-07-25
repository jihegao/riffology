import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { createConnection, type AddressInfo } from "node:net";
import { Duplex } from "node:stream";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { rejectUpgrade } from "../src/browser-network-topology.ts";
import {
  BrowserWebSocketBridge,
  BrowserWebSocketBridgeError,
  type BrowserWebSocketPeerIdentity,
} from "../src/browser-websocket-bridge.ts";

test("bridge waits for the fixed child peer, selects an exact protocol, and forwards no browser secret", async (t) => {
  const childHeaders: Record<string, string | string[] | undefined>[] = [];
  let childPeer: WebSocket | undefined;
  const childHttp = createServer();
  const childWs = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    handleProtocols: (offered) => offered.has("riff.v1") ? "riff.v1" : false,
  });
  childHttp.on("upgrade", (request, socket, head) => {
    childHeaders.push(request.headers);
    childWs.handleUpgrade(request, socket, head, (peer) => {
      childWs.emit("connection", peer, request);
    });
  });
  childWs.on("connection", (peer) => {
    childPeer = peer;
    peer.on("message", (data, isBinary) => peer.send(data, { binary: isBinary }));
  });
  await listen(childHttp, "127.0.0.1");
  t.after(async () => {
    childWs.close();
    await close(childHttp);
  });
  const childAddress = childHttp.address() as AddressInfo;

  const bridge = new BrowserWebSocketBridge();
  let releaseCount = 0;
  let observedPeer: BrowserWebSocketPeerIdentity | undefined;
  let browserOrigin = "";
  const broker = createServer();
  broker.on("upgrade", (request, socket, head) => {
    const owner = bridge.createOwner(socket);
    void bridge.upgrade(request, socket, head, owner, {
      childPort: childAddress.port,
      childPath: "/socket",
      declaredProtocols: ["riff.v1"],
      maxFrameBytes: 1_024,
      idleTimeoutMs: 5_000,
      expiresAtMs: Date.now() + 30_000,
      brokerOrigin: browserOrigin,
      inspectConnectedPeer: async (peer) => {
        observedPeer = peer;
        return true;
      },
      live: () => true,
      markOpen: () => undefined,
      onClosed: () => {
        releaseCount += 1;
      },
    }).catch(() => owner.terminate());
  });
  await listen(broker, "::1");
  t.after(() => close(broker));
  const brokerAddress = broker.address() as AddressInfo;
  browserOrigin = `http://[::1]:${brokerAddress.port}`;
  const browser = new WebSocket(
    `ws://[::1]:${brokerAddress.port}/frame/c/opaque/socket`,
    ["riff.v1"],
    {
      origin: browserOrigin,
      headers: {
        cookie: "riff_frame_secret=browser-secret",
      },
      perMessageDeflate: true,
    },
  );
  t.after(() => browser.terminate());
  await opened(browser);
  assert.equal(browser.protocol, "riff.v1");
  assert.ok(observedPeer);
  assert.equal(observedPeer.remotePort, childAddress.port);
  assert.equal(childHeaders.length, 1);
  assert.equal(childHeaders[0]!.host, `127.0.0.1:${childAddress.port}`);
  assert.equal(childHeaders[0]!.origin, browserOrigin);
  assert.equal(childHeaders[0]!.cookie, undefined);
  assert.equal(childHeaders[0]!.authorization, undefined);
  assert.equal(childHeaders[0]!["sec-websocket-extensions"], undefined);
  const echoed = onceTypedMessage(browser);
  browser.send("hello");
  assert.deepEqual(await echoed, { data: Buffer.from("hello"), isBinary: false });
  const binaryEcho = onceTypedMessage(browser);
  browser.send(Buffer.from([0, 1, 2]));
  assert.deepEqual(await binaryEcho, { data: Buffer.from([0, 1, 2]), isBinary: true });
  const childText = onceTypedMessage(browser);
  childPeer!.send("from-child");
  assert.deepEqual(await childText, { data: Buffer.from("from-child"), isBinary: false });
  const childBinary = onceTypedMessage(browser);
  childPeer!.send(Buffer.from([3, 4, 5]));
  assert.deepEqual(await childBinary, { data: Buffer.from([3, 4, 5]), isBinary: true });
  browser.close(1000);
  await closed(browser);
  await new Promise<void>((resolve) => setTimeout(resolve, 35));
  assert.equal(releaseCount, 1);
});

test("bridge maps idle expiry to 1001 and releases its owner exactly once", async (t) => {
  const childHttp = createServer();
  const childWs = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  childHttp.on("upgrade", (request, socket, head) =>
    childWs.handleUpgrade(request, socket, head, () => undefined));
  await listen(childHttp, "127.0.0.1");
  t.after(async () => {
    childWs.close();
    await close(childHttp);
  });
  const childAddress = childHttp.address() as AddressInfo;
  const bridge = new BrowserWebSocketBridge();
  let releases = 0;
  let brokerOrigin = "";
  const broker = createServer();
  broker.on("upgrade", (request, socket, head) => {
    const owner = bridge.createOwner(socket);
    void bridge.upgrade(request, socket, head, owner, {
      childPort: childAddress.port,
      childPath: "/socket",
      declaredProtocols: [],
      maxFrameBytes: 64,
      idleTimeoutMs: 1_000,
      expiresAtMs: Date.now() + 80,
      brokerOrigin,
      inspectConnectedPeer: async () => true,
      live: () => true,
      markOpen: () => undefined,
      onClosed: () => {
        releases += 1;
      },
    }).catch(() => owner.terminate());
  });
  await listen(broker, "::1");
  t.after(() => close(broker));
  const brokerAddress = broker.address() as AddressInfo;
  brokerOrigin = `http://[::1]:${brokerAddress.port}`;
  const browser = new WebSocket(`ws://[::1]:${brokerAddress.port}/socket`, {
    origin: brokerOrigin,
    headers: { cookie: "riff_frame_secret=browser-secret" },
    perMessageDeflate: false,
  });
  const closeResult = onceClose(browser);
  await opened(browser);
  assert.equal((await closeResult).code, 1001);
  await new Promise<void>((resolve) => setTimeout(resolve, 35));
  assert.equal(releases, 1);
});

test("capability revocation terminates the attached child during handshake and connected inspection", async (t) => {
  await t.test("pending child handshake", async (context) => {
    const bridge = new BrowserWebSocketBridge();
    const childHttp = createServer();
    let heldChildSocket: Duplex | undefined;
    let childArrived!: () => void;
    const childArrival = new Promise<void>((resolve) => {
      childArrived = resolve;
    });
    childHttp.on("upgrade", (_request, socket) => {
      heldChildSocket = socket;
      socket.resume();
      childArrived();
    });
    await listen(childHttp, "127.0.0.1");
    context.after(async () => {
      heldChildSocket?.destroy();
      await close(childHttp);
    });
    const childAddress = childHttp.address() as AddressInfo;
    let brokerOrigin = "";
    let owner: ReturnType<BrowserWebSocketBridge["createOwner"]> | undefined;
    let upgradeResult: Promise<unknown> | undefined;
    let releases = 0;
    const broker = createServer();
    broker.on("upgrade", (request, socket, head) => {
      owner = bridge.createOwner(socket);
      upgradeResult = bridge.upgrade(request, socket, head, owner, {
        childPort: childAddress.port,
        childPath: "/socket",
        declaredProtocols: [],
        maxFrameBytes: 64,
        idleTimeoutMs: 5_000,
        expiresAtMs: Date.now() + 10_000,
        brokerOrigin,
        inspectConnectedPeer: async () => true,
        live: () => true,
        markOpen: () => undefined,
        onClosed: () => {
          releases += 1;
        },
      }).catch((error) => error);
    });
    await listen(broker, "::1");
    context.after(() => close(broker));
    const address = broker.address() as AddressInfo;
    brokerOrigin = `http://[::1]:${address.port}`;
    const browser = new WebSocket(`ws://[::1]:${address.port}/socket`, {
      origin: brokerOrigin,
      headers: { cookie: "a=b" },
      perMessageDeflate: false,
    });
    browser.on("error", () => undefined);
    context.after(() => browser.terminate());

    await within(childArrival, "pending child handshake did not start");
    const childClosed = onceDuplexClose(heldChildSocket!);
    owner!.close(1008);
    assert.equal(owner!.terminated, true);
    assert.equal(releases, 1);
    await within(childClosed, "pending child handshake socket did not close");
    assert.ok(await within(upgradeResult!, "pending child handshake did not reject") instanceof Error);
  });

  await t.test("pending connected-peer inspection", async (context) => {
    const bridge = new BrowserWebSocketBridge();
    const childHttp = createServer();
    const childWs = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    let childPeer: WebSocket | undefined;
    childHttp.on("upgrade", (request, socket, head) => {
      childWs.handleUpgrade(request, socket, head, (peer) => {
        childPeer = peer;
        childWs.emit("connection", peer, request);
      });
    });
    await listen(childHttp, "127.0.0.1");
    context.after(async () => {
      childPeer?.terminate();
      childWs.close();
      await close(childHttp);
    });
    const childAddress = childHttp.address() as AddressInfo;
    let inspectEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      inspectEntered = resolve;
    });
    let finishInspection!: (value: boolean) => void;
    const inspection = new Promise<boolean>((resolve) => {
      finishInspection = resolve;
    });
    let brokerOrigin = "";
    let owner: ReturnType<BrowserWebSocketBridge["createOwner"]> | undefined;
    let upgradeResult: Promise<unknown> | undefined;
    let releases = 0;
    const broker = createServer();
    broker.on("upgrade", (request, socket, head) => {
      owner = bridge.createOwner(socket);
      upgradeResult = bridge.upgrade(request, socket, head, owner, {
        childPort: childAddress.port,
        childPath: "/socket",
        declaredProtocols: [],
        maxFrameBytes: 64,
        idleTimeoutMs: 5_000,
        expiresAtMs: Date.now() + 10_000,
        brokerOrigin,
        inspectConnectedPeer: async () => {
          inspectEntered();
          return inspection;
        },
        live: () => true,
        markOpen: () => undefined,
        onClosed: () => {
          releases += 1;
        },
      }).catch((error) => error);
    });
    await listen(broker, "::1");
    context.after(() => close(broker));
    const address = broker.address() as AddressInfo;
    brokerOrigin = `http://[::1]:${address.port}`;
    const browser = new WebSocket(`ws://[::1]:${address.port}/socket`, {
      origin: brokerOrigin,
      headers: { cookie: "a=b" },
      perMessageDeflate: false,
    });
    browser.on("error", () => undefined);
    context.after(() => browser.terminate());

    await within(entered, "connected-peer inspection did not start");
    const childClosed = onceClose(childPeer!);
    owner!.close(1008);
    assert.equal(owner!.terminated, true);
    assert.equal(releases, 1);
    await within(childClosed, "inspected child socket did not close");
    finishInspection(true);
    assert.ok(await within(upgradeResult!, "inspection race did not reject") instanceof Error);
  });

  await t.test("malformed child frame during inspection", async (context) => {
    const bridge = new BrowserWebSocketBridge();
    const childHttp = createServer();
    const childWs = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    let childPeer: WebSocket | undefined;
    childHttp.on("upgrade", (request, socket, head) => {
      childWs.handleUpgrade(request, socket, head, (peer) => {
        childPeer = peer;
        childWs.emit("connection", peer, request);
      });
    });
    await listen(childHttp, "127.0.0.1");
    context.after(async () => {
      childPeer?.terminate();
      childWs.close();
      await close(childHttp);
    });
    const childAddress = childHttp.address() as AddressInfo;
    let inspectEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      inspectEntered = resolve;
    });
    let finishInspection!: (value: boolean) => void;
    const inspection = new Promise<boolean>((resolve) => {
      finishInspection = resolve;
    });
    let brokerOrigin = "";
    const broker = createServer();
    broker.on("upgrade", (request, socket, head) => {
      const owner = bridge.createOwner(socket);
      void bridge.upgrade(request, socket, head, owner, {
        childPort: childAddress.port,
        childPath: "/socket",
        declaredProtocols: [],
        maxFrameBytes: 64,
        idleTimeoutMs: 5_000,
        expiresAtMs: Date.now() + 10_000,
        brokerOrigin,
        inspectConnectedPeer: async () => {
          inspectEntered();
          return inspection;
        },
        live: () => true,
        markOpen: () => undefined,
        onClosed: () => undefined,
      }).catch((error: BrowserWebSocketBridgeError) => {
        rejectUpgrade(socket, error.status, error.code);
      });
    });
    await listen(broker, "::1");
    context.after(() => close(broker));
    const address = broker.address() as AddressInfo;
    brokerOrigin = `http://[::1]:${address.port}`;
    const uncaught: Error[] = [];
    const onUncaught = (error: Error): void => {
      uncaught.push(error);
    };
    process.on("uncaughtException", onUncaught);
    context.after(() => process.off("uncaughtException", onUncaught));
    const browser = new WebSocket(`ws://[::1]:${address.port}/socket`, {
      origin: brokerOrigin,
      headers: { cookie: "a=b" },
      perMessageDeflate: false,
    });
    browser.on("error", () => undefined);
    context.after(() => browser.terminate());
    const browserClosed = onceClose(browser);

    await within(entered, "malformed-child inspection did not start");
    (childPeer as WebSocket & { _socket: Duplex })._socket.write(
      Buffer.from([0x81, 0x81, 0x11, 0x22, 0x33, 0x44, 0x70]),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(uncaught, []);
    finishInspection(true);
    assert.equal(
      (await within(browserClosed, "malformed child did not close the browser leg")).code,
      1002,
    );
    assert.deepEqual(uncaught, []);
  });
});

test("bridge maps oversized messages to 1009 and child failure to 1011", async (t) => {
  const childHttp = createServer();
  const childWs = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  childHttp.on("upgrade", (request, socket, head) => {
    childWs.handleUpgrade(request, socket, head, (peer) => {
      peer.on("message", (data) => {
        if (data.toString() === "fail") peer.close(1011);
      });
    });
  });
  await listen(childHttp, "127.0.0.1");
  t.after(async () => {
    childWs.close();
    await close(childHttp);
  });
  const childAddress = childHttp.address() as AddressInfo;
  const bridge = new BrowserWebSocketBridge();
  let brokerOrigin = "";
  const broker = createServer();
  broker.on("upgrade", (request, socket, head) => {
    const owner = bridge.createOwner(socket);
    void bridge.upgrade(request, socket, head, owner, {
      childPort: childAddress.port,
      childPath: "/socket",
      declaredProtocols: [],
      maxFrameBytes: 64,
      idleTimeoutMs: 5_000,
      expiresAtMs: Date.now() + 10_000,
      brokerOrigin,
      inspectConnectedPeer: async () => true,
      live: () => true,
      markOpen: () => undefined,
      onClosed: () => undefined,
    }).catch(() => owner.terminate());
  });
  await listen(broker, "::1");
  t.after(() => close(broker));
  const brokerAddress = broker.address() as AddressInfo;
  brokerOrigin = `http://[::1]:${brokerAddress.port}`;
  const connectBrowser = (): WebSocket => new WebSocket(
    `ws://[::1]:${brokerAddress.port}/socket`,
    {
      origin: brokerOrigin,
      headers: { cookie: "riff_frame_secret=browser-secret" },
      perMessageDeflate: false,
    },
  );
  const oversized = connectBrowser();
  await opened(oversized);
  const oversizedClose = onceClose(oversized);
  oversized.send("x".repeat(65));
  assert.equal((await oversizedClose).code, 1009);

  const childFailure = connectBrowser();
  await opened(childFailure);
  const failureClose = onceClose(childFailure);
  childFailure.send("fail");
  assert.equal((await failureClose).code, 1011);
});

test("raw frames preserve fragmentation and control frames, map protocol errors, and bound queued items", async (t) => {
  const childHttp = createServer();
  const childWs = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  childHttp.on("upgrade", (request, socket, head) => {
    childWs.handleUpgrade(request, socket, head, (peer) => {
      peer.on("message", (data, isBinary) => peer.send(data, { binary: isBinary }));
      childWs.emit("connection", peer, request);
    });
  });
  await listen(childHttp, "127.0.0.1");
  t.after(async () => {
    childWs.close();
    await close(childHttp);
  });
  const childAddress = childHttp.address() as AddressInfo;
  const bridge = new BrowserWebSocketBridge();
  let brokerOrigin = "";
  const broker = createServer();
  broker.on("upgrade", (request, socket, head) => {
    const owner = bridge.createOwner(socket);
    void bridge.upgrade(request, socket, head, owner, {
      childPort: childAddress.port,
      childPath: "/socket",
      declaredProtocols: [],
      maxFrameBytes: 64,
      idleTimeoutMs: 5_000,
      expiresAtMs: Date.now() + 10_000,
      brokerOrigin,
      inspectConnectedPeer: async () => true,
      live: () => true,
      markOpen: () => undefined,
      onClosed: () => undefined,
    }).catch(() => owner.terminate());
  });
  await listen(broker, "::1");
  t.after(() => close(broker));
  const address = broker.address() as AddressInfo;
  brokerOrigin = `http://[::1]:${address.port}`;

  const fragmented = await RawWebSocketClient.connect(address.port, brokerOrigin);
  t.after(() => fragmented.destroy());
  fragmented.write(Buffer.concat([
    clientFrame(0x01, Buffer.from("hel"), false),
    clientFrame(0x09, Buffer.from("probe")),
    clientFrame(0x0a, Buffer.from("seen")),
    clientFrame(0x00, Buffer.from("lo")),
  ]));
  assert.deepEqual((await fragmented.readFrame(0x0a)).payload, Buffer.from("probe"));
  const assembled = await fragmented.readFrame(0x01);
  assert.equal(assembled.fin, true);
  assert.deepEqual(assembled.payload, Buffer.from("hello"));
  fragmented.destroy();

  const malformed = await RawWebSocketClient.connect(address.port, brokerOrigin);
  t.after(() => malformed.destroy());
  malformed.write(Buffer.from([0x81, 0x01, 0x61]));
  assert.equal(closeCode(await malformed.readFrame(0x08)), 1002);
  malformed.destroy();

  const invalidUtf8 = await RawWebSocketClient.connect(address.port, brokerOrigin);
  t.after(() => invalidUtf8.destroy());
  invalidUtf8.write(clientFrame(0x01, Buffer.from([0xc3, 0x28])));
  assert.equal(closeCode(await invalidUtf8.readFrame(0x08)), 1007);
  invalidUtf8.destroy();

  const backpressured = await RawWebSocketClient.connect(address.port, brokerOrigin);
  t.after(() => backpressured.destroy());
  backpressured.write(Buffer.concat(
    Array.from({ length: 18 }, () => clientFrame(0x01, Buffer.from("x"))),
  ));
  assert.equal(closeCode(await backpressured.readFrame(0x08)), 1013);
  backpressured.destroy();
});

test("bridge rejects duplicate-sensitive or undeclared handshake protocols before child authority", async () => {
  const bridge = new BrowserWebSocketBridge();
  const request = {
    method: "GET",
    httpVersion: "1.1",
    rawHeaders: [
      "Connection", "Upgrade",
      "Upgrade", "websocket",
      "Sec-WebSocket-Version", "13",
      "Sec-WebSocket-Key", "MDEyMzQ1Njc4OWFiY2RlZg==",
      "Origin", "http://[::1]:18080",
      "Cookie", "a=b",
      "Sec-WebSocket-Protocol", "foreign",
    ],
  } as IncomingMessage;
  const raw = new PassThroughSocket();
  const owner = bridge.createOwner(raw);
  await assert.rejects(
    bridge.upgrade(request, raw, Buffer.alloc(0), owner, {
      childPort: 41_000,
      childPath: "/socket",
      declaredProtocols: ["riff.v1"],
      maxFrameBytes: 1_024,
      idleTimeoutMs: 1_000,
      expiresAtMs: Date.now() + 10_000,
      brokerOrigin: "http://[::1]:18080",
      inspectConnectedPeer: async () => true,
      live: () => true,
      markOpen: () => undefined,
      onClosed: () => undefined,
    }),
    (error: unknown) => error instanceof BrowserWebSocketBridgeError
      && error.code === "visual_websocket_protocol_denied",
  );
  assert.equal(raw.destroyed, false);
});

test("pre-101 denials leave the raw socket writable for stable HTTP status and code responses", async (t) => {
  const bridge = new BrowserWebSocketBridge();
  const childHttp = createServer();
  const childWs = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  childHttp.on("upgrade", (request, socket, head) =>
    childWs.handleUpgrade(request, socket, head, () => undefined));
  await listen(childHttp, "127.0.0.1");
  t.after(async () => {
    childWs.close();
    await close(childHttp);
  });
  const childAddress = childHttp.address() as AddressInfo;
  let brokerOrigin = "";
  const broker = createServer();
  broker.on("upgrade", (request, socket, head) => {
    const owner = bridge.createOwner(socket);
    const path = request.url ?? "";
    void bridge.upgrade(
      request,
      socket,
      path === "/limit" ? Buffer.alloc(80) : head,
      owner,
      {
        childPort: childAddress.port,
        childPath: "/socket",
        declaredProtocols: path === "/protocol" ? ["riff.v1"] : [],
        maxFrameBytes: 64,
        idleTimeoutMs: 1_000,
        expiresAtMs: Date.now() + 10_000,
        brokerOrigin,
        inspectConnectedPeer: async () => false,
        live: () => true,
        markOpen: () => undefined,
        onClosed: () => undefined,
      },
    ).catch((error: unknown) => {
      const denied = error as BrowserWebSocketBridgeError;
      rejectUpgrade(socket, denied.status, denied.code);
    });
  });
  await listen(broker, "::1");
  t.after(() => close(broker));
  const address = broker.address() as AddressInfo;
  brokerOrigin = `http://[::1]:${address.port}`;

  const cases = [
    {
      path: "/protocol",
      extraHeader: "Sec-WebSocket-Protocol: foreign\r\n",
      status: 403,
      code: "visual_websocket_protocol_denied",
    },
    {
      path: "/unavailable",
      extraHeader: "",
      status: 409,
      code: "visual_frame_unavailable",
    },
    {
      path: "/limit",
      extraHeader: "",
      status: 429,
      code: "visual_websocket_limit",
    },
  ] as const;
  for (const entry of cases) {
    const response = await rawUpgradeResponse(
      address.port,
      entry.path,
      brokerOrigin,
      entry.extraHeader,
    );
    assert.match(response, new RegExp(`^HTTP/1\\.1 ${entry.status} `, "u"));
    assert.match(response, new RegExp(`"code":"${entry.code}"`, "u"));
  }
});

type RawFrame = Readonly<{ fin: boolean; opcode: number; payload: Buffer }>;

class RawWebSocketClient {
  readonly #socket: ReturnType<typeof createConnection>;
  #buffer: Buffer;
  readonly #frames: RawFrame[] = [];
  readonly #waiters: Array<{
    opcode: number;
    resolve(frame: RawFrame): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  }> = [];

  private constructor(socket: ReturnType<typeof createConnection>, initial: Buffer) {
    this.#socket = socket;
    this.#buffer = initial;
    socket.on("data", (chunk) => {
      this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
      this.#parse();
    });
    socket.once("error", (error) => this.#rejectAll(error));
    socket.once("close", () => this.#rejectAll(new Error("The raw WebSocket closed.")));
    this.#parse();
  }

  static async connect(port: number, origin: string): Promise<RawWebSocketClient> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: "::1", port });
      let handshake = Buffer.alloc(0);
      const onError = (error: Error): void => reject(error);
      const onData = (chunk: Buffer): void => {
        handshake = Buffer.concat([handshake, Buffer.from(chunk)]);
        const end = handshake.indexOf("\r\n\r\n");
        if (end < 0) return;
        socket.off("error", onError);
        socket.off("data", onData);
        const headers = handshake.subarray(0, end + 4).toString("utf8");
        if (!headers.startsWith("HTTP/1.1 101 Switching Protocols\r\n")) {
          socket.destroy();
          reject(new Error(`Unexpected raw WebSocket handshake: ${headers.split("\r\n")[0]}`));
          return;
        }
        resolve(new RawWebSocketClient(socket, handshake.subarray(end + 4)));
      };
      socket.once("error", onError);
      socket.on("data", onData);
      socket.once("connect", () => {
        socket.write(
          "GET /socket HTTP/1.1\r\n"
          + `Host: [::1]:${port}\r\n`
          + "Connection: Upgrade\r\n"
          + "Upgrade: websocket\r\n"
          + "Sec-WebSocket-Version: 13\r\n"
          + "Sec-WebSocket-Key: MDEyMzQ1Njc4OWFiY2RlZg==\r\n"
          + `Origin: ${origin}\r\n`
          + "Cookie: a=b\r\n"
          + "\r\n",
        );
      });
    });
  }

  write(bytes: Buffer): void {
    this.#socket.write(bytes);
  }

  destroy(): void {
    this.#socket.destroy();
  }

  async readFrame(opcode: number): Promise<RawFrame> {
    const index = this.#frames.findIndex((frame) => frame.opcode === opcode);
    if (index >= 0) return this.#frames.splice(index, 1)[0]!;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const position = this.#waiters.findIndex((waiter) => waiter.timer === timer);
        if (position >= 0) this.#waiters.splice(position, 1);
        reject(new Error(`Timed out waiting for raw WebSocket opcode ${opcode}.`));
      }, 2_000);
      timer.unref?.();
      this.#waiters.push({ opcode, resolve, reject, timer });
    });
  }

  #parse(): void {
    while (this.#buffer.byteLength >= 2) {
      const first = this.#buffer[0]!;
      const second = this.#buffer[1]!;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.#buffer.byteLength < 4) return;
        length = this.#buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.#buffer.byteLength < 10) return;
        const wide = this.#buffer.readBigUInt64BE(2);
        if (wide > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.#rejectAll(new Error("Raw WebSocket frame length is unsafe."));
          return;
        }
        length = Number(wide);
        offset = 10;
      }
      const maskBytes = masked ? 4 : 0;
      if (this.#buffer.byteLength < offset + maskBytes + length) return;
      const mask = masked ? this.#buffer.subarray(offset, offset + 4) : undefined;
      offset += maskBytes;
      const payload = Buffer.from(this.#buffer.subarray(offset, offset + length));
      if (mask) {
        for (let index = 0; index < payload.byteLength; index += 1) {
          payload[index] = payload[index]! ^ mask[index % 4]!;
        }
      }
      this.#buffer = this.#buffer.subarray(offset + length);
      this.#deliver(Object.freeze({
        fin: (first & 0x80) !== 0,
        opcode: first & 0x0f,
        payload,
      }));
    }
  }

  #deliver(frame: RawFrame): void {
    const index = this.#waiters.findIndex((waiter) => waiter.opcode === frame.opcode);
    if (index < 0) {
      this.#frames.push(frame);
      return;
    }
    const waiter = this.#waiters.splice(index, 1)[0]!;
    clearTimeout(waiter.timer);
    waiter.resolve(frame);
  }

  #rejectAll(error: Error): void {
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

const clientFrame = (opcode: number, payload: Buffer, fin = true): Buffer => {
  assert.ok(payload.byteLength <= 125);
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const encoded = Buffer.allocUnsafe(2 + mask.byteLength + payload.byteLength);
  encoded[0] = (fin ? 0x80 : 0) | opcode;
  encoded[1] = 0x80 | payload.byteLength;
  mask.copy(encoded, 2);
  for (let index = 0; index < payload.byteLength; index += 1) {
    encoded[6 + index] = payload[index]! ^ mask[index % 4]!;
  }
  return encoded;
};

const closeCode = (frame: RawFrame): number => {
  assert.equal(frame.opcode, 0x08);
  assert.ok(frame.payload.byteLength >= 2);
  return frame.payload.readUInt16BE(0);
};

const within = async <T>(promise: Promise<T>, message: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 1_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

class PassThroughSocket extends Duplex {
  _read(): void {}
  _write(_chunk: any, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    callback();
  }
}

const listen = async (server: ReturnType<typeof createServer>, host: string): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port: 0, ipv6Only: host === "::1" }, resolve);
  });

const close = async (server: ReturnType<typeof createServer>): Promise<void> =>
  new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });

const rawUpgradeResponse = async (
  port: number,
  path: string,
  origin: string,
  extraHeader: string,
): Promise<string> => new Promise((resolve, reject) => {
  const socket = createConnection({ host: "::1", port });
  const chunks: Buffer[] = [];
  socket.once("error", reject);
  socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  socket.once("connect", () => {
    socket.write(
      `GET ${path} HTTP/1.1\r\n`
      + `Host: [::1]:${port}\r\n`
      + "Connection: Upgrade\r\n"
      + "Upgrade: websocket\r\n"
      + "Sec-WebSocket-Version: 13\r\n"
      + "Sec-WebSocket-Key: MDEyMzQ1Njc4OWFiY2RlZg==\r\n"
      + `Origin: ${origin}\r\n`
      + "Cookie: a=b\r\n"
      + extraHeader
      + "\r\n",
    );
  });
});

const opened = async (socket: WebSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    if (socket.readyState === WebSocket.OPEN) return resolve();
    socket.once("open", resolve);
    socket.once("error", reject);
  });

const closed = async (socket: WebSocket): Promise<void> =>
  new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) return resolve();
    socket.once("close", () => resolve());
  });

const onceTypedMessage = async (
  socket: WebSocket,
): Promise<{ data: Buffer; isBinary: boolean }> =>
  new Promise((resolve, reject) => {
    socket.once("message", (data, isBinary) => resolve({
      data: Buffer.from(data as any),
      isBinary,
    }));
    socket.once("error", reject);
  });

const onceDuplexClose = async (socket: Duplex): Promise<void> =>
  new Promise((resolve) => {
    if (socket.destroyed || ("readableEnded" in socket && socket.readableEnded)) return resolve();
    socket.once("end", resolve);
    socket.once("close", resolve);
  });

const onceClose = async (socket: WebSocket): Promise<{ code: number }> =>
  new Promise((resolve, reject) => {
    socket.once("close", (code) => resolve({ code }));
    socket.once("error", reject);
  });

import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";

const HANDSHAKE_TIMEOUT_MS = 5_000;
type BridgeCloseCode = 1000 | 1001 | 1002 | 1007 | 1008 | 1009 | 1011 | 1013;

export type BrowserWebSocketPeerIdentity = Readonly<{
  localAddress: "127.0.0.1";
  localPort: number;
  remoteAddress: "127.0.0.1";
  remotePort: number;
}>;

export type BrowserWebSocketBridgeAdmission = Readonly<{
  childPort: number;
  childPath: string;
  declaredProtocols: readonly string[];
  maxFrameBytes: number;
  idleTimeoutMs: number;
  expiresAtMs: number;
  brokerOrigin: string;
  inspectConnectedPeer(peer: BrowserWebSocketPeerIdentity): Promise<boolean>;
  live(): boolean;
  markOpen(): void;
  onClosed(): void;
}>;

export class BrowserWebSocketBridgeError extends Error {
  readonly status: number;
  readonly code:
    | "visual_websocket_protocol_denied"
    | "visual_websocket_limit"
    | "visual_websocket_timeout"
    | "visual_websocket_upstream_failed"
    | "visual_frame_unavailable";

  constructor(status: number, code: BrowserWebSocketBridgeError["code"]) {
    super("The visual WebSocket request was denied.");
    this.name = "BrowserWebSocketBridgeError";
    this.status = status;
    this.code = code;
  }
}

export class BrowserWebSocketOwner {
  readonly #raw: Duplex;
  #browser?: WebSocket;
  #child?: WebSocket;
  #terminated = false;
  #closedNotified = false;
  #onClosed?: () => void;

  constructor(raw: Duplex) {
    this.#raw = raw;
  }

  bind(browser: WebSocket, child: WebSocket): boolean {
    if (this.#terminated || this.#child !== child) {
      browser.terminate();
      child.terminate();
      return false;
    }
    this.#browser = browser;
    this.#child = child;
    return true;
  }

  attachChild(child: WebSocket): boolean {
    if (this.#child || this.#terminated) {
      child.terminate();
      return false;
    }
    this.#child = child;
    return true;
  }

  setOnClosed(callback: () => void): void {
    if (this.#onClosed) throw new Error("The WebSocket owner already has a release callback.");
    this.#onClosed = callback;
    if (this.#terminated) this.#notifyClosed();
  }

  close(code: 1008): void {
    this.#shutdown(code, true);
  }

  shutdown(code: BridgeCloseCode): void {
    this.#shutdown(code, false);
  }

  terminate(): void {
    this.#shutdown(undefined, true);
  }

  #shutdown(
    code: BridgeCloseCode | undefined,
    immediate: boolean,
  ): void {
    if (this.#terminated) return;
    this.#terminated = true;
    if (code !== undefined) {
      if (this.#browser?.readyState === WebSocket.OPEN) this.#browser.close(code);
      if (this.#child?.readyState === WebSocket.OPEN) this.#child.close(code);
    }
    const destroy = (): void => {
      this.#browser?.terminate();
      this.#child?.terminate();
      this.#raw.destroy();
      this.#notifyClosed();
    };
    if (immediate) destroy();
    else {
      const timer = setTimeout(destroy, 25);
      timer.unref?.();
    }
  }

  #notifyClosed(): void {
    if (this.#closedNotified || !this.#onClosed) return;
    this.#closedNotified = true;
    this.#onClosed();
  }

  get terminated(): boolean {
    return this.#terminated;
  }
}

export class BrowserWebSocketBridge {
  createOwner(socket: Duplex): BrowserWebSocketOwner {
    return new BrowserWebSocketOwner(socket);
  }

  async upgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    owner: BrowserWebSocketOwner,
    admission: BrowserWebSocketBridgeAdmission,
  ): Promise<void> {
    let pendingChild: PendingChildConnection | undefined;
    let browserAccepted = false;
    try {
      assertAdmission(admission);
      owner.setOnClosed(admission.onClosed);
      exactUpgradeHeaders(request, admission.brokerOrigin);
      const offered = exactOfferedProtocols(request);
      if ((admission.declaredProtocols.length === 0 && offered.length !== 0)
        || (admission.declaredProtocols.length > 0 && offered.length === 0)
        || offered.some((protocol) => !admission.declaredProtocols.includes(protocol))) {
        throw new BrowserWebSocketBridgeError(403, "visual_websocket_protocol_denied");
      }
      if (head.byteLength > admission.maxFrameBytes + 14) {
        throw new BrowserWebSocketBridgeError(429, "visual_websocket_limit");
      }
      pendingChild = await connectChild(owner, admission, offered);
      const child = pendingChild.child;
      const peer = exactChildPeer(child, admission.childPort);
      if (owner.terminated || !admission.live()
        || !await admission.inspectConnectedPeer(peer)
        || owner.terminated || !admission.live()) {
        throw new BrowserWebSocketBridgeError(409, "visual_frame_unavailable");
      }
      pendingChild.assertOpen();
      const selected = child.protocol;
      if (selected && (!offered.includes(selected) || !admission.declaredProtocols.includes(selected))) {
        throw new BrowserWebSocketBridgeError(403, "visual_websocket_protocol_denied");
      }
      if (admission.declaredProtocols.length > 0 && !selected) {
        throw new BrowserWebSocketBridgeError(403, "visual_websocket_protocol_denied");
      }
      const browser = await this.#acceptBrowser(
        request,
        socket,
        head,
        admission.maxFrameBytes,
        selected,
      );
      browserAccepted = true;
      if (!owner.bind(browser, child)) return;
      admission.markOpen();
      relay(owner, browser, child, admission, pendingChild.handoff);
    } catch (error) {
      pendingChild?.child.terminate();
      if (browserAccepted) owner.terminate();
      throw error;
    }
  }

  #acceptBrowser(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    maxPayload: number,
    selectedProtocol: string,
  ): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      try {
        const server = new WebSocketServer({
          noServer: true,
          perMessageDeflate: false,
          maxPayload,
          handleProtocols: (offered) =>
            selectedProtocol && offered.has(selectedProtocol) ? selectedProtocol : false,
        });
        server.handleUpgrade(request, socket, head, resolve);
      } catch (error) {
        reject(error);
      }
    });
  }
}

const connectChild = (
  owner: BrowserWebSocketOwner,
  admission: BrowserWebSocketBridgeAdmission,
  offered: readonly string[],
): Promise<PendingChildConnection> => new Promise((resolve, reject) => {
  let settled = false;
  let opened = false;
  let phaseError: Error | undefined;
  let phaseCloseCode: number | undefined;
  const child = new WebSocket(
    `ws://127.0.0.1:${admission.childPort}${admission.childPath}`,
    [...offered],
    {
      followRedirects: false,
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      maxPayload: admission.maxFrameBytes,
      perMessageDeflate: false,
      headers: {
        host: `127.0.0.1:${admission.childPort}`,
        origin: admission.brokerOrigin,
      },
    },
  );
  const failHandshake = (error: Error): void => {
    if (settled) return;
    settled = true;
    child.terminate();
    reject(error);
  };
  const onOpen = (): void => {
    if (settled) return;
    settled = true;
    opened = true;
    resolve(Object.freeze({
      child,
      assertOpen: (): void => {
        if (phaseError || phaseCloseCode !== undefined || child.readyState !== WebSocket.OPEN) {
          throw new BrowserWebSocketBridgeError(502, "visual_websocket_upstream_failed");
        }
      },
      handoff: (): PendingChildFailure | undefined => {
        child.off("error", onError);
        child.off("close", onClose);
        return phaseError
          ? Object.freeze({ error: phaseError })
          : phaseCloseCode !== undefined
            ? Object.freeze({ closeCode: phaseCloseCode })
            : undefined;
      },
    }));
  };
  const onError = (error: Error & { code?: string }): void => {
    phaseError ??= error;
    if (!opened) {
      failHandshake(
        error.code === "ETIMEDOUT" || /timed out/iu.test(error.message)
          ? new BrowserWebSocketBridgeError(504, "visual_websocket_timeout")
          : new BrowserWebSocketBridgeError(502, "visual_websocket_upstream_failed"),
      );
    }
  };
  const onClose = (code: number): void => {
    phaseCloseCode ??= code;
    if (!opened) {
      failHandshake(new BrowserWebSocketBridgeError(502, "visual_websocket_upstream_failed"));
    }
  };
  child.once("open", onOpen);
  child.on("error", onError);
  child.on("close", onClose);
  if (!owner.attachChild(child)) {
    failHandshake(new BrowserWebSocketBridgeError(409, "visual_frame_unavailable"));
  }
});

type PendingChildFailure = Readonly<{
  error?: Error;
  closeCode?: number;
}>;

type PendingChildConnection = Readonly<{
  child: WebSocket;
  assertOpen(): void;
  handoff(): PendingChildFailure | undefined;
}>;

const exactChildPeer = (
  child: WebSocket,
  expectedPort: number,
): BrowserWebSocketPeerIdentity => {
  const socket = (child as WebSocket & { _socket?: Socket })._socket;
  if (!socket
    || socket.localAddress !== "127.0.0.1"
    || socket.remoteAddress !== "127.0.0.1"
    || !validPort(socket.localPort)
    || socket.remotePort !== expectedPort) {
    throw new BrowserWebSocketBridgeError(409, "visual_frame_unavailable");
  }
  return Object.freeze({
    localAddress: "127.0.0.1",
    localPort: socket.localPort!,
    remoteAddress: "127.0.0.1",
    remotePort: expectedPort,
  });
};

const relay = (
  owner: BrowserWebSocketOwner,
  browser: WebSocket,
  child: WebSocket,
  admission: BrowserWebSocketBridgeAdmission,
  handoffChild: () => PendingChildFailure | undefined,
): void => {
  let closed = false;
  const bufferedLimit = admission.maxFrameBytes;
  let idleTimer: NodeJS.Timeout | undefined;
  let expiryTimer: NodeJS.Timeout | undefined;
  const finish = (code: BridgeCloseCode): void => {
    if (closed) return;
    closed = true;
    if (idleTimer) clearTimeout(idleTimer);
    if (expiryTimer) clearTimeout(expiryTimer);
    owner.shutdown(code);
  };
  const touch = (): void => {
    if (closed) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => finish(1001), admission.idleTimeoutMs);
    idleTimer.unref?.();
  };
  type Pending = Readonly<{ data: WebSocket.RawData; isBinary: boolean; bytes: number }>;
  const queues = new Map<"inbound" | "outbound", {
    active: boolean;
    bytes: number;
    items: Pending[];
  }>([
    ["inbound", { active: false, bytes: 0, items: [] }],
    ["outbound", { active: false, bytes: 0, items: [] }],
  ]);
  const forward = (
    source: WebSocket,
    destination: WebSocket,
    data: WebSocket.RawData,
    isBinary: boolean,
    direction: "inbound" | "outbound",
  ): void => {
    if (closed || destination.readyState !== WebSocket.OPEN) return finish(1011);
    const bytes = rawBytes(data);
    if (bytes > admission.maxFrameBytes) return finish(1009);
    const queue = queues.get(direction)!;
    if (queue.items.length >= 16 || queue.bytes + bytes > bufferedLimit) return finish(1013);
    queue.items.push({ data, isBinary, bytes });
    queue.bytes += bytes;
    source.pause();
    const flush = (): void => {
      if (closed || queue.active) return;
      const next = queue.items.shift();
      if (!next) {
        source.resume();
        return;
      }
      queue.bytes -= next.bytes;
      if (destination.readyState !== WebSocket.OPEN
        || destination.bufferedAmount + next.bytes > bufferedLimit) return finish(1013);
      queue.active = true;
      destination.send(next.data, { binary: next.isBinary, compress: false }, (error) => {
        queue.active = false;
        if (error || closed) return finish(1011);
        touch();
        flush();
      });
    };
    flush();
  };
  browser.on("message", (data, isBinary) => forward(browser, child, data, isBinary, "inbound"));
  child.on("message", (data, isBinary) => forward(child, browser, data, isBinary, "outbound"));
  for (const peer of [browser, child]) {
    peer.on("ping", touch);
    peer.on("pong", touch);
  }
  const onChildClose = (code: number): void => finish(code === 1000 ? 1000 : 1011);
  const onChildError = (error: Error): void => finish(webSocketErrorCloseCode(error));
  browser.once("close", (code) => finish(code === 1000 ? 1000 : 1008));
  child.once("close", onChildClose);
  browser.once("error", (error) => finish(webSocketErrorCloseCode(error)));
  child.once("error", onChildError);
  const pendingFailure = handoffChild();
  if (pendingFailure?.error) finish(webSocketErrorCloseCode(pendingFailure.error));
  else if (pendingFailure?.closeCode !== undefined) {
    finish(pendingFailure.closeCode === 1000 ? 1000 : 1011);
  }
  if (closed) return;
  touch();
  expiryTimer = setTimeout(() => finish(1001), Math.max(1, admission.expiresAtMs - Date.now()));
  expiryTimer.unref?.();
};

const rawBytes = (data: WebSocket.RawData): number => Array.isArray(data)
  ? data.reduce((total, part) => total + part.byteLength, 0)
  : data.byteLength;

const webSocketErrorCloseCode = (
  error: Error,
): 1002 | 1007 | 1009 | 1011 => {
  const code = (error as Error & { code?: string }).code;
  if (code === "WS_ERR_INVALID_UTF8") return 1007;
  if (code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
    || code === "WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH") return 1009;
  if (code?.startsWith("WS_ERR_")) return 1002;
  return 1011;
};

const exactOfferedProtocols = (request: IncomingMessage): readonly string[] => {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "sec-websocket-protocol") {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  if (values.length === 0) return Object.freeze([]);
  if (values.length !== 1) {
    throw new BrowserWebSocketBridgeError(403, "visual_websocket_protocol_denied");
  }
  const protocols = values[0]!.split(",").map((value) => value.trim());
  if (protocols.length < 1 || protocols.length > 8
    || protocols.some((value) => !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/u.test(value))
    || new Set(protocols).size !== protocols.length) {
    throw new BrowserWebSocketBridgeError(403, "visual_websocket_protocol_denied");
  }
  return Object.freeze(protocols);
};

const exactUpgradeHeaders = (
  request: IncomingMessage,
  brokerOrigin: string,
): void => {
  if (request.method !== "GET" || request.httpVersion !== "1.1") {
    throw new BrowserWebSocketBridgeError(403, "visual_websocket_protocol_denied");
  }
  const values = (name: string): readonly string[] => {
    const found: string[] = [];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      if (request.rawHeaders[index]?.toLowerCase() === name) {
        found.push(request.rawHeaders[index + 1] ?? "");
      }
    }
    return found;
  };
  const connection = values("connection");
  const upgrade = values("upgrade");
  const version = values("sec-websocket-version");
  const key = values("sec-websocket-key");
  const origin = values("origin");
  const cookies = values("cookie");
  const authorization = values("authorization");
  const extensions = values("sec-websocket-extensions");
  const connectionTokens = connection.length === 1
    ? connection[0]!.split(",").map((value) => value.trim().toLowerCase())
    : [];
  if (connection.length !== 1 || !connectionTokens.includes("upgrade")
    || upgrade.length !== 1 || upgrade[0]!.toLowerCase() !== "websocket"
    || version.length !== 1 || version[0] !== "13"
    || key.length !== 1 || !exactWebSocketKey(key[0]!)
    || origin.length !== 1 || origin[0] !== brokerOrigin
    || cookies.length !== 1
    || authorization.length !== 0
    || extensions.length > 1
    || [...connection, ...upgrade, ...version, ...key, ...origin, ...cookies, ...extensions]
      .some((value) => /[\r\n\u0000]/u.test(value))) {
    throw new BrowserWebSocketBridgeError(403, "visual_websocket_protocol_denied");
  }
};

const exactWebSocketKey = (value: string): boolean => {
  if (!/^[A-Za-z0-9+/]{22}==$/u.test(value)) return false;
  try {
    return Buffer.from(value, "base64").byteLength === 16;
  } catch {
    return false;
  }
};

const assertAdmission = (input: BrowserWebSocketBridgeAdmission): void => {
  if (!validPort(input.childPort)
    || typeof input.childPath !== "string"
    || !input.childPath.startsWith("/")
    || input.childPath.startsWith("//")
    || input.childPath.includes("?")
    || input.childPath.includes("#")
    || input.childPath.includes("\\")
    || input.declaredProtocols.length > 8
    || input.declaredProtocols.some((value) =>
      !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/u.test(value))
    || new Set(input.declaredProtocols).size !== input.declaredProtocols.length
    || !Number.isSafeInteger(input.maxFrameBytes)
    || input.maxFrameBytes < 1
    || input.maxFrameBytes > 1_048_576
    || !Number.isSafeInteger(input.idleTimeoutMs)
    || input.idleTimeoutMs < 1_000
    || input.idleTimeoutMs > 300_000
    || !Number.isSafeInteger(input.expiresAtMs)
    || input.expiresAtMs <= Date.now()
    || !/^https?:\/\/\[::1\]:\d+$/u.test(input.brokerOrigin)) {
    throw new BrowserWebSocketBridgeError(403, "visual_websocket_protocol_denied");
  }
};

const validPort = (value: number | undefined): value is number =>
  Number.isSafeInteger(value) && value! >= 1 && value! <= 65_535;

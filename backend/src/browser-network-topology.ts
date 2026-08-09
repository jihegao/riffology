import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

export const BROWSER_LOOPBACK_HOST = "::1" as const;
export const BROWSER_AUTHORITY_HOST = "localhost" as const;

export type BrowserNetworkRole = "platform" | "broker";

export type BrowserNetworkAddress = {
  host: typeof BROWSER_LOOPBACK_HOST;
  port: number;
  authority: string;
  origin: string;
};

export type BrowserNetworkHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  address: BrowserNetworkAddress,
) => void | Promise<void>;

export type BrowserNetworkUpgradeHandler = (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  address: BrowserNetworkAddress,
) => void | Promise<void>;

export type BrowserNetworkTopologyOptions = {
  appPort?: number;
  brokerPort?: number;
  appPublicOrigin?: string;
  brokerPublicOrigin?: string;
  closeDrainTimeoutMs?: number;
  appHandler: BrowserNetworkHandler;
  brokerHandler: BrowserNetworkHandler;
  brokerUpgradeHandler?: BrowserNetworkUpgradeHandler;
  beforeReady?: (addresses: Readonly<{
    app: BrowserNetworkAddress;
    broker: BrowserNetworkAddress;
  }>) => void | Promise<void>;
};

export class BrowserNetworkTopologyError extends Error {
  readonly code:
    | "platform_listener_invalid"
    | "platform_listener_unavailable"
    | "broker_listener_unavailable";

  constructor(
    code:
      | "platform_listener_invalid"
      | "platform_listener_unavailable"
      | "broker_listener_unavailable",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BrowserNetworkTopologyError";
    this.code = code;
  }
}

export class BrowserNetworkTopology {
  readonly app: BrowserNetworkAddress;
  readonly broker: BrowserNetworkAddress;
  readonly #appServer: Server;
  readonly #brokerServer: Server;
  readonly #appIpv4Guard: Server;
  readonly #brokerIpv4Guard: Server;
  readonly #gate: RequestGate;
  readonly #closeDrainTimeoutMs: number;
  #closed = false;

  private constructor(
    appServer: Server,
    brokerServer: Server,
    appIpv4Guard: Server,
    brokerIpv4Guard: Server,
    app: BrowserNetworkAddress,
    broker: BrowserNetworkAddress,
    gate: RequestGate,
    closeDrainTimeoutMs: number,
  ) {
    this.#appServer = appServer;
    this.#brokerServer = brokerServer;
    this.#appIpv4Guard = appIpv4Guard;
    this.#brokerIpv4Guard = brokerIpv4Guard;
    this.app = app;
    this.broker = broker;
    this.#gate = gate;
    this.#closeDrainTimeoutMs = closeDrainTimeoutMs;
  }

  static async start(options: BrowserNetworkTopologyOptions): Promise<BrowserNetworkTopology> {
    const appPort = exactPort(options.appPort ?? 0);
    const brokerPort = exactPort(options.brokerPort ?? 0);
    const closeDrainTimeoutMs = exactDrainTimeout(options.closeDrainTimeoutMs ?? 5_000);
    if (appPort !== 0 && appPort === brokerPort) {
      throw new BrowserNetworkTopologyError(
        "platform_listener_invalid",
        "The platform app and visual broker must use different server-owned ports.",
      );
    }
    if ((options.appPublicOrigin === undefined) !== (options.brokerPublicOrigin === undefined)) {
      throw new BrowserNetworkTopologyError(
        "platform_listener_invalid",
        "Public browser origins must configure both the platform app and visual broker.",
      );
    }
    const appPublicOrigin = options.appPublicOrigin === undefined
      ? undefined
      : exactPublicOrigin(options.appPublicOrigin);
    const brokerPublicOrigin = options.brokerPublicOrigin === undefined
      ? undefined
      : exactPublicOrigin(options.brokerPublicOrigin);
    if (appPublicOrigin && brokerPublicOrigin && appPublicOrigin.origin === brokerPublicOrigin.origin) {
      throw new BrowserNetworkTopologyError(
        "platform_listener_invalid",
        "The public platform app and visual broker origins must be distinct.",
      );
    }

    let appAddress: BrowserNetworkAddress | undefined;
    let brokerAddress: BrowserNetworkAddress | undefined;
    const gate: RequestGate = {
      ready: false,
      closing: false,
      inFlight: new Set(),
      upgradedSockets: new Set(),
    };
    const appServer = createExactServer("platform", () => appAddress, options.appHandler, undefined, gate);
    const brokerServer = createExactServer(
      "broker",
      () => brokerAddress,
      options.brokerHandler,
      options.brokerUpgradeHandler,
      gate,
    );
    let appIpv4Guard: Server | undefined;
    let brokerIpv4Guard: Server | undefined;
    try {
      appAddress = publicAddress(
        await listenExact(appServer, appPort, "platform_listener_unavailable"),
        appPublicOrigin,
      );
      brokerAddress = publicAddress(
        await listenExact(brokerServer, brokerPort, "broker_listener_unavailable"),
        brokerPublicOrigin,
      );
      if (appAddress.port === brokerAddress.port) {
        throw new BrowserNetworkTopologyError(
          "platform_listener_invalid",
          "The platform app and visual broker resolved to the same port.",
        );
      }
      appIpv4Guard = await listenIpv4Guard(appAddress.port, "platform_listener_unavailable");
      brokerIpv4Guard = await listenIpv4Guard(brokerAddress.port, "broker_listener_unavailable");
      await options.beforeReady?.(Object.freeze({ app: appAddress, broker: brokerAddress }));
      gate.ready = true;
      return new BrowserNetworkTopology(
        appServer,
        brokerServer,
        appIpv4Guard,
        brokerIpv4Guard,
        appAddress,
        brokerAddress,
        gate,
        closeDrainTimeoutMs,
      );
    } catch (error) {
      gate.closing = true;
      const partialServers = [
        appServer,
        brokerServer,
        ...(appIpv4Guard ? [appIpv4Guard] : []),
        ...(brokerIpv4Guard ? [brokerIpv4Guard] : []),
      ];
      const closing = partialServers.map((server) => closeServer(server));
      for (const server of partialServers) {
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
      }
      await Promise.allSettled(closing);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#gate.closing = true;
    this.#gate.ready = false;
    this.#appServer.closeIdleConnections?.();
    this.#brokerServer.closeIdleConnections?.();
    this.#appIpv4Guard.closeIdleConnections?.();
    this.#brokerIpv4Guard.closeIdleConnections?.();
    for (const socket of this.#gate.upgradedSockets) socket.destroy();
    this.#gate.upgradedSockets.clear();
    const closing = [
      closeServer(this.#brokerServer),
      closeServer(this.#appServer),
      closeServer(this.#brokerIpv4Guard),
      closeServer(this.#appIpv4Guard),
    ];
    await boundedDrain([...this.#gate.inFlight], this.#closeDrainTimeoutMs);
    this.#appServer.closeIdleConnections?.();
    this.#brokerServer.closeIdleConnections?.();
    this.#appServer.closeAllConnections?.();
    this.#brokerServer.closeAllConnections?.();
    this.#appIpv4Guard.closeAllConnections?.();
    this.#brokerIpv4Guard.closeAllConnections?.();
    const results = await Promise.allSettled(closing);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (rejected) throw rejected.reason;
  }
}

type RequestGate = {
  ready: boolean;
  closing: boolean;
  inFlight: Set<Promise<void>>;
  upgradedSockets: Set<Duplex>;
};

const listenIpv4Guard = async (
  port: number,
  failureCode: "platform_listener_unavailable" | "broker_listener_unavailable",
): Promise<Server> => {
  const server = createServer((_request, response) => {
    networkError(response, 421, "ipv4_authority_denied");
  });
  server.on("upgrade", (_request, socket) => rejectUpgrade(socket, 421, "ipv4_authority_denied"));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port }, resolve);
    });
    return server;
  } catch (error) {
    await closeServer(server);
    throw new BrowserNetworkTopologyError(
      failureCode,
      "The IPv4 same-port denial reservation is unavailable.",
      { cause: error },
    );
  }
};

const createExactServer = (
  role: BrowserNetworkRole,
  address: () => BrowserNetworkAddress | undefined,
  handler: BrowserNetworkHandler,
  upgradeHandler: BrowserNetworkUpgradeHandler | undefined,
  gate: RequestGate,
): Server => {
  const server = createServer({ maxHeaderSize: 32 * 1_024 }, (request, response) => {
    const current = address();
    if (!current || !gate.ready || gate.closing) return networkError(response, 503, `${role}_listener_unavailable`);
    if (request.headers.host !== current.authority) {
      return networkError(response, 421, role === "platform" ? "platform_host_denied" : "broker_host_denied");
    }
    const operation = Promise.resolve().then(() => handler(request, response, current)).then(() => undefined).catch(() => {
      if (!response.headersSent) networkError(response, 500, `${role}_request_failed`);
      else response.end();
    });
    gate.inFlight.add(operation);
    void operation.then(() => gate.inFlight.delete(operation));
  });
  server.on("upgrade", (request, socket, head) => {
    const current = address();
    gate.upgradedSockets.add(socket);
    socket.once("close", () => gate.upgradedSockets.delete(socket));
    if (!current || !gate.ready || gate.closing) {
      return rejectUpgrade(socket, 503, `${role}_listener_unavailable`);
    }
    if (exactRawHost(request) !== current.authority) {
      return rejectUpgrade(
        socket,
        421,
        role === "platform" ? "platform_host_denied" : "broker_host_denied",
      );
    }
    if (role !== "broker" || !upgradeHandler) {
      return rejectUpgrade(socket, 404, `${role}_upgrade_denied`);
    }
    const operation = Promise.resolve()
      .then(() => upgradeHandler(request, socket, Buffer.from(head), current))
      .then(() => undefined)
      .catch(() => rejectUpgrade(socket, 500, "broker_upgrade_failed"));
    gate.inFlight.add(operation);
    void operation.then(() => gate.inFlight.delete(operation));
  });
  server.on("clientError", (error: NodeJS.ErrnoException, socket: Duplex) => {
    if (!socket.writable) return socket.destroy();
    const overflow = error.code === "HPE_HEADER_OVERFLOW";
    const status = overflow && role === "broker" ? 502 : 400;
    const code = overflow && role === "broker"
      ? "visual_frame_proxy_limit_exceeded"
      : `${role}_request_failed`;
    const body = Buffer.from(JSON.stringify({
      accepted: false,
      error: { code, message: "The browser network request was denied." },
    }));
    socket.end([
      `HTTP/1.1 ${status} ${status === 502 ? "Bad Gateway" : "Bad Request"}`,
      "Connection: close",
      "Content-Type: application/json; charset=utf-8",
      `Content-Length: ${body.byteLength}`,
      "Cache-Control: no-store",
      "X-Content-Type-Options: nosniff",
      "",
      body.toString("utf8"),
    ].join("\r\n"));
  });
  return server;
};

const exactRawHost = (request: IncomingMessage): string | undefined => {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "host") {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  return values.length === 1 && !/[\r\n\u0000]/u.test(values[0]!) ? values[0] : undefined;
};

export const rejectUpgrade = (
  socket: Duplex,
  status: number,
  code: string,
): void => {
  if (!socket.writable || socket.destroyed) {
    socket.destroy();
    return;
  }
  const safeStatus = [400, 403, 404, 405, 409, 421, 429, 500, 502, 503, 504].includes(status)
    ? status
    : 500;
  const safeCode = /^[a-z][a-z0-9_]{0,63}$/u.test(code) ? code : "broker_upgrade_failed";
  const body = Buffer.from(JSON.stringify({
    accepted: false,
    error: { code: safeCode, message: "The browser network request was denied." },
  }));
  socket.end([
    `HTTP/1.1 ${safeStatus} ${upgradeStatusText(safeStatus)}`,
    "Connection: close",
    "Content-Type: application/json; charset=utf-8",
    `Content-Length: ${body.byteLength}`,
    "Cache-Control: no-store",
    "X-Content-Type-Options: nosniff",
    "",
    body.toString("utf8"),
  ].join("\r\n"));
};

const upgradeStatusText = (status: number): string => ({
  400: "Bad Request",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  421: "Misdirected Request",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
})[status] ?? "Internal Server Error";

const listenExact = async (
  server: Server,
  port: number,
  failureCode: "platform_listener_unavailable" | "broker_listener_unavailable",
): Promise<BrowserNetworkAddress> => {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(new BrowserNetworkTopologyError(failureCode, "The exact IPv6 loopback listener is unavailable.", { cause: error }));
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: BROWSER_LOOPBACK_HOST, port, ipv6Only: true });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new BrowserNetworkTopologyError(failureCode, "The listener did not expose a TCP address.");
  }
  if ((address as AddressInfo).address !== BROWSER_LOOPBACK_HOST || (address as AddressInfo).family !== "IPv6") {
    throw new BrowserNetworkTopologyError(failureCode, "The listener did not exact-bind IPv6 loopback.");
  }
  const boundPort = (address as AddressInfo).port;
  return Object.freeze({
    host: BROWSER_LOOPBACK_HOST,
    port: boundPort,
    authority: `${BROWSER_AUTHORITY_HOST}:${boundPort}`,
    origin: `http://${BROWSER_AUTHORITY_HOST}:${boundPort}`,
  });
};

const exactPort = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) {
    throw new BrowserNetworkTopologyError(
      "platform_listener_invalid",
      "Browser listener ports must be integers from 0 through 65535.",
    );
  }
  return value;
};

const exactPublicOrigin = (value: string): URL => {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.pathname !== "/"
    || url.search || url.hash || url.username || url.password || !url.hostname
    || url.hostname === "localhost") {
    throw new BrowserNetworkTopologyError(
      "platform_listener_invalid",
      "Public browser origins must be canonical HTTPS origins without credentials, paths, query, or fragment.",
    );
  }
  return url;
};

const publicAddress = (
  address: BrowserNetworkAddress,
  publicOrigin: URL | undefined,
): BrowserNetworkAddress => publicOrigin
  ? Object.freeze({
    ...address,
    authority: publicOrigin.host,
    origin: publicOrigin.origin,
  })
  : address;

const exactDrainTimeout = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 30_000) {
    throw new BrowserNetworkTopologyError(
      "platform_listener_invalid",
      "The browser listener close-drain timeout must be an integer from 1 through 30000 milliseconds.",
    );
  }
  return value;
};

const boundedDrain = async (operations: Promise<void>[], timeoutMs: number): Promise<void> => {
  if (operations.length === 0) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.allSettled(operations).then(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const closeServer = async (server: Server): Promise<void> => {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
};

export const networkJson = (
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void => {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": bytes.byteLength,
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(bytes);
};

const networkError = (response: ServerResponse, status: number, code: string): void =>
  networkJson(response, status, { accepted: false, error: { code, message: "The browser network request was denied." } });

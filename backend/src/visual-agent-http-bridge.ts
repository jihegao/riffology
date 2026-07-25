import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request, Agent, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import {
  inspectVisualConnectedPeerAsync,
  inspectVisualListenerAsync,
} from "./visual-listener-inspector.ts";

export type ExactPeerVisualTarget = Readonly<{
  runId: string;
  processAttemptId: string;
  pid: number;
  processStartToken: string;
  processGroupId: number;
  loopbackHost: "127.0.0.1";
  loopbackPort: number;
}>;

export type ExactPeerInspectionPort = Readonly<{
  inspectListener(target: ExactPeerVisualTarget): Promise<void>;
  inspectConnectedPeer(target: ExactPeerVisualTarget, localPort: number): Promise<void>;
}>;

export class VisualAgentHttpBridgeError extends Error {
  constructor() { super("The scoped visual interaction transport is unavailable."); this.name = "VisualAgentHttpBridgeError"; }
}

const denied = (): VisualAgentHttpBridgeError => new VisualAgentHttpBridgeError();
const MAX_PATH_BYTES = 4_096;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_BODY_BYTES = 512 * 1024;
const DEADLINE_MS = 5_000;
const MAX_ACTIVE_REQUESTS = 16;
const BRIDGE_HEADER = "x-riff-agent-bridge";
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * One browser interaction receives one random localhost relay. The relay is
 * backend-private: it has no cookie, nonce, MCP route, or persisted state.
 */
export class VisualAgentHttpBridge {
  readonly #target: ExactPeerVisualTarget;
  readonly #assertLive: () => void;
  readonly #inspection: ExactPeerInspectionPort;
  readonly #signal: AbortSignal;
  readonly #deadlineMs: number;
  readonly #requestToken = randomBytes(32).toString("base64url");
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();
  readonly #abort: () => void;
  #origin?: string;
  #closed = false;
  #activeRequests = 0;

  private constructor(
    target: ExactPeerVisualTarget,
    assertLive: () => void,
    inspection: ExactPeerInspectionPort,
    signal: AbortSignal,
    deadlineMs: number,
  ) {
    this.#target = target;
    this.#assertLive = assertLive;
    this.#inspection = inspection;
    this.#signal = signal;
    this.#deadlineMs = deadlineMs;
    this.#abort = () => { void this.close(); };
    this.#server = createServer((request, response) => { void this.#handle(request, response); });
    this.#server.on("connection", (socket) => {
      this.#sockets.add(socket);
      socket.once("close", () => this.#sockets.delete(socket));
    });
    signal.addEventListener("abort", this.#abort, { once: true });
  }

  static async open(input: Readonly<{
    target: ExactPeerVisualTarget;
    assertLive: () => void;
    inspection?: Partial<ExactPeerInspectionPort>;
    deadlineMs?: number;
    signal: AbortSignal;
  }>): Promise<VisualAgentHttpBridge> {
    const target = validTarget(input.target);
    if (input.signal.aborted) throw denied();
    const inspection: ExactPeerInspectionPort = Object.freeze({
      inspectListener: input.inspection?.inspectListener ?? (async (candidate) => {
        await inspectVisualListenerAsync(identity(candidate));
      }),
      inspectConnectedPeer: input.inspection?.inspectConnectedPeer ?? (async (candidate, localPort) => {
        await inspectVisualConnectedPeerAsync({ ...identity(candidate), brokerLocalPort: localPort });
      }),
    });
    const deadlineMs = input.deadlineMs ?? DEADLINE_MS;
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > DEADLINE_MS) {
      throw denied();
    }
    const bridge = new VisualAgentHttpBridge(
      target,
      input.assertLive,
      inspection,
      input.signal,
      deadlineMs,
    );
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => { void bridge.close(); reject(denied()); };
      const onError = (error: Error): void => { input.signal.removeEventListener("abort", onAbort); reject(error); };
      bridge.#server.once("error", onError);
      bridge.#server.listen({ host: "127.0.0.1", port: 0 }, () => {
        bridge.#server.off("error", onError);
        input.signal.removeEventListener("abort", onAbort);
        if (bridge.#closed || input.signal.aborted) {
          bridge.#server.close(() => reject(denied()));
          return;
        }
        const address = bridge.#server.address();
        if (!address || typeof address === "string") { void bridge.close(); reject(denied()); return; }
        bridge.#origin = `http://127.0.0.1:${address.port}`;
        resolve();
      });
      input.signal.addEventListener("abort", onAbort, { once: true });
    }).catch(() => { throw denied(); });
    return bridge;
  }

  get origin(): string { if (!this.#origin || this.#closed) throw denied(); return this.#origin; }

  get requestHeaders(): Readonly<Record<string, string>> {
    if (this.#closed) throw denied();
    return Object.freeze({ [BRIDGE_HEADER]: this.#requestToken });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#signal.removeEventListener("abort", this.#abort);
    for (const socket of this.#sockets) socket.destroy();
    if (!this.#server.listening) return;
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  async #handle(requestIn: IncomingMessage, response: ServerResponse): Promise<void> {
    let acquired = false;
    try {
      if (this.#closed || !this.#origin) throw denied();
      if (this.#activeRequests >= MAX_ACTIVE_REQUESTS) throw denied();
      this.#activeRequests += 1;
      acquired = true;
      const host = requestIn.headers.host;
      if (host !== new URL(this.#origin).host || Array.isArray(host)) throw denied();
      const requestToken = requestIn.headers[BRIDGE_HEADER];
      if (typeof requestToken !== "string"
        || !equalSecret(requestToken, this.#requestToken)) throw denied();
      if (requestIn.method !== "GET" && requestIn.method !== "HEAD") throw denied();
      if (requestIn.headers.cookie || requestIn.headers.authorization || requestIn.headers["proxy-authorization"]
        || (requestIn.headers.origin && requestIn.headers.origin !== this.#origin)
        || requestIn.headers.upgrade || requestIn.headers.connection?.toLowerCase().includes("upgrade")
        || requestIn.headers["content-length"] !== undefined
        || requestIn.headers["transfer-encoding"] !== undefined) throw denied();
      const path = normalizedPath(requestIn.url ?? "");
      const body = await this.#requestChild(path, requestIn.method);
      response.writeHead(body.status, {
        "cache-control": "no-store",
        "content-length": String(requestIn.method === "HEAD" ? 0 : body.bytes.byteLength),
        "content-security-policy": CSP,
        "content-type": body.contentType,
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      });
      response.end(requestIn.method === "HEAD" ? undefined : body.bytes);
    } catch {
      if (!response.headersSent) {
        response.writeHead(502, {
          "cache-control": "no-store",
          "content-length": "0",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
        });
      }
      response.end();
    } finally {
      if (acquired) this.#activeRequests -= 1;
    }
  }

  async #requestChild(path: string, method: "GET" | "HEAD"): Promise<Readonly<{ status: number; contentType: string; bytes: Buffer }>> {
    return await withAbsoluteDeadline(this.#signal, this.#deadlineMs, async (signal) => {
      this.#assertLive();
      await abortable(this.#inspection.inspectListener(this.#target), signal);
      const socket = await connectExact(this.#target.loopbackPort, signal);
      try {
        if (socket.localAddress !== "127.0.0.1" || socket.remoteAddress !== "127.0.0.1"
          || socket.remotePort !== this.#target.loopbackPort || !Number.isSafeInteger(socket.localPort)) throw denied();
        await abortable(
          this.#inspection.inspectConnectedPeer(this.#target, socket.localPort),
          signal,
        );
        const result = await requestExact(
          socket,
          this.#target.loopbackPort,
          path,
          method,
          signal,
        );
        this.#assertLive();
        return result;
      } finally {
        socket.destroy();
      }
    });
  }
}

const validTarget = (target: ExactPeerVisualTarget): ExactPeerVisualTarget => {
  if (!target || target.loopbackHost !== "127.0.0.1" || !Number.isSafeInteger(target.loopbackPort)
    || target.loopbackPort < 1 || target.loopbackPort > 65_535 || !Number.isSafeInteger(target.pid) || target.pid < 1
    || !Number.isSafeInteger(target.processGroupId) || target.processGroupId < 1
    || !boundedId(target.runId) || !boundedId(target.processAttemptId)
    || typeof target.processStartToken !== "string" || target.processStartToken.length < 1 || target.processStartToken.length > 300) throw denied();
  return Object.freeze({ ...target });
};
const boundedId = (value: unknown): value is string => typeof value === "string" && value.length >= 3 && value.length <= 128;
const identity = (target: ExactPeerVisualTarget) => ({ runId: target.runId, processAttemptId: target.processAttemptId, pid: target.pid, processStartToken: target.processStartToken, processGroupId: target.processGroupId, assignedPort: target.loopbackPort });
const normalizedPath = (raw: string): string => {
  if (!raw.startsWith("/") || Buffer.byteLength(raw, "utf8") > MAX_PATH_BYTES || /[\\\u0000]/u.test(raw)) throw denied();
  const parsed = new URL(raw, "http://bridge.invalid");
  const normalized = `${parsed.pathname}${parsed.search}`;
  if (parsed.origin !== "http://bridge.invalid" || normalized !== raw || parsed.hash) throw denied();
  return normalized;
};

const connectExact = async (port: number, signal: AbortSignal): Promise<Socket> => await new Promise<Socket>((resolve, reject) => {
  if (signal.aborted) { reject(denied()); return; }
  const socket = connect({ host: "127.0.0.1", port });
  const onAbort = (): void => { socket.destroy(); reject(denied()); };
  signal.addEventListener("abort", onAbort, { once: true });
  socket.once("connect", () => { signal.removeEventListener("abort", onAbort); resolve(socket); });
  socket.once("error", () => { signal.removeEventListener("abort", onAbort); socket.destroy(); reject(denied()); });
});

const requestExact = async (socket: Socket, port: number, path: string, method: "GET" | "HEAD", signal: AbortSignal): Promise<Readonly<{ status: number; contentType: string; bytes: Buffer }>> => await new Promise((resolve, reject) => {
  if (signal.aborted) { reject(denied()); return; }
  const agent = new Agent({ keepAlive: false });
  agent.createConnection = (_options, callback) => { callback?.(null, socket); return socket; };
  let settled = false;
  const finish = (error?: unknown, result?: Readonly<{ status: number; contentType: string; bytes: Buffer }>): void => {
    if (settled) return;
    settled = true;
    signal.removeEventListener("abort", onAbort);
    agent.destroy();
    if (error) reject(denied()); else resolve(result!);
  };
  const child = request({ host: "127.0.0.1", port, path, method, headers: { accept: "text/html, text/css, application/javascript, image/*, font/*, */*;q=0.1", "accept-encoding": "identity", connection: "close" }, agent, maxHeaderSize: MAX_HEADER_BYTES }, (response) => {
    const contentType = String(response.headers["content-type"] ?? "");
    const contentLength = String(response.headers["content-length"] ?? "");
    if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300
      || !contentType || Buffer.byteLength(contentType, "utf8") > 256
      || /[\r\n\u0000]/u.test(contentType) || response.headers["set-cookie"] || response.headers.location || response.headers.refresh
      || response.headers["www-authenticate"] || response.headers["proxy-authenticate"]
      || !allowedContentType(contentType)
      || (contentLength && (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES))) {
      response.destroy(); finish(denied()); return;
    }
    const chunks: Buffer[] = []; let length = 0;
    response.on("data", (chunk: Buffer) => { length += chunk.byteLength; if (length > MAX_BODY_BYTES) { response.destroy(); finish(denied()); } else chunks.push(Buffer.from(chunk)); });
    response.on("end", () => finish(undefined, Object.freeze({ status: response.statusCode!, contentType, bytes: Buffer.concat(chunks, length) })));
    response.on("error", () => finish(denied()));
  });
  const onAbort = (): void => { child.destroy(); finish(denied()); };
  signal.addEventListener("abort", onAbort, { once: true });
  child.on("error", () => finish(denied()));
  child.end();
});

const withAbsoluteDeadline = async <T>(
  outerSignal: AbortSignal,
  deadlineMs: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = (): void => controller.abort();
  outerSignal.addEventListener("abort", onAbort, { once: true });
  try {
    if (outerSignal.aborted) controller.abort();
    timer = setTimeout(() => controller.abort(), deadlineMs);
    timer.unref?.();
    return await abortable(
      Promise.resolve().then(() => work(controller.signal)),
      controller.signal,
    );
  } finally {
    if (timer) clearTimeout(timer);
    outerSignal.removeEventListener("abort", onAbort);
  }
};

const abortable = async <T>(work: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) throw denied();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(denied());
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
};

const allowedContentType = (value: string): boolean => {
  const mediaType = value.split(";", 1)[0]!.trim().toLowerCase();
  return mediaType === "text/html"
    || mediaType === "text/css"
    || new Set([
      "application/javascript",
      "text/javascript",
      "application/json",
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "image/svg+xml",
      "font/woff",
      "font/woff2",
      "application/font-woff",
    ]).has(mediaType);
};

const equalSecret = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.byteLength === rightBytes.byteLength
    && timingSafeEqual(leftBytes, rightBytes);
};

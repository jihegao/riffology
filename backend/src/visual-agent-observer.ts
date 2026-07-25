import { Agent, request } from "node:http";
import { connect, type Socket } from "node:net";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import {
  inspectVisualConnectedPeerAsync,
  inspectVisualListenerAsync,
} from "./visual-listener-inspector.ts";

/** The complete read-only observation vocabulary. */
export type VisualObservationKind =
  | "observe_structured"
  | "observe_accessibility"
  | "observe_dom_text"
  | "observe_screenshot";

/**
 * A backend-private projection of the authority-resolved target.  It is
 * intentionally not an MCP input type: callers cannot select an origin,
 * request path, cookie jar, or browser profile.
 */
export type VisualAgentObservationTarget = Readonly<{
  runId: string;
  processAttemptId: string;
  pid: number;
  processStartToken: string;
  processGroupId: number;
  loopbackHost: "127.0.0.1";
  loopbackPort: number;
  structuredInspectionPath?: string;
}>;

export type VisualAgentObservationInspectionPort = Readonly<{
  inspectListener(target: VisualAgentObservationTarget): Promise<void>;
  inspectConnectedPeer(
    target: VisualAgentObservationTarget,
    localPort: number,
  ): Promise<void>;
}>;

export type VisualAgentObservation =
  | Readonly<{
    schemaVersion: 1;
    kind: "observe_structured";
    untrusted: true;
    contentType: "application/json";
    value: unknown;
  }>
  | Readonly<{
    schemaVersion: 1;
    kind: "observe_accessibility" | "observe_dom_text";
    untrusted: true;
    contentType: "text/plain";
    text: string;
  }>
  | Readonly<{
    schemaVersion: 1;
    kind: "observe_screenshot";
    untrusted: true;
    contentType: "image/png";
    pngBase64: string;
  }>;

export class VisualAgentObservationError extends Error {
  readonly code = "visual_observation_failed";

  constructor() {
    super("The scoped visual observation is unavailable.");
    this.name = "VisualAgentObservationError";
  }
}

const denied = (): VisualAgentObservationError => new VisualAgentObservationError();

const NAVIGATION_TIMEOUT_MS = 5_000;
const MAX_STRUCTURED_BYTES = 256 * 1024;
const MAX_TEXT_BYTES = 128 * 1024;
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
const MAX_HTML_BYTES = 512 * 1024;
const MAX_DOM_NODES = 4_096;
const MAX_RESPONSE_HEADER_BYTES = 16 * 1024;
const STATIC_SNAPSHOT_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "script-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");
const MAX_JSON_NODES = 4_096;
const MAX_JSON_DEPTH = 32;
const VIEWPORT = Object.freeze({ width: 1_280, height: 720 });
const MAX_VIEWPORT_PIXELS = 1_000_000;

if (VIEWPORT.width * VIEWPORT.height > MAX_VIEWPORT_PIXELS) {
  throw new Error("Visual observation viewport exceeds its pixel limit.");
}

/**
 * Fresh-profile, read-only Playwright observer.  It never attaches to a CDP
 * endpoint and deliberately has no configuration surface for URLs, cookies,
 * selectors, scripts, downloads, popups, service workers, or permissions.
 */
export class VisualAgentObserver {
  readonly #inspection: VisualAgentObservationInspectionPort;

  constructor(
    inspection: Partial<VisualAgentObservationInspectionPort> = {},
  ) {
    this.#inspection = Object.freeze({
      inspectListener: inspection.inspectListener ?? (async (target) => {
        await inspectVisualListenerAsync(listenerIdentity(target));
      }),
      inspectConnectedPeer: inspection.inspectConnectedPeer
        ?? (async (target, localPort) => {
          await inspectVisualConnectedPeerAsync({
            ...listenerIdentity(target),
            brokerLocalPort: localPort,
          });
        }),
    });
  }

  async observe(input: Readonly<{
    target: VisualAgentObservationTarget;
    kind: VisualObservationKind;
    signal: AbortSignal;
  }>): Promise<VisualAgentObservation> {
    const target = validatedTarget(input.target);
    const kind = validatedKind(input.kind);
    if (input.signal.aborted) throw denied();
    if (kind === "observe_structured") {
      if (!target.structuredInspectionPath) throw denied();
      const body = await boundedLoopbackGet({
        target,
        path: target.structuredInspectionPath,
        maximumBytes: MAX_STRUCTURED_BYTES,
        expectedContentType: "application/json",
        signal: input.signal,
        inspection: this.#inspection,
      });
      let value: unknown;
      try { value = JSON.parse(body.toString("utf8")); } catch { throw denied(); }
      assertBoundedJson(value);
      return Object.freeze({
        schemaVersion: 1,
        kind,
        untrusted: true,
        contentType: "application/json",
        value,
      });
    }
    const html = await boundedLoopbackGet({
      target,
      path: "/",
      maximumBytes: MAX_HTML_BYTES,
      expectedContentType: "text/html",
      signal: input.signal,
      inspection: this.#inspection,
    });

    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    try {
      const launching = chromium.launch({
        headless: true,
        timeout: NAVIGATION_TIMEOUT_MS,
      });
      try {
        browser = await abortable(launching, input.signal);
      } catch {
        void launching.then((lateBrowser) => lateBrowser.close()).catch(() => undefined);
        throw denied();
      }
      context = await abortable(browser.newContext({
        acceptDownloads: false,
        javaScriptEnabled: false,
        serviceWorkers: "block",
        viewport: VIEWPORT,
      }), input.signal);
      await isolateContext(context);
      const page = await abortable(context.newPage(), input.signal);
      page.on("popup", (popup) => { void popup.close().catch(() => undefined); });
      return await abortable(
        this.#observePage(
          page,
          staticSnapshotHtml(html.toString("utf8")),
          kind,
          input.signal,
        ),
        input.signal,
      );
    } catch {
      throw denied();
    } finally {
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
    }
  }

  async #observePage(
    page: Page,
    html: string,
    kind: Exclude<VisualObservationKind, "observe_structured">,
    signal: AbortSignal,
  ): Promise<VisualAgentObservation> {
    await page.setContent(html, {
      timeout: NAVIGATION_TIMEOUT_MS,
      waitUntil: "domcontentloaded",
    });
    if (await abortable(page.locator("*").count(), signal) > MAX_DOM_NODES) {
      throw denied();
    }
    if (kind === "observe_accessibility") {
      const snapshot = await page.locator("body").ariaSnapshot({ timeout: NAVIGATION_TIMEOUT_MS });
      return Object.freeze({
        schemaVersion: 1,
        kind,
        untrusted: true,
        contentType: "text/plain",
        text: boundedText(snapshot, MAX_TEXT_BYTES),
      });
    }
    if (kind === "observe_dom_text") {
      const text = await page.locator("body").innerText({ timeout: NAVIGATION_TIMEOUT_MS });
      return Object.freeze({
        schemaVersion: 1,
        kind,
        untrusted: true,
        contentType: "text/plain",
        text: boundedText(text, MAX_TEXT_BYTES),
      });
    }
    const screenshot = await page.screenshot({ type: "png", fullPage: false, timeout: NAVIGATION_TIMEOUT_MS });
    if (screenshot.byteLength > MAX_SCREENSHOT_BYTES) throw denied();
    return Object.freeze({
      schemaVersion: 1,
      kind,
      untrusted: true,
      contentType: "image/png",
      pngBase64: screenshot.toString("base64"),
    });
  }
}

const isolateContext = async (context: BrowserContext): Promise<void> => {
  await context.route("**/*", async (route) => {
    await route.abort("blockedbyclient");
  });
  await context.routeWebSocket("**/*", (socket) => socket.close());
};

const validatedTarget = (target: VisualAgentObservationTarget): Readonly<{
  origin: string;
  runId: string;
  processAttemptId: string;
  pid: number;
  processStartToken: string;
  processGroupId: number;
  loopbackHost: "127.0.0.1";
  loopbackPort: number;
  structuredInspectionPath?: string;
}> => {
  if (!target || typeof target !== "object" || Array.isArray(target)
    || typeof target.runId !== "string"
    || target.runId.length < 3 || target.runId.length > 128
    || typeof target.processAttemptId !== "string"
    || target.processAttemptId.length < 3 || target.processAttemptId.length > 128
    || !Number.isSafeInteger(target.pid) || target.pid < 1
    || typeof target.processStartToken !== "string"
    || target.processStartToken.length < 1 || target.processStartToken.length > 300
    || !Number.isSafeInteger(target.processGroupId) || target.processGroupId < 1
    || target.loopbackHost !== "127.0.0.1"
    || !Number.isSafeInteger(target.loopbackPort)
    || target.loopbackPort < 1 || target.loopbackPort > 65_535) throw denied();
  const allowed = new Set([
    "runId",
    "processAttemptId",
    "pid",
    "processStartToken",
    "processGroupId",
    "loopbackHost",
    "loopbackPort",
    "structuredInspectionPath",
  ]);
  if (Object.keys(target).some((key) => !allowed.has(key))) throw denied();
  const structuredInspectionPath = target.structuredInspectionPath;
  if (structuredInspectionPath !== undefined
    && (typeof structuredInspectionPath !== "string"
      || !validSameOriginPath(structuredInspectionPath))) throw denied();
  return Object.freeze({
    runId: target.runId,
    processAttemptId: target.processAttemptId,
    pid: target.pid,
    processStartToken: target.processStartToken,
    processGroupId: target.processGroupId,
    loopbackHost: target.loopbackHost,
    loopbackPort: target.loopbackPort,
    origin: `http://127.0.0.1:${target.loopbackPort}`,
    ...(structuredInspectionPath === undefined ? {} : { structuredInspectionPath }),
  });
};

const validatedKind = (kind: VisualObservationKind): VisualObservationKind => {
  if (!new Set<VisualObservationKind>([
    "observe_structured",
    "observe_accessibility",
    "observe_dom_text",
    "observe_screenshot",
  ]).has(kind)) throw denied();
  return kind;
};

const validSameOriginPath = (path: string): boolean => path.startsWith("/")
  && path.length <= 1_024 && !/[\\?#\u0000]/u.test(path);

const staticSnapshotHtml = (html: string): string =>
  `<meta http-equiv="Content-Security-Policy" content="${STATIC_SNAPSHOT_CSP}">${html}`;

const boundedLoopbackGet = async (input: Readonly<{
  target: VisualAgentObservationTarget & Readonly<{ origin: string }>;
  path: string;
  maximumBytes: number;
  expectedContentType: "application/json" | "text/html";
  signal: AbortSignal;
  inspection: VisualAgentObservationInspectionPort;
}>): Promise<Buffer> => {
  const deadline = new AbortController();
  const onCallerAbort = (): void => deadline.abort();
  input.signal.addEventListener("abort", onCallerAbort, { once: true });
  const deadlineTimer = setTimeout(
    () => deadline.abort(),
    NAVIGATION_TIMEOUT_MS,
  );
  deadlineTimer.unref?.();
  try {
    if (input.signal.aborted) throw denied();
    const url = new URL(input.path, input.target.origin);
    if (url.origin !== input.target.origin
      || `${url.pathname}${url.search}` !== input.path) throw denied();
    await abortable(input.inspection.inspectListener(input.target), deadline.signal);
    const socket = await connectLoopback(input.target.loopbackPort, deadline.signal);
    try {
      if (socket.localAddress !== "127.0.0.1"
        || socket.remoteAddress !== "127.0.0.1"
        || socket.remotePort !== input.target.loopbackPort
        || !Number.isSafeInteger(socket.localPort)) throw denied();
      await abortable(
        input.inspection.inspectConnectedPeer(input.target, socket.localPort!),
        deadline.signal,
      );
      return await requestOnInspectedSocket({
        socket,
        path: input.path,
        maximumBytes: input.maximumBytes,
        expectedContentType: input.expectedContentType,
        signal: deadline.signal,
      });
    } finally {
      socket.destroy();
    }
  } catch {
    throw denied();
  } finally {
    clearTimeout(deadlineTimer);
    input.signal.removeEventListener("abort", onCallerAbort);
  }
};

const connectLoopback = async (
  port: number,
  signal: AbortSignal,
): Promise<Socket> => await new Promise<Socket>((resolve, reject) => {
  if (signal.aborted) {
    reject(denied());
    return;
  }
  const socket = connect({ host: "127.0.0.1", port });
  let settled = false;
  const finish = (error?: unknown): void => {
    if (settled) return;
    settled = true;
    signal.removeEventListener("abort", onAbort);
    socket.removeListener("connect", onConnect);
    socket.removeListener("error", onError);
    if (error) {
      socket.destroy();
      reject(denied());
    } else {
      resolve(socket);
    }
  };
  const onAbort = (): void => finish(denied());
  const onConnect = (): void => finish();
  const onError = (): void => finish(denied());
  signal.addEventListener("abort", onAbort, { once: true });
  socket.once("connect", onConnect);
  socket.once("error", onError);
});

const requestOnInspectedSocket = async (input: Readonly<{
  socket: Socket;
  path: string;
  maximumBytes: number;
  expectedContentType: "application/json" | "text/html";
  signal: AbortSignal;
}>): Promise<Buffer> => await new Promise<Buffer>((resolve, reject) => {
  if (input.signal.aborted) {
    reject(denied());
    return;
  }
  const agent = new Agent({ keepAlive: false });
  agent.createConnection = (_options, callback) => {
    callback?.(null, input.socket);
    return input.socket;
  };
  let settled = false;
  const finish = (error?: unknown, body?: Buffer): void => {
    if (settled) return;
    settled = true;
    input.signal.removeEventListener("abort", onAbort);
    agent.destroy();
    if (error) reject(denied());
    else resolve(body!);
  };
  const requestHandle = request({
    host: "127.0.0.1",
    port: input.socket.remotePort,
    path: input.path,
    method: "GET",
    headers: {
      accept: input.expectedContentType,
      connection: "close",
    },
    agent,
    maxHeaderSize: MAX_RESPONSE_HEADER_BYTES,
  }, (response) => {
    const contentType = String(response.headers["content-type"] ?? "").toLowerCase();
    const contentLength = String(response.headers["content-length"] ?? "");
    if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300
      || (contentType !== input.expectedContentType
        && !contentType.startsWith(`${input.expectedContentType};`))
      || (contentLength
        && (!/^\d+$/u.test(contentLength)
          || Number(contentLength) > input.maximumBytes))) {
      response.destroy();
      finish(denied());
      return;
    }
    const chunks: Buffer[] = [];
    let byteLength = 0;
    response.on("data", (chunk: Buffer) => {
      byteLength += chunk.byteLength;
      if (byteLength > input.maximumBytes) {
        response.destroy();
        finish(denied());
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    response.on("end", () => finish(undefined, Buffer.concat(chunks, byteLength)));
    response.on("error", () => finish(denied()));
  });
  const onAbort = (): void => {
    requestHandle.destroy();
    finish(denied());
  };
  input.signal.addEventListener("abort", onAbort, { once: true });
  requestHandle.on("timeout", () => {
    requestHandle.destroy();
    finish(denied());
  });
  requestHandle.on("error", () => finish(denied()));
  requestHandle.end();
});

const listenerIdentity = (
  target: VisualAgentObservationTarget,
): Readonly<{
  runId: string;
  processAttemptId: string;
  pid: number;
  processStartToken: string;
  processGroupId: number;
  assignedPort: number;
}> => Object.freeze({
  runId: target.runId,
  processAttemptId: target.processAttemptId,
  pid: target.pid,
  processStartToken: target.processStartToken,
  processGroupId: target.processGroupId,
  assignedPort: target.loopbackPort,
});

const boundedText = (value: string, maximumBytes: number): string => {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximumBytes) throw denied();
  return value;
};

const assertBoundedJson = (value: unknown): void => {
  let nodes = 0;
  const inspect = (current: unknown, depth: number): void => {
    if (++nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) throw denied();
    if (current === null || typeof current === "string" || typeof current === "boolean") return;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw denied();
      return;
    }
    if (Array.isArray(current)) {
      for (const child of current) inspect(child, depth + 1);
      return;
    }
    if (typeof current === "object") {
      for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
        if (Buffer.byteLength(key, "utf8") > 1_024) throw denied();
        inspect(child, depth + 1);
      }
      return;
    }
    throw denied();
  };
  inspect(value, 0);
};

const abortable = async <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) throw denied();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(denied());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
};

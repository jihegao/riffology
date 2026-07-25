import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { request as httpRequest } from "node:http";

const APP_SESSION_TTL_MS = 15 * 60_000;
const FRAME_NONCE_TTL_MS = 60_000;
const BROKER_SESSION_TTL_MS = 15 * 60_000;
const MAX_SUFFIX_BYTES = 4_096;
const MAX_RESPONSE_HEADER_BYTES = 32 * 1_024;
const MAX_RESPONSE_BODY_BYTES = 8 * 1_024 * 1_024;
const PROXY_TIMEOUT_MS = 5_000;
const MAX_PROXY_CONCURRENCY = 8;
const SECRET_BYTES = 32;

export const BROKER_DOCUMENT_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join("; ");

export type BrowserFrameTarget = Readonly<{
  projectId: string;
  runId: string;
  attemptGeneration: number;
  port: number;
  expiresAtMs: number;
  webSocket?: BrowserFrameWebSocketPolicy;
}>;

export type BrowserFrameWebSocketPolicy = Readonly<{
  path: string;
  subprotocols: readonly string[];
  maxFrameBytes: number;
  maxConnections: number;
  idleTimeoutMs: number;
}>;

export type BrowserFrameWebSocketOwner = Readonly<{
  close(code: 1008): void;
}>;

export type BrowserFrameWebSocketRequest = Readonly<{
  method: string;
  host: string | undefined;
  origin?: string | readonly string[];
  cookie?: string | readonly string[];
  authorization?: string | readonly string[];
  path: string;
  protocols?: string | readonly string[];
  upgrade?: string | readonly string[];
  connection?: string | readonly string[];
  version?: string | readonly string[];
  key?: string | readonly string[];
  extensions?: string | readonly string[];
}>;

export type BrowserFrameWebSocketAdmission = Readonly<{
  target: BrowserFrameTarget;
  childPath: string;
  offeredSubprotocols: readonly string[];
  maxFrameBytes: number;
  idleTimeoutMs: number;
  expiresAtMs: number;
  live(): boolean;
  recheck(): Promise<void>;
  recheckConnected(peer: BrowserFrameConnectedPeer): Promise<void>;
  markOpen(): void;
  release(): void;
}>;

export type BrowserFrameTargetResolver = {
  resolve(projectId: string, runId: string): Promise<BrowserFrameTarget | null>;
  inspect(target: BrowserFrameTarget): Promise<boolean>;
  inspectConnectedPeer?(
    target: BrowserFrameTarget,
    peer: BrowserFrameConnectedPeer,
  ): Promise<boolean>;
};

export class BrowserFrameInspectionTimeoutError extends Error {
  constructor() {
    super("The bounded browser frame inspection timed out.");
    this.name = "BrowserFrameInspectionTimeoutError";
  }
}

export type BrowserFrameConnectedPeer = Readonly<{
  localHost: "127.0.0.1";
  localPort: number;
  remoteHost: "127.0.0.1";
  remotePort: number;
}>;

export type FrameHttpTransportRequest = Readonly<{
  method: "GET" | "HEAD";
  host: "127.0.0.1";
  port: number;
  path: string;
  headers: Readonly<Record<string, string>>;
  maxHeaderBytes: number;
  maxBodyBytes: number;
  timeoutMs: number;
}>;

export type FrameHttpTransportResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  body: Uint8Array;
}>;

export type FrameHttpTransport = {
  request(input: FrameHttpTransportRequest): Promise<FrameHttpTransportResponse>;
};

export class FrameHttpTransportFailure extends Error {
  readonly kind: "limit" | "timeout";
  constructor(kind: "limit" | "timeout") {
    super("The fixed child transport failed.");
    this.name = "FrameHttpTransportFailure";
    this.kind = kind;
  }
}

export type BrowserRequestAdmission = Readonly<{
  method: string;
  host: string | undefined;
  origin?: string | readonly string[];
  fetchSite?: string | readonly string[];
  cookie?: string | readonly string[];
  csrf?: string | readonly string[];
  authorization?: string | readonly string[];
}>;

export type BrowserFrameCapabilityOptions = {
  appOrigin: string;
  brokerOrigin: string;
  secureCookies?: boolean;
  now?: () => number;
  random?: (size: number) => Uint8Array;
  targets: BrowserFrameTargetResolver;
  transport?: FrameHttpTransport;
};

export class BrowserFrameCapabilityError extends Error {
  readonly status: number;
  readonly code:
    | "browser_method_denied"
    | "browser_session_denied"
    | "visual_frame_unavailable"
    | "visual_frame_nonce_invalid"
    | "visual_frame_session_denied"
    | "visual_frame_proxy_denied"
    | "visual_frame_proxy_redirect_denied"
    | "visual_frame_proxy_limit_exceeded"
    | "visual_frame_proxy_timeout"
    | "visual_frame_proxy_failed"
    | "visual_websocket_not_declared"
    | "visual_websocket_protocol_denied"
    | "visual_websocket_limit"
    | "visual_websocket_timeout";

  constructor(
    status: number,
    code: BrowserFrameCapabilityError["code"],
  ) {
    super("The browser frame request was denied.");
    this.name = "BrowserFrameCapabilityError";
    this.status = status;
    this.code = code;
  }
}

export class BrowserFrameCapability {
  readonly #appOrigin: URL;
  readonly #brokerOrigin: URL;
  readonly #secureCookies: boolean;
  readonly #now: () => number;
  readonly #random: (size: number) => Uint8Array;
  readonly #targets: BrowserFrameTargetResolver;
  readonly #transport: FrameHttpTransport;
  #generation = 0;
  #appSession?: AppSession;
  readonly #nonces = new Map<string, FrameCapability>();
  readonly #routes = new Map<string, FrameCapability>();
  readonly #attemptSockets = new Map<string, Set<FrameWebSocketRegistration>>();

  constructor(options: BrowserFrameCapabilityOptions) {
    this.#appOrigin = exactLoopbackOrigin(options.appOrigin);
    this.#brokerOrigin = exactLoopbackOrigin(options.brokerOrigin);
    if (this.#appOrigin.origin === this.#brokerOrigin.origin) {
      throw new Error("Browser app and broker origins must be distinct.");
    }
    this.#secureCookies = options.secureCookies ?? false;
    if (this.#secureCookies !== (this.#appOrigin.protocol === "https:" && this.#brokerOrigin.protocol === "https:")) {
      throw new Error("Secure cookie mode must match the configured browser origins.");
    }
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? randomBytes;
    this.#targets = options.targets;
    this.#transport = options.transport ?? new FixedChildHttpTransport();
  }

  bootstrap(request: BrowserRequestAdmission): {
    csrfToken: string;
    expiresAtMs: number;
    generation: number;
    setCookie: string;
  } {
    this.#requireAppAdmission(request, "browser_session_denied");
    const now = exactNow(this.#now());
    const cookieValue = this.#secret();
    const csrfToken = this.#secret();
    this.clear();
    const session: AppSession = {
      cookieDigest: digest(cookieValue),
      csrfDigest: digest(csrfToken),
      expiresAtMs: now + APP_SESSION_TTL_MS,
      generation: this.#generation,
    };
    this.#appSession = session;
    return {
      csrfToken,
      expiresAtMs: session.expiresAtMs,
      generation: session.generation,
      setCookie: serializeCookie("riff_app", cookieValue, "/api/", session.expiresAtMs, now, this.#secureCookies),
    };
  }

  async issueFrameSession(
    request: BrowserRequestAdmission,
    identity: { projectId: string; runId: string },
  ): Promise<{ frameUrl: string; expiresAtMs: number }> {
    const session = this.#requireAppSession(request);
    const target = await this.#targets.resolve(exactId(identity.projectId), exactId(identity.runId));
    const now = exactNow(this.#now());
    if (!target || target.projectId !== identity.projectId || target.runId !== identity.runId
      || !validTarget(target, now) || !await this.#inspectHttp(target)) {
      throw denied(409, "visual_frame_unavailable");
    }
    if (!this.#appSession || this.#appSession.generation !== session.generation || this.#appSession.expiresAtMs <= now) {
      throw denied(403, "browser_session_denied");
    }
    const nonce = this.#secret();
    const routeId = this.#secret();
    if (this.#nonces.has(digest(nonce).toString("hex")) || this.#routes.has(routeId)) {
      throw denied(500, "visual_frame_proxy_failed");
    }
    const expiresAtMs = Math.min(now + FRAME_NONCE_TTL_MS, target.expiresAtMs, session.expiresAtMs);
    if (expiresAtMs <= now) throw denied(409, "visual_frame_unavailable");
    const capability: FrameCapability = {
      appGeneration: session.generation,
      target: freezeTarget(target),
      nonceDigest: digest(nonce),
      routeId,
      nonceExpiresAtMs: expiresAtMs,
      brokerSessionExpiresAtMs: 0,
      inFlight: 0,
      epoch: 0,
      sockets: new Set(),
    };
    this.#nonces.set(capability.nonceDigest.toString("hex"), capability);
    this.#routes.set(routeId, capability);
    return {
      frameUrl: `${this.#brokerOrigin.origin}/frame/redeem/${nonce}`,
      expiresAtMs,
    };
  }

  async redeem(
    request: BrowserRequestAdmission & { path: string },
  ): Promise<{ location: string; setCookie: string; expiresAtMs: number }> {
    this.#requireBrokerHost(request, "GET", "visual_frame_nonce_invalid");
    if (request.origin !== undefined) throw denied(404, "visual_frame_nonce_invalid");
    const nonce = redeemNonce(request.path);
    const nonceKey = digest(nonce).toString("hex");
    const capability = this.#nonces.get(nonceKey);
    if (!capability || !safeDigestEqual(capability.nonceDigest, digest(nonce))) {
      throw denied(404, "visual_frame_nonce_invalid");
    }
    this.#nonces.delete(nonceKey);
    const now = exactNow(this.#now());
    if (capability.nonceExpiresAtMs <= now
      || !this.#live(capability, now)
      || !await this.#inspectHttp(capability.target)) {
      this.#routes.delete(capability.routeId);
      throw denied(404, "visual_frame_nonce_invalid");
    }
    const inspectedAt = exactNow(this.#now());
    if (this.#routes.get(capability.routeId) !== capability
      || capability.nonceExpiresAtMs <= inspectedAt
      || !this.#live(capability, inspectedAt)) {
      this.#routes.delete(capability.routeId);
      throw denied(404, "visual_frame_nonce_invalid");
    }
    const cookieName = `riff_frame_${this.#secret().slice(0, 22)}`;
    const cookieValue = this.#secret();
    const expiresAtMs = Math.min(
      inspectedAt + BROKER_SESSION_TTL_MS,
      capability.target.expiresAtMs,
    );
    capability.cookieName = cookieName;
    capability.cookieDigest = digest(cookieValue);
    capability.brokerSessionExpiresAtMs = expiresAtMs;
    const path = `/frame/c/${capability.routeId}/`;
    return {
      location: path,
      setCookie: serializeCookie(cookieName, cookieValue, path, expiresAtMs, inspectedAt, this.#secureCookies),
      expiresAtMs,
    };
  }

  async proxy(request: {
    method: string;
    host: string | undefined;
    origin?: string | readonly string[];
    cookie?: string | readonly string[];
    path: string;
    headers?: Readonly<Record<string, string | readonly string[] | undefined>>;
    body?: Uint8Array;
  }): Promise<FrameHttpTransportResponse> {
    this.#requireBrokerHost(request, request.method, "visual_frame_session_denied");
    if (request.method !== "GET" && request.method !== "HEAD") throw denied(405, "visual_frame_proxy_denied");
    if (request.body && request.body.byteLength !== 0) throw denied(502, "visual_frame_proxy_limit_exceeded");
    const parsed = capabilityPath(request.path);
    const capability = this.#routes.get(parsed.routeId);
    const now = exactNow(this.#now());
    if (!capability || !capability.cookieName || !capability.cookieDigest
      || capability.brokerSessionExpiresAtMs <= now || !this.#live(capability, now)) {
      throw denied(403, "visual_frame_session_denied");
    }
    if (request.origin !== undefined && exactSingle(request.origin) !== this.#brokerOrigin.origin) {
      throw denied(403, "visual_frame_session_denied");
    }
    const cookieValue = exactCookie(request.cookie, capability.cookieName);
    if (!cookieValue || !safeDigestEqual(capability.cookieDigest, digest(cookieValue))) {
      throw denied(403, "visual_frame_session_denied");
    }
    if (capability.inFlight >= MAX_PROXY_CONCURRENCY) {
      throw denied(502, "visual_frame_proxy_limit_exceeded");
    }
    capability.inFlight += 1;
    try {
      if (!await this.#inspectHttp(capability.target)) {
        this.#routes.delete(capability.routeId);
        throw denied(409, "visual_frame_unavailable");
      }
      const inspectedAt = exactNow(this.#now());
      if (this.#routes.get(capability.routeId) !== capability
        || capability.brokerSessionExpiresAtMs <= inspectedAt
        || !this.#live(capability, inspectedAt)) {
        throw denied(403, "visual_frame_session_denied");
      }
      const response = await this.#transport.request({
        method: request.method,
        host: "127.0.0.1",
        port: capability.target.port,
        path: parsed.suffix,
        headers: requestHeaderAllowlist(request.headers ?? {}),
        maxHeaderBytes: MAX_RESPONSE_HEADER_BYTES,
        maxBodyBytes: MAX_RESPONSE_BODY_BYTES,
        timeoutMs: PROXY_TIMEOUT_MS,
      });
      if (!(response.body instanceof Uint8Array)
        || responseHeaderBytes(response.headers) > MAX_RESPONSE_HEADER_BYTES) {
        throw denied(502, "visual_frame_proxy_limit_exceeded");
      }
      if (response.status >= 300 && response.status < 400) {
        throw denied(502, "visual_frame_proxy_redirect_denied");
      }
      if (!Number.isSafeInteger(response.status) || response.status < 200 || response.status > 599) {
        throw denied(502, "visual_frame_proxy_failed");
      }
      if (response.body.byteLength > MAX_RESPONSE_BODY_BYTES) {
        throw denied(502, "visual_frame_proxy_limit_exceeded");
      }
      if (!await this.#inspectHttp(capability.target)) {
        this.#routes.delete(capability.routeId);
        throw denied(409, "visual_frame_unavailable");
      }
      const completedAt = exactNow(this.#now());
      if (this.#routes.get(capability.routeId) !== capability
        || capability.brokerSessionExpiresAtMs <= completedAt
        || !this.#live(capability, completedAt)) {
        throw denied(403, "visual_frame_session_denied");
      }
      const contentType = exactResponseContentType(response.headers);
      const body = request.method === "HEAD" ? new Uint8Array() : new Uint8Array(response.body);
      const rangeHeaders = response.status === 206 ? exactRangeHeaders(response.headers) : {};
      const validators = exactValidatorHeaders(response.headers);
      const contentLength = request.method === "HEAD"
        ? exactHeadContentLength(response.headers)
        : String(body.byteLength);
      return Object.freeze({
        status: response.status,
        headers: Object.freeze({
          "cache-control": "private, no-store",
          ...(contentLength === undefined ? {} : { "content-length": contentLength }),
          "content-security-policy": `${BROKER_DOCUMENT_CSP}; frame-ancestors ${this.#appOrigin.origin}`,
          ...(contentType === undefined ? {} : { "content-type": contentType }),
          "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
          ...rangeHeaders,
          ...validators,
        }),
        body,
      });
    } catch (error) {
      if (error instanceof BrowserFrameCapabilityError) throw error;
      if (error instanceof FrameHttpTransportFailure) {
        if (error.kind === "timeout") throw denied(504, "visual_frame_proxy_timeout");
        if (error.kind === "limit") throw denied(502, "visual_frame_proxy_limit_exceeded");
      }
      throw denied(502, "visual_frame_proxy_failed");
    } finally {
      capability.inFlight -= 1;
    }
  }

  async admitWebSocket(
    request: BrowserFrameWebSocketRequest,
    owner: BrowserFrameWebSocketOwner,
  ): Promise<BrowserFrameWebSocketAdmission> {
    if (!owner || typeof owner.close !== "function") {
      throw new Error("A browser WebSocket owner is required.");
    }
    if (request.method !== "GET") throw denied(405, "visual_websocket_protocol_denied");
    if (request.host !== this.#brokerOrigin.host) throw denied(403, "visual_frame_session_denied");
    if (exactSingle(request.origin) !== this.#brokerOrigin.origin
      || request.authorization !== undefined) {
      throw denied(403, "visual_frame_session_denied");
    }
    requireWebSocketUpgrade(request);
    const parsed = webSocketCapabilityPath(request.path);
    const capability = this.#routes.get(parsed.routeId);
    const now = exactNow(this.#now());
    if (!capability || !capability.cookieName || !capability.cookieDigest
      || capability.brokerSessionExpiresAtMs <= now || !this.#live(capability, now)) {
      throw denied(403, "visual_frame_session_denied");
    }
    const policy = capability.target.webSocket;
    if (!policy || parsed.suffix !== policy.path) {
      throw denied(404, "visual_websocket_not_declared");
    }
    const cookieValue = exactCookie(request.cookie, capability.cookieName);
    if (!cookieValue || !safeDigestEqual(capability.cookieDigest, digest(cookieValue))) {
      throw denied(403, "visual_frame_session_denied");
    }
    const offeredSubprotocols = exactWebSocketProtocols(request.protocols, policy);
    const attemptKey = webSocketAttemptKey(capability.target);
    const attemptSockets = this.#attemptSockets.get(attemptKey) ?? new Set<FrameWebSocketRegistration>();
    if (attemptSockets.size >= policy.maxConnections
      || [...attemptSockets].some((entry) => entry.owner === owner)) {
      throw denied(429, "visual_websocket_limit");
    }
    if (!this.#attemptSockets.has(attemptKey)) this.#attemptSockets.set(attemptKey, attemptSockets);
    const registration: FrameWebSocketRegistration = {
      capability,
      owner,
      state: "pending",
      epoch: capability.epoch,
      released: false,
    };
    attemptSockets.add(registration);
    capability.sockets.add(registration);

    const release = (): void => this.#releaseWebSocket(attemptKey, registration);
    const live = (): boolean => {
      const checkedAt = exactNow(this.#now());
      return !(registration.released
        || registration.epoch !== capability.epoch
        || this.#routes.get(capability.routeId) !== capability
        || capability.brokerSessionExpiresAtMs <= checkedAt
        || !this.#live(capability, checkedAt));
    };
    const requireCurrent = (): void => {
      if (!live()) {
        release();
        throw denied(403, "visual_frame_session_denied");
      }
    };
    const recheck = async (): Promise<void> => {
      try {
        requireCurrent();
        if (!await this.#targets.inspect(capability.target)) {
          release();
          throw denied(409, "visual_frame_unavailable");
        }
        requireCurrent();
      } catch (error) {
        release();
        if (error instanceof BrowserFrameCapabilityError) throw error;
        if (error instanceof BrowserFrameInspectionTimeoutError) {
          throw denied(504, "visual_websocket_timeout");
        }
        throw denied(409, "visual_frame_unavailable");
      }
    };
    const recheckConnected = async (peer: BrowserFrameConnectedPeer): Promise<void> => {
      try {
        requireCurrent();
        if (!validConnectedPeer(peer, capability.target)
          || !this.#targets.inspectConnectedPeer
          || !await this.#targets.inspectConnectedPeer(capability.target, peer)
          || !await this.#targets.inspect(capability.target)) {
          throw denied(409, "visual_frame_unavailable");
        }
        requireCurrent();
      } catch (error) {
        release();
        if (error instanceof BrowserFrameCapabilityError) throw error;
        if (error instanceof BrowserFrameInspectionTimeoutError) {
          throw denied(504, "visual_websocket_timeout");
        }
        throw denied(409, "visual_frame_unavailable");
      }
    };

    try {
      await recheck();
    } catch (error) {
      release();
      throw error;
    }
    return Object.freeze({
      target: capability.target,
      childPath: policy.path,
      offeredSubprotocols,
      maxFrameBytes: policy.maxFrameBytes,
      idleTimeoutMs: policy.idleTimeoutMs,
      expiresAtMs: capability.brokerSessionExpiresAtMs,
      live,
      recheck,
      recheckConnected,
      markOpen: (): void => {
        requireCurrent();
        registration.state = "open";
      },
      release,
    });
  }

  revoke(projectId: string, runId?: string, attemptGeneration?: number): void {
    for (const [routeId, capability] of this.#routes) {
      if (capability.target.projectId === projectId
        && (runId === undefined || capability.target.runId === runId)
        && (attemptGeneration === undefined
          || capability.target.attemptGeneration === attemptGeneration)) {
        this.#revokeCapability(routeId, capability);
      }
    }
  }

  revokeRun(runId: string): void {
    const exactRunId = exactId(runId);
    for (const [routeId, capability] of this.#routes) {
      if (capability.target.runId === exactRunId) {
        this.#revokeCapability(routeId, capability);
      }
    }
  }

  clear(): void {
    for (const [routeId, capability] of [...this.#routes]) {
      this.#revokeCapability(routeId, capability);
    }
    this.#generation += 1;
    this.#appSession = undefined;
    this.#nonces.clear();
    this.#routes.clear();
    this.#attemptSockets.clear();
  }

  #requireAppAdmission(
    request: BrowserRequestAdmission,
    code: "browser_session_denied",
  ): void {
    if (request.method !== "POST") throw denied(405, "browser_method_denied");
    if (request.host !== this.#appOrigin.host
      || exactSingle(request.origin) !== this.#appOrigin.origin
      || exactSingle(request.fetchSite) !== "same-origin"
      || request.authorization !== undefined) {
      throw denied(403, code);
    }
  }

  #requireAppSession(request: BrowserRequestAdmission): AppSession {
    this.#requireAppAdmission(request, "browser_session_denied");
    const session = this.#appSession;
    const now = exactNow(this.#now());
    const cookie = exactCookie(request.cookie, "riff_app");
    const csrf = exactSingle(request.csrf);
    if (!session || session.expiresAtMs <= now || !cookie || !csrf
      || !safeDigestEqual(session.cookieDigest, digest(cookie))
      || !safeDigestEqual(session.csrfDigest, digest(csrf))) {
      throw denied(403, "browser_session_denied");
    }
    return session;
  }

  #requireBrokerHost(
    request: { method: string; host: string | undefined },
    method: string,
    code: "visual_frame_nonce_invalid" | "visual_frame_session_denied",
  ): void {
    if (request.method !== method) throw denied(405, "browser_method_denied");
    if (request.host !== this.#brokerOrigin.host) throw denied(403, code);
  }

  #live(capability: FrameCapability, now: number): boolean {
    return Boolean(this.#appSession
      && capability.appGeneration === this.#appSession.generation
      && capability.target.expiresAtMs > now);
  }

  async #inspectHttp(target: BrowserFrameTarget): Promise<boolean> {
    try {
      return await this.#targets.inspect(target);
    } catch (error) {
      if (error instanceof BrowserFrameInspectionTimeoutError) return false;
      throw error;
    }
  }

  #revokeCapability(routeId: string, capability: FrameCapability): void {
    capability.epoch += 1;
    for (const registration of [...capability.sockets]) {
      try {
        registration.owner.close(1008);
      } catch {
        // Revocation remains best-effort across owners, then removes all authority.
      }
      this.#releaseWebSocket(webSocketAttemptKey(capability.target), registration);
    }
    this.#routes.delete(routeId);
    this.#nonces.delete(capability.nonceDigest.toString("hex"));
  }

  #releaseWebSocket(attemptKey: string, registration: FrameWebSocketRegistration): void {
    if (registration.released) return;
    registration.released = true;
    registration.capability.sockets.delete(registration);
    const attemptSockets = this.#attemptSockets.get(attemptKey);
    attemptSockets?.delete(registration);
    if (attemptSockets?.size === 0) this.#attemptSockets.delete(attemptKey);
  }

  #secret(): string {
    const bytes = this.#random(SECRET_BYTES);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== SECRET_BYTES) {
      throw new Error("The browser capability CSPRNG returned an invalid result.");
    }
    return Buffer.from(bytes).toString("base64url");
  }
}

type AppSession = {
  cookieDigest: Buffer;
  csrfDigest: Buffer;
  expiresAtMs: number;
  generation: number;
};

type FrameCapability = {
  appGeneration: number;
  target: BrowserFrameTarget;
  nonceDigest: Buffer;
  routeId: string;
  nonceExpiresAtMs: number;
  cookieName?: string;
  cookieDigest?: Buffer;
  brokerSessionExpiresAtMs: number;
  inFlight: number;
  epoch: number;
  sockets: Set<FrameWebSocketRegistration>;
};

type FrameWebSocketRegistration = {
  capability: FrameCapability;
  owner: BrowserFrameWebSocketOwner;
  state: "pending" | "open";
  epoch: number;
  released: boolean;
};

export class FixedChildHttpTransport implements FrameHttpTransport {
  async request(input: FrameHttpTransportRequest): Promise<FrameHttpTransportResponse> {
    if (input.host !== "127.0.0.1" || !validPort(input.port)) throw new Error("Invalid fixed child target.");
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (error?: Error, response?: FrameHttpTransportResponse): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (error) reject(error);
        else resolve(response!);
      };
      const outgoing = httpRequest({
        host: "127.0.0.1",
        port: input.port,
        method: input.method,
        path: input.path,
        headers: {
          ...input.headers,
          "accept-encoding": "identity",
          host: `127.0.0.1:${input.port}`,
        },
        maxHeaderSize: input.maxHeaderBytes,
      }, (response) => {
        if (headerBytes(response.rawHeaders) > input.maxHeaderBytes) {
          finish(new FrameHttpTransportFailure("limit"));
          response.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        response.on("data", (chunk) => {
          received += Buffer.byteLength(chunk);
          if (received > input.maxBodyBytes) {
            finish(new FrameHttpTransportFailure("limit"));
            response.destroy();
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.once("end", () => finish(undefined, {
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }));
        response.once("error", (error) => finish(error));
        response.once("aborted", () => finish(new Error("The child response was aborted.")));
        response.once("close", () => {
          if (!response.complete) finish(new Error("The child response closed before completion."));
        });
      });
      timer = setTimeout(() => {
        outgoing.destroy(new FrameHttpTransportFailure("timeout"));
      }, input.timeoutMs);
      timer.unref?.();
      outgoing.once("error", (error) => finish(
        (error as NodeJS.ErrnoException).code === "HPE_HEADER_OVERFLOW"
          ? new FrameHttpTransportFailure("limit")
          : error,
      ));
      outgoing.end();
    });
  }
}

const denied = (
  status: number,
  code: BrowserFrameCapabilityError["code"],
): BrowserFrameCapabilityError => new BrowserFrameCapabilityError(status, code);

const exactLoopbackOrigin = (value: string): URL => {
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:")
    || url.hostname !== "[::1]" || url.pathname !== "/" || url.search || url.hash
    || !url.port || url.username || url.password) {
    throw new Error("Browser origins must be exact bracketed IPv6 loopback origins with explicit ports.");
  }
  return url;
};

const exactNow = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("The browser capability clock is invalid.");
  return value;
};

const validPort = (value: number): boolean => Number.isSafeInteger(value) && value >= 1 && value <= 65_535;

const validConnectedPeer = (
  peer: BrowserFrameConnectedPeer,
  target: BrowserFrameTarget,
): boolean => Boolean(peer
  && peer.localHost === "127.0.0.1"
  && validPort(peer.localPort)
  && peer.remoteHost === "127.0.0.1"
  && peer.remotePort === target.port);

const validTarget = (target: BrowserFrameTarget, now: number): boolean =>
  exactId(target.projectId) === target.projectId
  && exactId(target.runId) === target.runId
  && Number.isSafeInteger(target.attemptGeneration) && target.attemptGeneration >= 1
  && validPort(target.port)
  && Number.isSafeInteger(target.expiresAtMs) && target.expiresAtMs > now
  && (target.webSocket === undefined || validWebSocketPolicy(target.webSocket));

const freezeTarget = (target: BrowserFrameTarget): BrowserFrameTarget => Object.freeze({
  projectId: target.projectId,
  runId: target.runId,
  attemptGeneration: target.attemptGeneration,
  port: target.port,
  expiresAtMs: target.expiresAtMs,
  ...(target.webSocket ? {
    webSocket: Object.freeze({
      path: target.webSocket.path,
      subprotocols: Object.freeze([...target.webSocket.subprotocols]),
      maxFrameBytes: target.webSocket.maxFrameBytes,
      maxConnections: target.webSocket.maxConnections,
      idleTimeoutMs: target.webSocket.idleTimeoutMs,
    }),
  } : {}),
});

const validWebSocketPolicy = (policy: BrowserFrameWebSocketPolicy): boolean =>
  typeof policy === "object" && policy !== null
  && exactSameOriginPath(policy.path)
  && Array.isArray(policy.subprotocols)
  && policy.subprotocols.length <= 8
  && policy.subprotocols.every((value) => typeof value === "string" && WEB_SOCKET_TOKEN.test(value))
  && new Set(policy.subprotocols).size === policy.subprotocols.length
  && Number.isSafeInteger(policy.maxFrameBytes)
  && policy.maxFrameBytes >= 1 && policy.maxFrameBytes <= 1_048_576
  && Number.isSafeInteger(policy.maxConnections)
  && policy.maxConnections >= 1 && policy.maxConnections <= 8
  && Number.isSafeInteger(policy.idleTimeoutMs)
  && policy.idleTimeoutMs >= 1_000 && policy.idleTimeoutMs <= 300_000;

const exactSameOriginPath = (path: string): boolean =>
  typeof path === "string" && path.startsWith("/") && !path.startsWith("//")
  && !path.includes("?") && !path.includes("#") && !path.includes("\\")
  && !/[\u0000-\u001f\u007f]/u.test(path)
  && !path.includes("//")
  && !path.split("/").some((segment) => segment === "." || segment === "..")
  && Buffer.byteLength(path) <= MAX_SUFFIX_BYTES;

const WEB_SOCKET_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/u;

const requireWebSocketUpgrade = (request: BrowserFrameWebSocketRequest): void => {
  const upgrade = exactSingle(request.upgrade);
  const connection = typeof request.connection === "string"
    && request.connection.length <= 256
    && !/[\r\n\u0000]/u.test(request.connection)
    ? request.connection
    : undefined;
  const version = exactSingle(request.version);
  const key = exactSingle(request.key);
  const connectionTokens = connection?.split(",").map((value) => value.trim().toLowerCase()) ?? [];
  let decodedKey: Buffer | undefined;
  try {
    decodedKey = key && /^[A-Za-z0-9+/]{22}==$/u.test(key)
      ? Buffer.from(key, "base64")
      : undefined;
  } catch {
    decodedKey = undefined;
  }
  if (upgrade?.toLowerCase() !== "websocket"
    || connectionTokens.length < 1
    || connectionTokens.some((value) => !value)
    || !connectionTokens.includes("upgrade")
    || new Set(connectionTokens).size !== connectionTokens.length
    || version !== "13"
    || decodedKey?.byteLength !== 16) {
    throw denied(400, "visual_websocket_protocol_denied");
  }
  if (request.extensions !== undefined) {
    const extensions = typeof request.extensions === "string"
      ? request.extensions
      : undefined;
    if (!extensions || extensions.length > 1_024
      || !/^[\u0020-\u007e]+$/u.test(extensions)) {
      throw denied(400, "visual_websocket_protocol_denied");
    }
  }
};

const exactWebSocketProtocols = (
  value: string | readonly string[] | undefined,
  policy: BrowserFrameWebSocketPolicy,
): readonly string[] => {
  if (value === undefined) {
    if (policy.subprotocols.length !== 0) {
      throw denied(403, "visual_websocket_protocol_denied");
    }
    return Object.freeze([]);
  }
  if (policy.subprotocols.length === 0) {
    throw denied(403, "visual_websocket_protocol_denied");
  }
  if (typeof value !== "string" || value.length > 1_024 || /[\r\n\u0000]/u.test(value)) {
    throw denied(403, "visual_websocket_protocol_denied");
  }
  const protocols = value.split(",").map((protocol) => protocol.trim());
  if (protocols.length < 1 || protocols.length > 8
    || protocols.some((protocol) => !WEB_SOCKET_TOKEN.test(protocol))
    || new Set(protocols).size !== protocols.length
    || protocols.some((protocol) => !policy.subprotocols.includes(protocol))) {
    throw denied(403, "visual_websocket_protocol_denied");
  }
  return Object.freeze(protocols);
};

const webSocketCapabilityPath = (path: string): { routeId: string; suffix: string } => {
  if (typeof path !== "string" || Buffer.byteLength(path) > MAX_SUFFIX_BYTES + 128
    || path.includes("?") || path.includes("#") || path.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(path)) {
    throw denied(404, "visual_websocket_not_declared");
  }
  const match = /^\/frame\/c\/([A-Za-z0-9_-]{40,80})(\/.*)$/u.exec(path);
  if (!match || !exactSameOriginPath(match[2])) {
    throw denied(404, "visual_websocket_not_declared");
  }
  return { routeId: match[1], suffix: match[2] };
};

const webSocketAttemptKey = (target: BrowserFrameTarget): string =>
  `${target.projectId}\0${target.runId}\0${target.attemptGeneration}`;

const exactId = (value: string): string => {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw denied(403, "browser_session_denied");
  }
  return value;
};

const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

const safeDigestEqual = (left: Buffer, right: Buffer): boolean =>
  left.byteLength === right.byteLength && timingSafeEqual(left, right);

const exactSingle = (value: string | readonly string[] | undefined): string | undefined => {
  if (typeof value !== "string" || value.includes(",") || /[\r\n\u0000]/u.test(value)) return undefined;
  return value;
};

const exactCookie = (
  header: string | readonly string[] | undefined,
  name: string,
): string | undefined => {
  if (typeof header !== "string" || header.length > 8_192 || /[\r\n\u0000]/u.test(header)) return undefined;
  const values: string[] = [];
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    if (part.slice(0, index).trim() === name) values.push(part.slice(index + 1).trim());
  }
  return values.length === 1 && /^[A-Za-z0-9_-]{20,128}$/u.test(values[0]) ? values[0] : undefined;
};

const serializeCookie = (
  name: string,
  value: string,
  path: string,
  expiresAtMs: number,
  now: number,
  secure: boolean,
): string => {
  const maxAge = Math.max(0, Math.floor((expiresAtMs - now) / 1_000));
  return `${name}=${value}; Path=${path}; Max-Age=${maxAge}; Expires=${new Date(expiresAtMs).toUTCString()}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
};

const redeemNonce = (path: string): string => {
  if (typeof path !== "string" || path.length > 256 || path.includes("?") || path.includes("#")) {
    throw denied(404, "visual_frame_nonce_invalid");
  }
  const match = /^\/frame\/redeem\/([A-Za-z0-9_-]{40,80})$/u.exec(path);
  if (!match) throw denied(404, "visual_frame_nonce_invalid");
  return match[1];
};

const capabilityPath = (path: string): { routeId: string; suffix: string } => {
  if (typeof path !== "string" || Buffer.byteLength(path) > MAX_SUFFIX_BYTES + 128
    || !path.startsWith("/") || path.startsWith("//") || path.includes("#")
    || path.includes("\\") || /[\u0000-\u001f\u007f]/u.test(path)) {
    throw denied(404, "visual_frame_proxy_denied");
  }
  const match = /^\/frame\/c\/([A-Za-z0-9_-]{40,80})(\/[^?]*)?(\?[^#]*)?$/u.exec(path);
  if (!match) throw denied(404, "visual_frame_proxy_denied");
  if (/%(?:2f|5c)/iu.test(path)) throw denied(404, "visual_frame_proxy_denied");
  const rawPath = match[2] || "/";
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    throw denied(404, "visual_frame_proxy_denied");
  }
  if (Buffer.byteLength(`${rawPath}${match[3] ?? ""}`) > MAX_SUFFIX_BYTES
    || decoded.includes("\\") || decoded.includes("//")
    || /%(?:2e|2f|5c)/iu.test(decoded)
    || /[\u0000-\u001f\u007f]/u.test(decoded)
    || decoded.split("/").some((segment) => segment === "." || segment === "..")) {
    throw denied(404, "visual_frame_proxy_denied");
  }
  return { routeId: match[1], suffix: `${rawPath}${match[3] ?? ""}` };
};

const requestHeaderAllowlist = (
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
): Readonly<Record<string, string>> => {
  if (responseHeaderBytes(headers) > MAX_RESPONSE_HEADER_BYTES) {
    throw denied(502, "visual_frame_proxy_limit_exceeded");
  }
  const allowed = new Set(["accept", "accept-language", "if-modified-since", "if-none-match", "range"]);
  const result: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (!allowed.has(name)) continue;
    if (rawValue === undefined) continue;
    if (typeof rawValue !== "string" || /[\r\n\u0000]/u.test(rawValue)) {
      throw denied(404, "visual_frame_proxy_denied");
    }
    result[name] = rawValue;
  }
  return Object.freeze(result);
};

const exactResponseContentType = (
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
): string | undefined => {
  const entries = Object.entries(headers).filter(([name]) => name.toLowerCase() === "content-type");
  if (entries.length === 0) return undefined;
  if (entries.length !== 1 || typeof entries[0][1] !== "string") {
    throw denied(502, "visual_frame_proxy_failed");
  }
  const value = entries[0][1].trim();
  if (!value || /[\r\n\u0000]/u.test(value)) {
    throw denied(502, "visual_frame_proxy_failed");
  }
  return value;
};

const exactHeadContentLength = (
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
): string | undefined => {
  const value = exactOptionalResponseHeader(headers, "content-length");
  if (value === undefined) return undefined;
  if (!/^(?:0|[1-9]\d{0,15})$/u.test(value) || Number(value) > MAX_RESPONSE_BODY_BYTES) {
    throw denied(502, "visual_frame_proxy_limit_exceeded");
  }
  return value;
};

const exactRangeHeaders = (
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
): Readonly<Record<string, string>> => {
  const contentRange = Object.entries(headers)
    .find(([name]) => name.toLowerCase() === "content-range")?.[1];
  if (contentRange !== undefined && (typeof contentRange !== "string" || /[\r\n\u0000]/u.test(contentRange))) {
    throw denied(502, "visual_frame_proxy_failed");
  }
  const acceptRanges = Object.entries(headers)
    .find(([name]) => name.toLowerCase() === "accept-ranges")?.[1];
  if (acceptRanges !== undefined && (typeof acceptRanges !== "string" || /[\r\n\u0000]/u.test(acceptRanges))) {
    throw denied(502, "visual_frame_proxy_failed");
  }
  return Object.freeze({
    ...(contentRange === undefined ? {} : { "content-range": contentRange }),
    ...(acceptRanges === undefined ? {} : { "accept-ranges": acceptRanges }),
  });
};

const exactValidatorHeaders = (
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
): Readonly<Record<string, string>> => {
  const result: Record<string, string> = {};
  const etag = exactOptionalResponseHeader(headers, "etag");
  if (etag !== undefined) result.etag = etag;
  const lastModified = exactOptionalResponseHeader(headers, "last-modified");
  if (lastModified !== undefined) result["last-modified"] = lastModified;
  const acceptRanges = exactOptionalResponseHeader(headers, "accept-ranges");
  if (acceptRanges !== undefined) result["accept-ranges"] = acceptRanges;
  return Object.freeze(result);
};

const exactOptionalResponseHeader = (
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  expectedName: string,
): string | undefined => {
  const values = Object.entries(headers)
    .filter(([name]) => name.toLowerCase() === expectedName)
    .map(([, value]) => value);
  if (values.length === 0) return undefined;
  if (values.length !== 1 || typeof values[0] !== "string"
    || /[\r\n\u0000]/u.test(values[0])) {
    throw denied(502, "visual_frame_proxy_failed");
  }
  return values[0];
};

const headerBytes = (headers: readonly string[]): number =>
  headers.reduce((total, value) => total + Buffer.byteLength(value) + 2, 0);

const responseHeaderBytes = (
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
): number => Object.entries(headers).reduce((total, [name, value]) => {
  const values: readonly string[] = typeof value === "string"
    ? [value]
    : Array.isArray(value) ? value as readonly string[] : [];
  return total + values.reduce(
    (subtotal, item) => subtotal + Buffer.byteLength(name) + Buffer.byteLength(item) + 4,
    0,
  );
}, 0);

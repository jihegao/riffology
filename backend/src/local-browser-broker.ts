import { randomBytes } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

export const RIFF_BROWSER_ALIASES = ["riff-app", "riff-visual", "riff-artifact"] as const;
export type RiffBrowserAlias = typeof RIFF_BROWSER_ALIASES[number];

export type BrowserConversationScope = Readonly<{
  conversationId: string;
  conversationGeneration: number;
}>;

const REGISTERED_BROWSER_TARGET: unique symbol = Symbol("registered-browser-target");

export type BrowserTargetRegistration = Readonly<{
  alias: RiffBrowserAlias;
  url: string;
  projectedUrl: string;
}>;

/**
 * Opaque backend-only target. The broker accepts only records created by
 * registerLocalBrowserTarget; never serialize this record or its target URL.
 */
export type DeclaredBrowserTarget = BrowserTargetRegistration & Readonly<{
  [REGISTERED_BROWSER_TARGET]: true;
}>;

export const registerLocalBrowserTarget = (
  input: BrowserTargetRegistration,
): DeclaredBrowserTarget => validateTargetRegistration(input);

export type BrowserTargetResolver = (
  alias: RiffBrowserAlias,
  scope: BrowserConversationScope,
) => Promise<DeclaredBrowserTarget | null> | DeclaredBrowserTarget | null;

export type BrowserRecoveryState =
  | "ready"
  | "closed"
  | "expired"
  | "disconnected"
  | "unavailable";

export type BrowserSessionDto = Readonly<{
  schemaVersion: 1;
  conversationGeneration: number;
  pageGeneration: number;
  projectedUrl: string | null;
  trustState: "trusted_riff" | "none";
  controlMode: "observer";
  remainingBudget: null;
  recoveryState: BrowserRecoveryState;
  canGoBack: boolean;
  canReload: boolean;
  expiresAt: string | null;
}>;

export class LocalBrowserBrokerError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super("The local browser observation request was denied.");
    this.name = "LocalBrowserBrokerError";
    this.status = status;
    this.code = code;
  }
}

type BrowserSession = {
  scope: BrowserConversationScope;
  alias: RiffBrowserAlias | null;
  target: DeclaredBrowserTarget | null;
  projectedUrl: string | null;
  context?: BrowserContext;
  page?: Page;
  pageGeneration: number;
  recoveryState: BrowserRecoveryState;
  history: DeclaredBrowserTarget[];
  expiresAtMs: number;
};

type BrowserLauncher = () => Promise<Browser>;

const DEFAULT_TTL_MS = 15 * 60_000;
const NAVIGATION_TIMEOUT_MS = 10_000;
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;
const MAX_RESOURCE_BYTES = 8 * 1024 * 1024;
const VIEWPORT = Object.freeze({ width: 1_440, height: 900 });

/**
 * Local, observation-only browser ownership for the Riffology workbench.
 *
 * The public API accepts an enum alias, never a URL, host, IP, port, cookie,
 * browser profile, selector, or script. Each target is resolved from a
 * backend-owned record and the context aborts every request outside that exact
 * declared origin, including redirect hops and subresources.
 */
export class LocalBrowserBroker {
  readonly #resolveTarget: BrowserTargetResolver;
  readonly #launch: BrowserLauncher;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #pageGenerationSeed: number;
  readonly #sessions = new Map<string, BrowserSession>();
  readonly #scopeTails = new Map<string, Promise<void>>();
  #browser?: Browser;
  #launching?: Promise<Browser>;
  #closed = false;

  constructor(options: Readonly<{
    resolveTarget: BrowserTargetResolver;
    ttlMs?: number;
    now?: () => number;
    launch?: BrowserLauncher;
    pageGenerationSeed?: number;
  }>) {
    this.#resolveTarget = options.resolveTarget;
    this.#ttlMs = exactTtl(options.ttlMs ?? DEFAULT_TTL_MS);
    this.#now = options.now ?? Date.now;
    this.#launch = options.launch ?? (() => chromium.launch({
      headless: true,
      timeout: NAVIGATION_TIMEOUT_MS,
    }));
    this.#pageGenerationSeed = exactPageGenerationSeed(
      options.pageGenerationSeed ?? randomBytes(6).readUIntBE(0, 6),
    );
  }

  async state(scope: BrowserConversationScope): Promise<BrowserSessionDto> {
    return this.#serialized(scope, async () => {
      await this.#revokeOtherGenerations(scope);
      const session = await this.#session(scope, false);
      return this.#dto(session ?? emptySession(scope));
    });
  }

  async open(scope: BrowserConversationScope, alias: RiffBrowserAlias): Promise<BrowserSessionDto> {
    return this.#serialized(scope, async () => {
      if (!RIFF_BROWSER_ALIASES.includes(alias)) throw denied(422, "browser_alias_denied");
      await this.#revokeOtherGenerations(scope);
      const target = await this.#resolveTarget(alias, scope);
      if (!target || target.alias !== alias) throw denied(404, "browser_alias_unavailable");
      const declared = validateDeclaredTarget(target);
      let session = await this.#session(scope, true);
      if (session.recoveryState === "expired") {
        const renewed = emptySession(scope, this.#now() + this.#ttlMs, this.#pageGenerationSeed);
        renewed.pageGeneration = session.pageGeneration;
        this.#sessions.set(sessionKey(scope), renewed);
        session = renewed;
      }
      if (session.target && session.recoveryState === "ready") session.history.push(session.target);
      await this.#replacePage(session, declared);
      session.alias = alias;
      session.target = declared;
      incrementPageGeneration(session);
      session.recoveryState = "ready";
      return this.#dto(session);
    });
  }

  async reload(
    scope: BrowserConversationScope,
    expectedPageGeneration: number,
  ): Promise<BrowserSessionDto> {
    return this.#serialized(scope, async () => {
      const session = await this.#live(scope, expectedPageGeneration);
      try {
        await session.page!.reload({ waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
        await session.page!.waitForLoadState("networkidle", { timeout: 2_000 }).catch(() => undefined);
        assertPageWithinTarget(session);
      } catch {
        throw denied(502, "browser_navigation_failed");
      }
      return this.#dto(session);
    });
  }

  async back(
    scope: BrowserConversationScope,
    expectedPageGeneration: number,
  ): Promise<BrowserSessionDto> {
    return this.#serialized(scope, async () => {
      const session = await this.#live(scope, expectedPageGeneration);
      const prior = session.history.at(-1);
      if (!prior) throw denied(409, "browser_history_empty");
      try {
        await this.#replacePage(session, prior);
      } catch {
        throw denied(502, "browser_navigation_failed");
      }
      session.history.pop();
      incrementPageGeneration(session);
      return this.#dto(session);
    });
  }

  async screenshot(
    scope: BrowserConversationScope,
    expectedPageGeneration: number,
  ): Promise<Readonly<{
    schemaVersion: 1;
    pageGeneration: number;
    contentType: "image/png";
    pngBase64: string;
  }>> {
    return this.#serialized(scope, async () => {
      const session = await this.#live(scope, expectedPageGeneration);
      try {
        const bytes = await session.page!.screenshot({
          type: "png",
          fullPage: false,
          timeout: NAVIGATION_TIMEOUT_MS,
        });
        if (bytes.byteLength > MAX_SCREENSHOT_BYTES) {
          throw denied(413, "browser_screenshot_too_large");
        }
        return Object.freeze({
          schemaVersion: 1 as const,
          pageGeneration: session.pageGeneration,
          contentType: "image/png" as const,
          pngBase64: bytes.toString("base64"),
        });
      } catch (error) {
        if (error instanceof LocalBrowserBrokerError) throw error;
        throw denied(502, "browser_observation_failed");
      }
    });
  }

  async closeSession(
    scope: BrowserConversationScope,
    expectedPageGeneration: number,
  ): Promise<BrowserSessionDto> {
    return this.#serialized(scope, async () => {
      const session = await this.#session(scope, false);
      if (!session) return this.#dto(emptySession(scope));
      assertExpectedPage(session, expectedPageGeneration);
      await this.#disposePage(session);
      session.recoveryState = "closed";
      session.target = null;
      session.projectedUrl = null;
      session.alias = null;
      session.history = [];
      return this.#dto(session);
    });
  }

  async restart(
    scope: BrowserConversationScope,
    expectedPageGeneration: number,
  ): Promise<BrowserSessionDto> {
    return this.#serialized(scope, async () => {
      const session = await this.#session(scope, false);
      if (!session?.target) throw denied(409, "browser_session_closed");
      assertExpectedPage(session, expectedPageGeneration);
      if (session.recoveryState === "expired") throw denied(410, "browser_session_expired");
      await this.#replacePage(session, session.target);
      incrementPageGeneration(session);
      session.recoveryState = "ready";
      return this.#dto(session);
    });
  }

  async reconnect(
    scope: BrowserConversationScope,
    expectedPageGeneration: number,
  ): Promise<BrowserSessionDto> {
    return this.#serialized(scope, async () => {
      const session = await this.#session(scope, false);
      if (!session?.target) throw denied(409, "browser_session_closed");
      assertExpectedPage(session, expectedPageGeneration);
      if (session.recoveryState === "expired") throw denied(410, "browser_session_expired");
      if (session.recoveryState !== "disconnected" && session.recoveryState !== "unavailable") {
        return this.#dto(session);
      }
      await this.#replacePage(session, session.target);
      incrementPageGeneration(session);
      session.recoveryState = "ready";
      return this.#dto(session);
    });
  }

  /** Simulates or handles an owned Chromium/Broker disconnect without inventing page state. */
  async disconnect(): Promise<void> {
    await Promise.allSettled([...this.#scopeTails.values()]);
    const browser = this.#browser;
    this.#browser = undefined;
    this.#launching = undefined;
    for (const session of this.#sessions.values()) {
      session.page = undefined;
      session.context = undefined;
      if (session.target && session.recoveryState !== "expired") {
        session.recoveryState = "disconnected";
      }
    }
    await browser?.close().catch(() => undefined);
  }

  /** Backend-only revocation used when durable Conversation generation drifts. */
  async revoke(scope: BrowserConversationScope): Promise<void> {
    await this.#serialized(scope, async () => {
      const key = sessionKey(scope);
      const session = this.#sessions.get(key);
      if (!session) return;
      this.#sessions.delete(key);
      await this.#disposePage(session);
    });
  }

  async shutdown(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.allSettled([...this.#scopeTails.values()]);
    for (const session of this.#sessions.values()) await this.#disposePage(session);
    this.#sessions.clear();
    const browser = this.#browser;
    this.#browser = undefined;
    this.#launching = undefined;
    await browser?.close().catch(() => undefined);
  }

  async #live(
    scope: BrowserConversationScope,
    expectedPageGeneration: number,
  ): Promise<BrowserSession> {
    const session = await this.#session(scope, false);
    if (!session) throw denied(409, "browser_session_closed");
    assertExpectedPage(session, expectedPageGeneration);
    if (session.recoveryState === "expired") throw denied(410, "browser_session_expired");
    if (session.recoveryState === "disconnected" || session.recoveryState === "unavailable") {
      throw denied(503, "browser_session_disconnected");
    }
    if (session.recoveryState !== "ready" || !session.page || session.page.isClosed()) {
      throw denied(409, "browser_session_closed");
    }
    return session;
  }

  async #serialized<T>(scope: BrowserConversationScope, action: () => Promise<T>): Promise<T> {
    assertScope(scope);
    const key = scope.conversationId;
    const prior = this.#scopeTails.get(key) ?? Promise.resolve();
    const operation = prior.catch(() => undefined).then(action);
    const tail = operation.then(() => undefined, () => undefined);
    this.#scopeTails.set(key, tail);
    try {
      return await operation;
    } finally {
      if (this.#scopeTails.get(key) === tail) this.#scopeTails.delete(key);
    }
  }

  async #session(
    scope: BrowserConversationScope,
    create: boolean,
  ): Promise<BrowserSession | undefined> {
    assertScope(scope);
    if (this.#closed) throw denied(503, "browser_broker_unavailable");
    const key = sessionKey(scope);
    let session = this.#sessions.get(key);
    if (!session && create) {
      session = emptySession(scope, this.#now() + this.#ttlMs, this.#pageGenerationSeed);
      this.#sessions.set(key, session);
    }
    if (session && session.recoveryState !== "expired" && session.expiresAtMs <= this.#now()) {
      await this.#disposePage(session);
      session.recoveryState = "expired";
    }
    return session;
  }

  async #replacePage(
    session: BrowserSession,
    target: DeclaredBrowserTarget,
  ): Promise<void> {
    await this.#disposePage(session);
    let context: BrowserContext | undefined;
    try {
      const browser = await this.#browserInstance();
      context = await browser.newContext({
        acceptDownloads: false,
        serviceWorkers: "block",
        viewport: VIEWPORT,
      });
      await isolateContext(context, target);
      const page = await context.newPage();
      page.on("popup", (popup) => { void popup.close().catch(() => undefined); });
      page.on("framenavigated", (frame) => {
        if (frame !== page.mainFrame() || session.page !== page) return;
        try {
          if (new URL(frame.url()).origin !== new URL(target.url).origin) {
            session.recoveryState = "unavailable";
            void context?.close().catch(() => undefined);
            return;
          }
          session.projectedUrl = target.projectedUrl;
          incrementPageGeneration(session);
        } catch {
          session.recoveryState = "unavailable";
          void context?.close().catch(() => undefined);
        }
      });
      await page.goto(target.url, {
        waitUntil: "domcontentloaded",
        timeout: NAVIGATION_TIMEOUT_MS,
      });
      await page.waitForLoadState("networkidle", { timeout: 2_000 }).catch(() => undefined);
      session.target = target;
      session.projectedUrl = target.projectedUrl;
      session.context = context;
      session.page = page;
      assertPageWithinTarget(session);
    } catch (error) {
      await context?.close().catch(() => undefined);
      session.context = undefined;
      session.page = undefined;
      session.recoveryState = "unavailable";
      if (error instanceof LocalBrowserBrokerError) throw error;
      throw denied(502, "browser_navigation_failed");
    }
  }

  async #browserInstance(): Promise<Browser> {
    if (this.#browser?.isConnected()) return this.#browser;
    this.#launching ??= this.#launch().then((browser) => {
      if (this.#closed) {
        void browser.close().catch(() => undefined);
        throw denied(503, "browser_broker_unavailable");
      }
      browser.once("disconnected", () => {
        if (this.#browser === browser) {
          this.#browser = undefined;
          this.#launching = undefined;
          for (const session of this.#sessions.values()) {
            session.page = undefined;
            session.context = undefined;
            if (session.target && session.recoveryState !== "expired") {
              session.recoveryState = "disconnected";
            }
          }
        }
      });
      this.#browser = browser;
      return browser;
    }).catch((error) => {
      this.#launching = undefined;
      if (error instanceof LocalBrowserBrokerError) throw error;
      throw denied(503, "browser_broker_unavailable");
    });
    return this.#launching;
  }

  async #disposePage(session: BrowserSession): Promise<void> {
    const context = session.context;
    session.page = undefined;
    session.context = undefined;
    await context?.close().catch(() => undefined);
  }

  async #revokeOtherGenerations(scope: BrowserConversationScope): Promise<void> {
    const disposing: Promise<void>[] = [];
    for (const [key, session] of this.#sessions) {
      if (session.scope.conversationId === scope.conversationId
        && session.scope.conversationGeneration !== scope.conversationGeneration) {
        this.#sessions.delete(key);
        disposing.push(this.#disposePage(session));
      }
    }
    await Promise.allSettled(disposing);
  }

  #dto(session: BrowserSession): BrowserSessionDto {
    const ready = session.recoveryState === "ready" && Boolean(session.target);
    return Object.freeze({
      schemaVersion: 1,
      conversationGeneration: session.scope.conversationGeneration,
      pageGeneration: session.pageGeneration,
      projectedUrl: session.projectedUrl,
      trustState: ready ? "trusted_riff" : "none",
      controlMode: "observer",
      remainingBudget: null,
      recoveryState: session.recoveryState,
      canGoBack: ready && session.history.length > 0,
      canReload: ready,
      expiresAt: session.expiresAtMs > 0 ? new Date(session.expiresAtMs).toISOString() : null,
    });
  }
}

const isolateContext = async (
  context: BrowserContext,
  target: DeclaredBrowserTarget,
): Promise<void> => {
  const declaredOrigin = new URL(target.url).origin;
  await context.route("**/*", async (route) => {
    try {
      const request = route.request();
      const first = new URL(request.url());
      if (!allowedBrowserRequest(first, declaredOrigin, request.method())) {
        await route.abort("blockedbyclient");
        return;
      }
      let candidate = first;
      for (let redirects = 0; redirects <= 5; redirects += 1) {
        const fetched = await route.fetch({ url: candidate.href, maxRedirects: 0 });
        const location = fetched.headers().location;
        if (fetched.status() >= 300 && fetched.status() < 400) {
          await fetched.dispose();
          if (!location) {
            await route.abort("blockedbyclient");
            return;
          }
          candidate = new URL(location, candidate);
          if (!allowedBrowserRequest(candidate, declaredOrigin, "GET")) {
            await route.abort("blockedbyclient");
            return;
          }
          continue;
        }
        const body = await fetched.body();
        if (body.byteLength > MAX_RESOURCE_BYTES) {
          await fetched.dispose();
          await route.abort("blockedbyclient");
          return;
        }
        await route.fulfill({ response: fetched, body });
        await fetched.dispose();
        return;
      }
      await route.abort("blockedbyclient");
    } catch {
      await route.abort("blockedbyclient").catch(() => undefined);
    }
  });
  await context.routeWebSocket("**/*", (socket) => socket.close());
};

const allowedBrowserRequest = (
  candidate: URL,
  declaredOrigin: string,
  method: string,
): boolean => {
  if (candidate.protocol !== "http:" && candidate.protocol !== "https:") return false;
  if (candidate.origin !== declaredOrigin || candidate.username || candidate.password) return false;
  if (method === "GET" || method === "HEAD") return true;
  return false;
};

const validateDeclaredTarget = (target: DeclaredBrowserTarget): DeclaredBrowserTarget => {
  if (target[REGISTERED_BROWSER_TARGET] !== true) {
    throw denied(500, "browser_alias_misconfigured");
  }
  return target;
};

const validateTargetRegistration = (
  target: BrowserTargetRegistration,
): DeclaredBrowserTarget => {
  if (!RIFF_BROWSER_ALIASES.includes(target.alias)
    || !target.projectedUrl.startsWith(`${target.alias}://`)
    || target.projectedUrl.length > 1_024) {
    throw denied(500, "browser_alias_misconfigured");
  }
  let url: URL;
  try { url = new URL(target.url); } catch { throw denied(500, "browser_alias_misconfigured"); }
  if (url.protocol !== "http:" || url.username || url.password || url.hash
    || url.hostname !== "localhost" || !url.port) {
    throw denied(500, "browser_alias_misconfigured");
  }
  return Object.freeze({
    alias: target.alias,
    url: url.href,
    projectedUrl: target.projectedUrl,
    [REGISTERED_BROWSER_TARGET]: true as const,
  });
};

const assertPageWithinTarget = (session: BrowserSession): void => {
  if (!session.page || !session.target) throw denied(502, "browser_navigation_failed");
  let current: URL;
  try { current = new URL(session.page.url()); } catch { throw denied(502, "browser_redirect_denied"); }
  if (current.origin !== new URL(session.target.url).origin) {
    throw denied(502, "browser_redirect_denied");
  }
};

const emptySession = (
  scope: BrowserConversationScope,
  expiresAtMs = 0,
  pageGeneration = 0,
): BrowserSession => ({
  scope: Object.freeze({ ...scope }),
  alias: null,
  target: null,
  projectedUrl: null,
  pageGeneration,
  recoveryState: "closed",
  history: [],
  expiresAtMs,
});

const assertScope = (scope: BrowserConversationScope): void => {
  if (!scope.conversationId || scope.conversationId.length > 200
    || !Number.isSafeInteger(scope.conversationGeneration)
    || scope.conversationGeneration < 1) {
    throw denied(422, "browser_scope_invalid");
  }
};

const assertExpectedPage = (session: BrowserSession, expected: number): void => {
  if (!Number.isSafeInteger(expected) || expected < 0 || expected !== session.pageGeneration) {
    throw denied(409, "browser_page_stale");
  }
};

const exactTtl = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 60 * 60_000) {
    throw new Error("Browser session TTL must be between 1 second and 1 hour.");
  }
  return value;
};

const exactPageGenerationSeed = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - 1_000_000) {
    throw new Error("Browser page generation seed is invalid.");
  }
  return value;
};

const incrementPageGeneration = (session: BrowserSession): void => {
  if (session.pageGeneration >= Number.MAX_SAFE_INTEGER) {
    throw denied(503, "browser_generation_exhausted");
  }
  session.pageGeneration += 1;
};

const sessionKey = (scope: BrowserConversationScope): string =>
  `${scope.conversationId}\u0000${scope.conversationGeneration}`;

const denied = (status: number, code: string): LocalBrowserBrokerError =>
  new LocalBrowserBrokerError(status, code);

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";

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
  controlMode: "observer" | "agent" | "human";
  remainingBudget: number | null;
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
  controlMode: "observer" | "agent" | "human";
  controlEpoch: number;
  remainingBudget: number | null;
  domGeneration: number;
  elementRefs: Map<string, BrowserElementRef>;
};

type BrowserElementRef = Readonly<{
  pageGeneration: number;
  domGeneration: number;
  ordinal: number;
  descriptorDigest: string;
}>;

export type BrowserAgentSnapshotDto = Readonly<{
  schemaVersion: 1;
  pageGeneration: number;
  projectedUrl: string;
  elements: ReadonlyArray<Readonly<{
    ref: string;
    role: string;
    name: string;
    disabled: boolean;
    editable: boolean;
  }>>;
  truncated: boolean;
}>;

/** Backend-only lease. controlEpoch is never serialized through the workbench API. */
export type BrowserAgentControlLease = Readonly<{
  state: BrowserSessionDto;
  controlEpoch: number;
}>;

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
      const current = await this.#session(scope, false);
      if (current?.controlMode === "agent") throw denied(409, "browser_agent_controlled");
      if (current?.controlMode === "human") throw denied(409, "browser_human_controlled");
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
      assertPublicMutationAllowed(session);
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
      assertPublicMutationAllowed(session);
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

  /** Backend-only: atomically transfers an observer page to an activated Agent grant. */
  async claimAgent(
    scope: BrowserConversationScope,
    remainingBudget: number | null = null,
  ): Promise<BrowserAgentControlLease> {
    return this.#serialized(scope, async () => {
      const session = await this.#session(scope, false);
      if (!session || session.recoveryState !== "ready" || !session.page) {
        throw denied(409, "browser_session_closed");
      }
      if (session.controlMode === "human") throw denied(409, "browser_human_controlled");
      session.controlMode = "agent";
      session.controlEpoch += 1;
      session.remainingBudget = remainingBudget;
      return Object.freeze({ state: this.#dto(session), controlEpoch: session.controlEpoch });
    });
  }

  /** Backend-only: revocation never resurrects Agent control after human takeover. */
  async releaseAgent(scope: BrowserConversationScope): Promise<BrowserSessionDto> {
    // Fail closed before joining the per-conversation tail. This invalidates an
    // action currently suspended in Playwright so its post-await epoch check
    // cannot report success after turn cancellation/revocation.
    assertScope(scope);
    const current = this.#sessions.get(sessionKey(scope));
    if (current?.controlMode === "agent") {
      current.controlMode = "observer";
      current.controlEpoch += 1;
      current.remainingBudget = null;
      current.elementRefs.clear();
    }
    return this.#serialized(scope, async () => {
      const session = await this.#session(scope, false);
      if (!session) return this.#dto(emptySession(scope));
      session.elementRefs.clear();
      return this.#dto(session);
    });
  }

  /**
   * Backend-only explicit human takeover. Invalidation and context close begin
   * before joining the tail so a suspended Agent action cannot later succeed.
   * Human-ready is published only after the same declared target is rebuilt.
   */
  async takeHuman(
    scope: BrowserConversationScope,
    expectedPageGeneration: number,
  ): Promise<BrowserSessionDto> {
    assertScope(scope);
    const current = this.#sessions.get(sessionKey(scope));
    if (!current) throw denied(409, "browser_session_closed");
    assertExpectedPage(current, expectedPageGeneration);
    if (!current.target || current.recoveryState !== "ready") {
      throw denied(409, "browser_session_closed");
    }
    const target = current.target;
    current.controlMode = "observer";
    current.controlEpoch += 1;
    current.remainingBudget = null;
    current.elementRefs.clear();
    current.recoveryState = "unavailable";
    const context = current.context;
    current.context = undefined;
    current.page = undefined;
    const preempt = context?.close().catch(() => undefined) ?? Promise.resolve();
    return this.#serialized(scope, async () => {
      const session = await this.#session(scope, false);
      if (!session || session !== current || session.target !== target) {
        throw denied(409, "browser_control_stale");
      }
      await preempt;
      try {
        await this.#replacePage(session, target);
        incrementPageGeneration(session);
        session.recoveryState = "ready";
        session.controlMode = "human";
        session.controlEpoch += 1;
        session.remainingBudget = null;
        session.elementRefs.clear();
        return this.#dto(session);
      } catch (error) {
        session.controlMode = "observer";
        session.remainingBudget = null;
        session.elementRefs.clear();
        if (error instanceof LocalBrowserBrokerError) throw error;
        throw denied(502, "browser_takeover_failed");
      }
    });
  }

  /** Human return never restores a prior Agent grant or control epoch. */
  async returnObserver(
    scope: BrowserConversationScope,
    expectedPageGeneration: number,
  ): Promise<BrowserSessionDto> {
    return this.#serialized(scope, async () => {
      const session = await this.#live(scope, expectedPageGeneration);
      if (session.controlMode !== "human") throw denied(409, "browser_human_control_denied");
      session.controlMode = "observer";
      session.controlEpoch += 1;
      session.remainingBudget = null;
      session.elementRefs.clear();
      return this.#dto(session);
    });
  }

  /** Backend-only public projection update; never carries the grant or capability. */
  async updateAgentBudget(
    scope: BrowserConversationScope,
    expectedControlEpoch: number,
    remainingBudget: number,
  ): Promise<BrowserSessionDto> {
    return this.#serialized(scope, async () => {
      const session = await this.#session(scope, false);
      if (!session) throw denied(409, "browser_agent_control_denied");
      assertAgentEpoch(session, expectedControlEpoch);
      session.remainingBudget = Math.max(0, Math.trunc(remainingBudget));
      return this.#dto(session);
    });
  }

  /** Backend-only bounded projection; no selector, script, DOM HTML, or form value is exposed. */
  async agentSnapshot(
    scope: BrowserConversationScope,
    expectedPageGeneration: number,
    expectedControlEpoch: number,
  ): Promise<BrowserAgentSnapshotDto> {
    return this.#serialized(scope, async () => {
      const session = await this.#agentLive(scope, expectedPageGeneration);
      assertAgentEpoch(session, expectedControlEpoch);
      const candidates = session.page!.locator(
        "a,button,input,textarea,select,[role],[tabindex]",
      );
      const total = await candidates.count();
      assertAgentEpoch(session, expectedControlEpoch);
      const limit = Math.min(total, 200);
      const elements: Array<{
        ref: string;
        role: string;
        name: string;
        disabled: boolean;
        editable: boolean;
      }> = [];
      session.elementRefs.clear();
      for (let ordinal = 0; ordinal < limit; ordinal += 1) {
        const descriptor = await interactiveDescriptor(candidates.nth(ordinal));
        assertAgentEpoch(session, expectedControlEpoch);
        if (!descriptor) continue;
        const ref = `element_${randomUUID().replaceAll("-", "")}`;
        session.elementRefs.set(ref, Object.freeze({
          pageGeneration: session.pageGeneration,
          domGeneration: session.domGeneration,
          ordinal,
          descriptorDigest: descriptorDigest(descriptor),
        }));
        elements.push({ ref, ...descriptor });
      }
      return Object.freeze({
        schemaVersion: 1,
        pageGeneration: session.pageGeneration,
        projectedUrl: session.projectedUrl!,
        elements: Object.freeze(elements.map((element) => Object.freeze(element))),
        truncated: total > limit,
      });
    });
  }

  /** Backend-only ref action. Caller input can never provide a selector. */
  async agentClick(
    scope: BrowserConversationScope,
    expectedPageGeneration: number,
    expectedControlEpoch: number,
    ref: string,
  ): Promise<BrowserSessionDto> {
    return this.#serialized(scope, async () => {
      const session = await this.#agentLive(scope, expectedPageGeneration);
      assertAgentEpoch(session, expectedControlEpoch);
      const declared = session.elementRefs.get(ref);
      if (!declared || declared.pageGeneration !== session.pageGeneration
        || declared.domGeneration !== session.domGeneration) {
        throw denied(409, "browser_element_stale");
      }
      const locator = session.page!.locator(
        "a,button,input,textarea,select,[role],[tabindex]",
      ).nth(declared.ordinal);
      const descriptor = await interactiveDescriptor(locator);
      assertAgentEpoch(session, expectedControlEpoch);
      if (!descriptor || descriptorDigest(descriptor) !== declared.descriptorDigest) {
        session.elementRefs.clear();
        throw denied(409, "browser_element_stale");
      }
      try {
        await locator.click({ timeout: NAVIGATION_TIMEOUT_MS });
        assertAgentEpoch(session, expectedControlEpoch);
        await session.page!.waitForLoadState("networkidle", { timeout: 2_000 })
          .catch(() => undefined);
        assertAgentEpoch(session, expectedControlEpoch);
      } catch (error) {
        assertAgentEpoch(session, expectedControlEpoch);
        if (error instanceof LocalBrowserBrokerError) throw error;
        throw denied(502, "browser_action_failed");
      }
      session.domGeneration += 1;
      session.elementRefs.clear();
      return this.#dto(session);
    });
  }

  /** Backend-only ref action. Text is bounded by the Browser tool schema. */
  async agentType(
    scope: BrowserConversationScope,
    expectedPageGeneration: number,
    expectedControlEpoch: number,
    ref: string,
    text: string,
  ): Promise<BrowserSessionDto> {
    return this.#serialized(scope, async () => {
      const session = await this.#agentLive(scope, expectedPageGeneration);
      assertAgentEpoch(session, expectedControlEpoch);
      if (Buffer.byteLength(text, "utf8") > 4_096 || /\u0000/u.test(text)) {
        throw denied(422, "browser_type_invalid");
      }
      const locator = await this.#agentLocator(session, expectedControlEpoch, ref, true);
      assertAgentEpoch(session, expectedControlEpoch);
      try {
        await locator.fill(text, { timeout: NAVIGATION_TIMEOUT_MS });
        assertAgentEpoch(session, expectedControlEpoch);
      } catch (error) {
        assertAgentEpoch(session, expectedControlEpoch);
        if (error instanceof LocalBrowserBrokerError) throw error;
        throw denied(502, "browser_action_failed");
      }
      session.domGeneration += 1;
      session.elementRefs.clear();
      return this.#dto(session);
    });
  }

  async agentScroll(
    scope: BrowserConversationScope,
    expectedPageGeneration: number,
    expectedControlEpoch: number,
    deltaY: number,
  ): Promise<BrowserSessionDto> {
    return this.#serialized(scope, async () => {
      const session = await this.#agentLive(scope, expectedPageGeneration);
      assertAgentEpoch(session, expectedControlEpoch);
      if (!Number.isSafeInteger(deltaY) || deltaY === 0 || deltaY < -2_000 || deltaY > 2_000) {
        throw denied(422, "browser_scroll_invalid");
      }
      try {
        await session.page!.mouse.wheel(0, deltaY);
        assertAgentEpoch(session, expectedControlEpoch);
      } catch (error) {
        assertAgentEpoch(session, expectedControlEpoch);
        if (error instanceof LocalBrowserBrokerError) throw error;
        throw denied(502, "browser_action_failed");
      }
      return this.#dto(session);
    });
  }

  async agentWait(
    scope: BrowserConversationScope,
    expectedPageGeneration: number,
    expectedControlEpoch: number,
    milliseconds: number,
  ): Promise<BrowserSessionDto> {
    return this.#serialized(scope, async () => {
      const session = await this.#agentLive(scope, expectedPageGeneration);
      assertAgentEpoch(session, expectedControlEpoch);
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 50 || milliseconds > 2_000) {
        throw denied(422, "browser_wait_invalid");
      }
      try {
        await session.page!.waitForTimeout(milliseconds);
        assertAgentEpoch(session, expectedControlEpoch);
      } catch (error) {
        assertAgentEpoch(session, expectedControlEpoch);
        if (error instanceof LocalBrowserBrokerError) throw error;
        throw denied(502, "browser_action_failed");
      }
      return this.#dto(session);
    });
  }

  async agentScreenshot(
    scope: BrowserConversationScope,
    expectedPageGeneration: number,
    expectedControlEpoch: number,
  ): Promise<Readonly<{
    schemaVersion: 1;
    pageGeneration: number;
    contentType: "image/png";
    pngBase64: string;
  }>> {
    return this.#serialized(scope, async () => {
      const session = await this.#agentLive(scope, expectedPageGeneration);
      assertAgentEpoch(session, expectedControlEpoch);
      try {
        const bytes = await session.page!.screenshot({
          type: "png",
          fullPage: false,
          timeout: NAVIGATION_TIMEOUT_MS,
        });
        assertAgentEpoch(session, expectedControlEpoch);
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
        assertAgentEpoch(session, expectedControlEpoch);
        if (error instanceof LocalBrowserBrokerError) throw error;
        throw denied(502, "browser_observation_failed");
      }
    });
  }

  async agentBack(
    scope: BrowserConversationScope,
    expectedPageGeneration: number,
    expectedControlEpoch: number,
  ): Promise<BrowserSessionDto> {
    return this.#serialized(scope, async () => {
      const session = await this.#agentLive(scope, expectedPageGeneration);
      assertAgentEpoch(session, expectedControlEpoch);
      const prior = session.history.at(-1);
      if (!prior) throw denied(409, "browser_history_empty");
      try { await this.#replacePage(session, prior); }
      catch (error) {
        assertAgentEpoch(session, expectedControlEpoch);
        if (error instanceof LocalBrowserBrokerError) throw error;
        throw denied(502, "browser_navigation_failed");
      }
      assertAgentEpoch(session, expectedControlEpoch);
      session.history.pop();
      incrementPageGeneration(session);
      session.controlMode = "agent";
      return this.#dto(session);
    });
  }

  async agentReload(
    scope: BrowserConversationScope,
    expectedPageGeneration: number,
    expectedControlEpoch: number,
  ): Promise<BrowserSessionDto> {
    return this.#serialized(scope, async () => {
      const session = await this.#agentLive(scope, expectedPageGeneration);
      assertAgentEpoch(session, expectedControlEpoch);
      try {
        await session.page!.reload({ waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
        assertAgentEpoch(session, expectedControlEpoch);
        await session.page!.waitForLoadState("networkidle", { timeout: 2_000 }).catch(() => undefined);
        assertAgentEpoch(session, expectedControlEpoch);
        assertPageWithinTarget(session);
      } catch (error) {
        assertAgentEpoch(session, expectedControlEpoch);
        if (error instanceof LocalBrowserBrokerError) throw error;
        throw denied(502, "browser_navigation_failed");
      }
      return this.#dto(session);
    });
  }

  async agentClose(
    scope: BrowserConversationScope,
    expectedPageGeneration: number,
    expectedControlEpoch: number,
  ): Promise<BrowserSessionDto> {
    return this.#serialized(scope, async () => {
      const session = await this.#agentLive(scope, expectedPageGeneration);
      assertAgentEpoch(session, expectedControlEpoch);
      await this.#disposePage(session);
      assertAgentEpoch(session, expectedControlEpoch);
      session.recoveryState = "closed";
      session.target = null;
      session.projectedUrl = null;
      session.alias = null;
      session.history = [];
      session.controlMode = "observer";
      session.controlEpoch += 1;
      session.remainingBudget = null;
      session.elementRefs.clear();
      return this.#dto(session);
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
      assertPublicMutationAllowed(session);
      await this.#disposePage(session);
      session.recoveryState = "closed";
      session.target = null;
      session.projectedUrl = null;
      session.alias = null;
      session.history = [];
      session.controlMode = "observer";
      session.elementRefs.clear();
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
      assertPublicMutationAllowed(session);
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
      assertPublicMutationAllowed(session);
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
      session.controlEpoch += 1;
      session.controlMode = "observer";
      session.remainingBudget = null;
      session.elementRefs.clear();
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

  async #agentLive(
    scope: BrowserConversationScope,
    expectedPageGeneration: number,
  ): Promise<BrowserSession> {
    const session = await this.#live(scope, expectedPageGeneration);
    if (session.controlMode !== "agent") throw denied(409, "browser_agent_control_denied");
    return session;
  }

  async #agentLocator(
    session: BrowserSession,
    expectedControlEpoch: number,
    ref: string,
    requireEditable: boolean,
  ): Promise<Locator> {
    const declared = session.elementRefs.get(ref);
    if (!declared || declared.pageGeneration !== session.pageGeneration
      || declared.domGeneration !== session.domGeneration) {
      throw denied(409, "browser_element_stale");
    }
    const locator = session.page!.locator(
      "a,button,input,textarea,select,[role],[tabindex]",
    ).nth(declared.ordinal);
    const descriptor = await interactiveDescriptor(locator);
    assertAgentEpoch(session, expectedControlEpoch);
    if (!descriptor || descriptorDigest(descriptor) !== declared.descriptorDigest
      || requireEditable && !descriptor.editable) {
      session.elementRefs.clear();
      throw denied(409, "browser_element_stale");
    }
    return locator;
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
      const mutationBinding = `__riff_mutation_${randomUUID().replaceAll("-", "")}`;
      let observedPage: Page | undefined;
      await context.exposeBinding(mutationBinding, () => {
        if (session.page === observedPage) {
          session.domGeneration += 1;
          session.elementRefs.clear();
        }
      });
      await context.addInitScript(({ binding }) => {
        const notify = (globalThis as any)[binding];
        if (typeof notify !== "function") return;
        const start = () => {
          if (!document.documentElement) return setTimeout(start, 0);
          let queued = false;
          new MutationObserver(() => {
            if (queued) return;
            queued = true;
            queueMicrotask(() => {
              queued = false;
              void (notify as () => Promise<void>)();
            });
          }).observe(document.documentElement, {
            subtree: true,
            childList: true,
            attributes: true,
            characterData: true,
          });
        };
        start();
      }, { binding: mutationBinding });
      await isolateContext(context, target);
      const page = await context.newPage();
      observedPage = page;
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
          session.domGeneration += 1;
          session.elementRefs.clear();
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
      session.elementRefs.clear();
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
            session.controlEpoch += 1;
            session.controlMode = "observer";
            session.remainingBudget = null;
            session.elementRefs.clear();
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
      controlMode: session.controlMode,
      remainingBudget: session.remainingBudget,
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
  // The explicitly configured Solara target owns its loopback page and its
  // asset graph (including the Solara client websocket). The target resolver
  // emits this exact projected identity; all other targets stay behind the
  // strict same-origin request proxy below.
  if (target.alias === "riff-visual" && target.projectedUrl === "riff-visual://solara/") return;
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
  // Solara hydrates its read-only page over a same-origin WebSocket. Keep the
  // stricter default for the Product shell and artifact pages, while allowing
  // the explicitly declared riff-visual target to complete its own hydration.
  if (target.alias !== "riff-visual") {
    await context.routeWebSocket("**/*", (socket) => socket.close());
  }
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

type InteractiveDescriptor = Readonly<{
  role: string;
  name: string;
  disabled: boolean;
  editable: boolean;
}>;

const interactiveDescriptor = async (
  locator: Locator,
): Promise<InteractiveDescriptor | null> => {
  try {
    const value = await locator.evaluate((element: any) => {
      const tag = String(element.tagName ?? "").toLowerCase();
      const explicitRole = element.getAttribute?.("role");
      const role = explicitRole || (tag === "a" ? "link"
        : tag === "button" ? "button"
          : tag === "select" ? "combobox"
            : tag === "textarea" ? "textbox"
              : tag === "input" ? (element.type === "checkbox" ? "checkbox"
                : element.type === "radio" ? "radio" : "textbox")
                : "interactive");
      const label = element.getAttribute?.("aria-label")
        || element.labels?.[0]?.textContent
        || element.getAttribute?.("title")
        || element.getAttribute?.("name")
        || role;
      return {
        role: String(role).replace(/\s+/gu, " ").trim().slice(0, 64),
        name: String(label).replace(/\s+/gu, " ").trim().slice(0, 500),
        disabled: Boolean(element.disabled || element.getAttribute?.("aria-disabled") === "true"),
        editable: tag === "textarea" || tag === "input"
          && !new Set(["button", "submit", "reset", "checkbox", "radio", "file", "hidden"])
            .has(String(element.type).toLowerCase()),
      };
    });
    if (!value || typeof value.role !== "string" || typeof value.name !== "string"
      || typeof value.disabled !== "boolean" || typeof value.editable !== "boolean"
      || !value.role || !value.name
      || Buffer.byteLength(value.role, "utf8") > 256
      || Buffer.byteLength(value.name, "utf8") > 2_000
      || /[\u0000-\u001f\u007f]/u.test(value.role)
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value.name)) return null;
    return Object.freeze(value as InteractiveDescriptor);
  } catch {
    return null;
  }
};

const descriptorDigest = (descriptor: InteractiveDescriptor): string =>
  createHash("sha256").update(JSON.stringify(descriptor)).digest("hex");

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
  controlMode: "observer",
  controlEpoch: 0,
  remainingBudget: null,
  domGeneration: 0,
  elementRefs: new Map(),
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

const assertPublicMutationAllowed = (session: BrowserSession): void => {
  if (session.controlMode === "agent") throw denied(409, "browser_agent_controlled");
};

const assertAgentEpoch = (session: BrowserSession, expected: number): void => {
  if (!Number.isSafeInteger(expected) || expected < 1
    || session.controlMode !== "agent" || session.controlEpoch !== expected) {
    throw denied(409, "browser_control_stale");
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

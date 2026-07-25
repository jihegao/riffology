import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import {
  VisualAgentHttpBridge,
  type ExactPeerInspectionPort,
  type ExactPeerVisualTarget,
} from "./visual-agent-http-bridge.ts";

export type VisualInteractionLocator =
  | Readonly<{ kind: "role_name"; role: string; name: string }>
  | Readonly<{ kind: "label"; label: string }>;

export type VisualInteractionOperation =
  | Readonly<{ kind: "click"; locator: VisualInteractionLocator }>
  | Readonly<{ kind: "type" | "select"; locator: VisualInteractionLocator; value: string }>;

export type VisualInteractionReceipt = Readonly<{
  schemaVersion: 1;
  kind: "click" | "type" | "select";
  status: "dispatched";
  untrusted: true;
}>;

export class VisualAgentInteractionError extends Error {
  readonly code = "visual_interaction_failed";
  readonly mayHaveDispatched: boolean;
  constructor(mayHaveDispatched = false) {
    super("The scoped visual interaction is unavailable.");
    this.name = "VisualAgentInteractionError";
    this.mayHaveDispatched = mayHaveDispatched;
  }
}

const denied = (mayHaveDispatched = false): VisualAgentInteractionError =>
  new VisualAgentInteractionError(mayHaveDispatched);
const TIMEOUT_MS = 5_000;
const ROLES = new Set(["button", "checkbox", "combobox", "radio", "switch", "tab", "textbox"]);
const CLICK_ROLES = new Set(["button", "checkbox", "radio", "switch", "tab"]);

/** A fresh, one-primitive renderer. It has no route to the child except its private relay. */
export class VisualAgentInteractor {
  readonly #inspection?: Partial<ExactPeerInspectionPort>;

  constructor(options: Readonly<{
    inspection?: Partial<ExactPeerInspectionPort>;
  }> = {}) {
    this.#inspection = options.inspection;
  }

  async interact(input: Readonly<{
    target: ExactPeerVisualTarget;
    operation: VisualInteractionOperation;
    assertLive: () => void;
    signal: AbortSignal;
  }>): Promise<VisualInteractionReceipt> {
    if (input.signal.aborted) throw denied();
    const operation = normalizedOperation(input.operation);
    let primitiveStarted = false;
    let bridge: VisualAgentHttpBridge | undefined;
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    try {
      bridge = await VisualAgentHttpBridge.open({
        target: input.target,
        assertLive: input.assertLive,
        signal: input.signal,
        ...(this.#inspection ? { inspection: this.#inspection } : {}),
      });
      const launching = chromium.launch({ headless: true, timeout: TIMEOUT_MS });
      try { browser = await abortable(launching, input.signal); }
      catch { void launching.then((late) => late.close()).catch(() => undefined); throw denied(); }
      context = await abortable(browser.newContext({ acceptDownloads: false, serviceWorkers: "block", viewport: { width: 1280, height: 720 } }), input.signal);
      await context.setExtraHTTPHeaders(bridge.requestHeaders);
      let policyViolation = false;
      await isolate(context, bridge.origin, () => { policyViolation = true; });
      const page = await abortable(context.newPage(), input.signal);
      page.on("popup", (popup) => { policyViolation = true; void popup.close().catch(() => undefined); });
      page.on("download", (download) => { policyViolation = true; void download.cancel().catch(() => undefined); });
      page.on("dialog", (dialog) => { policyViolation = true; void dialog.dismiss().catch(() => undefined); });
      const response = await abortable(page.goto(`${bridge.origin}/`, { timeout: TIMEOUT_MS, waitUntil: "domcontentloaded" }), input.signal);
      if (!response || !response.ok() || response.url() !== `${bridge.origin}/`) throw denied();
      input.assertLive();
      const locator = await exactLocator(page, operation.locator, input.signal);
      await assertPrimitiveAllowed(locator, operation, input.signal);
      input.assertLive();
      primitiveStarted = true;
      if (operation.kind === "click") await abortable(locator.click({ button: "left", timeout: TIMEOUT_MS, noWaitAfter: true }), input.signal);
      else if (operation.kind === "type") await typeOnce(locator, operation.value, input.signal);
      else await selectOnce(locator, operation.value, input.signal);
      await abortable(page.waitForTimeout(25), input.signal);
      if (policyViolation || page.url() !== `${bridge.origin}/`) throw denied();
      input.assertLive();
      return Object.freeze({ schemaVersion: 1, kind: operation.kind, status: "dispatched", untrusted: true });
    } catch {
      throw denied(primitiveStarted);
    } finally {
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
      await bridge?.close().catch(() => undefined);
    }
  }
}

const isolate = async (
  context: BrowserContext,
  origin: string,
  violation: () => void,
): Promise<void> => {
  let initialDocumentAllowed = true;
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const document = request.resourceType() === "document";
    const validInitialDocument = document
      && initialDocumentAllowed
      && request.url() === `${origin}/`;
    if (validInitialDocument) initialDocumentAllowed = false;
    if (request.method() !== "GET"
      || url.origin !== origin
      || (document && !validInitialDocument)) {
      violation();
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  await context.routeWebSocket("**/*", (socket) => { violation(); socket.close(); });
};

const exactLocator = async (page: Page, locator: VisualInteractionLocator, signal: AbortSignal): Promise<Locator> => {
  const candidate = locator.kind === "role_name"
    ? page.getByRole(locator.role as any, { name: locator.name, exact: true })
    : page.getByLabel(locator.label, { exact: true });
  if (await abortable(candidate.count(), signal) !== 1
    || !await abortable(candidate.isVisible({ timeout: TIMEOUT_MS }), signal)
    || !await abortable(candidate.isEnabled({ timeout: TIMEOUT_MS }), signal)) throw denied();
  return candidate;
};

const typeOnce = async (locator: Locator, value: string, signal: AbortSignal): Promise<void> => {
  const type = (await abortable(locator.getAttribute("type"), signal) ?? "").toLowerCase();
  if (type === "password" || type === "file") throw denied();
  await abortable(locator.fill(value, { timeout: TIMEOUT_MS }), signal);
};
const selectOnce = async (locator: Locator, value: string, signal: AbortSignal): Promise<void> => {
  await abortable(locator.selectOption({ value }, { timeout: TIMEOUT_MS }), signal);
};

const normalizedOperation = (value: VisualInteractionOperation): VisualInteractionOperation => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw denied();
  const keys = Object.keys(value).sort();
  if (value.kind === "click") {
    if (keys.join("\n") !== "kind\nlocator") throw denied();
    const locator = normalizedLocator(value.locator);
    if (locator.kind === "role_name" && !CLICK_ROLES.has(locator.role)) throw denied();
    return Object.freeze({ kind: "click", locator });
  }
  if ((value.kind === "type" || value.kind === "select") && keys.join("\n") === "kind\nlocator\nvalue") {
    if (typeof value.value !== "string" || value.value.includes("\0") || Buffer.byteLength(value.value, "utf8") > 16_384) throw denied();
    const locator = normalizedLocator(value.locator);
    if (locator.kind === "role_name"
      && (value.kind === "type"
        ? locator.role !== "textbox"
        : locator.role !== "combobox")) throw denied();
    return Object.freeze({ kind: value.kind, locator, value: value.value });
  }
  throw denied();
};
const normalizedLocator = (value: VisualInteractionLocator): VisualInteractionLocator => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw denied();
  if (value.kind === "role_name" && Object.keys(value).sort().join("\n") === "kind\nname\nrole") {
    if (!ROLES.has(value.role) || !bounded(value.name, 512)) throw denied();
    return Object.freeze({ kind: "role_name", role: value.role, name: value.name.normalize("NFC") });
  }
  if (value.kind === "label" && Object.keys(value).sort().join("\n") === "kind\nlabel" && bounded(value.label, 512)) return Object.freeze({ kind: "label", label: value.label.normalize("NFC") });
  throw denied();
};
const bounded = (value: unknown, max: number): value is string => typeof value === "string" && Boolean(value) && !value.includes("\0") && Buffer.byteLength(value.normalize("NFC"), "utf8") <= max;

const assertPrimitiveAllowed = async (
  locator: Locator,
  operation: VisualInteractionOperation,
  signal: AbortSignal,
): Promise<void> => {
  const href = await abortable(locator.getAttribute("href"), signal);
  const formAction = await abortable(locator.getAttribute("formaction"), signal);
  const target = await abortable(locator.getAttribute("target"), signal);
  const contentEditable = await abortable(locator.getAttribute("contenteditable"), signal);
  if (href !== null || formAction !== null || target !== null
    || (contentEditable !== null && contentEditable.toLowerCase() !== "false")) throw denied();
  const type = (await abortable(locator.getAttribute("type"), signal) ?? "").toLowerCase();
  if (type === "file" || type === "password" || type === "submit" || type === "image") throw denied();
  if (operation.kind === "click" && operation.locator.kind === "label"
    && !new Set(["button", "checkbox", "radio"]).has(type)) throw denied();
  if (operation.kind === "type"
    && !await abortable(locator.isEditable({ timeout: TIMEOUT_MS }), signal)) throw denied();
};

const abortable = async <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) throw denied();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(denied());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
};

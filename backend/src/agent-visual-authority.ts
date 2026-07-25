import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { canonicalDigest } from "./canonical-json-v2.ts";
import type { IsoTimestamp } from "./product-domain.ts";

export type VisualAgentLocator =
  | Readonly<{ kind: "role_name"; role: string; name: string }>
  | Readonly<{ kind: "label"; label: string }>;

export type VisualAgentOperation =
  | Readonly<{ kind: "observe_structured" | "observe_accessibility" | "observe_dom_text" | "observe_screenshot" }>
  | Readonly<{ kind: "click"; locator: VisualAgentLocator }>
  | Readonly<{ kind: "type" | "select"; locator: VisualAgentLocator; value: string }>;

export type VisualAgentAuditActionKind =
  | "structured_endpoint"
  | "accessibility_tree"
  | "dom_text"
  | "screenshot"
  | "click"
  | "type"
  | "select";

export type VisualAgentTarget = Readonly<{
  projectId: string;
  runId: string;
  attemptId: string;
  attemptGeneration: number;
  dispatcherGeneration: string;
  attemptExpiresAt: IsoTimestamp;
  processAttemptId: string;
  pid: number;
  processStartToken: string;
  processGroupId: number;
  loopbackHost: "127.0.0.1";
  loopbackPort: number;
  healthPath: string;
  healthyAt: IsoTimestamp;
}>;

export type VisualAgentTurnScope = Readonly<{
  conversationId: string;
  turnId: string;
  immutableUserMessageId: string;
  externalSessionGeneration: number;
  projectId: string;
}>;

export type VisualAgentAuditFactInput = Readonly<{
  id: string;
  capabilityRefDigest: string;
  factKind: "mint" | "consume" | "outcome" | "failure" | "crash_gap";
  conversationId: string;
  turnId: string;
  projectId: string;
  runId: string;
  runAttemptId: string;
  processAttemptId: string;
  attemptGeneration: number;
  processIdentityDigest: string;
  capabilityEpochDigest: string;
  capabilityExpiresAt: IsoTimestamp;
  operationKind: "observe" | "interact";
  actionKind: VisualAgentAuditActionKind;
  locatorKind: VisualAgentLocator["kind"] | null;
  locatorRoleDigest: string | null;
  locatorValueDigest: string | null;
  actionCommitmentDigest: string;
  valueDigest: string | null;
  outcomeCode: string | null;
  createdAt: IsoTimestamp;
}>;

/**
 * Backend-private Store boundary. Implementations must derive the Project from
 * the durable conversation and resolve exactly one healthy visual attempt.
 */
export interface VisualAgentAuthorityStore {
  resolveVisualAgentTurnScope(input: {
    conversationId: string;
    turnId: string;
    externalSessionGeneration: number;
  }): VisualAgentTurnScope;
  currentHealthyVisualAgentTarget(
    projectId: string,
    options?: Readonly<{ now?: IsoTimestamp }>,
  ): VisualAgentTarget;
  recordVisualAgentAuditFact(input: VisualAgentAuditFactInput): void;
}

export type MintVisualAgentCapabilityInput = Readonly<{
  conversationId: string;
  turnId: string;
  externalSessionGeneration: number;
  operation: VisualAgentOperation;
  intentAuthority: "explicit" | "proposal_only";
}>;

declare const consumedVisualAgentCapabilityBrand: unique symbol;
export type ConsumedVisualAgentCapability = Readonly<{
  [consumedVisualAgentCapabilityBrand]: true;
}>;

type Grant = {
  capabilityRefDigest: string;
  scope: VisualAgentTurnScope;
  target: VisualAgentTarget;
  processIdentityDigest: string;
  capabilityEpochDigest: string;
  capabilityExpiresAt: IsoTimestamp;
  operation: VisualAgentOperation;
  operationKind: "observe" | "interact";
  actionCommitmentDigest: string;
  valueDigest: string | null;
  expiresAtMs: number;
  state: "active" | "consumed";
  terminal: boolean;
};

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_GRANTS = 1_024;
const MAX_TTL_MS = 60_000;
const MAX_GRANTS = 4_096;

/**
 * A3-2c1 authority foundation. This registry never launches or attaches to a
 * browser and is intentionally not exposed as an OpenCode tool until A3-2c2.
 */
export class VisualAgentAuthority {
  readonly #store: VisualAgentAuthorityStore;
  readonly #now: () => Date;
  readonly #ttlMs: number;
  readonly #maxGrants: number;
  readonly #epochDigest: string;
  readonly #grants = new Map<string, Grant>();
  readonly #consumedHandles = new WeakMap<ConsumedVisualAgentCapability, Grant>();

  constructor(
    store: VisualAgentAuthorityStore,
    options: Readonly<{
      now?: () => Date;
      ttlMs?: number;
      maxGrants?: number;
      epochSecret?: Uint8Array;
    }> = {},
  ) {
    this.#store = store;
    this.#now = options.now ?? (() => new Date());
    this.#ttlMs = boundedPositiveInteger(
      options.ttlMs ?? DEFAULT_TTL_MS,
      "Visual capability TTL",
      MAX_TTL_MS,
    );
    this.#maxGrants = boundedPositiveInteger(
      options.maxGrants ?? DEFAULT_MAX_GRANTS,
      "Visual capability registry limit",
      MAX_GRANTS,
    );
    const epochSecret = Buffer.from(options.epochSecret ?? randomBytes(32));
    if (epochSecret.byteLength < 16) throw new Error("Visual capability epoch secret is too short.");
    this.#epochDigest = sha256(epochSecret);
  }

  mint(input: MintVisualAgentCapabilityInput): string {
    this.#sweepExpired();
    if (this.#grants.size >= this.#maxGrants) throw denied();
    const operation = normalizeOperation(input.operation);
    const operationKind = isObservation(operation) ? "observe" : "interact";
    if (operationKind === "interact" && input.intentAuthority !== "explicit") throw denied();
    const now = this.#now();
    assertDate(now);
    let scope: VisualAgentTurnScope;
    let target: VisualAgentTarget;
    try {
      scope = this.#store.resolveVisualAgentTurnScope({
        conversationId: input.conversationId,
        turnId: input.turnId,
        externalSessionGeneration: input.externalSessionGeneration,
      });
      target = this.#store.currentHealthyVisualAgentTarget(scope.projectId, {
        now: now.toISOString(),
      });
    } catch {
      throw denied();
    }
    const targetExpiryMs = Date.parse(target.attemptExpiresAt);
    if (!Number.isFinite(targetExpiryMs) || targetExpiryMs <= now.getTime()) throw denied();
    const expiresAtMs = Math.min(now.getTime() + this.#ttlMs, targetExpiryMs);
    const capability = randomBytes(32).toString("base64url");
    const capabilityRefDigest = sha256(capability);
    const processIdentityDigest = digestTarget(target);
    const commitment = operationCommitment(operation);
    const grant: Grant = {
      capabilityRefDigest,
      scope,
      target,
      processIdentityDigest,
      capabilityEpochDigest: this.#epochDigest,
      capabilityExpiresAt: new Date(expiresAtMs).toISOString(),
      operation,
      operationKind,
      actionCommitmentDigest: commitment.digest,
      valueDigest: commitment.valueDigest,
      expiresAtMs,
      state: "active",
      terminal: false,
    };
    try {
      this.#record(grant, "mint", now);
    } catch {
      throw denied();
    }
    this.#grants.set(capability, grant);
    return capability;
  }

  consume(capability: string, requestedOperation: VisualAgentOperation): ConsumedVisualAgentCapability {
    const grant = this.#grants.get(capability);
    if (!grant || grant.state !== "active") throw denied();

    // This transition is deliberately synchronous and precedes every
    // validation that could eventually lead to a browser side effect.
    grant.state = "consumed";
    const now = this.#now();
    assertDate(now);
    try {
      this.#record(grant, "consume", now);
    } catch {
      throw denied();
    }
    try {
      const requested = normalizeOperation(requestedOperation);
      const requestedCommitment = operationCommitment(requested);
      if (!equalDigest(requestedCommitment.digest, grant.actionCommitmentDigest)
        || now.getTime() >= grant.expiresAtMs
        || !equalDigest(this.#epochDigest, grant.capabilityEpochDigest)) {
        throw denied();
      }
      const scope = this.#store.resolveVisualAgentTurnScope({
        conversationId: grant.scope.conversationId,
        turnId: grant.scope.turnId,
        externalSessionGeneration: grant.scope.externalSessionGeneration,
      });
      if (canonicalDigest(scope) !== canonicalDigest(grant.scope)) throw denied();
      const target = this.#store.currentHealthyVisualAgentTarget(scope.projectId, {
        now: now.toISOString(),
      });
      if (!equalDigest(digestTarget(target), grant.processIdentityDigest)) throw denied();
      // The caller receives identity only. Scope, process identity, locator,
      // and typed values remain confined to the registry-owned Grant.
      const consumed = Object.freeze({}) as ConsumedVisualAgentCapability;
      this.#consumedHandles.set(consumed, grant);
      return consumed;
    } catch {
      try {
        this.#terminal(grant, "failure", "capability_denied", now);
      } catch {
        // The capability remains consumed even if durable failure audit cannot
        // be appended. Never expose the underlying Store error.
      }
      throw denied();
    }
  }

  recordOutcome(
    consumed: ConsumedVisualAgentCapability,
    outcome: Readonly<{ status: "succeeded" | "failed"; code: string }>,
  ): void {
    const grant = this.#consumedHandles.get(consumed);
    if (!grant || grant.state !== "consumed" || grant.terminal) throw denied();
    const code = boundedCode(outcome.code);
    try {
      this.#terminal(
        grant,
        outcome.status === "succeeded" ? "outcome" : "failure",
        code,
        this.#now(),
      );
      this.#consumedHandles.delete(consumed);
    } catch {
      throw denied();
    }
  }

  revokeConversation(conversationId: string): void {
    this.#revokeMatching(
      (grant) => grant.scope.conversationId === conversationId,
      "conversation_revoked",
    );
  }

  revokeTurn(conversationId: string, turnId: string): void {
    this.#revokeMatching(
      (grant) => grant.scope.conversationId === conversationId
        && grant.scope.turnId === turnId,
      "turn_released",
    );
  }

  revokeProject(projectId: string): void {
    this.#revokeMatching(
      (grant) => grant.scope.projectId === projectId,
      "project_revoked",
    );
  }

  revokeRun(runId: string): void {
    this.#revokeMatching(
      (grant) => grant.target.runId === runId,
      "run_revoked",
    );
  }

  revokeAll(): void {
    this.#revokeMatching(() => true, "authority_closed");
  }

  #record(grant: Grant, factKind: "mint" | "consume", at: Date): void {
    this.#store.recordVisualAgentAuditFact(auditFact(
      grant,
      factKind,
      this.#epochDigest,
      at,
      null,
    ));
  }

  #terminal(
    grant: Grant,
    factKind: "outcome" | "failure",
    code: string,
    at: Date,
  ): void {
    if (grant.terminal) throw denied();
    assertDate(at);
    this.#store.recordVisualAgentAuditFact(auditFact(
      grant,
      factKind,
      this.#epochDigest,
      at,
      code,
    ));
    grant.terminal = true;
    this.#deleteGrant(grant);
  }

  #sweepExpired(): void {
    const now = this.#now();
    assertDate(now);
    this.#revokeMatching(
      (grant) => grant.expiresAtMs <= now.getTime(),
      "capability_expired",
      now,
    );
  }

  #revokeMatching(
    predicate: (grant: Grant) => boolean,
    code: string,
    now = this.#now(),
  ): void {
    assertDate(now);
    for (const [capability, grant] of this.#grants) {
      if (!predicate(grant)) continue;
      if (!grant.terminal) {
        if (grant.state === "active") {
          grant.state = "consumed";
          try {
            this.#record(grant, "consume", now);
          } catch {
            // A later Store reopen reconciles any durable mint without a
            // terminal fact as a crash gap.
          }
        }
        try {
          this.#terminal(grant, "failure", code, now);
        } catch {
          // Revocation remains effective even when audit storage is unhealthy.
        }
      }
      this.#grants.delete(capability);
    }
  }

  #deleteGrant(grant: Grant): void {
    for (const [capability, candidate] of this.#grants) {
      if (candidate === grant) {
        this.#grants.delete(capability);
        return;
      }
    }
  }
}

export class VisualAgentAuthorityError extends Error {
  readonly code = "visual_capability_denied";

  constructor() {
    super("The scoped visual capability is unavailable.");
    this.name = "VisualAgentAuthorityError";
  }
}

const denied = (): VisualAgentAuthorityError => new VisualAgentAuthorityError();

const normalizeOperation = (operation: VisualAgentOperation): VisualAgentOperation => {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) throw denied();
  if (isObservation(operation)) {
    assertExactKeys(operation, ["kind"]);
    return Object.freeze({ kind: operation.kind });
  }
  if (operation.kind === "click") assertExactKeys(operation, ["kind", "locator"]);
  else assertExactKeys(operation, ["kind", "locator", "value"]);
  const locator = normalizeLocator(operation.locator);
  if (operation.kind === "click") return Object.freeze({ kind: "click", locator });
  if (operation.kind !== "type" && operation.kind !== "select") throw denied();
  if (typeof operation.value !== "string"
    || operation.value.includes("\0")
    || Buffer.byteLength(operation.value, "utf8") > 16_384) throw denied();
  return Object.freeze({ kind: operation.kind, locator, value: operation.value });
};

const isObservation = (
  operation: VisualAgentOperation,
): operation is Extract<VisualAgentOperation, { kind: `observe_${string}` }> =>
  new Set([
    "observe_structured",
    "observe_accessibility",
    "observe_dom_text",
    "observe_screenshot",
  ]).has(operation.kind);

const normalizeLocator = (locator: VisualAgentLocator): VisualAgentLocator => {
  if (!locator || typeof locator !== "object" || Array.isArray(locator)) throw denied();
  if (locator.kind === "role_name") {
    assertExactKeys(locator, ["kind", "role", "name"]);
    if (typeof locator.role !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/u.test(locator.role)) throw denied();
    return Object.freeze({
      kind: "role_name",
      role: locator.role,
      name: boundedNfc(locator.name, 512),
    });
  }
  if (locator.kind === "label") {
    assertExactKeys(locator, ["kind", "label"]);
    return Object.freeze({ kind: "label", label: boundedNfc(locator.label, 512) });
  }
  throw denied();
};

const boundedNfc = (value: unknown, maximumBytes: number): string => {
  if (typeof value !== "string" || value.includes("\0")) throw denied();
  const normalized = value.normalize("NFC");
  if (!normalized || Buffer.byteLength(normalized, "utf8") > maximumBytes) throw denied();
  return normalized;
};

const operationCommitment = (
  operation: VisualAgentOperation,
): Readonly<{ digest: string; valueDigest: string | null }> => {
  const valueDigest = "value" in operation ? sha256(operation.value) : null;
  const committed = "value" in operation
    ? { kind: operation.kind, locator: operation.locator, valueDigest }
    : operation;
  return Object.freeze({ digest: canonicalDigest(committed), valueDigest });
};

const digestTarget = (target: VisualAgentTarget): string => canonicalDigest({
  projectId: target.projectId,
  runId: target.runId,
  attemptId: target.attemptId,
  attemptGeneration: target.attemptGeneration,
  dispatcherGeneration: target.dispatcherGeneration,
  attemptExpiresAt: target.attemptExpiresAt,
  processAttemptId: target.processAttemptId,
  pid: target.pid,
  processStartToken: target.processStartToken,
  processGroupId: target.processGroupId,
  loopbackHost: target.loopbackHost,
  loopbackPort: target.loopbackPort,
  healthPath: target.healthPath,
  healthyAt: target.healthyAt,
});

const auditFact = (
  grant: Grant,
  factKind: VisualAgentAuditFactInput["factKind"],
  epochDigest: string,
  at: Date,
  outcomeCode: string | null,
): VisualAgentAuditFactInput => {
  const locator = "locator" in grant.operation ? grant.operation.locator : null;
  const locatorRole = locator?.kind === "role_name" ? locator.role : null;
  const locatorValue = locator?.kind === "role_name"
    ? locator.name
    : locator?.kind === "label"
      ? locator.label
      : null;
  return Object.freeze({
    id: `visualaudit_${randomUUID().replaceAll("-", "")}`,
    capabilityRefDigest: grant.capabilityRefDigest,
    factKind,
    conversationId: grant.scope.conversationId,
    turnId: grant.scope.turnId,
    projectId: grant.scope.projectId,
    runId: grant.target.runId,
    runAttemptId: grant.target.attemptId,
    processAttemptId: grant.target.processAttemptId,
    attemptGeneration: grant.target.attemptGeneration,
    processIdentityDigest: grant.processIdentityDigest,
    capabilityEpochDigest: epochDigest,
    capabilityExpiresAt: grant.capabilityExpiresAt,
    operationKind: grant.operationKind,
    actionKind: auditActionKind(grant.operation.kind),
    locatorKind: locator?.kind ?? null,
    locatorRoleDigest: locatorRole === null ? null : sha256(locatorRole),
    locatorValueDigest: locatorValue === null ? null : sha256(locatorValue),
    actionCommitmentDigest: grant.actionCommitmentDigest,
    valueDigest: grant.valueDigest,
    outcomeCode,
    createdAt: at.toISOString(),
  });
};

const boundedCode = (value: string): string => {
  if (!/^[a-z0-9][a-z0-9_]{0,79}$/u.test(value)) throw denied();
  return value;
};

const auditActionKind = (kind: VisualAgentOperation["kind"]): VisualAgentAuditActionKind => {
  switch (kind) {
    case "observe_structured": return "structured_endpoint";
    case "observe_accessibility": return "accessibility_tree";
    case "observe_dom_text": return "dom_text";
    case "observe_screenshot": return "screenshot";
    case "click":
    case "type":
    case "select":
      return kind;
  }
};

const boundedPositiveInteger = (value: number, label: string, maximum: number): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
};

const assertDate = (value: Date): void => {
  if (!Number.isFinite(value.getTime())) throw new Error("Visual authority clock is invalid.");
};

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const equalDigest = (left: string, right: string): boolean => {
  if (!/^[0-9a-f]{64}$/u.test(left) || !/^[0-9a-f]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
};

const assertExactKeys = (value: object, allowed: readonly string[]): void => {
  const expected = new Set(allowed);
  if (Object.keys(value).length !== expected.size
    || Object.keys(value).some((key) => !expected.has(key))) throw denied();
};

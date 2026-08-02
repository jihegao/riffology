import { createHash, randomBytes } from "node:crypto";
import { canonicalJsonV2 } from "./canonical-json-v2.ts";
import type { OpenCodeWorkspaceBinding } from "./opencode-adapter.ts";
import {
  BROWSER_AGENT_ACTION_BUDGET,
  BROWSER_AGENT_GRANT_TTL_MS,
  browserAgentOperationCommitment,
  type BrowserAgentToolName,
} from "./browser-agent-tools.ts";
import {
  LocalBrowserBroker,
  LocalBrowserBrokerError,
  type BrowserConversationScope,
  type RiffBrowserAlias,
} from "./local-browser-broker.ts";

type BrowserTurnGrant = {
  scope: BrowserConversationScope;
  turnId: string;
  workspaceDigest: string;
  target: RiffBrowserAlias | null;
  operations: ReadonlySet<BrowserAgentToolName>;
  remainingBudget: number;
  expiresAtMs: number;
  state: "dormant" | "active" | "revoked";
  controlEpoch: number | null;
  approvedCommitments: Set<string>;
  pending: Map<string, BrowserPendingPermission>;
};

type BrowserPendingPermission = {
  id: string;
  key: string;
  tool: BrowserAgentToolName;
  targetSummary: string;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: BrowserAgentAuthorityError) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type BrowserPendingPermissionDto = Readonly<{
  id: string;
  tool: BrowserAgentToolName;
  targetSummary: string;
  remainingBudget: number;
  expiresAtMs: number;
}>;

export class BrowserAgentAuthority {
  readonly #broker: LocalBrowserBroker;
  readonly #now: () => number;
  readonly #grants = new Map<string, BrowserTurnGrant>();

  constructor(broker: LocalBrowserBroker, options: { now?: () => number } = {}) {
    this.#broker = broker;
    this.#now = options.now ?? Date.now;
  }

  async prepareDormant(input: Readonly<{
    scope: BrowserConversationScope;
    turnId: string;
    workspace: OpenCodeWorkspaceBinding;
    target?: RiffBrowserAlias;
    operations: ReadonlySet<BrowserAgentToolName>;
    budget?: number;
    ttlMs?: number;
  }>): Promise<void> {
    if (!input.turnId || !input.operations.size) {
      throw new BrowserAgentAuthorityError("browser_grant_invalid");
    }
    const key = grantKey(input.scope.conversationId, input.turnId);
    for (const [candidateKey, candidate] of this.#grants) {
      if (candidateKey !== key
        && candidate.scope.conversationId === input.scope.conversationId
        && candidate.state !== "revoked") {
        throw new BrowserAgentAuthorityError("browser_control_conflict");
      }
    }
    const prior = this.#grants.get(key);
    if (prior) await this.#revoke(prior);
    this.#grants.set(key, {
      scope: Object.freeze({ ...input.scope }),
      turnId: input.turnId,
      workspaceDigest: workspaceDigest(input.workspace),
      target: input.target ?? null,
      operations: new Set(input.operations),
      remainingBudget: input.budget ?? BROWSER_AGENT_ACTION_BUDGET,
      expiresAtMs: this.#now() + (input.ttlMs ?? BROWSER_AGENT_GRANT_TTL_MS),
      state: "dormant",
      controlEpoch: null,
      approvedCommitments: new Set(),
      pending: new Map(),
    });
  }

  async pendingForTurn(
    conversationId: string,
    turnId: string,
  ): Promise<readonly BrowserPendingPermissionDto[]> {
    const grant = this.#grants.get(grantKey(conversationId, turnId));
    if (!grant || grant.state === "revoked") return [];
    if (grant.expiresAtMs <= this.#now()) {
      await this.#revoke(grant, "browser_grant_expired");
      return [];
    }
    return Object.freeze([...grant.pending.values()].map((pending) => Object.freeze({
      id: pending.id,
      tool: pending.tool,
      targetSummary: pending.targetSummary,
      remainingBudget: grant.remainingBudget,
      expiresAtMs: grant.expiresAtMs,
    })));
  }

  async approvePending(input: Readonly<{
    id: string;
    conversationId: string;
    turnId: string;
    externalSessionGeneration: number;
    workspace: OpenCodeWorkspaceBinding;
  }>): Promise<void> {
    const grant = await this.#activeRecord(input.conversationId, input.turnId, false);
    const pending = [...grant.pending.values()].find((candidate) => candidate.id === input.id);
    if (!pending) throw new BrowserAgentAuthorityError("browser_permission_unavailable");
    await this.activatePermission({
      conversationId: input.conversationId,
      turnId: input.turnId,
      externalSessionGeneration: input.externalSessionGeneration,
      workspace: input.workspace,
      tool: pending.tool,
      operationCommitment: pending.key.slice(pending.tool.length + 1),
    });
  }

  async rejectPending(input: Readonly<{
    id: string;
    conversationId: string;
    turnId: string;
  }>): Promise<void> {
    const grant = await this.#activeRecord(input.conversationId, input.turnId, false);
    if (![...grant.pending.values()].some((candidate) => candidate.id === input.id)) {
      throw new BrowserAgentAuthorityError("browser_permission_unavailable");
    }
    await this.#revoke(grant, "browser_permission_rejected");
  }

  /**
   * Called under AgentWorkspaceService turn control before OpenCode receives
   * allow-once. Activation stores only the normalized input digest.
   */
  async activatePermission(input: Readonly<{
    conversationId: string;
    turnId: string;
    externalSessionGeneration: number;
    workspace: OpenCodeWorkspaceBinding;
    tool: BrowserAgentToolName;
    operationCommitment: string;
  }>): Promise<void> {
    const grant = await this.#activeRecord(input.conversationId, input.turnId, false);
    if (grant.scope.conversationGeneration !== input.externalSessionGeneration
      || grant.workspaceDigest !== workspaceDigest(input.workspace)
      || !grant.operations.has(input.tool)
      || !/^[0-9a-f]{64}$/u.test(input.operationCommitment)) {
      await this.#revoke(grant);
      throw new BrowserAgentAuthorityError("browser_grant_scope_mismatch");
    }
    grant.approvedCommitments.add(`${input.tool}:${input.operationCommitment}`);
    if (grant.state === "dormant") {
      grant.state = "active";
      if (input.tool !== "browser_open") {
        try {
          const lease = await this.#broker.claimAgent(grant.scope, grant.remainingBudget);
          this.#assertCurrent(grant);
          grant.controlEpoch = lease.controlEpoch;
        }
        catch (error) {
          await this.#revoke(grant);
          throw authorityError(error);
        }
      }
    }
    const pending = grant.pending.get(`${input.tool}:${input.operationCommitment}`);
    if (pending) {
      grant.pending.delete(pending.key);
      clearTimeout(pending.timer);
      pending.resolve();
    }
  }

  async execute(input: Readonly<{
    conversationId: string;
    turnId: string;
    externalSessionGeneration: number;
    tool: BrowserAgentToolName;
    arguments: Readonly<Record<string, unknown>>;
  }>): Promise<unknown> {
    const grant = await this.#activeRecord(input.conversationId, input.turnId, false);
    const committed = browserAgentOperationCommitment(input.tool, input.arguments);
    const approval = `${input.tool}:${committed.digest}`;
    if (grant.scope.conversationGeneration !== input.externalSessionGeneration
      || !grant.operations.has(input.tool)) {
      throw new BrowserAgentAuthorityError("browser_operation_not_authorized");
    }
    if (!grant.approvedCommitments.has(approval)) {
      if ([...grant.approvedCommitments].some((candidate) =>
        candidate.startsWith(`${input.tool}:`))) {
        throw new BrowserAgentAuthorityError("browser_operation_not_authorized");
      }
      await this.#awaitPending(grant, input.tool, approval, committed.normalized);
    }
    this.#assertCurrent(grant);
    if (!grant.approvedCommitments.delete(approval)) {
      throw new BrowserAgentAuthorityError("browser_operation_not_authorized");
    }
    if (grant.remainingBudget <= 0) {
      await this.#revoke(grant);
      throw new BrowserAgentAuthorityError("browser_budget_exhausted");
    }
    // Consume before the first await so concurrent calls cannot overspend.
    grant.remainingBudget -= 1;
    let budgetProjected = false;
    try {
      let result: unknown;
      switch (input.tool) {
        case "browser_open": {
          const requested = String(committed.normalized.alias) as RiffBrowserAlias;
          if (grant.target !== null && requested !== grant.target) {
            throw new BrowserAgentAuthorityError("browser_target_not_authorized");
          }
          // First approved open atomically fixes this turn's target alias.
          grant.target = requested;
          try {
            await this.#broker.open(grant.scope, requested);
            this.#assertCurrent(grant);
            const lease = await this.#broker.claimAgent(grant.scope, grant.remainingBudget);
            this.#assertCurrent(grant);
            grant.controlEpoch = lease.controlEpoch;
            result = lease.state;
          } catch (error) {
            await this.#revoke(grant);
            throw error;
          }
          break;
        }
        case "browser_snapshot": {
          const state = await this.#broker.state(grant.scope);
          this.#assertCurrent(grant);
          result = await this.#broker.agentSnapshot(
            grant.scope,
            state.pageGeneration,
            requiredControlEpoch(grant),
          );
          this.#assertCurrent(grant);
          break;
        }
        case "browser_screenshot": {
          const state = await this.#broker.state(grant.scope);
          this.#assertCurrent(grant);
          result = await this.#broker.agentScreenshot(
            grant.scope,
            state.pageGeneration,
            requiredControlEpoch(grant),
          );
          this.#assertCurrent(grant);
          break;
        }
        case "browser_click": {
          const state = await this.#broker.state(grant.scope);
          this.#assertCurrent(grant);
          result = await this.#broker.agentClick(
            grant.scope,
            state.pageGeneration,
            requiredControlEpoch(grant),
            String(committed.normalized.ref),
          );
          this.#assertCurrent(grant);
          break;
        }
        case "browser_type": {
          const state = await this.#broker.state(grant.scope);
          this.#assertCurrent(grant);
          result = await this.#broker.agentType(
            grant.scope,
            state.pageGeneration,
            requiredControlEpoch(grant),
            String(committed.normalized.ref),
            String(committed.normalized.text),
          );
          this.#assertCurrent(grant);
          break;
        }
        case "browser_scroll": {
          const state = await this.#broker.state(grant.scope);
          this.#assertCurrent(grant);
          result = await this.#broker.agentScroll(
            grant.scope,
            state.pageGeneration,
            requiredControlEpoch(grant),
            Number(committed.normalized.deltaY),
          );
          this.#assertCurrent(grant);
          break;
        }
        case "browser_wait": {
          const state = await this.#broker.state(grant.scope);
          this.#assertCurrent(grant);
          result = await this.#broker.agentWait(
            grant.scope,
            state.pageGeneration,
            requiredControlEpoch(grant),
            Number(committed.normalized.milliseconds),
          );
          this.#assertCurrent(grant);
          break;
        }
        case "browser_back": {
          const state = await this.#broker.state(grant.scope);
          this.#assertCurrent(grant);
          result = await this.#broker.agentBack(
            grant.scope,
            state.pageGeneration,
            requiredControlEpoch(grant),
          );
          this.#assertCurrent(grant);
          break;
        }
        case "browser_reload": {
          const state = await this.#broker.state(grant.scope);
          this.#assertCurrent(grant);
          result = await this.#broker.agentReload(
            grant.scope,
            state.pageGeneration,
            requiredControlEpoch(grant),
          );
          this.#assertCurrent(grant);
          break;
        }
        case "browser_close": {
          const state = await this.#broker.state(grant.scope);
          this.#assertCurrent(grant);
          result = await this.#broker.agentClose(
            grant.scope,
            state.pageGeneration,
            requiredControlEpoch(grant),
          );
          this.#assertCurrent(grant);
          await this.#revoke(grant);
          return result;
        }
        default:
          throw new BrowserAgentAuthorityError("browser_operation_unavailable");
      }
      if (grant.remainingBudget > 0) {
        await this.#broker.updateAgentBudget(
          grant.scope,
          requiredControlEpoch(grant),
          grant.remainingBudget,
        );
        this.#assertCurrent(grant);
        budgetProjected = true;
      }
      return result;
    } catch (error) {
      if (error instanceof BrowserAgentAuthorityError) throw error;
      const mapped = authorityError(error);
      if (CONTROL_LOSS_CODES.has(mapped.code)) await this.#revoke(grant);
      throw mapped;
    } finally {
      if (grant.remainingBudget <= 0) {
        await this.#revoke(grant);
      } else if (!budgetProjected && grant.state === "active" && grant.controlEpoch !== null) {
        // Failed actions still consume their exact committed budget. Projection
        // is best-effort and must never replace the original action error.
        await this.#broker.updateAgentBudget(
          grant.scope,
          grant.controlEpoch,
          grant.remainingBudget,
        ).catch(() => undefined);
      }
    }
  }

  async revokeTurn(conversationId: string, turnId: string): Promise<void> {
    const grant = this.#grants.get(grantKey(conversationId, turnId));
    if (grant) await this.#revoke(grant);
  }

  async revokeConversation(conversationId: string): Promise<void> {
    await Promise.allSettled([...this.#grants.values()]
      .filter((grant) => grant.scope.conversationId === conversationId)
      .map((grant) => this.#revoke(grant)));
  }

  async takeoverConversation(
    scope: BrowserConversationScope,
    expectedPageGeneration: number,
  ): Promise<unknown> {
    // Revoke the private grants synchronously, then let takeHuman invalidate
    // the Broker epoch and close the context before joining its action tail.
    for (const grant of this.#grants.values()) {
      if (grant.scope.conversationId !== scope.conversationId) continue;
      grant.state = "revoked";
      grant.approvedCommitments.clear();
      for (const pending of grant.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new BrowserAgentAuthorityError("browser_grant_unavailable"));
      }
      grant.pending.clear();
      this.#grants.delete(grantKey(grant.scope.conversationId, grant.turnId));
    }
    return this.#broker.takeHuman(scope, expectedPageGeneration);
  }

  async returnConversationToObserver(
    scope: BrowserConversationScope,
    expectedPageGeneration: number,
  ): Promise<unknown> {
    return this.#broker.returnObserver(scope, expectedPageGeneration);
  }

  async revokeAll(): Promise<void> {
    await Promise.allSettled([...this.#grants.values()].map((grant) => this.#revoke(grant)));
  }

  async #awaitPending(
    grant: BrowserTurnGrant,
    tool: BrowserAgentToolName,
    key: string,
    normalized: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const existing = grant.pending.get(key);
    if (existing) {
      await existing.promise;
      return;
    }
    let resolve!: () => void;
    let reject!: (error: BrowserAgentAuthorityError) => void;
    const promise = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const remainingMs = Math.max(1, grant.expiresAtMs - this.#now());
    const pending: BrowserPendingPermission = {
      id: `browser_permission_${randomBytes(16).toString("hex")}`,
      key,
      tool,
      targetSummary: tool === "browser_open"
        ? `alias ${String(normalized.alias)}`
        : grant.target ? `alias ${grant.target}` : "active Riff browser target",
      promise,
      resolve,
      reject,
      timer: setTimeout(() => {
        void this.#revoke(grant, "browser_grant_expired");
      }, remainingMs),
    };
    grant.pending.set(key, pending);
    await promise;
  }

  async #revoke(
    grant: BrowserTurnGrant,
    reason = "browser_grant_unavailable",
  ): Promise<void> {
    grant.state = "revoked";
    grant.approvedCommitments.clear();
    this.#grants.delete(grantKey(grant.scope.conversationId, grant.turnId));
    for (const pending of grant.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new BrowserAgentAuthorityError(reason));
    }
    grant.pending.clear();
    await this.#broker.releaseAgent(grant.scope).catch(() => undefined);
  }

  async #activeRecord(
    conversationId: string,
    turnId: string,
    requireActive: boolean,
  ): Promise<BrowserTurnGrant> {
    const grant = this.#grants.get(grantKey(conversationId, turnId));
    if (!grant || grant.state === "revoked" || requireActive && grant.state !== "active") {
      throw new BrowserAgentAuthorityError("browser_grant_unavailable");
    }
    if (grant.expiresAtMs <= this.#now()) {
      await this.#revoke(grant, "browser_grant_expired");
      throw new BrowserAgentAuthorityError("browser_grant_expired");
    }
    return grant;
  }

  #assertCurrent(grant: BrowserTurnGrant): void {
    if (grant.state !== "active"
      || this.#grants.get(grantKey(grant.scope.conversationId, grant.turnId)) !== grant
      || grant.expiresAtMs <= this.#now()) {
      throw new BrowserAgentAuthorityError("browser_grant_stale");
    }
  }
}

export class BrowserAgentAuthorityError extends Error {
  readonly code: string;
  constructor(code: string) {
    super("The scoped Browser Agent operation was denied.");
    this.name = "BrowserAgentAuthorityError";
    this.code = code;
  }
}

const grantKey = (conversationId: string, turnId: string): string =>
  `${conversationId}\u0000${turnId}`;

const workspaceDigest = (workspace: OpenCodeWorkspaceBinding): string =>
  createHash("sha256").update(canonicalJsonV2({
    owner: workspace.owner,
    directory: workspace.directory,
  })).digest("hex");

const authorityError = (error: unknown): BrowserAgentAuthorityError =>
  new BrowserAgentAuthorityError(
    error instanceof LocalBrowserBrokerError ? error.code : "browser_operation_failed",
  );

const requiredControlEpoch = (grant: BrowserTurnGrant): number => {
  if (grant.controlEpoch === null) {
    throw new BrowserAgentAuthorityError("browser_control_stale");
  }
  return grant.controlEpoch;
};

const CONTROL_LOSS_CODES = new Set([
  "browser_session_disconnected",
  "browser_session_missing",
  "browser_session_closed",
  "browser_broker_unavailable",
  "browser_control_stale",
  "browser_agent_control_denied",
  "browser_human_controlled",
]);

import assert from "node:assert/strict";
import test from "node:test";
import {
  VisualAgentAuthority,
  VisualAgentAuthorityError,
  type VisualAgentAuditFactInput,
  type VisualAgentAuthorityStore,
  type VisualAgentOperation,
  type VisualAgentTarget,
  type VisualAgentTurnScope,
} from "../src/agent-visual-authority.ts";

const NOW = new Date("2026-07-25T17:00:00.000Z");
const SCOPE: VisualAgentTurnScope = Object.freeze({
  conversationId: "conversation_visual",
  turnId: "turn_visual",
  immutableUserMessageId: "message_visual",
  externalSessionGeneration: 3,
  projectId: "project_visual",
});
const TARGET: VisualAgentTarget = Object.freeze({
  projectId: "project_visual",
  runId: "run_visual",
  attemptId: "attempt_visual",
  attemptGeneration: 2,
  dispatcherGeneration: "a".repeat(64),
  attemptExpiresAt: "2026-07-25T17:01:00.000Z",
  processAttemptId: "process_visual",
  pid: 9_001,
  processStartToken: "secret-process-start-token",
  processGroupId: 9_001,
  loopbackHost: "127.0.0.1",
  loopbackPort: 41_237,
  entryPath: "/",
  healthPath: "/healthz",
  healthyAt: "2026-07-25T16:59:59.000Z",
});

class FakeStore implements VisualAgentAuthorityStore {
  scope = SCOPE;
  target = TARGET;
  readonly facts: VisualAgentAuditFactInput[] = [];
  failFactKind: VisualAgentAuditFactInput["factKind"] | null = null;
  resolveScopeCalls = 0;
  resolveTargetCalls = 0;

  resolveVisualAgentTurnScope(input: {
    conversationId: string;
    turnId: string;
    externalSessionGeneration: number;
  }): VisualAgentTurnScope {
    this.resolveScopeCalls += 1;
    if (input.conversationId !== this.scope.conversationId
      || input.turnId !== this.scope.turnId
      || input.externalSessionGeneration !== this.scope.externalSessionGeneration) {
      throw new Error("unavailable");
    }
    return this.scope;
  }

  currentHealthyVisualAgentTarget(projectId: string): VisualAgentTarget {
    this.resolveTargetCalls += 1;
    if (projectId !== this.target.projectId) throw new Error("unavailable");
    return this.target;
  }

  recordVisualAgentAuditFact(input: VisualAgentAuditFactInput): void {
    if (input.factKind === this.failFactKind) throw new Error("audit unavailable");
    this.facts.push(input);
  }
}

const authority = (
  store: FakeStore,
  now: () => Date = () => NOW,
): VisualAgentAuthority => new VisualAgentAuthority(store, {
  now,
  ttlMs: 30_000,
  epochSecret: Buffer.alloc(32, 7),
});

test("visual authority mints, atomically consumes, and records only secret-free immutable facts", () => {
  const store = new FakeStore();
  const registry = authority(store);
  const operation = { kind: "observe_accessibility" } as const;
  const capability = registry.mint({
    conversationId: SCOPE.conversationId,
    turnId: SCOPE.turnId,
    externalSessionGeneration: SCOPE.externalSessionGeneration,
    operation,
    intentAuthority: "proposal_only",
  });
  assert.ok(!JSON.stringify(store.facts).includes(capability));
  const consumed = registry.consume(capability, operation);
  assert.deepEqual(Object.keys(consumed), []);
  assert.equal(JSON.stringify(consumed), "{}");
  registry.recordOutcome(consumed, {
    status: "succeeded",
    code: "observation_succeeded",
  });
  assert.deepEqual(store.facts.map((fact) => fact.factKind), [
    "mint",
    "consume",
    "outcome",
  ]);
  const persisted = JSON.stringify(store.facts);
  for (const secret of [
    TARGET.processStartToken,
    TARGET.healthPath,
    capability,
  ]) assert.equal(persisted.includes(secret), false);
  for (const fact of store.facts) {
    for (const forbiddenKey of [
      "pid",
      "processStartToken",
      "processGroupId",
      "loopbackPort",
      "healthPath",
      "capability",
    ]) assert.equal(Object.hasOwn(fact, forbiddenKey), false);
  }
  assert.equal(store.facts[0]?.actionKind, "accessibility_tree");
  assert.equal(Object.hasOwn(store.facts[2]!, "redactedSummary"), false);
  assert.throws(() => registry.consume(capability, operation), VisualAgentAuthorityError);
});

test("visual authority privately resolves and executes one bounded observation", async () => {
  const store = new FakeStore();
  store.target = Object.freeze({
    ...TARGET,
    structuredInspectionPath: "/inspection",
  });
  const seen: unknown[] = [];
  const registry = new VisualAgentAuthority(store, {
    now: () => NOW,
    ttlMs: 30_000,
    epochSecret: Buffer.alloc(32, 7),
    observer: {
      async observe(input) {
        seen.push(input);
        return Object.freeze({
          schemaVersion: 1,
          kind: "observe_structured",
          untrusted: true,
          contentType: "application/json",
          value: { status: "ok" },
        });
      },
    },
  });
  assert.equal(registry.observationAvailable, true);
  const result = await registry.observe({
    conversationId: SCOPE.conversationId,
    turnId: SCOPE.turnId,
    externalSessionGeneration: SCOPE.externalSessionGeneration,
    operation: { kind: "observe_structured" },
    intentAuthority: "proposal_only",
  });
  assert.deepEqual(result, {
    schemaVersion: 1,
    kind: "observe_structured",
    untrusted: true,
    contentType: "application/json",
    value: { status: "ok" },
  });
  const observerInput = seen[0] as Record<string, unknown>;
  assert.deepEqual(Object.keys(observerInput).sort(), ["kind", "signal", "target"]);
  assert.deepEqual(observerInput.target, {
    runId: TARGET.runId,
    processAttemptId: TARGET.processAttemptId,
    pid: TARGET.pid,
    processStartToken: TARGET.processStartToken,
    processGroupId: TARGET.processGroupId,
    loopbackHost: "127.0.0.1",
    loopbackPort: TARGET.loopbackPort,
    structuredInspectionPath: "/inspection",
  });
  for (const forbidden of [
    "projectId",
    "attemptId",
    "healthPath",
    "capability",
  ]) {
    assert.equal(JSON.stringify(observerInput).includes(forbidden), false);
  }
  assert.deepEqual(store.facts.map((fact) => fact.factKind), [
    "mint",
    "consume",
    "outcome",
  ]);
});

test("run revocation aborts an in-flight observation before it can return", async () => {
  const store = new FakeStore();
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => { started = resolve; });
  const registry = new VisualAgentAuthority(store, {
    now: () => NOW,
    ttlMs: 30_000,
    epochSecret: Buffer.alloc(32, 7),
    observer: {
      async observe({ signal }) {
        started();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
        throw new Error("unreachable");
      },
    },
  });
  const pending = registry.observe({
    conversationId: SCOPE.conversationId,
    turnId: SCOPE.turnId,
    externalSessionGeneration: SCOPE.externalSessionGeneration,
    operation: { kind: "observe_dom_text" },
    intentAuthority: "proposal_only",
  });
  await didStart;
  registry.revokeRun(TARGET.runId);
  await assert.rejects(pending, VisualAgentAuthorityError);
  assert.deepEqual(store.facts.map((fact) => fact.factKind), [
    "mint",
    "consume",
    "failure",
  ]);
  assert.equal(store.facts.at(-1)?.outcomeCode, "run_revoked");
});

test("in-flight scope drift aborts observation and per-conversation concurrency fails closed", async () => {
  const store = new FakeStore();
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => { started = resolve; });
  const registry = new VisualAgentAuthority(store, {
    now: () => NOW,
    ttlMs: 30_000,
    epochSecret: Buffer.alloc(32, 7),
    observer: {
      async observe({ signal }) {
        started();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
        throw new Error("unreachable");
      },
    },
  });
  const input = {
    conversationId: SCOPE.conversationId,
    turnId: SCOPE.turnId,
    externalSessionGeneration: SCOPE.externalSessionGeneration,
    operation: { kind: "observe_accessibility" },
    intentAuthority: "proposal_only",
  } as const;
  const pending = registry.observe(input);
  await didStart;
  await assert.rejects(registry.observe(input), VisualAgentAuthorityError);
  store.scope = Object.freeze({
    ...SCOPE,
    externalSessionGeneration: SCOPE.externalSessionGeneration + 1,
  });
  await assert.rejects(pending, VisualAgentAuthorityError);
  assert.equal(
    store.facts.filter((fact) => fact.factKind === "mint").length,
    1,
  );
  assert.equal(store.facts.at(-1)?.outcomeCode, "observation_aborted");
});

test("only the exact registry-issued consumed handle can append a terminal fact", () => {
  const store = new FakeStore();
  const registry = authority(store);
  const operation = { kind: "observe_accessibility" } as const;
  const capability = registry.mint({
    conversationId: SCOPE.conversationId,
    turnId: SCOPE.turnId,
    externalSessionGeneration: SCOPE.externalSessionGeneration,
    operation,
    intentAuthority: "proposal_only",
  });
  const consumed = registry.consume(capability, operation);
  const forged = Object.freeze({ ...consumed });
  assert.throws(
    () => registry.recordOutcome(forged, {
      status: "succeeded",
      code: "forged_outcome",
    }),
    VisualAgentAuthorityError,
  );
  assert.deepEqual(store.facts.map((fact) => fact.factKind), ["mint", "consume"]);
  registry.recordOutcome(consumed, {
    status: "succeeded",
    code: "observation_succeeded",
  });
  assert.deepEqual(store.facts.map((fact) => fact.factKind), ["mint", "consume", "outcome"]);
});

test("terminal capabilities release registry capacity", () => {
  const store = new FakeStore();
  const registry = new VisualAgentAuthority(store, {
    now: () => NOW,
    ttlMs: 30_000,
    maxGrants: 2,
    epochSecret: Buffer.alloc(32, 7),
  });
  const operation = { kind: "observe_structured" } as const;
  for (let index = 0; index < 3; index += 1) {
    const capability = registry.mint({
      conversationId: SCOPE.conversationId,
      turnId: SCOPE.turnId,
      externalSessionGeneration: SCOPE.externalSessionGeneration,
      operation,
      intentAuthority: "proposal_only",
    });
    const consumed = registry.consume(capability, operation);
    registry.recordOutcome(consumed, {
      status: "succeeded",
      code: "observation_succeeded",
    });
  }
  assert.equal(store.facts.filter((fact) => fact.factKind === "outcome").length, 3);
});

test("mint audit failure denies without returning a capability", () => {
  const store = new FakeStore();
  store.failFactKind = "mint";
  const registry = authority(store);
  assert.throws(() => registry.mint({
    conversationId: SCOPE.conversationId,
    turnId: SCOPE.turnId,
    externalSessionGeneration: SCOPE.externalSessionGeneration,
    operation: { kind: "observe_structured" },
    intentAuthority: "proposal_only",
  }), VisualAgentAuthorityError);
  assert.deepEqual(store.facts, []);
});

test("consume audit failure denies before revalidation and permanently consumes the token", () => {
  const store = new FakeStore();
  const registry = authority(store);
  const operation = { kind: "observe_structured" } as const;
  const capability = registry.mint({
    conversationId: SCOPE.conversationId,
    turnId: SCOPE.turnId,
    externalSessionGeneration: SCOPE.externalSessionGeneration,
    operation,
    intentAuthority: "proposal_only",
  });
  assert.equal(store.resolveScopeCalls, 1);
  assert.equal(store.resolveTargetCalls, 1);
  store.failFactKind = "consume";
  assert.throws(() => registry.consume(capability, operation), VisualAgentAuthorityError);
  // The durable consume boundary precedes every target/scope revalidation and
  // the in-memory state must remain consumed even if that append fails.
  assert.equal(store.resolveScopeCalls, 1);
  assert.equal(store.resolveTargetCalls, 1);
  assert.deepEqual(store.facts.map((fact) => fact.factKind), ["mint"]);
  store.failFactKind = null;
  assert.throws(() => registry.consume(capability, operation), VisualAgentAuthorityError);
  assert.equal(store.resolveScopeCalls, 1);
  assert.equal(store.resolveTargetCalls, 1);
});

test("terminal audit failure does not report success or accept a forged completion handle", () => {
  const store = new FakeStore();
  const registry = authority(store);
  const operation = { kind: "observe_screenshot" } as const;
  const capability = registry.mint({
    conversationId: SCOPE.conversationId,
    turnId: SCOPE.turnId,
    externalSessionGeneration: SCOPE.externalSessionGeneration,
    operation,
    intentAuthority: "proposal_only",
  });
  const consumed = registry.consume(capability, operation);
  store.failFactKind = "outcome";
  assert.throws(() => registry.recordOutcome(consumed, {
    status: "succeeded",
    code: "observation_succeeded",
  }), VisualAgentAuthorityError);
  assert.deepEqual(store.facts.map((fact) => fact.factKind), ["mint", "consume"]);
  store.failFactKind = null;
  const forged = Object.freeze({ ...consumed });
  assert.throws(() => registry.recordOutcome(forged, {
    status: "succeeded",
    code: "forged_outcome",
  }), VisualAgentAuthorityError);
  assert.deepEqual(store.facts.map((fact) => fact.factKind), ["mint", "consume"]);
});

test("same token synchronous double consume admits exactly one caller", () => {
  const store = new FakeStore();
  const registry = authority(store);
  const operation = { kind: "observe_dom_text" } as const;
  const capability = registry.mint({
    conversationId: SCOPE.conversationId,
    turnId: SCOPE.turnId,
    externalSessionGeneration: SCOPE.externalSessionGeneration,
    operation,
    intentAuthority: "proposal_only",
  });
  const results = [
    () => registry.consume(capability, operation),
    () => registry.consume(capability, operation),
  ].map((attempt) => {
    try { return { ok: true, value: attempt() }; }
    catch (error) { return { ok: false, error }; }
  });
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => !result.ok).length, 1);
  assert.ok(results.find((result) => !result.ok)?.error instanceof VisualAgentAuthorityError);
  assert.deepEqual(store.facts.map((fact) => fact.factKind), ["mint", "consume"]);
});

test("interaction authority requires explicit intent and binds action, locator, and value digest", async (context) => {
  const base = {
    kind: "type",
    locator: { kind: "role_name", role: "textbox", name: "Crew count" },
    value: "3",
  } as const;
  await context.test("proposal-only interaction is denied before mint", () => {
    const store = new FakeStore();
    assert.throws(() => authority(store).mint({
      conversationId: SCOPE.conversationId,
      turnId: SCOPE.turnId,
      externalSessionGeneration: SCOPE.externalSessionGeneration,
      operation: base,
      intentAuthority: "proposal_only",
    }), VisualAgentAuthorityError);
    assert.equal(store.facts.length, 0);
  });
  await context.test("raw locator and typed value never enter the durable audit", () => {
    const store = new FakeStore();
    const registry = authority(store);
    const secretLocator = "customer-token-canary";
    const secretValue = "typed-secret-canary";
    const operation = {
      kind: "type",
      locator: { kind: "label", label: secretLocator },
      value: secretValue,
    } as const;
    const capability = registry.mint({
      conversationId: SCOPE.conversationId,
      turnId: SCOPE.turnId,
      externalSessionGeneration: SCOPE.externalSessionGeneration,
      operation,
      intentAuthority: "explicit",
    });
    const consumed = registry.consume(capability, operation);
    registry.recordOutcome(consumed, {
      status: "succeeded",
      code: "interaction_succeeded",
    });
    const persisted = JSON.stringify(store.facts);
    assert.equal(persisted.includes(secretLocator), false);
    assert.equal(persisted.includes(secretValue), false);
    assert.match(store.facts[0]!.locatorValueDigest ?? "", /^[0-9a-f]{64}$/u);
    assert.match(store.facts[0]!.valueDigest ?? "", /^[0-9a-f]{64}$/u);
  });
  for (const [label, substituted] of [
    ["action", { kind: "select", locator: base.locator, value: base.value }],
    ["locator", { ...base, locator: { ...base.locator, name: "Other" } }],
    ["value", { ...base, value: "4" }],
  ] as const) {
    await context.test(`${label} substitution consumes and fails closed`, () => {
      const store = new FakeStore();
      const registry = authority(store);
      const capability = registry.mint({
        conversationId: SCOPE.conversationId,
        turnId: SCOPE.turnId,
        externalSessionGeneration: SCOPE.externalSessionGeneration,
        operation: base,
        intentAuthority: "explicit",
      });
      assert.throws(
        () => registry.consume(capability, substituted as VisualAgentOperation),
        VisualAgentAuthorityError,
      );
      assert.deepEqual(store.facts.map((fact) => fact.factKind), [
        "mint",
        "consume",
        "failure",
      ]);
      assert.throws(() => registry.consume(capability, base), VisualAgentAuthorityError);
    });
  }
});

test("turn/session/attempt drift, expiry, restart, and extra operation fields fail closed", async (context) => {
  const operation = { kind: "observe_dom_text" } as const;
  await context.test("turn scope drift", () => {
    const store = new FakeStore();
    const registry = authority(store);
    const capability = registry.mint({
      conversationId: SCOPE.conversationId,
      turnId: SCOPE.turnId,
      externalSessionGeneration: SCOPE.externalSessionGeneration,
      operation,
      intentAuthority: "proposal_only",
    });
    store.scope = Object.freeze({ ...SCOPE, immutableUserMessageId: "message_replaced" });
    assert.throws(() => registry.consume(capability, operation), VisualAgentAuthorityError);
  });
  await context.test("full process identity drift", () => {
    const store = new FakeStore();
    const registry = authority(store);
    const capability = registry.mint({
      conversationId: SCOPE.conversationId,
      turnId: SCOPE.turnId,
      externalSessionGeneration: SCOPE.externalSessionGeneration,
      operation,
      intentAuthority: "proposal_only",
    });
    store.target = Object.freeze({ ...TARGET, processStartToken: "replacement-token" });
    assert.throws(() => registry.consume(capability, operation), VisualAgentAuthorityError);
  });
  await context.test("expiry", () => {
    const store = new FakeStore();
    let now = NOW;
    const registry = authority(store, () => now);
    const capability = registry.mint({
      conversationId: SCOPE.conversationId,
      turnId: SCOPE.turnId,
      externalSessionGeneration: SCOPE.externalSessionGeneration,
      operation,
      intentAuthority: "proposal_only",
    });
    now = new Date(NOW.getTime() + 30_000);
    assert.throws(() => registry.consume(capability, operation), VisualAgentAuthorityError);
  });
  await context.test("new registry epoch has no authority over old token", () => {
    const store = new FakeStore();
    const first = authority(store);
    const capability = first.mint({
      conversationId: SCOPE.conversationId,
      turnId: SCOPE.turnId,
      externalSessionGeneration: SCOPE.externalSessionGeneration,
      operation,
      intentAuthority: "proposal_only",
    });
    const restarted = new VisualAgentAuthority(store, {
      now: () => NOW,
      epochSecret: Buffer.alloc(32, 8),
    });
    assert.throws(() => restarted.consume(capability, operation), VisualAgentAuthorityError);
  });
  await context.test("turn release consumes and records bounded revocation", () => {
    const store = new FakeStore();
    const registry = authority(store);
    const capability = registry.mint({
      conversationId: SCOPE.conversationId,
      turnId: SCOPE.turnId,
      externalSessionGeneration: SCOPE.externalSessionGeneration,
      operation,
      intentAuthority: "proposal_only",
    });
    registry.revokeTurn(SCOPE.conversationId, SCOPE.turnId);
    assert.deepEqual(store.facts.map((fact) => [
      fact.factKind,
      fact.outcomeCode,
    ]), [
      ["mint", null],
      ["consume", null],
      ["failure", "turn_released"],
    ]);
    assert.throws(() => registry.consume(capability, operation), VisualAgentAuthorityError);
  });
  await context.test("run revocation is immediate and records a bounded terminal fact", () => {
    const store = new FakeStore();
    const registry = authority(store);
    const capability = registry.mint({
      conversationId: SCOPE.conversationId,
      turnId: SCOPE.turnId,
      externalSessionGeneration: SCOPE.externalSessionGeneration,
      operation,
      intentAuthority: "proposal_only",
    });
    registry.revokeRun(TARGET.runId);
    assert.deepEqual(store.facts.map((fact) => [
      fact.factKind,
      fact.outcomeCode,
    ]), [
      ["mint", null],
      ["consume", null],
      ["failure", "run_revoked"],
    ]);
    assert.throws(() => registry.consume(capability, operation), VisualAgentAuthorityError);
  });
  await context.test("unsupported extra fields are rejected", () => {
    const store = new FakeStore();
    assert.throws(() => authority(store).mint({
      conversationId: SCOPE.conversationId,
      turnId: SCOPE.turnId,
      externalSessionGeneration: SCOPE.externalSessionGeneration,
      operation: { kind: "observe_dom_text", selector: "#secret" } as never,
      intentAuthority: "proposal_only",
    }), VisualAgentAuthorityError);
    assert.equal(store.facts.length, 0);
  });
});

test("visual authority configuration has hard TTL and registry limits", () => {
  const store = new FakeStore();
  assert.throws(() => new VisualAgentAuthority(store, {
    ttlMs: 60_001,
  }), /TTL is invalid/u);
  assert.throws(() => new VisualAgentAuthority(store, {
    maxGrants: 4_097,
  }), /registry limit is invalid/u);
});

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ApiError } from "../src/errors.ts";
import { canonicalDigest, canonicalJsonV2, parseCanonicalJsonV2, sha256Hex } from "../src/canonical-json-v2.ts";
import { DurableProjectStore } from "../src/durable-project-store.ts";
import { Gate2Runtime } from "../src/gate2-runtime.ts";
import type { LocalRunTerminalEvidence, ProjectCommand, VerifiedMesaRunEvidence, WindModelContract } from "../src/durable-project-types.ts";

const commandId = (): string => crypto.randomUUID();
const contract: WindModelContract = {
  model_id: "wind-turbine-maintenance",
  model_revision_id: `mr_${"1".repeat(64)}`,
  preset_id: "wind-turbine-maintenance-demo-v1",
  parameter_defaults: { turbine_count: 100, crew_count: 3, preventive_enabled: true },
  execution_defaults: { horizon_days: 1095, warmup_days: 365, seed: 2 },
  runtime_profile: { event_cap: 1000000, wall_clock_seconds: 120 },
  parameter_rules: { turbine_count: { type: "integer", minimum: 1, maximum: 1000 }, crew_count: { type: "integer", minimum: 1, maximum: 100 }, preventive_enabled: { type: "boolean" } },
  allowed_model_refs: ["parameter:turbine_count", "metric:availability", "mechanism:corrective_priority"],
};

const withStore = (run: (root: string, store: DurableProjectStore) => void, options: ConstructorParameters<typeof DurableProjectStore>[1] = {}): void => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "riff-durable-")));
  const store = new DurableProjectStore(root, { ...options, modelContracts: [contract] });
  try { run(root, store); } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
};

const expectApi = (code: string, run: () => unknown): void => assert.throws(run, (error: unknown) => error instanceof ApiError && error.code === code);

test("canonical v2 follows UTF-16/JCS number rules and rejects unsafe input", () => {
  assert.equal(canonicalJsonV2({ "\u20ac": 1, "\r": 2, "\ufb33": 3, "1": 4, "😀": 5, "\u0080": 6, "ö": 7 }).toString(), '{"\\r":2,"1":4,"\u0080":6,"ö":7,"€":1,"😀":5,"דּ":3}');
  assert.equal(canonicalJsonV2({ negative_zero: -0, integral_float: 1.0, threshold: 1e-7 }).toString(), '{"integral_float":1,"negative_zero":0,"threshold":1e-7}');
  assert.notEqual(canonicalDigest("é"), canonicalDigest("e\u0301"));
  expectApiOrNative(() => parseCanonicalJsonV2('{"a":1,"a":2}'));
  expectApiOrNative(() => canonicalJsonV2(Number.POSITIVE_INFINITY));
  expectApiOrNative(() => parseCanonicalJsonV2("9007199254740992"));
  expectApiOrNative(() => canonicalJsonV2("\ud800"));
  assert.equal(parseCanonicalJsonV2("1e20"), 1e20);
  assert.equal(parseCanonicalJsonV2("9007199254740992.0"), 9_007_199_254_740_992);
  assert.equal(canonicalJsonV2(parseCanonicalJsonV2("[1e-6,1e-7,1e20,1e21,5e-324,333333333.33333329,1e30,4.5,0.002]")).toString(), "[0.000001,1e-7,100000000000000000000,1e+21,5e-324,333333333.3333333,1e+30,4.5,0.002]");
  for (const key of ["__proto__", "prototype", "constructor"]) expectApiOrNative(() => parseCanonicalJsonV2(`{"${key}":1}`));
  const parsed = parseCanonicalJsonV2('{"safe":1}') as Record<string, unknown>; assert.equal(Object.getPrototypeOf(parsed), null);
});

test("canonical v2 matches the shared Node/Python golden fixture byte-for-byte", () => {
  const fixturePath = join(import.meta.dirname, "../../contracts/canonical-json-v2-golden.json");
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
    schema_version: number;
    canonical_json_version: string;
    accept: Array<{ name: string; input: string; canonical_hex: string; sha256: string }>;
    reject: Array<{ name: string; input: string }>;
  };
  assert.equal(fixture.schema_version, 1);
  assert.equal(fixture.canonical_json_version, "riff-canonical-json-v2");
  for (const item of fixture.accept) {
    const bytes = canonicalJsonV2(parseCanonicalJsonV2(item.input));
    assert.equal(bytes.toString("hex"), item.canonical_hex, item.name);
    assert.equal(sha256Hex(bytes), item.sha256, item.name);
  }
  for (const item of fixture.reject) assert.throws(() => parseCanonicalJsonV2(item.input), undefined, item.name);
});

test("workspace root and write paths reject nested symlink escapes", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "riff-symlink-"))); const outside = realpathSync(mkdtempSync(join(tmpdir(), "riff-outside-"))); const link = join(base, "linked"); symlinkSync(outside, link);
  try { expectApi("unsafe_workspace", () => new DurableProjectStore(join(link, "workspace"), { modelContracts: [contract] })); }
  finally { rmSync(base, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("workspace creation is globally idempotent and durable project identity is distinct from sessions", () => withStore((root, store) => {
  const request = { command_id: commandId(), display_name: "Wind maintenance", initial_actor: { actor_type: "human" as const, display_name: "Owner", declared_role: "project_owner" as const } };
  const first = store.createProject(request); const retry = store.createProject(request);
  assert.deepEqual(retry, first); const projectId = (first.body.project as any).project_id; const actorId = (first.body.initial_actor as any).actor_id;
  assert.match(projectId, /^project_[0-9a-f]{32}$/); assert.match(actorId, /^actor_[0-9a-f]{32}$/);
  const one = store.attachSession(projectId, actorId); const two = store.attachSession(projectId, actorId);
  assert.notEqual(one.session_id, two.session_id); assert.equal(one.project_id, projectId); assert.equal(store.snapshot(projectId).snapshot_revision, 0);
  expectApi("command_id_conflict", () => store.createProject({ ...request, display_name: "Changed" }));
  store.close();
  const reopened = new DurableProjectStore(root, { modelContracts: [contract] });
  try { assert.equal(reopened.snapshot(projectId).project_id, projectId); assert.notEqual(reopened.attachSession(projectId, actorId).session_id, one.session_id); assert.deepEqual(reopened.createProject(request), first); }
  finally { reopened.close(); }
}));

test("a second backend writer fails while the first owns the workspace", () => withStore((root) => {
  expectApi("workspace_writer_active", () => new DurableProjectStore(root, { modelContracts: [contract] }));
}));

test("a crashed writer leaves a stale PID/start-token lock that a restart quarantines", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "riff-crash-lock-"))); const moduleUrl = new URL("../src/durable-project-store.ts", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `import { DurableProjectStore } from ${JSON.stringify(moduleUrl)}; new DurableProjectStore(${JSON.stringify(root)}); process.exit(0);`], { encoding: "utf8" }); assert.equal(child.status, 0, child.stderr);
  const reopened = new DurableProjectStore(root); try { assert.ok(readdirSync(join(root, "quarantine")).some((name) => name.startsWith("stale-writer-lock-"))); } finally { reopened.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a committed command retries after restart before expired-session validation", () => withStore((root, store) => {
  const context = bootstrap(store); const actorCommand = command(context, { actor_type: "agent" as const, display_name: "Local Agent", declared_role: "assistant" as const });
  const first = store.createActor(actorCommand); assert.equal(first.status, 201); store.close();
  const reopened = new DurableProjectStore(root, { modelContracts: [contract] });
  try {
    assert.deepEqual(reopened.createActor(actorCommand), first);
    expectApi("command_id_conflict", () => reopened.createActor({ ...actorCommand, payload: { ...actorCommand.payload, display_name: "Changed" } }));
    expectApi("resource_not_found", () => reopened.createActor({ ...actorCommand, command_id: commandId() }));
  } finally { reopened.close(); }
}));

test("a committed start-run retry preserves the exact durable 202 response after restart", () => withStore((root, store) => {
  const context = fullyConfigured(store); const request = command(context, { experiment_revision_id: store.snapshot(context.projectId).current.experiment_revision_id! }); const first = store.startRun(request); assert.equal(first.status, 202); store.close();
  const reopened = new DurableProjectStore(root, { modelContracts: [contract] }); try { const retry = reopened.startRun(request); assert.equal(retry.status, 202); assert.deepEqual(retry, first); }
  finally { reopened.close(); }
}));

test("bootstrap authorization is durable, precedes materialization, and completed retries need no live session", () => withStore((root, store) => {
  const created = store.createProject({ command_id: commandId(), display_name: "Wind", initial_actor: { actor_type: "human", display_name: "Owner", declared_role: "project_owner" } }); const projectId = (created.body.project as any).project_id; const actorId = (created.body.initial_actor as any).actor_id; const sessionId = store.attachSession(projectId, actorId).session_id;
  const request: ProjectCommand<Record<string, never>> = { command_id: commandId(), project_id: projectId, session_id: sessionId, base_snapshot_revision: 0, payload: {} };
  expectApi("resource_not_found", () => store.authorizeBootstrap({ ...request, command_id: commandId(), session_id: `session_${"0".repeat(32)}` })); expectApi("stale_snapshot", () => store.authorizeBootstrap({ ...request, command_id: commandId(), base_snapshot_revision: 1 })); assert.equal(existsSync(join(root, "projects", projectId, "model-reconciliation")), false);
  assert.deepEqual(store.authorizeBootstrap(request), { completed: false }); assert.deepEqual(store.authorizeBootstrap(request), { completed: false });
  expectApi("command_id_conflict", () => store.authorizeBootstrap({ ...request, base_snapshot_revision: 1 }));
  const completed = store.completeBootstrap(request, contract.model_revision_id); assert.equal(completed.body.model_revision_id, contract.model_revision_id); store.close();
  const reopened = new DurableProjectStore(root, { modelContracts: [contract] }); try { assert.deepEqual(reopened.authorizeBootstrap(request), { completed: true, result: completed }); expectApi("command_id_conflict", () => reopened.authorizeBootstrap({ ...request, base_snapshot_revision: 1 })); }
  finally { reopened.close(); }
}));

test("terminal cancel no-event receipts retry exactly across restart and reject changed content", () => withStore((root, store) => {
  const context = fullyConfigured(store); const started = store.startRun(command(context, { experiment_revision_id: store.snapshot(context.projectId).current.experiment_revision_id! })); context.base = Number(started.body.snapshot_revision); const runId = String(started.body.run_id);
  const requested = store.cancelRun(command(context, { run_id: runId })); context.base = Number(requested.body.snapshot_revision);
  const facts = { mesa_receipt_absent: true as const, dispatch_owner_absent: true as const };
  store.close();
  const reconciler = new DurableProjectStore(root, { modelContracts: [contract], localRunInspector: () => facts }); reconciler.publishLocalTerminal(context.projectId, runId, "cancelled_before_dispatch"); const terminalRevision = reconciler.snapshot(context.projectId).snapshot_revision; const session = reconciler.attachSession(context.projectId, context.actorId); const terminalCancel: ProjectCommand<{ run_id: string }> = { command_id: commandId(), project_id: context.projectId, session_id: session.session_id, base_snapshot_revision: terminalRevision, payload: { run_id: runId } }; const first = reconciler.cancelRun(terminalCancel); reconciler.close();
  const reopened = new DurableProjectStore(root, { modelContracts: [contract] }); try { assert.deepEqual(reopened.cancelRun(terminalCancel), first); expectApi("command_id_conflict", () => reopened.cancelRun({ ...terminalCancel, payload: { run_id: `run_${"0".repeat(32)}` } })); }
  finally { reopened.close(); }
}));

test("dispatch ownership survives restart and forbids false cancelled-before-dispatch publication", () => withStore((root, store) => {
  const context = fullyConfigured(store); const started = store.startRun(command(context, { experiment_revision_id: store.snapshot(context.projectId).current.experiment_revision_id! })); const runId = String(started.body.run_id); context.base = Number(started.body.snapshot_revision);
  assert.deepEqual(store.runDispatchState(context.projectId, runId), { state: "never_started", failure: null, absence_proof_count: 0 }); store.markRunDispatch(context.projectId, runId, "in_flight"); expectApi("invalid_request", () => store.markRunDispatch(context.projectId, runId, "rejection_observed", { code: "mesa_rejected", safe_message: "Generic rejection." })); expectApi("run_reconciliation_conflict", () => store.markRunDispatch(context.projectId, runId, "stable_rejected", { code: "run_admission_mismatch", safe_message: "The Mesa request differs from the admitted run." })); store.cancelRun(command(context, { run_id: runId })); store.close();
  const reopened = new DurableProjectStore(root, { modelContracts: [contract], localRunInspector: () => ({ mesa_receipt_absent: true, dispatch_owner_absent: true }) }); try { assert.equal(reopened.runDispatchState(context.projectId, runId).state, "in_flight"); expectApi("run_reconciliation_conflict", () => reopened.publishLocalTerminal(context.projectId, runId, "cancelled_before_dispatch")); }
  finally { reopened.close(); }
}));

test("a cancel racing a stable pre-receipt rejection converges durably to cancelled", () => withStore((_root, store) => {
  const context = fullyConfigured(store); const started = store.startRun(command(context, { experiment_revision_id: store.snapshot(context.projectId).current.experiment_revision_id! })); const runId = String(started.body.run_id); context.base = Number(started.body.snapshot_revision); store.markRunDispatch(context.projectId, runId, "in_flight"); store.cancelRun(command(context, { run_id: runId })); const rejection = { code: "run_admission_mismatch", safe_message: "The Mesa request differs from the admitted run." }; store.markRunDispatch(context.projectId, runId, "rejection_observed", rejection); store.markRunDispatch(context.projectId, runId, "rejection_observed", rejection); store.markRunDispatch(context.projectId, runId, "stable_rejected", rejection);
  const terminal = store.publishLocalTerminal(context.projectId, runId, "cancelled_before_dispatch"); assert.equal((terminal.body.run as any).status, "cancelled"); assert.equal((terminal.body.run as any).cancel_outcome, "cancelled_before_dispatch");
}, { localRunInspector: () => ({ mesa_receipt_absent: true, dispatch_owner_absent: true }) }));

test("same-base commands serialize to one commit and one deterministic stale snapshot", () => withStore((_root, store) => {
  const context = bootstrap(store); const first = command(context, { operation: "create" as const, parent_decision_brief_revision_id: null, question: "First", decision_owner: "Owner", objective: "Objective", constraints: [], assumptions: [], non_goals: [], sources: [source] }); const second = command(context, { operation: "create" as const, parent_decision_brief_revision_id: null, question: "Second", decision_owner: "Owner", objective: "Objective", constraints: [], assumptions: [], non_goals: [], sources: [source] }); store.createBrief(first); expectApi("stale_snapshot", () => store.createBrief(second)); assert.equal(store.snapshot(context.projectId).snapshot_revision, context.base + 1);
}));

test("a late receipt after local terminal is committed as explicit fail-closed corruption and recovery preserves it", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "riff-late-receipt-"))); const states = new Map<string, MesaFixtureState>(); const provider = mesaEvidenceFixture(root, states); const store = new DurableProjectStore(root, { modelContracts: [contract], mesaEvidenceProvider: provider, localRunInspector: () => ({ mesa_receipt_absent: true, dispatch_owner_absent: true }) });
  try { const context = fullyConfigured(store); const started = store.startRun(command(context, { experiment_revision_id: store.snapshot(context.projectId).current.experiment_revision_id! })); const runId = String(started.body.run_id); context.base = Number(started.body.snapshot_revision); store.cancelRun(command(context, { run_id: runId })); store.publishLocalTerminal(context.projectId, runId, "cancelled_before_dispatch"); expectApi("late_receipt_after_local_terminal", () => store.recordLateReceiptAfterLocalTerminal(context.projectId, runId, { accepted: true })); expectApi("late_receipt_after_local_terminal", () => store.snapshot(context.projectId)); const violation = join(root, "projects", context.projectId, "run-reconciliation", runId, "late-receipt-violation.json"); assert.equal(existsSync(violation), true); store.close(); const reopened = new DurableProjectStore(root, { modelContracts: [contract], mesaEvidenceProvider: provider }); try { expectApi("late_receipt_after_local_terminal", () => reopened.snapshot(context.projectId)); } finally { reopened.close(); } }
  finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("restart audit detects a receipt appearing after local terminal and attempts idempotent cancel", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "riff-late-receipt-restart-"))); const states = new Map<string, MesaFixtureState>(); const provider = mesaEvidenceFixture(root, states); let projectId = ""; let runId = ""; const initial = new DurableProjectStore(root, { modelContracts: [contract], mesaEvidenceProvider: provider, localRunInspector: () => ({ mesa_receipt_absent: true, dispatch_owner_absent: true }) });
  try { const context = fullyConfigured(initial); projectId = context.projectId; const started = initial.startRun(command(context, { experiment_revision_id: initial.snapshot(projectId).current.experiment_revision_id! })); runId = String(started.body.run_id); context.base = Number(started.body.snapshot_revision); initial.cancelRun(command(context, { run_id: runId })); initial.publishLocalTerminal(projectId, runId, "cancelled_before_dispatch"); }
  finally { initial.close(); }
  const reopened = new DurableProjectStore(root, { modelContracts: [contract], mesaEvidenceProvider: provider }); let cancelCalls = 0; const mesa: any = { async getWindRunReceipt(seenProject: string, downstreamKey: string) { assert.equal(seenProject, projectId); assert.match(downstreamKey, /^rk_/); return provider(projectId, runId); }, async cancelWindRunV2() { cancelCalls += 1; return { status: "cancelled" }; }, async getWindRunEvidence() { return provider(projectId, runId); } }; const runtime = new Gate2Runtime(root, mesa, reopened); runtime.start();
  try { const deadline = Date.now() + 3_000; while (Date.now() < deadline) { try { runtime.store.snapshot(projectId); } catch (error) { if (error instanceof ApiError && error.code === "late_receipt_after_local_terminal") break; throw error; } await new Promise((resolveWait) => setTimeout(resolveWait, 25)); } expectApi("late_receipt_after_local_terminal", () => runtime.store.snapshot(projectId)); assert.equal(cancelCalls, 1); }
  finally { await runtime.close(); }
  const recovered = new DurableProjectStore(root, { modelContracts: [contract], mesaEvidenceProvider: provider }); try { expectApi("late_receipt_after_local_terminal", () => recovered.snapshot(projectId)); } finally { recovered.close(); rmSync(root, { recursive: true, force: true }); }
});

test("late-receipt audit scheduling is fair beyond one batch and survives restart", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "riff-late-audit-fair-"))); const clock = () => "2026-07-21T00:00:00.000Z"; const initial = new DurableProjectStore(root, { clock, modelContracts: [contract], localRunInspector: () => ({ mesa_receipt_absent: true, dispatch_owner_absent: true }) }); let projectId = ""; const runIds: string[] = [];
  try {
    const context = fullyConfigured(initial); projectId = context.projectId;
    for (let index = 0; index < 12; index += 1) { const started = initial.startRun(command(context, { experiment_revision_id: initial.snapshot(projectId).current.experiment_revision_id! })); const runId = String(started.body.run_id); runIds.push(runId); context.base = Number(started.body.snapshot_revision); const cancelled = initial.cancelRun(command(context, { run_id: runId })); context.base = Number(cancelled.body.snapshot_revision); const terminal = initial.publishLocalTerminal(projectId, runId, "cancelled_before_dispatch"); context.base = Number(terminal.body.snapshot_revision); }
    const firstBatch = initial.localTerminalRunsForAudit(10); assert.equal(firstBatch.length, 10);
    firstBatch.forEach((candidate, index) => initial.recordLateReceiptAuditAttempt(candidate.project_id, candidate.run_id, index % 2 === 0 ? "transient_error" : "provider_unavailable"));
    const secondBatch = initial.localTerminalRunsForAudit(10); assert.equal(secondBatch.length, 2); assert.equal(secondBatch.every((candidate) => !firstBatch.some((first) => first.run_id === candidate.run_id)), true); initial.close();
    const reopened = new DurableProjectStore(root, { clock, modelContracts: [contract], localRunInspector: () => ({ mesa_receipt_absent: true, dispatch_owner_absent: true }) });
    try { const afterRestart = reopened.localTerminalRunsForAudit(10); assert.deepEqual(afterRestart.map((item) => item.run_id), secondBatch.map((item) => item.run_id)); afterRestart.forEach((candidate) => reopened.recordLateReceiptAuditAttempt(candidate.project_id, candidate.run_id, "not_found")); }
    finally { reopened.close(); }
    for (const runId of runIds) { const audit = JSON.parse(readFileSync(join(root, "projects", projectId, "run-reconciliation", runId, "late-receipt-audit.json"), "utf8")); assert.equal(audit.attempt_count, 1); assert.ok(["not_found", "transient_error", "provider_unavailable"].includes(audit.outcome_class)); assert.ok(Date.parse(audit.next_attempt_at) > Date.parse(audit.attempted_at)); assert.ok(Date.parse(audit.next_attempt_at) - Date.parse(audit.attempted_at) <= 30_000); }
  } finally { initial.close(); rmSync(root, { recursive: true, force: true }); }
});

test("malformed late receipt evidence commits a safe corruption marker and remains fail-closed after restart", async () => {
  const variants = ["receipt_schema", "lifecycle_schema", "receipt_digest"] as const;
  for (const variant of variants) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), `riff-late-corrupt-${variant}-`))); const states = new Map<string, MesaFixtureState>(); const validProvider = mesaEvidenceFixture(root, states); let projectId = ""; let runId = "";
    const corruptProvider = (seenProject: string, seenRun: string): VerifiedMesaRunEvidence => { const evidence = structuredClone(validProvider(seenProject, seenRun)); if (variant === "receipt_schema") (evidence.receipt as any).upstream_absolute_path = "/private/upstream/secret"; else if (variant === "lifecycle_schema") (evidence.lifecycle_records[0] as any).upstream_absolute_path = "/private/upstream/secret"; else evidence.receipt.mesa_run_receipt_digest = `mrr_${"0".repeat(64)}`; return evidence; };
    const store = new DurableProjectStore(root, { modelContracts: [contract], mesaEvidenceProvider: corruptProvider, localRunInspector: () => ({ mesa_receipt_absent: true, dispatch_owner_absent: true }) });
    try { const context = fullyConfigured(store); projectId = context.projectId; const started = store.startRun(command(context, { experiment_revision_id: store.snapshot(projectId).current.experiment_revision_id! })); runId = String(started.body.run_id); context.base = Number(started.body.snapshot_revision); store.cancelRun(command(context, { run_id: runId })); store.publishLocalTerminal(projectId, runId, "cancelled_before_dispatch"); let cancels = 0; const mesa: any = { async getWindRunReceipt() { return corruptProvider(projectId, runId); }, async cancelWindRunV2() { cancels += 1; return { status: "cancelled" }; }, async getWindRunEvidence() { return corruptProvider(projectId, runId); } }; const runtime = new Gate2Runtime(root, mesa, store); runtime.start();
      try { const deadline = Date.now() + 3_000; while (Date.now() < deadline) { try { runtime.store.snapshot(projectId); } catch (error) { if (error instanceof ApiError && error.code === "late_receipt_evidence_corrupt") break; throw error; } await new Promise((resolveWait) => setTimeout(resolveWait, 25)); } expectApi("late_receipt_evidence_corrupt", () => runtime.store.snapshot(projectId)); assert.equal(cancels, 1); const markerPath = join(root, "projects", projectId, "run-reconciliation", runId, "late-receipt-evidence-corrupt.json"); const markerText = readFileSync(markerPath, "utf8"); const marker = JSON.parse(markerText); assert.deepEqual(Object.keys(marker).sort(), ["canonical_json_version", "downstream_idempotency_key", "downstream_request_digest", "evidence_base_project_event_digest", "evidence_base_snapshot_revision", "late_receipt_evidence_corrupt_digest", "local_terminal_evidence_digest", "observed_at", "project_id", "run_id", "safe_error_code", "schema_version"].sort()); assert.equal(marker.safe_error_code, "mesa_run_corrupt"); assert.equal(marker.project_id, projectId); assert.equal(marker.run_id, runId); assert.equal(markerText.includes("/private/upstream/secret"), false); }
      finally { await runtime.close(); }
      const reopened = new DurableProjectStore(root, { modelContracts: [contract] }); try { expectApi("late_receipt_evidence_corrupt", () => reopened.snapshot(projectId)); } finally { reopened.close(); }
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  }
});

test("generic proxy 404 remains retryable in-flight and never becomes immutable rejection", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "riff-transient-404-"))); const states = new Map<string, MesaFixtureState>(); const provider = mesaEvidenceFixture(root, states); const store = new DurableProjectStore(root, { modelContracts: [contract], mesaEvidenceProvider: provider }); const context = fullyConfigured(store); let starts = 0; let receiptLookups = 0; let runId = "";
  const mesa: any = { async startWindRunV2() { starts += 1; if (starts <= 2) throw new ApiError(404, "mesa_rejected", "Mesa rejected the request."); return { status: "accepted" }; }, async getWindRunReceipt() { receiptLookups += 1; throw new ApiError(404, "mesa_rejected", "Mesa rejected the request."); }, async getWindRunEvidence(project: string, run: string) { return provider(project, run); } }; const runtime = new Gate2Runtime(root, mesa, store);
  try { const started = runtime.startRun(command(context, { experiment_revision_id: store.snapshot(context.projectId).current.experiment_revision_id! })); runId = String(started.body.run_id); runtime.start(); const deadline = Date.now() + 3_000; while (starts < 3 && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 25)); assert.ok(starts >= 3); assert.equal(receiptLookups, 0); assert.equal(store.runDispatchState(context.projectId, runId).state, "receipt_observed"); assert.equal(store.run(context.projectId, runId).reference_kind, "pending"); }
  finally { await runtime.close(); rmSync(root, { recursive: true, force: true }); }
});

test("receipt delayed after deterministic admission errors is observed before stable rejection", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "riff-delayed-receipt-"))); const states = new Map<string, MesaFixtureState>(); const provider = mesaEvidenceFixture(root, states); const store = new DurableProjectStore(root, { modelContracts: [contract], mesaEvidenceProvider: provider }); const context = fullyConfigured(store); let starts = 0; let lookups = 0; let runId = "";
  const mesa: any = { async startWindRunV2() { starts += 1; throw new ApiError(422, "run_admission_mismatch", "The Mesa request differs from the admitted run."); }, async getWindRunReceipt(project: string, _key: string) { lookups += 1; if (lookups === 1) throw new ApiError(404, "receipt_not_found", "The Mesa run receipt was not found."); return provider(project, runId); }, async getWindRunEvidence(project: string, run: string) { return provider(project, run); } }; const runtime = new Gate2Runtime(root, mesa, store);
  try { const started = runtime.startRun(command(context, { experiment_revision_id: store.snapshot(context.projectId).current.experiment_revision_id! })); runId = String(started.body.run_id); runtime.start(); const deadline = Date.now() + 3_000; while (store.runDispatchState(context.projectId, runId).state !== "receipt_observed" && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 25)); const journal = store.runDispatchState(context.projectId, runId); assert.equal(journal.state, "receipt_observed"); assert.equal(journal.absence_proof_count, 0); assert.equal(lookups, 2); assert.equal(store.run(context.projectId, runId).reference_kind, "pending"); }
  finally { await runtime.close(); rmSync(root, { recursive: true, force: true }); }
});

test("runtime close fences delayed dispatch writes and releases the writer only after in-flight drain", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "riff-runtime-close-"))); const store = new DurableProjectStore(root, { modelContracts: [contract] }); const context = fullyConfigured(store); let entered!: () => void; const enteredPromise = new Promise<void>((resolve) => { entered = resolve; }); let release!: () => void; const delayed = new Promise<void>((resolve) => { release = resolve; });
  const mesa: any = { async startWindRunV2() { entered(); await delayed; return { status: "accepted" }; }, async getWindRunReceipt() { throw new ApiError(404, "receipt_not_found", "The Mesa run receipt was not found."); }, async getWindRunEvidence() { throw new ApiError(404, "run_not_found", "The Mesa run was not found."); } }; const runtime = new Gate2Runtime(root, mesa, store); const started = runtime.startRun(command(context, { experiment_revision_id: store.snapshot(context.projectId).current.experiment_revision_id! })); const runId = String(started.body.run_id); await enteredPromise; const journalPath = join(root, "projects", context.projectId, "run-reconciliation", runId, "dispatch-journal.json"); const beforeClose = readFileSync(journalPath); const closing = runtime.close(); expectApi("workspace_writer_active", () => new DurableProjectStore(root, { modelContracts: [contract] })); release(); await closing; assert.equal(readFileSync(journalPath).equals(beforeClose), true);
  const replacement = new DurableProjectStore(root, { modelContracts: [contract] }); try { const afterOwner = readFileSync(journalPath); await new Promise((resolveWait) => setTimeout(resolveWait, 200)); assert.equal(readFileSync(journalPath).equals(afterOwner), true); assert.equal(replacement.runDispatchState(context.projectId, runId).state, "in_flight"); } finally { replacement.close(); rmSync(root, { recursive: true, force: true }); }
});

test("runtime close clears queued retry timers before a replacement writer starts", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "riff-runtime-timer-close-"))); const store = new DurableProjectStore(root, { modelContracts: [contract] }); const context = fullyConfigured(store); let calls = 0; const mesa: any = { async startWindRunV2() { calls += 1; throw new ApiError(503, "mesa_unavailable", "Mesa unavailable."); }, async getWindRunReceipt() { throw new ApiError(404, "receipt_not_found", "The Mesa run receipt was not found."); }, async getWindRunEvidence() { throw new ApiError(404, "run_not_found", "The Mesa run was not found."); } }; const runtime = new Gate2Runtime(root, mesa, store); runtime.startRun(command(context, { experiment_revision_id: store.snapshot(context.projectId).current.experiment_revision_id! })); const deadline = Date.now() + 1_000; while (calls < 1 && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 5)); assert.equal(calls, 1); await runtime.close(); const replacement = new DurableProjectStore(root, { modelContracts: [contract] }); try { await new Promise((resolveWait) => setTimeout(resolveWait, 200)); assert.equal(calls, 1); } finally { replacement.close(); rmSync(root, { recursive: true, force: true }); }
});

test("never-started cancellation commits local absence only after exact-key receipt_not_found", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "riff-never-started-cancel-"))); const store = new DurableProjectStore(root, { modelContracts: [contract], localRunInspector: () => ({ mesa_receipt_absent: true, dispatch_owner_absent: true }) }); const context = fullyConfigured(store); const started = store.startRun(command(context, { experiment_revision_id: store.snapshot(context.projectId).current.experiment_revision_id! })); const runId = String(started.body.run_id); context.base = Number(started.body.snapshot_revision); store.cancelRun(command(context, { run_id: runId })); let receiptQueries = 0; let dispatchCalls = 0; const mesa: any = { async getWindRunReceipt(projectId: string, downstreamKey: string) { receiptQueries += 1; assert.equal(projectId, context.projectId); assert.match(downstreamKey, /^rk_/u); throw new ApiError(404, "receipt_not_found", "The Mesa run receipt was not found."); }, async startWindRunV2() { dispatchCalls += 1; }, async getWindRunEvidence() { throw new ApiError(404, "run_not_found", "The Mesa run was not found."); } }; const runtime = new Gate2Runtime(root, mesa, store); runtime.start();
  try { const deadline = Date.now() + 2_000; while (runtime.store.run(context.projectId, runId).reference_kind !== "terminal" && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 20)); const terminal = runtime.store.run(context.projectId, runId) as any; assert.equal(terminal.reference_kind, "terminal"); assert.equal(terminal.cancel_outcome, "cancelled_before_dispatch"); assert.ok(receiptQueries >= 1); assert.equal(dispatchCalls, 0); assert.deepEqual(runtime.store.runDispatchState(context.projectId, runId), { state: "never_started", failure: null, absence_proof_count: 0 }); }
  finally { await runtime.close(); rmSync(root, { recursive: true, force: true }); }
});

test("never-started cancellation remains pending on generic receipt lookup errors", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "riff-never-started-generic-"))); const store = new DurableProjectStore(root, { modelContracts: [contract], localRunInspector: () => ({ mesa_receipt_absent: true, dispatch_owner_absent: true }) }); const context = fullyConfigured(store); const started = store.startRun(command(context, { experiment_revision_id: store.snapshot(context.projectId).current.experiment_revision_id! })); const runId = String(started.body.run_id); context.base = Number(started.body.snapshot_revision); store.cancelRun(command(context, { run_id: runId })); let receiptQueries = 0; const mesa: any = { async getWindRunReceipt() { receiptQueries += 1; throw new ApiError(503, "mesa_unavailable", "Mesa unavailable."); }, async startWindRunV2() { throw new Error("must not dispatch cancelled run"); }, async getWindRunEvidence() { throw new ApiError(503, "mesa_unavailable", "Mesa unavailable."); } }; const runtime = new Gate2Runtime(root, mesa, store); runtime.start();
  try { const deadline = Date.now() + 500; while (receiptQueries < 2 && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 20)); assert.ok(receiptQueries >= 1); const pending = runtime.store.run(context.projectId, runId); assert.equal(pending.reference_kind, "pending"); assert.equal(pending.status, "cancellation_requested"); assert.equal(existsSync(join(root, "projects", context.projectId, "run-terminal-evidence", runId)), false); }
  finally { await runtime.close(); rmSync(root, { recursive: true, force: true }); }
});

test("alignment writes and project recovery reject nested/project symlinks", () => withStore((root, store) => {
  const context = bootstrap(store); const outside = realpathSync(mkdtempSync(join(tmpdir(), "riff-write-outside-"))); const alignment = join(root, "projects", context.projectId, "alignment"); symlinkSync(outside, alignment);
  try { expectApi("unsafe_workspace", () => store.createBrief(command(context, { operation: "create" as const, parent_decision_brief_revision_id: null, question: "Question", decision_owner: "Owner", objective: "Objective", constraints: [], assumptions: [], non_goals: [], sources: [source] }))); assert.equal(readdirSync(outside).length, 0); }
  finally { unlinkSync(alignment); rmSync(outside, { recursive: true, force: true }); }
  writeFileSync(alignment, "not-a-directory"); try { expectApi("unsafe_workspace", () => store.createBrief(command(context, { operation: "create" as const, parent_decision_brief_revision_id: null, question: "Question", decision_owner: "Owner", objective: "Objective", constraints: [], assumptions: [], non_goals: [], sources: [source] }))); } finally { unlinkSync(alignment); }
  store.close(); const project = join(root, "projects", context.projectId); const moved = join(root, "quarantine", "moved-project"); renameSync(project, moved); symlinkSync(moved, project);
  const reopened = new DurableProjectStore(root, { modelContracts: [contract] });
  try { expectApi("project_corrupt", () => reopened.snapshot(context.projectId)); }
  finally { reopened.close(); }
}));

test("faults around the ProjectEvent commit point recover receipts and visibility deterministically", () => {
  for (const point of ["after_records_promoted", "after_event_committed", "after_snapshot_committed", "after_receipt_committed"] as const) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), `riff-fault-${point}-`))); let armed = false; let fired = false;
    const store = new DurableProjectStore(root, { modelContracts: [contract], faultInjector: (seen) => { if (armed && !fired && seen === point) { fired = true; throw new Error(`fault:${point}`); } } }); const context = bootstrap(store);
    const request = command(context, { operation: "create" as const, parent_decision_brief_revision_id: null, question: "Question", decision_owner: "Owner", objective: "Objective", constraints: [], assumptions: [], non_goals: [], sources: [source] }); armed = true; assert.throws(() => store.createBrief(request), new RegExp(`fault:${point}`)); assert.equal(fired, true);
    const committed = point !== "after_records_promoted"; assert.equal(store.snapshot(context.projectId).current.decision_brief_revision_id !== null, committed); store.close();
    const reopened = new DurableProjectStore(root, { modelContracts: [contract] }); try { assert.equal(reopened.snapshot(context.projectId).current.decision_brief_revision_id !== null, committed); if (committed) assert.equal(reopened.createBrief(request).status, 201); else assert.ok(readdirSync(join(root, "quarantine")).some((name) => name.includes("unreachable-decision_brief_revision"))); } finally { reopened.close(); rmSync(root, { recursive: true, force: true }); }
  }
});

test("workspace-create commit faults quarantine precommit projects and rebuild committed indexes", () => {
  for (const point of ["after_records_promoted", "after_workspace_event_committed", "after_receipt_committed"] as const) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), `riff-create-fault-${point}-`))); let fired = false; const request = { command_id: commandId(), display_name: "Wind", initial_actor: { actor_type: "human" as const, display_name: "Owner", declared_role: "project_owner" as const } };
    const store = new DurableProjectStore(root, { modelContracts: [contract], faultInjector: (seen) => { if (!fired && seen === point) { fired = true; throw new Error(`fault:${point}`); } } }); assert.throws(() => store.createProject(request), new RegExp(`fault:${point}`)); store.close();
    const reopened = new DurableProjectStore(root, { modelContracts: [contract] }); try { const retry = reopened.createProject(request); assert.equal(retry.status, 201); const projectId = (retry.body.project as any).project_id; assert.equal(reopened.snapshot(projectId).project_id, projectId); if (point === "after_records_promoted") assert.ok(readdirSync(join(root, "quarantine")).some((name) => name.startsWith("orphan-project_"))); } finally { reopened.close(); rmSync(root, { recursive: true, force: true }); }
  }
});

test("brief, alignment and experiment revisions are immutable, complete, editable and resettable", () => withStore((root, store) => {
  const context = bootstrap(store);
  const briefCommand = command(context, { operation: "create" as const, parent_decision_brief_revision_id: null, question: "How should crews be staffed?", decision_owner: "Maintenance lead", objective: "Measure service outcomes", constraints: [{ id: "c1", statement: "Three crews", source: source }], assumptions: [], non_goals: ["No optimization claim"], sources: [source] });
  const brief = (store.createBrief(briefCommand).body.decision_brief_revision as any); assert.match(brief.decision_brief_revision_id, /^dbr_[0-9a-f]{64}$/);
  context.base = 2;
  const alignment = (store.createAlignment(command(context, { operation: "create" as const, parent_alignment_map_revision_id: null, decision_brief_revision_id: brief.decision_brief_revision_id, model_id: "wind-turbine-maintenance" as const, model_revision_id: contract.model_revision_id, entries: [{ mapping_id: "m1", business_ref: "c1", mapping_kind: "constraint" as const, model_refs: ["parameter:turbine_count"], rationale: "Direct parameter", source }], known_gaps: [] })).body.alignment_map_revision as any);
  context.base = 3;
  const created = (store.createExperiment(command(context, { operation: "create", parent_experiment_revision_id: null, brief_revision_id: brief.decision_brief_revision_id, alignment_revision_id: alignment.alignment_map_revision_id, model_id: contract.model_id, model_revision_id: contract.model_revision_id, preset_id: contract.preset_id, parameters: contract.parameter_defaults, execution_values: contract.execution_defaults })).body.experiment_revision as any);
  assert.equal(created.parameter_diff.length, 0); assert.equal(created.execution_diff.length, 0); assert.match(created.defaults_digest, /^dd_[0-9a-f]{64}$/);
  const createdBytes = readFileSync(join(root, "projects", context.projectId, "experiments", "revisions", created.experiment_revision_id, "experiment.json")); assert.equal(createdBytes.equals(canonicalJsonV2(created)), true); assert.notEqual(createdBytes.at(-1), 0x0a); assert.equal(created.schema_id, undefined); assert.equal(created.experiment_digest, undefined);
  context.base = 4;
  const edited = (store.createExperiment(command(context, { operation: "edit", parent_experiment_revision_id: created.experiment_revision_id, parameter_changes: { crew_count: 4 }, execution_changes: { seed: 9 } })).body.experiment_revision as any);
  assert.equal(edited.parameters.crew_count, 4); assert.deepEqual(edited.parameter_diff.map((item: any) => item.parameter_id), ["crew_count"]); assert.deepEqual(edited.execution_diff.map((item: any) => item.field), ["seed"]);
  assert.equal(readFileSync(join(root, "projects", context.projectId, "experiments", "revisions", edited.experiment_revision_id, "experiment.json")).equals(canonicalJsonV2(edited)), true);
  context.base = 5;
  const reset = (store.createExperiment(command(context, { operation: "reset_defaults", parent_experiment_revision_id: edited.experiment_revision_id })).body.experiment_revision as any);
  assert.deepEqual(reset.parameters, contract.parameter_defaults); assert.deepEqual(reset.execution_values, contract.execution_defaults); assert.deepEqual(reset.parameter_diff, []); assert.deepEqual(reset.execution_diff, []); assert.notEqual(reset.experiment_revision_id, created.experiment_revision_id);
  assert.equal(readFileSync(join(root, "projects", context.projectId, "experiments", "revisions", reset.experiment_revision_id, "experiment.json")).equals(canonicalJsonV2(reset)), true);
  assert.equal(store.snapshot(context.projectId).phase, "review");
}));

test("framed experiment mutation requires its create root to equal the ready activation target", () => withStore((_root, store) => {
  const context = fullyConfigured(store); const snapshot = store.snapshot(context.projectId); const legacy = store.experimentRevision(context.projectId, snapshot.current.experiment_revision_id!);
  const preimage = { schema_id: "riff://evidence-studio/experiment-revision/framed/v1" as const, schema_version: 1 as const, canonical_json_version: "riff-canonical-json-v2" as const, project_id: context.projectId, parent_experiment_revision_id: null, operation: "create" as const, model_id: contract.model_id, model_revision_id: contract.model_revision_id, brief_revision_id: legacy.brief_revision_id, alignment_revision_id: legacy.alignment_revision_id, preset_id: contract.preset_id, defaults_digest: legacy.defaults_digest, parameter_defaults: legacy.parameter_defaults, parameters: legacy.parameters, parameter_diff: legacy.parameter_diff, execution_defaults: legacy.execution_defaults, execution_values: legacy.execution_values, execution_diff: legacy.execution_diff, runtime_profile: legacy.runtime_profile, copy_migration_rule: "framed_parameter_copy_revalidate_v1" as const, created_by_actor_id: context.actorId, created_at: legacy.created_at };
  const rootId = `er_${canonicalDigest(preimage)}`; const withId = { ...preimage, experiment_revision_id: rootId }; const root = { ...withId, experiment_digest: `erd_${canonicalDigest(withId)}` };
  store.gate3SystemTransition({ project_id: context.projectId, command_id: commandId(), command_digest: `cmd_${"a".repeat(64)}`, event_type: "model.activation_committed", records: [{ relative: `experiments/revisions/${rootId}/experiment.json`, value: root, ref: { kind: "experiment_revision", id: rootId, digest: root.experiment_digest } }], phase: "review", current: { ...snapshot.current, experiment_revision_id: rootId }, response: { status: "project_committed" } }); context.base += 1;
  store.setExperimentMutationGuard(() => ({ contract, root_experiment_revision_id: `er_${"f".repeat(64)}` }));
  expectApi("immutable_record_corrupt", () => store.createExperiment(command(context, { operation: "edit", parent_experiment_revision_id: rootId, parameter_changes: { crew_count: 4 }, execution_changes: {} })));
  assert.equal(store.snapshot(context.projectId).snapshot_revision, context.base);
  store.setExperimentMutationGuard(() => ({ contract, root_experiment_revision_id: rootId }));
  const edited = store.createExperiment(command(context, { operation: "edit", parent_experiment_revision_id: rootId, parameter_changes: { crew_count: 4 }, execution_changes: {} }));
  assert.equal((edited.body.experiment_revision as any).parent_experiment_revision_id, rootId);
}));

test("every live brief, alignment, and experiment subject load recomputes its content identity", () => {
  for (const family of ["brief", "alignment", "experiment"] as const) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), `riff-subject-${family}-`))); const store = new DurableProjectStore(root, { modelContracts: [contract] });
    try { const context = fullyConfigured(store); const snapshot = store.snapshot(context.projectId); const subject = family === "brief" ? snapshot.current.decision_brief_revision_id! : family === "alignment" ? snapshot.current.alignment_map_revision_id! : snapshot.current.experiment_revision_id!; const path = family === "brief" ? join(root, "projects", context.projectId, "alignment/decision-brief/revisions", subject, "revision.json") : family === "alignment" ? join(root, "projects", context.projectId, "alignment/requirement-map/revisions", subject, "revision.json") : join(root, "projects", context.projectId, "experiments/revisions", subject, "experiment.json"); const changed = JSON.parse(readFileSync(path, "utf8")); if (family === "brief") changed.question = "Changed after commit"; else if (family === "alignment") changed.known_gaps = [{ gap_id: "late", statement: "Changed after commit", blocking: false }]; else changed.execution_values.seed += 1; writeFileSync(path, canonicalJsonV2(changed)); expectApi("immutable_record_corrupt", () => store.createIssue(command(context, { subject_revision_ids: [subject], title: "Live check", body: "Must reject changed subject bytes", severity: "critical" as const, blocking: true, assignee_actor_id: null }))); }
    finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  }
});

test("execution bounds match Gate 1 and public projections are bounded/redacted", () => withStore((root, store) => {
  const context = fullyConfigured(store); let experimentId = store.snapshot(context.projectId).current.experiment_revision_id!;
  const negative = store.createExperiment(command(context, { operation: "edit", parent_experiment_revision_id: experimentId, parameter_changes: {}, execution_changes: { seed: -2_147_483_648 } })); context.base += 1; experimentId = (negative.body.experiment_revision as any).experiment_revision_id;
  for (const execution_changes of [{ seed: -2_147_483_649 }, { seed: 2_147_483_648 }, { horizon_days: 3661 }, { horizon_days: 10, warmup_days: 10 }]) expectApi("invalid_request", () => store.createExperiment(command(context, { operation: "edit", parent_experiment_revision_id: experimentId, parameter_changes: {}, execution_changes })));
  const maximum = store.createExperiment(command(context, { operation: "edit", parent_experiment_revision_id: experimentId, parameter_changes: {}, execution_changes: { horizon_days: 3660 } })); assert.equal((maximum.body.experiment_revision as any).execution_values.horizon_days, 3660);
  const projection = store.publicProjection(context.projectId); const text = JSON.stringify(projection); assert.equal("previous_event_digest" in projection, false); assert.equal("snapshot_digest" in projection, false); assert.equal(text.includes(root), false); assert.equal((projection as any).identity_assurance, "declared_unauthenticated_local");
  assert.deepEqual((projection as any).experiment.parameter_defaults, contract.parameter_defaults); assert.equal((projection as any).experiment.parameters.crew_count, 3); assert.deepEqual((projection as any).experiment.parameter_diff, []); assert.deepEqual((projection as any).experiment.execution_defaults, contract.execution_defaults); assert.equal((projection as any).review_summaries.human.count, 0); assert.equal((projection as any).review_summaries.agent.count, 0);
  assert.deepEqual(Object.keys((projection as any).actors[0]).sort(), ["actor_id", "actor_type", "declared_role", "display_name", "identity_assurance"]); assert.equal((projection as any).actors[0].actor_type, "human"); assert.equal((projection as any).actors[0].declared_role, "project_owner"); assert.equal((projection as any).actors[0].identity_assurance, "declared_unauthenticated_local"); assert.equal("actor_ids" in projection, false);
}));

test("sensitive text, control characters and oversized collections fail before mutation", () => withStore((_root, store) => {
  expectApi("sensitive_text_rejected", () => store.createProject({ command_id: commandId(), display_name: "api_key=super-secret", initial_actor: { actor_type: "human", display_name: "Owner", declared_role: "project_owner" } }));
  const context = bootstrap(store); const revision = store.snapshot(context.projectId).snapshot_revision;
  expectApi("sensitive_text_rejected", () => store.createBrief(command(context, { operation: "create" as const, parent_decision_brief_revision_id: null, question: "bad\u0001text", decision_owner: "Owner", objective: "Objective", constraints: [], assumptions: [], non_goals: [], sources: [source] })));
  expectApi("sensitive_text_rejected", () => store.createBrief(command(context, { operation: "create" as const, parent_decision_brief_revision_id: null, question: "Question", decision_owner: "Owner", objective: "Objective", constraints: [], assumptions: [], non_goals: ["-----BEGIN PRIVATE KEY-----"], sources: [source] })));
  expectApi("payload_too_large", () => store.createBrief(command(context, { operation: "create" as const, parent_decision_brief_revision_id: null, question: "Question", decision_owner: "Owner", objective: "Objective", constraints: [], assumptions: [], non_goals: Array.from({ length: 257 }, (_, index) => `goal-${index}`), sources: [source] })));
  assert.equal(store.snapshot(context.projectId).snapshot_revision, revision);
}));

test("actor authorization reloads exact committed identity and rejects agent-to-human or role tampering before mutation", () => {
  for (const field of ["actor_type", "declared_role"] as const) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), `riff-actor-tamper-${field}-`))); const store = new DurableProjectStore(root, { modelContracts: [contract] });
    try { const owner = fullyConfigured(store); const created = store.createActor(command(owner, { actor_type: "agent", display_name: "Reviewer agent", declared_role: "assistant" })); owner.base = Number(created.body.snapshot_revision); const actor = (created.body.actor as any); const session = store.attachSession(owner.projectId, actor.actor_id); const actorPath = join(root, "projects", owner.projectId, "actors", `${actor.actor_id}.json`); const forged = JSON.parse(readFileSync(actorPath, "utf8")); forged[field] = field === "actor_type" ? "human" : "project_owner"; writeFileSync(actorPath, canonicalJsonV2(forged)); const beforeEvents = readdirSync(join(root, "projects", owner.projectId, "project-events")).length; const forgedContext: Context = { projectId: owner.projectId, actorId: actor.actor_id, sessionId: session.session_id, base: owner.base }; const experiment = store.snapshot(owner.projectId).current.experiment_revision_id!; expectApi("immutable_record_corrupt", () => store.createIssue(command(forgedContext, { subject_revision_ids: [experiment], title: "Tampered actor", body: "Must not commit", severity: "warning", blocking: false, assignee_actor_id: null }))); assert.equal(readdirSync(join(root, "projects", owner.projectId, "project-events")).length, beforeEvents); }
    finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  }
});

test("actor authorization ignores and quarantines an uncommitted actor event beyond the trusted head", () => withStore((root, store) => {
  const context = fullyConfigured(store); const head = store.snapshot(context.projectId); const actorId = `actor_${"e".repeat(32)}`; const now = "2026-07-21T00:00:00.000Z";
  const actor = { schema_version: 1, canonical_json_version: "riff-canonical-json-v2", actor_id: actorId, actor_type: "agent", display_name: "Uncommitted actor", declared_role: "assistant", identity_assurance: "declared_unauthenticated_local", created_at: now };
  const actorDigest = `adr_${canonicalDigest(actor)}`; const projectDirectory = join(root, "projects", context.projectId); writeFileSync(join(projectDirectory, "actors", `${actorId}.json`), canonicalJsonV2(actor));
  const { snapshot_digest: _snapshotDigest, previous_event_digest: _previousEventDigest, ...candidate } = head;
  const next = { ...candidate, snapshot_revision: head.snapshot_revision + 1, actor_ids: [...head.actor_ids, actorId], updated_at: now };
  const unsigned: any = { schema_version: 1, canonical_json_version: "riff-canonical-json-v2", project_id: context.projectId, snapshot_revision: next.snapshot_revision, previous_snapshot_revision: head.snapshot_revision, previous_event_digest: head.previous_event_digest, event_digest: "", command_id: crypto.randomUUID(), command_digest: `cmd_${"a".repeat(64)}`, initiator: "client", session_id: context.sessionId, actor_id: context.actorId, system_component: null, event_type: "actor.created", record_refs: [{ kind: "actor", id: actorId, digest: actorDigest }], state_patch: [{ op: "replace", path: "", value: next }], response_status: 201, response_projection: { actor, snapshot_revision: next.snapshot_revision }, committed_at: now };
  const extra = withRecordDigest(unsigned, "event_digest", "pe_"); const extraPath = join(projectDirectory, "project-events", `${String(next.snapshot_revision).padStart(20, "0")}.json`); writeFileSync(extraPath, canonicalJsonV2(extra));
  expectApi("immutable_record_corrupt", () => store.attachSession(context.projectId, actorId));
  assert.equal(existsSync(extraPath), false); assert.ok(readdirSync(join(root, "quarantine")).some((name) => name.startsWith(`uncommitted-project-event-${context.projectId}-`))); assert.equal(store.snapshot(context.projectId).snapshot_revision, head.snapshot_revision);
}));

test("coordinated actor and committed event ref tampering still fails against the trusted snapshot head", () => withStore((root, store) => {
  const owner = fullyConfigured(store); const created = store.createActor(command(owner, { actor_type: "agent", display_name: "Reviewer agent", declared_role: "assistant" })); owner.base = Number(created.body.snapshot_revision); const actor = created.body.actor as any; const session = store.attachSession(owner.projectId, actor.actor_id); const projectDirectory = join(root, "projects", owner.projectId);
  const actorPath = join(projectDirectory, "actors", `${actor.actor_id}.json`); const forged = JSON.parse(readFileSync(actorPath, "utf8")); forged.actor_type = "human"; forged.declared_role = "project_owner"; writeFileSync(actorPath, canonicalJsonV2(forged)); const forgedDigest = `adr_${canonicalDigest(forged)}`;
  const eventPath = join(projectDirectory, "project-events", `${String(owner.base).padStart(20, "0")}.json`); const event = JSON.parse(readFileSync(eventPath, "utf8")); const ref = event.record_refs.find((item: any) => item.kind === "actor" && item.id === actor.actor_id); assert.ok(ref); ref.digest = forgedDigest; writeFileSync(eventPath, canonicalJsonV2(withRecordDigest(event, "event_digest", "pe_")));
  const beforeEvents = readdirSync(join(projectDirectory, "project-events")).length; const forgedContext: Context = { projectId: owner.projectId, actorId: actor.actor_id, sessionId: session.session_id, base: owner.base }; const experiment = store.snapshot(owner.projectId).current.experiment_revision_id!;
  expectApi("project_corrupt", () => store.createIssue(command(forgedContext, { subject_revision_ids: [experiment], title: "Coordinated tamper", body: "Must not commit", severity: "warning", blocking: false, assignee_actor_id: null })));
  assert.equal(readdirSync(join(projectDirectory, "project-events")).length, beforeEvents);
}));

test("nested request shape matrices return stable validation_error without mutation", () => {
  const briefRoot = realpathSync(mkdtempSync(join(tmpdir(), "riff-shape-brief-"))); const briefStore = new DurableProjectStore(briefRoot, { modelContracts: [contract] });
  try { const context = bootstrap(briefStore); const before = briefStore.snapshot(context.projectId).snapshot_revision; expectApi("validation_error", () => briefStore.createBrief(command(context, { operation: "create", parent_decision_brief_revision_id: null, question: "Question", decision_owner: "Owner", objective: "Objective", constraints: [null], assumptions: [], non_goals: [], sources: [source] } as any))); assert.equal(briefStore.snapshot(context.projectId).snapshot_revision, before); }
  finally { briefStore.close(); rmSync(briefRoot, { recursive: true, force: true }); }
  const root = realpathSync(mkdtempSync(join(tmpdir(), "riff-shape-matrix-"))); const store = new DurableProjectStore(root, { modelContracts: [contract] });
  try { const context = fullyConfigured(store); const experiment = store.snapshot(context.projectId).current.experiment_revision_id!; const before = store.snapshot(context.projectId).snapshot_revision; const attestationBase = { subject_revision_ids: [experiment], scope: "workflow_progression", decision: "endorse", rationale: "Review", issue_ids: [] };
    for (const supersedes_by_subject of [null, [], Object.create({ inherited: "att_" })]) expectApi("validation_error", () => store.createAttestations(command(context, { ...attestationBase, supersedes_by_subject } as any)));
    expectApi("validation_error", () => store.createAttestations(command(context, { ...attestationBase, issue_ids: null, supersedes_by_subject: {} } as any)));
    expectApi("validation_error", () => store.createIssue(command(context, { subject_revision_ids: null, title: "Issue", body: "Body", severity: "warning", blocking: false, assignee_actor_id: null } as any)));
    expectApi("validation_error", () => store.createIssue(command(context, { subject_revision_ids: [experiment], title: "Issue", body: "Body", severity: "warning", blocking: false, assignee_actor_id: [] } as any)));
    expectApi("validation_error", () => store.startRun(command(context, { experiment_revision_id: null } as any)));
    expectApi("validation_error", () => store.cancelRun({ ...command(context, { run_id: null } as any) }));
    assert.equal(store.snapshot(context.projectId).snapshot_revision, before);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("absolute path text and configured workspace-root occurrences are rejected under punctuation and assignment", () => withStore((root, store) => {
  for (const display_name of ["/tmp", "/etc", "x=/tmp", "workspace=/Users/alice/private/run", "path:\"/Users/alice/private/run\"", "root:/var/tmp/private/run", "quoted='/opt/private/run'", "windows=C:\\Users\\alice\\private", `workspace=${root}`]) expectApi("sensitive_text_rejected", () => store.createProject({ command_id: commandId(), display_name, initial_actor: { actor_type: "human", display_name: "Owner", declared_role: "project_owner" } }));
  assert.equal(store.createProject({ command_id: commandId(), display_name: "Compare failure/repair outcomes", initial_actor: { actor_type: "human", display_name: "Owner", declared_role: "project_owner" } }).status, 201);
}));

test("active pending run guards pointer changes and local terminal evidence releases it", () => withStore((root, store) => {
  const context = fullyConfigured(store); const snapshot = store.snapshot(context.projectId); const experimentId = snapshot.current.experiment_revision_id!;
  const started = store.startRun(command(context, { experiment_revision_id: experimentId })); const runId = started.body.run_id as string; context.base += 1;
  const runDirectory = join(root, "projects", context.projectId, "run-intents", runId); const intent = JSON.parse(readFileSync(join(runDirectory, "intent.json"), "utf8")); const admission = JSON.parse(readFileSync(join(runDirectory, "admission.json"), "utf8")); const policy = JSON.parse(readFileSync(join(runDirectory, "policy-snapshot.json"), "utf8")); assert.match(intent.run_intent_digest, /^ri_[0-9a-f]{64}$/); assert.match(admission.run_admission_digest, /^ra_[0-9a-f]{64}$/); assert.match(policy.policy_snapshot_digest, /^ps_[0-9a-f]{64}$/);
  expectApi("active_run_conflict", () => store.createExperiment(command(context, { operation: "edit", parent_experiment_revision_id: experimentId, parameter_changes: { crew_count: 7 }, execution_changes: {} })));
  const activeRevision = store.snapshot(context.projectId).snapshot_revision; expectApi("active_run_conflict", () => store.startRun(command(context, { experiment_revision_id: experimentId }))); assert.equal(store.snapshot(context.projectId).snapshot_revision, activeRevision);
  store.cancelRun(command(context, { run_id: runId })); context.base += 1; const tombstone = JSON.parse(readFileSync(join(runDirectory, "cancel-tombstone.json"), "utf8")); assert.match(tombstone.cancel_tombstone_digest, /^ct_[0-9a-f]{64}$/); store.publishLocalTerminal(context.projectId, runId, "cancelled_before_dispatch"); context.base += 1;
  assert.equal(store.snapshot(context.projectId).phase, "inspect");
  assert.doesNotThrow(() => store.createExperiment(command(context, { operation: "edit", parent_experiment_revision_id: experimentId, parameter_changes: { crew_count: 7 }, execution_changes: {} })));
  store.close(); const reopened = new DurableProjectStore(root, { modelContracts: [contract], localRunInspector: () => ({ mesa_receipt_absent: true, dispatch_owner_absent: true }) }); try { const recovered = reopened.snapshot(context.projectId).run_index.find((run) => run.run_id === runId)!; assert.equal(recovered.reference_kind, "terminal"); assert.equal(recovered.status, "cancelled"); } finally { reopened.close(); }
}, { localRunInspector: () => ({ mesa_receipt_absent: true, dispatch_owner_absent: true }) }));

test("pre-receipt admission failure is system-derived local evidence without a cancel tombstone", () => withStore((root, store) => {
  const context = fullyConfigured(store); const experimentId = store.snapshot(context.projectId).current.experiment_revision_id!; const started = store.startRun(command(context, { experiment_revision_id: experimentId })); const runId = started.body.run_id as string; const rejection = { code: "run_admission_mismatch", safe_message: "The Mesa request differs from the admitted run." }; store.markRunDispatch(context.projectId, runId, "in_flight"); store.markRunDispatch(context.projectId, runId, "rejection_observed", rejection); store.markRunDispatch(context.projectId, runId, "rejection_observed", rejection); store.markRunDispatch(context.projectId, runId, "stable_rejected", rejection); const result = store.publishLocalTerminal(context.projectId, runId, "pre_receipt_admission_failed"); assert.equal((result.body.run as any).status, "failed"); assert.equal((result.body.run as any).terminal_evidence_source, "local_run_terminal_evidence"); const intentDir = join(root, "projects", context.projectId, "run-intents", runId); assert.equal(existsSync(join(intentDir, "cancel-tombstone.json")), false); const evidenceDir = join(root, "projects", context.projectId, "run-terminal-evidence", runId); const evidence = JSON.parse(readFileSync(join(evidenceDir, readdirSync(evidenceDir)[0]), "utf8")); assert.equal(evidence.cancel_tombstone_digest, null); assert.match(evidence.local_terminal_evidence_digest, /^lte_[0-9a-f]{64}$/);
}, { localRunInspector: () => ({ mesa_receipt_absent: true, dispatch_owner_absent: true, failure: { code: "run_admission_mismatch", safe_message: "The Mesa request differs from the admitted run." } }) }));

test("only independently verified Mesa records advance states and late historical observations do not rewind current state", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "riff-mesa-evidence-"))); const states = new Map<string, MesaFixtureState>(); const provider = mesaEvidenceFixture(root, states); const store = new DurableProjectStore(root, { modelContracts: [contract], mesaEvidenceProvider: provider });
  try {
    assert.equal((store as any).recordRunReference, undefined); const context = fullyConfigured(store); let experimentId = store.snapshot(context.projectId).current.experiment_revision_id!; const started = store.startRun(command(context, { experiment_revision_id: experimentId })); const firstRun = started.body.run_id as string; context.base += 1;
    states.set(firstRun, "running"); expectApi("invalid_run_transition", () => store.reconcileVerifiedMesaState(context.projectId, firstRun)); states.set(firstRun, "queued"); store.reconcileVerifiedMesaState(context.projectId, firstRun); states.set(firstRun, "running"); store.reconcileVerifiedMesaState(context.projectId, firstRun); writeMesaArtifactFixture(root, context.projectId, firstRun); states.set(firstRun, "succeeded"); store.reconcileVerifiedMesaState(context.projectId, firstRun);
    const terminal = store.snapshot(context.projectId).run_index.find((run) => run.run_id === firstRun)! as any; assert.equal(terminal.reference_kind, "terminal"); assert.equal(terminal.artifact_ids.length, 8); assert.equal(new Set(terminal.artifact_ids).size, 8);
    const systemEvents = readdirSync(join(root, "projects", context.projectId, "project-events")).map((name) => JSON.parse(readFileSync(join(root, "projects", context.projectId, "project-events", name), "utf8"))).filter((event) => event.initiator === "system"); assert.ok(systemEvents.length >= 3); assert.ok(systemEvents.every((event) => event.actor_id === null && event.session_id === null && event.system_component === "backend_run_reconciler")); const terminalRefs = systemEvents.at(-1).record_refs; assert.equal(terminalRefs.filter((ref: any) => ref.kind === "mesa_lifecycle_record").length, 7); assert.equal(terminalRefs.some((ref: any) => ref.kind === "mesa_run_receipt"), true); assert.equal(terminalRefs.some((ref: any) => ref.kind === "mesa_terminal_metadata"), true);
    context.base = store.snapshot(context.projectId).snapshot_revision; const edited = store.createExperiment(command(context, { operation: "edit", parent_experiment_revision_id: experimentId, parameter_changes: { crew_count: 5 }, execution_changes: {} })); context.base += 1; experimentId = (edited.body.experiment_revision as any).experiment_revision_id; const second = store.startRun(command(context, { experiment_revision_id: experimentId })); const secondRun = second.body.run_id as string; const before = store.snapshot(context.projectId); store.reconcileVerifiedMesaState(context.projectId, firstRun); const after = store.snapshot(context.projectId); assert.equal(after.current.run_id, secondRun); assert.equal(after.phase, "run"); assert.equal(after.snapshot_revision, before.snapshot_revision);
    store.close(); const reopened = new DurableProjectStore(root, { modelContracts: [contract], mesaEvidenceProvider: provider }); try { const recovered = reopened.snapshot(context.projectId).run_index.find((run) => run.run_id === firstRun)! as any; assert.equal(recovered.status, "succeeded"); assert.deepEqual(recovered.artifact_ids, terminal.artifact_ids); } finally { reopened.close(); }
    writeFileSync(join(root, "mesa-provider-fixture", context.projectId, firstRun, "summary.json"), "changed source artifact bytes"); const corruptReopen = new DurableProjectStore(root, { modelContracts: [contract], mesaEvidenceProvider: provider }); try { expectApi("project_corrupt", () => corruptReopen.snapshot(context.projectId)); } finally { corruptReopen.close(); }
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("verifier-facing terminal metadata supplies every quantitative cancel outcome", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "riff-cancel-outcomes-"))); const states = new Map<string, MesaFixtureState>(); const provider = mesaEvidenceFixture(root, states); const store = new DurableProjectStore(root, { modelContracts: [contract], mesaEvidenceProvider: provider });
  try { const context = fullyConfigured(store); const expected = { succeeded: "completed_before_cancel_effect", failed: "failed_before_cancel_effect", timed_out: "timed_out_before_cancel_effect", cancelled: "cancelled_by_worker" } as const; for (const status of Object.keys(expected) as Array<keyof typeof expected>) { const started = store.startRun(command(context, { experiment_revision_id: store.snapshot(context.projectId).current.experiment_revision_id! })); const runId = String(started.body.run_id); context.base = Number(started.body.snapshot_revision); states.set(runId, "queued"); store.reconcileVerifiedMesaState(context.projectId, runId); context.base = store.snapshot(context.projectId).snapshot_revision; store.cancelRun(command(context, { run_id: runId })); context.base = store.snapshot(context.projectId).snapshot_revision; states.set(runId, status); if (status === "succeeded") writeMesaArtifactFixture(root, context.projectId, runId); store.reconcileVerifiedMesaState(context.projectId, runId); const terminal = store.run(context.projectId, runId) as any; assert.equal(terminal.status, status); assert.equal(terminal.cancel_outcome, expected[status]); context.base = store.snapshot(context.projectId).snapshot_revision; } }
  finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("receipt-present pre-spawn cancellation is provider-declared and cancel outcome digest or identity tampering fails closed", () => {
  for (const mode of ["valid", "digest_tamper", "identity_tamper"] as const) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), `riff-pre-spawn-${mode}-`))); const states = new Map<string, MesaFixtureState>(); const baseProvider = mesaEvidenceFixture(root, states); let context!: Context; let runId = ""; const provider = (projectId: string, seenRun: string): VerifiedMesaRunEvidence => { const evidence = structuredClone(baseProvider(projectId, seenRun)); const tombstone = JSON.parse(readFileSync(join(root, "projects", projectId, "run-intents", seenRun, "cancel-tombstone.json"), "utf8")); evidence.terminal_metadata!.cancel_outcome = mode === "identity_tamper" ? "cancelled_by_worker" : "cancelled_before_dispatch"; if (mode !== "digest_tamper") { evidence.terminal_metadata = withRecordDigest(evidence.terminal_metadata as any, "terminal_metadata_digest", "tm_") as any; } const receipt = evidence.lifecycle_records[0]; const owner = evidence.lifecycle_records[1]; const cancel = withRecordDigest({ ...owner, mesa_lifecycle_digest: "", sequence: 2, previous_mesa_lifecycle_digest: owner.mesa_lifecycle_digest, state: "cancel_requested", child_identity: null, evidence_digest: tombstone.cancel_tombstone_digest, created_at: "2026-07-21T00:00:02.000Z" }, "mesa_lifecycle_digest", "mlr_") as any; const terminal = withRecordDigest({ ...cancel, mesa_lifecycle_digest: "", sequence: 3, previous_mesa_lifecycle_digest: cancel.mesa_lifecycle_digest, state: "terminal_cancelled", evidence_digest: evidence.terminal_metadata!.terminal_metadata_digest, created_at: "2026-07-21T00:00:03.000Z" }, "mesa_lifecycle_digest", "mlr_") as any; evidence.lifecycle_records = [receipt, owner, cancel, terminal]; return evidence; }; const store = new DurableProjectStore(root, { modelContracts: [contract], mesaEvidenceProvider: provider });
    try { context = fullyConfigured(store); const started = store.startRun(command(context, { experiment_revision_id: store.snapshot(context.projectId).current.experiment_revision_id! })); runId = String(started.body.run_id); context.base = Number(started.body.snapshot_revision); store.cancelRun(command(context, { run_id: runId })); states.set(runId, "cancelled"); if (mode === "valid") { store.reconcileVerifiedMesaState(context.projectId, runId); assert.equal((store.run(context.projectId, runId) as any).cancel_outcome, "cancelled_before_dispatch"); } else expectApi("mesa_run_corrupt", () => store.reconcileVerifiedMesaState(context.projectId, runId)); }
    finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  }
});

test("Mesa identity or digest mismatch fails without a project event", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "riff-mesa-mismatch-"))); const states = new Map<string, MesaFixtureState>(); const validProvider = mesaEvidenceFixture(root, states); let corrupt = false; const provider = (projectId: string, runId: string): VerifiedMesaRunEvidence => { const evidence = validProvider(projectId, runId); if (corrupt) evidence.receipt.run_id = `run_${"f".repeat(32)}`; return evidence; }; const store = new DurableProjectStore(root, { modelContracts: [contract], mesaEvidenceProvider: provider });
  try { const context = fullyConfigured(store); const experimentId = store.snapshot(context.projectId).current.experiment_revision_id!; const started = store.startRun(command(context, { experiment_revision_id: experimentId })); const runId = started.body.run_id as string; const revision = store.snapshot(context.projectId).snapshot_revision; states.set(runId, "queued"); corrupt = true; expectApi("mesa_run_corrupt", () => store.reconcileVerifiedMesaState(context.projectId, runId)); assert.equal(store.snapshot(context.projectId).snapshot_revision, revision); }
  finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("complete Mesa lifecycle verification rejects gaps, illegal transitions, double owners, and epoch rollback", () => {
  for (const corruption of ["gap", "illegal_transition", "double_owner", "epoch_rollback"] as const) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), `riff-mesa-chain-${corruption}-`))); const states = new Map<string, MesaFixtureState>(); const baseProvider = mesaEvidenceFixture(root, states); const provider = (projectId: string, runId: string): VerifiedMesaRunEvidence => { const evidence = baseProvider(projectId, runId); if (corruption === "gap") evidence.lifecycle_records.splice(2, 1); else { if (corruption === "illegal_transition") evidence.lifecycle_records[1].state = "worker_started"; else if (corruption === "double_owner") evidence.lifecycle_records[1].owner_instance_id = `mesa_owner_${"5".repeat(32)}`; else evidence.lifecycle_records[2].ownership_epoch = 0; recomputeMesaLifecycleDigests(evidence); } return evidence; }; const store = new DurableProjectStore(root, { modelContracts: [contract], mesaEvidenceProvider: provider });
    try { const context = fullyConfigured(store); const experiment = store.snapshot(context.projectId).current.experiment_revision_id!; const started = store.startRun(command(context, { experiment_revision_id: experiment })); const runId = started.body.run_id as string; states.set(runId, "running"); const revision = store.snapshot(context.projectId).snapshot_revision; expectApi("mesa_run_corrupt", () => store.reconcileVerifiedMesaState(context.projectId, runId)); assert.equal(store.snapshot(context.projectId).snapshot_revision, revision); }
    finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  }
});

test("cancellation-requested runs reverify the complete Mesa lifecycle chain on restart", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "riff-mesa-cancel-recovery-"))); const states = new Map<string, MesaFixtureState>(); const baseProvider = mesaEvidenceFixture(root, states); let corruptChain = false; const provider = (projectId: string, runId: string): VerifiedMesaRunEvidence => { const evidence = baseProvider(projectId, runId); if (corruptChain) evidence.lifecycle_records.splice(0, 1); return evidence; }; const store = new DurableProjectStore(root, { modelContracts: [contract], mesaEvidenceProvider: provider });
  try { const context = fullyConfigured(store); const experiment = store.snapshot(context.projectId).current.experiment_revision_id!; const started = store.startRun(command(context, { experiment_revision_id: experiment })); const runId = started.body.run_id as string; states.set(runId, "queued"); store.reconcileVerifiedMesaState(context.projectId, runId); context.base = store.snapshot(context.projectId).snapshot_revision; store.cancelRun(command(context, { run_id: runId })); store.close();
    const reopened = new DurableProjectStore(root, { modelContracts: [contract], mesaEvidenceProvider: provider }); try { assert.equal(reopened.snapshot(context.projectId).run_index.find((run) => run.run_id === runId)!.status, "cancellation_requested"); } finally { reopened.close(); }
    corruptChain = true; const corruptReopen = new DurableProjectStore(root, { modelContracts: [contract], mesaEvidenceProvider: provider }); try { expectApi("project_corrupt", () => corruptReopen.snapshot(context.projectId)); } finally { corruptReopen.close(); }
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("local terminal evidence is content-addressed and status-specific", () => {
  const unsigned: LocalRunTerminalEvidence = { schema_version: 1, canonical_json_version: "riff-canonical-json-v2", local_terminal_evidence_digest: "", project_id: `project_${"1".repeat(32)}`, run_id: `run_${"2".repeat(32)}`, terminal_status: "cancelled", outcome_code: "cancelled_before_dispatch", run_intent_digest: `ri_${"3".repeat(64)}`, run_admission_digest: `ra_${"4".repeat(64)}`, policy_snapshot_digest: `ps_${"5".repeat(64)}`, downstream_idempotency_key: `rk_${"6".repeat(64)}`, downstream_request_digest: `rq_${"7".repeat(64)}`, cancel_tombstone_digest: `ct_${"8".repeat(64)}`, evidence_base_snapshot_revision: 4, evidence_base_project_event_digest: `pe_${"9".repeat(64)}`, mesa_receipt_absent: true, dispatch_owner_absent: true, failure: null, created_at: "2026-07-21T00:00:00.000Z" };
  const { local_terminal_evidence_digest: _, ...body } = unsigned; const valid = { ...unsigned, local_terminal_evidence_digest: `lte_${canonicalDigest(body)}` };
  assert.doesNotThrow(() => DurableProjectStore.validateLocalTerminalEvidence(valid));
  expectApi("invalid_request", () => DurableProjectStore.validateLocalTerminalEvidence({ ...valid, failure: { code: "bad", safe_message: "bad" } }));
  expectApi("immutable_record_corrupt", () => DurableProjectStore.validateLocalTerminalEvidence({ ...valid, created_at: "2026-07-21T00:00:01.000Z" }));
});

test("issues are append-only committed facts and policy is quantitative with explicit supersession", () => withStore((_root, store) => {
  const context = fullyConfigured(store); const snapshot = store.snapshot(context.projectId); const alignment = snapshot.current.alignment_map_revision_id!; const experiment = snapshot.current.experiment_revision_id!;
  const issue = (store.createIssue(command(context, { subject_revision_ids: [alignment, experiment], title: "Check mapping", body: "Reviewer objection", severity: "warning" as const, blocking: true, assignee_actor_id: context.actorId })).body.issue as any); context.base += 1;
  let policy = store.policySnapshot(context.projectId); assert.equal(policy.alignment.open_blocking_issue_count, 1); assert.equal(policy.experiment.open_blocking_issue_count, 1); assert.equal(policy.open_issue_ids.length, 1); assert.equal(policy.alignment.wording, "recorded_open_objection"); assert.equal(policy.combined_policy_satisfied, false);
  const first = store.createAttestations(command(context, { subject_revision_ids: [alignment, experiment], scope: "workflow_progression" as const, decision: "endorse" as const, rationale: "Reviewed exact revisions", issue_ids: [], supersedes_by_subject: {} })); context.base += 1;
  assert.equal((first.body.attestations as any[]).length, 2); policy = store.policySnapshot(context.projectId); assert.equal(policy.alignment.human_project_owner_endorsement_count, 1); assert.equal(policy.combined_policy_satisfied, false);
  expectApi("attestation_supersession_required", () => store.createAttestations(command(context, { subject_revision_ids: [alignment], scope: "workflow_progression", decision: "endorse", rationale: "Again", issue_ids: [], supersedes_by_subject: {} })));
  store.appendIssueEvent(command(context, { issue_id: issue.issue_id, event_type: "resolved" as const, reason: "Addressed" })); context.base += 1;
  policy = store.policySnapshot(context.projectId); assert.equal(policy.combined_policy_satisfied, true); assert.equal(policy.alignment.wording, "no_recorded_open_objection");
  const old = (first.body.attestations as any[]).find((item) => item.subject_revision_id === alignment);
  store.createAttestations(command(context, { subject_revision_ids: [alignment], scope: "workflow_progression", decision: "abstain", rationale: "Withdraw", issue_ids: [], supersedes_by_subject: { [alignment]: old.attestation_id } }));
  assert.equal(store.policySnapshot(context.projectId).alignment.human_project_owner_endorsement_count, 0);
}));

test("initial issue assignment is owner-only and human/Agent review summaries remain separate", () => withStore((_root, store) => {
  const owner = fullyConfigured(store); const experiment = store.snapshot(owner.projectId).current.experiment_revision_id!; const createdAgent = store.createActor(command(owner, { actor_type: "agent" as const, display_name: "Review Agent", declared_role: "assistant" as const })); owner.base += 1; const agentId = (createdAgent.body.actor as any).actor_id; const agent: Context = { projectId: owner.projectId, actorId: agentId, sessionId: store.attachSession(owner.projectId, agentId).session_id, base: owner.base };
  store.createAttestations(command(agent, { subject_revision_ids: [experiment], scope: "technical_review" as const, decision: "endorse" as const, rationale: "Agent review recorded", issue_ids: [], supersedes_by_subject: {} })); owner.base += 1; agent.base += 1;
  store.createAttestations(command(owner, { subject_revision_ids: [experiment], scope: "workflow_progression" as const, decision: "endorse" as const, rationale: "Owner review recorded", issue_ids: [], supersedes_by_subject: {} })); owner.base += 1; agent.base += 1;
  const projection = store.publicProjection(owner.projectId) as any; assert.equal(projection.review_summaries.human.count, 1); assert.equal(projection.review_summaries.agent.count, 1); assert.equal(projection.review_summaries.human.items[0].actor_type, "human"); assert.equal(projection.review_summaries.agent.items[0].actor_type, "agent"); assert.deepEqual(projection.actors.map((item: any) => item.actor_type).sort(), ["agent", "human"]); assert.ok(projection.actors.every((item: any) => item.identity_assurance === "declared_unauthenticated_local"));
  expectApi("actor_permission_denied", () => store.createIssue(command(agent, { subject_revision_ids: [experiment], title: "Assigned objection", body: "Agent cannot assign initially", severity: "warning" as const, blocking: false, assignee_actor_id: agentId }))); assert.equal(store.snapshot(owner.projectId).snapshot_revision, owner.base);
  const unassigned = store.createIssue(command(agent, { subject_revision_ids: [experiment], title: "Unassigned observation", body: "No initial assignee", severity: "info" as const, blocking: false, assignee_actor_id: null })); assert.equal((unassigned.body.issue as any).assignee_actor_id, null);
}));

test("run policy is frozen at its historical event and later issues do not rewrite it", () => withStore((root, store) => {
  const context = fullyConfigured(store); const experiment = store.snapshot(context.projectId).current.experiment_revision_id!; const started = store.startRun(command(context, { experiment_revision_id: experiment })); const runId = started.body.run_id as string; context.base += 1; const policyPath = join(root, "projects", context.projectId, "run-intents", runId, "policy-snapshot.json"); const frozen = readFileSync(policyPath);
  store.createIssue(command(context, { subject_revision_ids: [experiment], title: "Later objection", body: "Created after admission", severity: "critical" as const, blocking: true, assignee_actor_id: context.actorId })); assert.equal(store.policySnapshot(context.projectId).experiment.open_blocking_issue_count, 1); assert.equal(readFileSync(policyPath).equals(frozen), true); store.close();
  const reopened = new DurableProjectStore(root, { modelContracts: [contract] }); try { assert.equal(readFileSync(policyPath).equals(frozen), true); assert.equal(reopened.snapshot(context.projectId).run_index.find((run) => run.run_id === runId)!.workflow_label, "workflow_policy_unmet"); }
  finally { reopened.close(); }
}));

test("policy derivation reloads immutable actor, issue, and attestation facts instead of snapshot summaries", () => {
  for (const family of ["actor", "issue", "attestation"] as const) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), `riff-policy-${family}-`))); const store = new DurableProjectStore(root, { modelContracts: [contract] });
    try { const context = fullyConfigured(store); const experiment = store.snapshot(context.projectId).current.experiment_revision_id!; let path: string; if (family === "actor") path = join(root, "projects", context.projectId, "actors", `${context.actorId}.json`); else if (family === "issue") { const issue = store.createIssue(command(context, { subject_revision_ids: [experiment], title: "Issue", body: "Original", severity: "warning" as const, blocking: true, assignee_actor_id: null })).body.issue as any; path = join(root, "projects", context.projectId, "issues", issue.issue_id, "events", "00000000000000000000.json"); } else { const attestation = (store.createAttestations(command(context, { subject_revision_ids: [experiment], scope: "workflow_progression" as const, decision: "endorse" as const, rationale: "Original", issue_ids: [], supersedes_by_subject: {} })).body.attestations as any[])[0]; path = join(root, "projects", context.projectId, "attestations", `${attestation.attestation_id}.json`); } const changed = JSON.parse(readFileSync(path, "utf8")); if (family === "actor") changed.display_name = "Changed actor"; else if (family === "issue") changed.payload.body = "Changed issue"; else changed.rationale = "Changed attestation"; writeFileSync(path, canonicalJsonV2(changed)); expectApi("project_corrupt", () => store.policySnapshot(context.projectId)); }
    finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  }
});

test("historical policy rejects actor-role mismatch and broken effective supersession even with recomputed record refs", () => {
  for (const mismatch of ["actor_role", "supersession"] as const) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), `riff-policy-${mismatch}-`))); const store = new DurableProjectStore(root, { modelContracts: [contract] });
    try { const context = fullyConfigured(store); const experiment = store.snapshot(context.projectId).current.experiment_revision_id!; const first = (store.createAttestations(command(context, { subject_revision_ids: [experiment], scope: "workflow_progression" as const, decision: "endorse" as const, rationale: "First", issue_ids: [], supersedes_by_subject: {} })).body.attestations as any[])[0]; context.base += 1; let target = first; if (mismatch === "supersession") target = (store.createAttestations(command(context, { subject_revision_ids: [experiment], scope: "workflow_progression" as const, decision: "abstain" as const, rationale: "Second", issue_ids: [], supersedes_by_subject: { [experiment]: first.attestation_id } })).body.attestations as any[])[0]; rewriteAttestationAndCommittedRef(root, context.projectId, target.attestation_id, (record) => { if (mismatch === "actor_role") { record.actor_type = "agent"; record.declared_role = "assistant"; } else record.supersedes_attestation_id = null; }); expectApi("project_corrupt", () => store.policySnapshot(context.projectId)); }
    finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  }
});

test("strict IDs and exact project-owned attachment and subject references are fail-closed", () => withStore((root, store) => {
  const first = bootstrap(store); const attachmentId = `attachment_${"a".repeat(32)}`; const attachmentDirectory = join(root, "projects", first.projectId, "inputs", "attachments"); mkdirSync(attachmentDirectory, { recursive: true }); writeFileSync(join(attachmentDirectory, `${attachmentId}.json`), canonicalJsonV2({ schema_version: 1, canonical_json_version: "riff-canonical-json-v2", attachment_id: attachmentId, project_id: first.projectId }));
  const uploaded = { source_id: "uploaded-1", kind: "uploaded_file" as const, label: "Local turbine data", attachment_id: attachmentId }; const brief = (store.createBrief(command(first, { operation: "create" as const, parent_decision_brief_revision_id: null, question: "Question", decision_owner: "Owner", objective: "Objective", constraints: [], assumptions: [], non_goals: [], sources: [uploaded] })).body.decision_brief_revision as any); first.base += 1;
  const second = bootstrap(store); expectApi("resource_not_found", () => store.createBrief(command(second, { operation: "create" as const, parent_decision_brief_revision_id: null, question: "Question", decision_owner: "Owner", objective: "Objective", constraints: [], assumptions: [], non_goals: [], sources: [uploaded] })));
  expectApi("resource_not_found", () => store.snapshot(`${first.projectId}/..`)); expectApi("resource_not_found", () => store.actor(first.projectId, `${first.actorId}/..`)); expectApi("resource_not_found", () => store.createBrief({ ...command(first, { operation: "revise" as const, parent_decision_brief_revision_id: brief.decision_brief_revision_id, question: "Question", decision_owner: "Owner", objective: "Objective", constraints: [], assumptions: [], non_goals: [], sources: [source] }), session_id: `${first.sessionId}/..` }));
  expectApi("resource_not_found", () => store.createIssue(command(second, { subject_revision_ids: [brief.decision_brief_revision_id], title: "Cross-project", body: "Foreign subject", severity: "warning" as const, blocking: true, assignee_actor_id: null }))); expectApi("resource_not_found", () => store.reconcileVerifiedMesaState(first.projectId, `run_${"a".repeat(31)}/`));
  store.close(); unlinkSync(join(attachmentDirectory, `${attachmentId}.json`)); const reopened = new DurableProjectStore(root, { modelContracts: [contract] }); try { expectApi("project_corrupt", () => reopened.snapshot(first.projectId)); assert.equal(reopened.snapshot(second.projectId).project_id, second.projectId); } finally { reopened.close(); }
}));

test("an uncommitted issue event remains invisible and is quarantined on restart", () => withStore((root, store) => {
  const context = fullyConfigured(store);
  const experiment = store.snapshot(context.projectId).current.experiment_revision_id!;
  const created = store.createIssue(command(context, { subject_revision_ids: [experiment], title: "Objection", body: "Open", severity: "warning" as const, blocking: true, assignee_actor_id: context.actorId }));
  const issue = created.body.issue as any;
  const eventId = `issue_event_${"e".repeat(32)}`;
  const prior = issue.latest_issue_event_digest;
  store.close();
  const directory = join(root, "projects", context.projectId, "issues", issue.issue_id, "events");
  const unsigned: any = { schema_version: 1, canonical_json_version: "riff-canonical-json-v2", issue_event_id: eventId, project_id: context.projectId, issue_id: issue.issue_id, sequence: 1, previous_issue_event_digest: prior, issue_event_digest: "", event_type: "resolved", actor_id: context.actorId, payload: { reason: "not committed" }, created_at: "2026-07-21T00:00:00.000Z" };
  const { issue_event_digest: _, ...body } = unsigned;
  unsigned.issue_event_digest = `ied_${canonicalDigest(body)}`;
  writeFileSync(join(directory, "00000000000000000001.json"), canonicalJsonV2(unsigned));
  const reopened = new DurableProjectStore(root, { modelContracts: [contract] }); try { assert.equal(reopened.snapshot(context.projectId).issue_index.find((item) => item.issue_id === issue.issue_id)!.status, "open"); assert.equal(reopened.policySnapshot(context.projectId).experiment.open_blocking_issue_count, 1); assert.equal(existsSync(join(directory, "00000000000000000001.json")), false); assert.ok(readdirSync(join(root, "quarantine")).some((name) => name.includes(eventId))); } finally { reopened.close(); }
}));

test("corruption anywhere in the committed issue chain fails recovery closed", () => withStore((root, store) => {
  const context = fullyConfigured(store);
  const experiment = store.snapshot(context.projectId).current.experiment_revision_id!;
  const created = store.createIssue(command(context, { subject_revision_ids: [experiment], title: "Objection", body: "Open", severity: "warning" as const, blocking: true, assignee_actor_id: context.actorId }));
  const issue = created.body.issue as any;
  context.base += 1;
  store.appendIssueEvent(command(context, { issue_id: issue.issue_id, event_type: "commented" as const, body: "Discussion" }));
  const healthy = bootstrap(store);
  store.close();
  const eventZero = join(root, "projects", context.projectId, "issues", issue.issue_id, "events", "00000000000000000000.json"); const changed = JSON.parse(readFileSync(eventZero, "utf8")); changed.payload.body = "tampered"; writeFileSync(eventZero, JSON.stringify(changed)); const reopened = new DurableProjectStore(root, { modelContracts: [contract] });
  try { expectApi("project_corrupt", () => reopened.snapshot(context.projectId)); assert.equal(reopened.snapshot(healthy.projectId).project_id, healthy.projectId); const healthySession = reopened.attachSession(healthy.projectId, healthy.actorId); const healthyContext = { ...healthy, sessionId: healthySession.session_id }; assert.equal(reopened.createBrief(command(healthyContext, { operation: "create" as const, parent_decision_brief_revision_id: null, question: "Healthy project", decision_owner: "Owner", objective: "Continue", constraints: [], assumptions: [], non_goals: [], sources: [source] })).status, 201); }
  finally { reopened.close(); }
}));

test("event-committed snapshot is recovered when cache is missing or truncated; event hash drift fails closed", () => withStore((root, store) => {
  const context = fullyConfigured(store); const expected = store.snapshot(context.projectId); store.close();
  const cache = join(root, "projects", context.projectId, "project.json"); truncateSync(cache, 2);
  const recovered = new DurableProjectStore(root, { modelContracts: [contract] }); try { assert.deepEqual(recovered.snapshot(context.projectId), expected); } finally { recovered.close(); }
  const event = join(root, "projects", context.projectId, "project-events", "00000000000000000004.json"); const changed = JSON.parse(readFileSync(event, "utf8")); changed.event_type = "tampered"; writeFileSync(event, JSON.stringify(changed));
  const isolated = new DurableProjectStore(root, { modelContracts: [contract] }); try { expectApi("project_corrupt", () => isolated.snapshot(context.projectId)); } finally { isolated.close(); }
}));

test("content-addressed experiment mutation fails project recovery closed", () => withStore((root, store) => {
  const context = fullyConfigured(store); const experimentId = store.snapshot(context.projectId).current.experiment_revision_id!; store.close();
  const path = join(root, "projects", context.projectId, "experiments", "revisions", experimentId, "experiment.json"); const changed = JSON.parse(readFileSync(path, "utf8")); changed.execution_values.seed += 1; writeFileSync(path, JSON.stringify(changed));
  const reopened = new DurableProjectStore(root, { modelContracts: [contract] }); try { expectApi("project_corrupt", () => reopened.snapshot(context.projectId)); } finally { reopened.close(); }
}));

const source = { source_id: "source-1", kind: "user_declared" as const, label: "Owner statement" };
type Context = { projectId: string; actorId: string; sessionId: string; base: number };
const command = <T>(context: Context, payload: T): ProjectCommand<T> => ({ command_id: commandId(), project_id: context.projectId, session_id: context.sessionId, base_snapshot_revision: context.base, payload });
const bootstrap = (store: DurableProjectStore): Context => { const created = store.createProject({ command_id: commandId(), display_name: "Wind", initial_actor: { actor_type: "human", display_name: "Owner", declared_role: "project_owner" } }); const projectId = (created.body.project as any).project_id; const actorId = (created.body.initial_actor as any).actor_id; const sessionId = store.attachSession(projectId, actorId).session_id; const context = { projectId, actorId, sessionId, base: 0 }; store.selectModel(command(context, { model_revision_id: contract.model_revision_id })); context.base = 1; return context; };
const fullyConfigured = (store: DurableProjectStore): Context => { const context = bootstrap(store); const brief = (store.createBrief(command(context, { operation: "create" as const, parent_decision_brief_revision_id: null, question: "Question", decision_owner: "Owner", objective: "Objective", constraints: [], assumptions: [], non_goals: [], sources: [source] })).body.decision_brief_revision as any); context.base += 1; const alignment = (store.createAlignment(command(context, { operation: "create" as const, parent_alignment_map_revision_id: null, decision_brief_revision_id: brief.decision_brief_revision_id, model_id: contract.model_id, model_revision_id: contract.model_revision_id, entries: [], known_gaps: [] })).body.alignment_map_revision as any); context.base += 1; store.createExperiment(command(context, { operation: "create", parent_experiment_revision_id: null, brief_revision_id: brief.decision_brief_revision_id, alignment_revision_id: alignment.alignment_map_revision_id, model_id: contract.model_id, model_revision_id: contract.model_revision_id, preset_id: contract.preset_id, parameters: contract.parameter_defaults, execution_values: contract.execution_defaults })); context.base += 1; return context; };
const expectApiOrNative = (run: () => unknown): void => assert.throws(run, (error: unknown) => error instanceof Error);

type MesaFixtureState = "receipt_committed" | "queued" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled";
const mesaArtifactNames = ["daily-kpis.csv", "derived-views-manifest.json", "domain-events.jsonl", "metadata.json", "replay-manifest.json", "request.json", "run.log", "summary.json"] as const;
const writeMesaArtifactFixture = (root: string, projectId: string, runId: string): void => { const directory = join(root, "mesa-provider-fixture", projectId, runId); mkdirSync(directory, { recursive: true }); for (const name of mesaArtifactNames) writeFileSync(join(directory, name), Buffer.from(`${projectId}\n${runId}\n${name}\n`, "utf8")); };
const withRecordDigest = <T extends Record<string, unknown>>(record: T, field: string, prefix: string): T => ({ ...record, [field]: `${prefix}${canonicalDigest(Object.fromEntries(Object.entries(record).filter(([key]) => key !== field)))}` });
const rewriteAttestationAndCommittedRef = (root: string, projectId: string, attestationId: string, mutate: (record: any) => void): void => { const recordPath = join(root, "projects", projectId, "attestations", `${attestationId}.json`); const record = JSON.parse(readFileSync(recordPath, "utf8")); mutate(record); const rewritten = withRecordDigest(record, "attestation_digest", "atd_"); writeFileSync(recordPath, canonicalJsonV2(rewritten)); const eventDirectory = join(root, "projects", projectId, "project-events"); for (const name of readdirSync(eventDirectory).sort().reverse()) { const path = join(eventDirectory, name); const event = JSON.parse(readFileSync(path, "utf8")); const ref = event.record_refs.find((item: any) => item.kind === "attestation" && item.id === attestationId); if (!ref) continue; ref.digest = rewritten.attestation_digest; const withDigest = withRecordDigest(event, "event_digest", "pe_"); writeFileSync(path, canonicalJsonV2(withDigest)); return; } throw new Error("attestation ProjectEvent ref not found"); };
const recomputeMesaLifecycleDigests = (evidence: VerifiedMesaRunEvidence): void => { let previous: string | null = null; evidence.lifecycle_records.forEach((record, sequence) => { record.sequence = sequence; record.previous_mesa_lifecycle_digest = previous; const rewritten = withRecordDigest(record as unknown as Record<string, unknown>, "mesa_lifecycle_digest", "mlr_") as unknown as typeof record; Object.assign(record, rewritten); previous = record.mesa_lifecycle_digest; }); };
const mesaEvidenceFixture = (root: string, states: Map<string, MesaFixtureState>): ((projectId: string, runId: string) => VerifiedMesaRunEvidence) => (projectId, runId) => {
  const directory = join(root, "projects", projectId, "run-intents", runId); const intent = JSON.parse(readFileSync(join(directory, "intent.json"), "utf8")); const admission = JSON.parse(readFileSync(join(directory, "admission.json"), "utf8")); const policy = JSON.parse(readFileSync(join(directory, "policy-snapshot.json"), "utf8"));
  const capturedRequestSha256 = canonicalDigest({ run_id: runId, downstream_request_digest: intent.downstream_request_digest }); const receipt = withRecordDigest({ schema_version: 1, canonical_json_version: "riff-canonical-json-v2", mesa_run_receipt_digest: "", downstream_idempotency_key: intent.downstream_idempotency_key, downstream_request_digest: intent.downstream_request_digest, project_id: projectId, run_id: runId, model_id: intent.model_id, model_revision_id: intent.model_revision_id, experiment_revision_id: intent.experiment_revision_id, experiment_sha256: intent.experiment_sha256, policy_snapshot_digest: policy.policy_snapshot_digest, run_admission_digest: admission.run_admission_digest, run_intent_digest: intent.run_intent_digest, captured_request_sha256: capturedRequestSha256, ownership_epoch: 1, accepted_at: "2026-07-21T00:00:00.000Z" }, "mesa_run_receipt_digest", "mrr_") as VerifiedMesaRunEvidence["receipt"];
  const status = states.get(runId) ?? "receipt_committed"; const terminalStatus = ["succeeded", "failed", "timed_out", "cancelled"].includes(status) ? status as "succeeded" | "failed" | "timed_out" | "cancelled" : null;
  const artifacts = terminalStatus === "succeeded" ? mesaArtifactNames.map((name) => { const sha256 = sha256Hex(readFileSync(join(root, "mesa-provider-fixture", projectId, runId, name))); return { name, sha256, artifact_id: `artifact_${canonicalDigest({ run_id: runId, name, sha256 })}` }; }) : [];
  const tombstoneExists = existsSync(join(directory, "cancel-tombstone.json")); const cancelOutcome = !terminalStatus || !tombstoneExists ? null : terminalStatus === "succeeded" ? "completed_before_cancel_effect" : terminalStatus === "failed" ? "failed_before_cancel_effect" : terminalStatus === "timed_out" ? "timed_out_before_cancel_effect" : "cancelled_by_worker"; const terminal = terminalStatus ? withRecordDigest({ schema_version: 1, canonical_json_version: "riff-canonical-json-v2", terminal_metadata_digest: "", project_id: projectId, run_id: runId, status: terminalStatus, cancel_outcome: cancelOutcome, receipt_digest: receipt.mesa_run_receipt_digest, run_intent_digest: intent.run_intent_digest, run_admission_digest: admission.run_admission_digest, policy_snapshot_digest: policy.policy_snapshot_digest, experiment_revision_id: intent.experiment_revision_id, experiment_sha256: intent.experiment_sha256, artifacts }, "terminal_metadata_digest", "tm_") as NonNullable<VerifiedMesaRunEvidence["terminal_metadata"]> : null;
  const terminalState = terminalStatus === "succeeded" ? "verified_succeeded" : terminalStatus ? `terminal_${terminalStatus}` : null; const lifecycleStates = ["receipt_committed", "ownership_acquired", "temp_prepared", "spawn_intent", "worker_started", ...(terminalState ? ["worker_exited", terminalState] : [])] as VerifiedMesaRunEvidence["lifecycle_records"][number]["state"][]; const requestedState = status === "queued" ? "ownership_acquired" : status === "running" ? "worker_started" : terminalState ?? "receipt_committed"; const sequence = lifecycleStates.indexOf(requestedState as VerifiedMesaRunEvidence["lifecycle_records"][number]["state"]); let previous: string | null = null; const lifecycleRecords: VerifiedMesaRunEvidence["lifecycle_records"] = [];
  for (let index = 0; index <= sequence; index += 1) { const state = lifecycleStates[index]; const childIdentity = state === "worker_started" ? { pid: 12345, process_start_token: "1".repeat(64), spawn_nonce: "2".repeat(32), executable_sha256: "3".repeat(64), request_sha256: capturedRequestSha256 } : null; const evidenceDigest = state === "spawn_intent" ? `nonce_${"2".repeat(32)}` : state === "worker_exited" || state.startsWith("terminal_") || state === "verified_succeeded" ? terminal!.terminal_metadata_digest : null; const lifecycle = withRecordDigest({ schema_version: 1, canonical_json_version: "riff-canonical-json-v2", mesa_lifecycle_digest: "", project_id: projectId, run_id: runId, sequence: index, previous_mesa_lifecycle_digest: previous, ownership_epoch: 1, owner_instance_id: `mesa_owner_${"4".repeat(32)}`, state, receipt_digest: receipt.mesa_run_receipt_digest, run_intent_digest: intent.run_intent_digest, run_admission_digest: admission.run_admission_digest, policy_snapshot_digest: policy.policy_snapshot_digest, experiment_sha256: intent.experiment_sha256, captured_request_sha256: capturedRequestSha256, child_identity: childIdentity, evidence_digest: evidenceDigest, created_at: `2026-07-21T00:00:0${index}.000Z` }, "mesa_lifecycle_digest", "mlr_") as VerifiedMesaRunEvidence["lifecycle_records"][number]; lifecycleRecords.push(lifecycle); previous = lifecycle.mesa_lifecycle_digest; }
  return { receipt, lifecycle_records: lifecycleRecords, terminal_metadata: terminal };
};

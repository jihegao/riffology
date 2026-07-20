import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { ApiError } from "./errors.ts";
import { canonicalJsonV2, parseCanonicalJsonV2 } from "./canonical-json-v2.ts";
import { DurableProjectStore } from "./durable-project-store.ts";
import type { ProjectCommand, RunReference, VerifiedMesaArtifact, VerifiedMesaRunEvidence, WindModelContract } from "./durable-project-types.ts";
import { DETERMINISTIC_MESA_ADMISSION_CODES, type MesaAdapter, type WindArtifact, type WindBootstrap, type WindEventPage } from "./mesa-adapter.ts";
import { loadVerifiedWindModelContract } from "./wind-model-contract.ts";

type LocalFact = { mesa_receipt_absent: boolean; dispatch_owner_absent: boolean; failure?: { code: unknown; safe_message: unknown } };
const key = (projectId: string, runId: string): string => `${projectId}:${runId}`;
const isTerminalState = (state: string): boolean => ["verified_succeeded", "terminal_failed", "terminal_timed_out", "terminal_cancelled"].includes(state);

export class Gate2Runtime {
  readonly store: DurableProjectStore;
  readonly #mesa: MesaAdapter;
  readonly #workspaceRoot: string;
  readonly #evidence = new Map<string, VerifiedMesaRunEvidence>();
  readonly #localFacts = new Map<string, LocalFact>();
  readonly #runLocks = new Map<string, Promise<void>>();
  readonly #retryTimers = new Set<ReturnType<typeof setTimeout>>();
  #timer?: ReturnType<typeof setInterval>;
  #closing = false;
  #closePromise?: Promise<void>;

  constructor(workspaceRoot: string, mesa: MesaAdapter, store?: DurableProjectStore) {
    this.#workspaceRoot = existsSync(workspaceRoot) ? realpathSync(workspaceRoot) : workspaceRoot; this.#mesa = mesa;
    const preloaded = store ? { contracts: [] } : this.#preloadWorkspaceEvidence();
    this.store = store ?? new DurableProjectStore(this.#workspaceRoot, {
      modelContracts: preloaded.contracts,
      mesaEvidenceProvider: (projectId, runId) => {
        const value = this.#evidence.get(key(projectId, runId));
        if (!value) throw new ApiError(503, "provider_unavailable", "Verified Mesa evidence has not been captured.");
        return structuredClone(value);
      },
      localRunInspector: (projectId, runId) => {
        const value = this.#localFacts.get(key(projectId, runId));
        if (!value) throw new ApiError(409, "run_reconciliation_conflict", "Local terminal evidence has not been established.");
        return structuredClone(value);
      },
    });
  }

  #preloadWorkspaceEvidence(): { contracts: WindModelContract[] } {
    const contracts = new Map<string, WindModelContract>();
    const createEvents = join(this.#workspaceRoot, "workspace-create-events");
    if (!existsSync(createEvents)) return { contracts: [] };
    const projectIds: string[] = [];
    for (const name of readdirSync(createEvents).filter((item) => /^[0-9]{20}\.json$/u.test(item)).sort()) {
      try {
        const event = this.#canonicalRecord(join(createEvents, name));
        if (typeof event.project_id === "string" && /^project_[0-9a-f]{32}$/u.test(event.project_id)) projectIds.push(event.project_id);
      } catch { /* DurableProjectStore will report the authoritative workspace corruption. */ }
    }
    for (const projectId of projectIds) {
      try { const contract = loadVerifiedWindModelContract(this.#workspaceRoot, projectId); contracts.set(contract.model_revision_id, contract); }
      catch { /* A project without a selected/materialized wind bundle needs no contract yet. */ }
      const receiptDir = join(this.#workspaceRoot, "projects", projectId, "mesa-run-receipts");
      if (!existsSync(receiptDir)) continue;
      for (const name of readdirSync(receiptDir).filter((item) => /^rk_[0-9a-f]{64}\.json$/u.test(item)).sort()) {
        try {
          const receipt = this.#canonicalRecord(join(receiptDir, name));
          const runId = String(receipt.run_id);
          const eventsDir = join(this.#workspaceRoot, "projects", projectId, "mesa-run-lifecycle", runId, "events");
          const lifecycle = readdirSync(eventsDir).filter((item) => /^[0-9]{20}\.json$/u.test(item)).sort().map((item) => this.#canonicalRecord(join(eventsDir, item)));
          const terminalPath = join(this.#workspaceRoot, "projects", projectId, "mesa-run-lifecycle", runId, "terminal-metadata.json");
          const terminal = existsSync(terminalPath) ? this.#canonicalRecord(terminalPath) : null;
          this.#evidence.set(key(projectId, runId), { receipt, lifecycle_records: lifecycle, terminal_metadata: terminal } as VerifiedMesaRunEvidence);
        } catch { /* The durable store fails closed if a projected run requires corrupt evidence. */ }
      }
    }
    return { contracts: [...contracts.values()] };
  }

  #canonicalRecord(path: string): Record<string, any> {
    const bytes = readFileSync(path); const value = parseCanonicalJsonV2(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value) || !canonicalJsonV2(value).equals(bytes)) throw new ApiError(500, "immutable_record_corrupt", "A local Mesa evidence record is not exact canonical JSON.");
    return value as Record<string, any>;
  }

  start(): void {
    if (this.#closing) return;
    if (this.#timer) return;
    this.#timer = setInterval(() => this.reconcileAll(), 250);
    this.#timer.unref?.();
    this.reconcileAll();
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    if (this.#timer) clearInterval(this.#timer); this.#timer = undefined;
    for (const timer of this.#retryTimers) clearTimeout(timer); this.#retryTimers.clear();
    this.#closePromise = (async () => { await Promise.allSettled([...this.#runLocks.values()]); this.store.close(); })();
    return this.#closePromise;
  }

  async bootstrap(command: ProjectCommand<Record<string, never>>): Promise<{ status: number; body: Record<string, unknown> }> {
    this.#assertOpen();
    if (Object.keys(command.payload).length !== 0) throw new ApiError(422, "invalid_request", "Wind bootstrap payload must be empty.");
    const authorization = this.store.authorizeBootstrap(command); if (authorization.completed) return authorization.result!;
    if (!this.#mesa.materializeWindModel) throw new ApiError(503, "mesa_unconfigured", "Mesa Gate 2 bootstrap is unavailable.");
    const materialized = await this.#mesa.materializeWindModel(command.project_id) as WindBootstrap;
    this.#assertOpen();
    const contract = loadVerifiedWindModelContract(this.#workspaceRoot, command.project_id, materialized);
    this.store.registerModelContract(contract);
    return this.store.completeBootstrap(command, contract.model_revision_id);
  }

  startRun(command: ProjectCommand<{ experiment_revision_id: string }>): { status: number; body: Record<string, unknown> } {
    this.#assertOpen();
    const result = this.store.startRun(command);
    const runId = String(result.body.run_id);
    this.kick(command.project_id, runId);
    return result;
  }

  cancelRun(command: ProjectCommand<{ run_id: string }>): { status: number; body: Record<string, unknown> } {
    this.#assertOpen();
    const result = this.store.cancelRun(command);
    this.kick(command.project_id, command.payload.run_id);
    return result;
  }

  run(projectId: string, runId: string): RunReference {
    this.kick(projectId, runId);
    return this.store.run(projectId, runId);
  }

  reconcileAll(): void {
    if (this.#closing) return;
    for (const run of this.store.pendingRuns()) this.kick(run.project_id, run.run_id);
    for (const run of this.store.localTerminalRunsForAudit(10)) this.kick(run.project_id, run.run_id);
  }

  kick(projectId: string, runId: string): void {
    if (this.#closing) return;
    const runKey = key(projectId, runId);
    if (this.#runLocks.has(runKey)) return;
    const task = this.#reconcile(projectId, runId).catch((error) => { if (!this.#closing) this.#publishReconciliationFailure(projectId, runId, error); }).finally(() => this.#runLocks.delete(runKey));
    this.#runLocks.set(runKey, task);
  }

  async domainEvents(projectId: string, runId: string, after: number, limit: number): Promise<WindEventPage> {
    const run = this.store.run(projectId, runId);
    if (run.reference_kind !== "terminal" || run.status !== "succeeded") throw new ApiError(409, "run_evidence_pending", "Domain events are available only after verified success.");
    if (!this.#mesa.getWindRunEvidence || !this.#mesa.getWindArtifact) throw new ApiError(503, "mesa_unconfigured", "Mesa event retrieval is unavailable.");
    const { declaration } = await this.#verifiedArtifact(projectId, runId, "domain-events.jsonl");
    const artifact = await this.#mesa.getWindArtifact(projectId, runId, declaration.name); this.#assertArtifactDigest(artifact, declaration.sha256);
    const events: Array<Record<string, unknown>> = [];
    for (const line of artifact.bytes.toString("utf8").split("\n")) {
      if (line === "") continue; let event: unknown; try { event = JSON.parse(line); } catch { throw new ApiError(500, "mesa_run_corrupt", "The committed domain event artifact is invalid."); }
      if (!event || typeof event !== "object" || Array.isArray(event) || !Number.isSafeInteger((event as Record<string, unknown>).sequence)) throw new ApiError(500, "mesa_run_corrupt", "The committed domain event artifact is invalid.");
      const sequence = (event as Record<string, unknown>).sequence as number; if (sequence > after && events.length < limit) events.push(event as Record<string, unknown>);
    }
    return { events, next_after: events.at(-1)?.sequence as number ?? after };
  }

  async artifact(projectId: string, artifactId: string): Promise<WindArtifact> {
    if (!/^artifact_[0-9a-f]{64}$/u.test(artifactId)) throw new ApiError(404, "resource_not_found", "The artifact was not found.");
    const run = this.store.snapshot(projectId).run_index.find((item) => item.reference_kind === "terminal" && item.status === "succeeded" && item.artifact_ids.includes(artifactId));
    if (!run) throw new ApiError(404, "resource_not_found", "The artifact was not found.");
    if (!this.#mesa.getWindRunEvidence || !this.#mesa.getWindArtifact) throw new ApiError(503, "mesa_unconfigured", "Mesa artifact retrieval is unavailable.");
    const { declaration } = await this.#verifiedArtifact(projectId, run.run_id, undefined, artifactId);
    const artifact = await this.#mesa.getWindArtifact(projectId, run.run_id, declaration.name);
    this.#assertArtifactDigest(artifact, declaration.sha256);
    return artifact;
  }

  async #reconcile(projectId: string, runId: string): Promise<void> {
    if (this.#closing) return;
    let run = this.store.run(projectId, runId);
    if (run.reference_kind === "terminal") { if (run.terminal_evidence_source === "local_run_terminal_evidence") await this.#auditLocalTerminal(projectId, runId); return; }
    const dispatch = this.store.runDispatch(projectId, runId);
    if (!this.#mesa.getWindRunEvidence || !this.#mesa.getWindRunReceipt) return;
    let journal = this.store.runDispatchState(projectId, runId); let cancellationReceipt: VerifiedMesaRunEvidence | null = null;
    if (run.status === "cancellation_requested" && journal.state === "never_started") {
      try { cancellationReceipt = await this.#mesa.getWindRunReceipt(projectId, dispatch.downstream_idempotency_key); if (this.#closing) return; this.#evidence.set(key(projectId, runId), cancellationReceipt); this.store.markRunDispatch(projectId, runId, "receipt_observed"); journal = this.store.runDispatchState(projectId, runId); }
      catch (error) { if (this.#closing) return; if (!(error instanceof ApiError) || error.code !== "receipt_not_found") { this.#schedule(projectId, runId); return; } const confirmed = this.store.runDispatchState(projectId, runId); if (confirmed.state !== "never_started") { this.#schedule(projectId, runId); return; } this.#localFacts.set(key(projectId, runId), { mesa_receipt_absent: true, dispatch_owner_absent: true }); this.store.publishLocalTerminal(projectId, runId, "cancelled_before_dispatch"); return; }
    }
    if ((run.status === "dispatch_pending" || run.status === "cancellation_requested") && (journal.state === "never_started" || journal.state === "in_flight" || journal.state === "rejection_observed")) {
      if (!this.#mesa.startWindRunV2) return;
      if (journal.state === "never_started") { this.store.markRunDispatch(projectId, runId, "in_flight"); journal = this.store.runDispatchState(projectId, runId); }
      try {
        await this.#mesa.startWindRunV2(projectId, { experiment_revision_id: dispatch.body.experiment_revision_id, run_id: runId, downstream_idempotency_key: dispatch.downstream_idempotency_key, downstream_request_digest: dispatch.downstream_request_digest });
        if (this.#closing) return;
        this.store.markRunDispatch(projectId, runId, "receipt_observed");
      } catch (error) {
        if (!(error instanceof ApiError) || error.status < 400 || error.status >= 500 || !DETERMINISTIC_MESA_ADMISSION_CODES.has(error.code)) { this.#schedule(projectId, runId); return; }
        try { const received = await this.#mesa.getWindRunReceipt(projectId, dispatch.downstream_idempotency_key); if (this.#closing) return; this.#evidence.set(key(projectId, runId), received); this.store.markRunDispatch(projectId, runId, "receipt_observed"); }
        catch (receiptError) {
          if (this.#closing) return;
          if (!(receiptError instanceof ApiError) || receiptError.code !== "receipt_not_found") { this.#schedule(projectId, runId); return; }
          const failure = { code: error.code, safe_message: error.message }; this.store.markRunDispatch(projectId, runId, "rejection_observed", failure); const observed = this.store.runDispatchState(projectId, runId); if (observed.absence_proof_count < 2) { this.#schedule(projectId, runId); return; } this.store.markRunDispatch(projectId, runId, "stable_rejected", failure); this.#publishStableRejection(projectId, runId, failure); return;
        }
      }
    }
    if (journal.state === "stable_rejected") {
      if (run.status === "cancellation_requested") { this.#localFacts.set(key(projectId, runId), { mesa_receipt_absent: true, dispatch_owner_absent: true }); this.store.publishLocalTerminal(projectId, runId, "cancelled_before_dispatch"); }
      else { this.#localFacts.set(key(projectId, runId), { mesa_receipt_absent: true, dispatch_owner_absent: true, failure: journal.failure! }); this.store.publishLocalTerminal(projectId, runId, "pre_receipt_admission_failed"); } return;
    }
    run = this.store.run(projectId, runId);
    if (run.reference_kind === "terminal") return;
    if (run.status === "cancellation_requested") {
      try { const received = cancellationReceipt ?? await this.#mesa.getWindRunReceipt(projectId, dispatch.downstream_idempotency_key); if (this.#closing) return; this.#evidence.set(key(projectId, runId), received); if (!cancellationReceipt) this.store.markRunDispatch(projectId, runId, "receipt_observed"); if (this.#mesa.cancelWindRunV2) { await this.#mesa.cancelWindRunV2(projectId, runId); if (this.#closing) return; } }
      catch (error) { if (error instanceof ApiError && ["receipt_not_found", "run_not_found"].includes(error.code)) this.#schedule(projectId, runId); else throw error; return; }
    }

    let evidence: VerifiedMesaRunEvidence;
    try { evidence = await this.#mesa.getWindRunEvidence(projectId, runId); }
    catch (error) { if (error instanceof ApiError && ["receipt_not_found", "run_not_found", "mesa_unavailable"].includes(error.code)) { this.#schedule(projectId, runId); return; } throw error; }
    if (this.#closing) return;
    this.store.markRunDispatch(projectId, runId, "receipt_observed");
    this.#projectEvidenceStages(projectId, runId, evidence);
    run = this.store.run(projectId, runId);
    if (run.reference_kind === "pending") this.#schedule(projectId, runId);
  }

  #projectEvidenceStages(projectId: string, runId: string, evidence: VerifiedMesaRunEvidence): void {
    const current = this.store.run(projectId, runId);
    if (current.reference_kind === "terminal") return;
    const stages: VerifiedMesaRunEvidence[] = [];
    if (current.status !== "cancellation_requested") {
      const queuedIndex = evidence.lifecycle_records.findLastIndex((item) => item.state === "spawn_intent");
      if (queuedIndex >= 0) stages.push({ receipt: evidence.receipt, lifecycle_records: evidence.lifecycle_records.slice(0, queuedIndex + 1), terminal_metadata: null });
      if (evidence.lifecycle_records.at(-1)?.state === "worker_started") stages.push({ receipt: evidence.receipt, lifecycle_records: evidence.lifecycle_records, terminal_metadata: null });
    }
    if (isTerminalState(evidence.lifecycle_records.at(-1)?.state ?? "")) stages.push(evidence);
    for (const stage of stages) {
      const latest = this.store.run(projectId, runId);
      if (latest.reference_kind === "terminal") return;
      const last = stage.lifecycle_records.at(-1)?.state;
      if (latest.status === "cancellation_requested" && !isTerminalState(last ?? "")) continue;
      this.#evidence.set(key(projectId, runId), structuredClone(stage));
      try { this.store.reconcileVerifiedMesaState(projectId, runId); }
      catch (error) {
        if (error instanceof ApiError && error.code === "invalid_run_transition") continue;
        throw error;
      }
    }
  }

  async #verifiedArtifact(projectId: string, runId: string, name?: VerifiedMesaArtifact["name"], artifactId?: string): Promise<{ evidence: VerifiedMesaRunEvidence; declaration: VerifiedMesaArtifact }> {
    const evidence = await this.#mesa.getWindRunEvidence!(projectId, runId); const terminal = evidence.terminal_metadata;
    this.#assertOpen();
    if (!terminal || terminal.status !== "succeeded") throw new ApiError(500, "mesa_run_corrupt", "Current Mesa evidence is not verified success.");
    const declaration = terminal.artifacts.find((item) => name ? item.name === name : item.artifact_id === artifactId);
    if (!declaration) throw new ApiError(500, "mesa_run_corrupt", "The declared artifact is absent from terminal evidence."); this.#evidence.set(key(projectId, runId), evidence); this.store.reconcileVerifiedMesaState(projectId, runId);
    return { evidence, declaration };
  }

  #assertArtifactDigest(artifact: WindArtifact, expected: string): void { if (createHash("sha256").update(artifact.bytes).digest("hex") !== expected) throw new ApiError(500, "mesa_run_corrupt", "The retrieved artifact differs from terminal evidence."); }
  async #auditLocalTerminal(projectId: string, runId: string): Promise<void> {
    if (this.#closing) return;
    if (!this.#mesa.getWindRunReceipt) { this.store.recordLateReceiptAuditAttempt(projectId, runId, "provider_unavailable"); return; } const dispatch = this.store.runDispatch(projectId, runId); let evidence: VerifiedMesaRunEvidence;
    try { evidence = await this.#mesa.getWindRunReceipt(projectId, dispatch.downstream_idempotency_key); if (this.#closing) return; }
    catch (error) {
      if (this.#closing) return;
      if (error instanceof ApiError && ["mesa_run_corrupt", "immutable_record_corrupt", "project_corrupt"].includes(error.code)) this.store.recordLateReceiptEvidenceCorrupt(projectId, runId);
      const outcome = error instanceof ApiError && error.code === "receipt_not_found" ? "not_found" : error instanceof ApiError && ["mesa_unavailable", "mesa_unconfigured", "provider_unavailable"].includes(error.code) ? "provider_unavailable" : "transient_error"; this.store.recordLateReceiptAuditAttempt(projectId, runId, outcome); return;
    }
    this.#evidence.set(key(projectId, runId), evidence); let accepted = false; let errorCode: string | undefined;
    try { if (this.#mesa.cancelWindRunV2) { await this.#mesa.cancelWindRunV2(projectId, runId); if (this.#closing) return; accepted = true; } else errorCode = "mesa_cancel_unavailable"; }
    catch (error) { errorCode = error instanceof ApiError ? error.code : "mesa_cancel_failed"; }
    if (this.#mesa.getWindRunEvidence) { try { evidence = await this.#mesa.getWindRunEvidence(projectId, runId); if (this.#closing) return; this.#evidence.set(key(projectId, runId), evidence); } catch (error) { if (this.#closing) return; if (error instanceof ApiError && ["mesa_run_corrupt", "immutable_record_corrupt", "project_corrupt"].includes(error.code)) this.store.recordLateReceiptEvidenceCorrupt(projectId, runId); /* the exact receipt evidence remains sufficient for fail-closed recording */ } }
    try { this.store.recordLateReceiptAfterLocalTerminal(projectId, runId, { accepted, ...(errorCode ? { error_code: errorCode } : {}) }); }
    catch (error) { if (error instanceof ApiError && ["mesa_run_corrupt", "immutable_record_corrupt", "project_corrupt"].includes(error.code)) this.store.recordLateReceiptEvidenceCorrupt(projectId, runId); throw error; }
  }
  #publishStableRejection(projectId: string, runId: string, failure: { code: string; safe_message: string }): void { const now = this.store.run(projectId, runId); if (now.reference_kind === "pending" && now.status === "cancellation_requested") { this.#localFacts.set(key(projectId, runId), { mesa_receipt_absent: true, dispatch_owner_absent: true }); this.store.publishLocalTerminal(projectId, runId, "cancelled_before_dispatch"); } else { this.#localFacts.set(key(projectId, runId), { mesa_receipt_absent: true, dispatch_owner_absent: true, failure }); this.store.publishLocalTerminal(projectId, runId, "pre_receipt_admission_failed"); } }
  #schedule(projectId: string, runId: string): void { if (this.#closing) return; const timer = setTimeout(() => { this.#retryTimers.delete(timer); if (!this.#closing) this.kick(projectId, runId); }, 100); this.#retryTimers.add(timer); timer.unref?.(); }
  #publishReconciliationFailure(projectId: string, runId: string, error: unknown): void {
    if (this.#closing) return;
    if (error instanceof ApiError && ["late_receipt_after_local_terminal", "late_receipt_evidence_corrupt"].includes(error.code)) return;
    const run = this.store.run(projectId, runId); if (run.reference_kind === "terminal") return;
    if (!(error instanceof ApiError) || !["mesa_run_corrupt", "project_corrupt", "immutable_record_corrupt"].includes(error.code)) { this.#schedule(projectId, runId); return; }
    this.#localFacts.set(key(projectId, runId), { mesa_receipt_absent: false, dispatch_owner_absent: false, failure: { code: "mesa_evidence_corrupt", safe_message: "Mesa evidence failed integrity verification." } });
    this.store.publishLocalTerminal(projectId, runId, "mesa_evidence_corrupt");
  }
  #assertOpen(): void { if (this.#closing) throw new ApiError(503, "runtime_closing", "The Gate 2 runtime is closing."); }
}

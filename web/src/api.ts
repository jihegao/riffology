import { canonicalJsonV2 } from "./state";
import type { AttestationDetailPage, BrowserEvent, BrowserProjectionResponse, CandidateDescriptor, CommandResponse, DefaultProject, EvidenceIndex, EvidenceStudioClient, EventPage, FrozenCommand, IssueHistory, JsonScalar, KpiPage, ModelViewSources, ProjectCommand, ReplayPage } from "./types";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly correlationId?: string, readonly details: Record<string, unknown> = {}) { super(message); }
  get commandDigest() { return typeof this.details.command_digest === "string" ? this.details.command_digest : undefined; }
}

export const newCommand = <T>(projectId: string, sessionId: string, baseSnapshotRevision: number, payload: T): ProjectCommand<T> => ({ command_id: crypto.randomUUID(), project_id: projectId, session_id: sessionId, base_snapshot_revision: baseSnapshotRevision, payload });

const sha256 = async (value: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const commandContract = (path: string, envelope: ProjectCommand<Record<string, unknown>>) => {
  const payload = envelope.payload; let expected_event_type = ""; const expected_result_identity: Record<string, JsonScalar> = {};
  if (path.endsWith("/experiments/revisions")) expected_event_type = "experiment.revision_created";
  else if (path.endsWith("/attestations")) expected_event_type = "attestation.batch_created";
  else if (/\/runs\/[^/]+\/cancel$/.test(path)) { expected_event_type = "cancellation_requested"; expected_result_identity.run_id = String(payload.run_id); }
  else if (path.endsWith("/runs")) expected_event_type = "run.intent_committed";
  else if (/\/issues\/[^/]+(?:\/comments)?$/.test(path)) { expected_event_type = `issue.${String(payload.event_type)}`; expected_result_identity.issue_id = String(payload.issue_id); }
  else if (path.endsWith("/issues")) expected_event_type = "issue.opened";
  else if (path.endsWith("/wind/framed-evidence/activate")) { expected_event_type = "model.activation_reconciled"; expected_result_identity.activation_id = envelope.command_id; }
  else throw new Error("No frozen-command reconciliation contract exists for this route.");
  return { expected_event_type, expected_terminal_event_types: path.endsWith("/wind/framed-evidence/activate") ? ["model.activation_reconciled", "model.activation_failed"] : [expected_event_type], expected_result_identity };
};
const responseIdentity = (value: unknown): Record<string, JsonScalar> => { const result: Record<string, JsonScalar> = {}; const allowed = new Set(["snapshot_revision", "model_revision_id", "experiment_revision_id", "issue_id", "attestation_id", "attestation_batch_id", "run_id", "status", "activation_id"]); const visit = (item: unknown) => { if (!item || typeof item !== "object") return; if (Array.isArray(item)) { item.forEach(visit); return; } for (const [key, nested] of Object.entries(item)) { if (allowed.has(key) && (nested === null || ["string", "number", "boolean"].includes(typeof nested))) result[key] = nested as JsonScalar; else visit(nested); } }; visit(value); return result; };
export async function freezeCommand(envelope: ProjectCommand<Record<string, unknown>>, method: "POST" | "PATCH", actualPath: string, digestRoute: string, version: FrozenCommand["command_digest_version"] = "gate2-command-digest-v1"): Promise<FrozenCommand> {
  const canonical_json = canonicalJsonV2(envelope);
  const preimage = version === "gate2-command-digest-v1" ? { method, route: digestRoute, request: envelope } : { version: "gate3-command-digest-v2", method, actual_normalized_route: actualPath, request: envelope };
  return Object.freeze({ envelope: structuredClone(envelope), canonical_json, method, actual_path: actualPath, digest_route: digestRoute, command_digest_version: version, command_digest: `cmd_${await sha256(canonicalJsonV2(preimage))}`, ...commandContract(actualPath, envelope), observed_result_identity: null, error_receipt: null, transport_status: "not_sent" });
}

export class HttpEvidenceStudioClient implements EvidenceStudioClient {
  private frozen: FrozenCommand | null = null;
  constructor(private readonly baseUrl = import.meta.env.VITE_API_BASE_URL ?? "") {}
  private url(path: string) { return path.startsWith("http") ? path : `${this.baseUrl}${path}`; }
  private project(projectId: string) { return `/api/projects/${encodeURIComponent(projectId)}`; }
  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(this.url(path), init);
    const body = await response.json().catch(() => ({})) as T & { error?: { code?: string; message?: string; correlation_id?: string; details?: Record<string, unknown> }; accepted?: boolean };
    if (!response.ok || body.accepted === false) throw new ApiError(response.status, body.error?.code ?? "request_failed", body.error?.message ?? `Request failed (${response.status})`, body.error?.correlation_id, body.error?.details);
    return body;
  }
  private async command<T>(path: string, method: "POST" | "PATCH", envelope: ProjectCommand<Record<string, unknown>>, digestRoute = path, version: FrozenCommand["command_digest_version"] = "gate2-command-digest-v1") {
    const frozen = await freezeCommand(envelope, method, path, digestRoute, version); this.frozen = { ...frozen, transport_status: "in_flight" };
    try { const response = await fetch(this.url(path), { method, headers: { "content-type": "application/json" }, body: frozen.canonical_json }); const body = await response.json().catch(() => ({})) as T & { accepted?: boolean; error?: { code?: string; message?: string; correlation_id?: string; details?: Record<string, unknown> } }; if (!response.ok || body.accepted === false) throw new ApiError(response.status, body.error?.code ?? "request_failed", body.error?.message ?? `Request failed (${response.status})`, body.error?.correlation_id, body.error?.details); this.frozen = { ...frozen, observed_result_identity: responseIdentity(body), transport_status: response.status === 202 ? "reservation_pending" : "http_accepted" }; return body; }
    catch (error) { const terminal = error instanceof ApiError && this.activationFailureMatches(frozen, error); this.frozen = { ...frozen, error_receipt: error instanceof ApiError ? this.errorReceipt(error) : null, transport_status: terminal ? "terminal_failed" : error instanceof ApiError ? "http_rejected" : "response_lost" }; throw error; }
  }
  discoverDefaultProject() { return this.json<DefaultProject>("/api/projects/default"); }
  attachSession(projectId: string, actorId: string) { return this.json<{ session_id: string }>(`${this.project(projectId)}/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actor_id: actorId }) }); }
  getProjection(projectId: string) { return this.json<BrowserProjectionResponse>(`${this.project(projectId)}/browser-projection/v1`); }
  subscribe(projectId: string, onEvent: (event: BrowserEvent) => void) {
    const source = new EventSource(this.url(`${this.project(projectId)}/events/browser-v1`));
    source.onopen = () => onEvent({ event_type: "connection.status", status: "connected" });
    source.onerror = () => onEvent({ event_type: "connection.status", status: "reconnecting" });
    (["browser.project.snapshot.v1", "browser.project.patch.v1", "browser.project.reload-required.v1"] as const).forEach((name) => source.addEventListener(name, (event) => { try { onEvent(JSON.parse((event as MessageEvent<string>).data) as BrowserEvent); } catch { onEvent({ event_type: "connection.status", status: "reconnecting" }); } }));
    return () => source.close();
  }
  getCandidate(projectId: string) { return this.json<CandidateDescriptor>(`${this.project(projectId)}/wind/framed-candidate`); }
  getModelViewSources(href: string, signal?: AbortSignal) { return this.json<ModelViewSources>(href, { signal }); }
  async getExactJsonSource(source: import("./types").SourceDescriptor, signal?: AbortSignal) { const response=await fetch(this.url(source.href),{signal}); if (!response.ok) throw new ApiError(response.status,"request_failed",`Request failed (${response.status})`); const bytes=new Uint8Array(await response.arrayBuffer()); const digest=[...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map((byte)=>byte.toString(16).padStart(2,"0")).join(""); if (digest!==source.sha256) throw new Error(`Exact source digest mismatch for ${source.logical_name}.`); let text:string; try { text=new TextDecoder("utf-8",{fatal:true}).decode(bytes); } catch { throw new Error(`Exact source encoding is invalid for ${source.logical_name}.`); } const body=text.endsWith("\n")?text.slice(0,-1):text; if (body.endsWith("\n")) throw new Error(`Exact source final LF is invalid for ${source.logical_name}.`); let value:unknown; try { value=JSON.parse(body); } catch { throw new Error(`Exact source JSON is invalid for ${source.logical_name}.`); } if (!value || typeof value!=="object" || Array.isArray(value) || canonicalJsonV2(value)!==body) throw new Error(`Exact source is not canonical JSON v2 for ${source.logical_name}.`); return value as import("./types").JsonObject; }
  activate(projectId: string, command: ProjectCommand<Record<string, unknown>>) { const path = `${this.project(projectId)}/wind/framed-evidence/activate`; return this.command<CommandResponse>(path, "POST", command, path, "gate3-command-digest-v2"); }
  reviseExperiment(projectId: string, command: ProjectCommand<Record<string, unknown>>) { return this.command<CommandResponse>(`${this.project(projectId)}/experiments/revisions`, "POST", command); }
  createIssue(projectId: string, command: ProjectCommand<Record<string, unknown>>) { return this.command<CommandResponse>(`${this.project(projectId)}/issues`, "POST", command); }
  updateIssue(projectId: string, issueId: string, command: ProjectCommand<Record<string, unknown>>) { return this.command<CommandResponse>(`${this.project(projectId)}/issues/${encodeURIComponent(issueId)}`, "PATCH", command, `${this.project(projectId)}/issues/:issue`); }
  commentIssue(projectId: string, issueId: string, command: ProjectCommand<Record<string, unknown>>) { return this.command<CommandResponse>(`${this.project(projectId)}/issues/${encodeURIComponent(issueId)}/comments`, "POST", command, `${this.project(projectId)}/issues/:issue/comments`); }
  createAttestations(projectId: string, command: ProjectCommand<Record<string, unknown>>) { return this.command<CommandResponse>(`${this.project(projectId)}/attestations`, "POST", command); }
  startRun(projectId: string, command: ProjectCommand<Record<string, unknown>>) { return this.command<CommandResponse>(`${this.project(projectId)}/runs`, "POST", command); }
  cancelRun(projectId: string, runId: string, command: ProjectCommand<Record<string, unknown>>) { return this.command<CommandResponse>(`${this.project(projectId)}/runs/${encodeURIComponent(runId)}/cancel`, "POST", command, `${this.project(projectId)}/runs/:run/cancel`); }
  getAttestations(projectId: string, subjectId: string, after: string | null = null, signal?: AbortSignal) { const query = new URLSearchParams({ subject_revision_id: subjectId, limit: "100" }); if (after) query.set("after", after); return this.json<AttestationDetailPage>(`${this.project(projectId)}/attestations?${query}`, { signal }); }
  getIssueHistory(projectId: string, issueId: string, signal?: AbortSignal) { return this.json<IssueHistory>(`${this.project(projectId)}/issues/${encodeURIComponent(issueId)}/history`, { signal }); }
  getEvidence(projectId: string, runId: string, signal?: AbortSignal) { return this.json<EvidenceIndex>(`${this.project(projectId)}/runs/${encodeURIComponent(runId)}/evidence`, { signal }); }
  getKpis(projectId: string, runId: string, afterDay = -1, signal?: AbortSignal) { return this.json<KpiPage>(`${this.project(projectId)}/runs/${encodeURIComponent(runId)}/kpis?after_day=${afterDay}&limit=366`, { signal }); }
  getEvents(projectId: string, runId: string, filters: Record<string, string>, after = 0, signal?: AbortSignal) { const query = new URLSearchParams({ after: String(after), limit: "500" }); Object.entries(filters).forEach(([key, value]) => { if (value) query.set(key, value); }); return this.json<EventPage>(`${this.project(projectId)}/runs/${encodeURIComponent(runId)}/event-projection/v1?${query}`, { signal }); }
  getReplay(projectId: string, runId: string, afterFrame = -1, signal?: AbortSignal) { return this.json<ReplayPage>(`${this.project(projectId)}/runs/${encodeURIComponent(runId)}/replay?after_frame=${afterFrame}&limit=31`, { signal }); }
  pendingFrozen() { return this.frozen; }
  clearFrozen() { this.frozen = null; }
  private errorReceipt(error: ApiError): NonNullable<FrozenCommand["error_receipt"]> { const terminal = error.code === "activation_failed_no_effect" ? "failed_no_effect" : error.code === "activation_failed_fenced" ? "failed_fenced" : null; return { status: error.status, code: error.code, message: error.message, correlation_id: error.correlationId ?? null, command_digest: error.commandDigest ?? null, activation_id: typeof error.details.activation_id === "string" ? error.details.activation_id : null, receipt_digest: typeof error.details.receipt_digest === "string" ? error.details.receipt_digest : null, terminal_status: terminal }; }
  private activationFailureMatches(frozen: FrozenCommand, error: ApiError): boolean { return frozen.expected_terminal_event_types.includes("model.activation_failed") && ["activation_failed_no_effect", "activation_failed_fenced"].includes(error.code) && error.status === 409 && error.details.activation_id === frozen.expected_result_identity.activation_id && typeof error.details.receipt_digest === "string" && /^acr_[0-9a-f]{64}$/.test(error.details.receipt_digest); }
  async retryFrozen() { const frozen = this.frozen; if (!frozen || !["response_lost", "reservation_pending", "http_accepted", "http_rejected"].includes(frozen.transport_status)) throw new Error("No unresolved frozen command is available for exact retry."); this.frozen = { ...frozen, transport_status: "in_flight" }; try { const response = await fetch(this.url(frozen.actual_path), { method: frozen.method, headers: { "content-type": "application/json" }, body: frozen.canonical_json }); const body = await response.json().catch(() => ({})) as CommandResponse & { accepted?: boolean; error?: { code?: string; message?: string; correlation_id?: string; details?: Record<string, unknown> } }; if (!response.ok || body.accepted === false) throw new ApiError(response.status, body.error?.code ?? "request_failed", body.error?.message ?? `Request failed (${response.status})`, body.error?.correlation_id, body.error?.details); this.frozen = { ...frozen, observed_result_identity: responseIdentity(body), error_receipt: null, transport_status: response.status === 202 ? "reservation_pending" : "http_accepted" }; return body; } catch (error) { if (error instanceof ApiError && this.activationFailureMatches(frozen, error)) { this.frozen = null; throw error; } this.frozen = { ...frozen, error_receipt: error instanceof ApiError ? this.errorReceipt(error) : null, transport_status: error instanceof ApiError ? "http_rejected" : "response_lost" }; throw error; } }
}

import { ApiError } from "./errors.ts";
import { canonicalJsonV2, parseCanonicalJsonV2 } from "./canonical-json-v2.ts";
import type { VerifiedMesaRunEvidence } from "./durable-project-types.ts";
import type { RuntimeCandidateHandshake } from "./gate3-types.ts";

export type WindBootstrap = { model_id: "wind-turbine-maintenance"; model_revision_id: string; experiment_revision_id: string; preset_id: string };
export type WindDispatch = { experiment_revision_id: string; run_id: string; downstream_idempotency_key: string; downstream_request_digest: string };
export type WindEventPage = { events: Array<Record<string, unknown>>; next_after: number };
export type WindArtifact = { bytes: Buffer; media_type: string; filename: string };
export type FramedMaterializeRequest = { schema_id: "riff://mesa-wind/materialize-candidate-request/v1"; schema_version: 1; canonical_json_version: "riff-canonical-json-v2"; activation_id: string; project_id: string; expected_old_model_revision_id: string; candidate_descriptor_digest: string; intent_digest: string };
export type FramedCasRequest = { schema_id: "riff://mesa-wind/active-cas-request/v1"; schema_version: 1; canonical_json_version: "riff-canonical-json-v2"; activation_id: string; project_id: string; expected_old_model_revision_id: string; target_model_revision_id: string; candidate_receipt_digest: string; project_event_digest: string };
export const DETERMINISTIC_MESA_ADMISSION_CODES = new Set(["run_admission_mismatch", "downstream_key_conflict", "experiment_revision_drift", "active_model_revision_drift"]);

export interface MesaAdapter {
  materializeWindModel?(projectId: string): Promise<WindBootstrap>;
  startWindRunV2?(projectId: string, request: WindDispatch): Promise<Record<string, unknown>>;
  getWindRunEvidence?(projectId: string, runId: string): Promise<VerifiedMesaRunEvidence>;
  getWindRunReceipt?(projectId: string, downstreamKey: string): Promise<VerifiedMesaRunEvidence>;
  cancelWindRunV2?(projectId: string, runId: string): Promise<Record<string, unknown>>;
  getWindEvents?(projectId: string, runId: string, after: number, limit: number): Promise<WindEventPage>;
  getWindArtifact?(projectId: string, runId: string, name: string): Promise<WindArtifact>;
  getWindRuntimeCandidateHandshake?(projectId: string): Promise<RuntimeCandidateHandshake>;
  materializeFramedCandidate?(request: FramedMaterializeRequest): Promise<Record<string, unknown>>;
  captureFramedCandidate?(activationId: string): Promise<Record<string, unknown>>;
  captureFramedCandidateBytes?(projectId: string, activationId: string, candidateReceiptDigest: string): Promise<{ document: Record<string, unknown>; wire: Buffer }>;
  casFramedActiveModel?(request: FramedCasRequest): Promise<Record<string, unknown>>;
  getFramedActivationStatus?(activationId: string): Promise<Record<string, unknown>>;
}

type FetchLike = typeof fetch;

export class HttpMesaAdapter implements MesaAdapter {
  private readonly baseUrl: string;
  private readonly request: FetchLike;

  constructor(baseUrl: string, request: FetchLike = fetch) {
    this.baseUrl = baseUrl;
    this.request = request;
  }

  async materializeWindModel(projectId: string): Promise<WindBootstrap> {
    return await this.#json(`/v2/projects/${encodeURIComponent(projectId)}/models/wind-turbine-maintenance`, { method: "PUT", body: JSON.stringify({ preset_id: "wind-turbine-maintenance-demo-v1" }) }) as WindBootstrap;
  }

  async startWindRunV2(projectId: string, request: WindDispatch): Promise<Record<string, unknown>> {
    return await this.#json(`/v2/projects/${encodeURIComponent(projectId)}/runs`, {
      method: "POST",
      headers: { "Idempotency-Key": request.downstream_idempotency_key, "X-Riff-Run-Id": request.run_id, "X-Riff-Request-Digest": request.downstream_request_digest },
      body: JSON.stringify({ experiment_revision_id: request.experiment_revision_id }),
    });
  }

  async getWindRunEvidence(projectId: string, runId: string): Promise<VerifiedMesaRunEvidence> {
    return await this.#json(`/v2/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/evidence`) as VerifiedMesaRunEvidence;
  }

  async getWindRunReceipt(projectId: string, downstreamKey: string): Promise<VerifiedMesaRunEvidence> {
    const payload = await this.#json(`/v2/projects/${encodeURIComponent(projectId)}/run-receipts/${encodeURIComponent(downstreamKey)}`);
    return { receipt: payload.receipt, lifecycle_records: payload.lifecycle_records, terminal_metadata: payload.terminal_metadata ?? null } as VerifiedMesaRunEvidence;
  }

  async cancelWindRunV2(projectId: string, runId: string): Promise<Record<string, unknown>> {
    return await this.#json(`/v2/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST", body: "{}" });
  }

  async getWindEvents(projectId: string, runId: string, after: number, limit: number): Promise<WindEventPage> {
    return await this.#json(`/v1/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/events?after=${after}&limit=${limit}`) as WindEventPage;
  }

  async getWindArtifact(projectId: string, runId: string, name: string): Promise<WindArtifact> {
    const response = await this.#fetch(`/v1/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(name)}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > 64 * 1024 * 1024) throw new ApiError(502, "mesa_artifact_too_large", "Mesa returned an artifact above the backend response limit.");
    return { bytes, media_type: response.headers.get("content-type")?.split(";", 1)[0] ?? "application/octet-stream", filename: name };
  }

  async getWindRuntimeCandidateHandshake(projectId: string): Promise<RuntimeCandidateHandshake> {
    return await this.#json(`/internal/projects/${encodeURIComponent(projectId)}/wind/runtime-candidate-handshake/v1`, {
      headers: { accept: "application/json", "X-Riff-Internal-Protocol": "wind-runtime-handshake-v1" },
    }) as RuntimeCandidateHandshake;
  }

  async materializeFramedCandidate(request: FramedMaterializeRequest): Promise<Record<string, unknown>> {
    return await this.#json("/internal/wind/framed-candidates/materialize", {
      method: "POST", headers: { "X-Riff-Internal-Protocol": "wind-activation-v1", "Idempotency-Key": request.activation_id }, body: canonicalJsonV2(request),
    });
  }

  async captureFramedCandidate(activationId: string): Promise<Record<string, unknown>> {
    return await this.#json(`/internal/wind/framed-candidates/${encodeURIComponent(activationId)}`, {
      headers: { accept: "application/json", "X-Riff-Internal-Protocol": "wind-activation-v1", "Idempotency-Key": activationId },
    });
  }

  async captureFramedCandidateBytes(projectId: string, activationId: string, candidateReceiptDigest: string): Promise<{ document: Record<string, unknown>; wire: Buffer }> {
    const response = await this.#fetch(`/internal/projects/${encodeURIComponent(projectId)}/wind/framed-candidates/${encodeURIComponent(activationId)}/byte-capture/v1`, { headers: { accept: "application/json", "X-Riff-Internal-Protocol": "wind-activation-v1", "Idempotency-Key": activationId, "If-Match": `"${candidateReceiptDigest}"` } }); const wire = Buffer.from(await response.arrayBuffer()); if (wire.byteLength > 6 * 1024 * 1024) throw new ApiError(502, "mesa_adapter_failure", "The candidate byte capture exceeds its wire bound."); let value: unknown; try { value = parseCanonicalJsonV2(wire.toString("utf8")); } catch { throw new ApiError(502, "mesa_adapter_failure", "The candidate byte capture is not canonical JSON."); } if (!value || typeof value !== "object" || Array.isArray(value) || !canonicalJsonV2(value).equals(wire)) throw new ApiError(502, "mesa_adapter_failure", "The candidate byte capture is not exact canonical JSON."); return { document: value as Record<string, unknown>, wire };
  }

  async casFramedActiveModel(request: FramedCasRequest): Promise<Record<string, unknown>> {
    return await this.#json("/internal/wind/active/cas", {
      method: "POST", headers: { "X-Riff-Internal-Protocol": "wind-activation-v1", "Idempotency-Key": request.activation_id, "If-Match": `"${request.expected_old_model_revision_id}"` }, body: canonicalJsonV2(request),
    });
  }

  async getFramedActivationStatus(activationId: string): Promise<Record<string, unknown>> {
    return await this.#json(`/internal/wind/activations/${encodeURIComponent(activationId)}/status`, {
      headers: { accept: "application/json", "X-Riff-Internal-Protocol": "wind-activation-v1", "Idempotency-Key": activationId },
    });
  }

  async #json(path: string, init: RequestInit = {}): Promise<Record<string, any>> {
    const response = await this.#fetch(path, init);
    const payload = await response.json().catch(() => ({}));
    return payload;
  }

  async #fetch(path: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try { response = await this.request(new URL(path, this.baseUrl), { ...init, headers: { ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) } }); }
    catch { throw new ApiError(503, "mesa_unavailable", "The Mesa service is not reachable."); }
    if (!response.ok) {
      const payload = await response.clone().json().catch(() => ({})); const error = payload?.error ?? {};
      const upstream = typeof error.code === "string" ? error.code : ""; const allowed: Record<string, string> = {
        receipt_not_found: "The Mesa run receipt was not found.", run_not_found: "The Mesa run was not found.", downstream_key_conflict: "The downstream idempotency key conflicts with committed content.", invalid_request: "Mesa rejected the request contract.", project_not_indexed: "The Mesa project is not indexed.", cancel_tombstone_required: "A committed cancellation tombstone is required.", run_already_active: "A Mesa run is already active.", worker_limit_reached: "The Mesa worker limit was reached.", mesa_run_corrupt: "Mesa run evidence failed integrity verification.", mesa_owner_fenced: "The Mesa run owner was fenced.", experiment_revision_drift: "The experiment revision differs from committed bytes.", run_admission_mismatch: "The Mesa request differs from the admitted run.", active_model_revision_drift: "The active model revision differs from the admitted run.", incompatible_framed_runtime: "The Mesa runtime is incompatible with the framed model.", framed_candidate_source_mismatch: "The framed candidate source does not match the reviewed descriptor.", activation_not_found: "The Mesa activation was not found.", active_model_mismatch: "The active Mesa model does not match the expected revision.", candidate_descriptor_mismatch: "The framed candidate descriptor differs from the expected descriptor.", candidate_receipt_mismatch: "The framed candidate receipt condition is stale.", candidate_bytes_changed: "The framed candidate bytes changed.", idempotency_conflict: "The Mesa activation idempotency key conflicts with stored content.", concurrent_activation: "Another model activation is in progress.", invalid_activation_protocol: "Mesa rejected the activation protocol.",
      };
      if (allowed[upstream]) throw new ApiError(response.status, upstream, allowed[upstream]);
      throw new ApiError(response.status >= 500 ? 502 : response.status, response.status >= 500 ? "mesa_upstream_failure" : "mesa_rejected", response.status >= 500 ? "Mesa failed while processing the request." : "Mesa rejected the request.");
    }
    return response;
  }
}

export class UnavailableMesaAdapter implements MesaAdapter {}

import { ApiError } from "./errors.ts";
import { canonicalJsonV2, parseCanonicalJsonV2 } from "./canonical-json-v2.ts";
import type { MesaModel, MesaResults, MesaRun, ParameterField, ParameterSchema, RunStatus, Scalar } from "./types.ts";
import type { VerifiedMesaRunEvidence } from "./durable-project-types.ts";
import type { RuntimeCandidateHandshake } from "./gate3-types.ts";

export type MesaRunRequest = {
  model_revision: string;
  steps: number;
  seeds?: number[];
  parameters: Record<string, Scalar>;
};

export type WindBootstrap = { model_id: "wind-turbine-maintenance"; model_revision_id: string; experiment_revision_id: string; preset_id: string };
export type WindDispatch = { experiment_revision_id: string; run_id: string; downstream_idempotency_key: string; downstream_request_digest: string };
export type WindEventPage = { events: Array<Record<string, unknown>>; next_after: number };
export type WindArtifact = { bytes: Buffer; media_type: string; filename: string };
export type FramedMaterializeRequest = { schema_id: "riff://mesa-wind/materialize-candidate-request/v1"; schema_version: 1; canonical_json_version: "riff-canonical-json-v2"; activation_id: string; project_id: string; expected_old_model_revision_id: string; candidate_descriptor_digest: string; intent_digest: string };
export type FramedCasRequest = { schema_id: "riff://mesa-wind/active-cas-request/v1"; schema_version: 1; canonical_json_version: "riff-canonical-json-v2"; activation_id: string; project_id: string; expected_old_model_revision_id: string; target_model_revision_id: string; candidate_receipt_digest: string; project_event_digest: string };
export const DETERMINISTIC_MESA_ADMISSION_CODES = new Set(["run_admission_mismatch", "downstream_key_conflict", "experiment_revision_drift", "active_model_revision_drift"]);

export interface MesaAdapter {
  loadModel(projectId: string, modelId: string): Promise<MesaModel>;
  startRun(projectId: string, request: MesaRunRequest): Promise<MesaRun>;
  getRun(projectId: string, runId: string): Promise<MesaRun>;
  cancelRun(projectId: string, runId: string): Promise<MesaRun>;
  getResults(projectId: string, runId: string): Promise<MesaResults>;
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

  async loadModel(projectId: string, modelId: string): Promise<MesaModel> {
    const payload = await this.#json(`/v1/projects/${encodeURIComponent(projectId)}/model`, {
      method: "PUT",
      body: JSON.stringify({ model_id: modelId }),
    });
    const schema = toParameterSchema(payload.model_schema ?? payload.modelSchema ?? payload);
    return {
      modelId: String(payload.model_id ?? payload.modelId ?? modelId),
      modelRevision: String(payload.model_revision ?? payload.modelRevision ?? payload.revision ?? ""),
      title: String(payload.model_schema?.title ?? payload.title ?? modelId),
      description: optionalString(payload.model_schema?.description ?? payload.description),
      parameterSchema: schema,
    };
  }

  async startRun(projectId: string, request: MesaRunRequest): Promise<MesaRun> {
    const payload = await this.#json(`/v1/projects/${encodeURIComponent(projectId)}/runs`, {
      method: "POST",
      body: JSON.stringify(request),
    });
    return toMesaRun(payload);
  }

  async getRun(projectId: string, runId: string): Promise<MesaRun> {
    return toMesaRun(await this.#json(`/v1/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}`));
  }

  async cancelRun(projectId: string, runId: string): Promise<MesaRun> {
    return toMesaRun(await this.#json(`/v1/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" }));
  }

  async getResults(projectId: string, runId: string): Promise<MesaResults> {
    const payload = await this.#json(`/v1/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/results`);
    return toResults(payload, runId);
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

export class UnavailableMesaAdapter implements MesaAdapter {
  #error(): never {
    throw new ApiError(503, "mesa_unconfigured", "Set MESA_SERVICE_URL before using Mesa operations.");
  }
  async loadModel(): Promise<MesaModel> { return this.#error(); }
  async startRun(): Promise<MesaRun> { return this.#error(); }
  async getRun(): Promise<MesaRun> { return this.#error(); }
  async cancelRun(): Promise<MesaRun> { return this.#error(); }
  async getResults(): Promise<MesaResults> { return this.#error(); }
}

const toParameterSchema = (payload: Record<string, any>): ParameterSchema => {
  const raw = payload.parameters ?? payload.fields ?? [];
  if (!Array.isArray(raw)) throw new ApiError(502, "mesa_invalid_schema", "Mesa returned an invalid parameter schema.");
  return {
    fields: raw.map((field: Record<string, any>): ParameterField => ({
      key: String(field.name ?? field.key),
      label: String(field.label ?? field.name ?? field.key),
      type: field.type === "integer" || field.type === "boolean" || field.type === "string" ? field.type : "number",
      default: field.default,
      minimum: numberOrUndefined(field.minimum),
      maximum: numberOrUndefined(field.maximum),
      step: numberOrUndefined(field.step),
      description: optionalString(field.description),
      required: field.required !== false,
    })),
    defaultSteps: numberOrUndefined(payload.default_steps ?? payload.defaultSteps),
    maximumSteps: numberOrUndefined(payload.maximum_steps ?? payload.maximumSteps),
  };
};

const toMesaRun = (payload: Record<string, any>): MesaRun => ({
  runId: String(payload.run_id ?? payload.runId),
  status: normalizeStatus(payload.status),
  progress: payload.progress ? {
    completedSteps: Number(payload.progress.completedSteps ?? payload.progress.completed_steps ?? 0),
    totalSteps: payload.progress.totalSteps ?? payload.progress.total_steps ?? null,
  } : undefined,
  logTail: Array.isArray(payload.log_tail ?? payload.logTail) ? (payload.log_tail ?? payload.logTail).map(String) : undefined,
  error: payload.error ? { code: String(payload.error.code ?? "mesa_error"), message: String(payload.error.message ?? "Mesa run failed.") } : undefined,
  startedAt: optionalString(payload.started_at ?? payload.startedAt),
  finishedAt: optionalString(payload.finished_at ?? payload.finishedAt),
});

const toResults = (payload: Record<string, any>, fallbackRunId: string): MesaResults => {
  if (payload.summary && payload.timeSeries && payload.table) return { ...payload, runId: String(payload.runId ?? payload.run_id ?? fallbackRunId) } as MesaResults;
  if (payload.summary && Array.isArray(payload.timeseries)) {
    const summaryPayload = payload.summary as Record<string, any>;
    const aggregate = summaryPayload.aggregate_final ?? {};
    const metrics = Array.isArray(summaryPayload.metrics) ? summaryPayload.metrics.map(String) : Object.keys(aggregate);
    const rows = payload.timeseries.map((raw: Record<string, unknown>) => Object.fromEntries(
      Object.entries(raw).map(([key, value]) => [key, numericOrText(value)]),
    )) as Array<Record<string, string | number>>;
    const firstSeed = rows[0]?.seed;
    const chartRows = firstSeed === undefined ? rows : rows.filter((row) => row.seed === firstSeed);
    return {
      runId: String(payload.run_id ?? payload.runId ?? fallbackRunId),
      summary: metrics.map((key) => ({ key, label: displayLabel(key), value: Number(aggregate[key]?.mean) })),
      timeSeries: {
        xKey: "tick",
        xLabel: "Tick",
        series: metrics.map((key) => ({ key, label: displayLabel(key), values: chartRows.map((row) => Number(row[key])) })),
      },
      table: {
        columns: ["seed", "tick", ...metrics].map((key) => ({ key, label: displayLabel(key) })),
        rows,
      },
    };
  }
  const aggregate = payload.aggregate_final ?? payload.aggregateFinal ?? {};
  return {
    runId: String(payload.run_id ?? payload.runId ?? fallbackRunId),
    summary: Object.entries(aggregate).map(([key, value]) => ({ key, label: key, value: typeof value === "object" && value !== null ? Number((value as any).mean) : Number(value) })),
    timeSeries: { xKey: "tick", xLabel: "Tick", series: [] },
    table: { columns: [], rows: [] },
  };
};

const numericOrText = (value: unknown): number | string => {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return String(value);
};

const displayLabel = (key: string): string => key.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());

const normalizeStatus = (value: unknown): RunStatus => {
  if (["queued", "running", "succeeded", "failed", "cancelled", "timed_out"].includes(String(value))) return value as RunStatus;
  return "failed";
};
const optionalString = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const numberOrUndefined = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;

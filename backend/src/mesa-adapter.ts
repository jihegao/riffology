import { ApiError } from "./errors.ts";
import type { MesaModel, MesaResults, MesaRun, ParameterField, ParameterSchema, RunStatus, Scalar } from "./types.ts";

export type MesaRunRequest = {
  model_revision: string;
  steps: number;
  seeds?: number[];
  parameters: Record<string, Scalar>;
};

export interface MesaAdapter {
  loadModel(projectId: string, modelId: string): Promise<MesaModel>;
  startRun(projectId: string, request: MesaRunRequest): Promise<MesaRun>;
  getRun(projectId: string, runId: string): Promise<MesaRun>;
  cancelRun(projectId: string, runId: string): Promise<MesaRun>;
  getResults(projectId: string, runId: string): Promise<MesaResults>;
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

  async #json(path: string, init: RequestInit = {}): Promise<Record<string, any>> {
    let response: Response;
    try {
      response = await this.request(new URL(path, this.baseUrl), {
        ...init,
        headers: { "content-type": "application/json", ...(init.headers ?? {}) },
      });
    } catch {
      throw new ApiError(503, "mesa_unavailable", "The Mesa service is not reachable.");
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = payload?.error ?? {};
      throw new ApiError(response.status, String(error.code ?? "mesa_error"), String(error.message ?? "Mesa rejected this request."), error.details);
    }
    return payload;
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
  const aggregate = payload.aggregate_final ?? payload.aggregateFinal ?? {};
  return {
    runId: String(payload.run_id ?? payload.runId ?? fallbackRunId),
    summary: Object.entries(aggregate).map(([key, value]) => ({ key, label: key, value: typeof value === "object" && value !== null ? Number((value as any).mean) : Number(value) })),
    timeSeries: { xKey: "tick", xLabel: "Tick", series: [] },
    table: { columns: [], rows: [] },
  };
};

const normalizeStatus = (value: unknown): RunStatus => {
  if (["queued", "running", "succeeded", "failed", "cancelled", "timed_out"].includes(String(value))) return value as RunStatus;
  return "failed";
};
const optionalString = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const numberOrUndefined = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;

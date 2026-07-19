import { randomInt } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ApiError } from "./errors.ts";
import type { MesaAdapter } from "./mesa-adapter.ts";
import type { WorkbenchIntent, WorkbenchProjector } from "./playwright-projection.ts";
import { ProjectStore } from "./project-store.ts";
import type { MesaRun, Scalar } from "./types.ts";

export type RestrictedAction =
  | { name: "inspect_uploaded_files"; uploadIds?: string[] }
  | { name: "select_and_load_model"; modelId: "queue-network-v1" }
  | { name: "set_parameters"; values: Record<string, Scalar> }
  | { name: "run_experiment"; steps?: number; seeds?: number[] }
  | { name: "get_run_status"; runId?: string }
  | { name: "read_run_results"; runId: string }
  | { name: "drive_workbench_ui"; intent: WorkbenchIntent };

export class SimulationActions {
  readonly store: ProjectStore;
  private readonly mesa: MesaAdapter;
  private readonly projector?: WorkbenchProjector;
  readonly #projectingSessions = new Set<string>();

  constructor(
    store: ProjectStore,
    mesa: MesaAdapter,
    projector?: WorkbenchProjector,
  ) {
    this.store = store;
    this.mesa = mesa;
    this.projector = projector;
  }

  async execute(sessionId: string, action: RestrictedAction): Promise<unknown> {
    switch (action.name) {
      case "inspect_uploaded_files": return this.inspectUploads(sessionId, action.uploadIds);
      case "select_and_load_model": return this.loadModel(sessionId, action.modelId);
      case "set_parameters": return this.saveParameters(sessionId, action.values);
      case "run_experiment": return this.startRun(sessionId, action);
      case "get_run_status": return this.syncRun(sessionId, action.runId);
      case "read_run_results": return this.readResults(sessionId, action.runId);
      case "drive_workbench_ui": return this.project(sessionId, action.intent);
    }
  }

  async inspectUploads(sessionId: string, uploadIds?: string[]): Promise<Array<{ id: string; mediaType: string; preview: string }>> {
    const state = this.store.snapshot(sessionId);
    const ids = uploadIds ?? state.attachments.filter((item) => item.status === "ready").map((item) => item.id);
    return Promise.all(ids.map(async (id) => {
      const attachment = this.store.attachment(sessionId, id);
      const raw = await readFile(attachment.workspacePath);
      return { id, mediaType: attachment.mediaType, preview: raw.subarray(0, 16 * 1024).toString("utf8") };
    }));
  }

  async loadModel(sessionId: string, modelId: string): Promise<void> {
    if (modelId !== "queue-network-v1") throw new ApiError(422, "unsupported_model", "Only queue-network-v1 is available in this demo.");
    this.store.mutate(sessionId, (draft) => {
      draft.phase = "preparing_model";
      draft.model = null;
      draft.run = null;
      draft.results = null;
    });
    try {
      const model = await this.mesa.loadModel(this.store.projectId(sessionId), modelId);
      if (!model.modelRevision) throw new ApiError(502, "mesa_invalid_model", "Mesa did not return an active model revision.");
      const parameterValues = Object.fromEntries(model.parameterSchema.fields.map((field) => [field.key, field.default]));
      this.store.mutate(sessionId, (draft) => {
        draft.phase = "model_ready";
        draft.model = {
          id: model.modelId,
          name: model.title,
          description: model.description ?? model.title,
          status: "ready",
          parameterSchema: model.parameterSchema,
          parameterValues,
          modelRevision: model.modelRevision,
        };
      });
    } catch (error) {
      this.store.mutate(sessionId, (draft) => {
        draft.phase = "failed";
        draft.model = null;
      });
      throw error;
    }
  }

  saveParameters(sessionId: string, values: Record<string, Scalar>): Record<string, Scalar> {
    const state = this.store.snapshot(sessionId);
    const normalized = this.store.validateParameters(state, values);
    this.store.mutate(sessionId, (draft) => {
      if (!draft.model) throw new ApiError(409, "model_not_ready", "Prepare a model before saving parameters.");
      draft.model.parameterValues = normalized;
      draft.phase = "model_ready";
    });
    return normalized;
  }

  async startRun(sessionId: string, options: { steps?: number; seeds?: number[] } = {}): Promise<string> {
    const state = this.store.snapshot(sessionId);
    if (!state.model?.modelRevision || state.model.status !== "ready") throw new ApiError(409, "model_not_ready", "Prepare the Mesa model before running it.");
    if (state.run && ["queued", "running"].includes(state.run.status)) throw new ApiError(409, "run_already_active", "An experiment is already running.");
    const parameters = this.store.validateParameters(state, state.model.parameterValues);
    const steps = options.steps ?? state.model.parameterSchema.defaultSteps ?? 40;
    const maximum = state.model.parameterSchema.maximumSteps ?? 500;
    if (!Number.isInteger(steps) || steps < 1 || steps > maximum) throw new ApiError(422, "invalid_steps", "Steps must be a whole number within the active model limit.");
    if (options.seeds && (!options.seeds.length || options.seeds.length > 5 || new Set(options.seeds).size !== options.seeds.length || options.seeds.some((seed) => !Number.isInteger(seed)))) {
      throw new ApiError(422, "invalid_seeds", "Seeds must be one to five unique integers.");
    }
    // Mesa records this concrete seed in request.json. The browser may override
    // it with a validated seed list, but a normal UI run is reproducible too.
    const seeds = options.seeds ?? [randomInt(0, 2 ** 31)];
    const run = await this.mesa.startRun(this.store.projectId(sessionId), {
      model_revision: state.model.modelRevision,
      steps,
      seeds,
      parameters,
    });
    this.#applyRun(sessionId, run, steps);
    if (run.status === "succeeded") await this.readResults(sessionId, run.runId);
    else if (["queued", "running"].includes(run.status)) void this.#monitor(sessionId, run.runId, steps);
    return run.runId;
  }

  async cancelRun(sessionId: string, runId: string): Promise<void> {
    const state = this.store.snapshot(sessionId);
    if (!state.run || state.run.id !== runId) throw new ApiError(404, "run_not_found", "That run does not belong to this local session.");
    const run = await this.mesa.cancelRun(this.store.projectId(sessionId), runId);
    this.#applyRun(sessionId, run, state.run.progress.totalSteps ?? 0);
  }

  async syncRun(sessionId: string, explicitRunId?: string): Promise<MesaRun> {
    const state = this.store.snapshot(sessionId);
    const runId = explicitRunId ?? state.run?.id;
    if (!runId || !state.run || state.run.id !== runId) throw new ApiError(404, "run_not_found", "There is no matching run for this local session.");
    const run = await this.mesa.getRun(this.store.projectId(sessionId), runId);
    this.#applyRun(sessionId, run, state.run.progress.totalSteps ?? 0);
    return run;
  }

  async readResults(sessionId: string, runId: string): Promise<void> {
    const state = this.store.snapshot(sessionId);
    if (!state.run || state.run.id !== runId || state.run.status !== "succeeded") {
      throw new ApiError(409, "run_not_complete", "Results are available only after a successful run.");
    }
    const results = await this.mesa.getResults(this.store.projectId(sessionId), runId);
    this.store.mutate(sessionId, (draft) => {
      draft.results = results;
      draft.phase = "succeeded";
    });
  }

  async project(sessionId: string, intent: WorkbenchIntent): Promise<{ status: "verified" | "failed"; reason?: string }> {
    if (this.#projectingSessions.has(sessionId)) {
      throw new ApiError(409, "ui_projection_busy", "A visible workbench observation is already in progress.");
    }
    this.#projectingSessions.add(sessionId);
    try {
      await this.#commitUiIntent(sessionId, intent);
      const expectedRevision = this.store.snapshot(sessionId).revision;
      const target = this.#projectionTarget(sessionId, expectedRevision);
      const verifying = this.store.mutate(sessionId, (draft) => {
        draft.uiControl = { intent: intent.type, status: "verifying", expectedRevision };
      });
      const observation = await (this.projector?.project(intent) ?? Promise.resolve({ status: "failed" as const, reason: "Browser projection is disabled." }));
      if (!this.#projectionTargetMatches(sessionId, target, verifying.revision)) {
        const stale = { status: "failed" as const, reason: "Visible workbench observation was discarded because project state advanced." };
        this.#recordUiObservation(sessionId, intent, expectedRevision, stale);
        return stale;
      }
      this.#recordUiObservation(sessionId, intent, expectedRevision, observation);
      return observation;
    } finally {
      this.#projectingSessions.delete(sessionId);
    }
  }

  #recordUiObservation(
    sessionId: string,
    intent: WorkbenchIntent,
    expectedRevision: number,
    observation: { status: "verified" | "failed"; reason?: string },
  ): void {
    this.store.mutate(sessionId, (draft) => {
      if (!draft.uiControl || draft.uiControl.intent !== intent.type || draft.uiControl.expectedRevision !== expectedRevision) return;
      draft.uiControl = {
        intent: intent.type,
        status: observation.status,
        expectedRevision,
        ...(observation.reason ? { message: observation.reason } : {}),
      };
    });
  }

  #projectionTarget(sessionId: string, expectedRevision: number): { expectedRevision: number; modelRevision?: string; runId?: string } {
    const state = this.store.snapshot(sessionId);
    return { expectedRevision, ...(state.model?.modelRevision ? { modelRevision: state.model.modelRevision } : {}), ...(state.run?.id ? { runId: state.run.id } : {}) };
  }

  #projectionTargetMatches(sessionId: string, target: { expectedRevision: number; modelRevision?: string; runId?: string }, verifyingRevision: number): boolean {
    const state = this.store.snapshot(sessionId);
    return state.revision === verifyingRevision
      && state.model?.modelRevision === target.modelRevision
      && state.run?.id === target.runId;
  }

  /** Commits the matching state/Mesa action before any Playwright observation. */
  async #commitUiIntent(sessionId: string, intent: WorkbenchIntent): Promise<void> {
    switch (intent.type) {
      case "open_tab":
        // Tabs are visual-only. The uiControl state written by project() is the
        // committed server-side observation; it carries no domain authority.
        return;
      case "set_parameter": {
        const state = this.store.snapshot(sessionId);
        if (!state.model) throw new ApiError(409, "model_not_ready", "Prepare a model before changing a parameter.");
        this.saveParameters(sessionId, { ...state.model.parameterValues, [intent.key]: intent.value });
        return;
      }
      case "start_run":
        await this.startRun(sessionId);
        return;
      case "open_results": {
        const state = this.store.snapshot(sessionId);
        if (!state.run || state.run.id !== intent.runId) throw new ApiError(404, "run_not_found", "That run does not belong to this local session.");
        if (!state.results || state.results.runId !== intent.runId) await this.readResults(sessionId, intent.runId);
        return;
      }
    }
  }

  #applyRun(sessionId: string, run: MesaRun, fallbackSteps: number): void {
    this.store.mutate(sessionId, (draft) => {
      const terminal = ["succeeded", "failed", "cancelled", "timed_out"].includes(run.status);
      draft.run = {
        id: run.runId,
        status: run.status,
        progress: run.progress ?? { completedSteps: terminal ? fallbackSteps : 0, totalSteps: fallbackSteps || null },
        logTail: run.logTail ?? [],
        ...(run.error ? { error: run.error } : {}),
        ...(run.startedAt ? { startedAt: run.startedAt } : {}),
        ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
      };
      draft.phase = run.status === "succeeded" ? "succeeded" : run.status === "timed_out" ? "timed_out" : run.status === "cancelled" ? "cancelled" : run.status === "failed" ? "failed" : "running";
      if (run.status !== "succeeded") draft.results = draft.results?.runId === run.runId ? null : draft.results;
    });
  }

  async #monitor(sessionId: string, runId: string, steps: number): Promise<void> {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      const state = this.store.snapshot(sessionId);
      if (!state.run || state.run.id !== runId || !["queued", "running"].includes(state.run.status)) return;
      try {
        const run = await this.mesa.getRun(this.store.projectId(sessionId), runId);
        this.#applyRun(sessionId, run, steps);
        if (run.status === "succeeded") await this.readResults(sessionId, runId);
        if (["succeeded", "failed", "cancelled", "timed_out"].includes(run.status)) return;
      } catch (error) {
        if (error instanceof ApiError && error.status < 500) return;
      }
    }
  }
}

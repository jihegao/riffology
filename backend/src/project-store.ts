import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { ApiError } from "./errors.ts";
import type { Attachment, BrowserEvent, JsonPatch, ProjectState, Scalar, UiCommand } from "./types.ts";

export type StoredAttachment = Attachment & {
  workspacePath: string;
  sha256: string;
  originalName: string;
};

type InternalProject = {
  state: ProjectState;
  projectId: string;
  attachments: Map<string, StoredAttachment>;
  acceptedCommands: Map<string, { accepted: true; commandId: string }>;
};

const clone = <T>(value: T): T => structuredClone(value);

export class ProjectStore {
  readonly #projects = new Map<string, InternalProject>();
  readonly #events = new EventEmitter();

  create(sessionId: string, agent?: ProjectState["agent"]): ProjectState {
    if (this.#projects.has(sessionId)) return this.snapshot(sessionId);
    const state: ProjectState = {
      sessionId,
      revision: 0,
      phase: "idle",
      agent,
      attachments: [],
      conversation: [],
      model: null,
      run: null,
      results: null,
    };
    this.#projects.set(sessionId, {
      state,
      projectId: randomUUID(),
      attachments: new Map(),
      acceptedCommands: new Map(),
    });
    return clone(state);
  }

  has(sessionId: string): boolean {
    return this.#projects.has(sessionId);
  }

  projectId(sessionId: string): string {
    return this.#get(sessionId).projectId;
  }

  snapshot(sessionId: string): ProjectState {
    return clone(this.#get(sessionId).state);
  }

  attachment(sessionId: string, attachmentId: string): StoredAttachment {
    const attachment = this.#get(sessionId).attachments.get(attachmentId);
    if (!attachment) throw new ApiError(404, "attachment_not_found", "That attachment no longer exists.");
    return clone(attachment);
  }

  beginCommand<T>(command: UiCommand<T>): { accepted: true; commandId: string } | undefined {
    const project = this.#get(command.sessionId);
    const prior = project.acceptedCommands.get(command.commandId);
    if (prior) return clone(prior);
    if (command.baseRevision !== project.state.revision) {
      throw new ApiError(409, "stale_revision", "This page is out of date. Refreshing the project state is required.", {
        currentRevision: project.state.revision,
      });
    }
    return undefined;
  }

  acceptCommand(sessionId: string, commandId: string): { accepted: true; commandId: string } {
    const acknowledgement = { accepted: true as const, commandId };
    this.#get(sessionId).acceptedCommands.set(commandId, acknowledgement);
    return acknowledgement;
  }

  mutate(sessionId: string, update: (draft: ProjectState) => void): ProjectState {
    const project = this.#get(sessionId);
    const previous = project.state;
    const draft = clone(project.state);
    update(draft);
    draft.revision = previous.revision + 1;
    project.state = draft;
    const event: BrowserEvent = {
      type: "project.patch",
      data: {
        sessionId,
        revision: draft.revision,
        operations: jsonPatch(previous, draft),
      },
    };
    this.#events.emit(sessionId, event);
    return clone(draft);
  }

  publish(sessionId: string, event: Exclude<BrowserEvent, { type: "project.snapshot" | "project.patch" }>): void {
    this.#get(sessionId);
    this.#events.emit(sessionId, clone(event));
  }

  subscribe(sessionId: string, listener: (event: BrowserEvent) => void): () => void {
    this.#get(sessionId);
    this.#events.on(sessionId, listener);
    return () => this.#events.off(sessionId, listener);
  }

  addAttachment(sessionId: string, attachment: StoredAttachment): void {
    const project = this.#get(sessionId);
    project.attachments.set(attachment.id, clone(attachment));
    this.mutate(sessionId, (draft) => {
      draft.attachments.push(this.#publicAttachment(attachment));
      if (draft.phase === "idle") draft.phase = "idle";
    });
  }

  removeAttachment(sessionId: string, attachmentId: string): StoredAttachment {
    const project = this.#get(sessionId);
    const attachment = project.attachments.get(attachmentId);
    if (!attachment) throw new ApiError(404, "attachment_not_found", "That attachment no longer exists.");
    const inUse = project.state.conversation.some((message) => message.attachmentIds?.includes(attachmentId));
    if (inUse) {
      throw new ApiError(409, "attachment_in_use", "This attachment is retained because the conversation already references it.");
    }
    project.attachments.delete(attachmentId);
    this.mutate(sessionId, (draft) => {
      draft.attachments = draft.attachments.filter((item) => item.id !== attachmentId);
    });
    return clone(attachment);
  }

  setAgent(sessionId: string, agent: ProjectState["agent"]): void {
    this.mutate(sessionId, (draft) => {
      draft.agent = agent ? clone(agent) : undefined;
    });
    if (agent) this.publish(sessionId, { type: "agent.status", data: clone(agent) });
  }

  validateParameters(state: ProjectState, values: Record<string, Scalar>): Record<string, Scalar> {
    if (!state.model || state.model.status !== "ready") {
      throw new ApiError(409, "model_not_ready", "Prepare the bundled Mesa model before saving parameters.");
    }
    const fields = state.model.parameterSchema.fields;
    const allowed = new Set(fields.map((field) => field.key));
    for (const key of Object.keys(values)) {
      if (!allowed.has(key)) throw new ApiError(422, "unknown_parameter", `Unknown parameter: ${key}.`);
    }
    const normalized: Record<string, Scalar> = {};
    for (const field of fields) {
      const value = values[field.key] ?? field.default;
      if (field.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
        throw new ApiError(422, "invalid_parameter", `${field.label} must be a finite number.`);
      }
      if (field.type === "integer" && (typeof value !== "number" || !Number.isInteger(value))) {
        throw new ApiError(422, "invalid_parameter", `${field.label} must be an integer.`);
      }
      if (field.type === "boolean" && typeof value !== "boolean") {
        throw new ApiError(422, "invalid_parameter", `${field.label} must be true or false.`);
      }
      if (field.type === "string" && typeof value !== "string") {
        throw new ApiError(422, "invalid_parameter", `${field.label} must be text.`);
      }
      if (typeof value === "number") {
        if (field.minimum !== undefined && value < field.minimum) throw new ApiError(422, "invalid_parameter", `${field.label} is below its minimum.`);
        if (field.maximum !== undefined && value > field.maximum) throw new ApiError(422, "invalid_parameter", `${field.label} is above its maximum.`);
      }
      normalized[field.key] = value;
    }
    return normalized;
  }

  #get(sessionId: string): InternalProject {
    const project = this.#projects.get(sessionId);
    if (!project) throw new ApiError(404, "session_not_found", "This local demo session does not exist.");
    return project;
  }

  #publicAttachment(attachment: Attachment): Attachment {
    const { id, displayName, mediaType, sizeBytes, status, error } = attachment;
    return error ? { id, displayName, mediaType, sizeBytes, status, error: clone(error) } : { id, displayName, mediaType, sizeBytes, status };
  }
}

/** Emits valid RFC-6902 operations at the state object's top-level keys. */
const jsonPatch = (before: ProjectState, after: ProjectState): JsonPatch[] => {
  const operations: JsonPatch[] = [];
  const prior = before as unknown as Record<string, unknown>;
  const next = after as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(prior), ...Object.keys(next)]);
  for (const key of keys) {
    const oldValue = prior[key];
    const newValue = next[key];
    if (sameJson(oldValue, newValue)) continue;
    const path = `/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
    if (newValue === undefined) operations.push({ op: "remove", path });
    else if (oldValue === undefined) operations.push({ op: "add", path, value: clone(newValue) });
    else operations.push({ op: "replace", path, value: clone(newValue) });
  }
  return operations;
};

const sameJson = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

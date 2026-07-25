import type {
  HomeDto,
  ModelCreationDto,
  OwnerKind,
  ProjectCreationDto,
  ProviderDiscovery,
  WorkspaceDto,
} from "./types";

type BrowserSession = Readonly<{
  schemaVersion: 1;
  generation: number;
  csrfToken: string;
  expiresAt: string;
}>;

export interface ProductClient {
  home(): Promise<HomeDto>;
  providers(): Promise<ProviderDiscovery>;
  createModel(input: Readonly<{
    commandId: string;
    name: string;
    providerId: string;
    modelId: string;
  }>): Promise<ModelCreationDto>;
  createProject(input: Readonly<{
    commandId: string;
    name: string;
    modelId: string;
  }>): Promise<ProjectCreationDto>;
  workspace(kind: OwnerKind, id: string): Promise<WorkspaceDto>;
}

export class ProductApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ProductApiError";
    this.status = status;
    this.code = code;
  }
}

export class HttpProductClient implements ProductClient {
  #session?: Promise<BrowserSession>;

  home(): Promise<HomeDto> {
    return this.#request<HomeDto>("/api/home");
  }

  providers(): Promise<ProviderDiscovery> {
    return this.#request<ProviderDiscovery>("/api/providers");
  }

  createModel(input: Readonly<{
    commandId: string;
    name: string;
    providerId: string;
    modelId: string;
  }>): Promise<ModelCreationDto> {
    return this.#request<ModelCreationDto>("/api/models", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  createProject(input: Readonly<{
    commandId: string;
    name: string;
    modelId: string;
  }>): Promise<ProjectCreationDto> {
    return this.#request<ProjectCreationDto>("/api/projects", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async workspace(kind: OwnerKind, id: string): Promise<WorkspaceDto> {
    const collection = kind === "model" ? "models" : "projects";
    const workspace = await this.#request<unknown>(
      `/api/${collection}/${encodeURIComponent(id)}/workspace`,
    );
    if (kind === "project") return normalizeWorkspace(kind, workspace);
    const conversationResult = await this.#request<{
      conversations: WorkspaceDto["conversations"];
    }>(`/api/objects/model/${encodeURIComponent(id)}/conversations`);
    return normalizeWorkspace(kind, workspace, conversationResult.conversations);
  }

  async #request<T>(
    path: string,
    init: Readonly<{ method?: "POST"; body?: string }> = {},
  ): Promise<T> {
    const session = await this.#browserSession();
    const response = await fetch(path, {
      method: init.method ?? "GET",
      credentials: "same-origin",
      headers: init.method === "POST"
        ? {
          "content-type": "application/json",
          "x-riff-csrf": session.csrfToken,
        }
        : undefined,
      body: init.body,
    });
    return responseJson<T>(response);
  }

  #browserSession(): Promise<BrowserSession> {
    this.#session ??= fetch("/api/browser-session/bootstrap", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).then((response) => responseJson<BrowserSession>(response))
      .catch((error) => {
        this.#session = undefined;
        throw error;
      });
    return this.#session;
  }
}

const responseJson = async <T>(response: Response): Promise<T> => {
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    throw new ProductApiError(response.status, "invalid_response", "The server returned an invalid response.");
  }
  if (!response.ok) {
    const publicError = body && typeof body === "object"
      ? (body as { error?: unknown }).error
      : undefined;
    const record = publicError && typeof publicError === "object"
      ? publicError as { code?: unknown; message?: unknown }
      : body as { code?: unknown; message?: unknown } | undefined;
    throw new ProductApiError(
      response.status,
      typeof record?.code === "string" ? record.code : "request_failed",
      typeof record?.message === "string" ? record.message : "The request could not be completed.",
    );
  }
  return body as T;
};

const normalizeWorkspace = (
  kind: OwnerKind,
  value: unknown,
  modelConversations?: WorkspaceDto["conversations"],
): WorkspaceDto => {
  if (!value || typeof value !== "object") {
    throw new ProductApiError(500, "invalid_response", "The workspace response is invalid.");
  }
  const record = value as Record<string, unknown>;
  const rawOwner = record[kind];
  const conversations = kind === "model" ? modelConversations : record.conversations;
  if (!rawOwner || typeof rawOwner !== "object" || !Array.isArray(conversations)) {
    throw new ProductApiError(500, "invalid_response", "The workspace response is invalid.");
  }
  const owner = rawOwner as Record<string, unknown>;
  if (typeof owner.id !== "string" || typeof owner.name !== "string"
    || kind === "project"
      && !["active", "archived", "trashed"].includes(String(owner.lifecycleState))) {
    throw new ProductApiError(500, "invalid_response", "The workspace owner is invalid.");
  }
  return Object.freeze({
    owner: Object.freeze({
      id: owner.id,
      name: owner.name,
      kind,
      lifecycleState: kind === "model"
        ? "active"
        : owner.lifecycleState as WorkspaceDto["owner"]["lifecycleState"],
      ...(kind === "model" && typeof owner.technicalStatus === "string"
        ? { technicalStatus: owner.technicalStatus as WorkspaceDto["owner"]["technicalStatus"] }
        : {}),
    }),
    conversations: Object.freeze(conversations as WorkspaceDto["conversations"]),
  });
};

export const defaultProductClient = new HttpProductClient();

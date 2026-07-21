import type { BrowserEvent, DemoClient, ProjectState, Scalar } from "./types";

const commandId = (): string => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;

type CommandPayload = Record<string, unknown>;

export class HttpDemoClient implements DemoClient {
  constructor(private readonly baseUrl = import.meta.env.VITE_API_BASE_URL ?? "") {}

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  async getSnapshot(sessionId: string): Promise<ProjectState> {
    const response = await fetch(this.url(`/api/sessions/${encodeURIComponent(sessionId)}/snapshot`));
    return this.readJson<ProjectState>(response);
  }

  subscribe(sessionId: string, onEvent: (event: BrowserEvent) => void): () => void {
    const source = new EventSource(this.url(`/api/sessions/${encodeURIComponent(sessionId)}/events`));
    source.onopen = () => onEvent({ type: "connection.status", data: { status: "connected" } });
    source.onerror = () => onEvent({ type: "connection.status", data: { status: "reconnecting" } });
    (["project.snapshot", "project.patch", "conversation.delta", "agent.status", "connection.status"] as const).forEach((type) => {
      source.addEventListener(type, (event) => {
        try {
          onEvent({ type, data: JSON.parse((event as MessageEvent<string>).data) } as BrowserEvent);
        } catch {
          onEvent({ type: "connection.status", data: { status: "reconnecting" } });
        }
      });
    });
    return () => source.close();
  }

  async upload(sessionId: string, baseRevision: number, file: File): Promise<void> {
    const body = new FormData();
    body.append("envelope", JSON.stringify(this.envelope(sessionId, baseRevision, { clientFileName: file.name })));
    body.append("file", file);
    await this.command(`/api/sessions/${encodeURIComponent(sessionId)}/uploads`, "POST", body);
  }

  removeAttachment(sessionId: string, baseRevision: number, attachmentId: string): Promise<void> {
    return this.command(
      `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`,
      "DELETE",
      this.envelope(sessionId, baseRevision, { attachmentId })
    );
  }

  sendChat(sessionId: string, baseRevision: number, text: string, attachmentIds: string[]): Promise<void> {
    return this.command(`/api/sessions/${encodeURIComponent(sessionId)}/chat`, "POST", this.envelope(sessionId, baseRevision, { text, attachmentIds }));
  }

  saveParameters(sessionId: string, baseRevision: number, modelId: string, values: Record<string, Scalar>): Promise<void> {
    return this.command(`/api/sessions/${encodeURIComponent(sessionId)}/parameters`, "PUT", this.envelope(sessionId, baseRevision, { modelId, values }));
  }

  startRun(sessionId: string, baseRevision: number, modelId: string, parameters: Record<string, Scalar>): Promise<void> {
    return this.command(`/api/sessions/${encodeURIComponent(sessionId)}/runs`, "POST", this.envelope(sessionId, baseRevision, { modelId, parameters }));
  }

  cancelRun(sessionId: string, baseRevision: number, runId: string): Promise<void> {
    return this.command(`/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/cancel`, "POST", this.envelope(sessionId, baseRevision, {}));
  }

  private envelope(sessionId: string, baseRevision: number, payload: CommandPayload) {
    return { commandId: commandId(), sessionId, baseRevision, payload };
  }

  private async command(path: string, method: string, body: FormData | object): Promise<void> {
    const response = await fetch(this.url(path), {
      method,
      body: body instanceof FormData ? body : JSON.stringify(body),
      headers: body instanceof FormData ? undefined : { "content-type": "application/json" }
    });
    await this.readJson(response);
  }

  private async readJson<T>(response: Response): Promise<T> {
    const body = (await response.json().catch(() => ({}))) as T & { error?: { message?: string }; accepted?: boolean };
    if (!response.ok || body.accepted === false) throw new Error(body.error?.message ?? `Request failed (${response.status})`);
    return body;
  }
}

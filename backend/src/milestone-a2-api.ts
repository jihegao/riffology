import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError } from "./errors.ts";
import type { ConversationOwner } from "./agent-domain.ts";
import { AgentWorkspaceService } from "./agent-workspace-service.ts";

export class MilestoneA2Api {
  readonly service: AgentWorkspaceService;
  readonly #authorizeProductRead?: (request: IncomingMessage) => void;
  #activeOutputDownloads = 0;
  readonly #activeOutputDownloadsByRun = new Map<string, number>();
  readonly #outputDownloadStarts: number[] = [];
  readonly #outputDownloadStartsByRun = new Map<string, number[]>();

  constructor(
    service: AgentWorkspaceService,
    options: Readonly<{
      authorizeProductRead?: (request: IncomingMessage) => void;
    }> = {},
  ) {
    this.service = service;
    this.#authorizeProductRead = options.authorizeProductRead;
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL, parts: string[]): Promise<boolean> {
    if (request.method === "POST" && url.pathname === "/a2/mcp") {
      if ([...url.searchParams.keys()].some((key) => key !== "cap") || url.searchParams.getAll("cap").length !== 1) {
        throw new ApiError(422, "invalid_mcp_capability", "The scoped A2 MCP capability query is invalid.");
      }
      const capability = url.searchParams.get("cap");
      if (!capability) throw new ApiError(401, "mcp_capability_required", "A scoped A2 MCP capability is required.");
      const body = await strictJsonBody(request, ["jsonrpc", "id", "method", "params"], ["id", "params"], 1_200_000);
      const result = await this.service.handleAgentMcp(capability, body);
      if (result === undefined) { response.writeHead(204, { "cache-control": "no-store" }); response.end(); }
      else json(response, 200, result);
      return true;
    }
    if (request.method === "GET" && url.pathname === "/a2") {
      html(response, acceptanceHtml());
      return true;
    }
    if (parts[0] !== "api") return false;
    if (request.method === "GET" && parts.length === 2 && parts[1] === "providers") {
      json(response, 200, await this.service.discoverProviders());
      return true;
    }
    if (request.method === "POST" && parts.length === 2 && parts[1] === "models") {
      const body = await strictJsonBody(request, ["commandId", "name", "providerId", "modelId"]);
      json(response, 201, await this.service.createModel({
        commandId: requiredString(body.commandId, "commandId"),
        name: requiredString(body.name, "name"),
        providerId: requiredString(body.providerId, "providerId"),
        modelId: requiredString(body.modelId, "modelId"),
      }));
      return true;
    }
    if (request.method === "POST" && parts.length === 2 && parts[1] === "projects") {
      const body = await strictJsonBody(request, ["commandId", "name", "modelId"]);
      json(response, 201, this.service.createProject({
        commandId: requiredString(body.commandId, "commandId"),
        name: requiredString(body.name, "name"),
        modelId: requiredString(body.modelId, "modelId"),
      }));
      return true;
    }
    if (request.method === "GET" && parts.length === 4 && parts[1] === "projects" && parts[3] === "workspace") {
      json(response, 200, this.service.projectWorkspace(parts[2]));
      return true;
    }
    if (parts.length >= 4 && parts[1] === "projects" && parts[3] === "runs") {
      const projectId = parts[2];
      if (request.method === "POST" && parts.length === 4) {
        const body = await strictJsonBody(
          request,
          ["commandId", "experimentConfigId", "completionConversationId"],
          ["completionConversationId"],
        );
        json(response, 201, this.service.startRun({
          projectId,
          commandId: requiredString(body.commandId, "commandId"),
          experimentConfigId: requiredString(body.experimentConfigId, "experimentConfigId"),
          ...(body.completionConversationId === undefined
            ? {}
            : { completionConversationId: requiredString(body.completionConversationId, "completionConversationId") }),
        }));
        return true;
      }
      if (request.method === "GET" && parts.length === 5) {
        json(response, 200, this.service.getRun(projectId, parts[4]));
        return true;
      }
      if (request.method === "GET" && parts.length === 6 && parts[5] === "outputs") {
        this.#authorizeOutputRead(request, url);
        privateJson(response, 200, this.service.listRunOutputs(projectId, parts[4]));
        return true;
      }
      if ((request.method === "GET" || request.method === "HEAD")
        && parts.length === 8 && parts[5] === "outputs" && parts[7] === "download") {
        this.#authorizeOutputRead(request, url);
        this.#downloadOutput(request, response, projectId, parts[4], parts[6]);
        return true;
      }
      if (request.method === "POST" && parts.length === 6 && parts[5] === "cancel") {
        const body = await strictJsonBody(request, ["commandId"]);
        json(response, 200, this.service.cancelRun({
          projectId,
          runId: parts[4],
          commandId: requiredString(body.commandId, "commandId"),
        }));
        return true;
      }
    }
    if (parts.length >= 4 && parts[1] === "projects" && parts[3] === "experiment-configs") {
      const projectId = parts[2];
      if (request.method === "POST" && parts.length === 4) {
        const body = await strictJsonBody(request, ["commandId", "name", "configuration"]);
        json(response, 201, this.service.createExperimentConfiguration({
          projectId,
          commandId: requiredString(body.commandId, "commandId"),
          name: requiredString(body.name, "name"),
          configuration: requiredObject(body.configuration, "configuration"),
        }));
        return true;
      }
      if (request.method === "PATCH" && parts.length === 5) {
        const body = await strictJsonBody(
          request,
          ["commandId", "expectedConfigurationDigest", "expectedRecordDigest", "name", "configuration"],
          ["name", "configuration"],
        );
        json(response, 200, this.service.updateExperimentConfiguration({
          projectId,
          configId: parts[4],
          commandId: requiredString(body.commandId, "commandId"),
          expectedConfigurationDigest: requiredString(body.expectedConfigurationDigest, "expectedConfigurationDigest"),
          expectedRecordDigest: requiredString(body.expectedRecordDigest, "expectedRecordDigest"),
          ...(body.name === undefined ? {} : { name: requiredString(body.name, "name") }),
          ...(body.configuration === undefined ? {} : { configuration: requiredObject(body.configuration, "configuration") }),
        }));
        return true;
      }
    }
    if (parts.length >= 4 && parts[1] === "models") {
      const modelId = parts[2];
      if (request.method === "GET" && parts.length === 4 && parts[3] === "workspace") {
        json(response, 200, this.service.modelWorkspace(modelId));
        return true;
      }
      if (request.method === "POST" && parts.length === 4 && parts[3] === "technical-checks") {
        const body = await strictJsonBody(request, ["commandId"]);
        json(response, 200, await this.service.startTechnicalCheck(modelId, requiredString(body.commandId, "commandId")));
        return true;
      }
      if (request.method === "GET" && parts.length === 5 && parts[3] === "technical-checks") {
        json(response, 200, this.service.getTechnicalCheck(modelId, parts[4]));
        return true;
      }
    }
    if (parts.length === 5 && parts[1] === "objects" && parts[4] === "conversations") {
      const owner = ownerFromRoute(parts[2], parts[3]);
      if (request.method === "GET") {
        json(response, 200, { conversations: this.service.listConversations(owner) });
        return true;
      }
      if (request.method === "POST") {
        const body = await strictJsonBody(request, ["commandId", "name", "providerId", "modelId"]);
        json(response, 201, await this.service.createConversation({
          commandId: requiredString(body.commandId, "commandId"),
          owner,
          name: requiredString(body.name, "name"),
          providerId: requiredString(body.providerId, "providerId"),
          modelId: requiredString(body.modelId, "modelId"),
        }));
        return true;
      }
    }
    if (parts.length >= 3 && parts[1] === "conversations") {
      const conversationId = parts[2];
      if (request.method === "GET" && parts.length === 3) {
        json(response, 200, this.service.getConversation(conversationId));
        return true;
      }
      if (request.method === "GET" && parts.length === 4 && parts[3] === "messages") {
        json(response, 200, { messages: this.service.listMessages(conversationId) });
        return true;
      }
      if (request.method === "GET" && parts.length === 4 && parts[3] === "documents") {
        json(response, 200, { documents: this.service.listTemporaryDocuments(conversationId) });
        return true;
      }
      if (request.method === "POST" && parts.length === 4 && parts[3] === "attachments") {
        const body = await strictJsonBody(request, ["commandId", "originalName", "mediaType", "base64", "purpose"], ["purpose"], 1_500_000);
        json(response, 201, this.service.createAttachment({
          commandId: requiredString(body.commandId, "commandId"),
          conversationId,
          originalName: requiredString(body.originalName, "originalName"),
          mediaType: requiredString(body.mediaType, "mediaType"),
          bytes: strictBase64(body.base64),
          ...(body.purpose === undefined ? {} : { purpose: requiredString(body.purpose, "purpose") }),
        }));
        return true;
      }
      if (request.method === "POST" && parts.length === 4 && parts[3] === "turns") {
        const body = await strictJsonBody(request, ["requestKey", "text", "attachmentIds", "visualInteractionConfirmation"], ["attachmentIds", "visualInteractionConfirmation"]);
        const result = await this.service.runTurn({
          conversationId,
          requestKey: requiredString(body.requestKey, "requestKey"),
          text: requiredString(body.text, "text"),
          ...(body.attachmentIds === undefined ? {} : { attachmentIds: stringArray(body.attachmentIds, "attachmentIds") }),
          ...(body.visualInteractionConfirmation === undefined ? {} : { visualInteractionConfirmation: visualInteractionConfirmation(body.visualInteractionConfirmation) }),
        });
        json(response, result.mode === "live" ? 200 : 503, result);
        return true;
      }
    }
    return false;
  }

  #authorizeOutputRead(request: IncomingMessage, url: URL): void {
    if (url.search !== "") {
      throw new ApiError(422, "invalid_output_request",
        "Output reads do not accept query parameters.");
    }
    const contentLength = exactRawHeader(request, "content-length");
    if (exactRawHeader(request, "transfer-encoding") !== undefined
      || contentLength !== undefined && contentLength !== "0") {
      throw new ApiError(422, "invalid_output_request",
        "Output reads require an empty request body.");
    }
    if (exactRawHeader(request, "if-none-match") !== undefined
      || exactRawHeader(request, "if-modified-since") !== undefined
      || exactRawHeader(request, "if-range") !== undefined) {
      throw new ApiError(422, "invalid_output_request",
        "Conditional output reads are not supported.");
    }
    if (!this.#authorizeProductRead) {
      throw new ApiError(403, "output_access_denied",
        "The output is unavailable outside the browser app session.");
    }
    try {
      this.#authorizeProductRead(request);
    } catch {
      throw new ApiError(403, "output_access_denied",
        "The output is unavailable outside the browser app session.");
    }
  }

  #downloadOutput(
    request: IncomingMessage,
    response: ServerResponse,
    projectId: string,
    runId: string,
    outputId: string,
  ): void {
    const now = Date.now();
    const cutoff = now - 1_000;
    while (this.#outputDownloadStarts[0] !== undefined
      && this.#outputDownloadStarts[0] <= cutoff) {
      this.#outputDownloadStarts.shift();
    }
    for (const [key, starts] of this.#outputDownloadStartsByRun) {
      while (starts[0] !== undefined && starts[0] <= cutoff) starts.shift();
      if (starts.length === 0) this.#outputDownloadStartsByRun.delete(key);
    }
    const runStarts = this.#outputDownloadStartsByRun.get(runId) ?? [];
    if (this.#outputDownloadStarts.length >= 24 || runStarts.length >= 8
      || !this.#outputDownloadStartsByRun.has(runId)
        && this.#outputDownloadStartsByRun.size >= 256) {
      response.setHeader("retry-after", "1");
      throw new ApiError(429, "output_download_rate_limited",
        "Output download requests are temporarily limited.");
    }
    this.#outputDownloadStarts.push(now);
    runStarts.push(now);
    this.#outputDownloadStartsByRun.set(runId, runStarts);
    if (this.#activeOutputDownloads >= 4) {
      throw new ApiError(503, "output_download_busy",
        "Too many output downloads are active.");
    }
    const runDownloads = this.#activeOutputDownloadsByRun.get(runId) ?? 0;
    if (runDownloads >= 2) {
      throw new ApiError(503, "output_download_busy",
        "Too many output downloads are active for this run.");
    }
    this.#activeOutputDownloads += 1;
    this.#activeOutputDownloadsByRun.set(runId, runDownloads + 1);
    let slotHeld = true;
    let streamTimer: ReturnType<typeof setTimeout> | undefined;
    let opened: ReturnType<AgentWorkspaceService["openRunOutputDownload"]> | undefined;
    let handedOff = false;
    const release = (): void => {
      if (!slotHeld) return;
      slotHeld = false;
      if (streamTimer) clearTimeout(streamTimer);
      opened?.read.close();
      opened = undefined;
      this.#activeOutputDownloads -= 1;
      const remaining = (this.#activeOutputDownloadsByRun.get(runId) ?? 1) - 1;
      if (remaining > 0) this.#activeOutputDownloadsByRun.set(runId, remaining);
      else this.#activeOutputDownloadsByRun.delete(runId);
    };
    try {
      opened = this.service.openRunOutputDownload(projectId, runId, outputId);
      let range: Readonly<{ start: number; end: number }> | undefined;
      try {
        range = outputRange(exactRawHeader(request, "range"), opened.read.sizeBytes);
      } catch (error) {
        response.setHeader("content-range", `bytes */${opened.read.sizeBytes}`);
        throw error;
      }
      const start = range?.start ?? 0;
      const end = range?.end ?? Math.max(0, opened.read.sizeBytes - 1);
      const length = range ? end - start + 1 : opened.read.sizeBytes;
      const headers: Record<string, string> = {
        "accept-ranges": "bytes",
        "cache-control": "private, no-store",
        "content-disposition": `attachment; filename="${downloadFilename(opened.output.id, opened.output.mediaType)}"`,
        "content-length": String(length),
        "content-security-policy": "sandbox",
        "content-type": safeDownloadMediaType(opened.output.mediaType),
        etag: `"sha256-${opened.output.sha256}"`,
        "x-content-type-options": "nosniff",
      };
      if (range) headers["content-range"] = `bytes ${start}-${end}/${opened.read.sizeBytes}`;
      if (request.method === "HEAD") {
        response.writeHead(range ? 206 : 200, headers);
        response.end();
        release();
        return;
      }
      const stream = opened.read.stream(range);
      const onError = (): void => {
        release();
        response.destroy();
      };
      stream.once("error", onError);
      response.once("close", release);
      response.once("finish", release);
      streamTimer = setTimeout(() => {
        response.destroy();
        release();
      }, 30_000);
      streamTimer.unref?.();
      response.writeHead(range ? 206 : 200, headers);
      handedOff = true;
      stream.pipe(response);
    } finally {
      if (!handedOff) release();
    }
  }
}

const exactRawHeader = (
  request: IncomingMessage,
  name: string,
): string | undefined => {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  if (values.length > 1) {
    throw new ApiError(422, "invalid_output_request",
      "The output request contains a duplicate header.");
  }
  return values[0];
};

const outputRange = (
  value: string | undefined,
  size: number,
): Readonly<{ start: number; end: number }> | undefined => {
  if (value === undefined) return undefined;
  if (value.length > 100 || !/^bytes=(?:0|[1-9]\d*)-(?:0|[1-9]\d*)$/u.test(value)) {
    throw new ApiError(416, "range_not_satisfiable",
      "The output byte range is not satisfiable.");
  }
  const [startText, endText] = value.slice(6).split("-");
  const start = Number(startText);
  const end = Number(endText);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 0 || end < start || end >= size) {
    throw new ApiError(416, "range_not_satisfiable",
      "The output byte range is not satisfiable.");
  }
  return Object.freeze({ start, end });
};

const safeDownloadMediaType = (value: string): string =>
  new Set([
    "application/json",
    "application/x-ndjson",
    "application/pdf",
    "image/jpeg",
    "image/png",
    "text/csv",
    "text/plain",
  ]).has(value.toLowerCase())
    ? value.toLowerCase()
    : "application/octet-stream";

const downloadFilename = (outputId: string, mediaType: string): string => {
  const extension = new Map([
    ["application/json", "json"],
    ["application/x-ndjson", "ndjson"],
    ["application/pdf", "pdf"],
    ["image/jpeg", "jpg"],
    ["image/png", "png"],
    ["text/csv", "csv"],
    ["text/plain", "txt"],
  ]).get(mediaType.toLowerCase()) ?? "bin";
  const safeId = /^[A-Za-z0-9_-]{3,128}$/u.test(outputId)
    ? outputId
    : "output";
  return `${safeId}.${extension}`;
};

const privateJson = (
  response: ServerResponse,
  status: number,
  payload: unknown,
): void => {
  const bytes = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "cache-control": "private, no-store",
    "content-length": bytes.byteLength,
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(bytes);
};

const ownerFromRoute = (kind: string, id: string): ConversationOwner => {
  if (kind !== "model" && kind !== "project") throw new ApiError(422, "invalid_owner", "Conversation owner must be model or project.");
  return { kind, id };
};

const strictJsonBody = async (request: IncomingMessage, allowed: string[], optional: string[] = [], maximumBytes = 128_000): Promise<Record<string, unknown>> => {
  const contentType = String(request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw new ApiError(415, "unsupported_media_type", "Use application/json.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > maximumBytes) throw new ApiError(413, "request_too_large", "The request body is too large.");
    chunks.push(bytes);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ApiError(422, "invalid_json", "The request body must be valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(422, "invalid_request", "The request body must be an object.");
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !allowed.includes(key))) throw new ApiError(422, "unknown_field", "The request contains an unsupported field.");
  if (allowed.some((key) => !optional.includes(key) && !(key in object))) throw new ApiError(422, "missing_field", "The request is missing a required field.");
  return object;
};

const requiredString = (value: unknown, name: string): string => {
  if (typeof value !== "string") throw new ApiError(422, "invalid_request", `${name} must be text.`);
  return value;
};

const visualInteractionConfirmation = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(422, "invalid_visual_interaction_confirmation", "The visual interaction confirmation is invalid.");
  const action = value as Record<string, unknown>;
  if (!new Set(["click", "type", "select"]).has(action.kind)
    || Object.keys(action).some((key) => !["kind", "locator", "value"].includes(key))
    || (action.kind === "click" ? "value" in action : typeof action.value !== "string")) throw new ApiError(422, "invalid_visual_interaction_confirmation", "The visual interaction confirmation is invalid.");
  const locator = action.locator;
  if (!locator || typeof locator !== "object" || Array.isArray(locator)) throw new ApiError(422, "invalid_visual_interaction_confirmation", "The visual interaction confirmation is invalid.");
  const record = locator as Record<string, unknown>;
  const valid = record.kind === "role_name"
    ? Object.keys(record).every((key) => ["kind", "role", "name"].includes(key)) && typeof record.role === "string" && typeof record.name === "string"
    : record.kind === "label"
      ? Object.keys(record).every((key) => ["kind", "label"].includes(key)) && typeof record.label === "string"
      : false;
  if (!valid) throw new ApiError(422, "invalid_visual_interaction_confirmation", "The visual interaction confirmation is invalid.");
  return action;
};

const requiredObject = (value: unknown, name: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(422, "invalid_request", `${name} must be an object.`);
  return value as Record<string, unknown>;
};

const stringArray = (value: unknown, name: string): string[] => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new ApiError(422, "invalid_request", `${name} must be a text array.`);
  return value;
};

const strictBase64 = (value: unknown): Buffer => {
  if (typeof value !== "string" || !value || value.length > 1_400_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new ApiError(422, "invalid_attachment", "base64 must be canonical encoded attachment bytes.");
  }
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.byteLength > 1_048_576 || bytes.toString("base64") !== value) throw new ApiError(422, "invalid_attachment", "Attachment bytes are empty or too large.");
  return bytes;
};

const json = (response: ServerResponse, status: number, payload: unknown): void => {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
  response.end(body);
};

const html = (response: ServerResponse, body: string): void => {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
};

const acceptanceHtml = (): string => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Milestone A2 technical acceptance surface</title>
<style>body{font:15px system-ui;max-width:880px;margin:32px auto;padding:0 16px;color:#17202a}fieldset{margin:16px 0;padding:16px}label{display:block;margin:8px 0}input,select,textarea,button{font:inherit;padding:7px;width:100%;box-sizing:border-box}button{width:auto;margin-top:8px}pre{background:#f4f6f7;padding:12px;overflow:auto}.note{color:#566573}</style></head>
<body>
<h1>Milestone A2 technical acceptance surface</h1>
<p class="note">Narrow API proof only. This is not the Milestone A shared product shell.</p>
<section><h2>Provider availability</h2><pre id="providers">Loading…</pre></section>
<fieldset><legend>Create generic Model</legend>
<label>Name<input id="model-name" value="Generic simulation"></label>
<label>Provider/model<select id="provider-model"></select></label>
<button id="create-model">Create Model</button></fieldset>
<fieldset><legend>Conversation turn</legend>
<label>Conversation ID<input id="conversation-id"></label>
<label>Message<textarea id="turn-text">Describe this generic model.</textarea></label>
<button id="send-turn">Send live turn</button></fieldset>
<h2>Result</h2><pre id="result">No action yet.</pre>
<script>
const providers=document.querySelector('#providers'),select=document.querySelector('#provider-model'),result=document.querySelector('#result');
const show=(target,value)=>target.textContent=JSON.stringify(value,null,2);
async function request(url,options){const response=await fetch(url,options);const value=await response.json();show(result,value);return {response,value};}
async function load(){const response=await fetch('/api/providers');const value=await response.json();show(providers,value);select.replaceChildren();for(const item of value.providerModels||[]){const option=document.createElement('option');option.value=item.qualifiedId;option.textContent=item.qualifiedId;select.append(option)}}
document.querySelector('#create-model').onclick=async()=>{const [providerId,...rest]=select.value.split('/');const modelId=rest.join('/');const created=await request('/api/models',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({commandId:crypto.randomUUID(),name:document.querySelector('#model-name').value,providerId,modelId})});if(created.response.ok){document.querySelector('#conversation-id').value=created.value.conversation.id}};
document.querySelector('#send-turn').onclick=()=>request('/api/conversations/'+encodeURIComponent(document.querySelector('#conversation-id').value)+'/turns',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestKey:crypto.randomUUID(),text:document.querySelector('#turn-text').value,attachmentIds:[]})});
load().catch(()=>show(providers,{mode:'read_only',reason:'opencode_unavailable'}));
</script></body></html>`;

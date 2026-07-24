import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError } from "./errors.ts";
import type { ConversationOwner } from "./agent-domain.ts";
import { AgentWorkspaceService } from "./agent-workspace-service.ts";

export class MilestoneA2Api {
  readonly service: AgentWorkspaceService;
  constructor(service: AgentWorkspaceService) { this.service = service; }

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
        const body = await strictJsonBody(request, ["requestKey", "text", "attachmentIds"], ["attachmentIds"]);
        const result = await this.service.runTurn({
          conversationId,
          requestKey: requiredString(body.requestKey, "requestKey"),
          text: requiredString(body.text, "text"),
          ...(body.attachmentIds === undefined ? {} : { attachmentIds: stringArray(body.attachmentIds, "attachmentIds") }),
        });
        json(response, result.mode === "live" ? 200 : 503, result);
        return true;
      }
    }
    return false;
  }
}

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

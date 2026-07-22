import type { IsoTimestamp, LifecycleState, ProductId, ResourceOwner, Sha256Digest } from "./product-domain.ts";

export type ConversationOwner = Extract<ResourceOwner, { kind: "model" | "project" }>;
export type AgentSessionState = "none" | "connecting" | "available" | "lost" | "read_only";
export type DurableAgentSessionState = "creating" | "available" | "lost" | "rebuilding" | "closed";
export type AgentTurnState = "queued" | "running" | "complete" | "failed" | "read_only";

export type ConversationDto = {
  id: ProductId;
  owner: ConversationOwner;
  name: string;
  provider: { providerId: string; modelId: string; locked: boolean };
  sessionState: AgentSessionState;
  lifecycleState: LifecycleState;
  updatedAt: IsoTimestamp;
};

export type ConversationMessageDto = {
  id: ProductId;
  ordinal: number;
  role: "user" | "assistant" | "system" | "tool";
  status: "streaming" | "complete" | "failed";
  text: string;
  content: unknown;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
};

export type SkillUseDto = {
  id: ProductId;
  skillId: string;
  skillVersion: string;
  routingMode: "explicit" | "automatic";
  loadState: "selected" | "loaded" | "failed";
  rationale: string | null;
};

export type ActionRecordDto = {
  id: ProductId;
  actionKind: string;
  intent: unknown;
  permissionDecision: "pending" | "allowed" | "denied";
  state: "proposed" | "authorized" | "staging" | "committed" | "denied" | "rolled_back" | "failed";
  affectedResources: unknown;
  errorCode: string | null;
};

export type AgentTurnDto = {
  requestKey: string;
  state: AgentTurnState;
  userMessageId: ProductId | null;
  assistantMessageId: ProductId | null;
  skillUses: SkillUseDto[];
  actions: ActionRecordDto[];
  failure: { code: string; retryable: boolean } | null;
};

export type ContextSnapshot = {
  conversationId: ProductId;
  owner: ConversationOwner;
  summary: { content: string; coveredThroughOrdinal: number } | null;
  messages: ConversationMessageDto[];
  includedMessageIds: ProductId[];
  limits: { maxMessages: number; maxBytes: number };
  digest: Sha256Digest;
};

export type StartAgentTurnIntent = {
  turnId: ProductId;
  userMessageId: ProductId;
  conversationId: ProductId;
  requestKey: string;
  text: string;
  attachmentIds?: ProductId[];
  createdAt: IsoTimestamp;
};

export type ModelFileMutation = {
  objectFileId: ProductId;
  kind: "model_code" | "model_environment" | "model_visual_asset";
  relativePath: string;
  mediaType: string;
  bytes: Uint8Array;
  expectedPriorSha256: Sha256Digest | null;
};

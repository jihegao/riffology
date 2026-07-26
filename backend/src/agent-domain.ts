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
  recordDigest: Sha256Digest;
  updatedAt: IsoTimestamp;
};

export type ConversationProviderBindingReceipt = {
  schemaVersion: 1;
  commandId: string;
  conversationId: ProductId;
  provider: { providerId: string; modelId: string; locked: false };
  previousRecordDigest: Sha256Digest;
  currentRecordDigest: Sha256Digest;
  committedAt: IsoTimestamp;
  receiptDigest: Sha256Digest;
};

export type ConversationAttachmentDto = {
  id: ProductId;
  originalName: string;
  purpose: string | null;
  mediaType: string;
  sizeBytes: number;
  sha256: Sha256Digest;
  createdAt: IsoTimestamp;
};

export type TemporaryDocumentCardDto = {
  id: ProductId;
  sourceMessageId: ProductId | null;
  name: string;
  documentState: "draft" | "adopted" | "rejected" | "superseded";
  mediaType: string;
  lifecycleState: LifecycleState;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
};

export type PublicSkillUseDto = Pick<
  SkillUseDto,
  "id" | "skillId" | "skillVersion" | "routingMode" | "loadState"
>;

export type PublicActionRecordDto = Pick<
  ActionRecordDto,
  "id" | "actionKind" | "permissionDecision" | "state" | "errorCode"
>;

export type ConversationMessageDto = {
  id: ProductId;
  ordinal: number;
  role: "user" | "assistant" | "system" | "tool";
  status: "streaming" | "complete" | "failed";
  messageKind: "conversation" | "platform_card";
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
  agentName: string | null;
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
  agentName?: string;
  attachmentIds?: ProductId[];
  visualInteractionMarker?: VisualInteractionMarker | null;
  createdAt: IsoTimestamp;
};

export type VisualInteractionMarker = Readonly<{
  schemaVersion: 1;
  actionKind: "click" | "type" | "select";
  locatorKind: "role_name" | "label";
  actionCommitmentDigest: Sha256Digest;
  valueDigest: Sha256Digest | null;
}>;

export type ModelFileMutation = {
  objectFileId: ProductId;
  kind: "model_code" | "model_environment" | "model_visual_asset";
  relativePath: string;
  mediaType: string;
  bytes: Uint8Array;
  expectedPriorSha256: Sha256Digest | null;
};

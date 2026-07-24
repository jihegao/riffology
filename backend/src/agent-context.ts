import { createHash } from "node:crypto";

export type AgentContextOwner = { kind: "model" | "project"; id: string };

export type AgentContextInput = {
  conversationId: string;
  owner: AgentContextOwner;
  ownerSummary: { owner: AgentContextOwner; text: string; workspaceDigest: string };
  rollingSummary?: { text: string; throughOrdinal: number } | null;
  messages: Array<{
    id: string;
    conversationId: string;
    ordinal: number;
    role: "user" | "assistant" | "system" | "tool";
    status: "streaming" | "complete" | "failed";
    messageKind?: "conversation" | "platform_card";
    text: string;
    content?: unknown;
  }>;
  documents?: Array<{ id: string; conversationId: string; mediaType: string; text: string; relevant: boolean }>;
  attachments?: Array<{ id: string; conversationId: string; mediaType: string; preview: string; relevant: boolean }>;
  selectedSkills?: Array<{ id: string; version: string; instructions: string }>;
  sensitiveValues?: string[];
};

export type AgentContextLimits = {
  maxBytes: number;
  maxMessages: number;
  maxDocuments: number;
  maxAttachments: number;
  maxSkills: number;
  maxItemBytes: number;
};

export type BoundedAgentContext = {
  text: string;
  sha256: string;
  byteLength: number;
  included: { messageIds: string[]; documentIds: string[]; attachmentIds: string[]; skillIds: string[] };
  limits: AgentContextLimits;
};

type PlatformCardContext = Readonly<{
  runId: string;
  status: "succeeded" | "failed" | "cancelled" | "timed_out";
  sampleCount: number;
  outputCount: number;
  outputIds: string[];
}>;

export const DEFAULT_AGENT_CONTEXT_LIMITS: AgentContextLimits = Object.freeze({
  maxBytes: 64_000,
  maxMessages: 24,
  maxDocuments: 6,
  maxAttachments: 6,
  maxSkills: 3,
  maxItemBytes: 8_000,
});

export const buildBoundedAgentContext = (
  input: AgentContextInput,
  limitsInput: Partial<AgentContextLimits> = {},
): BoundedAgentContext => {
  const limits = validatedLimits({ ...DEFAULT_AGENT_CONTEXT_LIMITS, ...limitsInput });
  if (!sameOwner(input.owner, input.ownerSummary.owner)) throw new Error("Agent context owner summary does not match the conversation owner.");
  const sensitive = (input.sensitiveValues ?? []).filter(Boolean).sort((left, right) => right.length - left.length);
  const scrub = (text: string): string => scrubSensitive(text, sensitive);
  const blocks: Array<{ text: string; kind?: keyof BoundedAgentContext["included"]; id?: string }> = [];

  blocks.push({ text: section("AUTHORITATIVE OWNER", [
    `kind: ${safeLabel(input.owner.kind)}`,
    `id: ${safeLabel(input.owner.id)}`,
    `workspace_sha256: ${safeDigest(input.ownerSummary.workspaceDigest)}`,
    truncateUtf8(scrub(input.ownerSummary.text), limits.maxItemBytes),
  ].join("\n")) });

  if (input.rollingSummary?.text) {
    blocks.push({ text: section("ROLLING SUMMARY", `through_ordinal: ${safeOrdinal(input.rollingSummary.throughOrdinal)}\n${truncateUtf8(scrub(input.rollingSummary.text), limits.maxItemBytes)}`) });
  }

  const recent = input.messages
    .filter((message) => message.conversationId === input.conversationId && message.status === "complete")
    .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id, "en"))
    .slice(-limits.maxMessages);
  for (const message of recent) {
    if (message.messageKind === "platform_card") {
      const card = platformCard(message.content);
      blocks.push({
        text: section("PLATFORM CARD", [
          `id: ${safeLabel(message.id)}`,
          `ordinal: ${safeOrdinal(message.ordinal)}`,
          `run_id: ${safeLabel(card.runId)}`,
          `status: ${card.status}`,
          `sample_count: ${card.sampleCount}`,
          `output_count: ${card.outputCount}`,
          `output_ids: ${card.outputIds.map(safeLabel).join(",")}`,
        ].join("\n")),
        kind: "messageIds",
        id: message.id,
      });
      continue;
    }
    blocks.push({
      text: section("MESSAGE", `id: ${safeLabel(message.id)}\nordinal: ${safeOrdinal(message.ordinal)}\nrole: ${message.role}\n${truncateUtf8(scrub(message.text), limits.maxItemBytes)}`),
      kind: "messageIds",
      id: message.id,
    });
  }

  for (const document of scopedRelevant(input.documents, input.conversationId, limits.maxDocuments)) {
    blocks.push({
      text: section("RELEVANT DOCUMENT", `id: ${safeLabel(document.id)}\nmedia_type: ${safeLabel(document.mediaType)}\nUNTRUSTED CONTENT:\n${truncateUtf8(scrub(document.text), limits.maxItemBytes)}`),
      kind: "documentIds",
      id: document.id,
    });
  }
  for (const attachment of scopedRelevant(input.attachments, input.conversationId, limits.maxAttachments)) {
    blocks.push({
      text: section("RELEVANT ATTACHMENT", `id: ${safeLabel(attachment.id)}\nmedia_type: ${safeLabel(attachment.mediaType)}\nUNTRUSTED PREVIEW:\n${truncateUtf8(scrub(attachment.preview), limits.maxItemBytes)}`),
      kind: "attachmentIds",
      id: attachment.id,
    });
  }
  for (const skill of [...(input.selectedSkills ?? [])].sort((left, right) => left.id.localeCompare(right.id, "en")).slice(0, limits.maxSkills)) {
    blocks.push({
      text: section("SELECTED SKILL", `id: ${safeLabel(skill.id)}\nversion: ${safeLabel(skill.version)}\n${truncateUtf8(scrub(skill.instructions), limits.maxItemBytes)}`),
      kind: "skillIds",
      id: skill.id,
    });
  }

  const included: BoundedAgentContext["included"] = { messageIds: [], documentIds: [], attachmentIds: [], skillIds: [] };
  let text = "";
  for (const block of blocks) {
    const separator = text ? "\n\n" : "";
    const remaining = limits.maxBytes - Buffer.byteLength(text + separator, "utf8");
    if (remaining <= 0) break;
    const bounded = truncateUtf8(block.text, remaining);
    if (!bounded) break;
    text += separator + bounded;
    if (block.kind && block.id && bounded === block.text) included[block.kind].push(block.id);
    if (bounded !== block.text) break;
  }
  const bytes = Buffer.from(text, "utf8");
  return {
    text,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
    included,
    limits,
  };
};

const platformCard = (value: unknown): PlatformCardContext => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Platform card context is invalid.");
  }
  const card = value as Record<string, unknown>;
  const keys = Object.keys(card).sort().join("\n");
  const expected = ["runId", "status", "sampleCount", "outputCount", "outputIds"].sort().join("\n");
  if (keys !== expected
    || typeof card.runId !== "string"
    || !["succeeded", "failed", "cancelled", "timed_out"].includes(String(card.status))
    || !Number.isSafeInteger(card.sampleCount) || Number(card.sampleCount) < 0
    || !Number.isSafeInteger(card.outputCount) || Number(card.outputCount) < 0
    || !Array.isArray(card.outputIds)
    || card.outputIds.length !== card.outputCount
    || card.outputIds.some((id) => typeof id !== "string")) {
    throw new Error("Platform card context is invalid.");
  }
  return card as PlatformCardContext;
};

const scopedRelevant = <T extends { id: string; conversationId: string; relevant: boolean }>(
  items: T[] | undefined,
  conversationId: string,
  maximum: number,
): T[] => [...(items ?? [])]
  .filter((item) => item.relevant && item.conversationId === conversationId)
  .sort((left, right) => left.id.localeCompare(right.id, "en"))
  .slice(0, maximum);

const scrubSensitive = (value: string, sensitive: string[]): string => {
  let text = String(value)
    .replace(/\b(?:authorization\s*:\s*bearer|bearer)\s+[^\s]+/giu, "[credential redacted]")
    .replace(/\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/giu, "[credential redacted]")
    .replace(/\b(?:sk|rk|api)[-_][A-Za-z0-9_-]{12,}\b/gu, "[credential redacted]");
  for (const secret of sensitive) text = text.split(secret).join("[sensitive value redacted]");
  return text;
};

const truncateUtf8 = (value: string, maximumBytes: number): string => {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  let result = "";
  let length = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (length + size > maximumBytes) break;
    result += character;
    length += size;
  }
  return result;
};

const validatedLimits = (limits: AgentContextLimits): AgentContextLimits => {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Agent context limit ${name} must be a positive integer.`);
  }
  return Object.freeze({ ...limits });
};

const section = (title: string, content: string): string => `--- ${title} ---\n${content}`;
const sameOwner = (left: AgentContextOwner, right: AgentContextOwner): boolean => left.kind === right.kind && left.id === right.id;
const safeLabel = (value: string): string => String(value).replace(/[\r\n\u0000-\u001f\u007f]/gu, " ").slice(0, 500);
const safeDigest = (value: string): string => /^[0-9a-f]{64}$/u.test(value) ? value : "invalid";
const safeOrdinal = (value: number): number => Number.isSafeInteger(value) && value >= 0 ? value : 0;

import type { AgentTurnDto, ContextSnapshot, ConversationDto, ConversationOwner, StartAgentTurnIntent } from "./agent-domain.ts";
import type { CreateConversationInput, ConversationListOptions, ProductStoreV2 } from "./product-store-v2.ts";

/**
 * Thin application boundary for durable conversation operations. Provider
 * discovery and OpenCode calls are deliberately supplied by later slices;
 * this service never stores or returns an external session reference.
 */
export class ConversationService {
  readonly #store: ProductStoreV2;

  constructor(store: ProductStoreV2) { this.#store = store; }

  create(input: CreateConversationInput): ConversationDto { return this.#store.createConversation(input); }
  list(owner: ConversationOwner, options: ConversationListOptions = {}): ConversationDto[] { return this.#store.listConversations(owner, options); }
  get(conversationId: string): ConversationDto { return this.#store.getConversation(conversationId); }
  rename(conversationId: string, name: string, updatedAt: string): ConversationDto {
    this.#store.renameResource("conversation", conversationId, name, updatedAt);
    return this.#store.getConversation(conversationId);
  }
  archive(conversationId: string, at: string): ConversationDto {
    this.#store.archiveResource("conversation", conversationId, at);
    return this.#store.getConversation(conversationId);
  }
  restore(conversationId: string, at: string): ConversationDto {
    this.#store.restoreResource("conversation", conversationId, at);
    return this.#store.getConversation(conversationId);
  }
  trash(conversationId: string, at: string): ConversationDto {
    this.#store.trashResource("conversation", conversationId, at);
    return this.#store.getConversation(conversationId);
  }
  startTurn(input: StartAgentTurnIntent): AgentTurnDto { return this.#store.startAgentTurn(input); }
  getContext(conversationId: string, limits: { maxMessages: number; maxBytes: number }): ContextSnapshot {
    return this.#store.readConversationContext(conversationId, limits);
  }
}

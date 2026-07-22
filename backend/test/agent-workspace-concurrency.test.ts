import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentWorkspaceService } from "../src/agent-workspace-service.ts";
import type { OpenCodeAssistantResponse, OpenCodeConversationPort, OpenCodePrompt, OpenCodeProviderModel } from "../src/opencode-adapter.ts";
import { ProductStoreV2 } from "../src/product-store-v2.ts";

type Deferred = { promise: Promise<void>; resolve: () => void };
const deferred = (): Deferred => {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
};

class ControlledOpenCode implements OpenCodeConversationPort {
  readonly catalogue: OpenCodeProviderModel[] = [{ providerId: "provider", modelId: "model", qualifiedId: "provider/model" }];
  readonly sessions = new Map<string, string>();
  readonly starts: Array<{ conversationId: string; text: string }> = [];
  readonly holds = new Map<string, Deferred>();
  #nextSession = 0;

  hold(text: string): Deferred { const value = deferred(); this.holds.set(text, value); return value; }
  async discoverProviderModels(): Promise<OpenCodeProviderModel[]> { return this.catalogue; }
  async getSession(sessionId: string): Promise<boolean> { return this.sessions.has(sessionId); }
  async createSession(conversationId: string): Promise<string> {
    const id = `opaque-session-${++this.#nextSession}`;
    this.sessions.set(id, conversationId);
    return id;
  }
  async injectContext(): Promise<void> {}
  async promptWithModel(sessionId: string, _binding: { providerId: string; modelId: string }, prompt: OpenCodePrompt): Promise<OpenCodeAssistantResponse> {
    const conversationId = this.sessions.get(sessionId);
    if (!conversationId) throw new Error("unknown test session");
    this.starts.push({ conversationId, text: prompt.text });
    await this.holds.get(prompt.text)?.promise;
    return { messageId: `upstream-${this.starts.length}`, text: `answer:${prompt.text}`, content: { source: "opencode", textParts: 1 } };
  }
  async abort(): Promise<void> {}
}

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("timed out waiting for concurrent turn state");
};

test("runTurn merges one request key, serializes different keys per conversation, and preserves cross-conversation parallelism", async () => {
  const parent = mkdtempSync(join(tmpdir(), "riff-agent-workspace-concurrency-"));
  const store = ProductStoreV2.open(join(parent, "store"));
  const openCode = new ControlledOpenCode();
  const service = new AgentWorkspaceService(store, openCode, () => "2026-07-22T09:00:00.000Z");
  try {
    const created = await service.createModel({ commandId: "model-command", name: "Concurrent", providerId: "provider", modelId: "model" });
    const secondConversation = await service.createConversation({ commandId: "second-conversation", owner: { kind: "model", id: created.model.id },
      name: "Second", providerId: "provider", modelId: "model" });

    const firstHold = openCode.hold("first");
    const secondHold = openCode.hold("second");
    const first = service.runTurn({ conversationId: created.conversation.id, requestKey: "request-first", text: "first" });
    await waitFor(() => openCode.starts.some((item) => item.text === "first"));
    const second = service.runTurn({ conversationId: created.conversation.id, requestKey: "request-second", text: "second" });
    const duplicateSecond = service.runTurn({ conversationId: created.conversation.id, requestKey: "request-second", text: "second" });
    assert.equal(duplicateSecond, second, "same in-flight request key must return the same Promise");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(openCode.starts.some((item) => item.text === "second"), false, "a second key for one conversation must wait");
    firstHold.resolve();
    assert.equal((await first).turn.state, "complete");
    await waitFor(() => openCode.starts.some((item) => item.text === "second"));
    secondHold.resolve();
    assert.equal((await second).turn.state, "complete");
    assert.equal((await duplicateSecond).turn.requestKey, "request-second");
    assert.deepEqual(service.listMessages(created.conversation.id).map((message) => message.ordinal), [0, 1, 2, 3]);

    const leftHold = openCode.hold("parallel-left");
    const rightHold = openCode.hold("parallel-right");
    const left = service.runTurn({ conversationId: created.conversation.id, requestKey: "parallel-left", text: "parallel-left" });
    const right = service.runTurn({ conversationId: secondConversation.id, requestKey: "parallel-right", text: "parallel-right" });
    await waitFor(() => openCode.starts.some((item) => item.text === "parallel-left") && openCode.starts.some((item) => item.text === "parallel-right"));
    assert.notEqual(openCode.starts.find((item) => item.text === "parallel-left")!.conversationId,
      openCode.starts.find((item) => item.text === "parallel-right")!.conversationId);
    leftHold.resolve(); rightHold.resolve();
    assert.deepEqual((await Promise.all([left, right])).map((result) => result.turn.state), ["complete", "complete"]);

    const recoveryHold = openCode.hold("after-invalid");
    const invalid = service.runTurn({ conversationId: created.conversation.id, requestKey: "invalid-head", text: "" });
    const afterInvalid = service.runTurn({ conversationId: created.conversation.id, requestKey: "after-invalid", text: "after-invalid" });
    await assert.rejects(invalid, /empty or too large/u);
    await waitFor(() => openCode.starts.some((item) => item.text === "after-invalid"));
    recoveryHold.resolve();
    assert.equal((await afterInvalid).turn.state, "complete", "a rejected queue head must not poison later keys");
  } finally { store.close(); rmSync(parent, { recursive: true, force: true }); }
});

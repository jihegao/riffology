import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { verifyAgentGoal } from "../src/agent-goal-verifier.ts";
import { PRODUCT_SCHEMA_VERSION } from "../src/product-domain.ts";
import {
  configureProductDatabase,
  initializeProductSchema,
  openProductDatabase,
  PRODUCT_SCHEMA_MIGRATIONS,
  PRODUCT_SCHEMA_V16_SQL,
} from "../src/product-schema.ts";
import { ProductStoreV2 } from "../src/product-store-v2.ts";

const NOW = "2026-07-26T06:00:00.000Z";
const BATCH_EXECUTION = {
  schemaVersion: 2,
  runtime: "python",
  runMode: "batch",
  dependencyFile: "environment/requirements.txt",
  inputs: {
    schemaProfile: "riff-json-schema-2020-12-v1",
    schema: { type: "object", properties: {}, additionalProperties: false },
    smoke: {},
  },
  outputs: [],
  batch: { entryPoint: "code/model.py", protocol: "riff-batch-v1" },
  cancellation: { signal: "SIGTERM", graceMs: 100 },
} as const;

const installVersion15 = (database: DatabaseSync): void => {
  configureProductDatabase(database);
  for (const migration of PRODUCT_SCHEMA_MIGRATIONS.slice(0, 15)) {
    database.exec(migration.sql);
    database.prepare(
      "UPDATE product_schema SET version = ? WHERE singleton = 1",
    ).run(migration.version);
    database.exec(`PRAGMA user_version = ${migration.version}`);
  }
};

test("schema v16 adds immutable goal receipts and a terminal-turn receipt gate", () => {
  const database = new DatabaseSync(":memory:");
  try {
    installVersion15(database);
    initializeProductSchema(database);
    assert.equal(PRODUCT_SCHEMA_VERSION, 18);
    assert.equal(
      (database.prepare("PRAGMA user_version").get() as {
        user_version: number;
      }).user_version,
      PRODUCT_SCHEMA_VERSION,
    );
    assert.equal(
      (database.prepare(
        "SELECT version FROM product_schema WHERE singleton = 1",
      ).get() as { version: number }).version,
      PRODUCT_SCHEMA_VERSION,
    );
    assert.equal(Boolean(database.prepare(
      `SELECT 1 FROM sqlite_master
       WHERE type = 'table'
         AND name = 'agent_goal_verification_receipts'`,
    ).get()), true);
    for (const trigger of [
      "agent_goal_verification_receipts_immutable_update_v16",
      "agent_goal_verification_receipts_immutable_delete_v16",
      "agent_turn_terminal_requires_goal_verification_v16",
      "agent_turn_terminal_insert_requires_goal_verification_v16",
    ]) {
      assert.equal(Boolean(database.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?",
      ).get(trigger)), true, trigger);
    }
    assert.equal(
      (database.prepare("PRAGMA quick_check").get() as {
        quick_check: string;
      }).quick_check,
      "ok",
    );
  } finally {
    database.close();
  }
});

test("schema v16 migration failure restores both version markers and its table", () => {
  const database = new DatabaseSync(":memory:");
  try {
    installVersion15(database);
    const broken = [
      ...PRODUCT_SCHEMA_MIGRATIONS.slice(0, 15),
      {
        version: 16,
        sql: `${PRODUCT_SCHEMA_V16_SQL}
          SELECT * FROM missing_v16_rollback_probe;`,
      },
    ];
    assert.throws(
      () => initializeProductSchema(database, broken),
      /missing_v16_rollback_probe/u,
    );
    assert.equal(
      (database.prepare("PRAGMA user_version").get() as {
        user_version: number;
      }).user_version,
      15,
    );
    assert.equal(
      (database.prepare(
        "SELECT version FROM product_schema WHERE singleton = 1",
      ).get() as { version: number }).version,
      15,
    );
    assert.equal(Boolean(database.prepare(
      `SELECT 1 FROM sqlite_master
       WHERE type = 'table'
         AND name = 'agent_goal_verification_receipts'`,
    ).get()), false);
  } finally {
    database.close();
  }
});

test("terminal turn and matching goal receipt commit atomically and remain immutable", () => {
  const parent = mkdtempSync(join(tmpdir(), "riff-v16-goal-atomic-"));
  const root = join(parent, "store");
  let store = ProductStoreV2.open(root);
  try {
    store.createModel({
      id: "model_v16_atomic",
      name: "V16 atomic",
      technicalStatus: "draft",
      runMode: "batch",
      executionDescription: BATCH_EXECUTION,
      createdAt: NOW,
      files: [
        {
          id: "file_v16_atomic_code",
          kind: "model_code",
          relativePath: "model.py",
          mediaType: "text/x-python",
          bytes: Buffer.from("value = 1\n"),
        },
        {
          id: "file_v16_atomic_environment",
          kind: "model_environment",
          relativePath: "requirements.txt",
          mediaType: "text/plain",
          bytes: Buffer.from(""),
        },
      ],
    });
    store.createConversation({
      id: "conversation_v16_atomic",
      owner: { kind: "model", id: "model_v16_atomic" },
      name: "Atomic",
      providerId: "provider",
      providerModelId: "model",
      createdAt: NOW,
    });
    store.startAgentTurn({
      turnId: "turn_v16_atomic",
      userMessageId: "message_v16_atomic_user",
      conversationId: "conversation_v16_atomic",
      requestKey: "request-v16-atomic",
      text: "Explain the current Model.",
      createdAt: NOW,
    });
    const evidence = store.agentGoalEvidence(
      "conversation_v16_atomic",
      "request-v16-atomic",
    );
    const receipt = verifyAgentGoal({
      phase: "idle",
      goalText: "Explain the current Model.",
      goalDigest: evidence.goalDigest,
      intentAuthority: "proposal_only",
      ownerKind: evidence.ownerKind,
      sessionGeneration: 1,
      assistantDelivered: true,
      actions: [],
      ownerEvidence: {
        stateDigest: evidence.stateDigest,
        runMode: evidence.runMode,
        executionDescriptionValid: evidence.executionDescriptionValid,
        affectedResourcesVerified: evidence.affectedResourcesVerified,
      },
      verifiedAt: NOW,
    });
    const mismatched = {
      ...receipt,
      goalDigest: "f".repeat(64),
    };
    assert.throws(
      () => store.completeAgentTurn({
        conversationId: "conversation_v16_atomic",
        requestKey: "request-v16-atomic",
        assistantMessageId: "message_v16_atomic_assistant",
        assistantText: "Current Model explained.",
        assistantContent: { textParts: 1 },
        goalVerification: mismatched,
        completedAt: NOW,
      }),
      /goal verification receipt is invalid/u,
    );
    assert.equal(
      store.latestAgentTurn("conversation_v16_atomic")?.state,
      "running",
    );
    assert.deepEqual(
      store.listConversationMessages("conversation_v16_atomic")
        .map((message) => message.role),
      ["user"],
    );

    const completed = store.completeAgentTurn({
      conversationId: "conversation_v16_atomic",
      requestKey: "request-v16-atomic",
      assistantMessageId: "message_v16_atomic_assistant",
      assistantText: "Current Model explained.",
      assistantContent: { textParts: 1 },
      goalVerification: receipt,
      completedAt: NOW,
    });
    assert.equal(completed.state, "complete");
    assert.deepEqual(completed.goalVerification, receipt);

    store.startAgentTurn({
      turnId: "turn_v16_without_receipt",
      userMessageId: "message_v16_without_receipt",
      conversationId: "conversation_v16_atomic",
      requestKey: "request-v16-without-receipt",
      text: "A second turn.",
      createdAt: NOW,
    });
    store.close();
    const database = openProductDatabase(join(root, "product.sqlite3"));
    try {
      assert.equal(
        (database.prepare(
          "SELECT count(*) AS count FROM agent_goal_verification_receipts",
        ).get() as { count: number }).count,
        1,
      );
      assert.equal(
        (database.prepare(
          "SELECT count(*) AS count FROM messages WHERE role = 'assistant'",
        ).get() as { count: number }).count,
        1,
      );
      assert.throws(
        () => database.prepare(
          `UPDATE agent_goal_verification_receipts
           SET reason_code = 'changed'
           WHERE turn_id = 'turn_v16_atomic'`,
        ).run(),
        /immutable/u,
      );
      assert.throws(
        () => database.prepare(
          `DELETE FROM agent_goal_verification_receipts
           WHERE turn_id = 'turn_v16_atomic'`,
        ).run(),
        /immutable/u,
      );
      assert.throws(
        () => database.prepare(
          `UPDATE agent_turns SET state = 'failed'
           WHERE id = 'turn_v16_without_receipt'`,
        ).run(),
        /requires goal verification/u,
      );
      assert.throws(
        () => database.prepare(
          `INSERT INTO agent_turns
            (id, conversation_id, request_key, intent_sha256,
             input_message_id, assistant_message_id, state, created_at, updated_at)
           VALUES
            ('turn_v16_terminal_insert', 'conversation_v16_atomic',
             'request-v16-terminal-insert', ?,
             'message_v16_without_receipt', 'message_v16_atomic_assistant',
             'complete', ?, ?)`,
        ).run("f".repeat(64), NOW, NOW),
        /requires goal verification/u,
      );
    } finally {
      database.close();
    }
  } finally {
    try { store.close(); } catch { /* already closed for raw inspection */ }
    rmSync(parent, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  configureProductDatabase,
  initializeProductSchema,
  PRODUCT_SCHEMA_MIGRATIONS,
  PRODUCT_SCHEMA_V17_SQL,
} from "../src/product-schema.ts";

const installVersion16 = (database: DatabaseSync): void => {
  configureProductDatabase(database);
  for (const migration of PRODUCT_SCHEMA_MIGRATIONS.slice(0, 16)) {
    database.exec(migration.sql);
    database.prepare(
      "UPDATE product_schema SET version = ? WHERE singleton = 1",
    ).run(migration.version);
    database.exec(`PRAGMA user_version = ${migration.version}`);
  }
};

test("schema v17 adds bounded generated views, change sets, and immutable receipts", () => {
  const database = new DatabaseSync(":memory:");
  try {
    installVersion16(database);
    initializeProductSchema(database);
    assert.equal(
      (database.prepare("PRAGMA user_version").get() as {
        user_version: number;
      }).user_version,
      17,
    );
    for (const table of [
      "model_generated_view_sets",
      "model_generated_views",
      "model_change_sets",
      "model_change_set_files",
      "model_change_set_receipts",
      "agent_tool_result_receipts",
    ]) {
      assert.equal(Boolean(database.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get(table)), true, table);
    }
    for (const trigger of [
      "model_change_set_receipts_immutable_update_v17",
      "model_change_set_receipts_immutable_delete_v17",
      "agent_tool_result_receipts_immutable_update_v17",
      "agent_tool_result_receipts_immutable_delete_v17",
    ]) {
      assert.equal(Boolean(database.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?",
      ).get(trigger)), true, trigger);
    }
    assert.equal(
      (database.prepare("PRAGMA foreign_key_check").get() ?? null),
      null,
    );
    assert.equal(
      (database.prepare("PRAGMA integrity_check").get() as {
        integrity_check: string;
      }).integrity_check,
      "ok",
    );
  } finally {
    database.close();
  }
});

test("schema v17 migration failure rolls back version markers and all v17 tables", () => {
  const database = new DatabaseSync(":memory:");
  try {
    installVersion16(database);
    const broken = [
      ...PRODUCT_SCHEMA_MIGRATIONS.slice(0, 16),
      {
        version: 17,
        sql: `${PRODUCT_SCHEMA_V17_SQL}
          SELECT * FROM missing_v17_rollback_probe;`,
      },
    ];
    assert.throws(
      () => initializeProductSchema(database, broken),
      /missing_v17_rollback_probe/u,
    );
    assert.equal(
      (database.prepare("PRAGMA user_version").get() as {
        user_version: number;
      }).user_version,
      16,
    );
    assert.equal(
      (database.prepare(
        "SELECT version FROM product_schema WHERE singleton = 1",
      ).get() as { version: number }).version,
      16,
    );
    assert.equal(Boolean(database.prepare(
      `SELECT 1 FROM sqlite_master
       WHERE type = 'table' AND name = 'model_change_sets'`,
    ).get()), false);
  } finally {
    database.close();
  }
});

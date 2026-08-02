import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  configureProductDatabase,
  initializeProductSchema,
  PRODUCT_SCHEMA_MIGRATIONS,
  PRODUCT_SCHEMA_V18_SQL,
} from "../src/product-schema.ts";

const installVersion17 = (database: DatabaseSync): void => {
  configureProductDatabase(database);
  for (const migration of PRODUCT_SCHEMA_MIGRATIONS.slice(0, 17)) {
    database.exec(migration.sql);
    database.prepare(
      "UPDATE product_schema SET version = ? WHERE singleton = 1",
    ).run(migration.version);
    database.exec(`PRAGMA user_version = ${migration.version}`);
  }
};

test("schema v18 adds durable WorkspaceBinding, bootstrap conversations, and receipts", () => {
  const database = new DatabaseSync(":memory:");
  try {
    installVersion17(database);
    initializeProductSchema(database);
    assert.equal((database.prepare("PRAGMA user_version").get() as {
      user_version: number;
    }).user_version, 18);
    for (const table of [
      "workspace_bootstrap_conversations",
      "workspace_bootstrap_messages",
      "workspace_bindings",
      "workspace_binding_receipts",
    ]) {
      assert.equal(Boolean(database.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get(table)), true, table);
    }
    for (const trigger of [
      "workspace_binding_scope_insert_v18",
      "workspace_binding_scope_update_v18",
      "workspace_binding_receipts_immutable_update_v18",
      "workspace_binding_receipts_immutable_delete_v18",
    ]) {
      assert.equal(Boolean(database.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?",
      ).get(trigger)), true, trigger);
    }
    assert.equal(database.prepare("PRAGMA foreign_key_check").get() ?? null, null);
    assert.equal((database.prepare("PRAGMA integrity_check").get() as {
      integrity_check: string;
    }).integrity_check, "ok");
  } finally {
    database.close();
  }
});

test("schema v18 migration failure rolls back markers and every v18 table", () => {
  const database = new DatabaseSync(":memory:");
  try {
    installVersion17(database);
    const broken = [
      ...PRODUCT_SCHEMA_MIGRATIONS.slice(0, 17),
      {
        version: 18,
        sql: `${PRODUCT_SCHEMA_V18_SQL}
          SELECT * FROM missing_v18_rollback_probe;`,
      },
    ];
    assert.throws(
      () => initializeProductSchema(database, broken),
      /missing_v18_rollback_probe/u,
    );
    assert.equal((database.prepare("PRAGMA user_version").get() as {
      user_version: number;
    }).user_version, 17);
    assert.equal((database.prepare(
      "SELECT version FROM product_schema WHERE singleton = 1",
    ).get() as { version: number }).version, 17);
    assert.equal(Boolean(database.prepare(
      `SELECT 1 FROM sqlite_master
       WHERE type = 'table' AND name = 'workspace_bindings'`,
    ).get()), false);
  } finally {
    database.close();
  }
});

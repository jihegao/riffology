import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { PRODUCT_SCHEMA_VERSION } from "../src/product-domain.ts";
import {
  configureProductDatabase,
  initializeProductSchema,
  PRODUCT_SCHEMA_MIGRATIONS,
} from "../src/product-schema.ts";

const installVersion13 = (database: DatabaseSync): void => {
  configureProductDatabase(database);
  for (const migration of PRODUCT_SCHEMA_MIGRATIONS.slice(0, 13)) {
    database.exec(migration.sql);
    database.prepare(
      "UPDATE product_schema SET version = ? WHERE singleton = 1",
    ).run(migration.version);
    database.exec(`PRAGMA user_version = ${migration.version}`);
  }
};

test("schema v14 installs durable lifecycle/delete receipts and process-private purge guards", () => {
  const database = new DatabaseSync(":memory:");
  try {
    installVersion13(database);
    initializeProductSchema(database);
    assert.equal(PRODUCT_SCHEMA_VERSION, 16);
    assert.equal(
      (database.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
      PRODUCT_SCHEMA_VERSION,
    );
    for (const table of [
      "resource_lifecycle_receipts",
      "permanent_delete_receipts",
    ]) {
      assert.equal(Boolean(database.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get(table)), true, table);
    }
    assert.equal(Boolean(database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'permanent_delete_context'",
    ).get()), false);
    for (const trigger of [
      "resource_lifecycle_receipts_immutable_update_v14",
      "resource_lifecycle_receipts_immutable_delete_v14",
      "permanent_delete_receipts_immutable_update_v14",
      "permanent_delete_receipts_immutable_delete_v14",
    ]) {
      assert.equal(Boolean(database.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?",
      ).get(trigger)), true, trigger);
    }
    assert.equal(
      (database.prepare("PRAGMA quick_check").get() as { quick_check: string })
        .quick_check,
      "ok",
    );
  } finally {
    database.close();
  }
});

test("schema v14 failure atomically restores version 13 tables and delete triggers", () => {
  const database = new DatabaseSync(":memory:");
  try {
    installVersion13(database);
    const triggerBefore = database.prepare(
      `SELECT sql FROM sqlite_master
       WHERE type = 'trigger' AND name = 'run_receipt_delete_v4'`,
    ).get() as { sql: string };
    const migrations = [
      ...PRODUCT_SCHEMA_MIGRATIONS.slice(0, 13),
      {
        version: 14,
        sql: `${PRODUCT_SCHEMA_MIGRATIONS[13]!.sql}
          INSERT INTO missing_v14_rollback_probe DEFAULT VALUES;`,
      },
      PRODUCT_SCHEMA_MIGRATIONS[14]!,
      PRODUCT_SCHEMA_MIGRATIONS[15]!,
    ];
    assert.throws(
      () => initializeProductSchema(database, migrations),
      /missing_v14_rollback_probe|no such table/u,
    );
    assert.equal(
      (database.prepare("PRAGMA user_version").get() as {
        user_version: number;
      }).user_version,
      13,
    );
    assert.equal(
      (database.prepare(
        "SELECT version FROM product_schema WHERE singleton = 1",
      ).get() as { version: number }).version,
      13,
    );
    assert.equal(Boolean(database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'permanent_delete_receipts'",
    ).get()), false);
    assert.equal(
      (database.prepare(
        `SELECT sql FROM sqlite_master
         WHERE type = 'trigger' AND name = 'run_receipt_delete_v4'`,
      ).get() as { sql: string }).sql,
      triggerBefore.sql,
    );
  } finally {
    database.close();
  }
});

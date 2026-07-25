import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { PRODUCT_SCHEMA_VERSION } from "../src/product-domain.ts";
import {
  configureProductDatabase,
  initializeProductSchema,
  PRODUCT_SCHEMA_MIGRATIONS,
  PRODUCT_SCHEMA_V15_SQL,
} from "../src/product-schema.ts";

const installVersion14 = (database: DatabaseSync): void => {
  configureProductDatabase(database);
  for (const migration of PRODUCT_SCHEMA_MIGRATIONS.slice(0, 14)) {
    database.exec(migration.sql);
    database.prepare(
      "UPDATE product_schema SET version = ? WHERE singleton = 1",
    ).run(migration.version);
    database.exec(`PRAGMA user_version = ${migration.version}`);
  }
};

test("schema v15 adds immutable Conversation provider-binding receipts", () => {
  const database = new DatabaseSync(":memory:");
  try {
    installVersion14(database);
    initializeProductSchema(database);
    assert.equal(PRODUCT_SCHEMA_VERSION, 15);
    assert.equal(
      (database.prepare("PRAGMA user_version").get() as {
        user_version: number;
      }).user_version,
      PRODUCT_SCHEMA_VERSION,
    );
    assert.equal(Boolean(database.prepare(
      `SELECT 1 FROM sqlite_master
       WHERE type = 'table'
         AND name = 'conversation_provider_binding_receipts'`,
    ).get()), true);
    for (const trigger of [
      "conversation_provider_binding_receipts_immutable_update_v15",
      "conversation_provider_binding_receipts_immutable_delete_v15",
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

test("schema v15 migration failure restores both version markers", () => {
  const database = new DatabaseSync(":memory:");
  try {
    installVersion14(database);
    const broken = [
      ...PRODUCT_SCHEMA_MIGRATIONS.slice(0, 14),
      {
        version: 15,
        sql: `${PRODUCT_SCHEMA_V15_SQL}
          SELECT * FROM missing_v15_rollback_probe;`,
      },
    ];
    assert.throws(
      () => initializeProductSchema(database, broken),
      /missing_v15_rollback_probe/u,
    );
    assert.equal(
      (database.prepare("PRAGMA user_version").get() as {
        user_version: number;
      }).user_version,
      14,
    );
    assert.equal(
      (database.prepare(
        "SELECT version FROM product_schema WHERE singleton = 1",
      ).get() as { version: number }).version,
      14,
    );
    assert.equal(Boolean(database.prepare(
      `SELECT 1 FROM sqlite_master
       WHERE type = 'table'
         AND name = 'conversation_provider_binding_receipts'`,
    ).get()), false);
  } finally {
    database.close();
  }
});

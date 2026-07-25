import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { PRODUCT_SCHEMA_VERSION } from "../src/product-domain.ts";
import {
  configureProductDatabase,
  initializeProductSchema,
  PRODUCT_SCHEMA_MIGRATIONS,
  PRODUCT_SCHEMA_V13_SQL,
  PRODUCT_SCHEMA_V14_SQL,
} from "../src/product-schema.ts";

const installVersion12 = (database: DatabaseSync): void => {
  configureProductDatabase(database);
  for (const migration of PRODUCT_SCHEMA_MIGRATIONS.slice(0, 12)) {
    database.exec(migration.sql);
    database.prepare(
      "UPDATE product_schema SET version = ? WHERE singleton = 1",
    ).run(migration.version);
    database.exec(`PRAGMA user_version = ${migration.version}`);
  }
};

test("schema v13 adds immutable preinstalled manifest identity and passes quick_check", () => {
  const database = new DatabaseSync(":memory:");
  try {
    installVersion12(database);
    initializeProductSchema(database);
    assert.equal(
      (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      PRODUCT_SCHEMA_VERSION,
    );
    assert.equal(Boolean(database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'preinstalled_manifest_installations'",
    ).get()), true);
    for (const trigger of [
      "preinstalled_manifest_identity_immutable_v13",
      "preinstalled_manifest_state_forward_v13",
      "preinstalled_manifest_immutable_delete_v13",
      "preinstalled_manifest_ready_binding_v13",
    ]) {
      assert.equal(Boolean(database.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?",
      ).get(trigger)), true, trigger);
    }
    assert.equal(
      (database.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check,
      "ok",
    );
  } finally {
    database.close();
  }
});

test("schema v13 migration failure rolls back table and both version markers", () => {
  const database = new DatabaseSync(":memory:");
  try {
    installVersion12(database);
    const schemaBefore = database.prepare(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name`,
    ).all();
    const broken = [
      ...PRODUCT_SCHEMA_MIGRATIONS.slice(0, 12),
      {
        version: 13,
        sql: `${PRODUCT_SCHEMA_V13_SQL}\nSELECT * FROM missing_v13_guard;`,
      },
      { version: 14, sql: PRODUCT_SCHEMA_V14_SQL },
    ];
    assert.throws(
      () => initializeProductSchema(database, broken),
      /missing_v13_guard/u,
    );
    assert.equal(
      (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      12,
    );
    assert.equal(
      (database.prepare("SELECT version FROM product_schema WHERE singleton = 1").get() as { version: number }).version,
      12,
    );
    assert.equal(Boolean(database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'preinstalled_manifest_installations'",
    ).get()), false);
    assert.deepEqual(
      database.prepare(
        `SELECT type, name, tbl_name, sql
         FROM sqlite_master
         WHERE name NOT LIKE 'sqlite_%'
         ORDER BY type, name`,
      ).all(),
      schemaBefore,
    );
    assert.equal(
      (database.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check,
      "ok",
    );
  } finally {
    database.close();
  }
});

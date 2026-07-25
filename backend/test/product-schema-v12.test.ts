import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { PRODUCT_SCHEMA_VERSION } from "../src/product-domain.ts";
import {
  configureProductDatabase,
  initializeProductSchema,
  PRODUCT_SCHEMA_MIGRATIONS,
  PRODUCT_SCHEMA_V12_SQL,
} from "../src/product-schema.ts";

const installVersion11 = (database: DatabaseSync): void => {
  configureProductDatabase(database);
  for (const migration of PRODUCT_SCHEMA_MIGRATIONS.slice(0, 11)) {
    database.exec(migration.sql);
    database.prepare(
      "UPDATE product_schema SET version = ? WHERE singleton = 1",
    ).run(migration.version);
    database.exec(`PRAGMA user_version = ${migration.version}`);
  }
};

test("schema v12 adds immutable diagnostic event storage and passes quick_check", () => {
  const database = new DatabaseSync(":memory:");
  try {
    installVersion11(database);
    initializeProductSchema(database);
    assert.equal(
      (database.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
      PRODUCT_SCHEMA_VERSION,
    );
    for (const table of [
      "diagnostic_event_sets",
      "diagnostic_event_files",
      "diagnostic_events",
    ]) {
      assert.equal(Boolean(database.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get(table)), true, table);
    }
    for (const trigger of [
      "diagnostic_event_set_atomic_insert_v12",
      "diagnostic_event_file_atomic_insert_v12",
      "diagnostic_event_atomic_insert_v12",
      "diagnostic_event_sets_immutable_update_v12",
      "diagnostic_event_sets_immutable_delete_v12",
      "diagnostic_event_files_immutable_update_v12",
      "diagnostic_event_files_immutable_delete_v12",
      "diagnostic_events_immutable_update_v12",
      "diagnostic_events_immutable_delete_v12",
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

test("schema v12 migration failure rolls back tables and both version markers", () => {
  const database = new DatabaseSync(":memory:");
  try {
    installVersion11(database);
    const broken = [
      ...PRODUCT_SCHEMA_MIGRATIONS.slice(0, 11),
      {
        version: 12,
        sql: `${PRODUCT_SCHEMA_V12_SQL}\nSELECT * FROM missing_v12_guard;`,
      },
      PRODUCT_SCHEMA_MIGRATIONS[12]!,
      PRODUCT_SCHEMA_MIGRATIONS[13]!,
    ];
    assert.throws(
      () => initializeProductSchema(database, broken),
      /missing_v12_guard/u,
    );
    assert.equal(
      (database.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
      11,
    );
    assert.equal(
      (database.prepare(
        "SELECT version FROM product_schema WHERE singleton = 1",
      ).get() as { version: number }).version,
      11,
    );
    assert.equal(Boolean(database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'diagnostic_events'",
    ).get()), false);
  } finally {
    database.close();
  }
});

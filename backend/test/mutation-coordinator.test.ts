import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MutationCoordinator, type DatabaseMutationStatement, type MutationCoordinatorOptions, type MutationFaultPoint } from "../src/mutation-coordinator.ts";
import { ProductObjectStore, sha256, type OwnerPath } from "../src/object-store.ts";
import { openProductDatabase, type ProductDatabase } from "../src/product-schema.ts";

const NOW = "2026-07-22T00:00:00.000Z";
const MODEL_TARGET: OwnerPath = { owner: { kind: "model", id: "model_alpha" }, relativePath: "code/model.py" };

const createFixture = (): { root: string; databasePath: string; database: ProductDatabase; objects: ProductObjectStore } => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "riff-mutation-")));
  const databasePath = join(root, "riff.sqlite3");
  const database = openProductDatabase(databasePath);
  database.prepare(`INSERT INTO models
    (id, name, technical_status, run_mode, execution_description_json, created_at, updated_at)
    VALUES ('model_alpha', 'Alpha', 'executable', 'batch', '{}', ?, ?)`
  ).run(NOW, NOW);
  return { root, databasePath, database, objects: new ProductObjectStore(root) };
};

const insertObjectRow = (database: ProductDatabase, id: string, bytes: Buffer): void => {
  database.prepare(`INSERT INTO object_files
    (id, owner_model_id, kind, relative_path, media_type, size_bytes, sha256, created_at)
    VALUES (?, 'model_alpha', 'model_code', 'code/model.py', 'text/x-python', ?, ?, ?)`
  ).run(id, bytes.byteLength, sha256(bytes), NOW);
};

const insertObjectStatement = (id: string, bytes: Buffer): DatabaseMutationStatement => ({
  sql: `INSERT INTO object_files
    (id, owner_model_id, kind, relative_path, media_type, size_bytes, sha256, created_at)
    VALUES (?, 'model_alpha', 'model_code', 'code/model.py', 'text/x-python', ?, ?, ?)`,
  params: [id, bytes.byteLength, sha256(bytes), NOW],
  expectedChanges: 1,
});

test("successful mixed write and delete commit exact bytes and SQLite receipts", () => {
  const fixture = createFixture();
  try {
    const bytes = Buffer.from("print('hello')\n");
    const coordinator = makeCoordinator(fixture.database, fixture.objects);
    coordinator.execute({ transactionId: "mutation_write_success", files: [{ operation: "write", target: MODEL_TARGET, bytes, expectedPriorSha256: null }], statements: [insertObjectStatement("file_alpha", bytes)] });
    assert.equal(fixture.objects.read(MODEL_TARGET).equals(bytes), true);
    assert.equal((fixture.database.prepare("SELECT count(*) AS count FROM committed_mutations").get() as { count: number }).count, 1);
    assert.deepEqual(fixture.objects.recoveryManifestIds(), []);
    assert.throws(() => coordinator.execute({ transactionId: "mutation_write_success", files: [{ operation: "write", target: MODEL_TARGET, bytes }], statements: [insertObjectStatement("file_other", bytes)] }), /cannot be reused/u);

    coordinator.execute({ transactionId: "mutation_delete_success", files: [{ operation: "delete", target: MODEL_TARGET, expectedPriorSha256: sha256(bytes) }], statements: [{ sql: "DELETE FROM object_files WHERE id = ?", params: ["file_alpha"], expectedChanges: 1 }] });
    assert.equal(fixture.objects.inspect(MODEL_TARGET), null);
    assert.equal((fixture.database.prepare("SELECT count(*) AS count FROM object_files").get() as { count: number }).count, 0);
    coordinator.close();
  } finally {
    fixture.database.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("same-process failure before SQLite commit restores prior bytes and database state", () => {
  const fixture = createFixture();
  try {
    const original = Buffer.from("original");
    fixture.objects.atomicReplace(fixture.objects.ensureOwnerParent(MODEL_TARGET), original);
    insertObjectRow(fixture.database, "file_alpha", original);
    const replacement = Buffer.from("replacement");
    const coordinator = makeCoordinator(fixture.database, fixture.objects, { faultInjector: failAt("after_files_promoted") });
    assert.throws(() => coordinator.execute({
      transactionId: "mutation_rollback_replace",
      files: [{ operation: "write", target: MODEL_TARGET, bytes: replacement, expectedPriorSha256: sha256(original) }],
      statements: [{ sql: "UPDATE object_files SET size_bytes = ?, sha256 = ? WHERE id = ?", params: [replacement.byteLength, sha256(replacement), "file_alpha"], expectedChanges: 1 }],
    }), /fault:after_files_promoted/u);
    assert.equal(fixture.objects.read(MODEL_TARGET).equals(original), true);
    assert.deepEqual({ ...fixture.database.prepare("SELECT size_bytes, sha256 FROM object_files WHERE id = 'file_alpha'").get() }, { size_bytes: original.byteLength, sha256: sha256(original) });
    assert.deepEqual(fixture.objects.recoveryManifestIds(), []);
    coordinator.close();
  } finally {
    fixture.database.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("same-process failure after SQLite commit rolls forward and clears recovery material", () => {
  const fixture = createFixture();
  try {
    const bytes = Buffer.from("committed");
    const coordinator = makeCoordinator(fixture.database, fixture.objects, { faultInjector: failAt("after_sqlite_commit") });
    assert.throws(() => coordinator.execute({ transactionId: "mutation_committed_fault", files: [{ operation: "write", target: MODEL_TARGET, bytes }], statements: [insertObjectStatement("file_alpha", bytes)] }), /fault:after_sqlite_commit/u);
    assert.equal(fixture.objects.read(MODEL_TARGET).equals(bytes), true);
    assert.equal((fixture.database.prepare("SELECT count(*) AS count FROM object_files").get() as { count: number }).count, 1);
    assert.deepEqual(fixture.objects.recoveryManifestIds(), []);
    coordinator.close();
  } finally {
    fixture.database.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("crash before commit is rolled back when SQLite and coordinator reopen", () => {
  const fixture = createFixture();
  const bytes = Buffer.from("uncommitted");
  try {
    const crashing = makeCoordinator(fixture.database, fixture.objects, { faultInjector: failAt("after_files_promoted"), preserveRecoveryOnFault: true });
    assert.throws(() => crashing.execute({ transactionId: "mutation_crash_rollback", files: [{ operation: "write", target: MODEL_TARGET, bytes }], statements: [insertObjectStatement("file_alpha", bytes)] }), /fault:after_files_promoted/u);
    assert.equal(fixture.objects.read(MODEL_TARGET).equals(bytes), true);
    assert.equal(fixture.objects.recoveryManifestIds().length, 1);
    crashing.close();
    fixture.database.close();

    const reopened = openProductDatabase(fixture.databasePath);
    try {
      const reopenedObjects = new ProductObjectStore(fixture.root);
      const recovered = makeCoordinator(reopened, reopenedObjects);
      assert.equal(reopenedObjects.inspect(MODEL_TARGET), null);
      assert.equal((reopened.prepare("SELECT count(*) AS count FROM object_files").get() as { count: number }).count, 0);
      assert.deepEqual(reopenedObjects.recoveryManifestIds(), []);
      recovered.close();
    } finally { reopened.close(); }
  } finally {
    if (existsSync(fixture.databasePath)) rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("crash after commit is rolled forward when SQLite and coordinator reopen", () => {
  const fixture = createFixture();
  const bytes = Buffer.from("durably committed");
  try {
    const crashing = makeCoordinator(fixture.database, fixture.objects, { faultInjector: failAt("after_sqlite_commit"), preserveRecoveryOnFault: true });
    assert.throws(() => crashing.execute({ transactionId: "mutation_crash_forward", files: [{ operation: "write", target: MODEL_TARGET, bytes }], statements: [insertObjectStatement("file_alpha", bytes)] }), /fault:after_sqlite_commit/u);
    crashing.close();
    fixture.database.close();

    const reopened = openProductDatabase(fixture.databasePath);
    try {
      const reopenedObjects = new ProductObjectStore(fixture.root);
      const recovered = makeCoordinator(reopened, reopenedObjects);
      assert.equal(reopenedObjects.read(MODEL_TARGET).equals(bytes), true);
      assert.equal((reopened.prepare("SELECT count(*) AS count FROM object_files").get() as { count: number }).count, 1);
      assert.deepEqual(reopenedObjects.recoveryManifestIds(), []);
      recovered.close();
    } finally { reopened.close(); }
  } finally {
    if (existsSync(fixture.databasePath)) rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("orphan staging left before a manifest is durably published is removed on recovery", () => {
  const fixture = createFixture();
  try {
    fixture.objects.createTransactionDirectory("mutation_orphan_stage");
    assert.deepEqual(fixture.objects.stagingTransactionIds(), ["mutation_orphan_stage"]);
    const coordinator = makeCoordinator(fixture.database, fixture.objects);
    assert.deepEqual(fixture.objects.stagingTransactionIds(), []);
    coordinator.close();
  } finally {
    fixture.database.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("baseline ownership rejects no-op plans and missing owners without a replaceable validator", () => {
  const fixture = createFixture();
  try {
    assert.throws(() => new MutationCoordinator(fixture.database, fixture.objects, { additionalOwnershipValidator: async () => undefined } as any), /unsupported capability/u);
    const coordinator = makeCoordinator(fixture.database, fixture.objects);
    assert.throws(() => coordinator.execute({
      transactionId: "mutation_noop_write",
      files: [{ operation: "write", target: MODEL_TARGET, bytes: Buffer.from("x") }],
      statements: [{ sql: "UPDATE models SET updated_at = updated_at WHERE id = ?", params: ["model_alpha"], expectedChanges: 1 }],
    }), /not bound to matching database metadata/u);
    const missingOwner: OwnerPath = { owner: { kind: "model", id: "model_missing" }, relativePath: "code/model.py" };
    assert.throws(() => coordinator.execute({
      transactionId: "mutation_missing_owner",
      files: [{ operation: "write", target: missingOwner, bytes: Buffer.from("x") }],
      statements: [{ sql: "UPDATE models SET updated_at = updated_at WHERE id = ?", params: ["model_missing"], expectedChanges: 0 }],
    }), /owner does not exist/u);
    assert.equal(fixture.objects.inspect(MODEL_TARGET), null);
    assert.equal(fixture.objects.inspect(missingOwner), null);
    coordinator.close();
  } finally {
    fixture.database.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a new Project owner and its copied file metadata can commit in the same transaction", () => {
  const fixture = createFixture();
  try {
    const bytes = Buffer.from("project snapshot");
    const target: OwnerPath = { owner: { kind: "project", id: "project_new" }, relativePath: "model-snapshot/model.py" };
    const coordinator = makeCoordinator(fixture.database, fixture.objects);
    coordinator.execute({
      transactionId: "mutation_new_project_snapshot",
      files: [{ operation: "write", target, bytes, expectedPriorSha256: null }],
      statements: [
        {
          sql: `INSERT INTO projects
            (id, name, source_model_id, model_snapshot_digest, execution_description_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, '{}', ?, ?)`,
          params: ["project_new", "New project", "model_alpha", sha256(bytes), NOW, NOW],
          expectedChanges: 1,
        },
        {
          sql: `INSERT INTO object_files
            (id, owner_project_id, kind, relative_path, media_type, size_bytes, sha256, created_at)
            VALUES (?, ?, 'project_model_snapshot', ?, 'text/x-python', ?, ?, ?)`,
          params: ["file_project_snapshot", "project_new", target.relativePath, bytes.byteLength, sha256(bytes), NOW],
          expectedChanges: 1,
        },
      ],
    });
    assert.equal(fixture.objects.read(target).equals(bytes), true);
    assert.deepEqual({ ...fixture.database.prepare("SELECT source_model_id, model_snapshot_digest FROM projects WHERE id = ?").get("project_new") }, { source_model_id: "model_alpha", model_snapshot_digest: sha256(bytes) });
    coordinator.close();
  } finally {
    fixture.database.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("raw or async callbacks are not expressible and unsupported executable fields are rejected", () => {
  const fixture = createFixture();
  try {
    const coordinator = makeCoordinator(fixture.database, fixture.objects);
    let invoked = false;
    assert.throws(() => coordinator.execute({
      transactionId: "mutation_raw_callback_rejected",
      files: [{ operation: "write", target: MODEL_TARGET, bytes: Buffer.from("async") }],
      statements: [insertObjectStatement("file_alpha", Buffer.from("async"))],
      mutate: async () => { invoked = true; },
    } as any), /unsupported executable fields/u);
    assert.equal(invoked, false);
    assert.throws(() => coordinator.execute({
      transactionId: "mutation_missing_expected_changes",
      files: [{ operation: "write", target: MODEL_TARGET, bytes: Buffer.from("x") }],
      statements: [{ sql: "UPDATE models SET updated_at = updated_at WHERE id = ?", params: ["model_alpha"], expectedChanges: undefined } as any],
    }), /transactional, or unsupported/u);
    for (const sql of ["COMMIT", "ROLLBACK", "PRAGMA foreign_keys = OFF", "ATTACH 'x' AS other"]) {
      assert.throws(() => coordinator.execute({ transactionId: `mutation_forbidden_${sql.split(" ")[0]!.toLowerCase()}`, files: [{ operation: "write", target: MODEL_TARGET, bytes: Buffer.from("x") }], statements: [{ sql, expectedChanges: 0 }] }), /transactional, or unsupported/u);
    }
    assert.equal(fixture.objects.inspect(MODEL_TARGET), null);
    assert.deepEqual(fixture.objects.recoveryManifestIds(), []);
    coordinator.close();
  } finally {
    fixture.database.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rollback failure remains fail closed without querying receipts or removing recovery lock", () => {
  const fixture = createFixture();
  try {
    const coordinator = makeCoordinator(fixture.database, fixture.objects);
    const originalExec = fixture.database.exec.bind(fixture.database);
    (fixture.database as any).exec = (sql: string): void => {
      if (sql === "ROLLBACK") throw new Error("injected rollback failure");
      originalExec(sql);
    };
    assert.throws(() => coordinator.execute({
      transactionId: "mutation_rollback_failure",
      files: [{ operation: "write", target: MODEL_TARGET, bytes: Buffer.from("x") }],
      statements: [{ sql: "UPDATE models SET updated_at = updated_at WHERE id = ?", params: ["model_alpha"], expectedChanges: 1 }],
    }), /rollback failed.*retained/iu);
    assert.equal(fixture.objects.recoveryManifestIds().length, 1);
    assert.equal(existsSync(fixture.objects.writerLockPath), true);
    assert.throws(() => coordinator.execute({ transactionId: "mutation_after_poison", files: [{ operation: "write", target: MODEL_TARGET, bytes: Buffer.from("no") }], statements: [insertObjectStatement("file_no", Buffer.from("no"))] }), /poisoned/u);
    coordinator.close();
    assert.equal(existsSync(fixture.objects.writerLockPath), true);
  } finally {
    fixture.database.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("writer lock rejects a live second writer and quarantines a confirmed-dead stale owner before recovery", () => {
  const fixture = createFixture();
  try {
    const first = makeCoordinator(fixture.database, fixture.objects);
    assert.throws(() => makeCoordinator(fixture.database, fixture.objects), /Another mutation writer/u);
    first.close();

    fixture.objects.createTransactionDirectory("mutation_stale_orphan");
    writeFileSync(fixture.objects.writerLockPath, `${JSON.stringify({ schemaVersion: 1, pid: 999_999_999, processStartToken: "dead", instanceId: "a".repeat(32) })}\n`, { mode: 0o600, flag: "wx" });
    const recovered = makeCoordinator(fixture.database, fixture.objects);
    assert.deepEqual(fixture.objects.stagingTransactionIds(), []);
    assert.equal(readdirSync(fixture.objects.quarantineRoot).some((name) => name.startsWith("stale-writer-lock-")), true);
    recovered.close();
  } finally {
    fixture.database.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("unpublished manifest temps are cleaned, while a truncated published manifest fails closed", () => {
  const fixture = createFixture();
  try {
    const tempName = `.manifest-tmp-mutation_temp_cleanup-${"a".repeat(32)}`;
    fixture.objects.writeDurable(join(fixture.objects.recoveryRoot, tempName), Buffer.from("partial"));
    const cleaner = makeCoordinator(fixture.database, fixture.objects);
    assert.equal(existsSync(join(fixture.objects.recoveryRoot, tempName)), false);
    cleaner.close();

    fixture.objects.writeDurable(fixture.objects.recoveryManifestPath("mutation_truncated_final"), Buffer.from('{"schemaVersion":1'));
    assert.throws(() => makeCoordinator(fixture.database, fixture.objects), /not valid JSON/u);
    assert.equal(existsSync(fixture.objects.recoveryManifestPath("mutation_truncated_final")), true);
    fixture.objects.unlinkExact(fixture.objects.recoveryManifestPath("mutation_truncated_final"));
  } finally {
    fixture.database.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("recovery manifests reject mismatched digest-size null pairs", () => {
  const variants = [
    { operation: "write", priorSha256: "a".repeat(64), priorSizeBytes: null, nextSha256: "b".repeat(64), nextSizeBytes: 1, backupRelativePath: "backup/00000000.bin", stagedRelativePath: "next/00000000.bin" },
    { operation: "delete", priorSha256: "a".repeat(64), priorSizeBytes: 1, nextSha256: "b".repeat(64), nextSizeBytes: null, backupRelativePath: "backup/00000000.bin", stagedRelativePath: null },
  ] as const;
  variants.forEach((variant, index) => {
    const fixture = createFixture();
    const transactionId = `mutation_invalid_pair_${index}`;
    try {
      fixture.objects.createTransactionDirectory(transactionId);
      const core = { schemaVersion: 1, transactionId, createdAt: NOW, operations: [{ ...variant, target: MODEL_TARGET }] };
      const manifest = { ...core, manifestSha256: sha256(Buffer.from(`${JSON.stringify(core)}\n`)) };
      fixture.objects.publishRecoveryManifest(transactionId, Buffer.from(`${JSON.stringify(manifest)}\n`));
      assert.throws(() => makeCoordinator(fixture.database, fixture.objects), /manifest operation is invalid/u);
    } finally {
      if (existsSync(fixture.objects.recoveryManifestPath(transactionId))) fixture.objects.unlinkExact(fixture.objects.recoveryManifestPath(transactionId));
      fixture.objects.removeTransactionDirectory(transactionId);
      fixture.database.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

const failAt = (expected: MutationFaultPoint) => (point: MutationFaultPoint): void => {
  if (point === expected) throw new Error(`fault:${point}`);
};

const makeCoordinator = (database: ProductDatabase, objects: ProductObjectStore, options: MutationCoordinatorOptions = {}): MutationCoordinator => new MutationCoordinator(database, objects, options);

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { MutationFaultPoint } from "../src/mutation-coordinator.ts";
import { ProductStoreV2, type CreateModelInput, type ProductStoreFaultPoint } from "../src/product-store-v2.ts";
import { openProductDatabase } from "../src/product-schema.ts";

const NOW = "2026-07-22T03:00:00.000Z";
const input = (suffix: string): CreateModelInput => ({
  id: `model_${suffix}`,
  name: `Model ${suffix}`,
  technicalStatus: "executable",
  runMode: "batch",
  executionDescription: { entryPoint: "model.py" },
  createdAt: NOW,
  files: [{ id: `file_${suffix}`, kind: "model_code", relativePath: "model.py", mediaType: "text/x-python", bytes: Buffer.from(`print('${suffix}')\n`) }],
});

test("fresh initialization never publishes a partial root across initialization faults", () => {
  for (const point of ["after_staging_root", "after_schema", "before_root_publish", "after_root_publish"] satisfies ProductStoreFaultPoint[]) {
    const parent = mkdtempSync(join(tmpdir(), `riff-product-init-${point}-`));
    const root = join(parent, "store");
    try {
      assert.throws(() => ProductStoreV2.openForTesting(root, { initFaultInjector(seen) { if (seen === point) throw new Error(`fault:${point}`); } }), new RegExp(`fault:${point}`, "u"));
      if (point === "after_root_publish") {
        assert.equal(existsSync(join(root, "product.sqlite3")), true);
        const reopened = ProductStoreV2.open(root); reopened.close();
      } else {
        assert.equal(existsSync(root), false);
      }
      assert.equal(readdirSync(parent).some((name) => name.includes(".product-init-")), false);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  }
});

test("four createModel fault boundaries recover and lost-response retry is exactly idempotent", () => {
  for (const point of ["after_manifest", "after_database_changes", "after_files_promoted", "after_sqlite_commit"] satisfies MutationFaultPoint[]) {
    const parent = mkdtempSync(join(tmpdir(), `riff-product-mutation-${point}-`));
    const root = join(parent, "store");
    let store: ProductStoreV2 | undefined;
    try {
      store = ProductStoreV2.openForTesting(root, { coordinatorOptions: { faultInjector(seen) { if (seen === point) throw new Error(`fault:${point}`); } } });
      assert.throws(() => store!.createModel(input(point)), new RegExp(`fault:${point}`, "u"));
      const committed = point === "after_sqlite_commit";
      assert.equal(store.listModels({ includeArchived: true, includeTrashed: true }).length, committed ? 1 : 0, point);
      assert.equal(existsSync(join(root, "objects/models", `model_${point}`, "code/model.py")), committed, point);
      assert.deepEqual(readdirSync(join(root, ".recovery")), []);
      if (committed) {
        assert.equal(store.createModel(input(point)).id, `model_${point}`);
        assert.throws(() => store!.createModel({ ...input(point), name: "conflict" }), /different creation intent/u);
        assert.equal(store.listModels({ includeArchived: true, includeTrashed: true }).length, 1);
        const files = store.listObjectFiles({ kind: "model", id: `model_${point}` });
        assert.equal(files.length, 1);
        assert.equal(store.readObjectFile(files[0]!.id).equals(Buffer.from(`print('${point}')\n`)), true);
      }
      store.close(); store = undefined;
      const reopened = ProductStoreV2.open(root);
      assert.equal(reopened.listModels({ includeArchived: true, includeTrashed: true }).length, committed ? 1 : 0, point);
      reopened.close();
    } finally { store?.close(); rmSync(parent, { recursive: true, force: true }); }
  }
});

test("project lost-response retry is idempotent and source CAS rejects an after-manifest archive", () => {
  for (const mode of ["lost_response", "source_race"] as const) {
    const parent = mkdtempSync(join(tmpdir(), `riff-product-project-${mode}-`));
    const root = join(parent, "store");
    let initial = ProductStoreV2.open(root);
    initial.createModel(input(mode));
    initial.close();
    try {
      let injected = false;
      const store = ProductStoreV2.openForTesting(root, { coordinatorOptions: { faultInjector(point) {
        if (injected) return;
        if (mode === "lost_response" && point === "after_sqlite_commit") { injected = true; throw new Error("lost response"); }
        if (mode === "source_race" && point === "after_manifest") {
          injected = true;
          const other = openProductDatabase(join(root, "product.sqlite3"));
          other.prepare("UPDATE models SET lifecycle_state = 'archived', archived_at = ?, updated_at = ? WHERE id = ?").run(NOW, NOW, `model_${mode}`);
          other.close();
        }
      } } });
      const intent = { projectId: `project_${mode}`, projectName: "Project", sourceModelId: `model_${mode}`, createdAt: NOW };
      if (mode === "lost_response") {
        assert.throws(() => store.createProjectFromModel(intent), /lost response/u);
        const replay = store.createProjectFromModel(intent);
        assert.equal(replay.id, intent.projectId);
        assert.equal(store.listProjects({ includeArchived: true, includeTrashed: true }).length, 1);
        assert.throws(() => store.createProjectFromModel({ ...intent, projectName: "Conflict" }), /different creation intent/u);
        assert.equal(store.listObjectFiles({ kind: "project", id: intent.projectId }).filter((file) => file.kind === "project_model_snapshot").length, 1);
      } else {
        assert.throws(() => store.createProjectFromModel(intent), /unexpected number of rows/u);
        assert.equal(store.listProjects({ includeArchived: true, includeTrashed: true }).length, 0);
      }
      store.close();
    } finally { rmSync(parent, { recursive: true, force: true }); }
  }
});

test("abrupt child crashes before and after SQLite commit converge on reopen", () => {
  const moduleUrl = new URL("../src/product-store-v2.ts", import.meta.url).href;
  for (const [point, expected] of [["after_files_promoted", 0], ["after_sqlite_commit", 1]] as const) {
    const parent = mkdtempSync(join(tmpdir(), `riff-product-child-${point}-`));
    const root = join(parent, "store");
    const initial = ProductStoreV2.open(root); initial.close();
    try {
      const childCode = `
        import { ProductStoreV2 } from ${JSON.stringify(moduleUrl)};
        const store = ProductStoreV2.openForTesting(${JSON.stringify(root)}, { coordinatorOptions: {
          preserveRecoveryOnFault: true,
          faultInjector(point) { if (point === ${JSON.stringify(point)}) throw new Error('crash'); }
        }});
        try { store.createModel({
          id: ${JSON.stringify(`model_child_${point}`)}, name: 'Child', technicalStatus: 'executable', runMode: 'batch',
          executionDescription: { entryPoint: 'model.py' }, createdAt: ${JSON.stringify(NOW)},
          files: [{ id: ${JSON.stringify(`file_child_${point}`)}, kind: 'model_code', relativePath: 'model.py', mediaType: 'text/x-python', bytes: Buffer.from('child') }]
        }); } catch { process.exit(77); }
        process.exit(99);
      `;
      const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", childCode], { encoding: "utf8" });
      assert.equal(child.status, 77, child.stderr);
      const reopened = ProductStoreV2.open(root);
      try {
        assert.equal(reopened.listModels({ includeArchived: true, includeTrashed: true }).length, expected, point);
        assert.deepEqual(readdirSync(join(root, ".recovery")), []);
      } finally { reopened.close(); }
    } finally { rmSync(parent, { recursive: true, force: true }); }
  }
});

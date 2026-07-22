import assert from "node:assert/strict";
import { chmodSync, linkSync, mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProductObjectStore, sha256, UnsafeObjectPathError, type OwnerPath } from "../src/object-store.ts";

const withStore = (run: (root: string, store: ProductObjectStore) => void): void => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "riff-object-store-")));
  try { run(root, new ProductObjectStore(root)); } finally { rmSync(root, { recursive: true, force: true }); }
};

test("owner roots are deterministic and run files require their Project owner", () => withStore((root, store) => {
  assert.equal(store.ownerRoot({ kind: "model", id: "model_alpha" }), join(root, "objects", "models", "model_alpha"));
  assert.equal(store.ownerRoot({ kind: "project", id: "project_alpha" }), join(root, "objects", "projects", "project_alpha"));
  assert.equal(store.ownerRoot({ kind: "conversation", id: "conversation_alpha" }), join(root, "objects", "conversations", "conversation_alpha"));
  assert.equal(store.ownerRoot({ kind: "run", id: "run_alpha" }, "project_alpha"), join(root, "objects", "projects", "project_alpha", "runs", "run_alpha"));
  assert.throws(() => store.ownerRoot({ kind: "run", id: "run_alpha" }), /requires its Project ID/u);
}));

test("relative paths, owner IDs and canonical roots fail closed", () => withStore((_root, store) => {
  const unsafePaths = ["/absolute", "../escape", "code/../escape", "code/./model.py", "code//model.py", "code\\model.py", "code/\0model.py", "code/"];
  for (const relativePath of unsafePaths) {
    assert.throws(() => store.resolveOwnerPath({ owner: { kind: "model", id: "model_alpha" }, relativePath }), UnsafeObjectPathError);
  }
  assert.throws(() => store.ownerRoot({ kind: "model", id: "../model" }), /not path-safe/u);
  assert.throws(() => store.atomicReplace(join(store.root, "unmanaged.txt"), Buffer.from("no")), /outside managed/u);
}));

test("nested and root symlinks are rejected without touching their targets", () => withStore((root, store) => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "riff-object-outside-")));
  try {
    const modelRoot = store.ownerRoot({ kind: "model", id: "model_alpha" });
    mkdirSync(modelRoot, { recursive: true });
    symlinkSync(outside, join(modelRoot, "code"));
    const target: OwnerPath = { owner: { kind: "model", id: "model_alpha" }, relativePath: "code/model.py" };
    assert.throws(() => store.ensureOwnerParent(target), /symlink/u);
    assert.deepEqual(readdirSync(outside), []);

    const linkedRoot = join(root, "linked-root");
    symlinkSync(outside, linkedRoot);
    assert.throws(() => new ProductObjectStore(linkedRoot), /canonical directory/u);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
}));

test("durable writes report exact digest and size and atomic replacement stays owner-scoped", () => withStore((_root, store) => {
  const target: OwnerPath = { owner: { kind: "project", id: "project_alpha" }, relativePath: "model-snapshot/model.py" };
  const path = store.ensureOwnerParent(target);
  store.atomicReplace(path, Buffer.from("first"));
  assert.deepEqual(store.inspect(target), { sizeBytes: 5, sha256: sha256(Buffer.from("first")) });
  store.atomicReplace(path, Buffer.from("second"));
  assert.equal(store.read(target).toString("utf8"), "second");
  assert.deepEqual(store.inspect(target), { sizeBytes: 6, sha256: sha256(Buffer.from("second")) });
}));

test("unexpected recovery entries fail closed instead of being ignored", () => withStore((root, store) => {
  const outside = join(root, "outside.txt");
  writeFileSync(outside, "outside");
  symlinkSync(outside, join(store.recoveryRoot, "mutation_unsafe.json"));
  assert.throws(() => store.recoveryManifestIds(), /unsafe entry/u);
}));

test("group/world-writable roots and externally hard-linked managed files are rejected", () => {
  const insecureRoot = realpathSync(mkdtempSync(join(tmpdir(), "riff-object-insecure-")));
  try {
    chmodSync(insecureRoot, 0o770);
    assert.throws(() => new ProductObjectStore(insecureRoot), /group\/world writable/u);
  } finally {
    chmodSync(insecureRoot, 0o700);
    rmSync(insecureRoot, { recursive: true, force: true });
  }

  withStore((_root, store) => {
    const target: OwnerPath = { owner: { kind: "model", id: "model_alpha" }, relativePath: "code/model.py" };
    store.atomicReplace(store.ensureOwnerParent(target), Buffer.from("linked"));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "riff-hardlink-outside-")));
    try {
      linkSync(store.resolveOwnerPath(target), join(outside, "external-link"));
      assert.throws(() => store.inspect(target), /singly linked/u);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });
});

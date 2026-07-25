import assert from "node:assert/strict";
import { linkSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProductObjectStore, sha256, UnsafeObjectPathError, type OwnerPath } from "../src/object-store.ts";

const withStore = (run: (root: string, store: ProductObjectStore, target: OwnerPath) => Promise<void> | void): Promise<void> => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "riff-verified-read-")));
  const store = new ProductObjectStore(root);
  const target: OwnerPath = { owner: { kind: "run", id: "run_alpha" }, runProjectId: "project_alpha", relativePath: "outputs/0/result.txt" };
  return Promise.resolve(run(root, store, target)).finally(() => rmSync(root, { recursive: true, force: true }));
};

const streamed = async (handle: ReturnType<ProductObjectStore["openVerifiedRead"]>, range?: { start: number; end: number }): Promise<Buffer> => {
  const stream = handle.stream(range);
  const chunks: Buffer[] = [];
  stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  await once(stream, "end");
  return Buffer.concat(chunks);
};

test("verified read serves full and bounded ranges from one digest-checked descriptor", async () => {
  await withStore(async (_root, store, target) => {
    const bytes = Buffer.from("0123456789", "utf8");
    store.atomicReplace(store.ensureOwnerParent(target), bytes);
    const handle = store.openVerifiedRead(target, { sizeBytes: bytes.byteLength, sha256: sha256(bytes) });
    try {
      assert.equal((await streamed(handle)).toString(), "0123456789");
      assert.equal((await streamed(handle, { start: 2, end: 5 })).toString(), "2345");
      assert.throws(() => handle.stream({ start: 0, end: 10 }), UnsafeObjectPathError);
    } finally { handle.close(); }
  });
});

test("verified read fails closed on expected size or digest drift and closes failed opens", async () => {
  await withStore((_root, store, target) => {
    const bytes = Buffer.from("verified bytes", "utf8");
    store.atomicReplace(store.ensureOwnerParent(target), bytes);
    assert.throws(() => store.openVerifiedRead(target, { sizeBytes: bytes.byteLength + 1, sha256: sha256(bytes) }), /size drifted/u);
    assert.throws(() => store.openVerifiedRead(target, { sizeBytes: bytes.byteLength, sha256: "0".repeat(64) }), /metadata or bytes drifted/u);
    const handle = store.openVerifiedRead(target, { sizeBytes: bytes.byteLength, sha256: sha256(bytes) });
    handle.close();
    handle.close();
    assert.throws(() => handle.stream(), /closed/u);
  });
});

test("verified read rejects symlink and hard-link substitution without exposing outside bytes", async () => {
  await withStore((root, store, target) => {
    const bytes = Buffer.from("managed", "utf8");
    const path = store.ensureOwnerParent(target);
    store.atomicReplace(path, bytes);
    const outside = join(root, "outside.txt");
    const external = join(root, "external-link");
    writeFileSync(outside, "outside");
    unlinkSync(path);
    symlinkSync(outside, path);
    assert.throws(() => store.openVerifiedRead(target, { sizeBytes: bytes.byteLength, sha256: sha256(bytes) }), UnsafeObjectPathError);
    unlinkSync(path);
    store.atomicReplace(path, bytes);
    linkSync(path, external);
    assert.throws(() => store.openVerifiedRead(target, { sizeBytes: bytes.byteLength, sha256: sha256(bytes) }), /singly linked/u);
    assert.equal(readFileSync(outside, "utf8"), "outside");
  });
});

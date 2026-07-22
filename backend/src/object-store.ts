import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve, sep } from "node:path";
import type { ResourceOwner, Sha256Digest } from "./product-domain.ts";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u;
const SAFE_TRANSACTION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u;

export type OwnerPath = {
  owner: ResourceOwner;
  relativePath: string;
  /** Required for run owners because runs are nested below their Project. */
  runProjectId?: string;
};

export type FileInspection = { sizeBytes: number; sha256: Sha256Digest };
export type InspectedFile = FileInspection & { bytes: Buffer };
export type WriterLock = { instanceId: string; path: string };

export class UnsafeObjectPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeObjectPathError";
  }
}

export const sha256 = (bytes: Uint8Array): Sha256Digest => createHash("sha256").update(bytes).digest("hex");

export class ProductObjectStore {
  readonly root: string;
  readonly objectsRoot: string;
  readonly stagingRoot: string;
  readonly recoveryRoot: string;
  readonly quarantineRoot: string;
  readonly writerLockPath: string;

  constructor(root: string) {
    this.root = resolve(root);
    if (!existsSync(this.root)) throw new UnsafeObjectPathError("Object-store root must already exist.");
    const rootInfo = lstatSync(this.root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || realpathSync(this.root) !== this.root) {
      throw new UnsafeObjectPathError("Object-store root must be a real canonical directory.");
    }
    this.assertOwnedSecure(rootInfo, "Object-store root");
    this.objectsRoot = join(this.root, "objects");
    this.stagingRoot = join(this.root, ".staging");
    this.recoveryRoot = join(this.root, ".recovery");
    this.quarantineRoot = join(this.root, ".recovery-quarantine");
    this.writerLockPath = join(this.root, ".mutation-writer.lock");
    this.ensureDirectory(this.objectsRoot);
    this.ensureDirectory(this.stagingRoot);
    this.ensureDirectory(this.recoveryRoot);
    this.ensureDirectory(this.quarantineRoot);
  }

  ownerRoot(owner: ResourceOwner, runProjectId?: string): string {
    this.assertId(owner.id, "owner id");
    let target: string;
    switch (owner.kind) {
      case "model": target = join(this.objectsRoot, "models", owner.id); break;
      case "project": target = join(this.objectsRoot, "projects", owner.id); break;
      case "conversation": target = join(this.objectsRoot, "conversations", owner.id); break;
      case "run":
        if (!runProjectId) throw new UnsafeObjectPathError("A run owner requires its Project ID.");
        this.assertId(runProjectId, "run Project id");
        target = join(this.objectsRoot, "projects", runProjectId, "runs", owner.id);
        break;
    }
    this.assertContained(target, this.objectsRoot);
    return target;
  }

  resolveOwnerPath(input: OwnerPath): string {
    const segments = this.validateRelativePath(input.relativePath);
    const ownerRoot = this.ownerRoot(input.owner, input.runProjectId);
    const target = join(ownerRoot, ...segments);
    this.assertContained(target, ownerRoot);
    this.assertExistingChainSafe(target, this.root);
    return target;
  }

  ensureOwnerParent(input: OwnerPath): string {
    const target = this.resolveOwnerPath(input);
    this.ensureDirectory(dirname(target));
    this.assertExistingChainSafe(target, this.root);
    return target;
  }

  inspect(input: OwnerPath): FileInspection | null {
    const inspected = this.readWithInspection(input);
    return inspected ? { sizeBytes: inspected.sizeBytes, sha256: inspected.sha256 } : null;
  }

  read(input: OwnerPath): Buffer {
    const path = this.resolveOwnerPath(input);
    if (!existsSync(path)) throw new UnsafeObjectPathError("Stored object does not exist.");
    return this.readManagedFile(path);
  }

  readWithInspection(input: OwnerPath): InspectedFile | null {
    const path = this.resolveOwnerPath(input);
    if (!existsSync(path)) return null;
    const bytes = this.readManagedFile(path);
    return { bytes, sizeBytes: bytes.byteLength, sha256: sha256(bytes) };
  }

  transactionDirectory(transactionId: string): string {
    this.assertTransactionId(transactionId);
    return join(this.stagingRoot, transactionId);
  }

  recoveryManifestPath(transactionId: string): string {
    this.assertTransactionId(transactionId);
    return join(this.recoveryRoot, `${transactionId}.json`);
  }

  createTransactionDirectory(transactionId: string): string {
    const directory = this.transactionDirectory(transactionId);
    if (existsSync(directory)) throw new UnsafeObjectPathError("Transaction staging directory already exists.");
    this.ensureDirectory(directory);
    this.ensureDirectory(join(directory, "next"));
    this.ensureDirectory(join(directory, "backup"));
    return directory;
  }

  writeDurable(path: string, bytes: Uint8Array): void {
    const target = resolve(path);
    this.assertManagedFilePath(target);
    this.ensureDirectory(dirname(target));
    if (existsSync(target)) {
      const info = lstatSync(target);
      if (info.isSymbolicLink() || !info.isFile()) throw new UnsafeObjectPathError("Durable write target is unsafe.");
      throw new UnsafeObjectPathError("Durable write target already exists.");
    }
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_EXCL;
    const fd = openSync(target, flags, 0o600);
    try {
      const info = fstatSync(fd);
      this.assertOwnedManagedFile(info, "Durable write target");
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    this.syncDirectory(dirname(target));
  }

  atomicReplace(path: string, bytes: Uint8Array): void {
    const target = resolve(path);
    this.assertManagedFilePath(target);
    this.ensureDirectory(dirname(target));
    this.assertExistingChainSafe(target, this.root);
    const temp = `${target}.tmp-${randomUUID()}`;
    this.writeDurable(temp, bytes);
    try { this.safeRename(temp, target, true); } catch (error) { if (existsSync(temp)) this.unlinkExact(temp); throw error; }
    this.syncDirectory(dirname(target));
  }

  safeRename(source: string, target: string, replace: boolean): void {
    const sourcePath = resolve(source);
    const targetPath = resolve(target);
    const sourceParent = dirname(sourcePath);
    const targetParent = dirname(targetPath);
    this.assertManagedFilePath(sourcePath);
    this.assertManagedFilePath(targetPath);
    this.assertManagedRegularFile(sourcePath, "Rename source");
    this.ensureDirectory(dirname(targetPath));
    this.assertExistingChainSafe(targetPath, this.root);
    if (existsSync(targetPath)) {
      this.assertManagedRegularFile(targetPath, "Rename target");
      if (!replace) throw new UnsafeObjectPathError("Rename target is immutable.");
    }
    renameSync(sourcePath, targetPath);
    this.syncDirectory(sourceParent);
    if (targetParent !== sourceParent) this.syncDirectory(targetParent);
  }

  unlinkExact(path: string): void {
    const target = resolve(path);
    this.assertManagedFilePath(target);
    this.assertExistingChainSafe(target, this.root);
    if (!existsSync(target)) return;
    this.assertManagedRegularFile(target, "Exact deletion target");
    unlinkSync(target);
    this.syncDirectory(dirname(target));
  }

  removeTransactionDirectory(transactionId: string): void {
    const directory = this.transactionDirectory(transactionId);
    if (!existsSync(directory)) return;
    this.assertTreeContainsNoSymlinks(directory);
    rmSync(directory, { recursive: true, force: false });
    this.syncDirectory(this.stagingRoot);
  }

  recoveryManifestIds(): string[] {
    this.assertExistingChainSafe(this.recoveryRoot, this.root);
    return readdirSync(this.recoveryRoot).map((name) => {
      const path = join(this.recoveryRoot, name);
      const info = lstatSync(path);
      const transactionId = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (info.isSymbolicLink() || !info.isFile() || !SAFE_TRANSACTION_ID.test(transactionId)) throw new UnsafeObjectPathError("Recovery directory contains an unsafe entry.");
      this.assertOwnedManagedFile(info, "Recovery manifest");
      return transactionId;
    }).sort();
  }

  cleanupUnpublishedRecoveryTemps(): void {
    for (const name of readdirSync(this.recoveryRoot)) {
      if (!/^\.manifest-tmp-[A-Za-z0-9_-]{8,128}-[0-9a-f]{32}$/u.test(name)) continue;
      this.unlinkExact(join(this.recoveryRoot, name));
    }
  }

  publishRecoveryManifest(transactionId: string, bytes: Uint8Array): void {
    this.assertTransactionId(transactionId);
    const temp = join(this.recoveryRoot, `.manifest-tmp-${transactionId}-${randomUUID().replaceAll("-", "")}`);
    const final = this.recoveryManifestPath(transactionId);
    this.writeDurable(temp, bytes);
    try { this.safeRename(temp, final, false); }
    catch (error) { if (existsSync(temp)) this.unlinkExact(temp); throw error; }
    this.syncDirectory(this.recoveryRoot);
  }

  readManagedFile(path: string): Buffer {
    const target = resolve(path);
    this.assertManagedFilePath(target);
    this.assertExistingChainSafe(target, this.root);
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(fd);
      this.assertOwnedManagedFile(before, "Managed file");
      const bytes = readFileSync(fd);
      const after = fstatSync(fd);
      if (before.dev !== after.dev || before.ino !== after.ino || after.size !== bytes.byteLength) throw new UnsafeObjectPathError("Managed file changed while being read.");
      return bytes;
    } finally { closeSync(fd); }
  }

  acquireWriterLock(instanceId: string): WriterLock {
    if (!/^[0-9a-f]{32}$/u.test(instanceId)) throw new UnsafeObjectPathError("Writer instance ID is invalid.");
    const ownToken = this.processStartToken(process.pid);
    if (!ownToken) throw new UnsafeObjectPathError("Writer process identity is unavailable.");
    const record = Buffer.from(`${JSON.stringify({ schemaVersion: 1, pid: process.pid, processStartToken: ownToken, instanceId })}\n`);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(this.writerLockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { writeFileSync(fd, record); fsyncSync(fd); } finally { closeSync(fd); }
        this.syncDirectory(this.root);
        return { instanceId, path: this.writerLockPath };
      } catch (error) {
        if (!existsSync(this.writerLockPath)) throw error;
        const prior = this.readWriterLock();
        if (this.pidIsLive(prior.pid)) {
          const observed = this.processStartToken(prior.pid);
          if (!observed || observed === prior.processStartToken) throw new UnsafeObjectPathError("Another mutation writer owns this workspace.");
        }
        const stale = join(this.quarantineRoot, `stale-writer-lock-${randomUUID().replaceAll("-", "")}.json`);
        renameSync(this.writerLockPath, stale);
        this.syncDirectory(this.root);
        this.syncDirectory(this.quarantineRoot);
      }
    }
    throw new UnsafeObjectPathError("Mutation writer lock could not be acquired.");
  }

  releaseWriterLock(lock: WriterLock): void {
    if (!existsSync(lock.path)) return;
    const current = this.readWriterLock();
    if (current.instanceId !== lock.instanceId) throw new UnsafeObjectPathError("Mutation writer lock ownership changed.");
    unlinkSync(lock.path);
    this.syncDirectory(this.root);
  }

  stagingTransactionIds(): string[] {
    this.assertExistingChainSafe(this.stagingRoot, this.root);
    return readdirSync(this.stagingRoot).map((name) => {
      const path = join(this.stagingRoot, name);
      const info = lstatSync(path);
      if (info.isSymbolicLink() || !info.isDirectory() || !SAFE_TRANSACTION_ID.test(name)) throw new UnsafeObjectPathError("Staging directory contains an unsafe entry.");
      return name;
    }).sort();
  }

  syncDirectory(path: string): void {
    const target = resolve(path);
    this.assertContained(target, this.root, true);
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(fd);
      if (!info.isDirectory()) throw new UnsafeObjectPathError("Sync target is not a real directory.");
      this.assertOwnedSecure(info, "Sync directory");
      fsyncSync(fd);
    } finally { closeSync(fd); }
  }

  private validateRelativePath(relativePath: string): string[] {
    if (typeof relativePath !== "string" || relativePath.length < 1 || relativePath.length > 1024 || relativePath.includes("\0") || relativePath.includes("\\") || relativePath.startsWith("/") || relativePath.endsWith("/")) {
      throw new UnsafeObjectPathError("Object relative path is invalid.");
    }
    const segments = relativePath.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) throw new UnsafeObjectPathError("Object relative path contains an unsafe segment.");
    return segments;
  }

  private ensureDirectory(path: string): void {
    const target = resolve(path);
    this.assertContained(target, this.root, true);
    const missing: string[] = [];
    let cursor = target;
    while (!existsSync(cursor)) {
      missing.push(cursor);
      cursor = dirname(cursor);
    }
    while (true) {
      const info = lstatSync(cursor);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new UnsafeObjectPathError("Directory path contains a symlink or non-directory.");
      this.assertOwnedSecure(info, "Managed directory");
      if (cursor === this.root) break;
      cursor = dirname(cursor);
      if (!this.isContained(cursor, this.root, true)) throw new UnsafeObjectPathError("Directory path escapes the object-store root.");
    }
    for (const directory of missing.reverse()) {
      mkdirSync(directory, { mode: 0o700 });
      this.syncDirectory(dirname(directory));
    }
  }

  private assertExistingChainSafe(path: string, boundary: string): void {
    const target = resolve(path);
    const root = resolve(boundary);
    this.assertContained(target, root, true);
    let cursor = target;
    let first = true;
    while (this.isContained(cursor, root, true)) {
      if (existsSync(cursor)) {
        const info = lstatSync(cursor);
        if (info.isSymbolicLink() || (first ? !info.isFile() && !info.isDirectory() : !info.isDirectory())) {
          throw new UnsafeObjectPathError("Object path contains a symlink or non-directory ancestor.");
        }
      }
      if (cursor === root) break;
      cursor = dirname(cursor);
      first = false;
    }
  }

  private assertTreeContainsNoSymlinks(directory: string): void {
    const info = lstatSync(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new UnsafeObjectPathError("Transaction cleanup root is unsafe.");
    this.assertOwnedSecure(info, "Transaction cleanup directory");
    for (const name of readdirSync(directory)) {
      const child = join(directory, name);
      const childInfo = lstatSync(child);
      if (childInfo.isSymbolicLink()) throw new UnsafeObjectPathError("Transaction cleanup encountered a symlink.");
      if (childInfo.isDirectory()) this.assertTreeContainsNoSymlinks(child);
      else if (!childInfo.isFile()) throw new UnsafeObjectPathError("Transaction cleanup encountered a non-regular entry.");
      else this.assertOwnedManagedFile(childInfo, "Transaction cleanup file");
    }
  }

  private assertId(id: string, label: string): void {
    if (!SAFE_ID.test(id)) throw new UnsafeObjectPathError(`${label} is not path-safe.`);
  }

  private assertTransactionId(transactionId: string): void {
    if (!SAFE_TRANSACTION_ID.test(transactionId)) throw new UnsafeObjectPathError("Transaction ID is not path-safe.");
  }

  private assertManagedFilePath(path: string): void {
    const target = resolve(path);
    if (![this.objectsRoot, this.stagingRoot, this.recoveryRoot].some((root) => target.startsWith(`${root}${sep}`))) {
      throw new UnsafeObjectPathError("File path is outside managed object-store areas.");
    }
  }

  private assertManagedRegularFile(path: string, label: string): void {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { this.assertOwnedManagedFile(fstatSync(fd), label); } finally { closeSync(fd); }
  }

  private assertOwnedManagedFile(info: ReturnType<typeof fstatSync>, label: string): void {
    if (!info.isFile() || info.nlink !== 1) throw new UnsafeObjectPathError(`${label} is not a singly linked regular file.`);
    this.assertOwnedSecure(info, label);
  }

  private assertOwnedSecure(info: ReturnType<typeof lstatSync>, label: string): void {
    const uid = process.getuid?.();
    if (uid === undefined || info.uid !== uid) throw new UnsafeObjectPathError(`${label} is not owned by the current user.`);
    if ((info.mode & 0o022) !== 0) throw new UnsafeObjectPathError(`${label} is group/world writable.`);
  }

  private readWriterLock(): { pid: number; processStartToken: string; instanceId: string } {
    const fd = openSync(this.writerLockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1) throw new UnsafeObjectPathError("Writer lock is not a singly linked regular file.");
      this.assertOwnedSecure(info, "Writer lock");
      const value = JSON.parse(readFileSync(fd, "utf8")) as Record<string, unknown>;
      if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.pid) || Number(value.pid) < 1 || typeof value.processStartToken !== "string" || typeof value.instanceId !== "string") {
        throw new UnsafeObjectPathError("Writer lock is corrupt.");
      }
      return { pid: Number(value.pid), processStartToken: value.processStartToken, instanceId: value.instanceId };
    } catch (error) {
      if (error instanceof UnsafeObjectPathError) throw error;
      throw new UnsafeObjectPathError("Writer lock is corrupt.");
    } finally { closeSync(fd); }
  }

  private processStartToken(pid: number): string | null {
    try {
      const value = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      return value || null;
    } catch { return null; }
  }

  private pidIsLive(pid: number): boolean {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  }

  private assertContained(path: string, boundary: string, allowEqual = false): void {
    if (!this.isContained(resolve(path), resolve(boundary), allowEqual)) throw new UnsafeObjectPathError("Path escapes its allowed root.");
  }

  private isContained(path: string, boundary: string, allowEqual: boolean): boolean {
    return allowEqual && path === boundary || path.startsWith(`${boundary}${sep}`);
  }
}

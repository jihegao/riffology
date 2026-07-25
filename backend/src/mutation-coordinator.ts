import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  type ProductDatabase,
  withPermanentDeleteContext,
} from "./product-schema.ts";
import {
  ProductObjectStore,
  type FileIdentity,
  type OwnerPath,
  sha256,
  type WriterLock,
} from "./object-store.ts";

export type MutationFaultPoint = "after_manifest" | "after_database_changes" | "after_files_promoted" | "after_sqlite_commit";

export type FileMutation =
  | { operation: "write"; target: OwnerPath; bytes: Uint8Array; expectedPriorSha256?: string | null }
  | { operation: "delete"; target: OwnerPath; expectedPriorSha256: string };

export type MutationCoordinatorOptions = {
  faultInjector?: (point: MutationFaultPoint) => void;
  /** Test-only abrupt-process simulation: leave durable recovery material. */
  preserveRecoveryOnFault?: boolean;
  clock?: () => string;
};

export type DatabaseParameter = string | number | bigint | null | Uint8Array;
export type DatabaseMutationStatement = { sql: string; params?: readonly DatabaseParameter[]; expectedChanges: number };

export type PlannedObjectMutation = {
  operation: "write" | "delete";
  target: OwnerPath;
  priorSha256: string | null;
  priorSizeBytes: number | null;
  nextSha256: string | null;
  nextSizeBytes: number | null;
};

type OwnershipValidationPhase = "before_mutate" | "after_mutate";

type ManifestOperation = {
  operation: "write" | "delete";
  target: OwnerPath;
  stagedRelativePath: string | null;
  backupRelativePath: string | null;
  priorSha256: string | null;
  priorSizeBytes: number | null;
  priorIdentity?: FileIdentity | null;
  nextSha256: string | null;
  nextSizeBytes: number | null;
};

type ManifestCore = {
  schemaVersion: 1 | 2;
  transactionId: string;
  createdAt: string;
  operations: ManifestOperation[];
};

type RecoveryManifest = ManifestCore & { manifestSha256: string };

const manifestCoreBytes = (core: ManifestCore): Buffer => Buffer.from(`${JSON.stringify(core)}\n`, "utf8");
const manifestBytes = (manifest: RecoveryManifest): Buffer => Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");

export class MutationRecoveryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MutationRecoveryError";
  }
}

export class MutationCoordinator {
  readonly database: ProductDatabase;
  readonly objects: ProductObjectStore;
  readonly #fault?: MutationCoordinatorOptions["faultInjector"];
  readonly #preserveRecoveryOnFault: boolean;
  readonly #clock: () => string;
  readonly #writerLock: WriterLock;
  #closed = false;
  #poisoned = false;

  constructor(database: ProductDatabase, objects: ProductObjectStore, options: MutationCoordinatorOptions = {}) {
    if (Object.keys(options).some((key) => !["clock", "faultInjector", "preserveRecoveryOnFault"].includes(key))) throw new MutationRecoveryError("Mutation coordinator options contain an unsupported capability.");
    this.database = database;
    this.objects = objects;
    this.#fault = options.faultInjector;
    this.#preserveRecoveryOnFault = options.preserveRecoveryOnFault ?? false;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#writerLock = this.objects.acquireWriterLock(randomUUID().replaceAll("-", ""));
    try { this.recoverPending(); }
    catch (error) { this.objects.releaseWriterLock(this.#writerLock); this.#closed = true; throw error; }
  }

  close(): void {
    if (this.#closed) return;
    if (this.#poisoned) return;
    this.objects.releaseWriterLock(this.#writerLock);
    this.#closed = true;
  }

  assertUsable(): void {
    if (this.#closed || this.#poisoned) {
      throw new MutationRecoveryError(
        "Mutation coordinator is closed or poisoned.",
      );
    }
  }

  execute(input: {
    transactionId?: string;
    files: FileMutation[];
    statements: DatabaseMutationStatement[];
  }): void {
    this.#execute(input, false);
  }

  executePermanentDelete(input: {
    transactionId: string;
    files: FileMutation[];
    statements: DatabaseMutationStatement[];
  }): void {
    withPermanentDeleteContext(
      this.database,
      () => this.#execute(input, true),
    );
  }

  #execute(input: {
    transactionId?: string;
    files: FileMutation[];
    statements: DatabaseMutationStatement[];
  }, deferForeignKeys: boolean): void {
    if (this.#closed || this.#poisoned) throw new MutationRecoveryError("Mutation coordinator is closed or poisoned.");
    this.#validateExecutionPlan(input);
    const transactionId = input.transactionId ?? `mutation_${randomUUID().replaceAll("-", "")}`;
    const priorReceipt = this.database.prepare("SELECT 1 AS found FROM committed_mutations WHERE transaction_id = ?").get(transactionId);
    if (priorReceipt) throw new MutationRecoveryError("A committed transaction ID cannot be reused.");
    const manifest = this.#prepare(transactionId, input.files);
    let transactionOpen = false;
    let committed = false;
    try {
      this.#fault?.("after_manifest");
      this.database.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      if (deferForeignKeys) {
        this.database.exec("PRAGMA defer_foreign_keys = ON");
      }
      this.#assertPriorState(manifest);
      this.#validateOwnership("before_mutate", manifest);
      this.#stageDeletes(manifest);
      this.#assertStagedDeletes(manifest);
      this.#runStatements(input.statements);
      this.#validateOwnership("after_mutate", manifest);
      this.#assertStagedDeletes(manifest);
      this.database.prepare(`INSERT INTO committed_mutations (transaction_id, manifest_sha256, committed_at)
        VALUES (?, ?, ?)`
      ).run(transactionId, manifest.manifestSha256, this.#clock());
      this.#fault?.("after_database_changes");
      this.#rollForward(manifest);
      this.#fault?.("after_files_promoted");
      this.database.exec("COMMIT");
      transactionOpen = false;
      committed = true;
      this.#fault?.("after_sqlite_commit");
      this.#cleanup(manifest);
    } catch (error) {
      if (this.#preserveRecoveryOnFault) throw error;
      if (transactionOpen && !committed) {
        try { this.database.exec("ROLLBACK"); }
        catch (rollbackError) {
          this.#poisoned = true;
          throw new MutationRecoveryError("SQLite rollback failed; recovery material and writer lock were retained.", { cause: rollbackError });
        }
      }
      try {
        this.#recoverOne(manifest);
      } catch (recoveryError) {
        this.#poisoned = true;
        throw new MutationRecoveryError(
          "Mutation recovery failed; recovery material and writer lock were retained.",
          { cause: recoveryError },
        );
      }
      throw error;
    }
  }

  recoverPending(): void {
    if (this.#closed || this.#poisoned) throw new MutationRecoveryError("Mutation coordinator is closed or poisoned.");
    this.objects.cleanupUnpublishedRecoveryTemps();
    const manifestIds = new Set(this.objects.recoveryManifestIds());
    for (const transactionId of manifestIds) {
      const manifest = this.#readManifest(transactionId);
      this.#recoverOne(manifest);
    }
    for (const transactionId of this.objects.stagingTransactionIds()) {
      if (!manifestIds.has(transactionId)) this.objects.removeTransactionDirectory(transactionId);
    }
  }

  #prepare(transactionId: string, mutations: FileMutation[]): RecoveryManifest {
    if (!mutations.length) throw new MutationRecoveryError("A mixed mutation requires at least one file operation.");
    const directory = this.objects.createTransactionDirectory(transactionId);
    const seen = new Set<string>();
    const operations: ManifestOperation[] = [];
    try {
      mutations.forEach((mutation, index) => {
        const targetPath = this.objects.resolveOwnerPath(mutation.target);
        if (seen.has(targetPath)) throw new MutationRecoveryError("A mutation contains duplicate file targets.");
        seen.add(targetPath);
        const prior = this.objects.readWithInspection(mutation.target);
        if (mutation.expectedPriorSha256 !== undefined && mutation.expectedPriorSha256 !== (prior?.sha256 ?? null)) {
          throw new MutationRecoveryError("The prior object digest does not match the mutation precondition.");
        }
        const suffix = String(index).padStart(8, "0");
        const backupRelativePath = prior
          ? mutation.operation === "delete"
            ? `removed/${suffix}.bin`
            : `backup/${suffix}.bin`
          : null;
        if (prior && mutation.operation === "write" && backupRelativePath) {
          this.objects.writeDurable(`${directory}/${backupRelativePath}`, prior.bytes);
        }
        let stagedRelativePath: string | null = null;
        let nextSha256: string | null = null;
        let nextSizeBytes: number | null = null;
        if (mutation.operation === "write") {
          stagedRelativePath = `next/${suffix}.bin`;
          nextSha256 = sha256(mutation.bytes);
          nextSizeBytes = mutation.bytes.byteLength;
          this.objects.writeDurable(`${directory}/${stagedRelativePath}`, mutation.bytes);
        }
        operations.push({
          operation: mutation.operation,
          target: structuredClone(mutation.target),
          stagedRelativePath,
          backupRelativePath,
          priorSha256: prior?.sha256 ?? null,
          priorSizeBytes: prior?.sizeBytes ?? null,
          priorIdentity: prior ? inspectionWithoutBytes(prior) : null,
          nextSha256,
          nextSizeBytes,
        });
      });
      const core: ManifestCore = {
        schemaVersion: 2,
        transactionId,
        createdAt: this.#clock(),
        operations,
      };
      const manifest: RecoveryManifest = { ...core, manifestSha256: sha256(manifestCoreBytes(core)) };
      this.objects.publishRecoveryManifest(transactionId, manifestBytes(manifest));
      return manifest;
    } catch (error) {
      if (existsSync(this.objects.recoveryManifestPath(transactionId))) this.objects.unlinkExact(this.objects.recoveryManifestPath(transactionId));
      if (existsSync(directory)) this.objects.removeTransactionDirectory(transactionId);
      throw error;
    }
  }

  #recoverOne(manifest: RecoveryManifest): void {
    const receipt = this.database.prepare(`SELECT manifest_sha256 FROM committed_mutations WHERE transaction_id = ?`).get(manifest.transactionId) as { manifest_sha256: string } | undefined;
    if (receipt) {
      if (receipt.manifest_sha256 !== manifest.manifestSha256) throw new MutationRecoveryError("Committed mutation receipt does not match its recovery manifest.");
      this.#rollForward(manifest);
    } else {
      this.#rollBack(manifest);
    }
    this.#cleanup(manifest);
  }

  #rollForward(manifest: RecoveryManifest): void {
    const directory = this.objects.transactionDirectory(manifest.transactionId);
    for (const operation of manifest.operations) {
      const current = this.objects.inspectIdentity(operation.target);
      if (operation.operation === "delete") {
        if (!current) {
          if (manifest.schemaVersion === 2) {
            const stagedPath = this.#transactionFile(
              directory,
              operation.backupRelativePath!,
              "removed",
            );
            if (existsSync(stagedPath)) {
              const staged = this.objects.inspectManagedPath(stagedPath);
              if (!operation.priorIdentity
                || !sameInspection(staged, operation.priorIdentity)) {
                throw new MutationRecoveryError(
                  "Staged delete identity changed during recovery.",
                );
              }
            } else if (existsSync(directory)) {
              throw new MutationRecoveryError(
                "Staged delete bytes are missing during recovery.",
              );
            }
          }
          continue;
        }
        if (manifest.schemaVersion === 1) {
          if (current.sha256 !== operation.priorSha256
            || current.sizeBytes !== operation.priorSizeBytes) {
            throw new MutationRecoveryError(
              "Legacy delete target changed during recovery.",
            );
          }
          this.objects.unlinkExact(
            this.objects.resolveOwnerPath(operation.target),
          );
          continue;
        }
        if (!operation.priorIdentity || !sameInspection(current, operation.priorIdentity)) {
          throw new MutationRecoveryError("Delete target changed during recovery.");
        }
        this.objects.stageExactRemoval(
          operation.target,
          operation.priorIdentity,
          this.#transactionFile(directory, operation.backupRelativePath!, "removed"),
        );
        continue;
      }
      if (current?.sha256 === operation.nextSha256 && current.sizeBytes === operation.nextSizeBytes) continue;
      if (current && (current.sha256 !== operation.priorSha256 || current.sizeBytes !== operation.priorSizeBytes)) throw new MutationRecoveryError("Write target changed during recovery.");
      const stagedPath = this.#transactionFile(directory, operation.stagedRelativePath!, "next");
      this.#verifyInternalFile(stagedPath, operation.nextSha256!, operation.nextSizeBytes!);
      const target = this.objects.ensureOwnerParent(operation.target);
      this.objects.safeRename(stagedPath, target, true);
    }
  }

  #rollBack(manifest: RecoveryManifest): void {
    const directory = this.objects.transactionDirectory(manifest.transactionId);
    for (const operation of [...manifest.operations].reverse()) {
      const current = this.objects.inspectIdentity(operation.target);
      if (operation.priorSha256 === null) {
        if (!current) continue;
        if (current.sha256 !== operation.nextSha256 || current.sizeBytes !== operation.nextSizeBytes) throw new MutationRecoveryError("Uncommitted target changed before rollback.");
        this.objects.unlinkExact(this.objects.resolveOwnerPath(operation.target));
        continue;
      }
      if (operation.operation === "delete") {
        if (manifest.schemaVersion === 1) {
          if (current?.sha256 === operation.priorSha256
            && current.sizeBytes === operation.priorSizeBytes) {
            continue;
          }
          if (current) {
            throw new MutationRecoveryError(
              "Legacy removal target changed before rollback.",
            );
          }
          const legacyBackup = this.#transactionFile(
            directory,
            operation.backupRelativePath!,
            "backup",
          );
          this.#verifyInternalFile(
            legacyBackup,
            operation.priorSha256,
            operation.priorSizeBytes!,
          );
          this.objects.atomicReplace(
            this.objects.ensureOwnerParent(operation.target),
            this.objects.readManagedFile(legacyBackup),
          );
          continue;
        }
        if (!operation.priorIdentity) {
          throw new MutationRecoveryError("Removal rollback identity is missing.");
        }
        this.objects.restoreExactRemoval(
          operation.target,
          operation.priorIdentity,
          this.#transactionFile(directory, operation.backupRelativePath!, "removed"),
        );
        continue;
      }
      if (current?.sha256 === operation.priorSha256 && current.sizeBytes === operation.priorSizeBytes) continue;
      if (operation.operation === "write" && current && (current.sha256 !== operation.nextSha256 || current.sizeBytes !== operation.nextSizeBytes)) {
        throw new MutationRecoveryError("Replacement target changed before rollback.");
      }
      const backupPath = this.#transactionFile(directory, operation.backupRelativePath!, "backup");
      this.#verifyInternalFile(backupPath, operation.priorSha256, operation.priorSizeBytes!);
      this.objects.atomicReplace(this.objects.ensureOwnerParent(operation.target), this.objects.readManagedFile(backupPath));
    }
  }

  #cleanup(manifest: RecoveryManifest): void {
    const manifestPath = this.objects.recoveryManifestPath(manifest.transactionId);
    this.objects.removeTransactionDirectory(manifest.transactionId);
    if (existsSync(manifestPath)) this.objects.unlinkExact(manifestPath);
  }

  #readManifest(transactionId: string): RecoveryManifest {
    const path = this.objects.recoveryManifestPath(transactionId);
    let value: unknown;
    try { value = JSON.parse(this.objects.readManagedFile(path).toString("utf8")); } catch { throw new MutationRecoveryError("Recovery manifest is not valid JSON."); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new MutationRecoveryError("Recovery manifest has an invalid shape.");
    const manifest = value as RecoveryManifest;
    if (![1, 2].includes(manifest.schemaVersion)
      || manifest.transactionId !== transactionId
      || typeof manifest.createdAt !== "string"
      || !Array.isArray(manifest.operations)
      || !/^[0-9a-f]{64}$/u.test(String(manifest.manifestSha256))) {
      throw new MutationRecoveryError("Recovery manifest identity is invalid.");
    }
    const { manifestSha256, ...core } = manifest;
    if (sha256(manifestCoreBytes(core)) !== manifestSha256) throw new MutationRecoveryError("Recovery manifest digest is invalid.");
    for (const [index, operation] of manifest.operations.entries()) {
      const suffix = String(index).padStart(8, "0");
      const validDigest = (digest: unknown): boolean => digest === null || typeof digest === "string" && /^[0-9a-f]{64}$/u.test(digest);
      const validSize = (size: unknown): boolean => size === null || typeof size === "number" && Number.isSafeInteger(size) && size >= 0;
      const priorPairValid = Boolean(operation) && (operation.priorSha256 === null) === (operation.priorSizeBytes === null);
      const nextPairValid = Boolean(operation) && (operation.nextSha256 === null) === (operation.nextSizeBytes === null);
      const priorIdentityValid = manifest.schemaVersion === 1
        ? operation?.priorIdentity === undefined
        : operation?.priorIdentity !== undefined
          && (operation.priorIdentity === null)
            === (operation.priorSha256 === null)
          && (operation.priorIdentity === null
            || validInspection(operation.priorIdentity)
              && operation.priorIdentity.sha256 === operation.priorSha256
              && operation.priorIdentity.sizeBytes
                === operation.priorSizeBytes);
      if (!operation || !["write", "delete"].includes(operation.operation)
        || !validDigest(operation.priorSha256) || !validDigest(operation.nextSha256)
        || !validSize(operation.priorSizeBytes) || !validSize(operation.nextSizeBytes)
        || !priorPairValid || !nextPairValid
        || operation.backupRelativePath !== (operation.priorSha256 === null
          ? null
          : manifest.schemaVersion === 2 && operation.operation === "delete"
            ? `removed/${suffix}.bin`
            : `backup/${suffix}.bin`)
        || operation.stagedRelativePath !== (operation.operation === "write" ? `next/${suffix}.bin` : null)
        || operation.operation === "delete" && operation.priorSha256 === null
        || (operation.operation === "write" ? operation.nextSha256 === null : operation.nextSha256 !== null)
        || !priorIdentityValid) {
        throw new MutationRecoveryError("Recovery manifest operation is invalid.");
      }
      this.objects.resolveOwnerPath(operation.target);
    }
    return manifest;
  }

  #assertPriorState(manifest: RecoveryManifest): void {
    if (manifest.schemaVersion !== 2) {
      throw new MutationRecoveryError(
        "Only current recovery manifests may start a mutation.",
      );
    }
    for (const operation of manifest.operations) {
      const current = this.objects.inspectIdentity(operation.target);
      const priorIdentity = operation.priorIdentity;
      if (priorIdentity === undefined
        || (priorIdentity === null
          ? current !== null
          : current === null || !sameInspection(current, priorIdentity))) {
        throw new MutationRecoveryError("An object changed after staging and before database commit.");
      }
    }
  }

  #stageDeletes(manifest: RecoveryManifest): void {
    if (manifest.schemaVersion !== 2) {
      throw new MutationRecoveryError(
        "Only current recovery manifests may stage deletes.",
      );
    }
    const directory = this.objects.transactionDirectory(manifest.transactionId);
    for (const operation of manifest.operations) {
      if (operation.operation !== "delete") continue;
      if (!operation.priorIdentity) {
        throw new MutationRecoveryError("Delete target identity is missing.");
      }
      this.objects.stageExactRemoval(
        operation.target,
        operation.priorIdentity,
        this.#transactionFile(directory, operation.backupRelativePath!, "removed"),
      );
    }
  }

  #assertStagedDeletes(manifest: RecoveryManifest): void {
    if (manifest.schemaVersion !== 2) return;
    const directory = this.objects.transactionDirectory(
      manifest.transactionId,
    );
    for (const operation of manifest.operations) {
      if (operation.operation !== "delete" || !operation.priorIdentity) {
        continue;
      }
      const staged = this.objects.inspectManagedPath(
        this.#transactionFile(
          directory,
          operation.backupRelativePath!,
          "removed",
        ),
      );
      if (!sameInspection(staged, operation.priorIdentity)) {
        throw new MutationRecoveryError(
          "Staged delete identity changed before database commit.",
        );
      }
    }
  }

  #transactionFile(
    directory: string,
    relativePath: string,
    kind: "next" | "backup" | "removed",
  ): string {
    if (!new RegExp(`^${kind}/\\d{8}\\.bin$`, "u").test(relativePath)) throw new MutationRecoveryError("Recovery file path is invalid.");
    return `${directory}/${relativePath}`;
  }

  #verifyInternalFile(path: string, expectedSha256: string, expectedSize: number): void {
    if (!existsSync(path)) throw new MutationRecoveryError("Recovery bytes are missing.");
    const bytes = this.objects.readManagedFile(path);
    if (bytes.byteLength !== expectedSize || sha256(bytes) !== expectedSha256) throw new MutationRecoveryError("Recovery bytes failed integrity verification.");
  }

  #validateOwnership(phase: OwnershipValidationPhase, manifest: RecoveryManifest): void {
    const operations: PlannedObjectMutation[] = manifest.operations.map(({ operation, target, priorSha256, priorSizeBytes, nextSha256, nextSizeBytes }) => ({ operation, target, priorSha256, priorSizeBytes, nextSha256, nextSizeBytes }));
    baselineSqliteObjectOwnershipValidator(this.database, phase, operations);
  }

  #validateExecutionPlan(input: Record<string, unknown>): void {
    const keys = Object.keys(input).sort();
    if (keys.some((key) => ![
      "files",
      "statements",
      "transactionId",
    ].includes(key))) {
      throw new MutationRecoveryError(
        "Mutation plan contains unsupported executable fields.",
      );
    }
    if (!Array.isArray(input.files) || !Array.isArray(input.statements) || input.statements.length < 1) throw new MutationRecoveryError("Mutation plan requires files and at least one database statement.");
    for (const value of input.statements) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new MutationRecoveryError("Database mutation statement is invalid.");
      const statement = value as unknown as DatabaseMutationStatement;
      if (Object.keys(statement).some((key) => !["sql", "params", "expectedChanges"].includes(key))
        || typeof statement.sql !== "string" || !statement.sql.trim() || statement.sql.includes(";")
        || /\b(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|PRAGMA|ATTACH|DETACH|VACUUM)\b/iu.test(statement.sql)
        || statement.params !== undefined && !Array.isArray(statement.params)
        || statement.params?.some((parameter) => !(parameter === null || typeof parameter === "string" || typeof parameter === "bigint" || typeof parameter === "number" && Number.isFinite(parameter) || parameter instanceof Uint8Array))
        || !Number.isSafeInteger(statement.expectedChanges) || statement.expectedChanges < 0) {
        throw new MutationRecoveryError("Database mutation statement is empty, transactional, or unsupported.");
      }
    }
  }

  #runStatements(statements: readonly DatabaseMutationStatement[]): void {
    for (const statement of statements) {
      const result = this.database.prepare(statement.sql).run(...(statement.params ?? []));
      if (Number(result.changes) !== statement.expectedChanges) throw new MutationRecoveryError("Database mutation affected an unexpected number of rows.");
    }
  }
}

const inspectionWithoutBytes = (
  inspection: FileIdentity & { bytes: Buffer },
): FileIdentity => ({
  device: inspection.device,
  inode: inspection.inode,
  linkCount: inspection.linkCount,
  type: inspection.type,
  sizeBytes: inspection.sizeBytes,
  sha256: inspection.sha256,
});

const validInspection = (value: unknown): value is FileIdentity => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const inspection = value as Partial<FileIdentity>;
  return typeof inspection.device === "string" && /^\d+$/u.test(inspection.device)
    && typeof inspection.inode === "string" && /^\d+$/u.test(inspection.inode)
    && inspection.linkCount === 1 && inspection.type === "file"
    && Number.isSafeInteger(inspection.sizeBytes) && Number(inspection.sizeBytes) >= 0
    && typeof inspection.sha256 === "string" && /^[0-9a-f]{64}$/u.test(inspection.sha256);
};

const sameInspection = (left: FileIdentity, right: FileIdentity): boolean =>
  left.device === right.device
  && left.inode === right.inode
  && left.linkCount === right.linkCount
  && left.type === right.type
  && left.sizeBytes === right.sizeBytes
  && left.sha256 === right.sha256;

const baselineSqliteObjectOwnershipValidator = (database: ProductDatabase, phase: OwnershipValidationPhase, operations: readonly PlannedObjectMutation[]): void => {
  for (const operation of operations) {
    const { column, table } = ownerBinding(operation.target);
    const owner = database.prepare(`SELECT id${operation.target.owner.kind === "run" ? ", project_id" : ""} FROM ${table} WHERE id = ?`).get(operation.target.owner.id) as { id: string; project_id?: string } | undefined;
    const row = database.prepare(`SELECT id, size_bytes, sha256 FROM object_files WHERE ${column} = ? AND relative_path = ?`).get(operation.target.owner.id, operation.target.relativePath) as { id: string; size_bytes: number; sha256: string } | undefined;
    if (phase === "before_mutate") {
      if (operation.priorSha256 === null ? row !== undefined : !owner || operation.target.owner.kind === "run" && owner.project_id !== operation.target.runProjectId || !row || row.sha256 !== operation.priorSha256 || row.size_bytes !== operation.priorSizeBytes) {
        throw new MutationRecoveryError("Planned existing object is not bound to matching database metadata.");
      }
    } else if (operation.operation === "delete") {
      if (row) throw new MutationRecoveryError("Deleted object metadata remains after the database mutation.");
    } else if (!owner || operation.target.owner.kind === "run" && owner.project_id !== operation.target.runProjectId) {
      throw new MutationRecoveryError("Planned object owner does not exist or is outside its Project after mutation.");
    } else if (!row || row.sha256 !== operation.nextSha256 || row.size_bytes !== operation.nextSizeBytes) {
      throw new MutationRecoveryError("Written object is not bound to matching database metadata after mutation.");
    }
  }
};

const ownerBinding = (target: OwnerPath): { column: string; table: string } => {
  switch (target.owner.kind) {
    case "model": return { column: "owner_model_id", table: "models" };
    case "project": return { column: "owner_project_id", table: "projects" };
    case "conversation": return { column: "owner_conversation_id", table: "conversations" };
    case "run": return { column: "owner_run_id", table: "runs" };
  }
};

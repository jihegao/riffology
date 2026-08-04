import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalDigest, canonicalJsonV2 } from "./canonical-json-v2.ts";
import { ProjectOnlyStore } from "./project-only-store.ts";

const LEGACY_DATABASE = "riff.sqlite3";
const SENSITIVE_KEY = /(?:credential|api[_-]?key|access[_-]?token|refresh[_-]?token|capability|external[_-]?session|session[_-]?ref|internal[_-]?url|process[_-]?id|\bpid\b)/iu;
const SENSITIVE_PATH = /(?:^|[/_.-])(?:credential|secret|token|capability|session|pid)(?:[/_.-]|$)/iu;
const EXCLUDED_TABLE = /(?:agent_sessions|capabilit|process_attempt|dispatcher|lease|browser|workspace_binding)/iu;
const INCLUDED_TABLE = /^(?:models|projects|conversations|messages|temporary_documents|experiment_configurations|runs|object_files|attachments|message_attachments|output_indexes|trash_entries|action_records|model_change_sets|model_change_set_files|model_mutation_receipts|.*receipts?|run_completion_cards)$/u;

export type LegacyArchiveManifest = Readonly<{
  schemaVersion: 1;
  mode: "legacy_recovery_export";
  source: Readonly<{ databaseUserVersion: number; databaseSha256: string }>;
  sanitization: Readonly<{
    policy: "system_managed_sensitive_fields_v1";
    excludedTables: readonly string[];
    excludedColumns: readonly string[];
    excludedObjectPaths: readonly string[];
    userAuthoredContentNotSecretScanned: true;
  }>;
  entries: readonly Readonly<{ relativePath: string; sizeBytes: number; sha256: string; kind: "sanitized_database" | "managed_object" }>[];
  exportedAt: string;
  bundleSha256: string;
}>;

export class LegacyArchiveError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "LegacyArchiveError";
  }
}

export const legacyStoreRequiresRecovery = (rootInput: string): boolean => {
  const root = resolve(rootInput);
  const databasePath = join(root, LEGACY_DATABASE);
  if (!existsSync(databasePath)) return false;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'models'").get());
  } finally { database.close(); }
};

export const exportLegacyProjectStore = (input: Readonly<{
  legacyRoot: string;
  archiveRoot: string;
  exportedAt: string;
}>): LegacyArchiveManifest => {
  const legacyRoot = requireRealDirectory(input.legacyRoot, "legacy_store_not_found");
  if (!legacyStoreRequiresRecovery(legacyRoot)) throw new LegacyArchiveError("legacy_store_not_found", "A legacy Model/Project Store was not found.");
  const archiveRoot = resolve(input.archiveRoot);
  assertOutside(archiveRoot, legacyRoot, "archive_must_be_outside_legacy_store");
  if (existsSync(archiveRoot)) throw new LegacyArchiveError("archive_already_exists", "Legacy archive target already exists.");
  const parent = requireRealDirectory(dirname(archiveRoot), "archive_parent_not_found");
  const stage = join(parent, `.${basename(archiveRoot)}.stage-${randomUUID().replaceAll("-", "")}`);
  mkdirSync(stage, { mode: 0o700 });
  let published = false;
  try {
    const databasePath = join(legacyRoot, LEGACY_DATABASE);
    const databaseBytes = readStableFile(databasePath);
    const dump = sanitizedDatabaseDump(databasePath);
    const dumpPath = join(stage, "legacy-database.json");
    writeDurable(dumpPath, Buffer.concat([canonicalJsonV2(dump.value), Buffer.from("\n")]));
    const entries: Array<{ relativePath: string; sizeBytes: number; sha256: string; kind: "sanitized_database" | "managed_object" }> = [
      inspectedEntry(stage, "legacy-database.json", "sanitized_database"),
    ];
    const excludedObjectPaths: string[] = [];
    const objectsRoot = join(legacyRoot, "objects");
    if (existsSync(objectsRoot)) {
      visitFiles(objectsRoot, "", (sourcePath, relativePath) => {
        if (SENSITIVE_PATH.test(relativePath)) {
          excludedObjectPaths.push(relativePath);
          return;
        }
        const targetRelativePath = `objects/${relativePath}`;
        const bytes = readStableFile(sourcePath);
        writeDurable(join(stage, ...targetRelativePath.split("/")), bytes);
        entries.push({ relativePath: targetRelativePath, sizeBytes: bytes.byteLength, sha256: sha256(bytes), kind: "managed_object" });
      });
    }
    entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    const stable = Object.freeze({
      schemaVersion: 1 as const,
      mode: "legacy_recovery_export" as const,
      source: Object.freeze({
        databaseUserVersion: dump.userVersion,
        databaseSha256: sha256(databaseBytes),
      }),
      sanitization: Object.freeze({
        policy: "system_managed_sensitive_fields_v1" as const,
        excludedTables: Object.freeze(dump.excludedTables.sort()),
        excludedColumns: Object.freeze(dump.excludedColumns.sort()),
        excludedObjectPaths: Object.freeze(excludedObjectPaths.sort()),
        userAuthoredContentNotSecretScanned: true as const,
      }),
      entries: Object.freeze(entries.map(Object.freeze)),
      exportedAt: input.exportedAt,
    });
    const manifest: LegacyArchiveManifest = Object.freeze({ ...stable, bundleSha256: canonicalDigest(stable) });
    writeDurable(join(stage, "manifest.json"), Buffer.concat([canonicalJsonV2(manifest), Buffer.from("\n")]));
    renameSync(stage, archiveRoot);
    published = true;
    return verifyLegacyArchive(archiveRoot);
  } finally {
    if (!published && existsSync(stage)) rmSync(stage, { recursive: true, force: true });
  }
};

export const verifyLegacyArchive = (archiveRootInput: string): LegacyArchiveManifest => {
  const archiveRoot = requireRealDirectory(archiveRootInput, "archive_not_found");
  const raw = JSON.parse(readStableFile(join(archiveRoot, "manifest.json")).toString("utf8")) as LegacyArchiveManifest;
  const { bundleSha256, ...stable } = raw;
  if (raw.schemaVersion !== 1 || raw.mode !== "legacy_recovery_export" || canonicalDigest(stable) !== bundleSha256) {
    throw new LegacyArchiveError("archive_manifest_invalid", "Legacy archive manifest failed integrity verification.");
  }
  const seen = new Set<string>();
  for (const entry of raw.entries) {
    assertSafeRelativePath(entry.relativePath);
    if (seen.has(entry.relativePath)) throw new LegacyArchiveError("archive_manifest_invalid", "Legacy archive contains duplicate paths.");
    seen.add(entry.relativePath);
    const bytes = readStableFile(join(archiveRoot, ...entry.relativePath.split("/")));
    if (bytes.byteLength !== entry.sizeBytes || sha256(bytes) !== entry.sha256) {
      throw new LegacyArchiveError("archive_entry_invalid", `Legacy archive entry failed verification: ${entry.relativePath}`);
    }
  }
  return Object.freeze(raw);
};

export const cutoverLegacyProjectStore = (input: Readonly<{
  legacyRoot: string;
  archiveRoot: string;
  cutoverAt: string;
}>): Readonly<{ projectOnlyRoot: string; legacyBackupRoot: string; archiveBundleSha256: string }> => {
  const legacyRoot = requireRealDirectory(input.legacyRoot, "legacy_store_not_found");
  const archive = verifyLegacyArchive(input.archiveRoot);
  if (!legacyStoreRequiresRecovery(legacyRoot)) throw new LegacyArchiveError("legacy_store_not_found", "A legacy Model/Project Store was not found.");
  if (sha256(readStableFile(join(legacyRoot, LEGACY_DATABASE))) !== archive.source.databaseSha256) {
    throw new LegacyArchiveError("legacy_store_changed_after_export", "Legacy Store changed after its verified export.");
  }
  const archiveRoot = realpathSync(input.archiveRoot);
  assertOutside(archiveRoot, legacyRoot, "archive_must_be_outside_legacy_store");
  const suffix = input.cutoverAt.replace(/[^0-9]/gu, "");
  if (suffix.length < 8) throw new LegacyArchiveError("invalid_cutover_timestamp", "Cutover timestamp is invalid.");
  const backupRoot = join(dirname(legacyRoot), `${basename(legacyRoot)}.legacy-${suffix}`);
  if (existsSync(backupRoot)) throw new LegacyArchiveError("legacy_backup_exists", "Legacy backup target already exists.");
  renameSync(legacyRoot, backupRoot);
  let initialized = false;
  try {
    const store = ProjectOnlyStore.open(legacyRoot);
    store.close();
    initialized = true;
  } finally {
    if (!initialized) {
      if (existsSync(legacyRoot)) rmSync(legacyRoot, { recursive: true, force: true });
      renameSync(backupRoot, legacyRoot);
    }
  }
  return Object.freeze({ projectOnlyRoot: legacyRoot, legacyBackupRoot: backupRoot, archiveBundleSha256: archive.bundleSha256 });
};

const sanitizedDatabaseDump = (databasePath: string): Readonly<{
  userVersion: number;
  value: Record<string, unknown>;
  excludedTables: string[];
  excludedColumns: string[];
}> => {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const userVersion = (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(({ name }) => name);
    const excludedTables = tables.filter((table) => !INCLUDED_TABLE.test(table) || EXCLUDED_TABLE.test(table));
    const excludedColumns: string[] = [];
    const exported: Record<string, unknown> = {};
    for (const table of tables) {
      if (excludedTables.includes(table)) continue;
      if (!/^[a-z0-9_]+$/u.test(table)) throw new LegacyArchiveError("legacy_schema_unsafe", "Legacy table name is unsafe.");
      const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      const safeColumns = columns.map(({ name }) => name).filter((column) => {
        const excluded = SENSITIVE_KEY.test(column);
        if (excluded) excludedColumns.push(`${table}.${column}`);
        return !excluded;
      });
      const rows = database.prepare(`SELECT ${safeColumns.map((column) => `"${column}"`).join(", ")} FROM "${table}"`).all() as Record<string, unknown>[];
      exported[table] = rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, sanitizeValue(value)])))
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    }
    return Object.freeze({
      userVersion,
      value: Object.freeze({ schemaVersion: 1, sourceUserVersion: userVersion, tables: exported }),
      excludedTables,
      excludedColumns,
    });
  } finally { database.close(); }
};

const sanitizeValue = (value: unknown): unknown => {
  if (Buffer.isBuffer(value)) return Object.freeze({ encoding: "base64", bytes: value.toString("base64") });
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try { return sanitizeJson(JSON.parse(value)); } catch { return value; }
};

const sanitizeJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sanitizeJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !SENSITIVE_KEY.test(key))
    .map(([key, child]) => [key, sanitizeJson(child)]));
};

const visitFiles = (root: string, prefix: string, accept: (path: string, relativePath: string) => void): void => {
  const info = lstatSync(root);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new LegacyArchiveError("legacy_object_tree_unsafe", "Legacy object tree is unsafe.");
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    const relativePath = prefix ? `${prefix}/${name}` : name;
    const child = lstatSync(path);
    if (child.isSymbolicLink()) throw new LegacyArchiveError("legacy_object_tree_unsafe", "Legacy object tree contains a symlink.");
    if (child.isDirectory()) visitFiles(path, relativePath, accept);
    else if (child.isFile()) accept(path, relativePath);
    else throw new LegacyArchiveError("legacy_object_tree_unsafe", "Legacy object tree contains a special file.");
  }
};

const requireRealDirectory = (pathInput: string, code: string): string => {
  const path = resolve(pathInput);
  if (!existsSync(path)) throw new LegacyArchiveError(code, "Required directory does not exist.");
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new LegacyArchiveError(code, "Required directory is unsafe.");
  return realpathSync(path);
};

const assertOutside = (candidate: string, boundary: string, code: string): void => {
  const back = relative(boundary, candidate);
  if (back === "" || (!back.startsWith(`..${sep}`) && back !== "..")) throw new LegacyArchiveError(code, "Path must be outside the legacy Store.");
};

const assertSafeRelativePath = (path: string): void => {
  if (path.length < 1 || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new LegacyArchiveError("archive_manifest_invalid", "Legacy archive path is unsafe.");
  }
};

const readStableFile = (path: string): Buffer => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new LegacyArchiveError("unsafe_file", "Expected a regular file.");
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || after.size !== bytes.byteLength) {
      throw new LegacyArchiveError("file_changed_during_export", "A file changed during legacy export.");
    }
    return bytes;
  } finally { closeSync(fd); }
};

const writeDurable = (path: string, bytes: Uint8Array): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
};

const inspectedEntry = (root: string, relativePath: string, kind: "sanitized_database" | "managed_object") => {
  const bytes = readStableFile(join(root, ...relativePath.split("/")));
  return { relativePath, sizeBytes: bytes.byteLength, sha256: sha256(bytes), kind } as const;
};

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import { get as httpsGet } from "node:https";
import { connect as netConnect } from "node:net";
import { arch, release, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_A = "riff://workspace-retirement/report-a/v1";
const SCHEMA_B = "riff://workspace-retirement/report-b/v1";
const SCHEMA_JOURNAL = "riff://workspace-retirement/intent-progress/v1";
const SCHEMA_GATE = "riff://workspace-admission/global-gate/v1";
const SCHEMA_FENCE = "riff://workspace-admission/root-fence/v1";
const PROTOCOL = "riff-workspace-lifecycle-v1";
const LIFECYCLE = ".workspace-lifecycle.lock";
const MUTATION = ".workspace-mutation.lock";
const FENCE = ".workspace-apply.fence";
const GLOBAL_GATE = ".workspace-global-apply.gate";
const REPORT_A = "report-a.json";
const REPORT_B = "report-b.json";
const JOURNAL = "intent-progress.json";
const DARWIN_O_SHLOCK = 0x10;
const DARWIN_O_EXLOCK = 0x20;
const HEX40 = /^[0-9a-f]{40}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const FIXED_ROOTS = [".riff-workspaces", ".riff-workspace", "mesa_service/.riff-workspace"];
const FIXED_OUTPUT = "outputs/gate-4-retirement";
const FIXED_CONTROL = ".riff-control";
const APPROVAL = "review-approval.json";
const INTERNAL_CAPABILITY = Symbol("synthetic-auditor-capability");

export class AuditError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const fail = (code, message, details) => { throw new AuditError(code, message, details); };
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sha1 = (value) => createHash("sha1").update(value).digest("hex");
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const sortValue = (value) => Array.isArray(value) ? value.map(sortValue) : plain(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])])) : value;
const canonical = (value) => JSON.stringify(sortValue(value));
const digestObject = (value) => sha256(canonical(value));
const exactKeys = (value, keys, code = "invalid_schema") => {
  if (!plain(value)) fail(code, "A required document is not a plain JSON object.");
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code, "A required document has an unsupported key set.", { actual, expected });
};
const statType = (stat) => stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other";
const statTuple = (stat) => ({ device: stat.dev, inode: stat.ino, mode: stat.mode, nlink: stat.nlink, byte_length: stat.isFile() ? stat.size : 0, file_type: statType(stat) });
const descriptorSnapshot = (path, code = "unsafe_file", expectedType = "file", requireSingleLink = true) => {
  let fd; try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (error) { fail(code, "A required path cannot be opened without following links.", { path, cause: error?.code }); }
  try {
    const held = fstatSync(fd); const type = statType(held); if ((expectedType && type !== expectedType) || (requireSingleLink && held.nlink !== 1)) fail(code, "A required descriptor has an unsupported type or link count.", { path, type, nlink: held.nlink });
    const bytes = type === "file" ? readFileSync(fd) : null; let after; try { after = lstatSync(path); } catch (error) { fail(code, "A required pathname disappeared while its descriptor was held.", { path, cause: error?.code }); }
    const heldTuple = statTuple(held); const afterTuple = statTuple(after); if (after.isSymbolicLink() || canonical(afterTuple) !== canonical(heldTuple)) fail(code, "A required pathname changed while its no-follow descriptor was held.", { path, held: heldTuple, after: afterTuple });
    return { bytes, tuple: heldTuple };
  } finally { closeSync(fd); }
};
const readSafeRegular = (path, code = "unsafe_file") => descriptorSnapshot(path, code, "file").bytes;
const json = (path) => { let value; try { value = JSON.parse(readSafeRegular(path, "invalid_json").toString("utf8")); } catch (error) { if (error instanceof AuditError) throw error; fail("invalid_json", "A required JSON document cannot be parsed.", { path }); } if (!plain(value)) fail("invalid_json", "A required JSON document must be a plain object.", { path }); return value; };
const contains = (parent, child) => child === parent || child.startsWith(`${parent}${sep}`);
const overlaps = (left, right) => contains(left, right) || contains(right, left);
const compareBytes = (left, right) => Buffer.from(left).compare(Buffer.from(right));
const pathExists = (path) => { try { lstatSync(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; fail("path_probe_failed", "A no-follow path presence check failed.", { path, cause: error?.code }); } };

const assertNoSymlinkComponents = (input, allowMissingLeaf = false) => {
  const candidate = resolve(input); let current = candidate.startsWith(sep) ? sep : "";
  const parts = candidate.split(sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    if (!pathExists(current)) {
      if (allowMissingLeaf && index === parts.length - 1) continue;
      fail("path_missing", "A required path does not exist.", { path: current });
    }
    if (lstatSync(current).isSymbolicLink()) fail("symlink_rejected", "Symlink path components are not allowed.", { path: current });
  }
  return candidate;
};

const tuple = (path, hash = true) => {
  const snapshot = descriptorSnapshot(path, "tuple_drift", null, false); if (snapshot.tuple.file_type === "file" && snapshot.tuple.nlink !== 1) fail("tuple_drift", "A workspace file tuple has multiple links.", { path }); return { ...snapshot.tuple, ...(hash && snapshot.tuple.file_type === "file" ? { sha256: sha256(snapshot.bytes) } : {}) };
};

const identityEntry = (root, path, kind, disposition, reason, identityEvidence = {}) => {
  const observed = tuple(path);
  return {
    kind,
    exact_realpath: realpathSync(path),
    relative_path: relative(root, path),
    file_type: observed.file_type,
    device: observed.device,
    inode: observed.inode,
    mode: observed.mode,
    nlink: observed.nlink,
    byte_length: observed.byte_length,
    ...(observed.sha256 ? { sha256: observed.sha256 } : {}),
    identity_evidence: identityEvidence,
    disposition,
    reason,
  };
};

const fsyncDirectory = (path) => { const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } };
const atomicJson = (path, value, replace = false, options = {}, label = "atomic_json") => {
  const parent = dirname(path); const temp = join(parent, `.${basename(path)}.${randomUUID()}.tmp`);
  const bytes = Buffer.from(`${canonical(value)}\n`); const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fault(options, `${label}:after_temp_write`); fsyncSync(fd); fault(options, `${label}:after_file_fsync`); } finally { closeSync(fd); }
  if (!replace && pathExists(path)) { unlinkSync(temp); fail("output_conflict", "An immutable audit output already exists.", { path }); }
  renameSync(temp, path); fault(options, `${label}:after_rename`); fsyncDirectory(parent); fault(options, `${label}:after_parent_fsync`);
};

const reportDigest = (report) => digestObject(Object.fromEntries(Object.entries(report).filter(([key]) => key !== "report_digest")));

const lockFile = (path, mode) => {
  if (process.platform !== "darwin" || constants.O_NONBLOCK !== 0x4 || !constants.O_NOFOLLOW) fail("lock_unsupported", "The auditor requires verified Darwin open-lock semantics.");
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail("lock_corrupt", "A lifecycle lock path is not a single-link regular file.", { path });
  const flag = mode === "shared" ? DARWIN_O_SHLOCK : DARWIN_O_EXLOCK;
  let fd;
  try { fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK | flag); }
  catch (error) { fail("lock_conflict", "A required workspace lock is unavailable.", { path, cause: error.code }); }
  const held = fstatSync(fd); const after = lstatSync(path);
  if (!held.isFile() || held.dev !== after.dev || held.ino !== after.ino || after.nlink !== 1) { closeSync(fd); fail("lock_corrupt", "A lock changed during acquisition.", { path }); }
  return { fd, path, mode, tuple: tuple(path, false) };
};
const releaseLocks = (locks) => { for (const lock of [...locks].reverse()) closeSync(lock.fd); };

const acquireRootLocks = (roots, mode) => {
  const locks = [];
  try {
    for (const root of roots) locks.push(lockFile(join(root, LIFECYCLE), mode === "apply" ? "exclusive" : "shared"));
    for (const root of roots) locks.push(lockFile(join(root, MUTATION), "exclusive"));
    return locks;
  } catch (error) { releaseLocks(locks); throw error; }
};
const verifyApplyLockProofs = (report, locks) => {
  const expected = [...report.lifecycle_lock_proof, ...report.mutation_lock_proof]; if (expected.length !== 6 || locks.length !== 6) fail("lock_proof_drift", "The exact six-lock proof is incomplete."); const expectedByPath = new Map(expected.map((item) => [item.path, item.tuple])); if (expectedByPath.size !== 6) fail("lock_proof_drift", "Report A contains duplicate lock paths.");
  for (const lock of locks) { const expectedTuple = expectedByPath.get(lock.path); const held = fstatSync(lock.fd); const observed = tuple(lock.path, false); if (!expectedTuple || realpathSync(assertNoSymlinkComponents(lock.path)) !== lock.path || !held.isFile() || held.dev !== observed.device || held.ino !== observed.inode || held.mode !== observed.mode || held.nlink !== observed.nlink || held.size !== observed.byte_length || canonical(observed) !== canonical(expectedTuple)) fail("lock_proof_drift", "A lifecycle or mutation lock path, descriptor, inode, link count, size, or mode drifted from report A.", { path: lock.path }); expectedByPath.delete(lock.path); }
  if (expectedByPath.size) fail("lock_proof_drift", "An exact report-A lock path was not acquired.");
};

const objectPath = (gitDir, oid) => join(gitDir, "objects", oid.slice(0, 2), oid.slice(2));
const readLooseObject = (gitDir, oid) => {
  if (!HEX40.test(oid)) fail("git_object_invalid", "A Git object ID is invalid.");
  const path = objectPath(gitDir, oid);
  if (!pathExists(path)) fail("git_object_unsupported", "A required Git object is not available as a loose object; packed or promisor objects are not accepted.", { oid });
  const inflated = inflateSync(readSafeRegular(path, "git_object_corrupt")); const zero = inflated.indexOf(0);
  if (zero < 1) fail("git_object_corrupt", "A Git object header is corrupt.");
  const header = inflated.subarray(0, zero).toString("ascii"); const match = /^(commit|tree|blob) ([0-9]+)$/u.exec(header);
  if (!match) fail("git_object_corrupt", "A Git object header is unsupported.");
  const body = inflated.subarray(zero + 1); if (body.byteLength !== Number(match[2]) || sha1(inflated) !== oid) fail("git_object_corrupt", "A Git object digest or length is invalid.");
  return { type: match[1], body };
};

const resolveGit = (repository) => {
  const marker = join(repository, ".git"); const stat = lstatSync(marker); let gitDir;
  if (stat.isDirectory()) gitDir = realpathSync(marker);
  else if (stat.isFile()) { const text = readSafeRegular(marker, "gitdir_invalid").toString("utf8").trim(); if (!text.startsWith("gitdir: ")) fail("gitdir_invalid", "The repository gitdir indirection is invalid."); gitDir = realpathSync(resolve(repository, text.slice(8))); }
  else fail("gitdir_invalid", "The repository .git path is unsupported.");
  const headText = readSafeRegular(join(gitDir, "HEAD"), "git_head_invalid").toString("utf8").trim(); let head;
  if (headText.startsWith("ref: ")) {
    const ref = headText.slice(5); const refPath = join(gitDir, ...ref.split("/"));
    if (pathExists(refPath)) head = readSafeRegular(refPath, "git_head_invalid").toString("utf8").trim();
    else { const packed = readSafeRegular(join(gitDir, "packed-refs"), "git_head_invalid").toString("utf8").split("\n").find((line) => line.endsWith(` ${ref}`)); head = packed?.split(" ", 1)[0]; }
  } else head = headText;
  if (!head || !HEX40.test(head)) fail("git_head_invalid", "The repository HEAD cannot be resolved exactly.");
  return { gitDir, head };
};

const readCommitTree = (gitDir, head) => {
  const object = readLooseObject(gitDir, head); if (object.type !== "commit") fail("git_head_invalid", "HEAD is not a commit object.");
  const treeLine = object.body.toString("utf8").split("\n").find((line) => line.startsWith("tree "));
  const tree = treeLine?.slice(5); if (!tree || !HEX40.test(tree)) fail("git_tree_invalid", "HEAD has no valid tree."); return tree;
};

const readTree = (gitDir, oid, prefix = "", output = new Map()) => {
  const object = readLooseObject(gitDir, oid); if (object.type !== "tree") fail("git_tree_invalid", "A referenced Git tree is invalid.");
  let offset = 0;
  while (offset < object.body.length) {
    const space = object.body.indexOf(0x20, offset); const zero = object.body.indexOf(0, space + 1);
    if (space < 1 || zero < 0 || zero + 21 > object.body.length) fail("git_tree_invalid", "A Git tree entry is truncated.");
    const mode = object.body.subarray(offset, space).toString("ascii"); const name = object.body.subarray(space + 1, zero).toString("utf8"); const child = object.body.subarray(zero + 1, zero + 21).toString("hex");
    if (!name || name.includes("/") || name === "." || name === "..") fail("git_tree_invalid", "A Git tree path is unsafe.");
    const path = prefix ? `${prefix}/${name}` : name;
    if (mode === "40000" || mode === "040000") readTree(gitDir, child, path, output); else {
      if (!["100644", "100755", "120000"].includes(mode)) fail("git_tree_unsupported", "A Git tree mode is unsupported.", { path, mode });
      output.set(path, { mode, oid: child });
    }
    offset = zero + 21;
  }
  return output;
};

const readIndex = (gitDir) => {
  const bytes = readSafeRegular(join(gitDir, "index"), "git_index_invalid"); if (bytes.length < 32 || bytes.subarray(0, 4).toString("ascii") !== "DIRC") fail("git_index_invalid", "The Git index header is invalid.");
  const version = bytes.readUInt32BE(4); if (version !== 2) fail("git_index_unsupported", "Only a complete Git index v2 is accepted.");
  const count = bytes.readUInt32BE(8); const expectedChecksum = bytes.subarray(-20).toString("hex"); if (sha1(bytes.subarray(0, -20)) !== expectedChecksum) fail("git_index_corrupt", "The Git index checksum is invalid.");
  let offset = 12; const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    const start = offset; if (offset + 62 > bytes.length - 20) fail("git_index_corrupt", "A Git index entry is truncated.");
    const modeRaw = bytes.readUInt32BE(offset + 24); const oid = bytes.subarray(offset + 40, offset + 60).toString("hex"); const flags = bytes.readUInt16BE(offset + 60); const stage = (flags >> 12) & 3;
    if (stage !== 0 || flags & 0x4000) fail("git_index_unsupported", "Unmerged or extended Git index entries are not accepted.");
    const nameStart = offset + 62; const zero = bytes.indexOf(0, nameStart); if (zero < 0) fail("git_index_corrupt", "A Git index pathname is unterminated.");
    const path = bytes.subarray(nameStart, zero).toString("utf8"); if (!path || isAbsolute(path) || path.split("/").some((part) => part === ".." || part === ".")) fail("git_index_corrupt", "A Git index pathname is unsafe.");
    const mode = (modeRaw & 0o170000) === 0o120000 ? "120000" : (modeRaw & 0o111) ? "100755" : "100644";
    entries.set(path, { mode, oid }); offset = start + Math.ceil((62 + Buffer.byteLength(path) + 1) / 8) * 8;
  }
  while (offset < bytes.length - 20) {
    if (offset + 8 > bytes.length - 20) fail("git_index_corrupt", "A Git index extension is truncated.");
    const signature = bytes.subarray(offset, offset + 4).toString("ascii"); const length = bytes.readUInt32BE(offset + 4); offset += 8;
    if (offset + length > bytes.length - 20) fail("git_index_corrupt", "A Git index extension payload is truncated.");
    if (signature !== "TREE") fail("git_index_unsupported", "A Git index extension is not in the exact supported set.", { signature });
    offset += length;
  }
  return { entries, checksum: expectedChecksum };
};

const blobOid = (bytes) => sha1(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]));
const proveCleanRepository = (repository) => {
  const repo = realpathSync(assertNoSymlinkComponents(repository)); const { gitDir, head } = resolveGit(repo); const tree = readCommitTree(gitDir, head); const tracked = readTree(gitDir, tree); const index = readIndex(gitDir);
  if (tracked.size !== index.entries.size) fail("tracked_tree_dirty", "The Git index path set differs from HEAD.");
  const proof = [];
  for (const path of [...tracked.keys()].sort(compareBytes)) {
    const expected = tracked.get(path); const staged = index.entries.get(path);
    if (!staged || staged.mode !== expected.mode || staged.oid !== expected.oid) fail("tracked_tree_dirty", "The Git index differs from HEAD.", { path });
    const absolute = join(repo, ...path.split("/")); let bytes;
    if (expected.mode === "120000") fail("git_tree_unsupported", "Tracked symlinks are outside the no-follow worktree proof contract.", { path });
    else { const snapshot = descriptorSnapshot(absolute, "tracked_worktree_dirty", "file"); bytes = snapshot.bytes; const executable = Boolean(snapshot.tuple.mode & 0o111); if ((expected.mode === "100755") !== executable) fail("tracked_worktree_dirty", "A tracked executable bit changed.", { path }); }
    if (blobOid(bytes) !== expected.oid) fail("tracked_worktree_dirty", "Tracked worktree bytes differ from HEAD.", { path }); proof.push([path, expected.mode, expected.oid]);
  }
  return { repository: repo, git_dir: gitDir, audited_repository_head: head, git_tree_oid: tree, tracked_worktree_clean_proof: { index_checksum: index.checksum, entries_digest: digestObject(proof), entry_count: proof.length } };
};

const importPolicy = (source) => {
  const forbidden = [/\bimport\s*\(/u, /\bcreateRequire\b/u, /\bmodule\.register\b/u, /\brequire\s*\(/u, /^#!/u];
  if (forbidden.some((pattern) => pattern.test(source))) fail("auditor_import_policy", "The auditor source violates its one-file import policy.");
  const specifiers = [...source.matchAll(/from\s+["']([^"']+)["']/gu)].map((match) => match[1]);
  if (!specifiers.length || specifiers.some((value) => !value.startsWith("node:"))) fail("auditor_import_policy", "The auditor imports a non-built-in module.");
  return digestObject({ specifiers: [...new Set(specifiers)].sort(), forbidden: forbidden.map(String) });
};

const fileIdentitySnapshot = (path) => { const canonicalPath = realpathSync(assertNoSymlinkComponents(path)); const snapshot = descriptorSnapshot(canonicalPath, "tcb_identity_drift", "file"); return { identity: { path: canonicalPath, file_tuple: snapshot.tuple, sha256: sha256(snapshot.bytes) }, bytes: snapshot.bytes }; };
const fileIdentity = (path) => fileIdentitySnapshot(path).identity;

const formatUuid = (bytes) => { if (bytes.length !== 16 || bytes.every((value) => value === 0)) fail("dyld_cache_header_invalid", "A dyld shared-cache UUID is absent."); const hex = bytes.toString("hex"); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`.toUpperCase(); };
const readDyldHeader = (bytes, path, platformArchitecture) => { if (bytes.length < 104) fail("dyld_cache_header_invalid", "A dyld shared-cache header is truncated.", { path }); const header = bytes.subarray(0, 104); const magic = header.subarray(0, 16).toString("ascii").replaceAll("\0", "").trimEnd(); const match = /^dyld_v1\s+(arm64e?|x86_64h?)$/u.exec(magic); if (!match) fail("dyld_cache_header_invalid", "A dyld shared-cache magic or architecture is unsupported.", { path, magic }); const cacheArchitecture = match[1]; const compatible = platformArchitecture === "arm64" ? cacheArchitecture === "arm64" || cacheArchitecture === "arm64e" : platformArchitecture === "x64" ? cacheArchitecture === "x86_64" || cacheArchitecture === "x86_64h" : false; if (!compatible) fail("dyld_cache_header_invalid", "A dyld shared-cache architecture differs from Node.", { path, cacheArchitecture, platformArchitecture }); return { header_magic: magic, cache_architecture: cacheArchitecture, header_uuid: formatUuid(header.subarray(0x58, 0x68)) }; };
const bindCacheResidentPaths = (paths, imagePaths, cacheUuid, pathTableSha256) => paths.map((reportedPath) => { if (!imagePaths.has(reportedPath)) fail("dyld_cache_unattributable", "A missing shared object is not an exact image in the bound dyld cache path table.", { reportedPath }); return { reported_path: reportedPath, image_path: reportedPath, cache_uuid: cacheUuid, path_table_sha256: pathTableSha256 }; });
export const rejectForeignCachePathForSelfTest = (reportedPath, allowedPaths, cacheUuid = "00000000-0000-4000-8000-000000000001") => bindCacheResidentPaths([reportedPath], new Set(allowedPaths), cacheUuid, sha256(canonical(allowedPaths)));

const collectTcb = (auditorPath, strictExecArgv = true) => {
  if (process.env.NODE_OPTIONS !== undefined || process.env.NODE_PATH !== undefined || (strictExecArgv && process.execArgv.length)) fail("runtime_injection", "Node loader, import, or path injection is not allowed.");
  const auditorSnapshot = fileIdentitySnapshot(auditorPath); const auditor = auditorSnapshot.identity; auditor.import_policy_digest = importPolicy(auditorSnapshot.bytes.toString("utf8"));
  const executable = fileIdentity(process.execPath);
  const preload = [...new Set(process.report.getReport().sharedObjects ?? [])].sort(compareBytes); for (const reportedPath of preload) if (pathExists(reportedPath)) readSafeRegular(realpathSync(reportedPath), "tcb_identity_drift");
  const reported = [...new Set(process.report.getReport().sharedObjects ?? [])].sort(compareBytes); if (!reported.length || canonical(reported) !== canonical(preload)) fail("tcb_closure_drift", "The loaded native closure changed during preload."); const loaded = []; const cacheResident = [];
  for (const reportedPath of reported) {
    if (pathExists(reportedPath)) loaded.push({ reported_path: reportedPath, ...fileIdentity(reportedPath) }); else cacheResident.push(reportedPath);
  }
  const systemRecord = "/System/Library/CoreServices/SystemVersion.plist"; const system = fileIdentity(systemRecord);
  const cacheDirectories = ["/System/Library/dyld", "/System/Volumes/Preboot/Cryptexes/OS/System/Library/dyld"].filter(pathExists); const platformArchitecture = arch(); const prefix = platformArchitecture === "arm64" ? "dyld_shared_cache_arm64" : platformArchitecture === "x64" ? "dyld_shared_cache_x86_64" : ""; if (!prefix) fail("dyld_cache_header_invalid", "The Node architecture has no supported dyld shared-cache mapping.");
  const candidates = []; for (const directory of cacheDirectories) for (const name of readdirSync(directory).filter((item) => item.startsWith(prefix) && !item.endsWith(".map") && !item.endsWith(".atlas") && !item.endsWith(".symbols") && /^dyld_shared_cache_[^.]+(?:\.\d+(?:\.(?:dylddata|dyldreadonly|dyldlinkedit))?)?$/u.test(item)).sort(compareBytes)) candidates.push(join(directory, name));
  if (!candidates.length) fail("dyld_cache_unattributable", "No architecture-compatible dyld shared-cache binaries are readable."); const components = candidates.map((path) => { const snapshot = fileIdentitySnapshot(path); return { ...snapshot.identity, ...readDyldHeader(snapshot.bytes, path, platformArchitecture) }; }); const main = components.find((item) => !/\.\d+(?:\.|$)/u.test(basename(item.path))); if (!main) fail("dyld_cache_unattributable", "The main dyld shared-cache component is missing."); const mapPath = `${main.path}.map`; const mapSnapshot = fileIdentitySnapshot(mapPath); const pathTable = mapSnapshot.identity; const imagePaths = new Set(mapSnapshot.bytes.toString("utf8").split(/\r?\n/u).filter((line) => line.startsWith("/"))); if (!imagePaths.size) fail("dyld_cache_unattributable", "The bound dyld cache image path table is empty."); const memberships = bindCacheResidentPaths(cacheResident, imagePaths, main.header_uuid, pathTable.sha256);
  const dyld = { platform_build_record: system, kernel_release: release(), architecture: platformArchitecture, cache_resident_paths: cacheResident, cache_image_memberships: memberships, image_path_table: { ...pathTable, cache_uuid: main.header_uuid, image_count: imagePaths.size, image_paths_digest: digestObject([...imagePaths].sort(compareBytes)) }, components };
  const nodeRuntime = { realpath: executable.path, file_tuple: executable.file_tuple, sha256: executable.sha256, version: process.version, exec_argv: [...process.execArgv], loaded_macho_closure: loaded, dyld_cache_identity: dyld };
  if (!loaded.length && !cacheResident.length) fail("tcb_closure_empty", "A production TCB cannot claim an empty native closure.");
  nodeRuntime.closure_digest = digestObject(nodeRuntime);
  return { auditor, node_runtime: nodeRuntime };
};

export const inspectRealTcbForSelfTest = () => collectTcb(fileURLToPath(import.meta.url), false);

const validatePr = (record, expected) => {
  exactKeys(record, ["authenticated", "host", "repository", "number", "base_branch", "head_branch", "head_oid", "state", "is_draft", "review_decision"]);
  if (record.authenticated !== true || record.host !== expected.host || record.repository !== expected.repository || record.number !== expected.number || record.base_branch !== expected.base_branch || record.head_branch !== expected.head_branch || record.head_oid !== expected.head_oid || record.state !== "open" || record.is_draft !== false || record.review_decision !== "APPROVED") fail("pr_admission_denied", "The authenticated pull-request record is not an approved exact-head admission.");
  return { ...record, authenticated_read_digest: digestObject(record) };
};
const validateStoredPr = (snapshot, expected, code) => {
  try {
    exactKeys(snapshot, ["authenticated", "host", "repository", "number", "base_branch", "head_branch", "head_oid", "state", "is_draft", "review_decision", "authenticated_read_digest"], code); const record = Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== "authenticated_read_digest")); const validated = validatePr(record, expected); if (canonical(validated) !== canonical(snapshot)) fail(code, "A stored authenticated pull-request digest is invalid."); return snapshot;
  } catch (error) { if (error instanceof AuditError && error.code === code) throw error; fail(code, "A stored pull-request admission is not the exact authenticated approved head.", { cause: error?.code }); }
};

const httpsJson = (url, token) => new Promise((resolvePromise, rejectPromise) => {
  const request = httpsGet(url, { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "riff-workspace-retirement-auditor", "x-github-api-version": "2022-11-28" }, timeout: 10_000 }, (response) => {
    const chunks = []; response.on("data", (chunk) => chunks.push(chunk)); response.on("end", () => { if (response.statusCode !== 200) return rejectPromise(new AuditError("pr_network_failure", "The authenticated pull-request read failed.")); try { resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { rejectPromise(new AuditError("pr_network_failure", "The authenticated pull-request response is invalid.")); } });
  }); request.on("timeout", () => request.destroy(new Error("timeout"))); request.on("error", () => rejectPromise(new AuditError("pr_network_failure", "The authenticated pull-request read failed.")));
});

const readPr = async (expected, options) => {
  if (options[INTERNAL_CAPABILITY]) return validatePr(options[INTERNAL_CAPABILITY].readPr(expected), expected);
  const token = process.env.GITHUB_TOKEN; if (!token) fail("pr_auth_missing", "An authenticated live pull-request read is required.");
  const base = `https://${expected.host}/repos/${expected.repository}/pulls/${expected.number}`; const [pull, reviews] = await Promise.all([httpsJson(base, token), httpsJson(`${base}/reviews`, token)]);
  const latest = new Map(); for (const review of Array.isArray(reviews) ? reviews : []) if (review?.user?.id) latest.set(review.user.id, review.state);
  const record = { authenticated: true, host: expected.host, repository: expected.repository, number: expected.number, base_branch: pull.base?.ref, head_branch: pull.head?.ref, head_oid: pull.head?.sha, state: pull.state, is_draft: pull.draft, review_decision: [...latest.values()].includes("APPROVED") ? "APPROVED" : "UNAPPROVED" };
  return validatePr(record, expected);
};

const normalizeTarget = (value, internal = false) => {
  exactKeys(value, ["schema_id", "schema_version", "model_id", "model_class", "protocol_version", "revision_pattern", "run_pattern", "pull_request"]);
  if (value.schema_id !== "riff://workspace-retirement/target/v1" || value.schema_version !== 1 || typeof value.model_id !== "string" || !value.model_id || typeof value.model_class !== "string" || !value.model_class || typeof value.protocol_version !== "string" || !value.protocol_version) fail("target_invalid", "The supplied target identity is invalid.");
  try { new RegExp(value.revision_pattern, "u"); new RegExp(value.run_pattern, "u"); } catch { fail("target_invalid", "The supplied target identity patterns are invalid."); }
  exactKeys(value.pull_request, ["host", "repository", "number", "base_branch", "head_branch"]);
  if ((!internal && value.pull_request.host !== "api.github.com") || !Number.isSafeInteger(value.pull_request.number) || value.pull_request.number < 1 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value.pull_request.repository)) fail("target_invalid", "The supplied pull-request identity is invalid.");
  return value;
};

const revisionManifest = (revision, target) => {
  exactKeys(revision, ["model_id", "model_class", "protocol_version", "sha256"]);
  if (revision.model_id !== target.model_id || revision.model_class !== target.model_class || revision.protocol_version !== target.protocol_version || !/^[0-9a-f]{64}$/u.test(revision.sha256)) fail("target_mismatch", "A model manifest does not match the supplied target identity.");
};

const enumerateTree = (root) => {
  const entries = []; const walk = (directory) => { for (const name of readdirSync(directory).sort(compareBytes)) { const path = join(directory, name); const stat = lstatSync(path); if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) { entries.push({ path, unsafe: true }); continue; } entries.push({ path, unsafe: false }); if (stat.isDirectory()) walk(path); } }; walk(root); return entries;
};

const inspectRoot = (root, target) => {
  const all = enumerateTree(root); const preserved = []; const ambiguous = []; const candidates = []; const revisions = new Map(); const runs = new Map(); const activePointers = [];
  const revisionRegex = new RegExp(target.revision_pattern, "u"); const runRegex = new RegExp(target.run_pattern, "u");
  for (const item of all) if (item.unsafe) ambiguous.push(identityEntry(root, item.path, "unsafe", "ambiguous", "unsupported filesystem entry"));
  const revisionDirs = all.filter(({ path, unsafe }) => !unsafe && lstatSync(path).isDirectory() && basename(dirname(path)) === "revisions" && basename(dirname(dirname(path))) === "model" && revisionRegex.test(basename(path))).map((item) => item.path);
  for (const directory of revisionDirs) {
    try {
      const names = readdirSync(directory).sort(compareBytes); const allowed = new Set(["manifest.json", "model.py", "model_schema.json", "experiment_schema.json", "__pycache__"]);
      if (names.some((name) => !allowed.has(name)) || ["manifest.json", "model.py", "model_schema.json", "experiment_schema.json"].some((name) => !names.includes(name))) fail("revision_children_invalid", "A model revision has an unexpected child set.");
      for (const name of ["manifest.json", "model.py", "model_schema.json", "experiment_schema.json"]) { const stat = lstatSync(join(directory, name)); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("revision_children_invalid", "A mandatory model revision file is unsafe."); }
      const manifest = json(join(directory, "manifest.json")); revisionManifest(manifest, target);
      if (sha256(readSafeRegular(join(directory, "model.py"), "manifest_digest_mismatch")) !== manifest.sha256) fail("manifest_digest_mismatch", "A model source digest differs from its manifest.");
      const cache = join(directory, "__pycache__"); const cacheFiles = [];
      if (pathExists(cache)) { if (!lstatSync(cache).isDirectory()) fail("revision_children_invalid", "A Python cache path is not a directory."); for (const name of readdirSync(cache).sort(compareBytes)) { const path = join(cache, name); const stat = lstatSync(path); if (!/^model\.cpython-[0-9]+\.pyc$/u.test(name) || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("revision_children_invalid", "A Python cache descendant is not bound to the copied model source."); cacheFiles.push(path); } }
      const revisionId = basename(directory); const manifestDigest = digestObject(manifest); const files = ["manifest.json", "model.py", "model_schema.json", "experiment_schema.json"].map((name) => join(directory, name));
      revisions.set(`${dirname(dirname(dirname(directory)))}\0${revisionId}`, { directory, revisionId, manifest, manifestDigest, files, cache, cacheFiles });
    } catch (error) { ambiguous.push(identityEntry(root, directory, "model_revision", "ambiguous", error.code ?? "revision validation failed")); }
  }
  const runDirs = all.filter(({ path, unsafe }) => !unsafe && lstatSync(path).isDirectory() && basename(dirname(path)) === "runs" && runRegex.test(basename(path))).map((item) => item.path);
  for (const directory of runDirs) {
    try {
      const names = readdirSync(directory).sort(compareBytes); const required = ["metadata.json", "request.json", "run.log", "summary.json", "timeseries.csv"].sort(compareBytes);
      if (names.length !== required.length || names.some((name, index) => name !== required[index])) fail("run_children_invalid", "A run has an unexpected child set.");
      for (const name of required) { const stat = lstatSync(join(directory, name)); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("run_children_invalid", "A run child is unsafe."); }
      const request = json(join(directory, "request.json")); const metadata = json(join(directory, "metadata.json")); const summary = json(join(directory, "summary.json"));
      exactKeys(request, ["model_revision", "parameters", "seeds", "steps"]); const metadataKeys = Object.keys(metadata).sort(); const expectedBase = ["created_at", "finished_at", "model_manifest_digest", "request_digest", "run_id", "started_at", "status", "timeout_seconds", "worker_exit_code"].sort(); const expectedWithModel = [...expectedBase, "model_id"].sort(); if (![expectedBase, expectedWithModel].some((keys) => keys.length === metadataKeys.length && keys.every((key, index) => key === metadataKeys[index]))) fail("run_schema_invalid", "Run metadata has an unsupported exact shape.");
      exactKeys(summary, ["model_id", "model_revision"]);
      if (metadata.run_id !== basename(directory) || metadata.request_digest !== digestObject(request)) fail("run_digest_mismatch", "Run request identity or digest is invalid.");
      const container = dirname(dirname(directory)); const revision = revisions.get(`${container}\0${request.model_revision}`); if (!revision || metadata.model_manifest_digest !== revision.manifestDigest) fail("run_revision_unbound", "A run does not bind an eligible same-container model revision.");
      if ("model_id" in metadata && metadata.model_id !== target.model_id) fail("target_mismatch", "Run metadata has a different target identity.");
      if (summary.model_id !== target.model_id || summary.model_revision !== request.model_revision) fail("target_mismatch", "Run summary identity differs from its request target.");
      runs.set(directory, { directory, runId: basename(directory), revision, files: required.map((name) => join(directory, name)) });
    } catch (error) { ambiguous.push(identityEntry(root, directory, "run", "ambiguous", error.code ?? "run validation failed")); }
  }
  for (const item of all.filter(({ path, unsafe }) => !unsafe && basename(path) === "active.json" && basename(dirname(path)) === "model")) {
    try {
      if (!lstatSync(item.path).isFile()) fail("active_pointer_invalid", "An active pointer is not a regular file."); const active = json(item.path); exactKeys(active, ["model_revision", "model_id", "manifest_sha256"]);
      if (active.model_id !== target.model_id) { preserved.push(identityEntry(root, item.path, "active_pointer", "preserve", "active pointer has another identity")); continue; }
      const container = dirname(dirname(item.path)); const revision = revisions.get(`${container}\0${active.model_revision}`); if (!revision || active.manifest_sha256 !== revision.manifestDigest) fail("active_pointer_unbound", "An active pointer does not bind an eligible same-container revision.");
      activePointers.push({ path: item.path, revision });
    } catch (error) { ambiguous.push(identityEntry(root, item.path, "active_pointer", "ambiguous", error.code ?? "active pointer validation failed")); }
  }
  const candidatePaths = new Set([...revisions.values()].flatMap((value) => [value.directory, ...value.files, ...(value.cacheFiles ?? []), ...(pathExists(value.cache) ? [value.cache] : [])]).concat([...runs.values()].flatMap((value) => [value.directory, ...value.files]), activePointers.map((value) => value.path)));
  const ids = new Map(); for (const revision of revisions.values()) ids.set(revision.revisionId, revision.directory); for (const run of runs.values()) ids.set(run.runId, run.directory);
  const reverse = [];
  for (const item of all) {
    if (item.unsafe || !lstatSync(item.path).isFile() || candidatePaths.has(item.path) || [LIFECYCLE, MUTATION, FENCE].includes(basename(item.path))) continue;
    if (!item.path.endsWith(".json")) { preserved.push(identityEntry(root, item.path, "preserved_file", "preserve", "file is outside an eligible target record")); continue; }
    let value; try { value = JSON.parse(readSafeRegular(item.path, "reverse_reference_invalid").toString("utf8")); } catch { ambiguous.push(identityEntry(root, item.path, "unknown_json", "ambiguous", "unparseable JSON may contain an unresolved reverse reference")); continue; }
    const bytes = canonical(value); const matches = [...ids.keys()].filter((id) => bytes.includes(id));
    if (matches.length) reverse.push({ source: realpathSync(item.path), referenced_ids: matches, candidate_paths: matches.map((id) => ids.get(id)) });
    preserved.push(identityEntry(root, item.path, "preserved_json", "preserve", matches.length ? "preserved reverse reference" : "record is outside an eligible target record"));
  }
  const blocked = new Set(reverse.flatMap((item) => item.candidate_paths));
  for (const revision of revisions.values()) {
    if (blocked.has(revision.directory)) { ambiguous.push(identityEntry(root, revision.directory, "model_revision", "ambiguous", "eligible revision has a preserved reverse reference")); continue; }
    for (const file of revision.files) candidates.push(identityEntry(root, file, "revision_file", "delete", "exact target manifest/source/schema member", { revision_id: revision.revisionId, manifest_digest: revision.manifestDigest }));
    for (const file of revision.cacheFiles) candidates.push(identityEntry(root, file, "cache_file", "delete", "enumerated cache member of exact target revision", { revision_id: revision.revisionId }));
    if (pathExists(revision.cache)) candidates.push(identityEntry(root, revision.cache, "internal_directory", "delete", "enumerated cache directory becomes empty", { revision_id: revision.revisionId }));
    candidates.push(identityEntry(root, revision.directory, "revision_directory", "delete", "exact target revision becomes empty", { revision_id: revision.revisionId }));
  }
  for (const run of runs.values()) {
    if (blocked.has(run.directory) || blocked.has(run.revision.directory)) { ambiguous.push(identityEntry(root, run.directory, "run", "ambiguous", "eligible run has a preserved reverse reference")); continue; }
    for (const file of run.files) candidates.push(identityEntry(root, file, "run_file", "delete", "exact target run member", { run_id: run.runId, revision_id: run.revision.revisionId }));
    candidates.push(identityEntry(root, run.directory, "run_directory", "delete", "exact target run becomes empty", { run_id: run.runId }));
  }
  for (const active of activePointers) if (!blocked.has(active.revision.directory)) candidates.push(identityEntry(root, active.path, "active_pointer", "delete", "exact target active pointer", { revision_id: active.revision.revisionId }));
  return { candidates, preserved, ambiguous, reverse };
};

const scanRoots = (roots, target) => {
  const inspected = roots.map((root) => ({ root, ...inspectRoot(root, target) }));
  return {
    delete_entries: inspected.flatMap((item) => item.candidates),
    ambiguous_entries: inspected.flatMap((item) => item.ambiguous),
    preserved_entries: inspected.flatMap((item) => item.preserved),
    reverse_references: inspected.flatMap((item) => item.reverse),
  };
};
const membershipPaths = (roots) => roots.flatMap((root) => enumerateTree(root).map((item) => item.path)).sort(compareBytes);

const validatePaths = (repository) => {
  const repo = realpathSync(assertNoSymlinkComponents(repository)); const expectedRoots = FIXED_ROOTS.map((item) => join(repo, ...item.split("/")));
  const canonicalRoots = expectedRoots.map((root) => { const requested = assertNoSymlinkComponents(root); const canonicalRoot = realpathSync(requested); if (canonicalRoot !== requested || !lstatSync(canonicalRoot).isDirectory()) fail("root_set_invalid", "A fixed workspace root is not an exact canonical directory."); return canonicalRoot; }).sort(compareBytes);
  if (new Set(canonicalRoots).size !== 3) fail("root_set_invalid", "The fixed workspace root set contains an alias or duplicate.");
  const output = realpathSync(assertNoSymlinkComponents(join(repo, ...FIXED_OUTPUT.split("/")))); const control = realpathSync(assertNoSymlinkComponents(join(repo, FIXED_CONTROL)));
  const ignorePath = join(repo, ".gitignore"); const ignoreLines = readSafeRegular(ignorePath, "ignore_contract_invalid").toString("utf8").split(/\r?\n/u); if (ignoreLines.filter((line) => line === "outputs/").length !== 1 || ignoreLines.filter((line) => line === ".riff-control/").length !== 1) fail("ignore_contract_invalid", "The tracked ignore contract must cover outputs/ and .riff-control/ exactly once.");
  const { gitDir, head } = resolveGit(repo); const tracked = readTree(gitDir, readCommitTree(gitDir, head)); if (!tracked.has(".gitignore") || [...tracked.keys()].some((item) => item === "outputs" || item.startsWith("outputs/") || item === FIXED_CONTROL || item.startsWith(`${FIXED_CONTROL}/`))) fail("tracked_control_path", "Audit outputs or control paths are tracked by Git.");
  if (canonicalRoots.some((root) => !contains(repo, root))) fail("root_set_invalid", "A workspace root is outside the explicit repository.");
  for (const root of canonicalRoots) if (overlaps(root, output) || overlaps(root, control)) fail("containment_conflict", "Audit output or control storage overlaps a workspace root.");
  if (overlaps(output, control)) fail("containment_conflict", "Audit output overlaps the control directory.");
  for (const root of canonicalRoots) for (const lock of [LIFECYCLE, MUTATION]) { const path = join(root, lock); const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("lock_missing", "Workspace lifecycle infrastructure was not provisioned.", { path }); }
  return { roots: canonicalRoots, repository: repo, outputParent: output, controlDirectory: control };
};

const currentCounts = (roots) => ({ files: roots.reduce((count, root) => count + enumerateTree(root).filter((item) => !item.unsafe && lstatSync(item.path).isFile()).length, 0), directories: roots.reduce((count, root) => count + enumerateTree(root).filter((item) => !item.unsafe && lstatSync(item.path).isDirectory()).length, 0) });
const fault = (options, point) => { if (options[INTERNAL_CAPABILITY]?.faultAt === point) throw new AuditError("injected_crash", `Injected crash at ${point}.`); };
const runtimeTcb = (options) => options[INTERNAL_CAPABILITY] ? sortValue(options[INTERNAL_CAPABILITY].tcb) : collectTcb(fileURLToPath(import.meta.url));
const probeClosedPort = (port) => new Promise((resolveProbe, rejectProbe) => { const socket = netConnect({ host: "127.0.0.1", port }); const finish = (state) => { socket.destroy(); resolveProbe(state); }; socket.setTimeout(250, () => finish("closed")); socket.once("connect", () => finish("open")); socket.once("error", () => finish("closed")); socket.once("close", () => {}); socket.once("lookup", () => {}); setTimeout(() => rejectProbe(new AuditError("service_probe_failed", "A local service port probe did not settle.")), 1_000).unref(); });
const serviceStateProof = async (options, locks) => {
  const mutationLocks = locks.filter((item) => basename(item.path) === MUTATION && item.mode === "exclusive"); const lifecycleLocks = locks.filter((item) => basename(item.path) === LIFECYCLE && item.mode === "shared"); if (mutationLocks.length !== 3 || lifecycleLocks.length !== 3) fail("service_state_unproven", "The exact lock ownership proof is incomplete.");
  if (options[INTERNAL_CAPABILITY]) return { lifecycle_shared_count: lifecycleLocks.length, mutation_exclusive_count: mutationLocks.length, conflicting_writer_count: 0, local_port_probes: [] };
  const probes = []; for (const port of [5173, 8091, 8787]) { const state = await probeClosedPort(port); probes.push({ host: "127.0.0.1", port, state }); if (state !== "closed") fail("service_process_active", "A known repository service port is active while producing report A.", { port }); }
  return { lifecycle_shared_count: lifecycleLocks.length, mutation_exclusive_count: mutationLocks.length, conflicting_writer_count: 0, local_port_probes: probes };
};

const dryRun = async (options) => {
  const target = normalizeTarget(json(options.targetPath), Boolean(options[INTERNAL_CAPABILITY])); const repository = proveCleanRepository(options.repository); const expectedPr = { ...target.pull_request, head_oid: repository.audited_repository_head };
  const paths = validatePaths(repository.repository); const locks = acquireRootLocks(paths.roots, "dry-run");
  try {
    const rootBefore = paths.roots.map((root) => ({ root, tuple: tuple(root, false), counts: currentCounts([root]) })); const services = await serviceStateProof(options, locks); const tcb = runtimeTcb(options); const pr = await readPr(expectedPr, options); const targetDigest = digestObject(target); const attemptId = randomUUID(); const auditId = sha256(`${repository.audited_repository_head}\0${targetDigest}\0${attemptId}`); const attemptDirectory = join(paths.outputParent, auditId);
    assertNoSymlinkComponents(attemptDirectory, true); mkdirSync(attemptDirectory, { mode: 0o700 }); if (realpathSync(attemptDirectory) !== attemptDirectory) fail("output_conflict", "The attempt directory is not canonical."); fsyncDirectory(paths.outputParent);
    const scan = scanRoots(paths.roots, target); const deleteEntries = scan.delete_entries; const ambiguousEntries = scan.ambiguous_entries; const preservedEntries = scan.preserved_entries; const reverseReferences = scan.reverse_references; const protectedPaths = new Set([...paths.roots.flatMap((root) => [join(root, LIFECYCLE), join(root, MUTATION), join(root, FENCE)]), paths.outputParent, attemptDirectory, paths.controlDirectory, join(paths.controlDirectory, GLOBAL_GATE)]);
    if (deleteEntries.some((entry) => paths.roots.some((root) => entry.exact_realpath === root || contains(entry.exact_realpath, root)) || [...protectedPaths].some((path) => overlaps(path, entry.exact_realpath)))) fail("containment_conflict", "A delete entry overlaps protected infrastructure.");
    const rootAfter = paths.roots.map((root) => ({ root, tuple: tuple(root, false), counts: currentCounts([root]) })); if (canonical(rootAfter) !== canonical(rootBefore)) fail("dry_run_mutated_root", "A workspace root changed during dry-run.");
    const unsigned = { schema_id: SCHEMA_A, schema_version: 1, mode: "dry-run", generated_at: new Date().toISOString(), attempt_id: attemptId, audit_id: auditId, audited_repository_head: repository.audited_repository_head, git_tree_oid: repository.git_tree_oid, tracked_worktree_clean_proof: repository.tracked_worktree_clean_proof, auditor: tcb.auditor, node_runtime: tcb.node_runtime, github_pr: pr, workspace_realpaths: paths.roots, target_identity: target, target_identity_digest: targetDigest, scan_root_device_and_inode: rootBefore, root_membership_paths: membershipPaths(paths.roots), output_directory: { canonical_realpath: attemptDirectory, parent_file_tuple: tuple(paths.outputParent, false), attempt_id: attemptId, audit_id: auditId }, service_state_proof: services, lock_conflicts: [], lifecycle_lock_proof: locks.filter((item) => basename(item.path) === LIFECYCLE).map(({ path, mode, tuple: itemTuple }) => ({ path, mode, tuple: itemTuple })), mutation_lock_proof: locks.filter((item) => basename(item.path) === MUTATION).map(({ path, mode, tuple: itemTuple }) => ({ path, mode, tuple: itemTuple })), entries: [...deleteEntries, ...ambiguousEntries, ...preservedEntries].sort((left, right) => compareBytes(left.exact_realpath, right.exact_realpath)), before_counts: currentCounts(paths.roots), ambiguous_entries: ambiguousEntries, preserved_entries: preservedEntries, delete_entries: deleteEntries, reverse_references: reverseReferences, prior_report_digest: null, after_counts: currentCounts(paths.roots), report_digest: "" };
    unsigned.report_digest = reportDigest(unsigned); atomicJson(join(attemptDirectory, REPORT_A), unsigned, false, options, "report_a"); return unsigned;
  } finally { releaseLocks(locks); }
};

const REPORT_A_KEYS = ["schema_id", "schema_version", "mode", "generated_at", "attempt_id", "audit_id", "audited_repository_head", "git_tree_oid", "tracked_worktree_clean_proof", "auditor", "node_runtime", "github_pr", "workspace_realpaths", "target_identity", "target_identity_digest", "scan_root_device_and_inode", "root_membership_paths", "output_directory", "service_state_proof", "lock_conflicts", "lifecycle_lock_proof", "mutation_lock_proof", "entries", "before_counts", "ambiguous_entries", "preserved_entries", "delete_entries", "reverse_references", "prior_report_digest", "after_counts", "report_digest"];
const readReportA = (path, paths, internal = false) => {
  const exactPath = realpathSync(assertNoSymlinkComponents(path)); const report = json(exactPath); exactKeys(report, REPORT_A_KEYS, "report_a_invalid");
  if (report.schema_id !== SCHEMA_A || report.schema_version !== 1 || report.mode !== "dry-run" || report.report_digest !== reportDigest(report) || !UUID.test(report.attempt_id) || !/^[0-9a-f]{64}$/u.test(report.audit_id)) fail("report_a_invalid", "Report A is invalid or has drifted.");
  const target = normalizeTarget(report.target_identity, internal); const targetDigest = digestObject(target); const expectedAudit = sha256(`${report.audited_repository_head}\0${targetDigest}\0${report.attempt_id}`); const attemptDirectory = join(paths.outputParent, expectedAudit);
  exactKeys(report.output_directory, ["canonical_realpath", "parent_file_tuple", "attempt_id", "audit_id"], "report_a_invalid");
  if (report.target_identity_digest !== targetDigest || report.audit_id !== expectedAudit || report.output_directory.attempt_id !== report.attempt_id || report.output_directory.audit_id !== report.audit_id || report.output_directory.canonical_realpath !== attemptDirectory || dirname(exactPath) !== attemptDirectory || basename(exactPath) !== REPORT_A || realpathSync(dirname(exactPath)) !== attemptDirectory || canonical(report.output_directory.parent_file_tuple) !== canonical(tuple(paths.outputParent, false)) || canonical(report.workspace_realpaths) !== canonical(paths.roots)) fail("report_a_invalid", "Report A attempt, target, roots, or output binding is invalid.");
  validateStoredPr(report.github_pr, { ...target.pull_request, head_oid: report.audited_repository_head }, "report_a_invalid");
  const recomposed = [...report.delete_entries, ...report.ambiguous_entries, ...report.preserved_entries].sort((left, right) => compareBytes(left.exact_realpath, right.exact_realpath)); if (canonical(recomposed) !== canonical(report.entries) || report.prior_report_digest !== null) fail("report_a_invalid", "Report A dispositions are not an exact partition.");
  return report;
};
const historyRecord = (sequence, state, detail, priorRecordDigest, priorSnapshotDigest) => { const record = { sequence, state, ...detail, prior_record_digest: priorRecordDigest, prior_snapshot_digest: priorSnapshotDigest, record_digest: "" }; record.record_digest = digestObject(Object.fromEntries(Object.entries(record).filter(([key]) => key !== "record_digest"))); return record; };
const transition = (journalPath, journal, state, detail = {}, options = {}) => { const priorSnapshotDigest = digestObject(journal); const priorRecordDigest = journal.history.at(-1).record_digest; const record = historyRecord(journal.sequence + 1, state, detail, priorRecordDigest, priorSnapshotDigest); const next = { ...journal, sequence: journal.sequence + 1, prior_journal_digest: priorSnapshotDigest, state, history: [...journal.history, record] }; atomicJson(journalPath, next, true, options, `journal_${state}`); return next; };
const createExclusiveRecord = (path, value, options = {}, label = "guard") => { const bytes = Buffer.from(`${canonical(value)}\n`); const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); try { writeFileSync(fd, bytes); fault(options, `${label}:after_create`); fsyncSync(fd); fault(options, `${label}:after_file_fsync`); } finally { closeSync(fd); } fsyncDirectory(dirname(path)); fault(options, `${label}:after_parent_fsync`); return tuple(path); };
const validateApproval = (path, report) => { const approval = json(path); exactKeys(approval, ["schema_id", "schema_version", "attempt_id", "report_a_digest", "approved"]); if (approval.schema_id !== "riff://workspace-retirement/review-approval/v1" || approval.schema_version !== 1 || approval.attempt_id !== report.attempt_id || approval.report_a_digest !== report.report_digest || approval.approved !== true) fail("review_approval_invalid", "Apply lacks approval for the exact attempt and report-A digest."); return digestObject(approval); };

const initialJournal = (report, approvalDigest) => {
  const initialRecord = historyRecord(0, "intent_committed", {}, null, null); const journal = { schema_id: SCHEMA_JOURNAL, schema_version: 1, attempt_id: report.attempt_id, audit_id: report.audit_id, report_a_digest: report.report_digest, approval_digest: approvalDigest, audited_repository_head: report.audited_repository_head, git_tree_oid: report.git_tree_oid, auditor_sha256: report.auditor.sha256, node_sha256: report.node_runtime.sha256, closure_digest: report.node_runtime.closure_digest, target_identity_digest: report.target_identity_digest, roots: report.workspace_realpaths, root_device_and_inode: report.scan_root_device_and_inode, lifecycle_lock_proof: report.lifecycle_lock_proof, mutation_lock_proof: report.mutation_lock_proof, ordered_operations: report.delete_entries.map((entry) => entry.exact_realpath), pre_delete_entries: report.delete_entries, intent_digest: "", sequence: 0, prior_journal_digest: null, state: "intent_committed", history: [initialRecord] };
  journal.intent_digest = digestObject(Object.fromEntries(Object.entries(journal).filter(([key]) => key !== "intent_digest"))); return journal;
};

const validateJournal = (journal, report, approvalDigest) => {
  const expected = initialJournal(report, approvalDigest); const stable = ["schema_id", "schema_version", "attempt_id", "audit_id", "report_a_digest", "approval_digest", "audited_repository_head", "git_tree_oid", "auditor_sha256", "node_sha256", "closure_digest", "target_identity_digest", "roots", "root_device_and_inode", "lifecycle_lock_proof", "mutation_lock_proof", "ordered_operations", "pre_delete_entries", "intent_digest"];
  exactKeys(journal, Object.keys(expected), "journal_corrupt");
  if (!plain(journal) || stable.some((key) => canonical(journal[key]) !== canonical(expected[key]))) fail("journal_conflict", "The apply journal does not bind the exact reviewed report and intent.");
  if (!Number.isSafeInteger(journal.sequence) || journal.sequence < 0 || !Array.isArray(journal.history) || journal.history.length !== journal.sequence + 1 || journal.history.some((item, index) => !plain(item) || item.sequence !== index) || journal.history.at(-1)?.state !== journal.state) fail("journal_corrupt", "The apply journal sequence or state history is invalid.");
  const rootOrder = report.workspace_realpaths.map(sha256); const reverseRoots = [...rootOrder].reverse(); let installed = 0; let operation = 0; let removal = 0; let abortRemoval = 0; let branch = "arming";
  for (let index = 0; index < journal.history.length; index += 1) {
    const record = journal.history[index]; const computedRecord = digestObject(Object.fromEntries(Object.entries(record).filter(([key]) => key !== "record_digest"))); const priorRecord = index ? journal.history[index - 1].record_digest : null;
    const detailKeys = ["fence_installed", "fence_removal_started", "fence_removal_completed", "abort_fence_removal_started", "abort_fence_removal_completed"].includes(record.state) ? ["root_digest"] : ["operation_started", "operation_completed"].includes(record.state) ? ["path"] : record.state === "pre_mutation_aborted" ? ["reason_code"] : ["report_b_committed", "apply_completed"].includes(record.state) ? ["report_b_digest"] : []; exactKeys(record, ["sequence", "state", ...detailKeys, "prior_record_digest", "prior_snapshot_digest", "record_digest"], "journal_corrupt");
    if (record.record_digest !== computedRecord || record.prior_record_digest !== priorRecord || (index === 0 ? record.prior_snapshot_digest !== null : !/^[0-9a-f]{64}$/u.test(record.prior_snapshot_digest))) fail("journal_digest_chain_invalid", "A journal history digest link is invalid.");
    if (index > 0) { const prior = { ...journal, sequence: index - 1, prior_journal_digest: journal.history[index - 1].prior_snapshot_digest, state: journal.history[index - 1].state, history: journal.history.slice(0, index) }; if (record.prior_snapshot_digest !== digestObject(prior)) fail("journal_digest_chain_invalid", "A prior journal snapshot digest cannot be recomputed."); }
    const previous = index ? journal.history[index - 1].state : null; const state = record.state;
    if (index === 0) { if (state !== "intent_committed") fail("journal_transition_invalid", "A journal does not begin with intent_committed."); continue; }
    if (state === "global_gate_armed") { if (previous !== "intent_committed") fail("journal_transition_invalid", "The global gate transition is out of order."); }
    else if (state === "fence_installed") { if (!["global_gate_armed", "fence_installed"].includes(previous) || installed >= rootOrder.length || record.root_digest !== rootOrder[installed]) fail("journal_transition_invalid", "A root fence transition is out of order."); installed += 1; }
    else if (state === "all_fences_armed") { if (previous !== "fence_installed" || installed !== rootOrder.length) fail("journal_transition_invalid", "The complete fence transition lacks all exact roots."); branch = "ready"; }
    else if (state === "pre_mutation_aborted") { if (previous !== "all_fences_armed" || branch !== "ready") fail("journal_transition_invalid", "The abort branch is not reachable from this state."); branch = "abort"; }
    else if (state === "operation_started") { if (branch !== "ready" || !["all_fences_armed", "operation_completed"].includes(previous) || operation >= journal.ordered_operations.length || record.path !== journal.ordered_operations[operation]) fail("journal_transition_invalid", "An operation-started transition is not the next exact intent operation."); }
    else if (state === "operation_completed") { if (previous !== "operation_started" || record.path !== journal.ordered_operations[operation]) fail("journal_transition_invalid", "An operation-completed transition does not match its start."); operation += 1; }
    else if (state === "report_b_committed") { if (branch !== "ready" || operation !== journal.ordered_operations.length || !["all_fences_armed", "operation_completed"].includes(previous)) fail("journal_transition_invalid", "Report B was committed before the exact operation chain completed."); branch = "success"; }
    else if (state === "apply_completed") { if (previous !== "report_b_committed" || branch !== "success") fail("journal_transition_invalid", "Apply completion is not bound to report B."); }
    else if (state === "fence_removal_started") { if (branch !== "success" || !["apply_completed", "fence_removal_completed"].includes(previous) || removal >= reverseRoots.length || record.root_digest !== reverseRoots[removal]) fail("journal_transition_invalid", "A success fence removal is out of order."); }
    else if (state === "fence_removal_completed") { if (previous !== "fence_removal_started" || record.root_digest !== reverseRoots[removal]) fail("journal_transition_invalid", "A success fence completion has no matching start."); removal += 1; }
    else if (state === "fences_cleared") { if (previous !== "fence_removal_completed" || removal !== reverseRoots.length) fail("journal_transition_invalid", "Success fences were not all cleared."); }
    else if (state === "release_global_gate_removal_started") { if (previous !== "fences_cleared") fail("journal_transition_invalid", "Success global-gate removal started out of order."); }
    else if (state === "release_global_gate_removal_completed") { if (previous !== "release_global_gate_removal_started") fail("journal_transition_invalid", "Success global-gate removal completed out of order."); }
    else if (state === "release_gate_cleared") { if (previous !== "release_global_gate_removal_completed") fail("journal_transition_invalid", "Success terminal state is out of order."); }
    else if (state === "abort_fence_removal_started") { if (branch !== "abort" || !["pre_mutation_aborted", "abort_fence_removal_completed"].includes(previous) || abortRemoval >= reverseRoots.length || record.root_digest !== reverseRoots[abortRemoval]) fail("journal_transition_invalid", "An abort fence removal is out of order."); }
    else if (state === "abort_fence_removal_completed") { if (previous !== "abort_fence_removal_started" || record.root_digest !== reverseRoots[abortRemoval]) fail("journal_transition_invalid", "An abort fence completion has no matching start."); abortRemoval += 1; }
    else if (state === "abort_fences_cleared") { if (previous !== "abort_fence_removal_completed" || abortRemoval !== reverseRoots.length) fail("journal_transition_invalid", "Abort fences were not all cleared."); }
    else if (state === "abort_global_gate_removal_started") { if (previous !== "abort_fences_cleared") fail("journal_transition_invalid", "Abort global-gate removal started out of order."); }
    else if (state === "abort_global_gate_removal_completed") { if (previous !== "abort_global_gate_removal_started") fail("journal_transition_invalid", "Abort global-gate removal completed out of order."); }
    else if (state === "abort_release_gate_cleared") { if (previous !== "abort_global_gate_removal_completed") fail("journal_transition_invalid", "Abort terminal state is out of order."); }
    else fail("journal_transition_invalid", "A journal contains an unknown state.", { state });
  }
  if (journal.sequence === 0 ? journal.prior_journal_digest !== null : journal.prior_journal_digest !== journal.history.at(-1).prior_snapshot_digest) fail("journal_corrupt", "The journal prior-snapshot digest is invalid.");
  return journal;
};

const readReportB = (path, report) => {
  const result = json(path); exactKeys(result, ["schema_id", "schema_version", "mode", "generated_at", "attempt_id", "audit_id", "report_a_digest", "audited_repository_head", "git_tree_oid", "auditor_sha256", "node_sha256", "closure_digest", "target_identity_digest", "pre_b_journal_digest", "deleted_entries", "post_state_scan", "github_pr", "report_digest"], "report_b_invalid"); if (result.schema_id !== SCHEMA_B || result.schema_version !== 1 || result.mode !== "apply" || result.report_digest !== reportDigest(result) || result.attempt_id !== report.attempt_id || result.audit_id !== report.audit_id || result.report_a_digest !== report.report_digest || result.audited_repository_head !== report.audited_repository_head || result.git_tree_oid !== report.git_tree_oid || result.auditor_sha256 !== report.auditor.sha256 || result.node_sha256 !== report.node_runtime.sha256 || result.closure_digest !== report.node_runtime.closure_digest || result.target_identity_digest !== report.target_identity_digest) fail("report_b_invalid", "Report B is invalid, drifted, or belongs to another attempt."); validateStoredPr(result.github_pr, { host: report.github_pr.host, repository: report.github_pr.repository, number: report.github_pr.number, base_branch: report.github_pr.base_branch, head_branch: report.github_pr.head_branch, head_oid: report.audited_repository_head }, "report_b_invalid"); return result;
};
const countsWithoutFences = (roots) => ({ files: roots.reduce((count, root) => count + enumerateTree(root).filter((item) => !item.unsafe && basename(item.path) !== FENCE && lstatSync(item.path).isFile()).length, 0), directories: roots.reduce((count, root) => count + enumerateTree(root).filter((item) => !item.unsafe && lstatSync(item.path).isDirectory()).length, 0) });
const postStateSnapshot = (report, paths) => { const scan = scanRoots(paths.roots, report.target_identity); return { remaining_delete_paths: report.delete_entries.filter((entry) => pathExists(entry.exact_realpath)).map((entry) => entry.exact_realpath), counts_without_fences: countsWithoutFences(paths.roots), membership_without_fences: membershipPaths(paths.roots).filter((path) => basename(path) !== FENCE), remaining_target_fingerprints: [...scan.delete_entries, ...scan.ambiguous_entries].map((entry) => ({ exact_realpath: entry.exact_realpath, kind: entry.kind, disposition: entry.disposition, reason: entry.reason })) }; };
const snapshotBeforeHistoryIndex = (journal, index) => index === 0 ? null : ({ ...journal, sequence: index - 1, prior_journal_digest: journal.history[index - 1].prior_snapshot_digest, state: journal.history[index - 1].state, history: journal.history.slice(0, index) });
const validateReportBCrossBindings = (reportB, report, journal, paths, freshAdmission) => {
  if (!journal) fail("report_b_invalid", "Report B exists without its exact apply journal."); exactKeys(reportB.post_state_scan, ["remaining_delete_paths", "counts_without_fences", "membership_without_fences", "remaining_target_fingerprints"], "report_b_invalid"); const expectedDeleted = report.delete_entries.map((entry) => ({ exact_realpath: entry.exact_realpath, sha256: entry.sha256 ?? null, kind: entry.kind })); if (canonical(reportB.deleted_entries) !== canonical(expectedDeleted) || canonical(reportB.post_state_scan) !== canonical(postStateSnapshot(report, paths)) || reportB.post_state_scan.remaining_delete_paths.length || reportB.post_state_scan.remaining_target_fingerprints.length) fail("report_b_invalid", "Report B deleted operations or post-state fingerprints do not recompute exactly.");
  if (!freshAdmission || canonical(reportB.github_pr) !== canonical(freshAdmission)) fail("report_b_invalid", "Report B pull-request admission differs from the fresh authenticated live admission.");
  const recordIndex = journal.history.findIndex((item) => item.state === "report_b_committed"); const preB = recordIndex < 0 ? journal : snapshotBeforeHistoryIndex(journal, recordIndex); if (!preB || reportB.pre_b_journal_digest !== digestObject(preB)) fail("report_b_invalid", "Report B does not bind the actual pre-B journal snapshot."); const committed = recordIndex < 0 ? null : journal.history[recordIndex]; const completed = journal.history.find((item) => item.state === "apply_completed"); if (committed && committed.report_b_digest !== reportB.report_digest) fail("report_b_invalid", "The report-B journal record has a different digest."); if (completed && completed.report_b_digest !== reportB.report_digest) fail("report_b_invalid", "Apply completion has a different report-B digest."); return reportB;
};

const validateEntry = (entry) => {
  const stat = lstatSync(entry.exact_realpath); if (stat.isSymbolicLink()) fail("entry_drift", "A report entry became a symlink."); const observed = tuple(entry.exact_realpath); const keys = entry.file_type === "directory" ? ["device", "inode", "mode", "file_type"] : ["device", "inode", "mode", "nlink", "byte_length", "file_type"]; for (const key of keys) if (observed[key] !== entry[key]) fail("entry_drift", "A report entry tuple changed.", { path: entry.exact_realpath, key }); if (entry.file_type === "file" && observed.sha256 !== entry.sha256) fail("entry_drift", "A report entry hash changed.", { path: entry.exact_realpath });
};
const assertContainerAllowed = (entry, roots) => {
  if (!roots.some((root) => contains(root, entry.exact_realpath))) fail("container_delete_forbidden", "A delete entry escapes the exact roots.");
  if (entry.file_type === "file") {
    const name = basename(entry.exact_realpath); const parent = basename(dirname(entry.exact_realpath)); const allowedFile = entry.kind === "revision_file" && ["manifest.json", "model.py", "model_schema.json", "experiment_schema.json"].includes(name) && /^revision_[0-9a-f]+$/u.test(parent)
      || entry.kind === "cache_file" && parent === "__pycache__" && /^model\.cpython-[0-9]+\.pyc$/u.test(name)
      || entry.kind === "run_file" && ["metadata.json", "request.json", "run.log", "summary.json", "timeseries.csv"].includes(name) && /^execution_[0-9a-f]+$/u.test(parent)
      || entry.kind === "active_pointer" && name === "active.json" && parent === "model";
    if (!allowedFile) fail("container_delete_forbidden", "A file delete entry does not match an exact eligible leaf schema.", { path: entry.exact_realpath }); return;
  }
  if (entry.file_type !== "directory") fail("container_delete_forbidden", "Only regular files and exact empty internal directories may be deleted.");
  const name = basename(entry.exact_realpath); const parent = basename(dirname(entry.exact_realpath));
  const allowed = entry.kind === "run_directory" && parent === "runs"
    || entry.kind === "revision_directory" && parent === "revisions"
    || entry.kind === "internal_directory" && name === "__pycache__" && /^revision_[0-9a-f]+$/u.test(parent);
  if (!allowed || roots.some((root) => entry.exact_realpath === root) || name.startsWith("project") || name.startsWith("orphan-") || name === "quarantine") fail("container_delete_forbidden", "Project, quarantine, and root container deletion is forbidden.", { path: entry.exact_realpath });
};

export const validateDeletionEntry = (entry, roots) => assertContainerAllowed(entry, roots);

const heldMatchesEntry = (stat, entry, type) => stat.dev === entry.device && stat.ino === entry.inode && stat.mode === entry.mode && (type === "file" ? stat.nlink === entry.nlink && stat.isFile() && stat.size === entry.byte_length : stat.isDirectory() && entry.byte_length === 0);
const removeEntry = (entry, roots, options) => {
  assertContainerAllowed(entry, roots); const parent = realpathSync(dirname(entry.exact_realpath)); if (!roots.some((root) => contains(root, parent))) fail("entry_escape", "A delete parent escapes the root set."); const parentFd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fault(options, `delete_after_parent_open:${entry.exact_realpath}`); validateEntry(entry); fault(options, `delete_after_first_lstat:${entry.exact_realpath}`);
    if (entry.file_type === "file") { const fd = openSync(entry.exact_realpath, constants.O_RDONLY | constants.O_NOFOLLOW); try { const held = fstatSync(fd); if (!heldMatchesEntry(held, entry, "file") || sha256(readFileSync(fd)) !== entry.sha256) fail("entry_drift", "An open delete file does not match the complete report-A tuple and hash."); fault(options, `delete_after_file_hash:${entry.exact_realpath}`); const pathStat = lstatSync(entry.exact_realpath); if (!heldMatchesEntry(pathStat, entry, "file") || held.dev !== pathStat.dev || held.ino !== pathStat.ino) fail("entry_drift", "A delete file pathname changed after descriptor validation."); fault(options, `delete_before_unlink:${entry.exact_realpath}`); unlinkSync(entry.exact_realpath); fault(options, `delete_after_unlink:${entry.exact_realpath}`); fsyncSync(parentFd); fault(options, `delete_after_parent_fsync:${entry.exact_realpath}`); } finally { closeSync(fd); } }
    else { const fd = openSync(entry.exact_realpath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { const held = fstatSync(fd); if (!heldMatchesEntry(held, entry, "directory") || readdirSync(entry.exact_realpath).length) fail("entry_drift", "An open delete directory is not the exact empty report-A directory.", { path: entry.exact_realpath, observed: { device: held.dev, inode: held.ino, mode: held.mode, nlink: held.nlink }, expected: { device: entry.device, inode: entry.inode, mode: entry.mode, nlink: entry.nlink } }); fault(options, `delete_after_directory_scan:${entry.exact_realpath}`); const pathStat = lstatSync(entry.exact_realpath); if (!heldMatchesEntry(pathStat, entry, "directory") || held.dev !== pathStat.dev || held.ino !== pathStat.ino) fail("entry_drift", "A delete directory pathname changed after descriptor validation."); fault(options, `delete_before_rmdir:${entry.exact_realpath}`); rmdirSync(entry.exact_realpath); fault(options, `delete_after_rmdir:${entry.exact_realpath}`); fsyncSync(parentFd); fault(options, `delete_after_parent_fsync:${entry.exact_realpath}`); } finally { closeSync(fd); } }
  } finally { closeSync(parentFd); }
};

const gateDocument = (report, journalDigest) => ({ schema_id: SCHEMA_GATE, schema_version: 1, protocol_version: PROTOCOL, attempt_id: report.attempt_id, audit_id: report.audit_id, report_a_digest: report.report_digest, journal_intent_digest: journalDigest, audited_repository_head: report.audited_repository_head, git_tree_oid: report.git_tree_oid, auditor_sha256: report.auditor.sha256, node_sha256: report.node_runtime.sha256, closure_digest: report.node_runtime.closure_digest, target_identity_digest: report.target_identity_digest, root_digests: report.workspace_realpaths.map(sha256), armed: true });
const fenceDocument = (report, journalDigest, root) => ({ schema_id: SCHEMA_FENCE, schema_version: 1, protocol_version: PROTOCOL, attempt_id: report.attempt_id, audit_id: report.audit_id, report_a_digest: report.report_digest, journal_intent_digest: journalDigest, audited_repository_head: report.audited_repository_head, git_tree_oid: report.git_tree_oid, auditor_sha256: report.auditor.sha256, node_sha256: report.node_runtime.sha256, closure_digest: report.node_runtime.closure_digest, target_identity_digest: report.target_identity_digest, root_digest: sha256(root), armed: true });
const verifyExactJson = (path, expected) => { const bytes = readSafeRegular(path, "gate_mismatch"); if (!bytes.equals(Buffer.from(`${canonical(expected)}\n`))) fail("gate_mismatch", "A persistent gate or fence does not match the exact attempt.", { path }); };

const historyHas = (journal, state, predicate = () => true) => journal.history.some((item) => item.state === state && predicate(item));
const rootHistoryHas = (journal, state, root) => historyHas(journal, state, (item) => item.root_digest === sha256(root));

const ensureArmedGuards = (report, journalPath, journal, paths, options) => {
  const gate = join(paths.controlDirectory, GLOBAL_GATE); const expectedGate = gateDocument(report, journal.intent_digest);
  const gateRecorded = historyHas(journal, "global_gate_armed");
  if (pathExists(gate)) {
    verifyExactJson(gate, expectedGate);
    if (!gateRecorded) journal = transition(journalPath, journal, "global_gate_armed", {}, options);
  } else {
    if (gateRecorded) fail("gate_missing_after_armed", "The durable global gate disappeared after it was recorded as armed.");
    createExclusiveRecord(gate, expectedGate, options, "global_gate"); fault(options, "after_global_gate_create");
    journal = transition(journalPath, journal, "global_gate_armed", {}, options);
  }
  fault(options, "after_global_gate");
  for (const root of paths.roots) {
    const fence = join(root, FENCE); const expectedFence = fenceDocument(report, journal.intent_digest, root); const recorded = rootHistoryHas(journal, "fence_installed", root);
    if (pathExists(fence)) {
      verifyExactJson(fence, expectedFence);
      if (!recorded) journal = transition(journalPath, journal, "fence_installed", { root_digest: sha256(root) }, options);
    } else {
      if (recorded) fail("fence_missing_after_armed", "A durable root fence disappeared after it was recorded as armed.", { root });
      createExclusiveRecord(fence, expectedFence, options, `fence_${sha256(root)}`); fault(options, `after_fence_create:${sha256(root)}`);
      journal = transition(journalPath, journal, "fence_installed", { root_digest: sha256(root) }, options);
    }
    fault(options, `after_fence:${sha256(root)}`);
  }
  if (!historyHas(journal, "all_fences_armed")) journal = transition(journalPath, journal, "all_fences_armed", {}, options);
  return journal;
};

const clearFences = (report, journalPath, journal, abort = false, options = {}) => {
  const prefix = abort ? "abort_" : "";
  for (const root of [...report.workspace_realpaths].reverse()) {
    const path = join(root, FENCE); const startedState = `${prefix}fence_removal_started`; const completedState = `${prefix}fence_removal_completed`; const started = rootHistoryHas(journal, startedState, root); const completed = rootHistoryHas(journal, completedState, root);
    if (completed) { if (pathExists(path)) fail("fence_reappeared", "A root fence reappeared after durable removal completion.", { root }); continue; }
    if (!started) {
      if (!pathExists(path)) fail("fence_missing_without_started", "A root fence is missing without a durable removal-started state.", { root });
      verifyExactJson(path, fenceDocument(report, journal.intent_digest, root)); journal = transition(journalPath, journal, startedState, { root_digest: sha256(root) }, options);
    }
    if (pathExists(path)) { verifyExactJson(path, fenceDocument(report, journal.intent_digest, root)); fault(options, `${prefix}before_fence_unlink:${sha256(root)}`); unlinkSync(path); fault(options, `${prefix}after_fence_unlink:${sha256(root)}`); fsyncDirectory(root); }
    else fsyncDirectory(root); fault(options, `${prefix}after_fence_parent_fsync:${sha256(root)}`);
    journal = transition(journalPath, journal, completedState, { root_digest: sha256(root) }, options);
  }
  if (!historyHas(journal, `${prefix}fences_cleared`)) journal = transition(journalPath, journal, `${prefix}fences_cleared`, {}, options);
  const gate = join(options.controlDirectory, GLOBAL_GATE); const started = abort ? "abort_global_gate_removal_started" : "release_global_gate_removal_started"; const completed = abort ? "abort_global_gate_removal_completed" : "release_global_gate_removal_completed"; const terminal = abort ? "abort_release_gate_cleared" : "release_gate_cleared";
  const removalStarted = historyHas(journal, started); const removalCompleted = historyHas(journal, completed);
  if (removalCompleted) { if (pathExists(gate)) fail("gate_reappeared", "The global gate reappeared after durable removal completion."); }
  else {
    if (!removalStarted) {
      if (!pathExists(gate)) fail("gate_missing_without_started", "A global gate is missing without a durable removal-started state.");
      verifyExactJson(gate, gateDocument(report, journal.intent_digest)); journal = transition(journalPath, journal, started, {}, options);
    }
    if (pathExists(gate)) { verifyExactJson(gate, gateDocument(report, journal.intent_digest)); fault(options, `${prefix}before_global_unlink`); unlinkSync(gate); fault(options, `${prefix}after_global_unlink`); fsyncDirectory(options.controlDirectory); }
    else fsyncDirectory(options.controlDirectory); fault(options, `${prefix}after_global_parent_fsync`);
    journal = transition(journalPath, journal, completed, {}, options);
  }
  return historyHas(journal, terminal) ? journal : transition(journalPath, journal, terminal, {}, options);
};

const sameTcb = (left, right) => canonical(left) === canonical(right);
const validateWorkspaceClosure = (report, paths, journal = null) => {
  const mutationStarted = Boolean(journal && historyHas(journal, "operation_started")); const currentMembership = membershipPaths(paths.roots).filter((path) => basename(path) !== FENCE); const expectedMembership = report.root_membership_paths; const currentSet = new Set(currentMembership); const expectedSet = new Set(expectedMembership); const startedPaths = new Set((journal?.history ?? []).filter((item) => item.state === "operation_started").map((item) => item.path));
  const unexpected = currentMembership.filter((path) => !expectedSet.has(path)); const missing = expectedMembership.filter((path) => !currentSet.has(path) && !startedPaths.has(path)); if (unexpected.length || missing.length) fail("root_snapshot_drift", "Workspace membership drifted from report A during apply or resume.", { unexpected, missing });
  for (const entry of report.entries) if (currentSet.has(entry.exact_realpath)) validateEntry(entry);
  const rescanned = scanRoots(paths.roots, report.target_identity); if (!mutationStarted) {
    const rootSnapshot = paths.roots.map((root) => ({ root, tuple: tuple(root, false), counts: currentCounts([root]) })); const rescannedEntries = [...rescanned.delete_entries, ...rescanned.ambiguous_entries, ...rescanned.preserved_entries].sort((left, right) => compareBytes(left.exact_realpath, right.exact_realpath));
    const rootsMatch = journal ? rootSnapshot.every((item, index) => { const expected = report.scan_root_device_and_inode[index]; return item.root === expected.root && ["device", "inode", "mode", "file_type"].every((key) => item.tuple[key] === expected.tuple[key]); }) : canonical(rootSnapshot) === canonical(report.scan_root_device_and_inode); const countsMatch = journal ? true : canonical(currentCounts(paths.roots)) === canonical(report.before_counts);
    if (!rootsMatch || canonical(rescanned.delete_entries) !== canonical(report.delete_entries) || canonical(rescanned.ambiguous_entries) !== canonical(report.ambiguous_entries) || canonical(rescanned.preserved_entries) !== canonical(report.preserved_entries) || canonical(rescanned.reverse_references) !== canonical(report.reverse_references) || canonical(rescannedEntries) !== canonical(report.entries) || !countsMatch || canonical(report.before_counts) !== canonical(report.after_counts)) fail("root_snapshot_drift", "The full schema, join, reverse-reference, tuple, or membership closure drifted from report A.");
  } else {
    const known = new Set(report.entries.map((entry) => entry.exact_realpath)); const unexplained = [...rescanned.delete_entries, ...rescanned.ambiguous_entries, ...rescanned.preserved_entries].filter((entry) => !known.has(entry.exact_realpath) && !startedPaths.has(entry.exact_realpath)); if (unexplained.length) fail("root_snapshot_drift", "A resumed partial apply discovered a new schema record or reference.", { paths: unexplained.map((entry) => entry.exact_realpath) });
  }
  return { mutationStarted, rescanned, currentMembership };
};
const revalidatePreflight = async (report, options) => {
  const repository = proveCleanRepository(options.repository); if (repository.audited_repository_head !== report.audited_repository_head || repository.git_tree_oid !== report.git_tree_oid || canonical(repository.tracked_worktree_clean_proof) !== canonical(report.tracked_worktree_clean_proof)) fail("head_drift", "Repository HEAD, tree, index, or tracked worktree drifted from report A.");
  const tcb = runtimeTcb(options); if (!sameTcb(tcb.auditor, report.auditor) || !sameTcb(tcb.node_runtime, report.node_runtime)) fail("tcb_drift", "The auditor, Node runtime, loaded closure, or platform identity drifted from report A.");
  return await readPr({ host: report.github_pr.host, repository: report.github_pr.repository, number: report.github_pr.number, base_branch: report.github_pr.base_branch, head_branch: report.github_pr.head_branch, head_oid: report.audited_repository_head }, options);
};
const readAndRevalidateReportB = async (reportBPath, report, journal, paths, options) => { const reportB = readReportB(reportBPath, report); const freshAdmission = await revalidatePreflight(report, options); return validateReportBCrossBindings(reportB, report, journal, paths, freshAdmission); };

const applyReport = async (options) => {
  const paths = validatePaths(options.repository); const report = readReportA(options.reportAPath, paths, Boolean(options[INTERNAL_CAPABILITY])); if (report.ambiguous_entries.length) fail("ambiguity_present", "Report A contains ambiguity and is not mutation-eligible."); const approvalDigest = validateApproval(options.approvalPath, report); const locks = acquireRootLocks(paths.roots, "apply"); const journalPath = join(report.output_directory.canonical_realpath, JOURNAL); const reportBPath = join(report.output_directory.canonical_realpath, REPORT_B);
  try {
    verifyApplyLockProofs(report, locks);
    let journal = pathExists(journalPath) ? json(journalPath) : null;
    if (journal) validateJournal(journal, report, approvalDigest);
    if (pathExists(reportBPath)) await readAndRevalidateReportB(reportBPath, report, journal, paths, options);
    try { validateWorkspaceClosure(report, paths, journal); }
    catch (error) {
      if (!journal) throw error;
      const mutationStarted = historyHas(journal, "operation_started"); if (mutationStarted) fail("persistent_recovery_drift", "A resumed mutation discovered workspace drift; persistent recovery guards remain armed.", { cause: error.code ?? "root_snapshot_drift" });
      if (!historyHas(journal, "pre_mutation_aborted")) { journal = ensureArmedGuards(report, journalPath, journal, paths, options); journal = transition(journalPath, journal, "pre_mutation_aborted", { reason_code: error.code ?? "root_snapshot_drift" }, options); }
      journal = clearFences(report, journalPath, journal, true, { ...options, controlDirectory: paths.controlDirectory }); return { status: "pre_mutation_aborted", journal };
    }
    if (journal?.state === "release_gate_cleared" && pathExists(reportBPath)) { const reportB = await readAndRevalidateReportB(reportBPath, report, journal, paths, options); if (pathExists(join(paths.controlDirectory, GLOBAL_GATE)) || paths.roots.some((root) => pathExists(join(root, FENCE)))) fail("terminal_gate_present", "A terminal successful attempt still has an admission guard."); validateWorkspaceClosure(report, paths, journal); return { status: "already_applied", report_b: reportB }; }
    if (journal?.state === "abort_release_gate_cleared") { if (pathExists(reportBPath) || pathExists(join(paths.controlDirectory, GLOBAL_GATE)) || paths.roots.some((root) => pathExists(join(root, FENCE)))) fail("terminal_abort_invalid", "A terminal aborted attempt has B or an admission guard."); return { status: "already_aborted" }; }
    if (journal?.history?.some((item) => item.state === "pre_mutation_aborted")) { journal = clearFences(report, journalPath, journal, true, { ...options, controlDirectory: paths.controlDirectory }); return { status: "already_aborted", journal }; }
    await revalidatePreflight(report, options);
    for (const entry of report.delete_entries) if (pathExists(entry.exact_realpath)) validateEntry(entry); else if (!journal?.history?.some((item) => item.state === "operation_started" && item.path === entry.exact_realpath)) fail("entry_missing", "An unjournaled report entry is missing.", { path: entry.exact_realpath });
    if (!journal) {
      const initial = initialJournal(report, approvalDigest); atomicJson(journalPath, initial, false, options, "journal_intent_committed"); journal = initial; fault(options, "after_intent_commit");
    }
    const releaseBegan = journal.history.some((item) => item.state.startsWith("release_") || item.state === "apply_completed");
    if (!releaseBegan) {
      journal = ensureArmedGuards(report, journalPath, journal, paths, options);
      const mutationBegan = historyHas(journal, "operation_started");
      if (!mutationBegan) {
        try { await revalidatePreflight(report, options); }
        catch (error) { journal = transition(journalPath, journal, "pre_mutation_aborted", { reason_code: error.code ?? "pr_admission_denied" }, options); journal = clearFences(report, journalPath, journal, true, { ...options, controlDirectory: paths.controlDirectory }); return { status: "pre_mutation_aborted", journal }; }
      }
    }
    for (const entry of report.delete_entries) {
      const completed = journal.history.some((item) => item.state === "operation_completed" && item.path === entry.exact_realpath); if (completed) continue;
      const started = journal.history.some((item) => item.state === "operation_started" && item.path === entry.exact_realpath);
      if (!started) journal = transition(journalPath, journal, "operation_started", { path: entry.exact_realpath }, options);
      fault(options, `before_operation:${entry.exact_realpath}`); if (pathExists(entry.exact_realpath)) removeEntry(entry, paths.roots, options); fault(options, `after_operation:${entry.exact_realpath}`); journal = transition(journalPath, journal, "operation_completed", { path: entry.exact_realpath }, options);
    }
    let reportB;
    if (pathExists(reportBPath)) { reportB = await readAndRevalidateReportB(reportBPath, report, journal, paths, options); if (report.delete_entries.some((entry) => pathExists(entry.exact_realpath)) || report.delete_entries.some((entry) => !historyHas(journal, "operation_completed", (item) => item.path === entry.exact_realpath))) fail("report_b_conflict", "Report B exists before the exact operation chain completed."); if (!historyHas(journal, "report_b_committed")) journal = transition(journalPath, journal, "report_b_committed", { report_b_digest: reportB.report_digest }, options); }
    else { const currentTcb = runtimeTcb(options); if (!sameTcb(currentTcb.auditor, report.auditor) || !sameTcb(currentTcb.node_runtime, report.node_runtime)) fail("tcb_drift", "The TCB drifted after mutation; gates remain armed."); const postState = postStateSnapshot(report, paths); const unsigned = { schema_id: SCHEMA_B, schema_version: 1, mode: "apply", generated_at: new Date().toISOString(), attempt_id: report.attempt_id, audit_id: report.audit_id, report_a_digest: report.report_digest, audited_repository_head: report.audited_repository_head, git_tree_oid: report.git_tree_oid, auditor_sha256: report.auditor.sha256, node_sha256: report.node_runtime.sha256, closure_digest: report.node_runtime.closure_digest, target_identity_digest: report.target_identity_digest, pre_b_journal_digest: digestObject(journal), deleted_entries: report.delete_entries.map((entry) => ({ exact_realpath: entry.exact_realpath, sha256: entry.sha256 ?? null, kind: entry.kind })), post_state_scan: postState, github_pr: await revalidatePreflight(report, options), report_digest: "" }; if (postState.remaining_delete_paths.length || postState.remaining_target_fingerprints.length) fail("post_state_invalid", "A report-A delete path or target fingerprint remains after apply."); unsigned.report_digest = reportDigest(unsigned); fault(options, "before_report_b_write"); atomicJson(reportBPath, unsigned, false, options, "report_b"); reportB = unsigned; fault(options, "after_report_b_write"); journal = transition(journalPath, journal, "report_b_committed", { report_b_digest: reportB.report_digest }, options); fault(options, "after_report_b"); }
    await revalidatePreflight(report, options); if (!journal.history.some((item) => item.state === "apply_completed")) journal = transition(journalPath, journal, "apply_completed", { report_b_digest: reportB.report_digest }, options); fault(options, "after_apply_completed"); journal = clearFences(report, journalPath, journal, false, { ...options, controlDirectory: paths.controlDirectory }); return { status: "applied", report_b: reportB, journal };
  } finally { releaseLocks(locks); }
};

const writeSyntheticJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const writeSyntheticGitObject = (gitDir, type, body) => { const framed = Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]); const oid = sha1(framed); const directory = join(gitDir, "objects", oid.slice(0, 2)); mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, oid.slice(2)), deflateSync(framed)); return oid; };
const createSyntheticGitRepository = (repository) => {
  const gitDir = join(repository, ".git"); mkdirSync(join(gitDir, "objects"), { recursive: true }); mkdirSync(join(gitDir, "refs", "heads"), { recursive: true }); const ignore = Buffer.from("outputs/\n.riff-control/\n"); writeFileSync(join(repository, ".gitignore"), ignore);
  const blob = writeSyntheticGitObject(gitDir, "blob", ignore); const treeBody = Buffer.concat([Buffer.from("100644 .gitignore\0"), Buffer.from(blob, "hex")]); const tree = writeSyntheticGitObject(gitDir, "tree", treeBody); const commitBody = Buffer.from(`tree ${tree}\nauthor Synthetic <synthetic@example.invalid> 0 +0000\ncommitter Synthetic <synthetic@example.invalid> 0 +0000\n\ninternal fixture\n`); const head = writeSyntheticGitObject(gitDir, "commit", commitBody); writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n"); writeFileSync(join(gitDir, "refs", "heads", "main"), `${head}\n`);
  const name = Buffer.from(".gitignore"); const entryLength = Math.ceil((62 + name.length + 1) / 8) * 8; const entry = Buffer.alloc(entryLength); entry.writeUInt32BE(0o100644, 24); Buffer.from(blob, "hex").copy(entry, 40); entry.writeUInt16BE(name.length, 60); name.copy(entry, 62); const header = Buffer.alloc(12); header.write("DIRC", 0, "ascii"); header.writeUInt32BE(2, 4); header.writeUInt32BE(1, 8); const indexBody = Buffer.concat([header, entry]); writeFileSync(join(gitDir, "index"), Buffer.concat([indexBody, Buffer.from(sha1(indexBody), "hex")])); return head;
};

export const createSyntheticSelfTestHarness = async () => {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "riff-retirement-selftest-"))); const repository = join(sandbox, "repository"); mkdirSync(repository); const head = createSyntheticGitRepository(repository);
  const roots = FIXED_ROOTS.map((item) => join(repository, ...item.split("/"))); for (const root of roots) { mkdirSync(root, { recursive: true }); writeFileSync(join(root, LIFECYCLE), ""); writeFileSync(join(root, MUTATION), ""); }
  const outputParent = join(repository, ...FIXED_OUTPUT.split("/")); const controlDirectory = join(repository, FIXED_CONTROL); mkdirSync(outputParent, { recursive: true }); mkdirSync(controlDirectory);
  const modelId = ["synthetic", "retirement", "fixture"].join("-"); const modelClass = ["Synthetic", "Retirement", "Fixture"].join(""); const protocolVersion = ["synthetic", "protocol", "v1"].join("-"); const revisionId = `revision_${"a".repeat(8)}`; const runId = `execution_${"b".repeat(8)}`; const container = join(roots.find((root) => basename(root) === ".riff-workspaces"), "quarantine", "case-1"); const revision = join(container, "model", "revisions", revisionId); const run = join(container, "runs", runId); mkdirSync(revision, { recursive: true }); mkdirSync(run, { recursive: true });
  const source = Buffer.from("class SyntheticFixture:\n    pass\n"); writeFileSync(join(revision, "model.py"), source); writeSyntheticJson(join(revision, "model_schema.json"), { schema_version: 1 }); writeSyntheticJson(join(revision, "experiment_schema.json"), { schema_version: 1 }); const manifest = { model_id: modelId, model_class: modelClass, protocol_version: protocolVersion, sha256: sha256(source) }; writeSyntheticJson(join(revision, "manifest.json"), manifest);
  const request = { model_revision: revisionId, parameters: { rate: 1 }, seeds: [7], steps: 2 }; writeSyntheticJson(join(run, "request.json"), request); const metadata = { created_at: 1, finished_at: 2, model_manifest_digest: digestObject(manifest), request_digest: digestObject(request), run_id: runId, started_at: 1, status: "succeeded", timeout_seconds: 3, worker_exit_code: 0 }; writeSyntheticJson(join(run, "metadata.json"), metadata); writeFileSync(join(run, "run.log"), "synthetic\n"); writeSyntheticJson(join(run, "summary.json"), { model_id: modelId, model_revision: revisionId }); writeFileSync(join(run, "timeseries.csv"), "tick,value\n0,1\n"); mkdirSync(join(container, "model"), { recursive: true }); writeSyntheticJson(join(container, "model", "active.json"), { model_revision: revisionId, model_id: modelId, manifest_sha256: digestObject(manifest) });
  const targetPath = join(sandbox, "target.json"); const target = { schema_id: "riff://workspace-retirement/target/v1", schema_version: 1, model_id: modelId, model_class: modelClass, protocol_version: protocolVersion, revision_pattern: "^revision_[0-9a-f]{8}$", run_pattern: "^execution_[0-9a-f]{8}$", pull_request: { host: "selftest.invalid", repository: "internal/synthetic", number: 17, base_branch: "main", head_branch: "reviewed-head" } }; writeSyntheticJson(targetPath, target);
  const pristineTcb = { auditor: { path: "/internal-selftest/auditor", file_tuple: { device: 1, inode: 2 }, sha256: "a".repeat(64), import_policy_digest: "b".repeat(64) }, node_runtime: { realpath: "/internal-selftest/node", file_tuple: { device: 1, inode: 3 }, sha256: "c".repeat(64), version: "selftest", exec_argv: [], loaded_macho_closure: [], dyld_cache_identity: { platform_build: "internal-only" }, closure_digest: "d".repeat(64) } }; let tcb = structuredClone(pristineTcb); let decisions = ["APPROVED"]; let admissionRead = 0; let faultAt = null;
  const capability = { get tcb() { return tcb; }, get faultAt() { return faultAt; }, readPr(expected) { const review = decisions[Math.min(admissionRead, decisions.length - 1)]; admissionRead += 1; return { authenticated: true, host: expected.host, repository: expected.repository, number: expected.number, base_branch: expected.base_branch, head_branch: expected.head_branch, head_oid: expected.head_oid, state: "open", is_draft: false, review_decision: review }; } };
  const coreOptions = { repository, targetPath, [INTERNAL_CAPABILITY]: capability };
  const harness = {
    sandbox, repository, roots: [...roots].sort(compareBytes), outputParent, controlDirectory, targetPath, revision, run, container, head,
    async dryRun(options = {}) { faultAt = options.faultAt ?? null; return await dryRun(coreOptions); },
    async apply(report, options = {}) { faultAt = options.faultAt ?? null; const reportAPath = join(report.output_directory.canonical_realpath, REPORT_A); const approvalPath = join(report.output_directory.canonical_realpath, APPROVAL); if (!pathExists(approvalPath)) writeSyntheticJson(approvalPath, { schema_id: "riff://workspace-retirement/review-approval/v1", schema_version: 1, attempt_id: report.attempt_id, report_a_digest: report.report_digest, approved: true }); return await applyReport({ repository, reportAPath, approvalPath, [INTERNAL_CAPABILITY]: capability }); },
    setAdmissionSequence(next) { if (!Array.isArray(next) || !next.length || next.some((value) => !["APPROVED", "UNAPPROVED"].includes(value))) fail("selftest_invalid", "Synthetic admission decisions are invalid."); decisions = [...next]; admissionRead = 0; },
    driftTcb() { tcb = structuredClone(tcb); tcb.node_runtime.closure_digest = "e".repeat(64); }, restoreTcb() { tcb = structuredClone(pristineTcb); },
    resetAdmission() { decisions = ["APPROVED"]; admissionRead = 0; },
  };
  return Object.freeze(harness);
};

const parseArgs = (argv) => {
  const values = new Map(); const allowed = new Set(["--mode", "--target-json", "--report-a"]);
  for (let index = 0; index < argv.length; index += 2) { const key = argv[index]; const value = argv[index + 1]; if (!allowed.has(key) || value === undefined || values.has(key)) fail("argument_invalid", "The production CLI received an unknown, duplicate, or valueless option.", { key }); values.set(key, value); }
  const mode = values.get("--mode"); if (!['dry-run', 'apply', 'resume'].includes(mode)) fail("argument_invalid", "Mode must be dry-run, apply, or resume.");
  const expected = mode === "dry-run" ? new Set(["--mode", "--target-json"]) : new Set(["--mode", "--report-a"]); if (values.size !== expected.size || [...values.keys()].some((key) => !expected.has(key))) fail("argument_invalid", "The production CLI option set is not exact for its mode.");
  const repository = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  const reportAPath = values.get("--report-a");
  return { mode, repository, targetPath: values.get("--target-json"), reportAPath, approvalPath: reportAPath ? join(dirname(resolve(reportAPath)), APPROVAL) : undefined };
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === "dry-run") return await dryRun(options);
  if (options.mode === "apply" || options.mode === "resume") return await applyReport(options);
  fail("argument_invalid", "Mode must be dry-run, apply, or resume.");
};

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().then((result) => process.stdout.write(`${canonical(result)}\n`)).catch((error) => { const safe = error instanceof AuditError ? { code: error.code, message: error.message, details: error.details } : { code: "auditor_failed", message: "The auditor failed closed." }; process.stderr.write(`${canonical(safe)}\n`); process.exitCode = 1; });
}

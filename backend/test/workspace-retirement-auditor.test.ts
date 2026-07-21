import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, constants, copyFileSync, existsSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";
import { AuditError, createSyntheticSelfTestHarness, inspectRealTcbForSelfTest, rejectForeignCachePathForSelfTest, validateDeletionEntry } from "../../scripts/workspace-retirement-auditor.mjs";

type Harness = Awaited<ReturnType<typeof createSyntheticSelfTestHarness>>;
const temporary: string[] = [];
const harness = async (): Promise<Harness> => { const value = await createSyntheticSelfTestHarness(); temporary.push(value.sandbox); return value; };
afterEach(() => { for (const path of temporary.splice(0)) { const exact = realpathSync(path); assert.ok(exact.startsWith(`${realpathSync(tmpdir())}/riff-retirement-selftest-`)); rmSync(exact, { recursive: true, force: true }); } });
const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const sortValue = (value: any): any => Array.isArray(value) ? value.map(sortValue) : value !== null && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])])) : value;
const digestObject = (value: any): string => digest(JSON.stringify(sortValue(value)));
const reportDigest = (value: any): string => digestObject(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "report_digest")));
const writeJson = (path: string, value: unknown): void => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const reportPath = (report: any, name: string): string => join(report.output_directory.canonical_realpath, name);

test("internal harness owns three canonical temporary roots and dry-run never mutates them", async () => {
  const value = await harness(); const before = value.roots.map(digestTree); const first = await value.dryRun(); const second = await value.dryRun();
  assert.equal(value.roots.length, 3); assert.ok(value.roots.every((root) => root.startsWith(`${value.repository}/`))); assert.ok(!value.repository.startsWith(resolve(import.meta.dirname, "../..")));
  assert.notEqual(first.attempt_id, second.attempt_id); assert.notEqual(first.audit_id, second.audit_id); assert.equal(first.ambiguous_entries.length, 0); assert.equal(first.delete_entries.length, 12); assert.deepEqual(value.roots.map(digestTree), before);
});

test("apply is exact-approval bound, container-safe, and byte-idempotent", async () => {
  const value = await harness(); const report = await value.dryRun(); const result = await value.apply(report); assert.equal(result.status, "applied"); assert.equal(existsSync(value.revision), false); assert.equal(existsSync(value.run), false); assert.equal(existsSync(value.container), true);
  for (const root of value.roots) { assert.equal(existsSync(join(root, ".workspace-lifecycle.lock")), true); assert.equal(existsSync(join(root, ".workspace-mutation.lock")), true); assert.equal(existsSync(join(root, ".workspace-apply.fence")), false); }
  const frozen = readFileSync(reportPath(report, "report-b.json")); const repeated = await value.apply(report); assert.equal(repeated.status, "already_applied"); assert.equal(readFileSync(reportPath(report, "report-b.json")).equals(frozen), true);
});

test("new reverse references and summary schema drift are zero-delete pre-journal failures", async () => {
  {
    const value = await harness(); const report = await value.dryRun(); writeJson(join(value.container, "preserved.json"), { current_revision: basename(value.revision) }); await assert.rejects(() => value.apply(report), (error: AuditError) => error.code === "root_snapshot_drift"); assert.equal(existsSync(value.revision), true); assert.equal(existsSync(reportPath(report, "intent-progress.json")), false); assert.equal(existsSync(join(value.controlDirectory, ".workspace-global-apply.gate")), false);
  }
  {
    const value = await harness(); const report = await value.dryRun(); const summary = join(value.run, "summary.json"); const changed = JSON.parse(readFileSync(summary, "utf8")); changed.extra = true; writeJson(summary, changed); await assert.rejects(() => value.apply(report), (error: AuditError) => ["root_snapshot_drift", "entry_drift"].includes(error.code)); assert.equal(existsSync(value.run), true); assert.equal(existsSync(reportPath(report, "report-b.json")), false);
  }
});

test("TCB, report-A, tracked-worktree, and persistent-gate drift fail before deletion", async () => {
  {
    const value = await harness(); const report = await value.dryRun(); value.driftTcb(); await assert.rejects(() => value.apply(report), (error: AuditError) => error.code === "tcb_drift"); assert.equal(existsSync(reportPath(report, "intent-progress.json")), false);
  }
  {
    const value = await harness(); const report = await value.dryRun(); const path = reportPath(report, "report-a.json"); const changed = JSON.parse(readFileSync(path, "utf8")); changed.audit_id = "0".repeat(64); writeJson(path, changed); await assert.rejects(() => value.apply(report), (error: AuditError) => error.code === "report_a_invalid"); assert.equal(existsSync(value.revision), true);
  }
  {
    const value = await harness(); const report = await value.dryRun(); writeFileSync(join(value.repository, ".gitignore"), "changed\n"); await assert.rejects(() => value.apply(report), (error: AuditError) => ["ignore_contract_invalid", "tracked_worktree_dirty"].includes(error.code)); assert.equal(existsSync(value.revision), true);
  }
  {
    const value = await harness(); const report = await value.dryRun(); await assert.rejects(() => value.apply(report, { faultAt: "after_global_gate" }), (error: AuditError) => error.code === "injected_crash"); writeJson(join(value.controlDirectory, ".workspace-global-apply.gate"), { mismatched: true }); await assert.rejects(() => value.apply(report), (error: AuditError) => error.code === "gate_mismatch"); assert.equal(existsSync(value.revision), true);
  }
});

test("apply rejects a pathname-replaced lock even while the old inode remains locked", async () => {
  const value = await harness(); const report = await value.dryRun(); const lock = report.lifecycle_lock_proof[0].path;
  const oldHolder = openSync(lock, constants.O_RDWR | constants.O_NOFOLLOW | 0x10);
  try {
    unlinkSync(lock); writeFileSync(lock, "");
    await assert.rejects(() => value.apply(report), (error: AuditError) => error.code === "lock_proof_drift");
    assert.equal(existsSync(reportPath(report, "intent-progress.json")), false); assert.equal(existsSync(value.revision), true);
  } finally { closeSync(oldHolder); }
});

test("post-journal workspace drift aborts before mutation but remains fenced after mutation starts", async () => {
  for (const drift of ["reference", "extra"] as const) {
    const value = await harness(); const report = await value.dryRun();
    await assert.rejects(() => value.apply(report, { faultAt: "after_global_gate" }), (error: AuditError) => error.code === "injected_crash");
    if (drift === "reference") writeJson(join(value.container, "preserved.json"), { current_revision: basename(value.revision) });
    else writeFileSync(join(value.container, "unexpected.bin"), "unexpected\n");
    const result = await value.apply(report); assert.equal(result.status, "pre_mutation_aborted"); assert.equal(existsSync(value.revision), true); assert.equal(existsSync(reportPath(report, "report-b.json")), false);
    assert.equal(existsSync(join(value.controlDirectory, ".workspace-global-apply.gate")), false); assert.ok(value.roots.every((root) => !existsSync(join(root, ".workspace-apply.fence"))));
  }
  for (const drift of ["reference", "extra"] as const) {
    const value = await harness(); const report = await value.dryRun(); const first = report.delete_entries[0].exact_realpath;
    await assert.rejects(() => value.apply(report, { faultAt: `after_operation:${first}` }), (error: AuditError) => error.code === "injected_crash");
    if (drift === "reference") writeJson(join(value.container, "preserved.json"), { current_revision: basename(value.revision) });
    else writeFileSync(join(value.container, "unexpected.bin"), "unexpected\n");
    await assert.rejects(() => value.apply(report), (error: AuditError) => error.code === "persistent_recovery_drift");
    assert.equal(existsSync(reportPath(report, "report-b.json")), false); assert.equal(existsSync(join(value.controlDirectory, ".workspace-global-apply.gate")), true); assert.ok(value.roots.every((root) => existsSync(join(root, ".workspace-apply.fence")))); assert.equal(existsSync(report.delete_entries[1].exact_realpath), true);
  }
});

test("dangling and ordinary symlink guards or operations are never treated as absent", async () => {
  {
    const value = await harness(); const report = await value.dryRun(); const file = report.delete_entries.find((entry: any) => entry.file_type === "file").exact_realpath;
    await assert.rejects(() => value.apply(report, { faultAt: `before_operation:${file}` }), (error: AuditError) => error.code === "injected_crash"); unlinkSync(file); symlinkSync(join(value.sandbox, "missing-target"), file);
    await assert.rejects(() => value.apply(report), (error: AuditError) => error.code === "persistent_recovery_drift"); assert.equal(existsSync(join(value.controlDirectory, ".workspace-global-apply.gate")), true);
  }
  {
    const value = await harness(); const report = await value.dryRun(); const gate = join(value.controlDirectory, ".workspace-global-apply.gate");
    await assert.rejects(() => value.apply(report, { faultAt: "after_global_gate" }), (error: AuditError) => error.code === "injected_crash"); unlinkSync(gate); symlinkSync(join(value.sandbox, "missing-gate"), gate);
    await assert.rejects(() => value.apply(report), (error: AuditError) => ["invalid_json", "gate_mismatch", "unsafe_file"].includes(error.code)); assert.equal(existsSync(value.revision), true);
  }
  {
    const value = await harness(); const report = await value.dryRun(); const root = report.workspace_realpaths[0]; const fence = join(root, ".workspace-apply.fence");
    await assert.rejects(() => value.apply(report, { faultAt: `after_fence:${digest(root)}` }), (error: AuditError) => error.code === "injected_crash"); unlinkSync(fence); symlinkSync(join(root, ".workspace-lifecycle.lock"), fence);
    await assert.rejects(() => value.apply(report), (error: AuditError) => ["invalid_json", "gate_mismatch", "unsafe_file"].includes(error.code)); assert.equal(existsSync(value.revision), true);
  }
});

test("intent, gate, fence, delete-precheck, B, and release crash boundaries resume", async () => {
  for (const boundary of ["after_intent_commit", "after_global_gate_create", "after_global_gate"] as const) {
    const value = await harness(); const report = await value.dryRun(); await assert.rejects(() => value.apply(report, { faultAt: boundary }), (error: AuditError) => error.code === "injected_crash"); assert.equal(existsSync(value.revision), true); assert.equal((await value.apply(report)).status, "applied");
  }
  {
    const value = await harness(); const report = await value.dryRun(); const root = report.workspace_realpaths[0]; await assert.rejects(() => value.apply(report, { faultAt: `after_fence_create:${digest(root)}` }), (error: AuditError) => error.code === "injected_crash"); assert.equal((await value.apply(report)).status, "applied");
  }
  for (const phase of ["delete_after_parent_open", "delete_after_first_lstat", "delete_after_file_hash", "delete_before_unlink", "delete_after_unlink"] as const) {
    const value = await harness(); const report = await value.dryRun(); const file = report.delete_entries.find((entry: any) => entry.file_type === "file").exact_realpath; await assert.rejects(() => value.apply(report, { faultAt: `${phase}:${file}` }), (error: AuditError) => error.code === "injected_crash"); assert.equal((await value.apply(report)).status, "applied");
  }
  for (const phase of ["delete_after_directory_scan", "delete_before_rmdir", "delete_after_rmdir", "delete_after_parent_fsync"] as const) {
    const value = await harness(); const report = await value.dryRun(); const directory = report.delete_entries.find((entry: any) => entry.file_type === "directory").exact_realpath; await assert.rejects(() => value.apply(report, { faultAt: `${phase}:${directory}` }), (error: AuditError) => error.code === "injected_crash"); assert.equal((await value.apply(report)).status, "applied");
  }
  for (const boundary of ["before_report_b_write", "after_report_b_write", "after_report_b", "after_apply_completed"] as const) {
    const value = await harness(); const report = await value.dryRun(); await assert.rejects(() => value.apply(report, { faultAt: boundary }), (error: AuditError) => error.code === "injected_crash"); const frozen = existsSync(reportPath(report, "report-b.json")) ? readFileSync(reportPath(report, "report-b.json")) : null; assert.equal((await value.apply(report)).status, "applied"); if (frozen) assert.equal(readFileSync(reportPath(report, "report-b.json")).equals(frozen), true);
  }
  for (const boundary of ["fence", "global"] as const) {
    const value = await harness(); const report = await value.dryRun(); const point = boundary === "fence" ? `after_fence_unlink:${digest(report.workspace_realpaths.at(-1))}` : "after_global_unlink"; await assert.rejects(() => value.apply(report, { faultAt: point }), (error: AuditError) => error.code === "injected_crash"); assert.equal((await value.apply(report)).status, "applied");
  }
});

test("self-consistent but false B data and terminal post-state drift are rejected", async () => {
  {
    const value = await harness(); const report = await value.dryRun(); await assert.rejects(() => value.apply(report, { faultAt: "after_report_b" }), (error: AuditError) => error.code === "injected_crash"); const path = reportPath(report, "report-b.json"); const forged = JSON.parse(readFileSync(path, "utf8")); forged.post_state_scan.counts_without_fences.files += 1; forged.report_digest = reportDigest(forged); writeJson(path, forged);
    await assert.rejects(() => value.apply(report), (error: AuditError) => error.code === "report_b_invalid"); assert.equal(existsSync(join(value.controlDirectory, ".workspace-global-apply.gate")), true); assert.ok(value.roots.every((root) => existsSync(join(root, ".workspace-apply.fence"))));
  }
  {
    const value = await harness(); const report = await value.dryRun(); assert.equal((await value.apply(report)).status, "applied"); writeFileSync(join(value.roots[0], "post-terminal-drift.bin"), "drift\n");
    await assert.rejects(() => value.apply(report), (error: AuditError) => error.code === "report_b_invalid");
  }
});

test("pre-journal B admission tampering or fresh live denial retains every guard", async () => {
  {
    const value = await harness(); const report = await value.dryRun(); await assert.rejects(() => value.apply(report, { faultAt: "after_report_b_write" }), (error: AuditError) => error.code === "injected_crash"); const path = reportPath(report, "report-b.json"); const forged = JSON.parse(readFileSync(path, "utf8")); forged.github_pr.review_decision = "UNAPPROVED"; forged.github_pr.authenticated_read_digest = digestObject(Object.fromEntries(Object.entries(forged.github_pr).filter(([key]) => key !== "authenticated_read_digest"))); forged.report_digest = reportDigest(forged); writeJson(path, forged);
    await assert.rejects(() => value.apply(report), (error: AuditError) => error.code === "report_b_invalid"); assert.equal(existsSync(join(value.controlDirectory, ".workspace-global-apply.gate")), true); assert.ok(value.roots.every((root) => existsSync(join(root, ".workspace-apply.fence"))));
  }
  {
    const value = await harness(); const report = await value.dryRun(); await assert.rejects(() => value.apply(report, { faultAt: "after_report_b_write" }), (error: AuditError) => error.code === "injected_crash"); value.setAdmissionSequence(["UNAPPROVED"]);
    await assert.rejects(() => value.apply(report), (error: AuditError) => error.code === "pr_admission_denied"); assert.equal(existsSync(join(value.controlDirectory, ".workspace-global-apply.gate")), true); assert.ok(value.roots.every((root) => existsSync(join(root, ".workspace-apply.fence"))));
  }
});

test("atomic report, journal, gate, fence, and B durability boundaries fail or resume exactly", async () => {
  for (const phase of ["after_temp_write", "after_file_fsync", "after_rename", "after_parent_fsync"] as const) {
    const value = await harness(); const before = value.roots.map(digestTree); await assert.rejects(() => value.dryRun({ faultAt: `report_a:${phase}` }), (error: AuditError) => error.code === "injected_crash"); assert.deepEqual(value.roots.map(digestTree), before);
  }
  for (const label of ["journal_intent_committed", "report_b", "journal_apply_completed"] as const) for (const phase of ["after_temp_write", "after_file_fsync", "after_rename", "after_parent_fsync"] as const) {
    const value = await harness(); const report = await value.dryRun(); await assert.rejects(() => value.apply(report, { faultAt: `${label}:${phase}` }), (error: AuditError) => error.code === "injected_crash"); assert.equal((await value.apply(report)).status, "applied");
  }
  for (const phase of ["after_create", "after_file_fsync", "after_parent_fsync"] as const) {
    const value = await harness(); const report = await value.dryRun(); await assert.rejects(() => value.apply(report, { faultAt: `global_gate:${phase}` }), (error: AuditError) => error.code === "injected_crash"); assert.equal((await value.apply(report)).status, "applied");
  }
  for (const rootIndex of [0, 1, 2]) for (const phase of ["after_create", "after_file_fsync", "after_parent_fsync"] as const) {
    const value = await harness(); const report = await value.dryRun(); const rootDigest = digest(report.workspace_realpaths[rootIndex]); await assert.rejects(() => value.apply(report, { faultAt: `fence_${rootDigest}:${phase}` }), (error: AuditError) => error.code === "injected_crash"); assert.equal((await value.apply(report)).status, "applied");
  }
});

test("every cleanup journal transition is atomic across all four durability phases", async () => {
  const phases = ["after_temp_write", "after_file_fsync", "after_rename", "after_parent_fsync"] as const;
  const successStates = ["fence_removal_started", "fence_removal_completed", "release_global_gate_removal_started", "release_global_gate_removal_completed"] as const;
  for (const state of successStates) for (const phase of phases) {
    const value = await harness(); const report = await value.dryRun(); await assert.rejects(() => value.apply(report, { faultAt: `journal_${state}:${phase}` }), (error: AuditError) => error.code === "injected_crash"); assert.equal((await value.apply(report)).status, "applied");
  }
  const abortStates = ["abort_fence_removal_started", "abort_fence_removal_completed", "abort_global_gate_removal_started", "abort_global_gate_removal_completed"] as const;
  for (const state of abortStates) for (const phase of phases) {
    const value = await harness(); const report = await value.dryRun(); value.setAdmissionSequence(["APPROVED", "UNAPPROVED"]); await assert.rejects(() => value.apply(report, { faultAt: `journal_${state}:${phase}` }), (error: AuditError) => error.code === "injected_crash"); assert.equal((await value.apply(report)).status, "already_aborted"); assert.equal(existsSync(reportPath(report, "report-b.json")), false);
  }
});

test("second admission denial and abort-cleanup crashes remain permanently no-B", async () => {
  {
    const value = await harness(); const report = await value.dryRun(); value.setAdmissionSequence(["APPROVED", "UNAPPROVED"]); const result = await value.apply(report); assert.equal(result.status, "pre_mutation_aborted"); assert.equal(existsSync(value.revision), true); assert.equal(existsSync(reportPath(report, "report-b.json")), false); assert.equal((await value.apply(report)).status, "already_aborted");
  }
  for (const boundary of ["fence", "global"] as const) {
    const value = await harness(); const report = await value.dryRun(); value.setAdmissionSequence(["APPROVED", "UNAPPROVED"]); const point = boundary === "fence" ? `abort_after_fence_unlink:${digest(report.workspace_realpaths.at(-1))}` : "abort_after_global_unlink"; await assert.rejects(() => value.apply(report, { faultAt: point }), (error: AuditError) => error.code === "injected_crash"); assert.equal((await value.apply(report)).status, "already_aborted"); assert.equal(existsSync(reportPath(report, "report-b.json")), false);
  }
});

test("forged journal states and artifacts from another attempt are rejected", async () => {
  {
    const value = await harness(); const report = await value.dryRun(); await assert.rejects(() => value.apply(report, { faultAt: "after_intent_commit" }), (error: AuditError) => error.code === "injected_crash"); const path = reportPath(report, "intent-progress.json"); const forged = JSON.parse(readFileSync(path, "utf8")); forged.state = "apply_completed"; forged.history[0].state = "apply_completed"; writeJson(path, forged); await assert.rejects(() => value.apply(report), (error: AuditError) => ["journal_conflict", "journal_corrupt", "journal_digest_chain_invalid", "journal_transition_invalid"].includes(error.code)); assert.equal(existsSync(value.revision), true);
  }
  {
    const value = await harness(); const first = await value.dryRun(); await assert.rejects(() => value.apply(first, { faultAt: "after_intent_commit" }), (error: AuditError) => error.code === "injected_crash"); const second = await value.dryRun(); copyFileSync(reportPath(first, "intent-progress.json"), reportPath(second, "intent-progress.json")); await assert.rejects(() => value.apply(second), (error: AuditError) => error.code === "journal_conflict"); assert.equal(existsSync(value.revision), true);
  }
  {
    const source = await harness(); const sourceReport = await source.dryRun(); await source.apply(sourceReport); const value = await harness(); const report = await value.dryRun(); copyFileSync(reportPath(sourceReport, "report-b.json"), reportPath(report, "report-b.json")); await assert.rejects(() => value.apply(report), (error: AuditError) => error.code === "report_b_invalid"); assert.equal(existsSync(value.revision), true);
  }
});

test("production CLI rejects every synthetic or caller-selected capability", () => {
  const script = resolve(import.meta.dirname, "../../scripts/workspace-retirement-auditor.mjs");
  for (const option of ["--test-mode", "--test-tcb", "--pr-fixture", "--fault-at", "--root", "--output-parent", "--control-directory", "--approval-json"]) {
    const result = spawnSync(process.execPath, [script, option, "value"], { encoding: "utf8" }); assert.notEqual(result.status, 0); assert.match(result.stderr, /argument_invalid/u);
  }
});

test("real TCB smoke binds a nonempty native closure and dyld trust root", () => {
  const value = inspectRealTcbForSelfTest(); const dyld = value.node_runtime.dyld_cache_identity; assert.ok(value.node_runtime.loaded_macho_closure.length > 0); assert.match(value.node_runtime.closure_digest, /^[0-9a-f]{64}$/u); assert.ok(dyld.cache_resident_paths.length > 0); assert.equal(dyld.cache_image_memberships.length, dyld.cache_resident_paths.length); assert.ok(dyld.components.length > 0); assert.ok(dyld.image_path_table.image_count > 0); assert.match(dyld.image_path_table.image_paths_digest, /^[0-9a-f]{64}$/u); assert.match(dyld.image_path_table.cache_uuid, /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/u); for (const member of dyld.cache_image_memberships) { assert.equal(member.reported_path, member.image_path); assert.match(member.cache_uuid, /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/u); } for (const component of dyld.components) { assert.match(component.header_magic, /^dyld_v1\s+(?:arm64e?|x86_64h?)$/u); assert.match(component.header_uuid, /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/u); } assert.throws(() => rejectForeignCachePathForSelfTest("/foreign/missing.dylib", ["/allowed.dylib"]), (error: AuditError) => error.code === "dyld_cache_unattributable"); assert.equal(value.node_runtime.realpath, realpathSync(process.execPath));
});

test("A, B, journal, global gate, and all root fences contain no retired identity", async () => {
  const value = await harness(); const report = await value.dryRun(); await assert.rejects(() => value.apply(report, { faultAt: "after_apply_completed" }), (error: AuditError) => error.code === "injected_crash"); const retired = ["queue", "network", "v1"].join("-"); const paths = [reportPath(report, "report-a.json"), reportPath(report, "report-b.json"), reportPath(report, "intent-progress.json"), join(value.controlDirectory, ".workspace-global-apply.gate"), ...value.roots.map((root) => join(root, ".workspace-apply.fence"))]; for (const path of paths) { assert.equal(existsSync(path), true); assert.equal(readFileSync(path, "utf8").toLowerCase().includes(retired), false); }
});

test("project, quarantine, root, and unsupported leaf deletion are structurally impossible", async () => {
  const value = await harness(); const root = value.roots[0]; for (const path of [root, value.container, dirname(value.container)]) assert.throws(() => validateDeletionEntry({ exact_realpath: path, file_type: "directory", kind: "internal_directory" }, value.roots), /deletion is forbidden/u); assert.throws(() => validateDeletionEntry({ exact_realpath: join(value.container, "unknown.json"), file_type: "file", kind: "run_file" }, value.roots), /eligible leaf schema/u);
});

function digestTree(root: string): string {
  const walk = (directory: string): any[] => readdirSync(directory).sort().flatMap((name) => { const path = join(directory, name); return lstatSync(path).isDirectory() ? [[path.slice(root.length), "d"], ...walk(path)] : [[path.slice(root.length), "f", digest(readFileSync(path))]]; }); return digest(JSON.stringify(walk(root)));
}

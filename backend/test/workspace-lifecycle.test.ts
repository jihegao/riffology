import assert from "node:assert/strict";
import { closeSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";
import { DurableProjectStore } from "../src/durable-project-store.ts";
import { ApiError } from "../src/errors.ts";
import { Gate2Runtime } from "../src/gate2-runtime.ts";
import { acquireWorkspaceLockForAudit, closeWorkspaceLockForAudit, WORKSPACE_APPLY_FENCE, WORKSPACE_GLOBAL_GATE, WorkspaceLifecycle } from "../src/workspace-lifecycle.ts";

const temporary: string[] = [];
const fixture = (): { repository: string; root: string } => {
  const repository = realpathSync(mkdtempSync(join(tmpdir(), "riff-lifecycle-"))); temporary.push(repository);
  const root = join(repository, "workspace"); mkdirSync(root); return { repository, root };
};
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

test("Backend holds compatible shared lifecycle and mutation locks for its full writer lifetime", () => {
  const { repository, root } = fixture(); const store = new DurableProjectStore(root, { lifecycleRepositoryRoot: repository });
  try {
    const proof = store.workspaceLifecycleProof(); assert.equal(proof.workspace_root_realpath, root); assert.equal(proof.protocol_version, "riff-workspace-lifecycle-v1");
    const script = "import fcntl,sys; f=open(sys.argv[1],'r+b');\ntry: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB); print('acquired'); raise SystemExit(9)\nexcept BlockingIOError: raise SystemExit(0)";
    for (const path of [proof.lifecycle_lock_path, proof.mutation_lock_path]) assert.equal(spawnSync("python3", ["-c", script, path]).status, 0);
  } finally { store.close(); }
  const fd = acquireWorkspaceLockForAudit(join(root, ".workspace-lifecycle.lock"), "exclusive"); closeWorkspaceLockForAudit(fd);
});

test("Mesa/Python shared ownership conflicts with Node exclusive apply and crash releases the kernel lock", async () => {
  const { repository, root } = fixture(); const marker = join(repository, "ready");
  const script = [
    "import sys,time", `sys.path.insert(0,${JSON.stringify(resolve(import.meta.dirname, "../../mesa_service/src"))})`,
    "from mesa_service.workspace_lifecycle import WorkspaceLifecycle", "owner=WorkspaceLifecycle(sys.argv[1],sys.argv[2])", "open(sys.argv[3],'w').close()", "time.sleep(30)",
  ].join(";");
  const child = spawn("python3", ["-c", script, root, repository, marker], { stdio: "ignore" });
  try {
    const deadline = Date.now() + 5_000; while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10)); assert.equal(existsSync(marker), true);
    assert.throws(() => acquireWorkspaceLockForAudit(join(root, ".workspace-lifecycle.lock"), "exclusive"), /incompatible workspace lifecycle lock/u);
  } finally { child.kill("SIGKILL"); await new Promise((resolve) => child.once("exit", resolve)); }
  const fd = acquireWorkspaceLockForAudit(join(root, ".workspace-lifecycle.lock"), "exclusive"); closeWorkspaceLockForAudit(fd);
});

test("fixed global gate, root fence, and symlink aliases fail closed before workspace use", () => {
  const { repository, root } = fixture(); let owner = WorkspaceLifecycle.acquireShared(root, repository); owner.close();
  const control = join(repository, ".riff-control"); writeFileSync(join(control, WORKSPACE_GLOBAL_GATE), "{}\n");
  assert.throws(() => WorkspaceLifecycle.acquireShared(root, repository), /global apply gate/u);
  rmSync(join(control, WORKSPACE_GLOBAL_GATE)); writeFileSync(join(root, WORKSPACE_APPLY_FENCE), "{}\n");
  assert.throws(() => WorkspaceLifecycle.acquireShared(root, repository), /apply operation/u);
  rmSync(join(root, WORKSPACE_APPLY_FENCE)); const alias = join(repository, "workspace-alias"); symlinkSync(root, alias);
  assert.throws(() => WorkspaceLifecycle.acquireShared(alias, repository), /symlink/u);
});

const expectCode = (code: string, operation: () => unknown): void => {
  assert.throws(operation, (error: unknown) => error instanceof ApiError && error.code === code);
};

const installUnsafeEntry = (path: string, kind: "dangling_symlink" | "symlink" | "hardlink"): void => {
  const target = `${path}.target`;
  if (kind === "dangling_symlink") symlinkSync(target, path);
  else {
    writeFileSync(target, "target\n");
    if (kind === "symlink") symlinkSync(target, path);
    else linkSync(target, path);
  }
};

test("dangling symlink, symlink, and hardlink gates and fences fail closed", () => {
  for (const kind of ["dangling_symlink", "symlink", "hardlink"] as const) {
    for (const location of ["global", "root"] as const) {
      const { repository, root } = fixture(); const owner = WorkspaceLifecycle.acquireShared(root, repository); owner.close();
      const path = location === "global" ? join(repository, ".riff-control", WORKSPACE_GLOBAL_GATE) : join(root, WORKSPACE_APPLY_FENCE);
      installUnsafeEntry(path, kind);
      expectCode(location === "global" ? "workspace_global_gate_corrupt" : "workspace_root_fence_corrupt", () => WorkspaceLifecycle.acquireShared(root, repository));
    }
  }
});

test("dangling symlink, symlink, and hardlink lifecycle locks fail closed", () => {
  for (const kind of ["dangling_symlink", "symlink", "hardlink"] as const) {
    for (const name of [".workspace-lifecycle.lock", ".workspace-mutation.lock"] as const) {
      const { repository, root } = fixture(); const owner = WorkspaceLifecycle.acquireShared(root, repository); owner.close();
      const lock = join(root, name); unlinkSync(lock); installUnsafeEntry(lock, kind);
      expectCode("workspace_lock_corrupt", () => WorkspaceLifecycle.acquireShared(root, repository));
    }
  }
});

test("dangling workspace and control-directory components fail closed", () => {
  const { repository } = fixture(); const danglingRoot = join(repository, "dangling-root"); symlinkSync(join(repository, "missing-root"), danglingRoot);
  expectCode("unsafe_workspace", () => WorkspaceLifecycle.acquireShared(danglingRoot, repository));
  const second = fixture(); symlinkSync(join(second.repository, "missing-control"), join(second.repository, ".riff-control"));
  expectCode("unsafe_workspace", () => WorkspaceLifecycle.acquireShared(second.root, second.repository));
});

test("Gate2Runtime rejects global and root admission gates before evidence preload reads", () => {
  for (const location of ["global", "root"] as const) {
    const { repository, root } = fixture(); const initialized = new DurableProjectStore(root, { lifecycleRepositoryRoot: repository }); initialized.close();
    const preloadMarker = join(root, "workspace-create-events"); rmSync(preloadMarker, { recursive: true }); writeFileSync(preloadMarker, "preload must not read this non-directory\n");
    const before = Buffer.from("preload must not read this non-directory\n");
    const gate = location === "global" ? join(repository, ".riff-control", WORKSPACE_GLOBAL_GATE) : join(root, WORKSPACE_APPLY_FENCE); writeFileSync(gate, "{}\n");
    expectCode(location === "global" ? "workspace_global_gate_active" : "workspace_root_fence_active", () => new Gate2Runtime(root, {} as never));
    assert.deepEqual(requireBytes(preloadMarker), before);
  }
});

test("Gate2Runtime acquires the shared mutation lock before evidence preload reads", () => {
  const { repository, root } = fixture(); const initialized = new DurableProjectStore(root, { lifecycleRepositoryRoot: repository }); initialized.close();
  const preloadMarker = join(root, "workspace-create-events"); rmSync(preloadMarker, { recursive: true }); writeFileSync(preloadMarker, "preload must not read this non-directory\n");
  const before = Buffer.from("preload must not read this non-directory\n"); const exclusive = acquireWorkspaceLockForAudit(join(root, ".workspace-mutation.lock"), "exclusive");
  try { expectCode("workspace_lock_conflict", () => new Gate2Runtime(root, {} as never)); }
  finally { closeWorkspaceLockForAudit(exclusive); }
  assert.deepEqual(requireBytes(preloadMarker), before);
});

const requireBytes = (path: string): Buffer => {
  const result = spawnSync(process.execPath, ["-e", "process.stdout.write(require('fs').readFileSync(process.argv[1]))", path]);
  assert.equal(result.status, 0); return result.stdout;
};

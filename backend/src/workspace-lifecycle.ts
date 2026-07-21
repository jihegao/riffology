import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ApiError } from "./errors.ts";

export const WORKSPACE_LIFECYCLE_PROTOCOL = "riff-workspace-lifecycle-v1";
export const WORKSPACE_LIFECYCLE_LOCK = ".workspace-lifecycle.lock";
export const WORKSPACE_MUTATION_LOCK = ".workspace-mutation.lock";
export const WORKSPACE_APPLY_FENCE = ".workspace-apply.fence";
export const WORKSPACE_GLOBAL_GATE = ".workspace-global-apply.gate";

// Darwin exposes O_SHLOCK/O_EXLOCK to open(2), but Node does not publish names
// for them. The protocol is deliberately Darwin-only and is covered by a real
// cross-process Python flock test. Selecting a fallback would weaken the gate.
const DARWIN_O_SHLOCK = 0x10;
const DARWIN_O_EXLOCK = 0x20;

type LockMode = "shared" | "exclusive";

export type WorkspaceLifecycleProof = {
  protocol_version: typeof WORKSPACE_LIFECYCLE_PROTOCOL;
  workspace_root_realpath: string;
  lifecycle_lock_path: string;
  mutation_lock_path: string;
  control_directory_realpath: string;
};

const fail = (code: string, message: string): never => {
  throw new ApiError(503, code, message);
};

const assertDarwin = (): void => {
  if (process.platform !== "darwin") fail("workspace_lock_unsupported", "The workspace lifecycle protocol requires Darwin open-lock semantics.");
  if (constants.O_NONBLOCK !== 0x4 || !constants.O_NOFOLLOW) fail("workspace_lock_unsupported", "The runtime does not expose the required no-follow non-blocking lock flags.");
};

const lstatIfPresent = (path: string, code: string, message: string): ReturnType<typeof lstatSync> | null => {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    fail(code, message);
  }
};

const rejectSymlinkComponents = (path: string): string => {
  const candidate = resolve(path);
  let current = candidate.startsWith("/") ? "/" : "";
  for (const part of candidate.split("/").filter(Boolean)) {
    current = join(current, part);
    const stat = lstatIfPresent(current, "unsafe_workspace", "Workspace lifecycle path components could not be inspected.");
    if (!stat) continue;
    if (stat.isSymbolicLink()) fail("unsafe_workspace", "Workspace lifecycle paths must not contain symlinks.");
  }
  return candidate;
};

const assertRegularSingleLink = (path: string): void => {
  const before = lstatIfPresent(path, "workspace_lock_unavailable", "The workspace lifecycle lock could not be inspected.");
  if (!before) fail("workspace_lock_unavailable", "The workspace lifecycle lock is missing.");
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail("workspace_lock_corrupt", "A workspace lifecycle lock is not a single-link regular file.");
};

const ensureLockFile = (path: string): void => {
  const present = lstatIfPresent(path, "workspace_lock_unavailable", "The workspace lifecycle lock could not be inspected.");
  if (!present) {
    try {
      const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      closeSync(fd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") fail("workspace_lock_unavailable", "The workspace lifecycle lock could not be created safely.");
    }
  }
  assertRegularSingleLink(path);
};

const openLocked = (path: string, mode: LockMode): number => {
  assertDarwin();
  assertRegularSingleLink(path);
  const lockFlag = mode === "shared" ? DARWIN_O_SHLOCK : DARWIN_O_EXLOCK;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK | lockFlag);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EWOULDBLOCK" || code === "EAGAIN" || code === "EACCES") fail("workspace_lock_conflict", "Another process owns an incompatible workspace lifecycle lock.");
    fail("workspace_lock_unavailable", "The workspace lifecycle lock could not be acquired.");
  }
  try {
    const stat = fstatSync(fd);
    const pathStat = lstatIfPresent(path, "workspace_lock_corrupt", "The workspace lifecycle lock changed while it was acquired.");
    if (!pathStat || !stat.isFile() || stat.nlink !== 1 || stat.dev !== pathStat.dev || stat.ino !== pathStat.ino || !pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink !== 1) {
      fail("workspace_lock_corrupt", "The workspace lifecycle lock changed while it was acquired.");
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
};

const assertAdmissionOpen = (controlDirectory: string, root: string): void => {
  const globalGate = join(controlDirectory, WORKSPACE_GLOBAL_GATE);
  {
    const stat = lstatIfPresent(globalGate, "workspace_global_gate_corrupt", "The global workspace admission gate could not be inspected safely.");
    if (stat) {
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) fail("workspace_global_gate_corrupt", "The global workspace admission gate is unsafe.");
      fail("workspace_global_gate_active", "Workspace access is fenced by a global apply gate.");
    }
  }
  const rootFence = join(root, WORKSPACE_APPLY_FENCE);
  {
    const stat = lstatIfPresent(rootFence, "workspace_root_fence_corrupt", "The workspace root fence could not be inspected safely.");
    if (stat) {
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) fail("workspace_root_fence_corrupt", "The workspace root fence is unsafe.");
      fail("workspace_root_fence_active", "Workspace access is fenced by an apply operation.");
    }
  }
};

export const defaultRepositoryRoot = (): string => realpathSync(resolve(import.meta.dirname, "../.."));

export class WorkspaceLifecycle {
  readonly root: string;
  readonly controlDirectory: string;
  readonly lifecycleLockPath: string;
  readonly mutationLockPath: string;
  #lifecycleFd: number | null = null;
  #mutationFd: number | null = null;

  private constructor(root: string, controlDirectory: string, lifecycleFd: number, mutationFd: number) {
    this.root = root;
    this.controlDirectory = controlDirectory;
    this.lifecycleLockPath = join(root, WORKSPACE_LIFECYCLE_LOCK);
    this.mutationLockPath = join(root, WORKSPACE_MUTATION_LOCK);
    this.#lifecycleFd = lifecycleFd;
    this.#mutationFd = mutationFd;
  }

  static acquireShared(requestedRoot: string, repositoryRoot?: string): WorkspaceLifecycle {
    assertDarwin();
    const requested = rejectSymlinkComponents(requestedRoot);
    const productionRepository = defaultRepositoryRoot();
    const selectedRepository = repositoryRoot ?? (requested.startsWith(`${productionRepository}/`) ? productionRepository : dirname(requested));
    const repo = rejectSymlinkComponents(selectedRepository);
    const control = rejectSymlinkComponents(join(repo, ".riff-control"));
    // The global gate is checked before any workspace-root read or write.
    const initialGate = lstatIfPresent(join(control, WORKSPACE_GLOBAL_GATE), "workspace_global_gate_corrupt", "The global workspace admission gate could not be inspected safely.");
    if (initialGate) assertAdmissionOpen(control, requested);
    mkdirSync(requested, { recursive: true, mode: 0o700 });
    const root = realpathSync(requested);
    if (root !== requested) fail("unsafe_workspace", "The workspace root must be its canonical realpath.");
    mkdirSync(control, { recursive: true, mode: 0o700 });
    if (realpathSync(control) !== control) fail("unsafe_workspace", "The workspace control directory must be its canonical realpath.");
    const lifecyclePath = join(root, WORKSPACE_LIFECYCLE_LOCK);
    const mutationPath = join(root, WORKSPACE_MUTATION_LOCK);
    ensureLockFile(lifecyclePath);
    ensureLockFile(mutationPath);
    const lifecycleFd = openLocked(lifecyclePath, "shared");
    let mutationFd: number | null = null;
    try {
      assertAdmissionOpen(control, root);
      // Writers retain a shared mutation gate for their full lifetime. This is
      // intentionally stricter than transaction-only ownership and guarantees
      // that an audit snapshot cannot overlap any writer-capable process.
      mutationFd = openLocked(mutationPath, "shared");
      assertAdmissionOpen(control, root);
      return new WorkspaceLifecycle(root, control, lifecycleFd, mutationFd);
    } catch (error) {
      if (mutationFd !== null) closeSync(mutationFd);
      closeSync(lifecycleFd);
      throw error;
    }
  }

  proof(): WorkspaceLifecycleProof {
    return {
      protocol_version: WORKSPACE_LIFECYCLE_PROTOCOL,
      workspace_root_realpath: this.root,
      lifecycle_lock_path: this.lifecycleLockPath,
      mutation_lock_path: this.mutationLockPath,
      control_directory_realpath: this.controlDirectory,
    };
  }

  assertOpen(): void {
    if (this.#lifecycleFd === null) fail("workspace_lifecycle_closed", "The workspace lifecycle owner is closed.");
    assertAdmissionOpen(this.controlDirectory, this.root);
  }

  withMutation<T>(operation: () => T): T {
    this.assertOpen();
    if (this.#mutationFd === null) fail("workspace_lifecycle_closed", "The workspace mutation owner is closed.");
    assertAdmissionOpen(this.controlDirectory, this.root);
    return operation();
  }

  async withMutationAsync<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen();
    if (this.#mutationFd === null) fail("workspace_lifecycle_closed", "The workspace mutation owner is closed.");
    assertAdmissionOpen(this.controlDirectory, this.root);
    return await operation();
  }

  close(): void {
    if (this.#mutationFd !== null) closeSync(this.#mutationFd);
    this.#mutationFd = null;
    if (this.#lifecycleFd !== null) closeSync(this.#lifecycleFd);
    this.#lifecycleFd = null;
  }
}

export const acquireWorkspaceLockForAudit = (path: string, mode: LockMode): number => openLocked(path, mode);
export const closeWorkspaceLockForAudit = (fd: number): void => closeSync(fd);

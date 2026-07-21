"""Cross-language workspace admission and lifetime lock protocol."""

from __future__ import annotations

import errno
import fcntl
import os
import stat
from pathlib import Path
from typing import BinaryIO, Callable, TypeVar

PROTOCOL_VERSION = "riff-workspace-lifecycle-v1"
LIFECYCLE_LOCK = ".workspace-lifecycle.lock"
MUTATION_LOCK = ".workspace-mutation.lock"
APPLY_FENCE = ".workspace-apply.fence"
GLOBAL_GATE = ".workspace-global-apply.gate"

T = TypeVar("T")


class WorkspaceLifecycleError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _fail(code: str, message: str) -> None:
    raise WorkspaceLifecycleError(code, message)


def _absolute(path: str | Path) -> Path:
    return Path(os.path.abspath(os.fspath(path)))


def _reject_symlink_components(path: str | Path) -> Path:
    candidate = _absolute(path)
    current = Path(candidate.anchor)
    for part in candidate.parts[1:]:
        current /= part
        if os.path.lexists(current) and current.is_symlink():
            _fail("unsafe_workspace", "workspace lifecycle paths must not contain symlinks")
    return candidate


def _assert_regular_single_link(path: Path) -> None:
    try:
        info = path.lstat()
    except OSError as exc:
        raise WorkspaceLifecycleError(
            "workspace_lock_unavailable",
            "workspace lifecycle lock could not be inspected",
        ) from exc
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        _fail("workspace_lock_corrupt", "workspace lifecycle locks must be single-link regular files")


def _ensure_lock(path: Path) -> None:
    flags = os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC
    try:
        descriptor = os.open(path, flags, 0o600)
    except FileExistsError:
        pass
    except OSError as exc:
        raise WorkspaceLifecycleError(
            "workspace_lock_unavailable",
            "workspace lifecycle lock could not be created safely",
        ) from exc
    else:
        os.close(descriptor)
    _assert_regular_single_link(path)


def _open_locked(path: Path, exclusive: bool) -> BinaryIO:
    descriptor: int | None = None
    handle: BinaryIO | None = None
    try:
        descriptor = os.open(path, os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
        descriptor_info = os.fstat(descriptor)
        path_info = path.lstat()
        if (
            not stat.S_ISREG(descriptor_info.st_mode)
            or descriptor_info.st_nlink != 1
            or not stat.S_ISREG(path_info.st_mode)
            or path_info.st_nlink != 1
            or descriptor_info.st_dev != path_info.st_dev
            or descriptor_info.st_ino != path_info.st_ino
        ):
            _fail("workspace_lock_corrupt", "workspace lifecycle lock changed during acquisition")
        handle = os.fdopen(descriptor, "r+b", buffering=0)
        descriptor = None
        fcntl.flock(handle.fileno(), (fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH) | fcntl.LOCK_NB)
    except BlockingIOError as exc:
        if handle is not None:
            handle.close()
        if descriptor is not None:
            os.close(descriptor)
        raise WorkspaceLifecycleError("workspace_lock_conflict", "another process owns an incompatible workspace lifecycle lock") from exc
    except WorkspaceLifecycleError:
        if handle is not None:
            handle.close()
        if descriptor is not None:
            os.close(descriptor)
        raise
    except OSError as exc:
        if handle is not None:
            handle.close()
        if descriptor is not None:
            os.close(descriptor)
        if exc.errno == errno.ELOOP:
            raise WorkspaceLifecycleError("workspace_lock_corrupt", "workspace lifecycle lock is unsafe") from exc
        raise WorkspaceLifecycleError("workspace_lock_unavailable", "workspace lifecycle lock could not be acquired") from exc
    assert handle is not None
    try:
        descriptor_info = os.fstat(handle.fileno())
        path_info = path.lstat()
    except OSError as exc:
        handle.close()
        raise WorkspaceLifecycleError(
            "workspace_lock_unavailable",
            "workspace lifecycle lock could not be revalidated",
        ) from exc
    if (
        not stat.S_ISREG(descriptor_info.st_mode)
        or descriptor_info.st_nlink != 1
        or not stat.S_ISREG(path_info.st_mode)
        or descriptor_info.st_dev != path_info.st_dev
        or descriptor_info.st_ino != path_info.st_ino
        or path_info.st_nlink != 1
    ):
        handle.close()
        _fail("workspace_lock_corrupt", "workspace lifecycle lock changed during acquisition")
    return handle


def _assert_gate_absent(path: Path, active_code: str, corrupt_code: str) -> None:
    if not os.path.lexists(path):
        return
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        _fail(corrupt_code, "workspace admission gate is unsafe")
    _fail(active_code, "workspace access is fenced by an apply operation")


class WorkspaceLifecycle:
    """Holds shared lifecycle and mutation gates for a writer's full lifetime."""

    def __init__(self, requested_root: str | Path, repository_root: str | Path | None = None) -> None:
        requested = _reject_symlink_components(requested_root)
        production_repository = Path(__file__).resolve().parents[3]
        selected_repository = _absolute(repository_root) if repository_root is not None else (
            production_repository if requested.is_relative_to(production_repository) else requested.parent
        )
        repository = _reject_symlink_components(selected_repository)
        self.control_directory = repository / ".riff-control"
        _assert_gate_absent(
            self.control_directory / GLOBAL_GATE,
            "workspace_global_gate_active",
            "workspace_global_gate_corrupt",
        )
        requested.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.root = requested.resolve(strict=True)
        if self.root != requested:
            _fail("unsafe_workspace", "workspace root must be its canonical realpath")
        self.control_directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.control_directory.resolve(strict=True) != self.control_directory:
            _fail("unsafe_workspace", "workspace control directory must be its canonical realpath")
        self.lifecycle_lock_path = self.root / LIFECYCLE_LOCK
        self.mutation_lock_path = self.root / MUTATION_LOCK
        _ensure_lock(self.lifecycle_lock_path)
        _ensure_lock(self.mutation_lock_path)
        self._lifecycle = _open_locked(self.lifecycle_lock_path, False)
        self._mutation: BinaryIO | None = None
        try:
            self._assert_admission_open()
            self._mutation = _open_locked(self.mutation_lock_path, False)
            self._assert_admission_open()
        except Exception:
            self._lifecycle.close()
            if self._mutation is not None:
                self._mutation.close()
            raise

    def _assert_admission_open(self) -> None:
        _assert_gate_absent(
            self.control_directory / GLOBAL_GATE,
            "workspace_global_gate_active",
            "workspace_global_gate_corrupt",
        )
        _assert_gate_absent(
            self.root / APPLY_FENCE,
            "workspace_root_fence_active",
            "workspace_root_fence_corrupt",
        )

    def assert_open(self) -> None:
        if self._lifecycle.closed or self._mutation is None or self._mutation.closed:
            _fail("workspace_lifecycle_closed", "workspace lifecycle owner is closed")
        self._assert_admission_open()

    def with_mutation(self, operation: Callable[[], T]) -> T:
        self.assert_open()
        return operation()

    def proof(self) -> dict[str, str]:
        return {
            "protocol_version": PROTOCOL_VERSION,
            "workspace_root_realpath": str(self.root),
            "lifecycle_lock_path": str(self.lifecycle_lock_path),
            "mutation_lock_path": str(self.mutation_lock_path),
            "control_directory_realpath": str(self.control_directory),
        }

    def close(self) -> None:
        if self._mutation is not None and not self._mutation.closed:
            self._mutation.close()
        if not self._lifecycle.closed:
            self._lifecycle.close()

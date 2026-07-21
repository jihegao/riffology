from __future__ import annotations

import fcntl
import hashlib
import os
import subprocess
import sys
from pathlib import Path

import pytest

from mesa_service.service import MesaService, ServiceError
from mesa_service import wind_worker
from mesa_service.workspace_lifecycle import APPLY_FENCE, GLOBAL_GATE, WorkspaceLifecycle, WorkspaceLifecycleError


def test_mesa_service_holds_shared_locks_and_exposes_the_exact_root(tmp_path: Path) -> None:
    repository = tmp_path / "repo"
    root = repository / "workspace"
    repository.mkdir()
    service = MesaService(root, lifecycle_repository_root=repository)
    try:
        proof = service.workspace_lifecycle_proof()
        assert proof["workspace_root_realpath"] == str(root)
        assert proof["protocol_version"] == "riff-workspace-lifecycle-v1"
        for name in (".workspace-lifecycle.lock", ".workspace-mutation.lock"):
            with (root / name).open("r+b") as handle, pytest.raises(BlockingIOError):
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    finally:
        service.shutdown()


def test_mesa_global_gate_root_fence_and_symlink_fail_closed(tmp_path: Path) -> None:
    repository = tmp_path / "repo"
    root = repository / "workspace"
    repository.mkdir()
    owner = WorkspaceLifecycle(root, repository)
    owner.close()
    (repository / ".riff-control" / GLOBAL_GATE).write_text("{}\n")
    with pytest.raises(WorkspaceLifecycleError, match="fenced"):
        WorkspaceLifecycle(root, repository)
    (repository / ".riff-control" / GLOBAL_GATE).unlink()
    (root / APPLY_FENCE).write_text("{}\n")
    with pytest.raises(WorkspaceLifecycleError, match="fenced"):
        WorkspaceLifecycle(root, repository)
    (root / APPLY_FENCE).unlink()
    alias = repository / "alias"
    alias.symlink_to(root, target_is_directory=True)
    with pytest.raises(WorkspaceLifecycleError, match="symlink"):
        WorkspaceLifecycle(alias, repository)


def test_mesa_translates_lifecycle_admission_failure_to_stable_service_error(tmp_path: Path) -> None:
    repository = tmp_path / "repo"
    root = repository / "workspace"
    repository.mkdir()
    owner = WorkspaceLifecycle(root, repository)
    owner.close()
    (repository / ".riff-control" / GLOBAL_GATE).write_text("{}\n")
    with pytest.raises(ServiceError) as raised:
        MesaService(root, lifecycle_repository_root=repository)
    assert raised.value.code == "workspace_global_gate_active"


def test_importing_asgi_module_does_not_create_a_default_workspace(tmp_path: Path) -> None:
    environment = dict(os.environ)
    environment.pop("WORKSPACE_ROOT", None)
    result = subprocess.run(
        [sys.executable, "-c", "import mesa_service.app"],
        cwd=tmp_path,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert not (tmp_path / ".riff-workspace").exists()


def _install_unsafe_entry(path: Path, kind: str) -> None:
    target = path.with_name(f"{path.name}.target")
    if kind == "dangling_symlink":
        path.symlink_to(target)
        return
    target.write_text("target\n")
    if kind == "symlink":
        path.symlink_to(target)
    else:
        os.link(target, path)


@pytest.mark.parametrize("kind", ["dangling_symlink", "symlink", "hardlink"])
@pytest.mark.parametrize("location", ["global", "root"])
def test_mesa_unsafe_gate_and_fence_entries_fail_closed(tmp_path: Path, kind: str, location: str) -> None:
    repository = tmp_path / "repo"
    root = repository / "workspace"
    repository.mkdir()
    owner = WorkspaceLifecycle(root, repository)
    owner.close()
    path = repository / ".riff-control" / GLOBAL_GATE if location == "global" else root / APPLY_FENCE
    _install_unsafe_entry(path, kind)
    expected = "workspace_global_gate_corrupt" if location == "global" else "workspace_root_fence_corrupt"
    with pytest.raises(WorkspaceLifecycleError) as raised:
        WorkspaceLifecycle(root, repository)
    assert raised.value.code == expected


@pytest.mark.parametrize("kind", ["dangling_symlink", "symlink", "hardlink"])
@pytest.mark.parametrize("lock_name", [".workspace-lifecycle.lock", ".workspace-mutation.lock"])
def test_mesa_unsafe_lock_entries_fail_closed(tmp_path: Path, kind: str, lock_name: str) -> None:
    repository = tmp_path / "repo"
    root = repository / "workspace"
    repository.mkdir()
    owner = WorkspaceLifecycle(root, repository)
    owner.close()
    lock = root / lock_name
    lock.unlink()
    _install_unsafe_entry(lock, kind)
    with pytest.raises(WorkspaceLifecycleError) as raised:
        WorkspaceLifecycle(root, repository)
    assert raised.value.code == "workspace_lock_corrupt"


@pytest.mark.parametrize("replacement_phase", ["after_open", "after_flock"])
def test_mesa_lock_fd_revalidation_rejects_path_replacement(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, replacement_phase: str,
) -> None:
    repository = tmp_path / "repo"
    root = repository / "workspace"
    repository.mkdir()
    owner = WorkspaceLifecycle(root, repository)
    owner.close()
    lock = root / ".workspace-lifecycle.lock"
    real_open = os.open
    real_flock = fcntl.flock
    seen_flags: list[int] = []
    replaced = False

    def replace_lock() -> None:
        nonlocal replaced
        if replaced:
            return
        replaced = True
        lock.unlink()
        lock.write_bytes(b"replacement")

    def racing_open(path: str | bytes | os.PathLike[str] | os.PathLike[bytes], flags: int, mode: int = 0o777) -> int:
        descriptor = real_open(path, flags, mode)
        if Path(path) == lock and not flags & os.O_CREAT:
            seen_flags.append(flags)
            if replacement_phase == "after_open":
                replace_lock()
        return descriptor

    def racing_flock(descriptor: int, operation: int) -> None:
        real_flock(descriptor, operation)
        if replacement_phase == "after_flock":
            replace_lock()

    monkeypatch.setattr(os, "open", racing_open)
    monkeypatch.setattr(fcntl, "flock", racing_flock)
    with pytest.raises(WorkspaceLifecycleError) as raised:
        WorkspaceLifecycle(root, repository)
    assert raised.value.code == "workspace_lock_corrupt"
    assert seen_flags
    assert all(flags & os.O_NOFOLLOW and flags & os.O_CLOEXEC for flags in seen_flags)


def _tree_digest(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*"), key=lambda item: item.relative_to(root).as_posix()):
        relative = path.relative_to(root).as_posix().encode()
        info = path.lstat()
        digest.update(relative + b"\0" + str(info.st_mode).encode() + b"\0")
        if path.is_symlink():
            digest.update(os.readlink(path).encode())
        elif path.is_file():
            digest.update(path.read_bytes())
    return digest.hexdigest()


@pytest.mark.parametrize("failure", ["global_gate", "root_fence", "lock_conflict"])
def test_wind_worker_admission_failure_never_writes_workspace_or_output(tmp_path: Path, failure: str) -> None:
    repository = tmp_path / "repo"
    root = repository / "workspace"
    output = root / "projects" / "project_marker" / "run"
    repository.mkdir()
    owner = WorkspaceLifecycle(root, repository)
    owner.close()
    output.mkdir(parents=True)
    metadata = output / "metadata.json"
    original_metadata = b'{"status":"pending","sentinel":"unchanged"}\n'
    metadata.write_bytes(original_metadata)
    (output / "sentinel.bin").write_bytes(b"unchanged")
    conflict_handle = None
    if failure == "global_gate":
        (repository / ".riff-control" / GLOBAL_GATE).write_text("{}\n")
    elif failure == "root_fence":
        (root / APPLY_FENCE).write_text("{}\n")
    else:
        conflict_handle = (root / ".workspace-lifecycle.lock").open("r+b")
        fcntl.flock(conflict_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    before = _tree_digest(repository)
    try:
        result = wind_worker.main([
            "--model", str(root / "unread-model.py"),
            "--request", str(root / "unread-request.json"),
            "--output-dir", str(output),
            "--expected-request-sha256", "0" * 64,
            "--expected-model-revision-id", f"mr_{'1' * 64}",
            "--expected-experiment-revision-id", f"er_{'2' * 64}",
            "--workspace-root", str(root),
        ])
    finally:
        if conflict_handle is not None:
            fcntl.flock(conflict_handle.fileno(), fcntl.LOCK_UN)
            conflict_handle.close()
    assert result == 1
    assert metadata.read_bytes() == original_metadata
    assert _tree_digest(repository) == before

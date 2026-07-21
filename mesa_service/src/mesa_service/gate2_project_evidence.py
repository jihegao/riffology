"""Independent verification of backend-owned Gate 2 project/policy evidence."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .canonical_v2 import canonical_json_v2_bytes, prefixed_digest, require_canonical_json_v2_bytes, sha256_v2
from .gate2_contracts import Gate2ContractError, validate_policy_snapshot


EVENT_NAME = re.compile(r"^[0-9]{20}\.json$")
PROJECT_EVENT_KEYS = {
    "schema_version", "canonical_json_version", "project_id", "snapshot_revision",
    "previous_snapshot_revision", "previous_event_digest", "event_digest", "command_id", "command_digest",
    "initiator", "session_id", "actor_id", "system_component", "event_type", "record_refs", "state_patch",
    "response_status", "response_projection", "committed_at",
}
WORKSPACE_EVENT_KEYS = {
    "schema_version", "canonical_json_version", "workspace_revision", "previous_event_digest", "command_id",
    "command_digest", "project_id", "project_event_zero_digest", "project_snapshot_zero_digest",
    "initial_actor_id", "initial_actor_digest", "response_status", "response_projection", "committed_at", "event_digest",
}
ACTOR_KEYS = {
    "schema_version", "canonical_json_version", "actor_id", "actor_type", "display_name", "declared_role",
    "identity_assurance", "created_at",
}
ATTESTATION_KEYS = {
    "schema_version", "canonical_json_version", "attestation_id", "attestation_digest", "attestation_batch_id",
    "project_id", "actor_id", "actor_type", "declared_role", "identity_assurance", "subject_revision_id",
    "scope", "decision", "rationale", "issue_ids", "supersedes_attestation_id", "created_at",
}
ATTESTATION_SUMMARY_KEYS = {
    "attestation_id", "attestation_digest", "actor_id", "actor_type", "declared_role", "subject_revision_id",
    "scope", "decision", "supersedes_attestation_id",
}
ISSUE_SUMMARY_KEYS = {
    "issue_id", "subject_revision_ids", "status", "blocking", "severity", "reporter_actor_id",
    "assignee_actor_id", "latest_issue_event_id", "latest_issue_event_digest", "latest_sequence",
}
ISSUE_EVENT_KEYS = {
    "schema_version", "canonical_json_version", "issue_event_id", "project_id", "issue_id", "sequence",
    "previous_issue_event_digest", "issue_event_digest", "event_type", "actor_id", "payload", "created_at",
}
PROJECT_CANDIDATE_KEYS = {
    "schema_version", "canonical_json_version", "project_id", "display_name", "snapshot_revision",
    "phase", "current", "actor_ids", "issue_index", "attestation_index", "run_index",
    "created_at", "updated_at",
}
FRAMED_REVISION_SCHEMAS = {
    "riff://evidence-studio/decision-brief/activation-v1",
    "riff://evidence-studio/alignment-map/framed/v1",
    "riff://evidence-studio/experiment-revision/framed/v1",
}


class ProjectEvidenceError(Gate2ContractError):
    pass


def verify_indexed_project(workspace_root: Path, project_id: str) -> None:
    _verify_workspace_index(workspace_root, project_id)


def verify_cancel_tombstone_committed(
    workspace_root: Path,
    project_id: str,
    run_id: str,
    tombstone: dict[str, Any],
) -> None:
    """Prove cancellation is an exact backend-committed project transition."""

    _verify_workspace_index(workspace_root, project_id)
    events = _project_events(workspace_root / "projects" / project_id)
    tombstone_digest = tombstone["cancel_tombstone_digest"]
    target = ("cancel_tombstone", tombstone_digest, tombstone_digest)
    matches = [
        event for event in events
        if event.get("event_type") == "cancellation_requested"
        and target in {(ref["kind"], ref["id"], ref["digest"]) for ref in event["record_refs"]}
    ]
    if len(matches) != 1:
        raise ProjectEvidenceError("cancel tombstone lacks one exact committed cancellation event")
    committed = matches[0]
    if (
        committed.get("snapshot_revision") != tombstone.get("requested_at_snapshot_revision", -1) + 1
        or committed.get("previous_snapshot_revision") != tombstone.get("requested_at_snapshot_revision")
        or committed.get("command_id") != tombstone.get("cancel_command_id")
        or committed.get("command_digest") != tombstone.get("cancel_command_digest")
        or committed.get("actor_id") != tombstone.get("requested_by_actor_id")
        or committed.get("initiator") != "client"
    ):
        raise ProjectEvidenceError("cancel tombstone command provenance does not match its project event")
    snapshot = _snapshot_from_event(committed)
    runs = snapshot.get("run_index")
    if not isinstance(runs, list) or not any(
        isinstance(run, dict) and run.get("run_id") == run_id and run.get("status") == "cancellation_requested"
        for run in runs
    ):
        raise ProjectEvidenceError("committed cancellation does not bind the run state")


def _read(path: Path) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file():
        raise ProjectEvidenceError(f"committed evidence is unavailable: {path.name}")
    try:
        value = require_canonical_json_v2_bytes(path.read_bytes())
    except Exception as exc:
        raise ProjectEvidenceError(f"committed evidence is not exact canonical bytes: {path.name}") from exc
    if not isinstance(value, dict):
        raise ProjectEvidenceError(f"committed evidence must be an object: {path.name}")
    return value


def _read_revision(path: Path) -> dict[str, Any]:
    """Read a revision using its exact legacy/framed byte-level discriminator."""

    if path.is_symlink() or not path.is_file():
        raise ProjectEvidenceError(f"committed evidence is unavailable: {path.name}")
    data = path.read_bytes()
    framed_bytes = data.endswith(b"\n")
    if framed_bytes and data[:-1].endswith(b"\n"):
        raise ProjectEvidenceError(f"committed revision has more than one final LF: {path.name}")
    try:
        value = require_canonical_json_v2_bytes(data[:-1] if framed_bytes else data)
    except Exception as exc:
        raise ProjectEvidenceError(f"committed evidence is not exact canonical bytes: {path.name}") from exc
    if not isinstance(value, dict):
        raise ProjectEvidenceError(f"committed evidence must be an object: {path.name}")
    schema = value.get("schema_id")
    if (schema in FRAMED_REVISION_SCHEMAS) is not framed_bytes:
        branch = "framed" if schema in FRAMED_REVISION_SCHEMAS else "legacy"
        raise ProjectEvidenceError(f"{branch} committed revision encoding is invalid: {path.name}")
    return value


def _exact(value: dict[str, Any], keys: set[str], name: str) -> None:
    if set(value) != keys:
        raise ProjectEvidenceError(f"{name} schema is not exact")


def _snapshot_from_event(event: dict[str, Any]) -> dict[str, Any]:
    patches = event["state_patch"]
    if not isinstance(patches, list) or len(patches) != 1 or patches[0].get("op") != "replace" or patches[0].get("path") != "" or not isinstance(patches[0].get("value"), dict):
        raise ProjectEvidenceError("project event state patch is invalid")
    candidate = patches[0]["value"]
    if candidate.get("project_id") != event["project_id"] or candidate.get("snapshot_revision") != event["snapshot_revision"]:
        raise ProjectEvidenceError("project event snapshot binding is invalid")
    return candidate


def _snapshot_record(event: dict[str, Any]) -> dict[str, Any]:
    candidate = _snapshot_from_event(event)
    unsigned = {**candidate, "previous_event_digest": event["event_digest"]}
    return {**unsigned, "snapshot_digest": "sd_" + sha256_v2(unsigned)}


def _verify_workspace_index(workspace_root: Path, project_id: str) -> None:
    cache = _read(workspace_root / "workspace.json")
    _exact(cache, {"schema_version", "canonical_json_version", "project_ids", "corrupt_project_ids", "workspace_revision"}, "workspace cache")
    events_dir = workspace_root / "workspace-create-events"
    if events_dir.is_symlink() or not events_dir.is_dir():
        raise ProjectEvidenceError("workspace create-event log is unavailable")
    paths = sorted(events_dir.iterdir())
    previous = None
    membership: list[str] = []
    selected = None
    for sequence, path in enumerate(paths):
        if path.name != f"{sequence:020d}.json":
            raise ProjectEvidenceError("workspace create-event chain has a gap")
        event = _read(path)
        _exact(event, WORKSPACE_EVENT_KEYS, "workspace create event")
        if (
            event.get("schema_version") != 1
            or event.get("canonical_json_version") != "riff-canonical-json-v2"
            or event.get("workspace_revision") != sequence
            or event.get("previous_event_digest") != previous
            or event.get("event_digest") != prefixed_digest(event, field="event_digest", prefix="we_")
            or event.get("response_status") != 201
            or not isinstance(event.get("response_projection"), dict)
            or not isinstance(event.get("project_id"), str)
            or event["project_id"] in membership
        ):
            raise ProjectEvidenceError("workspace create-event chain is corrupt")
        membership.append(event["project_id"])
        previous = event["event_digest"]
        if event["project_id"] == project_id:
            selected = event
    if cache.get("schema_version") != 1 or cache.get("canonical_json_version") != "riff-canonical-json-v2" or cache.get("project_ids") != sorted(membership) or cache.get("corrupt_project_ids") != [] or cache.get("workspace_revision") != len(paths) - 1:
        raise ProjectEvidenceError("workspace cache does not match committed create events")
    if selected is None:
        raise ProjectEvidenceError("project is not named by the workspace create-event log")
    project_dir = workspace_root / "projects" / project_id
    event_zero = _project_events(project_dir)[0]
    actor = _read(project_dir / "actors" / f"{selected['initial_actor_id']}.json")
    candidate = _snapshot_from_event(event_zero)
    expected_response = {
        "project": {
            "project_id": project_id,
            "display_name": candidate.get("display_name"),
            "snapshot_revision": 0,
        },
        "initial_actor": actor,
    }
    expected_actor_ref = [{"kind": "actor", "id": actor.get("actor_id"), "digest": "adr_" + sha256_v2(actor)}]
    current = candidate.get("current")
    if (
        selected["project_event_zero_digest"] != event_zero.get("event_digest")
        or selected["project_snapshot_zero_digest"] != _snapshot_record(event_zero).get("snapshot_digest")
        or selected["initial_actor_digest"] != "adr_" + sha256_v2(actor)
        or actor.get("actor_id") != selected["initial_actor_id"]
        or set(candidate) != PROJECT_CANDIDATE_KEYS
        or candidate.get("schema_version") != 1
        or candidate.get("canonical_json_version") != "riff-canonical-json-v2"
        or candidate.get("snapshot_revision") != 0
        or candidate.get("phase") != "brief"
        or not isinstance(candidate.get("display_name"), str) or not candidate["display_name"]
        or current != {
            "decision_brief_revision_id": None, "alignment_map_revision_id": None,
            "model_revision_id": None, "experiment_revision_id": None, "run_id": None,
        }
        or candidate.get("actor_ids") != [actor.get("actor_id")]
        or candidate.get("issue_index") != []
        or candidate.get("attestation_index") != []
        or candidate.get("run_index") != []
        or actor.get("actor_type") != "human"
        or actor.get("declared_role") != "project_owner"
        or actor.get("identity_assurance") != "declared_unauthenticated_local"
        or event_zero.get("record_refs") != expected_actor_ref
        or event_zero.get("response_projection") != expected_response
        or selected.get("response_projection") != expected_response
        or selected.get("response_status") != event_zero.get("response_status")
        or selected.get("command_id") != event_zero.get("command_id")
        or selected.get("command_digest") != event_zero.get("command_digest")
        or selected.get("committed_at") != event_zero.get("committed_at")
    ):
        raise ProjectEvidenceError("workspace-to-project creation links are corrupt")


def _project_events(project_dir: Path) -> list[dict[str, Any]]:
    directory = project_dir / "project-events"
    if directory.is_symlink() or not directory.is_dir():
        raise ProjectEvidenceError("project event log is unavailable")
    paths = sorted(directory.iterdir())
    events: list[dict[str, Any]] = []
    previous = None
    for sequence, path in enumerate(paths):
        if path.name != f"{sequence:020d}.json":
            raise ProjectEvidenceError("project event chain has a gap")
        event = _read(path)
        _exact(event, PROJECT_EVENT_KEYS, "project event")
        if (
            event.get("schema_version") != 1
            or event.get("canonical_json_version") != "riff-canonical-json-v2"
            or event.get("snapshot_revision") != sequence
            or event.get("previous_snapshot_revision") != (None if sequence == 0 else sequence - 1)
            or event.get("previous_event_digest") != previous
            or event.get("event_digest") != prefixed_digest(event, field="event_digest", prefix="pe_")
            or not isinstance(event.get("response_status"), int)
            or isinstance(event.get("response_status"), bool)
            or not 100 <= event["response_status"] <= 599
            or not isinstance(event.get("response_projection"), dict)
        ):
            raise ProjectEvidenceError("project event chain is corrupt")
        _snapshot_from_event(event)
        refs = event.get("record_refs")
        if not isinstance(refs, list) or any(not isinstance(ref, dict) or set(ref) != {"kind", "id", "digest"} for ref in refs):
            raise ProjectEvidenceError("project event record refs are invalid")
        provenance_valid = (
            event.get("initiator") == "workspace_create"
            and sequence == 0
            and event.get("session_id") is None
            and event.get("actor_id") is not None
            and event.get("system_component") is None
        ) or (
            event.get("initiator") == "client"
            and sequence > 0
            and event.get("session_id") is not None
            and event.get("actor_id") is not None
            and event.get("system_component") is None
        ) or (
            event.get("initiator") == "system"
            and sequence > 0
            and event.get("session_id") is None
            and event.get("actor_id") is None
            and event.get("system_component") in {"backend_run_reconciler", "backend_model_reconciler"}
        )
        if not provenance_valid:
            raise ProjectEvidenceError("project event initiator provenance is invalid")
        events.append(event)
        previous = event["event_digest"]
    if not events or events[0].get("event_type") != "project.created" or events[0].get("initiator") != "workspace_create" or events[0].get("session_id") is not None or events[0].get("actor_id") is None or events[0].get("system_component") is not None or events[0].get("response_status") != 201:
        raise ProjectEvidenceError("project event zero is not a committed project.created event")
    return events


def _committed_refs(events: list[dict[str, Any]], through: int) -> set[tuple[str, str, str]]:
    return {
        (ref["kind"], ref["id"], ref["digest"])
        for event in events[: through + 1]
        for ref in event["record_refs"]
    }


def _actor(project_dir: Path, actor_id: str, refs: set[tuple[str, str, str]]) -> dict[str, Any]:
    actor = _read(project_dir / "actors" / f"{actor_id}.json")
    _exact(actor, ACTOR_KEYS, "actor")
    digest = "adr_" + sha256_v2(actor)
    if actor.get("actor_id") != actor_id or actor.get("actor_type") not in {"human", "agent"} or actor.get("declared_role") not in {"project_owner", "reviewer", "operator", "assistant"} or actor.get("identity_assurance") != "declared_unauthenticated_local" or ("actor", actor_id, digest) not in refs:
        raise ProjectEvidenceError("actor is not an exact committed local identity")
    return actor


def _issue(project_dir: Path, summary: dict[str, Any], refs: set[tuple[str, str, str]], actors: dict[str, dict[str, Any]]) -> dict[str, Any]:
    _exact(summary, ISSUE_SUMMARY_KEYS, "issue summary")
    issue_id = summary.get("issue_id")
    if not isinstance(issue_id, str) or re.fullmatch(r"issue_[0-9a-f]{32}", issue_id) is None:
        raise ProjectEvidenceError("issue identity is invalid")
    previous = None
    status = "open"
    opened = None
    assignee = None
    for sequence in range(summary.get("latest_sequence", -1) + 1):
        event = _read(project_dir / "issues" / issue_id / "events" / f"{sequence:020d}.json")
        _exact(event, ISSUE_EVENT_KEYS, "issue event")
        digest = prefixed_digest(event, field="issue_event_digest", prefix="ied_")
        if (
            event.get("project_id") != project_dir.name
            or event.get("issue_id") != issue_id
            or event.get("sequence") != sequence
            or event.get("previous_issue_event_digest") != previous
            or event.get("issue_event_digest") != digest
            or ("issue_event", event.get("issue_event_id"), digest) not in refs
            or event.get("actor_id") not in actors
        ):
            raise ProjectEvidenceError("issue event is uncommitted or corrupt")
        if sequence == 0:
            if event.get("event_type") != "opened" or not isinstance(event.get("payload"), dict):
                raise ProjectEvidenceError("issue does not begin with opened")
            opened = event["payload"]
            assignee = opened.get("assignee_actor_id")
        elif event["event_type"] == "assigned":
            assignee = event["payload"].get("assignee_actor_id")
        elif event["event_type"] == "resolved":
            status = "resolved"
        elif event["event_type"] == "closed":
            status = "closed"
        elif event["event_type"] == "reopened":
            status = "open"
        previous = digest
    if not opened or (
        summary.get("latest_issue_event_digest") != previous
        or summary.get("latest_issue_event_id") != event.get("issue_event_id")
        or summary.get("status") != status
        or summary.get("assignee_actor_id") != assignee
        or summary.get("subject_revision_ids") != opened.get("subject_revision_ids")
        or summary.get("blocking") is not opened.get("blocking")
        or summary.get("severity") != opened.get("severity")
        or summary.get("reporter_actor_id") != opened.get("reporter_actor_id")
    ):
        raise ProjectEvidenceError("issue head drifted from its committed event chain")
    return summary


def derive_policy_from_committed_events(
    workspace_root: Path,
    project_id: str,
    expected_policy: dict[str, Any],
    *,
    run_intent_digest: str,
    run_admission_digest: str,
) -> dict[str, Any]:
    """Recompute the exact historical policy and prove the run DAG was committed."""

    _verify_workspace_index(workspace_root, project_id)
    project_dir = workspace_root / "projects" / project_id
    events = _project_events(project_dir)
    if any(event.get("project_id") != project_id for event in events):
        raise ProjectEvidenceError("project event belongs to a different project")
    base = expected_policy.get("evaluated_at_snapshot_revision")
    if not isinstance(base, int) or isinstance(base, bool) or not 0 <= base < len(events):
        raise ProjectEvidenceError("policy base event is unavailable")
    if events[base]["event_digest"] != expected_policy.get("evaluated_project_event_digest"):
        raise ProjectEvidenceError("policy base event digest does not match")
    snapshot = _snapshot_from_event(events[base])
    if snapshot.get("project_id") != project_id:
        raise ProjectEvidenceError("policy snapshot belongs to a different project")
    current = snapshot.get("current")
    if not isinstance(current, dict) or current.get("alignment_map_revision_id") != expected_policy.get("alignment", {}).get("subject_revision_id") or current.get("experiment_revision_id") != expected_policy.get("experiment", {}).get("subject_revision_id"):
        raise ProjectEvidenceError("policy subjects are not the exact committed current revisions")
    refs = _committed_refs(events, base)
    all_refs = _committed_refs(events, len(events) - 1)
    if not any(
        event.get("event_type") == "run.intent_committed"
        and ("run_intent", run_intent_digest, run_intent_digest) in {(ref["kind"], ref["id"], ref["digest"]) for ref in event["record_refs"]}
        and ("run_admission", run_admission_digest, run_admission_digest) in {(ref["kind"], ref["id"], ref["digest"]) for ref in event["record_refs"]}
        and ("policy_snapshot", expected_policy["policy_snapshot_digest"], expected_policy["policy_snapshot_digest"]) in {(ref["kind"], ref["id"], ref["digest"]) for ref in event["record_refs"]}
        for event in events[base + 1 :]
    ):
        raise ProjectEvidenceError("run policy/admission/intent DAG is not committed")

    actor_ids = snapshot.get("actor_ids")
    if not isinstance(actor_ids, list) or actor_ids != sorted(set(actor_ids)):
        raise ProjectEvidenceError("snapshot actor index is invalid")
    actors = {actor_id: _actor(project_dir, actor_id, refs) for actor_id in actor_ids}

    issues_raw = snapshot.get("issue_index")
    if not isinstance(issues_raw, list):
        raise ProjectEvidenceError("snapshot issue index is invalid")
    issues = [_issue(project_dir, issue, refs, actors) for issue in issues_raw]

    attestations_raw = snapshot.get("attestation_index")
    if not isinstance(attestations_raw, list):
        raise ProjectEvidenceError("snapshot attestation index is invalid")
    attestations: list[dict[str, Any]] = []
    by_id: dict[str, dict[str, Any]] = {}
    superseded_by: dict[str, str] = {}
    for summary in attestations_raw:
        if not isinstance(summary, dict):
            raise ProjectEvidenceError("attestation summary is invalid")
        _exact(summary, ATTESTATION_SUMMARY_KEYS, "attestation summary")
        attestation_id = summary.get("attestation_id")
        record = _read(project_dir / "attestations" / f"{attestation_id}.json")
        _exact(record, ATTESTATION_KEYS, "attestation")
        digest = prefixed_digest(record, field="attestation_digest", prefix="atd_")
        actor = actors.get(record.get("actor_id"))
        projection = {key: record[key] for key in ATTESTATION_SUMMARY_KEYS}
        if (
            record.get("project_id") != project_id
            or record.get("attestation_id") != attestation_id
            or record.get("attestation_digest") != digest
            or projection != summary
            or actor is None
            or record.get("actor_type") != actor["actor_type"]
            or record.get("declared_role") != actor["declared_role"]
            or record.get("identity_assurance") != actor["identity_assurance"]
            or ("attestation", attestation_id, digest) not in refs
        ):
            raise ProjectEvidenceError("attestation is fabricated, uncommitted, or actor-forged")
        if attestation_id in by_id:
            raise ProjectEvidenceError("attestation index contains a duplicate")
        by_id[attestation_id] = record
        attestations.append(record)
    for record in attestations:
        prior_id = record["supersedes_attestation_id"]
        if prior_id is None:
            continue
        prior = by_id.get(prior_id)
        if prior is None or prior_id in superseded_by or any(record[key] != prior[key] for key in ("actor_id", "subject_revision_id", "scope")):
            raise ProjectEvidenceError("attestation supersession head is invalid")
        superseded_by[prior_id] = record["attestation_id"]

    subjects = (expected_policy["alignment"]["subject_revision_id"], expected_policy["experiment"]["subject_revision_id"])
    alignment_record = _read_revision(project_dir / "alignment" / "requirement-map" / "revisions" / subjects[0] / "revision.json")
    experiment_record = _read_revision(project_dir / "experiments" / "revisions" / subjects[1] / "experiment.json")

    def exact_revision(
        record: dict[str, Any], *, subject: str, kind: str, id_field: str, id_prefix: str,
        framed_schema: str, framed_keys: set[str], digest_field: str, digest_prefix: str,
        legacy_id_field: str | None = None,
    ) -> bool:
        if record.get("schema_id") != framed_schema:
            field = legacy_id_field or id_field
            computed = id_prefix + sha256_v2({key: value for key, value in record.items() if key != field})
            if record.get("project_id") != project_id or record.get(field) != subject or computed != subject or (kind, subject, subject) not in refs:
                raise ProjectEvidenceError("legacy policy subject revision is not exact committed project evidence")
            return False
        _exact(record, framed_keys, f"framed {kind}")
        id_preimage = {key: value for key, value in record.items() if key not in {id_field, digest_field}}
        digest_preimage = {key: value for key, value in record.items() if key != digest_field}
        digest = digest_prefix + sha256_v2(digest_preimage)
        if (
            record.get("schema_version") != 1
            or record.get("canonical_json_version") != "riff-canonical-json-v2"
            or record.get("project_id") != project_id
            or record.get(id_field) != subject
            or id_prefix + sha256_v2(id_preimage) != subject
            or record.get(digest_field) != digest
            or (kind, subject, digest) not in refs
        ):
            raise ProjectEvidenceError("framed policy subject revision is not exact committed project evidence")
        return True

    alignment_framed = exact_revision(
        alignment_record, subject=subjects[0], kind="alignment_map_revision",
        id_field="alignment_revision_id", id_prefix="amr_",
        framed_schema="riff://evidence-studio/alignment-map/framed/v1",
        framed_keys={"schema_id", "schema_version", "canonical_json_version", "project_id", "alignment_revision_id", "alignment_digest", "parent_alignment_revision_id", "brief_revision_id", "model_revision_id", "migration_rule", "mappings", "gaps", "source_refs", "created_by_actor_id", "created_at"},
        digest_field="alignment_digest", digest_prefix="amd_",
        legacy_id_field="alignment_map_revision_id",
    )
    experiment_framed = exact_revision(
        experiment_record, subject=subjects[1], kind="experiment_revision",
        id_field="experiment_revision_id", id_prefix="er_",
        framed_schema="riff://evidence-studio/experiment-revision/framed/v1",
        framed_keys={"schema_id", "schema_version", "canonical_json_version", "project_id", "parent_experiment_revision_id", "operation", "model_id", "model_revision_id", "brief_revision_id", "alignment_revision_id", "preset_id", "defaults_digest", "parameter_defaults", "parameters", "parameter_diff", "execution_defaults", "execution_values", "execution_diff", "runtime_profile", "copy_migration_rule", "created_by_actor_id", "created_at", "experiment_revision_id", "experiment_digest"},
        digest_field="experiment_digest", digest_prefix="erd_",
    )
    if alignment_framed is not experiment_framed:
        raise ProjectEvidenceError("policy subjects mix legacy and framed revision branches")
    if alignment_framed:
        brief_id = experiment_record.get("brief_revision_id")
        if not isinstance(brief_id, str):
            raise ProjectEvidenceError("framed experiment brief identity is invalid")
        brief_record = _read_revision(project_dir / "alignment" / "decision-brief" / "revisions" / brief_id / "revision.json")
        exact_revision(
            brief_record, subject=brief_id, kind="decision_brief_revision",
            id_field="decision_brief_revision_id", id_prefix="dbr_",
            framed_schema="riff://evidence-studio/decision-brief/activation-v1",
            framed_keys={"schema_id", "schema_version", "canonical_json_version", "project_id", "decision_brief_revision_id", "decision_brief_digest", "parent_brief_revision_id", "source_brief_revision_id", "operation", "copy_rule", "content", "created_by_actor_id", "created_at"},
            digest_field="decision_brief_digest", digest_prefix="dbrd_",
        )
        from .gate2_contracts import validate_experiment_framed

        validate_experiment_framed(experiment_record)
        if (
            current.get("decision_brief_revision_id") != brief_id
            or current.get("model_revision_id") != experiment_record.get("model_revision_id")
            or alignment_record.get("brief_revision_id") != brief_id
            or alignment_record.get("model_revision_id") != current.get("model_revision_id")
            or alignment_record.get("migration_rule") != "framed_alignment_rebind_v1"
            or experiment_record.get("alignment_revision_id") != subjects[0]
        ):
            raise ProjectEvidenceError("framed policy subject lineage is inconsistent")

    def subject_policy(subject: str) -> dict[str, Any]:
        effective = [record for record in attestations if record["subject_revision_id"] == subject and record["attestation_id"] not in superseded_by]
        effective.sort(key=lambda item: item["attestation_id"])
        refs_projection = [
            {key: record[key] for key in ("attestation_id", "attestation_digest", "actor_id", "actor_type", "declared_role", "scope", "decision")}
            for record in effective
        ]
        endorsements = [
            record["attestation_id"] for record in effective
            if actors[record["actor_id"]]["actor_type"] == "human"
            and actors[record["actor_id"]]["declared_role"] == "project_owner"
            and record["scope"] == "workflow_progression" and record["decision"] == "endorse"
        ]
        endorsement_count = len({record["actor_id"] for record in effective if record["attestation_id"] in endorsements})
        opened = sorted((issue for issue in issues if issue["status"] == "open" and subject in issue["subject_revision_ids"]), key=lambda item: item["issue_id"])
        blocking = [issue["issue_id"] for issue in opened if issue["blocking"]]
        nonblocking = [issue["issue_id"] for issue in opened if not issue["blocking"]]
        return {
            "subject_revision_id": subject,
            "effective_attestation_refs": refs_projection,
            "human_project_owner_endorsement_attestation_ids": endorsements,
            "human_project_owner_endorsement_count": endorsement_count,
            "open_issue_refs": [{"issue_id": issue["issue_id"], "latest_issue_event_digest": issue["latest_issue_event_digest"], "blocking": issue["blocking"]} for issue in opened],
            "open_issue_ids": [issue["issue_id"] for issue in opened],
            "open_issue_count": len(opened),
            "open_blocking_issue_ids": blocking,
            "open_blocking_issue_count": len(blocking),
            "open_non_blocking_issue_ids": nonblocking,
            "open_non_blocking_issue_count": len(nonblocking),
            "policy_satisfied": endorsement_count >= 1 and not blocking,
            "wording": "no_recorded_open_objection" if not opened else "recorded_open_objection",
        }

    alignment = subject_policy(subjects[0])
    experiment = subject_policy(subjects[1])
    derived = {
        "schema_version": 1,
        "canonical_json_version": "riff-canonical-json-v2",
        "policy_snapshot_digest": "",
        "project_id": project_id,
        "evaluated_at_snapshot_revision": base,
        "evaluated_project_event_digest": events[base]["event_digest"],
        "alignment": alignment,
        "experiment": experiment,
        "combined_policy_satisfied": alignment["policy_satisfied"] and experiment["policy_satisfied"],
        "effective_attestation_ids": sorted({ref["attestation_id"] for item in (alignment, experiment) for ref in item["effective_attestation_refs"]}),
        "open_issue_ids": sorted(set(alignment["open_issue_ids"]) | set(experiment["open_issue_ids"])),
    }
    derived["policy_snapshot_digest"] = prefixed_digest(derived, field="policy_snapshot_digest", prefix="ps_")
    validate_policy_snapshot(derived)
    if canonical_json_v2_bytes(derived) != canonical_json_v2_bytes(expected_policy):
        raise ProjectEvidenceError("policy snapshot differs from independently replayed committed evidence")
    # Silence an accidental unused-set regression: all refs are intentionally
    # read, while the exact run DAG commitment is checked above.
    if not all_refs:
        raise ProjectEvidenceError("project has no committed record evidence")
    return derived

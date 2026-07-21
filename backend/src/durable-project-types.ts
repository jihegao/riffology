import type { CanonicalJsonScalar } from "./canonical-json-v2.ts";

export type DurableProjectPhase = "brief" | "align" | "configure" | "review" | "run" | "inspect";
export type ActorType = "human" | "agent";
export type DeclaredRole = "project_owner" | "reviewer" | "operator" | "assistant";

export type DeclaredLocalActor = {
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  actor_id: string;
  actor_type: ActorType;
  display_name: string;
  declared_role: DeclaredRole;
  identity_assurance: "declared_unauthenticated_local";
  created_at: string;
};

export type SourceRef = { source_id: string; kind: "user_declared" | "bundled_reference" | "uploaded_file"; label: string; attachment_id?: string };
export type DecisionBriefRevision = {
  schema_version: 1; canonical_json_version: "riff-canonical-json-v2"; decision_brief_revision_id: string; project_id: string;
  parent_decision_brief_revision_id: string | null; operation: "create" | "revise"; question: string; decision_owner: string;
  objective: string; constraints: Array<{ id: string; statement: string; source: SourceRef }>;
  assumptions: Array<{ id: string; statement: string; source: SourceRef }>; non_goals: string[]; sources: SourceRef[];
  created_by_actor_id: string; created_at: string;
};
export type AlignmentMapRevision = {
  schema_version: 1; canonical_json_version: "riff-canonical-json-v2"; alignment_map_revision_id: string; project_id: string;
  parent_alignment_map_revision_id: string | null; operation: "create" | "revise"; decision_brief_revision_id: string;
  model_id: "wind-turbine-maintenance"; model_revision_id: string;
  entries: Array<{ mapping_id: string; business_ref: string; mapping_kind: "requirement" | "assumption" | "constraint" | "non_goal"; model_refs: string[]; rationale: string; source: SourceRef }>;
  known_gaps: Array<{ gap_id: string; statement: string; blocking: boolean }>; created_by_actor_id: string; created_at: string;
};
export type RuntimeProfile = Record<string, CanonicalJsonScalar>;
export type ExperimentRevision = {
  schema_version: 2; canonical_json_version: "riff-canonical-json-v2"; experiment_revision_id: string; project_id: string;
  parent_experiment_revision_id: string | null; operation: "create" | "edit" | "reset_defaults";
  model_id: "wind-turbine-maintenance"; model_revision_id: string; brief_revision_id: string; alignment_revision_id: string;
  preset_id: string; defaults_digest: string; parameter_defaults: Record<string, CanonicalJsonScalar>; parameters: Record<string, CanonicalJsonScalar>;
  parameter_diff: Array<{ parameter_id: string; default_value: CanonicalJsonScalar; current_value: CanonicalJsonScalar }>;
  execution_defaults: ExecutionValues; execution_values: ExecutionValues;
  execution_diff: Array<{ field: keyof ExecutionValues; default_value: number; current_value: number }>;
  runtime_profile: RuntimeProfile; created_by_actor_id: string; created_at: string;
};
export type ExecutionValues = { horizon_days: number; warmup_days: number; seed: number };

export type IssueStatus = "open" | "resolved" | "closed";
export type IssueSummary = { issue_id: string; subject_revision_ids: string[]; status: IssueStatus; blocking: boolean; severity: "info" | "warning" | "critical"; reporter_actor_id: string; assignee_actor_id: string | null; latest_issue_event_id: string; latest_issue_event_digest: string; latest_sequence: number };
export type IssueEvent = { schema_version: 1; canonical_json_version: "riff-canonical-json-v2"; issue_event_id: string; project_id: string; issue_id: string; sequence: number; previous_issue_event_digest: string | null; issue_event_digest: string; event_type: "opened" | "commented" | "assigned" | "resolved" | "closed" | "reopened"; actor_id: string; payload: Record<string, unknown>; created_at: string };
export type Attestation = { schema_version: 1; canonical_json_version: "riff-canonical-json-v2"; attestation_id: string; attestation_digest: string; attestation_batch_id: string; project_id: string; actor_id: string; actor_type: ActorType; declared_role: DeclaredRole; identity_assurance: "declared_unauthenticated_local"; subject_revision_id: string; scope: "workflow_progression" | "technical_review" | "other"; decision: "endorse" | "object" | "abstain"; rationale: string; issue_ids: string[]; supersedes_attestation_id: string | null; created_at: string };
export type AttestationSummary = Pick<Attestation, "attestation_id" | "attestation_digest" | "actor_id" | "actor_type" | "declared_role" | "subject_revision_id" | "scope" | "decision" | "supersedes_attestation_id">;

export type SubjectPolicy = { subject_revision_id: string; effective_attestation_refs: Array<Pick<Attestation, "attestation_id" | "attestation_digest" | "actor_id" | "actor_type" | "declared_role" | "scope" | "decision">>; human_project_owner_endorsement_attestation_ids: string[]; human_project_owner_endorsement_count: number; open_issue_refs: Array<{ issue_id: string; latest_issue_event_digest: string; blocking: boolean }>; open_issue_ids: string[]; open_issue_count: number; open_blocking_issue_ids: string[]; open_blocking_issue_count: number; open_non_blocking_issue_ids: string[]; open_non_blocking_issue_count: number; policy_satisfied: boolean; wording: "no_recorded_open_objection" | "recorded_open_objection" };
export type PolicySnapshot = { schema_version: 1; canonical_json_version: "riff-canonical-json-v2"; policy_snapshot_digest: string; project_id: string; evaluated_at_snapshot_revision: number; evaluated_project_event_digest: string; alignment: SubjectPolicy; experiment: SubjectPolicy; combined_policy_satisfied: boolean; effective_attestation_ids: string[]; open_issue_ids: string[] };

export type RunAdmission = { schema_version: 1; canonical_json_version: "riff-canonical-json-v2"; run_admission_digest: string; project_id: string; run_id: string; model_id: "wind-turbine-maintenance"; model_revision_id: string; brief_revision_id: string; alignment_revision_id: string; experiment_revision_id: string; experiment_sha256: string; policy_snapshot: PolicySnapshot; policy_snapshot_digest: string; visibility: "private_draft"; trust_label: "draft_unverified"; workflow_label: "workflow_policy_met" | "workflow_policy_unmet"; admission_base_snapshot_revision: number; admission_base_project_event_digest: string; created_at: string };
export type RunIntent = { schema_version: 1; canonical_json_version: "riff-canonical-json-v2"; run_intent_digest: string; project_id: string; run_id: string; command_id: string; command_digest: string; downstream_idempotency_key: string; downstream_request_digest: string; model_id: "wind-turbine-maintenance"; model_revision_id: string; brief_revision_id: string; alignment_revision_id: string; experiment_revision_id: string; experiment_sha256: string; policy_snapshot_digest: string; run_admission_digest: string; created_at: string };
export type CancelTombstone = { schema_version: 1; canonical_json_version: "riff-canonical-json-v2"; cancel_tombstone_digest: string; project_id: string; run_id: string; cancel_command_id: string; cancel_command_digest: string; requested_by_actor_id: string; requested_at_snapshot_revision: number; created_at: string };

export type RunReferenceIdentity = { project_id: string; run_id: string; model_id: "wind-turbine-maintenance"; model_revision_id: string; brief_revision_id: string; alignment_revision_id: string; experiment_revision_id: string; preset_id: string; seed: number; visibility: "private_draft"; trust_label: "draft_unverified"; workflow_label: "workflow_policy_met" | "workflow_policy_unmet"; policy_snapshot_digest: string; run_admission_digest: string; run_intent_digest: string };
export type PendingRunReference = RunReferenceIdentity & { reference_kind: "pending"; status: "dispatch_pending" | "queued" | "running" | "cancellation_requested" };
export type TerminalRunReference = RunReferenceIdentity & ({ reference_kind: "terminal"; status: "succeeded"; terminal_evidence_source: "mesa_terminal_metadata"; terminal_metadata_digest: string; verified_success: true; artifact_ids: string[]; cancel_outcome: null | "completed_before_cancel_effect" } | { reference_kind: "terminal"; status: "failed"; terminal_evidence_source: "mesa_terminal_metadata" | "local_run_terminal_evidence"; terminal_metadata_digest: string; verified_success: false; cancel_outcome: null | "failed_before_cancel_effect" } | { reference_kind: "terminal"; status: "timed_out"; terminal_evidence_source: "mesa_terminal_metadata"; terminal_metadata_digest: string; verified_success: false; cancel_outcome: null | "timed_out_before_cancel_effect" } | { reference_kind: "terminal"; status: "cancelled"; terminal_evidence_source: "mesa_terminal_metadata" | "local_run_terminal_evidence"; terminal_metadata_digest: string; verified_success: false; cancel_outcome: "cancelled_before_dispatch" | "cancelled_by_worker" });
export type RunReference = PendingRunReference | TerminalRunReference;
export type LocalRunTerminalEvidence = { schema_version: 1; canonical_json_version: "riff-canonical-json-v2"; local_terminal_evidence_digest: string; project_id: string; run_id: string; terminal_status: "cancelled" | "failed"; outcome_code: "cancelled_before_dispatch" | "pre_receipt_admission_failed" | "mesa_evidence_corrupt"; run_intent_digest: string; run_admission_digest: string; policy_snapshot_digest: string; downstream_idempotency_key: string; downstream_request_digest: string; cancel_tombstone_digest: string | null; evidence_base_snapshot_revision: number; evidence_base_project_event_digest: string; mesa_receipt_absent: boolean; dispatch_owner_absent: boolean; failure: null | { code: string; safe_message: string }; created_at: string };

export type VerifiedMesaRunReceipt = { schema_version: 1; canonical_json_version: "riff-canonical-json-v2"; mesa_run_receipt_digest: string; downstream_idempotency_key: string; downstream_request_digest: string; project_id: string; run_id: string; model_id: "wind-turbine-maintenance"; model_revision_id: string; experiment_revision_id: string; experiment_sha256: string; policy_snapshot_digest: string; run_admission_digest: string; run_intent_digest: string; captured_request_sha256: string; ownership_epoch: number; accepted_at: string };
export type VerifiedMesaChildIdentity = { pid: number; process_start_token: string; spawn_nonce: string; executable_sha256: string; request_sha256: string };
export type VerifiedMesaLifecycleHead = { schema_version: 1; canonical_json_version: "riff-canonical-json-v2"; mesa_lifecycle_digest: string; project_id: string; run_id: string; sequence: number; previous_mesa_lifecycle_digest: string | null; ownership_epoch: number; owner_instance_id: string; state: "receipt_committed" | "ownership_acquired" | "temp_prepared" | "spawn_intent" | "worker_started" | "cancel_requested" | "worker_exited" | "verified_succeeded" | "terminal_failed" | "terminal_timed_out" | "terminal_cancelled"; receipt_digest: string; run_intent_digest: string; run_admission_digest: string; policy_snapshot_digest: string; experiment_sha256: string; captured_request_sha256: string; child_identity: VerifiedMesaChildIdentity | null; evidence_digest: string | null; created_at: string };
export type VerifiedMesaArtifactName = "request.json" | "metadata.json" | "daily-kpis.csv" | "domain-events.jsonl" | "summary.json" | "replay-manifest.json" | "derived-views-manifest.json" | "run.log";
export type VerifiedMesaArtifact = { artifact_id: string; name: VerifiedMesaArtifactName; sha256: string; byte_length?: number };
export type VerifiedMesaTerminalMetadata = { schema_version: 1; canonical_json_version: "riff-canonical-json-v2"; terminal_metadata_digest: string; project_id: string; run_id: string; status: "succeeded" | "failed" | "timed_out" | "cancelled"; cancel_outcome: null | "cancelled_before_dispatch" | "cancelled_by_worker" | "completed_before_cancel_effect" | "failed_before_cancel_effect" | "timed_out_before_cancel_effect"; receipt_digest: string; run_intent_digest: string; run_admission_digest: string; policy_snapshot_digest: string; experiment_revision_id: string; experiment_sha256: string; artifacts: VerifiedMesaArtifact[] };
export type FramedVerifiedMesaTerminalMetadata = { schema_id: "riff://evidence-studio/framed-terminal-metadata/v1"; schema_version: 1; canonical_json_version: "riff-canonical-json-v2"; terminal_metadata_kind: "framed_verified_success"; project_id: string; run_id: string; metadata_core_projection: Record<string, unknown>; metadata_core_digest: string; artifacts: Record<VerifiedMesaArtifactName, { artifact_id: string; sha256: string; byte_length: number }>; finalized_at: string; terminal_metadata_digest: string };
export type VerifiedMesaRunEvidence = { receipt: VerifiedMesaRunReceipt; lifecycle_records: VerifiedMesaLifecycleHead[]; terminal_metadata: VerifiedMesaTerminalMetadata | FramedVerifiedMesaTerminalMetadata | null };

export type DurableProjectSnapshot = { schema_version: 1; canonical_json_version: "riff-canonical-json-v2"; project_id: string; display_name: string; snapshot_revision: number; snapshot_digest: string; previous_event_digest: string | null; phase: DurableProjectPhase; current: { decision_brief_revision_id: string | null; alignment_map_revision_id: string | null; model_revision_id: string | null; experiment_revision_id: string | null; run_id: string | null }; actor_ids: string[]; issue_index: IssueSummary[]; attestation_index: AttestationSummary[]; run_index: RunReference[]; created_at: string; updated_at: string };
export type RecordRef = { kind: string; id: string; digest: string };
export type DurableProjectEvent = { schema_version: 1; canonical_json_version: "riff-canonical-json-v2"; project_id: string; snapshot_revision: number; previous_snapshot_revision: number | null; previous_event_digest: string | null; event_digest: string; command_id: string; command_digest: string; initiator: "workspace_create" | "client" | "system"; session_id: string | null; actor_id: string | null; system_component: null | "backend_run_reconciler" | "backend_model_reconciler"; event_type: string; record_refs: RecordRef[]; state_patch: Array<{ op: "replace" | "add" | "remove"; path: string; value?: unknown }>; response_status: number; response_projection: Record<string, unknown>; committed_at: string };

export type ProjectCommand<T> = { command_id: string; project_id: string; session_id: string; base_snapshot_revision: number; payload: T };
export type WindParameterRule = { type: "number" | "integer" | "boolean" | "string"; minimum?: number; maximum?: number };
export type WindModelContract = { model_id: "wind-turbine-maintenance"; model_revision_id: string; preset_id: string; parameter_defaults: Record<string, CanonicalJsonScalar>; execution_defaults: ExecutionValues; runtime_profile: RuntimeProfile; parameter_rules: Record<string, WindParameterRule>; allowed_model_refs: string[] };

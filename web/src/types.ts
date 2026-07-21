export type JsonScalar = null | boolean | number | string;
export type JsonObject = Record<string, unknown>;

export type BrowserActor = {
  actor_id: string;
  display_name: string;
  actor_type: "human" | "agent";
  declared_role: string;
  assurance: "declared_unauthenticated_local";
};

export type ExperimentRevision = {
  experiment_revision_id: string;
  parent_experiment_revision_id: string | null;
  operation: "create" | "edit" | "reset_defaults";
  model_id: "wind-turbine-maintenance";
  model_revision_id: string;
  brief_revision_id: string;
  alignment_revision_id: string;
  preset_id: string;
  defaults_digest: string;
  parameter_defaults: Record<string, JsonScalar>;
  parameters: Record<string, JsonScalar>;
  parameter_diff: Array<{ parameter_id: string; default_value: JsonScalar; current_value: JsonScalar }>;
  execution_defaults: ExecutionValues;
  execution_values: ExecutionValues;
  execution_diff: Array<{ field: keyof ExecutionValues; default_value: number; current_value: number }>;
  runtime_profile: Record<string, JsonScalar>;
  created_by_actor_id: string;
  created_at: string;
};

export type ExecutionValues = { horizon_days: number; warmup_days: number; seed: number };

export type IssueSummary = {
  issue_id: string;
  subject_revision_ids: string[];
  status: "open" | "resolved" | "closed";
  blocking: boolean;
  severity: "info" | "warning" | "critical";
  reporter_actor_id: string;
  assignee_actor_id: string | null;
  latest_issue_event_id: string;
  latest_issue_event_digest: string;
  latest_sequence: number;
};

export type AttestationSummary = {
  attestation_id: string;
  attestation_digest: string;
  actor_id: string;
  actor_type: "human" | "agent";
  declared_role: string;
  subject_revision_id: string;
  scope: "workflow_progression" | "technical_review" | "other";
  decision: "endorse" | "object" | "abstain";
  supersedes_attestation_id: string | null;
};

export type SubjectPolicy = {
  subject_revision_id: string;
  human_project_owner_endorsement_count: number;
  open_issue_count: number;
  open_blocking_issue_count: number;
  open_non_blocking_issue_count: number;
  policy_satisfied: boolean;
  wording: "no_recorded_open_objection" | "recorded_open_objection";
  [key: string]: unknown;
};

export type WorkflowPolicy = {
  alignment: SubjectPolicy;
  experiment: SubjectPolicy;
  combined_policy_satisfied: boolean;
  [key: string]: unknown;
};

export type RunReferenceIdentity = {
  project_id: string;
  run_id: string;
  model_id: "wind-turbine-maintenance";
  model_revision_id: string;
  brief_revision_id: string;
  alignment_revision_id: string;
  experiment_revision_id: string;
  preset_id: string;
  seed: number;
  visibility: "private_draft";
  trust_label: "draft_unverified";
  workflow_label: "workflow_policy_met" | "workflow_policy_unmet";
  policy_snapshot_digest: string;
  run_admission_digest: string;
  run_intent_digest: string;
};

export type PendingRunReference = RunReferenceIdentity & {
  reference_kind: "pending";
  status: "dispatch_pending" | "queued" | "running" | "cancellation_requested";
};

export type SucceededRunReference = RunReferenceIdentity & {
  reference_kind: "terminal";
  status: "succeeded";
  terminal_evidence_source: "mesa_terminal_metadata";
  terminal_metadata_digest: string;
  verified_success: true;
  artifact_ids: string[];
  cancel_outcome: null | "completed_before_cancel_effect";
};

export type FailedRunReference = RunReferenceIdentity & {
  reference_kind: "terminal";
  status: "failed";
  terminal_evidence_source: "mesa_terminal_metadata" | "local_run_terminal_evidence";
  terminal_metadata_digest: string;
  verified_success: false;
  cancel_outcome: null | "failed_before_cancel_effect";
};

export type TimedOutRunReference = RunReferenceIdentity & {
  reference_kind: "terminal";
  status: "timed_out";
  terminal_evidence_source: "mesa_terminal_metadata";
  terminal_metadata_digest: string;
  verified_success: false;
  cancel_outcome: null | "timed_out_before_cancel_effect";
};

export type CancelledRunReference = RunReferenceIdentity & {
  reference_kind: "terminal";
  status: "cancelled";
  terminal_evidence_source: "mesa_terminal_metadata" | "local_run_terminal_evidence";
  terminal_metadata_digest: string;
  verified_success: false;
  cancel_outcome: "cancelled_before_dispatch" | "cancelled_by_worker";
};

export type TerminalRunReference = SucceededRunReference | FailedRunReference | TimedOutRunReference | CancelledRunReference;
export type RunReference = PendingRunReference | TerminalRunReference;

export type BrowserModelActivation = {
  activation_id: string;
  source: RevisionTuple;
  target: RevisionTuple;
  status: "authorizing" | "candidate_ready" | "project_committed" | "mesa_switch_pending" | "ready" | "failed_fenced";
  run_admission_fenced: boolean;
  safe_error: null | { code: string; message: string; correlation_id: string };
  intent_digest: string;
  candidate_digest: string | null;
  project_event_digest: string | null;
  switch_receipt_digest: string | null;
  reconcile_digest: string | null;
};

export type RevisionTuple = { model_revision_id: string; brief_revision_id: string; alignment_revision_id: string; experiment_revision_id: string };

export type BrowserProjectState = {
  schema_id: "riff://evidence-studio/project-state/v1";
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  project_id: string;
  display_name: string;
  snapshot_revision: number;
  projection_digest: string;
  phase: "brief" | "align" | "configure" | "review" | "run" | "inspect";
  current: {
    decision_brief_revision_id: string | null;
    alignment_map_revision_id: string | null;
    model_revision_id: string | null;
    experiment_revision_id: string | null;
    run_id: string | null;
  };
  model_activation: BrowserModelActivation | null;
  current_records: {
    decision_brief: (JsonObject & { decision_brief_revision_id: string }) | null;
    alignment_map: (JsonObject & { alignment_map_revision_id: string; entries?: JsonObject[]; known_gaps?: JsonObject[] }) | null;
    model_view: null | { model_id: "wind-turbine-maintenance"; model_revision_id: string; view_sources_href: string; source_set_digest: string };
    experiment: ExperimentRevision | null;
  };
  actors: BrowserActor[];
  issues: IssueSummary[];
  review_summaries: { human: { items: AttestationSummary[]; count: number; truncated: boolean }; agent: { items: AttestationSummary[]; count: number; truncated: boolean } };
  workflow_policy: WorkflowPolicy | null;
  runs: RunReference[];
  current_terminal_artifacts: Array<{ artifact_id: string; logical_name: string; sha256: string; href: string }>;
  recent_command_results: Array<{ command_id: string; command_digest: string; command_digest_version: "gate2-command-digest-v1" | "gate3-command-digest-v2"; event_type: string; committed_snapshot_revision: number; result_identity: Record<string, JsonScalar> }>;
  projection_truncation: Record<string, { count: number; truncated: boolean }>;
};

export type BrowserProjectionResponse = {
  schema_id: "riff://evidence-studio/browser-projection-response/v1";
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  project_id: string;
  snapshot_revision: number;
  projection_digest: string;
  projection: BrowserProjectState;
};

export type BrowserSnapshotEvent = BrowserProjectionResponse & { event_type: "browser.project.snapshot.v1" };
export type BrowserPatchEvent = {
  schema_id: "riff://evidence-studio/browser-project-patch/v1";
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  event_type: "browser.project.patch.v1";
  project_id: string;
  base_snapshot_revision: number;
  snapshot_revision: number;
  projection_digest: string;
  operations: [{ op: "replace"; path: ""; value: BrowserProjectState }];
};
export type BrowserReloadEvent = {
  schema_id: "riff://evidence-studio/browser-project-reload-required/v1";
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  event_type: "browser.project.reload-required.v1";
  project_id: string;
  base_snapshot_revision: number;
  snapshot_revision: number;
  projection_digest: string;
  reason: "revision_gap" | "projection_changed_while_disconnected" | "projection_digest_mismatch" | "unsupported_patch";
};
export type BrowserEvent = BrowserSnapshotEvent | BrowserPatchEvent | BrowserReloadEvent | { event_type: "connection.status"; status: "connected" | "reconnecting" | "offline" };

export type SourceDescriptor = { schema_id: "riff://evidence-studio/source-descriptor/v1"; schema_version: 1; canonical_json_version: "riff-canonical-json-v2"; logical_name: string; sha256: string; href: string; source_kind: "model_bundle" | "business_revision" | "run_artifact"; identity: { project_id: string; model_revision_id: string | null; brief_revision_id: string | null; alignment_revision_id: string | null; experiment_revision_id: string | null; run_id: string | null } };
export type ParameterProperty = {
  type: "number" | "integer" | "boolean" | "string";
  display_name: string;
  description?: string;
  section_id: string;
  display_order: number;
  minimum?: number;
  maximum?: number;
  unit: string | null;
  provenance: JsonObject;
  distribution_group_id: string | null;
  distribution_family: "triangular" | null;
  distribution_role: "low" | "mode" | "high" | null;
};
export type ExecutionProperty = { type: "integer"; minimum: number; maximum: number; unit: string };
export type ParameterSchema = { schema_id: "riff://wind-turbine-maintenance/parameters/v2"; schema_version: 2; required: string[]; properties: Record<string, ParameterProperty> };
export type ExecutionFieldSchema = { schema_id: "riff://wind-turbine-maintenance/execution-fields/v1"; schema_version: 1; required: ["horizon_days", "warmup_days", "seed"]; properties: Record<keyof ExecutionValues, ExecutionProperty>; invariants: [{ rule: "warmup_days < horizon_days" }] };
export type ModelViewSources = {
  schema_id: "riff://evidence-studio/model-view-sources/v1";
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  project_id: string;
  model_id: "wind-turbine-maintenance";
  model_revision_id: string;
  generator_contract_version: "wind-evidence-view-contract-v1";
  source_set_digest: string;
  sources: Record<string, SourceDescriptor>;
  contract_bindings: Record<string, SourceDescriptor>;
  model_spec: JsonObject;
  parameter_schema: ParameterSchema;
  execution_field_schema: ExecutionFieldSchema;
  metric_schema: JsonObject;
  visualization: JsonObject;
  traceability: JsonObject;
};

export type DefaultProject = { schema_id: "riff://evidence-studio/default-project-discovery/v1"; schema_version: 1; canonical_json_version: "riff-canonical-json-v2"; project_id: string; display_name: string; health: "healthy_configured"; actors: BrowserActor[]; actor_count: number; actors_truncated: boolean };
export type CandidateDescriptor = { project_id: string; model_id: "wind-turbine-maintenance"; model_revision_id: string; descriptor_digest: string; expected_active_model_revision_id: string; candidate_source_revision: string; runtime_handshake_digest: string };

export type AttestationDetail = { attestation_id: string; actor: BrowserActor; subject_revision_ids: string[]; scope: "workflow_progression" | "technical_review" | "other"; decision: "endorse" | "object" | "abstain"; rationale: string; issue_refs: Array<{ issue_id: string; title: string; status: "open" | "resolved" | "closed"; href: string }>; created_at: string; supersedes_attestation_id: string | null; superseded_by_attestation_id: string | null; effective_head: boolean; record_digest: string };
export type AttestationDetailPage = { schema_id: "riff://evidence-studio/attestation-detail-page/v1"; schema_version: 1; canonical_json_version: "riff-canonical-json-v2"; project_id: string; subject_revision_id: string; after: string | null; next_after: string | null; has_more: boolean; items: AttestationDetail[] };
export type EvidenceIndex = JsonObject & { project_id: string; run: RunReference; identity: Record<string, JsonScalar>; labels: { visibility: string; trust_label: string; workflow_label: string; claim_labels: string[]; non_claims: string[] }; summary: JsonObject; replay_manifest_summary: JsonObject; artifacts: Array<{ artifact_id: string; logical_name: string; sha256: string; href: string }>; source_links: SourceDescriptor[] };
export type PageRange = { page: number; request_after: number | string | null; first: number | string | null; last: number | string | null; count: number };
export type KpiPage = { schema_id: "riff://evidence-studio/kpi-page/v1"; schema_version: 1; canonical_json_version: "riff-canonical-json-v2"; project_id: string; run_id: string; experiment_revision_id: string; columns: Array<{ key: string; label: string; unit: string | null }>; rows: Array<Record<string, string | number>>; after_day: number; next_after_day: number; has_more: boolean; source: SourceDescriptor; metric_schema_source: SourceDescriptor; page_ranges?: PageRange[] };
export type DomainEvent = JsonObject & { event_id: string; sequence: number; sim_time_days: number; event_type: string; phase: number; turbine_id: string | null; crew_id: string | null; work_order_id: string | null; correlation_id: string | null; before_state: string | null; after_state: string | null; payload: JsonObject };
export type EventPage = { schema_id: "riff://evidence-studio/filtered-domain-event-projection-page/v1"; schema_version: 1; canonical_json_version: "riff-canonical-json-v2"; projection_kind: "filtered_domain_events"; project_id: string; run_id: string; experiment_revision_id: string; events: DomainEvent[]; filters: { from_day: number | null; to_day: number | null; event_type: string | null; turbine_id: string | null; crew_id: string | null; work_order_id: string | null }; source_event_count: number; after: number; scanned_through_sequence: number; next_after: number; has_more: boolean; source: SourceDescriptor; page_ranges?: PageRange[] };
export type SourceEventRange = { range_index: number; event_count: number; first_sequence: number; last_sequence: number; byte_offset: number; byte_length: number; raw_range_sha256: string; semantic_range_sha256: string };
export type ReplayFrame = { frame_index: number; identity: Record<string, JsonScalar>; day: number; phase: "warmup" | "measurement" | "horizon_end"; through_event_sequence: number; source_event_range_index: number; frame_state_sha256: string; depot: { x_km: number; y_km: number }; turbines: Array<{ turbine_id: string; x_km: number; y_km: number; state: string }>; crews: Array<{ crew_id: string; x_km: number; y_km: number; state: string; turbine_id: string | null; work_order_id: string | null }>; queues: { corrective: number; planned: number }; daily_metrics: Record<string, number> };
export type ReplayPage = { schema_id: "riff://evidence-studio/replay-page/v1"; schema_version: 1; canonical_json_version: "riff-canonical-json-v2"; page_kind: "complete" | "unavailable_population_limit" | "legacy_frameless"; project_id: string; run_id: string; frames: ReplayFrame[]; frame_count: number; sample_days: number[]; sample_days_sha256: string | null; unavailable_reason: "population_exceeds_frame_contract" | "legacy_frameless_manifest" | null; generator_version: "wind-worker-sampled-replay-v1" | null; sampling_algorithm: "wind-replay-sample-days-v1" | null; declared_population: { turbine_count: number; crew_count: number }; source_event_ranges: SourceEventRange[]; after_frame: number; next_after_frame: number; has_more: boolean; event_source: SourceDescriptor; manifest_source: SourceDescriptor; source_set_digest: string; page_ranges?: PageRange[] };

export type IssueEvent = { schema_version: 1; canonical_json_version: "riff-canonical-json-v2"; issue_event_id: string; project_id: string; issue_id: string; sequence: number; previous_issue_event_digest: string | null; issue_event_digest: string; event_type: "opened" | "commented" | "assigned" | "resolved" | "closed" | "reopened"; actor_id: string; payload: JsonObject; created_at: string };
export type IssueHistory = { issue_id: string; events: IssueEvent[]; truncated: boolean };

export type ProjectCommand<T> = { command_id: string; project_id: string; session_id: string; base_snapshot_revision: number; payload: T };
export type CommandResponse = Record<string, unknown> & { snapshot_revision?: number };
export type ApiErrorShape = { code: string; message: string; correlation_id?: string };
export type FrozenCommand = { envelope: ProjectCommand<Record<string, unknown>>; canonical_json: string; method: "POST" | "PATCH"; actual_path: string; digest_route: string; command_digest_version: "gate2-command-digest-v1" | "gate3-command-digest-v2"; command_digest: string; expected_event_type: string; expected_terminal_event_types: string[]; expected_result_identity: Record<string, JsonScalar>; observed_result_identity: Record<string, JsonScalar> | null; error_receipt: null | { status: number; code: string; message: string; correlation_id: string | null; command_digest: string | null; activation_id: string | null; receipt_digest: string | null; terminal_status: string | null }; transport_status: "not_sent" | "in_flight" | "reservation_pending" | "http_accepted" | "http_rejected" | "response_lost" | "terminal_failed" };

export interface EvidenceStudioClient {
  discoverDefaultProject(): Promise<DefaultProject>;
  attachSession(projectId: string, actorId: string): Promise<{ session_id: string }>;
  getProjection(projectId: string): Promise<BrowserProjectionResponse>;
  subscribe(projectId: string, onEvent: (event: BrowserEvent) => void): () => void;
  getCandidate(projectId: string): Promise<CandidateDescriptor>;
  getModelViewSources(href: string, signal?: AbortSignal): Promise<ModelViewSources>;
  getExactJsonSource?(source: SourceDescriptor, signal?: AbortSignal): Promise<JsonObject>;
  activate(projectId: string, command: ProjectCommand<Record<string, unknown>>): Promise<CommandResponse>;
  reviseExperiment(projectId: string, command: ProjectCommand<Record<string, unknown>>): Promise<CommandResponse>;
  createIssue(projectId: string, command: ProjectCommand<Record<string, unknown>>): Promise<CommandResponse>;
  updateIssue(projectId: string, issueId: string, command: ProjectCommand<Record<string, unknown>>): Promise<CommandResponse>;
  commentIssue(projectId: string, issueId: string, command: ProjectCommand<Record<string, unknown>>): Promise<CommandResponse>;
  createAttestations(projectId: string, command: ProjectCommand<Record<string, unknown>>): Promise<CommandResponse>;
  startRun(projectId: string, command: ProjectCommand<Record<string, unknown>>): Promise<CommandResponse>;
  cancelRun(projectId: string, runId: string, command: ProjectCommand<Record<string, unknown>>): Promise<CommandResponse>;
  getAttestations(projectId: string, subjectId: string, after?: string | null, signal?: AbortSignal): Promise<AttestationDetailPage>;
  getIssueHistory(projectId: string, issueId: string, signal?: AbortSignal): Promise<IssueHistory>;
  getEvidence(projectId: string, runId: string, signal?: AbortSignal): Promise<EvidenceIndex>;
  getKpis(projectId: string, runId: string, afterDay?: number, signal?: AbortSignal): Promise<KpiPage>;
  getEvents(projectId: string, runId: string, filters: Record<string, string>, after?: number, signal?: AbortSignal): Promise<EventPage>;
  getReplay(projectId: string, runId: string, afterFrame?: number, signal?: AbortSignal): Promise<ReplayPage>;
  retryFrozen?(): Promise<CommandResponse>;
  pendingFrozen?(): FrozenCommand | null;
  clearFrozen?(): void;
}

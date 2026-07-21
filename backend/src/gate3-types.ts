import type { AlignmentMapRevision, AttestationSummary, DecisionBriefRevision, ExperimentRevision, IssueSummary, RunReference } from "./durable-project-types.ts";

export const GATE3_CANONICAL = "riff-canonical-json-v2" as const;

export type BrowserActor = {
  actor_id: string; display_name: string; actor_type: "human" | "agent"; declared_role: string;
  assurance: "declared_unauthenticated_local";
};

export type BrowserModelActivation = {
  activation_id: string;
  source: { model_revision_id: string; brief_revision_id: string; alignment_revision_id: string; experiment_revision_id: string };
  target: { model_revision_id: string; brief_revision_id: string; alignment_revision_id: string; experiment_revision_id: string };
  status: "authorizing" | "candidate_ready" | "project_committed" | "mesa_switch_pending" | "ready" | "failed_fenced";
  run_admission_fenced: boolean;
  safe_error: null | { code: string; message: string; correlation_id: string };
  intent_digest: string; candidate_digest: string | null; project_event_digest: string | null;
  switch_receipt_digest: string | null; reconcile_digest: string | null;
};

export type BrowserProjectState = {
  schema_id: "riff://evidence-studio/project-state/v1"; schema_version: 1; canonical_json_version: typeof GATE3_CANONICAL;
  project_id: string; display_name: string; snapshot_revision: number; projection_digest: string;
  phase: "brief" | "align" | "configure" | "review" | "run" | "inspect";
  current: { decision_brief_revision_id: string | null; alignment_map_revision_id: string | null; model_revision_id: string | null; experiment_revision_id: string | null; run_id: string | null };
  model_activation: BrowserModelActivation | null;
  current_records: {
    decision_brief: DecisionBriefRevision | null; alignment_map: AlignmentMapRevision | null;
    model_view: null | { model_id: "wind-turbine-maintenance"; model_revision_id: string; view_sources_href: string; source_set_digest: string };
    experiment: ExperimentRevision | null;
  };
  actors: BrowserActor[]; issues: IssueSummary[];
  review_summaries: { human: { items: AttestationSummary[]; count: number; truncated: boolean }; agent: { items: AttestationSummary[]; count: number; truncated: boolean } };
  workflow_policy: Record<string, unknown> | null; runs: RunReference[];
  current_terminal_artifacts: Array<{ artifact_id: string; logical_name: string; sha256: string; href: string }>;
  recent_command_results: Array<{ command_id: string; command_digest: string; command_digest_version: "gate2-command-digest-v1" | "gate3-command-digest-v2"; event_type: string; committed_snapshot_revision: number; result_identity: Record<string, string | number | boolean | null> }>;
  projection_truncation: Record<string, { count: number; truncated: boolean }>;
};

export type BrowserProjectionResponse = {
  schema_id: "riff://evidence-studio/browser-projection-response/v1"; schema_version: 1; canonical_json_version: typeof GATE3_CANONICAL;
  project_id: string; snapshot_revision: number; projection_digest: string; projection: BrowserProjectState;
};

export type SourceDescriptor = {
  schema_id: "riff://evidence-studio/source-descriptor/v1"; schema_version: 1; canonical_json_version: typeof GATE3_CANONICAL;
  source_kind: "model_bundle" | "business_revision" | "run_artifact"; logical_name: string; sha256: string;
  identity: { project_id: string; model_revision_id: string | null; brief_revision_id: string | null; alignment_revision_id: string | null; experiment_revision_id: string | null; run_id: string | null };
  href: string;
};

export type RuntimeCandidateHandshake = {
  schema_id: "riff://mesa-wind/runtime-candidate-handshake/v1"; schema_version: 1; canonical_json_version: typeof GATE3_CANONICAL;
  project_id: string; runtime_instance_id: string; actual_python_implementation: string; actual_python_major_minor: string; actual_mesa_version: string;
  model_protocol_version: string; candidate_source_revision: string; candidate_bundle_protocol: string; candidate_manifest_sha256: string;
  candidate_file_map_sha256: string; candidate_source_descriptor_digest: string; active_model_revision_id: string | null; handshake_digest: string;
};

export type FramedCandidateDescriptor = {
  schema_id: "riff://evidence-studio/framed-candidate-descriptor/v1"; schema_version: 1; canonical_json_version: typeof GATE3_CANONICAL;
  project_id: string; runtime_handshake_digest: string; expected_active_model_revision_id: string; candidate_source_revision: string;
  model_id: "wind-turbine-maintenance"; model_revision_id: string; bundle_protocol: "wind-turbine-maintenance-bundle-v2-framed";
  manifest_sha256: string; file_map_sha256: string;
  runtime_profile: { canonical_json_version: typeof GATE3_CANONICAL; mesa_version: "3.5.1"; model_protocol_version: "wind-turbine-maintenance-v2-framed-replay"; python_implementation: "CPython"; python_major_minor: "3.12" };
  preset_id: "wind-turbine-maintenance-demo-v1"; preset_sha256: string; provenance_sha256: string; descriptor_digest: string;
};

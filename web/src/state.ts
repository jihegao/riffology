import type { AttestationDetailPage, BrowserPatchEvent, BrowserProjectState, BrowserProjectionResponse, BrowserReloadEvent, BrowserSnapshotEvent, ExecutionFieldSchema, ExecutionValues, ExperimentRevision, FrozenCommand, JsonScalar, ParameterProperty, ParameterSchema, RunReference } from "./types";

const dangerousKeys = new Set(["__proto__", "prototype", "constructor"]);
const exactKeys = (value: object, expected: string[]) => { const actual = Object.keys(value).sort(); const wanted = [...expected].sort(); return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]); };
const runIdentityKeys = ["project_id", "run_id", "model_id", "model_revision_id", "brief_revision_id", "alignment_revision_id", "experiment_revision_id", "preset_id", "seed", "visibility", "trust_label", "workflow_label", "policy_snapshot_digest", "run_admission_digest", "run_intent_digest"];
const pendingRunKeys = [...runIdentityKeys, "reference_kind", "status"];
const terminalRunKeys = [...runIdentityKeys, "reference_kind", "status", "terminal_evidence_source", "terminal_metadata_digest", "verified_success", "cancel_outcome"];
const succeededRunKeys = [...terminalRunKeys, "artifact_ids"];
const id = (value: unknown, prefix: string, size: number) => typeof value === "string" && new RegExp(`^${prefix}[0-9a-f]{${size}}$`).test(value);
const runAdmissionReasons = new Set(["ready", "activation_missing", "activation_not_ready", "activation_fenced", "activation_target_invalid", "model_revision_mismatch", "brief_revision_mismatch", "alignment_revision_mismatch", "experiment_lineage_invalid"]);

const validateRunAdmission = (value: unknown): void => {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, ["admissible", "reason"])) throw new Error("Run admission projection has an unsupported keyset.");
  const admission = value as Record<string, unknown>;
  if (typeof admission.admissible !== "boolean" || !runAdmissionReasons.has(String(admission.reason)) || admission.admissible !== (admission.reason === "ready")) throw new Error("Run admission projection is inconsistent.");
};

export function validateRunReference(value: unknown, projectId: string): RunReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Run reference must be an exact object.");
  const run = value as Record<string, unknown>;
  const pending = run.reference_kind === "pending";
  const terminal = run.reference_kind === "terminal";
  if (!pending && !terminal) throw new Error("Run reference discriminator is invalid.");
  const expectedKeys = pending ? pendingRunKeys : run.status === "succeeded" ? succeededRunKeys : terminalRunKeys;
  if (!exactKeys(run, expectedKeys)) throw new Error("Run reference keyset does not match its discriminator and status.");
  if (run.project_id !== projectId || !id(run.project_id, "project_", 32) || !id(run.run_id, "run_", 32) || run.model_id !== "wind-turbine-maintenance" || !id(run.model_revision_id, "mr_", 64) || !id(run.brief_revision_id, "dbr_", 64) || !id(run.alignment_revision_id, "amr_", 64) || !id(run.experiment_revision_id, "er_", 64) || run.preset_id !== "wind-turbine-maintenance-demo-v1" || !Number.isSafeInteger(run.seed) || Number(run.seed) < -2_147_483_648 || Number(run.seed) > 2_147_483_647 || run.visibility !== "private_draft" || run.trust_label !== "draft_unverified" || !["workflow_policy_met", "workflow_policy_unmet"].includes(String(run.workflow_label)) || !id(run.policy_snapshot_digest, "ps_", 64) || !id(run.run_admission_digest, "ra_", 64) || !id(run.run_intent_digest, "ri_", 64)) throw new Error("Run reference identity is invalid.");
  if (pending) {
    if (!["dispatch_pending", "queued", "running", "cancellation_requested"].includes(String(run.status))) throw new Error("Pending run status is invalid.");
    return run as unknown as RunReference;
  }
  const localEvidence = run.terminal_evidence_source === "local_run_terminal_evidence";
  if (!id(run.terminal_metadata_digest, localEvidence ? "lte_" : "tm_", 64)) throw new Error("Terminal run evidence identity is invalid.");
  switch (run.status) {
    case "succeeded":
      { const artifactIds = run.artifact_ids; if (!Array.isArray(artifactIds) || artifactIds.length !== 8 || artifactIds.some((item) => !id(item, "artifact_", 64)) || new Set(artifactIds).size !== 8 || artifactIds.some((item, index) => index > 0 && String(artifactIds[index - 1]) >= String(item)) || run.terminal_evidence_source !== "mesa_terminal_metadata" || run.verified_success !== true || run.cancel_outcome !== null && run.cancel_outcome !== "completed_before_cancel_effect") throw new Error("Succeeded run terminal contract is invalid."); }
      break;
    case "failed":
      if (!["mesa_terminal_metadata", "local_run_terminal_evidence"].includes(String(run.terminal_evidence_source)) || run.verified_success !== false || run.cancel_outcome !== null && run.cancel_outcome !== "failed_before_cancel_effect") throw new Error("Failed run terminal contract is invalid.");
      break;
    case "timed_out":
      if (run.terminal_evidence_source !== "mesa_terminal_metadata" || run.verified_success !== false || run.cancel_outcome !== null && run.cancel_outcome !== "timed_out_before_cancel_effect") throw new Error("Timed-out run terminal contract is invalid.");
      break;
    case "cancelled":
      if (!["mesa_terminal_metadata", "local_run_terminal_evidence"].includes(String(run.terminal_evidence_source)) || run.verified_success !== false || !["cancelled_before_dispatch", "cancelled_by_worker"].includes(String(run.cancel_outcome))) throw new Error("Cancelled run terminal contract is invalid.");
      break;
    default: throw new Error("Terminal run status is invalid.");
  }
  return run as unknown as RunReference;
}

const validateProjectionRuns = (projection: BrowserProjectState): void => {
  if (!Array.isArray(projection.runs)) throw new Error("Project runs must be an array.");
  projection.runs.forEach((run) => validateRunReference(run, projection.project_id));
  const ids = projection.runs.map((run) => run.run_id);
  if (ids.length !== new Set(ids).size) throw new Error("Project run identities must be unique.");
  if (projection.current.run_id !== null && !ids.includes(projection.current.run_id)) throw new Error("Current run identity is not present in runs.");
};

export function canonicalJsonV2(value: unknown, seen = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite number");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== "object" || value === undefined || seen.has(value)) throw new TypeError("unsupported canonical JSON value");
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonicalJsonV2(item, seen)).join(",")}]`;
    const keys = Object.keys(value).sort();
    if (keys.some((key) => dangerousKeys.has(key))) throw new TypeError("dangerous key");
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJsonV2((value as Record<string, unknown>)[key], seen)}`).join(",")}}`;
  } finally { seen.delete(value); }
}

export async function projectionDigest(projection: BrowserProjectState): Promise<string> {
  const unsigned = { ...projection } as Record<string, unknown>;
  delete unsigned.projection_digest;
  const bytes = new TextEncoder().encode(canonicalJsonV2(unsigned));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `pd_${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function verifyProjectionResponse(response: BrowserProjectionResponse | BrowserSnapshotEvent): Promise<BrowserProjectState> {
  const projection = response.projection;
  if (!exactKeys(response, ["schema_id", "schema_version", "canonical_json_version", "project_id", "snapshot_revision", "projection_digest", "projection", ...( "event_type" in response ? ["event_type"] : [])])) throw new Error("Browser projection envelope has an unsupported keyset.");
  if (response.schema_id !== "riff://evidence-studio/browser-projection-response/v1" || response.schema_version !== 1 || response.canonical_json_version !== "riff-canonical-json-v2" || "event_type" in response && response.event_type !== "browser.project.snapshot.v1") throw new Error("Unsupported browser projection schema.");
  if (!exactKeys(projection, ["schema_id", "schema_version", "canonical_json_version", "project_id", "display_name", "snapshot_revision", "projection_digest", "phase", "current", "model_activation", "run_admission", "current_records", "actors", "issues", "review_summaries", "workflow_policy", "runs", "current_terminal_artifacts", "recent_command_results", "projection_truncation"]) || projection.schema_id !== "riff://evidence-studio/project-state/v1" || projection.schema_version !== 1 || projection.canonical_json_version !== "riff-canonical-json-v2") throw new Error("Browser project state has an unsupported root schema/keyset.");
  validateRunAdmission(projection.run_admission);
  validateProjectionRuns(projection);
  if (response.project_id !== projection.project_id || response.snapshot_revision !== projection.snapshot_revision || response.projection_digest !== projection.projection_digest) throw new Error("Browser projection envelope identity mismatch.");
  if (await projectionDigest(projection) !== response.projection_digest) throw new Error("Browser projection digest mismatch.");
  return projection;
}

export function verifyReloadEvent(event: BrowserReloadEvent, projectId: string, currentRevision: number): BrowserReloadEvent {
  if (!exactKeys(event, ["schema_id", "schema_version", "canonical_json_version", "event_type", "project_id", "base_snapshot_revision", "snapshot_revision", "projection_digest", "reason"]) || event.schema_id !== "riff://evidence-studio/browser-project-reload-required/v1" || event.schema_version !== 1 || event.canonical_json_version !== "riff-canonical-json-v2" || event.event_type !== "browser.project.reload-required.v1" || event.project_id !== projectId || event.base_snapshot_revision !== currentRevision || event.snapshot_revision < currentRevision || !/^pd_[0-9a-f]{64}$/.test(event.projection_digest)) throw new Error("Browser reload event identity/schema mismatch.");
  return event;
}

export type PatchOutcome = { kind: "applied"; state: BrowserProjectState } | { kind: "ignored" | "reload"; state: BrowserProjectState; reason: string };

export async function reduceBrowserPatch(state: BrowserProjectState, patch: BrowserPatchEvent): Promise<PatchOutcome> {
  if (!exactKeys(patch, ["schema_id", "schema_version", "canonical_json_version", "event_type", "project_id", "base_snapshot_revision", "snapshot_revision", "projection_digest", "operations"])) return { kind: "reload", state, reason: "schema_mismatch" };
  if (patch.schema_id !== "riff://evidence-studio/browser-project-patch/v1" || patch.schema_version !== 1 || patch.canonical_json_version !== "riff-canonical-json-v2" || patch.event_type !== "browser.project.patch.v1") return { kind: "reload", state, reason: "schema_mismatch" };
  if (patch.project_id !== state.project_id) return { kind: "reload", state, reason: "project_mismatch" };
  if (patch.snapshot_revision <= state.snapshot_revision) return { kind: "reload", state, reason: patch.snapshot_revision === state.snapshot_revision && patch.projection_digest !== state.projection_digest ? "projection_changed_same_revision" : "duplicate" };
  if (patch.base_snapshot_revision !== state.snapshot_revision || patch.snapshot_revision !== state.snapshot_revision + 1) return { kind: "reload", state, reason: "revision_gap" };
  if (patch.operations.length !== 1 || patch.operations[0].op !== "replace" || patch.operations[0].path !== "") return { kind: "reload", state, reason: "unsupported_patch" };
  const next = patch.operations[0].value;
  try { validateProjectionRuns(next); } catch { return { kind: "reload", state, reason: "invalid_run_reference" }; }
  if (next.project_id !== patch.project_id || next.snapshot_revision !== patch.snapshot_revision || next.projection_digest !== patch.projection_digest || await projectionDigest(next) !== patch.projection_digest) return { kind: "reload", state, reason: "projection_digest_mismatch" };
  return { kind: "applied", state: next };
}

export const projectionCacheKey = (state: BrowserProjectState): string => `${state.project_id}:${state.snapshot_revision}:${state.projection_digest}`;

export function commandReceiptConfirmed(state: BrowserProjectState, frozen: FrozenCommand, attestationPages: AttestationDetailPage[] = []): boolean {
  const expectedEvents = frozen.expected_terminal_event_types ?? [frozen.expected_event_type];
  const receipt = state.recent_command_results.find((item) => item.command_id === frozen.envelope.command_id && item.command_digest === frozen.command_digest && item.command_digest_version === frozen.command_digest_version && expectedEvents.includes(item.event_type)); if (!receipt) return false;
  for (const [key, value] of Object.entries(frozen.expected_result_identity)) if (receipt.result_identity[key] !== value) return false;
  if (frozen.observed_result_identity) for (const [key, value] of Object.entries(receipt.result_identity)) if (key in frozen.observed_result_identity && frozen.observed_result_identity[key] !== value) return false;
  const identity = { ...receipt.result_identity, ...(frozen.observed_result_identity ?? {}) };
  switch (receipt.event_type) {
    case "experiment.revision_created": return typeof identity.experiment_revision_id === "string" && (state.current.experiment_revision_id === identity.experiment_revision_id || state.runs.some((item) => item.experiment_revision_id === identity.experiment_revision_id));
    case "issue.opened": return typeof identity.issue_id === "string" && state.issues.some((item) => item.issue_id === identity.issue_id);
    case "issue.commented": case "issue.assigned": case "issue.resolved": case "issue.closed": case "issue.reopened": return typeof identity.issue_id === "string" && state.issues.some((item) => item.issue_id === identity.issue_id && item.latest_sequence >= 1);
    case "attestation.batch_created": return typeof identity.attestation_batch_id === "string" && typeof identity.attestation_id === "string" && attestationPages.some((page) => page.items.some((item) => item.attestation_id === identity.attestation_id));
    case "run.intent_committed": return typeof identity.run_id === "string" && state.runs.some((item) => item.run_id === identity.run_id);
    case "cancellation_requested": return typeof identity.run_id === "string" && state.runs.some((item) => item.run_id === identity.run_id && (item.status === "cancellation_requested" || item.status === "cancelled"));
    case "model.activation_reconciled": return identity.activation_id === frozen.envelope.command_id && state.model_activation?.activation_id === identity.activation_id && state.model_activation.status === "ready" && identity.terminal_status === "ready";
    case "model.activation_failed": return identity.activation_id === frozen.envelope.command_id && state.model_activation?.activation_id === identity.activation_id && state.model_activation.status === "failed_fenced" && identity.terminal_status === "failed_fenced";
    default: return false;
  }
}

export type DraftBinding = { baseSnapshotRevision: number; decisionBriefRevisionId: string | null; alignmentMapRevisionId: string | null; modelRevisionId: string | null; experimentRevisionId: string | null; relevantSubjectRevisionIds: string[] };
export const bindDraft = (state: BrowserProjectState, subjects: string[] = []): DraftBinding => ({ baseSnapshotRevision: state.snapshot_revision, decisionBriefRevisionId: state.current.decision_brief_revision_id, alignmentMapRevisionId: state.current.alignment_map_revision_id, modelRevisionId: state.current.model_revision_id, experimentRevisionId: state.current.experiment_revision_id, relevantSubjectRevisionIds: [...subjects].sort() });
export const bindingIsStale = (binding: DraftBinding, state: BrowserProjectState): boolean => binding.baseSnapshotRevision !== state.snapshot_revision;

export function scalarSame(left: JsonScalar, right: JsonScalar): boolean { return canonicalJsonV2(left) === canonicalJsonV2(right); }

export function experimentChanges(experiment: ExperimentRevision, parameters: Record<string, JsonScalar>, execution: ExecutionValues) {
  const parameter_changes = Object.fromEntries(Object.keys(parameters).filter((key) => !scalarSame(parameters[key], experiment.parameters[key])).map((key) => [key, parameters[key]]));
  const execution_changes = Object.fromEntries((Object.keys(execution) as Array<keyof ExecutionValues>).filter((key) => execution[key] !== experiment.execution_values[key]).map((key) => [key, execution[key]]));
  return { parameter_changes, execution_changes };
}

export function validateDraft(parameterSchema: ParameterSchema, executionSchema: ExecutionFieldSchema, parameters: Record<string, JsonScalar>, execution: ExecutionValues): Record<string, string> {
  const errors: Record<string, string> = {};
  const validate = (key: string, property: Pick<ParameterProperty, "type" | "minimum" | "maximum">, value: JsonScalar | undefined) => {
    if (property.type === "boolean") { if (typeof value !== "boolean") errors[key] = "Must be true or false."; return; }
    if (property.type === "string") { if (typeof value !== "string") errors[key] = "Must be text."; return; }
    if (typeof value !== "number" || !Number.isFinite(value)) { errors[key] = "Must be a number."; return; }
    if (property.type === "integer" && !Number.isInteger(value)) errors[key] = "Must be an integer.";
    else if (property.minimum !== undefined && value < property.minimum) errors[key] = `Minimum ${property.minimum}.`;
    else if (property.maximum !== undefined && value > property.maximum) errors[key] = `Maximum ${property.maximum}.`;
  };
  Object.entries(parameterSchema.properties).forEach(([key, property]) => validate(key, property, parameters[key]));
  Object.entries(executionSchema.properties).forEach(([key, property]) => validate(key, property, execution[key as keyof ExecutionValues]));
  if (!(execution.warmup_days < execution.horizon_days)) errors.warmup_days = "Warm-up days must be less than horizon days.";
  return errors;
}

export function objectionIssuesForSubjects<T extends { issue_id: string; status: string; subject_revision_ids: string[] }>(issues: T[], subjects: string[]): T[] {
  return issues.filter((issue) => issue.status === "open" && subjects.some((subject) => issue.subject_revision_ids.includes(subject)));
}

export function objectionCoverage(issues: Array<{ issue_id: string; status: string; subject_revision_ids: string[] }>, subjects: string[], selectedIssueIds: string[]): boolean {
  return subjects.length > 0 && subjects.every((subject) => selectedIssueIds.some((id) => issues.find((issue) => issue.issue_id === id && issue.status === "open")?.subject_revision_ids.includes(subject)));
}

export function issuePermissions(issue: { status: "open" | "resolved" | "closed"; reporter_actor_id: string; assignee_actor_id: string | null }, actor?: { actor_id: string; actor_type: "human" | "agent"; declared_role: string }) {
  const human = actor?.actor_type === "human"; const owner = human && actor?.declared_role === "project_owner";
  return { comment: Boolean(actor), assign: Boolean(owner && issue.status === "open"), resolve: Boolean(issue.status === "open" && human && (owner || actor?.actor_id === issue.assignee_actor_id)), close: Boolean(["open", "resolved"].includes(issue.status) && human && (owner || actor?.actor_id === issue.reporter_actor_id)), reopen: Boolean(["resolved", "closed"].includes(issue.status) && human && (owner || actor?.actor_id === issue.reporter_actor_id || actor?.actor_id === issue.assignee_actor_id)) };
}

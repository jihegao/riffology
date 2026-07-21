import { describe, expect, it } from "vitest";
import { bindDraft, bindingIsStale, canonicalJsonV2, commandReceiptConfirmed, experimentChanges, issuePermissions, objectionCoverage, objectionIssuesForSubjects, projectionDigest, reduceBrowserPatch, validateDraft, validateRunReference, verifyProjectionResponse } from "./state";
import type { BrowserProjectState, ExperimentRevision } from "./types";

const project = (revision = 3): BrowserProjectState => ({ schema_id:"riff://evidence-studio/project-state/v1",schema_version:1,canonical_json_version:"riff-canonical-json-v2",project_id:"project_1",display_name:"Wind",snapshot_revision:revision,projection_digest:"pd_x",phase:"review",current:{decision_brief_revision_id:"d",alignment_map_revision_id:"a",model_revision_id:"m",experiment_revision_id:"e",run_id:null},model_activation:null,current_records:{decision_brief:null,alignment_map:null,model_view:null,experiment:null},actors:[],issues:[],review_summaries:{human:{items:[],count:0,truncated:false},agent:{items:[],count:0,truncated:false}},workflow_policy:null,runs:[],current_terminal_artifacts:[],recent_command_results:[],projection_truncation:{} });

const runIdentity = {
  project_id: `project_${"1".repeat(32)}`,
  run_id: `run_${"2".repeat(32)}`,
  model_id: "wind-turbine-maintenance",
  model_revision_id: `mr_${"3".repeat(64)}`,
  brief_revision_id: `dbr_${"4".repeat(64)}`,
  alignment_revision_id: `amr_${"5".repeat(64)}`,
  experiment_revision_id: `er_${"6".repeat(64)}`,
  preset_id: "wind-turbine-maintenance-demo-v1",
  seed: 2,
  visibility: "private_draft",
  trust_label: "draft_unverified",
  workflow_label: "workflow_policy_unmet",
  policy_snapshot_digest: `ps_${"7".repeat(64)}`,
  run_admission_digest: `ra_${"8".repeat(64)}`,
  run_intent_digest: `ri_${"9".repeat(64)}`,
} as const;
const mesaDigest = `tm_${"a".repeat(64)}`;
const localDigest = `lte_${"b".repeat(64)}`;
const artifactIds = Array.from({ length: 8 }, (_, index) => `artifact_${index.toString(16).repeat(64)}`);

describe("Gate 3 browser authority", () => {
  it("accepts only the exact pending and terminal RunReference variants", () => {
    expect(validateRunReference({ ...runIdentity, reference_kind:"pending", status:"queued" }, runIdentity.project_id).status).toBe("queued");
    expect(validateRunReference({ ...runIdentity, reference_kind:"terminal", status:"succeeded", terminal_evidence_source:"mesa_terminal_metadata", terminal_metadata_digest:mesaDigest, verified_success:true, artifact_ids:artifactIds, cancel_outcome:null }, runIdentity.project_id).status).toBe("succeeded");
    expect(validateRunReference({ ...runIdentity, reference_kind:"terminal", status:"failed", terminal_evidence_source:"local_run_terminal_evidence", terminal_metadata_digest:localDigest, verified_success:false, cancel_outcome:null }, runIdentity.project_id).status).toBe("failed");
    expect(validateRunReference({ ...runIdentity, reference_kind:"terminal", status:"timed_out", terminal_evidence_source:"mesa_terminal_metadata", terminal_metadata_digest:mesaDigest, verified_success:false, cancel_outcome:"timed_out_before_cancel_effect" }, runIdentity.project_id).status).toBe("timed_out");
    expect(validateRunReference({ ...runIdentity, reference_kind:"terminal", status:"cancelled", terminal_evidence_source:"local_run_terminal_evidence", terminal_metadata_digest:localDigest, verified_success:false, cancel_outcome:"cancelled_before_dispatch" }, runIdentity.project_id).status).toBe("cancelled");
  });
  it("rejects RunReference field mixing and forged terminal success evidence", () => {
    const success = { ...runIdentity, reference_kind:"terminal", status:"succeeded", terminal_evidence_source:"mesa_terminal_metadata", terminal_metadata_digest:mesaDigest, verified_success:true, artifact_ids:artifactIds, cancel_outcome:null };
    const invalid = [
      { ...runIdentity, reference_kind:"pending", status:"running", verified_success:false },
      { ...success, artifact_ids:artifactIds.slice(0, 7) },
      { ...success, artifact_ids:[...artifactIds].reverse() },
      { ...success, terminal_evidence_source:"local_run_terminal_evidence", terminal_metadata_digest:localDigest },
      { ...success, verified_success:false },
      { ...success, terminal_metadata_digest:undefined },
      { ...runIdentity, reference_kind:"terminal", status:"failed", terminal_evidence_source:"mesa_terminal_metadata", terminal_metadata_digest:mesaDigest, verified_success:false, artifact_ids:[], cancel_outcome:null },
      { ...runIdentity, reference_kind:"terminal", status:"timed_out", terminal_evidence_source:"local_run_terminal_evidence", terminal_metadata_digest:localDigest, verified_success:false, cancel_outcome:null },
      { ...runIdentity, reference_kind:"terminal", status:"cancelled", terminal_evidence_source:"mesa_terminal_metadata", terminal_metadata_digest:mesaDigest, verified_success:false, cancel_outcome:null },
    ];
    invalid.forEach((candidate) => expect(() => validateRunReference(candidate, runIdentity.project_id)).toThrow());
    expect(() => validateRunReference(success, `project_${"f".repeat(32)}`)).toThrow();
  });
  it("verifies every projected run before accepting an otherwise valid projection digest", async () => {
    const state = project(4);
    state.project_id = runIdentity.project_id;
    state.runs = [{ ...runIdentity, reference_kind:"pending", status:"running" }];
    state.current.run_id = runIdentity.run_id;
    state.projection_digest = await projectionDigest(state);
    const envelope = { schema_id:"riff://evidence-studio/browser-projection-response/v1", schema_version:1, canonical_json_version:"riff-canonical-json-v2", project_id:state.project_id, snapshot_revision:state.snapshot_revision, projection_digest:state.projection_digest, projection:state } as const;
    await expect(verifyProjectionResponse(envelope)).resolves.toBe(state);
    const forged = structuredClone(state) as any;
    forged.runs[0].verified_success = false;
    forged.projection_digest = await projectionDigest(forged);
    await expect(verifyProjectionResponse({ ...envelope, projection_digest:forged.projection_digest, projection:forged })).rejects.toThrow("keyset");
  });
  it("canonicalizes keys and makes any newer snapshot stale a bound draft", () => { expect(canonicalJsonV2({b:1,a:-0})).toBe('{"a":0,"b":1}'); const binding=bindDraft(project(3),["e"]); expect(bindingIsStale(binding,project(3))).toBe(false); expect(bindingIsStale(binding,project(4))).toBe(true); });
  it("reloads gaps and unsupported patches before root replacement", async () => { const current=project(3); const gap=await reduceBrowserPatch(current,{schema_id:"riff://evidence-studio/browser-project-patch/v1",schema_version:1,canonical_json_version:"riff-canonical-json-v2",event_type:"browser.project.patch.v1",project_id:"project_1",base_snapshot_revision:3,snapshot_revision:5,projection_digest:"pd_x",operations:[{op:"replace",path:"",value:project(5)}]}); expect(gap.kind).toBe("reload"); });
  it("dispatches validation only by exact schema property type and enforces execution invariant", () => { const property=(type:"integer"|"number"|"boolean"): any=>({type,section_id:"s",display_order:1,unit:null,provenance:{},distribution_group_id:null,distribution_family:null,distribution_role:null,minimum:type==="boolean"?undefined:0,maximum:type==="boolean"?undefined:10}); const ps:any={required:["count","rate","flag"],properties:{count:property("integer"),rate:property("number"),flag:property("boolean")}}; const es:any={required:["horizon_days","warmup_days","seed"],properties:{horizon_days:property("integer"),warmup_days:property("integer"),seed:{...property("integer"),minimum:-2147483648,maximum:2147483647}}}; expect(validateDraft(ps,es,{count:2,rate:1.5,flag:false},{horizon_days:5,warmup_days:1,seed:0})).toEqual({}); expect(validateDraft(ps,es,{count:2.2,rate:1,flag:1 as any},{horizon_days:5,warmup_days:5,seed:0})).toMatchObject({count:"Must be an integer.",flag:"Must be true or false.",warmup_days:"Warm-up days must be less than horizon days."}); });
  it("sends only exact changed fields while reset defaults remain backend-owned", () => { const exp={parameters:{a:1,b:false},parameter_defaults:{a:0,b:false},execution_values:{horizon_days:5,warmup_days:1,seed:2}} as unknown as ExperimentRevision; expect(experimentChanges(exp,{a:3,b:false},{horizon_days:5,warmup_days:1,seed:9})).toEqual({parameter_changes:{a:3},execution_changes:{seed:9}}); });
  it("allows an objection only when authoritative open issues cover every exact subject", () => { const issues=[{issue_id:"i1",status:"open",subject_revision_ids:["a"]},{issue_id:"i2",status:"open",subject_revision_ids:["e"]},{issue_id:"i3",status:"closed",subject_revision_ids:["a","e"]}]; expect(objectionIssuesForSubjects(issues,["a","e"]).map((issue)=>issue.issue_id)).toEqual(["i1","i2"]); expect(objectionCoverage(issues,["a","e"],["i1"])).toBe(false); expect(objectionCoverage(issues,["a","e"],["i1","i2"])).toBe(true); expect(objectionCoverage(issues,["a","e"],["i3"])).toBe(false); });
  it("reloads duplicate/schema mismatch and enforces human issue permissions", async () => { const current=project(3); const base:any={schema_id:"riff://evidence-studio/browser-project-patch/v1",schema_version:1,canonical_json_version:"riff-canonical-json-v2",event_type:"browser.project.patch.v1",project_id:"project_1",base_snapshot_revision:2,snapshot_revision:3,projection_digest:"pd_x",operations:[{op:"replace",path:"",value:project(3)}]}; expect((await reduceBrowserPatch(current,base)).kind).toBe("reload"); expect(await reduceBrowserPatch(current,{...base,projection_digest:"pd_other"})).toMatchObject({kind:"reload",reason:"projection_changed_same_revision"}); expect(await reduceBrowserPatch(current,{...base,schema_version:2})).toMatchObject({kind:"reload",reason:"schema_mismatch"}); const issue={status:"open" as const,reporter_actor_id:"reporter",assignee_actor_id:"assignee"}; expect(issuePermissions(issue,{actor_id:"agent",actor_type:"agent",declared_role:"project_owner"})).toEqual({comment:true,assign:false,resolve:false,close:false,reopen:false}); expect(issuePermissions(issue,{actor_id:"owner",actor_type:"human",declared_role:"project_owner"})).toMatchObject({assign:true,resolve:true,close:true}); });
  it("never confirms unknown result IDs or the wrong event type", () => { const state=project(4); state.recent_command_results=[{command_id:"c",command_digest:"cmd_"+"a".repeat(64),command_digest_version:"gate2-command-digest-v1",event_type:"attestation.batch_created",committed_snapshot_revision:4,result_identity:{attestation_batch_id:"batch"}}]; const frozen:any={envelope:{command_id:"c"},command_digest:"cmd_"+"a".repeat(64),command_digest_version:"gate2-command-digest-v1",expected_event_type:"attestation.batch_created",expected_result_identity:{},observed_result_identity:null}; expect(commandReceiptConfirmed(state,frozen)).toBe(false); state.recent_command_results[0].event_type="issue.opened"; expect(commandReceiptConfirmed(state,{...frozen,expected_event_type:"attestation.batch_created"})).toBe(false); });
  it("confirms only the exact failed activation terminal receipt and fenced projection", () => { const state=project(8); const commandId="11111111-1111-4111-8111-111111111111"; const digest=`cmd_${"c".repeat(64)}`; const frozen:any={envelope:{command_id:commandId},command_digest:digest,command_digest_version:"gate3-command-digest-v2",expected_event_type:"model.activation_reconciled",expected_terminal_event_types:["model.activation_reconciled","model.activation_failed"],expected_result_identity:{activation_id:commandId},observed_result_identity:null}; state.model_activation={activation_id:commandId,source:{model_revision_id:"old",brief_revision_id:"d",alignment_revision_id:"a",experiment_revision_id:"e"},target:{model_revision_id:"new",brief_revision_id:"d",alignment_revision_id:"a",experiment_revision_id:"e"},status:"failed_fenced",run_admission_fenced:true,safe_error:{code:"mesa_adapter_failure",message:"failed",correlation_id:"corr"},intent_digest:"intent",candidate_digest:null,project_event_digest:null,switch_receipt_digest:null,reconcile_digest:null}; state.recent_command_results=[{command_id:commandId,command_digest:digest,command_digest_version:"gate3-command-digest-v2",event_type:"model.activation_failed",committed_snapshot_revision:8,result_identity:{activation_id:commandId,terminal_status:"failed_fenced"}}]; expect(commandReceiptConfirmed(state,frozen)).toBe(true); state.recent_command_results[0].result_identity.terminal_status="failed_no_effect"; expect(commandReceiptConfirmed(state,frozen)).toBe(false); });
});

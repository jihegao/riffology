import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BusinessRecordsView, prepareEvidencePresentation, ReplayView } from "./EvidenceStudioApp";
import type { ReplayPage } from "./types";

const source=(logical_name:string)=>({schema_id:"riff://evidence-studio/source-descriptor/v1",schema_version:1,canonical_json_version:"riff-canonical-json-v2",source_kind:"run_artifact",logical_name,sha256:"a".repeat(64),identity:{project_id:"project",model_revision_id:"model",brief_revision_id:"brief",alignment_revision_id:"alignment",experiment_revision_id:"experiment",run_id:"run"},href:`/api/projects/project/${logical_name}`}) as const;

const noFrames=(page_kind:"unavailable_population_limit"|"legacy_frameless"):ReplayPage=>({schema_id:"riff://evidence-studio/replay-page/v1",schema_version:1,canonical_json_version:"riff-canonical-json-v2",page_kind,project_id:"project",run_id:"run",event_source:source("domain-events.jsonl"),manifest_source:source("replay-manifest.json"),generator_version:page_kind==="legacy_frameless"?null:"wind-worker-sampled-replay-v1",source_set_digest:`replay_${"b".repeat(64)}`,sampling_algorithm:page_kind==="legacy_frameless"?null:"wind-replay-sample-days-v1",declared_population:page_kind==="legacy_frameless"?{turbine_count:0,crew_count:0}:{turbine_count:101,crew_count:1},sample_days:[],sample_days_sha256:page_kind==="legacy_frameless"?null:"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",frame_count:0,unavailable_reason:page_kind==="legacy_frameless"?"legacy_frameless_manifest":"population_exceeds_frame_contract",source_event_ranges:[],frames:[],after_frame:-1,next_after_frame:-1,has_more:false});

describe.each(["unavailable_population_limit","legacy_frameless"] as const)("%s replay presentation",(kind)=>{
  it("loads KPI preparation from authoritative request context without inventing a frame",async()=>{ const metricKeys=["availability_fraction","crew_utilization_fraction","corrective_queue_length","planned_queue_length","operating_count","working_crew_count","total_maintenance_cost","operating_revenue"]; const rows=[0,1,2].map((sim_time_days)=>Object.fromEntries([["sim_time_days",sim_time_days],...metricKeys.map((key)=>[key,0])])); const loaded={kpis:{columns:[{key:"sim_time_days"},...metricKeys.map((key)=>({key}))],rows,source:{sha256:"c".repeat(64)}},replay:noFrames(kind),replayContext:{warmup_days:1}} as any; const prepared=await prepareEvidencePresentation(loaded); expect(prepared.warmupDays).toBe(1); expect(prepared.sampling.source_indexes).toEqual([0,1,2]); expect(loaded.replay.frames).toEqual([]); });

  it("shows the source-backed reason as an availability non-claim with disabled controls",()=>{ render(<ReplayView page={noFrames(kind)} onSelect={vi.fn()}/>); expect(screen.getByRole("region",{name:"Source-backed replay unavailable"})).toBeInTheDocument(); expect(screen.getByText(kind==="legacy_frameless"?"legacy_frameless_manifest":"population_exceeds_frame_contract")).toBeInTheDocument(); expect(screen.getByText(/not evidence that no events occurred/)).toBeInTheDocument(); expect(screen.getAllByRole("button")).toHaveLength(3); for(const button of screen.getAllByRole("button")) expect(button).toBeDisabled(); expect(screen.queryByRole("img")).not.toBeInTheDocument(); });
});

it("projects real activation brief content and framed alignment mappings without flattening the exact records",()=>{
  const sourceRef={source_id:"source-1",kind:"user_declared",label:"Project owner"};
  const brief={schema_id:"riff://evidence-studio/decision-brief/activation-v1",schema_version:1,canonical_json_version:"riff-canonical-json-v2",project_id:"project",parent_brief_revision_id:"dbr_parent",source_brief_revision_id:"dbr_source",operation:"activation_copy",copy_rule:"exact_content_activation_copy_v1",content:{question:"How should the wind farm maintenance policy change?",decision_owner:"Wind Operations Director",objective:"Increase availability without presenting draft simulation as validated advice.",constraints:[],assumptions:[],non_goals:[],sources:[sourceRef]},created_by_actor_id:"actor_owner",created_at:"2026-07-21T00:00:00.000Z",decision_brief_revision_id:"dbr_current",decision_brief_digest:"dbrd_current"};
  const mapping={mapping_id:"mapping-1",business_ref:"availability",mapping_kind:"requirement",model_refs:["metric:availability_fraction"],rationale:"Bind the business objective to the model metric.",source:sourceRef};
  const alignment={schema_id:"riff://evidence-studio/alignment-map/framed/v1",schema_version:1,canonical_json_version:"riff-canonical-json-v2",project_id:"project",parent_alignment_revision_id:"amr_parent",brief_revision_id:"dbr_current",model_revision_id:"mr_current",migration_rule:"framed_alignment_rebind_v1",mappings:[mapping],gaps:[],source_refs:[sourceRef],created_by_actor_id:"actor_owner",created_at:"2026-07-21T00:00:00.000Z",alignment_revision_id:"amr_current",alignment_digest:"amd_current"};
  render(<BusinessRecordsView briefRecord={brief} alignmentRecord={alignment}/>);
  expect(screen.getByRole("heading",{name:brief.content.question})).toBeInTheDocument();
  expect(screen.getByText(/Wind Operations Director/,{selector:"p"})).toBeInTheDocument();
  expect(screen.getByText(brief.content.objective,{selector:"p"})).toBeInTheDocument();
  expect(screen.getByText("1 mappings · 0 known gaps")).toBeInTheDocument();
  expect(screen.getByText(/"content"/)).toBeInTheDocument();
  expect(screen.getByText(/"mappings"/)).toBeInTheDocument();
});

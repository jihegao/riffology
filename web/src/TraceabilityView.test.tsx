import { render,screen } from "@testing-library/react";
import { describe,expect,it } from "vitest";
import { TraceabilityView } from "./EvidenceStudioApp";
import type { BrowserProjectState,ModelViewSources } from "./types";

const descriptor=(logical_name:string)=>({schema_id:"riff://evidence-studio/source-descriptor/v1",schema_version:1,canonical_json_version:"riff-canonical-json-v2",source_kind:"model_bundle",logical_name,sha256:"a".repeat(64),identity:{project_id:"project",model_revision_id:"model",brief_revision_id:null,alignment_revision_id:null,experiment_revision_id:null,run_id:null},href:`/api/projects/project/${logical_name}`});
const sources={source_set_digest:"views",sources:{traceability:descriptor("traceability.json"),parameter_schema:descriptor("parameter-schema.json"),execution_field_schema:descriptor("execution-field-schema.json"),metric_schema:descriptor("metric-schema.json")},parameter_schema:{properties:{}},execution_field_schema:{properties:{}},metric_schema:{properties:{availability_fraction:{type:"number"}}},model_spec:{},traceability:{equipment_transitions:[],crew_transitions:[]}} as unknown as ModelViewSources;
const sourceRef={source_id:"source-1",kind:"user_declared",label:"Owner"};
const framed=(model_refs:string[])=>({schema_id:"riff://evidence-studio/alignment-map/framed/v1",schema_version:1,canonical_json_version:"riff-canonical-json-v2",project_id:"project",parent_alignment_revision_id:"amr_parent",brief_revision_id:"dbr_current",model_revision_id:"model",migration_rule:"framed_alignment_rebind_v1",mappings:[{mapping_id:"mapping-1",business_ref:"availability objective",mapping_kind:"requirement",model_refs,rationale:"Business metric binding",source:sourceRef}],gaps:[],source_refs:[sourceRef],created_by_actor_id:"actor",created_at:"2026-07-21T00:00:00.000Z",alignment_revision_id:"amr_current",alignment_digest:"amd_current"});
const state=(alignment_map:unknown)=>({current_records:{alignment_map,experiment:null}}) as unknown as BrowserProjectState;

describe("TraceabilityView authoritative alignment projection",()=>{
  it.each([
    ["absent",null],
    ["unknown",{schema_id:"riff://evidence-studio/alignment-map/unknown/v1"}],
    ["invalid framed",{...framed(["metric:availability_fraction"]),extra:true}],
  ])("fails closed for %s schema without rendering a pseudo-empty table",(_label,record)=>{
    render(<TraceabilityView sources={sources} state={state(record)}/>);
    expect(screen.getByRole("alert")).toHaveTextContent(/Traceability projection unavailable/);
    expect(screen.getByRole("alert")).toHaveTextContent(/No empty mapping projection is inferred/);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText(/All current alignment entries/)).not.toBeInTheDocument();
  });

  it("retains one authoritative mapping row when model_refs is legally empty",()=>{
    render(<TraceabilityView sources={sources} state={state(framed([]))}/>);
    expect(screen.getByText(/1 mappings · 0 gaps/)).toBeInTheDocument();
    const rows=screen.getAllByRole("row");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toHaveTextContent("— (none declared)");
    expect(rows[1]).toHaveTextContent("Unavailable: no model reference was declared");
    expect(rows[1]).toHaveTextContent("unresolved / no declared model ref");
  });

  it("keeps the normal framed exact-reference row source-bound",()=>{
    render(<TraceabilityView sources={sources} state={state(framed(["metric:availability_fraction"]))}/>);
    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(screen.getByText("metric:availability_fraction")).toBeInTheDocument();
    expect(screen.getByText("source-bound exact key")).toBeInTheDocument();
  });
});

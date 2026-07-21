import { describe,expect,it } from "vitest";
import { projectAlignmentMap,projectDecisionBrief } from "./business-records";

const source={source_id:"source-1",kind:"user_declared",label:"Owner"};
const briefFields={question:"Maintenance question",decision_owner:"Owner",objective:"Maintenance objective",constraints:[],assumptions:[],non_goals:[],sources:[source]};
const mapping={mapping_id:"mapping-1",business_ref:"objective",mapping_kind:"requirement",model_refs:["metric:availability_fraction"],rationale:"Exact metric binding",source};

describe("business record schema projections",()=>{
  it("supports the exact legacy brief and alignment schemas",()=>{
    const brief={schema_version:1,canonical_json_version:"riff-canonical-json-v2",decision_brief_revision_id:"dbr_legacy",project_id:"project",parent_decision_brief_revision_id:null,operation:"create",...briefFields,created_by_actor_id:"actor",created_at:"2026-07-21T00:00:00.000Z"};
    const alignment={schema_version:1,canonical_json_version:"riff-canonical-json-v2",alignment_map_revision_id:"amr_legacy",project_id:"project",parent_alignment_map_revision_id:null,operation:"create",decision_brief_revision_id:"dbr_legacy",model_id:"wind-turbine-maintenance",model_revision_id:"mr_legacy",entries:[mapping],known_gaps:[],created_by_actor_id:"actor",created_at:"2026-07-21T00:00:00.000Z"};
    expect(projectDecisionBrief(brief)).toMatchObject({schema_kind:"legacy",question:"Maintenance question",decision_owner:"Owner",objective:"Maintenance objective"});
    expect(projectAlignmentMap(alignment)).toMatchObject({schema_kind:"legacy",mappings:[mapping],gaps:[]});
  });

  it("fails closed instead of accepting old flattened activation/framed fixtures or extra fields",()=>{
    expect(projectDecisionBrief({schema_id:"riff://evidence-studio/decision-brief/activation-v1",schema_version:1,canonical_json_version:"riff-canonical-json-v2",decision_brief_revision_id:"dbr",...briefFields})).toBeNull();
    expect(projectAlignmentMap({schema_id:"riff://evidence-studio/alignment-map/framed/v1",schema_version:1,canonical_json_version:"riff-canonical-json-v2",alignment_revision_id:"amr",entries:[mapping],known_gaps:[]})).toBeNull();
    const legacy={schema_version:1,canonical_json_version:"riff-canonical-json-v2",decision_brief_revision_id:"dbr",project_id:"project",parent_decision_brief_revision_id:null,operation:"create",...briefFields,created_by_actor_id:"actor",created_at:"2026-07-21T00:00:00.000Z",extra:true};
    expect(projectDecisionBrief(legacy)).toBeNull();
  });
});

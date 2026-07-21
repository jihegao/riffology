import type { JsonObject } from "./types";

const plain=(value:unknown):value is JsonObject=>value!==null&&typeof value==="object"&&!Array.isArray(value);
const exact=(value:JsonObject,keys:string[])=>Object.keys(value).sort().join("\n")===[...keys].sort().join("\n");
const nullableString=(value:unknown)=>value===null||typeof value==="string";
const strings=(value:unknown)=>Array.isArray(value)&&value.every((item)=>typeof item==="string");
const source=(value:unknown):value is JsonObject=>plain(value)&&exact(value,"attachment_id" in value?["source_id","kind","label","attachment_id"]:["source_id","kind","label"])&&typeof value.source_id==="string"&&["user_declared","bundled_reference","uploaded_file"].includes(String(value.kind))&&typeof value.label==="string"&&(!("attachment_id" in value)||typeof value.attachment_id==="string");
const statements=(value:unknown)=>Array.isArray(value)&&value.every((item)=>plain(item)&&exact(item,["id","statement","source"])&&typeof item.id==="string"&&typeof item.statement==="string"&&source(item.source));
const content=(value:unknown):value is JsonObject=>plain(value)&&exact(value,["question","decision_owner","objective","constraints","assumptions","non_goals","sources"])&&typeof value.question==="string"&&typeof value.decision_owner==="string"&&typeof value.objective==="string"&&statements(value.constraints)&&statements(value.assumptions)&&strings(value.non_goals)&&Array.isArray(value.sources)&&value.sources.every(source);
const mapping=(value:unknown):value is JsonObject=>plain(value)&&exact(value,["mapping_id","business_ref","mapping_kind","model_refs","rationale","source"])&&typeof value.mapping_id==="string"&&typeof value.business_ref==="string"&&["requirement","assumption","constraint","non_goal"].includes(String(value.mapping_kind))&&strings(value.model_refs)&&typeof value.rationale==="string"&&source(value.source);
const gap=(value:unknown):value is JsonObject=>plain(value)&&exact(value,["gap_id","statement","blocking"])&&typeof value.gap_id==="string"&&typeof value.statement==="string"&&typeof value.blocking==="boolean";

const LEGACY_BRIEF_KEYS=["schema_version","canonical_json_version","decision_brief_revision_id","project_id","parent_decision_brief_revision_id","operation","question","decision_owner","objective","constraints","assumptions","non_goals","sources","created_by_actor_id","created_at"];
const ACTIVATION_BRIEF_KEYS=["schema_id","schema_version","canonical_json_version","project_id","parent_brief_revision_id","source_brief_revision_id","operation","copy_rule","content","created_by_actor_id","created_at","decision_brief_revision_id","decision_brief_digest"];
const LEGACY_ALIGNMENT_KEYS=["schema_version","canonical_json_version","alignment_map_revision_id","project_id","parent_alignment_map_revision_id","operation","decision_brief_revision_id","model_id","model_revision_id","entries","known_gaps","created_by_actor_id","created_at"];
const FRAMED_ALIGNMENT_KEYS=["schema_id","schema_version","canonical_json_version","project_id","parent_alignment_revision_id","brief_revision_id","model_revision_id","migration_rule","mappings","gaps","source_refs","created_by_actor_id","created_at","alignment_revision_id","alignment_digest"];

export type DecisionBriefProjection={schema_kind:"activation"|"legacy";question:string;decision_owner:string;objective:string};
export type AlignmentProjection={schema_kind:"framed"|"legacy";mappings:JsonObject[];gaps:JsonObject[]};

export function projectDecisionBrief(value:unknown):DecisionBriefProjection|null{
  if(!plain(value)) return null;
  if(value.schema_id==="riff://evidence-studio/decision-brief/activation-v1"){
    if(!exact(value,ACTIVATION_BRIEF_KEYS)||value.schema_version!==1||value.canonical_json_version!=="riff-canonical-json-v2"||value.operation!=="activation_copy"||value.copy_rule!=="exact_content_activation_copy_v1"||typeof value.project_id!=="string"||!nullableString(value.parent_brief_revision_id)||typeof value.source_brief_revision_id!=="string"||typeof value.created_by_actor_id!=="string"||typeof value.created_at!=="string"||typeof value.decision_brief_revision_id!=="string"||typeof value.decision_brief_digest!=="string"||!content(value.content)) return null;
    return {schema_kind:"activation",question:value.content.question as string,decision_owner:value.content.decision_owner as string,objective:value.content.objective as string};
  }
  if(!exact(value,LEGACY_BRIEF_KEYS)||value.schema_version!==1||value.canonical_json_version!=="riff-canonical-json-v2"||!["create","revise"].includes(String(value.operation))||typeof value.project_id!=="string"||!nullableString(value.parent_decision_brief_revision_id)||typeof value.created_by_actor_id!=="string"||typeof value.created_at!=="string"||typeof value.decision_brief_revision_id!=="string"||!content(Object.fromEntries(["question","decision_owner","objective","constraints","assumptions","non_goals","sources"].map((key)=>[key,value[key]])))) return null;
  return {schema_kind:"legacy",question:value.question as string,decision_owner:value.decision_owner as string,objective:value.objective as string};
}

export function projectAlignmentMap(value:unknown):AlignmentProjection|null{
  if(!plain(value)) return null;
  if(value.schema_id==="riff://evidence-studio/alignment-map/framed/v1"){
    if(!exact(value,FRAMED_ALIGNMENT_KEYS)||value.schema_version!==1||value.canonical_json_version!=="riff-canonical-json-v2"||value.migration_rule!=="framed_alignment_rebind_v1"||typeof value.project_id!=="string"||!nullableString(value.parent_alignment_revision_id)||typeof value.brief_revision_id!=="string"||typeof value.model_revision_id!=="string"||typeof value.created_by_actor_id!=="string"||typeof value.created_at!=="string"||!Array.isArray(value.mappings)||!value.mappings.every(mapping)||!Array.isArray(value.gaps)||!value.gaps.every(gap)||!Array.isArray(value.source_refs)||!value.source_refs.every(source)||typeof value.alignment_revision_id!=="string"||typeof value.alignment_digest!=="string") return null;
    return {schema_kind:"framed",mappings:value.mappings as JsonObject[],gaps:value.gaps as JsonObject[]};
  }
  if(!exact(value,LEGACY_ALIGNMENT_KEYS)||value.schema_version!==1||value.canonical_json_version!=="riff-canonical-json-v2"||!["create","revise"].includes(String(value.operation))||typeof value.project_id!=="string"||!nullableString(value.parent_alignment_map_revision_id)||typeof value.decision_brief_revision_id!=="string"||value.model_id!=="wind-turbine-maintenance"||typeof value.model_revision_id!=="string"||typeof value.created_by_actor_id!=="string"||typeof value.created_at!=="string"||!Array.isArray(value.entries)||!value.entries.every(mapping)||!Array.isArray(value.known_gaps)||!value.known_gaps.every(gap)||typeof value.alignment_map_revision_id!=="string") return null;
  return {schema_kind:"legacy",mappings:value.entries as JsonObject[],gaps:value.known_gaps as JsonObject[]};
}

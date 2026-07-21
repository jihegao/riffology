import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import metricSchema from "../../mesa_service/src/mesa_service/model_assets/wind_turbine_maintenance/metric-schema.json";
import { downsampleKpis, loadAllAttestations, loadCompleteRunPages, validateEvidenceIndex, validateEventPage, validateKpiPage, validateReplayPage, type ReplayValidationContext } from "./evidence";
import { canonicalJsonV2 } from "./state";
import type { EvidenceIndex, EventPage, KpiPage, ReplayPage, RunReference, SourceDescriptor, SucceededRunReference } from "./types";

const artifactIds = Array.from({ length: 8 }, (_, index) => `artifact_${index.toString(16).repeat(64)}`);
const artifactNames = ["request.json", "metadata.json", "daily-kpis.csv", "domain-events.jsonl", "summary.json", "replay-manifest.json", "derived-views-manifest.json", "run.log"];
const run: SucceededRunReference = { reference_kind:"terminal",status:"succeeded",project_id:`project_${"1".repeat(32)}`,run_id:`run_${"2".repeat(32)}`,model_id:"wind-turbine-maintenance",model_revision_id:`mr_${"3".repeat(64)}`,brief_revision_id:`dbr_${"4".repeat(64)}`,alignment_revision_id:`amr_${"5".repeat(64)}`,experiment_revision_id:`er_${"6".repeat(64)}`,preset_id:"wind-turbine-maintenance-demo-v1",seed:7,visibility:"private_draft",trust_label:"draft_unverified",workflow_label:"workflow_policy_met",policy_snapshot_digest:`ps_${"7".repeat(64)}`,run_admission_digest:`ra_${"8".repeat(64)}`,run_intent_digest:`ri_${"9".repeat(64)}`,terminal_evidence_source:"mesa_terminal_metadata",terminal_metadata_digest:`tm_${"a".repeat(64)}`,verified_success:true,artifact_ids:artifactIds,cancel_outcome:null };
const identity = { project_id:run.project_id,run_id:run.run_id,model_id:run.model_id,model_revision_id:run.model_revision_id,brief_revision_id:run.brief_revision_id,alignment_revision_id:run.alignment_revision_id,experiment_revision_id:run.experiment_revision_id,preset_id:run.preset_id,seed:run.seed,visibility:run.visibility,trust_label:run.trust_label,workflow_label:run.workflow_label,policy_snapshot_digest:run.policy_snapshot_digest,run_admission_digest:run.run_admission_digest };
const source = (logical_name:string, runOwned=true): SourceDescriptor => { const index=artifactNames.indexOf(logical_name); const artifactId=index>=0?artifactIds[index]:null; return {schema_id:"riff://evidence-studio/source-descriptor/v1",schema_version:1,canonical_json_version:"riff-canonical-json-v2",source_kind:runOwned?"run_artifact":"model_bundle",logical_name,sha256:index>=0?index.toString(16).repeat(64):"a".repeat(64),identity:runOwned?{project_id:run.project_id,model_revision_id:run.model_revision_id,brief_revision_id:run.brief_revision_id,alignment_revision_id:run.alignment_revision_id,experiment_revision_id:run.experiment_revision_id,run_id:run.run_id}:{project_id:run.project_id,model_revision_id:run.model_revision_id,brief_revision_id:null,alignment_revision_id:null,experiment_revision_id:null,run_id:null},href:artifactId?`/api/projects/${run.project_id}/artifacts/${artifactId}`:`/api/projects/${run.project_id}/${logical_name}`}; };
const filters = {event_type:"failure_occurred",turbine_id:"",crew_id:"",work_order_id:"",from_day:"1",to_day:"2"};
const eventPage = (): EventPage => ({schema_id:"riff://evidence-studio/filtered-domain-event-projection-page/v1",schema_version:1,canonical_json_version:"riff-canonical-json-v2",projection_kind:"filtered_domain_events",project_id:run.project_id,run_id:run.run_id,experiment_revision_id:run.experiment_revision_id,source:source("domain-events.jsonl"),filters:{event_type:"failure_occurred",turbine_id:null,crew_id:null,work_order_id:null,from_day:1,to_day:2},source_event_count:1,after:0,scanned_through_sequence:1,next_after:1,has_more:false,events:[{...identity,event_id:"event-00000001",sequence:1,sim_time_days:1,event_type:"failure_occurred",phase:10,turbine_id:"turbine-0001",crew_id:null,work_order_id:"work-00000001",correlation_id:"corr",before_state:"operating",after_state:"failed_waiting",payload:{}}]});
const domainEvent = (sequence:number) => ({...identity,event_id:`event-${String(sequence).padStart(8,"0")}`,sequence,sim_time_days:sequence,event_type:"failure_occurred",phase:10,turbine_id:"turbine-0001",crew_id:null,work_order_id:`work-${String(sequence).padStart(8,"0")}`,correlation_id:`corr-${sequence}`,before_state:"operating",after_state:"failed_waiting",payload:{}});
const eventsPage = (after:number, scanned:number, sourceCount:number, sequences:number[], hasMore=scanned<sourceCount): EventPage => ({...eventPage(),source_event_count:sourceCount,after,scanned_through_sequence:scanned,next_after:scanned,has_more:hasMore,events:sequences.map(domainEvent)});
const kpiPage = (): KpiPage => { const columns=[...Object.keys(identity),"sim_time_days"].map((key)=>({key,label:key,unit:null})); return {schema_id:"riff://evidence-studio/kpi-page/v1",schema_version:1,canonical_json_version:"riff-canonical-json-v2",project_id:run.project_id,run_id:run.run_id,experiment_revision_id:run.experiment_revision_id,source:source("daily-kpis.csv"),metric_schema_source:source("metric-schema.json",false),columns,rows:[{...identity,sim_time_days:0}],after_day:-1,next_after_day:0,has_more:false}; };
const sha=(value:string)=>createHash("sha256").update(value).digest("hex");
const sampleDigests=Array.from({length:5},(_,length)=>sha(canonicalJsonV2(Array.from({length},(_value,index)=>index))));
const metricProperties=metricSchema.properties as Record<string,Record<string,unknown>>;
const contextFor=(frameCount:number,turbineCount=1,crewCount=1):ReplayValidationContext=>({parameters:{farm_width_km:10,farm_height_km:10,turbine_count:turbineCount,crew_count:crewCount},horizon_days:frameCount-1,warmup_days:frameCount>2?1:0,runtime_profile:{},metric_properties:metricProperties});
const dailyMetrics=(day:number)=>{ const metrics=Object.fromEntries(Object.keys(metricProperties).map((name)=>[name,0])) as Record<string,number>; Object.assign(metrics,{sim_time_days:day,turbine_count:1,crew_count:1,operating_count:1,idle_crew_count:1,availability_fraction:1}); return metrics; };
const replayPage = (after:number, frameIndexes:number[], frameCount:number, hasMore=(frameIndexes.at(-1)??after)<frameCount-1): ReplayPage => { const context=contextFor(frameCount); const frames=frameIndexes.map((index)=>{ const phase=index===context.horizon_days?"horizon_end":index<context.warmup_days?"warmup":"measurement"; const frame={frame_index:index,identity:{...identity},day:index,phase,through_event_sequence:index+1,source_event_range_index:index,frame_state_sha256:"",depot:{x_km:0,y_km:0},turbines:[{turbine_id:"turbine-0001",x_km:0,y_km:0,state:"operating"}],crews:[{crew_id:"crew-001",x_km:0,y_km:0,state:"idle",turbine_id:null,work_order_id:null}],queues:{corrective:0,planned:0},daily_metrics:dailyMetrics(index)}; const preimage={schema_id:"riff://wind-turbine-maintenance/replay-frame-state/v1",schema_version:1,canonical_json_version:"riff-canonical-json-v2",model_id:run.model_id,model_revision_id:run.model_revision_id,experiment_revision_id:run.experiment_revision_id,preset_id:run.preset_id,seed:run.seed,day:frame.day,phase:frame.phase,depot:frame.depot,turbines:frame.turbines,crews:frame.crews,queues:frame.queues,daily_metrics:frame.daily_metrics}; frame.frame_state_sha256=`fs_${sha(canonicalJsonV2(preimage))}`; return frame; }); return {schema_id:"riff://evidence-studio/replay-page/v1",schema_version:1,canonical_json_version:"riff-canonical-json-v2",page_kind:"complete",project_id:run.project_id,run_id:run.run_id,event_source:source("domain-events.jsonl"),manifest_source:source("replay-manifest.json"),generator_version:"wind-worker-sampled-replay-v1",source_set_digest:"replay_3fad735e9c1522a062df4007be41d58505673d9a13e644265453c16aa566ff22",sampling_algorithm:"wind-replay-sample-days-v1",declared_population:{turbine_count:1,crew_count:1},sample_days:Array.from({length:frameCount},(_,index)=>index),sample_days_sha256:sampleDigests[frameCount],frame_count:frameCount,unavailable_reason:null,source_event_ranges:frameIndexes.map((index)=>({range_index:index,event_count:1,first_sequence:index+1,last_sequence:index+1,byte_offset:index*10,byte_length:10,raw_range_sha256:"c".repeat(64),semantic_range_sha256:"d".repeat(64)})),frames,after_frame:after,next_after_frame:frameIndexes.at(-1)??after,has_more:hasMore} as ReplayPage; };
const unavailableReplayPage = (): ReplayPage => ({...replayPage(-1,[],0,false),page_kind:"unavailable_population_limit",declared_population:{turbine_count:101,crew_count:1},unavailable_reason:"population_exceeds_frame_contract"});
const legacyReplayPage = (): ReplayPage => ({...replayPage(-1,[],0,false),page_kind:"legacy_frameless",generator_version:null,sampling_algorithm:null,declared_population:{turbine_count:0,crew_count:0},sample_days_sha256:null,unavailable_reason:"legacy_frameless_manifest"});
const evidenceIndex = (page=replayPage(-1,[0,1,2],3),eventCount=3): EvidenceIndex => { const artifacts=artifactNames.map((logical_name,index)=>({artifact_id:artifactIds[index],logical_name,sha256:index.toString(16).repeat(64),href:`/api/projects/${encodeURIComponent(run.project_id)}/artifacts/${artifactIds[index]}`})); return {schema_id:"riff://evidence-studio/run-evidence-index/v1",schema_version:1,canonical_json_version:"riff-canonical-json-v2",project_id:run.project_id,run:structuredClone(run),identity:{run_id:run.run_id,model_id:run.model_id,model_revision_id:run.model_revision_id,brief_revision_id:run.brief_revision_id,alignment_revision_id:run.alignment_revision_id,experiment_revision_id:run.experiment_revision_id,preset_id:run.preset_id,seed:run.seed,policy_snapshot_digest:run.policy_snapshot_digest,run_admission_digest:run.run_admission_digest,run_intent_digest:run.run_intent_digest},labels:{visibility:run.visibility,trust_label:run.trust_label,workflow_label:run.workflow_label,claim_labels:[],non_claims:[]},summary:{},replay_manifest_summary:{schema_id:"riff://evidence-studio/replay-manifest-summary/v1",schema_version:1,canonical_json_version:"riff-canonical-json-v2",manifest_kind:page.page_kind,manifest_sha256:page.manifest_source.sha256,generator_version:page.generator_version,sampling_algorithm:page.sampling_algorithm,event_source_sha256:page.event_source.sha256,event_semantic_sha256:"e".repeat(64),event_count:eventCount,frame_count:page.frame_count,sample_days_sha256:page.sample_days_sha256,claim_labels_sha256:sampleDigests[0],non_claims_sha256:page.page_kind==="legacy_frameless"?null:sampleDigests[0],unavailable_reason:page.unavailable_reason},derived_views_manifest:{},artifacts,source_links:artifacts.map((artifact)=>source(artifact.logical_name))}; };
const requestFor=(page:ReplayPage)=>{ const context=contextFor(Math.max(2,page.frame_count),page.page_kind==="legacy_frameless"?1:page.declared_population.turbine_count,page.page_kind==="legacy_frameless"?1:page.declared_population.crew_count); const experiment={schema_id:"riff://evidence-studio/experiment-revision/framed/v1",experiment_revision_id:run.experiment_revision_id,model_id:run.model_id,model_revision_id:run.model_revision_id,brief_revision_id:run.brief_revision_id,alignment_revision_id:run.alignment_revision_id,preset_id:run.preset_id,execution_values:{seed:run.seed,horizon_days:context.horizon_days,warmup_days:context.warmup_days},parameters:context.parameters,runtime_profile:context.runtime_profile}; return {...identity,experiment_sha256:sha(`${canonicalJsonV2(experiment)}\n`),run_intent_digest:run.run_intent_digest,downstream_request_digest:`rq_${"b".repeat(64)}`,experiment_document:experiment,run_admission:{},parameters:context.parameters,horizon_days:context.horizon_days,warmup_days:context.warmup_days,runtime_profile:context.runtime_profile,claim_labels:[]}; };
const completeClient = (eventPages: EventPage[], replayPages: ReplayPage[], evidence?:EvidenceIndex) => { const index=evidence??evidenceIndex(replayPages[0],eventPages[0].source_event_count); const request=requestFor(replayPages[0]); return {getEvidence:vi.fn(async()=>index),getKpis:vi.fn(async()=>kpiPage()),getEvents:vi.fn(async(_p:string,_r:string,_f:Record<string,string>,after=0)=>eventPages.find((page)=>page.after===after)!),getReplay:vi.fn(async(_p:string,_r:string,after=-1)=>replayPages.find((page)=>page.after_frame===after)!),getExactJsonSource:vi.fn(async(descriptor:SourceDescriptor)=>descriptor.logical_name==="request.json"?request:metricSchema)}; };

describe("evidence pagination and KPI golden rules", () => {
  it("keeps mandatory equal-index-floor points and digest", async () => { const small=Array.from({length:3},(_,sim_time_days)=>({sim_time_days,m:sim_time_days})); const smallSample=await downsampleKpis(small,["m"],1,"a".repeat(64)); expect(smallSample.source_indexes).toEqual([0,1,2]); expect(smallSample.downsampling_digest).toBe("daa3f797c95f8a5a9df835541bb1e953869e8aa4af2c432336a11c8f83fac932"); const rows=Array.from({length:401},(_,sim_time_days)=>({sim_time_days,m:sim_time_days===200?-10:sim_time_days===250?999:sim_time_days})); const sampled=await downsampleKpis(rows,["m"],100,"b".repeat(64)); expect(sampled.source_indexes.length).toBeLessThanOrEqual(300); expect(sampled.source_indexes).toEqual(expect.arrayContaining([0,100,200,250,400])); expect(sampled.downsampling_digest).toMatch(/^[0-9a-f]{64}$/); });
  it("requires the exact warm-up row", async () => { const rows=Array.from({length:301},(_,index)=>({sim_time_days:index*2,m:index})); await expect(downsampleKpis(rows,["m"],1,"c".repeat(64))).rejects.toThrow("warm-up"); });
  it("loads every exact attestation page with cursor continuity", async () => { const item=(id:string)=>({attestation_id:id,actor:{actor_id:"actor",display_name:"Actor",actor_type:"human",declared_role:"project_owner",assurance:"declared_unauthenticated_local"},subject_revision_ids:["subject"],scope:"workflow_progression",decision:"endorse",rationale:"reviewed",issue_refs:[],created_at:"2026-07-21T00:00:00.000Z",supersedes_attestation_id:null,superseded_by_attestation_id:null,effective_head:true,record_digest:`digest-${id}`}); const pageBase={schema_id:"riff://evidence-studio/attestation-detail-page/v1",schema_version:1,canonical_json_version:"riff-canonical-json-v2",project_id:"project",subject_revision_id:"subject"}; const getAttestations=vi.fn(async (_p:string,_s:string,after?:string|null)=>after?{...pageBase,after:"a",next_after:null,has_more:false,items:[item("b")]}:{...pageBase,after:null,next_after:"a",has_more:true,items:[item("a")]}); const page=await loadAllAttestations({getAttestations} as any,"project","subject"); expect(page.items.map((value:any)=>value.attestation_id)).toEqual(["a","b"]); expect(getAttestations).toHaveBeenCalledTimes(2); });
  it("rejects an attestation response from a selection that was aborted while awaiting the page", async () => { let resolvePage!:(value:any)=>void; let observedSignal:AbortSignal|undefined; const response=new Promise((resolve)=>{resolvePage=resolve;}); const getAttestations=vi.fn((_p:string,_s:string,_after:string|null,signal?:AbortSignal)=>{observedSignal=signal; return response;}); const controller=new AbortController(); const pending=loadAllAttestations({getAttestations} as any,"project","subject",controller.signal); controller.abort(); resolvePage({schema_id:"riff://evidence-studio/attestation-detail-page/v1",schema_version:1,canonical_json_version:"riff-canonical-json-v2",project_id:"project",subject_revision_id:"subject",after:null,next_after:null,has_more:false,items:[]}); await expect(pending).rejects.toMatchObject({name:"AbortError"}); expect(observedSignal).toBe(controller.signal); });
  it("binds event filters and every framed event field to the exact selected run", () => { expect(()=>validateEventPage(eventPage(),run.project_id,run,filters,0)).not.toThrow(); const wrongFilters=eventPage(); wrongFilters.filters.event_type=null; expect(()=>validateEventPage(wrongFilters,run.project_id,run,filters,0)).toThrow("active exact request"); const wrongRun=eventPage(); wrongRun.events[0].model_revision_id="other"; expect(()=>validateEventPage(wrongRun,run.project_id,run,filters,0)).toThrow("complete selected-run identity"); });
  it("binds KPI rows and replay frame identities to the complete selected run", () => { const columns=[...Object.keys(identity),"sim_time_days"].map((key)=>({key,label:key,unit:null})); const kpi={schema_id:"riff://evidence-studio/kpi-page/v1",schema_version:1,canonical_json_version:"riff-canonical-json-v2",project_id:run.project_id,run_id:run.run_id,experiment_revision_id:run.experiment_revision_id,source:source("daily-kpis.csv"),metric_schema_source:source("metric-schema.json",false),columns,rows:[{...identity,sim_time_days:0}],after_day:-1,next_after_day:0,has_more:false} as KpiPage; expect(()=>validateKpiPage(kpi,run.project_id,run,-1)).not.toThrow(); kpi.rows[0].brief_revision_id="wrong"; expect(()=>validateKpiPage(kpi,run.project_id,run,-1)).toThrow("complete selected-run identity"); const replay=replayPage(-1,[0,1],2); expect(()=>validateReplayPage(replay,run.project_id,run,-1,undefined,contextFor(2))).not.toThrow(); replay.frames[0].identity.policy_snapshot_digest="wrong"; expect(()=>validateReplayPage(replay,run.project_id,run,-1,undefined,contextFor(2))).toThrow("complete selected-run identity"); });
  it("validates finite selected metrics even below 300 rows", async () => { await expect(downsampleKpis([{sim_time_days:0,m:Number.NaN}], ["m"], 0, "d".repeat(64))).rejects.toThrow("not finite"); });
});

describe("fail-closed exact run evidence", () => {
  it("reuses the strict RunReference validator and accepts only the exact selected succeeded run", () => {
    expect(() => validateEvidenceIndex(evidenceIndex(), run.project_id, run)).not.toThrow();
    const loose = evidenceIndex() as any; loose.run.extra = true;
    expect(() => validateEvidenceIndex(loose, run.project_id, run)).toThrow("keyset");
    const invalid = evidenceIndex() as any; invalid.run.artifact_ids = [...artifactIds].reverse();
    expect(() => validateEvidenceIndex(invalid, run.project_id, run)).toThrow("terminal contract");
    const wrongRun = evidenceIndex() as any; wrongRun.run = { ...run, run_intent_digest:`ri_${"f".repeat(64)}` };
    expect(() => validateEvidenceIndex(wrongRun, run.project_id, run)).toThrow("evidence run");
  });

  it.each([
    ["seven", (value:EvidenceIndex) => { value.artifacts.pop(); }],
    ["nine", (value:EvidenceIndex) => { value.artifacts.push(structuredClone(value.artifacts[0])); }],
    ["duplicate", (value:EvidenceIndex) => { value.artifacts[1].artifact_id=value.artifacts[0].artifact_id; value.artifacts[1].href=value.artifacts[0].href; }],
    ["malformed", (value:EvidenceIndex) => { value.artifacts[0].artifact_id="artifact_bad"; value.artifacts[0].href=`/api/projects/${run.project_id}/artifacts/artifact_bad`; }],
    ["wrong ID", (value:EvidenceIndex) => { const wrong=`artifact_${"f".repeat(64)}`; value.artifacts[0].artifact_id=wrong; value.artifacts[0].href=`/api/projects/${run.project_id}/artifacts/${wrong}`; }],
    ["wrong ordered name", (value:EvidenceIndex) => { [value.artifacts[0].logical_name,value.artifacts[1].logical_name]=[value.artifacts[1].logical_name,value.artifacts[0].logical_name]; }],
  ])("rejects %s evidence artifacts before projection rendering", (_label, mutate) => { const value=evidenceIndex(); mutate(value); expect(() => validateEvidenceIndex(value,run.project_id,run)).toThrow(); });

  it("loads normal multi-page events and replay only after complete count proof", async () => {
    const client=completeClient([eventsPage(0,2,3,[1,2]),eventsPage(2,3,3,[3])],[replayPage(-1,[0,1],3),replayPage(1,[2],3)]);
    const loaded=await loadCompleteRunPages(client as any,run.project_id,run,filters);
    expect(loaded.events.events.map((event)=>event.sequence)).toEqual([1,2,3]);
    expect(loaded.events.scanned_through_sequence).toBe(loaded.events.source_event_count);
    expect(loaded.replay.frames.map((frame)=>frame.frame_index)).toEqual([0,1,2]);
    expect(loaded.replay.frames).toHaveLength(loaded.replay.frame_count);
  });

  it("accepts only the exact unavailable and legacy replay discriminator branches", async () => {
    for (const page of [unavailableReplayPage(),legacyReplayPage()]) { const context=page.page_kind==="unavailable_population_limit"?contextFor(2,101,1):undefined; expect(()=>validateReplayPage(page,run.project_id,run,-1,undefined,context)).not.toThrow(); const loaded=await loadCompleteRunPages(completeClient([eventsPage(0,1,1,[1])],[page]) as any,run.project_id,run,filters); expect(loaded.replay.page_kind).toBe(page.page_kind); expect(loaded.replay.frames).toHaveLength(0); }
  });

  it.each([
    ["unknown page_kind",(page:ReplayPage)=>{ (page as any).page_kind="other"; }],
    ["null complete generator",(page:ReplayPage)=>{ page.generator_version=null; }],
    ["wrong complete generator",(page:ReplayPage)=>{ (page as any).generator_version="wrong"; }],
    ["null complete sampling",(page:ReplayPage)=>{ page.sampling_algorithm=null; }],
    ["wrong complete sampling",(page:ReplayPage)=>{ (page as any).sampling_algorithm="wrong"; }],
    ["null complete sample digest",(page:ReplayPage)=>{ page.sample_days_sha256=null; }],
    ["complete unavailable reason",(page:ReplayPage)=>{ (page as any).unavailable_reason="population_exceeds_frame_contract"; }],
    ["unavailable without reason",(page:ReplayPage)=>{ Object.assign(page,unavailableReplayPage(),{unavailable_reason:null}); }],
    ["unavailable pretending complete",(page:ReplayPage)=>{ Object.assign(page,unavailableReplayPage(),{frame_count:1,sample_days:[0],sample_days_sha256:sampleDigests[1],frames:replayPage(-1,[0],1).frames,source_event_ranges:replayPage(-1,[0],1).source_event_ranges,next_after_frame:0}); }],
    ["legacy framed generator",(page:ReplayPage)=>{ Object.assign(page,legacyReplayPage(),{generator_version:"wind-worker-sampled-replay-v1"}); }],
  ])("rejects replay discriminator drift: %s",(_label,mutate)=>{ const page=replayPage(-1,[0,1],2); mutate(page); expect(()=>validateReplayPage(page,run.project_id,run,-1,undefined,contextFor(2))).toThrow(); });

  it("rejects a well-formed but wrong complete sample-days digest and evidence-summary drift", async () => {
    const page=replayPage(-1,[0,1],2); page.sample_days_sha256="f".repeat(64); const client=completeClient([eventsPage(0,2,2,[1,2])],[page],evidenceIndex(page,2)); await expect(loadCompleteRunPages(client as any,run.project_id,run,filters)).rejects.toThrow("sample-days digest");
    const correct=replayPage(-1,[0,1],2); const evidence=evidenceIndex(correct,2); (evidence.replay_manifest_summary as any).generator_version="wrong"; await expect(loadCompleteRunPages(completeClient([eventsPage(0,2,2,[1,2])],[correct],evidence) as any,run.project_id,run,filters)).rejects.toThrow();
  });

  it.each([
    ["turbine population length",(page:ReplayPage)=>{ page.frames[0].turbines=[]; }],
    ["crew population length",(page:ReplayPage)=>{ page.frames[0].crews=[]; }],
    ["turbine extra field",(page:ReplayPage)=>{ (page.frames[0].turbines[0] as any).extra=true; }],
    ["turbine ID",(page:ReplayPage)=>{ page.frames[0].turbines[0].turbine_id="bad"; }],
    ["turbine state",(page:ReplayPage)=>{ page.frames[0].turbines[0].state="unknown"; }],
    ["turbine coordinate type",(page:ReplayPage)=>{ (page.frames[0].turbines[0] as any).x_km="0"; }],
    ["crew extra field",(page:ReplayPage)=>{ (page.frames[0].crews[0] as any).extra=true; }],
    ["crew ID",(page:ReplayPage)=>{ page.frames[0].crews[0].crew_id="bad"; }],
    ["crew state",(page:ReplayPage)=>{ page.frames[0].crews[0].state="unknown"; }],
    ["crew work order",(page:ReplayPage)=>{ page.frames[0].crews[0].work_order_id="bad"; }],
  ])("rejects replay entity/population drift: %s",(_label,mutate)=>{ const page=replayPage(-1,[0,1],2); mutate(page); expect(()=>validateReplayPage(page,run.project_id,run,-1,undefined,contextFor(2))).toThrow(); });

  it.each([
    ["later event descriptor sha",(page:ReplayPage)=>{ page.event_source.sha256="f".repeat(64); }],
    ["later manifest descriptor href",(page:ReplayPage)=>{ page.manifest_source.href=`/api/projects/${run.project_id}/artifacts/${artifactIds[0]}`; }],
  ])("rejects %s drift even when source_set_digest is reused",async(_label,mutate)=>{ const first=replayPage(-1,[0,1],3); const second=replayPage(1,[2],3); mutate(second); await expect(loadCompleteRunPages(completeClient([eventsPage(0,3,3,[1,2,3])],[first,second]) as any,run.project_id,run,filters)).rejects.toThrow("source provenance"); });

  it.each([
    ["claim labels",(evidence:EvidenceIndex)=>{ evidence.labels.claim_labels=["substituted"]; }],
    ["non-claims",(evidence:EvidenceIndex)=>{ evidence.labels.non_claims=["substituted"]; }],
    ["claim digest",(evidence:EvidenceIndex)=>{ (evidence.replay_manifest_summary as any).claim_labels_sha256="f".repeat(64); }],
    ["non-claim digest",(evidence:EvidenceIndex)=>{ (evidence.replay_manifest_summary as any).non_claims_sha256="f".repeat(64); }],
  ])("rejects replay %s provenance drift",async(_label,mutate)=>{ const page=replayPage(-1,[0],1); const evidence=evidenceIndex(page,1); mutate(evidence); await expect(loadCompleteRunPages(completeClient([eventsPage(0,1,1,[1])],[page],evidence) as any,run.project_id,run,filters)).rejects.toThrow("label provenance"); });

  it("rejects complete ranges whose final sequence is short or long",async()=>{
    const shortFirst=replayPage(-1,[0,1],3); const shortLast=replayPage(1,[2],3); await expect(loadCompleteRunPages(completeClient([eventsPage(0,4,4,[1,2,3,4])],[shortFirst,shortLast]) as any,run.project_id,run,filters)).rejects.toThrow("exactly cover");
    const longFirst=replayPage(-1,[0,1],3); const longLast=replayPage(1,[2],3); longLast.source_event_ranges[0].event_count=2; longLast.source_event_ranges[0].last_sequence=4; longLast.frames[0].through_event_sequence=4; await expect(loadCompleteRunPages(completeClient([eventsPage(0,3,3,[1,2,3])],[longFirst,longLast]) as any,run.project_id,run,filters)).rejects.toThrow("exactly cover");
  });

  it.each([
    ["early has_more=false", [eventsPage(0,2,4,[1,2],false)]],
    ["cursor gap", [eventsPage(0,2,4,[1,2]),eventsPage(3,4,4,[4])]],
    ["sequence overlap", [eventsPage(0,2,4,[1,2]),eventsPage(2,4,4,[2,4])]],
    ["sequence duplicate", [eventsPage(0,2,2,[1,1])]],
    ["source count mismatch", [eventsPage(0,2,4,[1,2]),eventsPage(2,5,5,[3,4,5])]],
  ])("rejects event pagination with %s", async (_label,pages) => { const client=completeClient(pages,[replayPage(-1,[0],1)]); await expect(loadCompleteRunPages(client as any,run.project_id,run,filters)).rejects.toThrow(); });

  it.each([
    ["frame gap", [replayPage(-1,[0,2],3)]],
    ["frame duplicate", [replayPage(-1,[0,0],2)]],
    ["early has_more=false", [replayPage(-1,[0,1],3,false)]],
    ["frame count mismatch", [replayPage(-1,[0,1],3),replayPage(1,[2,3],4)]],
  ])("rejects replay pagination with %s", async (_label,pages) => { const client=completeClient([eventsPage(0,1,1,[1])],pages); await expect(loadCompleteRunPages(client as any,run.project_id,run,filters)).rejects.toThrow(); });

  it.each([
    ["first_sequence gap",(page:ReplayPage)=>{ page.source_event_ranges[0].first_sequence=4; page.source_event_ranges[0].last_sequence=4; page.frames[0].through_event_sequence=4; }],
    ["first_sequence overlap",(page:ReplayPage)=>{ page.source_event_ranges[0].first_sequence=2; page.source_event_ranges[0].last_sequence=2; page.frames[0].through_event_sequence=2; }],
    ["byte_offset gap",(page:ReplayPage)=>{ page.source_event_ranges[0].byte_offset=21; }],
    ["byte_offset overlap",(page:ReplayPage)=>{ page.source_event_ranges[0].byte_offset=19; }],
  ])("rejects cross-page replay range %s",async(_label,mutate)=>{ const first=replayPage(-1,[0,1],3); const second=replayPage(1,[2],3); mutate(second); await expect(loadCompleteRunPages(completeClient([eventsPage(0,1,1,[1])],[first,second]) as any,run.project_id,run,filters)).rejects.toThrow("contiguous"); });

  it.each([
    ["daily-metric exact schema",(page:ReplayPage)=>{ (page.frames[0].daily_metrics as any).extra=0; }],
    ["daily-metric finite value",(page:ReplayPage)=>{ page.frames[0].daily_metrics.availability_fraction=Number.NaN; }],
    ["daily-metric integer declaration",(page:ReplayPage)=>{ page.frames[0].daily_metrics.operating_count=1.5; }],
    ["queue aggregate",(page:ReplayPage)=>{ page.frames[0].queues.corrective=1; }],
    ["entity aggregate",(page:ReplayPage)=>{ page.frames[0].daily_metrics.operating_count=0; }],
    ["farm coordinate bound",(page:ReplayPage)=>{ page.frames[0].turbines[0].x_km=10.1; }],
    ["experiment phase boundary",(page:ReplayPage)=>{ page.frames[0].phase="measurement"; }],
  ])("mirrors the backend frame validator for %s",(_label,mutate)=>{ const page=replayPage(-1,[0,1,2],3); mutate(page); expect(()=>validateReplayPage(page,run.project_id,run,-1,undefined,contextFor(3))).toThrow(); });

  it("recomputes frame-state SHA-256 from the full backend canonical preimage",async()=>{ const page=replayPage(-1,[0,1],2); page.frames[0].frame_state_sha256=`fs_${"f".repeat(64)}`; await expect(loadCompleteRunPages(completeClient([eventsPage(0,2,2,[1,2])],[page],evidenceIndex(page,2)) as any,run.project_id,run,filters)).rejects.toThrow("frame-state digest"); });

  it("rejects selected experiment identity drift from the exact run request source",async()=>{ const page=replayPage(-1,[0,1],2); const client=completeClient([eventsPage(0,2,2,[1,2])],[page],evidenceIndex(page,2)); const original=client.getExactJsonSource; client.getExactJsonSource=vi.fn(async(descriptor:SourceDescriptor)=>{ const value=await original(descriptor); return descriptor.logical_name==="request.json"?{...value,experiment_revision_id:`er_${"f".repeat(64)}`}:value; }); await expect(loadCompleteRunPages(client as any,run.project_id,run,filters)).rejects.toThrow("selected-run identity"); });
});

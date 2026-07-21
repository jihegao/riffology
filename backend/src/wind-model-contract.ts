import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { ApiError } from "./errors.ts";
import { canonicalJsonV2, sha256Hex, type CanonicalJsonScalar } from "./canonical-json-v2.ts";
import type { WindModelContract, WindParameterRule } from "./durable-project-types.ts";

type JsonRecord = Record<string, any>;
const EXPECTED_FILES = ["model.py", "model-spec.json", "parameter-schema.json", "metric-schema.json", "visualization.json", "traceability.json", "provenance.json", "defaults/source-field-service-reference.json", "defaults/wind-turbine-maintenance-demo-v1.json", "tests/microcase.json", "tests/source-transition-disposition.json"] as const;
const exactKeys = (value: unknown, keys: readonly string[], message: string): void => { let plain = false; try { plain = value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); } catch { plain = false; } if (!plain) throw new ApiError(502, "mesa_invalid_model", message); let actual: string[]; try { actual = Object.keys(value as JsonRecord).sort(); } catch { throw new ApiError(502, "mesa_invalid_model", message); } const expected = [...keys].sort(); if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new ApiError(502, "mesa_invalid_model", message); };
const canonicalV1Value = (value: any): any => Array.isArray(value) ? value.map(canonicalV1Value) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalV1Value(value[key])])) : value;
const canonicalV1 = (value: unknown): Buffer => Buffer.from(JSON.stringify(canonicalV1Value(value)), "utf8");
const canonicalExperimentV1 = (value: any, floatParameters: Set<string>, path: string[] = []): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new ApiError(502, "mesa_invalid_model", "The default experiment contains a non-finite number."); return path.length === 2 && path[0] === "parameters" && floatParameters.has(path[1]) && Number.isInteger(value) ? `${value}.0` : JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map((item, index) => canonicalExperimentV1(item, floatParameters, [...path, String(index)])).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalExperimentV1(value[key], floatParameters, [...path, key])}`).join(",")}}`;
  throw new ApiError(502, "mesa_invalid_model", "The default experiment contains an unsupported value.");
};

const readJson = (path: string): JsonRecord => {
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(502, "mesa_invalid_model", "The materialized wind bundle contains an invalid JSON record.");
  return value as JsonRecord;
};

const assertSafePath = (root: string, path: string): void => {
  const normalizedRoot = resolve(root);
  const normalized = resolve(path);
  const rel = relative(normalizedRoot, normalized);
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new ApiError(500, "unsafe_workspace", "A wind bundle path leaves its project workspace.");
  let cursor = normalized;
  while (cursor.length >= normalizedRoot.length) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new ApiError(500, "unsafe_workspace", "A wind bundle path contains a symbolic link.");
    if (cursor === normalizedRoot) break;
    cursor = dirname(cursor);
  }
};

export const loadVerifiedWindModelContract = (workspaceRoot: string, projectId: string, expected?: { model_revision_id?: string; experiment_revision_id?: string; preset_id?: string; historical_model_revision_id?: string }): WindModelContract => {
  if (!/^project_[0-9a-f]{32}$/u.test(projectId)) throw new ApiError(404, "resource_not_found", "The project was not found.");
  const projectRoot = join(resolve(workspaceRoot), "projects", projectId);
  const activePath = join(projectRoot, "models", "active.json");
  assertSafePath(projectRoot, activePath);
  if (!existsSync(activePath) || !lstatSync(activePath).isFile()) throw new ApiError(502, "mesa_invalid_model", "Mesa did not materialize an active wind model.");
  const active = readJson(activePath);
  if (active.model_id !== "wind-turbine-maintenance" || !/^mr_[0-9a-f]{64}$/u.test(active.model_revision_id) || !/^er_[0-9a-f]{64}$/u.test(active.experiment_revision_id) || active.preset_id !== "wind-turbine-maintenance-demo-v1") throw new ApiError(502, "mesa_invalid_model", "Mesa returned an invalid active wind identity.");
  if (!expected?.historical_model_revision_id && (expected?.model_revision_id && active.model_revision_id !== expected.model_revision_id || expected?.experiment_revision_id && active.experiment_revision_id !== expected.experiment_revision_id || expected?.preset_id && active.preset_id !== expected.preset_id)) throw new ApiError(502, "mesa_invalid_model", "Mesa active wind identity differs from its bootstrap response.");
  const selectedRevision = expected?.historical_model_revision_id ?? active.model_revision_id;

  const bundle = join(projectRoot, "models", "wind-turbine-maintenance", "revisions", selectedRevision);
  assertSafePath(projectRoot, bundle);
  const actualFiles: string[] = []; const walk = (directory: string): void => { for (const entry of readdirSync(directory).sort()) { const path = join(directory, entry); assertSafePath(bundle, path); const info = lstatSync(path); if (info.isSymbolicLink()) throw new ApiError(500, "unsafe_workspace", "The wind bundle contains a symbolic link."); if (info.isDirectory()) walk(path); else if (info.isFile()) actualFiles.push(relative(bundle, path).split(sep).join("/")); else throw new ApiError(500, "unsafe_workspace", "The wind bundle contains a non-regular entry."); } }; walk(bundle);
  const requiredWithManifest = ["manifest.json", ...EXPECTED_FILES].sort(); if (actualFiles.sort().join("\n") !== requiredWithManifest.join("\n")) throw new ApiError(502, "mesa_invalid_model", "The wind bundle file set is not exact.");
  const manifestPath = join(bundle, "manifest.json"); const manifestBytes = readFileSync(manifestPath); const manifest = readJson(manifestPath); exactKeys(manifest, ["schema_version", "model_id", "model_revision_id", "runtime_profile", "files"], "The wind bundle manifest keys are not exact.");
  if (!canonicalV1(manifest).equals(manifestBytes.subarray(0, manifestBytes.length - 1)) || manifestBytes.at(-1) !== 0x0a || manifest.schema_version !== 1 || manifest.model_id !== active.model_id || manifest.model_revision_id !== selectedRevision || !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) throw new ApiError(502, "mesa_invalid_model", "The wind bundle manifest identity or encoding is invalid.");
  exactKeys(manifest.files, EXPECTED_FILES, "The wind bundle declarations are not exact.");
  for (const name of EXPECTED_FILES) {
    const declaration = manifest.files[name] as JsonRecord; if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) throw new ApiError(502, "mesa_invalid_model", "A wind bundle declaration is invalid."); exactKeys(declaration, ["sha256", "byte_length", "media_type"], "A wind bundle declaration is not exact.");
    const path = join(bundle, name); const bytes = readFileSync(path); const expectedMedia = name === "model.py" ? "text/x-python" : "application/json";
    if (!/^[0-9a-f]{64}$/u.test(declaration.sha256) || declaration.media_type !== expectedMedia || declaration.byte_length !== bytes.byteLength || sha256Hex(bytes) !== declaration.sha256) throw new ApiError(500, "immutable_record_corrupt", "The materialized wind bundle differs from its exact manifest.");
  }
  const runtime = manifest.runtime_profile as JsonRecord; if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) throw new ApiError(502, "mesa_invalid_model", "The wind runtime profile is invalid."); exactKeys(runtime, ["python_implementation", "python_major_minor", "mesa_version", "model_protocol_version", "canonical_json_version"], "The wind runtime profile is not exact.");
  if (!Object.values(runtime).every((value) => typeof value === "string" && value.length > 0) || runtime.model_protocol_version !== "wind-turbine-maintenance-v1" || runtime.canonical_json_version !== "rfc8259-sort-keys-compact-v1") throw new ApiError(502, "mesa_invalid_model", "The wind runtime profile is invalid.");
  const computedRevision = `mr_${sha256Hex(canonicalV1({ model_id: active.model_id, runtime_profile: runtime, files: manifest.files }))}`; if (computedRevision !== selectedRevision) throw new ApiError(500, "immutable_record_corrupt", "The model revision does not match the exact bundle declarations.");

  const parameterSchema = readJson(join(bundle, "parameter-schema.json"));
  const metricSchema = readJson(join(bundle, "metric-schema.json"));
  const modelSpec = readJson(join(bundle, "model-spec.json"));
  const traceability = readJson(join(bundle, "traceability.json"));
  const parameterProperties = parameterSchema.properties as Record<string, JsonRecord>; if (!parameterProperties || typeof parameterProperties !== "object" || Array.isArray(parameterProperties)) throw new ApiError(502, "mesa_invalid_model", "The wind parameter contract is incomplete.");
  if (expected?.historical_model_revision_id) {
    const preset = readJson(join(bundle, "defaults/wind-turbine-maintenance-demo-v1.json")); const properties = parameterProperties; if (!Array.isArray(parameterSchema.required) || Object.keys(properties).sort().join() !== [...parameterSchema.required].sort().join() || Object.keys(properties).sort().join() !== Object.keys(preset.parameters ?? {}).sort().join()) throw new ApiError(502, "mesa_invalid_model", "The historical wind parameter contract is incomplete."); const parameterRules: Record<string, WindParameterRule> = {}; for (const [name, definition] of Object.entries(properties)) parameterRules[name] = { type: definition.type, ...(typeof definition.minimum === "number" ? { minimum: definition.minimum } : {}), ...(typeof definition.maximum === "number" ? { maximum: definition.maximum } : {}) } as WindParameterRule; const modelRefs = new Set<string>([...Object.keys(properties).map((name) => `parameter:${name}`), ...Object.keys(metricSchema.properties ?? {}).map((name) => `metric:${name}`), ...Object.keys(modelSpec).map((name) => `mechanism:${name}`)]); for (const family of [traceability.equipment_transitions, traceability.crew_transitions]) for (const item of Array.isArray(family) ? family : []) if (typeof item.target_rule === "string") modelRefs.add(`mechanism:${item.target_rule}`); return { model_id: "wind-turbine-maintenance", model_revision_id: selectedRevision, preset_id: "wind-turbine-maintenance-demo-v1", parameter_defaults: structuredClone(preset.parameters), execution_defaults: { horizon_days: preset.horizon_days, warmup_days: preset.warmup_days, seed: preset.seed }, runtime_profile: structuredClone(runtime), parameter_rules: parameterRules, allowed_model_refs: [...modelRefs].sort() };
  }

  const experimentPath = join(projectRoot, "experiments", "revisions", active.experiment_revision_id, "experiment.json");
  assertSafePath(projectRoot, experimentPath);
  const experimentBytes = readFileSync(experimentPath);
  const experiment = JSON.parse(experimentBytes.toString("utf8")) as JsonRecord;
  const floatParameters = new Set<string>(Object.entries(parameterProperties).filter(([, definition]) => definition.type === "number").map(([name]) => name)); const canonicalV1Bytes = Buffer.from(canonicalExperimentV1(experiment, floatParameters), "utf8"); const expectedBytes = Buffer.concat([canonicalV1Bytes, Buffer.from("\n")]);
  const preset = readJson(join(bundle, "defaults/wind-turbine-maintenance-demo-v1.json")); const expectedDefault = { ...preset, model_id: active.model_id, model_revision_id: active.model_revision_id, brief_revision_id: null, alignment_revision_id: null, workflow_policy: "workflow_policy_unmet", trust_label: "draft_unverified", runtime_profile: runtime };
  if (!experimentBytes.equals(expectedBytes) || !canonicalJsonV2(experiment).equals(canonicalJsonV2(expectedDefault)) || `er_${sha256Hex(canonicalV1Bytes)}` !== active.experiment_revision_id || experiment.preset_id !== active.preset_id) throw new ApiError(500, "immutable_record_corrupt", "The Gate 1 default experiment identity or exact bytes are invalid.");
  const properties = parameterProperties;
  if (!properties || !Array.isArray(parameterSchema.required) || Object.keys(properties).sort().join() !== [...parameterSchema.required].sort().join() || Object.keys(properties).sort().join() !== Object.keys(experiment.parameters ?? {}).sort().join()) throw new ApiError(502, "mesa_invalid_model", "The wind parameter contract is incomplete.");
  const parameterRules: Record<string, WindParameterRule> = {};
  for (const [name, definition] of Object.entries(properties)) {
    if (!["number", "integer", "boolean", "string"].includes(definition.type)) throw new ApiError(502, "mesa_invalid_model", "The wind parameter schema contains an unsupported type.");
    parameterRules[name] = { type: definition.type, ...(typeof definition.minimum === "number" ? { minimum: definition.minimum } : {}), ...(typeof definition.maximum === "number" ? { maximum: definition.maximum } : {}) } as WindParameterRule;
  }
  const modelRefs = new Set<string>([
    ...Object.keys(properties).map((name) => `parameter:${name}`),
    ...Object.keys(metricSchema.properties ?? {}).map((name) => `metric:${name}`),
    ...Object.keys(modelSpec).map((name) => `mechanism:${name}`),
  ]);
  for (const family of [traceability.equipment_transitions, traceability.crew_transitions]) for (const item of Array.isArray(family) ? family : []) if (typeof item.target_rule === "string") modelRefs.add(`mechanism:${item.target_rule}`);
  return {
    model_id: "wind-turbine-maintenance",
    model_revision_id: active.model_revision_id,
    preset_id: active.preset_id,
    parameter_defaults: structuredClone(experiment.parameters) as Record<string, CanonicalJsonScalar>,
    execution_defaults: { horizon_days: experiment.horizon_days, warmup_days: experiment.warmup_days, seed: experiment.seed },
    runtime_profile: structuredClone(experiment.runtime_profile) as Record<string, CanonicalJsonScalar>,
    parameter_rules: parameterRules,
    allowed_model_refs: [...modelRefs].sort(),
  };
};

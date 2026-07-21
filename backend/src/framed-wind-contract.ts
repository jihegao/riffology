import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { ApiError } from "./errors.ts";
import { canonicalJsonV2, sha256Hex, type CanonicalJsonScalar } from "./canonical-json-v2.ts";
import type { WindModelContract, WindParameterRule } from "./durable-project-types.ts";

export const FRAMED_BUNDLE_FILES = [
  "model.py", "model-spec.json", "parameter-schema.json", "execution-field-schema.json",
  "metric-schema.json", "visualization.json", "traceability.json", "provenance.json",
  "defaults/source-field-service-reference.json", "defaults/wind-turbine-maintenance-demo-v1.json",
  "tests/microcase.json", "tests/source-transition-disposition.json",
] as const;
export const FRAMED_RUNTIME_PROFILE = { canonical_json_version: "riff-canonical-json-v2", mesa_version: "3.5.1", model_protocol_version: "wind-turbine-maintenance-v2-framed-replay", python_implementation: "CPython", python_major_minor: "3.12" } as const;

type Plain = Record<string, any>;
const plain = (value: unknown): value is Plain => value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value: unknown, keys: readonly string[]): asserts value is Plain => { if (!plain(value) || Object.keys(value).sort().join("\n") !== [...keys].sort().join("\n")) throw new ApiError(500, "immutable_record_corrupt", "The framed wind contract schema is not exact."); };
const fail = (message: string): never => { throw new ApiError(500, "immutable_record_corrupt", message); };
const expectedMedia = (name: string): string => name === "model.py" ? "text/x-python" : "application/json";

const safeRoot = (workspaceRoot: string, projectId: string, root: string): { project: string; root: string } => {
  const project = realpathSync(join(workspaceRoot, "projects", projectId));
  if (!existsSync(root)) fail("The framed wind bundle is missing.");
  const rel = relative(project, root); if (!rel || rel.startsWith(`..${sep}`) || rel === "..") fail("The framed wind bundle escapes its project.");
  let cursor = project; for (const part of rel.split(sep)) { cursor = join(cursor, part); const stat = lstatSync(cursor); if (stat.isSymbolicLink()) fail("A framed wind bundle ancestor is a symlink."); }
  if (!lstatSync(root).isDirectory() || realpathSync(root) !== root) fail("The framed wind bundle path is unsafe."); return { project, root };
};

const exactTree = (root: string): void => {
  const rootNames = ["defaults", "execution-field-schema.json", "manifest.json", "metric-schema.json", "model-spec.json", "model.py", "parameter-schema.json", "provenance.json", "tests", "traceability.json", "visualization.json"];
  if (readdirSync(root).sort().join("\n") !== rootNames.sort().join("\n")) fail("The framed wind bundle contains undeclared root entries.");
  for (const [directory, names] of [["defaults", ["source-field-service-reference.json", "wind-turbine-maintenance-demo-v1.json"]], ["tests", ["microcase.json", "source-transition-disposition.json"]]] as const) {
    const path = join(root, directory); if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory() || readdirSync(path).sort().join("\n") !== [...names].sort().join("\n")) fail("The framed wind bundle directory tree is not exact.");
  }
};

const canonicalDocument = (root: string, name: string, maximum = 512 * 1024): { bytes: Buffer; value: Plain } => {
  const path = join(root, name); if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile() || dirname(realpathSync(path)) !== dirname(path)) fail("A framed wind source is not a safe regular file.");
  const bytes = readFileSync(path); if (bytes.byteLength > maximum || bytes.at(-1) !== 0x0a) fail("A framed wind JSON source exceeds its bound or lacks final LF.");
  let value: unknown; try { value = JSON.parse(bytes.subarray(0, -1).toString("utf8")); } catch { fail("A framed wind JSON source is invalid."); }
  if (!plain(value) || !canonicalJsonV2(value).equals(bytes.subarray(0, -1))) fail("A framed wind JSON source is not canonical-v2."); return { bytes, value };
};

export type VerifiedFramedBundle = { root: string; manifest: Plain; files: Map<string, Buffer>; contract: WindModelContract };

export const verifyFramedWindBundle = (workspaceRoot: string, projectId: string, options: { captured_activation_id?: string; model_revision_id?: string } = {}): VerifiedFramedBundle => {
  const project = realpathSync(join(workspaceRoot, "projects", projectId)); let active: Plain; try { active = JSON.parse(readFileSync(join(project, "models", "active.json"), "utf8")); } catch { fail("The active model pointer is invalid."); } if (!plain(active)) fail("The active model pointer is invalid."); const revision = options.model_revision_id ?? String(active.model_revision_id);
  const requested = options.captured_activation_id ? join(project, "activations", options.captured_activation_id, "captured-candidate", revision) : join(project, "models", "wind-turbine-maintenance", "revisions", revision); const root = safeRoot(workspaceRoot, projectId, requested).root; exactTree(root);
  const { bytes: manifestBytes, value: manifest } = canonicalDocument(root, "manifest.json"); exact(manifest, ["schema_version", "bundle_protocol", "model_id", "model_revision_id", "runtime_profile", "files"]);
  if (manifest.schema_version !== 2 || manifest.bundle_protocol !== "wind-turbine-maintenance-bundle-v2-framed" || manifest.model_id !== "wind-turbine-maintenance" || manifest.model_revision_id !== revision || !plain(manifest.files) || !canonicalJsonV2(manifest.runtime_profile).equals(canonicalJsonV2(FRAMED_RUNTIME_PROFILE))) fail("The framed wind manifest is invalid.");
  if (Object.keys(manifest.files).sort().join("\n") !== [...FRAMED_BUNDLE_FILES].sort().join("\n")) fail("The framed wind file set is invalid.");
  const files = new Map<string, Buffer>(); let total = manifestBytes.byteLength;
  for (const name of FRAMED_BUNDLE_FILES) {
    const declaration = manifest.files[name]; exact(declaration, ["sha256", "byte_length", "media_type"]); const path = join(root, name);
    if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile() || realpathSync(path) !== path) fail("A framed wind file is unsafe.");
    const bytes = readFileSync(path); total += bytes.byteLength; if (declaration.sha256 !== sha256Hex(bytes) || declaration.byte_length !== bytes.byteLength || declaration.media_type !== expectedMedia(name) || bytes.byteLength > 512 * 1024) fail("A framed wind file differs from its manifest.");
    if (name !== "model.py") {
      if (bytes.at(-1) !== 0x0a || bytes.at(-2) === 0x0a) fail("A framed wind JSON source must have exactly one final LF.");
      const payload = bytes.subarray(0, -1); let value: unknown;
      try { value = JSON.parse(payload.toString("utf8")); } catch { fail("A framed wind JSON source is invalid."); }
      if (!plain(value) || !canonicalJsonV2(value).equals(payload)) fail("A framed wind JSON source is not exact canonical-v2.");
    }
    files.set(name, bytes);
  }
  if (total > 4 * 1024 * 1024) fail("The framed wind bundle exceeds its total byte bound.");
  const preimage = { schema_version: 2, bundle_protocol: manifest.bundle_protocol, model_id: manifest.model_id, runtime_profile: manifest.runtime_profile, files: manifest.files }; if (`mr_${sha256Hex(canonicalJsonV2(preimage))}` !== revision) fail("The framed wind revision digest is invalid.");
  const parsed = (name: string): Plain => JSON.parse(files.get(name)!.toString("utf8")); const schema = parsed("parameter-schema.json"); const preset = parsed("defaults/wind-turbine-maintenance-demo-v1.json"); const execution = parsed("execution-field-schema.json"); const modelSpec = parsed("model-spec.json"); const metric = parsed("metric-schema.json"); const traceability = parsed("traceability.json");
  if (!plain(schema.properties) || !plain(preset.parameters) || Object.keys(schema.properties).sort().join() !== Object.keys(preset.parameters).sort().join() || !plain(execution) || !plain(modelSpec) || !plain(metric)) fail("The framed parameter schema and preset differ.");
  const parameterRules: Record<string, WindParameterRule> = {}; for (const [name, property] of Object.entries(schema.properties) as Array<[string, Plain]>) { if (!plain(property) || !["integer", "number", "boolean"].includes(property.type)) fail("A framed parameter type is unsupported."); const value = preset.parameters[name]; if (property.type === "boolean" ? typeof value !== "boolean" : typeof value !== "number" || !Number.isFinite(value) || property.type === "integer" && !Number.isInteger(value) || value < property.minimum || value > property.maximum) fail("A framed preset value is invalid."); parameterRules[name] = { type: property.type, ...(typeof property.minimum === "number" ? { minimum: property.minimum } : {}), ...(typeof property.maximum === "number" ? { maximum: property.maximum } : {}) }; }
  const refs = new Set<string>([...Object.keys(schema.properties).map((name) => `parameter:${name}`), ...Object.keys(metric.properties ?? {}).map((name) => `metric:${name}`), ...Object.keys(modelSpec).map((name) => `mechanism:${name}`)]); for (const family of [traceability.equipment_transitions, traceability.crew_transitions]) for (const item of Array.isArray(family) ? family : []) if (plain(item) && typeof item.target_rule === "string") refs.add(`mechanism:${item.target_rule}`);
  const contract: WindModelContract = { model_id: "wind-turbine-maintenance", model_revision_id: revision, preset_id: "wind-turbine-maintenance-demo-v1", parameter_defaults: structuredClone(preset.parameters) as Record<string, CanonicalJsonScalar>, execution_defaults: { horizon_days: Number(preset.horizon_days), warmup_days: Number(preset.warmup_days), seed: Number(preset.seed) }, runtime_profile: structuredClone(manifest.runtime_profile), parameter_rules: parameterRules, allowed_model_refs: [...refs].sort() };
  return { root, manifest, files, contract };
};

export const loadVerifiedFramedWindModelContract = (workspaceRoot: string, projectId: string, options: { captured_activation_id?: string; model_revision_id?: string } = {}): WindModelContract => verifyFramedWindBundle(workspaceRoot, projectId, options).contract;

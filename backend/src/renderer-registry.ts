import { parseCanonicalJsonV2 } from "./canonical-json-v2.ts";

export type RendererDto =
  | Readonly<{ kind: "markdown"; title: string; text: string }>
  | Readonly<{ kind: "code"; title: string; language: string; text: string }>
  | Readonly<{ kind: "json"; title: string; value: unknown }>
  | Readonly<{
      kind: "table";
      title: string;
      caption: string;
      columns: readonly string[];
      rows: readonly (readonly string[])[];
    }>
  | Readonly<{
      kind: "chart";
      title: string;
      summary: string;
      categoryLabel: string;
      valueLabel: string;
      rows: readonly Readonly<{ category: string; value: number }>[];
    }>
  | Readonly<{
      kind: "diagram";
      title: string;
      summary: string;
      nodes: readonly Readonly<{ id: string; label: string; groupId?: string; sourceRefs?: readonly string[] }>[];
      edges: readonly Readonly<{ from: string; to: string; label?: string; sourceRefs?: readonly string[] }>[];
      groups?: readonly Readonly<{ id: string; label: string; sourceRefs?: readonly string[] }>[];
    }>
  | Readonly<{
      kind: "attachment";
      title: string;
      mediaType: string;
      sizeBytes: number;
      sha256: string;
      reason: "active_content" | "unsupported_media";
    }>;

export class RendererRegistryError extends Error {
  readonly code = "renderer_limit_exceeded";
  constructor(message: string) {
    super(message);
    this.name = "RendererRegistryError";
  }
}

export const rendererDto = (input: Readonly<{
  title: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  bytes: Uint8Array;
}>): RendererDto => {
  if (input.bytes.byteLength !== input.sizeBytes || input.sizeBytes > 2_097_152) {
    limit("The declared resource exceeds the renderer byte limit.");
  }
  const title = safeLabel(input.title, 300, "Resource");
  const mediaType = input.mediaType.toLowerCase();
  if (mediaType === "text/markdown") {
    if (input.sizeBytes > 1_048_576) limit("Markdown exceeds the renderer byte limit.");
    const text = utf8(input.bytes);
    if (text.split(/\r?\n/u).length > 50_000) limit("Markdown exceeds the renderer node limit.");
    return Object.freeze({ kind: "markdown", title, text });
  }
  if (CODE_MEDIA_TYPES.has(mediaType)) {
    if (input.sizeBytes > 1_048_576) limit("Code exceeds the renderer byte limit.");
    const text = utf8(input.bytes);
    if (text.split(/\r?\n/u).length > 20_000) limit("Code exceeds the renderer line limit.");
    return Object.freeze({ kind: "code", title, language: languageFor(mediaType), text });
  }
  if (mediaType === "text/csv") {
    const rows = csvRows(utf8(input.bytes));
    if (rows.length < 1) return Object.freeze({
      kind: "table",
      title,
      caption: title,
      columns: Object.freeze([]),
      rows: Object.freeze([]),
    });
    const columns = rows[0]!;
    const body = rows.slice(1);
    if (columns.length > 100 || new Set(columns).size !== columns.length || body.length > 2_000
      || rows.some((row) => row.length !== columns.length
        || row.some((cell) => cell.length > 16_384))) {
      limit("Table exceeds the renderer row, column, or cell limit.");
    }
    return Object.freeze({
      kind: "table",
      title,
      caption: title,
      columns: Object.freeze(columns),
      rows: Object.freeze(body.map((row) => Object.freeze(row))),
    });
  }
  if (mediaType === "application/json"
    || mediaType === "application/vnd.riff.chart+json"
    || mediaType === "application/vnd.riff.diagram+json") {
    const value = jsonValue(utf8(input.bytes));
    if (mediaType === "application/vnd.riff.chart+json") return chartDto(title, value);
    if (mediaType === "application/vnd.riff.diagram+json") return diagramDto(title, value);
    return Object.freeze({ kind: "json", title, value });
  }
  return Object.freeze({
    kind: "attachment",
    title,
    mediaType,
    sizeBytes: input.sizeBytes,
    sha256: input.sha256,
    reason: ACTIVE_MEDIA_TYPES.has(mediaType) ? "active_content" : "unsupported_media",
  });
};

const CODE_MEDIA_TYPES = new Set([
  "text/plain",
  "text/x-python",
  "text/javascript",
  "text/typescript",
]);
const ACTIVE_MEDIA_TYPES = new Set(["text/html", "image/svg+xml"]);

const utf8 = (bytes: Uint8Array): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new RendererRegistryError("The resource is not valid UTF-8.");
  }
};

const jsonValue = (text: string): unknown => {
  let value: unknown;
  try {
    value = parseCanonicalJsonV2(text);
  } catch {
    throw new RendererRegistryError("The resource is not valid JSON.");
  }
  let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > 50_000 || depth > 32) limit("JSON exceeds the renderer structure limit.");
    if (Array.isArray(item)) item.forEach((child) => visit(child, depth + 1));
    else if (item && typeof item === "object") Object.values(item).forEach((child) => visit(child, depth + 1));
  };
  visit(value, 0);
  return value;
};

const chartDto = (title: string, value: unknown): RendererDto => {
  const record = object(value);
  const rows = Array.isArray(record.rows) ? record.rows.map((item) => {
    const row = object(item);
    if (typeof row.category !== "string" || typeof row.value !== "number"
      || !Number.isFinite(row.value)) limit("Chart rows are invalid.");
    return Object.freeze({ category: safeLabel(row.category, 4_096, "Category"), value: row.value });
  }) : [];
  if (rows.length > 10_000
    || new Set(rows.map((row) => row.category)).size !== rows.length) {
    limit("Chart exceeds the renderer mark or category identity limit.");
  }
  return Object.freeze({
    kind: "chart",
    title,
    summary: safeLabel(record.summary, 8_000, "Declared chart data."),
    categoryLabel: safeLabel(record.categoryLabel, 200, "Category"),
    valueLabel: safeLabel(record.valueLabel, 200, "Value"),
    rows: Object.freeze(rows),
  });
};

const diagramDto = (title: string, value: unknown): RendererDto => {
  const record = object(value);
  const nodes = Array.isArray(record.nodes) ? record.nodes.map((item) => {
    const node = object(item);
    return Object.freeze({
      id: safeLabel(node.id, 200, ""),
      label: safeLabel(node.label, 4_096, ""),
      ...(typeof node.groupId === "string" ? { groupId: safeLabel(node.groupId, 200, "") } : {}),
      ...(safeReferences(node.sourceRefs) ? { sourceRefs: Object.freeze(node.sourceRefs) } : {}),
    });
  }) : [];
  const edges = Array.isArray(record.edges) ? record.edges.map((item) => {
    const edge = object(item);
    return Object.freeze({
      from: safeLabel(edge.from, 200, ""),
      to: safeLabel(edge.to, 200, ""),
      ...(typeof edge.label === "string" ? { label: safeLabel(edge.label, 4_096, "") } : {}),
      ...(safeReferences(edge.sourceRefs) ? { sourceRefs: Object.freeze(edge.sourceRefs) } : {}),
    });
  }) : [];
  const groups = Array.isArray(record.groups) ? record.groups.map((item) => {
    const group = object(item);
    return Object.freeze({
      id: safeLabel(group.id, 200, ""),
      label: safeLabel(group.label, 4_096, ""),
      ...(safeReferences(group.sourceRefs) ? { sourceRefs: Object.freeze(group.sourceRefs) } : {}),
    });
  }) : [];
  if (nodes.length > 2_000 || edges.length > 4_000) limit("Diagram exceeds the renderer graph limit.");
  const ids = new Set(nodes.map((node) => node.id));
  const groupIds = new Set(groups.map((group) => group.id));
  if (ids.size !== nodes.length || groupIds.size !== groups.length
    || nodes.some((node) => node.groupId !== undefined && !groupIds.has(node.groupId))
    || edges.some((edge) => !ids.has(edge.from) || !ids.has(edge.to))) {
    limit("Diagram node and edge identities are invalid.");
  }
  return Object.freeze({
    kind: "diagram",
    title,
    summary: safeLabel(record.summary, 8_000, "Declared diagram."),
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
    ...(groups.length ? { groups: Object.freeze(groups) } : {}),
  });
};

const safeReferences = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= 256
  && value.every((reference) => typeof reference === "string" && reference.length <= 4_096
    && !/[\u0000-\u001f\u007f]/u.test(reference));

const csvRows = (text: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted && character === "\"" && text[index + 1] === "\"") {
      cell += "\"";
      index += 1;
    } else if (character === "\"") {
      quoted = !quoted;
    } else if (!quoted && character === ",") {
      row.push(cell); cell = "";
    } else if (!quoted && (character === "\n" || character === "\r")) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell); rows.push(row); row = []; cell = "";
      if (rows.length > 2_002) limit("Table exceeds the renderer row limit.");
    } else {
      cell += character;
      if (cell.length > 16_384) limit("Table exceeds the renderer cell limit.");
    }
  }
  if (quoted) throw new RendererRegistryError("The CSV resource has an unterminated quoted cell.");
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
};

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RendererRegistryError("The renderer document must be one JSON object.");
  }
  return value as Record<string, unknown>;
};
const safeLabel = (value: unknown, max: number, fallback: string): string =>
  typeof value === "string" && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : fallback;
const languageFor = (mediaType: string): string =>
  mediaType === "text/x-python" ? "python"
    : mediaType === "text/javascript" ? "javascript"
      : mediaType === "text/typescript" ? "typescript"
        : "text";
const limit = (message: string): never => { throw new RendererRegistryError(message); };

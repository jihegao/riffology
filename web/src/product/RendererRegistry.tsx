import type { ReactNode } from "react";

export type RendererResource =
  | Readonly<{ kind: "markdown"; title: string; text: string }>
  | Readonly<{ kind: "code"; title: string; language: string; text: string }>
  | Readonly<{ kind: "json"; title: string; value: unknown }>
  | Readonly<{
      kind: "table";
      title: string;
      caption: string;
      columns: readonly string[];
      rows: readonly (readonly unknown[])[];
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
      nodes: readonly Readonly<{ id: string; label: string }>[];
      edges: readonly Readonly<{ from: string; to: string; label?: string }>[];
    }>
  | Readonly<{
      kind: "attachment";
      title: string;
      mediaType: string;
      sizeBytes: number;
      sha256: string;
      reason: "active_content" | "unsupported_media";
    }>;

export function RendererRegistry({ resource }: Readonly<{ resource: RendererResource }>) {
  const issue = rendererIssue(resource);
  if (issue) {
    return (
      <section className="product-renderer product-renderer-error" role="status">
        <h3>{resource.title}</h3>
        <p>{issue}</p>
      </section>
    );
  }
  switch (resource.kind) {
    case "markdown":
      return <MarkdownRenderer resource={resource} />;
    case "code":
      return (
        <section className="product-renderer">
          <h3>{resource.title}</h3>
          <pre><code data-language={safeLanguage(resource.language)}>{resource.text}</code></pre>
        </section>
      );
    case "json":
      return (
        <section className="product-renderer">
          <h3>{resource.title}</h3>
          <pre><code data-language="json">{JSON.stringify(resource.value, null, 2)}</code></pre>
        </section>
      );
    case "table":
      return <TableRenderer resource={resource} />;
    case "chart":
      return <ChartRenderer resource={resource} />;
    case "diagram":
      return <DiagramRenderer resource={resource} />;
    case "attachment":
      return (
        <section className="product-renderer" role="status">
          <h3>{resource.title}</h3>
          <p>
            Inline rendering is unavailable for {resource.mediaType} ({resource.reason}).
            The resource remains opaque.
          </p>
          <p>{resource.sizeBytes} bytes · SHA-256 <code>{resource.sha256}</code></p>
        </section>
      );
  }
}

const MarkdownRenderer = ({
  resource,
}: Readonly<{ resource: Extract<RendererResource, { kind: "markdown" }> }>) => (
  <section className="product-renderer">
    <h3>{resource.title}</h3>
    <div className="product-markdown">
      {resource.text.split(/\r?\n/u).map((line, index): ReactNode => {
        const key = `${index}:${line.slice(0, 24)}`;
        if (line.startsWith("### ")) return <h6 key={key}>{inlineText(line.slice(4))}</h6>;
        if (line.startsWith("## ")) return <h5 key={key}>{inlineText(line.slice(3))}</h5>;
        if (line.startsWith("# ")) return <h4 key={key}>{inlineText(line.slice(2))}</h4>;
        if (line.startsWith("- ")) return <p className="product-markdown-list" key={key}>• {inlineText(line.slice(2))}</p>;
        return line ? <p key={key}>{inlineText(line)}</p> : <span aria-hidden="true" key={key} />;
      })}
    </div>
  </section>
);

const TableRenderer = ({
  resource,
}: Readonly<{ resource: Extract<RendererResource, { kind: "table" }> }>) => (
  <section className="product-renderer">
    <h3>{resource.title}</h3>
    <div
      className="product-table-scroll"
      role="region"
      aria-label={`${resource.title} scrollable table`}
      tabIndex={0}
    >
      <table>
        <caption>{resource.caption}</caption>
        <thead><tr>{resource.columns.map((column) => <th scope="col" key={column}>{column}</th>)}</tr></thead>
        <tbody>
          {resource.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {resource.columns.map((column, columnIndex) => columnIndex === 0
                ? <th scope="row" key={column}>{cellText(row[columnIndex])}</th>
                : <td key={column}>{cellText(row[columnIndex])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </section>
);

const ChartRenderer = ({
  resource,
}: Readonly<{ resource: Extract<RendererResource, { kind: "chart" }> }>) => {
  const maximum = Math.max(1, ...resource.rows.map((row) => Math.abs(row.value)));
  return (
    <section className="product-renderer">
      <h3>{resource.title}</h3>
      <p>{resource.summary}</p>
      <div className="product-bars" role="img" aria-label={resource.summary}>
        {resource.rows.map((row) => (
          <div key={row.category}>
            <span>{row.category}</span>
            <i style={{ width: `${Math.max(1, Math.abs(row.value) / maximum * 100)}%` }} />
            <strong>{row.value}</strong>
          </div>
        ))}
      </div>
      <TableRenderer resource={{
        kind: "table",
        title: `${resource.title} data`,
        caption: `Accessible data for ${resource.title}`,
        columns: [resource.categoryLabel, resource.valueLabel],
        rows: resource.rows.map((row) => [row.category, row.value]),
      }} />
    </section>
  );
};

const DiagramRenderer = ({
  resource,
}: Readonly<{ resource: Extract<RendererResource, { kind: "diagram" }> }>) => {
  const labels = new Map(resource.nodes.map((node) => [node.id, node.label]));
  return (
    <section className="product-renderer">
      <h3>{resource.title}</h3>
      <p>{resource.summary}</p>
      <TableRenderer resource={{
        kind: "table",
        title: `${resource.title} connections`,
        caption: `Accessible connections for ${resource.title}`,
        columns: ["From", "Relationship", "To"],
        rows: resource.edges.map((edge) => [
          labels.get(edge.from) ?? edge.from,
          edge.label ?? "connects to",
          labels.get(edge.to) ?? edge.to,
        ]),
      }} />
    </section>
  );
};

const rendererIssue = (resource: RendererResource): string | null => {
  if (resource.kind === "markdown" || resource.kind === "code") {
    if (new TextEncoder().encode(resource.text).byteLength > 1_048_576) {
      return "renderer_limit_exceeded: this text is too large to render safely.";
    }
    if (resource.kind === "code" && resource.text.split(/\r?\n/u).length > 20_000) {
      return "renderer_limit_exceeded: this code has too many lines.";
    }
    if (resource.kind === "markdown" && resource.text.split(/\r?\n/u).length > 50_000) {
      return "renderer_limit_exceeded: this Markdown has too many nodes.";
    }
  }
  if (resource.kind === "table"
    && (resource.columns.length > 100 || resource.rows.length > 2_000
      || new Set(resource.columns).size !== resource.columns.length
      || resource.rows.some((row) => row.length !== resource.columns.length
        || row.some((cell) => cellText(cell).length > 16_384)))) {
    return "renderer_limit_exceeded: this table exceeds the safe row, column, or cell limit.";
  }
  if (resource.kind === "chart"
    && (resource.rows.length > 10_000
      || new Set(resource.rows.map((row) => row.category)).size !== resource.rows.length
      || resource.rows.some((row) => !Number.isFinite(row.value)))) {
    return "renderer_limit_exceeded: this chart exceeds the safe mark limit.";
  }
  if (resource.kind === "diagram"
    && (resource.nodes.length > 2_000 || resource.edges.length > 4_000)) {
    return "renderer_limit_exceeded: this diagram exceeds the safe graph limit.";
  }
  try {
    if (resource.kind === "json"
      && new TextEncoder().encode(JSON.stringify(resource.value)).byteLength > 2_097_152) {
      return "renderer_limit_exceeded: this JSON is too large to render safely.";
    }
  } catch {
    return "renderer_invalid: this JSON value cannot be rendered.";
  }
  return null;
};

const inlineText = (value: string): ReactNode => {
  const match = /^\[([^\]]{1,200})\]\((https:\/\/[^)\s]{1,2000})\)$/u.exec(value);
  if (!match) return value;
  return <a href={match[2]} target="_blank" rel="noopener noreferrer">{match[1]} <span>(external)</span></a>;
};

const safeLanguage = (value: string): string =>
  ["python", "json", "markdown", "text", "csv", "typescript", "javascript"].includes(value)
    ? value
    : "text";

const cellText = (value: unknown): string => {
  if (value === null) return "null";
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "[unrenderable]";
  }
};

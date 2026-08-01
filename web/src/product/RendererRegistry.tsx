import { useId, type ReactNode } from "react";

export type RendererResource =
  | Readonly<{ kind: "safe_html"; title: string; html: string }>
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
      nodes: readonly Readonly<{
        id: string;
        label: string;
        groupId?: string;
        sourceRefs?: readonly string[];
      }>[];
      edges: readonly Readonly<{
        from: string;
        to: string;
        label?: string;
        sourceRefs?: readonly string[];
      }>[];
      groups?: readonly Readonly<{
        id: string;
        label: string;
        sourceRefs?: readonly string[];
      }>[];
    }>
  | Readonly<{
      kind: "attachment";
      title: string;
      mediaType: string;
      sizeBytes: number;
      sha256: string;
      reason: "active_content" | "unsupported_media";
    }>;

export function RendererRegistry({
  resource,
  onSourceReference,
}: Readonly<{
  resource: RendererResource | unknown;
  onSourceReference?: (reference: string) => void;
}>) {
  if (!rendererShape(resource)) {
    return (
      <section className="product-renderer product-renderer-error" role="status">
        <h3>{rendererTitle(resource)}</h3>
        <p>renderer_invalid: this resource cannot be rendered safely.</p>
      </section>
    );
  }
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
    case "safe_html":
      return <SandboxedHtmlRenderer resource={resource} />;
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
      return (
        <DiagramRenderer
          resource={resource}
          onSourceReference={onSourceReference}
        />
      );
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

const SandboxedHtmlRenderer = ({
  resource,
}: Readonly<{ resource: Extract<RendererResource, { kind: "safe_html" }> }>) => (
  <section className="product-renderer">
    <h3>{resource.title}</h3>
    <iframe className="product-sandboxed-html" title={resource.title} sandbox=""
      referrerPolicy="no-referrer" srcDoc={sandboxedHtmlDocument(resource.html)} />
  </section>
);

const HTML_SANDBOX_CSP = "default-src 'none'; base-uri 'none'; connect-src 'none'; font-src 'none'; form-action 'none'; frame-src 'none'; img-src 'none'; media-src 'none'; object-src 'none'; script-src 'none'; style-src 'unsafe-inline'";
const HTML_SANDBOX_META = `<meta http-equiv="Content-Security-Policy" content="${HTML_SANDBOX_CSP}">`;

const sandboxedHtmlDocument = (html: string): string => {
  if (/<head(?:\s[^>]*)?>/iu.test(html)) {
    return html.replace(/<head(?:\s[^>]*)?>/iu, (head) => `${head}${HTML_SANDBOX_META}`);
  }
  if (/<html(?:\s[^>]*)?>/iu.test(html)) {
    return html.replace(/<html(?:\s[^>]*)?>/iu, (root) => `${root}<head>${HTML_SANDBOX_META}</head>`);
  }
  return `<!doctype html><html><head>${HTML_SANDBOX_META}</head><body>${html}</body></html>`;
};

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
  onSourceReference,
}: Readonly<{
  resource: Extract<RendererResource, { kind: "diagram" }>;
  onSourceReference?: (reference: string) => void;
}>) => {
  const labels = new Map(resource.nodes.map((node) => [node.id, node.label]));
  const groupLabels = new Map(resource.groups?.map((group) => [group.id, group.label]) ?? []);
  return (
    <section className="product-renderer">
      <h3>{resource.title}</h3>
      <p>{resource.summary}</p>
      <DiagramGraph resource={resource} />
      <div className="product-diagram-canvas" role="group" aria-label={resource.summary}>
        {(resource.groups ?? []).map((group) => (
          <section className="product-diagram-group" key={group.id} aria-label={group.label}>
            <strong>{group.label}</strong>
            <SourceReferences
              references={group.sourceRefs}
              onSourceReference={onSourceReference}
            />
            <div>
              {resource.nodes.filter((node) => node.groupId === group.id).map((node) => (
                <DiagramNode
                  key={node.id}
                  node={node}
                  onSourceReference={onSourceReference}
                />
              ))}
            </div>
          </section>
        ))}
        <div className="product-diagram-ungrouped">
          {resource.nodes.filter((node) =>
            !node.groupId || !groupLabels.has(node.groupId)).map((node) => (
              <DiagramNode
                key={node.id}
                node={node}
                onSourceReference={onSourceReference}
              />
            ))}
        </div>
      </div>
      <TableRenderer resource={{
        kind: "table",
        title: `${resource.title} elements`,
        caption: `Accessible nodes and groups for ${resource.title}`,
        columns: ["Element type", "ID", "Label", "Group", "Sources"],
        rows: [
          ...(resource.groups ?? []).map((group) => [
            "group",
            group.id,
            group.label,
            "",
            group.sourceRefs?.join(", ") ?? "",
          ]),
          ...resource.nodes.map((node) => [
            "node",
            node.id,
            node.label,
            node.groupId ? (groupLabels.get(node.groupId) ?? node.groupId) : "ungrouped",
            node.sourceRefs?.join(", ") ?? "",
          ]),
        ],
      }} />
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
      {resource.edges.some((edge) => edge.sourceRefs?.length) && (
        <div className="product-diagram-sources">
          <strong>Relationship sources</strong>
          {resource.edges.map((edge, index) => edge.sourceRefs?.length ? (
            <div key={`${edge.from}:${edge.to}:${index}`}>
              <span>{labels.get(edge.from) ?? edge.from} → {labels.get(edge.to) ?? edge.to}</span>
              <SourceReferences
                references={edge.sourceRefs}
                onSourceReference={onSourceReference}
              />
            </div>
          ) : null)}
        </div>
      )}
    </section>
  );
};

const DiagramNode = ({
  node,
  onSourceReference,
}: Readonly<{
  node: Extract<RendererResource, { kind: "diagram" }>["nodes"][number];
  onSourceReference?: (reference: string) => void;
}>) => (
  <article className="product-diagram-node">
    <span>{node.label}</span>
    <SourceReferences
      references={node.sourceRefs}
      onSourceReference={onSourceReference}
    />
  </article>
);

const DiagramGraph = ({
  resource,
}: Readonly<{ resource: Extract<RendererResource, { kind: "diagram" }> }>) => {
  const markerId = useId();
  const lanes = resource.groups?.map((group) => ({
    ...group,
    nodes: resource.nodes.filter((node) => node.groupId === group.id),
  })).filter((group) => group.nodes.length > 0) ?? [];
  const isSwimlane = lanes.length > 0;
  const columns = isSwimlane
    ? Math.max(1, ...lanes.map((lane) => lane.nodes.length))
    : Math.min(3, Math.max(1, resource.nodes.length));
  const positions = new Map(resource.nodes.map((node, index) => {
    const laneIndex = lanes.findIndex((lane) => lane.id === node.groupId);
    const nodeIndex = laneIndex < 0 ? index : lanes[laneIndex]!.nodes.indexOf(node);
    return [node.id, {
      x: isSwimlane ? 170 + nodeIndex * 220 : 120 + (index % columns) * 260,
      y: isSwimlane ? 82 + laneIndex * 126 : 80 + Math.floor(index / columns) * 170,
    }];
  }));
  const rows = isSwimlane ? lanes.length : Math.max(1, Math.ceil(resource.nodes.length / columns));
  const width = Math.max(360, isSwimlane ? 170 + columns * 220 : columns * 260);
  const height = Math.max(180, isSwimlane ? rows * 126 : rows * 170);
  return (
    <svg
      className="product-diagram-graph"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${resource.title}: ${resource.summary}`}
    >
      <defs>
        <marker id={markerId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
          <path d="M0,0 L8,4 L0,8 z" />
        </marker>
      </defs>
      {isSwimlane && lanes.map((lane, index) => (
        <g className="product-diagram-lane" key={lane.id}>
          <rect x="4" y={index * 126 + 6} width={width - 8} height="114" rx="10" />
          <text x="16" y={index * 126 + 66}>{lane.label}</text>
        </g>
      ))}
      {resource.edges.map((edge, index) => {
        const from = positions.get(edge.from);
        const to = positions.get(edge.to);
        if (!from || !to) return null;
        const midX = (from.x + to.x) / 2;
        const midY = (from.y + to.y) / 2;
        return (
          <g className="product-diagram-edge" key={`${edge.from}:${edge.to}:${index}`}>
            <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} markerEnd={`url(#${markerId})`} />
            {edge.label && <text x={midX} y={midY - 7}>{edge.label}</text>}
          </g>
        );
      })}
      {resource.nodes.map((node) => {
        const position = positions.get(node.id)!;
        return (
          <g className="product-diagram-graph-node" key={node.id} transform={`translate(${position.x - 96} ${position.y - 34})`}>
            <rect width="192" height="68" rx="10" />
            <text x="96" y="39" textAnchor="middle">{node.label}</text>
          </g>
        );
      })}
    </svg>
  );
};

const SourceReferences = ({
  references,
  onSourceReference,
}: Readonly<{
  references?: readonly string[];
  onSourceReference?: (reference: string) => void;
}>) => references?.length ? (
  <span className="product-source-references">
    {references.map((reference) => onSourceReference
      ? (
        <button
          type="button"
          className="product-link-button"
          key={reference}
          onClick={() => onSourceReference(reference)}
        >
          {reference}
        </button>
        )
      : <code key={reference}>{reference}</code>)}
  </span>
) : null;

const rendererShape = (value: unknown): value is RendererResource => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const resource = value as Record<string, unknown>;
  if (typeof resource.kind !== "string" || typeof resource.title !== "string") return false;
  switch (resource.kind) {
    case "safe_html":
      return typeof resource.html === "string";
    case "markdown":
      return typeof resource.text === "string";
    case "code":
      return typeof resource.language === "string" && typeof resource.text === "string";
    case "json":
      return Object.hasOwn(resource, "value");
    case "table":
      return typeof resource.caption === "string"
        && stringArray(resource.columns)
        && Array.isArray(resource.rows)
        && resource.rows.every(Array.isArray);
    case "chart":
      return typeof resource.summary === "string"
        && typeof resource.categoryLabel === "string"
        && typeof resource.valueLabel === "string"
        && Array.isArray(resource.rows)
        && resource.rows.every((row) => objectWith(row, {
          category: "string",
          value: "number",
        }));
    case "diagram":
      return typeof resource.summary === "string"
        && Array.isArray(resource.nodes)
        && resource.nodes.every((node) => objectWith(node, {
          id: "string",
          label: "string",
        }) && optionalString(node, "groupId") && optionalStringArray(node, "sourceRefs"))
        && Array.isArray(resource.edges)
        && resource.edges.every((edge) => objectWith(edge, {
          from: "string",
          to: "string",
        }) && optionalString(edge, "label") && optionalStringArray(edge, "sourceRefs"))
        && (resource.groups === undefined
          || (Array.isArray(resource.groups)
            && resource.groups.every((group) => objectWith(group, {
              id: "string",
              label: "string",
            }) && optionalStringArray(group, "sourceRefs"))));
    case "attachment":
      return typeof resource.mediaType === "string"
        && typeof resource.sizeBytes === "number"
        && typeof resource.sha256 === "string"
        && (resource.reason === "active_content" || resource.reason === "unsupported_media");
    default:
      return false;
  }
};

const stringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const objectWith = (
  value: unknown,
  fields: Readonly<Record<string, "string" | "number">>,
): value is Record<string, unknown> => Boolean(
  value
  && typeof value === "object"
  && !Array.isArray(value)
  && Object.entries(fields).every(([field, type]) =>
    typeof (value as Record<string, unknown>)[field] === type),
);

const optionalString = (value: unknown, field: string): boolean =>
  !value || typeof value !== "object"
    || (value as Record<string, unknown>)[field] === undefined
    || typeof (value as Record<string, unknown>)[field] === "string";

const optionalStringArray = (value: unknown, field: string): boolean =>
  !value || typeof value !== "object"
    || (value as Record<string, unknown>)[field] === undefined
    || stringArray((value as Record<string, unknown>)[field]);

const rendererTitle = (value: unknown): string =>
  value && typeof value === "object" && !Array.isArray(value)
    && typeof (value as { title?: unknown }).title === "string"
    ? (value as { title: string }).title
    : "Unavailable view";

const rendererIssue = (resource: RendererResource): string | null => {
  if (resource.kind === "markdown" || resource.kind === "code" || resource.kind === "safe_html") {
    const text = resource.kind === "safe_html" ? resource.html : resource.text;
    if (new TextEncoder().encode(text).byteLength > 1_048_576) {
      return "renderer_limit_exceeded: this text is too large to render safely.";
    }
    if (resource.kind === "code" && resource.text.split(/\r?\n/u).length > 20_000) {
      return "renderer_limit_exceeded: this code has too many lines.";
    }
    if (resource.kind === "markdown" && resource.text.split(/\r?\n/u).length > 50_000) {
      return "renderer_limit_exceeded: this Markdown has too many nodes.";
    }
    if (resource.kind === "safe_html" && resource.html.split(/\r?\n/u).length > 20_000) {
      return "renderer_limit_exceeded: this HTML has too many lines.";
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
    && (resource.nodes.length > 2_000 || resource.edges.length > 4_000
      || (resource.groups?.length ?? 0) > 500)) {
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

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RendererRegistry } from "./RendererRegistry";

describe("safe renderer registry", () => {
  it("keeps Markdown HTML inert and rejects unsafe links", () => {
    render(<RendererRegistry resource={{
      kind: "markdown",
      title: "Untrusted Markdown",
      text: "# Heading\n<script>window.pwned = true</script>\n[unsafe](javascript:alert(1))\n[docs](https://example.com/docs)",
    }} />);
    expect(screen.getByRole("heading", { name: "Heading" })).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
    expect(screen.queryByRole("link", { name: /unsafe/u })).toBeNull();
    expect(screen.getByRole("link", { name: /docs/u })).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("gives chart and diagram data semantic table fallbacks", () => {
    const { rerender } = render(<RendererRegistry resource={{
      kind: "chart",
      title: "Samples",
      summary: "Two sample counts.",
      categoryLabel: "Case",
      valueLabel: "Samples",
      rows: [{ category: "A", value: 1 }, { category: "B", value: 2 }],
    }} />);
    expect(screen.getByRole("table", { name: "Accessible data for Samples" })).toBeInTheDocument();
    rerender(<RendererRegistry resource={{
      kind: "diagram",
      title: "Flow",
      summary: "Input reaches output.",
      nodes: [{ id: "a", label: "Input" }, { id: "b", label: "Output" }],
      edges: [{ from: "a", to: "b", label: "produces" }],
    }} />);
    expect(screen.getByRole("table", { name: "Accessible connections for Flow" })).toBeInTheDocument();
  });

  it("reports a stable limit error without rendering an oversized table", () => {
    render(<RendererRegistry resource={{
      kind: "table",
      title: "Oversized",
      caption: "Oversized table",
      columns: ["value"],
      rows: Array.from({ length: 2_001 }, (_, index) => [index]),
    }} />);
    expect(screen.getByRole("status")).toHaveTextContent("renderer_limit_exceeded");
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("renders optional diagram groups and source references without making them contractual", async () => {
    const onSourceReference = vi.fn();
    render(<RendererRegistry
      onSourceReference={onSourceReference}
      resource={{
        kind: "diagram",
        title: "Agent-chosen structure",
        summary: "A grouped projection.",
        groups: [{ id: "group-a", label: "Optional group", sourceRefs: ["code/group.py"] }],
        nodes: [
          { id: "a", label: "Input", groupId: "group-a", sourceRefs: ["code/input.py"] },
          { id: "b", label: "Output" },
        ],
        edges: [{ from: "a", to: "b", sourceRefs: ["code/flow.py"] }],
      }}
    />);

    expect(screen.getByRole("region", { name: "Optional group" })).toBeInTheDocument();
    const elements = screen.getByRole("table", {
      name: "Accessible nodes and groups for Agent-chosen structure",
    });
    expect(elements).toHaveTextContent("Optional group");
    expect(elements).toHaveTextContent("Input");
    expect(elements).toHaveTextContent("ungrouped");
    expect(screen.getByRole("table", {
      name: "Accessible connections for Agent-chosen structure",
    })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "code/flow.py" }));
    expect(onSourceReference).toHaveBeenCalledWith("code/flow.py");
  });

  it("fails closed for unknown and malformed renderer payloads", () => {
    const { rerender } = render(<RendererRegistry resource={{
      kind: "future_agent_view",
      title: "Unregistered projection",
      payload: {},
    }} />);
    expect(screen.getByRole("status")).toHaveTextContent("renderer_invalid");

    rerender(<RendererRegistry resource={{
      kind: "chart",
      title: "Malformed chart",
      summary: "Bad rows",
      categoryLabel: "Category",
      valueLabel: "Value",
      rows: [{ category: "A", value: "not a number" }],
    }} />);
    expect(screen.getByRole("status")).toHaveTextContent("renderer_invalid");
  });
});

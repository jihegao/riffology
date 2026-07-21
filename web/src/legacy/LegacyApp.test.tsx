import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LegacyApp } from "../LegacyApp";
import type { BrowserEvent, DemoClient, ProjectState, Scalar } from "./types";

const readyState = (): ProjectState => ({
  sessionId: "demo",
  revision: 4,
  phase: "model_ready",
  agent: { modelId: "deepseek/approved", status: "ready" },
  attachments: [{ id: "upl-1", displayName: "arrivals.csv", mediaType: "text/csv", sizeBytes: 1240, status: "ready" }],
  conversation: [],
  model: {
    id: "queue-network-v1",
    name: "Service queue",
    description: "A bundled Mesa queue network.",
    status: "ready",
    parameterSchema: { fields: [{ key: "arrival_rate", label: "Arrival rate", type: "number", default: 6, minimum: 0.1, maximum: 100, required: true }] },
    parameterValues: { arrival_rate: 6 }
  },
  run: null,
  results: null
});

function fakeClient(snapshot: ProjectState) {
  let listener: ((event: BrowserEvent) => void) | undefined;
  const client: DemoClient = {
    getSnapshot: vi.fn(async () => snapshot),
    subscribe: vi.fn((_session, handler) => { listener = handler; return () => { listener = undefined; }; }),
    upload: vi.fn(async () => undefined),
    removeAttachment: vi.fn(async () => undefined),
    sendChat: vi.fn(async () => undefined),
    saveParameters: vi.fn(async () => undefined),
    startRun: vi.fn(async () => undefined),
    cancelRun: vi.fn(async () => undefined)
  };
  return { client, emit: (event: BrowserEvent) => listener?.(event) };
}

describe("Riff browser UI", () => {
  it("renders schema parameters through stable labels and bridge-safe test IDs", async () => {
    const user = userEvent.setup();
    const { client } = fakeClient(readyState());
    render(<LegacyApp client={client} sessionId="demo" />);

    await screen.findByTestId("attachment-upl-1");
    await user.click(screen.getByRole("tab", { name: "Parameters" }));
    const input = screen.getByTestId("parameter-input-arrival_rate");
    expect(input).toHaveAccessibleName("Arrival rate");
    await user.clear(input);
    await user.type(input, "9");
    expect(screen.getByRole("button", { name: "Save parameters" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Save parameters" }));
    expect(client.saveParameters).toHaveBeenCalledWith("demo", 4, "queue-network-v1", { arrival_rate: 9 });
  });

  it("handles mocked canonical SSE deltas and keeps a ui-control warning non-blocking", async () => {
    const snapshot = {
      ...readyState(),
      uiControl: { intent: "start_run" as const, status: "failed" as const, expectedRevision: 4, message: "Visible verification did not complete." },
      conversation: [{ id: "assistant-1", role: "assistant" as const, text: "I will prepare it", status: "streaming" as const, createdAt: "2026-01-01T00:00:00Z" }]
    };
    const { client, emit } = fakeClient(snapshot);
    render(<LegacyApp client={client} sessionId="demo" />);

    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("Visible verification did not complete.");
    emit({ type: "conversation.delta", data: { messageId: "assistant-1", textDelta: " safely." } });
    expect(await screen.findByText("I will prepare it safely.")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("tab", { name: "Run" }));
    expect(screen.getByRole("button", { name: "Run experiment" })).toBeEnabled();
  });

  it("uses active/hidden tab panel semantics and resyncs a revision gap", async () => {
    const { client, emit } = fakeClient(readyState());
    render(<LegacyApp client={client} sessionId="demo" />);

    await screen.findByRole("tab", { name: "Files", selected: true });
    expect(screen.getByTestId("workbench-panel-files")).not.toHaveAttribute("hidden");
    expect(screen.getByTestId("workbench-panel-results")).toHaveAttribute("hidden");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Files" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Parameters" })).toHaveFocus();
    emit({ type: "project.patch", data: { sessionId: "demo", revision: 8, operations: [] } });
    await waitFor(() => expect(client.getSnapshot).toHaveBeenCalledTimes(2));
  });
});

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectChangeSet, ProjectMutationReceipt } from "./types";
import { ReviewRail } from "./ReviewRail";

const files = [{
  key: "file-one",
  relativePath: "code/model.py",
  mediaType: "text/x-python",
  sizeBytes: 18,
  sha256: "a".repeat(64),
}];

const changeSet = (freshness: "fresh" | "stale" = "fresh"): ProjectChangeSet => ({
  id: `change-${freshness}`,
  baseWorkspaceDigest: "b".repeat(64),
  currentWorkspaceDigest: "c".repeat(64),
  changeSetDigest: "d".repeat(64),
  freshness,
  state: "pending",
  createdAt: "2026-07-28T00:00:00.000Z",
  resolvedAt: null,
  files: [{
    itemId: "item-one",
    kind: "modify",
    relativePath: "code/model.py",
    mediaType: "text/x-python",
    priorSha256: "a".repeat(64),
    proposedSha256: "e".repeat(64),
    proposedText: "print('proposed')",
  }],
});

const receipt = (operation: "apply" | "reject"): ProjectMutationReceipt => ({
  schemaVersion: 1,
  commandId: "command-one",
  operation,
  projectId: "project-one",
  changeSetId: "change-fresh",
  changeSetDigest: "d".repeat(64),
  beforeWorkspaceDigest: "c".repeat(64),
  afterWorkspaceDigest: "f".repeat(64),
  files: [],
  committedAt: "2026-07-28T00:00:01.000Z",
  receiptDigest: "9".repeat(64),
});

afterEach(() => vi.unstubAllGlobals());

describe("capability-driven review rail", () => {
  it("does not steal initial desktop focus and restores focus for explicit rail toggles", async () => {
    render(<ReviewRail
      ownerKey="project:project-one:digest-one"
      files={files}
      loadFile={vi.fn(async () => ({
        kind: "code" as const,
        title: "code/model.py",
        language: "python",
        text: "print('current')",
      }))}
    />);

    expect(screen.getByRole("button", { name: /^Close$/u })).not.toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: /^Close$/u }));
    const trigger = screen.getByRole("button", { name: "Open file and change review" });
    await waitFor(() => expect(trigger).toHaveFocus());
    await userEvent.click(trigger);
    await waitFor(() => expect(screen.getByRole("button", {
      name: /^Close$/u,
    })).toHaveFocus());
  });

  it("supports file review, keyboard resizing, local progress, and whole-set apply receipts", async () => {
    const onApply = vi.fn(async () => receipt("apply"));
    render(<ReviewRail
      ownerKey="project:project-one:digest-one"
      files={files}
      changeSets={[changeSet()]}
      loadFile={vi.fn(async () => ({
        kind: "code" as const,
        title: "code/model.py",
        language: "python",
        text: "print('current')",
      }))}
      onApply={onApply}
    />);

    expect(await screen.findByText("print('current')")).toBeInTheDocument();
    const separator = screen.getByRole("separator", { name: "Resize review rail" });
    expect(separator).toHaveAttribute("aria-valuenow", "360");
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(separator).toHaveAttribute("aria-valuenow", "376");

    await userEvent.click(screen.getByRole("button", { name: "Changes · 1" }));
    expect(screen.getByText("0 / 1 files reviewed")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Mark file reviewed" }));
    expect(screen.getByText("1 / 1 files reviewed")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Apply whole change set" }));
    await waitFor(() => expect(onApply).toHaveBeenCalledWith(changeSet()));
    expect(await screen.findByRole("status")).toHaveTextContent("Applied");
  });

  it("keeps stale apply disabled while allowing the whole proposal to be rejected", async () => {
    const onReject = vi.fn(async () => receipt("reject"));
    render(<ReviewRail
      ownerKey="project:project-one:digest-one"
      files={files}
      changeSets={[changeSet("stale")]}
      loadFile={vi.fn(async () => ({
        kind: "code" as const,
        title: "code/model.py",
        language: "python",
        text: "print('current')",
      }))}
      onReject={onReject}
    />);

    await userEvent.click(screen.getByRole("button", { name: "Changes · 1" }));
    expect(screen.getByRole("button", { name: "Apply whole change set" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Reject change set" }));
    expect(await screen.findByText("Rejected")).toBeInTheDocument();
  });

  it("uses a focus-managed full-screen dialog and returns focus on Escape at narrow widths", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      media: "(max-width: 959px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    render(<div className="product-app">
      <header data-testid="global-header">Global header</header>
      <main className="product-shell">
        <header data-testid="owner-header">Owner header</header>
        <div data-testid="pane-selector">Pane selector</div>
        <div className="product-workspace">
          <aside data-testid="conversation-pane">Conversation</aside>
          <section>
            <div className="product-workbench-layout">
              <main className="product-workbench-canvas">Canvas</main>
              <ReviewRail
                ownerKey="project:project-one:digest-one"
                files={files}
                loadFile={vi.fn(async () => ({
                  kind: "code" as const,
                  title: "code/model.py",
                  language: "python",
                  text: "print('current')",
                }))}
              />
            </div>
          </section>
        </div>
      </main>
    </div>);

    const trigger = screen.getByRole("button", { name: "Open file and change review" });
    await userEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "File and change review" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText("Canvas").closest("main")).toHaveAttribute("inert");
    expect(screen.getByTestId("global-header")).toHaveAttribute("inert");
    expect(screen.getByTestId("owner-header")).toHaveAttribute("inert");
    expect(screen.getByTestId("pane-selector")).toHaveAttribute("inert");
    expect(screen.getByTestId("conversation-pane")).toHaveAttribute("inert");
    const close = screen.getByRole("button", { name: /^Close$/u });
    await waitFor(() => expect(close).toHaveFocus());
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("button", { name: /code\/model.py/u })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.getByRole("button", {
      name: "Open file and change review",
    })).toHaveFocus());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Canvas").closest("main")).not.toHaveAttribute("inert");
    expect(screen.getByTestId("global-header")).not.toHaveAttribute("inert");
    expect(screen.getByTestId("owner-header")).not.toHaveAttribute("inert");
    expect(screen.getByTestId("pane-selector")).not.toHaveAttribute("inert");
    expect(screen.getByTestId("conversation-pane")).not.toHaveAttribute("inert");
  });

  it("closes an open desktop rail on a narrow transition without transiently inerting or losing focus", async () => {
    let narrow = false;
    const listeners = new Set<() => void>();
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      get matches() { return narrow; },
      media: "(max-width: 959px)",
      onchange: null,
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    render(<div className="product-app">
      <button type="button">Pane selector control</button>
      <ReviewRail
        ownerKey="project:project-one:digest-one"
        files={files}
        loadFile={vi.fn(async () => ({
          kind: "code" as const,
          title: "code/model.py",
          language: "python",
          text: "print('current')",
        }))}
      />
    </div>);

    const control = screen.getByRole("button", { name: "Pane selector control" });
    control.focus();
    narrow = true;
    act(() => listeners.forEach((listener) => listener()));

    await waitFor(() => expect(screen.getByRole("button", {
      name: "Open file and change review",
    })).toBeInTheDocument());
    expect(control).toHaveFocus();
    expect(control).not.toHaveAttribute("inert");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

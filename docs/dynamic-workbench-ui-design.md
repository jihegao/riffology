# Dynamic Model/Project workbench UI design

- Status: active
- Role: active design
- Scope: approved post-MVP shared-shell layout, generated Model views, file review, and proposed Model change review
- Source of truth: [`product-requirements.md`](product-requirements.md); merged code and tests remain implementation authority
- Last reviewed: 2026-07-28

## 1. Purpose and authority

This design refines the delivered shared two-pane MVP without redefining its
product identity:

```text
left: persistent owner-scoped Conversation
right: dynamic Model or Project workbench
```

The visual assets under [`prototypes/`](prototypes/README.md) supplement this
design. Their sample tabs, file names, diagrams, entities, counts, and domain
content are not product contracts. Where a prototype conflicts with the PRD or
this design, the PRD and this design govern.

The work is not implemented merely because this document is merged. Each slice
must keep its own code, automated-test, browser, review, and merged-revision
evidence.

## 2. Stable shell contract

When a Model or Project is open:

- the object name appears once as the page/workspace title in the compact
  product header or breadcrumb; necessary contextual references in content,
  captions, or receipts are not duplicate titles;
- Conversation begins immediately below that header and reaches the bottom of
  the viewport;
- the Conversation toolbar and composer remain visible while the transcript
  and pending interactions share one independently scrolling middle region;
- the composer is the final layout row rather than an overlay, so it cannot
  cover the last message;
- switching Conversation changes only subordinate left-pane state and does not
  remount the current owner workbench; and
- narrow and 200% reflow layouts expose an accessible Conversation/Workspace
  selector without horizontal page overflow.

The shell must not repeat the owner title inside the workbench or add explanatory
headings such as `PERSISTENT CONTEXT`, `CURRENT OBJECT`, or equivalent Chinese
copy. Accessible landmarks and names remain required even when visual headings
are consolidated.

## 3. Weak-contract workbench

The right side is assembled from the current owner, available capabilities, and
task state. It does not define fixed `overview`, `configuration`, `run`,
`results`, or `technical details` tabs, URL segments, or DTO enums.

Stable platform controls may still exist:

- Model technical checks and safe resource rendering;
- Project Experiment and Run controls;
- Run cancel, output download, diagnostic-event access, and lifecycle actions;
- owner-scoped file inspection; and
- review of current content versus a proposed or committed change.

These controls are ordered and disclosed according to the current task. Their
existence does not require every Model or Project to render the same sections.
Direct Project operations remain usable when the Agent is read-only or
unavailable.

The Model-level visual preview shown in one prototype is not part of this slice.
The current formal visual lifecycle remains Project-owned; the UI must not
fabricate a Model preview runtime.

## 4. Generated Model views

A generated view is a bounded, owner-scoped, non-authoritative projection
published by an Agent for a captured Model workspace digest. A Model may have
zero, one, or many current views. Each view has an arbitrary title, order,
generic renderer kind, payload digest, and optional source references.

The platform does not require or enumerate class diagrams, swimlanes, data-flow
diagrams, `model-spec.json`, or any other file or view name. The Agent selects
useful views from the current Model. It may add, rename, replace, or omit them.

Generated views:

- never change Model files, execution description, technical status, or
  workspace digest;
- never prove that an Agent mutation committed;
- become stale when their captured workspace digest differs from the current
  Model workspace digest;
- remain visibly distinguishable from Model authority; and
- use the existing bounded renderer registry with accessible textual or tabular
  fallbacks.

Optional source references may link a rendered node or region to an owned file
or diff item. Missing source references are valid and do not make a view
invalid.

## 5. Stable review rail

Files and Changes are stable platform review capabilities, implemented by a
collapsible auxiliary rail:

- desktop supports a bounded pointer- and keyboard-adjustable width;
- the separator exposes orientation and current/minimum/maximum values;
- collapsing the rail returns space to the workbench canvas;
- narrow layouts use a modal or full-screen drawer with Escape, an explicit
  close control, focus containment, and focus return; and
- Files or Changes appears only when the current owner exposes that capability.

The file tree uses actual sanitized relative paths. No path or file name is
special. Preview reuses safe renderer and download boundaries and never exposes
absolute paths or object-store identity.

Diff review clearly separates current content, proposed content, and committed
content. The first implementation supports per-file reading progress but only
whole-change-set apply or reject. It does not implement partial-file exclusion.

## 6. Conversation intent and Model changes

Conversation intent continues to distinguish:

- **explicit mutation:** an allowed, unambiguous imperative may atomically
  modify the Model through the existing scoped mutation authority; and
- **proposal-only discussion:** the Agent may create a durable proposed change
  set, but the Model remains unchanged until the user applies that exact set
  through a direct Product command.

Both paths produce an immutable mutation receipt when a Model change commits.
The receipt binds before/after workspace digests and the affected logical files.
Assistant prose, OpenCode idle, generated views, or a proposed change set never
mean that files changed.

A proposed set binds its source Model, Conversation/turn, base workspace digest,
candidate file identities, prior/proposed digests, and canonical set digest.
Apply revalidates every binding and commits the whole set atomically. Drift
fails with a stable stale-change error; the platform does not silently rebase.
Reject records the decision without changing Model authority.

## 7. Persistence and public boundary

The planned implementation will add schema-v17 metadata for generated view
sets, generated views, proposed Model change sets, proposed files, and
immutable apply/reject receipts.

- Existing schema-v16 Models migrate with no fabricated views or change sets.
- Generated and proposed payloads are bounded and separate from authoritative
  Model object files.
- Public DTOs contain logical relative paths, renderer-safe payloads, bounded
  diff hunks, and digests only.
- Absolute paths, raw tool input/output, credentials, OpenCode/session IDs,
  process data, capability URLs, and object-store identity remain private.
- New records participate in owner lifecycle, backup, integrity, restart, and
  permanent-delete manifests.

## 8. Delivery gates

Delivery remains split into reviewable slices:

1. this design and PRD clarification;
2. full-height shell and Conversation layout without DTO changes;
3. schema-v17 Store/API/Agent contracts;
4. dynamic Model canvas, review rail, and task-state Project composition; and
5. deterministic continuous browser acceptance plus merged-main regression.

Each implementation slice requires focused and full relevant tests, production
build, deterministic browser evidence, and independent product/correctness and
security/accessibility review. Only the final merged-main browser gate may
claim this UI refinement complete.

# Riffology OpenChamber Stage 1 baseline

- Status: active
- Role: implementation record
- Scope: approved Stage 1 visual baseline, upstream/toolchain tuple, and public-surface contract for the Riffology workbench
- Source of truth: [`product-requirements.md`](product-requirements.md) and [`openchamber-browser-workbench-migration-plan.md`](openchamber-browser-workbench-migration-plan.md); the machine-readable tuple is [`riffology-openchamber-baseline.json`](riffology-openchamber-baseline.json)
- Last reviewed: 2026-08-01

## Baseline record

The visual authority for this staged implementation is the editable
[`openchamber-browser-workbench.svg`](prototypes/openchamber-browser-workbench.svg)
and its review preview
[`openchamber-browser-workbench.png`](prototypes/openchamber-browser-workbench.png).
The frozen SHA-256 values and PNG dimensions are in the adjacent manifest.
Run the dependency-free check below before accepting a change that claims to
use this visual baseline:

```sh
bash scripts/check-riffology-openchamber-baseline.sh
```

If either source changes, the author must deliberately update the SVG/PNG,
manifest hashes, this review date, and the visual-fixture evidence together.
A digest mismatch fails closed; a later implementation must not infer layout
from an older screenshot or an unpinned upstream checkout.

## Product and authority contract

The public product name is **Riffology**. OpenChamber is an internal upstream
source and must not be presented as the product brand. Riff remains the name
of the domain runtime and the sole authority for durable Model, Project,
Experiment, Run, output, receipt, and owner-binding facts.

| Component | May do | Must not become authoritative for |
| --- | --- | --- |
| Riffology web shell | render sessions, permissions, browser/file projections, and user intent | Riff domain mutations or completion claims |
| OpenCode | plan turns and invoke scoped tools | Riff owner scope, durable mutation success, or browser credentials |
| Browser Broker | own admitted browser lifecycle and bounded action receipts | Riff domain state, browser DOM as durable evidence, or web-client CDP access |
| Riff runtime/Store | validate and persist domain mutations, receipts, and frozen Run facts | presentation layout or upstream chat state |

Agent text, DOM, HTML, screenshots, OpenCode idle, client-side history, and a
healthy browser page remain projections. They cannot create, restore, or prove
durable Riff state without the matching Store receipt/digest evidence.

## Stage 1 public-surface boundary

The Riffology fork may retain only the UI primitives required by later stages.
Before it becomes a user-facing shell, these OpenChamber-origin capabilities
must be absent from public navigation, shortcuts, deep links, and product API
composition: terminal/shell execution, arbitrary filesystem edit, Git
publication, sharing, tunnels, provider-secret management, arbitrary external
browser navigation, upload, download, and external login.

This is an implementation boundary, not evidence that a fork or the listed
capabilities have already been removed. Stage 2+ must add explicit tests for
each public-surface denial.

## Upstream provenance and maintenance

The Riffology OpenChamber fork derives from the exact upstream commit in the
manifest and publishes its Stage 1 delta through the linked fork PR.
The fork must retain the upstream MIT license and NOTICE (if present) verbatim.
It must also contain an `UPSTREAM_DELTA.md` ledger with one
entry per divergence: date, upstream base, affected package/file, rationale,
security impact, test evidence, and upstreaming/rebase disposition. No
OpenChamber source is vendored into this Riff repository at Stage 1.

The manifest records the required Node and Bun versions plus the verified
OpenCode SDK/Server target. The pinned upstream snapshot originally used SDK
1.18.9; the Riffology fork advances all four SDK consumers and its lockfile to
1.18.11 as an explicit delta. Existing Riff Product startup defaults remain a
separate compatibility contract and are not silently reinterpreted by this
future-shell baseline.

## Observed Stage 1 verification

On 2026-08-01, the local fork at
`/Users/gaojihe/apps/riffology-openchamber` was checked at the pinned base with
Node 25.3.0 and Bun 1.3.14. After the SDK 1.18.11 delta, a fresh detached
worktree completed a frozen root + Web + UI workspace install, Web type-check,
and Web production build. The primary checkout additionally passed Web/UI/VS
Code type-checks. The build emitted existing unresolved KaTeX-font and
large-chunk warnings. The broader Electron workspace installation is outside
this local Web-shell build claim.

The fork retains the upstream MIT `LICENSE`, adds `UPSTREAM_DELTA.md` plus a
read-only provenance/toolchain check, and is published at
`https://github.com/jihegao/riffology-openchamber` with linked PR 1. Its frozen
lockfile resolves SDK 1.18.11; Web/UI/VS Code type-checks and the Web build pass.

The workstation OpenCode executable was upgraded from Homebrew 1.18.8 to the
official arm64 1.18.11 release installed at `~/.local/bin/opencode`. A pure
loopback Server reported healthy version 1.18.11, projected the exact
`/Users/gaojihe/apps/riff-demo` work directory, and passed credential-free
Provider discovery through the existing Riff adapter smoke. This closes the
Stage 1 CLI/Server readiness mismatch without changing the existing Riff
Product default-version contract.

The runtime evidence is reproducible without Provider credentials:

```sh
bash scripts/check-opencode-1.18.11-runtime.sh
```

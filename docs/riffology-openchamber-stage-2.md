# Riffology OpenChamber Stage 2 implementation evidence

- Status: implementation candidate; not the default Product entry
- Role: Stage 2 implementation boundary and verification record
- Scope: Riffology shell, project rail, and Conversation area only
- Last reviewed: 2026-08-02
- Visual authority: [`prototypes/openchamber-browser-workbench.svg`](prototypes/openchamber-browser-workbench.svg)
- Parent contract: [`openchamber-browser-workbench-migration-plan.md`](openchamber-browser-workbench-migration-plan.md)

## Delivered boundary

The Stage 2 shell is available below `/workbench`. `/` and the existing
Model/Project Product routes remain unchanged until the Stage 7 cutover.

The shell provides:

- the Riffology-owned mark and name, a 74 px project rail, project initials,
  current-project state, and a 472 px Conversation rail at the reference
  desktop viewport;
- separate `新项目` and `＋ 新会话` actions;
- the existing durable Conversation message, live tool, permission, runtime,
  and composer projections through the existing Product API;
- read-only failure when Provider discovery or the selected Conversation is
  unavailable;
- narrow-screen Conversation-first reflow without the retired
  Conversation/Workspace pane selector.

The Stage 2 route does not compose Terminal, Git, sharing, tunnels, Provider
secret management, attachment upload, arbitrary file editing, fixed
Model/Project pages, or direct Run controls. The center is deliberately a
bound-project placeholder. Browser chrome, file viewing, and Browser Broker
state belong to Stages 3 and 4.

## Unbound workspace projection

Each `新项目` action creates a distinct random client workspace key and routes
to `/workbench/new/<workspace-key>`. Its setup draft is isolated under that key
in `sessionStorage`, survives refresh in the same browser session, and is
labelled as non-authoritative local state.

This is not `WorkspaceBinding`. It cannot create, bind, restore, or claim a
Riff Model/Project. Server-side binding, generation, Agent bootstrap tools, and
durable receipts remain Stage 6 work. The client projection exists only to
make the Stage 2 new-project interaction observable without silently creating
domain data.

## Verification

From `web/`:

```text
npm test
npm run build
npm run test:e2e:riffology-stage2
```

The dedicated browser command covers:

- 1800×1180 geometry and screenshots;
- 1440×900-at-200%-equivalent reflow and 390×844 mobile fit;
- distinct and refresh-stable unbound workspace keys;
- a real fixture-backed live Provider flow that creates two Conversations,
  switches them, reloads the selected query state, and preserves messages;
- live tool and permission cards;
- transition to Conversation read-only without a fabricated assistant reply;
- absence of Stage 2 denylisted public controls.

Generated screenshots and traces are test outputs, not tracked product or Riff
authority.

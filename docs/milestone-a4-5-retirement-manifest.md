# Milestone A4-5 tracked-code retirement manifest

Status: executed for the A4-5 narrow slice. This is not an MVP-exit record and
does not close Issue #15.

Authority: [`product-requirements.md`](product-requirements.md).

Baseline commit:
`6b68025078bb34e5ed55b67661bd9ba3c409b63e` (merged A4-4).

## Safety boundary

This manifest authorizes removal of the exact tracked files below only after the
Product-first backend, static Product shell, recovery-only admission, Product
browser session, and retained A4 browser tests pass. The recorded Git blob,
SHA-256, and byte count identify the pre-removal object.

It does **not** authorize deleting or rewriting `.riff-workspace`,
`.riff-workspaces`, `backend/.riff-workspaces`,
`mesa_service/.riff-workspace`, `outputs`, `test-results`, virtual
environments, caches, `.DS_Store`, ignored files, or unrelated untracked files.
Preflight for those paths is read-only.

The ordinary wind domain pack, `wind_turbine_maintenance` Model assets,
preinstalled wind installer, ProductStoreV2, generic batch/visual supervisors,
browser broker/WebSocket/frame authority, Visual-Agent authority, and Git
history are preserved.

## Exact removal records

| Path | Git blob | SHA-256 | Bytes | Replacement |
| --- | --- | --- | ---: | --- |
| `web/src/LegacyApp.tsx` | `6f36a9d46878c3238dc3f0a4b64d7cd3035e516f` | `2bdbe00901d02b486e0a74ce3d9d4671ec74f5b2d5df3f92cd6611bfdd7a9dc2` | 20857 | Product persistent Conversation pane |
| `web/src/legacy.css` | `1bd289b6d4a39f63c7dd422d7046b880a98d6531` | `4bf333b34d1f295c9bf96d4f53ff21a9af1cc185f23d38e3edc22a788ed181f0` | 9444 | `web/src/product/product.css` |
| `web/src/legacy/api.ts` | `5a5a8a9f028292added3d3f01823d9b8785009f3` | `2ad4d2b6e54625a78baa2fc5a723acd1fc497595f174953719a46f1401080447` | 4162 | Product browser-session client |
| `web/src/legacy/state.ts` | `f8e868f822e73a54a9f10628ea9ee2b72bee2375` | `cf55e3cd22ae8ac780fe0ee10d225d2a7caf4d11c23839420c686392c54c0123` | 2541 | ProductStoreV2 projections |
| `web/src/legacy/types.ts` | `85bb73061e20df4b291e6be68e0f47b9de414337` | `e02fd0eaf270236eb62508e74d1e0434d431da892fe36de250c3d2acadc3bbe1` | 3864 | closed Product DTOs |
| `web/src/legacy/LegacyApp.test.tsx` | `fb7cd2f7f4a12d968c22403b0c4644c5417c7f26` | `4930b2d0aef1f67ef1133bfecfa73c838488bb83bde84247a7f2ae84695af13a` | 4356 | A4 Product App/Conversation tests |
| `web/src/legacy/state.test.ts` | `15de9173b5af464860e92892bdc6e95969e81eda` | `473d3c412792d4ded624c7b9518ced45f71b8a6fa36dbd97e092ac74c9ddea30` | 963 | Product projection tests |
| `web/src/EvidenceStudioApp.tsx` | `ded82434084f39f1ef0896dfe7a6ed1eeebfa957` | `a44fd384ce04d115cbe061e250e5d85d8e9da9085a15b3233176d41e63721add` | 78492 | dynamic Model/Project workspace |
| `web/src/styles.css` | `b0ed19b426a39c94e6735df281c838c3d036b91f` | `0e72e9acc253090a4507769055720161d7e3eaa080b70d631a4b8adf9ed326dc` | 21100 | Product shell styles |
| `web/src/api.ts` | `505a7ef60c40dd7bd3bed069e07b55ed4870c721` | `6f1871c84688fbb27f5f686053bc49d5f4e05d080a0462b75a6387868175718c` | 15396 | `web/src/product/api.ts` |
| `web/src/state.ts` | `8e0c98d156ec18bb65366adb136d17bbe8dd1a8e` | `26ee51d9492e45f057dbc75ed4452aaeb623851902201022e0df523c432df4f6` | 19266 | Product DTO normalization |
| `web/src/types.ts` | `c20167dedb44531c98d79b187bac26e06f2aeade` | `b3b2b478732f6c7b2d1e2dc1c813f16c092e719f88747b8e4ff23e8e4519cd2c` | 22108 | `web/src/product/types.ts` |
| `web/src/evidence.ts` | `3dd0799e403874e80d134955c484b48806893acb` | `8eec2ae3342d1f12ad76642112934f6ae06240a21da0f37625d7f32b854a580c` | 45592 | generic Run outputs/events/renderers |
| `web/src/business-records.ts` | `e3a84539ee484c15f05e1e0c30ae1724fc5a931b` | `27b1d0e88e614243c8bda42c0fc395bafe6bc254a5c7115bde8c41d738baa8ce` | 6952 | Conversation documents and deterministic completion cards |
| `web/src/EvidenceStudioApp.test.tsx` | `37e7f3b62df43f42c020e6e46122accb464e8c81` | `760e84a237082845c288159ecc715930e967f921de49ede69d7227904752ee41` | 5554 | A4 workspace tests |
| `web/src/TraceabilityView.test.tsx` | `2858a8fef29614aac2ec79f36612eea41f7f21a3` | `1893f7f42b093dfa591acd5fa0f69e7f3061b5fc6ed2492a5574d0b3dafb5009` | 3745 | Product action/document cards |
| `web/src/real-schema.test.tsx` | `e9cff5ea886d5b7cdb9a63e887fd4319310ae300` | `a12213037efaca66415209c8c747528459c427dff2234ce927866152b51ec63a` | 3586 | generic renderer registry tests |
| `web/src/api.test.ts` | `59cee969b23e2471458d3c676b299c0b245a5a99` | `858e37ecfd82550a56d1c2d0300680c7199e314ef3f8c57b93e4d7601c22d798` | 4742 | Product client tests |
| `web/src/state.test.ts` | `e3af2f43e6ddead26da9174e313fd69761deac24` | `a29de4eaf2951695da811a6a14ec8f466eb1b5a0a33942f393bfc2687a8b7872` | 12682 | Product Store/API tests |
| `web/src/evidence.test.ts` | `88d23ef9f285a781d56955cdf4231c77638269e3` | `b4638ad6992a16a1c3769432b547ca408a9a049192e86da419eb50eaa0d68ff9` | 30008 | Run output/event and renderer tests |
| `web/src/business-records.test.ts` | `e82b9f8fa3aec5cd91134494f24607e770151261` | `ef26abfb7c0e08dc2ba9f5ad611acaf500dcdd8ffd98dd3357c51f553b3543e7` | 2552 | Product cards tests |
| `web/e2e/evidence-studio.spec.ts` | `86deb2e8b3372c777884f30be239bfb0f4971759` | `6d723b97e1e20b58f2f465e1405ca3139190efdbd4ff46b15ae711a32dcd271e` | 7739 | A4 Product browser slices; A4-6 remains pending |
| `web/e2e/gate3-backend.ts` | `cd09bd7576662823c10dbb94ecaaddbf4cf0d353` | `a63ec8f8b5f3dd3a89b9c584b53fe155934c8c5e28aa4a3dd604a044e8710d82` | 1009 | Product-first production/backend test launchers |
| `web/e2e/start-live-stack.sh` | `7f994ae7ac3da3f387baa69ba0d7704b7b6a0771` | `2688798ef75a0437257997067eeb0b0f6f94e1d82f4a5d46a27d11041d605cbd` | 1494 | staged Product A4 launchers |
| `web/e2e/bootstrap-live.mjs` | `a4b13a0a6916d3fe4aa125866488d562b0d372ee` | `8425473719253068770ef0a6816cc622d538cf8929d7ae0da15979c4c7128754` | 3362 | Product fixtures owned by each narrow browser slice |
| `scripts/e2e-live.mjs` | `ce0abf61bb100f545d040c9db6a6e6b4fec68eaf` | `e44786bb524d7c9bf4809f9e2fc2cacb0d043f0c833991ce9de8fdf1c7885f62` | 7114 | Product Conversation/Run browser/API tests |

## Production route retirement

`App.tsx` and `main.tsx` are edited rather than removed. The Product app is now
the only browser entry, including old `?mode=legacy` and `?mode=evidence`
queries. Production `BackendApp` is created in Product mode and does not
construct Gate2, Gate3, legacy ProjectStore, legacy MCP, or legacy OpenCode
event bridges. Product mode returns the closed Product `not_found` response for
old `/api/sessions/*`, revision, activation, attestation, policy, replay, and
auditor route families.

The old backend implementation remains tracked only as a non-production,
explicit-dependency regression harness in this narrow slice. That retained code
is not startup authority and no old workspace is opened by the Product entry.

## Required postconditions

- Product Web tests and build pass after removal.
- Production-entry integration proves direct static Product shell, admitted
  browser session, recovery status, Product Home, and old session-route denial.
- A4-2, A4-3, A4-4, A3 Product, broker, WebSocket, and Visual-Agent retained
  tests pass.
- `rg` finds no production Legacy/Evidence import or mode branch.
- A before/after identity test proves excluded local state is untouched.
- Issue #15 remains open. A4-6 owns the continuous real-browser exit matrix and
  all MVP completion claims.

# Solara runtime visualization contract

The default executable visualization is a loopback-only Solara app. It is a
browser projection of one identified Model or result artifact; it is not a
second domain authority.

## Required fields

The page must expose, in accessible text:

- a stable app/model heading;
- source path and SHA-256 (or the immutable run/revision digest);
- declared input values and seed when applicable;
- runtime status and a bounded error state;
- claim limits, including single-seed, synthetic, draft, or non-calibrated status
  when present in the source evidence.

The launch record must preserve the exact app path, command, loopback host and
port, generated time, source digest, and browser URL. The page may read a
frozen artifact or invoke the declared bounded runner, but it must not write
Product Store/domain state from a render callback.

## Boundary

`solara run` reaching a listening port and a browser rendering the page prove
only app availability and browser reachability. They do not prove model
correctness, calibration, validation, optimization, or a staffing/business
recommendation. Keep the source Model/run receipt authoritative and keep the
Solara DOM disposable.

# Wind turbine maintenance modeling requirements

## Decision question and scope

- Decision question: how does field-service crew capacity affect wind-farm
  availability, maintenance delay, and annual maintenance cost under the
  declared synthetic scenario?
- In scope: one onshore farm, turbine failures, periodic maintenance, a shared
  crew pool, travel, corrective-priority queues, replacement after selected
  failures, and comparative what-if experiments.
- Out of scope: weather access, roads or GIS, vessels, spare parts, crew skills,
  multiple farms, predictive maintenance, and mid-run hiring or layoffs.
- Intended use: inspect the model and compare synthetic scenarios.
- Non-use: real staffing recommendations, operational forecasts, calibration,
  or proof of equivalence with the AnyLogic source.

## Evidence and assumptions

| Type | Item | Source or rationale | Owner | Status |
| --- | --- | --- | --- | --- |
| fact | The structural reference is the AnyLogic Field Service example identified by SHA-256 in `assets/provenance.json`. | Reviewed source traceability | Model asset | recorded |
| policy | Corrective work has priority over planned maintenance; each queue is FIFO. | Reviewed behavioral mapping | Model | implemented |
| policy | Simultaneous events use business phase followed by LIFO schedule order. | Explicit adaptation recorded in `assets/traceability.json` | Model | implemented |
| assumption | Default parameters and the 95% availability target are synthetic demo values. | No real wind-farm calibration dataset is included | Template | explicit |
| open question | Which parameter set represents a named real farm? | Requires external operational data and calibration | User/domain reviewer | open |

## Ontology and behavior

- Entities: turbine, maintenance crew, and work order, each with stable IDs.
- Turbine states: `operating`, `failed_waiting`, `corrective_repair`,
  `planned_maintenance`, and `major_replacement`.
- Crew states: `idle`, `driving_to_work`, `working`, and `driving_home`.
- Events include failure, maintenance due, request queueing, dispatch, arrival,
  work completion, return, and daily snapshot.
- Time is measured in fractional days; one public step advances to the next
  natural-day boundary.
- The principal decision variable is crew count. Other exposed inputs are
  scenario assumptions, not automatically recommended policies.

## Inputs and uncertainty

| Input group | Unit | Source | Distribution/range | Random stream | Missing-data treatment |
| --- | --- | --- | --- | --- | --- |
| Fleet and crew capacity | count | Synthetic preset | Parameter schema bounds | none | reject invalid or missing required values |
| Failure timing | days | Behavioral source mapping | exponential | `failure` | no silent imputation |
| Repair, maintenance, replacement durations | days | Synthetic/source-informed defaults | triangular | named operation stream | no silent imputation |
| Initial turbine layout and maintenance age | coordinates/days | Synthetic initialization | bounded uniform | `layout`, `initial_maintenance` | generated only from the declared seed |
| Replacement decision | probability | Synthetic assumption | Bernoulli | `replacement_decision` | reject values outside schema |

## Outputs and experiment plan

- Primary KPIs: availability fraction, crew utilization, failure/repair/
  maintenance/replacement counts, maintenance cost, operating revenue, and
  queue-delay diagnostics.
- The default experiment runs 1,095 days, excludes a 365-day warm-up from KPI
  aggregation, and uses one fixed seed (`2`).
- `summary.json` and `daily-kpis.csv` are required outputs;
  `domain-events.ndjson` is a bounded diagnostic event stream.
- A single-seed run is a technical baseline. Comparative or uncertainty claims
  require explicitly configured additional scenarios and seeds.

## Validation and claim boundary

- Required checks include fixed-seed reproducibility, lifecycle invariants,
  corrective-priority ordering, simultaneous-event ordering, queue integrity,
  warm-up exclusion, and KPI denominator checks.
- The included microcases and traceability assets document those checks; a
  successful Riff Run establishes execution only.
- This template is not calibrated to a real wind farm, does not establish
  AnyLogic numerical equivalence, and is not decision-ready.
- Any change to entities, rule order, units, distributions, KPI definitions, or
  validation boundaries must update this file and the corresponding model
  assets before a new immutable Template version is published.

## Review checklist

- [x] Decision question, intended use, and non-use are explicit.
- [x] Facts, policies, assumptions, and open questions are separated.
- [x] Entities, states, events, resources, time, and decision variables are defined.
- [x] Inputs, random streams, outputs, experiment defaults, and microcases are traceable.
- [x] Technical execution is separated from validation, calibration, and decision readiness.

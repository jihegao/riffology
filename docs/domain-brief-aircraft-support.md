# Aircraft maintenance & logistics support domain brief（飞机保障领域简报）

- Status: draft for review
- Role: reviewable domain brief; not an implementation design
- Scope: aircraft maintenance & logistics support as the second ordinary Riff Model (post-MVP domain content)
- Source of truth: [`product-requirements.md`](product-requirements.md)
- Last reviewed: 2026-07-31

## Decision question and scope

- Decision/user question: given a fleet, its daily flight task requirement,
  maintenance teams, hangars, and spare-part stocks, can the support system keep
  the fleet mission-capable at an acceptable availability and cost? Which team
  count, maintenance policy, or spare-part stock policy is the bottleneck and
  where should resources/parts be added?
- In scope:
  - Multi-echelon linkage: daily flight tasks → flying hours → unscheduled
    failures and scheduled maintenance due → maintenance work needing
    teams + hangar slots + spare parts → shortages causing ground time (AOG).
  - Corrective (unscheduled) and scheduled maintenance with explicit
    team/hangar/part resource contention.
  - A small, configurable spare-part catalog with reorder-point/order-quantity
    policy and lead time.
  - Fleet-level availability / mission-capable KPIs, maintenance queues,
    part backorders, and cost.
- Out of scope (v1):
  - Multiple aircraft types with heterogeneous part catalogs (single-type fleet).
  - Personnel training/skill certification, shift calendars, overtime rules.
  - Flight scheduling optimization or mission planning; missions are a fixed
    daily demand input, not a decision output.
  - Part supply chain beyond the base warehouse (no multi-echelon logistics).
  - Physics/fatigue/health-monitoring predictive maintenance.
- Intended use: comparative "what-if" resource/part policy experiments and
  bottleneck review by the demo user.
- Non-use: not a calibrated operational planning tool, not a real
  maintenance-management system, and not a recommendation engine; any optimal
  policy claim requires explicit user-requested optimization experiments that
  this model does not automate.

## Evidence and assumptions

| Type | Item | Source or rationale | Owner | Status |
| --- | --- | --- | --- | --- |
| fact | Riff treats wind and aircraft capabilities as ordinary Model/Project content, never as Core branches | PRD §7.2/§7.3 | user | accepted |
| fact | Daily flight task is the workload driver that converts to flying hours | domain convention | user | accepted |
| assumption | Fleet is homogeneous (single aircraft type) | simplification for v1 | user | open-to-confirm |
| assumption | One daily mission block per aircraft with configured flying hours | synthetic default | user | open-to-confirm |
| assumption | Failures occur only while flying; failure risk scales with flying hours | domain convention | user | open-to-confirm |
| assumption | Scheduled maintenance due is interval-based (flying-hour and/or calendar-day), performed on the ground | domain convention | user | open-to-confirm |
| assumption | Maintenance teams are generalist; hangar slots bound concurrent scheduled work | synthetic default | user | open-to-confirm |
| assumption | Spare-part demand arises at repair/replacement completion; shortage grounds the aircraft until part arrival (AOG) | domain convention | user | open-to-confirm |
| assumption | Part procurement is reorder-point/order-quantity with fixed lead time | synthetic policy | user | open-to-confirm |
| policy | Corrective work preempts scheduled work at assignment time; FIFO within each queue | mirrors wind demo | user | policy |
| open question | Real fleet size, MTBF, maintenance intervals, repair/maintenance duration families, team count, part catalog | verbal/experience description, values not yet supplied | user | open |
| open question | Real currency, costs, and cost weighting for shortage (AOG) penalty | not supplied | user | open |
| policy | All v1 numeric defaults carry `source_seeded_synthetic_assumption` provenance and `draft_unverified` trust | follows wind demo contract | user | policy |

The verbal/experience source items are recorded but **not** yet quantified.
Until real numbers are supplied, v1 defaults are synthetic and the model claims
technical executability only, never calibration or decision readiness.

## Ontology and behavior

- Entities and identifiers:
  - Aircraft: `aircraft-0001` … owns state, flying-hour accumulator,
    maintenance-due timestamps, active order references, assigned team.
  - MaintenanceTeam: `team-01` … owns state, current work order, capability.
  - HangarSlot: `hangar-01` … capacity resource occupied by scheduled work.
  - PartType: `part-engine-01` … catalog entry with stock level, reorder
    point, order quantity, lead time, unit cost.
  - WorkOrder: `work-00000001` … one order per aircraft per need; kind
    `corrective | scheduled`; links to part demand.
  - PartOrder: `po-00000001` … procurement order with expected arrival.
  - Daily task demand: fixed per-day required missions (input).
- State machines and transitions:
  - AircraftState = `grounded_for_repair | grounded_for_maintenance |
    grounded_for_part | operating | in_flight`.
  - TeamState = `idle | working`.
  - HangarState = `free | occupied` (capacity count).
  - WorkOrderStatus = `queued | assigned | in_progress | blocked_on_part |
    completed | superseded`.
- Events, queues, resources, priorities, and tie-breaks:
  - Queues: corrective queue, scheduled queue, part backorder queue.
  - Priority: corrective before scheduled; FIFO within a queue; stable team/hangar
    ID as tie-break.
  - Resources: maintenance teams and hangar slots; parts are consumable
    resources with inventory.
  - Time unit: continuous fractional days internally; one public `step()`
    advances to the next natural-day boundary (mirrors wind demo).
- Control/decision variables (experiment-level):
  - team count; hangar count; scheduled-maintenance interval;
    part initial stock / reorder point / order quantity / lead time;
    daily task requirement.

## Inputs and uncertainty

| Input | Unit | Source | Distribution/range | Random stream | Missing-data treatment |
| --- | --- | --- | --- | --- | --- |
| `fleet_size` | count | synthetic default | 20 | — | open; default assumed |
| `daily_missions_per_aircraft` | missions/day | synthetic default | 1 | — | open; default assumed |
| `mission_flying_hours` | hours | synthetic default | deterministic | — | open; default assumed |
| `failure_rate_per_flying_hour` | 1/fh | synthetic default | point | `failure` | open; default assumed |
| `scheduled_maintenance_interval_days` | day | synthetic default | point | — | open; default assumed |
| `repair_duration` | hours | synthetic default | triangular | `repair_duration` | open; default assumed |
| `scheduled_duration` | hours | synthetic default | triangular | `scheduled_duration` | open; default assumed |
| part catalog (per PartType) | stock/cost/lead | synthetic default | point | `parts` | open; default assumed |
| `crew_cost_per_day`, part unit costs, `aog_penalty_per_day` | currency | synthetic default | point | — | open; default assumed |
| `horizon_days`, `warmup_days`, `seed` | day, day, int | experiment config | — | — | follow wind demo limits |

Named streams are derived from the run seed exactly like the wind demo
(`aircraft-support-v1:<run-seed>:<stream-name>`, SHA-256 first 64 bits) so that
draw order changes never perturb unrelated mechanisms.

## Outputs and experiment plan

- KPIs and denominators:
  - Fleet availability fraction = available aircraft-days / (fleet_size ×
    elapsed), with explicit numerator/denominator.
  - Mission completion rate = completed missions / required missions.
  - Corrective and scheduled queue lengths; mean/P95 corrective response wait.
  - Part fill rate = satisfied part requests / part requests;
    backorder count; stock-out events.
  - Team utilization and hangar utilization.
  - Cost: crew cost + repair/maintenance cost + part procurement cost +
    holding cost + AOG penalty.
- Scenarios/horizon: single synthetic scenario v1, `horizon_days` and
  `warmup_days` mirror the wind demo defaults; one integer seed per experiment.
- Required event/output schema: a `daily_snapshot` projection row plus
  mechanism events (`flight_started`, `flight_completed`, `failure_occurred`,
  `maintenance_due`, `request_queued`, `request_superseded`,
  `request_suppressed`, `repair_started`, `repair_completed`,
  `maintenance_started`, `maintenance_completed`, `team_assigned`,
  `part_ordered`, `part_received`, `part_backordered`, `aircraft_released`,
  `aircraft_grounded`), exported to `domain-events.jsonl`, `daily-kpis.csv`,
  `summary.json` with canonical digests (wind demo contract).

## Validation and claim boundary

- Microcases / invariants: population conservation; no double-assignment of
  team/aircraft; single order per aircraft per need; no negative stocks/time;
  zero-distance idle-team assignment; corrective-priority and FIFO order; part
  backorder releases aircraft only on part receipt.
- Historical or engineering comparison: none available yet; the verbal
  description source has no quantified values, so no calibration is claimed.
- What a successful technical run does not prove: correct maintenance
  physics, valid MTBF/interval values, calibrated cost model, or a
  decision-ready resource recommendation.
- Open decisions: fleet/task parameters, failure/maintenance distributions,
  part catalog and costs, AOG penalty weighting, and whether the single daily
  mission block should be a per-aircraft schedule rather than a fleet-level
  demand.

## Review checklist

- [ ] Decision question is explicit and the model cannot silently answer beyond it.
- [ ] Facts vs assumptions vs policy vs open questions are separated in the evidence table.
- [ ] Ontology entities, states, events, queues, resources, time unit, and control variables are defined.
- [ ] Every rule has an owner and an observable consequence.
- [ ] Inputs list units, sources, distributions, named streams, and missing-data treatment.
- [ ] KPI denominators, warm-up/horizon, seeds, and output schema are specified.
- [ ] Non-claims are stated: technical run ≠ calibrated ≠ decision-ready.
- [ ] Riff boundary preserved: no aircraft ontology enters platform Core.

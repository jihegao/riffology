# Wind turbine maintenance Model

This preinstalled example is an ordinary Riff Model backed by the reviewed
Mesa wind-turbine maintenance mechanism. Its baseline uses synthetic inputs
and one fixed seed. It is a behavioral reproduction, not AnyLogic runtime or
numerical equivalence, real-wind-farm calibration, uncertainty analysis, or a
staffing recommendation.

The `riff-batch-v1` adapter emits a generic JSON summary, daily KPI table, and
diagnostic domain-event stream. Product APIs and UI code do not contain a
Wind-specific resource type or route.

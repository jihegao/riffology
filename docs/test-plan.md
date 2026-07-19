# Test plan

## Critical end-to-end scenario

1. A user uploads a supported input file through the left pane.
2. The assistant receives attachment metadata and prepares a supported Mesa model.
3. The right pane presents the model parameters.
4. A parameter is changed and an experiment is started.
5. The page reaches a terminal success state and renders metrics plus a time series.
6. The assistant reads the run artifacts and returns a result summary.

## Required evidence

- Unit tests for public backend and frontend contracts.
- A Mesa smoke run using a fixed seed.
- API integration test covering upload, model load, run start, status, and results.
- Playwright end-to-end test of the critical scenario.
- Visual inspection at the intended desktop viewport.


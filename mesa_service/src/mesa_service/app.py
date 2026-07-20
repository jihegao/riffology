"""Internal FastAPI application for the Mesa execution contract."""

from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse

from .service import MesaService, ServiceError


def create_app(
    workspace_root: str | Path | None = None,
    *,
    timeout_seconds: float = 30,
    wind_timeout_seconds: float = 180,
    worker_limit: int = 2,
    worker_delay_seconds: float = 0,
    owner_lease_seconds: float = 10.0,
) -> FastAPI:
    root = Path(workspace_root or os.environ.get("WORKSPACE_ROOT", ".riff-workspace"))
    service = MesaService(
        root,
        timeout_seconds=timeout_seconds,
        wind_timeout_seconds=wind_timeout_seconds,
        worker_limit=worker_limit,
        worker_delay_seconds=worker_delay_seconds,
        owner_lease_seconds=owner_lease_seconds,
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        stop = asyncio.Event()

        async def poller() -> None:
            while not stop.is_set():
                service.poll()
                await asyncio.sleep(0.05)

        task = asyncio.create_task(poller())
        try:
            yield
        finally:
            stop.set()
            await task
            service.shutdown()

    app = FastAPI(title="Riff Mesa execution service", version="0.1.0", lifespan=lifespan)
    app.state.mesa_service = service

    @app.exception_handler(ServiceError)
    async def service_error(_: Request, exc: ServiceError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content={"error": {"code": exc.code, "message": exc.message, "details": {}}})

    @app.exception_handler(RequestValidationError)
    async def request_validation_error(_: Request, __: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content={"error": {"code": "invalid_request", "message": "request does not match the API contract", "details": {}}},
        )

    @app.put("/v1/projects/{project_id}/model")
    async def load_model(project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return service.load_model(project_id, payload)

    @app.get("/v1/projects/{project_id}/model")
    async def get_model(project_id: str) -> dict[str, Any]:
        return service.get_model(project_id)

    @app.get("/v1/projects/{project_id}/parameters")
    async def get_parameters(project_id: str) -> dict[str, Any]:
        return service.get_parameters(project_id)

    @app.put("/v1/projects/{project_id}/models/wind-turbine-maintenance")
    async def load_wind_model(project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return service.load_wind_model(project_id, payload)

    @app.put("/v2/projects/{project_id}/models/wind-turbine-maintenance")
    async def load_wind_model_v2(project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return service.load_wind_model_v2(project_id, payload)

    @app.get("/v1/projects/{project_id}/models/active")
    async def get_active_wind_model(project_id: str) -> dict[str, Any]:
        return service.get_active_wind_model(project_id)

    @app.post("/v1/projects/{project_id}/runs", status_code=202)
    async def start_run(project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return service.start_run(project_id, payload)

    @app.post("/v2/projects/{project_id}/runs", status_code=202)
    async def start_wind_run_v2(
        project_id: str,
        payload: dict[str, Any],
        idempotency_key: str = Header(alias="Idempotency-Key"),
        run_id: str = Header(alias="X-Riff-Run-Id"),
        request_digest: str = Header(alias="X-Riff-Request-Digest"),
    ) -> dict[str, Any]:
        return service.start_wind_run_v2(
            project_id,
            payload,
            downstream_key=idempotency_key,
            run_id=run_id,
            downstream_digest=request_digest,
        )

    @app.get("/v1/projects/{project_id}/runs/{run_id}")
    async def get_run(project_id: str, run_id: str) -> dict[str, Any]:
        return service.get_run(project_id, run_id)

    @app.get("/v2/projects/{project_id}/runs/{run_id}")
    async def get_wind_run_v2(project_id: str, run_id: str) -> dict[str, Any]:
        return service.get_run(project_id, run_id)

    @app.get("/v2/projects/{project_id}/run-receipts/{downstream_key}")
    async def get_wind_run_receipt_v2(project_id: str, downstream_key: str) -> dict[str, Any]:
        return service.get_wind_run_receipt_v2(project_id, downstream_key)

    @app.post("/v1/projects/{project_id}/runs/{run_id}/cancel", status_code=202)
    async def cancel_run(project_id: str, run_id: str) -> dict[str, Any]:
        return service.cancel_run(project_id, run_id)

    @app.post("/v2/projects/{project_id}/runs/{run_id}/cancel", status_code=202)
    async def cancel_wind_run_v2(project_id: str, run_id: str) -> dict[str, Any]:
        return service.cancel_wind_run_v2(project_id, run_id)

    @app.get("/v1/projects/{project_id}/runs/{run_id}/results")
    async def get_results(project_id: str, run_id: str) -> dict[str, Any]:
        return service.get_results(project_id, run_id)

    @app.get("/v1/projects/{project_id}/runs/{run_id}/events")
    async def get_events(project_id: str, run_id: str, after: int = 0, limit: int = 100) -> dict[str, Any]:
        return service.get_events(project_id, run_id, after=after, limit=limit)

    @app.get("/v1/projects/{project_id}/runs/{run_id}/artifacts/{name}")
    async def get_artifact(project_id: str, run_id: str, name: str) -> FileResponse:
        path, media_type = service.get_artifact(project_id, run_id, name)
        return FileResponse(path, media_type=media_type, filename=name)

    return app


app = create_app()

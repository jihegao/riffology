"""Internal FastAPI application for the Mesa execution contract."""

from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException

from .canonical_v2 import CanonicalV2Error, canonical_json_v2_bytes, strict_json_loads_v2

from .service import MesaService, ServiceError


def create_app(
    workspace_root: str | Path | None = None,
    *,
    wind_timeout_seconds: float = 180,
    worker_limit: int = 2,
    worker_delay_seconds: float = 0,
    owner_lease_seconds: float = 10.0,
) -> FastAPI:
    root = Path(workspace_root or os.environ.get("WORKSPACE_ROOT", ".riff-workspace"))
    service = MesaService(
        root,
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

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {"healthy": True, "workspace_lifecycle": service.workspace_lifecycle_proof()}

    def _one_header(request: Request, name: str, expected: str | None = None) -> str:
        values = request.headers.getlist(name)
        if len(values) != 1 or (expected is not None and values[0] != expected):
            raise ServiceError(422, "invalid_activation_protocol", "internal protocol headers are invalid")
        return values[0]

    async def _internal_json(request: Request, activation_id: str, *, if_match: bool = False) -> tuple[dict[str, Any], str | None]:
        if request.url.query:
            raise ServiceError(422, "invalid_activation_protocol", "internal protocol query keys are invalid")
        _one_header(request, "content-type", "application/json")
        _one_header(request, "x-riff-internal-protocol", "wind-activation-v1")
        _one_header(request, "idempotency-key", activation_id)
        match = _one_header(request, "if-match") if if_match else None
        try:
            body = await request.body()
            value = strict_json_loads_v2(body)
            if canonical_json_v2_bytes(value) != body or not isinstance(value, dict):
                raise CanonicalV2Error("body is not exact canonical JSON")
        except CanonicalV2Error as exc:
            raise ServiceError(422, "invalid_activation_protocol", "internal JSON is invalid") from exc
        return value, match

    @app.exception_handler(ServiceError)
    async def service_error(request: Request, exc: ServiceError) -> Response:
        content = {"error": {"code": exc.code, "message": exc.message, "details": {}}}
        if request.url.path.startswith("/internal/"):
            return Response(status_code=exc.status_code, content=canonical_json_v2_bytes(content), media_type="application/json")
        return JSONResponse(status_code=exc.status_code, content=content)

    @app.exception_handler(RequestValidationError)
    async def request_validation_error(request: Request, __: RequestValidationError) -> Response:
        content = {"error": {"code": "invalid_request", "message": "request does not match the API contract", "details": {}}}
        if request.url.path.startswith("/internal/"):
            return Response(status_code=422, content=canonical_json_v2_bytes(content), media_type="application/json")
        return JSONResponse(status_code=422, content=content)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: StarletteHTTPException) -> Response:
        if request.url.path.startswith("/internal/"):
            code = "method_not_allowed" if exc.status_code == 405 else "resource_not_found"
            message = "internal method is not allowed" if exc.status_code == 405 else "internal resource was not found"
            content = {"error": {"code": code, "message": message, "details": {}}}
            return Response(status_code=exc.status_code, content=canonical_json_v2_bytes(content), media_type="application/json")
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})

    @app.put("/v2/projects/{project_id}/models/wind-turbine-maintenance")
    async def materialize_wind_model(project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return service.materialize_wind_model(project_id, payload)

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

    @app.get("/v2/projects/{project_id}/runs/{run_id}/evidence")
    async def get_wind_run_evidence_v2(project_id: str, run_id: str) -> dict[str, Any]:
        return service.get_wind_run_evidence_v2(project_id, run_id)

    @app.get("/v2/projects/{project_id}/run-receipts/{downstream_key}")
    async def get_wind_run_receipt_v2(project_id: str, downstream_key: str) -> dict[str, Any]:
        return service.get_wind_run_receipt_v2(project_id, downstream_key)

    @app.post("/v2/projects/{project_id}/runs/{run_id}/cancel", status_code=202)
    async def cancel_wind_run_v2(project_id: str, run_id: str) -> dict[str, Any]:
        return service.cancel_wind_run_v2(project_id, run_id)

    @app.get("/v1/projects/{project_id}/runs/{run_id}/events")
    async def get_events(project_id: str, run_id: str, after: int = 0, limit: int = 100) -> dict[str, Any]:
        return service.get_events(project_id, run_id, after=after, limit=limit)

    @app.get("/v1/projects/{project_id}/runs/{run_id}/artifacts/{name}")
    async def get_artifact(project_id: str, run_id: str, name: str) -> FileResponse:
        path, media_type = service.get_artifact(project_id, run_id, name)
        return FileResponse(path, media_type=media_type, filename=name)

    @app.get("/internal/projects/{project_id}/wind/runtime-candidate-handshake/v1")
    async def gate3_runtime_handshake(project_id: str, request: Request) -> Response:
        if request.url.query or await request.body():
            raise ServiceError(422, "invalid_activation_protocol", "handshake accepts no query or body")
        _one_header(request, "accept", "application/json")
        _one_header(request, "x-riff-internal-protocol", "wind-runtime-handshake-v1")
        return Response(content=canonical_json_v2_bytes(service.gate3_runtime_handshake(project_id)), media_type="application/json")

    @app.post("/internal/wind/framed-candidates/materialize")
    async def gate3_materialize_candidate(request: Request) -> Response:
        raw = await request.body()
        try:
            preliminary = strict_json_loads_v2(raw)
            activation_id = preliminary.get("activation_id") if isinstance(preliminary, dict) else None
        except CanonicalV2Error:
            activation_id = None
        if not isinstance(activation_id, str):
            raise ServiceError(422, "invalid_activation_protocol", "activation identity is invalid")
        payload, _ = await _internal_json(request, activation_id)
        status, receipt = service.gate3_materialize_candidate(payload, activation_id)
        return Response(status_code=status, content=canonical_json_v2_bytes(receipt), media_type="application/json")

    @app.get("/internal/wind/framed-candidates/{activation_id}")
    async def gate3_capture_candidate(activation_id: str, request: Request) -> Response:
        if request.url.query or await request.body():
            raise ServiceError(422, "invalid_activation_protocol", "capture accepts no query or body")
        _one_header(request, "accept", "application/json")
        _one_header(request, "x-riff-internal-protocol", "wind-activation-v1")
        _one_header(request, "idempotency-key", activation_id)
        return Response(content=canonical_json_v2_bytes(service.gate3_capture_candidate(activation_id)), media_type="application/json")

    @app.get("/internal/projects/{project_id}/wind/framed-candidates/{activation_id}/byte-capture/v1")
    async def gate3_capture_candidate_bytes(project_id: str, activation_id: str, request: Request) -> Response:
        if request.url.query or await request.body():
            raise ServiceError(422, "invalid_activation_protocol", "byte capture accepts no query or body")
        _one_header(request, "accept", "application/json")
        _one_header(request, "x-riff-internal-protocol", "wind-activation-v1")
        _one_header(request, "idempotency-key", activation_id)
        match = _one_header(request, "if-match")
        value = service.gate3_capture_candidate_bytes(project_id, activation_id, match)
        return Response(content=canonical_json_v2_bytes(value), media_type="application/json")

    @app.post("/internal/wind/active/cas")
    async def gate3_active_cas(request: Request) -> Response:
        raw = await request.body()
        try:
            preliminary = strict_json_loads_v2(raw)
            activation_id = preliminary.get("activation_id") if isinstance(preliminary, dict) else None
        except CanonicalV2Error:
            activation_id = None
        if not isinstance(activation_id, str):
            raise ServiceError(422, "invalid_activation_protocol", "activation identity is invalid")
        payload, match = await _internal_json(request, activation_id, if_match=True)
        return Response(content=canonical_json_v2_bytes(service.gate3_cas_active(payload, activation_id, match or "")), media_type="application/json")

    @app.get("/internal/wind/activations/{activation_id}/status")
    async def gate3_activation_status(activation_id: str, request: Request) -> Response:
        if request.url.query or await request.body():
            raise ServiceError(422, "invalid_activation_protocol", "status accepts no query or body")
        _one_header(request, "accept", "application/json")
        _one_header(request, "x-riff-internal-protocol", "wind-activation-v1")
        _one_header(request, "idempotency-key", activation_id)
        return Response(content=canonical_json_v2_bytes(service.gate3_activation_status(activation_id)), media_type="application/json")

    return app


class _LazyDefaultApplication:
    """Create the default service at ASGI startup, never as an import side effect."""

    def __init__(self) -> None:
        self._application: FastAPI | None = None

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if self._application is None:
            self._application = create_app()
        await self._application(scope, receive, send)


app = _LazyDefaultApplication()

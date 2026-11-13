"""Application factory: error contract, security headers, routes."""

from __future__ import annotations

import logging
from pathlib import Path

import asyncpg
from fastapi import Depends, FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import FileResponse, JSONResponse, Response

from .auth import authenticate, register_auth
from .catalog import register_catalog
from .config import Settings
from .fulfillment import register_fulfillment
from .http import ApiError, User
from .media import register_media
from .orders import register_orders

logger = logging.getLogger("shop")

MAX_JSON_BODY = 1024 * 1024
CONFLICT_CODES = {"23505", "23503", "23514"}
WEB_DIST = Path(__file__).resolve().parents[2] / "web" / "dist"


def error_response(error: ApiError) -> JSONResponse:
    body: dict[str, object] = {"error": error.code, "message": error.message}
    if error.details is not None:
        body["details"] = jsonable_encoder(error.details)
    return JSONResponse(status_code=error.status_code, content=body)


def create_app(
    pool: asyncpg.Pool, config: Settings, web_dir: Path | None = None
) -> FastAPI:
    app = FastAPI(title="Telegram order manager", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.pool = pool
    app.state.config = config

    @app.exception_handler(ApiError)
    async def _api_error(_request: Request, error: ApiError) -> JSONResponse:
        return error_response(error)

    @app.exception_handler(RequestValidationError)
    async def _invalid_input(_request: Request, error: RequestValidationError) -> JSONResponse:
        details = []
        for issue in error.errors():
            parts = [str(part) for part in issue["loc"]]
            if parts and parts[0] in {"body", "path", "query"}:
                parts = parts[1:]
            details.append({"field": ".".join(parts), "message": issue["msg"]})
        return JSONResponse(
            status_code=400,
            content={"error": "invalid_input", "message": "Check the submitted fields.", "details": details},
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(request: Request, error: StarletteHTTPException) -> JSONResponse:
        if error.status_code == 404:
            return JSONResponse(
                status_code=404,
                content={"error": "not_found", "message": "Endpoint not found"},
            )
        return JSONResponse(
            status_code=error.status_code,
            content={"error": "invalid_request", "message": "Invalid or oversized request."},
        )

    @app.exception_handler(asyncpg.IntegrityConstraintViolationError)
    async def _conflict(_request: Request, error: asyncpg.PostgresError) -> JSONResponse:
        if error.sqlstate in CONFLICT_CODES:
            return JSONResponse(
                status_code=409,
                content={
                    "error": "conflict",
                    "message": "This operation conflicts with current records. Refresh and try again.",
                },
            )
        logger.exception("Database constraint failure")
        return JSONResponse(
            status_code=500,
            content={"error": "internal_error", "message": "The request could not be completed."},
        )

    @app.exception_handler(Exception)
    async def _internal_error(_request: Request, error: Exception) -> JSONResponse:
        logger.exception("Request failed")
        return JSONResponse(
            status_code=500,
            content={"error": "internal_error", "message": "The request could not be completed."},
        )

    @app.middleware("http")
    async def headers_and_body_limit(request: Request, call_next) -> Response:
        content_type = request.headers.get("content-type", "")
        declared = request.headers.get("content-length")
        if request.method in {"POST", "PATCH", "PUT"} and content_type.startswith("application/json") and declared:
            try:
                too_large = int(declared) > MAX_JSON_BODY
            except ValueError:
                too_large = True
            if too_large:
                return JSONResponse(
                    status_code=413,
                    content={"error": "invalid_request", "message": "Invalid or oversized request."},
                )
        response = await call_next(request)
        if response.headers.get("content-type") == "application/json":
            response.headers["content-type"] = "application/json; charset=utf-8"
        path = request.url.path
        if response.status_code == 200 and (
            path.startswith("/assets/") or path.startswith("/api/public-media/")
        ):
            # Content-addressed files: safe to keep forever.
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        elif not path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-cache"
        else:
            response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    @app.get("/api/health")
    async def health() -> dict[str, bool]:
        return {"ok": True}

    register_auth(app, pool, config)
    register_media(app, pool, config)
    register_catalog(app, pool, config)
    register_orders(app, pool, config)
    register_fulfillment(app, pool, config)

    @app.api_route(
        "/api/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"]
    )
    async def unknown_api(path: str, user: User = Depends(authenticate)) -> Response:
        # A known route above always wins. For the rest, authenticate first:
        # the Node service applies its bearer preHandler even to unknown /api paths.
        raise StarletteHTTPException(status_code=404)

    root = (WEB_DIST if web_dir is None else web_dir).resolve()
    index = root / "index.html"
    if index.is_file():
        # Registered last: every /api route above wins. Non-API paths serve a
        # real file when present and otherwise the SPA shell, like the Node app.
        @app.get("/{path:path}")
        async def single_page(path: str) -> Response:
            if path == "api" or path.startswith("api/"):
                raise StarletteHTTPException(status_code=404)
            candidate = (root / path).resolve()
            if path and candidate.is_file() and candidate.is_relative_to(root):
                return FileResponse(candidate)
            if path.startswith("assets/"):
                # Never return the HTML shell for a missing hashed asset.
                raise StarletteHTTPException(status_code=404)
            return FileResponse(index, media_type="text/html")

    return app

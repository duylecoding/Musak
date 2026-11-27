"""FastAPI application factory for the Musak Local Audio & Producer Backend."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from musak import __version__
from musak.routers import ALL_ROUTERS
from musak.routers.deps import store
from musak.stems import recover_stuck_processing_state
from musak.storage import InvalidIdError, ProjectNotFoundError


@asynccontextmanager
async def _lifespan(_app: FastAPI) -> AsyncIterator[None]:
    recover_stuck_processing_state(store)
    yield


app = FastAPI(
    title="Musak Local Audio & Producer Backend",
    version=__version__,
    lifespan=_lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://tauri.localhost",
        "https://tauri.localhost",
        "null",
        "file://",
    ],
    allow_origin_regex=r"^(https?://(localhost|127\.0\.0\.1|tauri\.localhost)(:\d+)?|tauri://localhost|file://.*|null)$",
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition"],
)


@app.exception_handler(InvalidIdError)
async def _invalid_id_handler(_request: Request, exc: InvalidIdError) -> JSONResponse:
    return JSONResponse(status_code=400, content={"detail": str(exc)})


@app.exception_handler(ProjectNotFoundError)
async def _not_found_handler(_request: Request, exc: ProjectNotFoundError) -> JSONResponse:
    return JSONResponse(status_code=404, content={"detail": str(exc)})


for router in ALL_ROUTERS:
    app.include_router(router)

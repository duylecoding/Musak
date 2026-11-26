"""Domain routers for the Musak FastAPI backend."""

from __future__ import annotations

from musak.routers import chat, edits, health, projects, references, sfx, tracks

ALL_ROUTERS = (
    health.router,
    projects.router,
    tracks.router,
    references.router,
    edits.router,
    sfx.router,
    chat.router,
)

__all__ = ["ALL_ROUTERS", "chat", "edits", "health", "projects", "references", "sfx", "tracks"]

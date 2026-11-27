"""Domain routers for the Musak FastAPI backend."""

from __future__ import annotations

from musak.routers import chat, edits, engine, health, projects, references, sfx, track_cues, tracks

ALL_ROUTERS = (
    health.router,
    projects.router,
    tracks.router,
    track_cues.router,
    references.router,
    edits.router,
    engine.router,
    sfx.router,
    chat.router,
)

__all__ = ["ALL_ROUTERS", "chat", "edits", "engine", "health", "projects", "references", "sfx", "track_cues", "tracks"]

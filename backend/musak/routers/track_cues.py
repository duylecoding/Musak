"""Main track metadata (BPM/key) override and manual cue marker CRUD routes."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from musak.models import (
    AddCueRequest,
    CueMarker,
    ProjectState,
    UpdateCueRequest,
    UpdateMainTrackMetaRequest,
)
from musak.routers.deps import _enrich_project, store
from musak.storage import generate_id, validate_id

router = APIRouter(tags=["tracks"])


def _rebuild_beat_grid(bpm: float, duration: float, existing_beats: list[float]) -> list[float]:
    """Build an evenly spaced beat grid across `[0, duration]` anchored to first beat mod beat_interval."""
    if duration <= 0.0 or bpm <= 0.0:
        return []
    beat_interval = 60.0 / bpm
    anchor = (existing_beats[0] % beat_interval) if existing_beats else 0.0
    beats: list[float] = []
    t = anchor
    while t < duration:
        beats.append(round(t, 3))
        t += beat_interval
    return beats


@router.patch("/api/projects/{project_id}/main-track/meta", response_model=ProjectState)
def update_main_track_meta(project_id: str, body: UpdateMainTrackMetaRequest) -> ProjectState:
    validate_id(project_id, "project_id")
    if store.get_project(project_id).main_track is None:
        raise HTTPException(status_code=400, detail="Upload a main track before updating track metadata.")

    def _update(proj: ProjectState) -> None:
        if proj.main_track is None:
            raise HTTPException(status_code=400, detail="Upload a main track before updating track metadata.")
        if body.bpm is not None:
            new_bpm = round(float(body.bpm), 2)
            proj.main_track.bpm = new_bpm
            proj.main_track.beats = _rebuild_beat_grid(
                new_bpm, proj.main_track.duration, proj.main_track.beats
            )
        if body.key is not None:
            proj.main_track.key = body.key

    return _enrich_project(store.update_project(project_id, _update))


@router.post("/api/projects/{project_id}/main-track/cues", response_model=ProjectState)
def add_main_track_cue(project_id: str, body: AddCueRequest) -> ProjectState:
    validate_id(project_id, "project_id")
    project = store.get_project(project_id)
    if project.main_track is None:
        raise HTTPException(status_code=400, detail="Upload a main track before adding cue markers.")

    cue_id = generate_id("cue")

    def _add(proj: ProjectState) -> None:
        if proj.main_track is None:
            raise HTTPException(status_code=400, detail="Upload a main track before adding cue markers.")
        clamped_time = round(max(0.0, min(float(body.time), proj.main_track.duration)), 3)
        proj.main_track.cues.append(
            CueMarker(id=cue_id, label=body.label, time=clamped_time, color=body.color)
        )
        proj.main_track.cues.sort(key=lambda c: c.time)

    return _enrich_project(store.update_project(project_id, _add))


@router.patch("/api/projects/{project_id}/main-track/cues/{cue_id}", response_model=ProjectState)
def update_main_track_cue(project_id: str, cue_id: str, body: UpdateCueRequest) -> ProjectState:
    validate_id(project_id, "project_id")
    validate_id(cue_id, "cue_id")
    project = store.get_project(project_id)
    if project.main_track is None:
        raise HTTPException(status_code=400, detail="Upload a main track before updating cue markers.")
    if not any(c.id == cue_id for c in project.main_track.cues):
        raise HTTPException(status_code=404, detail=f"Cue '{cue_id}' not found.")

    def _patch(proj: ProjectState) -> None:
        if proj.main_track is None:
            raise HTTPException(status_code=400, detail="Upload a main track before updating cue markers.")
        cue = next((c for c in proj.main_track.cues if c.id == cue_id), None)
        if cue is None:
            raise HTTPException(status_code=404, detail=f"Cue '{cue_id}' not found.")
        if body.label is not None:
            cue.label = body.label
        if body.color is not None:
            cue.color = body.color
        if body.time is not None:
            cue.time = round(max(0.0, min(float(body.time), proj.main_track.duration)), 3)
        proj.main_track.cues.sort(key=lambda c: c.time)

    return _enrich_project(store.update_project(project_id, _patch))


@router.delete("/api/projects/{project_id}/main-track/cues/{cue_id}", response_model=ProjectState)
def delete_main_track_cue(project_id: str, cue_id: str) -> ProjectState:
    validate_id(project_id, "project_id")
    validate_id(cue_id, "cue_id")
    project = store.get_project(project_id)
    if project.main_track is None:
        raise HTTPException(status_code=400, detail="Upload a main track before deleting cue markers.")
    if not any(c.id == cue_id for c in project.main_track.cues):
        raise HTTPException(status_code=404, detail=f"Cue '{cue_id}' not found.")

    def _delete(proj: ProjectState) -> None:
        if proj.main_track is None:
            raise HTTPException(status_code=400, detail="Upload a main track before deleting cue markers.")
        if not any(c.id == cue_id for c in proj.main_track.cues):
            raise HTTPException(status_code=404, detail=f"Cue '{cue_id}' not found.")
        proj.main_track.cues = [c for c in proj.main_track.cues if c.id != cue_id]

    return _enrich_project(store.update_project(project_id, _delete))

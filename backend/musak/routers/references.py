"""Reference shelf upload, YouTube metadata, moments, auto-tag, stem extraction, and mashup routes."""

from __future__ import annotations

import logging
import shutil
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse

from musak.audio_analysis import analyze_audio, load_audio_to_stereo_wav
from musak.config import get_api_key, get_gemini_model
from musak.gemini_agent import auto_tag_reference
from musak.models import CreateMomentRequest, MashupRequest, MomentPin, ProjectState, ReferenceTrack, YouTubeReferenceRequest
from musak.routers.deps import (
    _enrich_project,
    _mutate_and_render,
    _safe_unlink,
    _save_upload_to_temp,
    _wav_file_response,
    store,
)
from musak.routers.mashup_builder import build_mashup_edit
from musak.stems import start_reference_stem_separation
from musak.storage import generate_id, validate_id
from musak.youtube import fetch_youtube_metadata

logger = logging.getLogger(__name__)
router = APIRouter(tags=["references"])


@router.post("/api/projects/{project_id}/references/upload", response_model=ProjectState)
def upload_reference_track(
    project_id: str,
    file: UploadFile = File(...),
    title: str | None = Form(default=None),
) -> ProjectState:
    validate_id(project_id, "project_id")
    store.get_project(project_id)

    ref_id = generate_id("ref")
    tmp_path = _save_upload_to_temp(file)
    try:
        dst_wav = store.reference_audio_path(project_id, ref_id)
        try:
            audio, sr = load_audio_to_stereo_wav(tmp_path, dst_wav)
        except (ValueError, RuntimeError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        analysis = analyze_audio(audio, sr)
        resolved_title = (title or "").strip() or Path(file.filename or "Reference").stem or "Reference"
        ref = ReferenceTrack(
            id=ref_id,
            title=resolved_title,
            source_type="local",
            youtube_url=None,
            youtube_id=None,
            duration=analysis.duration,
            bpm=analysis.bpm,
            key=analysis.key,
            audio_downloaded=True,
            stems_status="none",
            stems_error=None,
            audio_url=store.reference_audio_url(project_id, ref_id),
            moments=[],
        )

        def _add_ref(proj: ProjectState) -> None:
            proj.references.append(ref)

        return _enrich_project(store.update_project(project_id, _add_ref))
    finally:
        _safe_unlink(tmp_path)


@router.post("/api/projects/{project_id}/references/youtube", response_model=ProjectState)
def add_youtube_reference(project_id: str, body: YouTubeReferenceRequest) -> ProjectState:
    validate_id(project_id, "project_id")
    store.get_project(project_id)
    try:
        meta = fetch_youtube_metadata(body.url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    ref = ReferenceTrack(
        id=generate_id("ref"),
        title=(body.title or "").strip() or meta["title"],
        source_type="youtube",
        youtube_url=meta["youtube_url"],
        youtube_id=meta["youtube_id"],
        duration=meta["duration"],
        bpm=None,
        key=None,
        audio_downloaded=False,
        stems_status="none",
        stems_error=None,
        audio_url=None,
        moments=[],
    )

    def _add_ref(proj: ProjectState) -> None:
        proj.references.append(ref)

    return _enrich_project(store.update_project(project_id, _add_ref))


@router.delete("/api/projects/{project_id}/references/{ref_id}", response_model=ProjectState)
def delete_reference(project_id: str, ref_id: str) -> ProjectState:
    validate_id(project_id, "project_id")
    validate_id(ref_id, "ref_id")
    project = store.get_project(project_id)
    if not any(r.id == ref_id for r in project.references):
        raise HTTPException(status_code=404, detail=f"Reference '{ref_id}' not found.")

    ref_dir = store.reference_dir(project_id, ref_id)
    if ref_dir.exists():
        shutil.rmtree(ref_dir, ignore_errors=True)

    def _remove(proj: ProjectState) -> None:
        proj.references = [r for r in proj.references if r.id != ref_id]

    return _enrich_project(store.update_project(project_id, _remove))


@router.post("/api/projects/{project_id}/references/{ref_id}/moments", response_model=ProjectState)
def add_reference_moment(project_id: str, ref_id: str, body: CreateMomentRequest) -> ProjectState:
    validate_id(project_id, "project_id")
    validate_id(ref_id, "ref_id")
    project = store.get_project(project_id)
    if not any(r.id == ref_id for r in project.references):
        raise HTTPException(status_code=404, detail=f"Reference '{ref_id}' not found.")

    pin = MomentPin(
        id=generate_id("mom"),
        label=body.label.strip(),
        start=round(body.start, 3),
        end=round(body.end, 3),
        note=body.note.strip(),
        source="user",
    )

    def _add_pin(proj: ProjectState) -> None:
        ref = next((r for r in proj.references if r.id == ref_id), None)
        if ref is not None:
            ref.moments.append(pin)

    return _enrich_project(store.update_project(project_id, _add_pin))


@router.delete("/api/projects/{project_id}/references/{ref_id}/moments/{moment_id}", response_model=ProjectState)
def delete_reference_moment(project_id: str, ref_id: str, moment_id: str) -> ProjectState:
    validate_id(project_id, "project_id")
    validate_id(ref_id, "ref_id")
    validate_id(moment_id, "moment_id")
    project = store.get_project(project_id)
    ref = next((r for r in project.references if r.id == ref_id), None)
    if ref is None:
        raise HTTPException(status_code=404, detail=f"Reference '{ref_id}' not found.")
    if not any(m.id == moment_id for m in ref.moments):
        raise HTTPException(status_code=404, detail=f"Moment '{moment_id}' not found.")

    def _del_pin(proj: ProjectState) -> None:
        r = next((item for item in proj.references if item.id == ref_id), None)
        if r is not None:
            r.moments = [m for m in r.moments if m.id != moment_id]

    return _enrich_project(store.update_project(project_id, _del_pin))


@router.post("/api/projects/{project_id}/references/{ref_id}/auto-tag", response_model=ProjectState)
def auto_tag_reference_endpoint(
    project_id: str,
    ref_id: str,
    x_gemini_api_key: Annotated[str | None, Header()] = None,
) -> ProjectState:
    validate_id(project_id, "project_id")
    validate_id(ref_id, "ref_id")
    project = store.get_project(project_id)
    ref = next((r for r in project.references if r.id == ref_id), None)
    if ref is None:
        raise HTTPException(status_code=404, detail=f"Reference '{ref_id}' not found.")

    api_key = get_api_key(x_gemini_api_key)
    if not api_key:
        raise HTTPException(status_code=400, detail="Gemini API key is not configured.")

    ref_audio = store.reference_audio_path(project_id, ref_id)
    try:
        pins = auto_tag_reference(
            ref=ref,
            ref_audio_path=ref_audio if ref_audio.is_file() else None,
            api_key=api_key,
            model=get_gemini_model(),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Gemini auto-tag failed for %s/%s", project_id, ref_id)
        raise HTTPException(status_code=502, detail=f"Gemini auto-tag failed: {exc}") from exc

    def _attach_pins(proj: ProjectState) -> None:
        r = next((item for item in proj.references if item.id == ref_id), None)
        if r is not None:
            r.moments = [m for m in r.moments if m.source == "user"] + pins

    return _enrich_project(store.update_project(project_id, _attach_pins))


@router.post("/api/projects/{project_id}/references/{ref_id}/extract-stems", response_model=ProjectState)
def extract_reference_stems(project_id: str, ref_id: str) -> ProjectState:
    validate_id(project_id, "project_id")
    validate_id(ref_id, "ref_id")
    try:
        return _enrich_project(start_reference_stem_separation(store, project_id, ref_id))
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/api/projects/{project_id}/references/{ref_id}/audio")
def stream_reference_audio(project_id: str, ref_id: str) -> FileResponse:
    validate_id(project_id, "project_id")
    validate_id(ref_id, "ref_id")
    project = store.get_project(project_id)
    if not any(r.id == ref_id for r in project.references):
        raise HTTPException(status_code=404, detail=f"Reference '{ref_id}' not found.")
    path = store.reference_audio_path(project_id, ref_id)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Reference audio has not been downloaded locally yet.")
    return _wav_file_response(path, f"{ref_id}.wav")


@router.post("/api/projects/{project_id}/mashup", response_model=ProjectState)
def create_auto_mashup(project_id: str, body: MashupRequest) -> ProjectState:
    validate_id(project_id, "project_id")
    validate_id(body.ref_id, "ref_id")
    edit = build_mashup_edit(project_id, store.get_project(project_id), body)

    def _apply_mashup(proj: ProjectState) -> bool:
        if proj.main_track is None:
            raise HTTPException(status_code=400, detail="Upload a main track before creating a mashup.")
        proj.edits.append(edit)
        proj.redo_stack.clear()
        return True

    return _mutate_and_render(project_id, _apply_mashup)

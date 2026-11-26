"""Main track upload, YouTube import, reference promotion, separation, peaks, and audio streaming."""

from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path
from typing import Annotated

import soundfile as sf
from fastapi import APIRouter, File, Header, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse

from musak.audio_analysis import analyze_audio, load_audio_to_stereo_wav
from musak.config import get_api_key, get_gemini_model
from musak.dsp import resolve_rendered_audio_path
from musak.gemini_agent import extract_lyric_hooks
from musak.models import ProjectState, WaveformPeaksResponse, YouTubeReferenceRequest
from musak.routers.deps import (
    _enrich_project,
    _install_main_track_from_wav,
    _safe_unlink,
    _save_upload_to_temp,
    _wav_file_response,
    store,
)
from musak.routers.track_ops import build_waveform_peaks, download_ref_youtube_on_demand, import_youtube_main_track
from musak.stems import start_main_stem_separation
from musak.storage import validate_id, validate_stem_name

logger = logging.getLogger(__name__)
router = APIRouter(tags=["tracks"])


@router.post("/api/projects/{project_id}/main-track", response_model=ProjectState)
def upload_main_track(project_id: str, file: UploadFile = File(...)) -> ProjectState:
    validate_id(project_id, "project_id")
    store.get_project(project_id)

    tmp_upload = _save_upload_to_temp(file)
    fd, staged_name = tempfile.mkstemp(prefix="musak_stage_", suffix=".wav")
    os.close(fd)
    staged_wav = Path(staged_name)
    try:
        try:
            audio, sr = load_audio_to_stereo_wav(tmp_upload, staged_wav)
        except (ValueError, RuntimeError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        analysis = analyze_audio(audio, sr)
        track_name = Path(file.filename or "Main Track").stem or "Main Track"
        return _install_main_track_from_wav(project_id, staged_wav, track_name, analysis)
    finally:
        _safe_unlink(tmp_upload)
        _safe_unlink(staged_wav)


@router.post("/api/projects/{project_id}/main-track/youtube", response_model=ProjectState)
def load_main_track_from_youtube(project_id: str, body: YouTubeReferenceRequest) -> ProjectState:
    validate_id(project_id, "project_id")
    store.get_project(project_id)
    return import_youtube_main_track(project_id, body.url, body.title)


@router.post("/api/projects/{project_id}/main-track/from-reference/{ref_id}", response_model=ProjectState)
def promote_reference_to_main_track(project_id: str, ref_id: str) -> ProjectState:
    validate_id(project_id, "project_id")
    validate_id(ref_id, "ref_id")
    project = store.get_project(project_id)
    ref = next((r for r in project.references if r.id == ref_id), None)
    if ref is None:
        raise HTTPException(status_code=404, detail=f"Reference '{ref_id}' not found.")

    ref_wav = store.reference_audio_path(project_id, ref_id)
    downloaded_now = False
    if not ref.audio_downloaded or not ref_wav.is_file():
        if ref.source_type == "youtube" and ref.youtube_url:
            download_ref_youtube_on_demand(project_id, ref_id, ref.youtube_url, ref_wav)
            downloaded_now = True
        else:
            raise HTTPException(status_code=404, detail="Reference audio file is missing on disk.")

    try:
        audio, sr = sf.read(str(ref_wav), dtype="float32", always_2d=True)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Reference audio file could not be read: {exc}") from exc

    analysis = analyze_audio(audio, int(sr))
    if downloaded_now:
        def _mark_ref_downloaded(proj: ProjectState) -> None:
            target = next((r for r in proj.references if r.id == ref_id), None)
            if target is not None:
                target.audio_downloaded = True
                target.duration, target.bpm, target.key = analysis.duration, analysis.bpm, analysis.key
                target.audio_url = store.reference_audio_url(project_id, ref_id)

        store.update_project(project_id, _mark_ref_downloaded)

    latest_proj = store.get_project(project_id)
    latest_ref = next((r for r in latest_proj.references if r.id == ref_id), None)
    if latest_ref is None:
        raise HTTPException(status_code=404, detail=f"Reference '{ref_id}' was deleted.")

    copy_stems_from = store.reference_stems_dir(project_id, ref_id) if latest_ref.stems_status == "ready" else None
    return _install_main_track_from_wav(
        project_id=project_id,
        source_wav=ref_wav,
        track_name=latest_ref.title,
        analysis=analysis,
        copy_stems_from=copy_stems_from,
    )


@router.post("/api/projects/{project_id}/main-track/separate", response_model=ProjectState)
def separate_main_track(project_id: str) -> ProjectState:
    validate_id(project_id, "project_id")
    try:
        return _enrich_project(start_main_stem_separation(store, project_id))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/api/projects/{project_id}/main-track/extract-hooks", response_model=ProjectState)
def extract_main_track_hooks(
    project_id: str,
    x_gemini_api_key: Annotated[str | None, Header()] = None,
) -> ProjectState:
    validate_id(project_id, "project_id")
    project = store.get_project(project_id)
    if project.main_track is None:
        raise HTTPException(status_code=400, detail="Upload a main track before extracting lyrics/hooks.")

    api_key = get_api_key(x_gemini_api_key)
    if not api_key:
        raise HTTPException(status_code=400, detail="Gemini API key is not configured.")

    expected_track_id = project.main_track.id
    main_audio = store.get_main_audio_path(project_id, expected_track_id)
    if not main_audio.is_file():
        raise HTTPException(status_code=404, detail="Main track audio file is missing.")

    try:
        hooks = extract_lyric_hooks(
            audio_path=main_audio,
            duration=project.main_track.duration,
            api_key=api_key,
            model=get_gemini_model(),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Gemini lyric/hook extraction failed for project %s", project_id)
        raise HTTPException(status_code=502, detail=f"Gemini lyric/hook extraction failed: {exc}") from exc

    def _save_hooks(proj: ProjectState) -> None:
        if proj.main_track is not None and proj.main_track.id == expected_track_id:
            proj.main_track.lyric_hooks = hooks

    return _enrich_project(store.update_project(project_id, _save_hooks))


@router.get("/api/projects/{project_id}/peaks", response_model=WaveformPeaksResponse)
def get_waveform_peaks(
    project_id: str,
    buckets: Annotated[int, Query(ge=1, le=4000)] = 400,
) -> WaveformPeaksResponse:
    validate_id(project_id, "project_id")
    return build_waveform_peaks(project_id, store.get_project(project_id), buckets)


@router.get("/api/projects/{project_id}/audio/main")
def stream_main_audio(project_id: str) -> FileResponse:
    validate_id(project_id, "project_id")
    project = store.get_project(project_id)
    track_id = project.main_track.id if project.main_track is not None else None
    path = store.get_main_audio_path(project_id, track_id)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Main track audio not found.")
    return _wav_file_response(path, "main.wav")


@router.get("/api/projects/{project_id}/audio/rendered")
def stream_rendered_audio(project_id: str) -> FileResponse:
    validate_id(project_id, "project_id")
    path = resolve_rendered_audio_path(store, store.get_project(project_id))
    if path is None:
        raise HTTPException(status_code=404, detail="No audio available for this project.")
    return _wav_file_response(path, path.name)


@router.get("/api/projects/{project_id}/audio/stem/{stem_name}")
def stream_stem_audio(project_id: str, stem_name: str) -> FileResponse:
    validate_id(project_id, "project_id")
    valid_stem = validate_stem_name(stem_name)
    store.get_project(project_id)
    path = store.main_stem_path(project_id, valid_stem)
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"Stem '{valid_stem}' has not been generated yet.")
    return _wav_file_response(path, f"{valid_stem}.wav")


@router.get("/api/projects/{project_id}/audio/preview/{proposal_id}")
def stream_preview_audio(project_id: str, proposal_id: str, t: str | None = None) -> FileResponse:
    validate_id(project_id, "project_id")
    validate_id(proposal_id, "proposal_id")
    store.get_project(project_id)
    path = store.resolve_preview_audio_path(project_id, proposal_id, nonce=t)
    if path is None or not path.is_file():
        raise HTTPException(status_code=404, detail="Proposal preview audio not found.")
    return _wav_file_response(path, f"{proposal_id}.wav")

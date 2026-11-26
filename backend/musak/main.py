"""FastAPI application implementing docs/API_CONTRACT.md for Musak."""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import tempfile
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

import soundfile as sf
from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from musak import __version__
from musak.audio_analysis import AudioAnalysis, analyze_audio, load_audio_to_stereo_wav
from musak.config import (
    STEM_NAMES,
    clear_api_key,
    get_api_key,
    get_cuda_info,
    get_gemini_model,
    is_api_key_configured,
    is_ffmpeg_available,
    set_api_key,
)
from musak.dsp import (
    export_mix,
    render_project_mix,
    render_proposal_preview,
    resolve_rendered_audio_path,
)
from musak.gemini_agent import auto_tag_reference, run_producer_chat, transcribe_voice_audio
from musak.models import (
    ApiKeyRequest,
    ApiKeyStatusResponse,
    ChatMessage,
    ChatRequest,
    CreateEditRequest,
    CreateMomentRequest,
    CreateProjectRequest,
    DeleteProjectResponse,
    EditBlock,
    EditProposal,
    ExportRequest,
    HealthResponse,
    MainTrack,
    MomentPin,
    PatchEditRequest,
    ProjectListResponse,
    ProjectState,
    ReferenceTrack,
    RenameProjectRequest,
    VoiceTranscribeResponse,
    YouTubeReferenceRequest,
)
from musak.stems import (
    recover_project_processing_state,
    recover_stuck_processing_state,
    start_main_stem_separation,
    start_reference_stem_separation,
)
from musak.storage import (
    InvalidIdError,
    ProjectNotFoundError,
    generate_id,
    store,
    utc_now_iso,
    validate_id,
    validate_stem_name,
)
from musak.youtube import canonical_youtube_url, download_youtube_audio, extract_youtube_id, fetch_youtube_metadata

logger = logging.getLogger(__name__)

NO_STORE_HEADERS = {"Cache-Control": "no-store"}
MAX_VOICE_UPLOAD_BYTES = 15 * 1024 * 1024

_AUDIO_MIME_ALIASES: dict[str, str] = {
    "audio/webm": "audio/webm",
    "audio/ogg": "audio/ogg",
    "audio/opus": "audio/ogg",
    "audio/wav": "audio/wav",
    "audio/x-wav": "audio/wav",
    "audio/wave": "audio/wav",
    "audio/mp4": "audio/mp4",
    "audio/m4a": "audio/mp4",
    "audio/x-m4a": "audio/mp4",
    "audio/mpeg": "audio/mpeg",
    "audio/mp3": "audio/mpeg",
    "audio/flac": "audio/flac",
    "audio/aac": "audio/aac",
}

_AUDIO_EXT_MIMES: dict[str, str] = {
    ".webm": "audio/webm",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".mp4": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
    ".aac": "audio/aac",
}


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
        "null",
        "file://",
    ],
    allow_origin_regex=r"^(https?://(localhost|127\.0\.0\.1)(:\d+)?|file://.*|null)$",
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


def _save_upload_to_temp(upload: UploadFile) -> Path:
    suffix = Path(upload.filename or "audio.wav").suffix or ".wav"
    if len(suffix) > 12 or not suffix[1:].isalnum():
        suffix = ".wav"
    fd, tmp_name = tempfile.mkstemp(prefix="musak_up_", suffix=suffix)
    tmp_path = Path(tmp_name)
    try:
        with open(fd, "wb") as out:
            shutil.copyfileobj(upload.file, out)
        return tmp_path
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise


def _find_proposal(project: ProjectState, proposal_id: str) -> EditProposal | None:
    for msg in project.chat_messages:
        for prop in msg.proposals:
            if prop.id == proposal_id:
                return prop
    return None


def _set_proposal_applied(project: ProjectState, proposal_id: str | None, applied: bool) -> None:
    if not proposal_id:
        return
    if not applied and any(e.source_proposal_id == proposal_id for e in project.edits):
        return
    prop = _find_proposal(project, proposal_id)
    if prop is not None:
        prop.applied = applied


def _mutate_and_render(
    project_id: str,
    mutator: Callable[[ProjectState], bool],
) -> ProjectState:
    """Serialize heavy DSP rendering per-project WITHOUT holding global `store._lock`.

    `mutator` receives a working copy of `ProjectState` and returns `True` if rendering
    and persisting should proceed (or `False` for a no-op like undo on empty edits).
    """
    with store.get_render_lock(project_id):
        working = store.get_project(project_id)
        changed = mutator(working)
        if not changed:
            return working

        if working.main_track is not None:
            render_project_mix(store, working)

        # Commit updated edits, redo_stack, chat proposal applied flags, and render metadata briefly under store._lock
        def _commit(latest: ProjectState) -> None:
            latest.edits = working.edits
            latest.redo_stack = working.redo_stack
            latest.render_version = working.render_version
            if latest.main_track is not None and working.main_track is not None:
                latest.main_track.rendered_url = working.main_track.rendered_url
            # Sync proposal applied flags onto latest chat_messages
            applied_map: dict[str, bool] = {}
            for msg in working.chat_messages:
                for prop in msg.proposals:
                    applied_map[prop.id] = prop.applied
            for msg in latest.chat_messages:
                for prop in msg.proposals:
                    if prop.id in applied_map:
                        prop.applied = applied_map[prop.id]

        return store.update_project(project_id, _commit)


# ==============================================================================
# 1. Health & Settings
# ==============================================================================


@app.get("/api/health", response_model=HealthResponse)
def health_check() -> HealthResponse:
    cuda_available, gpu_name = get_cuda_info()
    return HealthResponse(
        status="ok",
        cuda_available=cuda_available,
        gpu_name=gpu_name,
        ffmpeg_available=is_ffmpeg_available(),
        api_key_configured=is_api_key_configured(),
        model=get_gemini_model(),
    )


@app.post("/api/settings/api-key", response_model=ApiKeyStatusResponse)
def configure_api_key(body: ApiKeyRequest) -> ApiKeyStatusResponse:
    configured = set_api_key(body.api_key)
    return ApiKeyStatusResponse(api_key_configured=configured)


@app.delete("/api/settings/api-key", response_model=ApiKeyStatusResponse)
def remove_api_key() -> ApiKeyStatusResponse:
    clear_api_key()
    return ApiKeyStatusResponse(api_key_configured=False)


# ==============================================================================
# 2. Projects (Workspaces)
# ==============================================================================


@app.get("/api/projects", response_model=ProjectListResponse)
def list_projects() -> ProjectListResponse:
    return ProjectListResponse(projects=store.list_projects())


@app.post("/api/projects", response_model=ProjectState)
def create_project(body: CreateProjectRequest) -> ProjectState:
    try:
        return store.create_project(body.name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/projects/{project_id}", response_model=ProjectState)
def get_project(project_id: str) -> ProjectState:
    project = store.get_project(project_id)
    return recover_project_processing_state(store, project)


@app.patch("/api/projects/{project_id}", response_model=ProjectState)
def rename_project(project_id: str, body: RenameProjectRequest) -> ProjectState:
    validate_id(project_id, "project_id")

    def _rename(proj: ProjectState) -> None:
        proj.name = body.name

    return store.update_project(project_id, _rename)


@app.delete("/api/projects/{project_id}", response_model=DeleteProjectResponse)
def delete_project(project_id: str) -> DeleteProjectResponse:
    store.delete_project(project_id)
    return DeleteProjectResponse(deleted=True)


# ==============================================================================
# 3. Main Track & Audio Streaming
# ==============================================================================


def _resolve_voice_mime(content_type: str | None, filename: str | None) -> str:
    """Strip codec parameters from Content-Type and fall back to filename extension."""
    if content_type:
        base = content_type.split(";", 1)[0].strip().lower()
        if base in _AUDIO_MIME_ALIASES:
            return _AUDIO_MIME_ALIASES[base]
        if base.startswith("audio/"):
            return base
    if filename:
        ext = Path(filename).suffix.lower()
        if ext in _AUDIO_EXT_MIMES:
            return _AUDIO_EXT_MIMES[ext]
    raise HTTPException(
        status_code=400,
        detail="Unsupported voice audio format. Provide audio/webm, audio/ogg, audio/wav, or audio/mp4.",
    )


def _safe_unlink(path: Path) -> None:
    """Best-effort unlink ignoring Windows transient file locks (WinError 32)."""
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


def _install_main_track_from_wav(
    project_id: str,
    source_wav: Path,
    track_name: str,
    analysis: AudioAnalysis,
    copy_stems_from: Path | None = None,
) -> ProjectState:
    """Install a prepared 44.1 kHz stereo WAV as versioned `main_{track_id}.wav`, clear stale state,
    and optionally reuse separated stems.

    Heavy audio decoding / YouTube downloads / analysis should run BEFORE calling this helper
    so neither `store._lock` nor the per-project render lock blocks during slow I/O.
    """
    with store.get_render_lock(project_id):
        # Ensure project still exists before writing files
        store.get_project(project_id)

        track_id = generate_id("trk")
        dst_wav = store.main_audio_path(project_id, track_id)
        dst_wav.parent.mkdir(parents=True, exist_ok=True)
        # Copy into project dir temp file then os.replace for atomic cross-drive safety on Windows
        fd, local_tmp_name = tempfile.mkstemp(prefix=".main_tmp_", suffix=".wav", dir=str(dst_wav.parent))
        os.close(fd)
        local_tmp = Path(local_tmp_name)
        try:
            shutil.copyfile(source_wav, local_tmp)
            os.replace(local_tmp, dst_wav)
        except Exception:
            _safe_unlink(local_tmp)
            raise

        # Best-effort cleanup of previous versioned main WAVs, stale renders, stems, previews, and exports
        store.prune_old_main_audio(project_id, keep_track_id=track_id)
        for stale_dir in (
            store.main_stems_dir(project_id),
            store.previews_dir(project_id),
            store.exports_dir(project_id),
        ):
            if stale_dir.exists():
                shutil.rmtree(stale_dir, ignore_errors=True)
        store.prune_old_renders(project_id, keep_version=None)

        reused_stems: list[str] = []
        if copy_stems_from is not None and copy_stems_from.is_dir():
            all_present = all((copy_stems_from / f"{stem}.wav").is_file() for stem in STEM_NAMES)
            if all_present:
                stage_stems = store.project_dir(project_id) / f".reuse_stems_{track_id}"
                try:
                    if stage_stems.exists():
                        shutil.rmtree(stage_stems, ignore_errors=True)
                    stage_stems.mkdir(parents=True, exist_ok=True)
                    for stem in STEM_NAMES:
                        shutil.copyfile(copy_stems_from / f"{stem}.wav", stage_stems / f"{stem}.wav")
                    main_stems_dir = store.main_stems_dir(project_id)
                    main_stems_dir.mkdir(parents=True, exist_ok=True)
                    for stem in STEM_NAMES:
                        os.replace(stage_stems / f"{stem}.wav", main_stems_dir / f"{stem}.wav")
                    reused_stems = list(STEM_NAMES)
                except OSError as exc:
                    logger.warning("Failed to reuse reference stems for %s; falling back to none: %s", project_id, exc)
                    reused_stems = []
                finally:
                    if stage_stems.exists():
                        shutil.rmtree(stage_stems, ignore_errors=True)

        stems_ready = len(reused_stems) == len(STEM_NAMES)
        resolved_name = track_name.strip() or "Main Track"

        def _attach_main(proj: ProjectState) -> None:
            proj.render_version = 0
            proj.edits = []
            proj.redo_stack = []
            for msg in proj.chat_messages:
                for prop in msg.proposals:
                    prop.applied = False
                    prop.preview_url = None
            proj.main_track = MainTrack(
                id=track_id,
                name=resolved_name,
                duration=analysis.duration,
                sample_rate=analysis.sample_rate,
                bpm=analysis.bpm,
                key=analysis.key,
                beats=analysis.beats,
                sections=analysis.sections,
                stems_status="ready" if stems_ready else "none",
                stems_error=None,
                stems=reused_stems,
                audio_url=store.main_audio_url(project_id, track_id=track_id),
                rendered_url=store.rendered_audio_url(project_id, 0, track_id=track_id),
                stem_urls=store.stem_urls(project_id, reused_stems, track_id=track_id) if stems_ready else {},
            )

        return store.update_project(project_id, _attach_main)


@app.post("/api/projects/{project_id}/main-track", response_model=ProjectState)
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


@app.post("/api/projects/{project_id}/main-track/youtube", response_model=ProjectState)
def load_main_track_from_youtube(project_id: str, body: YouTubeReferenceRequest) -> ProjectState:
    validate_id(project_id, "project_id")
    store.get_project(project_id)

    try:
        video_id = extract_youtube_id(body.url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    canon_url = canonical_youtube_url(video_id)
    explicit_title = (body.title or "").strip()
    if explicit_title:
        resolved_title = explicit_title
    else:
        meta = fetch_youtube_metadata(canon_url)
        resolved_title = str(meta.get("title") or f"YouTube ({video_id})")

    fd, staged_name = tempfile.mkstemp(prefix="musak_yt_main_", suffix=".wav")
    os.close(fd)
    staged_wav = Path(staged_name)
    try:
        try:
            download_youtube_audio(canon_url, staged_wav)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            logger.exception("YouTube main-track download failed for %s", video_id)
            raise HTTPException(status_code=502, detail=f"Failed to download YouTube audio: {exc}") from exc

        try:
            audio, sr = sf.read(str(staged_wav), dtype="float32", always_2d=True)
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Downloaded YouTube audio could not be read: {exc}") from exc

        analysis = analyze_audio(audio, int(sr))
        return _install_main_track_from_wav(project_id, staged_wav, resolved_title, analysis)
    finally:
        _safe_unlink(staged_wav)


@app.post("/api/projects/{project_id}/main-track/from-reference/{ref_id}", response_model=ProjectState)
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
            ref_wav.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp_dl_name = tempfile.mkstemp(prefix=".dl_ref_", suffix=".wav", dir=str(ref_wav.parent))
            os.close(fd)
            tmp_dl = Path(tmp_dl_name)
            try:
                download_youtube_audio(ref.youtube_url, tmp_dl)
                os.replace(tmp_dl, ref_wav)
            except ValueError as exc:
                _safe_unlink(tmp_dl)
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            except Exception as exc:
                _safe_unlink(tmp_dl)
                logger.exception("On-demand YouTube download failed for ref %s/%s", project_id, ref_id)
                raise HTTPException(status_code=502, detail=f"Failed to download YouTube reference: {exc}") from exc
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
                target.duration = analysis.duration
                target.bpm = analysis.bpm
                target.key = analysis.key
                target.audio_url = store.reference_audio_url(project_id, ref_id)

        store.update_project(project_id, _mark_ref_downloaded)

    # Re-verify the reference was not deleted while downloading
    latest_proj = store.get_project(project_id)
    latest_ref = next((r for r in latest_proj.references if r.id == ref_id), None)
    if latest_ref is None:
        raise HTTPException(status_code=404, detail=f"Reference '{ref_id}' was deleted.")

    copy_stems_from = (
        store.reference_stems_dir(project_id, ref_id)
        if latest_ref.stems_status == "ready"
        else None
    )

    return _install_main_track_from_wav(
        project_id=project_id,
        source_wav=ref_wav,
        track_name=latest_ref.title,
        analysis=analysis,
        copy_stems_from=copy_stems_from,
    )


@app.post("/api/projects/{project_id}/main-track/separate", response_model=ProjectState)
def separate_main_track(project_id: str) -> ProjectState:
    validate_id(project_id, "project_id")
    try:
        return start_main_stem_separation(store, project_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/projects/{project_id}/audio/main")
def stream_main_audio(project_id: str) -> FileResponse:
    validate_id(project_id, "project_id")
    project = store.get_project(project_id)
    track_id = project.main_track.id if project.main_track is not None else None
    path = store.get_main_audio_path(project_id, track_id)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Main track audio not found.")
    return FileResponse(path=str(path), media_type="audio/wav", filename="main.wav", headers=NO_STORE_HEADERS)


@app.get("/api/projects/{project_id}/audio/rendered")
def stream_rendered_audio(project_id: str) -> FileResponse:
    validate_id(project_id, "project_id")
    project = store.get_project(project_id)
    path = resolve_rendered_audio_path(store, project)
    if path is None:
        raise HTTPException(status_code=404, detail="No audio available for this project.")
    return FileResponse(path=str(path), media_type="audio/wav", filename=path.name, headers=NO_STORE_HEADERS)


@app.get("/api/projects/{project_id}/audio/stem/{stem_name}")
def stream_stem_audio(project_id: str, stem_name: str) -> FileResponse:
    validate_id(project_id, "project_id")
    valid_stem = validate_stem_name(stem_name)
    store.get_project(project_id)
    path = store.main_stem_path(project_id, valid_stem)
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"Stem '{valid_stem}' has not been generated yet.")
    return FileResponse(
        path=str(path),
        media_type="audio/wav",
        filename=f"{valid_stem}.wav",
        headers=NO_STORE_HEADERS,
    )


@app.get("/api/projects/{project_id}/audio/preview/{proposal_id}")
def stream_preview_audio(project_id: str, proposal_id: str) -> FileResponse:
    validate_id(project_id, "project_id")
    validate_id(proposal_id, "proposal_id")
    store.get_project(project_id)
    path = store.preview_audio_path(project_id, proposal_id)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Proposal preview audio not found.")
    return FileResponse(
        path=str(path),
        media_type="audio/wav",
        filename=f"{proposal_id}.wav",
        headers=NO_STORE_HEADERS,
    )


@app.post("/api/projects/{project_id}/export")
def export_project_mix(project_id: str, body: ExportRequest) -> FileResponse:
    validate_id(project_id, "project_id")
    with store.get_render_lock(project_id):
        project = store.get_project(project_id)
        try:
            out_path = export_mix(store, project, body.format)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc

    media_type = "audio/wav" if body.format == "wav" else "audio/mpeg"
    safe_base = "".join(c if c.isalnum() or c in ("-", "_") else "_" for c in project.name).strip("_") or "musak_mix"
    download_name = f"{safe_base}_remix.{body.format}"
    return FileResponse(
        path=str(out_path),
        media_type=media_type,
        filename=download_name,
        headers=NO_STORE_HEADERS,
    )


# ==============================================================================
# 4. Reference Shelf
# ==============================================================================


@app.post("/api/projects/{project_id}/references/upload", response_model=ProjectState)
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

        return store.update_project(project_id, _add_ref)
    finally:
        _safe_unlink(tmp_path)


@app.post("/api/projects/{project_id}/references/youtube", response_model=ProjectState)
def add_youtube_reference(project_id: str, body: YouTubeReferenceRequest) -> ProjectState:
    validate_id(project_id, "project_id")
    store.get_project(project_id)

    try:
        meta = fetch_youtube_metadata(body.url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    ref_id = generate_id("ref")
    resolved_title = (body.title or "").strip() or meta["title"]

    ref = ReferenceTrack(
        id=ref_id,
        title=resolved_title,
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

    return store.update_project(project_id, _add_ref)


@app.delete("/api/projects/{project_id}/references/{ref_id}", response_model=ProjectState)
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

    return store.update_project(project_id, _remove)


@app.post("/api/projects/{project_id}/references/{ref_id}/moments", response_model=ProjectState)
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

    return store.update_project(project_id, _add_pin)


@app.delete("/api/projects/{project_id}/references/{ref_id}/moments/{moment_id}", response_model=ProjectState)
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

    return store.update_project(project_id, _del_pin)


@app.post("/api/projects/{project_id}/references/{ref_id}/auto-tag", response_model=ProjectState)
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
            user_pins = [m for m in r.moments if m.source == "user"]
            r.moments = user_pins + pins

    return store.update_project(project_id, _attach_pins)


@app.post("/api/projects/{project_id}/references/{ref_id}/extract-stems", response_model=ProjectState)
def extract_reference_stems(project_id: str, ref_id: str) -> ProjectState:
    validate_id(project_id, "project_id")
    validate_id(ref_id, "ref_id")
    try:
        return start_reference_stem_separation(store, project_id, ref_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/projects/{project_id}/references/{ref_id}/audio")
def stream_reference_audio(project_id: str, ref_id: str) -> FileResponse:
    validate_id(project_id, "project_id")
    validate_id(ref_id, "ref_id")
    project = store.get_project(project_id)
    if not any(r.id == ref_id for r in project.references):
        raise HTTPException(status_code=404, detail=f"Reference '{ref_id}' not found.")
    path = store.reference_audio_path(project_id, ref_id)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Reference audio has not been downloaded locally yet.")
    return FileResponse(
        path=str(path),
        media_type="audio/wav",
        filename=f"{ref_id}.wav",
        headers=NO_STORE_HEADERS,
    )


# ==============================================================================
# 5. Edits & History
# ==============================================================================


@app.post("/api/projects/{project_id}/edits", response_model=ProjectState)
def create_edit(project_id: str, body: CreateEditRequest) -> ProjectState:
    validate_id(project_id, "project_id")
    project = store.get_project(project_id)
    if project.main_track is None:
        raise HTTPException(status_code=400, detail="Upload a main track before adding edits.")

    edit = EditBlock(
        id=generate_id("edit"),
        title=body.title.strip(),
        description=body.description.strip(),
        start=round(body.start, 3),
        end=round(body.end, 3),
        enabled=True,
        operations=body.operations,
        created_at=utc_now_iso(),
    )

    def _apply(proj: ProjectState) -> bool:
        if proj.main_track is None:
            raise HTTPException(status_code=400, detail="Upload a main track before adding edits.")
        proj.edits.append(edit)
        proj.redo_stack.clear()
        return True

    return _mutate_and_render(project_id, _apply)


@app.post("/api/projects/{project_id}/edits/apply-proposal/{proposal_id}", response_model=ProjectState)
def apply_proposal(project_id: str, proposal_id: str) -> ProjectState:
    validate_id(project_id, "project_id")
    validate_id(proposal_id, "proposal_id")
    project = store.get_project(project_id)
    if project.main_track is None:
        raise HTTPException(status_code=400, detail="Upload a main track before applying proposals.")
    if _find_proposal(project, proposal_id) is None:
        raise HTTPException(status_code=404, detail=f"Proposal '{proposal_id}' not found.")

    def _apply(proj: ProjectState) -> bool:
        prop = _find_proposal(proj, proposal_id)
        if prop is None:
            raise HTTPException(status_code=404, detail=f"Proposal '{proposal_id}' not found.")
        edit = EditBlock(
            id=generate_id("edit"),
            title=prop.title,
            description=prop.summary,
            start=prop.start,
            end=prop.end,
            enabled=True,
            operations=list(prop.operations),
            created_at=utc_now_iso(),
            source_proposal_id=prop.id,
        )
        proj.edits.append(edit)
        proj.redo_stack.clear()
        prop.applied = True
        return True

    return _mutate_and_render(project_id, _apply)


@app.patch("/api/projects/{project_id}/edits/{edit_id}", response_model=ProjectState)
def patch_edit(project_id: str, edit_id: str, body: PatchEditRequest) -> ProjectState:
    validate_id(project_id, "project_id")
    validate_id(edit_id, "edit_id")
    project = store.get_project(project_id)
    if not any(e.id == edit_id for e in project.edits):
        raise HTTPException(status_code=404, detail=f"Edit '{edit_id}' not found.")

    def _patch(proj: ProjectState) -> bool:
        target = next((e for e in proj.edits if e.id == edit_id), None)
        if target is None:
            raise HTTPException(status_code=404, detail=f"Edit '{edit_id}' not found.")
        if body.enabled is not None:
            target.enabled = body.enabled
        return True

    return _mutate_and_render(project_id, _patch)


@app.delete("/api/projects/{project_id}/edits/{edit_id}", response_model=ProjectState)
def delete_edit(project_id: str, edit_id: str) -> ProjectState:
    validate_id(project_id, "project_id")
    validate_id(edit_id, "edit_id")
    project = store.get_project(project_id)
    if not any(e.id == edit_id for e in project.edits):
        raise HTTPException(status_code=404, detail=f"Edit '{edit_id}' not found.")

    def _delete(proj: ProjectState) -> bool:
        removed = next((e for e in proj.edits if e.id == edit_id), None)
        if removed is None:
            raise HTTPException(status_code=404, detail=f"Edit '{edit_id}' not found.")
        proj.edits = [e for e in proj.edits if e.id != edit_id]
        _set_proposal_applied(proj, removed.source_proposal_id, False)
        return True

    return _mutate_and_render(project_id, _delete)


@app.post("/api/projects/{project_id}/undo", response_model=ProjectState)
def undo_edit(project_id: str) -> ProjectState:
    validate_id(project_id, "project_id")
    store.get_project(project_id)

    def _undo(proj: ProjectState) -> bool:
        if not proj.edits:
            return False
        popped = proj.edits.pop()
        proj.redo_stack.append(popped)
        _set_proposal_applied(proj, popped.source_proposal_id, False)
        return True

    return _mutate_and_render(project_id, _undo)


@app.post("/api/projects/{project_id}/redo", response_model=ProjectState)
def redo_edit(project_id: str) -> ProjectState:
    validate_id(project_id, "project_id")
    store.get_project(project_id)

    def _redo(proj: ProjectState) -> bool:
        if not proj.redo_stack:
            return False
        restored = proj.redo_stack.pop()
        proj.edits.append(restored)
        _set_proposal_applied(proj, restored.source_proposal_id, True)
        return True

    return _mutate_and_render(project_id, _redo)


# ==============================================================================
# 6. Gemini Producer Chat
# ==============================================================================


@app.post("/api/projects/{project_id}/chat", response_model=ProjectState)
def producer_chat(
    project_id: str,
    body: ChatRequest,
    x_gemini_api_key: Annotated[str | None, Header()] = None,
) -> ProjectState:
    validate_id(project_id, "project_id")
    project = store.get_project(project_id)
    if project.main_track is None:
        raise HTTPException(status_code=400, detail="Upload a main track before starting Producer Chat.")

    api_key = get_api_key(x_gemini_api_key)
    if not api_key:
        raise HTTPException(status_code=400, detail="Gemini API key is not configured.")

    main_audio = store.get_main_audio_path(project_id, project.main_track.id)
    if not main_audio.is_file():
        raise HTTPException(status_code=404, detail="Main track audio file is missing.")

    ref_audio_paths: dict[str, Path] = {}
    for ref in project.references:
        p = store.reference_audio_path(project_id, ref.id)
        if p.is_file():
            ref_audio_paths[ref.id] = p

    try:
        reply_text, proposals = run_producer_chat(
            project=project,
            main_audio_path=main_audio,
            ref_audio_paths=ref_audio_paths,
            user_message=body.message.strip(),
            selection=body.selection,
            reference_ids=body.reference_ids,
            api_key=api_key,
            model=get_gemini_model(),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Gemini Producer chat failed for project %s", project_id)
        raise HTTPException(status_code=502, detail=f"Gemini Producer chat failed: {exc}") from exc

    # Pre-render fast preview WAVs for each proposal under per-project render lock
    with store.get_render_lock(project_id):
        latest_for_preview = store.get_project(project_id)
        for prop in proposals:
            try:
                render_proposal_preview(store, latest_for_preview, prop)
            except Exception as exc:
                logger.warning("Preview rendering failed for proposal %s: %s", prop.id, exc)
                prop.preview_url = None

    now = utc_now_iso()
    user_msg = ChatMessage(
        id=generate_id("msg"),
        role="user",
        content=body.message.strip(),
        selection=body.selection,
        reference_ids=list(body.reference_ids),
        proposals=[],
        created_at=now,
    )
    assistant_msg = ChatMessage(
        id=generate_id("msg"),
        role="assistant",
        content=reply_text,
        selection=body.selection,
        reference_ids=list(body.reference_ids),
        proposals=proposals,
        created_at=utc_now_iso(),
    )

    def _append_chat(proj: ProjectState) -> None:
        proj.chat_messages.append(user_msg)
        proj.chat_messages.append(assistant_msg)

    return store.update_project(project_id, _append_chat)


@app.post("/api/voice/transcribe", response_model=VoiceTranscribeResponse)
async def transcribe_voice(
    file: UploadFile = File(...),
    x_gemini_api_key: Annotated[str | None, Header()] = None,
) -> VoiceTranscribeResponse:
    api_key = get_api_key(x_gemini_api_key)
    if not api_key:
        raise HTTPException(status_code=400, detail="Gemini API key is not configured.")

    clean_mime = _resolve_voice_mime(file.content_type, file.filename)

    chunks: list[bytes] = []
    total_bytes = 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        total_bytes += len(chunk)
        if total_bytes > MAX_VOICE_UPLOAD_BYTES:
            raise HTTPException(status_code=400, detail="Voice audio file exceeds maximum size of 15 MB.")
        chunks.append(chunk)

    audio_bytes = b"".join(chunks)
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Voice audio file is empty.")

    try:
        text = await asyncio.to_thread(
            transcribe_voice_audio,
            audio_bytes,
            clean_mime,
            api_key,
            get_gemini_model(),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Gemini voice transcription failed")
        raise HTTPException(status_code=502, detail=f"Gemini voice transcription failed: {exc}") from exc

    return VoiceTranscribeResponse(text=text)

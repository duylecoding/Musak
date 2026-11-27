"""Shared router dependencies, project enrichment, and serialized render helpers."""

from __future__ import annotations

import logging
import os
import shutil
import tempfile
from collections.abc import Callable
from pathlib import Path

from fastapi import UploadFile
from fastapi.responses import FileResponse

from musak.audio_analysis import AudioAnalysis, compute_mashup_compatibility
from musak.config import STEM_NAMES, is_auto_separate_enabled
from musak.dsp import render_project_mix
from musak.models import EditProposal, MainTrack, ProjectState
from musak.stems import start_main_stem_separation
from musak.storage import generate_id, store

logger = logging.getLogger(__name__)

NO_STORE_HEADERS = {"Cache-Control": "no-store"}


def _safe_unlink(path: Path) -> None:
    """Best-effort unlink ignoring Windows transient file locks (WinError 32)."""
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


def _wav_file_response(path: Path, filename: str) -> FileResponse:
    """Return a non-cached WAV FileResponse."""
    return FileResponse(path=str(path), media_type="audio/wav", filename=filename, headers=NO_STORE_HEADERS)


def _save_upload_to_temp(upload: UploadFile) -> Path:
    """Persist an uploaded file stream to a temporary file."""
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
        _safe_unlink(tmp_path)
        raise


def _find_proposal(project: ProjectState, proposal_id: str) -> EditProposal | None:
    for msg in project.chat_messages:
        for prop in msg.proposals:
            if prop.id == proposal_id:
                return prop
    return None


def _sync_proposal_applied_flags(project: ProjectState, proposal_id: str | None, applied: bool) -> None:
    if not proposal_id:
        return
    if not applied and any(e.source_proposal_id == proposal_id for e in project.edits):
        return
    prop = _find_proposal(project, proposal_id)
    if prop is not None:
        prop.applied = applied


def _enrich_project(project: ProjectState) -> ProjectState:
    """Dynamically populate reference mashup compatibility against the current main track."""
    mt = project.main_track
    for ref in project.references:
        ref.compatibility = (
            compute_mashup_compatibility(mt.bpm, mt.key, ref.bpm, ref.key) if mt is not None else None
        )
    return project


def _mutate_and_render(
    project_id: str,
    mutator: Callable[[ProjectState], bool],
    skip_render: bool = False,
) -> ProjectState:
    """Serialize heavy DSP rendering per-project WITHOUT holding global `store._lock`.

    When `skip_render=True` (used by the native Rust real-time audio engine), edit JSON is persisted
    immediately (<2ms) and `render_version` is bumped without writing offline WAV mixes to disk.
    """
    with store.get_render_lock(project_id):
        working = store.get_project(project_id)
        if not mutator(working):
            return _enrich_project(working)

        if working.main_track is not None:
            if skip_render:
                working.render_version += 1
            else:
                render_project_mix(store, working)

        def _commit(latest: ProjectState) -> None:
            latest.edits = working.edits
            latest.redo_stack = working.redo_stack
            latest.render_version = working.render_version
            if latest.main_track is not None and working.main_track is not None:
                latest.main_track.rendered_url = working.main_track.rendered_url
            applied_map = {
                prop.id: prop.applied
                for msg in working.chat_messages
                for prop in msg.proposals
            }
            for msg in latest.chat_messages:
                for prop in msg.proposals:
                    if prop.id in applied_map:
                        prop.applied = applied_map[prop.id]

        return _enrich_project(store.update_project(project_id, _commit))


def _reuse_reference_stems(project_id: str, track_id: str, copy_stems_from: Path | None) -> list[str]:
    """Atomically copy pre-separated reference stems into the main stems directory when available."""
    if copy_stems_from is None or not copy_stems_from.is_dir():
        return []
    if not all((copy_stems_from / f"{stem}.wav").is_file() for stem in STEM_NAMES):
        return []

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
        return list(STEM_NAMES)
    except OSError as exc:
        logger.warning("Failed to reuse reference stems for %s; falling back to none: %s", project_id, exc)
        return []
    finally:
        if stage_stems.exists():
            shutil.rmtree(stage_stems, ignore_errors=True)


def _install_main_track_from_wav(
    project_id: str,
    source_wav: Path,
    track_name: str,
    analysis: AudioAnalysis,
    copy_stems_from: Path | None = None,
) -> ProjectState:
    """Install a prepared 44.1 kHz stereo WAV as versioned `main_{track_id}.wav` and clear stale state."""
    with store.get_render_lock(project_id):
        store.get_project(project_id)

        track_id = generate_id("trk")
        dst_wav = store.main_audio_path(project_id, track_id)
        dst_wav.parent.mkdir(parents=True, exist_ok=True)
        fd, local_tmp_name = tempfile.mkstemp(prefix=".main_tmp_", suffix=".wav", dir=str(dst_wav.parent))
        os.close(fd)
        local_tmp = Path(local_tmp_name)
        try:
            shutil.copyfile(source_wav, local_tmp)
            os.replace(local_tmp, dst_wav)
        except Exception:
            _safe_unlink(local_tmp)
            raise

        store.prune_old_main_audio(project_id, keep_track_id=track_id)
        for stale_dir in (
            store.main_stems_dir(project_id),
            store.previews_dir(project_id),
            store.exports_dir(project_id),
        ):
            if stale_dir.exists():
                shutil.rmtree(stale_dir, ignore_errors=True)
        store.prune_old_renders(project_id, keep_version=None)

        reused_stems = _reuse_reference_stems(project_id, track_id, copy_stems_from)
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

        updated = _enrich_project(store.update_project(project_id, _attach_main))

    if is_auto_separate_enabled() and updated.main_track is not None and updated.main_track.stems_status == "none":
        updated = _enrich_project(start_main_stem_separation(store, project_id))
    return updated

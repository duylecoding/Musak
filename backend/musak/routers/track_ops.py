"""Helper operations for YouTube main-track import, reference promotion, and waveform peaks."""

from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path

import soundfile as sf
from fastapi import HTTPException

from musak.audio_analysis import analyze_audio, compute_waveform_peaks
from musak.config import STEM_NAMES
from musak.dsp.cache import get_cached_peaks
from musak.models import ProjectState, WaveformPeaksResponse
from musak.routers.deps import _install_main_track_from_wav, _safe_unlink, store
from musak.youtube import canonical_youtube_url, download_youtube_audio, extract_youtube_id, fetch_youtube_metadata

logger = logging.getLogger(__name__)


def import_youtube_main_track(project_id: str, url: str, title: str | None) -> ProjectState:
    """Download a YouTube video as stereo WAV, analyze it, and install as main track."""
    try:
        video_id = extract_youtube_id(url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    canon_url = canonical_youtube_url(video_id)
    explicit_title = (title or "").strip()
    resolved_title = explicit_title or str(fetch_youtube_metadata(canon_url).get("title") or f"YouTube ({video_id})")

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

        return _install_main_track_from_wav(project_id, staged_wav, resolved_title, analyze_audio(audio, int(sr)))
    finally:
        _safe_unlink(staged_wav)


def download_ref_youtube_on_demand(project_id: str, ref_id: str, youtube_url: str, ref_wav: Path) -> None:
    """Download a YouTube reference track atomically into `ref_wav`."""
    ref_wav.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_dl_name = tempfile.mkstemp(prefix=".dl_ref_", suffix=".wav", dir=str(ref_wav.parent))
    os.close(fd)
    tmp_dl = Path(tmp_dl_name)
    try:
        download_youtube_audio(youtube_url, tmp_dl)
        os.replace(tmp_dl, ref_wav)
    except ValueError as exc:
        _safe_unlink(tmp_dl)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        _safe_unlink(tmp_dl)
        logger.exception("On-demand YouTube download failed for ref %s/%s", project_id, ref_id)
        raise HTTPException(status_code=502, detail=f"Failed to download YouTube reference: {exc}") from exc


def build_waveform_peaks(project_id: str, project: ProjectState, buckets: int) -> WaveformPeaksResponse:
    """Compute downsampled waveform peaks for main, rendered, and ready stem WAVs."""
    if project.main_track is None:
        raise HTTPException(status_code=404, detail="Main track audio not found.")

    main_wav = store.get_main_audio_path(project_id, project.main_track.id)
    if not main_wav.is_file():
        raise HTTPException(status_code=404, detail="Main track audio not found.")

    main_peaks = get_cached_peaks(main_wav, buckets, lambda: compute_waveform_peaks(main_wav, buckets=buckets))
    rendered_peaks: list[float] | None = None
    if project.render_version > 0:
        rendered_wav = store.rendered_audio_path(project_id, project.render_version)
        if rendered_wav.is_file():
            rendered_peaks = get_cached_peaks(
                rendered_wav, buckets, lambda p=rendered_wav: compute_waveform_peaks(p, buckets=buckets)
            )

    stems_peaks: dict[str, list[float]] = {}
    if project.main_track.stems_status == "ready":
        for stem_name in STEM_NAMES:
            stem_path = store.main_stem_path(project_id, stem_name)
            if stem_path.is_file():
                stems_peaks[stem_name] = get_cached_peaks(
                    stem_path, buckets, lambda p=stem_path: compute_waveform_peaks(p, buckets=buckets)
                )

    return WaveformPeaksResponse(
        duration=project.main_track.duration,
        buckets=buckets,
        main=main_peaks,
        rendered=rendered_peaks,
        stems=stems_peaks,
    )

"""Demucs (htdemucs) stem separation with serialized inference, CUDA->CPU fallback, and recovery."""

from __future__ import annotations

import logging
import os
import shutil
import tempfile
import threading
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf

from musak.audio_analysis import analyze_audio, ensure_stereo, resample_stereo
from musak.config import STEM_NAMES
from musak.models import ProjectState
from musak.storage import ProjectNotFoundError, ProjectStore
from musak.youtube import download_youtube_audio

logger = logging.getLogger(__name__)

INTERRUPTED_ERROR_MSG = "Stem separation was interrupted — click to retry."

_model_lock = threading.Lock()
_inference_lock = threading.Lock()
_cached_model: Any | None = None
_active_jobs_lock = threading.Lock()
_active_jobs: set[str] = set()


def _get_htdemucs_model() -> Any:
    """Lazy-load and cache the pretrained `htdemucs` model."""
    global _cached_model
    with _model_lock:
        if _cached_model is None:
            from demucs.pretrained import get_model

            logger.info("Loading Demucs 'htdemucs' model...")
            _cached_model = get_model("htdemucs")
            _cached_model.eval()
        return _cached_model


def _run_demucs_apply(model: Any, wav_tensor: Any, device: str) -> Any:
    import torch
    from demucs.apply import apply_model

    model.to(device)
    inp = wav_tensor.to(device)
    with torch.no_grad():
        sources = apply_model(model, inp, device=device, split=True, overlap=0.25, progress=False)
    return sources.detach().cpu()


def separate_audio_file(input_wav: Path, output_dir: Path) -> list[str]:
    """Run Demucs `htdemucs` on `input_wav` and save stems via `soundfile.write` (never `torchaudio.save`)."""
    import torch

    if not input_wav.is_file():
        raise FileNotFoundError(f"Audio file not found: {input_wav}")

    model = _get_htdemucs_model()
    model_sr = int(getattr(model, "samplerate", 44100))

    audio, sr = sf.read(str(input_wav), dtype="float32", always_2d=True)
    stereo = ensure_stereo(audio)
    if int(sr) != model_sr:
        stereo = resample_stereo(stereo, int(sr), model_sr)

    # Shape expected by Demucs apply_model: (batch=1, channels=2, samples)
    wav_tensor = torch.from_numpy(stereo.T.copy()).unsqueeze(0)

    # Serialize Demucs model inference + device moves so concurrent main/ref jobs never collide
    with _inference_lock:
        use_cuda = torch.cuda.is_available()
        if use_cuda:
            try:
                sources_cpu = _run_demucs_apply(model, wav_tensor, "cuda")
            except Exception as exc:
                logger.warning("Demucs CUDA separation failed (%s); falling back to CPU.", exc)
                try:
                    torch.cuda.empty_cache()
                except Exception:
                    pass
                sources_cpu = _run_demucs_apply(model, wav_tensor, "cpu")
        else:
            sources_cpu = _run_demucs_apply(model, wav_tensor, "cpu")

    # sources_cpu shape: (1, num_sources, 2, samples)
    sources_np = sources_cpu[0].numpy()
    source_names: list[str] = list(getattr(model, "sources", ["drums", "bass", "other", "vocals"]))

    output_dir.mkdir(parents=True, exist_ok=True)
    saved_stems: list[str] = []
    for idx, stem_name in enumerate(source_names):
        if stem_name not in STEM_NAMES:
            continue
        stem_stereo = np.clip(sources_np[idx].T, -1.0, 1.0).astype(np.float32)
        out_path = output_dir / f"{stem_name}.wav"
        # Save directly via soundfile.write to avoid Windows torchaudio backend issues
        sf.write(str(out_path), stem_stereo, model_sr, subtype="PCM_16")
        saved_stems.append(stem_name)

    return [s for s in STEM_NAMES if s in saved_stems]


def _move_staged_stems(staging_dir: Path, target_dir: Path, stems: list[str]) -> None:
    target_dir.mkdir(parents=True, exist_ok=True)
    for stem_name in stems:
        src = staging_dir / f"{stem_name}.wav"
        dst = target_dir / f"{stem_name}.wav"
        if src.is_file():
            os.replace(src, dst)


def _main_stem_worker(
    store: ProjectStore,
    project_id: str,
    expected_track_id: str,
    job_key: str,
) -> None:
    staging_dir: Path | None = None
    try:
        # Guard against project deletion or main track replacement before starting
        current = store.get_project(project_id)
        if current.main_track is None or current.main_track.id != expected_track_id:
            return

        main_wav = store.get_main_audio_path(project_id, expected_track_id)
        staging_dir = store.project_dir(project_id) / f".stems_stage_{expected_track_id}"
        if staging_dir.exists():
            shutil.rmtree(staging_dir, ignore_errors=True)

        stems = separate_audio_file(main_wav, staging_dir)

        def _commit_if_matching(proj: ProjectState) -> None:
            if proj.main_track is None or proj.main_track.id != expected_track_id:
                return
            assert staging_dir is not None
            _move_staged_stems(staging_dir, store.main_stems_dir(project_id), stems)
            proj.main_track.stems_status = "ready"
            proj.main_track.stems_error = None
            proj.main_track.stems = stems
            proj.main_track.stem_urls = store.stem_urls(project_id, stems, track_id=expected_track_id)

        store.update_project(project_id, _commit_if_matching)
    except ProjectNotFoundError:
        logger.info("Project %s was deleted while separating main stems.", project_id)
    except Exception as exc:
        logger.exception("Main stem separation failed for project %s", project_id)
        err_msg = str(exc)

        def _mark_error(proj: ProjectState) -> None:
            if proj.main_track is not None and proj.main_track.id == expected_track_id:
                proj.main_track.stems_status = "error"
                proj.main_track.stems_error = err_msg

        try:
            store.update_project(project_id, _mark_error)
        except Exception:
            pass
    finally:
        if staging_dir is not None and staging_dir.exists():
            shutil.rmtree(staging_dir, ignore_errors=True)
        with _active_jobs_lock:
            _active_jobs.discard(job_key)


def start_main_stem_separation(store: ProjectStore, project_id: str) -> ProjectState:
    """Mark main track stems as processing and kick off background Demucs thread."""
    project = store.get_project(project_id)
    if project.main_track is None:
        raise ValueError("Upload a main track before separating stems.")

    expected_track_id = project.main_track.id
    job_key = f"main:{project_id}:{expected_track_id}"
    with _active_jobs_lock:
        if job_key in _active_jobs:
            return project
        _active_jobs.add(job_key)

    def _mark_processing(proj: ProjectState) -> None:
        if proj.main_track is not None and proj.main_track.id == expected_track_id:
            proj.main_track.stems_status = "processing"
            proj.main_track.stems_error = None

    updated = store.update_project(project_id, _mark_processing)
    thread = threading.Thread(
        target=_main_stem_worker,
        args=(store, project_id, expected_track_id, job_key),
        daemon=True,
        name=f"demucs-main-{project_id}",
    )
    thread.start()
    return updated


def _reference_stem_worker(store: ProjectStore, project_id: str, ref_id: str, job_key: str) -> None:
    staging_dir: Path | None = None
    try:
        project = store.get_project(project_id)
        ref = next((r for r in project.references if r.id == ref_id), None)
        if ref is None:
            return

        ref_wav = store.reference_audio_path(project_id, ref_id)
        if not ref_wav.is_file():
            if ref.source_type == "youtube" and ref.youtube_url:
                ref_wav.parent.mkdir(parents=True, exist_ok=True)
                fd, tmp_dl_name = tempfile.mkstemp(prefix=".dl_ref_", suffix=".wav", dir=str(ref_wav.parent))
                os.close(fd)
                tmp_dl = Path(tmp_dl_name)
                try:
                    download_youtube_audio(ref.youtube_url, tmp_dl)
                    os.replace(tmp_dl, ref_wav)
                except Exception:
                    try:
                        tmp_dl.unlink(missing_ok=True)
                    except OSError:
                        pass
                    raise

                audio, sr = sf.read(str(ref_wav), dtype="float32", always_2d=True)
                analysis = analyze_audio(audio, int(sr))

                def _mark_downloaded(proj: ProjectState) -> None:
                    r = next((item for item in proj.references if item.id == ref_id), None)
                    if r is not None:
                        r.audio_downloaded = True
                        r.duration = analysis.duration
                        r.bpm = analysis.bpm
                        r.key = analysis.key
                        r.audio_url = store.reference_audio_url(project_id, ref_id)

                store.update_project(project_id, _mark_downloaded)
            else:
                raise FileNotFoundError("Reference audio file is missing on disk.")

        # Re-check reference still exists before running Demucs
        project_check = store.get_project(project_id)
        if not any(r.id == ref_id for r in project_check.references):
            return

        staging_dir = store.reference_dir(project_id, ref_id) / ".stems_stage"
        if staging_dir.exists():
            shutil.rmtree(staging_dir, ignore_errors=True)

        stems = separate_audio_file(ref_wav, staging_dir)

        def _commit_ref_if_present(proj: ProjectState) -> None:
            r = next((item for item in proj.references if item.id == ref_id), None)
            if r is None:
                return
            assert staging_dir is not None
            _move_staged_stems(staging_dir, store.reference_stems_dir(project_id, ref_id), stems)
            r.stems_status = "ready"
            r.stems_error = None

        store.update_project(project_id, _commit_ref_if_present)
    except ProjectNotFoundError:
        logger.info("Project %s was deleted while extracting reference stems.", project_id)
    except Exception as exc:
        logger.exception("Reference stem extraction failed for %s/%s", project_id, ref_id)
        err_msg = str(exc)

        def _mark_error(proj: ProjectState) -> None:
            r = next((item for item in proj.references if item.id == ref_id), None)
            if r is not None:
                r.stems_status = "error"
                r.stems_error = err_msg

        try:
            store.update_project(project_id, _mark_error)
        except Exception:
            pass
    finally:
        if staging_dir is not None and staging_dir.exists():
            shutil.rmtree(staging_dir, ignore_errors=True)
        with _active_jobs_lock:
            _active_jobs.discard(job_key)


def start_reference_stem_separation(store: ProjectStore, project_id: str, ref_id: str) -> ProjectState:
    """Start on-demand download (if YouTube) + Demucs stem separation for a reference track."""
    project = store.get_project(project_id)
    ref = next((r for r in project.references if r.id == ref_id), None)
    if ref is None:
        raise FileNotFoundError(f"Reference '{ref_id}' not found.")

    job_key = f"ref:{project_id}:{ref_id}"
    with _active_jobs_lock:
        if job_key in _active_jobs:
            return project
        _active_jobs.add(job_key)

    def _mark_processing(proj: ProjectState) -> None:
        r = next((item for item in proj.references if item.id == ref_id), None)
        if r is not None:
            r.stems_status = "processing"
            r.stems_error = None

    updated = store.update_project(project_id, _mark_processing)
    thread = threading.Thread(
        target=_reference_stem_worker,
        args=(store, project_id, ref_id, job_key),
        daemon=True,
        name=f"demucs-ref-{ref_id}",
    )
    thread.start()
    return updated


def _has_active_main_job(project_id: str, track_id: str) -> bool:
    with _active_jobs_lock:
        return f"main:{project_id}:{track_id}" in _active_jobs


def _has_active_ref_job(project_id: str, ref_id: str) -> bool:
    with _active_jobs_lock:
        return f"ref:{project_id}:{ref_id}" in _active_jobs


def recover_project_processing_state(store: ProjectStore, project: ProjectState) -> ProjectState:
    """Reset any stuck `'processing'` stem status that has no live background worker."""
    needs_recovery = False
    if (
        project.main_track is not None
        and project.main_track.stems_status == "processing"
        and not _has_active_main_job(project.id, project.main_track.id)
    ):
        needs_recovery = True

    if not needs_recovery:
        for ref in project.references:
            if ref.stems_status == "processing" and not _has_active_ref_job(project.id, ref.id):
                needs_recovery = True
                break

    if not needs_recovery:
        return project

    def _recover(proj: ProjectState) -> None:
        if (
            proj.main_track is not None
            and proj.main_track.stems_status == "processing"
            and not _has_active_main_job(proj.id, proj.main_track.id)
        ):
            proj.main_track.stems_status = "error"
            proj.main_track.stems_error = INTERRUPTED_ERROR_MSG
        for ref in proj.references:
            if ref.stems_status == "processing" and not _has_active_ref_job(proj.id, ref.id):
                ref.stems_status = "error"
                ref.stems_error = INTERRUPTED_ERROR_MSG

    return store.update_project(project.id, _recover)


def recover_stuck_processing_state(store: ProjectStore) -> None:
    """Scan all projects on startup and reset any interrupted `'processing'` stem statuses."""
    for summary in store.list_projects():
        try:
            proj = store.get_project(summary.id)
            recover_project_processing_state(store, proj)
        except Exception as exc:
            logger.warning("Failed to inspect project %s during startup recovery: %s", summary.id, exc)

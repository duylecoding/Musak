"""Native Rust real-time audio engine manifest & content-hashed clip preparation router."""

from __future__ import annotations

import hashlib
import os
import tempfile
from pathlib import Path

import numpy as np
import pedalboard as pb
import soundfile as sf
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from musak.audio_analysis import semitone_diff_between_keys
from musak.config import STEM_NAMES, TARGET_SAMPLE_RATE
from musak.dsp.borrow import compute_effective_borrow_rate
from musak.dsp.pipeline import _sfx_stem_bucket
from musak.dsp.utils import _read_audio_slice, snap_range_to_beats
from musak.models import EditOperation, ProjectState
from musak.routers.deps import store
from musak.sfx import get_sfx_item, synthesize_sfx
from musak.storage import validate_id

router = APIRouter(tags=["engine"])


class PreparedClipEntry(BaseModel):
    path: str
    stem_bucket: str


class EngineManifestResponse(BaseModel):
    project_id: str
    track_id: str
    sample_rate: int
    duration: float
    bpm: float
    key: str
    render_version: int
    main_wav: str
    stems: dict[str, str]
    clips: dict[str, PreparedClipEntry]


def _write_wav_atomic(path: Path, stereo: np.ndarray, sr: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=".clip_", suffix=".wav", dir=str(path.parent))
    os.close(fd)
    tmp = Path(tmp_name)
    try:
        sf.write(str(tmp), stereo.astype(np.float32, copy=False), sr, subtype="PCM_16")
        os.replace(tmp, path)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise


def _prepare_borrow_clip(project: ProjectState, op: EditOperation, sr: int, clips_dir: Path) -> PreparedClipEntry | None:
    if not op.ref_id or project.main_track is None:
        return None
    ref = next((r for r in project.references if r.id == op.ref_id), None)
    if ref is None:
        return None

    ref_stem = op.ref_stem or "full"
    src_path: Path | None = None
    if ref_stem != "full":
        cand = store.reference_stem_path(project.id, ref.id, ref_stem)
        if cand.is_file():
            src_path = cand
    if src_path is None:
        cand = store.reference_audio_path(project.id, ref.id)
        if cand.is_file():
            src_path = cand
    if src_path is None:
        return None

    info = sf.info(str(src_path))
    ref_dur = float(info.frames) / float(info.samplerate) if info.samplerate > 0 else 0.0
    if ref_dur <= 0.0:
        return None
    r_start = max(0.0, min(float(op.ref_start if op.ref_start is not None else 0.0), ref_dur))
    r_end = max(r_start, min(float(op.ref_end if op.ref_end is not None else ref_dur), ref_dur))
    if r_end <= r_start:
        return None

    match_bpm = True if op.match_bpm is None else bool(op.match_bpm)
    rate = 1.0
    if match_bpm and ref.bpm and project.main_track.bpm and ref.bpm > 20.0 and project.main_track.bpm > 20.0:
        cand_rate = compute_effective_borrow_rate(project.main_track.bpm, ref.bpm)
        if abs(cand_rate - 1.0) > 0.01:
            rate = cand_rate

    match_key = True if op.match_key is None else bool(op.match_key)
    semitones = 0
    if match_key and ref_stem != "drums" and ref.key and project.main_track.key:
        semitones = semitone_diff_between_keys(ref.key, project.main_track.key)

    st = src_path.stat()
    sig = f"borrow|{src_path.resolve()}|{st.st_mtime_ns}|{st.st_size}|{r_start:.4f}|{r_end:.4f}|{sr}|{rate:.4f}|{semitones}|{ref_stem}"
    digest = hashlib.sha1(sig.encode("utf-8")).hexdigest()[:16]
    dst = clips_dir / f"borrow_{digest}.wav"

    if not dst.is_file():
        raw = _read_audio_slice(src_path, r_start, r_end, sr)
        if len(raw) == 0:
            return None
        if (abs(rate - 1.0) > 0.01 or semitones != 0) and len(raw) >= 256 and hasattr(pb, "time_stretch"):
            ch_first = np.ascontiguousarray(raw.T, dtype=np.float32)
            proc = pb.time_stretch(
                ch_first,
                float(sr),
                stretch_factor=float(rate),
                pitch_shift_in_semitones=float(semitones),
                high_quality=True,
                transient_mode="crisp",
                retain_phase_continuity=True,
                preserve_formants=(ref_stem == "vocals"),
            )
            raw = np.ascontiguousarray(proc.T, dtype=np.float32)
        _write_wav_atomic(dst, raw, sr)

    bucket = ref_stem if ref_stem in STEM_NAMES else "other"
    return PreparedClipEntry(path=str(dst.resolve()), stem_bucket=bucket)


def _prepare_sfx_clip(project: ProjectState, op: EditOperation, sr: int, clips_dir: Path) -> PreparedClipEntry | None:
    if not op.sfx_id or project.main_track is None:
        return None
    item = get_sfx_item(op.sfx_id)
    if item is None:
        return None

    dur_total = float(project.main_track.duration)
    snap = True if op.snap_to_beat is None else bool(op.snap_to_beat)
    raw_start = op.start if op.start is not None else 0.0
    raw_end = op.end if op.end is not None else (raw_start + item.default_duration)
    s_sec, e_sec = snap_range_to_beats(raw_start, raw_end, project.main_track.beats, dur_total, snap)
    clip_dur = max(0.05, e_sec - s_sec)
    resolved_key = op.musical_key or project.main_track.key
    bpm = float(project.main_track.bpm or 120.0)

    sig = f"sfx|{op.sfx_id}|{clip_dur:.3f}|{sr}|{bpm:.2f}|{resolved_key or ''}"
    digest = hashlib.sha1(sig.encode("utf-8")).hexdigest()[:16]
    dst = clips_dir / f"sfx_{digest}.wav"

    if not dst.is_file():
        audio = synthesize_sfx(op.sfx_id, duration=clip_dur, sr=sr, bpm=bpm, musical_key=resolved_key)
        if len(audio) == 0:
            return None
        _write_wav_atomic(dst, audio, sr)

    return PreparedClipEntry(path=str(dst.resolve()), stem_bucket=_sfx_stem_bucket(op.sfx_id))


@router.get("/api/projects/{project_id}/engine-manifest", response_model=EngineManifestResponse)
def get_engine_manifest(project_id: str) -> EngineManifestResponse:
    """Return local WAV paths for main track, stems, and pre-prepared borrow/SFX clips for Rust playback."""
    validate_id(project_id, "project_id")
    project = store.get_project(project_id)
    mt = project.main_track
    if mt is None:
        raise HTTPException(status_code=404, detail="Project has no main track.")

    main_wav = store.get_main_audio_path(project_id, mt.id)
    if not main_wav.is_file():
        raise HTTPException(status_code=404, detail="Main track WAV missing.")

    sr = int(mt.sample_rate or TARGET_SAMPLE_RATE)
    stems: dict[str, str] = {}
    if mt.stems_status == "ready":
        for stem_name in STEM_NAMES:
            sp = store.main_stem_path(project_id, stem_name)
            if sp.is_file():
                stems[stem_name] = str(sp.resolve())

    clips_dir = store.project_dir(project_id) / "engine_clips"
    clips: dict[str, PreparedClipEntry] = {}
    for edit in project.edits:
        for idx, op in enumerate(edit.operations):
            key = f"{edit.id}:{idx}"
            if op.type == "borrow_stem":
                entry = _prepare_borrow_clip(project, op, sr, clips_dir)
                if entry is not None:
                    clips[key] = entry
            elif op.type == "add_sfx":
                entry = _prepare_sfx_clip(project, op, sr, clips_dir)
                if entry is not None:
                    clips[key] = entry

    return EngineManifestResponse(
        project_id=project.id,
        track_id=mt.id,
        sample_rate=sr,
        duration=float(mt.duration),
        bpm=float(mt.bpm or 120.0),
        key=mt.key or "",
        render_version=project.render_version,
        main_wav=str(main_wav.resolve()),
        stems=stems,
        clips=clips,
    )

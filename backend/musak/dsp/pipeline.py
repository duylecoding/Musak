"""DSP execution pipeline, full-mix rendering, and sliced proposal previewing."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import soundfile as sf

from musak.audio_analysis import ensure_stereo, resample_stereo
from musak.config import STEM_NAMES, TARGET_SAMPLE_RATE
from musak.dsp.arrangement import ARRANGEMENT_OP_TYPES, apply_arrangement_ops
from musak.dsp.borrow import _apply_borrow_stem
from musak.dsp.dj_moves import _apply_beat_repeat_range, _apply_vinyl_brake_range
from musak.dsp.effects import (
    _apply_bass_boost,
    _apply_delay_throw,
    _apply_filter_sweep,
    _apply_lofi_eq,
    _apply_reverb_throw,
    _apply_stem_gain,
    _build_sfx_overlay,
)
from musak.dsp.pitch import _apply_tempo_pitch_slice, _transform_tempo_pitch_segment
from musak.dsp.preview import (
    _compute_preview_window,
    _finalize_and_write_preview,
    _load_sliced_preview_inputs,
)
from musak.dsp.utils import (
    _load_stems_if_ready,
    collect_enabled_operations,
    snap_range_to_beats,
    soft_limit,
)
from musak.models import EditOperation, EditProposal, ProjectState
from musak.storage import ProjectStore


def _apply_single_effect(
    audio: np.ndarray, sr: int, s_idx: int, e_idx: int, op: EditOperation, bpm: float
) -> np.ndarray:
    if op.type == "delay_throw":
        return _apply_delay_throw(audio, sr, s_idx, e_idx, op, bpm)
    if op.type == "beat_repeat":
        return _apply_beat_repeat_range(audio, sr, s_idx, e_idx, op, bpm)
    dispatch = {
        "stem_gain": _apply_stem_gain,
        "filter_sweep": _apply_filter_sweep,
        "reverb_throw": _apply_reverb_throw,
        "lofi_eq": _apply_lofi_eq,
        "bass_boost": _apply_bass_boost,
        "tempo_pitch": _apply_tempo_pitch_slice,
        "vinyl_brake": _apply_vinyl_brake_range,
    }
    handler = dispatch.get(op.type)
    return handler(audio, sr, s_idx, e_idx, op) if handler is not None else audio


def _execute_dsp_pipeline(
    store: ProjectStore,
    project: ProjectState,
    stem_buffers: dict[str, np.ndarray] | None,
    full_mix: np.ndarray | None,
    sr: int,
    beats: list[float],
    bpm: float,
    operations: list[EditOperation],
) -> np.ndarray:
    """Apply DSP operations onto pre-loaded `stem_buffers` or `full_mix` and return soft-limited stereo."""
    total_samples = len(full_mix) if full_mix is not None else len(next(iter(stem_buffers.values())))  # type: ignore[arg-type]
    duration = total_samples / float(sr) if sr > 0 else 0.0
    overlays: list[np.ndarray] = []
    full_track_tempo_ops: list[EditOperation] = []

    for op in operations:
        if op.type in ARRANGEMENT_OP_TYPES:
            continue

        if op.type == "borrow_stem":
            stem_buffers, full_mix, overlay = _apply_borrow_stem(store, project, stem_buffers, full_mix, sr, op)
            if overlay is not None:
                overlays.append(overlay)
            continue

        if op.type == "add_sfx":
            overlay = _build_sfx_overlay(total_samples, sr, beats, duration, bpm, op)
            if overlay is not None:
                overlays.append(overlay)
            continue

        snap = True if op.snap_to_beat is None else bool(op.snap_to_beat)
        raw_start = op.start if op.start is not None else 0.0
        raw_end = op.end if op.end is not None else duration

        if op.type == "tempo_pitch" and raw_start <= 0.1 and raw_end >= duration - 0.1:
            requested = op.stems or list(STEM_NAMES)
            if stem_buffers is None or "full" in requested or "all" in requested or set(STEM_NAMES).issubset(set(requested)):
                full_track_tempo_ops.append(op)
                continue

        s_sec, e_sec = snap_range_to_beats(raw_start, raw_end, beats, duration, snap)
        s_idx, e_idx = int(round(s_sec * sr)), int(round(e_sec * sr))
        if e_idx <= s_idx:
            continue

        if stem_buffers is not None:
            requested = op.stems or list(STEM_NAMES)
            targets = list(STEM_NAMES) if ("full" in requested or "all" in requested) else [s for s in requested if s in stem_buffers]
            for stem_name in (targets or list(STEM_NAMES)):
                stem_buffers[stem_name] = _apply_single_effect(stem_buffers[stem_name], sr, s_idx, e_idx, op, bpm)
        elif full_mix is not None:
            full_mix = _apply_single_effect(full_mix, sr, s_idx, e_idx, op, bpm)

    if stem_buffers is not None:
        mixed = np.zeros((total_samples, 2), dtype=np.float32)
        for buf in stem_buffers.values():
            mixed += buf
    else:
        assert full_mix is not None
        mixed = full_mix

    for overlay in overlays:
        mixed += overlay

    mixed = apply_arrangement_ops(mixed, sr, operations, beats, duration)

    for op in full_track_tempo_ops:
        speed_rate = float(np.clip(op.speed_rate if op.speed_rate is not None else 1.0, 0.5, 1.6))
        semitones = float(np.clip(op.semitones if op.semitones is not None else 0.0, -12.0, 12.0))
        add_reverb = bool(op.add_reverb)
        reverb_wet = float(np.clip(op.reverb_wet if op.reverb_wet is not None else 0.35, 0.0, 0.8))
        if abs(speed_rate - 1.0) >= 0.005 or abs(semitones) >= 0.01 or add_reverb:
            mixed = _transform_tempo_pitch_segment(mixed, sr, speed_rate, semitones, add_reverb, reverb_wet)

    return soft_limit(mixed)


def render_operations(
    store: ProjectStore, project: ProjectState, operations: list[EditOperation]
) -> tuple[np.ndarray, int]:
    """Render a sequence of DSP operations non-destructively onto the project's main track."""
    if project.main_track is None:
        raise ValueError("Cannot render audio: project has no main track.")

    main_wav = store.get_main_audio_path(project.id, project.main_track.id)
    if not main_wav.is_file():
        raise FileNotFoundError(f"Main track WAV missing at {main_wav}")

    sr = project.main_track.sample_rate or TARGET_SAMPLE_RATE
    stem_buffers = _load_stems_if_ready(store, project, sr)
    full_mix: np.ndarray | None = None
    if stem_buffers is None:
        data, orig_sr = sf.read(str(main_wav), dtype="float32", always_2d=True)
        full_mix = ensure_stereo(data)
        if int(orig_sr) != sr:
            full_mix = resample_stereo(full_mix, int(orig_sr), sr)

    mixed = _execute_dsp_pipeline(
        store, project, stem_buffers, full_mix, sr, project.main_track.beats, project.main_track.bpm, operations
    )
    return mixed, sr


def render_project_mix(store: ProjectStore, project: ProjectState) -> Path:
    """Render all enabled edits into versioned `rendered_v{N}.wav`, bump `render_version`, and prune old renders."""
    if project.main_track is None:
        raise ValueError("Cannot render project mix without a main track.")

    ops = collect_enabled_operations(project)
    next_version = project.render_version + 1
    rendered_path = store.rendered_audio_path(project.id, next_version)

    if not ops:
        main_wav = store.get_main_audio_path(project.id, project.main_track.id)
        audio, sr = sf.read(str(main_wav), dtype="float32", always_2d=True)
        sf.write(str(rendered_path), soft_limit(ensure_stereo(audio)), int(sr), subtype="PCM_16")
    else:
        mixed, sr = render_operations(store, project, ops)
        sf.write(str(rendered_path), mixed, sr, subtype="PCM_16")

    project.render_version = next_version
    project.main_track.rendered_url = store.rendered_audio_url(
        project.id, next_version, track_id=project.main_track.id
    )
    store.prune_old_renders(project.id, keep_version=next_version)
    return rendered_path


def render_proposal_preview(
    store: ProjectStore, project: ProjectState, proposal: EditProposal, nonce: str | None = None
) -> Path:
    """Render a fast, disk-sliced (<=20s) preview WAV without loading the full song into memory."""
    if project.main_track is None:
        raise ValueError("Cannot render proposal preview without a main track.")

    main_wav = store.get_main_audio_path(project.id, project.main_track.id)
    if not main_wav.is_file():
        raise FileNotFoundError(f"Main track WAV missing at {main_wav}")

    sr = project.main_track.sample_rate or TARGET_SAMPLE_RATE
    orig_dur = max(0.1, float(project.main_track.duration))
    ops = collect_enabled_operations(project) + list(proposal.operations)

    clip_start, clip_end = _compute_preview_window(project, proposal, ops, orig_dur)
    stem_buffers, full_mix, clip_beats, sliced_ops = _load_sliced_preview_inputs(
        store, project, main_wav, sr, ops, clip_start, clip_end, orig_dur
    )
    clip = _execute_dsp_pipeline(
        store, project, stem_buffers, full_mix, sr, clip_beats, project.main_track.bpm, sliced_ops
    )
    return _finalize_and_write_preview(store, project, proposal, clip, sr, clip_start, clip_end, nonce)

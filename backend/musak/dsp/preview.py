"""Preview window selection, operation slicing, and atomic WAV writing."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

from musak.config import STEM_NAMES
from musak.dsp.utils import MAX_PREVIEW_SECONDS, _cosine_fade_mask, _load_stems_if_ready, _read_audio_slice, soft_limit
from musak.models import EditOperation, EditProposal, ProjectState
from musak.storage import ProjectStore


def _compute_preview_window(
    project: ProjectState, proposal: EditProposal, ops: list[EditOperation], orig_dur: float
) -> tuple[float, float]:
    """Compute bounded `[clip_start, clip_end]` seconds for a fast preview render."""
    assert project.main_track is not None
    cumulative_speed = 1.0
    for op in ops:
        if op.type == "tempo_pitch":
            op_s = op.start if op.start is not None else 0.0
            op_e = op.end if op.end is not None else orig_dur
            if op_s <= 0.1 and op_e >= orig_dur - 0.1:
                req = op.stems or list(STEM_NAMES)
                if "full" in req or "all" in req or set(STEM_NAMES).issubset(set(req)):
                    cumulative_speed *= float(np.clip(op.speed_rate if op.speed_rate is not None else 1.0, 0.5, 1.6))

    src_cap = min(MAX_PREVIEW_SECONDS, MAX_PREVIEW_SECONDS * min(1.0, max(0.1, cumulative_speed)))

    if proposal.end - proposal.start > MAX_PREVIEW_SECONDS:
        if project.main_track.sections:
            best_sec = max(project.main_track.sections, key=lambda s: (s.label in ("Drop", "Chorus"), s.energy))
            center = 0.5 * (best_sec.start + best_sec.end)
        else:
            center = 0.5 * (proposal.start + proposal.end)
        clip_start = max(0.0, center - src_cap * 0.5)
        clip_end = min(orig_dur, clip_start + src_cap)
        if clip_end - clip_start < src_cap:
            clip_start = max(0.0, clip_end - src_cap)
    else:
        clip_start = max(0.0, proposal.start - 1.5)
        clip_end = min(orig_dur, proposal.end + 1.5)
        if clip_end - clip_start > src_cap:
            center = 0.5 * (proposal.start + proposal.end)
            clip_start = max(0.0, center - src_cap * 0.5)
            clip_end = min(orig_dur, clip_start + src_cap)
            if clip_end - clip_start < src_cap:
                clip_start = max(0.0, clip_end - src_cap)

    clip_start, clip_end = round(clip_start, 3), round(clip_end, 3)
    if clip_end <= clip_start:
        return 0.0, round(min(orig_dur, src_cap), 3)
    return clip_start, clip_end


def _offset_operations_for_slice(
    ops: list[EditOperation], clip_start: float, clip_end: float, clip_dur: float, orig_dur: float
) -> list[EditOperation]:
    """Keep only operations overlapping `[clip_start, clip_end]` and offset timestamps by `-clip_start`."""
    sliced_ops: list[EditOperation] = []
    for raw_op in ops:
        op = raw_op.model_copy(deep=True)
        if op.type == "borrow_stem":
            t_start = op.target_start if op.target_start is not None else (op.start if op.start is not None else 0.0)
            t_end = op.target_end if op.target_end is not None else (op.end if op.end is not None else orig_dur)
            if t_end <= clip_start or t_start >= clip_end:
                continue
            lead_trim = max(0.0, clip_start - t_start)
            new_ts, new_te = max(0.0, min(clip_dur, t_start - clip_start)), max(0.0, min(clip_dur, t_end - clip_start))
            if new_te <= new_ts:
                continue
            if lead_trim > 0.0:
                op.ref_start = round((op.ref_start or 0.0) + lead_trim, 3)
            op.target_start = op.start = round(new_ts, 4)
            op.target_end = op.end = round(new_te, 4)
            sliced_ops.append(op)
            continue

        raw_start = op.start if op.start is not None else 0.0
        raw_end = op.end if op.end is not None else orig_dur
        if raw_end <= clip_start or raw_start >= clip_end:
            continue
        if op.type == "tempo_pitch" and raw_start <= 0.1 and raw_end >= orig_dur - 0.1:
            op.start, op.end, op.snap_to_beat = 0.0, round(clip_dur, 4), False
            sliced_ops.append(op)
            continue

        new_s, new_e = max(0.0, min(clip_dur, raw_start - clip_start)), max(0.0, min(clip_dur, raw_end - clip_start))
        if new_e <= new_s:
            continue
        op.start, op.end = round(new_s, 4), round(new_e, 4)
        sliced_ops.append(op)
    return sliced_ops


def _load_sliced_preview_inputs(
    store: ProjectStore,
    project: ProjectState,
    main_wav: Path,
    sr: int,
    ops: list[EditOperation],
    clip_start: float,
    clip_end: float,
    orig_dur: float,
) -> tuple[dict[str, np.ndarray] | None, np.ndarray | None, list[float], list[EditOperation]]:
    """Read sliced stem or main buffers and offset beats/operations to `[0, clip_dur]`."""
    assert project.main_track is not None
    stem_buffers = _load_stems_if_ready(store, project, sr, clip_start=clip_start, clip_end=clip_end)
    full_mix = None if stem_buffers is not None else _read_audio_slice(main_wav, clip_start, clip_end, sr)
    total_samples = len(full_mix) if full_mix is not None else len(next(iter(stem_buffers.values())))  # type: ignore[arg-type]
    clip_dur = total_samples / float(sr) if sr > 0 else max(0.1, clip_end - clip_start)
    clip_beats = [
        round(b - clip_start, 4)
        for b in project.main_track.beats
        if (clip_start - 0.05) <= b <= (clip_end + 0.05)
    ]
    sliced_ops = _offset_operations_for_slice(ops, clip_start, clip_end, clip_dur, orig_dur)
    return stem_buffers, full_mix, clip_beats, sliced_ops


def _finalize_and_write_preview(
    store: ProjectStore, project: ProjectState, proposal: EditProposal, clip: np.ndarray, sr: int,
    clip_start: float, clip_end: float, nonce: str | None,
) -> Path:
    """Cap, fade, atomically write preview WAV, and update proposal metadata."""
    max_out_samples = int(round(MAX_PREVIEW_SECONDS * sr))
    if len(clip) > max_out_samples > 0:
        clip = clip[:max_out_samples]
    clip = clip.copy()
    clip *= _cosine_fade_mask(len(clip), min(int(0.015 * sr), len(clip) // 2))

    preview_path = store.preview_audio_path(project.id, proposal.id, nonce=nonce)
    preview_path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=".prev_", suffix=".wav", dir=str(preview_path.parent))
    os.close(fd)
    tmp_path = Path(tmp_name)
    try:
        sf.write(str(tmp_path), soft_limit(clip), sr, subtype="PCM_16")
        os.replace(tmp_path, preview_path)
    except Exception:
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise

    store.prune_old_previews(project.id, proposal.id, keep_name=preview_path.name)
    proposal.preview_start, proposal.preview_end = clip_start, clip_end
    proposal.preview_url = store.preview_audio_url(project.id, proposal.id, nonce=nonce)
    return preview_path

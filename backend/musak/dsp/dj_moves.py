"""DJ performance moves: beat-repeat stutter and real-audio vinyl brake."""

from __future__ import annotations

import numpy as np
from scipy.interpolate import CubicSpline

from musak.dsp.utils import _apply_tail_fade_out, _cosine_fade_mask, snap_range_to_beats
from musak.models import EditOperation


def _resolve_op_indices(
    audio_len: int, sr: int, op: EditOperation, beats: list[float]
) -> tuple[int, int]:
    duration = audio_len / float(sr) if sr > 0 else 0.0
    snap = True if op.snap_to_beat is None else bool(op.snap_to_beat)
    raw_start = op.start if op.start is not None else 0.0
    raw_end = op.end if op.end is not None else duration
    s_sec, e_sec = snap_range_to_beats(raw_start, raw_end, beats, duration, snap)
    return max(0, min(audio_len, int(round(s_sec * sr)))), max(0, min(audio_len, int(round(e_sec * sr))))


def _apply_beat_repeat_range(
    audio: np.ndarray,
    sr: int,
    s_idx: int,
    e_idx: int,
    op: EditOperation,
    bpm: float = 120.0,
) -> np.ndarray:
    """Stutter the initial beat-division slice across `[s_idx, e_idx]` with 5ms micro-fades and gentle build."""
    length = e_idx - s_idx
    if length <= 16 or sr <= 0:
        return audio

    safe_bpm = bpm if bpm > 20.0 else 120.0
    div_beats = float(np.clip(op.division_beats if op.division_beats is not None else 0.25, 0.0625, 2.0))
    slice_len = max(32, min(length, int(round(div_beats * (60.0 / safe_bpm) * sr))))

    unit = audio[s_idx : s_idx + slice_len].astype(np.float32, copy=True)
    micro_fade = min(int(round(0.005 * sr)), slice_len // 4)
    unit *= _cosine_fade_mask(slice_len, micro_fade)

    repeats = (length + slice_len - 1) // slice_len
    stuttered = np.tile(unit, (repeats, 1))[:length]
    build = np.linspace(0.78, 1.05, length, dtype=np.float32)[:, np.newaxis]
    stuttered *= build

    edge_mask = _cosine_fade_mask(length, min(int(round(0.010 * sr)), length // 4))
    out = audio.copy()
    out[s_idx:e_idx] = audio[s_idx:e_idx] * (1.0 - edge_mask) + stuttered * edge_mask
    return out


def _apply_beat_repeat(
    audio: np.ndarray,
    sr: int,
    op: EditOperation,
    beats: list[float],
    bpm: float = 120.0,
) -> np.ndarray:
    """Apply beat-repeat stutter using `op` timestamps and beat grid."""
    s_idx, e_idx = _resolve_op_indices(len(audio), sr, op, beats)
    if e_idx <= s_idx:
        return audio
    return _apply_beat_repeat_range(audio, sr, s_idx, e_idx, op, bpm)


def _apply_vinyl_brake_range(
    audio: np.ndarray,
    sr: int,
    s_idx: int,
    e_idx: int,
    op: EditOperation,
) -> np.ndarray:
    """Slow `[s_idx, e_idx]` audio smoothly to a dead stop via quadratic phase warping + tail fade-out."""
    del op  # reserved for future brake curve tuning
    length = e_idx - s_idx
    if length <= 16 or sr <= 0:
        return audio

    seg = audio[s_idx:e_idx].astype(np.float32, copy=False)
    u = np.linspace(0.0, 1.0, length, dtype=np.float64)
    # t_warp(u) = u - 0.5*u^2 => derivative (1 - u): 1.0x speed at u=0 down to 0.0x stop at u=1
    src_pos = (u - 0.5 * (u**2)) * float(length - 1)

    if length >= 4:
        cs = CubicSpline(np.arange(length, dtype=np.float64), seg.astype(np.float64), axis=0)
        braked = cs(src_pos).astype(np.float32)
    else:
        idx_grid = np.arange(length, dtype=np.float64)
        braked = np.stack(
            [np.interp(src_pos, idx_grid, seg[:, ch]) for ch in range(2)],
            axis=-1,
        ).astype(np.float32)

    tail_fade = min(length // 3, max(int(round(0.050 * sr)), length // 5))
    _apply_tail_fade_out(braked, tail_fade)

    entry_len = min(int(round(0.008 * sr)), length // 4)
    out = audio.copy()
    if entry_len > 1:
        ramp = np.linspace(0.0, 1.0, entry_len, dtype=np.float32)[:, np.newaxis]
        braked[:entry_len] = seg[:entry_len] * (1.0 - ramp) + braked[:entry_len] * ramp
    out[s_idx:e_idx] = braked
    return out


def _apply_vinyl_brake(
    audio: np.ndarray,
    sr: int,
    op: EditOperation,
    beats: list[float],
) -> np.ndarray:
    """Apply real-audio vinyl brake using `op` timestamps and beat grid."""
    s_idx, e_idx = _resolve_op_indices(len(audio), sr, op, beats)
    if e_idx <= s_idx:
        return audio
    return _apply_vinyl_brake_range(audio, sr, s_idx, e_idx, op)

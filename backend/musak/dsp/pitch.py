"""Tempo time-stretching, pitch-shifting, and slowed+reverb DSP helpers."""

from __future__ import annotations

import librosa
import numpy as np
import pedalboard as pb

from musak.dsp.utils import _apply_tail_fade_out, _cosine_fade_mask, _run_pedalboard
from musak.models import EditOperation


def _transform_tempo_pitch_segment(
    seg: np.ndarray,
    sr: int,
    speed_rate: float,
    semitones: float,
    add_reverb: bool,
    reverb_wet: float,
) -> np.ndarray:
    """Apply time-stretch, pitch-shift, and optional lush reverb to a `(samples, 2)` float32 segment."""
    out = seg.astype(np.float32, copy=True)
    if len(out) < 256:
        return out

    if abs(speed_rate - 1.0) >= 0.005:
        left = librosa.effects.time_stretch(out[:, 0], rate=speed_rate)
        right = librosa.effects.time_stretch(out[:, 1], rate=speed_rate)
        min_len = min(len(left), len(right))
        out = np.stack([left[:min_len], right[:min_len]], axis=-1).astype(np.float32)

    if abs(semitones) >= 0.01 and len(out) >= 256:
        left = librosa.effects.pitch_shift(out[:, 0], sr=sr, n_steps=semitones)
        right = librosa.effects.pitch_shift(out[:, 1], sr=sr, n_steps=semitones)
        min_len = min(len(left), len(right))
        out = np.stack([left[:min_len], right[:min_len]], axis=-1).astype(np.float32)

    if add_reverb and reverb_wet > 0.0:
        dry_level = max(0.35, 1.0 - reverb_wet * 0.45)
        board = pb.Pedalboard(
            [
                pb.Reverb(
                    room_size=0.78,
                    damping=0.45,
                    wet_level=reverb_wet,
                    dry_level=dry_level,
                    width=1.0,
                )
            ]
        )
        out = _run_pedalboard(board, out, sr)

    return out


def _apply_tempo_pitch_slice(
    audio: np.ndarray,
    sr: int,
    s_idx: int,
    e_idx: int,
    op: EditOperation,
) -> np.ndarray:
    """Apply localized tempo/pitch transformation inside `[s_idx, e_idx]`."""
    length = e_idx - s_idx
    if length <= 16:
        return audio

    speed_rate = float(np.clip(op.speed_rate if op.speed_rate is not None else 1.0, 0.5, 1.6))
    semitones = float(np.clip(op.semitones if op.semitones is not None else 0.0, -12.0, 12.0))
    add_reverb = bool(op.add_reverb)
    reverb_wet = float(np.clip(op.reverb_wet if op.reverb_wet is not None else 0.35, 0.0, 0.8))

    if abs(speed_rate - 1.0) < 0.005 and abs(semitones) < 0.01 and not add_reverb:
        return audio

    transformed = _transform_tempo_pitch_segment(
        audio[s_idx:e_idx], sr, speed_rate, semitones, add_reverb, reverb_wet
    )
    fitted = np.zeros((length, 2), dtype=np.float32)
    copy_len = min(length, len(transformed))
    fitted[:copy_len] = transformed[:copy_len]
    if copy_len < length:
        _apply_tail_fade_out(fitted[:copy_len], int(0.025 * sr))

    mask = _cosine_fade_mask(length, min(int(0.025 * sr), length // 2))
    out = audio.copy()
    out[s_idx:e_idx] = audio[s_idx:e_idx] * (1.0 - mask) + fitted * mask
    return out

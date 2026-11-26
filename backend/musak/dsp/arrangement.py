"""Non-destructive timeline arrangement operations (cut_section, repeat_section)."""

from __future__ import annotations

import math

import numpy as np

from musak.dsp.borrow import _tile_clip_with_crossfade
from musak.dsp.utils import snap_range_to_beats
from musak.models import EditOperation

ARRANGEMENT_OP_TYPES = ("cut_section", "repeat_section")


def _splice_cut(audio: np.ndarray, sr: int, s_idx: int, e_idx: int) -> np.ndarray:
    """Remove `[s_idx, e_idx]` from `audio` with a smooth 25ms cosine crossfade across the join."""
    before = audio[:s_idx]
    after = audio[e_idx:]
    if len(before) == 0:
        return after.astype(np.float32, copy=True)
    if len(after) == 0:
        return before.astype(np.float32, copy=True)

    xf = min(int(round(0.025 * sr)), len(before), len(after))
    if xf <= 1:
        return np.concatenate([before, after], axis=0).astype(np.float32, copy=False)

    t = np.linspace(0.0, math.pi, xf, dtype=np.float32)[:, np.newaxis]
    fade_in = 0.5 * (1.0 - np.cos(t))
    fade_out = 0.5 * (1.0 + np.cos(t))
    join = before[-xf:] * fade_out + after[:xf] * fade_in
    return np.concatenate([before[:-xf], join, after[xf:]], axis=0).astype(np.float32, copy=False)


def _repeat_slice(audio: np.ndarray, sr: int, s_idx: int, e_idx: int, count: int) -> np.ndarray:
    """Repeat `[s_idx, e_idx]` `count` times with 20ms cosine crossfades at loop boundaries."""
    seg = audio[s_idx:e_idx]
    seg_len = len(seg)
    if seg_len <= 0 or count <= 1:
        return audio

    xf = min(int(round(0.020 * sr)), seg_len // 4)
    target_len = count * seg_len - (count - 1) * xf if xf > 1 else count * seg_len
    repeated = _tile_clip_with_crossfade(seg, target_len, xf)
    return np.concatenate([audio[:s_idx], repeated, audio[e_idx:]], axis=0).astype(np.float32, copy=False)


def apply_arrangement_ops(
    audio: np.ndarray,
    sr: int,
    ops: list[EditOperation],
    beats: list[float],
    duration: float,
) -> np.ndarray:
    """Apply `cut_section` and `repeat_section` in reverse chronological order so timestamps never drift."""
    arr_ops = [op for op in ops if op.type in ARRANGEMENT_OP_TYPES]
    if not arr_ops or len(audio) == 0 or sr <= 0:
        return audio

    resolved: list[tuple[int, int, EditOperation]] = []
    for op in arr_ops:
        snap = True if op.snap_to_beat is None else bool(op.snap_to_beat)
        raw_s = op.start if op.start is not None else 0.0
        raw_e = op.end if op.end is not None else duration
        s_sec, e_sec = snap_range_to_beats(raw_s, raw_e, beats, duration, snap)
        s_idx, e_idx = int(round(s_sec * sr)), int(round(e_sec * sr))
        if e_idx > s_idx:
            resolved.append((s_idx, e_idx, op))

    if not resolved:
        return audio

    # Highest start first so earlier cuts/repeats don't shift later timestamps; clamp overlaps cleanly
    resolved.sort(key=lambda item: (item[0], item[1]), reverse=True)
    out = audio.astype(np.float32, copy=True)
    min_remaining = max(1, int(round(0.5 * sr)))
    last_start = len(out)
    for s_idx, e_idx, op in resolved:
        cur_s = max(0, min(s_idx, len(out), last_start))
        cur_e = max(cur_s, min(e_idx, len(out), last_start))
        if cur_e <= cur_s:
            continue
        if op.type == "cut_section":
            if len(out) - (cur_e - cur_s) < min_remaining:
                continue
            out = _splice_cut(out, sr, cur_s, cur_e)
        elif op.type == "repeat_section":
            count = max(2, min(4, int(op.repeat_count or 2)))
            out = _repeat_slice(out, sr, cur_s, cur_e, count)
        last_start = cur_s
    return out

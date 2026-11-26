"""Core audio DSP effects and SFX overlay builder."""

from __future__ import annotations

import logging
import math

import numpy as np
import pedalboard as pb
from scipy.signal import butter, sosfilt

from musak.dsp.cache import get_cached_sfx
from musak.dsp.utils import (
    _apply_tail_fade_out,
    _asymmetric_cosine_mask,
    _cosine_fade_mask,
    _run_pedalboard,
    snap_range_to_beats,
)
from musak.models import EditOperation
from musak.sfx import get_sfx_item, synthesize_sfx

logger = logging.getLogger(__name__)


def _apply_padded_pedalboard_effect(
    audio: np.ndarray, sr: int, s_idx: int, e_idx: int, board: pb.Pedalboard
) -> np.ndarray:
    """Run `board` with pre-roll context padding and cosine crossfade into `[s_idx, e_idx]`."""
    length = e_idx - s_idx
    if length <= 0:
        return audio
    pad = min(int(0.05 * sr), s_idx)
    processed = _run_pedalboard(board, audio[s_idx - pad : e_idx], sr)[pad:]
    mask = _cosine_fade_mask(length, min(int(0.025 * sr), length // 2))
    out = audio.copy()
    out[s_idx:e_idx] = audio[s_idx:e_idx] * (1.0 - mask) + processed * mask
    return out


def _apply_wet_throw(
    audio: np.ndarray,
    sr: int,
    s_idx: int,
    e_idx: int,
    tail_sec: float,
    fade_in_sec: float,
    fade_out_sec: float,
    board: pb.Pedalboard,
    wet_scale: float = 1.0,
) -> np.ndarray:
    """Send `[s_idx, e_idx]` into a wet effect tail and sum back onto `audio`."""
    length = e_idx - s_idx
    if length <= 0:
        return audio
    max_total = min(len(audio) - s_idx, length + int(tail_sec * sr))
    send = audio[s_idx:e_idx].copy()
    send *= _cosine_fade_mask(length, min(int(fade_in_sec * sr), length // 2))
    feed = np.zeros((max_total, 2), dtype=np.float32)
    feed[:length] = send[:max_total]
    wet_tail = _run_pedalboard(board, feed, sr) * wet_scale
    if s_idx + max_total < len(audio):
        _apply_tail_fade_out(wet_tail, int(fade_out_sec * sr))
    out = audio.copy()
    out[s_idx : s_idx + max_total] += wet_tail
    return out


def _apply_stem_gain(audio: np.ndarray, sr: int, s_idx: int, e_idx: int, op: EditOperation) -> np.ndarray:
    """Apply smooth dB gain change or fade-in/fade-out curve over `[s_idx, e_idx]`."""
    length = e_idx - s_idx
    if length <= 0:
        return audio
    gain_db = float(op.gain_db if op.gain_db is not None else 0.0)
    target_gain = 0.0 if gain_db <= -60.0 else float(10.0 ** (gain_db / 20.0))
    out = audio.copy()

    if op.fade_curve == "in":
        ramp = 0.5 * (1.0 - np.cos(np.linspace(0.0, math.pi, length, dtype=np.float32)))
        out[s_idx:e_idx] *= (ramp * target_gain)[:, np.newaxis]
        return out
    if op.fade_curve == "out":
        start_gain = target_gain if (op.gain_db is not None and op.gain_db > -60.0) else 1.0
        ramp = 0.5 * (1.0 + np.cos(np.linspace(0.0, math.pi, length, dtype=np.float32)))
        out[s_idx:e_idx] *= (ramp * start_gain)[:, np.newaxis]
        return out

    default_ms = float(op.fade_ms if op.fade_ms is not None else 30.0)
    fi_ms = float(np.clip(op.fade_in_ms if op.fade_in_ms is not None else default_ms, 0.0, 4000.0))
    fo_ms = float(np.clip(op.fade_out_ms if op.fade_out_ms is not None else default_ms, 0.0, 4000.0))
    mask = _asymmetric_cosine_mask(length, int(round(fi_ms * sr / 1000.0)), int(round(fo_ms * sr / 1000.0)))
    if op.fade_curve == "both":
        out[s_idx:e_idx] *= mask * target_gain
    else:
        out[s_idx:e_idx] *= 1.0 + mask * (target_gain - 1.0)
    return out


def _apply_filter_sweep(audio: np.ndarray, sr: int, s_idx: int, e_idx: int, op: EditOperation) -> np.ndarray:
    """Apply an overlap-add log-interpolated Butterworth filter sweep over `[s_idx, e_idx]`."""
    length = e_idx - s_idx
    if length <= 16:
        return audio
    mode = op.mode or "lowpass"
    nyq = sr * 0.45
    d_start, d_end = (150.0, 2400.0) if mode == "highpass" else (16000.0, 350.0)
    start_hz = float(np.clip(op.start_hz if op.start_hz is not None else d_start, 25.0, nyq))
    end_hz = float(np.clip(op.end_hz if op.end_hz is not None else d_end, 25.0, nyq))

    win_len = min(2048, max(256, (length // 4) * 2))
    win_len += win_len % 2
    hop = max(128, win_len // 2)
    window = np.hanning(win_len).astype(np.float32)[:, np.newaxis]

    ctx_start = max(0, s_idx - min(2048, win_len))
    ctx_end = min(len(audio), e_idx + min(2048, win_len))
    padded = audio[ctx_start:ctx_end].astype(np.float32, copy=False)
    rel_s = s_idx - ctx_start

    wet = np.zeros((length, 2), dtype=np.float32)
    norm = np.zeros((length, 1), dtype=np.float32)
    btype = "highpass" if mode == "highpass" else "lowpass"
    log_start, log_end = math.log(start_hz), math.log(end_hz)

    pos = 0
    while pos < length:
        seg_end = min(pos + win_len, length)
        seg_len = seg_end - pos
        cutoff_hz = float(np.clip(math.exp(log_start + ((pos + seg_len * 0.5) / max(1, length)) * (log_end - log_start)), 25.0, nyq))
        sos = butter(4, cutoff_hz / (sr * 0.5), btype=btype, output="sos")
        p_start = max(0, rel_s + pos - 512)
        local_offset = (rel_s + pos) - p_start
        filtered = sosfilt(sos, padded[p_start : rel_s + seg_end], axis=0)[local_offset : local_offset + seg_len].astype(np.float32)
        w = window[:seg_len] if seg_len == win_len else np.hanning(max(2, seg_len)).astype(np.float32)[:, np.newaxis]
        wet[pos:seg_end] += filtered * w
        norm[pos:seg_end] += w
        if seg_end >= length:
            break
        pos += hop

    wet /= np.maximum(norm, 1e-6)
    mask = _cosine_fade_mask(length, min(int(0.025 * sr), length // 2))
    out = audio.copy()
    out[s_idx:e_idx] = audio[s_idx:e_idx] * (1.0 - mask) + wet * mask
    return out


def _apply_reverb_throw(audio: np.ndarray, sr: int, s_idx: int, e_idx: int, op: EditOperation) -> np.ndarray:
    """Apply a lush reverb throw whose tail decays past `e_idx`."""
    room_size = float(np.clip(op.room_size if op.room_size is not None else 0.75, 0.0, 1.0))
    wet_level = float(np.clip(op.wet_level if op.wet_level is not None else 0.45, 0.0, 1.0))
    board = pb.Pedalboard([pb.Reverb(room_size=room_size, damping=0.45, wet_level=wet_level, dry_level=0.0, width=1.0)])
    return _apply_wet_throw(audio, sr, s_idx, e_idx, 1.5 + 3.0 * room_size, 0.02, 0.05, board)


def _apply_delay_throw(audio: np.ndarray, sr: int, s_idx: int, e_idx: int, op: EditOperation, bpm: float) -> np.ndarray:
    """Apply a BPM-synced delay throw whose echoes decay past `e_idx`."""
    safe_bpm = bpm if bpm > 20.0 else 120.0
    delay_beats = float(np.clip(op.delay_beats if op.delay_beats is not None else 0.5, 0.0625, 4.0))
    feedback = float(np.clip(op.feedback if op.feedback is not None else 0.45, 0.0, 0.92))
    mix = float(np.clip(op.mix if op.mix is not None else 0.4, 0.0, 1.0))
    delay_seconds = float(np.clip((60.0 / safe_bpm) * delay_beats, 0.02, 2.0))
    tail_sec = min(6.0, delay_seconds * (3.0 + 6.0 * feedback))
    board = pb.Pedalboard([pb.Delay(delay_seconds=delay_seconds, feedback=feedback, mix=1.0)])
    return _apply_wet_throw(audio, sr, s_idx, e_idx, tail_sec, 0.015, 0.04, board, wet_scale=mix)


def _apply_lofi_eq(audio: np.ndarray, sr: int, s_idx: int, e_idx: int, op: EditOperation) -> np.ndarray:
    """Apply bandpass telephone/radio EQ and subtle tape drive over `[s_idx, e_idx]`."""
    low_cut = float(np.clip(op.low_cut_hz if op.low_cut_hz is not None else 300.0, 40.0, 4000.0))
    high_cut = float(np.clip(op.high_cut_hz if op.high_cut_hz is not None else 3200.0, low_cut + 100.0, sr * 0.45))
    drive_db = float(np.clip(op.drive_db if op.drive_db is not None else 8.0, 0.0, 30.0))
    plugins: list[pb.Plugin] = [
        pb.HighpassFilter(cutoff_frequency_hz=low_cut),
        pb.LowpassFilter(cutoff_frequency_hz=high_cut),
    ]
    if drive_db > 0.0:
        plugins.append(pb.Distortion(drive_db=drive_db))
    return _apply_padded_pedalboard_effect(audio, sr, s_idx, e_idx, pb.Pedalboard(plugins))


def _apply_bass_boost(audio: np.ndarray, sr: int, s_idx: int, e_idx: int, op: EditOperation) -> np.ndarray:
    """Apply low-shelf bass boost with gentle compression over `[s_idx, e_idx]`."""
    gain_db = float(np.clip(op.gain_db if op.gain_db is not None else 6.0, -12.0, 18.0))
    cutoff_hz = float(np.clip(op.cutoff_hz if op.cutoff_hz is not None else 120.0, 40.0, 400.0))
    board = pb.Pedalboard(
        [
            pb.LowShelfFilter(cutoff_frequency_hz=cutoff_hz, gain_db=gain_db),
            pb.Compressor(threshold_db=-14.0, ratio=2.5, attack_ms=10.0, release_ms=100.0),
        ]
    )
    return _apply_padded_pedalboard_effect(audio, sr, s_idx, e_idx, board)


def _build_sfx_overlay(
    total_samples: int,
    sr: int,
    beats: list[float],
    duration: float,
    bpm: float,
    op: EditOperation,
    default_key: str | None = None,
) -> tuple[int, np.ndarray] | None:
    """Synthesize and return `(start_idx, fitted_stereo_slice)` for an `add_sfx` layer."""
    if not op.sfx_id:
        return None
    sfx_item = get_sfx_item(op.sfx_id)
    if sfx_item is None:
        logger.warning("add_sfx skipped: unknown sfx_id '%s'.", op.sfx_id)
        return None

    snap = True if op.snap_to_beat is None else bool(op.snap_to_beat)
    raw_start = op.start if op.start is not None else 0.0
    raw_end = op.end if op.end is not None else (raw_start + sfx_item.default_duration)
    s_sec, e_sec = snap_range_to_beats(raw_start, raw_end, beats, duration, snap)
    s_idx = max(0, min(total_samples, int(round(s_sec * sr))))
    e_idx = max(s_idx, min(total_samples, int(round(e_sec * sr))))
    length = e_idx - s_idx
    if length <= 0:
        return None

    resolved_key = op.musical_key or default_key
    sfx_audio = get_cached_sfx(
        op.sfx_id,
        length,
        sr,
        bpm,
        resolved_key,
        lambda: synthesize_sfx(
            op.sfx_id or "", duration=length / float(sr), sr=sr, bpm=bpm, musical_key=resolved_key
        ),
    )
    if len(sfx_audio) == 0:
        return None

    fitted = np.zeros((length, 2), dtype=np.float32)
    copy_len = min(length, len(sfx_audio))
    fitted[:copy_len] = sfx_audio[:copy_len]
    gain_db = float(op.gain_db if op.gain_db is not None else 0.0)
    fitted *= 0.0 if gain_db <= -60.0 else float(10.0 ** (gain_db / 20.0))
    fi_ms = float(np.clip(op.fade_in_ms if op.fade_in_ms is not None else 10.0, 0.0, 4000.0))
    fo_ms = float(np.clip(op.fade_out_ms if op.fade_out_ms is not None else 10.0, 0.0, 4000.0))
    fitted *= _asymmetric_cosine_mask(length, int(round(fi_ms * sr / 1000.0)), int(round(fo_ms * sr / 1000.0)))
    return s_idx, fitted

"""Non-destructive, beat-snapped DSP renderer supporting all 7 Musak edit operations."""

from __future__ import annotations

import logging
import math
import subprocess
from pathlib import Path
from typing import Literal

import librosa
import numpy as np
import pedalboard as pb
import soundfile as sf
from scipy.signal import butter, sosfilt

from musak.audio_analysis import ensure_stereo, resample_stereo, semitone_diff_between_keys
from musak.config import STEM_NAMES, TARGET_SAMPLE_RATE, get_ffmpeg_path
from musak.models import EditOperation, EditProposal, ProjectState
from musak.storage import ProjectStore

logger = logging.getLogger(__name__)

ENDPOINT_SNAP_EPSILON = 0.05


def snap_range_to_beats(
    start: float,
    end: float,
    beats: list[float],
    duration: float,
    snap_to_beat: bool = True,
) -> tuple[float, float]:
    """Clamp `[start, end]` to `[0, duration]` and optionally snap to nearest beat.

    Endpoints within `0.05s` of `0.0` or `duration` are not snapped so full-track edits
    cover the entire song cleanly.
    """
    s = max(0.0, min(float(start), duration))
    e = max(0.0, min(float(end), duration))
    if e < s:
        s, e = e, s

    if snap_to_beat and beats and e > s:
        pin_start = s <= ENDPOINT_SNAP_EPSILON
        pin_end = abs(duration - e) <= ENDPOINT_SNAP_EPSILON

        snapped_s = s if pin_start else min(beats, key=lambda b: abs(b - s))
        snapped_e = e if pin_end else min(beats, key=lambda b: abs(b - e))

        if snapped_e > snapped_s:
            s, e = snapped_s, snapped_e
        else:
            later = [b for b in beats if b > snapped_s]
            if later:
                s, e = snapped_s, min(duration, later[0])

    return max(0.0, min(s, duration)), max(0.0, min(e, duration))


def _cosine_fade_mask(length: int, fade_samples: int) -> np.ndarray:
    """Return a smooth `(length, 1)` [0..1] cosine envelope for click-free crossfades."""
    if length <= 0:
        return np.zeros((0, 1), dtype=np.float32)
    mask = np.ones(length, dtype=np.float32)
    f = min(max(0, fade_samples), length // 2)
    if f > 0:
        t = np.linspace(0.0, math.pi, f, dtype=np.float32)
        ramp_in = 0.5 * (1.0 - np.cos(t))
        mask[:f] = ramp_in
        mask[-f:] = ramp_in[::-1]
    return mask[:, np.newaxis]


def _run_pedalboard(board: pb.Pedalboard, audio: np.ndarray, sr: int) -> np.ndarray:
    """Run Pedalboard on `(samples, 2)` float32 audio and return `(samples, 2)` float32."""
    if len(audio) == 0:
        return audio.copy()
    channels_first = np.ascontiguousarray(audio.T, dtype=np.float32)
    processed = board(channels_first, sr)
    return np.ascontiguousarray(processed.T, dtype=np.float32)


def soft_limit(audio: np.ndarray, threshold: float = 0.95) -> np.ndarray:
    """Apply smooth tanh soft-limiting above `threshold` so output never digitally clips."""
    out = np.nan_to_num(audio.astype(np.float32, copy=True), nan=0.0, posinf=1.0, neginf=-1.0)
    abs_val = np.abs(out)
    over = abs_val > threshold
    if np.any(over):
        headroom = 1.0 - threshold
        excess = (abs_val[over] - threshold) / max(headroom, 1e-6)
        limited = threshold + headroom * np.tanh(excess)
        out[over] = np.sign(out[over]) * limited
    return np.clip(out, -0.998, 0.998).astype(np.float32, copy=False)


# --- Individual DSP Operation Implementations ---


def _apply_stem_gain(
    audio: np.ndarray,
    sr: int,
    s_idx: int,
    e_idx: int,
    op: EditOperation,
) -> np.ndarray:
    length = e_idx - s_idx
    if length <= 0:
        return audio

    gain_db = float(op.gain_db if op.gain_db is not None else 0.0)
    fade_ms = float(op.fade_ms if op.fade_ms is not None else 30.0)
    target_gain = 0.0 if gain_db <= -60.0 else float(10.0 ** (gain_db / 20.0))

    fade_samples = int(max(1.0, fade_ms) * sr / 1000.0)
    mask = _cosine_fade_mask(length, fade_samples)
    gain_curve = 1.0 + mask * (target_gain - 1.0)

    out = audio.copy()
    out[s_idx:e_idx] *= gain_curve
    return out


def _apply_filter_sweep(
    audio: np.ndarray,
    sr: int,
    s_idx: int,
    e_idx: int,
    op: EditOperation,
) -> np.ndarray:
    length = e_idx - s_idx
    if length <= 16:
        return audio

    mode = op.mode or "lowpass"
    nyq = sr * 0.45
    if mode == "highpass":
        default_start, default_end = 150.0, 2400.0
    else:
        default_start, default_end = 16000.0, 350.0

    start_hz = float(np.clip(op.start_hz if op.start_hz is not None else default_start, 25.0, nyq))
    end_hz = float(np.clip(op.end_hz if op.end_hz is not None else default_end, 25.0, nyq))

    # Overlap-add COLA with Hann window and log-interpolated Butterworth filter
    win_len = min(2048, max(256, (length // 4) * 2))
    if win_len % 2 != 0:
        win_len += 1
    hop = max(128, win_len // 2)
    window = np.hanning(win_len).astype(np.float32)[:, np.newaxis]

    pad_ctx = min(2048, win_len)
    ctx_start = max(0, s_idx - pad_ctx)
    ctx_end = min(len(audio), e_idx + pad_ctx)
    padded = audio[ctx_start:ctx_end].astype(np.float32, copy=False)
    rel_s = s_idx - ctx_start

    wet = np.zeros((length, 2), dtype=np.float32)
    norm = np.zeros((length, 1), dtype=np.float32)

    btype = "highpass" if mode == "highpass" else "lowpass"
    log_start = math.log(start_hz)
    log_end = math.log(end_hz)

    pos = 0
    while pos < length:
        seg_end = min(pos + win_len, length)
        seg_len = seg_end - pos
        frac = (pos + seg_len * 0.5) / max(1, length)
        cutoff_hz = float(np.clip(math.exp(log_start + frac * (log_end - log_start)), 25.0, nyq))

        sos = butter(4, cutoff_hz / (sr * 0.5), btype=btype, output="sos")

        p_start = max(0, rel_s + pos - 512)
        p_end = rel_s + seg_end
        local_offset = (rel_s + pos) - p_start
        chunk = padded[p_start:p_end]
        filtered = sosfilt(sos, chunk, axis=0)[local_offset : local_offset + seg_len].astype(np.float32)

        w = window[:seg_len] if seg_len == win_len else np.hanning(max(2, seg_len)).astype(np.float32)[:, np.newaxis]
        wet[pos:seg_end] += filtered * w
        norm[pos:seg_end] += w

        if seg_end >= length:
            break
        pos += hop

    wet /= np.maximum(norm, 1e-6)

    fade_samples = min(int(0.025 * sr), length // 2)
    mask = _cosine_fade_mask(length, fade_samples)

    out = audio.copy()
    out[s_idx:e_idx] = audio[s_idx:e_idx] * (1.0 - mask) + wet * mask
    return out


def _apply_reverb_throw(
    audio: np.ndarray,
    sr: int,
    s_idx: int,
    e_idx: int,
    op: EditOperation,
) -> np.ndarray:
    length = e_idx - s_idx
    if length <= 0:
        return audio

    room_size = float(np.clip(op.room_size if op.room_size is not None else 0.75, 0.0, 1.0))
    wet_level = float(np.clip(op.wet_level if op.wet_level is not None else 0.45, 0.0, 1.0))

    tail_sec = 1.5 + 3.0 * room_size
    tail_samples = int(tail_sec * sr)
    max_total = min(len(audio) - s_idx, length + tail_samples)

    send = audio[s_idx:e_idx].copy()
    send *= _cosine_fade_mask(length, min(int(0.02 * sr), length // 2))

    feed = np.zeros((max_total, 2), dtype=np.float32)
    feed[:length] = send[:max_total]

    board = pb.Pedalboard(
        [
            pb.Reverb(
                room_size=room_size,
                damping=0.45,
                wet_level=wet_level,
                dry_level=0.0,
                width=1.0,
            )
        ]
    )
    wet_tail = _run_pedalboard(board, feed, sr)

    end_fade = min(int(0.05 * sr), len(wet_tail))
    if end_fade > 0 and s_idx + max_total < len(audio):
        ramp = 0.5 * (1.0 + np.cos(np.linspace(0.0, math.pi, end_fade, dtype=np.float32)))[:, np.newaxis]
        wet_tail[-end_fade:] *= ramp

    out = audio.copy()
    out[s_idx : s_idx + max_total] += wet_tail
    return out


def _apply_delay_throw(
    audio: np.ndarray,
    sr: int,
    s_idx: int,
    e_idx: int,
    op: EditOperation,
    bpm: float,
) -> np.ndarray:
    length = e_idx - s_idx
    if length <= 0:
        return audio

    safe_bpm = bpm if bpm > 20.0 else 120.0
    delay_beats = float(np.clip(op.delay_beats if op.delay_beats is not None else 0.5, 0.0625, 4.0))
    feedback = float(np.clip(op.feedback if op.feedback is not None else 0.45, 0.0, 0.92))
    mix = float(np.clip(op.mix if op.mix is not None else 0.4, 0.0, 1.0))

    delay_seconds = float(np.clip((60.0 / safe_bpm) * delay_beats, 0.02, 2.0))
    tail_sec = min(6.0, delay_seconds * (3.0 + 6.0 * feedback))
    tail_samples = int(tail_sec * sr)
    max_total = min(len(audio) - s_idx, length + tail_samples)

    send = audio[s_idx:e_idx].copy()
    send *= _cosine_fade_mask(length, min(int(0.015 * sr), length // 2))

    feed = np.zeros((max_total, 2), dtype=np.float32)
    feed[:length] = send[:max_total]

    board = pb.Pedalboard([pb.Delay(delay_seconds=delay_seconds, feedback=feedback, mix=1.0)])
    wet_tail = _run_pedalboard(board, feed, sr) * mix

    end_fade = min(int(0.04 * sr), len(wet_tail))
    if end_fade > 0 and s_idx + max_total < len(audio):
        ramp = 0.5 * (1.0 + np.cos(np.linspace(0.0, math.pi, end_fade, dtype=np.float32)))[:, np.newaxis]
        wet_tail[-end_fade:] *= ramp

    out = audio.copy()
    out[s_idx : s_idx + max_total] += wet_tail
    return out


def _apply_lofi_eq(
    audio: np.ndarray,
    sr: int,
    s_idx: int,
    e_idx: int,
    op: EditOperation,
) -> np.ndarray:
    length = e_idx - s_idx
    if length <= 0:
        return audio

    low_cut = float(np.clip(op.low_cut_hz if op.low_cut_hz is not None else 300.0, 40.0, 4000.0))
    high_cut = float(np.clip(op.high_cut_hz if op.high_cut_hz is not None else 3200.0, low_cut + 100.0, sr * 0.45))
    drive_db = float(np.clip(op.drive_db if op.drive_db is not None else 8.0, 0.0, 30.0))

    pad = min(int(0.05 * sr), s_idx)
    seg = audio[s_idx - pad : e_idx]

    plugins: list[pb.Plugin] = [
        pb.HighpassFilter(cutoff_frequency_hz=low_cut),
        pb.LowpassFilter(cutoff_frequency_hz=high_cut),
    ]
    if drive_db > 0.0:
        plugins.append(pb.Distortion(drive_db=drive_db))

    board = pb.Pedalboard(plugins)
    processed = _run_pedalboard(board, seg, sr)[pad:]

    mask = _cosine_fade_mask(length, min(int(0.025 * sr), length // 2))
    out = audio.copy()
    out[s_idx:e_idx] = audio[s_idx:e_idx] * (1.0 - mask) + processed * mask
    return out


def _apply_bass_boost(
    audio: np.ndarray,
    sr: int,
    s_idx: int,
    e_idx: int,
    op: EditOperation,
) -> np.ndarray:
    length = e_idx - s_idx
    if length <= 0:
        return audio

    gain_db = float(np.clip(op.gain_db if op.gain_db is not None else 6.0, -12.0, 18.0))
    cutoff_hz = float(np.clip(op.cutoff_hz if op.cutoff_hz is not None else 120.0, 40.0, 400.0))

    pad = min(int(0.05 * sr), s_idx)
    seg = audio[s_idx - pad : e_idx]

    board = pb.Pedalboard(
        [
            pb.LowShelfFilter(cutoff_frequency_hz=cutoff_hz, gain_db=gain_db),
            pb.Compressor(threshold_db=-14.0, ratio=2.5, attack_ms=10.0, release_ms=100.0),
        ]
    )
    processed = _run_pedalboard(board, seg, sr)[pad:]

    mask = _cosine_fade_mask(length, min(int(0.025 * sr), length // 2))
    out = audio.copy()
    out[s_idx:e_idx] = audio[s_idx:e_idx] * (1.0 - mask) + processed * mask
    return out


def _apply_borrow_stem(
    store: ProjectStore,
    project: ProjectState,
    stem_buffers: dict[str, np.ndarray] | None,
    full_mix: np.ndarray | None,
    sr: int,
    op: EditOperation,
) -> tuple[dict[str, np.ndarray] | None, np.ndarray | None, np.ndarray | None]:
    """Load, time-stretch, pitch-shift, and blend a borrowed clip from a reference track."""
    if not op.ref_id or project.main_track is None:
        return stem_buffers, full_mix, None

    ref = next((r for r in project.references if r.id == op.ref_id), None)
    if ref is None:
        logger.warning("borrow_stem skipped: reference '%s' not found.", op.ref_id)
        return stem_buffers, full_mix, None

    ref_stem = op.ref_stem or "full"
    src_path: Path | None = None
    if ref_stem != "full":
        candidate = store.reference_stem_path(project.id, ref.id, ref_stem)
        if candidate.is_file():
            src_path = candidate
    if src_path is None:
        candidate = store.reference_audio_path(project.id, ref.id)
        if candidate.is_file():
            src_path = candidate

    if src_path is None:
        logger.warning("borrow_stem skipped: reference '%s' has no local audio downloaded.", ref.id)
        return stem_buffers, full_mix, None

    ref_audio, ref_sr = sf.read(str(src_path), dtype="float32", always_2d=True)
    ref_stereo = ensure_stereo(ref_audio)
    if int(ref_sr) != sr:
        ref_stereo = resample_stereo(ref_stereo, int(ref_sr), sr)

    ref_dur = len(ref_stereo) / float(sr)
    r_start = max(0.0, min(float(op.ref_start if op.ref_start is not None else 0.0), ref_dur))
    r_end = max(r_start, min(float(op.ref_end if op.ref_end is not None else ref_dur), ref_dur))
    rs_idx = int(round(r_start * sr))
    re_idx = int(round(r_end * sr))
    if re_idx <= rs_idx:
        return stem_buffers, full_mix, None

    clip = ref_stereo[rs_idx:re_idx].copy()

    # BPM time-stretching
    match_bpm = True if op.match_bpm is None else bool(op.match_bpm)
    if match_bpm and ref.bpm and project.main_track.bpm and ref.bpm > 20.0 and project.main_track.bpm > 20.0:
        rate = float(np.clip(project.main_track.bpm / ref.bpm, 0.5, 2.0))
        if abs(rate - 1.0) > 0.01 and len(clip) >= 256:
            left = librosa.effects.time_stretch(clip[:, 0].astype(np.float32), rate=rate)
            right = librosa.effects.time_stretch(clip[:, 1].astype(np.float32), rate=rate)
            min_len = min(len(left), len(right))
            clip = np.stack([left[:min_len], right[:min_len]], axis=-1).astype(np.float32)

    # Musical key pitch-shifting
    match_key = True if op.match_key is None else bool(op.match_key)
    if match_key and ref.key and project.main_track.key:
        semitones = semitone_diff_between_keys(ref.key, project.main_track.key)
        if semitones != 0 and len(clip) >= 256:
            left = librosa.effects.pitch_shift(clip[:, 0].astype(np.float32), sr=sr, n_steps=float(semitones))
            right = librosa.effects.pitch_shift(clip[:, 1].astype(np.float32), sr=sr, n_steps=float(semitones))
            min_len = min(len(left), len(right))
            clip = np.stack([left[:min_len], right[:min_len]], axis=-1).astype(np.float32)

    main_len = len(full_mix) if full_mix is not None else len(next(iter(stem_buffers.values())))  # type: ignore[arg-type]
    main_dur = main_len / float(sr)

    t_start_raw = op.target_start if op.target_start is not None else (op.start if op.start is not None else 0.0)
    t_end_raw = op.target_end if op.target_end is not None else (
        op.end if op.end is not None else (t_start_raw + len(clip) / float(sr))
    )
    snap = True if op.snap_to_beat is None else bool(op.snap_to_beat)
    t_start, t_end = snap_range_to_beats(t_start_raw, t_end_raw, project.main_track.beats, main_dur, snap)

    ts_idx = int(round(t_start * sr))
    te_idx = int(round(t_end * sr))
    target_len = max(0, min(main_len, te_idx) - ts_idx)
    if target_len <= 0:
        return stem_buffers, full_mix, None

    fitted = np.zeros((target_len, 2), dtype=np.float32)
    copy_len = min(target_len, len(clip))
    fitted[:copy_len] = clip[:copy_len]
    fade_samples = min(int(0.03 * sr), copy_len // 2)
    fitted[:copy_len] *= _cosine_fade_mask(copy_len, fade_samples)

    if op.gain_db is not None:
        gain = 0.0 if op.gain_db <= -60.0 else float(10.0 ** (op.gain_db / 20.0))
        fitted *= gain

    # Duck / mute replaced main stems over [ts_idx, te_idx]
    replace_stems = list(op.replace_main_stems or [])
    duck_mask = _cosine_fade_mask(target_len, min(int(0.03 * sr), target_len // 2))
    if stem_buffers is not None:
        if "full" in replace_stems:
            expanded = list(STEM_NAMES)
        else:
            expanded = [s for s in replace_stems if s in stem_buffers]
        for stem_name in expanded:
            stem_buffers[stem_name][ts_idx : ts_idx + target_len] *= 1.0 - duck_mask
    elif full_mix is not None and replace_stems:
        all_replaced = "full" in replace_stems or set(STEM_NAMES).issubset(set(replace_stems))
        duck_gain = 0.0 if all_replaced else 0.5
        full_mix[ts_idx : ts_idx + target_len] *= 1.0 + duck_mask * (duck_gain - 1.0)

    overlay = np.zeros((main_len, 2), dtype=np.float32)
    overlay[ts_idx : ts_idx + target_len] = fitted
    return stem_buffers, full_mix, overlay


def _apply_single_effect(
    audio: np.ndarray,
    sr: int,
    s_idx: int,
    e_idx: int,
    op: EditOperation,
    bpm: float,
) -> np.ndarray:
    if op.type == "stem_gain":
        return _apply_stem_gain(audio, sr, s_idx, e_idx, op)
    if op.type == "filter_sweep":
        return _apply_filter_sweep(audio, sr, s_idx, e_idx, op)
    if op.type == "reverb_throw":
        return _apply_reverb_throw(audio, sr, s_idx, e_idx, op)
    if op.type == "delay_throw":
        return _apply_delay_throw(audio, sr, s_idx, e_idx, op, bpm)
    if op.type == "lofi_eq":
        return _apply_lofi_eq(audio, sr, s_idx, e_idx, op)
    if op.type == "bass_boost":
        return _apply_bass_boost(audio, sr, s_idx, e_idx, op)
    return audio


def _load_stems_if_ready(store: ProjectStore, project: ProjectState, sr: int) -> dict[str, np.ndarray] | None:
    if project.main_track is None or project.main_track.stems_status != "ready":
        return None
    buffers: dict[str, np.ndarray] = {}
    for stem in STEM_NAMES:
        p = store.main_stem_path(project.id, stem)
        if not p.is_file():
            return None
        data, stem_sr = sf.read(str(p), dtype="float32", always_2d=True)
        stereo = ensure_stereo(data)
        if int(stem_sr) != sr:
            stereo = resample_stereo(stereo, int(stem_sr), sr)
        buffers[stem] = stereo

    max_len = max(len(buf) for buf in buffers.values())
    for stem, buf in buffers.items():
        if len(buf) < max_len:
            padded = np.zeros((max_len, 2), dtype=np.float32)
            padded[: len(buf)] = buf
            buffers[stem] = padded
    return buffers


def render_operations(
    store: ProjectStore,
    project: ProjectState,
    operations: list[EditOperation],
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

    total_samples = len(full_mix) if full_mix is not None else len(next(iter(stem_buffers.values())))  # type: ignore[arg-type]
    duration = total_samples / float(sr)
    beats = project.main_track.beats
    bpm = project.main_track.bpm

    overlays: list[np.ndarray] = []

    for op in operations:
        if op.type == "borrow_stem":
            stem_buffers, full_mix, overlay = _apply_borrow_stem(
                store=store,
                project=project,
                stem_buffers=stem_buffers,
                full_mix=full_mix,
                sr=sr,
                op=op,
            )
            if overlay is not None:
                overlays.append(overlay)
            continue

        snap = True if op.snap_to_beat is None else bool(op.snap_to_beat)
        raw_start = op.start if op.start is not None else 0.0
        raw_end = op.end if op.end is not None else duration
        s_sec, e_sec = snap_range_to_beats(raw_start, raw_end, beats, duration, snap)
        s_idx = int(round(s_sec * sr))
        e_idx = int(round(e_sec * sr))
        if e_idx <= s_idx:
            continue

        if stem_buffers is not None:
            requested = op.stems or list(STEM_NAMES)
            targets = list(STEM_NAMES) if "full" in requested else [s for s in requested if s in stem_buffers]
            if not targets:
                targets = list(STEM_NAMES)
            for stem_name in targets:
                stem_buffers[stem_name] = _apply_single_effect(
                    stem_buffers[stem_name], sr, s_idx, e_idx, op, bpm
                )
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

    return soft_limit(mixed), sr


def collect_enabled_operations(project: ProjectState) -> list[EditOperation]:
    """Flatten all operations from enabled EditBlocks in order."""
    ops: list[EditOperation] = []
    for block in project.edits:
        if block.enabled:
            ops.extend(block.operations)
    return ops


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
        project.id,
        next_version,
        track_id=project.main_track.id,
    )
    store.prune_old_renders(project.id, keep_version=next_version)
    return rendered_path


def render_proposal_preview(
    store: ProjectStore,
    project: ProjectState,
    proposal: EditProposal,
) -> Path:
    """Render a focused preview WAV around `[max(0, start-2), min(duration, end+2)]`."""
    if project.main_track is None:
        raise ValueError("Cannot render proposal preview without a main track.")

    duration = project.main_track.duration
    p_start = round(max(0.0, proposal.start - 2.0), 3)
    p_end = round(min(duration, max(proposal.end, proposal.start + 1.0) + 2.0), 3)
    if p_end <= p_start:
        p_start = 0.0
        p_end = duration

    ops = collect_enabled_operations(project) + list(proposal.operations)
    mixed, sr = render_operations(store, project, ops)

    s_idx = int(round(p_start * sr))
    e_idx = min(len(mixed), int(round(p_end * sr)))
    if e_idx <= s_idx:
        clip = mixed
    else:
        clip = mixed[s_idx:e_idx].copy()

    clip *= _cosine_fade_mask(len(clip), min(int(0.015 * sr), len(clip) // 2))

    preview_path = store.preview_audio_path(project.id, proposal.id)
    preview_path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(preview_path), soft_limit(clip), sr, subtype="PCM_16")

    proposal.preview_start = p_start
    proposal.preview_end = p_end
    proposal.preview_url = store.preview_audio_url(project.id, proposal.id)
    return preview_path


def resolve_rendered_audio_path(store: ProjectStore, project: ProjectState) -> Path | None:
    """Return the active versioned render WAV path, falling back to legacy `rendered.wav` or `main.wav`."""
    if project.render_version > 0:
        versioned = store.rendered_audio_path(project.id, project.render_version)
        if versioned.is_file():
            return versioned
    legacy = store.rendered_audio_path(project.id)
    if legacy.is_file():
        return legacy
    main = store.get_main_audio_path(project.id, project.main_track.id if project.main_track else None)
    if main.is_file():
        return main
    return None


def export_mix(
    store: ProjectStore,
    project: ProjectState,
    fmt: Literal["wav", "mp3"] = "wav",
) -> Path:
    """Export the current rendered mix as downloadable WAV or MP3, pruning stale exports first."""
    if project.main_track is None:
        raise ValueError("Project has no main track to export.")

    src_wav = resolve_rendered_audio_path(store, project)
    if src_wav is None:
        raise FileNotFoundError("Main track audio file is missing on disk.")

    exports_dir = store.exports_dir(project.id)
    exports_dir.mkdir(parents=True, exist_ok=True)
    store.prune_exports(project.id)
    out_path = store.export_file_path(project.id, f"mix_v{project.render_version}.{fmt}")

    if fmt == "wav":
        audio, sr = sf.read(str(src_wav), dtype="float32", always_2d=True)
        sf.write(str(out_path), ensure_stereo(audio), int(sr), subtype="PCM_16")
        return out_path

    # MP3 export: prefer ffmpeg (320 kbps LAME), fallback to soundfile MP3 if supported
    ffmpeg = get_ffmpeg_path()
    if ffmpeg:
        cmd = [
            ffmpeg,
            "-y",
            "-i",
            str(src_wav),
            "-codec:a",
            "libmp3lame",
            "-b:a",
            "320k",
            str(out_path),
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if result.returncode == 0 and out_path.is_file():
            return out_path
        logger.warning("FFmpeg MP3 export failed (%s), trying soundfile fallback.", result.stderr.strip()[:200])

    if "MP3" in sf.available_formats():
        audio, sr = sf.read(str(src_wav), dtype="float32", always_2d=True)
        sf.write(str(out_path), ensure_stereo(audio), int(sr), format="MP3")
        return out_path

    raise RuntimeError("MP3 export requires FFmpeg on PATH (or libsndfile MP3 support).")

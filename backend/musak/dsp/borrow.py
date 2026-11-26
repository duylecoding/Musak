"""Reference stem borrowing with BPM half/double-time matching and key transposition."""

from __future__ import annotations

import logging
import math
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

from musak.audio_analysis import ensure_stereo, resample_stereo, semitone_diff_between_keys
from musak.config import STEM_NAMES
from musak.dsp.utils import _asymmetric_cosine_mask, _cosine_fade_mask, snap_range_to_beats
from musak.models import EditOperation, ProjectState
from musak.storage import ProjectStore

logger = logging.getLogger(__name__)


def compute_effective_borrow_rate(main_bpm: float, ref_bpm: float) -> float:
    """Compute time-stretch rate from `ref_bpm` to `main_bpm` accounting for half/double-time."""
    effective_ref_bpm = min(
        (ref_bpm, ref_bpm * 2.0, ref_bpm / 2.0),
        key=lambda b: abs(main_bpm - b),
    )
    return float(np.clip(main_bpm / effective_ref_bpm, 0.5, 2.0))


def _tile_clip_with_crossfade(clip: np.ndarray, target_len: int, xfade_samples: int) -> np.ndarray:
    """Seamlessly tile `clip` to `target_len` using short cosine crossfades at loop boundaries."""
    clip_len = len(clip)
    if target_len <= 0 or clip_len <= 0:
        return np.zeros((max(0, target_len), 2), dtype=np.float32)
    if target_len <= clip_len:
        return clip[:target_len].astype(np.float32, copy=True)

    xf = min(max(0, xfade_samples), clip_len // 4)
    if xf <= 1:
        repeats = int(math.ceil(target_len / float(clip_len)))
        return np.tile(clip, (repeats, 1))[:target_len].astype(np.float32, copy=False)

    out = np.zeros((target_len, 2), dtype=np.float32)
    first_n = min(clip_len, target_len)
    out[:first_n] = clip[:first_n]
    write_pos = first_n

    t = np.linspace(0.0, math.pi, xf, dtype=np.float32)[:, np.newaxis]
    fade_in = 0.5 * (1.0 - np.cos(t))
    fade_out = 0.5 * (1.0 + np.cos(t))

    while write_pos < target_len:
        seam = write_pos - xf
        ov = min(xf, target_len - seam)
        out[seam : seam + ov] = out[seam : seam + ov] * fade_out[:ov] + clip[:ov] * fade_in[:ov]
        rem = min(clip_len - xf, target_len - write_pos)
        if rem > 0:
            out[write_pos : write_pos + rem] = clip[xf : xf + rem]
            write_pos += rem
        else:
            break
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

    # BPM time-stretching (half/double-time aware so e.g. 140 vs 70 BPM borrows at ~1.0x)
    match_bpm = True if op.match_bpm is None else bool(op.match_bpm)
    if match_bpm and ref.bpm and project.main_track.bpm and ref.bpm > 20.0 and project.main_track.bpm > 20.0:
        rate = compute_effective_borrow_rate(project.main_track.bpm, ref.bpm)
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

    if bool(op.loop_to_fit) and target_len > len(clip) > 0:
        fitted = _tile_clip_with_crossfade(clip, target_len, int(round(0.020 * sr)))
        active_len = target_len
    else:
        fitted = np.zeros((target_len, 2), dtype=np.float32)
        active_len = min(target_len, len(clip))
        fitted[:active_len] = clip[:active_len]

    fi_ms = float(np.clip(op.fade_in_ms if op.fade_in_ms is not None else 30.0, 0.0, 4000.0))
    fo_ms = float(np.clip(op.fade_out_ms if op.fade_out_ms is not None else 30.0, 0.0, 4000.0))
    fitted[:active_len] *= _asymmetric_cosine_mask(
        active_len,
        int(round(fi_ms * sr / 1000.0)),
        int(round(fo_ms * sr / 1000.0)),
    )

    if op.gain_db is not None:
        gain = 0.0 if op.gain_db <= -60.0 else float(10.0 ** (op.gain_db / 20.0))
        fitted *= gain

    # Duck / mute replaced main stems over [ts_idx, te_idx]
    replace_stems = list(op.replace_main_stems or [])
    duck_mask = _cosine_fade_mask(target_len, min(int(0.03 * sr), target_len // 2))
    if stem_buffers is not None:
        expanded = list(STEM_NAMES) if "full" in replace_stems else [s for s in replace_stems if s in stem_buffers]
        for stem_name in expanded:
            stem_buffers[stem_name][ts_idx : ts_idx + target_len] *= 1.0 - duck_mask
    elif full_mix is not None and replace_stems:
        all_replaced = "full" in replace_stems or set(STEM_NAMES).issubset(set(replace_stems))
        duck_gain = 0.0 if all_replaced else 0.5
        full_mix[ts_idx : ts_idx + target_len] *= 1.0 + duck_mask * (duck_gain - 1.0)

    overlay = np.zeros((main_len, 2), dtype=np.float32)
    overlay[ts_idx : ts_idx + target_len] = fitted
    return stem_buffers, full_mix, overlay

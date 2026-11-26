"""Shared DSP constants, beat snapping, crossfades, limiting, and audio slice loading."""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import pedalboard as pb
import soundfile as sf

from musak.audio_analysis import ensure_stereo, resample_stereo
from musak.config import STEM_NAMES
from musak.models import EditOperation, ProjectState
from musak.storage import ProjectStore

ENDPOINT_SNAP_EPSILON = 0.05
MAX_PREVIEW_SECONDS = 20.0


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


def _apply_tail_fade_out(buf: np.ndarray, fade_samples: int) -> None:
    """Apply an in-place cosine fade-out on the last `fade_samples` frames of `buf`."""
    n = min(max(0, fade_samples), len(buf))
    if n > 0:
        ramp = 0.5 * (1.0 + np.cos(np.linspace(0.0, math.pi, n, dtype=np.float32)))[:, np.newaxis]
        buf[-n:] *= ramp


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


def _read_audio_slice(path: Path, clip_start: float, clip_end: float, target_sr: int) -> np.ndarray:
    """Read ONLY `[clip_start, clip_end]` seconds directly from disk via `sf.read(start=..., stop=...)`."""
    info = sf.info(str(path))
    orig_sr = int(info.samplerate) if info.samplerate > 0 else target_sr
    total_frames = int(info.frames)
    if total_frames <= 0:
        return np.zeros((0, 2), dtype=np.float32)

    start_frame = max(0, min(total_frames - 1, int(round(clip_start * orig_sr))))
    stop_frame = min(total_frames, max(start_frame + 1, int(round(clip_end * orig_sr))))
    data, sr = sf.read(
        str(path),
        start=start_frame,
        stop=stop_frame,
        dtype="float32",
        always_2d=True,
    )
    stereo = ensure_stereo(data)
    if int(sr) != target_sr and len(stereo) > 0:
        stereo = resample_stereo(stereo, int(sr), target_sr)
    return stereo


def _load_stems_if_ready(
    store: ProjectStore,
    project: ProjectState,
    sr: int,
    clip_start: float | None = None,
    clip_end: float | None = None,
) -> dict[str, np.ndarray] | None:
    """Load all 4 stem WAVs (full or disk-sliced) if `stems_status == 'ready'`."""
    if project.main_track is None or project.main_track.stems_status != "ready":
        return None
    buffers: dict[str, np.ndarray] = {}
    sliced = clip_start is not None and clip_end is not None
    for stem in STEM_NAMES:
        p = store.main_stem_path(project.id, stem)
        if not p.is_file():
            return None
        if sliced:
            assert clip_start is not None and clip_end is not None
            stereo = _read_audio_slice(p, clip_start, clip_end, sr)
        else:
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


def collect_enabled_operations(project: ProjectState) -> list[EditOperation]:
    """Flatten all operations from enabled EditBlocks in order."""
    ops: list[EditOperation] = []
    for block in project.edits:
        if block.enabled:
            ops.extend(block.operations)
    return ops


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

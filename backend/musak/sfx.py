"""Built-in stereo 44.1 kHz transition SFX synthesizer (fast, deterministic, zero external files)."""

from __future__ import annotations

import math
import os
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import butter, sosfilt

from musak.config import TARGET_SAMPLE_RATE
from musak.models import SfxItem

_SFX_CATALOG: tuple[SfxItem, ...] = (
    SfxItem(
        id="riser_noise",
        name="White Noise Riser",
        category="riser",
        description="Bandpass-swept stereo white noise swell with smooth exponential ramp & crisp tail cut.",
        default_duration=4.0,
        bpm_synced=False,
        preview_url="/api/sfx/riser_noise/preview",
    ),
    SfxItem(
        id="riser_synth",
        name="Synth Tension Riser",
        category="riser",
        description="Detuned pitch-rising stereo saw/sine chord swell.",
        default_duration=4.0,
        bpm_synced=False,
        preview_url="/api/sfx/riser_synth/preview",
    ),
    SfxItem(
        id="sub_impact",
        name="Club Sub Impact",
        category="impact",
        description="Punchy 808 sub pitch dive (110Hz -> 36Hz) + short transient snap + smooth decay.",
        default_duration=2.0,
        bpm_synced=False,
        preview_url="/api/sfx/sub_impact/preview",
    ),
    SfxItem(
        id="reverse_cymbal",
        name="Reverse Cymbal Swell",
        category="transition",
        description="Reversed high-frequency metallic shimmer crescendo.",
        default_duration=2.5,
        bpm_synced=False,
        preview_url="/api/sfx/reverse_cymbal/preview",
    ),
    SfxItem(
        id="snare_roll",
        name="BPM Snare Roll",
        category="drums",
        description="Accelerating snare buildup (quarter -> eighth -> 16th -> 32nd hits synced to BPM) with velocity crescendo.",
        default_duration=4.0,
        bpm_synced=True,
        preview_url="/api/sfx/snare_roll/preview",
    ),
    SfxItem(
        id="tape_stop",
        name="Vinyl Tape Stop",
        category="transition",
        description="Downward pitch-bending warm synth/noise tape brake.",
        default_duration=1.5,
        bpm_synced=False,
        preview_url="/api/sfx/tape_stop/preview",
    ),
)

_SFX_BY_ID: dict[str, SfxItem] = {item.id: item for item in _SFX_CATALOG}
KNOWN_SFX_IDS: frozenset[str] = frozenset(_SFX_BY_ID.keys())


def list_sfx_items() -> list[SfxItem]:
    """Return all built-in transition SFX descriptors."""
    return [item.model_copy() for item in _SFX_CATALOG]


def get_sfx_item(sfx_id: str) -> SfxItem | None:
    """Return the SFX descriptor for `sfx_id`, or None if unknown."""
    item = _SFX_BY_ID.get(sfx_id)
    return item.model_copy() if item is not None else None


def _apply_edge_fades(stereo: np.ndarray, sr: int, fade_in_ms: float = 10.0, fade_out_ms: float = 15.0) -> np.ndarray:
    n = len(stereo)
    if n <= 2:
        return stereo
    out = stereo.astype(np.float32, copy=True)
    fin = min(n // 2, max(1, int(round(fade_in_ms * sr / 1000.0))))
    fout = min(n // 2, max(1, int(round(fade_out_ms * sr / 1000.0))))
    if fin > 0:
        ramp_in = 0.5 * (1.0 - np.cos(np.linspace(0.0, math.pi, fin, dtype=np.float32)))
        out[:fin] *= ramp_in[:, np.newaxis]
    if fout > 0:
        ramp_out = 0.5 * (1.0 + np.cos(np.linspace(0.0, math.pi, fout, dtype=np.float32)))
        out[-fout:] *= ramp_out[:, np.newaxis]
    return out


def _normalize_stereo(stereo: np.ndarray, target_peak: float = 0.78) -> np.ndarray:
    if len(stereo) == 0:
        return stereo.astype(np.float32, copy=False)
    peak = float(np.max(np.abs(stereo)))
    if peak > 1e-6:
        stereo = stereo * (target_peak / peak)
    return np.clip(stereo, -0.98, 0.98).astype(np.float32, copy=False)


def _synth_riser_noise(n: int, sr: int) -> np.ndarray:
    rng = np.random.default_rng(101)
    mid = rng.standard_normal(n).astype(np.float32)
    side = rng.standard_normal(n).astype(np.float32) * 0.35
    noise = np.stack([mid + side, mid - side], axis=-1)

    # Smooth overlap-add bandpass sweep from 260 Hz up to 9200 Hz
    nyq = sr * 0.5
    steps = min(32, max(4, n // 512))
    hop = max(1, n // steps)
    win_len = min(n, hop * 2)
    wet = np.zeros((n, 2), dtype=np.float32)
    norm = np.zeros((n, 1), dtype=np.float32)

    pos = 0
    while pos < n:
        end = min(n, pos + win_len)
        seg_len = end - pos
        frac = (pos + seg_len * 0.5) / max(1, n)
        center_hz = 260.0 * ((9200.0 / 260.0) ** frac)
        lo = float(np.clip(center_hz * 0.55, 60.0, nyq * 0.85))
        hi = float(np.clip(center_hz * 1.65, lo + 80.0, nyq * 0.94))
        sos = butter(2, [lo / nyq, hi / nyq], btype="bandpass", output="sos")
        p_start = max(0, pos - 256)
        filtered = sosfilt(sos, noise[p_start:end], axis=0)[pos - p_start :].astype(np.float32)
        w = np.hanning(max(2, seg_len)).astype(np.float32)[:, np.newaxis]
        wet[pos:end] += filtered * w
        norm[pos:end] += w
        if end >= n:
            break
        pos += hop

    wet /= np.maximum(norm, 1e-6)
    u = np.linspace(0.0, 1.0, n, dtype=np.float32)
    env = ((np.exp(3.8 * u) - 1.0) / (math.exp(3.8) - 1.0))[:, np.newaxis]
    out = _apply_edge_fades(wet * env, sr, fade_in_ms=15.0, fade_out_ms=14.0)
    return _normalize_stereo(out, target_peak=0.75)


def _synth_riser_synth(n: int, sr: int) -> np.ndarray:
    u = np.linspace(0.0, 1.0, n, dtype=np.float64)
    base_freq = 110.0 * (2.0 ** (2.0 * u))

    # Detuned L/R saw-like harmonic stacks + fifth chord shimmer
    left = np.zeros(n, dtype=np.float64)
    right = np.zeros(n, dtype=np.float64)
    voices = (
        (1.0, 0.996, 1.004, 1.0),
        (1.498, 1.003, 0.997, 0.65),
        (2.0, 0.998, 1.002, 0.45),
    )
    for ratio, det_l, det_r, weight in voices:
        phase_l = 2.0 * math.pi * np.cumsum(base_freq * ratio * det_l) / sr
        phase_r = 2.0 * math.pi * np.cumsum(base_freq * ratio * det_r) / sr
        # Band-limited 4-harmonic saw + fundamental sine warmth
        sig_l = np.sin(phase_l)
        sig_r = np.sin(phase_r)
        for harm in range(2, 5):
            sig_l += (0.7 / harm) * np.sin(harm * phase_l)
            sig_r += (0.7 / harm) * np.sin(harm * phase_r)
        left += weight * sig_l
        right += weight * sig_r

    stereo = np.stack([left, right], axis=-1).astype(np.float32)
    env = ((np.exp(3.5 * u.astype(np.float32)) - 1.0) / (math.exp(3.5) - 1.0))[:, np.newaxis]
    out = _apply_edge_fades(stereo * env, sr, fade_in_ms=20.0, fade_out_ms=15.0)
    return _normalize_stereo(out, target_peak=0.75)


def _synth_sub_impact(n: int, sr: int) -> np.ndarray:
    t = np.arange(n, dtype=np.float64) / float(sr)
    dur = max(0.05, n / float(sr))

    # Punchy 808 sub pitch dive 110 Hz -> 36 Hz
    freq = 36.0 + (110.0 - 36.0) * np.exp(-t / 0.065)
    phase = 2.0 * math.pi * np.cumsum(freq) / sr
    sub = np.tanh(1.35 * np.sin(phase)) * np.exp(-t / max(0.28, dur * 0.40))

    # Short transient click + stereo air snap in first ~40ms
    rng = np.random.default_rng(303)
    snap_freq = 1200.0 * np.exp(-t / 0.012) + 180.0
    snap_phase = 2.0 * math.pi * np.cumsum(snap_freq) / sr
    click = np.sin(snap_phase) * np.exp(-t / 0.010) * 0.45

    nyq = sr * 0.5
    sos = butter(2, [800.0 / nyq, min(9500.0, nyq * 0.9) / nyq], btype="bandpass", output="sos")
    noise_snap = sosfilt(sos, rng.standard_normal((n, 2)).astype(np.float32), axis=0)
    noise_env = np.exp(-t / 0.018).astype(np.float32)[:, np.newaxis]

    mono_core = (sub + click).astype(np.float32)[:, np.newaxis]
    stereo = mono_core + 0.32 * noise_snap * noise_env
    out = _apply_edge_fades(stereo, sr, fade_in_ms=3.0, fade_out_ms=25.0)
    return _normalize_stereo(out, target_peak=0.85)


def _synth_reverse_cymbal(n: int, sr: int) -> np.ndarray:
    t = np.arange(n, dtype=np.float64) / float(sr)
    dur = max(0.05, n / float(sr))
    rng = np.random.default_rng(404)

    # Metallic shimmer noise high-passed above 3.5 kHz + inharmonic partials
    nyq = sr * 0.5
    hp_cutoff = min(3500.0, nyq * 0.5) / nyq
    sos = butter(3, hp_cutoff, btype="highpass", output="sos")
    shimmer = sosfilt(sos, rng.standard_normal((n, 2)).astype(np.float32), axis=0)

    partials_l = np.zeros(n, dtype=np.float64)
    partials_r = np.zeros(n, dtype=np.float64)
    for idx, hz in enumerate((3120.0, 4430.0, 5890.0, 7410.0, 9120.0)):
        if hz >= nyq * 0.92:
            continue
        amp = 0.14 / (1.0 + 0.3 * idx)
        partials_l += amp * np.sin(2.0 * math.pi * (hz * 0.998) * t + idx * 0.7)
        partials_r += amp * np.sin(2.0 * math.pi * (hz * 1.002) * t + idx * 1.1)

    forward = shimmer * 0.7 + np.stack([partials_l, partials_r], axis=-1).astype(np.float32)
    decay = (0.45 * np.exp(-t / 0.18) + 0.55 * np.exp(-t / max(0.32, dur * 0.36))).astype(np.float32)
    crashed = forward * decay[:, np.newaxis]
    # Reverse for crescendo swell
    reversed_swell = crashed[::-1].copy()
    out = _apply_edge_fades(reversed_swell, sr, fade_in_ms=20.0, fade_out_ms=12.0)
    return _normalize_stereo(out, target_peak=0.75)


def _build_snare_hit(sr: int) -> np.ndarray:
    hit_len = max(64, int(round(0.14 * sr)))
    t = np.arange(hit_len, dtype=np.float64) / float(sr)
    rng = np.random.default_rng(505)

    # Drum body pitch drop + crisp snare wires
    body_freq = 125.0 + 85.0 * np.exp(-t / 0.018)
    body_phase = 2.0 * math.pi * np.cumsum(body_freq) / sr
    body = (np.sin(body_phase) * np.exp(-t / 0.032)).astype(np.float32)[:, np.newaxis]

    nyq = sr * 0.5
    sos = butter(2, [1200.0 / nyq, min(9500.0, nyq * 0.92) / nyq], btype="bandpass", output="sos")
    wires_noise = sosfilt(sos, rng.standard_normal((hit_len, 2)).astype(np.float32), axis=0)
    wires = wires_noise * np.exp(-t / 0.052).astype(np.float32)[:, np.newaxis]

    hit = 0.65 * body + 0.55 * wires
    return _apply_edge_fades(hit, sr, fade_in_ms=1.5, fade_out_ms=10.0)


def _synth_snare_roll(n: int, sr: int, bpm: float) -> np.ndarray:
    safe_bpm = float(np.clip(bpm if bpm > 0 else 120.0, 40.0, 240.0))
    beat_sec = 60.0 / safe_bpm
    dur = max(0.05, n / float(sr))

    # Quarter -> eighth -> 16th -> 32nd accelerating hits synced to BPM
    hit_times: list[float] = []
    stages = (
        (0.0, 0.25 * dur, beat_sec),
        (0.25 * dur, 0.50 * dur, beat_sec / 2.0),
        (0.50 * dur, 0.75 * dur, beat_sec / 4.0),
        (0.75 * dur, dur, beat_sec / 8.0),
    )
    for stage_start, stage_end, step in stages:
        t_cur = stage_start
        safe_step = max(0.02, step)
        while t_cur < stage_end - 1e-4:
            if not hit_times or (t_cur - hit_times[-1]) >= 0.018:
                hit_times.append(t_cur)
            t_cur += safe_step

    if not hit_times:
        hit_times = [0.0]

    hit_template = _build_snare_hit(sr)
    hit_len = len(hit_template)
    out = np.zeros((n, 2), dtype=np.float32)

    for hit_t in hit_times:
        idx = int(round(hit_t * sr))
        if idx >= n:
            continue
        frac = hit_t / max(dur, 1e-6)
        vel = 0.24 + 0.76 * (frac ** 1.45)
        copy_len = min(hit_len, n - idx)
        out[idx : idx + copy_len] += hit_template[:copy_len] * vel

    out = _apply_edge_fades(out, sr, fade_in_ms=3.0, fade_out_ms=12.0)
    return _normalize_stereo(out, target_peak=0.84)


def _synth_tape_stop(n: int, sr: int) -> np.ndarray:
    u = np.linspace(0.0, 1.0, n, dtype=np.float64)
    speed = np.maximum(0.05, (1.0 - u) ** 1.75)

    left = np.zeros(n, dtype=np.float64)
    right = np.zeros(n, dtype=np.float64)
    for idx, hz in enumerate((220.0, 277.18, 329.63, 440.0)):
        phase_l = 2.0 * math.pi * np.cumsum(hz * 0.997 * speed) / sr
        phase_r = 2.0 * math.pi * np.cumsum(hz * 1.003 * speed) / sr
        w = 0.35 / (1.0 + 0.2 * idx)
        left += w * np.tanh(1.4 * np.sin(phase_l))
        right += w * np.tanh(1.4 * np.sin(phase_r))

    rng = np.random.default_rng(606)
    nyq = sr * 0.5
    sos = butter(2, min(2800.0, nyq * 0.8) / nyq, btype="lowpass", output="sos")
    warm_hiss = sosfilt(sos, rng.standard_normal((n, 2)).astype(np.float32), axis=0) * 0.14
    warm_hiss *= speed.astype(np.float32)[:, np.newaxis]

    chord = np.stack([left, right], axis=-1).astype(np.float32) + warm_hiss
    env = (1.0 - (u ** 3.0)).astype(np.float32)[:, np.newaxis]
    out = _apply_edge_fades(chord * env, sr, fade_in_ms=8.0, fade_out_ms=15.0)
    return _normalize_stereo(out, target_peak=0.78)


def synthesize_sfx(
    sfx_id: str,
    duration: float,
    sr: int = TARGET_SAMPLE_RATE,
    bpm: float = 120.0,
) -> np.ndarray:
    """Synthesize a stereo float32 SFX clip of `duration` seconds at sample rate `sr`."""
    if sfx_id not in _SFX_BY_ID:
        raise ValueError(f"Unknown SFX id '{sfx_id}'.")

    safe_sr = max(8000, int(sr))
    safe_dur = float(duration)
    if safe_dur <= 0.0:
        return np.zeros((0, 2), dtype=np.float32)
    safe_dur = min(30.0, max(0.05, safe_dur))
    n = max(1, int(round(safe_dur * safe_sr)))

    if sfx_id == "riser_noise":
        return _synth_riser_noise(n, safe_sr)
    if sfx_id == "riser_synth":
        return _synth_riser_synth(n, safe_sr)
    if sfx_id == "sub_impact":
        return _synth_sub_impact(n, safe_sr)
    if sfx_id == "reverse_cymbal":
        return _synth_reverse_cymbal(n, safe_sr)
    if sfx_id == "snare_roll":
        return _synth_snare_roll(n, safe_sr, bpm=bpm)
    if sfx_id == "tape_stop":
        return _synth_tape_stop(n, safe_sr)
    raise ValueError(f"Unknown SFX id '{sfx_id}'.")


def render_sfx_preview_wav(
    sfx_id: str,
    cache_dir: Path,
    bpm: float = 120.0,
    duration: float | None = None,
) -> Path:
    """Render (and cache atomically) a stereo 44.1 kHz preview WAV for `sfx_id`."""
    item = get_sfx_item(sfx_id)
    if item is None:
        raise ValueError(f"Unknown SFX id '{sfx_id}'.")

    safe_bpm = round(float(np.clip(bpm if bpm > 0 else 120.0, 40.0, 240.0)), 1)
    raw_dur = duration if (duration is not None and duration > 0.0) else item.default_duration
    safe_dur = round(float(np.clip(raw_dur, 0.25, 16.0)), 2)

    cache_dir.mkdir(parents=True, exist_ok=True)
    bpm_tag = f"{safe_bpm:.1f}".replace(".", "_")
    dur_tag = f"{safe_dur:.2f}".replace(".", "_")
    target_path = cache_dir / f"{sfx_id}_bpm{bpm_tag}_d{dur_tag}.wav"
    if target_path.is_file():
        return target_path

    audio = synthesize_sfx(sfx_id, duration=safe_dur, sr=TARGET_SAMPLE_RATE, bpm=safe_bpm)
    fd, tmp_name = tempfile.mkstemp(prefix=".sfx_", suffix=".wav", dir=str(cache_dir))
    os.close(fd)
    tmp_path = Path(tmp_name)
    try:
        sf.write(str(tmp_path), audio, TARGET_SAMPLE_RATE, subtype="PCM_16")
        os.replace(tmp_path, target_path)
    except Exception:
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise
    return target_path

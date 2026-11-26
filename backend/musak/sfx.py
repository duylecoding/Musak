"""Built-in stereo 44.1 kHz transition SFX catalog, synthesis dispatcher, and WAV preview cache."""

from __future__ import annotations

import os
import re
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

from musak.config import TARGET_SAMPLE_RATE
from musak.models import SfxItem
from musak.sfx_classic import (
    _synth_reverse_cymbal,
    _synth_riser_noise,
    _synth_riser_synth,
    _synth_snare_roll,
    _synth_sub_impact,
    _synth_tape_stop,
)
from musak.sfx_melodic import _synth_ambient_pad, _synth_supersaw_swell

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
    SfxItem(
        id="supersaw_swell",
        name="Supersaw Chord Swell",
        category="riser",
        description="Key-locked 7-voice detuned stereo supersaw triad+7th chord with rising low-pass sweep & lush tail.",
        default_duration=4.0,
        bpm_synced=True,
        preview_url="/api/sfx/supersaw_swell/preview",
    ),
    SfxItem(
        id="ambient_pad",
        name="Ambient Chord Pad",
        category="transition",
        description="Warm key-locked stereo sine+triangle chord pad with gentle slow modulation & soft attack/release.",
        default_duration=8.0,
        bpm_synced=False,
        preview_url="/api/sfx/ambient_pad/preview",
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


def synthesize_sfx(
    sfx_id: str,
    duration: float,
    sr: int = TARGET_SAMPLE_RATE,
    bpm: float = 120.0,
    musical_key: str | None = None,
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
    if sfx_id == "supersaw_swell":
        return _synth_supersaw_swell(n, safe_sr, bpm=bpm, musical_key=musical_key)
    if sfx_id == "ambient_pad":
        return _synth_ambient_pad(n, safe_sr, musical_key=musical_key)
    raise ValueError(f"Unknown SFX id '{sfx_id}'.")


def _safe_key_tag(musical_key: str | None) -> str:
    if not musical_key or not musical_key.strip():
        return "default"
    normalized = musical_key.strip().lower().replace("#", "sharp")
    cleaned = re.sub(r"[^a-z0-9]+", "_", normalized).strip("_")
    return cleaned[:24] or "default"


def render_sfx_preview_wav(
    sfx_id: str,
    cache_dir: Path,
    bpm: float = 120.0,
    duration: float | None = None,
    musical_key: str | None = None,
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
    key_tag = _safe_key_tag(musical_key) if sfx_id in ("supersaw_swell", "ambient_pad") else "na"
    target_path = cache_dir / f"{sfx_id}_bpm{bpm_tag}_d{dur_tag}_k{key_tag}.wav"
    if target_path.is_file():
        return target_path

    audio = synthesize_sfx(
        sfx_id, duration=safe_dur, sr=TARGET_SAMPLE_RATE, bpm=safe_bpm, musical_key=musical_key
    )
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

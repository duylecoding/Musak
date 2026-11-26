"""Shared pytest fixtures and synthetic stereo audio generators (no network calls)."""

from __future__ import annotations

import io
import sys
from pathlib import Path

_BACKEND_DIR = str(Path(__file__).resolve().parents[1])
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from musak.config import clear_api_key
from musak.main import app


def make_synthetic_track(
    duration: float = 8.0,
    sr: int = 44100,
    bpm: float = 120.0,
    root_hz: float = 261.63,  # C4 (C Major)
    minor: bool = False,
    varying_energy: bool = True,
) -> np.ndarray:
    """Generate a clean synthetic musical stereo track (kick pulses + chord harmonics)."""
    n_samples = int(round(duration * sr))
    t = np.arange(n_samples, dtype=np.float32) / float(sr)

    # Chord triad (major or minor)
    third_ratio = 2.0 ** (3.0 / 12.0) if minor else 2.0 ** (4.0 / 12.0)
    fifth_ratio = 2.0 ** (7.0 / 12.0)

    pad = (
        0.22 * np.sin(2.0 * np.pi * root_hz * t)
        + 0.16 * np.sin(2.0 * np.pi * (root_hz * third_ratio) * t)
        + 0.14 * np.sin(2.0 * np.pi * (root_hz * fifth_ratio) * t)
        + 0.10 * np.sin(2.0 * np.pi * (root_hz * 0.5) * t)
    )

    # Periodic kick-like pulses at exact BPM intervals
    beat_period = 60.0 / bpm
    kick = np.zeros(n_samples, dtype=np.float32)
    beat_t = 0.0
    while beat_t < duration:
        idx = int(round(beat_t * sr))
        pulse_len = min(int(0.12 * sr), n_samples - idx)
        if pulse_len > 0:
            pt = np.arange(pulse_len, dtype=np.float32) / float(sr)
            freq = 120.0 * np.exp(-pt * 18.0) + 45.0
            phase = 2.0 * np.pi * np.cumsum(freq) / float(sr)
            env = np.exp(-pt * 24.0)
            kick[idx : idx + pulse_len] += 0.35 * np.sin(phase) * env
        beat_t += beat_period

    if varying_energy:
        # Quiet intro, medium verse, louder chorus/drop, softer outro
        env = np.ones(n_samples, dtype=np.float32)
        q = n_samples // 4
        env[:q] = 0.35
        env[q : 2 * q] = 0.65
        env[2 * q : 3 * q] = 1.0
        env[3 * q :] = 0.45
        mono = (pad + kick) * env
    else:
        mono = pad + kick

    left = mono.astype(np.float32)
    right = (mono * 0.96).astype(np.float32)
    stereo = np.stack([left, right], axis=-1)
    peak = float(np.max(np.abs(stereo)))
    if peak > 0.85:
        stereo = stereo * (0.85 / peak)
    return stereo


def wav_bytes_from_array(audio: np.ndarray, sr: int = 44100) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, audio, sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


@pytest.fixture()
def data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    d = tmp_path / "musak_projects"
    d.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("MUSAK_DATA_DIR", str(d))
    clear_api_key()
    yield d
    clear_api_key()


@pytest.fixture()
def client(data_dir: Path) -> TestClient:
    return TestClient(app)

"""Audio loading/decoding, BPM & beat tracking, key detection, and section segmentation."""

from __future__ import annotations

import logging
import math
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

from musak.config import TARGET_SAMPLE_RATE, get_ffmpeg_path
from musak.models import Section

logger = logging.getLogger(__name__)

# Krumhansl-Schmuckler key profiles
_MAJOR_PROFILE = np.array(
    [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
    dtype=np.float64,
)
_MINOR_PROFILE = np.array(
    [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
    dtype=np.float64,
)
_PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
_ENHARMONIC_MAP: dict[str, int] = {
    "C": 0,
    "B#": 0,
    "C#": 1,
    "DB": 1,
    "D": 2,
    "D#": 3,
    "EB": 3,
    "E": 4,
    "FB": 4,
    "F": 5,
    "E#": 5,
    "F#": 6,
    "GB": 6,
    "G": 7,
    "G#": 8,
    "AB": 8,
    "A": 9,
    "A#": 10,
    "BB": 10,
    "B": 11,
    "CB": 11,
}


@dataclass(frozen=True)
class AudioAnalysis:
    duration: float
    sample_rate: int
    bpm: float
    key: str
    beats: list[float]
    sections: list[Section]


def ensure_stereo(audio: np.ndarray) -> np.ndarray:
    """Convert mono, stereo, or multi-channel audio array to `(samples, 2)` float32."""
    arr = np.asarray(audio, dtype=np.float32)
    if arr.ndim == 1:
        return np.stack([arr, arr], axis=-1)
    if arr.shape[1] == 1:
        return np.repeat(arr, 2, axis=1)
    if arr.shape[1] == 2:
        return arr
    # Downmix extra channels gently to stereo
    left = np.mean(arr[:, 0::2], axis=1)
    right = np.mean(arr[:, 1::2], axis=1)
    return np.stack([left, right], axis=-1).astype(np.float32)


def resample_stereo(audio: np.ndarray, orig_sr: int, target_sr: int = TARGET_SAMPLE_RATE) -> np.ndarray:
    """Resample `(samples, 2)` float32 audio cleanly to `target_sr`."""
    if orig_sr == target_sr or len(audio) == 0:
        return audio.astype(np.float32, copy=False)
    gcd = math.gcd(orig_sr, target_sr)
    up = target_sr // gcd
    down = orig_sr // gcd
    resampled = resample_poly(audio, up=up, down=down, axis=0)
    return resampled.astype(np.float32, copy=False)


def _decode_with_ffmpeg(src_path: Path, target_sr: int) -> tuple[np.ndarray, int]:
    ffmpeg = get_ffmpeg_path()
    if not ffmpeg:
        raise RuntimeError(
            "FFmpeg is required to decode this audio format (e.g. M4A/AAC) but was not found on PATH."
        )
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp_wav = Path(tmp.name)
    try:
        cmd = [
            ffmpeg,
            "-y",
            "-i",
            str(src_path),
            "-ac",
            "2",
            "-ar",
            str(target_sr),
            "-c:a",
            "pcm_f32le",
            str(tmp_wav),
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if result.returncode != 0:
            raise RuntimeError(f"FFmpeg decode failed: {result.stderr.strip()[:400]}")
        data, sr = sf.read(str(tmp_wav), dtype="float32", always_2d=True)
        return data, int(sr)
    finally:
        tmp_wav.unlink(missing_ok=True)


def _decode_with_pedalboard(src_path: Path) -> tuple[np.ndarray, int]:
    from pedalboard.io import AudioFile

    with AudioFile(str(src_path)) as af:
        data = af.read(af.frames)
        sr = int(af.samplerate)
    # pedalboard returns (channels, frames) -> transpose to (frames, channels)
    return data.T.astype(np.float32, copy=False), sr


def load_audio_to_stereo_wav(
    src_path: Path,
    dst_wav_path: Path,
    target_sr: int = TARGET_SAMPLE_RATE,
) -> tuple[np.ndarray, int]:
    """Decode an uploaded/local audio file and store as stereo 44.1 kHz WAV."""
    data: np.ndarray | None = None
    sr: int = target_sr
    errors: list[str] = []

    try:
        data, sr = sf.read(str(src_path), dtype="float32", always_2d=True)
    except Exception as exc:
        errors.append(f"soundfile: {exc}")

    if data is None:
        try:
            data, sr = _decode_with_ffmpeg(src_path, target_sr)
        except Exception as exc:
            errors.append(f"ffmpeg: {exc}")

    if data is None:
        try:
            data, sr = _decode_with_pedalboard(src_path)
        except Exception as exc:
            errors.append(f"pedalboard: {exc}")

    if data is None or len(data) == 0:
        raise ValueError(f"Unsupported or unreadable audio file '{src_path.name}'. ({'; '.join(errors)})")

    stereo = ensure_stereo(data)
    stereo = np.nan_to_num(stereo, nan=0.0, posinf=1.0, neginf=-1.0)
    stereo = resample_stereo(stereo, int(sr), target_sr)

    peak = float(np.max(np.abs(stereo))) if stereo.size else 0.0
    if peak > 1.0:
        stereo = stereo / peak

    dst_wav_path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(dst_wav_path), stereo, target_sr, subtype="PCM_16")
    return stereo, target_sr


def detect_key(y_mono: np.ndarray, sr: int) -> str:
    """Estimate musical key using Krumhansl-Schmuckler major/minor chroma correlation."""
    if y_mono.size < 256 or float(np.max(np.abs(y_mono))) < 1e-6:
        return "C Major"

    n_fft = min(4096, max(256, 1 << (int(len(y_mono)).bit_length() - 1)))
    chroma = librosa.feature.chroma_stft(y=y_mono, sr=sr, n_fft=n_fft)
    chroma_mean = np.mean(chroma, axis=1).astype(np.float64)
    if float(np.std(chroma_mean)) < 1e-8:
        return "C Major"

    best_score = -2.0
    best_key = "C Major"

    for tonic in range(12):
        maj_rot = np.roll(_MAJOR_PROFILE, tonic)
        min_rot = np.roll(_MINOR_PROFILE, tonic)
        maj_corr = float(np.corrcoef(chroma_mean, maj_rot)[0, 1])
        min_corr = float(np.corrcoef(chroma_mean, min_rot)[0, 1])
        if not math.isnan(maj_corr) and maj_corr > best_score:
            best_score = maj_corr
            best_key = f"{_PITCH_CLASSES[tonic]} Major"
        if not math.isnan(min_corr) and min_corr > best_score:
            best_score = min_corr
            best_key = f"{_PITCH_CLASSES[tonic]} Minor"

    return best_key


def parse_key(key_str: str | None) -> tuple[int, str] | None:
    """Parse a key string such as `'A Minor'` or `'F# Major'` into `(pitch_class, mode)`."""
    if not key_str:
        return None
    parts = key_str.strip().split()
    if not parts:
        return None
    note = parts[0].upper()
    if note not in _ENHARMONIC_MAP:
        return None
    mode = "minor" if len(parts) > 1 and parts[1].lower().startswith("min") else "major"
    return _ENHARMONIC_MAP[note], mode


def semitone_diff_between_keys(src_key: str | None, dst_key: str | None) -> int:
    """Compute shortest semitone shift in `[-6, +6]` from `src_key` to `dst_key`."""
    src = parse_key(src_key)
    dst = parse_key(dst_key)
    if src is None or dst is None:
        return 0
    src_pc, src_mode = src
    dst_pc, dst_mode = dst
    # Align to relative major pitch class when modes differ so harmony matches musically
    effective_src = (src_pc + 3) % 12 if src_mode == "minor" else src_pc
    effective_dst = (dst_pc + 3) % 12 if dst_mode == "minor" else dst_pc
    diff = (effective_dst - effective_src) % 12
    if diff > 6:
        diff -= 12
    return int(diff)


def detect_bpm_and_beats(y_mono: np.ndarray, sr: int, duration: float) -> tuple[float, list[float]]:
    """Detect BPM and beat timestamps in seconds."""
    if duration <= 0.1 or float(np.max(np.abs(y_mono))) < 1e-6:
        return 120.0, []

    try:
        tempo, beat_times = librosa.beat.beat_track(y=y_mono, sr=sr, units="time")
        tempo_arr = np.asarray(tempo, dtype=np.float64).reshape(-1)
        bpm = float(tempo_arr[0]) if tempo_arr.size > 0 else 120.0
        beats = [round(float(t), 3) for t in np.asarray(beat_times, dtype=np.float64).reshape(-1) if 0.0 <= t <= duration]
    except Exception as exc:
        logger.warning("Beat tracking failed, using fallback tempo: %s", exc)
        bpm = 120.0
        beats = []

    if math.isnan(bpm) or bpm < 40.0 or bpm > 240.0:
        bpm = 120.0

    # If librosa detected no beats (e.g. steady drone/pad), synthesize a clean beat grid
    if not beats and duration >= 0.5:
        step = 60.0 / bpm
        t = 0.0
        while t < duration:
            beats.append(round(t, 3))
            t += step

    return round(bpm, 1), beats


def detect_sections(y_mono: np.ndarray, sr: int, duration: float, beats: list[float]) -> list[Section]:
    """Segment track into contiguous energy-based musical sections covering `[0, duration]`."""
    dur = round(float(duration), 3)
    if dur <= 0.0:
        return []
    if dur < 6.0:
        rms = float(np.sqrt(np.mean(y_mono**2))) if y_mono.size else 0.0
        energy = round(min(1.0, rms * 3.0), 3)
        return [Section(label="Main", start=0.0, end=dur, energy=energy)]

    hop_length = 2048
    rms_frames = librosa.feature.rms(y=y_mono, frame_length=4096, hop_length=hop_length)[0]
    times = librosa.frames_to_time(np.arange(len(rms_frames)), sr=sr, hop_length=hop_length)

    if len(rms_frames) < 4:
        return [Section(label="Main", start=0.0, end=dur, energy=0.5)]

    # Decide number of sections adaptively based on song duration
    if dur < 16.0:
        target_sections = 3
    elif dur < 45.0:
        target_sections = 4
    elif dur < 120.0:
        target_sections = 6
    else:
        target_sections = 8

    # Smooth RMS to locate natural energy shifts
    win = max(3, len(rms_frames) // (target_sections * 4))
    kernel = np.ones(win, dtype=np.float64) / win
    smooth = np.convolve(rms_frames.astype(np.float64), kernel, mode="same")
    diff = np.abs(np.gradient(smooth))

    # Pick boundary candidates near evenly spaced musical intervals with highest local energy change
    boundaries: list[float] = [0.0]
    min_gap = dur / (target_sections * 1.8)
    for idx in range(1, target_sections):
        center_t = (dur * idx) / target_sections
        low_t = max(boundaries[-1] + min_gap, center_t - dur / (target_sections * 2.5))
        high_t = min(dur - min_gap, center_t + dur / (target_sections * 2.5))
        if low_t >= high_t:
            cand_t = center_t
        else:
            mask = (times >= low_t) & (times <= high_t)
            if np.any(mask):
                local_indices = np.where(mask)[0]
                best_i = local_indices[int(np.argmax(diff[local_indices]))]
                cand_t = float(times[best_i])
            else:
                cand_t = center_t

        # Snap boundary to nearest beat when available
        if beats:
            nearest = min(beats, key=lambda b: abs(b - cand_t))
            if boundaries[-1] + 0.5 < nearest < dur - 0.5:
                cand_t = nearest

        cand_t = round(cand_t, 3)
        if cand_t > boundaries[-1] + 0.25 and cand_t < dur - 0.25:
            boundaries.append(cand_t)

    boundaries.append(dur)

    # Compute normalized energy per section
    raw_energies: list[float] = []
    for s, e in zip(boundaries[:-1], boundaries[1:]):
        mask = (times >= s) & (times <= e)
        val = float(np.mean(rms_frames[mask])) if np.any(mask) else 0.0
        raw_energies.append(val)

    max_e = max(raw_energies) if raw_energies else 1.0
    if max_e <= 1e-8:
        norm_energies = [0.1 for _ in raw_energies]
    else:
        norm_energies = [round(min(1.0, max(0.0, e / max_e)), 3) for e in raw_energies]

    # Assign intuitive musical section labels
    n = len(norm_energies)
    labels: list[str] = []
    peak_idx = int(np.argmax(norm_energies)) if n else 0

    for i, energy in enumerate(norm_energies):
        if i == 0 and n >= 3:
            labels.append("Intro" if energy < 0.85 else "Verse")
        elif i == n - 1 and n >= 3:
            labels.append("Outro" if energy < 0.85 else "Chorus")
        elif i == peak_idx:
            labels.append("Drop" if (i > 0 and energy - norm_energies[i - 1] >= 0.15) else "Chorus")
        elif i + 1 < n and norm_energies[i + 1] - energy >= 0.15 and norm_energies[i + 1] >= 0.75:
            labels.append("Buildup")
        elif energy >= 0.8:
            labels.append("Chorus")
        else:
            labels.append("Verse")

    sections: list[Section] = []
    for idx in range(n):
        sections.append(
            Section(
                label=labels[idx],
                start=round(boundaries[idx], 3),
                end=round(boundaries[idx + 1], 3),
                energy=norm_energies[idx],
            )
        )
    return sections


def analyze_audio(audio: np.ndarray, sr: int = TARGET_SAMPLE_RATE) -> AudioAnalysis:
    """Run full audio analysis (duration, BPM, beats, musical key, energy sections)."""
    stereo = ensure_stereo(audio)
    duration = round(len(stereo) / float(sr), 3) if sr > 0 else 0.0
    y_mono = np.mean(stereo, axis=1).astype(np.float32)

    bpm, beats = detect_bpm_and_beats(y_mono, sr, duration)
    key = detect_key(y_mono, sr)
    sections = detect_sections(y_mono, sr, duration, beats)

    return AudioAnalysis(
        duration=duration,
        sample_rate=sr,
        bpm=bpm,
        key=key,
        beats=beats,
        sections=sections,
    )

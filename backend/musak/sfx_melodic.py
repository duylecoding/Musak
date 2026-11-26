"""Key-synced melodic synth SFX generators: 7-voice supersaw chord swell & ambient pad."""

from __future__ import annotations

import math

import numpy as np
from scipy.signal import butter, sosfilt

from musak.audio_analysis import parse_key
from musak.sfx_classic import _apply_edge_fades, _normalize_stereo


def _resolve_chord_frequencies(musical_key: str | None) -> tuple[list[float], str]:
    """Parse `musical_key` (defaulting to `'A Minor'`) into triad+7th chord frequencies in Hz."""
    parsed = parse_key(musical_key)
    if parsed is None and musical_key:
        compact = musical_key.strip()
        if compact.lower().endswith("m") and len(compact) >= 2:
            parsed = parse_key(f"{compact[:-1]} Minor")
        else:
            parsed = parse_key(f"{compact} Major")
    pc, mode = parsed if parsed is not None else (9, "minor")
    # Place tonic cleanly in warm midrange (A2=110 Hz .. G#3=207.65 Hz)
    root_midi = 45 + ((pc - 9) % 12)
    intervals = (0, 3, 7, 10) if mode == "minor" else (0, 4, 7, 11)
    freqs = [440.0 * (2.0 ** (((root_midi + semi) - 69) / 12.0)) for semi in intervals]
    return freqs, mode


def _synth_supersaw_swell(
    n: int,
    sr: int,
    bpm: float = 120.0,
    musical_key: str | None = None,
) -> np.ndarray:
    """7-voice detuned stereo supersaw triad+7th chord with rising low-pass sweep & lush tail."""
    chord_freqs, _ = _resolve_chord_frequencies(musical_key)
    t = np.arange(n, dtype=np.float64) / float(sr)
    u = np.linspace(0.0, 1.0, n, dtype=np.float64)
    safe_bpm = float(np.clip(bpm if bpm > 0 else 120.0, 40.0, 240.0))

    # 7 detune voices (cents) spread wide across L/R
    detune_cents = (-24.0, -14.0, -6.0, 0.0, 6.0, 14.0, 24.0)
    pan_left = (0.88, 0.30, 0.72, 0.55, 0.28, 0.70, 0.12)
    voice_weights = (0.55, 0.75, 0.90, 1.00, 0.90, 0.75, 0.55)
    note_weights = (1.0, 0.85, 0.80, 0.70)

    # Band-limited warm additive sawtooth (harmonics 1..8) so there is zero harsh aliasing
    left = np.zeros(n, dtype=np.float64)
    right = np.zeros(n, dtype=np.float64)
    for note_idx, base_hz in enumerate(chord_freqs):
        nw = note_weights[note_idx]
        for v_idx, cents in enumerate(detune_cents):
            freq = base_hz * (2.0 ** (cents / 1200.0))
            base_phase = 2.0 * math.pi * freq * t + (note_idx * 1.1 + v_idx * 0.77)
            saw = np.zeros(n, dtype=np.float64)
            for h in range(1, 9):
                if freq * h < sr * 0.42:
                    saw += (1.0 / float(h)) * np.sin(h * base_phase)
            saw *= 0.62
            w = nw * voice_weights[v_idx]
            pl = pan_left[v_idx]
            left += saw * (w * pl)
            right += saw * (w * (1.0 - pl))

    raw = np.stack([left, right], axis=-1).astype(np.float32)

    # Warm analog low-pass filter sweep (240 Hz -> 4800 Hz) via overlap-add
    nyq = sr * 0.5
    steps = min(28, max(4, n // 512))
    hop = max(1, n // steps)
    win_len = min(n, hop * 2)
    swept = np.zeros((n, 2), dtype=np.float32)
    norm = np.zeros((n, 1), dtype=np.float32)

    pos = 0
    while pos < n:
        end = min(n, pos + win_len)
        seg_len = end - pos
        frac = (pos + seg_len * 0.5) / max(1, n)
        cutoff = float(np.clip(240.0 * ((4800.0 / 240.0) ** (frac ** 0.9)), 80.0, nyq * 0.90))
        sos = butter(2, cutoff / nyq, btype="lowpass", output="sos")
        p_start = max(0, pos - 256)
        filtered = sosfilt(sos, raw[p_start:end], axis=0)[pos - p_start :].astype(np.float32)
        w = np.hanning(max(2, seg_len)).astype(np.float32)[:, np.newaxis]
        swept[pos:end] += filtered * w
        norm[pos:end] += w
        if end >= n:
            break
        pos += hop

    swept /= np.maximum(norm, 1e-6)

    # Exponential swell envelope + BPM-synced subtle rhythmic shimmer + lush release tail
    beat_hz = safe_bpm / 60.0
    shimmer = (0.90 + 0.10 * np.sin(2.0 * math.pi * (beat_hz * 2.0) * t)).astype(np.float32)
    swell = (0.28 + 0.72 * ((np.exp(2.8 * u) - 1.0) / (math.exp(2.8) - 1.0))).astype(np.float32)
    tail_frac = 0.85
    tail = np.where(u > tail_frac, np.cos(0.5 * math.pi * ((u - tail_frac) / (1.0 - tail_frac))), 1.0).astype(
        np.float32
    )
    env = (swell * shimmer * tail)[:, np.newaxis]

    out = _apply_edge_fades(swept * env, sr, fade_in_ms=20.0, fade_out_ms=60.0)
    return _normalize_stereo(out, target_peak=0.78)


def _synth_ambient_pad(
    n: int,
    sr: int,
    musical_key: str | None = None,
) -> np.ndarray:
    """Warm stereo sine+triangle lush chord pad tuned to `musical_key` with slow modulation."""
    chord_freqs, _ = _resolve_chord_frequencies(musical_key)
    pad_freqs = chord_freqs + [chord_freqs[2] * 2.0]  # add airy octave-up fifth
    t = np.arange(n, dtype=np.float64) / float(sr)
    dur = max(0.05, n / float(sr))

    left = np.zeros(n, dtype=np.float64)
    right = np.zeros(n, dtype=np.float64)
    weights = (1.0, 0.82, 0.78, 0.65, 0.38)

    for idx, base_hz in enumerate(pad_freqs):
        w = weights[idx]
        p_l = 2.0 * math.pi * (base_hz * 0.998) * t + idx * 0.45
        p_r = 2.0 * math.pi * (base_hz * 1.002) * t + idx * 0.85
        # Warm sine + soft band-limited triangle (fundamental + 3rd harmonic)
        tri_l = np.sin(p_l) - (1.0 / 9.0) * np.sin(3.0 * p_l)
        tri_r = np.sin(p_r) - (1.0 / 9.0) * np.sin(3.0 * p_r)
        left += w * (0.65 * np.sin(p_l) + 0.35 * tri_l)
        right += w * (0.65 * np.sin(p_r) + 0.35 * tri_r)

    # Gentle slow stereo movement LFOs
    lfo_l = 0.88 + 0.12 * np.sin(2.0 * math.pi * 0.23 * t)
    lfo_r = 0.88 + 0.12 * np.sin(2.0 * math.pi * 0.31 * t + 1.1)
    stereo = np.stack([left * lfo_l, right * lfo_r], axis=-1).astype(np.float32)

    att_ms = min(350.0, dur * 220.0)
    rel_ms = min(600.0, dur * 280.0)
    out = _apply_edge_fades(stereo, sr, fade_in_ms=att_ms, fade_out_ms=rel_ms)
    return _normalize_stereo(out, target_peak=0.72)

"""Gemini compact WAV audio clip slicer and `generate_content` wrapper."""

from __future__ import annotations

import io
import logging
import math
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf
from google.genai import types
from scipy.signal import resample_poly

logger = logging.getLogger(__name__)


def create_compact_wav_clip(
    audio_path: Path,
    start: float | None = None,
    end: float | None = None,
    max_seconds: float = 30.0,
    target_sr: int = 16000,
) -> bytes:
    """Slice, downmix to mono, downsample, and encode as compact WAV bytes."""
    info = sf.info(str(audio_path))
    orig_sr = int(info.samplerate)
    total_frames = int(info.frames)
    if total_frames <= 0 or orig_sr <= 0:
        raise ValueError(f"Audio file '{audio_path.name}' contains no frames.")

    total_dur = total_frames / float(orig_sr)
    s_sec = max(0.0, min(float(start if start is not None else 0.0), total_dur))
    e_sec = min(total_dur, s_sec + max_seconds) if end is None else max(s_sec, min(float(end), total_dur))

    if e_sec - s_sec > max_seconds:
        mid = 0.5 * (s_sec + e_sec)
        s_sec = max(0.0, mid - max_seconds * 0.5)
        e_sec = min(total_dur, s_sec + max_seconds)
    if e_sec <= s_sec and total_dur > 0:
        s_sec = max(0.0, total_dur - min(total_dur, max_seconds))
        e_sec = total_dur

    start_frame = min(max(0, total_frames - 1), max(0, int(round(s_sec * orig_sr))))
    stop_frame = min(total_frames, max(start_frame + 1, int(round(e_sec * orig_sr))))
    data, sr = sf.read(str(audio_path), start=start_frame, stop=stop_frame, dtype="float32", always_2d=True)
    mono = np.mean(data, axis=1).astype(np.float32)

    if int(sr) != target_sr and len(mono) > 0:
        gcd = math.gcd(int(sr), target_sr)
        mono = resample_poly(mono, up=target_sr // gcd, down=int(sr) // gcd).astype(np.float32)

    mono = np.clip(np.nan_to_num(mono, nan=0.0), -1.0, 1.0)
    buf = io.BytesIO()
    sf.write(buf, mono, target_sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def _generate_content(
    client: Any,
    model: str,
    contents: Any,
    response_mime_type: str | None = None,
    temperature: float = 0.4,
    max_output_tokens: int = 600,
) -> Any:
    """Invoke `client.models.generate_content` with MINIMAL thinking and tight output caps."""
    cfg_kwargs: dict[str, Any] = {"temperature": temperature, "max_output_tokens": max_output_tokens}
    if response_mime_type:
        cfg_kwargs["response_mime_type"] = response_mime_type

    thinking_cfg = None
    if hasattr(types, "ThinkingConfig") and hasattr(types, "ThinkingLevel"):
        thinking_cfg = types.ThinkingConfig(thinking_level=types.ThinkingLevel.MINIMAL)

    if thinking_cfg is not None:
        try:
            return client.models.generate_content(
                model=model,
                contents=contents,
                config=types.GenerateContentConfig(**cfg_kwargs, thinking_config=thinking_cfg),
            )
        except Exception as exc:
            err_lower = str(exc).lower()
            if any(tok in err_lower for tok in ("thinking", "invalid_argument", "unsupported", "400")):
                logger.info("Retrying generate_content without thinking_config for model %s: %s", model, exc)
            else:
                raise

    return client.models.generate_content(model=model, contents=contents, config=types.GenerateContentConfig(**cfg_kwargs))

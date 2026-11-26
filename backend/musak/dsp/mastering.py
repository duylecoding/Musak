"""Mastering presets and multi-target WAV/MP3/ZIP export helpers."""

from __future__ import annotations

import io
import logging
import os
import subprocess
import tempfile
import zipfile
from pathlib import Path
from typing import Literal

import numpy as np
import pedalboard as pb
import soundfile as sf

from musak.audio_analysis import ensure_stereo, resample_stereo
from musak.config import STEM_NAMES, TARGET_SAMPLE_RATE, get_ffmpeg_path
from musak.dsp.utils import _run_pedalboard, resolve_rendered_audio_path, soft_limit
from musak.models import ProjectState
from musak.storage import ProjectStore, generate_id

logger = logging.getLogger(__name__)


def apply_master_preset(
    stereo: np.ndarray,
    sr: int,
    preset: Literal["off", "balanced", "club", "warm"] = "off",
) -> np.ndarray:
    """Apply optional mastering polish chain to stereo `(samples, 2)` float32 audio."""
    audio = ensure_stereo(stereo)
    if preset == "off" or len(audio) == 0:
        return soft_limit(audio)

    if preset == "balanced":
        board = pb.Pedalboard(
            [
                pb.LowShelfFilter(cutoff_frequency_hz=100.0, gain_db=1.5),
                pb.HighShelfFilter(cutoff_frequency_hz=8500.0, gain_db=1.5),
                pb.Compressor(threshold_db=-16.0, ratio=2.0, attack_ms=15.0, release_ms=120.0),
                pb.Limiter(threshold_db=-1.0, release_ms=80.0),
            ]
        )
        out = _run_pedalboard(board, audio, sr)
        peak = float(np.max(np.abs(out)))
        if peak > 1e-4:
            out = out * min(2.0, 0.944 / peak)
        return soft_limit(out)

    if preset == "club":
        board = pb.Pedalboard(
            [
                pb.LowShelfFilter(cutoff_frequency_hz=80.0, gain_db=2.2),
                pb.HighShelfFilter(cutoff_frequency_hz=9500.0, gain_db=1.5),
                pb.Compressor(threshold_db=-16.0, ratio=2.4, attack_ms=12.0, release_ms=90.0),
                pb.Gain(gain_db=2.0),
                pb.Limiter(threshold_db=-1.0, release_ms=70.0),
            ]
        )
        out = _run_pedalboard(board, audio, sr)
        return soft_limit(out)

    if preset == "warm":
        board = pb.Pedalboard(
            [
                pb.LowShelfFilter(cutoff_frequency_hz=160.0, gain_db=2.0),
                pb.HighShelfFilter(cutoff_frequency_hz=6500.0, gain_db=-2.0),
                pb.Distortion(drive_db=3.5),
                pb.Compressor(threshold_db=-16.0, ratio=2.2, attack_ms=20.0, release_ms=150.0),
                pb.Limiter(threshold_db=-1.2, release_ms=100.0),
            ]
        )
        return soft_limit(_run_pedalboard(board, audio, sr))

    return soft_limit(audio)


def _write_audio_export(audio: np.ndarray, sr: int, out_path: Path, fmt: Literal["wav", "mp3"]) -> Path:
    stereo = soft_limit(ensure_stereo(audio))
    if fmt == "wav":
        sf.write(str(out_path), stereo, sr, subtype="PCM_16")
        return out_path

    ffmpeg = get_ffmpeg_path()
    if ffmpeg:
        fd, tmp_wav_name = tempfile.mkstemp(prefix=".exp_wav_", suffix=".wav", dir=str(out_path.parent))
        os.close(fd)
        tmp_wav = Path(tmp_wav_name)
        try:
            sf.write(str(tmp_wav), stereo, sr, subtype="PCM_16")
            cmd = [ffmpeg, "-y", "-i", str(tmp_wav), "-codec:a", "libmp3lame", "-b:a", "320k", str(out_path)]
            result = subprocess.run(cmd, capture_output=True, text=True, check=False)
            if result.returncode == 0 and out_path.is_file():
                return out_path
            logger.warning("FFmpeg MP3 export failed (%s), trying soundfile fallback.", result.stderr.strip()[:200])
        finally:
            try:
                tmp_wav.unlink(missing_ok=True)
            except OSError:
                pass

    if "MP3" in sf.available_formats():
        sf.write(str(out_path), stereo, sr, format="MP3")
        return out_path

    raise RuntimeError("MP3 export requires FFmpeg on PATH (or libsndfile MP3 support).")


def export_mix(
    store: ProjectStore,
    project: ProjectState,
    fmt: Literal["wav", "mp3", "zip"] = "wav",
    target: Literal["remix", "instrumental", "vocals", "stems_zip"] = "remix",
    master_preset: Literal["off", "balanced", "club", "warm"] = "off",
) -> Path:
    """Export remix, instrumental, vocals, or 4-stem ZIP with optional mastering polish."""
    if project.main_track is None:
        raise ValueError("Project has no main track to export.")

    exports_dir = store.exports_dir(project.id)
    exports_dir.mkdir(parents=True, exist_ok=True)
    store.prune_exports(project.id)
    exp_nonce = generate_id("x")

    if target == "stems_zip" or fmt == "zip":
        if project.main_track.stems_status != "ready":
            raise ValueError("Separate stems on your main track first before exporting stems.")
        stem_paths = {s: store.main_stem_path(project.id, s) for s in STEM_NAMES}
        if not all(p.is_file() for p in stem_paths.values()):
            raise ValueError("One or more stem WAV files are missing. Re-run stem separation first.")

        zip_path = store.export_file_path(project.id, f"stems_v{project.render_version}_{exp_nonce}.zip")
        with zipfile.ZipFile(str(zip_path), "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for stem_name, stem_path in stem_paths.items():
                if master_preset == "off":
                    zf.write(str(stem_path), arcname=f"{stem_name}.wav")
                else:
                    data, sr = sf.read(str(stem_path), dtype="float32", always_2d=True)
                    polished = apply_master_preset(data, int(sr), master_preset)
                    buf = io.BytesIO()
                    sf.write(buf, polished, int(sr), format="WAV", subtype="PCM_16")
                    zf.writestr(f"{stem_name}.wav", buf.getvalue())
        return zip_path

    audio_fmt: Literal["wav", "mp3"] = "mp3" if fmt == "mp3" else "wav"

    if target == "vocals":
        if project.main_track.stems_status != "ready":
            raise ValueError("Separate stems on your main track first to export isolated vocals.")
        vocals_path = store.main_stem_path(project.id, "vocals")
        if not vocals_path.is_file():
            raise ValueError("Vocals stem WAV is missing. Re-run stem separation first.")
        audio, sr = sf.read(str(vocals_path), dtype="float32", always_2d=True)
        polished = apply_master_preset(audio, int(sr), master_preset)
        out_path = store.export_file_path(project.id, f"vocals_v{project.render_version}_{exp_nonce}.{audio_fmt}")
        return _write_audio_export(polished, int(sr), out_path, audio_fmt)

    if target == "instrumental":
        if project.main_track.stems_status != "ready":
            raise ValueError("Separate stems on your main track first to export an instrumental.")
        inst_paths = [store.main_stem_path(project.id, s) for s in ("drums", "bass", "other")]
        if not all(p.is_file() for p in inst_paths):
            raise ValueError("Instrumental stem WAVs are missing. Re-run stem separation first.")
        buffers: list[np.ndarray] = []
        sr = project.main_track.sample_rate or TARGET_SAMPLE_RATE
        for p in inst_paths:
            data, stem_sr = sf.read(str(p), dtype="float32", always_2d=True)
            stereo = ensure_stereo(data)
            if int(stem_sr) != sr:
                stereo = resample_stereo(stereo, int(stem_sr), sr)
            buffers.append(stereo)
        max_len = max(len(b) for b in buffers)
        summed = np.zeros((max_len, 2), dtype=np.float32)
        for b in buffers:
            summed[: len(b)] += b
        polished = apply_master_preset(summed, sr, master_preset)
        out_path = store.export_file_path(
            project.id, f"instrumental_v{project.render_version}_{exp_nonce}.{audio_fmt}"
        )
        return _write_audio_export(polished, sr, out_path, audio_fmt)

    src_wav = resolve_rendered_audio_path(store, project)
    if src_wav is None:
        raise FileNotFoundError("Main track audio file is missing on disk.")

    audio, sr = sf.read(str(src_wav), dtype="float32", always_2d=True)
    polished = apply_master_preset(audio, int(sr), master_preset)
    out_path = store.export_file_path(project.id, f"mix_v{project.render_version}_{exp_nonce}.{audio_fmt}")
    return _write_audio_export(polished, int(sr), out_path, audio_fmt)

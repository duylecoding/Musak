"""Configuration, environment paths, hardware capabilities, and in-memory API key store."""

from __future__ import annotations

import os
import shutil
import threading
from pathlib import Path

DEFAULT_GEMINI_MODEL = "gemini-2.5-flash"
TARGET_SAMPLE_RATE = 44100
STEM_NAMES: tuple[str, ...] = ("vocals", "drums", "bass", "other")

_api_key_lock = threading.Lock()
_gemini_api_key: str | None = None


def get_gemini_model() -> str:
    """Return configured Gemini model name."""
    return os.environ.get("MUSAK_GEMINI_MODEL", "").strip() or DEFAULT_GEMINI_MODEL


def get_data_dir() -> Path:
    """Return the root directory for stored Musak projects.

    Uses `MUSAK_DATA_DIR` when set, otherwise `%APPDATA%\\Musak\\projects` on Windows
    (or `~/.musak/projects` as a fallback).
    """
    override = os.environ.get("MUSAK_DATA_DIR", "").strip()
    if override:
        base = Path(override).expanduser().resolve()
    else:
        appdata = os.environ.get("APPDATA", "").strip()
        if appdata:
            base = Path(appdata) / "Musak" / "projects"
        else:
            base = Path.home() / ".musak" / "projects"
    base.mkdir(parents=True, exist_ok=True)
    return base


def set_api_key(api_key: str) -> bool:
    """Store Gemini API key exclusively in process memory (never written to disk)."""
    global _gemini_api_key
    cleaned = api_key.strip() if api_key else ""
    with _api_key_lock:
        _gemini_api_key = cleaned if cleaned else None
        return _gemini_api_key is not None


def get_api_key(override: str | None = None) -> str | None:
    """Return an explicit header override key or the in-memory configured API key."""
    if override and override.strip():
        return override.strip()
    with _api_key_lock:
        return _gemini_api_key


def clear_api_key() -> None:
    """Clear the in-memory Gemini API key."""
    global _gemini_api_key
    with _api_key_lock:
        _gemini_api_key = None


def is_api_key_configured() -> bool:
    """Return True if a non-empty Gemini API key is present in memory."""
    with _api_key_lock:
        return bool(_gemini_api_key)


def get_cuda_info() -> tuple[bool, str | None]:
    """Safely check whether PyTorch CUDA GPU acceleration is available."""
    try:
        import torch

        if torch.cuda.is_available():
            try:
                gpu_name = torch.cuda.get_device_name(0)
            except Exception:
                gpu_name = "CUDA GPU"
            return True, gpu_name
        return False, None
    except Exception:
        return False, None


def get_ffmpeg_path() -> str | None:
    """Locate ffmpeg executable via FFMPEG_PATH, PATH, WinGet, Chocolatey, or Scoop."""
    env_path = os.environ.get("FFMPEG_PATH", "").strip()
    if env_path:
        candidate = Path(env_path).expanduser()
        if candidate.is_file():
            return str(candidate)

    on_path = shutil.which("ffmpeg")
    if on_path:
        return on_path

    local_appdata = os.environ.get("LOCALAPPDATA", "").strip()
    if local_appdata:
        local_root = Path(local_appdata)
        winget_link = local_root / "Microsoft" / "WinGet" / "Links" / "ffmpeg.exe"
        if winget_link.is_file():
            return str(winget_link)

        winget_pkgs = local_root / "Microsoft" / "WinGet" / "Packages"
        if winget_pkgs.is_dir():
            matches: list[Path] = []
            for pattern in ("*FFmpeg*/**/bin/ffmpeg.exe", "*ffmpeg*/**/bin/ffmpeg.exe"):
                for match in winget_pkgs.glob(pattern):
                    if match.is_file():
                        matches.append(match)
            if matches:
                # Deduplicate and prefer highest sorted version path
                unique = sorted({m.resolve() for m in matches}, reverse=True)
                return str(unique[0])

    choco = Path(r"C:\ProgramData\chocolatey\bin\ffmpeg.exe")
    if choco.is_file():
        return str(choco)

    scoop = Path.home() / "scoop" / "shims" / "ffmpeg.exe"
    if scoop.is_file():
        return str(scoop)

    return None


def is_ffmpeg_available() -> bool:
    """Return True if ffmpeg can be located on this machine."""
    return get_ffmpeg_path() is not None

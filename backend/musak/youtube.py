"""Public YouTube URL validation, lightweight metadata lookup, and on-demand audio download."""

from __future__ import annotations

import json
import logging
import re
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from musak.audio_analysis import load_audio_to_stereo_wav
from musak.config import TARGET_SAMPLE_RATE, get_ffmpeg_path

logger = logging.getLogger(__name__)

_YOUTUBE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
_ALLOWED_YOUTUBE_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
    "www.youtu.be",
}


def extract_youtube_id(url: str) -> str:
    """Validate a public YouTube URL and return its 11-character video ID.

    Supports:
    - `https://www.youtube.com/watch?v=<ID>`
    - `https://youtu.be/<ID>`
    - `https://www.youtube.com/shorts/<ID>`
    - `https://music.youtube.com/watch?v=<ID>`
    """
    cleaned = (url or "").strip()
    parsed = urlparse(cleaned)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("YouTube URL must start with http:// or https://.")

    host = (parsed.hostname or "").lower()
    if host not in _ALLOWED_YOUTUBE_HOSTS:
        raise ValueError(f"Unsupported YouTube host '{host}'. Provide a valid youtube.com or youtu.be URL.")

    video_id: str | None = None
    path_parts = [p for p in parsed.path.split("/") if p]

    if host in ("youtu.be", "www.youtu.be"):
        if path_parts:
            video_id = path_parts[0]
    else:
        if path_parts and path_parts[0] == "watch":
            qs = parse_qs(parsed.query)
            vals = qs.get("v")
            if vals:
                video_id = vals[0]
        elif len(path_parts) >= 2 and path_parts[0] in ("shorts", "embed", "live"):
            video_id = path_parts[1]

    if not video_id or not _YOUTUBE_ID_RE.match(video_id):
        raise ValueError("Could not extract a valid 11-character YouTube video ID from URL.")

    return video_id


def canonical_youtube_url(video_id: str) -> str:
    """Build canonical watch URL from a validated video ID."""
    if not _YOUTUBE_ID_RE.match(video_id):
        raise ValueError("Invalid YouTube video ID.")
    return f"https://www.youtube.com/watch?v={video_id}"


def fetch_youtube_metadata(url: str) -> dict[str, Any]:
    """Fetch lightweight YouTube metadata (fast oEmbed first, yt-dlp fallback) without downloading media."""
    video_id = extract_youtube_id(url)
    canon_url = canonical_youtube_url(video_id)
    fallback: dict[str, Any] = {
        "youtube_id": video_id,
        "youtube_url": canon_url,
        "title": f"YouTube ({video_id})",
        "duration": None,
    }

    oembed_url = f"https://www.youtube.com/oembed?url={urllib.parse.quote(canon_url, safe='')}&format=json"
    try:
        with urllib.request.urlopen(oembed_url, timeout=3) as resp:
            raw = resp.read().decode("utf-8")
            oembed_data = json.loads(raw)
        if isinstance(oembed_data, dict):
            title = str(oembed_data.get("title") or "").strip()
            if title:
                return {
                    "youtube_id": video_id,
                    "youtube_url": canon_url,
                    "title": title,
                    "duration": None,
                }
    except Exception as exc:
        logger.debug("YouTube oEmbed lookup failed for %s (%s); falling back to yt-dlp.", video_id, exc)

    try:
        import yt_dlp

        ydl_opts = {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "noplaylist": True,
            "socket_timeout": 10,
        }
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(canon_url, download=False)
        if isinstance(info, dict):
            title = info.get("title") or fallback["title"]
            raw_dur = info.get("duration")
            duration = round(float(raw_dur), 3) if raw_dur is not None else None
            return {
                "youtube_id": video_id,
                "youtube_url": canon_url,
                "title": str(title),
                "duration": duration,
            }
    except Exception as exc:
        logger.warning("Lightweight YouTube metadata lookup failed for %s: %s", video_id, exc)

    return fallback


def download_youtube_audio(url: str, output_wav: Path, target_sr: int = TARGET_SAMPLE_RATE) -> Path:
    """Tier 2 on-demand download: fetch best audio via yt-dlp and convert to stereo 44.1 kHz WAV."""
    import yt_dlp

    video_id = extract_youtube_id(url)
    canon_url = canonical_youtube_url(video_id)
    output_wav.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="musak_yt_") as tmp_dir:
        tmp_root = Path(tmp_dir)
        out_tmpl = str(tmp_root / "%(id)s.%(ext)s")
        ffmpeg_path = get_ffmpeg_path()

        ydl_opts: dict[str, Any] = {
            "format": "bestaudio/best",
            "outtmpl": out_tmpl,
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
        }
        if ffmpeg_path:
            ydl_opts["ffmpeg_location"] = str(Path(ffmpeg_path).parent)

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([canon_url])

        candidates = [p for p in tmp_root.iterdir() if p.is_file()]
        if not candidates:
            raise RuntimeError("yt-dlp completed without producing an audio file.")

        downloaded = candidates[0]
        load_audio_to_stereo_wav(downloaded, output_wav, target_sr=target_sr)

    return output_wav

"""Bounded, thread-safe LRU caches for decoded stems, stretched reference clips, and waveform peaks."""

from __future__ import annotations

from collections import OrderedDict
from pathlib import Path
from threading import Lock
from typing import Callable, TypeVar

import numpy as np

T = TypeVar("T")


def file_cache_signature(path: Path) -> tuple[str, int, int]:
    """Return a `(resolved_path, mtime_ns, size)` tuple that invalidates automatically on file updates."""
    st = path.stat()
    return (str(path.resolve()), int(st.st_mtime_ns), int(st.st_size))


class _BoundedCache(OrderedDict[tuple[object, ...], T]):
    """Simple thread-safe LRU cache with optional byte-budget eviction."""

    def __init__(self, max_entries: int, max_bytes: int | None = None) -> None:
        super().__init__()
        self._max_entries = max_entries
        self._max_bytes = max_bytes
        self._total_bytes = 0
        self._lock = Lock()

    def _item_bytes(self, val: object) -> int:
        return int(val.nbytes) if isinstance(val, np.ndarray) else 0

    def get_or_compute(self, key: tuple[object, ...], compute: Callable[[], T]) -> T:
        with self._lock:
            if key in self:
                self.move_to_end(key)
                return self[key]

        value = compute()
        size = self._item_bytes(value)
        with self._lock:
            if key in self:
                self._total_bytes -= self._item_bytes(self[key])
                self.move_to_end(key)
            self[key] = value
            self._total_bytes += size
            while len(self) > self._max_entries or (
                self._max_bytes is not None and self._total_bytes > self._max_bytes and len(self) > 1
            ):
                _, evicted = self.popitem(last=False)
                self._total_bytes -= self._item_bytes(evicted)
        return value

    def clear_all(self) -> None:
        with self._lock:
            self.clear()
            self._total_bytes = 0


# Up to ~320 MB of decoded full stem buffers (~8 full-length stereo stems at 44.1 kHz float32)
_STEM_CACHE: _BoundedCache[np.ndarray] = _BoundedCache(max_entries=12, max_bytes=360 * 1024 * 1024)
# Up to ~240 MB of stretched/pitch-shifted borrowed clips (e.g. 24 x ~25s stereo clips)
_BORROW_CLIP_CACHE: _BoundedCache[np.ndarray] = _BoundedCache(max_entries=48, max_bytes=240 * 1024 * 1024)
# Up to 64 downsampled waveform peak lists (tiny: ~10 KB each)
_PEAKS_CACHE: _BoundedCache[list[float]] = _BoundedCache(max_entries=64)
# Up to ~96 MB of synthesized SFX buffers (e.g. ambient_pad, supersaw_swell, risers)
_SFX_CACHE: _BoundedCache[np.ndarray] = _BoundedCache(max_entries=32, max_bytes=96 * 1024 * 1024)


def get_cached_stem_audio(path: Path, target_sr: int, loader: Callable[[], np.ndarray]) -> np.ndarray:
    """Return a mutable copy of a cached `(samples, 2)` float32 stem buffer."""
    key = (file_cache_signature(path), int(target_sr))
    return _STEM_CACHE.get_or_compute(key, loader).copy()


def get_cached_borrowed_clip(
    src_path: Path,
    r_start: float,
    r_end: float,
    target_sr: int,
    rate: float,
    semitones: int,
    ref_stem: str,
    builder: Callable[[], np.ndarray],
) -> np.ndarray:
    """Return a mutable copy of a cached stretched/pitch-shifted borrowed reference clip."""
    key = (
        file_cache_signature(src_path),
        round(float(r_start), 4),
        round(float(r_end), 4),
        int(target_sr),
        round(float(rate), 4),
        int(semitones),
        str(ref_stem),
    )
    return _BORROW_CLIP_CACHE.get_or_compute(key, builder).copy()


def get_cached_peaks(path: Path, buckets: int, builder: Callable[[], list[float]]) -> list[float]:
    """Return cached waveform peaks list for `(path, mtime, size, buckets)`."""
    key = (file_cache_signature(path), int(buckets))
    return list(_PEAKS_CACHE.get_or_compute(key, builder))


def get_cached_sfx(
    sfx_id: str,
    length_samples: int,
    sr: int,
    bpm: float,
    musical_key: str | None,
    builder: Callable[[], np.ndarray],
) -> np.ndarray:
    """Return a cached synthesized SFX stereo buffer (read-only view; caller copies if mutating)."""
    key = (str(sfx_id), int(length_samples), int(sr), round(float(bpm), 2), str(musical_key or ""))
    return _SFX_CACHE.get_or_compute(key, builder)


def clear_dsp_caches() -> None:
    """Clear all in-memory DSP caches (useful for tests or explicit memory release)."""
    _STEM_CACHE.clear_all()
    _BORROW_CLIP_CACHE.clear_all()
    _PEAKS_CACHE.clear_all()
    _SFX_CACHE.clear_all()

"""Thread-safe JSON project store with strict ID validation, versioned renders, and per-project locks."""

from __future__ import annotations

import os
import re
import shutil
import tempfile
import threading
import uuid
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path

from musak.config import STEM_NAMES, get_data_dir
from musak.models import ProjectState, ProjectSummary

ID_PATTERN = re.compile(r"^[a-zA-Z0-9_-]+$")
MAX_ID_LENGTH = 128


class InvalidIdError(ValueError):
    """Raised when a supplied resource identifier fails strict path-safe validation."""


class ProjectNotFoundError(FileNotFoundError):
    """Raised when a project cannot be found on disk."""


def utc_now_iso() -> str:
    """Return an ISO-8601 UTC timestamp string."""
    return datetime.now(timezone.utc).isoformat()


def validate_id(value: str, label: str = "id") -> str:
    """Strictly validate an identifier against `^[a-zA-Z0-9_-]+$`."""
    if not isinstance(value, str) or not value or len(value) > MAX_ID_LENGTH:
        raise InvalidIdError(f"Invalid {label}: must be 1-{MAX_ID_LENGTH} alphanumeric/dash/underscore chars.")
    if not ID_PATTERN.match(value):
        raise InvalidIdError(f"Invalid {label}: contains disallowed characters.")
    return value


def validate_stem_name(stem_name: str) -> str:
    """Validate that a stem name is one of the 4 supported Demucs stems."""
    if stem_name not in STEM_NAMES:
        raise InvalidIdError(f"Invalid stem name '{stem_name}'. Must be one of {STEM_NAMES}.")
    return stem_name


def generate_id(prefix: str = "") -> str:
    """Generate a URL-safe, path-safe unique identifier."""
    token = uuid.uuid4().hex[:12]
    return f"{prefix}_{token}" if prefix else token


def _ensure_within(base: Path, target: Path) -> Path:
    resolved_base = base.resolve()
    resolved_target = target.resolve()
    if not resolved_target.is_relative_to(resolved_base):
        raise InvalidIdError("Path escapes storage root.")
    return resolved_target


class ProjectStore:
    """Thread-safe persistent project manager backed by atomic JSON files."""

    def __init__(self, data_dir_fn: Callable[[], Path] = get_data_dir) -> None:
        self._data_dir_fn = data_dir_fn
        self._lock = threading.RLock()
        self._render_locks_guard = threading.Lock()
        self._render_locks: dict[str, threading.Lock] = {}

    @property
    def root_dir(self) -> Path:
        root = self._data_dir_fn()
        root.mkdir(parents=True, exist_ok=True)
        return root

    def get_render_lock(self, project_id: str) -> threading.Lock:
        """Return a per-project lock for heavy DSP/render/track operations without blocking global reads."""
        pid = validate_id(project_id, "project_id")
        with self._render_locks_guard:
            lock = self._render_locks.get(pid)
            if lock is None:
                lock = threading.Lock()
                self._render_locks[pid] = lock
            return lock

    # --- Path Helpers ---

    def project_dir(self, project_id: str) -> Path:
        pid = validate_id(project_id, "project_id")
        return _ensure_within(self.root_dir, self.root_dir / pid)

    def project_json_path(self, project_id: str) -> Path:
        return self.project_dir(project_id) / "project.json"

    def main_audio_path(self, project_id: str, track_id: str | None = None) -> Path:
        pdir = self.project_dir(project_id)
        if track_id:
            tid = validate_id(track_id, "track_id")
            return _ensure_within(pdir, pdir / f"main_{tid}.wav")
        return pdir / "main.wav"

    def get_main_audio_path(self, project_id: str, track_id: str | None = None) -> Path:
        """Resolve active versioned `main_{track_id}.wav`, falling back to legacy `main.wav`."""
        if track_id:
            versioned = self.main_audio_path(project_id, track_id)
            if versioned.is_file():
                return versioned
        return self.main_audio_path(project_id)

    def prune_old_main_audio(self, project_id: str, keep_track_id: str | None = None) -> None:
        """Best-effort cleanup of older versioned main WAVs (ignores Windows WinError 32 if streaming)."""
        pdir = self.project_dir(project_id)
        if not pdir.is_dir():
            return
        keep_name = f"main_{validate_id(keep_track_id, 'track_id')}.wav" if keep_track_id else None
        for candidate in list(pdir.glob("main_*.wav")) + [pdir / "main.wav"]:
            if not candidate.is_file():
                continue
            if keep_name and candidate.name == keep_name:
                continue
            try:
                candidate.unlink(missing_ok=True)
            except OSError:
                pass

    def rendered_audio_path(self, project_id: str, render_version: int | None = None) -> Path:
        pdir = self.project_dir(project_id)
        if render_version is not None and render_version > 0:
            return pdir / f"rendered_v{render_version}.wav"
        return pdir / "rendered.wav"

    def rendered_stems_dir(self, project_id: str) -> Path:
        return self.project_dir(project_id) / "rendered_stems"

    def rendered_stem_path(self, project_id: str, stem_name: str, render_version: int) -> Path:
        stem = validate_stem_name(stem_name)
        rdir = self.rendered_stems_dir(project_id)
        return _ensure_within(rdir, rdir / f"{stem}_v{render_version}.wav")

    def prune_old_renders(self, project_id: str, keep_version: int | None = None) -> None:
        """Best-effort cleanup of older versioned render WAVs (ignores Windows WinError 32 if streaming)."""
        pdir = self.project_dir(project_id)
        if not pdir.is_dir():
            return
        keep_name = f"rendered_v{keep_version}.wav" if (keep_version is not None and keep_version > 0) else None
        for candidate in list(pdir.glob("rendered_v*.wav")) + [pdir / "rendered.wav"]:
            if not candidate.is_file():
                continue
            if keep_name and candidate.name == keep_name:
                continue
            try:
                candidate.unlink(missing_ok=True)
            except OSError:
                pass
        rs_dir = self.rendered_stems_dir(project_id)
        if rs_dir.is_dir():
            keep_suffix = f"_v{keep_version}.wav" if (keep_version is not None and keep_version > 0) else None
            for candidate in rs_dir.glob("*_v*.wav"):
                if keep_suffix and candidate.name.endswith(keep_suffix):
                    continue
                try:
                    candidate.unlink(missing_ok=True)
                except OSError:
                    pass

    def main_stems_dir(self, project_id: str) -> Path:
        return self.project_dir(project_id) / "stems"

    def main_stem_path(self, project_id: str, stem_name: str) -> Path:
        stem = validate_stem_name(stem_name)
        stems_dir = self.main_stems_dir(project_id)
        return _ensure_within(stems_dir, stems_dir / f"{stem}.wav")

    def previews_dir(self, project_id: str) -> Path:
        return self.project_dir(project_id) / "previews"

    def preview_audio_path(self, project_id: str, proposal_id: str, nonce: str | None = None) -> Path:
        prop_id = validate_id(proposal_id, "proposal_id")
        pdir = self.previews_dir(project_id)
        if nonce:
            safe_nonce = validate_id(nonce, "nonce")
            return _ensure_within(pdir, pdir / f"{prop_id}_{safe_nonce}.wav")
        return _ensure_within(pdir, pdir / f"{prop_id}.wav")

    def resolve_preview_audio_path(
        self,
        project_id: str,
        proposal_id: str,
        nonce: str | None = None,
    ) -> Path | None:
        """Resolve versioned preview WAV for a proposal, falling back to latest or unversioned."""
        prop_id = validate_id(proposal_id, "proposal_id")
        if nonce:
            try:
                exact = self.preview_audio_path(project_id, prop_id, nonce=nonce)
                if exact.is_file():
                    return exact
            except InvalidIdError:
                pass
        pdir = self.previews_dir(project_id)
        if pdir.is_dir():
            versioned = sorted(
                (p for p in pdir.glob(f"{prop_id}_*.wav") if p.is_file()),
                key=lambda p: p.stat().st_mtime,
                reverse=True,
            )
            if versioned:
                return versioned[0]
        legacy = self.preview_audio_path(project_id, prop_id)
        if legacy.is_file():
            return legacy
        return None

    def prune_old_previews(
        self,
        project_id: str,
        proposal_id: str,
        keep_name: str | None = None,
    ) -> None:
        """Best-effort cleanup of older preview WAVs for a proposal (ignores Windows WinError 32)."""
        prop_id = validate_id(proposal_id, "proposal_id")
        pdir = self.previews_dir(project_id)
        if not pdir.is_dir():
            return
        candidates = list(pdir.glob(f"{prop_id}_*.wav")) + [pdir / f"{prop_id}.wav"]
        for cand in candidates:
            if not cand.is_file():
                continue
            if keep_name and cand.name == keep_name:
                continue
            try:
                cand.unlink(missing_ok=True)
            except OSError:
                pass

    def reference_dir(self, project_id: str, ref_id: str) -> Path:
        rid = validate_id(ref_id, "ref_id")
        refs_root = self.project_dir(project_id) / "references"
        return _ensure_within(refs_root, refs_root / rid)

    def reference_audio_path(self, project_id: str, ref_id: str) -> Path:
        return self.reference_dir(project_id, ref_id) / "audio.wav"

    def reference_stems_dir(self, project_id: str, ref_id: str) -> Path:
        return self.reference_dir(project_id, ref_id) / "stems"

    def reference_stem_path(self, project_id: str, ref_id: str, stem_name: str) -> Path:
        stem = validate_stem_name(stem_name)
        sdir = self.reference_stems_dir(project_id, ref_id)
        return _ensure_within(sdir, sdir / f"{stem}.wav")

    def exports_dir(self, project_id: str) -> Path:
        return self.project_dir(project_id) / "exports"

    def prune_exports(self, project_id: str) -> None:
        """Best-effort cleanup of older export files."""
        edir = self.exports_dir(project_id)
        if not edir.is_dir():
            return
        for item in edir.iterdir():
            if item.is_file():
                try:
                    item.unlink(missing_ok=True)
                except OSError:
                    pass

    def export_file_path(self, project_id: str, filename: str) -> Path:
        safe_name = Path(filename).name
        if not safe_name or safe_name != filename:
            raise InvalidIdError("Invalid export filename.")
        edir = self.exports_dir(project_id)
        return _ensure_within(edir, edir / safe_name)

    # --- URL Builders ---

    @staticmethod
    def main_audio_url(project_id: str, track_id: str | None = None) -> str:
        base = f"/api/projects/{project_id}/audio/main"
        return f"{base}?t={track_id}" if track_id else base

    @staticmethod
    def rendered_audio_url(
        project_id: str,
        render_version: int = 0,
        track_id: str | None = None,
    ) -> str:
        base = f"/api/projects/{project_id}/audio/rendered"
        params: list[str] = []
        if track_id:
            params.append(f"t={track_id}")
        if render_version > 0:
            params.append(f"v={render_version}")
        return f"{base}?{'&'.join(params)}" if params else base

    @staticmethod
    def stem_urls(project_id: str, stems: list[str], track_id: str | None = None) -> dict[str, str]:
        suffix = f"?t={track_id}" if track_id else ""
        return {stem: f"/api/projects/{project_id}/audio/stem/{stem}{suffix}" for stem in stems}

    @staticmethod
    def preview_audio_url(project_id: str, proposal_id: str, nonce: str | None = None) -> str:
        base = f"/api/projects/{project_id}/audio/preview/{proposal_id}"
        return f"{base}?t={nonce}" if nonce else base

    @staticmethod
    def reference_audio_url(project_id: str, ref_id: str) -> str:
        return f"/api/projects/{project_id}/references/{ref_id}/audio"

    # --- CRUD ---

    def _atomic_write_json(self, path: Path, payload: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(prefix=".tmp_", suffix=".json", dir=str(path.parent))
        tmp_path = Path(tmp_name)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp_path, path)
        except Exception:
            if tmp_path.exists():
                tmp_path.unlink(missing_ok=True)
            raise

    def create_project(self, name: str) -> ProjectState:
        cleaned = name.strip()
        if not cleaned:
            raise ValueError("Project name cannot be empty.")
        now = utc_now_iso()
        project = ProjectState(
            id=generate_id("proj"),
            name=cleaned,
            created_at=now,
            updated_at=now,
        )
        with self._lock:
            pdir = self.project_dir(project.id)
            pdir.mkdir(parents=True, exist_ok=True)
            self._atomic_write_json(
                self.project_json_path(project.id),
                project.model_dump_json(indent=2),
            )
        return project

    def get_project(self, project_id: str) -> ProjectState:
        json_path = self.project_json_path(project_id)
        with self._lock:
            if not json_path.is_file():
                raise ProjectNotFoundError(f"Project '{project_id}' not found.")
            raw = json_path.read_text(encoding="utf-8")
            return ProjectState.model_validate_json(raw)

    def save_project(self, project: ProjectState) -> ProjectState:
        validate_id(project.id, "project_id")
        project.updated_at = utc_now_iso()
        with self._lock:
            pdir = self.project_dir(project.id)
            pdir.mkdir(parents=True, exist_ok=True)
            self._atomic_write_json(
                self.project_json_path(project.id),
                project.model_dump_json(indent=2),
            )
        return project

    def update_project(
        self,
        project_id: str,
        mutator: Callable[[ProjectState], None],
    ) -> ProjectState:
        """Atomically read, mutate, and save a project under the store lock."""
        with self._lock:
            project = self.get_project(project_id)
            mutator(project)
            return self.save_project(project)

    def list_projects(self) -> list[ProjectSummary]:
        summaries: list[ProjectSummary] = []
        with self._lock:
            root = self.root_dir
            for entry in root.iterdir():
                if not entry.is_dir():
                    continue
                if not ID_PATTERN.match(entry.name):
                    continue
                json_path = entry / "project.json"
                if not json_path.is_file():
                    continue
                try:
                    proj = ProjectState.model_validate_json(json_path.read_text(encoding="utf-8"))
                except Exception:
                    continue
                summaries.append(
                    ProjectSummary(
                        id=proj.id,
                        name=proj.name,
                        updated_at=proj.updated_at,
                        has_main_track=proj.main_track is not None,
                        reference_count=len(proj.references),
                        edit_count=len(proj.edits),
                    )
                )
        summaries.sort(key=lambda item: item.updated_at, reverse=True)
        return summaries

    def delete_project(self, project_id: str) -> None:
        pdir = self.project_dir(project_id)
        with self._lock:
            if not pdir.exists():
                raise ProjectNotFoundError(f"Project '{project_id}' not found.")
            shutil.rmtree(pdir)
        with self._render_locks_guard:
            self._render_locks.pop(project_id, None)


store = ProjectStore()

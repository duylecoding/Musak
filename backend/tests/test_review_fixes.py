"""Tests covering all code review fixes (WinGet FFmpeg, race safety, versioned renders, CORS, recovery, DSP/Gemini edge cases)."""

from __future__ import annotations

import io
import json
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from musak import gemini_agent, stems as stems_mod
from musak.config import get_ffmpeg_path
from musak.dsp import render_operations, snap_range_to_beats
from musak.models import EditOperation, ProjectState
from musak.storage import store
from tests.conftest import make_synthetic_track, wav_bytes_from_array


def test_windows_winget_ffmpeg_discovery(client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # Discovers real FFmpeg installed via WinGet on this Windows machine
    found = get_ffmpeg_path()
    assert found is not None
    assert Path(found).is_file()

    health = client.get("/api/health").json()
    assert health["ffmpeg_available"] is True

    # Respects explicit FFMPEG_PATH override
    fake_ff = tmp_path / "custom_ffmpeg.exe"
    fake_ff.write_bytes(b"stub")
    monkeypatch.setenv("FFMPEG_PATH", str(fake_ff))
    assert get_ffmpeg_path() == str(fake_ff)


def test_track_replacement_clears_stale_state_and_cache_busts(client: TestClient) -> None:
    pid = client.post("/api/projects", json={"name": "Replace Lab"}).json()["id"]
    wav_a = wav_bytes_from_array(make_synthetic_track(duration=4.0, bpm=120.0))

    p_a = client.post(
        f"/api/projects/{pid}/main-track",
        files={"file": ("track_a.wav", wav_a, "audio/wav")},
    ).json()
    track_a_id = p_a["main_track"]["id"]
    assert f"?t={track_a_id}" in p_a["main_track"]["audio_url"]
    assert f"?t={track_a_id}" in p_a["main_track"]["rendered_url"]

    # Audio responses must include Cache-Control: no-store
    r_stream = client.get(f"/api/projects/{pid}/audio/main")
    assert r_stream.status_code == 200
    assert r_stream.headers.get("cache-control") == "no-store"

    # Add edit, export, and create a preview file
    p_ed = client.post(
        f"/api/projects/{pid}/edits",
        json={
            "title": "Gain Edit",
            "start": 0.5,
            "end": 2.0,
            "operations": [{"type": "stem_gain", "start": 0.5, "end": 2.0, "gain_db": -6.0}],
        },
    ).json()
    assert len(p_ed["edits"]) == 1
    assert p_ed["render_version"] == 1
    assert f"t={track_a_id}" in p_ed["main_track"]["rendered_url"]
    assert "v=1" in p_ed["main_track"]["rendered_url"]
    assert store.rendered_audio_path(pid, 1).is_file()

    assert client.post(f"/api/projects/{pid}/export", json={"format": "wav"}).status_code == 200
    preview_file = store.preview_audio_path(pid, "prop_stale")
    preview_file.parent.mkdir(parents=True, exist_ok=True)
    preview_file.write_bytes(b"stale")

    # Upload Track B -> must wipe edits, redo_stack, previews, exports, old renders, and bump track_id
    wav_b = wav_bytes_from_array(make_synthetic_track(duration=3.0, bpm=128.0))
    p_b = client.post(
        f"/api/projects/{pid}/main-track",
        files={"file": ("track_b.wav", wav_b, "audio/wav")},
    ).json()
    track_b_id = p_b["main_track"]["id"]
    assert track_b_id != track_a_id
    assert p_b["edits"] == []
    assert p_b["redo_stack"] == []
    assert p_b["render_version"] == 0
    assert f"?t={track_b_id}" in p_b["main_track"]["audio_url"]
    assert not store.rendered_audio_path(pid, 1).exists()
    assert not store.previews_dir(pid).exists()
    assert not store.exports_dir(pid).exists()


def test_stale_stem_worker_race_ignored(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    pid = client.post("/api/projects", json={"name": "Race Guard"}).json()["id"]
    wav_a = wav_bytes_from_array(make_synthetic_track(duration=2.0))
    client.post(f"/api/projects/{pid}/main-track", files={"file": ("a.wav", wav_a, "audio/wav")})

    started = threading.Event()
    proceed = threading.Event()
    done = threading.Event()

    def _slow_separate(input_wav: Path, output_dir: Path) -> list[str]:
        # Like real Demucs, read audio into memory before slow model inference
        data, sr = sf.read(str(input_wav), dtype="float32", always_2d=True)
        started.set()
        proceed.wait(timeout=5.0)
        output_dir.mkdir(parents=True, exist_ok=True)
        for name in ("vocals", "drums", "bass", "other"):
            sf.write(str(output_dir / f"{name}.wav"), data * 0.25, int(sr), subtype="PCM_16")
        done.set()
        return ["vocals", "drums", "bass", "other"]

    monkeypatch.setattr(stems_mod, "separate_audio_file", _slow_separate)

    assert client.post(f"/api/projects/{pid}/main-track/separate").status_code == 200
    assert started.wait(timeout=3.0)

    # Replace main track while Track A's worker is mid-flight
    wav_b = wav_bytes_from_array(make_synthetic_track(duration=3.0))
    p_b = client.post(f"/api/projects/{pid}/main-track", files={"file": ("b.wav", wav_b, "audio/wav")}).json()
    track_b_id = p_b["main_track"]["id"]

    # Release Track A's worker and wait briefly for it to finish
    proceed.set()
    assert done.wait(timeout=3.0)
    time.sleep(0.2)

    final = client.get(f"/api/projects/{pid}").json()
    assert final["main_track"]["id"] == track_b_id
    assert final["main_track"]["stems_status"] == "none"
    assert final["main_track"]["stems"] == []


def test_stuck_processing_recovery_after_restart(client: TestClient) -> None:
    pid = client.post("/api/projects", json={"name": "Crash Recovery"}).json()["id"]
    wav = wav_bytes_from_array(make_synthetic_track(duration=2.0))
    client.post(f"/api/projects/{pid}/main-track", files={"file": ("a.wav", wav, "audio/wav")})
    client.post(f"/api/projects/{pid}/references/upload", files={"file": ("r.wav", wav, "audio/wav")})

    # Simulate persisted "processing" state left over from a killed process (no live _active_jobs)
    def _corrupt(proj: ProjectState) -> None:
        assert proj.main_track is not None
        proj.main_track.stems_status = "processing"
        proj.references[0].stems_status = "processing"

    store.update_project(pid, _corrupt)

    recovered = client.get(f"/api/projects/{pid}").json()
    assert recovered["main_track"]["stems_status"] == "error"
    assert "interrupted" in recovered["main_track"]["stems_error"].lower()
    assert recovered["references"][0]["stems_status"] == "error"
    assert "interrupted" in recovered["references"][0]["stems_error"].lower()


def test_versioned_renders_export_pruning_and_cors(client: TestClient) -> None:
    pid = client.post("/api/projects", json={"name": "Versioned"}).json()["id"]
    wav = wav_bytes_from_array(make_synthetic_track(duration=3.0))
    client.post(f"/api/projects/{pid}/main-track", files={"file": ("s.wav", wav, "audio/wav")})

    # CORS check: Origin: null allowed WITHOUT credentials, exposes Content-Disposition
    r_cors = client.options(
        f"/api/projects/{pid}/export",
        headers={
            "Origin": "null",
            "Access-Control-Request-Method": "POST",
        },
    )
    assert r_cors.status_code == 200
    assert r_cors.headers.get("access-control-allow-credentials") != "true"

    r_get = client.get("/api/health", headers={"Origin": "null"})
    assert "content-disposition" in (r_get.headers.get("access-control-expose-headers") or "").lower()

    # Two sequential edits -> rendered_v2.wav exists, rendered_v1.wav pruned
    client.post(
        f"/api/projects/{pid}/edits",
        json={
            "title": "Edit 1",
            "start": 0.0,
            "end": 1.0,
            "operations": [{"type": "bass_boost", "start": 0.0, "end": 1.0, "gain_db": 4.0}],
        },
    )
    assert store.rendered_audio_path(pid, 1).is_file()

    client.post(
        f"/api/projects/{pid}/edits",
        json={
            "title": "Edit 2",
            "start": 1.0,
            "end": 2.0,
            "operations": [{"type": "lofi_eq", "start": 1.0, "end": 2.0, "drive_db": 0.0}],
        },
    )
    assert store.rendered_audio_path(pid, 2).is_file()
    assert not store.rendered_audio_path(pid, 1).exists()

    # Rendered audio stream serves v2 with no-store
    r_rend = client.get(f"/api/projects/{pid}/audio/rendered")
    assert r_rend.status_code == 200
    assert r_rend.headers.get("cache-control") == "no-store"

    # Exports prune previous files
    assert client.post(f"/api/projects/{pid}/export", json={"format": "wav"}).status_code == 200
    assert len(list(store.exports_dir(pid).iterdir())) == 1
    assert client.post(f"/api/projects/{pid}/export", json={"format": "mp3"}).status_code == 200
    export_files = list(store.exports_dir(pid).iterdir())
    assert len(export_files) == 1
    assert export_files[0].suffix == ".mp3"


def test_dsp_endpoint_snap_and_borrow_full_replace(client: TestClient) -> None:
    # Full-track endpoints within 0.05s of 0.0 or duration are NOT snapped inward
    beats = [0.4, 1.0, 2.0, 3.0, 3.6]
    s, e = snap_range_to_beats(0.0, 4.0, beats, duration=4.0, snap_to_beat=True)
    assert s == 0.0 and e == 4.0
    s2, e2 = snap_range_to_beats(0.03, 3.97, beats, duration=4.0, snap_to_beat=True)
    assert abs(s2 - 0.03) < 1e-6 and abs(e2 - 3.97) < 1e-6

    # borrow_stem with replace_main_stems=["full"] mutes all 4 stems when stem_buffers is active
    pid = client.post("/api/projects", json={"name": "Full Replace"}).json()["id"]
    sr = 44100
    wav = wav_bytes_from_array(make_synthetic_track(duration=3.0, varying_energy=False))
    client.post(f"/api/projects/{pid}/main-track", files={"file": ("m.wav", wav, "audio/wav")})

    # Write 4 loud main stems
    t = np.arange(int(3.0 * sr), dtype=np.float32) / float(sr)
    tone = np.stack([0.2 * np.sin(2 * np.pi * 440 * t)] * 2, axis=-1)
    stems_dir = store.main_stems_dir(pid)
    stems_dir.mkdir(parents=True, exist_ok=True)
    for stem in ("vocals", "drums", "bass", "other"):
        sf.write(str(stems_dir / f"{stem}.wav"), tone, sr, subtype="PCM_16")

    # Upload a SILENT reference so replacing "full" with silent ref must silence [1.0, 2.0] completely!
    silent_ref = np.zeros((int(2.0 * sr), 2), dtype=np.float32)
    ref_id = client.post(
        f"/api/projects/{pid}/references/upload",
        files={"file": ("silent.wav", wav_bytes_from_array(silent_ref), "audio/wav")},
    ).json()["references"][0]["id"]

    def _ready(proj: ProjectState) -> None:
        assert proj.main_track is not None
        proj.main_track.stems_status = "ready"
        proj.main_track.stems = ["vocals", "drums", "bass", "other"]

    proj = store.update_project(pid, _ready)
    op = EditOperation(
        type="borrow_stem",
        ref_id=ref_id,
        ref_stem="full",
        ref_start=0.0,
        ref_end=1.0,
        target_start=1.0,
        target_end=2.0,
        replace_main_stems=["full"],
        match_bpm=False,
        match_key=False,
        snap_to_beat=False,
    )
    out, _ = render_operations(store, proj, [op])
    mid = out[int(1.2 * sr) : int(1.8 * sr)]
    assert float(np.max(np.abs(mid))) < 1e-4, "Expected all 4 stems muted when replace_main_stems=['full']"


def test_gemini_zero_values_eof_clip_and_local_plus_youtube_refs(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 1. _sanitize_operation preserves explicit 0.0 values
    op_lofi = gemini_agent._sanitize_operation(
        {"type": "lofi_eq", "start": 1.0, "end": 3.0, "drive_db": 0.0},
        duration=10.0,
        valid_ref_ids=set(),
        downloaded_ref_ids=set(),
        default_start=0.0,
        default_end=5.0,
    )
    assert op_lofi is not None
    assert op_lofi.drive_db == 0.0

    op_bass = gemini_agent._sanitize_operation(
        {"type": "bass_boost", "start": 1.0, "end": 3.0, "gain_db": 0.0},
        duration=10.0,
        valid_ref_ids=set(),
        downloaded_ref_ids=set(),
        default_start=0.0,
        default_end=5.0,
    )
    assert op_bass is not None
    assert op_bass.gain_db == 0.0

    # 2. create_compact_wav_clip handles exact EOF start==duration without 0-frame WAV
    wav_path = tmp_path / "eof_test.wav"
    sf.write(str(wav_path), make_synthetic_track(duration=2.0), 44100, subtype="PCM_16")
    clip_bytes = gemini_agent.create_compact_wav_clip(wav_path, start=2.0, end=2.0, max_seconds=10.0)
    data, sr = sf.read(io.BytesIO(clip_bytes))
    assert sr == 16000
    assert len(data) > 0

    # 3. run_producer_chat attaches BOTH a local ref clip AND a YouTube ref appearing AFTER it
    from musak.routers import references as refs_router

    pid = client.post("/api/projects", json={"name": "Dual Ref Chat"}).json()["id"]
    main_wav = wav_bytes_from_array(make_synthetic_track(duration=6.0))
    client.post(f"/api/projects/{pid}/main-track", files={"file": ("m.wav", main_wav, "audio/wav")})

    local_ref_id = client.post(
        f"/api/projects/{pid}/references/upload",
        files={"file": ("local.wav", wav_bytes_from_array(make_synthetic_track(duration=3.0)), "audio/wav")},
    ).json()["references"][0]["id"]

    monkeypatch.setattr(
        refs_router,
        "fetch_youtube_metadata",
        lambda url: {
            "youtube_id": "dQw4w9WgXcQ",
            "youtube_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "title": "YT Ref",
            "duration": 180.0,
        },
    )
    yt_ref_id = client.post(
        f"/api/projects/{pid}/references/youtube",
        json={"url": "https://youtu.be/dQw4w9WgXcQ"},
    ).json()["references"][1]["id"]

    captured: list[Any] = []

    class _FakeModels:
        def generate_content(self, *, model: str, contents: Any, config: Any) -> Any:
            captured.append(contents)
            return SimpleNamespace(
                text=json.dumps(
                    {
                        "reply": "Nice combo!",
                        "proposals": [
                            {
                                "title": "Clean Bandpass",
                                "summary": "No-drive telephone EQ",
                                "style": "creative",
                                "start": 1.0,
                                "end": 3.0,
                                "operations": [
                                    {"type": "lofi_eq", "start": 1.0, "end": 3.0, "drive_db": 0.0}
                                ],
                            }
                        ],
                    }
                )
            )

    class _FakeClient:
        def __init__(self, api_key: str) -> None:
            self.models = _FakeModels()

    monkeypatch.setattr(gemini_agent.genai, "Client", _FakeClient)

    r_chat = client.post(
        f"/api/projects/{pid}/chat",
        headers={"X-Gemini-Api-Key": "test-key"},
        json={
            "message": "Blend both refs!",
            "selection": {"start": 1.0, "end": 3.0},
            "reference_ids": [local_ref_id, yt_ref_id],
        },
    )
    assert r_chat.status_code == 200
    sent_parts = captured[0]
    inline_parts = [p for p in sent_parts if getattr(p, "inline_data", None) is not None]
    uri_parts = [p for p in sent_parts if getattr(p, "file_data", None) is not None]
    # Token-efficient cap: at most 1 reference media item, preferring compact local WAV over YouTube video
    assert len(inline_parts) == 2  # main clip + 1 local ref clip
    assert len(uri_parts) == 0

    # When ONLY an undownloaded YouTube reference is attached, falls back to Part.from_uri
    captured.clear()
    r_yt_only = client.post(
        f"/api/projects/{pid}/chat",
        headers={"X-Gemini-Api-Key": "test-key"},
        json={
            "message": "Borrow the transition vibe from the YouTube ref",
            "selection": {"start": 1.0, "end": 3.0},
            "reference_ids": [yt_ref_id],
        },
    )
    assert r_yt_only.status_code == 200
    yt_inline = [p for p in captured[0] if getattr(p, "inline_data", None) is not None]
    yt_uri = [p for p in captured[0] if getattr(p, "file_data", None) is not None]
    assert len(yt_inline) == 1  # main clip only
    assert len(yt_uri) == 1
    assert yt_uri[0].file_data.file_uri == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

    # Also verify local auto-tag includes explicit analyzed window note
    captured.clear()

    class _TagModels:
        def generate_content(self, *, model: str, contents: Any, config: Any) -> Any:
            captured.append(contents)
            return SimpleNamespace(
                text=json.dumps({"moments": [{"label": "Hook", "start": 0.5, "end": 2.0, "note": "Nice"}]})
            )

    class _TagClient:
        def __init__(self, api_key: str) -> None:
            self.models = _TagModels()

    monkeypatch.setattr(gemini_agent.genai, "Client", _TagClient)
    r_tag = client.post(
        f"/api/projects/{pid}/references/{local_ref_id}/auto-tag",
        headers={"X-Gemini-Api-Key": "test-key"},
    )
    assert r_tag.status_code == 200
    prompt_str = next(c for c in captured[0] if isinstance(c, str))
    assert "[0.0s, 3.0s]" in prompt_str


def test_whitespace_validation_and_proposal_applied_sync(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Whitespace-only project name rejected (422)
    assert client.post("/api/projects", json={"name": "   "}).status_code == 422

    pid = client.post("/api/projects", json={"name": "Validation Lab"}).json()["id"]
    wav = wav_bytes_from_array(make_synthetic_track(duration=5.0))
    client.post(f"/api/projects/{pid}/main-track", files={"file": ("m.wav", wav, "audio/wav")})
    ref_id = client.post(
        f"/api/projects/{pid}/references/upload",
        files={"file": ("r.wav", wav, "audio/wav")},
    ).json()["references"][0]["id"]

    # Whitespace-only & inverted ranges rejected with 422
    assert (
        client.post(
            f"/api/projects/{pid}/references/{ref_id}/moments",
            json={"label": "   ", "start": 1.0, "end": 2.0},
        ).status_code
        == 422
    )
    assert (
        client.post(
            f"/api/projects/{pid}/references/{ref_id}/moments",
            json={"label": "Bad Range", "start": 3.0, "end": 2.0},
        ).status_code
        == 422
    )
    assert (
        client.post(
            f"/api/projects/{pid}/edits",
            json={
                "title": "   ",
                "start": 1.0,
                "end": 2.0,
                "operations": [{"type": "bass_boost", "start": 1.0, "end": 2.0}],
            },
        ).status_code
        == 422
    )
    assert (
        client.post(
            f"/api/projects/{pid}/edits",
            json={
                "title": "Inverted",
                "start": 2.0,
                "end": 2.0,
                "operations": [{"type": "bass_boost", "start": 1.0, "end": 2.0}],
            },
        ).status_code
        == 422
    )
    assert (
        client.post(
            f"/api/projects/{pid}/chat",
            headers={"X-Gemini-Api-Key": "k"},
            json={"message": "   "},
        ).status_code
        == 422
    )

    # Proposal applied flag sync across apply -> undo -> redo -> delete
    class _FakeModels:
        def generate_content(self, *, model: str, contents: Any, config: Any) -> Any:
            return SimpleNamespace(
                text=json.dumps(
                    {
                        "reply": "Try this!",
                        "proposals": [
                            {
                                "title": "Bass Drop",
                                "summary": "Punchy low end",
                                "style": "creative",
                                "start": 1.0,
                                "end": 3.0,
                                "operations": [{"type": "bass_boost", "start": 1.0, "end": 3.0, "gain_db": 6.0}],
                            }
                        ],
                    }
                )
            )

    class _FakeClient:
        def __init__(self, api_key: str) -> None:
            self.models = _FakeModels()

    monkeypatch.setattr(gemini_agent.genai, "Client", _FakeClient)

    p_chat = client.post(
        f"/api/projects/{pid}/chat",
        headers={"X-Gemini-Api-Key": "k"},
        json={"message": "Boost the bass"},
    ).json()
    prop_id = p_chat["chat_messages"][1]["proposals"][0]["id"]

    p_applied = client.post(f"/api/projects/{pid}/edits/apply-proposal/{prop_id}").json()
    assert p_applied["chat_messages"][1]["proposals"][0]["applied"] is True
    assert p_applied["edits"][0]["source_proposal_id"] == prop_id
    edit_id = p_applied["edits"][0]["id"]

    # Undo -> proposal re-enabled (applied == False)
    p_undo = client.post(f"/api/projects/{pid}/undo").json()
    assert p_undo["chat_messages"][1]["proposals"][0]["applied"] is False

    # Redo -> proposal restored (applied == True)
    p_redo = client.post(f"/api/projects/{pid}/redo").json()
    assert p_redo["chat_messages"][1]["proposals"][0]["applied"] is True

    # Delete edit -> proposal re-enabled (applied == False)
    p_del = client.delete(f"/api/projects/{pid}/edits/{edit_id}").json()
    assert p_del["chat_messages"][1]["proposals"][0]["applied"] is False

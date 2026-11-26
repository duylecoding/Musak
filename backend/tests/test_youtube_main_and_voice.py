"""Tests for YouTube main-track loading, Reference-to-Main promotion, and Gemini Voice transcription."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from musak import gemini_agent, main as musak_main
from musak.config import STEM_NAMES
from musak.models import ProjectState
from musak.storage import store
from tests.conftest import make_synthetic_track, wav_bytes_from_array


def test_load_main_track_from_youtube_and_stale_cleanup(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pid = client.post("/api/projects", json={"name": "YT Main Lab"}).json()["id"]

    # Reject invalid YouTube URL
    r_bad = client.post(
        f"/api/projects/{pid}/main-track/youtube",
        json={"url": "https://vimeo.com/123456"},
    )
    assert r_bad.status_code == 400

    # Upload an initial track and create an edit so we verify stale cleanup
    init_wav = wav_bytes_from_array(make_synthetic_track(duration=3.0, bpm=120.0))
    client.post(f"/api/projects/{pid}/main-track", files={"file": ("old.wav", init_wav, "audio/wav")})
    p_ed = client.post(
        f"/api/projects/{pid}/edits",
        json={
            "title": "Old Edit",
            "start": 0.5,
            "end": 1.5,
            "operations": [{"type": "bass_boost", "start": 0.5, "end": 1.5, "gain_db": 5.0}],
        },
    ).json()
    assert len(p_ed["edits"]) == 1
    assert store.rendered_audio_path(pid, 1).is_file()

    # Mock YouTube metadata and audio download (no external network calls)
    monkeypatch.setattr(
        musak_main,
        "fetch_youtube_metadata",
        lambda url: {
            "youtube_id": "dQw4w9WgXcQ",
            "youtube_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "title": "YouTube Banger",
            "duration": 6.0,
        },
    )

    def _fake_download(url: str, output_wav: Path, target_sr: int = 44100) -> Path:
        output_wav.parent.mkdir(parents=True, exist_ok=True)
        audio = make_synthetic_track(duration=6.0, sr=target_sr, bpm=128.0, root_hz=220.0, minor=True)
        sf.write(str(output_wav), audio, target_sr, subtype="PCM_16")
        return output_wav

    monkeypatch.setattr(musak_main, "download_youtube_audio", _fake_download)

    r_yt = client.post(
        f"/api/projects/{pid}/main-track/youtube",
        json={"url": "https://youtu.be/dQw4w9WgXcQ"},
    )
    assert r_yt.status_code == 200
    proj = r_yt.json()
    mt = proj["main_track"]
    assert mt is not None
    assert mt["name"] == "YouTube Banger"
    assert abs(mt["duration"] - 6.0) < 0.05
    assert mt["sample_rate"] == 44100
    assert mt["bpm"] > 0
    assert len(mt["sections"]) >= 1
    assert f"?t={mt['id']}" in mt["audio_url"]
    assert proj["edits"] == []
    assert proj["redo_stack"] == []
    assert proj["render_version"] == 0
    assert not store.rendered_audio_path(pid, 1).exists()

    # Stream newly installed main track
    r_audio = client.get(f"/api/projects/{pid}/audio/main")
    assert r_audio.status_code == 200
    assert r_audio.headers.get("cache-control") == "no-store"

    # Explicit title override works without requiring metadata lookup
    r_custom = client.post(
        f"/api/projects/{pid}/main-track/youtube",
        json={"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "title": "My Custom Title"},
    )
    assert r_custom.status_code == 200
    assert r_custom.json()["main_track"]["name"] == "My Custom Title"


def test_promote_local_reference_with_ready_stems_to_main_track(client: TestClient) -> None:
    pid = client.post("/api/projects", json={"name": "Promote Local"}).json()["id"]
    ref_audio = make_synthetic_track(duration=4.0, sr=44100, bpm=124.0, root_hz=293.66)
    ref_id = client.post(
        f"/api/projects/{pid}/references/upload",
        files={"file": ("groove.wav", wav_bytes_from_array(ref_audio), "audio/wav")},
        data={"title": "Ready Stems Groove"},
    ).json()["references"][0]["id"]

    # Populate all 4 pre-existing reference stem WAVs and mark stems_status == "ready"
    ref_stems_dir = store.reference_stems_dir(pid, ref_id)
    ref_stems_dir.mkdir(parents=True, exist_ok=True)
    for stem in STEM_NAMES:
        sf.write(str(ref_stems_dir / f"{stem}.wav"), ref_audio * 0.25, 44100, subtype="PCM_16")

    def _mark_ref_stems_ready(proj: ProjectState) -> None:
        proj.references[0].stems_status = "ready"

    store.update_project(pid, _mark_ref_stems_ready)

    # Promote reference -> main track should immediately reuse all 4 stems!
    r_prom = client.post(f"/api/projects/{pid}/main-track/from-reference/{ref_id}")
    assert r_prom.status_code == 200
    proj = r_prom.json()
    mt = proj["main_track"]
    assert mt is not None
    assert mt["name"] == "Ready Stems Groove"
    assert abs(mt["duration"] - 4.0) < 0.05
    assert mt["stems_status"] == "ready"
    assert mt["stems"] == list(STEM_NAMES)
    assert set(mt["stem_urls"].keys()) == set(STEM_NAMES)
    assert f"?t={mt['id']}" in mt["stem_urls"]["vocals"]

    # Every main stem file exists on disk and streams cleanly
    for stem in STEM_NAMES:
        assert store.main_stem_path(pid, stem).is_file()
        r_stem = client.get(f"/api/projects/{pid}/audio/stem/{stem}")
        assert r_stem.status_code == 200
        assert r_stem.headers.get("cache-control") == "no-store"

    # Reference's own audio and stems remain intact
    assert store.reference_audio_path(pid, ref_id).is_file()
    assert store.reference_stem_path(pid, ref_id, "vocals").is_file()


def test_promote_youtube_reference_triggers_on_demand_download(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pid = client.post("/api/projects", json={"name": "Promote YT"}).json()["id"]

    # 404 on unknown ref_id
    assert client.post(f"/api/projects/{pid}/main-track/from-reference/ref_missing").status_code == 404

    monkeypatch.setattr(
        musak_main,
        "fetch_youtube_metadata",
        lambda url: {
            "youtube_id": "dQw4w9WgXcQ",
            "youtube_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "title": "YT Reference Track",
            "duration": 5.0,
        },
    )
    ref_id = client.post(
        f"/api/projects/{pid}/references/youtube",
        json={"url": "https://youtu.be/dQw4w9WgXcQ"},
    ).json()["references"][0]["id"]

    download_calls: list[str] = []

    def _fake_download(url: str, output_wav: Path, target_sr: int = 44100) -> Path:
        download_calls.append(url)
        output_wav.parent.mkdir(parents=True, exist_ok=True)
        audio = make_synthetic_track(duration=5.0, sr=target_sr, bpm=118.0)
        sf.write(str(output_wav), audio, target_sr, subtype="PCM_16")
        return output_wav

    monkeypatch.setattr(musak_main, "download_youtube_audio", _fake_download)

    r_prom = client.post(f"/api/projects/{pid}/main-track/from-reference/{ref_id}")
    assert r_prom.status_code == 200
    assert len(download_calls) == 1

    proj = r_prom.json()
    mt = proj["main_track"]
    assert mt is not None
    assert mt["name"] == "YT Reference Track"
    assert abs(mt["duration"] - 5.0) < 0.05
    assert mt["stems_status"] == "none"

    # Reference itself is also updated with downloaded audio metadata
    ref = proj["references"][0]
    assert ref["audio_downloaded"] is True
    assert ref["bpm"] is not None
    assert ref["key"] is not None
    assert ref["audio_url"] == f"/api/projects/{pid}/references/{ref_id}/audio"
    assert client.get(ref["audio_url"]).status_code == 200


def test_voice_transcribe_endpoint(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sample_bytes = b"\x1a\x45\xdf\xa3fake-webm-opus-audio-bytes"

    # Missing API key -> 400
    r_nokey = client.post(
        "/api/voice/transcribe",
        files={"file": ("voice.webm", sample_bytes, "audio/webm;codecs=opus")},
    )
    assert r_nokey.status_code == 400

    # Configure in-memory key
    client.post("/api/settings/api-key", json={"api_key": "fake-voice-key"})

    # Empty upload -> 400
    r_empty = client.post(
        "/api/voice/transcribe",
        files={"file": ("voice.webm", b"", "audio/webm;codecs=opus")},
    )
    assert r_empty.status_code == 400

    # Unsupported non-audio MIME & extension -> 400
    r_bad_mime = client.post(
        "/api/voice/transcribe",
        files={"file": ("notes.txt", b"hello", "text/plain")},
    )
    assert r_bad_mime.status_code == 400

    # Oversized upload (> 15 MB) -> 400
    monkeypatch.setattr(musak_main, "MAX_VOICE_UPLOAD_BYTES", 32)
    r_big = client.post(
        "/api/voice/transcribe",
        files={"file": ("big.webm", b"x" * 64, "audio/webm")},
    )
    assert r_big.status_code == 400
    monkeypatch.setattr(musak_main, "MAX_VOICE_UPLOAD_BYTES", 15 * 1024 * 1024)

    # Mock Gemini client and capture the Part sent to generate_content
    captured: list[Any] = []

    class _FakeModels:
        def generate_content(self, *, model: str, contents: Any, config: Any) -> Any:
            captured.append({"model": model, "contents": contents, "config": config})
            return SimpleNamespace(text='"Drop the drums at 0:45 and sweep into 1:12 like Daft Punk"')

    class _FakeClient:
        def __init__(self, api_key: str) -> None:
            self.api_key = api_key
            self.models = _FakeModels()

    monkeypatch.setattr(gemini_agent.genai, "Client", _FakeClient)

    # Codec parameter in Content-Type (`audio/webm;codecs=opus`) is stripped to `audio/webm`
    r_ok = client.post(
        "/api/voice/transcribe",
        files={"file": ("recording.webm", sample_bytes, "audio/webm;codecs=opus")},
    )
    assert r_ok.status_code == 200
    assert r_ok.json() == {"text": "Drop the drums at 0:45 and sweep into 1:12 like Daft Punk"}

    inline_parts = [p for p in captured[0]["contents"] if getattr(p, "inline_data", None) is not None]
    assert len(inline_parts) == 1
    assert inline_parts[0].inline_data.mime_type == "audio/webm"
    assert inline_parts[0].inline_data.data == sample_bytes

    # Fallback by filename extension when Content-Type is generic `application/octet-stream`
    captured.clear()
    r_ogg = client.post(
        "/api/voice/transcribe",
        files={"file": ("clip.ogg", sample_bytes, "application/octet-stream")},
    )
    assert r_ogg.status_code == 200
    ogg_parts = [p for p in captured[0]["contents"] if getattr(p, "inline_data", None) is not None]
    assert ogg_parts[0].inline_data.mime_type == "audio/ogg"


def test_versioned_main_audio_files_and_legacy_fallback(client: TestClient) -> None:
    pid = client.post("/api/projects", json={"name": "Versioned Main"}).json()["id"]
    wav_a = wav_bytes_from_array(make_synthetic_track(duration=2.0, bpm=120.0))
    p_a = client.post(f"/api/projects/{pid}/main-track", files={"file": ("a.wav", wav_a, "audio/wav")}).json()
    tid_a = p_a["main_track"]["id"]

    path_a = store.main_audio_path(pid, tid_a)
    assert path_a.name == f"main_{tid_a}.wav"
    assert path_a.is_file()

    # Upload Track B -> writes main_{tid_b}.wav and prunes main_{tid_a}.wav
    wav_b = wav_bytes_from_array(make_synthetic_track(duration=3.0, bpm=128.0))
    p_b = client.post(f"/api/projects/{pid}/main-track", files={"file": ("b.wav", wav_b, "audio/wav")}).json()
    tid_b = p_b["main_track"]["id"]
    path_b = store.main_audio_path(pid, tid_b)
    assert path_b.is_file()
    assert not path_a.exists()

    # Backwards-compatible fallback to legacy main.wav when versioned file is absent
    legacy_path = store.main_audio_path(pid)
    path_b.replace(legacy_path)
    assert store.get_main_audio_path(pid, tid_b) == legacy_path
    assert client.get(f"/api/projects/{pid}/audio/main").status_code == 200


def test_reference_stem_worker_downloads_youtube_and_separates(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import time

    from musak import stems as stems_mod

    pid = client.post("/api/projects", json={"name": "YT Ref Stems"}).json()["id"]
    monkeypatch.setattr(
        musak_main,
        "fetch_youtube_metadata",
        lambda url: {
            "youtube_id": "dQw4w9WgXcQ",
            "youtube_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "title": "YT Stems Ref",
            "duration": 3.0,
        },
    )
    ref_id = client.post(
        f"/api/projects/{pid}/references/youtube",
        json={"url": "https://youtu.be/dQw4w9WgXcQ"},
    ).json()["references"][0]["id"]

    dl_calls: list[str] = []

    def _fake_yt_download(url: str, output_wav: Path, target_sr: int = 44100) -> Path:
        dl_calls.append(url)
        output_wav.parent.mkdir(parents=True, exist_ok=True)
        sf.write(str(output_wav), make_synthetic_track(duration=3.0, sr=target_sr), target_sr, subtype="PCM_16")
        return output_wav

    def _fake_separate(input_wav: Path, output_dir: Path) -> list[str]:
        output_dir.mkdir(parents=True, exist_ok=True)
        data, sr = sf.read(str(input_wav), dtype="float32", always_2d=True)
        for stem in STEM_NAMES:
            sf.write(str(output_dir / f"{stem}.wav"), data * 0.25, int(sr), subtype="PCM_16")
        return list(STEM_NAMES)

    monkeypatch.setattr(stems_mod, "download_youtube_audio", _fake_yt_download)
    monkeypatch.setattr(stems_mod, "separate_audio_file", _fake_separate)

    r_ext = client.post(f"/api/projects/{pid}/references/{ref_id}/extract-stems")
    assert r_ext.status_code == 200

    final_ref = None
    for _ in range(60):
        state = client.get(f"/api/projects/{pid}").json()
        ref = state["references"][0]
        if ref["stems_status"] in ("ready", "error"):
            final_ref = ref
            break
        time.sleep(0.05)

    assert final_ref is not None
    assert final_ref["stems_status"] == "ready", f"Unexpected error: {final_ref.get('stems_error')}"
    assert final_ref["audio_downloaded"] is True
    assert len(dl_calls) == 1
    assert store.reference_audio_path(pid, ref_id).is_file()
    for stem in STEM_NAMES:
        assert store.reference_stem_path(pid, ref_id, stem).is_file()


def test_promote_reference_deleted_mid_download_returns_404(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pid = client.post("/api/projects", json={"name": "Deleted Ref Race"}).json()["id"]
    monkeypatch.setattr(
        musak_main,
        "fetch_youtube_metadata",
        lambda url: {
            "youtube_id": "dQw4w9WgXcQ",
            "youtube_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "title": "Vanishing Ref",
            "duration": 3.0,
        },
    )
    ref_id = client.post(
        f"/api/projects/{pid}/references/youtube",
        json={"url": "https://youtu.be/dQw4w9WgXcQ"},
    ).json()["references"][0]["id"]

    def _download_and_delete_ref(url: str, output_wav: Path, target_sr: int = 44100) -> Path:
        sf.write(str(output_wav), make_synthetic_track(duration=2.0, sr=target_sr), target_sr, subtype="PCM_16")

        # Simulate concurrent deletion of the reference while download was running
        def _drop_ref(proj: ProjectState) -> None:
            proj.references = [r for r in proj.references if r.id != ref_id]

        store.update_project(pid, _drop_ref)
        return output_wav

    monkeypatch.setattr(musak_main, "download_youtube_audio", _download_and_delete_ref)
    r = client.post(f"/api/projects/{pid}/main-track/from-reference/{ref_id}")
    assert r.status_code == 404

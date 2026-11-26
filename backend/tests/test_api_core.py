"""Core API tests: health, in-memory API key, project CRUD, path traversal, upload/analysis, export."""

from __future__ import annotations

from pathlib import Path

import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from musak.storage import InvalidIdError, store
from tests.conftest import make_synthetic_track, wav_bytes_from_array


def test_health_and_in_memory_api_key(client: TestClient, data_dir: Path) -> None:
    resp = client.get("/api/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert isinstance(body["cuda_available"], bool)
    assert isinstance(body["ffmpeg_available"], bool)
    assert body["api_key_configured"] is False
    assert body["model"]

    secret = "test-in-memory-only-dummy-value"
    r_set = client.post("/api/settings/api-key", json={"api_key": secret})
    assert r_set.status_code == 200
    assert r_set.json() == {"api_key_configured": True}

    assert client.get("/api/health").json()["api_key_configured"] is True

    # Ensure key was NEVER persisted anywhere inside data_dir or backend directory
    for root in (data_dir, Path(__file__).resolve().parents[1]):
        for p in root.rglob("*"):
            if p.is_file() and ".venv" not in p.parts and "__pycache__" not in p.parts and p.name != "test_api_core.py":
                try:
                    if p.stat().st_size < 2_000_000:
                        assert secret not in p.read_text(encoding="utf-8", errors="ignore"), f"Key leaked into {p}"
                except OSError:
                    continue

    r_del = client.delete("/api/settings/api-key")
    assert r_del.status_code == 200
    assert r_del.json() == {"api_key_configured": False}
    assert client.get("/api/health").json()["api_key_configured"] is False


def test_project_crud_and_path_traversal_rejection(client: TestClient) -> None:
    assert client.get("/api/projects").json() == {"projects": []}

    created = client.post("/api/projects", json={"name": "Summer Mashup"}).json()
    pid = created["id"]
    assert created["name"] == "Summer Mashup"
    assert created["main_track"] is None
    assert created["render_version"] == 0

    listed = client.get("/api/projects").json()["projects"]
    assert len(listed) == 1
    assert listed[0]["id"] == pid
    assert listed[0]["has_main_track"] is False

    fetched = client.get(f"/api/projects/{pid}").json()
    assert fetched["id"] == pid

    # Strict ID / path traversal rejection at HTTP layer and storage layer
    for bad_id in ("..%5Csecret", "bad$id", "has space", "dot.name"):
        r = client.get(f"/api/projects/{bad_id}")
        assert r.status_code == 400, f"Expected 400 for bad id {bad_id}, got {r.status_code}"

    # Encoded slash traversal is blocked by router (404) or validator (400), never allowed
    assert client.get("/api/projects/..%2Fsecret").status_code in (400, 404)

    for traversal in ("../secret", "..\\evil", "..", "a/b", "proj.json"):
        with pytest.raises(InvalidIdError):
            store.get_project(traversal)

    # Invalid stem name rejected
    assert client.get(f"/api/projects/{pid}/audio/stem/invalid_stem").status_code == 400
    assert client.get(f"/api/projects/{pid}/audio/stem/..%2Fmain").status_code in (400, 404)

    # Delete project
    r_del = client.delete(f"/api/projects/{pid}")
    assert r_del.status_code == 200
    assert r_del.json() == {"deleted": True}

    assert client.get(f"/api/projects/{pid}").status_code == 404


def test_main_track_upload_analysis_streaming_and_export(client: TestClient, data_dir: Path) -> None:
    pid = client.post("/api/projects", json={"name": "Beat Lab"}).json()["id"]

    audio = make_synthetic_track(duration=8.0, sr=44100, bpm=120.0, root_hz=261.63)
    wav_bytes = wav_bytes_from_array(audio, 44100)

    r = client.post(
        f"/api/projects/{pid}/main-track",
        files={"file": ("demo_song.wav", wav_bytes, "audio/wav")},
    )
    assert r.status_code == 200
    proj = r.json()
    mt = proj["main_track"]
    assert mt is not None
    assert mt["name"] == "demo_song"
    assert abs(mt["duration"] - 8.0) < 0.05
    assert mt["sample_rate"] == 44100
    assert 60.0 <= mt["bpm"] <= 200.0
    assert "Major" in mt["key"] or "Minor" in mt["key"]
    assert len(mt["beats"]) > 0

    # Sections must contiguously cover [0, duration]
    sections = mt["sections"]
    assert len(sections) >= 1
    assert sections[0]["start"] == 0.0
    assert abs(sections[-1]["end"] - mt["duration"]) < 0.02
    for prev, nxt in zip(sections[:-1], sections[1:]):
        assert abs(prev["end"] - nxt["start"]) < 0.01

    # Audio streaming endpoints work (rendered falls back to main)
    r_main = client.get(f"/api/projects/{pid}/audio/main")
    assert r_main.status_code == 200
    assert len(r_main.content) > 1000

    r_rend = client.get(f"/api/projects/{pid}/audio/rendered")
    assert r_rend.status_code == 200
    assert len(r_rend.content) > 1000

    # WAV export returns downloadable valid WAV
    r_exp = client.post(f"/api/projects/{pid}/export", json={"format": "wav"})
    assert r_exp.status_code == 200
    assert "attachment" in r_exp.headers.get("content-disposition", "").lower()
    exp_path = data_dir / "exported_check.wav"
    exp_path.write_bytes(r_exp.content)
    data, sr = sf.read(str(exp_path))
    assert sr == 44100
    assert data.ndim == 2 and data.shape[1] == 2

    # MP3 export also succeeds when ffmpeg or libsndfile MP3 is available
    if "MP3" in sf.available_formats():
        r_mp3 = client.post(f"/api/projects/{pid}/export", json={"format": "mp3"})
        assert r_mp3.status_code == 200
        assert len(r_mp3.content) > 500


def test_background_stem_separation_state_transitions(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import time

    from musak import stems as stems_mod

    pid = client.post("/api/projects", json={"name": "Stems Test"}).json()["id"]
    audio = make_synthetic_track(duration=2.0, sr=44100, bpm=120.0)
    assert (
        client.post(
            f"/api/projects/{pid}/main-track",
            files={"file": ("stems_song.wav", wav_bytes_from_array(audio), "audio/wav")},
        ).status_code
        == 200
    )

    def _fake_separate(input_wav: Path, output_dir: Path) -> list[str]:
        output_dir.mkdir(parents=True, exist_ok=True)
        data, sr = sf.read(str(input_wav), dtype="float32", always_2d=True)
        for name in ("vocals", "drums", "bass", "other"):
            sf.write(str(output_dir / f"{name}.wav"), data * 0.25, int(sr), subtype="PCM_16")
        return ["vocals", "drums", "bass", "other"]

    monkeypatch.setattr(stems_mod, "separate_audio_file", _fake_separate)

    r_sep = client.post(f"/api/projects/{pid}/main-track/separate")
    assert r_sep.status_code == 200
    assert r_sep.json()["main_track"]["stems_status"] in ("processing", "ready")

    # Wait briefly for background worker thread to finish
    final_state = None
    for _ in range(40):
        state = client.get(f"/api/projects/{pid}").json()
        if state["main_track"]["stems_status"] == "ready":
            final_state = state
            break
        time.sleep(0.05)

    assert final_state is not None
    assert final_state["main_track"]["stems"] == ["vocals", "drums", "bass", "other"]
    assert "vocals" in final_state["main_track"]["stem_urls"]
    r_stem = client.get(f"/api/projects/{pid}/audio/stem/vocals")
    assert r_stem.status_code == 200
    assert len(r_stem.content) > 1000


def test_local_reference_and_moment_pins_crud(client: TestClient) -> None:
    pid = client.post("/api/projects", json={"name": "Ref Shelf"}).json()["id"]
    ref_wav = wav_bytes_from_array(make_synthetic_track(duration=4.0, bpm=128.0, root_hz=220.0, minor=True))

    r_up = client.post(
        f"/api/projects/{pid}/references/upload",
        files={"file": ("hook_ref.wav", ref_wav, "audio/wav")},
        data={"title": "Cool Synth Hook"},
    )
    assert r_up.status_code == 200
    refs = r_up.json()["references"]
    assert len(refs) == 1
    ref = refs[0]
    assert ref["title"] == "Cool Synth Hook"
    assert ref["source_type"] == "local"
    assert ref["audio_downloaded"] is True
    assert ref["bpm"] is not None
    assert ref["key"] is not None

    # Stream ref audio
    assert client.get(f"/api/projects/{pid}/references/{ref['id']}/audio").status_code == 200

    # Pin moment
    r_pin = client.post(
        f"/api/projects/{pid}/references/{ref['id']}/moments",
        json={"label": "Big Drop", "start": 1.0, "end": 3.0, "note": "Love the kick energy"},
    )
    assert r_pin.status_code == 200
    moments = r_pin.json()["references"][0]["moments"]
    assert len(moments) == 1
    assert moments[0]["source"] == "user"
    mom_id = moments[0]["id"]

    # Delete moment
    r_del_mom = client.delete(f"/api/projects/{pid}/references/{ref['id']}/moments/{mom_id}")
    assert r_del_mom.status_code == 200
    assert r_del_mom.json()["references"][0]["moments"] == []

    # Delete reference
    r_del_ref = client.delete(f"/api/projects/{pid}/references/{ref['id']}")
    assert r_del_ref.status_code == 200
    assert r_del_ref.json()["references"] == []


def test_rename_project_endpoint(client: TestClient) -> None:
    created = client.post("/api/projects", json={"name": "Draft Mix"}).json()
    pid = created["id"]

    r_ren = client.patch(f"/api/projects/{pid}", json={"name": "  Festival Club Edit  "})
    assert r_ren.status_code == 200
    assert r_ren.json()["name"] == "Festival Club Edit"

    # Reflected in GET /api/projects/{id} and GET /api/projects
    assert client.get(f"/api/projects/{pid}").json()["name"] == "Festival Club Edit"
    listed = client.get("/api/projects").json()["projects"]
    assert listed[0]["id"] == pid
    assert listed[0]["name"] == "Festival Club Edit"

    # Rejects blank / whitespace-only names with 422
    assert client.patch(f"/api/projects/{pid}", json={"name": "   "}).status_code == 422
    assert client.patch(f"/api/projects/{pid}", json={"name": ""}).status_code == 422

    # Returns 404 for unknown project ID
    assert client.patch("/api/projects/proj_missing123", json={"name": "Valid Name"}).status_code == 404

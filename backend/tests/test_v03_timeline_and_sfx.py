"""Comprehensive tests for Musak v0.3 upgrades: stem device, waveform peaks, SFX library & DSP,
drag/resize/gain PATCH edits, fast sliced previews, YouTube oEmbed, auto-separate, and lane-aware chat.
"""

from __future__ import annotations

import io
import json
import time
import urllib.request
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from musak import gemini_agent, stems as stems_mod, youtube
from musak.routers import deps as deps_mod
from musak.audio_analysis import compute_waveform_peaks
from musak.config import STEM_NAMES, get_stem_device
from musak.dsp import MAX_PREVIEW_SECONDS, render_operations, render_proposal_preview, tune_proposal_operations
from musak.models import EditOperation, EditProposal, ProjectState
from musak.sfx import KNOWN_SFX_IDS, synthesize_sfx
from musak.storage import store
from tests.conftest import make_synthetic_track, wav_bytes_from_array


def _create_project_with_main(
    client: TestClient,
    duration: float = 8.0,
    bpm: float = 120.0,
    with_stems: bool = False,
) -> str:
    pid = client.post("/api/projects", json={"name": "v0.3 Studio"}).json()["id"]
    audio = make_synthetic_track(duration=duration, sr=44100, bpm=bpm, root_hz=261.63, varying_energy=True)
    resp = client.post(
        f"/api/projects/{pid}/main-track",
        files={"file": ("track.wav", wav_bytes_from_array(audio), "audio/wav")},
    )
    assert resp.status_code == 200

    if with_stems:
        sr = 44100
        n_samples = int(round(duration * sr))
        t = np.arange(n_samples, dtype=np.float32) / float(sr)
        stems_dir = store.main_stems_dir(pid)
        stems_dir.mkdir(parents=True, exist_ok=True)
        freqs = {"vocals": 880.0, "drums": 110.0, "bass": 65.0, "other": 330.0}
        for name, hz in freqs.items():
            tone = np.stack([0.2 * np.sin(2.0 * np.pi * hz * t)] * 2, axis=-1).astype(np.float32)
            sf.write(str(stems_dir / f"{name}.wav"), tone, sr, subtype="PCM_16")

        def _mark_ready(proj: ProjectState) -> None:
            assert proj.main_track is not None
            proj.main_track.stems_status = "ready"
            proj.main_track.stems = list(STEM_NAMES)
            proj.main_track.stem_urls = store.stem_urls(pid, list(STEM_NAMES), track_id=proj.main_track.id)
            proj.main_track.bpm = bpm

        store.update_project(pid, _mark_ready)

    return pid


def test_stem_device_setting_and_health(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    h0 = client.get("/api/health")
    assert h0.status_code == 200
    assert h0.json()["stem_device"] == "auto"

    for dev in ("cpu", "cuda", "auto"):
        r = client.post("/api/settings/stem-device", json={"device": dev})
        assert r.status_code == 200
        assert r.json() == {"stem_device": dev}
        assert get_stem_device() == dev
        assert client.get("/api/health").json()["stem_device"] == dev

    assert client.post("/api/settings/stem-device", json={"device": "tpu"}).status_code == 422

    # Verify stems.py respects "cpu" even if torch.cuda.is_available() is True
    import torch

    chosen_devices: list[str] = []

    class _FakeModel:
        samplerate = 44100
        sources = ["drums", "bass", "other", "vocals"]

        def eval(self) -> None:
            pass

    def _fake_apply(model: Any, wav_tensor: Any, device: str) -> Any:
        chosen_devices.append(device)
        return torch.zeros((1, 4, 2, wav_tensor.shape[-1]), dtype=torch.float32)

    monkeypatch.setattr(stems_mod, "_get_htdemucs_model", lambda: _FakeModel())
    monkeypatch.setattr(stems_mod, "_run_demucs_apply", _fake_apply)
    monkeypatch.setattr(torch.cuda, "is_available", lambda: True)

    pid = _create_project_with_main(client, duration=1.0, with_stems=False)
    proj = store.get_project(pid)
    assert proj.main_track is not None
    main_wav = store.get_main_audio_path(pid, proj.main_track.id)
    out_dir = store.project_dir(pid) / "test_stems"

    client.post("/api/settings/stem-device", json={"device": "cpu"})
    stems_mod.separate_audio_file(main_wav, out_dir)
    assert chosen_devices[-1] == "cpu"

    client.post("/api/settings/stem-device", json={"device": "auto"})
    stems_mod.separate_audio_file(main_wav, out_dir)
    assert chosen_devices[-1] == "cuda"


def test_waveform_peaks_endpoint_main_rendered_and_stems(client: TestClient, tmp_path: Path) -> None:
    pid = _create_project_with_main(client, duration=4.0, with_stems=True)

    # Before any edits, rendered is None and stems are populated
    r1 = client.get(f"/api/projects/{pid}/peaks?buckets=100")
    assert r1.status_code == 200
    body1 = r1.json()
    assert body1["buckets"] == 100
    assert body1["duration"] == pytest.approx(4.0, abs=0.05)
    assert len(body1["main"]) == 100
    assert max(body1["main"]) == pytest.approx(1.0, abs=0.01)
    assert min(body1["main"]) >= 0.0
    assert body1["rendered"] is None
    assert set(body1["stems"].keys()) == set(STEM_NAMES)
    for stem_peaks in body1["stems"].values():
        assert len(stem_peaks) == 100
        assert max(stem_peaks) == pytest.approx(1.0, abs=0.01)

    # Apply an edit -> rendered peaks are also computed
    r_edit = client.post(
        f"/api/projects/{pid}/edits",
        json={
            "title": "Vocal Mute",
            "start": 1.0,
            "end": 2.5,
            "operations": [{"type": "stem_gain", "stems": ["vocals"], "start": 1.0, "end": 2.5, "gain_db": -80.0}],
        },
    )
    assert r_edit.status_code == 200

    r2 = client.get(f"/api/projects/{pid}/peaks?buckets=80")
    assert r2.status_code == 200
    body2 = r2.json()
    assert body2["rendered"] is not None
    assert len(body2["rendered"]) == 80
    assert max(body2["rendered"]) == pytest.approx(1.0, abs=0.01)

    # Silent WAV edge case
    silent_path = tmp_path / "silent.wav"
    sf.write(str(silent_path), np.zeros((4410, 2), dtype=np.float32), 44100, subtype="PCM_16")
    assert compute_waveform_peaks(silent_path, buckets=50) == [0.0] * 50


def test_sfx_library_preview_and_dsp_rendering(client: TestClient) -> None:
    r_list = client.get("/api/sfx")
    assert r_list.status_code == 200
    items = r_list.json()["items"]
    assert len(items) == 6
    assert {item["id"] for item in items} == set(KNOWN_SFX_IDS)

    # Every SFX ID synthesizes fast, deterministically, stereo 44.1 kHz, non-silent, and streams preview WAV
    for item in items:
        sfx_id = item["id"]
        t0 = time.perf_counter()
        a1 = synthesize_sfx(sfx_id, duration=1.5, sr=44100, bpm=128.0)
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        a2 = synthesize_sfx(sfx_id, duration=1.5, sr=44100, bpm=128.0)
        assert elapsed_ms < 250.0  # comfortably fast even on loaded CI runners
        assert a1.shape == (int(round(1.5 * 44100)), 2)
        assert np.allclose(a1, a2)
        assert float(np.max(np.abs(a1))) > 0.1
        assert not np.any(np.isnan(a1))

        r_prev = client.get(f"{item['preview_url']}?bpm=128&duration=1.5")
        assert r_prev.status_code == 200
        assert r_prev.headers["content-type"].startswith("audio/wav")
        buf = io.BytesIO(r_prev.content)
        data, sr = sf.read(buf, dtype="float32", always_2d=True)
        assert sr == 44100
        assert data.shape[1] == 2
        assert len(data) == int(round(1.5 * 44100))

    assert client.get("/api/sfx/does_not_exist/preview").status_code == 404

    # Render all 6 SFX IDs via DSP "add_sfx" operation and verify mix changes only in [start, end]
    pid = _create_project_with_main(client, duration=8.0, bpm=120.0, with_stems=True)
    proj = store.get_project(pid)
    assert proj.main_track is not None
    dry, _ = render_operations(store, proj, [])

    for sfx_id in sorted(KNOWN_SFX_IDS):
        op = EditOperation(
            type="add_sfx",
            sfx_id=sfx_id,
            layer_id="sfx_lane_1",
            start=2.0,
            end=4.0,
            gain_db=0.0,
            snap_to_beat=False,
        )
        mixed, sr = render_operations(store, proj, [op])
        assert sr == 44100
        assert mixed.shape == dry.shape
        assert not np.any(np.isnan(mixed))
        assert float(np.max(np.abs(mixed))) <= 0.999
        # Outside [2.0, 4.0] untouched; inside [2.0, 4.0] audibly layered
        assert np.allclose(mixed[: int(1.9 * sr)], dry[: int(1.9 * sr)], atol=1e-4)
        assert float(np.mean(np.abs(mixed[int(2.1 * sr) : int(3.9 * sr)] - dry[int(2.1 * sr) : int(3.9 * sr)]))) > 0.01

    # tune_proposal_operations handles add_sfx intensity and beat shift
    tuned = tune_proposal_operations(
        [EditOperation(type="add_sfx", sfx_id="riser_noise", start=2.0, end=4.0, gain_db=0.0)],
        intensity=1.5,
        keep_vocals_clear=True,
        shift_beats=2.0,
        bpm=120.0,
        duration=8.0,
    )
    assert len(tuned) == 1
    assert tuned[0].start == 3.0
    assert tuned[0].end == 5.0
    assert tuned[0].gain_db == pytest.approx(3.0, abs=0.01)


def test_patch_edit_move_resize_title_and_gain_db(client: TestClient) -> None:
    pid = _create_project_with_main(client, duration=8.0, bpm=120.0, with_stems=True)

    r_create = client.post(
        f"/api/projects/{pid}/edits",
        json={
            "title": "Noise Riser",
            "start": 1.0,
            "end": 3.0,
            "operations": [
                {
                    "type": "add_sfx",
                    "sfx_id": "riser_noise",
                    "start": 1.25,
                    "end": 2.75,
                    "gain_db": -6.0,
                    "snap_to_beat": False,
                }
            ],
        },
    )
    assert r_create.status_code == 200
    edit_id = r_create.json()["edits"][0]["id"]

    # Validation errors on bad title or end <= start
    assert client.patch(f"/api/projects/{pid}/edits/{edit_id}", json={"title": "   "}).status_code == 422
    assert client.patch(f"/api/projects/{pid}/edits/{edit_id}", json={"start": 4.0, "end": 3.0}).status_code == 422

    # Move block by +2.0s while keeping span=2.0 -> relative offsets (+0.25, +1.75) preserved
    r_move = client.patch(
        f"/api/projects/{pid}/edits/{edit_id}",
        json={"start": 3.0, "end": 5.0, "title": "  Drop Riser  ", "gain_db": 2.0},
    )
    assert r_move.status_code == 200
    moved = r_move.json()["edits"][0]
    assert moved["title"] == "Drop Riser"
    assert moved["start"] == 3.0
    assert moved["end"] == 5.0
    assert moved["operations"][0]["start"] == pytest.approx(3.25, abs=0.01)
    assert moved["operations"][0]["end"] == pytest.approx(4.75, abs=0.01)
    assert moved["operations"][0]["gain_db"] == pytest.approx(2.0, abs=0.01)

    # Resize block from [3.0, 5.0] (span 2.0) to [3.0, 7.0] (span 4.0) -> scales op offsets by 2x
    r_resize = client.patch(
        f"/api/projects/{pid}/edits/{edit_id}",
        json={"start": 3.0, "end": 7.0},
    )
    assert r_resize.status_code == 200
    resized = r_resize.json()["edits"][0]
    assert resized["start"] == 3.0
    assert resized["end"] == 7.0
    assert resized["operations"][0]["start"] == pytest.approx(3.5, abs=0.01)
    assert resized["operations"][0]["end"] == pytest.approx(6.5, abs=0.01)

    # Rendered WAV reflects boosted gain_db at new window
    r_wav = client.get(f"/api/projects/{pid}/audio/rendered")
    assert r_wav.status_code == 200
    assert len(r_wav.content) > 1000


def test_fast_sliced_preview_with_stems_does_not_read_full_song(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Create a 26s project with stems so full-song length > MAX_PREVIEW_SECONDS (20s)
    pid = _create_project_with_main(client, duration=26.0, bpm=120.0, with_stems=True)
    proj = store.get_project(pid)
    assert proj.main_track is not None

    read_calls: list[tuple[Any, Any]] = []
    orig_sf_read = sf.read

    def _spy_read(file: Any, *args: Any, **kwargs: Any) -> Any:
        read_calls.append((kwargs.get("start"), kwargs.get("stop")))
        return orig_sf_read(file, *args, **kwargs)

    monkeypatch.setattr(sf, "read", _spy_read)

    prop = EditProposal(
        id="prop_sliced_stem_test",
        title="Chorus Vocal Reverb + Snare Roll",
        summary="Dreamy chorus vocals with snare buildup.",
        style="creative",
        start=10.0,
        end=14.0,
        operations=[
            EditOperation(
                type="reverb_throw",
                stems=["vocals"],
                start=10.0,
                end=14.0,
                room_size=0.8,
                wet_level=0.5,
                snap_to_beat=False,
            ),
            EditOperation(
                type="add_sfx",
                sfx_id="snare_roll",
                start=10.0,
                end=14.0,
                gain_db=0.0,
                snap_to_beat=False,
            ),
        ],
    )

    prev_path = render_proposal_preview(store, proj, prop, nonce="s1")
    assert prev_path.is_file()
    info = sf.info(str(prev_path))
    prev_dur = info.frames / float(info.samplerate)
    assert 6.5 <= prev_dur <= 7.5  # [8.5, 15.5] = 7.0s slice
    assert prop.preview_start == pytest.approx(8.5, abs=0.05)
    assert prop.preview_end == pytest.approx(15.5, abs=0.05)

    # Every stem read MUST have used bounded [start, stop] frames (< 20s), never full 26s file!
    assert len(read_calls) == 4
    total_frames_26s = int(round(26.0 * 44100))
    for s_frame, e_frame in read_calls:
        assert s_frame is not None and e_frame is not None
        assert (e_frame - s_frame) < total_frames_26s
        assert (e_frame - s_frame) <= int(round((MAX_PREVIEW_SECONDS + 0.1) * 44100))


def test_youtube_oembed_fast_path_and_ytdlp_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    class _FakeResp:
        def __init__(self, payload: dict[str, Any]) -> None:
            self._data = json.dumps(payload).encode("utf-8")

        def read(self) -> bytes:
            return self._data

        def __enter__(self) -> _FakeResp:
            return self

        def __exit__(self, *args: Any) -> None:
            return None

    seen_urls: list[str] = []

    def _fake_urlopen(url: str, timeout: float = 3.0) -> _FakeResp:
        seen_urls.append(url)
        return _FakeResp({"title": "Daft Punk - One More Time (Official Audio)"})

    monkeypatch.setattr(urllib.request, "urlopen", _fake_urlopen)

    # Ensure yt-dlp is NOT invoked when oEmbed succeeds
    import yt_dlp

    def _forbid_ytdlp(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("yt_dlp should not be called when YouTube oEmbed succeeds!")

    monkeypatch.setattr(yt_dlp, "YoutubeDL", _forbid_ytdlp)

    meta = youtube.fetch_youtube_metadata("https://youtu.be/FGBhQbmPwH8")
    assert len(seen_urls) == 1
    assert "youtube.com/oembed" in seen_urls[0]
    assert meta["youtube_id"] == "FGBhQbmPwH8"
    assert meta["title"] == "Daft Punk - One More Time (Official Audio)"
    assert meta["duration"] is None

    # Fallback to yt-dlp when oEmbed fails
    def _failing_urlopen(url: str, timeout: float = 3.0) -> Any:
        raise OSError("network timeout")

    class _FakeYdl:
        def __init__(self, opts: dict[str, Any]) -> None:
            pass

        def __enter__(self) -> _FakeYdl:
            return self

        def __exit__(self, *args: Any) -> None:
            return None

        def extract_info(self, url: str, download: bool = False) -> dict[str, Any]:
            return {"title": "Fallback Song", "duration": 212.5}

    monkeypatch.setattr(urllib.request, "urlopen", _failing_urlopen)
    monkeypatch.setattr(yt_dlp, "YoutubeDL", _FakeYdl)

    meta2 = youtube.fetch_youtube_metadata("https://www.youtube.com/watch?v=FGBhQbmPwH8")
    assert meta2["title"] == "Fallback Song"
    assert meta2["duration"] == 212.5


def test_auto_separate_trigger_when_enabled(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    def _fake_start_main(s: Any, project_id: str) -> ProjectState:
        calls.append(project_id)

        def _mark(p: ProjectState) -> None:
            if p.main_track is not None:
                p.main_track.stems_status = "processing"

        return s.update_project(project_id, _mark)

    monkeypatch.setattr(deps_mod, "start_main_stem_separation", _fake_start_main)

    pid = client.post("/api/projects", json={"name": "AutoSep"}).json()["id"]
    audio = make_synthetic_track(duration=2.0, sr=44100, bpm=120.0)

    # With MUSAK_DISABLE_AUTO_SEPARATE=1 (from fixture), auto-separate does NOT run
    r1 = client.post(
        f"/api/projects/{pid}/main-track",
        files={"file": ("song1.wav", wav_bytes_from_array(audio), "audio/wav")},
    )
    assert r1.status_code == 200
    assert r1.json()["main_track"]["stems_status"] == "none"
    assert calls == []

    # Unset MUSAK_DISABLE_AUTO_SEPARATE -> auto-separate triggers automatically on upload!
    monkeypatch.delenv("MUSAK_DISABLE_AUTO_SEPARATE", raising=False)
    r2 = client.post(
        f"/api/projects/{pid}/main-track",
        files={"file": ("song2.wav", wav_bytes_from_array(audio), "audio/wav")},
    )
    assert r2.status_code == 200
    assert r2.json()["main_track"]["stems_status"] == "processing"
    assert calls == [pid]


def test_lane_aware_chat_and_add_sfx_proposal(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pid = _create_project_with_main(client, duration=8.0, bpm=120.0, with_stems=True)
    client.post("/api/settings/api-key", json={"api_key": "test-dummy-key"})

    captured_contents: list[Any] = []

    class _FakeModels:
        def generate_content(self, *, model: str, contents: Any, config: Any) -> Any:
            captured_contents.append(contents)
            return SimpleNamespace(
                text=json.dumps(
                    {
                        "reply": "Added a crisp vocal reverb and noise riser into the drop.",
                        "proposals": [
                            {
                                "title": "Vocal Lift + Riser",
                                "summary": "Focus reverb on vocals with a transition riser.",
                                "style": "creative",
                                "start": 2.0,
                                "end": 6.0,
                                "operations": [
                                    {
                                        "type": "reverb_throw",
                                        "stems": ["vocals"],
                                        "start": 2.0,
                                        "end": 4.0,
                                        "room_size": 0.7,
                                        "wet_level": 0.45,
                                    },
                                    {
                                        "type": "add_sfx",
                                        "sfx_id": "riser_noise",
                                        "start": 2.0,
                                        "end": 6.0,
                                        "gain_db": -3.0,
                                    },
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
        json={
            "message": "Make this vocal section soar into the drop",
            "selection": {"start": 2.0, "end": 6.0, "lane": "vocals"},
        },
    )
    assert r_chat.status_code == 200
    body = r_chat.json()
    assert body["chat_messages"][0]["selection"]["lane"] == "vocals"

    # Verify context_doc sent to Gemini included "lane":"vocals" and prompt mentions lane + add_sfx
    assert len(captured_contents) == 1
    system_text = captured_contents[0][0]
    ctx_text = captured_contents[0][1]
    assert "add_sfx:" in system_text
    assert '"lane"' in system_text
    assert '"lane":"vocals"' in ctx_text

    # Verify add_sfx proposal sanitized and preview WAV rendered
    prop = body["chat_messages"][1]["proposals"][0]
    assert len(prop["operations"]) == 2
    assert prop["operations"][1]["type"] == "add_sfx"
    assert prop["operations"][1]["sfx_id"] == "riser_noise"
    assert prop["preview_url"] is not None
    assert client.get(prop["preview_url"]).status_code == 200

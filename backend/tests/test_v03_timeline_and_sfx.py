"""Tests for Musak v0.3: stem device, waveform peaks, and SFX library/DSP rendering."""

from __future__ import annotations

import io
import time
from pathlib import Path
from typing import Any

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from musak import stems as stems_mod
from musak.audio_analysis import compute_waveform_peaks
from musak.config import STEM_NAMES, get_stem_device
from musak.dsp import render_operations, tune_proposal_operations
from musak.models import EditOperation, ProjectState
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

    silent_path = tmp_path / "silent.wav"
    sf.write(str(silent_path), np.zeros((4410, 2), dtype=np.float32), 44100, subtype="PCM_16")
    assert compute_waveform_peaks(silent_path, buckets=50) == [0.0] * 50


def test_sfx_library_preview_and_dsp_rendering(client: TestClient) -> None:
    r_list = client.get("/api/sfx")
    assert r_list.status_code == 200
    items = r_list.json()["items"]
    assert len(items) == 8
    assert {item["id"] for item in items} == set(KNOWN_SFX_IDS)

    for item in items:
        sfx_id = item["id"]
        t0 = time.perf_counter()
        a1 = synthesize_sfx(sfx_id, duration=1.5, sr=44100, bpm=128.0)
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        a2 = synthesize_sfx(sfx_id, duration=1.5, sr=44100, bpm=128.0)
        assert elapsed_ms < 250.0
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
        assert np.allclose(mixed[: int(1.9 * sr)], dry[: int(1.9 * sr)], atol=1e-4)
        assert float(np.mean(np.abs(mixed[int(2.1 * sr) : int(3.9 * sr)] - dry[int(2.1 * sr) : int(3.9 * sr)]))) > 0.01

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

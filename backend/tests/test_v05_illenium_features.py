"""Tests for Melodic-Bass / Illenium DJ capabilities (#10-#13)."""

from __future__ import annotations

import io
import time

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from musak.config import STEM_NAMES
from musak.dsp import _apply_sidechain_pump, _apply_stereo_wash, render_operations, tune_proposal_operations
from musak.gemini_agent import VALID_OP_TYPES, _sanitize_operation
from musak.models import EditOperation, ProjectState
from musak.sfx import KNOWN_SFX_IDS, synthesize_sfx
from musak.storage import store
from tests.conftest import make_synthetic_track, wav_bytes_from_array


def _rms(buf: np.ndarray, a: float, b: float, sr: int = 44100) -> float:
    seg = buf[int(round(a * sr)) : int(round(b * sr))]
    return float(np.sqrt(np.mean(seg**2)))


def _setup_project(client: TestClient, duration: float = 6.0, bpm: float = 120.0, with_stems: bool = False) -> str:
    pid = client.post("/api/projects", json={"name": "Illenium Lab"}).json()["id"]
    audio = make_synthetic_track(duration=duration, sr=44100, bpm=bpm, root_hz=220.0, minor=True, varying_energy=False)
    r = client.post(
        f"/api/projects/{pid}/main-track",
        files={"file": ("main.wav", wav_bytes_from_array(audio), "audio/wav")},
    )
    assert r.status_code == 200

    if with_stems:
        sr = 44100
        n = int(round(duration * sr))
        t = np.arange(n, dtype=np.float32) / float(sr)
        stems_dir = store.main_stems_dir(pid)
        stems_dir.mkdir(parents=True, exist_ok=True)
        for name, hz in {"vocals": 880.0, "drums": 110.0, "bass": 65.0, "other": 330.0}.items():
            tone = np.stack([0.18 * np.sin(2.0 * np.pi * hz * t)] * 2, axis=-1).astype(np.float32)
            sf.write(str(stems_dir / f"{name}.wav"), tone, sr, subtype="PCM_16")

        def _ready(proj: ProjectState) -> None:
            assert proj.main_track is not None
            proj.main_track.stems_status = "ready"
            proj.main_track.stems = list(STEM_NAMES)
            proj.main_track.stem_urls = store.stem_urls(pid, list(STEM_NAMES), track_id=proj.main_track.id)
            proj.main_track.bpm = bpm
            proj.main_track.key = "G# Minor"

        store.update_project(pid, _ready)
    return pid


def test_sidechain_pump_modulation_depth_and_zero_clipping() -> None:
    sr = 44100
    t = np.arange(int(4.0 * sr), dtype=np.float32) / float(sr)
    tone = np.stack([0.5 * np.sin(2.0 * np.pi * 440.0 * t)] * 2, axis=-1).astype(np.float32)

    op = EditOperation(type="sidechain_pump", start=1.0, end=3.0, division_beats=1.0, depth=0.75, snap_to_beat=False)
    pumped = _apply_sidechain_pump(tone, sr, op, [], bpm=120.0)
    assert pumped.shape == tone.shape
    assert not np.any(np.isnan(pumped))
    assert float(np.max(np.abs(pumped))) <= float(np.max(np.abs(tone))) + 1e-4
    assert np.allclose(pumped[: int(0.95 * sr)], tone[: int(0.95 * sr)], atol=1e-4)
    assert np.allclose(pumped[int(3.05 * sr) :], tone[int(3.05 * sr) :], atol=1e-4)

    dry_rms = _rms(tone, 1.4, 1.48, sr)
    for beat_t in (1.02, 1.52, 2.02, 2.52):
        assert _rms(pumped, beat_t, beat_t + 0.03, sr) < dry_rms * 0.45
        assert _rms(pumped, beat_t + 0.40, beat_t + 0.45, sr) > dry_rms * 0.85

    op_half = EditOperation(type="sidechain_pump", start=1.0, end=2.0, division_beats=0.5, depth=0.8, snap_to_beat=False)
    pumped_half = _apply_sidechain_pump(tone, sr, op_half, [], bpm=120.0)
    assert _rms(pumped_half, 1.26, 1.28, sr) < dry_rms * 0.40


def test_stereo_wash_increases_side_energy() -> None:
    sr = 44100
    t = np.arange(int(4.0 * sr), dtype=np.float32) / float(sr)
    mono_sig = 0.35 * np.sin(2.0 * np.pi * 330.0 * t)
    stereo_in = np.stack([mono_sig, mono_sig], axis=-1).astype(np.float32)

    op = EditOperation(type="stereo_wash", start=1.0, end=3.0, width=1.6, chorus_mix=0.45, snap_to_beat=False)
    washed = _apply_stereo_wash(stereo_in, sr, op, [])
    assert washed.shape == stereo_in.shape
    assert not np.any(np.isnan(washed))
    assert np.allclose(washed[: int(0.95 * sr)], stereo_in[: int(0.95 * sr)], atol=1e-4)

    seg = washed[int(1.2 * sr) : int(2.8 * sr)]
    side_rms = float(np.sqrt(np.mean((seg[:, 0] - seg[:, 1]) ** 2)))
    assert side_rms > 0.02

    op_narrow = EditOperation(type="stereo_wash", start=1.0, end=3.0, width=0.6, chorus_mix=0.45, snap_to_beat=False)
    narrow = _apply_stereo_wash(stereo_in, sr, op_narrow, [])
    narrow_seg = narrow[int(1.2 * sr) : int(2.8 * sr)]
    assert side_rms > float(np.sqrt(np.mean((narrow_seg[:, 0] - narrow_seg[:, 1]) ** 2))) * 1.5


def test_melodic_sfx_keys_catalog_and_preview(client: TestClient) -> None:
    r_list = client.get("/api/sfx")
    assert r_list.status_code == 200
    items = r_list.json()["items"]
    assert len(items) == 8
    by_id = {item["id"]: item for item in items}
    assert {"supersaw_swell", "ambient_pad"}.issubset(KNOWN_SFX_IDS)
    assert by_id["supersaw_swell"]["category"] == "riser"
    assert by_id["supersaw_swell"]["default_duration"] == 4.0
    assert by_id["supersaw_swell"]["bpm_synced"] is True
    assert by_id["ambient_pad"]["category"] == "transition"
    assert by_id["ambient_pad"]["default_duration"] == 8.0
    assert by_id["ambient_pad"]["bpm_synced"] is False

    sr = 44100
    for sfx_id in ("supersaw_swell", "ambient_pad"):
        t0 = time.perf_counter()
        gs = synthesize_sfx(sfx_id, duration=2.0, sr=sr, bpm=128.0, musical_key="G# Minor")
        assert (time.perf_counter() - t0) * 1000.0 < 250.0
        dm = synthesize_sfx(sfx_id, duration=2.0, sr=sr, bpm=128.0, musical_key="D Major")
        assert gs.shape == (2 * sr, 2) and dm.shape == (2 * sr, 2)
        assert not np.any(np.isnan(gs)) and not np.any(np.isnan(dm))
        assert float(np.max(np.abs(gs))) > 0.2
        assert float(np.mean(np.abs(gs - dm))) > 0.05

        # Dominant root energy near 207.65 Hz (G#3) vs 146.83 Hz (D3)
        freqs = np.fft.rfftfreq(len(gs), d=1.0 / sr)
        spec_gs = np.abs(np.fft.rfft(gs[:, 0]))
        spec_dm = np.abs(np.fft.rfft(dm[:, 0]))
        e_gs_at_gs = float(np.max(spec_gs[(freqs >= 200.0) & (freqs <= 216.0)]))
        e_gs_at_d = float(np.max(spec_gs[(freqs >= 140.0) & (freqs <= 154.0)]))
        e_dm_at_d = float(np.max(spec_dm[(freqs >= 140.0) & (freqs <= 154.0)]))
        assert e_gs_at_gs > e_gs_at_d * 2.0
        assert e_dm_at_d > float(np.max(spec_dm[(freqs >= 200.0) & (freqs <= 216.0)])) * 1.5

    r_prev = client.get("/api/sfx/supersaw_swell/preview?bpm=128&duration=1.5&key=G%23%20Minor")
    assert r_prev.status_code == 200
    assert r_prev.headers["content-type"].startswith("audio/wav")
    wav_gs, prev_sr = sf.read(io.BytesIO(r_prev.content), dtype="float32", always_2d=True)
    assert prev_sr == 44100 and wav_gs.shape == (int(round(1.5 * 44100)), 2)

    r_prev_dm = client.get("/api/sfx/supersaw_swell/preview?bpm=128&duration=1.5&key=D%20Major")
    assert r_prev_dm.status_code == 200
    wav_dm, _ = sf.read(io.BytesIO(r_prev_dm.content), dtype="float32", always_2d=True)
    assert float(np.mean(np.abs(wav_gs - wav_dm))) > 0.05


def test_post_overlay_fx_routing_modulates_borrowed_and_sfx_layers(client: TestClient) -> None:
    pid = _setup_project(client, duration=6.0, bpm=120.0, with_stems=True)
    sr = 44100
    t = np.arange(int(3.0 * sr), dtype=np.float32) / float(sr)
    ref_tone = np.stack([0.4 * np.sin(2.0 * np.pi * 523.25 * t)] * 2, axis=-1).astype(np.float32)
    r_ref = client.post(
        f"/api/projects/{pid}/references/upload",
        files={"file": ("synth.wav", wav_bytes_from_array(ref_tone), "audio/wav")},
        data={"title": "Illenium Synth"},
    )
    assert r_ref.status_code == 200
    ref_id = r_ref.json()["references"][0]["id"]

    def _align_ref(proj: ProjectState) -> None:
        proj.references[0].bpm = 120.0
        proj.references[0].key = "G# Minor"

    proj = store.update_project(pid, _align_ref)
    borrow_op = EditOperation(
        type="borrow_stem",
        ref_id=ref_id,
        ref_stem="full",
        ref_start=0.0,
        ref_end=2.5,
        target_start=1.0,
        target_end=3.5,
        replace_main_stems=["full"],
        match_bpm=False,
        match_key=False,
        snap_to_beat=False,
    )
    pad_op = EditOperation(type="add_sfx", sfx_id="ambient_pad", start=1.0, end=3.5, gain_db=-3.0, snap_to_beat=False)

    unpumped, _ = render_operations(store, proj, [borrow_op, pad_op])
    pump_all = EditOperation(type="sidechain_pump", start=1.0, end=3.5, division_beats=1.0, depth=0.85, snap_to_beat=False)
    pumped, _ = render_operations(store, proj, [borrow_op, pad_op, pump_all])

    # Because main stems are replaced in [1.0, 3.5], audio there comes purely from borrow_stem + add_sfx overlays!
    assert _rms(pumped, 1.515, 1.545, sr) < _rms(unpumped, 1.515, 1.545, sr) * 0.35
    assert _rms(pumped, 1.92, 1.98, sr) > _rms(pumped, 1.515, 1.545, sr) * 2.0

    # Per-stem sidechain_pump (stems=["bass"]) does NOT pump the overlay
    pump_bass = EditOperation(type="sidechain_pump", stems=["bass"], start=1.0, end=3.5, division_beats=1.0, depth=0.85, snap_to_beat=False)
    pumped_bass_only, _ = render_operations(store, proj, [borrow_op, pad_op, pump_bass])
    assert _rms(pumped_bass_only, 1.515, 1.545, sr) > _rms(unpumped, 1.515, 1.545, sr) * 0.9


def test_patch_edit_illenium_params_tuning_and_gemini_sanitize(client: TestClient) -> None:
    pid = _setup_project(client, duration=6.0, bpm=120.0, with_stems=False)
    r_sc = client.post(
        f"/api/projects/{pid}/edits",
        json={"title": "Pump", "start": 1.0, "end": 3.0, "operations": [{"type": "sidechain_pump", "start": 1.0, "end": 3.0}]},
    )
    assert r_sc.status_code == 200
    sc_id = r_sc.json()["edits"][0]["id"]

    r_sw = client.post(
        f"/api/projects/{pid}/edits",
        json={"title": "Wash", "start": 1.0, "end": 3.0, "operations": [{"type": "stereo_wash", "start": 1.0, "end": 3.0}]},
    )
    assert r_sw.status_code == 200
    sw_id = r_sw.json()["edits"][1]["id"]

    assert client.patch(f"/api/projects/{pid}/edits/{sc_id}", json={"depth": 1.2}).status_code == 422
    assert client.patch(f"/api/projects/{pid}/edits/{sw_id}", json={"width": 3.0}).status_code == 422
    assert client.patch(f"/api/projects/{pid}/edits/{sw_id}", json={"chorus_mix": 0.95}).status_code == 422

    p_sc = client.patch(
        f"/api/projects/{pid}/edits/{sc_id}",
        json={"depth": 0.85, "division_beats": 0.5, "apply_to_layers": True},
    )
    assert p_sc.status_code == 200
    sc_op = next(e for e in p_sc.json()["edits"] if e["id"] == sc_id)["operations"][0]
    assert sc_op["depth"] == 0.85 and sc_op["division_beats"] == 0.5 and sc_op["apply_to_layers"] is True

    p_sw = client.patch(f"/api/projects/{pid}/edits/{sw_id}", json={"width": 1.85, "chorus_mix": 0.55})
    assert p_sw.status_code == 200
    sw_op = next(e for e in p_sw.json()["edits"] if e["id"] == sw_id)["operations"][0]
    assert sw_op["width"] == 1.85 and sw_op["chorus_mix"] == 0.55

    assert {"sidechain_pump", "stereo_wash"}.issubset(VALID_OP_TYPES)
    san_sc = _sanitize_operation(
        {"type": "sidechain_pump", "start": 1.0, "end": 3.0, "depth": 5.0, "division_beats": 0.5, "apply_to_layers": True},
        duration=6.0, valid_ref_ids=set(), downloaded_ref_ids=set(), default_start=1.0, default_end=3.0,
    )
    assert san_sc is not None and san_sc.depth == 0.95 and san_sc.apply_to_layers is True
    san_sw = _sanitize_operation(
        {"type": "stereo_wash", "start": 1.0, "end": 3.0, "width": 1.75, "chorus_mix": 0.9},
        duration=6.0, valid_ref_ids=set(), downloaded_ref_ids=set(), default_start=1.0, default_end=3.0,
    )
    assert san_sw is not None and san_sw.width == 1.75 and san_sw.chorus_mix == 0.8

    tuned = tune_proposal_operations(
        [EditOperation(type="sidechain_pump", start=1.0, end=3.0, depth=0.6), EditOperation(type="stereo_wash", start=1.0, end=3.0, width=1.4, chorus_mix=0.4)],
        intensity=1.25,
    )
    assert tuned[0].depth == pytest.approx(0.75, abs=0.01)
    assert tuned[1].width == pytest.approx(1.5, abs=0.01)
    assert tuned[1].chorus_mix == pytest.approx(0.5, abs=0.01)

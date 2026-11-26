"""Comprehensive tests for all 9 Musak v0.4 DJ Checklist backend capabilities."""

from __future__ import annotations

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from musak.dsp import (
    _apply_beat_repeat,
    _apply_vinyl_brake,
    render_operations,
    render_proposal_preview,
)
from musak.gemini_agent import VALID_OP_TYPES, _sanitize_operation
from musak.models import EditOperation, EditProposal, ProjectState
from musak.storage import store
from tests.conftest import make_synthetic_track, wav_bytes_from_array


def _setup_main(client: TestClient, duration: float = 8.0, bpm: float = 120.0, root_hz: float = 261.63) -> str:
    pid = client.post("/api/projects", json={"name": "v0.4 DJ Lab"}).json()["id"]
    audio = make_synthetic_track(duration=duration, sr=44100, bpm=bpm, root_hz=root_hz, varying_energy=False)
    r = client.post(
        f"/api/projects/{pid}/main-track",
        files={"file": ("main.wav", wav_bytes_from_array(audio), "audio/wav")},
    )
    assert r.status_code == 200
    return pid


def _upload_short_ref(client: TestClient, pid: str, duration: float = 1.0, freq: float = 440.0) -> str:
    sr = 44100
    t = np.arange(int(round(duration * sr)), dtype=np.float32) / float(sr)
    ref_audio = np.stack([0.35 * np.sin(2.0 * np.pi * freq * t)] * 2, axis=-1).astype(np.float32)
    r = client.post(
        f"/api/projects/{pid}/references/upload",
        files={"file": ("ref_loop.wav", wav_bytes_from_array(ref_audio), "audio/wav")},
        data={"title": "Short Loop"},
    )
    assert r.status_code == 200
    return r.json()["references"][-1]["id"]


def test_patch_edit_fx_params_fades_and_borrow_fields(client: TestClient) -> None:
    pid = _setup_main(client, duration=8.0, bpm=120.0)
    ref_id = _upload_short_ref(client, pid, duration=4.0)

    def _create(title: str, op: dict) -> str:
        r = client.post(
            f"/api/projects/{pid}/edits",
            json={"title": title, "start": 1.0, "end": 3.0, "operations": [op]},
        )
        assert r.status_code == 200
        return r.json()["edits"][-1]["id"]

    flt_id = _create(
        "Sweep",
        {"type": "filter_sweep", "start": 1.0, "end": 3.0, "mode": "highpass", "start_hz": 120.0, "end_hz": 2400.0},
    )
    rev_id = _create("Verb", {"type": "reverb_throw", "start": 1.0, "end": 3.0, "room_size": 0.5, "wet_level": 0.3})
    dly_id = _create(
        "Echo",
        {"type": "delay_throw", "start": 1.0, "end": 3.0, "delay_beats": 0.5, "feedback": 0.4, "mix": 0.35},
    )
    lofi_id = _create(
        "LoFi",
        {"type": "lofi_eq", "start": 1.0, "end": 3.0, "low_cut_hz": 300.0, "high_cut_hz": 3200.0, "drive_db": 6.0},
    )
    bass_id = _create("Bass", {"type": "bass_boost", "start": 1.0, "end": 3.0, "gain_db": 4.0, "cutoff_hz": 120.0})
    gain_id = _create("Fade", {"type": "stem_gain", "start": 1.0, "end": 3.0, "gain_db": 0.0})
    brw_id = _create(
        "Borrow",
        {
            "type": "borrow_stem",
            "ref_id": ref_id,
            "ref_stem": "full",
            "ref_start": 0.0,
            "ref_end": 2.0,
            "target_start": 1.0,
            "target_end": 3.0,
            "match_bpm": True,
            "match_key": True,
        },
    )

    p_flt = client.patch(
        f"/api/projects/{pid}/edits/{flt_id}",
        json={"title": "Underwater Drop", "mode": "lowpass", "start_hz": 12000.0, "end_hz": 280.0},
    )
    assert p_flt.status_code == 200
    flt_edit = next(e for e in p_flt.json()["edits"] if e["id"] == flt_id)
    assert flt_edit["title"] == "Underwater Drop"
    assert flt_edit["operations"][0]["mode"] == "lowpass"
    assert flt_edit["operations"][0]["start_hz"] == 12000.0
    assert flt_edit["operations"][0]["end_hz"] == 280.0

    p_rev = client.patch(f"/api/projects/{pid}/edits/{rev_id}", json={"room_size": 0.9, "wet_level": 0.75})
    assert p_rev.status_code == 200
    rev_op = next(e for e in p_rev.json()["edits"] if e["id"] == rev_id)["operations"][0]
    assert rev_op["room_size"] == 0.9 and rev_op["wet_level"] == 0.75

    p_dly = client.patch(
        f"/api/projects/{pid}/edits/{dly_id}", json={"delay_beats": 0.75, "feedback": 0.65, "mix": 0.55}
    )
    assert p_dly.status_code == 200
    dly_op = next(e for e in p_dly.json()["edits"] if e["id"] == dly_id)["operations"][0]
    assert dly_op["delay_beats"] == 0.75 and dly_op["feedback"] == 0.65 and dly_op["mix"] == 0.55

    assert client.patch(
        f"/api/projects/{pid}/edits/{lofi_id}", json={"low_cut_hz": 3000.0, "high_cut_hz": 1500.0}
    ).status_code == 422
    p_lofi = client.patch(
        f"/api/projects/{pid}/edits/{lofi_id}",
        json={"low_cut_hz": 450.0, "high_cut_hz": 2200.0, "drive_db": 14.0},
    )
    assert p_lofi.status_code == 200
    lofi_op = next(e for e in p_lofi.json()["edits"] if e["id"] == lofi_id)["operations"][0]
    assert lofi_op["low_cut_hz"] == 450.0 and lofi_op["high_cut_hz"] == 2200.0 and lofi_op["drive_db"] == 14.0

    p_bass = client.patch(f"/api/projects/{pid}/edits/{bass_id}", json={"gain_db": 9.5, "cutoff_hz": 145.0})
    assert p_bass.status_code == 200
    bass_op = next(e for e in p_bass.json()["edits"] if e["id"] == bass_id)["operations"][0]
    assert bass_op["gain_db"] == 9.5 and bass_op["cutoff_hz"] == 145.0

    p_gain = client.patch(
        f"/api/projects/{pid}/edits/{gain_id}",
        json={"fade_in_ms": 400.0, "fade_out_ms": 800.0, "fade_curve": "both"},
    )
    assert p_gain.status_code == 200
    gain_op = next(e for e in p_gain.json()["edits"] if e["id"] == gain_id)["operations"][0]
    assert gain_op["fade_in_ms"] == 400.0 and gain_op["fade_out_ms"] == 800.0 and gain_op["fade_curve"] == "both"

    assert client.patch(
        f"/api/projects/{pid}/edits/{brw_id}", json={"ref_start": 2.5, "ref_end": 1.0}
    ).status_code == 422
    p_brw = client.patch(
        f"/api/projects/{pid}/edits/{brw_id}",
        json={
            "ref_start": 0.5,
            "ref_end": 2.5,
            "replace_main_stems": ["vocals"],
            "match_bpm": False,
            "match_key": False,
            "loop_to_fit": True,
            "fade_in_ms": 150.0,
            "fade_out_ms": 250.0,
        },
    )
    assert p_brw.status_code == 200
    brw_op = next(e for e in p_brw.json()["edits"] if e["id"] == brw_id)["operations"][0]
    assert brw_op["ref_start"] == 0.5 and brw_op["ref_end"] == 2.5
    assert brw_op["replace_main_stems"] == ["vocals"]
    assert brw_op["match_bpm"] is False and brw_op["match_key"] is False and brw_op["loop_to_fit"] is True
    assert brw_op["fade_in_ms"] == 150.0 and brw_op["fade_out_ms"] == 250.0


def test_fade_curves_and_asymmetric_edge_fades(client: TestClient) -> None:
    pid = _setup_main(client, duration=6.0, bpm=120.0)
    sr = 44100
    project = store.get_project(pid)
    assert project.main_track is not None
    main_wav = store.get_main_audio_path(pid, project.main_track.id)

    # Constant tone so amplitude envelopes are cleanly measurable
    t = np.arange(int(6.0 * sr), dtype=np.float32) / float(sr)
    tone = np.stack([0.4 * np.sin(2.0 * np.pi * 440.0 * t)] * 2, axis=-1).astype(np.float32)
    sf.write(str(main_wav), tone, sr, subtype="PCM_16")

    def _rms(buf: np.ndarray, a: float, b: float) -> float:
        seg = buf[int(a * sr) : int(b * sr)]
        return float(np.sqrt(np.mean(seg**2)))

    # fade_curve == "in" rises from ~0 at 1.0s to full at 3.0s
    out_in, _ = render_operations(
        store,
        project,
        [EditOperation(type="stem_gain", start=1.0, end=3.0, fade_curve="in", snap_to_beat=False)],
    )
    assert _rms(out_in, 1.0, 1.1) < _rms(out_in, 1.9, 2.1) < _rms(out_in, 2.85, 2.98)
    assert _rms(out_in, 1.0, 1.05) < 0.02
    assert _rms(out_in, 2.9, 2.99) > 0.25
    assert np.allclose(out_in[: int(0.95 * sr)], tone[: int(0.95 * sr)], atol=1e-3)

    # fade_curve == "out" decays from full at 1.0s to ~0 at 3.0s
    out_out, _ = render_operations(
        store,
        project,
        [EditOperation(type="stem_gain", start=1.0, end=3.0, fade_curve="out", snap_to_beat=False)],
    )
    assert _rms(out_out, 1.02, 1.12) > _rms(out_out, 1.9, 2.1) > _rms(out_out, 2.9, 2.99)
    assert _rms(out_out, 2.92, 3.0) < 0.02

    # Asymmetric fade_in_ms / fade_out_ms on mute (-80 dB)
    out_asym, _ = render_operations(
        store,
        project,
        [
            EditOperation(
                type="stem_gain",
                start=1.0,
                end=4.0,
                gain_db=-80.0,
                fade_in_ms=1500.0,
                fade_out_ms=50.0,
                snap_to_beat=False,
            )
        ],
    )
    # 200ms after start (inside 1500ms fade-down) is still noticeably louder than muted middle
    assert _rms(out_asym, 1.1, 1.2) > 0.15
    assert _rms(out_asym, 2.6, 3.4) < 1e-4

    # add_sfx honors custom fade_in_ms / fade_out_ms
    out_sfx, _ = render_operations(
        store,
        project,
        [
            EditOperation(
                type="add_sfx",
                sfx_id="riser_noise",
                start=1.0,
                end=3.0,
                fade_in_ms=600.0,
                fade_out_ms=600.0,
                snap_to_beat=False,
            )
        ],
    )
    assert not np.any(np.isnan(out_sfx))
    assert float(np.max(np.abs(out_sfx))) <= 0.999


def test_borrow_stem_loop_to_fit_and_mashup_ref_slice(client: TestClient) -> None:
    pid = _setup_main(client, duration=6.0, bpm=120.0)
    ref_id = _upload_short_ref(client, pid, duration=1.0, freq=523.25)

    def _align_ref(proj: ProjectState) -> None:
        assert proj.main_track is not None
        proj.main_track.bpm = 120.0
        proj.main_track.key = "C Major"
        proj.references[0].bpm = 120.0
        proj.references[0].key = "C Major"

    project = store.update_project(pid, _align_ref)
    sr = 44100

    # Without loop_to_fit: 1s clip in [1.0, 5.0] pads silence after t=2.0
    no_loop, _ = render_operations(
        store,
        project,
        [
            EditOperation(
                type="borrow_stem",
                ref_id=ref_id,
                ref_stem="full",
                ref_start=0.0,
                ref_end=1.0,
                target_start=1.0,
                target_end=5.0,
                replace_main_stems=["full"],
                match_bpm=False,
                match_key=False,
                loop_to_fit=False,
                snap_to_beat=False,
            )
        ],
    )
    tail_rms_noloop = float(np.sqrt(np.mean(no_loop[int(2.5 * sr) : int(4.5 * sr)] ** 2)))
    assert tail_rms_noloop < 1e-4

    # With loop_to_fit=True: 1s clip is seamlessly tiled across [1.0, 5.0]
    with_loop, _ = render_operations(
        store,
        project,
        [
            EditOperation(
                type="borrow_stem",
                ref_id=ref_id,
                ref_stem="full",
                ref_start=0.0,
                ref_end=1.0,
                target_start=1.0,
                target_end=5.0,
                replace_main_stems=["full"],
                match_bpm=False,
                match_key=False,
                loop_to_fit=True,
                snap_to_beat=False,
            )
        ],
    )
    tail_rms_loop = float(np.sqrt(np.mean(with_loop[int(2.5 * sr) : int(4.5 * sr)] ** 2)))
    assert tail_rms_loop > 0.15

    # MashupRequest honors explicit ref_start / ref_end
    ref_long_id = _upload_short_ref(client, pid, duration=6.0, freq=330.0)
    r_mash = client.post(
        f"/api/projects/{pid}/mashup",
        json={
            "ref_id": ref_long_id,
            "mode": "smart_auto",
            "start": 1.0,
            "end": 3.0,
            "ref_start": 2.5,
            "ref_end": 4.5,
        },
    )
    assert r_mash.status_code == 200
    borrow_op = r_mash.json()["edits"][-1]["operations"][0]
    assert borrow_op["ref_start"] == pytest.approx(2.5, abs=0.01)
    assert borrow_op["ref_end"] == pytest.approx(4.5, abs=0.01)


def test_duplicate_edit_endpoint(client: TestClient) -> None:
    pid = _setup_main(client, duration=8.0, bpm=120.0)
    r_create = client.post(
        f"/api/projects/{pid}/edits",
        json={
            "title": "Echo Throw",
            "start": 1.0,
            "end": 2.5,
            "operations": [{"type": "delay_throw", "start": 1.2, "end": 2.3, "delay_beats": 0.5}],
        },
    )
    assert r_create.status_code == 200
    orig_id = r_create.json()["edits"][0]["id"]

    # Default duplicate places immediately after original: [2.5, 4.0]
    r_dup1 = client.post(f"/api/projects/{pid}/edits/{orig_id}/duplicate", json={})
    assert r_dup1.status_code == 200
    edits1 = r_dup1.json()["edits"]
    assert len(edits1) == 2
    d1 = edits1[1]
    assert d1["id"] != orig_id
    assert d1["start"] == pytest.approx(2.5, abs=0.01)
    assert d1["end"] == pytest.approx(4.0, abs=0.01)
    assert d1["operations"][0]["start"] == pytest.approx(2.7, abs=0.01)
    assert d1["operations"][0]["end"] == pytest.approx(3.8, abs=0.01)

    # Explicit target start=5.0 -> [5.0, 6.5]
    r_dup2 = client.post(f"/api/projects/{pid}/edits/{orig_id}/duplicate", json={"start": 5.0})
    assert r_dup2.status_code == 200
    d2 = r_dup2.json()["edits"][2]
    assert d2["start"] == pytest.approx(5.0, abs=0.01)
    assert d2["end"] == pytest.approx(6.5, abs=0.01)
    assert d2["operations"][0]["start"] == pytest.approx(5.2, abs=0.01)
    assert d2["operations"][0]["end"] == pytest.approx(6.3, abs=0.01)


def test_arrangement_cut_repeat_reverse_order_and_preview_skip(client: TestClient) -> None:
    pid = _setup_main(client, duration=8.0, bpm=120.0)
    project = store.get_project(pid)
    sr = 44100

    # Cut [2.0, 4.0] -> shortens 8s track to ~6s
    cut_out, _ = render_operations(
        store,
        project,
        [EditOperation(type="cut_section", start=2.0, end=4.0, snap_to_beat=False)],
    )
    assert 5.9 * sr <= len(cut_out) <= 6.05 * sr
    assert not np.any(np.isnan(cut_out))

    # Repeat [2.0, 4.0] x2 -> lengthens 8s track to ~10s; x3 -> ~12s
    rep2_out, _ = render_operations(
        store,
        project,
        [EditOperation(type="repeat_section", start=2.0, end=4.0, repeat_count=2, snap_to_beat=False)],
    )
    assert 9.9 * sr <= len(rep2_out) <= 10.05 * sr

    rep3_out, _ = render_operations(
        store,
        project,
        [EditOperation(type="repeat_section", start=2.0, end=4.0, repeat_count=3, snap_to_beat=False)],
    )
    assert 11.9 * sr <= len(rep3_out) <= 12.05 * sr

    # Combined cut [1.0, 2.0] (-1s) + repeat [5.0, 6.0] x2 (+1s) -> stays ~8.0s because reverse chronological
    combo_out, _ = render_operations(
        store,
        project,
        [
            EditOperation(type="cut_section", start=1.0, end=2.0, snap_to_beat=False),
            EditOperation(type="repeat_section", start=5.0, end=6.0, repeat_count=2, snap_to_beat=False),
        ],
    )
    assert 7.9 * sr <= len(combo_out) <= 8.05 * sr

    # Non-overlapping cut_section is skipped in sliced preview for [5.0, 7.0]
    r_cut = client.post(
        f"/api/projects/{pid}/edits",
        json={
            "title": "Cut Intro",
            "start": 0.5,
            "end": 1.5,
            "operations": [{"type": "cut_section", "start": 0.5, "end": 1.5, "snap_to_beat": False}],
        },
    )
    assert r_cut.status_code == 200
    prop = EditProposal(
        id="prop_arr_skip",
        title="Late Reverb",
        summary="Reverb near end.",
        style="creative",
        start=5.0,
        end=7.0,
        operations=[EditOperation(type="reverb_throw", start=5.0, end=7.0, snap_to_beat=False)],
    )
    prev_path = render_proposal_preview(store, store.get_project(pid), prop, nonce="arr1")
    info = sf.info(str(prev_path))
    prev_dur = info.frames / float(info.samplerate)
    # [3.5, 8.0] = 4.5s window untouched by distant [0.5, 1.5] cut
    assert 4.4 <= prev_dur <= 4.6


def test_beat_repeat_and_vinyl_brake_dsp_and_gemini_sanitize(client: TestClient) -> None:
    pid = _setup_main(client, duration=6.0, bpm=120.0)
    project = store.get_project(pid)
    assert project.main_track is not None
    sr = 44100
    main_wav = store.get_main_audio_path(pid, project.main_track.id)

    # Create a distinctive signal: 1st quarter-beat is loud 880Hz, rest is 220Hz
    t = np.arange(int(6.0 * sr), dtype=np.float32) / float(sr)
    sig = 0.35 * np.sin(2.0 * np.pi * 220.0 * t)
    s0, s1 = int(1.0 * sr), int(1.125 * sr)
    sig[s0:s1] = 0.4 * np.sin(2.0 * np.pi * 880.0 * t[s0:s1])
    stereo = np.stack([sig, sig], axis=-1).astype(np.float32)
    sf.write(str(main_wav), stereo, sr, subtype="PCM_16")

    # 1. beat_repeat direct + pipeline
    op_br = EditOperation(
        type="beat_repeat", start=1.0, end=2.5, division_beats=0.25, snap_to_beat=False
    )
    br_direct = _apply_beat_repeat(stereo, sr, op_br, [], bpm=120.0)
    assert br_direct.shape == stereo.shape
    assert np.allclose(br_direct[: int(0.95 * sr)], stereo[: int(0.95 * sr)], atol=1e-4)
    assert float(np.mean(np.abs(br_direct[int(1.2 * sr) : int(2.4 * sr)] - stereo[int(1.2 * sr) : int(2.4 * sr)]))) > 0.05

    br_pipe, _ = render_operations(store, project, [op_br])
    assert not np.any(np.isnan(br_pipe))
    assert float(np.max(np.abs(br_pipe))) <= 0.999

    # 2. vinyl_brake direct + pipeline: pitch drops (fewer zero-crossings in late half) + tail fades to ~0
    op_vb = EditOperation(type="vinyl_brake", start=2.0, end=4.0, snap_to_beat=False)
    vb_direct = _apply_vinyl_brake(stereo, sr, op_vb, [])
    assert vb_direct.shape == stereo.shape
    assert np.allclose(vb_direct[: int(1.95 * sr)], stereo[: int(1.95 * sr)], atol=1e-4)
    assert np.allclose(vb_direct[int(4.05 * sr) :], stereo[int(4.05 * sr) :], atol=1e-4)

    def _zero_crossings(x: np.ndarray) -> int:
        mono = x[:, 0]
        return int(np.sum((mono[:-1] * mono[1:]) < 0))

    zc_early = _zero_crossings(vb_direct[int(2.1 * sr) : int(2.6 * sr)])
    zc_late = _zero_crossings(vb_direct[int(3.2 * sr) : int(3.7 * sr)])
    assert zc_late < zc_early * 0.65, "Vinyl brake should visibly lower pitch/zero-crossing rate toward stop"
    tail_rms = float(np.sqrt(np.mean(vb_direct[int(3.92 * sr) : int(4.0 * sr)] ** 2)))
    assert tail_rms < 0.05

    vb_pipe, _ = render_operations(store, project, [op_vb])
    assert not np.any(np.isnan(vb_pipe))

    # 3. Gemini sanitization & VALID_OP_TYPES
    for tname in ("cut_section", "repeat_section", "beat_repeat", "vinyl_brake"):
        assert tname in VALID_OP_TYPES
    san_br = _sanitize_operation(
        {"type": "beat_repeat", "start": 1.0, "end": 3.0, "division_beats": 0.125},
        duration=6.0,
        valid_ref_ids=set(),
        downloaded_ref_ids=set(),
        default_start=1.0,
        default_end=3.0,
    )
    assert san_br is not None and san_br.division_beats == 0.125
    san_rep = _sanitize_operation(
        {"type": "repeat_section", "start": 1.0, "end": 3.0, "repeat_count": 9},
        duration=6.0,
        valid_ref_ids=set(),
        downloaded_ref_ids=set(),
        default_start=1.0,
        default_end=3.0,
    )
    assert san_rep is not None and san_rep.repeat_count == 4


def test_main_track_meta_bpm_div2_mul2_and_key_override(client: TestClient) -> None:
    pid = _setup_main(client, duration=8.0, bpm=120.0)
    _upload_short_ref(client, pid, duration=2.0)

    def _seed_grid(proj: ProjectState) -> None:
        assert proj.main_track is not None
        proj.main_track.bpm = 140.0
        proj.main_track.key = "C Major"
        proj.main_track.beats = [round(0.1 + i * (60.0 / 140.0), 3) for i in range(18)]
        proj.references[0].bpm = 70.0
        proj.references[0].key = "A Minor"

    store.update_project(pid, _seed_grid)

    # Validation checks
    assert client.patch(f"/api/projects/{pid}/main-track/meta", json={"bpm": 20.0}).status_code == 422
    assert client.patch(f"/api/projects/{pid}/main-track/meta", json={"key": "   "}).status_code == 422

    # Halve BPM (140 -> 70): beat grid anchored to 0.1 % (60/70) = 0.1s with step ~0.857s
    r_half = client.patch(f"/api/projects/{pid}/main-track/meta", json={"bpm": 70.0})
    assert r_half.status_code == 200
    mt_half = r_half.json()["main_track"]
    assert mt_half["bpm"] == 70.0
    assert mt_half["beats"][0] == pytest.approx(0.1, abs=0.005)
    assert mt_half["beats"][1] - mt_half["beats"][0] == pytest.approx(60.0 / 70.0, abs=0.005)
    assert len(mt_half["beats"]) == 10

    # Double BPM (70 -> 140) + Key override
    r_dbl = client.patch(f"/api/projects/{pid}/main-track/meta", json={"bpm": 140.0, "key": "  A Minor  "})
    assert r_dbl.status_code == 200
    body_dbl = r_dbl.json()
    mt_dbl = body_dbl["main_track"]
    assert mt_dbl["bpm"] == 140.0
    assert mt_dbl["key"] == "A Minor"
    assert mt_dbl["beats"][1] - mt_dbl["beats"][0] == pytest.approx(60.0 / 140.0, abs=0.005)
    assert body_dbl["references"][0]["compatibility"]["semitone_diff"] == 0


def test_main_track_cues_crud_clamping_and_sorting(client: TestClient) -> None:
    pid = _setup_main(client, duration=8.0, bpm=120.0)

    assert client.post(
        f"/api/projects/{pid}/main-track/cues", json={"label": "   ", "time": 1.0}
    ).status_code == 422

    r1 = client.post(
        f"/api/projects/{pid}/main-track/cues",
        json={"label": "  Drop 1  ", "time": 4.5, "color": "emerald"},
    )
    assert r1.status_code == 200
    c1 = r1.json()["main_track"]["cues"][0]
    assert c1["label"] == "Drop 1"
    assert c1["time"] == 4.5
    assert c1["color"] == "emerald"

    r2 = client.post(
        f"/api/projects/{pid}/main-track/cues",
        json={"label": "Intro", "time": 1.0},
    )
    assert r2.status_code == 200
    # Out-of-bounds time clamped to duration (~8.0)
    r3 = client.post(
        f"/api/projects/{pid}/main-track/cues",
        json={"label": "Outro", "time": 999.0, "color": "rose"},
    )
    assert r3.status_code == 200
    cues = r3.json()["main_track"]["cues"]
    assert [c["label"] for c in cues] == ["Intro", "Drop 1", "Outro"]
    assert cues[2]["time"] == pytest.approx(8.0, abs=0.01)

    # Patch cue time so it moves before Intro -> sorted first
    drop_id = c1["id"]
    r_patch = client.patch(
        f"/api/projects/{pid}/main-track/cues/{drop_id}",
        json={"label": "Early Hook", "time": 0.4, "color": "amber"},
    )
    assert r_patch.status_code == 200
    patched_cues = r_patch.json()["main_track"]["cues"]
    assert [c["label"] for c in patched_cues] == ["Early Hook", "Intro", "Outro"]
    assert patched_cues[0]["color"] == "amber"

    # Delete cue
    r_del = client.delete(f"/api/projects/{pid}/main-track/cues/{drop_id}")
    assert r_del.status_code == 200
    assert [c["label"] for c in r_del.json()["main_track"]["cues"]] == ["Intro", "Outro"]
    assert client.delete(f"/api/projects/{pid}/main-track/cues/{drop_id}").status_code == 404

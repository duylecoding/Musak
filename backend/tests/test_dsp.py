"""Comprehensive tests for all 7 DSP operations, beat snapping, limiter, stems mode, and undo/redo."""

from __future__ import annotations

import numpy as np
import soundfile as sf
from fastapi.testclient import TestClient

from musak.dsp import render_operations, snap_range_to_beats, soft_limit
from musak.models import EditOperation, ProjectState
from musak.storage import store
from tests.conftest import make_synthetic_track, wav_bytes_from_array


def _setup_project_with_main(client: TestClient, duration: float = 6.0, bpm: float = 120.0) -> str:
    pid = client.post("/api/projects", json={"name": "DSP Lab"}).json()["id"]
    audio = make_synthetic_track(duration=duration, sr=44100, bpm=bpm, root_hz=261.63, varying_energy=False)
    r = client.post(
        f"/api/projects/{pid}/main-track",
        files={"file": ("main.wav", wav_bytes_from_array(audio), "audio/wav")},
    )
    assert r.status_code == 200
    return pid


def test_beat_snapping_and_soft_limiter() -> None:
    beats = [0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0]
    s, e = snap_range_to_beats(0.42, 2.08, beats, duration=4.0, snap_to_beat=True)
    assert s == 0.5 and e == 2.0

    s_raw, e_raw = snap_range_to_beats(0.42, 2.08, beats, duration=4.0, snap_to_beat=False)
    assert abs(s_raw - 0.42) < 1e-6 and abs(e_raw - 2.08) < 1e-6

    hot = np.array([[5.0, -4.0], [0.5, -0.5]], dtype=np.float32)
    limited = soft_limit(hot, threshold=0.95)
    assert float(np.max(np.abs(limited))) <= 0.999
    assert np.allclose(limited[1], [0.5, -0.5], atol=1e-6)


def test_all_six_core_dsp_operations(client: TestClient) -> None:
    pid = _setup_project_with_main(client, duration=6.0, bpm=120.0)
    project = store.get_project(pid)
    assert project.main_track is not None
    main_wav_path = store.get_main_audio_path(pid, project.main_track.id)
    sr = 44100
    dry, _ = sf.read(str(main_wav_path), dtype="float32", always_2d=True)

    # 1. stem_gain dropout (<= -60 dB -> silence inside [1.0, 2.0])
    out_gain, _ = render_operations(
        store,
        project,
        [EditOperation(type="stem_gain", start=1.0, end=2.0, gain_db=-80.0, fade_ms=20.0, snap_to_beat=False)],
    )
    mid_slice = out_gain[int(1.2 * sr) : int(1.8 * sr)]
    assert float(np.max(np.abs(mid_slice))) < 1e-4
    # Outside region untouched
    assert np.allclose(out_gain[: int(0.9 * sr)], dry[: int(0.9 * sr)], atol=1e-4)

    # 2. filter_sweep (highpass and lowpass)
    for mode, shz, ehz in [("highpass", 150.0, 3000.0), ("lowpass", 12000.0, 250.0)]:
        out_flt, _ = render_operations(
            store,
            project,
            [
                EditOperation(
                    type="filter_sweep",
                    start=1.0,
                    end=3.0,
                    mode=mode,
                    start_hz=shz,
                    end_hz=ehz,
                    snap_to_beat=False,
                )
            ],
        )
        assert not np.any(np.isnan(out_flt))
        assert float(np.max(np.abs(out_flt))) <= 0.999
        diff = float(np.mean(np.abs(out_flt[int(1.2 * sr) : int(2.8 * sr)] - dry[int(1.2 * sr) : int(2.8 * sr)])))
        assert diff > 0.01

    # 3. reverb_throw & 4. delay_throw spillover verification:
    # Put silence after t=2.0 in main.wav so tail spillover after end=1.5 is unmistakably measurable
    tailed = dry.copy()
    tailed[int(1.5 * sr) :] = 0.0
    sf.write(str(main_wav_path), tailed, sr, subtype="PCM_16")

    out_rev, _ = render_operations(
        store,
        project,
        [EditOperation(type="reverb_throw", start=0.5, end=1.5, room_size=0.85, wet_level=0.7, snap_to_beat=False)],
    )
    rev_tail = out_rev[int(1.7 * sr) : int(2.5 * sr)]
    assert float(np.sqrt(np.mean(rev_tail**2))) > 1e-3, "Expected natural reverb tail spillover past end"

    out_dly, _ = render_operations(
        store,
        project,
        [
            EditOperation(
                type="delay_throw",
                start=0.5,
                end=1.5,
                delay_beats=0.5,
                feedback=0.6,
                mix=0.7,
                snap_to_beat=False,
            )
        ],
    )
    dly_tail = out_dly[int(1.6 * sr) : int(2.6 * sr)]
    assert float(np.sqrt(np.mean(dly_tail**2))) > 1e-3, "Expected tempo-synced delay spillover past end"

    # Restore full audio for EQ checks
    sf.write(str(main_wav_path), dry, sr, subtype="PCM_16")

    # 5. lofi_eq
    out_lofi, _ = render_operations(
        store,
        project,
        [
            EditOperation(
                type="lofi_eq",
                start=1.0,
                end=3.0,
                low_cut_hz=400.0,
                high_cut_hz=2400.0,
                drive_db=12.0,
                snap_to_beat=False,
            )
        ],
    )
    assert float(np.mean(np.abs(out_lofi[int(1.2 * sr) : int(2.8 * sr)] - dry[int(1.2 * sr) : int(2.8 * sr)]))) > 0.01

    # 6. bass_boost
    out_bass, _ = render_operations(
        store,
        project,
        [
            EditOperation(
                type="bass_boost",
                start=1.0,
                end=3.0,
                gain_db=9.0,
                cutoff_hz=150.0,
                snap_to_beat=False,
            )
        ],
    )
    assert float(np.mean(np.abs(out_bass[int(1.2 * sr) : int(2.8 * sr)] - dry[int(1.2 * sr) : int(2.8 * sr)]))) > 0.005


def test_borrow_stem_with_bpm_key_match_and_stem_ducking(client: TestClient) -> None:
    pid = _setup_project_with_main(client, duration=6.0, bpm=120.0)
    sr = 44100

    # Create synthetic separated main stems (drums has loud 100 Hz tone, vocals has 600 Hz tone)
    t = np.arange(int(6.0 * sr), dtype=np.float32) / float(sr)
    drums_stem = np.stack([0.3 * np.sin(2 * np.pi * 100 * t)] * 2, axis=-1)
    vocals_stem = np.stack([0.2 * np.sin(2 * np.pi * 600 * t)] * 2, axis=-1)
    zeros_stem = np.zeros_like(drums_stem)

    stems_dir = store.main_stems_dir(pid)
    stems_dir.mkdir(parents=True, exist_ok=True)
    sf.write(str(stems_dir / "drums.wav"), drums_stem, sr, subtype="PCM_16")
    sf.write(str(stems_dir / "vocals.wav"), vocals_stem, sr, subtype="PCM_16")
    sf.write(str(stems_dir / "bass.wav"), zeros_stem, sr, subtype="PCM_16")
    sf.write(str(stems_dir / "other.wav"), zeros_stem, sr, subtype="PCM_16")

    def _set_stems_ready(proj: ProjectState) -> None:
        assert proj.main_track is not None
        proj.main_track.stems_status = "ready"
        proj.main_track.stems = ["vocals", "drums", "bass", "other"]
        proj.main_track.bpm = 120.0
        proj.main_track.key = "C Major"

    store.update_project(pid, _set_stems_ready)

    # Upload reference track at a different BPM (100 BPM) and different key (D Major)
    ref_audio = make_synthetic_track(duration=4.0, sr=44100, bpm=100.0, root_hz=293.66, varying_energy=False)
    r_ref = client.post(
        f"/api/projects/{pid}/references/upload",
        files={"file": ("ref_groove.wav", wav_bytes_from_array(ref_audio), "audio/wav")},
        data={"title": "Ref Groove"},
    )
    assert r_ref.status_code == 200
    ref_id = r_ref.json()["references"][0]["id"]

    # Force explicit distinct bpm/key on ref so both time_stretch and pitch_shift definitely run
    def _set_ref_meta(proj: ProjectState) -> None:
        proj.references[0].bpm = 100.0
        proj.references[0].key = "D Major"

    project = store.update_project(pid, _set_ref_meta)

    borrow_op = EditOperation(
        type="borrow_stem",
        ref_id=ref_id,
        ref_stem="full",
        ref_start=0.5,
        ref_end=2.5,
        target_start=1.0,
        target_end=3.0,
        replace_main_stems=["drums"],
        match_bpm=True,
        match_key=True,
        snap_to_beat=False,
    )
    out, out_sr = render_operations(store, project, [borrow_op])
    assert out_sr == sr
    assert not np.any(np.isnan(out))
    assert float(np.max(np.abs(out))) <= 0.999

    # Baseline without borrow_stem
    base, _ = render_operations(store, project, [])
    # Target window [1.0, 3.0] must reflect replaced drums + borrowed ref audio
    assert float(np.mean(np.abs(out[int(1.2 * sr) : int(2.8 * sr)] - base[int(1.2 * sr) : int(2.8 * sr)]))) > 0.02
    # Outside window [0.0, 0.8] remains untouched
    assert np.allclose(out[: int(0.8 * sr)], base[: int(0.8 * sr)], atol=1e-4)


def test_edit_lifecycle_toggle_delete_undo_redo(client: TestClient) -> None:
    pid = _setup_project_with_main(client, duration=4.0)

    r1 = client.post(
        f"/api/projects/{pid}/edits",
        json={
            "title": "Lo-Fi Intro",
            "description": "Warm telephone vibe",
            "start": 0.0,
            "end": 2.0,
            "operations": [{"type": "lofi_eq", "start": 0.0, "end": 2.0, "low_cut_hz": 350, "high_cut_hz": 2800}],
        },
    )
    assert r1.status_code == 200
    p1 = r1.json()
    assert len(p1["edits"]) == 1
    assert p1["render_version"] == 1
    e1_id = p1["edits"][0]["id"]

    # Add second edit
    r2 = client.post(
        f"/api/projects/{pid}/edits",
        json={
            "title": "Bass Punch",
            "description": "Extra sub",
            "start": 2.0,
            "end": 4.0,
            "operations": [{"type": "bass_boost", "start": 2.0, "end": 4.0, "gain_db": 6.0}],
        },
    )
    assert r2.status_code == 200
    p2 = r2.json()
    assert len(p2["edits"]) == 2
    assert p2["render_version"] == 2

    # Toggle first edit off
    r_patch = client.patch(f"/api/projects/{pid}/edits/{e1_id}", json={"enabled": False})
    assert r_patch.status_code == 200
    assert r_patch.json()["edits"][0]["enabled"] is False
    assert r_patch.json()["render_version"] == 3

    # Undo pops second edit onto redo_stack
    r_undo = client.post(f"/api/projects/{pid}/undo")
    assert r_undo.status_code == 200
    pu = r_undo.json()
    assert len(pu["edits"]) == 1
    assert len(pu["redo_stack"]) == 1
    assert pu["render_version"] == 4

    # Redo restores second edit
    r_redo = client.post(f"/api/projects/{pid}/redo")
    assert r_redo.status_code == 200
    pr = r_redo.json()
    assert len(pr["edits"]) == 2
    assert len(pr["redo_stack"]) == 0
    assert pr["render_version"] == 5

    # Delete first edit
    r_del = client.delete(f"/api/projects/{pid}/edits/{e1_id}")
    assert r_del.status_code == 200
    assert len(r_del.json()["edits"]) == 1
    assert r_del.json()["render_version"] == 6

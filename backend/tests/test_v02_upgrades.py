"""Comprehensive tests for Musak v0.2 upgrades: compatibility, tempo_pitch, tuning, mashup, mastering/export, hooks."""

from __future__ import annotations

import io
import json
import zipfile
from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from musak import gemini_agent
from musak.audio_analysis import compute_mashup_compatibility
from musak.config import STEM_NAMES
from musak.dsp import (
    MAX_PREVIEW_SECONDS,
    apply_master_preset,
    compute_effective_borrow_rate,
    export_mix,
    render_operations,
    render_proposal_preview,
    tune_proposal_operations,
)
from musak.models import EditOperation, EditProposal, ProjectState
from musak.storage import store
from tests.conftest import make_synthetic_track, wav_bytes_from_array


def _setup_project_with_main_and_stems(
    client: TestClient,
    duration: float = 4.0,
    bpm: float = 120.0,
    with_stems: bool = True,
) -> str:
    pid = client.post("/api/projects", json={"name": "v0.2 Studio"}).json()["id"]
    audio = make_synthetic_track(duration=duration, sr=44100, bpm=bpm, root_hz=261.63, varying_energy=False)
    r = client.post(
        f"/api/projects/{pid}/main-track",
        files={"file": ("main.wav", wav_bytes_from_array(audio), "audio/wav")},
    )
    assert r.status_code == 200

    if with_stems:
        sr = 44100
        t = np.arange(int(duration * sr), dtype=np.float32) / float(sr)
        stems_dir = store.main_stems_dir(pid)
        stems_dir.mkdir(parents=True, exist_ok=True)
        # Distinct sine frequencies per stem so instrumental vs vocals export is measurably distinct
        freqs = {"vocals": 880.0, "drums": 110.0, "bass": 65.0, "other": 330.0}
        for name, hz in freqs.items():
            tone = np.stack([0.2 * np.sin(2.0 * np.pi * hz * t)] * 2, axis=-1).astype(np.float32)
            sf.write(str(stems_dir / f"{name}.wav"), tone, sr, subtype="PCM_16")

        def _ready(proj: ProjectState) -> None:
            assert proj.main_track is not None
            proj.main_track.stems_status = "ready"
            proj.main_track.stems = list(STEM_NAMES)
            proj.main_track.stem_urls = store.stem_urls(pid, list(STEM_NAMES), track_id=proj.main_track.id)
            proj.main_track.bpm = bpm
            proj.main_track.key = "C Major"

        store.update_project(pid, _ready)

    return pid


def test_mashup_compatibility_scoring_and_enrichment(client: TestClient) -> None:
    assert compute_mashup_compatibility(None, "C Major", 120.0, "C Major") is None
    assert compute_mashup_compatibility(120.0, "C Major", None, "C Major") is None

    exact = compute_mashup_compatibility(120.0, "C Major", 120.0, "C Major")
    assert exact is not None
    assert exact.score == 100
    assert exact.rating == "great"
    assert exact.bpm_diff == 0.0
    assert exact.semitone_diff == 0

    # Half-time and double-time BPM should match with 0 BPM diff!
    half = compute_mashup_compatibility(120.0, "C Major", 60.0, "A Minor")  # A Minor is relative minor of C Major!
    assert half is not None
    assert half.bpm_diff == 0.0
    assert half.semitone_diff == 0
    assert half.rating == "great"

    double = compute_mashup_compatibility(120.0, "C Major", 240.0, "C# Major")
    assert double is not None
    assert double.bpm_diff == 0.0
    assert double.semitone_diff == 1
    assert double.rating == "great"

    good = compute_mashup_compatibility(120.0, "C Major", 128.0, "D Major")
    assert good is not None
    assert good.rating == "good"

    tricky = compute_mashup_compatibility(120.0, "C Major", 148.0, "F# Major")
    assert tricky is not None
    assert tricky.rating == "tricky"

    # Enriched dynamically on API responses
    pid = _setup_project_with_main_and_stems(client, duration=4.0, bpm=120.0, with_stems=False)
    ref_wav = wav_bytes_from_array(make_synthetic_track(duration=3.0, bpm=120.0, root_hz=261.63))
    r_up = client.post(
        f"/api/projects/{pid}/references/upload",
        files={"file": ("ref.wav", ref_wav, "audio/wav")},
    )
    assert r_up.status_code == 200
    compat = r_up.json()["references"][0]["compatibility"]
    assert compat is not None
    assert 0 <= compat["score"] <= 100
    assert compat["rating"] in ("great", "good", "tricky")
    assert compat["summary"]


def test_tempo_pitch_full_track_and_slice(client: TestClient) -> None:
    pid = _setup_project_with_main_and_stems(client, duration=4.0, bpm=120.0, with_stems=False)
    project = store.get_project(pid)
    assert project.main_track is not None
    sr = 44100
    dry, _ = sf.read(str(store.get_main_audio_path(pid, project.main_track.id)), dtype="float32", always_2d=True)

    # Full-track Slowed + Reverb scales output length naturally (~1.25x longer)
    slowed_op = EditOperation(
        type="tempo_pitch",
        start=0.0,
        end=project.main_track.duration,
        speed_rate=0.8,
        semitones=-2.0,
        add_reverb=True,
        reverb_wet=0.4,
        snap_to_beat=False,
    )
    out_slow, out_sr = render_operations(store, project, [slowed_op])
    assert out_sr == sr
    assert not np.any(np.isnan(out_slow))
    assert float(np.max(np.abs(out_slow))) <= 0.999
    assert len(out_slow) > int(len(dry) * 1.15), "Expected full-track Slowed+Reverb to lengthen audio"

    # Full-track Sped Up shortens audio naturally (~0.8x)
    sped_op = EditOperation(
        type="tempo_pitch",
        start=0.0,
        end=project.main_track.duration,
        speed_rate=1.25,
        semitones=2.0,
        add_reverb=False,
        snap_to_beat=False,
    )
    out_fast, _ = render_operations(store, project, [sped_op])
    assert len(out_fast) < int(len(dry) * 0.88), "Expected full-track Sped Up to shorten audio"

    # Sub-slice pitch shift keeps total length constant and leaves outside untouched
    slice_op = EditOperation(
        type="tempo_pitch",
        start=1.0,
        end=2.5,
        speed_rate=1.0,
        semitones=3.0,
        add_reverb=False,
        snap_to_beat=False,
    )
    out_slice, _ = render_operations(store, project, [slice_op])
    assert len(out_slice) == len(dry)
    assert np.allclose(out_slice[: int(0.9 * sr)], dry[: int(0.9 * sr)], atol=1e-4)
    assert float(np.mean(np.abs(out_slice[int(1.2 * sr) : int(2.3 * sr)] - dry[int(1.2 * sr) : int(2.3 * sr)]))) > 0.02


def test_proposal_tuning_non_destructive_and_zero_llm_calls(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 1. Pure unit checks on tune_proposal_operations
    base_ops = [
        EditOperation(type="stem_gain", start=1.0, end=2.0, gain_db=-80.0, stems=["drums"]),
        EditOperation(type="reverb_throw", start=1.0, end=3.0, wet_level=0.4, room_size=0.7),
        EditOperation(type="bass_boost", start=1.0, end=3.0, gain_db=6.0),
    ]
    tuned = tune_proposal_operations(
        base_ops,
        intensity=0.5,
        keep_vocals_clear=True,
        shift_beats=2.0,
        bpm=120.0,
        duration=8.0,
    )
    # Deep dropout <= -40 dB is NEVER weakened!
    assert tuned[0].gain_db == -80.0
    # Reverb & bass boost scaled down cleanly
    assert tuned[1].wet_level == pytest.approx(0.2, abs=1e-3)
    assert tuned[2].gain_db == pytest.approx(3.0, abs=1e-3)
    # Vocals excluded when keep_vocals_clear=True
    assert tuned[1].stems == ["drums", "bass", "other"]
    assert "vocals" not in (tuned[2].stems or [])
    # +2 beats at 120 BPM == +1.0s shift
    assert tuned[1].start == 2.0 and tuned[1].end == 4.0

    # 2. Full HTTP test of POST /proposals/{proposal_id}/tune with zero Gemini calls
    pid = _setup_project_with_main_and_stems(client, duration=6.0, bpm=120.0, with_stems=False)
    client.post("/api/settings/api-key", json={"api_key": "fake-key"})

    class _FakeModels:
        def generate_content(self, *, model: str, contents: Any, config: Any) -> Any:
            return SimpleNamespace(
                text=json.dumps(
                    {
                        "reply": "Try this dreamy reverb throw!",
                        "proposals": [
                            {
                                "title": "Dreamy Throw",
                                "summary": "Lush reverb + warmth",
                                "style": "creative",
                                "start": 1.0,
                                "end": 3.0,
                                "operations": [
                                    {"type": "reverb_throw", "start": 1.0, "end": 3.0, "wet_level": 0.4, "room_size": 0.7},
                                    {"type": "lofi_eq", "start": 1.0, "end": 3.0, "drive_db": 8.0},
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

    p_chat = client.post(
        f"/api/projects/{pid}/chat",
        json={"message": "Add dreamy reverb", "selection": {"start": 1.0, "end": 3.0}},
    ).json()
    prop = p_chat["chat_messages"][1]["proposals"][0]
    prop_id = prop["id"]
    orig_preview_url = prop["preview_url"]
    assert len(prop["base_operations"]) == 2

    # Ensure Gemini is NEVER called during /tune
    def _forbid_llm(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("Tuning must be 100% local with zero Gemini calls!")

    monkeypatch.setattr(gemini_agent.genai, "Client", _forbid_llm)

    r_tune1 = client.post(
        f"/api/projects/{pid}/proposals/{prop_id}/tune",
        json={"intensity": 1.5, "keep_vocals_clear": True, "shift_beats": 1.0},
    )
    assert r_tune1.status_code == 200
    t1_prop = r_tune1.json()["chat_messages"][1]["proposals"][0]
    assert t1_prop["intensity"] == 1.5
    assert t1_prop["keep_vocals_clear"] is True
    assert t1_prop["shift_beats"] == 1.0
    assert t1_prop["operations"][0]["wet_level"] == pytest.approx(0.6, abs=1e-3)
    assert t1_prop["operations"][0]["stems"] == ["drums", "bass", "other"]
    assert t1_prop["preview_url"] != orig_preview_url
    assert "?t=" in t1_prop["preview_url"]
    assert client.get(t1_prop["preview_url"]).status_code == 200

    # Retuning back to defaults restores original parameters non-destructively from base_operations
    r_tune2 = client.post(
        f"/api/projects/{pid}/proposals/{prop_id}/tune",
        json={"intensity": 1.0, "keep_vocals_clear": False, "shift_beats": 0.0},
    )
    assert r_tune2.status_code == 200
    t2_prop = r_tune2.json()["chat_messages"][1]["proposals"][0]
    assert t2_prop["operations"][0]["wet_level"] == pytest.approx(0.4, abs=1e-3)
    assert t2_prop["operations"][0]["start"] == 1.0


def test_auto_mashup_modes_and_missing_stems_errors(client: TestClient) -> None:
    pid = _setup_project_with_main_and_stems(client, duration=4.0, bpm=120.0, with_stems=False)
    ref_audio = make_synthetic_track(duration=4.0, sr=44100, bpm=125.0, root_hz=293.66)
    ref_id = client.post(
        f"/api/projects/{pid}/references/upload",
        files={"file": ("pop_ref.wav", wav_bytes_from_array(ref_audio), "audio/wav")},
        data={"title": "Pop Ref"},
    ).json()["references"][0]["id"]

    # Missing stems return clear HTTP 400
    r_err1 = client.post(f"/api/projects/{pid}/mashup", json={"ref_id": ref_id, "mode": "ref_vocals_on_main"})
    assert r_err1.status_code == 400
    assert "stems" in r_err1.json()["detail"].lower()

    r_err2 = client.post(f"/api/projects/{pid}/mashup", json={"ref_id": ref_id, "mode": "main_vocals_on_ref"})
    assert r_err2.status_code == 400

    # Now populate stems on BOTH main and reference
    pid2 = _setup_project_with_main_and_stems(client, duration=4.0, bpm=120.0, with_stems=True)
    ref_id2 = client.post(
        f"/api/projects/{pid2}/references/upload",
        files={"file": ("pop_ref2.wav", wav_bytes_from_array(ref_audio), "audio/wav")},
        data={"title": "Pop Ref 2"},
    ).json()["references"][0]["id"]

    ref_stems_dir = store.reference_stems_dir(pid2, ref_id2)
    ref_stems_dir.mkdir(parents=True, exist_ok=True)
    for stem in STEM_NAMES:
        sf.write(str(ref_stems_dir / f"{stem}.wav"), ref_audio * 0.25, 44100, subtype="PCM_16")

    def _mark_ref_ready(proj: ProjectState) -> None:
        proj.references[0].stems_status = "ready"
        proj.references[0].bpm = 125.0
        proj.references[0].key = "D Major"

    store.update_project(pid2, _mark_ref_ready)

    for idx, mode in enumerate(("ref_vocals_on_main", "main_vocals_on_ref", "ref_drums_on_main", "smart_auto"), 1):
        r_m = client.post(
            f"/api/projects/{pid2}/mashup",
            json={"ref_id": ref_id2, "mode": mode, "start": 0.5, "end": 2.5},
        )
        assert r_m.status_code == 200, f"Mode {mode} failed: {r_m.text}"
        body = r_m.json()
        assert len(body["edits"]) == idx
        assert body["render_version"] == idx


def test_master_presets_and_multi_target_exports(client: TestClient) -> None:
    sr = 44100
    raw = make_synthetic_track(duration=2.0, sr=sr, bpm=120.0, varying_energy=False)
    for preset in ("off", "balanced", "club", "warm"):
        out = apply_master_preset(raw, sr, preset)  # type: ignore[arg-type]
        assert out.shape == raw.shape
        assert not np.any(np.isnan(out))
        assert float(np.max(np.abs(out))) <= 0.999

    # Before stems are ready, instrumental/vocals/stems_zip exports return 400
    pid_no_stems = _setup_project_with_main_and_stems(client, duration=2.0, with_stems=False)
    for target in ("instrumental", "vocals", "stems_zip"):
        r = client.post(f"/api/projects/{pid_no_stems}/export", json={"format": "wav", "target": target})
        assert r.status_code == 400

    # With stems ready, all export targets and master presets succeed
    pid = _setup_project_with_main_and_stems(client, duration=2.0, with_stems=True)

    r_remix = client.post(
        f"/api/projects/{pid}/export",
        json={"format": "wav", "target": "remix", "master_preset": "club"},
    )
    assert r_remix.status_code == 200
    rem_data, rem_sr = sf.read(io.BytesIO(r_remix.content))
    assert rem_sr == 44100 and rem_data.shape[1] == 2

    r_inst = client.post(
        f"/api/projects/{pid}/export",
        json={"format": "wav", "target": "instrumental", "master_preset": "balanced"},
    )
    assert r_inst.status_code == 200
    inst_data, inst_sr = sf.read(io.BytesIO(r_inst.content))
    assert inst_sr == 44100 and len(inst_data) > 0

    r_vox = client.post(
        f"/api/projects/{pid}/export",
        json={"format": "mp3", "target": "vocals", "master_preset": "warm"},
    )
    assert r_vox.status_code == 200
    assert len(r_vox.content) > 500

    r_zip = client.post(
        f"/api/projects/{pid}/export",
        json={"format": "zip", "target": "stems_zip", "master_preset": "off"},
    )
    assert r_zip.status_code == 200
    assert r_zip.headers.get("content-type") == "application/zip"
    with zipfile.ZipFile(io.BytesIO(r_zip.content), "r") as zf:
        names = set(zf.namelist())
        assert names == {"vocals.wav", "drums.wav", "bass.wav", "other.wav"}


def test_extract_lyric_hooks_endpoint(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pid = _setup_project_with_main_and_stems(client, duration=8.0, with_stems=False)

    # Missing API key -> 400
    assert client.post(f"/api/projects/{pid}/main-track/extract-hooks").status_code == 400

    class _FakeModels:
        def generate_content(self, *, model: str, contents: Any, config: Any) -> Any:
            return SimpleNamespace(
                text=json.dumps(
                    {
                        "hooks": [
                            {"text": "Big synth drop", "start": 5.0, "end": 7.5, "kind": "drop"},
                            {"text": "Meet me on the dancefloor", "start": 1.0, "end": 3.5, "kind": "hook"},
                            {"text": "Turn the lights down low", "start": 3.5, "end": 5.0, "kind": "lyric"},
                        ]
                    }
                )
            )

    class _FakeClient:
        def __init__(self, api_key: str) -> None:
            self.models = _FakeModels()

    monkeypatch.setattr(gemini_agent.genai, "Client", _FakeClient)

    r_hooks = client.post(
        f"/api/projects/{pid}/main-track/extract-hooks",
        headers={"X-Gemini-Api-Key": "fake-key"},
    )
    assert r_hooks.status_code == 200
    hooks = r_hooks.json()["main_track"]["lyric_hooks"]
    assert len(hooks) == 3
    # Sorted by start time
    assert [h["start"] for h in hooks] == [1.0, 3.5, 5.0]
    assert hooks[0]["kind"] == "hook"
    assert hooks[2]["kind"] == "drop"

    # Persisted on subsequent GET
    persisted = client.get(f"/api/projects/{pid}").json()["main_track"]["lyric_hooks"]
    assert len(persisted) == 3


def test_v02_review_fixes_half_double_borrow_vocal_skip_exports_mashup_clamp_and_preview_cap(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 1. Half/double-time BPM borrow rate (~1.0x for 140 vs 70 BPM, never 2.0x chipmunk speed!)
    assert compute_effective_borrow_rate(140.0, 70.0) == pytest.approx(1.0, abs=1e-4)
    assert compute_effective_borrow_rate(70.0, 140.0) == pytest.approx(1.0, abs=1e-4)
    assert compute_effective_borrow_rate(140.0, 72.0) == pytest.approx(140.0 / 144.0, abs=1e-3)

    # 2. Vocal-only stem_gain is DROPPED under keep_vocals_clear=True (never redirected to instrumental!)
    ops = [
        EditOperation(type="stem_gain", stems=["vocals"], start=1.0, end=2.0, gain_db=-80.0),
        EditOperation(type="reverb_throw", stems=["vocals", "other"], start=1.0, end=3.0, wet_level=0.4),
    ]
    tuned = tune_proposal_operations(ops, intensity=1.0, keep_vocals_clear=True, shift_beats=0.0, bpm=120.0, duration=8.0)
    assert len(tuned) == 1
    assert tuned[0].type == "reverb_throw"
    assert tuned[0].stems == ["other"]

    # 3. Unique nonced export filenames across back-to-back exports
    pid = _setup_project_with_main_and_stems(client, duration=2.0, bpm=140.0, with_stems=True)
    proj = store.get_project(pid)
    p1 = export_mix(store, proj, fmt="wav", target="remix", master_preset="off")
    p2 = export_mix(store, proj, fmt="wav", target="remix", master_preset="off")
    assert p1.name != p2.name
    assert p2.is_file()

    # 4. Out-of-range pinned moment in /mashup is clamped cleanly so ref_start < ref_end <= ref_dur
    ref_audio = make_synthetic_track(duration=3.0, sr=44100, bpm=70.0)
    ref_id = client.post(
        f"/api/projects/{pid}/references/upload",
        files={"file": ("half_bpm.wav", wav_bytes_from_array(ref_audio), "audio/wav")},
        data={"title": "Half Tempo"},
    ).json()["references"][0]["id"]
    ref_stems_dir = store.reference_stems_dir(pid, ref_id)
    ref_stems_dir.mkdir(parents=True, exist_ok=True)
    for stem in STEM_NAMES:
        sf.write(str(ref_stems_dir / f"{stem}.wav"), ref_audio * 0.25, 44100, subtype="PCM_16")

    def _ready_ref(p: ProjectState) -> None:
        p.references[0].stems_status = "ready"
        p.references[0].bpm = 70.0

    store.update_project(pid, _ready_ref)
    # Pin a moment WAY beyond the 3s reference duration
    client.post(
        f"/api/projects/{pid}/references/{ref_id}/moments",
        json={"label": "Far Out", "start": 50.0, "end": 60.0},
    )
    r_m = client.post(
        f"/api/projects/{pid}/mashup",
        json={"ref_id": ref_id, "mode": "ref_vocals_on_main", "start": 0.0, "end": 1.5},
    )
    assert r_m.status_code == 200
    borrow_op = r_m.json()["edits"][-1]["operations"][0]
    assert 0.0 <= borrow_op["ref_start"] < borrow_op["ref_end"] <= 3.05

    # 5. Whole-track Slowed + Reverb preview on a 28s track is capped strictly at <= 24s!
    pid_long = _setup_project_with_main_and_stems(client, duration=28.0, bpm=120.0, with_stems=False)
    long_proj = store.get_project(pid_long)
    assert long_proj.main_track is not None
    whole_prop = EditProposal(
        id="prop_slowed_cap",
        title="Slowed + Reverb",
        summary="Dreamy slowed full track",
        style="creative",
        start=0.0,
        end=long_proj.main_track.duration,
        operations=[
            EditOperation(
                type="tempo_pitch",
                start=0.0,
                end=long_proj.main_track.duration,
                speed_rate=0.85,
                semitones=-2.0,
                add_reverb=True,
                reverb_wet=0.35,
                snap_to_beat=False,
            )
        ],
    )
    prev_path = render_proposal_preview(store, long_proj, whole_prop, nonce="cap1")
    info = sf.info(str(prev_path))
    prev_dur = info.frames / float(info.samplerate)
    assert prev_dur <= MAX_PREVIEW_SECONDS + 0.05
    assert (whole_prop.preview_end - whole_prop.preview_start) <= MAX_PREVIEW_SECONDS + 0.05

    # 6. extract_lyric_hooks clamps timestamps strictly inside [0, analyzed_end]
    class _OverflowModels:
        def generate_content(self, *, model: str, contents: Any, config: Any) -> Any:
            return SimpleNamespace(
                text=json.dumps(
                    {
                        "hooks": [
                            {"text": "Way past EOF", "start": 999.0, "end": 1020.0, "kind": "hook"},
                        ]
                    }
                )
            )

    class _OverflowClient:
        def __init__(self, api_key: str) -> None:
            self.models = _OverflowModels()

    monkeypatch.setattr(gemini_agent.genai, "Client", _OverflowClient)
    r_h = client.post(
        f"/api/projects/{pid}/main-track/extract-hooks",
        headers={"X-Gemini-Api-Key": "fake"},
    )
    assert r_h.status_code == 200
    clamped_hook = r_h.json()["main_track"]["lyric_hooks"][0]
    assert 0.0 <= clamped_hook["start"] < clamped_hook["end"] <= 2.01


def test_gemini_token_efficiency_minimal_thinking_and_surgical_pushback(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from google.genai import types

    from musak.routers import references as refs_router

    pid = _setup_project_with_main_and_stems(client, duration=12.0, bpm=120.0, with_stems=False)

    # Add a YouTube reference that HAS already been downloaded locally -> must prefer compact 12 kHz WAV over video URI!
    monkeypatch.setattr(
        refs_router,
        "fetch_youtube_metadata",
        lambda url: {
            "youtube_id": "dQw4w9WgXcQ",
            "youtube_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "title": "Downloaded YT Ref",
            "duration": 20.0,
        },
    )
    yt_ref_id = client.post(
        f"/api/projects/{pid}/references/youtube",
        json={"url": "https://youtu.be/dQw4w9WgXcQ"},
    ).json()["references"][0]["id"]

    yt_wav = store.reference_audio_path(pid, yt_ref_id)
    yt_wav.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(yt_wav), make_synthetic_track(duration=15.0, sr=44100), 44100, subtype="PCM_16")

    def _mark_yt_downloaded(p: ProjectState) -> None:
        p.references[0].audio_downloaded = True

    store.update_project(pid, _mark_yt_downloaded)

    captured_calls: list[dict[str, Any]] = []

    class _FakeModels:
        def generate_content(self, *, model: str, contents: Any, config: Any) -> Any:
            captured_calls.append({"model": model, "contents": contents, "config": config})
            # Return 4 proposals to verify backend caps to <= 2 proposals!
            return SimpleNamespace(
                text=json.dumps(
                    {
                        "reply": "Musak works best one moment at a time — try this quick tension sweep on your drop!",
                        "proposals": [
                            {
                                "title": f"Option {i}",
                                "summary": "Short surgical tweak.",
                                "style": "creative",
                                "start": 2.0,
                                "end": 6.0,
                                "operations": [
                                    {"type": "filter_sweep", "start": 2.0, "end": 5.0, "mode": "highpass", "start_hz": 120, "end_hz": 1800},
                                    {"type": "reverb_throw", "start": 4.5, "end": 6.0, "wet_level": 0.4},
                                    {"type": "bass_boost", "start": 5.0, "end": 6.0, "gain_db": 4.0},
                                    {"type": "lofi_eq", "start": 2.0, "end": 4.0, "drive_db": 6.0},
                                ],
                            }
                            for i in range(1, 5)
                        ],
                    }
                )
            )

    class _FakeClient:
        def __init__(self, api_key: str) -> None:
            self.models = _FakeModels()

    monkeypatch.setattr(gemini_agent.genai, "Client", _FakeClient)

    r = client.post(
        f"/api/projects/{pid}/chat",
        headers={"X-Gemini-Api-Key": "test-dummy-key"},
        json={
            "message": "Rewrite the entire song in the style of Daft Punk",
            "selection": None,
            "reference_ids": [yt_ref_id],
        },
    )
    assert r.status_code == 200
    proj = r.json()
    proposals = proj["chat_messages"][1]["proposals"]
    # Capped to at most 2 proposals, each capped to <= 3 ops
    assert len(proposals) == 2
    assert len(proposals[0]["operations"]) == 3

    call = captured_calls[0]
    cfg = call["config"]
    assert cfg.max_output_tokens == 600
    assert cfg.thinking_config is not None
    assert cfg.thinking_config.thinking_level == types.ThinkingLevel.MINIMAL

    contents = call["contents"]
    sys_prompt = contents[0]
    assert "PUSHBACK" in sys_prompt
    assert "SMALL, SURGICAL" in sys_prompt
    assert "1-2 focused proposals max" in sys_prompt

    # Downloaded YouTube reference must use compact 12 kHz WAV clip instead of video URI!
    inline_parts = [p for p in contents if getattr(p, "inline_data", None) is not None]
    uri_parts = [p for p in contents if getattr(p, "file_data", None) is not None]
    assert len(uri_parts) == 0
    assert len(inline_parts) == 2
    for part in inline_parts:
        wav_data, wav_sr = sf.read(io.BytesIO(part.inline_data.data))
        assert wav_sr == 12000
        assert (len(wav_data) / float(wav_sr)) <= 16.05

    # Verify graceful retry without thinking_config when a custom model rejects it
    retry_configs: list[Any] = []

    class _RejectThinkingModels:
        def generate_content(self, *, model: str, contents: Any, config: Any) -> Any:
            retry_configs.append(config)
            if getattr(config, "thinking_config", None) is not None:
                raise RuntimeError("INVALID_ARGUMENT: thinking_config is unsupported for this model")
            return SimpleNamespace(text="Drop the drums at 0:45")

    class _RejectThinkingClient:
        def __init__(self, api_key: str) -> None:
            self.models = _RejectThinkingModels()

    monkeypatch.setattr(gemini_agent.genai, "Client", _RejectThinkingClient)
    out_text = gemini_agent.transcribe_voice_audio(b"fake-bytes", "audio/webm", "test-dummy-key", "custom-model")
    assert out_text == "Drop the drums at 0:45"
    assert len(retry_configs) == 2
    assert retry_configs[0].thinking_config is not None
    assert retry_configs[0].max_output_tokens == 200
    assert retry_configs[1].thinking_config is None

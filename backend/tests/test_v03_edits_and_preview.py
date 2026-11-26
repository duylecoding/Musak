"""Tests for Musak v0.3: drag/resize/gain PATCH edits and fast sliced previews."""

from __future__ import annotations

from typing import Any

import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from musak.dsp import MAX_PREVIEW_SECONDS, render_proposal_preview
from musak.models import EditOperation, EditProposal
from musak.storage import store
from tests.test_v03_timeline_and_sfx import _create_project_with_main


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

    assert client.patch(f"/api/projects/{pid}/edits/{edit_id}", json={"title": "   "}).status_code == 422
    assert client.patch(f"/api/projects/{pid}/edits/{edit_id}", json={"start": 4.0, "end": 3.0}).status_code == 422

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

    r_wav = client.get(f"/api/projects/{pid}/audio/rendered")
    assert r_wav.status_code == 200
    assert len(r_wav.content) > 1000


def test_fast_sliced_preview_with_stems_does_not_read_full_song(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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
    assert 6.5 <= prev_dur <= 7.5
    assert prop.preview_start == pytest.approx(8.5, abs=0.05)
    assert prop.preview_end == pytest.approx(15.5, abs=0.05)

    assert len(read_calls) == 4
    total_frames_26s = int(round(26.0 * 44100))
    for s_frame, e_frame in read_calls:
        assert s_frame is not None and e_frame is not None
        assert (e_frame - s_frame) < total_frames_26s
        assert (e_frame - s_frame) <= int(round((MAX_PREVIEW_SECONDS + 0.1) * 44100))

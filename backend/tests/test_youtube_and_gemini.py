"""Tests for YouTube URL parsing/validation and mocked Gemini Producer auto-tag, chat, preview, & apply."""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient

from musak import gemini_agent, main as musak_main
from musak.youtube import canonical_youtube_url, extract_youtube_id
from tests.conftest import make_synthetic_track, wav_bytes_from_array


def test_youtube_url_validation_and_id_extraction() -> None:
    vid = "dQw4w9WgXcQ"
    assert extract_youtube_id(f"https://www.youtube.com/watch?v={vid}&t=42s") == vid
    assert extract_youtube_id(f"https://youtu.be/{vid}?si=abc") == vid
    assert extract_youtube_id(f"https://www.youtube.com/shorts/{vid}") == vid
    assert extract_youtube_id(f"https://music.youtube.com/watch?v={vid}") == vid
    assert canonical_youtube_url(vid) == f"https://www.youtube.com/watch?v={vid}"

    for bad_url in (
        "https://vimeo.com/123456",
        "ftp://youtube.com/watch?v=dQw4w9WgXcQ",
        "https://www.youtube.com/watch?v=short",
        "not-a-url",
    ):
        with pytest.raises(ValueError):
            extract_youtube_id(bad_url)


def test_youtube_reference_and_mocked_gemini_auto_tag(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pid = client.post("/api/projects", json={"name": "YT Inspo"}).json()["id"]

    # Reject invalid YouTube URL via API
    r_bad = client.post(f"/api/projects/{pid}/references/youtube", json={"url": "https://example.com/abc"})
    assert r_bad.status_code == 400

    # Mock lightweight YouTube metadata lookup (no network)
    monkeypatch.setattr(
        musak_main,
        "fetch_youtube_metadata",
        lambda url: {
            "youtube_id": "dQw4w9WgXcQ",
            "youtube_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "title": "Synth Pop Classic",
            "duration": 212.0,
        },
    )

    r_add = client.post(
        f"/api/projects/{pid}/references/youtube",
        json={"url": "https://youtu.be/dQw4w9WgXcQ"},
    )
    assert r_add.status_code == 200
    ref = r_add.json()["references"][0]
    assert ref["source_type"] == "youtube"
    assert ref["youtube_id"] == "dQw4w9WgXcQ"
    assert ref["audio_downloaded"] is False
    ref_id = ref["id"]

    # Calling auto-tag without an API key returns 400
    assert client.post(f"/api/projects/{pid}/references/{ref_id}/auto-tag").status_code == 400

    # Mock google.genai.Client to capture Tier 1 Part.from_uri call
    captured_calls: list[dict[str, Any]] = []

    class _FakeModels:
        def generate_content(self, *, model: str, contents: Any, config: Any) -> Any:
            captured_calls.append({"model": model, "contents": contents, "config": config})
            payload = {
                "moments": [
                    {"label": "Iconic Drum Fill", "start": 0.0, "end": 4.0, "note": "Punchy intro drums"},
                    {"label": "Synth Hook", "start": 18.0, "end": 32.0, "note": "Bright brassy chords"},
                    {"label": "Vocal Chorus", "start": 43.0, "end": 62.0, "note": "Catchy vocal lift"},
                ]
            }
            return SimpleNamespace(text=json.dumps(payload))

    class _FakeClient:
        def __init__(self, api_key: str) -> None:
            self.api_key = api_key
            self.models = _FakeModels()

    monkeypatch.setattr(gemini_agent.genai, "Client", _FakeClient)

    # Pass API key via header (in-memory only)
    r_tag = client.post(
        f"/api/projects/{pid}/references/{ref_id}/auto-tag",
        headers={"X-Gemini-Api-Key": "fake-header-key"},
    )
    assert r_tag.status_code == 200
    moments = r_tag.json()["references"][0]["moments"]
    assert len(moments) == 3
    assert all(m["source"] == "gemini" for m in moments)

    # Verify Tier 1 native YouTube URI part was sent without downloading audio
    sent_contents = captured_calls[0]["contents"]
    uri_parts = [p for p in sent_contents if getattr(p, "file_data", None) is not None]
    assert len(uri_parts) == 1
    assert uri_parts[0].file_data.file_uri == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"


def test_mocked_gemini_chat_preview_and_apply_proposal(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pid = client.post("/api/projects", json={"name": "Producer Session"}).json()["id"]

    # Upload main track
    main_wav = wav_bytes_from_array(make_synthetic_track(duration=8.0, bpm=120.0))
    assert (
        client.post(
            f"/api/projects/{pid}/main-track",
            files={"file": ("track.wav", main_wav, "audio/wav")},
        ).status_code
        == 200
    )

    # Upload local reference so mashup/borrow_stem is allowed
    ref_wav = wav_bytes_from_array(make_synthetic_track(duration=4.0, bpm=120.0, root_hz=293.66))
    ref_id = client.post(
        f"/api/projects/{pid}/references/upload",
        files={"file": ("ref.wav", ref_wav, "audio/wav")},
        data={"title": "Energy Ref"},
    ).json()["references"][0]["id"]

    # Configure in-memory API key
    client.post("/api/settings/api-key", json={"api_key": "fake-session-key"})

    class _FakeModels:
        def generate_content(self, *, model: str, contents: Any, config: Any) -> Any:
            payload = {
                "reply": "Love this pocket! Here are two remix ideas around 2s–5s.",
                "proposals": [
                    {
                        "title": "Filter Rise + Reverb Throw",
                        "summary": "Sweeps the highs open and throws a lush reverb tail into the drop.",
                        "style": "imitate",
                        "start": 2.0,
                        "end": 5.0,
                        "operations": [
                            {
                                "type": "filter_sweep",
                                "mode": "highpass",
                                "start": 2.0,
                                "end": 4.0,
                                "start_hz": 120,
                                "end_hz": 1800,
                                "snap_to_beat": True,
                            },
                            {
                                "type": "reverb_throw",
                                "start": 3.5,
                                "end": 5.0,
                                "room_size": 0.8,
                                "wet_level": 0.5,
                                "snap_to_beat": False,
                            },
                            # Invalid op should be safely sanitized out
                            {"type": "nonexistent_fx", "start": 2.0, "end": 3.0},
                        ],
                    },
                    {
                        "title": "Reference Groove Mashup",
                        "summary": "Borrows the punchy groove from Energy Ref right into the middle.",
                        "style": "mashup",
                        "start": 2.0,
                        "end": 4.0,
                        "operations": [
                            {
                                "type": "borrow_stem",
                                "ref_id": ref_id,
                                "ref_stem": "full",
                                "ref_start": 0.0,
                                "ref_end": 2.0,
                                "target_start": 2.0,
                                "target_end": 4.0,
                                "replace_main_stems": ["drums"],
                                "match_bpm": True,
                                "match_key": True,
                                "snap_to_beat": False,
                            }
                        ],
                    },
                ],
            }
            return SimpleNamespace(text=json.dumps(payload))

    class _FakeClient:
        def __init__(self, api_key: str) -> None:
            self.models = _FakeModels()

    monkeypatch.setattr(gemini_agent.genai, "Client", _FakeClient)

    r_chat = client.post(
        f"/api/projects/{pid}/chat",
        json={
            "message": "Make 2s to 5s build tension like my reference!",
            "selection": {"start": 2.0, "end": 5.0},
            "reference_ids": [ref_id],
        },
    )
    assert r_chat.status_code == 200
    proj = r_chat.json()
    assert len(proj["chat_messages"]) == 2
    assert proj["chat_messages"][0]["role"] == "user"
    assistant = proj["chat_messages"][1]
    assert assistant["role"] == "assistant"
    assert len(assistant["proposals"]) == 2

    prop0 = assistant["proposals"][0]
    # Invalid op was filtered out cleanly, leaving 2 valid ops
    assert len(prop0["operations"]) == 2
    assert prop0["preview_url"] is not None
    assert prop0["applied"] is False

    # Stream pre-rendered preview WAV
    r_prev = client.get(prop0["preview_url"])
    assert r_prev.status_code == 200
    assert len(r_prev.content) > 1000

    # Apply proposal -> adds EditBlock, marks applied=True, renders rendered.wav
    r_apply = client.post(f"/api/projects/{pid}/edits/apply-proposal/{prop0['id']}")
    assert r_apply.status_code == 200
    applied_proj = r_apply.json()
    assert len(applied_proj["edits"]) == 1
    assert applied_proj["edits"][0]["title"] == prop0["title"]
    assert applied_proj["render_version"] == 1
    assert applied_proj["chat_messages"][1]["proposals"][0]["applied"] is True

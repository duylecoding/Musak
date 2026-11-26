"""Tests for Musak v0.3: YouTube oEmbed fast-path, auto-separate trigger, and lane-aware chat."""

from __future__ import annotations

import json
import urllib.request
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient

from musak import gemini_agent, youtube
from musak.models import ProjectState
from musak.routers import deps as deps_mod
from tests.conftest import make_synthetic_track, wav_bytes_from_array
from tests.test_v03_timeline_and_sfx import _create_project_with_main


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

    r1 = client.post(
        f"/api/projects/{pid}/main-track",
        files={"file": ("song1.wav", wav_bytes_from_array(audio), "audio/wav")},
    )
    assert r1.status_code == 200
    assert r1.json()["main_track"]["stems_status"] == "none"
    assert calls == []

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

    assert len(captured_contents) == 1
    system_text = captured_contents[0][0]
    ctx_text = captured_contents[0][1]
    assert "add_sfx:" in system_text
    assert '"lane"' in system_text
    assert '"lane":"vocals"' in ctx_text

    prop = body["chat_messages"][1]["proposals"][0]
    assert len(prop["operations"]) == 2
    assert prop["operations"][1]["type"] == "add_sfx"
    assert prop["operations"][1]["sfx_id"] == "riser_noise"
    assert prop["preview_url"] is not None
    assert client.get(prop["preview_url"]).status_code == 200

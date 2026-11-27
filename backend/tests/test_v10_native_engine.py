"""Tests for native Rust audio engine manifest and skip_render=1 fast persistence."""

from __future__ import annotations

import io
import math
from pathlib import Path

import numpy as np
import soundfile as sf
from fastapi.testclient import TestClient

from musak.main import app


def _make_wav_bytes(duration: float = 1.5, sr: int = 44100, freq: float = 220.0) -> bytes:
    n = int(duration * sr)
    t = np.arange(n, dtype=np.float32) / float(sr)
    wave = 0.25 * np.sin(2.0 * math.pi * freq * t)
    stereo = np.stack([wave, wave], axis=-1)
    buf = io.BytesIO()
    sf.write(buf, stereo, sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def test_engine_manifest_and_skip_render_export(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("MUSAK_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("MUSAK_AUTO_SEPARATE", "0")

    with TestClient(app) as client:
        proj = client.post("/api/projects", json={"name": "Rust Engine Test"}).json()
        pid = proj["id"]

        up = client.post(
            f"/api/projects/{pid}/main-track",
            files={"file": ("demo.wav", _make_wav_bytes(), "audio/wav")},
        )
        assert up.status_code == 200, up.text

        # Create SFX edit with skip_render=1 (instant JSON persist without offline WAV render)
        cr = client.post(
            f"/api/projects/{pid}/edits?skip_render=1",
            json={
                "title": "Sub Hit",
                "description": "Fast native layer",
                "start": 0.2,
                "end": 1.0,
                "operations": [{"type": "add_sfx", "sfx_id": "sub_impact", "start": 0.2, "end": 1.0, "gain_db": -2.0}],
            },
        )
        assert cr.status_code == 200, cr.text
        proj_after = cr.json()
        edit_id = proj_after["edits"][0]["id"]
        assert proj_after["render_version"] >= 1

        # Fetch native engine manifest -> returns main WAV + prepared SFX WAV on disk
        mf_res = client.get(f"/api/projects/{pid}/engine-manifest")
        assert mf_res.status_code == 200, mf_res.text
        mf = mf_res.json()
        assert Path(mf["main_wav"]).is_file()
        clip_key = f"{edit_id}:0"
        assert clip_key in mf["clips"]
        assert mf["clips"][clip_key]["stem_bucket"] == "bass"
        assert Path(mf["clips"][clip_key]["path"]).is_file()

        # Exporting remix when skip_render=1 was used still renders on demand cleanly!
        exp = client.post(
            f"/api/projects/{pid}/export",
            json={"format": "wav", "target": "remix", "master_preset": "off"},
        )
        assert exp.status_code == 200, exp.text
        assert len(exp.content) > 4000

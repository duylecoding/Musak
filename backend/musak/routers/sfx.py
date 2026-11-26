"""Built-in SFX library listing and preview audio routes."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from musak.config import get_data_dir
from musak.models import SfxListResponse
from musak.sfx import get_sfx_item, list_sfx_items, render_sfx_preview_wav

router = APIRouter(tags=["sfx"])


@router.get("/api/sfx", response_model=SfxListResponse)
def get_sfx_library() -> SfxListResponse:
    return SfxListResponse(items=list_sfx_items())


@router.get("/api/sfx/{sfx_id}/preview")
def stream_sfx_preview(
    sfx_id: str,
    bpm: Annotated[float, Query(ge=40.0, le=240.0)] = 120.0,
    duration: Annotated[float | None, Query(gt=0.0, le=30.0)] = None,
) -> FileResponse:
    if get_sfx_item(sfx_id) is None:
        raise HTTPException(status_code=404, detail=f"Unknown SFX '{sfx_id}'.")
    wav_path = render_sfx_preview_wav(sfx_id, cache_dir=get_data_dir() / ".sfx_cache", bpm=bpm, duration=duration)
    return FileResponse(path=str(wav_path), media_type="audio/wav", filename=f"{sfx_id}.wav")

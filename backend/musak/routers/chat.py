"""Gemini Producer Chat and voice-to-prompt transcription routes."""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, File, Header, HTTPException, UploadFile

from musak.config import get_api_key, get_gemini_model
from musak.dsp import render_proposal_preview
from musak.gemini_agent import run_producer_chat, transcribe_voice_audio
from musak.models import ChatMessage, ChatRequest, ProjectState, VoiceTranscribeResponse
from musak.routers.deps import _enrich_project, store
from musak.storage import generate_id, utc_now_iso, validate_id

logger = logging.getLogger(__name__)
router = APIRouter(tags=["chat"])

MAX_VOICE_UPLOAD_BYTES = 15 * 1024 * 1024

_AUDIO_MIME_ALIASES: dict[str, str] = {
    "audio/webm": "audio/webm",
    "audio/ogg": "audio/ogg",
    "audio/opus": "audio/ogg",
    "audio/wav": "audio/wav",
    "audio/x-wav": "audio/wav",
    "audio/wave": "audio/wav",
    "audio/mp4": "audio/mp4",
    "audio/m4a": "audio/mp4",
    "audio/x-m4a": "audio/mp4",
    "audio/mpeg": "audio/mpeg",
    "audio/mp3": "audio/mpeg",
    "audio/flac": "audio/flac",
    "audio/aac": "audio/aac",
}

_AUDIO_EXT_MIMES: dict[str, str] = {
    ".webm": "audio/webm",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".mp4": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
    ".aac": "audio/aac",
}


def _resolve_voice_mime(content_type: str | None, filename: str | None) -> str:
    """Strip codec parameters from Content-Type and fall back to filename extension."""
    if content_type:
        base = content_type.split(";", 1)[0].strip().lower()
        if base in _AUDIO_MIME_ALIASES:
            return _AUDIO_MIME_ALIASES[base]
        if base.startswith("audio/"):
            return base
    if filename:
        ext = Path(filename).suffix.lower()
        if ext in _AUDIO_EXT_MIMES:
            return _AUDIO_EXT_MIMES[ext]
    raise HTTPException(
        status_code=400,
        detail="Unsupported voice audio format. Provide audio/webm, audio/ogg, audio/wav, or audio/mp4.",
    )


@router.post("/api/projects/{project_id}/chat", response_model=ProjectState)
def producer_chat(
    project_id: str,
    body: ChatRequest,
    x_gemini_api_key: Annotated[str | None, Header()] = None,
) -> ProjectState:
    validate_id(project_id, "project_id")
    project = store.get_project(project_id)
    if project.main_track is None:
        raise HTTPException(status_code=400, detail="Upload a main track before starting Producer Chat.")

    api_key = get_api_key(x_gemini_api_key)
    if not api_key:
        raise HTTPException(status_code=400, detail="Gemini API key is not configured.")

    main_audio = store.get_main_audio_path(project_id, project.main_track.id)
    if not main_audio.is_file():
        raise HTTPException(status_code=404, detail="Main track audio file is missing.")

    ref_audio_paths = {
        ref.id: p
        for ref in project.references
        if (p := store.reference_audio_path(project_id, ref.id)).is_file()
    }

    try:
        reply_text, proposals = run_producer_chat(
            project=project,
            main_audio_path=main_audio,
            ref_audio_paths=ref_audio_paths,
            user_message=body.message.strip(),
            selection=body.selection,
            reference_ids=body.reference_ids,
            api_key=api_key,
            model=get_gemini_model(),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Gemini Producer chat failed for project %s", project_id)
        raise HTTPException(status_code=502, detail=f"Gemini Producer chat failed: {exc}") from exc

    expected_track_id = project.main_track.id
    with store.get_render_lock(project_id):
        latest_for_preview = store.get_project(project_id)
        if latest_for_preview.main_track is None or latest_for_preview.main_track.id != expected_track_id:
            proposals = []
        else:
            for prop in proposals:
                prop.base_operations = [op.model_copy(deep=True) for op in prop.operations]
                try:
                    render_proposal_preview(store, latest_for_preview, prop, nonce=generate_id("t"))
                except Exception as exc:
                    logger.warning("Preview rendering failed for proposal %s: %s", prop.id, exc)
                    prop.preview_url = None

    now = utc_now_iso()
    user_msg = ChatMessage(
        id=generate_id("msg"),
        role="user",
        content=body.message.strip(),
        selection=body.selection,
        reference_ids=list(body.reference_ids),
        proposals=[],
        created_at=now,
    )
    assistant_msg = ChatMessage(
        id=generate_id("msg"),
        role="assistant",
        content=reply_text,
        selection=body.selection,
        reference_ids=list(body.reference_ids),
        proposals=proposals,
        created_at=utc_now_iso(),
    )

    def _append_chat(proj: ProjectState) -> None:
        proj.chat_messages.append(user_msg)
        proj.chat_messages.append(assistant_msg)

    return _enrich_project(store.update_project(project_id, _append_chat))


@router.post("/api/voice/transcribe", response_model=VoiceTranscribeResponse)
async def transcribe_voice(
    file: UploadFile = File(...),
    x_gemini_api_key: Annotated[str | None, Header()] = None,
) -> VoiceTranscribeResponse:
    api_key = get_api_key(x_gemini_api_key)
    if not api_key:
        raise HTTPException(status_code=400, detail="Gemini API key is not configured.")

    clean_mime = _resolve_voice_mime(file.content_type, file.filename)

    chunks: list[bytes] = []
    total_bytes = 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        total_bytes += len(chunk)
        if total_bytes > MAX_VOICE_UPLOAD_BYTES:
            raise HTTPException(status_code=400, detail="Voice audio file exceeds maximum size of 15 MB.")
        chunks.append(chunk)

    audio_bytes = b"".join(chunks)
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Voice audio file is empty.")

    try:
        text = await asyncio.to_thread(
            transcribe_voice_audio, audio_bytes, clean_mime, api_key, get_gemini_model()
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Gemini voice transcription failed")
        raise HTTPException(status_code=502, detail=f"Gemini voice transcription failed: {exc}") from exc

    return VoiceTranscribeResponse(text=text)

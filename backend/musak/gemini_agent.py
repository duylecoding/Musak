"""Gemini Producer Agent powered by `google-genai` (Tier 1 native YouTube + compact WAV audio)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import soundfile as sf
from google import genai
from google.genai import types

from musak.gemini_audio import _generate_content, create_compact_wav_clip
from musak.gemini_parsers import (
    build_chat_context,
    build_producer_system_prompt,
    parse_lyric_hooks,
    parse_moment_pins,
    parse_producer_proposals,
)
from musak.gemini_sanitize import (  # noqa: F401
    VALID_HOOK_KINDS,
    VALID_OP_TYPES,
    VALID_REF_STEMS,
    VALID_STYLES,
    _parse_json_payload,
    _sanitize_operation,
)
from musak.models import EditProposal, LyricHook, MomentPin, ProjectState, ReferenceTrack, TimeSelection


def auto_tag_reference(
    ref: ReferenceTrack,
    ref_audio_path: Path | None,
    api_key: str,
    model: str,
) -> list[MomentPin]:
    """Ask Gemini to identify 3-5 standout musical moments in a reference track."""
    if not api_key:
        raise ValueError("Gemini API key is required for auto-tagging.")

    contents: list[Any] = []
    window_note = ""
    max_dur = ref.duration if (ref.duration is not None and ref.duration > 0) else 3600.0

    if ref.source_type == "youtube" and ref.youtube_url:
        contents.append(types.Part.from_uri(file_uri=ref.youtube_url, mime_type="video/*"))
        if ref.duration:
            window_note = f"Track duration is approximately {ref.duration:.1f} seconds."
    elif ref_audio_path is not None and ref_audio_path.is_file():
        info = sf.info(str(ref_audio_path))
        file_dur = info.frames / float(info.samplerate) if info.samplerate > 0 else (ref.duration or 90.0)
        analyzed_end = round(min(file_dur, 90.0), 2)
        max_dur = analyzed_end
        wav_bytes = create_compact_wav_clip(ref_audio_path, start=0.0, end=analyzed_end, max_seconds=90.0, target_sr=12000)
        contents.append(types.Part.from_bytes(data=wav_bytes, mime_type="audio/wav"))
        window_note = (
            f"The attached audio clip covers exactly [0.0s, {analyzed_end:.1f}s] of this track. "
            f"Only return moments within [0.0, {analyzed_end:.1f}]."
        )
    else:
        raise ValueError("Reference has neither a YouTube URL nor local audio available for auto-tagging.")

    contents.append(
        f"Identify 3-5 standout remix moments in '{ref.title}'. {window_note}\n"
        f"Return STRICT JSON ONLY: "
        f'{{"moments":[{{"label":"Short name","start":12.0,"end":20.0,"note":"Plain-English vibe"}}]}} '
        f"(seconds, start < end)."
    )
    response = _generate_content(
        client=genai.Client(api_key=api_key),
        model=model,
        contents=contents,
        response_mime_type="application/json",
        temperature=0.3,
        max_output_tokens=500,
    )
    return parse_moment_pins(response.text or "{}", max_dur)


def run_producer_chat(
    project: ProjectState,
    main_audio_path: Path,
    ref_audio_paths: dict[str, Path],
    user_message: str,
    selection: TimeSelection | None,
    reference_ids: list[str],
    api_key: str,
    model: str,
) -> tuple[str, list[EditProposal]]:
    """Run fast, token-efficient Gemini Producer chat returning `(reply_text, validated_proposals)`."""
    if not api_key:
        raise ValueError("Gemini API key is required for producer chat.")
    if project.main_track is None:
        raise ValueError("Upload a main track before chatting with the producer.")

    main = project.main_track
    duration = main.duration
    if selection is not None:
        sel_start = max(0.0, min(selection.start, duration))
        sel_end = max(sel_start, min(selection.end, duration))
        if sel_end <= sel_start:
            sel_end = min(duration, sel_start + 8.0)
    elif main.sections:
        best_sec = max(main.sections, key=lambda s: (s.label in ("Drop", "Chorus"), s.energy))
        sel_start = max(0.0, min(best_sec.start, duration))
        sel_end = min(duration, best_sec.end, sel_start + 16.0)
        if sel_end <= sel_start:
            sel_end = min(duration, sel_start + 12.0)
    else:
        sel_start, sel_end = 0.0, min(duration, 16.0)

    clip_start = max(0.0, sel_start - 1.5)
    clip_end = min(duration, sel_end + 1.5)
    main_clip_bytes = create_compact_wav_clip(main_audio_path, start=clip_start, end=clip_end, max_seconds=16.0, target_sr=12000)

    selected_refs = [r for r in project.references if r.id in set(reference_ids)] if reference_ids else []
    valid_ref_ids = {r.id for r in project.references}
    downloaded_ref_ids = {r.id for r in project.references if r.audio_downloaded and r.id in ref_audio_paths}
    context_doc = build_chat_context(project, sel_start, sel_end, clip_start, clip_end, selected_refs, selection)
    mashup_rule = (
        "borrow_stem allowed ONLY for refs with dl=true."
        if any(r.id in downloaded_ref_ids for r in selected_refs)
        else "NO borrow_stem (no downloaded ref audio)."
    )

    contents: list[Any] = [
        build_producer_system_prompt(mashup_rule, duration),
        f"CTX:{json.dumps(context_doc, separators=(',', ':'))}",
        types.Part.from_bytes(data=main_clip_bytes, mime_type="audio/wav"),
    ]
    ref_attached = False
    for ref in selected_refs:
        local_path = ref_audio_paths.get(ref.id)
        if local_path is not None and local_path.is_file():
            ref_s = ref.moments[0].start if ref.moments else 0.0
            ref_e = ref.moments[0].end if ref.moments else 12.0
            ref_bytes = create_compact_wav_clip(local_path, start=ref_s, end=ref_e, max_seconds=12.0, target_sr=12000)
            contents.append(types.Part.from_bytes(data=ref_bytes, mime_type="audio/wav"))
            ref_attached = True
            break
    if not ref_attached:
        for ref in selected_refs:
            if ref.source_type == "youtube" and ref.youtube_url:
                contents.append(types.Part.from_uri(file_uri=ref.youtube_url, mime_type="video/*"))
                break
    if project.chat_messages[-3:]:
        contents.append("History:\n" + "\n".join(f"{m.role[0].upper()}: {m.content[:180]}" for m in project.chat_messages[-3:]))
    contents.append(f"User: {user_message}")

    response = _generate_content(
        client=genai.Client(api_key=api_key),
        model=model,
        contents=contents,
        response_mime_type="application/json",
        temperature=0.45,
        max_output_tokens=600,
    )
    return parse_producer_proposals(response.text or "{}", duration, valid_ref_ids, downloaded_ref_ids, sel_start, sel_end)


def transcribe_voice_audio(audio_bytes: bytes, mime_type: str, api_key: str, model: str) -> str:
    """Transcribe a spoken voice remix instruction into clean plain text via Gemini."""
    if not api_key:
        raise ValueError("Gemini API key is required for voice transcription.")
    if not audio_bytes:
        raise ValueError("Voice audio payload is empty.")
    prompt = (
        "Transcribe the spoken music-editing request accurately. "
        "Format spoken timestamps as m:ss (e.g. 0:45, 1:12), preserve song/artist/track names, "
        "and return ONLY the transcribed text (no quotes or commentary; empty string if silent)."
    )
    response = _generate_content(
        client=genai.Client(api_key=api_key),
        model=model,
        contents=[types.Part.from_bytes(data=audio_bytes, mime_type=mime_type), prompt],
        response_mime_type=None,
        temperature=0.0,
        max_output_tokens=200,
    )
    text = (response.text or "").strip()
    if len(text) >= 2 and ((text[0] == '"' and text[-1] == '"') or (text[0] == "'" and text[-1] == "'")):
        text = text[1:-1].strip()
    return text


def extract_lyric_hooks(audio_path: Path, duration: float, api_key: str, model: str) -> list[LyricHook]:
    """Use Gemini to extract 5-10 timestamped clickable vocal lyrics, hooks, and big drops."""
    if not api_key:
        raise ValueError("Gemini API key is required for lyric/hook extraction.")
    if not audio_path.is_file():
        raise FileNotFoundError(f"Audio file not found: {audio_path}")

    info = sf.info(str(audio_path))
    file_dur = info.frames / float(info.samplerate) if info.samplerate > 0 else duration
    base_dur = min(duration, file_dur) if (duration > 0 and file_dur > 0) else max(duration, file_dur, 0.5)
    analyzed_end = round(min(max(base_dur, 0.5), 120.0), 2)
    wav_bytes = create_compact_wav_clip(audio_path, start=0.0, end=analyzed_end, max_seconds=120.0, target_sr=12000)

    prompt = (
        f"Audio clip covers [0.0s, {analyzed_end:.1f}s]. "
        "Identify 5-10 standout vocal lyric snippets (3-10 words), catchy hooks, or big instrumental drops.\n"
        'Return STRICT JSON ONLY: {"hooks":[{"text":"...","start":12.5,"end":18.0,"kind":"hook"|"lyric"|"drop"}]}\n'
        f"Timestamps MUST satisfy 0 <= start < end <= {analyzed_end:.1f}."
    )
    response = _generate_content(
        client=genai.Client(api_key=api_key),
        model=model,
        contents=[types.Part.from_bytes(data=wav_bytes, mime_type="audio/wav"), prompt],
        response_mime_type="application/json",
        temperature=0.2,
        max_output_tokens=600,
    )
    return parse_lyric_hooks(response.text or "{}", analyzed_end)

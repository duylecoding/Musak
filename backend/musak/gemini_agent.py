"""Gemini Producer Agent powered by `google-genai` (Tier 1 native YouTube + compact WAV audio)."""

from __future__ import annotations

import io
import json
import logging
import math
import re
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf
from google import genai
from google.genai import types
from scipy.signal import resample_poly

from musak.config import STEM_NAMES
from musak.models import (
    EditOperation,
    EditProposal,
    MomentPin,
    ProjectState,
    ReferenceTrack,
    TimeSelection,
)
from musak.storage import generate_id

logger = logging.getLogger(__name__)

VALID_OP_TYPES = {
    "stem_gain",
    "filter_sweep",
    "reverb_throw",
    "delay_throw",
    "lofi_eq",
    "bass_boost",
    "borrow_stem",
}
VALID_STYLES = {"imitate", "mashup", "creative"}
VALID_REF_STEMS = {"vocals", "drums", "bass", "other", "full"}


def create_compact_wav_clip(
    audio_path: Path,
    start: float | None = None,
    end: float | None = None,
    max_seconds: float = 30.0,
    target_sr: int = 16000,
) -> bytes:
    """Slice, downmix to mono, downsample, and encode as compact WAV bytes."""
    info = sf.info(str(audio_path))
    orig_sr = int(info.samplerate)
    total_frames = int(info.frames)
    if total_frames <= 0 or orig_sr <= 0:
        raise ValueError(f"Audio file '{audio_path.name}' contains no frames.")

    total_dur = total_frames / float(orig_sr)

    s_sec = max(0.0, min(float(start if start is not None else 0.0), total_dur))
    if end is None:
        e_sec = min(total_dur, s_sec + max_seconds)
    else:
        e_sec = max(s_sec, min(float(end), total_dur))

    if e_sec - s_sec > max_seconds:
        mid = 0.5 * (s_sec + e_sec)
        s_sec = max(0.0, mid - max_seconds * 0.5)
        e_sec = min(total_dur, s_sec + max_seconds)

    if e_sec <= s_sec and total_dur > 0:
        s_sec = max(0.0, total_dur - min(total_dur, max_seconds))
        e_sec = total_dur

    # Clamp start_frame strictly below total_frames so EOF timestamps never yield a 0-frame WAV
    start_frame = min(max(0, total_frames - 1), max(0, int(round(s_sec * orig_sr))))
    stop_frame = min(total_frames, max(start_frame + 1, int(round(e_sec * orig_sr))))

    data, sr = sf.read(
        str(audio_path),
        start=start_frame,
        stop=stop_frame,
        dtype="float32",
        always_2d=True,
    )
    mono = np.mean(data, axis=1).astype(np.float32)

    if int(sr) != target_sr and len(mono) > 0:
        gcd = math.gcd(int(sr), target_sr)
        mono = resample_poly(mono, up=target_sr // gcd, down=int(sr) // gcd).astype(np.float32)

    mono = np.clip(np.nan_to_num(mono, nan=0.0), -1.0, 1.0)
    buf = io.BytesIO()
    sf.write(buf, mono, target_sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def _parse_json_payload(raw_text: str) -> Any:
    """Parse JSON from Gemini output, stripping accidental markdown code fences."""
    text = (raw_text or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
        text = re.sub(r"\s*```$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        obj_match = re.search(r"(\{[\s\S]*\}|\[[\s\S]*\])", text)
        if obj_match:
            return json.loads(obj_match.group(1))
        raise


def _sanitize_operation(
    raw_op: dict[str, Any],
    duration: float,
    valid_ref_ids: set[str],
    downloaded_ref_ids: set[str],
    default_start: float,
    default_end: float,
) -> EditOperation | None:
    """Validate and clamp a Gemini-generated operation into a safe `EditOperation`."""
    if not isinstance(raw_op, dict):
        return None
    op_type = raw_op.get("type")
    if op_type not in VALID_OP_TYPES:
        return None

    def _clamp_time(val: Any, fallback: float) -> float:
        try:
            f = float(val)
            if math.isnan(f) or math.isinf(f):
                return fallback
            return round(max(0.0, min(f, duration)), 3)
        except (TypeError, ValueError):
            return fallback

    def _opt_float(val: Any, lo: float, hi: float) -> float | None:
        if val is None:
            return None
        try:
            f = float(val)
            if math.isnan(f) or math.isinf(f):
                return None
            return round(max(lo, min(f, hi)), 3)
        except (TypeError, ValueError):
            return None

    def _float_or(val: Any, lo: float, hi: float, default: float) -> float:
        parsed = _opt_float(val, lo, hi)
        return parsed if parsed is not None else default

    clean: dict[str, Any] = {"type": op_type}
    if "snap_to_beat" in raw_op and raw_op["snap_to_beat"] is not None:
        clean["snap_to_beat"] = bool(raw_op["snap_to_beat"])
    else:
        clean["snap_to_beat"] = True

    if op_type == "borrow_stem":
        ref_id = raw_op.get("ref_id")
        if not isinstance(ref_id, str) or ref_id not in valid_ref_ids:
            return None
        if ref_id not in downloaded_ref_ids:
            return None
        ref_stem = raw_op.get("ref_stem", "full")
        if ref_stem not in VALID_REF_STEMS:
            ref_stem = "full"

        t_start = _clamp_time(raw_op.get("target_start", raw_op.get("start")), default_start)
        t_end = _clamp_time(raw_op.get("target_end", raw_op.get("end")), default_end)
        if t_end <= t_start:
            t_end = round(min(duration, t_start + 4.0), 3)

        r_start = _float_or(raw_op.get("ref_start"), 0.0, 3600.0, 0.0)
        r_end = _opt_float(raw_op.get("ref_end"), 0.0, 3600.0)
        if r_end is None or r_end <= r_start:
            r_end = round(r_start + max(1.0, t_end - t_start), 3)

        replace_raw = raw_op.get("replace_main_stems")
        replace_stems = (
            [s for s in replace_raw if isinstance(s, str) and s in (*STEM_NAMES, "full")]
            if isinstance(replace_raw, list)
            else []
        )

        clean.update(
            {
                "ref_id": ref_id,
                "ref_stem": ref_stem,
                "ref_start": r_start,
                "ref_end": r_end,
                "target_start": t_start,
                "target_end": t_end,
                "replace_main_stems": replace_stems,
                "match_bpm": True if raw_op.get("match_bpm") is None else bool(raw_op.get("match_bpm")),
                "match_key": True if raw_op.get("match_key") is None else bool(raw_op.get("match_key")),
            }
        )
        gain_db = _opt_float(raw_op.get("gain_db"), -24.0, 12.0)
        if gain_db is not None:
            clean["gain_db"] = gain_db
        return EditOperation.model_validate(clean)

    # Standard DSP operations
    s = _clamp_time(raw_op.get("start"), default_start)
    e = _clamp_time(raw_op.get("end"), default_end)
    if e <= s:
        e = round(min(duration, s + 2.0), 3)
    if e <= s:
        return None
    clean["start"] = s
    clean["end"] = e

    raw_stems = raw_op.get("stems")
    if isinstance(raw_stems, list):
        filtered = [st for st in raw_stems if isinstance(st, str) and st in (*STEM_NAMES, "full")]
        if filtered:
            clean["stems"] = filtered

    if op_type == "stem_gain":
        clean["gain_db"] = _float_or(raw_op.get("gain_db"), -80.0, 12.0, -60.0)
        clean["fade_ms"] = _float_or(raw_op.get("fade_ms"), 5.0, 2000.0, 30.0)
    elif op_type == "filter_sweep":
        mode = raw_op.get("mode")
        clean["mode"] = mode if mode in ("highpass", "lowpass") else "lowpass"
        clean["start_hz"] = _opt_float(raw_op.get("start_hz"), 30.0, 18000.0)
        clean["end_hz"] = _opt_float(raw_op.get("end_hz"), 30.0, 18000.0)
    elif op_type == "reverb_throw":
        clean["room_size"] = _float_or(raw_op.get("room_size"), 0.05, 1.0, 0.75)
        clean["wet_level"] = _float_or(raw_op.get("wet_level"), 0.05, 1.0, 0.45)
    elif op_type == "delay_throw":
        clean["delay_beats"] = _float_or(raw_op.get("delay_beats"), 0.125, 2.0, 0.5)
        clean["feedback"] = _float_or(raw_op.get("feedback"), 0.05, 0.85, 0.45)
        clean["mix"] = _float_or(raw_op.get("mix"), 0.05, 1.0, 0.4)
    elif op_type == "lofi_eq":
        clean["low_cut_hz"] = _float_or(raw_op.get("low_cut_hz"), 80.0, 2000.0, 300.0)
        clean["high_cut_hz"] = _float_or(raw_op.get("high_cut_hz"), 1000.0, 12000.0, 3200.0)
        clean["drive_db"] = _float_or(raw_op.get("drive_db"), 0.0, 24.0, 8.0)
    elif op_type == "bass_boost":
        clean["gain_db"] = _float_or(raw_op.get("gain_db"), -6.0, 15.0, 6.0)
        clean["cutoff_hz"] = _float_or(raw_op.get("cutoff_hz"), 50.0, 300.0, 120.0)

    return EditOperation.model_validate(clean)


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
        # Tier 1: native YouTube URL understanding without local download
        contents.append(types.Part.from_uri(file_uri=ref.youtube_url, mime_type="video/*"))
        if ref.duration:
            window_note = f"Track duration is approximately {ref.duration:.1f} seconds."
    elif ref_audio_path is not None and ref_audio_path.is_file():
        info = sf.info(str(ref_audio_path))
        file_dur = info.frames / float(info.samplerate) if info.samplerate > 0 else (ref.duration or 90.0)
        analyzed_end = round(min(file_dur, 90.0), 2)
        max_dur = analyzed_end
        wav_bytes = create_compact_wav_clip(
            ref_audio_path,
            start=0.0,
            end=analyzed_end,
            max_seconds=90.0,
            target_sr=12000,
        )
        contents.append(types.Part.from_bytes(data=wav_bytes, mime_type="audio/wav"))
        window_note = (
            f"The attached audio clip covers exactly [0.0s, {analyzed_end:.1f}s] of this track. "
            f"Only return moments within [0.0, {analyzed_end:.1f}]."
        )
    else:
        raise ValueError("Reference has neither a YouTube URL nor local audio available for auto-tagging.")

    prompt = (
        f"You are an expert music producer helping a non-musician remix songs.\n"
        f"Listen to this reference track titled '{ref.title}'. {window_note}\n"
        f"Identify 3 to 5 standout production moments (e.g., drum dropout, filter sweep buildup, "
        f"vocal chop hook, heavy bass drop, lo-fi breakdown, reverb throw transition).\n"
        f"Return STRICT JSON ONLY matching this schema:\n"
        f'{{"moments": [{{"label": "Short catchy name", "start": 12.0, "end": 20.0, '
        f'"note": "Plain-English explanation of what makes this moment sound cool"}}]}}\n'
        f"All timestamps must be numbers in seconds with start < end."
    )
    contents.append(prompt)

    client = genai.Client(api_key=api_key)
    response = client.models.generate_content(
        model=model,
        contents=contents,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            temperature=0.4,
        ),
    )

    payload = _parse_json_payload(response.text or "{}")
    raw_moments = payload.get("moments", []) if isinstance(payload, dict) else (payload if isinstance(payload, list) else [])

    pins: list[MomentPin] = []
    for item in raw_moments[:5]:
        if not isinstance(item, dict):
            continue
        label = str(item.get("label") or "Standout Moment").strip()[:80]
        note = str(item.get("note") or "").strip()[:300]
        try:
            start = max(0.0, min(float(item.get("start", 0.0)), max_dur))
            end = max(start + 0.5, min(float(item.get("end", start + 4.0)), max_dur))
        except (TypeError, ValueError):
            continue
        if end <= start:
            continue
        pins.append(
            MomentPin(
                id=generate_id("mom"),
                label=label or "Moment",
                start=round(start, 2),
                end=round(end, 2),
                note=note,
                source="gemini",
            )
        )

    return pins


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
    """Run Gemini Producer chat and return `(reply_text, validated_proposals)`."""
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
    else:
        sel_start = 0.0
        sel_end = min(duration, 24.0)

    clip_start = max(0.0, sel_start - 2.0)
    clip_end = min(duration, sel_end + 2.0)
    main_clip_bytes = create_compact_wav_clip(
        main_audio_path,
        start=clip_start,
        end=clip_end,
        max_seconds=30.0,
        target_sr=16000,
    )

    selected_refs = [r for r in project.references if r.id in set(reference_ids)] if reference_ids else []
    valid_ref_ids = {r.id for r in project.references}
    downloaded_ref_ids = {r.id for r in project.references if r.audio_downloaded and r.id in ref_audio_paths}

    context_doc = {
        "main_track": {
            "name": main.name,
            "duration": main.duration,
            "bpm": main.bpm,
            "key": main.key,
            "stems_status": main.stems_status,
            "stems_ready": main.stems_status == "ready",
            "sections": [s.model_dump() for s in main.sections],
        },
        "user_selection": {"start": round(sel_start, 2), "end": round(sel_end, 2)},
        "audio_clip_window": {"start": round(clip_start, 2), "end": round(clip_end, 2)},
        "existing_edits": [
            {"title": e.title, "start": e.start, "end": e.end, "enabled": e.enabled}
            for e in project.edits
        ],
        "attached_references": [
            {
                "id": r.id,
                "title": r.title,
                "source_type": r.source_type,
                "duration": r.duration,
                "bpm": r.bpm,
                "key": r.key,
                "audio_downloaded": r.audio_downloaded,
                "stems_status": r.stems_status,
                "moments": [m.model_dump() for m in r.moments],
            }
            for r in selected_refs
        ],
    }

    mashup_rule = (
        "You MAY include a 'mashup' proposal using 'borrow_stem' ONLY for references where audio_downloaded is true."
        if any(r.id in downloaded_ref_ids for r in selected_refs)
        else "Do NOT use 'borrow_stem' because no attached reference has downloaded audio yet."
    )

    system_prompt = (
        "You are Musak's friendly, approachable AI music producer helping a non-musician remix their song.\n"
        "Speak warmly in plain English without intimidating jargon.\n"
        "Listen carefully to the user's song clip (and any attached reference track) and propose 1 to 3 distinct, "
        "concrete, immediately auditionable remix options.\n\n"
        "Allowed EditOperation types and exact fields:\n"
        '1. {"type": "stem_gain", "stems": ["drums"|"bass"|"vocals"|"other"], "start": sec, "end": sec, "gain_db": -60..12, "fade_ms": 30, "snap_to_beat": true}\n'
        '2. {"type": "filter_sweep", "stems": [...], "start": sec, "end": sec, "mode": "highpass"|"lowpass", "start_hz": 200, "end_hz": 2400, "snap_to_beat": true}\n'
        '3. {"type": "reverb_throw", "stems": [...], "start": sec, "end": sec, "room_size": 0.1..1.0, "wet_level": 0.1..1.0, "snap_to_beat": true}\n'
        '4. {"type": "delay_throw", "stems": [...], "start": sec, "end": sec, "delay_beats": 0.25|0.5|0.75|1.0, "feedback": 0.1..0.8, "mix": 0.2..0.8, "snap_to_beat": true}\n'
        '5. {"type": "lofi_eq", "stems": [...], "start": sec, "end": sec, "low_cut_hz": 300, "high_cut_hz": 3200, "drive_db": 8, "snap_to_beat": true}\n'
        '6. {"type": "bass_boost", "stems": ["bass"|"drums"], "start": sec, "end": sec, "gain_db": 6, "cutoff_hz": 120, "snap_to_beat": true}\n'
        '7. {"type": "borrow_stem", "ref_id": "<ref_id>", "ref_stem": "vocals"|"drums"|"bass"|"other"|"full", '
        '"ref_start": sec, "ref_end": sec, "target_start": sec, "target_end": sec, '
        '"replace_main_stems": ["drums"], "match_bpm": true, "match_key": true, "snap_to_beat": true}\n\n'
        f"{mashup_rule}\n"
        f"All main-track timestamps MUST be within [0, {duration:.2f}]. Focus proposals around the user's selection.\n"
        "Return STRICT JSON ONLY:\n"
        '{\n'
        '  "reply": "Short friendly producer message explaining your ideas",\n'
        '  "proposals": [\n'
        '    {\n'
        '      "title": "Short catchy title",\n'
        '      "summary": "1-sentence plain-English description of how it sounds",\n'
        '      "style": "imitate" | "mashup" | "creative",\n'
        '      "start": 12.0,\n'
        '      "end": 20.0,\n'
        '      "operations": [ ... ]\n'
        '    }\n'
        '  ]\n'
        '}\n'
    )

    contents: list[Any] = [
        system_prompt,
        f"Project Context JSON:\n{json.dumps(context_doc, indent=2)}",
        types.Part.from_bytes(data=main_clip_bytes, mime_type="audio/wav"),
    ]

    # Attach up to 1 YouTube reference via Part.from_uri AND up to 1 local/downloaded clip
    youtube_attached = False
    local_attached = False
    for ref in selected_refs:
        if ref.source_type == "youtube" and ref.youtube_url and not youtube_attached:
            contents.append(types.Part.from_uri(file_uri=ref.youtube_url, mime_type="video/*"))
            youtube_attached = True
        elif not local_attached and ref.id in ref_audio_paths and ref_audio_paths[ref.id].is_file():
            ref_s = ref.moments[0].start if ref.moments else 0.0
            ref_e = ref.moments[0].end if ref.moments else 20.0
            ref_bytes = create_compact_wav_clip(
                ref_audio_paths[ref.id],
                start=ref_s,
                end=ref_e,
                max_seconds=20.0,
                target_sr=16000,
            )
            contents.append(types.Part.from_bytes(data=ref_bytes, mime_type="audio/wav"))
            local_attached = True
        if youtube_attached and local_attached:
            break

    recent_history = project.chat_messages[-6:]
    if recent_history:
        history_lines = [f"{m.role.upper()}: {m.content}" for m in recent_history]
        contents.append("Recent conversation:\n" + "\n".join(history_lines))

    contents.append(f"User request: {user_message}")

    client = genai.Client(api_key=api_key)
    response = client.models.generate_content(
        model=model,
        contents=contents,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            temperature=0.6,
        ),
    )

    payload = _parse_json_payload(response.text or "{}")
    if not isinstance(payload, dict):
        payload = {"reply": str(response.text or "Here are a few remix ideas!"), "proposals": []}

    reply = str(payload.get("reply") or "Here are some remix ideas tailored to your track!").strip()
    raw_proposals = payload.get("proposals")
    if not isinstance(raw_proposals, list):
        raw_proposals = []

    proposals: list[EditProposal] = []
    for raw_prop in raw_proposals[:3]:
        if not isinstance(raw_prop, dict):
            continue
        style = raw_prop.get("style", "creative")
        if style not in VALID_STYLES:
            style = "creative"

        try:
            p_start = max(0.0, min(float(raw_prop.get("start", sel_start)), duration))
            p_end = max(p_start, min(float(raw_prop.get("end", sel_end)), duration))
        except (TypeError, ValueError):
            p_start, p_end = sel_start, sel_end

        if p_end <= p_start:
            p_end = min(duration, p_start + 4.0)

        sanitized_ops: list[EditOperation] = []
        raw_ops = raw_prop.get("operations", [])
        if isinstance(raw_ops, list):
            for raw_op in raw_ops:
                op = _sanitize_operation(
                    raw_op=raw_op,
                    duration=duration,
                    valid_ref_ids=valid_ref_ids,
                    downloaded_ref_ids=downloaded_ref_ids,
                    default_start=p_start,
                    default_end=p_end,
                )
                if op is not None:
                    sanitized_ops.append(op)

        if not sanitized_ops:
            continue

        op_starts = [op.target_start if op.type == "borrow_stem" else op.start for op in sanitized_ops]
        op_ends = [op.target_end if op.type == "borrow_stem" else op.end for op in sanitized_ops]
        valid_starts = [x for x in op_starts if x is not None]
        valid_ends = [x for x in op_ends if x is not None]
        if valid_starts and valid_ends:
            p_start = round(min(valid_starts), 3)
            p_end = round(max(valid_ends), 3)

        proposals.append(
            EditProposal(
                id=generate_id("prop"),
                title=str(raw_prop.get("title") or "Producer Idea").strip()[:120],
                summary=str(raw_prop.get("summary") or "Custom remix edit.").strip()[:300],
                style=style,
                start=round(p_start, 3),
                end=round(p_end, 3),
                operations=sanitized_ops,
                preview_url=None,
                preview_start=0.0,
                preview_end=0.0,
                applied=False,
            )
        )

    return reply, proposals


def transcribe_voice_audio(
    audio_bytes: bytes,
    mime_type: str,
    api_key: str,
    model: str,
) -> str:
    """Transcribe a spoken voice remix instruction into clean plain text via Gemini."""
    if not api_key:
        raise ValueError("Gemini API key is required for voice transcription.")
    if not audio_bytes:
        raise ValueError("Voice audio payload is empty.")

    prompt = (
        "Transcribe the user's spoken music-editing or remixing request accurately.\n"
        "- Format spoken timestamps cleanly using m:ss (e.g., 0:45, 1:12).\n"
        "- Preserve song titles, artist names, track references, and musical terms accurately.\n"
        "- Return ONLY the transcribed text with no surrounding quotes, markdown, or extra commentary.\n"
        "- If the audio is silent or completely unintelligible, return an empty string."
    )

    client = genai.Client(api_key=api_key)
    response = client.models.generate_content(
        model=model,
        contents=[
            types.Part.from_bytes(data=audio_bytes, mime_type=mime_type),
            prompt,
        ],
        config=types.GenerateContentConfig(temperature=0.1),
    )

    text = (response.text or "").strip()
    if len(text) >= 2 and ((text[0] == '"' and text[-1] == '"') or (text[0] == "'" and text[-1] == "'")):
        text = text[1:-1].strip()
    return text

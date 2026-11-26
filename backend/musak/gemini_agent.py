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
    LyricHook,
    MomentPin,
    ProjectState,
    ReferenceTrack,
    TimeSelection,
)
from musak.sfx import KNOWN_SFX_IDS, get_sfx_item
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
    "tempo_pitch",
    "add_sfx",
    "cut_section",
    "repeat_section",
    "beat_repeat",
    "vinyl_brake",
}
VALID_STYLES = {"imitate", "mashup", "creative"}
VALID_REF_STEMS = {"vocals", "drums", "bass", "other", "full"}
VALID_HOOK_KINDS = {"hook", "lyric", "drop"}


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
        if raw_op.get("loop_to_fit") is not None:
            clean["loop_to_fit"] = bool(raw_op["loop_to_fit"])
        for fade_field in ("fade_in_ms", "fade_out_ms"):
            if (fv := _opt_float(raw_op.get(fade_field), 0.0, 4000.0)) is not None:
                clean[fade_field] = fv
        return EditOperation.model_validate(clean)

    # Standard DSP operations & add_sfx
    if op_type == "add_sfx":
        sfx_id = raw_op.get("sfx_id")
        if not isinstance(sfx_id, str) or sfx_id not in KNOWN_SFX_IDS:
            return None
        sfx_item = get_sfx_item(sfx_id)
        s = _clamp_time(raw_op.get("start"), default_start)
        sfx_default_end = round(min(duration, s + sfx_item.default_duration), 3) if sfx_item is not None else default_end
        e = _clamp_time(raw_op.get("end"), sfx_default_end if raw_op.get("end") is None else default_end)
        if e <= s:
            e = round(min(duration, s + (sfx_item.default_duration if sfx_item is not None else 2.0)), 3)
        if e <= s:
            return None
        clean["start"] = s
        clean["end"] = e
        clean["sfx_id"] = sfx_id
        clean["gain_db"] = _float_or(raw_op.get("gain_db"), -24.0, 12.0, 0.0)
        for fade_field in ("fade_in_ms", "fade_out_ms"):
            if (fv := _opt_float(raw_op.get(fade_field), 0.0, 4000.0)) is not None:
                clean[fade_field] = fv
        layer_id = raw_op.get("layer_id")
        if isinstance(layer_id, str) and layer_id.strip():
            clean["layer_id"] = layer_id.strip()[:64]
        return EditOperation.model_validate(clean)

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
        for fade_field in ("fade_in_ms", "fade_out_ms"):
            if (fv := _opt_float(raw_op.get(fade_field), 0.0, 4000.0)) is not None:
                clean[fade_field] = fv
        if raw_op.get("fade_curve") in ("in", "out", "both"):
            clean["fade_curve"] = raw_op["fade_curve"]
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
    elif op_type == "tempo_pitch":
        clean["speed_rate"] = _float_or(raw_op.get("speed_rate"), 0.5, 1.6, 1.0)
        clean["semitones"] = _float_or(raw_op.get("semitones"), -12.0, 12.0, 0.0)
        clean["add_reverb"] = bool(raw_op.get("add_reverb", False))
        clean["reverb_wet"] = _float_or(raw_op.get("reverb_wet"), 0.0, 0.8, 0.35)
    elif op_type == "beat_repeat":
        clean["division_beats"] = _float_or(raw_op.get("division_beats"), 0.0625, 2.0, 0.25)
    elif op_type == "repeat_section":
        try:
            rc = int(round(float(raw_op.get("repeat_count", 2))))
        except (TypeError, ValueError):
            rc = 2
        clean["repeat_count"] = max(2, min(4, rc))

    return EditOperation.model_validate(clean)


def _generate_content(
    client: Any,
    model: str,
    contents: Any,
    response_mime_type: str | None = None,
    temperature: float = 0.4,
    max_output_tokens: int = 600,
) -> Any:
    """Invoke `client.models.generate_content` with MINIMAL thinking and tight output caps.

    Gracefully retries once without `thinking_config` if a custom model rejects it.
    """
    cfg_kwargs: dict[str, Any] = {
        "temperature": temperature,
        "max_output_tokens": max_output_tokens,
    }
    if response_mime_type:
        cfg_kwargs["response_mime_type"] = response_mime_type

    thinking_cfg = None
    if hasattr(types, "ThinkingConfig") and hasattr(types, "ThinkingLevel"):
        thinking_cfg = types.ThinkingConfig(thinking_level=types.ThinkingLevel.MINIMAL)

    if thinking_cfg is not None:
        try:
            return client.models.generate_content(
                model=model,
                contents=contents,
                config=types.GenerateContentConfig(**cfg_kwargs, thinking_config=thinking_cfg),
            )
        except Exception as exc:
            err_lower = str(exc).lower()
            if any(tok in err_lower for tok in ("thinking", "invalid_argument", "unsupported", "400")):
                logger.info("Retrying generate_content without thinking_config for model %s: %s", model, exc)
            else:
                raise

    return client.models.generate_content(
        model=model,
        contents=contents,
        config=types.GenerateContentConfig(**cfg_kwargs),
    )


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
        f"Identify 3-5 standout remix moments in '{ref.title}'. {window_note}\n"
        f"Return STRICT JSON ONLY: "
        f'{{"moments":[{{"label":"Short name","start":12.0,"end":20.0,"note":"Plain-English vibe"}}]}} '
        f"(seconds, start < end)."
    )
    contents.append(prompt)

    client = genai.Client(api_key=api_key)
    response = _generate_content(
        client=client,
        model=model,
        contents=contents,
        response_mime_type="application/json",
        temperature=0.3,
        max_output_tokens=500,
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
        sel_start = 0.0
        sel_end = min(duration, 16.0)

    # Compact 12 kHz mono main clip (max 16s with 1.5s padding)
    clip_start = max(0.0, sel_start - 1.5)
    clip_end = min(duration, sel_end + 1.5)
    main_clip_bytes = create_compact_wav_clip(
        main_audio_path,
        start=clip_start,
        end=clip_end,
        max_seconds=16.0,
        target_sr=12000,
    )

    selected_refs = [r for r in project.references if r.id in set(reference_ids)] if reference_ids else []
    valid_ref_ids = {r.id for r in project.references}
    downloaded_ref_ids = {r.id for r in project.references if r.audio_downloaded and r.id in ref_audio_paths}

    context_doc: dict[str, Any] = {
        "track": {
            "name": main.name,
            "dur": round(main.duration, 2),
            "bpm": main.bpm,
            "key": main.key,
            "stems_ready": main.stems_status == "ready",
            "sections": [
                {"l": s.label, "s": round(s.start, 1), "e": round(s.end, 1)}
                for s in main.sections
            ],
        },
        "sel": [round(sel_start, 2), round(sel_end, 2)],
        "clip": [round(clip_start, 2), round(clip_end, 2)],
        "edits": [e.title for e in project.edits if e.enabled][-5:],
        "refs": [
            {
                "id": r.id,
                "title": r.title,
                "bpm": r.bpm,
                "key": r.key,
                "dl": r.audio_downloaded,
                "stems": r.stems_status == "ready",
                "moments": [
                    {"l": m.label, "s": round(m.start, 1), "e": round(m.end, 1)}
                    for m in r.moments[:5]
                ],
            }
            for r in selected_refs
        ],
    }
    if selection is not None and selection.lane and selection.lane != "all":
        context_doc["lane"] = selection.lane

    mashup_rule = (
        "borrow_stem allowed ONLY for refs with dl=true."
        if any(r.id in downloaded_ref_ids for r in selected_refs)
        else "NO borrow_stem (no downloaded ref audio)."
    )

    system_prompt = (
        "You are Musak's friendly AI music producer helping a non-musician make SMALL, SURGICAL, moment-by-moment edits so they stay in control — NOT full-song rewrites.\n"
        "PUSHBACK RULE: If the user asks to rewrite/remix the whole song, redo the whole track in another artist's style, or gives a broad unfocused request, "
        "gently push back in 1-2 warm sentences explaining Musak shines one moment at a time and suggest a specific detected section + timestamp (e.g. Drop/Chorus), "
        "AND still return 1 small starter proposal (<=16s, 1-2 ops) on that moment so they can audition immediately.\n"
        "RULES: reply MUST be 1-2 short plain-English sentences (<=40 words). Return 1-2 focused proposals max, each with 1-2 surgical ops. "
        "Avoid full-song edits UNLESS explicitly asked for Slowed+Reverb, Sped Up, or Pitch Shift. "
        "If context includes \"lane\" (vocals|drums|bass|other), focus your edits on that specific stem!\n"
        "OPS:\n"
        'stem_gain:{type,stems,start,end,gain_db:-60..12,fade_ms,snap_to_beat}\n'
        'filter_sweep:{type,stems,start,end,mode:"highpass"|"lowpass",start_hz,end_hz,snap_to_beat}\n'
        'reverb_throw:{type,stems,start,end,room_size:0.1..1,wet_level:0.1..1,snap_to_beat}\n'
        'delay_throw:{type,stems,start,end,delay_beats:0.25|0.5|0.75|1,feedback:0.1..0.8,mix:0.2..0.8,snap_to_beat}\n'
        'lofi_eq:{type,stems,start,end,low_cut_hz,high_cut_hz,drive_db,snap_to_beat}\n'
        'bass_boost:{type,stems,start,end,gain_db,cutoff_hz,snap_to_beat}\n'
        'borrow_stem:{type,ref_id,ref_stem:"vocals"|"drums"|"bass"|"other"|"full",ref_start,ref_end,target_start,target_end,replace_main_stems,match_bpm,match_key,snap_to_beat}\n'
        'tempo_pitch:{type,start,end,speed_rate:0.5..1.6,semitones:-12..12,add_reverb,reverb_wet:0..0.8,snap_to_beat:false}\n'
        'add_sfx:{type,sfx_id:"riser_noise"|"riser_synth"|"sub_impact"|"reverse_cymbal"|"snare_roll"|"tape_stop",start,end,gain_db:-24..12,snap_to_beat}\n'
        'beat_repeat:{type,stems,start,end,division_beats:0.125|0.25|0.5,snap_to_beat}\n'
        'vinyl_brake:{type,stems,start,end,snap_to_beat}\n'
        'cut_section:{type,start,end,snap_to_beat}\n'
        'repeat_section:{type,start,end,repeat_count:2..4,snap_to_beat}\n'
        f"{mashup_rule} Timestamps in [0,{duration:.2f}].\n"
        'STRICT JSON ONLY: {"reply":"...","proposals":[{"title":"...","summary":"1 short sentence","style":"imitate"|"mashup"|"creative","start":12.0,"end":20.0,"operations":[...]}]}'
    )

    contents: list[Any] = [
        system_prompt,
        f"CTX:{json.dumps(context_doc, separators=(',', ':'))}",
        types.Part.from_bytes(data=main_clip_bytes, mime_type="audio/wav"),
    ]

    # Attach at most 1 reference media item: prefer compact 12s @ 12 kHz local WAV (even for downloaded YouTube refs)
    ref_media_attached = False
    for ref in selected_refs:
        local_path = ref_audio_paths.get(ref.id)
        if local_path is not None and local_path.is_file():
            ref_s = ref.moments[0].start if ref.moments else 0.0
            ref_e = ref.moments[0].end if ref.moments else 12.0
            ref_bytes = create_compact_wav_clip(
                local_path,
                start=ref_s,
                end=ref_e,
                max_seconds=12.0,
                target_sr=12000,
            )
            contents.append(types.Part.from_bytes(data=ref_bytes, mime_type="audio/wav"))
            ref_media_attached = True
            break

    if not ref_media_attached:
        for ref in selected_refs:
            if ref.source_type == "youtube" and ref.youtube_url:
                contents.append(types.Part.from_uri(file_uri=ref.youtube_url, mime_type="video/*"))
                break

    recent_history = project.chat_messages[-3:]
    if recent_history:
        history_lines = [f"{m.role[0].upper()}: {m.content[:180]}" for m in recent_history]
        contents.append("History:\n" + "\n".join(history_lines))

    contents.append(f"User: {user_message}")

    client = genai.Client(api_key=api_key)
    response = _generate_content(
        client=client,
        model=model,
        contents=contents,
        response_mime_type="application/json",
        temperature=0.45,
        max_output_tokens=600,
    )

    payload = _parse_json_payload(response.text or "{}")
    if not isinstance(payload, dict):
        payload = {"reply": str(response.text or "Here are a couple focused ideas!"), "proposals": []}

    reply = str(payload.get("reply") or "Here are focused remix ideas for this moment.").strip()
    raw_proposals = payload.get("proposals")
    if not isinstance(raw_proposals, list):
        raw_proposals = []

    proposals: list[EditProposal] = []
    for raw_prop in raw_proposals[:2]:
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
            for raw_op in raw_ops[:3]:
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
        "Transcribe the spoken music-editing request accurately. "
        "Format spoken timestamps as m:ss (e.g. 0:45, 1:12), preserve song/artist/track names, "
        "and return ONLY the transcribed text (no quotes or commentary; empty string if silent)."
    )

    client = genai.Client(api_key=api_key)
    response = _generate_content(
        client=client,
        model=model,
        contents=[
            types.Part.from_bytes(data=audio_bytes, mime_type=mime_type),
            prompt,
        ],
        response_mime_type=None,
        temperature=0.0,
        max_output_tokens=200,
    )

    text = (response.text or "").strip()
    if len(text) >= 2 and ((text[0] == '"' and text[-1] == '"') or (text[0] == "'" and text[-1] == "'")):
        text = text[1:-1].strip()
    return text


def extract_lyric_hooks(
    audio_path: Path,
    duration: float,
    api_key: str,
    model: str,
) -> list[LyricHook]:
    """Use Gemini to extract 5-10 timestamped clickable vocal lyrics, hooks, and big drops."""
    if not api_key:
        raise ValueError("Gemini API key is required for lyric/hook extraction.")
    if not audio_path.is_file():
        raise FileNotFoundError(f"Audio file not found: {audio_path}")

    info = sf.info(str(audio_path))
    file_dur = info.frames / float(info.samplerate) if info.samplerate > 0 else duration
    base_dur = min(duration, file_dur) if (duration > 0 and file_dur > 0) else max(duration, file_dur, 0.5)
    analyzed_end = round(min(max(base_dur, 0.5), 120.0), 2)

    wav_bytes = create_compact_wav_clip(
        audio_path,
        start=0.0,
        end=analyzed_end,
        max_seconds=120.0,
        target_sr=12000,
    )

    prompt = (
        f"Audio clip covers [0.0s, {analyzed_end:.1f}s]. "
        "Identify 5-10 standout vocal lyric snippets (3-10 words), catchy hooks, or big instrumental drops.\n"
        'Return STRICT JSON ONLY: {"hooks":[{"text":"...","start":12.5,"end":18.0,"kind":"hook"|"lyric"|"drop"}]}\n'
        f"Timestamps MUST satisfy 0 <= start < end <= {analyzed_end:.1f}."
    )

    client = genai.Client(api_key=api_key)
    response = _generate_content(
        client=client,
        model=model,
        contents=[
            types.Part.from_bytes(data=wav_bytes, mime_type="audio/wav"),
            prompt,
        ],
        response_mime_type="application/json",
        temperature=0.2,
        max_output_tokens=600,
    )

    payload = _parse_json_payload(response.text or "{}")
    raw_hooks = payload.get("hooks", []) if isinstance(payload, dict) else (payload if isinstance(payload, list) else [])

    hooks: list[LyricHook] = []
    for item in raw_hooks[:10]:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or "").strip()[:140]
        if not text:
            continue
        kind = str(item.get("kind") or "lyric").strip().lower()
        if kind not in VALID_HOOK_KINDS:
            kind = "lyric"
        try:
            max_start = max(0.0, analyzed_end - 0.5)
            start = max(0.0, min(float(item.get("start", 0.0)), max_start))
            raw_end = float(item.get("end", start + 4.0))
            end = min(analyzed_end, max(start + 0.5, raw_end))
        except (TypeError, ValueError):
            continue
        if end <= start:
            continue
        hooks.append(
            LyricHook(
                id=generate_id("hook"),
                text=text,
                start=round(start, 2),
                end=round(end, 2),
                kind=kind,  # type: ignore[arg-type]
            )
        )

    hooks.sort(key=lambda h: h.start)
    return hooks

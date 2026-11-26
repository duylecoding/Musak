"""Validation, clamping, and JSON extraction for Gemini Producer operations."""

from __future__ import annotations

import json
import math
import re
from typing import Any

from musak.config import STEM_NAMES
from musak.models import EditOperation
from musak.sfx import KNOWN_SFX_IDS, get_sfx_item

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
    "sidechain_pump",
    "stereo_wash",
}
VALID_STYLES = {"imitate", "mashup", "creative"}
VALID_REF_STEMS = {"vocals", "drums", "bass", "other", "full"}
VALID_HOOK_KINDS = {"hook", "lyric", "drop"}
_POST_OVERLAY_TYPES = ("sidechain_pump", "filter_sweep", "vinyl_brake", "beat_repeat", "stereo_wash")


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


def _clamp_time(val: Any, fallback: float, duration: float) -> float:
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

    clean: dict[str, Any] = {
        "type": op_type,
        "snap_to_beat": True if raw_op.get("snap_to_beat") is None else bool(raw_op["snap_to_beat"]),
    }

    if op_type == "borrow_stem":
        ref_id = raw_op.get("ref_id")
        if not isinstance(ref_id, str) or ref_id not in valid_ref_ids or ref_id not in downloaded_ref_ids:
            return None
        ref_stem = raw_op.get("ref_stem", "full")
        if ref_stem not in VALID_REF_STEMS:
            ref_stem = "full"

        t_start = _clamp_time(raw_op.get("target_start", raw_op.get("start")), default_start, duration)
        t_end = _clamp_time(raw_op.get("target_end", raw_op.get("end")), default_end, duration)
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
        if (gain_db := _opt_float(raw_op.get("gain_db"), -24.0, 12.0)) is not None:
            clean["gain_db"] = gain_db
        if raw_op.get("loop_to_fit") is not None:
            clean["loop_to_fit"] = bool(raw_op["loop_to_fit"])
        for fade_field in ("fade_in_ms", "fade_out_ms"):
            if (fv := _opt_float(raw_op.get(fade_field), 0.0, 4000.0)) is not None:
                clean[fade_field] = fv
        return EditOperation.model_validate(clean)

    if op_type == "add_sfx":
        sfx_id = raw_op.get("sfx_id")
        if not isinstance(sfx_id, str) or sfx_id not in KNOWN_SFX_IDS:
            return None
        sfx_item = get_sfx_item(sfx_id)
        s = _clamp_time(raw_op.get("start"), default_start, duration)
        sfx_default_end = round(min(duration, s + sfx_item.default_duration), 3) if sfx_item is not None else default_end
        e = _clamp_time(raw_op.get("end"), sfx_default_end if raw_op.get("end") is None else default_end, duration)
        if e <= s:
            e = round(min(duration, s + (sfx_item.default_duration if sfx_item is not None else 2.0)), 3)
        if e <= s:
            return None
        clean.update({"start": s, "end": e, "sfx_id": sfx_id, "gain_db": _float_or(raw_op.get("gain_db"), -24.0, 12.0, 0.0)})
        for fade_field in ("fade_in_ms", "fade_out_ms"):
            if (fv := _opt_float(raw_op.get(fade_field), 0.0, 4000.0)) is not None:
                clean[fade_field] = fv
        if isinstance(raw_op.get("layer_id"), str) and raw_op["layer_id"].strip():
            clean["layer_id"] = raw_op["layer_id"].strip()[:64]
        if isinstance(raw_op.get("musical_key"), str) and raw_op["musical_key"].strip():
            clean["musical_key"] = raw_op["musical_key"].strip()[:32]
        return EditOperation.model_validate(clean)

    s = _clamp_time(raw_op.get("start"), default_start, duration)
    e = _clamp_time(raw_op.get("end"), default_end, duration)
    if e <= s:
        e = round(min(duration, s + 2.0), 3)
    if e <= s:
        return None
    clean["start"], clean["end"] = s, e

    if isinstance(raw_op.get("stems"), list):
        filtered = [st for st in raw_op["stems"] if isinstance(st, str) and st in (*STEM_NAMES, "full")]
        if filtered:
            clean["stems"] = filtered
    if raw_op.get("apply_to_layers") is not None and op_type in _POST_OVERLAY_TYPES:
        clean["apply_to_layers"] = bool(raw_op["apply_to_layers"])

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
    elif op_type == "sidechain_pump":
        clean["division_beats"] = _float_or(raw_op.get("division_beats"), 0.0625, 2.0, 1.0)
        clean["depth"] = _float_or(raw_op.get("depth"), 0.05, 0.95, 0.7)
    elif op_type == "stereo_wash":
        clean["width"] = _float_or(raw_op.get("width"), 0.5, 2.0, 1.45)
        clean["chorus_mix"] = _float_or(raw_op.get("chorus_mix"), 0.0, 0.8, 0.35)
    elif op_type == "repeat_section":
        try:
            rc = int(round(float(raw_op.get("repeat_count", 2))))
        except (TypeError, ValueError):
            rc = 2
        clean["repeat_count"] = max(2, min(4, rc))

    return EditOperation.model_validate(clean)

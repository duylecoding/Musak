"""Helper applying partial FX, fade, borrow, and timing updates to an EditBlock."""

from __future__ import annotations

from fastapi import HTTPException

from musak.dsp import remap_operation_range, tune_proposal_operations
from musak.models import EditBlock, EditOperation, EditProposal, ProjectState, TuneProposalRequest, UpdateEditRequest
from musak.storage import generate_id, utc_now_iso


def _apply_op_field_updates(op: EditOperation, body: UpdateEditRequest, is_composite_layer: bool) -> None:
    """Apply matching FX, fade, borrow, and DJ move parameter overrides onto a single `EditOperation`."""
    is_aux_duck = is_composite_layer and op.type == "stem_gain"

    if body.gain_db is not None and not is_aux_duck and op.type in ("stem_gain", "add_sfx", "borrow_stem", "bass_boost"):
        op.gain_db = round(float(body.gain_db), 3)

    if not is_aux_duck and op.type in ("stem_gain", "add_sfx", "borrow_stem"):
        if body.fade_in_ms is not None:
            op.fade_in_ms = round(float(body.fade_in_ms), 2)
        if body.fade_out_ms is not None:
            op.fade_out_ms = round(float(body.fade_out_ms), 2)

    if op.type == "stem_gain" and body.fade_curve is not None:
        op.fade_curve = body.fade_curve

    if op.type == "filter_sweep":
        for field in ("mode", "start_hz", "end_hz"):
            if (val := getattr(body, field)) is not None:
                setattr(op, field, round(float(val), 2) if isinstance(val, (int, float)) else val)

    if op.type == "reverb_throw":
        for field in ("room_size", "wet_level"):
            if (val := getattr(body, field)) is not None:
                setattr(op, field, round(float(val), 3))

    if op.type == "delay_throw":
        for field in ("delay_beats", "feedback", "mix"):
            if (val := getattr(body, field)) is not None:
                setattr(op, field, round(float(val), 4))

    if op.type == "lofi_eq":
        new_low = round(float(body.low_cut_hz), 2) if body.low_cut_hz is not None else op.low_cut_hz
        new_high = round(float(body.high_cut_hz), 2) if body.high_cut_hz is not None else op.high_cut_hz
        if new_low is not None and new_high is not None and new_high <= new_low:
            raise HTTPException(status_code=400, detail="high_cut_hz must be greater than low_cut_hz.")
        op.low_cut_hz = new_low
        op.high_cut_hz = new_high
        if body.drive_db is not None:
            op.drive_db = round(float(body.drive_db), 3)

    if op.type == "bass_boost" and body.cutoff_hz is not None:
        op.cutoff_hz = round(float(body.cutoff_hz), 2)

    if op.type == "borrow_stem":
        new_rs = round(float(body.ref_start), 3) if body.ref_start is not None else op.ref_start
        new_re = round(float(body.ref_end), 3) if body.ref_end is not None else op.ref_end
        if new_rs is not None and new_re is not None and new_re <= new_rs:
            raise HTTPException(status_code=400, detail="ref_end must be greater than ref_start.")
        op.ref_start = new_rs
        op.ref_end = new_re
        if body.replace_main_stems is not None:
            op.replace_main_stems = list(body.replace_main_stems)
        for flag in ("match_bpm", "match_key", "loop_to_fit"):
            if (val := getattr(body, flag)) is not None:
                if flag == "match_key" and op.ref_stem == "drums" and bool(val):
                    continue
                setattr(op, flag, bool(val))

    if op.type == "beat_repeat" and body.division_beats is not None:
        op.division_beats = round(float(body.division_beats), 4)

    if op.type == "repeat_section" and body.repeat_count is not None:
        op.repeat_count = int(body.repeat_count)


def apply_patch_to_edit(proj: ProjectState, target: EditBlock, body: UpdateEditRequest) -> None:
    """Validate and apply `UpdateEditRequest` mutations onto `target` in place."""
    if body.enabled is not None:
        target.enabled = body.enabled
    if body.title is not None:
        target.title = body.title

    if body.start is not None or body.end is not None:
        duration = proj.main_track.duration if proj.main_track is not None else max(target.end, 3600.0)
        old_start, old_end = float(target.start), float(target.end)
        new_start = max(0.0, min(float(body.start), duration)) if body.start is not None else old_start
        new_end = max(0.0, min(float(body.end), duration)) if body.end is not None else old_end
        if new_end <= new_start:
            raise HTTPException(status_code=400, detail="Edit end time must be greater than start time.")
        for op in target.operations:
            remap_operation_range(op, old_start, old_end, new_start, new_end, duration)
        target.start, target.end = round(new_start, 3), round(new_end, 3)

    is_composite_layer = any(op.type in ("borrow_stem", "add_sfx") for op in target.operations)
    for op in target.operations:
        _apply_op_field_updates(op, body, is_composite_layer)


def build_duplicated_edit(proj: ProjectState, orig: EditBlock, start_override: float | None) -> EditBlock:
    """Deep-copy `orig` with a fresh ID and remap its range cleanly to `start_override` or after `orig`."""
    assert proj.main_track is not None
    duration = max(0.05, float(proj.main_track.duration))
    orig_start, orig_end = float(orig.start), float(orig.end)
    span = max(0.05, orig_end - orig_start)

    if start_override is not None:
        new_start = max(0.0, min(float(start_override), max(0.0, duration - 0.05)))
    else:
        new_start = max(0.0, min(duration - span, orig_end))
    new_end = min(duration, new_start + span)
    if new_end <= new_start:
        new_start = max(0.0, duration - 0.05)
        new_end = duration

    cloned = orig.model_copy(deep=True)
    cloned.id = generate_id("edit")
    cloned.created_at = utc_now_iso()
    cloned.source_proposal_id = None
    for op in cloned.operations:
        remap_operation_range(op, orig_start, orig_end, new_start, new_end, duration)
    cloned.start, cloned.end = round(new_start, 3), round(new_end, 3)
    return cloned


def apply_proposal_tune_fields(working: ProjectState, prop: EditProposal, body: TuneProposalRequest) -> None:
    """Retune `prop` in place using `tune_proposal_operations` without invoking an LLM."""
    assert working.main_track is not None
    if not prop.base_operations:
        prop.base_operations = [op.model_copy(deep=True) for op in prop.operations]

    new_intensity = body.intensity if body.intensity is not None else prop.intensity
    new_keep_vocals = body.keep_vocals_clear if body.keep_vocals_clear is not None else prop.keep_vocals_clear
    new_shift_beats = body.shift_beats if body.shift_beats is not None else prop.shift_beats

    tuned_ops = tune_proposal_operations(
        base_ops=prop.base_operations,
        intensity=new_intensity,
        keep_vocals_clear=new_keep_vocals,
        shift_beats=new_shift_beats,
        bpm=working.main_track.bpm,
        duration=working.main_track.duration,
    )
    prop.operations = tuned_ops
    prop.intensity = round(float(new_intensity), 3)
    prop.keep_vocals_clear = bool(new_keep_vocals)
    prop.shift_beats = round(float(new_shift_beats), 3)

    starts = [x for op in tuned_ops if (x := (op.target_start if op.type == "borrow_stem" else op.start)) is not None]
    ends = [x for op in tuned_ops if (x := (op.target_end if op.type == "borrow_stem" else op.end)) is not None]
    if starts and ends:
        prop.start, prop.end = round(min(starts), 3), round(max(ends), 3)

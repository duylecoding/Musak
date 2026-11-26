"""Gemini Producer prompts, context document builder, and structured response parsers."""

from __future__ import annotations

from typing import Any

from musak.gemini_sanitize import VALID_HOOK_KINDS, VALID_STYLES, _parse_json_payload, _sanitize_operation
from musak.models import EditOperation, EditProposal, LyricHook, MomentPin, ProjectState, ReferenceTrack, TimeSelection
from musak.storage import generate_id


def build_producer_system_prompt(mashup_rule: str, duration: float) -> str:
    return (
        "You are Musak's friendly AI music producer helping a non-musician make SMALL, SURGICAL, moment-by-moment edits so they stay in control — NOT full-song rewrites.\n"
        "PUSHBACK RULE: If the user asks to rewrite/remix the whole song, redo the whole track in another artist's style, or gives a broad unfocused request, "
        "gently push back in 1-2 warm sentences explaining Musak shines one moment at a time and suggest a specific detected section + timestamp (e.g. Drop/Chorus), "
        "AND still return 1 small starter proposal (<=16s, 1-2 ops) on that moment so they can audition immediately.\n"
        "RULES: reply MUST be 1-2 short plain-English sentences (<=40 words). Return 1-2 focused proposals max, each with 1-2 surgical ops. "
        "Avoid full-song edits UNLESS explicitly asked for Slowed+Reverb, Sped Up, or Pitch Shift. "
        'If context includes "lane" (vocals|drums|bass|other), focus your edits on that specific stem!\n'
        "OPS:\n"
        'stem_gain:{type,stems,start,end,gain_db:-60..12,fade_ms,snap_to_beat}\n'
        'filter_sweep:{type,stems,start,end,mode:"highpass"|"lowpass",start_hz,end_hz,snap_to_beat}\n'
        'reverb_throw:{type,stems,start,end,room_size:0.1..1,wet_level:0.1..1,snap_to_beat}\n'
        'delay_throw:{type,stems,start,end,delay_beats:0.25|0.5|0.75|1,feedback:0.1..0.8,mix:0.2..0.8,snap_to_beat}\n'
        'lofi_eq:{type,stems,start,end,low_cut_hz,high_cut_hz,drive_db,snap_to_beat}\n'
        'bass_boost:{type,stems,start,end,gain_db,cutoff_hz,snap_to_beat}\n'
        'borrow_stem:{type,ref_id,ref_stem:"vocals"|"drums"|"bass"|"other"|"full",ref_start,ref_end,target_start,target_end,replace_main_stems,match_bpm,match_key,snap_to_beat}\n'
        'tempo_pitch:{type,start,end,speed_rate:0.5..1.6,semitones:-12..12,add_reverb,reverb_wet:0..0.8,snap_to_beat:false}\n'
        'add_sfx:{type,sfx_id:"riser_noise"|"riser_synth"|"sub_impact"|"reverse_cymbal"|"snare_roll"|"tape_stop"|"supersaw_swell"|"ambient_pad",start,end,gain_db:-24..12,snap_to_beat}\n'
        'sidechain_pump:{type,stems,start,end,division_beats:0.5|1.0,depth:0.05..0.95,apply_to_layers,snap_to_beat}\n'
        'stereo_wash:{type,stems,start,end,width:0.5..2.0,chorus_mix:0.0..0.8,apply_to_layers,snap_to_beat}\n'
        'beat_repeat:{type,stems,start,end,division_beats:0.125|0.25|0.5,snap_to_beat}\n'
        'vinyl_brake:{type,stems,start,end,snap_to_beat}\n'
        'cut_section:{type,start,end,snap_to_beat}\n'
        'repeat_section:{type,start,end,repeat_count:2..4,snap_to_beat}\n'
        f"{mashup_rule} Timestamps in [0,{duration:.2f}].\n"
        'STRICT JSON ONLY: {"reply":"...","proposals":[{"title":"...","summary":"1 short sentence","style":"imitate"|"mashup"|"creative","start":12.0,"end":20.0,"operations":[...]}]}'
    )


def build_chat_context(
    project: ProjectState,
    sel_start: float,
    sel_end: float,
    clip_start: float,
    clip_end: float,
    selected_refs: list[ReferenceTrack],
    selection: TimeSelection | None,
) -> dict[str, Any]:
    main = project.main_track
    assert main is not None
    doc: dict[str, Any] = {
        "track": {
            "name": main.name, "dur": round(main.duration, 2), "bpm": main.bpm, "key": main.key,
            "stems_ready": main.stems_status == "ready",
            "sections": [{"l": s.label, "s": round(s.start, 1), "e": round(s.end, 1)} for s in main.sections],
        },
        "sel": [round(sel_start, 2), round(sel_end, 2)],
        "clip": [round(clip_start, 2), round(clip_end, 2)],
        "edits": [e.title for e in project.edits if e.enabled][-5:],
        "refs": [
            {
                "id": r.id, "title": r.title, "bpm": r.bpm, "key": r.key,
                "dl": r.audio_downloaded, "stems": r.stems_status == "ready",
                "moments": [{"l": m.label, "s": round(m.start, 1), "e": round(m.end, 1)} for m in r.moments[:5]],
            }
            for r in selected_refs
        ],
    }
    if selection is not None and selection.lane and selection.lane != "all":
        doc["lane"] = selection.lane
    return doc


def parse_producer_proposals(
    raw_text: str,
    duration: float,
    valid_ref_ids: set[str],
    downloaded_ref_ids: set[str],
    sel_start: float,
    sel_end: float,
) -> tuple[str, list[EditProposal]]:
    payload = _parse_json_payload(raw_text or "{}")
    if not isinstance(payload, dict):
        payload = {"reply": str(raw_text or "Here are a couple focused ideas!"), "proposals": []}

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
                op = _sanitize_operation(raw_op, duration, valid_ref_ids, downloaded_ref_ids, p_start, p_end)
                if op is not None:
                    sanitized_ops.append(op)
        if not sanitized_ops:
            continue

        op_starts = [op.target_start if op.type == "borrow_stem" else op.start for op in sanitized_ops]
        op_ends = [op.target_end if op.type == "borrow_stem" else op.end for op in sanitized_ops]
        valid_s = [x for x in op_starts if x is not None]
        valid_e = [x for x in op_ends if x is not None]
        if valid_s and valid_e:
            p_start, p_end = round(min(valid_s), 3), round(max(valid_e), 3)

        proposals.append(
            EditProposal(
                id=generate_id("prop"),
                title=str(raw_prop.get("title") or "Producer Idea").strip()[:120],
                summary=str(raw_prop.get("summary") or "Custom remix edit.").strip()[:300],
                style=style,
                start=round(p_start, 3),
                end=round(p_end, 3),
                operations=sanitized_ops,
            )
        )
    return reply, proposals


def parse_moment_pins(raw_text: str, max_dur: float) -> list[MomentPin]:
    payload = _parse_json_payload(raw_text or "{}")
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
        if end > start:
            pins.append(MomentPin(id=generate_id("mom"), label=label or "Moment", start=round(start, 2), end=round(end, 2), note=note, source="gemini"))
    return pins


def parse_lyric_hooks(raw_text: str, analyzed_end: float) -> list[LyricHook]:
    payload = _parse_json_payload(raw_text or "{}")
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
            start = max(0.0, min(float(item.get("start", 0.0)), max(0.0, analyzed_end - 0.5)))
            end = min(analyzed_end, max(start + 0.5, float(item.get("end", start + 4.0))))
        except (TypeError, ValueError):
            continue
        if end > start:
            hooks.append(LyricHook(id=generate_id("hook"), text=text, start=round(start, 2), end=round(end, 2), kind=kind))  # type: ignore[arg-type]
    hooks.sort(key=lambda h: h.start)
    return hooks

"""Deterministic proposal retuning and timeline operation range remapping."""

from __future__ import annotations

import math

import numpy as np

from musak.models import EditOperation


def remap_operation_range(
    op: EditOperation,
    old_start: float,
    old_end: float,
    new_start: float,
    new_end: float,
    duration: float,
) -> None:
    """Shift or rescale an operation's timestamps cleanly from `[old_start, old_end]` into `[new_start, new_end]`."""
    old_span = max(0.05, old_end - old_start)
    new_span = max(0.05, new_end - new_start)
    scale = new_span / old_span

    def _map_window(raw_s: float | None, raw_e: float | None) -> tuple[float, float]:
        s_val = old_start if raw_s is None else float(raw_s)
        e_val = old_end if raw_e is None else float(raw_e)
        if abs(scale - 1.0) < 1e-4:
            delta = new_start - old_start
            mapped_s = s_val + delta
            mapped_e = e_val + delta
        else:
            mapped_s = new_start + (s_val - old_start) * scale
            mapped_e = new_start + (e_val - old_start) * scale
        mapped_s = max(0.0, min(mapped_s, max(0.0, duration - 0.05)))
        mapped_e = max(mapped_s + 0.05, min(mapped_e, duration))
        if mapped_e <= mapped_s:
            mapped_s = max(0.0, duration - 0.05)
            mapped_e = duration
        return round(mapped_s, 3), round(mapped_e, 3)

    if op.type == "borrow_stem":
        ts, te = _map_window(
            op.target_start if op.target_start is not None else op.start,
            op.target_end if op.target_end is not None else op.end,
        )
        op.target_start = ts
        op.target_end = te
        if op.start is not None or op.end is not None:
            op.start = ts
            op.end = te
    else:
        s_out, e_out = _map_window(op.start, op.end)
        op.start = s_out
        op.end = e_out


def tune_proposal_operations(
    base_ops: list[EditOperation],
    intensity: float = 1.0,
    keep_vocals_clear: bool = False,
    shift_beats: float = 0.0,
    bpm: float = 120.0,
    duration: float = 0.0,
) -> list[EditOperation]:
    """Deterministically retune a proposal's operations locally without calling an LLM."""
    clamped_intensity = float(np.clip(intensity, 0.25, 1.75))
    shift_sec = float(shift_beats) * (60.0 / bpm) if (shift_beats != 0.0 and bpm > 0.0) else 0.0
    max_dur = max(0.25, float(duration)) if duration > 0.0 else 3600.0

    def _shift_window(s: float | None, e: float | None) -> tuple[float | None, float | None]:
        if s is None or e is None or shift_sec == 0.0:
            return s, e
        if s <= 0.05 and duration > 0.0 and e >= duration - 0.05:
            return s, e
        span = max(0.25, e - s)
        new_s = max(0.0, min(s + shift_sec, max(0.0, max_dur - 0.25)))
        new_e = min(max_dur, max(new_s + 0.25, new_s + span))
        if new_e - new_s < 0.25 and new_e >= 0.25:
            new_s = max(0.0, new_e - 0.25)
        return round(new_s, 3), round(new_e, 3)

    tuned: list[EditOperation] = []
    for raw_op in base_ops:
        op = raw_op.model_copy(deep=True)

        if op.type == "borrow_stem":
            op.target_start, op.target_end = _shift_window(op.target_start, op.target_end)
        else:
            op.start, op.end = _shift_window(op.start, op.end)

        if keep_vocals_clear:
            if op.type in ("add_sfx", "cut_section", "repeat_section"):
                pass
            elif op.type == "borrow_stem":
                if op.replace_main_stems:
                    op.replace_main_stems = (
                        ["drums", "bass", "other"]
                        if ("full" in op.replace_main_stems or "all" in op.replace_main_stems)
                        else [s for s in op.replace_main_stems if s != "vocals"]
                    )
            else:
                if not op.stems or "full" in op.stems or "all" in op.stems:
                    op.stems = ["drums", "bass", "other"]
                else:
                    filtered = [s for s in op.stems if s != "vocals"]
                    if not filtered:
                        if op.type == "stem_gain":
                            continue
                        op.stems = ["drums", "bass", "other"]
                    else:
                        op.stems = filtered

        if op.type == "stem_gain":
            if op.gain_db is not None and op.gain_db > -40.0:
                op.gain_db = round(float(np.clip(op.gain_db * clamped_intensity, -36.0, 12.0)), 3)
        elif op.type == "reverb_throw":
            base_wet = op.wet_level if op.wet_level is not None else 0.45
            base_room = op.room_size if op.room_size is not None else 0.75
            op.wet_level = round(float(np.clip(base_wet * clamped_intensity, 0.05, 0.95)), 3)
            op.room_size = round(float(np.clip(base_room * (0.7 + 0.3 * clamped_intensity), 0.1, 1.0)), 3)
        elif op.type == "delay_throw":
            base_mix = op.mix if op.mix is not None else 0.4
            base_fb = op.feedback if op.feedback is not None else 0.45
            op.mix = round(float(np.clip(base_mix * clamped_intensity, 0.05, 0.95)), 3)
            op.feedback = round(float(np.clip(base_fb * (0.75 + 0.25 * clamped_intensity), 0.05, 0.88)), 3)
        elif op.type == "lofi_eq":
            base_drive = op.drive_db if op.drive_db is not None else 8.0
            op.drive_db = round(float(np.clip(base_drive * clamped_intensity, 0.0, 28.0)), 3)
        elif op.type == "bass_boost":
            base_gain = op.gain_db if op.gain_db is not None else 6.0
            op.gain_db = round(float(np.clip(base_gain * clamped_intensity, -12.0, 16.0)), 3)
        elif op.type == "filter_sweep":
            mode = op.mode or "lowpass"
            s_hz = op.start_hz if op.start_hz is not None else (150.0 if mode == "highpass" else 16000.0)
            e_hz = op.end_hz if op.end_hz is not None else (2400.0 if mode == "highpass" else 350.0)
            s_hz = max(30.0, min(18000.0, float(s_hz)))
            e_hz = max(30.0, min(18000.0, float(e_hz)))
            log_mid = 0.5 * (math.log(s_hz) + math.log(e_hz))
            half_span = 0.5 * (math.log(e_hz) - math.log(s_hz)) * (0.65 + 0.35 * clamped_intensity)
            op.start_hz = round(float(np.clip(math.exp(log_mid - half_span), 30.0, 18000.0)), 1)
            op.end_hz = round(float(np.clip(math.exp(log_mid + half_span), 30.0, 18000.0)), 1)
        elif op.type == "tempo_pitch":
            if op.add_reverb:
                base_rw = op.reverb_wet if op.reverb_wet is not None else 0.35
                op.reverb_wet = round(float(np.clip(base_rw * clamped_intensity, 0.05, 0.8)), 3)
            if op.speed_rate is not None and abs(op.speed_rate - 1.0) >= 0.005:
                op.speed_rate = round(float(np.clip(1.0 + (op.speed_rate - 1.0) * clamped_intensity, 0.5, 1.6)), 3)
            if op.semitones is not None and abs(op.semitones) >= 0.01:
                op.semitones = round(float(np.clip(op.semitones * clamped_intensity, -12.0, 12.0)), 2)
        elif op.type == "borrow_stem":
            base_g = op.gain_db if op.gain_db is not None else 0.0
            op.gain_db = round(float(np.clip(base_g + (clamped_intensity - 1.0) * 4.0, -12.0, 6.0)), 2)
        elif op.type == "add_sfx":
            base_g = op.gain_db if op.gain_db is not None else 0.0
            op.gain_db = round(float(np.clip(base_g + (clamped_intensity - 1.0) * 6.0, -24.0, 12.0)), 2)
        elif op.type == "sidechain_pump":
            base_depth = op.depth if op.depth is not None else 0.7
            op.depth = round(float(np.clip(base_depth * clamped_intensity, 0.05, 0.95)), 3)
        elif op.type == "stereo_wash":
            base_width = op.width if op.width is not None else 1.45
            base_mix = op.chorus_mix if op.chorus_mix is not None else 0.35
            op.width = round(float(np.clip(1.0 + (base_width - 1.0) * clamped_intensity, 0.5, 2.0)), 3)
            op.chorus_mix = round(float(np.clip(base_mix * clamped_intensity, 0.0, 0.8)), 3)

        tuned.append(op)

    return tuned

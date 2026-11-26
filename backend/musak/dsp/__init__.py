"""Non-destructive, beat-snapped DSP renderer supporting all Musak edit operations."""

from __future__ import annotations

from musak.dsp.arrangement import apply_arrangement_ops
from musak.dsp.borrow import compute_effective_borrow_rate
from musak.dsp.dj_moves import _apply_beat_repeat, _apply_vinyl_brake
from musak.dsp.mastering import apply_master_preset, export_mix
from musak.dsp.pipeline import (
    _execute_dsp_pipeline,
    render_operations,
    render_project_mix,
    render_proposal_preview,
)
from musak.dsp.tuning import remap_operation_range, tune_proposal_operations
from musak.dsp.utils import (
    ENDPOINT_SNAP_EPSILON,
    MAX_PREVIEW_SECONDS,
    collect_enabled_operations,
    resolve_rendered_audio_path,
    snap_range_to_beats,
    soft_limit,
)

__all__ = [
    "ENDPOINT_SNAP_EPSILON",
    "MAX_PREVIEW_SECONDS",
    "_apply_beat_repeat",
    "_apply_vinyl_brake",
    "apply_arrangement_ops",
    "apply_master_preset",
    "collect_enabled_operations",
    "compute_effective_borrow_rate",
    "export_mix",
    "remap_operation_range",
    "render_operations",
    "render_project_mix",
    "render_proposal_preview",
    "resolve_rendered_audio_path",
    "snap_range_to_beats",
    "soft_limit",
    "tune_proposal_operations",
]

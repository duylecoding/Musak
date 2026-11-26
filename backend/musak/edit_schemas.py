"""Edit, proposal-tuning, and clip-duplication Pydantic v2 request schemas."""

from __future__ import annotations

import math
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from musak.config import STEM_NAMES
from musak.models import EditOperation

_VALID_REPLACE_STEMS = {*STEM_NAMES, "full"}


class TuneProposalRequest(BaseModel):
    intensity: float | None = Field(default=None, ge=0.25, le=1.75)
    keep_vocals_clear: bool | None = None
    shift_beats: float | None = Field(default=None, ge=-16.0, le=16.0)


class CreateEditRequest(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str = ""
    start: float = Field(ge=0.0)
    end: float = Field(ge=0.0)
    operations: list[EditOperation] = Field(min_length=1)

    @field_validator("title")
    @classmethod
    def _non_blank_title(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Edit title cannot be empty or whitespace.")
        return cleaned

    @model_validator(mode="after")
    def _valid_range(self) -> CreateEditRequest:
        if self.end <= self.start:
            raise ValueError("Edit end time must be greater than start time.")
        return self


class UpdateEditRequest(BaseModel):
    enabled: bool | None = None
    start: float | None = Field(default=None, ge=0.0)
    end: float | None = Field(default=None, ge=0.0)
    title: str | None = Field(default=None, max_length=200)
    gain_db: float | None = Field(default=None, ge=-80.0, le=18.0)
    fade_in_ms: float | None = Field(default=None, ge=0.0, le=4000.0)
    fade_out_ms: float | None = Field(default=None, ge=0.0, le=4000.0)
    fade_curve: Literal["in", "out", "both"] | None = None
    mode: Literal["highpass", "lowpass"] | None = None
    start_hz: float | None = Field(default=None, ge=20.0, le=20000.0)
    end_hz: float | None = Field(default=None, ge=20.0, le=20000.0)
    room_size: float | None = Field(default=None, ge=0.0, le=1.0)
    wet_level: float | None = Field(default=None, ge=0.0, le=1.0)
    delay_beats: float | None = Field(default=None, ge=0.0625, le=4.0)
    feedback: float | None = Field(default=None, ge=0.0, le=0.92)
    mix: float | None = Field(default=None, ge=0.0, le=1.0)
    drive_db: float | None = Field(default=None, ge=0.0, le=30.0)
    cutoff_hz: float | None = Field(default=None, ge=40.0, le=400.0)
    low_cut_hz: float | None = Field(default=None, ge=40.0, le=4000.0)
    high_cut_hz: float | None = Field(default=None, ge=200.0, le=20000.0)
    ref_start: float | None = Field(default=None, ge=0.0)
    ref_end: float | None = Field(default=None, ge=0.0)
    replace_main_stems: list[str] | None = None
    match_bpm: bool | None = None
    match_key: bool | None = None
    loop_to_fit: bool | None = None
    division_beats: float | None = Field(default=None, ge=0.0625, le=2.0)
    repeat_count: int | None = Field(default=None, ge=2, le=4)

    @field_validator("title")
    @classmethod
    def _non_blank_title(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Edit title cannot be empty or whitespace.")
        return cleaned

    @field_validator("replace_main_stems")
    @classmethod
    def _valid_replace_stems(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        invalid = [s for s in value if s not in _VALID_REPLACE_STEMS]
        if invalid:
            raise ValueError(f"Invalid stem name(s) in replace_main_stems: {invalid}")
        return list(value)

    @model_validator(mode="after")
    def _valid_optional_ranges(self) -> UpdateEditRequest:
        for field_name in self.__class__.model_fields:
            val = getattr(self, field_name)
            if isinstance(val, float) and not math.isfinite(val):
                raise ValueError(f"{field_name} must be a finite number.")
        if self.start is not None and self.end is not None and self.end <= self.start:
            raise ValueError("Edit end time must be greater than start time.")
        if self.ref_start is not None and self.ref_end is not None and self.ref_end <= self.ref_start:
            raise ValueError("Reference end time must be greater than reference start time.")
        if self.low_cut_hz is not None and self.high_cut_hz is not None and self.high_cut_hz <= self.low_cut_hz:
            raise ValueError("high_cut_hz must be greater than low_cut_hz.")
        return self


PatchEditRequest = UpdateEditRequest


class DuplicateEditRequest(BaseModel):
    start: float | None = Field(default=None, ge=0.0)

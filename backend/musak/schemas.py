"""API request and response Pydantic v2 schemas matching docs/API_CONTRACT.md."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from musak.edit_schemas import (  # noqa: F401
    CreateEditRequest,
    DuplicateEditRequest,
    PatchEditRequest,
    TuneProposalRequest,
    UpdateEditRequest,
)
from musak.models import ProjectSummary, TimeSelection


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"
    cuda_available: bool
    gpu_name: str | None = None
    ffmpeg_available: bool
    api_key_configured: bool
    model: str
    stem_device: Literal["auto", "cuda", "cpu"] = "auto"


class StemDeviceRequest(BaseModel):
    device: Literal["auto", "cuda", "cpu"]


class StemDeviceResponse(BaseModel):
    stem_device: Literal["auto", "cuda", "cpu"]


class WaveformPeaksResponse(BaseModel):
    duration: float
    buckets: int
    main: list[float]
    rendered: list[float] | None = None
    stems: dict[str, list[float]] = Field(default_factory=dict)


class SfxItem(BaseModel):
    id: str
    name: str
    category: Literal["riser", "impact", "transition", "drums"]
    description: str
    default_duration: float
    bpm_synced: bool
    preview_url: str


class SfxListResponse(BaseModel):
    items: list[SfxItem]


class ApiKeyRequest(BaseModel):
    api_key: str


class ApiKeyStatusResponse(BaseModel):
    api_key_configured: bool


class ProjectListResponse(BaseModel):
    projects: list[ProjectSummary]


def _strip_non_blank(value: str, err: str) -> str:
    cleaned = value.strip()
    if not cleaned:
        raise ValueError(err)
    return cleaned


class CreateProjectRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)

    @field_validator("name")
    @classmethod
    def _non_blank_name(cls, value: str) -> str:
        return _strip_non_blank(value, "Project name cannot be empty or whitespace.")


class RenameProjectRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)

    @field_validator("name")
    @classmethod
    def _non_blank_name(cls, value: str) -> str:
        return _strip_non_blank(value, "Project name cannot be empty or whitespace.")


class DeleteProjectResponse(BaseModel):
    deleted: bool = True


class ExportRequest(BaseModel):
    format: Literal["wav", "mp3", "zip"] = "wav"
    target: Literal["remix", "instrumental", "vocals", "stems_zip"] = "remix"
    master_preset: Literal["off", "balanced", "club", "warm"] = "off"


MashupMode = Literal["ref_vocals_on_main", "main_vocals_on_ref", "ref_drums_on_main", "smart_auto"]


class MashupRequest(BaseModel):
    ref_id: str = Field(min_length=1, max_length=128)
    mode: MashupMode = "smart_auto"
    start: float | None = Field(default=None, ge=0.0)
    end: float | None = Field(default=None, ge=0.0)
    ref_start: float | None = Field(default=None, ge=0.0)
    ref_end: float | None = Field(default=None, ge=0.0)

    @model_validator(mode="after")
    def _valid_optional_range(self) -> MashupRequest:
        if self.start is not None and self.end is not None and self.end <= self.start:
            raise ValueError("Mashup end time must be greater than start time.")
        if self.ref_start is not None and self.ref_end is not None and self.ref_end <= self.ref_start:
            raise ValueError("Mashup ref_end must be greater than ref_start.")
        return self


class YouTubeReferenceRequest(BaseModel):
    url: str = Field(min_length=1)
    title: str | None = None

    @field_validator("url")
    @classmethod
    def _non_blank_url(cls, value: str) -> str:
        return _strip_non_blank(value, "YouTube URL cannot be blank.")


class CreateMomentRequest(BaseModel):
    label: str = Field(min_length=1, max_length=120)
    start: float = Field(ge=0.0)
    end: float = Field(ge=0.0)
    note: str = ""

    @field_validator("label")
    @classmethod
    def _non_blank_label(cls, value: str) -> str:
        return _strip_non_blank(value, "Moment label cannot be empty or whitespace.")

    @model_validator(mode="after")
    def _valid_range(self) -> CreateMomentRequest:
        if self.end <= self.start:
            raise ValueError("Moment end time must be greater than start time.")
        return self


class UpdateMainTrackMetaRequest(BaseModel):
    bpm: float | None = Field(default=None, ge=40.0, le=240.0)
    key: str | None = Field(default=None, max_length=40)

    @field_validator("key")
    @classmethod
    def _non_blank_key(cls, value: str | None) -> str | None:
        return None if value is None else _strip_non_blank(value, "Musical key cannot be empty or whitespace.")


class AddCueRequest(BaseModel):
    label: str = Field(min_length=1, max_length=120)
    time: float = Field(ge=0.0)
    color: str = Field(default="violet", max_length=32)

    @field_validator("label", "color")
    @classmethod
    def _non_blank_str(cls, value: str) -> str:
        return _strip_non_blank(value, "Cue label and color cannot be empty or whitespace.")


class UpdateCueRequest(BaseModel):
    label: str | None = Field(default=None, max_length=120)
    time: float | None = Field(default=None, ge=0.0)
    color: str | None = Field(default=None, max_length=32)

    @field_validator("label", "color")
    @classmethod
    def _non_blank_opt_str(cls, value: str | None) -> str | None:
        return None if value is None else _strip_non_blank(value, "Cue label and color cannot be empty or whitespace.")


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    selection: TimeSelection | None = None
    reference_ids: list[str] = Field(default_factory=list)

    @field_validator("message")
    @classmethod
    def _non_blank_message(cls, value: str) -> str:
        return _strip_non_blank(value, "Chat message cannot be empty or whitespace.")


class VoiceTranscribeResponse(BaseModel):
    text: str

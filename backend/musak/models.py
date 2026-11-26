"""Pydantic v2 models matching docs/API_CONTRACT.md."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator


class Section(BaseModel):
    label: str
    start: float
    end: float
    energy: float = Field(ge=0.0, le=1.0)


class MainTrack(BaseModel):
    id: str
    name: str
    duration: float
    sample_rate: int
    bpm: float
    key: str
    beats: list[float] = Field(default_factory=list)
    sections: list[Section] = Field(default_factory=list)
    stems_status: Literal["none", "processing", "ready", "error"] = "none"
    stems_error: str | None = None
    stems: list[str] = Field(default_factory=list)
    audio_url: str
    rendered_url: str
    stem_urls: dict[str, str] = Field(default_factory=dict)


class MomentPin(BaseModel):
    id: str
    label: str
    start: float
    end: float
    note: str = ""
    source: Literal["user", "gemini"] = "user"


class ReferenceTrack(BaseModel):
    id: str
    title: str
    source_type: Literal["local", "youtube"]
    youtube_url: str | None = None
    youtube_id: str | None = None
    duration: float | None = None
    bpm: float | None = None
    key: str | None = None
    audio_downloaded: bool = False
    stems_status: Literal["none", "processing", "ready", "error"] = "none"
    stems_error: str | None = None
    audio_url: str | None = None
    moments: list[MomentPin] = Field(default_factory=list)


EditOperationType = Literal[
    "stem_gain",
    "filter_sweep",
    "reverb_throw",
    "delay_throw",
    "lofi_eq",
    "bass_boost",
    "borrow_stem",
]


class EditOperation(BaseModel):
    type: EditOperationType
    stems: list[str] | None = None
    start: float | None = None
    end: float | None = None
    snap_to_beat: bool | None = True
    # stem_gain & bass_boost
    gain_db: float | None = None
    fade_ms: float | None = None
    # filter_sweep
    mode: Literal["highpass", "lowpass"] | None = None
    start_hz: float | None = None
    end_hz: float | None = None
    # reverb_throw
    room_size: float | None = None
    wet_level: float | None = None
    # delay_throw
    delay_beats: float | None = None
    feedback: float | None = None
    mix: float | None = None
    # lofi_eq
    low_cut_hz: float | None = None
    high_cut_hz: float | None = None
    drive_db: float | None = None
    # bass_boost
    cutoff_hz: float | None = None
    # borrow_stem
    ref_id: str | None = None
    ref_stem: Literal["vocals", "drums", "bass", "other", "full"] | None = None
    ref_start: float | None = None
    ref_end: float | None = None
    target_start: float | None = None
    target_end: float | None = None
    replace_main_stems: list[str] | None = None
    match_bpm: bool | None = None
    match_key: bool | None = None


class EditBlock(BaseModel):
    id: str
    title: str
    description: str = ""
    start: float
    end: float
    enabled: bool = True
    operations: list[EditOperation] = Field(default_factory=list)
    created_at: str
    source_proposal_id: str | None = None


class EditProposal(BaseModel):
    id: str
    title: str
    summary: str
    style: Literal["imitate", "mashup", "creative"]
    start: float
    end: float
    operations: list[EditOperation] = Field(default_factory=list)
    preview_url: str | None = None
    preview_start: float = 0.0
    preview_end: float = 0.0
    applied: bool = False


class TimeSelection(BaseModel):
    start: float
    end: float


class ChatMessage(BaseModel):
    id: str
    role: Literal["user", "assistant"]
    content: str
    selection: TimeSelection | None = None
    reference_ids: list[str] = Field(default_factory=list)
    proposals: list[EditProposal] = Field(default_factory=list)
    created_at: str


class ProjectState(BaseModel):
    id: str
    name: str
    created_at: str
    updated_at: str
    render_version: int = 0
    main_track: MainTrack | None = None
    references: list[ReferenceTrack] = Field(default_factory=list)
    edits: list[EditBlock] = Field(default_factory=list)
    redo_stack: list[EditBlock] = Field(default_factory=list)
    chat_messages: list[ChatMessage] = Field(default_factory=list)


class ProjectSummary(BaseModel):
    id: str
    name: str
    updated_at: str
    has_main_track: bool
    reference_count: int
    edit_count: int


# --- API Request / Response Schemas ---


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"
    cuda_available: bool
    gpu_name: str | None = None
    ffmpeg_available: bool
    api_key_configured: bool
    model: str


class ApiKeyRequest(BaseModel):
    api_key: str


class ApiKeyStatusResponse(BaseModel):
    api_key_configured: bool


class ProjectListResponse(BaseModel):
    projects: list[ProjectSummary]


class CreateProjectRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)

    @field_validator("name")
    @classmethod
    def _non_blank_name(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Project name cannot be empty or whitespace.")
        return cleaned


class RenameProjectRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)

    @field_validator("name")
    @classmethod
    def _non_blank_name(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Project name cannot be empty or whitespace.")
        return cleaned


class DeleteProjectResponse(BaseModel):
    deleted: bool = True


class ExportRequest(BaseModel):
    format: Literal["wav", "mp3"] = "wav"


class YouTubeReferenceRequest(BaseModel):
    url: str = Field(min_length=1)
    title: str | None = None

    @field_validator("url")
    @classmethod
    def _non_blank_url(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("YouTube URL cannot be blank.")
        return cleaned


class CreateMomentRequest(BaseModel):
    label: str = Field(min_length=1, max_length=120)
    start: float = Field(ge=0.0)
    end: float = Field(ge=0.0)
    note: str = ""

    @field_validator("label")
    @classmethod
    def _non_blank_label(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Moment label cannot be empty or whitespace.")
        return cleaned

    @model_validator(mode="after")
    def _valid_range(self) -> CreateMomentRequest:
        if self.end <= self.start:
            raise ValueError("Moment end time must be greater than start time.")
        return self


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


class PatchEditRequest(BaseModel):
    enabled: bool | None = None


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    selection: TimeSelection | None = None
    reference_ids: list[str] = Field(default_factory=list)

    @field_validator("message")
    @classmethod
    def _non_blank_message(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Chat message cannot be empty or whitespace.")
        return cleaned


class VoiceTranscribeResponse(BaseModel):
    text: str

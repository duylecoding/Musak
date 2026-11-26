"""Pydantic v2 domain models matching docs/API_CONTRACT.md."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class Section(BaseModel):
    label: str
    start: float
    end: float
    energy: float = Field(ge=0.0, le=1.0)


class LyricHook(BaseModel):
    id: str
    text: str
    start: float
    end: float
    kind: Literal["hook", "lyric", "drop"] = "lyric"


class CueMarker(BaseModel):
    id: str
    label: str
    time: float
    color: str = "violet"


class MainTrack(BaseModel):
    id: str
    name: str
    duration: float
    sample_rate: int
    bpm: float
    key: str
    beats: list[float] = Field(default_factory=list)
    sections: list[Section] = Field(default_factory=list)
    lyric_hooks: list[LyricHook] = Field(default_factory=list)
    cues: list[CueMarker] = Field(default_factory=list)
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


class MashupCompatibility(BaseModel):
    score: int = Field(ge=0, le=100)
    rating: Literal["great", "good", "tricky"]
    bpm_diff: float
    semitone_diff: int
    summary: str


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
    compatibility: MashupCompatibility | None = None


EditOperationType = Literal[
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
]


class EditOperation(BaseModel):
    type: EditOperationType
    stems: list[str] | None = None
    start: float | None = None
    end: float | None = None
    snap_to_beat: bool | None = True
    # stem_gain, bass_boost, & fades
    gain_db: float | None = None
    fade_ms: float | None = None
    fade_in_ms: float | None = None
    fade_out_ms: float | None = None
    fade_curve: Literal["in", "out", "both"] | None = None
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
    loop_to_fit: bool | None = None
    # tempo_pitch
    speed_rate: float | None = None
    semitones: float | None = None
    add_reverb: bool | None = None
    reverb_wet: float | None = None
    # add_sfx
    sfx_id: str | None = None
    layer_id: str | None = None
    # repeat_section / beat_repeat
    repeat_count: int | None = None
    division_beats: float | None = None


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
    base_operations: list[EditOperation] = Field(default_factory=list)
    intensity: float = 1.0
    keep_vocals_clear: bool = False
    shift_beats: float = 0.0
    preview_url: str | None = None
    preview_start: float = 0.0
    preview_end: float = 0.0
    applied: bool = False


StemLane = Literal["all", "vocals", "drums", "bass", "other"]


class TimeSelection(BaseModel):
    start: float
    end: float
    lane: StemLane | None = None


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


# Re-export API schemas so `from musak.models import ...` remains backward-compatible.
from musak.schemas import (  # noqa: E402, F401
    AddCueRequest, ApiKeyRequest, ApiKeyStatusResponse, ChatRequest, CreateEditRequest,
    CreateMomentRequest, CreateProjectRequest, DeleteProjectResponse, DuplicateEditRequest,
    ExportRequest, HealthResponse, MashupMode, MashupRequest, PatchEditRequest,
    ProjectListResponse, RenameProjectRequest, SfxItem, SfxListResponse,
    StemDeviceRequest, StemDeviceResponse, TuneProposalRequest, UpdateCueRequest,
    UpdateEditRequest, UpdateMainTrackMetaRequest, VoiceTranscribeResponse,
    WaveformPeaksResponse, YouTubeReferenceRequest,
)

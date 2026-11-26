# Musak Internal API Contract (v0.3)

Base URL: `http://127.0.0.1:8765`
CORS: Allow `http://localhost:5173`, `http://127.0.0.1:5173`, `file://`, and `null` (`allow_credentials=False`, `expose_headers=["Content-Disposition"]`).

## 1. Health & Settings
- `GET /api/health`
  - Returns: `{ status: "ok", cuda_available: boolean, gpu_name: string | null, ffmpeg_available: boolean, api_key_configured: boolean, model: string, stem_device: "auto" | "cuda" | "cpu" }`
- `POST /api/settings/api-key` -> Body `{ api_key: string }` -> `{ api_key_configured: boolean }`
- `DELETE /api/settings/api-key` -> `{ api_key_configured: false }`
- `POST /api/settings/stem-device` -> Body `{ device: "auto" | "cuda" | "cpu" }` -> `{ stem_device: "auto" | "cuda" | "cpu" }`

## 2. Projects (Workspaces)
- `GET /api/projects` -> `{ projects: ProjectSummary[] }`
- `POST /api/projects` -> Body `{ name: string }` (max 120 chars) -> `ProjectState`
- `GET /api/projects/{project_id}` -> `ProjectState`
- `PATCH /api/projects/{project_id}` -> Body `{ name: string }` (max 120 chars) -> `ProjectState`
- `DELETE /api/projects/{project_id}` -> `{ deleted: true }`

### Core Types
```ts
type StemLane = "all" | "vocals" | "drums" | "bass" | "other";

interface TimeSelection {
  start: number;
  end: number;
  lane?: StemLane;
}

interface WaveformPeaksResponse {
  duration: number;
  buckets: number;
  main: number[];
  rendered: number[] | null;
  stems: Record<string, number[]>; // keys: vocals, drums, bass, other
}

interface SfxItem {
  id: string;
  name: string;
  category: "riser" | "impact" | "transition" | "drums";
  description: string;
  default_duration: number;
  bpm_synced: boolean;
  preview_url: string;
}

interface EditOperation {
  type:
    | "stem_gain"
    | "filter_sweep"
    | "reverb_throw"
    | "delay_throw"
    | "lofi_eq"
    | "bass_boost"
    | "borrow_stem"
    | "tempo_pitch"
    | "add_sfx";
  stems?: string[];
  start?: number;
  end?: number;
  snap_to_beat?: boolean;
  gain_db?: number;
  fade_ms?: number;
  mode?: "highpass" | "lowpass";
  start_hz?: number;
  end_hz?: number;
  room_size?: number;
  wet_level?: number;
  delay_beats?: number;
  feedback?: number;
  mix?: number;
  low_cut_hz?: number;
  high_cut_hz?: number;
  drive_db?: number;
  cutoff_hz?: number;
  ref_id?: string;
  ref_stem?: "vocals" | "drums" | "bass" | "other" | "full";
  ref_start?: number;
  ref_end?: number;
  target_start?: number;
  target_end?: number;
  replace_main_stems?: string[];
  match_bpm?: boolean;
  match_key?: boolean;
  speed_rate?: number;
  semitones?: number;
  add_reverb?: boolean;
  reverb_wet?: number;
  // add_sfx
  sfx_id?: string;
  layer_id?: string;
}
```

## 3. Main Track, Peaks & Audio Streaming
- `POST /api/projects/{project_id}/main-track` (multipart `file`) -> auto-starts background Demucs -> `ProjectState`
- `POST /api/projects/{project_id}/main-track/youtube` -> Body `{ url: string, title?: string }` -> auto-starts background Demucs -> `ProjectState`
- `POST /api/projects/{project_id}/main-track/from-reference/{ref_id}` -> promotes ref (reuses stems if ready, else auto-starts Demucs) -> `ProjectState`
- `POST /api/projects/{project_id}/main-track/separate` -> manually triggers/retries background Demucs -> `ProjectState`
- `POST /api/projects/{project_id}/main-track/extract-hooks` -> Gemini extracts clickable lyric/hook cues -> `ProjectState`
- `GET /api/projects/{project_id}/peaks?buckets=400` -> `WaveformPeaksResponse` (fast normalized waveform peaks for multi-lane canvas rendering)
- `GET /api/projects/{project_id}/audio/main` -> audio stream (`Cache-Control: no-store`)
- `GET /api/projects/{project_id}/audio/rendered` -> rendered remix stream (`Cache-Control: no-store`)
- `GET /api/projects/{project_id}/audio/stem/{stem_name}` -> stem audio stream
- `GET /api/projects/{project_id}/audio/preview/{proposal_id}?t=...` -> fast sliced proposal preview stream
- `POST /api/projects/{project_id}/export` -> Body `{ format?: "wav"|"mp3"|"zip", target?: "remix"|"instrumental"|"vocals"|"stems_zip", master_preset?: "off"|"balanced"|"club"|"warm" }`

## 4. Built-In Transition SFX Library
- `GET /api/sfx` -> `{ items: SfxItem[] }`
- `GET /api/sfx/{sfx_id}/preview?bpm=120&duration=4.0` -> stereo 44.1 kHz WAV preview stream

## 5. Reference Shelf & Auto-Mashup
- `POST /api/projects/{project_id}/references/upload` (multipart `file`, optional `title`) -> `ProjectState`
- `POST /api/projects/{project_id}/references/youtube` -> Body `{ url: string, title?: string }` (fast YouTube oEmbed lookup first!) -> `ProjectState`
- `DELETE /api/projects/{project_id}/references/{ref_id}` -> `ProjectState`
- `POST /api/projects/{project_id}/references/{ref_id}/moments` -> `ProjectState`
- `DELETE /api/projects/{project_id}/references/{ref_id}/moments/{moment_id}` -> `ProjectState`
- `POST /api/projects/{project_id}/references/{ref_id}/auto-tag` -> `ProjectState`
- `POST /api/projects/{project_id}/references/{ref_id}/extract-stems` -> `ProjectState`
- `GET /api/projects/{project_id}/references/{ref_id}/audio` -> audio stream
- `POST /api/projects/{project_id}/mashup` -> Body `{ ref_id, mode, start?, end? }` -> `ProjectState`

## 6. Edits, Drag/Resize Updates, Proposal Tuning & History
- `POST /api/projects/{project_id}/edits` -> Body `{ title, description, start, end, operations }` -> `ProjectState`
- `POST /api/projects/{project_id}/edits/apply-proposal/{proposal_id}` -> `ProjectState`
- `POST /api/projects/{project_id}/proposals/{proposal_id}/tune` -> Body `{ intensity?, keep_vocals_clear?, shift_beats? }` -> `ProjectState`
- `PATCH /api/projects/{project_id}/edits/{edit_id}`
  - Body: `{ enabled?: boolean, start?: number, end?: number, title?: string, gain_db?: number }`
  - Allows toggling on/off OR dragging/resizing/re-leveling any block directly on the timeline lanes; updates operation timestamps/gain, re-renders remix, returns `ProjectState`.
- `DELETE /api/projects/{project_id}/edits/{edit_id}` -> `ProjectState`
- `POST /api/projects/{project_id}/undo` -> `ProjectState`
- `POST /api/projects/{project_id}/redo` -> `ProjectState`

## 7. Gemini Producer Chat & Voice Input
- `POST /api/projects/{project_id}/chat`
  - Body: `{ message: string, selection?: TimeSelection | null, reference_ids?: string[] }` (supports `selection.lane`!)
  - Returns: `ProjectState` (with fast <0.3s sliced proposal preview WAVs)
- `POST /api/voice/transcribe` (multipart `file`) -> `{ text: string }`

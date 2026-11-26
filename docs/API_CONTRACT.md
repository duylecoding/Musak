# Musak Internal API Contract (v0.1)

Base URL: `http://127.0.0.1:8765`
CORS: Allow `http://localhost:5173`, `http://127.0.0.1:5173`, and `file://` (Electron renderer).

## 1. Health & Settings
- `GET /api/health`
  - Returns: `{ status: "ok", cuda_available: boolean, gpu_name: string | null, ffmpeg_available: boolean, api_key_configured: boolean, model: string }`
- `POST /api/settings/api-key`
  - Body: `{ api_key: string }` (stored ONLY in backend process memory; never written to disk)
  - Returns: `{ api_key_configured: boolean }`
- `DELETE /api/settings/api-key`
  - Returns: `{ api_key_configured: false }`

## 2. Projects (Workspaces)
- `GET /api/projects` -> `{ projects: ProjectSummary[] }`
  - `ProjectSummary`: `{ id, name, updated_at, has_main_track, reference_count, edit_count }`
- `POST /api/projects` -> Body `{ name: string }` -> returns `ProjectState`
- `GET /api/projects/{project_id}` -> returns `ProjectState`
- `PATCH /api/projects/{project_id}` -> Body `{ name: string }` -> renames project, returns `ProjectState`
- `DELETE /api/projects/{project_id}` -> returns `{ deleted: true }`

### `ProjectState`
```ts
interface Section {
  label: string;
  start: number;
  end: number;
  energy: number;
}

interface MainTrack {
  id: string;
  name: string;
  duration: number;
  sample_rate: number;
  bpm: number;
  key: string;
  beats: number[];
  sections: Section[];
  stems_status: "none" | "processing" | "ready" | "error";
  stems_error: string | null;
  stems: string[];
  audio_url: string;
  rendered_url: string;
  stem_urls: Record<string, string>;
}

interface MomentPin {
  id: string;
  label: string;
  start: number;
  end: number;
  note: string;
  source: "user" | "gemini";
}

interface ReferenceTrack {
  id: string;
  title: string;
  source_type: "local" | "youtube";
  youtube_url: string | null;
  youtube_id: string | null;
  duration: number | null;
  bpm: number | null;
  key: string | null;
  audio_downloaded: boolean;
  stems_status: "none" | "processing" | "ready" | "error";
  stems_error: string | null;
  audio_url: string | null;
  moments: MomentPin[];
}

interface EditOperation {
  type:
    | "stem_gain"
    | "filter_sweep"
    | "reverb_throw"
    | "delay_throw"
    | "lofi_eq"
    | "bass_boost"
    | "borrow_stem";
  stems?: string[];
  start?: number;
  end?: number;
  snap_to_beat?: boolean;
  // stem_gain
  gain_db?: number;
  fade_ms?: number;
  // filter_sweep
  mode?: "highpass" | "lowpass";
  start_hz?: number;
  end_hz?: number;
  // reverb_throw
  room_size?: number;
  wet_level?: number;
  // delay_throw
  delay_beats?: number;
  feedback?: number;
  mix?: number;
  // lofi_eq
  low_cut_hz?: number;
  high_cut_hz?: number;
  drive_db?: number;
  // bass_boost
  cutoff_hz?: number;
  // borrow_stem
  ref_id?: string;
  ref_stem?: "vocals" | "drums" | "bass" | "other" | "full";
  ref_start?: number;
  ref_end?: number;
  target_start?: number;
  target_end?: number;
  replace_main_stems?: string[];
  match_bpm?: boolean;
  match_key?: boolean;
}

interface EditBlock {
  id: string;
  title: string;
  description: string;
  start: number;
  end: number;
  enabled: boolean;
  operations: EditOperation[];
  created_at: string;
}

interface EditProposal {
  id: string;
  title: string;
  summary: string;
  style: "imitate" | "mashup" | "creative";
  start: number;
  end: number;
  operations: EditOperation[];
  preview_url: string | null;
  preview_start: number;
  preview_end: number;
  applied: boolean;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  selection: { start: number; end: number } | null;
  reference_ids: string[];
  proposals: EditProposal[];
  created_at: string;
}

interface ProjectState {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  render_version: number;
  main_track: MainTrack | null;
  references: ReferenceTrack[];
  edits: EditBlock[];
  redo_stack: EditBlock[];
  chat_messages: ChatMessage[];
}
```

## 3. Main Track & Audio Streaming
- `POST /api/projects/{project_id}/main-track` (multipart `file`) -> `ProjectState`
- `POST /api/projects/{project_id}/main-track/youtube` -> Body `{ url: string, title?: string }` -> downloads public YouTube audio via `yt-dlp`, analyzes BPM/key/sections, replaces main track -> `ProjectState`
- `POST /api/projects/{project_id}/main-track/from-reference/{ref_id}` -> promotes a Reference Shelf item to main track (downloads via `yt-dlp` on demand if YouTube and not yet downloaded; reuses stems if already ready) -> `ProjectState`
- `POST /api/projects/{project_id}/main-track/separate` -> starts background Demucs -> `ProjectState`
- `GET /api/projects/{project_id}/audio/main` -> audio file stream
- `GET /api/projects/{project_id}/audio/rendered` -> rendered remix audio stream (falls back to main)
- `GET /api/projects/{project_id}/audio/stem/{stem_name}` -> stem audio stream (`vocals|drums|bass|other`)
- `GET /api/projects/{project_id}/audio/preview/{proposal_id}` -> proposal preview audio stream
- `POST /api/projects/{project_id}/export` -> Body `{ format: "wav" | "mp3" }` -> downloadable audio attachment

## 4. Reference Shelf
- `POST /api/projects/{project_id}/references/upload` (multipart `file`, optional form field `title`) -> `ProjectState`
- `POST /api/projects/{project_id}/references/youtube` -> Body `{ url: string, title?: string }` -> `ProjectState`
- `DELETE /api/projects/{project_id}/references/{ref_id}` -> `ProjectState`
- `POST /api/projects/{project_id}/references/{ref_id}/moments` -> Body `{ label: string, start: number, end: number, note?: string }` -> `ProjectState`
- `DELETE /api/projects/{project_id}/references/{ref_id}/moments/{moment_id}` -> `ProjectState`
- `POST /api/projects/{project_id}/references/{ref_id}/auto-tag` -> Gemini auto-tags standout moments -> `ProjectState`
- `POST /api/projects/{project_id}/references/{ref_id}/extract-stems` -> On-demand `yt-dlp` (if YouTube) + Demucs in background -> `ProjectState`
- `GET /api/projects/{project_id}/references/{ref_id}/audio` -> audio stream if downloaded/local

## 5. Edits & History
- `POST /api/projects/{project_id}/edits` -> Body `{ title, description, start, end, operations }` -> `ProjectState`
- `POST /api/projects/{project_id}/edits/apply-proposal/{proposal_id}` -> `ProjectState`
- `PATCH /api/projects/{project_id}/edits/{edit_id}` -> Body `{ enabled?: boolean }` -> `ProjectState`
- `DELETE /api/projects/{project_id}/edits/{edit_id}` -> `ProjectState`
- `POST /api/projects/{project_id}/undo` -> `ProjectState`
- `POST /api/projects/{project_id}/redo` -> `ProjectState`

## 6. Gemini Producer Chat & Voice Input
- `POST /api/projects/{project_id}/chat`
  - Body: `{ message: string, selection?: { start: number, end: number } | null, reference_ids?: string[] }`
  - Returns: `ProjectState` (with new user & assistant messages + pre-rendered preview WAVs for proposals)
- `POST /api/voice/transcribe` (multipart `file` — `audio/webm`, `audio/ogg`, `audio/wav`, `audio/mp4`)
  - Uses Gemini (`gemini-2.5-flash`) to transcribe spoken user instructions accurately (preserving timestamps like `0:45`, `1:12`, song/track names, and remix terms).
  - Returns: `{ text: string }`

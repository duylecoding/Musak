export type StemDevice = 'auto' | 'cuda' | 'cpu';
export type StemLane = 'all' | 'vocals' | 'drums' | 'bass' | 'other';
export type MashupMode = 'ref_vocals_on_main' | 'main_vocals_on_ref' | 'ref_drums_on_main' | 'smart_auto';
export type ExportFormat = 'wav' | 'mp3' | 'zip';
export type ExportTarget = 'remix' | 'instrumental' | 'vocals' | 'stems_zip';
export type MasterPreset = 'off' | 'balanced' | 'club' | 'warm';

export interface TimeSelection {
  start: number;
  end: number;
  lane?: StemLane;
}

export interface HealthStatus {
  status: string;
  cuda_available: boolean;
  gpu_name: string | null;
  ffmpeg_available: boolean;
  api_key_configured: boolean;
  model: string;
  stem_device?: StemDevice;
}

export interface WaveformPeaksResponse {
  duration: number;
  buckets: number;
  main: number[];
  rendered: number[] | null;
  stems: Record<string, number[]>;
}

export interface SfxItem {
  id: string;
  name: string;
  category: 'riser' | 'impact' | 'transition' | 'drums';
  description: string;
  default_duration: number;
  bpm_synced: boolean;
  preview_url: string;
}

export interface EditUpdatePayload {
  enabled?: boolean;
  start?: number;
  end?: number;
  title?: string;
  gain_db?: number;
}

export interface ProjectSummary {
  id: string;
  name: string;
  updated_at: string;
  has_main_track: boolean;
  reference_count: number;
  edit_count: number;
}

export interface Section {
  label: string;
  start: number;
  end: number;
  energy: number;
}

export interface LyricHook {
  id: string;
  text: string;
  start: number;
  end: number;
  kind: 'hook' | 'lyric' | 'drop';
}

export interface MainTrack {
  id: string;
  name: string;
  duration: number;
  sample_rate: number;
  bpm: number;
  key: string;
  beats: number[];
  sections: Section[];
  lyric_hooks: LyricHook[];
  stems_status: 'none' | 'processing' | 'ready' | 'error';
  stems_error: string | null;
  stems: string[];
  audio_url: string;
  rendered_url: string;
  stem_urls: Record<string, string>;
}

export interface MomentPin {
  id: string;
  label: string;
  start: number;
  end: number;
  note: string;
  source: 'user' | 'gemini';
}

export interface MashupCompatibility {
  score: number;
  rating: 'great' | 'good' | 'tricky';
  bpm_diff: number;
  semitone_diff: number;
  summary: string;
}

export interface ReferenceTrack {
  id: string;
  title: string;
  source_type: 'local' | 'youtube';
  youtube_url: string | null;
  youtube_id: string | null;
  duration: number | null;
  bpm: number | null;
  key: string | null;
  audio_downloaded: boolean;
  stems_status: 'none' | 'processing' | 'ready' | 'error';
  stems_error: string | null;
  audio_url: string | null;
  moments: MomentPin[];
  compatibility: MashupCompatibility | null;
}

export interface ExportOptions {
  format?: ExportFormat;
  target?: ExportTarget;
  master_preset?: MasterPreset;
}

export interface ProposalTunePayload {
  intensity?: number;
  keep_vocals_clear?: boolean;
  shift_beats?: number;
}

export interface EditOperation {
  type:
    | 'stem_gain'
    | 'filter_sweep'
    | 'reverb_throw'
    | 'delay_throw'
    | 'lofi_eq'
    | 'bass_boost'
    | 'borrow_stem'
    | 'tempo_pitch'
    | 'add_sfx';
  stems?: string[];
  start?: number;
  end?: number;
  snap_to_beat?: boolean;
  gain_db?: number;
  fade_ms?: number;
  mode?: 'highpass' | 'lowpass';
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
  ref_stem?: 'vocals' | 'drums' | 'bass' | 'other' | 'full';
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
  sfx_id?: string;
  layer_id?: string;
}

export interface EditBlock {
  id: string;
  title: string;
  description: string;
  start: number;
  end: number;
  enabled: boolean;
  operations: EditOperation[];
  source_proposal_id?: string | null;
  created_at: string;
}

export interface EditProposal {
  id: string;
  title: string;
  summary: string;
  style: 'imitate' | 'mashup' | 'creative';
  start: number;
  end: number;
  operations: EditOperation[];
  base_operations?: EditOperation[];
  intensity?: number;
  keep_vocals_clear?: boolean;
  shift_beats?: number;
  preview_url: string | null;
  preview_start: number;
  preview_end: number;
  applied: boolean;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  selection: TimeSelection | null;
  reference_ids: string[];
  proposals: EditProposal[];
  created_at: string;
}

export interface ProjectState {
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

export interface MusakKeyStatus {
  configured: boolean;
  encryptionAvailable: boolean;
}

export interface MusakKeyActionResult {
  ok: boolean;
  configured: boolean;
  synced?: boolean;
  error?: string;
}

export interface MusakBridge {
  getKeyStatus: () => Promise<MusakKeyStatus>;
  saveApiKey: (apiKey: string) => Promise<MusakKeyActionResult>;
  clearApiKey: () => Promise<MusakKeyActionResult>;
  openExternal: (url: string) => Promise<boolean>;
  getBackendUrl: () => Promise<string>;
  onApiKeySynced?: (cb: () => void) => () => void;
}

declare global {
  interface Window {
    musakBridge?: MusakBridge;
  }
}

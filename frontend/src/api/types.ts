export interface HealthStatus {
  status: string;
  cuda_available: boolean;
  gpu_name: string | null;
  ffmpeg_available: boolean;
  api_key_configured: boolean;
  model: string;
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

export interface MainTrack {
  id: string;
  name: string;
  duration: number;
  sample_rate: number;
  bpm: number;
  key: string;
  beats: number[];
  sections: Section[];
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
}

export interface EditOperation {
  type:
    | 'stem_gain'
    | 'filter_sweep'
    | 'reverb_throw'
    | 'delay_throw'
    | 'lofi_eq'
    | 'bass_boost'
    | 'borrow_stem';
  stems?: string[];
  start?: number;
  end?: number;
  snap_to_beat?: boolean;
  // stem_gain
  gain_db?: number;
  fade_ms?: number;
  // filter_sweep
  mode?: 'highpass' | 'lowpass';
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
  ref_stem?: 'vocals' | 'drums' | 'bass' | 'other' | 'full';
  ref_start?: number;
  ref_end?: number;
  target_start?: number;
  target_end?: number;
  replace_main_stems?: string[];
  match_bpm?: boolean;
  match_key?: boolean;
}

export interface EditBlock {
  id: string;
  title: string;
  description: string;
  start: number;
  end: number;
  enabled: boolean;
  operations: EditOperation[];
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
  preview_url: string | null;
  preview_start: number;
  preview_end: number;
  applied: boolean;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  selection: { start: number; end: number } | null;
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

export interface TimeSelection {
  start: number;
  end: number;
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

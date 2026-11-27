import type { EditBlock, EditProposal } from './editTypes';

export * from './editTypes';

export type StemDevice = 'auto' | 'cuda' | 'cpu';
export type StemLane = 'all' | 'vocals' | 'drums' | 'bass' | 'other';
export type MashupMode = 'ref_vocals_on_main' | 'main_vocals_on_ref' | 'ref_drums_on_main' | 'smart_auto';

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

export interface CueMarker {
  id: string;
  label: string;
  time: number;
  color: string;
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
  cues?: CueMarker[];
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

export interface ReferenceLayerOptions {
  ref: ReferenceTrack;
  stem?: 'vocals' | 'drums' | 'bass' | 'other' | 'full';
  refStart?: number;
  refEnd?: number;
  targetStart?: number;
  replaceMainStems?: string[];
  matchBpm?: boolean;
  matchKey?: boolean;
  loopToFit?: boolean;
  label?: string;
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

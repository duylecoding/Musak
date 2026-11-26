export type ExportFormat = 'wav' | 'mp3' | 'zip';
export type ExportTarget = 'remix' | 'instrumental' | 'vocals' | 'stems_zip';
export type MasterPreset = 'off' | 'balanced' | 'club' | 'warm';

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

export interface EditUpdatePayload {
  enabled?: boolean;
  start?: number;
  end?: number;
  title?: string;
  gain_db?: number;
  fade_in_ms?: number;
  fade_out_ms?: number;
  fade_curve?: 'in' | 'out' | 'both';
  mode?: 'highpass' | 'lowpass';
  start_hz?: number;
  end_hz?: number;
  room_size?: number;
  wet_level?: number;
  delay_beats?: number;
  feedback?: number;
  mix?: number;
  drive_db?: number;
  cutoff_hz?: number;
  low_cut_hz?: number;
  high_cut_hz?: number;
  ref_start?: number;
  ref_end?: number;
  replace_main_stems?: string[];
  match_bpm?: boolean;
  match_key?: boolean;
  loop_to_fit?: boolean;
  division_beats?: number;
  repeat_count?: number;
  depth?: number;
  width?: number;
  chorus_mix?: number;
  apply_to_layers?: boolean;
  musical_key?: string;
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
    | 'add_sfx'
    | 'cut_section'
    | 'repeat_section'
    | 'beat_repeat'
    | 'vinyl_brake'
    | 'sidechain_pump'
    | 'stereo_wash';
  stems?: string[];
  start?: number;
  end?: number;
  snap_to_beat?: boolean;
  gain_db?: number;
  fade_ms?: number;
  fade_in_ms?: number;
  fade_out_ms?: number;
  fade_curve?: 'in' | 'out' | 'both';
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
  loop_to_fit?: boolean;
  speed_rate?: number;
  semitones?: number;
  add_reverb?: boolean;
  reverb_wet?: number;
  sfx_id?: string;
  layer_id?: string;
  repeat_count?: number;
  division_beats?: number;
  depth?: number;
  width?: number;
  chorus_mix?: number;
  apply_to_layers?: boolean;
  musical_key?: string;
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

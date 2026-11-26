import type React from 'react';
import {
  CloudRain,
  Disc,
  Disc3,
  Drum,
  Filter,
  Flame,
  Guitar,
  Mic2,
  Radio,
  Sparkles,
  Waves,
  Zap,
} from 'lucide-react';
import type { EditOperation } from '../../shared/api';
import type { InstrumentStem } from '../../shared/utils/timelineMath';

export interface StemChannelState {
  volume: number;
  muted: boolean;
  solo: boolean;
}

export interface StemLaneConfig {
  id: InstrumentStem;
  label: string;
  shortLabel: string;
  colorVar: string;
  tip: string;
  icon: React.ComponentType<{ className?: string }>;
}

export interface SegmentFxDef {
  id: string;
  label: string;
  tip: string;
  icon: React.ComponentType<{ className?: string }>;
  build: (
    start: number,
    end: number,
    stems: string[] | undefined,
    snapToBeat: boolean
  ) => { title: string; description: string; operations: EditOperation[] };
}

export const STEM_LANES: StemLaneConfig[] = [
  { id: 'vocals', label: 'Vocals', shortLabel: 'Vocals', colorVar: '--lane-vocals', tip: 'Lead singing, rap, and vocal harmonies isolated from the instruments.', icon: Mic2 },
  { id: 'drums', label: 'Drums', shortLabel: 'Drums', colorVar: '--lane-drums', tip: 'Kick, snare, claps, hi-hats, and percussion groove.', icon: Drum },
  { id: 'bass', label: 'Bass', shortLabel: 'Bass', colorVar: '--lane-bass', tip: '808s, sub-bass, and bassline low-end.', icon: Disc },
  { id: 'other', label: 'Melody / Other', shortLabel: 'Melody', colorVar: '--lane-other', tip: 'Synths, chords, guitars, pianos, and melodic textures.', icon: Guitar },
];

export const INITIAL_STEM_CHANNELS: Record<InstrumentStem, StemChannelState> = {
  vocals: { volume: 100, muted: false, solo: false },
  drums: { volume: 100, muted: false, solo: false },
  bass: { volume: 100, muted: false, solo: false },
  other: { volume: 100, muted: false, solo: false },
};

export const VOLUME_STEPS = [-6, -3, 3, 6] as const;

export const AUTO_DUCK_PRESETS: Array<{ id: string; label: string; stems: string[] }> = [
  { id: 'none', label: 'None', stems: [] },
  { id: 'vocals', label: 'Vocals', stems: ['vocals'] },
  { id: 'drums', label: 'Drums', stems: ['drums'] },
  { id: 'instrumental', label: 'Instrumental', stems: ['drums', 'bass', 'other'] },
  { id: 'all', label: 'All', stems: ['vocals', 'drums', 'bass', 'other'] },
];

const fxOp = (
  op: EditOperation,
  start: number,
  end: number,
  stems: string[] | undefined,
  snapToBeat: boolean
): EditOperation => ({ ...op, ...(stems ? { stems } : {}), start, end, snap_to_beat: snapToBeat });

export const SEGMENT_FX_OPTIONS: SegmentFxDef[] = [
  {
    id: 'filter_sweep',
    label: 'High-Pass Rise',
    tip: 'Gradually sweeps frequencies upward like a DJ transition rise.',
    icon: Waves,
    build: (s, e, st, snap) => ({
      title: 'High-Pass Rise',
      description: 'Rising high-pass sweep (120 Hz -> 2.6 kHz).',
      operations: [fxOp({ type: 'filter_sweep', mode: 'highpass', start_hz: 120, end_hz: 2600 }, s, e, st, snap)],
    }),
  },
  {
    id: 'lowpass_underwater',
    label: 'Low-Pass Underwater',
    tip: 'Muffles highs smoothly down to 280 Hz for a submerged vibe.',
    icon: Filter,
    build: (s, e, st, snap) => ({
      title: 'Low-Pass Underwater',
      description: 'Submerged low-pass sweep (6 kHz -> 280 Hz).',
      operations: [fxOp({ type: 'filter_sweep', mode: 'lowpass', start_hz: 6000, end_hz: 280 }, s, e, st, snap)],
    }),
  },
  {
    id: 'filter_open_up',
    label: 'Filter Open Up',
    tip: 'Opens a muffled low-pass filter wide into full bright clarity.',
    icon: Filter,
    build: (s, e, st, snap) => ({
      title: 'Filter Open Up',
      description: 'Opening low-pass sweep (280 Hz -> 14 kHz).',
      operations: [fxOp({ type: 'filter_sweep', mode: 'lowpass', start_hz: 280, end_hz: 14000 }, s, e, st, snap)],
    }),
  },
  {
    id: 'delay_throw',
    label: 'Echo Out',
    tip: 'Adds a beat-synced rhythmic echo trail to this part.',
    icon: Sparkles,
    build: (s, e, st, snap) => ({
      title: 'Echo Out',
      description: 'Beat-synced half-beat delay throw.',
      operations: [fxOp({ type: 'delay_throw', delay_beats: 0.5, feedback: 0.45, mix: 0.45 }, s, e, st, snap)],
    }),
  },
  {
    id: 'reverb_throw',
    label: 'Reverb Wash',
    tip: 'Wraps this segment in a spacious, dreamy hall reverb.',
    icon: CloudRain,
    build: (s, e, st, snap) => ({
      title: 'Reverb Wash',
      description: 'Lush cathedral reverb wash.',
      operations: [fxOp({ type: 'reverb_throw', room_size: 0.85, wet_level: 0.48 }, s, e, st, snap)],
    }),
  },
  {
    id: 'lofi_eq',
    label: 'Lo-Fi',
    tip: 'Warm vintage vinyl/radio EQ tone with gentle grit.',
    icon: Radio,
    build: (s, e, st, snap) => ({
      title: 'Lo-Fi Tone',
      description: 'Warm vintage bandpass EQ with subtle tape grit.',
      operations: [fxOp({ type: 'lofi_eq', low_cut_hz: 300, high_cut_hz: 3400, drive_db: 4 }, s, e, st, snap)],
    }),
  },
  {
    id: 'bass_boost',
    label: 'Bass Boost',
    tip: 'Pumps up the low end by +6 dB for extra punch.',
    icon: Flame,
    build: (s, e, st, snap) => ({
      title: 'Bass Boost',
      description: 'Punchy +6 dB low-end boost.',
      operations: [fxOp({ type: 'bass_boost', gain_db: 6, cutoff_hz: 140 }, s, e, st, snap)],
    }),
  },
];

export const SEGMENT_DJ_MOVES: SegmentFxDef[] = [
  {
    id: 'club_buildup',
    label: 'Club Buildup',
    tip: 'High-pass rise + BPM snare roll + bass cut for an instant drop setup.',
    icon: Flame,
    build: (s, e, st, snap) => ({
      title: 'Club Buildup',
      description: 'High-pass rise, accelerating snare roll, and bass cut.',
      operations: [
        fxOp({ type: 'filter_sweep', mode: 'highpass', start_hz: 120, end_hz: 2600 }, s, e, st, snap),
        { type: 'add_sfx', sfx_id: 'snare_roll', start: s, end: e, gain_db: 0, snap_to_beat: snap },
        { type: 'stem_gain', stems: ['bass'], start: s, end: e, gain_db: -40, fade_ms: 25, snap_to_beat: snap },
      ],
    }),
  },
  {
    id: 'beat_repeat',
    label: 'Beat Stutter (1/4)',
    tip: 'Repeats the opening 1/4 beat across the selection like a CDJ loop.',
    icon: Zap,
    build: (s, e, st, snap) => ({
      title: 'Beat Stutter (1/4)',
      description: 'Rhythmic 1/4-beat DJ stutter.',
      operations: [fxOp({ type: 'beat_repeat', division_beats: 0.25 }, s, e, st, snap)],
    }),
  },
  {
    id: 'vinyl_brake',
    label: 'Real Vinyl Brake',
    tip: 'Slows the audio down to a realistic turntable stop.',
    icon: Disc3,
    build: (s, e, st, snap) => ({
      title: 'Real Vinyl Brake',
      description: 'Turntable power-down pitch & speed brake.',
      operations: [fxOp({ type: 'vinyl_brake' }, s, e, st, snap)],
    }),
  },
  {
    id: 'echo_freeze',
    label: 'Echo Freeze',
    tip: 'Stacks a long rhythmic echo into a cavernous reverb wash.',
    icon: CloudRain,
    build: (s, e, st, snap) => ({
      title: 'Echo Freeze',
      description: 'Long feedback delay frozen into hall reverb.',
      operations: [
        fxOp({ type: 'delay_throw', delay_beats: 0.5, feedback: 0.72, mix: 0.55 }, s, e, st, snap),
        fxOp({ type: 'reverb_throw', room_size: 0.9, wet_level: 0.6 }, s, e, st, snap),
      ],
    }),
  },
];

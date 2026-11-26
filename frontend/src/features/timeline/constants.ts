import type React from 'react';
import { CloudRain, Disc, Drum, Flame, Guitar, Mic2, Radio, Sparkles, Waves } from 'lucide-react';
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
    label: 'Filter Sweep',
    tip: 'Gradually sweeps frequencies upward like a DJ transition rise.',
    icon: Waves,
    build: (s, e, st, snap) => ({
      title: 'Filter Sweep',
      description: 'Rising high-pass sweep (120 Hz -> 2.6 kHz).',
      operations: [fxOp({ type: 'filter_sweep', mode: 'highpass', start_hz: 120, end_hz: 2600 }, s, e, st, snap)],
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

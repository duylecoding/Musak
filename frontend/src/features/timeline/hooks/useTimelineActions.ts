import { useCallback, useState } from 'react';
import type {
  EditOperation,
  MainTrack,
  ProjectState,
  ReferenceLayerOptions,
  SfxItem,
  TimeSelection,
} from '../../../shared/api';
import { computeBarsEnd, type InstrumentStem } from '../../../shared/utils/timelineMath';
import type { AddReferenceLayerFn } from '../../../state/projectContextTypes';
import type { SpeedPitchPayload } from '../components/SpeedPitchPopover';
import { STEM_LANES, type SegmentFxDef, type StemChannelState } from '../constants';
import { effectiveStemGain, getLaneLabel } from '../utils';
import { useTrackSetupActions } from './useTrackSetupActions';

export interface UseTimelineActionsOptions {
  project: ProjectState | null;
  mainTrack: MainTrack | null;
  trackDuration: number;
  beatSnap: boolean;
  selection: TimeSelection | null;
  mainTrackBusy: boolean;
  apiKeyConfigured: boolean;
  stemChannels: Record<InstrumentStem, StemChannelState>;
  isStemPreviewActive: boolean;
  stemsReady: boolean;
  currentTimeRef: React.MutableRefObject<number>;
  onOpenSettings?: () => void;
  onSelectionChange: (sel: TimeSelection | null) => void;
  uploadMainTrack: (file: File) => Promise<void>;
  loadMainFromYoutube: (url: string) => Promise<void>;
  loadMainFromReference: (refId: string) => Promise<void>;
  separateMainStems: () => Promise<void>;
  extractHooks: () => Promise<void>;
  createEdit: (payload: {
    title: string;
    description: string;
    start: number;
    end: number;
    operations: EditOperation[];
  }) => Promise<void>;
  addSfxLayer: (sfx: SfxItem, startTime?: number) => Promise<void>;
  addReferenceLayer: AddReferenceLayerFn;
  resetStemChannels: () => void;
}

export function useTimelineActions(opts: UseTimelineActionsOptions) {
  const setup = useTrackSetupActions(opts);
  const [applyingSpeedPitch, setApplyingSpeedPitch] = useState(false);
  const [bakingMix, setBakingMix] = useState(false);
  const [busySegment, setBusySegment] = useState(false);
  const [busyLayerAdd, setBusyLayerAdd] = useState(false);

  const handleApplySpeedPitch = useCallback(async ({ speedRate, semitones, addReverb, reverbWet, lane }: SpeedPitchPayload) => {
    if (!opts.mainTrack || applyingSpeedPitch) return;
    const isWhole = !opts.selection;
    const start = opts.selection ? opts.selection.start : 0;
    const end = opts.selection ? opts.selection.end : Math.max(0.5, opts.trackDuration);
    const targetStems = opts.stemsReady && lane !== 'all' ? [lane] : undefined;
    const wet = addReverb ? reverbWet : 0;
    const parts: string[] = [];
    if (Math.abs(speedRate - 1) > 0.005) parts.push(`${speedRate.toFixed(2)}x speed`);
    if (Math.abs(semitones) > 0.05) parts.push(`${semitones > 0 ? '+' : ''}${semitones} st pitch`);
    if (wet > 0) parts.push(`${Math.round(wet * 100)}% reverb`);
    const baseTitle = speedRate <= 0.9 && wet > 0 ? 'Slowed + Reverb'
      : speedRate >= 1.12 ? `Sped Up ${speedRate.toFixed(2)}x`
      : semitones <= -2 && Math.abs(speedRate - 1) < 0.02 ? 'Deep Pitch' : 'Speed & Pitch';
    setApplyingSpeedPitch(true);
    try {
      await opts.createEdit({
        title: targetStems ? `${baseTitle} (${getLaneLabel(lane)})` : baseTitle,
        description: parts.length > 0 ? `Applied ${parts.join(', ')}` : 'Adjusted speed & pitch',
        start, end,
        operations: [{
          type: 'tempo_pitch',
          ...(targetStems ? { stems: targetStems } : {}),
          start, end,
          snap_to_beat: isWhole ? false : opts.beatSnap,
          speed_rate: speedRate,
          semitones,
          add_reverb: wet > 0,
          reverb_wet: wet,
        }],
      });
    } finally { setApplyingSpeedPitch(false); }
  }, [applyingSpeedPitch, opts]);

  const handleBakeStemPreview = useCallback(async () => {
    if (!opts.mainTrack || bakingMix || !opts.isStemPreviewActive) return;
    const start = opts.selection ? opts.selection.start : 0;
    const end = opts.selection ? opts.selection.end : Math.max(0.5, opts.trackDuration);
    const ops: EditOperation[] = [];
    const summary: string[] = [];
    for (const lane of STEM_LANES) {
      const g = effectiveStemGain(lane.id, opts.stemChannels);
      if (Math.abs(g - 1) <= 0.02) continue;
      const gainDb = g <= 0.001 ? -80 : Number((20 * Math.log10(g)).toFixed(1));
      ops.push({ type: 'stem_gain', stems: [lane.id], start, end, gain_db: gainDb, fade_ms: 25 });
      summary.push(g <= 0.001 ? `${lane.shortLabel} muted` : `${lane.shortLabel} ${gainDb > 0 ? `+${gainDb}` : gainDb} dB`);
    }
    if (ops.length === 0) return;
    setBakingMix(true);
    try {
      await opts.createEdit({ title: 'Custom Stem Mix', description: `Applied stem balance (${summary.join(', ')})`, start, end, operations: ops });
      opts.resetStemChannels();
    } finally { setBakingMix(false); }
  }, [bakingMix, opts]);

  const handleSetBars = useCallback((bars: number) => {
    if (!opts.selection || !opts.mainTrack) return;
    const end = computeBarsEnd(opts.selection.start, bars, opts.mainTrack.bpm, opts.trackDuration, opts.mainTrack.beats, opts.beatSnap);
    if (end > opts.selection.start + 0.2) opts.onSelectionChange({ ...opts.selection, end });
  }, [opts]);

  const handleSegmentVolume = useCallback(async (gainDb: number) => {
    if (!opts.selection || !opts.mainTrack || busySegment) return;
    const lane = opts.selection.lane ?? 'all';
    const stems = lane === 'all' ? ['vocals', 'drums', 'bass', 'other'] : [lane];
    const laneTitle = getLaneLabel(lane);
    setBusySegment(true);
    try {
      await opts.createEdit({
        title: gainDb <= -40 ? `Mute ${laneTitle}` : `${laneTitle} ${gainDb > 0 ? `+${gainDb}` : gainDb} dB`,
        description: gainDb <= -40 ? `Cuts ${laneTitle.toLowerCase()} cleanly during this moment.` : `Adjusts ${laneTitle.toLowerCase()} level by ${gainDb > 0 ? `+${gainDb}` : gainDb} dB.`,
        start: opts.selection.start, end: opts.selection.end,
        operations: [{ type: 'stem_gain', stems, gain_db: gainDb, fade_ms: 25, start: opts.selection.start, end: opts.selection.end, snap_to_beat: opts.beatSnap }],
      });
    } finally { setBusySegment(false); }
  }, [busySegment, opts]);

  const handleSegmentFade = useCallback(async (curve: 'in' | 'out') => {
    if (!opts.selection || !opts.mainTrack || busySegment) return;
    const lane = opts.selection.lane ?? 'all';
    const stems = lane === 'all' ? ['vocals', 'drums', 'bass', 'other'] : [lane];
    const label = curve === 'in' ? 'Fade In' : 'Fade Out';
    setBusySegment(true);
    try {
      await opts.createEdit({
        title: lane === 'all' ? label : `${label} (${getLaneLabel(lane)})`,
        description: `Smooth ${curve === 'in' ? 'fade-in' : 'fade-out'} envelope across this segment.`,
        start: opts.selection.start, end: opts.selection.end,
        operations: [{ type: 'stem_gain', stems, gain_db: 0, fade_curve: curve, start: opts.selection.start, end: opts.selection.end, snap_to_beat: opts.beatSnap }],
      });
    } finally { setBusySegment(false); }
  }, [busySegment, opts]);

  const handleCutSection = useCallback(async () => {
    if (!opts.selection || !opts.mainTrack || busySegment) return;
    setBusySegment(true);
    try {
      await opts.createEdit({
        title: 'Cut Section',
        description: 'Cleanly splices out this highlighted section with a 25ms crossfade.',
        start: opts.selection.start, end: opts.selection.end,
        operations: [{ type: 'cut_section', start: opts.selection.start, end: opts.selection.end, snap_to_beat: opts.beatSnap }],
      });
    } finally { setBusySegment(false); }
  }, [busySegment, opts]);

  const handleRepeatSection = useCallback(async (repeatCount = 2) => {
    if (!opts.selection || !opts.mainTrack || busySegment) return;
    setBusySegment(true);
    try {
      await opts.createEdit({
        title: `Repeat ×${repeatCount}`,
        description: `Loops this highlighted section ${repeatCount} times seamlessly.`,
        start: opts.selection.start, end: opts.selection.end,
        operations: [{ type: 'repeat_section', repeat_count: repeatCount, start: opts.selection.start, end: opts.selection.end, snap_to_beat: opts.beatSnap }],
      });
    } finally { setBusySegment(false); }
  }, [busySegment, opts]);

  const handleSegmentFx = useCallback(async (fx: SegmentFxDef) => {
    if (!opts.selection || !opts.mainTrack || busySegment) return;
    const lane = opts.selection.lane ?? 'all';
    const targetStems = opts.stemsReady && lane !== 'all' ? [lane] : undefined;
    const built = fx.build(opts.selection.start, opts.selection.end, targetStems, opts.beatSnap);
    setBusySegment(true);
    try {
      await opts.createEdit({
        title: `${built.title}${targetStems ? ` (${getLaneLabel(lane)})` : ''}`,
        description: built.description, start: opts.selection.start, end: opts.selection.end, operations: built.operations,
      });
    } finally { setBusySegment(false); }
  }, [busySegment, opts]);

  const handleDropSfx = useCallback(async (sfx: SfxItem) => {
    if (busyLayerAdd) return;
    setBusyLayerAdd(true);
    try { await opts.addSfxLayer(sfx, opts.selection ? opts.selection.start : opts.currentTimeRef.current); }
    finally { setBusyLayerAdd(false); }
  }, [busyLayerAdd, opts]);

  const handleDropReference = useCallback(async (options: ReferenceLayerOptions) => {
    if (busyLayerAdd) return;
    setBusyLayerAdd(true);
    try {
      await opts.addReferenceLayer({
        ...options,
        targetStart: options.targetStart ?? (opts.selection ? opts.selection.start : opts.currentTimeRef.current),
      });
    } finally { setBusyLayerAdd(false); }
  }, [busyLayerAdd, opts]);

  return {
    ...setup, applyingSpeedPitch, bakingMix, busySegment, busyLayerAdd,
    handleApplySpeedPitch, handleBakeStemPreview, handleSetBars,
    handleSegmentVolume, handleSegmentFade, handleCutSection, handleRepeatSection,
    handleSegmentFx, handleDropSfx, handleDropReference,
  };
}

import { useCallback, useState } from 'react';
import {
  type EditOperation,
  type MainTrack,
  type ProjectState,
  type ReferenceTrack,
  type SfxItem,
  type TimeSelection,
} from '../../../shared/api';
import {
  computeBarsEnd,
  type InstrumentStem,
} from '../../../shared/utils/timelineMath';
import { STEM_LANES, type SegmentFxDef, type StemChannelState } from '../constants';
import { effectiveStemGain, getLaneLabel } from '../utils';
import type { SpeedPitchPayload } from '../components/SpeedPitchPopover';

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
  addReferenceLayer: (
    ref: ReferenceTrack,
    stem?: 'vocals' | 'drums' | 'bass' | 'other' | 'full',
    startTime?: number
  ) => Promise<void>;
  resetStemChannels: () => void;
}

export function useTimelineActions(opts: UseTimelineActionsOptions) {
  const [uploading, setUploading] = useState(false);
  const [loadingYoutube, setLoadingYoutube] = useState(false);
  const [promotingRefId, setPromotingRefId] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [startingStems, setStartingStems] = useState(false);
  const [extractingHooks, setExtractingHooks] = useState(false);
  const [applyingSpeedPitch, setApplyingSpeedPitch] = useState(false);
  const [bakingMix, setBakingMix] = useState(false);
  const [busySegment, setBusySegment] = useState(false);
  const [busyLayerAdd, setBusyLayerAdd] = useState(false);

  const anyMainBusy = opts.mainTrackBusy || uploading || loadingYoutube || Boolean(promotingRefId);

  const handleFileSelected = useCallback(async (file: File | undefined) => {
    if (!file || !opts.project || anyMainBusy) return;
    setUploadError(null);
    setUploading(true);
    try { await opts.uploadMainTrack(file); }
    catch (err) { setUploadError(err instanceof Error ? err.message : 'Failed to upload main track.'); }
    finally { setUploading(false); }
  }, [anyMainBusy, opts]);

  const handleYoutubeMainSubmit = useCallback(async (url: string) => {
    if (!url.trim() || !opts.project || anyMainBusy) return;
    setUploadError(null);
    setLoadingYoutube(true);
    try { await opts.loadMainFromYoutube(url.trim()); }
    catch (err) { setUploadError(err instanceof Error ? err.message : 'Failed to load audio from YouTube URL.'); throw err; }
    finally { setLoadingYoutube(false); }
  }, [anyMainBusy, opts]);

  const handlePromoteReference = useCallback(async (refId: string) => {
    if (!opts.project || anyMainBusy) return;
    setUploadError(null);
    setPromotingRefId(refId);
    try { await opts.loadMainFromReference(refId); }
    catch (err) { setUploadError(err instanceof Error ? err.message : 'Failed to load reference as main track.'); }
    finally { setPromotingRefId(null); }
  }, [anyMainBusy, opts]);

  const handleSeparateStems = useCallback(async () => {
    if (!opts.mainTrack || opts.mainTrack.stems_status === 'processing' || startingStems) return;
    setStartingStems(true);
    try { await opts.separateMainStems(); } finally { setStartingStems(false); }
  }, [opts, startingStems]);

  const handleExtractHooks = useCallback(async () => {
    if (!opts.mainTrack || extractingHooks) return;
    if (!opts.apiKeyConfigured) { opts.onOpenSettings?.(); return; }
    setExtractingHooks(true);
    try { await opts.extractHooks(); } finally { setExtractingHooks(false); }
  }, [extractingHooks, opts]);

  const handleApplySpeedPitch = useCallback(async ({ speedRate, semitones, addReverb }: SpeedPitchPayload) => {
    if (!opts.mainTrack || applyingSpeedPitch) return;
    const isWhole = !opts.selection;
    const start = opts.selection ? opts.selection.start : 0;
    const end = opts.selection ? opts.selection.end : Math.max(0.5, opts.trackDuration);
    const parts: string[] = [];
    if (Math.abs(speedRate - 1) > 0.005) parts.push(`${speedRate.toFixed(2)}x speed`);
    if (Math.abs(semitones) > 0.05) parts.push(`${semitones > 0 ? '+' : ''}${semitones} st pitch`);
    if (addReverb) parts.push('lush reverb');
    const title = speedRate <= 0.9 && addReverb ? 'Slowed + Reverb'
      : speedRate >= 1.12 ? `Sped Up ${speedRate.toFixed(2)}x`
      : semitones <= -2 && Math.abs(speedRate - 1) < 0.02 ? 'Deep Pitch' : 'Speed & Pitch';
    setApplyingSpeedPitch(true);
    try {
      await opts.createEdit({
        title,
        description: parts.length > 0 ? `Applied ${parts.join(', ')}` : 'Adjusted speed & pitch',
        start, end,
        operations: [{ type: 'tempo_pitch', start, end, snap_to_beat: isWhole ? false : opts.beatSnap, speed_rate: speedRate, semitones, add_reverb: addReverb, reverb_wet: addReverb ? 0.42 : 0 }],
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

  const handleDropReference = useCallback(async (ref: ReferenceTrack, stem: 'vocals' | 'drums' | 'bass' | 'other' | 'full') => {
    if (busyLayerAdd) return;
    setBusyLayerAdd(true);
    try { await opts.addReferenceLayer(ref, stem, opts.selection ? opts.selection.start : opts.currentTimeRef.current); }
    finally { setBusyLayerAdd(false); }
  }, [busyLayerAdd, opts]);

  return {
    uploading, loadingYoutube, promotingRefId, uploadError, setUploadError,
    startingStems, extractingHooks, applyingSpeedPitch, bakingMix, busySegment, busyLayerAdd, anyMainBusy,
    handleFileSelected, handleYoutubeMainSubmit, handlePromoteReference, handleSeparateStems,
    handleExtractHooks, handleApplySpeedPitch, handleBakeStemPreview, handleSetBars,
    handleSegmentVolume, handleSegmentFx, handleDropSfx, handleDropReference,
  };
}

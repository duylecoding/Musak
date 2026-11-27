import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { getEngineManifest, type ProjectState, type TimeSelection } from '../../../shared/api';
import {
  nativeLoadManifest,
  nativePause,
  nativePlay,
  nativeSeek,
  nativeSetStemMixer,
  nativeSyncTimeline,
  nativeTransportState,
} from '../../../shared/audio/nativeEngine';
import { formatTime } from '../../../shared/utils/format';
import type { InstrumentStem } from '../../../shared/utils/timelineMath';
import type { StemChannelState } from '../constants';
import { createInitialStemChannels } from '../utils';
import { isEditableElement } from './useStemAudio';

export interface UseNativePlaybackOptions {
  enabled: boolean;
  project: ProjectState | null;
  abMode: 'original' | 'remix';
  selection: TimeSelection | null;
  trackDuration: number;
  playheadRef: React.MutableRefObject<number>;
  playheadLineRef: React.RefObject<HTMLDivElement>;
  playheadDiamondRef: React.RefObject<HTMLDivElement>;
  timecodeRef?: React.RefObject<HTMLSpanElement>;
}

/** Build a stable signature for only the borrow/SFX clip sources (ignoring drag start/end moves). */
function clipSourceSignature(project: ProjectState | null): string {
  if (!project) return '';
  const parts: string[] = [];
  for (const edit of project.edits) {
    edit.operations.forEach((op, idx) => {
      if (op.type === 'borrow_stem') {
        parts.push(
          `${edit.id}:${idx}:b:${op.ref_id}:${op.ref_stem}:${op.ref_start}:${op.ref_end}:${op.match_bpm}:${op.match_key}`
        );
      } else if (op.type === 'add_sfx') {
        const dur = ((op.end ?? edit.end) - (op.start ?? edit.start)).toFixed(2);
        parts.push(`${edit.id}:${idx}:s:${op.sfx_id}:${dur}:${op.musical_key ?? ''}`);
      }
    });
  }
  return parts.join('|');
}

export function useNativePlayback({
  enabled,
  project,
  abMode,
  selection,
  trackDuration,
  playheadRef,
  playheadLineRef,
  playheadDiamondRef,
  timecodeRef,
}: UseNativePlaybackOptions) {
  const mainTrack = project?.main_track ?? null;
  const stemsReady = mainTrack?.stems_status === 'ready';
  const [isPlaying, setIsPlaying] = useState(false);
  const [loopSelection, setLoopSelection] = useState(false);
  const [displayTime, setDisplayTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [loadingAudio, setLoadingAudio] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [stemChannels, setStemChannels] = useState<Record<InstrumentStem, StemChannelState>>(
    createInitialStemChannels
  );

  const currentTimeRef = useRef(0);
  const isPlayingRef = useRef(false);
  const durationRef = useRef(trackDuration);
  const selectionRef = useRef(selection);
  const stemChannelsRef = useRef(stemChannels);
  const abModeRef = useRef(abMode);
  const editsRef = useRef(project?.edits ?? []);
  const loadedKeyRef = useRef<string | null>(null);

  durationRef.current = trackDuration || audioDuration;
  selectionRef.current = selection;
  stemChannelsRef.current = stemChannels;
  abModeRef.current = abMode;
  editsRef.current = project?.edits ?? [];

  const isStemPreviewActive = useMemo(
    () => stemsReady && Object.values(stemChannels).some((c) => c.muted || c.solo || c.volume !== 100),
    [stemsReady, stemChannels]
  );

  const updatePlayheadVisual = useCallback(
    (t: number) => {
      currentTimeRef.current = t;
      playheadRef.current = t;
      if (timecodeRef?.current) timecodeRef.current.textContent = formatTime(t);
      const dur = durationRef.current;
      if (dur <= 0) return;
      const pct = `${Math.max(0, Math.min(100, (t / dur) * 100))}%`;
      if (playheadLineRef.current) playheadLineRef.current.style.left = pct;
      if (playheadDiamondRef.current) playheadDiamondRef.current.style.left = pct;
    },
    [playheadDiamondRef, playheadLineRef, playheadRef, timecodeRef]
  );

  const clipsSig = useMemo(() => clipSourceSignature(project), [project]);
  const manifestKey =
    enabled && project?.id && mainTrack?.id
      ? `${project.id}|${mainTrack.id}|${mainTrack.stems_status}|${mainTrack.bpm}|${mainTrack.key}|${clipsSig}`
      : null;

  // Reset UI playhead when switching projects/tracks
  useEffect(() => {
    if (!enabled) return;
    setStemChannels(createInitialStemChannels());
    updatePlayheadVisual(0);
    setDisplayTime(0);
    setAudioDuration(0);
    setAudioError(null);
    setIsPlaying(false);
    isPlayingRef.current = false;
    void nativePause().catch(() => {});
  }, [enabled, project?.id, mainTrack?.id, updatePlayheadVisual]);

  // Load WAV buffers into Rust only when track, stems, or clip sources change (NOT on clip drag!)
  useEffect(() => {
    if (!enabled || !manifestKey || !project?.id || loadedKeyRef.current === manifestKey) return;
    let cancelled = false;
    setLoadingAudio(true);
    setAudioError(null);
    getEngineManifest(project.id)
      .then((manifest) =>
        nativeLoadManifest(manifest, editsRef.current, abModeRef.current, stemChannelsRef.current)
      )
      .then((state) => {
        if (cancelled) return;
        loadedKeyRef.current = manifestKey;
        setLoadingAudio(false);
        if (state.duration > 0) setAudioDuration(state.duration);
        isPlayingRef.current = state.playing;
        setIsPlaying(state.playing);
        updatePlayheadVisual(state.current_time);
        setDisplayTime(state.current_time);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadingAudio(false);
        setAudioError(err instanceof Error ? err.message : 'Native audio engine failed to load.');
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, manifestKey, project?.id, updatePlayheadVisual]);

  // Instant (<0.1ms) lock-free snapshot hot-swap on edit drag, mute/solo, A/B flip, or loop change
  useEffect(() => {
    if (!enabled || !project?.main_track) return;
    const loopRange: [number, number] | null =
      loopSelection && selection && selection.end > selection.start
        ? [selection.start, selection.end]
        : null;
    void nativeSyncTimeline(project.edits, abMode, stemChannels, loopRange).catch(() => {});
  }, [enabled, project?.main_track, project?.edits, abMode, stemChannels, loopSelection, selection]);

  // 60fps zero-re-render playhead polling from Rust's AtomicU64 sample cursor
  useEffect(() => {
    if (!enabled || !isPlaying) return;
    let rafId = 0;
    let inFlight = false;
    const tick = () => {
      if (!isPlayingRef.current) return;
      if (!inFlight) {
        inFlight = true;
        nativeTransportState()
          .then((st) => {
            inFlight = false;
            if (!st.playing && isPlayingRef.current) {
              isPlayingRef.current = false;
              setIsPlaying(false);
              setDisplayTime(st.current_time);
            }
            updatePlayheadVisual(st.current_time);
          })
          .catch(() => {
            inFlight = false;
          });
      }
      rafId = window.requestAnimationFrame(tick);
    };
    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [enabled, isPlaying, updatePlayheadVisual]);

  const seekToTime = useCallback(
    (rawTime: number) => {
      const dur = durationRef.current;
      const clamped = Math.max(0, dur > 0 ? Math.min(rawTime, dur - 0.02) : rawTime);
      updatePlayheadVisual(clamped);
      setDisplayTime(clamped);
      if (enabled) void nativeSeek(clamped).catch(() => {});
    },
    [enabled, updatePlayheadVisual]
  );

  const handlePlayPause = useCallback(() => {
    if (!enabled || !mainTrack) return;
    if (isPlayingRef.current) {
      isPlayingRef.current = false;
      setIsPlaying(false);
      setDisplayTime(currentTimeRef.current);
      void nativePause().catch(() => {});
      return;
    }
    const sel = selectionRef.current;
    const cur = currentTimeRef.current;
    const startAt = sel && (cur < sel.start || cur >= sel.end) ? sel.start : cur;
    updatePlayheadVisual(startAt);
    isPlayingRef.current = true;
    setIsPlaying(true);
    void nativePlay(startAt).catch(() => {
      isPlayingRef.current = false;
      setIsPlaying(false);
    });
  }, [enabled, mainTrack, updatePlayheadVisual]);

  const handleStop = useCallback(() => {
    if (!enabled) return;
    isPlayingRef.current = false;
    setIsPlaying(false);
    const target = selectionRef.current ? selectionRef.current.start : 0;
    void nativePause().catch(() => {});
    seekToTime(target);
  }, [enabled, seekToTime]);

  const updateStemChannel = useCallback(
    (stem: InstrumentStem, patch: Partial<StemChannelState>) => {
      setStemChannels((prev) => {
        const next = { ...prev, [stem]: { ...prev[stem], ...patch } };
        if (enabled) void nativeSetStemMixer(next).catch(() => {});
        return next;
      });
    },
    [enabled]
  );

  const resetStemChannels = useCallback(() => {
    const fresh = createInitialStemChannels();
    setStemChannels(fresh);
    if (enabled) void nativeSetStemMixer(fresh).catch(() => {});
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !mainTrack || isEditableElement(e.target)) return;
      e.preventDefault();
      handlePlayPause();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled, mainTrack, handlePlayPause]);

  return {
    isPlaying,
    loopSelection,
    setLoopSelection,
    displayTime,
    audioDuration,
    loadingAudio,
    audioError,
    setAudioError,
    stemChannels,
    isStemPreviewActive,
    currentTimeRef,
    seekToTime,
    handlePlayPause,
    handleStop,
    updateStemChannel,
    resetStemChannels,
  };
}

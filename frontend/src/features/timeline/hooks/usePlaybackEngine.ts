import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { getMainAudioUrl, getRenderedAudioUrl, type ProjectState, type TimeSelection } from '../../../shared/api';
import { disposeAudioElement, getActiveStemTime, isEditableElement, useStemAudio, waitForMetadata } from './useStemAudio';

export interface UsePlaybackEngineOptions {
  project: ProjectState | null;
  abMode: 'original' | 'remix';
  selection: TimeSelection | null;
  trackDuration: number;
  playheadRef: React.MutableRefObject<number>;
  playheadLineRef: React.RefObject<HTMLDivElement>;
  playheadDiamondRef: React.RefObject<HTMLDivElement>;
}

export function usePlaybackEngine({
  project, abMode, selection, trackDuration, playheadRef, playheadLineRef, playheadDiamondRef,
}: UsePlaybackEngineOptions) {
  const mainTrack = project?.main_track ?? null;
  const stemsReady = mainTrack?.stems_status === 'ready';
  const [isPlaying, setIsPlaying] = useState(false);
  const [loopSelection, setLoopSelection] = useState(false);
  const [displayTime, setDisplayTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [loadingAudio, setLoadingAudio] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);

  const mixAudioRef = useRef<HTMLAudioElement | null>(null);
  const loadedMixUrlRef = useRef<string | null>(null);
  const currentTimeRef = useRef(0);
  const isPlayingRef = useRef(false);
  const selectionRef = useRef(selection);
  const loopSelectionRef = useRef(loopSelection);
  const durationRef = useRef(trackDuration);
  const pendingRestoreRef = useRef<{ time: number; shouldPlay: boolean } | null>(null);
  const stemSessionRef = useRef(0);
  const isStemPreviewRef = useRef(false);

  selectionRef.current = selection;
  loopSelectionRef.current = loopSelection;
  durationRef.current = trackDuration;

  const stopFromEnded = useCallback(() => { isPlayingRef.current = false; setIsPlaying(false); }, []);
  const stems = useStemAudio(project, stemsReady, isStemPreviewRef, stopFromEnded);

  const isStemPreviewActive = useMemo(
    () => stemsReady && Object.values(stems.stemChannels).some((c) => c.muted || c.solo || c.volume !== 100),
    [stemsReady, stems.stemChannels]
  );
  const prevStemPreviewRef = useRef(isStemPreviewActive);
  isStemPreviewRef.current = isStemPreviewActive;

  const activeAudioUrl = useMemo(() => {
    if (!project || !project.main_track) return null;
    return abMode === 'original' ? getMainAudioUrl(project) : getRenderedAudioUrl(project);
  }, [project, abMode]);

  const updatePlayheadVisual = useCallback((t: number) => {
    currentTimeRef.current = t;
    playheadRef.current = t;
    if (durationRef.current <= 0) return;
    const pct = `${Math.max(0, Math.min(100, (t / durationRef.current) * 100))}%`;
    if (playheadLineRef.current) playheadLineRef.current.style.left = pct;
    if (playheadDiamondRef.current) playheadDiamondRef.current.style.left = pct;
  }, [playheadRef, playheadLineRef, playheadDiamondRef]);

  const teardownMixAudio = useCallback(() => {
    disposeAudioElement(mixAudioRef.current);
    mixAudioRef.current = null;
    loadedMixUrlRef.current = null;
  }, []);

  useEffect(() => {
    stems.resetStemChannels();
    updatePlayheadVisual(0);
    setDisplayTime(0);
    setAudioDuration(0);
    setAudioError(null);
  }, [project?.id, mainTrack?.id, stems.resetStemChannels, updatePlayheadVisual]);

  useEffect(() => {
    teardownMixAudio();
    stems.teardownStemAudio();
    stopFromEnded();
    if (!project || !mainTrack) return;

    const audio = new Audio();
    audio.preload = 'auto';
    mixAudioRef.current = audio;

    const onLoadedMeta = () => {
      setLoadingAudio(false);
      setAudioError(null);
      if (Number.isFinite(audio.duration) && audio.duration > 0) setAudioDuration(audio.duration);
      const restore = pendingRestoreRef.current;
      pendingRestoreRef.current = null;
      if (!restore) return;
      const clamped = Math.max(0, Math.min(restore.time, Math.max(0, (audio.duration || durationRef.current) - 0.05)));
      try { audio.currentTime = clamped; } catch { /* ignore */ }
      updatePlayheadVisual(clamped);
      setDisplayTime(clamped);
      if (restore.shouldPlay && !isStemPreviewRef.current) {
        audio.play().then(() => { isPlayingRef.current = true; setIsPlaying(true); }).catch(stopFromEnded);
      }
    };
    const onError = () => { if (loadedMixUrlRef.current) { setLoadingAudio(false); setAudioError('Could not stream audio from backend.'); stopFromEnded(); } };
    const onEnded = () => { if (!isStemPreviewRef.current) stopFromEnded(); };

    audio.addEventListener('loadedmetadata', onLoadedMeta);
    audio.addEventListener('error', onError);
    audio.addEventListener('ended', onEnded);
    return () => {
      audio.removeEventListener('loadedmetadata', onLoadedMeta);
      audio.removeEventListener('error', onError);
      audio.removeEventListener('ended', onEnded);
      teardownMixAudio();
      stems.teardownStemAudio();
    };
  }, [project?.id, mainTrack?.id, stopFromEnded, stems.teardownStemAudio, teardownMixAudio, updatePlayheadVisual]);

  useEffect(() => {
    const audio = mixAudioRef.current;
    if (!audio || !activeAudioUrl || loadedMixUrlRef.current === activeAudioUrl) return;
    pendingRestoreRef.current = loadedMixUrlRef.current
      ? { time: currentTimeRef.current, shouldPlay: isPlayingRef.current && !isStemPreviewRef.current }
      : null;
    if (pendingRestoreRef.current && !isStemPreviewRef.current) audio.pause();
    loadedMixUrlRef.current = activeAudioUrl;
    setLoadingAudio(true);
    setAudioError(null);
    audio.src = activeAudioUrl;
    audio.load();
  }, [activeAudioUrl]);

  const seekToTime = useCallback((rawTime: number) => {
    const dur = durationRef.current;
    const clamped = Math.max(0, dur > 0 ? Math.min(rawTime, dur - 0.02) : rawTime);
    updatePlayheadVisual(clamped);
    setDisplayTime(clamped);
    for (const a of [mixAudioRef.current, ...Object.values(stems.stemAudiosRef.current)]) {
      if (a && a.readyState >= 1) { try { a.currentTime = clamped; } catch { /* ignore */ } }
    }
  }, [stems.stemAudiosRef, updatePlayheadVisual]);

  const pausePlayback = useCallback(() => {
    stemSessionRef.current += 1;
    mixAudioRef.current?.pause();
    Object.values(stems.stemAudiosRef.current).forEach((a) => a?.pause());
    stopFromEnded();
  }, [stems.stemAudiosRef, stopFromEnded]);

  const startPlayback = useCallback(async (startAt?: number) => {
    const t = startAt ?? currentTimeRef.current;
    if (startAt !== undefined) { updatePlayheadVisual(t); setDisplayTime(t); }
    const stemEls = Object.values(stems.stemAudiosRef.current).filter((a): a is HTMLAudioElement => Boolean(a));
    if (isStemPreviewRef.current && stemEls.length > 0) {
      mixAudioRef.current?.pause();
      const session = ++stemSessionRef.current;
      await stems.ensureStemGraph();
      await Promise.all(stemEls.map((a) => waitForMetadata(a)));
      if (stemSessionRef.current !== session) return;
      stemEls.forEach((a) => { try { a.currentTime = t; } catch { /* ignore */ } });
      try {
        await Promise.all(stemEls.map((a) => a.play()));
        if (stemSessionRef.current !== session) { stemEls.forEach((a) => a.pause()); return; }
        isPlayingRef.current = true; setIsPlaying(true);
      } catch { if (stemSessionRef.current === session) pausePlayback(); }
      return;
    }
    stemEls.forEach((a) => a.pause());
    const audio = mixAudioRef.current;
    if (!audio) return;
    try {
      await waitForMetadata(audio);
      if (audio.readyState >= 1) audio.currentTime = t;
      await audio.play();
      isPlayingRef.current = true; setIsPlaying(true);
    } catch { stopFromEnded(); }
  }, [pausePlayback, stems, stopFromEnded, updatePlayheadVisual]);

  useEffect(() => {
    const prev = prevStemPreviewRef.current;
    prevStemPreviewRef.current = isStemPreviewActive;
    if (prev === isStemPreviewActive) return;
    const wasPlaying = isPlayingRef.current;
    const saved = currentTimeRef.current;
    pausePlayback();
    if (wasPlaying) void startPlayback(saved); else seekToTime(saved);
  }, [isStemPreviewActive, pausePlayback, seekToTime, startPlayback]);

  useEffect(() => {
    if (!isPlaying) return;
    let rafId = 0, lastUi = 0, lastSync = 0;
    const tick = (now: number) => {
      if (!isPlayingRef.current) return;
      if (pendingRestoreRef.current !== null) {
        rafId = window.requestAnimationFrame(tick);
        return;
      }
      const shouldSync = now - lastSync > 150;
      if (shouldSync) lastSync = now;
      const activeTime = isStemPreviewRef.current
        ? getActiveStemTime(stems.stemAudiosRef.current, currentTimeRef.current, shouldSync)
        : (mixAudioRef.current?.currentTime ?? currentTimeRef.current);
      const sel = selectionRef.current;
      if (loopSelectionRef.current && sel && sel.end > sel.start && activeTime >= sel.end) seekToTime(sel.start);
      else { updatePlayheadVisual(activeTime); if (now - lastUi > 90) { lastUi = now; setDisplayTime(activeTime); } }
      rafId = window.requestAnimationFrame(tick);
    };
    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [isPlaying, seekToTime, stems.stemAudiosRef, updatePlayheadVisual]);

  const handlePlayPause = useCallback(() => {
    if (!mainTrack) return;
    if (isPlayingRef.current) { pausePlayback(); return; }
    const sel = selectionRef.current;
    const cur = currentTimeRef.current;
    void startPlayback(sel && (cur < sel.start || cur >= sel.end) ? sel.start : cur);
  }, [mainTrack, pausePlayback, startPlayback]);

  const handleStop = useCallback(() => {
    pausePlayback();
    seekToTime(selectionRef.current ? selectionRef.current.start : 0);
  }, [pausePlayback, seekToTime]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !mainTrack || isEditableElement(e.target)) return;
      e.preventDefault();
      handlePlayPause();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mainTrack, handlePlayPause]);

  return {
    isPlaying, loopSelection, setLoopSelection, displayTime, audioDuration, loadingAudio, audioError,
    setAudioError, stemChannels: stems.stemChannels, isStemPreviewActive, currentTimeRef, seekToTime,
    handlePlayPause, handleStop, updateStemChannel: stems.updateStemChannel, resetStemChannels: stems.resetStemChannels,
  };
}

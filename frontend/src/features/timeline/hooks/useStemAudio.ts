import { useCallback, useEffect, useRef, useState } from 'react';
import { getStemAudioUrl, type ProjectState } from '../../../shared/api';
import type { InstrumentStem } from '../../../shared/utils/timelineMath';
import { STEM_LANES, type StemChannelState } from '../constants';
import { createInitialStemChannels, effectiveStemGain } from '../utils';

export function waitForMetadata(audio: HTMLAudioElement, timeoutMs = 3000): Promise<void> {
  if (audio.readyState >= 1) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      audio.removeEventListener('loadedmetadata', done);
      audio.removeEventListener('error', done);
      resolve();
    };
    const timer = window.setTimeout(done, timeoutMs);
    audio.addEventListener('loadedmetadata', done, { once: true });
    audio.addEventListener('error', done, { once: true });
  });
}

export function isEditableElement(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable
  );
}

export function getActiveStemTime(
  stemAudios: Partial<Record<InstrumentStem, HTMLAudioElement>>,
  fallbackTime: number,
  shouldSyncFollowers: boolean
): number {
  const els = Object.values(stemAudios).filter((a): a is HTMLAudioElement => Boolean(a));
  if (!els[0]) return fallbackTime;
  const leaderTime = els[0].currentTime;
  if (shouldSyncFollowers) {
    for (let i = 1; i < els.length; i++) {
      const f = els[i];
      if (!f.paused && Math.abs(f.currentTime - leaderTime) > 0.1) {
        try { f.currentTime = leaderTime; } catch { /* ignore */ }
      }
    }
  }
  return leaderTime;
}

export function disposeAudioElement(audio: HTMLAudioElement | null | undefined): void {
  if (!audio) return;
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
}

export function useStemAudio(
  project: ProjectState | null,
  stemsReady: boolean,
  isStemPreviewRef: React.MutableRefObject<boolean>,
  onEndedAll: () => void
) {
  const [stemChannels, setStemChannels] = useState<Record<InstrumentStem, StemChannelState>>(createInitialStemChannels);
  const stemAudiosRef = useRef<Partial<Record<InstrumentStem, HTMLAudioElement>>>({});
  const stemGainsRef = useRef<Partial<Record<InstrumentStem, GainNode>>>({});
  const stemCtxRef = useRef<AudioContext | null>(null);
  const stemChannelsRef = useRef(stemChannels);
  stemChannelsRef.current = stemChannels;

  const teardownStemAudio = useCallback(() => {
    Object.values(stemAudiosRef.current).forEach(disposeAudioElement);
    stemAudiosRef.current = {};
    stemGainsRef.current = {};
    stemCtxRef.current?.close().catch(() => {});
    stemCtxRef.current = null;
  }, []);

  useEffect(() => {
    for (const lane of STEM_LANES) {
      const audio = stemAudiosRef.current[lane.id];
      const gain = effectiveStemGain(lane.id, stemChannels);
      const gainNode = stemGainsRef.current[lane.id];
      if (gainNode) gainNode.gain.value = gain;
      if (audio) {
        audio.volume = gainNode ? 1 : Math.min(1, gain);
        audio.muted = gain === 0;
      }
    }
  }, [stemChannels]);

  useEffect(() => {
    teardownStemAudio();
    if (!project || !project.main_track || !stemsReady) return;
    const created: Partial<Record<InstrumentStem, HTMLAudioElement>> = {};
    for (const lane of STEM_LANES) {
      const a = new Audio();
      a.crossOrigin = 'anonymous';
      a.preload = 'auto';
      a.src = getStemAudioUrl(project, lane.id);
      created[lane.id] = a;
    }
    stemAudiosRef.current = created;
    const leader = created.vocals || created.drums;
    const onEnded = () => {
      if (!isStemPreviewRef.current) return;
      Object.values(stemAudiosRef.current).forEach((a) => a?.pause());
      onEndedAll();
    };
    leader?.addEventListener('ended', onEnded);
    return () => {
      leader?.removeEventListener('ended', onEnded);
      teardownStemAudio();
    };
  }, [project?.id, project?.main_track?.id, stemsReady, isStemPreviewRef, onEndedAll, teardownStemAudio]);

  const ensureStemGraph = useCallback(async () => {
    if (stemCtxRef.current) {
      if (stemCtxRef.current.state === 'suspended') await stemCtxRef.current.resume().catch(() => {});
      return;
    }
    const entries = Object.entries(stemAudiosRef.current) as [InstrumentStem, HTMLAudioElement][];
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!entries.length || !AudioCtx) return;
    let ctx: AudioContext | null = null;
    try {
      ctx = new AudioCtx();
      if (ctx.state === 'suspended') await ctx.resume();
      const nodes: Partial<Record<InstrumentStem, GainNode>> = {};
      for (const [stem, audio] of entries) {
        audio.volume = 1;
        const src = ctx.createMediaElementSource(audio);
        const gainNode = ctx.createGain();
        gainNode.gain.value = effectiveStemGain(stem, stemChannelsRef.current);
        src.connect(gainNode);
        gainNode.connect(ctx.destination);
        nodes[stem] = gainNode;
      }
      stemCtxRef.current = ctx;
      stemGainsRef.current = nodes;
    } catch {
      ctx?.close().catch(() => {});
      stemCtxRef.current = null;
      stemGainsRef.current = {};
    }
  }, []);

  const updateStemChannel = useCallback((stem: InstrumentStem, patch: Partial<StemChannelState>) => {
    setStemChannels((prev) => ({ ...prev, [stem]: { ...prev[stem], ...patch } }));
  }, []);

  const resetStemChannels = useCallback(() => setStemChannels(createInitialStemChannels()), []);

  return {
    stemChannels, stemAudiosRef, teardownStemAudio, ensureStemGraph, updateStemChannel, resetStemChannels,
  };
}

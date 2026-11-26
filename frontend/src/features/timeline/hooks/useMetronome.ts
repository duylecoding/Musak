import { useEffect, useRef } from 'react';
import type React from 'react';

export interface UseMetronomeOptions {
  enabled: boolean;
  isPlaying: boolean;
  beats: number[];
  currentTimeRef: React.MutableRefObject<number>;
}

function findLatestBeatIndex(beats: number[], time: number): number {
  let idx = -1;
  for (let i = 0; i < beats.length && beats[i] <= time; i++) idx = i;
  return idx;
}

function triggerClick(ctx: AudioContext, isDownbeat: boolean): void {
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(isDownbeat ? 1400 : 1000, now);
  gain.gain.setValueAtTime(isDownbeat ? 0.2 : 0.12, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.032);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.035);
}

export function useMetronome({ enabled, isPlaying, beats, currentTimeRef }: UseMetronomeOptions): void {
  const audioCtxRef = useRef<AudioContext | null>(null);
  const lastBeatIdxRef = useRef(-1);
  const lastTimeRef = useRef(0);

  useEffect(() => () => {
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      void audioCtxRef.current.close().catch(() => {});
    }
    audioCtxRef.current = null;
  }, []);

  useEffect(() => {
    if (!enabled || !isPlaying || beats.length === 0) {
      lastBeatIdxRef.current = -1;
      return;
    }
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') audioCtxRef.current = new AudioCtx();
    const ctx = audioCtxRef.current;
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});

    lastTimeRef.current = currentTimeRef.current;
    lastBeatIdxRef.current = findLatestBeatIndex(beats, currentTimeRef.current - 0.015);

    let rafId = 0;
    const tick = () => {
      const t = currentTimeRef.current;
      if (t < lastTimeRef.current - 0.15 || t > lastTimeRef.current + 0.5) {
        lastBeatIdxRef.current = findLatestBeatIndex(beats, t - 0.015);
      }
      lastTimeRef.current = t;
      const idx = findLatestBeatIndex(beats, t);
      if (idx > lastBeatIdxRef.current && idx >= 0) {
        if (t - beats[idx] <= 0.08) triggerClick(ctx, idx % 4 === 0);
        lastBeatIdxRef.current = idx;
      }
      rafId = window.requestAnimationFrame(tick);
    };
    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [enabled, isPlaying, beats, currentTimeRef]);
}

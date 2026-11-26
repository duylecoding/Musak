import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectState } from '../../../shared/api';
import { computeRulerTicks } from '../utils';
import { usePlaybackEngine } from './usePlaybackEngine';

class FakeAudio extends EventTarget {
  src = '';
  preload = '';
  crossOrigin: string | null = null;
  volume = 1;
  muted = false;
  paused = true;
  readyState = 1;
  duration = 120;
  currentTime = 0;

  load = vi.fn(() => {
    this.readyState = 0;
  });

  pause = vi.fn(() => {
    this.paused = true;
  });

  play = vi.fn(async () => {
    this.paused = false;
    this.dispatchEvent(new Event('playing'));
  });

  removeAttribute = vi.fn(() => {
    this.src = '';
  });

  finishLoad() {
    this.readyState = 4;
    this.dispatchEvent(new Event('loadedmetadata'));
  }
}

function makeProject(renderVersion: number, stemsStatus: 'none' | 'ready' = 'none'): ProjectState {
  return {
    id: 'proj_1',
    name: 'Test',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    render_version: renderVersion,
    main_track: {
      id: 'trk_1',
      name: 'Song',
      duration: 120,
      sample_rate: 44100,
      bpm: 120,
      key: 'A minor',
      beats: [0, 0.5, 1, 1.5],
      sections: [],
      lyric_hooks: [],
      stems_status: stemsStatus,
      stems_error: null,
      stems: stemsStatus === 'ready' ? ['vocals', 'drums', 'bass', 'other'] : [],
      audio_url: '/api/projects/proj_1/audio/main',
      rendered_url: '/api/projects/proj_1/audio/rendered',
      stem_urls:
        stemsStatus === 'ready'
          ? {
              vocals: '/api/projects/proj_1/audio/stem/vocals',
              drums: '/api/projects/proj_1/audio/stem/drums',
              bass: '/api/projects/proj_1/audio/stem/bass',
              other: '/api/projects/proj_1/audio/stem/other',
            }
          : {},
    },
    references: [],
    edits: [],
    redo_stack: [],
    chat_messages: [],
  };
}

describe('usePlaybackEngine & timeline zoom ticks', () => {
  const createdAudios: FakeAudio[] = [];
  const origAudio = window.Audio;
  const origRaf = window.requestAnimationFrame;
  const origCancelRaf = window.cancelAnimationFrame;

  beforeEach(() => {
    createdAudios.length = 0;
    (window as unknown as { Audio: unknown }).Audio = vi.fn(() => {
      const a = new FakeAudio();
      createdAudios.push(a);
      return a;
    });
  });

  afterEach(() => {
    (window as unknown as { Audio: unknown }).Audio = origAudio;
    window.requestAnimationFrame = origRaf;
    window.cancelAnimationFrame = origCancelRaf;
  });

  it('keeps playhead moving when pressing Play right after adding a layer bumps render_version', async () => {
    let rafCallback: FrameRequestCallback | null = null;
    window.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
      rafCallback = cb;
      return 1;
    });
    window.cancelAnimationFrame = vi.fn();

    const playheadRef = { current: 0 };
    const lineEl = document.createElement('div');
    const diamondEl = document.createElement('div');
    const playheadLineRef = { current: lineEl };
    const playheadDiamondRef = { current: diamondEl };

    const { result, rerender } = renderHook(
      ({ proj }: { proj: ProjectState }) =>
        usePlaybackEngine({
          project: proj,
          abMode: 'remix',
          selection: null,
          trackDuration: 120,
          playheadRef,
          playheadLineRef,
          playheadDiamondRef,
        }),
      { initialProps: { proj: makeProject(0) } }
    );

    const mixAudio = createdAudios[0];
    act(() => {
      mixAudio.finishLoad();
    });

    // Simulate adding a synth layer -> render_version increments 0 -> 1
    rerender({ proj: makeProject(1) });
    expect(mixAudio.src).toContain('v=1');

    // Press Play while metadata is loading, then metadata completes
    let playPromise: Promise<void> | undefined;
    act(() => {
      playPromise = Promise.resolve(result.current.handlePlayPause());
    });
    act(() => {
      mixAudio.finishLoad();
    });
    await act(async () => {
      await playPromise;
    });

    expect(result.current.isPlaying).toBe(true);

    // Advance audio time and run RAF tick -> playhead must move!
    mixAudio.currentTime = 30;
    act(() => {
      rafCallback?.(1000);
    });

    expect(playheadRef.current).toBe(30);
    expect(lineEl.style.left).toBe('25%');
    expect(diamondEl.style.left).toBe('25%');
  });

  it('produces fine 1s and 2s ruler ticks when zoomed to 8x and 16x', () => {
    const ticks8x = computeRulerTicks(180, 8);
    const ticks16x = computeRulerTicks(180, 16);
    expect(ticks8x[1] - ticks8x[0]).toBe(2);
    expect(ticks16x[1] - ticks16x[0]).toBe(1);
  });

  it('mutes vocals stem via stem playback instead of falling back to full unmuted mix', async () => {
    const playheadRef = { current: 0 };
    const playheadLineRef = { current: document.createElement('div') };
    const playheadDiamondRef = { current: document.createElement('div') };
    const proj = makeProject(1, 'ready');

    const { result } = renderHook(() =>
      usePlaybackEngine({
        project: proj,
        abMode: 'remix',
        selection: null,
        trackDuration: 120,
        playheadRef,
        playheadLineRef,
        playheadDiamondRef,
      })
    );

    // 4 stem Audio elements (vocals, drums, bass, other) + 1 mix Audio element
    expect(createdAudios.length).toBe(5);
    const vocalsAudio = createdAudios.find((a) => a.src.includes('/audio/stem/vocals'))!;
    const drumsAudio = createdAudios.find((a) => a.src.includes('/audio/stem/drums'))!;
    const mixAudio = createdAudios.find((a) => a.src.includes('/audio/rendered'))!;
    expect(vocalsAudio).toBeDefined();
    expect(drumsAudio).toBeDefined();
    expect(mixAudio).toBeDefined();

    // Mute vocals and start playback
    act(() => {
      result.current.updateStemChannel('vocals', { muted: true });
    });
    expect(result.current.isStemPreviewActive).toBe(true);
    expect(vocalsAudio.muted).toBe(true);
    expect(drumsAudio.muted).toBe(false);

    await act(async () => {
      result.current.handlePlayPause();
    });

    // Stem playback must be active with vocals muted, while full mix stays paused
    expect(result.current.isPlaying).toBe(true);
    expect(mixAudio.paused).toBe(true);
    expect(drumsAudio.paused).toBe(false);
    expect(vocalsAudio.muted).toBe(true);
    // In remix mode, stem playback must stream remixed stems (mode=remix&v=1) so borrowed layers keep playing!
    expect(drumsAudio.src).toContain('mode=remix');
    expect(drumsAudio.src).toContain('v=1');
  });
});

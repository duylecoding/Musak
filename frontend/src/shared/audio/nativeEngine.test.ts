import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isTauriRuntime,
  nativePause,
  nativePlay,
  nativeSeek,
  nativeSetStemMixer,
  nativeSyncTimeline,
} from './nativeEngine';

describe('nativeEngine Tauri IPC bridge', () => {
  afterEach(() => {
    delete window.__TAURI__;
  });

  it('detects Tauri runtime only when __TAURI__.core.invoke is present', () => {
    expect(isTauriRuntime()).toBe(false);
    window.__TAURI__ = { core: { invoke: vi.fn() } };
    expect(isTauriRuntime()).toBe(true);
  });

  it('forwards play, pause, seek, stem mixer, and timeline sync commands to Rust', async () => {
    const invoke = vi.fn().mockResolvedValue({
      playing: true,
      current_time: 12.5,
      duration: 180,
      sample_rate: 48000,
      device_ready: true,
    });
    window.__TAURI__ = { core: { invoke } };

    const mixer = {
      vocals: { volume: 100, muted: true, solo: false },
      drums: { volume: 100, muted: false, solo: false },
      bass: { volume: 100, muted: false, solo: false },
      other: { volume: 100, muted: false, solo: false },
    };

    await nativePlay(12.5);
    expect(invoke).toHaveBeenCalledWith('audio_play', { startSecs: 12.5 });

    await nativeSeek(30);
    expect(invoke).toHaveBeenCalledWith('audio_seek', { secs: 30 });

    await nativeSetStemMixer(mixer);
    expect(invoke).toHaveBeenCalledWith('audio_set_stem_mixer', { stemMixer: mixer });

    await nativeSyncTimeline([], 'remix', mixer, [10, 20]);
    expect(invoke).toHaveBeenCalledWith('audio_sync_timeline', {
      edits: [],
      abMode: 'remix',
      stemMixer: mixer,
      loopRange: [10, 20],
    });

    await nativePause();
    expect(invoke).toHaveBeenCalledWith('audio_pause', undefined);
  });
});

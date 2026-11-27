import type { EditBlock } from '../api/editTypes';
import type { EngineManifestResponse } from '../api/tracksApi';
import type { StemChannelState } from '../../features/timeline/constants';
import type { InstrumentStem } from '../utils/timelineMath';

export interface NativeTransportState {
  playing: boolean;
  current_time: number;
  duration: number;
  sample_rate: number;
  device_ready: boolean;
}

interface TauriCore {
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
}

declare global {
  interface Window {
    __TAURI__?: { core?: TauriCore };
  }
}

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && typeof window.__TAURI__?.core?.invoke === 'function';
}

function invokeNative<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) return Promise.reject(new Error('Native Tauri audio engine unavailable.'));
  return invoke<T>(cmd, args);
}

export function nativeLoadManifest(
  manifest: EngineManifestResponse,
  edits: EditBlock[],
  abMode: 'original' | 'remix',
  stemMixer?: Record<InstrumentStem, StemChannelState>
): Promise<NativeTransportState> {
  return invokeNative<NativeTransportState>('audio_load_manifest', {
    manifest,
    edits,
    abMode,
    stemMixer: stemMixer ?? null,
  });
}

export function nativeSyncTimeline(
  edits: EditBlock[],
  abMode: 'original' | 'remix',
  stemMixer: Record<InstrumentStem, StemChannelState>,
  loopRange: [number, number] | null
): Promise<NativeTransportState> {
  return invokeNative<NativeTransportState>('audio_sync_timeline', {
    edits,
    abMode,
    stemMixer,
    loopRange,
  });
}

export function nativeSetStemMixer(stemMixer: Record<InstrumentStem, StemChannelState>): Promise<void> {
  return invokeNative<void>('audio_set_stem_mixer', { stemMixer });
}

export function nativePlay(startSecs?: number): Promise<NativeTransportState> {
  return invokeNative<NativeTransportState>('audio_play', {
    startSecs: startSecs ?? null,
  });
}

export function nativePause(): Promise<NativeTransportState> {
  return invokeNative<NativeTransportState>('audio_pause');
}

export function nativeSeek(secs: number): Promise<NativeTransportState> {
  return invokeNative<NativeTransportState>('audio_seek', { secs });
}

export function nativeTransportState(): Promise<NativeTransportState> {
  return invokeNative<NativeTransportState>('audio_transport_state');
}

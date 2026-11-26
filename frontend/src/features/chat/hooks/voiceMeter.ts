export function pickBestRecorderMime(): { mimeType: string; filename: string } {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return { mimeType: '', filename: 'voice.webm' };
  }
  const candidates = [
    { mimeType: 'audio/webm;codecs=opus', filename: 'voice.webm' },
    { mimeType: 'audio/webm', filename: 'voice.webm' },
    { mimeType: 'audio/ogg;codecs=opus', filename: 'voice.ogg' },
    { mimeType: 'audio/ogg', filename: 'voice.ogg' },
    { mimeType: 'audio/mp4', filename: 'voice.m4a' },
  ];
  return candidates.find((c) => MediaRecorder.isTypeSupported(c.mimeType)) ?? { mimeType: '', filename: 'voice.webm' };
}

export function formatMicError(err: unknown): string {
  const name = err && typeof err === 'object' && 'name' in err ? String(err.name) : '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return 'Microphone permission was denied. Allow mic access in Windows settings and try again.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No microphone detected. Plug in a mic and try again.';
  }
  return err instanceof Error ? err.message : 'Could not access microphone.';
}

export interface MicMeterHandle {
  stop: () => void;
}

/** Starts a WebAudio AnalyserNode RMS meter and returns a handle to tear down the AudioContext & RAF loop. */
export function startAudioLevelMeter(
  stream: MediaStream,
  onLevel: (level: number) => void
): MicMeterHandle {
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) {
    return { stop: () => {} };
  }

  let ctx: AudioContext | null = null;
  let rafId: number | null = null;
  let stopped = false;

  try {
    ctx = new AudioCtx();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.75;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const data = new Uint8Array(analyser.fftSize);

    const tick = () => {
      if (stopped || !ctx) return;
      analyser.getByteTimeDomainData(data);
      let sumSq = 0;
      for (let i = 0; i < data.length; i += 1) {
        const norm = (data[i] - 128) / 128;
        sumSq += norm * norm;
      }
      onLevel(Math.min(1, Math.sqrt(sumSq / data.length) * 3.8));
      rafId = window.requestAnimationFrame(tick);
    };
    rafId = window.requestAnimationFrame(tick);
  } catch {
    // Non-fatal: recording still succeeds without live meter
  }

  return {
    stop: () => {
      stopped = true;
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (ctx) {
        ctx.close().catch(() => {});
        ctx = null;
      }
      onLevel(0);
    },
  };
}

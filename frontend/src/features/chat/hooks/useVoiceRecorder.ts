import { useCallback, useEffect, useRef, useState } from 'react';
import { transcribeVoice } from '../../../shared/api';
import { formatMicError, type MicMeterHandle, pickBestRecorderMime, startAudioLevelMeter } from './voiceMeter';

interface UseVoiceRecorderOptions {
  projectId: string | null;
  apiKeyConfigured: boolean;
  sending: boolean;
  onOpenSettings: () => void;
  onBeforeStart?: () => void;
  onError: (message: string | null) => void;
  onTranscript: (transcript: string) => Promise<void> | void;
}

/** Encapsulates MediaRecorder, live mic meter, transcription, and race-safe session/stream cleanup. */
export function useVoiceRecorder({
  projectId, apiKeyConfigured, sending, onOpenSettings, onBeforeStart, onError, onTranscript,
}: UseVoiceRecorderOptions) {
  const [isRecording, setIsRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const meterHandleRef = useRef<MicMeterHandle | null>(null);
  const elapsedTimerRef = useRef<number | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const cancelRef = useRef(false);
  const unmountedRef = useRef(false);
  const voiceSessionIdRef = useRef(0);
  const startingMicRef = useRef(false);

  const projectIdRef = useRef(projectId);
  const isRecordingRef = useRef(isRecording);
  const transcribingRef = useRef(transcribing);
  const sendingRef = useRef(sending);
  const onTranscriptRef = useRef(onTranscript);
  projectIdRef.current = projectId;
  isRecordingRef.current = isRecording;
  transcribingRef.current = transcribing;
  sendingRef.current = sending;
  onTranscriptRef.current = onTranscript;

  const cleanupVoiceResources = useCallback(() => {
    if (elapsedTimerRef.current !== null) { window.clearInterval(elapsedTimerRef.current); elapsedTimerRef.current = null; }
    meterHandleRef.current?.stop();
    meterHandleRef.current = null;
    if (mediaStreamRef.current) {
      for (const track of mediaStreamRef.current.getTracks()) { try { track.stop(); } catch { /* ignore */ } }
      mediaStreamRef.current = null;
    }
    setAudioLevel(0);
  }, []);

  const teardownRecorder = useCallback((cancel: boolean) => {
    voiceSessionIdRef.current += 1;
    startingMicRef.current = false;
    cancelRef.current = cancel;
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch { /* ignore */ } }
    mediaRecorderRef.current = null;
    cleanupVoiceResources();
  }, [cleanupVoiceResources]);

  useEffect(() => {
    unmountedRef.current = false;
    return () => { unmountedRef.current = true; teardownRecorder(true); };
  }, [teardownRecorder]);

  useEffect(() => {
    teardownRecorder(true);
    isRecordingRef.current = false;
    transcribingRef.current = false;
    setIsRecording(false);
    setTranscribing(false);
    setRecordingSeconds(0);
    return () => teardownRecorder(true);
  }, [projectId, teardownRecorder]);

  const stopRecording = useCallback((cancel = false) => {
    if (cancel) voiceSessionIdRef.current += 1;
    cancelRef.current = cancel;
    startingMicRef.current = false;
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); return; } catch { /* fall through */ }
    }
    cleanupVoiceResources();
    isRecordingRef.current = false;
    setIsRecording(false);
    setRecordingSeconds(0);
  }, [cleanupVoiceResources]);

  const startRecording = useCallback(async () => {
    const capturedPid = projectIdRef.current;
    if (!capturedPid || startingMicRef.current || isRecordingRef.current || transcribingRef.current || sendingRef.current) return;
    if (!apiKeyConfigured) { onError('Configure your Gemini API key in Settings to use voice control.'); onOpenSettings(); return; }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      onError('Microphone recording is not supported in this environment.');
      return;
    }

    startingMicRef.current = true;
    const sessionId = ++voiceSessionIdRef.current;
    const isStale = () => unmountedRef.current || voiceSessionIdRef.current !== sessionId || projectIdRef.current !== capturedPid;
    onError(null);
    onBeforeStart?.();
    cancelRef.current = false;
    chunksRef.current = [];

    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (err) { startingMicRef.current = false; if (!isStale()) onError(formatMicError(err)); return; }
    if (isStale()) { startingMicRef.current = false; stream.getTracks().forEach((t) => t.stop()); return; }

    mediaStreamRef.current = stream;
    meterHandleRef.current = startAudioLevelMeter(stream, setAudioLevel);

    const { mimeType, filename } = pickBestRecorderMime();
    let recorder: MediaRecorder;
    try { recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream); }
    catch { startingMicRef.current = false; cleanupVoiceResources(); onError('Failed to initialize audio recorder.'); return; }

    mediaRecorderRef.current = recorder;
    recorder.ondataavailable = (e) => { if (e.data?.size > 0) chunksRef.current.push(e.data); };
    recorder.onerror = () => {
      startingMicRef.current = false;
      cleanupVoiceResources();
      mediaRecorderRef.current = null;
      if (isStale()) return;
      isRecordingRef.current = false; setIsRecording(false); setRecordingSeconds(0);
      onError('Voice recording encountered an audio error.');
    };
    recorder.onstop = async () => {
      const wasCancelled = cancelRef.current;
      const chunks = chunksRef.current.slice();
      chunksRef.current = [];
      mediaRecorderRef.current = null;
      startingMicRef.current = false;
      cleanupVoiceResources();
      if (isStale()) return;

      isRecordingRef.current = false; setIsRecording(false); setRecordingSeconds(0);
      if (wasCancelled) return;
      const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
      if (blob.size < 256) { onError("Didn't catch any audio — hold a moment longer while speaking."); return; }

      transcribingRef.current = true; setTranscribing(true); onError(null);
      try {
        const result = await transcribeVoice(blob, filename);
        if (isStale()) return;
        const transcript = (result.text || '').trim();
        if (!transcript) { onError("Couldn't hear any speech — try speaking a little closer to your mic."); return; }
        transcribingRef.current = false; setTranscribing(false);
        await onTranscriptRef.current(transcript);
      } catch (err) {
        if (!isStale()) onError(err instanceof Error ? err.message : 'Voice transcription failed.');
      } finally {
        if (!isStale()) { transcribingRef.current = false; setTranscribing(false); }
      }
    };

    try { recorder.start(200); }
    catch (err) {
      startingMicRef.current = false; mediaRecorderRef.current = null; cleanupVoiceResources();
      onError(err instanceof Error ? err.message : 'Failed to start microphone recording.');
      return;
    }

    startingMicRef.current = false; isRecordingRef.current = true; setRecordingSeconds(0); setIsRecording(true);
    const startedAt = Date.now();
    elapsedTimerRef.current = window.setInterval(() => setRecordingSeconds(Math.floor((Date.now() - startedAt) / 1000)), 250);
  }, [apiKeyConfigured, cleanupVoiceResources, onBeforeStart, onError, onOpenSettings]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        if (isRecordingRef.current) stopRecording(false);
        else void startRecording();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [startRecording, stopRecording]);

  return { isRecording, transcribing, recordingSeconds, audioLevel, startRecording, stopRecording };
}

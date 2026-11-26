import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AtSign,
  Check,
  KeyRound,
  Loader2,
  Mic,
  Play,
  Send,
  Sparkles,
  Square,
  Target,
  Wand2,
  X,
} from 'lucide-react';
import type {
  ChatMessage,
  EditProposal,
  ReferenceTrack,
  TimeSelection,
} from '../api/types';
import { getProposalPreviewUrl, transcribeVoice } from '../api/client';
import { formatTime, formatTimeRange } from '../utils/format';

interface ProducerChatProps {
  projectId: string | null;
  hasMainTrack: boolean;
  messages: ChatMessage[];
  selection: TimeSelection | null;
  onClearSelection: () => void;
  references: ReferenceTrack[];
  attachedRefIds: string[];
  onToggleAttachRef: (refId: string) => void;
  onSendMessage: (message: string) => Promise<void>;
  onApplyProposal: (proposalId: string) => Promise<void>;
  apiKeyConfigured: boolean;
  onOpenSettings: () => void;
  draftSnippet: { text: string; nonce: number } | null;
}

const QUICK_PROMPTS = [
  'Suggest 3 ways to make this drop hit harder',
  'Give this section the vibe of my reference track',
  'Strip the drums for 4 bars then slam back in',
  'Make a dreamy lo-fi transition here',
];

function styleBadge(style: EditProposal['style']) {
  switch (style) {
    case 'imitate':
      return {
        label: 'Style Match',
        className: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
      };
    case 'mashup':
      return {
        label: 'Mashup',
        className: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
      };
    default:
      return {
        label: 'Creative',
        className: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
      };
  }
}

function pickBestRecorderMime(): { mimeType: string; filename: string } {
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
  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported(candidate.mimeType)) {
      return candidate;
    }
  }
  return { mimeType: '', filename: 'voice.webm' };
}

export const ProducerChat: React.FC<ProducerChatProps> = ({
  projectId,
  hasMainTrack,
  messages,
  selection,
  onClearSelection,
  references,
  attachedRefIds,
  onToggleAttachRef,
  onSendMessage,
  onApplyProposal,
  apiKeyConfigured,
  onOpenSettings,
  draftSnippet,
}) => {
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [playingProposalId, setPlayingProposalId] = useState<string | null>(null);

  // Voice Control state
  const [autoSendVoice, setAutoSendVoice] = useState(true);
  const [isRecording, setIsRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0);

  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Voice recording resource refs (for guaranteed cleanup & race protection)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const levelRafRef = useRef<number | null>(null);
  const elapsedTimerRef = useRef<number | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const cancelRecordingRef = useRef(false);
  const unmountedRef = useRef(false);
  const voiceSessionIdRef = useRef(0);
  const startingMicRef = useRef(false);

  const projectIdRef = useRef(projectId);
  const autoSendVoiceRef = useRef(autoSendVoice);
  const hasMainTrackRef = useRef(hasMainTrack);
  const isRecordingRef = useRef(isRecording);
  const transcribingRef = useRef(transcribing);
  const sendingRef = useRef(sending);
  const handleSubmitRef = useRef<(textOverride?: string) => Promise<void>>(async () => {});

  projectIdRef.current = projectId;
  autoSendVoiceRef.current = autoSendVoice;
  hasMainTrackRef.current = hasMainTrack;
  isRecordingRef.current = isRecording;
  transcribingRef.current = transcribing;
  sendingRef.current = sending;

  const cleanupVoiceResources = useCallback(() => {
    if (levelRafRef.current !== null) {
      window.cancelAnimationFrame(levelRafRef.current);
      levelRafRef.current = null;
    }
    if (elapsedTimerRef.current !== null) {
      window.clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
    if (mediaStreamRef.current) {
      for (const track of mediaStreamRef.current.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
      mediaStreamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    setAudioLevel(0);
  }, []);

  // Cleanup voice resources on unmount
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      voiceSessionIdRef.current += 1;
      startingMicRef.current = false;
      cancelRecordingRef.current = true;
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          // ignore
        }
      }
      mediaRecorderRef.current = null;
      cleanupVoiceResources();
    };
  }, [cleanupVoiceResources]);

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, sending]);

  // Append injected @Chat moment snippet from ReferenceShelf
  useEffect(() => {
    if (!draftSnippet?.text) return;
    setInput((prev) => {
      const sep = prev.trim().length > 0 ? ' ' : '';
      return `${prev.trim()}${sep}${draftSnippet.text} `;
    });
    textareaRef.current?.focus();
  }, [draftSnippet]);

  // Cleanup preview audio & reset voice/error state on project switch
  useEffect(() => {
    voiceSessionIdRef.current += 1;
    startingMicRef.current = false;
    cancelRecordingRef.current = true;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop();
      } catch {
        // ignore
      }
    }
    mediaRecorderRef.current = null;
    cleanupVoiceResources();
    isRecordingRef.current = false;
    transcribingRef.current = false;
    setIsRecording(false);
    setTranscribing(false);
    setRecordingSeconds(0);
    setChatError(null);

    return () => {
      voiceSessionIdRef.current += 1;
      startingMicRef.current = false;
      if (previewAudioRef.current) {
        previewAudioRef.current.pause();
        previewAudioRef.current = null;
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        cancelRecordingRef.current = true;
        try {
          mediaRecorderRef.current.stop();
        } catch {
          // ignore
        }
      }
      mediaRecorderRef.current = null;
      cleanupVoiceResources();
    };
  }, [projectId, cleanupVoiceResources]);

  const stopPreview = () => {
    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current.currentTime = 0;
      previewAudioRef.current = null;
    }
    setPlayingProposalId(null);
  };

  const handleTogglePreview = (proposal: EditProposal) => {
    if (!projectId) return;
    if (playingProposalId === proposal.id) {
      stopPreview();
      return;
    }
    stopPreview();

    const url = getProposalPreviewUrl(projectId, proposal.id, proposal.preview_url);
    const audio = new Audio(url);
    previewAudioRef.current = audio;
    setPlayingProposalId(proposal.id);

    audio.onended = () => {
      setPlayingProposalId((cur) => (cur === proposal.id ? null : cur));
    };
    audio.onerror = () => {
      setPlayingProposalId((cur) => (cur === proposal.id ? null : cur));
      setChatError('Preview audio could not be played.');
    };
    audio.play().catch(() => {
      setPlayingProposalId(null);
    });
  };

  const handleSubmit = useCallback(
    async (textOverride?: string) => {
      const activePid = projectIdRef.current;
      const content = (textOverride ?? input).trim();
      if (!content || !activePid || sendingRef.current) return;
      if (!apiKeyConfigured) {
        onOpenSettings();
        return;
      }
      if (!hasMainTrackRef.current) {
        setChatError('Load a song in the center stage first so Gemini can remix it.');
        return;
      }

      setChatError(null);
      sendingRef.current = true;
      setSending(true);
      if (textOverride === undefined) {
        setInput('');
      }
      try {
        await onSendMessage(content);
      } catch (err) {
        if (!unmountedRef.current && projectIdRef.current === activePid) {
          setChatError(err instanceof Error ? err.message : 'Gemini producer request failed.');
        }
      } finally {
        sendingRef.current = false;
        if (!unmountedRef.current) {
          setSending(false);
        }
      }
    },
    [input, apiKeyConfigured, onOpenSettings, onSendMessage]
  );

  handleSubmitRef.current = handleSubmit;

  const stopVoiceRecording = useCallback(
    (cancel = false) => {
      if (cancel) {
        voiceSessionIdRef.current += 1;
      }
      cancelRecordingRef.current = cancel;
      startingMicRef.current = false;
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          cleanupVoiceResources();
          isRecordingRef.current = false;
          setIsRecording(false);
          setRecordingSeconds(0);
        }
      } else {
        cleanupVoiceResources();
        isRecordingRef.current = false;
        setIsRecording(false);
        setRecordingSeconds(0);
      }
    },
    [cleanupVoiceResources]
  );

  const startVoiceRecording = useCallback(async () => {
    const capturedProjectId = projectIdRef.current;
    if (
      !capturedProjectId ||
      startingMicRef.current ||
      isRecordingRef.current ||
      transcribingRef.current ||
      sendingRef.current
    ) {
      return;
    }
    if (!apiKeyConfigured) {
      setChatError('Configure your Gemini API key in Settings to use voice control.');
      onOpenSettings();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setChatError('Microphone recording is not supported in this environment.');
      return;
    }

    startingMicRef.current = true;
    const sessionId = ++voiceSessionIdRef.current;
    setChatError(null);
    stopPreview();
    cancelRecordingRef.current = false;
    recordedChunksRef.current = [];

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      startingMicRef.current = false;
      if (
        unmountedRef.current ||
        voiceSessionIdRef.current !== sessionId ||
        projectIdRef.current !== capturedProjectId
      ) {
        return;
      }
      const name = err && typeof err === 'object' && 'name' in err ? String(err.name) : '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setChatError(
          'Microphone permission was denied. Allow mic access in Windows settings and try again.'
        );
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        setChatError('No microphone detected. Plug in a mic and try again.');
      } else {
        setChatError(err instanceof Error ? err.message : 'Could not access microphone.');
      }
      return;
    }

    if (
      unmountedRef.current ||
      voiceSessionIdRef.current !== sessionId ||
      projectIdRef.current !== capturedProjectId
    ) {
      startingMicRef.current = false;
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    mediaStreamRef.current = stream;

    // Start live WebAudio AnalyserNode meter
    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        const ctx = new AudioCtx();
        audioContextRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.75;
        source.connect(analyser);

        const dataArray = new Uint8Array(analyser.fftSize);
        const updateLevel = () => {
          if (!audioContextRef.current || voiceSessionIdRef.current !== sessionId) return;
          analyser.getByteTimeDomainData(dataArray);
          let sumSq = 0;
          for (let i = 0; i < dataArray.length; i++) {
            const norm = (dataArray[i] - 128) / 128;
            sumSq += norm * norm;
          }
          const rms = Math.sqrt(sumSq / dataArray.length);
          const scaled = Math.min(1, rms * 3.8);
          setAudioLevel(scaled);
          levelRafRef.current = window.requestAnimationFrame(updateLevel);
        };
        levelRafRef.current = window.requestAnimationFrame(updateLevel);
      }
    } catch {
      // Non-fatal: recording still works even if level meter fails
    }

    const { mimeType, filename } = pickBestRecorderMime();
    let recorder: MediaRecorder;
    try {
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch {
      startingMicRef.current = false;
      cleanupVoiceResources();
      setChatError('Failed to initialize audio recorder.');
      return;
    }

    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        recordedChunksRef.current.push(event.data);
      }
    };

    recorder.onerror = () => {
      startingMicRef.current = false;
      cleanupVoiceResources();
      mediaRecorderRef.current = null;
      if (
        !unmountedRef.current &&
        voiceSessionIdRef.current === sessionId &&
        projectIdRef.current === capturedProjectId
      ) {
        isRecordingRef.current = false;
        setIsRecording(false);
        setRecordingSeconds(0);
        setChatError('Voice recording encountered an audio error.');
      }
    };

    recorder.onstop = async () => {
      const wasCancelled = cancelRecordingRef.current;
      const chunks = recordedChunksRef.current.slice();
      recordedChunksRef.current = [];
      mediaRecorderRef.current = null;
      startingMicRef.current = false;
      cleanupVoiceResources();

      if (
        unmountedRef.current ||
        voiceSessionIdRef.current !== sessionId ||
        projectIdRef.current !== capturedProjectId
      ) {
        return;
      }

      isRecordingRef.current = false;
      setIsRecording(false);
      setRecordingSeconds(0);

      if (wasCancelled) return;

      const blobType = recorder.mimeType || mimeType || 'audio/webm';
      const blob = new Blob(chunks, { type: blobType });
      if (blob.size < 256) {
        setChatError("Didn't catch any audio — hold a moment longer while speaking.");
        return;
      }

      transcribingRef.current = true;
      setTranscribing(true);
      setChatError(null);
      try {
        const result = await transcribeVoice(blob, filename);
        if (
          unmountedRef.current ||
          voiceSessionIdRef.current !== sessionId ||
          projectIdRef.current !== capturedProjectId
        ) {
          return;
        }
        const transcript = (result.text || '').trim();
        if (!transcript) {
          setChatError("Couldn't hear any speech — try speaking a little closer to your mic.");
          return;
        }

        if (autoSendVoiceRef.current && hasMainTrackRef.current) {
          transcribingRef.current = false;
          setTranscribing(false);
          await handleSubmitRef.current(transcript);
        } else {
          setInput((prev) => {
            const sep = prev.trim().length > 0 ? ' ' : '';
            return `${prev.trim()}${sep}${transcript}`;
          });
          textareaRef.current?.focus();
          if (autoSendVoiceRef.current && !hasMainTrackRef.current) {
            setChatError('Transcript ready! Load a song in the center stage first, then hit Send.');
          }
        }
      } catch (err) {
        if (
          !unmountedRef.current &&
          voiceSessionIdRef.current === sessionId &&
          projectIdRef.current === capturedProjectId
        ) {
          setChatError(err instanceof Error ? err.message : 'Voice transcription failed.');
        }
      } finally {
        if (
          !unmountedRef.current &&
          voiceSessionIdRef.current === sessionId &&
          projectIdRef.current === capturedProjectId
        ) {
          transcribingRef.current = false;
          setTranscribing(false);
        }
      }
    };

    try {
      recorder.start(200);
    } catch (err) {
      startingMicRef.current = false;
      mediaRecorderRef.current = null;
      cleanupVoiceResources();
      setChatError(
        err instanceof Error ? err.message : 'Failed to start microphone recording.'
      );
      return;
    }

    startingMicRef.current = false;
    isRecordingRef.current = true;
    setRecordingSeconds(0);
    setIsRecording(true);
    const startedAt = Date.now();
    elapsedTimerRef.current = window.setInterval(() => {
      setRecordingSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 250);
  }, [apiKeyConfigured, onOpenSettings, cleanupVoiceResources]);

  // Keyboard shortcut: Ctrl+Shift+M to toggle voice recording
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        if (isRecordingRef.current) {
          stopVoiceRecording(false);
        } else {
          startVoiceRecording();
        }
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [startVoiceRecording, stopVoiceRecording]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleApplyClick = async (proposalId: string) => {
    if (applyingId) return;
    stopPreview();
    setApplyingId(proposalId);
    setChatError(null);
    try {
      await onApplyProposal(proposalId);
    } catch (err) {
      setChatError(err instanceof Error ? err.message : 'Failed to apply edit.');
    } finally {
      setApplyingId(null);
    }
  };

  const attachedRefs = references.filter((r) => attachedRefIds.includes(r.id));

  return (
    <aside className="w-[350px] xl:w-[390px] shrink-0 bg-[#12141c] border-l border-white/[0.07] flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3.5 border-b border-white/[0.07] shrink-0 flex items-center justify-between">
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-200 flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-violet-400" />
            Gemini Producer
          </h2>
          <p className="text-[11px] text-zinc-500 mt-0.5">
            Describe the vibe — preview & apply in one click
          </p>
        </div>
        <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-violet-500/12 text-violet-300 border border-violet-500/25">
          Co-Pilot
        </span>
      </div>

      {/* API Key Missing Banner */}
      {!apiKeyConfigured && (
        <div className="mx-3 mt-3 p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-start gap-2.5 shrink-0">
          <KeyRound className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-amber-200">Gemini API Key needed</p>
            <p className="text-[11px] text-amber-200/75 mt-0.5 leading-snug">
              Add your Google AI Studio key to unlock AI remix suggestions and audio previews.
            </p>
            <button
              type="button"
              onClick={onOpenSettings}
              className="mt-2 px-2.5 py-1 rounded-md bg-amber-500 hover:bg-amber-400 text-[#0b0c10] text-[11px] font-semibold transition-colors"
            >
              Configure API Key
            </button>
          </div>
        </div>
      )}

      {/* Chat Thread */}
      <div className="flex-1 overflow-y-auto px-3.5 py-3 space-y-4">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col justify-center py-4 space-y-4">
            <div className="text-center px-2">
              <div className="w-11 h-11 rounded-2xl bg-violet-500/15 border border-violet-500/30 flex items-center justify-center mx-auto mb-3">
                <Wand2 className="w-5 h-5 text-violet-300" />
              </div>
              <h3 className="text-sm font-semibold text-zinc-100">Ready to remix together</h3>
              <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
                Highlight a moment on the waveform (or leave the full track selected) and tell me
                how you want it to feel.
              </p>
            </div>

            <div className="space-y-1.5">
              <div className="text-[10px] uppercase tracking-wider font-semibold text-zinc-500 px-1">
                Try asking
              </div>
              {QUICK_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  disabled={sending || !projectId}
                  onClick={() => handleSubmit(prompt)}
                  className="w-full text-left px-3 py-2 rounded-xl bg-[#181b26] hover:bg-[#1f2332] border border-white/[0.07] hover:border-violet-500/35 text-xs text-zinc-200 transition-colors disabled:opacity-40"
                >
                  “{prompt}”
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((msg) => {
            const isUser = msg.role === 'user';
            return (
              <div key={msg.id} className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
                <div
                  className={`max-w-[92%] rounded-2xl px-3.5 py-2.5 text-xs leading-relaxed ${
                    isUser
                      ? 'bg-violet-600 text-white rounded-br-sm'
                      : 'bg-[#181b26] border border-white/[0.07] text-zinc-200 rounded-bl-sm'
                  }`}
                >
                  {isUser && (msg.selection || msg.reference_ids.length > 0) && (
                    <div className="flex flex-wrap items-center gap-1 mb-1.5 opacity-90">
                      {msg.selection && (
                        <span className="px-1.5 py-0.5 rounded bg-black/25 text-[10px] font-mono">
                          🎯 {formatTimeRange(msg.selection.start, msg.selection.end)}
                        </span>
                      )}
                      {msg.reference_ids.map((rid) => {
                        const found = references.find((r) => r.id === rid);
                        return (
                          <span
                            key={rid}
                            className="px-1.5 py-0.5 rounded bg-black/25 text-[10px] truncate max-w-[140px]"
                          >
                            @{found ? found.title : 'Ref'}
                          </span>
                        );
                      })}
                    </div>
                  )}
                  <div className="whitespace-pre-wrap">{msg.content}</div>
                </div>

                {/* Proposal Option Cards */}
                {!isUser && msg.proposals && msg.proposals.length > 0 && (
                  <div className="w-full mt-2 space-y-2">
                    {msg.proposals.map((proposal) => {
                      const badge = styleBadge(proposal.style);
                      const isPlaying = playingProposalId === proposal.id;
                      const isApplying = applyingId === proposal.id;
                      const hasPreview = Boolean(proposal.preview_url);

                      return (
                        <div
                          key={proposal.id}
                          className={`p-3 rounded-xl border transition-colors ${
                            proposal.applied
                              ? 'bg-emerald-500/[0.06] border-emerald-500/30'
                              : 'bg-[#151824] border-white/[0.08] hover:border-violet-500/35'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <h4 className="text-xs font-semibold text-zinc-100 leading-snug">
                              {proposal.title}
                            </h4>
                            <span
                              className={`text-[10px] font-medium px-1.5 py-0.5 rounded border shrink-0 ${badge.className}`}
                            >
                              {badge.label}
                            </span>
                          </div>

                          <p className="text-[11px] text-zinc-400 mt-1 leading-relaxed">
                            {proposal.summary}
                          </p>

                          <div className="mt-2.5 flex items-center justify-between gap-2">
                            <span className="text-[10px] font-mono text-zinc-500">
                              {formatTimeRange(proposal.start, proposal.end)}
                            </span>

                            <div className="flex items-center gap-1.5">
                              {hasPreview && (
                                <button
                                  type="button"
                                  onClick={() => handleTogglePreview(proposal)}
                                  className={`px-2.5 py-1 rounded-lg text-[11px] font-medium flex items-center gap-1 border transition-colors ${
                                    isPlaying
                                      ? 'bg-amber-500/20 border-amber-500/40 text-amber-200'
                                      : 'bg-white/[0.05] hover:bg-white/[0.1] border-white/10 text-zinc-200'
                                  }`}
                                >
                                  {isPlaying ? (
                                    <>
                                      <Square className="w-2.5 h-2.5 fill-current" />
                                      Stop
                                    </>
                                  ) : (
                                    <>
                                      <Play className="w-2.5 h-2.5 fill-current" />
                                      Preview
                                    </>
                                  )}
                                </button>
                              )}

                              <button
                                type="button"
                                disabled={proposal.applied || isApplying}
                                onClick={() => handleApplyClick(proposal.id)}
                                className={`px-2.5 py-1 rounded-lg text-[11px] font-medium flex items-center gap-1 transition-colors ${
                                  proposal.applied
                                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 cursor-default'
                                    : 'bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-50'
                                }`}
                              >
                                {isApplying ? (
                                  <>
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                    Applying...
                                  </>
                                ) : proposal.applied ? (
                                  <>
                                    <Check className="w-3 h-3" />
                                    Applied
                                  </>
                                ) : (
                                  'Apply to Track'
                                )}
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}

        {sending && (
          <div className="flex items-center gap-2 text-xs text-violet-300 bg-[#181b26] border border-violet-500/25 rounded-xl px-3 py-2.5">
            <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
            <span>Gemini is crafting remix options & rendering previews...</span>
          </div>
        )}

        <div ref={threadEndRef} />
      </div>

      {/* Composer */}
      <div className="p-3 border-t border-white/[0.07] bg-[#10121a] shrink-0 space-y-2">
        {chatError && (
          <div className="text-[11px] text-rose-300 bg-rose-500/10 border border-rose-500/25 rounded-lg px-2.5 py-1.5 flex items-center justify-between gap-2">
            <span className="truncate">{chatError}</span>
            <button
              type="button"
              onClick={() => setChatError(null)}
              className="text-rose-300/70 hover:text-rose-200 shrink-0"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        )}

        {/* Active Context Strip + Auto-send Voice Toggle */}
        <div className="flex flex-wrap items-center justify-between gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5 min-w-0">
            {selection ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-violet-500/15 border border-violet-500/35 text-[11px] text-violet-200 font-mono">
                <Target className="w-3 h-3 text-violet-400" />
                {formatTimeRange(selection.start, selection.end)}
                <button
                  type="button"
                  onClick={onClearSelection}
                  title="Clear selection (use full track)"
                  className="ml-0.5 text-violet-300/70 hover:text-white"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/[0.05] border border-white/[0.08] text-[11px] text-zinc-400">
                <Target className="w-3 h-3 text-zinc-500" />
                Full Track
              </span>
            )}

            {attachedRefs.map((ref) => (
              <span
                key={ref.id}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/12 border border-emerald-500/30 text-[11px] text-emerald-200 max-w-[165px]"
              >
                <AtSign className="w-2.5 h-2.5 shrink-0 text-emerald-400" />
                <span className="truncate">{ref.title}</span>
                <button
                  type="button"
                  onClick={() => onToggleAttachRef(ref.id)}
                  className="text-emerald-300/70 hover:text-white shrink-0"
                  title="Detach reference"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setAutoSendVoice((v) => !v)}
            title={
              autoSendVoice
                ? 'Voice auto-sends straight to Gemini after you stop talking (click to review text first)'
                : 'Voice fills the text box so you can edit before sending (click to enable auto-send)'
            }
            className={`px-2 py-0.5 rounded-full text-[10px] font-medium border flex items-center gap-1 transition-colors shrink-0 ${
              autoSendVoice
                ? 'bg-violet-500/15 border-violet-500/35 text-violet-200'
                : 'bg-white/[0.04] border-white/[0.08] text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Mic className="w-2.5 h-2.5" />
            Auto-send: {autoSendVoice ? 'On' : 'Off'}
          </button>
        </div>

        {/* Live Voice Recording Indicator */}
        {isRecording && (
          <div className="rounded-xl bg-rose-500/10 border border-rose-500/35 px-3 py-2 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-2.5 h-2.5 rounded-full bg-rose-500 animate-pulse shrink-0 shadow-sm shadow-rose-500" />
                <span className="text-xs font-medium text-rose-200">Listening</span>
                <span className="text-[11px] font-mono text-rose-300/90 tabular-nums">
                  {formatTime(recordingSeconds)}
                </span>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => stopVoiceRecording(true)}
                  className="px-2 py-1 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] text-[11px] text-zinc-300 hover:text-white transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => stopVoiceRecording(false)}
                  className="px-2.5 py-1 rounded-lg bg-rose-600 hover:bg-rose-500 text-[11px] font-medium text-white flex items-center gap-1 transition-colors"
                >
                  <Square className="w-2.5 h-2.5 fill-current" />
                  {autoSendVoice ? 'Stop & Send' : 'Stop & Transcribe'}
                </button>
              </div>
            </div>

            {/* Live Audio Level Bar */}
            <div className="h-1.5 w-full rounded-full bg-black/40 overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-emerald-400 via-violet-400 to-rose-400 transition-[width] duration-75"
                style={{ width: `${Math.max(4, Math.round(audioLevel * 100))}%` }}
              />
            </div>
          </div>
        )}

        {/* Transcribing Status Banner */}
        {transcribing && (
          <div className="rounded-xl bg-violet-500/12 border border-violet-500/30 px-3 py-2 flex items-center gap-2 text-xs text-violet-200">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-violet-300 shrink-0" />
            <span>Transcribing voice...</span>
          </div>
        )}

        {/* Textarea + Mic + Send */}
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            rows={2}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={!projectId || sending || isRecording || transcribing}
            placeholder={
              hasMainTrack
                ? 'Type or click the mic to talk to Gemini... (Enter to send)'
                : 'Load a song from YouTube or local file first...'
            }
            className="flex-1 resize-none rounded-xl bg-[#0b0c10] border border-white/10 px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-violet-500/60 disabled:opacity-50"
          />

          <button
            type="button"
            disabled={!projectId || sending || transcribing}
            onClick={() => (isRecording ? stopVoiceRecording(false) : startVoiceRecording())}
            title={
              isRecording
                ? 'Stop recording & transcribe (Ctrl+Shift+M)'
                : 'Talk to Gemini Producer (Ctrl+Shift+M)'
            }
            className={`h-9 w-9 shrink-0 rounded-xl border flex items-center justify-center transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              isRecording
                ? 'bg-rose-600 hover:bg-rose-500 border-rose-400 text-white shadow-sm shadow-rose-950/60 animate-pulse'
                : 'bg-[#181b26] hover:bg-[#24293b] border-white/10 text-zinc-200 hover:text-white'
            }`}
          >
            {transcribing ? (
              <Loader2 className="w-4 h-4 animate-spin text-violet-300" />
            ) : isRecording ? (
              <Square className="w-3.5 h-3.5 fill-current" />
            ) : (
              <Mic className="w-4 h-4" />
            )}
          </button>

          <button
            type="button"
            disabled={!input.trim() || !projectId || sending || isRecording || transcribing}
            onClick={() => handleSubmit()}
            title="Send to Gemini Producer"
            className="h-9 w-9 shrink-0 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed text-white flex items-center justify-center transition-colors shadow-sm shadow-violet-950/50"
          >
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
      </div>
    </aside>
  );
};

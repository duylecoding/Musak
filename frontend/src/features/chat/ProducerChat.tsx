import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KeyRound, Sparkles } from 'lucide-react';
import type { ProposalTunePayload } from '../../shared/api';
import { useProject } from '../../state/ProjectContext';
import { ChatComposer } from './ChatComposer';
import { buildSmartPrompts } from './chatHelpers';
import { ChatThread } from './ChatThread';
import { usePreviewPlayer } from './hooks/usePreviewPlayer';
import { useVoiceRecorder } from './hooks/useVoiceRecorder';
import styles from './ProducerChat.module.css';

export interface ProducerChatProps {
  onOpenSettings: () => void;
}

export const ProducerChat: React.FC<ProducerChatProps> = ({ onOpenSettings }) => {
  const {
    health,
    currentProject,
    selection,
    setSelection,
    attachedRefIds,
    toggleAttachRef,
    draftSnippet,
    focusChatNonce,
    sendChat,
    tuneProposal,
    applyProposal,
  } = useProject();

  const projectId = currentProject?.id ?? null;
  const mainTrack = currentProject?.main_track ?? null;
  const messages = currentProject?.chat_messages ?? [];
  const references = currentProject?.references ?? [];
  const apiKeyConfigured = Boolean(health?.api_key_configured);
  const hasMainTrack = Boolean(mainTrack);

  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [sendingSeconds, setSendingSeconds] = useState(0);
  const [chatError, setChatError] = useState<string | null>(null);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [tuningId, setTuningId] = useState<string | null>(null);
  const [autoSendVoice, setAutoSendVoice] = useState(true);
  const [localFocusNonce, setLocalFocusNonce] = useState(0);

  const projectIdRef = useRef(projectId);
  const sendingRef = useRef(sending);
  const unmountedRef = useRef(false);
  const autoSendVoiceRef = useRef(autoSendVoice);
  const hasMainTrackRef = useRef(hasMainTrack);

  projectIdRef.current = projectId;
  sendingRef.current = sending;
  autoSendVoiceRef.current = autoSendVoice;
  hasMainTrackRef.current = hasMainTrack;

  const { playingProposalId, stopPreview, togglePreview } = usePreviewPlayer(projectId, setChatError);

  const attachedRefs = useMemo(
    () => references.filter((r) => attachedRefIds.includes(r.id)),
    [references, attachedRefIds]
  );

  const smartPrompts = useMemo(
    () => buildSmartPrompts(mainTrack, selection, attachedRefs, references),
    [mainTrack, selection, attachedRefs, references]
  );

  useEffect(() => {
    unmountedRef.current = false;
    return () => { unmountedRef.current = true; };
  }, []);

  useEffect(() => {
    if (!draftSnippet?.text) return;
    setInput((prev) => `${prev.trim()}${prev.trim() ? ' ' : ''}${draftSnippet.text} `);
    setLocalFocusNonce((n) => n + 1);
  }, [draftSnippet]);

  useEffect(() => {
    if (!sending) { setSendingSeconds(0); return; }
    const startedAt = Date.now();
    setSendingSeconds(0);
    const timer = window.setInterval(() => setSendingSeconds(Math.floor((Date.now() - startedAt) / 1000)), 500);
    return () => window.clearInterval(timer);
  }, [sending]);

  useEffect(() => { setChatError(null); }, [projectId]);

  const handleSubmit = useCallback(async (textOverride?: string) => {
    const activePid = projectIdRef.current;
    const content = (textOverride ?? input).trim();
    if (!content || !activePid || sendingRef.current) return;
    if (!apiKeyConfigured) { onOpenSettings(); return; }
    if (!hasMainTrackRef.current) {
      setChatError('Load a song in the center stage first so Gemini can remix it.');
      return;
    }
    setChatError(null);
    sendingRef.current = true;
    setSending(true);
    if (textOverride === undefined) setInput('');
    try {
      await sendChat(content);
    } catch (err) {
      if (!unmountedRef.current && projectIdRef.current === activePid) {
        setChatError(err instanceof Error ? err.message : 'Gemini producer request failed.');
      }
    } finally {
      sendingRef.current = false;
      if (!unmountedRef.current) setSending(false);
    }
  }, [input, apiKeyConfigured, onOpenSettings, sendChat]);

  const handleVoiceTranscript = useCallback(async (transcript: string) => {
    if (autoSendVoiceRef.current && hasMainTrackRef.current) {
      await handleSubmit(transcript);
      return;
    }
    setInput((prev) => `${prev.trim()}${prev.trim() ? ' ' : ''}${transcript}`);
    setLocalFocusNonce((n) => n + 1);
    if (autoSendVoiceRef.current && !hasMainTrackRef.current) {
      setChatError('Transcript ready! Load a song in the center stage first, then hit Send.');
    }
  }, [handleSubmit]);

  const voice = useVoiceRecorder({
    projectId,
    apiKeyConfigured,
    sending,
    onOpenSettings,
    onBeforeStart: stopPreview,
    onError: setChatError,
    onTranscript: handleVoiceTranscript,
  });

  const handleApplyClick = async (proposalId: string) => {
    if (applyingId) return;
    stopPreview();
    setApplyingId(proposalId);
    setChatError(null);
    try { await applyProposal(proposalId); }
    catch (err) { setChatError(err instanceof Error ? err.message : 'Failed to apply edit.'); }
    finally { setApplyingId(null); }
  };

  const handleTuneClick = async (proposalId: string, payload: ProposalTunePayload): Promise<boolean> => {
    if (tuningId) return false;
    if (playingProposalId === proposalId) stopPreview();
    setTuningId(proposalId);
    setChatError(null);
    try { await tuneProposal(proposalId, payload); return true; }
    catch (err) { setChatError(err instanceof Error ? err.message : 'Could not update proposal preview.'); return false; }
    finally { setTuningId(null); }
  };

  return (
    <aside className={styles.aside}>
      <div className={styles.header}>
        <div>
          <h2 className={styles.headerTitle}>
            <Sparkles className={styles.headerIcon} />
            Gemini Producer
          </h2>
          <p className={styles.headerSubtitle}>Describe the vibe — tune, preview &amp; apply</p>
        </div>
        <span className={styles.copilotBadge}>Co-Pilot</span>
      </div>

      {!apiKeyConfigured && (
        <div className={styles.apiBanner}>
          <KeyRound className={styles.apiBannerIcon} />
          <div className={styles.apiBannerBody}>
            <p className={styles.apiBannerTitle}>Gemini API Key needed</p>
            <p className={styles.apiBannerText}>Add your Google AI Studio key to unlock AI remix suggestions and voice control.</p>
            <button type="button" onClick={onOpenSettings} className={styles.apiBannerBtn}>Configure API Key</button>
          </div>
        </div>
      )}

      <ChatThread
        projectId={projectId}
        messages={messages}
        references={references}
        smartPrompts={smartPrompts}
        sending={sending}
        sendingSeconds={sendingSeconds}
        playingProposalId={playingProposalId}
        applyingId={applyingId}
        tuningId={tuningId}
        onSendPrompt={(prompt) => void handleSubmit(prompt)}
        onTogglePreview={togglePreview}
        onApply={(id) => void handleApplyClick(id)}
        onTune={handleTuneClick}
      />

      <ChatComposer
        projectId={projectId}
        hasMainTrack={hasMainTrack}
        selection={selection}
        attachedRefs={attachedRefs}
        input={input}
        sending={sending}
        chatError={chatError}
        autoSendVoice={autoSendVoice}
        isRecording={voice.isRecording}
        transcribing={voice.transcribing}
        recordingSeconds={voice.recordingSeconds}
        audioLevel={voice.audioLevel}
        focusNonce={focusChatNonce + localFocusNonce}
        onInputChange={setInput}
        onSubmit={() => void handleSubmit()}
        onClearSelection={() => setSelection(null)}
        onToggleAttachRef={toggleAttachRef}
        onToggleAutoSendVoice={() => setAutoSendVoice((v) => !v)}
        onDismissError={() => setChatError(null)}
        onStartRecording={() => void voice.startRecording()}
        onStopRecording={voice.stopRecording}
      />
    </aside>
  );
};

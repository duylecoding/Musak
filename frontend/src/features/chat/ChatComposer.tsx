import React, { useEffect, useRef } from 'react';
import { AtSign, Loader2, Mic, Send, Square, Target, X } from 'lucide-react';
import type { ReferenceTrack, TimeSelection } from '../../shared/api';
import { formatTime, formatTimeRange } from '../../shared/utils/format';
import { HelpTip } from '../../shared/components/Tooltip/Tooltip';
import { formatLanePrefix } from './chatHelpers';
import styles from './ChatComposer.module.css';

export interface ChatComposerProps {
  projectId: string | null;
  hasMainTrack: boolean;
  selection: TimeSelection | null;
  attachedRefs: ReferenceTrack[];
  input: string;
  sending: boolean;
  chatError: string | null;
  autoSendVoice: boolean;
  isRecording: boolean;
  transcribing: boolean;
  recordingSeconds: number;
  audioLevel: number;
  focusNonce: number;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
  onClearSelection: () => void;
  onToggleAttachRef: (refId: string) => void;
  onToggleAutoSendVoice: () => void;
  onDismissError: () => void;
  onStartRecording: () => void;
  onStopRecording: (cancel?: boolean) => void;
}

export const ChatComposer: React.FC<ChatComposerProps> = ({
  projectId, hasMainTrack, selection, attachedRefs, input, sending, chatError, autoSendVoice,
  isRecording, transcribing, recordingSeconds, audioLevel, focusNonce,
  onInputChange, onSubmit, onClearSelection, onToggleAttachRef, onToggleAutoSendVoice,
  onDismissError, onStartRecording, onStopRecording,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (focusNonce) textareaRef.current?.focus();
  }, [focusNonce]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className={styles.composer}>
      {chatError && (
        <div className={styles.errorBanner} role="alert">
          <span className={styles.errorText}>{chatError}</span>
          <button type="button" onClick={onDismissError} className={styles.errorDismiss} aria-label="Dismiss error">
            <X className={styles.iconSm} />
          </button>
        </div>
      )}

      <div className={styles.contextStrip}>
        <div className={styles.contextPills}>
          {selection ? (
            <HelpTip content="Gemini will focus your next remix request on this highlighted instrument lane & time range.">
              <span className={styles.selectionPill}>
                <Target className={`${styles.iconSm} ${styles.iconAccent}`} />
                <span>{formatLanePrefix(selection.lane)}{formatTimeRange(selection.start, selection.end)}</span>
                <button type="button" onClick={onClearSelection} title="Clear selection" aria-label="Clear selection" className={styles.pillCloseBtn}>
                  <X className={styles.iconSm} />
                </button>
              </span>
            </HelpTip>
          ) : hasMainTrack ? (
            <HelpTip content="Highlighting a short 4–16 bar moment on any stem lane keeps edits surgical, fast to preview, and true to the song.">
              <span className={styles.nudgePill}>
                <Target className={`${styles.iconSm} ${styles.iconAccent}`} />
                <span>Drag a short moment on the waveform for sharper, faster tweaks</span>
              </span>
            </HelpTip>
          ) : (
            <span className={styles.mutedPill}><Target className={styles.iconSm} /><span>Load a track to start</span></span>
          )}

          {attachedRefs.map((ref) => (
            <span key={ref.id} className={styles.refChip}>
              <AtSign className={styles.iconXs} />
              <span className={styles.refChipText}>{ref.title}</span>
              <button type="button" onClick={() => onToggleAttachRef(ref.id)} title="Detach reference" aria-label={`Detach ${ref.title}`} className={styles.pillCloseBtn}>
                <X className={styles.iconSm} />
              </button>
            </span>
          ))}
        </div>

        <HelpTip title="Auto-Send Voice" content={autoSendVoice ? 'On: stopping the mic automatically transcribes and sends your instruction straight to Gemini.' : 'Off: stopping the mic drops your spoken words into the text box so you can review or edit before sending.'}>
          <button type="button" onClick={onToggleAutoSendVoice} aria-pressed={autoSendVoice} className={autoSendVoice ? `${styles.autoSendBtn} ${styles.autoSendBtnActive}` : styles.autoSendBtn}>
            <Mic className={styles.iconXs} />
            Auto-send: {autoSendVoice ? 'On' : 'Off'}
          </button>
        </HelpTip>
      </div>

      {isRecording && (
        <div className={styles.recordingBox}>
          <div className={styles.recordingTop}>
            <div className={styles.recordingStatus}>
              <span className={styles.recordingDot} />
              <span className={styles.recordingLabel}>Listening</span>
              <span className={styles.recordingTime}>{formatTime(recordingSeconds)}</span>
            </div>
            <div className={styles.recordingActions}>
              <button type="button" onClick={() => onStopRecording(true)} className={styles.cancelRecBtn}>Cancel</button>
              <button type="button" onClick={() => onStopRecording(false)} className={styles.stopRecBtn}>
                <Square className={`${styles.iconXs} ${styles.iconFill}`} />
                {autoSendVoice ? 'Stop & Send' : 'Stop & Transcribe'}
              </button>
            </div>
          </div>
          <div className={styles.meterTrack}>
            <div className={styles.meterFill} style={{ width: `${Math.max(4, Math.round(audioLevel * 100))}%` }} />
          </div>
        </div>
      )}

      {transcribing && (
        <div className={styles.transcribingBanner}>
          <Loader2 className={`${styles.iconSm} ${styles.spin}`} />
          <span>Transcribing voice...</span>
        </div>
      )}

      <div className={styles.inputRow}>
        <textarea
          ref={textareaRef}
          rows={2}
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!projectId || sending || isRecording || transcribing}
          placeholder={hasMainTrack ? 'Ask for one quick tweak on this moment...' : 'Load a song from YouTube or local file first...'}
          className={styles.textarea}
        />
        <HelpTip title="Voice Producer (Ctrl+Shift+M)" content={isRecording ? 'Click to stop listening and turn your speech into a remix command.' : 'Click and talk naturally to tell Gemini what you want to change in the track.'}>
          <button
            type="button"
            disabled={!projectId || sending || transcribing}
            onClick={() => (isRecording ? onStopRecording(false) : onStartRecording())}
            aria-label={isRecording ? 'Stop voice recording' : 'Start voice recording'}
            className={isRecording ? `${styles.iconBtn} ${styles.micBtnActive}` : `${styles.iconBtn} ${styles.micBtn}`}
          >
            {transcribing ? <Loader2 className={`${styles.iconMd} ${styles.spin}`} /> : isRecording ? <Square className={`${styles.iconSm} ${styles.iconFill}`} /> : <Mic className={styles.iconMd} />}
          </button>
        </HelpTip>
        <HelpTip content="Send your remix instruction to Gemini Producer.">
          <button
            type="button"
            disabled={!input.trim() || !projectId || sending || isRecording || transcribing}
            onClick={onSubmit}
            aria-label="Send to Gemini Producer"
            className={`${styles.iconBtn} ${styles.sendBtn}`}
          >
            {sending ? <Loader2 className={`${styles.iconMd} ${styles.spin}`} /> : <Send className={styles.iconMd} />}
          </button>
        </HelpTip>
      </div>
    </div>
  );
};

import React, { useEffect, useRef } from 'react';
import { Loader2, Wand2 } from 'lucide-react';
import type { ChatMessage, EditProposal, ProposalTunePayload, ReferenceTrack } from '../../shared/api';
import { formatTimeRange } from '../../shared/utils/format';
import { formatLanePrefix } from './chatHelpers';
import { ProposalCard } from './ProposalCard';
import styles from './ProducerChat.module.css';

interface ChatThreadProps {
  projectId: string | null;
  messages: ChatMessage[];
  references: ReferenceTrack[];
  smartPrompts: string[];
  sending: boolean;
  sendingSeconds: number;
  playingProposalId: string | null;
  applyingId: string | null;
  tuningId: string | null;
  onSendPrompt: (prompt: string) => void;
  onTogglePreview: (proposal: EditProposal) => void;
  onApply: (proposalId: string) => void;
  onTune: (proposalId: string, payload: ProposalTunePayload) => Promise<boolean>;
}

export const ChatThread: React.FC<ChatThreadProps> = ({
  projectId,
  messages,
  references,
  smartPrompts,
  sending,
  sendingSeconds,
  playingProposalId,
  applyingId,
  tuningId,
  onSendPrompt,
  onTogglePreview,
  onApply,
  onTune,
}) => {
  const threadEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, sending]);

  return (
  <div className={styles.thread}>
    {messages.length === 0 ? (
      <div className={styles.emptyState}>
        <div className={styles.emptyHero}>
          <div className={styles.emptyIconBox}><Wand2 className={styles.emptyIcon} /></div>
          <h3 className={styles.emptyTitle}>Ready to remix together</h3>
          <p className={styles.emptySubtitle}>
            Highlight a moment on the waveform (or leave the full track selected) and type or speak how you want it to feel.
          </p>
        </div>
        <div className={styles.promptSection}>
          <div className={styles.promptLabel}>Smart ideas for your track</div>
          {smartPrompts.map((prompt) => (
            <button key={prompt} type="button" disabled={sending || !projectId} onClick={() => onSendPrompt(prompt)} className={styles.promptBtn}>
              “{prompt}”
            </button>
          ))}
        </div>
      </div>
    ) : (
      messages.map((msg) => {
        const isUser = msg.role === 'user';
        return (
          <div key={msg.id} className={`${styles.messageRow} ${isUser ? styles.messageRowUser : styles.messageRowAssistant}`}>
            <div className={`${styles.bubble} ${isUser ? styles.bubbleUser : styles.bubbleAssistant}`}>
              {isUser && (msg.selection || msg.reference_ids.length > 0) && (
                <div className={styles.bubbleMeta}>
                  {msg.selection && (
                    <span className={styles.bubbleChip}>
                      {formatLanePrefix(msg.selection.lane)}{formatTimeRange(msg.selection.start, msg.selection.end)}
                    </span>
                  )}
                  {msg.reference_ids.map((rid) => {
                    const found = references.find((r) => r.id === rid);
                    return <span key={rid} className={styles.bubbleChip}>@{found ? found.title : 'Ref'}</span>;
                  })}
                </div>
              )}
              <div className={styles.bubbleText}>{msg.content}</div>
            </div>
            {!isUser && msg.proposals?.length > 0 && (
              <div className={styles.proposalList}>
                {msg.proposals.map((proposal) => (
                  <ProposalCard
                    key={proposal.id}
                    proposal={proposal}
                    isPlaying={playingProposalId === proposal.id}
                    isApplying={applyingId === proposal.id}
                    isTuning={tuningId === proposal.id}
                    anyTuning={Boolean(tuningId)}
                    sending={sending}
                    onTogglePreview={() => onTogglePreview(proposal)}
                    onApply={() => onApply(proposal.id)}
                    onTune={(payload) => onTune(proposal.id, payload)}
                    onTryAnother={() => onSendPrompt(`Give me a fresh alternative to "${proposal.title}" around ${formatTimeRange(proposal.start, proposal.end)}`)}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })
    )}
    {sending && (
      <div className={styles.thinkingBanner}>
        <div className={styles.thinkingRow}>
          <Loader2 className={`${styles.iconSm} ${styles.spin}`} />
          <span>Gemini is thinking...</span>
        </div>
        <span className={styles.thinkingTimer}>{sendingSeconds}s</span>
      </div>
    )}
    <div ref={threadEndRef} />
  </div>
  );
};

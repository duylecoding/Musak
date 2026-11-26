import React, { useState } from 'react';
import { Loader2, Pin, Plus, Trash2 } from 'lucide-react';
import type { MomentPin } from '../../shared/api';
import { HelpTip } from '../../shared/components/Tooltip/Tooltip';
import { formatTime, parseTimeInput } from '../../shared/utils/format';
import styles from './MomentPinsList.module.css';

export interface MomentPinsListProps {
  moments: MomentPin[];
  canDropMoment?: boolean;
  onPlayMoment: (moment: MomentPin) => void;
  onAddMoment: (payload: {
    label: string;
    start: number;
    end: number;
    note?: string;
  }) => Promise<void>;
  onDeleteMoment: (momentId: string) => Promise<void>;
  onDropMoment?: (moment: MomentPin) => void;
  onSendMomentToChat: (moment: MomentPin) => void;
}

export const MomentPinsList: React.FC<MomentPinsListProps> = ({
  moments,
  canDropMoment = false,
  onPlayMoment,
  onAddMoment,
  onDeleteMoment,
  onDropMoment,
  onSendMomentToChat,
}) => {
  const [pinFormOpen, setPinFormOpen] = useState(false);
  const [pinLabel, setPinLabel] = useState('');
  const [pinStart, setPinStart] = useState('');
  const [pinEnd, setPinEnd] = useState('');
  const [pinNote, setPinNote] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [savingPin, setSavingPin] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPinError(null);
    const label = pinLabel.trim();
    const startSec = parseTimeInput(pinStart);
    const endSec = pinEnd.trim() ? parseTimeInput(pinEnd) : startSec !== null ? startSec + 8 : null;

    if (!label) { setPinError('Add a short label (e.g. "Beat Drop").'); return; }
    if (startSec === null) { setPinError('Enter start time like 1:12 or 72.'); return; }
    if (endSec === null || endSec <= startSec) { setPinError('End time must be after start time.'); return; }

    setSavingPin(true);
    try {
      await onAddMoment({ label, start: startSec, end: endSec, note: pinNote.trim() || undefined });
      setPinLabel('');
      setPinStart('');
      setPinEnd('');
      setPinNote('');
      setPinFormOpen(false);
    } catch (err) {
      setPinError(err instanceof Error ? err.message : 'Failed to pin moment.');
    } finally {
      setSavingPin(false);
    }
  };

  return (
    <div className={styles.momentsSection}>
      <div className={styles.momentsHeader}>
        <span className={styles.momentsLabel}>
          <Pin size={10} />
          Pinned Moments ({moments.length})
        </span>
        <HelpTip content="Bookmark a timestamp you love so you can jump back to it or mention it to Gemini.">
          <button
            type="button"
            onClick={() => { setPinFormOpen((prev) => !prev); setPinError(null); }}
            className={styles.pinToggleBtn}
          >
            <Plus size={12} />
            Pin Moment
          </button>
        </HelpTip>
      </div>

      {pinFormOpen && (
        <form onSubmit={handleSubmit} className={styles.pinForm}>
          <input
            type="text"
            value={pinLabel}
            onChange={(e) => setPinLabel(e.target.value)}
            placeholder="Label (e.g. Heavy Bass Drop)"
            className={styles.pinInput}
          />
          <div className={styles.pinInputGrid}>
            <input
              type="text"
              value={pinStart}
              onChange={(e) => setPinStart(e.target.value)}
              placeholder="Start (e.g. 1:12)"
              className={styles.pinInput}
            />
            <input
              type="text"
              value={pinEnd}
              onChange={(e) => setPinEnd(e.target.value)}
              placeholder="End (e.g. 1:24)"
              className={styles.pinInput}
            />
          </div>
          <input
            type="text"
            value={pinNote}
            onChange={(e) => setPinNote(e.target.value)}
            placeholder="Optional vibe note..."
            className={styles.pinInput}
          />
          {pinError && <div className={styles.errorText}>{pinError}</div>}
          <div className={styles.pinFormActions}>
            <button type="button" onClick={() => setPinFormOpen(false)} className={styles.pinCancelBtn}>
              Cancel
            </button>
            <button type="submit" disabled={savingPin} className={styles.pinSaveBtn}>
              {savingPin && <Loader2 size={10} className={styles.spinner} />}
              Save Pin
            </button>
          </div>
        </form>
      )}

      {moments.length === 0 ? (
        <p className={styles.momentsEmpty}>Pin a timestamp or hit Auto-Tag to mark cool moments.</p>
      ) : (
        <div className={styles.momentsList}>
          {moments.map((moment) => (
            <div key={moment.id} className={styles.momentRow}>
              <button
                type="button"
                onClick={() => onPlayMoment(moment)}
                className={styles.momentPlayBtn}
                title={moment.note || `Play from ${formatTime(moment.start)}`}
              >
                <span className={styles.momentTime}>{formatTime(moment.start)}</span>
                <span className={styles.momentName}>{moment.label}</span>
                <span className={moment.source === 'gemini' ? styles.momentSourceAi : styles.momentSourceUser}>
                  {moment.source === 'gemini' ? 'AI' : 'You'}
                </span>
              </button>

              <div className={styles.momentActions}>
                {onDropMoment && (
                  <HelpTip content="Drop this exact pinned moment onto a Sound Layer at your playhead">
                    <button
                      type="button"
                      disabled={!canDropMoment}
                      onClick={() => onDropMoment(moment)}
                      className={styles.momentDropBtn}
                    >
                      + Drop
                    </button>
                  </HelpTip>
                )}
                <HelpTip content="Attach this exact timestamp and song into your Gemini Producer chat box.">
                  <button type="button" onClick={() => onSendMomentToChat(moment)} className={styles.momentChatBtn}>
                    @Chat
                  </button>
                </HelpTip>
                <button
                  type="button"
                  onClick={() => void onDeleteMoment(moment.id)}
                  aria-label={`Delete pin ${moment.label}`}
                  title="Delete pin"
                  className={styles.momentDeleteBtn}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

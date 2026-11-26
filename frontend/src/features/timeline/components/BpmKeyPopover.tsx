import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { Popover } from '../../../shared/components/Popover/Popover';
import styles from './BpmKeyPopover.module.css';

const MUSICAL_KEYS = [
  'C Major', 'C# Major', 'D Major', 'Eb Major', 'E Major', 'F Major',
  'F# Major', 'G Major', 'Ab Major', 'A Major', 'Bb Major', 'B Major',
  'C Minor', 'C# Minor', 'D Minor', 'Eb Minor', 'E Minor', 'F Minor',
  'F# Minor', 'G Minor', 'G# Minor', 'A Minor', 'Bb Minor', 'B Minor',
] as const;

export interface BpmKeyPopoverProps {
  open: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  bpm: number;
  musicalKey: string;
  onClose: () => void;
  onApply: (payload: { bpm?: number; key?: string }) => Promise<void>;
}

function clampBpm(val: number): number {
  return Math.max(40, Math.min(240, Math.round(val * 10) / 10));
}

export const BpmKeyPopover: React.FC<BpmKeyPopoverProps> = ({
  open,
  anchorRef,
  bpm,
  musicalKey,
  onClose,
  onApply,
}) => {
  const [bpmDraft, setBpmDraft] = useState(String(bpm || 120));
  const [keyDraft, setKeyDraft] = useState(musicalKey || 'C Major');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setBpmDraft(String(bpm > 0 ? Math.round(bpm * 10) / 10 : 120));
    setKeyDraft(musicalKey || 'C Major');
    // Reset drafts only when opening popover so ÷2/×2 doesn't wipe an unsaved key selection
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const parsedBpm = Number(bpmDraft);
  const validBpm = Number.isFinite(parsedBpm) && parsedBpm >= 40 && parsedBpm <= 240;

  const handleRatio = async (factor: 0.5 | 2) => {
    const base = Number.isFinite(parsedBpm) && parsedBpm > 0 ? parsedBpm : bpm || 120;
    const nextBpm = clampBpm(base * factor);
    setBpmDraft(String(nextBpm));
    setBusy(true);
    try {
      await onApply({ bpm: nextBpm });
    } finally {
      setBusy(false);
    }
  };

  const handleApply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validBpm || busy) return;
    setBusy(true);
    try {
      await onApply({ bpm: clampBpm(parsedBpm), key: keyDraft });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const keyOptions = MUSICAL_KEYS.includes(keyDraft as (typeof MUSICAL_KEYS)[number])
    ? [...MUSICAL_KEYS]
    : [keyDraft, ...MUSICAL_KEYS];

  return (
    <Popover anchorRef={anchorRef} open={open} onClose={onClose} width={264} ariaLabel="BPM and Key Override">
      <form onSubmit={(e) => void handleApply(e)} className={styles.body}>
        <div className={styles.header}>
          <div>
            <div className={styles.title}>Tempo &amp; Key Override</div>
            <div className={styles.subtitle}>Fix half/double-time BPM or key detection</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className={styles.closeBtn}>
            <X className={styles.iconSm} />
          </button>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="bpm-override-input">BPM (40–240)</label>
          <div className={styles.bpmRow}>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleRatio(0.5)}
              className={styles.ratioBtn}
            >
              ÷2
            </button>
            <input
              id="bpm-override-input"
              type="number"
              min={40}
              max={240}
              step={0.1}
              value={bpmDraft}
              onChange={(e) => setBpmDraft(e.target.value)}
              className={styles.bpmInput}
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleRatio(2)}
              className={styles.ratioBtn}
            >
              ×2
            </button>
          </div>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="key-override-select">Musical Key</label>
          <select
            id="key-override-select"
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            className={styles.select}
          >
            {keyOptions.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </div>

        <button type="submit" disabled={!validBpm || busy} className={styles.applyBtn}>
          {busy ? 'Saving...' : 'Apply'}
        </button>
      </form>
    </Popover>
  );
};

import React, { useEffect, useState } from 'react';
import type { EditOperation, EditUpdatePayload } from '../../../shared/api';
import { AUTO_DUCK_PRESETS } from '../constants';
import { sameStemSet } from '../utils';
import styles from './ClipBorrowControls.module.css';

export interface ClipBorrowControlsProps {
  op: EditOperation;
  busy: boolean;
  onUpdate: (patch: EditUpdatePayload) => Promise<void>;
}

export const ClipBorrowControls: React.FC<ClipBorrowControlsProps> = ({
  op,
  busy,
  onUpdate,
}) => {
  const savedStart = op.ref_start ?? 0;
  const savedEnd = op.ref_end ?? savedStart + 4;
  const [startDraft, setStartDraft] = useState(String(savedStart));
  const [endDraft, setEndDraft] = useState(String(savedEnd));

  useEffect(() => {
    setStartDraft(String(op.ref_start ?? 0));
    setEndDraft(String(op.ref_end ?? (op.ref_start ?? 0) + 4));
  }, [op.ref_start, op.ref_end]);

  const commitRange = () => {
    const nextStart = Math.max(0, Number(startDraft));
    const nextEnd = Number(endDraft);
    if (!Number.isFinite(nextStart) || !Number.isFinite(nextEnd) || nextEnd <= nextStart + 0.05) {
      setStartDraft(String(savedStart));
      setEndDraft(String(savedEnd));
      return;
    }
    if (Math.abs(nextStart - savedStart) < 0.01 && Math.abs(nextEnd - savedEnd) < 0.01) return;
    void onUpdate({ ref_start: nextStart, ref_end: nextEnd });
  };

  const matchBpm = op.match_bpm ?? true;
  const matchKey = op.match_key ?? op.ref_stem !== 'drums';
  const loopToFit = Boolean(op.loop_to_fit);

  return (
    <div className={styles.section}>
      <span className={styles.groupLabel}>Source Slice (sec)</span>
      <div className={styles.rangeGrid}>
        <label className={styles.numWrap}>
          <span className={styles.numTag}>Start</span>
          <input
            type="number"
            min={0}
            step={0.1}
            disabled={busy}
            aria-label="Borrow Source Start"
            value={startDraft}
            onChange={(e) => setStartDraft(e.target.value)}
            onBlur={commitRange}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
            className={styles.numInput}
          />
        </label>
        <label className={styles.numWrap}>
          <span className={styles.numTag}>End</span>
          <input
            type="number"
            min={0.1}
            step={0.1}
            disabled={busy}
            aria-label="Borrow Source End"
            value={endDraft}
            onChange={(e) => setEndDraft(e.target.value)}
            onBlur={commitRange}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
            className={styles.numInput}
          />
        </label>
      </div>

      <span className={styles.groupLabel}>Auto-Duck Main</span>
      <div className={styles.chipRow}>
        {AUTO_DUCK_PRESETS.map((preset) => {
          const active = sameStemSet(op.replace_main_stems, preset.stems);
          return (
            <button
              key={preset.id}
              type="button"
              disabled={busy}
              aria-pressed={active}
              onClick={() => void onUpdate({ replace_main_stems: preset.stems })}
              className={active ? `${styles.chip} ${styles.chipActive}` : styles.chip}
            >
              {preset.label}
            </button>
          );
        })}
      </div>

      <div className={styles.checksGrid}>
        <label className={styles.checkLabel}>
          <input
            type="checkbox"
            disabled={busy}
            checked={matchBpm}
            onChange={(e) => void onUpdate({ match_bpm: e.target.checked })}
            className={styles.checkbox}
          />
          <span>Match BPM</span>
        </label>
        <label className={styles.checkLabel}>
          <input
            type="checkbox"
            disabled={busy}
            checked={matchKey}
            onChange={(e) => void onUpdate({ match_key: e.target.checked })}
            className={styles.checkbox}
          />
          <span>Match Key</span>
        </label>
        <label className={styles.checkLabel}>
          <input
            type="checkbox"
            disabled={busy}
            checked={loopToFit}
            onChange={(e) => void onUpdate({ loop_to_fit: e.target.checked })}
            className={styles.checkbox}
          />
          <span>Loop Audio to Fit</span>
        </label>
      </div>
    </div>
  );
};

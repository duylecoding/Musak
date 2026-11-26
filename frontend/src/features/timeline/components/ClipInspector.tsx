import React, { useEffect, useState } from 'react';
import { Loader2, Trash2, X } from 'lucide-react';
import type { EditBlock, EditUpdatePayload } from '../../../shared/api';
import { Popover } from '../../../shared/components/Popover/Popover';
import { formatTimeRange } from '../../../shared/utils/format';
import { editSupportsGain, getEditGainDb } from '../../../shared/utils/timelineMath';
import { getClipEmoji } from '../utils';
import styles from './ClipInspector.module.css';

export interface ClipInspectorProps {
  edit: EditBlock | null;
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onUpdateEdit: (editId: string, patch: EditUpdatePayload) => Promise<void>;
  onDeleteEdit: (editId: string) => Promise<void>;
}

export const ClipInspector: React.FC<ClipInspectorProps> = ({
  edit,
  anchorRef,
  onClose,
  onUpdateEdit,
  onDeleteEdit,
}) => {
  const [gainDraft, setGainDraft] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (edit) {
      setGainDraft(getEditGainDb(edit));
    }
  }, [edit]);

  const commitGain = async (nextGain: number) => {
    if (!edit || Math.abs(nextGain - getEditGainDb(edit)) < 0.01) return;
    setBusy(true);
    try {
      await onUpdateEdit(edit.id, { gain_db: nextGain });
    } catch {
      setGainDraft(getEditGainDb(edit));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover
      anchorRef={anchorRef}
      open={Boolean(edit)}
      onClose={onClose}
      width={256}
      ariaLabel="Edit clip inspector"
    >
      {edit && (
        <div className={styles.body}>
          <div className={styles.header}>
            <div className={styles.meta}>
              <div className={styles.title}>
                {getClipEmoji(edit)} {edit.title}
              </div>
              <div className={styles.range}>{formatTimeRange(edit.start, edit.end)}</div>
            </div>
            <button type="button" onClick={onClose} aria-label="Close inspector" className={styles.closeBtn}>
              <X className={styles.iconSm} />
            </button>
          </div>

          {edit.description && <p className={styles.desc}>{edit.description}</p>}

          <div className={styles.switchRow}>
            <span className={styles.rowLabel}>Active in Remix</span>
            <button
              type="button"
              role="switch"
              aria-checked={edit.enabled}
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onUpdateEdit(edit.id, { enabled: !edit.enabled });
                } catch {
                  // toast handled by context
                } finally {
                  setBusy(false);
                }
              }}
              className={edit.enabled ? `${styles.switchBtn} ${styles.switchOn}` : styles.switchBtn}
            >
              <span
                className={
                  edit.enabled ? `${styles.switchThumb} ${styles.switchThumbOn}` : styles.switchThumb
                }
              />
            </button>
          </div>

          {editSupportsGain(edit) && (
            <div className={styles.gainBlock}>
              <div className={styles.gainHeader}>
                <span className={styles.rowLabel}>Clip Level</span>
                <span className={styles.gainValue}>
                  {gainDraft > 0 ? `+${gainDraft}` : gainDraft} dB
                </span>
              </div>
              <input
                type="range"
                min={-24}
                max={12}
                step={1}
                value={Math.max(-24, Math.min(12, gainDraft))}
                onChange={(e) => setGainDraft(Number(e.target.value))}
                onPointerUp={(e) => void commitGain(Number(e.currentTarget.value))}
                onKeyUp={(e) => void commitGain(Number(e.currentTarget.value))}
                aria-label="Clip Level"
                className={styles.gainSlider}
              />
            </div>
          )}

          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onDeleteEdit(edit.id);
                onClose();
              } catch {
                // toast handled by context
              } finally {
                setBusy(false);
              }
            }}
            className={styles.deleteBtn}
          >
            {busy ? <Loader2 className={styles.iconSpin} /> : <Trash2 className={styles.iconSm} />}
            Delete Edit
          </button>
        </div>
      )}
    </Popover>
  );
};

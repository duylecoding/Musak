import React, { useEffect, useState } from 'react';
import { Copy, Loader2, Trash2, X } from 'lucide-react';
import type { EditBlock, EditUpdatePayload } from '../../../shared/api';
import { Popover } from '../../../shared/components/Popover/Popover';
import { formatTimeRange } from '../../../shared/utils/format';
import { editSupportsGain, getEditGainDb } from '../../../shared/utils/timelineMath';
import { getClipEmoji } from '../utils';
import { ClipBorrowControls } from './ClipBorrowControls';
import { ClipFxControls } from './ClipFxControls';
import styles from './ClipInspector.module.css';

const FX_TYPES = new Set(['filter_sweep', 'reverb_throw', 'delay_throw', 'lofi_eq', 'bass_boost', 'beat_repeat']);
const FADE_TYPES = new Set(['borrow_stem', 'add_sfx', 'stem_gain']);
const FADE_OPTIONS = [
  { label: 'None', ms: 0 },
  { label: '0.5s', ms: 500 },
  { label: '1s', ms: 1000 },
  { label: '2s', ms: 2000 },
  { label: '4s', ms: 4000 },
] as const;

export interface ClipInspectorProps {
  edit: EditBlock | null;
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onUpdateEdit: (editId: string, patch: EditUpdatePayload) => Promise<void>;
  onDuplicateEdit?: (editId: string) => Promise<void>;
  onDeleteEdit: (editId: string) => Promise<void>;
}

export const ClipInspector: React.FC<ClipInspectorProps> = ({
  edit, anchorRef, onClose, onUpdateEdit, onDuplicateEdit, onDeleteEdit,
}) => {
  const [titleDraft, setTitleDraft] = useState('');
  const [gainDraft, setGainDraft] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (edit) {
      setTitleDraft(edit.title);
      setGainDraft(getEditGainDb(edit));
    }
  }, [edit]);

  const runUpdate = async (patch: EditUpdatePayload) => {
    if (!edit) return;
    setBusy(true);
    try { await onUpdateEdit(edit.id, patch); }
    catch { /* toast handled by context */ }
    finally { setBusy(false); }
  };

  const commitTitle = () => {
    if (!edit) return;
    const trimmed = titleDraft.trim();
    if (!trimmed || trimmed === edit.title) { setTitleDraft(edit.title); return; }
    void runUpdate({ title: trimmed });
  };

  const commitGain = async (nextGain: number) => {
    if (!edit || Math.abs(nextGain - getEditGainDb(edit)) < 0.01) return;
    setBusy(true);
    try { await onUpdateEdit(edit.id, { gain_db: nextGain }); }
    catch { setGainDraft(getEditGainDb(edit)); }
    finally { setBusy(false); }
  };

  const isCompositeLayer = Boolean(edit?.operations.some((op) => op.type === 'borrow_stem' || op.type === 'add_sfx'));
  const fadeOp = edit?.operations.find((op) =>
    isCompositeLayer ? op.type === 'borrow_stem' || op.type === 'add_sfx' : FADE_TYPES.has(op.type)
  );
  const showFadePills = Boolean(fadeOp && fadeOp.fade_curve !== 'in' && fadeOp.fade_curve !== 'out');
  const fxOp = edit?.operations.find((op) => FX_TYPES.has(op.type));
  const borrowOp = edit?.operations.find((op) => op.type === 'borrow_stem');
  const fadeInMs = fadeOp?.fade_in_ms ?? 0;
  const fadeOutMs = fadeOp?.fade_out_ms ?? 0;

  return (
    <Popover anchorRef={anchorRef} open={Boolean(edit)} onClose={onClose} width={288} ariaLabel="Edit clip inspector">
      {edit && (
        <div className={styles.body}>
          <div className={styles.header}>
            <div className={styles.meta}>
              <div className={styles.titleRow}>
                <span className={styles.emoji}>{getClipEmoji(edit)}</span>
                <input
                  type="text"
                  aria-label="Clip title"
                  disabled={busy}
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onBlur={commitTitle}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') { setTitleDraft(edit.title); e.currentTarget.blur(); }
                  }}
                  className={styles.titleInput}
                />
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
              type="button" role="switch" aria-checked={edit.enabled} disabled={busy}
              onClick={() => void runUpdate({ enabled: !edit.enabled })}
              className={edit.enabled ? `${styles.switchBtn} ${styles.switchOn}` : styles.switchBtn}
            >
              <span className={edit.enabled ? `${styles.switchThumb} ${styles.switchThumbOn}` : styles.switchThumb} />
            </button>
          </div>

          {editSupportsGain(edit) && fxOp?.type !== 'bass_boost' && (
            <div className={styles.gainBlock}>
              <div className={styles.gainHeader}>
                <span className={styles.rowLabel}>Clip Level</span>
                <span className={styles.gainValue}>{gainDraft > 0 ? `+${gainDraft}` : gainDraft} dB</span>
              </div>
              <input
                type="range" min={-24} max={12} step={1}
                disabled={busy}
                value={Math.max(-24, Math.min(12, gainDraft))}
                onChange={(e) => setGainDraft(Number(e.target.value))}
                onPointerUp={(e) => void commitGain(Number(e.currentTarget.value))}
                onKeyUp={(e) => void commitGain(Number(e.currentTarget.value))}
                aria-label="Clip Level" className={styles.gainSlider}
              />
            </div>
          )}

          {showFadePills && (
            <div className={styles.fadeSection}>
              {([
                { label: 'Fade In', current: fadeInMs, key: 'fade_in_ms' as const },
                { label: 'Fade Out', current: fadeOutMs, key: 'fade_out_ms' as const },
              ]).map((row) => (
                <div key={row.key} className={styles.fadeGroup}>
                  <span className={styles.fadeLabel}>{row.label}</span>
                  <div className={styles.pillRow}>
                    {FADE_OPTIONS.map((opt) => {
                      const active = opt.ms === 0 ? row.current <= 50 : Math.abs(row.current - opt.ms) < 50;
                      return (
                        <button
                          key={opt.label}
                          type="button"
                          disabled={busy}
                          aria-label={`${row.label} ${opt.label}`}
                          aria-pressed={active}
                          onClick={() => void runUpdate({ [row.key]: opt.ms })}
                          className={active ? `${styles.pill} ${styles.pillActive}` : styles.pill}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          {fxOp && <ClipFxControls op={fxOp} busy={busy} onUpdate={runUpdate} />}
          {borrowOp && <ClipBorrowControls op={borrowOp} busy={busy} onUpdate={runUpdate} />}

          <div className={styles.footerActions}>
            {onDuplicateEdit && (
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try { await onDuplicateEdit(edit.id); onClose(); }
                  catch { /* toast handled */ }
                  finally { setBusy(false); }
                }}
                className={styles.dupBtn}
              >
                <Copy className={styles.iconSm} />
                Duplicate (Ctrl+D)
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try { await onDeleteEdit(edit.id); onClose(); }
                catch { /* toast handled */ }
                finally { setBusy(false); }
              }}
              className={styles.deleteBtn}
            >
              {busy ? <Loader2 className={styles.iconSpin} /> : <Trash2 className={styles.iconSm} />}
              Delete Edit
            </button>
          </div>
        </div>
      )}
    </Popover>
  );
};

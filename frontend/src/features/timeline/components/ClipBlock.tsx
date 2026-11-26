import React from 'react';
import type { EditBlock } from '../../../shared/api';
import { formatTimeRange } from '../../../shared/utils/format';
import type { ClipDragMode } from '../hooks/useClipDrag';
import { getClipEmoji } from '../utils';
import styles from './ClipBlock.module.css';

export type ClipTone = 'vocals' | 'drums' | 'bass' | 'other' | 'master' | 'sfx' | 'reference';

export interface ClipBlockProps {
  edit: EditBlock;
  tone: ClipTone;
  trackDuration: number;
  previewRange?: { start: number; end: number } | null;
  onClipPointerDown: (
    edit: EditBlock,
    mode: ClipDragMode,
    e: React.PointerEvent<HTMLDivElement>
  ) => void;
  onInspect?: (edit: EditBlock, el: HTMLElement) => void;
}

const TONE_CLASS_MAP: Record<ClipTone, string> = {
  vocals: styles.toneVocals,
  drums: styles.toneDrums,
  bass: styles.toneBass,
  other: styles.toneOther,
  master: styles.toneMaster,
  sfx: styles.toneSfx,
  reference: styles.toneReference,
};

export const ClipBlock: React.FC<ClipBlockProps> = ({
  edit,
  tone,
  trackDuration,
  previewRange,
  onClipPointerDown,
  onInspect,
}) => {
  if (trackDuration <= 0) return null;

  const start = previewRange ? previewRange.start : edit.start;
  const end = previewRange ? previewRange.end : edit.end;
  const leftPct = Math.max(0, Math.min(100, (start / trackDuration) * 100));
  const widthPct = Math.max(1.2, Math.min(100 - leftPct, ((end - start) / trackDuration) * 100));

  const stateClass = edit.enabled ? TONE_CLASS_MAP[tone] : styles.clipDisabled;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${edit.title} clip`}
      onPointerDown={(e) => onClipPointerDown(edit, 'move', e)}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && onInspect) {
          e.preventDefault();
          onInspect(edit, e.currentTarget);
        }
      }}
      style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
      title={`${edit.title} (${formatTimeRange(start, end)}) — Drag to move, edges to resize, click to edit`}
      className={`${styles.clip} ${stateClass}`}
    >
      <div
        role="separator"
        aria-label="Resize left edge"
        onPointerDown={(e) => {
          e.stopPropagation();
          onClipPointerDown(edit, 'resize-left', e);
        }}
        className={styles.resizeHandleLeft}
      />

      <span className={styles.emoji}>{getClipEmoji(edit)}</span>
      <span className={styles.title}>{edit.title}</span>
      {!edit.enabled && <span className={styles.offBadge}>Off</span>}

      <div
        role="separator"
        aria-label="Resize right edge"
        onPointerDown={(e) => {
          e.stopPropagation();
          onClipPointerDown(edit, 'resize-right', e);
        }}
        className={styles.resizeHandleRight}
      />
    </div>
  );
};

import { useCallback, useRef, useState } from 'react';
import type React from 'react';
import type { EditBlock, EditUpdatePayload } from '../../../shared/api';
import { computeMovedRange, computeResizedRange } from '../../../shared/utils/timelineMath';

export interface ClipDragPreview {
  editId: string;
  start: number;
  end: number;
}

export type ClipDragMode = 'move' | 'resize-left' | 'resize-right';

export interface UseClipDragOptions {
  trackDuration: number;
  beats: number[];
  beatSnap: boolean;
  onUpdateEdit: (editId: string, patch: EditUpdatePayload) => Promise<void>;
  onInspectClip: (edit: EditBlock, anchorEl: HTMLElement) => void;
}

export function useClipDrag({
  trackDuration,
  beats,
  beatSnap,
  onUpdateEdit,
  onInspectClip,
}: UseClipDragOptions) {
  const [clipDragPreview, setClipDragPreview] = useState<ClipDragPreview | null>(null);
  const beatSnapRef = useRef(beatSnap);
  const beatsRef = useRef(beats);
  beatSnapRef.current = beatSnap;
  beatsRef.current = beats;

  const handleClipPointerDown = useCallback(
    (
      edit: EditBlock,
      mode: ClipDragMode,
      laneEl: HTMLDivElement | null,
      e: React.PointerEvent<HTMLDivElement>
    ) => {
      e.stopPropagation();
      if (e.button !== 0 || trackDuration <= 0 || !laneEl) return;

      const clipEl = (e.currentTarget.closest('[role="button"]') as HTMLDivElement | null) ?? e.currentTarget;
      const laneRect = laneEl.getBoundingClientRect();
      const downX = e.clientX;
      const pxPerSec = laneRect.width / Math.max(0.1, trackDuration);
      const origStart = edit.start;
      const origEnd = edit.end;
      const origLeftStyle = clipEl.style.left;
      const origWidthStyle = clipEl.style.width;
      let moved = false;
      let latestStart = origStart;
      let latestEnd = origEnd;
      let rafId = 0;

      clipEl.setPointerCapture?.(e.pointerId);

      const applyDomPreview = () => {
        rafId = 0;
        const leftPct = Math.max(0, Math.min(100, (latestStart / trackDuration) * 100));
        const widthPct = Math.max(1.2, Math.min(100 - leftPct, ((latestEnd - latestStart) / trackDuration) * 100));
        clipEl.style.left = `${leftPct}%`;
        clipEl.style.width = `${widthPct}%`;
      };

      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - downX;
        if (Math.abs(dx) > 3) moved = true;
        if (!moved) return;

        const dt = dx / pxPerSec;
        const range =
          mode === 'move'
            ? computeMovedRange(
                origStart,
                origEnd,
                dt,
                trackDuration,
                beatsRef.current,
                beatSnapRef.current
              )
            : computeResizedRange(
                origStart,
                origEnd,
                mode === 'resize-left' ? 'left' : 'right',
                dt,
                trackDuration,
                beatsRef.current,
                beatSnapRef.current
              );

        latestStart = range.start;
        latestEnd = range.end;
        if (!rafId) rafId = window.requestAnimationFrame(applyDomPreview);
      };

      const onUp = (ev: PointerEvent) => {
        if (rafId) { window.cancelAnimationFrame(rafId); rafId = 0; }
        try { clipEl.releasePointerCapture?.(ev.pointerId); } catch { /* ignore */ }
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        if (!moved && mode === 'move') {
          setClipDragPreview(null);
          onInspectClip(edit, clipEl);
          return;
        }

        if (
          moved &&
          (Math.abs(latestStart - origStart) > 0.02 || Math.abs(latestEnd - origEnd) > 0.02)
        ) {
          applyDomPreview();
          setClipDragPreview({ editId: edit.id, start: latestStart, end: latestEnd });
          void onUpdateEdit(edit.id, { start: latestStart, end: latestEnd })
            .catch(() => {
              clipEl.style.left = origLeftStyle;
              clipEl.style.width = origWidthStyle;
            })
            .finally(() => {
              setClipDragPreview((cur) => (cur?.editId === edit.id ? null : cur));
            });
        } else {
          clipEl.style.left = origLeftStyle;
          clipEl.style.width = origWidthStyle;
          setClipDragPreview(null);
        }
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [onInspectClip, onUpdateEdit, trackDuration]
  );

  return {
    clipDragPreview,
    handleClipPointerDown,
  };
}

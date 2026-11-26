import { useEffect } from 'react';
import type React from 'react';
import type { MainTrack } from '../../../shared/api';
import { isEditableElement } from './useStemAudio';

export interface UseTimelineShortcutsOptions {
  enabled: boolean;
  inspectedEditId: string | null;
  onDuplicateEdit: (editId: string) => void;
  onDropCue: () => void;
}

export function useTimelineShortcuts({
  enabled,
  inspectedEditId,
  onDuplicateEdit,
  onDropCue,
}: UseTimelineShortcutsOptions): void {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableElement(e.target)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
        if (!inspectedEditId) return;
        e.preventDefault();
        onDuplicateEdit(inspectedEditId);
        return;
      }
      if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        onDropCue();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled, inspectedEditId, onDuplicateEdit, onDropCue]);
}

export function useTimelineWheelZoom(
  scrollRef: React.RefObject<HTMLDivElement>,
  mainTrack: MainTrack | null,
  setZoom: React.Dispatch<React.SetStateAction<number>>
): void {
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !mainTrack) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const headerWidth = 156;
      const pointerInTrack = Math.max(0, e.clientX - rect.left - headerWidth);
      const oldTrackWidth = Math.max(1, el.scrollWidth - headerWidth);
      const anchorRatio = (el.scrollLeft + pointerInTrack) / oldTrackWidth;
      const factor = e.deltaY < 0 ? 1.25 : 1 / 1.25;
      setZoom((prev) => {
        const next = Math.max(1, Math.min(16, Number((prev * factor).toFixed(2))));
        window.requestAnimationFrame(() => {
          const newTrackWidth = Math.max(1, el.scrollWidth - headerWidth);
          el.scrollLeft = Math.max(0, anchorRatio * newTrackWidth - pointerInTrack);
        });
        return next;
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [scrollRef, mainTrack, setZoom]);
}

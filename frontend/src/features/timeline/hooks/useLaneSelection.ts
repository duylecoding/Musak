import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type React from 'react';
import type { TimeSelection } from '../../../shared/api';
import { snapTimeToBeat, type InstrumentStem } from '../../../shared/utils/timelineMath';

export interface UseLaneSelectionOptions {
  trackDuration: number;
  beats: number[];
  beatSnap: boolean;
  zoom: number;
  selection: TimeSelection | null;
  laneRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
  timelineScrollRef: React.RefObject<HTMLDivElement>;
  onSelectionChange: (sel: TimeSelection | null) => void;
  seekToTime: (time: number) => void;
}

export function useLaneSelection({
  trackDuration, beats, beatSnap, zoom, selection, laneRefs, timelineScrollRef, onSelectionChange, seekToTime,
}: UseLaneSelectionOptions) {
  const [laneDragSelection, setLaneDragSelection] = useState<{ lane: InstrumentStem; start: number; end: number } | null>(null);
  const [actionBarCoords, setActionBarCoords] = useState<{ top: number; left: number } | null>(null);
  const actionBarRef = useRef<HTMLDivElement>(null);
  const beatSnapRef = useRef(beatSnap);
  const beatsRef = useRef(beats);
  beatSnapRef.current = beatSnap;
  beatsRef.current = beats;

  const handleLanePointerDown = useCallback((lane: InstrumentStem, e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || trackDuration <= 0) return;
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    const downX = e.clientX;
    const ratioAt = (cx: number) => Math.max(0, Math.min(1, (cx - rect.left) / Math.max(1, rect.width)));
    const downTime = ratioAt(downX) * trackDuration;
    let dragged = false;

    const computeRange = (cx: number) => {
      const curTime = ratioAt(cx) * trackDuration;
      let s = Math.min(downTime, curTime);
      let en = Math.max(downTime, curTime);
      if (beatSnapRef.current && beatsRef.current.length > 0) {
        const ss = snapTimeToBeat(s, beatsRef.current, true);
        const se = snapTimeToBeat(en, beatsRef.current, true);
        if (se - ss >= 0.2) { s = ss; en = se; }
      }
      return { start: Math.max(0, s), end: Math.min(trackDuration, en) };
    };

    el.setPointerCapture?.(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - downX) > 4) dragged = true;
      if (dragged) setLaneDragSelection({ lane, ...computeRange(ev.clientX) });
    };
    const onUp = (ev: PointerEvent) => {
      try { el.releasePointerCapture?.(ev.pointerId); } catch { /* ignore */ }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      setLaneDragSelection(null);
      if (dragged) {
        const range = computeRange(ev.clientX);
        if (range.end - range.start >= 0.2) {
          onSelectionChange({ ...range, lane });
          seekToTime(range.start);
          return;
        }
      }
      seekToTime(downTime);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [onSelectionChange, seekToTime, trackDuration]);

  const updateActionBarPosition = useCallback(() => {
    if (!selection || trackDuration <= 0 || !actionBarRef.current) { setActionBarCoords(null); return; }
    const laneKey = selection.lane && selection.lane !== 'all' ? selection.lane : 'vocals';
    const laneEl = laneRefs.current[laneKey] || laneRefs.current.vocals;
    const scrollEl = timelineScrollRef.current;
    if (!laneEl || !scrollEl) return;
    const laneRect = laneEl.getBoundingClientRect();
    const scrollRect = scrollEl.getBoundingClientRect();
    const popRect = actionBarRef.current.getBoundingClientRect();
    if (laneRect.bottom < scrollRect.top || laneRect.top > scrollRect.bottom) { setActionBarCoords(null); return; }
    const startPx = laneRect.left + (selection.start / trackDuration) * laneRect.width;
    const endPx = laneRect.left + (selection.end / trackDuration) * laneRect.width;
    const pad = 12;
    let top = laneRect.top - popRect.height - 8;
    if (top < Math.max(pad, scrollRect.top - 42)) top = Math.min(window.innerHeight - popRect.height - pad, laneRect.bottom + 8);
    top = Math.max(pad, Math.min(top, window.innerHeight - popRect.height - pad));
    const left = Math.max(pad, Math.min((startPx + endPx) / 2 - popRect.width / 2, window.innerWidth - popRect.width - pad));
    setActionBarCoords({ top, left });
  }, [laneRefs, selection, timelineScrollRef, trackDuration]);

  useLayoutEffect(() => { updateActionBarPosition(); }, [updateActionBarPosition, zoom]);

  useEffect(() => {
    if (!selection) { setActionBarCoords(null); return; }
    const scrollEl = timelineScrollRef.current;
    const onChange = () => updateActionBarPosition();
    scrollEl?.addEventListener('scroll', onChange, { passive: true });
    window.addEventListener('resize', onChange);
    return () => {
      scrollEl?.removeEventListener('scroll', onChange);
      window.removeEventListener('resize', onChange);
    };
  }, [selection, timelineScrollRef, updateActionBarPosition]);

  return { laneDragSelection, actionBarRef, actionBarCoords, updateActionBarPosition, handleLanePointerDown };
}

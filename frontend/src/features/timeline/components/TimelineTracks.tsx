import React, { useCallback, useRef, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import type { EditBlock, MainTrack, TimeSelection, WaveformPeaksResponse } from '../../../shared/api';
import type { InstrumentStem } from '../../../shared/utils/timelineMath';
import { STEM_LANES, type StemChannelState } from '../constants';
import type { ClipDragMode, ClipDragPreview } from '../hooks/useClipDrag';
import { effectiveStemGain } from '../utils';
import { ClipBlock } from './ClipBlock';
import { AddSoundLayerRow, SoundLayerRow } from './SoundLayerRow';
import { StemLaneRow } from './StemLaneRow';
import { TimelineRuler } from './TimelineRuler';
import styles from './TimelineWorkspace.module.css';

const HEADER_WIDTH_KEY = 'musak_timeline_header_width';
const DEFAULT_HEADER_WIDTH = 204;
const MIN_HEADER_WIDTH = 140;
const MAX_HEADER_WIDTH = 380;

function readHeaderWidth(): number {
  try {
    const raw = Number(window.localStorage?.getItem(HEADER_WIDTH_KEY));
    if (Number.isFinite(raw) && raw >= MIN_HEADER_WIDTH && raw <= MAX_HEADER_WIDTH) return Math.round(raw);
  } catch { /* ignore */ }
  return DEFAULT_HEADER_WIDTH;
}

export interface TimelineTracksProps {
  mainTrack: MainTrack;
  trackDuration: number;
  currentTimeRef: React.MutableRefObject<number>;
  zoom: number;
  stemsReady: boolean;
  stemsProcessing: boolean;
  peaks: WaveformPeaksResponse | null;
  selection: TimeSelection | null;
  laneDragSelection: { lane: InstrumentStem; start: number; end: number } | null;
  stemChannels: Record<InstrumentStem, StemChannelState>;
  masterEdits: EditBlock[];
  stemEditsMap: Record<InstrumentStem, EditBlock[]>;
  layerEdits: EditBlock[];
  clipDragPreview: ClipDragPreview | null;
  timelineScrollRef: React.RefObject<HTMLDivElement>;
  playheadLineRef: React.RefObject<HTMLDivElement>;
  playheadDiamondRef: React.RefObject<HTMLDivElement>;
  addLayerBtnRef: React.RefObject<HTMLButtonElement>;
  laneRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
  onSeekToTime: (time: number) => void;
  onSelectionChange: (sel: TimeSelection | null) => void;
  onUpdateChannel: (stem: InstrumentStem, patch: Partial<StemChannelState>) => void;
  onLanePointerDown: (lane: InstrumentStem, e: React.PointerEvent<HTMLDivElement>) => void;
  onClipPointerDown: (edit: EditBlock, mode: ClipDragMode, laneEl: HTMLDivElement | null, e: React.PointerEvent<HTMLDivElement>) => void;
  onInspectClip: (edit: EditBlock, el: HTMLElement) => void;
  onToggleLayerEnabled: (edit: EditBlock) => void;
  onDeleteEdit: (editId: string) => void;
  onDeleteCue?: (cueId: string) => void;
  onToggleAddLayer: () => void;
}

export const TimelineTracks: React.FC<TimelineTracksProps> = ({
  mainTrack, trackDuration, currentTimeRef, zoom, stemsReady, stemsProcessing, peaks, selection,
  laneDragSelection, stemChannels, masterEdits, stemEditsMap, layerEdits, clipDragPreview,
  timelineScrollRef, playheadLineRef, playheadDiamondRef, addLayerBtnRef, laneRefs,
  onSeekToTime, onSelectionChange, onUpdateChannel, onLanePointerDown, onClipPointerDown,
  onInspectClip, onToggleLayerEnabled, onDeleteEdit, onDeleteCue, onToggleAddLayer,
}) => {
  const frameRef = useRef<HTMLDivElement>(null);
  const [headerWidth, setHeaderWidth] = useState<number>(readHeaderWidth);
  const [resizingCol, setResizingCol] = useState(false);

  const commitHeaderWidth = useCallback((w: number) => {
    const clamped = Math.max(MIN_HEADER_WIDTH, Math.min(MAX_HEADER_WIDTH, Math.round(w)));
    setHeaderWidth(clamped);
    frameRef.current?.style.setProperty('--timeline-header-width', `${clamped}px`);
    try { window.localStorage?.setItem(HEADER_WIDTH_KEY, String(clamped)); } catch { /* ignore */ }
  }, []);

  const handleColumnResizeStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = headerWidth;
    let latestW = startW;
    let rafId = 0;
    setResizingCol(true);
    e.currentTarget.setPointerCapture?.(e.pointerId);

    const applyWidth = () => {
      rafId = 0;
      frameRef.current?.style.setProperty('--timeline-header-width', `${latestW}px`);
    };

    const onMove = (ev: PointerEvent) => {
      latestW = Math.max(MIN_HEADER_WIDTH, Math.min(MAX_HEADER_WIDTH, Math.round(startW + (ev.clientX - startX))));
      if (!rafId) rafId = window.requestAnimationFrame(applyWidth);
    };

    const onUp = () => {
      if (rafId) { window.cancelAnimationFrame(rafId); rafId = 0; }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      setResizingCol(false);
      commitHeaderWidth(latestW);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [commitHeaderWidth, headerWidth]);

  const playheadPct = trackDuration > 0 ? Math.max(0, Math.min(100, (currentTimeRef.current / trackDuration) * 100)) : 0;
  const frameStyle = { '--timeline-header-width': `${headerWidth}px` } as React.CSSProperties;

  return (
    <div ref={frameRef} style={frameStyle} className={styles.timelineFrame}>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize track labels column"
        title="Drag to widen track labels (double-click to reset)"
        onPointerDown={handleColumnResizeStart}
        onDoubleClick={() => commitHeaderWidth(DEFAULT_HEADER_WIDTH)}
        className={resizingCol ? `${styles.columnResizer} ${styles.columnResizerActive}` : styles.columnResizer}
      />
      <div ref={timelineScrollRef} className={styles.timelineScroll}>
        <div
          style={{
            width: zoom === 1
              ? '100%'
              : `calc(var(--timeline-header-width, 204px) + (100% - var(--timeline-header-width, 204px)) * ${zoom})`,
          }}
          className={styles.timelineInner}
        >
        <div className={styles.playheadLayer}>
          <div ref={playheadLineRef} style={{ left: `${playheadPct}%` }} className={styles.playheadLine} />
        </div>

        <TimelineRuler
          trackDuration={trackDuration}
          zoom={zoom}
          currentTimeRef={currentTimeRef}
          sections={mainTrack.sections ?? []}
          cues={mainTrack.cues ?? []}
          selection={selection}
          playheadDiamondRef={playheadDiamondRef}
          onSeekToTime={onSeekToTime}
          onSelectSection={(sec) => {
            onSelectionChange({ start: sec.start, end: sec.end, lane: 'all' });
            onSeekToTime(sec.start);
          }}
          onSelectSpan={(start, end) => onSelectionChange({ start, end, lane: 'all' })}
          onDeleteCue={onDeleteCue}
        />

        {masterEdits.length > 0 && (
          <div className={styles.masterRow}>
            <div className={styles.masterHeader}>
              <div className={styles.masterLabelGroup}>
                <SlidersHorizontal className={styles.masterIcon} />
                <span className={styles.masterLabel}>Master FX</span>
              </div>
              <span className={styles.masterCount}>{masterEdits.length}</span>
            </div>
            <div ref={(el) => { laneRefs.current.master = el; }} className={styles.masterTrack}>
              {masterEdits.map((edit) => (
                <ClipBlock
                  key={`master-${edit.id}`}
                  edit={edit}
                  tone="master"
                  trackDuration={trackDuration}
                  previewRange={clipDragPreview?.editId === edit.id ? clipDragPreview : null}
                  onClipPointerDown={(ed, mode, e) => onClipPointerDown(ed, mode, laneRefs.current.master ?? null, e)}
                  onInspect={onInspectClip}
                />
              ))}
            </div>
          </div>
        )}

        {STEM_LANES.map((lane) => {
          const activeDrag = laneDragSelection?.lane === lane.id ? laneDragSelection : null;
          const matched = !activeDrag && selection && (!selection.lane || selection.lane === 'all' || selection.lane === lane.id) ? selection : null;
          const lanePeaks = peaks?.stems?.[lane.id]?.length ? peaks.stems[lane.id] : peaks?.main ?? [];
          return (
            <StemLaneRow
              key={lane.id}
              lane={lane}
              channel={stemChannels[lane.id]}
              stemsReady={stemsReady}
              isLaneMuted={stemsReady && effectiveStemGain(lane.id, stemChannels) === 0}
              processingOverlay={stemsProcessing && lane.id === 'drums'}
              peaks={lanePeaks}
              isUsingMainFallback={!peaks?.stems?.[lane.id]?.length}
              beats={mainTrack.beats}
              trackDuration={trackDuration}
              displaySelection={activeDrag || matched}
              edits={stemEditsMap[lane.id]}
              clipDragPreview={clipDragPreview}
              laneRef={(el) => { laneRefs.current[lane.id] = el; }}
              onUpdateChannel={onUpdateChannel}
              onLanePointerDown={onLanePointerDown}
              onClipPointerDown={(ed, mode, e) => onClipPointerDown(ed, mode, laneRefs.current[lane.id] ?? null, e)}
              onInspectClip={onInspectClip}
            />
          );
        })}

        {layerEdits.map((edit, idx) => {
          const key = `layer-${edit.id}`;
          return (
            <SoundLayerRow
              key={edit.id}
              edit={edit}
              index={idx}
              trackDuration={trackDuration}
              clipDragPreview={clipDragPreview}
              laneRef={(el) => { laneRefs.current[key] = el; }}
              onToggleEnabled={onToggleLayerEnabled}
              onDelete={onDeleteEdit}
              onClipPointerDown={(ed, mode, e) => onClipPointerDown(ed, mode, laneRefs.current[key] ?? null, e)}
              onInspectClip={onInspectClip}
            />
          );
        })}

        <AddSoundLayerRow buttonRef={addLayerBtnRef} onToggleOpen={onToggleAddLayer} />
        </div>
      </div>
    </div>
  );
};

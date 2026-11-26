import React from 'react';
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

export interface TimelineTracksProps {
  mainTrack: MainTrack;
  trackDuration: number;
  displayTime: number;
  zoom: 1 | 2 | 4;
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
  onToggleAddLayer: () => void;
}

export const TimelineTracks: React.FC<TimelineTracksProps> = ({
  mainTrack, trackDuration, displayTime, zoom, stemsReady, stemsProcessing, peaks, selection,
  laneDragSelection, stemChannels, masterEdits, stemEditsMap, layerEdits, clipDragPreview,
  timelineScrollRef, playheadLineRef, playheadDiamondRef, addLayerBtnRef, laneRefs,
  onSeekToTime, onSelectionChange, onUpdateChannel, onLanePointerDown, onClipPointerDown,
  onInspectClip, onToggleLayerEnabled, onDeleteEdit, onToggleAddLayer,
}) => {
  const playheadPct = trackDuration > 0 ? Math.max(0, Math.min(100, (displayTime / trackDuration) * 100)) : 0;

  return (
    <div ref={timelineScrollRef} className={styles.timelineScroll}>
      <div style={{ width: zoom === 1 ? '100%' : `calc(156px + (100% - 156px) * ${zoom})` }} className={styles.timelineInner}>
        <div className={styles.playheadLayer}>
          <div ref={playheadLineRef} style={{ left: `${playheadPct}%` }} className={styles.playheadLine} />
        </div>

        <TimelineRuler
          trackDuration={trackDuration}
          zoom={zoom}
          displayTime={displayTime}
          sections={mainTrack.sections ?? []}
          selection={selection}
          playheadDiamondRef={playheadDiamondRef}
          onSeekToTime={onSeekToTime}
          onSelectSection={(sec) => {
            onSelectionChange({ start: sec.start, end: sec.end, lane: 'all' });
            onSeekToTime(sec.start);
          }}
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
  );
};

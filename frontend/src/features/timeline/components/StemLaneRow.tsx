import React from 'react';
import type { EditBlock, TimeSelection } from '../../../shared/api';
import { HelpTip } from '../../../shared/components/Tooltip/Tooltip';
import type { InstrumentStem } from '../../../shared/utils/timelineMath';
import type { StemChannelState, StemLaneConfig } from '../constants';
import type { ClipDragMode, ClipDragPreview } from '../hooks/useClipDrag';
import { ClipBlock } from './ClipBlock';
import { LaneWaveform } from './LaneWaveform';
import styles from './StemLaneRow.module.css';

export interface StemLaneRowProps {
  lane: StemLaneConfig;
  channel: StemChannelState;
  stemsReady: boolean;
  isLaneMuted: boolean;
  processingOverlay: boolean;
  peaks: number[];
  isUsingMainFallback: boolean;
  beats: number[];
  trackDuration: number;
  displaySelection: { start: number; end: number } | TimeSelection | null;
  edits: EditBlock[];
  clipDragPreview: ClipDragPreview | null;
  laneRef: (el: HTMLDivElement | null) => void;
  onUpdateChannel: (stem: InstrumentStem, patch: Partial<StemChannelState>) => void;
  onLanePointerDown: (lane: InstrumentStem, e: React.PointerEvent<HTMLDivElement>) => void;
  onClipPointerDown: (edit: EditBlock, mode: ClipDragMode, e: React.PointerEvent<HTMLDivElement>) => void;
  onInspectClip: (edit: EditBlock, el: HTMLElement) => void;
}

const BADGE_CLASS_MAP: Record<InstrumentStem, string> = {
  vocals: styles.badgeVocals,
  drums: styles.badgeDrums,
  bass: styles.badgeBass,
  other: styles.badgeOther,
};

const SELECTION_CLASS_MAP: Record<InstrumentStem, string> = {
  vocals: styles.selVocals,
  drums: styles.selDrums,
  bass: styles.selBass,
  other: styles.selOther,
};

export const StemLaneRow: React.FC<StemLaneRowProps> = ({
  lane, channel, stemsReady, isLaneMuted, processingOverlay, peaks, isUsingMainFallback,
  beats, trackDuration, displaySelection, edits, clipDragPreview, laneRef,
  onUpdateChannel, onLanePointerDown, onClipPointerDown, onInspectClip,
}) => {
  const Icon = lane.icon;

  return (
    <div className={styles.row}>
      <div className={styles.stickyHeader}>
        <HelpTip title={lane.label} content={lane.tip}>
          <div className={styles.headerTop}>
            <div className={styles.labelGroup}>
              <span className={`${styles.iconBadge} ${BADGE_CLASS_MAP[lane.id]}`}>
                <Icon className={styles.laneIcon} />
              </span>
              <span className={styles.laneName}>{lane.shortLabel}</span>
            </div>
            <span className={styles.volumeText}>{channel.volume}%</span>
          </div>
        </HelpTip>

        <div className={styles.controlsRow}>
          <HelpTip content={stemsReady ? `Mute ${lane.shortLabel} live.` : 'Separate stems first to mute individual instruments.'}>
            <button
              type="button"
              disabled={!stemsReady}
              onClick={() => onUpdateChannel(lane.id, { muted: !channel.muted })}
              aria-label={`Mute ${lane.shortLabel}`}
              className={channel.muted ? `${styles.msBtn} ${styles.muteActive}` : styles.msBtn}
            >
              M
            </button>
          </HelpTip>

          <HelpTip content={stemsReady ? `Solo ${lane.shortLabel} live.` : 'Separate stems first to solo individual instruments.'}>
            <button
              type="button"
              disabled={!stemsReady}
              onClick={() => onUpdateChannel(lane.id, { solo: !channel.solo })}
              aria-label={`Solo ${lane.shortLabel}`}
              className={channel.solo ? `${styles.msBtn} ${styles.soloActive}` : styles.msBtn}
            >
              S
            </button>
          </HelpTip>

          <input
            type="range"
            min={0}
            max={150}
            step={5}
            disabled={!stemsReady}
            value={channel.volume}
            onChange={(e) => onUpdateChannel(lane.id, { volume: Number(e.target.value), muted: Number(e.target.value) === 0 })}
            aria-label={`${lane.label} volume`}
            className={styles.volumeSlider}
          />
        </div>
      </div>

      <div ref={laneRef} onPointerDown={(e) => onLanePointerDown(lane.id, e)} className={styles.laneTrack}>
        <LaneWaveform
          peaks={peaks}
          colorVar={lane.colorVar}
          opacity={isUsingMainFallback ? 0.28 : 0.88}
          muted={isLaneMuted}
          beats={beats}
          duration={trackDuration}
          processingOverlay={processingOverlay}
        />

        {displaySelection && trackDuration > 0 && displaySelection.end > displaySelection.start && (
          <div
            style={{
              left: `${(displaySelection.start / trackDuration) * 100}%`,
              width: `${((displaySelection.end - displaySelection.start) / trackDuration) * 100}%`,
            }}
            className={`${styles.selectionHighlight} ${SELECTION_CLASS_MAP[lane.id]}`}
          />
        )}

        {edits.map((edit) => (
          <ClipBlock
            key={`${lane.id}-${edit.id}`}
            edit={edit}
            tone={lane.id}
            trackDuration={trackDuration}
            previewRange={clipDragPreview?.editId === edit.id ? clipDragPreview : null}
            onClipPointerDown={onClipPointerDown}
            onInspect={onInspectClip}
          />
        ))}
      </div>
    </div>
  );
};

import React, { useMemo } from 'react';
import type { CueMarker, Section, TimeSelection } from '../../../shared/api';
import { formatTime, formatTimeRange } from '../../../shared/utils/format';
import { computeRulerTicks, getSectionTone, type SectionTone } from '../utils';
import styles from './TimelineRuler.module.css';

export interface TimelineRulerProps {
  trackDuration: number;
  zoom: number;
  currentTimeRef: React.MutableRefObject<number>;
  sections: Section[];
  cues?: CueMarker[];
  selection: TimeSelection | null;
  playheadDiamondRef: React.RefObject<HTMLDivElement>;
  onSeekToTime: (time: number) => void;
  onSelectSection: (section: Section) => void;
  onSelectSpan?: (start: number, end: number) => void;
  onDeleteCue?: (cueId: string) => void;
}

const TONE_CLASS_MAP: Record<SectionTone, string> = {
  drop: styles.toneDrop,
  buildup: styles.toneBuildup,
  verse: styles.toneVerse,
  bridge: styles.toneBridge,
  default: styles.toneDefault,
};

const CUE_TONE_CLASSES = [
  styles.cueAmber,
  styles.cueSky,
  styles.cueEmerald,
  styles.cueRose,
  styles.cueViolet,
];

function getCueToneClass(cue: CueMarker, index: number): string {
  const c = (cue.color || '').toLowerCase();
  if (c.includes('sky') || c.includes('blue') || c.includes('38bdf8')) return styles.cueSky;
  if (c.includes('emerald') || c.includes('green') || c.includes('10b981') || c.includes('34d399')) return styles.cueEmerald;
  if (c.includes('rose') || c.includes('red') || c.includes('f43f5e')) return styles.cueRose;
  if (c.includes('violet') || c.includes('purple') || c.includes('8b5cf6') || c.includes('a78bfa')) return styles.cueViolet;
  return CUE_TONE_CLASSES[index % CUE_TONE_CLASSES.length];
}

export const TimelineRuler: React.FC<TimelineRulerProps> = React.memo(({
  trackDuration, zoom, currentTimeRef, sections, cues = [], selection,
  playheadDiamondRef, onSeekToTime, onSelectSection, onSelectSpan, onDeleteCue,
}) => {
  const rulerTicks = useMemo(() => computeRulerTicks(trackDuration, zoom), [trackDuration, zoom]);

  const handleRulerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || trackDuration <= 0) return;
    const el = e.currentTarget;
    el.setPointerCapture?.(e.pointerId);
    const seek = (clientX: number) => {
      const rect = el.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
      onSeekToTime(ratio * trackDuration);
    };
    seek(e.clientX);
    const onMove = (ev: PointerEvent) => seek(ev.clientX);
    const onUp = (ev: PointerEvent) => {
      try { el.releasePointerCapture?.(ev.pointerId); } catch { /* ignore */ }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const playheadPct = trackDuration > 0 ? Math.max(0, Math.min(100, (currentTimeRef.current / trackDuration) * 100)) : 0;

  return (
    <div className={styles.stickyRow}>
      <div className={styles.stickyLabel}>
        <div className={styles.title}>Timeline</div>
        <div className={styles.subtitle}>Drag any lane to select</div>
      </div>

      <div className={styles.tracksColumn}>
        <div onPointerDown={handleRulerPointerDown} className={styles.timeRuler} title="Click or drag to seek">
          <div ref={playheadDiamondRef} style={{ left: `${playheadPct}%` }} className={styles.playheadDiamondWrap}>
            <div className={styles.playheadDiamond} />
          </div>
          {trackDuration > 0 &&
            rulerTicks.map((t) => (
              <div key={t} style={{ left: `${(t / trackDuration) * 100}%` }} className={styles.tickMark}>
                <span className={styles.tickLabel}>{formatTime(t)}</span>
              </div>
            ))}
          {trackDuration > 0 &&
            cues.map((cue, idx) => {
              const leftPct = Math.max(0, Math.min(98, (cue.time / trackDuration) * 100));
              return (
                <div
                  key={cue.id}
                  style={{ left: `${leftPct}%` }}
                  onPointerDown={(e) => e.stopPropagation()}
                  className={`${styles.cueFlag} ${getCueToneClass(cue, idx)}`}
                >
                  <button
                    type="button"
                    title={`${cue.label} (${formatTime(cue.time)}) — Click to jump, Shift+Click to select span`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (e.shiftKey && onSelectSpan) {
                        const nowTime = currentTimeRef.current;
                        const s = Math.min(nowTime, cue.time);
                        const end = Math.max(nowTime, cue.time);
                        if (end - s >= 0.2) onSelectSpan(s, end);
                      } else {
                        onSeekToTime(cue.time);
                      }
                    }}
                    className={styles.cueLabelBtn}
                  >
                    {cue.label}
                  </button>
                  {onDeleteCue && (
                    <button
                      type="button"
                      aria-label={`Delete ${cue.label}`}
                      onClick={(e) => { e.stopPropagation(); onDeleteCue(cue.id); }}
                      className={styles.cueDeleteBtn}
                    >
                      ×
                    </button>
                  )}
                </div>
              );
            })}
        </div>

        <div className={styles.sectionTrack}>
          {sections.length > 0 && trackDuration > 0 ? (
            sections.map((sec, idx) => {
              const leftPct = Math.max(0, (sec.start / trackDuration) * 100);
              const widthPct = Math.max(1.5, Math.min(100 - leftPct, ((sec.end - sec.start) / trackDuration) * 100));
              const isSelected =
                Boolean(selection) &&
                Math.abs((selection?.start ?? -1) - sec.start) < 0.4 &&
                Math.abs((selection?.end ?? -1) - sec.end) < 0.4;
              const toneClass = isSelected ? styles.sectionSelected : TONE_CLASS_MAP[getSectionTone(sec.label)];
              return (
                <button
                  key={`${sec.label}-${idx}`}
                  type="button"
                  onClick={() => onSelectSection(sec)}
                  style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                  title={`Select ${sec.label} (${formatTimeRange(sec.start, sec.end)})`}
                  className={`${styles.sectionBtn} ${toneClass}`}
                >
                  {sec.label}
                </button>
              );
            })
          ) : (
            <div className={styles.fallbackSection}>Full Track ({formatTime(trackDuration)})</div>
          )}
        </div>
      </div>
    </div>
  );
});

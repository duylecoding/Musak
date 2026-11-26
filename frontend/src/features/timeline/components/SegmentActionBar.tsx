import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Repeat, Scissors, Sparkles, Volume2, VolumeX, X, Zap } from 'lucide-react';
import type { TimeSelection } from '../../../shared/api';
import { HelpTip } from '../../../shared/components/Tooltip/Tooltip';
import { formatTimeRange } from '../../../shared/utils/format';
import { SEGMENT_DJ_MOVES, SEGMENT_FX_OPTIONS, VOLUME_STEPS, type SegmentFxDef } from '../constants';
import { getLaneLabel } from '../utils';
import styles from './SegmentActionBar.module.css';

export interface SegmentActionBarProps {
  selection: TimeSelection | null;
  stemsReady: boolean;
  busy: boolean;
  barRef?: React.RefObject<HTMLDivElement>;
  coords?: { top: number; left: number } | null;
  onLayoutChange?: () => void;
  onSetBars: (bars: number) => void;
  onAdjustVolume: (gainDb: number) => void;
  onApplyFade?: (curve: 'in' | 'out') => void;
  onCutSection?: () => void;
  onRepeatSection?: (count: number) => void;
  onApplyFx: (fx: SegmentFxDef) => void;
  onAskGemini: () => void;
  onClearSelection: () => void;
}

export const SegmentActionBar: React.FC<SegmentActionBarProps> = ({
  selection, stemsReady, busy, barRef, coords, onLayoutChange,
  onSetBars, onAdjustVolume, onApplyFade, onCutSection, onRepeatSection,
  onApplyFx, onAskGemini, onClearSelection,
}) => {
  const [subMenu, setSubMenu] = useState<'none' | 'volume' | 'fx'>('none');
  const localRef = useRef<HTMLDivElement | null>(null);

  const assignRef = (el: HTMLDivElement | null) => {
    localRef.current = el;
    if (barRef && 'current' in barRef) {
      (barRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    }
  };

  useEffect(() => { setSubMenu('none'); }, [selection]);
  useEffect(() => { onLayoutChange?.(); }, [subMenu, onLayoutChange]);

  useEffect(() => {
    if (subMenu === 'none') return;
    const onMouseDown = (e: MouseEvent) => {
      if (e.target instanceof Node && !localRef.current?.contains(e.target)) setSubMenu('none');
    };
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') setSubMenu('none'); };
    document.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [subMenu]);

  if (!selection || typeof document === 'undefined') return null;

  const isAllLanes = !selection.lane || selection.lane === 'all';
  const laneLabel = getLaneLabel(selection.lane);
  const posStyle: React.CSSProperties =
    coords === undefined
      ? { top: '12px', left: '12px', opacity: 1 }
      : { top: coords ? `${coords.top}px` : '-9999px', left: coords ? `${coords.left}px` : '-9999px', opacity: coords ? 1 : 0 };

  const renderFxItem = (fx: SegmentFxDef) => {
    const FxIcon = fx.icon;
    return (
      <button key={fx.id} type="button" onClick={() => { setSubMenu('none'); onApplyFx(fx); }} className={styles.fxItem}>
        <FxIcon className={styles.iconFx} />
        <div className={styles.fxMeta}>
          <div className={styles.fxLabel}>{fx.label}</div>
          <div className={styles.fxTip}>{fx.tip}</div>
        </div>
      </button>
    );
  };

  return createPortal(
    <div ref={assignRef} role="toolbar" aria-label="Segment actions" style={posStyle} className={styles.bar}>
      <span className={styles.targetPill}>
        <span>{laneLabel}</span>
        <span className={styles.dot}>·</span>
        <span className={styles.rangeText}>{formatTimeRange(selection.start, selection.end)}</span>
      </span>

      {[4, 8].map((bars) => (
        <HelpTip key={bars} content={`Snap selection length to ${bars} musical bars.`}>
          <button type="button" onClick={() => onSetBars(bars)} className={styles.barsBtn}>{bars} Bars</button>
        </HelpTip>
      ))}

      <div className={styles.divider} />

      <HelpTip content={stemsReady ? `Silences ${laneLabel.toLowerCase()} cleanly just during this highlighted moment.` : 'Separate stems first so Musak can mute just this instrument.'}>
        <button
          type="button"
          disabled={!stemsReady || busy}
          onClick={() => { setSubMenu('none'); onAdjustVolume(-80); }}
          className={styles.muteBtn}
        >
          <VolumeX className={styles.iconSm} />
          Mute / Cut
        </button>
      </HelpTip>

      <div className={styles.menuWrap}>
        <HelpTip content={stemsReady ? `Boost, lower, or fade ${laneLabel.toLowerCase()} volume during this moment.` : 'Separate stems first to adjust individual instrument volume.'}>
          <button
            type="button"
            disabled={!stemsReady || busy}
            onClick={() => setSubMenu((m) => (m === 'volume' ? 'none' : 'volume'))}
            className={styles.menuBtn}
          >
            <Volume2 className={styles.iconSm} />
            Volume
            <ChevronDown className={styles.iconChevron} />
          </button>
        </HelpTip>
        {subMenu === 'volume' && (
          <div className={`${styles.dropdown} ${styles.volumeDropdown}`}>
            {VOLUME_STEPS.map((db) => (
              <button key={db} type="button" onClick={() => { setSubMenu('none'); onAdjustVolume(db); }} className={styles.volumeItem}>
                <span>{db > 0 ? `+${db} dB` : `${db} dB`}</span>
                <span className={styles.volumeHint}>{db > 0 ? 'Boost' : 'Lower'}</span>
              </button>
            ))}
            {onApplyFade && (
              <>
                <div className={styles.dropdownDivider} />
                <button type="button" onClick={() => { setSubMenu('none'); onApplyFade('in'); }} className={styles.volumeItem}>
                  <span>Fade In</span>
                  <span className={styles.volumeHint}>0 → 100%</span>
                </button>
                <button type="button" onClick={() => { setSubMenu('none'); onApplyFade('out'); }} className={styles.volumeItem}>
                  <span>Fade Out</span>
                  <span className={styles.volumeHint}>100 → 0%</span>
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {isAllLanes && onCutSection && (
        <HelpTip content="Splice out this whole section cleanly with a 25ms crossfade.">
          <button type="button" disabled={busy} onClick={() => { setSubMenu('none'); onCutSection(); }} className={styles.arrBtn}>
            <Scissors className={styles.iconSm} />
            Cut Out
          </button>
        </HelpTip>
      )}

      {isAllLanes && onRepeatSection && (
        <HelpTip content="Loop this whole section twice seamlessly in the arrangement.">
          <button type="button" disabled={busy} onClick={() => { setSubMenu('none'); onRepeatSection(2); }} className={styles.arrBtn}>
            <Repeat className={styles.iconSm} />
            Repeat ×2
          </button>
        </HelpTip>
      )}

      <div className={styles.menuWrap}>
        <HelpTip content="Apply a quick studio effect or 1-click DJ Move to this exact segment.">
          <button type="button" disabled={busy} onClick={() => setSubMenu((m) => (m === 'fx' ? 'none' : 'fx'))} className={styles.menuBtn}>
            <Zap className={styles.iconAmber} />
            FX
            <ChevronDown className={styles.iconChevron} />
          </button>
        </HelpTip>
        {subMenu === 'fx' && (
          <div className={`${styles.dropdown} ${styles.fxDropdown}`}>
            {SEGMENT_FX_OPTIONS.map(renderFxItem)}
            <div className={styles.dropdownDivider} />
            <div className={styles.dropdownKicker}>DJ Moves</div>
            {SEGMENT_DJ_MOVES.map(renderFxItem)}
          </div>
        )}
      </div>

      <HelpTip content="Jump to Gemini Producer Chat with this exact lane and timestamp targeted.">
        <button type="button" onClick={() => { setSubMenu('none'); onAskGemini(); }} className={styles.geminiBtn}>
          <Sparkles className={styles.iconSm} />
          Ask Gemini
        </button>
      </HelpTip>

      <button type="button" onClick={onClearSelection} aria-label="Clear selection" title="Clear selection" className={styles.closeBtn}>
        <X className={styles.iconClose} />
      </button>
    </div>,
    document.body
  );
};

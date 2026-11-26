import React, { useEffect, useState } from 'react';
import { Loader2, Sparkles, X } from 'lucide-react';
import type { StemLane, TimeSelection } from '../../../shared/api';
import { Popover } from '../../../shared/components/Popover/Popover';
import { formatTimeRange } from '../../../shared/utils/format';
import styles from './SpeedPitchPopover.module.css';

export interface SpeedPitchPayload {
  speedRate: number;
  semitones: number;
  addReverb: boolean;
  reverbWet: number;
  lane: StemLane;
}

export interface SpeedPitchPopoverProps {
  open: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  selection: TimeSelection | null;
  stemsReady?: boolean;
  applying: boolean;
  onClose: () => void;
  onApply: (payload: SpeedPitchPayload) => Promise<void>;
}

const PRESETS = [
  { label: 'Slowed + Reverb', speed: 0.85, semitones: -2, wet: 0.42 },
  { label: 'Sped Up 1.2x', speed: 1.2, semitones: 2, wet: 0 },
  { label: 'Deep Pitch', speed: 1.0, semitones: -3, wet: 0 },
] as const;

const LANE_CHIPS: Array<{ id: StemLane; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'vocals', label: 'Vocals' },
  { id: 'drums', label: 'Drums' },
  { id: 'bass', label: 'Bass' },
  { id: 'other', label: 'Melody' },
];

export const SpeedPitchPopover: React.FC<SpeedPitchPopoverProps> = ({
  open, anchorRef, selection, stemsReady = true, applying, onClose, onApply,
}) => {
  const [speedRate, setSpeedRate] = useState(1.0);
  const [semitones, setSemitones] = useState(0);
  const [reverbWet, setReverbWet] = useState(0);
  const [lane, setLane] = useState<StemLane>('all');

  useEffect(() => {
    if (!open) return;
    const selLane = selection?.lane ?? 'all';
    setLane(stemsReady || selLane === 'all' ? selLane : 'all');
  }, [open, selection?.lane, stemsReady]);

  const addReverb = reverbWet > 0.005;
  const unchanged = Math.abs(speedRate - 1.0) < 0.005 && Math.abs(semitones) < 0.05 && !addReverb;

  return (
    <Popover anchorRef={anchorRef} open={open} onClose={onClose} width={304} ariaLabel="Speed and Pitch">
      <div className={styles.body}>
        <div className={styles.header}>
          <div>
            <div className={styles.title}>Speed &amp; Pitch</div>
            <div className={styles.subtitle}>
              Applies to {selection ? formatTimeRange(selection.start, selection.end) : 'entire track'}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className={styles.closeBtn}>
            <X className={styles.iconSm} />
          </button>
        </div>

        <div className={styles.controlGroup}>
          <span className={styles.controlLabel}>Target Lane</span>
          <div className={styles.chipRow}>
            {LANE_CHIPS.map((c) => {
              const disabled = c.id !== 'all' && !stemsReady;
              return (
                <button
                  key={c.id}
                  type="button"
                  disabled={disabled}
                  aria-pressed={lane === c.id}
                  title={disabled ? 'Separate stems first to target a single stem' : undefined}
                  onClick={() => setLane(c.id)}
                  className={lane === c.id ? `${styles.chip} ${styles.chipActive}` : styles.chip}
                >
                  {c.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className={styles.presetsGrid}>
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => { setSpeedRate(p.speed); setSemitones(p.semitones); setReverbWet(p.wet); }}
              className={styles.presetBtn}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className={styles.controlGroup}>
          <div className={styles.controlHeader}>
            <span className={styles.controlLabel}>Speed</span>
            <span className={styles.controlValue}>{speedRate.toFixed(2)}x</span>
          </div>
          <input
            type="range" min={0.5} max={1.6} step={0.01} value={speedRate}
            onChange={(e) => setSpeedRate(Number(e.target.value))}
            aria-label="Speed" className={styles.slider}
          />
        </div>

        <div className={styles.controlGroup}>
          <div className={styles.controlHeader}>
            <span className={styles.controlLabel}>Pitch Shift</span>
            <span className={styles.controlValue}>{semitones > 0 ? `+${semitones}` : semitones} st</span>
          </div>
          <input
            type="range" min={-12} max={12} step={0.5} value={semitones}
            onChange={(e) => setSemitones(Number(e.target.value))}
            aria-label="Pitch Shift" className={styles.slider}
          />
        </div>

        <div className={styles.controlGroup}>
          <div className={styles.controlHeader}>
            <span className={styles.controlLabel}>Reverb Wet</span>
            <span className={styles.controlValue}>{Math.round(reverbWet * 100)}%</span>
          </div>
          <input
            type="range" min={0} max={0.8} step={0.05} value={reverbWet}
            onChange={(e) => setReverbWet(Number(e.target.value))}
            aria-label="Reverb Wet" className={styles.slider}
          />
        </div>

        <button
          type="button"
          disabled={applying || unchanged}
          onClick={() => void onApply({ speedRate, semitones, addReverb, reverbWet, lane })}
          className={styles.applyBtn}
        >
          {applying ? (
            <><Loader2 className={styles.iconSpin} />Rendering...</>
          ) : (
            <><Sparkles className={styles.iconSm} />Apply to Remix</>
          )}
        </button>
      </div>
    </Popover>
  );
};

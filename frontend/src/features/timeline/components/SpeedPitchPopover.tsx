import React, { useState } from 'react';
import { Loader2, Sparkles, X } from 'lucide-react';
import type { TimeSelection } from '../../../shared/api';
import { Popover } from '../../../shared/components/Popover/Popover';
import { formatTimeRange } from '../../../shared/utils/format';
import styles from './SpeedPitchPopover.module.css';

export interface SpeedPitchPayload {
  speedRate: number;
  semitones: number;
  addReverb: boolean;
}

export interface SpeedPitchPopoverProps {
  open: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  selection: TimeSelection | null;
  applying: boolean;
  onClose: () => void;
  onApply: (payload: SpeedPitchPayload) => Promise<void>;
}

const PRESETS = [
  { label: 'Slowed + Reverb', speed: 0.85, semitones: -2, reverb: true },
  { label: 'Sped Up 1.2x', speed: 1.2, semitones: 2, reverb: false },
  { label: 'Deep Pitch', speed: 1.0, semitones: -3, reverb: false },
] as const;

export const SpeedPitchPopover: React.FC<SpeedPitchPopoverProps> = ({
  open, anchorRef, selection, applying, onClose, onApply,
}) => {
  const [speedRate, setSpeedRate] = useState(1.0);
  const [semitones, setSemitones] = useState(0);
  const [addReverb, setAddReverb] = useState(false);

  const unchanged = Math.abs(speedRate - 1.0) < 0.005 && Math.abs(semitones) < 0.05 && !addReverb;

  return (
    <Popover anchorRef={anchorRef} open={open} onClose={onClose} width={288} ariaLabel="Speed and Pitch">
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

        <div className={styles.presetsGrid}>
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => { setSpeedRate(p.speed); setSemitones(p.semitones); setAddReverb(p.reverb); }}
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
            type="range"
            min={0.75}
            max={1.35}
            step={0.01}
            value={speedRate}
            onChange={(e) => setSpeedRate(Number(e.target.value))}
            aria-label="Speed"
            className={styles.slider}
          />
        </div>

        <div className={styles.controlGroup}>
          <div className={styles.controlHeader}>
            <span className={styles.controlLabel}>Pitch Shift</span>
            <span className={styles.controlValue}>{semitones > 0 ? `+${semitones}` : semitones} st</span>
          </div>
          <input
            type="range"
            min={-6}
            max={6}
            step={0.5}
            value={semitones}
            onChange={(e) => setSemitones(Number(e.target.value))}
            aria-label="Pitch Shift"
            className={styles.slider}
          />
        </div>

        <label className={styles.checkboxRow}>
          <input
            type="checkbox"
            checked={addReverb}
            onChange={(e) => setAddReverb(e.target.checked)}
            className={styles.checkbox}
          />
          <span>Add dreamy reverb wash</span>
        </label>

        <button
          type="button"
          disabled={applying || unchanged}
          onClick={() => void onApply({ speedRate, semitones, addReverb })}
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

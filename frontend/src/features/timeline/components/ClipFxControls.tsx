import React, { useEffect, useState } from 'react';
import type { EditOperation, EditUpdatePayload } from '../../../shared/api';
import styles from './ClipFxControls.module.css';

export interface ClipFxControlsProps {
  op: EditOperation;
  busy: boolean;
  onUpdate: (patch: EditUpdatePayload) => Promise<void>;
}

const DELAY_DIVS = [{ label: '1/4', value: 0.25 }, { label: '1/2', value: 0.5 }, { label: '3/4', value: 0.75 }, { label: '1 Beat', value: 1 }] as const;
const STUTTER_DIVS = [{ label: '1/8', value: 0.125 }, { label: '1/4', value: 0.25 }, { label: '1/2', value: 0.5 }] as const;

const FxSliderRow: React.FC<{
  label: string; displayValue: string; min: number; max: number; step: number;
  value: number; disabled: boolean; onDraft: (v: number) => void; onCommit: (v: number) => void;
}> = ({ label, displayValue, min, max, step, value, disabled, onDraft, onCommit }) => (
  <div className={styles.sliderBlock}>
    <div className={styles.sliderHeader}>
      <span className={styles.sliderLabel}>{label}</span>
      <span className={styles.sliderValue}>{displayValue}</span>
    </div>
    <input
      type="range" min={min} max={max} step={step} disabled={disabled}
      value={Math.max(min, Math.min(max, value))} aria-label={label}
      onChange={(e) => onDraft(Number(e.target.value))}
      onPointerUp={(e) => onCommit(Number(e.currentTarget.value))}
      onKeyUp={(e) => onCommit(Number(e.currentTarget.value))}
      className={styles.slider}
    />
  </div>
);

function filterFreqs(mode: 'highpass' | 'lowpass', up: boolean): { start_hz: number; end_hz: number } {
  if (mode === 'highpass') return up ? { start_hz: 120, end_hz: 2600 } : { start_hz: 2600, end_hz: 120 };
  return up ? { start_hz: 280, end_hz: 14000 } : { start_hz: 6000, end_hz: 280 };
}

export const ClipFxControls: React.FC<ClipFxControlsProps> = ({ op, busy, onUpdate }) => {
  const [wet, setWet] = useState(op.wet_level ?? 0.48);
  const [room, setRoom] = useState(op.room_size ?? 0.85);
  const [mix, setMix] = useState(op.mix ?? 0.45);
  const [feedback, setFeedback] = useState(op.feedback ?? 0.45);
  const [drive, setDrive] = useState(op.drive_db ?? 4);
  const [warmth, setWarmth] = useState(op.high_cut_hz ?? 3400);
  const [boost, setBoost] = useState(op.gain_db ?? 6);
  const [cutoff, setCutoff] = useState(op.cutoff_hz ?? 140);

  useEffect(() => {
    setWet(op.wet_level ?? 0.48); setRoom(op.room_size ?? 0.85);
    setMix(op.mix ?? 0.45); setFeedback(op.feedback ?? 0.45);
    setDrive(op.drive_db ?? 4); setWarmth(op.high_cut_hz ?? 3400);
    setBoost(op.gain_db ?? 6); setCutoff(op.cutoff_hz ?? 140);
  }, [op]);

  if (op.type === 'filter_sweep') {
    const mode = op.mode === 'highpass' ? 'highpass' : 'lowpass';
    const isUp = (op.end_hz ?? 2600) >= (op.start_hz ?? 120);
    return (
      <div className={styles.section}>
        <span className={styles.groupLabel}>Filter Mode</span>
        <div className={styles.chipRow}>
          {(['highpass', 'lowpass'] as const).map((m) => (
            <button
              key={m} type="button" disabled={busy} aria-pressed={mode === m}
              onClick={() => void onUpdate({ mode: m, ...filterFreqs(m, isUp) })}
              className={mode === m ? `${styles.chip} ${styles.chipActive}` : styles.chip}
            >
              {m === 'highpass' ? 'High-Pass' : 'Low-Pass'}
            </button>
          ))}
        </div>
        <span className={styles.groupLabel}>Sweep Direction</span>
        <div className={styles.chipRow}>
          {[true, false].map((up) => (
            <button
              key={String(up)} type="button" disabled={busy} aria-pressed={isUp === up}
              onClick={() => void onUpdate({ mode, ...filterFreqs(mode, up) })}
              className={isUp === up ? `${styles.chip} ${styles.chipActive}` : styles.chip}
            >
              {up ? 'Sweep Up' : 'Sweep Down'}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (op.type === 'reverb_throw') {
    return (
      <div className={styles.section}>
        <FxSliderRow label="Wet Mix" displayValue={`${Math.round(wet * 100)}%`} min={0.1} max={0.9} step={0.05} value={wet} disabled={busy} onDraft={setWet} onCommit={(v) => void onUpdate({ wet_level: v })} />
        <FxSliderRow label="Room Size" displayValue={`${Math.round(room * 100)}%`} min={0.2} max={0.95} step={0.05} value={room} disabled={busy} onDraft={setRoom} onCommit={(v) => void onUpdate({ room_size: v })} />
      </div>
    );
  }

  if (op.type === 'delay_throw') {
    const curBeat = op.delay_beats ?? 0.5;
    return (
      <div className={styles.section}>
        <span className={styles.groupLabel}>Echo Speed</span>
        <div className={styles.chipRow}>
          {DELAY_DIVS.map((d) => (
            <button
              key={d.value} type="button" disabled={busy} aria-pressed={Math.abs(curBeat - d.value) < 0.02}
              onClick={() => void onUpdate({ delay_beats: d.value })}
              className={Math.abs(curBeat - d.value) < 0.02 ? `${styles.chip} ${styles.chipActive}` : styles.chip}
            >
              {d.label}
            </button>
          ))}
        </div>
        <FxSliderRow label="Echo Mix" displayValue={`${Math.round(mix * 100)}%`} min={0.1} max={0.9} step={0.05} value={mix} disabled={busy} onDraft={setMix} onCommit={(v) => void onUpdate({ mix: v })} />
        <FxSliderRow label="Feedback" displayValue={`${Math.round(feedback * 100)}%`} min={0.1} max={0.85} step={0.05} value={feedback} disabled={busy} onDraft={setFeedback} onCommit={(v) => void onUpdate({ feedback: v })} />
      </div>
    );
  }

  if (op.type === 'lofi_eq') {
    return (
      <div className={styles.section}>
        <FxSliderRow label="Grit / Drive" displayValue={`${drive} dB`} min={0} max={20} step={1} value={drive} disabled={busy} onDraft={setDrive} onCommit={(v) => void onUpdate({ drive_db: v })} />
        <FxSliderRow label="Warmth" displayValue={`${warmth} Hz`} min={Math.max(1200, Math.round((op.low_cut_hz ?? 300) + 100))} max={6000} step={100} value={warmth} disabled={busy} onDraft={setWarmth} onCommit={(v) => void onUpdate({ high_cut_hz: v })} />
      </div>
    );
  }

  if (op.type === 'bass_boost') {
    return (
      <div className={styles.section}>
        <FxSliderRow label="Boost" displayValue={`+${boost} dB`} min={0} max={12} step={1} value={boost} disabled={busy} onDraft={setBoost} onCommit={(v) => void onUpdate({ gain_db: v })} />
        <FxSliderRow label="Cutoff" displayValue={`${cutoff} Hz`} min={80} max={200} step={10} value={cutoff} disabled={busy} onDraft={setCutoff} onCommit={(v) => void onUpdate({ cutoff_hz: v })} />
      </div>
    );
  }

  if (op.type === 'beat_repeat') {
    const curDiv = op.division_beats ?? 0.25;
    return (
      <div className={styles.section}>
        <span className={styles.groupLabel}>Stutter Speed</span>
        <div className={styles.chipRow}>
          {STUTTER_DIVS.map((d) => (
            <button
              key={d.value} type="button" disabled={busy} aria-pressed={Math.abs(curDiv - d.value) < 0.01}
              onClick={() => void onUpdate({ division_beats: d.value })}
              className={Math.abs(curDiv - d.value) < 0.01 ? `${styles.chip} ${styles.chipActive}` : styles.chip}
            >
              {d.label} Beat
            </button>
          ))}
        </div>
      </div>
    );
  }

  return null;
};

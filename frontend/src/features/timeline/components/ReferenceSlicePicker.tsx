import React, { useEffect, useState } from 'react';
import type { ReferenceLayerOptions, ReferenceTrack } from '../../../shared/api';
import { formatTimeRange } from '../../../shared/utils/format';
import { AUTO_DUCK_PRESETS } from '../constants';
import styles from './ReferenceSlicePicker.module.css';

type RefStemChoice = 'full' | 'vocals' | 'drums' | 'bass' | 'other';

const STEM_CHOICES: Array<{ id: RefStemChoice; label: string }> = [
  { id: 'full', label: 'Full' },
  { id: 'vocals', label: 'Vocals' },
  { id: 'drums', label: 'Drums' },
  { id: 'bass', label: 'Bass' },
  { id: 'other', label: 'Melody' },
];

export interface ReferenceSlicePickerProps {
  refTrack: ReferenceTrack;
  dropTime: number;
  busy: boolean;
  onDropReference: (options: ReferenceLayerOptions) => Promise<void>;
}

export const ReferenceSlicePicker: React.FC<ReferenceSlicePickerProps> = ({
  refTrack,
  dropTime,
  busy,
  onDropReference,
}) => {
  const defaultEnd = Number(Math.min(refTrack.duration ?? 16, 16).toFixed(2));
  const [momentId, setMomentId] = useState<string>('custom');
  const [refStart, setRefStart] = useState(0);
  const [refEnd, setRefEnd] = useState(defaultEnd > 0.5 ? defaultEnd : 8);
  const [stem, setStem] = useState<RefStemChoice>('full');
  const [duckId, setDuckId] = useState<string>('none');
  const [matchBpm, setMatchBpm] = useState(true);
  const [matchKey, setMatchKey] = useState(true);
  const [loopToFit, setLoopToFit] = useState(false);

  useEffect(() => {
    const firstMoment = refTrack.moments[0];
    if (firstMoment) {
      setMomentId(firstMoment.id);
      setRefStart(firstMoment.start);
      setRefEnd(firstMoment.end);
    } else {
      setMomentId('custom');
      setRefStart(0);
      setRefEnd(Number(Math.min(refTrack.duration ?? 16, 16).toFixed(2)) || 8);
    }
    setStem('full');
    setDuckId('none');
    setMatchBpm(true);
    setMatchKey(true);
    setLoopToFit(false);
  }, [refTrack]);

  const handleMomentChange = (nextId: string) => {
    setMomentId(nextId);
    const found = refTrack.moments.find((m) => m.id === nextId);
    if (found) {
      setRefStart(found.start);
      setRefEnd(found.end);
    }
  };

  const handleStemSelect = (nextStem: RefStemChoice) => {
    setStem(nextStem);
    setMatchKey(nextStem !== 'drums');
  };

  const selectedMoment = refTrack.moments.find((m) => m.id === momentId);
  const duckPreset = AUTO_DUCK_PRESETS.find((p) => p.id === duckId);
  const validRange = Number.isFinite(refStart) && Number.isFinite(refEnd) && refEnd > refStart + 0.1;

  const handleSubmit = () => {
    if (!validRange || busy) return;
    void onDropReference({
      ref: refTrack,
      stem,
      refStart: Math.max(0, refStart),
      refEnd,
      targetStart: dropTime,
      replaceMainStems: duckPreset?.stems ?? [],
      matchBpm,
      matchKey,
      loopToFit,
      label: selectedMoment?.label,
    });
  };

  return (
    <div className={styles.picker}>
      <div className={styles.fieldRow}>
        <label className={styles.fieldLabel} htmlFor="ref-moment-select">Source Moment</label>
        <select
          id="ref-moment-select"
          value={momentId}
          onChange={(e) => handleMomentChange(e.target.value)}
          className={styles.select}
        >
          {refTrack.moments.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} ({formatTimeRange(m.start, m.end)})
            </option>
          ))}
          <option value="custom">Custom Start / End</option>
        </select>
      </div>

      <div className={styles.rangeGrid}>
        <label className={styles.numWrap}>
          <span className={styles.numTag}>Start (s)</span>
          <input
            type="number"
            min={0}
            step={0.1}
            value={refStart}
            aria-label="Source Start"
            onChange={(e) => { setMomentId('custom'); setRefStart(Number(e.target.value)); }}
            className={styles.numInput}
          />
        </label>
        <label className={styles.numWrap}>
          <span className={styles.numTag}>End (s)</span>
          <input
            type="number"
            min={0.2}
            step={0.1}
            value={refEnd}
            aria-label="Source End"
            onChange={(e) => { setMomentId('custom'); setRefEnd(Number(e.target.value)); }}
            className={styles.numInput}
          />
        </label>
      </div>

      <div className={styles.fieldRow}>
        <span className={styles.fieldLabel}>Stem</span>
        <div className={styles.chipRow}>
          {STEM_CHOICES.map((c) => {
            const disabled = c.id !== 'full' && refTrack.stems_status !== 'ready';
            return (
              <button
                key={c.id}
                type="button"
                disabled={disabled}
                onClick={() => handleStemSelect(c.id)}
                title={disabled ? 'Separate stems on this reference first' : undefined}
                className={stem === c.id ? `${styles.chip} ${styles.chipActive}` : styles.chip}
              >
                {c.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className={styles.fieldRow}>
        <span className={styles.fieldLabel}>Auto-Duck Main</span>
        <div className={styles.chipRow}>
          {AUTO_DUCK_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setDuckId(p.id)}
              className={duckId === p.id ? `${styles.chip} ${styles.chipActive}` : styles.chip}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.checksRow}>
        <label className={styles.checkLabel}>
          <input type="checkbox" checked={matchBpm} onChange={(e) => setMatchBpm(e.target.checked)} className={styles.checkbox} />
          <span>Match BPM</span>
        </label>
        <label className={styles.checkLabel}>
          <input type="checkbox" checked={matchKey} onChange={(e) => setMatchKey(e.target.checked)} className={styles.checkbox} />
          <span>Match Key</span>
        </label>
        <label className={styles.checkLabel}>
          <input type="checkbox" checked={loopToFit} onChange={(e) => setLoopToFit(e.target.checked)} className={styles.checkbox} />
          <span>Loop to Fit</span>
        </label>
      </div>

      <button
        type="button"
        disabled={busy || !validRange}
        onClick={handleSubmit}
        className={styles.submitBtn}
      >
        + Drop Reference Clip
      </button>
    </div>
  );
};

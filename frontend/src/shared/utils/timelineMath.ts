import type { EditBlock } from '../api/types';
import { clamp } from './format';

export type InstrumentStem = 'vocals' | 'drums' | 'bass' | 'other';
export type EditLane = InstrumentStem | 'layer' | 'master';

export const MIN_CLIP_DURATION = 0.25;

const VALID_STEMS = new Set<InstrumentStem>(['vocals', 'drums', 'bass', 'other']);
const GAIN_OP_TYPES = new Set(['stem_gain', 'add_sfx', 'borrow_stem', 'bass_boost']);

export function snapTimeToBeat(t: number, beats: number[], enabled: boolean): number {
  if (!enabled || !beats || beats.length === 0) return t;
  let closest = beats[0];
  let bestDiff = Math.abs(t - closest);
  for (let i = 1; i < beats.length; i++) {
    const diff = Math.abs(t - beats[i]);
    if (diff < bestDiff) {
      bestDiff = diff;
      closest = beats[i];
    }
  }
  return closest;
}

export function computeBarsEnd(
  start: number,
  bars: number,
  bpm: number,
  duration: number,
  beats: number[],
  beatSnap: boolean
): number {
  const safeDuration = Math.max(0, duration);
  const effectiveBpm = bpm && Number.isFinite(bpm) && bpm > 20 ? bpm : 120;
  const rawEnd = Math.min(safeDuration, start + bars * 4 * (60 / effectiveBpm));
  const snapped = snapTimeToBeat(rawEnd, beats, beatSnap);
  return clamp(snapped, Math.min(safeDuration, start), safeDuration);
}

export function computeMovedRange(
  origStart: number,
  origEnd: number,
  deltaSec: number,
  duration: number,
  beats: number[],
  beatSnap: boolean
): { start: number; end: number } {
  const safeDuration = Math.max(0, duration);
  const origDur = Math.min(safeDuration, Math.max(MIN_CLIP_DURATION, origEnd - origStart));
  const maxStart = Math.max(0, safeDuration - origDur);
  const rawStart = clamp(origStart + deltaSec, 0, maxStart);
  const snapped = snapTimeToBeat(rawStart, beats, beatSnap);
  const nextStart = clamp(snapped, 0, maxStart);
  const nextEnd = clamp(nextStart + origDur, nextStart, safeDuration);
  return {
    start: Number(nextStart.toFixed(2)),
    end: Number(nextEnd.toFixed(2)),
  };
}

export function computeResizedRange(
  origStart: number,
  origEnd: number,
  edge: 'left' | 'right',
  deltaSec: number,
  duration: number,
  beats: number[],
  beatSnap: boolean
): { start: number; end: number } {
  const safeDuration = Math.max(0, duration);
  if (edge === 'left') {
    const maxStart = Math.max(0, origEnd - MIN_CLIP_DURATION);
    const rawStart = clamp(origStart + deltaSec, 0, maxStart);
    const snapped = snapTimeToBeat(rawStart, beats, beatSnap);
    const nextStart = clamp(snapped, 0, maxStart);
    return {
      start: Number(nextStart.toFixed(2)),
      end: Number(origEnd.toFixed(2)),
    };
  }

  const minEnd = Math.min(safeDuration, origStart + MIN_CLIP_DURATION);
  const rawEnd = clamp(origEnd + deltaSec, minEnd, safeDuration);
  const snapped = snapTimeToBeat(rawEnd, beats, beatSnap);
  const nextEnd = clamp(snapped, minEnd, safeDuration);
  return {
    start: Number(origStart.toFixed(2)),
    end: Number(nextEnd.toFixed(2)),
  };
}

export function getEditGainDb(edit: EditBlock): number {
  const preferred = edit.operations.find(
    (op) => (op.type === 'borrow_stem' || op.type === 'add_sfx') && typeof op.gain_db === 'number' && Number.isFinite(op.gain_db)
  );
  if (preferred && typeof preferred.gain_db === 'number') {
    return preferred.gain_db;
  }
  for (const op of edit.operations) {
    if (typeof op.gain_db === 'number' && Number.isFinite(op.gain_db)) {
      return op.gain_db;
    }
  }
  return 0;
}

export function editSupportsGain(edit: EditBlock): boolean {
  return edit.operations.some((op) => GAIN_OP_TYPES.has(op.type));
}

export function classifyEditLane(edit: EditBlock): EditLane {
  if (edit.operations.some((op) => op.type === 'add_sfx' || op.type === 'borrow_stem')) {
    return 'layer';
  }
  if (edit.operations.some((op) => op.type === 'cut_section' || op.type === 'repeat_section')) {
    return 'master';
  }

  const targeted = new Set<InstrumentStem>();
  let hasNonStemOp = false;

  for (const op of edit.operations) {
    if (!op.stems || op.stems.length === 0) {
      hasNonStemOp = true;
      continue;
    }
    const matched = op.stems.filter((s): s is InstrumentStem =>
      VALID_STEMS.has(s as InstrumentStem)
    );
    if (matched.length === 0) {
      hasNonStemOp = true;
    } else {
      matched.forEach((s) => targeted.add(s));
    }
  }

  if (!hasNonStemOp && targeted.size === 1) {
    return Array.from(targeted)[0];
  }
  return 'master';
}

import { describe, expect, it } from 'vitest';
import type { EditBlock } from '../api/types';
import {
  classifyEditLane,
  computeBarsEnd,
  computeMovedRange,
  computeResizedRange,
  editSupportsGain,
  getEditGainDb,
  snapTimeToBeat,
} from './timelineMath';

function makeEdit(operations: EditBlock['operations']): EditBlock {
  return {
    id: 'e1',
    title: 'Test Edit',
    description: 'desc',
    start: 4,
    end: 12,
    enabled: true,
    operations,
    created_at: '2026-01-01T00:00:00Z',
  };
}

describe('timelineMath', () => {
  const beats = [0, 0.5, 1.0, 1.5, 2.0, 4.0, 8.0, 12.0, 16.0];

  it('snaps time to nearest beat only when enabled and beats exist', () => {
    expect(snapTimeToBeat(1.18, beats, true)).toBe(1.0);
    expect(snapTimeToBeat(1.38, beats, true)).toBe(1.5);
    expect(snapTimeToBeat(1.38, beats, false)).toBe(1.38);
    expect(snapTimeToBeat(1.38, [], true)).toBe(1.38);
  });

  it('computes bar end duration and clamps to track duration', () => {
    // 120 BPM => 4 beats = 2.0s per bar => 4 bars = 8.0s
    expect(computeBarsEnd(4, 4, 120, 30, [], false)).toBe(12);
    // Clamped to track duration
    expect(computeBarsEnd(25, 4, 120, 30, [], false)).toBe(30);
    // Invalid BPM falls back to 120 BPM
    expect(computeBarsEnd(0, 4, 0, 30, [], false)).toBe(8);
    // Beat snap adjusts raw end to nearest beat
    expect(computeBarsEnd(0, 1, 100, 30, [0, 2.0, 4.0], true)).toBe(2.0);
  });

  it('moves clips while preserving duration, snapping, and clamping within bounds', () => {
    expect(computeMovedRange(4, 8, 2.2, 20, beats, false)).toEqual({ start: 6.2, end: 10.2 });
    // Clamps at 0
    expect(computeMovedRange(2, 6, -5, 20, beats, false)).toEqual({ start: 0, end: 4 });
    // Clamps at duration - origDur
    expect(computeMovedRange(10, 14, 10, 20, beats, false)).toEqual({ start: 16, end: 20 });
    // Snaps start to nearest beat and keeps duration
    expect(computeMovedRange(4, 8, 3.8, 20, beats, true)).toEqual({ start: 8, end: 12 });
  });

  it('resizes left and right edges with 0.25s min-width and clamping', () => {
    // Left resize shrinks toward end but stops at MIN_CLIP_DURATION (0.25)
    expect(computeResizedRange(4, 8, 'left', 10, 20, beats, false)).toEqual({
      start: 7.75,
      end: 8,
    });
    // Left resize clamps at 0
    expect(computeResizedRange(4, 8, 'left', -10, 20, beats, false)).toEqual({
      start: 0,
      end: 8,
    });
    // Right resize enforces MIN_CLIP_DURATION
    expect(computeResizedRange(4, 8, 'right', -10, 20, beats, false)).toEqual({
      start: 4,
      end: 4.25,
    });
    // Right resize clamps at track duration and snaps when enabled
    expect(computeResizedRange(4, 8, 'right', 3.7, 20, beats, true)).toEqual({
      start: 4,
      end: 12,
    });
  });

  it('classifies edit lanes accurately', () => {
    expect(classifyEditLane(makeEdit([{ type: 'stem_gain', stems: ['vocals'], gain_db: -6 }]))).toBe(
      'vocals'
    );
    expect(classifyEditLane(makeEdit([{ type: 'reverb_throw', stems: ['drums'] }]))).toBe('drums');
    expect(classifyEditLane(makeEdit([{ type: 'bass_boost', stems: ['bass'] }]))).toBe('bass');
    expect(classifyEditLane(makeEdit([{ type: 'lofi_eq', stems: ['other'] }]))).toBe('other');
    expect(classifyEditLane(makeEdit([{ type: 'add_sfx', sfx_id: 'riser' }]))).toBe('layer');
    expect(classifyEditLane(makeEdit([{ type: 'borrow_stem', ref_id: 'r1' }]))).toBe('layer');
    expect(
      classifyEditLane(makeEdit([{ type: 'stem_gain', stems: ['vocals', 'drums'], gain_db: -3 }]))
    ).toBe('master');
    expect(classifyEditLane(makeEdit([{ type: 'filter_sweep' }]))).toBe('master');
    expect(classifyEditLane(makeEdit([{ type: 'cut_section' }]))).toBe('master');
    expect(classifyEditLane(makeEdit([{ type: 'cut_section', stems: ['drums'] }]))).toBe('master');
    expect(classifyEditLane(makeEdit([{ type: 'repeat_section', repeat_count: 2 }]))).toBe('master');
    expect(classifyEditLane(makeEdit([{ type: 'beat_repeat', stems: ['drums'], division_beats: 0.5 }]))).toBe('drums');
    expect(classifyEditLane(makeEdit([{ type: 'beat_repeat', stems: ['all'], division_beats: 0.5 }]))).toBe('master');
    expect(classifyEditLane(makeEdit([{ type: 'beat_repeat', division_beats: 0.5 }]))).toBe('master');
    expect(classifyEditLane(makeEdit([{ type: 'vinyl_brake', stems: ['vocals'] }]))).toBe('vocals');
    expect(
      classifyEditLane(makeEdit([{ type: 'vinyl_brake', stems: ['vocals', 'drums', 'bass', 'other'] }]))
    ).toBe('master');
  });

  it('extracts gain_db and detects gain-capable operations', () => {
    const gainEdit = makeEdit([{ type: 'stem_gain', stems: ['vocals'], gain_db: -4.5 }]);
    const sfxEdit = makeEdit([{ type: 'add_sfx', sfx_id: 'boom' }]);
    const filterEdit = makeEdit([{ type: 'filter_sweep', mode: 'highpass' }]);

    expect(getEditGainDb(gainEdit)).toBe(-4.5);
    expect(getEditGainDb(filterEdit)).toBe(0);

    expect(editSupportsGain(gainEdit)).toBe(true);
    expect(editSupportsGain(sfxEdit)).toBe(true);
    expect(editSupportsGain(filterEdit)).toBe(false);
  });
});

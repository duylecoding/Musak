import { describe, expect, it } from 'vitest';
import type { MainTrack, ReferenceTrack } from '../shared/api';
import { buildReferenceLayerPayload, normalizeReferenceLayerOptions } from './editPayloads';

const MAIN_TRACK: MainTrack = {
  id: 'main-1',
  name: 'Main Song',
  duration: 180,
  sample_rate: 44100,
  bpm: 120,
  key: 'Am',
  beats: [],
  sections: [],
  lyric_hooks: [],
  cues: [],
  stems_status: 'ready',
  stems_error: null,
  stems: ['vocals', 'drums', 'bass', 'other'],
  audio_url: '/audio.wav',
  rendered_url: '/rendered.wav',
  stem_urls: {},
};

const REF_TRACK: ReferenceTrack = {
  id: 'ref-1',
  title: 'Reference Groove',
  source_type: 'local',
  youtube_url: null,
  youtube_id: null,
  duration: 200,
  bpm: 124,
  key: 'Cm',
  audio_downloaded: true,
  stems_status: 'ready',
  stems_error: null,
  audio_url: '/ref.wav',
  moments: [],
  compatibility: null,
};

describe('editPayloads', () => {
  it('normalizes legacy positional args and ReferenceLayerOptions identically', () => {
    expect(normalizeReferenceLayerOptions(REF_TRACK, 'vocals', 12)).toEqual({
      ref: REF_TRACK,
      stem: 'vocals',
      targetStart: 12,
    });

    const opts = { ref: REF_TRACK, refStart: 64, refEnd: 80, targetStart: 15, label: 'Drop' };
    expect(normalizeReferenceLayerOptions(opts)).toBe(opts);
  });

  it('builds borrow_stem payload preserving moment [refStart, refEnd] and ducking options', () => {
    const result = buildReferenceLayerPayload(
      MAIN_TRACK,
      {
        ref: REF_TRACK,
        stem: 'vocals',
        refStart: 64,
        refEnd: 80,
        targetStart: 20,
        replaceMainStems: ['vocals', 'other'],
        matchBpm: true,
        matchKey: false,
        loopToFit: true,
        label: 'Chorus Drop',
      },
      0
    );

    expect(result.payload.title).toBe('@Reference Groove · Chorus Drop');
    expect(result.payload.start).toBe(20);
    // 16s slice stretched from 124 BPM -> 120 BPM = 16.53s
    expect(result.payload.end).toBe(36.53);
    expect(result.payload.operations).toEqual([
      {
        type: 'borrow_stem',
        ref_id: 'ref-1',
        ref_stem: 'vocals',
        ref_start: 64,
        ref_end: 80,
        target_start: 20,
        target_end: 36.53,
        match_bpm: true,
        match_key: false,
        loop_to_fit: true,
        replace_main_stems: ['vocals', 'other'],
        gain_db: 0,
      },
    ]);
  });

  it('uses default 4-bar window starting at ref_start 0 when refEnd is omitted', () => {
    const result = buildReferenceLayerPayload(
      MAIN_TRACK,
      { ref: REF_TRACK, stem: 'drums', targetStart: 10 },
      0
    );

    // 120 BPM => 4 bars = 8s ref slice, stretched 124 -> 120 BPM = 8.27s
    expect(result.payload.start).toBe(10);
    expect(result.payload.end).toBe(18.27);
    expect(result.payload.operations[0]).toMatchObject({
      type: 'borrow_stem',
      ref_stem: 'drums',
      ref_start: 0,
      ref_end: 8,
      match_bpm: true,
      match_key: false,
    });
  });

  it('scales target_end span for BPM stretch (143.6 BPM -> 139.7 BPM stretches 20s slice to ~20.56s)', () => {
    const result = buildReferenceLayerPayload(
      { ...MAIN_TRACK, bpm: 139.7 },
      {
        ref: { ...REF_TRACK, bpm: 143.6 },
        stem: 'other',
        refStart: 40,
        refEnd: 60,
        targetStart: 10,
        matchBpm: true,
      },
      0
    );

    expect(result.payload.start).toBe(10);
    expect(result.payload.end).toBe(30.56);
    expect(result.payload.operations[0]).toMatchObject({
      ref_start: 40,
      ref_end: 60,
      target_start: 10,
      target_end: 30.56,
    });
  });

  it('uses closest half/double-time BPM and skips stretch when matchBpm is false', () => {
    const halfTime = buildReferenceLayerPayload(
      { ...MAIN_TRACK, bpm: 140 },
      {
        ref: { ...REF_TRACK, bpm: 71.8 },
        stem: 'other',
        refStart: 0,
        refEnd: 20,
        targetStart: 0,
        matchBpm: true,
      },
      0
    );
    // 71.8 * 2 = 143.6 => 20 * (143.6 / 140) = 20.51
    expect(halfTime.payload.end).toBe(20.51);

    const noStretch = buildReferenceLayerPayload(
      { ...MAIN_TRACK, bpm: 139.7 },
      {
        ref: { ...REF_TRACK, bpm: 143.6 },
        stem: 'other',
        refStart: 40,
        refEnd: 60,
        targetStart: 170,
        matchBpm: false,
      },
      0
    );
    // Clamped cleanly to mainTrack.duration (180)
    expect(noStretch.payload.end).toBe(180);
  });
});

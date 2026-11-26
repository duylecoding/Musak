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
    expect(result.payload.end).toBe(36);
    expect(result.payload.operations).toEqual([
      {
        type: 'borrow_stem',
        ref_id: 'ref-1',
        ref_stem: 'vocals',
        ref_start: 64,
        ref_end: 80,
        target_start: 20,
        target_end: 36,
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

    // 120 BPM => 4 bars = 8s
    expect(result.payload.start).toBe(10);
    expect(result.payload.end).toBe(18);
    expect(result.payload.operations[0]).toMatchObject({
      type: 'borrow_stem',
      ref_stem: 'drums',
      ref_start: 0,
      ref_end: 8,
      match_bpm: true,
      match_key: false,
    });
  });
});

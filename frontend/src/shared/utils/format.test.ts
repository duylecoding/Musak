import { describe, expect, it } from 'vitest';
import {
  clamp,
  formatBpm,
  formatDb,
  formatTime,
  formatTimeRange,
  parseTimeInput,
  sanitizeFilename,
} from './format';

describe('format utilities', () => {
  it('formats seconds as m:ss safely', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(5)).toBe('0:05');
    expect(formatTime(65.9)).toBe('1:05');
    expect(formatTime(-3)).toBe('0:00');
    expect(formatTime(null)).toBe('0:00');
    expect(formatTime(Number.NaN)).toBe('0:00');
  });

  it('formats time ranges', () => {
    expect(formatTimeRange(12, 75)).toBe('0:12 – 1:15');
  });

  it('clamps numeric values', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-2, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
    expect(clamp(5, 10, 4)).toBe(10);
  });

  it('formats decibel values with explicit positive sign', () => {
    expect(formatDb(6)).toBe('+6 dB');
    expect(formatDb(-3.5)).toBe('-3.5 dB');
    expect(formatDb(0)).toBe('0 dB');
    expect(formatDb(Number.NaN)).toBe('0 dB');
  });

  it('parses user time strings', () => {
    expect(parseTimeInput('1:12')).toBe(72);
    expect(parseTimeInput('45.5')).toBe(45.5);
    expect(parseTimeInput('1:65')).toBeNull();
    expect(parseTimeInput('')).toBeNull();
  });

  it('formats BPM and sanitizes filenames', () => {
    expect(formatBpm(124.6)).toBe('125 BPM');
    expect(formatBpm(null)).toBe('');
    expect(sanitizeFilename('My Track (Remix)!')).toBe('My_Track_Remix');
    expect(sanitizeFilename('***')).toBe('musak_track');
  });
});

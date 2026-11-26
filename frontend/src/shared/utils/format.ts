export function clamp(value: number, min: number, max: number): number {
  if (min > max) return min;
  return Math.max(min, Math.min(max, value));
}

export function formatTime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return '0:00';
  }
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function formatTimeRange(start: number, end: number): string {
  return `${formatTime(start)} – ${formatTime(end)}`;
}

export function formatDb(db: number): string {
  if (!Number.isFinite(db)) return '0 dB';
  const rounded = Math.round(db * 10) / 10;
  if (rounded > 0) return `+${rounded} dB`;
  return `${rounded} dB`;
}

export function parseTimeInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const val = Number(trimmed);
    return Number.isFinite(val) && val >= 0 ? val : null;
  }
  const parts = trimmed.split(':');
  if (parts.length === 2) {
    const mins = Number(parts[0]);
    const secs = Number(parts[1]);
    if (Number.isFinite(mins) && Number.isFinite(secs) && mins >= 0 && secs >= 0 && secs < 60) {
      return mins * 60 + secs;
    }
  }
  return null;
}

export function formatBpm(bpm: number | null | undefined): string {
  if (!bpm || !Number.isFinite(bpm)) return '';
  return `${Math.round(bpm)} BPM`;
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[^a-z0-9\-_]+/gi, '_').replace(/^_+|_+$/g, '') || 'musak_track';
}

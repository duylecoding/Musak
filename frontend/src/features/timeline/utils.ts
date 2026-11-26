import type { EditBlock, StemLane } from '../../shared/api';
import { classifyEditLane, type InstrumentStem } from '../../shared/utils/timelineMath';
import type { StemChannelState } from './constants';

export function createInitialStemChannels(): Record<InstrumentStem, StemChannelState> {
  return {
    vocals: { volume: 100, muted: false, solo: false },
    drums: { volume: 100, muted: false, solo: false },
    bass: { volume: 100, muted: false, solo: false },
    other: { volume: 100, muted: false, solo: false },
  };
}

export function effectiveStemGain(
  stem: InstrumentStem,
  channels: Record<InstrumentStem, StemChannelState>
): number {
  const ch = channels[stem];
  const anySolo = Object.values(channels).some((c) => c.solo);
  if (anySolo && !ch.solo) return 0;
  if (ch.muted) return 0;
  return Math.max(0, Math.min(1.5, ch.volume / 100));
}

export function getLaneLabel(lane?: StemLane): string {
  switch (lane) {
    case 'vocals': return 'Vocals';
    case 'drums': return 'Drums';
    case 'bass': return 'Bass';
    case 'other': return 'Melody';
    default: return 'All Stems';
  }
}

export function getClipEmoji(edit: EditBlock): string {
  const first = edit.operations[0];
  if (!first) return '✨';
  if (first.type === 'add_sfx') {
    if (first.sfx_id?.includes('impact') || first.sfx_id?.includes('sub')) return '💥';
    if (first.sfx_id?.includes('snare') || first.sfx_id?.includes('drum')) return '🥁';
    if (first.sfx_id?.includes('tape')) return '📼';
    return '⚡';
  }
  if (first.type === 'borrow_stem') {
    if (first.ref_stem === 'drums') return '🥁';
    if (first.ref_stem === 'vocals') return '🎤';
    if (first.ref_stem === 'bass') return '🎸';
    return '🎧';
  }
  if (first.type === 'cut_section') return '✂️';
  if (first.type === 'repeat_section') return '🔁';
  if (first.type === 'beat_repeat') return '⚡';
  if (first.type === 'vinyl_brake') return '💿';
  if (first.type === 'stem_gain') return (first.gain_db ?? 0) <= -30 ? '🔇' : '🔊';
  if (first.type === 'filter_sweep') return '🌊';
  if (first.type === 'delay_throw') return '🔁';
  if (first.type === 'reverb_throw') return '✨';
  if (first.type === 'lofi_eq') return '📻';
  if (first.type === 'bass_boost') return '🔥';
  if (first.type === 'sidechain_pump') return '💓';
  if (first.type === 'stereo_wash') return '🌌';
  if (first.type === 'tempo_pitch') return '⏱️';
  return '🎛️';
}

export function sameStemSet(a: string[] | undefined, b: string[]): boolean {
  const normA = [...new Set(a ?? [])].sort();
  const normB = [...new Set(b)].sort();
  return normA.length === normB.length && normA.every((v, i) => v === normB[i]);
}

export function partitionEditsByLane(edits: EditBlock[]) {
  const masterEdits: EditBlock[] = [];
  const stemEditsMap: Record<InstrumentStem, EditBlock[]> = { vocals: [], drums: [], bass: [], other: [] };
  const layerEdits: EditBlock[] = [];
  for (const edit of edits) {
    const lane = classifyEditLane(edit);
    if (lane === 'layer') layerEdits.push(edit);
    else if (lane === 'master') masterEdits.push(edit);
    else stemEditsMap[lane].push(edit);
  }
  return { masterEdits, stemEditsMap, layerEdits };
}

export function computeRulerTicks(duration: number, zoom: number): number[] {
  if (duration <= 0) return [];
  const effectiveDur = duration / Math.max(1, zoom);
  const step =
    effectiveDur <= 12 ? 1
    : effectiveDur <= 25 ? 2
    : effectiveDur <= 50 ? 5
    : effectiveDur <= 110 ? 10
    : effectiveDur <= 210 ? 15
    : 30;
  const ticks: number[] = [];
  for (let t = 0; t <= duration; t += step) ticks.push(t);
  return ticks;
}

export type SectionTone = 'drop' | 'buildup' | 'verse' | 'bridge' | 'default';

export function getSectionTone(label: string): SectionTone {
  const lower = label.toLowerCase();
  if (lower.includes('drop') || lower.includes('chorus')) return 'drop';
  if (lower.includes('buildup') || lower.includes('pre')) return 'buildup';
  if (lower.includes('verse')) return 'verse';
  if (lower.includes('bridge') || lower.includes('break')) return 'bridge';
  return 'default';
}

export function drawWaveformCanvas(
  canvas: HTMLCanvasElement,
  container: HTMLElement,
  opts: { peaks: number[]; colorVar: string; opacity: number; muted: boolean; beats?: number[]; duration: number; width: number; height: number }
): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(opts.width * dpr);
  canvas.height = Math.floor(opts.height * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, opts.width, opts.height);
  const midY = opts.height / 2;

  if (opts.beats?.length && opts.duration > 0) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.lineWidth = 1;
    let lastX = -10;
    ctx.beginPath();
    for (const beat of opts.beats) {
      const x = (beat / opts.duration) * opts.width;
      if (x < 0 || x > opts.width || x - lastX < 10) continue;
      const crispX = Math.round(x) + 0.5;
      ctx.moveTo(crispX, 0);
      ctx.lineTo(crispX, opts.height);
      lastX = x;
    }
    ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, Math.round(midY) + 0.5);
  ctx.lineTo(opts.width, Math.round(midY) + 0.5);
  ctx.stroke();

  if (!opts.peaks.length) return;
  const color =
    getComputedStyle(container).getPropertyValue(opts.colorVar).trim() ||
    getComputedStyle(document.documentElement).getPropertyValue(opts.colorVar).trim() ||
    'rgb(139, 92, 246)';

  const barStep = 3.5;
  const numBars = Math.max(16, Math.floor(opts.width / barStep));
  const maxAmp = opts.height * 0.42;
  let maxPeak = 0;
  for (const p of opts.peaks) if (p > maxPeak) maxPeak = p;
  const norm = maxPeak > 0.001 ? 1 / maxPeak : 1;

  ctx.save();
  ctx.globalAlpha = opts.muted ? Math.min(opts.opacity, 0.25) : opts.opacity;
  ctx.fillStyle = color;
  for (let i = 0; i < numBars; i++) {
    const startIdx = Math.floor((i / numBars) * opts.peaks.length);
    const endIdx = Math.max(startIdx + 1, Math.floor(((i + 1) / numBars) * opts.peaks.length));
    let bucketPeak = 0;
    for (let j = startIdx; j < endIdx && j < opts.peaks.length; j++) {
      if (opts.peaks[j] > bucketPeak) bucketPeak = opts.peaks[j];
    }
    const amp = Math.max(2, Math.min(1, bucketPeak * norm) * maxAmp);
    const x = i * barStep;
    const y = midY - amp;
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(x, y, 2, amp * 2, 1);
      ctx.fill();
    } else {
      ctx.fillRect(x, y, 2, amp * 2);
    }
  }
  ctx.restore();
}

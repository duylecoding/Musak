import type {
  EditOperation,
  ExportOptions,
  MainTrack,
  ReferenceLayerOptions,
  ReferenceTrack,
  SfxItem,
} from '../shared/api';

export const EXPORT_TARGET_LABELS: Record<
  NonNullable<ExportOptions['target']>,
  { busy: (fmt: string) => string; done: (fmt: string) => string }
> = {
  remix: { busy: (f) => `Exporting ${f}...`, done: (f) => `Exported ${f} remix!` },
  instrumental: { busy: () => 'Exporting Instrumental...', done: () => 'Exported Instrumental WAV!' },
  vocals: { busy: () => 'Exporting Acapella...', done: () => 'Exported Acapella (Vocals) WAV!' },
  stems_zip: { busy: () => 'Zipping 4 Stems...', done: () => 'Exported all 4 stems (.zip)!' },
};

export function normalizeReferenceLayerOptions(
  refOrOptions: ReferenceTrack | ReferenceLayerOptions,
  stem: 'vocals' | 'drums' | 'bass' | 'other' | 'full' = 'full',
  startTime?: number
): ReferenceLayerOptions {
  if ('ref' in refOrOptions) {
    return refOrOptions;
  }
  return { ref: refOrOptions, stem, targetStart: startTime };
}

export function buildSfxLayerPayload(sfx: SfxItem, track: MainTrack, rawStart: number) {
  const dur = Math.max(0.5, sfx.default_duration || 2.0);
  const clampedStart = Math.max(0, Math.min(Math.max(0, track.duration - 0.5), rawStart));
  const end = Math.min(track.duration, clampedStart + dur);
  return {
    title: sfx.name,
    description: sfx.description,
    start: Number(clampedStart.toFixed(2)),
    end: Number(end.toFixed(2)),
    operations: [
      {
        type: 'add_sfx' as const,
        sfx_id: sfx.id,
        start: Number(clampedStart.toFixed(2)),
        end: Number(end.toFixed(2)),
        gain_db: 0,
        snap_to_beat: true,
      },
    ],
  };
}

export function buildReferenceLayerPayload(
  track: MainTrack,
  opts: ReferenceLayerOptions,
  fallbackStart: number
) {
  const { ref } = opts;
  const stem = opts.stem ?? 'full';
  const rawStart = opts.targetStart ?? fallbackStart;
  const refStart = Math.max(0, opts.refStart ?? 0);

  let clampedStart: number;
  let end: number;
  let refEnd: number;

  if (typeof opts.refEnd === 'number' && opts.refEnd > refStart) {
    const momentDur = opts.refEnd - refStart;
    clampedStart = Math.max(0, Math.min(Math.max(0, track.duration - 0.5), rawStart));
    end = Math.min(track.duration, clampedStart + momentDur);
    const actualLen = Math.max(0.5, end - clampedStart);
    refEnd = opts.loopToFit ? opts.refEnd : Math.min(opts.refEnd, refStart + actualLen);
  } else {
    const bpm = track.bpm && track.bpm > 20 ? track.bpm : 120;
    const bar4Dur = 4 * 4 * (60 / bpm);
    const availRefDur =
      ref.duration && ref.duration > refStart + 1 ? ref.duration - refStart : bar4Dur;
    const maxClipLen = Math.min(availRefDur, Math.max(4, Math.min(16, bar4Dur)));
    clampedStart = Math.max(0, Math.min(Math.max(0, track.duration - 1), rawStart));
    end = Math.min(track.duration, clampedStart + maxClipLen);
    const actualLen = Math.max(0.5, end - clampedStart);
    refEnd = refStart + actualLen;
  }

  const matchBpm = opts.matchBpm ?? true;
  const matchKey = opts.matchKey ?? stem !== 'drums';
  const stemLabel =
    stem === 'full' ? 'Clip' : stem === 'other' ? 'Melody' : stem.charAt(0).toUpperCase() + stem.slice(1);
  const shortTitle = ref.title.length > 22 ? `${ref.title.slice(0, 22)}…` : ref.title;
  const title = opts.label ? `@${shortTitle} · ${opts.label}` : `@${shortTitle} ${stemLabel}`;

  const operation: EditOperation = {
    type: 'borrow_stem',
    ref_id: ref.id,
    ref_stem: stem,
    ref_start: Number(refStart.toFixed(2)),
    ref_end: Number(refEnd.toFixed(2)),
    target_start: Number(clampedStart.toFixed(2)),
    target_end: Number(end.toFixed(2)),
    match_bpm: matchBpm,
    match_key: matchKey,
    gain_db: 0,
    ...(opts.replaceMainStems && opts.replaceMainStems.length > 0
      ? { replace_main_stems: opts.replaceMainStems }
      : {}),
    ...(opts.loopToFit !== undefined ? { loop_to_fit: opts.loopToFit } : {}),
  };

  return {
    shortTitle,
    stemLabel,
    payload: {
      title,
      description: `Layered ${opts.label ? `"${opts.label}" ` : ''}${stemLabel.toLowerCase()} from ${ref.title}${matchBpm ? ', BPM' : ''}${matchKey ? ' & key' : ''}${matchBpm || matchKey ? ' matched' : ''}.`,
      start: Number(clampedStart.toFixed(2)),
      end: Number(end.toFixed(2)),
      operations: [operation],
    },
  };
}

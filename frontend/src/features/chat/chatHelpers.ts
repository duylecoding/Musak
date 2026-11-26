import type { MainTrack, ReferenceTrack, TimeSelection } from '../../shared/api';
import { formatTime, formatTimeRange } from '../../shared/utils/format';

export function formatLanePrefix(lane?: TimeSelection['lane']): string {
  switch (lane) {
    case 'vocals':
      return 'Vocals · ';
    case 'drums':
      return 'Drums · ';
    case 'bass':
      return 'Bass · ';
    case 'other':
      return 'Melody · ';
    default:
      return '';
  }
}

export function buildSmartPrompts(
  mainTrack: MainTrack | null,
  selection: TimeSelection | null,
  attachedRefs: ReferenceTrack[],
  references: ReferenceTrack[]
): string[] {
  const prompts: string[] = [];
  const dropSection =
    mainTrack?.sections?.find((s) => /drop|chorus/i.test(s.label)) ||
    mainTrack?.sections?.reduce<NonNullable<MainTrack['sections']>[number] | null>(
      (best, cur) => (!best || cur.energy > best.energy ? cur : best),
      null
    );

  if (selection) {
    const laneWord =
      selection.lane && selection.lane !== 'all'
        ? `the ${selection.lane === 'other' ? 'melody' : selection.lane} in `
        : '';
    prompts.push(`Suggest 3 ways to make ${laneWord}${formatTimeRange(selection.start, selection.end)} hit harder`);
  } else if (dropSection) {
    prompts.push(`Punch up the ${formatTime(dropSection.start)} ${dropSection.label}`);
  } else {
    prompts.push('Suggest 3 ways to make this drop hit harder');
  }

  const focusRef = attachedRefs[0] ?? references[0] ?? null;
  if (focusRef) {
    const targetLabel = dropSection ? dropSection.label : 'this section';
    const shortTitle = focusRef.title.length > 26 ? `${focusRef.title.slice(0, 26)}…` : focusRef.title;
    prompts.push(`Blend @${shortTitle} drums into the ${targetLabel}`);
  } else {
    prompts.push('Give this section the vibe of my reference track');
  }

  const firstHook = mainTrack?.lyric_hooks?.[0] ?? null;
  prompts.push(
    firstHook
      ? `Echo the vocal hook at ${formatTime(firstHook.start)}`
      : 'Strip the drums for 4 bars then slam back in'
  );
  prompts.push('Make a Slowed + Reverb breakdown here');
  return prompts.slice(0, 4);
}

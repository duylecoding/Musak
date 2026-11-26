import React, { useEffect, useState } from 'react';
import { Check, Loader2, Play, RefreshCw, Shield, Sliders, Square } from 'lucide-react';
import type { EditProposal, ProposalTunePayload } from '../../shared/api';
import { formatTimeRange } from '../../shared/utils/format';
import { HelpTip } from '../../shared/components/Tooltip/Tooltip';
import styles from './ProposalCard.module.css';

export interface ProposalCardProps {
  proposal: EditProposal;
  isPlaying: boolean;
  isApplying: boolean;
  isTuning: boolean;
  anyTuning: boolean;
  sending: boolean;
  onTogglePreview: () => void;
  onApply: () => void;
  onTune: (payload: ProposalTunePayload) => Promise<boolean>;
  onTryAnother: () => void;
}

function getStyleBadge(style: EditProposal['style']): { label: string; className: string } {
  switch (style) {
    case 'imitate':
      return { label: 'Style Match', className: styles.badgeImitate };
    case 'mashup':
      return { label: 'Mashup', className: styles.badgeMashup };
    default:
      return { label: 'Creative', className: styles.badgeCreative };
  }
}

export const ProposalCard: React.FC<ProposalCardProps> = ({
  proposal,
  isPlaying,
  isApplying,
  isTuning,
  anyTuning,
  sending,
  onTogglePreview,
  onApply,
  onTune,
  onTryAnother,
}) => {
  const serverIntensity = proposal.intensity ?? 1.0;
  const [draftIntensity, setDraftIntensity] = useState<number>(serverIntensity);
  const badge = getStyleBadge(proposal.style);
  const hasPreview = Boolean(proposal.preview_url);
  const vocalsClear = Boolean(proposal.keep_vocals_clear);
  const shiftBeats = proposal.shift_beats ?? 0;
  const tuneDisabled = proposal.applied || anyTuning;

  useEffect(() => {
    setDraftIntensity(proposal.intensity ?? 1.0);
  }, [proposal.intensity, proposal.id]);

  const commitIntensity = async (rawValue: number) => {
    if (tuneDisabled) return;
    const clamped = Number(Math.max(0.25, Math.min(1.75, rawValue)).toFixed(2));
    if (Math.abs(clamped - serverIntensity) < 0.01) return;
    const ok = await onTune({ intensity: clamped });
    if (!ok) setDraftIntensity(serverIntensity);
  };

  const intensityLabel =
    draftIntensity <= 0.65 ? 'Subtle' : draftIntensity >= 1.35 ? 'Bold' : `${Math.round(draftIntensity * 100)}%`;

  return (
    <div className={proposal.applied ? `${styles.card} ${styles.cardApplied}` : styles.card}>
      <div className={styles.header}>
        <h4 className={styles.title}>{proposal.title}</h4>
        <span className={`${styles.badge} ${badge.className}`}>{badge.label}</span>
      </div>

      <p className={styles.summary}>{proposal.summary}</p>

      <div className={styles.tuningBox}>
        <div className={styles.sliderHeader}>
          <HelpTip
            title="Subtle ↔ Bold Intensity"
            content="Drag left for a gentler effect or right to crank it up — updates your audio preview instantly without waiting on AI."
          >
            <span className={styles.sliderLabel}>
              <Sliders className={styles.sliderIcon} />
              Subtle ↔ Bold
            </span>
          </HelpTip>
          <span className={styles.intensityReadout}>
            {isTuning ? (
              <span className={styles.tuningStatus}>
                <Loader2 className={`${styles.iconXs} ${styles.spin}`} />
                Updating preview...
              </span>
            ) : (
              intensityLabel
            )}
          </span>
        </div>

        <input
          type="range"
          min={0.25}
          max={1.75}
          step={0.15}
          value={draftIntensity}
          disabled={tuneDisabled}
          onChange={(e) => setDraftIntensity(Number(e.target.value))}
          onPointerUp={(e) => { void commitIntensity(Number(e.currentTarget.value)); }}
          onKeyUp={(e) => { void commitIntensity(Number(e.currentTarget.value)); }}
          aria-label="Effect intensity from Subtle to Bold"
          className={styles.slider}
        />

        <div className={styles.tweakRow}>
          <HelpTip content="Keeps the singer’s voice crisp and untouched while applying the remix effect to the instruments.">
            <button
              type="button"
              disabled={tuneDisabled}
              aria-pressed={vocalsClear}
              onClick={() => { void onTune({ keep_vocals_clear: !vocalsClear }); }}
              className={vocalsClear ? `${styles.tweakBtn} ${styles.tweakBtnVocalsActive}` : styles.tweakBtn}
            >
              <Shield className={styles.iconXs} />
              Keep Vocals Clear
            </button>
          </HelpTip>

          <HelpTip content={shiftBeats <= -16 ? 'Reached maximum early shift (-16 beats).' : 'Nudge this remix effect 2 beats earlier to tighten the timing.'}>
            <button
              type="button"
              disabled={tuneDisabled || shiftBeats <= -16}
              onClick={() => { void onTune({ shift_beats: Math.max(-16, shiftBeats - 2) }); }}
              className={`${styles.tweakBtn} ${styles.tweakBtnMono}`}
            >
              -2 Beats
            </button>
          </HelpTip>

          <HelpTip content={shiftBeats >= 16 ? 'Reached maximum late shift (+16 beats).' : 'Nudge this remix effect 2 beats later to line up better with the drop.'}>
            <button
              type="button"
              disabled={tuneDisabled || shiftBeats >= 16}
              onClick={() => { void onTune({ shift_beats: Math.min(16, shiftBeats + 2) }); }}
              className={`${styles.tweakBtn} ${styles.tweakBtnMono}`}
            >
              +2 Beats
            </button>
          </HelpTip>

          <HelpTip content="Ask Gemini for a fresh alternative idea for this same moment.">
            <button
              type="button"
              disabled={sending}
              onClick={onTryAnother}
              className={`${styles.tweakBtn} ${styles.tweakBtnTryAnother}`}
            >
              <RefreshCw className={styles.iconXs} />
              Try Another
            </button>
          </HelpTip>
        </div>
      </div>

      <div className={styles.footer}>
        <div className={styles.timeMeta}>
          <span className={styles.timeRange}>{formatTimeRange(proposal.start, proposal.end)}</span>
          {shiftBeats !== 0 && (
            <span className={styles.shiftBadge}>{shiftBeats > 0 ? `+${shiftBeats}b` : `${shiftBeats}b`}</span>
          )}
        </div>

        <div className={styles.actions}>
          {hasPreview && (
            <HelpTip content="Hear a quick before-you-commit audio clip of how this remix idea sounds.">
              <button
                type="button"
                disabled={isTuning}
                onClick={onTogglePreview}
                className={isPlaying ? `${styles.previewBtn} ${styles.previewBtnPlaying}` : styles.previewBtn}
              >
                {isPlaying ? (
                  <>
                    <Square className={`${styles.iconXs} ${styles.iconFill}`} />
                    Stop
                  </>
                ) : (
                  <>
                    <Play className={`${styles.iconXs} ${styles.iconFill}`} />
                    Preview
                  </>
                )}
              </button>
            </HelpTip>
          )}

          <HelpTip
            content={
              proposal.applied
                ? 'This edit is active on your remix. You can undo or toggle it off anytime.'
                : 'Add this remix idea to your main track (you can always Undo or switch Before/After).'
            }
          >
            <button
              type="button"
              disabled={proposal.applied || isApplying || isTuning}
              onClick={onApply}
              className={proposal.applied ? `${styles.applyBtn} ${styles.applyBtnApplied}` : styles.applyBtn}
            >
              {isApplying ? (
                <>
                  <Loader2 className={`${styles.iconSm} ${styles.spin}`} />
                  Applying...
                </>
              ) : proposal.applied ? (
                <>
                  <Check className={styles.iconSm} />
                  Applied
                </>
              ) : (
                'Apply to Track'
              )}
            </button>
          </HelpTip>
        </div>
      </div>
    </div>
  );
};

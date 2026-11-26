import React from 'react';
import { Loader2, Quote, Sparkles, X } from 'lucide-react';
import type { LyricHook } from '../../../shared/api';
import { Popover } from '../../../shared/components/Popover/Popover';
import { formatTime } from '../../../shared/utils/format';
import styles from './LyricsHooksPopover.module.css';

export interface LyricsHooksPopoverProps {
  open: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  hooks: LyricHook[];
  extracting: boolean;
  onClose: () => void;
  onExtractHooks: () => void;
  onSelectHook: (hook: LyricHook) => void;
}

export const LyricsHooksPopover: React.FC<LyricsHooksPopoverProps> = ({
  open,
  anchorRef,
  hooks,
  extracting,
  onClose,
  onExtractHooks,
  onSelectHook,
}) => {
  return (
    <Popover
      anchorRef={anchorRef}
      open={open}
      onClose={onClose}
      width={320}
      ariaLabel="Lyrics and Hooks"
    >
      <div className={styles.body}>
        <div className={styles.header}>
          <div>
            <div className={styles.title}>Lyrics &amp; Hooks</div>
            <div className={styles.subtitle}>Click any line to highlight &amp; jump there</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className={styles.closeBtn}>
            <X className={styles.iconSm} />
          </button>
        </div>

        <button
          type="button"
          disabled={extracting}
          onClick={onExtractHooks}
          className={styles.scanBtn}
        >
          {extracting ? (
            <>
              <Loader2 className={styles.iconSpin} />
              Scanning song with Gemini...
            </>
          ) : (
            <>
              <Sparkles className={styles.iconSm} />
              {hooks.length > 0 ? 'Refresh Hooks' : 'Find Lyrics & Hooks'}
            </>
          )}
        </button>

        {hooks.length === 0 ? (
          <p className={styles.emptyText}>
            No lyric hooks extracted yet. Click above to let Gemini pinpoint them!
          </p>
        ) : (
          <div className={styles.list}>
            {hooks.map((hook) => (
              <button
                key={hook.id}
                type="button"
                onClick={() => onSelectHook(hook)}
                className={styles.hookPill}
              >
                <div className={styles.hookLeft}>
                  <Quote className={styles.quoteIcon} />
                  <span className={styles.hookText}>“{hook.text}”</span>
                </div>
                <span className={styles.hookTime}>{formatTime(hook.start)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Popover>
  );
};

import React, { useRef, useState } from 'react';
import { ChevronDown, Loader2, Shuffle } from 'lucide-react';
import type { MashupMode } from '../../shared/api';
import { Popover } from '../../shared/components/Popover/Popover';
import { HelpTip } from '../../shared/components/Tooltip/Tooltip';
import styles from './LibraryCard.module.css';

const MASHUP_OPTIONS: ReadonlyArray<{
  mode: MashupMode;
  label: string;
  sublabel: string;
  tip: string;
}> = [
  {
    mode: 'ref_vocals_on_main',
    label: 'Ref Vocals + My Beat',
    sublabel: 'Sing their lyrics over your music',
    tip: "Puts this reference song's vocals on top of your main track's beat, automatically matched to your tempo and key.",
  },
  {
    mode: 'main_vocals_on_ref',
    label: 'My Vocals + Ref Beat',
    sublabel: 'Your vocals over their instrumental',
    tip: "Keeps your main track's vocals and swaps in this reference song's beat underneath.",
  },
  {
    mode: 'ref_drums_on_main',
    label: 'Borrow Ref Drums',
    sublabel: "Swap in this song's drum groove",
    tip: "Replaces your main track's drums with this reference track's drum pattern synced to your BPM.",
  },
  {
    mode: 'smart_auto',
    label: 'Smart Auto-Mashup',
    sublabel: 'Best automatic blend for both songs',
    tip: "Automatically picks the cleanest mashup blend based on both tracks' tempo, key, and energy.",
  },
];

export interface MashupMenuProps {
  hasMainTrack: boolean;
  mashingMode: MashupMode | null;
  onSelectMode: (mode: MashupMode) => void | Promise<void>;
}

export const MashupMenu: React.FC<MashupMenuProps> = ({
  hasMainTrack,
  mashingMode,
  onSelectMode,
}) => {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const handleSelect = (mode: MashupMode) => {
    setOpen(false);
    void onSelectMode(mode);
  };

  return (
    <>
      <HelpTip
        title="1-Click Auto-Mashup"
        content={
          hasMainTrack
            ? 'Instantly blend vocals, drums, or beats between this song and your main track — tempo and key matched automatically.'
            : 'Load a main song in the center stage first to create an instant mashup.'
        }
      >
        <button
          ref={triggerRef}
          type="button"
          disabled={!hasMainTrack || Boolean(mashingMode)}
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={() => setOpen((prev) => !prev)}
          className={`${styles.actionBtn} ${styles.actionBtnMashup}`}
        >
          {mashingMode ? (
            <>
              <Loader2 size={12} className={styles.spinner} />
              Mashing...
            </>
          ) : (
            <>
              <Shuffle size={12} />
              Mashup
              <ChevronDown size={12} />
            </>
          )}
        </button>
      </HelpTip>

      <Popover
        anchorRef={triggerRef}
        open={open && hasMainTrack}
        onClose={() => setOpen(false)}
        width={244}
        ariaLabel="1-Click Auto-Mashup"
      >
        <div className={styles.menuHeader}>1-Click Auto-Mashup</div>
        {MASHUP_OPTIONS.map((opt) => (
          <HelpTip key={opt.mode} side="right" title={opt.label} content={opt.tip}>
            <button
              type="button"
              onClick={() => handleSelect(opt.mode)}
              className={styles.menuItem}
            >
              <div className={styles.menuItemTitle}>{opt.label}</div>
              <div className={styles.menuItemSub}>{opt.sublabel}</div>
            </button>
          </HelpTip>
        ))}
      </Popover>
    </>
  );
};

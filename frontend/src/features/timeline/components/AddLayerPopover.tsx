import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Play, Square, X } from 'lucide-react';
import { getSfxPreviewUrl, type ReferenceTrack, type SfxItem } from '../../../shared/api';
import { Popover } from '../../../shared/components/Popover/Popover';
import { formatTime } from '../../../shared/utils/format';
import styles from './AddLayerPopover.module.css';

export interface AddLayerPopoverProps {
  open: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  dropTime: number;
  mainTrackBpm?: number;
  sfxItems: SfxItem[];
  downloadableRefs: ReferenceTrack[];
  busy: boolean;
  onClose: () => void;
  onDropSfx: (sfx: SfxItem) => Promise<void>;
  onDropReference: (ref: ReferenceTrack, stem: 'vocals' | 'drums' | 'bass' | 'other' | 'full') => Promise<void>;
}

export const AddLayerPopover: React.FC<AddLayerPopoverProps> = ({
  open, anchorRef, dropTime, mainTrackBpm, sfxItems, downloadableRefs, busy, onClose, onDropSfx, onDropReference,
}) => {
  const [auditionId, setAuditionId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const stopAudition = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute('src');
      audioRef.current.load();
      audioRef.current = null;
    }
    setAuditionId(null);
  }, []);

  useEffect(() => { if (!open) stopAudition(); }, [open, stopAudition]);
  useEffect(() => () => stopAudition(), [stopAudition]);

  const toggleAudition = (sfx: SfxItem) => {
    if (auditionId === sfx.id) { stopAudition(); return; }
    stopAudition();
    const audio = new Audio(getSfxPreviewUrl(sfx.id, mainTrackBpm, sfx.default_duration));
    audioRef.current = audio;
    setAuditionId(sfx.id);
    audio.onended = () => setAuditionId((cur) => (cur === sfx.id ? null : cur));
    audio.onerror = () => setAuditionId((cur) => (cur === sfx.id ? null : cur));
    audio.play().catch(() => setAuditionId(null));
  };

  return (
    <Popover anchorRef={anchorRef} open={open} onClose={() => { stopAudition(); onClose(); }} width={320} ariaLabel="Add Sound Layer">
      <div className={styles.body}>
        <div className={styles.header}>
          <div>
            <div className={styles.title}>Add Sound Layer</div>
            <div className={styles.subtitle}>Drops at <span className={styles.dropTime}>{formatTime(dropTime)}</span></div>
          </div>
          <button type="button" onClick={() => { stopAudition(); onClose(); }} aria-label="Close" className={styles.closeBtn}>
            <X className={styles.iconClose} />
          </button>
        </div>

        <div className={styles.section}>
          <div className={styles.kicker}>Transition SFX (BPM Synced)</div>
          {sfxItems.length === 0 ? (
            <div className={styles.emptyText}>Loading sound library...</div>
          ) : (
            <div className={styles.sfxList}>
              {sfxItems.map((sfx) => {
                const playing = auditionId === sfx.id;
                return (
                  <div key={sfx.id} className={styles.sfxRow}>
                    <button
                      type="button"
                      onClick={() => toggleAudition(sfx)}
                      title={playing ? 'Stop preview' : 'Preview sound'}
                      className={playing ? `${styles.previewBtn} ${styles.previewBtnActive}` : styles.previewBtn}
                    >
                      {playing ? <Square className={styles.iconStop} /> : <Play className={styles.iconPlay} />}
                    </button>
                    <div className={styles.sfxMeta}>
                      <div className={styles.sfxName}>{sfx.name}</div>
                      <div className={styles.sfxDesc}>{sfx.description}</div>
                    </div>
                    <button type="button" disabled={busy} onClick={() => { stopAudition(); void onDropSfx(sfx); }} className={styles.dropBtn}>
                      + Drop
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {downloadableRefs.length > 0 && (
          <div className={styles.refSection}>
            <div className={styles.kicker}>Reference Clips</div>
            <div className={styles.refList}>
              {downloadableRefs.map((ref) => (
                <div key={ref.id} className={styles.refCard}>
                  <div className={styles.refTitle}>{ref.title}</div>
                  <div className={styles.refButtons}>
                    <button type="button" disabled={busy} onClick={() => { stopAudition(); void onDropReference(ref, 'full'); }} className={styles.refBtn}>
                      + Full
                    </button>
                    {ref.stems_status === 'ready' &&
                      (['vocals', 'drums', 'bass', 'other'] as const).map((stem) => (
                        <button key={stem} type="button" disabled={busy} onClick={() => { stopAudition(); void onDropReference(ref, stem); }} className={styles.refStemBtn}>
                          + {stem}
                        </button>
                      ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Popover>
  );
};

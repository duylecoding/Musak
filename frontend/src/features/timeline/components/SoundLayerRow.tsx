import React from 'react';
import { Plus, Trash2, Volume2, VolumeX } from 'lucide-react';
import type { EditBlock } from '../../../shared/api';
import { HelpTip } from '../../../shared/components/Tooltip/Tooltip';
import type { ClipDragMode, ClipDragPreview } from '../hooks/useClipDrag';
import { ClipBlock } from './ClipBlock';
import styles from './SoundLayerRow.module.css';

export interface SoundLayerRowProps {
  edit: EditBlock;
  index: number;
  trackDuration: number;
  clipDragPreview: ClipDragPreview | null;
  laneRef: (el: HTMLDivElement | null) => void;
  onToggleEnabled: (edit: EditBlock) => void;
  onDelete: (editId: string) => void;
  onClipPointerDown: (edit: EditBlock, mode: ClipDragMode, e: React.PointerEvent<HTMLDivElement>) => void;
  onInspectClip: (edit: EditBlock, el: HTMLElement) => void;
}

export const SoundLayerRow: React.FC<SoundLayerRowProps> = React.memo(({
  edit, index, trackDuration, clipDragPreview, laneRef,
  onToggleEnabled, onDelete, onClipPointerDown, onInspectClip,
}) => {
  const isSfx = edit.operations.some((op) => op.type === 'add_sfx');

  return (
    <div className={styles.row}>
      <div className={styles.stickyHeader}>
        <div className={styles.meta}>
          <div className={styles.kicker}>Layer {index + 1}</div>
          <div className={styles.title} title={edit.title}>{edit.title}</div>
        </div>
        <div className={styles.actions}>
          <button
            type="button"
            onClick={() => onToggleEnabled(edit)}
            title={edit.enabled ? 'Mute layer' : 'Unmute layer'}
            className={edit.enabled ? styles.actionBtn : `${styles.actionBtn} ${styles.mutedBtn}`}
          >
            {edit.enabled ? <Volume2 className={styles.iconSm} /> : <VolumeX className={styles.iconSm} />}
          </button>
          <button
            type="button"
            onClick={() => onDelete(edit.id)}
            title="Delete layer"
            className={`${styles.actionBtn} ${styles.deleteBtn}`}
          >
            <Trash2 className={styles.iconSm} />
          </button>
        </div>
      </div>

      <div ref={laneRef} className={styles.layerTrack}>
        <ClipBlock
          edit={edit}
          tone={isSfx ? 'sfx' : 'reference'}
          trackDuration={trackDuration}
          previewRange={clipDragPreview?.editId === edit.id ? clipDragPreview : null}
          onClipPointerDown={onClipPointerDown}
          onInspect={onInspectClip}
        />
      </div>
    </div>
  );
});

export interface AddSoundLayerRowProps {
  buttonRef: React.RefObject<HTMLButtonElement>;
  onToggleOpen: () => void;
}

export const AddSoundLayerRow: React.FC<AddSoundLayerRowProps> = ({ buttonRef, onToggleOpen }) => (
  <div className={styles.addRow}>
    <div className={styles.stickyHeader}>
      <HelpTip content="Drop transition risers, impacts, snare rolls, or clips from your Reference tracks onto a new timeline layer.">
        <button ref={buttonRef} type="button" onClick={onToggleOpen} className={styles.addBtn}>
          <Plus className={styles.iconAdd} />
          Add Sound Layer
        </button>
      </HelpTip>
    </div>
    <div onClick={onToggleOpen} className={styles.addHintTrack}>
      Click <span className={styles.hintAccent}>+ Add Sound Layer</span> or pick from the
      <span className={styles.hintSky}>Sounds</span> library on the left to drop risers,
      impacts, or reference clips at the playhead.
    </div>
  </div>
);

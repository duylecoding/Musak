import React, { useState } from 'react';
import { AlertCircle, Link2, Loader2, Music, Music2, Sparkles, Upload, X, Youtube } from 'lucide-react';
import type { ReferenceTrack } from '../../../shared/api';
import styles from './EmptyTrackState.module.css';

export interface EmptyTrackStateProps {
  hasProject: boolean;
  references: ReferenceTrack[];
  anyMainBusy: boolean;
  loadingYoutube: boolean;
  uploading: boolean;
  promotingRefId: string | null;
  uploadError: string | null;
  onDismissError: () => void;
  onSubmitYoutube: (url: string) => Promise<void>;
  onPromoteReference: (refId: string) => Promise<void>;
  onFileSelected: (file: File | undefined) => void;
  onBrowseClick: () => void;
}

export const EmptyTrackState: React.FC<EmptyTrackStateProps> = ({
  hasProject, references, anyMainBusy, loadingYoutube, uploading, promotingRefId,
  uploadError, onDismissError, onSubmitYoutube, onPromoteReference, onFileSelected, onBrowseClick,
}) => {
  const [ytInput, setYtInput] = useState('');
  const [dragOver, setDragOver] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = ytInput.trim();
    if (!trimmed || !hasProject || anyMainBusy) return;
    await onSubmitYoutube(trimmed);
    setYtInput('');
  };

  return (
    <div className={styles.wrapper}>
      <div className={styles.stack}>
        <div className={styles.heroCard}>
          <div className={styles.heroTop}>
            <div className={styles.heroIconWrap}>
              {loadingYoutube ? <Loader2 className={styles.heroIconSpin} /> : <Youtube className={styles.heroIconYoutube} />}
            </div>
            <div>
              <h2 className={styles.heroTitle}>Load a song from YouTube to remix</h2>
              <p className={styles.heroSubtitle}>
                Paste any public YouTube link — Musak downloads the audio, auto-splits 4 instrument
                lanes (Vocals, Drums, Bass, Melody), and maps BPM, key, and song sections.
              </p>
            </div>
          </div>

          <form onSubmit={handleSubmit} className={styles.ytForm}>
            <div className={styles.inputWrap}>
              <Link2 className={styles.inputIcon} />
              <input
                type="text"
                value={ytInput}
                onChange={(e) => setYtInput(e.target.value)}
                disabled={!hasProject || anyMainBusy}
                placeholder="Paste a YouTube URL to remix..."
                className={styles.ytInput}
              />
            </div>
            <button type="submit" disabled={!hasProject || !ytInput.trim() || anyMainBusy} className={styles.submitBtn}>
              {loadingYoutube ? (
                <><Loader2 className={styles.btnIconSpin} />Downloading &amp; analyzing...</>
              ) : (
                <><Sparkles className={styles.btnIcon} />Load Song</>
              )}
            </button>
          </form>

          {hasProject && references.length > 0 && (
            <div className={styles.refSection}>
              <div className={styles.refLabel}>Or pick from your Reference Shelf</div>
              <div className={styles.refList}>
                {references.map((ref) => (
                  <button
                    key={ref.id}
                    type="button"
                    disabled={anyMainBusy}
                    onClick={() => void onPromoteReference(ref.id)}
                    className={styles.refPill}
                  >
                    {promotingRefId === ref.id ? (
                      <Loader2 className={styles.refIconSpin} />
                    ) : ref.source_type === 'youtube' ? (
                      <Youtube className={styles.refIconYt} />
                    ) : (
                      <Music className={styles.refIconFile} />
                    )}
                    <span className={styles.refTitle}>{ref.title}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {uploadError && (
            <div className={styles.errorBanner}>
              <div className={styles.errorContent}>
                <AlertCircle className={styles.smallIcon} />
                <span>{uploadError}</span>
              </div>
              <button type="button" onClick={onDismissError} className={styles.errorClose}>
                <X className={styles.smallIcon} />
              </button>
            </div>
          )}
        </div>

        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); onFileSelected(e.dataTransfer.files?.[0]); }}
          onClick={() => !anyMainBusy && hasProject && onBrowseClick()}
          className={dragOver ? `${styles.dropzone} ${styles.dropzoneActive}` : styles.dropzone}
        >
          <div className={styles.dropLeft}>
            <div className={styles.dropIconBox}>
              {uploading ? <Loader2 className={styles.dropIconSpin} /> : <Upload className={styles.dropIcon} />}
            </div>
            <div>
              <div className={styles.dropTitle}>
                {uploading ? 'Analyzing local audio...' : 'Or drop / browse a local MP3, WAV, FLAC, M4A'}
              </div>
              <div className={styles.dropDesc}>
                {uploading
                  ? 'Detecting BPM, musical key, beat grid, and song sections.'
                  : 'Drag an audio file anywhere here or click to choose from your PC.'}
              </div>
            </div>
          </div>
          {!uploading && (
            <span className={styles.browseChip}>
              <Music2 className={styles.browseIcon} />
              Browse File
            </span>
          )}
        </div>
      </div>
    </div>
  );
};

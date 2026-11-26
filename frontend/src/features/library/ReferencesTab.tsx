import React, { useRef, useState } from 'react';
import { Link2, Loader2, Music, Upload } from 'lucide-react';
import { HelpTip } from '../../shared/components/Tooltip/Tooltip';
import { useProject } from '../../state/ProjectContext';
import styles from './LibraryPanel.module.css';
import { ReferenceCard } from './ReferenceCard';

export interface ReferencesTabProps {
  onOpenSettings: () => void;
}

export const ReferencesTab: React.FC<ReferencesTabProps> = ({ onOpenSettings }) => {
  const { currentProject, addYouTubeReference, uploadReference } = useProject();
  const [ytUrl, setYtUrl] = useState('');
  const [addingYt, setAddingYt] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [tabError, setTabError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const projectId = currentProject?.id ?? null;
  const references = currentProject?.references ?? [];

  const handleYouTubeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = ytUrl.trim();
    if (!trimmed || !projectId || addingYt) return;

    setTabError(null);
    setAddingYt(true);
    try {
      await addYouTubeReference(trimmed);
      setYtUrl('');
    } catch (err) {
      setTabError(err instanceof Error ? err.message : 'Could not add YouTube link.');
    } finally {
      setAddingYt(false);
    }
  };

  const handleUploadFile = async (file: File | undefined) => {
    if (!file || !projectId || uploadingFile) return;
    setTabError(null);
    setUploadingFile(true);
    try {
      await uploadReference(file);
    } catch (err) {
      setTabError(err instanceof Error ? err.message : 'Could not upload reference audio.');
    } finally {
      setUploadingFile(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    void handleUploadFile(file);
  };

  const handleDrop = (e: React.DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    void handleUploadFile(file);
  };

  return (
    <div className={styles.tabContainer}>
      <div className={styles.refControls}>
        <form onSubmit={handleYouTubeSubmit} className={styles.ytForm}>
          <div className={styles.ytInputWrap}>
            <Link2 className={styles.ytInputIcon} />
            <input
              type="text"
              value={ytUrl}
              onChange={(e) => setYtUrl(e.target.value)}
              disabled={!projectId || addingYt}
              placeholder="Paste YouTube URL..."
              className={styles.ytInput}
            />
          </div>
          <HelpTip content="Add a YouTube song to your inspiration shelf so you can listen, mash it up, or copy its vibe.">
            <button
              type="submit"
              disabled={!projectId || !ytUrl.trim() || addingYt}
              className={styles.ytSubmitBtn}
            >
              {addingYt ? <Loader2 size={14} className={styles.spinner} /> : 'Add'}
            </button>
          </HelpTip>
        </form>

        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*,.mp3,.wav,.flac,.m4a,.ogg"
          onChange={handleFileChange}
          className={styles.uploadInput}
        />

        <HelpTip content="Add a song file from your computer to compare BPM/Key, borrow drums or vocals, or use as your main track.">
          <button
            type="button"
            disabled={!projectId || uploadingFile}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            className={`${styles.uploadDropzone} ${
              isDragging ? styles.uploadDropzoneDragging : ''
            }`}
          >
            {uploadingFile ? (
              <>
                <Loader2 size={14} className={styles.spinner} />
                Analyzing audio...
              </>
            ) : (
              <>
                <Upload size={14} />
                Upload or Drop Local Audio
              </>
            )}
          </button>
        </HelpTip>

        {tabError && <div className={styles.errorBanner}>{tabError}</div>}
      </div>

      <div className={styles.scrollBody}>
        {references.length === 0 ? (
          <div className={styles.emptyState}>
            <div className={styles.emptyIconWrap}>
              <Music size={20} />
            </div>
            <p className={styles.emptyTitle}>No inspiration tracks yet</p>
            <p className={styles.emptySubtitle}>
              Paste a YouTube link or drop a local song to check mashup match scores, create 1-click
              mashups, or drop clips onto a Sound Layer.
            </p>
          </div>
        ) : (
          references.map((ref) => (
            <ReferenceCard key={ref.id} reference={ref} onOpenSettings={onOpenSettings} />
          ))
        )}
      </div>
    </div>
  );
};

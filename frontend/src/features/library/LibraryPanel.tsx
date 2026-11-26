import React, { useState } from 'react';
import { Disc3, Music, Zap } from 'lucide-react';
import { useProject } from '../../state/ProjectContext';
import styles from './LibraryPanel.module.css';
import { ReferencesTab } from './ReferencesTab';
import { SoundsTab } from './SoundsTab';

export interface LibraryPanelProps {
  onOpenSettings: () => void;
}

export const LibraryPanel: React.FC<LibraryPanelProps> = ({ onOpenSettings }) => {
  const { sfxItems, currentProject } = useProject();
  const [activeTab, setActiveTab] = useState<'sounds' | 'references'>('sounds');

  const referenceCount = currentProject?.references.length ?? 0;

  return (
    <aside className={styles.panel} aria-label="Sound and Reference Library">
      <div className={styles.header}>
        <div>
          <h2 className={styles.headerTitle}>
            <Disc3 className={styles.headerIcon} />
            Sound &amp; Reference Library
          </h2>
          <p className={styles.headerSubtitle}>
            {activeTab === 'sounds'
              ? 'Drop beat-synced risers, impacts & rolls'
              : 'Drop songs for vibe matching & mashups'}
          </p>
        </div>

        <div className={styles.tabBar} role="tablist" aria-label="Library sections">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'sounds'}
            onClick={() => setActiveTab('sounds')}
            className={`${styles.tabButton} ${
              activeTab === 'sounds' ? styles.tabButtonActive : ''
            }`}
          >
            <Zap size={14} />
            Sounds
            {sfxItems.length > 0 && (
              <span
                className={`${styles.tabCount} ${
                  activeTab === 'sounds' ? styles.tabCountActive : ''
                }`}
              >
                {sfxItems.length}
              </span>
            )}
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'references'}
            onClick={() => setActiveTab('references')}
            className={`${styles.tabButton} ${
              activeTab === 'references' ? styles.tabButtonActive : ''
            }`}
          >
            <Music size={14} />
            References
            <span
              className={`${styles.tabCount} ${
                activeTab === 'references' ? styles.tabCountActive : ''
              }`}
            >
              {referenceCount}
            </span>
          </button>
        </div>
      </div>

      {activeTab === 'sounds' ? (
        <SoundsTab />
      ) : (
        <ReferencesTab onOpenSettings={onOpenSettings} />
      )}
    </aside>
  );
};

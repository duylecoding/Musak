import React, { useRef, useState } from 'react';
import { ChevronDown, Download, FolderArchive, Loader2, Mic2, Music } from 'lucide-react';
import type { ExportOptions, MasterPreset } from '../../shared/api';
import { useProject } from '../../state/ProjectContext';
import { Popover } from '../../shared/components/Popover/Popover';
import { HelpTip } from '../../shared/components/Tooltip/Tooltip';
import styles from './TopBar.module.css';

const MASTER_PRESETS: { id: MasterPreset; label: string; tip: string }[] = [
  { id: 'off', label: 'Off', tip: 'Export your remix exactly as-is with no extra loudness or tone shaping.' },
  { id: 'balanced', label: 'Balanced', tip: 'Smooths volume levels and adds clean streaming-ready loudness for headphones or speakers.' },
  { id: 'club', label: 'Club', tip: 'Punches up the bass and crisp highs with loud festival-ready energy.' },
  { id: 'warm', label: 'Warm', tip: 'Adds gentle analog warmth and softens sharp highs for a cozy, mellow finish.' },
];

const REMIX_TARGETS: { label: string; sub: string; tip: string; opts: Omit<ExportOptions, 'master_preset'> }[] = [
  { label: 'Remix WAV', sub: 'Studio-quality lossless master', tip: 'Lossless uncompressed WAV file — best quality for editing or uploading.', opts: { target: 'remix', format: 'wav' } },
  { label: 'Remix MP3', sub: 'Lightweight for sharing', tip: 'Compact MP3 file — fast to send to friends, TikTok, or your phone.', opts: { target: 'remix', format: 'mp3' } },
];

const STEM_TARGETS: {
  label: string;
  sub: string;
  tip: string;
  icon: React.ReactNode;
  opts: Omit<ExportOptions, 'master_preset'>;
}[] = [
  { label: 'Instrumental WAV', sub: 'Beat & music without vocals', tip: 'Export the full beat and instruments with vocals removed (karaoke version).', icon: <Music size={14} className={styles.iconEmerald} />, opts: { target: 'instrumental', format: 'wav' } },
  { label: 'Acapella WAV', sub: 'Isolated vocal track', tip: 'Export just the isolated singing/rap vocals with no backing music.', icon: <Mic2 size={14} className={styles.iconVocals} />, opts: { target: 'vocals', format: 'wav' } },
  { label: 'All 4 Stems (.zip)', sub: 'Vocals, Drums, Bass & Other', tip: 'Download a ZIP bundle containing all 4 separate WAV tracks (Vocals, Drums, Bass, Other).', icon: <FolderArchive size={14} className={styles.iconAmber} />, opts: { target: 'stems_zip', format: 'zip' } },
];

export const ExportMenu: React.FC = () => {
  const { currentProject, exportingLabel, exportAudio } = useProject();
  const [menuOpen, setMenuOpen] = useState(false);
  const [masterPreset, setMasterPreset] = useState<MasterPreset>('balanced');
  const anchorRef = useRef<HTMLButtonElement>(null);

  const hasMainTrack = Boolean(currentProject?.main_track);
  const stemsReady = currentProject?.main_track?.stems_status === 'ready';

  const triggerExport = (opts: Omit<ExportOptions, 'master_preset'>) => {
    setMenuOpen(false);
    void exportAudio({ ...opts, master_preset: masterPreset });
  };

  return (
    <>
      <HelpTip
        side="bottom"
        title="Export Audio"
        content="Download your finished remix, instrumental, acapella, or all 4 stems with optional mastering polish."
      >
        <button
          ref={anchorRef}
          type="button"
          disabled={!hasMainTrack || Boolean(exportingLabel)}
          onClick={() => setMenuOpen((v) => !v)}
          className={styles.exportTrigger}
        >
          {exportingLabel ? (
            <>
              <Loader2 size={14} className={styles.spin} />
              <span>{exportingLabel}</span>
            </>
          ) : (
            <>
              <Download size={14} />
              <span>Export</span>
              <ChevronDown size={12} />
            </>
          )}
        </button>
      </HelpTip>

      <Popover anchorRef={anchorRef} open={menuOpen && hasMainTrack} onClose={() => setMenuOpen(false)} width={288} align="end" ariaLabel="Export audio menu" className={styles.popoverBody}>
        <div className={styles.exportSection}>
          <div className={styles.exportHeaderRow}>
            <span className={styles.exportLabel}>Master Polish</span>
            <span className={styles.exportValue}>{masterPreset}</span>
          </div>
          <div className={styles.presetGrid}>
            {MASTER_PRESETS.map((preset) => {
              const active = masterPreset === preset.id;
              return (
                <HelpTip key={preset.id} side="bottom" title={`Master: ${preset.label}`} content={preset.tip}>
                  <button
                    type="button"
                    aria-pressed={active}
                    onClick={() => setMasterPreset(preset.id)}
                    className={`${styles.presetBtn} ${active ? styles.presetBtnActive : ''}`}
                  >
                    {preset.label}
                  </button>
                </HelpTip>
              );
            })}
          </div>
        </div>

        <div className={styles.exportSection}>
          <div className={styles.exportHeaderRow}>
            <span className={styles.exportLabel}>Full Remix</span>
          </div>
          {REMIX_TARGETS.map((item) => (
            <HelpTip key={item.label} side="left" content={item.tip}>
              <button type="button" onClick={() => triggerExport(item.opts)} className={styles.exportItem}>
                <div>
                  <div className={styles.exportItemTitle}>{item.label}</div>
                  <div className={styles.exportItemSub}>{item.sub}</div>
                </div>
                <Download size={14} />
              </button>
            </HelpTip>
          ))}
        </div>

        <div className={styles.exportSection}>
          <div className={styles.exportHeaderRow}>
            <span className={styles.exportLabel}>Stem Exports</span>
            {!stemsReady && <span className={styles.exportItemSub}>Split stems first</span>}
          </div>
          {STEM_TARGETS.map((item) => (
            <HelpTip key={item.label} side="left" content={item.tip}>
              <button type="button" disabled={!stemsReady} onClick={() => triggerExport(item.opts)} className={styles.exportItem}>
                <div className={styles.exportItemLeft}>
                  {item.icon}
                  <div>
                    <div className={styles.exportItemTitle}>{item.label}</div>
                    <div className={styles.exportItemSub}>{item.sub}</div>
                  </div>
                </div>
                <Download size={14} />
              </button>
            </HelpTip>
          ))}
        </div>
      </Popover>
    </>
  );
};

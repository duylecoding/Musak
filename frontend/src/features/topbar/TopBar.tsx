import React from 'react';
import {
  AudioWaveform,
  Cpu,
  HelpCircle,
  KeyRound,
  Redo2,
  Settings,
  Sparkles,
  Undo2,
  WifiOff,
} from 'lucide-react';
import { useProject } from '../../state/ProjectContext';
import { HelpTip, useTooltips } from '../../shared/components/Tooltip/Tooltip';
import { ProjectSwitcher } from './ProjectSwitcher';
import { ExportMenu } from './ExportMenu';
import styles from './TopBar.module.css';

export interface TopBarProps {
  onOpenSettings: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({ onOpenSettings }) => {
  const { health, backendOnline, currentProject, historyBusy, undo, redo } = useProject();
  const { tipsEnabled, toggleTips } = useTooltips();

  const canUndo = Boolean(currentProject && currentProject.edits.length > 0 && !historyBusy);
  const canRedo = Boolean(currentProject && currentProject.redo_stack.length > 0 && !historyBusy);
  const gpuShortName = health?.cuda_available
    ? (health.gpu_name || 'CUDA GPU').replace(/^NVIDIA\s+GeForce\s+/i, '')
    : 'CPU';

  return (
    <header className={styles.topBar}>
      <div className={styles.leftGroup}>
        <div className={styles.brand}>
          <div className={styles.brandBadge}><AudioWaveform size={16} /></div>
          <div className={styles.brandText}>
            <span className={styles.brandTitle}>Musak</span>
            <span className={styles.brandSub}>Producer Studio</span>
          </div>
        </div>
        <div className={styles.divider} />
        <ProjectSwitcher />
      </div>

      <div className={styles.statusGroup}>
        {!backendOnline ? (
          <HelpTip side="bottom" content="The local audio engine is starting up or offline. Click to check Studio Diagnostics.">
            <button type="button" onClick={onOpenSettings} className={`${styles.statusPill} ${styles.pillRose}`}>
              <WifiOff size={12} />
              <span>Backend Offline</span>
            </button>
          </HelpTip>
        ) : (
          <>
            <HelpTip
              side="bottom"
              title="Local Audio Engine"
              content={
                health?.cuda_available
                  ? `Running on your ${health.gpu_name || 'GPU'} for fast local stem separation and audio rendering.`
                  : 'Running in CPU mode. Stem separation still works, just a little slower.'
              }
            >
              <button type="button" onClick={onOpenSettings} className={`${styles.statusPill} ${health?.cuda_available ? styles.pillEmerald : ''}`}>
                <Cpu size={12} />
                <span>{gpuShortName}</span>
                {health?.cuda_available && <span>CUDA</span>}
              </button>
            </HelpTip>

            <HelpTip
              side="bottom"
              title="Gemini AI Producer"
              content={
                health?.api_key_configured
                  ? 'Your Gemini API key is connected and ready for AI remixes, lyric hooks, and voice commands.'
                  : 'Click to paste your Google AI Studio key so Gemini can suggest remixes and understand voice commands.'
              }
            >
              <button
                type="button"
                onClick={onOpenSettings}
                className={`${styles.statusPill} ${health?.api_key_configured ? styles.pillViolet : styles.pillAmber}`}
              >
                {health?.api_key_configured ? (
                  <>
                    <Sparkles size={12} />
                    <span>Gemini Ready</span>
                  </>
                ) : (
                  <>
                    <KeyRound size={12} />
                    <span>Set Gemini Key</span>
                  </>
                )}
              </button>
            </HelpTip>
          </>
        )}
      </div>

      <div className={styles.rightGroup}>
        <HelpTip side="bottom" title="Beginner Hover Tips" content="Show or hide plain-English explanations when you hover over any button or slider in Musak.">
          <button type="button" aria-pressed={tipsEnabled} onClick={toggleTips} className={`${styles.tipsBtn} ${tipsEnabled ? styles.tipsBtnActive : ''}`}>
            <HelpCircle size={14} />
            <span>Tips</span>
          </button>
        </HelpTip>

        <div className={styles.historyGroup}>
          <HelpTip side="bottom" content="Step back and remove the last remix change you applied.">
            <button type="button" onClick={() => void undo()} disabled={!canUndo} aria-label="Undo" className={styles.historyBtn}>
              <Undo2 size={14} />
              <span>Undo</span>
            </button>
          </HelpTip>
          <div className={styles.historyDivider} />
          <HelpTip side="bottom" content="Bring back a remix change you just undid.">
            <button type="button" onClick={() => void redo()} disabled={!canRedo} aria-label="Redo" className={styles.historyBtn}>
              <Redo2 size={14} />
              <span>Redo</span>
            </button>
          </HelpTip>
        </div>

        <ExportMenu />

        <HelpTip side="bottom" content="Manage your Gemini API key and check GPU & backend health.">
          <button type="button" onClick={onOpenSettings} aria-label="Studio Settings & API Key" className={styles.settingsBtn}>
            <Settings size={16} />
            {backendOnline && !health?.api_key_configured && <span className={styles.alertDot} />}
          </button>
        </HelpTip>
      </div>
    </header>
  );
};

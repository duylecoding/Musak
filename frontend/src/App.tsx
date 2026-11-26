import React, { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, X } from 'lucide-react';
import { ProducerChat } from './features/chat';
import { LibraryPanel } from './features/library';
import { SettingsModal } from './features/settings';
import { TimelineWorkspace } from './features/timeline';
import { TopBar } from './features/topbar';
import { TooltipProvider } from './shared/components/Tooltip';
import { ProjectProvider, useProject } from './state/ProjectContext';
import styles from './App.module.css';

const CHAT_PANEL_KEY = 'musak_chat_panel_open';

function readChatPanelPref(): boolean {
  try {
    return window.localStorage?.getItem(CHAT_PANEL_KEY) !== 'false';
  } catch {
    return true;
  }
}

const StudioShell: React.FC = () => {
  const { initializing, toast, dismissToast, focusChatNonce } = useProject();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chatPanelOpen, setChatPanelOpen] = useState<boolean>(readChatPanelPref);

  const toggleChatPanel = () => {
    setChatPanelOpen((prev) => {
      const next = !prev;
      try { window.localStorage?.setItem(CHAT_PANEL_KEY, String(next)); } catch { /* ignore */ }
      return next;
    });
  };

  const hideChatPanel = () => {
    setChatPanelOpen(false);
    try { window.localStorage?.setItem(CHAT_PANEL_KEY, 'false'); } catch { /* ignore */ }
  };

  useEffect(() => {
    if (focusChatNonce > 0) {
      setChatPanelOpen(true);
      try { window.localStorage?.setItem(CHAT_PANEL_KEY, 'true'); } catch { /* ignore */ }
    }
  }, [focusChatNonce]);

  return (
    <div className={styles.shell}>
      <TopBar
        onOpenSettings={() => setSettingsOpen(true)}
        chatPanelOpen={chatPanelOpen}
        onToggleChatPanel={toggleChatPanel}
      />

      {initializing ? (
        <div className={styles.loadingScreen}>
          <Loader2 className={styles.spinner} />
          <p className={styles.loadingTitle}>Starting Musak Producer Studio...</p>
          <p className={styles.loadingSubtitle}>Connecting to local audio engine</p>
        </div>
      ) : (
        <div className={styles.workspace}>
          <LibraryPanel onOpenSettings={() => setSettingsOpen(true)} />
          <TimelineWorkspace onOpenSettings={() => setSettingsOpen(true)} />
          {chatPanelOpen && (
            <ProducerChat
              onOpenSettings={() => setSettingsOpen(true)}
              onClose={hideChatPanel}
            />
          )}
        </div>
      )}

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {toast && (
        <div
          role="status"
          className={`${styles.toast} ${
            toast.type === 'error' ? styles.toastError : styles.toastSuccess
          }`}
        >
          {toast.type === 'error' ? <AlertCircle size={15} /> : <CheckCircle2 size={15} />}
          <span>{toast.message}</span>
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={dismissToast}
            className={styles.toastDismiss}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
};

export const App: React.FC = () => (
  <TooltipProvider>
    <ProjectProvider>
      <StudioShell />
    </ProjectProvider>
  </TooltipProvider>
);

export default App;

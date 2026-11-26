import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectState, ProjectSummary } from '../../shared/api';
import type { ProjectContextValue } from '../../state/ProjectContext';
import { TooltipProvider } from '../../shared/components/Tooltip/Tooltip';
import { TopBar } from './TopBar';

function ensureMockLocalStorage() {
  const store = new Map<string, string>();
  const mockStorage: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(window, 'localStorage', {
    value: mockStorage,
    configurable: true,
    writable: true,
  });
}

const mockUseProject = vi.fn<() => ProjectContextValue>();

vi.mock('../../state/ProjectContext', () => ({
  useProject: () => mockUseProject(),
}));

function makeProject(stemsStatus: 'none' | 'ready' = 'none'): ProjectState {
  return {
    id: 'proj-1',
    name: 'Midnight Remix',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    render_version: 1,
    main_track: {
      id: 'track-1',
      name: 'demo.mp3',
      duration: 120,
      sample_rate: 44100,
      bpm: 120,
      key: 'C min',
      beats: [],
      sections: [],
      lyric_hooks: [],
      stems_status: stemsStatus,
      stems_error: null,
      stems: stemsStatus === 'ready' ? ['vocals', 'drums', 'bass', 'other'] : [],
      audio_url: '/audio.wav',
      rendered_url: '/rendered.wav',
      stem_urls: {},
    },
    references: [],
    edits: [],
    redo_stack: [],
    chat_messages: [],
  };
}

function makeContext(overrides: Partial<ProjectContextValue> = {}): ProjectContextValue {
  const summaries: ProjectSummary[] = [
    {
      id: 'proj-1',
      name: 'Midnight Remix',
      updated_at: '2026-01-01T00:00:00Z',
      has_main_track: true,
      reference_count: 1,
      edit_count: 0,
    },
  ];
  return {
    health: {
      status: 'ok',
      cuda_available: true,
      gpu_name: 'NVIDIA GeForce RTX 4070',
      ffmpeg_available: true,
      api_key_configured: true,
      model: 'gemini-2.5-flash',
      stem_device: 'auto',
    },
    backendOnline: true,
    initializing: false,
    projects: summaries,
    currentProject: makeProject('none'),
    sfxItems: [],
    abMode: 'remix',
    setAbMode: vi.fn(),
    selection: null,
    setSelection: vi.fn(),
    attachedRefIds: [],
    toggleAttachRef: vi.fn(),
    attachRef: vi.fn(),
    draftSnippet: null,
    setDraftSnippet: vi.fn(),
    focusChatNonce: 0,
    requestFocusChat: vi.fn(),
    playheadRef: { current: 0 },
    mainTrackBusy: false,
    historyBusy: false,
    exportingLabel: null,
    toast: null,
    showToast: vi.fn(),
    dismissToast: vi.fn(),
    refreshHealth: vi.fn().mockResolvedValue(null),
    selectProject: vi.fn().mockResolvedValue(undefined),
    createProject: vi.fn().mockResolvedValue(undefined),
    renameProject: vi.fn().mockResolvedValue(undefined),
    deleteProject: vi.fn().mockResolvedValue(undefined),
    uploadMainTrack: vi.fn().mockResolvedValue(undefined),
    loadMainFromYoutube: vi.fn().mockResolvedValue(undefined),
    loadMainFromReference: vi.fn().mockResolvedValue(undefined),
    separateMainStems: vi.fn().mockResolvedValue(undefined),
    extractHooks: vi.fn().mockResolvedValue(undefined),
    updateMainTrackMeta: vi.fn().mockResolvedValue(undefined),
    addCue: vi.fn().mockResolvedValue(undefined),
    updateCue: vi.fn().mockResolvedValue(undefined),
    deleteCue: vi.fn().mockResolvedValue(undefined),
    addYouTubeReference: vi.fn().mockResolvedValue(undefined),
    uploadReference: vi.fn().mockResolvedValue(undefined),
    deleteReference: vi.fn().mockResolvedValue(undefined),
    addMoment: vi.fn().mockResolvedValue(undefined),
    deleteMoment: vi.fn().mockResolvedValue(undefined),
    autoTagReference: vi.fn().mockResolvedValue(undefined),
    extractReferenceStems: vi.fn().mockResolvedValue(undefined),
    createAutoMashup: vi.fn().mockResolvedValue(undefined),
    sendMomentToChat: vi.fn(),
    createEdit: vi.fn().mockResolvedValue(undefined),
    updateEdit: vi.fn().mockResolvedValue(undefined),
    duplicateEdit: vi.fn().mockResolvedValue(undefined),
    deleteEdit: vi.fn().mockResolvedValue(undefined),
    addSfxLayer: vi.fn().mockResolvedValue(undefined),
    addReferenceLayer: vi.fn().mockResolvedValue(undefined),
    undo: vi.fn().mockResolvedValue(undefined),
    redo: vi.fn().mockResolvedValue(undefined),
    exportAudio: vi.fn().mockResolvedValue(undefined),
    sendChat: vi.fn().mockResolvedValue(undefined),
    tuneProposal: vi.fn().mockResolvedValue(undefined),
    applyProposal: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('TopBar', () => {
  beforeEach(() => {
    ensureMockLocalStorage();
    vi.clearAllMocks();
  });

  it('commits trimmed inline project rename with explicit projectId and cancels on Escape', async () => {
    const renameProject = vi.fn().mockResolvedValue(undefined);
    mockUseProject.mockReturnValue(makeContext({ renameProject }));

    render(
      <TooltipProvider>
        <TopBar onOpenSettings={vi.fn()} />
      </TooltipProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Rename remix project' }));
    const input = screen.getByRole('textbox', { name: 'Rename project' });
    fireEvent.change(input, { target: { value: '  Sunset Club Mix  ' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => {
      expect(renameProject).toHaveBeenCalledWith('proj-1', 'Sunset Club Mix');
    });

    // Double-click title and cancel with Escape
    fireEvent.doubleClick(screen.getByRole('button', { name: /Midnight Remix/i }));
    const escInput = screen.getByRole('textbox', { name: 'Rename project' });
    fireEvent.change(escInput, { target: { value: 'Discarded Name' } });
    fireEvent.keyDown(escInput, { key: 'Escape' });

    expect(screen.queryByRole('textbox', { name: 'Rename project' })).not.toBeInTheDocument();
    expect(renameProject).toHaveBeenCalledTimes(1);
  });

  it('toggles tipsEnabled when clicking the Tips button', () => {
    mockUseProject.mockReturnValue(makeContext());

    render(
      <TooltipProvider>
        <TopBar onOpenSettings={vi.fn()} />
      </TooltipProvider>
    );

    const tipsBtn = screen.getByRole('button', { name: /Tips/i });
    expect(tipsBtn).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(tipsBtn);
    expect(tipsBtn).toHaveAttribute('aria-pressed', 'false');
    expect(window.localStorage.getItem('musak_tips_enabled')).toBe('false');
  });

  it('renders Master Polish presets and disables stem exports until stems are ready', async () => {
    const exportAudio = vi.fn().mockResolvedValue(undefined);
    const ctxNone = makeContext({ currentProject: makeProject('none'), exportAudio });
    mockUseProject.mockReturnValue(ctxNone);

    const { rerender } = render(
      <TooltipProvider>
        <TopBar onOpenSettings={vi.fn()} />
      </TooltipProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: /Export/i }));

    for (const preset of ['Off', 'Balanced', 'Club', 'Warm']) {
      expect(screen.getByRole('button', { name: preset })).toBeInTheDocument();
    }

    expect(screen.getByRole('button', { name: /Instrumental WAV/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Acapella WAV/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /All 4 Stems/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Remix WAV/i })).toBeEnabled();

    // Switch preset to Club and verify stems unlock when stems_status === 'ready'
    fireEvent.click(screen.getByRole('button', { name: 'Club' }));
    mockUseProject.mockReturnValue(makeContext({ currentProject: makeProject('ready'), exportAudio }));
    rerender(
      <TooltipProvider>
        <TopBar onOpenSettings={vi.fn()} />
      </TooltipProvider>
    );

    const instBtn = screen.getByRole('button', { name: /Instrumental WAV/i });
    expect(instBtn).toBeEnabled();
    fireEvent.click(instBtn);

    await waitFor(() => {
      expect(exportAudio).toHaveBeenCalledWith({
        target: 'instrumental',
        format: 'wav',
        master_preset: 'club',
      });
    });
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectContextValue } from '../../state/ProjectContext';
import { TooltipProvider } from '../../shared/components/Tooltip/Tooltip';
import { SettingsModal } from './SettingsModal';

const mockUseProject = vi.fn<() => ProjectContextValue>();
const mockSetBackendApiKey = vi.fn();
const mockClearBackendApiKey = vi.fn();
const mockSetStemDevice = vi.fn();

vi.mock('../../state/ProjectContext', () => ({
  useProject: () => mockUseProject(),
}));

vi.mock('../../shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/api')>();
  return {
    ...actual,
    setBackendApiKey: (...args: unknown[]) => mockSetBackendApiKey(...args),
    clearBackendApiKey: (...args: unknown[]) => mockClearBackendApiKey(...args),
    setStemDevice: (...args: unknown[]) => mockSetStemDevice(...args),
  };
});

function makeContext(overrides: Partial<ProjectContextValue> = {}): ProjectContextValue {
  return {
    health: {
      status: 'ok',
      cuda_available: true,
      gpu_name: 'NVIDIA GeForce RTX 4070',
      ffmpeg_available: true,
      api_key_configured: false,
      model: 'gemini-2.5-flash',
      stem_device: 'auto',
    },
    backendOnline: true,
    initializing: false,
    projects: [],
    currentProject: null,
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

describe('SettingsModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetBackendApiKey.mockResolvedValue({ api_key_configured: true });
    mockClearBackendApiKey.mockResolvedValue({ api_key_configured: false });
    mockSetStemDevice.mockResolvedValue({ stem_device: 'cpu' });
  });

  it('saves and clears API key via local backend API', async () => {
    const refreshHealth = vi.fn().mockResolvedValue(null);
    mockUseProject.mockReturnValue(
      makeContext({
        refreshHealth,
        health: {
          status: 'ok',
          cuda_available: true,
          gpu_name: 'RTX 4070',
          ffmpeg_available: true,
          api_key_configured: true,
          model: 'gemini-2.5-flash',
          stem_device: 'auto',
        },
      })
    );

    render(
      <TooltipProvider>
        <SettingsModal open onClose={vi.fn()} />
      </TooltipProvider>
    );

    const input = screen.getByLabelText('Gemini API Key');
    fireEvent.change(input, { target: { value: '  test-dummy-key  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Key' }));

    await waitFor(() => {
      expect(mockSetBackendApiKey).toHaveBeenCalledWith('test-dummy-key');
    });
    expect(refreshHealth).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => {
      expect(mockClearBackendApiKey).toHaveBeenCalledTimes(1);
    });
  });

  it('switches stem splitting engine device and refreshes health', async () => {
    const refreshHealth = vi.fn().mockResolvedValue(null);
    mockUseProject.mockReturnValue(makeContext({ refreshHealth }));

    render(
      <TooltipProvider>
        <SettingsModal open onClose={vi.fn()} />
      </TooltipProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: /CPU \(Quiet\)/i }));
    await waitFor(() => {
      expect(mockSetStemDevice).toHaveBeenCalledWith('cpu');
    });
    expect(refreshHealth).toHaveBeenCalled();
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SfxItem } from '../../shared/api';
import { useProject } from '../../state/ProjectContext';
import { SoundsTab } from './SoundsTab';

vi.mock('../../state/ProjectContext', () => ({
  useProject: vi.fn(),
}));

const mockedUseProject = vi.mocked(useProject);

const SAMPLE_SFX: SfxItem[] = [
  {
    id: 'riser-sweep-1',
    name: 'White Noise Riser',
    category: 'riser',
    description: '4-bar tension sweep into the drop.',
    default_duration: 4,
    bpm_synced: true,
    preview_url: '/api/sfx/riser-sweep-1/preview',
  },
  {
    id: 'impact-boom-1',
    name: 'Sub Impact Boom',
    category: 'impact',
    description: 'Deep sub hit on beat 1.',
    default_duration: 2,
    bpm_synced: false,
    preview_url: '/api/sfx/impact-boom-1/preview',
  },
];

function createProjectMock(overrides: Record<string, unknown> = {}) {
  return {
    sfxItems: SAMPLE_SFX,
    currentProject: {
      id: 'proj-1',
      name: 'Test Mix',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      render_version: 1,
      main_track: {
        id: 'main-1',
        name: 'Main Song',
        duration: 180,
        sample_rate: 44100,
        bpm: 128,
        key: 'Am',
        beats: [],
        sections: [],
        lyric_hooks: [],
        stems_status: 'none',
        stems_error: null,
        stems: [],
        audio_url: '/audio.wav',
        rendered_url: '/rendered.wav',
        stem_urls: {},
      },
      references: [],
      edits: [],
      redo_stack: [],
      chat_messages: [],
    },
    playheadRef: { current: 42.5 },
    addSfxLayer: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('SoundsTab', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  });

  it('renders the SFX catalog with category, BPM, and duration badges', () => {
    mockedUseProject.mockReturnValue(createProjectMock() as unknown as ReturnType<typeof useProject>);

    render(<SoundsTab />);

    expect(screen.getByText('White Noise Riser')).toBeInTheDocument();
    expect(screen.getByText('4-bar tension sweep into the drop.')).toBeInTheDocument();
    expect(screen.getByText('Riser')).toBeInTheDocument();
    expect(screen.getByText('128 BPM')).toBeInTheDocument();
    expect(screen.getByText('4s')).toBeInTheDocument();

    expect(screen.getByText('Sub Impact Boom')).toBeInTheDocument();
    expect(screen.getByText('Impact')).toBeInTheDocument();
  });

  it('calls addSfxLayer with current playhead when clicking Add to Layer', async () => {
    const projectMock = createProjectMock({ playheadRef: { current: 42.5 } });
    mockedUseProject.mockReturnValue(projectMock as unknown as ReturnType<typeof useProject>);

    render(<SoundsTab />);

    const addButtons = screen.getAllByRole('button', { name: /add to layer/i });
    fireEvent.click(addButtons[0]);

    await waitFor(() => {
      expect(projectMock.addSfxLayer).toHaveBeenCalledTimes(1);
    });
    expect(projectMock.addSfxLayer).toHaveBeenCalledWith(SAMPLE_SFX[0], 42.5);
  });

  it('shows an error banner if addSfxLayer rejects', async () => {
    const projectMock = createProjectMock({
      addSfxLayer: vi.fn().mockRejectedValue(new Error('Layer limit reached')),
    });
    mockedUseProject.mockReturnValue(projectMock as unknown as ReturnType<typeof useProject>);

    render(<SoundsTab />);

    const addButtons = screen.getAllByRole('button', { name: /add to layer/i });
    fireEvent.click(addButtons[0]);

    expect(await screen.findByText('Layer limit reached')).toBeInTheDocument();
  });

  it('toggles preview play/stop and cleans up audio src on stop and unmount', () => {
    mockedUseProject.mockReturnValue(createProjectMock() as unknown as ReturnType<typeof useProject>);
    const removeAttrSpy = vi.spyOn(HTMLMediaElement.prototype, 'removeAttribute');

    const { container, unmount } = render(<SoundsTab />);
    const audioEl = container.querySelector('audio');
    expect(audioEl).not.toBeNull();

    const previewButtons = screen.getAllByRole('button', { name: /preview/i });
    fireEvent.click(previewButtons[0]);

    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    expect(audioEl?.getAttribute('src')).toContain('/api/sfx/riser-sweep-1/preview');
    expect(audioEl?.getAttribute('src')).toContain('bpm=128');
    expect(audioEl?.getAttribute('src')).toContain('key=Am');
    expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /stop/i }));

    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(removeAttrSpy).toHaveBeenCalledWith('src');
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /stop/i })).not.toBeInTheDocument();

    unmount();
    expect(removeAttrSpy).toHaveBeenCalledWith('src');
  });
});

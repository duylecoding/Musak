import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReferenceTrack } from '../../shared/api';
import { useProject } from '../../state/ProjectContext';
import { ReferenceCard } from './ReferenceCard';

vi.mock('../../state/ProjectContext', () => ({
  useProject: vi.fn(),
}));

const mockedUseProject = vi.mocked(useProject);

function makeReference(overrides: Partial<ReferenceTrack> = {}): ReferenceTrack {
  return {
    id: 'ref-1',
    title: 'Midnight Groove',
    source_type: 'local',
    youtube_url: null,
    youtube_id: null,
    duration: 195,
    bpm: 124,
    key: 'Cm',
    audio_downloaded: true,
    stems_status: 'none',
    stems_error: null,
    audio_url: '/api/projects/proj-1/references/ref-1/audio',
    moments: [
      {
        id: 'mom-1',
        label: 'Chorus Drop',
        start: 64,
        end: 80,
        note: 'Big synth hit',
        source: 'gemini',
      },
    ],
    compatibility: {
      score: 92.4,
      rating: 'great',
      bpm_diff: 2,
      semitone_diff: 0,
      summary: 'Tight tempo and key match.',
    },
    ...overrides,
  };
}

function createProjectMock(overrides: Record<string, unknown> = {}) {
  return {
    currentProject: {
      id: 'proj-1',
      name: 'Test Mix',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      render_version: 1,
      main_track: {
        id: 'main-1', name: 'Main Song', duration: 180, sample_rate: 44100, bpm: 126, key: 'Cm',
        beats: [], sections: [], lyric_hooks: [], stems_status: 'none', stems_error: null,
        stems: [], audio_url: '/audio.wav', rendered_url: '/rendered.wav', stem_urls: {},
      },
      references: [], edits: [], redo_stack: [], chat_messages: [],
    },
    health: {
      status: 'ok', cuda_available: false, gpu_name: null,
      ffmpeg_available: true, api_key_configured: true, model: 'gemini-2.5-flash',
    },
    attachedRefIds: [],
    mainTrackBusy: false,
    playheadRef: { current: 15 },
    toggleAttachRef: vi.fn(),
    deleteReference: vi.fn().mockResolvedValue(undefined),
    addMoment: vi.fn().mockResolvedValue(undefined),
    deleteMoment: vi.fn().mockResolvedValue(undefined),
    autoTagReference: vi.fn().mockResolvedValue(undefined),
    extractReferenceStems: vi.fn().mockResolvedValue(undefined),
    loadMainFromReference: vi.fn().mockResolvedValue(undefined),
    createAutoMashup: vi.fn().mockResolvedValue(undefined),
    addReferenceLayer: vi.fn().mockResolvedValue(undefined),
    sendMomentToChat: vi.fn(),
    ...overrides,
  };
}

describe('ReferenceCard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders Match Score badges for great, good, and tricky compatibility', () => {
    mockedUseProject.mockReturnValue(createProjectMock() as unknown as ReturnType<typeof useProject>);

    const { rerender } = render(
      <ReferenceCard reference={makeReference()} onOpenSettings={vi.fn()} />
    );
    expect(screen.getByText('Great 92%')).toBeInTheDocument();

    rerender(
      <ReferenceCard
        reference={makeReference({
          compatibility: {
            score: 74,
            rating: 'good',
            bpm_diff: 6,
            semitone_diff: 2,
            summary: 'Slight pitch shift needed.',
          },
        })}
        onOpenSettings={vi.fn()}
      />
    );
    expect(screen.getByText('Good 74%')).toBeInTheDocument();

    rerender(
      <ReferenceCard
        reference={makeReference({
          compatibility: {
            score: 41.8,
            rating: 'tricky',
            bpm_diff: 22,
            semitone_diff: 5,
            summary: 'Large tempo gap.',
          },
        })}
        onOpenSettings={vi.fn()}
      />
    );
    expect(screen.getByText('Tricky 42%')).toBeInTheDocument();
  });

  it('calls loadMainFromReference when clicking Use as Main', async () => {
    const projectMock = createProjectMock();
    mockedUseProject.mockReturnValue(projectMock as unknown as ReturnType<typeof useProject>);

    render(<ReferenceCard reference={makeReference()} onOpenSettings={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /use as main/i }));

    await waitFor(() => {
      expect(projectMock.loadMainFromReference).toHaveBeenCalledTimes(1);
    });
    expect(projectMock.loadMainFromReference).toHaveBeenCalledWith('ref-1');
  });

  it('pins a new moment and deletes an existing moment', async () => {
    const projectMock = createProjectMock();
    mockedUseProject.mockReturnValue(projectMock as unknown as ReturnType<typeof useProject>);

    render(<ReferenceCard reference={makeReference()} onOpenSettings={vi.fn()} />);

    expect(screen.getByText('Chorus Drop')).toBeInTheDocument();
    expect(screen.getByText('AI')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /pin moment/i }));

    fireEvent.change(screen.getByPlaceholderText(/label/i), {
      target: { value: 'Bass Switch' },
    });
    fireEvent.change(screen.getByPlaceholderText(/start/i), {
      target: { value: '1:12' },
    });
    fireEvent.change(screen.getByPlaceholderText(/end/i), {
      target: { value: '1:24' },
    });
    fireEvent.change(screen.getByPlaceholderText(/optional vibe note/i), {
      target: { value: 'Punchy kick' },
    });

    fireEvent.click(screen.getByRole('button', { name: /save pin/i }));

    await waitFor(() => {
      expect(projectMock.addMoment).toHaveBeenCalledWith('ref-1', {
        label: 'Bass Switch',
        start: 72,
        end: 84,
        note: 'Punchy kick',
      });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete pin Chorus Drop' }));

    await waitFor(() => {
      expect(projectMock.deleteMoment).toHaveBeenCalledWith('ref-1', 'mom-1');
    });
  });

  it('renders YouTube embed with strict-origin-when-cross-origin when Listen is clicked', () => {
    mockedUseProject.mockReturnValue(createProjectMock() as unknown as ReturnType<typeof useProject>);

    render(
      <ReferenceCard
        reference={makeReference({
          source_type: 'youtube',
          youtube_id: 'dQw4w9WgXcQ',
          youtube_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          audio_downloaded: false,
          audio_url: null,
        })}
        onOpenSettings={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /listen/i }));

    const iframe = screen
      .getAllByTitle('Midnight Groove')
      .find((el) => el.tagName === 'IFRAME') as HTMLIFrameElement;
    expect(iframe).toBeDefined();
    expect(iframe).toHaveAttribute('referrerPolicy', 'strict-origin-when-cross-origin');
    expect(iframe.src).toContain('https://www.youtube.com/embed/dQw4w9WgXcQ');
    expect(screen.getByRole('button', { name: /open on youtube/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ Drop' })).toBeDisabled();
  });

  it('passes moment.start and moment.end to addReferenceLayer when clicking + Drop', async () => {
    const projectMock = createProjectMock();
    mockedUseProject.mockReturnValue(projectMock as unknown as ReturnType<typeof useProject>);

    const ref = makeReference();
    render(<ReferenceCard reference={ref} onOpenSettings={vi.fn()} />);

    const dropBtn = screen.getByRole('button', { name: '+ Drop' });
    expect(dropBtn).not.toBeDisabled();
    fireEvent.click(dropBtn);

    await waitFor(() => {
      expect(projectMock.addReferenceLayer).toHaveBeenCalledTimes(1);
    });
    expect(projectMock.addReferenceLayer).toHaveBeenCalledWith({
      ref,
      refStart: 64,
      refEnd: 80,
      targetStart: 15,
      label: 'Chorus Drop',
    });
  });
});

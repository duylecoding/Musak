import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { EditProposal } from '../../shared/api';
import { TooltipProvider } from '../../shared/components/Tooltip/Tooltip';
import { ProposalCard, type ProposalCardProps } from './ProposalCard';

function makeProposal(overrides: Partial<EditProposal> = {}): EditProposal {
  return {
    id: 'prop-1',
    title: 'Punchy Drop Lift',
    summary: 'Boosts drum snap and adds a short riser into the chorus.',
    style: 'creative',
    start: 45,
    end: 53,
    operations: [],
    intensity: 1.0,
    keep_vocals_clear: false,
    shift_beats: 0,
    preview_url: '/api/projects/p1/audio/preview/prop-1',
    preview_start: 43,
    preview_end: 55,
    applied: false,
    ...overrides,
  };
}

function renderCard(overrides: Partial<ProposalCardProps> = {}) {
  const props: ProposalCardProps = {
    proposal: makeProposal(),
    isPlaying: false,
    isApplying: false,
    isTuning: false,
    anyTuning: false,
    sending: false,
    onTogglePreview: vi.fn(),
    onApply: vi.fn(),
    onTune: vi.fn().mockResolvedValue(true),
    onTryAnother: vi.fn(),
    ...overrides,
  };

  const view = render(
    <TooltipProvider>
      <ProposalCard {...props} />
    </TooltipProvider>
  );
  return { ...view, props };
}

describe('ProposalCard', () => {
  it('commits Subtle↔Bold slider on pointerUp/keyUp and reverts on tune failure', async () => {
    const onTune = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    renderCard({ onTune });

    const slider = screen.getByRole('slider', { name: /subtle to bold/i }) as HTMLInputElement;
    expect(slider.value).toBe('1');

    fireEvent.change(slider, { target: { value: '1.45' } });
    fireEvent.pointerUp(slider);

    await waitFor(() => {
      expect(onTune).toHaveBeenCalledWith({ intensity: 1.45 });
    });

    fireEvent.change(slider, { target: { value: '0.4' } });
    fireEvent.keyUp(slider, { key: 'ArrowLeft' });

    await waitFor(() => {
      expect(onTune).toHaveBeenCalledWith({ intensity: 0.4 });
      expect(slider.value).toBe('1');
    });
  });

  it('toggles Keep Vocals Clear', async () => {
    const onTune = vi.fn().mockResolvedValue(true);
    const { rerender, props } = renderCard({
      proposal: makeProposal({ keep_vocals_clear: false }),
      onTune,
    });

    const toggleBtn = screen.getByRole('button', { name: /keep vocals clear/i });
    expect(toggleBtn).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggleBtn);
    expect(onTune).toHaveBeenCalledWith({ keep_vocals_clear: true });

    rerender(
      <TooltipProvider>
        <ProposalCard {...props} proposal={makeProposal({ keep_vocals_clear: true })} />
      </TooltipProvider>
    );
    const activeBtn = screen.getByRole('button', { name: /keep vocals clear/i });
    expect(activeBtn).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(activeBtn);
    expect(onTune).toHaveBeenCalledWith({ keep_vocals_clear: false });
  });

  it('nudges -2/+2 Beats and clamps at ±16', () => {
    const onTune = vi.fn().mockResolvedValue(true);
    const { rerender, props } = renderCard({
      proposal: makeProposal({ shift_beats: -15 }),
      onTune,
    });

    fireEvent.click(screen.getByRole('button', { name: '-2 Beats' }));
    expect(onTune).toHaveBeenCalledWith({ shift_beats: -16 });

    rerender(
      <TooltipProvider>
        <ProposalCard {...props} proposal={makeProposal({ shift_beats: -16 })} />
      </TooltipProvider>
    );
    expect(screen.getByRole('button', { name: '-2 Beats' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '+2 Beats' })).not.toBeDisabled();

    rerender(
      <TooltipProvider>
        <ProposalCard {...props} proposal={makeProposal({ shift_beats: 15 })} />
      </TooltipProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: '+2 Beats' }));
    expect(onTune).toHaveBeenCalledWith({ shift_beats: 16 });

    rerender(
      <TooltipProvider>
        <ProposalCard {...props} proposal={makeProposal({ shift_beats: 16 })} />
      </TooltipProvider>
    );
    expect(screen.getByRole('button', { name: '+2 Beats' })).toBeDisabled();
  });

  it('toggles Preview/Stop and hides Preview when preview_url is null', () => {
    const onTogglePreview = vi.fn();
    const { rerender, props } = renderCard({ isPlaying: false, onTogglePreview });

    fireEvent.click(screen.getByRole('button', { name: /preview/i }));
    expect(onTogglePreview).toHaveBeenCalledTimes(1);

    rerender(
      <TooltipProvider>
        <ProposalCard {...props} isPlaying={true} />
      </TooltipProvider>
    );
    expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();

    rerender(
      <TooltipProvider>
        <ProposalCard {...props} proposal={makeProposal({ preview_url: null })} />
      </TooltipProvider>
    );
    expect(screen.queryByRole('button', { name: /preview|stop/i })).not.toBeInTheDocument();
  });

  it('handles Apply to Track, Applying..., and Applied states', () => {
    const onApply = vi.fn();
    const { rerender, props } = renderCard({ onApply });

    const applyBtn = screen.getByRole('button', { name: 'Apply to Track' });
    expect(applyBtn).not.toBeDisabled();
    fireEvent.click(applyBtn);
    expect(onApply).toHaveBeenCalledTimes(1);

    rerender(
      <TooltipProvider>
        <ProposalCard {...props} isApplying={true} />
      </TooltipProvider>
    );
    expect(screen.getByRole('button', { name: /applying/i })).toBeDisabled();

    rerender(
      <TooltipProvider>
        <ProposalCard {...props} proposal={makeProposal({ applied: true })} />
      </TooltipProvider>
    );
    expect(screen.getByRole('button', { name: /applied/i })).toBeDisabled();
  });
});

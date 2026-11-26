import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../../shared/components/Tooltip/Tooltip';
import { SegmentActionBar } from './SegmentActionBar';

function renderBar(overrides: Partial<React.ComponentProps<typeof SegmentActionBar>> = {}) {
  const props: React.ComponentProps<typeof SegmentActionBar> = {
    selection: { start: 45, end: 53, lane: 'vocals' },
    stemsReady: true,
    busy: false,
    onSetBars: vi.fn(),
    onAdjustVolume: vi.fn(),
    onApplyFx: vi.fn(),
    onAskGemini: vi.fn(),
    onClearSelection: vi.fn(),
    ...overrides,
  };
  return {
    props,
    ...render(
      <TooltipProvider>
        <SegmentActionBar {...props} />
      </TooltipProvider>
    ),
  };
}

describe('SegmentActionBar', () => {
  it('renders target lane and time range and handles Mute/Cut, 4 Bars, FX, and Ask Gemini', () => {
    const { props } = renderBar();

    expect(screen.getByText('Vocals')).toBeInTheDocument();
    expect(screen.getByText('0:45 – 0:53')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '4 Bars' }));
    expect(props.onSetBars).toHaveBeenCalledWith(4);

    fireEvent.click(screen.getByRole('button', { name: /Mute \/ Cut/i }));
    expect(props.onAdjustVolume).toHaveBeenCalledWith(-80);

    fireEvent.click(screen.getByRole('button', { name: /^FX$/i }));
    fireEvent.click(screen.getByText('Filter Sweep'));
    expect(props.onApplyFx).toHaveBeenCalledTimes(1);
    expect(props.onApplyFx).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'filter_sweep', label: 'Filter Sweep' })
    );

    fireEvent.click(screen.getByRole('button', { name: /Ask Gemini/i }));
    expect(props.onAskGemini).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(props.onClearSelection).toHaveBeenCalledTimes(1);
  });

  it('disables Mute/Cut and Volume when stems are not ready', () => {
    renderBar({ stemsReady: false });

    expect(screen.getByRole('button', { name: /Mute \/ Cut/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Volume/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^FX$/i })).toBeEnabled();
  });
});

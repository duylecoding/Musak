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
    onApplyFade: vi.fn(),
    onCutSection: vi.fn(),
    onRepeatSection: vi.fn(),
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
    expect(screen.queryByRole('button', { name: /Cut Out/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Repeat ×2/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '4 Bars' }));
    expect(props.onSetBars).toHaveBeenCalledWith(4);

    fireEvent.click(screen.getByRole('button', { name: /Mute \/ Cut/i }));
    expect(props.onAdjustVolume).toHaveBeenCalledWith(-80);

    fireEvent.click(screen.getByRole('button', { name: /^FX$/i }));
    expect(screen.getByText('Low-Pass Underwater')).toBeInTheDocument();
    expect(screen.getByText('Filter Open Up')).toBeInTheDocument();
    expect(screen.getByText('Sidechain Pump')).toBeInTheDocument();
    expect(screen.getByText('Stereo Wash')).toBeInTheDocument();
    expect(screen.getByText('DJ Moves')).toBeInTheDocument();
    expect(screen.getByText('Club Buildup')).toBeInTheDocument();
    expect(screen.getByText('Real Vinyl Brake')).toBeInTheDocument();

    fireEvent.click(screen.getByText('High-Pass Rise'));
    expect(props.onApplyFx).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'filter_sweep', label: 'High-Pass Rise' })
    );

    fireEvent.click(screen.getByRole('button', { name: /Ask Gemini/i }));
    expect(props.onAskGemini).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(props.onClearSelection).toHaveBeenCalledTimes(1);
  });

  it('triggers Fade In and Fade Out from the Volume menu', () => {
    const { props } = renderBar();

    fireEvent.click(screen.getByRole('button', { name: /Volume/i }));
    fireEvent.click(screen.getByText('Fade In'));
    expect(props.onApplyFade).toHaveBeenCalledWith('in');

    fireEvent.click(screen.getByRole('button', { name: /Volume/i }));
    fireEvent.click(screen.getByText('Fade Out'));
    expect(props.onApplyFade).toHaveBeenCalledWith('out');
  });

  it('shows Cut Out and Repeat ×2 on full-track selection and fires Low-Pass Underwater / DJ Moves', () => {
    const { props } = renderBar({ selection: { start: 16, end: 24, lane: 'all' } });

    fireEvent.click(screen.getByRole('button', { name: /Cut Out/i }));
    expect(props.onCutSection).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /Repeat ×2/i }));
    expect(props.onRepeatSection).toHaveBeenCalledWith(2);

    fireEvent.click(screen.getByRole('button', { name: /^FX$/i }));
    fireEvent.click(screen.getByText('Low-Pass Underwater'));
    expect(props.onApplyFx).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'lowpass_underwater' })
    );

    fireEvent.click(screen.getByRole('button', { name: /^FX$/i }));
    fireEvent.click(screen.getByText('Beat Stutter (1/4)'));
    expect(props.onApplyFx).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'beat_repeat' })
    );

    fireEvent.click(screen.getByRole('button', { name: /^FX$/i }));
    fireEvent.click(screen.getByText('Sidechain Pump'));
    expect(props.onApplyFx).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'sidechain_pump', label: 'Sidechain Pump' })
    );

    fireEvent.click(screen.getByRole('button', { name: /^FX$/i }));
    fireEvent.click(screen.getByText('Stereo Wash'));
    expect(props.onApplyFx).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'stereo_wash', label: 'Stereo Wash' })
    );
  });

  it('disables Mute/Cut and Volume when stems are not ready', () => {
    renderBar({ stemsReady: false });

    expect(screen.getByRole('button', { name: /Mute \/ Cut/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Volume/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^FX$/i })).toBeEnabled();
  });
});

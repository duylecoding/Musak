import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HelpTip, TooltipProvider, useTooltips } from './Tooltip';

const ToggleProbe: React.FC = () => {
  const { tipsEnabled, toggleTips } = useTooltips();
  return (
    <button type="button" onClick={toggleTips}>
      {tipsEnabled ? 'tips-on' : 'tips-off'}
    </button>
  );
};

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

describe('Tooltip', () => {
  beforeEach(() => {
    ensureMockLocalStorage();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('persists tipsEnabled in localStorage and defaults to true', () => {
    render(
      <TooltipProvider>
        <ToggleProbe />
      </TooltipProvider>
    );

    const btn = screen.getByRole('button', { name: 'tips-on' });
    fireEvent.click(btn);
    expect(screen.getByRole('button', { name: 'tips-off' })).toBeInTheDocument();
    expect(window.localStorage.getItem('musak_tips_enabled')).toBe('false');
  });

  it('shows tooltip in a document.body portal after 160ms hover delay and hides on leave', () => {
    render(
      <TooltipProvider>
        <HelpTip title="Cut Vocals" content="Lowers vocal stem volume">
          <button type="button">Hover me</button>
        </HelpTip>
      </TooltipProvider>
    );

    const triggerBtn = screen.getByRole('button', { name: 'Hover me' });
    fireEvent.mouseEnter(triggerBtn.parentElement!);

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(159);
    });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    const tip = screen.getByRole('tooltip');
    expect(tip).toBeInTheDocument();
    expect(tip.parentElement).toBe(document.body);
    expect(screen.getByText('Cut Vocals')).toBeInTheDocument();
    expect(screen.getByText('Lowers vocal stem volume')).toBeInTheDocument();

    fireEvent.mouseLeave(triggerBtn.parentElement!);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('does not show tooltip when musak_tips_enabled is false', () => {
    window.localStorage.setItem('musak_tips_enabled', 'false');

    render(
      <TooltipProvider>
        <HelpTip content="Hidden tip">
          <button type="button">Hover me</button>
        </HelpTip>
      </TooltipProvider>
    );

    const triggerBtn = screen.getByRole('button', { name: 'Hover me' });
    fireEvent.mouseEnter(triggerBtn.parentElement!);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });
});

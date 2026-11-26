import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BpmKeyPopover } from './BpmKeyPopover';

function makeAnchorRef() {
  const el = document.createElement('button');
  el.getBoundingClientRect = () => ({
    top: 40, bottom: 70, left: 100, right: 180, width: 80, height: 30, x: 100, y: 40, toJSON: () => {},
  });
  document.body.appendChild(el);
  return { current: el } as React.RefObject<HTMLElement | null>;
}

describe('BpmKeyPopover', () => {
  it('handles ÷2, ×2, and manual BPM + Key apply', async () => {
    const onApply = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();

    render(
      <BpmKeyPopover
        open
        anchorRef={makeAnchorRef()}
        bpm={140}
        musicalKey="C Major"
        onClose={onClose}
        onApply={onApply}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '÷2' }));
    await waitFor(() => expect(onApply).toHaveBeenCalledWith({ bpm: 70 }));

    fireEvent.click(screen.getByRole('button', { name: '×2' }));
    await waitFor(() => expect(onApply).toHaveBeenCalledWith({ bpm: 140 }));

    fireEvent.change(screen.getByRole('spinbutton', { name: /BPM/i }), { target: { value: '128' } });
    fireEvent.change(screen.getByLabelText('Musical Key'), { target: { value: 'A Minor' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(onApply).toHaveBeenCalledWith({ bpm: 128, key: 'A Minor' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

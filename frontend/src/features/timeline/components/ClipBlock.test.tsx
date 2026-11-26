import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { EditBlock } from '../../../shared/api';
import { ClipBlock } from './ClipBlock';

function makeEdit(overrides: Partial<EditBlock> = {}): EditBlock {
  return {
    id: 'edit-1',
    title: 'Mute Vocals',
    description: 'Cuts vocals cleanly.',
    start: 5,
    end: 10,
    enabled: true,
    operations: [{ type: 'stem_gain', stems: ['vocals'], gain_db: -80 }],
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('ClipBlock', () => {
  it('positions clip proportionally and supports previewRange overrides', () => {
    const onPointerDown = vi.fn();
    const { rerender } = render(
      <ClipBlock
        edit={makeEdit()}
        tone="vocals"
        trackDuration={20}
        onClipPointerDown={onPointerDown}
      />
    );

    const clip = screen.getByRole('button', { name: 'Mute Vocals clip' });
    expect(clip.style.left).toBe('25%');
    expect(clip.style.width).toBe('25%');
    expect(screen.queryByText('Off')).not.toBeInTheDocument();

    rerender(
      <ClipBlock
        edit={makeEdit()}
        tone="vocals"
        trackDuration={20}
        previewRange={{ start: 10, end: 15 }}
        onClipPointerDown={onPointerDown}
      />
    );
    expect(clip.style.left).toBe('50%');
    expect(clip.style.width).toBe('25%');
  });

  it('renders disabled Off badge when edit.enabled is false', () => {
    render(
      <ClipBlock
        edit={makeEdit({ enabled: false })}
        tone="drums"
        trackDuration={20}
        onClipPointerDown={vi.fn()}
      />
    );

    expect(screen.getByText('Off')).toBeInTheDocument();
  });

  it('invokes move pointer-down, keyboard inspect, and left/right resize handles', () => {
    const onPointerDown = vi.fn();
    const onInspect = vi.fn();
    const edit = makeEdit();

    render(
      <ClipBlock
        edit={edit}
        tone="bass"
        trackDuration={20}
        onClipPointerDown={onPointerDown}
        onInspect={onInspect}
      />
    );

    const clip = screen.getByRole('button', { name: 'Mute Vocals clip' });
    fireEvent.pointerDown(clip, { button: 0 });
    expect(onPointerDown).toHaveBeenCalledWith(edit, 'move', expect.any(Object));

    fireEvent.keyDown(clip, { key: 'Enter' });
    expect(onInspect).toHaveBeenCalledWith(edit, clip);

    const leftHandle = screen.getByRole('separator', { name: 'Resize left edge' });
    const rightHandle = screen.getByRole('separator', { name: 'Resize right edge' });

    onPointerDown.mockClear();
    fireEvent.pointerDown(leftHandle, { button: 0 });
    expect(onPointerDown).toHaveBeenCalledTimes(1);
    expect(onPointerDown).toHaveBeenCalledWith(edit, 'resize-left', expect.any(Object));

    onPointerDown.mockClear();
    fireEvent.pointerDown(rightHandle, { button: 0 });
    expect(onPointerDown).toHaveBeenCalledTimes(1);
    expect(onPointerDown).toHaveBeenCalledWith(edit, 'resize-right', expect.any(Object));
  });
});

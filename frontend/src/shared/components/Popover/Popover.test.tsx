import React, { useRef, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Popover } from './Popover';

const PopoverHarness: React.FC<{
  initialOpen?: boolean;
  onCloseSpy?: () => void;
  align?: 'start' | 'center' | 'end';
}> = ({ initialOpen = true, onCloseSpy, align = 'start' }) => {
  const [open, setOpen] = useState(initialOpen);
  const anchorRef = useRef<HTMLButtonElement>(null);

  return (
    <div>
      <button ref={anchorRef} type="button" onClick={() => setOpen((o) => !o)}>
        Anchor
      </button>
      <div data-testid="outside">Outside area</div>
      <Popover
        anchorRef={anchorRef}
        open={open}
        onClose={() => {
          setOpen(false);
          onCloseSpy?.();
        }}
        width={200}
        align={align}
        ariaLabel="Test popover"
      >
        <div data-testid="popover-content">Popover Body</div>
      </Popover>
    </div>
  );
};

describe('Popover', () => {
  it('portals into document.body when open and closes on Escape or outside click', () => {
    const onCloseSpy = vi.fn();
    render(<PopoverHarness onCloseSpy={onCloseSpy} />);

    const dialog = screen.getByRole('dialog', { name: 'Test popover' });
    expect(dialog.parentElement).toBe(document.body);

    // Clicking inside popover does not close it
    fireEvent.mouseDown(screen.getByTestId('popover-content'));
    expect(onCloseSpy).not.toHaveBeenCalled();

    // Clicking outside closes it
    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(onCloseSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // Reopen and close on Escape
    fireEvent.click(screen.getByRole('button', { name: 'Anchor' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCloseSpy).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes on window scroll outside popover and resize, but not internal scroll', () => {
    const onCloseSpy = vi.fn();
    render(<PopoverHarness onCloseSpy={onCloseSpy} />);

    const content = screen.getByTestId('popover-content');
    fireEvent.scroll(content);
    expect(onCloseSpy).not.toHaveBeenCalled();

    fireEvent.scroll(window);
    expect(onCloseSpy).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Anchor' }));
    fireEvent.resize(window);
    expect(onCloseSpy).toHaveBeenCalledTimes(2);
  });

  it('auto-flips above anchor and clamps within viewport edges', () => {
    Object.defineProperty(window, 'innerWidth', { value: 400, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 300, configurable: true });

    const origGetRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      if (this.tagName === 'BUTTON') {
        return new DOMRect(300, 260, 80, 30);
      }
      if (this.getAttribute('role') === 'dialog') {
        return new DOMRect(0, 0, 200, 120);
      }
      return origGetRect.call(this);
    });

    render(<PopoverHarness />);
    const dialog = screen.getByRole('dialog');
    // Anchor bottom is 290; height 120 wouldn't fit below in 300px viewport -> flips above: 260 - 120 - 6 = 134
    expect(dialog.style.top).toBe('134px');
    // Anchor left is 300; width 200 clamped to 400 - 200 - 10 = 190
    expect(dialog.style.left).toBe('190px');

    vi.restoreAllMocks();
  });
});

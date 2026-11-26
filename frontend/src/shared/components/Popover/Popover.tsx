import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './Popover.module.css';

const GAP = 6;
const VIEWPORT_PADDING = 10;

export interface PopoverProps {
  anchorRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  width?: number | string;
  align?: 'start' | 'center' | 'end';
  className?: string;
  ariaLabel?: string;
  children: React.ReactNode;
}

function computePopoverCoords(
  anchorRect: DOMRect,
  popRect: DOMRect,
  align: 'start' | 'center' | 'end'
): { top: number; left: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const spaceBelow = vh - anchorRect.bottom - GAP - VIEWPORT_PADDING;
  const spaceAbove = anchorRect.top - GAP - VIEWPORT_PADDING;
  const openAbove = popRect.height > spaceBelow && spaceAbove > spaceBelow;

  const rawTop = openAbove
    ? anchorRect.top - popRect.height - GAP
    : anchorRect.bottom + GAP;

  let rawLeft = anchorRect.left;
  if (align === 'center') {
    rawLeft = anchorRect.left + anchorRect.width / 2 - popRect.width / 2;
  } else if (align === 'end') {
    rawLeft = anchorRect.right - popRect.width;
  }

  return {
    top: Math.max(
      VIEWPORT_PADDING,
      Math.min(rawTop, Math.max(VIEWPORT_PADDING, vh - popRect.height - VIEWPORT_PADDING))
    ),
    left: Math.max(
      VIEWPORT_PADDING,
      Math.min(rawLeft, Math.max(VIEWPORT_PADDING, vw - popRect.width - VIEWPORT_PADDING))
    ),
  };
}

export const Popover: React.FC<PopoverProps> = ({
  anchorRef,
  open,
  onClose,
  width,
  align = 'start',
  className,
  ariaLabel,
  children,
}) => {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    const onMouseDown = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (popoverRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };

    const onScroll = (e: Event) => {
      const target = e.target;
      if (target instanceof Node && popoverRef.current?.contains(target)) return;
      onClose();
    };

    const onResize = () => onClose();

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, onClose, anchorRef]);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current || !popoverRef.current) return;
    const next = computePopoverCoords(
      anchorRef.current.getBoundingClientRect(),
      popoverRef.current.getBoundingClientRect(),
      align
    );
    setCoords(next);
  }, [open, align, width, children, anchorRef]);

  if (!open || typeof document === 'undefined') {
    return null;
  }

  const panelClass = className ? `${styles.popoverPanel} ${className}` : styles.popoverPanel;

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={ariaLabel}
      className={panelClass}
      style={{
        width: typeof width === 'number' ? `${width}px` : width,
        top: coords ? `${coords.top}px` : '-9999px',
        left: coords ? `${coords.left}px` : '-9999px',
        opacity: coords ? 1 : 0,
      }}
    >
      {children}
    </div>,
    document.body
  );
};

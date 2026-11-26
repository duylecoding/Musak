import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import styles from './Tooltip.module.css';

const STORAGE_KEY = 'musak_tips_enabled';
const GAP = 8;
const VIEWPORT_PADDING = 10;
const SHOW_DELAY_MS = 160;

interface TooltipContextValue {
  tipsEnabled: boolean;
  toggleTips: () => void;
  setTipsEnabled: (enabled: boolean) => void;
}

const TooltipContext = createContext<TooltipContextValue>({
  tipsEnabled: true,
  toggleTips: () => {},
  setTipsEnabled: () => {},
});

export const TooltipProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [tipsEnabled, setTipsEnabledState] = useState<boolean>(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved === 'false') return false;
      if (saved === 'true') return true;
    } catch {
      // Ignore storage errors
    }
    return true;
  });

  const setTipsEnabled = useCallback((enabled: boolean) => {
    setTipsEnabledState(enabled);
    try {
      window.localStorage.setItem(STORAGE_KEY, String(enabled));
    } catch {
      // Ignore storage errors
    }
  }, []);

  const toggleTips = useCallback(() => {
    setTipsEnabledState((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(STORAGE_KEY, String(next));
      } catch {
        // Ignore storage errors
      }
      return next;
    });
  }, []);

  return (
    <TooltipContext.Provider value={{ tipsEnabled, toggleTips, setTipsEnabled }}>
      {children}
    </TooltipContext.Provider>
  );
};

export function useTooltips(): TooltipContextValue {
  return useContext(TooltipContext);
}

export interface HelpTipProps {
  content: string;
  title?: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
  children: React.ReactNode;
}

function computeTooltipCoords(
  triggerRect: DOMRect,
  tipRect: DOMRect,
  preferredSide: 'top' | 'bottom' | 'left' | 'right'
): { top: number; left: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let chosenSide = preferredSide;
  if (preferredSide === 'top' && triggerRect.top - tipRect.height - GAP < VIEWPORT_PADDING) {
    chosenSide = 'bottom';
  } else if (
    preferredSide === 'bottom' &&
    triggerRect.bottom + tipRect.height + GAP > vh - VIEWPORT_PADDING
  ) {
    chosenSide = 'top';
  } else if (preferredSide === 'left' && triggerRect.left - tipRect.width - GAP < VIEWPORT_PADDING) {
    chosenSide = 'right';
  } else if (
    preferredSide === 'right' &&
    triggerRect.right + tipRect.width + GAP > vw - VIEWPORT_PADDING
  ) {
    chosenSide = 'left';
  }

  let rawTop = 0;
  let rawLeft = 0;
  switch (chosenSide) {
    case 'bottom':
      rawTop = triggerRect.bottom + GAP;
      rawLeft = triggerRect.left + triggerRect.width / 2 - tipRect.width / 2;
      break;
    case 'left':
      rawTop = triggerRect.top + triggerRect.height / 2 - tipRect.height / 2;
      rawLeft = triggerRect.left - tipRect.width - GAP;
      break;
    case 'right':
      rawTop = triggerRect.top + triggerRect.height / 2 - tipRect.height / 2;
      rawLeft = triggerRect.right + GAP;
      break;
    case 'top':
    default:
      rawTop = triggerRect.top - tipRect.height - GAP;
      rawLeft = triggerRect.left + triggerRect.width / 2 - tipRect.width / 2;
      break;
  }

  return {
    top: Math.max(
      VIEWPORT_PADDING,
      Math.min(rawTop, Math.max(VIEWPORT_PADDING, vh - tipRect.height - VIEWPORT_PADDING))
    ),
    left: Math.max(
      VIEWPORT_PADDING,
      Math.min(rawLeft, Math.max(VIEWPORT_PADDING, vw - tipRect.width - VIEWPORT_PADDING))
    ),
  };
}

export const HelpTip: React.FC<HelpTipProps> = ({
  content,
  title,
  side = 'top',
  className,
  children,
}) => {
  const { tipsEnabled } = useTooltips();
  const [visible, setVisible] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);

  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const hide = useCallback(() => {
    clearTimer();
    setVisible(false);
    setCoords(null);
  }, [clearTimer]);

  const scheduleShow = useCallback(() => {
    if (!tipsEnabled || !content) return;
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      setVisible(true);
    }, SHOW_DELAY_MS);
  }, [tipsEnabled, content, clearTimer]);

  useEffect(() => {
    if (!tipsEnabled) {
      hide();
    }
  }, [tipsEnabled, hide]);

  useEffect(() => () => clearTimer(), [clearTimer]);

  useEffect(() => {
    if (!visible) return;
    const handleDismiss = () => setVisible(false);
    window.addEventListener('scroll', handleDismiss, true);
    window.addEventListener('resize', handleDismiss);
    return () => {
      window.removeEventListener('scroll', handleDismiss, true);
      window.removeEventListener('resize', handleDismiss);
    };
  }, [visible]);

  useLayoutEffect(() => {
    if (!visible || !triggerRef.current || !tooltipRef.current) return;
    const next = computeTooltipCoords(
      triggerRef.current.getBoundingClientRect(),
      tooltipRef.current.getBoundingClientRect(),
      side
    );
    setCoords(next);
  }, [visible, side, content, title]);

  return (
    <>
      <span
        ref={triggerRef}
        onMouseEnter={scheduleShow}
        onMouseLeave={hide}
        onFocus={scheduleShow}
        onBlur={hide}
        onMouseDown={hide}
        className={className ? `${styles.trigger} ${className}` : styles.trigger}
      >
        {children}
      </span>

      {visible &&
        tipsEnabled &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={tooltipRef}
            role="tooltip"
            className={styles.tooltipPanel}
            style={{
              top: coords ? `${coords.top}px` : '-9999px',
              left: coords ? `${coords.left}px` : '-9999px',
              opacity: coords ? 1 : 0,
            }}
          >
            {title && <div className={styles.tooltipTitle}>{title}</div>}
            <div className={styles.tooltipBody}>{content}</div>
          </div>,
          document.body
        )}
    </>
  );
};

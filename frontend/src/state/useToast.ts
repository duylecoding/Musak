import { useCallback, useEffect, useState } from 'react';

export interface ToastState {
  type: 'error' | 'success';
  message: string;
}

export function useToast(durationMs = 4500) {
  const [toast, setToast] = useState<ToastState | null>(null);

  const showToast = useCallback((type: 'error' | 'success', message: string) => {
    setToast({ type, message });
  }, []);

  const dismissToast = useCallback(() => {
    setToast(null);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), durationMs);
    return () => window.clearTimeout(timer);
  }, [toast, durationMs]);

  return { toast, showToast, dismissToast };
}

import { useEffect, useState, useCallback, useRef } from 'react';

type UpdateState = 'idle' | 'available' | 'updating';

interface UseAppUpdateReturn {
  state: UpdateState;
  update: () => void;
}

export function useAppUpdate(): UseAppUpdateReturn {
  const [state, setState] = useState<UpdateState>('idle');
  const regRef = useRef<ServiceWorkerRegistration | null>(null);
  const stateRef = useRef<UpdateState>(state);
  stateRef.current = state;

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const handleUpdateFound = () => {
      const installing = regRef.current?.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          setState('available');
        }
      });
    };

    const handleControllerChange = () => {
      if (stateRef.current === 'updating') {
        window.location.reload();
      }
    };

    const register = async () => {
      try {
        const reg = await navigator.serviceWorker.register('/sw.js');
        regRef.current = reg;
        reg.addEventListener('updatefound', handleUpdateFound);
      } catch {
        // SW registration failed (non-fatal — app still works without offline support)
      }
    };

    void register();
    navigator.serviceWorker.addEventListener('controllerchange', handleControllerChange);

    return () => {
      if (regRef.current) regRef.current.removeEventListener('updatefound', handleUpdateFound);
      navigator.serviceWorker.removeEventListener('controllerchange', handleControllerChange);
    };
  }, []);

  const update = useCallback(() => {
    setState('updating');
    const waiting = regRef.current?.waiting;
    if (waiting) {
      waiting.postMessage({ type: 'SKIP_WAITING' });
    } else {
      window.location.reload();
    }
  }, []);

  return { state, update };
}

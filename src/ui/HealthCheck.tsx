import { useEffect, useState, useCallback } from 'react';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';

interface HealthCheckProps {
  onReady: () => void;
}

type HealthStatus = 'checking' | 'ok' | 'failed';

export function HealthCheck({ onReady }: HealthCheckProps) {
  const [status, setStatus] = useState<HealthStatus>('checking');
  const [message, setMessage] = useState('Проверка источников данных…');
  const [attempt, setAttempt] = useState(0);

  const check = useCallback(() => {
    let cancelled = false;
    setStatus('checking');
    setMessage('Проверка источников данных…');
    void (async () => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const res = await fetch('https://api.binance.com/api/v3/ping', {
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (cancelled) return;
        if (res.ok) {
          setStatus('ok');
          setMessage('Подключено к Binance');
          const readyTimer = setTimeout(() => !cancelled && onReady(), 600);
          return () => clearTimeout(readyTimer);
        } else {
          setStatus('failed');
          setMessage(`Binance ответил статусом ${res.status}`);
        }
      } catch {
        if (cancelled) return;
        setStatus('failed');
        setMessage('Нет связи с Binance. Проверьте подключение.');
      }
    })();
    return () => { cancelled = true; };
  }, [onReady]);

  useEffect(() => {
    const cleanup = check();
    return cleanup;
  }, [check, attempt]);

  const handleRetry = () => {
    setAttempt((a) => a + 1);
  };

  return (
    <div className="flex h-[100dvh] flex-col items-center justify-center gap-4 bg-base-950 px-4">
      {status === 'checking' && <Loader2 size={32} className="animate-spin text-secondary-400" />}
      {status === 'ok' && <CheckCircle2 size={32} className="text-success-500" />}
      {status === 'failed' && (
        <>
          <XCircle size={32} className="text-error-500" />
          <button
            onClick={handleRetry}
            className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-primary-500"
          >
            Повторить
          </button>
        </>
      )}
      <p className="text-sm text-base-300">{message}</p>
    </div>
  );
}

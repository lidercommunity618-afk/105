import { useEffect, useRef } from 'react';

// Аудит (работа в «спящем режиме»): полноценно продолжать открывать
// демо-сделки при выключенном/заблокированном экране браузер НЕ может —
// это ограничение самой платформы (iOS Safari замораживает вкладку через
// несколько секунд в фоне, Android — через считаные минуты, WebSocket
// закрывается ОС), а не текущей реализации: ни один сайт/PWA-без-нативного
// бэкграунд-сервиса не в состоянии гарантировать выполнение JS при
// заблокированном экране. Единственный технически честный способ сделать
// торговлю нечувствительной ко сну устройства — перенести движок демо-сделок
// на сервер (Supabase Edge Function по расписанию), это отдельная задача.
//
// Что реально можно и нужно сделать на клиенте — не дать экрану погаснуть
// по таймауту бездействия, пока идёт активная автоторговля: это самая частая
// причина обрыва сессии на практике (пользователь просто не трогает экран).
// Screen Wake Lock API решает именно это: держит экран включённым, пока
// вкладка видима и лок не отпущен явно.
//
// Ограничения, которые API не снимает (и не может):
// - если пользователь вручную нажал кнопку блокировки/сна — лок снимается
//   браузером принудительно (спецификация Wake Lock API);
// - если вкладка свёрнута/приложение уйдёт в фон — лок тоже снимается
//   браузером автоматически; при возврате на вкладку хук перезапрашивает
//   его сам (см. visibilitychange ниже).
export function useWakeLock(enabled: boolean): void {
  const lockRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;

    let cancelled = false;

    const releaseCurrent = () => {
      const current = lockRef.current;
      lockRef.current = null;
      if (current) void current.release().catch(() => {});
    };

    const acquire = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const lock = await navigator.wakeLock.request('screen');
        if (cancelled) {
          void lock.release().catch(() => {});
          return;
        }
        lockRef.current = lock;
        lock.addEventListener('release', () => {
          if (lockRef.current === lock) lockRef.current = null;
        });
      } catch {
        // Недоступно/отклонено (нет фокуса, браузер без поддержки,
        // системная экономия энергии и т.п.) — не критично, автоторговля
        // продолжает работать как и раньше, просто без удержания экрана.
      }
    };

    void acquire();

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        if (!lockRef.current) void acquire();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      releaseCurrent();
    };
  }, [enabled]);
}

import { useEffect, useState } from 'react';
import { Timer, AlertTriangle, Moon } from 'lucide-react';
import { useTickStore } from '@/stores/useTickStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { TIMEFRAME_SECONDS } from '@/data/symbols';
import { serverClock } from '@/data/server-clock';
import { clsx } from '@/lib/utils';
import { PRE_CLOSE_SIGNAL_LEAD_MS } from '@/lib/constants';

export function CandleTimer() {
  const symbolId = useSettingsStore((s) => s.symbolId);
  const timeframe = useSettingsStore((s) => s.timeframe);
  const candleLifecycle = useTickStore((s) => s.candleLifecycle);
  const marketClosed = useTickStore((s) => s.marketClosed);
  // Реальное время открытия последней свечи из потока данных — тот же
  // источник истины, которым пользуются schedulePreCloseTimer() и
  // checkExpiries() в useTickStore для реального открытия/закрытия
  // сделок. Раньше таймер считал границу свечи ТОЛЬКО по формуле
  // Math.floor(nowMs / tfMs) * tfSec, то есть предполагал, что границы
  // свечей идеально выровнены по эпохе Unix и идут непрерывно. Это
  // расходится с реальностью минимум в двух случаях:
  //  1. Форекс/индексы: compactTimeline() умышленно пропускает выходные
  //     (см. src/data/compact-timeline.ts) — при открытии рынка после
  //     паузы реальная последняя свеча может стоять совсем не там, где
  //     её "предсказывает" непрерывная формула по wall-clock.
  //  2. Лаг/переподключение фида: пока candleLifecycle не 'live', реальная
  //     свеча не обновляется, а таймер по старой формуле продолжал бы
  //     бодро отсчитывать несуществующие циклы, создавая у пользователя
  //     ложное впечатление, что новая свеча вот-вот откроется/закроется.
  const lastCandleTime = useTickStore((s) => {
    const candles = s.candles;
    return candles.length > 0 ? candles[candles.length - 1].time : null;
  });
  const [nowMs, setNowMs] = useState(serverClock.now());

  useEffect(() => {
    return serverClock.onTick((t) => setNowMs(t));
  }, []);

  if (!symbolId) return null;

  const tfMs = TIMEFRAME_SECONDS[timeframe] * 1000;
  const tfSec = TIMEFRAME_SECONDS[timeframe];

  // Пока реальная свеча ещё не загружена (самый первый рендер до ответа
  // истории), используем ту же эпоха-выровненную оценку, что и раньше —
  // это единственный случай, когда честной альтернативы нет.
  const currentPeriodOpen = lastCandleTime ?? Math.floor(nowMs / tfMs) * tfSec;
  const currentPeriodOpenMs = currentPeriodOpen * 1000;
  const currentPeriodCloseMs = currentPeriodOpenMs + tfMs;
  const remainingMs = currentPeriodCloseMs - nowMs;
  const elapsedInCycle = Math.min(Math.max(nowMs - currentPeriodOpenMs, 0), tfMs);
  const remaining = Math.max(0, Math.min(remainingMs, tfMs));
  const isPreClose = remaining > 0 && remaining <= PRE_CLOSE_SIGNAL_LEAD_MS;
  const progress = elapsedInCycle / tfMs;

  const totalSeconds = Math.floor(remaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const display = `${minutes}:${seconds.toString().padStart(2, '0')}`;

  const isStale = !marketClosed && candleLifecycle === 'stale';

  return (
    <span className="flex items-center gap-1 rounded-md bg-base-800/60 px-2 py-1.5 sm:px-1.5 sm:py-1">
      <Timer
        size={13}
        className={clsx(
          isPreClose ? 'text-warning-400 animate-pulse' : 'text-secondary-400',
          marketClosed && 'text-accent-400',
          isStale && 'text-warning-400',
        )}
      />
      <div className="flex flex-col">
        <span className="hidden text-3xs font-medium leading-none text-base-500 sm:inline">Свеча</span>
        <span
          className={clsx(
            'font-mono text-sm font-bold leading-tight tabular-nums',
            isPreClose ? 'text-warning-400' : 'text-base-100',
            marketClosed && 'text-accent-400',
            isStale && 'text-warning-400',
          )}
        >
          {display}
        </span>
      </div>
      <span className="relative h-1.5 w-11 overflow-hidden rounded-full bg-base-800">
        <span
          className={clsx(
            'absolute left-0 top-0 h-full rounded-full transition-all duration-1000 ease-linear',
            isPreClose ? 'bg-warning-400' : 'bg-secondary-500',
            marketClosed && 'bg-accent-500',
            isStale && 'bg-warning-500',
          )}
          style={{ width: `${progress * 100}%` }}
        />
      </span>
      {marketClosed && (
        <span className="hidden items-center gap-0.5 text-3xs font-bold text-accent-400 sm:flex">
          <Moon size={10} />
          Рынок закрыт
        </span>
      )}
      {isStale && (
        <span className="hidden items-center gap-0.5 text-3xs font-bold text-warning-400 sm:flex">
          <AlertTriangle size={10} />
          Нет данных
        </span>
      )}
    </span>
  );
}

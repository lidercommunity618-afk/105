import type { Candle, ChartContext, Signal, SignalDirection } from '@/types/domain';

// Сколько свечей ПОСЛЕ сигнала сохранять в chartContext.candlesAfter. Модель
// исхода в этом приложении бинарная (resolveOutcome в outcome-scheduler.ts
// резолвит по close ПЕРВОЙ же свечи после сигнала — см. комментарий там),
// поэтому на практике candlesAfter в момент резолва почти всегда будет
// содержать 1 свечу. Кап на 15 — защита на случай, если onCandleClosed
// вызывается с более длинной историей (напр. после reconnect/resync), не
// более того.
const MAX_CONTEXT_CANDLES_AFTER = 15;

// Максимальное благоприятное/неблагоприятное движение цены относительно
// entryPrice за время, что сигнал был "в рынке" (от входа до резолва
// исхода). Для убыточной сделки MAE показывает, насколько глубоко цена
// уходила против позиции; MFE — была ли сделка близка к выигрышу перед тем,
// как развернуться. Значения — в цене инструмента (не в пипсах), всегда
// >= 0 по построению (это величина движения, а не самой цены).
export function computeExcursion(
  direction: SignalDirection,
  entryPrice: number,
  candlesAfterSignal: Candle[],
): { maxFavorableExcursion: number; maxAdverseExcursion: number } {
  if (candlesAfterSignal.length === 0) {
    return { maxFavorableExcursion: 0, maxAdverseExcursion: 0 };
  }
  let best = entryPrice;
  let worst = entryPrice;
  for (const c of candlesAfterSignal) {
    if (direction === 'buy') {
      if (c.high > best) best = c.high;
      if (c.low < worst) worst = c.low;
    } else {
      if (c.low < best) best = c.low;
      if (c.high > worst) worst = c.high;
    }
  }
  const maxFavorableExcursion = direction === 'buy' ? best - entryPrice : entryPrice - best;
  const maxAdverseExcursion = direction === 'buy' ? entryPrice - worst : worst - entryPrice;
  return { maxFavorableExcursion, maxAdverseExcursion };
}

// Собирает финальный ChartContext сигнала в момент резолва исхода —
// candlesBefore уже был захвачен раньше, в buildSignal() (см.
// signal-builder.ts CONTEXT_CANDLES_BEFORE), здесь достраивается вторая
// половина (candlesAfter + excursion), которая физически не могла быть
// известна на момент создания сигнала.
export function buildResolvedChartContext(signal: Signal, candlesAfterSignal: Candle[]): ChartContext {
  const capped = candlesAfterSignal.slice(0, MAX_CONTEXT_CANDLES_AFTER);
  const { maxFavorableExcursion, maxAdverseExcursion } = computeExcursion(signal.direction, signal.entryPrice, capped);
  return {
    candlesBefore: signal.chartContext.candlesBefore,
    candlesAfter: capped,
    maxFavorableExcursion,
    maxAdverseExcursion,
  };
}

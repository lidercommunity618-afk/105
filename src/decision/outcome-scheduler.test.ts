import { describe, it, expect } from 'vitest';
import type { Candle, Signal } from '@/types/domain';
import { OutcomeScheduler, resolveOutcome } from './outcome-scheduler';

function makeSignal(overrides: Partial<Signal> & { id: string; time: number }): Signal {
  return {
    symbolId: 'A', timeframe: '5m', direction: 'buy', strength: 'moderate',
    score: 3, calibratedProbability: null, entryPrice: 100,
    reason: 'test', indicators: {} as unknown as Signal['indicators'],
    pattern: null, outcome: 'pending', frozenAt: null, isRevised: false,
    isPreClose: false, revisionNote: null, barsToResolve: 5, spread: null,
    spreadSource: null, recommendedExpiry: 300, featureVector: [0],
    factors: [], rejectedPatterns: [], engineConfigSnapshot: {} as unknown as Signal['engineConfigSnapshot'],
    chartContext: { candlesBefore: [], candlesAfter: [], maxFavorableExcursion: null, maxAdverseExcursion: null },
    marketContext: { regime: 'range', structure: { trend: 'range', bos: false, choch: false, swingHigh: null, swingLow: null, provisional: false }, session: 'closed' },
    ...overrides,
  };
}

function candle(time: number, close: number, high: number, low: number): Candle {
  return { time, open: close, high, low, close, volume: 100 };
}

describe('OutcomeScheduler.schedule — dedup by signal.id', () => {
  it('only tracks one pending entry when schedule() is called twice for the same signal.id', () => {
    // Воспроизводит реальный сценарий: pre-close (maybeTriggerPreClose)
    // и подстраховка в maybeEvaluateSignal (isClosed === true) для одной и
    // той же свечи оба вызывают scheduler.schedule(signal) с одинаковым
    // signal.id (см. generateSignalId — id детерминирован по
    // symbolId:timeframe:candleTime).
    const scheduler = new OutcomeScheduler();
    const signal = makeSignal({ id: 'A:5m:1000', time: 1000 });
    const signalCopy = makeSignal({ id: 'A:5m:1000', time: 1000 }); // другой объект, тот же id

    scheduler.schedule(signal);
    scheduler.schedule(signalCopy);

    expect(scheduler.getPendingCount()).toBe(1);
  });

  it('does not call onResolve twice for the same signal.id once outcome is reached', () => {
    const scheduler = new OutcomeScheduler();
    const signal = makeSignal({ id: 'A:5m:1000', time: 1000, direction: 'buy', barsToResolve: 3 });
    const signalCopy = makeSignal({ id: 'A:5m:1000', time: 1000, direction: 'buy', barsToResolve: 3 });

    scheduler.schedule(signal);
    scheduler.schedule(signalCopy);

    const resolvedCalls: Array<{ signalId: string; outcome: string }> = [];
    const allCandles = [candle(1000, 100, 101, 99), candle(1300, 111, 112, 108)];

    scheduler.onCandleClosed(allCandles, (resolved) => {
      resolvedCalls.push({ signalId: resolved.signalId, outcome: resolved.outcome });
    });

    expect(resolvedCalls).toHaveLength(1);
    expect(resolvedCalls[0]).toEqual({ signalId: 'A:5m:1000', outcome: 'win' });
    expect(scheduler.getPendingCount()).toBe(0);
  });

  it('still tracks two distinct signals with different ids independently', () => {
    const scheduler = new OutcomeScheduler();
    scheduler.schedule(makeSignal({ id: 'A:5m:1000', time: 1000 }));
    scheduler.schedule(makeSignal({ id: 'A:5m:1300', time: 1300 }));

    expect(scheduler.getPendingCount()).toBe(2);
  });

  it('updates tradeOpened from false to true when schedule() is called again with the same id', () => {
    // Воспроизводит баг расхождения "Последние сделки" vs "История сигналов":
    // pre-close кладёт сигнал с tradeOpened: false (сделка не открылась из-за
    // guard'а "одна сделка на инструмент"), затем при реальном закрытии
    // свечи maybeEvaluateSignal открывает сделку и вызывает schedule() с
    // tradeOpened: true. Без обновления в очереди остаётся устаревший false,
    // и maybeResolveOutcomes позже перезапишет корректный исход от
    // useDemoAccountStore своим собственным (неправильным).
    const scheduler = new OutcomeScheduler();
    const signalNotTraded = makeSignal({ id: 'A:5m:1000', time: 1000, tradeOpened: false });
    const signalTraded = makeSignal({ id: 'A:5m:1000', time: 1000, tradeOpened: true });

    scheduler.schedule(signalNotTraded);
    scheduler.schedule(signalTraded);

    expect(scheduler.getPendingCount()).toBe(1);
    const pending = scheduler.getPendingList();
    expect(pending[0].signal.tradeOpened).toBe(true);
  });
});

// Аудит (синхронизация с демо-счётом): resolveOutcome раньше проверял
// касание стопа/цели в течение barsToResolve будущих свечей. Теперь исход
// зависит ИСКЛЮЧИТЕЛЬНО от close свечи на expiryBars vs entryPrice — ровно
// как реальная демо-сделка (resolveTrade). BUGFIX (Фаза 1, "честный
// бинарный опцион"): signal.stopLoss/signal.takeProfit удалены из Signal
// целиком (не просто "не читаются" здесь) — бинарный опцион с
// фиксированной экспирацией/выплатой не имеет структурного стопа/цели.
describe('resolveOutcome — только close на expiryBars vs entryPrice, без стопа/цели', () => {
  it('returns "win" for a buy whose expiry candle closes above entry, even though low dipped well below entry intrabar', () => {
    const signal = makeSignal({
      id: 'A:5m:1000', time: 1000, direction: 'buy',
      entryPrice: 100, barsToResolve: 5,
    });
    // Low (94) dips well below entry intrabar, but the CLOSE (101) is still
    // above entry — a hypothetical structural-stop model would have called
    // this a 'loss' (stop touched); the actual binary-option resolution
    // must call it a 'win' (only the close at expiry matters).
    const candlesAfter = [candle(1300, 101, 102, 94)];

    const resolved = resolveOutcome(signal, candlesAfter);

    expect(resolved).toEqual({ signalId: 'A:5m:1000', outcome: 'win' });
  });

  it('returns "win" for a buy even when the close is only marginally above entry', () => {
    const signal = makeSignal({
      id: 'A:5m:1000', time: 1000, direction: 'buy',
      entryPrice: 100, barsToResolve: 5,
    });
    // Close (100.5) is only marginally above entry — a hypothetical
    // structural-target model would still be "waiting" for a bigger move;
    // the actual binary-option resolution resolves immediately as 'win'.
    const candlesAfter = [candle(1300, 100.5, 100.6, 100.2)];

    const resolved = resolveOutcome(signal, candlesAfter);

    expect(resolved).toEqual({ signalId: 'A:5m:1000', outcome: 'win' });
  });

  it('resolves using the FIRST candle after the signal when expiryBars is undefined/1, regardless of barsToResolve', () => {
    const signal = makeSignal({
      id: 'A:5m:1000', time: 1000, direction: 'buy',
      entryPrice: 100, barsToResolve: 5,
    });
    // First candle after the signal closes below entry (loss). A later
    // candle closes far above entry — the outcome must still be locked in
    // from the very first (expiryBars=1, default when undefined) candle.
    const candlesAfter = [
      candle(1300, 98, 99, 97),
      candle(1600, 120, 121, 119),
    ];

    const resolved = resolveOutcome(signal, candlesAfter);

    expect(resolved).toEqual({ signalId: 'A:5m:1000', outcome: 'loss' });
  });

  // BUGFIX (Фаза 0, "экспирация на карточке не совпадает с фактическим
  // резолвом"): это и есть сам баг — раньше resolveOutcome всегда читал
  // candlesAfterSignal[0], игнорируя expiryBars целиком.
  it('resolves using the expiryBars-th candle, not always the first, when expiryBars > 1', () => {
    const signal = makeSignal({
      id: 'A:5m:1000', time: 1000, direction: 'buy',
      entryPrice: 100, expiryBars: 2,
    });
    // First candle after signal closes below entry (would be 'loss' if the
    // old always-bar-1 bug were still present); the SECOND candle (the
    // actual expiryBars=2 target) closes above entry — must be 'win'.
    const candlesAfter = [
      candle(1300, 98, 99, 97),
      candle(1600, 105, 106, 104),
    ];

    const resolved = resolveOutcome(signal, candlesAfter);

    expect(resolved).toEqual({ signalId: 'A:5m:1000', outcome: 'win' });
  });

  it('returns null when fewer candles are available than expiryBars requires', () => {
    const signal = makeSignal({
      id: 'A:5m:1000', time: 1000, direction: 'buy',
      entryPrice: 100, expiryBars: 3,
    });
    const candlesAfter = [candle(1300, 98, 99, 97), candle(1600, 99, 100, 98)];

    expect(resolveOutcome(signal, candlesAfter)).toBeNull();
  });

  it('returns "loss" for a sell whose expiry candle closes above entry', () => {
    const signal = makeSignal({
      id: 'A:5m:1000', time: 1000, direction: 'sell',
      entryPrice: 100, barsToResolve: 5,
    });
    const candlesAfter = [candle(1300, 101, 102, 100.5)];

    const resolved = resolveOutcome(signal, candlesAfter);

    expect(resolved).toEqual({ signalId: 'A:5m:1000', outcome: 'loss' });
  });

  it('returns "timeout" on an exact tie (close === entryPrice)', () => {
    const signal = makeSignal({
      id: 'A:5m:1000', time: 1000, direction: 'buy',
      entryPrice: 100, barsToResolve: 5,
    });
    const candlesAfter = [candle(1300, 100, 100.5, 99.5)];

    const resolved = resolveOutcome(signal, candlesAfter);

    expect(resolved).toEqual({ signalId: 'A:5m:1000', outcome: 'timeout' });
  });

  it('returns null when the signal is not pending (already resolved)', () => {
    const signal = makeSignal({ id: 'A:5m:1000', time: 1000, outcome: 'win' });
    const candlesAfter = [candle(1300, 101, 102, 99)];

    expect(resolveOutcome(signal, candlesAfter)).toBeNull();
  });

  it('returns null when there are no candles after the signal yet', () => {
    const signal = makeSignal({ id: 'A:5m:1000', time: 1000 });

    expect(resolveOutcome(signal, [])).toBeNull();
  });
});

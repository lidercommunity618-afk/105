import { describe, it, expect } from 'vitest';
import { isSuppressedByCooldown, pruneResolvedSignals, type RecentSignalRecord } from './signal-cooldown';

describe('isSuppressedByCooldown', () => {
  it('reproduces the audited incident: 3rd BUY at almost the same price 2 minutes later is suppressed', () => {
    // Реальные цифры из аудита: BUY 79664.47 @08:20 (expiry 3m => resolves ~08:23),
    // затем BUY 79664.47 @08:21, затем BUY 79663.19 @08:22 — все в одну и ту же
    // зону, пока первый сигнал ещё не резолвился.
    const recent: RecentSignalRecord[] = [
      { direction: 'buy', entryPrice: 79664.47, candleTime: 1200, resolvesAtTime: 1200 + 180 },
    ];
    const suppressed = isSuppressedByCooldown({
      recent,
      direction: 'buy',
      entryPrice: 79663.19,
      candleTime: 1200 + 120, // 08:22, ещё до 08:23
      atrValue: 15.2,
    });
    expect(suppressed).toBe(true);
  });

  it('does not suppress once the previous signal has already resolved', () => {
    const recent: RecentSignalRecord[] = [
      { direction: 'buy', entryPrice: 79664.47, candleTime: 1200, resolvesAtTime: 1200 + 180 },
    ];
    const suppressed = isSuppressedByCooldown({
      recent,
      direction: 'buy',
      entryPrice: 79663.19,
      candleTime: 1200 + 180, // ровно момент резолва — новый сигнал уже разрешён
      atrValue: 15.2,
    });
    expect(suppressed).toBe(false);
  });

  it('does not suppress the opposite direction in the same zone', () => {
    const recent: RecentSignalRecord[] = [
      { direction: 'buy', entryPrice: 79664.47, candleTime: 1200, resolvesAtTime: 1200 + 180 },
    ];
    const suppressed = isSuppressedByCooldown({
      recent,
      direction: 'sell',
      entryPrice: 79663.19,
      candleTime: 1200 + 60,
      atrValue: 15.2,
    });
    expect(suppressed).toBe(false);
  });

  it('does not suppress the same direction far outside the ATR-sized zone', () => {
    const recent: RecentSignalRecord[] = [
      { direction: 'buy', entryPrice: 79664.47, candleTime: 1200, resolvesAtTime: 1200 + 180 },
    ];
    const suppressed = isSuppressedByCooldown({
      recent,
      direction: 'buy',
      entryPrice: 79800, // далеко за пределами 2*ATR
      candleTime: 1200 + 60,
      atrValue: 15.2,
    });
    expect(suppressed).toBe(false);
  });

  it('is a no-op when ATR is unavailable', () => {
    const recent: RecentSignalRecord[] = [
      { direction: 'buy', entryPrice: 100, candleTime: 0, resolvesAtTime: 180 },
    ];
    expect(isSuppressedByCooldown({ recent, direction: 'buy', entryPrice: 100, candleTime: 60, atrValue: null })).toBe(false);
  });
});

describe('pruneResolvedSignals', () => {
  it('drops records whose resolve window has passed', () => {
    const recent: RecentSignalRecord[] = [
      { direction: 'buy', entryPrice: 100, candleTime: 0, resolvesAtTime: 180 },
      { direction: 'sell', entryPrice: 200, candleTime: 0, resolvesAtTime: 600 },
    ];
    const pruned = pruneResolvedSignals(recent, 200);
    expect(pruned).toHaveLength(1);
    expect(pruned[0].entryPrice).toBe(200);
  });
});

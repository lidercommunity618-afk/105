import { describe, it, expect } from 'vitest';
import { avgRangeFromSnapshot, fallbackAtr } from './atr-fallback';
import { recommendedExpiry } from './recommended-expiry';
import { estimateSpread } from './spread-estimate';
import type { IndicatorSnapshot, Tick } from '@/types/domain';

// BUGFIX (Фаза 1, "честный бинарный опцион"): describe('computeTradeLevels')
// удалён вместе с decision/trade-levels.ts — структурные SL/TP не
// существуют для бинарного опциона с фиксированной экспирацией/выплатой.
// avgRangeFromSnapshot/fallbackAtr не имели отношения к SL/TP (чистый
// ATR-фолбэк для расчёта волатильности) — перенесены в atr-fallback.ts,
// тесты ниже без изменений.

describe('avgRangeFromSnapshot', () => {
  it('computes average high-low range', () => {
    const candles = [
      { high: 12, low: 8 },
      { high: 14, low: 10 },
      { high: 11, low: 9 },
    ];
    expect(avgRangeFromSnapshot(candles, 3)).toBeCloseTo((4 + 4 + 2) / 3, 5);
  });

  it('returns 0 for empty array', () => {
    expect(avgRangeFromSnapshot([], 5)).toBe(0);
  });
});

describe('fallbackAtr', () => {
  it('uses snapshot ATR when available', () => {
    const snap = { atr: 3.5 } as IndicatorSnapshot;
    expect(fallbackAtr(snap, [], 14)).toBe(3.5);
  });

  it('falls back to avgRange when ATR is null', () => {
    const snap = { atr: null } as IndicatorSnapshot;
    const candles = [
      { high: 12, low: 8 },
      { high: 14, low: 10 },
    ];
    expect(fallbackAtr(snap, candles, 2)).toBeCloseTo(4, 5);
  });
});

describe('recommendedExpiry', () => {
  it('returns at least 1 timeframe for low volatility', () => {
    const expiry = recommendedExpiry('15m', 0.001, 100);
    expect(expiry).toBeGreaterThanOrEqual(900);
  });

  it('returns more bars for lower volatility', () => {
    const lowVol = recommendedExpiry('15m', 0.001, 100);
    const highVol = recommendedExpiry('15m', 2, 100);
    expect(lowVol).toBeGreaterThan(highVol);
  });
});

describe('estimateSpread', () => {
  it('uses live bid/ask when available', () => {
    const tick: Tick = { price: 100, time: 0, bid: 99.98, ask: 100.02 };
    const result = estimateSpread('BTCUSDT', tick);
    expect(result.source).toBe('live');
    expect(result.spread).toBeCloseTo(0.04, 5);
  });

  it('falls back to static estimate when no bid/ask', () => {
    const result = estimateSpread('BTCUSDT', null);
    expect(result.source).toBe('estimated');
    expect(result.spread).toBe(0.5);
  });

  it('falls back to 0 for unknown symbol', () => {
    const result = estimateSpread('UNKNOWN', null);
    expect(result.source).toBe('estimated');
    expect(result.spread).toBe(0);
  });

  it('uses estimated when bid/ask missing from tick', () => {
    const tick: Tick = { price: 100, time: 0 };
    const result = estimateSpread('EURUSD', tick);
    expect(result.source).toBe('estimated');
  });
});

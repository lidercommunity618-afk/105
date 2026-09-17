import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { computeDirectionScore, isPatternInRange } from '@/decision/direction-prediction';
import {
  applyReliabilityMultiplierUpdatesForSymbol,
  resetReliabilityOverridesForSymbol,
} from '@/lib/pattern-categories';
import type { Candle, IndicatorSnapshot, MarketStructure, Snapshot, PatternResult } from '@/types/domain';

function makeCandles(count: number, trend: 'up' | 'down' | 'flat' = 'up'): Candle[] {
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const open = price;
    const change = trend === 'up' ? 0.5 : trend === 'down' ? -0.5 : 0;
    const close = open + change;
    const high = Math.max(open, close) + 0.2;
    const low = Math.min(open, close) - 0.2;
    candles.push({ time: 1700000000 + i * 60, open, high, low, close, volume: 1000 });
    price = close;
  }
  return candles;
}

function snapshotWith(overrides: Partial<Snapshot> = {}): Snapshot {
  const indicators: IndicatorSnapshot = {
    rsi: null, emaFast: null, emaSlow: null, macd: null, macdSignal: null,
    macdHistogram: null, atr: 2, bollingerUpper: null, bollingerMiddle: null,
    bollingerLower: null, vwap: null, vwapIsProxyVolume: false, volumeProfilePoc: null,
    volumeProfilePocIsProxyVolume: false, meanReversionRsi: null, impulseVelocity: null, adx: null,
  };
  const structure: MarketStructure = {
    trend: 'range', bos: false, choch: false, swingHigh: null, swingLow: null, provisional: false,
  };
  return {
    indicators, structure, patterns: [], regime: 'range',
    lastPrice: null, candleTime: null, ...overrides,
  };
}

describe('computeDirectionScore — sell direction', () => {
  it('returns sell for downtrend with bearish structure', () => {
    const snapshot = snapshotWith({
      structure: { trend: 'down', bos: true, choch: false, swingHigh: 110, swingLow: 90, provisional: false },
    });
    const result = computeDirectionScore(makeCandles(60, 'down'), snapshot);
    expect(result.direction).toBe('sell');
    expect(result.score).toBeGreaterThan(0);
    expect(result.components.structure).toBe(0);
    expect(result.components.bos).toBeLessThan(0);
  });

  it('sell reasons contain bearish structure entries', () => {
    const snapshot = snapshotWith({
      structure: { trend: 'down', bos: true, choch: false, swingHigh: 110, swingLow: 90, provisional: false },
    });
    const result = computeDirectionScore(makeCandles(60, 'down'), snapshot);
    expect(result.reasons.some((r) => r.includes('bearish'))).toBe(true);
  });
});

describe('computeDirectionScore — CHoCH', () => {
  it('CHoCH bullish adds positive structure component', () => {
    const snapshot = snapshotWith({
      structure: { trend: 'up', bos: false, choch: true, swingHigh: 110, swingLow: 95, provisional: false },
    });
    const result = computeDirectionScore(makeCandles(60, 'up'), snapshot);
    expect(result.components.structure).toBe(0.5);
  });

  it('CHoCH bearish adds negative structure component', () => {
    const snapshot = snapshotWith({
      structure: { trend: 'down', bos: false, choch: true, swingHigh: 110, swingLow: 95, provisional: false },
    });
    const result = computeDirectionScore(makeCandles(60, 'down'), snapshot);
    expect(result.components.structure).toBe(-0.5);
  });
});

describe('computeDirectionScore — indicators', () => {
  it('EMA fast above slow adds positive indicator component', () => {
    const snapshot = snapshotWith({
      indicators: { ...snapshotWith().indicators, emaFast: 102, emaSlow: 100 },
    });
    const result = computeDirectionScore(makeCandles(60, 'up'), snapshot);
    expect(result.components.indicator).toBeGreaterThan(0);
  });

  it('EMA fast below slow adds negative indicator component', () => {
    const snapshot = snapshotWith({
      indicators: { ...snapshotWith().indicators, emaFast: 98, emaSlow: 100 },
    });
    const result = computeDirectionScore(makeCandles(60, 'down'), snapshot);
    expect(result.components.indicator).toBeLessThan(0);
  });

  // BUGFIX (факторный анализ): RSI oversold/overbought — 25% винрейт, N=10 —
  // contribution обнулена, но факт по-прежнему логируется в factors для
  // постмортема (см. изменение 4 фикс-промпта).
  it('RSI oversold no longer contributes to indicator component, but is still logged as a factor', () => {
    // emaFast/emaSlow (same 'buy' direction as the RSI oversold signal) is
    // needed so the overall score is non-zero and a direction is picked —
    // otherwise, with RSI's contribution now zeroed, this snapshot alone
    // would score exactly 0 and `factors` would be empty (direction: null).
    const snapshot = snapshotWith({
      indicators: { ...snapshotWith().indicators, rsi: 25, emaFast: 102, emaSlow: 100 },
    });
    const result = computeDirectionScore(makeCandles(60, 'up'), snapshot);
    expect(result.direction).toBe('buy');
    const rsiFactor = result.factors.find((f) => f.name === 'rsi');
    expect(rsiFactor).toBeDefined();
    expect(rsiFactor?.contribution).toBe(0);
  });

  it('RSI overbought no longer contributes to indicator component, but is still logged as a factor', () => {
    const snapshot = snapshotWith({
      indicators: { ...snapshotWith().indicators, rsi: 75, emaFast: 98, emaSlow: 100 },
    });
    const result = computeDirectionScore(makeCandles(60, 'down'), snapshot);
    expect(result.direction).toBe('sell');
    const rsiFactor = result.factors.find((f) => f.name === 'rsi');
    expect(rsiFactor).toBeDefined();
    expect(rsiFactor?.contribution).toBe(0);
  });

  it('indicator component is clamped to [-1, 1]', () => {
    const snapshot = snapshotWith({
      indicators: { ...snapshotWith().indicators, emaFast: 200, emaSlow: 100, rsi: 20 },
    });
    const result = computeDirectionScore(makeCandles(60, 'up'), snapshot);
    expect(result.components.indicator).toBeLessThanOrEqual(1);
    expect(result.components.indicator).toBeGreaterThanOrEqual(-1);
  });
});

describe('computeDirectionScore — MACD', () => {
  it('positive MACD histogram adds positive macd component', () => {
    const snapshot = snapshotWith({
      indicators: { ...snapshotWith().indicators, macdHistogram: 0.5 },
    });
    const result = computeDirectionScore(makeCandles(60, 'up'), snapshot);
    expect(result.components.macd).toBeGreaterThan(0);
  });

  it('negative MACD histogram adds negative macd component', () => {
    const snapshot = snapshotWith({
      indicators: { ...snapshotWith().indicators, macdHistogram: -0.5 },
    });
    const result = computeDirectionScore(makeCandles(60, 'down'), snapshot);
    expect(result.components.macd).toBeLessThan(0);
  });
});

describe('computeDirectionScore — mean reversion', () => {
  // BUGFIX (факторный анализ): bollinger touch — 0% винрейт, N=8 — contribution
  // обнулена (components.meanReversion stays 0), but the touch is still
  // logged in factors for postmortem review (см. изменение 3 фикс-промпта).
  // emaFast/emaSlow gives the snapshot a non-zero score so a direction is
  // actually picked and the bollinger factor ends up in the returned array.
  it('price at lower Bollinger band no longer contributes to meanReversion, but is still logged as a factor', () => {
    const candles = makeCandles(60, 'flat');
    const last = candles[candles.length - 1];
    const snapshot = snapshotWith({
      indicators: {
        ...snapshotWith().indicators,
        bollingerLower: last.close,
        bollingerMiddle: last.close + 5,
        bollingerUpper: last.close + 10,
        emaFast: 102,
        emaSlow: 100,
      },
    });
    const result = computeDirectionScore(candles, snapshot);
    expect(result.components.meanReversion).toBe(0);
    expect(result.direction).toBe('buy');
    const bollingerFactor = result.factors.find((f) => f.name === 'bollinger');
    expect(bollingerFactor).toBeDefined();
    expect(bollingerFactor?.contribution).toBe(0);
  });

  it('price at upper Bollinger band no longer contributes to meanReversion, but is still logged as a factor', () => {
    const candles = makeCandles(60, 'flat');
    const last = candles[candles.length - 1];
    const snapshot = snapshotWith({
      indicators: {
        ...snapshotWith().indicators,
        bollingerLower: last.close - 10,
        bollingerMiddle: last.close - 5,
        bollingerUpper: last.close,
        emaFast: 98,
        emaSlow: 100,
      },
    });
    const result = computeDirectionScore(candles, snapshot);
    expect(result.components.meanReversion).toBe(0);
    expect(result.direction).toBe('sell');
    const bollingerFactor = result.factors.find((f) => f.name === 'bollinger');
    expect(bollingerFactor).toBeDefined();
    expect(bollingerFactor?.contribution).toBe(0);
  });
});

describe('computeDirectionScore — trigger (patterns)', () => {
  it('bullish pattern adds positive trigger component', () => {
    const pattern: PatternResult = {
      name: 'hammer', direction: 'buy', confidence: 0.8, strength: 'strong', time: 1700000000,
    };
    const snapshot = snapshotWith({ patterns: [pattern] });
    const result = computeDirectionScore(makeCandles(60, 'up'), snapshot);
    expect(result.components.trigger).toBe(0.8);
  });

  it('bearish pattern adds negative trigger component', () => {
    const pattern: PatternResult = {
      name: 'shooting-star', direction: 'sell', confidence: 0.7, strength: 'strong', time: 1700000000,
    };
    const snapshot = snapshotWith({ patterns: [pattern] });
    const result = computeDirectionScore(makeCandles(60, 'down'), snapshot);
    expect(result.components.trigger).toBe(-0.7);
  });

  // BUGFIX (факторный анализ): inside-bar — 27% винрейт, N=19 — reliability
  // multiplier 0.1 почти обнуляет его вклад в trigger (но не убирает
  // детекцию/факт из factors — полезно для постмортема).
  it('inside-bar as top pattern contributes near zero to trigger, but the pattern still appears in factors', () => {
    const pattern: PatternResult = {
      name: 'inside-bar', direction: 'buy', confidence: 0.8, strength: 'strong', time: 1700000000,
    };
    const snapshot = snapshotWith({ patterns: [pattern] });
    const result = computeDirectionScore(makeCandles(60, 'up'), snapshot);
    expect(result.components.trigger).toBeCloseTo(0.08, 5); // 0.8 confidence * 0.1 multiplier
    const insideBarFactor = result.factors.find((f) => f.name === 'inside-bar');
    expect(insideBarFactor).toBeDefined();
  });
});

// FIX (аудит калибровки Этапа 2, п.4 — "PATTERN_RELIABILITY_MULTIPLIER
// остался глобальным, не per-symbol"): калибровка одного инструмента
// (например BTCUSDT) не должна изменять trigger-вклад для того же паттерна
// на другом инструменте (например EURUSD), если symbolId передан.
describe('computeDirectionScore — per-symbol reliability multiplier', () => {
  beforeEach(() => {
    resetReliabilityOverridesForSymbol('BTCUSDT');
    resetReliabilityOverridesForSymbol('EURUSD');
  });

  afterEach(() => {
    resetReliabilityOverridesForSymbol('BTCUSDT');
    resetReliabilityOverridesForSymbol('EURUSD');
  });

  it('applies a per-symbol override only to the symbolId it was calibrated for', () => {
    const pattern: PatternResult = {
      name: 'hammer', direction: 'buy', confidence: 0.8, strength: 'strong', time: 1700000000,
    };
    const snapshot = snapshotWith({ patterns: [pattern] });
    const candles = makeCandles(60, 'up');

    // Calibrate 'hammer' to 1.5x on BTCUSDT only.
    applyReliabilityMultiplierUpdatesForSymbol('BTCUSDT', { hammer: 1.5 });

    const btcResult = computeDirectionScore(candles, snapshot, undefined, [], 14, 70, 30, 'BTCUSDT');
    expect(btcResult.components.trigger).toBeCloseTo(0.8 * 1.5, 5);

    // EURUSD must be unaffected by BTCUSDT's calibration.
    const eurResult = computeDirectionScore(candles, snapshot, undefined, [], 14, 70, 30, 'EURUSD');
    expect(eurResult.components.trigger).toBe(0.8);

    // Calling without a symbolId at all (existing callers/tests) must also
    // be unaffected — falls back to the global default (unset here = 1).
    const noSymbolResult = computeDirectionScore(candles, snapshot);
    expect(noSymbolResult.components.trigger).toBe(0.8);
  });
});

describe('computeDirectionScore — conflicting components', () => {
  it('bullish structure but bearish indicators produces a valid direction', () => {
    const snapshot = snapshotWith({
      structure: { trend: 'up', bos: true, choch: false, swingHigh: 110, swingLow: 95, provisional: false },
      indicators: { ...snapshotWith().indicators, emaFast: 98, emaSlow: 100, rsi: 75 },
    });
    const result = computeDirectionScore(makeCandles(60, 'up'), snapshot);
    expect(['buy', 'sell']).toContain(result.direction);
  });
});

describe('computeDirectionScore — flat market', () => {
  it('returns a valid direction, or null when there is no evidence either way', () => {
    const snapshot = snapshotWith();
    const result = computeDirectionScore(makeCandles(60, 'flat'), snapshot);
    expect([...['buy', 'sell'], null]).toContain(result.direction);
  });

  it('flat market with no signals produces a valid direction, or null when there is no evidence either way', () => {
    const snapshot = snapshotWith();
    const result = computeDirectionScore(makeCandles(60, 'flat'), snapshot);
    expect([...['buy', 'sell'], null]).toContain(result.direction);
  });
});

describe('computeDirectionScore — exact tie', () => {
  it('returns direction: null (not a silent "buy") when the weighted score is exactly zero', () => {
    // No structure, no patterns, no indicators — every component stays 0,
    // so the weighted sum is exactly 0.
    const snapshot = snapshotWith({
      structure: { trend: 'range', bos: false, choch: false, swingHigh: 100, swingLow: 100, provisional: false },
      indicators: { ...snapshotWith().indicators, emaFast: null, emaSlow: null, rsi: null, macdHistogram: null, bollingerLower: null, bollingerUpper: null, bollingerMiddle: null },
      patterns: [],
    });
    const result = computeDirectionScore(makeCandles(60, 'flat'), snapshot);
    expect(result.direction).toBeNull();
    expect(result.score).toBe(0);
    expect(result.reasons).toEqual([]);
  });
});

describe('isPatternInRange', () => {
  it('returns true when price is far from S/R and OB zones', () => {
    const candles: Candle[] = [];
    let price = 100;
    for (let i = 0; i < 60; i++) {
      const open = price;
      const close = open + 0.8;
      candles.push({
        time: 1700000000 + i * 60,
        open, high: close + 0.2, low: open - 0.2, close, volume: 1000,
      });
      price = close;
    }
    const snapshot = snapshotWith();
    const result = isPatternInRange(candles, snapshot);
    expect(result).toBe(true);
  });

  it('returns false for insufficient ATR', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 5; i++) {
      candles.push({ time: i * 60, open: 100, high: 100, low: 100, close: 100, volume: 0 });
    }
    const snapshot = snapshotWith({ indicators: { ...snapshotWith().indicators, atr: null } });
    const result = isPatternInRange(candles, snapshot);
    expect(result).toBe(false);
  });
});

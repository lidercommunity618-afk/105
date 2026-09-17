import { describe, it, expect } from 'vitest';
import { applySignalFilters, CONTEXT_PENALTY, CONFIRMATION_BONUS } from './signal-filters';
import type { Candle, IndicatorSnapshot, MarketStructure, PatternResult, Snapshot } from '@/types/domain';
import { DEFAULT_SIGNAL_TOGGLES } from '@/types/domain';

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  const indicators: IndicatorSnapshot = {
    rsi: 50, emaFast: 100, emaSlow: 98, macd: 0.5, macdSignal: 0.3, macdHistogram: 0.2,
    atr: 2, bollingerUpper: 105, bollingerMiddle: 100, bollingerLower: 95,
    vwap: 100, vwapIsProxyVolume: false, volumeProfilePoc: 100, volumeProfilePocIsProxyVolume: false,
    meanReversionRsi: 50, impulseVelocity: 0, adx: null,
  };
  const structure: MarketStructure = {
    trend: 'up', bos: false, choch: false, swingHigh: 105, swingLow: 95, provisional: false,
  };
  return {
    indicators,
    patterns: [],
    structure,
    regime: 'trend',
    lastPrice: 100,
    candleTime: 1000,
    ...overrides,
  };
}

function makeCandle(time: number, open: number, high: number, low: number, close: number, volume = 100): Candle {
  return { time, open, high, low, close, volume };
}

function uptrendCandles(n: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const base = 100 + i * 2;
    out.push(makeCandle(i * 60, base - 1, base + 2, base - 2, base + 1));
  }
  return out;
}

function downtrendCandles(n: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const base = 200 - i * 2;
    out.push(makeCandle(i * 60, base + 1, base + 2, base - 2, base - 1));
  }
  return out;
}

describe('applySignalFilters', () => {
  it('returns neutral multiplier when no patterns and no confirmations', () => {
    const candles = uptrendCandles(30);
    const snapshot = makeSnapshot({ patterns: [] });
    const result = applySignalFilters(candles, snapshot, 'buy', 0.5);
    expect(result.invalidated).toBe(false);
    expect(result.confirmed).toBe(false);
    expect(result.scoreMultiplier).toBe(1);
    expect(result.reasons).toHaveLength(0);
  });

  it('applies context penalty when pattern is in range with no S/R/OB context', () => {
    const candles = uptrendCandles(30);
    const pattern: PatternResult = {
      name: 'hammer', direction: 'buy', confidence: 0.7, strength: 'moderate', time: 1000,
    };
    const snapshot = makeSnapshot({
      patterns: [pattern],
      structure: { trend: 'range', bos: false, choch: false, swingHigh: null, swingLow: null, provisional: false },
    });
    const result = applySignalFilters(candles, snapshot, 'buy', 0.7);
    expect(result.scoreMultiplier).toBe(CONTEXT_PENALTY);
    expect(result.reasons).toContainEqual(expect.stringContaining('score reduced'));
  });

  it('confirms signal with untouched bullish OB nearby for buy direction', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 30; i++) {
      const base = 100 + i * 2;
      if (i === 25) {
        candles.push(makeCandle(i * 60, base + 3, base + 5, base - 2, base - 1));
      } else if (i === 26) {
        candles.push(makeCandle(i * 60, base - 1, base + 4, base - 2, base + 3));
      } else {
        candles.push(makeCandle(i * 60, base - 1, base + 2, base - 2, base + 1));
      }
    }
    const snapshot = makeSnapshot({ patterns: [] });
    const result = applySignalFilters(candles, snapshot, 'buy', 0.6);
    expect(result.scoreMultiplier).toBeGreaterThanOrEqual(1);
  });

  it('confirms signal with untouched bearish OB nearby for sell direction', () => {
    const candles = downtrendCandles(30);
    const snapshot = makeSnapshot({ patterns: [] });
    const result = applySignalFilters(candles, snapshot, 'sell', 0.6);
    expect(result.scoreMultiplier).toBeGreaterThanOrEqual(1);
  });

  it('invalidates buy signal when price closes below prior candle low', () => {
    const candles = uptrendCandles(30);
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    candles[candles.length - 1] = makeCandle(last.time, last.open, last.high, last.low, prev.low - 10);
    const snapshot = makeSnapshot({ patterns: [] });
    const result = applySignalFilters(candles, snapshot, 'buy', 0.6);
    expect(result.invalidated).toBe(true);
    expect(result.scoreMultiplier).toBe(0);
    expect(result.reasons).toContainEqual(expect.stringContaining('invalidated'));
  });

  it('invalidates sell signal when price closes above prior candle high', () => {
    const candles = downtrendCandles(30);
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    candles[candles.length - 1] = makeCandle(last.time, last.open, last.high, last.low, prev.high + 10);
    const snapshot = makeSnapshot({ patterns: [] });
    const result = applySignalFilters(candles, snapshot, 'sell', 0.6);
    expect(result.invalidated).toBe(true);
    expect(result.scoreMultiplier).toBe(0);
  });

  it('does not invalidate buy signal when close is within ATR buffer of prior low', () => {
    const candles = uptrendCandles(30);
    const prev = candles[candles.length - 2];
    const last = candles[candles.length - 1];
    candles[candles.length - 1] = makeCandle(last.time, last.open, last.high, last.low, prev.low - 0.01);
    const snapshot = makeSnapshot({ patterns: [] });
    const result = applySignalFilters(candles, snapshot, 'buy', 0.6);
    expect(result.invalidated).toBe(false);
  });

  it('does not apply context penalty when no patterns detected', () => {
    const candles = uptrendCandles(30);
    const snapshot = makeSnapshot({
      patterns: [],
      structure: { trend: 'range', bos: false, choch: false, swingHigh: null, swingLow: null, provisional: false },
    });
    const result = applySignalFilters(candles, snapshot, 'buy', 0.5);
    expect(result.scoreMultiplier).toBe(1);
  });

  // BUGFIX (повторный аудит): этот filter-level FVG-бонус НЕ является тем же
  // фактором, что "liquidity-pools: 49% винрейт, N=58" в факторной таблице
  // (тот фактор — components.liquidity в direction-prediction.ts, см.
  // 'liquidity-fvg'/'liquidity-pool' там же). Этот бонус публикуется как
  // kind:'filter'/name:'signal-filter' — измеренный винрейт 55%/92, хороший
  // фактор — поэтому он восстановлен и снова усиливает score.
  it('strengthens the score for an untouched same-direction FVG', () => {
    const candles: Candle[] = [];
    // Tight-range baseline so the ATR used for the displacement check stays
    // small relative to the impulse candle below.
    for (let i = 0; i < 20; i++) {
      candles.push(makeCandle(i * 60, 100, 100.5, 99.5, 100));
    }
    // 3-candle bullish FVG: right.low (111) > left.high (101), with a large
    // displacement body on the middle candle — clears MIN_DISPLACEMENT_ATR_MULTIPLE.
    candles.push(makeCandle(20 * 60, 100, 101, 99.5, 100.5)); // left
    candles.push(makeCandle(21 * 60, 100.5, 110.5, 100.3, 110)); // mid (impulse)
    candles.push(makeCandle(22 * 60, 111, 115, 111, 114)); // right (gap: low 111 > left.high 101)

    const toggles = {
      ...DEFAULT_SIGNAL_TOGGLES,
      obConfirmation: false,
      bosConfirmation: false,
      chochWarning: false,
      regimeGate: false,
      contextPenalty: false,
      invalidation: false,
    };
    const snapshot = makeSnapshot({ patterns: [] });
    const result = applySignalFilters(candles, snapshot, 'buy', 0.6, toggles, ['order-block-strength']);
    expect(result.scoreMultiplier).toBeCloseTo(1 + CONFIRMATION_BONUS * 0.8, 5);
    expect(result.confirmed).toBe(true);
    expect(result.reasons).toContainEqual(expect.stringContaining('Untouched FVG nearby'));
  });
});

describe('applySignalFilters — regime/ADX gate (BUGFIX аудит 2026-09-05)', () => {
  // Регрессионный тест на реальный инцидент: 3 из 6 убыточных сделок были
  // сгенерированы при regime='range' с ADX 27.4 / 26.0 / 25.3 — первая
  // версия гейта (порог 25) их бы пропустила молча. Порог поднят до 30
  // именно для того, чтобы это не повторилось.
  function rangeSnapshotWithAdx(adx: number | null): Snapshot {
    return makeSnapshot({
      regime: 'range',
      patterns: [],
      indicators: {
        rsi: 50, emaFast: 100, emaSlow: 98, macd: 0.5, macdSignal: 0.3, macdHistogram: 0.2,
        atr: 2, bollingerUpper: 105, bollingerMiddle: 100, bollingerLower: 95,
        vwap: 100, vwapIsProxyVolume: false, volumeProfilePoc: 100, volumeProfilePocIsProxyVolume: false,
        meanReversionRsi: 50, impulseVelocity: 0, adx,
      },
    });
  }

  it('reduces score when regime=range and ADX is below the threshold (reproduces the audited 08:20-08:22 trades)', () => {
    const candles = uptrendCandles(30);
    for (const adx of [27.4, 26.0, 25.3]) {
      const result = applySignalFilters(candles, rangeSnapshotWithAdx(adx), 'buy', 0.5);
      expect(result.scoreMultiplier).toBeLessThan(1);
      expect(result.reasons.some((r) => r.includes('weak/fading trend'))).toBe(true);
    }
  });

  it('does not gate when regime=range but ADX is at/above the threshold (real trend, not chop)', () => {
    const candles = uptrendCandles(30);
    const result = applySignalFilters(candles, rangeSnapshotWithAdx(35), 'buy', 0.5);
    expect(result.scoreMultiplier).toBe(1);
  });

  it('gates high-volatility regime the same way as range when ADX shows no coherent trend (audit 2026-09-13: this regime previously had no deterministic gate at all)', () => {
    const candles = uptrendCandles(30);
    const snapshot = makeSnapshot({
      regime: 'high-volatility',
      patterns: [],
      indicators: {
        rsi: 50, emaFast: 100, emaSlow: 98, macd: 0.5, macdSignal: 0.3, macdHistogram: 0.2,
        atr: 2, bollingerUpper: 105, bollingerMiddle: 100, bollingerLower: 95,
        vwap: 100, vwapIsProxyVolume: false, volumeProfilePoc: 100, volumeProfilePocIsProxyVolume: false,
        meanReversionRsi: 50, impulseVelocity: 0, adx: 20,
      },
    });
    const result = applySignalFilters(candles, snapshot, 'buy', 0.5);
    expect(result.scoreMultiplier).toBeLessThan(1);
    expect(result.reasons.some((r) => r.includes('High-volatility regime with weak/fading trend'))).toBe(true);
  });

  it('hard-vetoes high-volatility regime when ADX is below the no-trend threshold (directionless spike, not a tradeable expansion)', () => {
    const candles = uptrendCandles(30);
    const snapshot = makeSnapshot({
      regime: 'high-volatility',
      patterns: [],
      indicators: {
        rsi: 50, emaFast: 100, emaSlow: 98, macd: 0.5, macdSignal: 0.3, macdHistogram: 0.2,
        atr: 2, bollingerUpper: 105, bollingerMiddle: 100, bollingerLower: 95,
        vwap: 100, vwapIsProxyVolume: false, volumeProfilePoc: 100, volumeProfilePocIsProxyVolume: false,
        meanReversionRsi: 50, impulseVelocity: 0, adx: 15,
      },
    });
    const result = applySignalFilters(candles, snapshot, 'buy', 0.5);
    expect(result.invalidated).toBe(true);
    expect(result.scoreMultiplier).toBe(0);
  });

  it('does not gate high-volatility regime when ADX confirms a real coherent trend', () => {
    const candles = uptrendCandles(30);
    const snapshot = makeSnapshot({
      regime: 'high-volatility',
      patterns: [],
      indicators: {
        rsi: 50, emaFast: 100, emaSlow: 98, macd: 0.5, macdSignal: 0.3, macdHistogram: 0.2,
        atr: 2, bollingerUpper: 105, bollingerMiddle: 100, bollingerLower: 95,
        vwap: 100, vwapIsProxyVolume: false, volumeProfilePoc: 100, volumeProfilePocIsProxyVolume: false,
        meanReversionRsi: 50, impulseVelocity: 0, adx: 35,
      },
    });
    const result = applySignalFilters(candles, snapshot, 'buy', 0.5);
    expect(result.scoreMultiplier).toBe(1);
  });

  it('does not gate when ADX is unavailable (null)', () => {
    const candles = uptrendCandles(30);
    const result = applySignalFilters(candles, rangeSnapshotWithAdx(null), 'buy', 0.5);
    expect(result.scoreMultiplier).toBe(1);
  });

  it('can be disabled via signalToggles.regimeGate', () => {
    const candles = uptrendCandles(30);
    const toggles = { ...DEFAULT_SIGNAL_TOGGLES, regimeGate: false };
    const result = applySignalFilters(candles, rangeSnapshotWithAdx(20), 'buy', 0.5, toggles);
    expect(result.scoreMultiplier).toBe(1);
  });
});

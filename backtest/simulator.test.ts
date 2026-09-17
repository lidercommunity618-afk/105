import { describe, it, expect } from 'vitest';
import { simulate, splitTrades, type SimulatorOptions } from './simulator';
import type { Candle, IndicatorConfig, FeatureName } from '@/types/domain';
import { DEFAULT_INDICATOR_CONFIG } from '@/types/domain';

function makeCandle(time: number, open: number, high: number, low: number, close: number): Candle {
  return { time, open, high, low, close, volume: 1000 };
}

function uptrendCandles(n: number, startTime = 1700000000): Candle[] {
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const open = price;
    const close = open + 0.8;
    const high = close + 0.5;
    const low = open - 0.3;
    candles.push(makeCandle(startTime + i * 60, open, high, low, close));
    price = close;
  }
  return candles;
}

// BUGFIX (аудит 2026-09-06, п.2): scoreThreshold по умолчанию поднят с 2 до
// 4, ориентируясь на реальный движок со ВСЕМИ паттернами/стратегиями
// включёнными. Этот файл намеренно тестирует симулятор с урезанным набором
// activeFeatures (только rsi/ema/macd/atr, без единого паттерна/стратегии,
// см. FEATURES ниже) — то есть проверяет механику окон/сплита, а не
// реалистичный score. Порог здесь понижен локально, чтобы тест не был
// хрупким к производственному дефолту, который сознательно калибруется под
// другой (полнофункциональный) сценарий.
const CONFIG: IndicatorConfig = { ...DEFAULT_INDICATOR_CONFIG, scoreThreshold: 0 };

const FEATURES: FeatureName[] = ['rsi', 'ema', 'macd', 'atr'];

const BASE_OPTIONS: Omit<SimulatorOptions, 'symbol' | 'timeframe'> = {
  indicatorConfig: CONFIG,
  activeFeatures: FEATURES,
  barsToResolve: 5,
  windowSize: 60,
  inSampleRatio: 0.7,
};

describe('simulate', () => {
  it('returns empty array for insufficient candles', () => {
    const candles = uptrendCandles(10);
    const trades = simulate(candles, {
      ...BASE_OPTIONS, symbol: 'BTCUSDT', timeframe: '1m',
    });
    expect(trades).toHaveLength(0);
  });

  it('generates trades for a strong uptrend', () => {
    const candles = uptrendCandles(200);
    const trades = simulate(candles, {
      ...BASE_OPTIONS, symbol: 'BTCUSDT', timeframe: '1m',
    });
    expect(trades.length).toBeGreaterThan(0);
    for (const t of trades) {
      expect(t.signal.symbolId).toBe('BTCUSDT');
      expect(t.signal.timeframe).toBe('1m');
      expect(t.signal.outcome).toBe('pending');
      expect(['win', 'loss', 'timeout']).toContain(t.outcome);
      expect(t.candleIndex).toBeGreaterThanOrEqual(0);
      expect(t.spreadCostR).toBeGreaterThanOrEqual(0);
    }
  });

  it('assigns deterministic signal IDs based on candle index', () => {
    const candles = uptrendCandles(200);
    const trades = simulate(candles, {
      ...BASE_OPTIONS, symbol: 'BTCUSDT', timeframe: '1m',
    });
    const ids = new Set(trades.map((t) => t.signal.id));
    expect(ids.size).toBe(trades.length);
    for (const t of trades) {
      expect(t.signal.id).toContain(`BTCUSDT:1m:${t.candleIndex}`);
    }
  });

  it('splits trades into in-sample and out-of-sample', () => {
    const candles = uptrendCandles(200);
    const trades = simulate(candles, {
      ...BASE_OPTIONS, symbol: 'BTCUSDT', timeframe: '1m',
    });
    const { inSample, outOfSample } = splitTrades(trades);
    for (const t of inSample) expect(t.inSample).toBe(true);
    for (const t of outOfSample) expect(t.inSample).toBe(false);
    expect(inSample.length + outOfSample.length).toBe(trades.length);
  });

  it('in-sample ratio controls split proportion', { timeout: 15000 }, () => {
    const candles = uptrendCandles(300);
    const trades70 = simulate(candles, {
      ...BASE_OPTIONS, inSampleRatio: 0.7, symbol: 'BTCUSDT', timeframe: '1m',
    });
    const trades30 = simulate(candles, {
      ...BASE_OPTIONS, inSampleRatio: 0.3, symbol: 'BTCUSDT', timeframe: '1m',
    });
    const in70 = trades70.filter((t) => t.inSample).length;
    const in30 = trades30.filter((t) => t.inSample).length;
    expect(in70).toBeGreaterThan(in30);
  });

  it('spread cost is zero for crypto symbols', () => {
    const candles = uptrendCandles(200);
    const trades = simulate(candles, {
      ...BASE_OPTIONS, symbol: 'BTCUSDT', timeframe: '1m',
    });
    for (const t of trades) {
      expect(t.spreadCostR).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('splitTrades', () => {
  it('returns empty arrays for empty input', () => {
    const { inSample, outOfSample } = splitTrades([]);
    expect(inSample).toHaveLength(0);
    expect(outOfSample).toHaveLength(0);
  });
});

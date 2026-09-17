import { describe, it, expect } from 'vitest';
import { runEngine } from '@/engine/analysisEngine';
import type { Candle, IndicatorConfig, FeatureName } from '@/types/domain';
import { DEFAULT_INDICATOR_CONFIG } from '@/types/domain';

const DEFAULT_CONFIG: IndicatorConfig = { ...DEFAULT_INDICATOR_CONFIG };

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

describe('runEngine', () => {
  it('returns null signal for insufficient candles', () => {
    const result = runEngine({
      symbolId: 'BTCUSD',
      timeframe: '1m',
      candles: makeCandles(5),
      config: DEFAULT_CONFIG,
      activeFeatures: [] as FeatureName[],
      calibration: null,
      tick: null,
      barsToResolve: 5,
    });
    expect(result.signal).toBeNull();
    expect(result.snapshot).toBeDefined();
  });

  it('returns a signal for a valid uptrend', () => {
    const result = runEngine({
      symbolId: 'BTCUSD',
      timeframe: '1m',
      candles: makeCandles(60),
      config: DEFAULT_CONFIG,
      activeFeatures: ['ema-cross'] as unknown as FeatureName[],
      calibration: null,
      tick: null,
      barsToResolve: 5,
    });
    expect(result.snapshot).toBeDefined();
    expect(result.snapshot.indicators).toBeDefined();
  });

  it('produces consistent frame data for same input', () => {
    const input = {
      symbolId: 'BTCUSD',
      timeframe: '1m' as const,
      candles: makeCandles(50),
      config: DEFAULT_CONFIG,
      activeFeatures: [] as FeatureName[],
      calibration: null,
      tick: null,
      barsToResolve: 5,
    };
    const r1 = runEngine(input);
    const r2 = runEngine(input);
    expect(r1.snapshot.indicators.emaFast).toBe(r2.snapshot.indicators.emaFast);
  });
});

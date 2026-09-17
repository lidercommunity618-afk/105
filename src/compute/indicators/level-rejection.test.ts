import { describe, it, expect } from 'vitest';
import { analyzeLevelTouches, levelRejection } from '@/compute/indicators/level-rejection';
import type { Candle } from '@/types/domain';

function candle(
  time: number,
  open: number,
  close: number,
  high: number,
  low: number,
  volume = 100,
): Candle {
  return { time, open, high, low, close, volume };
}

describe('analyzeLevelTouches', () => {
  it('increases strengthScore on repeated touches with high wick-ratio', () => {
    const candles: Candle[] = [
      candle(1, 100, 101, 101, 95),
      candle(2, 100, 101, 101, 94),
      candle(3, 100, 101, 101, 95),
    ];
    const result = analyzeLevelTouches(candles, 'support', 101, 99);
    expect(result.touchCount).toBe(3);
    expect(result.status).toBe('tested-hold');
    expect(result.strengthScore).toBeGreaterThan(0.5);
  });

  it('returns broken when close falls below zone', () => {
    const candles: Candle[] = [
      candle(1, 100, 101, 101, 95),
      candle(2, 98, 96, 99, 95),
    ];
    const result = analyzeLevelTouches(candles, 'support', 101, 99);
    expect(result.status).toBe('broken');
  });

  it('returns untested when no candles enter the zone', () => {
    const candles: Candle[] = [
      candle(1, 110, 111, 112, 109),
      candle(2, 111, 112, 113, 110),
    ];
    const result = analyzeLevelTouches(candles, 'support', 101, 99);
    expect(result.touchCount).toBe(0);
    expect(result.status).toBe('untested');
  });
});

describe('levelRejection', () => {
  it('detects rejection from resistance with multiple fractal highs', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 15; i++) {
      candles.push(candle(i, 100, 100.5, 101, 99.5));
    }
    candles.push(candle(15, 105, 106, 107, 104.5));
    candles.push(candle(16, 106, 108, 110, 105));
    candles.push(candle(17, 108, 107, 109, 106));
    candles.push(candle(18, 107, 106, 108, 105));
    candles.push(candle(19, 106, 108, 110, 105));
    candles.push(candle(20, 108, 107, 109, 106));
    candles.push(candle(21, 107, 106, 108, 105));
    candles.push(candle(22, 106, 108, 110, 105));
    candles.push(candle(23, 108, 107, 109, 106));
    candles.push(candle(24, 107, 106, 110, 105.5));

    const zones = levelRejection(candles);
    const resZone = zones.find((z) => z.type === 'resistance');
    expect(resZone).toBeDefined();
    expect(resZone!.status).not.toBe('broken');
  });

  it('filters out broken zones', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 15; i++) {
      candles.push(candle(i, 100, 100.5, 101, 99.5));
    }
    candles.push(candle(15, 105, 106, 107, 104.5));
    candles.push(candle(16, 106, 108, 110, 105));
    candles.push(candle(17, 108, 107, 109, 106));
    candles.push(candle(18, 107, 106, 108, 105));
    candles.push(candle(19, 106, 108, 110, 105));
    candles.push(candle(20, 108, 107, 109, 106));
    candles.push(candle(21, 107, 112, 113, 106));

    const zones = levelRejection(candles);
    const brokenZone = zones.find((z) => z.type === 'resistance' && z.status === 'broken');
    expect(brokenZone).toBeUndefined();
  });
});

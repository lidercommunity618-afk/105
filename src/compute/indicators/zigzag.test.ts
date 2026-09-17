import { describe, it, expect } from 'vitest';
import { computeZigZag, findHarmonicZigZagPoints } from './zigzag';
import type { Candle } from '@/types/domain';

// Свечи ниже строят 6 подряд чередующихся точек ZigZag (X,A,B,C,D,E) —
// та же фикстура, что и в тесте "still finds the pattern via the [-6,-1]
// window..." в harmonic-pattern.test.ts (см. комментарий там про то, как
// это было проверено прогоном computeZigZag).
function candle(time: number, open: number, close: number, high: number, low: number, volume = 100): Candle {
  return { time, open, high, low, close, volume };
}
function ramp(startTime: number, from: number, to: number, bars: number, wick = 0.15): { candles: Candle[]; endTime: number } {
  const candles: Candle[] = [];
  let t = startTime;
  const step = (to - from) / bars;
  let price = from;
  for (let i = 0; i < bars; i++) {
    const open = price;
    price = from + step * (i + 1);
    const close = price;
    const high = Math.max(open, close) + wick;
    const low = Math.min(open, close) - wick;
    candles.push(candle(t, open, close, high, low));
    t += 60;
  }
  return { candles, endTime: t };
}
function flat(startTime: number, price: number, bars: number, noise = 0.3): { candles: Candle[]; endTime: number } {
  const candles: Candle[] = [];
  let t = startTime;
  for (let i = 0; i < bars; i++) {
    const wobble = (i % 2 === 0 ? 1 : -1) * noise * 0.3;
    const open = price;
    const close = price + wobble;
    const high = Math.max(open, close) + noise;
    const low = Math.min(open, close) - noise;
    candles.push(candle(t, open, close, high, low));
    t += 60;
  }
  return { candles, endTime: t };
}
function barsFor(from: number, to: number): number {
  return Math.max(10, Math.round(Math.abs(to - from) / 2));
}
function buildSwingCandles(startPrice: number, targets: number[], warmupBars = 20): Candle[] {
  let t = 1_700_000_000;
  const out: Candle[] = [];
  const warm = flat(t, startPrice, warmupBars);
  out.push(...warm.candles);
  t = warm.endTime;
  let prev = startPrice;
  for (const target of targets) {
    const leg = ramp(t, prev, target, barsFor(prev, target));
    out.push(...leg.candles);
    t = leg.endTime;
    prev = target;
  }
  return out;
}

describe('computeZigZag', () => {
  it('returns [] for too few candles or a non-positive leg multiple', () => {
    expect(computeZigZag([candle(1, 100, 101, 101, 99)], 1.0)).toEqual([]);
    const candles = buildSwingCandles(150, [100, 200]);
    expect(computeZigZag(candles, 0)).toEqual([]);
    expect(computeZigZag(candles, -1)).toEqual([]);
  });

  it('produces strictly alternating high/low pivots', () => {
    const candles = buildSwingCandles(150, [100, 200, 138.2, 169.1, 121.4, 145, 128]);
    const points = computeZigZag(candles, 1.0, 14);
    expect(points.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < points.length; i++) {
      expect(points[i].type).not.toBe(points[i - 1].type);
    }
  });
});

describe('findHarmonicZigZagPoints — tailCount parameter', () => {
  it('defaults to returning exactly the last 5 points (unchanged behavior for existing callers like ChartPanel.tsx)', () => {
    const candles = buildSwingCandles(150, [100, 200, 138.2, 169.1, 121.4, 145, 128]);
    const points = findHarmonicZigZagPoints(candles, 1.0, 1);
    expect(points).not.toBeNull();
    expect(points!.length).toBe(5);
  });

  it('returns up to tailCount points when more are available, for multi-window search', () => {
    const candles = buildSwingCandles(150, [100, 200, 138.2, 169.1, 121.4, 145, 128]);
    const tail = findHarmonicZigZagPoints(candles, 1.0, 1, 14, 7);
    expect(tail).not.toBeNull();
    // Фикстура даёт ровно 6 точек ZigZag (см. комментарий выше) — tailCount=7
    // запрошен, но точек всего 6, slice(-7) на 6-элементном массиве
    // возвращает все 6 (не требует отдельной обработки "точек меньше
    // tailCount", см. комментарий в zigzag.ts).
    expect(tail!.length).toBe(6);
  });

  it('returns null when fewer than 5 points exist, regardless of tailCount', () => {
    const candles = buildSwingCandles(150, [100, 200]);
    expect(findHarmonicZigZagPoints(candles, 1.0, 1, 14, 7)).toBeNull();
  });
});

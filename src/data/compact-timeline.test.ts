import { describe, it, expect } from 'vitest';
import { compactTimeline } from './compact-timeline';
import type { Candle } from '@/types/domain';

function candle(time: number, close: number, volume = 100): Candle {
  return { time, open: close, high: close + 1, low: close - 1, close, volume };
}

describe('compactTimeline', () => {
  it('returns candles unchanged for less than 2 candles', () => {
    const single = [candle(0, 100)];
    expect(compactTimeline(single, '15m', 'forex')).toBe(single);
    expect(compactTimeline([], '15m', 'forex')).toEqual([]);
  });

  it('passes through contiguous candles without filling gaps', () => {
    const candles = [candle(0, 100), candle(900, 101), candle(1800, 102)];
    const result = compactTimeline(candles, '15m', 'forex');
    expect(result).toHaveLength(3);
    expect(result.map((c) => c.time)).toEqual([0, 900, 1800]);
  });

  it('fills gaps with flat candles using previous close', () => {
    // Gap: candle at 0, next at 1800 (missing 900) for 15m (900s)
    const candles = [candle(0, 100), candle(1800, 102)];
    const result = compactTimeline(candles, '15m', 'forex');
    expect(result).toHaveLength(3);
    expect(result[1].time).toBe(900);
    expect(result[1].open).toBe(100); // previous close
    expect(result[1].close).toBe(100);
    expect(result[1].high).toBe(100);
    expect(result[1].low).toBe(100);
    expect(result[1].volume).toBe(0);
  });

  it('fills multiple missing candles', () => {
    // 15m = 900s. Candles at 0 and 3600 → missing 900, 1800, 2700
    const candles = [candle(0, 100), candle(3600, 104)];
    const result = compactTimeline(candles, '15m', 'forex');
    expect(result).toHaveLength(5);
    expect(result[1].time).toBe(900);
    expect(result[2].time).toBe(1800);
    expect(result[3].time).toBe(2700);
    // All filled candles use the last pushed close (100)
    expect(result[1].close).toBe(100);
    expect(result[2].close).toBe(100);
    expect(result[3].close).toBe(100);
  });

  it('skips weekend candles for forex (Saturday and Sunday)', () => {
    // Jan 3, 2026 is Saturday (getUTCDay()=6), Jan 4 is Sunday (=0), Jan 5 is Monday (=1)
    const saturday = Math.floor(Date.UTC(2026, 0, 3, 0, 0) / 1000);
    const sunday = Math.floor(Date.UTC(2026, 0, 4, 0, 0) / 1000);
    const monday = Math.floor(Date.UTC(2026, 0, 5, 0, 0) / 1000);

    const candles = [
      candle(saturday, 100),
      candle(sunday, 101),
      candle(monday, 102),
    ];
    const result = compactTimeline(candles, '15m', 'forex');
    // Saturday and Sunday should be skipped for forex — only Monday survives
    const times = result.map((c) => c.time);
    expect(times).not.toContain(saturday);
    expect(times).not.toContain(sunday);
    expect(times).toContain(monday);
  });

  it('keeps weekend candles for crypto (no weekend filtering)', () => {
    const saturday = Math.floor(Date.UTC(2026, 0, 3, 0, 0) / 1000);
    const sunday = Math.floor(Date.UTC(2026, 0, 4, 0, 0) / 1000);

    const candles = [candle(saturday, 100), candle(sunday, 101)];
    const result = compactTimeline(candles, '15m', 'crypto');
    // Crypto doesn't filter weekends, but gap-fill still applies between the two candles
    // Gap = 86400s, tfSec = 900s → missing = 86400/900 - 1 = 95, plus 2 originals = 97
    expect(result).toHaveLength(97);
    expect(result[0].time).toBe(saturday);
    expect(result[96].time).toBe(sunday);
  });

  it('fills gap candles with volume = 0', () => {
    const candles = [candle(0, 100), candle(1800, 102)];
    const result = compactTimeline(candles, '15m', 'forex');
    expect(result[1].volume).toBe(0);
  });

  it('preserves original candle data (not modified)', () => {
    const candles = [candle(0, 100, 500), candle(900, 101, 600)];
    const result = compactTimeline(candles, '15m', 'forex');
    expect(result[0].volume).toBe(500);
    expect(result[1].volume).toBe(600);
    expect(result[0].close).toBe(100);
    expect(result[1].close).toBe(101);
  });
});

import { describe, it, expect } from 'vitest';
import { hasReliableVolume } from '@/compute/indicators/helpers';

function candle(volume: number) {
  return { volume };
}

describe('hasReliableVolume (Пункт 1 — Deriv/forex zero-volume fix)', () => {
  it('returns false when every candle in the window reports volume 0 (Deriv/OTC-forex feeds)', () => {
    const candles = Array.from({ length: 25 }, () => candle(0));
    expect(hasReliableVolume(candles, 24, 20)).toBe(false);
  });

  it('returns true when at least one candle in the trailing window has real volume', () => {
    const candles = Array.from({ length: 25 }, (_, i) => candle(i === 20 ? 150 : 0));
    expect(hasReliableVolume(candles, 24, 20)).toBe(true);
  });

  it('only looks at the trailing `period` window, not the whole array', () => {
    // Real volume exists far outside the trailing 20-bar window at index 24.
    const candles = Array.from({ length: 25 }, (_, i) => candle(i === 0 ? 500 : 0));
    expect(hasReliableVolume(candles, 24, 20)).toBe(false);
  });

  it('returns true for an ordinary equities/crypto-style feed with real volume throughout', () => {
    const candles = Array.from({ length: 25 }, () => candle(1000));
    expect(hasReliableVolume(candles, 24, 20)).toBe(true);
  });
});

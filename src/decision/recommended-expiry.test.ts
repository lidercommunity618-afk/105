import { describe, it, expect } from 'vitest';
import { recommendedExpiry } from './recommended-expiry';

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

  it('returns 3x timeframe for very low volatility (< 0.5%)', () => {
    // volatilityPct = 0.4 / 100 = 0.004 < 0.005 → 3 bars
    const expiry = recommendedExpiry('15m', 0.4, 100);
    expect(expiry).toBe(900 * 3);
  });

  it('returns 2x timeframe for medium volatility (0.5%-1%)', () => {
    // volatilityPct = 0.7 / 100 = 0.007 → 2 bars
    const expiry = recommendedExpiry('15m', 0.7, 100);
    expect(expiry).toBe(900 * 2);
  });

  it('returns 1x timeframe for high volatility (> 1%)', () => {
    // volatilityPct = 2 / 100 = 0.02 → 1 bar
    const expiry = recommendedExpiry('15m', 2, 100);
    expect(expiry).toBe(900);
  });

  it('returns timeframe seconds when atr is zero', () => {
    const expiry = recommendedExpiry('5m', 0, 100);
    expect(expiry).toBe(300);
  });

  it('returns timeframe seconds when entryPrice is zero', () => {
    const expiry = recommendedExpiry('5m', 1, 0);
    expect(expiry).toBe(300);
  });

  it('returns timeframe seconds when both atr and entryPrice are zero', () => {
    const expiry = recommendedExpiry('1m', 0, 0);
    expect(expiry).toBe(60);
  });

  it('works correctly for different timeframes', () => {
    expect(recommendedExpiry('1m', 2, 100)).toBe(60);
    expect(recommendedExpiry('1h', 2, 100)).toBe(3600);
    expect(recommendedExpiry('1d', 2, 100)).toBe(86400);
  });

  it('handles boundary at exactly 0.5% volatility', () => {
    // volatilityPct = 0.5 / 100 = 0.005 → NOT < 0.005, so 2 bars
    const expiry = recommendedExpiry('15m', 0.5, 100);
    expect(expiry).toBe(900 * 2);
  });

  it('handles boundary at exactly 1% volatility', () => {
    // volatilityPct = 1 / 100 = 0.01 → NOT < 0.01, so 1 bar
    const expiry = recommendedExpiry('15m', 1, 100);
    expect(expiry).toBe(900);
  });
});

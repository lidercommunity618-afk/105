import { describe, it, expect } from 'vitest';
import { binomialSignificanceTest, MIN_SAMPLES_FOR_SIGNIFICANCE } from './significance';

describe('binomialSignificanceTest', () => {
  it('marks insufficient-samples below the minimum threshold, regardless of accuracy', () => {
    const result = binomialSignificanceTest(80, 100, 0.5); // 80% accuracy but only 100 samples
    expect(result.total).toBeLessThan(MIN_SAMPLES_FOR_SIGNIFICANCE);
    expect(result.reason).toBe('insufficient-samples');
    expect(result.significant).toBe(false);
    expect(Number.isNaN(result.pValue)).toBe(true);
  });

  it('does not reject H0 for accuracy indistinguishable from baseline at a large sample size', () => {
    // 505/1000 ≈ 50.5% — well within noise of a 50% baseline even at n=1000.
    const result = binomialSignificanceTest(505, 1000, 0.5);
    expect(result.significant).toBe(false);
    expect(result.reason).toBe('not-significant');
  });

  it('rejects H0 for accuracy clearly above baseline at a large sample size', () => {
    // 620/1000 = 62% vs 50% baseline, n=1000 — should be highly significant.
    const result = binomialSignificanceTest(620, 1000, 0.5);
    expect(result.significant).toBe(true);
    expect(result.reason).toBe('significant');
    expect(result.pValue).toBeLessThan(0.05);
  });

  it('never marks significant when accuracy is below baseline, even with a tiny p-value', () => {
    // 380/1000 = 38% vs 50% baseline — extreme deviation, but in the WRONG
    // direction (worse than random). Not "significant" for our purposes.
    const result = binomialSignificanceTest(380, 1000, 0.5);
    expect(result.observedAccuracy).toBeLessThan(0.5);
    expect(result.significant).toBe(false);
  });

  it('is symmetric: p-value for k wins equals p-value for (n-k) wins at baseline 0.5', () => {
    const a = binomialSignificanceTest(600, 1000, 0.5);
    const b = binomialSignificanceTest(400, 1000, 0.5);
    expect(a.pValue).toBeCloseTo(b.pValue, 6);
  });

  it('handles baseline other than 0.5 (e.g. testing against a biased reference rate)', () => {
    // At baseline 0.55 (e.g. breakeven for a specific payout), 620/1000
    // should still clear significance since 62% is meaningfully above 55%.
    const result = binomialSignificanceTest(620, 1000, 0.55);
    expect(result.significant).toBe(true);
  });

  it('returns a p-value of 1 for an exact-baseline observation', () => {
    const result = binomialSignificanceTest(500, 1000, 0.5);
    expect(result.pValue).toBeCloseTo(1, 2);
    expect(result.significant).toBe(false);
  });

  it('handles the exact minimum sample threshold as sufficient', () => {
    const result = binomialSignificanceTest(120, MIN_SAMPLES_FOR_SIGNIFICANCE, 0.5);
    expect(result.reason).not.toBe('insufficient-samples');
  });
});

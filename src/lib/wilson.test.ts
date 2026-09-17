import { describe, it, expect } from 'vitest';
import { wilsonLowerBound } from '@/lib/wilson';

describe('wilsonLowerBound (shared module)', () => {
  it('matches the well-known reference value for a single 100% observation (n=1)', () => {
    expect(wilsonLowerBound(1, 1)).toBeCloseTo(0.2065, 4);
  });

  it('is strictly below the raw winRate for any finite sample below 100%', () => {
    expect(wilsonLowerBound(10, 20)).toBeLessThan(0.5);
    expect(wilsonLowerBound(5, 10)).toBeLessThan(0.5);
  });

  it('converges toward the raw winRate as n grows', () => {
    const small = wilsonLowerBound(50, 100);
    const large = wilsonLowerBound(5000, 10000);
    expect(large).toBeGreaterThan(small);
    expect(large).toBeLessThan(0.5);
  });

  it('returns 0 for n<=0 without throwing', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });

  it('gives a lower bound above 0.5 for a strong majority with enough samples', () => {
    // 70/100 = 70% raw, Wilson LB should be above 0.5
    const lb = wilsonLowerBound(70, 100);
    expect(lb).toBeGreaterThan(0.5);
  });

  it('gives a lower bound below 0.5 for a marginal majority with few samples', () => {
    // 7/10 = 70% raw, but Wilson LB should be below 0.5 due to small n
    const lb = wilsonLowerBound(7, 10);
    expect(lb).toBeLessThan(0.5);
  });
});

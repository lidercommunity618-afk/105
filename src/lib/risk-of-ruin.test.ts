import { describe, it, expect } from 'vitest';
import {
  probabilityOfNConsecutiveLosses,
  martingaleFullCycleLossProbability,
  martingaleFullCycleLossAmount,
  MARTINGALE_STAGES_PER_CYCLE,
} from './risk-of-ruin';

describe('probabilityOfNConsecutiveLosses', () => {
  it('matches a fair coin flip: 50% accuracy, 1 loss = 50%', () => {
    expect(probabilityOfNConsecutiveLosses(0.5, 1)).toBeCloseTo(0.5, 10);
  });

  it('matches a fair coin flip: 50% accuracy, 4 losses = 6.25%', () => {
    expect(probabilityOfNConsecutiveLosses(0.5, 4)).toBeCloseTo(0.0625, 10);
  });

  it('is near zero for a highly accurate pattern over several losses', () => {
    expect(probabilityOfNConsecutiveLosses(0.9, 4)).toBeCloseTo(0.0001, 10);
  });

  it('is 1 for a 0% accuracy pattern (always loses)', () => {
    expect(probabilityOfNConsecutiveLosses(0, 3)).toBe(1);
  });

  it('is 0 for a 100% accuracy pattern (never loses)', () => {
    expect(probabilityOfNConsecutiveLosses(1, 3)).toBe(0);
  });

  it('clamps out-of-range accuracy into [0, 1] rather than producing NaN/negative probabilities', () => {
    expect(probabilityOfNConsecutiveLosses(-0.2, 3)).toBe(1);
    expect(probabilityOfNConsecutiveLosses(1.5, 3)).toBe(0);
  });

  it('decreases monotonically as accuracy increases', () => {
    const low = probabilityOfNConsecutiveLosses(0.4, 4);
    const mid = probabilityOfNConsecutiveLosses(0.5, 4);
    const high = probabilityOfNConsecutiveLosses(0.6, 4);
    expect(low).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(high);
  });
});

describe('martingaleFullCycleLossProbability', () => {
  it('uses exactly 4 stages (stage0 + 3 escalations), matching this app\'s bounded martingale', () => {
    expect(MARTINGALE_STAGES_PER_CYCLE).toBe(4);
    expect(martingaleFullCycleLossProbability(0.5)).toBeCloseTo(
      probabilityOfNConsecutiveLosses(0.5, 4),
      10,
    );
  });

  it('at a realistic below-breakeven accuracy (45%), a full cycle loss is a meaningfully common event', () => {
    // (1-0.45)^4 = 0.55^4 ≈ 9.15% — happens roughly 1 in 11 cycles, not a
    // tail event a user should dismiss.
    const p = martingaleFullCycleLossProbability(0.45);
    expect(p).toBeCloseTo(0.0915, 3);
  });

  it('at a strong accuracy (65%), a full cycle loss is much rarer', () => {
    // (1-0.65)^4 = 0.35^4 ≈ 1.5%
    const p = martingaleFullCycleLossProbability(0.65);
    expect(p).toBeCloseTo(0.0150, 3);
  });
});

describe('martingaleFullCycleLossAmount', () => {
  it('sums stage0Amount and all three escalation stages', () => {
    expect(martingaleFullCycleLossAmount(10, [20, 40, 80])).toBe(150);
  });

  it('returns 0 for an all-zero configuration', () => {
    expect(martingaleFullCycleLossAmount(0, [0, 0, 0])).toBe(0);
  });
});

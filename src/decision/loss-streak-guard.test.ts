import { describe, it, expect } from 'vitest';
import {
  nextLossStreak,
  requiresStrongOnlyForLossStreak,
  LOSS_STREAK_GATE_THRESHOLD,
} from './loss-streak-guard';

describe('nextLossStreak', () => {
  it('increments on consecutive losses', () => {
    let streak = 0;
    streak = nextLossStreak(streak, 'loss');
    expect(streak).toBe(1);
    streak = nextLossStreak(streak, 'loss');
    expect(streak).toBe(2);
    streak = nextLossStreak(streak, 'loss');
    expect(streak).toBe(3);
  });

  it('resets to 0 on a win', () => {
    expect(nextLossStreak(5, 'win')).toBe(0);
  });

  it('a win immediately after a loss resets the streak (alternating wins/losses never accumulate)', () => {
    let streak = 0;
    streak = nextLossStreak(streak, 'loss');
    streak = nextLossStreak(streak, 'win');
    streak = nextLossStreak(streak, 'loss');
    streak = nextLossStreak(streak, 'win');
    expect(streak).toBe(0);
  });

  it('starting from 0, a win stays at 0', () => {
    expect(nextLossStreak(0, 'win')).toBe(0);
  });
});

describe('requiresStrongOnlyForLossStreak', () => {
  it('is false below the threshold', () => {
    expect(requiresStrongOnlyForLossStreak(0)).toBe(false);
    expect(requiresStrongOnlyForLossStreak(LOSS_STREAK_GATE_THRESHOLD - 1)).toBe(false);
  });

  it('is true at and above the threshold', () => {
    expect(requiresStrongOnlyForLossStreak(LOSS_STREAK_GATE_THRESHOLD)).toBe(true);
    expect(requiresStrongOnlyForLossStreak(LOSS_STREAK_GATE_THRESHOLD + 1)).toBe(true);
    expect(requiresStrongOnlyForLossStreak(50)).toBe(true);
  });

  it('respects an explicit custom threshold override', () => {
    expect(requiresStrongOnlyForLossStreak(1, 1)).toBe(true);
    expect(requiresStrongOnlyForLossStreak(0, 1)).toBe(false);
  });

  it('default threshold is 2 (gate on the 3rd trade of a losing series, not after it)', () => {
    expect(LOSS_STREAK_GATE_THRESHOLD).toBe(2);
  });
});

describe('nextLossStreak + requiresStrongOnlyForLossStreak — end-to-end sequence', () => {
  it('reproduces the exact "3 losses in a row" scenario: gate activates before the 3rd loss', () => {
    let streak = 0;
    // 1st loss: streak=1, gate not yet active (only 1 real loss so far).
    streak = nextLossStreak(streak, 'loss');
    expect(requiresStrongOnlyForLossStreak(streak)).toBe(false);
    // 2nd consecutive loss: streak=2, gate becomes active — any signal for
    // what would become the 3rd trade in this losing series must now be
    // 'strong' or be suppressed.
    streak = nextLossStreak(streak, 'loss');
    expect(requiresStrongOnlyForLossStreak(streak)).toBe(true);
  });

  it('a win anywhere in the sequence fully clears the gate', () => {
    let streak = 0;
    streak = nextLossStreak(streak, 'loss');
    streak = nextLossStreak(streak, 'loss');
    expect(requiresStrongOnlyForLossStreak(streak)).toBe(true);
    streak = nextLossStreak(streak, 'win');
    expect(requiresStrongOnlyForLossStreak(streak)).toBe(false);
  });
});

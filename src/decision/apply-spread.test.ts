import { describe, it, expect } from 'vitest';
import type { Signal } from '@/types/domain';
import { applySpreadToOutcome } from './apply-spread';

function makeSignal(overrides: Partial<Signal> & { id: string }): Signal {
  return {
    symbolId: 'BTCUSDT',
    timeframe: '5m',
    direction: 'buy',
    strength: 'moderate',
    score: 3,
    calibratedProbability: null,
    entryPrice: 100,
    reason: 'test',
    indicators: {} as unknown as Signal['indicators'],
    pattern: null,
    time: 1000,
    outcome: 'pending',
    frozenAt: null,
    isRevised: false,
    isPreClose: false,
    revisionNote: null,
    barsToResolve: 5,
    spread: null,
    spreadSource: null,
    recommendedExpiry: 300,
    featureVector: [0],
    factors: [], rejectedPatterns: [], engineConfigSnapshot: {} as unknown as Signal['engineConfigSnapshot'],
    chartContext: { candlesBefore: [], candlesAfter: [], maxFavorableExcursion: null, maxAdverseExcursion: null },
    marketContext: { regime: 'range', structure: { trend: 'range', bos: false, choch: false, swingHigh: null, swingLow: null, provisional: false }, session: 'closed' },
    ...overrides,
  };
}

describe('applySpreadToOutcome', () => {
  it('downgrades a win to timeout when the price move does not exceed the spread', () => {
    const signal = makeSignal({ id: 'sig-1', entryPrice: 100 });
    // Close moved only 0.4 above entry; spread is 0.5 — move <= spread.
    const result = applySpreadToOutcome('win', signal, 0.5, 100.4);

    expect(result.outcome).toBe('timeout');
  });

  it('keeps a win when the price move exceeds the spread', () => {
    const signal = makeSignal({ id: 'sig-2', entryPrice: 100 });
    // Close moved 2 above entry; spread is 0.5 — move > spread.
    const result = applySpreadToOutcome('win', signal, 0.5, 102);

    expect(result.outcome).toBe('win');
  });

  it('does not downgrade a loss even when the move is smaller than the spread', () => {
    const signal = makeSignal({ id: 'sig-3', entryPrice: 100 });
    const result = applySpreadToOutcome('loss', signal, 0.5, 99.9);

    expect(result.outcome).toBe('loss');
  });

  it('leaves timeout unchanged regardless of spread', () => {
    const signal = makeSignal({ id: 'sig-4', entryPrice: 100 });
    const result = applySpreadToOutcome('timeout', signal, 0.5, 100);

    expect(result.outcome).toBe('timeout');
  });

  // BUGFIX (Фаза 1, "честный бинарный опцион"): тест "ignores
  // signal.takeProfit entirely" удалён — сам факт удаления поля
  // Signal.takeProfit (см. types/domain.ts) делает его бессмысленным:
  // applySpreadToOutcome физически не может обращаться к полю, которого
  // больше не существует в типе.

  it('computes spreadCostR as spread divided by the actual price move', () => {
    const signal = makeSignal({ id: 'sig-6', entryPrice: 100 });
    const result = applySpreadToOutcome('win', signal, 0.5, 102);

    expect(result.spreadCostR).toBeCloseTo(0.5 / 2, 5);
  });

  it('returns spreadCostR of 0 when there is no price move at all', () => {
    const signal = makeSignal({ id: 'sig-7', entryPrice: 100 });
    const result = applySpreadToOutcome('timeout', signal, 0.5, 100);

    expect(result.spreadCostR).toBe(0);
  });

  it('treats a move exactly equal to the spread as a downgrade (boundary, move <= spread)', () => {
    const signal = makeSignal({ id: 'sig-8', entryPrice: 100 });
    const result = applySpreadToOutcome('win', signal, 0.5, 100.5);

    expect(result.outcome).toBe('timeout');
  });
});

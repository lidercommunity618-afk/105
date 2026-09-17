import { describe, it, expect } from 'vitest';
import type { Signal, SignalFactor } from '@/types/domain';
import { computeFactorStats, MIN_FACTOR_SAMPLES } from './factor-analytics';

function factor(name: string, kind: SignalFactor['kind'] = 'indicator'): SignalFactor {
  return { kind, name, direction: 'buy', contribution: 0.5, argument: name };
}

function makeSignal(overrides: Partial<Signal>): Signal {
  return {
    id: `s-${Math.random()}`,
    symbolId: 'BTCUSDT',
    direction: 'buy',
    strength: 'moderate',
    score: 3,
    calibratedProbability: 0.5,
    entryPrice: 100,
    reason: '',
    indicators: {} as Signal['indicators'],
    pattern: null,
    time: 0,
    timeframe: '15m',
    outcome: 'pending',
    frozenAt: null,
    isRevised: false,
    isPreClose: false,
    revisionNote: null,
    barsToResolve: 1,
    spread: null,
    spreadSource: null,
    recommendedExpiry: 900,
    featureVector: [],
    factors: [],
    rejectedPatterns: [],
    engineConfigSnapshot: {} as Signal['engineConfigSnapshot'],
    chartContext: { candlesBefore: [], candlesAfter: [], maxFavorableExcursion: null, maxAdverseExcursion: null },
    marketContext: { regime: 'range', structure: { trend: 'range', bos: false, choch: false, swingHigh: null, swingLow: null, provisional: false }, session: 'closed' },
    ...overrides,
  };
}

describe('computeFactorStats', () => {
  it('groups by factor name and computes winRate over decided (win/loss) trades', () => {
    const signals = [
      makeSignal({ outcome: 'win', factors: [factor('rsi')] }),
      makeSignal({ outcome: 'loss', factors: [factor('rsi')] }),
      makeSignal({ outcome: 'win', factors: [factor('rsi')] }),
    ];
    const stats = computeFactorStats(signals);
    expect(stats).toHaveLength(1);
    expect(stats[0].name).toBe('rsi');
    expect(stats[0].sampleCount).toBe(3);
    expect(stats[0].decidedCount).toBe(3);
    expect(stats[0].wins).toBe(2);
    expect(stats[0].winRate).toBeCloseTo(2 / 3, 5);
  });

  it('excludes pending signals and signals with tradeOpened === false', () => {
    const signals = [
      makeSignal({ outcome: 'pending', factors: [factor('rsi')] }),
      makeSignal({ outcome: 'loss', tradeOpened: false, factors: [factor('rsi')] }),
      makeSignal({ outcome: 'win', factors: [factor('rsi')] }),
    ];
    const stats = computeFactorStats(signals);
    expect(stats).toHaveLength(1);
    expect(stats[0].sampleCount).toBe(1);
  });

  it('counts timeout in sampleCount but not in decidedCount/winRate denominator', () => {
    const signals = [
      makeSignal({ outcome: 'timeout', factors: [factor('bos')] }),
      makeSignal({ outcome: 'win', factors: [factor('bos')] }),
    ];
    const stats = computeFactorStats(signals);
    expect(stats[0].sampleCount).toBe(2);
    expect(stats[0].decidedCount).toBe(1);
    expect(stats[0].winRate).toBe(1);
  });

  it('sorts by sampleCount descending', () => {
    const signals = [
      makeSignal({ outcome: 'win', factors: [factor('rare-factor')] }),
      makeSignal({ outcome: 'win', factors: [factor('common-factor')] }),
      makeSignal({ outcome: 'loss', factors: [factor('common-factor')] }),
    ];
    const stats = computeFactorStats(signals);
    expect(stats[0].name).toBe('common-factor');
    expect(stats[1].name).toBe('rare-factor');
  });

  it('handles signals with missing factors gracefully', () => {
    const signals = [makeSignal({ outcome: 'win', factors: undefined })];
    expect(() => computeFactorStats(signals)).not.toThrow();
    expect(computeFactorStats(signals)).toEqual([]);
  });

  it('exposes MIN_FACTOR_SAMPLES as a usable threshold', () => {
    expect(MIN_FACTOR_SAMPLES).toBeGreaterThan(0);
  });

  // BUGFIX (аудит калибровки Этапа 2, п.2): STRATEGY_BONUS_PATTERNS
  // (например 'order-block-continuation') produce TWO SignalFactor entries
  // with the same name within one signal — a zeroed 'pattern' placeholder
  // from direction-prediction.ts and the real 'strategy' bonus from
  // signal-builder.ts. One trade must count once, not twice.
  it('counts a factor once per signal even if it appears twice with different kinds (STRATEGY_BONUS_PATTERNS double-entry)', () => {
    const signals = [
      makeSignal({
        outcome: 'win',
        factors: [
          { kind: 'pattern', name: 'order-block-continuation', direction: 'buy', contribution: 0, argument: 'order-block-continuation pattern (100%)', value: 1 },
          { kind: 'strategy', name: 'order-block-continuation', direction: 'buy', contribution: 0.55, argument: 'OBC strategy (+0.55)', value: 1 },
        ],
      }),
      makeSignal({
        outcome: 'loss',
        factors: [
          { kind: 'pattern', name: 'order-block-continuation', direction: 'sell', contribution: 0, argument: 'order-block-continuation pattern (100%)', value: 1 },
          { kind: 'strategy', name: 'order-block-continuation', direction: 'sell', contribution: 0.4, argument: 'OBC strategy (+0.40)', value: 1 },
        ],
      }),
    ];
    const stats = computeFactorStats(signals);
    expect(stats).toHaveLength(1);
    expect(stats[0].name).toBe('order-block-continuation');
    // 2 signals -> sampleCount/decidedCount must be 2, not 4.
    expect(stats[0].sampleCount).toBe(2);
    expect(stats[0].decidedCount).toBe(2);
    expect(stats[0].wins).toBe(1);
    expect(stats[0].winRate).toBeCloseTo(0.5, 5);
  });

  it('reports kind "strategy" (the real contribution) rather than "pattern" (the zeroed placeholder) for a double-entry factor', () => {
    const signals = [
      makeSignal({
        outcome: 'win',
        factors: [
          { kind: 'pattern', name: 'order-block-continuation', direction: 'buy', contribution: 0, argument: 'x', value: 1 },
          { kind: 'strategy', name: 'order-block-continuation', direction: 'buy', contribution: 0.55, argument: 'y', value: 1 },
        ],
      }),
    ];
    const stats = computeFactorStats(signals);
    expect(stats[0].kind).toBe('strategy');
  });

  it('still counts two independent single-entry factors with unrelated names normally (no regression)', () => {
    const signals = [
      makeSignal({ outcome: 'win', factors: [factor('rsi'), factor('ema')] }),
      makeSignal({ outcome: 'loss', factors: [factor('rsi')] }),
    ];
    const stats = computeFactorStats(signals);
    const rsi = stats.find((s) => s.name === 'rsi');
    const ema = stats.find((s) => s.name === 'ema');
    expect(rsi?.sampleCount).toBe(2);
    expect(ema?.sampleCount).toBe(1);
  });
});

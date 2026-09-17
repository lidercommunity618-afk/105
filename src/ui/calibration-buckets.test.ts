import { describe, it, expect } from 'vitest';
import { computeBuckets } from './calibration-buckets';
import type { Signal } from '@/types/domain';

function makeSignal(overrides: Partial<Signal> & { id: string }): Signal {
  return {
    symbolId: 'BTCUSDT',
    direction: 'buy',
    strength: 'moderate',
    score: 3,
    calibratedProbability: 0.7,
    entryPrice: 100,
    reason: 'test',
    indicators: {} as Signal['indicators'],
    pattern: null,
    time: 1000,
    timeframe: '15m',
    outcome: 'win',
    frozenAt: null,
    isRevised: false,
    isPreClose: false,
    revisionNote: null,
    barsToResolve: 5,
    spread: null,
    spreadSource: null,
    recommendedExpiry: 900,
    featureVector: [],
    factors: [], rejectedPatterns: [], engineConfigSnapshot: {} as unknown as Signal['engineConfigSnapshot'],
    chartContext: { candlesBefore: [], candlesAfter: [], maxFavorableExcursion: null, maxAdverseExcursion: null },
    marketContext: { regime: 'range', structure: { trend: 'range', bos: false, choch: false, swingHigh: null, swingLow: null, provisional: false }, session: 'closed' },
    ...overrides,
  };
}

describe('CalibrationPanel computeBuckets', () => {
  // Аудит (перенесённый фикс — расхождение N в таблице калибровки):
  // сигналы без реально открытой демо-сделки (tradeOpened === false)
  // не должны учитываться в N/винрейте таблицы «НАДЁЖНОСТЬ ПО
  // УВЕРЕННОСТИ» — так же, как они уже исключены из «ИСТОРИЯ СИГНАЛОВ»
  // (SignalFeed.tsx) и из calibrationSampleCount/winRate
  // (useAnalyticsStore.recomputeStats).
  it('excludes tradeOpened: false signals from N and winRate', () => {
    const signals = [
      makeSignal({ id: 's1', outcome: 'win', calibratedProbability: 0.7, tradeOpened: true }),
      makeSignal({ id: 's2', outcome: 'loss', calibratedProbability: 0.7, tradeOpened: true }),
      // These would inflate N to 4 and skew winRate if counted.
      makeSignal({ id: 's3', outcome: 'win', calibratedProbability: 0.7, tradeOpened: false }),
      makeSignal({ id: 's4', outcome: 'win', calibratedProbability: 0.7, tradeOpened: false }),
    ];

    const buckets = computeBuckets(signals);
    const bucket = buckets.find((b) => b.label === '60–80%')!;

    expect(bucket.total).toBe(2);
    expect(bucket.wins).toBe(1);
    expect(bucket.winRate).toBeCloseTo(0.5, 5);
  });

  it('treats tradeOpened: undefined (legacy signals) as traded, counting them in N', () => {
    const signals = [
      makeSignal({ id: 's1', outcome: 'win', calibratedProbability: 0.7 }),
      makeSignal({ id: 's2', outcome: 'loss', calibratedProbability: 0.7 }),
    ];

    const buckets = computeBuckets(signals);
    const bucket = buckets.find((b) => b.label === '60–80%')!;

    expect(bucket.total).toBe(2);
  });

  it('still ignores pending signals regardless of tradeOpened', () => {
    const signals = [
      makeSignal({ id: 's1', outcome: 'pending', calibratedProbability: 0.7, tradeOpened: true }),
    ];

    const buckets = computeBuckets(signals);
    expect(buckets.every((b) => b.total === 0)).toBe(true);
  });
});

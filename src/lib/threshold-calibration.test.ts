import { describe, it, expect } from 'vitest';
import type { Signal } from '@/types/domain';
import {
  computeThresholdCandidates,
  MIN_THRESHOLD_BACKTEST_SAMPLES,
  WINRATE_TOLERANCE,
  TARGET_SIGNALS_PER_5MIN,
} from './threshold-calibration';

function makeSignal(overrides: Partial<Signal> & { id: string }): Signal {
  return {
    symbolId: 'BTCUSDT',
    direction: 'buy',
    strength: 'moderate',
    score: 3,
    calibratedProbability: 0.7,
    calibrationSource: 'model',
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
    factors: [],
    rejectedPatterns: [],
    engineConfigSnapshot: {} as unknown as Signal['engineConfigSnapshot'],
    chartContext: { candlesBefore: [], candlesAfter: [], maxFavorableExcursion: null, maxAdverseExcursion: null },
    marketContext: {
      regime: 'range',
      structure: { trend: 'range', bos: false, choch: false, swingHigh: null, swingLow: null, provisional: false },
      session: 'closed',
    },
    ...overrides,
  };
}

// Builds N signals evenly spaced `stepSeconds` apart starting at time=0, all
// calibrationSource='model', decided (win/loss), tradeOpened true.
function makeSeries(
  count: number,
  opts: { stepSeconds?: number; probability: number; winRate: number },
): Signal[] {
  const { stepSeconds = 60, probability, winRate } = opts;
  const winsWanted = Math.round(count * winRate);
  const out: Signal[] = [];
  for (let i = 0; i < count; i++) {
    out.push(
      makeSignal({
        id: `s${i}`,
        time: i * stepSeconds,
        calibratedProbability: probability,
        calibrationSource: 'model',
        outcome: i < winsWanted ? 'win' : 'loss',
        tradeOpened: true,
      }),
    );
  }
  return out;
}

describe('computeThresholdCandidates', () => {
  it('never recommends a threshold whose frequency is below target, even at 100% winRate', () => {
    // 2 signals spanning 100 minutes = 20 windows of 5min => 0.1 signals/5min,
    // far below TARGET_SIGNALS_PER_5MIN=1, despite a perfect winRate.
    const signals: Signal[] = [
      makeSignal({ id: 's1', time: 0, calibratedProbability: 0.9, outcome: 'win', tradeOpened: true }),
      makeSignal({ id: 's2', time: 6000, calibratedProbability: 0.9, outcome: 'win', tradeOpened: true }),
    ];
    const result = computeThresholdCandidates(signals, 0.75, 0.5);
    expect(result.recommendedThreshold).toBeNull();
    // No candidate in this tiny, sparse dataset should meet the frequency bar.
    expect(result.candidates.every((c) => !c.meetsFrequencyTarget)).toBe(true);
  });

  it('rejects a threshold that meets frequency but drops winRate below baseline - tolerance', () => {
    // Dense series (10s apart) => easily meets frequency target at threshold 0.5.
    // winRate is deliberately low (20%) vs a high baseline (70%).
    const signals = makeSeries(MIN_THRESHOLD_BACKTEST_SAMPLES + 10, {
      stepSeconds: 10,
      probability: 0.55,
      winRate: 0.2,
    });
    const result = computeThresholdCandidates(signals, 0.75, 0.7);
    const candidateAt055 = result.candidates.find((c) => c.threshold === 0.55);
    expect(candidateAt055?.meetsFrequencyTarget).toBe(true);
    expect(candidateAt055?.meetsAccuracyFloor).toBe(false);
    expect(result.recommendedThreshold).toBeNull();
  });

  it('treats decidedCount below MIN_THRESHOLD_BACKTEST_SAMPLES as not meeting the accuracy floor, even with a high raw winRate', () => {
    // Only 3 decided signals, 100% winRate — should NOT qualify despite a
    // perfect winRate, same protection as MIN_FACTOR_SAMPLES in factor-analytics.ts.
    const signals = makeSeries(3, { stepSeconds: 10, probability: 0.55, winRate: 1 });
    const result = computeThresholdCandidates(signals, 0.75, null);
    const candidateAt055 = result.candidates.find((c) => c.threshold === 0.55);
    expect(candidateAt055?.winRate).toBe(1);
    expect(candidateAt055?.decidedCount).toBe(3);
    expect(candidateAt055?.meetsAccuracyFloor).toBe(false);
  });

  it('excludes calibrationSource=fallback signals entirely — not in emittedCount, not in the time span', () => {
    const modelSignals = makeSeries(5, { stepSeconds: 10, probability: 0.6, winRate: 1 });
    const fallbackSignals: Signal[] = [
      makeSignal({ id: 'f1', time: -1000, calibratedProbability: 0.6, calibrationSource: 'fallback', outcome: 'win', tradeOpened: true }),
      makeSignal({ id: 'f2', time: 100000, calibratedProbability: 0.6, calibrationSource: 'fallback', outcome: 'win', tradeOpened: true }),
    ];
    const withFallback = computeThresholdCandidates([...modelSignals, ...fallbackSignals], 0.75, null);
    const withoutFallback = computeThresholdCandidates(modelSignals, 0.75, null);
    const c1 = withFallback.candidates.find((c) => c.threshold === 0.6);
    const c2 = withoutFallback.candidates.find((c) => c.threshold === 0.6);
    expect(c1?.emittedCount).toBe(c2?.emittedCount);
    expect(c1?.signalsPer5Min).toBeCloseTo(c2?.signalsPer5Min ?? -1, 6);
  });

  it('counts a pending signal into emittedCount but not into decidedCount/winRate', () => {
    const signals: Signal[] = [
      makeSignal({ id: 's1', time: 0, calibratedProbability: 0.6, outcome: 'win', tradeOpened: true }),
      makeSignal({ id: 's2', time: 10, calibratedProbability: 0.6, outcome: 'pending', tradeOpened: true }),
    ];
    const result = computeThresholdCandidates(signals, 0.75, null);
    const c = result.candidates.find((cand) => cand.threshold === 0.6);
    expect(c?.emittedCount).toBe(2);
    expect(c?.decidedCount).toBe(1);
  });

  it('always includes currentThreshold as its own point in candidates, unrounded to the 0.05 grid', () => {
    const signals = makeSeries(5, { stepSeconds: 10, probability: 0.6, winRate: 1 });
    const result = computeThresholdCandidates(signals, 0.63, null);
    expect(result.currentThreshold).toBe(0.63);
    expect(result.candidates.some((c) => c.threshold === 0.63)).toBe(true);
  });

  it('returns recommendedThreshold=null with a non-empty reason when nothing qualifies', () => {
    const signals: Signal[] = [];
    const result = computeThresholdCandidates(signals, 0.75, null);
    expect(result.recommendedThreshold).toBeNull();
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it('recommends the highest-winRate qualifying threshold when several qualify', () => {
    // All model signals at prob 0.6, dense enough to clear the frequency bar
    // at every grid point below 0.6. Half the flow is "bad" trades that show
    // up only below 0.55, so a higher threshold has a better winRate.
    const good = makeSeries(MIN_THRESHOLD_BACKTEST_SAMPLES + 5, { stepSeconds: 5, probability: 0.6, winRate: 0.8 });
    const bad = good.map((s, i) => {
      const outcome: Signal['outcome'] = i % 5 === 0 ? 'win' : 'loss';
      return {
        ...s,
        id: `bad${i}`,
        calibratedProbability: 0.5,
        outcome,
      };
    });
    const result = computeThresholdCandidates([...good, ...bad], 0.75, 0.3);
    expect(result.recommendedThreshold).not.toBeNull();
    const rec = result.candidates.find((c) => c.threshold === result.recommendedThreshold);
    expect(rec?.meetsFrequencyTarget).toBe(true);
    expect(rec?.meetsAccuracyFloor).toBe(true);
  });

  it('exposes the documented target/tolerance constants used by the UI copy', () => {
    expect(TARGET_SIGNALS_PER_5MIN).toBe(1);
    expect(WINRATE_TOLERANCE).toBeCloseTo(0.03);
  });
});

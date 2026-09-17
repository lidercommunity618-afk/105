import { describe, it, expect } from 'vitest';
import type { Signal, SignalOutcome } from '@/types/domain';
import type { SimulatedTrade } from './simulator';
import {
  LOGIC_CHANGE_LOG,
  currentFreezeMs,
  isForwardTestTrade,
  computeForwardTestReport,
} from './change-registry';

// Тесты используют только те поля SimulatedTrade/Signal, которые реально
// читает computeMetrics()/computeForwardTestReport() — остальное типизации
// ради приведено через `as unknown as Signal`, как и в backtest.test.ts.
function makeTrade(entryTime: number, outcome: SignalOutcome, calibratedProbability = 0.6): SimulatedTrade {
  return {
    signal: { calibratedProbability } as unknown as Signal,
    outcome,
    rawOutcome: outcome,
    entryTime,
    candleIndex: 0,
    spreadCostR: 0,
    inSample: true,
  };
}

describe('LOGIC_CHANGE_LOG', () => {
  it('is non-empty and every entry has a valid frozenAtMs', () => {
    expect(LOGIC_CHANGE_LOG.length).toBeGreaterThan(0);
    for (const entry of LOGIC_CHANGE_LOG) {
      expect(Number.isFinite(entry.frozenAtMs)).toBe(true);
      expect(entry.frozenAtMs).toBeGreaterThan(0);
      expect(entry.id.length).toBeGreaterThan(0);
      expect(entry.filesChanged.length).toBeGreaterThan(0);
    }
  });
});

describe('currentFreezeMs', () => {
  it('returns the maximum frozenAtMs across the log', () => {
    const log = [
      { id: 'a', date: '2026-01-01', description: '', filesChanged: ['x'], frozenAtMs: 1000 },
      { id: 'b', date: '2026-01-02', description: '', filesChanged: ['x'], frozenAtMs: 5000 },
      { id: 'c', date: '2026-01-03', description: '', filesChanged: ['x'], frozenAtMs: 2000 },
    ];
    expect(currentFreezeMs(log)).toBe(5000);
  });

  it('returns 0 for an empty log', () => {
    expect(currentFreezeMs([])).toBe(0);
  });

  it('defaults to the real LOGIC_CHANGE_LOG when called without arguments', () => {
    expect(currentFreezeMs()).toBe(currentFreezeMs(LOGIC_CHANGE_LOG));
  });
});

describe('isForwardTestTrade', () => {
  it('treats entryTime (seconds) at or after freezeAtMs as forward-test', () => {
    const freezeAtMs = 1_000_000_000; // ms
    expect(isForwardTestTrade(1_000_000, freezeAtMs)).toBe(true); // 1_000_000s = 1_000_000_000ms, boundary
    expect(isForwardTestTrade(1_000_001, freezeAtMs)).toBe(true);
    expect(isForwardTestTrade(999_999, freezeAtMs)).toBe(false);
  });
});

describe('computeForwardTestReport', () => {
  const FREEZE = 1_000_000_000_000; // произвольный фиксированный момент в мс

  it('reports insufficient-data when there are zero forward trades', () => {
    const trades = [makeTrade(1, 'win'), makeTrade(2, 'loss')]; // все задолго до FREEZE
    const report = computeForwardTestReport(trades, FREEZE, 80);
    expect(report.forwardTradeCount).toBe(0);
    expect(report.hasEnoughSamples).toBe(false);
    expect(report.reliableWinRateLowerBound).toBeNull();
    expect(report.verdict).toBe('insufficient-data');
  });

  it('reports insufficient-data when forward trades exist but are fewer than MIN_THRESHOLD_BACKTEST_SAMPLES', () => {
    const freezeSec = FREEZE / 1000;
    const trades = Array.from({ length: 10 }, (_, i) => makeTrade(freezeSec + i, 'win'));
    const report = computeForwardTestReport(trades, FREEZE, 80);
    expect(report.forwardTradeCount).toBe(10);
    expect(report.hasEnoughSamples).toBe(false);
    expect(report.verdict).toBe('insufficient-data');
  });

  it('flags below-breakeven when the raw winRate itself is under the payout-derived breakeven', () => {
    const freezeSec = FREEZE / 1000;
    // 20 сделок, ровно 50% побед — ниже безубытка 55.56% при payout 80%.
    const trades = Array.from({ length: 20 }, (_, i) => makeTrade(freezeSec + i, i % 2 === 0 ? 'win' : 'loss'));
    const report = computeForwardTestReport(trades, FREEZE, 80);
    expect(report.hasEnoughSamples).toBe(true);
    expect(report.metrics.winRate).toBeCloseTo(0.5, 5);
    expect(report.verdict).toBe('below-breakeven');
  });

  it('flags above-breakeven-not-significant when raw winRate clears breakeven but the Wilson lower bound does not', () => {
    const freezeSec = FREEZE / 1000;
    // 20 сделок, 12 побед (60% raw) — выше безубытка 55.56%, но на n=20
    // нижняя граница Уилсона однозначно ниже 55.56%.
    const trades = Array.from({ length: 20 }, (_, i) => makeTrade(freezeSec + i, i < 12 ? 'win' : 'loss'));
    const report = computeForwardTestReport(trades, FREEZE, 80);
    expect(report.metrics.winRate).toBeCloseTo(0.6, 5);
    expect(report.reliableWinRateLowerBound).not.toBeNull();
    expect(report.reliableWinRateLowerBound as number).toBeLessThan(report.breakevenWinRate);
    expect(report.verdict).toBe('above-breakeven-not-significant');
  });

  it('flags significantly-above-breakeven with a large enough sample and high enough winRate', () => {
    const freezeSec = FREEZE / 1000;
    // 200 сделок, 75% побед — на такой выборке нижняя граница Уилсона
    // уверенно выше безубытка 55.56%.
    const trades = Array.from({ length: 200 }, (_, i) => makeTrade(freezeSec + i, i < 150 ? 'win' : 'loss'));
    const report = computeForwardTestReport(trades, FREEZE, 80);
    expect(report.hasEnoughSamples).toBe(true);
    expect(report.reliableWinRateLowerBound as number).toBeGreaterThan(report.breakevenWinRate);
    expect(report.verdict).toBe('significantly-above-breakeven');
  });

  it('ignores trades before the freeze date entirely, even if there are many of them', () => {
    const freezeSec = FREEZE / 1000;
    const preFreeze = Array.from({ length: 500 }, (_, i) => makeTrade(freezeSec - 1000 + i, 'win'));
    const report = computeForwardTestReport(preFreeze, FREEZE, 80);
    expect(report.forwardTradeCount).toBe(0);
    expect(report.verdict).toBe('insufficient-data');
  });

  it('a lower configured payout raises the breakeven bar used for the verdict', () => {
    const freezeSec = FREEZE / 1000;
    const trades = Array.from({ length: 20 }, (_, i) => makeTrade(freezeSec + i, i < 12 ? 'win' : 'loss')); // 60%
    const at80 = computeForwardTestReport(trades, FREEZE, 80);
    const at60 = computeForwardTestReport(trades, FREEZE, 60);
    expect(at60.breakevenWinRate).toBeGreaterThan(at80.breakevenWinRate);
  });
});

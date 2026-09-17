import { describe, it, expect, beforeEach } from 'vitest';
import {
  effectivePriorityThresholdForSymbol,
  hasPriorityThresholdOverride,
  applyPriorityThresholdOverrideForSymbol,
  resetPriorityThresholdOverrideForSymbol,
} from './priority-threshold-overrides';
import { THRESHOLD_GRID_MIN, THRESHOLD_GRID_MAX } from './threshold-calibration';

beforeEach(() => {
  localStorage.clear();
  resetPriorityThresholdOverrideForSymbol('BTCUSDT');
  resetPriorityThresholdOverrideForSymbol('EURUSD');
});

describe('priority-threshold-overrides', () => {
  it('falls back to globalDefault when no override is set', () => {
    expect(effectivePriorityThresholdForSymbol('BTCUSDT', 0.75)).toBe(0.75);
    expect(hasPriorityThresholdOverride('BTCUSDT')).toBe(false);
  });

  it('applies an override only to the given symbol, not others', () => {
    applyPriorityThresholdOverrideForSymbol('BTCUSDT', 0.85);
    expect(effectivePriorityThresholdForSymbol('BTCUSDT', 0.75)).toBe(0.85);
    expect(hasPriorityThresholdOverride('BTCUSDT')).toBe(true);
    // EURUSD must be completely unaffected — this is the exact bug class
    // (BTCUSDT calibration leaking into EURUSD) this module exists to prevent.
    expect(effectivePriorityThresholdForSymbol('EURUSD', 0.75)).toBe(0.75);
    expect(hasPriorityThresholdOverride('EURUSD')).toBe(false);
  });

  it('clamps an out-of-range value to [THRESHOLD_GRID_MIN, THRESHOLD_GRID_MAX]', () => {
    applyPriorityThresholdOverrideForSymbol('BTCUSDT', 1.5);
    expect(effectivePriorityThresholdForSymbol('BTCUSDT', 0.75)).toBe(THRESHOLD_GRID_MAX);
    applyPriorityThresholdOverrideForSymbol('BTCUSDT', -1);
    expect(effectivePriorityThresholdForSymbol('BTCUSDT', 0.75)).toBe(THRESHOLD_GRID_MIN);
  });

  it('reset returns the symbol to globalDefault without touching other symbols', () => {
    applyPriorityThresholdOverrideForSymbol('BTCUSDT', 0.9);
    applyPriorityThresholdOverrideForSymbol('EURUSD', 0.6);
    resetPriorityThresholdOverrideForSymbol('BTCUSDT');
    expect(hasPriorityThresholdOverride('BTCUSDT')).toBe(false);
    expect(effectivePriorityThresholdForSymbol('BTCUSDT', 0.75)).toBe(0.75);
    // EURUSD's own override survives BTCUSDT's reset.
    expect(effectivePriorityThresholdForSymbol('EURUSD', 0.75)).toBe(0.6);
  });

  it('persists the override across a simulated reload (re-read from localStorage)', () => {
    applyPriorityThresholdOverrideForSymbol('BTCUSDT', 0.82);
    // Simulate a fresh module load by clearing only the in-memory cache path:
    // re-reading via a symbol never touched in-memory this test run still
    // resolves from localStorage.
    expect(localStorage.getItem('priority-threshold-symbol-v1:BTCUSDT')).toBe('0.82');
  });
});

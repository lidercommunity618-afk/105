import { describe, it, expect } from 'vitest';
import type { Candle } from '@/types/domain';
import { detectMarketRegime } from '@/compute/indicators/market-regime';
import { computeStructure } from '@/compute/indicators/trend-structure';
import { detectImpulseBreakout } from '@/compute/patterns/impulse-breakout';

// These tests exist to prove Задача 0.1 (ATR-period unification) actually
// works end-to-end: previously every listed function hardcoded atr(candles,
// 14) internally, so config.atrPeriod silently had zero effect on anything
// except IndicatorAggregator's own snapshot.indicators.atr value. Now that
// atrPeriod is threaded as a real parameter, changing it must be able to
// change the output of computeStructure, detectMarketRegime, and every
// pattern detector that gates on ATR (impulse-breakout, consolidation-
// breakout, liquidity-sweep, liquidity-sweep-reaction and
// strong-order-block-reaction all share the exact same
// `atr(candles, atrPeriod)` call shape, so demonstrating it for one of them
// — the simplest, impulse-breakout — exercises the identical code path).

function makeCandle(
  time: number,
  open: number,
  close: number,
  high: number,
  low: number,
  volume = 100,
): Candle {
  return { time, open, high, low, close, volume };
}

describe('config.atrPeriod threading', () => {
  it('detectMarketRegime classifies the same candles differently depending on atrPeriod', () => {
    // Phase A (i=0..14): wide true range (~30). Phase B (i=15..39): tight
    // true range (~0.2). Closes drift by a constant +0.1/bar throughout,
    // PLUS a symmetric one-cycle wobble centered on the 20-bar recent
    // window (i=20..39, center i=29.5): this contributes ~0 net linear
    // slope over that window (so slopeAtr stays well under the 'trend'
    // threshold for both periods — see values below) but leaves genuine
    // curvature — i.e. actual residual dispersion around the trend line —
    // which is what normalizedVol is now supposed to measure.
    //
    // BUGFIX (аудит 2026-09-12, §5.1/§5.2, applied in market-regime.ts):
    // this test previously used a PURE linear drift with no wobble at all,
    // relying on the pre-fix normalizedVol = stdDev(raw price levels)/ATR,
    // which counted the drift itself as "volatility" (see the audit's
    // exact finding — a smoothly trending market's raw level-stdDev grows
    // with distance travelled even with zero actual noise, which is a
    // trend artefact, not a volatility measure). After the fix,
    // normalizedVol uses the std of RESIDUALS around the fitted trend line
    // (linearFit in market-regime.ts), so a pure drift with no noise now
    // correctly yields ~0 residual dispersion regardless of atrPeriod —
    // the fixed formula no longer discriminates by atrPeriod on that
    // input, which is the intended, corrected behaviour, not a bug. The
    // explicit wobble term added here restores real (non-trend) dispersion
    // so the test still demonstrates what it is meant to demonstrate: that
    // atrPeriod affects the classification (via atrValue in the
    // denominator), same recent-window residual dispersion/slope for both
    // calls below — only atrValue differs, because a short period
    // converges to the recent tight range while a longer period still
    // carries substantial weight from the early wide-range phase (Wilder
    // smoothing decays slowly).
    const candles: Candle[] = [];
    for (let i = 0; i < 40; i++) {
      const drift = i * 0.1;
      const wobble = 2 * Math.cos((2 * Math.PI * (i - 29.5)) / 20);
      const close = 100 + drift + wobble;
      if (i < 15) {
        candles.push(makeCandle(i * 60, close, close, close + 15.05, close - 15, 100));
      } else {
        candles.push(makeCandle(i * 60, close, close, close + 0.05, close - 0.15, 100));
      }
    }

    const shortPeriodRegime = detectMarketRegime(candles, 20, 5);
    const longPeriodRegime = detectMarketRegime(candles, 20, 35);

    expect(shortPeriodRegime).toBe('high-volatility');
    expect(longPeriodRegime).toBe('range');
    expect(shortPeriodRegime).not.toBe(longPeriodRegime);
  });

  it('computeStructure falls back to a different trend call depending on atrPeriod', () => {
    // Strictly monotonic high/low series (no local pivots exist at all, so
    // computeStructure must use its ATR-relative-slope fallback branch
    // regardless of lookback). Phase A (i=0..5): wide true range (~30).
    // Phase B (i=6..15): tight true range (~1). The constant +0.1/bar close
    // drift gives a fixed small positive slope; a short atrPeriod converges
    // to the tight recent range, making that slope large *relative* to ATR
    // (classified 'up'), while atrPeriod=14 (the old hardcoded default)
    // still carries enough weight from the wide early phase that the same
    // slope reads as noise (classified 'range').
    const candles: Candle[] = [];
    for (let i = 0; i < 16; i++) {
      const close = 100 + i * 0.1;
      const high = close + 0.5;
      const low = i < 6 ? close - 20 : close - 0.5;
      candles.push(makeCandle(i * 60, close, close, high, low, 100));
    }

    const shortPeriodStructure = computeStructure(candles, 50, true, 3);
    const defaultPeriodStructure = computeStructure(candles, 50, true, 14);

    expect(shortPeriodStructure.trend).toBe('up');
    expect(defaultPeriodStructure.trend).toBe('range');
  });

  it('detectImpulseBreakout fires or hard-blocks on the same breakout candle depending on atrPeriod', () => {
    // Phase A (i=0..5): wide true range (~30) with flat closes. Phase B
    // (i=6..30): tight, flat 1.0-wide range — this is also the 20-bar
    // lookback window used for rangeHigh/rangeLow, so the breakout candle
    // (i=31, body=4) clearly clears it. With atrPeriod=5 the ATR value has
    // fully decayed toward the tight recent range (~1.8), so body >= atrValue
    // passes the detector's hard block and confidence clears the entry
    // threshold. With atrPeriod=25 the ATR value still carries heavy weight
    // from the wide early phase (~6.4), so body < atrValue hard-blocks the
    // same candle into a null result.
    const candles: Candle[] = [];
    for (let i = 0; i < 31; i++) {
      if (i < 6) {
        candles.push(makeCandle(i * 60, 100, 100, 130, 100, 100));
      } else {
        candles.push(makeCandle(i * 60, 100, 100, 100.5, 99.5, 100));
      }
    }
    // Breakout candle: strong bullish body clearing the 20-bar range high
    // (100.5) with a volume spike (5x the trailing 20-bar average of 100).
    candles.push(makeCandle(31 * 60, 100, 104, 104.2, 99.8, 500));

    const shortPeriodResult = detectImpulseBreakout(candles, undefined, undefined, undefined, 20, 5);
    const longPeriodResult = detectImpulseBreakout(candles, undefined, undefined, undefined, 20, 25);

    expect(shortPeriodResult).not.toBeNull();
    expect(shortPeriodResult?.direction).toBe('buy');
    expect(longPeriodResult).toBeNull();
  });
});

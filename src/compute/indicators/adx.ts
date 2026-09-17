import type { Candle } from '@/types/domain';
import { nullArray } from './helpers';
import { trueRange } from './atr';

// Average Directional Index (Wilder). Same smoothing convention as atr.ts:
// prev = (prev * (period - 1) + value) / period.
//
// Used as a hard-filter in several M1 strategies (mean-reversion,
// impulse-breakout, consolidation-breakout) to distinguish trending vs
// ranging regimes — see bolt-prompt-8-strategies-replacement.md Phase 0.1.
export function adx(candles: Candle[], period: number = 14): (number | null)[] {
  const n = candles.length;
  const result = nullArray(n);
  // Need at least 2*period+1 bars: `period` bars to seed the first smoothed
  // +DM/-DM/TR sums, then another `period` DX values to seed the first ADX.
  if (n < period * 2 + 1) return result;

  const tr = trueRange(candles);
  const plusDM = new Array<number>(n).fill(0);
  const minusDM = new Array<number>(n).fill(0);

  for (let i = 1; i < n; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
  }

  // Wilder-smoothed averages, seeded as the simple average over the first
  // `period` bars (indices 1..period, since plusDM[0]/minusDM[0]/tr[0] have
  // no prior bar) — same seeding convention as atr.ts (`prev = sum / period`),
  // so the recurrence below (prev*(period-1)+new)/period stays consistent
  // and the +DI/-DI ratio comes out identical to the textbook "running sum"
  // formulation (both numerator and denominator are scaled by the same
  // 1/period factor at every step, so the ratio is unaffected).
  let sumTR = 0;
  let sumPlusDM = 0;
  let sumMinusDM = 0;
  for (let i = 1; i <= period; i++) {
    sumTR += tr[i];
    sumPlusDM += plusDM[i];
    sumMinusDM += minusDM[i];
  }
  let smoothedTR = sumTR / period;
  let smoothedPlusDM = sumPlusDM / period;
  let smoothedMinusDM = sumMinusDM / period;

  const dx: (number | null)[] = nullArray(n);

  const computeDx = (trVal: number, pDM: number, mDM: number): number | null => {
    if (trVal <= 0) return null;
    const plusDI = (100 * pDM) / trVal;
    const minusDI = (100 * mDM) / trVal;
    const sum = plusDI + minusDI;
    if (sum <= 0) return 0;
    return (100 * Math.abs(plusDI - minusDI)) / sum;
  };

  dx[period] = computeDx(smoothedTR, smoothedPlusDM, smoothedMinusDM);

  for (let i = period + 1; i < n; i++) {
    smoothedTR = (smoothedTR * (period - 1) + tr[i]) / period;
    smoothedPlusDM = (smoothedPlusDM * (period - 1) + plusDM[i]) / period;
    smoothedMinusDM = (smoothedMinusDM * (period - 1) + minusDM[i]) / period;
    dx[i] = computeDx(smoothedTR, smoothedPlusDM, smoothedMinusDM);
  }

  // Seed ADX as the simple average of the first `period` valid DX values,
  // then Wilder-smooth it forward (same recurrence as rsi.ts/atr.ts).
  const firstDxIdx = period;
  const seedEnd = firstDxIdx + period; // exclusive
  if (seedEnd > n) return result;

  let dxSum = 0;
  let dxCount = 0;
  for (let i = firstDxIdx; i < seedEnd; i++) {
    const v = dx[i];
    if (v === null) return result; // insufficient valid DX to seed ADX
    dxSum += v;
    dxCount++;
  }
  if (dxCount === 0) return result;

  let prevAdx = dxSum / dxCount;
  result[seedEnd - 1] = prevAdx;

  for (let i = seedEnd; i < n; i++) {
    const v = dx[i];
    if (v === null) {
      result[i] = null;
      continue;
    }
    prevAdx = (prevAdx * (period - 1) + v) / period;
    result[i] = prevAdx;
  }

  return result;
}

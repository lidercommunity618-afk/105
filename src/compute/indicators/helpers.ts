// Shared "institutional displacement" threshold used by every Order Block
// detector (smart-money.ts, order-block-strength.ts, super-order-block.ts)
// so a candle only counts as a genuine impulse — per the spec's "импульс
// должен быть сильным" rule — when its range clears this multiple of ATR,
// consistently across all three implementations.
export const DEFAULT_MIN_DISPLACEMENT_ATR_MULTIPLE = 1.2;
export const DEFAULT_DISPLACEMENT_ATR_PERIOD = 14;

export function nullArray(len: number): (number | null)[] {
  return Array.from({ length: len }, () => null);
}

export function zeroArray(len: number): number[] {
  return Array.from({ length: len }, () => 0);
}

export function lastNonNull(values: (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i] !== null) return values[i];
  }
  return null;
}

export function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export function averageVolume(candles: { volume: number }[], period: number, endExclusive: number): number {
  const start = Math.max(0, endExclusive - period);
  const slice = candles.slice(start, endExclusive);
  if (slice.length === 0) return 0;
  return slice.reduce((sum, c) => sum + c.volume, 0) / slice.length;
}

export function averageBody(candles: { open: number; close: number }[], period: number, endExclusive: number): number {
  const start = Math.max(0, endExclusive - period);
  const slice = candles.slice(start, endExclusive);
  if (slice.length === 0) return 0;
  return slice.reduce((sum, c) => sum + Math.abs(c.close - c.open), 0) / slice.length;
}

// Ratio of a single candle's volume to the average volume of the preceding
// `period` bars (tick-volume proxy for forex, same convention as elsewhere
// in this module). Used by the 8 M1 strategy detectors as a shared volume
// filter instead of each one re-deriving its own average-volume math.
export function volumeRatio(candles: { volume: number }[], index: number, period: number = 20): number {
  const avg = averageVolume(candles, period, index);
  if (avg <= 0) return 1;
  return candles[index].volume / avg;
}

// Whether any candle in the trailing `period` window carries real volume
// data. Forex/CFD OTC feeds (Deriv and most forex sources) always report
// volume: 0 — there is no consolidated tape, only per-broker tick counts,
// and most providers don't even forward those. averageVolume() silently
// returns 0 in that case and volumeRatio() maps avg<=0 to a neutral 1,
// which used to be indistinguishable from "genuinely thin, reliable
// volume of exactly the average". This helper makes that distinction
// explicit so a volume-based filter can be skipped (not just neutralized)
// when no real volume signal exists in the window, instead of silently
// gating on a proxy value of 1 forever — see impulse-breakout.ts.
export function hasReliableVolume(
  candles: { volume: number }[],
  index: number,
  period: number = 20,
): boolean {
  const start = Math.max(0, index - period + 1);
  const slice = candles.slice(start, index + 1);
  if (slice.length === 0) return false;
  return slice.some((c) => c.volume > 0);
}

export function zipTime(
  candles: { time: number }[],
  values: (number | null)[],
): Array<{ time: number; value: number | null }> {
  return candles.map((c, i) => ({ time: c.time, value: values[i] ?? null }));
}

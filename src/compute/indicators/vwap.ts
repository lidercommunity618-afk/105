import type { Candle } from '@/types/domain';
import { lastNonNull } from './helpers';

export interface VwapResult {
  values: (number | null)[];
  isProxyVolume: boolean;
}

export function vwap(
  candles: Candle[],
  period?: number,
  useProxyVolume: boolean = false,
): VwapResult {
  if (candles.length === 0) return { values: [], isProxyVolume: false };

  const slice = period ? candles.slice(-period) : candles;
  const offset = period ? candles.length - slice.length : 0;
  const result: (number | null)[] = Array.from({ length: candles.length }, () => null);

  const allZeroVolume = slice.every((c) => c.volume === 0);
  const useProxy = useProxyVolume || allZeroVolume;

  let cumPV = 0;
  let cumV = 0;
  for (let i = 0; i < slice.length; i++) {
    const c = slice[i];
    const weight = useProxy ? c.high - c.low : c.volume;
    if (weight > 0) {
      const typical = (c.high + c.low + c.close) / 3;
      cumPV += typical * weight;
      cumV += weight;
      result[offset + i] = cumV > 0 ? cumPV / cumV : null;
    }
  }
  return { values: result, isProxyVolume: useProxy };
}

const SECONDS_PER_DAY = 24 * 60 * 60;

/**
 * Number of trailing candles (counting back from the end of the array)
 * that fall on or after the most recent UTC-day boundary (00:00 UTC)
 * relative to the last candle's timestamp. Intended to be passed as the
 * `period` argument to vwap()/vwapLast() so the cumulative VWAP resets
 * daily instead of accumulating from the start of whatever window of
 * history happens to be in memory.
 *
 * BUGFIX (аудит 2026-09-12, п.1 "VWAP не имеет привязки к сессии/дню"):
 * every call site previously called vwapLast(candles) with no `period`,
 * so cumPV/cumV accumulated from the start of the in-memory candle buffer
 * (up to ~600 M1 bars / 10 hours, crossing Asia→London→NY and UTC-day
 * boundaries). That turns VWAP into a slow-moving multi-session average
 * instead of the intraday fair-price reference that the SMC/ICT "price
 * above/below VWAP" check (vwapSideOk, ~16% of FVG/OB scoring weight)
 * assumes — and it lags hardest, in a systematically directional way,
 * right after a long trend, which is exactly when a reversal check needs
 * VWAP to be responsive.
 */
export function vwapSessionPeriod(candles: Candle[]): number {
  if (candles.length === 0) return 0;
  const lastTime = candles[candles.length - 1].time;
  const dayStart = Math.floor(lastTime / SECONDS_PER_DAY) * SECONDS_PER_DAY;
  let count = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].time < dayStart) break;
    count++;
  }
  return count;
}

export interface VwapLastResult {
  value: number | null;
  isProxyVolume: boolean;
}

export function vwapLast(
  candles: Candle[],
  period?: number,
  useProxyVolume: boolean = false,
): VwapLastResult {
  const { values, isProxyVolume } = vwap(candles, period, useProxyVolume);
  return { value: lastNonNull(values), isProxyVolume };
}

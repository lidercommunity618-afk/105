import type { Candle } from '@/types/domain';
import { nullArray, zeroArray } from './helpers';

export function trueRange(candles: Candle[]): number[] {
  const tr = zeroArray(candles.length);
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      tr[i] = candles[i].high - candles[i].low;
    } else {
      const prevClose = candles[i - 1].close;
      tr[i] = Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - prevClose),
        Math.abs(candles[i].low - prevClose),
      );
    }
  }
  return tr;
}

export function atr(candles: Candle[], period: number): (number | null)[] {
  const tr = trueRange(candles);
  const result = nullArray(candles.length);
  if (candles.length <= period) return result;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  let prev = sum / period;
  result[period - 1] = prev;

  for (let i = period; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    result[i] = prev;
  }
  return result;
}

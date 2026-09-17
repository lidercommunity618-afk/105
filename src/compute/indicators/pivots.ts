import type { Candle } from '@/types/domain';

export const PIVOT_LOOKUP = 2;

export interface Pivot {
  index: number;
  price: number;
  type: 'high' | 'low';
}

export function findPivots(candles: Candle[], lookback: number = 50): { highs: Pivot[]; lows: Pivot[] } {
  const slice = candles.slice(-lookback);
  const offset = candles.length - slice.length;
  const highs: Pivot[] = [];
  const lows: Pivot[] = [];

  for (let i = PIVOT_LOOKUP; i < slice.length - PIVOT_LOOKUP; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= PIVOT_LOOKUP; j++) {
      if (slice[i].high < slice[i - j].high || slice[i].high < slice[i + j].high) isHigh = false;
      if (slice[i].low > slice[i - j].low || slice[i].low > slice[i + j].low) isLow = false;
    }
    if (isHigh) highs.push({ index: offset + i, price: slice[i].high, type: 'high' });
    if (isLow) lows.push({ index: offset + i, price: slice[i].low, type: 'low' });
  }
  return { highs, lows };
}

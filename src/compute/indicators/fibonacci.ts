import type { Candle } from '@/types/domain';

export interface FibonacciLevel {
  level: number;
  price: number;
}

const FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618];

export function fibonacciRetracement(candles: Candle[]): FibonacciLevel[] {
  if (candles.length < 10) return [];

  let swingHigh = -Infinity;
  let swingLow = Infinity;
  let swingHighIdx = 0;
  let swingLowIdx = 0;

  for (let i = 0; i < candles.length; i++) {
    if (candles[i].high > swingHigh) {
      swingHigh = candles[i].high;
      swingHighIdx = i;
    }
    if (candles[i].low < swingLow) {
      swingLow = candles[i].low;
      swingLowIdx = i;
    }
  }

  const isUptrend = swingHighIdx > swingLowIdx;
  const diff = swingHigh - swingLow;
  if (diff <= 0) return [];

  return FIB_RATIOS.map((ratio) => ({
    level: ratio,
    price: isUptrend ? swingHigh - diff * ratio : swingLow + diff * ratio,
  }));
}

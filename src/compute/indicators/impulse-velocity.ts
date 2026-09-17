import type { Candle } from '@/types/domain';
import { lastNonNull } from './helpers';
import { atr } from './atr';

// Proxy volume for forex: ratio of candle body to ATR.
// In UI this must be labeled "Volume Proxy", not "Volume".
export function computeImpulseVelocity(candles: Candle[], atrPeriod: number = 14): number | null {
  if (candles.length < atrPeriod + 1) return null;

  const atrArr = atr(candles, atrPeriod);
  const atrValue = lastNonNull(atrArr);
  if (atrValue === null || atrValue <= 0) return null;

  const lastCandle = candles[candles.length - 1];
  const body = Math.abs(lastCandle.close - lastCandle.open);
  return body / atrValue;
}

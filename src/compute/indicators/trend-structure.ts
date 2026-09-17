import type { Candle, MarketStructure } from '@/types/domain';
import { PIVOT_LOOKUP, findPivots } from './pivots';
import { atr } from './atr';
import { lastNonNull } from './helpers';

export function computeStructure(candles: Candle[], lookback: number = 50, isClosed: boolean = true, atrPeriod: number = 14): MarketStructure {
  if (candles.length < PIVOT_LOOKUP * 2 + 3) {
    return { trend: 'range', bos: false, choch: false, swingHigh: null, swingLow: null, provisional: !isClosed };
  }

  const slice = candles.slice(-lookback);
  const { highs, lows } = findPivots(candles, lookback);

  const lastCandle = slice[slice.length - 1];
  const prevCandle = slice[slice.length - 2];

  const recentHighs = highs.slice(-3);
  const recentLows = lows.slice(-3);
  const swingHigh = recentHighs.length > 0 ? recentHighs[recentHighs.length - 1].price : Math.max(...slice.map((c) => c.high));
  const swingLow = recentLows.length > 0 ? recentLows[recentLows.length - 1].price : Math.min(...slice.map((c) => c.low));

  let trend: 'up' | 'down' | 'range' = 'range';
  if (recentHighs.length >= 2 && recentLows.length >= 2) {
    const higherHighs = recentHighs[recentHighs.length - 1].price > recentHighs[0].price;
    const higherLows = recentLows[recentLows.length - 1].price > recentLows[0].price;
    const lowerHighs = recentHighs[recentHighs.length - 1].price < recentHighs[0].price;
    const lowerLows = recentLows[recentLows.length - 1].price < recentLows[0].price;
    if (higherHighs && higherLows) trend = 'up';
    else if (lowerHighs && lowerLows) trend = 'down';
  } else {
    const first = slice[0];
    const slope = (lastCandle.close - first.close) / Math.max(1, slice.length);
    const atrArr = atr(candles, atrPeriod);
    const atrValue = lastNonNull(atrArr);
    const atrApprox = atrValue ?? Math.abs(lastCandle.high - lastCandle.low);
    if (slope > atrApprox * 0.05) trend = 'up';
    else if (slope < -atrApprox * 0.05) trend = 'down';
  }

  let bos = false;
  let choch = false;

  // Range has no established direction to change, so a breakout either way
  // is a fresh BOS (structure forming where none existed), never a CHoCH —
  // "change of character" presupposes a character to change. The previous
  // asymmetric version treated an up-break out of range as bos (bullish
  // boost) and a down-break as choch (bearish 0.7x penalty in
  // impulse-breakout.ts and elsewhere), which had no market justification
  // and produced a systematic bullish skew on every range-regime signal.
  if (trend === 'range') {
    bos =
      (lastCandle.close > swingHigh && prevCandle.close <= swingHigh) ||
      (lastCandle.close < swingLow && prevCandle.close >= swingLow);
    choch = false;
  }
  if (trend === 'up') {
    bos = lastCandle.close > swingHigh && prevCandle.close <= swingHigh;
    choch = lastCandle.close < swingLow && prevCandle.close >= swingLow;
  }
  if (trend === 'down') {
    bos = lastCandle.close < swingLow && prevCandle.close >= swingLow;
    choch = lastCandle.close > swingHigh && prevCandle.close <= swingHigh;
  }

  return { trend, bos, choch, swingHigh, swingLow, provisional: !isClosed };
}

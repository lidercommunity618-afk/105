import type { Candle } from '@/types/domain';

export type TrendDirection = 'up' | 'down';

export function checkPriorTrend(
  candles: Candle[],
  direction: TrendDirection,
  minCandles: number = 5,
): boolean {
  if (candles.length < minCandles) return false;
  const first = candles[0].close;
  const last = candles[candles.length - 1].close;
  if (direction === 'up') return last > first;
  return last < first;
}

export function checkTrendStrength(
  candles: Candle[],
  direction: TrendDirection,
  minCandles: number = 5,
): number {
  if (candles.length < minCandles) return 0;
  const slice = candles.slice(-minCandles);
  let bullCount = 0;
  let bearCount = 0;
  for (const c of slice) {
    if (c.close > c.open) bullCount++;
    else if (c.close < c.open) bearCount++;
  }
  if (direction === 'up') return bullCount / minCandles;
  return bearCount / minCandles;
}

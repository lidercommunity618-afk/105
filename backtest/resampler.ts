import type { Candle, Timeframe } from '@/types/domain';
import { TIMEFRAME_SECONDS } from '@/data/symbols';

export function resample(candles: Candle[], targetTimeframe: Timeframe): Candle[] {
  if (targetTimeframe === '1m') return [...candles];

  const tfSeconds = TIMEFRAME_SECONDS[targetTimeframe];
  const result: Candle[] = [];
  let current: Candle | null = null;
  let currentBucket = -1;

  for (const c of candles) {
    const bucket = Math.floor(c.time / tfSeconds) * tfSeconds;

    if (current === null || bucket !== currentBucket) {
      if (current !== null) result.push(current);
      currentBucket = bucket;
      current = {
        time: bucket,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      };
    } else {
      current.high = Math.max(current.high, c.high);
      current.low = Math.min(current.low, c.low);
      current.close = c.close;
      current.volume += c.volume;
    }
  }

  if (current !== null) result.push(current);
  return result;
}

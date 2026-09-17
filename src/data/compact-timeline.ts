import type { Candle, Timeframe, AssetClass } from '@/types/domain';
import { TIMEFRAME_SECONDS } from '@/data/symbols';

const SUNDAY = 0;
const SATURDAY = 6;

export function compactTimeline(
  candles: Candle[],
  timeframe: Timeframe,
  assetClass: AssetClass = 'forex',
): Candle[] {
  if (candles.length < 2) return candles;
  const tfSec = TIMEFRAME_SECONDS[timeframe];
  const out: Candle[] = [];
  let prevTime: number | null = null;
  let lastPushedClose: number | null = null;

  for (const c of candles) {
    if (assetClass !== 'crypto' && isWeekendUtc(c.time) && isWeekendUtc(c.time + tfSec)) {
      continue;
    }
    if (prevTime !== null && lastPushedClose !== null) {
      const gapSec = c.time - prevTime;
      const missing = Math.floor(gapSec / tfSec) - 1;
      for (let i = 1; i <= missing && i > 0; i++) {
        out.push({
          time: prevTime + tfSec * i,
          open: lastPushedClose,
          high: lastPushedClose,
          low: lastPushedClose,
          close: lastPushedClose,
          volume: 0,
        });
      }
    }
    out.push(c);
    prevTime = c.time;
    lastPushedClose = c.close;
  }
  return out;
}

function isWeekendUtc(timeSec: number): boolean {
  const day = new Date(timeSec * 1000).getUTCDay();
  return day === SUNDAY || day === SATURDAY;
}

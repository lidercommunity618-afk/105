import type { Candle } from '@/types/domain';

export interface LiquidityPool {
  price: number;
  type: 'buy-side' | 'sell-side';
  touches: number;
}

export function liquidityPools(candles: Candle[], lookback: number = 50): LiquidityPool[] {
  if (candles.length < 5) return [];

  const slice = candles.slice(-lookback);
  const equalBars = Math.min(3, Math.floor(slice.length / 3));
  const pools: LiquidityPool[] = [];
  const tolerance = computeTolerance(slice);

  const highs = slice.map((c) => c.high);
  const lows = slice.map((c) => c.low);

  const swingHighs = findEqualLevels(highs, equalBars, tolerance);
  const swingLows = findEqualLevels(lows, equalBars, tolerance);

  for (const sh of swingHighs) {
    pools.push({ price: sh.price, type: 'sell-side', touches: sh.touches });
  }
  for (const sl of swingLows) {
    pools.push({ price: sl.price, type: 'buy-side', touches: sl.touches });
  }

  return pools;
}

interface EqualLevel {
  price: number;
  touches: number;
}

function findEqualLevels(prices: number[], bars: number, tolerance: number): EqualLevel[] {
  const levels: EqualLevel[] = [];
  for (let i = bars; i < prices.length - bars; i++) {
    let isExtreme = true;
    for (let j = 1; j <= bars; j++) {
      if (prices[i] < prices[i - j] || prices[i] < prices[i + j]) {
        isExtreme = false;
        break;
      }
    }
    if (!isExtreme) continue;

    const existing = levels.find((l) => Math.abs(l.price - prices[i]) < tolerance);
    if (existing) {
      existing.touches++;
    } else {
      levels.push({ price: prices[i], touches: 1 });
    }
  }
  return levels;
}

function computeTolerance(candles: Candle[]): number {
  const ranges = candles.slice(-20).map((c) => c.high - c.low);
  const avgRange = ranges.reduce((a, b) => a + b, 0) / Math.max(1, ranges.length);
  return avgRange * 0.2;
}

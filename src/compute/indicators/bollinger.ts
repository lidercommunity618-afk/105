import { nullArray } from './helpers';
import { sma } from './ema';

export interface BollingerResult {
  upper: (number | null)[];
  middle: (number | null)[];
  lower: (number | null)[];
}

export function bollinger(
  closes: number[],
  period: number,
  stdDevMult: number,
): BollingerResult {
  const middle = sma(closes, period);
  const upper = nullArray(closes.length);
  const lower = nullArray(closes.length);

  for (let i = period - 1; i < closes.length; i++) {
    const m = middle[i];
    if (m === null) continue;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) {
      variance += (closes[j] - m) ** 2;
    }
    const sd = Math.sqrt(variance / period);
    upper[i] = m + stdDevMult * sd;
    lower[i] = m - stdDevMult * sd;
  }
  return { upper, middle, lower };
}

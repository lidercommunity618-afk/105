import { nullArray } from './helpers';
import { ema } from './ema';

export interface MacdResult {
  macd: (number | null)[];
  signal: (number | null)[];
  histogram: (number | null)[];
}

export function macd(
  closes: number[],
  fast: number,
  slow: number,
  signalPeriod: number,
): MacdResult {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine: (number | null)[] = closes.map((_, i) =>
    emaFast[i] !== null && emaSlow[i] !== null
      ? emaFast[i] - emaSlow[i]
      : null,
  );

  const firstValidIdx = macdLine.findIndex((v) => v !== null);
  const signal: (number | null)[] = nullArray(closes.length);
  if (firstValidIdx >= 0) {
    const validMacd = macdLine.slice(firstValidIdx).map((v) => v as number);
    const signalRaw = ema(validMacd, signalPeriod);
    for (let i = 0; i < signalRaw.length; i++) {
      signal[firstValidIdx + i] = signalRaw[i];
    }
  }

  const histogram = macdLine.map((v, i) =>
    v !== null && signal[i] !== null ? v - signal[i] : null,
  );
  return { macd: macdLine, signal, histogram };
}

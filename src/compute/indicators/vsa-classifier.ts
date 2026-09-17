import type { Candle } from '@/types/domain';
import { lastNonNull } from './helpers';
import { atr } from './atr';

// Single-bar VSA classifier. Limited signal: one bar cannot capture
// the full supply/demand context. Low weight in scoring.
export interface VsaClassification {
  signal: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
}

export function classifyVsa(candles: Candle[], atrPeriod: number = 14): VsaClassification {
  if (candles.length < atrPeriod + 1) {
    return { signal: 'neutral', confidence: 0 };
  }

  const atrArr = atr(candles, atrPeriod);
  const atrValue = lastNonNull(atrArr);
  if (atrValue === null || atrValue <= 0) {
    return { signal: 'neutral', confidence: 0 };
  }

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const body = Math.abs(last.close - last.open);
  const range = last.high - last.low;
  const upperWick = last.high - Math.max(last.close, last.open);
  const lowerWick = Math.min(last.close, last.open) - last.low;

  const isWideRange = range > atrValue * 1.5;
  const isHighVolume = last.volume > 0 && last.volume > avgVolume(candles, 20) * 1.5;

  if (isWideRange && body > range * 0.6 && last.close > prev.close) {
    return { signal: 'bullish', confidence: isHighVolume ? 0.6 : 0.4 };
  }
  if (isWideRange && body > range * 0.6 && last.close < prev.close) {
    return { signal: 'bearish', confidence: isHighVolume ? 0.6 : 0.4 };
  }
  // BUGFIX (аудит 2026-09-12, п.4 "половина классификатора игнорирует
  // объём"): в отличие от двух веток выше (wide-range), эти две реагировали
  // только на геометрию фитиля/тела (по сути детектор hammer/shooting-star),
  // никак не проверяя объём — то есть по факту не были VSA (Volume Spread
  // Analysis) в смысле Уайкоффа/Уильямса. Теперь объём учтён так же, как и в
  // ветках выше: геометрия остаётся обязательным условием (её отсутствие по-
  // прежнему даёт neutral), а высокий объём на баре повышает confidence — это
  // и есть VSA-прочтение "climax"-разворота, а не просто фигура свечи.
  if (lowerWick > body * 2 && last.close > last.open) {
    return { signal: 'bullish', confidence: isHighVolume ? 0.5 : 0.35 };
  }
  if (upperWick > body * 2 && last.close < last.open) {
    return { signal: 'bearish', confidence: isHighVolume ? 0.5 : 0.35 };
  }

  return { signal: 'neutral', confidence: 0 };
}

function avgVolume(candles: Candle[], period: number): number {
  const slice = candles.slice(-period).filter((c) => c.volume > 0);
  if (slice.length === 0) return 0;
  return slice.reduce((a, b) => a + b.volume, 0) / slice.length;
}

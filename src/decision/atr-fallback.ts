import type { IndicatorSnapshot } from '@/types/domain';

// Вынесено из decision/trade-levels.ts при удалении файла (Фаза 1, "честный
// бинарный опцион" — SL/TP убраны из движка целиком). Эта пара функций не
// имеет отношения к стопу/цели — это запасной расчёт волатильности (ATR),
// когда snapshot.indicators.atr ещё null (прогрев индикатора не завершён).
// Используется signal-builder.ts для оценки volatility-adaptive expiry
// (recommended-expiry.ts) и гейта по спреду — оба живут и без какого-либо
// понятия стопа/цели.
export function avgRangeFromSnapshot(
  candles: { high: number; low: number }[],
  period: number,
): number {
  const slice = candles.slice(-period);
  if (slice.length === 0) return 0;
  let sum = 0;
  for (const c of slice) sum += c.high - c.low;
  return sum / slice.length;
}

export function fallbackAtr(snapshot: IndicatorSnapshot, candles: { high: number; low: number }[], period: number): number {
  if (snapshot.atr !== null && snapshot.atr > 0) return snapshot.atr;
  return avgRangeFromSnapshot(candles, period);
}

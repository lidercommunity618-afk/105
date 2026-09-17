import type { Candle, MarketStructure } from '@/types/domain';
import { computeStructure } from './trend-structure';

// BUGFIX (аудит 2026-09-06, п.3 "псевдо-HTF bias"): до этого фикса "HTF"
// структура в двух местах (strong-order-block-reaction.ts через ctx.structure
// напрямую, mean-reversion.ts через локальную переменную htfStructure в
// patterns/index.ts) на самом деле пересчитывала computeStructure() на ТЕХ ЖЕ
// САМЫХ M1-свечах, просто с более широким lookback (60 баров вместо 50).
// Это не старший таймфрейм — это тот же M1-график, который в диапазоне
// (regime='range') может переключать trend каждые несколько баров, создавая
// иллюзию мультитаймфреймового подтверждения там, где его физически нет (см.
// сделку 20:16 BUY, strong-order-block-reaction, score 5.6 — HTF bias был
// формально "satisfied" структурой, посчитанной 13 минутами позже сама себя
// пересчитавшей на sell-сторону).
//
// Здесь вместо этого M1-свечи агрегируются в настоящие M15-бары (ресэмплинг
// OHLCV, как в backtest/resampler.ts), и MarketStructure считается уже по
// НИМ — трендовая разметка теперь физически привязана к другому, более
// медленному таймфрейму, а не к другому lookback-окну того же самого.
export const HTF_BUCKET_SECONDS = 15 * 60; // M15

/**
 * Ресэмплит M1 (или любые более мелкие) свечи в бары длительностью
 * bucketSeconds, стандартным OHLCV-агрегированием (open первой свечи бакета,
 * close последней, high/low — экстремумы, volume — сумма). Свечи должны быть
 * отсортированы по времени по возрастанию (как и everywhere else в проекте).
 */
export function aggregateToHigherTimeframe(candles: Candle[], bucketSeconds: number = HTF_BUCKET_SECONDS): Candle[] {
  if (candles.length === 0) return [];
  const buckets: Candle[] = [];
  let current: Candle | null = null;
  let currentBucketStart = -1;

  for (const c of candles) {
    const bucketStart = Math.floor(c.time / bucketSeconds) * bucketSeconds;
    if (current === null || bucketStart !== currentBucketStart) {
      current = { time: bucketStart, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
      currentBucketStart = bucketStart;
      buckets.push(current);
    } else {
      current.high = Math.max(current.high, c.high);
      current.low = Math.min(current.low, c.low);
      current.close = c.close;
      current.volume += c.volume;
    }
  }
  return buckets;
}

/**
 * Настоящая HTF (M15-по-умолчанию) структура рынка, посчитанная на
 * ресэмплированных барах, а не на M1 с другим lookback. Последний M15-бар
 * почти никогда не закрыт (M1-фид почти никогда не заканчивается ровно на
 * границе 15 минут) — считаем его provisional=true всегда через
 * computeStructure(..., isClosed=false), независимо от того, закрыта ли
 * последняя M1-свеча, чтобы не выдавать частично сформированный M15-бар за
 * подтверждённую структуру.
 */
export function computeHtfStructure(
  m1Candles: Candle[],
  atrPeriod: number = 14,
  bucketSeconds: number = HTF_BUCKET_SECONDS,
): MarketStructure {
  const htfCandles = aggregateToHigherTimeframe(m1Candles, bucketSeconds);
  return computeStructure(htfCandles, 50, false, atrPeriod);
}

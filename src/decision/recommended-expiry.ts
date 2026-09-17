import type { Timeframe } from '@/types/domain';
import { TIMEFRAME_SECONDS } from '@/data/symbols';

// BUGFIX (аудит 2026-09-06, п.7 "экспирация слишком жёсткая для чопа"):
// раньше экспирация зависела только от volatilityPct (ATR/цена) и никогда —
// от regime/ADX. В range-режиме со слабым/угасающим трендом (тот же случай,
// что гейтится в signal-filters.ts REGIME_GATE_ADX_THRESHOLD) 3 бара почти
// не оставляют права на ошибку: при ATR ~27-30 на BTCUSDT M1 разворот на
// пару баров съедает весь стоп ещё до резолва. Для сигналов, прошедших
// regime-гейт только с мягким штрафом (ADX в [20,30), см. signal-filters.ts —
// ниже 20 сигнал теперь не создаётся вовсе, п.1), экспирация увеличивается на
// один бар относительно того, что дала бы чистая волатильность — не полная
// компенсация риска, но явно бОльший запас на резолв, чем в трендовом
// режиме с тем же ATR.
export function recommendedExpiry(
  timeframe: Timeframe,
  atr: number,
  entryPrice: number,
  isRangeWithWeakTrend: boolean = false,
): number {
  if (atr <= 0 || entryPrice <= 0) return TIMEFRAME_SECONDS[timeframe];
  const volatilityPct = atr / entryPrice;
  const baseBars = volatilityPct < 0.005 ? 3 : volatilityPct < 0.01 ? 2 : 1;
  const bars = isRangeWithWeakTrend ? baseBars + 1 : baseBars;
  return Math.round(TIMEFRAME_SECONDS[timeframe] * bars);
}

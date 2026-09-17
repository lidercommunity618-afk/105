import type { Candle, PatternResult, SignalStrength, MarketStructure } from '@/types/domain';
import { lastNonNull, volumeRatio, hasReliableVolume } from '@/compute/indicators/helpers';
import { atr } from '@/compute/indicators/atr';
import type { SessionRegime } from '@/compute/session-regime';
import type { SmartMoneyResult } from '@/compute/indicators/smart-money';
import { checkTrendStrength } from './trend-utils';
import {
  sessionBoost,
  htfAlignment,
  isAsiaOrClosed,
  isNearSwingLevel,
  obFvgConfluenceBonus,
  intervalSeconds,
} from './pattern-context';

function strengthForConfidence(confidence: number): SignalStrength {
  if (confidence >= 0.75) return 'strong';
  if (confidence >= 0.5) return 'moderate';
  return 'weak';
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

const ENTRY_THRESHOLD = 0.65;
const MIN_VOLUME_RATIO = 1.5;
const MIN_DEPTH_ATR = 0.3;
const MAX_DEPTH_ATR = 2.0;

// Liquidity sweep (ICT): price spikes beyond a recent extreme, on volume,
// then closes back inside the range — see bolt-prompt-8-strategies-replacement.md
// Phase 1.1 ("СТРАТЕГИЯ «LIQUIDITY SWEEP (ICT)»").
export function detectLiquiditySweep(
  candles: Candle[],
  structure: MarketStructure,
  session: SessionRegime,
  smartMoney: SmartMoneyResult,
  lookback: number = 20,
  atrPeriod: number = 14,
): PatternResult | null {
  if (candles.length < lookback + 1) return null;

  const atrArr = atr(candles, atrPeriod);
  const atrValue = lastNonNull(atrArr);
  if (atrValue === null || atrValue <= 0) return null;

  const slice = candles.slice(-lookback - 1, -1);
  const recentHigh = Math.max(...slice.map((c) => c.high));
  const recentLow = Math.min(...slice.map((c) => c.low));
  const last = candles[candles.length - 1];
  const lastIdx = candles.length - 1;

  let direction: 'buy' | 'sell' | null = null;
  let depth = 0;

  // Bullish sweep: spikes below recent low then closes back above it
  if (last.low < recentLow && last.close > recentLow) {
    direction = 'buy';
    depth = recentLow - last.low;
  } else if (last.high > recentHigh && last.close < recentHigh) {
    // Bearish sweep: spikes above recent high then closes back below it
    direction = 'sell';
    depth = last.high - recentHigh;
  }

  if (direction === null) return null;

  // Глубина прокола в единицах ATR — вычисляется здесь (до тренд-контекста),
  // потому что сценарий "разворот у ключевого уровня" ниже сам зависит от
  // depthInAtr (спецификация требует ≥0.5×ATR именно для разворотных
  // сетапов, не только общий диапазон 0.3–2.0 для обоих сценариев).
  const depthInAtr = depth / atrValue;

  // 1. Тренд-контекст перед sweep — ДВА равноправных валидных сценария
  //    (аудит "Реакция на снятие ликвидности", находка №7; см. также
  //    strategy doc §3 "Продолжение" / "Разворот у ключевого уровня"):
  //
  //    а) Continuation — sweep в сторону уже идущего движения:
  //       structure.trend уже указывает нужное направление, либо минимум
  //       5 из последних 7 баров — свечи в сторону движения
  //       (checkTrendStrength из trend-utils.ts). Это классический ICT
  //       "sweep of a retracement low/high before continuation".
  //
  //    б) Reversal-at-key-level — Wyckoff Spring/Upthrust: sweep ПРОТИВ
  //       текущего тренда, но ровно на структурно значимом swing-уровне
  //       (isNearSwingLevel) и с достаточной глубиной прокола (≥0.5×ATR).
  //       Старая версия кода допускала только (а), из-за чего ни один
  //       классический Spring/Upthrust не мог пройти фильтр — а это как
  //       раз тот случай, который пользователь и трейдеры называют
  //       "реакцией на снятие ликвидности" в первую очередь.
  const trendDirection = direction === 'buy' ? 'up' : 'down';
  const structureAligned = structure.trend === trendDirection;
  const barTrendStrength = checkTrendStrength(candles, trendDirection, 7);
  const isContinuation = structureAligned || barTrendStrength >= 5 / 7;
  const isReversalAtKeyLevel = isNearSwingLevel(structure, last, atrValue) && depthInAtr >= 0.5;
  if (!isContinuation && !isReversalAtKeyLevel) return null;
  const setupType: 'continuation' | 'reversal-at-key-level' = isContinuation
    ? 'continuation'
    : 'reversal-at-key-level';

  // 4. Диапазон глубины прокола (общий для обоих сценариев) — вне
  //    0.3–2.0 ATR это уже не убедительный sweep (либо слишком мелкий шум,
  //    либо настоящий пробой структуры в противоположную сторону).
  if (depthInAtr > MAX_DEPTH_ATR) return null;
  if (depthInAtr < MIN_DEPTH_ATR) return null;

  // 5. Объёмный фильтр — НЕ жёсткий блок, а условное усиление (аудит,
  //    находка №1). На споте Форекс через REST-провайдеров (TwelveData/
  //    Yahoo/Finnhub) объём либо отсутствует, либо всегда 0 — это
  //    задокументированное ограничение OTC-рынка (см. helpers.ts,
  //    hasReliableVolume). Раньше volumeRatio() тихо возвращала 1 для
  //    avg<=0, что ВСЕГДА проваливало жёсткий порог 1.5 — сигнал не мог
  //    сработать вообще, независимо от качества структурной картины.
  //    Теперь: фильтр применяется, только если объём реально доступен;
  //    иначе — не штрафуем и не поощряем, полагаемся на структурные
  //    условия (глубина, тренд-контекст, конфлюэнс, сессия).
  const volumeReliable = hasReliableVolume(candles, lastIdx, 20);
  const volRatio = volumeReliable ? volumeRatio(candles, lastIdx, 20) : null;
  if (volumeReliable && volRatio! < MIN_VOLUME_RATIO) return null;

  // 6. Конфлюэнс с OB/FVG старшего ТФ либо со swing-уровнем структуры —
  //    не hard-блок, а понижающий/повышающий мультипликатор confidence.
  const intervalSec = intervalSeconds(candles);
  const confluenceBonus = obFvgConfluenceBonus(smartMoney, last, direction, atrValue, intervalSec);
  const nearSwing = isNearSwingLevel(structure, last, atrValue);

  let confidence = clamp01(depthInAtr / 1.5);

  if (isAsiaOrClosed(session)) {
    confidence *= 0.6;
  } else {
    confidence *= sessionBoost(session);
  }

  confidence *= 1 + confluenceBonus;
  if (confluenceBonus === 0 && !nearSwing) confidence *= 0.8;

  // htfAlignment() is written for the continuation scenario — it penalizes
  // any sweep that isn't in the direction of structure.trend, which is
  // EXACTLY what a legitimate reversal-at-key-level (Spring/Upthrust) setup
  // looks like by construction. Applying it here would undo the trend-
  // context gate above (a real reversal would get the same ~0.5x penalty as
  // an ambiguous, unconfirmed counter-trend guess). Reversal setups already
  // passed their own, stricter bar (swing-level proximity + depth >=0.5x
  // ATR) — a mild discount (0.9) reflects the residual extra risk of fading
  // a trend, without re-imposing the continuation-only logic that would
  // otherwise make this setup unreachable in practice.
  confidence *= setupType === 'reversal-at-key-level' ? 0.9 : htfAlignment(structure, direction);

  confidence = clamp01(confidence);
  if (confidence < ENTRY_THRESHOLD) return null;

  return {
    name: 'liquidity-sweep',
    direction,
    confidence,
    strength: strengthForConfidence(confidence),
    time: last.time,
    // Honest volume confirmation (audit finding #1/#3): only true when
    // volume data was actually reliable AND the bar cleared 2x its average —
    // never a hardcoded true. Feeds applyConfidenceHierarchy()'s +0.1
    // volumeConfirmed bonus in patterns/index.ts with a real signal instead
    // of a constant that made every surviving sweep get the same flat bonus.
    volumeConfirmed: volumeReliable ? volRatio! >= 2.0 : false,
    setupType,
  };
}

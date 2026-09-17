import type { Candle, PatternResult, IndicatorSnapshot } from '@/types/domain';
import type { SessionRegime } from '@/compute/session-regime';
import type { SmartMoneyResult } from '@/compute/indicators/smart-money';
import { rsi as calcRsi } from '@/compute/indicators/rsi';
import { vwapLast, vwapSessionPeriod } from '@/compute/indicators/vwap';
import { lastNonNull, volumeRatio } from '@/compute/indicators/helpers';
import { nextCandleConfirmation, intervalSeconds } from './pattern-context';
import {
  pickFreshUnbrokenFvgs,
  vwapSideOk,
  rsiConfirmOk,
  ema50AlignedOk,
  atrNotSpiking,
  wickRatio,
  scoreFvgSignal,
  FVG_SCORE_MAX,
  FVG_SCORE_MIN_ENTRY,
  strengthForFvgScore,
} from './fvg-strategies-shared';

const MAX_AGE_BARS = 15;
const MIN_HISTORY = 30;
const MIN_WICK_RATIO = 0.35;

// Strategy B — "FVG + Breaker Block" (Усиленная), doc §3:
//   - Price broke a key level (approximated here by hasBOSConfluence — the
//     FVG formed within BOS_CONFLUENCE_LOOKBACK_BARS of a same-direction
//     structural break, see smart-money.ts).
//   - A FVG formed in the breakout direction.
//   - On return to the FVG, a Breaker Block forms: a candle with a long
//     wick piercing the zone while its body stays outside it.
//   Signal: break of that wick in the direction of the original impulse —
//   modeled with the same next-candle confirmation logic used by the
//   engulfing/piercing-line pattern detectors (pattern-context.ts).
export function detectFvgBreakerBlock(
  candles: Candle[],
  snapshot: IndicatorSnapshot | undefined,
  session: SessionRegime,
  smartMoney: SmartMoneyResult,
): PatternResult | null {
  if (candles.length < MIN_HISTORY) return null;

  const last = candles[candles.length - 1];
  const patternCandle = candles[candles.length - 2];
  const intervalSec = intervalSeconds(candles);

  for (const wantType of ['bullish', 'bearish'] as const) {
    const direction: 'buy' | 'sell' = wantType === 'bullish' ? 'buy' : 'sell';

    const candidates = pickFreshUnbrokenFvgs(smartMoney.fvgs, wantType, patternCandle.time, intervalSec, MAX_AGE_BARS)
      .filter((f) => f.hasBOSConfluence);
    if (candidates.length === 0) continue;
    const fvg = candidates[candidates.length - 1];

    // BUGFIX (аудит 2026-09-12, п.3): раньше "close >= fvg.bottom" (buy) /
    // "close <= fvg.top" (sell) допускало закрытие ГДЕ УГОДНО внутри зоны —
    // требования "тело закрылось СНАРУЖИ зоны", описанного в докстринге
    // этого файла выше ("body stays outside it"), физически не было. Теперь
    // разделено на два условия по образцу order-block-breaker.ts (та же
    // "wick-then-confirmation" геометрия, см. комментарий в том файле):
    // сначала фитиль реально вошёл в зону, затем тело ПОЛНОСТЬЮ закрылось
    // снаружи неё — на стороне, откуда пришёл первоначальный импульс.
    const enteredZone = patternCandle.low <= fvg.top && patternCandle.high >= fvg.bottom;
    if (!enteredZone) continue;
    const closedBackOutside = direction === 'buy'
      ? patternCandle.close >= fvg.top
      : patternCandle.close <= fvg.bottom;
    if (!closedBackOutside) continue;

    const wr = wickRatio(patternCandle, direction === 'buy' ? 'lower' : 'upper');
    if (wr < MIN_WICK_RATIO) continue;

    const confirmation = nextCandleConfirmation(patternCandle, last, direction);
    if (!confirmation.confirmed) continue;

    const atrValue = snapshot?.atr ?? null;
    const rsiFast = lastNonNull(calcRsi(candles.map((c) => c.close), 7));
    const vwapValue = vwapLast(candles, vwapSessionPeriod(candles)).value;
    const ema50Value = snapshot?.emaSlow ?? null;
    const volRatio = volumeRatio(candles, candles.length - 1, 20);

    const score = scoreFvgSignal({
      emaAligned: ema50AlignedOk(direction, last.close, ema50Value),
      vwapAligned: vwapSideOk(direction, last.close, vwapValue),
      rsiConfirmed: rsiConfirmOk(direction, rsiFast),
      volumeConfirmed: volRatio > 1.5,
      // This strategy's own defining confluence is a dominant breaker wick.
      confluenceBonus: wr >= 0.6,
      atrNormal: atrNotSpiking(last, atrValue),
      sessionBoosted: session === 'london' || session === 'newyork' || session === 'overlap',
    });
    if (score < FVG_SCORE_MIN_ENTRY) continue;

    const confidence = Math.max(0, Math.min(1, (score / FVG_SCORE_MAX) * confirmation.multiplier));
    return {
      name: 'fvg-breaker-block',
      direction,
      confidence,
      strength: strengthForFvgScore(confidence),
      time: last.time,
      volumeConfirmed: volRatio > 1.5,
      confirmedByNextCandle: true,
    };
  }

  return null;
}

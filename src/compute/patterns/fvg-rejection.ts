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
const MIN_WICK_RATIO = 0.5;
const MAX_BODY_TO_RANGE = 0.4;
const MIN_TOUCH_VOLUME_RATIO = 1.2; // doc §3D: "Объём на касании выше среднего"

// Strategy D — "FVG Rejection" (Отбой от границы), doc §3:
//   - Price touches the FVG's boundary (not deep inside — a rejection
//     happens at the edge).
//   - A Pin-bar/Doji forms: dominant wick, small body.
//   - Volume on the touch is above average.
//   Entry: on the close of the confirming candle.
export function detectFvgRejection(
  candles: Candle[],
  snapshot: IndicatorSnapshot | undefined,
  session: SessionRegime,
  smartMoney: SmartMoneyResult,
): PatternResult | null {
  if (candles.length < MIN_HISTORY) return null;

  const last = candles[candles.length - 1];
  const patternCandle = candles[candles.length - 2];
  const patternIdx = candles.length - 2;
  const intervalSec = intervalSeconds(candles);

  for (const wantType of ['bullish', 'bearish'] as const) {
    const direction: 'buy' | 'sell' = wantType === 'bullish' ? 'buy' : 'sell';

    const candidates = pickFreshUnbrokenFvgs(smartMoney.fvgs, wantType, patternCandle.time, intervalSec, MAX_AGE_BARS);
    if (candidates.length === 0) continue;
    const fvg = candidates[candidates.length - 1];

    const boundary = direction === 'buy' ? fvg.top : fvg.bottom;
    const touchedBoundary = direction === 'buy'
      ? patternCandle.low <= boundary && patternCandle.low >= fvg.bottom
      : patternCandle.high >= boundary && patternCandle.high <= fvg.top;
    if (!touchedBoundary) continue;

    const range = patternCandle.high - patternCandle.low || 1e-9;
    const body = Math.abs(patternCandle.close - patternCandle.open);
    const wr = wickRatio(patternCandle, direction === 'buy' ? 'lower' : 'upper');
    if (wr < MIN_WICK_RATIO || body / range > MAX_BODY_TO_RANGE) continue;

    const touchVolRatio = volumeRatio(candles, patternIdx, 20);
    if (touchVolRatio < MIN_TOUCH_VOLUME_RATIO) continue;

    const confirmation = nextCandleConfirmation(patternCandle, last, direction);
    if (!confirmation.confirmed) continue;

    const atrValue = snapshot?.atr ?? null;
    const rsiFast = lastNonNull(calcRsi(candles.map((c) => c.close), 7));
    const vwapValue = vwapLast(candles, vwapSessionPeriod(candles)).value;
    const ema50Value = snapshot?.emaSlow ?? null;

    const score = scoreFvgSignal({
      emaAligned: ema50AlignedOk(direction, last.close, ema50Value),
      vwapAligned: vwapSideOk(direction, last.close, vwapValue),
      rsiConfirmed: rsiConfirmOk(direction, rsiFast),
      volumeConfirmed: touchVolRatio >= 1.5,
      confluenceBonus: fvg.hasOBConfluence || fvg.hasBOSConfluence,
      atrNormal: atrNotSpiking(last, atrValue),
      sessionBoosted: session === 'london' || session === 'newyork' || session === 'overlap',
    });
    if (score < FVG_SCORE_MIN_ENTRY) continue;

    const confidence = Math.max(0, Math.min(1, (score / FVG_SCORE_MAX) * confirmation.multiplier));
    return {
      name: 'fvg-rejection',
      direction,
      confidence,
      strength: strengthForFvgScore(confidence),
      time: last.time,
      volumeConfirmed: true,
      confirmedByNextCandle: true,
    };
  }

  return null;
}

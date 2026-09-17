import type { Candle, PatternResult, IndicatorSnapshot, MarketStructure } from '@/types/domain';
import type { SessionRegime } from '@/compute/session-regime';
import type { SmartMoneyResult } from '@/compute/indicators/smart-money';
import { rsi as calcRsi } from '@/compute/indicators/rsi';
import { vwapLast, vwapSessionPeriod } from '@/compute/indicators/vwap';
import { lastNonNull } from '@/compute/indicators/helpers';
import { intervalSeconds } from './pattern-context';
import {
  pickFreshUnbrokenFvgs,
  vwapSideOk,
  rsiConfirmOk,
  ema50AlignedOk,
  atrNotSpiking,
  scoreFvgSignal,
  FVG_SCORE_MAX,
  FVG_SCORE_MIN_ENTRY,
  strengthForFvgScore,
} from './fvg-strategies-shared';

// Doc §5 mandatory filter: "Возраст FVG < 15 свечей".
const MAX_AGE_BARS = 15;
const MIN_HISTORY = 30;

// Strategy A — "Return to FVG" (Классическая), doc §3:
//   1. A Bullish/Bearish FVG exists within the matching trend direction.
//   2. Price retraces back into the zone (retest).
//   3. Confirming indicators agree (§4 scoring engine, shared with the
//      other 3 strategies — see fvg-strategies-shared.ts).
// Entry: limit at 30-50% zone depth or market order on an in-zone reversal
// — approximated here as requiring the reacting candle to close on the
// trade side of the zone's 50% Consequent Encroachment line.
export function detectFvgReturn(
  candles: Candle[],
  snapshot: IndicatorSnapshot | undefined,
  structure: MarketStructure,
  session: SessionRegime,
  smartMoney: SmartMoneyResult,
): PatternResult | null {
  if (candles.length < MIN_HISTORY) return null;
  // Doc condition 1: "Bullish FVG в рамках восходящего тренда" — trend
  // alignment is a hard requirement, not a soft bonus, for this strategy.
  if (structure.trend === 'range') return null;

  const wantType: 'bullish' | 'bearish' = structure.trend === 'up' ? 'bullish' : 'bearish';
  const direction: 'buy' | 'sell' = wantType === 'bullish' ? 'buy' : 'sell';

  const last = candles[candles.length - 1];
  const intervalSec = intervalSeconds(candles);
  const candidates = pickFreshUnbrokenFvgs(smartMoney.fvgs, wantType, last.time, intervalSec, MAX_AGE_BARS);
  if (candidates.length === 0) return null;

  const fvg = candidates[candidates.length - 1];

  // Retest: the current candle's range overlaps the zone.
  const touchedZone = last.low <= fvg.top && last.high >= fvg.bottom;
  if (!touchedZone) return null;

  // Reaction confirmation + mandatory filter ("цена не закрылась за
  // пределами FVG против сигнала"): close must sit on the trade side of
  // the zone's CE midline and must not have closed through the far edge.
  if (direction === 'buy') {
    if (last.close < fvg.ce) return null;
    if (last.close < fvg.bottom) return null;
  } else {
    if (last.close > fvg.ce) return null;
    if (last.close > fvg.top) return null;
  }

  const atrValue = snapshot?.atr ?? null;
  const rsiFast = lastNonNull(calcRsi(candles.map((c) => c.close), 7));
  const vwapValue = vwapLast(candles, vwapSessionPeriod(candles)).value;
  const ema50Value = snapshot?.emaSlow ?? null;

  // Doc's Wyckoff-style rule (§2, "Правило для приложения"): on the return
  // move, volume should be lower than the impulse candle that created the
  // gap — evidence of no opposing aggression. The impulse candle is the
  // FVG's middle candle, one bar after its recorded left/time candle.
  const impulseIdx = candles.findIndex((c) => c.time === fvg.time) + 1;
  const impulseVolume = impulseIdx > 0 && impulseIdx < candles.length ? candles[impulseIdx].volume : null;
  const volumeConfirmed = impulseVolume != null && impulseVolume > 0 ? last.volume < impulseVolume : false;

  const score = scoreFvgSignal({
    emaAligned: ema50AlignedOk(direction, last.close, ema50Value),
    vwapAligned: vwapSideOk(direction, last.close, vwapValue),
    rsiConfirmed: rsiConfirmOk(direction, rsiFast),
    volumeConfirmed,
    confluenceBonus: fvg.hasOBConfluence || fvg.hasBOSConfluence,
    atrNormal: atrNotSpiking(last, atrValue),
    sessionBoosted: session === 'london' || session === 'newyork' || session === 'overlap',
  });
  if (score < FVG_SCORE_MIN_ENTRY) return null;

  const confidence = Math.max(0, Math.min(1, score / FVG_SCORE_MAX));
  return {
    name: 'fvg-return',
    direction,
    confidence,
    strength: strengthForFvgScore(confidence),
    time: last.time,
    volumeConfirmed,
  };
}

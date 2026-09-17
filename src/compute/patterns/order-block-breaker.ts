import type { Candle, PatternResult, IndicatorSnapshot } from '@/types/domain';
import type { SessionRegime } from '@/compute/session-regime';
import type { SmartMoneyResult } from '@/compute/indicators/smart-money';
import { rsi as calcRsi } from '@/compute/indicators/rsi';
import { vwapLast, vwapSessionPeriod } from '@/compute/indicators/vwap';
import { lastNonNull, volumeRatio } from '@/compute/indicators/helpers';
import { nextCandleConfirmation, intervalSeconds } from './pattern-context';
import {
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
import { pickFreshUnbrokenOrderBlocks } from './order-block-strategies-shared';

const MAX_AGE_BARS = 15;
const MIN_HISTORY = 30;
const MIN_WICK_RATIO = 0.35;

// "OB Breaker Block" — the genuine ICT role-inversion concept. NOT the same
// pattern as fvg-breaker-block.ts (which borrows the term "Breaker Block"
// for a different geometry: a rejection wick piercing an ordinary FVG).
// Here a Breaker Block is `smartMoney.breakerBlocks` from smart-money.ts:
// an Order Block that got fully invalidated (closed through) and had its
// zone re-purposed with inverted polarity — a broken bullish OB (failed
// support) becomes a bearish breaker (new resistance); a broken bearish OB
// (failed resistance) becomes a bullish breaker (new support).
//
// This strategy trades the classic ICT "break, retest as the opposite
// role, reject" setup: price returns into that re-purposed zone and
// rejects in the breaker's OWN (post-inversion) direction — a wick pierces
// the zone while the candle closes back out on the breaker's favorable
// side, confirmed by the next candle continuing that way. Same
// wick-then-confirmation geometry as fvg-breaker-block.ts, applied to a
// structurally different zone.
export function detectOrderBlockBreaker(
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

    const candidates = pickFreshUnbrokenOrderBlocks(
      smartMoney.breakerBlocks,
      wantType,
      patternCandle.time,
      intervalSec,
      MAX_AGE_BARS,
    );
    if (candidates.length === 0) continue;
    const breaker = candidates[candidates.length - 1];

    // Wicked into the breaker zone, then closed back out on the zone's own
    // (post-inversion) favorable side — same "entered, then closedBackOutside"
    // criterion analyzeOBTouches uses for a live order block's own
    // tested-hold reactions, applied here to confirm a genuine retest
    // rather than a simple pass-through.
    const enteredZone = patternCandle.low <= breaker.top && patternCandle.high >= breaker.bottom;
    if (!enteredZone) continue;
    const closedBackOutside = direction === 'buy'
      ? patternCandle.close >= breaker.top
      : patternCandle.close <= breaker.bottom;
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
      // This strategy's own defining confluence is a well-formed ORIGIN
      // block: a breaker inherited from a genuine, structurally confirmed
      // order block (both flags copied over unchanged in smart-money.ts's
      // breaker-generation loop) is a materially stronger breaker than one
      // from a marginal/unconfirmed block.
      confluenceBonus: breaker.hasDisplacement && breaker.hasStructureConfluence,
      atrNormal: atrNotSpiking(last, atrValue),
      sessionBoosted: session === 'london' || session === 'newyork' || session === 'overlap',
    });
    if (score < FVG_SCORE_MIN_ENTRY) continue;

    const confidence = Math.max(0, Math.min(1, (score / FVG_SCORE_MAX) * confirmation.multiplier));
    return {
      name: 'order-block-breaker',
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

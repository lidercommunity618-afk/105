import type { Candle, PatternResult, IndicatorSnapshot } from '@/types/domain';
import type { SessionRegime } from '@/compute/session-regime';
import type { SmartMoneyResult } from '@/compute/indicators/smart-money';
import { rsi as calcRsi } from '@/compute/indicators/rsi';
import { vwapLast, vwapSessionPeriod } from '@/compute/indicators/vwap';
import { lastNonNull, volumeRatio } from '@/compute/indicators/helpers';
import { detectFvgGeometry, computeAtrSeries } from '@/compute/indicators/fvg-core';
import { intervalSeconds } from './pattern-context';
import {
  resampleCandles,
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

const MAX_AGE_BARS = 15;
const MIN_HISTORY = 60;
// M1 -> synthetic M5 aggregation factor for the HTF-approximation zone
// (see resampleCandles doc-comment in fvg-strategies-shared.ts).
const HTF_FACTOR = 5;

interface HtfFvgZone {
  top: number;
  bottom: number;
  type: 'bullish' | 'bearish';
  time: number;
}

// Экспортировано ради эмпирической проверки на синтетических данных — см.
// аналогичный комментарий у detectHtfObZones в order-block-nested.ts.
export function detectHtfFvgZones(candles: Candle[]): HtfFvgZone[] {
  // BUGFIX (аудит, Рекомендация 1, 2026-09): подтверждена эмпирически та же
  // экспозиция, что и у ZigZag/гармоник — см. идентичный комментарий у
  // detectHtfObZones в order-block-nested.ts.
  const htf = resampleCandles(candles, HTF_FACTOR, { alignToAbsoluteTime: true });
  if (htf.length < 3) return [];

  const atrSeries = computeAtrSeries(htf, 14);
  const zones: HtfFvgZone[] = [];

  for (let i = 2; i < htf.length; i++) {
    const geo = detectFvgGeometry(htf[i - 2], htf[i - 1], htf[i], atrSeries[i - 1] ?? null);
    if (!geo) continue;

    let broken = false;
    for (let j = i + 1; j < htf.length; j++) {
      const closedThrough = geo.type === 'bullish' ? htf[j].close < geo.bottom : htf[j].close > geo.top;
      if (closedThrough) { broken = true; break; }
    }
    if (broken) continue;

    zones.push({ top: geo.top, bottom: geo.bottom, type: geo.type, time: htf[i - 2].time });
  }
  return zones;
}

// Strategy C — "Nested FVG" (Вложенные FVG), doc §3, priority: Максимальный:
//   - An untouched FVG exists on a higher timeframe (approximated as
//     synthetic M5 built from the live M1 candles — see HTF_FACTOR above).
//   - An M1 FVG in the same direction forms inside it.
//   - Price reaches the overlap ("confluence zone") of both.
export function detectFvgNested(
  candles: Candle[],
  snapshot: IndicatorSnapshot | undefined,
  session: SessionRegime,
  smartMoney: SmartMoneyResult,
): PatternResult | null {
  if (candles.length < MIN_HISTORY) return null;

  const last = candles[candles.length - 1];
  const intervalSec = intervalSeconds(candles);
  const htfZones = detectHtfFvgZones(candles);
  if (htfZones.length === 0) return null;

  for (const wantType of ['bullish', 'bearish'] as const) {
    const direction: 'buy' | 'sell' = wantType === 'bullish' ? 'buy' : 'sell';

    const htfCandidates = htfZones.filter((z) => z.type === wantType);
    if (htfCandidates.length === 0) continue;
    const m1Candidates = pickFreshUnbrokenFvgs(smartMoney.fvgs, wantType, last.time, intervalSec, MAX_AGE_BARS);
    if (m1Candidates.length === 0) continue;

    for (const htf of htfCandidates) {
      for (const m1 of m1Candidates) {
        const overlapTop = Math.min(htf.top, m1.top);
        const overlapBottom = Math.max(htf.bottom, m1.bottom);
        if (overlapTop <= overlapBottom) continue; // zones don't actually overlap

        const priceInConfluence = last.low <= overlapTop && last.high >= overlapBottom;
        if (!priceInConfluence) continue;

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
          // The HTF/M1 nesting itself IS this strategy's defining confluence.
          confluenceBonus: true,
          atrNormal: atrNotSpiking(last, atrValue),
          sessionBoosted: session === 'london' || session === 'newyork' || session === 'overlap',
        });
        if (score < FVG_SCORE_MIN_ENTRY) continue;

        const confidence = Math.max(0, Math.min(1, score / FVG_SCORE_MAX));
        return {
          name: 'fvg-nested',
          direction,
          confidence,
          strength: strengthForFvgScore(confidence),
          time: last.time,
          volumeConfirmed: volRatio > 1.5,
        };
      }
    }
  }

  return null;
}

import type { Candle, PatternResult, IndicatorSnapshot } from '@/types/domain';
import type { SessionRegime } from '@/compute/session-regime';
import { calcSmartMoney, type SmartMoneyResult } from '@/compute/indicators/smart-money';
import { rsi as calcRsi } from '@/compute/indicators/rsi';
import { vwapLast, vwapSessionPeriod } from '@/compute/indicators/vwap';
import { lastNonNull, volumeRatio } from '@/compute/indicators/helpers';
import { intervalSeconds } from './pattern-context';
import {
  resampleCandles,
  vwapSideOk,
  rsiConfirmOk,
  ema50AlignedOk,
  atrNotSpiking,
  scoreFvgSignal,
  FVG_SCORE_MAX,
  FVG_SCORE_MIN_ENTRY,
  strengthForFvgScore,
} from './fvg-strategies-shared';
import { pickFreshUnbrokenOrderBlocks } from './order-block-strategies-shared';

const MAX_AGE_BARS = 15;
const MIN_HISTORY = 60;
// M1 -> synthetic M5 aggregation factor for the HTF-approximation zone —
// same factor and same technique as fvg-nested.ts's HTF_FACTOR, kept
// identical so "nested" means the same timeframe relationship for both
// FVGs and Order Blocks in this app.
const HTF_FACTOR = 5;

interface HtfObZone {
  top: number;
  bottom: number;
  type: 'bullish' | 'bearish';
  time: number;
}

// Экспортировано (а не оставлено module-private) ради эмпирической
// проверки на синтетических данных — тот же приём, что и
// computeZigZag/findHarmonicZigZagPoints в zigzag.ts (см. Рекомендацию 3
// аудита: "не чинить вслепую по аналогии", нужен прямой доступ к функции
// для сравнения её результата на последовательных барах скользящего окна).
export function detectHtfObZones(candles: Candle[]): HtfObZone[] {
  // BUGFIX (аудит, Рекомендация 1, 2026-09): подтверждена эмпирически та же
  // экспозиция, что и у ZigZag/гармоник — production/бэктест вызывают этот
  // детектор на СКОЛЬЗЯЩЕМ окне (см. backtest/simulator.ts), из-за чего
  // top/bottom/time одной и той же исторической HTF OB-зоны "гуляли" в
  // зависимости от `windowStart % HTF_FACTOR` без единого реального
  // изменения цены. `alignToAbsoluteTime: true` привязывает границу
  // группировки к абсолютному времени свечи — см. ResampleOptions в
  // fvg-strategies-shared.ts.
  const htf = resampleCandles(candles, HTF_FACTOR, { alignToAbsoluteTime: true });
  // calcSmartMoney's own minimum-history guard (2*PIVOT_LOOKUP+5 = 9) is
  // reused rather than duplicated — it just returns an empty result below
  // that bar, same as if there was nothing to find.
  const htfSmartMoney = calcSmartMoney(htf, {
    // Displacement stays required (the default) — that's the "this is a
    // genuine institutional-size impulse, not just any directional close"
    // gate, and dropping it would make the HTF side of this pattern
    // trivially easy to satisfy on any resampled series.
    //
    // Structure confluence (BOS/CHoCH within the confirmation window) is
    // turned OFF here, deliberately: it's a *secondary* structural
    // confirmation on top of displacement, and requiring a full pivot-
    // based break at the coarse HTF scale — computed from a resampled
    // synthetic series that may only span a few dozen bars — is brittle
    // and would suppress otherwise-valid nested setups. The M1 side of
    // this pattern (smartMoney.orderBlocks, filtered below) is already
    // computed with the app's default requireStructureConfluence: true,
    // so genuine structural quality is still enforced at the primary
    // timeframe. Same asymmetry fvg-nested.ts already accepts implicitly
    // by using the structure-agnostic detectFvgGeometry for its HTF side.
    requireStructureConfluence: false,
  });
  return htfSmartMoney.orderBlocks
    .filter((ob) => ob.status !== 'broken')
    .map((ob) => ({ top: ob.top, bottom: ob.bottom, type: ob.type, time: ob.time }));
}

// "Nested OB" (Вложенный Order Block) — the OB counterpart of the existing
// "Nested FVG" strategy (fvg-nested.ts), same structure:
//   - An unbroken order block exists on a higher timeframe (approximated as
//     synthetic M5 built from the live M1 candles — see HTF_FACTOR above).
//   - An unbroken M1 order block in the same direction sits inside it.
//   - Price reaches the overlap ("confluence zone") of both.
// Multi-timeframe alignment (an HTF institutional zone reinforced by a
// fresh M1 zone at the same price) is itself the setup's edge, mirroring
// standard SMC/ICT practice of trading the point where a lower-timeframe
// order block sits inside a higher-timeframe one.
export function detectOrderBlockNested(
  candles: Candle[],
  snapshot: IndicatorSnapshot | undefined,
  session: SessionRegime,
  smartMoney: SmartMoneyResult,
): PatternResult | null {
  if (candles.length < MIN_HISTORY) return null;

  const last = candles[candles.length - 1];
  const intervalSec = intervalSeconds(candles);
  const htfZones = detectHtfObZones(candles);
  if (htfZones.length === 0) return null;

  for (const wantType of ['bullish', 'bearish'] as const) {
    const direction: 'buy' | 'sell' = wantType === 'bullish' ? 'buy' : 'sell';

    const htfCandidates = htfZones.filter((z) => z.type === wantType);
    if (htfCandidates.length === 0) continue;
    const m1Candidates = pickFreshUnbrokenOrderBlocks(
      smartMoney.orderBlocks,
      wantType,
      last.time,
      intervalSec,
      MAX_AGE_BARS,
    );
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
          // The HTF/M1 nesting itself IS this strategy's defining confluence
          // — same convention as fvg-nested.ts.
          confluenceBonus: true,
          atrNormal: atrNotSpiking(last, atrValue),
          sessionBoosted: session === 'london' || session === 'newyork' || session === 'overlap',
        });
        if (score < FVG_SCORE_MIN_ENTRY) continue;

        const confidence = Math.max(0, Math.min(1, score / FVG_SCORE_MAX));
        return {
          name: 'order-block-nested',
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

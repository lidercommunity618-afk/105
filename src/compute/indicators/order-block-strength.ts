import type { Candle, MarketStructure } from '@/types/domain';
import { detectFvgGeometry, computeAtrSeries } from './fvg-core';
import { atr } from './atr';
import {
  lastNonNull,
  DEFAULT_MIN_DISPLACEMENT_ATR_MULTIPLE,
  DEFAULT_DISPLACEMENT_ATR_PERIOD,
} from './helpers';

export interface RejectionTouch {
  time: number;
  wickRatio: number;
  closedBackOutside: boolean;
}

export type OrderBlockStatus = 'untested' | 'tested-hold' | 'broken';

export interface TouchAnalysis {
  touchCount: number;
  rejections: RejectionTouch[];
  status: OrderBlockStatus;
  strengthScore: number;
  breakTime: number | null;
}

export interface OrderBlockZone {
  open: number;
  close: number;
  high: number;
  low: number;
  direction: 'bullish' | 'bearish';
  // Redefined to match "Mitigation Block" from the spec (a zone the price
  // has broken and closed beyond, not merely touched) — same meaning as
  // `status === 'broken'` and as `mitigated` in smart-money.ts/
  // super-order-block.ts, instead of the old `touchCount > 0` (which
  // conflated "touched at all" with "invalidated").
  mitigated: boolean;
  filled: boolean;
  time: number;
  endTime: number;
  touchCount: number;
  rejections: RejectionTouch[];
  status: OrderBlockStatus;
  strengthScore: number;
  // Validation flags — Задача 0.2, дополнено при аудите разметки OB (см.
  // bolt-prompt-order-block-fixes.md). Computed for every zone regardless of
  // `onlyValidated` below, so callers (UI, diagnostics, future scoring) can
  // inspect OB quality without re-deriving this logic elsewhere.
  //
  // 1. impulseEngulfsBlock — the breaking impulse candle's full range
  //    (body+wick) engulfs the OB candle's full range.
  impulseEngulfsBlock: boolean;
  // 2. hasFvgConfluence — a fair-value gap (same 3-candle imbalance
  //    definition as detectImbalances) sits at/adjacent to this OB.
  hasFvgConfluence: boolean;
  // 3. hasDisplacement — the impulse candle's own range clears
  //    `minDisplacementAtrMultiple` × ATR (see DisplacementOptions below),
  //    i.e. this is a genuine institutional-size displacement and not just
  //    any directional close. Same rule and same defaults as
  //    super-order-block.ts/smart-money.ts, so a candle either qualifies as
  //    "a strong impulse" or it doesn't — consistently across every OB
  //    detector in the codebase, per the spec's "импульс должен быть
  //    сильным" rule.
  hasDisplacement: boolean;
  // 4. hasStructureConfluence — a CHoCH/BOS exists in the same direction as
  //    the impulse, checked against the single `structure` snapshot passed
  //    to this call (usually "structure right now", not "structure at the
  //    time this specific historical OB formed"). NOTE: `bos`/`choch` in
  //    MarketStructure are edge-triggered (true only on the exact candle
  //    where the break happens — see computeStructure in trend-structure.ts),
  //    so this flag is false for most zones most of the time even when the
  //    zone is otherwise perfectly valid. That's why it feeds `validated`
  //    below only when the caller explicitly opts into `onlyValidated`, and
  //    is false (not gating) when `structure` isn't supplied at all.
  hasStructureConfluence: boolean;
  // All conditions above at once — the "обязательны все условия" gate from
  // the spec, precomputed for convenience. Gates the return value of
  // orderBlockStrength() when `onlyValidated: true` (the default). Pass
  // `onlyValidated: false` to get all non-filled zones regardless of
  // validation status (e.g. for direction scoring or target-finding).
  validated: boolean;
}

export interface DisplacementOptions {
  /** Pre-computed ATR value for the displacement check. If omitted,
   *  computed internally via atr(candles, atrPeriod) once per call. */
  atrValue?: number | null;
  /** Period used for the internally-computed ATR fallback above. */
  atrPeriod?: number;
  /** Minimum impulse-candle range, as a multiple of ATR, to count as
   *  genuine displacement (see hasDisplacement doc above). */
  minDisplacementAtrMultiple?: number;
}

export function structureConfluence(structure: MarketStructure | undefined, direction: 'bullish' | 'bearish'): boolean {
  if (!structure) return false;
  const wantTrend = direction === 'bullish' ? 'up' : 'down';
  return structure.trend === wantTrend && (structure.bos || structure.choch);
}

export function analyzeOBTouches(
  candles: Candle[],
  direction: 'bullish' | 'bearish',
  zoneHigh: number,
  zoneLow: number,
): TouchAnalysis {
  let touchCount = 0;
  let strengthScore = 0.5;
  let status: OrderBlockStatus = 'untested';
  let breakTime: number | null = null;
  const rejections: RejectionTouch[] = [];

  for (const candle of candles) {
    if (direction === 'bullish' && candle.close < zoneLow) {
      status = 'broken';
      breakTime = candle.time;
      break;
    }
    if (direction === 'bearish' && candle.close > zoneHigh) {
      status = 'broken';
      breakTime = candle.time;
      break;
    }

    const enteredZone = candle.low <= zoneHigh && candle.high >= zoneLow;
    if (!enteredZone) continue;

    touchCount += 1;
    const range = Math.max(candle.high - candle.low, Number.EPSILON);
    const wick = direction === 'bullish'
      ? Math.min(candle.open, candle.close) - candle.low
      : candle.high - Math.max(candle.open, candle.close);
    const wickRatio = Math.max(0, Math.min(1, wick / range));
    const closedBackOutside = direction === 'bullish'
      ? candle.close >= zoneHigh
      : candle.close <= zoneLow;

    rejections.push({ time: candle.time, wickRatio, closedBackOutside });
    if (!closedBackOutside) continue;

    status = 'tested-hold';
    if (wickRatio >= 0.5) {
      strengthScore = Math.min(1, strengthScore + 0.15 + 0.1 * touchCount);
    } else {
      strengthScore = Math.max(0.2, strengthScore - 0.1);
    }
  }

  return { touchCount, rejections, status, strengthScore, breakTime };
}

export function orderBlockStrength(
  candles: Candle[],
  lookback: number = 50,
  structure?: MarketStructure,
  onlyValidated: boolean = true,
  displacement?: DisplacementOptions,
): OrderBlockZone[] {
  if (candles.length < 5) return [];

  const slice = candles.slice(-lookback);
  const lastTime = slice[slice.length - 1].time;
  const atrSeries = computeAtrSeries(slice, 14);
  const zones: OrderBlockZone[] = [];

  const atrPeriod = displacement?.atrPeriod ?? DEFAULT_DISPLACEMENT_ATR_PERIOD;
  const minMultiple = displacement?.minDisplacementAtrMultiple ?? DEFAULT_MIN_DISPLACEMENT_ATR_MULTIPLE;
  const displacementAtrValue = displacement?.atrValue !== undefined
    ? displacement.atrValue
    : lastNonNull(atr(candles, atrPeriod));

  const checkDisplacement = (impulseCandle: Candle): boolean => {
    if (displacementAtrValue == null || displacementAtrValue <= 0) return true; // no ATR context — don't silently exclude on it
    const impulseRange = impulseCandle.high - impulseCandle.low;
    return impulseRange >= displacementAtrValue * minMultiple;
  };

  for (let i = 1; i < slice.length - 1; i += 1) {
    const current = slice[i];
    const next = slice[i + 1];
    const after = slice.slice(i + 2);

    if (current.close < current.open && next.close > current.high) {
      const fvg = detectFVG(slice, i, atrSeries[i + 1] ?? null);
      const analysis = analyzeOBTouches(after, 'bullish', current.high, current.low);
      const filled = fvg !== null && after.some((candle) => candle.low <= fvg.lower);
      const impulseEngulfsBlock = next.high >= current.high && next.low <= current.low;
      const hasFvgConfluence = fvg !== null;
      const hasDisplacement = checkDisplacement(next);
      const hasStructureConfluence = structureConfluence(structure, 'bullish');
      // Don't require structure confluence when no `structure` context was
      // supplied at all — absence of context isn't evidence against the zone.
      const structureOk = structure !== undefined ? hasStructureConfluence : true;
      zones.push({
        open: current.open, close: current.close, high: current.high, low: current.low,
        direction: 'bullish', mitigated: analysis.status === 'broken', filled,
        time: current.time, endTime: analysis.breakTime ?? lastTime,
        touchCount: analysis.touchCount, rejections: analysis.rejections,
        status: analysis.status, strengthScore: analysis.strengthScore,
        impulseEngulfsBlock, hasFvgConfluence, hasDisplacement, hasStructureConfluence,
        validated: impulseEngulfsBlock && hasFvgConfluence && hasDisplacement && structureOk,
      });
    }

    if (current.close > current.open && next.close < current.low) {
      const fvg = detectFVG(slice, i, atrSeries[i + 1] ?? null);
      const analysis = analyzeOBTouches(after, 'bearish', current.high, current.low);
      const filled = fvg !== null && after.some((candle) => candle.high >= fvg.upper);
      const impulseEngulfsBlock = next.high >= current.high && next.low <= current.low;
      const hasFvgConfluence = fvg !== null;
      const hasDisplacement = checkDisplacement(next);
      const hasStructureConfluence = structureConfluence(structure, 'bearish');
      const structureOk = structure !== undefined ? hasStructureConfluence : true;
      zones.push({
        open: current.open, close: current.close, high: current.high, low: current.low,
        direction: 'bearish', mitigated: analysis.status === 'broken', filled,
        time: current.time, endTime: analysis.breakTime ?? lastTime,
        touchCount: analysis.touchCount, rejections: analysis.rejections,
        status: analysis.status, strengthScore: analysis.strengthScore,
        impulseEngulfsBlock, hasFvgConfluence, hasDisplacement, hasStructureConfluence,
        validated: impulseEngulfsBlock && hasFvgConfluence && hasDisplacement && structureOk,
      });
    }
  }

  return zones.filter((zone) => !zone.filled && (!onlyValidated || zone.validated));
}

export interface ImbalanceZone {
  upper: number;
  lower: number;
  direction: 'bullish' | 'bearish';
  /** Consequent Encroachment — (upper + lower) / 2. */
  ce: number;
  /** Price touched (wick) the CE midline — a partial mitigation, per ICT. Weaker signal than `invalidated`. */
  touched: boolean;
  /** A candle closed all the way through the zone (past the far boundary) — full invalidation, same criterion as `broken` in smart-money.ts. */
  invalidated: boolean;
  time: number;
  endTime: number;
}

// `touched` (CE-touch, wick-only mitigation) and `invalidated` (full-close
// invalidation) are deliberately separate, non-equivalent concepts — see
// order-block-strength.ts module docs / the FVG audit. Consumers that need
// "is this zone still tradeable" should filter on `!invalidated`, not
// `!touched`: a zone that's merely been touched at its CE is still valid
// until it's actually invalidated by a full close through it.
export function detectImbalances(candles: Candle[], lookback: number = 50): ImbalanceZone[] {
  if (candles.length < 3) return [];

  const slice = candles.slice(-lookback);
  const lastTime = slice[slice.length - 1].time;
  const atrSeries = computeAtrSeries(slice, 14);
  const zones: ImbalanceZone[] = [];

  for (let i = 0; i < slice.length - 2; i += 1) {
    const first = slice[i];
    const mid = slice[i + 1];
    const third = slice[i + 2];
    const startTime = mid.time;

    const geo = detectFvgGeometry(first, mid, third, atrSeries[i + 1] ?? null);
    if (!geo) continue;

    const after = slice.slice(i + 3);
    const touched = geo.type === 'bullish'
      ? after.some((c) => c.low <= geo.ce)
      : after.some((c) => c.high >= geo.ce);
    const invalidated = geo.type === 'bullish'
      ? after.some((c) => c.close < geo.bottom)
      : after.some((c) => c.close > geo.top);

    zones.push({
      upper: geo.top, lower: geo.bottom, direction: geo.type, ce: geo.ce,
      touched, invalidated, time: startTime, endTime: lastTime,
    });
  }

  return zones.filter((zone) => !zone.invalidated);
}

interface FVG {
  upper: number;
  lower: number;
}

function detectFVG(candles: Candle[], index: number, atrAtMid: number | null): FVG | null {
  if (index + 2 > candles.length - 1) return null;
  const first = candles[index];
  const mid = candles[index + 1];
  const third = candles[index + 2];
  const geo = detectFvgGeometry(first, mid, third, atrAtMid);
  if (!geo) return null;
  return { upper: geo.top, lower: geo.bottom };
}

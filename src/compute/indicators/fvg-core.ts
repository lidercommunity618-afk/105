import type { Candle } from '@/types/domain';
import { atr } from './atr';

// ICT displacement rule: the middle (impulse) candle's body must be at
// least this many times the average ATR to count as a genuine displacement
// rather than noise/spread. Applied whenever an ATR value is available.
export const MIN_DISPLACEMENT_ATR_MULTIPLE = 1.2;

export interface FvgGeometry {
  top: number;
  bottom: number;
  type: 'bullish' | 'bearish';
  /** Consequent Encroachment — the 50% midline of the zone, per ICT methodology. */
  ce: number;
  /**
   * True only when an ATR value was available AND the middle candle's body
   * cleared the MIN_DISPLACEMENT_ATR_MULTIPLE threshold. False (but the
   * zone is still returned, not excluded) when no ATR value was available —
   * see detectFvgGeometry doc below.
   */
  hasDisplacement: boolean;
}

export function computeAtrSeries(candles: Candle[], period = 14): (number | null)[] {
  return atr(candles, period);
}

/**
 * Raw 3-candle FVG/imbalance geometry shared by every detector in the
 * codebase (smart-money.ts calcSmartMoney, order-block-strength.ts
 * detectFVG and detectImbalances). Centralizing this closes the gap where
 * three independent copies of "what is a 3-bar gap" could silently diverge.
 *
 * Validation applied here (ICT displacement rules for the middle/impulse candle):
 *   1. Direction check (always enforced, regardless of ATR availability):
 *      the middle candle must close in the direction of the gap. A gap can
 *      technically form even off a "wrong colour" doji in the middle —
 *      that's noise, not a genuine displacement, so it's rejected (null).
 *   2. Displacement-size check (enforced only when an ATR value is passed
 *      in): the middle candle's body must be >= MIN_DISPLACEMENT_ATR_MULTIPLE
 *      × ATR. If it isn't, the candidate is rejected (null) — a gap this
 *      weak relative to recent volatility isn't a real displacement.
 *   3. When atrAtMid is null (too little history to compute ATR yet), the
 *      size check is skipped rather than blocking the candidate outright —
 *      the zone is returned with hasDisplacement: false so callers know its
 *      quality is unverified, instead of losing early-history zones entirely.
 */
export function detectFvgGeometry(
  left: Candle,
  mid: Candle,
  right: Candle,
  atrAtMid: number | null,
): FvgGeometry | null {
  const isBullishGap = right.low > left.high;
  const isBearishGap = right.high < left.low;
  if (!isBullishGap && !isBearishGap) return null;

  const type: 'bullish' | 'bearish' = isBullishGap ? 'bullish' : 'bearish';

  const midDirectionOk = type === 'bullish' ? mid.close > mid.open : mid.close < mid.open;
  if (!midDirectionOk) return null;

  let hasDisplacement = false;
  if (atrAtMid !== null && atrAtMid > 0) {
    const midBody = Math.abs(mid.close - mid.open);
    if (midBody < atrAtMid * MIN_DISPLACEMENT_ATR_MULTIPLE) return null;
    hasDisplacement = true;
  }

  const top = type === 'bullish' ? right.low : left.low;
  const bottom = type === 'bullish' ? left.high : right.high;

  return { top, bottom, type, ce: (top + bottom) / 2, hasDisplacement };
}

/**
 * Right-edge cutoff (`toTime`) for rendering a live FVG/IFVG box on the chart.
 *
 * ICT methodology: a zone stays valid — and, per `pickFreshUnbrokenFvgs` in
 * `fvg-strategies-shared.ts`, remains a tradeable signal candidate — until it
 * is *invalidated* by a candle closing all the way through its far boundary
 * (`broken`/`endTime`). A mere CE wick touch (`touchedTime`) is a weaker,
 * much more common partial mitigation (see `ImbalanceZone.touched` in
 * order-block-strength.ts) and does not end the zone's life.
 *
 * The chart's visual right edge must track the same criterion the signal
 * engine trades on: cutting the box off at `touchedTime` would show a zone
 * as "finished" on screen while `fvg-return.ts` and friends still treat it
 * as live and can fire a signal on it, which contradicts the picture the
 * trader sees. So the box is only cut short by full invalidation; while a
 * zone is merely touched-but-not-invalidated it stretches to the current bar
 * (`toTime: null`).
 */
export function fvgRenderCutoff(zone: { broken: boolean; endTime: number | null }): number | null {
  return zone.broken ? zone.endTime : null;
}

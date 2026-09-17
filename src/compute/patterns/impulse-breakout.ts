import type { Candle, PatternResult, SignalStrength, IndicatorSnapshot, MarketStructure } from '@/types/domain';
import { lastNonNull, volumeRatio, hasReliableVolume } from '@/compute/indicators/helpers';
import { atr } from '@/compute/indicators/atr';
import { computeStructure } from '@/compute/indicators/trend-structure';
import type { SessionRegime } from '@/compute/session-regime';
import { sessionBoost } from './pattern-context';

function strengthForConfidence(confidence: number): SignalStrength {
  // Threshold is intentionally higher than the 0.75 convention used
  // elsewhere in this codebase: with the additive model below, a candle at
  // the bare minimum entry gate (base confidence 0.5, itself below
  // ENTRY_THRESHOLD without any bonus at all) can pick up at most +0.35 from
  // every bonus firing together (squeeze +0.10, volume +0.10, overlap
  // session +0.15) — reaching 0.85. At the shared 0.75 cutoff that bare-
  // minimum-body candle would misleadingly label as 'strong' on bonus
  // coincidence alone, exactly the failure mode this additive model (over
  // the old unbounded `confidence *= ...` chain) was built to prevent. 0.86
  // keeps that ceiling case at 'moderate' while a genuinely large body
  // (>=1.75x ATR, which alone clamps to confidence 1.0) still reaches
  // 'strong' on its own.
  if (confidence >= 0.86) return 'strong';
  if (confidence >= 0.5) return 'moderate';
  return 'weak';
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

const ENTRY_THRESHOLD = 0.6;
const MIN_VOLUME_RATIO = 1.5;
// Below this fraction of the range, a close that formally clears
// rangeHigh/rangeLow is still noise (a few pips of overshoot), not a real
// breakout — see "фитиль-отказ" fix (Пункт 4).
const MIN_BREAKOUT_MARGIN_ATR = 0.1;
// Opposite-wick fraction of the candle's full range above which the candle
// looks like a Wyckoff Upthrust / ICT liquidity grab (stop hunt + fast
// reversion) rather than genuine continuation.
const REJECTION_WICK_RATIO = 0.35;
const REJECTION_WICK_PENALTY = 0.20;

// Impulse breakout: candle closes beyond a recent 20-bar range with a body
// larger than ATR — see bolt-prompt-8-strategies-replacement.md Phase 4.1
// ("Стратегия «Импульсный прорыв»"), hardened per the impulse-breakout audit
// (fallback volume gate, honest M1-structure labeling, symmetric range
// BOS/CHoCH via trend-structure.ts, rejection-wick filter, additive
// confidence, structural SL/TP). `snapshot`/`structure`/`session` are
// optional so existing direct unit-test call sites without that context
// keep compiling, but the production pipeline (index.ts) always supplies
// them.
export function detectImpulseBreakout(
  candles: Candle[],
  snapshot?: IndicatorSnapshot,
  structure?: MarketStructure,
  session?: SessionRegime,
  lookback: number = 20,
  atrPeriod: number = 14,
): PatternResult | null {
  if (candles.length < lookback + 1) return null;

  const atrArr = atr(candles, atrPeriod);
  const atrValue = lastNonNull(atrArr);
  if (atrValue === null || atrValue <= 0) return null;

  const slice = candles.slice(-lookback - 1, -1);
  const rangeHigh = Math.max(...slice.map((c) => c.high));
  const rangeLow = Math.min(...slice.map((c) => c.low));
  const last = candles[candles.length - 1];
  const lastIdx = candles.length - 1;
  const body = Math.abs(last.close - last.open);

  // Forex/CFD OTC feeds (Deriv first in ROUTING_CHAIN.forex, and most other
  // forex sources) always report volume: 0 — there is no consolidated tape
  // on spot/CFD forex, only per-broker tick counts, and not even those from
  // every provider. averageVolume() returns 0 for such a window and the old
  // code read that through volumeRatio() as a flat 1, then hard-blocked
  // every bar with `if (volRatio < 1.5) return null` — meaning the strategy
  // could never fire at all on the default data source, independent of how
  // strong the real breakout was. hasReliableVolume() distinguishes "no
  // real volume signal in this window" from "genuinely average volume", so
  // the filter can be skipped (not just neutralized to a value that always
  // fails it) when volume data isn't actually available.
  const volumeReliable = hasReliableVolume(candles, lastIdx, 20);
  const volRatio = volumeReliable ? volumeRatio(candles, lastIdx, 20) : null;
  if (volumeReliable && volRatio! < MIN_VOLUME_RATIO) return null;

  // Compensate for the loss of the volume filter on volume-less sources by
  // requiring a larger breakout body (1.2x ATR instead of 1.0x) — keeps the
  // strategy selective on Deriv/most forex feeds instead of just dropping a
  // filter with nothing replacing it.
  const minBodyMultiple = volumeReliable ? 1.0 : 1.2;
  if (body < atrValue * minBodyMultiple) return null;

  let direction: 'buy' | 'sell' | null = null;
  if (last.close > rangeHigh && last.close > last.open) direction = 'buy';
  else if (last.close < rangeLow && last.close < last.open) direction = 'sell';
  if (direction === null) return null;

  // Rejection-wick / stop-hunt filter: the old condition only checked close
  // vs. range and candle direction, so (a) a close a fraction of a pip past
  // the level counted as a full breakout, and (b) a long opposite wick — the
  // textbook signature of a Wyckoff Upthrust / ICT liquidity sweep, i.e. a
  // reversal, not continuation — was invisible to the detector. On M1 forex
  // most false "impulse breakouts" are exactly this: a stop-run with a long
  // wick and a fast snap-back.
  const range = last.high - last.low;
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  let hasRejectionWick = false;

  if (direction === 'buy') {
    const breakoutMargin = last.close - rangeHigh;
    if (breakoutMargin < atrValue * MIN_BREAKOUT_MARGIN_ATR) return null;
    if (range > 0 && upperWick / range > REJECTION_WICK_RATIO) hasRejectionWick = true;
  } else {
    const breakoutMargin = rangeLow - last.close;
    if (breakoutMargin < atrValue * MIN_BREAKOUT_MARGIN_ATR) return null;
    if (range > 0 && lowerWick / range > REJECTION_WICK_RATIO) hasRejectionWick = true;
  }

  // M1 structural approximation (NOT a real higher-timeframe confirmation —
  // both `structure` and `coarseStructure` are computed on the same M1
  // candle array, just with different pivot windows). The old code called
  // this "structural confirmation (BOS/MSB старшего ТФ)" in comments while
  // computing it on the same M1 bars as everything else — misleading, since
  // ICT/SMC BOS/CHoCH confirmation is meant to come from a genuinely higher
  // timeframe. Without real M15/H1 data available, `coarseStructure` at
  // least updates less often than the base 50-bar `structure` used
  // elsewhere in the pipeline, so it's a coarser (not "higher timeframe")
  // read of the same M1 series — used here as a local-bias indicator, not a
  // real HTF filter.
  const coarseStructure = candles.length >= 150 ? computeStructure(candles, 150, true, atrPeriod) : structure;
  const structureOk = !!coarseStructure && coarseStructure.bos && coarseStructure.trend === (direction === 'buy' ? 'up' : 'down');

  // Bounded additive confidence model. The previous chain of `confidence *=`
  // multipliers only clamped once at the very end, so a candle that barely
  // cleared the entry gate (body ~1.2x ATR, base confidence ~0.6) could be
  // multiplied up past 1.0 by squeeze + volume + session landing together,
  // and get labeled "strong" purely from timing coincidence rather than
  // real impulse size. Here the body/ATR ratio is the dominant term, and
  // every secondary factor contributes a small, capped additive
  // bonus/penalty instead of an unbounded multiplier.
  const baseConfidence = clamp01(body / (atrValue * 2));
  let adjustment = 0;

  // BB squeeze before the breakout — approximation: IndicatorSnapshot only
  // carries the current band values (no historical width series), so
  // "squeeze" is approximated as narrow bands relative to current ATR,
  // rather than comparison against band width N bars back.
  if (snapshot?.bollingerUpper != null && snapshot?.bollingerLower != null) {
    const bandWidth = snapshot.bollingerUpper - snapshot.bollingerLower;
    if (bandWidth < atrValue * 2) adjustment += 0.10;
  }

  if (volumeReliable && volRatio! >= 2.0) adjustment += 0.10;

  if (session) adjustment += sessionBoost(session) - 1; // overlap:+0.15, london/ny:+0.05, asia:-0.30

  if (!structureOk) adjustment -= 0.15;
  if (hasRejectionWick) adjustment -= REJECTION_WICK_PENALTY;

  const confidence = clamp01(baseConfidence + adjustment);
  if (confidence < ENTRY_THRESHOLD) return null;

  return {
    name: 'impulse-breakout',
    direction,
    confidence,
    strength: strengthForConfidence(confidence),
    time: last.time,
    // Honest volume confirmation: only true when volume data was actually
    // reliable AND above the 2x-average bar — never a hardcoded true. This
    // feeds applyConfidenceHierarchy()'s +0.1 volumeConfirmed bonus in
    // patterns/index.ts, which used to be granted unconditionally.
    volumeConfirmed: volumeReliable ? volRatio! >= 2.0 : false,
    // Breakout candle extremes, used by signal-builder.ts to place a
    // structural stop (beyond the level that was just taken out) instead of
    // an arbitrary ATR-multiple-from-entry stop — see
    // computeBreakoutTradeLevels in trade-levels.ts.
    breakoutLow: last.low,
    breakoutHigh: last.high,
  };
}

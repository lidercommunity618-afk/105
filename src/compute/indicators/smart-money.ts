import type { Candle } from '@/types/domain';
import { PIVOT_LOOKUP } from './pivots';
import { analyzeOBTouches, type RejectionTouch, type OrderBlockStatus } from './order-block-strength';
import { detectFvgGeometry, computeAtrSeries } from './fvg-core';
import { atr } from './atr';
import {
  lastNonNull,
  DEFAULT_MIN_DISPLACEMENT_ATR_MULTIPLE,
  DEFAULT_DISPLACEMENT_ATR_PERIOD,
} from './helpers';

// How many bars before a FVG's left candle a same-direction BOS event may
// have occurred and still count as "structural confluence" for that FVG.
const BOS_CONFLUENCE_LOOKBACK_BARS = 5;
const DEFAULT_STRUCTURE_CONFIRM_WINDOW = 20;
// How many candles before the OB candle to look for the swing low/high that
// a valid OB's impulse is expected to have swept liquidity from first.
const DEFAULT_LIQUIDITY_SWEEP_LOOKBACK = 5;

export interface SmartMoneyOrderBlock {
  top: number;
  bottom: number;
  time: number;
  type: 'bullish' | 'bearish';
  mitigated: boolean;
  endTime: number | null;
  touchCount: number;
  rejections: RejectionTouch[];
  status: OrderBlockStatus;
  strengthScore: number;
  // Body of the OB candle (top = max(open,close), bottom = min(open,close)).
  // Kept separate from top/bottom (the candle's full high/low range, which
  // is what the zone itself is drawn as) so the ICT "mean threshold" — the
  // 50% level of the candle's BODY, the conventional OB entry trigger — can
  // be computed and drawn without changing the zone boundaries traded
  // against elsewhere in the app.
  bodyTop: number;
  bodyBottom: number;
  /** (bodyTop + bodyBottom) / 2 — the ICT "mean threshold" / OB 50% entry level. */
  meanThreshold: number;
  // Additional ICT confluence checks, computed for every block but NOT
  // gating by default (see requireFvgConfluence/requireLiquiditySweep
  // below) — same "always compute, opt-in to filter" convention as
  // hasDisplacement/hasStructureConfluence, so existing callers
  // (pattern-context.ts, ChartPanel.tsx, tests) keep seeing the same set of
  // blocks unless they explicitly ask for the stricter filter.
  //
  // A Fair Value Gap forms across the OB candle → breaking candle → the
  // candle right after (same 3-candle definition used everywhere else in
  // this file/order-block-strength.ts). Its presence is one of the 4
  // classic ICT OB-validity criteria.
  hasFvgConfluence: boolean;
  // A recent swing low/high was swept (wicked through) at or just before
  // the OB candle, in the direction opposite the impulse — i.e. the move
  // that produced this OB also grabbed resting liquidity first. Another of
  // the 4 classic ICT OB-validity criteria.
  hasLiquiditySweep: boolean;
  // True when the breaking (impulse) candle's own range clears
  // `minDisplacementAtrMultiple` × ATR — same rule and same defaults as
  // order-block-strength.ts / super-order-block.ts, so a candle either
  // counts as "a strong impulse" or it doesn't, consistently everywhere
  // this app draws or trades an Order Block. Gates the returned list by
  // default (see `requireDisplacement` below).
  hasDisplacement: boolean;
  // True when a structural break (BOS) in the same direction as this
  // block's impulse actually happened within `structureConfirmWindow`
  // candles of the breakout. Computed per-block against this block's own
  // formation (using the bosEvents already derived below), NOT against a
  // single "structure right now" snapshot — so, unlike the analogous flag
  // in order-block-strength.ts/super-order-block.ts, this one is safe to
  // gate on by default without hiding every historical block that isn't
  // exactly at the current bar. Gates the returned list by default (see
  // `requireStructureConfluence` below).
  hasStructureConfluence: boolean;
}

export interface SmartMoneyFVG {
  top: number;
  bottom: number;
  time: number;
  type: 'bullish' | 'bearish';
  broken: boolean;
  endTime: number | null;
  /**
   * Time of the first candle whose wick traded back into the zone far
   * enough to reach the CE midline — a partial mitigation (ICT "touched"),
   * much weaker and much more common than `broken`/`endTime` (full close
   * through the far boundary). This does NOT end the zone's life: the
   * signal engine (see `pickFreshUnbrokenFvgs` in
   * `fvg-strategies-shared.ts`) still treats a touched-but-unbroken zone as
   * live, and chart rendering (`ChartPanel.tsx`, via `fvgRenderCutoff` in
   * `fvg-core.ts`) intentionally does NOT cut the box off at this time —
   * only `broken`/`endTime` does. Kept for informational/UI-state use (e.g.
   * a "touched" badge), not for the box's right-edge cutoff. See
   * ImbalanceZone.touched in order-block-strength.ts for the same split.
   */
  touchedTime: number | null;
  /** Consequent Encroachment — (top + bottom) / 2, the key ICT reaction point. */
  ce: number;
  /** False when no ATR value was available to verify the middle candle's displacement (short history). Not a hard exclusion. */
  hasDisplacement: boolean;
  /** This FVG overlaps or is adjacent to an order block of the same direction. */
  hasOBConfluence: boolean;
  /** A same-direction BOS event occurred within BOS_CONFLUENCE_LOOKBACK_BARS bars before this FVG formed. */
  hasBOSConfluence: boolean;
}

export interface SmartMoneyRejectionBlock {
  top: number;
  bottom: number;
  time: number;
  type: 'bullish' | 'bearish';
}

export interface SmartMoneyBOSEvent {
  price: number;
  time: number;
  type: 'bullish' | 'bearish';
}

export interface SmartMoneyResult {
  orderBlocks: SmartMoneyOrderBlock[];
  fvgs: SmartMoneyFVG[];
  /** Zones created when a FVG in `fvgs` was invalidated by a candle closing through it — same bounds, opposite polarity. */
  inversionFvgs: SmartMoneyFVG[];
  /**
   * OB Breaker Block — the ICT role-inversion concept: an order block in
   * `orderBlocks` that got fully invalidated (closed through, `status ===
   * 'broken'`) has its zone re-purposed with inverted polarity, the same
   * way an invalidated FVG becomes an entry in `inversionFvgs` above. A
   * broken bullish OB (failed support) becomes a bearish breaker
   * (resistance); a broken bearish OB (failed resistance) becomes a
   * bullish breaker (support). See the generation loop below for the full
   * rationale and the origin-quality fields it carries over.
   */
  breakerBlocks: SmartMoneyOrderBlock[];
  rejectionBlocks: SmartMoneyRejectionBlock[];
  bosEvents: SmartMoneyBOSEvent[];
}

export interface SmartMoneyOptions {
  /** When true (default), order blocks whose impulse candle doesn't clear
   *  the displacement threshold are excluded — see hasDisplacement doc
   *  above. Set to false to get the raw candidate list (diagnostics/UI only). */
  requireDisplacement?: boolean;
  /** When true (default), order blocks with no matching BOS within
   *  `structureConfirmWindow` candles of the breakout are excluded — see
   *  hasStructureConfluence doc above. Set to false to get all candidates
   *  regardless of structural confirmation. */
  requireStructureConfluence?: boolean;
  /** Pre-computed ATR value for the order-block displacement check. If
   *  omitted, computed internally via atr(candles, atrPeriod) once per call.
   *  FVG displacement uses its own per-candle ATR series (see
   *  computeAtrSeries in fvg-core.ts) regardless of this value, unless
   *  `fvgAtrValue` below is set. */
  atrValue?: number | null;
  /** Period used for the internally-computed order-block ATR fallback above. */
  atrPeriod?: number;
  /** Minimum impulse-candle range, as a multiple of ATR, to count as
   *  genuine displacement (see hasDisplacement doc above). Applies to both
   *  order blocks and FVGs, per the spec's shared displacement rule. */
  minDisplacementAtrMultiple?: number;
  /** How many candles after the breakout to look for a same-direction BOS
   *  before concluding an order block wasn't structurally confirmed. */
  structureConfirmWindow?: number;
  /** Pre-computed, single ATR value to use uniformly for FVG displacement
   *  instead of the default per-candle ATR series. */
  fvgAtrValue?: number;
  /** How many candles before the OB candle to scan for the swing low/high
   *  that `hasLiquiditySweep` checks was swept. Default 5. */
  liquiditySweepLookback?: number;
  /** When true, order blocks with no FVG formed by their own impulse are
   *  excluded (see hasFvgConfluence doc above). Default false — off by
   *  default so this stricter ICT criterion doesn't silently shrink the
   *  block list for existing callers; opt in explicitly where wanted. */
  requireFvgConfluence?: boolean;
  /** When true, order blocks with no liquidity sweep before the OB candle
   *  are excluded (see hasLiquiditySweep doc above). Default false, same
   *  rationale as requireFvgConfluence. */
  requireLiquiditySweep?: boolean;
}

const isUp = (c: Candle) => c.close > c.open;
const isDown = (c: Candle) => c.close < c.open;

const zonesOverlapOrAdjacent = (aTop: number, aBottom: number, bTop: number, bBottom: number): boolean =>
  aBottom <= bTop && bBottom <= aTop;

export function calcSmartMoney(candles: Candle[], options?: SmartMoneyOptions): SmartMoneyResult {
  const orderBlocks: SmartMoneyOrderBlock[] = [];
  const fvgs: SmartMoneyFVG[] = [];
  const inversionFvgs: SmartMoneyFVG[] = [];
  const breakerBlocks: SmartMoneyOrderBlock[] = [];
  const rejectionBlocks: SmartMoneyRejectionBlock[] = [];
  const bosEvents: SmartMoneyBOSEvent[] = [];

  const n = candles.length;
  if (n < 2 * PIVOT_LOOKUP + 5) {
    return { orderBlocks, fvgs, inversionFvgs, breakerBlocks, rejectionBlocks, bosEvents };
  }

  const requireDisplacement = options?.requireDisplacement ?? true;
  const requireStructureConfluence = options?.requireStructureConfluence ?? true;
  const minMultiple = options?.minDisplacementAtrMultiple ?? DEFAULT_MIN_DISPLACEMENT_ATR_MULTIPLE;
  const atrPeriod = options?.atrPeriod ?? DEFAULT_DISPLACEMENT_ATR_PERIOD;
  const structureConfirmWindow = options?.structureConfirmWindow ?? DEFAULT_STRUCTURE_CONFIRM_WINDOW;
  const liquiditySweepLookback = options?.liquiditySweepLookback ?? DEFAULT_LIQUIDITY_SWEEP_LOOKBACK;
  const requireFvgConfluence = options?.requireFvgConfluence ?? false;
  const requireLiquiditySweep = options?.requireLiquiditySweep ?? false;
  const obAtrValue = options?.atrValue !== undefined
    ? options.atrValue
    : lastNonNull(atr(candles, atrPeriod));

  const hasObDisplacement = (impulseCandle: Candle): boolean => {
    if (obAtrValue == null || obAtrValue <= 0) return true; // no ATR context — don't silently exclude on it
    const impulseRange = impulseCandle.high - impulseCandle.low;
    return impulseRange >= obAtrValue * minMultiple;
  };

  // FVG displacement keeps its existing per-candle ATR(14) series behaviour
  // (local volatility per zone) unless the caller pins a single value.
  const fvgAtrValue = options?.fvgAtrValue;
  const atrSeries = fvgAtrValue === undefined ? computeAtrSeries(candles, 14) : null;
  const atrAt = (idx: number): number | null => (fvgAtrValue !== undefined ? fvgAtrValue : atrSeries![idx] ?? null);

  // time -> index lookup used below for BOS confluence lookback (both the
  // order-block structural-confirmation check and the FVG BOS-confluence
  // flag share this single map/pass instead of two separate BOS scans).
  const timeIndex = new Map<number, number>();
  candles.forEach((c, idx) => timeIndex.set(c.time, idx));

  // BOS events are computed once, up front, so both the order-block loop
  // below (structural confirmation at each block's own formation time) and
  // the FVG confluence pass further down can use the same data instead of
  // scanning pivots twice.
  let lastPivotHigh: number | null = null;
  let lastPivotLow: number | null = null;

  for (let i = PIVOT_LOOKUP; i < n - PIVOT_LOOKUP; i++) {
    const window = candles.slice(i - PIVOT_LOOKUP, i + PIVOT_LOOKUP + 1);
    const isPivHigh = window.every(c => c.high <= candles[i].high);
    const isPivLow = window.every(c => c.low >= candles[i].low);

    const confirmBar = i + PIVOT_LOOKUP;
    if (confirmBar >= n) continue;

    if (isPivHigh) lastPivotHigh = candles[i].high;
    if (isPivLow) lastPivotLow = candles[i].low;

    const cur = candles[confirmBar];
    const prev = candles[confirmBar - 1];

    if (lastPivotHigh !== null && prev && prev.close <= lastPivotHigh && cur.close > lastPivotHigh) {
      bosEvents.push({ price: lastPivotHigh, time: cur.time, type: 'bullish' });
    }
    if (lastPivotLow !== null && prev && prev.close >= lastPivotLow && cur.close < lastPivotLow) {
      bosEvents.push({ price: lastPivotLow, time: cur.time, type: 'bearish' });
    }
  }

  // Index BOS events by candle time so the OB loop below can cheaply check
  // "was there a same-direction BOS within N candles of this breakout"
  // without an O(n) scan per block.
  const bosTypesByTime = new Map<number, ('bullish' | 'bearish')[]>();
  for (const ev of bosEvents) {
    const list = bosTypesByTime.get(ev.time) ?? [];
    list.push(ev.type);
    bosTypesByTime.set(ev.time, list);
  }
  const hasStructureConfirmation = (breakIndex: number, direction: 'bullish' | 'bearish'): boolean => {
    const end = Math.min(n, breakIndex + structureConfirmWindow);
    for (let k = breakIndex; k < end; k++) {
      const types = bosTypesByTime.get(candles[k].time);
      if (types?.includes(direction)) return true;
    }
    return false;
  };

  // ICT criterion "liquidity sweep before the impulse": did the OB candle
  // (the last opposite-direction candle before displacement) wick through a
  // swing low/high made in the preceding window, opposite the impulse
  // direction? e.g. for a bullish OB, the bearish OB candle dipping below a
  // recent low right before reversing up is the classic "stop hunt" that
  // precedes accumulation. Checked once per candidate OB index below.
  const hasLiquiditySweepAt = (obIndex: number, direction: 'bullish' | 'bearish'): boolean => {
    const winStart = obIndex - liquiditySweepLookback;
    if (winStart < 0) return false;
    const priorCandles = candles.slice(winStart, obIndex);
    if (priorCandles.length === 0) return false;
    const obCandle = candles[obIndex];
    if (direction === 'bullish') {
      const priorLow = Math.min(...priorCandles.map((c) => c.low));
      return obCandle.low < priorLow;
    }
    const priorHigh = Math.max(...priorCandles.map((c) => c.high));
    return obCandle.high > priorHigh;
  };

  for (let i = 2; i < n; i++) {
    const obCandle = candles[i - 2];
    const brCandle = candles[i - 1];

    if (isDown(obCandle) && isUp(brCandle) && brCandle.close > obCandle.high) {
      // Zone = the OB candle's own high/low only, per spec — NOT extended
      // by the breaking candle's wick (previously: bottom included
      // brCandle.low, which widened/shifted the zone away from what the
      // decision engine — order-block-strength.ts / super-order-block.ts —
      // actually trades, so the chart and the decision engine disagreed on
      // where the same zone even was).
      const top = obCandle.high;
      const bottom = obCandle.low;
      const bodyTop = Math.max(obCandle.open, obCandle.close);
      const bodyBottom = Math.min(obCandle.open, obCandle.close);
      const displacementOk = hasObDisplacement(brCandle);
      const structureOk = hasStructureConfirmation(i - 1, 'bullish');
      const fvgOk = detectFvgGeometry(obCandle, brCandle, candles[i], atrAt(i - 1))?.type === 'bullish';
      const sweepOk = hasLiquiditySweepAt(i - 2, 'bullish');
      if (requireDisplacement && !displacementOk) continue;
      if (requireStructureConfluence && !structureOk) continue;
      if (requireFvgConfluence && !fvgOk) continue;
      if (requireLiquiditySweep && !sweepOk) continue;

      const after = candles.slice(i);
      const touches = analyzeOBTouches(after, 'bullish', top, bottom);
      orderBlocks.push({
        top, bottom, time: obCandle.time, type: 'bullish',
        mitigated: touches.status === 'broken',
        endTime: touches.breakTime,
        touchCount: touches.touchCount, rejections: touches.rejections,
        status: touches.status, strengthScore: touches.strengthScore,
        hasDisplacement: displacementOk, hasStructureConfluence: structureOk,
        bodyTop, bodyBottom, meanThreshold: (bodyTop + bodyBottom) / 2,
        hasFvgConfluence: fvgOk, hasLiquiditySweep: sweepOk,
      });
    }

    if (isUp(obCandle) && isDown(brCandle) && brCandle.close < obCandle.low) {
      const top = obCandle.high;
      const bottom = obCandle.low;
      const bodyTop = Math.max(obCandle.open, obCandle.close);
      const bodyBottom = Math.min(obCandle.open, obCandle.close);
      const displacementOk = hasObDisplacement(brCandle);
      const structureOk = hasStructureConfirmation(i - 1, 'bearish');
      const fvgOk = detectFvgGeometry(obCandle, brCandle, candles[i], atrAt(i - 1))?.type === 'bearish';
      const sweepOk = hasLiquiditySweepAt(i - 2, 'bearish');
      if (requireDisplacement && !displacementOk) continue;
      if (requireStructureConfluence && !structureOk) continue;
      if (requireFvgConfluence && !fvgOk) continue;
      if (requireLiquiditySweep && !sweepOk) continue;

      const after = candles.slice(i);
      const touches = analyzeOBTouches(after, 'bearish', top, bottom);
      orderBlocks.push({
        top, bottom, time: obCandle.time, type: 'bearish',
        mitigated: touches.status === 'broken',
        endTime: touches.breakTime,
        touchCount: touches.touchCount, rejections: touches.rejections,
        status: touches.status, strengthScore: touches.strengthScore,
        hasDisplacement: displacementOk, hasStructureConfluence: structureOk,
        bodyTop, bodyBottom, meanThreshold: (bodyTop + bodyBottom) / 2,
        hasFvgConfluence: fvgOk, hasLiquiditySweep: sweepOk,
      });
    }
  }

  // OB Breaker Block generation — mirrors the Inversion FVG loop below
  // (same "invalidation re-purposes the zone with the opposite polarity"
  // idea, applied to Order Blocks instead of FVGs). Runs right after the
  // order-block loop so every block's final `status`/`endTime` is already
  // known; iterates the full (unsliced) `orderBlocks` array so a breaker
  // isn't lost just because its origin later falls outside the `slice(-30)`
  // window applied to the return value.
  for (const ob of orderBlocks) {
    if (ob.status !== 'broken' || ob.endTime === null) continue;

    const invType: 'bullish' | 'bearish' = ob.type === 'bullish' ? 'bearish' : 'bullish';
    const breakIdx = timeIndex.get(ob.endTime) ?? -1;
    // A breaker zone starts life fresh at the moment of invalidation, so —
    // exactly like an Inversion FVG — it needs its own forward touch/break
    // scan from there; it does not inherit the origin OB's touchCount or
    // rejections. analyzeOBTouches is the same helper the origin OB itself
    // was scored with, so a breaker's status/strengthScore is computed on
    // identical terms.
    const after = breakIdx >= 0 ? candles.slice(breakIdx + 1) : [];
    const touches = analyzeOBTouches(after, invType, ob.top, ob.bottom);

    breakerBlocks.push({
      top: ob.top, bottom: ob.bottom, time: ob.endTime, type: invType,
      mitigated: touches.status === 'broken',
      endTime: touches.breakTime,
      touchCount: touches.touchCount, rejections: touches.rejections,
      status: touches.status, strengthScore: touches.strengthScore,
      // The zone's own geometry (body/mean-threshold) doesn't change on
      // inversion — only which side is now expected to react at it — so
      // these carry straight over from the origin block rather than being
      // recomputed against a candle that no longer exists at this index.
      bodyTop: ob.bodyTop, bodyBottom: ob.bodyBottom, meanThreshold: ob.meanThreshold,
      // Quality flags likewise describe how well-formed the ORIGIN
      // impulse was — a breaker inherited from a genuine, structurally
      // confirmed OB is a stronger breaker than one from a marginal block,
      // same logic as inversionFvgs copying hasOBConfluence/hasBOSConfluence
      // from their origin FVG below.
      hasDisplacement: ob.hasDisplacement, hasStructureConfluence: ob.hasStructureConfluence,
      hasFvgConfluence: ob.hasFvgConfluence, hasLiquiditySweep: ob.hasLiquiditySweep,
    });
  }

  // The inversion source index parallels inversionFvgs 1:1, pointing back
  // into fvgs — used below to copy confluence flags once they're computed.
  const inversionSourceIdx: number[] = [];

  for (let i = 2; i < n; i++) {
    const left = candles[i - 2];
    const mid = candles[i - 1];
    const cur = candles[i];

    const geo = detectFvgGeometry(left, mid, cur, atrAt(i - 1));
    if (!geo) continue;

    let endTime: number | null = null;
    let touchedTime: number | null = null;
    for (let j = i + 1; j < n; j++) {
      if (touchedTime === null) {
        const touchedCe = geo.type === 'bullish' ? candles[j].low <= geo.ce : candles[j].high >= geo.ce;
        if (touchedCe) touchedTime = candles[j].time;
      }
      const closedThrough = geo.type === 'bullish' ? candles[j].close < geo.bottom : candles[j].close > geo.top;
      if (closedThrough) { endTime = candles[j].time; break; }
    }
    const broken = endTime !== null;

    fvgs.push({
      top: geo.top, bottom: geo.bottom, time: left.time, type: geo.type,
      broken, endTime, touchedTime, ce: geo.ce, hasDisplacement: geo.hasDisplacement,
      hasOBConfluence: false, hasBOSConfluence: false,
    });

    if (broken) {
      // Inversion FVG: same bounds, opposite polarity, dated to the moment
      // of the invalidating close — not just a flag, a tradeable zone.
      // An inversion zone starts life fresh at the moment of invalidation,
      // so it needs its own touched/broken scan forward from there — it
      // does not inherit the source FVG's touchedTime.
      let ifvgEndTime: number | null = null;
      let ifvgTouchedTime: number | null = null;
      const invType = geo.type === 'bullish' ? 'bearish' : 'bullish';
      for (let j = i + 1; j < n; j++) {
        if (candles[j].time <= (endTime as number)) continue;
        if (ifvgTouchedTime === null) {
          const touchedCe = invType === 'bullish' ? candles[j].low <= geo.ce : candles[j].high >= geo.ce;
          if (touchedCe) ifvgTouchedTime = candles[j].time;
        }
        const closedThrough = invType === 'bullish' ? candles[j].close < geo.bottom : candles[j].close > geo.top;
        if (closedThrough) { ifvgEndTime = candles[j].time; break; }
      }

      inversionFvgs.push({
        top: geo.top, bottom: geo.bottom, time: endTime as number,
        type: invType,
        broken: ifvgEndTime !== null, endTime: ifvgEndTime, touchedTime: ifvgTouchedTime,
        ce: geo.ce, hasDisplacement: geo.hasDisplacement,
        hasOBConfluence: false, hasBOSConfluence: false,
      });
      inversionSourceIdx.push(fvgs.length - 1);
    }
  }

  // Confluence pass — orderBlocks and bosEvents are both fully populated by
  // this point, so each FVG can be checked against real OB/BOS confluence.
  for (const fvg of fvgs) {
    fvg.hasOBConfluence = orderBlocks.some((ob) =>
      ob.type === fvg.type && zonesOverlapOrAdjacent(fvg.top, fvg.bottom, ob.top, ob.bottom),
    );

    const leftIndex = timeIndex.get(fvg.time) ?? -1;
    fvg.hasBOSConfluence = leftIndex >= 0 && bosEvents.some((bos) => {
      if (bos.type !== fvg.type) return false;
      const bosIndex = timeIndex.get(bos.time) ?? -1;
      return bosIndex >= 0 && bosIndex <= leftIndex && leftIndex - bosIndex <= BOS_CONFLUENCE_LOOKBACK_BARS;
    });
  }
  inversionFvgs.forEach((ifvg, k) => {
    const origin = fvgs[inversionSourceIdx[k]];
    ifvg.hasOBConfluence = origin.hasOBConfluence;
    ifvg.hasBOSConfluence = origin.hasBOSConfluence;
  });

  for (let i = 2; i < n; i++) {
    const obCandle = candles[i - 2];
    const brCandle = candles[i - 1];

    const isDownRjbOb = isUp(obCandle) && isDown(brCandle) && brCandle.close < obCandle.low;
    if (isDownRjbOb) {
      const rjb1 = brCandle.high < (obCandle.close + 0.2 * (obCandle.high - obCandle.close));
      const rjb2 = brCandle.high > obCandle.high;
      if (rjb1) {
        rejectionBlocks.push({ top: obCandle.high, bottom: obCandle.close, time: obCandle.time, type: 'bearish' });
      } else if (rjb2) {
        rejectionBlocks.push({ top: brCandle.high, bottom: brCandle.open, time: brCandle.time, type: 'bearish' });
      }
    }

    const isUpRjbOb = isDown(obCandle) && isUp(brCandle) && brCandle.close > obCandle.high;
    if (isUpRjbOb) {
      const rjb1 = brCandle.low > (obCandle.close - 0.2 * (obCandle.close - obCandle.low));
      const rjb2 = brCandle.low < obCandle.low;
      if (rjb1) {
        rejectionBlocks.push({ top: obCandle.close, bottom: obCandle.low, time: obCandle.time, type: 'bullish' });
      } else if (rjb2) {
        rejectionBlocks.push({ top: brCandle.open, bottom: brCandle.low, time: brCandle.time, type: 'bullish' });
      }
    }
  }

  return {
    orderBlocks: orderBlocks.slice(-30),
    fvgs: fvgs.slice(-30),
    inversionFvgs: inversionFvgs.slice(-30),
    breakerBlocks: breakerBlocks.slice(-30),
    rejectionBlocks: rejectionBlocks.slice(-30),
    bosEvents: bosEvents.slice(-30),
  };
}

import type { Candle, PatternResult, SignalStrength, IndicatorSnapshot, MarketStructure } from '@/types/domain';
import { orderBlockStrength, detectImbalances } from '@/compute/indicators/order-block-strength';
import { supportResistance } from '@/compute/indicators/support-resistance';
import { macd } from '@/compute/indicators/macd';
import type { SessionRegime } from '@/compute/session-regime';
import { isHighLiquiditySession } from '@/compute/session-regime';
import type { SmartMoneyResult, SmartMoneyOrderBlock } from '@/compute/indicators/smart-money';

export interface OBCResult extends PatternResult {
  targetZone?: number;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function strengthForConfidence(confidence: number): SignalStrength {
  if (confidence >= 0.75) return 'strong';
  if (confidence >= 0.5) return 'moderate';
  return 'weak';
}

const N_BARS = 12;
const MAX_FRESH_CANDLES = 3;

// Order Block Continuation: a fresh (1–3 candles) untested OB coincides with
// a |MACD histogram| extreme in the surrounding N bars, signalling momentum
// continuation away from the block.
export function detectOrderBlockContinuation(
  candles: Candle[],
  snapshot?: IndicatorSnapshot,
  session?: SessionRegime,
  structure?: MarketStructure,
  smartMoney?: SmartMoneyResult,
): OBCResult | null {
  if (candles.length < 30) return null;

  // Fix #1: Use smartMoney.orderBlocks (correct formation-time structure
  // confluence via hasStructureConfirmation) instead of superOrderBlocks
  // (which gates against the current structure snapshot, not the snapshot
  // at the block's own formation — see smart-money.ts hasStructureConfirmation).
  // SmartMoneyOrderBlock uses top/bottom instead of high/low, type instead of
  // direction, and time instead of index — adapt accordingly.
  const allBlocks = smartMoney?.orderBlocks ?? [];
  const timeIndex = new Map<number, number>();
  candles.forEach((c, idx) => timeIndex.set(c.time, idx));
  const untestedBlocks: { block: SmartMoneyOrderBlock; blockIdx: number }[] = [];
  for (const b of allBlocks) {
    if (b.status !== 'untested' && b.status !== 'tested-hold') continue;
    const blockIdx = timeIndex.get(b.time) ?? -1;
    if (blockIdx < 0 || blockIdx >= candles.length) continue;
    untestedBlocks.push({ block: b, blockIdx });
  }
  if (untestedBlocks.length === 0) return null;

  const last = candles[candles.length - 1];
  const closes = candles.map((c) => c.close);
  const { histogram } = macd(closes, 12, 26, 9);

  let bestResult: OBCResult | null = null;
  let bestConfidence = 0;

  for (const { block, blockIdx } of untestedBlocks) {

    const candlesSinceFormation = candles.length - 1 - blockIdx;
    if (candlesSinceFormation < 1 || candlesSinceFormation > MAX_FRESH_CANDLES) continue;

    // Fix #2: Retrospective window — N_BARS bars BEFORE the block, not
    // "blockIdx-1, plus 12 forward". The old forward window structurally
    // excluded the freshest (1-bar-old) blocks because there weren't enough
    // future bars to fill the minimum. A retrospective window decouples
    // freshness from sample size.
    const windowEnd = blockIdx;
    const windowStart = Math.max(0, blockIdx - N_BARS);
    const windowAbs: number[] = [];
    for (let j = windowStart; j < windowEnd; j++) {
      if (histogram[j] !== null) windowAbs.push(Math.abs(histogram[j] as number));
    }
    if (windowAbs.length < 4) continue;

    // Fix #4: Read the block's own MACD histogram value directly from the
    // source array instead of indexing into the null-filtered windowAbs.
    // The old code computed obHistIdx as blockIdx - windowStart and used it
    // on windowAbs, but null entries in the original array shift all
    // indices in windowAbs, causing obHistIdx to point at the wrong bar.
    const obHistRaw = histogram[blockIdx];
    const obHistValue = obHistRaw !== null ? Math.abs(obHistRaw) : 0;
    const maxHist = Math.max(...windowAbs);
    const avgHist = windowAbs.reduce((a, b) => a + b, 0) / windowAbs.length;

    // OB formation bar's histogram must be the extreme (or within 80% of it)
    if (obHistValue < maxHist * 0.8) continue;

    const confidenceRaw = clamp01(avgHist > 0 ? obHistValue / (avgHist * 2) : 0.5);
    const direction = block.type === 'bullish' ? 'buy' : 'sell';

    // RSI-extreme hard filter (TIER 3, п.12): a fresh continuation block
    // entered while RSI already sits in an extreme reading is a documented
    // red flag, not just a minor confluence miss — skip this block entirely.
    if (snapshot?.rsi != null) {
      if (direction === 'buy' && snapshot.rsi > 75) continue;
      if (direction === 'sell' && snapshot.rsi < 25) continue;
    }

    let confidence = confidenceRaw;

    // Kill Zone bonus (TIER 2, п.7).
    if (session && isHighLiquiditySession(session)) confidence *= 1.2;

    // EMA confluence bonus (TIER 2, п.10): block sits on the "far side" of
    // the fast EMA relative to its direction (bullish block above emaFast,
    // bearish block below it).
    if (snapshot?.emaFast != null) {
      const emaAligned = direction === 'buy' ? block.bottom > snapshot.emaFast : block.top < snapshot.emaFast;
      if (emaAligned) confidence *= 1.1;
    }

    // BB expansion bonus (TIER 3, п.13) — approximation: IndicatorSnapshot
    // only carries the latest Bollinger values (no historical band-width
    // series to compare against), so we approximate "expansion" as the
    // current band width exceeding 2x ATR, rather than comparing to the
    // width N bars ago.
    if (snapshot?.bollingerUpper != null && snapshot?.bollingerLower != null && snapshot?.atr != null) {
      const bandWidth = snapshot.bollingerUpper - snapshot.bollingerLower;
      if (bandWidth > snapshot.atr * 2) confidence *= 1.05;
    }

    // Structure confluence bonus: smartMoney.orderBlocks already gates on
    // hasStructureConfluence by default (requireStructureConfluence=true in
    // calcSmartMoney), so every surviving block here has it — this is now
    // always true, kept for confidence shape consistency.
    if (block.hasStructureConfluence) confidence *= 1.1;

    confidence = clamp01(confidence);
    if (confidence <= bestConfidence) continue;

    const targetZone = findTargetZone(candles, direction, last.close);

    bestConfidence = confidence;
    bestResult = {
      name: 'order-block-continuation',
      direction,
      confidence,
      strength: strengthForConfidence(confidence),
      time: last.time,
      targetZone,
    };
  }

  return bestResult;
}

function findTargetZone(
  candles: Candle[],
  direction: 'buy' | 'sell',
  currentPrice: number,
): number | undefined {
  const candidates: number[] = [];

  const obZones = orderBlockStrength(candles, 50, undefined, false);
  for (const z of obZones) {
    if (z.status === 'broken') continue;
    const level = direction === 'buy' ? z.high : z.low;
    if (direction === 'buy' && level > currentPrice) candidates.push(level);
    if (direction === 'sell' && level < currentPrice) candidates.push(level);
  }

  const fvgs = detectImbalances(candles);
  for (const f of fvgs) {
    if (f.invalidated) continue;
    const level = direction === 'buy' ? f.upper : f.lower;
    if (direction === 'buy' && level > currentPrice) candidates.push(level);
    if (direction === 'sell' && level < currentPrice) candidates.push(level);
  }

  const levels = supportResistance(candles);
  for (const l of levels) {
    if (direction === 'buy' && l.price > currentPrice) candidates.push(l.price);
    if (direction === 'sell' && l.price < currentPrice) candidates.push(l.price);
  }

  if (candidates.length === 0) return undefined;
  // Наблюдение при аудите: раньше здесь была тернарная развилка по
  // `direction`, но обе ветки содержали ИДЕНТИЧНОЕ выражение
  // (Math.abs(a - currentPrice) - Math.abs(b - currentPrice)) — мёртвый
  // код, оставшийся от неполного рефакторинга. На фактический результат
  // это не влияет: `candidates` и для 'buy', и для 'sell' уже
  // односторонне отфильтрованы (см. циклы выше — только уровни строго по
  // нужную сторону от currentPrice), так что сортировка по абсолютному
  // расстоянию корректна для обоих направлений без развилки. Убрано, чтобы
  // не создавать ложное впечатление, будто здесь разная логика для buy/sell.
  candidates.sort((a, b) => Math.abs(a - currentPrice) - Math.abs(b - currentPrice));
  return candidates[0];
}

import type { Candle, PatternResult, SignalStrength, MarketStructure } from '@/types/domain';
import { atr } from '@/compute/indicators/atr';
import { lastNonNull } from '@/compute/indicators/helpers';
import type { SessionRegime } from '@/compute/session-regime';
import { obFvgConfluenceBonus, intervalSeconds } from './pattern-context';
import type { SmartMoneyResult } from '@/compute/indicators/smart-money';

function strengthForConfidence(confidence: number): SignalStrength {
  if (confidence >= 0.75) return 'strong';
  if (confidence >= 0.5) return 'moderate';
  return 'weak';
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

const MIN_SCORE = 5;
const MAX_SCORE = 10;

// Strong order block reaction — see bolt-prompt-8-strategies-replacement.md
// Phase 2.1. A 0–10 point scoring system (§8 SCORING SYSTEM of the source
// strategy document) replaces the old single strength*ratio confidence:
//   +2 HTF bias (block direction matches structure.trend)
//   +2 displacement into the block was >= 2x ATR
//   +2 block.status === 'tested-hold'
//   +1 Kill Zone session (london/newyork)
//   +1 OB/FVG confluence bonus present
//   +1 structure.bos true after the reaction
//   +1 reaction in the discount/premium half of the recent 20-bar range
// Below MIN_SCORE points -> no trade (documented: "< 5 баллов — пропустить сделку").
export function detectStrongOrderBlockReaction(
  candles: Candle[],
  structure: MarketStructure,
  session: SessionRegime,
  smartMoney?: SmartMoneyResult,
  atrPeriod: number = 14,
  // BUGFIX (аудит 2026-09-06, п.3 "псевдо-HTF bias"): `structure` здесь —
  // M1-структура (ctx.structure), которая уместна для п.6 "structure.bos true
  // после реакции" (это и должно быть немедленное M1-подтверждение), но
  // раньше выдавалась и за п.1 "HTF bias", хотя физически считалась на том
  // же M1-графике. htfStructure — отдельный параметр с настоящей M15
  // структурой (см. htf-structure.ts); когда он не передан (например, в
  // старых тестах), HTF-bias гейт консервативно отключается (пропускается),
  // а не тихо откатывается на M1 `structure`, чтобы не воскресить тот же баг.
  htfStructure?: MarketStructure,
): PatternResult | null {
  if (candles.length < 20) return null;

  const atrArr = atr(candles, atrPeriod);
  const atrValue = lastNonNull(atrArr);
  if (atrValue === null || atrValue <= 0) return null;

  // Fix #1: Use smartMoney.orderBlocks (correct formation-time structure
  // confluence) instead of superOrderBlocks (which gates against the current
  // structure snapshot). smartMoney is already passed as the 4th parameter
  // but was previously unused — the detector still called superOrderBlocks
  // internally. Now we consume the pre-computed orderBlocks from smartMoney.
  const allBlocks = smartMoney?.orderBlocks ?? [];
  const timeIndex = new Map<number, number>();
  candles.forEach((c, idx) => timeIndex.set(c.time, idx));
  const activeBlocks = allBlocks.filter((b) => b.status !== 'broken');
  if (activeBlocks.length === 0) return null;

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const rangeWindow = candles.slice(-20);
  const rangeHigh = Math.max(...rangeWindow.map((c) => c.high));
  const rangeLow = Math.min(...rangeWindow.map((c) => c.low));
  const rangeMid = (rangeHigh + rangeLow) / 2;

  let bestScore = 0;
  let bestResult: PatternResult | null = null;

  for (const block of activeBlocks) {
    const direction: 'buy' | 'sell' = block.type === 'bullish' ? 'buy' : 'sell';
    const reacted =
      direction === 'buy'
        ? prev.low <= block.top && last.close > block.top
        : prev.high >= block.bottom && last.close < block.bottom;
    if (!reacted) continue;

    // 1. HTF bias (hard requirement): block direction must agree with the
    //    trend on a genuinely higher timeframe (M15 resample — see
    //    htf-structure.ts), otherwise this reaction is counter-trend and the
    //    document treats it as a hard skip. Falls back to not gating (rather
    //    than silently reusing the M1 `structure` param) when no htfStructure
    //    is supplied, so a missing HTF read fails open in tests instead of
    //    reintroducing the M1-masquerading-as-HTF bug.
    const htfDirection = direction === 'buy' ? 'up' : 'down';
    if (htfStructure && htfStructure.trend !== htfDirection) continue;

    let score = 2; // HTF bias satisfied

    // 2. Displacement that formed the block must be >= 2x ATR (a stronger
    //    bar than the >= 1.2x ATR baseline super-order-block.ts already
    //    requires just to form a block at all — this is the "extra strong"
    //    scoring tier). SmartMoneyOrderBlock has no `index` field — look up
    //    the candle index via the block's `time` field against a pre-built
    //    Map for O(1) access instead of candles.findIndex() per block.
    const blockIdx = timeIndex.get(block.time) ?? -1;
    if (blockIdx >= 0 && blockIdx + 1 < candles.length) {
      const impulse = candles[blockIdx + 1];
      const impulseRange = impulse.high - impulse.low;
      if (impulseRange >= atrValue * 2) score += 2;
    }

    // 3. Zone quality: tested-hold is the strongest bounce setup.
    if (block.status === 'tested-hold') score += 2;

    // 4. Kill Zone session bonus.
    if (session === 'london' || session === 'newyork') score += 1;

    // 5. OB/FVG confluence bonus (only when smart-money context is supplied).
    if (smartMoney) {
      const bonus = obFvgConfluenceBonus(smartMoney, last, direction, atrValue, intervalSeconds(candles));
      if (bonus > 0) score += 1;
    }

    // 6. Structural confirmation (MSB/BOS) after the reaction.
    if (structure.bos) score += 1;

    // 7. Premium/discount positioning: buys reacting in the lower
    //    (discount) half of the recent range, sells in the upper
    //    (premium) half, are the higher-quality setups documented.
    const inDiscount = direction === 'buy' ? last.close <= rangeMid : last.close >= rangeMid;
    if (inDiscount) score += 1;

    if (score < MIN_SCORE) continue;
    if (score <= bestScore) continue;

    const confidence = clamp01(score / MAX_SCORE);
    bestScore = score;
    bestResult = {
      name: 'strong-order-block-reaction',
      direction,
      confidence,
      strength: strengthForConfidence(confidence),
      time: last.time,
    };
  }

  return bestResult;
}

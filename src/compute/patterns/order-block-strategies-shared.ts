import type { SmartMoneyOrderBlock } from '@/compute/indicators/smart-money';
import { fvgAgeBars } from './fvg-strategies-shared';

// Shared helpers for the Order Block family strategies added alongside the
// existing pair (order-block-continuation.ts, strong-order-block-reaction.ts
// — both built on super-order-block.ts, a separate detector): order-block-
// breaker.ts and order-block-nested.ts, both built on smart-money.ts's
// `orderBlocks`/`breakerBlocks`. `fvgAgeBars` is reused as-is from
// fvg-strategies-shared.ts — it's plain "how many bars old is this
// zone" arithmetic, not actually FVG-specific despite the file it lives in.

/** Unbroken, same-direction order blocks no older than maxAgeBars — the OB
 *  equivalent of pickFreshUnbrokenFvgs (same "age < N bars" mandatory
 *  freshness filter used across the FVG strategy family, applied here to
 *  Order Blocks so both families are held to the same staleness rule). */
export function pickFreshUnbrokenOrderBlocks(
  blocks: SmartMoneyOrderBlock[],
  direction: 'bullish' | 'bearish',
  lastTime: number,
  intervalSec: number,
  maxAgeBars: number,
): SmartMoneyOrderBlock[] {
  return blocks.filter((b) => {
    if (b.type !== direction || b.status === 'broken') return false;
    const age = fvgAgeBars(b.time, lastTime, intervalSec);
    return age >= 0 && age <= maxAgeBars;
  });
}

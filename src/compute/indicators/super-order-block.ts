import type { Candle, MarketStructure } from '@/types/domain';
import { analyzeOBTouches, structureConfluence, type OrderBlockStatus, type RejectionTouch } from './order-block-strength';
import { atr } from './atr';
import {
  lastNonNull,
  DEFAULT_MIN_DISPLACEMENT_ATR_MULTIPLE,
  DEFAULT_DISPLACEMENT_ATR_PERIOD,
} from './helpers';

// DEAD-CODE NOTICE (аудит 2026-09-12, п.6): superOrderBlocks() ниже больше
// НЕ вызывается ни в одном реальном месте пайплайна (проверено: не
// встречается в IndicatorAggregator.ts, full-snapshot.ts, patterns/index.ts,
// ChartPanel.tsx). Все живые OB-стратегии (order-block-continuation.ts,
// strong-order-block-reaction.ts, macd-deceleration-continuation.ts) явно
// задокументированы как перешедшие на smartMoney.orderBlocks из
// smart-money.ts. Настройка 'super-order-block' в settingsStore.ts/
// types/domain.ts сохранена только ради UI/обратной совместимости и сейчас
// ни на что не влияет. Файл оставлен как есть (не удалён), чтобы не ломать
// существующие импорты/тесты, ссылающиеся на типы SuperOrderBlock.

export interface SuperOrderBlock {
  open: number;
  close: number;
  high: number;
  low: number;
  direction: 'bullish' | 'bearish';
  // Redefined to match "Mitigation Block" from the spec (a zone the price
  // has broken and closed beyond) — same meaning as `breaker`/`status ===
  // 'broken'`, and consistent with the same field in smart-money.ts and
  // order-block-strength.ts, instead of the old `touchCount > 0` (which
  // conflated "touched at all" with "invalidated").
  mitigated: boolean;
  breaker: boolean;
  touchCount: number;
  rejections: RejectionTouch[];
  status: OrderBlockStatus;
  strengthScore: number;
  // Position of the OB candle in the ORIGINAL `candles` array (not the
  // internal lookback slice). Lets callers locate the impulse candle
  // (candles[index + 1]) and formation time reliably, instead of
  // re-deriving it via OHLC-value matching, which breaks on duplicate
  // OHLC values (flat/rangebound candles, repeated round levels on forex).
  index: number;
  time: number;
  // Impulse candle's range is at least `minDisplacementAtrMultiple` × ATR —
  // i.e. this is a genuine institutional-size displacement, not just any
  // directional close. Gates the returned list by default (see
  // `requireDisplacement` below) because it's scoped to this specific
  // block's own impulse candle, unlike structure confluence below.
  hasDisplacement: boolean;
  // Block direction agrees with the `structure` passed in via options
  // (BOS/CHoCH in the same direction). Informational only by default —
  // NOT auto-computed and NEVER gates the returned list unless the caller
  // explicitly passes `requireStructureConfluence: true`, because bos/choch
  // are edge-triggered (true only on the exact breaking candle — see
  // computeStructure in trend-structure.ts) and `structure` here is a single
  // "right now" snapshot, not the structure at each historical block's own
  // formation time. Gating on it by default would make this function return
  // almost nothing almost all the time.
  hasStructureConfluence: boolean;
}

export interface SuperOrderBlockOptions {
  /** Pre-computed ATR value for the displacement check. If omitted (and
   *  `requireDisplacement` isn't disabled), computed internally via
   *  atr(candles, atrPeriod) — cheap, O(candles.length), once per call. */
  atrValue?: number | null;
  /** Period used for the internally-computed ATR fallback above. */
  atrPeriod?: number;
  /** Minimum impulse-candle range, as a multiple of ATR, to count as genuine
   *  displacement (see hasDisplacement doc above). */
  minDisplacementAtrMultiple?: number;
  /** When true (default), blocks whose impulse candle doesn't clear the
   *  displacement threshold are excluded from the returned array. Set to
   *  false to get the raw candidate list (e.g. for diagnostics/UI, or when
   *  ATR context genuinely isn't available and you'd rather not filter
   *  blindly). */
  requireDisplacement?: boolean;
  /** Current market structure, used only to compute the informational
   *  `hasStructureConfluence` flag on each block (see doc above). Not used
   *  for anything else unless `requireStructureConfluence` is also true. */
  structure?: MarketStructure;
  /** When true, additionally require hasStructureConfluence to keep a block.
   *  Off by default — see the caveat on hasStructureConfluence above before
   *  enabling this for a whole historical block list. */
  requireStructureConfluence?: boolean;
}

export function superOrderBlocks(
  candles: Candle[],
  lookback: number = 100,
  options?: SuperOrderBlockOptions,
): SuperOrderBlock[] {
  if (candles.length < 10) return [];

  const requireDisplacement = options?.requireDisplacement ?? true;
  const requireStructureConfluence = options?.requireStructureConfluence ?? false;
  const minMultiple = options?.minDisplacementAtrMultiple ?? DEFAULT_MIN_DISPLACEMENT_ATR_MULTIPLE;
  const atrPeriod = options?.atrPeriod ?? DEFAULT_DISPLACEMENT_ATR_PERIOD;

  const atrValue = options?.atrValue !== undefined
    ? options.atrValue
    : (requireDisplacement ? lastNonNull(atr(candles, atrPeriod)) : null);

  const slice = candles.slice(-lookback);
  const sliceOffset = candles.length - slice.length;
  const blocks: SuperOrderBlock[] = [];

  for (let i = 2; i < slice.length - 1; i += 1) {
    const current = slice[i];
    const next = slice[i + 1];
    const after = slice.slice(i + 2);

    // Break of the OB candle's own high/low by the impulse candle's close —
    // per the spec, price must clear the HIGH of a bullish OB / LOW of a
    // bearish OB. Previously compared against `current.open`, a much weaker
    // threshold that let many non-breaking candles count as valid OBs.
    const bullish = current.close < current.open && next.close > current.high;
    const bearish = current.close > current.open && next.close < current.low;

    if (bullish || bearish) {
      const direction = bullish ? 'bullish' : 'bearish';

      const impulseRange = next.high - next.low;
      const hasDisplacement = atrValue != null && atrValue > 0
        ? impulseRange >= atrValue * minMultiple
        : true; // no ATR context available — don't silently exclude on it

      const hasStructureConfluence = structureConfluence(options?.structure, direction);

      if (requireDisplacement && !hasDisplacement) continue;
      if (requireStructureConfluence && !hasStructureConfluence) continue;

      const analysis = analyzeOBTouches(after, direction, current.high, current.low);
      blocks.push({
        open: current.open, close: current.close, high: current.high, low: current.low,
        direction, mitigated: analysis.status === 'broken', breaker: analysis.status === 'broken',
        touchCount: analysis.touchCount, rejections: analysis.rejections,
        status: analysis.status, strengthScore: analysis.strengthScore,
        index: sliceOffset + i, time: current.time,
        hasDisplacement, hasStructureConfluence,
      });
    }
  }

  return blocks;
}

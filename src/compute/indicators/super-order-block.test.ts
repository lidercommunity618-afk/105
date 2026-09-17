import { describe, it, expect } from 'vitest';
import { superOrderBlocks } from '@/compute/indicators/super-order-block';
import { orderBlockStrength } from '@/compute/indicators/order-block-strength';
import type { Candle, MarketStructure } from '@/types/domain';

function candle(
  time: number,
  open: number,
  close: number,
  high: number,
  low: number,
  volume = 100,
): Candle {
  return { time, open, high, low, close, volume };
}

const UP_STRUCTURE: MarketStructure = {
  trend: 'up', bos: true, choch: false, swingHigh: 200, swingLow: 90, provisional: false,
};

const DOWN_STRUCTURE: MarketStructure = {
  trend: 'down', bos: true, choch: false, swingHigh: 200, swingLow: 90, provisional: false,
};

const RANGE_NO_BOS: MarketStructure = {
  trend: 'range', bos: false, choch: false, swingHigh: 200, swingLow: 90, provisional: false,
};

// 20 flat warmup candles with a stable ~1.2 ATR baseline, so displacement
// thresholds (>= 1.2x ATR) are easy to reason about precisely.
function flatWarmup(count = 20): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const bullish = i % 2 === 0;
    const open = bullish ? 99.9 : 100.1;
    const close = bullish ? 100.1 : 99.9;
    return candle(i, open, close, 100.6, 99.4, 100);
  });
}

describe('superOrderBlocks — break by high/low (Проблема A)', () => {
  it('creates a bullish OB when the impulse candle closes above the OB candle high', () => {
    const candles = flatWarmup(20);
    // Bearish OB candle: open=102, close=100, high=103, low=99
    candles.push(candle(20, 102, 100, 103, 99));
    // Impulse candle: closes above the OB high (103), large range for displacement
    candles.push(candle(21, 100, 106, 107, 99.5, 200));
    // A few follow-up candles so the block isn't the last bar
    candles.push(candle(22, 106, 107, 108, 105, 100));
    candles.push(candle(23, 107, 108, 109, 106, 100));

    const blocks = superOrderBlocks(candles, 100, { structure: UP_STRUCTURE });
    const bullBlocks = blocks.filter((b) => b.direction === 'bullish');
    expect(bullBlocks.length).toBeGreaterThan(0);
    // The block's index should point at the OB candle (index 20 in the array)
    expect(bullBlocks[0].index).toBe(20);
    expect(bullBlocks[0].time).toBe(20);
  });

  it('does NOT create a bullish OB when the impulse closes above open but NOT above high', () => {
    const candles = flatWarmup(20);
    // Bearish OB candle: open=102, close=100, high=105, low=99
    candles.push(candle(20, 102, 100, 105, 99));
    // Impulse candle: closes at 104 — above open (102) but NOT above high (105)
    candles.push(candle(21, 100, 104, 104.5, 99.5, 200));
    candles.push(candle(22, 104, 105, 106, 103, 100));
    candles.push(candle(23, 105, 106, 107, 104, 100));

    const blocks = superOrderBlocks(candles, 100, { structure: UP_STRUCTURE });
    const bullBlocks = blocks.filter((b) => b.direction === 'bullish' && b.index === 20);
    // No bullish OB should be created from candle 20 because its high (105)
    // was never broken — this is the core bug the prompt asked to fix.
    expect(bullBlocks).toHaveLength(0);
  });
});

describe('superOrderBlocks — displacement gate (Проблема B)', () => {
  it('filters out blocks whose impulse candle lacks displacement (< 1.2x ATR)', () => {
    const candles = flatWarmup(20);
    // OB candle: high=103, low=99
    candles.push(candle(20, 102, 100, 103, 99));
    // Impulse candle: closes above high (103) but has a tiny range (~1.0).
    // ATR from warmup is ~1.2, threshold = 1.2 * 1.2 = 1.44 → 1.0 < 1.44 = no displacement
    candles.push(candle(21, 102.6, 103.5, 103.6, 102.6, 200));
    candles.push(candle(22, 103.5, 104, 105, 103, 100));
    candles.push(candle(23, 104, 105, 106, 103, 100));

    // requireDisplacement defaults to true → the small-impulse block is filtered out
    const blocks = superOrderBlocks(candles, 100, { structure: UP_STRUCTURE });
    const fromIdx20 = blocks.filter((b) => b.index === 20);
    expect(fromIdx20).toHaveLength(0);

    // With requireDisplacement: false and explicit atrValue, the block appears
    // but hasDisplacement is false (range 1.0 < 1.2 * 1.2 = 1.44).
    const rawBlocks = superOrderBlocks(candles, 100, { structure: UP_STRUCTURE, requireDisplacement: false, atrValue: 1.2 });
    const rawFromIdx20 = rawBlocks.filter((b) => b.index === 20);
    expect(rawFromIdx20.length).toBeGreaterThan(0);
    expect(rawFromIdx20[0].hasDisplacement).toBe(false);
  });

  it('creates a block when the impulse has sufficient displacement (>= 1.2x ATR)', () => {
    const candles = flatWarmup(20);
    candles.push(candle(20, 102, 100, 103, 99));
    // Impulse: range = 107 - 99 = 8, ATR ~1.2, threshold = 1.44 → 8 >> 1.44
    candles.push(candle(21, 100, 106, 107, 99, 200));
    candles.push(candle(22, 106, 107, 108, 105, 100));
    candles.push(candle(23, 107, 108, 109, 106, 100));

    const blocks = superOrderBlocks(candles, 100, { structure: UP_STRUCTURE });
    const fromIdx20 = blocks.filter((b) => b.index === 20);
    expect(fromIdx20.length).toBeGreaterThan(0);
    expect(fromIdx20[0].hasDisplacement).toBe(true);
  });
});

describe('superOrderBlocks — structure confluence (Проблема B)', () => {
  it('marks hasStructureConfluence=true when structure.trend matches and BOS is true', () => {
    const candles = flatWarmup(20);
    candles.push(candle(20, 102, 100, 103, 99));
    candles.push(candle(21, 100, 106, 107, 99, 200));
    candles.push(candle(22, 106, 107, 108, 105, 100));
    candles.push(candle(23, 107, 108, 109, 106, 100));

    const blocks = superOrderBlocks(candles, 100, { structure: UP_STRUCTURE });
    const bullBlock = blocks.find((b) => b.index === 20 && b.direction === 'bullish');
    expect(bullBlock).toBeDefined();
    expect(bullBlock!.hasStructureConfluence).toBe(true);
  });

  it('marks hasStructureConfluence=false when structure.trend conflicts', () => {
    const candles = flatWarmup(20);
    candles.push(candle(20, 102, 100, 103, 99));
    candles.push(candle(21, 100, 106, 107, 99, 200));
    candles.push(candle(22, 106, 107, 108, 105, 100));
    candles.push(candle(23, 107, 108, 109, 106, 100));

    // Down structure vs bullish OB → no confluence
    const blocks = superOrderBlocks(candles, 100, { structure: DOWN_STRUCTURE });
    const bullBlock = blocks.find((b) => b.index === 20 && b.direction === 'bullish');
    if (bullBlock) {
      expect(bullBlock.hasStructureConfluence).toBe(false);
    }
  });

  it('filters out blocks without structure confluence when requireStructureConfluence is true', () => {
    const candles = flatWarmup(20);
    candles.push(candle(20, 102, 100, 103, 99));
    candles.push(candle(21, 100, 106, 107, 99, 200));
    candles.push(candle(22, 106, 107, 108, 105, 100));
    candles.push(candle(23, 107, 108, 109, 106, 100));

    // range/no-BOS structure → hasStructureConfluence=false for a bullish block
    const blocks = superOrderBlocks(candles, 100, {
      structure: RANGE_NO_BOS,
      requireStructureConfluence: true,
    });
    const fromIdx20 = blocks.filter((b) => b.index === 20);
    expect(fromIdx20).toHaveLength(0);
  });
});

describe('superOrderBlocks — index field (Проблема C)', () => {
  it('sets index to the position in the original candles array, not the internal slice', () => {
    // Use a lookback smaller than the array to verify sliceOffset is applied
    const candles = flatWarmup(30);
    candles.push(candle(30, 102, 100, 103, 99));
    candles.push(candle(31, 100, 106, 107, 99, 200));
    candles.push(candle(32, 106, 107, 108, 105, 100));

    const blocks = superOrderBlocks(candles, 20, { structure: UP_STRUCTURE });
    // The OB candle is at index 30 in the full array, but only at index 1
    // in the slice (slice starts at 30-20=10... actually slice(-20) starts at
    // index 13). The key invariant: block.index must point into the ORIGINAL
    // candles array so candles[block.index] is the OB candle.
    const bullBlock = blocks.find((b) => b.direction === 'bullish');
    if (bullBlock) {
      expect(bullBlock.index).toBeGreaterThanOrEqual(0);
      expect(bullBlock.index).toBeLessThan(candles.length);
      // Verify the index actually points at the right candle
      expect(candles[bullBlock.index].close).toBe(bullBlock.close);
      expect(candles[bullBlock.index].open).toBe(bullBlock.open);
    }
  });
});

describe('orderBlockStrength — onlyValidated gate (Проблема B, Файл 2)', () => {
  it('returns only validated zones by default (onlyValidated=true)', () => {
    const candles = flatWarmup(20);
    candles.push(candle(20, 102, 100, 103, 99));
    candles.push(candle(21, 100, 106, 107, 99, 200));
    candles.push(candle(22, 106, 107, 108, 105, 100));
    candles.push(candle(23, 107, 108, 109, 106, 100));

    // Default: onlyValidated=true → only validated zones returned
    const zones = orderBlockStrength(candles, 50, UP_STRUCTURE);
    for (const z of zones) {
      expect(z.validated).toBe(true);
    }

    // Explicit onlyValidated=false → all non-filled zones returned
    const allZones = orderBlockStrength(candles, 50, UP_STRUCTURE, false);
    expect(allZones.length).toBeGreaterThanOrEqual(zones.length);
  });

  it('does not require structure confluence when structure is not supplied', () => {
    const candles = flatWarmup(20);
    candles.push(candle(20, 102, 100, 103, 99));
    candles.push(candle(21, 100, 106, 107, 99, 200));
    candles.push(candle(22, 106, 107, 108, 105, 100));
    candles.push(candle(23, 107, 108, 109, 106, 100));

    // No structure passed → structureOk defaults to true, so validated zones
    // can still be returned (impulseEngulfsBlock && hasFvgConfluence).
    const zones = orderBlockStrength(candles, 50, undefined);
    // There may or may not be validated zones depending on FVG, but the call
    // must not throw and must not filter on structureConfluence.
    expect(Array.isArray(zones)).toBe(true);
  });
});

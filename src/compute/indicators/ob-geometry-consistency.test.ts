import { describe, it, expect } from 'vitest';
import { calcSmartMoney } from './smart-money';
import { orderBlockStrength } from './order-block-strength';
import { superOrderBlocks } from './super-order-block';
import type { Candle } from '@/types/domain';

// This suite locks in the OB-unification fix: calcSmartMoney (the chart),
// orderBlockStrength, and superOrderBlocks (the decision engine) must all
// agree on the GEOMETRY of a given Order Block — top = OB candle's own
// high, bottom = OB candle's own low, dated to the OB candle's own time —
// regardless of how each one separately decides whether to *include* that
// block by default (their quality gates run on deliberately different
// mechanisms/timing — see the module docs in each file — so gating is
// disabled here via each function's own options to isolate geometry only).
function candle(time: number, open: number, close: number, high: number, low: number, volume = 100): Candle {
  return { time, open, high, low, close, volume };
}

function buildBullishObScenario(): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < 20; i++) candles.push(candle(i, 100, 100.2, 101, 99, 100));
  // OB candle (bearish) at index 20 — top=103 (high), bottom=99 (low).
  candles.push(candle(20, 102, 100, 103, 99, 100));
  // Impulse candle at index 21: closes above the OB's own high (103).
  candles.push(candle(21, 100, 106, 107, 99.5, 200));
  for (let i = 22; i < 30; i++) {
    const base = 106 + (i - 22);
    candles.push(candle(i, base, base + 1, base + 2, base - 1, 100));
  }
  return candles;
}

function buildBearishObScenario(): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < 20; i++) candles.push(candle(i, 100, 99.8, 101, 99, 100));
  // OB candle (bullish) at index 20 — top=103 (high), bottom=99 (low).
  candles.push(candle(20, 100, 102, 103, 99, 100));
  // Impulse candle at index 21: closes below the OB's own low (99).
  candles.push(candle(21, 102, 96, 102.5, 95, 200));
  for (let i = 22; i < 30; i++) {
    const base = 96 - (i - 22);
    candles.push(candle(i, base, base - 1, base + 1, base - 2, 100));
  }
  return candles;
}

describe('Order Block geometry consistency across all three implementations', () => {
  it('calcSmartMoney, orderBlockStrength and superOrderBlocks agree on top/bottom/time for the same bullish OB', () => {
    const candles = buildBullishObScenario();

    const sm = calcSmartMoney(candles, { requireDisplacement: false, requireStructureConfluence: false });
    const obs = orderBlockStrength(candles, 100, undefined, false);
    const sob = superOrderBlocks(candles, 100, { requireDisplacement: false, requireStructureConfluence: false });

    const smOB = sm.orderBlocks.find((o) => o.time === 20 && o.type === 'bullish');
    const obsOB = obs.find((o) => o.time === 20 && o.direction === 'bullish');
    const sobOB = sob.find((o) => o.time === 20 && o.direction === 'bullish');

    expect(smOB).toBeDefined();
    expect(obsOB).toBeDefined();
    expect(sobOB).toBeDefined();

    // Geometry must be the OB candle's own high/low everywhere — not
    // widened by the breaking (impulse) candle's wick.
    expect(smOB!.top).toBe(103);
    expect(smOB!.bottom).toBe(99);
    expect(obsOB!.high).toBe(103);
    expect(obsOB!.low).toBe(99);
    expect(sobOB!.high).toBe(103);
    expect(sobOB!.low).toBe(99);

    expect(smOB!.top).toBe(obsOB!.high);
    expect(smOB!.bottom).toBe(obsOB!.low);
    expect(smOB!.top).toBe(sobOB!.high);
    expect(smOB!.bottom).toBe(sobOB!.low);
    expect(smOB!.time).toBe(obsOB!.time);
    expect(smOB!.time).toBe(sobOB!.time);
  });

  it('calcSmartMoney, orderBlockStrength and superOrderBlocks agree on top/bottom/time for the same bearish OB', () => {
    const candles = buildBearishObScenario();

    const sm = calcSmartMoney(candles, { requireDisplacement: false, requireStructureConfluence: false });
    const obs = orderBlockStrength(candles, 100, undefined, false);
    const sob = superOrderBlocks(candles, 100, { requireDisplacement: false, requireStructureConfluence: false });

    const smOB = sm.orderBlocks.find((o) => o.time === 20 && o.type === 'bearish');
    const obsOB = obs.find((o) => o.time === 20 && o.direction === 'bearish');
    const sobOB = sob.find((o) => o.time === 20 && o.direction === 'bearish');

    expect(smOB).toBeDefined();
    expect(obsOB).toBeDefined();
    expect(sobOB).toBeDefined();

    expect(smOB!.top).toBe(103);
    expect(smOB!.bottom).toBe(99);
    expect(obsOB!.high).toBe(103);
    expect(obsOB!.low).toBe(99);
    expect(sobOB!.high).toBe(103);
    expect(sobOB!.low).toBe(99);

    expect(smOB!.top).toBe(obsOB!.high);
    expect(smOB!.bottom).toBe(obsOB!.low);
    expect(smOB!.top).toBe(sobOB!.high);
    expect(smOB!.bottom).toBe(sobOB!.low);
    expect(smOB!.time).toBe(obsOB!.time);
    expect(smOB!.time).toBe(sobOB!.time);
  });
});

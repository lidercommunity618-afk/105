import { describe, it, expect } from 'vitest';
import { calcSmartMoney } from '@/compute/indicators/smart-money';
import type { Candle } from '@/types/domain';

function candle(
  time: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume = 1000,
): Candle {
  return { time, open, high, low, close, volume };
}

describe('detectOrderBlocks (calcSmartMoney.orderBlocks)', () => {
  it('returns empty for insufficient candles', () => {
    const result = calcSmartMoney([candle(1, 100, 101, 99, 100)]);
    expect(result.orderBlocks).toEqual([]);
  });

  it('detects bullish order block after down candle + breakout up', () => {
    const candles: Candle[] = [];
    let t = 1700000000;
    for (let i = 0; i < 10; i++) {
      candles.push(candle(t, 100, 101, 99, 99, 1000));
      t += 60;
    }
    candles.push(candle(t, 99, 98, 97, 97.5, 1000));
    t += 60;
    candles.push(candle(t, 97.5, 103, 97, 102, 1500));
    t += 60;
    for (let i = 0; i < 5; i++) {
      candles.push(candle(t, 102, 103, 101, 102.5, 1000));
      t += 60;
    }
    const result = calcSmartMoney(candles);
    expect(result.orderBlocks.length).toBeGreaterThan(0);
    const bullOB = result.orderBlocks.find((ob) => ob.type === 'bullish');
    expect(bullOB).toBeDefined();
    expect(bullOB!.top).toBeGreaterThan(bullOB!.bottom);
  });

  it('detects bearish order block after up candle + breakout down', () => {
    const candles: Candle[] = [];
    let t = 1700000000;
    for (let i = 0; i < 10; i++) {
      candles.push(candle(t, 100, 101, 99, 100.5, 1000));
      t += 60;
    }
    candles.push(candle(t, 100.5, 102, 100, 102, 1000));
    t += 60;
    candles.push(candle(t, 102, 102, 96, 97, 1500));
    t += 60;
    for (let i = 0; i < 5; i++) {
      candles.push(candle(t, 97, 98, 96, 96.5, 1000));
      t += 60;
    }
    const result = calcSmartMoney(candles);
    const bearOB = result.orderBlocks.find((ob) => ob.type === 'bearish');
    expect(bearOB).toBeDefined();
    expect(bearOB!.top).toBeGreaterThan(bearOB!.bottom);
  });

  it("meanThreshold is the 50% midpoint of the OB candle's BODY, not of its full high/low range", () => {
    // Order Block audit (merge of the two render-fix branches): the ICT
    // "Mean Threshold" is defined on the OB candle's body (bodyTop/
    // bodyBottom, derived from open/close), which sits off-centre inside a
    // candle with an asymmetric wick — it must NOT collapse to
    // (top + bottom) / 2 (the box's geometric middle, i.e. the full
    // high/low range), which is what a naive reuse of the FVG CE midline
    // logic would compute.
    const candles: Candle[] = [];
    let t = 1700000000;
    for (let i = 0; i < 10; i++) {
      candles.push(candle(t, 100, 101, 99, 100, 1000));
      t += 60;
    }
    // OB candle: bearish body 100 -> 99.8, but a long lower wick down to 95
    // — high/low range [95, 100.2] is far from centred on the body.
    candles.push(candle(t, 100, 100.2, 95, 99.8, 1000));
    t += 60;
    candles.push(candle(t, 99.8, 106, 99.7, 105, 1500));
    t += 60;
    for (let i = 0; i < 5; i++) {
      candles.push(candle(t, 105, 106, 104, 105.5, 1000));
      t += 60;
    }
    const result = calcSmartMoney(candles);
    const bullOB = result.orderBlocks.find((ob) => ob.type === 'bullish');
    expect(bullOB).toBeDefined();
    // Body: open 100, close 99.8 -> bodyTop 100, bodyBottom 99.8, midpoint 99.9
    expect(bullOB!.bodyTop).toBeCloseTo(100, 5);
    expect(bullOB!.bodyBottom).toBeCloseTo(99.8, 5);
    expect(bullOB!.meanThreshold).toBeCloseTo(99.9, 5);
    // Full-range geometric middle would instead be (100.2 + 95) / 2 = 97.6 —
    // must not match that.
    const geometricMiddle = (bullOB!.top + bullOB!.bottom) / 2;
    expect(bullOB!.meanThreshold).not.toBeCloseTo(geometricMiddle, 1);
    // Sanity: the mean threshold must fall within the OB candle's own body.
    expect(bullOB!.meanThreshold).toBeLessThanOrEqual(bullOB!.bodyTop);
    expect(bullOB!.meanThreshold).toBeGreaterThanOrEqual(bullOB!.bodyBottom);
  });

  it('a broken (fully invalidated) order block keeps its zone data intact for the caller to grey out in rendering', () => {
    // Regression guard for the render fix: broken/invalidated status must
    // still carry a valid endTime (used to stop the box at the point of
    // invalidation) so the UI can distinguish it from a still-live zone
    // without losing where/when it broke.
    const candles: Candle[] = [];
    let t = 1700000000;
    for (let i = 0; i < 10; i++) {
      candles.push(candle(t, 100, 101, 99, 99, 1000));
      t += 60;
    }
    candles.push(candle(t, 99, 98, 97, 97.5, 1000));
    t += 60;
    candles.push(candle(t, 97.5, 103, 97, 102, 1500));
    t += 60;
    // Price later closes back below the OB's low (97) — full invalidation.
    for (let i = 0; i < 5; i++) {
      candles.push(candle(t, 102, 102.5, 95, 95.5, 1000));
      t += 60;
    }
    const result = calcSmartMoney(candles);
    const bullOB = result.orderBlocks.find((ob) => ob.type === 'bullish');
    expect(bullOB).toBeDefined();
    expect(bullOB!.status).toBe('broken');
    expect(bullOB!.endTime).not.toBeNull();
  });

  it('hasFvgConfluence and hasLiquiditySweep are computed but do not filter the result by default', () => {
    // Both new ICT criteria must be informational-only unless explicitly
    // requested via requireFvgConfluence/requireLiquiditySweep — existing
    // callers (pattern-context.ts, ChartPanel.tsx) must keep seeing the
    // same block list they did before these fields were added.
    const candles: Candle[] = [];
    let t = 1700000000;
    for (let i = 0; i < 10; i++) {
      candles.push(candle(t, 100, 101, 99, 99, 1000));
      t += 60;
    }
    candles.push(candle(t, 99, 98, 97, 97.5, 1000));
    t += 60;
    candles.push(candle(t, 97.5, 103, 97, 102, 1500));
    t += 60;
    for (let i = 0; i < 5; i++) {
      candles.push(candle(t, 102, 103, 101, 102.5, 1000));
      t += 60;
    }
    const withoutFilters = calcSmartMoney(candles);
    const withFilters = calcSmartMoney(candles, {
      requireFvgConfluence: true,
      requireLiquiditySweep: true,
    });
    const bullOB = withoutFilters.orderBlocks.find((ob) => ob.type === 'bullish');
    expect(bullOB).toBeDefined();
    expect(typeof bullOB!.hasFvgConfluence).toBe('boolean');
    expect(typeof bullOB!.hasLiquiditySweep).toBe('boolean');
    // The strict, opt-in filtered call must never return MORE blocks than
    // the permissive default call.
    expect(withFilters.orderBlocks.length).toBeLessThanOrEqual(withoutFilters.orderBlocks.length);
  });
});

describe('detectFVGs (calcSmartMoney.fvgs)', () => {
  it('returns empty for insufficient candles', () => {
    const result = calcSmartMoney([candle(1, 100, 101, 99, 100)]);
    expect(result.fvgs).toEqual([]);
  });

  it('detects bullish FVG when gap up exists', () => {
    const candles: Candle[] = [];
    let t = 1700000000;
    for (let i = 0; i < 10; i++) {
      candles.push(candle(t, 100, 101, 99, 100, 1000));
      t += 60;
    }
    candles.push(candle(t, 100, 101, 99, 100, 1000));
    t += 60;
    candles.push(candle(t, 102, 105, 102, 104, 1000));
    t += 60;
    for (let i = 0; i < 5; i++) {
      candles.push(candle(t, 104, 105, 103, 104, 1000));
      t += 60;
    }
    const result = calcSmartMoney(candles);
    const bullFvg = result.fvgs.find((f) => f.type === 'bullish');
    expect(bullFvg).toBeDefined();
    expect(bullFvg!.top).toBeGreaterThan(bullFvg!.bottom);
  });

  it('detects bearish FVG when gap down exists', () => {
    const candles: Candle[] = [];
    let t = 1700000000;
    for (let i = 0; i < 10; i++) {
      candles.push(candle(t, 100, 101, 99, 100, 1000));
      t += 60;
    }
    candles.push(candle(t, 100, 101, 99, 100, 1000));
    t += 60;
    candles.push(candle(t, 98, 98, 95, 96, 1000));
    t += 60;
    for (let i = 0; i < 5; i++) {
      candles.push(candle(t, 96, 97, 95, 96, 1000));
      t += 60;
    }
    const result = calcSmartMoney(candles);
    const bearFvg = result.fvgs.find((f) => f.type === 'bearish');
    expect(bearFvg).toBeDefined();
    expect(bearFvg!.top).toBeGreaterThan(bearFvg!.bottom);
  });
});

describe('FVG displacement gating (§6 spec)', () => {
  function baseline(count: number, startTime: number): { candles: Candle[]; t: number } {
    const candles: Candle[] = [];
    let t = startTime;
    for (let i = 0; i < count; i++) {
      candles.push(candle(t, 100, 100.5, 99.5, 100.2, 1000));
      t += 60;
    }
    return { candles, t };
  }

  it('creates a bullish zone with correct top/bottom/ce when displacement is strong and wicks do not overlap', () => {
    const { candles, t: t0 } = baseline(20, 1700000000);
    let t = t0;

    const left = candle(t, 100, 100.5, 99.5, 100.2, 1000); t += 60;
    const mid = candle(t, 100.2, 104.2, 100.1, 104, 1000); t += 60; // body 3.8, strong displacement, closes bullish
    const right = candle(t, 105, 106, 105, 105.5, 1000); t += 60; // low 105 > left.high 100.5 — no wick overlap

    candles.push(left, mid, right);
    for (let i = 0; i < 5; i++) {
      candles.push(candle(t, 105.5, 106, 105, 105.5, 1000));
      t += 60;
    }

    const result = calcSmartMoney(candles);
    const fvg = result.fvgs.find((f) => f.type === 'bullish' && f.bottom === left.high);
    expect(fvg).toBeDefined();
    expect(fvg!.top).toBe(right.low);
    expect(fvg!.bottom).toBe(left.high);
    expect(fvg!.ce).toBeCloseTo((fvg!.top + fvg!.bottom) / 2);
    expect(fvg!.hasDisplacement).toBe(true);
  });

  it('does not create a zone when the middle candle body is weaker than 1.2×ATR', () => {
    const { candles, t: t0 } = baseline(20, 1700000000);
    let t = t0;

    const left = candle(t, 100, 100.5, 99.5, 100.2, 1000); t += 60;
    const mid = candle(t, 100.2, 100.7, 100.1, 100.5, 1000); t += 60; // body 0.3 — weak vs baseline ATR (~1)
    const right = candle(t, 101, 101.5, 101, 101.2, 1000); t += 60; // low 101 > left.high 100.5, gap technically exists

    candles.push(left, mid, right);
    for (let i = 0; i < 5; i++) {
      candles.push(candle(t, 101.2, 101.5, 101, 101.2, 1000));
      t += 60;
    }

    const result = calcSmartMoney(candles);
    const weakFvg = result.fvgs.find((f) => f.bottom === left.high && f.top === right.low);
    expect(weakFvg).toBeUndefined();
  });

  it('creates an inversion FVG with reversed polarity when the original zone is invalidated by a close', () => {
    const { candles, t: t0 } = baseline(20, 1700000000);
    let t = t0;

    const left = candle(t, 100, 100.5, 99.5, 100.2, 1000); t += 60;
    const mid = candle(t, 100.2, 104.2, 100.1, 104, 1000); t += 60;
    const right = candle(t, 105, 106, 105, 105.5, 1000); t += 60;
    candles.push(left, mid, right);

    // A few holding candles, then a candle that closes back below left.high — full invalidation.
    candles.push(candle(t, 105.5, 106, 105, 105.5, 1000)); t += 60;
    candles.push(candle(t, 105, 105.5, 99, 99.5, 1000)); t += 60; // closes at 99.5 < left.high (100.5)
    for (let i = 0; i < 3; i++) {
      candles.push(candle(t, 99.5, 100, 99, 99.5, 1000));
      t += 60;
    }

    const result = calcSmartMoney(candles);
    const original = result.fvgs.find((f) => f.type === 'bullish' && f.bottom === left.high);
    expect(original).toBeDefined();
    expect(original!.broken).toBe(true);

    const inverted = result.inversionFvgs.find((f) => f.bottom === left.high && f.top === right.low);
    expect(inverted).toBeDefined();
    expect(inverted!.type).toBe('bearish');
    expect(inverted!.top).toBe(original!.top);
    expect(inverted!.bottom).toBe(original!.bottom);
  });
});

describe('OB Breaker Block (calcSmartMoney.breakerBlocks)', () => {
  it('creates a bearish breaker with inverted polarity and the same geometry when a bullish order block is fully invalidated', () => {
    // Same bullish-OB-then-invalidation shape as the 'broken order block'
    // test above: OB zone [97, 98] (obCandle high/low), broken by a candle
    // closing at 95.5 (< 97). A failed bullish OB (support) is the classic
    // ICT setup for a bearish breaker (resistance) at the same zone.
    const candles: Candle[] = [];
    let t = 1700000000;
    for (let i = 0; i < 10; i++) {
      candles.push(candle(t, 100, 101, 99, 99, 1000));
      t += 60;
    }
    candles.push(candle(t, 99, 98, 97, 97.5, 1000));
    t += 60;
    candles.push(candle(t, 97.5, 103, 97, 102, 1500));
    t += 60;
    for (let i = 0; i < 5; i++) {
      candles.push(candle(t, 102, 102.5, 95, 95.5, 1000));
      t += 60;
    }
    const result = calcSmartMoney(candles);
    const bullOB = result.orderBlocks.find((ob) => ob.type === 'bullish');
    expect(bullOB).toBeDefined();
    expect(bullOB!.status).toBe('broken');

    const breaker = result.breakerBlocks.find((b) => b.top === bullOB!.top && b.bottom === bullOB!.bottom);
    expect(breaker).toBeDefined();
    expect(breaker!.type).toBe('bearish');
    // Dated to the moment of invalidation, not to the origin OB candle.
    expect(breaker!.time).toBe(bullOB!.endTime);
    // Geometry (body/mean threshold) carries over unchanged from the origin.
    expect(breaker!.bodyTop).toBe(bullOB!.bodyTop);
    expect(breaker!.bodyBottom).toBe(bullOB!.bodyBottom);
    expect(breaker!.meanThreshold).toBe(bullOB!.meanThreshold);
  });

  it("a breaker block tracks its own touches forward from invalidation, independent of the origin order block's touch history", () => {
    const candles: Candle[] = [];
    let t = 1700000000;
    for (let i = 0; i < 10; i++) {
      candles.push(candle(t, 100, 101, 99, 99, 1000));
      t += 60;
    }
    candles.push(candle(t, 99, 98, 97, 97.5, 1000)); // OB candle: zone [97, 98]
    t += 60;
    candles.push(candle(t, 97.5, 103, 97, 102, 1500)); // breaking candle up -> bullish OB
    t += 60;
    // Full invalidation: closes at 95.5 (< 97).
    candles.push(candle(t, 102, 102.5, 95, 95.5, 1000));
    t += 60;
    // Price returns and wicks into the now-bearish breaker zone [97, 98]
    // from below, then closes back out beneath it — a rejection of the
    // breaker's own (bearish) direction, i.e. a tested-hold reaction.
    candles.push(candle(t, 95.5, 97.5, 95, 95.3, 1000));
    t += 60;
    for (let i = 0; i < 5; i++) {
      candles.push(candle(t, 96, 96.5, 95, 95.5, 1000));
      t += 60;
    }

    const result = calcSmartMoney(candles);
    const breaker = result.breakerBlocks.find((b) => b.type === 'bearish');
    expect(breaker).toBeDefined();
    // The breaker's own touch count reflects the wick above, NOT the
    // origin bullish OB's touch history (which never had this reaction).
    expect(breaker!.touchCount).toBeGreaterThan(0);
    expect(breaker!.status).not.toBe('untested');
  });

  it('breakerBlocks is empty when no order block has been fully invalidated', () => {
    const candles: Candle[] = [];
    let t = 1700000000;
    for (let i = 0; i < 10; i++) {
      candles.push(candle(t, 100, 101, 99, 99, 1000));
      t += 60;
    }
    candles.push(candle(t, 99, 98, 97, 97.5, 1000));
    t += 60;
    candles.push(candle(t, 97.5, 103, 97, 102, 1500));
    t += 60;
    // Stays well above the OB zone — never invalidated.
    for (let i = 0; i < 5; i++) {
      candles.push(candle(t, 102, 103, 101, 102.5, 1000));
      t += 60;
    }
    const result = calcSmartMoney(candles);
    expect(result.orderBlocks.some((ob) => ob.status === 'broken')).toBe(false);
    expect(result.breakerBlocks).toEqual([]);
  });
});

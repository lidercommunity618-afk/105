import { describe, it, expect } from 'vitest';
import { detectOrderBlockBreaker } from '@/compute/patterns/order-block-breaker';
import { detectOrderBlockNested, detectHtfObZones } from '@/compute/patterns/order-block-nested';
import type { Candle, IndicatorSnapshot } from '@/types/domain';
import type { SmartMoneyResult, SmartMoneyOrderBlock } from '@/compute/indicators/smart-money';

// Same (time, open, close, high, low, volume) argument order as
// fvg-strategies.test.ts, since these two detectors are the direct Order
// Block counterparts of that file's fvg-breaker-block/fvg-nested tests.
function candle(time: number, open: number, close: number, high: number, low: number, volume = 100): Candle {
  return { time, open, high, low, close, volume };
}

function mockOb(
  overrides: Partial<SmartMoneyOrderBlock> & Pick<SmartMoneyOrderBlock, 'top' | 'bottom' | 'time' | 'type'>,
): SmartMoneyOrderBlock {
  return {
    mitigated: false,
    endTime: null,
    touchCount: 0,
    rejections: [],
    status: 'untested',
    strengthScore: 1,
    bodyTop: overrides.top,
    bodyBottom: overrides.bottom,
    meanThreshold: (overrides.top + overrides.bottom) / 2,
    hasFvgConfluence: true,
    hasLiquiditySweep: true,
    hasDisplacement: true,
    hasStructureConfluence: true,
    ...overrides,
  };
}

const EMPTY_SMART_MONEY: SmartMoneyResult = {
  orderBlocks: [], fvgs: [], inversionFvgs: [], breakerBlocks: [], rejectionBlocks: [], bosEvents: [],
};

const NEUTRAL_SNAPSHOT: IndicatorSnapshot = {
  rsi: null, emaFast: null, emaSlow: null, macd: null, macdSignal: null, macdHistogram: null,
  atr: null, bollingerUpper: null, bollingerMiddle: null, bollingerLower: null,
  vwap: null, vwapIsProxyVolume: false, volumeProfilePoc: null, volumeProfilePocIsProxyVolume: false,
  meanReversionRsi: null, impulseVelocity: null, adx: null,
};

// A steady rising 1m price path so live-computed VWAP/RSI sit on the buy
// side without needing to hand-tune every bar — same helper/purpose as
// fvg-strategies.test.ts's risingWarmup.
function risingWarmup(count: number, startTime: number, startClose: number, step = 0.15): Candle[] {
  const out: Candle[] = [];
  let t = startTime;
  let c = startClose;
  for (let i = 0; i < count; i++) {
    const open = c;
    c = c + step;
    out.push(candle(t, open, c, Math.max(open, c) + 0.05, Math.min(open, c) - 0.05, 100));
    t += 60;
  }
  return out;
}

describe('detectOrderBlockBreaker (OB Breaker Block — role-inversion retest)', () => {
  it('returns null with insufficient history', () => {
    const result = detectOrderBlockBreaker([candle(1, 100, 101, 101, 99)], NEUTRAL_SNAPSHOT, 'london', EMPTY_SMART_MONEY);
    expect(result).toBeNull();
  });

  it('returns null when there are no breaker blocks at all', () => {
    const candles = risingWarmup(34, 1700000000, 100);
    const result = detectOrderBlockBreaker(candles, NEUTRAL_SNAPSHOT, 'london', EMPTY_SMART_MONEY);
    expect(result).toBeNull();
  });

  it('returns null when the pattern candle passes through the breaker zone without rejecting (no wick-then-close-back)', () => {
    const candles = risingWarmup(34, 1700000000, 100);
    // Closes INSIDE the zone instead of back outside it on the breaker's own side — not a rejection.
    candles.push(candle(candles[candles.length - 1].time + 60, 106, 104.5, 106.5, 104.1, 100));
    candles.push(candle(candles[candles.length - 1].time + 60, 104.4, 105, 105.2, 104.3, 300));

    const breaker = mockOb({ top: 105, bottom: 104, time: candles[candles.length - 6].time, type: 'bullish' });
    const smartMoney: SmartMoneyResult = { ...EMPTY_SMART_MONEY, breakerBlocks: [breaker] };
    const result = detectOrderBlockBreaker(candles, NEUTRAL_SNAPSHOT, 'london', smartMoney);
    expect(result).toBeNull();
  });

  it('detects a buy signal on a confirmed bullish-breaker (former bearish OB, now support) wick rejection', () => {
    const candles = risingWarmup(34, 1700000000, 100);
    // patternCandle: long lower wick piercing the [104, 105] zone from above, body closing back out above the zone top.
    candles.push(candle(candles[candles.length - 1].time + 60, 106, 106.3, 106.5, 104.1, 100));
    // confirmCandle: strong close beyond the pattern candle's body, continuing the breaker's (bullish) direction.
    candles.push(candle(candles[candles.length - 1].time + 60, 106.4, 107, 107.2, 106.3, 300));

    const breaker = mockOb({
      top: 105, bottom: 104, time: candles[candles.length - 6].time, type: 'bullish',
      hasDisplacement: true, hasStructureConfluence: true,
    });
    const smartMoney: SmartMoneyResult = { ...EMPTY_SMART_MONEY, breakerBlocks: [breaker] };
    const snapshot: IndicatorSnapshot = { ...NEUTRAL_SNAPSHOT, emaSlow: 100 };

    const result = detectOrderBlockBreaker(candles, snapshot, 'london', smartMoney);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('order-block-breaker');
    expect(result?.direction).toBe('buy');
    expect(result?.confirmedByNextCandle).toBe(true);
  });

  it('ignores a breaker block that is already too old (age filter, mirrors the FVG-family freshness rule)', () => {
    const candles = risingWarmup(34, 1700000000, 100);
    candles.push(candle(candles[candles.length - 1].time + 60, 106, 106.3, 106.5, 104.1, 100));
    candles.push(candle(candles[candles.length - 1].time + 60, 106.4, 107, 107.2, 106.3, 300));

    // Same zone/geometry as the passing test above, but dated far in the past (well beyond MAX_AGE_BARS).
    const staleBreaker = mockOb({ top: 105, bottom: 104, time: candles[0].time - 100 * 60, type: 'bullish' });
    const smartMoney: SmartMoneyResult = { ...EMPTY_SMART_MONEY, breakerBlocks: [staleBreaker] };
    const result = detectOrderBlockBreaker(candles, NEUTRAL_SNAPSHOT, 'london', smartMoney);
    expect(result).toBeNull();
  });
});

describe('detectOrderBlockNested (Nested OB — HTF order block containing a fresh M1 order block)', () => {
  it('returns null with insufficient history', () => {
    const result = detectOrderBlockNested([candle(1, 100, 101, 101, 99)], NEUTRAL_SNAPSHOT, 'london', EMPTY_SMART_MONEY);
    expect(result).toBeNull();
  });

  it('returns null when there is no M1 order block at all, even if an HTF zone exists', () => {
    const candles = risingWarmup(120, 1700000000, 100);
    const result = detectOrderBlockNested(candles, NEUTRAL_SNAPSHOT, 'london', EMPTY_SMART_MONEY);
    expect(result).toBeNull();
  });

  it('detects a buy signal where a fresh M1 bullish order block overlaps a genuine HTF bullish order block and price sits in the confluence zone', () => {
    // Hand-built M1 series whose synthetic M5 (HTF_FACTOR=5) resample
    // contains one clean, displacement-confirmed bullish order block at
    // [99.75, 100.15]: a long flat "noise" run (keeps ATR low), one small
    // bearish OB candle, then a large bullish impulse candle that clears
    // the ATR×1.2 displacement gate and breaks structure.
    const m1: Candle[] = [];
    let t = 1700000000;
    const pushGroup = (build: (k: number) => Candle) => {
      for (let k = 0; k < 5; k++) { m1.push(build(k)); t += 60; }
    };
    for (let g = 0; g < 20; g++) {
      const base = 100 + (g % 2 === 0 ? 0.05 : -0.05);
      pushGroup((k) => candle(t, base, base + (k === 4 ? 0.02 : 0), base + 0.1, base - 0.1, 100));
    }
    pushGroup((k) => (k === 0
      ? candle(t, 100.1, 99.8, 100.15, 99.8, 100)
      : candle(t, 99.8, 99.8, 99.85, 99.75, 100)));
    pushGroup((k) => (k === 4
      ? candle(t, 100, 103, 103, 99.9, 500)
      : candle(t, 99.8 + k * 0.5, 100 + k * 0.5, 100 + k * 0.5, 99.7 + k * 0.5, 200)));
    for (let g = 0; g < 4; g++) {
      pushGroup(() => candle(t, 103, 103.2, 103.5, 102.8, 100));
    }
    // Tail pullback: bring the LAST M1 candle's range back down into the
    // HTF zone / M1 zone confluence around [99.9, 100.15].
    for (let i = 0; i < 6; i++) {
      const c = 103.2 - i * 0.6;
      m1.push(candle(t, c + 0.1, c, c + 0.15, c - 0.15, 150));
      t += 60;
    }

    // M1-side order block: fresh, unbroken, overlapping the HTF zone.
    const m1Ob = mockOb({ top: 100.2, bottom: 99.9, time: m1[m1.length - 10].time, type: 'bullish' });
    const smartMoney: SmartMoneyResult = { ...EMPTY_SMART_MONEY, orderBlocks: [m1Ob] };
    const snapshot: IndicatorSnapshot = { ...NEUTRAL_SNAPSHOT, emaSlow: 99 };

    const result = detectOrderBlockNested(m1, snapshot, 'london', smartMoney);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('order-block-nested');
    expect(result?.direction).toBe('buy');
  });

  it('returns null when the M1 order block does not actually overlap the HTF zone', () => {
    const m1: Candle[] = [];
    let t = 1700000000;
    const pushGroup = (build: (k: number) => Candle) => {
      for (let k = 0; k < 5; k++) { m1.push(build(k)); t += 60; }
    };
    for (let g = 0; g < 20; g++) {
      const base = 100 + (g % 2 === 0 ? 0.05 : -0.05);
      pushGroup((k) => candle(t, base, base + (k === 4 ? 0.02 : 0), base + 0.1, base - 0.1, 100));
    }
    pushGroup((k) => (k === 0
      ? candle(t, 100.1, 99.8, 100.15, 99.8, 100)
      : candle(t, 99.8, 99.8, 99.85, 99.75, 100)));
    pushGroup((k) => (k === 4
      ? candle(t, 100, 103, 103, 99.9, 500)
      : candle(t, 99.8 + k * 0.5, 100 + k * 0.5, 100 + k * 0.5, 99.7 + k * 0.5, 200)));
    for (let g = 0; g < 4; g++) {
      pushGroup(() => candle(t, 103, 103.2, 103.5, 102.8, 100));
    }
    for (let i = 0; i < 6; i++) {
      const c = 103.2 - i * 0.6;
      m1.push(candle(t, c + 0.1, c, c + 0.15, c - 0.15, 150));
      t += 60;
    }

    // M1 block sits far away from the HTF zone [99.75, 100.15] — no overlap.
    const farOb = mockOb({ top: 90, bottom: 89, time: m1[m1.length - 10].time, type: 'bullish' });
    const smartMoney: SmartMoneyResult = { ...EMPTY_SMART_MONEY, orderBlocks: [farOb] };
    const result = detectOrderBlockNested(m1, NEUTRAL_SNAPSHOT, 'london', smartMoney);
    expect(result).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────
// Рекомендация 1/3 (docs/audit/recommendations-post-harmonic-audit.md):
// та же экспозиция, что уже была найдена и исправлена в ZigZag/гармониках
// (HTF-группировка `resampleCandles()` привязана к позиции в массиве, а не
// к абсолютному времени — на скользящем окне `candles.slice(i - windowSize
// + 1, i + 1)` из backtest/simulator.ts граница группы "гуляет"), была
// подтверждена эмпирически и здесь и исправлена через
// `resampleCandles(candles, HTF_FACTOR, { alignToAbsoluteTime: true })`.
// Регрессионный тест ниже — постоянная (запускаемая `npm run test`) версия
// разовой проверки, методика и числа сверены со standalone-аудитом
// `backtest/htf-resample-stability-audit.ts` (`npm run
// backtest:htf-resample-audit`) — см. docs/changelog/
// CHANGES_APPLIED_HTF_RESAMPLE_ALIGNMENT_20260912.md.
describe('detectHtfObZones — HTF resample alignment stability on a sliding window (Рекомендации 1 и 3)', () => {
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Реалистичный ряд M1 с периодическими импульсами (displacement для
  // order block) + шумовыми консолидациями между ними. Время —
  // epoch-aligned (кратно 60 от начала минуты), как реальные M1-бары
  // брокера — существенно для alignToAbsoluteTime (см. комментарий в
  // fvg-strategies-shared.ts).
  function buildRealisticSeries(bars: number, seed: number): Candle[] {
    const rnd = mulberry32(seed);
    const candles: Candle[] = [];
    let t = Date.UTC(2025, 0, 1, 0, 0, 0) / 1000;
    let price = 100;
    for (let i = 0; i < bars; i++) {
      const phase = i % 12;
      const move = phase < 4 ? (i % 24 < 12 ? 1 : -1) * (1.2 + rnd() * 0.6) : (rnd() - 0.5) * 0.3;
      const open = price;
      price += move;
      const close = price;
      const high = Math.max(open, close) + rnd() * 0.2;
      const low = Math.min(open, close) - rnd() * 0.2;
      candles.push(candle(t, open, close, high, low, 100 + rnd() * 50));
      t += 60;
    }
    return candles;
  }

  it('keeps top/bottom/time of a settled HTF zone identical across 25 consecutive 1-bar window shifts', () => {
    const WINDOW_SIZE = 500;
    const N_CONSECUTIVE_SHIFTS = 25;
    // Диапазон "устоявшейся" истории — до точки, где статус зоны ещё может
    // законно пересчитаться (broken/unbroken) по мере роста окна обзора;
    // см. подробный разбор этого явления в
    // backtest/htf-resample-stability-audit.ts.
    const STABLE_HORIZON_TIME = Date.UTC(2025, 0, 1, 0, 0, 0) / 1000 + 11400;

    const full = buildRealisticSeries(1200, 42);
    const snapshots = new Set<string>();
    for (let k = 0; k < N_CONSECUTIVE_SHIFTS; k++) {
      const i = WINDOW_SIZE + k;
      const window = full.slice(i - WINDOW_SIZE + 1, i + 1);
      const zones = detectHtfObZones(window).filter((z) => z.time < STABLE_HORIZON_TIME);
      snapshots.add(
        zones
          .slice()
          .sort((a, b) => a.time - b.time)
          .map((z) => `${z.type}[${z.bottom.toFixed(6)}-${z.top.toFixed(6)}]@${z.time}`)
          .join(' | '),
      );
    }

    // Ровно один уникальный снимок на всех 25 сдвигах — если граница
    // группировки "гуляет" (баг до фикса), здесь были бы 5-6 разных
    // представлений с отличающимися time И top/bottom (проверено вручную
    // при временном откате фикса, см. docs/changelog).
    expect(snapshots.size).toBe(1);
    expect([...snapshots][0]).not.toBe('');
  });
});

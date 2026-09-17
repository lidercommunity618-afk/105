import { describe, it, expect } from 'vitest';
import { detectFvgReturn } from '@/compute/patterns/fvg-return';
import { detectFvgBreakerBlock } from '@/compute/patterns/fvg-breaker-block';
import { detectFvgNested, detectHtfFvgZones } from '@/compute/patterns/fvg-nested';
import { detectFvgRejection } from '@/compute/patterns/fvg-rejection';
import type { Candle, MarketStructure, IndicatorSnapshot } from '@/types/domain';
import type { SmartMoneyResult } from '@/compute/indicators/smart-money';
import type { SmartMoneyFVG } from '@/compute/indicators/smart-money';

function candle(time: number, open: number, close: number, high: number, low: number, volume = 100): Candle {
  return { time, open, high, low, close, volume };
}

function mockFvg(overrides: Partial<SmartMoneyFVG> & Pick<SmartMoneyFVG, 'top' | 'bottom' | 'time' | 'type'>): SmartMoneyFVG {
  return {
    broken: false,
    endTime: null,
    touchedTime: null,
    ce: (overrides.top + overrides.bottom) / 2,
    hasDisplacement: true,
    hasOBConfluence: false,
    hasBOSConfluence: false,
    ...overrides,
  };
}

const UP_STRUCTURE: MarketStructure = {
  trend: 'up', bos: true, choch: false, swingHigh: 130, swingLow: 97.6, provisional: false,
};

const NEUTRAL_SNAPSHOT: IndicatorSnapshot = {
  rsi: null, emaFast: null, emaSlow: null, macd: null, macdSignal: null, macdHistogram: null,
  atr: null, bollingerUpper: null, bollingerMiddle: null, bollingerLower: null,
  vwap: null, vwapIsProxyVolume: false, volumeProfilePoc: null, volumeProfilePocIsProxyVolume: false,
  meanReversionRsi: null, impulseVelocity: null, adx: null,
};

// A steady rising 1m price path so live-computed VWAP/RSI sit on the buy
// side without needing to hand-tune every bar. `close` climbs by ~0.15/bar.
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

describe('detectFvgReturn (Strategy A — Возврат к FVG)', () => {
  it('returns null with insufficient history', () => {
    const smartMoney: SmartMoneyResult = { orderBlocks: [], fvgs: [], inversionFvgs: [], breakerBlocks: [], rejectionBlocks: [], bosEvents: [] };
    const result = detectFvgReturn([candle(1, 100, 101, 101, 99)], NEUTRAL_SNAPSHOT, UP_STRUCTURE, 'london', smartMoney);
    expect(result).toBeNull();
  });

  it('returns null when structure is ranging (no trend to align FVG direction with)', () => {
    const candles = risingWarmup(35, 1700000000, 100);
    const smartMoney: SmartMoneyResult = {
      orderBlocks: [], fvgs: [mockFvg({ top: 105, bottom: 104, time: candles[5].time, type: 'bullish' })],
      inversionFvgs: [], breakerBlocks: [], rejectionBlocks: [], bosEvents: [],
    };
    const RANGE_STRUCTURE: MarketStructure = { trend: 'range', bos: false, choch: false, swingHigh: 130, swingLow: 97.6, provisional: false };
    const result = detectFvgReturn(candles, NEUTRAL_SNAPSHOT, RANGE_STRUCTURE, 'london', smartMoney);
    expect(result).toBeNull();
  });

  it('detects a buy signal on a retest of an unbroken bullish FVG in an uptrend', () => {
    const candles = risingWarmup(34, 1700000000, 100);
    // Final candle dips into the FVG zone [104, 105] and closes back above CE (104.5).
    const last = candle(candles[candles.length - 1].time + 60, 106, 106.5, 107, 104.2, 100);
    candles.push(last);

    const fvg = mockFvg({
      top: 105, bottom: 104, time: candles[candles.length - 6].time, type: 'bullish', hasOBConfluence: true,
    });
    const smartMoney: SmartMoneyResult = { orderBlocks: [], fvgs: [fvg], inversionFvgs: [], breakerBlocks: [], rejectionBlocks: [], bosEvents: [] };
    const snapshot: IndicatorSnapshot = { ...NEUTRAL_SNAPSHOT, emaSlow: 100 };

    const result = detectFvgReturn(candles, snapshot, UP_STRUCTURE, 'london', smartMoney);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('fvg-return');
    expect(result?.direction).toBe('buy');
    expect(result?.confidence).toBeGreaterThan(0);
    expect(result?.confidence).toBeLessThanOrEqual(1);
  });

  it('returns null when the reacting candle closes back through the far edge of the zone', () => {
    const candles = risingWarmup(34, 1700000000, 100);
    // Closes through the bottom of the zone — mandatory filter should reject this.
    const last = candle(candles[candles.length - 1].time + 60, 105, 103.5, 105.2, 103.4, 100);
    candles.push(last);
    const fvg = mockFvg({ top: 105, bottom: 104, time: candles[candles.length - 6].time, type: 'bullish' });
    const smartMoney: SmartMoneyResult = { orderBlocks: [], fvgs: [fvg], inversionFvgs: [], breakerBlocks: [], rejectionBlocks: [], bosEvents: [] };
    const result = detectFvgReturn(candles, NEUTRAL_SNAPSHOT, UP_STRUCTURE, 'london', smartMoney);
    expect(result).toBeNull();
  });
});

describe('detectFvgBreakerBlock (Strategy B — FVG + Брейкер-блок)', () => {
  it('returns null when the FVG has no BOS confluence (no key-level break)', () => {
    const candles = risingWarmup(34, 1700000000, 100);
    candles.push(candle(candles[candles.length - 1].time + 60, 106, 106.3, 106.5, 104.1, 100));
    candles.push(candle(candles[candles.length - 1].time + 60, 106.4, 107, 107.2, 106.3, 100));
    const fvg = mockFvg({ top: 105, bottom: 104, time: candles[candles.length - 6].time, type: 'bullish', hasBOSConfluence: false });
    const smartMoney: SmartMoneyResult = { orderBlocks: [], fvgs: [fvg], inversionFvgs: [], breakerBlocks: [], rejectionBlocks: [], bosEvents: [] };
    const result = detectFvgBreakerBlock(candles, NEUTRAL_SNAPSHOT, 'london', smartMoney);
    expect(result).toBeNull();
  });

  it('detects a buy signal on a confirmed breaker-block wick rejection', () => {
    const candles = risingWarmup(34, 1700000000, 100);
    // patternCandle: long lower wick piercing the zone, small body outside it.
    candles.push(candle(candles[candles.length - 1].time + 60, 106, 106.3, 106.5, 104.1, 100));
    // confirmCandle: strong close beyond the patternCandle's body.
    candles.push(candle(candles[candles.length - 1].time + 60, 106.4, 107, 107.2, 106.3, 300));

    const fvg = mockFvg({ top: 105, bottom: 104, time: candles[candles.length - 6].time, type: 'bullish', hasBOSConfluence: true });
    const smartMoney: SmartMoneyResult = { orderBlocks: [], fvgs: [fvg], inversionFvgs: [], breakerBlocks: [], rejectionBlocks: [], bosEvents: [] };
    const snapshot: IndicatorSnapshot = { ...NEUTRAL_SNAPSHOT, emaSlow: 100 };

    const result = detectFvgBreakerBlock(candles, snapshot, 'london', smartMoney);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('fvg-breaker-block');
    expect(result?.direction).toBe('buy');
    expect(result?.confirmedByNextCandle).toBe(true);
  });
});

describe('detectFvgRejection (Strategy D — Отбой от границы FVG)', () => {
  it('returns null when the touch candle has no dominant wick (no pin-bar/doji shape)', () => {
    const candles = risingWarmup(34, 1700000000, 100);
    // Large body, no meaningful wick — not a rejection candle.
    candles.push(candle(candles[candles.length - 1].time + 60, 104.2, 104.9, 105, 104.1, 250));
    candles.push(candle(candles[candles.length - 1].time + 60, 105, 105.6, 105.7, 105, 100));
    const fvg = mockFvg({ top: 105, bottom: 104, time: candles[candles.length - 6].time, type: 'bullish' });
    const smartMoney: SmartMoneyResult = { orderBlocks: [], fvgs: [fvg], inversionFvgs: [], breakerBlocks: [], rejectionBlocks: [], bosEvents: [] };
    const result = detectFvgRejection(candles, NEUTRAL_SNAPSHOT, 'london', smartMoney);
    expect(result).toBeNull();
  });

  it('detects a buy signal on a high-volume pin-bar rejection at the zone boundary', () => {
    const candles = risingWarmup(34, 1700000000, 100);
    // patternCandle: dominant lower wick, small body, touching the top boundary, high volume.
    candles.push(candle(candles[candles.length - 1].time + 60, 104.9, 105.0, 105.05, 104.2, 250));
    // confirmCandle: strong close beyond the pattern candle's body.
    candles.push(candle(candles[candles.length - 1].time + 60, 105.1, 105.6, 105.7, 105.0, 100));

    const fvg = mockFvg({ top: 105, bottom: 104, time: candles[candles.length - 6].time, type: 'bullish', hasOBConfluence: true });
    const smartMoney: SmartMoneyResult = { orderBlocks: [], fvgs: [fvg], inversionFvgs: [], breakerBlocks: [], rejectionBlocks: [], bosEvents: [] };
    const snapshot: IndicatorSnapshot = { ...NEUTRAL_SNAPSHOT, emaSlow: 100 };

    const result = detectFvgRejection(candles, snapshot, 'london', smartMoney);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('fvg-rejection');
    expect(result?.direction).toBe('buy');
    expect(result?.confirmedByNextCandle).toBe(true);
  });
});

describe('detectFvgNested (Strategy C — Вложенный FVG)', () => {
  it('returns null with insufficient history for HTF resampling', () => {
    const candles = risingWarmup(30, 1700000000, 100);
    const smartMoney: SmartMoneyResult = { orderBlocks: [], fvgs: [], inversionFvgs: [], breakerBlocks: [], rejectionBlocks: [], bosEvents: [] };
    const result = detectFvgNested(candles, NEUTRAL_SNAPSHOT, 'london', smartMoney);
    expect(result).toBeNull();
  });

  it('returns null when there is no M1 FVG nested inside an HTF zone', () => {
    // 60 plain rising candles produce no clean 3-bar gap at either timeframe.
    const candles = risingWarmup(60, 1700000000, 100, 0.02);
    const smartMoney: SmartMoneyResult = { orderBlocks: [], fvgs: [], inversionFvgs: [], breakerBlocks: [], rejectionBlocks: [], bosEvents: [] };
    const result = detectFvgNested(candles, NEUTRAL_SNAPSHOT, 'london', smartMoney);
    expect(result).toBeNull();
  });

  it('detects a buy signal when an M1 FVG sits inside a same-direction HTF FVG and price is in the overlap', () => {
    let t = 1700000000;
    const candles: Candle[] = [];
    const push = (open: number, close: number, high: number, low: number, volume = 100) => {
      candles.push(candle(t, open, close, high, low, volume));
      t += 60;
    };

    // Groups 0-1 (M1 idx 0-9): mild rise, no gap.
    for (let g = 0; g < 2; g++) {
      const base = 100 + g * 1;
      for (let i = 0; i < 5; i++) push(base, base + 0.1, base + 0.15, base - 0.05, 100);
    }
    // HTF group 2 (M1 idx 10-14): the FVG "left" candle — aggregate high 102.2.
    push(101.8, 101.9, 102.0, 101.75);
    push(101.9, 101.95, 102.05, 101.8);
    push(101.95, 102.0, 102.1, 101.85);
    push(102.0, 101.98, 102.15, 101.9);
    push(101.98, 102.0, 102.2, 101.7);
    // HTF group 3 (M1 idx 15-19): the "mid" impulse candle — aggregate open 102.1, close 103.5.
    push(102.1, 102.5, 102.6, 102.0);
    push(102.5, 102.9, 103.0, 102.45);
    push(102.9, 103.2, 103.3, 102.85);
    push(103.2, 103.4, 103.5, 103.15);
    push(103.4, 103.5, 103.6, 103.35);
    // HTF group 4 (M1 idx 20-24): the "right" candle — aggregate low 103.7, close 104.0.
    push(103.6, 103.75, 103.8, 103.7);
    push(103.75, 103.85, 103.9, 103.75);
    push(103.85, 103.9, 104.0, 103.8);
    push(103.9, 103.95, 104.05, 103.85);
    push(103.95, 104.0, 104.2, 103.9);
    // -> HTF bullish FVG detected at i=4: bottom = left.high = 102.2, top = right.low = 103.7.

    // Groups 5-9 (M1 idx 25-49): keep rising, staying well above 102.2 so the zone never breaks.
    let base = 104.2;
    for (let g = 0; g < 25; g++) {
      push(base, base + 0.1, base + 0.15, base - 0.05, 100);
      base += 0.05;
    }

    // Group 10 (M1 idx 50-54): pull back down toward the zone.
    let pull = base;
    for (let i = 0; i < 5; i++) {
      pull -= 0.5;
      push(pull + 0.5, pull, pull + 0.55, pull - 0.05, 100);
    }
    // Group 11 (M1 idx 55-59): retest the overlap zone [102.5, 103.2], last candle high volume.
    push(pull, 103.0, 103.1, 102.9, 100);
    push(103.0, 102.95, 103.05, 102.8, 100);
    push(102.95, 102.9, 103.0, 102.7, 100);
    push(102.9, 102.85, 102.95, 102.65, 100);
    push(102.85, 102.9, 103.1, 102.6, 300); // last candle, in the overlap zone

    const m1Fvg = mockFvg({
      top: 103.2, bottom: 102.5, time: candles[candles.length - 5].time, type: 'bullish',
    });
    const smartMoney: SmartMoneyResult = { orderBlocks: [], fvgs: [m1Fvg], inversionFvgs: [], breakerBlocks: [], rejectionBlocks: [], bosEvents: [] };
    const snapshot: IndicatorSnapshot = { ...NEUTRAL_SNAPSHOT, emaSlow: 100 };

    const result = detectFvgNested(candles, snapshot, 'london', smartMoney);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('fvg-nested');
    expect(result?.direction).toBe('buy');
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
// См. идентичный тест и подробный комментарий в
// order-block-strategies.test.ts, а также standalone-аудит
// `backtest/htf-resample-stability-audit.ts` (`npm run
// backtest:htf-resample-audit`) и docs/changelog/
// CHANGES_APPLIED_HTF_RESAMPLE_ALIGNMENT_20260912.md.
describe('detectHtfFvgZones — HTF resample alignment stability on a sliding window (Рекомендации 1 и 3)', () => {
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

  // Реалистичный ряд M1 с периодическими импульсами (3-свечные гэпы для
  // FVG) + шумовыми консолидациями между ними. Время — epoch-aligned
  // (кратно 60 от начала минуты), как реальные M1-бары брокера —
  // существенно для alignToAbsoluteTime (см. комментарий в
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
    const STABLE_HORIZON_TIME = Date.UTC(2025, 0, 1, 0, 0, 0) / 1000 + 11400;

    const full = buildRealisticSeries(1200, 42);
    const snapshots = new Set<string>();
    for (let k = 0; k < N_CONSECUTIVE_SHIFTS; k++) {
      const i = WINDOW_SIZE + k;
      const window = full.slice(i - WINDOW_SIZE + 1, i + 1);
      const zones = detectHtfFvgZones(window).filter((z) => z.time < STABLE_HORIZON_TIME);
      snapshots.add(
        zones
          .slice()
          .sort((a, b) => a.time - b.time)
          .map((z) => `${z.type}[${z.bottom.toFixed(6)}-${z.top.toFixed(6)}]@${z.time}`)
          .join(' | '),
      );
    }

    expect(snapshots.size).toBe(1);
    expect([...snapshots][0]).not.toBe('');
  });
});

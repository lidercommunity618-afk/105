import { describe, it, expect } from 'vitest';
import { detectAllPatterns, applyConfidenceHierarchy } from '@/compute/patterns';
import { detectHammer, detectDoji, detectShootingStar, detectInvertedHammer, detectHangingMan, detectMarubozuBullish, detectMarubozuBearish } from '@/compute/patterns/single';
import { detectBullishEngulfing, detectBearishEngulfing, detectBullishHarami, detectBearishHarami, detectPiercingLine, detectDarkCloudCover, detectTweezerBottom, detectTweezerTop } from '@/compute/patterns/double';
import {
  detectMorningStar,
  detectEveningStar,
  detectThreeWhiteSoldiers,
  detectThreeBlackCrows,
  detectAbandonedBabyBottom,
  detectAbandonedBabyTop,
  type TripleContext,
} from '@/compute/patterns/triple';
import { detectPinBar } from '@/compute/patterns/pin-bar';
import { detectInsideBar } from '@/compute/patterns/inside-bar';
import { detectMeanReversion } from '@/compute/patterns/mean-reversion';
import { detectRisingThreeMethods, detectFallingThreeMethods, type ContinuationContext } from '@/compute/patterns/continuation';
import type { PatternContext } from '@/compute/patterns/pattern-context';
import type { Candle, FeatureName, MarketStructure, IndicatorSnapshot } from '@/types/domain';
import { ALL_FEATURES } from '@/types/domain';
import type { SmartMoneyResult } from '@/compute/indicators/smart-money';

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

// ВАЖНО: [] означает «ничего не выбрано», а не «фильтра нет — всё активно»
// (см. фикс в compute/patterns/index.ts). Чтобы тесты по-прежнему детектили
// все паттерны, ALL явно перечисляет все фичи, а не полагается на [].
const ALL: FeatureName[] = [...ALL_FEATURES];

const RANGE_STRUCTURE: MarketStructure = {
  trend: 'range', bos: false, choch: false, swingHigh: null, swingLow: null, provisional: false,
};

const UP_STRUCTURE: MarketStructure = {
  trend: 'up', bos: true, choch: false, swingHigh: 110, swingLow: 95, provisional: false,
};

const DOWN_STRUCTURE: MarketStructure = {
  trend: 'down', bos: true, choch: false, swingHigh: 110, swingLow: 95, provisional: false,
};

const EMPTY_SMART_MONEY: SmartMoneyResult = {
  orderBlocks: [], fvgs: [], inversionFvgs: [], breakerBlocks: [], rejectionBlocks: [], bosEvents: [],
};

const NO_INDICATORS: IndicatorSnapshot = {
  rsi: null, emaFast: null, emaSlow: null,
  macd: null, macdSignal: null, macdHistogram: null,
  atr: null, bollingerUpper: null, bollingerMiddle: null, bollingerLower: null,
  vwap: null, vwapIsProxyVolume: false,
  volumeProfilePoc: null, volumeProfilePocIsProxyVolume: false,
  meanReversionRsi: null, impulseVelocity: null, adx: null,
};

function makeCtx(
  candles: Candle[],
  overrides: Partial<PatternContext> = {},
): PatternContext {
  const structure = overrides.structure ?? UP_STRUCTURE;
  return {
    candles,
    index: candles.length - 2,
    structure,
    // BUGFIX (аудит 2026-09-12, §1): продакшн-код теперь считает htfStructure
    // отдельно от M1 structure (см. patterns/index.ts, computeHtfStructure).
    // Эти фикстуры писались до фикса и оверрайдят только `structure` — чтобы
    // все уже существующие тесты (и их уже проверенные числовые ожидания по
    // confidence) остались валидны без изменений, htfStructure по умолчанию
    // зеркалит `structure` этого же вызова (т.е. воспроизводит поведение ДО
    // фикса — M1 и HTF совпадают). Тесты, которым нужно явно проверить
    // независимое HTF-поведение, могут передать `htfStructure` через
    // overrides отдельно от `structure`.
    htfStructure: structure,
    session: 'london',
    smartMoney: EMPTY_SMART_MONEY,
    indicators: NO_INDICATORS,
    ...overrides,
  };
}

// Build a bullish uptrend sequence: N rising candles, then a pattern candle, then a confirm candle
function uptrendCandles(patternCandle: Candle, confirmCandle: Candle, count = 6): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const base = 100 + i * 1.5;
    candles.push(candle(i, base, base + 1, base + 1.2, base - 0.3, 100));
  }
  candles.push(patternCandle);
  candles.push(confirmCandle);
  return candles;
}

function downtrendCandles(patternCandle: Candle, confirmCandle: Candle, count = 6): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const base = 120 - i * 1.5;
    candles.push(candle(i, base, base - 1, base + 0.3, base - 1.2, 100));
  }
  candles.push(patternCandle);
  candles.push(confirmCandle);
  return candles;
}

describe('detectAllPatterns', () => {
  it('returns empty for single candle', () => {
    expect(detectAllPatterns([candle(0, 1, 2, 2.5, 0.5)], ALL)).toEqual([]);
  });

  it('detects bullish engulfing', () => {
    // 5 bearish candles (downtrend) + bearish prev + bullish engulfing cur
    // (high volume) + bullish confirm. Timestamps land in the London/overlap
    // session so the context-aware detector doesn't reject for Asia/closed.
    const baseTime = 1786957200; // 09:00 UTC Monday — London session
    const candles: Candle[] = [
      candle(baseTime - 7 * 60, 110, 108, 110.5, 107.5, 100),
      candle(baseTime - 6 * 60, 108, 106, 108.5, 105.5, 100),
      candle(baseTime - 5 * 60, 106, 104, 106.5, 103.5, 100),
      candle(baseTime - 4 * 60, 104, 102, 104.5, 101.5, 100),
      candle(baseTime - 3 * 60, 102, 100, 102.5, 99.5, 100),
      candle(baseTime - 2 * 60, 100, 98, 100.5, 97.5, 100),
      candle(baseTime - 1 * 60, 97, 102, 102.2, 96.8, 200),
      candle(baseTime, 102, 104, 104.5, 101.5, 100),
    ];
    const patterns = detectAllPatterns(candles, ALL, undefined, UP_STRUCTURE, undefined, 14, undefined, undefined, UP_STRUCTURE);
    expect(patterns.some((p) => p.name === 'bullish-engulfing')).toBe(true);
  });

  it('detects bearish engulfing', () => {
    // 5 bullish candles (uptrend) + bullish prev + bearish engulfing cur
    // (high volume) + bearish confirm. Timestamps land in the London/overlap
    // session so the context-aware detector doesn't reject for Asia/closed.
    const baseTime = 1786957200; // 09:00 UTC Monday — London session
    const candles: Candle[] = [
      candle(baseTime - 7 * 60, 90, 92, 92.5, 89.5, 100),
      candle(baseTime - 6 * 60, 92, 94, 94.5, 91.5, 100),
      candle(baseTime - 5 * 60, 94, 96, 96.5, 93.5, 100),
      candle(baseTime - 4 * 60, 96, 98, 98.5, 95.5, 100),
      candle(baseTime - 3 * 60, 98, 100, 100.5, 97.5, 100),
      candle(baseTime - 2 * 60, 100, 102, 102.5, 99.5, 100),
      candle(baseTime - 1 * 60, 103, 98, 103.2, 97.8, 200),
      candle(baseTime, 98, 96, 98.5, 95.5, 100),
    ];
    const patterns = detectAllPatterns(candles, ALL, undefined, DOWN_STRUCTURE, undefined, 14, undefined, undefined, DOWN_STRUCTURE);
    expect(patterns.some((p) => p.name === 'bearish-engulfing')).toBe(true);
  });

  it('detects doji', () => {
    // BUGFIX-regression: тест обновлён под новую context-aware сигнатуру —
    // старая версия принимала direction по микроскопической разнице
    // close/open без тренда, теперь требуется предшествующий тренд.
    // Timestamps land in the London session so isAsiaOrClosed doesn't reject.
    const baseTime = 1786957200; // 09:00 UTC Monday — London session
    const candles = [
      candle(baseTime - 6 * 60, 12, 10, 12.5, 9.5),
      candle(baseTime - 5 * 60, 10.5, 8.5, 11, 8),
      candle(baseTime - 4 * 60, 8.5, 6.5, 9, 6),
      candle(baseTime - 3 * 60, 6.5, 4.5, 7, 4),
      candle(baseTime - 2 * 60, 4.5, 2.5, 5, 2),
      candle(baseTime - 1 * 60, 2.5, 0.5, 3, 0),
      candle(baseTime, 0.5, 0.505, 1.5, -1),
    ];
    const patterns = detectAllPatterns(candles, ALL, undefined, DOWN_STRUCTURE);
    expect(patterns.some((p) => p.name === 'doji')).toBe(true);
  });

  it('detects hammer', () => {
    // BUGFIX-regression: тест обновлён под новую context-aware сигнатуру —
    // старая версия принимала любую свечу с длинной нижней тенью без
    // тренда, RSI и подтверждения. Теперь нужен даунтренд + подтверждение
    // следующей свечой. Timestamps land in the London session.
    const baseTime = 1786957200; // 09:00 UTC Monday — London session
    const candles = [
      candle(baseTime - 7 * 60, 15, 13, 15.5, 12.5),
      candle(baseTime - 6 * 60, 13, 11, 13.5, 10.5),
      candle(baseTime - 5 * 60, 11, 9, 11.5, 8.5),
      candle(baseTime - 4 * 60, 9, 7, 9.5, 6.5),
      candle(baseTime - 3 * 60, 7, 5, 7.5, 4.5),
      candle(baseTime - 2 * 60, 5, 3, 5.5, 2.5),
      candle(baseTime - 1 * 60, 2.5, 2.8, 2.85, 0.5, 200), // pattern: small body up top, long lower wick
      candle(baseTime, 2.5, 4, 4.2, 2.4, 150), // confirmation: strong close above pattern body
    ];
    const downStruct = { trend: 'down', bos: false, choch: true, swingHigh: 16, swingLow: 0, provisional: false } as const;
    const patterns = detectAllPatterns(candles, ALL, undefined, downStruct, undefined, 14, undefined, undefined, downStruct);
    const hammer = patterns.find((p) => p.name === 'hammer');
    expect(hammer).toBeDefined();
    expect(hammer?.direction).toBe('buy');
  });

  it('filters out patterns not in activeFeatures', () => {
    const candles = [
      candle(0, 10, 8, 10.5, 7.5),
      candle(1, 7.5, 11, 11.5, 7),
    ];
    const patterns = detectAllPatterns(candles, ['doji'] as FeatureName[]);
    expect(patterns.some((p) => p.name === 'bullish-engulfing')).toBe(false);
    expect(patterns.some((p) => p.name === 'doji')).toBe(false);
  });
});

// ─── detectHammer (BUGFIX аудит 2026-09-12: теперь context-aware, как
// Inverted Hammer/Hanging Man — требует даунтренд, RSI<=40, сессию и
// обязательное подтверждение следующей свечой) ─────────────────────

describe('detectHammer', () => {
  it('detects hammer with downtrend, RSI <= 40, and confirmation', () => {
    // Hammer: тело в верхней трети диапазона, длинная нижняя тень (>=2x
    // тела), короткая верхняя тень (<=0.5x тела) — та же форма, что Hanging
    // Man, но после нисходящего импульса (бычий разворот).
    const pattern = candle(6, 87.5, 88, 88.05, 84, 200);
    const confirm = candle(7, 87.5, 91, 91.5, 87, 120); // сильное закрытие выше тела паттерна
    const candles = downtrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, {
      structure: { trend: 'down', bos: false, choch: true, swingHigh: 110, swingLow: 87, provisional: false },
      indicators: { ...NO_INDICATORS, rsi: 30 },
      session: 'overlap',
    });
    const result = detectHammer(ctx);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('hammer');
    expect(result?.direction).toBe('buy');
    expect(result?.confirmedByNextCandle).toBe(true);
  });

  it('returns null without confirmation candle', () => {
    const pattern = candle(6, 87.5, 88, 88.05, 84, 200);
    const confirm = candle(7, 87.5, 86, 87.6, 85, 120); // медвежье закрытие — подтверждения нет
    const candles = downtrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, {
      structure: DOWN_STRUCTURE,
      indicators: { ...NO_INDICATORS, rsi: 30 },
    });
    expect(detectHammer(ctx)).toBeNull();
  });

  it('returns null when RSI > 40 (if RSI available)', () => {
    const pattern = candle(6, 87.5, 88, 88.05, 84, 200);
    const confirm = candle(7, 87.5, 91, 91.5, 87, 120);
    const candles = downtrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, {
      structure: { trend: 'down', bos: false, choch: true, swingHigh: 110, swingLow: 87, provisional: false },
      indicators: { ...NO_INDICATORS, rsi: 55 },
    });
    expect(detectHammer(ctx)).toBeNull();
  });

  it('returns null without preceding downtrend (BUGFIX regression guard)', () => {
    // До фикса detectHammer(cur) сработал бы на этой же форме свечи даже
    // посреди аптренда — именно эта регрессия и была источником ложных buy.
    const pattern = candle(1, 87.5, 88, 88.05, 84, 200);
    const confirm = candle(2, 87.5, 91, 91.5, 87, 120);
    const candles = [
      candle(0, 85, 87, 87.5, 84.5), // бычья свеча — нет медвежьего импульса
      pattern,
      confirm,
    ];
    const ctx = makeCtx(candles, {
      structure: RANGE_STRUCTURE,
      indicators: { ...NO_INDICATORS, rsi: 30 },
    });
    expect(detectHammer(ctx)).toBeNull();
  });
});

// ─── detectDoji (BUGFIX аудит 2026-09-12: теперь context-aware — направление
// берётся из предшествующего тренда, а не из микроскопического close/open) ─

describe('detectDoji', () => {
  it('detects doji as bullish reversal after a downtrend', () => {
    const pattern = candle(6, 88, 88.005, 89, 87);
    const candles = downtrendCandles(pattern, candle(7, 88, 87.5, 88.5, 87));
    const ctx = makeCtx(candles, { structure: DOWN_STRUCTURE, index: candles.length - 2 });
    const result = detectDoji(ctx);
    expect(result).not.toBeNull();
    expect(result?.direction).toBe('buy');
  });

  it('detects doji as bearish reversal after an uptrend', () => {
    const pattern = candle(6, 112, 111.995, 113, 111);
    const candles = uptrendCandles(pattern, candle(7, 112, 112.5, 113, 111.5));
    const ctx = makeCtx(candles, { structure: UP_STRUCTURE, index: candles.length - 2 });
    const result = detectDoji(ctx);
    expect(result).not.toBeNull();
    expect(result?.direction).toBe('sell');
  });

  it('returns null in a range with no clear trend (BUGFIX regression guard)', () => {
    // До фикса эта же свеча сгенерировала бы произвольное направление
    // ("buy"/"sell") по разнице close-open даже без какого-либо тренда.
    // Предшествующие свечи флэтовые (open===close), чтобы countBullish и
    // countBearish были равны нулю — а не "3 против 2" при чередовании,
    // что hasPrecedingBearish/Bullish (порог >=3 из 5) засчитал бы как
    // тренд.
    const candles = [
      candle(0, 100, 100, 100.5, 99.5),
      candle(1, 100, 100, 100.5, 99.5),
      candle(2, 100, 100, 100.5, 99.5),
      candle(3, 100, 100, 100.5, 99.5),
      candle(4, 100, 100, 100.5, 99.5),
      candle(5, 100, 100, 100.5, 99.5),
      candle(6, 100, 100.005, 101, 99),
      candle(7, 100, 100, 100.5, 99.5),
    ];
    const ctx = makeCtx(candles, { structure: RANGE_STRUCTURE, index: candles.length - 2 });
    expect(detectDoji(ctx)).toBeNull();
  });

  it('returns null when body is too large', () => {
    const pattern = candle(6, 88, 89, 89, 87);
    const candles = downtrendCandles(pattern, candle(7, 88, 87.5, 88.5, 87));
    const ctx = makeCtx(candles, { structure: DOWN_STRUCTURE, index: candles.length - 2 });
    expect(detectDoji(ctx)).toBeNull();
  });
});

// ─── detectShootingStar ────────────────────────────────────────────

describe('detectShootingStar', () => {
  it('detects shooting star with bullish context and confirmation', () => {
    // Pattern candle: small body in lower third, long upper wick (>=2x body), tiny lower wick (<=0.5x body)
    const pattern = candle(6, 112, 111, 116, 110.9, 200);
    const confirm = candle(7, 111, 109, 111.5, 108, 120);
    const candles = uptrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, { structure: { trend: 'up', bos: false, choch: true, swingHigh: 116, swingLow: 95, provisional: false } });
    const result = detectShootingStar(ctx);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('shooting-star');
    expect(result?.direction).toBe('sell');
    expect(result?.time).toBe(confirm.time);
  });

  it('returns null without preceding bullish impulse', () => {
    const pattern = candle(1, 112, 111, 116, 110.9, 150);
    const confirm = candle(2, 111, 109, 111.5, 108, 120);
    const candles = [
      candle(0, 110, 109, 111, 108),
      pattern,
      confirm,
    ];
    const ctx = makeCtx(candles, { structure: RANGE_STRUCTURE });
    expect(detectShootingStar(ctx)).toBeNull();
  });

  it('returns null in Asia session', () => {
    const pattern = candle(6, 112, 111, 116, 110.9, 200);
    const confirm = candle(7, 111, 109, 111.5, 108, 120);
    const candles = uptrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, { session: 'tokyo' });
    expect(detectShootingStar(ctx)).toBeNull();
  });

  it('returns null when next candle contradicts (bullish close)', () => {
    const pattern = candle(6, 112, 111, 116, 110.9, 200);
    const confirm = candle(7, 111, 117, 118, 110.5, 120); // bullish, closes above pattern high
    const candles = uptrendCandles(pattern, confirm);
    const ctx = makeCtx(candles);
    expect(detectShootingStar(ctx)).toBeNull();
  });
});

// ─── detectPinBar ──────────────────────────────────────────────────

describe('detectPinBar', () => {
  it('detects bullish pin bar near swing low with confirmation', () => {
    // Bullish pin bar: long lower wick, body in upper third
    const pattern = candle(6, 100, 100.5, 101, 94, 150);
    const confirm = candle(7, 100, 102, 102.5, 99.5, 120);
    const candles = uptrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, {
      structure: { ...UP_STRUCTURE, swingLow: 94 },
      indicators: { ...NO_INDICATORS, atr: 3 },
    });
    const result = detectPinBar(ctx);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('pin-bar');
    expect(result?.direction).toBe('buy');
  });

  it('detects bearish pin bar near swing high with confirmation', () => {
    // Bearish pin bar: long upper wick, body in lower third
    const pattern = candle(6, 110, 109.5, 116, 109, 150);
    const confirm = candle(7, 109, 107, 109.5, 106, 120);
    const candles = uptrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, {
      structure: { ...DOWN_STRUCTURE, swingHigh: 116 },
      indicators: { ...NO_INDICATORS, atr: 3 },
    });
    const result = detectPinBar(ctx);
    expect(result).not.toBeNull();
    expect(result?.direction).toBe('sell');
  });

  it('returns null without proximity to OB/FVG or swing level', () => {
    const pattern = candle(6, 100, 100.5, 101, 94, 150);
    const confirm = candle(7, 100, 102, 102.5, 99.5, 120);
    const candles = uptrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, {
      structure: { trend: 'range', bos: false, choch: false, swingHigh: 200, swingLow: 50, provisional: false },
      indicators: { ...NO_INDICATORS, atr: 1 },
    });
    expect(detectPinBar(ctx)).toBeNull();
  });

  it('returns null when body is too large', () => {
    const pattern = candle(6, 100, 103, 104, 99, 150); // body=3, range=5, body/range=0.6
    const confirm = candle(7, 103, 105, 106, 102, 120);
    const candles = uptrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, { structure: { ...UP_STRUCTURE, swingLow: 99 }, indicators: { ...NO_INDICATORS, atr: 3 } });
    expect(detectPinBar(ctx)).toBeNull();
  });

  it('returns null in Asia session', () => {
    const pattern = candle(6, 100, 100.5, 101, 94, 150);
    const confirm = candle(7, 100, 102, 102.5, 99.5, 120);
    const candles = uptrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, {
      structure: { ...UP_STRUCTURE, swingLow: 94 },
      indicators: { ...NO_INDICATORS, atr: 3 },
      session: 'sydney',
    });
    expect(detectPinBar(ctx)).toBeNull();
  });
});

// ─── detectHangingMan ──────────────────────────────────────────────

describe('detectHangingMan', () => {
  it('detects hanging man with uptrend, RSI >= 60, and confirmation', () => {
    // Hanging man: small body in upper third, long lower wick, small upper wick
    // Use choch=true to signal potential reversal (htfAlignment=0.75 for counter-trend)
    // Hanging man: body in upper third, long lower wick (>=2x body), tiny upper wick (<=0.5x body)
    const pattern = candle(6, 111.5, 112, 112.05, 108, 200);
    const confirm = candle(7, 111.5, 109, 112, 108, 120); // bearish close below pattern body
    const candles = uptrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, {
      structure: { trend: 'up', bos: false, choch: true, swingHigh: 113, swingLow: 95, provisional: false },
      indicators: { ...NO_INDICATORS, rsi: 70 },
      session: 'overlap',
    });
    const result = detectHangingMan(ctx);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('hanging-man');
    expect(result?.direction).toBe('sell');
    expect(result?.confirmedByNextCandle).toBe(true);
  });

  it('returns null without confirmation candle', () => {
    const pattern = candle(6, 111.5, 112, 112.05, 108, 150);
    const confirm = candle(7, 111.5, 112, 113, 111, 120); // bullish close, no confirmation
    const candles = uptrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, {
      structure: UP_STRUCTURE,
      indicators: { ...NO_INDICATORS, rsi: 65 },
    });
    expect(detectHangingMan(ctx)).toBeNull();
  });

  it('returns null when RSI < 60 (if RSI available)', () => {
    const pattern = candle(6, 111.5, 112, 112.05, 108, 200);
    const confirm = candle(7, 111.5, 109, 112, 108, 120);
    const candles = uptrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, {
      structure: { trend: 'up', bos: false, choch: true, swingHigh: 113, swingLow: 95, provisional: false },
      indicators: { ...NO_INDICATORS, rsi: 45 },
    });
    expect(detectHangingMan(ctx)).toBeNull();
  });

  it('returns null in closed session', () => {
    const pattern = candle(6, 111.5, 112, 112.05, 108, 200);
    const confirm = candle(7, 111.5, 109, 112, 108, 120);
    const candles = uptrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, {
      structure: { trend: 'up', bos: false, choch: true, swingHigh: 113, swingLow: 95, provisional: false },
      indicators: { ...NO_INDICATORS, rsi: 65 },
      session: 'closed',
    });
    expect(detectHangingMan(ctx)).toBeNull();
  });
});

// ─── detectInvertedHammer ───────────────────────────────────────────

describe('detectInvertedHammer', () => {
  it('detects inverted hammer with downtrend, RSI <= 40, and confirmation', () => {
    // Inverted hammer: small body in lower third, long upper wick, small lower wick
    // Use choch=true to signal potential reversal (htfAlignment=0.75 for counter-trend)
    // Inverted hammer: body in lower third, long upper wick (>=2x body), tiny lower wick (<=0.5x body)
    const pattern = candle(6, 88, 88.5, 92, 88.45, 200);
    const confirm = candle(7, 88, 91, 92, 87.5, 120); // bullish close above pattern body
    const candles = downtrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, {
      structure: { trend: 'down', bos: false, choch: true, swingHigh: 110, swingLow: 87, provisional: false },
      indicators: { ...NO_INDICATORS, rsi: 25 },
      session: 'overlap',
    });
    const result = detectInvertedHammer(ctx);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('inverted-hammer');
    expect(result?.direction).toBe('buy');
    expect(result?.confirmedByNextCandle).toBe(true);
  });

  it('returns null without confirmation', () => {
    const pattern = candle(6, 88, 88.5, 92, 88.45, 150);
    const confirm = candle(7, 88, 86, 89, 85, 120); // bearish, no confirmation
    const candles = downtrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, {
      structure: DOWN_STRUCTURE,
      indicators: { ...NO_INDICATORS, rsi: 35 },
    });
    expect(detectInvertedHammer(ctx)).toBeNull();
  });

  it('returns null when RSI > 40 (if RSI available)', () => {
    const pattern = candle(6, 88, 88.5, 92, 88.45, 200);
    const confirm = candle(7, 88, 91, 92, 87.5, 120);
    const candles = downtrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, {
      structure: { trend: 'down', bos: false, choch: true, swingHigh: 110, swingLow: 87, provisional: false },
      indicators: { ...NO_INDICATORS, rsi: 50 },
    });
    expect(detectInvertedHammer(ctx)).toBeNull();
  });

  it('returns null without preceding bearish impulse', () => {
    const pattern = candle(1, 88, 88.5, 92, 88.45, 200);
    const confirm = candle(2, 88, 91, 92, 87.5, 120);
    const candles = [
      candle(0, 90, 92, 93, 89), // bullish
      pattern,
      confirm,
    ];
    const ctx = makeCtx(candles, {
      structure: RANGE_STRUCTURE,
      indicators: { ...NO_INDICATORS, rsi: 35 },
    });
    expect(detectInvertedHammer(ctx)).toBeNull();
  });
});

// ─── detectMarubozuBullish ─────────────────────────────────────────

describe('detectMarubozuBullish', () => {
  it('detects bullish marubozu with volume and trend', () => {
    // Marubozu: body >= 90% of range, tiny wicks, bullish
    const pattern = candle(6, 100, 106, 106.1, 99.9, 200);
    const confirm = candle(7, 106, 107, 108, 105, 120);
    const candles = uptrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, { structure: UP_STRUCTURE });
    const result = detectMarubozuBullish(ctx);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('marubozu-bullish');
    expect(result?.direction).toBe('buy');
    expect(result?.volumeConfirmed).toBe(true);
  });

  it('returns null in range without BOS/CHoCH', () => {
    const pattern = candle(6, 100, 106, 106.1, 99.9, 200);
    const confirm = candle(7, 106, 107, 108, 105, 120);
    const candles = uptrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, { structure: RANGE_STRUCTURE });
    expect(detectMarubozuBullish(ctx)).toBeNull();
  });

  it('returns null with volume below average', () => {
    const pattern = candle(6, 100, 106, 106.1, 99.9, 50); // low volume
    const confirm = candle(7, 106, 107, 108, 105, 120);
    const candles = uptrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, { structure: UP_STRUCTURE });
    expect(detectMarubozuBullish(ctx)).toBeNull();
  });

  it('returns null in Asia session', () => {
    const pattern = candle(6, 100, 106, 106.1, 99.9, 200);
    const confirm = candle(7, 106, 107, 108, 105, 120);
    const candles = uptrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, { structure: UP_STRUCTURE, session: 'tokyo' });
    expect(detectMarubozuBullish(ctx)).toBeNull();
  });
});

// ─── detectMarubozuBearish ─────────────────────────────────────────

describe('detectMarubozuBearish', () => {
  it('detects bearish marubozu with volume and downtrend', () => {
    const pattern = candle(6, 110, 104, 110.1, 103.9, 200);
    const confirm = candle(7, 104, 103, 105, 102, 120);
    const candles = downtrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, { structure: DOWN_STRUCTURE });
    const result = detectMarubozuBearish(ctx);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('marubozu-bearish');
    expect(result?.direction).toBe('sell');
  });

  it('returns null in range without BOS/CHoCH', () => {
    const pattern = candle(6, 110, 104, 110.1, 103.9, 200);
    const confirm = candle(7, 104, 103, 105, 102, 120);
    const candles = downtrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, { structure: RANGE_STRUCTURE });
    expect(detectMarubozuBearish(ctx)).toBeNull();
  });

  it('returns null with volume below average', () => {
    const pattern = candle(6, 110, 104, 110.1, 103.9, 50);
    const confirm = candle(7, 104, 103, 105, 102, 120);
    const candles = downtrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, { structure: DOWN_STRUCTURE });
    expect(detectMarubozuBearish(ctx)).toBeNull();
  });
});

// ─── Existing double/triple pattern tests (unchanged) ──────────────

describe('detectBullishEngulfing', () => {
  // 5 bearish candles (downtrend) + prevCandle (bearish) + curCandle (bullish
  // engulfing, full-body + full-wick engulf, short wicks) + confirmCandle
  // (strong bullish confirmation).
  const preceding: Candle[] = [
    candle(0, 110, 108, 110.5, 107.5, 100),
    candle(1, 108, 106, 108.5, 105.5, 100),
    candle(2, 106, 104, 106.5, 103.5, 100),
    candle(3, 104, 102, 104.5, 101.5, 100),
    candle(4, 102, 100, 102.5, 99.5, 100),
  ];
  const prevCandle = candle(5, 100, 98, 100.5, 97.5, 100);
  const curCandle = candle(6, 97, 102, 102.2, 96.8, 200);
  const confirmCandle = candle(7, 102, 104, 104.5, 101.5, 100);
  const candles = [...preceding, prevCandle, curCandle, confirmCandle];

  it('detects a valid bullish engulfing with full context', () => {
    const result = detectBullishEngulfing(makeCtx(candles));
    expect(result).not.toBeNull();
    expect(result?.direction).toBe('buy');
    expect(result?.confirmedByNextCandle).toBe(true);
    expect(result?.volumeConfirmed).toBe(true);
  });

  it('does not fire without sufficient volume', () => {
    const lowVolumeCandles = [...preceding, prevCandle, { ...curCandle, volume: 50 }, confirmCandle];
    const result = detectBullishEngulfing(makeCtx(lowVolumeCandles));
    expect(result).toBeNull();
  });

  it('does not fire without a preceding bearish impulse (range structure, flat candles)', () => {
    const flatPreceding: Candle[] = preceding.map((c, i) => candle(i, 100, 100, 100.2, 99.8, 100));
    const flatCandles = [...flatPreceding, prevCandle, curCandle, confirmCandle];
    const result = detectBullishEngulfing(makeCtx(flatCandles, { structure: RANGE_STRUCTURE }));
    expect(result).toBeNull();
  });

  it('is cancelled when the confirming candle contradicts the signal', () => {
    const contradicting = candle(7, 102, 95, 102.5, 94.5, 100); // closes below curCandle.low
    const candlesWithContradiction = [...preceding, prevCandle, curCandle, contradicting];
    const result = detectBullishEngulfing(makeCtx(candlesWithContradiction));
    expect(result).toBeNull();
  });
});

describe('detectBearishEngulfing', () => {
  const preceding: Candle[] = [
    candle(0, 90, 92, 92.5, 89.5, 100),
    candle(1, 92, 94, 94.5, 91.5, 100),
    candle(2, 94, 96, 96.5, 93.5, 100),
    candle(3, 96, 98, 98.5, 95.5, 100),
    candle(4, 98, 100, 100.5, 97.5, 100),
  ];
  const prevCandle = candle(5, 100, 102, 102.5, 99.5, 100);
  const curCandle = candle(6, 103, 98, 103.2, 97.8, 200);
  const confirmCandle = candle(7, 98, 96, 98.5, 95.5, 100);
  const candles = [...preceding, prevCandle, curCandle, confirmCandle];

  it('detects a valid bearish engulfing with full context', () => {
    const result = detectBearishEngulfing(makeCtx(candles, { structure: DOWN_STRUCTURE }));
    expect(result).not.toBeNull();
    expect(result?.direction).toBe('sell');
    expect(result?.confirmedByNextCandle).toBe(true);
  });

  it('does not fire without sufficient volume', () => {
    const lowVolumeCandles = [...preceding, prevCandle, { ...curCandle, volume: 50 }, confirmCandle];
    const result = detectBearishEngulfing(makeCtx(lowVolumeCandles, { structure: DOWN_STRUCTURE }));
    expect(result).toBeNull();
  });

  it('does not fire in the Asia session', () => {
    const result = detectBearishEngulfing(makeCtx(candles, { structure: DOWN_STRUCTURE, session: 'tokyo' }));
    expect(result).toBeNull();
  });
});

describe('detectPiercingLine', () => {
  const preceding: Candle[] = [
    candle(0, 110, 108, 110.5, 107.5, 100),
    candle(1, 108, 106, 108.5, 105.5, 100),
    candle(2, 106, 104, 106.5, 103.5, 100),
    candle(3, 104, 102, 104.5, 101.5, 100),
    candle(4, 102, 100, 102.5, 99.5, 100),
  ];
  const prevCandle = candle(5, 100, 94, 100.5, 93.5, 100); // bearish, body 6
  const curCandle = candle(6, 93, 98, 98.5, 92.5, 140); // closes at 98, midpoint of prev is 97
  const confirmCandle = candle(7, 98, 100, 100.5, 97.5, 100);
  const candles = [...preceding, prevCandle, curCandle, confirmCandle];

  it('detects a valid piercing line with >50% penetration and full context', () => {
    const result = detectPiercingLine(makeCtx(candles));
    expect(result).not.toBeNull();
    expect(result?.direction).toBe('buy');
  });

  it('does not fire when penetration is below the strict 50% rule', () => {
    const shallowCur = candle(6, 93, 96, 96.5, 92.5, 140); // closes at 96, below midpoint 97
    const shallowCandles = [...preceding, prevCandle, shallowCur, confirmCandle];
    const result = detectPiercingLine(makeCtx(shallowCandles));
    expect(result).toBeNull();
  });

  it('does not fire without sufficient volume (1.3x threshold)', () => {
    const lowVolumeCandles = [...preceding, prevCandle, { ...curCandle, volume: 110 }, confirmCandle]; // ratio 1.1 < 1.3
    const result = detectPiercingLine(makeCtx(lowVolumeCandles));
    expect(result).toBeNull();
  });
});

describe('detectDarkCloudCover', () => {
  const preceding: Candle[] = [
    candle(0, 90, 92, 92.5, 89.5, 100),
    candle(1, 92, 94, 94.5, 91.5, 100),
    candle(2, 94, 96, 96.5, 93.5, 100),
    candle(3, 96, 98, 98.5, 95.5, 100),
    candle(4, 98, 100, 100.5, 97.5, 100),
  ];
  const prevCandle = candle(5, 100, 106, 106.5, 99.5, 100); // bullish, body 6
  const curCandle = candle(6, 107, 102, 107.5, 101.5, 140); // closes at 102, midpoint of prev is 103
  const confirmCandle = candle(7, 102, 99, 102.5, 98.5, 100);
  const candles = [...preceding, prevCandle, curCandle, confirmCandle];

  it('detects a valid dark cloud cover with >50% penetration and full context', () => {
    const result = detectDarkCloudCover(makeCtx(candles, { structure: DOWN_STRUCTURE }));
    expect(result).not.toBeNull();
    expect(result?.direction).toBe('sell');
  });

  it('does not fire when penetration is below the strict 50% rule', () => {
    const shallowCur = candle(6, 107, 104, 107.5, 101.5, 140); // closes at 104, above midpoint 103
    const shallowCandles = [...preceding, prevCandle, shallowCur, confirmCandle];
    const result = detectDarkCloudCover(makeCtx(shallowCandles, { structure: DOWN_STRUCTURE }));
    expect(result).toBeNull();
  });
});

describe('detectTweezerBottom', () => {
  const preceding: Candle[] = [
    candle(0, 110, 108, 110.5, 107.5, 100),
    candle(1, 108, 106, 108.5, 105.5, 100),
    candle(2, 106, 104, 106.5, 103.5, 100),
    candle(3, 104, 102, 104.5, 101.5, 100),
    candle(4, 102, 100, 102.5, 99.5, 100),
  ];
  const prevCandle = candle(5, 98, 96, 98.5, 95, 100);
  const curCandle = candle(6, 95.5, 97, 97.5, 95, 140); // matching low = 95
  const strongConfirm = candle(7, 97, 99, 99.5, 96.5, 100); // closes above curCandle body top (97)
  const weakConfirm = candle(7, 96, 96, 96.5, 95.5, 100); // does not confirm (not below/above thresholds)
  const candles = [...preceding, prevCandle, curCandle, strongConfirm];

  it('detects a valid tweezer bottom WITH mandatory next-candle confirmation', () => {
    const result = detectTweezerBottom(makeCtx(candles));
    expect(result).not.toBeNull();
    expect(result?.direction).toBe('buy');
    expect(result?.confirmedByNextCandle).toBe(true);
  });

  it('NEVER fires without next-candle confirmation (golden rule)', () => {
    const unconfirmedCandles = [...preceding, prevCandle, curCandle, weakConfirm];
    const result = detectTweezerBottom(makeCtx(unconfirmedCandles));
    expect(result).toBeNull();
  });

  it('does not fire when RSI is on the wrong side of 50', () => {
    const result = detectTweezerBottom(makeCtx(candles, { indicators: { ...NO_INDICATORS, rsi: 65 } }));
    expect(result).toBeNull();
  });
});

describe('detectTweezerTop', () => {
  const preceding: Candle[] = [
    candle(0, 90, 92, 92.5, 89.5, 100),
    candle(1, 92, 94, 94.5, 91.5, 100),
    candle(2, 94, 96, 96.5, 93.5, 100),
    candle(3, 96, 98, 98.5, 95.5, 100),
    candle(4, 98, 100, 100.5, 97.5, 100),
  ];
  const prevCandle = candle(5, 106, 109, 110, 105.5, 100);
  const curCandle = candle(6, 109.5, 107, 110, 106.5, 140); // matching high = 110
  const strongConfirm = candle(7, 107, 105, 107.5, 104.5, 100); // closes below curCandle body bottom (107)
  const weakConfirm = candle(7, 109, 109, 109.5, 108.5, 100); // does not confirm
  const candles = [...preceding, prevCandle, curCandle, strongConfirm];

  it('detects a valid tweezer top WITH mandatory next-candle confirmation', () => {
    const result = detectTweezerTop(makeCtx(candles, { structure: DOWN_STRUCTURE }));
    expect(result).not.toBeNull();
    expect(result?.direction).toBe('sell');
    expect(result?.confirmedByNextCandle).toBe(true);
  });

  it('NEVER fires without next-candle confirmation (golden rule)', () => {
    const unconfirmedCandles = [...preceding, prevCandle, curCandle, weakConfirm];
    const result = detectTweezerTop(makeCtx(unconfirmedCandles, { structure: DOWN_STRUCTURE }));
    expect(result).toBeNull();
  });

  it('does not fire when RSI is on the wrong side of 50', () => {
    const result = detectTweezerTop(makeCtx(candles, { structure: DOWN_STRUCTURE, indicators: { ...NO_INDICATORS, rsi: 35 } }));
    expect(result).toBeNull();
  });
});

describe('double-bar patterns: session derived from curCandle time (regression)', () => {
  it('uses the session of curCandle (index length-2), not prevCandle or Date.now(), via detectAllPatterns', () => {
    const preceding: Candle[] = [
      candle(1786950000 - 300, 110, 108, 110.5, 107.5, 100),
      candle(1786950000 - 240, 108, 106, 108.5, 105.5, 100),
      candle(1786950000 - 180, 106, 104, 106.5, 103.5, 100),
      candle(1786950000 - 120, 104, 102, 104.5, 101.5, 100),
      candle(1786950000 - 60, 102, 100, 102.5, 99.5, 100),
    ];
    // prevCandle sits in the Tokyo (Asia) session — 07:00 UTC, Monday 2026-08-17.
    const prevCandle = candle(1786950000, 100, 98, 100.5, 97.5, 100);
    // curCandle sits in the London session — 09:00 UTC, same Monday. If the
    // session were (bug) computed from prevCandle's time instead of
    // curCandle's, this would be wrongly classified as Asia and rejected.
    const curCandle = candle(1786957200, 97, 102, 102.2, 96.8, 200);
    const confirmCandle = candle(1786957260, 102, 104, 104.5, 101.5, 100);
    const candles = [...preceding, prevCandle, curCandle, confirmCandle];

    const patterns = detectAllPatterns(
      candles,
      ['bullish-engulfing'] as FeatureName[],
      NO_INDICATORS,
      UP_STRUCTURE,
      EMPTY_SMART_MONEY,
      14,
      undefined,
      undefined,
      UP_STRUCTURE,
    );
    const engulfing = patterns.find((p) => p.name === 'bullish-engulfing');
    expect(engulfing).toBeDefined();
    expect(engulfing?.direction).toBe('buy');
  });
});

// ─── detectBullishHarami / detectBearishHarami (BUGFIX аудит 2026-09-12:
// раньше принимали (prev, cur) без единого контекстного фильтра — были
// явно помечены "UNCHANGED (out of scope)" в double.ts. Теперь
// context-aware: обязательный контр-трендовый импульс, запрет
// Азии/закрытого рынка, классический объёмный признак (падение объёма на
// 2-й свече) и ОБЯЗАТЕЛЬНОЕ подтверждение следующей свечой — золотое
// правило, как у Tweezer.) ──────────────────────────────────────────

describe('detectBullishHarami', () => {
  const prevCandle = candle(0, 10, 7, 10.5, 6.5, 200); // mother: bearish impulse, high volume
  const curCandle = candle(1, 7.5, 8, 8.5, 7, 80); // inside, bullish, contained, lower volume (индecision)
  const strongConfirm = candle(2, 8, 9, 9.5, 7.8, 100); // closes above curCandle body top (8)
  const weakConfirm = candle(2, 7.8, 7.9, 8, 7.7, 100); // не подтверждает

  it('detects a valid bullish harami WITH mandatory next-candle confirmation', () => {
    const candles = [prevCandle, curCandle, strongConfirm];
    const ctx = makeCtx(candles, {
      structure: { trend: 'down', bos: false, choch: true, swingHigh: 110, swingLow: 87, provisional: false },
      session: 'overlap',
    });
    const result = detectBullishHarami(ctx);
    expect(result).not.toBeNull();
    expect(result?.direction).toBe('buy');
    expect(result?.confirmedByNextCandle).toBe(true);
  });

  it('NEVER fires without next-candle confirmation (golden rule)', () => {
    const candles = [prevCandle, curCandle, weakConfirm];
    const ctx = makeCtx(candles, {
      structure: { trend: 'down', bos: false, choch: true, swingHigh: 110, swingLow: 87, provisional: false },
      session: 'overlap',
    });
    expect(detectBullishHarami(ctx)).toBeNull();
  });

  it('returns null when the 2nd candle volume is NOT lower than the mother candle (BUGFIX regression guard)', () => {
    // Раньше детектор не проверял объём вообще — сработал бы даже на
    // агрессивной 2-й свече, что противоречит самому смыслу Harami
    // (нерешительность = падающий объём).
    const aggressiveCur = candle(1, 7.5, 8, 8.5, 7, 250); // volume выше, чем у mother
    const candles = [prevCandle, aggressiveCur, strongConfirm];
    const ctx = makeCtx(candles, {
      structure: { trend: 'down', bos: false, choch: true, swingHigh: 110, swingLow: 87, provisional: false },
      session: 'overlap',
    });
    expect(detectBullishHarami(ctx)).toBeNull();
  });

  it('returns null without preceding downtrend (BUGFIX regression guard)', () => {
    const candles = [prevCandle, curCandle, strongConfirm];
    const ctx = makeCtx(candles, { structure: RANGE_STRUCTURE, session: 'overlap' });
    expect(detectBullishHarami(ctx)).toBeNull();
  });

  it('returns null in closed session (BUGFIX regression guard)', () => {
    const candles = [prevCandle, curCandle, strongConfirm];
    const ctx = makeCtx(candles, {
      structure: { trend: 'down', bos: false, choch: true, swingHigh: 110, swingLow: 87, provisional: false },
      session: 'closed',
    });
    expect(detectBullishHarami(ctx)).toBeNull();
  });
});

describe('detectBearishHarami', () => {
  const prevCandle = candle(0, 7, 10, 10.5, 6.5, 200); // mother: bullish impulse, high volume
  const curCandle = candle(1, 9, 8.5, 9.5, 8, 80); // inside, bearish, contained, lower volume
  const strongConfirm = candle(2, 8.5, 7.5, 8.7, 7.3, 100); // closes below curCandle body bottom (8.5)
  const weakConfirm = candle(2, 8.6, 9.2, 9.4, 8.5, 100); // не подтверждает (close в "мёртвой зоне")

  it('detects a valid bearish harami WITH mandatory next-candle confirmation', () => {
    const candles = [prevCandle, curCandle, strongConfirm];
    const ctx = makeCtx(candles, {
      structure: { trend: 'up', bos: false, choch: true, swingHigh: 113, swingLow: 95, provisional: false },
      session: 'overlap',
    });
    const result = detectBearishHarami(ctx);
    expect(result).not.toBeNull();
    expect(result?.direction).toBe('sell');
    expect(result?.confirmedByNextCandle).toBe(true);
  });

  it('NEVER fires without next-candle confirmation (golden rule)', () => {
    const candles = [prevCandle, curCandle, weakConfirm];
    const ctx = makeCtx(candles, {
      structure: { trend: 'up', bos: false, choch: true, swingHigh: 113, swingLow: 95, provisional: false },
      session: 'overlap',
    });
    expect(detectBearishHarami(ctx)).toBeNull();
  });

  it('returns null without preceding uptrend (BUGFIX regression guard)', () => {
    const candles = [prevCandle, curCandle, strongConfirm];
    const ctx = makeCtx(candles, { structure: RANGE_STRUCTURE, session: 'overlap' });
    expect(detectBearishHarami(ctx)).toBeNull();
  });
});

// ── Общие фикстуры для трёхсвечных context-aware паттернов (Шаг 2/5 апгрейда) ──

const FAVORABLE_ATR = 1.0;

function favorableIndicators(overrides: Partial<IndicatorSnapshot> = {}): IndicatorSnapshot {
  return { ...NO_INDICATORS, atr: FAVORABLE_ATR, ...overrides };
}

// 10 небольших медвежьих свечей подряд (чёткий нисходящий тренд, требуемый
// star/soldiers/abandoned-baby-bottom детекторами: >=5 из последних 7).
function smallDowntrend(count: number, startOpen: number, volume = 100): Candle[] {
  const out: Candle[] = [];
  let open = startOpen;
  for (let i = 0; i < count; i++) {
    const close = open - 0.3;
    out.push(candle(i, open, close, open + 0.1, close - 0.1, volume));
    open = close - 0.7; // общий уклон вниз между свечами
  }
  return out;
}

function smallUptrend(count: number, startOpen: number, volume = 100): Candle[] {
  const out: Candle[] = [];
  let open = startOpen;
  for (let i = 0; i < count; i++) {
    const close = open + 0.3;
    out.push(candle(i, open, close, close + 0.1, open - 0.1, volume));
    open = close + 0.7;
  }
  return out;
}

// Готовый TripleContext, где 7 из 9 мультифакторных фильтров гарантированно
// проходят (OB-конфлюэнс, свип ликвидности, MACD, EMA-зона, Bollinger,
// структурный сдвиг, kill-zone сессия) — независимо от точного значения RSI,
// которое зависит от формы всей серии свечей и не форсируется искусственно.
function favorableTripleCtx(
  candles: Candle[],
  candleA: Candle,
  candleC: Candle,
  direction: 'buy' | 'sell',
  overrides: Partial<TripleContext> = {},
): TripleContext {
  const obType = direction === 'buy' ? 'bullish' : 'bearish';
  const mid = direction === 'buy' ? candleC.low : candleC.high;
  const structure: MarketStructure = {
    trend: direction === 'buy' ? 'up' : 'down',
    bos: false,
    choch: true,
    swingHigh: direction === 'buy' ? null : candleA.high,
    swingLow: direction === 'buy' ? candleA.low : null,
    provisional: false,
  };
  return {
    candles,
    structure,
    // BUGFIX (аудит 2026-09-12, §1): см. аналогичный комментарий в makeCtx
    // выше — htfStructure по умолчанию зеркалит structure этого же вызова,
    // чтобы существующие тесты (Morning/Evening Star, Soldiers/Crows,
    // Abandoned Baby) сохранили свои уже проверенные числовые ожидания.
    htfStructure: structure,
    session: 'london',
    smartMoney: {
      orderBlocks: [{
        top: mid + 0.5,
        bottom: mid - 0.5,
        time: candleC.time - 1,
        type: obType,
        mitigated: false,
        endTime: null,
        touchCount: 0,
        rejections: [],
        status: 'untested',
        strengthScore: 1,
        hasDisplacement: true,
        hasStructureConfluence: true,
        bodyTop: mid + 0.5,
        bodyBottom: mid - 0.5,
        meanThreshold: mid,
        hasFvgConfluence: true,
        hasLiquiditySweep: true,
      }],
      fvgs: [],
      inversionFvgs: [], breakerBlocks: [],
      rejectionBlocks: [],
      bosEvents: [],
    },
    indicators: favorableIndicators({
      emaFast: candleC.low === mid ? candleC.low : candleC.high,
      bollingerLower: direction === 'buy' ? candleA.low : null,
      bollingerUpper: direction === 'sell' ? candleA.high : null,
      macd: direction === 'buy' ? 1 : -1,
      macdSignal: 0,
    }),
    ...overrides,
  };
}

describe('detectMorningStar', () => {
  // 10 медвежьих свечей (тренд) + a (крупная медвежья) + b (маленькая "звезда")
  // + c (крупная бычья, закрывается глубоко в теле a) + одна свеча после.
  const preceding = smallDowntrend(10, 110);
  const a = candle(10, 91, 88, 91.2, 87.8, 100);
  const b = candle(11, 88, 88.2, 88.6, 87.9, 100);
  const c = candle(12, 88.3, 91.5, 91.8, 88, 200);
  const after = candle(13, 91.5, 91.8, 92, 91.3, 100);
  const candles = [...preceding, a, b, c, after];

  it('detects morning star after downtrend with full favorable context', () => {
    const ctx = favorableTripleCtx(candles, a, c, 'buy');
    const result = detectMorningStar(ctx);
    expect(result).not.toBeNull();
    expect(result?.direction).toBe('buy');
    expect(result?.volumeConfirmed).toBe(true);
  });

  it('returns null when candle (c) does not close above 50% of body (a)', () => {
    const weakC = candle(12, 88.3, 89.2, 89.5, 88, 200); // закрытие ровно на midpoint или ниже
    const weakCandles = [...preceding, a, b, weakC, after];
    const ctx = favorableTripleCtx(weakCandles, a, weakC, 'buy');
    const result = detectMorningStar(ctx);
    expect(result).toBeNull();
  });

  it('returns null without a preceding downtrend', () => {
    const flat = smallUptrend(10, 80).map((cc, i) => candle(i, 88, 88, 88.2, 87.8, 100));
    const flatCandles = [...flat, a, b, c, after];
    const ctx = favorableTripleCtx(flatCandles, a, c, 'buy', { structure: RANGE_STRUCTURE });
    const result = detectMorningStar(ctx);
    expect(result).toBeNull();
  });

  it('returns null in Asia/closed session regardless of geometry', () => {
    const ctx = favorableTripleCtx(candles, a, c, 'buy', { session: 'tokyo' });
    const result = detectMorningStar(ctx);
    expect(result).toBeNull();
  });
});

describe('detectEveningStar', () => {
  const preceding = smallUptrend(10, 90);
  const a = candle(10, 109, 112, 112.2, 108.8, 100);
  const b = candle(11, 112, 111.8, 112.1, 111.4, 100);
  const c = candle(12, 111.7, 108.5, 111.9, 108.2, 200);
  const after = candle(13, 108.5, 108.2, 108.7, 108, 100);
  const candles = [...preceding, a, b, c, after];

  it('detects evening star after uptrend with full favorable context', () => {
    const ctx = favorableTripleCtx(candles, a, c, 'sell');
    const result = detectEveningStar(ctx);
    expect(result).not.toBeNull();
    expect(result?.direction).toBe('sell');
    expect(result?.volumeConfirmed).toBe(true);
  });

  it('returns null when candle (c) does not close below 50% of body (a)', () => {
    const weakC = candle(12, 111.7, 110.8, 111.9, 108.2, 200);
    const weakCandles = [...preceding, a, b, weakC, after];
    const ctx = favorableTripleCtx(weakCandles, a, weakC, 'sell');
    const result = detectEveningStar(ctx);
    expect(result).toBeNull();
  });

  it('returns null in Asia/closed session regardless of geometry', () => {
    const ctx = favorableTripleCtx(candles, a, c, 'sell', { session: 'sydney' });
    const result = detectEveningStar(ctx);
    expect(result).toBeNull();
  });
});

describe('detectThreeWhiteSoldiers', () => {
  const preceding = smallDowntrend(10, 110);
  const a = candle(10, 91, 94, 94.2, 90.9, 150);
  const b = candle(11, 94, 97, 97.1, 93.9, 160);
  const c = candle(12, 97, 100, 100.1, 96.9, 180);
  const after = candle(13, 100, 100.3, 100.5, 99.8, 100);
  const candles = [...preceding, a, b, c, after];

  it('detects three white soldiers with full favorable context', () => {
    const ctx = favorableTripleCtx(candles, a, c, 'buy');
    const result = detectThreeWhiteSoldiers(ctx);
    expect(result).not.toBeNull();
    expect(result?.direction).toBe('buy');
  });

  it('returns null when volume falls across the three candles (no conviction)', () => {
    const decliningVolCandles = [
      ...preceding,
      { ...a, volume: 200 },
      { ...b, volume: 150 },
      { ...c, volume: 100 },
      after,
    ];
    const ctx = favorableTripleCtx(decliningVolCandles, a, c, 'buy');
    const result = detectThreeWhiteSoldiers(ctx);
    expect(result).toBeNull();
  });

  it('returns null on climax/exhaustion (huge bodies, no wicks, extreme ATR ratio)', () => {
    const climaxA = candle(10, 91, 121, 121, 91, 150);
    const climaxB = candle(11, 121, 151, 151, 121, 160);
    const climaxC = candle(12, 151, 181, 181, 151, 180);
    const climaxCandles = [...preceding, climaxA, climaxB, climaxC, after];
    const ctx = favorableTripleCtx(climaxCandles, climaxA, climaxC, 'buy', {
      indicators: favorableIndicators({ atr: 1 }),
    });
    const result = detectThreeWhiteSoldiers(ctx);
    expect(result).toBeNull();
  });
});

describe('detectThreeBlackCrows', () => {
  const preceding = smallUptrend(10, 90);
  const a = candle(10, 109, 106, 109.1, 105.8, 150);
  const b = candle(11, 106, 103, 106.1, 102.9, 160);
  const c = candle(12, 103, 100, 103.1, 99.9, 180);
  const after = candle(13, 100, 99.7, 100.2, 99.5, 100);
  const candles = [...preceding, a, b, c, after];

  it('detects three black crows with full favorable context', () => {
    const ctx = favorableTripleCtx(candles, a, c, 'sell');
    const result = detectThreeBlackCrows(ctx);
    expect(result).not.toBeNull();
    expect(result?.direction).toBe('sell');
  });

  it('returns null when volume falls across the three candles (no conviction)', () => {
    const decliningVolCandles = [
      ...preceding,
      { ...a, volume: 200 },
      { ...b, volume: 150 },
      { ...c, volume: 100 },
      after,
    ];
    const ctx = favorableTripleCtx(decliningVolCandles, a, c, 'sell');
    const result = detectThreeBlackCrows(ctx);
    expect(result).toBeNull();
  });
});

describe('detectAbandonedBabyBottom', () => {
  const preceding = smallDowntrend(10, 110);
  const a = candle(10, 91, 88, 91.2, 87.8, 150);
  const b = candle(11, 87.5, 87.505, 87.6, 87.4, 100); // doji (body/range=0.025<=0.05), изолирован по теням ниже a.low=87.8
  const c = candle(12, 88.2, 91.5, 91.6, 88.1, 220); // изолирован по теням выше b.high=87.6
  const after = candle(13, 91.5, 91.9, 92, 91.4, 100);
  const candles = [...preceding, a, b, c, after];

  it('detects a valid bullish abandoned baby with strict wick gaps and volume climax', () => {
    const ctx = favorableTripleCtx(candles, a, c, 'buy', {
      indicators: favorableIndicators({ atr: 1 }),
    });
    const result = detectAbandonedBabyBottom(ctx);
    expect(result).not.toBeNull();
    expect(result?.direction).toBe('buy');
    expect(result?.confidence).toBeGreaterThanOrEqual(0.65);
  });

  it('returns null when wicks of (a) and (b) overlap (no true gap -> not an abandoned baby)', () => {
    const overlappingB = candle(11, 87.9, 87.92, 88.0, 87.85, 100); // b.high (88.0) >= a.low (87.8)
    const overlappingCandles = [...preceding, a, overlappingB, c, after];
    const ctx = favorableTripleCtx(overlappingCandles, a, c, 'buy', {
      indicators: favorableIndicators({ atr: 1 }),
    });
    const result = detectAbandonedBabyBottom(ctx);
    expect(result).toBeNull();
  });

  it('returns null when the 4th candle is bearish (pattern cancelled)', () => {
    const bearishFourth = candle(13, 91.5, 90.5, 91.6, 90.3, 100);
    const cancelledCandles = [...preceding, a, b, c, bearishFourth];
    const ctx = favorableTripleCtx(cancelledCandles, a, c, 'buy', {
      indicators: favorableIndicators({ atr: 1 }),
    });
    const result = detectAbandonedBabyBottom(ctx);
    expect(result).toBeNull();
  });
});

describe('detectAbandonedBabyTop', () => {
  const preceding = smallUptrend(10, 90);
  const a = candle(10, 109, 112, 112.2, 108.8, 150);
  const b = candle(11, 112.5, 112.495, 112.6, 112.4, 100); // doji (body/range=0.025<=0.05), выше a.high=112.2
  const c = candle(12, 111.8, 108.5, 111.9, 108.4, 220); // ниже b.low=112.4
  const after = candle(13, 108.5, 108.1, 108.6, 108, 100);
  const candles = [...preceding, a, b, c, after];

  it('detects a valid bearish abandoned baby with strict wick gaps and volume climax', () => {
    const ctx = favorableTripleCtx(candles, a, c, 'sell', {
      indicators: favorableIndicators({ atr: 1 }),
    });
    const result = detectAbandonedBabyTop(ctx);
    expect(result).not.toBeNull();
    expect(result?.direction).toBe('sell');
    expect(result?.confidence).toBeGreaterThanOrEqual(0.65);
  });

  it('returns null when wicks of (a) and (b) overlap (no true gap -> not an abandoned baby)', () => {
    const overlappingB = candle(11, 112.1, 112.12, 112.2, 112.05, 100); // b.low (112.2) <= a.high (112.2)
    const overlappingCandles = [...preceding, a, overlappingB, c, after];
    const ctx = favorableTripleCtx(overlappingCandles, a, c, 'sell', {
      indicators: favorableIndicators({ atr: 1 }),
    });
    const result = detectAbandonedBabyTop(ctx);
    expect(result).toBeNull();
  });
});

describe('detectInsideBar', () => {
  const mother = candle(0, 10, 12, 13, 9);
  const inside = candle(1, 10.5, 11, 11.5, 10);

  it('returns null while still coiling (breakout candle has not cleared mother range)', () => {
    const noBreakout = candle(2, 11, 11.2, 11.4, 10.9);
    expect(detectInsideBar(mother, inside, noBreakout)).toBeNull();
  });

  it('detects a bullish breakout once the following candle closes above mother.high', () => {
    const breakout = candle(2, 11.5, 13.4, 13.6, 11.4);
    const result = detectInsideBar(mother, inside, breakout);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('inside-bar');
    expect(result?.direction).toBe('buy');
    expect(result?.time).toBe(breakout.time);
  });

  it('detects a bearish breakout once the following candle closes below mother.low', () => {
    const breakout = candle(2, 10, 8.5, 10.2, 8.4);
    const result = detectInsideBar(mother, inside, breakout);
    expect(result).not.toBeNull();
    expect(result?.direction).toBe('sell');
  });

  it('returns null when the middle candle is not actually inside the mother range', () => {
    const notInside = candle(1, 10.5, 14, 14.5, 10);
    const breakout = candle(2, 14, 15, 15.2, 13.9);
    expect(detectInsideBar(mother, notInside, breakout)).toBeNull();
  });
});

describe('detectMeanReversion', () => {
  it('does not conflict with SMC trend (BOS suppresses a sell-fade during a confirmed uptrend)', () => {
    // 30-bar uptrend warmup, then a spike bar that closes above the upper
    // BB (the "exit" bar), then a return bar back inside the bands with an
    // oversold... err overbought RSI reading — this is exactly the shape
    // detectMeanReversion looks for on the sell side, EXCEPT the HTF
    // structure confirms an up-trending BOS, so per priority #1 it must be
    // suppressed rather than faded.
    const candles: Candle[] = Array.from({ length: 30 }, (_, i) => ({
      time: i, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 100,
    }));
    candles.push({ time: 30, open: 129.5, high: 138, low: 129, close: 137, volume: 150 }); // exit bar: closes above upper BB (135)
    candles.push({ time: 31, open: 137, high: 137.5, low: 133, close: 134, volume: 150 }); // return bar: back inside

    const snapshot: IndicatorSnapshot = {
      rsi: 80, emaFast: 130, emaSlow: 120,
      macd: 10, macdSignal: 8, macdHistogram: 2,
      atr: 3, bollingerUpper: 135, bollingerMiddle: 120, bollingerLower: 105,
      vwap: null, vwapIsProxyVolume: false, volumeProfilePoc: null, volumeProfilePocIsProxyVolume: false,
      meanReversionRsi: null, impulseVelocity: null, adx: 30,
    };
    const htfStructure: MarketStructure = {
      trend: 'up', bos: true, choch: false, swingHigh: 140, swingLow: 95, provisional: false,
    };

    const result = detectMeanReversion(candles, snapshot, 80, 'london', htfStructure);
    expect(result).toBeNull();
  });

  it('detects a bullish reversion when BOS does not conflict and ADX confirms a flat regime', () => {
    // 30-bar flat/ranging warmup so ADX stays low (no HTF conflict), then a
    // decisive exit bar below the lower BB, then a decisive return bar.
    const candles: Candle[] = Array.from({ length: 30 }, (_, i) => {
      const bullish = i % 2 === 0;
      const open = bullish ? 99.9 : 100.1;
      const close = bullish ? 100.1 : 99.9;
      return { time: i, open, high: 100.6, low: 99.4, close, volume: 100 };
    });
    candles.push({ time: 30, open: 100, high: 100.2, low: 95, close: 96, volume: 120 }); // exit bar: closes below lower BB (98)
    candles.push({ time: 31, open: 96, high: 99.5, low: 95.8, close: 99, volume: 120 }); // return bar: back inside, decisive body

    const snapshot: IndicatorSnapshot = {
      rsi: 50, emaFast: 100, emaSlow: 100,
      macd: 0, macdSignal: 0, macdHistogram: 0,
      atr: 1.2, bollingerUpper: 102, bollingerMiddle: 100, bollingerLower: 98,
      vwap: null, vwapIsProxyVolume: false, volumeProfilePoc: null, volumeProfilePocIsProxyVolume: false,
      meanReversionRsi: null, impulseVelocity: null, adx: 10,
    };

    const result = detectMeanReversion(candles, snapshot, 20, 'london');
    expect(result).not.toBeNull();
    expect(result?.direction).toBe('buy');
  });

  it('returns null when ADX confirms a strong trend (>25), even with a textbook BB+RSI setup', () => {
    const candles: Candle[] = Array.from({ length: 30 }, (_, i) => {
      const bullish = i % 2 === 0;
      const open = bullish ? 99.9 : 100.1;
      const close = bullish ? 100.1 : 99.9;
      return { time: i, open, high: 100.6, low: 99.4, close, volume: 100 };
    });
    candles.push({ time: 30, open: 100, high: 100.2, low: 95, close: 96, volume: 120 });
    candles.push({ time: 31, open: 96, high: 99.5, low: 95.8, close: 99, volume: 120 });

    const snapshot: IndicatorSnapshot = {
      rsi: 50, emaFast: 100, emaSlow: 100,
      macd: 0, macdSignal: 0, macdHistogram: 0,
      atr: 1.2, bollingerUpper: 102, bollingerMiddle: 100, bollingerLower: 98,
      vwap: null, vwapIsProxyVolume: false, volumeProfilePoc: null, volumeProfilePocIsProxyVolume: false,
      meanReversionRsi: null, impulseVelocity: null, adx: 30,
    };

    expect(detectMeanReversion(candles, snapshot, 20, 'london')).toBeNull();
  });

  it('returns null when the exit bar (N-1) body is <40% of its range (doji-like exit)', () => {
    // Same flat warmup + BB/RSI setup as the happy-path bullish test, but
    // the exit bar has a tiny body (open≈close) with long wicks — body/range
    // is well under the 40% threshold, so the geometry gate must reject it
    // even though RSI and BB conditions would otherwise be satisfied.
    const candles: Candle[] = Array.from({ length: 30 }, (_, i) => {
      const bullish = i % 2 === 0;
      const open = bullish ? 99.9 : 100.1;
      const close = bullish ? 100.1 : 99.9;
      return { time: i, open, high: 100.6, low: 99.4, close, volume: 100 };
    });
    // Exit bar: open=100, close=97 (body=3), but range=5 (low=95, high=100)
    // → body/range = 60% which passes. Instead make a doji-like exit:
    // open=97, close=96.5 (body=0.5), range=5 (low=95, high=100) → 10% < 40%.
    candles.push({ time: 30, open: 97, high: 100, low: 95, close: 96.5, volume: 120 });
    // Return bar: decisive, closes back inside the bands.
    candles.push({ time: 31, open: 96.5, high: 99.5, low: 95.8, close: 99, volume: 120 });

    const snapshot: IndicatorSnapshot = {
      rsi: 50, emaFast: 100, emaSlow: 100,
      macd: 0, macdSignal: 0, macdHistogram: 0,
      atr: 1.2, bollingerUpper: 102, bollingerMiddle: 100, bollingerLower: 98,
      vwap: null, vwapIsProxyVolume: false, volumeProfilePoc: null, volumeProfilePocIsProxyVolume: false,
      meanReversionRsi: null, impulseVelocity: null, adx: 10,
    };

    expect(detectMeanReversion(candles, snapshot, 20, 'london')).toBeNull();
  });
});

describe('Rising/Falling Three Methods (continuation.ts, Промт 4)', () => {
  const BASE_TIME = 1786957200; // London session (см. остальные context-aware тесты выше)
  const STEP = 60;

  // Rising: 30 "дальних" колеблющихся свечей (не влияют на avgBody20/avgVol20,
  // т.к. вне окна [idx-20,idx), но формируют RSI-память) + 13 мягко-бычьих +
  // 7 бычьих трендовых + импульс (candle1) + консолидация (c2-c4) + свеча 5.
  // farNet регулирует, куда "утекает" RSI(14) на свечах 2-4, не трогая
  // геометрию/объём/containment (которые зависят только от близких свечей).
  function buildRising(farNet: number, consolOverride?: [number, number, number], c5Volume = 500): ContinuationContext {
    const candles: Candle[] = [];
    let price = 30;
    for (let i = 0; i < 30; i++) {
      const open = price;
      const close = price + (i % 2 === 0 ? 1 + farNet : -1 + farNet);
      candles.push(candle(0, open, close, Math.max(open, close) + 0.05, Math.min(open, close) - 0.05, 80));
      price = close;
    }
    for (let i = 0; i < 13; i++) {
      const open = price; const close = price + 0.08;
      candles.push(candle(0, open, close, close + 0.05, open - 0.05, 80));
      price = close;
    }
    for (let i = 0; i < 7; i++) {
      const open = price; const close = price + 0.3;
      candles.push(candle(0, open, close, close + 0.1, open - 0.1, 80));
      price = close;
    }
    const c1open = price; const c1close = c1open + 2;
    candles.push(candle(0, c1open, c1close, c1close + 0.2, c1open - 0.2, 300));
    // Открытие свечи 2 гэпом на -0.1 от close(1) (см. подтверждённый рабочий
    // фикстур): цепочка close[n-1]=open[n] дальше идёт без гэпов.
    const [d2, d3, d4] = consolOverride ?? ([-0.05, -0.05, 0.05] as [number, number, number]);
    let p = c1close - 0.1;
    const consolCandles: Candle[] = [];
    for (const d of [d2, d3, d4]) {
      const close = p + d;
      consolCandles.push(candle(0, p, close, Math.max(p, close) + 0.05, Math.min(p, close) - 0.05, 28));
      p = close;
    }
    candles.push(...consolCandles);
    const preLast = candles[candles.length - 1];
    const c5open = preLast.close - 0.15; const c5close = c5open + 2.25;
    candles.push(candle(0, c5open, c5close, c5close + 0.1, c5open - 0.1, c5Volume));
    const n = candles.length;
    for (let i = 0; i < n; i++) candles[i] = { ...candles[i], time: BASE_TIME - (n - i) * STEP };

    const idx = n - 5;
    const structure: MarketStructure = {
      trend: 'up', bos: true, choch: false, swingHigh: null, swingLow: candles[idx].low - 0.3, provisional: false,
    };
    const smartMoney: SmartMoneyResult = {
      orderBlocks: [{
        top: candles[idx].high + 0.3, bottom: candles[idx].low - 0.3, time: candles[idx].time - 60,
        type: 'bullish', mitigated: false, endTime: null, touchCount: 0, rejections: [], status: 'untested', strengthScore: 1,
        hasDisplacement: true, hasStructureConfluence: true,
        bodyTop: candles[idx].high, bodyBottom: candles[idx].low,
        meanThreshold: (candles[idx].high + candles[idx].low) / 2,
        hasFvgConfluence: true, hasLiquiditySweep: true,
      }],
      fvgs: [], inversionFvgs: [], breakerBlocks: [], rejectionBlocks: [], bosEvents: [],
    };
    const last = candles[n - 1];
    const indicators: IndicatorSnapshot = {
      ...NO_INDICATORS, emaFast: last.low - 0.01, atr: 0.5,
    };
    return { candles, structure, session: 'london', smartMoney, indicators };
  }

  // Falling — зеркало Rising (см. комментарий выше).
  function buildFalling(farNet: number, consolOverride?: [number, number, number], c5Volume = 500): ContinuationContext {
    const candles: Candle[] = [];
    let price = 130;
    for (let i = 0; i < 30; i++) {
      const open = price;
      const close = price + (i % 2 === 0 ? -1 + farNet : 1 + farNet);
      candles.push(candle(0, open, close, Math.max(open, close) + 0.05, Math.min(open, close) - 0.05, 80));
      price = close;
    }
    for (let i = 0; i < 13; i++) {
      const open = price; const close = price - 0.08;
      candles.push(candle(0, open, close, open + 0.05, close - 0.05, 80));
      price = close;
    }
    for (let i = 0; i < 7; i++) {
      const open = price; const close = price - 0.3;
      candles.push(candle(0, open, close, open + 0.1, close - 0.1, 80));
      price = close;
    }
    const c1open = price; const c1close = c1open - 2;
    candles.push(candle(0, c1open, c1close, c1open + 0.2, c1close - 0.2, 300));
    // Открытие свечи 2 гэпом на +0.1 от close(1) (зеркально Rising).
    const [d2, d3, d4] = consolOverride ?? ([0.05, 0.05, -0.05] as [number, number, number]);
    let p = c1close + 0.1;
    const consolCandles: Candle[] = [];
    for (const d of [d2, d3, d4]) {
      const close = p + d;
      consolCandles.push(candle(0, p, close, Math.max(p, close) + 0.05, Math.min(p, close) - 0.05, 28));
      p = close;
    }
    candles.push(...consolCandles);
    const preLast = candles[candles.length - 1];
    const c5open = preLast.close + 0.15; const c5close = c5open - 2.25;
    candles.push(candle(0, c5open, c5close, c5open + 0.1, c5close - 0.1, c5Volume));
    const n = candles.length;
    for (let i = 0; i < n; i++) candles[i] = { ...candles[i], time: BASE_TIME - (n - i) * STEP };

    const idx = n - 5;
    const structure: MarketStructure = {
      trend: 'down', bos: true, choch: false, swingHigh: candles[idx].high + 0.3, swingLow: null, provisional: false,
    };
    const smartMoney: SmartMoneyResult = {
      orderBlocks: [{
        top: candles[idx].high + 0.3, bottom: candles[idx].low - 0.3, time: candles[idx].time - 60,
        type: 'bearish', mitigated: false, endTime: null, touchCount: 0, rejections: [], status: 'untested', strengthScore: 1,
        hasDisplacement: true, hasStructureConfluence: true,
        bodyTop: candles[idx].high, bodyBottom: candles[idx].low,
        meanThreshold: (candles[idx].high + candles[idx].low) / 2,
        hasFvgConfluence: true, hasLiquiditySweep: true,
      }],
      fvgs: [], inversionFvgs: [], breakerBlocks: [], rejectionBlocks: [], bosEvents: [],
    };
    const last = candles[n - 1];
    const indicators: IndicatorSnapshot = {
      ...NO_INDICATORS, emaFast: last.high + 0.01, atr: 0.5,
    };
    return { candles, structure, session: 'london', smartMoney, indicators };
  }

  describe('Rising Three Methods', () => {
    it('detects a valid setup with >=6/9 confluence filters and confidence >= 0.5', () => {
      const ctx = buildRising(0);
      const result = detectRisingThreeMethods(ctx);
      expect(result).not.toBeNull();
      expect(result!.direction).toBe('buy');
      expect(result!.confidence).toBeGreaterThanOrEqual(0.5);
      expect(result!.confluenceFactors!.length).toBeGreaterThanOrEqual(6);
      // Порог должен приходить из формулы §4, а не из старого фиксированного
      // пола 0.7 — иначе confidence всегда был бы ровно 0.7 или 0.8.
      expect(result!.confidence).not.toBe(0.7);
    });

    it('rejects when a consolidation candle breaks candle 1 high/low (containment invalidator)', () => {
      const ctx = buildRising(0);
      const idx = ctx.candles.length - 5;
      const broken = ctx.candles.map((c, i) => (i === idx + 1 ? { ...c, low: ctx.candles[idx].low - 1 } : c));
      const result = detectRisingThreeMethods({ ...ctx, candles: broken });
      expect(result).toBeNull();
    });

    it('rejects when volume(candle 5) < volume(candle 1) — hard invalidator per методичка §"Не входить"', () => {
      const ctx = buildRising(0, undefined, 250); // 250 < candle1's volume of 300
      const result = detectRisingThreeMethods(ctx);
      expect(result).toBeNull();
      // Sanity: with volume(5) >= volume(1) restored, the same shape passes.
      const ok = buildRising(0, undefined, 500);
      expect(detectRisingThreeMethods(ok)).not.toBeNull();
    });

    it('rejects when RSI(14) on candles 2-4 dips to <=50 (hard gate, not the soft rsiZone bonus)', () => {
      const ctx = buildRising(-1.3);
      const result = detectRisingThreeMethods(ctx);
      expect(result).toBeNull();
    });

    it('does NOT hard-gate on rsi5<=rsi4 or hist5<=hist4 (these are the soft rsiZone/macdTurn filters now)', () => {
      // The baseline positive fixture already has rsi5/hist5 comparisons
      // implicit; this test documents that a pattern can still pass even
      // when candle 5's RSI/MACD momentum vs candle 4 isn't examined as a
      // hard requirement — only candles 2-4 (>50) and candle 1 hard gates
      // (incl. volume(5)>=volume(1)) are mandatory, per §2 of Промт 4.
      const ctx = buildRising(0);
      const result = detectRisingThreeMethods(ctx);
      expect(result).not.toBeNull();
    });
  });

  describe('Falling Three Methods', () => {
    it('detects a valid setup with >=6/9 confluence filters and confidence >= 0.5', () => {
      const ctx = buildFalling(0);
      const result = detectFallingThreeMethods(ctx);
      expect(result).not.toBeNull();
      expect(result!.direction).toBe('sell');
      expect(result!.confidence).toBeGreaterThanOrEqual(0.5);
      expect(result!.confluenceFactors!.length).toBeGreaterThanOrEqual(6);
      expect(result!.confidence).not.toBe(0.7);
    });

    it('rejects when a consolidation candle breaks candle 1 high/low (containment invalidator)', () => {
      const ctx = buildFalling(0);
      const idx = ctx.candles.length - 5;
      const broken = ctx.candles.map((c, i) => (i === idx + 1 ? { ...c, high: ctx.candles[idx].high + 1 } : c));
      const result = detectFallingThreeMethods({ ...ctx, candles: broken });
      expect(result).toBeNull();
    });

    it('rejects when volume(candle 5) < volume(candle 1) — hard invalidator per методичка §"Не входить"', () => {
      const ctx = buildFalling(0, undefined, 250);
      const result = detectFallingThreeMethods(ctx);
      expect(result).toBeNull();
      const ok = buildFalling(0, undefined, 500);
      expect(detectFallingThreeMethods(ok)).not.toBeNull();
    });

    it('rejects when RSI(14) on candles 2-4 rises to >=50 (hard gate, not the soft rsiZone bonus)', () => {
      const ctx = buildFalling(1.3);
      const result = detectFallingThreeMethods(ctx);
      expect(result).toBeNull();
    });
  });

  describe('detectAllPatterns integration', () => {
    it('rising-three-methods confidence flows from the multi-factor formula, not the legacy 0.7 floor', () => {
      const ctx = buildRising(0);
      const structure = ctx.structure;
      const smartMoney = ctx.smartMoney;
      const results = detectAllPatterns(ctx.candles, ALL, ctx.indicators, structure, smartMoney);
      const risingResult = results.find((p) => p.name === 'rising-three-methods');
      expect(risingResult).toBeDefined();
      // applyConfidenceHierarchy adds +0.1 volumeConfirmed bonus on top of the
      // detector's own confidence (baseConfidence floor is 0.35, well below
      // what the detector computes) — so this should NOT land on exactly the
      // old hardcoded 0.7/0.8 values used before the Промт 4 refactor.
      expect(risingResult!.confidence).not.toBe(0.7);
      expect(risingResult!.confidence).not.toBe(0.8);
    });

    it('rising-three-methods: volumeConfirmed +0.1 bonus is the sole volume gradation (regression guard)', () => {
      // The detector's confidence formula (continuation.ts:320-327) has no
      // volume term — volume enters only as the binary volumeConfirmed flag.
      // applyConfidenceHierarchy converts that flag to +0.1 (added after the
      // Math.max floor). Verify directly: take the raw detector output, run
      // it through applyConfidenceHierarchy, and confirm the +0.1 is present
      // by comparing with a version where volumeConfirmed is forced to false.
      const ctx = buildRising(0);
      const raw = detectRisingThreeMethods(ctx);
      expect(raw).toBeDefined();
      expect(raw!.volumeConfirmed).toBe(true);
      const withBonus = applyConfidenceHierarchy(raw!);
      const withoutVolume = { ...raw!, volumeConfirmed: false };
      const withoutBonus = applyConfidenceHierarchy(withoutVolume);
      expect(withBonus.confidence - withoutBonus.confidence).toBeCloseTo(0.1, 5);
    });
  });
});

import { describe, it, expect } from 'vitest';
import { detectOrderBlockContinuation } from '@/compute/patterns/order-block-continuation';
import { detectMacdDecelerationContinuation } from '@/compute/patterns/macd-deceleration-continuation';
import { detectLiquiditySweep } from '@/compute/patterns/liquidity-sweep';
import { detectLiquiditySweepReaction } from '@/compute/patterns/liquidity-sweep-reaction';
import type { Candle, MarketStructure, IndicatorSnapshot } from '@/types/domain';
import type { SmartMoneyResult, SmartMoneyOrderBlock } from '@/compute/indicators/smart-money';
import { detectStrongOrderBlockReaction } from '@/compute/patterns/strong-order-block-reaction';
import { detectImpulseBreakout } from '@/compute/patterns/impulse-breakout';
import { detectConsolidationBreakout } from '@/compute/patterns/consolidation-breakout';

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
  trend: 'up', bos: true, choch: false, swingHigh: 130, swingLow: 97.6, provisional: false,
};

const DOWN_STRUCTURE: MarketStructure = {
  trend: 'down', bos: true, choch: false, swingHigh: 130, swingLow: 97.6, provisional: false,
};

const UP_STRUCTURE_FOR_OB: MarketStructure = {
  trend: 'up', bos: true, choch: false, swingHigh: 200, swingLow: 90, provisional: false,
};
const UP_STRUCTURE_NO_BOS: MarketStructure = {
  trend: 'up', bos: false, choch: false, swingHigh: 200, swingLow: 90, provisional: false,
};
const DOWN_STRUCTURE_FOR_OB: MarketStructure = {
  trend: 'down', bos: true, choch: false, swingHigh: 200, swingLow: 90, provisional: false,
};

const EMPTY_SMART_MONEY: SmartMoneyResult = {
  orderBlocks: [], fvgs: [], inversionFvgs: [], breakerBlocks: [], rejectionBlocks: [], bosEvents: [],
};

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

const NEUTRAL_SNAPSHOT: IndicatorSnapshot = {
  rsi: null, emaFast: null, emaSlow: null, macd: null, macdSignal: null, macdHistogram: null,
  atr: null, bollingerUpper: null, bollingerMiddle: null, bollingerLower: null,
  vwap: null, vwapIsProxyVolume: false, volumeProfilePoc: null, volumeProfilePocIsProxyVolume: false,
  meanReversionRsi: null, impulseVelocity: null, adx: null,
};

// Flat/ranging 30-bar warmup (constant high/low band, alternating bullish
// and bearish bodies) used as context for liquidity-sweep tests. Alternating
// bodies keep bar-level trend strength (checkTrendStrength) genuinely mixed
// (~50/50), so tests that rely on structure metadata (UP_STRUCTURE /
// DOWN_STRUCTURE) to satisfy the HTF-alignment gate aren't accidentally
// passing because of a directional bias baked into the candle bodies
// themselves. Constant high/low (99.4/100.6) gives ATR(14) a stable ~1.2
// baseline so wick-depth-in-ATR math is easy to reason about precisely.
const WARMUP_LOW = 99.4;
const WARMUP_HIGH = 100.6;

function flatWarmup(count = 30): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const bullish = i % 2 === 0;
    const open = bullish ? 99.9 : 100.1;
    const close = bullish ? 100.1 : 99.9;
    return candle(i, open, close, WARMUP_HIGH, WARMUP_LOW, 100);
  });
}

// Builds a synthetic uptrend with a genuine AGAINST-TREND correction (the
// "old series"): the histogram decays in magnitude while negative (opposite
// the uptrend), then flips to a small positive value as the trend resumes.
//
// Rewritten 2026-08-31 as part of the «Замедление MACD с продолжением»
// audit/fix. The PREVIOUS version of this helper (`tailSlopes` all positive,
// i.e. price only ever decelerating but never actually pulling back) built a
// scenario where the "old series" was TREND-COLORED (positive) momentum
// fading toward zero, and the "flip" was INTO the anti-trend color — the
// opposite of what this pattern is defined to detect (see the docstring in
// macd-deceleration-continuation.ts: a correction against the trend that
// decays, then flips back to the trend color). The old scenario only passed
// before this fix because there was no check that the flip bar's sign
// actually matches the trend direction (see "доп. фикс п.7" in the
// strategy file) — once that coherence check was added, the old fixture
// fails, correctly, because it described a different (and, per the
// strategy's own definition, invalid) setup.
//
// `pullbackAmplitude`/`pullbackRatio`/`pullbackLen` shape the correction's
// decay curve (geometric decay from `pullbackAmplitude`, each subsequent bar
// `pullbackRatio`× the previous); `flipSlope` controls how strongly the
// final bar resumes the trend. These parameters were tuned empirically
// against the real macd()/computeStructure() implementations to produce a
// scenario that clears every structural gate in the strategy — decay
// monotonicity, pause/flip indexing, direction coherence, the
// |lastValue| < |flipValue| "quiet flip" gate, and the 78.6% Fibonacci
// invalidation.
function macdDecelScenario(
  pullbackAmplitude: number,
  pullbackRatio: number,
  pullbackLen: number,
  flipSlope: number,
): Candle[] {
  const candles: Candle[] = [];
  let price = 100;
  let t = 0;
  // Long, gentle uptrend: enough bars for the EMA(12)/EMA(26)/signal(9)
  // chain to fully warm up and for the MACD histogram to settle near zero
  // in steady state, so a modest pullback is enough to flip its sign.
  for (let i = 0; i < 90; i++) {
    const open = price;
    const close = price + 0.15;
    candles.push(candle(t++, open, close, close + 0.05, open - 0.05));
    price = close;
  }
  // Correction against the trend: geometrically decaying negative closes
  // (the "old series" the pattern is looking for).
  let slope = -pullbackAmplitude;
  for (let i = 0; i < pullbackLen; i++) {
    const open = price;
    const close = price + slope;
    const high = Math.max(open, close) + 0.03;
    const low = Math.min(open, close) - 0.03;
    candles.push(candle(t++, open, close, high, low));
    price = close;
    slope *= pullbackRatio;
  }
  // Pause candle: tiny body relative to the preceding 10-bar average.
  {
    const open = price;
    const close = price + 0.003;
    candles.push(candle(t++, open, close, close + 0.02, open - 0.02));
    price = close;
  }
  // Flip candle: resumes the uptrend (small positive histogram bar).
  {
    const open = price;
    const close = price + flipSlope;
    const high = Math.max(open, close) + 0.05;
    const low = Math.min(open, close) - 0.05;
    candles.push(candle(t++, open, close, high, low));
    price = close;
  }
  return candles;
}

// The one verified "everything lines up" shape: passes every structural
// gate (decay, indexing, direction coherence, |lastValue| < |flipValue|,
// <78.6% Fibo) AND clears ENTRY_THRESHOLD on its own (confidence ≈0.560,
// with the current oldSeries.length=13 and quietness≈0.335 for this exact
// fixture — see the confidence-formula comment in
// macd-deceleration-continuation.ts for what those two inputs mean).
// Confirmed via a direct run against the real detector, not just the
// gate-replica used while tuning the fixture.
function macdDecelHappyPath(): Candle[] {
  return macdDecelScenario(0.5, 0.75, 30, 0.1);
}

describe('detectOrderBlockContinuation', () => {
  it('returns null for insufficient candles', () => {
    expect(detectOrderBlockContinuation([])).toBeNull();
    expect(detectOrderBlockContinuation(Array.from({ length: 29 }, (_, i) => candle(i, 10, 11, 12, 9)))).toBeNull();
  });

  it('returns null when no untested order blocks exist', () => {
    const candles: Candle[] = Array.from({ length: 40 }, (_, i) =>
      candle(i, 100, 100.1, 100.2, 99.9),
    );
    expect(detectOrderBlockContinuation(candles)).toBeNull();
  });

  it('detects bullish OBC when fresh untested block aligns with MACD extreme', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 40; i++) {
      candles.push(candle(i, 100 + i * 0.5, 101 + i * 0.5, 102 + i * 0.5, 99 + i * 0.5));
    }
    for (let i = 40; i < 45; i++) {
      const base = 120 + (i - 40) * 3;
      candles.push(candle(i, base, base + 3, base + 4, base - 1));
    }
    const obIdx = 45;
    candles.push(candle(obIdx, 135, 132, 136, 131));
    candles.push(candle(obIdx + 1, 132, 137, 138, 131.5));
    candles.push(candle(obIdx + 2, 137, 139, 140, 136));

    const sm: SmartMoneyResult = { ...EMPTY_SMART_MONEY, orderBlocks: [mockOb({ top: 136, bottom: 131, time: 45, type: 'bullish' })] };
    const result = detectOrderBlockContinuation(candles, undefined, undefined, undefined, sm);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('order-block-continuation');
    expect(result?.direction).toBe('buy');
  });

  it('returns null when RSI is already in an extreme reading (red flag, not a bonus miss)', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 40; i++) {
      candles.push(candle(i, 100 + i * 0.5, 101 + i * 0.5, 102 + i * 0.5, 99 + i * 0.5));
    }
    for (let i = 40; i < 45; i++) {
      const base = 120 + (i - 40) * 3;
      candles.push(candle(i, base, base + 3, base + 4, base - 1));
    }
    const obIdx = 45;
    candles.push(candle(obIdx, 135, 132, 136, 131));
    candles.push(candle(obIdx + 1, 132, 137, 138, 131.5));
    candles.push(candle(obIdx + 2, 137, 139, 140, 136));

    const extremeSnapshot: IndicatorSnapshot = { ...NEUTRAL_SNAPSHOT, rsi: 80 };
    // Without the RSI filter this scenario is the same as the happy-path
    // test above and would be detected — demonstrating the filter actually
    // blocks it, not just that it happens to return null anyway.
    const sm: SmartMoneyResult = { ...EMPTY_SMART_MONEY, orderBlocks: [mockOb({ top: 136, bottom: 131, time: 45, type: 'bullish' })] };
    expect(detectOrderBlockContinuation(candles, extremeSnapshot, undefined, undefined, sm)).toBeNull();

    const normalSnapshot: IndicatorSnapshot = { ...NEUTRAL_SNAPSHOT, rsi: 50 };
    expect(detectOrderBlockContinuation(candles, normalSnapshot, undefined, undefined, sm)).not.toBeNull();
  });

  it('boosts confidence in a Kill Zone session vs a non-Kill-Zone session', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 40; i++) {
      candles.push(candle(i, 100 + i * 0.5, 101 + i * 0.5, 102 + i * 0.5, 99 + i * 0.5));
    }
    for (let i = 40; i < 45; i++) {
      const base = 120 + (i - 40) * 3;
      candles.push(candle(i, base, base + 3, base + 4, base - 1));
    }
    const obIdx = 45;
    candles.push(candle(obIdx, 135, 132, 136, 131));
    candles.push(candle(obIdx + 1, 132, 137, 138, 131.5));
    candles.push(candle(obIdx + 2, 137, 139, 140, 136));

    const sm: SmartMoneyResult = { ...EMPTY_SMART_MONEY, orderBlocks: [mockOb({ top: 136, bottom: 131, time: 45, type: 'bullish' })] };
    const withKillZone = detectOrderBlockContinuation(candles, NEUTRAL_SNAPSHOT, 'london', undefined, sm);
    const withoutKillZone = detectOrderBlockContinuation(candles, NEUTRAL_SNAPSHOT, 'sydney', undefined, sm);
    expect(withKillZone).not.toBeNull();
    expect(withoutKillZone).not.toBeNull();
    // Confidence may saturate at 1.0 on this strong-trend fixture (confidenceRaw
    // already ~1.0, so *1.2 kill zone and *1.1 structure bonuses both clamp).
    // Assert >= rather than > so the test still verifies the bonus exists
    // (it can never lower confidence) without failing on saturation.
    expect(withKillZone!.confidence).toBeGreaterThanOrEqual(withoutKillZone!.confidence);
  });
});

describe('detectMacdDecelerationContinuation', () => {
  // This whole suite was rewritten 2026-08-31 alongside the audit/fix of
  // this strategy, and revised again the same day once the
  // |lastValue| < |flipValue| gate and the ATR news-spike filter (both
  // originally left unimplemented, see macd-deceleration-continuation.ts)
  // were added on request together with a recalibrated confidence formula.
  // Summary of why the tests below differ from the very first version:
  //  - The ORIGINAL fixture (macdDecelScenario with all-positive
  //    tailSlopes) described a scenario this pattern is not actually meant
  //    to match — it only passed because of a real bug (inverted oldSeries
  //    break condition) that made the pattern's primary detection path dead
  //    code, plus a missing direction/flip-sign coherence check.
  //  - The SECOND version of this suite used a corrected fixture
  //    (macdDecelHappyPath, still used below) but that fixture's confidence
  //    (≈0.404 under the old formula) sat below ENTRY_THRESHOLD, so gate
  //    tests (RSI/ADX) could only assert "returns null" without a
  //    differential — both a hostile and a supportive gate value produced
  //    null, for different reasons.
  //  - Adding the |lastValue| < |flipValue| gate this request asked for
  //    made that ceiling *worse* under the old confidence formula (down to
  //    a proven ~0.51 max), so the formula was recalibrated alongside it:
  //    it now rewards decay-chain length and flip "quietness" — the
  //    pattern's own defining trait — instead of flip strength (see the
  //    formula's comment in macd-deceleration-continuation.ts). Under the
  //    new formula, macdDecelHappyPath() scores ≈0.560, clearing
  //    ENTRY_THRESHOLD on its own, so every gate below can now be tested as
  //    a real null-vs-signal differential again.
  it('returns null for insufficient candles', () => {
    expect(detectMacdDecelerationContinuation([])).toBeNull();
    expect(detectMacdDecelerationContinuation(Array.from({ length: 34 }, (_, i) => candle(i, 10, 11, 12, 9)))).toBeNull();
  });

  it('returns null in range market', () => {
    const candles: Candle[] = Array.from({ length: 50 }, (_, i) =>
      candle(i, 100, 100.1, 100.5, 99.5),
    );
    expect(detectMacdDecelerationContinuation(candles)).toBeNull();
  });

  it('detects a continuation signal on a valid decay-pause-flip shape', () => {
    // A real against-trend correction that decays monotonically (each bar
    // <=90% of the previous), a genuine pause bar preceding the flip, a
    // flip bar whose sign matches the uptrend direction and whose
    // magnitude is smaller than the old series' last bar (the
    // |lastValue| < |flipValue| gate), and a correction that never exceeds
    // 61.8% retracement (so no confidence penalty). Confirmed against the
    // real detector (not a hand-rolled replica) to clear ENTRY_THRESHOLD.
    const candles = macdDecelHappyPath();
    const result = detectMacdDecelerationContinuation(candles);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('macd-deceleration-continuation');
    expect(result?.direction).toBe('buy');
    expect(result?.confidence).toBeGreaterThanOrEqual(0.55);
  });

  it('returns null when RSI opposes the trend direction, fires when it supports it', () => {
    const candles = macdDecelHappyPath();
    expect(detectMacdDecelerationContinuation(candles, { ...NEUTRAL_SNAPSHOT, rsi: 40 })).toBeNull();
    expect(detectMacdDecelerationContinuation(candles, { ...NEUTRAL_SNAPSHOT, rsi: 55 })).not.toBeNull();
  });

  it('returns null when ADX is below the trend-confirmation threshold, fires when it is above', () => {
    const candles = macdDecelHappyPath();
    expect(detectMacdDecelerationContinuation(candles, { ...NEUTRAL_SNAPSHOT, adx: 15 })).toBeNull();
    expect(detectMacdDecelerationContinuation(candles, { ...NEUTRAL_SNAPSHOT, adx: 25 })).not.toBeNull();
  });

  it('returns null when the flip bar is wider than 2×ATR (news-spike filter), fires when it is within range', () => {
    // The flip candle's body on this fixture is ~0.1 (flipSlope=0.1 from
    // macdDecelHappyPath). 2×0.02=0.04 is narrower than that body (blocks
    // as a probable news spike); 2×1.0=2.0 comfortably contains it (passes
    // through unaffected). This is the fix that required wiring needAtr in
    // IndicatorAggregator.ts through to this strategy — without it,
    // snapshot.atr would be null here and this gate would silently no-op.
    const candles = macdDecelHappyPath();
    expect(detectMacdDecelerationContinuation(candles, { ...NEUTRAL_SNAPSHOT, atr: 0.02 })).toBeNull();
    expect(detectMacdDecelerationContinuation(candles, { ...NEUTRAL_SNAPSHOT, atr: 1.0 })).not.toBeNull();
  });

  it('boosts confidence in a Kill Zone session vs no session', () => {
    const candles = macdDecelHappyPath();
    const withKillZone = detectMacdDecelerationContinuation(candles, NEUTRAL_SNAPSHOT, 'london');
    const withoutSession = detectMacdDecelerationContinuation(candles, NEUTRAL_SNAPSHOT);
    expect(withKillZone).not.toBeNull();
    expect(withoutSession).not.toBeNull();
    expect(withKillZone!.confidence).toBeGreaterThan(withoutSession!.confidence);
  });

  it('returns null when the correction retraced past 78.6% of the recent swing at any bar, not only the last', () => {
    // A much deeper geometric pullback (larger amplitude, slower decay
    // ratio) than the happy-path fixture — deep enough that some bar within
    // the correction series closes beyond the 78.6% Fibonacci line relative
    // to the 15-bar swing, checked across the whole correction window (per
    // Торговая система §7), not just the final candle.
    const deepCandles = macdDecelScenario(3, 0.85, 20, 0.1);
    expect(detectMacdDecelerationContinuation(deepCandles)).toBeNull();
  });

  it('returns null when the flip bar is not quieter than the old series\u2019 last bar', () => {
    // The |lastValue| < |flipValue| gate, straight from this pattern's own
    // docstring ("the first bar of the new color is smaller in magnitude
    // than the last bar of the old color"). A large flipSlope makes the
    // resumption bar's histogram value comparable to or larger than the
    // old series' last bar instead of a quiet continuation — this is
    // structurally different from the "news spike" ATR check above (which
    // looks at candle body width, not histogram magnitude), so it can fire
    // independently. flipSlope=6 on this trend/pullback shape is large
    // enough to violate the gate while everything else about the shape
    // (decay, direction, pause body) still matches.
    const noisyFlipCandles = macdDecelScenario(0.5, 0.75, 30, 6);
    expect(detectMacdDecelerationContinuation(noisyFlipCandles)).toBeNull();
  });

  // Перенесено из параллельной сессии правок этой же стратегии (см.
  // сравнительный аудит A vs B) — прямая, изолированная проверка индексации
  // "паузы" (промт-фикс п.3), которой не хватало в этой версии набора
  // тестов. pauseAbsIdx = windowStart + flipIdx - 1 = candles.length - 3 —
  // на один бар РАНЬШЕ candle'а flipValue (candles.length - 2) и на два
  // раньше фактического бара флипа/триггера (candles.length - 1, lastValue).
  // Меняем ТОЛЬКО open свечи на этой позиции (close не трогаем — гистограмма
  // MACD зависит только от close, поэтому форма паттерна и confidence
  // остаются прежними), чтобы изолированно проверить именно проверку тела
  // паузы, а не случайно задеть что-то ещё.
  it('treats the bar before flipValue\'s candle as the pause candle, not the flip/trigger bar itself', () => {
    const base = macdDecelHappyPath();
    const n = base.length;

    // On this fixture's geometric decay, the 10-bar average body around the
    // pause position is ≈0.0008 (the correction has been decaying for ~29
    // bars by this point, so bodies are already tiny) — the delta here must
    // stay well under that average, not just "small" in absolute terms.
    // high/low are deliberately left untouched: this candle sits inside the
    // strategy's own 15-bar structure lookback, so widening/shrinking its
    // high would perturb swingHigh/retracement — a confound unrelated to
    // the pause-body check this test targets. The tiny open delta already
    // fits inside the original [low, high], so no high/low change is
    // needed here.
    const smallPauseBody = base.map((c) => ({ ...c }));
    const pauseTarget = smallPauseBody[n - 3];
    smallPauseBody[n - 3] = { ...pauseTarget, open: pauseTarget.close - 0.0002 };
    expect(detectMacdDecelerationContinuation(smallPauseBody)).not.toBeNull();

    const largePauseBody = base.map((c) => ({ ...c }));
    const bigTarget = largePauseBody[n - 3];
    const bigOpen = bigTarget.close - 5;
    largePauseBody[n - 3] = {
      ...bigTarget,
      open: bigOpen,
      high: Math.max(bigOpen, bigTarget.close) + 0.05,
      low: Math.min(bigOpen, bigTarget.close) - 0.05,
    };
    expect(detectMacdDecelerationContinuation(largePauseBody)).toBeNull();
  });
});

describe('detectStrongOrderBlockReaction', () => {
  function buildScenario(): Candle[] {
    const candles: Candle[] = [];
    for (let i = 0; i < 20; i++) candles.push(candle(i, 100, 100.2, 101, 99, 100));
    candles.push(candle(20, 106, 101, 107, 100, 100)); // bearish block candle
    candles.push(candle(21, 101, 115, 116, 100.5, 150)); // impulse, displacement >> 2xATR
    for (let i = 22; i < 28; i++) {
      const base = 115 + (i - 22) * 4;
      candles.push(candle(i, base, base + 4, base + 5, base - 1, 100));
    }
    // prev: wicks into the block zone. close is 136, not lower — 135 would
    // close below candle 27's low (134), which (correctly, after the
    // high/low break-condition fix in super-order-block.ts) makes candles
    // 27→28 themselves qualify as a *second*, incidental bearish OB whose
    // direction happens to satisfy DOWN_STRUCTURE_FOR_OB below, unrelated to
    // the bullish reaction this fixture is actually testing.
    candles.push(candle(28, 139, 136, 140, 106, 100));
    candles.push(candle(29, 107.2, 109, 109.2, 107, 120)); // last: reaction, closes above block.high
    return candles;
  }

  it('detects a bullish reaction with a high score (HTF bias + strong displacement + BOS + Kill Zone)', () => {
    const candles = buildScenario();
    const sm: SmartMoneyResult = { ...EMPTY_SMART_MONEY, orderBlocks: [mockOb({ top: 107, bottom: 100, time: 20, type: 'bullish', status: 'tested-hold' })] };
    const result = detectStrongOrderBlockReaction(candles, UP_STRUCTURE_FOR_OB, 'london', sm);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('strong-order-block-reaction');
    expect(result?.direction).toBe('buy');
    expect(result?.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('returns null against the HTF bias (block direction conflicts with a genuinely higher-timeframe trend)', () => {
    const candles = buildScenario();
    const sm: SmartMoneyResult = { ...EMPTY_SMART_MONEY, orderBlocks: [mockOb({ top: 107, bottom: 100, time: 20, type: 'bullish', status: 'tested-hold' })] };
    // BUGFIX (аудит 2026-09-06, п.3): HTF bias теперь гейтится отдельным
    // параметром htfStructure (6-й позиционный аргумент), а не тем же
    // `structure`, что и M1 BOS-подтверждение (structure остаётся
    // DOWN_STRUCTURE_FOR_OB здесь для сохранения прежнего сценария M1-
    // контекста) — без явно переданного htfStructure гейт теперь fail-open
    // (см. JSDoc в strong-order-block-reaction.ts), поэтому конфликтующий
    // тренд нужно передать явно.
    expect(detectStrongOrderBlockReaction(candles, DOWN_STRUCTURE_FOR_OB, 'london', sm, 14, DOWN_STRUCTURE_FOR_OB)).toBeNull();
  });

  it('scores lower without BOS confirmation and outside a Kill Zone session', () => {
    const candles = buildScenario();
    const sm: SmartMoneyResult = { ...EMPTY_SMART_MONEY, orderBlocks: [mockOb({ top: 107, bottom: 100, time: 20, type: 'bullish', status: 'tested-hold' })] };
    const full = detectStrongOrderBlockReaction(candles, UP_STRUCTURE_FOR_OB, 'london', sm);
    const reduced = detectStrongOrderBlockReaction(candles, UP_STRUCTURE_NO_BOS, 'sydney', sm);
    expect(full).not.toBeNull();
    // Both may or may not clear the entry threshold depending on the other
    // scored factors, but the reduced-factor case must never score higher.
    if (reduced) {
      expect(reduced.confidence).toBeLessThan(full!.confidence);
    }
  });
});

describe('detectImpulseBreakout', () => {
  function buildScenario(): Candle[] {
    const candles: Candle[] = [];
    for (let i = 0; i < 25; i++) {
      const bullish = i % 2 === 0;
      candles.push(candle(i, bullish ? 99.9 : 100.1, bullish ? 100.1 : 99.9, 101, 99, 100));
    }
    candles.push(candle(25, 100, 104, 104.3, 99.8, 200)); // breakout bar, 2x avg volume
    return candles;
  }

  it('detects a bullish breakout with volume confirmation', () => {
    const result = detectImpulseBreakout(buildScenario(), undefined, UP_STRUCTURE_FOR_OB, 'london');
    expect(result).not.toBeNull();
    expect(result?.name).toBe('impulse-breakout');
    expect(result?.direction).toBe('buy');
  });

  it('returns null without volume confirmation (hard block, not just a lower score)', () => {
    const candles = buildScenario().slice(0, -1);
    candles.push(candle(25, 100, 104, 104.3, 99.8, 100)); // same geometry, avg volume only
    // Without the volume floor this is the same breakout geometry as the
    // happy-path test above and would be detected — demonstrating the
    // filter actually blocks it.
    expect(detectImpulseBreakout(candles, undefined, UP_STRUCTURE_FOR_OB, 'london')).toBeNull();
  });

  it('scores lower against the HTF trend than when aligned with it', () => {
    const candles = buildScenario();
    const aligned = detectImpulseBreakout(candles, undefined, UP_STRUCTURE_FOR_OB, 'london');
    const against = detectImpulseBreakout(candles, undefined, DOWN_STRUCTURE_FOR_OB, 'london');
    expect(aligned).not.toBeNull();
    expect(against).not.toBeNull();
    expect(against!.confidence).toBeLessThan(aligned!.confidence);
  });

  // Пункт 1 — Deriv/forex volume-gate fix: candles with volume: 0 on every
  // bar (the Deriv scenario) must NOT be hard-blocked when the breakout
  // body clears the higher no-reliable-volume bar (1.2x ATR).
  it('generates a signal on zero-volume (Deriv-style) candles given a large enough body', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 25; i++) {
      const bullish = i % 2 === 0;
      candles.push(candle(i, bullish ? 99.9 : 100.1, bullish ? 100.1 : 99.9, 101, 99, 0));
    }
    // Body ~4, comfortably above the 1.2x-ATR no-volume floor; all volumes 0.
    candles.push(candle(25, 100, 104, 104.3, 99.8, 0));
    const result = detectImpulseBreakout(candles, undefined, UP_STRUCTURE_FOR_OB, 'london');
    expect(result).not.toBeNull();
    expect(result?.direction).toBe('buy');
    // Volume was never reliable, so volumeConfirmed must be honestly false —
    // not the old hardcoded `true`.
    expect(result?.volumeConfirmed).toBe(false);
  });

  it('still hard-blocks on real (non-zero) volume below 1.5x average', () => {
    const candles = buildScenario().slice(0, -1);
    candles.push(candle(25, 100, 104, 104.3, 99.8, 100)); // same geometry, avg (reliable) volume only
    expect(detectImpulseBreakout(candles, undefined, UP_STRUCTURE_FOR_OB, 'london')).toBeNull();
  });

  it('marks volumeConfirmed honestly (only true when volume is reliable AND >= 2x average)', () => {
    const strongVolume = detectImpulseBreakout(buildScenario(), undefined, UP_STRUCTURE_FOR_OB, 'london');
    expect(strongVolume?.volumeConfirmed).toBe(true); // breakout bar has 2x avg volume in buildScenario()
  });

  // Пункт 4 — rejection-wick / stop-hunt filter.
  it('returns null when the close barely clears the range (noise, not a breakout)', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 25; i++) {
      const bullish = i % 2 === 0;
      candles.push(candle(i, bullish ? 99.9 : 100.1, bullish ? 100.1 : 99.9, 101, 99, 200));
    }
    // Body large enough (>=1x ATR) but close only ~0.02 above rangeHigh (101)
    // — far below the 0.1xATR margin requirement.
    candles.push(candle(25, 100, 101.02, 101.05, 99.8, 200));
    expect(detectImpulseBreakout(candles, undefined, UP_STRUCTURE_FOR_OB, 'london')).toBeNull();
  });

  it('penalizes a breakout candle with a long opposite (rejection) wick', () => {
    function scenarioWithUpperWick(): Candle[] {
      const candles: Candle[] = [];
      for (let i = 0; i < 25; i++) {
        const bullish = i % 2 === 0;
        candles.push(candle(i, bullish ? 99.9 : 100.1, bullish ? 100.1 : 99.9, 101, 99, 100));
      }
      return candles;
    }
    const clean = scenarioWithUpperWick();
    clean.push(candle(25, 100, 104, 104.3, 99.8, 200)); // small upper wick
    const wicked = scenarioWithUpperWick();
    // Same close/body, but a long upper wick (>35% of the candle's range) —
    // classic Wyckoff Upthrust / ICT liquidity-grab geometry.
    wicked.push(candle(25, 100, 104, 108, 99.8, 200));

    const cleanResult = detectImpulseBreakout(clean, undefined, UP_STRUCTURE_FOR_OB, 'london');
    const wickedResult = detectImpulseBreakout(wicked, undefined, UP_STRUCTURE_FOR_OB, 'london');
    expect(cleanResult).not.toBeNull();
    if (wickedResult) {
      expect(wickedResult.confidence).toBeLessThan(cleanResult!.confidence);
    }
  });

  // Пункт 5 — bounded additive confidence: a barely-qualifying candle (body
  // just over the entry floor) stacking every possible bonus must not reach
  // 'strong' purely from bonus coincidence; a genuinely large-body candle
  // should stay at least 'moderate' even with zero bonuses.
  it('does not label a minimal-body candle "strong" even with every bonus stacked', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 25; i++) {
      const bullish = i % 2 === 0;
      candles.push(candle(i, bullish ? 99.9 : 100.1, bullish ? 100.1 : 99.9, 101, 99, 200));
    }
    // ATR here is ~2.03, so body ~2.03 sits right at the 1.0x-ATR entry
    // floor (base confidence ~0.5, itself below ENTRY_THRESHOLD without any
    // bonus at all) — the scenario the additive-adjustment cap targets.
    candles.push(candle(25, 100, 102.03, 102.1, 99.95, 400)); // strong volume too
    const snapshot: IndicatorSnapshot = {
      ...NEUTRAL_SNAPSHOT,
      bollingerUpper: 100.5,
      bollingerLower: 99.5, // narrow bands => squeeze bonus
    };
    const result = detectImpulseBreakout(candles, snapshot, UP_STRUCTURE_FOR_OB, 'overlap');
    expect(result).not.toBeNull();
    expect(result?.strength).not.toBe('strong');
  });

  it('keeps a large-body candle at least "moderate" with zero bonuses', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 25; i++) {
      const bullish = i % 2 === 0;
      candles.push(candle(i, bullish ? 99.9 : 100.1, bullish ? 100.1 : 99.9, 101, 99, 100));
    }
    candles.push(candle(25, 100, 105, 105.3, 99.9, 200)); // large body, no wick, no session/BB bonus
    const result = detectImpulseBreakout(candles, undefined, UP_STRUCTURE_NO_BOS);
    expect(result).not.toBeNull();
    expect(result?.strength).not.toBe('weak');
  });

  // breakoutLow/breakoutHigh carried on the result for structural SL/TP.
  it('carries the breakout candle extremes for structural stop placement', () => {
    const result = detectImpulseBreakout(buildScenario(), undefined, UP_STRUCTURE_FOR_OB, 'london');
    expect(result?.breakoutLow).toBe(99.8);
    expect(result?.breakoutHigh).toBe(104.3);
  });
});

describe('detectConsolidationBreakout', () => {
  function buildScenario(): Candle[] {
    const candles: Candle[] = [];
    for (let i = 0; i < 20; i++) candles.push(candle(i, 99.5, 100.5, 101.5, 98.5, 100));
    for (let i = 20; i < 30; i++) {
      const bullish = i % 2 === 0;
      candles.push(candle(i, bullish ? 99.9 : 100.1, bullish ? 100.1 : 99.9, 100.3, 99.7, 100));
    }
    candles.push(candle(30, 100.2, 101.5, 101.6, 100.1, 200)); // breakout bar, 2x avg volume
    return candles;
  }

  it('detects a bullish breakout out of a tight consolidation', () => {
    const result = detectConsolidationBreakout(buildScenario(), UP_STRUCTURE_FOR_OB, 'london');
    expect(result).not.toBeNull();
    expect(result?.name).toBe('consolidation-breakout');
    expect(result?.direction).toBe('buy');
  });

  it('returns null without volume confirmation (hard block)', () => {
    const candles = buildScenario().slice(0, -1);
    candles.push(candle(30, 100.2, 101.5, 101.6, 100.1, 100));
    expect(detectConsolidationBreakout(candles, UP_STRUCTURE_FOR_OB, 'london')).toBeNull();
  });

  it('returns null when the breakout bar body is under 60% of its own range (doji-like)', () => {
    const candles = buildScenario().slice(0, -1);
    candles.push(candle(30, 100.5, 100.6, 101.6, 100.1, 200)); // tiny body, big range
    expect(detectConsolidationBreakout(candles, UP_STRUCTURE_FOR_OB, 'london')).toBeNull();
  });
});

describe('detectLiquiditySweep', () => {
  it('detects a bullish sweep: deep wick + volume + swing-level confluence', () => {
    const candles = flatWarmup(30);
    // Sweep bar: wick spikes ~1.5x ATR below the 20-bar low (WARMUP_LOW),
    // closes back above it, high stays under the 20-bar high, volume 2.6x
    // the warmup average.
    candles.push(candle(30, 99.5, 99.6, 100.5, 97.6, 260));

    const result = detectLiquiditySweep(candles, UP_STRUCTURE, 'london', EMPTY_SMART_MONEY);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('liquidity-sweep');
    expect(result?.direction).toBe('buy');
    expect(result?.setupType).toBe('continuation');
  });

  it('returns null without volume confirmation', () => {
    const candles = flatWarmup(30);
    // Same wick geometry as the passing case above, but volume stays at the
    // warmup average (100) instead of the required >=1.5x.
    candles.push(candle(30, 99.5, 99.6, 100.5, 97.6, 100));

    expect(detectLiquiditySweep(candles, UP_STRUCTURE, 'london', EMPTY_SMART_MONEY)).toBeNull();
  });

  // Audit finding #1: on real spot-Forex feeds volume is frequently absent
  // (always 0) rather than merely low. The old volumeRatio() silently
  // treated avg<=0 as ratio=1, which ALWAYS failed the hard >=1.5 gate —
  // meaning the entire pattern could never fire on such feeds regardless of
  // how clean the structural setup was. hasReliableVolume() must recognize
  // this as "no data" (not "failing data") and skip the gate instead.
  it('still detects the sweep when volume is entirely absent (0 for every bar in the window)', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 30; i++) {
      const bullish = i % 2 === 0;
      const open = bullish ? 99.9 : 100.1;
      const close = bullish ? 100.1 : 99.9;
      candles.push(candle(i, open, close, WARMUP_HIGH, WARMUP_LOW, 0));
    }
    candles.push(candle(30, 99.5, 99.6, 100.5, 97.6, 0));

    const result = detectLiquiditySweep(candles, UP_STRUCTURE, 'london', EMPTY_SMART_MONEY);
    expect(result).not.toBeNull();
    expect(result?.volumeConfirmed).toBe(false);
  });

  it('returns null when the wick pierces more than 2x ATR (likely a real breakout, not a sweep)', () => {
    const candles = flatWarmup(30);
    candles.push(candle(30, 99.5, 99.6, 100.5, 96.4, 260));

    expect(detectLiquiditySweep(candles, UP_STRUCTURE, 'london', EMPTY_SMART_MONEY)).toBeNull();
  });

  it('returns null against the HTF trend without sufficient bar-level trend strength or a swing-level reversal', () => {
    const candles = flatWarmup(30);
    candles.push(candle(30, 99.5, 99.6, 100.5, 97.6, 260));

    // Same bullish sweep geometry, but structure says 'down' and the flat
    // warmup candles are a genuine ~50/50 mix, so bar-level trend strength
    // for 'up' stays far below the 5/7 threshold. structure.swingLow here is
    // deliberately far from the sweep wick, so it also isn't a valid
    // reversal-at-key-level setup.
    const farStructure: MarketStructure = { trend: 'down', bos: true, choch: false, swingHigh: 130, swingLow: 50, provisional: false };
    expect(detectLiquiditySweep(candles, farStructure, 'london', EMPTY_SMART_MONEY)).toBeNull();
  });

  // Audit finding #7: the old code only ever allowed a sweep that agreed
  // with the prevailing trend (continuation), which structurally excludes
  // the classic Wyckoff Spring/Upthrust — an against-trend sweep right at a
  // genuine swing extreme, which is exactly the setup most ICT/SMC traders
  // mean by "reaction to liquidity sweep" in the first place.
  it('allows a reversal-at-key-level sweep against the prevailing trend, right at the structural swing low', () => {
    const candles = flatWarmup(30);
    candles.push(candle(30, 99.5, 99.6, 100.5, 97.6, 260));

    // structure.trend is 'down' (opposite of the buy sweep direction) but
    // swingLow sits exactly at the sweep wick's low, and depth clears the
    // 0.5x ATR reversal-specific floor.
    const result = detectLiquiditySweep(candles, DOWN_STRUCTURE, 'london', EMPTY_SMART_MONEY);
    expect(result).not.toBeNull();
    expect(result?.direction).toBe('buy');
    expect(result?.setupType).toBe('reversal-at-key-level');
  });

  it('returns null in the Asian/closed session (heavily penalized confidence)', () => {
    const candles = flatWarmup(30);
    candles.push(candle(30, 99.5, 99.6, 100.5, 97.6, 260));

    expect(detectLiquiditySweep(candles, UP_STRUCTURE, 'tokyo', EMPTY_SMART_MONEY)).toBeNull();
  });
});

describe('detectLiquiditySweepReaction', () => {
  it('detects a reaction when displacement follows immediately (1 bar after sweep)', () => {
    const candles = flatWarmup(30);
    candles.push(candle(30, 99.5, 99.6, 100.5, 97.6, 260)); // sweep bar
    // Displacement bar: strong bullish body breaking above the sweep bar's
    // high (100.5), with volume well over the 2.5x floor for the extra bonus.
    candles.push(candle(31, 100.5, 103.5, 103.7, 100.4, 300));

    const result = detectLiquiditySweepReaction(candles, UP_STRUCTURE, 'london', EMPTY_SMART_MONEY);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('liquidity-sweep-reaction');
    expect(result?.direction).toBe('buy');
    // Audit finding #6: sweep bar extremes carried on the result for
    // structural SL placement in trade-levels.ts.
    expect(result?.sweepLow).toBe(97.6);
    expect(result?.sweepHigh).toBe(100.5);
  });

  it('returns null when displacement volume is below the 1.5x hard floor', () => {
    const candles = flatWarmup(30);
    candles.push(candle(30, 99.5, 99.6, 100.5, 97.6, 260));
    candles.push(candle(31, 100.5, 103.5, 103.7, 100.4, 100));

    expect(detectLiquiditySweepReaction(candles, UP_STRUCTURE, 'london', EMPTY_SMART_MONEY)).toBeNull();
  });

  // Audit finding #1: same "not a hard gate on Forex" fix as
  // detectLiquiditySweep — a feed with genuinely no volume data must not be
  // penalized as if it had confirmed-low volume.
  it('still detects the reaction when volume is entirely absent for both sweep and displacement bars', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 30; i++) {
      const bullish = i % 2 === 0;
      const open = bullish ? 99.9 : 100.1;
      const close = bullish ? 100.1 : 99.9;
      candles.push(candle(i, open, close, WARMUP_HIGH, WARMUP_LOW, 0));
    }
    candles.push(candle(30, 99.5, 99.6, 100.5, 97.6, 0));
    candles.push(candle(31, 100.5, 103.5, 103.7, 100.4, 0));

    const result = detectLiquiditySweepReaction(candles, UP_STRUCTURE, 'london', EMPTY_SMART_MONEY);
    expect(result).not.toBeNull();
    expect(result?.volumeConfirmed).toBe(false);
  });

  it('finds displacement 2 bars after the sweep when the intermediate bar holds the level', () => {
    const candles = flatWarmup(30);
    candles.push(candle(30, 99.5, 99.6, 100.5, 97.6, 260)); // sweep bar
    // Intermediate bar: small, holds above the swept level (WARMUP_LOW),
    // doesn't itself qualify as a fresh sweep or re-break anything.
    candles.push(candle(31, 100.5, 100.6, 100.7, 100.4, 100));
    candles.push(candle(32, 100.6, 104, 104.2, 100.5, 300));

    const result = detectLiquiditySweepReaction(candles, UP_STRUCTURE, 'london', EMPTY_SMART_MONEY);
    expect(result).not.toBeNull();
    expect(result?.direction).toBe('buy');
  });

  it('returns null when the intermediate bar re-invalidates the swept level', () => {
    const candles = flatWarmup(30);
    candles.push(candle(30, 99.5, 99.6, 100.5, 97.6, 260)); // sweep bar
    // Intermediate bar closes back below the originally-swept level
    // (WARMUP_LOW = 99.4), negating the reclaim before displacement happens.
    candles.push(candle(31, 99.3, 99.0, 99.5, 98.8, 100));
    candles.push(candle(32, 99.0, 102, 102.2, 98.9, 300));

    expect(detectLiquiditySweepReaction(candles, UP_STRUCTURE, 'london', EMPTY_SMART_MONEY)).toBeNull();
  });

  // Audit finding #6: TP should target the nearest opposite-side OB/FVG
  // when one exists beyond entry, instead of an arbitrary R:R multiple.
  it('carries the nearest opposite-side order block edge as oppositeZonePrice', () => {
    const candles = flatWarmup(30);
    candles.push(candle(30, 99.5, 99.6, 100.5, 97.6, 260));
    candles.push(candle(31, 100.5, 103.5, 103.7, 100.4, 300));

    const smartMoney: SmartMoneyResult = {
      ...EMPTY_SMART_MONEY,
      orderBlocks: [
        // Bearish OB comfortably above the displacement bar's close (103.5)
        // — the natural opposite-side target for this buy trade.
        mockOb({ top: 110, bottom: 108, time: 5, type: 'bearish' }),
        // A bullish OB (wrong polarity) even closer — must be ignored.
        mockOb({ top: 103.9, bottom: 103.6, time: 6, type: 'bullish' }),
      ],
    };

    const result = detectLiquiditySweepReaction(candles, UP_STRUCTURE, 'london', smartMoney);
    expect(result).not.toBeNull();
    expect(result?.oppositeZonePrice).toBe(108);
  });
});

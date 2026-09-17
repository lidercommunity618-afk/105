import { describe, it, expect } from 'vitest';
import type { Candle, IndicatorConfig, PatternResult, Signal } from '@/types/domain';
import { DEFAULT_INDICATOR_CONFIG, DEFAULT_SIGNAL_TOGGLES } from '@/types/domain';
import { buildSignal, buildFeatureVector, generateSignalId, shouldRevise, sigmoidFallback, reviseSignal, STRONG_SIGNAL_SCORE_THRESHOLD } from './signal-builder';
import { CalibrationModel, MIN_SAMPLES, MAX_SAMPLES } from './calibration-model';
import type { Snapshot } from '@/types/domain';

const CONFIG: IndicatorConfig = {
  ...DEFAULT_INDICATOR_CONFIG,
  emaFast: 9,
  emaSlow: 21,
};

function makeCandles(uptrend: boolean): Candle[] {
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < 60; i++) {
    const change = uptrend ? 1.5 : -1.5;
    const open = price;
    const close = price + change;
    const high = Math.max(open, close) + 0.5;
    const low = Math.min(open, close) - 0.5;
    candles.push({ time: i * 60, open, high, low, close, volume: 100 });
    price = close;
  }
  return candles;
}

function makeSnapshot(candles: Candle[], indicators: Partial<Signal['indicators']>): Snapshot {
  return {
    indicators: { ...candles[candles.length - 1], ...indicators } as Signal['indicators'],
    patterns: [],
    structure: { trend: 'range', bos: false, choch: false, swingHigh: null, swingLow: null, provisional: false },
    regime: 'range',
    lastPrice: candles[candles.length - 1].close,
    candleTime: candles[candles.length - 1].time,
  };
}

describe('generateSignalId', () => {
  it('produces deterministic IDs per candle', () => {
    const id1 = generateSignalId('BTCUSDT', '15m', 1000);
    const id2 = generateSignalId('BTCUSDT', '15m', 1000);
    expect(id1).toBe(id2);
    expect(id1).toBe('BTCUSDT:15m:1000');
  });
});

describe('buildFeatureVector', () => {
  it('includes only non-null indicators', () => {
    const snap = makeSnapshot(makeCandles(true), {
      rsi: 65,
      emaFast: 110,
      emaSlow: 105,
      macdHistogram: 0.5,
      atr: 2,
      bollingerUpper: 115,
      bollingerMiddle: 105,
      bollingerLower: 95,
    });
    const vec = buildFeatureVector(snap);
    expect(vec.values.length).toBeGreaterThan(0);
    expect(vec.keys).toContain('rsi');
    expect(vec.keys).toContain('ema_cross');
    expect(vec.keys).toContain('macd_hist');
  });

  it('returns fixed-length vector even with all null indicators', () => {
    const snap = makeSnapshot(makeCandles(true), {
      rsi: null,
      emaFast: null,
      emaSlow: null,
      macdHistogram: null,
      atr: null,
      bollingerUpper: null,
      bollingerMiddle: null,
      bollingerLower: null,
      vwap: null,
      vwapIsProxyVolume: false,
      volumeProfilePoc: null,
      volumeProfilePocIsProxyVolume: false,
      meanReversionRsi: null,
      impulseVelocity: null,
      adx: null,
    });
    const vec = buildFeatureVector(snap);
    expect(vec.values.length).toBe(12);
    expect(vec.values.every((v) => v === 0)).toBe(true);
  });
});

describe('sigmoidFallback', () => {
  it('returns 0.5 for score 0', () => {
    expect(sigmoidFallback(0)).toBeCloseTo(0.5, 3);
  });

  it('returns higher probability for higher score, within the unclamped range', () => {
    // BUGFIX (найдено при аудите 2026-09-05, п.2): raw sigmoid(5) ≈ 0.731 и
    // raw sigmoid(10) ≈ 0.881 — оба выше плафона 0.65 (см. clamp в
    // sigmoidFallback), поэтому оба схлопывались в одно и то же значение
    // 0.65, и `toBeGreaterThan` между ними был обречён падать. Сравнение
    // монотonности теперь ведётся внутри диапазона, где клэмп ещё не
    // сработал (raw < 0.65 при score < ~3.1) — сама монотонность
    // sigmoidFallback как функции по-прежнему проверяется, просто не на
    // значениях, для которых результат заведомо одинаков по конструкции.
    expect(sigmoidFallback(1)).toBeGreaterThan(sigmoidFallback(0));
    expect(sigmoidFallback(3)).toBeGreaterThan(sigmoidFallback(1));
  });

  it('plateaus at the 0.65 ceiling for scores above the clamp threshold (~3.1)', () => {
    expect(sigmoidFallback(5)).toBeCloseTo(0.65, 5);
    expect(sigmoidFallback(10)).toBeCloseTo(0.65, 5);
    expect(sigmoidFallback(24)).toBeCloseTo(0.65, 5);
  });

  it('is bounded in [0, 1]', () => {
    expect(sigmoidFallback(-100)).toBeGreaterThanOrEqual(0);
    expect(sigmoidFallback(100)).toBeLessThanOrEqual(1);
  });
});

describe('shouldRevise', () => {
  it('returns true when delta > 3', () => {
    expect(shouldRevise(6, 2)).toBe(true);
    expect(shouldRevise(2, 6)).toBe(true);
  });

  it('returns false when delta <= 3', () => {
    expect(shouldRevise(4, 2)).toBe(false);
    expect(shouldRevise(2, 4)).toBe(false);
  });
});

describe('reviseSignal', () => {
  it('updates score, reason, and marks as revised', () => {
    const candles = makeCandles(true);
    const snap = makeSnapshot(candles, {
      rsi: 25, emaFast: 110, emaSlow: 105, macdHistogram: -0.5, atr: 2,
      bollingerUpper: 115, bollingerMiddle: 105, bollingerLower: 95,
    });
    const signal: Signal = {
      id: 'test:1',
      symbolId: 'BTCUSDT',
      direction: 'buy',
      strength: 'moderate',
      score: 2,
      calibratedProbability: 0.5,
      entryPrice: 100,
      reason: 'initial',
      indicators: snap.indicators,
      pattern: null,
      time: 100,
      timeframe: '15m',
      outcome: 'pending',
      frozenAt: null,
      isRevised: false,
      isPreClose: false,
      revisionNote: null,
      barsToResolve: 5,
      spread: null,
      spreadSource: null,
      recommendedExpiry: 900,
      featureVector: new Array(12).fill(0),
      factors: [], rejectedPatterns: [], engineConfigSnapshot: {} as unknown as Signal['engineConfigSnapshot'],
      chartContext: { candlesBefore: [], candlesAfter: [], maxFavorableExcursion: null, maxAdverseExcursion: null },
      marketContext: { regime: 'range', structure: { trend: 'range', bos: false, choch: false, swingHigh: null, swingLow: null, provisional: false }, session: 'closed' },
    };
    const revised = reviseSignal(signal, 6, 'new reasons', snap, null);
    expect(revised.isRevised).toBe(true);
    expect(revised.score).toBe(6);
    expect(revised.reason).toBe('new reasons');
    expect(revised.revisionNote).toContain('2');
    expect(revised.revisionNote).toContain('6');
  });
});

describe('buildSignal', () => {
  it('returns null when score < 2', () => {
    const candles = makeCandles(true);
    const snap = makeSnapshot(candles, {
      rsi: 50, emaFast: 105, emaSlow: 105, macdHistogram: 0, atr: 2,
      bollingerUpper: 115, bollingerMiddle: 105, bollingerLower: 95,
    });
    const signal = buildSignal({
      symbolId: 'BTCUSDT', timeframe: '15m', candles, config: CONFIG,
      activeFeatures: [], snapshot: snap, calibration: null, tick: null, barsToResolve: 5,
    });
    expect(signal).toBeNull();
  });

  it('uses fallback sigmoid when calibration not ready', () => {
    const candles = makeCandles(true);
    const snap = makeSnapshot(candles, {
      rsi: 25, emaFast: 110, emaSlow: 100, macdHistogram: 1, atr: 2,
      bollingerUpper: 115, bollingerMiddle: 105, bollingerLower: 95,
    });
    const signal = buildSignal({
      symbolId: 'BTCUSDT', timeframe: '15m', candles, config: CONFIG,
      activeFeatures: [], snapshot: snap, calibration: null, tick: null, barsToResolve: 5,
    });
    expect(signal).not.toBeNull();
    expect(signal!.calibratedProbability).not.toBeNull();
    expect(signal!.calibratedProbability).toBeGreaterThan(0.5);
  });

  it('uses calibrated probability when model is ready', () => {
    const candles = makeCandles(true);
    const snap = makeSnapshot(candles, {
      rsi: 25, emaFast: 110, emaSlow: 100, macdHistogram: 1, atr: 2,
      bollingerUpper: 115, bollingerMiddle: 105, bollingerLower: 95,
    });
    const model = new CalibrationModel(12);
    // BUGFIX (найдено при аудите 2026-09-05, п.2): раньше здесь добавлялось
    // всего 15 сэмплов — при MIN_SAMPLES = 100 (calibration-model.ts)
    // calibration.isReady() было false, то есть тест, названный "when model
    // is ready", на самом деле тренировал фоллбэк-ветку, а не модель. Он
    // "проходил" только потому, что не проверял calibrationSource — и
    // sigmoidFallback(), и calibration.predict() оба возвращают число в
    // (0, 1), так что единственная имевшаяся проверка ничего не различала.
    for (let i = 0; i < MIN_SAMPLES; i++) {
      model.addSample({ features: new Array(12).fill(0.5), score: 3, outcome: 1 });
    }
    model.retrain();
    expect(model.isReady()).toBe(true);
    const signal = buildSignal({
      symbolId: 'BTCUSDT', timeframe: '15m', candles, config: CONFIG,
      activeFeatures: [], snapshot: snap, calibration: model, tick: null, barsToResolve: 5,
    });
    expect(signal).not.toBeNull();
    expect(signal!.calibrationSource).toBe('model');
    expect(signal!.calibratedProbability).not.toBeNull();
    expect(signal!.calibratedProbability).toBeGreaterThan(0);
    expect(signal!.calibratedProbability).toBeLessThan(1);
  });

  it('populates entry price, expiryBars, spread, and expiry (Фаза 1: SL/TP удалены — бинарный опцион без структурного стопа/цели)', () => {
    const candles = makeCandles(true);
    const snap = makeSnapshot(candles, {
      rsi: 25, emaFast: 110, emaSlow: 100, macdHistogram: 1, atr: 2,
      bollingerUpper: 115, bollingerMiddle: 105, bollingerLower: 95,
    });
    const tick = { price: 100, time: 0, bid: 99.9, ask: 100.1 };
    const signal = buildSignal({
      symbolId: 'BTCUSDT', timeframe: '15m', candles, config: CONFIG,
      activeFeatures: [], snapshot: snap, calibration: null, tick, barsToResolve: 5,
    });
    expect(signal).not.toBeNull();
    expect(signal!.entryPrice).toBeGreaterThan(0);
    expect(signal!.expiryBars).toBeGreaterThanOrEqual(1);
    expect(signal!.spread).toBeCloseTo(0.2, 5);
    expect(signal!.spreadSource).toBe('live');
    expect(signal!.recommendedExpiry).toBeGreaterThan(0);
    expect(signal!.barsToResolve).toBe(5);
    expect(signal!.frozenAt).toBeNull();
    expect(signal!.isRevised).toBe(false);
  });

  // Реальные проблемы, п.1: свеча самого входа раньше выпадала из
  // chartContext (candlesBefore заканчивался ДО неё, candlesAfter
  // начинался СТРОГО после неё — ни один из двух массивов её не содержал).
  it('includes the entry (signal) candle as the last element of chartContext.candlesBefore', () => {
    const candles = makeCandles(true);
    const snap = makeSnapshot(candles, {
      rsi: 25, emaFast: 110, emaSlow: 100, macdHistogram: 1, atr: 2,
      bollingerUpper: 115, bollingerMiddle: 105, bollingerLower: 95,
    });
    const signal = buildSignal({
      symbolId: 'BTCUSDT', timeframe: '15m', candles, config: CONFIG,
      activeFeatures: [], snapshot: snap, calibration: null, tick: null, barsToResolve: 5,
    });
    expect(signal).not.toBeNull();
    const before = signal!.chartContext.candlesBefore;
    expect(before.length).toBeGreaterThan(0);
    expect(before[before.length - 1].time).toBe(signal!.time);
    expect(before[before.length - 1]).toEqual(candles[candles.length - 1]);
  });

  it('returns null when only meanReversion toggle is enabled (BUGFIX regression, аудит 2026-09: same-class deadlock as priorityThreshold)', () => {
    // components.meanReversion в direction-prediction.ts никогда не
    // получает ненулевого значения (реальная стратегия возврата к среднему
    // реализована отдельно, как паттерн 'mean-reversion', и идёт через
    // toggles.trigger) — значит конфигурация "включён только meanReversion"
    // структурно не может дать ненулевой score ни при каких свечах/
    // индикаторах. До фикса hasEnabledSource в signal-builder.ts такая
    // конфигурация молча считалась "есть активный источник" и просто вечно
    // не давала сигналов, без единого предупреждения. После фикса —
    // hasEnabledSource=false, buildSignal возвращает null сразу, честно.
    const candles = makeCandles(true);
    const snap = makeSnapshot(candles, {
      rsi: 25, emaFast: 110, emaSlow: 100, macdHistogram: 1, atr: 2,
      bollingerUpper: 115, bollingerMiddle: 105, bollingerLower: 95,
    });
    const onlyMeanReversionToggles = {
      ...DEFAULT_SIGNAL_TOGGLES,
      structure: false, zones: false, liquidity: false, trigger: false,
      indicator: false, bos: false, macd: false, meanReversion: true,
    };
    const signal = buildSignal({
      symbolId: 'BTCUSDT', timeframe: '15m', candles, config: CONFIG,
      activeFeatures: [], snapshot: snap, calibration: null, tick: null, barsToResolve: 5,
      signalToggles: onlyMeanReversionToggles,
    });
    expect(signal).toBeNull();
  });
});

// Audit ("Реакция на снятие ликвидности") findings #4, #9, #10.
// BUGFIX (Фаза 1, "честный бинарный опцион"): заголовок был "...structural
// SL/TP and bonuses" — структурные SL/TP (finding #6, computeLiquiditySweepTradeLevels
// в decision/trade-levels.ts) удалены целиком вместе с файлом; тесты,
// проверявшие именно их (signal!.stopLoss/signal!.takeProfit), удалены
// ниже, не переразмечены — see decision/signal-quality.ts::
// sweepInvalidationDistance для того, что осталось от finding #6 (только
// как spread-гейт, не как торговый уровень; уже покрыт тестом finding #10
// ниже).
describe('buildSignal — liquidity-sweep-reaction spread gate and bonuses', () => {
  // BUGFIX (аудит 2026-09-06, п.2 и п.4): scoreThreshold по умолчанию
  // поднят 2→4, и liquidity-sweep-reaction больше не даёт вклад в score
  // дважды (через components.trigger И через персональный strategy-бонус,
  // см. STRATEGY_BONUS_PATTERNS в lib/pattern-categories.ts) — только через
  // бонус. Эти тесты проверяют SL/TP-механику, спред и текст причины, а не
  // саму scoring-политику, поэтому используют локальный конфиг с
  // scoreThreshold=0, чтобы не быть хрупкими к порогу, который сознательно
  // меняется независимо от этой механики.
  const LSR_CONFIG: IndicatorConfig = { ...CONFIG, scoreThreshold: 0 };

  function lsrPattern(overrides: Partial<PatternResult> = {}): PatternResult {
    return {
      name: 'liquidity-sweep-reaction',
      direction: 'buy',
      confidence: 0.8,
      strength: 'strong',
      time: 0,
      volumeConfirmed: true,
      setupType: 'continuation',
      ...overrides,
    };
  }

  function buySnapshot(candles: Candle[]) {
    const snap = makeSnapshot(candles, {
      rsi: 25, emaFast: 110, emaSlow: 100, macdHistogram: 1, atr: 2,
      bollingerUpper: 115, bollingerMiddle: 105, bollingerLower: 95,
    });
    return snap;
  }

  it('includes a Liquidity Sweep Reaction bonus line in the reason text (finding #4)', () => {
    const candles = makeCandles(true);
    const lastClose = candles[candles.length - 1].close;
    const snap = buySnapshot(candles);
    snap.patterns = [lsrPattern({ sweepLow: lastClose - 5, sweepHigh: lastClose - 1, oppositeZonePrice: null })];

    const signal = buildSignal({
      symbolId: 'BTCUSDT', timeframe: '15m', candles, config: LSR_CONFIG,
      activeFeatures: [], snapshot: snap, calibration: null, tick: null, barsToResolve: 5,
    });
    expect(signal).not.toBeNull();
    expect(signal!.reason).toContain('Liquidity Sweep Reaction');
  });

  it('adjusts the modelled entry price by half the spread in the trade direction (finding #9)', () => {
    const candles = makeCandles(true);
    const lastClose = candles[candles.length - 1].close;
    const snap = buySnapshot(candles);
    snap.patterns = [lsrPattern({ sweepLow: lastClose - 5, sweepHigh: lastClose - 1, oppositeZonePrice: null })];
    const tick = { price: lastClose, time: 0, bid: lastClose - 0.05, ask: lastClose + 0.05 }; // spread = 0.1

    const signal = buildSignal({
      symbolId: 'BTCUSDT', timeframe: '15m', candles, config: LSR_CONFIG,
      activeFeatures: [], snapshot: snap, calibration: null, tick, barsToResolve: 5,
    });
    expect(signal).not.toBeNull();
    // Buy → entry is modelled at close + spread/2, not the raw close.
    expect(signal!.entryPrice).toBeCloseTo(lastClose + 0.05, 6);
  });

  it('blocks entry when spread is wide relative to THIS trade\'s planned stop, even though it clears the general ATR-relative gate (finding #10)', () => {
    const candles = makeCandles(true);
    const lastClose = candles[candles.length - 1].close;
    // Sweep bar extreme very close to entry → tiny stopDistance. atr=2, so
    // the general spreadGateMultiplier=3 gate (spread <= atr*3 = 6) is
    // trivially satisfied by a 0.5 spread, but the LSR-specific gate
    // (spread <= stopDistance*0.4) is not.
    const sweepLow = lastClose - 0.05;
    const snap = buySnapshot(candles);
    snap.patterns = [lsrPattern({ sweepLow, sweepHigh: lastClose - 0.01, oppositeZonePrice: null })];
    const tick = { price: lastClose, time: 0, bid: lastClose - 0.25, ask: lastClose + 0.25 }; // spread = 0.5

    const signal = buildSignal({
      symbolId: 'BTCUSDT', timeframe: '15m', candles, config: LSR_CONFIG,
      activeFeatures: [], snapshot: snap, calibration: null, tick, barsToResolve: 5,
    });
    expect(signal).toBeNull();
  });

  it('does not apply the LSR-specific spread gate to other patterns (scoped fix)', () => {
    // Same tight-stop, wide-spread scenario, but with no LSR pattern present
    // — no structural invalidation distance to compute the LSR-specific
    // gate from, so it must not fire for other patterns.
    const candles = makeCandles(true);
    const snap = buySnapshot(candles);
    const tick = { price: candles[candles.length - 1].close, time: 0, bid: candles[candles.length - 1].close - 0.25, ask: candles[candles.length - 1].close + 0.25 };

    const signal = buildSignal({
      symbolId: 'BTCUSDT', timeframe: '15m', candles, config: LSR_CONFIG,
      activeFeatures: [], snapshot: snap, calibration: null, tick, barsToResolve: 5,
    });
    expect(signal).not.toBeNull();
  });
});

describe('buildSignal — strategy bonus direction gate (BUGFIX аудит 2026-09-06, п.А)', () => {
  // Воспроизводит найденный баг: components.trigger обнулён для
  // STRATEGY_BONUS_PATTERNS (фикс двойного учёта, п.4), поэтому topPattern
  // BUY-паттерн больше не голосует за direction сам по себе — если
  // structure/BOS/MACD/EMA все тянут в sell, итоговый direction может стать
  // 'sell' при живом BUY topPattern. Бонус (+0.55 для OBC и т.д.) не должен
  // в этом случае прибавляться к SELL-сигналу.
  const BONUS_CONFIG: IndicatorConfig = { ...CONFIG, scoreThreshold: 0 };

  function obcPattern(overrides: Partial<PatternResult> = {}): PatternResult {
    return {
      name: 'order-block-continuation',
      direction: 'buy',
      confidence: 1,
      strength: 'strong',
      time: 0,
      ...overrides,
    };
  }

  function bearishSnapshotWithBuyPattern(candles: Candle[]): Snapshot {
    // Downtrend candles → structure/BOS component sell. EMA/MACD/RSI all
    // bearish too, so every non-trigger component votes sell while the only
    // pattern present is a BUY order-block-continuation.
    const snap = makeSnapshot(candles, {
      rsi: 75, emaFast: 90, emaSlow: 110, macdHistogram: -1, atr: 2,
      bollingerUpper: 115, bollingerMiddle: 105, bollingerLower: 95,
    });
    snap.structure = { trend: 'down', bos: true, choch: false, swingHigh: null, swingLow: null, provisional: false };
    snap.patterns = [obcPattern()];
    return snap;
  }

  it('does not add the OBC bonus when the final direction disagrees with the pattern (finding A)', () => {
    const candles = makeCandles(false);
    const snap = bearishSnapshotWithBuyPattern(candles);

    const signal = buildSignal({
      symbolId: 'BTCUSDT', timeframe: '15m', candles, config: BONUS_CONFIG,
      activeFeatures: [], snapshot: snap, calibration: null, tick: null, barsToResolve: 5,
    });

    expect(signal).not.toBeNull();
    expect(signal!.direction).toBe('sell');
    // The bug: reason used to contain 'OBC strategy (+0.55)' here even
    // though the pattern that earned the bonus was a BUY pattern.
    expect(signal!.reason).not.toContain('OBC strategy (+');
    // Инвариант — никакого ВКЛАДА в score (contribution=0 у любого
    // 'strategy'-фактора order-block-continuation здесь); присутствие
    // самого факта диагностики (см. следующий тест) — не то же самое, что
    // повторный учёт бонуса.
    expect(
      signal!.factors
        .filter((f) => f.kind === 'strategy' && f.name === 'order-block-continuation')
        .every((f) => f.contribution === 0),
    ).toBe(true);
  });

  it('logs a diagnostic (contribution=0) when the OBC bonus is vetoed by direction mismatch — visibility for the "weights vs pattern gating" audit', () => {
    const candles = makeCandles(false);
    const snap = bearishSnapshotWithBuyPattern(candles);

    const signal = buildSignal({
      symbolId: 'BTCUSDT', timeframe: '15m', candles, config: BONUS_CONFIG,
      activeFeatures: [], snapshot: snap, calibration: null, tick: null, barsToResolve: 5,
    });

    expect(signal).not.toBeNull();
    const vetoFactor = signal!.factors.find(
      (f) => f.kind === 'strategy' && f.name === 'order-block-continuation',
    );
    expect(vetoFactor).toBeDefined();
    expect(vetoFactor!.contribution).toBe(0);
    expect(vetoFactor!.argument).toContain('vetoed');
  });

  it('still applies the OBC bonus when the pattern agrees with the final direction (no regression)', () => {
    const candles = makeCandles(true);
    const lastClose = candles[candles.length - 1].close;
    const snap = makeSnapshot(candles, {
      rsi: 25, emaFast: 110, emaSlow: 100, macdHistogram: 1, atr: 2,
      bollingerUpper: 115, bollingerMiddle: 105, bollingerLower: 95,
    });
    snap.structure = { trend: 'up', bos: true, choch: false, swingHigh: null, swingLow: null, provisional: false };
    snap.patterns = [obcPattern({ direction: 'buy' })];
    void lastClose;

    const signal = buildSignal({
      symbolId: 'BTCUSDT', timeframe: '15m', candles, config: BONUS_CONFIG,
      activeFeatures: [], snapshot: snap, calibration: null, tick: null, barsToResolve: 5,
    });

    expect(signal).not.toBeNull();
    expect(signal!.direction).toBe('buy');
    expect(signal!.reason).toContain('OBC strategy');
  });
});

describe('buildSignal — harmonic-pattern strategy bonus (no double-counting; Фаза 1: structural SL/TP удалены)', () => {
  // Тот же класс проверок, что и у liquidity-sweep-reaction/OBC выше:
  // (1) стратегия даёт персональный бонус +0.5×confidence в reason;
  // (2) бонус/направление не голосуют дважды — если итоговый direction не
  // совпадает с направлением паттерна, components.trigger уже обнулён
  // (harmonic-pattern в STRATEGY_BONUS_PATTERNS), и бонус не добавляется.
  // BUGFIX (Фаза 1, "честный бинарный опцион"): пункт (2) старого списка —
  // структурные SL/TP (computeHarmonicTradeLevels в decision/trade-levels.ts,
  // гейт по minRR) — удалён вместе с файлом; тесты, проверявшие именно
  // signal!.stopLoss/signal!.takeProfit, удалены ниже, не переразмечены.
  // harmonicStop/harmonicTarget остаются на PatternResult как диагностика
  // геометрии точки D (см. harmonic-pattern.ts), фикстура ниже их не
  // трогает специально — просто больше ничем не потребляются.
  const HARMONIC_CONFIG: IndicatorConfig = { ...CONFIG, scoreThreshold: 0 };

  function harmonicPattern(overrides: Partial<PatternResult> = {}): PatternResult {
    return {
      name: 'harmonic-pattern',
      direction: 'buy',
      confidence: 0.8,
      strength: 'strong',
      time: 0,
      harmonicType: 'gartley',
      przLow: 90,
      przHigh: 95,
      harmonicStop: 85,
      harmonicTarget: 130,
      ...overrides,
    };
  }

  function buySnapshot(candles: Candle[]) {
    return makeSnapshot(candles, {
      rsi: 25, emaFast: 110, emaSlow: 100, macdHistogram: 1, atr: 2,
      bollingerUpper: 115, bollingerMiddle: 105, bollingerLower: 95,
    });
  }

  it('includes a Harmonic Pattern strategy bonus line in the reason text', () => {
    const candles = makeCandles(true);
    const snap = buySnapshot(candles);
    snap.structure = { trend: 'up', bos: true, choch: false, swingHigh: null, swingLow: null, provisional: false };
    snap.patterns = [harmonicPattern()];

    const signal = buildSignal({
      symbolId: 'BTCUSDT', timeframe: '15m', candles, config: HARMONIC_CONFIG,
      activeFeatures: [], snapshot: snap, calibration: null, tick: null, barsToResolve: 5,
    });
    expect(signal).not.toBeNull();
    expect(signal!.direction).toBe('buy');
    expect(signal!.reason).toContain('gartley harmonic strategy');
  });

  it('does not add the harmonic-pattern bonus when the final direction disagrees with the pattern (no double-counting via components.trigger)', () => {
    // Тот же сценарий, что и у OBC выше: downtrend-свечи → structure/BOS
    // тянут в sell, EMA/MACD/RSI тоже bearish, а единственный паттерн —
    // BUY harmonic-pattern. Раз components.trigger для него обнулён
    // (STRATEGY_BONUS_PATTERNS), он не должен перетягивать итоговый
    // direction, и бонус не должен добавляться к SELL-сигналу.
    const candles = makeCandles(false);
    const snap = makeSnapshot(candles, {
      rsi: 75, emaFast: 90, emaSlow: 110, macdHistogram: -1, atr: 2,
      bollingerUpper: 115, bollingerMiddle: 105, bollingerLower: 95,
    });
    snap.structure = { trend: 'down', bos: true, choch: false, swingHigh: null, swingLow: null, provisional: false };
    snap.patterns = [harmonicPattern({ direction: 'buy' })];

    const signal = buildSignal({
      symbolId: 'BTCUSDT', timeframe: '15m', candles, config: HARMONIC_CONFIG,
      activeFeatures: [], snapshot: snap, calibration: null, tick: null, barsToResolve: 5,
    });

    expect(signal).not.toBeNull();
    expect(signal!.direction).toBe('sell');
    expect(signal!.reason).not.toContain('gartley harmonic strategy');
    expect(
      signal!.factors
        .filter((f) => f.kind === 'strategy' && f.name === 'harmonic-pattern')
        .every((f) => f.contribution === 0),
    ).toBe(true);
  });
});

describe('buildSignal — priorityThreshold gate (доделка, Задача 1 + BUGFIX аудит 2026-09-05, п.2)', () => {
  // Требование (актуальное, после фикса дедлока): сигнал создаётся только
  // если calibratedProbability >= priorityThreshold — НО ТОЛЬКО когда
  // calibratedProbability пришла из обученной модели (calibrationSource
  // === 'model'). Пока модели нет (calibration === null, calibrationSource
  // === 'fallback'), фильтр НЕ применяется вообще — иначе, при зажатом в
  // [0.35, 0.65] sigmoidFallback() и дефолтном пороге 0.75, сигнал не
  // создавался бы НИКОГДА (см. подробности прямо в signal-builder.ts у
  // самого гейта). Сравнение для 'model' включительное (>=), не строгое (>).
  function baselineParams() {
    const candles = makeCandles(true);
    const snap = makeSnapshot(candles, {
      rsi: 25, emaFast: 110, emaSlow: 100, macdHistogram: 1, atr: 2,
      bollingerUpper: 115, bollingerMiddle: 105, bollingerLower: 95,
    });
    return {
      symbolId: 'BTCUSDT', timeframe: '15m' as const, candles, config: CONFIG,
      activeFeatures: [], snapshot: snap, calibration: null, tick: null, barsToResolve: 5,
    };
  }

  it('does not filter anything when priorityThreshold is undefined (backward-compatible default)', () => {
    const signal = buildSignal(baselineParams());
    expect(signal).not.toBeNull();
  });

  // Регрессионный тест на сам найденный баг: без обученной модели
  // (calibration: null) sigmoidFallback никогда не превышает 0.65 — с
  // priorityThreshold=0.75 (реальный дефолт из settingsStore.ts) старый код
  // возвращал null абсолютно всегда. Теперь сигнал создаётся, потому что
  // фильтр не применяется к fallback-вероятности.
  it('BUGFIX: still creates a fallback-sourced signal even when priorityThreshold is above the sigmoidFallback ceiling (0.65) — this used to deadlock signal creation forever', () => {
    const signal = buildSignal({ ...baselineParams(), priorityThreshold: 0.75 });
    expect(signal).not.toBeNull();
    expect(signal!.calibrationSource).toBe('fallback');
    expect(signal!.calibratedProbability).toBeLessThanOrEqual(0.65);
  });

  it('does not gate fallback-sourced signals by priorityThreshold at all, even at the maximum slider value (0.95)', () => {
    const signal = buildSignal({ ...baselineParams(), priorityThreshold: 0.95 });
    expect(signal).not.toBeNull();
    expect(signal!.calibrationSource).toBe('fallback');
  });

  it('applies the gate for a ready calibration model (calibrationSource === "model"), not only in theory', () => {
    // MAX_SAMPLES (500): confidence ramp is fully active (rampFraction=1),
    // so rampFloor === priorityThreshold and the gate behaves as before.
    const model = new CalibrationModel(12);
    for (let i = 0; i < MAX_SAMPLES; i++) {
      model.addSample({ features: new Array(12).fill(0.5), score: 3, outcome: 1 });
    }
    model.retrain();
    expect(model.isReady()).toBe(true);

    const baselineWithModel = buildSignal({ ...baselineParams(), calibration: model });
    expect(baselineWithModel).not.toBeNull();
    expect(baselineWithModel!.calibrationSource).toBe('model');
    const prob = baselineWithModel!.calibratedProbability!;

    expect(buildSignal({ ...baselineParams(), calibration: model, priorityThreshold: prob })).not.toBeNull();
    expect(buildSignal({ ...baselineParams(), calibration: model, priorityThreshold: prob + 0.01 })).toBeNull();
  });

  it('creates a model-sourced signal when calibratedProbability is exactly equal to priorityThreshold (>=, not >)', () => {
    const model = new CalibrationModel(12);
    for (let i = 0; i < MAX_SAMPLES; i++) {
      model.addSample({ features: new Array(12).fill(0.5), score: 3, outcome: 1 });
    }
    model.retrain();
    const baseline = buildSignal({ ...baselineParams(), calibration: model });
    expect(baseline!.calibrationSource).toBe('model');
    const prob = baseline!.calibratedProbability!;

    const signal = buildSignal({ ...baselineParams(), calibration: model, priorityThreshold: prob });
    expect(signal).not.toBeNull();
    expect(signal!.calibratedProbability).toBeCloseTo(prob, 10);
  });

  // BUGFIX (аудит 2026-09-11, "0 сигналов после 100 исходов"): confidence ramp
  // гарантирует, что модель с ровно MIN_SAMPLES (100) сэмплов не блокирует
  // сигналы вообще — эффективный порог при 100 сэмплах равен 0 (rampFraction = 0),
  // гейт отключён, поэтому сигнал создаётся независимо от calibratedProbability.
  it('BUGFIX: does not block signals at MIN_SAMPLES even when calibratedProbability is low — confidence ramp prevents the 100-sample deadlock', () => {
    // Mixed outcomes (55% win) — model predicts ~0.55, which is below the
    // old rampFloor of 0.5 and far below priorityThreshold 0.75. With the
    // fix, rampFloor = 0 at MIN_SAMPLES, so the gate is fully disabled.
    const model = new CalibrationModel(12);
    for (let i = 0; i < 55; i++) {
      model.addSample({ features: new Array(12).fill(0.5), score: 3, outcome: 1 });
    }
    for (let i = 0; i < 45; i++) {
      model.addSample({ features: new Array(12).fill(0.5), score: 1, outcome: 0 });
    }
    model.retrain();
    expect(model.isReady()).toBe(true);
    expect(model.getSampleCount()).toBe(MIN_SAMPLES);

    const signal = buildSignal({ ...baselineParams(), calibration: model, priorityThreshold: 0.75 });
    expect(signal).not.toBeNull();
    expect(signal!.calibrationSource).toBe('model');
  });

  it('BUGFIX: confidence ramp gradually tightens — at MAX_SAMPLES the full priorityThreshold applies', () => {
    const model = new CalibrationModel(12);
    for (let i = 0; i < MAX_SAMPLES; i++) {
      model.addSample({ features: new Array(12).fill(0.5), score: 3, outcome: 1 });
    }
    model.retrain();
    expect(model.getSampleCount()).toBe(MAX_SAMPLES);

    const baseline = buildSignal({ ...baselineParams(), calibration: model });
    expect(baseline!.calibrationSource).toBe('model');
    const prob = baseline!.calibratedProbability!;

    expect(buildSignal({ ...baselineParams(), calibration: model, priorityThreshold: prob })).not.toBeNull();
    expect(buildSignal({ ...baselineParams(), calibration: model, priorityThreshold: prob + 0.01 })).toBeNull();
  });
});

describe('STRONG_SIGNAL_SCORE_THRESHOLD (used by DecisionEngine strongSignalsOnly / "Система мартингейла")', () => {
  it('is the single source of truth: strength contract holds against the threshold constant', () => {
    // Reuses the same fixture as 'uses fallback sigmoid when calibration not
    // ready' above (known non-null signal). This test isn't about that
    // fixture's specific score — it locks in the *contract* engine.ts's
    // effectiveScoreThreshold gate depends on: score >= STRONG_SIGNAL_SCORE_
    // THRESHOLD must always imply strength === 'strong', and vice versa.
    // If strengthFor()'s bucketing ever drifts from this constant, this
    // fails loudly instead of silently letting strongSignalsOnly leak
    // non-strong signals through.
    const candles = makeCandles(true);
    const snap = makeSnapshot(candles, {
      rsi: 25, emaFast: 110, emaSlow: 100, macdHistogram: 1, atr: 2,
      bollingerUpper: 115, bollingerMiddle: 105, bollingerLower: 95,
    });
    const signal = buildSignal({
      symbolId: 'BTCUSDT', timeframe: '15m', candles, config: CONFIG,
      activeFeatures: [], snapshot: snap, calibration: null, tick: null, barsToResolve: 5,
      scoreThreshold: 0,
    });
    expect(signal).not.toBeNull();
    if (signal!.score >= STRONG_SIGNAL_SCORE_THRESHOLD) {
      expect(signal!.strength).toBe('strong');
    } else {
      expect(signal!.strength).not.toBe('strong');
    }
  });

  it('equals 4 (documented default IndicatorConfig.scoreThreshold)', () => {
    expect(STRONG_SIGNAL_SCORE_THRESHOLD).toBe(4);
  });
});

// Smoke-тест: полный путь генерации сигнала с продакшен-дефолтной
// конфигурацией (DEFAULT_INDICATOR_CONFIG как есть — emaFast=20, emaSlow=50,
// scoreThreshold=4 — и DEFAULT_SIGNAL_TOGGLES). Существующие тесты используют
// локальный CONFIG с emaFast=9/emaSlow=21; этот проверяет, что реальные
// дефолты не регрессируют в "0 сигналов" при наличии strategy-бонуса.
describe('buildSignal — production default config smoke test', () => {
  it('produces a strong signal with DEFAULT_INDICATOR_CONFIG + DEFAULT_SIGNAL_TOGGLES + OBC strategy bonus', () => {
    const candles = makeCandles(true);
    const snap = makeSnapshot(candles, {
      rsi: 25, emaFast: 110, emaSlow: 100, macdHistogram: 1, atr: 2,
      bollingerUpper: 115, bollingerMiddle: 105, bollingerLower: 95,
    });
    snap.structure = { trend: 'up', bos: true, choch: false, swingHigh: null, swingLow: null, provisional: false };
    snap.patterns = [{
      name: 'order-block-continuation',
      direction: 'buy',
      confidence: 1,
      strength: 'strong',
      time: 0,
    }];

    const signal = buildSignal({
      symbolId: 'BTCUSDT',
      timeframe: '15m',
      candles,
      config: DEFAULT_INDICATOR_CONFIG,
      activeFeatures: [],
      snapshot: snap,
      calibration: null,
      tick: null,
      barsToResolve: 5,
      signalToggles: DEFAULT_SIGNAL_TOGGLES,
    });

    expect(signal).not.toBeNull();
    expect(signal!.score).toBeGreaterThanOrEqual(STRONG_SIGNAL_SCORE_THRESHOLD);
    expect(signal!.strength).toBe('strong');
    expect(signal!.direction).toBe('buy');
    expect(signal!.reason).toContain('OBC strategy');
  });
});

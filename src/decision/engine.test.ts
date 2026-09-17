import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Candle, Signal } from '@/types/domain';
import { buildFullSnapshot } from '@/compute/full-snapshot';
import { DecisionEngine, computeEffectiveScoreThreshold } from './engine';
import { OutcomeScheduler, resolveOutcome, getCandlesAfterSignal } from './outcome-scheduler';
import { CalibrationModel, persistCalibrationState, loadCalibrationState, MIN_SAMPLES } from './calibration-model';
import { DEFAULT_INDICATOR_CONFIG, ALL_FEATURES } from '@/types/domain';

// evaluate() now gets its snapshot from workerClient.snapshotRequest() instead
// of calling buildFullSnapshot() directly (see engine.ts). For these unit
// tests we don't want a real Worker (unavailable in jsdom), so we mock
// WorkerClient's singleton to just call the real buildFullSnapshot()
// synchronously — this keeps the assertions below (which rely on real
// indicator/pattern output) meaningful, while avoiding worker plumbing.
// (vi.mock calls are hoisted above imports by vitest, so this applies before
// './engine' is evaluated regardless of statement order.)
vi.mock('@/compute/WorkerClient', () => ({
  workerClient: {
    snapshotRequest: vi.fn(
      (
        _symbolId: string,
        _timeframe: string,
        candles: Candle[],
        config: Parameters<typeof buildFullSnapshot>[1],
        activeFeatures: Parameters<typeof buildFullSnapshot>[2],
        isClosed: boolean,
      ) => Promise.resolve(buildFullSnapshot(candles, config, activeFeatures, isClosed)),
    ),
  },
}));

// BUGFIX (аудит 2026-09-06, п.2): scoreThreshold по умолчанию поднят 2→4,
// откалиброван на реальном движке с паттернами/стратегиями. Синтетические
// фикстуры в этом файле — идеальная линейная свеча за свечой без единого
// вика/отката — намеренно не порождают НИ ОДНОГО свечного/SMC паттерна (см.
// `patterns: []` при отладке "evaluate returns a signal for valid uptrend
// candles"), то есть проверяют работу движка (BOS/структура/индикаторы,
// пайплайн closed→signal, calibration hookup и т.д.), а не реалистичный
// score реального рынка, где направленное движение почти всегда сопровож-
// дается хоть каким-то паттерном. DecisionEngine берёт scoreThreshold из
// СВОИХ конструкторных опций (this.scoreThreshold), а не из этого config —
// см. каждый `new DecisionEngine({..., scoreThreshold: 0})` ниже.
const CONFIG = {
  ...DEFAULT_INDICATOR_CONFIG,
  rsiPeriod: 14, emaFast: 9, emaSlow: 21,
  macdFast: 12, macdSlow: 26, macdSignal: 9,
  atrPeriod: 14, bbPeriod: 20, bbStdDev: 2,
};

function makeUptrendCandles(): Candle[] {
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < 60; i++) {
    const open = price;
    const close = price + 2;
    candles.push({ time: i * 900, open, high: close + 1, low: open - 1, close, volume: 100 });
    price = close;
  }
  return candles;
}

function makeSignal(overrides?: Partial<Signal>): Signal {
  return {
    id: 'test-signal-1',
    symbolId: 'BTCUSDT',
    direction: 'buy',
    strength: 'moderate',
    score: 3,
    calibratedProbability: 0.6,
    entryPrice: 100,
    reason: 'test',
    indicators: {
      rsi: 25, emaFast: 110, emaSlow: 100, macd: 1, macdSignal: 0.5, macdHistogram: 0.5,
      atr: 5, bollingerUpper: 115, bollingerMiddle: 105, bollingerLower: 95,
      vwap: null, vwapIsProxyVolume: false, volumeProfilePoc: null, volumeProfilePocIsProxyVolume: false,
      meanReversionRsi: null, impulseVelocity: null, adx: null,
    },
    pattern: null,
    time: 1000,
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
    ...overrides,
  };
}

describe('DecisionEngine', () => {
  it('evaluate returns null for insufficient candles', async () => {
    const eng = new DecisionEngine({ calibration: null, barsToResolve: 5, scoreThreshold: 0 });
    const result = await eng.evaluate('BTCUSDT', '15m', [], CONFIG, [], null, Date.now());
    expect(result).toBeNull();
  });

  it('evaluate returns a signal for valid uptrend candles', async () => {
    const eng = new DecisionEngine({ calibration: null, barsToResolve: 5, scoreThreshold: 0 });
    const candles = makeUptrendCandles();
    const serverNow = candles[candles.length - 1].time * 1000 - 10000;
    // ВАЖНО: activeFeatures: [] означает «ничего не выбрано» (см. фикс
    // в full-snapshot.ts и др.), а не «фильтра нет — включено всё». Этот
    // тест проверяет генерацию сигнала при обычной работе движка, поэтому
    // передаём полный набор фич, как это делают реальные настройки по
    // умолчанию (settingsStore: activePatterns/activeIndicators = ALL_*).
    const result = await eng.evaluate('BTCUSDT', '15m', candles, CONFIG, [...ALL_FEATURES], null, serverNow);
    expect(result).not.toBeNull();
  });

  it('drops a stale response when two evaluate() calls for the SAME candleTime resolve out of order', async () => {
    // Regression test: guard used to compare only candleTime
    // (pendingRequestCandleTime), which can't tell apart two in-flight
    // requests for the same candle. If the worker resolves them out of
    // order, the older (stale) response could overwrite the newer one.
    // The fix compares a monotonic requestSeq instead.
    const { workerClient } = await import('@/compute/WorkerClient');
    // vi.mocked() only wraps the reference for typing; it never invokes it detached from `this`.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockFn = vi.mocked(workerClient.snapshotRequest);
    const candles = makeUptrendCandles();
    const serverNow = candles[candles.length - 1].time * 1000 - 10000;

    const emptySeries = {
      rsi: [], emaFast: [], emaSlow: [], macd: [], macdSignal: [], macdHistogram: [],
      bollingerUpper: [], bollingerMiddle: [], bollingerLower: [],
    };
    const baseSnapshot = buildFullSnapshot(candles, CONFIG, [...ALL_FEATURES], true).snapshot;
    const staleSnapshot = { ...baseSnapshot, lastPrice: 111 };
    const freshSnapshot = { ...baseSnapshot, lastPrice: 222 };

    let resolveStale!: (v: unknown) => void;
    let resolveFresh!: (v: unknown) => void;
    const stalePromise = new Promise((res) => { resolveStale = res; });
    const freshPromise = new Promise((res) => { resolveFresh = res; });
    mockFn.mockImplementationOnce(() => stalePromise as ReturnType<typeof mockFn>);
    mockFn.mockImplementationOnce(() => freshPromise as ReturnType<typeof mockFn>);

    const eng = new DecisionEngine({ calibration: null, barsToResolve: 5, scoreThreshold: 0 });

    // Two evaluate() calls for the same candleTime (e.g. two pre-close
    // checks with a tick update in between), both reach the worker before
    // either resolves.
    const staleCall = eng.evaluate('BTCUSDT', '15m', candles, CONFIG, [...ALL_FEATURES], null, serverNow);
    const freshCall = eng.evaluate('BTCUSDT', '15m', candles, CONFIG, [...ALL_FEATURES], null, serverNow);

    // Resolve the NEWER request first, THEN the older one — out-of-order
    // worker resolution.
    resolveFresh({ snapshot: freshSnapshot, series: emptySeries });
    const freshResult = await freshCall;
    resolveStale({ snapshot: staleSnapshot, series: emptySeries });
    const staleResult = await staleCall;

    expect(freshResult).not.toBeNull();
    expect(staleResult).toBeNull(); // the late-arriving stale response must be dropped
    expect(eng.getLastSnapshot()?.lastPrice).toBe(222); // not overwritten by the stale one
  });

  it('onCandleClosed returns the frozen signal and clears state', () => {
    const eng = new DecisionEngine({ calibration: null, barsToResolve: 5, scoreThreshold: 0 });
    expect(eng.onCandleClosed()).toBeNull();
  });

  // Audit finding D1 ("Реакция на снятие ликвидности"): a signal frozen
  // pre-close for a hard-geometry pattern (liquidity-sweep-reaction,
  // impulse-breakout, consolidation-breakout) must be revalidated against
  // the bar's ACTUAL close, not handed out as final unconditionally.
  describe('hard-geometry pattern revalidation at candle close (audit finding D1)', () => {
    function seedFrozen(eng: DecisionEngine, pattern: Signal['pattern'], candleTime: number): Signal {
      const frozen = makeSignal({ pattern, time: candleTime, entryPrice: 999_999, frozenAt: candleTime * 1000 });
      // White-box: DecisionEngine has no public setter for pre-close-frozen
      // state — this is the only way to set up "a signal was already frozen
      // for this exact candle" without re-deriving that state from a full
      // pre-close evaluate() call (which would require engineering a real
      // impulse-breakout/liquidity-sweep-reaction detection through the
      // whole indicator pipeline just to get a pattern name).
      (eng as unknown as { frozenSignal: Signal | null; frozenCandleTime: number | null }).frozenSignal = frozen;
      (eng as unknown as { frozenSignal: Signal | null; frozenCandleTime: number | null }).frozenCandleTime = candleTime;
      return frozen;
    }

    it('drops the frozen signal at close if the hard-geometry pattern no longer produces a signal', async () => {
      const eng = new DecisionEngine({ calibration: null, barsToResolve: 5, scoreThreshold: 0 });
      // Deliberately below warmup — buildSignal() will return null regardless
      // of the frozen value, standing in for "the actual close no longer
      // satisfies the pattern's geometry".
      const candles = makeUptrendCandles().slice(0, 3);
      const candleTime = candles[candles.length - 1].time;
      seedFrozen(eng, 'impulse-breakout', candleTime);

      const serverNow = candleTime * 1000 + 1;
      const result = await eng.evaluate('BTCUSDT', '15m', candles, CONFIG, [...ALL_FEATURES], null, serverNow, true);

      expect(result).toBeNull();
      expect(eng.getFrozenSignal()).toBeNull();
      expect(eng.onCandleClosed()).toBeNull();
    });

    it('replaces the frozen signal at close with a freshly computed one for a hard-geometry pattern', async () => {
      const eng = new DecisionEngine({ calibration: null, barsToResolve: 5, scoreThreshold: 0 });
      const candles = makeUptrendCandles();
      const candleTime = candles[candles.length - 1].time;
      seedFrozen(eng, 'liquidity-sweep-reaction', candleTime);

      const serverNow = candleTime * 1000 + 1;
      const result = await eng.evaluate('BTCUSDT', '15m', candles, CONFIG, [...ALL_FEATURES], null, serverNow, true);

      expect(result).not.toBeNull();
      // The stale frozen dummy (entryPrice 999_999) must not survive —
      // the returned signal is a fresh computation on the closed bar.
      expect(result!.entryPrice).not.toBe(999_999);
      expect(eng.getFrozenSignal()?.entryPrice).not.toBe(999_999);
    });

    it('keeps the pre-close fast path for patterns outside the hard-geometry set, even at close', async () => {
      const eng = new DecisionEngine({ calibration: null, barsToResolve: 5, scoreThreshold: 0 });
      // Below warmup, same as the drop-case above — but with a NON-hard-
      // geometry pattern this must NOT trigger revalidation: the frozen
      // value is returned as-is via the fast path, exactly like before this
      // audit fix, because these patterns' geometry doesn't have the same
      // last-second-flip risk this fix targets.
      const candles = makeUptrendCandles().slice(0, 3);
      const candleTime = candles[candles.length - 1].time;
      const frozen = seedFrozen(eng, 'hammer', candleTime);

      const serverNow = candleTime * 1000 + 1;
      const result = await eng.evaluate('BTCUSDT', '15m', candles, CONFIG, [...ALL_FEATURES], null, serverNow, true);

      expect(result).toBe(frozen);
      expect(eng.getFrozenSignal()).toBe(frozen);
    });
  });

  it('emits pre-close signals throughout the 5-second window before close', () => {
    const eng = new DecisionEngine({ calibration: null, barsToResolve: 5, scoreThreshold: 0 });
    const candleTime = 1_000;
    const closeTimeMs = (candleTime + 900) * 1000;

    // 6 seconds before close — outside the window, should not emit
    expect(eng.shouldEmitPreClose(closeTimeMs - 6_000, candleTime, 900)).toBe(false);

    // Exactly 5 seconds before close — first moment of the window
    expect(eng.shouldEmitPreClose(closeTimeMs - 5_000, candleTime, 900)).toBe(true);

    // 3 seconds before close — inside the window
    expect(eng.shouldEmitPreClose(closeTimeMs - 3_000, candleTime, 900)).toBe(true);

    // 1 second before close — still inside
    expect(eng.shouldEmitPreClose(closeTimeMs - 1_000, candleTime, 900)).toBe(true);

    // At or after close — outside
    expect(eng.shouldEmitPreClose(closeTimeMs, candleTime, 900)).toBe(false);
    expect(eng.shouldEmitPreClose(closeTimeMs + 1_000, candleTime, 900)).toBe(false);
  });

  it('recordOutcome adds sample and retrains calibration', () => {
    const model = new CalibrationModel(12);
    const eng = new DecisionEngine({ calibration: model, barsToResolve: 5, scoreThreshold: 0 });
    const signal = makeSignal();
    const record = eng.recordOutcome(signal, 'win');
    expect(record).not.toBeNull();
    expect(record!.outcome).toBe('win');
    expect(model.getSampleCount()).toBe(1);
  });

  it('recordOutcome returns null for pending outcome', () => {
    const model = new CalibrationModel(12);
    const eng = new DecisionEngine({ calibration: model, barsToResolve: 5, scoreThreshold: 0 });
    const signal = makeSignal();
    expect(eng.recordOutcome(signal, 'pending')).toBeNull();
  });

  it('recordOutcome returns null when no calibration model', () => {
    const eng = new DecisionEngine({ calibration: null, barsToResolve: 5, scoreThreshold: 0 });
    const signal = makeSignal();
    expect(eng.recordOutcome(signal, 'win')).toBeNull();
  });

  // Аудит-ревью Этапа 1 (нюанс QA — per-symbol calibration routing): раньше
  // recordOutcome() всегда писал сэмпл в this.calibration (модель, заданную
  // конструктором/setCalibration — т.е. модель ТЕКУЩЕГО активного символа),
  // а вызывающий код (outcomes.ts) отдельно искал модель по signal.symbolId
  // только для triggerRetrain. Эти две модели совпадали лишь благодаря
  // побочному эффекту в другом модуле (useTickStore.start() дренирует
  // outcomeScheduler при смене символа) — здесь же явно проверяем, что
  // третий (explicit) параметр — самостоятельный источник истины и
  // ПЕРЕОПРЕДЕЛЯЕТ this.calibration, а не совпадает с ним "по счастливой
  // случайности".
  it('recordOutcome writes the sample into the explicitly passed model, not this.calibration, when both are given', () => {
    const activeSymbolModel = new CalibrationModel(12);
    const otherSymbolModel = new CalibrationModel(12);
    const eng = new DecisionEngine({ calibration: activeSymbolModel, barsToResolve: 5, scoreThreshold: 0 });
    const signal = makeSignal();

    const record = eng.recordOutcome(signal, 'win', otherSymbolModel);

    expect(record).not.toBeNull();
    expect(otherSymbolModel.getSampleCount()).toBe(1);
    expect(activeSymbolModel.getSampleCount()).toBe(0);
  });

  it('recordOutcome falls back to this.calibration when the explicit model param is omitted (back-compat)', () => {
    const model = new CalibrationModel(12);
    const eng = new DecisionEngine({ calibration: model, barsToResolve: 5, scoreThreshold: 0 });
    const signal = makeSignal();

    eng.recordOutcome(signal, 'win');

    expect(model.getSampleCount()).toBe(1);
  });

  it('recordOutcome returns null when an explicit null model is passed, even if this.calibration is set', () => {
    const activeSymbolModel = new CalibrationModel(12);
    const eng = new DecisionEngine({ calibration: activeSymbolModel, barsToResolve: 5, scoreThreshold: 0 });
    const signal = makeSignal();

    const record = eng.recordOutcome(signal, 'win', null);

    expect(record).toBeNull();
    expect(activeSymbolModel.getSampleCount()).toBe(0);
  });
});

describe('OutcomeScheduler', () => {
  // Аудит (синхронизация с демо-счётом): resolveOutcome больше не проверяет
  // касание stopLoss/takeProfit за N свечей — исход определяется РОВНО так
  // же, как реальная демо-сделка (useDemoAccountStore::resolveTrade): close
  // первой же свечи после сигнала против entryPrice, фиксированная выплата.
  it('resolveOutcome detects a win (buy: close above entry)', () => {
    const signal = makeSignal({ direction: 'buy', entryPrice: 100 });
    const candles: Candle[] = [
      { time: 2000, open: 100, high: 125, low: 99, close: 122, volume: 10 },
    ];
    const result = resolveOutcome(signal, candles);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe('win');
  });

  it('resolveOutcome detects a loss (buy: close below entry)', () => {
    const signal = makeSignal({ direction: 'buy', entryPrice: 100 });
    const candles: Candle[] = [
      { time: 2000, open: 100, high: 101, low: 88, close: 89, volume: 10 },
    ];
    const result = resolveOutcome(signal, candles);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe('loss');
  });

  it('resolveOutcome detects a sell win (close below entry)', () => {
    const signal = makeSignal({ direction: 'sell', entryPrice: 100 });
    const candles: Candle[] = [
      { time: 2000, open: 100, high: 101, low: 78, close: 79, volume: 10 },
    ];
    const result = resolveOutcome(signal, candles);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe('win');
  });

  it('resolveOutcome detects a sell loss (close above entry)', () => {
    const signal = makeSignal({ direction: 'sell', entryPrice: 100 });
    const candles: Candle[] = [
      { time: 2000, open: 100, high: 112, low: 99, close: 111, volume: 10 },
    ];
    const result = resolveOutcome(signal, candles);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe('loss');
  });

  it('resolveOutcome returns timeout when close equals entry (tie)', () => {
    const signal = makeSignal({ direction: 'buy', entryPrice: 100 });
    const candles: Candle[] = [
      { time: 2000, open: 100, high: 101, low: 99, close: 100, volume: 10 },
    ];
    const result = resolveOutcome(signal, candles);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe('timeout');
  });

  it('resolveOutcome only looks at the first future candle, ignoring later ones', () => {
    // Раньше (SL/TP-модель) второй свечи хватало, чтобы развернуть исход в
    // пределах barsToResolve — теперь резолв происходит строго на первой же
    // свече после сигнала, дальнейшие свечи не читаются вовсе.
    const signal = makeSignal({ direction: 'buy', entryPrice: 100 });
    const candles: Candle[] = [
      { time: 2000, open: 100, high: 101, low: 99, close: 105, volume: 10 },
      { time: 3000, open: 105, high: 106, low: 50, close: 51, volume: 10 },
    ];
    const result = resolveOutcome(signal, candles);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe('win');
  });

  it('resolveOutcome returns null when there are no future candles yet', () => {
    const signal = makeSignal({ entryPrice: 100 });
    const result = resolveOutcome(signal, []);
    expect(result).toBeNull();
  });

  it('resolveOutcome returns null for non-pending signal', () => {
    const signal = makeSignal({ outcome: 'win' });
    const result = resolveOutcome(signal, []);
    expect(result).toBeNull();
  });

  it('getCandlesAfterSignal filters correctly', () => {
    const candles: Candle[] = [
      { time: 500, open: 1, high: 2, low: 0, close: 1, volume: 1 },
      { time: 1000, open: 1, high: 2, low: 0, close: 1, volume: 1 },
      { time: 1500, open: 1, high: 2, low: 0, close: 1, volume: 1 },
      { time: 2000, open: 1, high: 2, low: 0, close: 1, volume: 1 },
    ];
    const after = getCandlesAfterSignal(candles, 1000);
    expect(after.length).toBe(2);
    expect(after[0].time).toBe(1500);
  });

  it('scheduler schedules and resolves signals', () => {
    const sched = new OutcomeScheduler();
    const signal = makeSignal({ time: 1000, direction: 'buy', entryPrice: 100 });
    sched.schedule(signal);
    expect(sched.getPendingCount()).toBe(1);

    const allCandles: Candle[] = [
      { time: 500, open: 1, high: 2, low: 0, close: 1, volume: 1 },
      { time: 1000, open: 1, high: 2, low: 0, close: 1, volume: 1 },
      { time: 1500, open: 100, high: 210, low: 99, close: 200, volume: 10 },
    ];

    sched.onCandleClosed(allCandles, (resolved) => {
      expect(resolved.outcome).toBe('win');
    });
    expect(sched.getPendingCount()).toBe(0);
  });

  it('scheduler does not schedule non-pending signals', () => {
    const sched = new OutcomeScheduler();
    sched.schedule(makeSignal({ outcome: 'win' }));
    expect(sched.getPendingCount()).toBe(0);
  });

  it('scheduler clears', () => {
    const sched = new OutcomeScheduler();
    sched.schedule(makeSignal());
    sched.clear();
    expect(sched.getPendingCount()).toBe(0);
  });
});

describe('DecisionEngine — strongSignalsOnly ("Система мартингейла")', () => {
  // makeUptrendCandles() with scoreThreshold: 0 reliably produces a
  // 'moderate' signal (score ≈ 3.999999999999991, floating-point short of
  // the 4.0 STRONG_SIGNAL_SCORE_THRESHOLD — see probe run during
  // development). That makes it a real below-'strong' fixture, not a
  // hand-picked edge case, so it is the right fixture to prove
  // strongSignalsOnly actually suppresses non-strong signals rather than
  // trivially passing because nothing under 'strong' was ever produced.
  function evaluateUptrend(eng: DecisionEngine) {
    const candles = makeUptrendCandles();
    const serverNow = candles[candles.length - 1].time * 1000 - 10000;
    return eng.evaluate('BTCUSDT', '15m', candles, CONFIG, [...ALL_FEATURES], null, serverNow);
  }

  it('suppresses a non-strong signal when strongSignalsOnly is enabled at construction', async () => {
    const baseline = new DecisionEngine({ calibration: null, barsToResolve: 5, scoreThreshold: 0 });
    const baselineResult = await evaluateUptrend(baseline);
    expect(baselineResult).not.toBeNull();
    expect(baselineResult!.strength).toBe('moderate');

    const eng = new DecisionEngine({
      calibration: null,
      barsToResolve: 5,
      scoreThreshold: 0,
      strongSignalsOnly: true,
    });
    const result = await evaluateUptrend(eng);
    expect(result).toBeNull();
  });

  it('does not suppress anything when strongSignalsOnly is false (default)', async () => {
    const eng = new DecisionEngine({ calibration: null, barsToResolve: 5, scoreThreshold: 0 });
    const result = await evaluateUptrend(eng);
    expect(result).not.toBeNull();
    expect(result!.strength).toBe('moderate');
  });

  it('never LOWERS an explicit stricter scoreThreshold when toggled on (pure function, unambiguous)', () => {
    // Direct test of computeEffectiveScoreThreshold — see engine.ts for why
    // the earlier integration-only version of this test was a false-
    // positive risk. Plain numbers, no fixture-score coincidence possible.
    expect(computeEffectiveScoreThreshold(5, true)).toBe(5);
    expect(computeEffectiveScoreThreshold(6, true)).toBe(6);
    // Below the strong floor: strongSignalsOnly must raise it to 4.
    expect(computeEffectiveScoreThreshold(0, true)).toBe(4);
    expect(computeEffectiveScoreThreshold(2, true)).toBe(4);
    // Disabled: passes the user's threshold through completely untouched,
    // in both directions (no flooring at all when off).
    expect(computeEffectiveScoreThreshold(6, false)).toBe(6);
    expect(computeEffectiveScoreThreshold(0, false)).toBe(0);
  });

  it('never LOWERS an explicit stricter scoreThreshold when toggled on (end-to-end sanity check)', async () => {
    // Keeps an integration-level check too, now correctly scoped: this only
    // asserts "still blocked", which is consistent with either a correct or
    // a buggy Math.max — the actual direction is proven by the pure-function
    // test above, this one just guards against effectiveScoreThreshold not
    // being wired into buildSignal() at all.
    const eng = new DecisionEngine({
      calibration: null,
      barsToResolve: 5,
      scoreThreshold: 5,
      strongSignalsOnly: true,
    });
    const result = await evaluateUptrend(eng);
    expect(result).toBeNull();
  });

  it('setStrongSignalsOnly(true) suppresses live, without recreating the engine', async () => {
    const eng = new DecisionEngine({ calibration: null, barsToResolve: 5, scoreThreshold: 0 });
    const before = await evaluateUptrend(eng);
    expect(before).not.toBeNull();

    eng.setStrongSignalsOnly(true);
    const after = await evaluateUptrend(eng);
    expect(after).toBeNull();
  });

  it('setStrongSignalsOnly(false) restores non-strong signals live', async () => {
    const eng = new DecisionEngine({
      calibration: null,
      barsToResolve: 5,
      scoreThreshold: 0,
      strongSignalsOnly: true,
    });
    const suppressed = await evaluateUptrend(eng);
    expect(suppressed).toBeNull();

    eng.setStrongSignalsOnly(false);
    const restored = await evaluateUptrend(eng);
    expect(restored).not.toBeNull();
    expect(restored!.strength).toBe('moderate');
  });

  // BUGFIX (self-audit, 2026-09-11): found via adversarial review of this
  // exact feature. A 'moderate'/'weak' signal frozen via the pre-close fast
  // path (see snapshot()/shouldFreeze in engine.ts) is cached on
  // `this.frozenSignal` and served SYNCHRONOUSLY on subsequent evaluate()
  // calls for up to FROZEN_SIGNAL_MAX_AGE_MS (60s) — a fast path that used
  // to run BEFORE any strongSignalsOnly check existed. If the user toggles
  // "Система мартингейла" ON while such a frozen non-strong signal is still
  // within its 60s window, the old code would keep serving it verbatim,
  // completely bypassing both the effectiveScoreThreshold gate and the
  // defense-in-depth strength check (neither runs on the fast-path early
  // return). Fixed by invalidating a stale non-strong frozen signal the
  // moment strongSignalsOnly is (or becomes) true — see frozenSatisfiesStrongOnly
  // in engine.ts.
  it('BUGFIX: does not serve a stale non-strong FROZEN signal once strongSignalsOnly is toggled on', async () => {
    const eng = new DecisionEngine({ calibration: null, barsToResolve: 5, scoreThreshold: 0 });
    const candles = makeUptrendCandles();
    const candleTime = candles[candles.length - 1].time;

    // Seed a frozen 'moderate' signal exactly as the pre-close path would
    // have (white-box, same technique as the hard-geometry describe block
    // above): as if it was frozen a moment ago while strongSignalsOnly was
    // still off.
    const staleFrozen = makeSignal({
      strength: 'moderate',
      pattern: null, // non-hard-geometry: isolates this bug from the D1 revalidation mechanism
      time: candleTime,
      entryPrice: 999_999, // sentinel: must not leak through
      frozenAt: Date.now(),
    });
    (eng as unknown as { frozenSignal: Signal | null; frozenCandleTime: number | null }).frozenSignal = staleFrozen;
    (eng as unknown as { frozenSignal: Signal | null; frozenCandleTime: number | null }).frozenCandleTime = candleTime;

    // Toggle ON, as the user would via SettingsPanel, then call evaluate()
    // again for the SAME candle, well within FROZEN_SIGNAL_MAX_AGE_MS.
    eng.setStrongSignalsOnly(true);
    const serverNow = candleTime * 1000 + 5000;
    const result = await eng.evaluate('BTCUSDT', '15m', candles, CONFIG, [...ALL_FEATURES], null, serverNow, false);

    // Must NOT be the stale frozen sentinel — either null (recomputed and
    // gated to nothing, which is what this fixture's real score produces)
    // or a freshly computed 'strong' signal, but never the cached 999_999
    // moderate one.
    expect(result?.entryPrice).not.toBe(999_999);
    expect(eng.getFrozenSignal()?.entryPrice).not.toBe(999_999);
  });
});

describe('DecisionEngine — loss-streak guard (аудит 2026-09-13, "не допустить 3 убыточные сделки подряд")', () => {
  function evaluateUptrend(eng: DecisionEngine) {
    const candles = makeUptrendCandles();
    const serverNow = candles[candles.length - 1].time * 1000 - 10000;
    return eng.evaluate('BTCUSDT', '15m', candles, CONFIG, [...ALL_FEATURES], null, serverNow);
  }

  it('enabled by default, but a fresh engine (streak=0) does not suppress anything', async () => {
    const eng = new DecisionEngine({ calibration: null, barsToResolve: 5, scoreThreshold: 0 });
    expect(eng.getCurrentLossStreak()).toBe(0);
    const result = await evaluateUptrend(eng);
    expect(result).not.toBeNull();
    expect(result!.strength).toBe('moderate');
  });

  it('setLossStreak below the gate threshold does not suppress a non-strong signal', async () => {
    const eng = new DecisionEngine({ calibration: null, barsToResolve: 5, scoreThreshold: 0 });
    eng.setLossStreak(1); // LOSS_STREAK_GATE_THRESHOLD is 2 — one real loss alone isn't enough
    const result = await evaluateUptrend(eng);
    expect(result).not.toBeNull();
    expect(result!.strength).toBe('moderate');
  });

  it('suppresses a non-strong signal once the real loss streak reaches the gate threshold', async () => {
    const eng = new DecisionEngine({ calibration: null, barsToResolve: 5, scoreThreshold: 0 });
    eng.setLossStreak(2);
    const result = await evaluateUptrend(eng);
    expect(result).toBeNull();
  });

  it('a win (setLossStreak(0)) after a streak restores non-strong signals', async () => {
    const eng = new DecisionEngine({ calibration: null, barsToResolve: 5, scoreThreshold: 0 });
    eng.setLossStreak(2);
    const suppressed = await evaluateUptrend(eng);
    expect(suppressed).toBeNull();

    eng.setLossStreak(0);
    const restored = await evaluateUptrend(eng);
    expect(restored).not.toBeNull();
    expect(restored!.strength).toBe('moderate');
  });

  it('can be disabled entirely via the constructor option, even with a high streak', async () => {
    const eng = new DecisionEngine({
      calibration: null,
      barsToResolve: 5,
      scoreThreshold: 0,
      lossStreakGuardEnabled: false,
    });
    eng.setLossStreak(10);
    const result = await evaluateUptrend(eng);
    expect(result).not.toBeNull();
    expect(result!.strength).toBe('moderate');
  });

  it('setLossStreakGuardEnabled(false) turns off suppression live, without recreating the engine', async () => {
    const eng = new DecisionEngine({ calibration: null, barsToResolve: 5, scoreThreshold: 0 });
    eng.setLossStreak(2);
    const suppressed = await evaluateUptrend(eng);
    expect(suppressed).toBeNull();

    eng.setLossStreakGuardEnabled(false);
    const restored = await evaluateUptrend(eng);
    expect(restored).not.toBeNull();
    expect(restored!.strength).toBe('moderate');
  });

  it('setLossStreak ignores negative/invalid input rather than silently arming the gate', () => {
    const eng = new DecisionEngine({ calibration: null, barsToResolve: 5, scoreThreshold: 0 });
    eng.setLossStreak(-5);
    expect(eng.getCurrentLossStreak()).toBe(0);
    eng.setLossStreak(NaN);
    expect(eng.getCurrentLossStreak()).toBe(0);
    eng.setLossStreak(2.9);
    expect(eng.getCurrentLossStreak()).toBe(2); // floored, still arms the gate at >=2
  });

  it('composes with strongSignalsOnly via OR: either one alone is enough to require strong', async () => {
    // strongSignalsOnly on its own (streak stays 0) already suppresses —
    // unchanged pre-existing behaviour, just confirming the composition
    // didn't accidentally turn this into an AND.
    const eng = new DecisionEngine({
      calibration: null,
      barsToResolve: 5,
      scoreThreshold: 0,
      strongSignalsOnly: true,
      lossStreakGuardEnabled: false,
    });
    const result = await evaluateUptrend(eng);
    expect(result).toBeNull();
  });
});

describe('Calibration integration with DecisionEngine', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('recordOutcome + retrain + persist works end-to-end', () => {
    const model = new CalibrationModel(12);
    const eng = new DecisionEngine({ calibration: model, barsToResolve: 5, scoreThreshold: 0 });

    for (let i = 0; i < MIN_SAMPLES; i++) {
      const sig = makeSignal({ id: `sig-${i}` });
      eng.recordOutcome(sig, i % 2 === 0 ? 'win' : 'loss');
    }

    persistCalibrationState(model);
    const loaded = loadCalibrationState(12);
    expect(loaded).not.toBeNull();
    expect(loaded!.getSampleCount()).toBe(MIN_SAMPLES);
    expect(loaded!.isReady()).toBe(true);
  });
});

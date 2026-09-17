import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Candle, Signal } from '@/types/domain';
import type { DecisionEngine } from '@/decision/engine';
import type { CalibrationModel } from '@/decision/calibration-model';
import { OutcomeScheduler } from '@/decision/outcome-scheduler';
import { useAnalyticsStore } from '../useAnalyticsStore';
import { maybeResolveOutcomes, type OutcomeDeps } from './outcomes';
import type { TickState } from '../useTickStore';

function makeSignal(overrides: Partial<Signal> & { id: string; time: number }): Signal {
  return {
    symbolId: 'BTCUSDT',
    timeframe: '5m',
    direction: 'buy',
    strength: 'moderate',
    score: 3,
    calibratedProbability: null,
    entryPrice: 100,
    reason: 'test',
    indicators: {} as unknown as Signal['indicators'],
    pattern: null,
    outcome: 'pending',
    frozenAt: null,
    isRevised: false,
    isPreClose: false,
    revisionNote: null,
    barsToResolve: 5,
    spread: null,
    spreadSource: null,
    recommendedExpiry: 300,
    featureVector: [0],
    factors: [],
    rejectedPatterns: [],
    engineConfigSnapshot: {} as unknown as Signal['engineConfigSnapshot'],
    chartContext: { candlesBefore: [], candlesAfter: [], maxFavorableExcursion: null, maxAdverseExcursion: null },
    marketContext: { regime: 'range', structure: { trend: 'range', bos: false, choch: false, swingHigh: null, swingLow: null, provisional: false }, session: 'closed' },
    ...overrides,
  };
}

function candle(time: number, close: number): Candle {
  return { time, open: close, high: close, low: close, close, volume: 100 };
}

function makeDeps(recordOutcome = vi.fn().mockReturnValue(null)): OutcomeDeps & {
  recordOutcome: typeof recordOutcome;
} {
  const scheduler = new OutcomeScheduler();
  const fakeEngine = { recordOutcome } as unknown as DecisionEngine;
  return {
    ensureEngine: () => fakeEngine,
    ensureScheduler: () => scheduler,
    getCalibrationModel: () => null as CalibrationModel | null,
    triggerRetrain: vi.fn().mockResolvedValue(undefined),
    recordOutcome,
  };
}

describe('maybeResolveOutcomes', () => {
  beforeEach(() => {
    useAnalyticsStore.getState().clearAll();
  });

  it('does NOT call analytics.updateSignalOutcome/recomputeStats when the signal had a real demo trade opened (tradeOpened: true)', () => {
    const signal = makeSignal({ id: 'sig-traded', time: 1000, tradeOpened: true });
    useAnalyticsStore.getState().addSignal(signal);

    const deps = makeDeps();
    deps.ensureScheduler().schedule(signal);

    const updateSpy = vi.spyOn(useAnalyticsStore.getState(), 'updateSignalOutcome');
    const recomputeSpy = vi.spyOn(useAnalyticsStore.getState(), 'recomputeStats');

    const candles = [candle(1000, 100), candle(1300, 108)];
    const get = () => ({ candles }) as unknown as TickState;

    maybeResolveOutcomes(get, deps);

    expect(updateSpy).not.toHaveBeenCalled();
    expect(recomputeSpy).not.toHaveBeenCalled();

    updateSpy.mockRestore();
    recomputeSpy.mockRestore();
  });

  it('DOES call analytics.updateSignalOutcome/recomputeStats as a fallback when no demo trade was opened (tradeOpened: false)', () => {
    const signal = makeSignal({ id: 'sig-untraded', time: 2000, tradeOpened: false });
    useAnalyticsStore.getState().addSignal(signal);

    const deps = makeDeps();
    deps.ensureScheduler().schedule(signal);

    const updateSpy = vi.spyOn(useAnalyticsStore.getState(), 'updateSignalOutcome');
    const recomputeSpy = vi.spyOn(useAnalyticsStore.getState(), 'recomputeStats');

    const candles = [candle(2000, 100), candle(2300, 108)];
    const get = () => ({ candles }) as unknown as TickState;

    maybeResolveOutcomes(get, deps);

    expect(updateSpy).toHaveBeenCalledWith('sig-untraded', 'win');
    expect(recomputeSpy).toHaveBeenCalled();

    updateSpy.mockRestore();
    recomputeSpy.mockRestore();
  });

  it('records a calibration sample via engine.recordOutcome ONLY for signals with a real demo trade (tradeOpened: true)', () => {
    const tradedSignal = makeSignal({ id: 'sig-cal-traded', time: 3000, tradeOpened: true });
    const untradedSignal = makeSignal({ id: 'sig-cal-untraded', time: 4000, tradeOpened: false });
    useAnalyticsStore.getState().addSignal(tradedSignal);
    useAnalyticsStore.getState().addSignal(untradedSignal);

    const recordOutcome = vi.fn().mockReturnValue(null);
    const deps = makeDeps(recordOutcome);
    deps.ensureScheduler().schedule(tradedSignal);
    deps.ensureScheduler().schedule(untradedSignal);

    const candles = [
      candle(3000, 100),
      candle(3300, 108),
      candle(4000, 100),
      candle(4300, 108),
    ];
    const get = () => ({ candles }) as unknown as TickState;

    maybeResolveOutcomes(get, deps);

    // Аудит: непроторгованный сигнал (tradeOpened: false) больше не должен
    // обучать калибровочную модель — она учится только на реальных
    // прибыль/убыток/тайм-аут по фактически открытым и закрытым сделкам.
    expect(recordOutcome).toHaveBeenCalledTimes(1);
    expect((recordOutcome.mock.calls[0][0] as Signal).id).toBe('sig-cal-traded');
  });

  it('does not call triggerRetrain for an untraded signal (tradeOpened: false), even when a calibration model exists', () => {
    const untradedSignal = makeSignal({ id: 'sig-no-retrain', time: 5000, tradeOpened: false });
    useAnalyticsStore.getState().addSignal(untradedSignal);

    const recordOutcome = vi.fn().mockReturnValue({ signalId: 'sig-no-retrain', outcome: 'win', features: [0], score: 3 });
    const triggerRetrain = vi.fn().mockResolvedValue(undefined);
    const scheduler = new OutcomeScheduler();
    const fakeEngine = { recordOutcome } as unknown as DecisionEngine;
    const fakeModel = {} as unknown as CalibrationModel;
    const deps: OutcomeDeps = {
      ensureEngine: () => fakeEngine,
      ensureScheduler: () => scheduler,
      getCalibrationModel: () => fakeModel,
      triggerRetrain,
    };
    deps.ensureScheduler().schedule(untradedSignal);

    const candles = [candle(5000, 100), candle(5300, 108)];
    const get = () => ({ candles }) as unknown as TickState;

    maybeResolveOutcomes(get, deps);

    expect(recordOutcome).not.toHaveBeenCalled();
    expect(triggerRetrain).not.toHaveBeenCalled();
  });

  it('DOES call recordOutcome/triggerRetrain for a traded signal (tradeOpened: true) when a calibration model exists', () => {
    const tradedSignal = makeSignal({ id: 'sig-retrain', time: 6000, tradeOpened: true });
    useAnalyticsStore.getState().addSignal(tradedSignal);

    const recordOutcome = vi.fn().mockReturnValue({ signalId: 'sig-retrain', outcome: 'win', features: [0], score: 3 });
    const triggerRetrain = vi.fn().mockResolvedValue(undefined);
    const scheduler = new OutcomeScheduler();
    const fakeEngine = { recordOutcome } as unknown as DecisionEngine;
    const fakeModel = { getSampleCount: () => 0 } as unknown as CalibrationModel;
    const deps: OutcomeDeps = {
      ensureEngine: () => fakeEngine,
      ensureScheduler: () => scheduler,
      getCalibrationModel: () => fakeModel,
      triggerRetrain,
    };
    deps.ensureScheduler().schedule(tradedSignal);

    const candles = [candle(6000, 100), candle(6300, 108)];
    const get = () => ({ candles }) as unknown as TickState;

    maybeResolveOutcomes(get, deps);

    expect(recordOutcome).toHaveBeenCalledTimes(1);
    expect(triggerRetrain).toHaveBeenCalledTimes(1);
    // Этап 1 аудита ("КАЛИБРОВКА"/"АНАЛИТИКА ПО ФАКТОРАМ" не связаны, п.1–2):
    // triggerRetrain теперь принимает symbolId вторым аргументом — каждая
    // модель персистится под своим инструментом (localStorage-ключ и
    // Supabase-строка per-symbol), а не в единый глобальный слот.
    expect(triggerRetrain).toHaveBeenCalledWith(fakeModel, tradedSignal.symbolId);
  });

  // Аудит-ревью Этапа 1 (нюанс QA — per-symbol calibration routing): раньше
  // eng.recordOutcome() писал сэмпл в this.calibration движка (модель
  // ТЕКУЩЕГО активного символа), а getCalibrationModel(signal.symbolId)
  // использовался отдельно только для triggerRetrain — совпадение двух
  // моделей держалось на инварианте другого модуля (useTickStore.start()
  // дренирует outcomeScheduler при смене символа), а не проверялось здесь.
  // Этот тест резолвит В ОДНОМ вызове maybeResolveOutcomes ДВА сигнала
  // разных инструментов (как если бы, например, восстановленная после
  // reload история одновременно содержала pending-сигналы по BTCUSDT и
  // EURUSD) и проверяет, что recordOutcome() для каждого получает ИМЕННО
  // модель своего инструмента третьим аргументом — а не одну и ту же
  // модель для обоих.
  it('routes each signal to the calibration model of its OWN symbolId, not a shared/active one, when multiple instruments resolve together', () => {
    const btcSignal = makeSignal({ id: 'sig-btc', time: 7000, symbolId: 'BTCUSDT', tradeOpened: true });
    const eurSignal = makeSignal({ id: 'sig-eur', time: 7000, symbolId: 'EURUSD', tradeOpened: true });
    useAnalyticsStore.getState().addSignal(btcSignal);
    useAnalyticsStore.getState().addSignal(eurSignal);

    const recordOutcome = vi.fn().mockReturnValue({ signalId: 'x', outcome: 'win', features: [0], score: 3 });
    const triggerRetrain = vi.fn().mockResolvedValue(undefined);
    const scheduler = new OutcomeScheduler();
    const fakeEngine = { recordOutcome } as unknown as DecisionEngine;
    const btcModel = { getSampleCount: () => 0, id: 'btc-model' } as unknown as CalibrationModel;
    const eurModel = { getSampleCount: () => 0, id: 'eur-model' } as unknown as CalibrationModel;
    const modelsBySymbol: Record<string, CalibrationModel> = { BTCUSDT: btcModel, EURUSD: eurModel };
    const deps: OutcomeDeps = {
      ensureEngine: () => fakeEngine,
      ensureScheduler: () => scheduler,
      getCalibrationModel: (symbolId) => modelsBySymbol[symbolId] ?? null,
      triggerRetrain,
    };
    deps.ensureScheduler().schedule(btcSignal);
    deps.ensureScheduler().schedule(eurSignal);

    const candles = [candle(7000, 100), candle(7300, 108)];
    const get = () => ({ candles }) as unknown as TickState;

    maybeResolveOutcomes(get, deps);

    expect(recordOutcome).toHaveBeenCalledTimes(2);
    const btcCall = recordOutcome.mock.calls.find((c) => (c[0] as Signal).id === 'sig-btc')!;
    const eurCall = recordOutcome.mock.calls.find((c) => (c[0] as Signal).id === 'sig-eur')!;
    expect(btcCall[2]).toBe(btcModel);
    expect(eurCall[2]).toBe(eurModel);
    expect(triggerRetrain).toHaveBeenCalledWith(btcModel, 'BTCUSDT');
    expect(triggerRetrain).toHaveBeenCalledWith(eurModel, 'EURUSD');
  });

  // Аудит (пробел в тестировании незавершённых/pending сигналов): все
  // остальные тесты в этом файле резолвят исход сразу после schedule(),
  // пока в analytics.signals почти ничего больше нет — это не покрывает
  // реальный сценарий, из-за которого сигнал молча пропадал из «ИСТОРИЯ
  // СИГНАЛОВ»: пользователь успевает наполнить историю МНОЖЕСТВОМ новых
  // сигналов (например, переключаясь между инструментами), пока где-то
  // "в фоне" всё ещё висит один pending сигнал, ожидающий закрытия своей
  // демо-сделки. Этот тест воспроизводит именно такой порядок событий на
  // всём пути planировщик → capSignals (useAnalyticsStore) → outcome, а
  // не каждую часть по отдельности.
  it('resolves a long-pending untraded signal correctly even after 150 newer signals have been added to analytics history in the meantime', () => {
    const pendingSignal = makeSignal({ id: 'sig-long-pending', time: 500, tradeOpened: false });
    useAnalyticsStore.getState().addSignal(pendingSignal);

    const deps = makeDeps();
    deps.ensureScheduler().schedule(pendingSignal);

    // Simulate a busy session: many newer, already-resolved signals pile up
    // in analytics history while sig-long-pending is still waiting on its
    // candle. Far more than MAX_SIGNALS (100).
    for (let i = 0; i < 150; i++) {
      useAnalyticsStore.getState().addSignal(
        makeSignal({ id: `sig-noise-${i}`, time: 1000 + i, outcome: 'win' }),
      );
    }

    // The still-pending signal must still be present, not evicted.
    expect(
      useAnalyticsStore.getState().signals.find((s) => s.id === 'sig-long-pending'),
    ).toBeDefined();

    const candles = [candle(500, 100), candle(800, 108)];
    const get = () => ({ candles }) as unknown as TickState;

    maybeResolveOutcomes(get, deps);

    const resolved = useAnalyticsStore.getState().signals.find((s) => s.id === 'sig-long-pending');
    expect(resolved?.outcome).toBe('win');
  });

  it('does nothing when there are no pending scheduled signals', () => {
    const deps = makeDeps();
    const updateSpy = vi.spyOn(useAnalyticsStore.getState(), 'updateSignalOutcome');
    const recomputeSpy = vi.spyOn(useAnalyticsStore.getState(), 'recomputeStats');

    const get = () => ({ candles: [] }) as unknown as TickState;
    maybeResolveOutcomes(get, deps);

    expect(updateSpy).not.toHaveBeenCalled();
    expect(recomputeSpy).not.toHaveBeenCalled();

    updateSpy.mockRestore();
    recomputeSpy.mockRestore();
  });
});

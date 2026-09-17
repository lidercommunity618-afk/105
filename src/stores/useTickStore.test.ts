import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Candle, Signal, Timeframe } from '@/types/domain';

// vi.mock(...) calls below are hoisted by Vitest above every other
// statement in this file, including plain `const` declarations — so any
// mock factory that closes over a module-scope const (mockSettingsSubscribe
// etc.) was hitting the const before its initializer ran (TDZ), throwing
// "Cannot access '...' before initialization". vi.hoisted() runs its
// callback at that same hoisted position (before the vi.mock calls that
// reference it), so these mocks are guaranteed to exist first.
const {
  mockEvaluate,
  mockOnCandleClosed,
  mockShouldEmitPreClose,
  mockGetFrozenSignal,
  mockSetPriorityThreshold,
  mockSettingsSubscribe,
  mockAnalyticsStore,
} = vi.hoisted(() => {
  const mockAnalyticsStore = {
    signals: [] as Signal[],
    currentSignal: null as Signal | null,
    connectionStatus: 'live' as const,
    setCurrentSignal: vi.fn(),
    addSignal: vi.fn(),
    upsertSignal: vi.fn(),
    recomputeStats: vi.fn(),
    updateSignalOutcome: vi.fn(),
    markTradeOpened: vi.fn(),
    setCalibrationState: vi.fn(),
    setConnectionStatus: vi.fn(),
    clearAll: vi.fn(),
    clearSignalHistory: vi.fn(),
    resetSession: vi.fn(),
  };
  return {
    mockEvaluate: vi.fn(),
    mockOnCandleClosed: vi.fn(),
    mockShouldEmitPreClose: vi.fn().mockReturnValue(false),
    mockGetFrozenSignal: vi.fn().mockReturnValue(null),
    mockSetPriorityThreshold: vi.fn(),
    mockSettingsSubscribe: vi.fn(() => () => {}),
    mockAnalyticsStore,
  };
});

vi.mock('@/decision/engine', () => ({
  DecisionEngine: vi.fn().mockImplementation(() => ({
    evaluate: mockEvaluate,
    onCandleClosed: mockOnCandleClosed,
    shouldEmitPreClose: mockShouldEmitPreClose,
    getFrozenSignal: mockGetFrozenSignal,
    recordOutcome: vi.fn().mockReturnValue(null),
    getLastSnapshot: vi.fn().mockReturnValue(null),
    setScoreThreshold: vi.fn(),
    setSignalToggles: vi.fn(),
    setPriorityThreshold: mockSetPriorityThreshold,
    // АУДИТ 2026-09-13: ensureEngine() безусловно вызывает
    // engine.setLossStreak(...) сразу после создания движка (сидирование
    // текущей серии) — без этого мока каждый тест, создающий движок через
    // ensureEngine(), падал бы с "setLossStreak is not a function".
    setLossStreak: vi.fn(),
    setLossStreakGuardEnabled: vi.fn(),
    setStrongSignalsOnly: vi.fn(),
  })),
}));

vi.mock('@/decision/outcome-scheduler', () => ({
  OutcomeScheduler: vi.fn().mockImplementation(() => ({
    schedule: vi.fn(),
    onCandleClosed: vi.fn(),
    clear: vi.fn(),
    getPendingCount: vi.fn().mockReturnValue(0),
    getPendingList: vi.fn().mockReturnValue([]),
  })),
}));

vi.mock('@/decision/calibration-model', () => ({
  MIN_SAMPLES: 100,
  loadCalibrationState: vi.fn().mockReturnValue(null),
  persistCalibrationState: vi.fn(),
  CalibrationModel: vi.fn(),
}));

vi.mock('@/decision/signal-builder', () => ({
  FEATURE_COUNT: 10,
  FEATURE_KEYS: [],
  shouldRevise: vi.fn().mockReturnValue(false),
  reviseSignal: vi.fn(),
  // Реальная реализация (не заглушка): tick-store/shared.ts::notifySignal
  // использует sigmoidFallback как резервную формулу вероятности, когда
  // calibratedProbability не задан, и тесты в этом файле полагаются на
  // настоящее значение, а не на мок. BUGFIX (аудит 2026-09-05): зажато в
  // [0.35, 0.65], зеркалит правку в decision/signal-builder.ts.
  sigmoidFallback: (score: number) => Math.max(0.35, Math.min(0.65, 1 / (1 + Math.exp(-score / 5)))),
}));

vi.mock('@/lib/signal-persistence', () => ({
  saveSignal: vi.fn().mockResolvedValue(undefined),
  updateSignalOutcome: vi.fn().mockResolvedValue(undefined),
  loadCalibrationStateFromDb: vi.fn().mockResolvedValue(null),
  saveCalibrationState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/audio', () => ({ playSignalAlert: vi.fn(), playPriorityAlert: vi.fn() }));
vi.mock('@/lib/sentry', () => ({ captureError: vi.fn(), addBreadcrumb: vi.fn() }));
vi.mock('@/data/server-clock', () => ({ serverClock: { now: vi.fn(() => Date.now()), onTick: vi.fn(() => () => {}) } }));
vi.mock('@/data/connection-manager', () => ({
  connectionManager: {
    onCandle: vi.fn(() => () => {}),
    onTick: vi.fn(() => () => {}),
    onStatus: vi.fn(() => () => {}),
    onSourceAttempt: vi.fn(() => () => {}),
    connectAndGetHistory: vi.fn().mockResolvedValue({ status: 'live', candles: [] }),
    disconnect: vi.fn(),
  },
}));
vi.mock('@/data/market-hours', () => ({
  isMarketOpen: vi.fn().mockReturnValue(true),
  FOREX_MARKET_HOURS: { openDays: [false, true, true, true, true, true, false], openMinutesUtc: 0, closeMinutesUtc: 1440 },
}));
vi.mock('@/data/compact-timeline', () => ({ compactTimeline: vi.fn((c: unknown) => c) }));
vi.mock('@/compute/WorkerClient', () => ({
  workerClient: { candleClosed: vi.fn().mockResolvedValue({ snapshot: { indicators: {} }, series: {} }), resetStreaming: vi.fn() },
}));
vi.mock('@/compute/IndicatorAggregator', () => ({ computeSnapshot: vi.fn() }));
vi.mock('@/compute/full-snapshot', () => ({ buildFullSnapshot: vi.fn() }));
vi.mock('./settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({
      indicators: {}, priorityThreshold: 0.7,
      activePatterns: [], activeIndicators: [], sensitivity: 'soft',
      signalToggles: {},
    }),
    subscribe: mockSettingsSubscribe,
  },
}));

vi.mock('./useAnalyticsStore', () => ({
  useAnalyticsStore: {
    getState: () => mockAnalyticsStore,
    setState: vi.fn((partial: Record<string, unknown>) => Object.assign(mockAnalyticsStore, partial)),
  },
}));

// useDemoAccountStore — БЕЗ мока, проверяем реальное поведение стора.
import { useDemoAccountStore } from '@/stores/useDemoAccountStore';
import { useAnalyticsStore } from '@/stores/useAnalyticsStore';
import { handleCandle, maybeTriggerPreClose, useTickStore } from '@/stores/useTickStore';
import {
  hasPriorityThresholdOverride,
  resetPriorityThresholdOverrideForSymbol,
} from '@/lib/priority-threshold-overrides';

function candle(time: number, open: number, close: number, high: number, low: number): Candle {
  return { time, open, high, low, close, volume: 100 };
}

function makeSignal(overrides: Partial<Signal> & { id: string; time: number }): Signal {
  return {
    symbolId: 'A', timeframe: '5m', direction: 'buy', strength: 'moderate',
    score: 3, calibratedProbability: null, entryPrice: 100,
    reason: 'test', indicators: {} as unknown as Signal['indicators'],
    pattern: null, outcome: 'pending', frozenAt: null, isRevised: false,
    isPreClose: false, revisionNote: null, barsToResolve: 5, spread: null,
    spreadSource: null, recommendedExpiry: 300, featureVector: [0],
    factors: [], rejectedPatterns: [], engineConfigSnapshot: {} as unknown as Signal['engineConfigSnapshot'],
    chartContext: { candlesBefore: [], candlesAfter: [], maxFavorableExcursion: null, maxAdverseExcursion: null },
    marketContext: { regime: 'range', structure: { trend: 'range', bos: false, choch: false, swingHigh: null, swingLow: null, provisional: false }, session: 'closed' },
    ...overrides,
  };
}

// Минимальный набор полей TickState, который реально читает handleCandle
// и функции, которые он вызывает. Тип ослаблен — тесту не нужен полный
// TickState, только использованные поля.
function makeTickHarness(initial: Record<string, unknown>) {
  let state: Record<string, unknown> = {
    candles: [], activeSymbolId: 'A', activeTimeframe: '5m',
    lastCandleCloseAtMs: 0, lastCandleUpdatedAt: 0, lastComputeAt: 0,
    lastTick: null, candleLifecycle: 'live', currentPrice: null,
    lastTickAt: 0, lastPriceFlash: null, prioritySignal: null,
    ...initial,
  };
  const get = () => state as never;
  const set = (partial: Record<string, unknown>) => { state = { ...state, ...partial }; };
  return { get, set };
}

describe('useTickStore handleCandle — demo account wiring regressions', () => {
  beforeEach(() => {
    useDemoAccountStore.getState().resetAccount();
    useDemoAccountStore.setState({ autoTradeEnabled: true, stage0Amount: 10, stageAmounts: [25, 50, 100], martingale: {} });
    mockEvaluate.mockReset();
    mockOnCandleClosed.mockReset();
    mockShouldEmitPreClose.mockReturnValue(true);
  });

  afterEach(() => {
    mockShouldEmitPreClose.mockReturnValue(false);
  });

  it('confirmEntryPrice fires on the new candle even when isClosed already advanced lastCandleCloseAtMs on the previous candle', async () => {
    const tf: Timeframe = '5m';
    const tfSeconds = 300;
    const T = 1_000_000;

    const closedCandle = candle(T, 100, 100, 101, 99);
    const harness = makeTickHarness({ candles: [closedCandle], activeTimeframe: tf });

    const signal = makeSignal({ id: `A:${tf}:${T}`, time: T, entryPrice: 100 });
    mockEvaluate.mockReturnValue(signal);
    mockOnCandleClosed.mockReturnValue(signal);

    // 0) Simulate pre-close having already fired for this candle so the
    //    fallback openTrade path (isClosed=true) is allowed to proceed.
    await maybeTriggerPreClose(harness.set, harness.get);

    // 1) Последний тик текущей свечи приходит с isClosed=true ДО того, как
    //    появилась следующая свеча (типичное поведение deriv.ts). Это уже
    //    продвигает lastCandleCloseAtMs и открывает сделку без известной цены.
    await handleCandle(candle(T, 100, 100, 101, 99), true, harness.set, harness.get);

    const tradeId = signal.id;
    let trade = useDemoAccountStore.getState().openTrades[tradeId];
    expect(trade).toBeDefined();
    expect(trade?.entryPrice).toBeNull(); // цена ещё не подтверждена

    // 2) Приходит первая свеча нового периода — gap-up, open=103.
    //    lastCandleCloseAtMs у harness уже равен prevCloseMs для этого
    //    перехода (выставлен шагом 1), поэтому дедуп-гвард НЕ должен
    //    помешать confirmEntryPrice сработать.
    await handleCandle(candle(T + tfSeconds, 103, 104, 105, 102), false, harness.set, harness.get);

    trade = useDemoAccountStore.getState().openTrades[tradeId];
    expect(trade?.entryPrice).toBe(103); // подтверждена реальная цена открытия
  });

  it('does not open a demo trade on an intermediate (isClosed === false) signal, only on the actual close', async () => {
    const tf: Timeframe = '5m';
    const T = 2_000_000;

    const forming = candle(T, 100, 100, 101, 99);
    const harness = makeTickHarness({ candles: [forming], activeTimeframe: tf });

    const signal = makeSignal({ id: `A:${tf}:${T}`, time: T, entryPrice: 100 });
    mockEvaluate.mockReturnValue(signal);
    mockOnCandleClosed.mockReturnValue(signal);

    // 0) Simulate pre-close having fired for this candle so the
    //    fallback openTrade path (isClosed=true) is allowed to proceed.
    await maybeTriggerPreClose(harness.set, harness.get);
    // Clear the trade opened by pre-close — we only need preCloseTriggeredCandleTime
    // to be set so the isClosed=true path can proceed. The test verifies that
    // intermediate ticks don't open trades and the close path does.
    useDemoAccountStore.setState({ openTrades: {}, balance: 1000 });

    // Промежуточный тик внутри той же свечи (isClosed=false) — evaluate()
    // уже возвращает валидный сигнал (например, порог по score набран
    // раньше, чем за 5 секунд до закрытия).
    await handleCandle(candle(T, 100, 102, 103, 99), false, harness.set, harness.get);

    expect(Object.keys(useDemoAccountStore.getState().openTrades)).toHaveLength(0);

    // Настоящее закрытие той же свечи — теперь сделка должна открыться.
    await handleCandle(candle(T, 100, 105, 106, 99), true, harness.set, harness.get);

    const trades = useDemoAccountStore.getState().openTrades;
    expect(Object.keys(trades)).toHaveLength(1);
    expect(trades[signal.id]).toBeDefined();
  });

  // Аудит (сигналы бесследно пропадают из ИСТОРИЯ СИГНАЛОВ): pre-close по
  // дизайну срабатывает НЕМНОГО РАНЬШЕ закрытия текущей свечи — то есть в
  // момент, когда сделка ПРЕДЫДУЩЕЙ свечи на этом же инструменте формально
  // ЕЩЁ НЕ истекла (истекает она ровно в момент закрытия текущей свечи). Из-
  // за guard'а "не больше одной открытой сделки на инструмент" в
  // useDemoAccountStore.openTrade попытка pre-close открыть сделку
  // структурно ВСЕГДА блокируется этой ещё не истёкшей предыдущей сделкой —
  // и в analytics сразу попадает tradeOpened: false. Реальная сделка при
  // этом успешно открывается чуть позже, в момент фактического закрытия
  // свечи (handleCandle -> checkExpiries снимает предыдущую сделку ->
  // openTrade для этого же signal.id уже проходит) — и tradeOpened должен
  // быть скорректирован на true на УЖЕ существующей записи через
  // markTradeOpened(), а не остаться задним числом ложным (и, в этой
  // версии SignalFeed.tsx, полностью скрытым от пользователя).
  it('corrects a pre-close tradeOpened: false snapshot to true once the trade actually opens at candle close', async () => {
    const tf: Timeframe = '5m';
    const tfSeconds = 300;
    const T = 5_000_000;

    const forming = candle(T, 100, 100, 101, 99);
    const harness = makeTickHarness({ candles: [forming], activeTimeframe: tf });

    const signal = makeSignal({ id: `A:${tf}:${T}`, time: T, entryPrice: 100 });
    mockEvaluate.mockReturnValue(signal);
    mockOnCandleClosed.mockReturnValue(signal);

    // Сделка ПРЕДЫДУЩЕЙ свечи на том же инструменте/таймфрейме, ещё формально
    // не истёкшая на момент pre-close (истечёт ровно при закрытии свечи T,
    // т.е. в момент (T + tfSeconds) * 1000 — см. checkExpiries ниже).
    useDemoAccountStore.setState({
      openTrades: {
        'A:5m:PREV': {
          signalId: 'A:5m:PREV',
          stake: 10,
          profitPercent: 80,
          direction: 'buy',
          openedAt: (T - tfSeconds) * 1000,
          entryPrice: 100,
          fallbackEntryPrice: 100,
          spread: null,
          expiryAt: T * 1000,
          symbolId: 'A',
          timeframe: tf,
          candleTime: T,
          stage: 0,
          stakeConfigAtOpen: { stage0Amount: 10, stageAmounts: [25, 50, 100] },
        },
      },
      balance: 1000,
    });

    // Pre-close свечи T — openTrade() для signal.id должен быть заблокирован
    // ещё не истёкшей сделкой 'A:5m:PREV'.
    await maybeTriggerPreClose(harness.set, harness.get);

    expect(useDemoAccountStore.getState().openTrades[signal.id]).toBeUndefined();
    const upsertCalls = mockAnalyticsStore.upsertSignal.mock.calls;
    const upsertCall = upsertCalls[upsertCalls.length - 1]?.[0] as Signal | undefined;
    expect(upsertCall?.id).toBe(signal.id);
    expect(upsertCall?.tradeOpened).toBe(false);
    expect(mockAnalyticsStore.markTradeOpened).not.toHaveBeenCalledWith(signal.id);

    // Свеча T реально закрывается — checkExpiries снимает 'A:5m:PREV' (её
    // expiryAt === T*1000, ровно текущий момент перехода), после чего
    // openTrade() для signal.id (той же свечи T) уже успешно проходит.
    await handleCandle(candle(T + tfSeconds, 105, 106, 107, 104), false, harness.set, harness.get);

    expect(useDemoAccountStore.getState().openTrades[signal.id]).toBeDefined();
    // Ключевая проверка фикса: markTradeOpened должен поднять флаг на УЖЕ
    // существующей (из pre-close, tradeOpened: false) записи в analytics.
    expect(mockAnalyticsStore.markTradeOpened).toHaveBeenCalledWith(signal.id);
  });
});

describe('maybeTriggerPreClose — entryPrice regression (Finding #1)', () => {
  beforeEach(() => {
    useDemoAccountStore.getState().resetAccount();
    useDemoAccountStore.setState({ autoTradeEnabled: true, stage0Amount: 10, stageAmounts: [25, 50, 100], martingale: {} });
    mockEvaluate.mockReset();
    mockOnCandleClosed.mockReset();
    mockShouldEmitPreClose.mockReturnValue(true);
  });

  afterEach(() => {
    mockShouldEmitPreClose.mockReturnValue(false);
  });

  it('opens trade with entryPrice === null (not signal.entryPrice) so confirmEntryPrice can correct it later', async () => {
    const tf: Timeframe = '5m';
    const tfSeconds = 300;
    const T = 3_000_000;

    // The forming candle has close=102 — this is what signal.entryPrice would be.
    // The real open of the next candle is 105 (gap up). If the bug were present,
    // entryPrice would be locked to 102 and confirmEntryPrice could not fix it.
    const forming = candle(T, 100, 102, 103, 99);
    const harness = makeTickHarness({ candles: [forming], activeTimeframe: tf });

    const signal = makeSignal({
      id: `A:${tf}:${T}`,
      time: T,
      entryPrice: 102, // signal.entryPrice = close of forming candle
    });
    mockEvaluate.mockReturnValue(signal);

    // Simulate pre-close trigger (5s before candle close)
    await maybeTriggerPreClose(harness.set, harness.get);

    const trade = useDemoAccountStore.getState().openTrades[signal.id];
    expect(trade).toBeDefined();
    // CRITICAL: entryPrice must be null, NOT 102 — so confirmEntryPrice can
    // set the real open price when the next candle arrives.
    expect(trade?.entryPrice).toBeNull();
    expect(trade?.fallbackEntryPrice).toBe(102);

    // Now the new candle arrives with open=105 — confirmEntryPrice should fire
    await handleCandle(candle(T + tfSeconds, 105, 106, 107, 104), false, harness.set, harness.get);

    const correctedTrade = useDemoAccountStore.getState().openTrades[signal.id];
    expect(correctedTrade?.entryPrice).toBe(105);
  });

  it('does not open a second trade for the same signal.id if called again', async () => {
    const tf: Timeframe = '5m';
    const T = 4_000_000;

    const forming = candle(T, 100, 102, 103, 99);
    const harness = makeTickHarness({ candles: [forming], activeTimeframe: tf });

    const signal = makeSignal({ id: `A:${tf}:${T}`, time: T, entryPrice: 102 });
    mockEvaluate.mockReturnValue(signal);

    await maybeTriggerPreClose(harness.set, harness.get);
    const balanceAfterFirst = useDemoAccountStore.getState().balance;

    // Second call — should be deduped by preCloseTriggeredCandleTime guard
    await maybeTriggerPreClose(harness.set, harness.get);
    const balanceAfterSecond = useDemoAccountStore.getState().balance;

    expect(balanceAfterFirst).toBe(balanceAfterSecond);
    expect(Object.keys(useDemoAccountStore.getState().openTrades)).toHaveLength(1);
  });
});

describe('handleCandle — merges same-time candle updates instead of overwriting (WS/poll race)', () => {
  beforeEach(() => {
    useDemoAccountStore.getState().resetAccount();
    mockEvaluate.mockReset();
    mockEvaluate.mockReturnValue(null);
    mockOnCandleClosed.mockReset();
    mockShouldEmitPreClose.mockReturnValue(false);
  });

  it('does not regress high/low when a later, narrower-range update arrives for the same forming candle', async () => {
    // Симулирует ровно тот сценарий из отчёта: WS-тик уже расширил high/low
    // локально (через handleTick, эмулируем здесь напрямую в candles), а
    // следом приходит REST-poll снапшот с БОЛЕЕ УЗКИМ диапазоном (устаревший
    // на несколько секунд из-за агрегации на стороне Deriv). high не должен
    // уменьшаться, low не должен увеличиваться, open не должен "плавать".
    const tf: Timeframe = '5m';
    const T = 11_000_000;
    // Локально уже накоплено через WS-тики: high=105, low=95.
    const widened = candle(T, 100, 103, 105, 95);
    const harness = makeTickHarness({ candles: [widened], activeTimeframe: tf });

    // Более поздний, но более узкий REST-снимок для той же свечи.
    const narrowerPoll = candle(T, 99 /* другой open! */, 102, 102, 98);

    await handleCandle(narrowerPoll, false, harness.set, harness.get);

    const result = (harness.get() as unknown as { candles: Candle[] }).candles;
    expect(result).toHaveLength(1);
    expect(result[0].high).toBe(105); // не регрессировал вниз
    expect(result[0].low).toBe(95); // не регрессировал вверх
    expect(result[0].open).toBe(100); // open зафиксирован первым снимком, не переписан
    expect(result[0].close).toBe(102); // close — из более свежего снимка, как обычно
  });

  it('still expands high/low when a later update genuinely has a wider range', async () => {
    const tf: Timeframe = '5m';
    const T = 12_000_000;
    const initial = candle(T, 100, 101, 102, 99);
    const harness = makeTickHarness({ candles: [initial], activeTimeframe: tf });

    const wider = candle(T, 100, 103, 106, 94);
    await handleCandle(wider, false, harness.set, harness.get);

    const result = (harness.get() as unknown as { candles: Candle[] }).candles;
    expect(result[0].high).toBe(106);
    expect(result[0].low).toBe(94);
  });
});

describe('signal notification gating — intermediate ticks do not update currentSignal', () => {
  beforeEach(() => {
    useDemoAccountStore.getState().resetAccount();
    useDemoAccountStore.setState({ autoTradeEnabled: true, stage0Amount: 10, stageAmounts: [25, 50, 100], martingale: {} });
    mockEvaluate.mockReset();
    mockOnCandleClosed.mockReset();
    mockShouldEmitPreClose.mockReturnValue(false);
  });

  it('intermediate tick (isClosed=false) does not call setCurrentSignal or play alerts', async () => {
    const tf: Timeframe = '5m';
    const T = 5_000_000;
    const forming = candle(T, 100, 100, 101, 99);
    const harness = makeTickHarness({ candles: [forming], activeTimeframe: tf });

    const signal = makeSignal({ id: `A:${tf}:${T}`, time: T, entryPrice: 100 });
    mockEvaluate.mockReturnValue(signal);

    const setCurrentSignalMock = (useAnalyticsStore as unknown as { getState: () => { setCurrentSignal: ReturnType<typeof vi.fn> } }).getState().setCurrentSignal;
    setCurrentSignalMock.mockClear();

    await handleCandle(candle(T, 100, 102, 103, 99), false, harness.set, harness.get);

    expect(setCurrentSignalMock).not.toHaveBeenCalled();
  });

  it('pre-close tick calls setCurrentSignal and plays alerts', async () => {
    const tf: Timeframe = '5m';
    const T = 6_000_000;
    const forming = candle(T, 100, 102, 103, 99);
    const harness = makeTickHarness({ candles: [forming], activeTimeframe: tf });

    const signal = makeSignal({ id: `A:${tf}:${T}`, time: T, entryPrice: 102 });
    mockEvaluate.mockReturnValue(signal);
    mockShouldEmitPreClose.mockReturnValue(true);

    const setCurrentSignalMock = (useAnalyticsStore as unknown as { getState: () => { setCurrentSignal: ReturnType<typeof vi.fn> } }).getState().setCurrentSignal;
    setCurrentSignalMock.mockClear();

    await maybeTriggerPreClose(harness.set, harness.get);

    expect(setCurrentSignalMock).toHaveBeenCalledTimes(1);
    mockShouldEmitPreClose.mockReturnValue(false);
  });
});

describe('settings subscription — reactive priorityThreshold propagation (Задача 3.3)', () => {
  beforeEach(() => {
    mockSetPriorityThreshold.mockClear();
  });

  it('registers exactly one subscription to settingsStore on module load', () => {
    // useTickStore.ts подписывается на useSettingsStore при импорте модуля
    // (module-level код), а не внутри React-компонента — поэтому подписка
    // должна быть ровно одна за весь тестовый файл (модуль импортируется
    // один раз для всех тестов).
    expect(mockSettingsSubscribe).toHaveBeenCalledTimes(1);
  });

  it('calls engine.setPriorityThreshold when priorityThreshold changes in settings', async () => {
    // Гарантируем, что модульный синглтон engine уже создан (ensureEngine()
    // создаёт его лениво при первом использовании) — иначе подписка ничего
    // не вызовет, так как реализация проверяет `&& engine`.
    const tf: Timeframe = '5m';
    const T = 7_000_000;
    const harness = makeTickHarness({ candles: [candle(T, 100, 100, 101, 99)], activeTimeframe: tf });
    mockEvaluate.mockReturnValue(null);
    await maybeTriggerPreClose(harness.set, harness.get);

    const onSettingsChange = (mockSettingsSubscribe.mock.calls[0] as unknown as unknown[])[0] as (
      next: { sensitivity: string; indicators: { scoreThreshold: number }; signalToggles: unknown; priorityThreshold: number },
      prev: { sensitivity: string; indicators: { scoreThreshold: number }; signalToggles: unknown; priorityThreshold: number },
    ) => void;

    const base = { sensitivity: 'soft', indicators: { scoreThreshold: 2 }, signalToggles: {}, priorityThreshold: 0.7 };
    onSettingsChange({ ...base, priorityThreshold: 0.85 }, base);

    expect(mockSetPriorityThreshold).toHaveBeenCalledTimes(1);
    expect(mockSetPriorityThreshold).toHaveBeenCalledWith(0.85);
  });

  it('does not call engine.setPriorityThreshold when priorityThreshold is unchanged', async () => {
    const tf: Timeframe = '5m';
    const T = 8_000_000;
    const harness = makeTickHarness({ candles: [candle(T, 100, 100, 101, 99)], activeTimeframe: tf });
    mockEvaluate.mockReturnValue(null);
    await maybeTriggerPreClose(harness.set, harness.get);

    const onSettingsChange = (mockSettingsSubscribe.mock.calls[0] as unknown as unknown[])[0] as (
      next: { sensitivity: string; indicators: { scoreThreshold: number }; signalToggles: unknown; priorityThreshold: number },
      prev: { sensitivity: string; indicators: { scoreThreshold: number }; signalToggles: unknown; priorityThreshold: number },
    ) => void;

    const base = { sensitivity: 'soft', indicators: { scoreThreshold: 2 }, signalToggles: {}, priorityThreshold: 0.7 };
    // Тот же priorityThreshold, только меняем sensitivity — этот кейс
    // должен задеть только setScoreThreshold, а не setPriorityThreshold.
    onSettingsChange({ ...base, sensitivity: 'strict' }, base);

    expect(mockSetPriorityThreshold).not.toHaveBeenCalled();
  });
});

describe('stale async evaluate() guarded against a symbol/timeframe switch mid-flight', () => {
  beforeEach(() => {
    useDemoAccountStore.getState().resetAccount();
    useDemoAccountStore.setState({ autoTradeEnabled: true, stage0Amount: 10, stageAmounts: [25, 50, 100], martingale: {} });
    mockEvaluate.mockReset();
    mockOnCandleClosed.mockReset();
    mockShouldEmitPreClose.mockReturnValue(false);
    (useAnalyticsStore.getState().addSignal as ReturnType<typeof vi.fn>).mockClear();
    (useAnalyticsStore.getState().upsertSignal as ReturnType<typeof vi.fn>).mockClear();
    (useAnalyticsStore.getState().setCurrentSignal as ReturnType<typeof vi.fn>).mockClear();
  });

  it('discards a maybeEvaluateSignal() result if the symbol changed while eng.evaluate() was in flight', async () => {
    const tf: Timeframe = '5m';
    const T = 9_000_000;
    const closedCandle = candle(T, 100, 100, 101, 99);
    const harness = makeTickHarness({ candles: [closedCandle], activeTimeframe: tf, activeSymbolId: 'A' });

    const staleSignal = makeSignal({ id: `A:${tf}:${T}`, time: T, entryPrice: 100 });

    let resolveEvaluate!: (v: Signal) => void;
    mockEvaluate.mockReturnValueOnce(new Promise<Signal>((resolve) => { resolveEvaluate = resolve; }));

    const call = handleCandle(candle(T, 100, 100, 101, 99), true, harness.set, harness.get);

    // Симулируем переключение символа ПОКА eng.evaluate() ещё не резолвился
    // (например, пользователь кликнул другой инструмент во время round-trip
    // к воркеру) — ровно то, что делает реальный switchSymbol().
    harness.set({ activeSymbolId: 'B', candles: [] });
    resolveEvaluate(staleSignal);
    await call;

    // Протухший сигнал по СТАРОМУ символу не должен попасть ни в историю,
    // ни в текущий сигнал, ни открыть сделку — иначе он "всплывает" в
    // сайдбаре уже под текущим (новым) символом.
    expect(useAnalyticsStore.getState().addSignal).not.toHaveBeenCalled();
    expect(Object.keys(useDemoAccountStore.getState().openTrades)).toHaveLength(0);
  });

  it('discards a maybeTriggerPreClose() result if the timeframe changed while eng.evaluate() was in flight', async () => {
    const tf: Timeframe = '5m';
    const T = 10_000_000;
    const forming = candle(T, 100, 102, 103, 99);
    const harness = makeTickHarness({ candles: [forming], activeTimeframe: tf, activeSymbolId: 'A' });
    mockShouldEmitPreClose.mockReturnValue(true);

    const staleSignal = makeSignal({ id: `A:${tf}:${T}`, time: T, entryPrice: 102 });

    let resolveEvaluate!: (v: Signal) => void;
    mockEvaluate.mockReturnValueOnce(new Promise<Signal>((resolve) => { resolveEvaluate = resolve; }));

    const call = maybeTriggerPreClose(harness.set, harness.get);
    harness.set({ activeTimeframe: '15m' });
    resolveEvaluate(staleSignal);
    await call;

    expect(useAnalyticsStore.getState().setCurrentSignal).not.toHaveBeenCalled();
    expect(useAnalyticsStore.getState().upsertSignal).not.toHaveBeenCalled();
    expect(Object.keys(useDemoAccountStore.getState().openTrades)).toHaveLength(0);
    mockShouldEmitPreClose.mockReturnValue(false);
  });
});

describe('applyPriorityThresholdForSymbol / resetPriorityThresholdForSymbol (Этап 4)', () => {
  beforeEach(async () => {
    mockSetPriorityThreshold.mockClear();
    resetPriorityThresholdOverrideForSymbol('BTCUSDT');
    resetPriorityThresholdOverrideForSymbol('EURUSD');
    // Убеждаемся, что модульный синглтон engine уже создан — та же
    // подстраховка, что в блоке "settings subscription" выше.
    const tf: Timeframe = '5m';
    const harness = makeTickHarness({ candles: [candle(9_000_000, 100, 100, 101, 99)], activeTimeframe: tf });
    mockEvaluate.mockReturnValue(null);
    await maybeTriggerPreClose(harness.set, harness.get);
  });

  it('pushes the new threshold to the engine immediately when applied to the currently active symbol', () => {
    useTickStore.setState({ activeSymbolId: 'BTCUSDT' });
    useTickStore.getState().applyPriorityThresholdForSymbol('BTCUSDT', 0.8);
    expect(hasPriorityThresholdOverride('BTCUSDT')).toBe(true);
    expect(mockSetPriorityThreshold).toHaveBeenCalledWith(0.8);
  });

  it('does not push to the engine when applied to a symbol other than the currently active one', () => {
    useTickStore.setState({ activeSymbolId: 'BTCUSDT' });
    useTickStore.getState().applyPriorityThresholdForSymbol('EURUSD', 0.9);
    expect(hasPriorityThresholdOverride('EURUSD')).toBe(true);
    // BTCUSDT is active, but the override was for EURUSD — the live engine
    // (currently serving BTCUSDT) must not be touched by another symbol's
    // calibration, same guarantee as PATTERN_RELIABILITY_MULTIPLIER overrides.
    expect(mockSetPriorityThreshold).not.toHaveBeenCalled();
  });

  it('reset reverts the active symbol to the global default and pushes it to the engine', () => {
    useTickStore.setState({ activeSymbolId: 'BTCUSDT' });
    useTickStore.getState().applyPriorityThresholdForSymbol('BTCUSDT', 0.8);
    mockSetPriorityThreshold.mockClear();
    useTickStore.getState().resetPriorityThresholdForSymbol('BTCUSDT');
    expect(hasPriorityThresholdOverride('BTCUSDT')).toBe(false);
    expect(mockSetPriorityThreshold).toHaveBeenCalledTimes(1);
  });
});

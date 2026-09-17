import { create } from 'zustand';
import type { Candle, Tick, Timeframe, Signal } from '@/types/domain';
import { connectionManager } from '@/data/connection-manager';
import { findSymbol, TIMEFRAME_SECONDS } from '@/data/symbols';
import { isMarketOpen } from '@/data/market-hours';
import { compactTimeline } from '@/data/compact-timeline';
import { workerClient } from '@/compute/WorkerClient';
import { buildFullSnapshot } from '@/compute/full-snapshot';
import type { IndicatorSnapshot } from '@/types/domain';
import { serverClock } from '@/data/server-clock';
import { captureError } from '@/lib/sentry';
import { getHumanReadableError, classifyDataError, sourceLabel } from '@/data/error-messages';
import { useSettingsStore } from './settingsStore';
import { useAnalyticsStore } from './useAnalyticsStore';
import { DecisionEngine } from '@/decision/engine';
import { OutcomeScheduler } from '@/decision/outcome-scheduler';
import {
  CalibrationModel,
  loadCalibrationState,
  persistCalibrationState,
  MIN_SAMPLES,
} from '@/decision/calibration-model';
import { FEATURE_COUNT, FEATURE_KEYS, shouldRevise, reviseSignal } from '@/decision/signal-builder';
import {
  saveSignal,
  loadCalibrationStateFromDb,
  saveCalibrationState,
  updateSignalOutcome,
} from '@/lib/signal-persistence';
import { useDemoAccountStore } from '@/stores/useDemoAccountStore';
import { getActiveFeatures, notifySignal } from './tick-store/shared';
import {
  effectivePriorityThresholdForSymbol,
  applyPriorityThresholdOverrideForSymbol,
  resetPriorityThresholdOverrideForSymbol,
} from '@/lib/priority-threshold-overrides';
import {
  schedulePreCloseTimer,
  maybeTriggerPreClose as maybeTriggerPreCloseImpl,
  getPreCloseTriggeredCandleTime,
  resetPreCloseTriggeredCandleTime,
  clearPreCloseTimer,
} from './tick-store/pre-close';
import { maybeResolveOutcomes as maybeResolveOutcomesImpl } from './tick-store/outcomes';

const MAX_CANDLES = 600;
const COMPUTE_THROTTLE_MS = 800;
const TICK_THROTTLE_MS = 200;
const BARS_TO_RESOLVE = 5;
const MARKET_HOURS_RECHECK_MS = 30_000;

type CandleLifecycleState = 'live' | 'stale' | 'closed';

export interface TickState {
  candles: Candle[];
  currentPrice: number | null;
  loading: boolean;
  error: string | null;
  errorDetail: string | null;
  sourceFallbackNotice: string | null;
  lastPriceFlash: 'up' | 'down' | null;
  activeSymbolId: string;
  activeTimeframe: Timeframe;
  historyLoadedKey: string | null;
  marketClosed: boolean;
  unsubscribe: (() => void) | null;
  lastComputeAt: number;
  lastTickAt: number;
  lastTick: Tick | null;
  lastCandleUpdatedAt: number;
  lastCandleCloseAtMs: number;
  candleLifecycle: CandleLifecycleState;
  indicatorSnapshot: IndicatorSnapshot | null;
  indicatorSeries: ReturnType<typeof buildFullSnapshot>['series'] | null;
  fullSnapshot: ReturnType<typeof buildFullSnapshot>['snapshot'] | null;
  prioritySignal: Signal | null;
  start: (symbolId: string, timeframe: Timeframe) => Promise<void>;
  stop: () => void;
  clearError: () => void;
  clearPrioritySignal: () => void;
  // Этап 4 плана калибровки: applyPriorityThresholdForSymbol/
  // resetPriorityThresholdForSymbol — единственный путь применения нового
  // priorityThreshold из CalibrationPanel.tsx. В отличие от
  // PATTERN_RELIABILITY_MULTIPLIER (который читается read-through на каждый
  // evaluate()), priorityThreshold — приватное push-based поле
  // DecisionEngine (см. engine.ts), поэтому запись override без явного
  // engine.setPriorityThreshold() физически не долетела бы до движка до
  // следующего switchCalibrationModel()/изменения глобального слайдера.
  // Эти экшены делают оба шага атомарно: запись override
  // (priority-threshold-overrides.ts) + немедленный пуш в движок, если
  // применяется к ТЕКУЩЕМУ активному символу.
  applyPriorityThresholdForSymbol: (symbolId: string, value: number) => void;
  resetPriorityThresholdForSymbol: (symbolId: string) => void;
}

let engine: DecisionEngine | null = null;
let outcomeScheduler: OutcomeScheduler | null = null;
// Этап 1 аудита ("КАЛИБРОВКА"/"АНАЛИТИКА ПО ФАКТОРАМ" не связаны, п.1):
// раньше здесь была ОДНА калибровочная модель на всё приложение,
// независимо от activeSymbolId — исходы, скажем, BTCUSDT и EURUSD обучали
// одну и ту же логрегрессию, и модель не могла понять, что предсказательно
// для одного инструмента, а что для другого. Теперь calibrationModel —
// модель ТЕКУЩЕГО активного символа (для обратной совместимости с кодом
// ниже, который читает её как раньше — maybeConsiderRevision,
// outcomeDeps()), а calibrationModelsBySymbol хранит по одной модели на
// каждый уже посещённый в этой сессии инструмент, чтобы переключение
// символа туда-обратно не теряло накопленные сэмплы и не дёргало лишний
// раз localStorage/Supabase.
const calibrationModelsBySymbol = new Map<string, CalibrationModel>();
let calibrationModel: CalibrationModel | null = null;
let marketHoursTimer: ReturnType<typeof setInterval> | null = null;
let retrainInFlight = false;

// Offloads CalibrationModel's logistic-regression retrain (500-epoch
// full-batch gradient descent) to the compute worker instead of blocking the
// UI thread. Single call site for all three places that used to call
// calibrationModel.retrain()/model.retrain() directly (switchCalibrationModel's
// DB-load branch and maybeResolveOutcomes() below).
//
// - Skips the request entirely if the model isn't ready yet (mirrors the
//   MIN_SAMPLES guard retrain() used to apply internally).
// - Skips (does not queue) if a retrain is already in flight — the extra
//   call is simply dropped rather than piling up requests.
// - Persists (persistCalibrationState / saveCalibrationState) only after the
//   worker actually returns a result, never before.
// - symbolId (Этап 1 аудита, п.2): каждая модель теперь персистится под
//   СВОИМ инструментом — и в localStorage (ключ `${STORAGE_KEY}:${symbolId}`,
//   см. calibration-model.ts), и в Supabase (столбец symbol_id в
//   calibration_state, см. миграцию per-symbol calibration state) — а не в
//   единый глобальный ключ/строку, как раньше.
async function triggerRetrain(model: CalibrationModel, symbolId: string): Promise<void> {
  // Всегда персистим сэмплы и обновляем UI-счётчик, даже если модель ещё не
  // готова к ретрейну (< MIN_SAMPLES). До этого фикса ранний return здесь
  // означал, что сэмплы накапливались только в памяти — после перезагрузки
  // страницы модель создавалась с нуля, и счётчик "Сбор данных (0 из 100)"
  // не рос, хотя в "ИСТОРИЯ СИГНАЛОВ" закрытые сигналы были.
  persistCalibrationState(model, symbolId);
  void saveCalibrationState(model.exportState(), model.getSamples(), symbolId);
  if (calibrationModel === model) {
    useAnalyticsStore.getState().setCalibrationState(model.exportState());
  }

  if (!model.isReady()) return;
  if (retrainInFlight) return;
  retrainInFlight = true;
  try {
    const result = await workerClient.retrainCalibration(model.getSamples(), FEATURE_COUNT);
    model.applyTrainedWeights(result);
    persistCalibrationState(model, symbolId);
    void saveCalibrationState(model.exportState(), model.getSamples(), symbolId);
    // Обновляем UI-стор только если это всё ещё модель активного символа —
    // ретрейн может завершиться уже после того, как пользователь
    // переключился на другой инструмент.
    if (calibrationModel === model) {
      useAnalyticsStore.getState().setCalibrationState(model.exportState());
    }
  } catch (err) {
    captureError(err, { context: 'worker.retrainCalibration' });
  } finally {
    retrainInFlight = false;
  }
}

function startMarketHoursWatch(
  set: (partial: Partial<TickState>) => void,
  get: () => TickState,
): void {
  if (marketHoursTimer) clearInterval(marketHoursTimer);
  marketHoursTimer = setInterval(() => {
    const { activeSymbolId } = get();
    if (!activeSymbolId) return;
    const symbol = findSymbol(activeSymbolId);
    if (!symbol) return;
    const closed = !isMarketOpen(symbol);
    const prev = get().marketClosed;
    if (closed !== prev) {
      set({ marketClosed: closed });
      const cur = useAnalyticsStore.getState().connectionStatus;
      if (closed && cur === 'live') {
        useAnalyticsStore.setState({ connectionStatus: 'market_closed' });
      } else if (!closed && cur === 'market_closed') {
        useAnalyticsStore.setState({ connectionStatus: 'live' });
      }
    }
  }, MARKET_HOURS_RECHECK_MS);
}

// Возвращает уже загруженную в этой сессии модель для symbolId, либо
// восстанавливает её из localStorage (per-symbol ключ), либо создаёт
// новую с нуля — в этом порядке приоритета. Ничего не обращается к
// Supabase здесь — асинхронная проверка БД происходит в
// switchCalibrationModel() ниже, т.к. она может занять время и не должна
// блокировать синхронное переключение символа.
function loadOrCreateCalibrationModel(symbolId: string): CalibrationModel {
  const cached = calibrationModelsBySymbol.get(symbolId);
  if (cached) return cached;
  const model = loadCalibrationState(FEATURE_COUNT, symbolId) ?? new CalibrationModel(FEATURE_COUNT);
  calibrationModelsBySymbol.set(symbolId, model);
  return model;
}

// Этап 1 аудита ("КАЛИБРОВКА"/"АНАЛИТИКА ПО ФАКТОРАМ" не связаны, п.1–2):
// переключает активную калибровочную модель на модель symbolId — вызывается
// из start() с ЦЕЛЕВЫМ символом явным параметром (а не читается из
// get().activeSymbolId, которое на момент вызова в start() ещё указывает на
// предыдущий символ). Синхронно подставляет уже известное состояние
// (из памяти/localStorage) в движок и в UI-стор, затем асинхронно проверяет
// Supabase — она может содержать более новое состояние (например, если
// пользователь заходил с другого устройства/вкладки), не блокируя при этом
// само переключение символа.
function switchCalibrationModel(symbolId: string): void {
  const model = loadOrCreateCalibrationModel(symbolId);
  calibrationModel = model;
  if (engine) {
    engine.setCalibration(model);
    // Этап 4 плана калибровки: порог входа переключается на per-symbol
    // значение синхронно с калибровочной моделью, в том же месте, где уже
    // переключается модель — не создаём отдельную точку переключения,
    // чтобы не рисковать рассинхронизацией, если кто-то забудет вызвать
    // обе при будущих правках. См. priority-threshold-overrides.ts.
    engine.setPriorityThreshold(
      effectivePriorityThresholdForSymbol(symbolId, useSettingsStore.getState().priorityThreshold),
    );
  }
  useAnalyticsStore.getState().setCalibrationState(model.exportState());

  void loadCalibrationStateFromDb(symbolId).then(async (dbState) => {
    if (!dbState) return;
    const m = calibrationModelsBySymbol.get(symbolId);
    if (!m) return;
    m.loadState(dbState.state);
    if (dbState.samples.length > 0) {
      m.loadSamples(dbState.samples);
      await triggerRetrain(m, symbolId);
    }
    // Применяем к движку/UI только если пользователь всё ещё на этом
    // инструменте — иначе модель просто дожидается своего активного
    // момента в calibrationModelsBySymbol.
    if (calibrationModel === m) {
      if (engine) engine.setCalibration(m);
      useAnalyticsStore.getState().setCalibrationState(m.exportState());
    }
  });
}

// Этап 4 плана калибровки: symbolId — опциональный, передаётся вызывающим
// кодом, когда он уже известен на момент создания движка (см. start(),
// maybeEvaluateSignal), чтобы движок с самого создания получал per-symbol
// priorityThreshold, а не глобальный дефолт — тот же принцип, что уже
// применён к calibration в этой же функции. Значение имеет эффект только
// при ПЕРВОМ создании движка (engine — модульный синглтон, если !engine);
// последующие вызовы без символа не откатывают уже применённый порог —
// им и не нужно: switchCalibrationModel() уже держит его синхронизированным
// при каждом переключении инструмента.
function ensureEngine(symbolId?: string): DecisionEngine {
  if (!engine) {
    const sensitivity = useSettingsStore.getState().sensitivity;
    const scoreThreshold = sensitivity === 'strict'
      ? 4
      : useSettingsStore.getState().indicators.scoreThreshold;
    const globalPriorityThreshold = useSettingsStore.getState().priorityThreshold;
    const effectiveSymbolId = symbolId || useSettingsStore.getState().symbolId;
    engine = new DecisionEngine({
      calibration: calibrationModel,
      barsToResolve: BARS_TO_RESOLVE,
      scoreThreshold,
      signalToggles: useSettingsStore.getState().signalToggles,
      priorityThreshold: effectiveSymbolId
        ? effectivePriorityThresholdForSymbol(effectiveSymbolId, globalPriorityThreshold)
        : globalPriorityThreshold,
      // "Система мартингейла" (Демо-счёт → SettingsPanel.tsx) — тот же тумблер,
      // что управляет повышением ставки по стадиям 1-3 в useDemoAccountStore.
      // При его включении движок с самого создания должен фильтровать сигналы
      // до 'strong' — см. также подписку ниже (martingaleModeUnsub) для live-
      // реакции на переключение без пересоздания движка.
      strongSignalsOnly: useDemoAccountStore.getState().martingaleEnabled,
    });
    // АУДИТ 2026-09-13: сидируем уже известную серию сразу при создании
    // движка (а не ждём первого resolve после reload/смены символа) — тем
    // же способом, что strongSignalsOnly чуть выше, только через setter, а
    // не конструктор, т.к. lossStreakGuardEnabled по умолчанию true и сам
    // конструктор его не принимает как обязательный параметр. См. также
    // lossStreakUnsub ниже для live-обновлений после этой точки.
    engine.setLossStreak(useDemoAccountStore.getState().currentLossStreak);
  }
  return engine;
}

function ensureScheduler(): OutcomeScheduler {
  if (!outcomeScheduler) {
    outcomeScheduler = new OutcomeScheduler();
  }
  return outcomeScheduler;
}

// Экспортируется для ручной очистки истории сигналов (кнопка "Удалить все"
// в SignalFeed.tsx, см. clearSignalHistory там же): outcomeScheduler — это
// module-level синглтон, независимый от useAnalyticsStore, поэтому одной
// только clearSignalHistory() недостаточно — без этого вызова уже
// запланированные, но ещё не отрисованные (удалённые из истории) сигналы
// продолжали бы тихо резолвиться в фоне и (в зависимости от таймингов)
// могли бы всплыть обратно через updateSignalOutcome/upsertSignal.
export function clearOutcomeScheduler(): void {
  outcomeScheduler?.clear();
}

// Явные зависимости для вынесенного maybeResolveOutcomes (см.
// src/stores/tick-store/outcomes.ts) — ensureEngine/ensureScheduler и
// calibrationModel/triggerRetrain остаются модульными синглтонами здесь и
// передаются наружу параметром, а не через импорт стора внутрь outcomes.ts.
function outcomeDeps() {
  return {
    ensureEngine,
    ensureScheduler,
    // Этап 1 аудита, п.1–2: по symbolId сигнала (а не по текущему
    // activeSymbolId) — так исход всегда попадает в модель ТОГО
    // инструмента, по которому реально был сигнал, даже в невероятном
    // edge-кейсе, если пользователь успел переключиться на другой символ
    // между появлением сигнала и резолвом его исхода.
    getCalibrationModel: (symbolId: string) => calibrationModelsBySymbol.get(symbolId) ?? null,
    triggerRetrain,
  };
}

function resolvePendingAsTimeout(): void {
  if (!outcomeScheduler) return;
  const analytics = useAnalyticsStore.getState();
  for (const p of outcomeScheduler.getPendingList()) {
    const sig = p.signal;
    // Аудит (синхронизация с демо-счётом): сигналы, по которым уже открыта
    // демо-сделка, здесь принудительно НЕ тайм-аутим — их финальный outcome
    // обязана выставить useDemoAccountStore в момент реального закрытия
    // сделки (сейчас или позже, через resolveFromHistory при повторном
    // заходе на этот инструмент). Форсированный тайм-аут здесь для них
    // воссоздал бы тот же двойной источник исхода, который и был причиной
    // бага — реальная сделка потом придёт со своим (возможно другим)
    // результатом и перезапишет уже показанный пользователю "Тайм-аут".
    if (sig.tradeOpened) continue;
    analytics.updateSignalOutcome(sig.id, 'timeout');
    void updateSignalOutcome(sig.id, 'timeout');
  }
  analytics.recomputeStats();
}

export const useTickStore = create<TickState>((set, get) => ({
  candles: [],
  currentPrice: null,
  loading: false,
  error: null,
  errorDetail: null,
  sourceFallbackNotice: null,
  lastPriceFlash: null,
  activeSymbolId: '',
  activeTimeframe: '15m',
  historyLoadedKey: null,
  marketClosed: false,
  unsubscribe: null,
  lastComputeAt: 0,
  lastTickAt: 0,
  lastTick: null,
  lastCandleUpdatedAt: 0,
  lastCandleCloseAtMs: 0,
  candleLifecycle: 'live',
  indicatorSnapshot: null,
  indicatorSeries: null,
  fullSnapshot: null,
  prioritySignal: null,

  start: async (symbolId: string, timeframe: Timeframe) => {
    const state = get();
    if (state.activeSymbolId === symbolId && state.activeTimeframe === timeframe && state.unsubscribe) {
      return;
    }
    state.stop();
    workerClient.resetStreaming();

    // Clear all state on mode/symbol switch
    set({
      candles: [],
      currentPrice: null,
      indicatorSnapshot: null,
      indicatorSeries: null,
      fullSnapshot: null,
      prioritySignal: null,
      lastPriceFlash: null,
      lastTick: null,
      lastCandleUpdatedAt: Date.now(),
      lastCandleCloseAtMs: 0,
      candleLifecycle: 'live',
    });
    resolvePendingAsTimeout();
    useAnalyticsStore.getState().resetSession();
    resetPreCloseTriggeredCandleTime();

    ensureEngine(symbolId);
    // Этап 1 аудита, п.1–2: подставляем модель КАЛИБРОВКИ конкретно для
    // symbolId, на который переключаемся — до этого фикса ensureEngine()
    // грузил/создавал калибровочную модель ровно один раз за всё время
    // жизни приложения и больше никогда её не трогал при смене инструмента.
    switchCalibrationModel(symbolId);
    ensureScheduler();
    outcomeScheduler!.clear();

    // Баг 1 (ИСТОРИЯ СИГНАЛОВ), первопричина №2: signals теперь персистится
    // через localStorage (см. useAnalyticsStore) и больше не стирается
    // clearAll()'ом выше — но outcomeScheduler это module-level синглтон
    // БЕЗ персистентности, и .clear() выше в любом случае обнуляет его
    // pending-очередь на каждый start(). Без реseed-а ниже любой сигнал,
    // который был 'pending' на момент перезагрузки страницы (или всё ещё
    // 'pending' для того же symbolId/timeframe после resolvePendingAsTimeout,
    // который финализирует только то, что действительно было в СТАРОМ
    // scheduler'е), навсегда завис бы без исхода — это и есть "некоторые
    // сигналы не получают статус, из-за чего статистика неверна".
    // Планировщик заново заполняется PENDING-сигналами именно из
    // восстановленной истории для целевого symbolId/timeframe: onCandleClosed
    // ниже досчитает их исход по уже загруженным/будущим свечам, включая
    // ретроактивно (см. barsToCheck в resolveOutcome — не зависит от того,
    // сколько реального времени прошло).
    for (const sig of useAnalyticsStore.getState().signals) {
      if (sig.outcome === 'pending' && sig.symbolId === symbolId && sig.timeframe === timeframe) {
        outcomeScheduler!.schedule(sig);
      }
    }

    set({
      loading: true,
      error: null,
      errorDetail: null,
      sourceFallbackNotice: null,
      activeSymbolId: symbolId,
      activeTimeframe: timeframe,
      historyLoadedKey: null,
      marketClosed: false,
      lastCandleUpdatedAt: Date.now(),
      lastCandleCloseAtMs: 0,
      candleLifecycle: 'live',
    });
    useAnalyticsStore.setState({ connectionStatus: 'connecting' });

    const symbol = findSymbol(symbolId);
    if (!symbol) {
      const detail = `Unknown symbol: ${symbolId}`;
      set({ loading: false, error: getHumanReadableError('unknown-symbol'), errorDetail: detail });
      captureError(new Error(detail), { level: 'warning' });
      useAnalyticsStore.setState({ connectionStatus: 'failed' });
      return;
    }

    const marketClosed = !isMarketOpen(symbol);
    set({ marketClosed });
    if (marketClosed) {
      useAnalyticsStore.setState({ connectionStatus: 'market_closed' });
    }
    startMarketHoursWatch(set, get);

    const historyKey = `${symbolId}:${timeframe}`;
    try {
      const { status, candles: history } = await connectionManager.connectAndGetHistory(symbol, timeframe);
      if (get().activeSymbolId !== symbolId || get().activeTimeframe !== timeframe) return;

      if (status === 'failed') {
        const detail = 'All data sources failed to connect';
        set({ loading: false, error: getHumanReadableError('all-sources-failed'), errorDetail: detail, sourceFallbackNotice: null });
        captureError(new Error(detail), { level: 'warning' });
        useAnalyticsStore.setState({ connectionStatus: 'failed' });
        return;
      }

      const deduped = dedupeHistory(history);
      const compacted = compactTimeline(deduped, timeframe, symbol.assetClass);
      const settings = useSettingsStore.getState();
      const features = getActiveFeatures(settings);
      const { snapshot: fullSnap, series: fullSeries } = buildFullSnapshot(compacted, settings.indicators, features);
      set({
        candles: compacted,
        historyLoadedKey: historyKey,
        loading: false,
        sourceFallbackNotice: null,
        currentPrice: compacted.length > 0 ? compacted[compacted.length - 1].close : null,
        indicatorSnapshot: fullSnap.indicators,
        indicatorSeries: fullSeries,
        fullSnapshot: fullSnap,
        lastCandleUpdatedAt: Date.now(),
        lastCandleCloseAtMs: 0,
        candleLifecycle: 'live',
      });
      useDemoAccountStore.getState().resolveFromHistory(symbolId, timeframe, compacted);
    } catch (err) {
      if (get().activeSymbolId !== symbolId) return;
      const message = err instanceof Error ? err.message : 'Failed to load market data';
      const reason = classifyDataError(message);
      set({ loading: false, error: getHumanReadableError(reason), errorDetail: message, sourceFallbackNotice: null });
      captureError(err, { context: 'tickStore.start' });
      useAnalyticsStore.setState({ connectionStatus: 'failed' });
      return;
    }

    const unsubCandles = connectionManager.onCandle((candle, isClosed) =>
      void handleCandle(candle, isClosed, set, get),
    );
    const unsubTicks = connectionManager.onTick((tick) => handleTick(tick, set, get));
    set({ unsubscribe: () => { unsubCandles(); unsubTicks(); } });

    schedulePreCloseTimer(set, get, { ensureEngine, ensureScheduler });
  },

  stop: () => {
    const { unsubscribe } = get();
    if (unsubscribe) {
      unsubscribe();
      set({ unsubscribe: null });
    }
    if (marketHoursTimer) { clearInterval(marketHoursTimer); marketHoursTimer = null; }
    clearPreCloseTimer();
    connectionManager.disconnect();
    set({ activeSymbolId: '' });
  },

  clearError: () => set({ error: null, errorDetail: null }),
  clearPrioritySignal: () => set({ prioritySignal: null }),

  applyPriorityThresholdForSymbol: (symbolId: string, value: number) => {
    applyPriorityThresholdOverrideForSymbol(symbolId, value);
    if (engine && get().activeSymbolId === symbolId) {
      engine.setPriorityThreshold(value);
    }
  },

  resetPriorityThresholdForSymbol: (symbolId: string) => {
    resetPriorityThresholdOverrideForSymbol(symbolId);
    if (engine && get().activeSymbolId === symbolId) {
      engine.setPriorityThreshold(useSettingsStore.getState().priorityThreshold);
    }
  },
}));

let statusUnsub: (() => void) | null = null;
statusUnsub = connectionManager.onStatus((status) => {
  useAnalyticsStore.setState({ connectionStatus: status });
  if (status === 'live') {
    useTickStore.setState({ sourceFallbackNotice: null });
  }
});
if (import.meta.hot) {
  import.meta.hot.dispose(() => { if (statusUnsub) statusUnsub(); });
}

// Показывает пользователю, что цепочка источников (getRoutingChain) сейчас
// переключается на следующий источник, вместо тишины до финального
// успеха/провала. Сама цепочка/ретраи не меняются — см. connection-manager.ts.
let sourceAttemptUnsub: (() => void) | null = null;
sourceAttemptUnsub = connectionManager.onSourceAttempt(({ sourceId, isFallback, previousSourceId }) => {
  if (!isFallback) {
    useTickStore.setState({ sourceFallbackNotice: null });
    return;
  }
  const prevLabel = previousSourceId ? sourceLabel(previousSourceId) : 'Источник';
  useTickStore.setState({
    sourceFallbackNotice: `${prevLabel} недоступен, переключаемся на ${sourceLabel(sourceId)}…`,
  });
});
if (import.meta.hot) {
  import.meta.hot.dispose(() => { if (sourceAttemptUnsub) sourceAttemptUnsub(); });
}

let sensitivityUnsub: (() => void) | null = null;
sensitivityUnsub = useSettingsStore.subscribe((s, prev) => {
  if (s.sensitivity !== prev.sensitivity && engine) {
    engine.setScoreThreshold(s.sensitivity === 'strict' ? 4 : s.indicators.scoreThreshold);
  }
  // Задача 1.1: scoreThreshold now lives in IndicatorConfig, so a change to
  // it (e.g. via "Reset to defaults") must propagate live too — not just on
  // sensitivity toggle — as long as "strict" isn't overriding it.
  if (s.indicators.scoreThreshold !== prev.indicators.scoreThreshold && s.sensitivity !== 'strict' && engine) {
    engine.setScoreThreshold(s.indicators.scoreThreshold);
  }
  if (s.signalToggles !== prev.signalToggles && engine) {
    engine.setSignalToggles(s.signalToggles);
  }
  if (s.priorityThreshold !== prev.priorityThreshold && engine) {
    // Этап 4 плана калибровки: изменение ГЛОБАЛЬНОГО слайдера продолжает
    // работать как раньше для любого символа БЕЗ собственного per-symbol
    // override; для символа с активным override глобальный слайдер
    // по-прежнему не должен его перекрывать — та же гарантия, что уже даёт
    // getReliabilityMultiplier() для паттернов (см.
    // priority-threshold-overrides.ts).
    const activeSymbolId = useTickStore.getState().activeSymbolId;
    engine.setPriorityThreshold(effectivePriorityThresholdForSymbol(activeSymbolId, s.priorityThreshold));
  }
});
if (import.meta.hot) {
  import.meta.hot.dispose(() => { if (sensitivityUnsub) sensitivityUnsub(); });
}

// "Система мартингейла": живое переключение strongSignalsOnly в уже
// созданном движке — без этой подписки тумблер в SettingsPanel.tsx менял бы
// поведение только после пересоздания движка (смена символа/перезагрузка),
// а не сразу, что для риск-настройки недопустимо: пользователь ожидает,
// что "выключил мартингейл — тут же снова пошли средние/слабые сигналы" и
// наоборот.
let martingaleModeUnsub: (() => void) | null = null;
martingaleModeUnsub = useDemoAccountStore.subscribe((s, prev) => {
  if (s.martingaleEnabled !== prev.martingaleEnabled && engine) {
    engine.setStrongSignalsOnly(s.martingaleEnabled);
  }
});
if (import.meta.hot) {
  import.meta.hot.dispose(() => { if (martingaleModeUnsub) martingaleModeUnsub(); });
}

// АУДИТ 2026-09-13 ("не допустить 3 убыточные сделки подряд"): то же самое
// зеркалирование, что и martingaleModeUnsub выше, но для реальной серии
// подряд идущих убытков (см. useDemoAccountStore.currentLossStreak и
// decision/loss-streak-guard.ts). Движок сам не резолвит сделки и не знает
// P&L — единственный источник истины для серии это useDemoAccountStore
// (checkExpiries/resolveFromHistory), а этот подписчик лишь переносит уже
// посчитанное значение в уже созданный движок setLossStreak(), без
// пересоздания движка и без задержки до следующей смены символа.
let lossStreakUnsub: (() => void) | null = null;
lossStreakUnsub = useDemoAccountStore.subscribe((s, prev) => {
  if (s.currentLossStreak !== prev.currentLossStreak && engine) {
    engine.setLossStreak(s.currentLossStreak);
  }
});
if (import.meta.hot) {
  import.meta.hot.dispose(() => { if (lossStreakUnsub) lossStreakUnsub(); });
}

function dedupeHistory(candles: Candle[]): Candle[] {
  const seen = new Set<number>();
  const out: Candle[] = [];
  for (const c of candles) {
    if (seen.has(c.time)) continue;
    seen.add(c.time);
    out.push(c);
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

function deriveCandleLifecycleState(
  candle: Candle,
  timeframe: Timeframe,
  serverNowMs: number,
  lastUpdatedAtMs: number,
  isClosed: boolean,
  lastCandleCloseAtMs: number,
): CandleLifecycleState {
  const closeTimeMs = (candle.time + TIMEFRAME_SECONDS[timeframe]) * 1000;
  if (isClosed || serverNowMs >= closeTimeMs) {
    const staleThresholdMs = Math.max(15_000, TIMEFRAME_SECONDS[timeframe] * 1000 * 2);
    if (lastCandleCloseAtMs > 0 && serverNowMs - lastCandleCloseAtMs > staleThresholdMs) {
      return 'stale';
    }
    return 'closed';
  }
  if (lastUpdatedAtMs > 0 && serverNowMs - lastUpdatedAtMs > Math.max(15_000, TIMEFRAME_SECONDS[timeframe] * 1000 * 2)) {
    return 'stale';
  }
  return 'live';
}

export async function handleCandle(
  candle: Candle,
  isClosed: boolean,
  set: (partial: Partial<TickState>) => void,
  get: () => TickState,
): Promise<void> {
  if (get().activeSymbolId === '') return;
  const candles = [...get().candles];
  const last = candles[candles.length - 1];
  if (last && last.time === candle.time) {
    // Мерж, а не полная замена: для одной и той же (ещё формирующейся или
    // только что закрытой) свечи high/low должны только расширяться, а не
    // регрессировать. Раньше здесь была полная перезапись (`candles[...] =
    // candle`), из-за которой более поздний, но более "узкий" снимок (типичный
    // случай — REST-poll в DerivSource, который может обгонять WS по времени
    // прихода, но нести более старые/агрегированные high/low, чем то, что
    // локально уже накоплено через handleTick) визуально уменьшал high и
    // увеличивал low на графике в реальном времени. open берём из первого
    // пришедшего снимка этой свечи (last.open), а не переписываем его —
    // именно open фиксирует начало свечи и не должен "плавать" от источника
    // к источнику.
    candles[candles.length - 1] = {
      ...candle,
      open: last.open,
      high: Math.max(last.high, candle.high),
      low: Math.min(last.low, candle.low),
    };
  } else if (!last || candle.time > last.time) {
    // confirmEntryPrice вызывается безусловно при появлении новой свечи —
    // до дедап-гварда ниже. Это покрывает сценарий resync(): при повторной
    // доставке уже обработанного перехода свечи гвард пропускает резолюцию,
    // но confirmEntryPrice всё равно должна сработать, если цена ещё не
    // подтверждена (идемпотентна — правит только entryPrice === null).
    if (last) {
      useDemoAccountStore.getState().confirmEntryPrice(
        get().activeSymbolId, get().activeTimeframe, candle.time, candle.open,
      );
    }
    if (last) {
      const prevCloseMs = (last.time + TIMEFRAME_SECONDS[get().activeTimeframe]) * 1000;
      if (get().lastCandleCloseAtMs !== prevCloseMs) {
        set({
          lastCandleUpdatedAt: serverClock.now(),
          lastCandleCloseAtMs: prevCloseMs,
          candleLifecycle: 'closed',
        });
        maybeCompute(set, get);
        useDemoAccountStore.getState().checkExpiries(last.close, prevCloseMs, get().activeSymbolId, get().activeTimeframe);
        await maybeEvaluateSignal(set, get, true, candle.open);
        maybeResolveOutcomesImpl(get, outcomeDeps());
      }
    }
    candles.push(candle);
    if (candles.length > MAX_CANDLES) candles.shift();
    resetPreCloseTriggeredCandleTime();
  } else {
    return;
  }
  const state = get();
  const serverNowMs = serverClock.now();
  const lifecycle = deriveCandleLifecycleState(
    candle,
    state.activeTimeframe,
    serverNowMs,
    state.lastCandleUpdatedAt,
    isClosed,
    state.lastCandleCloseAtMs,
  );
  set({
    candles,
    currentPrice: candle.close,
    lastCandleUpdatedAt: serverNowMs,
    lastCandleCloseAtMs: isClosed ? (candle.time + TIMEFRAME_SECONDS[state.activeTimeframe]) * 1000 : state.lastCandleCloseAtMs,
    candleLifecycle: lifecycle,
  });
  // Планируем pre-close таймер ТОЛЬКО после того, как новая свеча попала в
  // store (см. set({candles, ...}) выше). Раньше schedulePreCloseTimer()
  // вызывался до этого set(...), поэтому get() внутри него ещё видел старый
  // массив candles, оканчивающийся уже ЗАКРЫВШЕЙСЯ свечой — closeTime такой
  // свечи всегда в прошлом, msUntilClose <= 0, и функция сразу выходила,
  // ничего не планируя. В результате таймер для новой (текущей) свечи не
  // взводился НИКОГДА, и предупреждение за 5 секунд до закрытия (звук +
  // баннер) не срабатывало.
  schedulePreCloseTimer(set, get, { ensureEngine, ensureScheduler });

  if (isClosed) {
    maybeCompute(set, get);
    useDemoAccountStore.getState().checkExpiries(candle.close, (candle.time + TIMEFRAME_SECONDS[state.activeTimeframe]) * 1000, state.activeSymbolId, state.activeTimeframe);
    await maybeEvaluateSignal(set, get, true);
    maybeResolveOutcomesImpl(get, outcomeDeps());
  } else {
    await maybeEvaluateSignal(set, get, false);
    await maybeConsiderRevision(set, get);
  }
}

function handleTick(
  tick: Tick,
  set: (partial: Partial<TickState>) => void,
  get: () => TickState,
): void {
  if (get().activeSymbolId === '') return;
  const now = Date.now();
  const throttled = now - get().lastTickAt < TICK_THROTTLE_MS;
  const prevPrice = get().currentPrice ?? tick.price;
  const flash = tick.price > prevPrice ? 'up' : tick.price < prevPrice ? 'down' : get().lastPriceFlash;

  const candles = get().candles;
  if (candles.length > 0 && !throttled) {
    const updated = [...candles];
    const last = { ...updated[updated.length - 1] };
    last.close = tick.price;
    if (tick.price > last.high) last.high = tick.price;
    if (tick.price < last.low) last.low = tick.price;
    updated[updated.length - 1] = last;
    set({ candles: updated });
  }

  if (throttled) {
    set({ currentPrice: tick.price, lastTick: tick, lastCandleUpdatedAt: now, lastCandleCloseAtMs: get().lastCandleCloseAtMs, candleLifecycle: 'live' });
    return;
  }
  set({ currentPrice: tick.price, lastPriceFlash: flash, lastTickAt: now, lastTick: tick, lastCandleUpdatedAt: now, lastCandleCloseAtMs: get().lastCandleCloseAtMs, candleLifecycle: 'live' });
  void maybeTriggerPreCloseImpl(set, get, { ensureEngine, ensureScheduler });
}

function maybeCompute(
  set: (partial: Partial<TickState>) => void,
  get: () => TickState,
): void {
  const state = get();
  if (state.candleLifecycle === 'stale') return;
  const now = Date.now();
  if (now - state.lastComputeAt < COMPUTE_THROTTLE_MS) return;
  set({ lastComputeAt: now });
  const settings = useSettingsStore.getState();
  const features = getActiveFeatures(settings);
  void workerClient
    .candleClosed(state.activeSymbolId, state.activeTimeframe, state.candles, settings.indicators, features)
    .then(({ snapshot, series }) => {
      const cur = get();
      if (cur.activeSymbolId !== state.activeSymbolId || cur.activeTimeframe !== state.activeTimeframe) return;
      set({ indicatorSnapshot: snapshot.indicators, indicatorSeries: series, fullSnapshot: snapshot });
    })
    .catch((err) => {
      captureError(err, { context: 'worker.candleClosed' });
    });
}

async function maybeEvaluateSignal(
  set: (partial: Partial<TickState>) => void,
  get: () => TickState,
  isClosed: boolean,
  knownOpenPrice?: number,
): Promise<void> {
  const state = get();
  const settings = useSettingsStore.getState();
  const features = getActiveFeatures(settings);
  const eng = ensureEngine(state.activeSymbolId);
  const serverNowMs = serverClock.now();

  let signal: Signal | null;
  try {
    signal = await eng.evaluate(
      state.activeSymbolId,
      state.activeTimeframe,
      state.candles,
      settings.indicators,
      features,
      state.lastTick,
      serverNowMs,
      isClosed,
    );
  } catch (err) {
    captureError(err, { context: 'engine.evaluate.maybeEvaluateSignal' });
    return;
  }

  // Гвард против гонки: eng.evaluate() выше — асинхронный (round-trip до
  // воркера). Если за это время пользователь переключил символ/таймфрейм
  // (или произошёл resetSession()+reseed scheduler'а при смене символа —
  // см. start()), get() ниже уже вернёт ДРУГОЕ активное состояние, а
  // signal/finalSignal всё ещё построены по СТАРОМУ символу — тот же
  // паттерн, что уже был учтён в maybeCompute() (см. .then(...) там:
  // `if (cur.activeSymbolId !== state.activeSymbolId ...) return;`), но
  // здесь этой проверки не было. Без неё «протухший» сигнал от предыдущего
  // символа мог примешаться в analytics.signals уже ПОД НОВЫМ символом —
  // а поскольку signals теперь глобальная персистентная история (не
  // сбрасывается на переключение), такой сигнал не вычищался бы даже
  // следующим стартом; с точки зрения пользователя это выглядит как
  // «лишний сигнал, всплывший непонятно откуда», часто с меткой времени,
  // похожей на текущую (обе свечи «сейчас»), и который потом либо никогда
  // не резолвится (планировщик и eng к этому моменту уже принадлежат
  // новому символу), либо резолвится некорректно — то есть карточка в
  // истории застревает без ПРИБЫЛЬ/УБЫТОК/ТАЙМ-АУТ.
  if (get().activeSymbolId !== state.activeSymbolId || get().activeTimeframe !== state.activeTimeframe) {
    return;
  }

  let finalSignal: Signal | null = signal;
  if (isClosed) {
    const frozen = eng.onCandleClosed();
    finalSignal = frozen ?? signal;
  }
  if (!finalSignal) return;

  // Демо-сделка открывается РОВНО одним из двух способов, и никогда — на
  // произвольном промежуточном тике внутри свечи:
  //  1) maybeTriggerPreClose — основной путь, срабатывает ровно один раз за
  //     свечу, за PRE_CLOSE_SIGNAL_LEAD_MS до её закрытия, с ценой, близкой
  //     к реальному открытию следующей свечи;
  //  2) здесь, при isClosed === true — подстраховка на случай, если
  //     pre-close таймер не успел сработать (например, вкладка была
  //     свёрнута/выгружена браузером), либо pre-close сработал, но на своём
  //     (более раннем) вызове evaluate() ещё не нашёл валидного сигнала, а к
  //     моменту реального закрытия свечи сигнал уже появился. Дедуп по
  //     signal.id в openTrade гарантирует, что если pre-close уже открыл
  //     сделку, повторного открытия здесь не произойдёт.
  //
  //     ВАЖНО (аудит, п.3): раньше условие ниже было
  //     `getPreCloseTriggeredCandleTime() === lastCandle.time`, что на самом
  //     деле означает противоположное описанному выше — блок срабатывал,
  //     только если pre-close УЖЕ пометил эту свечу (в норме — уже открыл
  //     сделку сам, тогда это безобидный no-op через дедуп), и НЕ срабатывал,
  //     если pre-close вообще не выстрелил. То есть настоящая подстраховка
  //     не работала: если таймер pre-close не успел сработать (свёрнутая
  //     вкладка и т.п.), сделка не открывалась вообще, а если и открывалась
  //     (сигнал появился только на закрытии), то полностью без звука/баннера
  //     — ни то, ни другое место уведомление не отправляло.
  //
  //     Сейчас: на пути гарантированного перехода к новой свече
  //     (knownOpenPrice передан — см. вызов на переходе candle.time >
  //     last.time) пытаемся открыть сделку всегда, независимо от того,
  //     пометил ли pre-close эту свечу — именно это и есть подстраховка.
  //     На "догоняющем" пути (без knownOpenPrice — например, батчевая
  //     доставка уже закрытых исторических свечей после реконнекта)
  //     сохраняем прежнее строгое условие, чтобы не открывать сделки на
  //     заведомо устаревших свечах, для которых pre-close в принципе не мог
  //     сработать в реальном времени.
  if (isClosed) {
    const lastCandle = state.candles[state.candles.length - 1];
    const preCloseHandledThisCandle = getPreCloseTriggeredCandleTime() === lastCandle.time;
    const canAttemptOpenHere = knownOpenPrice !== undefined || preCloseHandledThisCandle;
    if (canAttemptOpenHere) {
      const demoStore = useDemoAccountStore.getState();
      const alreadyOpenBefore = Boolean(demoStore.openTrades[finalSignal.id]);
      demoStore.openTrade(finalSignal, knownOpenPrice);
      const openedJustNow = !alreadyOpenBefore && Boolean(useDemoAccountStore.getState().openTrades[finalSignal.id]);
      // Уведомляем (звук + приоритетный баннер) только если сделка реально
      // открылась именно в этой ветке — если pre-close уже открыл и
      // уведомил по этому же signal.id, дублировать не нужно.
      if (openedJustNow) {
        notifySignal(finalSignal, settings, set);
      }
    }
    // Аудит (синхронизация с демо-счётом): фиксируем на сигнале, была ли по
    // нему реально открыта демо-сделка — либо только что, в блоке выше,
    // либо ранее (pre-close уже открыл её для того же signal.id). От этого
    // зависит, кто выставит финальный outcome (useDemoAccountStore при
    // закрытии сделки, либо, для непроторгованных сигналов, планировщик как
    // fallback — см. tick-store/outcomes.ts) и учитывается ли сигнал в
    // винрейте (см. useAnalyticsStore.recomputeStats).
    const tradeOpened = Boolean(useDemoAccountStore.getState().openTrades[finalSignal.id]);
    finalSignal = { ...finalSignal, tradeOpened };
  }

  // Аудит, п.2: setCurrentSignal/addSignal/schedule/saveSignal должны
  // выполняться СТРОГО в тех же двух случаях, что и открытие демо-сделки
  // выше (pre-close или закрытие свечи) — никогда на произвольном
  // промежуточном тике формирующейся свечи. Раньше вызов ниже был
  // безусловным и срабатывал на каждом isClosed === false тике, из-за чего
  // currentSignal (а с ним SignalFeed/DirectionIndicator в UI) мигал много
  // раз за одну свечу вместо одного стабильного обновления на pre-close.
  // Дедуп по signal.id в addSignal/scheduler делает повторный вызов здесь
  // при isClosed === true безопасным даже если pre-close уже это сделал.
  if (isClosed) {
    const analytics = useAnalyticsStore.getState();
    analytics.setCurrentSignal(finalSignal);
    analytics.addSignal(finalSignal);
    if (finalSignal.tradeOpened) {
      // Аудит (сигналы бесследно пропадают из ИСТОРИЯ СИГНАЛОВ): если
      // pre-close уже создал запись для этого signal.id со снимком
      // tradeOpened: false (структурно неизбежным на тот момент — см.
      // markTradeOpened в useAnalyticsStore.ts и комментарий в
      // pre-close.ts), addSignal() выше был безопасным no-op'ом и НЕ
      // обновил флаг. Здесь мы точно знаем, что сделка реально открыта
      // (см. вычисление tradeOpened чуть выше) — поднимаем флаг на
      // существующей записи, чтобы SignalFeed.tsx (фильтрует по
      // tradeOpened !== false) не скрывал сигналы, которые демо-счёт на
      // самом деле отторговал.
      analytics.markTradeOpened(finalSignal.id);
    }
    ensureScheduler().schedule(finalSignal);
    void saveSignal(finalSignal);
  }
}

async function maybeConsiderRevision(
  _set: (partial: Partial<TickState>) => void,
  get: () => TickState,
): Promise<void> {
  const state = get();
  const eng = ensureEngine(state.activeSymbolId);
  const frozen = eng.getFrozenSignal();
  if (!frozen) return;

  const settings = useSettingsStore.getState();
  const features = getActiveFeatures(settings);
  const serverNowMs = serverClock.now();

  let newSignal: Signal | null;
  try {
    newSignal = await eng.evaluate(
      state.activeSymbolId,
      state.activeTimeframe,
      state.candles,
      settings.indicators,
      features,
      state.lastTick,
      serverNowMs,
      false,
    );
  } catch (err) {
    captureError(err, { context: 'engine.evaluate.maybeConsiderRevision' });
    return;
  }
  // Тот же гвард от протухшего асинхронного ответа, что и в
  // maybeEvaluateSignal — см. комментарий там.
  if (get().activeSymbolId !== state.activeSymbolId || get().activeTimeframe !== state.activeTimeframe) {
    return;
  }
  if (!newSignal) return;

  if (shouldRevise(newSignal.score, frozen.score)) {
    const revised = reviseSignal(
      frozen,
      newSignal.score,
      newSignal.reason,
      eng.getLastSnapshot() ?? {
        indicators: newSignal.indicators,
        patterns: [],
        structure: { trend: 'range', bos: false, choch: false, swingHigh: null, swingLow: null, provisional: false },
        regime: 'range',
        lastPrice: newSignal.entryPrice,
        candleTime: newSignal.time,
      },
      calibrationModel,
      {
        factors: newSignal.factors,
        rejectedPatterns: newSignal.rejectedPatterns,
        engineConfigSnapshot: newSignal.engineConfigSnapshot,
        chartContext: newSignal.chartContext,
        marketContext: newSignal.marketContext,
      },
    );
    // ВАЖНО: revised.id === frozen.id (reviseSignal сохраняет id исходного
    // сигнала) — то есть эта запись уже почти наверняка есть в
    // analytics.signals (её туда положил maybeEvaluateSignal/pre-close).
    // addSignal() у существующего id — намеренный no-op (см. её тесты и
    // JSDoc-отличие от upsertSignal): вызов addSignal() здесь означал, что
    // обновлённые score/reason/revisionNote вообще никогда не попадали в
    // историю сигналов — карточка в сайдбаре молча оставалась со старыми
    // (не revised) данными. upsertSignal() — как раз тот метод стора,
    // специально созданный для замены существующей записи по id.
    const analytics = useAnalyticsStore.getState();
    analytics.upsertSignal(revised);
  }
}

// Публичная обёртка над вынесенной реализацией (src/stores/tick-store/pre-close.ts)
// с прежней сигнатурой (set, get) — её напрямую используют существующие тесты
// (useTickStore.test.ts), поэтому она остаётся частью публичного API стора неизменной.
async function maybeTriggerPreClose(
  set: (partial: Partial<TickState>) => void,
  get: () => TickState,
): Promise<void> {
  return maybeTriggerPreCloseImpl(set, get, { ensureEngine, ensureScheduler });
}

export { MIN_SAMPLES, FEATURE_KEYS, maybeTriggerPreClose };

/// <reference lib="webworker" />
import type {
  WorkerInboundMessage,
  WorkerOutboundMessage,
} from '@/types/messages';
import type {
  IndicatorConfig,
  CalibrationResult,
  Timeframe,
  FeatureName,
  Candle,
} from '@/types/domain';
import { buildFullSnapshot } from '@/compute/full-snapshot';
import { computeIndicators } from '@/compute/IndicatorAggregator';
import { buildSignal } from '@/decision/signal-builder';
import { trainLogisticRegression } from '@/decision/calibration-model';
import { isSuppressedByCooldown, pruneResolvedSignals, type RecentSignalRecord } from '@/decision/signal-cooldown';
import { TIMEFRAME_SECONDS } from '@/data/symbols';
import type { IndicatorSnapshot } from '@/types/domain';

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

function post(msg: WorkerOutboundMessage): void {
  ctx.postMessage(msg);
}

// Cache of the last full compute result from candle_closed/snapshot_request.
// On tick_update we patch lastPrice into the cached snapshot instead of
// re-running every indicator from scratch.
let lastSnapshot: IndicatorSnapshot | null = null;

ctx.onmessage = (e: MessageEvent<WorkerInboundMessage>) => {
  const data = e.data;
  try {
    switch (data.type) {
      case 'candle_closed':
      case 'snapshot_request': {
        const { snapshot, series } = buildFullSnapshot(data.candles, data.config, data.activeFeatures, data.isClosed);
        const resultType = data.type === 'candle_closed' ? 'candle_closed_result' : 'snapshot_result';
        lastSnapshot = snapshot.indicators;
        post({ type: resultType, requestId: data.requestId, snapshot, series });
        break;
      }
      case 'tick_update': {
        const snapshot = computeIncremental(data);
        post({ type: 'tick_update_result', requestId: data.requestId, snapshot });
        break;
      }
      case 'reset_streaming': {
        lastSnapshot = null;
        break;
      }
      case 'calibrate': {
        const result = calibrateInWorker(
          data.symbolId,
          data.timeframe,
          data.candles,
          data.config,
        );
        post({ type: 'calibrate_result', requestId: data.requestId, result });
        break;
      }
      case 'retrain_calibration': {
        const result = trainLogisticRegression(data.samples, data.featureCount);
        post({
          type: 'retrain_calibration_result',
          requestId: data.requestId,
          weights: result.weights,
          bias: result.bias,
          // BUGFIX (аудит "калибровка: 0 сигналов после 100"): featureMean/
          // featureStd обязаны доехать до main thread вместе с weights — см.
          // calibration-model.ts::trainLogisticRegression.
          featureMean: result.featureMean,
          featureStd: result.featureStd,
        });
        break;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'compute failed';
    post({ type: 'worker_error', requestId: data.requestId, message });
  }
};

function computeIncremental(
  data: Extract<WorkerInboundMessage, { type: 'tick_update' }>,
): IndicatorSnapshot {
  const candles = data.candles;
  const config = data.config;
  const activeFeatures = data.activeFeatures;

  if (candles.length === 0) {
    return computeIndicators(candles, config, activeFeatures).snapshot;
  }

  // If we have a cached snapshot from the last candle_closed/snapshot_request,
  // reuse it instead of re-running all indicators. The only field that changes
  // on a tick is the last candle's close/high/low, which only affects
  // lastPrice — the indicator values are based on the closed candle.
  if (lastSnapshot) {
    return lastSnapshot;
  }

  return computeIndicators(candles, config, activeFeatures).snapshot;
}

// BUGFIX (Фаза 1/2/4, "честный бинарный опцион" — панель «Калибровка»
// перестроена под принцип бинарных опционов, не удалена, см. запрос
// пользователя): раньше это был grid-search по atrMultiplier, подбирающий
// stopLossPips/takeProfitPips с максимальным winRate внутри мини-бэктеста
// на основе касания SL/TP — оба понятия (структурный стоп/цель/R:R) не
// существуют для бинарного опциона с фиксированной экспирацией и
// фиксированной выплатой. Теперь это grid-search по expiryBars (сколько
// баров держать позицию до экспирации), метрика — ДОЛЯ ВЕРНЫХ ЗНАКОВ
// ДВИЖЕНИЯ (accuracy направления: закрытие на expiryBars-й свече выше/ниже
// entryPrice в сторону сигнала), а не winRate — winRate зависит от
// profitPercent выплаты и спред-поправки (см. decision/apply-spread.ts),
// accuracy — нет. Намеренно НЕ учитывает спред/выплату здесь — это
// отдельная забота (backtest/metrics.ts), а не часть self-learning
// калибровки экспирации.
const EXPIRY_BARS_OPTIONS = [1, 2, 3, 4];
const DEFAULT_EXPIRY_BARS = 1;
const MIN_TRADES = 8;

function calibrateInWorker(
  symbolId: string,
  timeframe: Timeframe,
  candles: Candle[],
  config: IndicatorConfig,
): CalibrationResult {
  const features: FeatureName[] = [];
  let best: CalibrationResult | null = null;

  for (const expiryBars of EXPIRY_BARS_OPTIONS) {
    const trades = backtestInWorker(symbolId, timeframe, candles, config, expiryBars, features);
    if (trades.length < MIN_TRADES) continue;
    let correct = 0;
    for (const t of trades) if (t.correct) correct += 1;
    const directionAccuracy = correct / trades.length;
    const candidate: CalibrationResult = {
      symbolId,
      timeframe,
      bestExpiryBars: expiryBars,
      directionAccuracy,
      totalTrades: trades.length,
      calibratedAt: Date.now(),
    };
    if (best === null || directionAccuracy > best.directionAccuracy) best = candidate;
  }

  if (best) return best;

  return {
    symbolId,
    timeframe,
    bestExpiryBars: DEFAULT_EXPIRY_BARS,
    directionAccuracy: 0,
    totalTrades: 0,
    calibratedAt: Date.now(),
  };
}

function backtestInWorker(
  symbolId: string,
  timeframe: Timeframe,
  candles: Candle[],
  config: IndicatorConfig,
  expiryBars: number,
  activeFeatures: FeatureName[],
): { correct: boolean }[] {
  const trades: { correct: boolean }[] = [];
  const warmup = Math.max(config.emaSlow, config.bbPeriod, config.macdSlow, config.rsiPeriod, config.atrPeriod) + 5;
  if (candles.length <= warmup + expiryBars + 5) return trades;

  // BUGFIX (аудит 2026-09-05): раньше этот цикл не хранил историю уже
  // выданных сигналов — тот же дубль-баг, что был в живом DecisionEngine
  // (см. decision/engine.ts), только здесь ещё и искажал результаты
  // бэктеста: стратегия, которая на практике штампует сигналы в одну и ту
  // же зону, выглядела в бэктесте "прибыльнее", чем есть на самом деле,
  // потому что каждая свеча оценивалась независимо от предыдущих сигналов.
  const tfSeconds = TIMEFRAME_SECONDS[timeframe];
  let recentSignals: RecentSignalRecord[] = [];

  for (let i = warmup; i < candles.length - expiryBars - 1; i++) {
    const slice = candles.slice(0, i + 1);
    const { snapshot } = buildFullSnapshot(slice, config, activeFeatures);
    const signal = buildSignal({
      symbolId,
      timeframe,
      candles: slice,
      config,
      activeFeatures,
      snapshot,
      calibration: null,
      tick: null,
      barsToResolve: 5,
    });
    if (!signal) continue;

    const candleTime = slice[slice.length - 1].time;
    recentSignals = pruneResolvedSignals(recentSignals, candleTime);
    const suppressed = isSuppressedByCooldown({
      recent: recentSignals,
      direction: signal.direction,
      entryPrice: signal.entryPrice,
      candleTime,
      atrValue: signal.indicators.atr,
    });
    if (suppressed) continue;
    recentSignals.push({
      direction: signal.direction,
      entryPrice: signal.entryPrice,
      candleTime,
      resolvesAtTime: candleTime + expiryBars * tfSeconds,
    });

    // BUGFIX (тот же третий баг из Фазы 0, что и в tick-store/outcomes.ts и
    // backtest/simulator.ts): цена резолва — цена ЗАКРЫТИЯ ровно
    // expiryBars-й свечи после сигнала (candles[i+expiryBars]), не
    // произвольного окна i+1..i+6 с проверкой касания SL/TP на каждой
    // свече внутри него, как было раньше.
    const expiryIndex = i + expiryBars;
    const closePrice = candles[expiryIndex].close;
    const isLong = signal.direction === 'buy';
    const correct = isLong ? closePrice > signal.entryPrice : closePrice < signal.entryPrice;
    trades.push({ correct });
  }
  return trades;
}

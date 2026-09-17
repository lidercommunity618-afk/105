import type {
  Candle,
  Signal,
  SignalOutcome,
  Timeframe,
  IndicatorConfig,
  FeatureName,
} from '@/types/domain';
import { runEngine } from '@/engine/analysisEngine';
import { resolveOutcome } from '@/decision/outcome-scheduler';
import { estimateSpread } from '@/decision/spread-estimate';
import { applySpreadToOutcome } from '@/decision/apply-spread';
import { TIMEFRAME_SECONDS } from '@/data/symbols';
import { isSuppressedByCooldown, pruneResolvedSignals, type RecentSignalRecord } from '@/decision/signal-cooldown';
import { nextLossStreak, requiresStrongOnlyForLossStreak } from '@/decision/loss-streak-guard';

export interface SimulatedTrade {
  signal: Signal;
  outcome: SignalOutcome;
  // Фаза 3 ("экономика выплаты и accuracy направления"): исход ДО
  // applySpreadToOutcome() — чистый знак цены на expiryBars vs entryPrice,
  // без поправки на спред и без всякой связи с profitPercent/payout.
  // `outcome` выше — это то, что реально увидел бы пользователь на демо-
  // счёте (после спред-поправки, downgrade близких к спреду win → timeout);
  // `rawOutcome` — вход для Фазы 2 (метрика "точность направления паттерна"
  // в pattern-audit-checklist.md), которая намеренно не зависит ни от
  // спреда, ни от выплаты — см. metrics.ts::computeMetrics.directionAccuracy.
  rawOutcome: SignalOutcome;
  entryTime: number;
  candleIndex: number;
  spreadCostR: number;
  inSample: boolean;
}

export interface SimulatorOptions {
  symbol: string;
  timeframe: Timeframe;
  indicatorConfig: IndicatorConfig;
  activeFeatures: FeatureName[];
  barsToResolve: number;
  windowSize: number;
  inSampleRatio: number;
  // АУДИТ 2026-09-13 ("не допустить 3 убыточные сделки подряд"): опционально
  // эмулирует в бэктесте тот же предохранитель, что и живой DecisionEngine
  // (см. decision/loss-streak-guard.ts, DecisionEngine.lossStreakGuardEnabled
  // — там включён по умолчанию). Здесь, наоборот, по умолчанию ВЫКЛЮЧЕН
  // (undefined/false): существующие прогоны бэктеста и backtest.test.ts не
  // должны менять результат, пока это явно не запрошено — включайте, чтобы
  // сравнить metrics.maxConsecutiveLosses/winRate до и после.
  lossStreakGuardEnabled?: boolean;
}

export function simulate(candles: Candle[], options: SimulatorOptions): SimulatedTrade[] {
  const trades: SimulatedTrade[] = [];
  const tfSeconds = TIMEFRAME_SECONDS[options.timeframe];

  const warmup =
    Math.max(
      options.indicatorConfig.emaSlow,
      options.indicatorConfig.bbPeriod,
      options.indicatorConfig.macdSlow,
      options.indicatorConfig.rsiPeriod,
      options.indicatorConfig.atrPeriod,
    ) + 5;

  const minStart = Math.max(warmup, options.windowSize);
  const splitIndex = Math.floor((candles.length - minStart) * options.inSampleRatio) + minStart;

  // BUGFIX (аудит 2026-09-05): без истории уже выданных сигналов бэктест
  // молча "усредняется" в ту же зону так же, как это делал живой движок в
  // реальном инциденте (3 BUY подряд за 2 минуты почти на одной цене) — это
  // завышает число сделок и искажает winrate/статистику relative к тому,
  // что видел бы реальный пользователь после фикса в decision/engine.ts.
  let recentSignals: RecentSignalRecord[] = [];
  // Тот же, независимый от cooldown/chop-guard предохранитель, что и в
  // живом движке — см. lossStreakGuardEnabled выше. Хронологический,
  // т.к. цикл ниже уже идёт по возрастающему i (последовательные закрытые
  // свечи), в том же порядке, в каком уже накапливается recentSignals.
  let lossStreak = 0;

  for (let i = minStart; i < candles.length - options.barsToResolve; i++) {
    const window = candles.slice(i - options.windowSize + 1, i + 1);
    const lastCandle = candles[i];
    const serverNowMs = (lastCandle.time + tfSeconds) * 1000;

    const { signal } = runEngine({
      symbolId: options.symbol,
      timeframe: options.timeframe,
      candles: window,
      config: options.indicatorConfig,
      activeFeatures: options.activeFeatures,
      calibration: null,
      tick: null,
      barsToResolve: options.barsToResolve,
    });

    if (!signal) continue;

    if (
      options.lossStreakGuardEnabled &&
      requiresStrongOnlyForLossStreak(lossStreak) &&
      signal.strength !== 'strong'
    ) {
      continue;
    }

    recentSignals = pruneResolvedSignals(recentSignals, lastCandle.time);
    const suppressed = isSuppressedByCooldown({
      recent: recentSignals,
      direction: signal.direction,
      entryPrice: signal.entryPrice,
      candleTime: lastCandle.time,
      atrValue: signal.indicators.atr,
    });
    if (suppressed) continue;
    recentSignals.push({
      direction: signal.direction,
      entryPrice: signal.entryPrice,
      candleTime: lastCandle.time,
      resolvesAtTime: lastCandle.time + signal.barsToResolve * tfSeconds,
    });

    const deterministicSignal: Signal = {
      ...signal,
      id: `${options.symbol}:${options.timeframe}:${i}`,
    };

    const futureCandles = candles.slice(i + 1, i + 1 + options.barsToResolve);
    const resolved = resolveOutcome(deterministicSignal, futureCandles);
    if (!resolved) continue;

    const { spread } = estimateSpread(options.symbol, null);
    // BUGFIX (тот же третий баг из Фазы 0, что и в tick-store/outcomes.ts):
    // раньше здесь было захардкожено futureCandles[0] (ровно 1 бар)
    // независимо от signal.expiryBars, которым уже резолвится сам исход
    // (resolveOutcome выше) — цена для спред-поправки должна быть ценой
    // ТОЙ ЖЕ свечи. resolveOutcome() гарантирует futureCandles.length >=
    // expiryBars, когда он вернул non-null.
    const expiryBars = deterministicSignal.expiryBars ?? 1;
    const adjusted = applySpreadToOutcome(resolved.outcome, deterministicSignal, spread, futureCandles[expiryBars - 1].close);

    // См. lossStreakGuardEnabled выше — обновляется независимо от того,
    // включён ли гейт в этом прогоне, чтобы значение metrics.
    // maxConsecutiveLosses не зависело от того, что options содержит
    // (гейт и метрика — два разных, независимо включаемых потребителя
    // одной и той же серии). 'timeout' пропускается — та же конвенция,
    // что и в metrics.ts/decision/loss-streak-guard.ts.
    if (adjusted.outcome === 'win' || adjusted.outcome === 'loss') {
      lossStreak = nextLossStreak(lossStreak, adjusted.outcome);
    }

    trades.push({
      signal: deterministicSignal,
      outcome: adjusted.outcome,
      rawOutcome: resolved.outcome,
      entryTime: lastCandle.time,
      candleIndex: i,
      spreadCostR: adjusted.spreadCostR,
      inSample: i < splitIndex,
    });
  }

  return trades;
}

export function splitTrades(trades: SimulatedTrade[]): {
  inSample: SimulatedTrade[];
  outOfSample: SimulatedTrade[];
} {
  return {
    inSample: trades.filter((t) => t.inSample),
    outOfSample: trades.filter((t) => !t.inSample),
  };
}

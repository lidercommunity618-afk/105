import type {
  Candle,
  IndicatorConfig,
  PatternName,
  Signal,
  SignalOutcome,
  Snapshot,
  Timeframe,
  FeatureName,
  Tick,
  SignalComponentToggles,
} from '@/types/domain';
import { DEFAULT_SIGNAL_TOGGLES, DEFAULT_INDICATOR_CONFIG } from '@/types/domain';
import type { CalibrationModel } from './calibration-model';
import { workerClient } from '@/compute/WorkerClient';
import {
  buildSignal,
  STRONG_SIGNAL_SCORE_THRESHOLD,
  type BuildSignalParams,
} from './signal-builder';
import { addBreadcrumb } from '@/lib/sentry';
import { TIMEFRAME_SECONDS } from '@/data/symbols';
import { PRE_CLOSE_SIGNAL_LEAD_MS } from '@/lib/constants';
import { isSuppressedByCooldown, pruneResolvedSignals, isSuppressedByChopGuard, isSuppressedBySameDirectionSerial, pruneChopGuardHistory, type RecentSignalRecord } from './signal-cooldown';
import { requiresStrongOnlyForLossStreak } from './loss-streak-guard';

const DEFAULT_BARS_TO_RESOLVE = 5;
const FROZEN_SIGNAL_MAX_AGE_MS = 60_000;

// Audit finding D1 ("Реакция на снятие ликвидности"): patterns whose entry
// conditions are hard geometric checks on the LAST candle's exact OHLC
// (displacement body/range ratio, breakout margin, rejection wicks...) can
// flip from valid to invalid in the last few seconds before a candle closes
// — a partial wick retrace on M1 is common, especially around institutional
// activity. The pre-close freeze mechanism below exists to cut UI/
// notification latency, which is a reasonable trade-off for most patterns,
// but for these three specifically a signal frozen at "close - 5s" can be
// handed out as final even though the bar's ACTUAL close no longer satisfies
// the pattern's own geometry. These are revalidated against the closed bar
// instead of trusting the frozen pre-close value — every other pattern
// keeps the existing fast path unchanged.
export const HARD_GEOMETRY_PATTERNS = new Set<PatternName>([
  'liquidity-sweep-reaction',
  'impulse-breakout',
  'consolidation-breakout',
]);

// Extracted as a pure, directly-unit-testable function rather than left
// inline in evaluate() — self-audit (2026-09-11) found that an integration
// test asserting "strongSignalsOnly never LOWERS a stricter user
// scoreThreshold" was a false-positive risk: with this codebase's real
// scoring fixtures, both the correct Math.max behaviour and a hypothetical
// bug (e.g. always overriding to STRONG_SIGNAL_SCORE_THRESHOLD regardless of
// the user's own, stricter setting) would have produced the SAME observable
// outcome (null), because the fixture score happened to sit below both
// candidate thresholds. Testing this pure function directly with plain
// numbers removes that ambiguity — see engine.test.ts.
export function computeEffectiveScoreThreshold(scoreThreshold: number, strongSignalsOnly: boolean): number {
  return strongSignalsOnly ? Math.max(scoreThreshold, STRONG_SIGNAL_SCORE_THRESHOLD) : scoreThreshold;
}

export interface OutcomeRecord {
  signalId: string;
  outcome: SignalOutcome;
  features: number[];
  score: number;
}

export interface DecisionEngineOptions {
  calibration: CalibrationModel | null;
  barsToResolve: number;
  scoreThreshold?: number;
  signalToggles?: SignalComponentToggles;
  priorityThreshold?: number;
  // "Система мартингейла" в настройках (см. useDemoAccountStore.martingaleEnabled
  // / SettingsPanel.tsx). Когда true — движок обязан пропускать только
  // "сильные" сигналы (strength === 'strong'), т.к. включённый мартингейл
  // повышает ставку после каждого убытка (стадии 1-3), и торговать в этом
  // режиме на "средних"/"слабых" сигналах системно опаснее для депозита.
  strongSignalsOnly?: boolean;
  // АУДИТ 2026-09-13 ("не допустить 3 убыточные сделки подряд"): независимый
  // от strongSignalsOnly предохранитель — см. decision/loss-streak-guard.ts.
  // После LOSS_STREAK_GATE_THRESHOLD подряд идущих РЕАЛЬНЫХ убытков на
  // демо-счёте временно поднимает требование до 'strong', пока серию не
  // прервёт выигрыш. В отличие от strongSignalsOnly это не пользовательский
  // тумблер в Настройках, а автоматическая защита — по умолчанию включена
  // (true), не требует явного включения. Сам движок не резолвит сделки и не
  // знает реальный P&L: актуальное значение серии приходит извне через
  // setLossStreak() — см. useTickStore.ts (подписка lossStreakUnsub,
  // зеркалирующая useDemoAccountStore.currentLossStreak) — это единственный
  // источник истины для серии, аналогично тому, как ensureEngine() уже
  // читает useDemoAccountStore.martingaleEnabled для strongSignalsOnly.
  lossStreakGuardEnabled?: boolean;
}

export class DecisionEngine {
  private calibration: CalibrationModel | null;
  private barsToResolve: number;
  private scoreThreshold: number;
  private signalToggles: SignalComponentToggles;
  private priorityThreshold: number | null;
  private strongSignalsOnly: boolean;
  private lossStreakGuardEnabled: boolean;
  // Счётчик РЕАЛЬНЫХ, подряд идущих убыточных демо-сделок — устанавливается
  // ИЗВНЕ через setLossStreak() (см. lossStreakGuardEnabled выше), а не
  // инкрементируется здесь самим движком: движок не видит фактический P&L,
  // только useDemoAccountStore это делает.
  private currentLossStreak = 0;
  private frozenSignal: Signal | null = null;
  private frozenCandleTime: number | null = null;
  private currentSignal: Signal | null = null;
  private currentSnapshot: Snapshot | null = null;
  // BUGFIX (аудит 2026-09-05): раньше между вызовами evaluate() не хранилось
  // никакой истории уже выданных сигналов — движок мог штамповать сигналы в
  // одном направлении в одну и ту же ценовую зону, пока предыдущий ещё не
  // резолвился (реальный кейс: 3 BUY подряд за 2 минуты в пределах ATR друг
  // от друга на BTCUSDT M1). См. signal-cooldown.ts.
  private recentSignals: RecentSignalRecord[] = [];
  // BUGFIX (аудит 2026-09-06, п.5): отдельная история для chop-guard — в
  // отличие от recentSignals, из неё НЕ удаляются записи по факту резолва;
  // она хранит сигналы ровно CHOP_GUARD_WINDOW_SECONDS по времени, независимо
  // от их исхода, потому что "пила" на границах диапазона — это про то, что
  // происходило в зоне за последние N минут, а не про то, что ещё не
  // резолвилось. См. signal-cooldown.ts.
  private chopGuardHistory: RecentSignalRecord[] = [];
  // Monotonic counter, incremented on every evaluate() call that reaches the
  // worker. candleTime alone can't distinguish two in-flight requests for the
  // *same* candle (e.g. two maybeTriggerPreClose ticks on the same candleTime,
  // with a tick/snapshot update in between) — worker promises aren't
  // guaranteed to resolve in issue order, so without a per-call sequence
  // number a newer request's response could be overwritten by an older one
  // that happens to resolve later. requestSeq is compared instead of (not
  // just alongside) candleTime, so it also covers the different-candle case.
  private requestSeq = 0;

  constructor(opts: DecisionEngineOptions) {
    this.calibration = opts.calibration;
    this.barsToResolve = opts.barsToResolve > 0 ? opts.barsToResolve : DEFAULT_BARS_TO_RESOLVE;
    this.scoreThreshold = opts.scoreThreshold ?? DEFAULT_INDICATOR_CONFIG.scoreThreshold;
    this.signalToggles = opts.signalToggles ?? DEFAULT_SIGNAL_TOGGLES;
    this.priorityThreshold = opts.priorityThreshold ?? null;
    this.strongSignalsOnly = opts.strongSignalsOnly ?? false;
    this.lossStreakGuardEnabled = opts.lossStreakGuardEnabled ?? true;
  }

  snapshot(candleTime: number, serverNowMs: number, timeframeSeconds: number): { isFrozen: boolean; shouldFreeze: boolean } {
    const closeTimeMs = (candleTime + timeframeSeconds) * 1000;
    const msUntilClose = closeTimeMs - serverNowMs;
    const shouldFreeze = msUntilClose <= PRE_CLOSE_SIGNAL_LEAD_MS && msUntilClose > -PRE_CLOSE_SIGNAL_LEAD_MS;
    return { isFrozen: this.frozenSignal !== null, shouldFreeze };
  }

  async evaluate(
    symbolId: string,
    timeframe: Timeframe,
    candles: Candle[],
    config: IndicatorConfig,
    activeFeatures: FeatureName[],
    tick: Tick | null,
    serverNowMs: number,
    isClosed: boolean = true,
  ): Promise<Signal | null> {
    if (candles.length === 0) return null;
    // См. комментарий к идентичной проверке в signal-builder.ts:
    // buildSignal() — meanReversion исключён из OR-цепочки: этот тумблер не
    // связан ни с одним ненулевым компонентом score (реальная стратегия
    // живёт в паттерне 'mean-reversion'), поэтому конфигурация «включён
    // только meanReversion» должна давать hasEnabledSource=false, а не
    // молчаливый вечный null-сигнал.
    const hasEnabledSource = this.signalToggles.structure || this.signalToggles.zones || this.signalToggles.liquidity || this.signalToggles.trigger || this.signalToggles.indicator || this.signalToggles.bos || this.signalToggles.macd;
    if (!hasEnabledSource) {
      this.currentSignal = null;
      this.frozenSignal = null;
      this.frozenCandleTime = null;
      return null;
    }
    const lastCandle = candles[candles.length - 1];
    const tfSeconds = TIMEFRAME_SECONDS[timeframe];
    const { shouldFreeze } = this.snapshot(lastCandle.time, serverNowMs, tfSeconds);

    const frozenForThisCandle =
      this.frozenSignal && this.frozenCandleTime === lastCandle.time ? this.frozenSignal : null;

    // Composed "must be strong" requirement: either the user's own
    // "Система мартингейла" toggle (strongSignalsOnly) OR the automatic
    // loss-streak guard (см. decision/loss-streak-guard.ts) — either one
    // alone is enough to raise the bar to 'strong' only. Computed once per
    // evaluate() call and reused everywhere strongSignalsOnly used to be
    // checked directly (frozen-signal fast path, effective score
    // threshold, defense-in-depth check below), so none of those three
    // places can ever disagree about which requirement is currently
    // active.
    const requireStrong =
      this.strongSignalsOnly ||
      (this.lossStreakGuardEnabled && requiresStrongOnlyForLossStreak(this.currentLossStreak));

    // BUGFIX (self-audit strongSignalsOnly, 2026-09-11): a signal frozen
    // WHILE requireStrong was false (or before it became true) can be
    // 'moderate'/'weak'. Without this check, the synchronous fast path a
    // few lines below would keep serving that stale non-strong frozen
    // signal for up to FROZEN_SIGNAL_MAX_AGE_MS (60s) after the requirement
    // turns on (user enables "Система мартингейла", or the loss-streak
    // guard activates after a real loss) — completely bypassing both the
    // effectiveScoreThreshold gate AND the defense-in-depth strength check
    // further down, because neither of those runs on this early-return
    // path. A frozen signal is only safe to serve as-is when either
    // requireStrong is currently false, or the frozen signal already is
    // 'strong' (in which case the requirement is already satisfied).
    const frozenSatisfiesStrongOnly =
      !requireStrong || frozenForThisCandle === null || frozenForThisCandle.strength === 'strong';
    if (frozenForThisCandle && !frozenSatisfiesStrongOnly) {
      // Invalidate rather than silently fall through with stale state: the
      // full recompute below will freeze a fresh (correctly gated) result
      // if shouldFreeze still applies.
      this.frozenSignal = null;
      this.frozenCandleTime = null;
    }

    // See HARD_GEOMETRY_PATTERNS above: the actual candle-close call
    // (isClosed === true) for one of these patterns must always recompute
    // against the closed bar rather than short-circuiting on the frozen
    // pre-close value — everything else keeps the fast path below.
    const requiresCloseRevalidation =
      isClosed &&
      frozenForThisCandle !== null &&
      frozenForThisCandle.pattern !== null &&
      HARD_GEOMETRY_PATTERNS.has(frozenForThisCandle.pattern);

    // Fast path: this MUST resolve synchronously, before we ever go to the
    // worker, so a valid frozen signal keeps being returned immediately on
    // every call (up to 5x/sec via maybeTriggerPreClose) instead of paying
    // worker round-trip latency for a result we already have.
    if (frozenForThisCandle && !requiresCloseRevalidation && frozenSatisfiesStrongOnly) {
      const age = serverNowMs - (frozenForThisCandle.frozenAt ?? 0);
      if (age > FROZEN_SIGNAL_MAX_AGE_MS) {
        this.frozenSignal = null;
        this.frozenCandleTime = null;
      } else {
        return frozenForThisCandle;
      }
    }

    const requestSeq = ++this.requestSeq;

    const { snapshot, series } = await workerClient.snapshotRequest(
      symbolId,
      timeframe,
      candles,
      config,
      activeFeatures,
      isClosed,
    );
    void series;

    // Race condition guard: if a newer evaluate() call was issued while we
    // were awaiting the worker, requestSeq will have moved on — this
    // response is stale, so it must not overwrite currentSignal/currentSnapshot
    // (or frozenSignal) with outdated data. Just drop it; the newer in-flight
    // call will produce the up-to-date result.
    //
    // Comparing requestSeq (not just candleTime) also covers two in-flight
    // requests for the *same* candleTime: worker promises aren't guaranteed
    // to resolve in issue order, so if an older same-candle request resolves
    // after a newer one, requestSeq (unlike candleTime) still tells them
    // apart and the older response is dropped instead of overwriting the
    // newer result.
    if (this.requestSeq !== requestSeq) {
      return null;
    }

    // requireStrong (strongSignalsOnly ИЛИ активный loss-streak guard):
    // поднимаем ЭФФЕКТИВНЫЙ scoreThreshold до порога "сильного" сигнала (см.
    // STRONG_SIGNAL_SCORE_THRESHOLD в signal-builder.ts), не трогая при
    // этом сохранённый this.scoreThreshold — пользовательский слайдер
    // "Порог score сигнала" в SettingsPanel.tsx должен остаться как есть и
    // снова начать работать в исходном виде, как только оба требования
    // снимутся (см. Math.max внутри computeEffectiveScoreThreshold: если
    // пользователь уже выставил порог строже 4, ни одно из требований его
    // не ослабляет — только ужесточает при необходимости, никогда не
    // понижает).
    const effectiveScoreThreshold = computeEffectiveScoreThreshold(this.scoreThreshold, requireStrong);

    const signal = buildSignal({
      symbolId,
      timeframe,
      candles,
      config,
      activeFeatures,
      snapshot,
      calibration: this.calibration,
      tick,
      barsToResolve: this.barsToResolve,
      scoreThreshold: effectiveScoreThreshold,
      signalToggles: this.signalToggles,
      priorityThreshold: this.priorityThreshold ?? undefined,
    } satisfies BuildSignalParams);

    // BUGFIX (аудит 2026-09-05): подавляем сигнал, если это тот же
    // direction в той же (в пределах ATR) ценовой зоне, что и недавний ещё
    // не резолвленный сигнал — иначе движок "усредняется" в уже
    // проигрывающую зону вместо того, чтобы дождаться исхода. Резолв в
    // recentSignals фиксируется один раз за бар в onCandleClosed(), поэтому
    // многократные вызовы evaluate() внутри одного бара (freeze-цикл) сюда
    // не попадают лишний раз.
    let finalSignal = signal;

    // Defense-in-depth для requireStrong: порог score выше уже не должен
    // пропускать ничего слабее 'strong' (strengthFor и effectiveScoreThreshold
    // используют один и тот же STRONG_SIGNAL_SCORE_THRESHOLD), но эта явная
    // проверка по итоговому полю strength — а не по сырому score — не
    // зависит от того, останется ли это соответствие верным при будущих
    // изменениях buildSignal (например, если score станет пересчитываться
    // после гейта по какой-то калибровочной поправке). Один лишний if
    // здесь стоит дёшево и гарантирует инвариант "requireStrong ⇒ наружу
    // не уйдёт ничего, кроме 'strong'" независимо от деталей
    // scoreThreshold-математики выше — для ОБОИХ источников requireStrong
    // (мартингейл и loss-streak guard), не только для мартингейла.
    if (finalSignal && requireStrong && finalSignal.strength !== 'strong') {
      addBreadcrumb('Signal suppressed: strong-only requirement active (martingale mode and/or loss-streak guard), strength below "strong"', {
        direction: finalSignal.direction,
        strength: finalSignal.strength,
        symbolId,
      });
      finalSignal = null;
    }

    if (finalSignal) {
      this.recentSignals = pruneResolvedSignals(this.recentSignals, lastCandle.time);
      const suppressed = isSuppressedByCooldown({
        recent: this.recentSignals,
        direction: finalSignal.direction,
        entryPrice: finalSignal.entryPrice,
        candleTime: lastCandle.time,
        atrValue: finalSignal.indicators.atr,
      });
      this.chopGuardHistory = pruneChopGuardHistory(this.chopGuardHistory, lastCandle.time);
      const chopped = isSuppressedByChopGuard({
        history: this.chopGuardHistory,
        direction: finalSignal.direction,
        entryPrice: finalSignal.entryPrice,
        candleTime: lastCandle.time,
        atrValue: finalSignal.indicators.atr,
      });
      // BUGFIX (аудит, "серийный" гейт): та же не-завязанная-на-резолв
      // история, что и chop-guard, но ловит серию сигналов ОДНОГО
      // направления в одной зоне (chop-guard требует >=2 разных
      // направлений и не срабатывает на этот паттерн — см.
      // signal-cooldown.ts::isSuppressedBySameDirectionSerial).
      const serialRepeat = isSuppressedBySameDirectionSerial({
        history: this.chopGuardHistory,
        direction: finalSignal.direction,
        entryPrice: finalSignal.entryPrice,
        candleTime: lastCandle.time,
        atrValue: finalSignal.indicators.atr,
      });
      if (suppressed || chopped || serialRepeat) {
        addBreadcrumb(
          chopped
            ? 'Signal suppressed by chop-guard: 2+ opposing-direction signals in this zone recently'
            : serialRepeat
              ? 'Signal suppressed by serial-direction guard: repeated same-direction signals in this zone without a structure change'
              : 'Signal suppressed by cooldown: same direction/zone as unresolved recent signal',
          {
            direction: finalSignal.direction,
            entryPrice: finalSignal.entryPrice,
            symbolId,
          },
        );
        finalSignal = null;
      }
    }

    this.currentSignal = finalSignal;
    this.currentSnapshot = snapshot;

    if (requiresCloseRevalidation) {
      // Authoritative close-time result for a hard-geometry pattern: replace
      // whatever was frozen pre-close outright, including invalidating it
      // (signal === null) if the pattern's own geometric conditions no
      // longer hold on the bar's actual close — see HARD_GEOMETRY_PATTERNS.
      this.frozenSignal = finalSignal ? { ...finalSignal, frozenAt: serverNowMs } : null;
      this.frozenCandleTime = finalSignal ? lastCandle.time : null;
      return finalSignal;
    }

    if (shouldFreeze && finalSignal) {
      this.frozenSignal = { ...finalSignal, frozenAt: serverNowMs };
      this.frozenCandleTime = lastCandle.time;
      return this.frozenSignal;
    }

    return finalSignal;
  }

  onCandleClosed(): Signal | null {
    const sig = this.frozenSignal ?? this.currentSignal;
    this.frozenSignal = null;
    this.frozenCandleTime = null;
    if (sig) {
      // Коммитим сигнал в историю кулдауна ровно один раз за бар — это
      // единственное место, где сигнал становится "выданным" для этого
      // бара (см. signal-cooldown.ts и комментарий в evaluate()).
      const tfSeconds = TIMEFRAME_SECONDS[sig.timeframe];
      this.recentSignals = pruneResolvedSignals(this.recentSignals, sig.time);
      this.recentSignals.push({
        direction: sig.direction,
        entryPrice: sig.entryPrice,
        candleTime: sig.time,
        resolvesAtTime: sig.time + sig.barsToResolve * tfSeconds,
      });
      // Chop-guard history (см. п.5): не завязана на резолв, только на
      // временное окно — та же самая запись, но в отдельном массиве,
      // который pruneResolvedSignals не трогает.
      this.chopGuardHistory = pruneChopGuardHistory(this.chopGuardHistory, sig.time);
      this.chopGuardHistory.push({
        direction: sig.direction,
        entryPrice: sig.entryPrice,
        candleTime: sig.time,
        resolvesAtTime: sig.time + sig.barsToResolve * tfSeconds,
      });
    }
    return sig;
  }

  // Этап 1 аудита ("КАЛИБРОВКА"/"АНАЛИТИКА ПО ФАКТОРАМ", п.5): позволяет
  // useTickStore.ts подменить калибровочную модель на модель другого
  // инструмента при переключении symbolId, не пересоздавая сам движок
  // (recentSignals/chopGuardHistory/frozenSignal — состояние сессии текущего
  // символа — намеренно не трогаются здесь, это отдельная забота).
  setCalibration(calibration: CalibrationModel | null): void {
    this.calibration = calibration;
  }

  // Аудит-ревью Этапа 1 (нюанс QA): раньше recordOutcome() всегда писал
  // сэмпл в this.calibration — модель ТЕКУЩЕГО активного символа на момент
  // вызова (последний setCalibration()), а не обязательно в модель именно
  // signal.symbolId. На практике это совпадает благодаря тому, что
  // useTickStore.start() при смене инструмента дренирует и заново засеивает
  // outcomeScheduler только сигналами нового символа — но это ПОБОЧНЫЙ
  // эффект другого модуля, а не гарантия, проверяемая здесь. Явный
  // необязательный третий параметр делает корректность самодостаточной:
  // вызывающий код (outcomes.ts) теперь передаёт модель, найденную по
  // signal.symbolId, напрямую — это единственный источник истины для
  // обучения, а не совпадение с this.calibration. Параметр необязателен
  // (по умолчанию — прежний this.calibration) исключительно ради обратной
  // совместимости существующих тестов/вызовов, которые не подменяют
  // инструмент внутри одного вызова.
  recordOutcome(
    signal: Signal,
    outcome: SignalOutcome,
    calibrationModel: CalibrationModel | null = this.calibration,
  ): OutcomeRecord | null {
    if (outcome === 'pending') return null;
    if (!calibrationModel) return null;

    // Этап 1 аудита, п.5: timeout — это "не дождались решения", а не
    // проигрыш. Раньше он кодировался как outcome=0 (loss) в обучающей
    // выборке логрегрессии, хотя в winRate (useAnalyticsStore.recomputeStats)
    // timeout корректно исключается из знаменателя — модель училась на
    // разметке, отличной от той, что видит пользователь в статистике.
    // Полностью исключаем timeout из тренировочных сэмплов, как и из
    // winRate, вместо того чтобы трактовать его как поражение.
    if (outcome === 'timeout') {
      addBreadcrumb('Calibration sample skipped: timeout excluded from training (not a win/loss)', {
        score: signal.score,
      });
      return null;
    }

    const outcomeValue: 1 | 0 = outcome === 'win' ? 1 : 0;
    const sample = {
      features: signal.featureVector,
      score: signal.score,
      outcome: outcomeValue,
    };

    // Only the (cheap) sample bookkeeping happens here. Retraining the
    // logistic regression is comparatively expensive (500-epoch full-batch
    // gradient descent) and is the calling code's responsibility (see
    // useTickStore.ts, triggerRetrain — it offloads to the worker via
    // workerClient.retrainCalibration()). recordOutcome() itself stays a
    // plain synchronous method that doesn't await anything.
    calibrationModel.addSample(sample);
    addBreadcrumb(`Calibration sample added: ${calibrationModel.getSampleCount()} samples`, {
      outcome,
      score: signal.score,
    });

    return {
      signalId: signal.id,
      outcome,
      features: signal.featureVector,
      score: signal.score,
    };
  }

  getFrozenSignal(): Signal | null {
    return this.frozenSignal;
  }

  shouldEmitPreClose(serverNowMs: number, candleTime: number, timeframeSeconds: number): boolean {
    const closeTimeMs = (candleTime + timeframeSeconds) * 1000;
    const msUntilClose = closeTimeMs - serverNowMs;
    return msUntilClose <= PRE_CLOSE_SIGNAL_LEAD_MS && msUntilClose > 0;
  }

  getLastSnapshot(): Snapshot | null {
    return this.currentSnapshot;
  }

  setScoreThreshold(threshold: number): void {
    this.scoreThreshold = threshold;
  }

  setSignalToggles(toggles: SignalComponentToggles): void {
    this.signalToggles = toggles;
  }

  setPriorityThreshold(threshold: number): void {
    this.priorityThreshold = threshold;
  }

  setStrongSignalsOnly(enabled: boolean): void {
    this.strongSignalsOnly = enabled;
  }

  setLossStreakGuardEnabled(enabled: boolean): void {
    this.lossStreakGuardEnabled = enabled;
  }

  // Устанавливается извне (useTickStore.ts, зеркалируя
  // useDemoAccountStore.currentLossStreak) — счётчик РЕАЛЬНЫХ, подряд
  // идущих убыточных демо-сделок. Движок сам не резолвит сделки и не
  // считает P&L, поэтому это простой setter, а не внутренний инкремент, в
  // отличие от recentSignals/chopGuardHistory выше (которые движок и
  // заполняет, и читает сам). Защищено от отрицательных/некорректных
  // значений — некорректный вход не должен ложно взводить гейт.
  setLossStreak(streak: number): void {
    this.currentLossStreak = Number.isFinite(streak) && streak > 0 ? Math.floor(streak) : 0;
  }

  getCurrentLossStreak(): number {
    return this.currentLossStreak;
  }
}

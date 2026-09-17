import type { Signal } from '@/types/domain';
import type { TickState } from '../useTickStore';
import type { DecisionEngine } from '@/decision/engine';
import type { OutcomeScheduler } from '@/decision/outcome-scheduler';
import { TIMEFRAME_SECONDS } from '@/data/symbols';
import { serverClock } from '@/data/server-clock';
import { captureError } from '@/lib/sentry';
import { useSettingsStore } from '../settingsStore';
import { useAnalyticsStore } from '../useAnalyticsStore';
import { useDemoAccountStore } from '@/stores/useDemoAccountStore';
import { saveSignal } from '@/lib/signal-persistence';
import { PRE_CLOSE_SIGNAL_LEAD_MS } from '@/lib/constants';
import { getActiveFeatures, notifySignal } from './shared';

// Модульное состояние pre-close владения перенесено сюда целиком (было в
// useTickStore.ts). Наружу отдаётся только через явные функции ниже —
// useTickStore.ts (handleCandle/maybeEvaluateSignal/stop) больше не трогает
// эти переменные напрямую, а вызывает getPreCloseTriggeredCandleTime /
// resetPreCloseTriggeredCandleTime / clearPreCloseTimer.
let preCloseTriggeredCandleTime: number | null = null;
let preCloseTimer: ReturnType<typeof setTimeout> | null = null;

export function getPreCloseTriggeredCandleTime(): number | null {
  return preCloseTriggeredCandleTime;
}

export function resetPreCloseTriggeredCandleTime(): void {
  preCloseTriggeredCandleTime = null;
}

export function clearPreCloseTimer(): void {
  if (preCloseTimer) {
    clearTimeout(preCloseTimer);
    preCloseTimer = null;
  }
}

// ensureEngine()/ensureScheduler() остаются модульными синглтонами в
// useTickStore.ts — сюда передаются явными параметрами, чтобы не создавать
// циклический импорт useTickStore.ts <-> tick-store/pre-close.ts.
export interface PreCloseDeps {
  ensureEngine: () => DecisionEngine;
  ensureScheduler: () => OutcomeScheduler;
}

export function schedulePreCloseTimer(
  set: (partial: Partial<TickState>) => void,
  get: () => TickState,
  deps: PreCloseDeps,
): void {
  clearPreCloseTimer();

  const state = get();
  if (state.activeSymbolId === '' || state.candles.length === 0) return;

  const lastCandle = state.candles[state.candles.length - 1];
  const tfSeconds = TIMEFRAME_SECONDS[state.activeTimeframe];
  const closeTimeMs = (lastCandle.time + tfSeconds) * 1000;
  const serverNowMs = serverClock.now();
  const msUntilClose = closeTimeMs - serverNowMs;

  if (msUntilClose <= PRE_CLOSE_SIGNAL_LEAD_MS && msUntilClose > 0) {
    void maybeTriggerPreClose(set, get, deps);
    return;
  }

  if (msUntilClose <= 0) return;

  const delay = msUntilClose - PRE_CLOSE_SIGNAL_LEAD_MS;
  preCloseTimer = setTimeout(() => {
    preCloseTimer = null;
    void maybeTriggerPreClose(set, get, deps);
  }, Math.max(0, delay));
}

export async function maybeTriggerPreClose(
  set: (partial: Partial<TickState>) => void,
  get: () => TickState,
  deps: PreCloseDeps,
): Promise<void> {
  void set;
  const state = get();
  if (state.activeSymbolId === '' || state.candles.length === 0) return;

  const lastCandle = state.candles[state.candles.length - 1];
  const tfSeconds = TIMEFRAME_SECONDS[state.activeTimeframe];
  const serverNowMs = serverClock.now();

  if (!deps.ensureEngine().shouldEmitPreClose(serverNowMs, lastCandle.time, tfSeconds)) return;
  if (state.candleLifecycle !== 'live') return;
  if (preCloseTriggeredCandleTime === lastCandle.time) return;

  preCloseTriggeredCandleTime = lastCandle.time;

  const settings = useSettingsStore.getState();
  const features = getActiveFeatures(settings);
  const eng = deps.ensureEngine();

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
      false,
    );
  } catch (err) {
    captureError(err, { context: 'engine.evaluate.preClose' });
    return;
  }

  // Тот же гвард от протухшего асинхронного ответа, что и в
  // useTickStore.ts (maybeEvaluateSignal/maybeConsiderRevision): eng.evaluate()
  // выше может резолвиться уже после того, как пользователь переключил
  // символ/таймфрейм (или сработал resetSession()+reseed scheduler'а на
  // смене символа, см. useTickStore.start()) — без проверки ниже сигнал по
  // СТАРОМУ символу мог всё равно попасть в analytics (setCurrentSignal/
  // upsertSignal) и в OutcomeScheduler для уже неактуального eng/scheduler,
  // застревая там без финального исхода.
  if (get().activeSymbolId !== state.activeSymbolId || get().activeTimeframe !== state.activeTimeframe) {
    return;
  }

  if (!signal) return;

  const draftSignal: Signal = { ...signal, isPreClose: true };
  // entryPrice не передаётся: signal.entryPrice — это close ещё формирующейся
  // свечи, а не реальный open следующей. Передача его сюда немедленно зафиксирует
  // неверную цену входа и заблокирует последующую коррекцию через
  // confirmEntryPrice (guard на entryPrice === null не сработает).
  // Реальная цена подтверждается в handleCandle при появлении новой свечи.
  useDemoAccountStore.getState().openTrade(draftSignal);

  // Аудит (синхронизация с демо-счётом): фиксируем на самом сигнале, была
  // ли по нему реально открыта демо-сделка, ДО того как сигнал уйдёт в
  // analytics/scheduler/БД — от этого зависит, кто выставит финальный
  // outcome (см. tick-store/outcomes.ts) и учитывается ли сигнал в
  // винрейте (см. useAnalyticsStore.recomputeStats).
  const tradeOpened = Boolean(useDemoAccountStore.getState().openTrades[draftSignal.id]);
  const preCloseSignal: Signal = { ...draftSignal, tradeOpened };

  const analytics = useAnalyticsStore.getState();
  analytics.setCurrentSignal(preCloseSignal);
  analytics.upsertSignal(preCloseSignal);
  deps.ensureScheduler().schedule(preCloseSignal);
  void saveSignal(preCloseSignal);

  notifySignal(preCloseSignal, settings, set);
}

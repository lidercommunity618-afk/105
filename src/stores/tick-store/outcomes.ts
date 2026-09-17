import type { TickState } from '../useTickStore';
import type { DecisionEngine } from '@/decision/engine';
import type { OutcomeScheduler } from '@/decision/outcome-scheduler';
import type { CalibrationModel } from '@/decision/calibration-model';
import { addBreadcrumb } from '@/lib/sentry';
import { useAnalyticsStore } from '../useAnalyticsStore';
import { updateSignalOutcome, updateSignalChartContext } from '@/lib/signal-persistence';
import { estimateSpread } from '@/decision/spread-estimate';
import { applySpreadToOutcome } from '@/decision/apply-spread';
import { getCandlesAfterSignal } from '@/decision/outcome-scheduler';
import { buildResolvedChartContext } from '@/decision/trade-context';

// ensureEngine()/ensureScheduler() и модульный calibrationModel/triggerRetrain
// остаются в useTickStore.ts — сюда передаются явными параметрами, чтобы не
// создавать циклический импорт useTickStore.ts <-> tick-store/outcomes.ts.
export interface OutcomeDeps {
  ensureEngine: () => DecisionEngine;
  ensureScheduler: () => OutcomeScheduler;
  getCalibrationModel: (symbolId: string) => CalibrationModel | null;
  triggerRetrain: (model: CalibrationModel, symbolId: string) => Promise<void>;
}

export function maybeResolveOutcomes(
  get: () => TickState,
  deps: OutcomeDeps,
): void {
  const state = get();
  const sched = deps.ensureScheduler();
  const eng = deps.ensureEngine();
  const analytics = useAnalyticsStore.getState();

  sched.onCandleClosed(state.candles, (resolved, signal) => {
    // Ценовой контекст (candlesAfter + MFE/MAE) для постмортем-экспорта
    // (см. lib/trade-report.ts) — считается ОДИН раз здесь, независимо от
    // tradeOpened, т.к. onCandleClosed срабатывает для любого резолвящегося
    // сигнала вне зависимости от того, кто ниже считается "источником
    // истины" для самого outcome (см. комментарий про tradeOpened ниже).
    // Полностью ортогонально синхронизации исхода — ничего не решает и не
    // блокирует, только дописывает описательные данные к уже существующей
    // записи сигнала.
    const candlesAfter = getCandlesAfterSignal(state.candles, signal.time);
    const chartContext = buildResolvedChartContext(signal, candlesAfter);
    analytics.updateSignalChartContext(resolved.signalId, chartContext);
    void updateSignalChartContext(resolved.signalId, chartContext);

    // Аудит (синхронизация с демо-счётом): если по этому сигналу была
    // реально открыта демо-сделка (signal.tradeOpened === true),
    // отображаемый пользователю исход — analytics.signals ("ИСТОРИЯ
    // СИГНАЛОВ"), запись в БД и винрейт в StatusBar — выставляет
    // ИСКЛЮЧИТЕЛЬНО useDemoAccountStore синхронно в момент фактического
    // закрытия этой сделки (checkExpiries/resolveFromHistory). Раньше это
    // делалось здесь, на основе отдельной SL/TP-модели resolveOutcome —
    // именно два независимых источника исхода для одного signal.id и были
    // причиной расхождения "Последние сделки" vs "История сигналов".
    // Трогать analytics.updateSignalOutcome здесь для tradeOpened === true
    // нельзя — иначе рассинхронизация вернётся.
    //
    // Если демо-сделка НЕ открывалась (halted-мартингейл, autoTrade
    // выключен, недостаточно баланса, уже есть открытая сделка по
    // инструменту — см. useDemoAccountStore.openTrade), useDemoAccountStore
    // никогда не резолвит этот signal.id — тогда этот блок остаётся
    // единственным источником исхода, чтобы карточка не висела в "pending"
    // вечно. Такие сигналы помечены tradeOpened === false и исключены из
    // винрейта (см. SignalCard.tsx/useAnalyticsStore.recomputeStats).
    if (!signal.tradeOpened) {
      analytics.updateSignalOutcome(resolved.signalId, resolved.outcome);
      void updateSignalOutcome(resolved.signalId, resolved.outcome);
      analytics.recomputeStats();
      // Аудит: непроторгованный сигнал (не было реальной демо-сделки) не
      // должен обучать калибровочную модель — его "исход" здесь считается
      // ТОЛЬКО чтобы карточка не висела в pending вечно (см. комментарий
      // выше), а не потому что по нему реально была прибыль/убыток/тайм-аут
      // на демо-счёте. Раньше recordOutcome/triggerRetrain вызывались для
      // ВСЕХ сигналов без разбора — модель училась на "сделках", которых
      // на самом деле не было, что искажало калибровку.
      return;
    }

    // Калибровочная модель обучается только на сигналах, по которым
    // реально была открыта и закрыта демо-сделка (signal.tradeOpened ===
    // true) — прибыль/убыток/тайм-аут по факту, а не служебный fallback-
    // исход непроторгованного сигнала. Спред-коррекция сравнивается с
    // фактическим движением цены на экспирации, а не с takeProfit (см.
    // apply-spread.ts).
    // BUGFIX (Фаза 0, третье место с тем же хардкодом 1 бара, не описанное
    // в исходном аудите): эта цена идёт в applySpreadToOutcome() как
    // обучающая метка для калибровочной модели (см. ниже) — должна быть
    // ценой закрытия ТОЙ ЖЕ свечи, на которой резолвится сам исход
    // (signal.expiryBars), иначе модель обучается на движении цены за
    // другой горизонт, чем тот, который увидел пользователь.
    const expiryBars = signal.expiryBars ?? 1;
    const expiryClosePrice = candlesAfter[expiryBars - 1]?.close ?? signal.entryPrice;
    const { spread } = estimateSpread(signal.symbolId, null);
    const adjusted = applySpreadToOutcome(resolved.outcome, signal, spread, expiryClosePrice);
    // Аудит-ревью Этапа 1 (нюанс QA): модель ИМЕННО инструмента этого
    // сигнала (signal.symbolId) ищется здесь ОДИН раз и передаётся в
    // recordOutcome() явным третьим аргументом — раньше recordOutcome()
    // молча писал сэмпл в this.calibration движка (модель ТЕКУЩЕГО
    // активного символа), а этот же lookup по signal.symbolId
    // использовался только для triggerRetrain. Совпадение двух моделей
    // держалось на инварианте другого модуля (useTickStore.start()
    // дренирует/засеивает outcomeScheduler только сигналами активного
    // символа при смене инструмента) — теперь это не обязательный
    // побочный эффект, а прямой explicit-параметр: даже если этот
    // инвариант где-то в будущем сломается, сэмпл физически не может
    // попасть не в ту модель.
    const calibrationModel = deps.getCalibrationModel(signal.symbolId);
    const outcomeRecord = eng.recordOutcome(signal, adjusted.outcome, calibrationModel);
    if (outcomeRecord && calibrationModel) {
      addBreadcrumb(`Outcome resolved: ${resolved.outcome} (calibration: ${adjusted.outcome})`, {
        signalId: resolved.signalId,
        samples: calibrationModel.getSampleCount(),
      });
      // Retraining (worker round-trip) and persisting the resulting weights
      // happen asynchronously via triggerRetrain — see its docstring above.
      // recordOutcome() itself already added the sample synchronously.
      void deps.triggerRetrain(calibrationModel, signal.symbolId);
    }
  });
}

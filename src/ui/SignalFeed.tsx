import { Zap, Clock, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { useAnalyticsStore } from '@/stores/useAnalyticsStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { clearOutcomeScheduler } from '@/stores/useTickStore';
import { findSymbol } from '@/data/symbols';
import { SignalCard } from '@/ui/SignalCard';
import { clsx } from '@/lib/utils';
import { deleteAllSignals } from '@/lib/signal-persistence';

export function SignalFeed() {
  const current = useAnalyticsStore((s) => s.currentSignal);
  const signals = useAnalyticsStore((s) => s.signals);
  const clearSignalHistory = useAnalyticsStore((s) => s.clearSignalHistory);
  // Точки входа на графике теперь включаются точечно, кликом по строке
  // истории (см. JSDoc у selectedChartSignalIds в useAnalyticsStore.ts),
  // а не автоматически для всех сигналов сразу.
  const selectedChartSignalIds = useAnalyticsStore((s) => s.selectedChartSignalIds);
  const toggleChartSignal = useAnalyticsStore((s) => s.toggleChartSignal);
  const symbolId = useSettingsStore((s) => s.symbolId);
  const symbol = findSymbol(symbolId);
  const pipSize = symbol?.pipSize ?? 0.01;
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Аудит (ИСТОРИЯ СИГНАЛОВ === Последние сделки): раньше сюда попадал
  // КАЖДЫЙ просчитанный сигнал сразу после генерации (ещё outcome === 'pending'),
  // и отдельно — сигналы, по которым демо-сделка вообще не открывалась
  // (tradeOpened === false), помеченные нейтральным бейджем "Не торговался".
  // Итоговый список выглядел длиннее и "шумнее" реальной истории демо-счёта
  // (useDemoAccountStore.history), и пользователю было неочевидно, что часть
  // строк — это не реальные сделки.
  //
  // Теперь ИСТОРИЯ СИГНАЛОВ показывает ТОЛЬКО то же самое множество, что и
  // демо-счёт: запись появляется исключительно после факта закрытия реальной
  // демо-сделки (tradeOpened === true И outcome !== 'pending'). Сигналы без
  // открытой сделки и ещё не резолвнутые (pending) сюда не попадают вовсе —
  // они по-прежнему учитываются калибровочной моделью (OutcomeScheduler/
  // recordOutcome в tick-store/outcomes.ts работают с ПОЛНЫМ набором сигналов
  // независимо от этого фильтра, см. её комментарий), просто не отображаются
  // пользователю как сделка.
  //
  // tradeOpened === undefined (записи, сохранённые до этого фикса) трактуется
  // как "да" — тем же способом, что и в useAnalyticsStore.recomputeStats()/
  // StatusBar.tsx, чтобы не терять уже накопленную историю задним числом.
  const closedTradedSignals = signals.filter(
    (sig) => sig.id !== current?.id && sig.tradeOpened !== false && sig.outcome !== 'pending',
  );

  return (
    <div className="flex flex-col gap-3">
      {current ? (
        <SignalCard signal={current} pipSize={pipSize} />
      ) : (
        <div className="rounded-xl border border-base-800 bg-base-900 p-4 text-center">
          <Zap size={20} className="mx-auto mb-1 text-base-500" />
          <p className="text-xs text-base-400">Нет активного сигнала</p>
          <p className="mt-0.5 text-2xs text-base-500">Ожидание конfluence индикаторов</p>
        </div>
      )}

      {closedTradedSignals.length > 0 && (
        <div className="rounded-xl border border-base-800 bg-base-900 p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-2xs font-semibold text-base-400">
              <Clock size={12} />
              ИСТОРИЯ СИГНАЛОВ
            </div>
            {confirmDelete ? (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => {
                    // Очищаем локальную историю сразу (мгновенный отклик UI),
                    // и параллельно — всю таблицу trading_signals в БД. Это
                    // два независимых действия: очистка стора не должна
                    // ждать сетевой round-trip, а сбой сети не должен мешать
                    // пользователю увидеть пустую историю немедленно.
                    // Плюс — гасим очередь OutcomeScheduler'а (module-level
                    // синглтон в useTickStore.ts, независимый от этого
                    // стора): иначе уже запланированные сигналы, которые
                    // пользователь только что осознанно удалил, продолжали
                    // бы резолвиться в фоне и обучать калибровочную модель
                    // трейдами, которых с точки зрения пользователя больше
                    // не существует.
                    clearSignalHistory();
                    clearOutcomeScheduler();
                    setConfirmDelete(false);
                    void deleteAllSignals();
                  }}
                  className="flex items-center gap-1 rounded-md bg-error-700/30 px-1.5 py-0.5 text-2xs font-bold uppercase text-error-400 transition hover:bg-error-700/50"
                >
                  <Trash2 size={10} />
                  Очистить
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="flex items-center gap-1 rounded-md bg-base-800 px-1.5 py-0.5 text-2xs font-bold uppercase text-base-400 transition hover:text-base-200"
                >
                  <X size={10} />
                  Отмена
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs font-semibold text-base-500 transition hover:text-error-400"
                title="Очистить всю историю сигналов"
              >
                <Trash2 size={10} />
                Удалить все
              </button>
            )}
          </div>
          <div className={clsx('flex flex-col gap-1.5 transition', confirmDelete && 'opacity-60')}>
            {closedTradedSignals.map((sig) => (
              <SignalCard
                key={sig.id}
                signal={sig}
                pipSize={pipSize}
                compact
                chartSelected={selectedChartSignalIds.has(sig.id)}
                onToggleChart={() => toggleChartSignal(sig.id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

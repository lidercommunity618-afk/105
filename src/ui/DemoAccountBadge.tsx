import { useState } from 'react';
import { Wallet, X, TrendingUp, TrendingDown, Minus, Ban } from 'lucide-react';
import { useDemoAccountStore, getStageStake } from '@/stores/useDemoAccountStore';
import { useTickStore } from '@/stores/useTickStore';
import { formatCurrency, clsx } from '@/lib/utils';

export function DemoAccountBadge() {
  const [open, setOpen] = useState(false);
  const balance = useDemoAccountStore((s) => s.balance);
  const profitPercent = useDemoAccountStore((s) => s.profitPercent);
  const martingale = useDemoAccountStore((s) => s.martingale);
  const stage0Amount = useDemoAccountStore((s) => s.stage0Amount);
  const stageAmounts = useDemoAccountStore((s) => s.stageAmounts);
  const openTrades = useDemoAccountStore((s) => s.openTrades);
  const history = useDemoAccountStore((s) => s.history);
  const activeSymbolId = useTickStore((s) => s.activeSymbolId);
  const activeTimeframe = useTickStore((s) => s.activeTimeframe);

  const openCount = Object.keys(openTrades).length;
  const recentHistory = history.slice(0, 5);

  const activeKey = activeSymbolId ? `${activeSymbolId}:${activeTimeframe}` : '';
  const activeState = activeKey ? martingale[activeKey] : undefined;
  const activeStage = activeState?.stage ?? 0;
  const activeStake = getStageStake(activeStage, stage0Amount, stageAmounts);

  const parallelSeries = Object.entries(martingale)
    .filter(([key, ms]) => key !== activeKey && ms.stage > 0 && !ms.halted)
    .map(([key, ms]) => {
      const [sym, tf] = key.split(':');
      return { key, symbolId: sym, timeframe: tf, stage: ms.stage, stake: getStageStake(ms.stage, stage0Amount, stageAmounts) };
    });

  const haltedInstruments = Object.entries(martingale)
    .filter(([, ms]) => ms.halted)
    .map(([key]) => {
      const [sym, tf] = key.split(':');
      return { key, symbolId: sym, timeframe: tf };
    });

  const activeHaltedEntry = haltedInstruments.find((h) => h.key === activeKey);
  const otherHalted = haltedInstruments.filter((h) => h.key !== activeKey);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-md bg-base-800 px-2 py-1.5 text-2xs font-bold transition hover:bg-base-700 sm:px-1.5 sm:py-1"
        aria-label="Демо-счёт"
      >
        <Wallet size={12} className="text-secondary-400" />
        <span className={clsx('font-mono tabular-nums', balance >= 0 ? 'text-success-500' : 'text-error-500')}>
          {formatCurrency(balance)}
        </span>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 animate-fade-in" onClick={() => setOpen(false)} />
          <div className="relative flex max-h-[85dvh] w-full max-w-sm flex-col rounded-2xl border border-base-800 bg-base-950 animate-slide-up">
            <div className="flex items-center justify-between border-b border-base-800 px-4 py-3">
              <h2 className="flex items-center gap-2 text-sm font-bold text-base-100">
                <Wallet size={18} className="text-secondary-400" />
                Демо-счёт
              </h2>
              <button onClick={() => setOpen(false)} className="rounded-lg p-1 text-base-400 transition hover:bg-base-800 hover:text-base-100">
                <X size={18} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-4">
              <div className="mb-4 rounded-xl border border-base-800 bg-base-900 px-4 py-3">
                <div className="text-2xs font-bold uppercase tracking-wider text-base-400">Баланс</div>
                <div className={clsx('mt-1 font-mono text-2xl font-bold tabular-nums', balance >= 0 ? 'text-success-500' : 'text-error-500')}>
                  {formatCurrency(balance)}
                </div>
              </div>

              <div className="mb-4 grid grid-cols-2 gap-2">
                <StatCard label="Процент прибыли" value={`${profitPercent}%`} />
                <StatCard
                  label="Открытые сделки"
                  value={String(openCount)}
                  valueClass={openCount > 0 ? 'text-accent-400' : 'text-base-100'}
                />
              </div>

              {activeHaltedEntry ? (
                <div className="mb-4 rounded-lg border border-error-700/50 bg-error-700/10 px-3 py-3">
                  <div className="flex items-center gap-2 text-xs font-bold text-error-400">
                    <Ban size={14} />
                    Торговля по {activeHaltedEntry.symbolId} {activeHaltedEntry.timeframe} остановлена
                  </div>
                  <p className="mt-1 text-2xs text-base-500">
                    Недостаточно средств. Измените баланс в настройках, чтобы возобновить.
                  </p>
                </div>
              ) : activeSymbolId ? (
                <div className="mb-4 rounded-lg border border-base-800 bg-base-900 px-3 py-3">
                  <div className="text-2xs font-bold uppercase tracking-wider text-base-400">
                    {activeSymbolId} {activeTimeframe}
                  </div>
                  <div className="mt-2 flex items-center justify-between">
                    <span className="text-2xs text-base-500">Стадия мартингейла</span>
                    <span className="font-mono text-sm font-bold tabular-nums text-base-100">
                      {activeStage}/3
                    </span>
                  </div>
                  <div className="mt-1 flex items-center justify-between">
                    <span className="text-2xs text-base-500">Следующая ставка</span>
                    <span className="font-mono text-sm font-bold tabular-nums text-base-100">
                      {formatCurrency(activeStake)}
                    </span>
                  </div>
                </div>
              ) : null}

              {parallelSeries.length > 0 && (
                <div className="mb-4">
                  <h3 className="mb-2 text-2xs font-bold uppercase tracking-wider text-base-400">Активные серии</h3>
                  <div className="flex flex-col gap-1.5">
                    {parallelSeries.map((s) => (
                      <div
                        key={s.key}
                        className="flex items-center justify-between rounded-lg border border-base-800 bg-base-900 px-3 py-2"
                      >
                        <span className="text-2xs font-medium text-base-300">
                          {s.symbolId} {s.timeframe} — стадия {s.stage}
                        </span>
                        <span className="font-mono text-xs font-bold tabular-nums text-base-100">
                          {formatCurrency(s.stake)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {otherHalted.length > 0 && (
                <div className="mb-4">
                  <h3 className="mb-2 text-2xs font-bold uppercase tracking-wider text-error-400">Остановленные инструменты</h3>
                  <div className="flex flex-col gap-1.5">
                    {otherHalted.map((h) => (
                      <div
                        key={h.key}
                        className="flex items-center gap-2 rounded-lg border border-error-700/30 bg-error-700/5 px-3 py-2"
                      >
                        <Ban size={12} className="text-error-400" />
                        <span className="text-2xs font-medium text-base-300">
                          {h.symbolId} {h.timeframe}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <p className="mb-4 text-2xs text-base-500">
                Стадии 0–3 — фиксированные суммы ставки в $. Мартингейл ведётся отдельно по каждому инструменту (символ + таймфрейм).
              </p>

              <div>
                <h3 className="mb-2 text-2xs font-bold uppercase tracking-wider text-base-400">Последние сделки</h3>
                {recentHistory.length === 0 ? (
                  <div className="rounded-lg border border-base-800 bg-base-900 px-3 py-4 text-center text-2xs text-base-500">
                    Сделок пока нет
                  </div>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {recentHistory.map((entry, i) => (
                      <div
                        key={`${entry.signalId}-${i}`}
                        className="flex items-center justify-between rounded-lg border border-base-800 bg-base-900 px-3 py-2"
                      >
                        <div className="flex items-center gap-2">
                          {entry.outcome === 'win' ? (
                            <TrendingUp size={14} className="text-success-400" />
                          ) : entry.outcome === 'loss' ? (
                            <TrendingDown size={14} className="text-error-400" />
                          ) : (
                            <Minus size={14} className="text-base-400" />
                          )}
                          <span className="text-2xs font-medium text-base-300">
                            {entry.outcome === 'win' ? 'Выигрыш' : entry.outcome === 'loss' ? 'Проигрыш' : 'Возврат'}
                          </span>
                        </div>
                        <span className={clsx('font-mono text-xs font-bold tabular-nums', entry.pnl > 0 ? 'text-success-400' : entry.pnl < 0 ? 'text-error-400' : 'text-base-400')}>
                          {entry.pnl > 0 ? '+' : ''}{formatCurrency(entry.pnl)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function StatCard({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="rounded-lg border border-base-800 bg-base-900 px-3 py-2">
      <div className="text-2xs text-base-500">{label}</div>
      <div className={clsx('mt-0.5 font-mono text-sm font-bold tabular-nums', valueClass ?? 'text-base-100')}>
        {value}
      </div>
    </div>
  );
}

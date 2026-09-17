import { X, ArrowUpCircle, ArrowDownCircle, ClipboardCopy, Check } from 'lucide-react';
import type { Signal } from '@/types/domain';
import { formatTime, clsx, getSignalEntryTime } from '@/lib/utils';
import { useTradeReportExport } from '@/hooks/useTradeReportExport';

interface EntryPointPopupProps {
  signal: Signal;
  onClose: () => void;
}

// Попап по клику на маркер точки входа на графике (см. ChartPanel.tsx).
// Показывает краткую атрибуцию сигнала (то же самое, что уже видно в
// SignalCard, но привязано к месту на графике, а не к списку истории) и
// кнопку экспорта полного постмортем-отчёта (lib/trade-report.ts) — по
// сценарию пользователя: убыточная сделка -> экспорт -> вставка в чат с ИИ.
export function EntryPointPopup({ signal, onClose }: EntryPointPopupProps) {
  const isBuy = signal.direction === 'buy';
  const Icon = isBuy ? ArrowUpCircle : ArrowDownCircle;
  const sideColor = isBuy ? 'text-success-500' : 'text-error-500';
  const factors = signal.factors ?? [];
  const topFactors = [...factors].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)).slice(0, 5);

  // Логика экспорта вынесена в общий хук (см. его JSDoc) — раньше была
  // продублирована один-в-один с SignalCard.tsx.
  const { copied, handleExport } = useTradeReportExport(signal);

  return (
    <div className="absolute bottom-3 right-3 z-20 w-72 rounded-xl border border-base-700 bg-base-900/95 p-3 shadow-xl backdrop-blur">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Icon size={16} className={sideColor} />
          <span className="text-xs font-semibold text-base-100">
            {/* Время свечи ВХОДА (см. getSignalEntryTime) — то же самое
                время, на которое поставлен маркер на графике, а не время
                свечи, где сигнал был сгенерирован (signal.time). */}
            {isBuy ? 'BUY' : 'SELL'} · {formatTime(getSignalEntryTime(signal))}
          </span>
        </div>
        <button onClick={onClose} className="rounded p-0.5 text-base-400 hover:bg-base-800 hover:text-base-100">
          <X size={14} />
        </button>
      </div>

      <div className="mt-1.5 text-2xs text-base-400">
        Score {signal.score.toFixed(1)} ({signal.strength})
        {signal.outcome !== 'pending' && (
          <span className={clsx(
            'ml-1.5 rounded px-1 py-0.5 font-semibold uppercase',
            signal.outcome === 'win' ? 'bg-success-700/30 text-success-400' :
            signal.outcome === 'loss' ? 'bg-error-700/30 text-error-400' :
            'bg-base-700/30 text-base-300',
          )}>
            {signal.outcome}
          </span>
        )}
      </div>

      {topFactors.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1 text-2xs text-base-300">
          {topFactors.map((f, i) => (
            <li key={i} className="flex items-start gap-1">
              <span className={clsx('mt-0.5 shrink-0 font-mono', f.contribution >= 0 ? 'text-success-500' : 'text-error-500')}>
                {f.contribution >= 0 ? '+' : ''}{f.contribution.toFixed(2)}
              </span>
              <span className="truncate">{f.argument}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-2xs text-base-500">
          Структурированная атрибуция недоступна для этого сигнала (создан до появления этой функции).
        </p>
      )}

      <button
        onClick={() => { void handleExport(); }}
        className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg bg-secondary-700/30 px-2 py-1.5 text-2xs font-semibold text-secondary-300 hover:bg-secondary-700/50"
      >
        {copied ? <Check size={12} /> : <ClipboardCopy size={12} />}
        {copied ? 'Скопировано' : 'Экспорт для анализа'}
      </button>
    </div>
  );
}

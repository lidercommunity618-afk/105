import { useEffect, useState } from 'react';
import { AlertTriangle, X, Timer, CheckCircle2 } from 'lucide-react';
import type { Signal } from '@/types/domain';
import { patternCategory, PATTERN_LABELS_RU } from '@/lib/pattern-categories';
import { translateReason } from '@/lib/reason-translations';

interface PriorityAlertBannerProps {
  signal: Signal;
  /** Оставлен для обратной совместимости вызовов и возможного будущего
   * использования — цена входа показывается только в SignalCard.tsx, не
   * дублируется в этой компактной плитке. BUGFIX (Фаза 1, "честный
   * бинарный опцион"): комментарий раньше упоминал "стоп/цель" — этих
   * полей у Signal больше нет вовсе (см. types/domain.ts), не только в
   * этой конкретной плитке. */
  pipSize: number;
  onDismiss: () => void;
}

const COUNTDOWN_SECONDS = 30;
const NEUTRAL_REASON_TEXT = 'Комплексное подтверждение по нескольким факторам';

export function PriorityAlertBanner({ signal, onDismiss }: PriorityAlertBannerProps) {
  const [remaining, setRemaining] = useState(COUNTDOWN_SECONDS);

  useEffect(() => {
    setRemaining(COUNTDOWN_SECONDS);
    const interval = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          clearInterval(interval);
          onDismiss();
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [signal.id, onDismiss]);

  const isBuy = signal.direction === 'buy';
  const progress = (remaining / COUNTDOWN_SECONDS) * 100;
  const category = signal.pattern ? patternCategory(signal.pattern) : null;
  const isStrategy = category === 'strategy';
  const accentTextClass = isStrategy ? 'text-accent-400' : 'text-secondary-400';
  const reasonLines = translateReason(signal.reason).slice(0, 3);
  const displayedReasons = reasonLines.length > 0 ? reasonLines : [NEUTRAL_REASON_TEXT];

  return (
    <div
      className={`absolute bottom-[60px] left-2 z-50 w-[200px] animate-slide-up rounded-lg border ${isStrategy ? 'border-accent-600' : 'border-secondary-600'} bg-base-900/95 shadow-xl backdrop-blur lg:bottom-2`}
    >
      {/* ── header row ── */}
      <div className={`border-b ${isStrategy ? 'border-accent-800/50' : 'border-secondary-800/50'} px-2 py-1`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <AlertTriangle size={9} className={accentTextClass} />
            <span className={`text-3xs font-bold uppercase tracking-wider ${accentTextClass}`}>
              Сигнал
            </span>
          </div>
          <button
            onClick={onDismiss}
            className="rounded p-0.5 text-base-400 transition hover:bg-base-800 hover:text-base-100"
          >
            <X size={9} />
          </button>
        </div>
        {signal.pattern && (
          <div className="mt-0.5 text-3xs text-base-500">
            {isStrategy ? 'Стратегия' : 'Паттерн'} · {PATTERN_LABELS_RU[signal.pattern] ?? signal.pattern.replace(/-/g, ' ')}
          </div>
        )}
      </div>

      {/* ── body ── */}
      <div className="px-2 py-1.5">
        {/* direction + strength + countdown */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <span
              className={`text-3xs font-bold uppercase ${isBuy ? 'text-success-500' : 'text-error-500'}`}
            >
              {isBuy ? 'Покупка' : 'Продажа'}
            </span>
            <span className="text-3xs font-bold uppercase text-secondary-400">{signal.strength}</span>
          </div>
          <div className="flex items-center gap-0.5 text-secondary-400">
            <Timer size={8} />
            <span className="font-mono text-3xs font-semibold tabular-nums">{remaining}s</span>
          </div>
        </div>

        {/* ── аргументы сигнала (русский текст reason) ── */}
        <div className="mt-1.5 space-y-1">
          {displayedReasons.map((line, index) => (
            <div key={index} className="flex items-center gap-1">
              <CheckCircle2 size={9} className={`shrink-0 ${accentTextClass}`} />
              <span className="text-3xs text-base-200">{line}</span>
            </div>
          ))}
        </div>

        {/* countdown progress bar */}
        <div className="mt-1.5 h-0.5 overflow-hidden rounded-full bg-base-800">
          <div
            className={`h-full rounded-full ${isStrategy ? 'bg-accent-500' : 'bg-secondary-500'} transition-all duration-1000 ease-linear`}
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
    </div>
  );
}

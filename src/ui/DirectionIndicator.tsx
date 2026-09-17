import { ArrowUpCircle, ArrowDownCircle, CircleDashed } from 'lucide-react';
import type { Signal } from '@/types/domain';
import { clsx } from '@/lib/utils';

interface DirectionIndicatorProps {
  signal: Signal | null;
  size?: number;
}

export function DirectionIndicator({ signal, size = 28 }: DirectionIndicatorProps) {
  if (!signal) {
    return (
      <div className="flex items-center gap-2 text-base-400">
        <CircleDashed size={size} className="text-base-600" />
        <div className="flex flex-col">
          <span className="text-xs font-semibold text-base-300">Нет сигнала</span>
          <span className="text-2xs text-base-500">ожидание условий</span>
        </div>
      </div>
    );
  }

  const isBuy = signal.direction === 'buy';
  const Icon = isBuy ? ArrowUpCircle : ArrowDownCircle;

  return (
    <div className="flex items-center gap-2">
      <Icon
        size={size}
        className={clsx(isBuy ? 'text-success-500' : 'text-error-500')}
      />
      <div className="flex flex-col">
        <span
          className={clsx(
            'text-sm font-bold uppercase tracking-wide',
            isBuy ? 'text-success-400' : 'text-error-400',
          )}
        >
          {isBuy ? 'Покупка' : 'Продажа'}
        </span>
        <span className="text-2xs text-base-400">
          {signal.isPreClose ? 'досрочно' : signal.isRevised ? 'обновлён' : signal.frozenAt !== null ? 'заморожен' : 'лайв'}
          {' · '}
          рейтинг {signal.score}
        </span>
      </div>
    </div>
  );
}

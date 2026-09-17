import { TrendingUp, TrendingDown, Minus, GitBranch } from 'lucide-react';
import type { MarketStructure } from '@/types/domain';
import { formatTime, clsx } from '@/lib/utils';

interface MarketStructureBadgeProps {
  structure: MarketStructure;
  candleTime: number | null;
}

export function MarketStructureBadge({ structure, candleTime }: MarketStructureBadgeProps) {
  const { trend, bos, choch, swingHigh, swingLow } = structure;

  const config = trend === 'up'
    ? { label: 'Бычий', icon: TrendingUp, color: 'text-success-400', bg: 'bg-success-700/20' }
    : trend === 'down'
    ? { label: 'Медвежий', icon: TrendingDown, color: 'text-error-400', bg: 'bg-error-700/20' }
    : { label: 'Флэт', icon: Minus, color: 'text-base-300', bg: 'bg-base-700/40' };

  const Icon = config.icon;
  const event = bos ? 'BOS' : choch ? 'CHOCH' : null;

  return (
    <div className="flex flex-col gap-1">
      <span
        className={clsx(
          'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-2xs font-bold',
          config.bg,
          config.color,
        )}
      >
        <Icon size={12} />
        {config.label} структура
      </span>
      {event && candleTime !== null && (
        <span className="flex items-center gap-1 text-2xs text-accent-400">
          <GitBranch size={10} />
          {event} · {formatTime(candleTime)}
        </span>
      )}
      {swingHigh !== null && swingLow !== null && (
        <span className="font-mono text-2xs text-base-500">
          H {swingHigh.toPrecision(6)} · L {swingLow.toPrecision(6)}
        </span>
      )}
    </div>
  );
}

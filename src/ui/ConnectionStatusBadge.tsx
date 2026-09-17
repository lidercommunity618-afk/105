import { Wifi, Loader2, AlertCircle, AlertTriangle, Minus, Moon } from 'lucide-react';
import type { ConnectionStatus } from '@/types/domain';
import { clsx } from '@/lib/utils';

interface StatusConfig {
  label: string;
  icon: typeof Wifi;
  color: string;
  bg: string;
  pulse: boolean;
}

const STATUS_CONFIG: Record<ConnectionStatus, StatusConfig> = {
  idle: {
    label: 'Ожидание',
    icon: Minus,
    color: 'text-base-400',
    bg: 'bg-base-800/50',
    pulse: false,
  },
  connecting: {
    label: 'Подключение',
    icon: Loader2,
    color: 'text-accent-400',
    bg: 'bg-accent-700/20',
    pulse: true,
  },
  live: {
    label: 'В эфире',
    icon: Wifi,
    color: 'text-success-400',
    bg: 'bg-success-700/20',
    pulse: false,
  },
  market_closed: {
    label: 'Рынок закрыт',
    icon: Moon,
    color: 'text-accent-400',
    bg: 'bg-accent-700/20',
    pulse: false,
  },
  degraded: {
    label: 'Пониж. качество',
    icon: AlertTriangle,
    color: 'text-accent-400',
    bg: 'bg-accent-700/20',
    pulse: false,
  },
  reconnecting: {
    label: 'Переподключение',
    icon: Loader2,
    color: 'text-accent-400',
    bg: 'bg-accent-700/20',
    pulse: true,
  },
  failed: {
    label: 'Ошибка',
    icon: AlertCircle,
    color: 'text-error-400',
    bg: 'bg-error-700/20',
    pulse: false,
  },
};

export function ConnectionStatusBadge({ status }: { status: ConnectionStatus }) {
  const config = STATUS_CONFIG[status];
  const Icon = config.icon;

  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-2xs font-bold',
        config.bg,
        config.color,
      )}
    >
      <Icon size={12} className={clsx(config.pulse && 'animate-spin')} />
      {config.label}
    </span>
  );
}

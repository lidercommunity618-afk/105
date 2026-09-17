import { TIMEFRAME_SECONDS } from '@/data/symbols';
import type { Signal } from '@/types/domain';

export function formatPrice(value: number, pipSize: number): string {
  const decimals = Math.max(0, Math.min(8, Math.round(Math.log10(1 / pipSize))));
  return value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatForexPrice(value: number, quoteAsset: string): string {
  const isJpy = quoteAsset === 'JPY';
  const decimals = isJpy ? 3 : 5;
  return value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatCompact(value: number | null): string {
  if (value === null) return '—';
  if (Math.abs(value) >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  return value.toFixed(2);
}

export function formatPercent(value: number | null, decimals = 2): string {
  if (value === null) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(decimals)}%`;
}

export function formatTime(timeSeconds: number): string {
  return new Date(timeSeconds * 1000).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function clsx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function formatCurrency(value: number): string {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const formatted = abs.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sign}${formatted.replace(/,/g, ' ')}`;
}

export function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Компактное форматирование длительности в секундах (recommendedExpiry) —
// было продублировано как локальная formatExpiry() в SignalCard.tsx;
// вынесено сюда, чтобы постмортем-отчёт (lib/trade-report.ts) использовал
// то же самое представление, а не отдельную копию форматирования.
export function formatDurationShort(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

// Аудит (точки входа на графике): сигнал создаётся на ещё формирующейся
// "сигнальной" свече — signal.time это время именно этой свечи (см.
// decision/signal-builder.ts), а НЕ той свечи, на которой реально
// открывается сделка. Реальная точка входа — всегда СЛЕДУЮЩАЯ свеча
// (signal.time + tfSeconds); это уже то самое смещение, которое
// useDemoAccountStore.confirmEntryPrice независимо вычисляет как
// `newCandleTime = signal.time + tfSeconds` при подтверждении цены входа
// по open новой свечи. Единая точка вычисления этого смещения — чтобы
// ChartPanel (маркер стрелки) и попап атрибуции показывали ОДНУ и ту же
// свечу, вместо того чтобы каждый компонент отдельно прибавлял
// TIMEFRAME_SECONDS[...] и рисковал разойтись.
export function getSignalEntryTime(signal: Signal): number {
  return signal.time + TIMEFRAME_SECONDS[signal.timeframe];
}

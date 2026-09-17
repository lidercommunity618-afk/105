import { TrendingUp, TrendingDown, Minus, Clock, Target, Percent } from 'lucide-react';
import { useTickStore } from '@/stores/useTickStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useAnalyticsStore } from '@/stores/useAnalyticsStore';
import { useDemoAccountStore } from '@/stores/useDemoAccountStore';
import { findSymbol } from '@/data/symbols';
import { formatPrice, clsx } from '@/lib/utils';

export function StatusBar() {
  const currentPrice = useTickStore((s) => s.currentPrice);
  const flash = useTickStore((s) => s.lastPriceFlash);
  const loading = useTickStore((s) => s.loading);
  const error = useTickStore((s) => s.error);
  const sourceFallbackNotice = useTickStore((s) => s.sourceFallbackNotice);
  const marketClosed = useTickStore((s) => s.marketClosed);
  const candleCount = useTickStore((s) => s.candles.length);
  const winRate = useAnalyticsStore((s) => s.winRate);
  const signals = useAnalyticsStore((s) => s.signals);
  const symbolId = useSettingsStore((s) => s.symbolId);
  const symbol = findSymbol(symbolId);
  // Фаза 5 ("UI/UX и продуктовая честность"): выплата — рядом с винрейтом,
  // не отдельно спрятана в настройках демо-счёта. Точка безубыточности
  // бинарного опциона с фиксированной выплатой — не 50%, а
  // 100/(100+profitPercent) (при 80% — 55.56%), и без этого числа рядом
  // винрейт сам по себе не говорит, прибыльна ли стратегия по факту (см.
  // комментарий у BUGFIX 2026-09-13 в backtest/metrics.ts, тот же принцип).
  const profitPercent = useDemoAccountStore((s) => s.profitPercent);

  if (error) {
    return (
      <div className="flex items-center gap-2 border-t border-error-700/40 bg-error-700/20 px-3 py-1.5 text-2xs text-error-400">
        <span className="font-semibold">Ошибка:</span>
        <span className="truncate">{error}</span>
      </div>
    );
  }

  if (sourceFallbackNotice) {
    return (
      <div className="flex items-center gap-2 border-t border-accent-700/40 bg-accent-700/10 px-3 py-1.5 text-2xs text-accent-400">
        <span className="animate-pulse-soft truncate">{sourceFallbackNotice}</span>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 border-t border-base-800 bg-base-950 px-3 py-1.5 text-2xs text-base-400">
        <span className="animate-pulse-soft">Загрузка рыночных данных…</span>
      </div>
    );
  }

  const ChangeIcon = flash === 'up' ? TrendingUp : flash === 'down' ? TrendingDown : Minus;

  // Аудит (синхронизация с демо-счётом): та же фильтрация, что и в
  // useAnalyticsStore.recomputeStats() — иначе winRatePct (из winRate,
  // отфильтрованного) и разбивка побед/поражений/тайм-аутов ниже (raw
  // signals) могли бы разойтись между собой для одного и того же набора
  // сигналов.
  const tradedSignals = signals.filter((s) => s.tradeOpened !== false);
  const completedSignals = tradedSignals.filter((s) => s.outcome === 'win' || s.outcome === 'loss' || s.outcome === 'timeout');
  const wins = completedSignals.filter((s) => s.outcome === 'win').length;
  const losses = completedSignals.filter((s) => s.outcome === 'loss').length;
  const draws = completedSignals.filter((s) => s.outcome === 'timeout').length;
  const winRatePct = winRate !== null ? Math.round(winRate * 100) : null;
  const winRateTone = winRatePct !== null && winRatePct >= 60 ? 'text-success-400' : winRatePct !== null && winRatePct >= 45 ? 'text-secondary-400' : 'text-error-400';

  return (
    <div className="flex items-center gap-2 border-t border-base-800 bg-base-950 px-3 py-1.5 text-2xs text-base-400 sm:gap-4">
      <span className="flex shrink-0 items-center gap-1">
        <span className="text-base-500">цена</span>
        <span className={clsx('font-mono tabular-nums', flash === 'up' ? 'text-success-500' : flash === 'down' ? 'text-error-500' : 'text-base-200')}>
          {currentPrice !== null && symbol ? formatPrice(currentPrice, symbol.pipSize) : '—'}
        </span>
      </span>
      <span className="hidden shrink-0 items-center gap-1 sm:flex">
        <ChangeIcon size={11} className={flash === 'up' ? 'text-success-500' : flash === 'down' ? 'text-error-500' : 'text-base-500'} />
        <span className={clsx(flash === 'up' ? 'text-success-500' : flash === 'down' ? 'text-error-500' : 'text-base-500')}>
          {flash === 'up' ? 'рост' : flash === 'down' ? 'падение' : 'стоп'}
        </span>
      </span>
      <div className="flex min-w-0 flex-1 justify-center">
        <span className="text-base-500">{candleCount > 0 ? `${candleCount} свечей загружено` : ''}</span>
      </div>
      {winRatePct !== null && (
        <span className="flex shrink-0 items-center gap-1">
          <Target size={11} className={winRateTone} />
          <span className="text-base-500">винрейт</span>
          <span className={clsx('font-mono font-bold tabular-nums', winRateTone)}>
            {winRatePct}%
          </span>
          <span className="text-base-600">·</span>
          <span className="font-mono text-success-400">{wins}</span>
          <span className="text-base-600">/</span>
          <span className="font-mono text-error-400">{losses}</span>
          {draws > 0 && (
            <>
              <span className="text-base-600">/</span>
              <span className="font-mono text-base-400">{draws}</span>
            </>
          )}
        </span>
      )}
      {/* Фаза 5: выплата — всегда рядом с винрейтом (не только когда есть
          завершённые сделки), т.к. это статичный параметр самого продукта,
          а не производная от истории. */}
      <span className="flex shrink-0 items-center gap-1">
        <Percent size={11} className="text-base-500" />
        <span className="text-base-500">выплата</span>
        <span className="font-mono font-semibold text-base-200">{profitPercent}%</span>
      </span>
      <span className="flex shrink-0 items-center gap-1">
        <span className="text-base-500">свечей</span>
        <span className="font-mono text-base-300">{candleCount}</span>
      </span>
      {marketClosed && (
        <span className="hidden shrink-0 items-center gap-1 text-accent-400 sm:flex">
          <Clock size={11} />
          Рынок закрыт
        </span>
      )}
    </div>
  );
}

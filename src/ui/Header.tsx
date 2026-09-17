import { TIMEFRAMES } from '@/data/symbols';
import { useSettingsStore } from '@/stores/settingsStore';
import { useTickStore } from '@/stores/useTickStore';
import { useAnalyticsStore } from '@/stores/useAnalyticsStore';
import { findSymbol } from '@/data/symbols';
import { formatPrice, formatForexPrice, clsx } from '@/lib/utils';
import { SymbolSelector } from '@/ui/SymbolSelector';
import { ConnectionStatusBadge } from '@/ui/ConnectionStatusBadge';
import { ForexHoursIndicator } from '@/ui/ForexHoursIndicator';
import { PredictionAccuracyBadge } from '@/ui/PredictionAccuracyBadge';
import { Boxes } from 'lucide-react';
import { useState, lazy, Suspense } from 'react';
import { AiAnalysisButton } from '@/ui/AiAnalysisButton';
import { DemoAccountBadge } from '@/ui/DemoAccountBadge';
import { CandleTimer } from '@/ui/CandleTimer';

const StrategiesModal = lazy(() =>
  import('@/ui/StrategiesModal').then((m) => ({ default: m.StrategiesModal })),
);

interface HeaderProps {
  onAiAnalyze: () => void;
  aiLoading: boolean;
}

export function Header({ onAiAnalyze, aiLoading }: HeaderProps) {
  const timeframe = useSettingsStore((s) => s.timeframe);
  const setTimeframe = useSettingsStore((s) => s.setTimeframe);
  const currentPrice = useTickStore((s) => s.currentPrice);
  const flash = useTickStore((s) => s.lastPriceFlash);
  const marketClosed = useTickStore((s) => s.marketClosed);
  const status = useAnalyticsStore((s) => s.connectionStatus);
  const symbolId = useSettingsStore((s) => s.symbolId);
  const [strategiesOpen, setStrategiesOpen] = useState(false);

  const symbol = findSymbol(symbolId);
  const marketOpen = symbol ? !marketClosed : false;

  return (
    <header className="flex flex-col gap-2 border-b border-base-800 bg-base-950 px-3 py-2 sm:gap-2 sm:px-3 sm:py-2 lg:flex-row lg:items-center lg:gap-2.5">
      {/* Row 1 on mobile / first segment on desktop: brand + symbol + timeframe */}
      <div className="flex items-center gap-2 sm:gap-2 lg:contents">
        {/* Left: brand + symbol selector */}
        <div className="flex min-w-0 flex-1 items-center gap-2 sm:flex-none sm:shrink-0 lg:gap-2">
          <span className="hidden text-sm font-bold tracking-tight text-base-100 sm:inline">Терминал</span>
          <SymbolSelector />
        </div>

        {/* Timeframe selector — compact, scrollable if it still overflows */}
        <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto rounded-lg bg-base-800 p-1 no-scrollbar lg:overflow-visible">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              onClick={() => setTimeframe(tf)}
              className={clsx(
                'shrink-0 rounded-md px-2 py-1.5 text-center text-2xs font-semibold transition sm:px-2 sm:text-2xs lg:px-3 lg:text-xs',
                'w-8 sm:w-8 lg:w-10',
                tf === timeframe
                  ? 'bg-primary-600 text-white'
                  : 'text-base-300 hover:text-base-100',
              )}
            >
              {tf}
            </button>
          ))}
        </div>
      </div>

      {/* Row 2 on mobile / second segment on desktop: timer + right cluster */}
      <div className="flex items-center gap-2 sm:gap-2 lg:contents">
        {/* Candle timer — always visible on top bar, any orientation */}
        <div className="flex shrink-0 items-center">
          <CandleTimer />
        </div>

        {/* Right cluster: price + badges */}
        <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-1.5 lg:gap-2.5">
          {/* Price + forex hours — hidden on small screens to save space */}
          <div className="hidden flex-col items-end sm:flex">
            <span
              className={clsx(
                'font-mono text-sm font-bold tabular-nums transition-colors lg:text-base',
                flash === 'up' ? 'text-success-500' : flash === 'down' ? 'text-error-500' : 'text-base-100',
              )}
            >
              {currentPrice !== null && symbol
                ? symbol.assetClass === 'forex'
                  ? formatForexPrice(currentPrice, symbol.quoteAsset)
                  : formatPrice(currentPrice, symbol.pipSize)
                : '—'}
            </span>
            {symbol && (
              <div className="mt-0.5">
                <ForexHoursIndicator symbol={symbol} />
              </div>
            )}
          </div>

          {/* Market open/closed badge */}
          <span
            className={clsx(
              'flex shrink-0 items-center rounded-md px-2 py-1.5 text-2xs font-bold sm:px-1.5 sm:py-1',
              marketOpen ? 'bg-success-700/30 text-success-400' : 'bg-accent-700/30 text-accent-400',
            )}
          >
            {marketOpen ? 'ОТКР' : 'ЗАКР'}
          </span>

          {/* Prediction accuracy — hidden on small screens */}
          <div className="hidden sm:block">
            <PredictionAccuracyBadge />
          </div>

          <DemoAccountBadge />

          {/* Connection status — icon only on mobile, full on desktop */}
          <div className="hidden md:block">
            <ConnectionStatusBadge status={status} />
          </div>

          <AiAnalysisButton onClick={onAiAnalyze} loading={aiLoading} />

          <button
            onClick={() => setStrategiesOpen(true)}
            className="flex shrink-0 items-center gap-1 rounded-lg bg-base-800 p-2 text-base-300 transition hover:bg-base-700 hover:text-base-100 sm:p-2"
            aria-label="Стратегии"
          >
            <Boxes size={16} />
          </button>
        </div>
      </div>
      {strategiesOpen && (
        <Suspense fallback={null}>
          <StrategiesModal onClose={() => setStrategiesOpen(false)} />
        </Suspense>
      )}
    </header>
  );
}

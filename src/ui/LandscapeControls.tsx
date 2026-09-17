import { TIMEFRAMES } from '@/data/symbols';
import { useSettingsStore } from '@/stores/settingsStore';
import { useTickStore } from '@/stores/useTickStore';
import { useAnalyticsStore } from '@/stores/useAnalyticsStore';
import { findSymbol } from '@/data/symbols';
import { formatPrice, formatForexPrice, clsx } from '@/lib/utils';
import { SymbolSelector } from '@/ui/SymbolSelector';
import { PredictionAccuracyBadge } from '@/ui/PredictionAccuracyBadge';
import { DemoAccountBadge } from '@/ui/DemoAccountBadge';
import { ConnectionStatusBadge } from '@/ui/ConnectionStatusBadge';
import { AiAnalysisButton } from '@/ui/AiAnalysisButton';
import { CandleTimer } from '@/ui/CandleTimer';
import { Maximize2, Minimize2 } from 'lucide-react';

interface LandscapeControlsProps {
  panelsVisible: boolean;
  onTogglePanels: () => void;
  onAiAnalyze: () => void;
  aiLoading: boolean;
}

export function LandscapeControls({ panelsVisible, onTogglePanels, onAiAnalyze, aiLoading }: LandscapeControlsProps) {
  const timeframe = useSettingsStore((s) => s.timeframe);
  const setTimeframe = useSettingsStore((s) => s.setTimeframe);
  const currentPrice = useTickStore((s) => s.currentPrice);
  const flash = useTickStore((s) => s.lastPriceFlash);
  const status = useAnalyticsStore((s) => s.connectionStatus);
  const symbolId = useSettingsStore((s) => s.symbolId);
  const symbol = findSymbol(symbolId);

  const statusColor =
    status === 'live' ? 'bg-success-500' :
    status === 'connecting' || status === 'reconnecting' ? 'bg-accent-500 animate-pulse' :
    status === 'failed' ? 'bg-error-500' :
    'bg-base-500';

  return (
    <>
      {/* Toggle button — always visible, top-right */}
      <button
        onClick={(e) => { e.stopPropagation(); onTogglePanels(); }}
        className="absolute right-2 top-2 z-50 flex items-center gap-1 rounded-lg bg-base-900/80 p-2 text-base-200 backdrop-blur transition hover:bg-base-800 hover:text-base-100"
        aria-label={panelsVisible ? 'Скрыть панели' : 'Показать панели'}
      >
        {panelsVisible ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
      </button>

      {/* Top overlay bar with all terminal indicators — shown when panels are visible */}
      {panelsVisible && (
        <div
          className="pointer-events-none absolute left-2 right-12 top-2 z-40 flex flex-wrap items-center gap-1.5 rounded-lg bg-base-900/80 px-2 py-1 backdrop-blur"
          style={{ paddingTop: 'max(0.25rem, env(safe-area-inset-top))' }}
        >
          <div className="pointer-events-auto flex items-center gap-2">
            <SymbolSelector />
          </div>

          {/* Timeframe pills */}
          <div className="pointer-events-auto flex items-center gap-0.5 overflow-x-auto rounded-lg bg-base-800 p-0.5 no-scrollbar">
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf}
                onClick={() => setTimeframe(tf)}
                className={clsx(
                  'shrink-0 rounded-md px-2 py-0.5 text-2xs font-semibold transition',
                  tf === timeframe
                    ? 'bg-primary-600 text-white'
                    : 'text-base-300 hover:text-base-100',
                )}
              >
                {tf}
              </button>
            ))}
          </div>

          {/* Candle timer — always visible in landscape top bar */}
          <div className="pointer-events-auto flex items-center">
            <CandleTimer />
          </div>

          {/* Price */}
          <span
            className={clsx(
              'ml-auto shrink-0 font-mono text-xs font-bold tabular-nums',
              flash === 'up' ? 'text-success-500' : flash === 'down' ? 'text-error-500' : 'text-base-100',
            )}
          >
            {currentPrice !== null && symbol
              ? symbol.assetClass === 'forex'
                ? formatForexPrice(currentPrice, symbol.quoteAsset)
                : formatPrice(currentPrice, symbol.pipSize)
              : '—'}
          </span>

          {/* Prediction accuracy */}
          <div className="pointer-events-auto hidden sm:block">
            <PredictionAccuracyBadge />
          </div>

          {/* Demo account */}
          <div className="pointer-events-auto">
            <DemoAccountBadge />
          </div>

          {/* Connection status badge */}
          <div className="pointer-events-auto hidden sm:block">
            <ConnectionStatusBadge status={status} />
          </div>

          {/* Compact status dot for very small screens */}
          <span className={clsx('h-2 w-2 shrink-0 rounded-full sm:hidden', statusColor)} />

          {/* AI analysis button */}
          <div className="pointer-events-auto">
            <AiAnalysisButton onClick={onAiAnalyze} loading={aiLoading} />
          </div>
        </div>
      )}
    </>
  );
}

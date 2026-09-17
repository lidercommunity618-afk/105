import { Brain, X, Loader2, AlertCircle, RotateCw, TrendingUp, TrendingDown, Minus, Target, Shield } from 'lucide-react';
import { clsx } from '@/lib/utils';
import type { AIAnalysis } from '@/lib/gemini-analysis';

interface AiAnalysisOverlayProps {
  loading: boolean;
  result: AIAnalysis | null;
  error: string | null;
  onAnalyze: () => void;
  onClear: () => void;
}

const TREND_CONFIG = {
  bullish: { icon: TrendingUp, color: 'text-success-400', bg: 'bg-success-700/30' },
  bearish: { icon: TrendingDown, color: 'text-error-400', bg: 'bg-error-700/30' },
  sideways: { icon: Minus, color: 'text-base-400', bg: 'bg-base-800' },
} as const;

const TREND_LABELS = { bullish: 'Бычий', bearish: 'Медвежий', sideways: 'Нейтр.' } as const;

const REC_CONFIG = {
  buy: { color: 'text-success-400', bg: 'bg-success-700/30' },
  sell: { color: 'text-error-400', bg: 'bg-error-700/30' },
  wait: { color: 'text-accent-400', bg: 'bg-accent-700/30' },
} as const;

const REC_LABELS = { buy: 'Покупка', sell: 'Продажа', wait: 'Ждать' } as const;

export function AiAnalysisOverlay({ loading, result, error, onAnalyze, onClear }: AiAnalysisOverlayProps) {
  const visible = loading || result !== null || error !== null;
  if (!visible) return null;

  return (
    <div className="absolute bottom-3 left-3 right-3 z-30 max-h-[55%] overflow-y-auto rounded-xl border border-base-700 bg-base-900/95 backdrop-blur animate-slide-up">
      <div className="flex items-center justify-between border-b border-base-800 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Brain size={14} className={clsx(loading && 'animate-pulse', 'text-secondary-400')} />
          <span className="text-2xs font-bold uppercase tracking-wider text-base-300">
            ИИ-анализ
          </span>
        </div>
        <button
          onClick={onClear}
          className="rounded p-0.5 text-base-400 transition hover:bg-base-800 hover:text-base-100"
        >
          <X size={14} />
        </button>
      </div>

      <div className="px-3 py-2.5">
        {loading && (
          <div className="flex items-center gap-2 text-xs text-base-400">
            <Loader2 size={14} className="animate-spin text-secondary-400" />
            Анализ рыночных условий…
          </div>
        )}

        {error && !loading && (
          <div className="flex flex-col gap-2">
            <div className="flex items-start gap-2 text-xs text-error-400">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
            <button
              onClick={onAnalyze}
              className="flex items-center gap-1.5 rounded-lg bg-base-800 px-2.5 py-1.5 text-2xs font-semibold text-base-200 transition hover:bg-base-700"
            >
              <RotateCw size={12} />
              Повторить
            </button>
          </div>
        )}

        {result && !loading && !error && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              {(() => {
                const cfg = TREND_CONFIG[result.trend];
                const TrendIcon = cfg.icon;
                return (
                  <span className={clsx('flex items-center gap-1 rounded-md px-2 py-0.5 text-2xs font-bold uppercase', cfg.bg, cfg.color)}>
                    <TrendIcon size={11} />
                    {TREND_LABELS[result.trend] ?? result.trend}
                  </span>
                );
              })()}
              {(() => {
                const cfg = REC_CONFIG[result.recommendation];
                return (
                  <span className={clsx('flex items-center gap-1 rounded-md px-2 py-0.5 text-2xs font-bold uppercase', cfg.bg, cfg.color)}>
                    {REC_LABELS[result.recommendation] ?? result.recommendation}
                  </span>
                );
              })()}
              <span className="flex items-center gap-1 rounded-md bg-base-800 px-2 py-0.5 text-2xs font-bold text-base-300">
                {result.confidence.toFixed(0)}% увер.
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="flex items-center gap-1.5 rounded-lg bg-base-800/60 px-2 py-1.5">
                <Target size={12} className="text-success-400" />
                <div className="flex flex-col">
                  <span className="text-3xs font-medium uppercase text-base-500">Поддержка</span>
                  <span className="font-mono text-xs font-semibold text-base-200">{result.levels.support}</span>
                </div>
              </div>
              <div className="flex items-center gap-1.5 rounded-lg bg-base-800/60 px-2 py-1.5">
                <Shield size={12} className="text-error-400" />
                <div className="flex flex-col">
                  <span className="text-3xs font-medium uppercase text-base-500">Сопротивление</span>
                  <span className="font-mono text-xs font-semibold text-base-200">{result.levels.resistance}</span>
                </div>
              </div>
            </div>

            <p className="text-xs leading-relaxed text-base-200">{result.reasoning}</p>

            {result.keyLevels && result.keyLevels.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {result.keyLevels.slice(0, 6).map((lvl, i) => (
                  <span key={i} className="rounded bg-base-800 px-1.5 py-0.5 font-mono text-3xs text-base-400">
                    {lvl}
                  </span>
                ))}
              </div>
            )}

            {result.riskNote && (
              <div className="flex items-start gap-1.5 rounded-lg bg-warning-700/15 px-2 py-1.5">
                <AlertCircle size={12} className="mt-0.5 shrink-0 text-warning-400" />
                <span className="text-3xs leading-relaxed text-warning-400">{result.riskNote}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}


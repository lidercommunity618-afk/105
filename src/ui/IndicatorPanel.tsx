import { Gauge, TrendingUp, TrendingDown, BarChart3, Activity, Zap } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTickStore } from '@/stores/useTickStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { findSymbol } from '@/data/symbols';
import { clsx } from '@/lib/utils';

type Tone = 'neutral' | 'positive' | 'negative' | 'warning';

export function IndicatorPanel() {
  const indicators = useTickStore((s) => s.indicatorSnapshot);
  const activeSymbolId = useTickStore((s) => s.activeSymbolId);
  const config = useSettingsStore((s) => s.indicators);
  const activeIndicators = useSettingsStore((s) => s.activeIndicators);

  const symbol = activeSymbolId ? findSymbol(activeSymbolId) : undefined;
  const isForex = symbol?.assetClass === 'forex';

  const showRsi = activeIndicators.includes('rsi');
  const showEma = activeIndicators.includes('ema');
  const showMacd = activeIndicators.includes('macd');
  const showAtr = activeIndicators.includes('atr');
  const showBb = activeIndicators.includes('bollinger');
  const showVwap = activeIndicators.includes('vwap') && !isForex;
  const showVolumeProfile = activeIndicators.includes('volume-profile') && !isForex;
  const showImpulse = activeIndicators.includes('impulse-velocity');

  const hasMomentum = showRsi || showMacd;
  const hasTrend = showEma;
  const hasVolatility = showAtr || showBb;
  const hasVolume = showVwap || showVolumeProfile || showImpulse;

  return (
    <div className="flex flex-col gap-4">
      {/* ── Импульс: RSI + MACD ── */}
      {hasMomentum && (
        <section>
          <GroupLabel>Импульс</GroupLabel>
          <div className="grid grid-cols-2 gap-2">
            {showRsi && (
              <Metric
                label={`RSI ${config.rsiPeriod}`}
                value={indicators?.rsi ?? null}
                icon={<Gauge size={13} className="text-secondary-400" />}
                tone={rsiTone(indicators?.rsi ?? null)}
              />
            )}
            {showMacd && (
              <>
                <Metric
                  label="MACD"
                  value={indicators?.macd ?? null}
                  icon={<BarChart3 size={13} className="text-primary-400" />}
                  tone={macdTone(indicators?.macd ?? null)}
                />
                <Metric
                  label="MACD Гист."
                  value={indicators?.macdHistogram ?? null}
                  icon={<BarChart3 size={13} className="text-primary-400" />}
                  tone={macdTone(indicators?.macdHistogram ?? null)}
                />
              </>
            )}
          </div>
        </section>
      )}

      {/* ── Тренд: EMA fast + EMA slow ── */}
      {hasTrend && (
        <section>
          <GroupLabel>Тренд</GroupLabel>
          <div className="grid grid-cols-2 gap-2">
            <Metric
              label={`EMA ${config.emaFast}`}
              value={indicators?.emaFast ?? null}
              icon={<TrendingUp size={13} className="text-secondary-400" />}
            />
            <Metric
              label={`EMA ${config.emaSlow}`}
              value={indicators?.emaSlow ?? null}
              icon={<TrendingDown size={13} className="text-accent-400" />}
            />
          </div>
        </section>
      )}

      {/* ── Волатильность: ATR + Bollinger ── */}
      {hasVolatility && (
        <section>
          <GroupLabel>Волатильность</GroupLabel>
          <div className="grid grid-cols-2 gap-2">
            {showAtr && (
              <Metric
                label={`ATR ${config.atrPeriod}`}
                value={indicators?.atr ?? null}
                icon={<Activity size={13} className="text-base-300" />}
              />
            )}
            {showBb && (
              <>
                <Metric
                  label="BB Верх."
                  value={indicators?.bollingerUpper ?? null}
                  icon={<BarChart3 size={13} className="text-primary-400" />}
                />
                <Metric
                  label="BB Серед."
                  value={indicators?.bollingerMiddle ?? null}
                  icon={<BarChart3 size={13} className="text-base-300" />}
                />
                <Metric
                  label="BB Низ."
                  value={indicators?.bollingerLower ?? null}
                  icon={<BarChart3 size={13} className="text-primary-400" />}
                />
              </>
            )}
          </div>
        </section>
      )}

      {/* ── Объём / прокси-объём: VWAP, Volume POC, Impulse/ATR ── */}
      {hasVolume && (
        <section>
          <GroupLabel>Объём</GroupLabel>
          <div className="grid grid-cols-2 gap-2">
            {showVwap && (
              <Metric
                label={indicators?.vwapIsProxyVolume ? 'VWAP (прокси)' : 'VWAP'}
                value={indicators?.vwap ?? null}
                icon={<BarChart3 size={13} className="text-secondary-400" />}
              />
            )}
            {showVolumeProfile && (
              <Metric
                label={indicators?.volumeProfilePocIsProxyVolume ? 'Volume POC (прокси)' : 'Volume POC'}
                value={indicators?.volumeProfilePoc ?? null}
                icon={<BarChart3 size={13} className="text-accent-400" />}
              />
            )}
            {showImpulse && (
              <Metric
                label="Импульс/ATR"
                value={indicators?.impulseVelocity ?? null}
                icon={<Zap size={13} className="text-primary-400" />}
              />
            )}
          </div>
        </section>
      )}
    </div>
  );
}

function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <p className="mb-2 text-2xs font-bold uppercase tracking-wider text-base-500">
      {children}
    </p>
  );
}

function rsiTone(v: number | null): Tone {
  if (v === null) return 'neutral';
  if (v >= 70) return 'warning';
  if (v <= 30) return 'positive';
  return 'neutral';
}

function macdTone(v: number | null): Tone {
  if (v === null) return 'neutral';
  return v >= 0 ? 'positive' : 'negative';
}

interface MetricProps {
  label: string;
  value: number | null;
  icon: ReactNode;
  tone?: Tone;
}

function Metric({ label, value, icon, tone = 'neutral' }: MetricProps) {
  const toneColor: Record<Tone, string> = {
    neutral: 'text-base-100',
    positive: 'text-success-500',
    negative: 'text-error-500',
    warning: 'text-accent-400',
  };
  return (
    /* min-h-[64px] ensures every card is the same height regardless of value length */
    <div className="flex min-h-[64px] flex-col justify-between rounded-lg border border-base-800 bg-base-900 px-3 py-2.5 transition hover:border-base-700">
      {/* level 1 — card label */}
      <div className="flex items-center gap-1.5 text-2xs font-medium text-base-400">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      {/* level 2 — primary value */}
      <div className={clsx('font-mono text-sm font-semibold tabular-nums', toneColor[tone])}>
        {value !== null ? formatNum(value) : '—'}
      </div>
    </div>
  );
}

function formatNum(v: number): string {
  if (Math.abs(v) >= 1000) return v.toFixed(1);
  if (Math.abs(v) >= 1) return v.toFixed(3);
  return v.toFixed(5);
}

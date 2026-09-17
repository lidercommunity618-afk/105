import { ArrowUpCircle, ArrowDownCircle, Target, Shield, RefreshCw, Activity, Timer, TrendingUp, TrendingDown, ClipboardCopy, Check } from 'lucide-react';
import type { Signal, SignalStrength, SpreadSource } from '@/types/domain';
import { formatPrice, formatTime, formatDurationShort, clsx } from '@/lib/utils';
import { PATTERN_LABELS_RU } from '@/lib/pattern-categories';
import { useTradeReportExport } from '@/hooks/useTradeReportExport';

interface SignalCardProps {
  signal: Signal;
  pipSize: number;
  compact?: boolean;
  // Показ/скрытие стрелки этого сигнала на графике (см. JSDoc у
  // selectedChartSignalIds в useAnalyticsStore.ts). Передаётся только в
  // compact-режиме из SignalFeed.tsx (строка в ИСТОРИЯ СИГНАЛОВ) — активная
  // карточка (compact=false) кликом по стрелке не управляет.
  chartSelected?: boolean;
  onToggleChart?: () => void;
}

export function SignalCard({ signal, pipSize, compact = false, chartSelected = false, onToggleChart }: SignalCardProps) {
  const isBuy = signal.direction === 'buy';
  const sideColor = isBuy ? 'text-success-500' : 'text-error-500';
  const sideBg = isBuy ? 'bg-success-700/20 border-success-700/40' : 'bg-error-700/20 border-error-700/40';
  const Icon = isBuy ? ArrowUpCircle : ArrowDownCircle;
  const prob = signal.calibratedProbability;
  const probPct = prob !== null ? `${(prob * 100).toFixed(0)}%` : '—';

  // Экспорт постмортем-отчёта (см. lib/trade-report.ts) — доступен только
  // для завершённых сигналов (win/loss/timeout): смысл функции — разобрать
  // УЖЕ отработавшую сделку и выяснить, какой индикатор/паттерн/стратегию
  // стоит настроить, а не строить гипотезы по ещё не резолвнутому сигналу.
  // Логика копирования/скачивания вынесена в общий хук (см. его JSDoc) —
  // раньше была продублирована один-в-один с EntryPointPopup.tsx.
  const { copied, handleExport } = useTradeReportExport(signal);

  if (compact) {
    // Учитываем все три финальных исхода (win/loss/timeout), а не только
    // win/loss — иначе таймаут-сигнал в истории визуально ничем не
    // отличался от ещё pending-сигнала (тот же нейтральный фон, та же
    // буква-иконка направления вместо иконки исхода), хотя бейдж
    // (OutcomeBadge) при этом уже показывался. Именно это создавало
    // впечатление "сигналы и с пометкой, и без" в списке истории.
    const hasOutcome = signal.outcome === 'win' || signal.outcome === 'loss' || signal.outcome === 'timeout';
    // Аудит (ИСТОРИЯ СИГНАЛОВ === Последние сделки): сигналы без реально
    // открытой демо-сделки (tradeOpened === false) больше не доходят до
    // этого компонента — SignalFeed отфильтровывает их до рендера (см. его
    // комментарий), поэтому здесь достаточно обычной win/loss/timeout-
    // раскраски без отдельной "непроторгованной" ветки.
    const rowBg = !hasOutcome
      ? 'bg-base-950/40'
      : signal.outcome === 'win' ? 'bg-success-700/15' : signal.outcome === 'loss' ? 'bg-error-700/15' : 'bg-base-800/40';
    const rowBorder = !hasOutcome
      ? ''
      : signal.outcome === 'win' ? 'border-l-2 border-l-success-600' : signal.outcome === 'loss' ? 'border-l-2 border-l-error-600' : 'border-l-2 border-l-base-500';
    return (
      <button
        type="button"
        onClick={onToggleChart}
        title={chartSelected ? 'Скрыть стрелку на графике' : 'Показать стрелку на графике'}
        className={clsx(
          'flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left transition',
          rowBg,
          rowBorder,
          chartSelected && 'ring-1 ring-inset ring-secondary-400',
        )}
      >
        <div className="flex items-center gap-2">
          {hasOutcome ? (
            signal.outcome === 'win'
              ? <TrendingUp size={12} className="shrink-0 text-success-500" />
              : signal.outcome === 'loss'
                ? <TrendingDown size={12} className="shrink-0 text-error-500" />
                : <Timer size={12} className="shrink-0 text-base-400" />
          ) : (
            // BUGFIX (Фаза 5, "UI/UX и продуктовая честность" — переименование
            // терминологии под "прогноз направления"): было 'П'/'S' —
            // смешение русского сокращения "Покупка" с английским "Sell",
            // да и сама пара "купить/продать" неточна для бинарного опциона:
            // пользователь не покупает и не продаёт актив, он делает ставку
            // на направление цены к моменту экспирации. Стрелка однозначна
            // независимо от языка и не подразумевает открытие позиции.
            <span className={clsx('text-xs font-bold', isBuy ? 'text-success-500' : 'text-error-500')}>
              {isBuy ? '↑' : '↓'}
            </span>
          )}
          <span className="font-mono text-2xs text-base-200">
            {formatPrice(signal.entryPrice, pipSize)}
          </span>
          {signal.isRevised && <RefreshCw size={10} className="text-accent-400" />}
        </div>
        <div className="flex items-center gap-2">
          <StrengthBadge strength={signal.strength} />
          <OutcomeBadge outcome={signal.outcome} />
          <span className="text-2xs text-base-500">{formatTime(signal.time)}</span>
        </div>
      </button>
    );
  }

  return (
    <div className={clsx('rounded-xl border p-3.5 animate-slide-up', sideBg)}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon size={20} className={sideColor} />
          {/* BUGFIX (Фаза 5, "UI/UX и продуктовая честность"): было
              {signal.direction} — сырое значение enum ('buy'/'sell')
              рендерилось прямо пользователю на английском, да и сама пара
              "купить/продать" неточна для бинарного опциона (нет позиции,
              которую покупают или продают) — заменено на явный прогноз
              направления цены к экспирации. */}
          <span className={clsx('text-sm font-bold uppercase tracking-wide', sideColor)}>
            {isBuy ? 'Прогноз: вверх' : 'Прогноз: вниз'}
          </span>
          <StrengthBadge strength={signal.strength} />
          {signal.isRevised && (
            <span className="flex items-center gap-0.5 rounded bg-accent-700/30 px-1.5 py-0.5 text-2xs font-bold uppercase text-accent-400">
              <RefreshCw size={10} />
              Обновлён
            </span>
          )}
        </div>
        <span className="text-2xs text-base-400">{formatTime(signal.time)}</span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <LevelBox label="Вход" value={formatPrice(signal.entryPrice, pipSize)} />
        {/* BUGFIX (Фаза 1, "честный бинарный опцион"): Стоп/Цель убраны —
            бинарный опцион с фиксированной экспирацией и фиксированной
            выплатой не имеет структурного стопа/цели; выше показывались
            signal.stopLoss/signal.takeProfit, которых больше не
            существует в Signal вовсе (не просто скрыты). Вместо них —
            единственное, что реально определяет исход: экспирация. */}
        <LevelBox
          label="Экспирация"
          value={formatDurationShort(signal.recommendedExpiry)}
          tone="neutral"
        />
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-lg bg-base-950/50 px-2.5 py-1.5">
          <Activity size={12} className="text-secondary-400" />
          <span className="text-2xs text-base-400">Вероятн.</span>
          <span className="font-mono text-2xs font-semibold text-secondary-400">{probPct}</span>
          <CalibrationBadge source={signal.calibrationSource} />
        </div>
        {signal.spread !== null && (
          <div className="flex items-center gap-1 rounded-lg bg-base-950/50 px-2.5 py-1.5">
            <Target size={12} className="text-base-400" />
            <span className="text-2xs text-base-400">Спред</span>
            <span className="font-mono text-2xs font-semibold text-base-100">
              {formatPrice(signal.spread, pipSize)}
            </span>
            <SpreadBadge source={signal.spreadSource} />
          </div>
        )}
      </div>

      <div className="mt-2.5 flex items-center gap-1 rounded-lg bg-base-950/50 px-2.5 py-1.5">
        <Shield size={12} className="text-base-400" />
        <span className="text-2xs text-base-300">{signal.reason}</span>
        <span className="ml-auto shrink-0 font-mono text-2xs font-semibold text-base-400">score {signal.score.toFixed(1)}</span>
      </div>

      {signal.pattern && (
        <div className="mt-1.5 flex items-center gap-1 text-2xs text-secondary-400">
          <Target size={12} />
          Паттерн: {PATTERN_LABELS_RU[signal.pattern] ?? signal.pattern.replace(/-/g, ' ')}
        </div>
      )}

      {signal.isRevised && signal.revisionNote && (
        <div className="mt-1.5 flex items-center gap-1 text-2xs text-accent-400">
          <RefreshCw size={12} />
          {signal.revisionNote}
        </div>
      )}

      {signal.outcome !== 'pending' && (
        <button
          onClick={() => { void handleExport(); }}
          className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-lg bg-base-950/50 px-2.5 py-1.5 text-2xs font-semibold text-base-300 hover:bg-base-800/70"
        >
          {copied ? <Check size={12} className="text-success-400" /> : <ClipboardCopy size={12} />}
          {copied ? 'Скопировано' : 'Экспорт для анализа'}
        </button>
      )}
    </div>
  );
}

export function SpreadBadge({ source }: { source: SpreadSource | null }) {
  if (!source) return null;
  const isLive = source === 'live';
  return (
    <span className={clsx(
      'rounded px-1 py-0.5 text-2xs font-bold uppercase',
      isLive ? 'bg-success-700/20 text-success-400' : 'bg-base-700 text-base-400',
    )}>
      {isLive ? 'Лайв' : 'Оценка'}
    </span>
  );
}

// BUGFIX (аудит 2026-09-06, п.6 "калибровка выглядит как реальная"): до этого
// фикса calibrationSource==='fallback' помечался как "не откалибровано —
// сырая оценка по score, не win-rate" только в текстовом постмортем-отчёте
// (см. lib/trade-report.ts) — то есть уже ПОСЛЕ того, как сделка отыграла. В
// самом интерфейсе, в момент когда решение "входить или нет" ещё принимается,
// сигнал показывал голое число ("65%") неотличимое от вероятности, реально
// откалиброванной на исходах (calibrationSource==='model'). Бейдж делает то же
// предупреждение видимым в тот момент, когда оно может на что-то повлиять.
export function CalibrationBadge({ source }: { source: 'model' | 'fallback' | undefined }) {
  if (source !== 'fallback') return null;
  return (
    <span
      className="rounded bg-warning-700/25 px-1 py-0.5 text-2xs font-bold uppercase text-warning-400"
      title="calibratedProbability здесь — sigmoidFallback() по score, зажатый в [0.35, 0.65], а не вероятность, откалиброванная на реальных исходах"
    >
      Не откалибр.
    </span>
  );
}

export function StrengthBadge({ strength }: { strength: SignalStrength }) {
  const styles: Record<SignalStrength, string> = {
    weak: 'bg-base-700 text-base-300',
    moderate: 'bg-accent-700/30 text-accent-400',
    strong: 'bg-secondary-700/30 text-secondary-400',
  };
  return (
    <span className={clsx('rounded px-1.5 py-0.5 text-2xs font-bold uppercase', styles[strength])}>
      {strength === 'weak' ? 'Слабый' : strength === 'moderate' ? 'Средний' : 'Сильный'}
    </span>
  );
}

export function OutcomeBadge({ outcome }: { outcome: Signal['outcome'] }) {
  if (outcome === 'pending') return null;
  const styles: Record<string, string> = {
    win: 'bg-success-700/30 text-success-400',
    loss: 'bg-error-700/30 text-error-400',
    timeout: 'bg-base-700 text-base-400',
  };
  return (
    <span className={clsx('rounded px-1.5 py-0.5 text-2xs font-bold uppercase', styles[outcome])}>
      {outcome === 'win' ? 'Прибыль' : outcome === 'loss' ? 'Убыток' : 'Тайм-аут'}
    </span>
  );
}

function LevelBox({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'error' | 'success';
}) {
  const colors = {
    neutral: 'text-base-100',
    error: 'text-error-500',
    success: 'text-success-500',
  };
  return (
    <div className="rounded-lg bg-base-950/50 px-2 py-1.5">
      <div className="text-2xs text-base-500">{label}</div>
      <div className={clsx('font-mono text-xs font-semibold tabular-nums', colors[tone])}>{value}</div>
    </div>
  );
}



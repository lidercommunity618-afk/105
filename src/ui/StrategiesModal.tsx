import { X, Boxes, CandlestickChart } from 'lucide-react';
import { useSettingsStore, ALL_PATTERNS, ALL_INDICATOR_FEATURES } from '@/stores/settingsStore';
import { patternCategory, PATTERN_LABELS_RU } from '@/lib/pattern-categories';
import type { PatternName } from '@/types/domain';
import { clsx } from '@/lib/utils';
import type { ReactNode } from 'react';

interface StrategiesModalProps {
  onClose: () => void;
}

// Та же классификация, что и в боковой панели настроек (SettingsPanel.tsx) —
// единый источник истины src/lib/pattern-categories.ts, чтобы оба места
// управления паттернами/стратегиями (эта модалка из хедера и сайдбар
// настроек) визуально и логически различали классические свечные паттерны
// от комплексных многофакторных стратегий одинаково.
const CANDLE_PATTERN_LIST: readonly PatternName[] = ALL_PATTERNS.filter(
  (p) => patternCategory(p) === 'pattern',
);
const STRATEGY_PATTERN_LIST: readonly PatternName[] = ALL_PATTERNS.filter(
  (p) => patternCategory(p) === 'strategy',
);

export function StrategiesModal({ onClose }: StrategiesModalProps) {
  const activePatterns = useSettingsStore((s) => s.activePatterns);
  const setActivePatterns = useSettingsStore((s) => s.setActivePatterns);
  const activeIndicators = useSettingsStore((s) => s.activeIndicators);
  const setActiveIndicators = useSettingsStore((s) => s.setActiveIndicators);

  const togglePattern = (name: string) => {
    setActivePatterns(
      activePatterns.includes(name)
        ? activePatterns.filter((x) => x !== name)
        : [...activePatterns, name],
    );
  };

  const toggleIndicator = (name: string) => {
    setActiveIndicators(
      activeIndicators.includes(name)
        ? activeIndicators.filter((x) => x !== name)
        : [...activeIndicators, name],
    );
  };

  const toggleGroup = (group: readonly PatternName[], enable: boolean) => {
    if (enable) {
      const merged = new Set([...activePatterns, ...group]);
      setActivePatterns([...merged]);
    } else {
      setActivePatterns(activePatterns.filter((x) => !group.includes(x as PatternName)));
    }
  };

  const toggleAllIndicators = (enable: boolean) => {
    setActiveIndicators(enable ? [...ALL_INDICATOR_FEATURES] : []);
  };

  const allCandlePatternsOn = CANDLE_PATTERN_LIST.every((p) => activePatterns.includes(p));
  const allStrategyPatternsOn = STRATEGY_PATTERN_LIST.every((p) => activePatterns.includes(p));
  const allIndicatorsOn = ALL_INDICATOR_FEATURES.every((i) => activeIndicators.includes(i));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 animate-fade-in" onClick={onClose} />
      <div className="relative flex max-h-[85dvh] w-full max-w-lg flex-col rounded-2xl border border-base-800 bg-base-950 animate-slide-up">
        <div className="flex items-center justify-between border-b border-base-800 px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-bold text-base-100">
            <Boxes size={18} className="text-secondary-400" />
            Стратегии и индикаторы
          </h2>
          <button onClick={onClose} className="rounded-lg p-1 text-base-400 transition hover:bg-base-800 hover:text-base-100">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          <Group
            icon={<CandlestickChart size={14} className="text-secondary-400" />}
            title="Свечные паттерны"
            allOn={allCandlePatternsOn}
            onToggleAll={() => toggleGroup(CANDLE_PATTERN_LIST, !allCandlePatternsOn)}
            count={CANDLE_PATTERN_LIST.length}
            activeCount={CANDLE_PATTERN_LIST.filter((p) => activePatterns.includes(p)).length}
          >
            <div className="grid grid-cols-2 gap-1.5">
              {CANDLE_PATTERN_LIST.map((p) => (
                <ToggleRow
                  key={p}
                  label={PATTERN_LABELS_RU[p] ?? p.replace(/-/g, ' ')}
                  checked={activePatterns.includes(p)}
                  onToggle={() => togglePattern(p)}
                />
              ))}
            </div>
          </Group>

          <div className="mt-5">
            <Group
              icon={<Boxes size={14} className="text-accent-400" />}
              title="Стратегии"
              allOn={allStrategyPatternsOn}
              onToggleAll={() => toggleGroup(STRATEGY_PATTERN_LIST, !allStrategyPatternsOn)}
              count={STRATEGY_PATTERN_LIST.length}
              activeCount={STRATEGY_PATTERN_LIST.filter((p) => activePatterns.includes(p)).length}
            >
              <div className="grid grid-cols-2 gap-1.5">
                {STRATEGY_PATTERN_LIST.map((p) => (
                  <ToggleRow
                    key={p}
                    label={PATTERN_LABELS_RU[p] ?? p.replace(/-/g, ' ')}
                    checked={activePatterns.includes(p)}
                    onToggle={() => togglePattern(p)}
                  />
                ))}
              </div>
            </Group>
          </div>

          <div className="mt-5">
            <Group
              icon={<Boxes size={14} className="text-secondary-400" />}
              title="Индикаторы и инструменты"
              allOn={allIndicatorsOn}
              onToggleAll={() => toggleAllIndicators(!allIndicatorsOn)}
              count={ALL_INDICATOR_FEATURES.length}
              activeCount={activeIndicators.length}
            >
              <div className="grid grid-cols-2 gap-1.5">
                {ALL_INDICATOR_FEATURES.map((ind) => (
                  <ToggleRow
                    key={ind}
                    label={formatFeatureLabel(ind)}
                    checked={activeIndicators.includes(ind)}
                    onToggle={() => toggleIndicator(ind)}
                  />
                ))}
              </div>
            </Group>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatFeatureLabel(name: string): string {
  return name
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function Group({
  icon,
  title,
  allOn,
  onToggleAll,
  count,
  activeCount,
  children,
}: {
  icon: ReactNode;
  title: string;
  allOn: boolean;
  onToggleAll: () => void;
  count: number;
  activeCount: number;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {icon}
          <h3 className="text-2xs font-bold uppercase tracking-wider text-base-400">{title}</h3>
          <span className="text-2xs text-base-600">{activeCount}/{count}</span>
        </div>
        <button
          onClick={onToggleAll}
          className="text-2xs font-semibold text-secondary-400 transition hover:text-secondary-300"
        >
          {allOn ? 'Отключить все' : 'Включить все'}
        </button>
      </div>
      {children}
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  onToggle,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className={clsx(
        'flex items-center justify-between rounded-lg border px-3 py-2 text-left transition',
        checked ? 'border-secondary-700/50 bg-secondary-700/15' : 'border-base-800 bg-base-900',
      )}
    >
      <span className={clsx('text-xs font-medium capitalize', checked ? 'text-base-100' : 'text-base-400')}>
        {label}
      </span>
      <div
        className={clsx(
          'relative h-4 w-7 rounded-full transition',
          checked ? 'bg-secondary-600' : 'bg-base-700',
        )}
      >
        <span
          className="absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all"
          style={{ left: checked ? '0.875rem' : '0.125rem' }}
        />
      </div>
    </button>
  );
}

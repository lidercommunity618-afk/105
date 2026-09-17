import { useState, lazy, Suspense } from 'react';
import { X, Volume2, Key, Layers, Box, BarChart3, RotateCcw, LineChart, AlertTriangle, GraduationCap, Wallet, CandlestickChart, Boxes } from 'lucide-react';
import { useSettingsStore, ALL_PATTERNS, ALL_INDICATOR_FEATURES } from '@/stores/settingsStore';
import { useApiKeysStore } from '@/stores/useApiKeysStore';
import { useTickStore } from '@/stores/useTickStore';
import { useDemoAccountStore } from '@/stores/useDemoAccountStore';
import { useAnalyticsStore } from '@/stores/useAnalyticsStore';
import { martingaleFullCycleLossProbability, martingaleFullCycleLossAmount } from '@/lib/risk-of-ruin';
import { MIN_FACTOR_SAMPLES } from '@/ui/factor-analytics';
import { DERIV_DEFAULT_APP_ID } from '@/data/providers.config';
import { TIMEFRAMES, findSymbol } from '@/data/symbols';
import { clsx } from '@/lib/utils';
import { SIGNAL_COMPONENT_KEYS, DEFAULT_INDICATOR_CONFIG, type IndicatorConfig, type SignalComponentKey, type PatternName } from '@/types/domain';
import { patternCategory, PATTERN_LABELS_RU } from '@/lib/pattern-categories';
import { effectivePriorityThresholdForSymbol, hasPriorityThresholdOverride } from '@/lib/priority-threshold-overrides';
import type { ReactNode } from 'react';

const Education = lazy(() => import('@/ui/Education').then((m) => ({ default: m.Education })));

// Разделение ALL_PATTERNS на классические свечные паттерны и комплексные
// стратегии (см. src/lib/pattern-categories.ts — единственный источник
// истины для этой классификации, уже использующийся для русских подписей).
// Вычисляется один раз на модуле, а не при каждом рендере компонента.
const CANDLE_PATTERN_LIST: readonly PatternName[] = ALL_PATTERNS.filter(
  (p) => patternCategory(p) === 'pattern',
);
const STRATEGY_PATTERN_LIST: readonly PatternName[] = ALL_PATTERNS.filter(
  (p) => patternCategory(p) === 'strategy',
);

interface NumberField {
  key: keyof Omit<IndicatorConfig, 'sessionFilter'>;
  label: string;
  min: number;
  max: number;
  step?: number;
}

const FIELDS: NumberField[] = [
  { key: 'rsiPeriod', label: 'RSI период', min: 2, max: 50 },
  { key: 'emaFast', label: 'EMA быстрая', min: 2, max: 100 },
  { key: 'emaSlow', label: 'EMA медленная', min: 2, max: 200 },
  { key: 'macdFast', label: 'MACD быстрая', min: 2, max: 50 },
  { key: 'macdSlow', label: 'MACD медленная', min: 2, max: 100 },
  { key: 'macdSignal', label: 'MACD сигнальная', min: 2, max: 50 },
  { key: 'atrPeriod', label: 'ATR период', min: 2, max: 50 },
  { key: 'bbPeriod', label: 'Bollinger период', min: 5, max: 100 },
  { key: 'bbStdDev', label: 'Bollinger откл.', min: 0.5, max: 4, step: 0.1 },
];

// Задача 1.1 / Этап 2 / Задача 1.3 — прежде хардкодились как локальные
// константы (DEFAULT_SCORE_THRESHOLD=2, RSI_OVERSOLD=30/RSI_OVERBOUGHT=70)
// внутри signal-builder.ts и direction-prediction.ts. spreadGateMultiplier —
// новый порог, введённый вместе с pre-entry spread-gate.
const QUALITY_FIELDS: NumberField[] = [
  { key: 'scoreThreshold', label: 'Порог score сигнала', min: 0.5, max: 6, step: 0.5 },
  { key: 'rsiOversold', label: 'RSI перепродан <', min: 5, max: 50, step: 1 },
  { key: 'rsiOverbought', label: 'RSI перекуплен >', min: 50, max: 95, step: 1 },
  { key: 'spreadGateMultiplier', label: 'Спред-гейт × ATR', min: 1, max: 10, step: 0.5 },
];

// Модуль "Гармонические паттерны" (Gartley/Butterfly/AB=CD) — ручная
// конфигурация ZigZag/допусков, по той же схеме, что FIELDS/QUALITY_FIELDS
// выше (общий компонент слайдера NumberInput уже универсален).
const HARMONIC_FIELDS: NumberField[] = [
  { key: 'harmonicMinLegAtr', label: 'Мин. нога ZigZag × ATR', min: 0.5, max: 5, step: 0.1 },
  { key: 'harmonicFibTolerancePct', label: 'Допуск по Фибо, %', min: 1, max: 20, step: 1 },
  { key: 'harmonicHtfFactor', label: 'Ресэмплинг ZigZag ×', min: 2, max: 15, step: 1 },
];

// Задача 1.2 — те же 5 именованных сессий, что возвращает getSessionRegime()
// и что реально проверяет sessionFilter-гейт в signal-builder.ts.
const SESSION_FILTER_KEYS: readonly (keyof IndicatorConfig['sessionFilter'])[] = [
  'sydney', 'tokyo', 'london', 'newyork', 'overlap',
];
const SESSION_LABELS: Record<keyof IndicatorConfig['sessionFilter'], string> = {
  sydney: 'Сидней',
  tokyo: 'Токио',
  london: 'Лондон',
  newyork: 'Нью-Йорк',
  overlap: 'Overlap',
};

const API_KEYS: { key: 'derivAppId'; label: string; placeholder: string }[] = [
  { key: 'derivAppId', label: 'Deriv App ID', placeholder: '1089' },
];

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const indicators = useSettingsStore((s) => s.indicators);
  const setIndicators = useSettingsStore((s) => s.setIndicators);
  const sensitivity = useSettingsStore((s) => s.sensitivity);
  const setSensitivity = useSettingsStore((s) => s.setSensitivity);
  const apiKeys = useApiKeysStore((s) => s.keys);
  const setApiKey = useApiKeysStore((s) => s.setKey);
  const startTick = useTickStore((s) => s.start);
  const stopTick = useTickStore((s) => s.stop);
  const activeSymbolId = useTickStore((s) => s.activeSymbolId);
  const activeTimeframe = useTickStore((s) => s.activeTimeframe);

  const handleApiKeyChange = (key: 'derivAppId', value: string) => {
    setApiKey(key, value);
    if (key === 'derivAppId' && activeSymbolId && activeTimeframe) {
      stopTick();
      void startTick(activeSymbolId, activeTimeframe);
    }
  };
  const [showEducation, setShowEducation] = useState(false);
  const timeframe = useSettingsStore((s) => s.timeframe);
  const setTimeframe = useSettingsStore((s) => s.setTimeframe);
  const activePatterns = useSettingsStore((s) => s.activePatterns);
  const setActivePatterns = useSettingsStore((s) => s.setActivePatterns);
  const activeIndicators = useSettingsStore((s) => s.activeIndicators);
  const setActiveIndicators = useSettingsStore((s) => s.setActiveIndicators);
  const showBosLayer = useSettingsStore((s) => s.showBosLayer);
  const setShowBosLayer = useSettingsStore((s) => s.setShowBosLayer);
  const showOrderBlocks = useSettingsStore((s) => s.showOrderBlocks);
  const setShowOrderBlocks = useSettingsStore((s) => s.setShowOrderBlocks);
  const showImbalances = useSettingsStore((s) => s.showImbalances);
  const setShowImbalances = useSettingsStore((s) => s.setShowImbalances);
  const showSupportResistance = useSettingsStore((s) => s.showSupportResistance);
  const setShowSupportResistance = useSettingsStore((s) => s.setShowSupportResistance);
  const showEma20 = useSettingsStore((s) => s.showEma20);
  const setShowEma20 = useSettingsStore((s) => s.setShowEma20);
  const showEma50 = useSettingsStore((s) => s.showEma50);
  const setShowEma50 = useSettingsStore((s) => s.setShowEma50);
  const showEma200 = useSettingsStore((s) => s.showEma200);
  const setShowEma200 = useSettingsStore((s) => s.setShowEma200);
  const showBollinger = useSettingsStore((s) => s.showBollinger);
  const setShowBollinger = useSettingsStore((s) => s.setShowBollinger);
  const showMacd = useSettingsStore((s) => s.showMacd);
  const setShowMacd = useSettingsStore((s) => s.setShowMacd);
  const showRejectionBlocks = useSettingsStore((s) => s.showRejectionBlocks);
  const setShowRejectionBlocks = useSettingsStore((s) => s.setShowRejectionBlocks);
  const showHarmonicPatterns = useSettingsStore((s) => s.showHarmonicPatterns);
  const setShowHarmonicPatterns = useSettingsStore((s) => s.setShowHarmonicPatterns);
  const showEntryPoints = useSettingsStore((s) => s.showEntryPoints);
  const setShowEntryPoints = useSettingsStore((s) => s.setShowEntryPoints);
  const priorityThreshold = useSettingsStore((s) => s.priorityThreshold);
  const symbolIdForThreshold = useSettingsStore((s) => s.symbolId);
  const setPriorityThreshold = useSettingsStore((s) => s.setPriorityThreshold);
  const setOnboardingCompleted = useSettingsStore((s) => s.setOnboardingCompleted);
  const signalToggles = useSettingsStore((s) => s.signalToggles);
  const setSignalToggle = useSettingsStore((s) => s.setSignalToggle);
  const setAllSignalToggles = useSettingsStore((s) => s.setAllSignalToggles);

  const demoBalance = useDemoAccountStore((s) => s.balance);
  const setDemoBalanceAction = useDemoAccountStore((s) => s.setBalance);
  const demoStage0Amount = useDemoAccountStore((s) => s.stage0Amount);
  const setStage0AmountAction = useDemoAccountStore((s) => s.setStage0Amount);
  const demoStageAmounts = useDemoAccountStore((s) => s.stageAmounts);
  const setStageAmountAction = useDemoAccountStore((s) => s.setStageAmount);
  const demoProfitPercent = useDemoAccountStore((s) => s.profitPercent);
  const setDemoProfitPercentAction = useDemoAccountStore((s) => s.setProfitPercent);
  const demoAutoTrade = useDemoAccountStore((s) => s.autoTradeEnabled);
  const setDemoAutoTradeAction = useDemoAccountStore((s) => s.setAutoTradeEnabled);
  const demoMartingaleEnabled = useDemoAccountStore((s) => s.martingaleEnabled);
  // СЛИЯНИЕ (2026-09-16, Фаза 5 промта — risk-of-ruin аудит мартингейла на
  // ЭМПИРИЧЕСКОЙ, а не предполагаемой, точности): winRate/liveCompletedCount
  // берутся из уже накопленной live-статистики резолвнутых демо-сделок
  // (см. useAnalyticsStore.recomputeStats) — та же самая цифра, что показана
  // в StatusBar.tsx, не отдельно придуманное число.
  const liveWinRate = useAnalyticsStore((s) => s.winRate);
  const liveCompletedCount = useAnalyticsStore((s) => s.liveCompletedCount);
  const setDemoMartingaleEnabledAction = useDemoAccountStore((s) => s.setMartingaleEnabled);
  const keepScreenAwake = useSettingsStore((s) => s.keepScreenAwake);
  const setKeepScreenAwake = useSettingsStore((s) => s.setKeepScreenAwake);
  const resetAccount = useDemoAccountStore((s) => s.resetAccount);

  const setDemoBalance = (v: number) => setDemoBalanceAction(v);
  const setDemoProfitPercent = (v: number) => setDemoProfitPercentAction(v);
  const setDemoAutoTrade = (v: boolean) => setDemoAutoTradeAction(v);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/60 animate-fade-in" onClick={onClose} />
      <div className="relative flex h-full w-full max-w-sm flex-col border-l border-base-800 bg-base-950 animate-slide-up">
        <div className="flex items-center justify-between border-b border-base-800 px-4 py-3">
          <h2 className="text-sm font-bold text-base-100">Настройки</h2>
          <button onClick={onClose} className="rounded-lg p-1 text-base-400 transition hover:bg-base-800 hover:text-base-100">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          <Section title="Индикаторы">
            <div className="grid grid-cols-2 gap-2">
              {FIELDS.map((f) => (
                <NumberInput
                  key={f.key}
                  label={f.label}
                  value={indicators[f.key]}
                  min={f.min}
                  max={f.max}
                  step={f.step ?? 1}
                  onChange={(v) => setIndicators({ [f.key]: v })}
                />
              ))}
            </div>
          </Section>

          <Section title="Качество сигнала">
            <p className="mb-2 text-2xs text-base-500">
              Пороги, которые определяют, строится ли сигнал вообще —
              отдельно от периодов индикаторов выше. Порог score ниже ~3
              практически ничего не фильтрует (см. аудит 2026-09-06) —
              значение по умолчанию поднято до 4.
            </p>
            <div className="grid grid-cols-2 gap-2">
              {QUALITY_FIELDS.map((f) => (
                <NumberInput
                  key={f.key}
                  label={f.label}
                  value={indicators[f.key]}
                  min={f.min}
                  max={f.max}
                  step={f.step ?? 1}
                  onChange={(v) => setIndicators({ [f.key]: v })}
                />
              ))}
            </div>
            <div className="mt-2 flex gap-1.5">
              <button
                onClick={() => setIndicators({ rsiOversold: 30, rsiOverbought: 70 })}
                className={clsx(
                  'flex-1 rounded-lg px-2 py-1.5 text-2xs font-medium transition',
                  indicators.rsiOversold === 30 && indicators.rsiOverbought === 70
                    ? 'bg-secondary-600 text-white'
                    : 'bg-base-800 text-base-300 hover:text-base-100',
                )}
              >
                RSI 30/70 (по умолчанию)
              </button>
              <button
                onClick={() => setIndicators({ rsiOversold: 20, rsiOverbought: 80 })}
                className={clsx(
                  'flex-1 rounded-lg px-2 py-1.5 text-2xs font-medium transition',
                  indicators.rsiOversold === 20 && indicators.rsiOverbought === 80
                    ? 'bg-secondary-600 text-white'
                    : 'bg-base-800 text-base-300 hover:text-base-100',
                )}
              >
                Aggressive 20/80
              </button>
            </div>
            <p className="mt-2 text-2xs text-base-500">
              Торговые сессии (UTC), в которых разрешено строить сигналы:
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {SESSION_FILTER_KEYS.map((key) => (
                <Chip
                  key={key}
                  label={SESSION_LABELS[key]}
                  active={indicators.sessionFilter[key]}
                  onToggle={() => setIndicators({ sessionFilter: { ...indicators.sessionFilter, [key]: !indicators.sessionFilter[key] } })}
                />
              ))}
            </div>
            <button
              onClick={() => setIndicators({ ...DEFAULT_INDICATOR_CONFIG })}
              className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg bg-base-800 px-2 py-1.5 text-2xs font-medium text-base-300 transition hover:text-base-100"
            >
              <RotateCcw size={12} />
              Сбросить индикаторы и пороги к дефолту
            </button>
          </Section>

          <Section title="Гармонические паттерны">
            <p className="mb-2 text-2xs text-base-500">
              Ручная настройка ZigZag/допусков для детектора Gartley/Butterfly/AB=CD
              (см. вкладку "Слои графика" ниже для включения отображения).
            </p>
            <div className="grid grid-cols-2 gap-2">
              {HARMONIC_FIELDS.map((f) => (
                <NumberInput
                  key={f.key}
                  label={f.label}
                  value={indicators[f.key]}
                  min={f.min}
                  max={f.max}
                  step={f.step ?? 1}
                  onChange={(v) => setIndicators({ [f.key]: v })}
                />
              ))}
            </div>
          </Section>

          <Section title="Активные индикаторы">
            <div className="flex flex-wrap gap-1.5">
              {ALL_INDICATOR_FEATURES.map((ind: string) => (
                <Chip
                  key={ind}
                  label={ind.toUpperCase()}
                  active={activeIndicators.includes(ind)}
                  onToggle={() =>
                    setActiveIndicators(
                      activeIndicators.includes(ind)
                        ? activeIndicators.filter((x) => x !== ind)
                        : [...activeIndicators, ind],
                    )
                  }
                />
              ))}
            </div>
          </Section>

          <PatternGroupSection
            icon={<CandlestickChart size={14} className="text-secondary-400" />}
            title="Свечные паттерны"
            accent="secondary"
            patterns={CANDLE_PATTERN_LIST}
            activePatterns={activePatterns}
            setActivePatterns={setActivePatterns}
          />

          <PatternGroupSection
            icon={<Boxes size={14} className="text-accent-400" />}
            title="Стратегии"
            accent="accent"
            patterns={STRATEGY_PATTERN_LIST}
            activePatterns={activePatterns}
            setActivePatterns={setActivePatterns}
          />

          <Section title="Компоненты сигнала">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-2xs text-base-500">Отключённые элементы не влияют на результат</span>
              <button onClick={() => setAllSignalToggles(!SIGNAL_COMPONENT_KEYS.every((key) => signalToggles[key]))} className="text-2xs font-semibold text-secondary-400 hover:text-secondary-300">
                {SIGNAL_COMPONENT_KEYS.every((key) => signalToggles[key]) ? 'Отключить все' : 'Включить все'}
              </button>
            </div>
            <div className="flex flex-col gap-2">
              {SIGNAL_COMPONENT_KEYS.map((key) => (
                <div key={key} className="flex items-center justify-between rounded-lg bg-base-900 px-3 py-2">
                  <span className="text-xs text-base-200">{SIGNAL_COMPONENT_LABELS[key]}</span>
                  <Toggle on={signalToggles[key]} onToggle={() => setSignalToggle(key, !signalToggles[key])} />
                </div>
              ))}
            </div>
          </Section>

          <Section title="Сигнальный движок">
            <div className="mt-2 flex items-center justify-between rounded-lg bg-base-900 px-3 py-2">
              <div className="flex items-center gap-2 text-xs text-base-200">
                <Layers size={14} className="text-secondary-400" />
                <span>Слой BOS</span>
              </div>
              <Toggle on={showBosLayer} onToggle={() => setShowBosLayer(!showBosLayer)} />
            </div>
            <div className="mt-2 flex items-center justify-between rounded-lg bg-base-900 px-3 py-2">
              <div className="flex items-center gap-2 text-xs text-base-200">
                <Box size={14} className="text-success-400" />
                <span>Ордер-блоки</span>
              </div>
              <Toggle on={showOrderBlocks} onToggle={() => setShowOrderBlocks(!showOrderBlocks)} />
            </div>
            <p className="mb-2 mt-1 px-1 text-2xs text-base-500">
              Визуальный слой (Smart Money OB) — отдельная реализация от
              order-block-strength.ts, которая двигает score сигнала
              (компонент «Зоны» и OB-confirmation). Зоны на графике и то,
              что учитывается в score, могут не совпадать 1:1.
            </p>
            <div className="mt-2 flex items-center justify-between rounded-lg bg-base-900 px-3 py-2">
              <div className="flex items-center gap-2 text-xs text-base-200">
                <BarChart3 size={14} className="text-secondary-400" />
                <span>Имбалансы (FVG)</span>
              </div>
              <Toggle on={showImbalances} onToggle={() => setShowImbalances(!showImbalances)} />
            </div>
            <div className="mt-2 flex items-center justify-between rounded-lg bg-base-900 px-3 py-2">
              <div className="flex items-center gap-2 text-xs text-base-200">
                <LineChart size={14} className="text-primary-400" />
                <span>Поддержка / Сопротивление</span>
              </div>
              <Toggle on={showSupportResistance} onToggle={() => setShowSupportResistance(!showSupportResistance)} />
            </div>
          </Section>

          <Section title="Слои графика">
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between rounded-lg bg-base-900 px-3 py-2">
                <div className="flex items-center gap-2 text-xs text-base-200">
                  <span className="h-2 w-2 rounded-sm bg-amber-500" />
                  <span>EMA 20</span>
                </div>
                <Toggle on={showEma20} onToggle={() => setShowEma20(!showEma20)} />
              </div>
              <div className="flex items-center justify-between rounded-lg bg-base-900 px-3 py-2">
                <div className="flex items-center gap-2 text-xs text-base-200">
                  <span className="h-2 w-2 rounded-sm bg-blue-500" />
                  <span>EMA 50</span>
                </div>
                <Toggle on={showEma50} onToggle={() => setShowEma50(!showEma50)} />
              </div>
              <div className="flex items-center justify-between rounded-lg bg-base-900 px-3 py-2">
                <div className="flex items-center gap-2 text-xs text-base-200">
                  <span className="h-2 w-2 rounded-sm bg-purple-500" />
                  <span>EMA 200</span>
                </div>
                <Toggle on={showEma200} onToggle={() => setShowEma200(!showEma200)} />
              </div>
              <div className="flex items-center justify-between rounded-lg bg-base-900 px-3 py-2">
                <div className="flex items-center gap-2 text-xs text-base-200">
                  <BarChart3 size={14} className="text-blue-400" />
                  <span>Bollinger Bands</span>
                </div>
                <Toggle on={showBollinger} onToggle={() => setShowBollinger(!showBollinger)} />
              </div>
              <div className="flex items-center justify-between rounded-lg bg-base-900 px-3 py-2">
                <div className="flex items-center gap-2 text-xs text-base-200">
                  <BarChart3 size={14} className="text-success-400" />
                  <span>MACD</span>
                </div>
                <Toggle on={showMacd} onToggle={() => setShowMacd(!showMacd)} />
              </div>
              <div className="flex items-center justify-between rounded-lg bg-base-900 px-3 py-2">
                <div className="flex items-center gap-2 text-xs text-base-200">
                  <Box size={14} className="text-teal-400" />
                  <span>Rejection Blocks</span>
                </div>
                <Toggle on={showRejectionBlocks} onToggle={() => setShowRejectionBlocks(!showRejectionBlocks)} />
              </div>
              <div className="flex items-center justify-between rounded-lg bg-base-900 px-3 py-2">
                <div className="flex items-center gap-2 text-xs text-base-200">
                  <Boxes size={14} className="text-accent-400" />
                  <span>Гармонические паттерны</span>
                </div>
                <Toggle on={showHarmonicPatterns} onToggle={() => setShowHarmonicPatterns(!showHarmonicPatterns)} />
              </div>
              <div className="flex items-center justify-between rounded-lg bg-base-900 px-3 py-2">
                <div className="flex items-center gap-2 text-xs text-base-200">
                  <CandlestickChart size={14} className="text-success-400" />
                  <span>Точки входа в позицию</span>
                </div>
                <Toggle on={showEntryPoints} onToggle={() => setShowEntryPoints(!showEntryPoints)} />
              </div>
            </div>
          </Section>

          <Section title="Звуковые уведомления">
            <div className="flex items-start gap-2 rounded-lg bg-base-900 px-3 py-2 text-xs text-base-300">
              <Volume2 size={14} className="mt-0.5 shrink-0 text-secondary-400" />
              <span>
                Звук и приоритетный баннер воспроизводятся автоматически для
                каждого сигнала, прошедшего порог приоритета (настройка ниже).
                Отключить их нельзя — это гарантирует, что вы не пропустите
                ни один сигнал.
              </span>
            </div>
          </Section>

          <Section title="Чувствительность">
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setSensitivity('soft')}
                className={clsx(
                  'rounded-lg px-3 py-2.5 text-xs font-semibold transition',
                  sensitivity === 'soft' ? 'bg-secondary-600 text-white' : 'bg-base-800 text-base-300 hover:text-base-100',
                )}
              >
                Мягкая
              </button>
              <button
                onClick={() => setSensitivity('strict')}
                className={clsx(
                  'rounded-lg px-3 py-2.5 text-xs font-semibold transition',
                  sensitivity === 'strict' ? 'bg-secondary-600 text-white' : 'bg-base-800 text-base-300 hover:text-base-100',
                )}
              >
                Строгая
              </button>
            </div>
            <p className="mt-2 text-2xs text-base-500">
              {sensitivity === 'soft'
                ? 'Больше сигналов, ниже порог уверенности.'
                : 'Меньше сигналов, только высокоуверенные сетапы.'}
            </p>
          </Section>

          <Section title="Подключение">
            <p className="mb-2 text-2xs text-base-500">
              API-ключи для Gemini, TwelveData и Finnhub теперь хранятся на сервере и не требуются на клиенте.
            </p>
            <div className="flex flex-col gap-2">
              {API_KEYS.map((k) => (
                <div key={k.key} className="flex flex-col gap-0.5">
                  <KeyInput
                    label={k.label}
                    placeholder={k.placeholder}
                    value={apiKeys[k.key]}
                    onChange={(v) => handleApiKeyChange(k.key, v)}
                  />
                  {k.key === 'derivAppId' && apiKeys.derivAppId === DERIV_DEFAULT_APP_ID && (
                    <div className="mt-1 flex flex-col gap-1 rounded-md bg-warning-700/20 px-2 py-1.5 text-2xs text-warning-400">
                      <div className="flex items-center gap-1">
                        <AlertTriangle size={10} />
                        Используется публичный демо App ID — возможны разрывы соединения и ограничения скорости.
                      </div>
                      <span className="text-base-500">
                        Зарегистрируйте свой App ID на api.deriv.com/dashboard и введите его здесь — это снизит частоту разрывов соединения.
                      </span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Section>

          <Section title="Приоритетные уведомления">
            <p className="mb-2 text-2xs text-base-500">
              Сигналы создаются только при уверенности не ниже этого порога — независимо от их силы (weak/moderate/strong). Каждый созданный сигнал всегда сопровождается приоритетным баннером и звуком. Пока модель калибровки не обучена (первые ~100 сделок после старта или после ежедневной автоочистки), реальной оценки уверенности ещё нет — на это время порог не действует, чтобы приложению было на чём обучиться.
            </p>
            <NumberInput
              label="Порог приоритета"
              value={priorityThreshold}
              min={0.5}
              max={0.95}
              step={0.05}
              onChange={setPriorityThreshold}
            />
            <p className="mt-1 text-2xs font-mono text-base-400">
              Текущий: {(priorityThreshold * 100).toFixed(0)}%
            </p>
            {hasPriorityThresholdOverride(symbolIdForThreshold) && (
              // Этап 4 плана калибровки: этот слайдер редактирует только
              // ОБЩИЙ дефолт priorityThreshold — если для текущего
              // инструмента уже применён per-symbol override (см.
              // "ПОРОГ ВХОДА (ЧАСТОТА)" в CalibrationPanel.tsx), движение
              // этого слайдера не меняет его поведение. Без этой строки
              // это выглядело бы как баг — у надёжности паттернов такой
              // неоднозначности нет (там нет отдельного глобального
              // слайдера в Settings), а у priorityThreshold есть оба UI
              // для одного значения одновременно.
              <p className="mt-1 text-2xs text-secondary-400">
                Переопределено для {findSymbol(symbolIdForThreshold)?.displayName ?? symbolIdForThreshold}:{' '}
                {(effectivePriorityThresholdForSymbol(symbolIdForThreshold, priorityThreshold) * 100).toFixed(0)}%
              </p>
            )}
          </Section>

          <Section title="Таймфрейм по умолчанию">
            <div className="flex flex-wrap gap-1.5">
              {TIMEFRAMES.map((tf) => (
                <button
                  key={tf}
                  onClick={() => setTimeframe(tf)}
                  className={clsx(
                    'rounded-md px-2.5 py-1 text-xs font-semibold transition',
                    tf === timeframe ? 'bg-primary-600 text-white' : 'bg-base-800 text-base-300 hover:text-base-100',
                  )}
                >
                  {tf}
                </button>
              ))}
            </div>
          </Section>

          <Section title="Демо-счёт">
            <div className="flex flex-col gap-3 rounded-lg border border-base-800 bg-base-900 p-3">
              <div className="flex items-center gap-2">
                <Wallet size={14} className="text-secondary-400" />
                <span className="text-2xs font-bold uppercase tracking-wider text-base-400">Виртуальный счёт для оценки сигналов</span>
              </div>
              <p className="text-2xs text-base-500">
                Стадии 0–3 — фиксированные суммы ставки в $ (не зависят друг от друга). Мартингейл ведётся отдельно по каждому инструменту (символ + таймфрейм).
              </p>
              <NumberInput
                label="Баланс ($)"
                value={demoBalance}
                min={0}
                max={100000}
                step={10}
                onChange={(v) => setDemoBalance(v)}
              />
              <NumberInput
                label="Стадия 0 ($)"
                value={demoStage0Amount}
                min={1}
                max={1000}
                step={1}
                onChange={(v) => setStage0AmountAction(v)}
              />
              <div className="flex items-center justify-between">
                <span className="text-2xs text-base-400">Система мартингейла</span>
                <Toggle
                  on={demoMartingaleEnabled}
                  onToggle={() => setDemoMartingaleEnabledAction(!demoMartingaleEnabled)}
                />
              </div>
              <p className="-mt-2 text-2xs leading-snug text-base-500">
                {demoMartingaleEnabled
                  ? 'Включено: после убытка ставка на инструмент повышается по стадиям 1–3 (см. ниже). После выигрыша стадия сбрасывается на 0. Дополнительно: движок генерирует только "сильные" сигналы — "средние" и "слабые" не выдаются, пока мартингейл включён.'
                  : 'Выключено: каждая убыточная сделка закрывается в минус ставки, но ставка на следующую сделку не повышается — остаётся равной "Стадия 0". Стадии 1–3 ниже не используются. Генерируются сигналы всех уровней силы: "сильные", "средние" и "слабые".'}
              </p>
              <div className={clsx(!demoMartingaleEnabled && 'opacity-40')}>
                <NumberInput
                  label="Стадия 1 ($)"
                  value={demoStageAmounts[0]}
                  min={0}
                  max={100000}
                  step={1}
                  disabled={!demoMartingaleEnabled}
                  onChange={(v) => setStageAmountAction(1, v)}
                />
              </div>
              <div className={clsx(!demoMartingaleEnabled && 'opacity-40')}>
                <NumberInput
                  label="Стадия 2 ($)"
                  value={demoStageAmounts[1]}
                  min={0}
                  max={100000}
                  step={1}
                  disabled={!demoMartingaleEnabled}
                  onChange={(v) => setStageAmountAction(2, v)}
                />
              </div>
              <div className={clsx(!demoMartingaleEnabled && 'opacity-40')}>
                <NumberInput
                  label="Стадия 3 ($)"
                  value={demoStageAmounts[2]}
                  min={0}
                  max={100000}
                  step={1}
                  disabled={!demoMartingaleEnabled}
                  onChange={(v) => setStageAmountAction(3, v)}
                />
              </div>
              {demoMartingaleEnabled && (
                <div className="rounded-lg border border-warning-700/40 bg-warning-700/10 px-2.5 py-2 text-2xs">
                  <div className="mb-1 flex items-center gap-1.5 font-semibold text-warning-400">
                    <AlertTriangle size={12} />
                    Риск полного цикла мартингейла
                  </div>
                  {liveCompletedCount < MIN_FACTOR_SAMPLES || liveWinRate === null ? (
                    <p className="leading-snug text-base-500">
                      Недостаточно резолвнутых сделок ({liveCompletedCount} из {MIN_FACTOR_SAMPLES}) для
                      расчёта на эмпирической точности — оценка риска появится здесь после накопления
                      статистики. Не показываем предполагаемое число вместо измеренного.
                    </p>
                  ) : (
                    (() => {
                      const cycleLossProbability = martingaleFullCycleLossProbability(liveWinRate);
                      const cycleLossAmount = martingaleFullCycleLossAmount(demoStage0Amount, demoStageAmounts);
                      return (
                        <p className="leading-snug text-base-500">
                          При текущей измеренной точности ({(liveWinRate * 100).toFixed(1)}% по{' '}
                          {liveCompletedCount} резолвнутым сделкам) вероятность проиграть все 4 ставки
                          подряд (стадии 0→1→2→3, суммарно ${cycleLossAmount.toFixed(0)}) — примерно{' '}
                          <span className="font-mono font-bold text-warning-400">
                            {(cycleLossProbability * 100).toFixed(2)}%
                          </span>{' '}
                          на каждый такой цикл. Это не гипотетическая цифра из рекламы — она пересчитывается
                          по факту ваших сделок и меняется вместе с реальной точностью сигналов.
                        </p>
                      );
                    })()
                  )}
                </div>
              )}
              <NumberInput
                label="Процент прибыли (%)"
                value={demoProfitPercent}
                min={1}
                max={100}
                step={1}
                onChange={(v) => setDemoProfitPercent(v)}
              />
              <div className="flex items-center justify-between">
                <span className="text-2xs text-base-400">Автооткрытие сделок</span>
                <Toggle on={demoAutoTrade} onToggle={() => setDemoAutoTrade(!demoAutoTrade)} />
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-2xs text-base-400">
                  Не выключать экран во время автоторговли
                </span>
                <Toggle on={keepScreenAwake} onToggle={() => setKeepScreenAwake(!keepScreenAwake)} />
              </div>
              <p className="-mt-2 text-2xs leading-snug text-base-500">
                Пока автоторговля активна и вкладка открыта, экран не будет гаснуть по
                таймауту. Полная работа при заблокированном/выключенном экране устройства
                браузером не поддерживается ни для одного сайта — это ограничение ОС, а
                не терминала.
              </p>
              <button
                onClick={() => {
                  if (window.confirm('Сбросить демо-счёт? Баланс вернётся к $1000, история будет очищена.')) {
                    resetAccount();
                  }
                }}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-error-700/50 bg-error-700/15 px-3 py-2 text-xs font-semibold text-error-400 transition hover:bg-error-700/25"
              >
                <RotateCcw size={14} />
                Сбросить демо-счёт
              </button>
            </div>
          </Section>

          <Section title="Обучение">
            <button
              onClick={() => setShowEducation(true)}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-base-800 bg-base-900 px-3 py-2.5 text-xs font-semibold text-base-200 transition hover:bg-base-800"
            >
              <GraduationCap size={14} className="text-secondary-400" />
              Учебный курс
            </button>
          </Section>

          <Section title="Введение и сброс">
            <button
              onClick={() => {
                setOnboardingCompleted(false);
                onClose();
              }}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-base-800 bg-base-900 px-3 py-2.5 text-xs font-semibold text-base-200 transition hover:bg-base-800"
            >
              <RotateCcw size={14} className="text-secondary-400" />
              Показать введение снова
            </button>
          </Section>
        </div>
      </div>
      {showEducation && (
        <Suspense fallback={null}>
          <Education onClose={() => setShowEducation(false)} />
        </Suspense>
      )}
    </div>
  );
}

const SIGNAL_COMPONENT_LABELS: Record<SignalComponentKey, string> = {
  structure: 'Структура рынка',
  zones: 'Ордер-блоки и зоны',
  liquidity: 'Ликвидность и FVG',
  trigger: 'Свечные паттерны',
  indicator: 'Индикаторы',
  bos: 'BOS',
  macd: 'MACD',
  // Пометка "(инфо, см. Стратегии)": этот тумблер не влияет на счёт сигнала
  // напрямую — он лишь показывает/скрывает информационную заметку о касании
  // Bollinger в истории причин; сама торгуемая стратегия возврата к среднему
  // (RSI+BB+ADX+HTF-BOS confluence) включается/выключается паттерном
  // "Mean Reversion" в секции «Стратегии» выше (см. BUGFIX-комментарий у
  // hasEnabledSource в signal-builder.ts/engine.ts).
  meanReversion: 'Mean reversion (инфо, см. Стратегии)',
  contextPenalty: 'Штраф за сигнал в диапазоне',
  obConfirmation: 'Подтверждение ордер-блоком',
  fvgConfirmation: 'Подтверждение FVG',
  bosConfirmation: 'Подтверждение BOS',
  chochWarning: 'Предупреждение CHoCH',
  invalidation: 'Инвалидация сигнала',
  regimeGate: 'Фильтр слабого тренда (ADX/режим)',
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-5">
      <h3 className="mb-2 text-2xs font-bold uppercase tracking-wider text-base-400">{title}</h3>
      {children}
    </div>
  );
}

// Задача 2/3 (боковая панель настроек): свечные паттерны и стратегии — два
// визуально различимых блока (свой акцентный цвет + иконка + счётчик +
// групповой "включить/отключить все") вместо одного плоского списка чипов,
// в котором классические свечные паттерны (hammer, doji, engulfing...) были
// неотличимы от комплексных многофакторных стратегий (fvg-return,
// order-block-continuation, liquidity-sweep...). Оба блока пишут в один и
// тот же activePatterns — классификация только визуальная/группирующая, не
// меняет модель данных.
function PatternGroupSection({
  icon,
  title,
  accent,
  patterns,
  activePatterns,
  setActivePatterns,
}: {
  icon: ReactNode;
  title: string;
  accent: 'secondary' | 'accent';
  patterns: readonly PatternName[];
  activePatterns: string[];
  setActivePatterns: (patterns: string[]) => void;
}) {
  const activeCount = patterns.filter((p) => activePatterns.includes(p)).length;
  const allOn = patterns.length > 0 && activeCount === patterns.length;

  const toggleOne = (p: PatternName) => {
    setActivePatterns(
      activePatterns.includes(p)
        ? activePatterns.filter((x) => x !== p)
        : [...activePatterns, p],
    );
  };

  const toggleAll = () => {
    if (allOn) {
      setActivePatterns(activePatterns.filter((x) => !patterns.includes(x as PatternName)));
    } else {
      const merged = new Set([...activePatterns, ...patterns]);
      setActivePatterns([...merged]);
    }
  };

  const borderTone = accent === 'accent' ? 'border-accent-700/30' : 'border-secondary-700/30';
  const chipActiveTone = accent === 'accent'
    ? 'bg-accent-700/25 text-accent-400'
    : 'bg-secondary-700/40 text-secondary-400';

  return (
    <div className={clsx('mb-5 rounded-xl border bg-base-900/40 p-3', borderTone)}>
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {icon}
          <h3 className="text-2xs font-bold uppercase tracking-wider text-base-300">{title}</h3>
          <span className="text-2xs text-base-600">{activeCount}/{patterns.length}</span>
        </div>
        <button
          onClick={toggleAll}
          className="text-2xs font-semibold text-secondary-400 transition hover:text-secondary-300"
        >
          {allOn ? 'Отключить все' : 'Включить все'}
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {patterns.map((p) => (
          <button
            key={p}
            onClick={() => toggleOne(p)}
            className={clsx(
              'rounded-md px-2.5 py-1 text-xs font-semibold capitalize transition',
              activePatterns.includes(p) ? chipActiveTone : 'bg-base-800 text-base-400 hover:text-base-200',
            )}
          >
            {PATTERN_LABELS_RU[p] ?? p.replace(/-/g, ' ')}
          </button>
        ))}
      </div>
    </div>
  );
}

function NumberInput({
  label,
  value,
  min,
  max,
  step,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-2xs text-base-400">{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (!Number.isNaN(v)) onChange(v);
        }}
        className="rounded-md border border-base-800 bg-base-900 px-2 py-1.5 font-mono text-xs text-base-100 outline-none transition focus:border-secondary-600 disabled:cursor-not-allowed"
      />
    </label>
  );
}

function KeyInput({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="flex items-center gap-1 text-2xs text-base-400">
        <Key size={10} />
        {label}
      </span>
      <input
        type="password"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-base-800 bg-base-900 px-2 py-1.5 text-xs text-base-100 outline-none transition focus:border-secondary-600"
      />
    </label>
  );
}

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className={clsx(
        'relative h-5 w-9 rounded-full transition',
        on ? 'bg-secondary-600' : 'bg-base-700',
      )}
    >
      <span
        className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all"
        style={{ left: on ? '1.125rem' : '0.125rem' }}
      />
    </button>
  );
}

function Chip({ label, active, onToggle }: { label: string; active: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className={clsx(
        'rounded-md px-2.5 py-1 text-xs font-semibold transition',
        active ? 'bg-secondary-700/40 text-secondary-400' : 'bg-base-800 text-base-400 hover:text-base-200',
      )}
    >
      {label}
    </button>
  );
}

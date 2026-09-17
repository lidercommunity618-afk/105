import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { Timeframe, IndicatorConfig, FeatureName, PatternName, SignalComponentToggles } from '@/types/domain';
import { DEFAULT_INDICATOR_CONFIG, DEFAULT_SIGNAL_TOGGLES } from '@/types/domain';
import { ALL_FEATURES } from '@/types/domain';

export const ALL_PATTERNS: readonly PatternName[] = [
  'hammer',
  'shooting-star',
  'doji',
  'pin-bar',
  'bullish-engulfing',
  'bearish-engulfing',
  'bullish-harami',
  'bearish-harami',
  'inside-bar',
  'morning-star',
  'evening-star',
  'three-white-soldiers',
  'three-black-crows',
  'abandoned-baby-bottom',
  'abandoned-baby-top',
  'impulse-breakout',
  'consolidation-breakout',
  'liquidity-sweep',
  'liquidity-sweep-reaction',
  'mean-reversion',
  'strong-order-block-reaction',
  'order-block-continuation',
  'macd-deceleration-continuation',
  'fvg-return',
  'fvg-breaker-block',
  'fvg-nested',
  'fvg-rejection',
  'order-block-breaker',
  'order-block-nested',
  // Previously missing — fully implemented and tested in patterns/index.ts,
  // but absent from this toggle list meant detectAllPatterns' has() filter
  // silently dropped them for every user (including "enable all" in the UI,
  // which only ever enables what's in this array). See audit notes.
  'inverted-hammer',
  'hanging-man',
  'marubozu-bullish',
  'marubozu-bearish',
  'spinning-top',
  'piercing-line',
  'dark-cloud-cover',
  'tweezer-bottom',
  'tweezer-top',
  'rising-three-methods',
  'falling-three-methods',
  // Гармонические паттерны (Gartley/Butterfly/AB=CD) — единый PatternName,
  // см. domain.ts (PatternResult.harmonicType) и pattern-categories.ts
  // (STRATEGY_PATTERNS/STRATEGY_BONUS_PATTERNS).
  'harmonic-pattern',
];

export const ALL_INDICATOR_FEATURES: readonly FeatureName[] = [
  'rsi',
  'ema',
  'macd',
  'atr',
  'bollinger',
  'vwap',
  'volume-profile',
  'fibonacci',
  'liquidity-pools',
  // Мёртвая настройка (аудит 2026-09-12, п.6): ни на что не влияет — см.
  // комментарий у 'super-order-block' в types/domain.ts.
  'super-order-block',
  'support-resistance',
  'trend-structure',
  'market-regime',
  'impulse-velocity',
  'vsa-classifier',
  'order-block-strength',
  'level-rejection',
  'smart-money',
];

type SoundUnit = 'pips' | 'points' | 'percent';

export type MarketMode = 'crypto' | 'forex';

export type Sensitivity = 'soft' | 'strict';

interface SettingsState {
  symbolId: string;
  timeframe: Timeframe;
  marketMode: MarketMode;
  indicators: IndicatorConfig;
  soundUnit: SoundUnit;
  priorityThreshold: number;
  activePatterns: string[];
  activeIndicators: string[];
  showBosLayer: boolean;
  showOrderBlocks: boolean;
  showImbalances: boolean;
  showSupportResistance: boolean;
  showEma20: boolean;
  showEma50: boolean;
  showEma200: boolean;
  showBollinger: boolean;
  showMacd: boolean;
  showRejectionBlocks: boolean;
  // Слой отображения найденных гармонических паттернов (PRZ-зона +
  // маркеры X-A-B-C-D) на графике — см. ChartPanel.tsx / SettingsPanel.tsx.
  showHarmonicPatterns: boolean;
  // Точки входа в позицию на графике (маркеры сигналов) — см.
  // ChartPanel.tsx. Отдельный слой от showBosLayer/showOrderBlocks и т.п.:
  // те рисуют структуру рынка, этот — историю уже сгенерированных сигналов
  // поверх неё. По умолчанию включено, как и большинство остальных слоёв.
  showEntryPoints: boolean;
  onboardingCompleted: boolean;
  sensitivity: Sensitivity;
  // Держать экран включённым (Screen Wake Lock), пока идёт автоторговля на
  // демо-счёте — см. useWakeLock.ts. По умолчанию включено: это самая частая
  // причина обрыва сессии на практике (экран гаснет по таймауту бездействия).
  keepScreenAwake: boolean;
  signalToggles: SignalComponentToggles;
  setSignalToggle: (key: keyof SignalComponentToggles, enabled: boolean) => void;
  setAllSignalToggles: (enabled: boolean) => void;
  setSymbol: (id: string) => void;
  setTimeframe: (tf: Timeframe) => void;
  setMarketMode: (mode: MarketMode) => void;
  setIndicators: (patch: Partial<IndicatorConfig>) => void;
  setSoundUnit: (unit: SoundUnit) => void;
  setPriorityThreshold: (threshold: number) => void;
  setActivePatterns: (patterns: string[]) => void;
  setActiveIndicators: (indicators: string[]) => void;
  setShowBosLayer: (show: boolean) => void;
  setShowOrderBlocks: (show: boolean) => void;
  setShowImbalances: (show: boolean) => void;
  setShowSupportResistance: (show: boolean) => void;
  setShowEma20: (show: boolean) => void;
  setShowEma50: (show: boolean) => void;
  setShowEma200: (show: boolean) => void;
  setShowBollinger: (show: boolean) => void;
  setShowMacd: (show: boolean) => void;
  setShowRejectionBlocks: (show: boolean) => void;
  setShowHarmonicPatterns: (show: boolean) => void;
  setShowEntryPoints: (show: boolean) => void;
  setOnboardingCompleted: (done: boolean) => void;
  setSensitivity: (s: Sensitivity) => void;
  setKeepScreenAwake: (enabled: boolean) => void;
}

function defaultActiveFeatures(): { patterns: string[]; indicators: string[] } {
  return {
    patterns: [...ALL_PATTERNS],
    indicators: [...ALL_INDICATOR_FEATURES],
  };
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      symbolId: 'BTCUSDT',
      timeframe: '15m',
      marketMode: 'crypto',
      indicators: { ...DEFAULT_INDICATOR_CONFIG },
      soundUnit: 'pips',
      priorityThreshold: 0.75,
      activePatterns: [...ALL_PATTERNS],
      activeIndicators: [...ALL_INDICATOR_FEATURES],
      showBosLayer: false,
      showOrderBlocks: true,
      showImbalances: true,
      showSupportResistance: true,
      showEma20: true,
      showEma50: true,
      showEma200: false,
      showBollinger: false,
      showMacd: false,
      showRejectionBlocks: false,
      showHarmonicPatterns: true,
      showEntryPoints: true,
      onboardingCompleted: false,
      sensitivity: 'soft',
      keepScreenAwake: true,
      signalToggles: { ...DEFAULT_SIGNAL_TOGGLES },
      setSignalToggle: (key, enabled) => set((s) => ({ signalToggles: { ...s.signalToggles, [key]: enabled } })),
      setAllSignalToggles: (enabled) => set({ signalToggles: { structure: enabled, zones: enabled, liquidity: enabled, trigger: enabled, indicator: enabled, bos: enabled, macd: enabled, meanReversion: enabled, contextPenalty: enabled, obConfirmation: enabled, fvgConfirmation: enabled, bosConfirmation: enabled, chochWarning: enabled, invalidation: enabled, regimeGate: enabled } }),
      setSymbol: (id) => set({ symbolId: id }),
      setTimeframe: (tf) => set({ timeframe: tf }),
      setMarketMode: (mode) => set({ marketMode: mode }),
      setIndicators: (patch) => set((s) => ({ indicators: { ...s.indicators, ...patch } })),
      setSoundUnit: (unit) => set({ soundUnit: unit }),
      setPriorityThreshold: (threshold) => set({ priorityThreshold: Math.max(0.5, Math.min(0.95, threshold)) }),
      setActivePatterns: (patterns) => set({ activePatterns: patterns }),
      setActiveIndicators: (indicators) => set({ activeIndicators: indicators }),
      setShowBosLayer: (show) => set({ showBosLayer: show }),
      setShowOrderBlocks: (show) => set({ showOrderBlocks: show }),
      setShowImbalances: (show) => set({ showImbalances: show }),
      setShowSupportResistance: (show) => set({ showSupportResistance: show }),
      setShowEma20: (show) => set({ showEma20: show }),
      setShowEma50: (show) => set({ showEma50: show }),
      setShowEma200: (show) => set({ showEma200: show }),
      setShowBollinger: (show) => set({ showBollinger: show }),
      setShowMacd: (show) => set({ showMacd: show }),
      setShowRejectionBlocks: (show) => set({ showRejectionBlocks: show }),
      setShowHarmonicPatterns: (show) => set({ showHarmonicPatterns: show }),
      setShowEntryPoints: (show) => set({ showEntryPoints: show }),
      setOnboardingCompleted: (done) => set({ onboardingCompleted: done }),
      setSensitivity: (s) => set({ sensitivity: s }),
      setKeepScreenAwake: (enabled) => set({ keepScreenAwake: enabled }),
    }),
    {
      name: 'terminal-settings',
      version: 14,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        symbolId: s.symbolId,
        timeframe: s.timeframe,
        marketMode: s.marketMode,
        indicators: s.indicators,
        soundUnit: s.soundUnit,
        priorityThreshold: s.priorityThreshold,
        activePatterns: s.activePatterns,
        activeIndicators: s.activeIndicators,
        showBosLayer: s.showBosLayer,
        showOrderBlocks: s.showOrderBlocks,
        showImbalances: s.showImbalances,
        showSupportResistance: s.showSupportResistance,
        showEma20: s.showEma20,
        showEma50: s.showEma50,
        showEma200: s.showEma200,
        showBollinger: s.showBollinger,
        showMacd: s.showMacd,
        showRejectionBlocks: s.showRejectionBlocks,
        showHarmonicPatterns: s.showHarmonicPatterns,
        showEntryPoints: s.showEntryPoints,
        onboardingCompleted: s.onboardingCompleted,
        sensitivity: s.sensitivity,
        keepScreenAwake: s.keepScreenAwake,
        signalToggles: s.signalToggles,
      }),
      migrate: (persisted, version) => {
        const s: Record<string, unknown> = ((persisted as Record<string, unknown>) ?? {});
        if (version < 1) {
          if (typeof s.soundEnabled === 'boolean') {
            s.soundNewSignal = s.soundEnabled;
            s.soundPrioritySignal = s.soundEnabled;
            delete s.soundEnabled;
          }
        }
        if (version < 2) {
          const ind = (s.indicators ?? {}) as Record<string, number>;
          if (ind.bollingerPeriod !== undefined) {
            ind.bbPeriod = ind.bollingerPeriod;
            delete ind.bollingerPeriod;
          }
          if (ind.bollingerStdDev !== undefined) {
            ind.bbStdDev = ind.bollingerStdDev;
            delete ind.bollingerStdDev;
          }
          s.indicators = ind;
        }
        if (version < 3) {
          const keys = (s.apiKeys ?? {}) as Record<string, unknown>;
          if (typeof keys.derivAppId !== 'string') keys.derivAppId = '';
          if (typeof keys.yahooProxyUrl !== 'string') keys.yahooProxyUrl = '';
          s.apiKeys = keys;
        }
        if (version < 4) {
          const defaults = defaultActiveFeatures();
          if (!Array.isArray(s.activePatterns) || (s.activePatterns as string[]).length <= 5) {
            s.activePatterns = defaults.patterns;
          }
          if (!Array.isArray(s.activeIndicators) || (s.activeIndicators as string[]).length <= 5) {
            s.activeIndicators = defaults.indicators;
          }
          if (typeof s.priorityThreshold !== 'number') s.priorityThreshold = 0.75;
          if (typeof s.showOrderBlocks !== 'boolean') s.showOrderBlocks = true;
          if (typeof s.showImbalances !== 'boolean') s.showImbalances = true;
          if (typeof s.showSupportResistance !== 'boolean') s.showSupportResistance = true;
          if (typeof s.onboardingCompleted !== 'boolean') s.onboardingCompleted = false;
        }
        if (version < 5) {
          if (s.marketMode !== 'crypto' && s.marketMode !== 'forex') s.marketMode = 'crypto';
        }
        if (version < 6) {
          if (typeof s.showEma20 !== 'boolean') s.showEma20 = true;
          if (typeof s.showEma50 !== 'boolean') s.showEma50 = true;
          if (typeof s.showEma200 !== 'boolean') s.showEma200 = false;
          if (typeof s.showBollinger !== 'boolean') s.showBollinger = false;
          if (typeof s.showMacd !== 'boolean') s.showMacd = false;
          if (typeof s.showRejectionBlocks !== 'boolean') s.showRejectionBlocks = false;
        }
        if (version < 7) {
          if (s.sensitivity !== 'soft' && s.sensitivity !== 'strict') s.sensitivity = 'soft';
          delete (s as Partial<Record<string, unknown>>).apiKeys;
        }
        if (version < 8) s.signalToggles = { ...DEFAULT_SIGNAL_TOGGLES };
        if (version < 9) {
          // ALL_PATTERNS just gained 11 previously-implemented-but-untoggleable
          // patterns (see audit notes). Additively merge them into whatever the
          // user already has, instead of resetting activePatterns wholesale —
          // that would silently re-enable patterns a user had deliberately
          // turned off.
          const currentPatterns = Array.isArray(s.activePatterns) ? (s.activePatterns as string[]) : [];
          const missing = ALL_PATTERNS.filter((p) => !currentPatterns.includes(p));
          if (missing.length > 0) {
            s.activePatterns = [...currentPatterns, ...missing];
          }
        }
        if (version < 10) {
          // Задачи 1.1/1.2/1.3/Этап 2: IndicatorConfig gained scoreThreshold,
          // rsiOverbought, rsiOversold, spreadGateMultiplier and
          // sessionFilter. Merge in defaults for whichever of these an
          // already-persisted config is missing, without touching any
          // existing indicator period the user already tuned. All of the
          // new defaults preserve current behaviour exactly (scoreThreshold
          // matches the previous hardcoded constant, sessionFilter starts
          // fully open, rsiOverbought/oversold match the previous hardcoded
          // 70/30) — this migration only makes them visible/editable, it
          // does not change anyone's existing signal behaviour.
          const ind = (s.indicators ?? {}) as Record<string, unknown>;
          if (typeof ind.scoreThreshold !== 'number') ind.scoreThreshold = DEFAULT_INDICATOR_CONFIG.scoreThreshold;
          if (typeof ind.rsiOverbought !== 'number') ind.rsiOverbought = DEFAULT_INDICATOR_CONFIG.rsiOverbought;
          if (typeof ind.rsiOversold !== 'number') ind.rsiOversold = DEFAULT_INDICATOR_CONFIG.rsiOversold;
          if (typeof ind.spreadGateMultiplier !== 'number') ind.spreadGateMultiplier = DEFAULT_INDICATOR_CONFIG.spreadGateMultiplier;
          const existingFilter = (ind.sessionFilter ?? {}) as Record<string, unknown>;
          ind.sessionFilter = {
            london: typeof existingFilter.london === 'boolean' ? existingFilter.london : DEFAULT_INDICATOR_CONFIG.sessionFilter.london,
            newyork: typeof existingFilter.newyork === 'boolean' ? existingFilter.newyork : DEFAULT_INDICATOR_CONFIG.sessionFilter.newyork,
            overlap: typeof existingFilter.overlap === 'boolean' ? existingFilter.overlap : DEFAULT_INDICATOR_CONFIG.sessionFilter.overlap,
            tokyo: typeof existingFilter.tokyo === 'boolean' ? existingFilter.tokyo : DEFAULT_INDICATOR_CONFIG.sessionFilter.tokyo,
            sydney: typeof existingFilter.sydney === 'boolean' ? existingFilter.sydney : DEFAULT_INDICATOR_CONFIG.sessionFilter.sydney,
          };
          s.indicators = ind;
        }
        if (version < 11) {
          // Задача 2 (доделка): soundNewSignal/soundPrioritySignal удалены из
          // SettingsState — баннер и звук теперь обязательны для каждого
          // приоритетного сигнала и больше не переключаются пользователем
          // (см. notifySignal в tick-store/shared.ts). Чистим их из уже
          // сохранённого у пользователя стейта, чтобы не оставлять там
          // осиротевшие ключи (в т.ч. те, что мог проставить шаг version < 1
          // выше, если он сработал в этом же проходе миграции).
          delete s.soundNewSignal;
          delete s.soundPrioritySignal;
        }
        if (version < 12) {
          // "Стратегии на FVG" added 4 new toggleable patterns (fvg-return,
          // fvg-breaker-block, fvg-nested, fvg-rejection). Same additive-merge
          // approach as version < 9 above — enable them for existing users
          // without resetting any pattern they'd deliberately turned off.
          const currentPatterns = Array.isArray(s.activePatterns) ? (s.activePatterns as string[]) : [];
          const missing = ALL_PATTERNS.filter((p) => !currentPatterns.includes(p));
          if (missing.length > 0) {
            s.activePatterns = [...currentPatterns, ...missing];
          }
        }
        if (version < 13) {
          // Точки входа на графике (showEntryPoints) — новый слой,
          // включённый по умолчанию для новых пользователей; для уже
          // существующих сохранённых настроек проставляем тот же дефолт,
          // а не оставляем undefined (иначе ChartPanel.tsx трактовал бы
          // это как falsy и молча скрывал маркеры до первого явного клика
          // по тумблеру).
          if (typeof s.showEntryPoints !== 'boolean') s.showEntryPoints = true;
        }
        if (version < 14) {
          // Модуль "Гармонические паттерны" (Gartley/Butterfly/AB=CD) —
          // три независимых риска "потерянных при персисте данных",
          // закрываемые одним версионным шагом:
          //
          // 1) indicators персистится целиком одним объектом — у уже
          //    существующих пользователей в localStorage нет 3 новых полей
          //    (harmonicMinLegAtr/harmonicFibTolerancePct/harmonicHtfFactor)
          //    → без этого шага они были бы undefined → NaN в расчётах
          //    ZigZag/допусков. Прецедент: version < 2.
          //    BUGFIX (Фаза 1, "честный бинарный опцион"): было 4 поля,
          //    четвёртое — harmonicMinRR — удалено из IndicatorConfig
          //    целиком вместе с decision/trade-levels.ts (детектор его
          //    никогда не читал, см. compute/patterns/harmonic-pattern.ts).
          //    Старые записи в localStorage могут по-прежнему содержать
          //    ключ harmonicMinRR — не страшно, TS-тип его просто
          //    игнорирует, читающий код на него не смотрит нигде.
          const ind = (s.indicators ?? {}) as Record<string, number>;
          if (typeof ind.harmonicMinLegAtr !== 'number') ind.harmonicMinLegAtr = DEFAULT_INDICATOR_CONFIG.harmonicMinLegAtr;
          if (typeof ind.harmonicFibTolerancePct !== 'number') ind.harmonicFibTolerancePct = DEFAULT_INDICATOR_CONFIG.harmonicFibTolerancePct;
          if (typeof ind.harmonicHtfFactor !== 'number') ind.harmonicHtfFactor = DEFAULT_INDICATOR_CONFIG.harmonicHtfFactor;
          s.indicators = ind;

          // 2) Флаг видимости showHarmonicPatterns отсутствует у уже
          //    сохранённых пользователей. Прецедент: version < 6 (6 флагов
          //    showEma20/50/200/showBollinger/showMacd/showRejectionBlocks).
          if (typeof s.showHarmonicPatterns !== 'boolean') s.showHarmonicPatterns = true;

          // 3) activePatterns персистится как самостоятельный массив строк
          //    и НЕ мержится автоматически с новым ALL_PATTERNS — у
          //    пользователей с уже сохранённым activePatterns
          //    'harmonic-pattern' там просто не будет, и has('harmonic-pattern')
          //    в detectAllPatterns/patterns/index.ts всегда будет false для
          //    них, даже после обновления кода. Тот же приём, что version < 9
          //    и version < 12 — аддитивный домердж нового паттерна в уже
          //    сохранённый activePatterns, без сброса пользовательских
          //    отключений остальных паттернов.
          const currentPatterns = Array.isArray(s.activePatterns) ? (s.activePatterns as string[]) : [];
          if (!currentPatterns.includes('harmonic-pattern')) {
            s.activePatterns = [...currentPatterns, 'harmonic-pattern'];
          }
        }
        return s;
      },
    },
  ),
);

export { ALL_FEATURES };

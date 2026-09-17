import { z } from 'zod';

// ─── Union / Literal Types ──────────────────────────────────────────

export type Timeframe = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d';

export type SourceId = 'binance' | 'deriv' | 'twelvedata' | 'finnhub' | 'yahoo';

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'live'
  | 'market_closed'
  | 'degraded'
  | 'reconnecting'
  | 'failed';

export type SignalDirection = 'buy' | 'sell';

export type SignalOutcome = 'pending' | 'win' | 'loss' | 'timeout';

export type SignalStrength = 'weak' | 'moderate' | 'strong';

export type MarketRegime = 'trend' | 'range' | 'high-volatility';

export type SpreadSource = 'live' | 'estimated';

export type AssetClass = 'crypto' | 'forex';

export type PatternName =
  // Toggleable patterns (ALL_PATTERNS in settingsStore)
  | 'hammer'
  | 'shooting-star'
  | 'doji'
  | 'pin-bar'
  | 'bullish-engulfing'
  | 'bearish-engulfing'
  | 'bullish-harami'
  | 'bearish-harami'
  | 'inside-bar'
  | 'morning-star'
  | 'evening-star'
  | 'impulse-breakout'
  | 'consolidation-breakout'
  | 'liquidity-sweep'
  | 'liquidity-sweep-reaction'
  | 'mean-reversion'
  | 'strong-order-block-reaction'
  | 'order-block-continuation'
  | 'macd-deceleration-continuation'
  // "Стратегии на FVG" (fvg-return.ts, fvg-breaker-block.ts, fvg-nested.ts,
  // fvg-rejection.ts) — Strategies A-D from the source document.
  | 'fvg-return'
  | 'fvg-breaker-block'
  | 'fvg-nested'
  | 'fvg-rejection'
  // OB Breaker Block / Nested OB (order-block-breaker.ts, order-block-
  // nested.ts) — the Order Block counterparts of fvg-breaker-block/
  // fvg-nested above, built on smart-money.ts's `breakerBlocks`/
  // `orderBlocks` rather than super-order-block.ts (the detector behind
  // strong-order-block-reaction/order-block-continuation above).
  | 'order-block-breaker'
  | 'order-block-nested'
  // Additional patterns detected in patterns/index.ts
  | 'inverted-hammer'
  | 'hanging-man'
  | 'marubozu-bullish'
  | 'marubozu-bearish'
  | 'spinning-top'
  | 'piercing-line'
  | 'dark-cloud-cover'
  | 'tweezer-bottom'
  | 'tweezer-top'
  | 'three-white-soldiers'
  | 'three-black-crows'
  | 'abandoned-baby-bottom'
  | 'abandoned-baby-top'
  | 'rising-three-methods'
  | 'falling-three-methods'
  // Гармонические паттерны (Gartley, Butterfly, AB=CD) — один PatternName
  // на все 3 геометрии; конкретный тип различается полем harmonicType
  // внутри PatternResult (по аналогии с setupType у liquidity-sweep-reaction),
  // чтобы не плодить тройное дублирование во всех реестрах ниже.
  | 'harmonic-pattern';

export type IndicatorFeature =
  | 'rsi'
  | 'ema'
  | 'macd'
  | 'atr'
  | 'bollinger'
  | 'vwap'
  | 'volume-profile'
  | 'fibonacci'
  | 'liquidity-pools'
  // BUGFIX-NOTE (аудит 2026-09-12, п.6 "мёртвая настройка"): этот тумблер
  // сохранён только для UI/обратной совместимости настроек. Реальная
  // OB-детекция во всех живых стратегиях (order-block-continuation.ts,
  // strong-order-block-reaction.ts, macd-deceleration-continuation.ts)
  // уже безусловно использует smartMoney.orderBlocks из smart-money.ts —
  // сам детектор super-order-block.ts (superOrderBlocks()) нигде в реальном
  // пайплайне (IndicatorAggregator.ts/full-snapshot.ts/patterns/index.ts/
  // ChartPanel.tsx) не вызывается. Включение/выключение этого пункта в
  // настройках ничего не меняет в генерируемых сигналах.
  | 'super-order-block'
  | 'support-resistance'
  | 'trend-structure'
  | 'market-regime'
  | 'impulse-velocity'
  | 'vsa-classifier'
  | 'order-block-strength'
  | 'level-rejection'
  | 'smart-money';

export type FeatureName = PatternName | IndicatorFeature;

// ─── Interfaces ─────────────────────────────────────────────────────

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Tick {
  price: number;
  time: number;
  bid?: number;
  ask?: number;
}

export interface PatternResult {
  name: PatternName;
  direction: SignalDirection;
  confidence: number;
  strength: SignalStrength;
  time: number;
  volumeConfirmed?: boolean;
  confirmedByNextCandle?: boolean;
  confluenceFactors?: string[];
  // Breakout candle extremes (impulse-breakout only) — used to place a
  // structural stop beyond the level that was just taken out instead of an
  // arbitrary ATR-multiple-from-entry stop. See computeBreakoutTradeLevels.
  breakoutLow?: number;
  breakoutHigh?: number;
  // Liquidity-sweep-reaction only — the swept bar's own extreme (the level
  // stop/take-profit should be structured around, not a flat ATR multiple).
  // See computeLiquiditySweepTradeLevels and the "Реакция на снятие
  // ликвидности" audit fix, finding #6.
  sweepLow?: number;
  sweepHigh?: number;
  // Liquidity-sweep-reaction only — nearest opposite-side OB/FVG edge beyond
  // entry, precomputed inside the detector (which has smartMoney in scope)
  // so the decision layer doesn't need its own copy of smartMoney to place a
  // structural take-profit. Null when no such zone was found.
  oppositeZonePrice?: number | null;
  // liquidity-sweep / liquidity-sweep-reaction only — which of the two
  // ICT/Wyckoff-valid trend contexts this setup matched: continuation (sweep
  // in the direction the market was already moving) or a reversal right at a
  // significant swing level (Spring/Upthrust). See audit finding #7.
  setupType?: 'continuation' | 'reversal-at-key-level';
  // Order-block-continuation only — nearest structural level (OB/FVG/S-R)
  // in the trade direction, precomputed by findTargetZone() inside the
  // detector. Used by computeOrderBlockContinuationTradeLevels to place a
  // structural take-profit instead of a flat ATR×2. See audit finding #3.
  targetZone?: number;
  // Гармонические паттерны (harmonic-pattern) only — конкретный тип
  // геометрии, диапазон PRZ (Potential Reversal Zone) и предвычисленные
  // в детекторе структурные SL/TP (см. computeHarmonicTradeLevels в
  // trade-levels.ts). harmonicStop — за точкой D/X с ATR-буфером,
  // harmonicTarget — проекция Фибоначчи от точки D. 'bat'/'crab' добавлены
  // при интеграции детектора гармоник из соседнего проекта — тот же единый
  // PatternName 'harmonic-pattern', просто 2 новые геометрии этого же поля.
  harmonicType?: 'gartley' | 'bat' | 'crab' | 'butterfly' | 'ab-cd';
  przLow?: number;
  przHigh?: number;
  harmonicStop?: number;
  harmonicTarget?: number;
  // Необязательные диагностические поля (не потребляются trade-levels.ts/
  // signal-builder.ts — только для чарта/постмортем-аналитики). Точки
  // X-A-B-C-D, на которых сматчилась геометрия, и сами 4 коэффициента
  // Фибоначчи, по которым считался confidence — то же, что harmonicPoints/
  // harmonicRatios в соседнем проекте, перенесено как полезное дополнение
  // без изменения уже используемых harmonicStop/harmonicTarget/przLow/
  // przHigh, на которые завязана вся остальная логика ниже по цепочке.
  harmonicPoints?: {
    x: HarmonicPoint;
    a: HarmonicPoint;
    b: HarmonicPoint;
    c: HarmonicPoint;
    d: HarmonicPoint;
  };
  harmonicRatios?: { ab_xa: number; bc_ab: number; cd_bc: number; ad_xa: number };
}

/** Одна из 5 точек X-A-B-C-D гармонического паттерна (диагностика/чарт). */
export interface HarmonicPoint {
  price: number;
  time: number;
  index: number;
}

export interface MarketStructure {
  trend: 'up' | 'down' | 'range';
  bos: boolean;
  choch: boolean;
  swingHigh: number | null;
  swingLow: number | null;
  provisional: boolean;
}

export interface SessionFilterConfig {
  london: boolean;
  newyork: boolean;
  overlap: boolean;
  tokyo: boolean;
  sydney: boolean;
}

export interface IndicatorConfig {
  rsiPeriod: number;
  emaFast: number;
  emaSlow: number;
  macdFast: number;
  macdSlow: number;
  macdSignal: number;
  atrPeriod: number;
  bbPeriod: number;
  bbStdDev: number;
  // Задача 1.1 — прежде хардкодился как DEFAULT_SCORE_THRESHOLD внутри
  // signal-builder.ts/engine.ts. Минимальный итоговый score, при котором
  // сигнал вообще строится.
  scoreThreshold: number;
  // Этап 2 — прежде хардкодились как RSI_OVERSOLD/RSI_OVERBOUGHT (30/70) в
  // signal-builder.ts и напрямую как 30/70 в direction-prediction.ts.
  rsiOverbought: number;
  rsiOversold: number;
  // Задача 1.3 — порог pre-entry spread-gate: сигнал не строится, если
  // estimateSpread(...) вернул спред шире, чем atrValue * spreadGateMultiplier.
  spreadGateMultiplier: number;
  // Задача 1.2 — какие торговые сессии (по UTC-окнам getSessionRegime())
  // разрешено использовать для генерации сигналов. Это фильтр качества
  // ликвидности внутри торгового дня, отдельный от MarketHoursConfig
  // (открыт/закрыт рынок в принципе).
  sessionFilter: SessionFilterConfig;
  // Модуль "Гармонические паттерны" (Gartley/Butterfly/AB=CD) — ручная
  // конфигурация ZigZag/допусков, по той же схеме, что и остальные поля
  // этого интерфейса (не отдельный state-объект). См. SettingsPanel.tsx
  // (HARMONIC_FIELDS) и full-snapshot.ts (harmonicConfig).
  harmonicMinLegAtr: number;       // мин. размер ноги ZigZag в ATR
  harmonicFibTolerancePct: number; // допуск по коэффициентам Фибо, %
  harmonicHtfFactor: number;       // множитель ресэмплинга для ZigZag
}

export interface IndicatorSnapshot {
  rsi: number | null;
  emaFast: number | null;
  emaSlow: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  atr: number | null;
  bollingerUpper: number | null;
  bollingerMiddle: number | null;
  bollingerLower: number | null;
  vwap: number | null;
  vwapIsProxyVolume: boolean;
  volumeProfilePoc: number | null;
  volumeProfilePocIsProxyVolume: boolean;
  meanReversionRsi: number | null;
  impulseVelocity: number | null;
  adx: number | null;
}

export interface SeriesPoint {
  time: number;
  value: number | null;
}

export interface IndicatorSeries {
  rsi: SeriesPoint[];
  emaFast: SeriesPoint[];
  emaSlow: SeriesPoint[];
  macd: SeriesPoint[];
  macdSignal: SeriesPoint[];
  macdHistogram: SeriesPoint[];
  bollingerUpper: SeriesPoint[];
  bollingerMiddle: SeriesPoint[];
  bollingerLower: SeriesPoint[];
}

export interface Snapshot {
  indicators: IndicatorSnapshot;
  patterns: PatternResult[];
  structure: MarketStructure;
  regime: MarketRegime;
  lastPrice: number | null;
  candleTime: number | null;
}

export interface Signal {
  id: string;
  symbolId: string;
  direction: SignalDirection;
  strength: SignalStrength;
  score: number;
  calibratedProbability: number | null;
  // BUGFIX (аудит 2026-09-05): до накопления MIN_SAMPLES реальных исходов
  // (calibration-model.ts) calibratedProbability считается через
  // sigmoidFallback() — монотонную функцию от score без всякой связи с
  // фактическим win-rate. 'model' — из обученной логистической регрессии,
  // 'fallback' — сырая оценка по score, доверять ей как проценту выигрыша
  // нельзя. Опционально (undefined = старые записи до этого фикса,
  // трактовать как 'fallback' на всякий случай) — не required, чтобы не
  // ломать все существующие места, собирающие Signal-литералы вручную.
  calibrationSource?: 'model' | 'fallback';
  // BUGFIX (Фаза 1, вычистка TP/SL/RR-языка — "честный бинарный опцион"):
  // stopLoss/takeProfit удалены целиком, не переразмечены. Бинарный опцион
  // с фиксированной экспирацией не имеет структурного стопа/цели — исход
  // определяется ТОЛЬКО ценой закрытия на экспирации (expiryBars) против
  // entryPrice, см. outcome-scheduler.ts::resolveOutcome. Поле в БД удалено
  // отдельной миграцией (DROP COLUMN), не просто "больше не писать туда".
  entryPrice: number;
  reason: string;
  indicators: IndicatorSnapshot;
  pattern: PatternName | null;
  time: number;
  timeframe: Timeframe;
  outcome: SignalOutcome;
  frozenAt: number | null;
  isRevised: boolean;
  isPreClose: boolean;
  revisionNote: string | null;
  barsToResolve: number;
  spread: number | null;
  spreadSource: SpreadSource | null;
  recommendedExpiry: number;
  // BUGFIX (Фаза 0, аудит "экспирация на карточке не совпадает с фактическим
  // резолвом"): единственное число, которое реально управляет резолвом
  // исхода — outcome-scheduler.ts::resolveOutcome, tick-store/outcomes.ts и
  // useDemoAccountStore.ts::openTrade читают ИМЕННО это поле, не
  // recommendedExpiry напрямую (recommendedExpiry — секунды для отображения,
  // expiryBars = round(recommendedExpiry / TIMEFRAME_SECONDS[timeframe]),
  // см. signal-builder.ts). Optional (а не required), как и tradeOpened/
  // calibrationSource выше — ради обратной совместимости с записями,
  // персистнутыми до этого фикса: undefined трактуется как 1 бар везде,
  // где поле читается, поскольку старые записи и были фактически
  // резолвлены ровно через 1 бар (жёсткий хардкод, который и чинит этот
  // фикс) — не переписывает задним числом уже посчитанную статистику.
  expiryBars?: number;
  featureVector: number[];
  // Структурированная атрибуция сигнала — см. блок "Signal attribution
  // (post-mortem analysis)" выше. Заполняется в signal-builder.ts
  // buildSignal()/reviseSignal() наравне с уже существующими reason/
  // indicators/pattern, ничего из них не заменяет.
  factors: SignalFactor[];
  rejectedPatterns: RejectedPattern[];
  engineConfigSnapshot: EngineConfigSnapshot;
  chartContext: ChartContext;
  marketContext: MarketContext;
  // Аудит (синхронизация с демо-счётом): true/false проставляется в момент
  // закрытия свечи (см. useTickStore.ts/tick-store/pre-close.ts) — была ли
  // по этому сигналу реально открыта демо-сделка (useDemoAccountStore).
  // undefined — устаревшая запись до этого фикса (трактуется как "да",
  // чтобы не переписывать задним числом уже посчитанную статистику).
  // Определяет: 1) кто выставляет финальный outcome — useDemoAccountStore
  // при закрытии сделки (true) или планировщик как fallback (false/undefined
  // без открытой сделки); 2) учитывается ли сигнал в винрейте (см.
  // recomputeStats/StatusBar) и как он подписывается в SignalCard.
  tradeOpened?: boolean;
}

// Рыночный контекст на момент сигнала — regime/structure уже считались в
// Snapshot (см. decision/engine.ts), но раньше нигде не копировались в
// Signal, а session вообще нигде не сохранялась. Без этого постмортем-отчёт
// не может ответить на вопрос "сигнал шёл против тренда старшего порядка
// или по нему", "рынок был трендовый или флэтовый", "какая сессия была
// в момент входа" — а это часто и есть причина убыточной сделки.
export interface MarketContext {
  regime: MarketRegime;
  structure: MarketStructure;
  // 'sydney' | 'tokyo' | 'london' | 'newyork' | 'overlap' | 'closed' —
  // не импортируем SessionRegime из compute/session-regime.ts напрямую,
  // чтобы не тянуть зависимость types/domain.ts -> compute/*; тип продублирован
  // как строковый литерал-union, значения совпадают 1:1 с SessionRegime.
  session: 'sydney' | 'tokyo' | 'london' | 'newyork' | 'overlap' | 'closed';
}

export interface SpreadEstimate {
  spread: number;
  source: SpreadSource;
}

// ─── Signal attribution (post-mortem analysis) ─────────────────────
//
// Раньше вклад каждого индикатора/паттерна/стратегии в решение сгенерировать
// сигнал схлопывался в единственную строку `Signal.reason` ("BOS bullish;
// RSI oversold (24.5); FVG Nested strategy (+0.46)") — читаемо для человека,
// но не пригодно для агрегации ("какой индикатор чаще всего в убыточных
// сделках") и без сохранённых числовых величин. SignalFactor — структурная
// версия того же самого: computeDirectionScore()/evaluateEvidence() в
// direction-prediction.ts и signal-builder.ts уже считают ровно эти данные
// (components, extraReasons, weighted strategy bonuses) — теперь они не
// теряются при сборке Signal, а сохраняются рядом со строкой reason.

// BUGFIX (факторный анализ, BOS-задвоение): 'bos' добавлен как собственный
// kind, отдельный от 'structure' — раньше BOS-факты помечались kind:
// 'structure', что при фиксе задвоения (direction-prediction.ts,
// components.bos vs components.structure) стало вводить в заблуждение:
// bos-факт больше не связан с components.structure. Кроме computeDirectionScore
// в direction-prediction.ts, других мест, порождающих SignalFactor с этим
// kind, нет — существующие switch/exhaustiveness-проверки по SignalFactorKind
// (если такие появятся) должны явно обработать 'bos' наравне с остальными.
export type SignalFactorKind = 'indicator' | 'pattern' | 'strategy' | 'structure' | 'filter' | 'bos';

export interface SignalFactor {
  kind: SignalFactorKind;
  // Имя индикатора/паттерна/компонента ('rsi', 'order-block-continuation',
  // 'bos', 'session-gate'...) — не строго типизировано под FeatureName,
  // т.к. структурные компоненты (BOS/CHoCH, session-gate, spread-gate)
  // не являются ни PatternName, ни IndicatorFeature.
  name: string;
  direction: SignalDirection | null;
  // Числовой вклад в итоговый score (то, что раньше проговаривалось только
  // в тексте строки, напр. "+0.46").
  contribution: number;
  // Человекочитаемое обоснование — то же самое, что раньше уходило только
  // в `reasons: string[]` ("RSI oversold (24.5)").
  argument: string;
  // Конкретное значение индикатора на момент срабатывания, если применимо.
  value?: number | null;
}

// Паттерны, которые сработали на этой же свече, но не были выбраны как
// главный триггер (selectTopPattern в pattern-selection.ts выбирает один).
// Для постмортема убыточной сделки важно видеть, что альтернативный
// (возможно, встречный) сигнал был отклонён — а не просто не существовал.
export interface RejectedPattern {
  name: PatternName;
  direction: SignalDirection;
  confidence: number;
  reasonNotSelected: 'lower-class-priority' | 'opposite-direction' | 'lower-confidence';
}

// "Замороженная" на момент генерации сигнала конфигурация движка. Signal.
// indicators хранит СЗНАЧЕНИЯ индикаторов, но не то, с какими ПОРОГАМИ/
// периодами/переключателями эти значения оценивались — если пользователь
// потом поменяет настройки, старые сигналы становятся нечитаемы без этого.
export interface EngineConfigSnapshot {
  indicatorConfig: IndicatorConfig;
  signalToggles: SignalComponentToggles;
  activeFeatures: FeatureName[];
  // BUGFIX (Фаза 1, вычистка TP/SL/RR-языка): atrMultiplier удалён — он
  // управлял ТОЛЬКО размером ATR-стопа/цели в decision/trade-levels.ts
  // (удалён целиком, см. Signal.entryPrice выше); без структурных SL/TP
  // это число ни на что не влияет нигде в движке.
}

// Ценовой контекст вокруг сигнала — дополняет скриншот графика точными
// числами и позволяет посчитать, насколько сделка была близка к
// выигрышу/насколько далеко ушла в минус до резолва исхода.
export interface ChartContext {
  // Свечи ДО сигнала (захватываются сразу в buildSignal — уже есть в
  // параметрах). Используются для реконструкции контекста без скриншота.
  candlesBefore: Candle[];
  // Свечи ОТ сигнала до момента резолва исхода включительно. Заполняются
  // отдельно, в момент резолва (см. tick-store/outcomes.ts) — на момент
  // создания сигнала будущих свечей ещё не существует.
  candlesAfter: Candle[];
  // Максимальное движение В ПОЛЬЗУ позиции за время удержания (в цене
  // инструмента, не в пипсах) — null, пока не резолвлено.
  maxFavorableExcursion: number | null;
  // Максимальное движение ПРОТИВ позиции за время удержания — null, пока
  // не резолвлено.
  maxAdverseExcursion: number | null;
}

export const EMPTY_CHART_CONTEXT: ChartContext = {
  candlesBefore: [],
  candlesAfter: [],
  maxFavorableExcursion: null,
  maxAdverseExcursion: null,
};

// BUGFIX (Фаза 1/2/4, "честный бинарный опцион" — панель «Калибровка»
// перестроена под принцип бинарных опционов, не удалена): раньше это был
// grid-search по atrMultiplier, подбирающий stopLossPips/takeProfitPips с
// максимальным winRate внутри мини-бэктеста (см. compute/worker.ts) — оба
// понятия (структурный стоп/цель/R:R) не существуют для бинарного опциона
// с фиксированной экспирацией и фиксированной выплатой. Теперь это
// grid-search по expiryBars (сколько баров держать позицию до экспирации),
// метрика — ДОЛЯ ВЕРНЫХ ЗНАКОВ ДВИЖЕНИЯ (accuracy направления, не winRate:
// winRate зависит от profitPercent выплаты и спред-поправки, accuracy —
// нет; см. backtest/metrics.ts, Фаза 3).
export interface CalibrationResult {
  symbolId: string;
  timeframe: Timeframe;
  bestExpiryBars: number;
  directionAccuracy: number;
  totalTrades: number;
  calibratedAt: number;
}

export interface CalibrationState {
  weights: number[];
  bias: number;
  sampleCount: number;
  // BUGFIX (аудит "калибровка: 0 сигналов после 100", 2026-09-10, см.
  // calibration-model.ts::trainLogisticRegression): z-score статистики,
  // применённые к признакам ПЕРЕД обучением weights — обязательны для
  // корректной интерпретации weights при predict(). Опциональны (а не
  // required) исключительно ради обратной совместимости с состояниями,
  // персистнутыми (localStorage/Supabase) до этого фикса — см.
  // CalibrationModel.loadState()/loadCalibrationState() для того, как
  // их отсутствие обрабатывается (no-op нормализация + принудительный
  // переретрейн при первой возможности).
  featureMean?: number[];
  featureStd?: number[];
}

export interface MarketHoursConfig {
  openDays: boolean[];
  openMinutesUtc: number;
  closeMinutesUtc: number;
}

export interface Symbol {
  id: string;
  assetClass: AssetClass;
  displaySymbol: string;
  baseAsset: string;
  quoteAsset: string;
  displayName: string;
  pipSize: number;
  marketHours: MarketHoursConfig | null;
}

export interface DirectionComponents {
  structure: number;
  zones: number;
  liquidity: number;
  trigger: number;
  indicator: number;
  bos: number;
  macd: number;
  meanReversion: number;
}

export interface SignalComponentToggles {
  structure: boolean;
  zones: boolean;
  liquidity: boolean;
  trigger: boolean;
  indicator: boolean;
  bos: boolean;
  macd: boolean;
  meanReversion: boolean;
  contextPenalty: boolean;
  obConfirmation: boolean;
  fvgConfirmation: boolean;
  bosConfirmation: boolean;
  chochWarning: boolean;
  invalidation: boolean;
  // BUGFIX (аудит 2026-09-05): ADX считался движком (IndicatorAggregator) и
  // показывался в карточке сигнала, но нигде не влиял на score/решение —
  // regime тоже вычислялся, но использовался только как фича для
  // ML-калибровки (которая до накопления MIN_SAMPLES не активна, см.
  // calibration-model.ts). В результате сигналы штамповались и на затухающем
  // тренде/чистом флэте. Этот тоггл включает реальный гейт в
  // signal-filters.ts.
  regimeGate: boolean;
}

export const SIGNAL_COMPONENT_KEYS = [
  'structure',
  'zones',
  'liquidity',
  'trigger',
  'indicator',
  'bos',
  'macd',
  'meanReversion',
  'contextPenalty',
  'obConfirmation',
  'fvgConfirmation',
  'bosConfirmation',
  'chochWarning',
  'invalidation',
  'regimeGate',
] as const;

export type SignalComponentKey = (typeof SIGNAL_COMPONENT_KEYS)[number];

export const DEFAULT_SIGNAL_TOGGLES: SignalComponentToggles = {
  structure: true,
  zones: true,
  liquidity: true,
  trigger: true,
  indicator: true,
  bos: true,
  macd: true,
  meanReversion: true,
  contextPenalty: true,
  obConfirmation: true,
  fvgConfirmation: true,
  bosConfirmation: true,
  chochWarning: true,
  invalidation: true,
  regimeGate: true,
};

// ─── Constants ──────────────────────────────────────────────────────

export const DEFAULT_SESSION_FILTER: SessionFilterConfig = {
  london: true,
  newyork: true,
  overlap: true,
  tokyo: true,
  sydney: true,
};

export const DEFAULT_INDICATOR_CONFIG: IndicatorConfig = {
  rsiPeriod: 14,
  emaFast: 20,
  emaSlow: 50,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  atrPeriod: 14,
  bbPeriod: 20,
  bbStdDev: 2,
  // BUGFIX (аудит 2026-09-06, п.2): 2 из 10 не является рабочим порогом —
  // даже сигнал, урезанный regime-гейтом (×0.35) или несколькими штрафами
  // подряд, почти никогда не опускается ниже 2 (см. 4 сделки 2026-09-05
  // 20:15-20:29, score 4.3-7.0 уже ПОСЛЕ штрафа). Поднято до 4 — нижней
  // границы диапазона, который сам файл-аудит рекомендует (4-5 из 10); см.
  // также подпись под слайдером в SettingsPanel.tsx.
  scoreThreshold: 4,
  rsiOverbought: 70,
  rsiOversold: 30,
  spreadGateMultiplier: 3,
  sessionFilter: { ...DEFAULT_SESSION_FILTER },
  // Модуль "Гармонические паттерны" — стартовые дефолты. 1.5×ATR за ногу
  // ZigZag (заметно строже дефолтного PIVOT_LOOKUP=2 у findPivots, который
  // непригоден для 5-точечной геометрии на M1 — см. zigzag.ts); 8% допуск
  // по Фибо (стандартная практика для гармоник); ×5 ресэмплинг — тот же
  // HTF_FACTOR, что уже используется order-block-nested.ts/fvg-nested.ts.
  // BUGFIX (Фаза 1, вычистка TP/SL/RR-языка): harmonicMinRR (минимальный
  // RR для структурного TP) удалён целиком вместе с decision/trade-levels.ts —
  // структурные SL/TP не имеют смысла для бинарного опциона с
  // фиксированной экспирацией/выплатой. przLow/przHigh/harmonicStop/
  // harmonicTarget на PatternResult остаются как диагностическая
  // геометрия (см. комментарий в harmonic-pattern.ts), но ничем не
  // потребляются в решающем слое.
  harmonicMinLegAtr: 1.5,
  harmonicFibTolerancePct: 8,
  harmonicHtfFactor: 5,
};

const PATTERN_NAMES: readonly PatternName[] = [
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
  // Additional patterns detected in patterns/index.ts — previously missing
  // here, which meant backtest/config.ts's DEFAULT_BACKTEST_CONFIG (built
  // from ALL_FEATURES) silently never evaluated them (same root-cause bug
  // as ALL_PATTERNS in settingsStore.ts).
  'inverted-hammer',
  'hanging-man',
  'marubozu-bullish',
  'marubozu-bearish',
  'spinning-top',
  'piercing-line',
  'dark-cloud-cover',
  'tweezer-bottom',
  'tweezer-top',
  'three-white-soldiers',
  'three-black-crows',
  'abandoned-baby-bottom',
  'abandoned-baby-top',
  'rising-three-methods',
  'falling-three-methods',
  // Гармонические паттерны — см. комментарий у PatternName выше. Без этой
  // строки ALL_FEATURES (ниже) не получит новое имя, и backtest/config.ts
  // (DEFAULT_BACKTEST_CONFIG.activeFeatures = [...ALL_FEATURES]) молча
  // никогда не прогонит гармоники в бэктесте — тот же класс бага, что уже
  // описан комментарием выше в этом же массиве.
  'harmonic-pattern',
];

const INDICATOR_FEATURES: readonly IndicatorFeature[] = [
  'rsi',
  'ema',
  'macd',
  'atr',
  'bollinger',
  'vwap',
  'volume-profile',
  'fibonacci',
  'liquidity-pools',
  // См. комментарий у 'super-order-block' в IndicatorFeature выше — этот
  // пункт настроек сейчас ни на что не влияет (мёртвая настройка).
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

export const ALL_FEATURES: readonly FeatureName[] = [
  ...PATTERN_NAMES,
  ...INDICATOR_FEATURES,
];

// ─── Zod Schemas ────────────────────────────────────────────────────

export const timeframeSchema = z.enum([
  '1m',
  '5m',
  '15m',
  '30m',
  '1h',
  '4h',
  '1d',
]);

export const sourceIdSchema = z.enum([
  'binance',
  'deriv',
  'twelvedata',
  'finnhub',
  'yahoo',
]);

export const connectionStatusSchema = z.enum([
  'idle',
  'connecting',
  'live',
  'market_closed',
  'degraded',
  'reconnecting',
  'failed',
]);

export const signalDirectionSchema = z.enum(['buy', 'sell']);

export const signalOutcomeSchema = z.enum(['pending', 'win', 'loss', 'timeout']);

export const signalStrengthSchema = z.enum(['weak', 'moderate', 'strong']);

export const patternNameSchema = z.enum([
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
  'inverted-hammer',
  'hanging-man',
  'marubozu-bullish',
  'marubozu-bearish',
  'spinning-top',
  'piercing-line',
  'dark-cloud-cover',
  'tweezer-bottom',
  'tweezer-top',
  'three-white-soldiers',
  'three-black-crows',
  'abandoned-baby-bottom',
  'abandoned-baby-top',
  'rising-three-methods',
  'falling-three-methods',
  'harmonic-pattern',
]);

export const assetClassSchema = z.enum(['crypto', 'forex']);

export const featureNameSchema = z.enum([
  ...patternNameSchema.options,
  ...INDICATOR_FEATURES,
] as unknown as [FeatureName, ...FeatureName[]]);

export const candleSchema = z.object({
  time: z.number(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
});

export const tickSchema = z.object({
  price: z.number(),
  time: z.number(),
  bid: z.number().optional(),
  ask: z.number().optional(),
});

const harmonicPointSchema = z.object({
  price: z.number(),
  time: z.number(),
  index: z.number(),
});

export const patternResultSchema = z.object({
  name: patternNameSchema,
  direction: signalDirectionSchema,
  confidence: z.number().min(0).max(1),
  strength: signalStrengthSchema,
  time: z.number(),
  volumeConfirmed: z.boolean().optional(),
  confirmedByNextCandle: z.boolean().optional(),
  confluenceFactors: z.array(z.string()).optional(),
  // Kept in sync with the PatternResult interface above — this schema isn't
  // exercised by any live .parse()/.safeParse() call today (the worker
  // boundary uses postMessage's structured clone, not zod), so a missing
  // field here wouldn't break anything *right now*. But if runtime
  // validation is ever added at that boundary (a reasonable thing to want),
  // an out-of-sync schema would silently strip these fields via zod's
  // default unknown-key stripping — turning a real structural SL/TP input
  // into a silently-dropped one. Found and fixed during the "Реакция на
  // снятие ликвидности" quality review, 2026-09-01.
  breakoutLow: z.number().optional(),
  breakoutHigh: z.number().optional(),
  sweepLow: z.number().optional(),
  sweepHigh: z.number().optional(),
  oppositeZonePrice: z.number().nullable().optional(),
  setupType: z.enum(['continuation', 'reversal-at-key-level']).optional(),
  // Ранее отсутствовало в схеме — существующий дрейф от PatternResult
  // (order-block-continuation), не относится к гармоникам, но раз уже
  // трогаем этот блок, чинится заодно (см. п.7 отчёта о проверке промта).
  targetZone: z.number().optional(),
  // Гармонические паттерны (harmonic-pattern) — см. PatternResult в начале
  // файла.
  harmonicType: z.enum(['gartley', 'bat', 'crab', 'butterfly', 'ab-cd']).optional(),
  przLow: z.number().optional(),
  przHigh: z.number().optional(),
  harmonicStop: z.number().optional(),
  harmonicTarget: z.number().optional(),
  harmonicPoints: z
    .object({
      x: harmonicPointSchema,
      a: harmonicPointSchema,
      b: harmonicPointSchema,
      c: harmonicPointSchema,
      d: harmonicPointSchema,
    })
    .optional(),
  harmonicRatios: z
    .object({ ab_xa: z.number(), bc_ab: z.number(), cd_bc: z.number(), ad_xa: z.number() })
    .optional(),
});

export const marketStructureSchema = z.object({
  trend: z.enum(['up', 'down', 'range']),
  bos: z.boolean(),
  choch: z.boolean(),
  swingHigh: z.number().nullable(),
  swingLow: z.number().nullable(),
});

export const marketRegimeSchema = z.enum(['trend', 'range', 'high-volatility']);

export const sessionFilterConfigSchema = z.object({
  london: z.boolean(),
  newyork: z.boolean(),
  overlap: z.boolean(),
  tokyo: z.boolean(),
  sydney: z.boolean(),
});

export const indicatorConfigSchema = z.object({
  rsiPeriod: z.number(),
  emaFast: z.number(),
  emaSlow: z.number(),
  macdFast: z.number(),
  macdSlow: z.number(),
  macdSignal: z.number(),
  atrPeriod: z.number(),
  bbPeriod: z.number(),
  bbStdDev: z.number(),
  scoreThreshold: z.number(),
  rsiOverbought: z.number(),
  rsiOversold: z.number(),
  spreadGateMultiplier: z.number(),
  sessionFilter: sessionFilterConfigSchema,
});

export const indicatorSnapshotSchema = z.object({
  rsi: z.number().nullable(),
  emaFast: z.number().nullable(),
  emaSlow: z.number().nullable(),
  macd: z.number().nullable(),
  macdSignal: z.number().nullable(),
  macdHistogram: z.number().nullable(),
  atr: z.number().nullable(),
  bollingerUpper: z.number().nullable(),
  bollingerMiddle: z.number().nullable(),
  bollingerLower: z.number().nullable(),
  vwap: z.number().nullable(),
  vwapIsProxyVolume: z.boolean(),
  volumeProfilePoc: z.number().nullable(),
  volumeProfilePocIsProxyVolume: z.boolean(),
  meanReversionRsi: z.number().nullable(),
  impulseVelocity: z.number().nullable(),
  adx: z.number().nullable(),
});

const seriesPointSchema = z.object({
  time: z.number(),
  value: z.number().nullable(),
});

export const indicatorSeriesSchema = z.object({
  rsi: z.array(seriesPointSchema),
  emaFast: z.array(seriesPointSchema),
  emaSlow: z.array(seriesPointSchema),
  macd: z.array(seriesPointSchema),
  macdSignal: z.array(seriesPointSchema),
  macdHistogram: z.array(seriesPointSchema),
  bollingerUpper: z.array(seriesPointSchema),
  bollingerMiddle: z.array(seriesPointSchema),
  bollingerLower: z.array(seriesPointSchema),
});

export const snapshotSchema = z.object({
  indicators: indicatorSnapshotSchema,
  patterns: z.array(patternResultSchema),
  structure: marketStructureSchema,
  regime: marketRegimeSchema,
  lastPrice: z.number().nullable(),
  candleTime: z.number().nullable(),
});

export const signalFactorKindSchema = z.enum(['indicator', 'pattern', 'strategy', 'structure', 'filter']);

export const signalFactorSchema = z.object({
  kind: signalFactorKindSchema,
  name: z.string(),
  direction: signalDirectionSchema.nullable(),
  contribution: z.number(),
  argument: z.string(),
  value: z.number().nullable().optional(),
});

export const rejectedPatternSchema = z.object({
  name: patternNameSchema,
  direction: signalDirectionSchema,
  confidence: z.number(),
  reasonNotSelected: z.enum(['lower-class-priority', 'opposite-direction', 'lower-confidence']),
});

export const engineConfigSnapshotSchema = z.object({
  indicatorConfig: indicatorConfigSchema,
  signalToggles: z.object(
    Object.fromEntries(SIGNAL_COMPONENT_KEYS.map((k) => [k, z.boolean()])) as Record<SignalComponentKey, z.ZodBoolean>,
  ),
  activeFeatures: z.array(featureNameSchema),
});

export const chartContextSchema = z.object({
  candlesBefore: z.array(candleSchema),
  candlesAfter: z.array(candleSchema),
  maxFavorableExcursion: z.number().nullable(),
  maxAdverseExcursion: z.number().nullable(),
});

export const marketContextSchema = z.object({
  regime: marketRegimeSchema,
  structure: marketStructureSchema,
  session: z.enum(['sydney', 'tokyo', 'london', 'newyork', 'overlap', 'closed']),
});

export const signalSchema = z.object({
  id: z.string(),
  symbolId: z.string(),
  direction: signalDirectionSchema,
  strength: signalStrengthSchema,
  score: z.number(),
  calibratedProbability: z.number().nullable(),
  calibrationSource: z.enum(['model', 'fallback']).optional(),
  entryPrice: z.number(),
  reason: z.string(),
  indicators: indicatorSnapshotSchema,
  pattern: patternNameSchema.nullable(),
  time: z.number(),
  timeframe: timeframeSchema,
  outcome: signalOutcomeSchema,
  frozenAt: z.number().nullable(),
  isRevised: z.boolean(),
  isPreClose: z.boolean(),
  revisionNote: z.string().nullable(),
  barsToResolve: z.number(),
  spread: z.number().nullable(),
  spreadSource: z.enum(['live', 'estimated']).nullable(),
  recommendedExpiry: z.number(),
  expiryBars: z.number().optional(),
  featureVector: z.array(z.number()),
  factors: z.array(signalFactorSchema),
  rejectedPatterns: z.array(rejectedPatternSchema),
  engineConfigSnapshot: engineConfigSnapshotSchema,
  chartContext: chartContextSchema,
  marketContext: marketContextSchema,
});

export const calibrationResultSchema = z.object({
  symbolId: z.string(),
  timeframe: timeframeSchema,
  bestExpiryBars: z.number(),
  directionAccuracy: z.number(),
  totalTrades: z.number(),
  calibratedAt: z.number(),
});

export const marketHoursConfigSchema = z.object({
  openDays: z.array(z.boolean()),
  openMinutesUtc: z.number(),
  closeMinutesUtc: z.number(),
});

export const symbolSchema = z.object({
  id: z.string(),
  assetClass: assetClassSchema,
  displaySymbol: z.string(),
  baseAsset: z.string(),
  quoteAsset: z.string(),
  displayName: z.string(),
  pipSize: z.number(),
  marketHours: marketHoursConfigSchema.nullable(),
});

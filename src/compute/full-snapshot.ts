import type {
  Candle,
  IndicatorConfig,
  Snapshot,
  FeatureName,
} from '@/types/domain';
import { computeIndicators } from '@/compute/IndicatorAggregator';
import { detectAllPatterns } from '@/compute/patterns';
import { computeStructure } from '@/compute/indicators/trend-structure';
import { detectMarketRegime } from '@/compute/indicators/market-regime';
import { calcSmartMoney, type SmartMoneyResult } from '@/compute/indicators/smart-money';

const EMPTY_SMART_MONEY: SmartMoneyResult = {
  orderBlocks: [],
  fvgs: [],
  inversionFvgs: [],
  breakerBlocks: [],
  rejectionBlocks: [],
  bosEvents: [],
};

export function buildFullSnapshot(
  candles: Candle[],
  config: IndicatorConfig,
  activeFeatures: FeatureName[],
  isClosed: boolean = true,
): { snapshot: Snapshot; series: ReturnType<typeof computeIndicators>['series'] } {
  const { snapshot: indicators, series } = computeIndicators(candles, config, activeFeatures);

  // ВАЖНО: пустой activeFeatures означает «ничего не выбрано», а не «фильтра
  // нет — считать всё активным» (см. тот же фикс в IndicatorAggregator.ts,
  // direction-prediction.ts, signal-filters.ts, patterns/index.ts).
  const has = (name: FeatureName) => activeFeatures.includes(name);

  // Compute structure and smart money BEFORE patterns, so they can be
  // passed as context to the 6 context-aware pattern detectors.
  // HTF approximation on 1M data — replace with real multi-timeframe fetch when available
  const structure = has('trend-structure')
    ? computeStructure(candles, 50, isClosed, config.atrPeriod)
    : { trend: 'range' as const, bos: false, choch: false, swingHigh: null, swingLow: null, provisional: false };

  const smartMoney = has('smart-money')
    ? calcSmartMoney(candles)
    : EMPTY_SMART_MONEY;

  const patterns = detectAllPatterns(
    candles,
    activeFeatures,
    indicators,
    structure,
    smartMoney,
    config.atrPeriod,
    { fast: config.macdFast, slow: config.macdSlow, signal: config.macdSignal },
    {
      minLegAtr: config.harmonicMinLegAtr,
      fibTolerancePct: config.harmonicFibTolerancePct,
      htfFactor: config.harmonicHtfFactor,
    },
  );

  const regime = has('market-regime')
    ? detectMarketRegime(candles, 20, config.atrPeriod)
    : ('range' as const);

  const lastCandle = candles.length > 0 ? candles[candles.length - 1] : null;

  const fullSnapshot: Snapshot = {
    indicators,
    patterns,
    structure,
    regime,
    lastPrice: lastCandle?.close ?? null,
    candleTime: lastCandle?.time ?? null,
  };

  return { snapshot: fullSnapshot, series };
}

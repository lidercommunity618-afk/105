import type { Timeframe, IndicatorConfig, FeatureName } from '@/types/domain';
import { DEFAULT_INDICATOR_CONFIG, ALL_FEATURES } from '@/types/domain';

export interface BacktestConfig {
  symbol: string;
  timeframe: Timeframe;
  fromMs: number;
  toMs: number;
  indicatorConfig: IndicatorConfig;
  activeFeatures: FeatureName[];
  barsToResolve: number;
  windowSize: number;
  inSampleRatio: number;
  outputDir: string;
}

export const DEFAULT_BACKTEST_CONFIG: Omit<BacktestConfig, 'symbol' | 'fromMs' | 'toMs'> = {
  timeframe: '15m',
  indicatorConfig: { ...DEFAULT_INDICATOR_CONFIG },
  activeFeatures: [...ALL_FEATURES],
  barsToResolve: 5,
  windowSize: 500,
  inSampleRatio: 0.7,
  outputDir: 'backtest/output',
};
